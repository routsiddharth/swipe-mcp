# Deployment and runtime modes

The MCP server uses stdio. It normally runs on the same machine as the MCP host;
the HTTP component it calls may be local mock, hosted mock, or Swipe production.

## Default: live, keyed from `.env`

`SwipeConfig.from_env()` loads the repository-root `.env` by absolute path (so it
is found regardless of the host's working directory) and **defaults to live mode
whenever a key is present** (`SWIPE_API_TOKEN` or `SWIPE_API_KEY`). The repo
`.env` should contain:

```
SWIPE_API_TOKEN=...        # your Partner API key (never committed; .env is gitignored)
SWIPE_MODE=live            # optional; live is already the default when a token exists
SWIPE_COMPANY_STATE=TELANGANA   # your registered company state (for CGST/SGST vs IGST)
```

Set `SWIPE_MODE=mock` explicitly to force the key-free local backend instead.

`SWIPE_COMPANY_STATE` must be your own registered company state name — it drives
the CGST/SGST-versus-IGST decision on invoice creation. Read-only tools and
payments do not need it. The Partner API v2 exposes no company-profile endpoint,
so it cannot be auto-detected; set it explicitly.

## Connect to Claude Desktop

Add an `mcpServers` entry to
`~/Library/Application Support/Claude/claude_desktop_config.json` (already done on
this machine):

```json
{
  "mcpServers": {
    "swipe": {
      "command": "/opt/miniconda3/bin/python",
      "args": ["-m", "swipe_mcp"],
      "env": { "PYTHONPATH": "/Users/siddharthrout/Desktop/Projects/swipe" }
    }
  }
}
```

`PYTHONPATH` lets `python -m swipe_mcp` import both `swipe_mcp` and the shared
`mock_backend.gst` engine no matter where Claude Desktop launches it. The key is
read from `.env` by absolute path, so it never has to live in this JSON. Restart
Claude Desktop fully (quit, not just close the window) to pick up the change.

## Connect to Claude Code

A project-scoped `.mcp.json` at the repo root registers the same server, so
running `claude` inside this directory exposes the eight Swipe tools.

## Local mock

```bash
python -m uvicorn mock_backend.main:app
SWIPE_MODE=mock python -m swipe_mcp
```

Mock mode must be requested explicitly now that a key is present in `.env`
(otherwise the server defaults to live). It then uses:

- `SWIPE_BACKEND_URL=http://127.0.0.1:8000`

## Hosted mock

Point the stdio server at the deployed mock:

```bash
SWIPE_MODE=mock \
SWIPE_BACKEND_URL=https://swipe-mcp-mock.fly.dev \
python -m swipe_mcp
```

If hosted mock authentication is enabled, the MCP server currently sends the
non-secret token `demo`. Configure the deployment accordingly or use the local
auth-off default. The hosted mock contains fake, resettable data only.

## Live Swipe

```bash
SWIPE_MODE=live \
SWIPE_API_KEY=... \
SWIPE_COMPANY_STATE=TELANGANA \
python -m swipe_mcp
```

Live mode always targets `https://app.getswipe.in/api/partner`. The mock URL is
ignored and never receives the live key.

The company state is mandatory for invoice creation because Swipe exposes no
company-profile endpoint in Partner API v2. Read-only tools can run without it.
Set the exact registered state name.

## Validation

Local deterministic suite:

```bash
python -m pytest -q
```

Production contract smoke (creates, pays ₹0.01, then cancels a test invoice):

```bash
SWIPE_COMPANY_STATE=TELANGANA python scripts/live_mcp_smoke.py
```

The production script consumes API quota and leaves a cancelled document plus
its test payment in account history. Do not run it in CI.
