// popup.js — Kahoot AI Helper v2.0
const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  enabled: true,
  provider: "google",
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

const OR_MODELS = ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"];
const PUTER_MODELS = ["gpt-4o-mini", "gpt-4.1-nano"];

// ─── Provider tab switching ──────────────────────────────────────────────────
// Map provider name → HTML box id (orBox, not openrouterBox)
const PROVIDER_BOX_ID = { google: "googleBox", openrouter: "orBox", puter: "puterBox" };

function setActiveProvider(provider) {
  document.querySelectorAll(".provider-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.provider === provider);
  });
  const targetId = PROVIDER_BOX_ID[provider] || (provider + "Box");
  document.querySelectorAll(".provider-box").forEach((box) => {
    box.classList.toggle("active", box.id === targetId);
  });
  chrome.storage.local.set({ provider });
}

document.querySelectorAll(".provider-tab").forEach((btn) => {
  btn.addEventListener("click", () => setActiveProvider(btn.dataset.provider));
});

// ─── Dot size range ──────────────────────────────────────────────────────────
function refreshUI(display) {
  $("dotSizeBox").classList.toggle("hide", display !== "dot");
  $("dotSizeVal").textContent = $("dotSize").value;
}

// ─── Load settings ───────────────────────────────────────────────────────────
chrome.storage.local.get(Object.keys(DEFAULTS), (v) => {
  const s = { ...DEFAULTS, ...v };
  // Migrate: fill in any missing defaults
  const toSet = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (v[k] === undefined) toSet[k] = DEFAULTS[k];
  }
  if (Object.keys(toSet).length) chrome.storage.local.set(toSet);
  Object.assign(s, toSet);

  $("enabled").checked = !!s.enabled;
  $("prefetch").checked = !!s.prefetch;
  $("debug").checked = !!s.debug;
  $("puterModel").value = s.puterModel;
  $("openrouterModel").value = s.openrouterModel;
  $("openrouterKey").value = s.openrouterKey || "";
  $("googleKey").value = s.googleKey || DEFAULTS.googleKey;
  $("googleModel").value = s.googleModel || DEFAULTS.googleModel;
  $("display").value = s.display;
  $("dotSize").value = s.dotSize;

  setActiveProvider(s.provider || "google");
  refreshUI(s.display);

  // Update header status dot
  $("statusDot").className = s.enabled ? "dot-active" : "dot-inactive";
  $("statusText").textContent = s.enabled ? "Active" : "Disabled";
});

// ─── Bind inputs ─────────────────────────────────────────────────────────────
function bind(id, prop, cast = (x) => x) {
  $(id).addEventListener(prop === "checked" ? "change" : "input", () => {
    const val = cast($(id)[prop]);
    chrome.storage.local.set({ [id]: val });
    if (id === "display") refreshUI(val);
    if (id === "dotSize") $("dotSizeVal").textContent = $(id).value;
    if (id === "enabled") {
      $("statusDot").className = val ? "dot-active" : "dot-inactive";
      $("statusText").textContent = val ? "Active" : "Disabled";
    }
  });
}
bind("enabled", "checked");
bind("prefetch", "checked");
bind("debug", "checked");
bind("puterModel", "value");
bind("openrouterModel", "value");
bind("openrouterKey", "value");
bind("googleKey", "value");
bind("googleModel", "value");
bind("display", "value");
bind("dotSize", "value", (v) => parseInt(v, 10));

// ─── Test AI connection ───────────────────────────────────────────────────────
const TEST_MESSAGES = [
  { role: "system", content: "You are a quiz solver. Reply with ONLY one word, no punctuation." },
  { role: "user", content: "What is the capital of France?" },
];
const TEST_EXPECTED = /pari[sz]/i;
const normTest = (t) =>
  String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

async function getOrCreateInjectableTab() {
  const tabs = await chrome.tabs.query({});
  const good = tabs.find((t) => /^https?:\/\//.test(t.url || ""));
  if (good) return { tab: good, created: false };
  const tab = await chrome.tabs.create({ url: "https://puter.com/", active: false });
  await new Promise((resolve) => {
    const l = (id, info) => {
      if (id === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(l);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(l);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(l); resolve(); }, 8000);
  });
  return { tab, created: true };
}

$("test").addEventListener("click", async () => {
  const out = $("testOut");
  const btn = $("test");
  out.textContent = "Testing…";
  out.className = "visible";
  btn.disabled = true;
  const t0 = performance.now();

  try {
    const provider = document.querySelector(".provider-tab.active")?.dataset.provider || "google";

    if (provider === "google") {
      const key = $("googleKey").value.trim();
      const model = $("googleModel").value;
      if (!key) { out.textContent = "✗ Missing Google AI Studio API key"; out.className = "visible err"; return; }

      // Build Gemini request
      const body = {
        contents: [{ role: "user", parts: [{ text: "What is the capital of France? Reply with only one word." }] }],
        systemInstruction: { parts: [{ text: "You are a quiz solver. Reply with ONLY one word." }] },
        generationConfig: { temperature: 0, maxOutputTokens: 16 },
      };
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      const dt = ((performance.now() - t0) / 1000).toFixed(2);
      if (r.ok) {
        const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
        const valid = TEST_EXPECTED.test(normTest(text));
        out.textContent = `${valid ? "✓" : "⚠"} (${dt}s) ${model}\n→ "${text || "(empty)"}"`;
        out.className = "visible " + (valid ? "ok" : "err");
      } else {
        out.textContent = `✗ (${dt}s) ${j?.error?.message || "HTTP " + r.status}`;
        out.className = "visible err";
      }
    } else if (provider === "openrouter") {
      const key = $("openrouterKey").value.trim();
      const model = $("openrouterModel").value;
      if (!key) { out.textContent = "✗ Missing OpenRouter API key"; out.className = "visible err"; return; }

      const isReasoning = /reasoning|nemotron/i.test(model);
      const body = {
        model,
        messages: TEST_MESSAGES,
        max_tokens: isReasoning ? 3072 : 32,
        temperature: 0,
        top_p: 0.1,
        provider: { sort: "throughput", allow_fallbacks: true },
      };
      if (isReasoning) body.reasoning = { exclude: true };
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "HTTP-Referer": "https://kahoot.it/",
          "X-Title": "Kahoot AI Helper",
        },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      const dt = ((performance.now() - t0) / 1000).toFixed(2);
      if (r.ok) {
        const text = (j?.choices?.[0]?.message?.content || j?.choices?.[0]?.message?.reasoning || "").trim();
        const valid = TEST_EXPECTED.test(normTest(text));
        out.textContent = `${valid ? "✓" : "⚠"} (${dt}s) ${model}\n→ "${text || "(empty)"}"`;
        out.className = "visible " + (valid ? "ok" : "err");
      } else {
        out.textContent = `✗ (${dt}s) ${j?.error?.message || "HTTP " + r.status}`;
        out.className = "visible err";
      }
    } else {
      // Puter
      let created = false, tabId;
      try {
        const res = await getOrCreateInjectableTab();
        created = res.created; tabId = res.tab.id;
        const models = [...new Set([$("puterModel").value, ...PUTER_MODELS])];
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: async (models) => {
            if (!window.puter) {
              await new Promise((res, rej) => {
                const s = document.createElement("script");
                s.src = "https://js.puter.com/v2/";
                s.onload = res;
                s.onerror = () => rej(new Error("puter.js load failed"));
                document.head.appendChild(s);
              });
            }
            let last = "";
            for (const model of models) {
              try {
                const r = await window.puter.ai.chat(
                  [
                    { role: "system", content: "You are a quiz solver. Reply with ONLY one word." },
                    { role: "user", content: "What is the capital of France?" },
                  ],
                  { model, temperature: 0, max_tokens: 16 }
                );
                const text = typeof r === "string" ? r : (r?.message?.content ?? r?.text ?? "");
                const t = String(typeof text === "string" ? text : JSON.stringify(text)).trim();
                if (/pari[sz]/i.test(t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""))) {
                  return { ok: true, model, raw: t };
                }
                last = `${model}: "${t.slice(0, 80)}"`;
              } catch (e) {
                last = `${model}: ${e?.message || String(e)}`;
              }
            }
            return { ok: false, error: last };
          },
          args: [models],
        });
        const dt = ((performance.now() - t0) / 1000).toFixed(2);
        if (result?.ok) {
          out.textContent = `✓ (${dt}s) ${result.model}\n→ "${result.raw}"`;
          out.className = "visible ok";
        } else {
          out.textContent = `✗ (${dt}s) ${result?.error}`;
          out.className = "visible err";
        }
      } finally {
        if (created && tabId) setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 1500);
      }
    }
  } catch (e) {
    out.textContent = "✗ " + (e?.message || String(e));
    out.className = "visible err";
  } finally {
    btn.disabled = false;
  }
});
