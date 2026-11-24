"""API contract tests. They run fully offline using demo (``mock-``) keys."""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.llm import InvalidSimulationHeader, parse_simulation_header
from app.main import create_app


def make_client(tmp_path, **overrides) -> TestClient:
    settings = Settings(
        llm_api_keys=overrides.pop("keys", ["mock-key-one", "mock-key-two"]),
        database_url=f"sqlite:///{tmp_path / 'test.db'}",
        allowed_origins=["http://localhost:3000"],
        enable_failure_simulation=overrides.pop("simulation", True),
        mock_delay_ms=overrides.pop("mock_delay_ms", 50),
        **overrides,
    )
    return TestClient(create_app(settings))


@pytest.fixture()
def client(tmp_path):
    with make_client(tmp_path) as c:
        yield c


def sid() -> str:
    return f"s-{uuid.uuid4().hex[:8]}"


# --------------------------------------------------------------------- health
def test_health(client):
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["keys_configured"] == 2
    assert body["cache_enabled"] is True


def test_health_without_keys(tmp_path):
    with make_client(tmp_path, keys=[]) as c:
        res = c.get("/health")
        assert res.status_code == 503
        assert res.json()["keys_configured"] == 0


# ----------------------------------------------------------------------- chat
def test_chat_live_then_cache(client):
    first = client.post("/chat", json={"session_id": sid(), "message": "What is the capital of France?"})
    assert first.status_code == 200
    body = first.json()
    meta = body["metadata"]
    assert body["reply"]
    assert meta["resolution_source"] == "LIVE_INFERENCE"
    assert meta["key_id"] == "key_1"
    assert meta["fallback_attempts"] == 0
    assert isinstance(meta["latency_ms"], int)
    assert meta["input_tokens"] > 0 and meta["output_tokens"] > 0
    assert set(meta) >= {
        "resolution_source", "model", "latency_ms", "input_tokens",
        "output_tokens", "key_id", "fallback_attempts",
    }

    second = client.post("/chat", json={"session_id": sid(), "message": "What is the capital of France?"})
    assert second.status_code == 200
    cached = second.json()
    assert cached["metadata"]["resolution_source"] == "LLM_CACHE"
    assert cached["metadata"]["key_id"] is None
    assert cached["metadata"]["fallback_attempts"] == 0
    assert cached["reply"] == body["reply"]
    assert cached["metadata"]["input_tokens"] == meta["input_tokens"]
    assert cached["metadata"]["output_tokens"] == meta["output_tokens"]
    assert cached["metadata"]["latency_ms"] < meta["latency_ms"]


def test_different_message_never_from_cache(client):
    client.post("/chat", json={"session_id": sid(), "message": "hello one"})
    res = client.post("/chat", json={"session_id": sid(), "message": "hello two"})
    assert res.json()["metadata"]["resolution_source"] == "LIVE_INFERENCE"


def test_tokens_are_per_request(client):
    s = sid()
    a = client.post("/chat", json={"session_id": s, "message": "first message here"}).json()
    b = client.post("/chat", json={"session_id": s, "message": "second message here"}).json()
    other = client.post("/chat", json={"session_id": sid(), "message": "other message here"}).json()
    # Same-length first messages in new sessions report the same prompt size.
    assert a["metadata"]["input_tokens"] == other["metadata"]["input_tokens"]
    # The follow-up includes history, so its prompt is larger, but it is not a running total.
    assert b["metadata"]["input_tokens"] > a["metadata"]["input_tokens"]
    assert b["metadata"]["input_tokens"] < a["metadata"]["input_tokens"] * 4


def test_multi_turn_history(client):
    s = sid()
    client.post("/chat", json={"session_id": s, "message": "My name is Ada."})
    second = client.post("/chat", json={"session_id": s, "message": "What is my name?"}).json()
    assert "My name is Ada." in second["reply"]  # demo replies quote the first user turn

    history = client.get(f"/sessions/{s}/messages")
    assert history.status_code == 200
    data = history.json()
    assert data["session_id"] == s
    roles = [m["role"] for m in data["messages"]]
    assert roles == ["user", "assistant", "user", "assistant"]
    assert data["messages"][0]["content"] == "My name is Ada."
    assert "metadata" not in data["messages"][0]
    assert data["messages"][1]["metadata"]["resolution_source"] == "LIVE_INFERENCE"
    assert all(m["role"] != "system" for m in data["messages"])


def test_sessions_are_isolated(client):
    a, b = sid(), sid()
    client.post("/chat", json={"session_id": a, "message": "only in a"})
    client.post("/chat", json={"session_id": b, "message": "only in b"})
    msgs_a = client.get(f"/sessions/{a}/messages").json()["messages"]
    assert [m["content"] for m in msgs_a if m["role"] == "user"] == ["only in a"]


def test_system_prompt_override_is_kept_for_session(client):
    s = sid()
    first = client.post(
        "/chat", json={"session_id": s, "message": "hi", "system_prompt": "Reply like a pirate."}
    ).json()
    default = client.post("/chat", json={"session_id": sid(), "message": "hi"}).json()
    # Different system prompt -> different prompt -> no cross-cache and different size.
    assert default["metadata"]["resolution_source"] == "LIVE_INFERENCE"
    assert first["metadata"]["input_tokens"] != default["metadata"]["input_tokens"]


def test_unknown_session_404(client):
    res = client.get("/sessions/does-not-exist/messages")
    assert res.status_code == 404
    assert res.json() == {"detail": "session not found"}


# ----------------------------------------------------------------- validation
@pytest.mark.parametrize(
    "payload",
    [
        {"session_id": "s-1"},
        {"message": "hi"},
        {"session_id": "", "message": "hi"},
        {"session_id": "s-1", "message": "   "},
        {"session_id": "s-1", "message": "x" * 4001},
        {"session_id": "x" * 129, "message": "hi"},
        {"session_id": 5, "message": "hi"},
    ],
)
def test_validation_errors(client, payload):
    res = client.post("/chat", json=payload)
    assert res.status_code == 422
    assert "detail" in res.json()


def test_malformed_json(client):
    res = client.post("/chat", content="{not json", headers={"Content-Type": "application/json"})
    assert res.status_code == 422
    assert "detail" in res.json()


def test_message_limit_counts_after_trim(client):
    res = client.post("/chat", json={"session_id": sid(), "message": "  " + "x" * 4000 + "  "})
    assert res.status_code == 200


def test_failed_validation_not_stored(client):
    s = sid()
    client.post("/chat", json={"session_id": s, "message": ""})
    assert client.get(f"/sessions/{s}/messages").status_code == 404


# ------------------------------------------------------------------- failover
@pytest.mark.parametrize("header", ["key_1=429", "key_1=500", "key_1=502", "key_1=503"])
def test_failover_to_second_key(client, header):
    res = client.post(
        "/chat",
        json={"session_id": sid(), "message": f"failover test {header}"},
        headers={"X-Simulate-Failure": header},
    )
    assert res.status_code == 200
    meta = res.json()["metadata"]
    assert meta["key_id"] == "key_2"
    assert meta["fallback_attempts"] == 1
    assert meta["resolution_source"] == "LIVE_INFERENCE"
    assert res.json()["reply"]


def test_failover_bypasses_warm_cache(client):
    msg = {"message": "cached question"}
    client.post("/chat", json={"session_id": sid(), **msg})
    res = client.post(
        "/chat", json={"session_id": sid(), **msg}, headers={"X-Simulate-Failure": "key_1=429"}
    )
    assert res.json()["metadata"]["key_id"] == "key_2"


def test_all_keys_fail_returns_503_and_stores_nothing(client):
    s = sid()
    res = client.post(
        "/chat", json={"session_id": s, "message": "hello"}, headers={"X-Simulate-Failure": "*=429"}
    )
    assert res.status_code == 503
    assert res.json() == {"detail": "all providers unavailable"}
    assert client.get(f"/sessions/{s}/messages").status_code == 404


def test_listing_every_key_returns_503(client):
    res = client.post(
        "/chat",
        json={"session_id": sid(), "message": "hello"},
        headers={"X-Simulate-Failure": "key_1=429,key_2=500"},
    )
    assert res.status_code == 503


def test_simulation_is_per_request(client):
    client.post(
        "/chat", json={"session_id": sid(), "message": "a"}, headers={"X-Simulate-Failure": "key_1=429"}
    )
    res = client.post("/chat", json={"session_id": sid(), "message": "b"})
    assert res.json()["metadata"]["key_id"] == "key_1"


def test_simulation_ignored_when_disabled(tmp_path):
    with make_client(tmp_path, simulation=False) as c:
        res = c.post(
            "/chat", json={"session_id": sid(), "message": "hi"}, headers={"X-Simulate-Failure": "*=429"}
        )
        assert res.status_code == 200
        assert res.json()["metadata"]["key_id"] == "key_1"


def test_invalid_simulation_header(client):
    res = client.post(
        "/chat", json={"session_id": sid(), "message": "hi"}, headers={"X-Simulate-Failure": "key_1=418"}
    )
    assert res.status_code == 422


def test_real_provider_failure_falls_back(tmp_path):
    # key_1 is a real-looking key for a provider that cannot be reached offline;
    # the request must still succeed on key_2.
    with make_client(
        tmp_path,
        keys=["invalid-real-key", "mock-key-two"],
        llm_model="openai/gpt-4o-mini",
        request_timeout_seconds=2,
    ) as c:
        res = c.post("/chat", json={"session_id": sid(), "message": "hi"})
        assert res.status_code == 200
        assert res.json()["metadata"]["key_id"] == "key_2"
        assert res.json()["metadata"]["fallback_attempts"] == 1


# ---------------------------------------------------------------- unit: header
def test_parse_simulation_header():
    ids = ["key_1", "key_2"]
    assert parse_simulation_header("key_1=429", ids) == {"key_1": 429}
    assert parse_simulation_header("key_1=429, key_2=500", ids) == {"key_1": 429, "key_2": 500}
    assert parse_simulation_header("*=503", ids) == {"key_1": 503, "key_2": 503}
    assert parse_simulation_header("", ids) == {}
    with pytest.raises(InvalidSimulationHeader):
        parse_simulation_header("key_1", ids)
    with pytest.raises(InvalidSimulationHeader):
        parse_simulation_header("key_1=abc", ids)


def test_cors_allows_frontend_origin(client):
    res = client.options(
        "/chat",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-simulate-failure",
        },
    )
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == "http://localhost:3000"
