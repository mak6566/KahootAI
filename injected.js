// injected.js — MAIN world: Puter.js bridge (v2.0)
(function () {
  const MSG_OUT = "KH_AI_RESULT";
  const MSG_IN = "KH_AI_QUERY";
  const MSG_READY = "KH_AI_READY";

  let puterPromise = null;
  function loadPuter() {
    if (window.puter) return Promise.resolve();
    if (puterPromise) return puterPromise;
    puterPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://js.puter.com/v2/";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("puter.js load failed"));
      document.head.appendChild(s);
    });
    return puterPromise;
  }

  function reply(reqId, data) {
    window.postMessage({ type: MSG_OUT, reqId, ...data }, "*");
  }

  function extractText(res) {
    if (!res) return "";
    if (typeof res === "string") return res;
    const msg = res.message ?? res;
    let c = msg?.content ?? res?.text ?? res?.output_text ?? "";
    if (Array.isArray(c)) c = c.map((x) => x?.text || x?.content || "").filter(Boolean).join("\n");
    if (typeof c === "string" && c.trim()) return c;
    const r = msg?.reasoning ?? res?.reasoning ?? "";
    if (typeof r === "string" && r.trim()) return r;
    const rd = msg?.reasoning_details ?? res?.reasoning_details;
    if (Array.isArray(rd)) return rd.map((x) => x?.text || "").join("\n");
    return "";
  }

  async function chat(model, messages, maxTokens) {
    const opts = {
      model,
      temperature: 0,
      max_tokens: Math.max(16, maxTokens || 64),
    };
    const res = await window.puter.ai.chat(messages, opts);
    return extractText(res);
  }

  async function handle(req) {
    try {
      await loadPuter();
      const text = await chat(req.model, req.messages, req.max_tokens);
      reply(req.reqId, { ok: true, text });
    } catch (e) {
      reply(req.reqId, { ok: false, error: e?.message || String(e) });
    }
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data) return;
    if (ev.data.type === MSG_IN) handle(ev.data);
  });

  loadPuter().catch(() => {});
  window.postMessage({ type: MSG_READY }, "*");
})();
