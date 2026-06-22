"""Swipe-style error envelope and the SwipeError exception.

Every error response follows the spec's shape:
    {"success": false, "error_code": "...", "message": "...", "errors": {}}
Error codes are drawn from https://developers.getswipe.in/api-reference/error-codes

The ``SwipeError`` class itself lives in the framework-free ``swipe_core.errors``
so the MCP server can raise/catch the same type without importing this mock. It
is re-exported here so every existing ``from .errors import SwipeError`` (and the
FastAPI handler below) keeps the identical class identity.
"""
from __future__ import annotations

from typing import Optional

from fastapi import Request
from fastapi.responses import JSONResponse

from swipe_core.errors import SwipeError

__all__ = ["SwipeError", "error_body", "ok", "swipe_error_handler"]


def error_body(error_code: str, message: str, errors: Optional[dict] = None) -> dict:
    return {
        "success": False,
        "error_code": error_code,
        "message": message,
        "errors": errors or {},
    }


def ok(message: str, data=None, **extra) -> dict:
    """Build a standard success envelope."""
    body = {"success": True, "message": message, "error_code": "", "errors": {}}
    if data is not None:
        body["data"] = data
    body.update(extra)
    return body


async def swipe_error_handler(_: Request, exc: SwipeError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content=error_body(exc.error_code, exc.message, exc.errors),
    )
