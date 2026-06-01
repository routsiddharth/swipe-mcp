/* ============================================================================
   Swipe Agent — App orchestration
   Turns natural language into: streamed reply + MCP tool trace + result card,
   with confirm-on-write and multi-turn draft editing. Deterministic + offline.
============================================================================ */
const { useState, useRef, useEffect } = React;
const E = window.SwipeEngine;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let UID = 0;
const uid = () => "m" + ++UID;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#2d5bff",
  "cardStyle": "playful",
  "traceDetail": "compact",
  "dark": false
}/*EDITMODE-END*/;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  // local cache of documents (sourced from + written through to the backend)
  const docsRef = useRef(E.SEED_DOCS.map((d) => ({ ...d })));
  const [online, setOnline] = useState(E.online);
  const draftRef = useRef(null);       // { customer, lines, dueDays, dueDate, msgId }
  const lastDocRef = useRef(null);     // most recently touched document
  const streamRef = useRef(null);
  const lastAgentRef = useRef(null);
  const commitsRef = useRef({});       // msgId -> onCommit; consumed once (idempotent confirm)

  // ---- theme / tweaks application --------------------------------------
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", t.dark ? "dark" : "light");
  }, [t.dark]);

  const scrollDown = () => {
    const el = streamRef.current;
    if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  };
  useEffect(scrollDown, [messages]);

  // ---- message helpers --------------------------------------------------
  const patch = (id, p) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...(typeof p === "function" ? p(m) : p) } : m)));

  async function streamText(id, full, speed = 16) {
    const words = full.split(" ");
    let acc = "";
    for (let i = 0; i < words.length; i++) {
      acc += (i ? " " : "") + words[i];
      patch(id, { text: acc });
      scrollDown();
      await sleep(speed + Math.random() * 22);
    }
  }

  async function revealTrace(id, steps) {
    patch(id, { trace: steps, shownTrace: 0, tracePhaseDone: false, traceCollapsed: false });
    for (let i = 0; i < steps.length; i++) {
      patch(id, { shownTrace: i + 1 });
      scrollDown();
      await sleep(420 + Math.random() * 260);
    }
    patch(id, { tracePhaseDone: true, traceCollapsed: t.traceDetail === "compact" });
  }

  // ---- intent → plan ----------------------------------------------------
  async function planFor(text) {
    const ctx = { draft: draftRef.current };
    const { intent, gstin } = E.classify(text, ctx);
    switch (intent) {
      case "create_invoice": return planCreate(text);
      case "edit_draft": return planEdit(text);
      case "record_payment": return planPayment(text);
      case "list_invoices": return await planList(text);
      case "outstanding": return await planOutstanding(text);
      case "gstin_lookup": return await planGstin(text, gstin);
      default: return planUnknown(text);
    }
  }

  function planCreate(text) {
    const customer = E.findCustomer(text);
    const amount = E.parseAmount(text);
    if (!customer) return planClarify("Which customer is this for? I can bill " +
      E.CUSTOMERS.map((c) => c.name).slice(0, 3).join(", ") + " and others.");
    if (!amount) return planClarify(`What amount should I bill ${customer.name}? e.g. “₹50,000”.`);
    const gst = E.parseGst(text);
    const dueDays = E.parseDueDays(text);
    const item = E.describeItem(text);
    const dueDate = E.addDays(E.TODAY, dueDays);
    const lines = [{ id: item.id, name: item.name, item_type: item.item_type, qty: 1, rate: amount, gst, unit: item.unit || "", hsn: item.hsn || "" }];
    const inv = E.computeInvoice(lines, customer);
    const draft = { customer, lines, dueDays, dueDate };
    return {
      intro: `Got it — composing an invoice for <b>${customer.name}</b>. Here's the GST worked out <i>before</i> I create anything:`,
      trace: [
        { tool: "resolve_customer", label: `Matched <b>${customer.name}</b> · GSTIN ${customer.gstin}` },
        { tool: "get_tax_profile", label: `Place of supply <b>${customer.state} (${customer.stateCode})</b> → ${inv.intra ? "intra-state" : "inter-state"}` },
        { tool: "compute_gst", label: `${gst}% on ${E.formatINR(inv.net)} = <b>${E.formatINR(inv.tax)}</b> ${inv.intra ? "(CGST + SGST)" : "(IGST)"}` },
        { tool: "compose_document", label: `Drafted invoice · grand total <b>${E.formatINR(inv.grand)}</b>` },
      ],
      card: { type: "invoice", props: { inv, customer, meta: { dueDate }, status: "draft" } },
      confirm: { question: `Create this invoice for ${customer.name}?`, confirmLabel: "Create invoice" },
      onCommit: async (id) => {
        const res = await E.createInvoice(draft);
        docsRef.current = await E.refreshDocs();
        lastDocRef.current = docsRef.current.find((d) => d.hash_id === res.hash_id) || lastDocRef.current;
        draftRef.current = null;
        patch(id, {
          card: { type: "invoice", props: { inv: res.inv, customer, meta: { dueDate }, status: "pending", serial: res.serial } },
          stampText: "Created!",
          committedNote: `<b>${res.serial}</b> is live · ${E.formatINR(res.inv.grand)} · pending. Ready to share over <b>WhatsApp</b>, email or SMS.`,
        });
      },
      draft,
      isWrite: true,
    };
  }

  function planEdit(text) {
    const draft = draftRef.current;
    if (!draft) return planUnknown(text);
    let changeNote = "Updated";
    // GST change
    const gstM = text.match(/(\d+(?:\.\d+)?)\s*%/);
    if (gstM && /gst|tax|%/.test(text.toLowerCase())) {
      const g = parseFloat(gstM[1]);
      draft.lines.forEach((l) => (l.gst = g));
      changeNote = `Switched GST to ${g}%`;
    }
    // add item: "add 10 safety gloves"
    const addM = text.match(/add\s+(\d+)\s+([a-z][a-z &\-]+)/i);
    if (addM) {
      const qty = parseInt(addM[1], 10);
      const name = addM[2].trim().toLowerCase();
      const prod = E.PRODUCTS.find((p) => name.includes(p.name.toLowerCase().split(" ")[0]) || p.name.toLowerCase().includes(name.split(" ")[0]));
      const p = prod || { name: addM[2].trim().replace(/\b\w/g, (c) => c.toUpperCase()), rate: 100, gst: draft.lines[0].gst, unit: "pcs", hsn: "0000" };
      draft.lines.push({ name: p.name, qty, rate: p.rate, gst: p.gst, unit: p.unit, hsn: p.hsn });
      changeNote = `Added ${qty} × ${p.name}`;
    }
    // amount change: "make it ₹X" — but not when a "%" is present (that's a GST
    // change, handled above) so "make it 28% GST" doesn't set the rate to 28.
    const amt = (/make it|change.*to|set.*to/.test(text.toLowerCase()) && !gstM) ? E.parseAmount(text) : null;
    if (amt && !addM) { draft.lines[0].rate = amt; changeNote = `Set amount to ${E.formatINR(amt)}`; }
    // due change
    const dueM = text.match(/due\s+in\s+(\d+)\s*days?/i);
    if (dueM) { draft.dueDays = parseInt(dueM[1], 10); draft.dueDate = E.addDays(E.TODAY, draft.dueDays); changeNote = `Due in ${draft.dueDays} days`; }

    const inv = E.computeInvoice(draft.lines, draft.customer);
    // clear the previous draft's confirm bar
    if (draft.msgId) patch(draft.msgId, { confirm: null, cancelled: false, supersededNote: true });
    return {
      intro: `${changeNote} — here's the recalculated invoice:`,
      trace: [
        { tool: "edit_document", label: changeNote },
        { tool: "compute_gst", label: `New tax <b>${E.formatINR(inv.tax)}</b> · grand total <b>${E.formatINR(inv.grand)}</b>` },
      ],
      card: { type: "invoice", props: { inv, customer: draft.customer, meta: { dueDate: draft.dueDate }, status: "draft" } },
      confirm: { question: `Create this updated invoice for ${draft.customer.name}?`, confirmLabel: "Create invoice" },
      onCommit: async (id) => {
        const res = await E.createInvoice(draft);
        docsRef.current = await E.refreshDocs();
        lastDocRef.current = docsRef.current.find((d) => d.hash_id === res.hash_id) || lastDocRef.current;
        draftRef.current = null;
        patch(id, {
          card: { type: "invoice", props: { inv: res.inv, customer: draft.customer, meta: { dueDate: draft.dueDate }, status: "pending", serial: res.serial } },
          stampText: "Created!",
          committedNote: `<b>${res.serial}</b> created · ${E.formatINR(res.inv.grand)}.`,
        });
      },
      draft,
      isWrite: true,
    };
  }

  function resolveTargetDoc(text) {
    const serialM = text.match(/inv[-\s]?0?(\d{1,4})/i);
    if (serialM) {
      const d = docsRef.current.find((x) => x.serial.replace(/\D/g, "") === serialM[1].padStart(3, "0") || x.serial.toLowerCase().includes(serialM[1]));
      if (d) return d;
    }
    if (/\b(it|that|this|the invoice|above)\b/i.test(text) && lastDocRef.current) return lastDocRef.current;
    const cust = E.findCustomer(text);
    if (cust) {
      const open = docsRef.current.filter((d) => d.customerId === cust.id && E.docStatus(d) !== "paid");
      if (open.length) return open[open.length - 1];
    }
    return lastDocRef.current;
  }

  function planPayment(text) {
    const amount = E.parseAmount(text);
    const method = E.parseMethod(text);
    const doc = resolveTargetDoc(text);
    if (!doc) return planClarify("Which invoice should I record the payment against? Create one first or name a serial like INV-008.");
    if (!amount) return planClarify(`How much was paid against ${doc.serial}?`);
    const t0 = E.docTotals(doc);
    return {
      intro: `Recording a <b>${E.formatINR(amount)}</b> ${method} payment against <b>${doc.serial}</b> (${t0.customer.name}).`,
      trace: [
        { tool: "find_document", label: `Located <b>${doc.serial}</b> · ${E.formatINR(t0.grand)} · ${E.docStatus(doc)}` },
        { tool: "validate_payment", label: `${E.formatINR(amount)} ≤ balance ${E.formatINR(t0.due)} ✓` },
        { tool: "compose_receipt", label: `Prepared ${method} receipt` },
      ],
      card: { type: "payment", props: { amount, method, doc, preview: true } },
      confirm: { question: `Record ${E.formatINR(amount)} against ${doc.serial}?`, confirmLabel: "Record payment" },
      onCommit: async (id) => {
        await E.recordPayment({ doc, amount, method });
        docsRef.current = await E.refreshDocs();
        const updated = docsRef.current.find((d) => d.hash_id === doc.hash_id) || doc;
        lastDocRef.current = updated;
        const st = E.docStatus(updated);
        const nt = E.docTotals(updated);
        patch(id, {
          card: { type: "payment", props: { amount, method, doc: updated, preview: false } },
          stampText: st === "paid" ? "Settled!" : "Recorded!",
          committedNote: `<b>${updated.serial}</b> → <b>${st === "partial" ? "partially paid" : st}</b>. Balance ${E.formatINR(Math.max(0, nt.due))}.`,
        });
      },
      isWrite: true,
    };
  }

  async function planList(text) {
    const tl = text.toLowerCase();
    // We filter by status only (the backend holds all dates), so the copy below
    // reflects exactly that — no invented "this quarter" period.
    let filter = "unpaid", title = "Unpaid invoices";
    if (/overdue/.test(tl)) { filter = "overdue"; title = "Overdue invoices"; }
    else if (/unpaid|outstanding|pending|not paid|\bdue\b/.test(tl)) { filter = "unpaid"; title = "Unpaid invoices"; }
    else if (/\bpaid\b/.test(tl)) { filter = "paid"; title = "Paid invoices"; }
    else if (/\ball\b|every|each/.test(tl)) { filter = "all"; title = "All invoices"; }
    let all;
    try { all = await E.listInvoices(); docsRef.current = all; }
    catch (e) { return planClarify(`I couldn't reach the Swipe API to list invoices — is the mock backend running? (${e.message})`); }
    const docs = all.filter((d) => {
      const s = E.docStatus(d);
      if (s === "cancelled") return filter === "all";
      if (filter === "unpaid") return s !== "paid";
      if (filter === "overdue") return s === "overdue";
      if (filter === "paid") return s === "paid";
      return true;
    }).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const label = filter === "all" ? "" : filter + " ";
    return {
      intro: `Here ${docs.length === 1 ? "is" : "are"} the <b>${docs.length}</b> ${label}invoice${docs.length === 1 ? "" : "s"} I found:`,
      trace: [
        { tool: "search_documents", label: `Filter: status=${filter} (all dates)` },
        { tool: "search_documents", label: `Returned <b>${docs.length}</b> of ${all.length} document${all.length === 1 ? "" : "s"}` },
      ],
      card: { type: "list", props: { title, sub: `${docs.length} of ${all.length} invoices`, docs } },
      isWrite: false,
    };
  }

  async function planOutstanding(text) {
    const customer = E.findCustomer(text);
    if (!customer) return planClarify("Whose outstanding balance — e.g. Globex Corporation, Initech Solutions, Umbrella Retail?");
    let led, docs;
    try {
      led = await E.ledger(customer.id);
      docs = (await E.listInvoices()).filter((d) => d.customerId === customer.id);
    } catch (e) {
      return planClarify(`I couldn't reach the Swipe API for the ledger — is the mock backend running? (${e.message})`);
    }
    const outstanding = led.outstanding;
    const openCount = docs.filter((d) => { const s = E.docStatus(d); return s !== "paid" && s !== "cancelled"; }).length;
    return {
      intro: `<b>${customer.name}</b> owes you <b>${E.formatINR(outstanding)}</b> across ${openCount} open invoice${openCount === 1 ? "" : "s"}. Here's the ledger:`,
      trace: [
        { tool: "resolve_customer", label: `Matched <b>${customer.name}</b>` },
        { tool: "get_ledger", label: `Aggregated ${led.entries.length} entr${led.entries.length === 1 ? "y" : "ies"} → balance <b>${E.formatINR(outstanding)}</b>` },
      ],
      card: { type: "ledger", props: { customer, entries: led.entries, outstanding } },
      isWrite: false,
    };
  }

  async function planGstin(text, gstin) {
    const cust = E.findCustomer(text);
    let g = gstin || (cust && cust.gstin) || (text.match(E.GSTIN_RE) || [])[1];
    if (g) g = g.toUpperCase();
    if (!g || g.length !== 15) {
      return planClarify("Which GSTIN should I look up? Paste a 15-character GSTIN, or name a customer like Globex.");
    }
    let data;
    try { data = await E.lookupGstin(g); }
    catch (e) { return planClarify(`That GSTIN lookup failed — is the mock backend running? (${e.message})`); }
    return {
      intro: `Looked that up against the GST registry:`,
      trace: [{ tool: "lookup_gstin", label: `${data.gstin} → <b>${data.legal}</b> · ${data.state} · ${data.status}` }],
      card: { type: "gstin", props: { data } },
      isWrite: false,
    };
  }

  function planClarify(msg) {
    return { intro: msg, trace: [], card: null, isWrite: false };
  }
  function planUnknown() {
    return {
      intro: `I can help you run Swipe in plain English — try:<br>• <b>Create</b> “invoice Acme ₹50,000 for consulting, 18% GST, due in 15 days”<br>• <b>Collect</b> “record a ₹20,000 UPI payment against it”<br>• <b>Read</b> “show unpaid invoices this quarter” · “what's Globex's outstanding balance?”`,
      trace: [], card: null, isWrite: false,
    };
  }

  // ---- run one turn -----------------------------------------------------
  async function runTurn(text) {
    const plan = await planFor(text);
    const id = uid();
    lastAgentRef.current = id;
    setMessages((prev) => [...prev, { id, role: "agent", text: "", streaming: true, trace: [], shownTrace: 0 }]);
    await sleep(280);
    await streamText(id, plan.intro);
    if (plan.trace && plan.trace.length) await revealTrace(id, plan.trace);
    if (plan.card) { patch(id, { card: plan.card }); scrollDown(); await sleep(180); }
    if (plan.isWrite) {
      // keep the write out of render state; remember the confirm bar for retry
      commitsRef.current[id] = { onCommit: plan.onCommit, confirm: plan.confirm };
      patch(id, { confirm: plan.confirm, streaming: false });
      if (plan.draft) { plan.draft.msgId = id; draftRef.current = plan.draft; }
    } else {
      patch(id, { streaming: false });
    }
    scrollDown();
    return id;
  }

  // ---- public actions ---------------------------------------------------
  async function send(text) {
    const q = (text != null ? text : input).trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    setMessages((prev) => [...prev, { id: uid(), role: "user", text: q }]);
    scrollDown();
    await runTurn(q);
    setBusy(false);
  }

  async function confirmMsg(id) {
    // Consume the commit exactly once: a double-tap or the auto-demo racing a
    // manual click can't fire two backend writes for the same message.
    const entry = commitsRef.current[id];
    if (!entry) return;
    delete commitsRef.current[id];
    setBusy(true);
    patch(id, { confirm: { question: "Writing to Swipe…", confirmLabel: "…" }, error: null });
    await sleep(500);
    try {
      await entry.onCommit(id);              // performs the real backend write
      patch(id, { confirm: null, committed: true });
    } catch (e) {
      commitsRef.current[id] = entry;        // restore so the user can retry
      patch(id, { confirm: entry.confirm, committed: false, error: (e && e.message) || "The write failed." });
    }
    scrollDown();
    setBusy(false);
  }

  function cancelMsg(id) {
    delete commitsRef.current[id];
    draftRef.current = null;
    patch(id, { confirm: null, cancelled: true });
  }

  function toggleTrace(id) {
    patch(id, (m) => ({ traceCollapsed: !m.traceCollapsed }));
  }

  // ---- auto demo (golden path) -----------------------------------------
  const [demoOn, setDemoOn] = useState(false);
  const demoAbort = useRef(false);

  async function typeInto(text) {
    setInput("");
    for (let i = 0; i < text.length; i++) {
      if (demoAbort.current) return;
      setInput(text.slice(0, i + 1));
      await sleep(15 + Math.random() * 25);
    }
    await sleep(380);
  }

  async function confirmLatest() {
    const id = lastAgentRef.current;
    if (!id) return;
    await sleep(700);
    if (demoAbort.current) return;
    await confirmMsg(id);
    await sleep(900);
  }

  async function runDemo() {
    if (demoOn) { demoAbort.current = true; setDemoOn(false); return; }
    setMessages([]); draftRef.current = null; lastDocRef.current = null;
    // Reset the backend to its seed so the demo always starts from a clean slate.
    try { docsRef.current = await E.resetBackend(); setOnline(true); }
    catch (e) { console.warn("Demo reset failed; using last-known docs:", e); docsRef.current = E.SEED_DOCS.map((d) => ({ ...d })); }
    demoAbort.current = false; setDemoOn(true);
    const script = [
      { send: window.QUICK[0] }, { confirm: true },
      { send: window.QUICK[1] }, { confirm: true },
      { send: window.QUICK[2] },
      { send: window.QUICK[3] },
    ];
    for (const step of script) {
      if (demoAbort.current) break;
      if (step.send) {
        setBusy(true);
        await typeInto(step.send);
        if (demoAbort.current) break;
        const q = step.send; setInput("");
        setMessages((prev) => [...prev, { id: uid(), role: "user", text: q }]);
        scrollDown();
        await runTurn(q);
        setBusy(false);
        await sleep(650);
      } else if (step.confirm) {
        await confirmLatest();
      }
    }
    demoAbort.current = false; setDemoOn(false); setBusy(false);
  }

  async function retryConnect() {
    const ok = await E.reconnect();
    setOnline(ok);
    if (ok) docsRef.current = E.SEED_DOCS.map((d) => ({ ...d }));
  }

  // ---- render -----------------------------------------------------------
  const empty = messages.length === 0;
  return (
    <div className={"app " + (t.cardStyle === "calm" ? "calm" : "")} style={{ "--accent": t.accent }}>
      <header className="topbar">
        <div className="brand">
          <span className="mark"><SwipeMark /></span>
          <span className="wordmark">swipe</span>
        </div>
        <span className="pill"><span style={{ fontSize: 14 }}>🇮🇳</span> IN</span>
        {online
          ? <span className="pill live"><span className="dot" /> Backend live</span>
          : <span className="pill offline" onClick={retryConnect} title="Click to retry">Backend offline</span>}
        <span className="spacer" />
        <button className={"btn " + (demoOn ? "" : "primary")} onClick={runDemo}>
          {demoOn ? <><Ic d={["M7 6h3v12H7zM14 6h3v12h-3z"]} size={15} sw={0} fill="currentColor" /> Stop demo</>
                  : <><Ic d={["M7 5l11 7-11 7z"]} size={15} sw={0} fill="currentColor" /> Auto-demo</>}
        </button>
      </header>

      <div className="stream-wrap" ref={streamRef}>
        {!online && (
          <div className="offline-banner">
            <span>⚠ Can't reach the Swipe API at <code>{E.apiBase}</code>. Start the mock backend
            (<code>uvicorn mock_backend.main:app</code>), then</span>
            <button className="btn" onClick={retryConnect}>Retry</button>
          </div>
        )}
        {empty ? (
          <EmptyState onPick={(q) => send(q)} />
        ) : (
          <div className="stream">
            {messages.map((m) =>
              m.role === "user"
                ? <UserMessage key={m.id} text={m.text} />
                : <AgentMessage key={m.id} msg={m}
                    onToggleTrace={() => toggleTrace(m.id)}
                    onConfirm={() => confirmMsg(m.id)}
                    onCancel={() => cancelMsg(m.id)} />
            )}
          </div>
        )}
      </div>

      <Composer
        value={input} setValue={setInput}
        onSend={() => send()} busy={busy}
        showQuick={!empty} onPick={(q) => send(q)}
      />

      <TweaksPanel>
        <TweakSection label="Surface" />
        <TweakToggle label="Dark mode" value={t.dark} onChange={(v) => setTweak("dark", v)} />
        <TweakColor label="Accent" value={t.accent}
          options={["#2d5bff", "#6b4eff", "#11a36b", "#e0457b"]}
          onChange={(v) => setTweak("accent", v)} />
        <TweakSection label="Result cards" />
        <TweakRadio label="Style" value={t.cardStyle} options={["playful", "calm"]}
          onChange={(v) => setTweak("cardStyle", v)} />
        <TweakSection label="Agent tool calls" />
        <TweakRadio label="Trace" value={t.traceDetail} options={["compact", "full"]}
          onChange={(v) => setTweak("traceDetail", v)} />
      </TweaksPanel>
    </div>
  );
}

// Wait for the engine to finish loading reference data from the backend (or to
// fail and fall back to offline) before mounting, so the first render has data.
E.ready.then(() => {
  ReactDOM.createRoot(document.getElementById("root")).render(<App />);
});
