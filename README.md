# Swipe MCP Server + Partner API Demo

A real stdio MCP server plus a conversational demo for
[Swipe's](https://getswipe.in) Partner API v2. Claude Desktop, Cursor, and other
MCP hosts can list customers/products/invoices, inspect ledgers and GSTINs, and
create invoices or record payments.

- **MCP server** — [`swipe_mcp/`](swipe_mcp/) exposes eight typed tools over
  stdio, with GST computation, live/mock adapters, error mapping, and retriable
  write idempotency.
- **live mode** — calls `https://app.getswipe.in/api/partner` with the API key
  from the environment or `.env`.
- **mock mode** — calls the included FastAPI backend with resettable fake data.
- **browser demo** — [`frontend/`](frontend/) remains an optional in-app agent
  surface using the same API concepts.

The MCP live path was verified against a real Swipe account on June 21, 2026:
customer/product reads, invoice create/get/list, GST totals, cash payment,
payment retry deduplication, ledger retrieval, GSTIN lookup, and cancellation
cleanup all reached the production API successfully.

## MCP quick start

Install dependencies:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

Run against the local mock:

```bash
uvicorn mock_backend.main:app --reload
# in another terminal
python -m swipe_mcp
```

Run against the real Swipe API:

```bash
SWIPE_MODE=live \
SWIPE_COMPANY_STATE=TELANGANA \
SWIPE_API_KEY=your-key \
python -m swipe_mcp
```

`SWIPE_COMPANY_STATE` must be the seller's registered state; it controls the
CGST/SGST versus IGST preview. `SWIPE_API_TOKEN` is also accepted. A repository
`.env` is loaded automatically.

For a low-value production contract test that cancels its test invoice:

```bash
SWIPE_COMPANY_STATE=TELANGANA python scripts/live_mcp_smoke.py
```

See [`swipe_mcp/README.md`](swipe_mcp/README.md) for Claude Desktop wiring and
the tool contracts, and [`DEPLOYMENT.md`](DEPLOYMENT.md) for runtime modes.

## Mock backend quick start

- Interactive docs: http://127.0.0.1:8000/docs
- Health check (no auth): http://127.0.0.1:8000/health

Mock authentication is off by default because all data is fake and resettable.
Set `MOCK_REQUIRE_AUTH=true` to mirror production authentication; unless
`MOCK_API_TOKEN` is also set, any non-empty bearer token then works:

```bash
curl -s http://127.0.0.1:8000/v2/customer/list \
  -H "Authorization: Bearer any-token-works"
```

## What's implemented

Base path mirrors the real API: `https://app.getswipe.in/api/partner` → here
just `http://127.0.0.1:8000`.

| Area | Endpoints |
|------|-----------|
| Documents | `POST /v2/doc`, `GET /v2/doc/list`, `GET /v2/doc/{id}`, `PUT /v2/doc/{id}`, `DELETE /v2/doc/{id}`, `GET /v2/doc/pdf/{id}` |
| Customers | `POST/PUT /v2/customer`, `GET /v2/customer/{id}`, `DELETE /v2/customer/{id}`, `GET /v2/customer/list`, `GET /v2/customer/ledger` |
| Vendors | `POST /v2/vendor`, `GET /v2/vendor/{id}`, `DELETE /v2/vendor/{id}`, `GET /v2/vendor/list`, `GET /v2/vendor/ledger` |
| Products | `POST/PUT /v2/product`, `GET /v2/product/{id}`, `DELETE /v2/product/{id}`, `GET /v2/product/list` |
| Payments | `POST /v2/payment`, `GET /v2/payment/list` |
| Utility | `GET /v2/utils/gstin/{gstin}` |
| Inventory | `POST /v2/inventory/stock`, `GET /v2/inventory/warehouses/list` |
| Subscriptions | `GET /v2/subscriptions/list`, `GET /v2/subscriptions/{id}` |
| Mock-only | `GET /health`, `POST /v2/_mock/reset` |

## The GST engine ([`mock_backend/gst.py`](mock_backend/gst.py))

The real Swipe API computes invoice amounts server-side. The hard part of the
create-document endpoint is the GST line-item math, so this mock computes it for
real (you send the minimal inputs; it derives the rest):

```
discount       = discount_amount, OR (quantity × unit_price) × discount_percent/100
net_amount     = quantity × unit_price − discount
tax_amount     = net_amount × (tax_rate + cess_rate) / 100   # tax on POST-discount net
total_amount   = net_amount + tax_amount
price_with_tax = unit_price × (1 + (tax_rate + cess_rate)/100)
```

It also splits tax into **CGST/SGST** (intra-state) vs **IGST** (inter-state)
based on the party's state vs the company's state, and handles doc-level
`extra_discount`, `round_off`, and `charges_and_deductions`. Verified against the
spec's worked examples in `tests/test_gst.py`.

## Example: create an invoice

```bash
curl -s http://127.0.0.1:8000/v2/doc \
  -H "Authorization: Bearer demo" -H "Content-Type: application/json" \
  -d '{
    "document_type": "invoice",
    "document_date": "01-06-2026",
    "due_date": "16-06-2026",
    "party": {"id": "CUST002", "type": "customer", "name": "Globex Corporation",
              "billing_address": {"state": "KARNATAKA"}},
    "items": [
      {"id": "ITEM005", "name": "Consulting", "item_type": "Service",
       "quantity": 20, "unit_price": 2500, "tax_rate": 18}
    ],
    "payments": [{"amount": 30000, "method": "upi"}]
  }'
# -> { "success": true, "data": { "hash_id": "SL...", "serial_number": "INV-..." } }
```

## Seed data

On startup (and on `POST /v2/_mock/reset`) the store is seeded with 5 customers,
3 vendors, 8 products, and several documents spanning invoice / estimate /
purchase types, paid / pending / cancelled statuses, intra- and inter-state GST,
an export + e-invoice, and a subscription — enough to exercise every endpoint and
the common list filters. State is in-memory (see `mock_backend/store.py`); swap
that one layer for SQLite/Postgres later without touching the routers.

## Tests

```bash
python -m pytest -q
```

`tests/test_gst.py` pins the GST math to the spec examples; `tests/test_api.py`
runs end-to-end endpoint flows via FastAPI's TestClient. The MCP tests cover
live/mock response adaptation, GST request mapping, idempotent create/payment,
and stdio tool discovery. Normal tests use no live account or network.

## Conversational frontend

[`frontend/`](frontend/) is a one-surface demo UI: you talk to Swipe in plain
English and an agent composes the action, shows the GST breakdown, and (on
confirm for writes) drives the API for real. It runs in the browser with no build
step and works against **either mode** — in mock mode it talks to the local
FastAPI backend; in live mode it calls `app.getswipe.in` directly with your key.
Start the backend (mock), then serve `frontend/` over HTTP and open it. See
[`frontend/README.md`](frontend/README.md). The mock enables CORS so the browser
can call it directly (configurable via `MOCK_CORS_ORIGINS`).

## Going live (the real Swipe API)

The frontend talks to the **real Partner API directly** in live mode — the Swipe
API sends permissive CORS headers, so the browser can call `app.getswipe.in`
without any proxy or backend in the loop. Switch via the in-app **Connection**
panel. The key is validated against Swipe and stored only in that browser's
localStorage; it is never generated into public deployment files.

`frontend/config.js` may contain non-secret defaults such as the mock backend
URL and seller state, but never the Swipe API key.

Seed a live account with the demo's customers/products (and a few sample
invoices) so the agent's prompts resolve against real data:

```bash
SWIPE_API_KEY=...  python scripts/seed_live.py          # customers + products
SWIPE_API_KEY=...  python scripts/seed_live.py --all    # + sample invoices
```

See [`frontend/README.md`](frontend/README.md) for the connection flow.

### Graceful degradation when the live limit is hit

The free Partner API has a small daily quota. When live calls start returning
`API Limit Reached`, the frontend **degrades to the mock**: reads transparently
switch to mock data, a small **"Daily limit reached"** tag appears in the header,
and each new message silently re-probes the real API — when it resets, a prompt
offers to start a fresh chat on the live account or stay on the mock. **Writes
are not silently redirected:** a create/payment that hits the limit surfaces the
limit and re-arms the confirm, so you knowingly re-confirm it against the mock
(sample data) rather than believing a mock record landed on your real account.

> ⚠️ Degradation targets the **local** mock (`http://127.0.0.1:8000`). It's meant
> for local runs (mock + frontend on the same machine). On a hosted HTTPS deploy
> with no mock running, a live-limit lapse can't fall back (localhost is
> unreachable / mixed-content) — it shows the offline state instead. Host the
> mock alongside the static site if you want degradation in production.

### Mock-server env vars (for the offline mock)

| Variable | Default | Meaning |
|----------|---------|---------|
| `MOCK_REQUIRE_AUTH` | `false` | Enforce the `Authorization: Bearer` header |
| `MOCK_API_TOKEN` | _(empty)_ | If set, only this token is accepted; empty = accept any |
| `MOCK_HOST` / `MOCK_PORT` | `127.0.0.1` / `8000` | Bind address |
| `MOCK_CORS_ORIGINS` | `*` | Comma-separated allowed browser origins |

> ⚠️ The mock's defaults are tuned for a zero-setup local demo: CORS is open
> (`*`) and auth is disabled. If you deploy the *mock* anywhere public, set
> `MOCK_CORS_ORIGINS`, `MOCK_REQUIRE_AUTH=true`, and `MOCK_API_TOKEN` —
> otherwise it's world-writable.

## Layout

```
mock_backend/
  main.py        FastAPI app, error handlers, auth wiring, mock helpers
  gst.py         GST line-item + document math (the core, unit-tested)
  service.py     document/payment/ledger business logic (shared w/ seeder)
  store.py       in-memory data store + reset
  seed.py        seed data
  schemas.py     Pydantic request models (spec-faithful validation)
  auth.py        bearer-token dependency
  errors.py      Swipe-style error envelope + SwipeError
  pdf.py         minimal valid PDF generator for /v2/doc/pdf
  routers/       parties, products, documents, payments, misc
spec/partner.yaml  the authoritative OpenAPI spec this is built from
tests/             gst + api tests
```
