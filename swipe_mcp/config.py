"""Runtime configuration for the Swipe MCP server."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv

LIVE_API_BASE = "https://app.getswipe.in/api/partner"

# The repository-root .env, resolved by absolute path so the server finds the
# key no matter what working directory the MCP host (e.g. Claude Desktop)
# launches it from.
REPO_ENV = Path(__file__).resolve().parents[1] / ".env"


def _load_env() -> None:
    if REPO_ENV.is_file():
        load_dotenv(REPO_ENV)
    else:
        load_dotenv()


class ConfigurationError(ValueError):
    """Raised when environment configuration is invalid or unsafe."""


@dataclass(frozen=True)
class SwipeConfig:
    mode: Literal["mock", "live"] = "mock"
    backend_url: str = "http://127.0.0.1:8000"
    api_token: str = ""
    company_state: str = ""
    timeout: float = 20.0

    @classmethod
    def from_env(cls) -> "SwipeConfig":
        _load_env()

        backend_url = os.getenv("SWIPE_BACKEND_URL", "http://127.0.0.1:8000").strip()
        if not backend_url.startswith(("http://", "https://")):
            raise ConfigurationError("SWIPE_BACKEND_URL must be an http(s) URL.")

        token = (
            os.getenv("SWIPE_API_TOKEN", "").strip()
            or os.getenv("SWIPE_API_KEY", "").strip()
        )

        # Default to live whenever a key is present so the server is wired to the
        # real Swipe account out of the box. Set SWIPE_MODE=mock explicitly to
        # force the key-free local backend.
        raw_mode = os.getenv("SWIPE_MODE", "").strip().lower()
        if raw_mode:
            mode = raw_mode
        else:
            mode = "live" if token else "mock"
        if mode not in {"mock", "live"}:
            raise ConfigurationError("SWIPE_MODE must be 'mock' or 'live'.")

        if mode == "live" and not token:
            raise ConfigurationError(
                "SWIPE_MODE=live requires SWIPE_API_TOKEN (or SWIPE_API_KEY) in the "
                "environment or .env."
            )

        try:
            timeout = float(os.getenv("SWIPE_HTTP_TIMEOUT", "20"))
        except ValueError as exc:
            raise ConfigurationError("SWIPE_HTTP_TIMEOUT must be a number.") from exc
        if timeout <= 0:
            raise ConfigurationError("SWIPE_HTTP_TIMEOUT must be greater than zero.")

        return cls(
            mode=mode,  # type: ignore[arg-type]
            backend_url=backend_url.rstrip("/"),
            api_token=token,
            company_state=normalize_state(os.getenv("SWIPE_COMPANY_STATE", "")),
            timeout=timeout,
        )

    @property
    def base_url(self) -> str:
        return LIVE_API_BASE if self.mode == "live" else self.backend_url

    @property
    def authorization_token(self) -> str:
        return self.api_token if self.mode == "live" else "demo"

    def require_company_state(self) -> str:
        if not self.company_state:
            raise ConfigurationError(
                "SWIPE_COMPANY_STATE is required for live invoice creation so "
                "CGST/SGST versus IGST can be computed safely."
            )
        return self.company_state


def normalize_state(value: str | None) -> str:
    text = str(value or "").strip().upper()
    if "-" in text and text.split("-", 1)[0].strip().isdigit():
        text = text.split("-", 1)[1].strip()
    return " ".join(text.split())
