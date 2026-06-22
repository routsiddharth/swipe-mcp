# Swipe Partner API — MCP server + conversational agent

Drive [Swipe](https://getswipe.in) (Indian GST billing software) in **plain
English**. This repo is two things that share one engine:

1. **An MCP server** (`swipe_mcp/`) — a real stdio [Model Context
   Protocol](https://modelcontextprotocol.io) server that exposes Swipe's
   Partner API v2 as **nine typed tools**. Point Claude Desktop, Claude Code,
   Cursor, or any MCP host at it and the model can look up customers, compose
   GST-correct invoices, record payments, read ledgers, and **reconcile a bank
   statement against outstanding invoices** — all through tool calls.
2. **A conversational web frontend** (`frontend/`) — a one-input browser surface
   where you type intent (`"invoice Acme ₹50k for consulting, 18% GST, due in 15
   days"`), an LLM composes the action, shows the GST breakdown, and on confirm
   writes it for real. It demonstrates the same thesis without an MCP host.

Both run **key-free against a bundled FastAPI mock** in ~30 seconds, and both
run against a **real Swipe account** when you supply an API key. The hard,
correctness-critical parts — the GST line-item math and the `SwipeError`
contract — live in a single pure package (`swipe_core/`) that both halves
depend on.

> **Live validation.** The MCP server's live path was exercised against a real
> Swipe account on **June 21, 2026**: customer/product reads, invoice
> create/get/list, GST totals, a cash payment, payment-retry deduplication,
> ledger retrieval, GSTIN lookup, and cancellation cleanup all reached the
> production API. The `reconcile` tool is validated offline (pure matcher +
> mock-backend write round-trip), not yet against a live account. The README is
> kept honest about what is live-verified versus built-to-spec.

---

# Part 1 — The MCP server (`swipe_mcp/`)

`python -m swipe_mcp` starts a stdio MCP server (built on the official `mcp`
SDK's `FastMCP`). It is the primary deliverable: a well-described, safe tool
surface an LLM agent can call correctly.

## The nine tools

Each tool has a crisp description and a JSON schema (an agent only calls
correctly if the tool is well described). Read tools run immediately; write
tools are annotated **destructive** so MCP hosts surface an approval prompt.

| Tool | Kind | What it does |
|---|---|---|
| `find_customer` | read | Rank customers by ID / name / company / GSTIN; returns scored matches so the agent can disambiguate before writing. |
| `list_customers` | read | Bounded, paginated customer list. |
| `list_products` | read | Bounded, paginated product & service catalog. |
| `list_invoices` | read | Invoices filtered by status (`all`/`pending`/`paid`/`cancelled`), date range, and customer. Dates accept `YYYY-MM-DD` or `DD-MM-YYYY`. |
| `customer_outstanding` | read | Resolve a customer and return their outstanding balance + ledger. |
| `lookup_gstin` | read | Validate a 15-char GSTIN and look it up against the Swipe portal. |
| `create_invoice` | **write** | Resolve the customer, compute GST line-item math, write the invoice, and read it back. |
| `record_payment` | **write** | Resolve an invoice by hash ID **or** serial number, then record a payment against it. |
| `reconcile` | **write** | Match parsed bank-statement credits to outstanding invoices and (on confirm) record the payments. See [the flagship feature](#the-flagship-reconcile). |

The three writes carry the engineering substance:

**`create_invoice`** — You pass the minimal inputs (`items` with quantity / unit
price / tax rate, and a `customer_id` or `customer_name`); the server resolves
the customer against the live/mock catalog, runs the [GST
engine](#the-gst-engine-swipe_coregstpy), assembles the exact v2 request body
(including the live API's `serial_number_v2` and address placeholders), POSTs
it, and fetches the created document back so the agent sees the API's own
authoritative totals. A `preview` (per-line net/tax/total, CGST/SGST-vs-IGST,
grand total, due date) is returned alongside.

**`record_payment`** — Accepts a hash ID, an exact serial number, or resolves
the latest invoice; guards against overpayment (`amount > amount_pending` is
rejected, not forced through); and shapes the correct live/mock payment body.
Live non-cash payments require real `bank_details` — the server never invents an
account number.

**Idempotency on writes.** Every retriable write accepts a stable
`idempotency_key`. The server dedupes in two layers: an in-process cache keyed by
`(mode, namespace, key)` guarded by a per-key lock, **and** a deterministic
`serial_number` (invoices) / notes marker (payments) so that even a fresh
process re-running the same statement reuses the existing record instead of
double-creating. A POST that wins the race but fails verification still returns
its identifiers rather than inviting a dangerous retry.

**Error mapping.** Swipe error codes (`DUPLICATE_DOC_SERIAL_NUMBER`,
`AMOUNT_RECEIVED_GREATER_THAN_TOTAL_AMOUNT`, `INVALID_TAX_RATE`,
`CUSTOMER_NOT_FOUND`, …) are caught and turned into friendly `ToolError`
messages the model can act on.

## The flagship: `reconcile`

The one demo that is **structurally impossible inside a walled in-app
assistant**: an agent reads your **bank statement**, matches the incoming
credits against your outstanding Swipe invoices, and flips them from *pending*
to *paid*. A billing tool's own assistant cannot see your bank file; an MCP tool
in your agent workspace can.

The host (e.g. Claude Desktop) parses the statement into credit rows — the Swipe
MCP's job starts at *"here are the credits."* The matcher
(`swipe_mcp/reconcile.py`) is a **pure, unit-tested function** that scores each
credit against each outstanding invoice on amount, payee name (fuzzy, tolerant
of `Pvt Ltd`/`LLP` suffixes and garbled UPI/IMPS strings), and an invoice serial
embedded in the narration, then classifies it:

| Outcome | Meaning | Action |
|---|---|---|
| **confident** | amount + payee/ref agree | book it |
| **review** | near-amount, overpayment, or 2+ candidates | ask the user |
| **split** | one credit clears several invoices | book multiple payments |
| **none** | refund / salary / transfer / unknown payee | **leave it alone** |

`dry_run=True` (the default) returns the proposed match table and **writes
nothing**; after the user confirms, `dry_run=False` records the confident/split
matches through the same idempotent `record_payment` path. Correctly **not**
booking a refund or salary deposit is as much the point as booking the real
ones. Full write-up and demo script: [`DETAILS.md`](DETAILS.md).

## Mock vs. live

A single toggle selects the backend; the **same nine tools** work in both modes.

- **`SwipeConfig.from_env()` defaults to live whenever an API key is present**
  (`SWIPE_API_TOKEN` or `SWIPE_API_KEY`, read from the environment or the
  repo-root `.env`), so the server is wired to your real account out of the box.
- Set **`SWIPE_MODE=mock`** explicitly to force the key-free local FastAPI mock.
- Live mode always targets the fixed host `https://app.getswipe.in/api/partner`;
  the mock URL is ignored and can never receive the live key.

| Variable | Default | Notes |
|---|---|---|
| `SWIPE_MODE` | inferred | `live` if a key is present, else `mock`; set explicitly to override |
| `SWIPE_API_TOKEN` | _(empty)_ | Live Partner API key (`SWIPE_API_KEY` is an accepted alias) |
| `SWIPE_BACKEND_URL` | `http://127.0.0.1:8000` | Mock mode only |
| `SWIPE_COMPANY_STATE` | _(empty)_ | Your registered seller state — **required for live invoice creation** (drives CGST/SGST vs IGST; Partner API v2 exposes no company endpoint, so it can't be auto-detected) |
| `SWIPE_HTTP_TIMEOUT` | `20` | Request timeout (seconds) |

## Quick start

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

**Against the local mock (no key):**

```bash
python -m uvicorn mock_backend.main:app        # terminal 1
SWIPE_MODE=mock python -m swipe_mcp            # terminal 2
```

**Against the real Swipe API:**

```bash
SWIPE_MODE=live \
SWIPE_API_KEY=your-key \
SWIPE_COMPANY_STATE=TELANGANA \
python -m swipe_mcp
```

## Wire it into an MCP host

**Claude Code** — a project-scoped [`.mcp.json`](.mcp.json) already registers the
server, so running `claude` in this directory exposes the Swipe tools.

**Claude Desktop** — add to
`~/Library/Application Support/Claude/claude_desktop_config.json`:

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

The key is read from `.env` by absolute path, so it never lives in this JSON.
Restart Claude Desktop fully (quit, not just close the window). For mock mode,
add `"SWIPE_MODE": "mock"` and start `uvicorn mock_backend.main:app` first. See
[`swipe_mcp/README.md`](swipe_mcp/README.md) for the full tool contracts and
[`DEPLOYMENT.md`](DEPLOYMENT.md) for hosted-mock and live runtime modes.

## Production smoke test

```bash
SWIPE_COMPANY_STATE=TELANGANA python scripts/live_mcp_smoke.py
```

Creates a ₹1 invoice with 18% GST, records a ₹0.01 cash payment, verifies retry
deduplication and the ledger, then cancels the document. It consumes API quota
and leaves a cancelled document in history — never run it in CI. Normal unit
tests never touch a live account.

---

# Part 2 — The conversational web frontend (`frontend/`)

**The thesis: you talk to your billing software in plain English and an agent
drives it correctly.** Not a CRUD app — there are no customer pages, invoice
forms, or settings screens. There is **one input**.

```
"invoice Acme ₹50,000 for consulting, 18% GST, due in 15 days"
   → agent resolves the customer
   → computes per-line GST (net / tax / total, CGST+SGST vs IGST, grand total)
   → shows the composed invoice
   → on confirm, creates it for real and renders the result card
```

It's a thin surface: React + Babel loaded straight in the browser, **no build
step**. The heavy lifting (persistence, authoritative GST, valid API calls)
lives in the backend.

## The interaction model

1. **Intent in.** You type natural language, including multi-turn follow-ups
   (`"actually make it 28% GST"`, `"add 10 safety gloves"`).
2. **Show the work.** Before doing anything, the agent renders *what it
   understood and what it will do* — most importantly the composed invoice with
   the GST breakdown. This visible correctness is the proof.
3. **Confirm on writes.** Anything that creates or changes data (invoice,
   payment) shows a preview and requires an explicit confirm. Never a silent
   write. The agent's chosen tool + arguments stream as a legible **tool-call
   trace** so you watch the machine think.
4. **Execute & render.** After confirm, the result is shown as a consequence of
   the tool call — an invoice card with serial number, totals, and payment
   status — not a hand-built form.
5. **Reads run immediately**, no confirm (`"show me unpaid invoices this
   quarter"`, `"what does Globex owe me?"`, `"look up GSTIN 29AAAC…"`).

## What's real vs. illustrative

- **Real:** every data operation hits a real REST API over HTTP and persists —
  `POST /v2/doc`, `POST /v2/payment`, `GET /v2/doc/list`,
  `GET /v2/customer/ledger`, `GET /v2/utils/gstin/{gstin}`. In **mock** mode
  that's the local FastAPI backend; in **live** mode it's your Swipe account at
  `app.getswipe.in` (which sends permissive CORS, so the browser calls it
  directly — no proxy). The engine adapts request/response shapes per mode. The
  final invoice card is rendered from the **API's own computed totals**, fetched
  back via `GET /v2/doc/{hash_id}`.
- **Real agent (LLM):** when an OpenRouter key is configured on the backend, an
  LLM (`openai/gpt-4o-mini` by default) is the brain. It reads your message plus
  the live customer/product catalog and emits a single tool call
  (`create_invoice`, `record_payment`, `list_invoices`, `customer_outstanding`,
  `lookup_gstin`, `list_customers`, `list_products`, or a plain reply). This
  handles open-ended phrasing, multi-item invoices, and follow-ups. **The key
  never reaches the browser** — the frontend routes planning through the
  backend's `/llm` proxy and discovers availability via `/llm/status`. Without a
  key it falls back to a deterministic regex intent matcher, so the demo still
  runs offline.
- **Illustrative:** the streamed "MCP tool call" trace is a faithful
  visualisation of the agent's chosen tool + arguments, but for zero-friction
  demoing the frontend calls the REST API directly rather than spawning the
  stdio MCP process. The pre-confirm GST breakdown is an **instant client-side
  preview** (`frontend/engine.js`) mirroring the canonical math; the API
  recomputes it authoritatively on create. That JS mirror is pinned to the
  Python engine by a cross-language contract test
  ([`tests/test_gst_contract.py`](tests/test_gst_contract.py)) so it can't
  silently drift.

Nothing is faked: if the backend is unreachable, the app shows a "Backend
offline" banner rather than inventing data.

## Run it (~30 seconds)

```bash
python -m uvicorn mock_backend.main:app        # http://127.0.0.1:8000
cd frontend && python3 -m http.server 5500     # open http://127.0.0.1:5500/
```

(`file://` won't work — the browser blocks cross-origin `fetch` from a file
origin.) Click **Auto-demo** to watch the golden path run itself, or type an
example prompt.

## Mock vs. live, and graceful degradation

Switch modes from the in-app **Connection** panel (the gear icon). You enter
your Swipe API key there; the browser validates it directly against Swipe and
stores it in that device's `localStorage` — it is **never** generated into
deployment files. A clean browser starts in key-free mock mode.

The free Partner API has a small daily quota. When live calls start returning
`API Limit Reached`, the frontend **degrades reads to the local mock** (with a
"Daily limit reached" tag) and re-probes the real API on each message. **Writes
are never silently redirected** — a create/payment that hits the limit
re-arms the confirm so you knowingly re-confirm against sample data rather than
believing a mock record landed on your real account.

Non-secret deployment defaults (mock base URL, seller state) can live in a
git-ignored `frontend/config.js`; **secrets never go there** (it's served to the
browser). Generate it with `python scripts/gen_frontend_config.py`. Full
connection/deployment flow: [`frontend/README.md`](frontend/README.md).

---

# The shared core

## The GST engine (`swipe_core/gst.py`)

The real Swipe API computes invoice amounts server-side. The hard part of the
create-document endpoint is the GST line-item math, so this project computes it
for real — and keeps it in **one pure, dependency-free module** that the mock
backend, the MCP server, and (mirrored in JS) the frontend all agree on:

```
discount       = discount_amount, OR (quantity × unit_price) × discount_percent/100
net_amount     = quantity × unit_price − discount
tax_amount     = net_amount × (tax_rate + cess_rate) / 100   # tax on POST-discount net
total_amount   = net_amount + tax_amount
price_with_tax = unit_price × (1 + (tax_rate + cess_rate)/100)
```

It splits tax into **CGST/SGST** (intra-state) vs **IGST** (inter-state) from
the party's state vs the company's state, validates GST slabs, and handles
doc-level `extra_discount`, `round_off`, and `charges_and_deductions`. It's
verified against the spec's worked examples in
[`tests/test_gst.py`](tests/test_gst.py).

> `swipe_core/` is the framework-free heart shared by both halves: `gst.py` (the
> math) and `errors.py` (the `SwipeError` contract). The MCP server depends on it
> directly and **does not import the mock backend at all** — the mock is a peer
> that depends on the same core, not a dependency of the production wrapper.

## The mock backend (`mock_backend/`)

An offline, spec-faithful FastAPI mock of Partner API v2, built from
[`spec/partner.yaml`](spec/partner.yaml). It backs **mock mode** for both the
MCP server and the frontend, so the whole project is demoable from a clean
checkout with no key. Request/response *shapes* mirror the spec; the GST math is
real (via `swipe_core`). Layering: thin routers → `service.py` (business logic,
shared with the seeder) → `store.py` (in-memory) → `swipe_core.gst`.

Endpoints mirror the real base path (`…/api/partner` → here `http://127.0.0.1:8000`):

| Area | Endpoints |
|------|-----------|
| Documents | `POST /v2/doc`, `GET /v2/doc/list`, `GET/PUT/DELETE /v2/doc/{id}`, `GET /v2/doc/pdf/{id}` |
| Customers | `POST/PUT /v2/customer`, `GET/DELETE /v2/customer/{id}`, `GET /v2/customer/list`, `GET /v2/customer/ledger` |
| Vendors | `POST /v2/vendor`, `GET/DELETE /v2/vendor/{id}`, `GET /v2/vendor/list`, `GET /v2/vendor/ledger` |
| Products | `POST/PUT /v2/product`, `GET/DELETE /v2/product/{id}`, `GET /v2/product/list` |
| Payments | `POST /v2/payment`, `GET /v2/payment/list` |
| Utility | `GET /v2/utils/gstin/{gstin}` |
| Inventory | `POST /v2/inventory/stock`, `GET /v2/inventory/warehouses/list` |
| Subscriptions | `GET /v2/subscriptions/list`, `GET /v2/subscriptions/{id}` |
| Mock-only | `GET /health`, `POST /v2/_mock/reset` |

On startup (and on `POST /v2/_mock/reset`) the store is seeded with 5 customers,
3 vendors, 8 products, and several documents spanning invoice / estimate /
purchase, paid / pending / cancelled, intra- and inter-state GST, an export +
e-invoice, and a subscription — enough to exercise every endpoint and the common
filters. Auth is **off by default** (all data is fake and resettable);
`MOCK_REQUIRE_AUTH=true` + optional `MOCK_API_TOKEN` mirror production auth.

> ⚠️ The mock's defaults suit a zero-setup local demo: CORS open (`*`), auth off.
> If you deploy the *mock* publicly, set `MOCK_CORS_ORIGINS`,
> `MOCK_REQUIRE_AUTH=true`, and `MOCK_API_TOKEN` — otherwise it's world-writable.

| Mock variable | Default | Meaning |
|---|---|---|
| `MOCK_REQUIRE_AUTH` | `false` | Enforce `Authorization: Bearer` |
| `MOCK_API_TOKEN` | _(empty)_ | If set, only this token is accepted; empty = accept any |
| `MOCK_HOST` / `MOCK_PORT` | `127.0.0.1` / `8000` | Bind address |
| `MOCK_CORS_ORIGINS` | `*` | Comma-separated allowed origins |

---

## Seeding a live account

So the agent's prompts resolve against real data (`CUST001`, `ITEM005`, …):

```bash
SWIPE_API_KEY=...  python scripts/seed_live.py          # customers + products
SWIPE_API_KEY=...  python scripts/seed_live.py --all    # + a few sample invoices
```

The sample-invoice amounts are computed through the same `swipe_core.gst` engine,
so seeded data can't drift from the live math.

## Tests

```bash
python -m pytest -q
```

- `tests/test_gst.py` pins the GST math to the spec's worked examples.
- `tests/test_gst_contract.py` is a **cross-language contract test** — it feeds
  identical fixtures to the Python engine and the frontend's JS mirror (run under
  Node) and asserts they agree, so the preview can't drift from the source of
  truth.
- `tests/test_api.py` runs end-to-end mock-backend flows via FastAPI's TestClient.
- The `tests/test_mcp_*.py` suite covers live/mock response adaptation, GST
  request mapping, idempotent create/payment, the pure reconciliation matcher,
  and stdio tool discovery.

All deterministic — no live account or network required.

## Repository layout

```
swipe_core/        pure, dependency-free shared core
  gst.py             GST line-item + document math (the centerpiece, unit-tested)
  errors.py          the SwipeError contract (re-exported by mock_backend)

swipe_mcp/         the MCP server (the deliverable)
  server.py          FastMCP: the nine tool definitions + annotations
  service.py         business logic: resolution, idempotency, orchestration
  client.py          async HTTP adapter for the live/mock Partner API
  mapping.py         normalize records + build GST-complete request bodies
  reconcile.py       pure bank-statement → invoice matching engine
  models.py          typed tool inputs (JSON schemas)
  config.py          mode/key/env resolution

mock_backend/      offline FastAPI mock of Partner API v2 (backs mock mode)
  main.py · service.py · store.py · seed.py · schemas.py · routers/ · …

frontend/          conversational web surface (React + Babel, no build step)
  engine.js          NLU + GST preview + the backend HTTP client
  app.jsx · chat.jsx · cards.jsx · styles.css

spec/partner.yaml  the authoritative OpenAPI spec everything is built from
scripts/           live smoke test, live seeding, config generation
demo/              mock bank statement for the reconcile demo
tests/             gst + contract + api + mcp tests
```

See [`DETAILS.md`](DETAILS.md) (reconcile), [`DEPLOYMENT.md`](DEPLOYMENT.md)
(runtime modes), [`swipe_mcp/README.md`](swipe_mcp/README.md), and
[`frontend/README.md`](frontend/README.md) for depth on each piece.
