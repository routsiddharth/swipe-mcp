"""Swipe-style error envelope and the SwipeError exception.

Every error response follows the spec's shape:
    {"success": false, "error_code": "...", "message": "...", "errors": {}}
Error codes are drawn from https://developers.getswipe.in/api-reference/error-codes
"""
from __future__ import annotations

from typing import Optional

from fastapi import Request
from fastapi.responses import JSONResponse


class SwipeError(Exception):
    def __init__(
        self,
        error_code: str,
        message: str,
        status_code: int = 400,
        errors: Optional[dict] = None,
    ):
        self.error_code = error_code
        self.message = message
        self.status_code = status_code
        self.errors = errors or {}
        super().__init__(message)


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
