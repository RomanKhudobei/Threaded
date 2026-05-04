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


DEFAULT_SPACE_ID = "general"
DEFAULT_SPACE_NAME = "General"


@dataclass
class Space:
    id: str
    name: str
    createdAt: str

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "createdAt": self.createdAt,
        }


@dataclass
class Note:
    id: str
    spaceId: str
    parentId: Optional[str]
    text: str
    createdAt: str
    childCount: int = 0

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "spaceId": self.spaceId,
            "parentId": self.parentId,
            "text": self.text,
            "createdAt": self.createdAt,
            "childCount": self.childCount,
        }


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS spaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
);
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
        spaceId=row["space_id"],
        parentId=row["parent_id"],
        text=row["text"],
        createdAt=row["created_at"],
        childCount=int(child_count or 0),
    )


def _row_to_space(row: aiosqlite.Row) -> Space:
    return Space(
        id=row["id"],
        name=row["name"],
        createdAt=row["created_at"],
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
            await self._run_migrations(conn)
            self._conn = conn
            return conn

    async def _run_migrations(self, conn: aiosqlite.Connection) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        await conn.execute(
            "INSERT OR IGNORE INTO spaces (id, name, created_at) VALUES (?, ?, ?)",
            (DEFAULT_SPACE_ID, DEFAULT_SPACE_NAME, now_iso),
        )

        table_cursor = await conn.execute("PRAGMA table_info(notes)")
        columns = await table_cursor.fetchall()
        await table_cursor.close()
        has_space_id = any(col["name"] == "space_id" for col in columns)
        if not has_space_id:
            await conn.execute("PRAGMA foreign_keys=OFF")
            try:
                await conn.execute("ALTER TABLE notes RENAME TO notes_legacy")
                await conn.execute(
                    """
                    CREATE TABLE notes (
                        id TEXT PRIMARY KEY,
                        space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
                        parent_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
                        text TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    )
                    """
                )
                await conn.execute(
                    """
                    INSERT INTO notes (id, space_id, parent_id, text, created_at)
                    SELECT id, ?, parent_id, text, created_at
                    FROM notes_legacy
                    """,
                    (DEFAULT_SPACE_ID,),
                )
                await conn.execute("DROP TABLE notes_legacy")
            finally:
                await conn.execute("PRAGMA foreign_keys=ON")
        else:
            await conn.execute(
                "UPDATE notes SET space_id = ? WHERE space_id IS NULL OR TRIM(space_id) = ''",
                (DEFAULT_SPACE_ID,),
            )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_notes_space_parent_created_at "
            "ON notes(space_id, parent_id, created_at)"
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_spaces_created_at ON spaces(created_at)"
        )

    async def close(self) -> None:
        async with self._init_lock:
            if self._conn is not None:
                await self._conn.close()
                self._conn = None

    async def list_spaces(self) -> list[Space]:
        conn = await self._ensure_conn()
        cursor = await conn.execute(
            "SELECT id, name, created_at FROM spaces ORDER BY created_at ASC"
        )
        rows = await cursor.fetchall()
        await cursor.close()
        return [_row_to_space(row) for row in rows]

    async def create_space(self, name: str) -> Space:
        await self._ensure_conn()
        space = Space(
            id=uuid4().hex,
            name=name,
            createdAt=datetime.now(timezone.utc).isoformat(),
        )
        async with aiosqlite.connect(self._path, isolation_level=None) as conn:
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA foreign_keys=ON")
            await conn.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
            await conn.execute("BEGIN IMMEDIATE")
            try:
                await conn.execute(
                    "INSERT INTO spaces (id, name, created_at) VALUES (?, ?, ?)",
                    (space.id, space.name, space.createdAt),
                )
            except BaseException:
                await conn.execute("ROLLBACK")
                raise
            await conn.execute("COMMIT")
        return space

    async def update_space_name(self, space_id: str, name: str) -> Optional[Space]:
        await self._ensure_conn()
        async with aiosqlite.connect(self._path, isolation_level=None) as conn:
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA foreign_keys=ON")
            await conn.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
            await conn.execute("BEGIN IMMEDIATE")
            try:
                cursor = await conn.execute(
                    "UPDATE spaces SET name = ? WHERE id = ?",
                    (name, space_id),
                )
                updated_rows = cursor.rowcount
                await cursor.close()
                if updated_rows == 0:
                    await conn.execute("ROLLBACK")
                    return None
            except BaseException:
                await conn.execute("ROLLBACK")
                raise
            await conn.execute("COMMIT")
        return await self.get_space(space_id)

    async def delete_space(self, space_id: str) -> bool:
        await self._ensure_conn()
        async with aiosqlite.connect(self._path, isolation_level=None) as conn:
            await conn.execute("PRAGMA foreign_keys=ON")
            await conn.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
            await conn.execute("BEGIN IMMEDIATE")
            try:
                cursor = await conn.execute(
                    "DELETE FROM spaces WHERE id = ?",
                    (space_id,),
                )
                deleted_rows = cursor.rowcount
                await cursor.close()
                if deleted_rows == 0:
                    await conn.execute("ROLLBACK")
                    return False
            except BaseException:
                await conn.execute("ROLLBACK")
                raise
            await conn.execute("COMMIT")
        return True

    async def get_space(self, space_id: str) -> Optional[Space]:
        conn = await self._ensure_conn()
        cursor = await conn.execute(
            "SELECT id, name, created_at FROM spaces WHERE id = ?",
            (space_id,),
        )
        row = await cursor.fetchone()
        await cursor.close()
        return _row_to_space(row) if row else None

    async def list_children(self, space_id: str, parent_id: Optional[str]) -> list[Note]:
        conn = await self._ensure_conn()
        # Subquery yields the direct-child count per row so the UI can render
        # "Show N replies" affordances without an extra fetch per note.
        select_clause = (
            "SELECT n.id, n.parent_id, n.text, n.created_at, "
            "n.space_id, "
            "(SELECT COUNT(*) FROM notes c WHERE c.parent_id = n.id AND c.space_id = n.space_id) AS child_count "
            "FROM notes n"
        )
        if parent_id is None:
            cursor = await conn.execute(
                f"{select_clause} WHERE n.space_id = ? AND n.parent_id IS NULL ORDER BY n.created_at ASC",
                (space_id,),
            )
        else:
            cursor = await conn.execute(
                f"{select_clause} WHERE n.space_id = ? AND n.parent_id = ? ORDER BY n.created_at ASC",
                (space_id, parent_id),
            )
        rows = await cursor.fetchall()
        await cursor.close()
        return [_row_to_note(row) for row in rows]

    async def search_notes(self, space_id: str, query: str) -> list[Note]:
        conn = await self._ensure_conn()
        select_clause = (
            "SELECT n.id, n.parent_id, n.text, n.created_at, "
            "n.space_id, "
            "(SELECT COUNT(*) FROM notes c WHERE c.parent_id = n.id AND c.space_id = n.space_id) AS child_count "
            "FROM notes n"
        )
        normalized = query.strip().lower()
        cursor = await conn.execute(
            f"{select_clause} "
            "WHERE n.space_id = ? AND LOWER(n.text) LIKE ? "
            "ORDER BY n.created_at ASC",
            (space_id, f"%{normalized}%"),
        )
        rows = await cursor.fetchall()
        await cursor.close()
        return [_row_to_note(row) for row in rows]

    async def get(self, note_id: str, space_id: Optional[str] = None) -> Optional[Note]:
        conn = await self._ensure_conn()
        query = (
            "SELECT n.id, n.space_id, n.parent_id, n.text, n.created_at, "
            "(SELECT COUNT(*) FROM notes c WHERE c.parent_id = n.id AND c.space_id = n.space_id) AS child_count "
            "FROM notes n WHERE n.id = ?"
        )
        params: tuple[str, ...] = (note_id,)
        if space_id is not None:
            query += " AND n.space_id = ?"
            params = (note_id, space_id)
        cursor = await conn.execute(query, params)
        row = await cursor.fetchone()
        await cursor.close()
        return _row_to_note(row) if row else None

    async def ancestors(self, note_id: str, space_id: str) -> list[Note]:
        """Return ancestors ordered from root to immediate parent."""
        conn = await self._ensure_conn()
        cursor = await conn.execute(
            """
            WITH RECURSIVE chain(id, parent_id, text, created_at, space_id, depth) AS (
                SELECT n.id, n.parent_id, n.text, n.created_at, n.space_id, 0
                FROM notes n
                WHERE n.space_id = ? AND n.id = (
                    SELECT parent_id FROM notes WHERE id = ? AND space_id = ?
                )
                UNION ALL
                SELECT n.id, n.parent_id, n.text, n.created_at, n.space_id, c.depth + 1
                FROM notes n
                JOIN chain c ON n.id = c.parent_id
                WHERE n.space_id = ? AND c.depth < ?
            )
            SELECT id, space_id, parent_id, text, created_at FROM chain
            """,
            (space_id, note_id, space_id, space_id, _MAX_ANCESTOR_DEPTH),
        )
        rows = await cursor.fetchall()
        await cursor.close()
        # CTE walks parent -> grandparent -> ...; reverse for root-first.
        return [_row_to_note(row) for row in reversed(rows)]

    async def create(self, text: str, parent_id: Optional[str], space_id: str) -> Note:
        # Make sure the schema/WAL/PRAGMAs have been initialized (this is a
        # no-op once the read connection has been opened).
        await self._ensure_conn()
        note = Note(
            id=uuid4().hex,
            spaceId=space_id,
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
                        "SELECT 1 FROM notes WHERE id = ? AND space_id = ?",
                        (parent_id, space_id),
                    )
                    row = await cursor.fetchone()
                    await cursor.close()
                    if row is None:
                        raise KeyError(parent_id)
                await conn.execute(
                    "INSERT INTO notes (id, space_id, parent_id, text, created_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (note.id, note.spaceId, note.parentId, note.text, note.createdAt),
                )
            except BaseException:
                await conn.execute("ROLLBACK")
                raise
            await conn.execute("COMMIT")
        return note

    async def update_text(
        self, note_id: str, text: str, space_id: Optional[str] = None
    ) -> Optional[Note]:
        # Make sure schema/WAL/PRAGMAs are initialized before write connection.
        await self._ensure_conn()
        async with aiosqlite.connect(
            self._path, isolation_level=None
        ) as conn:
            await conn.execute("PRAGMA foreign_keys=ON")
            await conn.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
            await conn.execute("BEGIN IMMEDIATE")
            try:
                if space_id is None:
                    cursor = await conn.execute(
                        "UPDATE notes SET text = ? WHERE id = ?",
                        (text, note_id),
                    )
                else:
                    cursor = await conn.execute(
                        "UPDATE notes SET text = ? WHERE id = ? AND space_id = ?",
                        (text, note_id, space_id),
                    )
                updated_rows = cursor.rowcount
                await cursor.close()
                if updated_rows == 0:
                    await conn.execute("ROLLBACK")
                    return None
            except BaseException:
                await conn.execute("ROLLBACK")
                raise
            await conn.execute("COMMIT")
        return await self.get(note_id, space_id=space_id)

    async def delete(self, note_id: str, space_id: Optional[str] = None) -> bool:
        # Make sure schema/WAL/PRAGMAs are initialized before write connection.
        await self._ensure_conn()
        async with aiosqlite.connect(
            self._path, isolation_level=None
        ) as conn:
            await conn.execute("PRAGMA foreign_keys=ON")
            await conn.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
            await conn.execute("BEGIN IMMEDIATE")
            try:
                if space_id is None:
                    cursor = await conn.execute(
                        "DELETE FROM notes WHERE id = ?",
                        (note_id,),
                    )
                else:
                    cursor = await conn.execute(
                        "DELETE FROM notes WHERE id = ? AND space_id = ?",
                        (note_id, space_id),
                    )
                deleted_rows = cursor.rowcount
                await cursor.close()
                if deleted_rows == 0:
                    await conn.execute("ROLLBACK")
                    return False
            except BaseException:
                await conn.execute("ROLLBACK")
                raise
            await conn.execute("COMMIT")
        return True
