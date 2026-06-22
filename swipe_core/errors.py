"""The coded ``SwipeError`` exception, framework-free.

This is the single error type the GST math raises (``INVALID_TAX_RATE``) and the
type the mock backend raises throughout. It carries everything the Swipe error
envelope needs, but knows nothing about FastAPI — the HTTP handler that turns it
into a JSON response lives in ``mock_backend.errors``, which re-exports this
class so the identity is shared across both packages.
"""
from __future__ import annotations

from typing import Optional


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
