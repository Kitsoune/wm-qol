// Wiki Masters QoL — Background Service Worker
// Reçoit les données interceptées depuis inject.js (via content.js) et les stocke.
// Fonctionne même quand la page est en arrière-plan ou que l'onglet est inactif.

const PRICES_KEY = "wmq_prices";
const IDS_KEY = "wmq_ids2";
const CHECKED_KEY = "wmq_checked";
const META_KEY = "wmq_ids_full_ts3";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
const rarityCode = (s) => (typeof s === "string" ? s.trim().toUpperCase() : "");

// ── Merge helpers (identiques à content.js pour cohérence) ──────────────────

function mergePrices(a, b) {
  const out = {};
  for (const src of [a || {}, b || {}]) {
    for (const [k, e] of Object.entries(src)) {
      const cur = out[k];
      if (!cur) {
        out[k] = { name: e.name, byRarity: { ...e.byRarity }, ts: e.ts || 0 };
        continue;
      }
      const newer = (e.ts || 0) >= cur.ts;
      out[k] = {
        name: cur.name,
        byRarity: newer ? { ...cur.byRarity, ...e.byRarity } : { ...e.byRarity, ...cur.byRarity },
        ts: Math.max(cur.ts, e.ts || 0),
      };
    }
  }
  return out;
}

function maxMerge(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) out[k] = Math.max(out[k] || 0, v);
  return out;
}

// ── Batch write (évite de spammer chrome.storage) ───────────────────────────

let pendingPrices = null;  // prix à écrire
let pendingIds = null;     // ids à écrire
let pendingChecked = null; // checked à écrire
let flushTimer = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 1500);
}

async function flush() {
  flushTimer = null;
  const toWrite = {};

  if (pendingPrices) {
    const r = await chrome.storage.local.get(PRICES_KEY);
    const merged = mergePrices(r[PRICES_KEY] || {}, pendingPrices);
    toWrite[PRICES_KEY] = merged;
    pendingPrices = null;
  }

  if (pendingIds) {
    const r = await chrome.storage.local.get(IDS_KEY);
    const merged = { ...(r[IDS_KEY] || {}), ...pendingIds };
    toWrite[IDS_KEY] = merged;
    pendingIds = null;
  }

  if (pendingChecked) {
    const r = await chrome.storage.local.get(CHECKED_KEY);
    const merged = maxMerge(r[CHECKED_KEY] || {}, pendingChecked);
    toWrite[CHECKED_KEY] = merged;
    pendingChecked = null;
  }

  if (Object.keys(toWrite).length) {
    await chrome.storage.local.set(toWrite);
  }
}

// ── Traitement d'une réponse summary (prix) ──────────────────────────────────
// Format : { wikipedia_title, summary: { L: { average: 508 } } }

function handleSummary(node, cardId) {
  if (!node?.summary || !node.wikipedia_title) return false;
  const byRarity = {};
  let got = false;
  for (const [code, v] of Object.entries(node.summary)) {
    if (v && typeof v.average === "number") {
      byRarity[code.toUpperCase()] = Math.round(v.average);
      got = true;
    }
  }
  if (!got) return false;

  const key = norm(node.wikipedia_title);
  pendingPrices = pendingPrices || {};
  const cur = pendingPrices[key] || { name: node.wikipedia_title, byRarity: {}, ts: 0 };
  Object.assign(cur.byRarity, byRarity);
  cur.ts = Date.now();
  pendingPrices[key] = cur;

  // Si on a l'UUID, on le mémorise comme "checked"
  if (cardId && UUID_RE.test(cardId)) {
    pendingChecked = pendingChecked || {};
    pendingChecked[cardId] = Date.now();
  }

  scheduleFlush();
  return true;
}

// ── Traitement d'une réponse /api/my-collection ──────────────────────────────

function handleCollection(data) {
  if (!Array.isArray(data?.collection)) return;
  let dirty = false;
  const agg = {};
  for (const it of data.collection) {
    const c = it?.card;
    if (!c?.id || !UUID_RE.test(c.id) || typeof c.wikipedia_title !== "string") continue;
    const a = agg[c.id] || (agg[c.id] = { name: c.wikipedia_title, rarity: rarityCode(c.rarity), count: 0 });
    a.count += Number(it.count) || 1;
  }
  for (const [id, a] of Object.entries(agg)) {
    pendingIds = pendingIds || {};
    pendingIds[id] = a;
    dirty = true;
  }
  if (dirty) scheduleFlush();
}

// ── Écoute des messages depuis content.js ───────────────────────────────────
// content.js fait chrome.runtime.sendMessage({ type: "wmq-bg", url, data })

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "wmq-bg") return false;

  const { url, data } = msg;
  if (!url || !data) return false;

  // Prix d'une carte spécifique
  const mSales = /\/api\/marketplace\/cards\/([0-9a-f-]{36})\/sales/i.exec(url);
  if (mSales) {
    handleSummary(data, mSales[1]);
    sendResponse({ ok: true });
    return false;
  }

  // Collection complète
  if (/\/api\/my-collection/i.test(url)) {
    handleCollection(data);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// ── Keep-alive (MV3 : le SW peut s'endormir) ─────────────────────────────────
// On garde le SW éveillé pendant un scan en répondant aux pings de content.js.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "wmq-ping") return false; // juste maintenir éveillé
  return false;
});
