"""FastAPI app entrypoint for the Swipe Partner API mock.

Run:  uvicorn mock_backend.main:app --reload
Docs: http://127.0.0.1:8000/docs
"""
from __future__ import annotations

import logging

from fastapi import Depends, FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .auth import require_auth
from .config import settings
from .errors import SwipeError, error_body, swipe_error_handler
from .routers import documents, llm, misc, parties, payments, products
from .store import db

logger = logging.getLogger("swipe_mock")

app = FastAPI(
    title="Swipe Partner API (Mock)",
    version="0.1.0",
    description=(
        "Offline mock of Swipe's Partner API v2, built to the public OpenAPI "
        "spec. Same request/response shapes; GST math computed for real."
    ),
)

# --- CORS: let the browser frontend (served from any local origin / file) ---- #
# call the API directly. The real Partner API is server-to-server, but this mock
# is meant to be driven from the demo web UI, so we allow cross-origin requests.
# Overridable via MOCK_CORS_ORIGINS (comma-separated); defaults to "*".
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,  # bearer-token auth only; no cookies → no CSRF surface
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Security headers on every response ------------------------------------ #
# Cheap defence-in-depth. HSTS is intentionally NOT set here — set it at the
# TLS-terminating proxy/CDN (only valid over HTTPS), per DEPLOYMENT.md.
@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Permissions-Policy"] = "geolocation=(), camera=(), microphone=()"
    return resp

# --- Exception handlers: every error uses Swipe's envelope ------------------ #
app.add_exception_handler(SwipeError, swipe_error_handler)


@app.exception_handler(RequestValidationError)
async def validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content=error_body(
            "BAD_REQUEST",
            "Request validation failed.",
            errors={"detail": jsonable_encoder(exc.errors())},
        ),
    )


@app.exception_handler(Exception)
async def unknown_handler(_: Request, exc: Exception) -> JSONResponse:
    # Log the full traceback so unexpected failures are debuggable; return the
    # spec's generic envelope to the client.
    logger.exception("Unhandled error: %s", exc)
    return JSONResponse(
        status_code=500,
        content=error_body("UNKNOWN_ERROR", str(exc) or "Unexpected error."),
    )


# --- Routers (all require bearer auth, mirroring production) ---------------- #
_auth = [Depends(require_auth)]
app.include_router(parties.router, dependencies=_auth)
app.include_router(documents.router, dependencies=_auth)
app.include_router(payments.router, dependencies=_auth)
app.include_router(products.router, dependencies=_auth)
app.include_router(misc.router, dependencies=_auth)

# The LLM proxy is intentionally UNauthenticated (see routers/llm.py): the
# browser calls it tokenless, and in live mode must never send the Swipe key to
# this origin. Rate-limit at the edge for a public deploy.
app.include_router(llm.router)


# --- Unauthenticated helper endpoints (mock-only) -------------------------- #
@app.get("/health", tags=["Mock"])
async def health() -> dict:
    return {"status": "ok", "mode": "mock"}


@app.get("/v2/_mock/company", tags=["Mock"])
async def company() -> dict:
    """Expose the seller (company) profile so the frontend can show the right
    intra/inter-state GST split. The real API has no public company endpoint;
    this is a mock-only convenience that mirrors `store.company`.

    Note: like `/v2/_mock/reset`, the `/v2/_mock/*` helpers intentionally return
    bare dicts rather than the Swipe success envelope — they're out-of-band dev
    helpers, not spec endpoints, and the frontend reads this shape directly.
    """
    return db.company


@app.post("/v2/_mock/reset", tags=["Mock"])
async def reset() -> dict:
    """Reset all data back to the seed set (handy between demos/tests)."""
    db.reset()
    return {
        "success": True,
        "message": "Mock data reset.",
        "counts": {
            "customers": len(db.customers),
            "vendors": len(db.vendors),
            "products": len(db.products),
            "documents": len(db.documents),
            "payments": len(db.payments),
        },
    }
