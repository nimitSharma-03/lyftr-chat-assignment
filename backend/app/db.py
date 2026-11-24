"""SQLite persistence for chat sessions and messages."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id    TEXT PRIMARY KEY,
    system_prompt TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content     TEXT NOT NULL,
    metadata    TEXT,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, id);
"""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Database:
    def __init__(self, path: str) -> None:
        self.path = path
        self._write_lock = threading.Lock()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=10, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            yield conn
        finally:
            conn.close()

    def init(self) -> None:
        directory = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(directory, exist_ok=True)
        with self.connection() as conn:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.executescript(SCHEMA)
            conn.commit()

    def ping(self) -> bool:
        try:
            with self.connection() as conn:
                conn.execute("SELECT 1 FROM messages LIMIT 1").fetchall()
            return True
        except sqlite3.Error:
            return False

    # ----------------------------------------------------------------- reads
    def get_session(self, session_id: str) -> dict[str, Any] | None:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT session_id, system_prompt, created_at FROM sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        return dict(row) if row else None

    def get_messages(self, session_id: str, limit: int | None = None) -> list[dict[str, Any]]:
        """Return messages oldest-first. ``limit`` keeps only the most recent N."""
        with self.connection() as conn:
            if limit:
                rows = conn.execute(
                    "SELECT * FROM (SELECT id, role, content, metadata, created_at FROM messages "
                    "WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
                    (session_id, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT id, role, content, metadata, created_at FROM messages "
                    "WHERE session_id = ? ORDER BY id ASC",
                    (session_id,),
                ).fetchall()
        result = []
        for row in rows:
            item: dict[str, Any] = {"role": row["role"], "content": row["content"]}
            if row["metadata"]:
                item["metadata"] = json.loads(row["metadata"])
            item["created_at"] = row["created_at"]
            result.append(item)
        return result

    # ---------------------------------------------------------------- writes
    def save_turn(
        self,
        session_id: str,
        user_message: str,
        reply: str,
        metadata: dict[str, Any],
        system_prompt: str | None,
    ) -> None:
        """Persist a successful exchange atomically (session + user + assistant rows)."""
        now = utc_now()
        with self._write_lock, self.connection() as conn:
            try:
                conn.execute("BEGIN IMMEDIATE")
                conn.execute(
                    "INSERT INTO sessions (session_id, system_prompt, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET "
                    "updated_at = excluded.updated_at, "
                    "system_prompt = COALESCE(excluded.system_prompt, sessions.system_prompt)",
                    (session_id, system_prompt, now, now),
                )
                conn.execute(
                    "INSERT INTO messages (session_id, role, content, metadata, created_at) "
                    "VALUES (?, 'user', ?, NULL, ?)",
                    (session_id, user_message, now),
                )
                conn.execute(
                    "INSERT INTO messages (session_id, role, content, metadata, created_at) "
                    "VALUES (?, 'assistant', ?, ?, ?)",
                    (session_id, reply, json.dumps(metadata), utc_now()),
                )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
