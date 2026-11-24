"""Application settings, read once from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int(value: str | None, default: int) -> int:
    try:
        return int(value) if value not in (None, "") else default
    except ValueError:
        return default


def _csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful, concise assistant. Answer clearly and accurately. "
    "Use short paragraphs or bullet points when they improve readability."
)


@dataclass(frozen=True)
class Settings:
    llm_api_keys: list[str] = field(default_factory=list)
    llm_model: str = "gemini/gemini-2.5-flash"
    llm_key_models: list[str] = field(default_factory=list)
    database_url: str = "sqlite:////data/app.db"
    allowed_origins: list[str] = field(default_factory=list)
    enable_failure_simulation: bool = False
    default_system_prompt: str = DEFAULT_SYSTEM_PROMPT
    cache_ttl_seconds: int = 3600
    request_timeout_seconds: int = 30
    key_cooldown_seconds: int = 30
    max_history_messages: int = 40
    max_output_tokens: int = 1024
    temperature: float = 0.2
    mock_delay_ms: int = 600

    @classmethod
    def from_env(cls) -> "Settings":
        try:
            temperature = float(os.getenv("LLM_TEMPERATURE", "0.2"))
        except ValueError:
            temperature = 0.2
        return cls(
            llm_api_keys=_csv(os.getenv("LLM_API_KEYS")),
            llm_model=os.getenv("LLM_MODEL", "gemini/gemini-2.5-flash").strip()
            or "gemini/gemini-2.5-flash",
            llm_key_models=_csv(os.getenv("LLM_KEY_MODELS")),
            database_url=os.getenv("DATABASE_URL", "sqlite:////data/app.db").strip(),
            allowed_origins=_csv(os.getenv("ALLOWED_ORIGINS", "http://localhost:3000")),
            enable_failure_simulation=_bool(os.getenv("ENABLE_FAILURE_SIMULATION")),
            default_system_prompt=os.getenv("DEFAULT_SYSTEM_PROMPT", "").strip()
            or DEFAULT_SYSTEM_PROMPT,
            cache_ttl_seconds=_int(os.getenv("CACHE_TTL_SECONDS"), 3600),
            request_timeout_seconds=_int(os.getenv("LLM_TIMEOUT_SECONDS"), 30),
            key_cooldown_seconds=_int(os.getenv("KEY_COOLDOWN_SECONDS"), 30),
            max_history_messages=_int(os.getenv("MAX_HISTORY_MESSAGES"), 40),
            max_output_tokens=_int(os.getenv("LLM_MAX_OUTPUT_TOKENS"), 1024),
            temperature=temperature,
            mock_delay_ms=_int(os.getenv("MOCK_DELAY_MS"), 600),
        )


def sqlite_path(database_url: str) -> str:
    """Turn ``sqlite:////data/app.db`` / ``sqlite:///./app.db`` into a file path."""
    url = database_url.strip()
    if url.startswith("sqlite:///"):
        return url[len("sqlite:///"):] or "app.db"
    if url.startswith("sqlite://"):
        return url[len("sqlite://"):] or "app.db"
    return url
