"""Runtime configuration, all overridable via environment variables.

The defaults make the server runnable with zero setup (`uvicorn
mock_backend.main:app`) while still exercising the real auth flow.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import List


def _flag(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


def _origins() -> List[str]:
    # Comma-separated list of allowed CORS origins; "*" (the default) allows any.
    raw = os.getenv("MOCK_CORS_ORIGINS", "*").strip()
    return [o.strip() for o in raw.split(",") if o.strip()] or ["*"]


@dataclass(frozen=True)
class Settings:
    # Whether to enforce an `Authorization: Bearer <token>` header. OFF by
    # default: the mock serves only fake, resettable seed data, so there's
    # nothing to protect (the user's real Swipe key never touches this backend).
    # Flip on with MOCK_REQUIRE_AUTH=true to mirror the real API's auth flow
    # (e.g. when exercising the same client code against live Swipe).
    require_auth: bool = _flag("MOCK_REQUIRE_AUTH", False)
    # If auth is enabled and this is set, only this exact token is accepted. If
    # empty, ANY non-empty bearer token is accepted — convenient for dev/demo.
    api_token: str = os.getenv("MOCK_API_TOKEN", "")
    host: str = os.getenv("MOCK_HOST", "127.0.0.1")
    port: int = int(os.getenv("MOCK_PORT", "8000"))
    # Origins the browser frontend may call the API from.
    cors_origins: List[str] = field(default_factory=_origins)


settings = Settings()
