"""FastAPI app exposing the threaded note API.

Endpoints:
- GET /api/notes?parentId=...    list root notes or direct children
- GET /api/notes/search          search notes by text within a space
- GET /api/notes/{id}/thread     focused note with children + ancestor path
- POST /api/notes                create root or child note
- PATCH /api/notes/{id}          update note text
- DELETE /api/notes/{id}         delete note subtree
"""

from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .store import DEFAULT_SPACE_ID, Note, NoteStore, Space, Tag

DATABASE_PATH = Path(
    os.environ.get(
        "THREADED_DATABASE_PATH",
        str(Path(__file__).resolve().parent / "data" / "threaded.sqlite3"),
    )
)

# Default page size for the ancestor breadcrumb. Newest ancestors win when
# the chain is longer than this so the user can keep stepping upward.
ANCESTOR_PAGE_SIZE = 5
_TAG_FRAGMENT_RE = re.compile(r"#(\w+)")


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
    spaceId: str
    parentId: Optional[str]
    text: str
    createdAt: str
    childCount: int = 0
    tags: list[str] = Field(default_factory=list)

    @classmethod
    def from_note(cls, note: Note) -> "NoteOut":
        return cls(
            id=note.id,
            spaceId=note.spaceId,
            parentId=note.parentId,
            text=note.text,
            createdAt=note.createdAt,
            childCount=note.childCount,
            tags=note.tags or [],
        )


class CreateNoteIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=10_000)
    spaceId: str = Field(..., min_length=1, max_length=255)
    parentId: Optional[str] = None
    tags: Optional[list[str]] = None


class UpdateNoteIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=10_000)
    tags: Optional[list[str]] = None


class TagOut(BaseModel):
    name: str
    count: int

    @classmethod
    def from_tag(cls, tag: Tag) -> "TagOut":
        return cls(name=tag.name, count=tag.noteCount)


class SpaceOut(BaseModel):
    id: str
    name: str
    createdAt: str

    @classmethod
    def from_space(cls, space: Space) -> "SpaceOut":
        return cls(
            id=space.id,
            name=space.name,
            createdAt=space.createdAt,
        )


class CreateSpaceIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


class UpdateSpaceIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


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


def _normalize_space_id(space_id: str) -> str:
    cleaned = space_id.strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="spaceId is required")
    return cleaned


def _normalize_space_name(name: str) -> str:
    cleaned = " ".join(name.split()).strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="Space name cannot be empty")
    return cleaned


def _extract_text_tags(text: str) -> list[str]:
    tags: list[str] = []
    seen: set[str] = set()
    for match in _TAG_FRAGMENT_RE.finditer(text):
        tag = match.group(1).lower()
        if not tag or tag in seen:
            continue
        seen.add(tag)
        tags.append(tag)
    return tags


def _normalize_tags(tags: Optional[list[str]]) -> list[str]:
    if tags is None:
        return []
    normalized: list[str] = []
    seen: set[str] = set()
    for raw_tag in tags:
        cleaned = raw_tag.strip().lstrip("#").lower()
        if not cleaned:
            continue
        if not cleaned.replace("_", "").isalnum():
            continue
        if cleaned in seen:
            continue
        seen.add(cleaned)
        normalized.append(cleaned)
    return normalized


def _resolve_tags(explicit_tags: Optional[list[str]], text: str) -> list[str]:
    if explicit_tags is None:
        return _extract_text_tags(text)
    return _normalize_tags(explicit_tags)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/api/spaces", response_model=list[SpaceOut])
async def list_spaces() -> list[SpaceOut]:
    spaces = await store.list_spaces()
    return [SpaceOut.from_space(space) for space in spaces]


@app.post("/api/spaces", response_model=SpaceOut, status_code=201)
async def create_space(payload: CreateSpaceIn) -> SpaceOut:
    name = _normalize_space_name(payload.name)
    try:
        space = await store.create_space(name)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="Space name already exists")
    return SpaceOut.from_space(space)


@app.patch("/api/spaces/{space_id}", response_model=SpaceOut)
async def update_space(space_id: str, payload: UpdateSpaceIn) -> SpaceOut:
    name = _normalize_space_name(payload.name)
    try:
        space = await store.update_space_name(space_id=space_id, name=name)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="Space name already exists")
    if space is None:
        raise HTTPException(status_code=404, detail="Space not found")
    return SpaceOut.from_space(space)


@app.delete("/api/spaces/{space_id}", status_code=204, response_class=Response)
async def delete_space(space_id: str) -> Response:
    spaces = await store.list_spaces()
    if len(spaces) <= 1:
        raise HTTPException(
            status_code=400,
            detail="At least one space must remain",
        )
    if space_id == DEFAULT_SPACE_ID and len(spaces) > 1:
        # Keep default space stable for legacy links and startup backfills.
        raise HTTPException(
            status_code=400,
            detail="Default space cannot be deleted",
        )
    deleted = await store.delete_space(space_id=space_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Space not found")
    return Response(status_code=204)


@app.get("/api/notes", response_model=list[NoteOut])
async def list_notes(
    spaceId: str = Query(..., min_length=1),
    parentId: Optional[str] = Query(default=None),
    tag: list[str] = Query(default=[]),
) -> list[NoteOut]:
    space = _normalize_space_id(spaceId)
    if await store.get_space(space) is None:
        raise HTTPException(status_code=404, detail="Space not found")
    parent = _normalize_parent_id(parentId)
    if parent is not None:
        if await store.get(parent, space_id=space) is None:
            raise HTTPException(status_code=404, detail="Parent note not found")
    children = await store.list_children(space, parent, tags=tag)
    return [NoteOut.from_note(n) for n in children]


@app.get("/api/notes/search", response_model=list[NoteOut])
async def search_notes(
    spaceId: str = Query(..., min_length=1),
    query: str = Query(..., min_length=1, max_length=500),
    tag: list[str] = Query(default=[]),
) -> list[NoteOut]:
    space = _normalize_space_id(spaceId)
    if await store.get_space(space) is None:
        raise HTTPException(status_code=404, detail="Space not found")
    text_query = " ".join(query.split()).strip()
    if not text_query:
        raise HTTPException(status_code=400, detail="Query cannot be empty")
    matches = await store.search_notes(space_id=space, query=text_query, tags=tag)
    return [NoteOut.from_note(note) for note in matches]


@app.get("/api/tags", response_model=list[TagOut])
async def list_tags(spaceId: str = Query(..., min_length=1)) -> list[TagOut]:
    space = _normalize_space_id(spaceId)
    if await store.get_space(space) is None:
        raise HTTPException(status_code=404, detail="Space not found")
    tags = await store.list_tags(space_id=space)
    return [TagOut.from_tag(tag) for tag in tags]


@app.get("/api/notes/{note_id}/thread", response_model=ThreadView)
async def get_thread(
    note_id: str,
    spaceId: str = Query(..., min_length=1),
    ancestorLimit: int = Query(default=ANCESTOR_PAGE_SIZE, ge=1, le=50),
) -> ThreadView:
    space = _normalize_space_id(spaceId)
    if await store.get_space(space) is None:
        raise HTTPException(status_code=404, detail="Space not found")
    note = await store.get(note_id, space_id=space)
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")

    children = await store.list_children(space, note.id)
    full_chain = await store.ancestors(note.id, space)
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
    space = _normalize_space_id(payload.spaceId)
    if await store.get_space(space) is None:
        raise HTTPException(status_code=404, detail="Space not found")
    parent_id = _normalize_parent_id(payload.parentId)
    tags = _resolve_tags(payload.tags, text)
    try:
        note = await store.create(
            text=text,
            parent_id=parent_id,
            space_id=space,
            tags=tags,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="Parent note not found")
    return NoteOut.from_note(note)


@app.patch("/api/notes/{note_id}", response_model=NoteOut)
async def update_note(
    note_id: str, payload: UpdateNoteIn, spaceId: str = Query(..., min_length=1)
) -> NoteOut:
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text cannot be empty")
    space = _normalize_space_id(spaceId)
    if await store.get_space(space) is None:
        raise HTTPException(status_code=404, detail="Space not found")
    tags = _resolve_tags(payload.tags, text)
    note = await store.update_text(
        note_id=note_id,
        text=text,
        space_id=space,
        tags=tags,
    )
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")
    return NoteOut.from_note(note)


@app.delete("/api/notes/{note_id}", status_code=204, response_class=Response)
async def delete_note(
    note_id: str, spaceId: str = Query(..., min_length=1)
) -> Response:
    space = _normalize_space_id(spaceId)
    if await store.get_space(space) is None:
        raise HTTPException(status_code=404, detail="Space not found")
    deleted = await store.delete(note_id=note_id, space_id=space)
    if not deleted:
        raise HTTPException(status_code=404, detail="Note not found")
    return Response(status_code=204)
