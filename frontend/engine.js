/* ============================================================================
   Swipe Agent — engine (window.SwipeEngine)
   ----------------------------------------------------------------------------
   The "brain" the UI talks to. Two responsibilities:

   1. Natural-language understanding (client-side): classify intent and pull out
      the customer, amount, GST rate, due date, item and payment method from a
      plain-English sentence. This is the lightweight stand-in for the agent/MCP
      layer — it decides *what* to do.

   2. Real data operations (over HTTP): the actual create / list / pay / ledger /
      GSTIN calls go to the mock backend's REST API (FastAPI, runs locally or in
      the cloud). Nothing is faked — invoices really get created and persisted
      server-side, and the final invoice card is rendered from the backend's own
      computed totals. GST is shown client-side as an instant *preview* before
      the write; the backend re-computes it authoritatively on create.

   Connection (two modes, switchable from the in-app Connection panel):
     • mock — talks to the local FastAPI mock at <backend>            (default)
     • live — talks to the REAL Swipe Partner API at app.getswipe.in
              directly (it sends permissive CORS headers, so no proxy is
              needed), using your real Swipe API key as the bearer token.

   Config precedence (first wins):
     ?mode / ?token / ?api               query params (ad-hoc)
     window.SWIPE_MODE / SWIPE_API_TOKEN / SWIPE_API_BASE   (config.js, from env)
     localStorage swipe_mode / swipe_api_token / swipe_backend  (session)
     defaults: mode=mock  backend=http://127.0.0.1:8000  token="demo"
   An injected window.SWIPE_API_TOKEN (config.js) implies live + that key, so a
   hosted deploy always uses your key with nothing to type.
============================================================================ */
(function () {
  "use strict";

  // ---- config ------------------------------------------------------------ //
  // The real Swipe Partner API. It sends permissive CORS headers, so the
  // browser can call it directly — no proxy needed. `live` mode points here;
  // `mock` mode points at a local FastAPI mock (for the offline/key-free demo).
  var LIVE_API = "https://app.getswipe.in/api/partner";
  function deriveBase(mode, backend) {
    if (mode === "live") return LIVE_API;
    return String(backend || "").replace(/\/+$/, "");
  }
  // --- effective connection state -------------------------------------- //
  // CFG.mode is the user's INTENT ("live" or "mock"). When the live daily limit
  // is hit we do NOT change the intent — we set DEGRADED and transparently serve
  // from the mock, while re-probing the real API on each message so we can offer
  // to reconnect once the limit resets. A pure "mock" intent never degrades or
  // probes (there's no key, and nothing to fall back from).
  var DEGRADED = false;        // live intended, but currently serving from mock
  var PROBE_DISMISSED = false; // user chose to stay on mock for this session
  var RESET_PENDING = false;   // a live-reset prompt is already showing
  function liveIntended() { return CFG.mode === "live"; }
  function isLive() { return CFG.mode === "live" && !DEGRADED; }
  // Where mock calls go: in mock intent that's CFG.base (honours ?api=); in a
  // degraded live session it's the local mock backend (CFG.backend).
  function mockBase() { return CFG.mode === "live" ? CFG.backend : CFG.base; }
  function activeBase() { return isLive() ? LIVE_API : mockBase(); }
  function activeTok() { return isLive() ? CFG.liveTok : "demo"; }
  function readConfig() {
    var qs = new URLSearchParams(location.search);
    // SECURITY / by-design: the Swipe API key is NEVER imported on boot — not
    // from config.js, not from a host env var, not from a query param. It exists
    // only after the user enters it in the Connection panel AND it validates
    // against the live API; it is then persisted in localStorage on THIS device.
    // So the only source here is localStorage, and a clean install starts with
    // no key (→ key-free mock demo).
    var lsTok = localStorage.getItem("swipe_api_token") || "";
    // Mode is the user's last explicit choice; with no saved key we stay on the
    // mock. A stale "live" with no key downgrades to mock (can't go live keyless).
    var mode = localStorage.getItem("swipe_mode") || "mock";
    if (mode === "live" && !lsTok) mode = "mock";
    var backend =
      window.SWIPE_API_BASE ||                 // the MOCK backend URL (not a secret)
      localStorage.getItem("swipe_backend") ||
      "http://127.0.0.1:8000";
    // SECURITY: in live mode the base is ALWAYS the real Swipe host — never an
    // attacker-supplied ?api= (or a stale localStorage swipe_api_base), which
    // would let a crafted link redirect the key to an attacker origin. The ?api=
    // escape hatch is a mock-only convenience (token is the worthless "demo").
    var override = mode === "live" ? "" : (qs.get("api") || localStorage.getItem("swipe_api_base"));
    // The real Swipe key — used only for live calls and live-reset probes. Kept
    // even in a degraded session (which serves "demo" against the mock) so we
    // can still poll the real API for a quota reset.
    var liveTok = lsTok;
    var tok = mode === "live" ? liveTok : "demo";
    var base = override ? override : deriveBase(mode, backend);
    // OpenRouter LLM (the agent's brain). The KEY is server-side now — held by
    // the backend's /llm proxy, never in the browser (see engine.js llmPlan and
    // routers/llm.py). Enablement + model come from the /llm/status probe at
    // boot; this is only a client-side fallback model name. Absent server key →
    // the deterministic regex NLU is used instead.
    var llmModel = qs.get("llm_model") || window.OPENROUTER_MODEL || localStorage.getItem("openrouter_model") || "openai/gpt-4o-mini";
    // Seller's own state/GSTIN. The live API has no company endpoint, so the
    // CGST/SGST-vs-IGST split can't be derived from it — the deploy must supply
    // the seller's state (else we fall back to a default and the split is only
    // a best guess; see SELLER_ASSUMED).
    var sellerGstin = qs.get("seller_gstin") || window.SWIPE_SELLER_GSTIN || "";
    var sellerState = qs.get("seller_state") || window.SWIPE_SELLER_STATE ||
      (sellerGstin ? CODE_STATE[sellerGstin.slice(0, 2)] : "") || "";
    return {
      mode: mode, backend: backend.replace(/\/+$/, ""), base: base.replace(/\/+$/, ""),
      tok: tok, liveTok: liveTok,
      llmModel: llmModel,
      sellerState: normState(sellerState), sellerGstin: sellerGstin,
    };
  }

  // ---- reference data (filled from the backend at boot) ------------------ //
  var SELLER = { name: "Demo Traders Pvt Ltd", gstin: "36AABCD1234E1Z5", state: "TELANGANA", stateCode: "36" };
  var CUSTOMERS = []; // {id,name,gstin,state,stateCode,company,phone,email}
  var PRODUCTS = []; // {id,name,rate,gst,cess,unit,hsn,item_type}
  var SEED_DOCS = []; // normalized mini-docs (see normDoc)

  // Display-only fallback: the 2-digit GST state code is taken from a party's
  // GSTIN when present (authoritative); this map only fills the code for the
  // rare GSTIN-less party so the cards don't show "()". It is intentionally not
  // exhaustive (an unlisted state simply shows no code) and never feeds the
  // CGST/SGST-vs-IGST decision — that compares state *names* (see computeInvoice).
  var STATE_CODE = {
    TELANGANA: "36", KARNATAKA: "29", MAHARASHTRA: "27", DELHI: "07",
    "TAMIL NADU": "33", GUJARAT: "24", "ANDHRA PRADESH": "37", KERALA: "32",
    "UTTAR PRADESH": "09", "WEST BENGAL": "19", RAJASTHAN: "08", HARYANA: "06",
    PUNJAB: "03", BIHAR: "10", ODISHA: "21", "MADHYA PRADESH": "23",
  };
  // Reverse map (GST state code → name). The live customer list omits the
  // address but returns the GSTIN, whose first two digits encode the state —
  // so we can still resolve place-of-supply for the intra/inter-state split.
  var CODE_STATE = {};
  for (var _s in STATE_CODE) if (STATE_CODE.hasOwnProperty(_s)) CODE_STATE[STATE_CODE[_s]] = _s;
  // The live API returns states code-prefixed ("36-TELANGANA"); strip it.
  function cleanState(s) { return normState(String(s == null ? "" : s).replace(/^\d{1,2}\s*-\s*/, "")); }

  // Built after CODE_STATE/normState exist, since readConfig() resolves the
  // seller state from a configured GSTIN.
  var CFG = readConfig();
  // True when live mode is running without an explicitly-configured seller
  // state — the intra/inter-state split is then a best-effort assumption.
  var SELLER_ASSUMED = false;

  // ---- small helpers ----------------------------------------------------- //
  function money(v) { return Math.round((Number(v) + 1e-9) * 100) / 100; }
  function normState(s) { return String(s == null ? "" : s).trim().toUpperCase(); }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "item"; }
  function titleize(s) { return String(s).trim().replace(/\s+/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

  // ---- HTML sanitization ------------------------------------------------- //
  // Agent messages are rendered via dangerouslySetInnerHTML and interpolate
  // untrusted strings (customer names from the live API, LLM-authored text). To
  // stop those injecting active content (e.g. a customer named
  // "<img onerror=…>" exfiltrating the in-page API keys), we escape EVERYTHING,
  // then re-enable only a fixed allowlist of attribute-less tags the agent uses
  // for emphasis. No attributes survive, so no event handlers / src can sneak
  // through. This is the single choke point for all rendered HTML.
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function safeHtml(s) {
    return escapeHtml(s)
      .replace(/&lt;(b|i|u|small)&gt;/gi, "<$1>")
      .replace(/&lt;\/(b|i|u|small)&gt;/gi, "</$1>")
      .replace(/&lt;br\s*\/?&gt;/gi, "<br/>");
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function toDate(x) {
    if (x instanceof Date) return isNaN(x.getTime()) ? null : x;
    if (typeof x === "string") {
      var iso = x.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
      var dmy = x.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (dmy) return new Date(+dmy[3], +dmy[2] - 1, +dmy[1]);
      var d = new Date(x);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }
  function addDays(date, n) { var d = new Date(toDate(date) || new Date()); d.setDate(d.getDate() + (Number(n) || 0)); return d; }
  function ddmmyyyy(date) { var d = toDate(date) || new Date(); return pad2(d.getDate()) + "-" + pad2(d.getMonth() + 1) + "-" + d.getFullYear(); }
  function isoDate(date) { var d = toDate(date) || new Date(); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function isoFromDDMMYYYY(s) { var m = s && String(s).match(/^(\d{2})-(\d{2})-(\d{4})$/); return m ? m[3] + "-" + m[2] + "-" + m[1] : (s || null); }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDate(x) {
    var d = toDate(x);
    if (!d) return "—";
    return d.getDate() + " " + MONTHS[d.getMonth()] + " " + String(d.getFullYear()).slice(2);
  }
  function formatINR(n) {
    var v = Number(n) || 0;
    var neg = v < 0;
    var abs = Math.abs(v);
    var hasFrac = Math.round(abs * 100) % 100 !== 0;
    var s = abs.toLocaleString("en-IN", { minimumFractionDigits: hasFrac ? 2 : 0, maximumFractionDigits: 2 });
    return (neg ? "-" : "") + "₹" + s;
  }

  // ---- entity resolution ------------------------------------------------- //
  function findCustomerById(id) {
    for (var i = 0; i < CUSTOMERS.length; i++) if (CUSTOMERS[i].id === id) return CUSTOMERS[i];
    return null;
  }
  function findCustomer(text) {
    var tl = " " + String(text).toLowerCase() + " ";
    for (var i = 0; i < CUSTOMERS.length; i++) {
      var c = CUSTOMERS[i];
      var toks = c.name.toLowerCase().split(/[\s,]+/).concat((c.company || "").toLowerCase().split(/[\s,]+/));
      for (var j = 0; j < toks.length; j++) {
        var t = toks[j];
        if (t.length >= 3 && tl.indexOf(" " + t) !== -1) return c;
      }
    }
    return null;
  }
  function findProduct(text) {
    if (!text) return null;
    var tl = " " + String(text).toLowerCase() + " ";
    for (var i = 0; i < PRODUCTS.length; i++) {
      var first = PRODUCTS[i].name.toLowerCase().split(/[\s(]+/)[0];
      if (first.length >= 3 && tl.indexOf(first) !== -1) return PRODUCTS[i];
    }
    return null;
  }

  // ---- field parsers ----------------------------------------------------- //
  function scaleAmount(numStr, suffix) {
    var val = parseFloat(String(numStr).replace(/,/g, ""));
    if (isNaN(val)) return null;
    var suf = (suffix || "").toLowerCase();
    if (suf === "k") val *= 1e3;
    else if (suf === "l" || suf === "lac" || suf === "lakh" || suf === "lakhs") val *= 1e5;
    else if (suf === "cr" || suf === "crore" || suf === "crores") val *= 1e7;
    return val;
  }
  var AMOUNT_SUFFIX = "(k|l|lac|lakh|lakhs|cr|crore|crores)";
  function parseAmount(text) {
    var s = String(text);
    // Prefer a currency-anchored amount (₹/Rs prefix or a k/l/cr suffix) so a
    // bare "18%" earlier in the sentence isn't mistaken for the amount.
    var anchored =
      s.match(new RegExp("(?:₹|rs\\.?|inr)\\s*(\\d[\\d,]*(?:\\.\\d+)?)\\s*" + AMOUNT_SUFFIX + "?", "i")) ||
      s.match(new RegExp("(\\d[\\d,]*(?:\\.\\d+)?)\\s*" + AMOUNT_SUFFIX, "i"));
    if (anchored) return scaleAmount(anchored[1], anchored[2]);
    // Fall back to the first plain number that isn't a percentage. Consume the
    // whole number greedily, then check for a trailing "%" so "18%" is skipped.
    var re = /(\d[\d,]*(?:\.\d+)?)(\s*%)?/g, mm;
    while ((mm = re.exec(s)) !== null) {
      if (mm[0] === "") { re.lastIndex++; continue; }
      if (!mm[2]) return scaleAmount(mm[1], null);
    }
    return null;
  }
  function parseGst(text) {
    var m = String(text).match(/(\d+(?:\.\d+)?)\s*%/);
    if (m) return parseFloat(m[1]);
    var m2 = String(text).match(/(?:gst|tax)\s*(?:of|at|@)?\s*(\d+(?:\.\d+)?)/i) ||
             String(text).match(/(\d+(?:\.\d+)?)\s*(?:percent)?\s*gst/i);
    if (m2) return parseFloat(m2[1]);
    return 18; // most common slab; the user usually states it explicitly
  }
  function parseDueDays(text) {
    var m = String(text).match(/due\s+(?:in\s+)?(\d+)\s*days?/i) ||
            String(text).match(/net[-\s]*(\d+)/i) ||
            String(text).match(/in\s+(\d+)\s*days?/i);
    return m ? parseInt(m[1], 10) : 30;
  }
  function parseMethod(text) {
    var tl = String(text).toLowerCase();
    if (/\bupi\b/.test(tl)) return "UPI";
    if (/\bcash\b/.test(tl)) return "Cash";
    if (/credit card|debit card|\bcard\b/.test(tl)) return "Card";
    if (/\bcheque\b|\bcheck\b/.test(tl)) return "Cheque";
    if (/\bemi\b/.test(tl)) return "EMI";
    if (/neft|rtgs|imps|bank\s*transfer|net\s*banking|\bbank\b|\btransfer\b/.test(tl)) return "Bank transfer";
    return "UPI";
  }
  function methodToApi(m) {
    var x = String(m || "").toLowerCase();
    if (x.indexOf("upi") !== -1) return "upi";
    if (x.indexOf("cash") !== -1) return "cash";
    if (x.indexOf("card") !== -1) return "card";
    if (x.indexOf("cheque") !== -1 || x.indexOf("check") !== -1) return "cheque";
    if (x.indexOf("emi") !== -1) return "emi";
    if (/neft|rtgs|imps|bank|net|transfer/.test(x)) return "netBanking";
    return "cash";
  }
  function describeItem(text) {
    var name = null;
    var m = String(text).match(/\bfor\s+([a-z][a-z0-9 &\/-]*?)(?:\s*,|\.|;|\s+gst\b|\s+due\b|\s+at\b|\s+\d|$)/i);
    if (m) name = m[1].trim();
    var prod = findProduct(name || text);
    if (prod) return { id: prod.id, name: titleize(name || prod.name), item_type: prod.item_type, unit: prod.unit, hsn: prod.hsn, product: prod };
    var nm = titleize(name || "Services");
    var svc = /consult|service|maintenance|support|audit|design|develop|retainer|\bfee\b|labour|labor|install/i.test(nm);
    return { id: (svc ? "SVC-" : "GEN-") + slug(nm), name: nm, item_type: svc ? "Service" : "Product", unit: "OTH", hsn: svc ? "9983" : null, product: null };
  }

  // ---- intent classification --------------------------------------------- //
  var GSTIN_RE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z]\d)\b/i;
  function classify(text, ctx) {
    var tl = String(text).toLowerCase();
    var gstinM = String(text).match(GSTIN_RE);
    var gstin = gstinM ? gstinM[1].toUpperCase() : null;

    if (gstin || /\bgstin\b|gst number|gst no\.?\b|look ?up.*gst|verify.*gst/.test(tl)) {
      return { intent: "gstin_lookup", gstin: gstin };
    }
    if (/\b(record|received|collected|got)\b.*\b(payment|paid|rupees|₹|upi|cash|cheque|neft|rtgs|card)\b/.test(tl) ||
        /\b(pay(ment)?|paid)\b.*\bagainst\b/.test(tl) ||
        /^\s*(record|log)\b.*\bpay/.test(tl)) {
      return { intent: "record_payment" };
    }
    if (/\b(show|list|find|display|get|what|which|how many)\b.*\b(invoice|invoices|bill|bills|document|documents)\b/.test(tl) ||
        /\b(unpaid|overdue|pending|paid)\s+(invoice|invoices|bills)\b/.test(tl)) {
      return { intent: "list_invoices" };
    }
    if (/\b(customers?|clients?|parties|buyers?)\b/.test(tl) && /\b(show|list|all|my|view|see|who|which|how many)\b/.test(tl)) {
      return { intent: "list_customers" };
    }
    if (/\b(products?|items?|catalog|catalogue|skus?|inventory|what.*sell)\b/.test(tl) && /\b(show|list|all|my|view|see|what|which|how many|sell)\b/.test(tl)) {
      return { intent: "list_products" };
    }
    // Note: deliberately does NOT match "due" (as in "due in 15 days") — that
    // belongs to invoice creation, not a balance lookup.
    if (/\bowe[sd]?\b|\boutstanding\b|\bledger\b|\bbalance\b/.test(tl)) {
      return { intent: "outstanding" };
    }
    if (/\b(invoice|bill|raise|create|generate|new invoice|charge)\b/.test(tl)) {
      return { intent: "create_invoice" };
    }
    if (ctx && ctx.draft && /\b(actually|make it|change|update|set|add|instead|also|switch|increase|decrease|raise it|drop)\b/.test(tl)) {
      return { intent: "edit_draft" };
    }
    return { intent: "unknown" };
  }

  // ---- LLM planner (OpenRouter) ------------------------------------------ //
  // The real "agent": an LLM reads the message + the live catalog and emits ONE
  // tool call, which the app then dispatches through window.SwipeTools (the tool
  // registry — the single home for each tool's schema, handler and trace). The
  // tool *schemas* the model sees come from there too; this module no longer
  // keeps its own copy. Falls back to classify() when no key is configured, so
  // the demo still runs key-free.
  function llmTools() {
    return (window.SwipeTools && window.SwipeTools.schemas()) || [];
  }

  function buildSystemPrompt(ctx) {
    var custs = CUSTOMERS.map(function (c) {
      return "- " + c.id + " · " + c.name + (c.gstin ? " · GSTIN " + c.gstin : "") + (c.state ? " · " + c.state : "");
    }).join("\n") || "(none yet)";
    var prods = PRODUCTS.map(function (p) {
      return "- " + p.id + " · " + p.name + " · ₹" + p.rate + " · " + p.gst + "% GST · " + p.item_type + (p.unit ? " · " + p.unit : "");
    }).join("\n") || "(none yet)";
    var lines = [
      "You are the agent inside Swipe, an Indian billing/invoicing product. You turn a user's plain-English request into exactly ONE tool call.",
      "Today is " + ddmmyyyy(new Date()) + ". Seller state: " + SELLER.state + " (used for CGST/SGST vs IGST).",
      "",
      "Resolve customers and products to ids from these catalogs. If a customer isn't listed, pass customer_name (a new party will be created). If a product isn't listed, infer item_type and use the user's stated price.",
      "",
      "CUSTOMERS:\n" + custs,
      "",
      "PRODUCTS (unit_price is tax-exclusive):\n" + prods,
      "",
      "Tool routing (decide from THIS message, not the prior turns):",
      "- Money being RECEIVED — 'record/received/got/collected a payment', 'paid ₹X', 'mark X paid' — is ALWAYS record_payment, never create_invoice.",
      "- Billing a customer — 'invoice/bill/charge/raise' — is create_invoice.",
      "- 'show/list/how many' + invoices→list_invoices, + customers→list_customers, + products/items→list_products.",
      "- owes/outstanding/balance/ledger → customer_outstanding. A 15-char GSTIN or 'look up GST' → lookup_gstin.",
      "",
      "Rules: GST defaults to 18% if unstated. Due date defaults to 30 days. Interpret amounts like '50k'=50000, '1.2L'=120000, '2cr'=20000000. For create_invoice, split distinct goods/services into separate items. Never invent invoice numbers; use 'last' or a stated serial for payments. Use 'reply' for chit-chat, help, or anything no tool covers.",
    ];
    if (ctx && ctx.draft && ctx.draft.customer) {
      var d = ctx.draft;
      var dl = d.lines.map(function (l) { return l.qty + "× " + l.name + " @₹" + l.rate + " (" + l.gst + "% GST)"; }).join("; ");
      lines.push("", "There is a PENDING UNCONFIRMED invoice draft for " + d.customer.name + ": " + dl + ". If the user is amending it (e.g. 'make it 28%', 'add 10 gloves'), re-emit create_invoice for the SAME customer with the full updated item list.");
    }
    return lines.join("\n");
  }

  function llmPlan(text, ctx) {
    var messages = [{ role: "system", content: buildSystemPrompt(ctx) }];
    (ctx && ctx.history ? ctx.history : []).forEach(function (h) {
      if (h && h.text) messages.push({ role: h.role === "user" ? "user" : "assistant", content: h.text });
    });
    messages.push({ role: "user", content: String(text) });
    // The OpenRouter key lives only on the backend. We POST to its /llm proxy,
    // which injects the key server-side — so it never ships to the browser. No
    // Authorization header here by design (and in live mode we must NOT send the
    // Swipe key to this origin). The proxy passes OpenRouter's body through
    // verbatim, so the response parsing below is unchanged.
    return fetch(mockBase() + "/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: Engine.llmModel || CFG.llmModel, messages: messages,
        tools: llmTools(), tool_choice: "auto", temperature: 0,
      }),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error((data && data.error && data.error.message) || ("LLM error " + res.status));
        var m = data.choices && data.choices[0] && data.choices[0].message;
        var tc = m && m.tool_calls && m.tool_calls[0];
        if (tc) {
          // Arguments are model-authored JSON. On a parse failure we fall back
          // to {} — the plan builders then re-parse the raw sentence (regex), so
          // a garbled tool call degrades to best-effort rather than throwing.
          var args = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch (e) { args = {}; }
          if (!args || typeof args !== "object") args = {};
          return { tool: tc.function.name, args: args };
        }
        return { tool: "reply", args: { message: (m && m.content) || "" } };
      });
    });
  }

  // ---- GST preview (client mirror of mock_backend/gst.py) ---------------- //
  function computeInvoice(lines, customer) {
    var intra = normState(customer && customer.state) === normState(SELLER.state);
    var out = lines.map(function (l) {
      var rate = (Number(l.gst) || 0) + (Number(l.cess) || 0);
      var gross = (Number(l.qty) || 0) * (Number(l.rate) || 0);
      var disc = 0;
      if (l.discountPercent) disc = (gross * l.discountPercent) / 100;
      else if (l.discountAmount) disc = Number(l.discountAmount);
      disc = Math.max(0, Math.min(disc, gross));
      var net = gross - disc;
      var tax = (net * rate) / 100;
      return Object.assign({}, l, { net: money(net), tax: money(tax), total: money(net + tax) });
    });
    var net = money(out.reduce(function (s, l) { return s + l.net; }, 0));
    var tax = money(out.reduce(function (s, l) { return s + l.tax; }, 0));
    var grand = money(net + tax);
    var breakup;
    if (intra) {
      var cgst = money(tax / 2);
      breakup = [{ label: "CGST", amount: cgst }, { label: "SGST", amount: money(tax - cgst) }];
    } else {
      breakup = [{ label: "IGST", amount: tax }];
    }
    return {
      lines: out, net: net, tax: tax, grand: grand, intra: intra, breakup: breakup,
      slabs: distinctSlabs(lines), assumed: SELLER_ASSUMED,
    };
  }

  // Distinct GST rates present on a line set (so a multi-rate invoice doesn't
  // misreport itself as a single slab).
  function distinctSlabs(lines) {
    var seen = {}, out = [];
    (lines || []).forEach(function (l) {
      var r = Number(l.gst) || 0;
      if (!seen[r]) { seen[r] = true; out.push({ rate: r }); }
    });
    return out.length ? out : [{ rate: 0 }];
  }

  // ---- document helpers (operate on normalized mini-docs) ---------------- //
  function docTotals(doc) {
    var customer = findCustomerById(doc.customerId) ||
      { id: doc.customerId, name: doc.customerName || "Customer", state: "", stateCode: "", gstin: doc.gstin || "" };
    var grand = money(Number(doc.grand) || 0); // always the backend's total_amount
    var paid = money(Number(doc.paid) || 0);
    return { customer: customer, grand: grand, paid: paid, due: money(grand - paid) };
  }
  function docStatus(doc) {
    if (doc.cancelled || doc.status === "cancelled") return "cancelled";
    var t = docTotals(doc);
    if (t.due <= 0.01) return "paid";
    var due = toDate(doc.dueDate);
    if (due && due < startOfToday()) return "overdue";
    if (t.paid > 0) return "partial";
    return "pending";
  }
  function startOfToday() { var n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }

  function normDoc(t) {
    return {
      hash_id: t.hash_id,
      serial: t.serial_number,
      customerId: t.customer && t.customer.id,
      customerName: t.customer && t.customer.name,
      gstin: t.customer && t.customer.gstin,
      date: isoFromDDMMYYYY(t.document_date),
      dueDate: isoFromDDMMYYYY(t.due_date),
      net: t.net_amount,
      tax: t.tax_amount,
      grand: t.total_amount,
      paid: t.amount_paid,
      status: t.payment_status,
      cancelled: t.payment_status === "cancelled",
      item: "",
    };
  }
  function partyState(p) {
    if (!p) return "";
    var b = p.billing_address;
    if (Array.isArray(b)) b = b[0];
    return b && b.state ? cleanState(b.state) : "";
  }
  function invFromDetail(d) {
    // Live nests the document under `invoice_details`; the mock returns it bare.
    if (d && d.invoice_details) d = Array.isArray(d.invoice_details) ? d.invoice_details[0] : d.invoice_details;
    var lines = (d.items || []).map(function (it) {
      return {
        name: it.name, qty: it.quantity, rate: it.unit_price, gst: it.tax_rate,
        unit: it.unit, hsn: it.hsn_code,
        net: it.net_amount, tax: it.tax_amount, total: it.total_amount,
      };
    });
    var tb = d.tax_breakup, intra, assumed = false;
    if (tb) {
      intra = (Number(tb.igst) || 0) === 0;
    } else {
      // Live returns no breakup — derive it from place-of-supply vs the seller's
      // state and split the authoritative total tax accordingly. When the seller
      // state isn't configured (SELLER_ASSUMED), this split is a best guess —
      // the grand total from the API is still correct.
      var ps = partyState(d.party);
      intra = !ps || ps === normState(SELLER.state);
      assumed = SELLER_ASSUMED;
      var tax = Number(d.tax_amount) || 0;
      tb = intra ? { cgst: money(tax / 2), sgst: money(tax - money(tax / 2)), igst: 0 } : { cgst: 0, sgst: 0, igst: tax };
    }
    var breakup = intra
      ? [{ label: "CGST", amount: tb.cgst || 0 }, { label: "SGST", amount: tb.sgst || 0 }]
      : [{ label: "IGST", amount: tb.igst || 0 }];
    return {
      lines: lines, net: d.net_amount, tax: d.tax_amount, grand: d.total_amount,
      intra: intra, breakup: breakup, slabs: distinctSlabs(lines), assumed: assumed,
    };
  }

  // ---- HTTP client ------------------------------------------------------- //
  // Defence-in-depth: in live mode the bearer token is the real Swipe key, so
  // it must only ever leave the browser bound for the real Swipe host. The base
  // is already pinned to LIVE_API for live mode (see readConfig), but we re-check
  // the resolved origin here and fail CLOSED if it has somehow drifted, rather
  // than ever attaching the key to an unexpected origin.
  function assertLiveBaseSafe() {
    if (!isLive()) return;
    try {
      if (new URL(activeBase()).origin !== new URL(LIVE_API).origin) {
        throw new Error("Refusing to send the live Swipe key to an unexpected host (" + activeBase() + ").");
      }
    } catch (e) {
      throw new Error("Invalid live API base: " + activeBase());
    }
  }
  // Recognise a "limit exhausted" rejection from the live API so we can degrade
  // to the mock rather than dead-ending. NOTE: the real Swipe Partner API does
  // NOT use HTTP 429 for this — it returns HTTP 200 with success=false,
  // error_code "FORBIDDEN", and message "API Limit Reached. Please write a mail
  // to api@getswipe.in for additional free credits". So we match on the message
  // text (and 429, for good measure), not on the status or the generic
  // FORBIDDEN code (which also covers real permission errors we must NOT mask).
  function isRateLimit(status, code, message) {
    // Match the SPECIFIC known signals only — a broad alternation against
    // free-text server messages risks misclassifying an unrelated error as a
    // limit (which would wrongly route the call to the mock). HTTP 429, the
    // real Swipe phrasing ("API Limit Reached … additional free credits"), or
    // an explicit rate-limit error_code.
    return status === 429 ||
      /\bapi limit reached\b|\blimit reached\b|\brate.?limit\b|\btoo many requests\b|\bfree credits\b|RATE_LIMIT|LIMIT_EXCEEDED|USAGE_LIMIT|TOO_MANY_REQUESTS/i
        .test(String(code) + " " + String(message));
  }
  // Low-level call. Targets the active endpoint by default; an explicit base/tok
  // (used by the live-reset probe) overrides that to hit the real API directly.
  function rawCall(method, path, body, base, tok) {
    base = base != null ? base : activeBase();
    tok = tok != null ? tok : activeTok();
    return fetch(base + path, {
      method: method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok || (data && data.success === false)) {
          var code = (data && data.error_code) || String(res.status);
          var err = new Error((data && data.message) || ("Request failed (" + res.status + ")"));
          err.code = code; err.status = res.status;
          err.rateLimited = isRateLimit(res.status, code, err.message);
          throw err;
        }
        return data ? data.data : null;
      });
    });
  }
  function apiCall(method, path, body) {
    var live = isLive();
    if (live) assertLiveBaseSafe();
    return rawCall(method, path, body).catch(function (err) {
      // A live call hit the daily limit → flip to degraded so the header shows
      // it and subsequent calls use the mock. We do NOT keep the user's intent
      // a secret, but we DO treat reads and writes differently:
      if (err && err.rateLimited && live && liveIntended()) {
        setDegraded(err.message);
        // Reads degrade transparently — serving the same read from the mock is
        // harmless and keeps the UI alive.
        if (String(method).toUpperCase() === "GET") return rawCall(method, path, body);
        // Writes must NOT silently retry against the mock: creating an invoice /
        // payment on a throwaway backend while the user believes it hit their
        // live account is a silent, misleading write (CLAUDE.md non-negotiable).
        // Surface the limit on THIS attempt; the confirm bar re-arms, and since
        // we're now degraded the user's re-confirm goes to the mock knowingly.
        var e2 = new Error("Live Swipe API daily limit reached — switched to the offline mock. Re-confirm to record this on the mock (sample data), or try again once the limit resets.");
        e2.code = err.code; e2.rateLimited = true;
        throw e2;
      }
      throw err;
    });
  }
  function apiGet(path) { return apiCall("GET", path); }

  // Validate a Swipe key with the MINIMUM possible call (one customer record)
  // against the real API, using the supplied token directly — without changing
  // the active connection. Resolves { ok:true } or { ok:false, error } with a
  // user-facing message (invalid key vs. limit reached vs. unreachable). This is
  // the gate before we ever switch the app to live.
  function validateLiveKey(token) {
    token = String(token || "").trim();
    if (!token) return Promise.resolve({ ok: false, error: "Enter your Swipe API key." });
    return rawCall("GET", "/v2/customer/list?page=1&num_records=1", null, LIVE_API, token)
      .then(function () { return { ok: true }; })
      .catch(function (err) {
        var code = (err && err.code) || "";
        var msg = (err && err.message) || "";
        var error;
        if (err && err.rateLimited) {
          error = "Daily limit reached on this key. Try again after it resets, or email api@getswipe.in for more credits.";
        } else if (/unauthor|invalid token|token format|forbidden/i.test(code + " " + msg)) {
          error = "Invalid or unauthorized API key.";
        } else {
          error = msg ? ("Couldn't validate the key — " + msg) : "Couldn't reach Swipe to validate the key.";
        }
        return { ok: false, error: error };
      });
  }

  var DOC_QUERY = "document_type=invoice&start_date=01-01-2000&end_date=31-12-2099&payment_status=all&num_records=100";

  function listInvoices() {
    return apiGet("/v2/doc/list?" + DOC_QUERY).then(function (data) {
      return ((data && data.transactions) || []).map(normDoc);
    });
  }
  function refreshDocs() {
    return listInvoices().then(function (docs) {
      SEED_DOCS.length = 0;
      docs.forEach(function (d) { SEED_DOCS.push(d); });
      return docs;
    });
  }

  // The live API requires fully-computed line amounts (we send our own preview
  // totals; it recomputes authoritatively); the mock derives them server-side
  // from the minimal inputs. Pass `computed` for live, null for mock.
  function buildItems(draft, computed) {
    return draft.lines.map(function (l, i) {
      var item = {
        id: l.id || ("GEN-" + slug(l.name)),
        name: l.name,
        item_type: l.item_type || "Product",
        quantity: Number(l.qty) || 0,
        unit_price: Number(l.rate) || 0,
        tax_rate: Number(l.gst) || 0,
        cess_rate: Number(l.cess) || 0,
        // The live API rejects nulls here, so always send a number / omit blanks.
        discount_percent: Number(l.discountPercent) || 0,
      };
      if (l.hsn) item.hsn_code = l.hsn;
      if (l.unit) item.unit = l.unit;
      if (computed) {
        var cl = computed.lines[i];
        var rate = (Number(l.gst) || 0) + (Number(l.cess) || 0);
        item.net_amount = cl.net;
        item.tax_amount = cl.tax;
        item.total_amount = cl.total;
        item.price_with_tax = money((Number(l.rate) || 0) * (1 + rate / 100));
      }
      return item;
    });
  }

  // A full AddressV2 for the live doc party (the live customer list omits the
  // address; we fetch it and fall back to placeholders + GSTIN-derived state).
  function liveAddr(a, idV2, fallbackState) {
    a = a || {};
    return {
      addr_id_v2: idV2,
      address_line1: a.address_line1 || "NA",
      address_line2: a.address_line2 || "",
      city: a.city || "NA",
      state: cleanState(a.state) || normState(fallbackState) || normState(SELLER.state),
      country: a.country || "India",
      pincode: a.pincode || "000000",
    };
  }

  function postDoc(body) {
    return apiCall("POST", "/v2/doc", body).then(function (data) {
      return apiGet("/v2/doc/" + data.hash_id).then(function (detail) {
        return { hash_id: data.hash_id, serial: data.serial_number, inv: invFromDetail(detail), detail: detail };
      });
    });
  }

  function createInvoiceLive(draft) {
    var c = draft.customer;
    var computed = computeInvoice(draft.lines, c);
    var items = buildItems(draft, computed);
    // Fetch the stored customer to recover a valid billing/shipping address.
    return apiGet("/v2/customer/" + encodeURIComponent(c.id)).then(function (cd) {
      var cust = Array.isArray(cd) ? cd[0] : cd || {};
      var bAddr = (cust.billing_address || [])[0];
      var sAddr = (cust.shipping_address || [])[0] || bAddr;
      var body = {
        document_type: "invoice",
        document_date: ddmmyyyy(new Date()),
        due_date: ddmmyyyy(draft.dueDate),
        party: {
          id: c.id, type: "customer", name: c.name,
          gstin: c.gstin || undefined, company_name: c.company || undefined,
          phone_number: c.phone || undefined, email: c.email || undefined,
          billing_address: liveAddr(bAddr, "b" + c.id, c.state),
          shipping_address: liveAddr(sAddr, "s" + c.id, c.state),
        },
        items: items,
      };
      return postDoc(body);
    });
  }

  function createInvoiceMock(draft) {
    var c = draft.customer;
    var addr = { state: c.state || null };
    var body = {
      document_type: "invoice",
      document_date: ddmmyyyy(new Date()),
      due_date: ddmmyyyy(draft.dueDate),
      party: {
        id: c.id, type: "customer", name: c.name,
        gstin: c.gstin || null, company_name: c.company || null,
        phone_number: c.phone || null, email: c.email || null,
        billing_address: addr, shipping_address: addr,
      },
      items: buildItems(draft, null),
    };
    return postDoc(body);
  }

  // Idempotency guard: writes have no server idempotency key, so we dedupe
  // client-side by a fingerprint of the draft. A double-click or a re-confirm of
  // the SAME draft reuses the in-flight / resolved create instead of POSTing
  // twice. On failure we clear it so a genuine retry works. (Residual limit: a
  // lost response *after* the server created the doc can't be deduped without a
  // server-side key — surface this by refreshing the list before re-confirming.)
  var _createInflight = {};
  function draftFingerprint(draft) {
    var c = draft.customer || {};
    var items = (draft.lines || []).map(function (l) {
      return [l.id, l.name, l.qty, l.rate, l.gst, l.cess, l.discountPercent].join(":");
    }).join("|");
    // Include the effective backend so a draft created on the mock (while
    // degraded) and the SAME draft later created on live don't collide — else a
    // resumed-live create would return the stale mock result from the cache.
    return [isLive() ? "live" : "mock", c.id, draft.dueDays, items].join("~");
  }
  function createInvoice(draft) {
    var fp = draftFingerprint(draft);
    if (_createInflight[fp]) return _createInflight[fp];
    var p = isLive() ? createInvoiceLive(draft) : createInvoiceMock(draft);
    _createInflight[fp] = p;
    p.catch(function () { delete _createInflight[fp]; });
    return p;
  }

  // Live payment_mode enum is Title Case ("UPI", "Net Banking", …) and differs
  // from the v2 doc-embedded method enum.
  function methodToLive(m) {
    var x = String(m || "").toLowerCase();
    if (x.indexOf("upi") !== -1) return "UPI";
    if (x.indexOf("cash") !== -1) return "Cash";
    if (x.indexOf("card") !== -1) return "Card";
    if (x.indexOf("cheque") !== -1 || x.indexOf("check") !== -1) return "Cheque";
    if (x.indexOf("emi") !== -1) return "EMI";
    if (/neft|rtgs|imps|bank|net|transfer/.test(x)) return "Net Banking";
    return "Cash";
  }

  function recordPayment(args) {
    var amount = Number(args.amount) || 0;
    if (isLive()) {
      var mode = methodToLive(args.method);
      var body = {
        amount: amount,
        customer: args.doc.customerId,
        payment_date: ddmmyyyy(new Date()),
        payment_mode: mode,
        documents: [{ hash_id: args.doc.hash_id, amount_paying: amount }],
      };
      // The live API rejects non-cash payments without bank details.
      if (mode !== "Cash") {
        body.bank_details = { account_number: "000000000000", ifsc: "HDFC0000001", bank_name: "HDFC Bank", branch: "Demo" };
      }
      return apiCall("POST", "/v2/payment", body);
    }
    return apiCall("POST", "/v2/payment", {
      doc_hash_id: args.doc.hash_id, amount: amount, method: methodToApi(args.method),
    });
  }

  function ledger(customerId) {
    if (isLive()) {
      var q = "customer_id=" + encodeURIComponent(customerId) +
        "&start_date=01-01-2000&end_date=31-12-2099&num_records=100";
      return apiGet("/v2/customer/ledger?" + q).then(function (d) {
        d = d || {};
        var entries = (d.ledger || []).filter(function (e) { return e.date; }).map(function (e) {
          var isPay = !!e.mode || /^PAY/i.test(e.serial_number || "");
          var amt = Number(e.total_amount) || 0;
          return {
            date: isoFromDDMMYYYY(e.date), label: e.serial_number || (isPay ? "Payment" : "Invoice"),
            debit: isPay ? 0 : amt, credit: isPay ? amt : 0,
            balance: -(Number(e.balance) || 0), // live balance is negative when owed
          };
        });
        return { entries: entries, outstanding: -(Number(d.closing_balance) || 0), opening: 0 };
      });
    }
    return apiGet("/v2/customer/ledger?customer_id=" + encodeURIComponent(customerId)).then(function (d) {
      var entries = (d.transactions || []).map(function (t) {
        return { date: isoFromDDMMYYYY(t.date), label: t.particulars, debit: t.debit || 0, credit: t.credit || 0, balance: t.balance };
      });
      return { entries: entries, outstanding: d.closing_balance, opening: d.opening_balance };
    });
  }

  function lookupGstin(gstin) {
    return apiGet("/v2/utils/gstin/" + encodeURIComponent(gstin)).then(function (d) {
      return {
        legal: d.legal_name || "—", trade: d.trade_name || "—",
        state: d.state || "—", stateCode: (d.gstin || "").slice(0, 2),
        gstin: d.gstin || gstin, type: d.taxpayer_type || "Regular", status: d.status || "Active",
      };
    });
  }

  // ---- boot / connection ------------------------------------------------- //
  // The mock returns `data` as a bare array; the live API wraps it
  // (`data.customers`, `data.items`). Accept either, plus a `transactions`
  // fallback, so the same client drives both.
  function asList(data, keys) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") {
      for (var i = 0; i < keys.length; i++) if (Array.isArray(data[keys[i]])) return data[keys[i]];
    }
    return [];
  }
  function fillCustomers(data) {
    CUSTOMERS.length = 0;
    asList(data, ["customers"]).forEach(function (c) {
      // The live API lists unmapped customers with a null id (e.g. the
      // "Default Customer" placeholder) — skip those; they aren't addressable.
      if (c.customer_id == null) return;
      var ba = c.billing_address && c.billing_address[0];
      var code = (c.gstin && c.gstin.slice(0, 2)) || "";
      // Prefer the address state; else recover it from the GSTIN's state code
      // (the live list has no address but does carry the GSTIN).
      var state = cleanState(ba && ba.state) || CODE_STATE[code] || "";
      if (!code) code = STATE_CODE[state] || "";
      CUSTOMERS.push({
        id: c.customer_id, name: c.name, gstin: c.gstin || "", state: state,
        stateCode: code, company: c.company_name || "", phone: c.phone || "", email: c.email || "",
      });
    });
  }
  function fillProducts(data) {
    PRODUCTS.length = 0;
    asList(data, ["items", "products"]).forEach(function (p) {
      // Field names differ live vs mock: id/item_id, unit_price/selling_price.
      var id = p.item_id != null ? p.item_id : p.id;
      if (id == null) return; // skip the live "Sample Product" placeholder
      var rate = p.selling_price != null ? p.selling_price : p.unit_price;
      PRODUCTS.push({
        id: id, name: p.name, rate: rate, gst: p.tax_rate,
        cess: p.cess_rate || 0, unit: p.unit, hsn: p.hsn_code, item_type: p.item_type,
      });
    });
  }

  // Whether the agent's LLM brain is available is now a SERVER fact (the
  // OpenRouter key lives on the backend, not in the browser). Probe the proxy's
  // status endpoint and reflect it on the Engine; on any failure we leave the
  // LLM off and the deterministic regex NLU takes over. Fire-and-forget — it
  // doesn't gate the connection state, and resolves well before the first turn.
  function probeLLM() {
    return fetch(mockBase() + "/llm/status")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        Engine.llmEnabled = !!(s && s.enabled);
        if (s && s.model) Engine.llmModel = s.model;
      })
      .catch(function () { Engine.llmEnabled = false; });
  }

  function boot() {
    probeLLM();
    // `_mock/company` is a mock-only convenience; the live API has no company
    // endpoint. In live mode the seller identity comes from config (if set),
    // else stays at the default and the intra/inter split is flagged assumed.
    var company;
    if (isLive()) {
      company = Promise.resolve(null);
      if (CFG.sellerState) {
        SELLER.state = CFG.sellerState;
        SELLER.stateCode = (CFG.sellerGstin || "").slice(0, 2) || STATE_CODE[CFG.sellerState] || SELLER.stateCode;
        if (CFG.sellerGstin) SELLER.gstin = CFG.sellerGstin;
        SELLER.name = "Your business";
        SELLER_ASSUMED = false;
      } else {
        SELLER_ASSUMED = true; // no configured seller state → split is a guess
      }
    } else {
      SELLER_ASSUMED = false;
      company = fetch(mockBase() + "/v2/_mock/company")
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    }
    return Promise.all([
      company,
      apiGet("/v2/customer/list?num_records=100"),
      apiGet("/v2/product/list?num_records=100"),
      listInvoices(),
    ]).then(function (res) {
      var co = res[0];
      if (co && co.state) {
        SELLER.name = co.name || SELLER.name;
        SELLER.gstin = co.gstin || SELLER.gstin;
        SELLER.state = normState(co.state);
        SELLER.stateCode = (co.gstin || "").slice(0, 2) || SELLER.stateCode;
      }
      fillCustomers(res[1]);
      fillProducts(res[2]);
      SEED_DOCS.length = 0;
      res[3].forEach(function (d) { SEED_DOCS.push(d); });
      Engine.online = true;
      Engine.lastError = null;
      notifyMode();   // single propagation point for connection state → UI
    }).catch(function (e) {
      Engine.online = false;
      Engine.lastError = (e && e.message) || "Cannot reach the Swipe API.";
      notifyMode();
    });
  }
  function reconnect() { return boot().then(function () { return Engine.online; }); }

  // Notify the UI of a connection-state change (the React app listens for this
  // to resync the header pill, the offline state, and the document cache).
  function notifyMode() {
    Engine.mode = CFG.mode;
    Engine.intendedLive = liveIntended();
    Engine.usingMock = !isLive();
    Engine.degraded = DEGRADED;
    Engine.apiBase = activeBase();
    try {
      window.dispatchEvent(new CustomEvent("swipe:mode", {
        detail: {
          mode: CFG.mode, online: Engine.online,
          degraded: !!DEGRADED, intendedLive: liveIntended(),
          reason: Engine.degradedReason || "",
        },
      }));
    } catch (e) { /* CustomEvent unavailable — UI reads Engine flags on next render */ }
  }

  // Enter degraded mode: live is intended, but the daily limit is spent, so we
  // transparently serve from the mock. Runtime-only (never persisted) and fully
  // reversible (resumeLive). The header shows a small "daily limit reached" tag.
  function setDegraded(reason) {
    if (DEGRADED) return;
    DEGRADED = true;
    Engine.degraded = true;
    Engine.degradedReason = reason || "Live Swipe API daily limit reached";
    notifyMode();
  }

  // Probe the real API (one cheap read) to see whether the daily limit has
  // reset. Hits the live host directly with the real key, bypassing the degrade
  // path; resolves true only on a genuine success.
  function probeLive() {
    if (!liveIntended() || !DEGRADED || !CFG.liveTok) return Promise.resolve(false);
    return rawCall("GET", "/v2/customer/list?num_records=1", null, LIVE_API, CFG.liveTok)
      .then(function () { return true; })
      .catch(function () { return false; });
  }
  // Called by the UI on each new message while degraded: silently re-probe live;
  // if it's back, raise a one-time "swipe:livereset" prompt and let the user
  // decide whether to reconnect. No-op once dismissed or while a prompt shows.
  function maybeProbeLive() {
    if (!liveIntended() || !DEGRADED || PROBE_DISMISSED || RESET_PENDING) return Promise.resolve(false);
    return probeLive().then(function (up) {
      if (up) {
        RESET_PENDING = true;
        try { window.dispatchEvent(new CustomEvent("swipe:livereset", { detail: {} })); } catch (e) {}
      }
      return up;
    });
  }
  // User accepted the reset: drop back to the real API, fresh.
  function resumeLive() {
    DEGRADED = false; PROBE_DISMISSED = false; RESET_PENDING = false;
    Engine.degraded = false; Engine.degradedReason = null;
    return boot().then(function () { notifyMode(); return Engine.online; });
  }
  // User declined: keep this chat on the mock and stop probing for the session.
  function stayOnMock() {
    PROBE_DISMISSED = true; RESET_PENDING = false;
    notifyMode();
  }

  // Apply new connection settings (from the in-app Connection panel), persist
  // them, then re-boot against the new target. Returns whether we connected.
  function configure(opts) {
    opts = opts || {};
    // An explicit reconnect clears any prior automatic degrade / probe state.
    DEGRADED = false; PROBE_DISMISSED = false; RESET_PENDING = false;
    Engine.degraded = false; Engine.degradedReason = null;
    if (opts.mode != null) { CFG.mode = opts.mode; localStorage.setItem("swipe_mode", opts.mode); }
    if (opts.backend != null) { CFG.backend = String(opts.backend).replace(/\/+$/, ""); localStorage.setItem("swipe_backend", CFG.backend); }
    if (opts.token != null) {
      localStorage.setItem("swipe_api_token", opts.token);
      if (CFG.mode === "live") CFG.liveTok = opts.token;
    }
    // A saved choice always recomputes the base from (mode, backend), so drop
    // any legacy full-base override that would otherwise pin it.
    localStorage.removeItem("swipe_api_base");
    CFG.base = deriveBase(CFG.mode, CFG.backend);
    CFG.tok = CFG.mode === "live" ? CFG.liveTok : "demo";
    Engine.token = CFG.tok; Engine.mode = CFG.mode; Engine.backend = CFG.backend;
    Engine.intendedLive = liveIntended(); Engine.apiBase = activeBase();
    return reconnect();
  }
  function resetBackend() {
    return fetch(mockBase() + "/v2/_mock/reset", { method: "POST" })
      .then(function () { return boot(); })
      .then(function () { return SEED_DOCS.slice(); });
  }

  // ---- export ------------------------------------------------------------ //
  var Engine = {
    // config / status
    apiBase: CFG.base, token: CFG.tok, mode: CFG.mode, backend: CFG.backend,
    online: false, lastError: null, ready: null,
    intendedLive: CFG.mode === "live", usingMock: CFG.mode !== "live",
    degraded: false, degradedReason: null,
    // reference data (mutated in place by boot)
    SELLER: SELLER, CUSTOMERS: CUSTOMERS, PRODUCTS: PRODUCTS, SEED_DOCS: SEED_DOCS, TODAY: new Date(),
    // formatting + sanitization
    formatINR: formatINR, fmtDate: fmtDate, addDays: addDays, safeHtml: safeHtml, escapeHtml: escapeHtml,
    // NLU + LLM planner
    // llmEnabled is set by probeLLM() at boot from the backend's /llm/status —
    // the key is server-side now, so the browser can't know it up front.
    classify: classify, llmPlan: llmPlan, llmEnabled: false, llmModel: CFG.llmModel,
    findCustomer: findCustomer, findCustomerById: findCustomerById, findProduct: findProduct,
    parseAmount: parseAmount, parseGst: parseGst, parseDueDays: parseDueDays,
    parseMethod: parseMethod, describeItem: describeItem, GSTIN_RE: GSTIN_RE,
    // math
    computeInvoice: computeInvoice, docTotals: docTotals, docStatus: docStatus,
    // backend operations
    createInvoice: createInvoice, recordPayment: recordPayment, listInvoices: listInvoices,
    refreshDocs: refreshDocs, ledger: ledger, lookupGstin: lookupGstin,
    reconnect: reconnect, resetBackend: resetBackend, configure: configure,
    validateLiveKey: validateLiveKey,
    maybeProbeLive: maybeProbeLive, resumeLive: resumeLive, stayOnMock: stayOnMock,
  };
  window.SwipeEngine = Engine;
  Engine.ready = boot(); // kick off; resolves whether or not the backend is up
})();
