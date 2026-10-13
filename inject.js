(() => {
  if (window.__wmQolHooked) return;
  window.__wmQolHooked = true;

  const COLLECTION_RE = /\/api\/my-collection(?:[?#]|$)/i;
  const SALES_RE = /\/api\/marketplace\/cards\/[0-9a-f-]{36}\/sales/i;
  const VIEW_FLAG = "wmq_view";

  const emit = (url, data) => {
    try {
      window.postMessage({ source: "wm-qol", url, data }, location.origin);
    } catch (_) {}
  };

  let seq = 0;
  const askView = (url, data) =>
    new Promise((resolve) => {
      const id = ++seq;
      const msg = { source: "wm-qol", type: "view-req", id, url, total: data.total, size: data.collection.length };
      const done = (v) => {
        clearInterval(retry);
        clearTimeout(giveUp);
        window.removeEventListener("message", onMsg);
        resolve(v);
      };
      const onMsg = (e) => {
        if (e.source === window && e.data?.source === "wm-qol-cs" && e.data.id === id) done(e.data.view);
      };
      window.addEventListener("message", onMsg);
      const post = () => window.postMessage(msg, location.origin);
      const retry = setInterval(post, 200);
      const giveUp = setTimeout(() => done(null), 5000);
      post();
    });

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const a = args[0];
      const url = typeof a === "string" ? a : a?.url || String(a);
      const isCollection = COLLECTION_RE.test(url);
      if (!res.ok || (!isCollection && !SALES_RE.test(url))) return res;
      const data = await res.clone().json();
      emit(url, data);
      if (isCollection && Array.isArray(data?.collection) && localStorage.getItem(VIEW_FLAG) === "1") {
        const view = await askView(url, data);
        if (view) {
          const body = { ...data, collection: view.items };
          if (Number.isFinite(data.total)) body.total = view.total;
          return new Response(JSON.stringify(body), {
            status: res.status,
            statusText: res.statusText,
            headers: { "content-type": "application/json" },
          });
        }
      }
    } catch (_) {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (url && (COLLECTION_RE.test(String(url)) || SALES_RE.test(String(url)))) {
      this.addEventListener("load", () => {
        try {
          emit(String(url), JSON.parse(this.responseText));
        } catch (_) {}
      });
    }
    return origOpen.call(this, method, url, ...rest);
  };
})();
