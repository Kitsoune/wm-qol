// Wiki Masters QoL — inject.js (MAIN world)
// Écoute passivement les réponses JSON du site et les transmet au content script.
(() => {
  if (window.__wmQolHooked) return;
  window.__wmQolHooked = true;

  // Nettoie tout ancien override résiduel
  try {
    sessionStorage.removeItem("__wmq_global_sort");
  } catch (_) {}

  const URL_RE = /\/api\/|rest\/v1|supabase|cards|mine|sales|market/i;

  const emit = (url, data) => {
    try {
      window.postMessage({ source: "wm-qol", url: String(url), data }, "*");
    } catch (_) {}
  };

  // ── Écoute passive de fetch ───────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
      if (url && URL_RE.test(url)) {
        res.clone().json().then((d) => emit(url, d)).catch(() => {});
      }
    } catch (_) {}
    return res;
  };

  // ── Écoute passive de XHR ─────────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (url && URL_RE.test(String(url))) {
      this.addEventListener("load", () => {
        try {
          emit(url, JSON.parse(this.responseText));
        } catch (_) {}
      });
    }
    return origOpen.call(this, method, url, ...rest);
  };
})();
