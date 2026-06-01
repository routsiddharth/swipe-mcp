# Swipe Partner API — Agent + Mock Backend

A conversational agent for [Swipe's](https://getswipe.in) Partner API (v2) that
runs in **two modes from one codebase**:

- **live** — drives a **real Swipe account** against the production Partner API
  (`https://app.getswipe.in/api/partner`) with your API key.
- **mock** — an offline, fully-runnable **FastAPI** mock built entirely against
  the public OpenAPI spec ([`spec/partner.yaml`](spec/partner.yaml)), so the
  frontend / MCP server can be developed and demoed **with no Swipe account or
  key**. Request/response shapes match the spec; the GST math is computed for real.

Mock is the zero-setup default; supply a key and flip a single toggle to point
the same agent and UI at the live API (see [Going live](#going-live-the-real-swipe-api)).

> Status: the mock is built-to-spec; the GST math is verified against the spec's
> own worked examples (see tests). The conversational frontend can also drive the
> **real Swipe Partner API directly** (live mode) — the create-invoice, record-
> payment, list, and ledger flows have been validated against a live account, and
> the engine adapts to the several places where the live shapes differ from the
> spec/mock (see `frontend/engine.js`). Live GST requires the Swipe account to
> have its GSTIN configured, otherwise Swipe zeroes the tax. The free key has a
> small daily quota; once spent, the app degrades to the mock for reads (see
> [Graceful degradation](#graceful-degradation-when-the-live-limit-is-hit)).

## Quick start (~30 seconds)

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn mock_backend.main:app --reload
```

- Interactive docs: http://127.0.0.1:8000/docs
- Health check (no auth): http://127.0.0.1:8000/health

Every `/v2/...` endpoint requires a bearer token, exactly like production. In
mock mode **any non-empty token works**:

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
pytest -q
```

`tests/test_gst.py` pins the GST math to the spec examples; `tests/test_api.py`
runs end-to-end endpoint flows via FastAPI's TestClient (no network, no key).

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
panel, or set a deployment default with a git-ignored `frontend/config.js`
(generated from an env var) so the hosted app always uses your key:

```bash
SWIPE_API_KEY=...  python scripts/gen_frontend_config.py   # writes frontend/config.js
```

Seed a live account with the demo's customers/products (and a few sample
invoices) so the agent's prompts resolve against real data:

```bash
SWIPE_API_KEY=...  python scripts/seed_live.py          # customers + products
SWIPE_API_KEY=...  python scripts/seed_live.py --all    # + sample invoices
```

See [`frontend/README.md`](frontend/README.md) for the full config precedence.
The key is read from env / a git-ignored `.env`; it is never committed.

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
| `MOCK_REQUIRE_AUTH` | `true` | Enforce the `Authorization: Bearer` header |
| `MOCK_API_TOKEN` | _(empty)_ | If set, only this token is accepted; empty = accept any |
| `MOCK_HOST` / `MOCK_PORT` | `127.0.0.1` / `8000` | Bind address |
| `MOCK_CORS_ORIGINS` | `*` | Comma-separated allowed browser origins |

> ⚠️ The mock's defaults are tuned for a zero-setup local demo: CORS is open
> (`*`) and any non-empty token is accepted. If you deploy the *mock* anywhere
> public, set `MOCK_CORS_ORIGINS` and `MOCK_API_TOKEN` — otherwise it's
> world-writable.

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
