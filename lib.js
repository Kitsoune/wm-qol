const WMQ = (() => {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const rarityCode = (s) => (typeof s === "string" ? s.trim().toUpperCase() : "");

  function entryPrice(entry, code) {
    if (!entry?.byRarity) return NaN;
    if (code && entry.byRarity[code] != null) return entry.byRarity[code];
    const vals = Object.values(entry.byRarity);
    return vals.length ? Math.max(...vals) : NaN;
  }

  function priceOf(prices, name, rarity) {
    const e = prices[norm(name)];
    if (!e?.byRarity) return NaN;
    if (rarity && e.byRarity[rarity] != null) return e.byRarity[rarity];
    return !rarity || Object.keys(e.byRarity).length === 1 ? entryPrice(e, "") : NaN;
  }

  function mergePrices(a, b) {
    const out = {};
    for (const src of [a || {}, b || {}]) {
      for (const [k, e] of Object.entries(src)) {
        const cur = out[k];
        if (!cur) {
          out[k] = { name: e.name, byRarity: { ...e.byRarity }, prev: { ...e.prev }, ts: e.ts || 0 };
          continue;
        }
        const newer = (e.ts || 0) >= cur.ts;
        out[k] = {
          name: cur.name,
          byRarity: newer ? { ...cur.byRarity, ...e.byRarity } : { ...e.byRarity, ...cur.byRarity },
          prev: newer ? { ...cur.prev, ...e.prev } : { ...e.prev, ...cur.prev },
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

  const globalActive = (v) => v.scope === "all" && (v.sort !== "off" || v.rar.length > 0 || v.dup);

  function viewList(list, prices, ids, view) {
    let rows = list.map((it) => ({ it, r: rarityCode(it.card.rarity), p: priceOf(prices, it.card.wikipedia_title, rarityCode(it.card.rarity)) }));
    if (view.rar.length) rows = rows.filter((x) => view.rar.includes(x.r));
    if (view.dup) rows = rows.filter((x) => (ids[x.it.card.id]?.count || Number(x.it.count) || 1) > 1);
    if (view.sort !== "off") {
      const dir = view.sort === "desc" ? -1 : 1;
      const has = (x) => Number.isFinite(x.p);
      rows.sort((a, b) => (has(a) ? 0 : 1) - (has(b) ? 0 : 1) || (has(a) ? dir * (a.p - b.p) : 0));
    }
    return rows.map((x) => x.it);
  }

  return { norm, rarityCode, entryPrice, priceOf, mergePrices, maxMerge, globalActive, viewList };
})();

if (typeof module !== "undefined") module.exports = WMQ;
