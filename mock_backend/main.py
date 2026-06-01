"""FastAPI app entrypoint for the Swipe Partner API mock.

Run:  uvicorn mock_backend.main:app --reload
Docs: http://127.0.0.1:8000/docs
"""
from __future__ import annotations

import logging

from fastapi import Depends, FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .auth import require_auth
from .errors import SwipeError, error_body, swipe_error_handler
from .routers import documents, misc, parties, payments, products
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


# --- Unauthenticated helper endpoints (mock-only) -------------------------- #
@app.get("/health", tags=["Mock"])
async def health() -> dict:
    return {"status": "ok", "mode": "mock"}


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
