// content.js — Kahoot AI Helper v2.0
// Two-phase AI flow: question → numbered options → digit reply
(function () {
  const TAG = "[KH-AI]";
  const MSG_OUT = "KH_AI_QUERY";
  const MSG_IN = "KH_AI_RESULT";
  const MSG_READY = "KH_AI_READY";

  // ─── Inject Puter.js bridge into MAIN world ─────────────────────────────
  (function injectMainWorld() {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("injected.js");
    s.async = false;
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  })();

  // ─── Model lists ─────────────────────────────────────────────────────────
  const OPENROUTER_MODELS = [
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  ];
  const PUTER_MODELS = ["gpt-4o-mini", "gpt-4.1-nano"];
  // Google AI Studio fastest model
  const GOOGLE_MODEL = "gemini-2.0-flash-lite";

  // ─── Defaults ────────────────────────────────────────────────────────────
  const DEFAULTS = {
    enabled: true,
    provider: "google",           // google | openrouter | puter
    puterModel: "gpt-4o-mini",
    openrouterModel: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    openrouterKey: "",
    googleKey: "",
    googleModel: "gemini-2.0-flash-lite",
    display: "dot",
    dotSize: 5,
    prefetch: true,
    debug: false,
  };
  let settings = { ...DEFAULTS };

  // ─── Debug panel ─────────────────────────────────────────────────────────
  function ensureDebugPanel() {
    let el = document.getElementById("kh-ai-debug");
    if (el) return el;
    el = document.createElement("div");
    el.id = "kh-ai-debug";
    el.innerHTML = `<div class="kh-dbg-head"><span>Kahoot AI · debug</span><button class="kh-dbg-clear">⌫</button><button class="kh-dbg-close">×</button></div><div class="kh-dbg-body"></div>`;
    document.body.appendChild(el);
    el.querySelector(".kh-dbg-close").addEventListener("click", () => el.remove());
    el.querySelector(".kh-dbg-clear").addEventListener("click", () => {
      el.querySelector(".kh-dbg-body").innerHTML = "";
    });
    let sx, sy, ox, oy, dragging = false;
    el.querySelector(".kh-dbg-head").addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); ox = r.left; oy = r.top; e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      el.style.left = (ox + e.clientX - sx) + "px";
      el.style.top = (oy + e.clientY - sy) + "px";
      el.style.right = "auto"; el.style.bottom = "auto";
    });
    window.addEventListener("mouseup", () => { dragging = false; });
    return el;
  }
  function removeDebugPanel() { document.getElementById("kh-ai-debug")?.remove(); }
  function pushDebug(level, args) {
    if (!settings.debug) return;
    const el = ensureDebugPanel();
    const body = el.querySelector(".kh-dbg-body");
    const line = document.createElement("div");
    line.className = "kh-dbg-line kh-dbg-" + level;
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    const text = args.map((a) => {
      if (typeof a === "string") return a;
      try { return JSON.stringify(a, null, 0).slice(0, 500); } catch { return String(a); }
    }).join(" ");
    line.textContent = `[${time}] ${text}`;
    body.appendChild(line);
    while (body.childNodes.length > 300) body.removeChild(body.firstChild);
    body.scrollTop = body.scrollHeight;
  }
  const dlog = (...a) => { if (!settings.debug) return; try { console.log(TAG, ...a); } catch {} pushDebug("info", a); };
  const derr = (...a) => { if (!settings.debug) return; try { console.warn(TAG, ...a); } catch {} pushDebug("err", a); };

  // ─── Settings load/watch ─────────────────────────────────────────────────
  chrome.storage.local.get(Object.keys(DEFAULTS), (v) => {
    settings = { ...DEFAULTS, ...v };
    if (settings.debug) ensureDebugPanel();
    dlog("settings loaded", settings);
  });
  chrome.storage.onChanged.addListener((c) => {
    for (const k of Object.keys(c)) settings[k] = c[k].newValue;
    if (settings.display !== "floating") document.getElementById("kh-ai-float")?.remove();
    if (settings.debug) ensureDebugPanel(); else removeDebugPanel();
    clearMarks(); lastSig = ""; lastQSig = ""; prefetchedQ = null; busy = false; abortAll();
    dlog("settings changed", settings);
  });

  // ─── DOM scraping ────────────────────────────────────────────────────────
  const QUESTION_SELECTORS = [
    '[data-functional-selector="block-title"]',
    '[data-functional-selector="question-title"]',
    'h1[class*="question"]',
    "main h1",
    "h1",
  ];

  // Strict selectors — in priority order; try all, union results
  const ANSWER_SELECTORS_STRICT = [
    '[data-functional-selector^="answer-"]',
    'button[data-functional-selector^="answer-"]',
    '[data-functional-selector^="choice-"]',
    'button[data-functional-selector^="choice-"]',
    '[data-functional-selector*="answer"]',
    '[data-functional-selector*="choice"]',
    '[data-functional-selector*="option"]',
  ];

  // Loose fallbacks — used when strict yields < 2 results
  const ANSWER_SELECTORS_LOOSE = [
    // class-name patterns (CSS Modules / styled-components hash classes often contain these words)
    'button[class*="answer" i]',
    'button[class*="Answer"]',
    'button[class*="choice" i]',
    'button[class*="option" i]',
    'div[class*="answer" i]',
    'div[class*="Answer"]',
    'div[class*="choice" i]',
    'div[class*="answerCard" i]',
    'li[class*="answer" i]',
    'li[class*="choice" i]',
    '[class*="AnswerBox"]',
    '[class*="answer-box"]',
    '[class*="answer_button"]',
    '[class*="answerButton"]',
    'ul[class*="choice" i] > li',
    'ul[class*="answer" i] > li',
    'ol > li[role="listitem"]',
  ];

  function visible(el) {
    const r = el?.getBoundingClientRect?.();
    const cs = el ? getComputedStyle(el) : null;
    return !!r && r.width > 40 && r.height > 20 &&
      cs?.display !== "none" && cs?.visibility !== "hidden" &&
      parseFloat(cs?.opacity ?? "1") > 0.05 &&
      r.bottom > 0 && r.top < innerHeight;
  }

  /**
   * Last-resort: find answer buttons by grouping large clickable elements
   * that share the same parent and sit in the lower portion of the viewport.
   * This handles Kahoot.it/gameblock (mobile player view) where class names
   * are hashed styled-components and no stable selector matches.
   */
  function findAnswersByParentGroup() {
    // Query a broad but targeted set of elements
    const candidates = Array.from(document.querySelectorAll(
      'button, [role="button"], [role="option"], li, a[class]'
    )).filter((el) => {
      const r = el.getBoundingClientRect();
      // Must be large enough to be an answer button
      if (r.width < 60 || r.height < 36) return false;
      // Must be in the lower 75% of viewport (answers are below the question)
      if (r.top < innerHeight * 0.2) return false;
      // Must be on-screen
      if (r.top >= innerHeight || r.bottom <= 0) return false;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      if (parseFloat(cs.opacity ?? "1") < 0.05) return false;
      // Must have readable text (not icon-only)
      const text = (el.textContent || el.getAttribute("aria-label") || "").trim();
      return text.length >= 1 && text.length <= 600;
    });

    if (candidates.length < 2) return [];

    // Group by direct parent
    const byParent = new Map();
    for (const el of candidates) {
      const p = el.parentElement;
      if (!p) continue;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(el);
    }

    // Prefer a group of 2–6 siblings (exact answer count)
    let best = [];
    for (const group of byParent.values()) {
      if (group.length >= 2 && group.length <= 6 && group.length > best.length) best = group;
    }
    if (best.length >= 2) return best;

    // Try grandparent grouping (common in 2-column grid layouts where each
    // answer is wrapped in its own <div> cell before a shared grid container)
    const byGrandparent = new Map();
    for (const el of candidates) {
      const gp = el.parentElement?.parentElement;
      if (!gp) continue;
      if (!byGrandparent.has(gp)) byGrandparent.set(gp, []);
      byGrandparent.get(gp).push(el);
    }
    for (const group of byGrandparent.values()) {
      if (group.length >= 2 && group.length <= 6 && group.length > best.length) best = group;
    }

    return best.length >= 2 ? best : [];
  }
  function cleanText(s) {
    const raw = String(s || "").replace(/\s+/g, " ").trim();
    const m = raw.match(/^(.{2,}?)\1{1,}$/);
    return m ? m[1] : raw;
  }
  function normalize(s) {
    return cleanText(s).toLowerCase().normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ").trim();
  }

  function getQuestionText() {
    for (const sel of QUESTION_SELECTORS) {
      const el = document.querySelector(sel);
      const t = cleanText(el?.textContent);
      if (visible(el) && t.length > 2 && t.length < 1200 && !/^quiz$/i.test(t)) return t;
    }
    return null;
  }
  function collectButtons(selectors) {
    const found = [], seen = new Set();
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (!visible(el) || seen.has(el)) continue;
        seen.add(el); found.push(el);
      }
    }
    return found;
  }
  function getAnswerButtons() {
    let btns = collectButtons(ANSWER_SELECTORS_STRICT);
    if (btns.length < 2 || btns.length > 6) {
      const loose = collectButtons(ANSWER_SELECTORS_LOOSE);
      if (loose.length >= 2 && loose.length <= 6) {
        btns = loose;
      }
    }
    // Last resort: parent-group heuristic for mobile Kahoot gameblock
    // (handles hashed styled-components class names with no stable selector)
    if (btns.length < 2 || btns.length > 6) {
      const heuristic = findAnswersByParentGroup();
      dlog("getAnswerButtons heuristic:", heuristic.length, heuristic.map(b => (b.textContent||"").trim().slice(0,30)));
      if (heuristic.length >= 2 && heuristic.length <= 6) btns = heuristic;
    } else {
      dlog("getAnswerButtons found", btns.length, "via selectors");
    }
    return btns.length >= 2 && btns.length <= 6 ? btns : [];
  }
  function getAnswers(btns) {
    return btns.map((b, i) => cleanText(b.textContent || b.getAttribute("aria-label")) || `Answer ${i + 1}`);
  }
  function isMultiSelect() {
    const text = cleanText(document.body.innerText).toLowerCase();
    return !!document.querySelector('[data-functional-selector*="multi"], [class*="multi-select"]') ||
      text.includes("select all") || text.includes("multiple select");
  }

  // ─── Overlays / display ──────────────────────────────────────────────────
  // overlays[] stores {el, btn, kind} — el is appended INSIDE btn (position:absolute)
  const overlays = [];

  function clearMarks() {
    // Remove our overlay elements from inside buttons
    while (overlays.length) {
      const o = overlays.pop();
      o.el?.remove();
      // Restore button positioning if we set it
      if (o.btn && o._origPosition !== undefined) {
        o.btn.style.position = o._origPosition || "";
      }
    }
    // Sweep for any orphaned overlays (belt-and-suspenders)
    document.querySelectorAll(".kh-ai-overlay").forEach((d) => d.remove());
    document.getElementById("kh-ai-corner")?.remove();
  }

  function addOverlay(btn, kind) {
    if (!btn || !btn.isConnected) return null;

    // Make sure the button is a positioning context so absolute children work
    const computedPos = getComputedStyle(btn).position;
    const origPosition = btn.style.position || "";
    if (!computedPos || computedPos === "static") {
      btn.style.position = "relative";
    }

    const el = document.createElement("div");
    el.className = "kh-ai-overlay kh-ai-" + kind;

    if (kind === "dot") {
      const sz = Math.max(6, Math.min(24, settings.dotSize || 10));
      // Vertically centered on the right side — only set size; CSS handles position
      el.style.width = sz + "px";
      el.style.height = sz + "px";
    } else if (kind === "highlight") {
      // Cover the entire button
      el.style.cssText = "inset:0;";
    }

    // Append INSIDE the button so it moves with React re-renders
    btn.appendChild(el);

    const o = { el, btn, kind, _origPosition: origPosition };
    overlays.push(o);
    return o;
  }

  function showCornerNumber(text) {
    let el = document.getElementById("kh-ai-corner");
    if (!el) { el = document.createElement("div"); el.id = "kh-ai-corner"; document.body.appendChild(el); }
    el.textContent = String(text);
  }

  // ─── Floating panel ──────────────────────────────────────────────────────
  function ensureFloat() {
    let el = document.getElementById("kh-ai-float");
    if (el) return el;
    el = document.createElement("div");
    el.id = "kh-ai-float";
    el.innerHTML = `
      <div class="kh-head">
        <span class="kh-title">Kahoot AI</span>
        <span class="kh-lat"></span>
        <button class="kh-close">×</button>
      </div>
      <div class="kh-q"></div>
      <div class="kh-meta"></div>
      <div class="kh-body"></div>
      <div class="kh-actions">
        <button data-mode="dot" title="Dot">·</button>
        <button data-mode="corner-number" title="Number">#</button>
        <button data-mode="highlight" title="Highlight">▣</button>
        <button data-mode="notification" title="Notify">↗</button>
      </div>
      <div class="kh-status"></div>`;
    document.body.appendChild(el);
    el.querySelector(".kh-close").addEventListener("click", () => el.remove());
    el.querySelectorAll(".kh-actions button").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        chrome.storage.local.set({ display: b.dataset.mode });
      })
    );
    let sx, sy, ox, oy, dragging = false;
    el.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      el.style.left = (ox + e.clientX - sx) + "px";
      el.style.top = (oy + e.clientY - sy) + "px";
      el.style.bottom = "auto";
    });
    window.addEventListener("mouseup", () => { dragging = false; });
    return el;
  }
  function updateFloat({ question, answers, correct, status, error, latency, model }) {
    if (settings.display !== "floating") return;
    const el = ensureFloat();
    if (question !== undefined) el.querySelector(".kh-q").textContent = question || "—";
    if (latency || model || status) {
      el.querySelector(".kh-lat").textContent = latency || model || status || "";
    }
    if (answers !== undefined || correct !== undefined) {
      const body = el.querySelector(".kh-body");
      body.innerHTML = "";
      if (Array.isArray(answers) && answers.length) {
        const set = new Set(Array.isArray(correct) ? correct : (correct != null ? [correct] : []));
        answers.forEach((a, i) => {
          const div = document.createElement("div");
          div.className = "kh-ans" + (set.has(i) ? " kh-correct" : "");
          div.textContent = `${set.has(i) ? "✓" : "·"} ${i + 1}) ${a}`;
          body.appendChild(div);
        });
      } else if (typeof correct === "string") {
        const div = document.createElement("div");
        div.className = "kh-ans kh-correct";
        div.textContent = "✓ " + correct;
        body.appendChild(div);
      }
    }
    if (status !== undefined || error !== undefined) {
      const st = el.querySelector(".kh-status");
      st.className = "kh-status" + (error ? " kh-err" : "");
      st.textContent = error ? `✗ ${error}` : (status || "");
    }
    if (question !== undefined) {
      el.querySelector(".kh-meta").textContent = Array.isArray(answers) && answers.length
        ? `${answers.length} options${isMultiSelect() ? " · multi" : ""}`
        : "";
    }
  }

  function notify(title, body) {
    chrome.runtime.sendMessage({ type: "KH_AI_NOTIFY", title, body });
  }

  // ─── Phase 2 completion flag — prevents phase-1 late callback from overwriting ──
  let phase2Done = false;

  function markCorrect(btns, idxs, answers, question, status, model) {
    clearMarks();
    phase2Done = true; // signal that we have a real answer

    const list = Array.isArray(idxs) ? idxs : [idxs];
    const mode = settings.display || "dot";
    dlog("markCorrect", { mode, list, status, model });

    if (mode === "floating") {
      updateFloat({ question, answers, correct: list, status, model });
      return;
    }
    if (mode === "notification") {
      notify("Kahoot AI", list.map((i) => `${i + 1}: ${answers?.[i] || ""}`).join(" | "));
      return;
    }
    if (mode === "corner-number") {
      showCornerNumber(list.map((i) => i + 1).join(","));
      return;
    }

    // dot or highlight — re-query buttons fresh to avoid stale references from before await
    const freshBtns = getAnswerButtons();
    const targetAnswers = answers || [];

    for (const idx of list) {
      // First try fresh buttons at same index
      let btn = freshBtns[idx];

      // If that button is detached or missing, find by text match
      if (!btn || !btn.isConnected) {
        const targetText = normalize(targetAnswers[idx] || "");
        if (targetText) {
          for (const fb of freshBtns) {
            const fbText = normalize(fb.textContent || "");
            if (fb.isConnected && fbText && (fbText === targetText || fbText.includes(targetText) || targetText.includes(fbText))) {
              btn = fb;
              break;
            }
          }
        }
      }

      // Fallback to original stale reference if fresh query also failed
      if (!btn || !btn.isConnected) btn = btns[idx];

      if (!btn || !btn.isConnected) {
        dlog("markCorrect: no live button for idx", idx);
        continue;
      }
      addOverlay(btn, mode === "highlight" ? "highlight" : "dot");
    }
  }

  // ─── Puter bridge ────────────────────────────────────────────────────────
  const pending = new Map();
  let reqId = 0;
  let injectedReady = false;
  const readyQueue = [];

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data) return;
    const d = ev.data;
    if (d.type === MSG_READY) {
      injectedReady = true;
      while (readyQueue.length) readyQueue.shift()();
      return;
    }
    if (d.type === MSG_IN && d.reqId != null) {
      const cb = pending.get(d.reqId);
      if (cb) { pending.delete(d.reqId); cb(d); }
    }
  });

  function puterChat(model, messages, maxTokens) {
    return new Promise((resolve) => {
      const id = ++reqId;
      pending.set(id, resolve);
      const send = () => window.postMessage({ type: MSG_OUT, reqId: id, model, messages, max_tokens: maxTokens }, "*");
      if (injectedReady) send(); else readyQueue.push(send);
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ ok: false, error: "timeout" }); }
      }, 25000);
    });
  }

  function openrouterChat(messages, signalId, maxTokens) {
    return new Promise((resolve) => {
      const models = OPENROUTER_MODELS.filter((m) => m);
      const primary = settings.openrouterModel || models[0];
      const queue = Array.from(new Set([primary, ...models]));
      chrome.runtime.sendMessage(
        { type: "KH_AI_OPENROUTER", apiKey: settings.openrouterKey, model: queue[0], models: queue, messages, signal_id: signalId, max_tokens: maxTokens },
        (r) => resolve(r || { ok: false, error: "no response" })
      );
    });
  }

  function googleChat(messages, signalId, maxTokens) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "KH_AI_GOOGLE", apiKey: settings.googleKey, model: settings.googleModel || GOOGLE_MODEL, messages, signal_id: signalId, max_tokens: maxTokens },
        (r) => resolve(r || { ok: false, error: "no response" })
      );
    });
  }

  let signalSeq = 0;
  const inflightSignals = new Set();
  function abortAll() {
    for (const s of inflightSignals) chrome.runtime.sendMessage({ type: "KH_AI_ABORT", signal_id: s });
    inflightSignals.clear();
  }

  async function callAI(messages, maxTokens) {
    const signalId = ++signalSeq;
    inflightSignals.add(signalId);
    const t0 = performance.now();
    try {
      dlog("→ callAI", { provider: settings.provider, maxTokens });
      let res;
      if (settings.provider === "google") {
        if (!settings.googleKey) return { ok: false, error: "Missing Google AI Studio API key" };
        res = await googleChat(messages, signalId, maxTokens);
      } else if (settings.provider === "openrouter") {
        if (!settings.openrouterKey) return { ok: false, error: "Missing OpenRouter API key" };
        res = await openrouterChat(messages, signalId, maxTokens);
      } else {
        // puter
        let last = null;
        const models = Array.from(new Set([settings.puterModel, ...PUTER_MODELS].filter(Boolean)));
        for (const model of models) {
          last = await puterChat(model, messages, maxTokens);
          dlog("puter try", model, last?.ok ? "ok" : "fail");
          if (last?.ok && last.text?.trim()) { res = { ...last, model }; break; }
        }
        res = res || last || { ok: false, error: "Puter: no response" };
      }
      const dt = ((performance.now() - t0) / 1000).toFixed(2);
      if (res?.ok) dlog("← callAI ok", { dt, model: res.model, text: String(res.text).slice(0, 80) });
      else derr("← callAI fail", { dt, error: res?.error });
      return res;
    } finally {
      inflightSignals.delete(signalId);
    }
  }

  // ─── Number parsing — robust extraction of answer index ──────────────────
  // Extracts which answer (1-N) the AI picked.
  // Handles: "2", "2.", "2\n", "The answer is 2", "Option 2", "(2)", "1,3", "1 and 3", etc.
  function parseNumberAnswer(raw, max, multi) {
    if (!raw) return null;
    const s = String(raw).trim();
    const n = max;

    // Helper: collect ALL valid 1-based digit indices in the string (for both single/multi)
    function allDigits() {
      return Array.from(s.matchAll(/\b([1-9])\b/g))
        .map((x) => parseInt(x[1], 10) - 1)
        .filter((v) => v >= 0 && v < n);
    }

    // For multi-select: aggregate ALL valid digits found anywhere in the response
    if (multi) {
      // Try JSON first: [1,3] or {"answers":[1,3]}
      const jsonMatch = s.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const j = JSON.parse(jsonMatch[0]);
          const val = j.answers ?? j.correct ?? j.answer ?? j;
          if (Array.isArray(val)) {
            const arr = val.map((x) => parseInt(String(x).replace(/\D/g, ""), 10) - 1)
              .filter((v) => Number.isInteger(v) && v >= 0 && v < n);
            if (arr.length) return Array.from(new Set(arr));
          }
        } catch {}
      }
      // Collect all valid digits (handles "1,3", "1 and 3", "options 1, 3", etc.)
      const all = allDigits();
      if (all.length) return Array.from(new Set(all));
      return null;
    }

    // Single-answer: prefer the first unambiguous digit

    // 1. Entire response is just a digit (possibly with trailing punctuation)
    const singleDigit = s.match(/^([1-9])[.,!?]?$/);
    if (singleDigit) {
      const v = parseInt(singleDigit[1], 10) - 1;
      if (v >= 0 && v < n) return v;
    }

    // 2. Digit at the very start of the response
    const leadDigit = s.match(/^([1-9])(?:\b|[.,:\s)]|$)/);
    if (leadDigit) {
      const v = parseInt(leadDigit[1], 10) - 1;
      if (v >= 0 && v < n) return v;
    }

    // 3. JSON: {"answer": 2}
    const jsonMatch = s.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const j = JSON.parse(jsonMatch[0]);
        const val = j.answers ?? j.correct ?? j.answer ?? j.index ?? j;
        const v = parseInt(String(val).replace(/\D/g, ""), 10) - 1;
        if (Number.isInteger(v) && v >= 0 && v < n) return v;
      } catch {}
    }

    // 4. Common English patterns: "answer is 3", "option 2", "#4", "(2)"
    const patterns = [
      /(?:answer|option|choice|number|pick|select)[^0-9]*([1-9])/i,
      /(?:is|:)\s*([1-9])\b/i,
      /#([1-9])\b/,
      /\(([1-9])\)/,
    ];
    for (const pat of patterns) {
      const m = s.match(pat);
      if (m) {
        const v = parseInt(m[1], 10) - 1;
        if (v >= 0 && v < n) return v;
      }
    }

    // 5. Any valid digit anywhere in the response
    const all = allDigits();
    if (all.length) return all[0];

    return null;
  }

  // ─── Fuzzy match (for when AI returns prose instead of a number) ─────────
  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const v0 = Array.from({ length: b.length + 1 }, (_, i) => i);
    const v1 = new Array(b.length + 1);
    for (let i = 0; i < a.length; i++) {
      v1[0] = i + 1;
      for (let j = 0; j < b.length; j++) {
        const cost = a[i] === b[j] ? 0 : 1;
        v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
      }
      for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
    }
    return v1[b.length];
  }
  function fuzzyMatchAnswer(hint, answers) {
    if (!hint || !answers?.length) return null;
    const h = normalize(hint);
    if (!h) return null;
    let best = { index: -1, score: 0 };
    answers.forEach((a, i) => {
      const n = normalize(a);
      if (!n) return;
      let score = 0;
      if (n === h) score = 1;
      else if (n.includes(h) || h.includes(n)) {
        score = Math.max(0.85, Math.min(n.length, h.length) / Math.max(n.length, h.length));
      } else {
        const ht = new Set(h.split(" ").filter((x) => x.length > 1));
        const nt = new Set(n.split(" ").filter((x) => x.length > 1));
        if (ht.size && nt.size) {
          let common = 0;
          for (const t of ht) if (nt.has(t)) common++;
          const tokenScore = common / Math.max(ht.size, nt.size);
          const lev = 1 - levenshtein(h, n) / Math.max(h.length, n.length);
          score = Math.max(tokenScore, lev);
        }
      }
      if (score > best.score) best = { index: i, score };
    });
    return best.index >= 0 && best.score >= 0.55 ? best : null;
  }

  // ─── Cache ───────────────────────────────────────────────────────────────
  const cache = new Map();
  function cacheGet(k) { return cache.get(k); }
  function cacheSet(k, v) {
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    cache.set(k, v);
  }

  // ─── Prompt builders ─────────────────────────────────────────────────────
  // Phase 1: question only → AI solves and replies with short answer
  const SYS_PHASE1 =
    "You are a fast, accurate quiz assistant. When given a QUESTION, solve it and reply with ONLY the final short answer (1-4 words). No explanation, no punctuation, no quotes.";

  // Phase 2 (with hint): AI already gave answer, now picks the matching number
  // Phase 2 (cold): question + options together → pick number
  const SYS_PHASE2_SINGLE = (n) =>
    `You are a quiz solver. Reply with ONLY ONE DIGIT 1-${n}. Nothing else — no words, no punctuation.`;
  const SYS_PHASE2_MULTI =
    "You are a quiz solver. Reply with ONLY the digits of correct answers separated by commas (e.g. 1,3). Nothing else.";

  function buildPhase1(q) {
    return [
      { role: "system", content: SYS_PHASE1 },
      { role: "user", content: `QUESTION: ${q}\n\n(Options are not visible yet. Give ONLY your best short answer now.)` },
    ];
  }
  function buildPhase2WithHint(q, answers, multi, hint) {
    const list = answers.map((a, i) => `${i + 1}) ${a}`).join("\n");
    const instruction = multi
      ? `These are the options for the question above:\n${list}\n\nWhich digits match your answer? Reply ONLY digits separated by commas.`
      : `These are the options for the question above:\n${list}\n\nWhich digit matches your answer? Reply ONLY ONE DIGIT 1-${answers.length}.`;
    return [
      { role: "system", content: multi ? SYS_PHASE2_MULTI : SYS_PHASE2_SINGLE(answers.length) },
      { role: "user", content: `QUESTION: ${q}` },
      { role: "assistant", content: String(hint).slice(0, 150) },
      { role: "user", content: instruction },
    ];
  }
  function buildPhase2Cold(q, answers, multi) {
    const list = answers.map((a, i) => `${i + 1}) ${a}`).join("\n");
    return [
      { role: "system", content: multi ? SYS_PHASE2_MULTI : SYS_PHASE2_SINGLE(answers.length) },
      { role: "user", content: `QUESTION: ${q}\nOPTIONS:\n${list}\n\nReply with ONLY the correct digit${multi ? "s" : ""}.` },
    ];
  }

  // ─── Prefetch state ──────────────────────────────────────────────────────
  let lastSig = "";
  let lastQSig = "";
  let busy = false;
  let prefetchedQ = null; // { question, qSig, ts, hint, inFlight }

  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  function maybePrefetchQuestion(q) {
    if (!settings.prefetch) return;
    const qSig = hash(q);
    if (qSig === lastQSig) return;
    lastQSig = qSig;
    clearMarks();
    phase2Done = false;
    prefetchedQ = { question: q, qSig, ts: Date.now(), hint: null, inFlight: true };
    dlog("prefetch → phase1:", q);
    updateFloat({ question: q, status: "① AI analysing question…" });
    callAI(buildPhase1(q), 32).then((r) => {
      if (prefetchedQ?.qSig !== qSig) return; // stale
      const hint = r?.ok ? cleanText(r.text).replace(/^["']|["']$/g, "").slice(0, 200) : null;
      prefetchedQ.hint = hint;
      prefetchedQ.inFlight = false;
      dlog("prefetch ← phase1:", { hint, model: r?.model, error: r?.error });
      // Only update floating panel status if phase 2 hasn't already shown the answer
      if (!phase2Done) {
        updateFloat({ question: q, status: hint ? `② waiting for options… (hint: ${hint})` : (r?.error || "no hint") });
      }
    });
  }

  function getWarmHint(q) {
    if (!prefetchedQ) return null;
    if (prefetchedQ.question !== q) return null;
    if (Date.now() - prefetchedQ.ts > 90000) return null;
    return prefetchedQ.hint; // may be null if still in flight
  }

  // ─── Main detection loop ─────────────────────────────────────────────────
  async function tick() {
    if (!settings.enabled || busy) return;
    const q = getQuestionText();
    if (!q) { dlog("tick: no question text found"); return; }

    const btns = getAnswerButtons();
    dlog("tick: q found, btns =", btns.length);

    // Stage 1: question is visible but no options yet → prefetch (phase 1)
    if (!btns.length) {
      maybePrefetchQuestion(q);
      return;
    }

    // Stage 2: options visible → pick the answer
    const answers = getAnswers(btns);
    const hasText = answers.some((a) => a && !/^answer \d+$/i.test(a));
    dlog("tick: answers =", answers, "hasText =", hasText);
    if (!hasText) return; // buttons without text — skip (no OCR fallback)

    const multi = isMultiSelect();
    const sig = `${hash(q)}|${answers.join("|")}|${multi ? "m" : "s"}`;
    if (sig === lastSig) return;
    // Set lastSig now to prevent double-processing, but reset on failure
    const thisSig = sig;
    lastSig = sig;
    busy = true;
    clearMarks();
    phase2Done = false;

    // Check cache first
    const cacheKey = `${settings.provider}:${sig}`;
    const cached = cacheGet(cacheKey);
    if (cached != null) {
      markCorrect(btns, cached, answers, q, "cache");
      busy = false;
      return;
    }

    const t0 = performance.now();
    try {
      // Get prefetch hint (phase 1 result)
      const hint = getWarmHint(q);
      dlog("stage2 hint:", hint, "multi:", multi);

      updateFloat({ question: q, answers, status: hint ? "② AI matching number…" : "② AI picking answer…" });

      // Instant fuzzy match if we have a good prefetch hint (zero API calls)
      if (hint && !multi && !prefetchedQ?.inFlight) {
        const m = fuzzyMatchAnswer(hint, answers);
        if (m && m.score >= 0.78) {
          cacheSet(cacheKey, m.index);
          const dt = ((performance.now() - t0) / 1000).toFixed(2);
          dlog("fuzzy match (no API call):", { score: m.score, idx: m.index });
          markCorrect(btns, m.index, answers, q, `${dt}s · instant match`, settings.provider);
          return;
        }
      }

      // Phase 2 API call: with hint or cold
      abortAll();
      const messages = (hint && !prefetchedQ?.inFlight)
        ? buildPhase2WithHint(q, answers, multi, hint)
        : buildPhase2Cold(q, answers, multi);

      // Phase 2 needs very few tokens — just a digit
      const maxTok = multi ? 12 : 4;
      const result = await callAI(messages, maxTok);

      dlog("phase2 result:", result);

      if (!result?.ok) {
        if (!result?.aborted) {
          updateFloat({ question: q, answers, error: result?.error || "AI error" });
        }
        // Reset sig on failure so the same question can be retried on next tick
        if (lastSig === thisSig) lastSig = "";
        return;
      }

      const rawText = String(result.text || "").trim();

      // Primary: parse number from AI response
      let parsed = parseNumberAnswer(rawText, btns.length, multi);

      // Fallback A: fuzzy match AI's prose response against answer texts
      if (parsed == null || (Array.isArray(parsed) && !parsed.length)) {
        const m = fuzzyMatchAnswer(rawText, answers);
        if (m) {
          dlog("fallback A: fuzzy on AI prose", { score: m.score, idx: m.index });
          cacheSet(cacheKey, m.index);
          const dt = ((performance.now() - t0) / 1000).toFixed(2);
          markCorrect(btns, m.index, answers, q, `${dt}s · fuzzy`, result.model);
          return;
        }
        // Fallback B: fuzzy match the prefetch hint against answers
        if (hint) {
          const m2 = fuzzyMatchAnswer(hint, answers);
          if (m2) {
            dlog("fallback B: fuzzy on hint", { score: m2.score, idx: m2.index });
            cacheSet(cacheKey, m2.index);
            const dt = ((performance.now() - t0) / 1000).toFixed(2);
            markCorrect(btns, m2.index, answers, q, `${dt}s · hint-fuzzy`, result.model);
            return;
          }
        }
        derr("could not parse answer:", rawText);
        updateFloat({ question: q, answers, error: `Could not read: "${rawText.slice(0, 60)}"` });
        return;
      }

      cacheSet(cacheKey, parsed);
      const dt = ((performance.now() - t0) / 1000).toFixed(2);
      markCorrect(btns, parsed, answers, q, `${dt}s · ${settings.provider}`, result.model);
    } finally {
      busy = false;
    }
  }

  // ─── Observer + polling ──────────────────────────────────────────────────
  let debounce;
  const obs = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(tick, 100);
  });
  obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  setInterval(tick, 500);
  console.log(TAG, "v1.0.0-alpha loaded");
})();
