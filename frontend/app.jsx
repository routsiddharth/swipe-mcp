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

// Once the user has made a connection choice (entered a live key, or dismissed
// the panel to use the mock), don't auto-open the Connection panel again.
const isOnboarded = () => { try { return localStorage.getItem("swipe_onboarded") === "1"; } catch (e) { return false; } };
const markOnboarded = () => { try { localStorage.setItem("swipe_onboarded", "1"); } catch (e) {} };

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#2d5bff",
  "cardStyle": "playful",
  "traceDetail": "compact",
  "dark": false
}/*EDITMODE-END*/;

// ---- Connection settings (mock ↔ live, API key) ------------------------- //
// Lets the user paste their real Swipe API key and switch the agent from the
// local mock to their live Swipe account. Live calls go straight to
// app.getswipe.in from the browser (it sends permissive CORS) — no proxy.
function ConnectionModal({ onClose, onApplied }) {
  const [mode, setMode] = useState(E.mode || "mock");
  // Mock backend URL is fixed (config.js / env via E.backend) — not user-editable.
  const backend = E.backend || "http://127.0.0.1:8000";
  // Pre-fill only from a key the user previously entered+validated on this
  // device (localStorage). Never from config.js / env — nothing is imported.
  const [token, setToken] = useState(() => { try { return localStorage.getItem("swipe_api_token") || ""; } catch (e) { return ""; } });
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState(null); // {busy,msg}|{ok,msg}|{err,msg}

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function apply() {
    if (mode === "live") {
      const tok = token.trim();
      if (!tok) { setStatus({ err: true, msg: "Enter your Swipe API key." }); return; }
      // Validate with the minimum possible call BEFORE switching to live.
      setStatus({ busy: true, msg: "Validating key…" });
      const v = await E.validateLiveKey(tok);
      if (!v.ok) { setStatus({ err: true, msg: "Error: " + v.error }); return; }
      // Valid → persist the key (localStorage) and connect live.
      const ok = await E.configure({ mode: "live", token: tok });
      markOnboarded();
      if (ok) {
        setStatus({ ok: true, msg: "Connected to your live Swipe account." });
        onApplied();
        setTimeout(onClose, 900);
      } else {
        setStatus({ err: true, msg: "Error: " + (E.lastError || "Key is valid but the account data couldn't be loaded.") });
      }
    } else {
      setStatus({ busy: true, msg: "Connecting…" });
      const ok = await E.configure({ mode: "mock", backend: backend.trim() });
      markOnboarded();
      if (ok) {
        setStatus({ ok: true, msg: "Connected to the local mock backend." });
        onApplied();
        setTimeout(onClose, 700);
      } else {
        setStatus({ err: true, msg: E.lastError || "Couldn't reach the mock backend — is it running?" });
      }
    }
  }

  return (
    <div className="cfg-overlay" onMouseDown={onClose}>
      <div className="cfg-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Connection settings">
        <div className="cfg-head">
          <b>Connection</b>
          <button className="cfg-x" aria-label="Close" onClick={onClose}>✕</button>
        </div>

        <div className="cfg-label">Talk to</div>
        <div className="cfg-seg" role="radiogroup">
          {[["mock", "Mock backend"], ["live", "Live Swipe account"]].map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={mode === v}
              className={mode === v ? "on" : ""} onClick={() => { setMode(v); setStatus(null); }}>
              {label}
            </button>
          ))}
        </div>
        <p className="cfg-hint">
          {mode === "live"
            ? "Drives your real Swipe account at app.getswipe.in directly. Writes (invoices, payments) are real."
            : "Hosted FastAPI mock — no key needed, sample data only. Best for the demo."}
        </p>

        {mode === "live" && (
          <>
            <div className="cfg-label">Swipe API key</div>
            <div className="cfg-key">
              <input className="cfg-field" type={showKey ? "text" : "password"}
                value={token} placeholder="eyJhbGciOiJI…  (from Swipe → API Integration)"
                autoComplete="off" spellCheck={false}
                onChange={(e) => { setToken(e.target.value); setStatus(null); }} />
              <button type="button" className="btn ghost cfg-eye" onClick={() => setShowKey((s) => !s)}>
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
          </>
        )}

        {status && (status.ok || status.err) && (
          <div className={"cfg-note " + (status.ok ? "ok" : "err")}>{status.msg}</div>
        )}

        <div className="cfg-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={apply} disabled={status && status.busy}>
            {status && status.busy ? "Connecting…" : "Save & connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Shown when, mid-degraded-session, a probe finds the live Swipe API back after
// a daily-limit lapse. The user picks: reconnect on a fresh chat, or stay here
// on the mock. (Closing via the backdrop = stay on mock, the non-destructive
// choice — it won't blow away the current conversation.)
function LimitResetModal({ onNewLive, onStayMock }) {
  return (
    <div className="cfg-overlay" onMouseDown={onStayMock}>
      <div className="cfg-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Live API available">
        <div className="cfg-head">
          <b>Live API is back</b>
          <button className="cfg-x" aria-label="Close" onClick={onStayMock}>✕</button>
        </div>
        <p className="cfg-hint">
          Your Swipe API limit has reset — the real account is responding again. This chat has been
          running on the offline mock, so its data is sample data.
        </p>
        <div className="cfg-stack">
          <button className="btn primary" onClick={onNewLive}>Start a new chat on the live API</button>
          <button className="btn ghost" onClick={onStayMock}>Keep this chat on the mock</button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  // local cache of documents (sourced from + written through to the backend)
  const docsRef = useRef(E.SEED_DOCS.map((d) => ({ ...d })));
  const [online, setOnline] = useState(E.online);
  const [mode, setMode] = useState(E.mode);          // user's intent: "live" | "mock"
  const [degraded, setDegraded] = useState(E.degraded); // live intended, on mock (limit)
  // Open the Connection panel on the very first visit (no prior choice). X-ing
  // out leaves the app on the key-free mock (markOnboarded stops the re-nag).
  const [cfgOpen, setCfgOpen] = useState(() => !isOnboarded());
  const [resetOpen, setResetOpen] = useState(false);  // "live API is back" prompt
  const closeCfg = () => { markOnboarded(); setCfgOpen(false); };
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const draftRef = useRef(null);       // { customer, lines, dueDays, dueDate, msgId }
  const lastDocRef = useRef(null);     // most recently touched document
  const streamRef = useRef(null);
  const lastAgentRef = useRef(null);
  const commitsRef = useRef({});       // msgId -> onCommit; consumed once (idempotent confirm)
  const busyRef = useRef(false);       // mirror of `busy` for event handlers (stale-closure-safe)
  const pendingResetRef = useRef(false); // a live-reset prompt deferred until the turn settles

  // Keep busyRef in sync, and flush a deferred live-reset prompt once idle, so
  // the reconnect modal never pops mid-stream (it can wipe an in-flight turn).
  useEffect(() => {
    busyRef.current = busy;
    if (!busy && pendingResetRef.current) { pendingResetRef.current = false; setResetOpen(true); }
  }, [busy]);

  // ---- theme / tweaks application --------------------------------------
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", t.dark ? "dark" : "light");
  }, [t.dark]);

  const scrollDown = () => {
    const el = streamRef.current;
    if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  };
  useEffect(scrollDown, [messages]);

  // ---- connection-state sync -------------------------------------------
  // The engine fires "swipe:mode" when the effective connection changes — most
  // notably when a live call hits the daily limit and it silently degrades to
  // the mock. We just resync the small header indicator + document cache; no
  // banner, no chat spam (the user shouldn't see the per-call live attempts).
  useEffect(() => {
    function onModeChange() {
      setOnline(E.online);
      setMode(E.mode);
      setDegraded(!!E.degraded);
      docsRef.current = E.SEED_DOCS.map((x) => ({ ...x }));
      if (E.online) setBannerDismissed(false); // a fresh outage re-shows the banner
    }
    window.addEventListener("swipe:mode", onModeChange);
    return () => window.removeEventListener("swipe:mode", onModeChange);
  }, []);

  // "swipe:livereset" fires when a per-message probe finds the real API back
  // after a limit. Offer to reconnect (new chat) or stay on the mock — but if a
  // turn is mid-stream, defer the prompt until it settles (the busy effect above
  // flushes it), so accepting can't tear down an in-flight conversation.
  useEffect(() => {
    function onLiveReset() {
      if (busyRef.current) pendingResetRef.current = true;
      else setResetOpen(true);
    }
    window.addEventListener("swipe:livereset", onLiveReset);
    return () => window.removeEventListener("swipe:livereset", onLiveReset);
  }, []);

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
  // Build the per-turn context the tool registry needs, route the message to a
  // tool (the LLM when a key is set, else the regex classifier), and dispatch.
  // ALL tool logic — schema, handler, trace — lives in window.SwipeTools
  // (tools.js). This component only orchestrates the turn and renders.
  function turnCtx(text) {
    return {
      text,
      draft: draftRef.current,
      history: messages.slice(-6)
        .map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: (m.text || "").replace(/<[^>]+>/g, "").trim() }))
        .filter((h) => h.text),
      getDraft: () => draftRef.current,
      setDraft: (d) => { draftRef.current = d; },
      getDocs: () => docsRef.current,
      setDocs: (d) => { docsRef.current = d; },
      getLastDoc: () => lastDocRef.current,
      setLastDoc: (d) => { lastDocRef.current = d; },
      patch,
    };
  }

  async function planFor(text) {
    const ctx = turnCtx(text);
    let route = null;
    if (E.llmEnabled) {
      try { route = await E.llmPlan(text, ctx); }
      catch (e) { console.warn("LLM planning failed, using regex fallback:", e); }
    }
    if (!route) {
      const { intent, gstin } = E.classify(text, ctx);
      route = { tool: intent, args: { gstin } };
    }
    return await window.SwipeTools.dispatch(route.tool, route.args || {}, ctx);
  }

  // ---- run one turn -----------------------------------------------------
  async function runTurn(text) {
    let plan;
    try { plan = await planFor(text); }
    catch (e) {
      console.error("Planning failed:", e);
      plan = window.SwipeTools.clarify("Sorry — I couldn't work that one out. Try rephrasing, e.g. “invoice Acme ₹50,000 for consulting, 18% GST”.");
    }
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
    // While degraded, silently re-probe the real API (it may have reset). Fire
    // and forget — the turn proceeds on the mock; if live is back, the engine
    // raises "swipe:livereset" and we prompt to reconnect.
    E.maybeProbeLive();
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
    setBannerDismissed(false);
    const ok = await E.reconnect();
    setOnline(ok);
    setMode(E.mode);
    setDegraded(!!E.degraded);
    if (ok) docsRef.current = E.SEED_DOCS.map((d) => ({ ...d }));
  }

  // After the Connection panel saves new settings + re-boots the engine, sync
  // the UI to the new target: status, mode, the document cache, and any draft.
  function onConnectionApplied() {
    setOnline(E.online);
    setMode(E.mode);
    setDegraded(!!E.degraded);
    setBannerDismissed(false);
    docsRef.current = E.SEED_DOCS.map((d) => ({ ...d }));
    draftRef.current = null;
    lastDocRef.current = null;
  }

  // Live API recovered: (a) reconnect on a fresh chat, or (b) stay on the mock.
  async function acceptLive() {
    setResetOpen(false);
    const ok = await E.resumeLive();
    setOnline(E.online);
    setMode(E.mode);
    setDegraded(!!E.degraded);
    // Only start a clean live chat if the reconnect actually succeeded — if the
    // boot failed (live flaked right after the probe), keep the current chat
    // rather than wiping a recoverable conversation into an offline session.
    if (ok) {
      setMessages([]);
      draftRef.current = null;
      lastDocRef.current = null;
      docsRef.current = E.SEED_DOCS.map((d) => ({ ...d }));
    }
  }
  function declineLive() {
    E.stayOnMock();
    setResetOpen(false);
    setDegraded(!!E.degraded);
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
        {!online
          ? <span className="pill offline" onClick={retryConnect} title="Click to retry">Backend offline</span>
          : (mode === "live" && !degraded)
            ? <span className="pill live" onClick={() => setCfgOpen(true)} style={{ cursor: "pointer" }}
                    title="Connected to your live Swipe account. Click to change.">
                <span className="dot" /> Live API
              </span>
            : <span className="pill mock" onClick={() => setCfgOpen(true)} style={{ cursor: "pointer" }}
                    title={degraded
                      ? "Live daily limit reached — running on the mock. Click to reconnect when it resets."
                      : "Talking to the offline mock backend. Click to connect a live Swipe key."}>
                <span className="dot" /> Mock Backend
              </span>}
        <span className="spacer" />
        <button className="btn ghost icon" onClick={() => setCfgOpen(true)} title="Connection / API key" aria-label="Connection settings">
          <Ic d={["M12 15a3 3 0 100-6 3 3 0 000 6z", "M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"]} size={17} sw={2} />
        </button>
        <button className={"btn " + (demoOn ? "" : "primary")} onClick={runDemo}>
          {demoOn ? <><Ic d={["M7 6h3v12H7zM14 6h3v12h-3z"]} size={15} sw={0} fill="currentColor" /> Stop demo</>
                  : <><Ic d={["M7 5l11 7-11 7z"]} size={15} sw={0} fill="currentColor" /> Auto-demo</>}
        </button>
      </header>
      {cfgOpen && <ConnectionModal onClose={closeCfg} onApplied={onConnectionApplied} />}

      <div className="stream-wrap" ref={streamRef}>
        {!online && !bannerDismissed && (
          <div className="offline-banner">
            <span>⚠ Can't reach the backend at <code>{E.apiBase}</code>.{" "}
            Start it (<code>uvicorn mock_backend.main:app</code>), then</span>
            <button className="btn" onClick={() => setCfgOpen(true)}>Connection</button>
            <button className="btn" onClick={retryConnect}>Retry</button>
            <button className="banner-x" onClick={() => setBannerDismissed(true)} aria-label="Dismiss">✕</button>
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
      {resetOpen && <LimitResetModal onNewLive={acceptLive} onStayMock={declineLive} />}

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
