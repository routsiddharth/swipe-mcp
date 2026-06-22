# Swipe Agent — conversational frontend

A single conversational surface for Swipe: you type plain English, an agent
composes the action (resolving the customer, doing the GST line-item math),
shows you the work, and — on confirm for writes — drives the **mock backend**'s
REST API for real. No CRUD screens, no forms; one input.

It's a thin web surface built with React + Babel loaded straight in the browser
(no build step). The heavy lifting (persistence, authoritative GST math, valid
API calls) lives in the backend.

## What's real vs. illustrative

- **Real:** every data operation hits a real REST API over HTTP and persists —
  create invoice (`POST /v2/doc`), record payment (`POST /v2/payment`), list
  (`GET /v2/doc/list`), ledger (`GET /v2/customer/ledger`), GSTIN lookup
  (`GET /v2/utils/gstin/{gstin}`). In **mock** mode that's the local FastAPI
  mock; in **live** mode it's your actual Swipe account at `app.getswipe.in`.
  The engine adapts the request/response shapes per mode (they differ in
  several places — see comments in `engine.js`). Reference data (customers,
  products) loads at startup; the **final invoice card is rendered from the
  API's own computed totals**, fetched back via `GET /v2/doc/{hash_id}`.
- **The agent (real LLM):** when an OpenRouter key is configured, an LLM
  (`openai/gpt-4o-mini` by default) is the brain — it reads your message plus the
  live customer/product catalog and emits a single **tool call** (create_invoice,
  record_payment, list_invoices, customer_outstanding, lookup_gstin,
  list_customers, list_products, or a plain reply). The engine then previews /
  executes it. This handles open-ended phrasing, multi-item invoices, catalog
  resolution and follow-ups ("make it 28%", "add 10 gloves"). Without a key it
  falls back to a deterministic regex intent matcher, so the demo still runs.
- **Illustrative:** the streamed "MCP tool call" trace is a legible visualisation
  of the agent's chosen tool + arguments (the tools call this backend directly
  rather than through a separate MCP process). The pre-confirm GST breakdown is
  an instant client preview mirroring `swipe_core/gst.py`; the API recomputes
  it authoritatively on create.

Nothing is faked: if the backend is unreachable, the app says so (a "Backend
offline" banner) rather than inventing data.

## Run it (~30 seconds)

From the repo root, start the backend (see the root `README.md`):

```bash
uvicorn mock_backend.main:app          # http://127.0.0.1:8000
```

Then serve this folder over HTTP (any static server; `file://` won't work
because the browser blocks cross-origin `fetch` from a file origin):

```bash
cd frontend
python3 -m http.server 5500            # then open http://127.0.0.1:5500/
```

Click **Auto-demo** to watch the golden path run itself, or type one of the
example prompts.

## Mock vs. live

There are two connection modes, switchable from the **Connection** panel in the
top bar (the gear icon) — or set as the deployment default (see below):

- **Mock** (default) — talks to the local FastAPI mock. Any token works; nothing
  leaves your machine. Best for the offline demo.
- **Live** — talks to the **real Swipe Partner API** at `app.getswipe.in`
  *directly* (it sends permissive CORS headers, so no proxy/backend is needed),
  using your real Swipe API key. Invoices, payments etc. are **real**.

> Note: for GST to apply on live invoices, the Swipe account must have its GSTIN
> configured (Settings → company profile). Without it, Swipe zeroes the tax on
> every invoice regardless of the `tax_rate` sent.

### Connection and deployment config

Enter the Swipe API key in the in-app **Connection** panel. The browser validates
it directly against Swipe and stores it in localStorage on that device. A clean
browser starts in key-free mock mode.

`index.html` also loads an optional, git-ignored `config.js`, but this file is
only for non-secret deployment defaults:

```js
// frontend/config.js
window.SWIPE_API_BASE = "https://your-mock-backend.example.com";
window.SWIPE_SELLER_STATE = "TELANGANA";
```

> The LLM agent's OpenRouter key is **not** set here — it lives on the backend
> (the `/llm` proxy injects it; see DEPLOYMENT.md). Set `OPENROUTER_API_KEY` in
> the backend's environment to enable the agent.

> ⚠️ **Security:** `config.js` is served to the browser, so every value in it is
> readable by anyone who loads the page. Never put the Swipe key, OpenRouter key,
> or another secret there.

> **Seller state:** the live Swipe API has no company endpoint, so the
> CGST/SGST-vs-IGST split shown on the invoice card is derived from
> `SWIPE_SELLER_STATE`. Set it to your business's state; if omitted, the split is
> flagged "assumed" on the card (the grand total from the API is always correct).

Generate the non-secret settings from environment variables:

```bash
SWIPE_API_BASE=https://your-mock.example.com \
SWIPE_SELLER_STATE=TELANGANA \
python scripts/gen_frontend_config.py
```

`config.js` is `.gitignore`d. See `config.example.js` for the template. If it's
absent, the app falls back to the Connection panel / mock mode.

### Config sources

| Source | Values |
|--------|--------|
| Connection panel / localStorage | live mode and the user's Swipe key |
| `config.js` | non-secret mock base, seller state/GSTIN, fallback model |
| `?api=` query parameter | temporary mock base override only |
| Default | mock mode at `http://127.0.0.1:8000` |

Live mode always targets the fixed Swipe production host, so a mock URL override
cannot receive the real key.

The LLM agent is enabled **server-side**: set `OPENROUTER_API_KEY` (and optional
`OPENROUTER_MODEL`) in the backend's environment. The frontend discovers
availability via the backend's `/llm/status` and routes planning through its
`/llm` proxy — the key never reaches the browser. Absent → the regex intent
matcher is used.

## Files

```
index.html        loads fonts, React + Babel, then engine.js and the .jsx views
engine.js         window.SwipeEngine — NLU + GST preview + the backend HTTP client
app.jsx           App orchestration: intent → plan → stream → confirm → write
chat.jsx          conversation UI (messages, tool-call trace, confirm bar, empty state)
cards.jsx         result cards (invoice, payment, doc list, ledger, GSTIN) + icons
tweaks-panel.jsx  reusable design-tweak panel (host edit-mode protocol)
styles.css        design system (neobrutalist light/dark, "calm" variant)
```

`engine.js` must load before the `.jsx` files (the HTML already orders them
correctly); the app mounts only after `SwipeEngine.ready` resolves, so the first
render has its reference data.
