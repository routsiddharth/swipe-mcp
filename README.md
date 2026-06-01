# Swipe Partner API — Mock Backend

An offline, fully-runnable **FastAPI** mock of [Swipe's](https://getswipe.in)
Partner API (v2), built entirely against the public OpenAPI spec
([`spec/partner.yaml`](spec/partner.yaml)). It lets the frontend / MCP server be
developed and demoed **without a live Swipe account or API key** — request and
response shapes match the spec, and the GST line-item math is computed for real.

> Status: built-to-spec. **Nothing here has been validated against the live
> Swipe API yet** (I don't have a key). Response shapes mirror the spec; the
> GST math is verified against the spec's own worked examples (see tests).

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
confirm for writes) drives this backend's API for real. It runs in the browser
with no build step — start this backend, then serve `frontend/` over HTTP and
open it. See [`frontend/README.md`](frontend/README.md). CORS is enabled here so
the browser can call the API directly (configurable via `MOCK_CORS_ORIGINS`).

## Going live later

Auth and config are env-driven, so the same code can point at the real API:

| Variable | Default | Meaning |
|----------|---------|---------|
| `MOCK_REQUIRE_AUTH` | `true` | Enforce the `Authorization: Bearer` header |
| `MOCK_API_TOKEN` | _(empty)_ | If set, only this token is accepted; empty = accept any |
| `MOCK_HOST` / `MOCK_PORT` | `127.0.0.1` / `8000` | Bind address |
| `MOCK_CORS_ORIGINS` | `*` | Comma-separated allowed browser origins |

> ⚠️ The defaults are tuned for a zero-setup local demo: CORS is open (`*`) and
> any non-empty token is accepted. If you deploy this mock anywhere public, set
> `MOCK_CORS_ORIGINS` to your frontend's origin and `MOCK_API_TOKEN` to a real
> token — otherwise the mock is world-writable.

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
