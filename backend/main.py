"""FastAPI app exposing the threaded note API.

Endpoints:
- GET /api/notes?parentId=...    list root notes or direct children
- GET /api/notes/{id}/thread     focused note with children + ancestor path
- POST /api/notes                create root or child note
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .store import Note, NoteStore

DATABASE_PATH = Path(
    os.environ.get(
        "THREADED_DATABASE_PATH",
        str(Path(__file__).resolve().parent / "data" / "threaded.sqlite3"),
    )
)

# Default page size for the ancestor breadcrumb. Newest ancestors win when
# the chain is longer than this so the user can keep stepping upward.
ANCESTOR_PAGE_SIZE = 5


app = FastAPI(title="Threaded API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

store = NoteStore(DATABASE_PATH)


@app.on_event("shutdown")
async def _close_store() -> None:
    await store.close()


class NoteOut(BaseModel):
    id: str
    parentId: Optional[str]
    text: str
    createdAt: str

    @classmethod
    def from_note(cls, note: Note) -> "NoteOut":
        return cls(
            id=note.id,
            parentId=note.parentId,
            text=note.text,
            createdAt=note.createdAt,
        )


class CreateNoteIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=10_000)
    parentId: Optional[str] = None


class ThreadView(BaseModel):
    note: NoteOut
    children: list[NoteOut]
    ancestors: list[NoteOut]
    hasMoreAncestors: bool
    totalAncestors: int


def _normalize_parent_id(parent_id: Optional[str]) -> Optional[str]:
    if parent_id is None:
        return None
    cleaned = parent_id.strip()
    if not cleaned or cleaned.lower() in {"null", "none", "root"}:
        return None
    return cleaned


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/api/notes", response_model=list[NoteOut])
async def list_notes(parentId: Optional[str] = Query(default=None)) -> list[NoteOut]:
    parent = _normalize_parent_id(parentId)
    if parent is not None:
        if await store.get(parent) is None:
            raise HTTPException(status_code=404, detail="Parent note not found")
    children = await store.list_children(parent)
    return [NoteOut.from_note(n) for n in children]


@app.get("/api/notes/{note_id}/thread", response_model=ThreadView)
async def get_thread(
    note_id: str,
    ancestorLimit: int = Query(default=ANCESTOR_PAGE_SIZE, ge=1, le=50),
) -> ThreadView:
    note = await store.get(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")

    children = await store.list_children(note.id)
    full_chain = await store.ancestors(note.id)
    total = len(full_chain)
    visible = full_chain[-ancestorLimit:] if ancestorLimit < total else full_chain
    has_more = total > len(visible)

    return ThreadView(
        note=NoteOut.from_note(note),
        children=[NoteOut.from_note(n) for n in children],
        ancestors=[NoteOut.from_note(n) for n in visible],
        hasMoreAncestors=has_more,
        totalAncestors=total,
    )


@app.post("/api/notes", response_model=NoteOut, status_code=201)
async def create_note(payload: CreateNoteIn) -> NoteOut:
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text cannot be empty")
    parent_id = _normalize_parent_id(payload.parentId)
    try:
        note = await store.create(text=text, parent_id=parent_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Parent note not found")
    return NoteOut.from_note(note)
