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

import httpx
from authlib.integrations.httpx_client import AsyncOAuth2Client
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from . import auth as auth_module
from .auth import (
    COOKIE_NAME,
    OAUTH_STATE_COOKIE,
    create_jwt,
    create_state_token,
    decode_jwt,
    get_current_user,
    _is_secure,
)
from .store import Note, NoteStore, Space, Tag, User

DATABASE_PATH = Path(
    os.environ.get(
        "THREADED_DATABASE_PATH",
        str(Path(__file__).resolve().parent / "data" / "threaded.sqlite3"),
    )
)

APP_BASE_URL = os.environ.get("APP_BASE_URL", "http://localhost:8080").rstrip("/")
BACKEND_BASE_URL = os.environ.get("BACKEND_BASE_URL", "http://localhost:8000").rstrip("/")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = f"{BACKEND_BASE_URL}/api/auth/google/callback"
GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"

# Default page size for the ancestor breadcrumb. Newest ancestors win when
# the chain is longer than this so the user can keep stepping upward.
ANCESTOR_PAGE_SIZE = 5
_TAG_FRAGMENT_RE = re.compile(r"#(\w+)")


app = FastAPI(title="Threaded API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[APP_BASE_URL],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

store = NoteStore(DATABASE_PATH)
auth_module.init(store)


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


class UserOut(BaseModel):
    id: str
    email: str
    displayName: Optional[str]
    avatarUrl: Optional[str]

    @classmethod
    def from_user(cls, user: User) -> "UserOut":
        return cls(
            id=user.id,
            email=user.email,
            displayName=user.displayName,
            avatarUrl=user.avatarUrl,
        )


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


# ---------------------------------------------------------------------------
# Auth endpoints
# ---------------------------------------------------------------------------

@app.get("/api/auth/google/login")
async def google_login(request: Request, response: Response) -> RedirectResponse:
    state = create_state_token()
    redirect = RedirectResponse(
        url=(
            f"{GOOGLE_AUTHORIZE_URL}"
            f"?client_id={GOOGLE_CLIENT_ID}"
            f"&redirect_uri={GOOGLE_REDIRECT_URI}"
            f"&response_type=code"
            f"&scope=openid+email+profile"
            f"&state={state}"
            f"&access_type=offline"
        )
    )
    redirect.set_cookie(
        key=OAUTH_STATE_COOKIE,
        value=state,
        httponly=True,
        samesite="lax",
        secure=_is_secure(request),
        max_age=600,
        path="/",
    )
    return redirect


@app.get("/api/auth/google/callback")
async def google_callback(
    request: Request,
    code: str = Query(...),
    state: str = Query(...),
) -> RedirectResponse:
    stored_state = request.cookies.get(OAUTH_STATE_COOKIE)
    if not stored_state or stored_state != state:
        raise HTTPException(status_code=400, detail="Invalid OAuth state")
    try:
        decode_jwt(state)
    except Exception:
        raise HTTPException(status_code=400, detail="Expired OAuth state")

    async with httpx.AsyncClient() as client:
        token_resp = await client.post(
            GOOGLE_TOKEN_URL,
            data={
                "code": code,
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri": GOOGLE_REDIRECT_URI,
                "grant_type": "authorization_code",
            },
        )
    if token_resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to exchange OAuth code")

    access_token = token_resp.json().get("access_token")
    async with httpx.AsyncClient() as client:
        info_resp = await client.get(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
        )
    if info_resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch Google user info")

    info = info_resp.json()
    user = await store.upsert_user(
        google_sub=info["id"],
        email=info["email"],
        display_name=info.get("name"),
        avatar_url=info.get("picture"),
    )

    jwt_token = create_jwt(user.id)
    redirect = RedirectResponse(url="/", status_code=302)
    redirect.delete_cookie(OAUTH_STATE_COOKIE, path="/")
    redirect.set_cookie(
        key=COOKIE_NAME,
        value=jwt_token,
        httponly=True,
        samesite="none",
        secure=_is_secure(request),
        max_age=auth_module.JWT_MAX_AGE,
        path="/",
    )
    return redirect


@app.get("/api/auth/me", response_model=UserOut)
async def auth_me(current_user: User = Depends(get_current_user)) -> UserOut:
    return UserOut.from_user(current_user)


@app.post("/api/auth/logout")
async def auth_logout(request: Request) -> dict:
    resp = Response(content='{"ok":true}', media_type="application/json")
    resp.delete_cookie(COOKIE_NAME, path="/", samesite="lax", httponly=True)
    return Response(
        content='{"ok":true}',
        media_type="application/json",
        headers={"Set-Cookie": f"{COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax"},
    )


# ---------------------------------------------------------------------------
# Core API
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/api/spaces", response_model=list[SpaceOut])
async def list_spaces(current_user: User = Depends(get_current_user)) -> list[SpaceOut]:
    spaces = await store.list_spaces(user_id=current_user.id)
    return [SpaceOut.from_space(space) for space in spaces]


@app.post("/api/spaces", response_model=SpaceOut, status_code=201)
async def create_space(
    payload: CreateSpaceIn,
    current_user: User = Depends(get_current_user),
) -> SpaceOut:
    name = _normalize_space_name(payload.name)
    try:
        space = await store.create_space(name, user_id=current_user.id)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="Space name already exists")
    return SpaceOut.from_space(space)


@app.patch("/api/spaces/{space_id}", response_model=SpaceOut)
async def update_space(
    space_id: str,
    payload: UpdateSpaceIn,
    current_user: User = Depends(get_current_user),
) -> SpaceOut:
    name = _normalize_space_name(payload.name)
    try:
        space = await store.update_space_name(
            space_id=space_id, name=name, user_id=current_user.id
        )
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="Space name already exists")
    if space is None:
        raise HTTPException(status_code=404, detail="Space not found")
    return SpaceOut.from_space(space)


@app.delete("/api/spaces/{space_id}", status_code=204, response_class=Response)
async def delete_space(
    space_id: str,
    current_user: User = Depends(get_current_user),
) -> Response:
    spaces = await store.list_spaces(user_id=current_user.id)
    if len(spaces) <= 1:
        raise HTTPException(
            status_code=400,
            detail="At least one space must remain",
        )
    deleted = await store.delete_space(space_id=space_id, user_id=current_user.id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Space not found")
    return Response(status_code=204)


@app.get("/api/notes", response_model=list[NoteOut])
async def list_notes(
    spaceId: str = Query(..., min_length=1),
    parentId: Optional[str] = Query(default=None),
    tag: list[str] = Query(default=[]),
    dateFrom: Optional[str] = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    dateTo: Optional[str] = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    current_user: User = Depends(get_current_user),
) -> list[NoteOut]:
    space = _normalize_space_id(spaceId)
    if await store.get_space(space, user_id=current_user.id) is None:
        raise HTTPException(status_code=404, detail="Space not found")
    parent = _normalize_parent_id(parentId)
    if parent is not None:
        if await store.get(parent, space_id=space) is None:
            raise HTTPException(status_code=404, detail="Parent note not found")
    children = await store.list_children(space, parent, tags=tag, date_from=dateFrom, date_to=dateTo)
    return [NoteOut.from_note(n) for n in children]


@app.get("/api/notes/search", response_model=list[NoteOut])
async def search_notes(
    spaceId: str = Query(..., min_length=1),
    query: str = Query(..., min_length=1, max_length=500),
    tag: list[str] = Query(default=[]),
    dateFrom: Optional[str] = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    dateTo: Optional[str] = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    current_user: User = Depends(get_current_user),
) -> list[NoteOut]:
    space = _normalize_space_id(spaceId)
    if await store.get_space(space, user_id=current_user.id) is None:
        raise HTTPException(status_code=404, detail="Space not found")
    text_query = " ".join(query.split()).strip()
    if not text_query:
        raise HTTPException(status_code=400, detail="Query cannot be empty")
    matches = await store.search_notes(space_id=space, query=text_query, tags=tag, date_from=dateFrom, date_to=dateTo)
    return [NoteOut.from_note(note) for note in matches]


@app.get("/api/tags", response_model=list[TagOut])
async def list_tags(
    spaceId: str = Query(..., min_length=1),
    current_user: User = Depends(get_current_user),
) -> list[TagOut]:
    space = _normalize_space_id(spaceId)
    if await store.get_space(space, user_id=current_user.id) is None:
        raise HTTPException(status_code=404, detail="Space not found")
    tags = await store.list_tags(space_id=space)
    return [TagOut.from_tag(tag) for tag in tags]


@app.get("/api/notes/{note_id}/thread", response_model=ThreadView)
async def get_thread(
    note_id: str,
    spaceId: str = Query(..., min_length=1),
    ancestorLimit: int = Query(default=ANCESTOR_PAGE_SIZE, ge=1, le=50),
    current_user: User = Depends(get_current_user),
) -> ThreadView:
    space = _normalize_space_id(spaceId)
    if await store.get_space(space, user_id=current_user.id) is None:
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
async def create_note(
    payload: CreateNoteIn,
    current_user: User = Depends(get_current_user),
) -> NoteOut:
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text cannot be empty")
    space = _normalize_space_id(payload.spaceId)
    if await store.get_space(space, user_id=current_user.id) is None:
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
    note_id: str,
    payload: UpdateNoteIn,
    spaceId: str = Query(..., min_length=1),
    current_user: User = Depends(get_current_user),
) -> NoteOut:
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text cannot be empty")
    space = _normalize_space_id(spaceId)
    if await store.get_space(space, user_id=current_user.id) is None:
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
    note_id: str,
    spaceId: str = Query(..., min_length=1),
    current_user: User = Depends(get_current_user),
) -> Response:
    space = _normalize_space_id(spaceId)
    if await store.get_space(space, user_id=current_user.id) is None:
        raise HTTPException(status_code=404, detail="Space not found")
    deleted = await store.delete(note_id=note_id, space_id=space)
    if not deleted:
        raise HTTPException(status_code=404, detail="Note not found")
    return Response(status_code=204)
