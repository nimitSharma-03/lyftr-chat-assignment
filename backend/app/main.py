"""FastAPI application: /health, /chat and /sessions/{session_id}/messages."""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import Settings, sqlite_path
from .db import Database
from .llm import (
    AllProvidersUnavailable,
    InvalidSimulationHeader,
    LLMGateway,
    parse_simulation_header,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("app")

MAX_MESSAGE_CHARS = 4000
MAX_SESSION_ID_CHARS = 128
MAX_SYSTEM_PROMPT_CHARS = 4000


# ---------------------------------------------------------------------- schemas
class ChatRequest(BaseModel):
    session_id: str = Field(..., description="Client-generated session id, 1-128 chars")
    message: str = Field(..., description="User message, 1-4000 chars after trimming")
    system_prompt: Optional[str] = Field(None, description="Overrides the default system prompt")

    @field_validator("session_id")
    @classmethod
    def _check_session_id(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("session_id must not be empty")
        if len(value) > MAX_SESSION_ID_CHARS:
            raise ValueError(f"session_id must be at most {MAX_SESSION_ID_CHARS} characters")
        return value

    @field_validator("message")
    @classmethod
    def _check_message(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("message must not be empty")
        if len(value) > MAX_MESSAGE_CHARS:
            raise ValueError(f"message must be at most {MAX_MESSAGE_CHARS} characters")
        return value

    @field_validator("system_prompt")
    @classmethod
    def _check_system_prompt(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        if len(value) > MAX_SYSTEM_PROMPT_CHARS:
            raise ValueError(f"system_prompt must be at most {MAX_SYSTEM_PROMPT_CHARS} characters")
        return value or None


class ChatMetadata(BaseModel):
    resolution_source: str
    model: str
    latency_ms: int
    input_tokens: int
    output_tokens: int
    key_id: Optional[str]
    fallback_attempts: int


class ChatResponse(BaseModel):
    session_id: str
    reply: str
    metadata: ChatMetadata


# ------------------------------------------------------------------------- app
def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    db = Database(sqlite_path(settings.database_url))
    gateway = LLMGateway(settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        db.init()
        logger.info(
            "started: keys=%d model=%s cache=local failure_simulation=%s db=%s",
            len(gateway.keys), settings.llm_model, settings.enable_failure_simulation, db.path,
        )
        yield

    app = FastAPI(
        title="Lyftr Chat API",
        version="1.0.0",
        description="Multi-turn chat with key failover and response caching.",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.db = db
    app.state.gateway = gateway

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins or ["*"],
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
        expose_headers=["X-Request-Latency-Ms"],
    )

    # ------------------------------------------------------------ error shapes
    @app.exception_handler(RequestValidationError)
    async def _validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {"loc": list(err.get("loc", [])), "msg": str(err.get("msg", "")), "type": err.get("type")}
            for err in exc.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})

    @app.exception_handler(StarletteHTTPException)
    async def _http_handler(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail},
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(Exception)
    async def _unhandled_handler(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled error: %s", type(exc).__name__)
        return JSONResponse(status_code=500, content={"detail": "internal server error"})

    # --------------------------------------------------------------- endpoints
    @app.get("/")
    def root() -> dict[str, Any]:
        return {
            "name": "Lyftr Chat API",
            "endpoints": ["GET /health", "POST /chat", "GET /sessions/{session_id}/messages"],
            "docs": "/docs",
        }

    @app.get("/health")
    def health() -> JSONResponse:
        db_ok = db.ping()
        keys = len(gateway.keys)
        body: dict[str, Any] = {
            "status": "ok" if db_ok and keys > 0 else "degraded",
            "keys_configured": keys,
            "cache_enabled": gateway.cache_enabled,
            "database": "ok" if db_ok else "unreachable",
            "failure_simulation": settings.enable_failure_simulation,
            "keys": gateway.key_status(),
        }
        if not db_ok or keys == 0:
            body["detail"] = "database unreachable" if not db_ok else "no API keys configured"
            return JSONResponse(status_code=503, content=body)
        return JSONResponse(status_code=200, content=body)

    @app.post("/chat", response_model=ChatResponse)
    def chat(
        payload: ChatRequest,
        x_simulate_failure: Optional[str] = Header(default=None, alias="X-Simulate-Failure"),
    ) -> ChatResponse:
        started = time.perf_counter()

        simulate: dict[str, int] = {}
        if settings.enable_failure_simulation and x_simulate_failure:
            try:
                simulate = parse_simulation_header(x_simulate_failure, gateway.key_ids)
            except InvalidSimulationHeader as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc

        session = db.get_session(payload.session_id)
        system_prompt = (
            payload.system_prompt
            or (session or {}).get("system_prompt")
            or settings.default_system_prompt
        )
        history = db.get_messages(payload.session_id, limit=settings.max_history_messages)
        messages = [{"role": "system", "content": system_prompt}]
        messages += [{"role": m["role"], "content": m["content"]} for m in history]
        messages.append({"role": "user", "content": payload.message})

        try:
            result = gateway.complete(messages, simulate=simulate)
        except AllProvidersUnavailable as exc:
            logger.error("all providers unavailable after %d attempt(s)", len(exc.failures))
            raise HTTPException(status_code=503, detail="all providers unavailable") from exc

        metadata = ChatMetadata(
            resolution_source=result.resolution_source,
            model=result.model,
            latency_ms=max(0, int(round((time.perf_counter() - started) * 1000))),
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            key_id=result.key_id,
            fallback_attempts=result.fallback_attempts,
        )
        db.save_turn(
            session_id=payload.session_id,
            user_message=payload.message,
            reply=result.reply,
            metadata=metadata.model_dump(),
            system_prompt=payload.system_prompt,
        )
        return ChatResponse(session_id=payload.session_id, reply=result.reply, metadata=metadata)

    @app.get("/sessions/{session_id}/messages")
    def session_messages(session_id: str) -> dict[str, Any]:
        if db.get_session(session_id) is None:
            raise HTTPException(status_code=404, detail="session not found")
        return {"session_id": session_id, "messages": db.get_messages(session_id)}

    return app


app = create_app()
