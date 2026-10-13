(() => {
  const { norm, rarityCode, entryPrice, priceOf, mergePrices, maxMerge, globalActive, viewList } = WMQ;

  const K = {
    prices: "wmq_prices",
    ids: "wmq_ids2",
    checked: "wmq_checked",
    idsTs: "wmq_ids_full_ts3",
    raw: "wmq_raw",
    view: "wmq_view2",
    settings: "wmq_settings",
    hist: "wmq_hist",
    collapsed: "wmq_collapsed",
  };
  const VIEW_FLAG = "wmq_view";
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const FOREIGN_PARAM_RE = /^(user|user_?id|username|profile|friend|owner|player|id)$/i;
  const SITE_PARAMS = new Set(["sort", "page", "stats", "limit", "per_page", "pageSize"]);
  const RARITIES = ["L", "UR", "SR", "R", "PC", "C"];
  const COOLDOWN_MS = 10 * 1000;
  const MAX_REFUSALS = 30;
  const PAGE_DELAY_MS = 100;
  const PAGE_CONCURRENCY = 4;
  const FRESH_MS = 10 * 60 * 1000;
  const MAX_PAGES = 500;
  const IDS_REUSE_MS = 60 * 60 * 1000;
  const OLD_PRICE_MS = 7 * 24 * 3600 * 1000;
  const HIST_DAYS = 90;

  let prices = {};
  let ids = {};
  let checked = {};
  let idsFullTs = 0;
  let raw = { list: [], total: null, pageSize: 0, ts: 0 };
  let view = { sort: "off", scope: "all", rar: [], dup: false };
  let draft = null;
  let viewNote = "";
  let settings = { badges: true, dupBadges: true, compact: false, gentle: false, left: false, highlight: 0 };
  let hist = {};
  let collapsed = false;
  let tab = "vue";
  let listQuery = "";
  let scanning = false;
  let stopRequested = false;
  let progress = { text: "", pct: null };
  let visibleTiles = 0;

  const firstLetter = (s) =>
    (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().charAt(0).toUpperCase();
  const toNum = (s) => {
    const d = String(s).replace(/[^\d]/g, "");
    return d ? parseInt(d, 10) : NaN;
  };
  const fmt = (n) => n.toLocaleString("fr-FR");
  const compactFmt = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });
  const fmtC = (n) => (Math.abs(n) >= 1000000 ? compactFmt.format(n) : fmt(Math.round(n)));
  const fmtP = (n) => (settings.compact && Math.abs(n) >= 10000 ? compactFmt.format(n) : fmt(n));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const today = () => new Date().toLocaleDateString("sv-SE");

  const hasForeignParam = (search) => [...new URLSearchParams(search).keys()].some((k) => FOREIGN_PARAM_RE.test(k));
  const ownPage = () => location.pathname.replace(/\/+$/, "") === "/collection" && !hasForeignParam(location.search);
  const ownCollectionUrl = (url) => {
    try {
      const u = new URL(url, location.origin);
      return /\/api\/my-collection\/?$/i.test(u.pathname) && !hasForeignParam(u.search);
    } catch (_) {
      return false;
    }
  };

  let saveTimer = null;
  const savePrices = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flushPrices();
    }, 1500);
  };
  function flushPrices() {
    chrome.storage.local.get(K.prices, (r) => {
      prices = mergePrices(r[K.prices], prices);
      chrome.storage.local.set({ [K.prices]: prices });
    });
  }

  const saveIds = () =>
    chrome.storage.local.get(K.ids, (r) => {
      ids = { ...(r[K.ids] || {}), ...ids };
      chrome.storage.local.set({ [K.ids]: ids });
    });

  let checkedTimer = null;
  function saveChecked() {
    if (checkedTimer) return;
    checkedTimer = setTimeout(() => {
      checkedTimer = null;
      flushChecked();
    }, 1500);
  }
  function flushChecked() {
    chrome.storage.local.get(K.checked, (r) => {
      checked = maxMerge(r[K.checked], checked);
      chrome.storage.local.set({ [K.checked]: checked });
    });
  }

  const saveSettings = () => chrome.storage.local.set({ [K.settings]: settings });

  function nameRarityMap() {
    const m = {};
    for (const info of Object.values(ids)) {
      const k = norm(info.name);
      if (info.rarity && !m[k]) m[k] = info.rarity;
    }
    return m;
  }

  function countMap() {
    const m = {};
    for (const info of Object.values(ids)) {
      const n = Number(info.count) || 1;
      const k = norm(info.name);
      m[`${k}|${info.rarity || ""}`] = (m[`${k}|${info.rarity || ""}`] || 0) + n;
      m[k] = (m[k] || 0) + n;
    }
    return m;
  }

  function setPrice(name, code, avg) {
    if (!name || !code || !Number.isFinite(avg)) return;
    const key = norm(name);
    const e = prices[key] || { name, byRarity: {}, prev: {}, ts: 0 };
    const old = e.byRarity[code];
    if (old != null && old !== avg) (e.prev || (e.prev = {}))[code] = old;
    e.byRarity[code] = avg;
    e.ts = Date.now();
    prices[key] = e;
    savePrices();
    scheduleUI();
  }

  function handleSummary(node) {
    if (!node || typeof node !== "object" || !node.summary || !node.wikipedia_title) return false;
    let got = false;
    for (const [code, v] of Object.entries(node.summary)) {
      if (v && typeof v.average === "number") {
        setPrice(node.wikipedia_title, code.toUpperCase(), Math.round(v.average));
        got = true;
      }
    }
    return got ? "price" : "empty";
  }

  function collectCollection(data) {
    if (!Array.isArray(data?.collection)) return false;
    const agg = {};
    for (const it of data.collection) {
      const c = it?.card;
      if (!c?.id || !UUID_RE.test(c.id) || typeof c.wikipedia_title !== "string") continue;
      const a = agg[c.id] || (agg[c.id] = { name: c.wikipedia_title, rarity: rarityCode(c.rarity), count: 0 });
      a.count += Number(it.count) || 1;
    }
    let dirty = false;
    for (const [id, a] of Object.entries(agg)) {
      const cur = ids[id];
      if (!cur || cur.name !== a.name || cur.rarity !== a.rarity || cur.count !== a.count) {
        ids[id] = a;
        dirty = true;
      }
    }
    return dirty;
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.source !== "wm-qol") return;
    try {
      if (e.data.type === "view-req") return answerView(e.data);
      const url = String(e.data.url || "");
      const m = /cards\/([0-9a-f-]{36})\/sales/i.exec(url);
      if (m) {
        if (ids[m[1].toLowerCase()] || ids[m[1]]) handleSummary(e.data.data);
        return;
      }
      if (ownCollectionUrl(url) && collectCollection(e.data.data)) {
        saveIds();
        schedule();
      }
    } catch (_) {}
  });

  function scanAuctionPanel() {
    if (!ownPage()) return;
    let owned = null;
    for (const el of document.querySelectorAll("div, section, aside")) {
      const t = el.innerText;
      if (!t || t.length > 400 || !/MOYENNE/i.test(t) || !/MARCH[ÉE]\s*·/i.test(t)) continue;
      if ([...el.children].some((c) => /MOYENNE/i.test(c.innerText || "") && /MARCH[ÉE]\s*·/i.test(c.innerText || ""))) continue;
      const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
      const iM = lines.findIndex((l) => /^MARCH[ÉE]\s*·/i.test(l));
      const iA = lines.findIndex((l) => /^MOYENNE$/i.test(l));
      if (iM < 1 || iA < 0) continue;
      const name = lines[iM - 1];
      owned = owned || nameRarityMap();
      if (!(norm(name) in owned)) continue;
      const code = owned[norm(name)] || firstLetter(lines[iM].split("·")[1]);
      const avg = lines.slice(iA + 1).map(toNum).find(Number.isFinite);
      if (Number.isFinite(avg)) setPrice(name, code, avg);
    }
  }

  const syncFlag = () => {
    try {
      if (globalActive(view)) localStorage.setItem(VIEW_FLAG, "1");
      else localStorage.removeItem(VIEW_FLAG);
    } catch (_) {}
  };

  const answered = new Set();
  function answerView(req) {
    if (answered.has(req.id)) return;
    answered.add(req.id);
    const reply = (v) => window.postMessage({ source: "wm-qol-cs", id: req.id, view: v }, location.origin);
    const note = (t) => {
      if (viewNote === t) return;
      viewNote = t;
      if (tab === "vue") renderBody();
    };
    if (!globalActive(view) || !ownPage() || !ownCollectionUrl(req.url)) return reply(null);
    const params = new URL(req.url, location.origin).searchParams;
    const siteFilter = [...params].find(([k, v]) => !SITE_PARAMS.has(k) && v && !/^(all|tous|false|0)$/i.test(v));
    if (siteFilter) {
      note(`Vue globale en pause : filtre du site actif (${siteFilter.join(" = ")}).`);
      return reply(null);
    }
    if (!raw.list.length || (Number.isFinite(req.total) && Number.isFinite(raw.total) && req.total !== raw.total)) {
      reply(null);
      return resync();
    }
    const list = viewList(raw.list, prices, ids, view);
    const size = Number(params.get("limit") || params.get("per_page") || params.get("pageSize")) || raw.pageSize || req.size || 24;
    const page = Math.max(1, parseInt(params.get("page"), 10) || 1);
    note("");
    reply({ items: list.slice((page - 1) * size, page * size), total: list.length });
  }

  async function resync() {
    if (scanning) return;
    const last = Number(sessionStorage.getItem("wmq_resync")) || 0;
    if (Date.now() - last < 60000) {
      viewNote = "Vue globale indisponible : la liste ne correspond pas à ta collection. Lance « Tout rafraîchir ».";
      return renderBody();
    }
    sessionStorage.setItem("wmq_resync", String(Date.now()));
    toast("Ta collection a changé : mise à jour de la liste des cartes…", false);
    if (await scanAll("list")) location.reload();
  }

  function setView(patch) {
    const next = { ...(draft || view), ...patch };
    if (!globalActive(view) && !globalActive(next)) commitView(next, false);
    else {
      draft = JSON.stringify(next) === JSON.stringify(view) ? null : next;
      renderBody();
    }
  }

  async function commitView(next, reload) {
    if (reload && scanning) return toast("Un scan est en cours : applique la vue quand il est terminé.", true);
    view = next;
    draft = null;
    viewNote = "";
    syncFlag();
    await chrome.storage.local.set({ [K.view]: view });
    if (reload && ownPage()) {
      const stale = !raw.list.length || Date.now() - raw.ts > FRESH_MS;
      if (!globalActive(view) || !stale || (await scanAll("list"))) return location.reload();
    }
    renderBody();
    refreshUI();
  }

  let refusals = 0;
  let pauseUntil = 0;
  let okStreak = 0;
  let refusalReason = "";

  async function onRefusal(res) {
    okStreak = 0;
    if (Date.now() < pauseUntil) return true;
    let snippet = "";
    try {
      snippet = (await res.text()).replace(/\s+/g, " ").trim().slice(0, 120);
    } catch (_) {}
    if (++refusals > MAX_REFUSALS) {
      refusalReason = `Le serveur refuse les requêtes (HTTP ${res.status})${snippet ? ` : « ${snippet} »` : ""}`;
      return false;
    }
    pauseUntil = Date.now() + COOLDOWN_MS;
    return true;
  }

  async function waitIfPaused() {
    while (Date.now() < pauseUntil && !stopRequested) {
      setProgress(`Pause ${Math.ceil((pauseUntil - Date.now()) / 1000)} s : le serveur refuse (essai ${refusals}/${MAX_REFUSALS})…`, progress.pct);
      await sleep(1000);
    }
  }

  async function fetchCollectionPage(page, stats, abort, shouldStop) {
    let failures = 0;
    while (!shouldStop()) {
      await waitIfPaused();
      if (shouldStop()) return null;
      let res;
      try {
        res = await fetch(`/api/my-collection?sort=rarity&page=${page}&stats=${stats}`, { credentials: "same-origin" });
      } catch (_) {
        if (++failures >= 5) {
          abort("Erreur réseau répétée");
          return null;
        }
        await sleep(2000);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (++failures >= 5) {
          abort(res.status === 429 ? "Trop de requêtes (HTTP 429) en lisant la collection" : `Erreur serveur (HTTP ${res.status}) en lisant la collection`);
          return null;
        }
        await sleep(3000 * failures);
        continue;
      }
      if (res.status === 401) {
        abort("Session expirée (HTTP 401) : reconnecte-toi");
        return null;
      }
      if (res.status === 403) {
        if (!(await onRefusal(res))) {
          abort(refusalReason);
          return null;
        }
        continue;
      }
      if (!res.ok) {
        abort(`Lecture de la collection impossible (HTTP ${res.status})`);
        return null;
      }
      try {
        return await res.json();
      } catch (_) {
        abort("Réponse de la collection illisible");
        return null;
      }
    }
    return null;
  }

  async function loadAllPages(abort, shouldStop) {
    const results = new Map();
    let total = null;
    let pageSize = 0;
    const build = (complete) => {
      const found = {};
      const list = [];
      for (const p of [...results.keys()].sort((a, b) => a - b)) {
        for (const it of results.get(p)) {
          const c = it?.card;
          if (!c?.id || !UUID_RE.test(c.id) || typeof c.wikipedia_title !== "string") continue;
          list.push(it);
          const n = Number(it.count) || 1;
          if (found[c.id]) found[c.id].count += n;
          else found[c.id] = { name: c.wikipedia_title, rarity: rarityCode(c.rarity), count: n };
        }
      }
      return { found, list, total, pageSize, complete };
    };
    const itemsOf = (d) => (Array.isArray(d?.collection) ? d.collection : []);

    setProgress("Collection : page 1…");
    const first = await fetchCollectionPage(1, 1, abort, shouldStop);
    if (!first) return build(false);
    const firstItems = itemsOf(first);
    if (!firstItems.length) return build(true);
    results.set(1, firstItems);
    pageSize = firstItems.length;
    if (Number.isFinite(first.total)) total = first.total;

    const lastPage = total > 0 ? Math.min(MAX_PAGES, Math.ceil(total / pageSize)) : null;
    if (lastPage) {
      let next = 2;
      const pageWorker = async () => {
        while (!shouldStop() && next <= lastPage) {
          const p = next++;
          const data = await fetchCollectionPage(p, 0, abort, shouldStop);
          if (!data) return;
          results.set(p, itemsOf(data));
          setProgress(`Collection : ${results.size}/${lastPage} pages…`, results.size / lastPage);
          await sleep(PAGE_DELAY_MS);
        }
      };
      await Promise.all(Array.from({ length: PAGE_CONCURRENCY }, pageWorker));
      if (shouldStop() || results.size < lastPage) return build(false);
    }

    let page = (lastPage || 1) + 1;
    let prevFirst = null;
    while (page <= MAX_PAGES && !shouldStop()) {
      setProgress(`Collection : page ${page}…`);
      const data = await fetchCollectionPage(page, 0, abort, shouldStop);
      if (!data) return build(false);
      const items = itemsOf(data);
      if (!items.length) return build(true);
      if (items[0].id === prevFirst) return build(true);
      prevFirst = items[0].id;
      results.set(page, items);
      page++;
      await sleep(PAGE_DELAY_MS);
    }
    return build(false);
  }

  async function scanAll(mode) {
    if (scanning) return false;
    scanning = true;
    stopRequested = false;
    refusals = 0;
    pauseUntil = 0;
    okStreak = 0;
    refusalReason = "";
    let aborted = false;
    let abortReason = "";
    const abort = (reason) => {
      if (!aborted) {
        aborted = true;
        abortReason = reason;
      }
    };
    setProgress("Démarrage…");

    let complete = true;
    const reuse = mode === "new" && raw.list.length && Date.now() - idsFullTs < IDS_REUSE_MS && Object.keys(ids).length > 0;
    if (!reuse) {
      const r = await loadAllPages(abort, () => stopRequested || aborted);
      complete = r.complete;
      if (r.complete) {
        ids = r.found;
        idsFullTs = Date.now();
        raw = { list: r.list, total: r.total, pageSize: r.pageSize, ts: idsFullTs };
        chrome.storage.local.set({ [K.idsTs]: idsFullTs, [K.ids]: ids, [K.raw]: raw }, () => {
          if (chrome.runtime.lastError) toast(`Liste des cartes non enregistrée : ${chrome.runtime.lastError.message}`, true);
        });
      } else {
        Object.assign(ids, r.found);
        saveIds();
      }
    }

    if (mode === "list") {
      scanning = false;
      const ok = complete && !aborted && !stopRequested;
      if (aborted) toast(`Lecture de la collection arrêtée : ${abortReason}.`, true);
      setProgress(ok ? "" : "Liste des cartes incomplète");
      refreshUI();
      return ok;
    }

    const queue = Object.entries(ids).filter(([id, info]) => {
      const c = prices[norm(info.name)];
      const has = c && (info.rarity ? c.byRarity[info.rarity] != null : Object.keys(c.byRarity).length);
      const ck = checked[id] || 0;
      if (mode === "new") return !has && !ck;
      const last = Math.max(ck, has ? c.ts : 0);
      return !last || Date.now() - last >= FRESH_MS;
    });
    queue.sort(([idA], [idB]) => (checked[idA] || 0) - (checked[idB] || 0));
    const total = queue.length;
    const t0 = Date.now();
    let idx = 0;
    let done = 0;
    let failures = 0;
    let okCount = 0;
    let skipped = 0;
    let limit = settings.gentle ? 2 : 4;
    const delay = settings.gentle ? 500 : 200;
    let probeMode = false;

    const worker = async (wi) => {
      while (!stopRequested && !aborted && idx < queue.length) {
        await waitIfPaused();
        if (stopRequested || aborted || wi >= limit) break;
        if (probeMode && wi !== 0) {
          await sleep(500);
          continue;
        }
        const item = queue[idx++];
        const [id] = item;
        try {
          const res = await fetch(`/api/marketplace/cards/${id}/sales?scope=summary`, { credentials: "same-origin" });
          if (res.status === 429 || res.status >= 500) {
            failures++;
            if (failures >= 6) {
              abort(res.status === 429 ? "Trop de requêtes (HTTP 429), le serveur demande de ralentir" : `Erreur serveur (HTTP ${res.status})`);
              break;
            }
            queue.push(item);
            await sleep(3000 * failures);
            continue;
          }
          if (res.status === 401) {
            abort("Session expirée (HTTP 401) : reconnecte-toi");
            break;
          }
          if (res.status === 403) {
            if (!(await onRefusal(res))) {
              abort(refusalReason);
              break;
            }
            limit = Math.min(limit, 2);
            probeMode = true;
            queue.push(item);
            continue;
          }
          if (res.ok || res.status === 404) {
            let r = false;
            if (res.ok) {
              try {
                r = handleSummary(await res.json());
              } catch (_) {}
            }
            checked[id] = Date.now();
            saveChecked();
            if (r === "price") okCount++;
            else skipped++;
          } else {
            skipped++;
          }
          probeMode = false;
          if (++okStreak >= 20) refusals = 0;
        } catch (_) {
          if (++failures >= 6) {
            abort("Erreur réseau répétée");
            break;
          }
          queue.push(item);
          await sleep(2000);
          continue;
        }
        done++;
        if (!aborted) {
          const n = Math.min(done, total);
          const left = Math.round(((Date.now() - t0) / n) * (total - n) / 1000);
          const eta = left >= 90 ? `${Math.round(left / 60)} min` : `${left} s`;
          setProgress(`Prix ${n}/${total}${n < total ? ` · reste ≈ ${eta}` : ""}`, n / total);
        }
        await sleep(delay);
      }
    };

    if (!aborted && !stopRequested) await Promise.all(Array.from({ length: 4 }, (_, i) => worker(i)));
    flushPrices();
    flushChecked();
    scanning = false;
    statsTs = 0;

    const nCards = Object.keys(ids).length;
    const remaining = Math.max(total - okCount - skipped, 0);
    if (aborted) {
      setProgress(`Scan arrêté : ${okCount}/${total} prix récupérés`);
      toast(`Scan arrêté — ${abortReason}.\n${nCards} cartes trouvées${complete ? "" : " (collection incomplète)"}, ${okCount}/${total} prix récupérés, ${remaining} restantes. Relance plus tard.`, true);
    } else if (stopRequested) {
      setProgress(`Interrompu : ${okCount}/${total} prix`);
    } else {
      snapshotValue();
      if (skipped > 0) {
        setProgress(`Terminé : ${nCards} cartes, ${skipped} sans prix`);
        toast(`${nCards} cartes analysées. ${skipped} sans prix de marché (probablement jamais vendues).`, false);
      } else setProgress(total ? `Prix à jour ✓ (${total} relevés)` : "Rien de nouveau : tous les prix sont déjà connus ✓");
    }
    refreshUI();
    return complete;
  }

  function snapshotValue() {
    const st = getStats(true);
    if (!st.pricedUnique) return;
    hist[today()] = Math.round(st.total);
    const keep = Object.keys(hist).sort().slice(-HIST_DAYS);
    hist = Object.fromEntries(keep.map((d) => [d, hist[d]]));
    chrome.storage.local.set({ [K.hist]: hist });
  }

  function tileCode(tile, entry, fallback) {
    for (const el of tile.querySelectorAll("*")) {
      if (el.children.length || el.closest(".wmq-badge")) continue;
      const t = el.textContent.trim().toUpperCase();
      if (/^[A-Z]{1,3}$/.test(t) && entry.byRarity[t] != null) return t;
    }
    return fallback || "";
  }

  function inModal(el) {
    for (let cur = el; cur && cur !== document.body; cur = cur.parentElement) {
      if (cur.getAttribute("role") === "dialog" || cur.getAttribute("aria-modal") === "true") return true;
      if (getComputedStyle(cur).position === "fixed") return true;
    }
    return false;
  }

  function findTiles() {
    const known = new Set(Object.keys(prices));
    if (!known.size) return [];
    const byName = nameRarityMap();
    const counts = countMap();
    const tiles = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const el = n.parentElement;
      if (!el || el.closest("#wmq-root, #wmq-stats, .wmq-badge, .wmq-toast")) continue;
      const key = norm(n.nodeValue);
      if (!known.has(key) || !(key in counts)) continue;
      if (inModal(el)) continue;
      let cur = el;
      let tile = null;
      for (let i = 0; i < 8 && cur && cur.parentElement; i++, cur = cur.parentElement) {
        if (cur.parentElement.children.length >= 3 && cur.querySelector("img")) {
          tile = cur;
          break;
        }
      }
      if (tile && !tiles.has(tile)) {
        const entry = prices[key];
        const code = tileCode(tile, entry, byName[key]);
        const count = counts[`${key}|${code}`] || counts[key] || 1;
        tiles.set(tile, { price: entryPrice(entry, code), prev: entry.prev?.[code], ts: entry.ts, count });
      }
    }
    const all = [...tiles.entries()].filter(([, v]) => Number.isFinite(v.price));
    return all.filter(([t]) => !all.some(([o]) => o !== t && t.contains(o)));
  }

  function clearDecorations() {
    document.querySelectorAll(".wmq-badge").forEach((b) => b.remove());
    document.querySelectorAll(".wmq-hot").forEach((t) => t.classList.remove("wmq-hot"));
    document.querySelectorAll("[data-wmq-order]").forEach((t) => {
      t.style.order = "";
      delete t.dataset.wmqOrder;
    });
  }

  function decorate() {
    const tiles = ownPage() ? findTiles() : [];
    visibleTiles = tiles.length;
    if (!tiles.length) clearDecorations();
    const tileSet = new Set(tiles.map(([t]) => t));
    document.querySelectorAll(".wmq-badge").forEach((b) => {
      if (!tileSet.has(b.parentElement)) b.remove();
    });
    document.querySelectorAll(".wmq-hot").forEach((t) => {
      if (!tileSet.has(t)) t.classList.remove("wmq-hot");
    });
    for (const [tile, v] of tiles) {
      if (getComputedStyle(tile).position === "static") tile.style.position = "relative";
      tile.classList.toggle("wmq-hot", settings.highlight > 0 && v.price >= settings.highlight);

      let b = tile.querySelector(":scope > .wmq-badge:not(.wmq-dup)");
      if (!settings.badges) b?.remove();
      else {
        if (!b) {
          b = document.createElement("div");
          b.className = "wmq-badge";
          tile.appendChild(b);
        }
        const trend = v.prev == null || v.prev === v.price ? "" : v.price > v.prev ? "up" : "down";
        const txt = `⌀ ${fmtP(v.price)}${trend ? (trend === "up" ? " ▲" : " ▼") : ""}`;
        if (b.textContent !== txt) b.textContent = txt;
        b.classList.toggle("up", trend === "up");
        b.classList.toggle("down", trend === "down");
        b.classList.toggle("old", Date.now() - v.ts > OLD_PRICE_MS);
        b.title =
          `Moyenne marché relevée le ${new Date(v.ts).toLocaleString("fr-FR")}` +
          (trend ? ` — avant : ${fmt(v.prev)}` : "") +
          (v.count > 1 ? ` — tu en as ${v.count}` : "");
      }

      let d = tile.querySelector(":scope > .wmq-badge.wmq-dup");
      if (v.count > 1 && settings.dupBadges) {
        if (!d) {
          d = document.createElement("div");
          d.className = "wmq-badge wmq-dup";
          tile.appendChild(d);
        }
        const dt = `×${v.count}`;
        if (d.textContent !== dt) d.textContent = dt;
        d.title = `Tu possèdes ${v.count} exemplaires`;
      } else if (d) d.remove();
    }
    applyPageSort(tiles);
    placeStatsChip();
    updateUI();
  }

  function applyPageSort(tiles) {
    const on = view.scope === "page" && view.sort !== "off";
    for (const parent of new Set(tiles.map(([t]) => t.parentElement))) {
      const priced = new Map(tiles.filter(([t]) => t.parentElement === parent));
      for (const child of parent.children) {
        if (on) {
          const v = priced.get(child);
          child.style.order = String(v ? (view.sort === "desc" ? -v.price : v.price) : 1e9);
          child.dataset.wmqOrder = "1";
        } else if (child.dataset.wmqOrder) {
          child.style.order = "";
          delete child.dataset.wmqOrder;
        }
      }
    }
  }

  function ownedRanking(includeUnpriced = false) {
    const rows = new Map();
    for (const info of Object.values(ids)) {
      const p = priceOf(prices, info.name, info.rarity);
      if (!Number.isFinite(p) && !includeUnpriced) continue;
      const key = `${info.name}|${info.rarity}`;
      const n = Number(info.count) || 1;
      const prev = rows.get(key);
      if (prev) prev.count += n;
      else rows.set(key, { name: info.name, rarity: info.rarity, price: p, count: n });
    }
    return [...rows.values()].sort((a, b) => (Number.isFinite(b.price) ? b.price : -1) - (Number.isFinite(a.price) ? a.price : -1));
  }

  function computeStats() {
    const rows = ownedRanking(true);
    const priced = rows.filter((r) => Number.isFinite(r.price));
    const totalCards = rows.reduce((t, r) => t + r.count, 0);
    const pricedCards = priced.reduce((t, r) => t + r.count, 0);
    const total = priced.reduce((t, r) => t + r.price * r.count, 0);
    const dupValue = priced.reduce((t, r) => t + r.price * (r.count - 1), 0);
    const mean = pricedCards ? total / pricedCards : 0;
    const asc = [...priced].sort((a, b) => a.price - b.price);
    const valueAt = (k) => {
      let cum = 0;
      for (const r of asc) {
        cum += r.count;
        if (k < cum) return r.price;
      }
      return 0;
    };
    const median = pricedCards ? (valueAt(Math.floor((pricedCards - 1) / 2)) + valueAt(Math.ceil((pricedCards - 1) / 2))) / 2 : 0;
    const byRarity = {};
    for (const r of rows) {
      const b = byRarity[r.rarity || "?"] || (byRarity[r.rarity || "?"] = { cards: 0, value: 0, priced: 0 });
      b.cards += r.count;
      if (Number.isFinite(r.price)) {
        b.value += r.price * r.count;
        b.priced += r.count;
      }
    }
    return {
      unique: rows.length, pricedUnique: priced.length, totalCards, pricedCards,
      total, mean, median, dupValue, top: priced[0] || null,
      byRarity: Object.entries(byRarity).sort((a, b) => b[1].value - a[1].value),
    };
  }

  let statsCache = null;
  let statsTs = 0;
  function getStats(force) {
    if (force || !statsCache || Date.now() - statsTs > 800) {
      statsCache = computeStats();
      statsTs = Date.now();
    }
    return statsCache;
  }

  function valueDelta(total) {
    const day = Object.keys(hist).filter((d) => d < today()).sort().pop();
    return day ? { diff: Math.round(total) - hist[day], day } : null;
  }

  function exportCsv() {
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [["Nom", "Rareté", "Quantité", "Prix moyen", "Valeur"].map(q).join(";")];
    for (const r of ownedRanking(true)) {
      const p = Number.isFinite(r.price) ? r.price : "";
      lines.push([q(r.name), q(r.rarity), r.count, p, p === "" ? "" : p * r.count].join(";"));
    }
    const a = h("a", { href: URL.createObjectURL(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv" })), download: `wiki-masters-collection-${today()}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
      else if (k in e) e[k] = v;
      else e.setAttribute(k, v);
    }
    e.append(...kids.filter((x) => x != null && x !== false));
    return e;
  }

  let chipParts = null;
  function placeStatsChip() {
    let chip = document.getElementById("wmq-stats");
    if (chip && !chipParts) {
      chip.remove();
      chip = null;
    }
    const st = getStats();
    if (!ownPage() || !st.pricedUnique) return chip?.remove();
    const heading = [...document.querySelectorAll("h1, h2")].find((hd) => {
      if (hd.closest("nav, aside, #wmq-root")) return false;
      const own = [...hd.childNodes].filter((n) => n !== chip).map((n) => n.textContent).join("");
      return /^collection$/i.test(norm(own));
    });
    if (!heading) return;
    if (!chip) {
      const stat = (label) => {
        const v = h("b");
        return { box: h("span", { className: "wmq-st" }, h("small", null, label), v), set: (t) => v.textContent !== t && (v.textContent = t) };
      };
      chipParts = { total: stat("Valeur du compte"), mean: stat("Moyenne / carte"), med: stat("Médiane"), cov: stat("Cartes avec prix") };
      chip = h("span", { id: "wmq-stats", on: { click: () => openTab("stats") } }, ...Object.values(chipParts).map((p) => p.box));
    }
    if (chip.parentElement !== heading) heading.appendChild(chip);
    chipParts.total.set(`≈ ${fmtC(st.total)}`);
    chipParts.mean.set(fmtC(st.mean));
    chipParts.med.set(fmtC(st.median));
    const partial = st.pricedUnique < st.unique;
    chipParts.cov.box.style.display = partial ? "" : "none";
    chipParts.cov.set(`${fmtC(st.pricedUnique)} / ${fmtC(st.unique)}`);
    chip.title =
      "Estimation d'après les prix moyens du marché.\nMoyenne : total ÷ nombre de cartes. Médiane : la moitié de tes cartes vaut moins.\n" +
      (partial ? `Seulement ${st.pricedUnique} cartes sur ${st.unique} ont un prix : lance le scan pour compléter.\n` : "") +
      "Clique pour voir le détail.";
  }

  let root, panel, fab, valueEl, deltaEl, statusEl, meterEl, btnScan, btnAll, tabsEl, bodyEl, listEl;
  const TABS = [["vue", "Vue"], ["top", "Top prix"], ["dup", "Doublons"], ["stats", "Stats"], ["opts", "Réglages"]];

  function setCollapsed(v) {
    collapsed = v;
    chrome.storage.local.set({ [K.collapsed]: v });
    updateUI();
    if (!v) renderBody();
  }
  function openTab(id) {
    tab = id;
    setCollapsed(false);
  }

  function buildUI() {
    if (root) return;
    const fav = document.querySelector('link[rel~="icon"]')?.href;
    const letter = h("span", null, "W");
    fab = h("button", { className: "wmq-fab", on: { click: () => setCollapsed(!collapsed) } }, letter);
    if (fav) {
      const img = h("img", { src: fav, alt: "" });
      img.addEventListener("load", () => letter.remove());
      img.addEventListener("error", () => img.remove());
      fab.append(img);
    }

    valueEl = h("b", { className: "wmq-value" });
    deltaEl = h("span", { className: "wmq-delta" });
    statusEl = h("div", { className: "wmq-status", role: "status" });
    meterEl = h("div", { className: "wmq-meter" }, h("i"));
    btnScan = h("button", {
      className: "wmq-btn primary",
      title: "Relève le prix des cartes jamais vérifiées (Alt+Maj+S)",
      on: { click: toggleScan },
    });
    btnAll = h("button", {
      className: "wmq-btn",
      title: "Relit ta collection et redemande les prix de plus de 10 min",
      on: { click: () => scanAll("all") },
    }, "Tout rafraîchir");
    tabsEl = h("div", { className: "wmq-tabs", role: "tablist" });
    for (const [id, label] of TABS) {
      tabsEl.append(h("button", { role: "tab", "data-tab": id, on: { click: () => { tab = id; listQuery = ""; updateUI(); renderBody(); } } }, label));
    }
    bodyEl = h("div", { className: "wmq-body" });
    panel = h("section", { className: "wmq-panel", "aria-label": "Wiki Masters QoL" },
      h("header", null,
        h("div", { className: "wmq-head" },
          h("small", null, "Valeur du compte"),
          h("div", null, valueEl, deltaEl)),
        h("button", { className: "wmq-x", title: "Replier (Alt+Maj+Q)", "aria-label": "Replier", on: { click: () => setCollapsed(true) } }, "✕")),
      statusEl, meterEl,
      h("div", { className: "wmq-actions" }, btnScan, btnAll),
      tabsEl, bodyEl);
    root = h("div", { id: "wmq-root" }, panel, fab);
    document.body.appendChild(root);
    renderBody();
  }

  function toggleScan() {
    if (scanning) {
      stopRequested = true;
      flushPrices();
      flushChecked();
    } else scanAll("new");
  }

  function setProgress(text, pct = null) {
    progress = { text, pct };
    updateUI();
  }

  function updateUI() {
    buildUI();
    root.classList.toggle("collapsed", collapsed);
    root.classList.toggle("left", settings.left);
    fab.classList.toggle("busy", scanning);
    fab.classList.toggle("view", globalActive(view));
    fab.title = collapsed ? "Ouvrir Wiki Masters QoL (Alt+Maj+Q)" : "Replier";
    fab.setAttribute("aria-expanded", String(!collapsed));

    const st = getStats();
    valueEl.textContent = st.pricedUnique ? `≈ ${fmtC(st.total)}` : "—";
    const d = st.pricedUnique ? valueDelta(st.total) : null;
    deltaEl.textContent = d && d.diff ? `${d.diff > 0 ? "▲" : "▼"} ${fmtC(Math.abs(d.diff))}` : "";
    deltaEl.className = `wmq-delta ${d && d.diff < 0 ? "down" : "up"}`;
    if (d) deltaEl.title = `Depuis le relevé du ${new Date(d.day).toLocaleDateString("fr-FR")}`;

    statusEl.textContent =
      progress.text ||
      `${fmt(st.unique)} cartes · ${fmt(st.pricedUnique)} avec prix` + (ownPage() ? ` · ${visibleTiles} à l'écran` : "");
    meterEl.style.display = scanning && progress.pct != null ? "" : "none";
    meterEl.firstChild.style.width = `${Math.round((progress.pct || 0) * 100)}%`;
    btnScan.textContent = scanning ? "Arrêter" : "Scanner les nouvelles";
    btnScan.classList.toggle("stop", scanning);
    btnAll.disabled = scanning;
    for (const b of tabsEl.children) {
      const on = b.dataset.tab === tab;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    }
  }

  function seg(options, current, onPick, disabled) {
    return h("div", { className: "wmq-seg" }, ...options.map(([val, label, title]) =>
      h("button", { className: val === current ? "on" : "", "aria-pressed": String(val === current), disabled: !!disabled, title: title || "", on: { click: () => onPick(val) } }, label)));
  }
  const field = (label, ...kids) => h("div", { className: "wmq-field" }, h("small", null, label), ...kids);

  function renderBody() {
    if (!bodyEl || collapsed) return;
    listEl = null;
    if (tab === "vue") return bodyEl.replaceChildren(...buildVue());
    if (tab === "stats") return bodyEl.replaceChildren(buildEstimate(getStats(true)));
    if (tab === "opts") return bodyEl.replaceChildren(...buildOpts());
    listEl = h("ol", { className: "wmq-list" });
    const search = h("input", {
      type: "search", className: "wmq-search", placeholder: "Filtrer par nom…", value: listQuery, "aria-label": "Filtrer par nom",
      on: { input: (e) => { listQuery = e.target.value; fillList(); } },
    });
    bodyEl.replaceChildren(search, h("div", { className: "wmq-list-head" }), listEl);
    fillList();
  }

  function buildVue() {
    const v = draft || view;
    const all = v.scope === "all";
    const out = [
      field("Trier par prix", seg([["off", "Ordre du site"], ["desc", "Plus chères ▼"], ["asc", "Moins chères ▲"]], v.sort, (sort) => setView({ sort }))),
      field("Sur", seg([
        ["all", "Toute la collection", "Le site affiche tes vraies cartes dans le nouvel ordre, toutes pages confondues"],
        ["page", "Page affichée", "Réordonne seulement les cartes déjà à l'écran, sans rechargement"],
      ], v.scope, (scope) => setView({ scope }))),
      field("Raretés (toute la collection)", h("div", { className: "wmq-chips" }, ...RARITIES.map((r) =>
        h("button", {
          className: `wmq-rar${v.rar.includes(r) ? " on" : ""}`, "data-r": r, "aria-pressed": String(v.rar.includes(r)), disabled: !all,
          on: { click: () => setView({ rar: RARITIES.filter((x) => (x === r) !== v.rar.includes(x)) }) },
        }, r)),
        h("button", { className: `wmq-rar dup${v.dup ? " on" : ""}`, "aria-pressed": String(v.dup), disabled: !all, on: { click: () => setView({ dup: !v.dup }) } }, "Doublons ×2+"))),
    ];
    if (draft) {
      out.push(h("div", { className: "wmq-apply" },
        h("button", { className: "wmq-btn primary", on: { click: () => commitView(draft, true) } }, ownPage() ? "Appliquer (recharge la page)" : "Appliquer"),
        h("button", { className: "wmq-btn", on: { click: () => { draft = null; renderBody(); } } }, "Annuler")));
    } else if (globalActive(view)) {
      out.push(h("div", { className: "wmq-apply" },
        h("span", { className: "wmq-pill" }, "Vue globale active"),
        h("button", { className: "wmq-btn", on: { click: () => commitView({ sort: "off", scope: "all", rar: [], dup: false }, true) } }, "Revenir à l'ordre du site")));
    }
    if (viewNote) out.push(h("p", { className: "wmq-note warn" }, viewNote));
    if (!Object.keys(prices).length) out.push(h("p", { className: "wmq-note" }, "Aucun prix pour l'instant : clique sur « Scanner les nouvelles »."));
    else if (!ownPage()) out.push(h("p", { className: "wmq-note" }, "Badges et tri ne s'affichent que sur ta page Collection."));
    return out;
  }

  function fillList() {
    if (!listEl) return;
    const dupMode = tab === "dup";
    const all = ownedRanking(dupMode).filter((r) => !dupMode || r.count > 1);
    const q = norm(listQuery);
    const rows = q ? all.filter((r) => norm(r.name).includes(q)) : all;
    const head = listEl.previousSibling;
    if (dupMode) {
      const extras = all.reduce((t, r) => t + (r.count - 1), 0);
      const surplus = all.reduce((t, r) => t + (Number.isFinite(r.price) ? r.price * (r.count - 1) : 0), 0);
      head.textContent = `${fmt(all.length)} cartes en double · ${fmt(extras)} en trop · ≈ ${fmtC(surplus)}`;
    } else head.textContent = `${fmt(all.length)} cartes avec prix sur ${fmt(Object.keys(ids).length)}`;
    const keep = bodyEl.scrollTop;
    if (!rows.length) {
      listEl.replaceChildren(h("li", { className: "wmq-empty" },
        q ? "Aucune carte ne correspond." : dupMode ? "Aucun doublon détecté. Clique sur « Tout rafraîchir » pour relire ta collection." : "Aucun prix pour l'instant : clique sur « Scanner les nouvelles »."));
      return;
    }
    const MAX = 100;
    listEl.replaceChildren(...rows.slice(0, MAX).map((r, i) =>
      h("li", null,
        h("span", { className: "wmq-rank" }, String(i + 1)),
        h("span", { className: "wmq-rar on", "data-r": r.rarity }, r.rarity || "?"),
        h("span", { className: "wmq-name", title: r.name }, r.name),
        r.count > 1 && h("span", { className: "wmq-x2" }, `×${r.count}`),
        h("span", { className: "wmq-price" }, Number.isFinite(r.price) ? fmt(r.price) : "—"))));
    if (rows.length > MAX) listEl.append(h("li", { className: "wmq-empty" }, `+ ${fmt(rows.length - MAX)} autres : affine avec le filtre ou exporte en CSV (Réglages).`));
    bodyEl.scrollTop = keep;
  }

  function buildEstimate(st) {
    const wrap = h("div", { className: "wmq-est" });
    if (!st.pricedUnique) {
      wrap.append(h("p", { className: "wmq-note" }, "Aucun prix pour l'instant : clique sur « Scanner les nouvelles »."));
      return wrap;
    }
    const card = (label, value, hint, tip) => h("div", { className: "wmq-est-card", title: tip || hint }, h("small", null, label), h("b", null, value), h("em", null, hint));
    wrap.append(h("div", { className: "wmq-est-grid" },
      card("Moyenne", fmtC(st.mean), "par carte", "Moyenne par carte : valeur totale ÷ nombre de cartes avec prix"),
      card("Médiane", fmtC(st.median), "50 % en dessous", "Médiane : la moitié de tes cartes vaut moins que ce prix, l'autre moitié vaut plus"),
      card("Plus chère", st.top ? fmtC(st.top.price) : "—", st.top ? st.top.name : "")));

    const days = Object.keys(hist).sort();
    if (days.length > 1) {
      const vals = days.map((d) => hist[d]);
      const min = Math.min(...vals);
      const span = Math.max(...vals) - min || 1;
      const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * 100).toFixed(1)},${(30 - ((v - min) / span) * 28).toFixed(1)}`).join(" ");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 100 32");
      svg.setAttribute("preserveAspectRatio", "none");
      const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      line.setAttribute("points", pts);
      svg.append(line);
      wrap.append(field(`Valeur du compte · ${days.length} relevés depuis le ${new Date(days[0]).toLocaleDateString("fr-FR")}`, h("div", { className: "wmq-spark" }, svg)));
    }

    const pct = st.unique ? Math.round((st.pricedUnique / st.unique) * 100) : 0;
    const fill = h("i");
    fill.style.width = `${pct}%`;
    wrap.append(field("Couverture des prix", h("div", { className: "wmq-meter" }, fill),
      h("p", { className: "wmq-note" }, `${fmt(st.pricedUnique)} cartes sur ${fmt(st.unique)} ont un prix (${pct} %)` + (pct < 100 ? ". Les autres comptent 0 : lance le scan pour compléter." : "."))));

    const facts = h("div", { className: "wmq-est-facts" });
    const fact = (l, v) => facts.append(h("span", null, l), h("b", null, v));
    fact("Exemplaires possédés", fmt(st.totalCards));
    fact("Cartes différentes", fmt(st.unique));
    if (st.dupValue > 0) fact("Valeur des doublons", `≈ ${fmtC(st.dupValue)}`);
    wrap.append(facts);

    const table = h("div", { className: "wmq-est-table" }, ...["Rareté", "Exemplaires", "Valeur", "Moyenne"].map((t) => h("small", null, t)));
    for (const [rar, b] of st.byRarity.slice(0, 8)) {
      table.append(
        h("span", { className: "wmq-rar on", "data-r": rar }, rar),
        h("span", null, fmt(b.cards)),
        h("span", null, b.value ? fmtC(b.value) : "—"),
        h("span", null, b.priced ? fmtC(b.value / b.priced) : "—"));
    }
    wrap.append(table);
    return wrap;
  }

  function buildOpts() {
    const toggle = (key, label, hint) =>
      h("label", { className: "wmq-toggle", title: hint || "" },
        h("input", { type: "checkbox", checked: !!settings[key], on: { change: (e) => { settings[key] = e.target.checked; saveSettings(); refreshUI(); } } }),
        h("span", null, label));
    return [
      toggle("badges", "Badge de prix sur les cartes"),
      toggle("dupBadges", "Badge ×N sur les doublons"),
      toggle("compact", "Prix abrégés (12 k au lieu de 12 000)"),
      toggle("gentle", "Scan doux", "Deux fois moins de requêtes en parallèle : plus lent, moins de refus du serveur"),
      toggle("left", "Panneau à gauche"),
      h("label", { className: "wmq-toggle" },
        h("span", null, "Surligner les cartes à partir de"),
        h("input", {
          type: "number", min: "0", step: "100", className: "wmq-num", value: settings.highlight || "", placeholder: "prix", "aria-label": "Prix à partir duquel surligner une carte",
          on: { change: (e) => { settings.highlight = Math.max(0, Number(e.target.value) || 0); saveSettings(); refreshUI(); } },
        })),
      h("div", { className: "wmq-apply" },
        h("button", { className: "wmq-btn", title: "Toutes tes cartes avec quantité, prix et valeur", on: { click: exportCsv } }, "Exporter en CSV"),
        h("button", { className: "wmq-btn danger", title: "Efface les prix mémorisés", on: { click: clearPrices } }, "Effacer les prix")),
      h("p", { className: "wmq-note" }, "Raccourcis : Alt+Maj+S lance ou arrête le scan · Alt+Maj+Q ouvre ou replie ce panneau."),
    ];
  }

  function clearPrices() {
    if (scanning || !confirm("Effacer tous les prix mémorisés ?")) return;
    prices = {};
    checked = {};
    clearTimeout(saveTimer);
    saveTimer = null;
    chrome.storage.local.remove([K.prices, K.checked]);
    refreshUI();
  }

  function toast(text, isError) {
    const t = h("div", { className: "wmq-toast" + (isError ? " err" : ""), role: isError ? "alert" : "status", title: "Cliquer pour fermer" }, text);
    t.addEventListener("click", () => t.remove());
    document.body.appendChild(t);
    setTimeout(() => t.remove(), isError ? 20000 : 8000);
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      scanAuctionPanel();
      refreshUI();
    }, 400);
  }

  let uiTimer = null;
  function scheduleUI() {
    if (uiTimer) return;
    uiTimer = setTimeout(() => {
      uiTimer = null;
      refreshUI();
    }, 1000);
  }

  function refreshUI() {
    decorate();
    if (collapsed) return;
    if (tab === "top" || tab === "dup") fillList();
    else if (tab === "stats") renderBody();
  }

  document.addEventListener("keydown", (e) => {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (e.code === "KeyS") toggleScan();
    else if (e.code === "KeyQ") setCollapsed(!collapsed);
    else return;
    e.preventDefault();
  });

  chrome.storage.local.get(Object.values(K), (r) => {
    collapsed = !!r[K.collapsed];
    prices = r[K.prices] || {};
    checked = r[K.checked] || {};
    idsFullTs = r[K.idsTs] || 0;
    ids = r[K.ids] || {};
    hist = r[K.hist] || {};
    if (r[K.raw]?.list) raw = r[K.raw];
    view = { ...view, ...r[K.view] };
    settings = { ...settings, ...r[K.settings] };
    for (const e of Object.values(prices)) {
      if (!e.byRarity) {
        e.byRarity = e.avg != null ? { [firstLetter(e.rarity) || "?"]: e.avg } : {};
        delete e.avg;
        delete e.rarity;
      }
    }
    chrome.storage.local.remove(["wmq_card_meta", "wmq_sort"]);
    syncFlag();

    const isOurs = (n) => {
      const el = n && n.nodeType === 1 ? n : n?.parentElement;
      return !!el?.closest?.("#wmq-root, #wmq-stats, .wmq-toast, .wmq-badge");
    };
    const flushNow = () => {
      if (Object.keys(prices).length) chrome.storage.local.set({ [K.prices]: prices });
      if (Object.keys(checked).length) chrome.storage.local.set({ [K.checked]: checked });
    };
    window.addEventListener("pagehide", flushNow);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushNow();
    });

    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch[K.prices]) prices = ch[K.prices].newValue ? mergePrices(ch[K.prices].newValue, prices) : {};
      if (ch[K.ids]?.newValue) ids = ch[K.ids].newValue;
      if (ch[K.checked]) checked = ch[K.checked].newValue ? maxMerge(ch[K.checked].newValue, checked) : {};
      if (ch[K.idsTs]) idsFullTs = ch[K.idsTs].newValue || 0;
      if (ch[K.raw]?.newValue) raw = ch[K.raw].newValue;
      if (ch[K.hist]?.newValue) hist = ch[K.hist].newValue;
      if (ch[K.view]?.newValue) view = ch[K.view].newValue;
      if (ch[K.settings]?.newValue) settings = ch[K.settings].newValue;
      if (ch[K.collapsed]) collapsed = !!ch[K.collapsed].newValue;
      if (ch[K.view] || ch[K.settings] || ch[K.collapsed]) {
        updateUI();
        if (tab !== "opts") renderBody();
      }
      if (ch[K.prices] || ch[K.ids] || ch[K.settings]) scheduleUI();
    });

    new MutationObserver((recs) => {
      const foreign = recs.some((rec) => {
        if (isOurs(rec.target)) return false;
        const nodes = [...rec.addedNodes, ...rec.removedNodes];
        return !(nodes.length && nodes.every(isOurs));
      });
      if (foreign) schedule();
    }).observe(document.body, { childList: true, subtree: true });
    schedule();
  });
})();
