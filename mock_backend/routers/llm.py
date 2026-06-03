"""Server-side proxy for the LLM agent (OpenRouter).

The agent's OpenRouter key lives ONLY on the server — read from the environment
(``OPENROUTER_API_KEY``), falling back to the repo-root ``.env`` so local dev
needs no extra setup. It is injected here and never ships to the browser, so a
viewer of the static frontend cannot read it (the whole point of moving the LLM
server-side; see DEPLOYMENT.md §3).

These routes are mounted OUTSIDE the bearer-auth routers (like ``/health``):
the frontend calls them without a token, and — critically — in live mode must
never send the real Swipe key to this origin. For a public deploy, rate-limit
``/llm`` at the edge so the proxy can't be used to burn your OpenRouter credits.
"""
from __future__ import annotations

import os
from pathlib import Path

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter(tags=["LLM"])

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
# repo root: mock_backend/routers/llm.py -> mock_backend -> <root>
_ROOT = Path(__file__).resolve().parent.parent.parent


def _from_env(name: str) -> str:
    """Env var, falling back to a repo-root ``.env`` entry.

    Mirrors ``scripts/gen_frontend_config.py`` so a key kept in the local
    ``.env`` keeps working with no extra wiring. In a container the ``.env``
    won't exist and the value comes purely from the environment (e.g. a
    ``fly secrets``-injected var).
    """
    val = os.getenv(name, "").strip()
    if val:
        return val
    env = _ROOT / ".env"
    if env.is_file():
        for line in env.read_text().splitlines():
            if line.strip().startswith(name + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def _model() -> str:
    return _from_env("OPENROUTER_MODEL") or "openai/gpt-4o-mini"


@router.get("/llm/status")
async def llm_status() -> dict:
    """Tell the frontend whether the server-side agent is available.

    The frontend probes this at boot to decide between the LLM planner and the
    deterministic regex fallback — without ever holding the key itself.
    """
    return {"enabled": bool(_from_env("OPENROUTER_API_KEY")), "model": _model()}


@router.post("/llm")
async def llm_proxy(request: Request) -> JSONResponse:
    """Forward a chat-completions request to OpenRouter with the server-held key.

    The request/response bodies are OpenRouter's own shape — we pass them
    through verbatim (the frontend already parses both the success message and
    the ``error.message`` error shape), only swapping in the Authorization
    header so the key never reaches the browser.
    """
    key = _from_env("OPENROUTER_API_KEY")
    if not key:
        return JSONResponse(
            status_code=503,
            content={"error": {"message": "LLM is not configured on the server."}},
        )
    try:
        body = await request.json()
    except ValueError:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "Request body must be JSON."}},
        )
    headers = {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "X-Title": "Swipe Agent",
    }
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(OPENROUTER_URL, json=body, headers=headers)
    except httpx.HTTPError as exc:
        return JSONResponse(
            status_code=502,
            content={"error": {"message": "Upstream LLM request failed: " + str(exc)}},
        )
    try:
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    except ValueError:
        return JSONResponse(
            status_code=502,
            content={"error": {"message": "Invalid response from the LLM provider."}},
        )
