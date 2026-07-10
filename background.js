// background.js — Service worker: OpenRouter + Google AI Studio proxies + screenshot capture (v2.0)

const abortMap = new Map();

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function shouldTryNextModel(message = "") {
  const s = String(message).toLowerCase();
  return s.includes("no endpoints") ||
    s.includes("provider returned error") ||
    s.includes("provider error") ||
    s.includes("not free") ||
    s.includes("not found") ||
    s.includes("unavailable") ||
    s.includes("rate limit") ||
    s.includes("rate-limit") ||
    s.includes("temporarily") ||
    s.includes("429") ||
    s.includes("503");
}

function extractOpenRouterContent(choice) {
  const msg = choice?.message || {};
  let c = msg.content;
  if (Array.isArray(c)) c = c.map((x) => x?.text || x?.content || "").filter(Boolean).join("\n");
  if (typeof c === "string" && c.trim()) return c.trim();
  if (typeof msg.reasoning === "string" && msg.reasoning.trim()) return msg.reasoning.trim();
  if (Array.isArray(msg.reasoning_details)) {
    const t = msg.reasoning_details.map((x) => x?.text || "").join("\n").trim();
    if (t) return t;
  }
  return "";
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ─── Screenshot capture ───────────────────────────────────────────────────
  if (msg?.type === "KH_AI_CAPTURE") {
    chrome.tabs.captureVisibleTab(
      sender.tab?.windowId,
      { format: "jpeg", quality: 55 },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, dataUrl });
        }
      }
    );
    return true;
  }

  // ─── OpenRouter ───────────────────────────────────────────────────────────
  if (msg?.type === "KH_AI_OPENROUTER") {
    (async () => {
      const { apiKey, model, models, messages, signal_id, max_tokens } = msg;
      const ctrl = new AbortController();
      if (signal_id != null) abortMap.set(signal_id, ctrl);
      try {
        const queue = Array.from(new Set([model, ...(Array.isArray(models) ? models : [])].filter(Boolean)));
        let lastError = "unknown OpenRouter error";
        for (const candidate of queue) {
          const isReasoning = /reasoning|nemotron-3-nano-omni/i.test(candidate);
          const baseTokens = isReasoning
            ? Math.max(2048, (max_tokens || 16) * 64)
            : Math.max(16, max_tokens || 32);
          let attempt = 0;
          let attemptTokens = baseTokens;
          let succeeded = false;
          while (attempt < 2 && !succeeded) {
            const body = {
              model: candidate,
              messages,
              temperature: 0,
              top_p: 0.1,
              max_tokens: attemptTokens,
              provider: { sort: "throughput", allow_fallbacks: true },
              stream: false,
            };
            if (isReasoning) body.reasoning = { exclude: true };
            const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                "HTTP-Referer": "https://kahoot.it/",
                "X-Title": "Kahoot AI Helper",
              },
              body: JSON.stringify(body),
              signal: ctrl.signal,
            });
            const raw = await r.text();
            const data = safeJson(raw) || { error: { message: raw } };
            if (r.ok) {
              const text = extractOpenRouterContent(data?.choices?.[0]);
              if (text) { sendResponse({ ok: true, text, model: candidate }); return; }
              lastError = `${candidate}: empty response`;
              if (isReasoning && attempt === 0) {
                attempt++;
                attemptTokens = Math.min(attemptTokens * 2, 8192);
                continue;
              }
              break;
            }
            lastError = data?.error?.message || `HTTP ${r.status}`;
            if (!shouldTryNextModel(lastError)) { sendResponse({ ok: false, error: lastError }); return; }
            break;
          }
        }
        sendResponse({ ok: false, error: lastError });
      } catch (e) {
        if (e.name === "AbortError") sendResponse({ ok: false, error: "aborted", aborted: true });
        else sendResponse({ ok: false, error: e?.message || String(e) });
      } finally {
        if (signal_id != null) abortMap.delete(signal_id);
      }
    })();
    return true;
  }

  // ─── Google AI Studio (Gemini) ────────────────────────────────────────────
  if (msg?.type === "KH_AI_GOOGLE") {
    (async () => {
      const { apiKey, model, messages, signal_id, max_tokens } = msg;
      const ctrl = new AbortController();
      if (signal_id != null) abortMap.set(signal_id, ctrl);
      try {
        // Convert OpenAI-style messages to Gemini format
        let systemInstruction = null;
        const contents = [];
        for (const m of messages) {
          if (m.role === "system") {
            systemInstruction = m.content;
          } else {
            const role = m.role === "assistant" ? "model" : "user";
            if (Array.isArray(m.content)) {
              // Multimodal (vision)
              const parts = m.content.map((part) => {
                if (part.type === "text") return { text: part.text };
                if (part.type === "image_url") {
                  const url = part.image_url?.url || "";
                  if (url.startsWith("data:")) {
                    const [header, data] = url.split(",");
                    const mimeType = header.replace("data:", "").replace(";base64", "");
                    return { inline_data: { mime_type: mimeType, data } };
                  }
                  return { text: "[image]" };
                }
                return { text: String(part) };
              });
              contents.push({ role, parts });
            } else {
              contents.push({ role, parts: [{ text: m.content }] });
            }
          }
        }
        const body = {
          contents,
          generationConfig: {
            temperature: 0,
            topP: 0.1,
            maxOutputTokens: Math.max(16, max_tokens || 32),
          },
        };
        if (systemInstruction) {
          body.systemInstruction = { parts: [{ text: systemInstruction }] };
        }
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const r = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        const raw = await r.text();
        const data = safeJson(raw) || {};
        if (r.ok) {
          const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
          if (text) { sendResponse({ ok: true, text, model }); return; }
          sendResponse({ ok: false, error: "Google AI: empty response" });
        } else {
          const errMsg = data?.error?.message || `HTTP ${r.status}`;
          sendResponse({ ok: false, error: errMsg });
        }
      } catch (e) {
        if (e.name === "AbortError") sendResponse({ ok: false, error: "aborted", aborted: true });
        else sendResponse({ ok: false, error: e?.message || String(e) });
      } finally {
        if (signal_id != null) abortMap.delete(signal_id);
      }
    })();
    return true;
  }

  // ─── Abort ────────────────────────────────────────────────────────────────
  if (msg?.type === "KH_AI_ABORT" && msg.signal_id != null) {
    const c = abortMap.get(msg.signal_id);
    if (c) { c.abort(); abortMap.delete(msg.signal_id); }
    sendResponse({ ok: true });
    return false;
  }

  // ─── Notification ─────────────────────────────────────────────────────────
  if (msg?.type === "KH_AI_NOTIFY") {
    chrome.notifications?.create?.({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title: msg.title || "Kahoot AI",
      message: msg.body || "",
      priority: 2,
    });
    sendResponse({ ok: true });
    return false;
  }
});
