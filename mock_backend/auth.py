"""Bearer-token auth dependency, mirroring the real API's auth flow.

The real Partner API authenticates with `Authorization: Bearer <JWT>`. We don't
validate a real JWT (this is a mock), but we DO enforce the header so the
frontend / MCP client wires up auth exactly as it would against production.
"""
from __future__ import annotations

from typing import Optional

from fastapi import Header

from .config import settings
from .errors import SwipeError


async def require_auth(authorization: Optional[str] = Header(default=None)) -> Optional[str]:
    if not settings.require_auth:
        return None

    if not authorization or not authorization.lower().startswith("bearer "):
        raise SwipeError(
            "UNAUTHORIZED",
            "Missing bearer token. Send header 'Authorization: Bearer <token>'.",
            status_code=401,
        )

    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise SwipeError("UNAUTHORIZED", "Empty bearer token.", status_code=401)
    if settings.api_token and token != settings.api_token:
        raise SwipeError("UNAUTHORIZED", "Invalid API token.", status_code=401)
    return token
