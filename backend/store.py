"""Async SQLite-backed note store.

Persists self-referential notes in a single SQLite database file.
A `parent_id` index keeps child lookups O(log n + k); the recursive CTE in
`ancestors` walks the parent chain with a depth guard so a corrupted cycle
can never spin forever.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from uuid import uuid4

import aiosqlite


@dataclass
class Note:
    id: str
    parentId: Optional[str]
    text: str
    createdAt: str
    childCount: int = 0

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "parentId": self.parentId,
            "text": self.text,
            "createdAt": self.createdAt,
            "childCount": self.childCount,
        }


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_parent_id_created_at
ON notes(parent_id, created_at);
"""

# Hard cap on ancestor walk depth so a malformed cycle (parent_id pointing
# back into the chain) can never produce an unbounded recursion in SQLite.
_MAX_ANCESTOR_DEPTH = 1000

# How long a writer waits on SQLite's reserved lock before failing with
# SQLITE_BUSY. Plenty for an interactive note app; tune if you ever run a
# bulk-import workload.
_BUSY_TIMEOUT_MS = 5000


def _row_to_note(row: aiosqlite.Row) -> Note:
    # child_count is included by queries that need it; otherwise default to 0.
    try:
        child_count = row["child_count"]
    except (IndexError, KeyError):
        child_count = 0
    return Note(
        id=row["id"],
        parentId=row["parent_id"],
        text=row["text"],
        createdAt=row["created_at"],
        childCount=int(child_count or 0),
    )


class NoteStore:
    """Async SQLite-backed store for self-referential notes."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._conn: Optional[aiosqlite.Connection] = None
        self._init_lock = asyncio.Lock()

    async def _ensure_conn(self) -> aiosqlite.Connection:
        if self._conn is not None:
            return self._conn
        async with self._init_lock:
            if self._conn is not None:
                return self._conn
            self._path.parent.mkdir(parents=True, exist_ok=True)
            # isolation_level=None puts the driver in autocommit mode so we
            # control transaction boundaries explicitly with BEGIN/COMMIT.
            conn = await aiosqlite.connect(self._path, isolation_level=None)
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA journal_mode=WAL")
            await conn.execute("PRAGMA foreign_keys=ON")
            await conn.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
            await conn.executescript(_SCHEMA_SQL)
            self._conn = conn
            return conn

    async def close(self) -> None:
        async with self._init_lock:
            if self._conn is not None:
                await self._conn.close()
                self._conn = None

    async def list_children(self, parent_id: Optional[str]) -> list[Note]:
        conn = await self._ensure_conn()
        # Subquery yields the direct-child count per row so the UI can render
        # "Show N replies" affordances without an extra fetch per note.
        select_clause = (
            "SELECT n.id, n.parent_id, n.text, n.created_at, "
            "(SELECT COUNT(*) FROM notes c WHERE c.parent_id = n.id) AS child_count "
            "FROM notes n"
        )
        if parent_id is None:
            cursor = await conn.execute(
                f"{select_clause} WHERE n.parent_id IS NULL ORDER BY n.created_at ASC"
            )
        else:
            cursor = await conn.execute(
                f"{select_clause} WHERE n.parent_id = ? ORDER BY n.created_at ASC",
                (parent_id,),
            )
        rows = await cursor.fetchall()
        await cursor.close()
        return [_row_to_note(row) for row in rows]

    async def get(self, note_id: str) -> Optional[Note]:
        conn = await self._ensure_conn()
        cursor = await conn.execute(
            "SELECT n.id, n.parent_id, n.text, n.created_at, "
            "(SELECT COUNT(*) FROM notes c WHERE c.parent_id = n.id) AS child_count "
            "FROM notes n WHERE n.id = ?",
            (note_id,),
        )
        row = await cursor.fetchone()
        await cursor.close()
        return _row_to_note(row) if row else None

    async def ancestors(self, note_id: str) -> list[Note]:
        """Return ancestors ordered from root to immediate parent."""
        conn = await self._ensure_conn()
        cursor = await conn.execute(
            """
            WITH RECURSIVE chain(id, parent_id, text, created_at, depth) AS (
                SELECT n.id, n.parent_id, n.text, n.created_at, 0
                FROM notes n
                WHERE n.id = (SELECT parent_id FROM notes WHERE id = ?)
                UNION ALL
                SELECT n.id, n.parent_id, n.text, n.created_at, c.depth + 1
                FROM notes n
                JOIN chain c ON n.id = c.parent_id
                WHERE c.depth < ?
            )
            SELECT id, parent_id, text, created_at FROM chain
            """,
            (note_id, _MAX_ANCESTOR_DEPTH),
        )
        rows = await cursor.fetchall()
        await cursor.close()
        # CTE walks parent -> grandparent -> ...; reverse for root-first.
        return [_row_to_note(row) for row in reversed(rows)]

    async def create(self, text: str, parent_id: Optional[str]) -> Note:
        # Make sure the schema/WAL/PRAGMAs have been initialized (this is a
        # no-op once the read connection has been opened).
        await self._ensure_conn()
        note = Note(
            id=uuid4().hex,
            parentId=parent_id,
            text=text,
            createdAt=datetime.now(timezone.utc).isoformat(),
        )
        # Writes get their own short-lived connection so concurrent creators
        # serialize at SQLite's reserved lock (BEGIN IMMEDIATE + busy_timeout)
        # instead of an asyncio lock on the Python side. This also means a
        # rollback on error truly rolls the transaction back at the DB layer.
        async with aiosqlite.connect(
            self._path, isolation_level=None
        ) as conn:
            await conn.execute("PRAGMA foreign_keys=ON")
            await conn.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
            await conn.execute("BEGIN IMMEDIATE")
            try:
                if parent_id is not None:
                    cursor = await conn.execute(
                        "SELECT 1 FROM notes WHERE id = ?", (parent_id,)
                    )
                    row = await cursor.fetchone()
                    await cursor.close()
                    if row is None:
                        raise KeyError(parent_id)
                await conn.execute(
                    "INSERT INTO notes (id, parent_id, text, created_at) "
                    "VALUES (?, ?, ?, ?)",
                    (note.id, note.parentId, note.text, note.createdAt),
                )
            except BaseException:
                await conn.execute("ROLLBACK")
                raise
            await conn.execute("COMMIT")
        return note
