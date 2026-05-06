"""JWT-based auth utilities and FastAPI dependencies."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException, Request
from jose import JWTError, jwt

from .store import NoteStore, User

JWT_SECRET = os.environ.get("JWT_SECRET", "dev-secret-change-me")
JWT_ALGORITHM = "HS256"
JWT_MAX_AGE = int(os.environ.get("JWT_MAX_AGE_SECONDS", 2592000))  # 30 days
COOKIE_NAME = "threaded_session"
OAUTH_STATE_COOKIE = "threaded_oauth_state"

# Injected by main.py after store is created.
_store: Optional[NoteStore] = None


def init(store: NoteStore) -> None:
    global _store
    _store = store


def create_jwt(user_id: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(seconds=JWT_MAX_AGE)
    return jwt.encode({"sub": user_id, "exp": exp}, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_jwt(token: str) -> dict:
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])


def create_state_token() -> str:
    exp = datetime.now(timezone.utc) + timedelta(minutes=10)
    import secrets
    nonce = secrets.token_urlsafe(32)
    return jwt.encode({"nonce": nonce, "exp": exp}, JWT_SECRET, algorithm=JWT_ALGORITHM)


def _is_secure(request: Request) -> bool:
    return request.headers.get("x-forwarded-proto", "http") == "https"


async def get_current_user(request: Request) -> User:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_jwt(token)
        user_id: str = payload["sub"]
    except (JWTError, KeyError):
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    assert _store is not None
    user = await _store.get_user_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    return user


async def get_optional_user(request: Request) -> Optional[User]:
    try:
        return await get_current_user(request)
    except HTTPException:
        return None
