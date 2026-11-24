"""LLM gateway: LiteLLM key pool with ordered failover and response caching.

Every request walks the key pool in order (key_1, key_2, ...). Each attempt is
a single ``litellm.completion`` call with ``num_retries=0`` so that a failing
key is abandoned immediately and the next one is tried. LiteLLM's built-in
cache sits in front of the provider call: on a hit LiteLLM returns the stored
response without contacting the provider, which we report as ``LLM_CACHE``.
"""

from __future__ import annotations

import logging
import os
import threading
import time
import warnings
from dataclasses import dataclass, field
from typing import Any

os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
warnings.filterwarnings("ignore", message="Pydantic serializer warnings")

import litellm  # noqa: E402
from litellm.caching.caching import Cache  # noqa: E402

from .config import Settings  # noqa: E402

logger = logging.getLogger("app.llm")

litellm.suppress_debug_info = True
litellm.drop_params = True

SIMULATABLE_STATUSES = {429, 500, 502, 503}
MOCK_KEY_PREFIX = "mock-"
MOCK_MODEL = "demo-echo"


class AllProvidersUnavailable(Exception):
    """Raised when every key in the pool failed for a request."""

    def __init__(self, failures: list[dict[str, Any]]) -> None:
        super().__init__("all providers unavailable")
        self.failures = failures


class InvalidSimulationHeader(ValueError):
    pass


@dataclass
class PoolKey:
    key_id: str
    secret: str
    model: str
    cooldown_until: float = 0.0

    @property
    def is_mock(self) -> bool:
        return self.secret.startswith(MOCK_KEY_PREFIX)


@dataclass
class CompletionResult:
    reply: str
    resolution_source: str
    model: str
    input_tokens: int
    output_tokens: int
    key_id: str | None
    fallback_attempts: int
    attempts: list[dict[str, Any]] = field(default_factory=list)


def parse_simulation_header(raw: str | None, key_ids: list[str]) -> dict[str, int]:
    """Parse ``key_1=429,key_2=500`` / ``*=429`` into ``{key_id: status}``."""
    if raw is None or not raw.strip():
        return {}
    plan: dict[str, int] = {}
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            raise InvalidSimulationHeader(f"invalid X-Simulate-Failure entry '{part}'")
        target, _, status_text = part.partition("=")
        target, status_text = target.strip(), status_text.strip()
        try:
            status = int(status_text)
        except ValueError as exc:
            raise InvalidSimulationHeader(f"invalid status '{status_text}'") from exc
        if status not in SIMULATABLE_STATUSES:
            raise InvalidSimulationHeader(
                f"unsupported status {status}; use one of {sorted(SIMULATABLE_STATUSES)}"
            )
        if target == "*":
            for key_id in key_ids:
                plan[key_id] = status
        elif target:
            plan[target] = status
        else:
            raise InvalidSimulationHeader("empty key id in X-Simulate-Failure")
    return plan


def simulated_error(status: int, model: str, key_id: str) -> Exception:
    message = f"simulated HTTP {status} for {key_id}"
    provider = model.split("/", 1)[0] if "/" in model else "openai"
    if status == 429:
        return litellm.RateLimitError(message=message, llm_provider=provider, model=model)
    if status == 503:
        return litellm.ServiceUnavailableError(message=message, llm_provider=provider, model=model)
    err = litellm.InternalServerError(message=message, llm_provider=provider, model=model)
    err.status_code = status
    return err


def _status_of(exc: Exception) -> int | None:
    status = getattr(exc, "status_code", None)
    return status if isinstance(status, int) else None


def _is_quota_or_rate_limit(exc: Exception) -> bool:
    if isinstance(exc, litellm.RateLimitError) or _status_of(exc) == 429:
        return True
    text = str(exc).lower()
    return "quota" in text or "resource_exhausted" in text or "rate limit" in text


class LLMGateway:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._lock = threading.Lock()
        self.keys: list[PoolKey] = []
        for index, secret in enumerate(settings.llm_api_keys):
            if secret.startswith(MOCK_KEY_PREFIX):
                model = MOCK_MODEL
            elif index < len(settings.llm_key_models) and settings.llm_key_models[index]:
                model = settings.llm_key_models[index]
            else:
                model = settings.llm_model
            self.keys.append(PoolKey(key_id=f"key_{index + 1}", secret=secret, model=model))
        self.cache_enabled = True
        litellm.cache = Cache(type="local", ttl=settings.cache_ttl_seconds)
        litellm.enable_cache()

    # --------------------------------------------------------------- helpers
    @property
    def key_ids(self) -> list[str]:
        return [k.key_id for k in self.keys]

    def key_status(self) -> list[dict[str, Any]]:
        now = time.monotonic()
        return [
            {
                "key_id": k.key_id,
                "model": k.model,
                "cooling_down": k.cooldown_until > now,
            }
            for k in self.keys
        ]

    def _ordered_keys(self) -> list[PoolKey]:
        """Healthy keys first (in configured order), cooling-down keys last.

        Keys in cooldown are still tried as a last resort so a temporary
        cooldown never turns into a hard outage.
        """
        now = time.monotonic()
        healthy = [k for k in self.keys if k.cooldown_until <= now]
        cooling = [k for k in self.keys if k.cooldown_until > now]
        return healthy + cooling

    def _mark_failed(self, key: PoolKey, exc: Exception) -> None:
        if _is_quota_or_rate_limit(exc) and self.settings.key_cooldown_seconds > 0:
            with self._lock:
                key.cooldown_until = time.monotonic() + self.settings.key_cooldown_seconds

    def _mark_ok(self, key: PoolKey) -> None:
        if key.cooldown_until:
            with self._lock:
                key.cooldown_until = 0.0

    def _mock_reply(self, messages: list[dict[str, str]]) -> str:
        user_turns = [m["content"] for m in messages if m["role"] == "user"]
        latest = user_turns[-1] if user_turns else ""
        text = f'Demo mode reply (no provider key configured). You said: "{latest}".'
        if len(user_turns) > 1:
            text += (
                f' This session has {len(user_turns) - 1} earlier message(s); '
                f'the first one was: "{user_turns[0]}".'
            )
        return text

    def _call(self, key: PoolKey, messages: list[dict[str, str]], use_cache: bool) -> Any:
        kwargs: dict[str, Any] = {
            "model": key.model,
            "messages": messages,
            "api_key": key.secret,
            "temperature": self.settings.temperature,
            "max_tokens": self.settings.max_output_tokens,
            "num_retries": 0,
            "timeout": self.settings.request_timeout_seconds,
            "caching": use_cache,
        }
        if key.is_mock:
            kwargs["custom_llm_provider"] = "openai"
            kwargs["mock_response"] = self._mock_reply(messages)
            kwargs["mock_delay"] = self.settings.mock_delay_ms / 1000
        return litellm.completion(**kwargs)

    @staticmethod
    def _usage(response: Any, key: PoolKey, messages: list[dict[str, str]], reply: str) -> tuple[int, int]:
        if key.is_mock:
            # LiteLLM's mock responses carry placeholder usage; count real tokens instead.
            prompt = litellm.token_counter(model="gpt-4o", messages=messages)
            completion = litellm.token_counter(model="gpt-4o", text=reply, count_response_tokens=True)
            return int(prompt), int(completion)
        usage = getattr(response, "usage", None)
        prompt = int(getattr(usage, "prompt_tokens", 0) or 0)
        completion = int(getattr(usage, "completion_tokens", 0) or 0)
        return prompt, completion

    # ------------------------------------------------------------------ main
    def complete(
        self, messages: list[dict[str, str]], simulate: dict[str, int] | None = None
    ) -> CompletionResult:
        if not self.keys:
            raise AllProvidersUnavailable([])
        simulate = simulate or {}
        # A simulated outage must actually exercise the key pool, so the cache
        # is bypassed for those requests (otherwise a warm cache would hide it).
        use_cache = not simulate
        failures: list[dict[str, Any]] = []

        for key in self._ordered_keys():
            try:
                if key.key_id in simulate:
                    raise simulated_error(simulate[key.key_id], key.model, key.key_id)
                response = self._call(key, messages, use_cache)
                reply = (response.choices[0].message.content or "").strip()
                if not reply:
                    raise litellm.InternalServerError(
                        message="empty completion", llm_provider="unknown", model=key.model
                    )
            except Exception as exc:  # noqa: BLE001 - every provider error triggers failover
                status = _status_of(exc)
                simulated = key.key_id in simulate
                failures.append(
                    {
                        "key_id": key.key_id,
                        "status": status,
                        "error": type(exc).__name__,
                        "simulated": simulated,
                    }
                )
                logger.warning(
                    "key %s failed (status=%s, type=%s, simulated=%s); trying next key",
                    key.key_id, status, type(exc).__name__, simulated,
                )
                if not simulated:
                    self._mark_failed(key, exc)
                continue

            cache_hit = bool(getattr(response, "_hidden_params", {}).get("cache_hit"))
            input_tokens, output_tokens = self._usage(response, key, messages, reply)
            if not cache_hit:
                self._mark_ok(key)
            return CompletionResult(
                reply=reply,
                resolution_source="LLM_CACHE" if cache_hit else "LIVE_INFERENCE",
                model=key.model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                key_id=None if cache_hit else key.key_id,
                fallback_attempts=0 if cache_hit else len(failures),
                attempts=failures,
            )

        raise AllProvidersUnavailable(failures)
