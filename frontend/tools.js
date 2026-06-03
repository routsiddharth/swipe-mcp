/* ============================================================================
   Swipe Agent — tool registry (the real tool seam)

   ONE place per tool, holding all three things that used to be smeared across
   the codebase:
     • schema  — the JSON the LLM sees (engine.js's llmPlan derives its tool list
                 from schemas() here; it no longer keeps its own copy).
     • run     — the handler: resolve entities, do the GST preview, build the
                 result card + confirm bar + the write to run on confirm.
     • trace   — the MCP step labels, emitted by run() right next to the logic
                 they describe.

   app.jsx no longer contains tool logic; it builds a ctx and calls dispatch().
   A real MCP server would satisfy this exact { name, schema, run } interface —
   it becomes the second adapter at this seam.

   ctx (supplied by app.jsx per turn):
     text                      the raw user message
     history                   recent turns, for the LLM
     draft, getDraft/setDraft  the single pending invoice draft
     getDocs/setDocs           the local document cache
     getLastDoc/setLastDoc     most recently touched document
     patch(msgId, partial)     patch a rendered message in place
============================================================================ */
(function () {
  "use strict";
  var E = window.SwipeEngine;

  // ---- arg → line-item coercion ----------------------------------------- //
  function slugId(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "item";
  }
  function titleCase(s) {
    return String(s || "").trim().replace(/\s+/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  // The model controls items[] — coerce anything non-object to a safe stub so a
  // stray null/string can't throw and lock up the turn.
  function lineFromArg(it) {
    if (!it || typeof it !== "object") it = { name: typeof it === "string" ? it : "Item" };
    var prod = null;
    if (it.item_id) prod = E.PRODUCTS.find(function (p) { return p.id === it.item_id; });
    if (!prod && it.name) prod = E.findProduct(it.name);
    return {
      id: it.item_id || (prod && prod.id) || ("GEN-" + slugId(it.name)),
      name: titleCase(it.name || (prod && prod.name) || "Item"),
      item_type: it.item_type || (prod && prod.item_type) || "Product",
      qty: Number(it.quantity) || 1,
      rate: it.unit_price != null ? Number(it.unit_price) : (prod ? prod.rate : 0),
      gst: it.tax_rate != null ? Number(it.tax_rate) : (prod ? prod.gst : 18),
      cess: it.cess_rate != null ? Number(it.cess_rate) : (prod ? prod.cess : 0),
      unit: it.unit || (prod && prod.unit) || "",
      hsn: it.hsn_code || (prod && prod.hsn) || "",
      discountPercent: it.discount_percent != null ? Number(it.discount_percent) : undefined,
    };
  }

  var METHOD_LABEL = { upi: "UPI", cash: "Cash", card: "Card", cheque: "Cheque", emi: "EMI", netBanking: "Bank transfer" };

  function resolveTargetDoc(ref, ctx) {
    var text = ctx.text;
    var docs = ctx.getDocs();
    var last = ctx.getLastDoc();
    ref = String(ref || "");
    if ((/last|recent|latest|\bit\b|that|this|above/i.test(ref) ||
         (!ref && /\b(it|that|this|the invoice|above)\b/i.test(text))) && last) return last;
    var serialM = (ref + " " + text).match(/inv[-\s]?0?(\d{1,4})/i) || ref.match(/^\s*0*(\d{1,4})\s*$/);
    if (serialM) {
      var d = docs.find(function (x) {
        return x.serial && (x.serial.replace(/\D/g, "") === serialM[1].padStart(3, "0") || x.serial.toLowerCase().includes(serialM[1]));
      });
      if (d) return d;
    }
    var cust = E.findCustomer(text);
    if (cust) {
      var open = docs.filter(function (d2) { return d2.customerId === cust.id && E.docStatus(d2) !== "paid"; });
      if (open.length) return open[open.length - 1];
    }
    return last;
  }

  // ---- shared, content-only plans --------------------------------------- //
  function clarify(msg) { return { intro: msg, trace: [], card: null, isWrite: false }; }
  function message(msg) {
    return { intro: msg || "I can create invoices, record payments, list invoices/customers/products, pull a ledger, or look up a GSTIN — what do you need?", trace: [], card: null, isWrite: false };
  }
  function unknown() {
    return {
      intro: "I can help you run Swipe in plain English — try:<br>• <b>Create</b> “invoice Acme ₹50,000 for consulting, 18% GST, due in 15 days”<br>• <b>Collect</b> “record a ₹20,000 UPI payment against it”<br>• <b>Read</b> “show unpaid invoices this quarter” · “what's Globex's outstanding balance?”",
      trace: [], card: null, isWrite: false,
    };
  }

  // ---- create_invoice ---------------------------------------------------- //
  function runCreate(args, ctx) {
    args = args || {};
    var text = ctx.text;
    // Resolve the customer: LLM id → LLM name → free-text match → new party.
    var customer = args.customer_id ? E.findCustomerById(args.customer_id) : null;
    if (!customer && args.customer_name) customer = E.findCustomer(args.customer_name);
    if (!customer) customer = E.findCustomer(text);
    if (!customer && args.customer_name) {
      customer = { id: "CUST-" + slugId(args.customer_name), name: titleCase(args.customer_name), gstin: "", state: "", stateCode: "", company: "", phone: "", email: "" };
    }
    if (!customer) return clarify("Which customer is this for? I can bill " +
      E.CUSTOMERS.map(function (c) { return c.name; }).slice(0, 3).join(", ") + " and others.");

    // Build line items from the LLM's structured items, else parse the sentence.
    var lines;
    if (Array.isArray(args.items) && args.items.length) {
      lines = args.items.map(lineFromArg);
    } else {
      var amount = E.parseAmount(text);
      if (!amount) return clarify("What amount should I bill " + customer.name + "? e.g. “₹50,000”.");
      var item = E.describeItem(text);
      // Only override a matched product's GST when the user actually stated a
      // rate — otherwise a 0%/exempt catalog item would be silently taxed at the
      // 18% default. GST is the centerpiece; respect it.
      var statedGst = /\d+(?:\.\d+)?\s*%|\bgst\b|\btax\b/i.test(text);
      var gst = statedGst ? E.parseGst(text) : (item.product ? item.product.gst : E.parseGst(text));
      var cess = item.product ? item.product.cess : 0;
      lines = [{ id: item.id, name: item.name, item_type: item.item_type, qty: 1, rate: amount, gst: gst, cess: cess, unit: item.unit || "", hsn: item.hsn || "" }];
    }
    var dueDays = args.due_days != null ? Number(args.due_days) : E.parseDueDays(text);
    var dueDate = E.addDays(E.TODAY, dueDays);
    var inv = E.computeInvoice(lines, customer);
    // Amending a pending draft? Supersede its confirm bar so only one is live.
    var prev = ctx.getDraft();
    if (prev && prev.msgId) ctx.patch(prev.msgId, { confirm: null, supersededNote: true });
    var draft = { customer: customer, lines: lines, dueDays: dueDays, dueDate: dueDate };
    var rates = Array.from(new Set(lines.map(function (l) { return l.gst; })));
    var gstLabel = rates.length === 1 ? rates[0] + "%" : "GST";
    var itemsLabel = lines.length === 1 ? lines[0].name : lines.length + " line items";
    return {
      intro: "Got it — composing an invoice for <b>" + customer.name + "</b>. Here's the GST worked out <i>before</i> I create anything:",
      trace: [
        { tool: "resolve_customer", label: "Matched <b>" + customer.name + "</b>" + (customer.gstin ? " · GSTIN " + customer.gstin : "") },
        { tool: "get_tax_profile", label: "Place of supply <b>" + (customer.state || "—") + (customer.stateCode ? " (" + customer.stateCode + ")" : "") + "</b> → " + (inv.intra ? "intra-state" : "inter-state") },
        { tool: "compute_gst", label: gstLabel + " on " + E.formatINR(inv.net) + " (" + itemsLabel + ") = <b>" + E.formatINR(inv.tax) + "</b> " + (inv.intra ? "(CGST + SGST)" : "(IGST)") },
        { tool: "compose_document", label: "Drafted invoice · grand total <b>" + E.formatINR(inv.grand) + "</b>" },
      ],
      card: { type: "invoice", props: { inv: inv, customer: customer, meta: { dueDate: dueDate }, status: "draft" } },
      confirm: { question: "Create this invoice for " + customer.name + "?", confirmLabel: "Create invoice" },
      onCommit: async function (id) {
        var res = await E.createInvoice(draft);
        ctx.setDocs(await E.refreshDocs());
        ctx.setLastDoc(ctx.getDocs().find(function (d) { return d.hash_id === res.hash_id; }) || ctx.getLastDoc());
        ctx.setDraft(null);
        ctx.patch(id, {
          card: { type: "invoice", props: { inv: res.inv, customer: customer, meta: { dueDate: dueDate }, status: "pending", serial: res.serial } },
          stampText: "Created!",
          committedNote: "<b>" + res.serial + "</b> is live · " + E.formatINR(res.inv.grand) + " · pending. Ready to share over <b>WhatsApp</b>, email or SMS.",
        });
      },
      draft: draft,
      isWrite: true,
    };
  }

  // ---- edit_draft (regex fallback only; the LLM re-emits create_invoice) -- //
  function runEdit(args, ctx) {
    var text = ctx.text;
    var draft = ctx.getDraft();
    if (!draft) return unknown();
    var changeNote = "Updated";
    var gstM = text.match(/(\d+(?:\.\d+)?)\s*%/);
    if (gstM && /gst|tax|%/.test(text.toLowerCase())) {
      var g = parseFloat(gstM[1]);
      draft.lines.forEach(function (l) { l.gst = g; });
      changeNote = "Switched GST to " + g + "%";
    }
    var addM = text.match(/add\s+(\d+)\s+([a-z][a-z &\-]+)/i);
    if (addM) {
      var qty = parseInt(addM[1], 10);
      var name = addM[2].trim().toLowerCase();
      var prod = E.PRODUCTS.find(function (p) {
        return name.includes(p.name.toLowerCase().split(" ")[0]) || p.name.toLowerCase().includes(name.split(" ")[0]);
      });
      var p = prod || { name: titleCase(addM[2].trim()), rate: 100, gst: draft.lines[0].gst, unit: "pcs", hsn: "0000" };
      draft.lines.push({ name: p.name, qty: qty, rate: p.rate, gst: p.gst, unit: p.unit, hsn: p.hsn });
      changeNote = "Added " + qty + " × " + p.name;
    }
    var amt = (/make it|change.*to|set.*to/.test(text.toLowerCase()) && !gstM) ? E.parseAmount(text) : null;
    if (amt && !addM) { draft.lines[0].rate = amt; changeNote = "Set amount to " + E.formatINR(amt); }
    var dueM = text.match(/due\s+in\s+(\d+)\s*days?/i);
    if (dueM) { draft.dueDays = parseInt(dueM[1], 10); draft.dueDate = E.addDays(E.TODAY, draft.dueDays); changeNote = "Due in " + draft.dueDays + " days"; }

    var inv = E.computeInvoice(draft.lines, draft.customer);
    if (draft.msgId) ctx.patch(draft.msgId, { confirm: null, cancelled: false, supersededNote: true });
    return {
      intro: changeNote + " — here's the recalculated invoice:",
      trace: [
        { tool: "edit_document", label: changeNote },
        { tool: "compute_gst", label: "New tax <b>" + E.formatINR(inv.tax) + "</b> · grand total <b>" + E.formatINR(inv.grand) + "</b>" },
      ],
      card: { type: "invoice", props: { inv: inv, customer: draft.customer, meta: { dueDate: draft.dueDate }, status: "draft" } },
      confirm: { question: "Create this updated invoice for " + draft.customer.name + "?", confirmLabel: "Create invoice" },
      onCommit: async function (id) {
        var res = await E.createInvoice(draft);
        ctx.setDocs(await E.refreshDocs());
        ctx.setLastDoc(ctx.getDocs().find(function (d) { return d.hash_id === res.hash_id; }) || ctx.getLastDoc());
        ctx.setDraft(null);
        ctx.patch(id, {
          card: { type: "invoice", props: { inv: res.inv, customer: draft.customer, meta: { dueDate: draft.dueDate }, status: "pending", serial: res.serial } },
          stampText: "Created!",
          committedNote: "<b>" + res.serial + "</b> created · " + E.formatINR(res.inv.grand) + ".",
        });
      },
      draft: draft,
      isWrite: true,
    };
  }

  // ---- record_payment ---------------------------------------------------- //
  function runPayment(args, ctx) {
    args = args || {};
    var amount = args.amount != null ? Number(args.amount) : E.parseAmount(ctx.text);
    var method = args.method ? (METHOD_LABEL[args.method] || args.method) : E.parseMethod(ctx.text);
    var doc = resolveTargetDoc(args.document_ref, ctx);
    if (!doc) return clarify("Which invoice should I record the payment against? Create one first or name a serial like INV-008.");
    if (!amount) return clarify("How much was paid against " + doc.serial + "?");
    var t0 = E.docTotals(doc);
    // The live API rejects a payment greater than the balance — catch it here so
    // the preview is honest rather than a checkmark the write will then reject.
    if (amount > t0.due + 0.01) {
      return clarify("That's more than " + doc.serial + "'s outstanding balance of <b>" + E.formatINR(t0.due) + "</b>. Want me to record exactly " + E.formatINR(t0.due) + " to settle it, or a smaller amount?");
    }
    return {
      intro: "Recording a <b>" + E.formatINR(amount) + "</b> " + method + " payment against <b>" + doc.serial + "</b> (" + t0.customer.name + ").",
      trace: [
        { tool: "find_document", label: "Located <b>" + doc.serial + "</b> · " + E.formatINR(t0.grand) + " · " + E.docStatus(doc) },
        { tool: "validate_payment", label: E.formatINR(amount) + " ≤ balance " + E.formatINR(t0.due) + " ✓" },
        { tool: "compose_receipt", label: "Prepared " + method + " receipt" },
      ],
      card: { type: "payment", props: { amount: amount, method: method, doc: doc, preview: true } },
      confirm: { question: "Record " + E.formatINR(amount) + " against " + doc.serial + "?", confirmLabel: "Record payment" },
      onCommit: async function (id) {
        await E.recordPayment({ doc: doc, amount: amount, method: method });
        ctx.setDocs(await E.refreshDocs());
        var updated = ctx.getDocs().find(function (d) { return d.hash_id === doc.hash_id; }) || doc;
        ctx.setLastDoc(updated);
        var st = E.docStatus(updated);
        var nt = E.docTotals(updated);
        ctx.patch(id, {
          card: { type: "payment", props: { amount: amount, method: method, doc: updated, preview: false } },
          stampText: st === "paid" ? "Settled!" : "Recorded!",
          committedNote: "<b>" + updated.serial + "</b> → <b>" + (st === "partial" ? "partially paid" : st) + "</b>. Balance " + E.formatINR(Math.max(0, nt.due)) + ".",
        });
      },
      isWrite: true,
    };
  }

  // ---- list_invoices ----------------------------------------------------- //
  async function runList(args, ctx) {
    args = args || {};
    var tl = ctx.text.toLowerCase();
    // We filter by status only (the backend holds all dates), so the copy below
    // reflects exactly that — no invented "this quarter" period.
    var filter = "unpaid";
    if (args.status) { filter = args.status; }
    else if (/overdue/.test(tl)) { filter = "overdue"; }
    else if (/unpaid|outstanding|pending|not paid|\bdue\b/.test(tl)) { filter = "unpaid"; }
    else if (/\bpaid\b/.test(tl)) { filter = "paid"; }
    else if (/\ball\b|every|each/.test(tl)) { filter = "all"; }
    var title = { all: "All invoices", unpaid: "Unpaid invoices", paid: "Paid invoices", overdue: "Overdue invoices" }[filter] || "Invoices";
    var all;
    try { all = await E.listInvoices(); ctx.setDocs(all); }
    catch (e) { return clarify("I couldn't reach the Swipe API to list invoices — is the mock backend running? (" + e.message + ")"); }
    var docs = all.filter(function (d) {
      var s = E.docStatus(d);
      if (s === "cancelled") return filter === "all";
      if (filter === "unpaid") return s !== "paid";
      if (filter === "overdue") return s === "overdue";
      if (filter === "paid") return s === "paid";
      return true;
    }).sort(function (a, b) { return (a.date || "").localeCompare(b.date || ""); });
    var label = filter === "all" ? "" : filter + " ";
    return {
      intro: "Here " + (docs.length === 1 ? "is" : "are") + " the <b>" + docs.length + "</b> " + label + "invoice" + (docs.length === 1 ? "" : "s") + " I found:",
      trace: [
        { tool: "search_documents", label: "Filter: status=" + filter + " (all dates)" },
        { tool: "search_documents", label: "Returned <b>" + docs.length + "</b> of " + all.length + " document" + (all.length === 1 ? "" : "s") },
      ],
      card: { type: "list", props: { title: title, sub: docs.length + " of " + all.length + " invoices", docs: docs } },
      isWrite: false,
    };
  }

  // ---- customer_outstanding --------------------------------------------- //
  async function runOutstanding(args, ctx) {
    args = args || {};
    var text = ctx.text;
    var customer = args.customer_id ? E.findCustomerById(args.customer_id) : null;
    if (!customer && args.customer_name) customer = E.findCustomer(args.customer_name);
    if (!customer) customer = E.findCustomer(text);
    if (!customer) return clarify("Whose outstanding balance — e.g. Globex Corporation, Initech Solutions, Umbrella Retail?");
    var led, docs;
    try {
      led = await E.ledger(customer.id);
      docs = (await E.listInvoices()).filter(function (d) { return d.customerId === customer.id; });
    } catch (e) {
      return clarify("I couldn't reach the Swipe API for the ledger — is the mock backend running? (" + e.message + ")");
    }
    var outstanding = led.outstanding;
    var openCount = docs.filter(function (d) { var s = E.docStatus(d); return s !== "paid" && s !== "cancelled"; }).length;
    return {
      intro: "<b>" + customer.name + "</b> owes you <b>" + E.formatINR(outstanding) + "</b> across " + openCount + " open invoice" + (openCount === 1 ? "" : "s") + ". Here's the ledger:",
      trace: [
        { tool: "resolve_customer", label: "Matched <b>" + customer.name + "</b>" },
        { tool: "get_ledger", label: "Aggregated " + led.entries.length + " entr" + (led.entries.length === 1 ? "y" : "ies") + " → balance <b>" + E.formatINR(outstanding) + "</b>" },
      ],
      card: { type: "ledger", props: { customer: customer, entries: led.entries, outstanding: outstanding } },
      isWrite: false,
    };
  }

  // ---- lookup_gstin ------------------------------------------------------ //
  async function runGstin(args, ctx) {
    args = args || {};
    var text = ctx.text;
    var cust = E.findCustomer(text);
    var g = args.gstin || (cust && cust.gstin) || (text.match(E.GSTIN_RE) || [])[1];
    if (g) g = g.toUpperCase();
    if (!g || g.length !== 15) {
      return clarify("Which GSTIN should I look up? Paste a 15-character GSTIN, or name a customer like Globex.");
    }
    var data;
    try { data = await E.lookupGstin(g); }
    catch (e) { return clarify("That GSTIN lookup failed — is the mock backend running? (" + e.message + ")"); }
    return {
      intro: "Looked that up against the GST registry:",
      trace: [{ tool: "lookup_gstin", label: data.gstin + " → <b>" + data.legal + "</b> · " + data.state + " · " + data.status }],
      card: { type: "gstin", props: { data: data } },
      isWrite: false,
    };
  }

  // ---- list_customers / list_products ----------------------------------- //
  async function runListCustomers() {
    var custs = E.CUSTOMERS;
    try { await E.reconnect(); custs = E.CUSTOMERS; } catch (e) { /* use cached */ }
    return {
      intro: "You have <b>" + custs.length + "</b> customer" + (custs.length === 1 ? "" : "s") + " on file:",
      trace: [{ tool: "list_customers", label: "Fetched <b>" + custs.length + "</b> customer" + (custs.length === 1 ? "" : "s") }],
      card: { type: "customers", props: { customers: custs.map(function (c) { return Object.assign({}, c); }) } },
      isWrite: false,
    };
  }

  function runListProducts() {
    var prods = E.PRODUCTS;
    return {
      intro: "Here " + (prods.length === 1 ? "is" : "are") + " the <b>" + prods.length + "</b> item" + (prods.length === 1 ? "" : "s") + " in your catalog:",
      trace: [{ tool: "list_products", label: "Fetched <b>" + prods.length + "</b> product" + (prods.length === 1 ? "" : "s") }],
      card: { type: "products", props: { products: prods.map(function (p) { return Object.assign({}, p); }) } },
      isWrite: false,
    };
  }

  // ---- LLM tool schemas (the only copy; engine.js reads these) ----------- //
  var ITEM_SCHEMA = {
    type: "object",
    properties: {
      item_id: { type: "string", description: "Catalog item id if it matches one." },
      name: { type: "string" },
      quantity: { type: "number" },
      unit_price: { type: "number", description: "Per-unit price excluding tax." },
      tax_rate: { type: "number", description: "GST % (e.g. 18). Default 18 if unstated." },
      cess_rate: { type: "number" },
      discount_percent: { type: "number" },
      item_type: { type: "string", enum: ["Product", "Service"] },
    },
    required: ["name", "quantity", "unit_price", "tax_rate"],
  };

  function fn(name, description, parameters) {
    return { type: "function", function: { name: name, description: description, parameters: parameters } };
  }

  // ---- the registry: name → { schema?, run, alias? } -------------------- //
  var TOOLS = {
    create_invoice: {
      run: runCreate,
      schema: fn("create_invoice",
        "Compose an invoice for a customer. Resolve the customer to an id from the catalog. One entry per line item; unit_price is per-unit and TAX-EXCLUSIVE.",
        {
          type: "object",
          properties: {
            customer_id: { type: "string", description: "Customer id from the catalog (e.g. CUST002)." },
            customer_name: { type: "string", description: "Customer name if no id matches (a new party)." },
            items: { type: "array", items: ITEM_SCHEMA },
            due_days: { type: "number", description: "Days until due (default 30)." },
          },
          required: ["items"],
        }),
    },
    record_payment: {
      run: runPayment,
      schema: fn("record_payment",
        "Record a payment against an invoice. 'document_ref' can be an invoice serial (INV-12) or 'last' for the most recent.",
        {
          type: "object",
          properties: {
            amount: { type: "number" },
            method: { type: "string", enum: ["upi", "cash", "card", "cheque", "emi", "netBanking"] },
            document_ref: { type: "string" },
          },
          required: ["amount"],
        }),
    },
    list_invoices: {
      run: runList,
      schema: fn("list_invoices", "List/search invoices by payment status.",
        { type: "object", properties: { status: { type: "string", enum: ["all", "unpaid", "paid", "overdue"] } } }),
    },
    customer_outstanding: {
      run: runOutstanding,
      schema: fn("customer_outstanding", "Show a customer's outstanding balance and ledger.",
        { type: "object", properties: { customer_id: { type: "string" }, customer_name: { type: "string" } } }),
    },
    lookup_gstin: {
      run: runGstin,
      schema: fn("lookup_gstin", "Look up / validate a 15-character GSTIN against the GST registry.",
        { type: "object", properties: { gstin: { type: "string" } }, required: ["gstin"] }),
    },
    list_customers: {
      run: runListCustomers,
      schema: fn("list_customers", "List all customers on the account.", { type: "object", properties: {} }),
    },
    list_products: {
      run: runListProducts,
      schema: fn("list_products", "List all products/items in the catalog.", { type: "object", properties: {} }),
    },
    reply: {
      run: function (args) { return message((args || {}).message); },
      schema: fn("reply", "Answer a greeting, a general question, or explain what you can do — when no other tool fits.",
        { type: "object", properties: { message: { type: "string" } }, required: ["message"] }),
    },
    // Handlers with no LLM schema: edit_draft is reached only via the regex
    // fallback (the LLM amends by re-emitting create_invoice); unknown is the
    // catch-all.
    edit_draft: { run: runEdit },
    unknown: { run: function () { return unknown(); } },
  };

  // Aliases for the regex classifier's intent names → canonical tool names.
  var ALIAS = { gstin_lookup: "lookup_gstin", outstanding: "customer_outstanding" };

  // The LLM's tool list, derived from the registry (single source of truth).
  var SCHEMA_ORDER = ["create_invoice", "record_payment", "list_invoices", "customer_outstanding",
    "lookup_gstin", "list_customers", "list_products", "reply"];
  function schemas() {
    return SCHEMA_ORDER.map(function (n) { return TOOLS[n].schema; });
  }

  function dispatch(tool, args, ctx) {
    var name = ALIAS[tool] || tool;
    var entry = TOOLS[name] || TOOLS.unknown;
    return entry.run(args || {}, ctx);
  }

  window.SwipeTools = { TOOLS: TOOLS, schemas: schemas, dispatch: dispatch, clarify: clarify };
})();
