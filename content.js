// Wiki Masters QoL
// - « Scanner les nouvelles » : charge toutes les pages de TA collection (/api/my-collection), puis récupère
//   le prix moyen du marché de chaque carte (/api/marketplace/cards/<id>/sales?scope=summary).
//   Même requêtes que le site, avec ta session, à cadence modérée. Aucune mise aux enchères, aucun clic.
// - « Top prix » : classement de toutes tes cartes, de la plus chère à la moins chère, toutes pages confondues.
// - Badges de prix + tri sur la page affichée.
(() => {
  const PRICES_KEY = "wmq_prices";
  const IDS_KEY = "wmq_ids2"; // v3 : liste lue uniquement depuis /api/my-collection
  const COLLAPSED_KEY = "wmq_collapsed";
  const CHECKED_KEY = "wmq_checked"; // { idCarte: date } : cartes déjà interrogées, avec ou sans prix
  const SORT_KEY = "wmq_sort"; // "off" | "global-desc" | "desc" | "asc"
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const CONCURRENCY = 4; // requêtes de prix en parallèle (baisse à 2 sur refus)
  const DELAY_MS = 200; // pause de chaque « voie » entre deux cartes
  const COOLDOWN_MS = 10 * 1000; // pause quand le serveur refuse (HTTP 403), répétée tant que ça refuse
  const MAX_REFUSALS = 30; // refus consécutifs (≈ 5 min de pauses de 10 s) avant d'abandonner
  const PAGE_DELAY_MS = 100; // pause entre deux pages de collection
  const PAGE_CONCURRENCY = 4; // pages de collection en parallèle
  const FRESH_MS = 10 * 60 * 1000; // on ne re-demande pas un prix de moins de 10 min
  const MAX_PAGES = 500;
  const META_KEY = "wmq_ids_full_ts3";
  const IDS_REUSE_MS = 60 * 60 * 1000; // la liste des cartes est réutilisée pendant 1 h
  let idsFullTs = 0; // date du dernier chargement complet de la collection

  let prices = {}; // { "patrick vieira": { name, byRarity: {L: 508}, ts } }
  let ids = {}; // { cardUuid: { name, rarity } }  rarity = code du site (L, SR…)
  let checked = {};
  let sortMode = "off";
  let scanning = false;
  let stopRequested = false;
  let progress = "";
  let topOpen = false;
  let topTab = "top"; // "top" | "dup"
  let rawItems = {}; // { uuid: { card: {}, count: N, raw: {} } } — données brutes de l'API pour le tri global
  let collectionMeta = null; // { total: N, stats: {}, pageSize: N }

  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const rarityCode = (s) => (typeof s === "string" ? s.trim().toUpperCase() : "");
  const firstLetter = (s) =>
    (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().charAt(0).toUpperCase();
  const toNum = (s) => {
    const d = String(s).replace(/[^\d]/g, "");
    return d ? parseInt(d, 10) : NaN;
  };
  const fmt = (n) => n.toLocaleString("fr-FR");
  const compactFmt = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });
  const fmtC = (n) => (Math.abs(n) >= 1000000 ? compactFmt.format(n) : fmt(Math.round(n)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Plusieurs onglets du site peuvent tourner en même temps : on FUSIONNE avec le stockage au lieu de l'écraser.
  let saveTimer = null;
  const savePrices = () => {
    // sauvegarde toutes les ~1,5 s au plus, mais SANS jamais être repoussée par les prix qui arrivent en continu
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flushPrices();
    }, 1500);
  };

  // a, b : { nom: { name, byRarity: {L: 508}, ts } } ; l'entrée la plus récente gagne pour une même rareté
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

  function flushPrices() {
    chrome.storage.local.get(PRICES_KEY, (r) => {
      prices = mergePrices(r[PRICES_KEY], prices);
      chrome.storage.local.set({ [PRICES_KEY]: prices });
    });
  }

  // ajout de cartes à la liste (union) ; le remplacement complet se fait directement dans scanAll
  const saveIds = () =>
    chrome.storage.local.get(IDS_KEY, (r) => {
      ids = { ...(r[IDS_KEY] || {}), ...ids };
      chrome.storage.local.set({ [IDS_KEY]: ids });
    });

  // cartes déjà interrogées (même sans prix) : on garde la date la plus récente
  function maxMerge(a, b) {
    const out = { ...(a || {}) };
    for (const [k, v] of Object.entries(b || {})) out[k] = Math.max(out[k] || 0, v);
    return out;
  }
  let checkedTimer = null;
  function saveChecked() {
    if (checkedTimer) return;
    checkedTimer = setTimeout(() => {
      checkedTimer = null;
      flushChecked();
    }, 1500);
  }
  function flushChecked() {
    chrome.storage.local.get(CHECKED_KEY, (r) => {
      checked = maxMerge(r[CHECKED_KEY], checked);
      chrome.storage.local.set({ [CHECKED_KEY]: checked });
    });
  }

  // prix d'une entrée pour une rareté ; rareté inconnue ou absente : on prend la plus haute
  function entryPrice(entry, code) {
    if (!entry?.byRarity) return NaN;
    if (code && entry.byRarity[code] != null) return entry.byRarity[code];
    const vals = Object.values(entry.byRarity);
    return vals.length ? Math.max(...vals) : NaN;
  }

  function nameRarityMap() {
    const m = {};
    for (const info of Object.values(ids)) {
      const k = norm(info.name);
      if (info.rarity && !m[k]) m[k] = info.rarity;
    }
    return m;
  }

  // quantité possédée d'une carte (nom + rareté) ; sans rareté : toutes raretés confondues
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
    const e = prices[key] || { name, byRarity: {}, ts: 0 };
    e.byRarity[code] = avg;
    e.ts = Date.now();
    prices[key] = e;
    savePrices();
    scheduleUI();
  }

  // ---------- 1) réponses réseau déjà reçues par la page ----------

  // { wikipedia_title: "Patrick Vieira", summary: { L: { average: 508 } } }
  // retourne "price" (au moins un prix), "empty" (réponse valide sans prix) ou false
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

  let idsDirty = false;
  // Réponse de /api/my-collection : { collection: [{ card_id, count, card: { id, wikipedia_title, rarity } }] }
  // On ne lit QUE ce format (pas les notifications, messages, etc.).
  function collectCollection(data) {
    if (!Array.isArray(data?.collection)) return;
    if (data.total) collectionMeta = { total: data.total, stats: data.stats, pageSize: data.collection.length || 24 };
    const agg = {};
    for (const it of data.collection) {
      const c = it?.card;
      if (!c?.id || !UUID_RE.test(c.id) || typeof c.wikipedia_title !== "string") continue;
      // Stocke l'objet card brut complet (pour reconstituer l'API lors du tri global)
      if (!rawItems[c.id]) rawItems[c.id] = { card: c, count: 0, raw: it };
      rawItems[c.id].count = (rawItems[c.id].count || 0) + (Number(it.count) || 1);
      rawItems[c.id].raw = it;
      const img = c.image_url || c.image || c.thumbnail_url || c.thumbnail || "";
      const desc = c.description || c.short_description || c.category || "";
      if (img || desc) saveCardMeta(c.wikipedia_title, desc, img);
      const a = agg[c.id] || (agg[c.id] = { name: c.wikipedia_title, rarity: rarityCode(c.rarity), count: 0 });
      a.count += Number(it.count) || 1;
    }
    for (const [id, a] of Object.entries(agg)) {
      const cur = ids[id];
      if (!cur || cur.name !== a.name || cur.rarity !== a.rarity || cur.count !== a.count) {
        ids[id] = a;
        idsDirty = true;
      }
    }
  }

  // Relaie les données interceptées vers le background Service Worker (stockage passif hors-onglet)
  function relayToBackground(url, data) {
    try {
      chrome.runtime.sendMessage({ type: "wmq-bg", url, data }).catch(() => {});
    } catch (_) {}
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.source !== "wm-qol") return;
    try {
      // Relay passif vers le background SW (zéro requête supplémentaire)
      relayToBackground(e.data.url, e.data.data);

      if (handleSummary(e.data.data)) {
        // carte ouverte depuis la collection : on la retient pour qu'elle apparaisse dans « Top prix »
        const m = /cards\/([0-9a-f-]{36})\/sales/i.exec(e.data.url);
        if (m && location.pathname.startsWith("/collection") && !ids[m[1]]) {
          const codes = Object.keys(e.data.data.summary || {});
          ids[m[1]] = { name: e.data.data.wikipedia_title, rarity: codes.length === 1 ? codes[0].toUpperCase() : "" };
          saveIds();
        }
        return;
      }
      // on ne retient les cartes que depuis la page collection (= tes cartes)
      if (/\/api\/my-collection/i.test(e.data.url)) {
        collectCollection(e.data.data);
        if (idsDirty) {
          idsDirty = false;
          saveIds();
          schedule();
        }
      }
    } catch (_) {}
  });

  // ---------- 2) lecture du panneau « MOYENNE » (si tu ouvres une carte) ----------
  function scanAuctionPanel() {
    for (const el of document.querySelectorAll("div, section, aside")) {
      const t = el.innerText;
      if (!t || t.length > 400 || !/MOYENNE/i.test(t) || !/MARCH[ÉE]\s*·/i.test(t)) continue;
      if ([...el.children].some((c) => /MOYENNE/i.test(c.innerText || "") && /MARCH[ÉE]\s*·/i.test(c.innerText || ""))) continue;
      const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
      const iM = lines.findIndex((l) => /^MARCH[ÉE]\s*·/i.test(l));
      const iA = lines.findIndex((l) => /^MOYENNE$/i.test(l));
      if (iM < 1 || iA < 0) continue;
      const name = lines[iM - 1];
      const code = nameRarityMap()[norm(name)] || firstLetter(lines[iM].split("·")[1]);
      const avg = lines.slice(iA + 1).map(toNum).find(Number.isFinite);
      if (Number.isFinite(avg)) setPrice(name, code, avg);
    }
  }

  // ---------- pause quand le serveur refuse (403) ----------
  let refusals = 0;
  let pauseUntil = 0;
  let okStreak = 0;
  let refusalReason = "";

  // retourne true si on peut réessayer après une pause, false s'il faut abandonner
  async function onRefusal(res) {
    okStreak = 0;
    if (Date.now() < pauseUntil) return true; // une pause est déjà en cours (autre voie)
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
      progress = `Pause ${Math.ceil((pauseUntil - Date.now()) / 1000)} s : le serveur refuse (essai ${refusals}/${MAX_REFUSALS})…`;
      updateBar();
      await sleep(1000);
    }
  }

  // ---------- 3) chargement de toutes les pages de la collection ----------
  // une page, avec reprise sur erreur ; retourne le JSON ou null (et appelle abort) si impossible
  async function fetchCollectionPage(page, stats, abort, shouldStop) {
    let failures = 0;
    while (!shouldStop()) {
      await waitIfPaused();
      if (shouldStop()) return null;
      let res;
      try {
        res = await fetch(`/api/my-collection?sort=rarity&page=${page}&stats=${stats}&_wmq=raw`, {
          credentials: "same-origin",
          headers: { "x-wmq-bypass": "1" },
        });
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
    const results = new Map(); // page -> items (pour garder l'ordre du site)
    const build = () => {
      const found = {};
      for (const p of [...results.keys()].sort((a, b) => a - b)) {
        for (const it of results.get(p)) {
          const c = it.card;
          if (!c?.id || !c.wikipedia_title) continue;
          const n = Number(it.count) || 1;
          // Stocke aussi l'objet brut complet
          if (!rawItems[c.id]) rawItems[c.id] = { card: c, count: 0, raw: it };
          rawItems[c.id].count = (rawItems[c.id].count || 0) + n;
          rawItems[c.id].raw = it;
          if (found[c.id]) found[c.id].count += n;
          else found[c.id] = { name: c.wikipedia_title, rarity: rarityCode(c.rarity), count: n };
        }
      }
      return found;
    };
    const itemsOf = (d) => (Array.isArray(d?.collection) ? d.collection : []);

    // page 1 avec stats=1 : devrait donner le total, donc le nombre de pages
    progress = "Collection : page 1…";
    updateBar();
    const first = await fetchCollectionPage(1, 1, abort, shouldStop);
    if (!first) return { found: build(), complete: false };
    const firstItems = itemsOf(first);
    if (!firstItems.length) return { found: build(), complete: true };
    results.set(1, firstItems);
    collectionMeta = { total: first.total, stats: first.stats, pageSize: firstItems.length };
    for (const it of firstItems) {
      const c = it?.card;
      if (c?.id) {
        rawItems[c.id] = { card: c, count: Number(it.count) || 1, raw: it };
        const img = c.image_url || c.image || c.thumbnail_url || c.thumbnail || "";
        const desc = c.description || c.short_description || c.category || "";
        if (img || desc) saveCardMeta(c.wikipedia_title, desc, img);
      }
    }

    let lastPage = null;
    if (Number.isFinite(first.total) && first.total > 0) {
      lastPage = Math.min(MAX_PAGES, Math.ceil(first.total / firstItems.length));
    }

    if (lastPage) {
      // pages 2..lastPage en parallèle (légèrement)
      let next = 2;
      const pageWorker = async () => {
        while (!shouldStop() && next <= lastPage) {
          const p = next++;
          const data = await fetchCollectionPage(p, 0, abort, shouldStop);
          if (!data) return;
          const items = itemsOf(data);
          results.set(p, items);
          for (const it of items) {
            const c = it?.card;
            if (c?.id) {
              rawItems[c.id] = { card: c, count: Number(it.count) || 1, raw: it };
              const img = c.image_url || c.image || c.thumbnail_url || c.thumbnail || "";
              const desc = c.description || c.short_description || c.category || "";
              if (img || desc) saveCardMeta(c.wikipedia_title, desc, img);
            }
          }
          progress = `Collection : ${results.size}/${lastPage} pages…`;
          updateBar();
          await sleep(PAGE_DELAY_MS);
        }
      };
      await Promise.all(Array.from({ length: PAGE_CONCURRENCY }, pageWorker));
      if (shouldStop() || results.size < lastPage) return { found: build(), complete: false };
    }

    // sécurité : on continue page par page jusqu'à une page vide (couvre aussi le cas « total inconnu »)
    let page = (lastPage || 1) + 1;
    let prevFirst = null;
    while (page <= MAX_PAGES && !shouldStop()) {
      progress = `Collection : page ${page}…`;
      updateBar();
      const data = await fetchCollectionPage(page, 0, abort, shouldStop);
      if (!data) return { found: build(), complete: false };
      const items = itemsOf(data);
      if (!items.length) return { found: build(), complete: true };
      if (items[0].id === prevFirst) return { found: build(), complete: true }; // le serveur ignore le numéro de page
      prevFirst = items[0].id;
      results.set(page, items);
      page++;
      await sleep(PAGE_DELAY_MS);
    }
    return { found: build(), complete: false };
  }

  // ---------- 4) récupération automatique des prix ----------
  // refreshAll = false : seulement les cartes sans prix (nouvelles) ; true : + les prix de plus de 10 min
  async function scanAll(refreshAll = false) {
    if (scanning) return;
    scanning = true;
    stopRequested = false;
    progress = "";
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
    updateBar();

    // phase 1 : toute la collection (toutes les pages)
    // si la liste complète a été chargée récemment, on la réutilise (sauf avec « Tout rafraîchir »)
    let complete = true;
    const reuse = !refreshAll && idsFullTs && Date.now() - idsFullTs < IDS_REUSE_MS && Object.keys(ids).length > 0;
    if (reuse) {
      progress = "Liste des cartes réutilisée…";
      updateBar();
    } else {
      const r = await loadAllPages(abort, () => stopRequested || aborted);
      complete = r.complete;
      if (r.complete) {
        ids = r.found; // liste fraîche : retire les cartes vendues/échangées
        idsFullTs = Date.now();
        chrome.storage.local.set({ [META_KEY]: idsFullTs, [IDS_KEY]: ids });
      } else {
        Object.assign(ids, r.found);
        saveIds();
      }
    }

    // phase 2 : prix du marché
    const queue = Object.entries(ids).filter(([id, info]) => {
      const c = prices[norm(info.name)];
      const has = c && (info.rarity ? c.byRarity[info.rarity] != null : Object.keys(c.byRarity).length);
      const ck = checked[id] || 0;
      // « nouvelles » : jamais interrogées (ni prix, ni « pas de prix » mémorisé)
      if (!refreshAll) return !has && !ck;
      // « tout rafraîchir » : jamais interrogées, ou dernière vérification de plus de 10 min
      const last = Math.max(ck, has ? c.ts : 0);
      return !last || Date.now() - last >= FRESH_MS;
    });
    // Priorité : jamais vérifiées en premier, puis les plus anciennes
    queue.sort(([idA, infoA], [idB, infoB]) => {
      const ckA = checked[idA] || 0;
      const ckB = checked[idB] || 0;
      if (!ckA && ckB) return -1; // A jamais vu → avant
      if (ckA && !ckB) return 1;  // B jamais vu → avant
      return ckA - ckB;           // plus ancien d'abord
    });
    const total = queue.length;
    let idx = 0;
    let done = 0;
    let failures = 0;
    let okCount = 0;
    let skipped = 0;
    let limit = CONCURRENCY; // voies actives ; baisse à 2 au premier refus du serveur
    let probeMode = false; // après un refus, une seule voie teste le serveur avant de reprendre

    // Keep-alive pour le Service Worker background (MV3 peut l'endormir après 30 s)
    const swPing = setInterval(() => {
      try { chrome.runtime.sendMessage({ type: "wmq-ping" }).catch(() => {}); } catch (_) {}
    }, 20000);

    const worker = async (wi) => {
      while (!stopRequested && !aborted && idx < queue.length) {
        await waitIfPaused();
        if (stopRequested || aborted || wi >= limit) break;
        if (probeMode && wi !== 0) {
          await sleep(500); // les autres voies attendent que la voie 0 ait réussi une requête
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
            limit = Math.min(limit, 2); // on ralentit pour le reste du scan
            probeMode = true;
            queue.push(item); // on la refera après la pause
            continue;
          }
          if (res.ok || res.status === 404) {
            let r = false;
            if (res.ok) {
              try {
                const json = await res.json();
                r = handleSummary(json);
                // double couverture : relay au SW background aussi
                relayToBackground(`/api/marketplace/cards/${id}/sales?scope=summary`, json);
              } catch (_) {}
            }
            checked[id] = Date.now(); // vérifiée : même sans prix, on ne la redemande pas au prochain scan
            saveChecked();
            if (r === "price") okCount++;
            else skipped++;
          } else {
            skipped++;
          }
          probeMode = false; // le serveur répond de nouveau : toutes les voies reprennent
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
          progress = `Prix ${Math.min(done, total)}/${total}…`;
          updateBar();
        }
        await sleep(DELAY_MS);
      }
    };

    if (!aborted && !stopRequested) await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
    clearInterval(swPing);
    flushPrices();
    flushChecked();
    scanning = false;

    const nCards = Object.keys(ids).length;
    const remaining = Math.max(total - okCount - skipped, 0);
    if (aborted) {
      progress = `⚠ Scan arrêté : ${okCount}/${total} prix récupérés`;
      toast(`Scan arrêté — ${abortReason}.\n${nCards} cartes trouvées${complete ? "" : " (collection incomplète)"}, ${okCount}/${total} prix récupérés, ${remaining} restantes. Relance plus tard.`, true);
    } else if (stopRequested) {
      progress = `Interrompu : ${okCount}/${total} prix`;
    } else if (skipped > 0) {
      progress = `Terminé : ${nCards} cartes, ${skipped} sans prix`;
      toast(`${nCards} cartes analysées. ${skipped} sans prix de marché (probablement jamais vendues).`, false);
    } else {
      progress = `Prix à jour ✓ (${nCards} cartes)`;
    }
    updateBar();
    decorate();
    if (topOpen) renderTop();
  }

  // ---------- 5) badges + tri sur la page affichée ----------
  function tileCode(tile, entry, fallback) {
    for (const el of tile.querySelectorAll("*")) {
      if (el.children.length || el.closest(".wmq-badge")) continue;
      const t = el.textContent.trim().toUpperCase();
      if (/^[A-Z]{1,3}$/.test(t) && entry.byRarity[t] != null) return t;
    }
    return fallback || "";
  }

  // vue détaillée / fenêtre modale (position fixe) : on n'y met pas de badge, le site y affiche déjà le prix
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
      if (!el || el.closest("#wmq-bar, #wmq-top, .wmq-badge, .wmq-toast, [data-wmq-injected]")) continue;
      const key = norm(n.nodeValue);
      if (!known.has(key)) continue;
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
        tiles.set(tile, { name: entry?.name || n.nodeValue.trim(), price: entryPrice(entry, code), ts: entry.ts, code, count });
      }
    }
    const all = [...tiles.entries()].filter(([, v]) => Number.isFinite(v.price));
    return all.filter(([t]) => !all.some(([o]) => o !== t && t.contains(o))); // garde la carte la plus interne
  }

  function decorate() {
    const tiles = findTiles();
    const tileSet = new Set(tiles.map(([t]) => t));
    document.querySelectorAll(".wmq-badge").forEach((b) => {
      if (b.parentElement && b.parentElement.dataset.wmqInjected) return; // Protège formellement les cartes injectées !
      if (!tileSet.has(b.parentElement)) b.remove(); // badge orphelin ou en double
    });
    for (const [tile, v] of tiles) {
      if (getComputedStyle(tile).position === "static") tile.style.position = "relative";
      // badge prix : en bas, au centre, entre l'attaque et la défense
      let b = tile.querySelector(":scope > .wmq-badge:not(.wmq-dup)");
      if (!b) {
        b = document.createElement("div");
        b.className = "wmq-badge";
        tile.appendChild(b);
      }
      const txt = `⌀ ${fmt(v.price)}`;
      if (b.textContent !== txt) b.textContent = txt;
      b.title = `Moyenne marché relevée le ${new Date(v.ts).toLocaleString("fr-FR")}${v.count > 1 ? ` — tu en as ${v.count}` : ""}`;

      // badge doublon : en haut à droite, seulement si tu as plusieurs exemplaires
      let d = tile.querySelector(":scope > .wmq-badge.wmq-dup");
      if (v.count > 1) {
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
    applySort(tiles);
    placeStatsChip();
    const injectedCount = document.querySelectorAll("[data-wmq-injected]").length;
    updateBar(tiles.length + injectedCount);
  }

  // ---------- Système d'affichage et de tri des cartes ----------
  const RARITY_THEMES = {
    C: {
      badgeBg: "#b8f2d5",
      badgeColor: "#064e3b",
      borderColor: "#b8f2d5",
      glow: "0 0 12px rgba(184, 242, 213, 0.3)",
      cardBg: "linear-gradient(180deg, #18221c 0%, #0d1410 100%)",
      descColor: "#cbd5e1",
    },
    PC: {
      badgeBg: "#b1cff2",
      badgeColor: "#0f172a",
      borderColor: "#b1cff2",
      glow: "0 0 14px rgba(177, 207, 242, 0.35)",
      cardBg: "linear-gradient(180deg, #132238 0%, #0c1420 100%)",
      descColor: "#93c5fd",
    },
    R: {
      badgeBg: "#c6a7f2",
      badgeColor: "#2e1065",
      borderColor: "#c6a7f2",
      glow: "0 0 16px rgba(198, 167, 242, 0.4)",
      cardBg: "linear-gradient(180deg, #251838 0%, #130d20 100%)",
      descColor: "#d8b4fe",
    },
    SR: {
      badgeBg: "#ed6fa3",
      badgeColor: "#ffffff",
      borderColor: "#ed6fa3",
      glow: "0 0 18px rgba(237, 111, 163, 0.45)",
      cardBg: "linear-gradient(180deg, #3d1527 0%, #1f0b14 100%)",
      descColor: "#f472b6",
    },
    UR: {
      badgeBg: "#fa9931",
      badgeColor: "#ffffff",
      borderColor: "#fa9931",
      glow: "0 0 20px rgba(250, 153, 49, 0.5)",
      cardBg: "linear-gradient(180deg, #3d2010 0%, #1f1008 100%)",
      descColor: "#fdba74",
    },
    L: {
      badgeBg: "#ffe144",
      badgeColor: "#000000",
      borderColor: "#ffe144",
      glow: "0 0 22px rgba(255, 225, 68, 0.6)",
      cardBg: "linear-gradient(180deg, #382c0b 0%, #1c1605 100%)",
      descColor: "#fef08a",
    },
  };

  const CARD_META_KEY = "wmq_card_meta";
  let cardMeta = {}; // { [norm(name)]: { desc: string, img: string } }
  let cardMetaTimer = null;

  function saveCardMeta(name, desc, img) {
    const k = norm(name);
    if (!k) return;
    if (!cardMeta[k]) cardMeta[k] = {};
    if (desc) cardMeta[k].desc = desc;
    if (img) cardMeta[k].img = img;
    if (cardMetaTimer) return;
    cardMetaTimer = setTimeout(() => {
      cardMetaTimer = null;
      try {
        chrome.storage.local.get(CARD_META_KEY, (r) => {
          const merged = { ...(r?.[CARD_META_KEY] || {}), ...cardMeta };
          chrome.storage.local.set({ [CARD_META_KEY]: merged });
        });
      } catch (_) {}
    }, 1500);
  }

  const fetchingCards = new Map(); // k -> Promise<{ desc, img }>

  async function fetchCardData(name, descNode, imgEl) {
    const k = norm(name);
    const cached = cardMeta[k];
    if (cached) {
      if (descNode && cached.desc) descNode.nodeValue = cached.desc;
      if (imgEl && cached.img) {
        imgEl.src = cached.img;
        imgEl.removeAttribute("srcset");
        imgEl.removeAttribute("sizes");
        imgEl.className = "wmq-art-img";
        imgEl.style.position = "relative";
        imgEl.style.inset = "auto";
        imgEl.style.maxWidth = "100%";
        imgEl.style.maxHeight = "100%";
        imgEl.style.objectFit = "contain";
        if (imgEl.parentElement && imgEl.parentElement.classList) {
          imgEl.parentElement.classList.add("wmq-art-frame");
          imgEl.parentElement.style.height = "118px";
          imgEl.parentElement.style.maxHeight = "118px";
          imgEl.parentElement.style.overflow = "hidden";
        }
      }
      if (cached.desc && cached.img) return;
    }

    let p = fetchingCards.get(k);
    if (!p) {
      p = (async () => {
        try {
          const clean = name.trim().replace(/\s+/g, "_");
          const url = `https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(clean)}`;
          const res = await fetch(url, { headers: { Accept: "application/json" } });
          if (res.ok) {
            const data = await res.json();
            const desc = data.description || (data.extract ? data.extract.split(".")[0].slice(0, 80) : "");
            const img = data.thumbnail?.source || data.originalimage?.source || "";
            saveCardMeta(name, desc, img);
            return { desc, img };
          }
        } catch (_) {}
        return null;
      })();
      fetchingCards.set(k, p);
    }

    const data = await p;
    if (data) {
      if (descNode && data.desc) descNode.nodeValue = data.desc;
      if (imgEl && data.img) {
        imgEl.src = data.img;
        imgEl.removeAttribute("srcset");
        imgEl.removeAttribute("sizes");
        imgEl.className = "wmq-art-img";
        imgEl.style.position = "relative";
        imgEl.style.inset = "auto";
        imgEl.style.maxWidth = "100%";
        imgEl.style.maxHeight = "100%";
        imgEl.style.objectFit = "contain";
        if (imgEl.parentElement && imgEl.parentElement.classList) {
          imgEl.parentElement.classList.add("wmq-art-frame");
          imgEl.parentElement.style.height = "118px";
          imgEl.parentElement.style.maxHeight = "118px";
          imgEl.parentElement.style.overflow = "hidden";
        }
      }
    }
  }

  function findCardId(name, rarity) {
    const target = norm(name);
    for (const [id, info] of Object.entries(ids)) {
      if (norm(info.name) === target && (!rarity || info.rarity === rarity)) {
        return id;
      }
    }
    for (const [id, info] of Object.entries(ids)) {
      if (norm(info.name) === target) return id;
    }
    return null;
  }

  function removeInjectedTiles() {
    document.querySelectorAll("[data-wmq-injected]").forEach((el) => el.remove());
  }

  function getCleanTemplate(tiles, rarity) {
    // 1. Modèles propres et fiables connus présents sur le site
    const cleanMatches = {
      SR: ["blender", "monster"],
      PC: ["dzūkija", "dzukija", "guyenne", "brady ellison"],
      C: ["max ramsland", "ramsland", "protime", "jean guyot"],
      L: ["kennedy", "secret story"],
    };

    const targets = cleanMatches[rarity] || [];
    for (const [t] of tiles) {
      const txt = (t.textContent || "").toLowerCase();
      if (targets.some((k) => txt.includes(k))) return t;
    }

    // 2. Cherche n'importe quelle tuile de cette rareté sans Tudor ni Cechy
    for (const [t, info] of tiles) {
      const txt = (t.textContent || "").toLowerCase();
      if (info.code === rarity && !txt.includes("tudor") && !txt.includes("cechy")) {
        return t;
      }
    }

    // 3. Cherche par texte de badge direct dans les tuiles
    for (const [t] of tiles) {
      const txt = (t.textContent || "").toLowerCase();
      if (txt.includes("cechy") || txt.includes("tudor")) continue;
      for (const el of t.querySelectorAll("*")) {
        if (el.children.length === 0 && el.textContent.trim().toUpperCase() === rarity) {
          return t;
        }
      }
    }

    // 4. Fallback universel : Blender (SR) ou JFK (L)
    for (const [t] of tiles) {
      const txt = (t.textContent || "").toLowerCase();
      if (txt.includes("blender") || txt.includes("kennedy")) return t;
    }

    return tiles[0]?.[0] || null;
  }

  function createGlobalTopTile(templateTile, cardInfo, price) {
    const clone = templateTile.cloneNode(true);
    clone.dataset.wmqInjected = cardInfo.name;
    const rarCode = cardInfo.rarity || "C";
    clone.dataset.wmqRarity = rarCode;
    delete clone.dataset.wmqOrder;

    const theme = RARITY_THEMES[rarCode] || RARITY_THEMES.C;

    // Applique le thème de fond, bordure et lueur officielle
    clone.style.position = "relative";
    clone.style.border = `1.5px solid ${theme.borderColor}`;
    clone.style.boxShadow = theme.glow;
    clone.style.background = theme.cardBg;
    clone.style.overflow = "hidden";
    clone.style.display = "flex";
    clone.style.flexDirection = "column";

    // 1. Supprime tout logo secondaire éventuel (bannières ou filigranes)
    const allImgs = clone.querySelectorAll("img");
    for (let i = 1; i < allImgs.length; i++) {
      allImgs[i].remove();
    }

    // 2. Supprime les petits tags spécifiques du modèle (ex: "Info", "Jeux", "DANGER")
    for (const tag of clone.querySelectorAll("span, div")) {
      if (tag.children.length === 0 && !tag.closest(".wmq-badge")) {
        const t = tag.textContent.trim().toUpperCase();
        if (["INFO", "JEUX", "DANGER"].includes(t)) {
          tag.remove();
        }
      }
    }

    // 3. Cherche le badge de rareté existant (L, UR, SR, R, PC, C)
    let rarityEl = null;
    for (const el of clone.querySelectorAll("*")) {
      if (el.children.length || el.closest(".wmq-badge")) continue;
      const t = el.textContent.trim().toUpperCase();
      if (/^(L|UR|SR|R|PC|C)$/.test(t)) {
        rarityEl = el;
        break;
      }
    }
    if (rarityEl) {
      rarityEl.textContent = rarCode;
      rarityEl.style.backgroundColor = theme.badgeBg;
      rarityEl.style.color = theme.badgeColor;
      rarityEl.style.fontWeight = "800";
      rarityEl.style.borderRadius = "6px";
      rarityEl.style.padding = "2px 7px";
      rarityEl.style.fontSize = "11px";
      rarityEl.style.lineHeight = "1";
      rarityEl.style.boxShadow = "0 1px 4px rgba(0,0,0,0.4)";
    }

    // Étoile dorée en haut à droite (remplie pour SR, UR, L, contour/discrète sinon)
    const topSvg = clone.querySelector("svg");
    if (topSvg && !topSvg.closest(".wmq-badge")) {
      if (["SR", "UR", "L"].includes(rarCode)) {
        topSvg.style.color = "#ffe144";
        topSvg.style.fill = "#ffe144";
        topSvg.style.opacity = "1";
        topSvg.style.display = "block";
      } else {
        topSvg.style.color = theme.borderColor;
        topSvg.style.fill = "none";
        topSvg.style.opacity = "0.35";
      }
    }

    // 4. Parcourt les nœuds texte pour isoler Titre et Description
    let titleNode = null;
    let descNode = null;
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    let tn;
    while ((tn = walker.nextNode())) {
      if (tn.parentElement.closest(".wmq-badge")) continue;
      if (rarityEl && tn.parentElement === rarityEl) continue;
      const val = (tn.nodeValue || "").trim();
      if (!val) continue;

      // Ignore les stats numériques (ex: 10 000, 8653, 5843)
      if (/^[\d\s\u00A0.,]+$/.test(val)) continue;

      if (!titleNode) {
        titleNode = tn;
        continue;
      }

      if (!descNode) {
        descNode = tn;
        break;
      }
    }

    // Met à jour le nom
    if (titleNode) {
      titleNode.nodeValue = cardInfo.name;
      if (titleNode.parentElement) {
        titleNode.parentElement.className = "wmq-card-title";
        titleNode.parentElement.style.color = "#ffffff";
        titleNode.parentElement.style.fontWeight = "700";
        titleNode.parentElement.style.fontSize = "13px";
        titleNode.parentElement.style.lineHeight = "1.25";
        titleNode.parentElement.style.textShadow = "0 1px 3px rgba(0, 0, 0, 0.9)";
      }
    }

    // Vide immédiatement la description pendant le chargement
    if (descNode) {
      descNode.nodeValue = "";
      if (descNode.parentElement) {
        descNode.parentElement.className = "wmq-card-desc";
        descNode.parentElement.style.color = theme.descColor;
        descNode.parentElement.style.fontSize = "10.5px";
        descNode.parentElement.style.lineHeight = "1.25";
        descNode.parentElement.style.opacity = "0.85";
      }
    }

    // Conteneur de texte
    const bodyEl = titleNode?.parentElement?.parentElement;
    if (bodyEl && bodyEl !== clone) {
      bodyEl.className = "wmq-card-body";
      bodyEl.style.position = "relative";
      bodyEl.style.zIndex = "3";
      bodyEl.style.padding = "6px 10px";
      bodyEl.style.minHeight = "55px";
      bodyEl.style.flex = "1 1 auto";
    }

    // 5. Cadre illustration propre (hauteur fixe 118px, supprime le plein écran / full art)
    const img = clone.querySelector("img");
    if (img) {
      img.removeAttribute("srcset");
      img.removeAttribute("sizes");
      img.alt = cardInfo.name;
      img.className = "wmq-art-img";
      img.style.position = "relative";
      img.style.inset = "auto";
      img.style.top = "auto";
      img.style.bottom = "auto";
      img.style.left = "auto";
      img.style.right = "auto";
      img.style.width = "auto";
      img.style.height = "auto";
      img.style.maxWidth = "100%";
      img.style.maxHeight = "100%";
      img.style.objectFit = "contain";
      img.style.display = "block";
      img.style.margin = "0 auto";
      img.style.zIndex = "2";

      const frame = img.parentElement;
      if (frame && frame !== clone) {
        frame.className = "wmq-art-frame";
        frame.style.position = "relative";
        frame.style.width = "100%";
        frame.style.height = "118px";
        frame.style.minHeight = "118px";
        frame.style.maxHeight = "118px";
        frame.style.overflow = "hidden";
        frame.style.display = "flex";
        frame.style.alignItems = "center";
        frame.style.justifyContent = "center";
        frame.style.background = "rgba(0, 0, 0, 0.45)";
        frame.style.flexShrink = "0";
      }

      // Placeholder SVG neutre et élégant
      img.src = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150" viewBox="0 0 300 150"><rect width="300" height="150" fill="%230c1017"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%2364748b" font-size="12" font-family="sans-serif">${encodeURIComponent(cardInfo.name.slice(0, 24))}</text></svg>`;
    }

    // 6. Met à jour les liens de la carte vers son véritable ID
    const cardId = findCardId(cardInfo.name, cardInfo.rarity);
    if (cardId) {
      clone.dataset.wmqCardId = cardId;
      const links = clone.tagName === "A" ? [clone] : [...clone.querySelectorAll("a")];
      for (const a of links) {
        if (a.href) a.href = a.href.replace(/[0-9a-f-]{36}/i, cardId);
      }
    }

    // 7. Badge prix (garanti présent, visible et centré)
    let b = clone.querySelector(":scope > .wmq-badge:not(.wmq-dup)");
    if (!b) {
      b = document.createElement("div");
      b.className = "wmq-badge";
      clone.appendChild(b);
    }
    b.textContent = `⌀ ${fmt(price)}`;
    b.title = `Prix moyen marché : ${fmt(price)}`;
    b.style.display = "block";
    b.style.visibility = "visible";
    b.style.opacity = "1";
    b.style.zIndex = "50";

    // 8. Badge doublon
    let d = clone.querySelector(":scope > .wmq-badge.wmq-dup");
    if (cardInfo.count > 1) {
      if (!d) {
        d = document.createElement("div");
        d.className = "wmq-badge wmq-dup";
        clone.appendChild(d);
      }
      d.textContent = `×${cardInfo.count}`;
      d.title = `Tu possèdes ${cardInfo.count} exemplaires`;
      d.style.display = "block";
    } else if (d) {
      d.remove();
    }

    // Ordre dans la grille
    clone.style.order = String(-price);

    // 9. Charge la vraie image et la vraie description depuis Wikipedia / cache
    fetchCardData(cardInfo.name, descNode, img);

    return clone;
  }

  function applySort(tiles) {
    const parents = new Set(tiles.map(([t]) => t.parentElement));
    if (!parents.size) return;

    for (const parent of parents) {
      const priced = new Map(tiles.filter(([t]) => t.parentElement === parent));

      if (sortMode === "off") {
        removeInjectedTiles();
        for (const child of parent.children) {
          if (child.dataset.wmqOrder) {
            child.style.order = "";
            delete child.dataset.wmqOrder;
          }
        }
        continue;
      }

      if (sortMode === "desc" || sortMode === "asc") {
        removeInjectedTiles();
        for (const child of parent.children) {
          const v = priced.get(child);
          child.style.order = String(v ? (sortMode === "desc" ? -v.price : v.price) : 1e9);
          child.dataset.wmqOrder = "1";
        }
        continue;
      }

      if (sortMode === "global-desc") {
        // Mode 🏆 Top global :
        // 1. Trie les cartes déjà présentes sur la page par prix décroissant
        const existingNames = new Set();
        for (const child of parent.children) {
          if (child.dataset.wmqInjected) continue;
          const v = priced.get(child);
          child.style.order = String(v ? -v.price : 1e9);
          child.dataset.wmqOrder = "1";
        }

        for (const [, v] of tiles) {
          if (v.name) existingNames.add(norm(v.name));
        }

        // Nettoie toujours les anciennes tuiles injectées pour un rafraîchissement propre
        removeInjectedTiles();

        // 2. Récupère le classement global complet
        const ranked = ownedRanking(false);
        if (!ranked.length || !tiles.length) continue;

        // 3. Injecte les cartes du top qui ne sont pas sur cette page (jusqu'à 36 cartes pour remplir la grille)
        const limit = Math.min(ranked.length, 36);
        for (let i = 0; i < limit; i++) {
          const r = ranked[i];
          const k = norm(r.name);
          if (existingNames.has(k)) continue; // déjà sur cette page

          const template = getCleanTemplate(tiles, r.rarity);
          if (!template) continue;

          const clone = createGlobalTopTile(template, r, r.price);
          parent.appendChild(clone);
        }
      }
    }
  }

  // ---------- 6) classement de toute la collection ----------
  function ownedRanking(includeUnpriced = false) {
    const rows = new Map();
    for (const info of Object.values(ids)) {
      const e = prices[norm(info.name)];
      let p = NaN;
      if (e) {
        const keys = Object.keys(e.byRarity);
        if (info.rarity && e.byRarity[info.rarity] != null) p = e.byRarity[info.rarity];
        else if (!info.rarity || keys.length === 1) p = entryPrice(e, ""); // rareté inconnue ou une seule connue
      }
      if (!Number.isFinite(p) && !includeUnpriced) continue;
      const key = `${info.name}|${info.rarity}`;
      const n = Number(info.count) || 1;
      const prev = rows.get(key);
      if (prev) prev.count += n;
      else rows.set(key, { name: info.name, rarity: info.rarity, price: p, count: n });
    }
    return [...rows.values()].sort((a, b) => (Number.isFinite(b.price) ? b.price : -1) - (Number.isFinite(a.price) ? a.price : -1));
  }

  // ---------- estimation du compte ----------
  // Basée sur le prix moyen du marché de chaque carte, pondérée par la quantité possédée.
  // Les cartes sans prix connu ne comptent pas (elles sont signalées dans la couverture).
  function computeStats() {
    const rows = ownedRanking(true);
    const priced = rows.filter((r) => Number.isFinite(r.price));
    const totalCards = rows.reduce((t, r) => t + r.count, 0);
    const pricedCards = priced.reduce((t, r) => t + r.count, 0);
    const total = priced.reduce((t, r) => t + r.price * r.count, 0);
    const dupValue = priced.reduce((t, r) => t + r.price * (r.count - 1), 0);
    const mean = pricedCards ? total / pricedCards : 0;
    // médiane pondérée : on parcourt les prix croissants en cumulant les quantités
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
      const b = byRarity[r.rarity || "?"] || (byRarity[r.rarity || "?"] = { cards: 0, value: 0, unpriced: 0, priced: 0 });
      b.cards += r.count;
      if (Number.isFinite(r.price)) {
        b.value += r.price * r.count;
        b.priced += r.count;
      } else b.unpriced += r.count;
    }
    return {
      unique: rows.length, pricedUnique: priced.length, totalCards, pricedCards,
      total, mean, median, dupValue, top: priced[0] || null,
      byRarity: Object.entries(byRarity).sort((a, b) => b[1].value - a[1].value),
    };
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // onglet « Estimation » : lecture claire, avec une explication sous chaque chiffre
  function buildEstimate(st) {
    const wrap = el("div", "wmq-est");
    if (!st.pricedUnique) {
      wrap.appendChild(el("div", "wmq-top-empty", "Aucun prix pour l'instant : clique sur « Scanner les nouvelles »."));
      return wrap;
    }
    const big = el("div", "wmq-est-big");
    big.append(el("small", null, "Valeur estimée du compte"), el("b", null, `≈ ${fmt(Math.round(st.total))}`), el("span", null, "d'après les prix moyens du marché"));
    wrap.appendChild(big);

    const grid = el("div", "wmq-est-grid");
    const card = (label, value, hint, tip) => {
      const c = el("div", "wmq-est-card");
      c.append(el("small", null, label), el("b", null, value), el("em", null, hint));
      if (tip || hint) c.title = tip || hint;
      return c;
    };
    grid.append(
      card("Moyenne", fmt(Math.round(st.mean)), "par carte", "Moyenne par carte : valeur totale ÷ nombre de cartes avec prix"),
      card("Médiane", fmt(Math.round(st.median)), "50 % en dessous", "Médiane : la moitié de tes cartes vaut moins que ce prix, l'autre moitié vaut plus"),
      card("Plus chère", st.top ? fmt(st.top.price) : "—", st.top ? st.top.name : "")
    );
    wrap.appendChild(grid);

    const pct = st.unique ? Math.round((st.pricedUnique / st.unique) * 100) : 0;
    const cov = el("div", "wmq-est-cov");
    const track = el("div", "wmq-bar-track");
    const fill = el("div", "wmq-bar-fill");
    fill.style.width = `${pct}%`;
    track.appendChild(fill);
    cov.append(el("small", null, "Couverture des prix"), track,
      el("p", null, `${fmt(st.pricedUnique)} cartes sur ${fmt(st.unique)} ont un prix (${pct} %)` + (pct < 100 ? ". Les autres comptent 0 : lance le scan pour compléter." : ".")));
    wrap.appendChild(cov);

    const facts = el("div", "wmq-est-facts");
    const fact = (l, v) => facts.append(el("span", null, l), el("b", null, v));
    fact("Exemplaires possédés", fmt(st.totalCards));
    fact("Cartes différentes", fmt(st.unique));
    if (st.dupValue > 0) fact("Valeur des doublons", `≈ ${fmt(Math.round(st.dupValue))}`);
    wrap.appendChild(facts);

    const table = el("div", "wmq-est-table");
    for (const h of ["Rareté", "Exemplaires", "Valeur", "Moyenne"]) table.appendChild(el("small", null, h));
    for (const [rar, b] of st.byRarity.slice(0, 8)) {
      table.append(
        el("span", "wmq-rar", rar),
        el("span", null, fmt(b.cards)),
        el("span", null, b.value ? fmt(Math.round(b.value)) : "—"),
        el("span", null, b.priced ? fmt(Math.round(b.value / b.priced)) : "—")
      );
    }
    wrap.appendChild(table);
    return wrap;
  }

  // pastille à côté du titre « Collection » (page /collection uniquement) : 3-4 petits blocs avec libellé
  let chipParts = null;
  function makeStat(label) {
    const box = el("span", "wmq-st");
    const v = el("b");
    box.append(el("small", null, label), v);
    return { box, set: (t) => { if (v.textContent !== t) v.textContent = t; } };
  }

  let statsCache = null;
  let statsTs = 0;
  function placeStatsChip() {
    let chip = document.getElementById("wmq-stats");
    if (chip && !chipParts) {
      chip.remove(); // reste d'une ancienne instance du script
      chip = null;
    }
    if (!location.pathname.startsWith("/collection")) {
      if (chip) chip.remove();
      return;
    }
    if (Date.now() - statsTs > 800 || !statsCache) {
      statsCache = computeStats();
      statsTs = Date.now();
    }
    const st = statsCache;
    if (!st.pricedUnique) {
      if (chip) chip.remove();
      return;
    }
    const heading = [...document.querySelectorAll("h1, h2")].find((h) => {
      if (h.closest("nav, aside, #wmq-bar, #wmq-top")) return false;
      const own = [...h.childNodes].filter((n) => n !== chip).map((n) => n.textContent).join("");
      return /^collection$/i.test(norm(own));
    });
    if (!heading) return;
    if (!chip) {
      chip = el("span");
      chip.id = "wmq-stats";
      chipParts = { total: makeStat("Valeur du compte"), mean: makeStat("Moyenne / carte"), med: makeStat("Médiane"), cov: makeStat("Cartes avec prix") };
      chip.append(...Object.values(chipParts).map((p) => p.box));
      chip.addEventListener("click", () => {
        collapsed = false;
        topOpen = true;
        topTab = "est";
        chrome.storage.local.set({ [COLLAPSED_KEY]: false });
        renderTop();
        updateBar();
      });
    }
    if (chip.parentElement !== heading) heading.appendChild(chip);
    chipParts.total.set(`≈ ${fmtC(st.total)}`);
    chipParts.mean.set(fmtC(st.mean));
    chipParts.med.set(fmtC(st.median));
    const partial = st.pricedUnique < st.unique;
    chipParts.cov.box.style.display = partial ? "" : "none";
    chipParts.cov.set(`${fmtC(st.pricedUnique)} / ${fmtC(st.unique)}`);
    chip.title =
      `Estimation d'après les prix moyens du marché.\nMoyenne : total ÷ nombre de cartes. Médiane : la moitié de tes cartes vaut moins.\n` +
      (partial ? `Seulement ${st.pricedUnique} cartes sur ${st.unique} ont un prix : lance « Scanner les nouvelles » pour compléter.\n` : "") +
      "Clique pour voir le détail.";
  }

  let topEl;
  function renderTop() {
    if (!topEl) {
      topEl = document.createElement("div");
      topEl.id = "wmq-top";
      document.body.appendChild(topEl);
    }
    const show = topOpen && !collapsed;
    topEl.style.display = show ? "block" : "none";
    if (!show) return;
    const dupMode = topTab === "dup";
    const estMode = topTab === "est";
    const all = estMode ? [] : ownedRanking(dupMode);
    const rows = dupMode ? all.filter((r) => r.count > 1) : all;
    const total = Object.keys(ids).length;
    const keepScroll = topEl.scrollTop;
    topEl.replaceChildren();

    const head = document.createElement("div");
    head.className = "wmq-top-head";
    const row = document.createElement("div");
    row.className = "wmq-top-row";
    const title = document.createElement("span");
    if (estMode) {
      title.textContent = "Estimation du compte";
    } else if (dupMode) {
      const extras = rows.reduce((t, r) => t + (r.count - 1), 0);
      const surplus = rows.reduce((t, r) => t + (Number.isFinite(r.price) ? r.price * (r.count - 1) : 0), 0);
      title.textContent = `${rows.length} cartes en double (${extras} en trop · ≈ ${fmt(Math.round(surplus))})`;
    } else {
      title.textContent = `Tes cartes les plus chères (${rows.length}/${total} avec prix)`;
    }
    const close = document.createElement("button");
    close.textContent = "✕";
    close.addEventListener("click", () => {
      topOpen = false;
      renderTop();
      updateBar();
    });
    row.append(title, close);

    const tabs = document.createElement("div");
    tabs.className = "wmq-tabs";
    for (const [id, label] of [["top", "Top prix"], ["dup", "Doublons"], ["est", "Estimation"]]) {
      const t = document.createElement("button");
      t.textContent = label;
      t.className = topTab === id ? "on" : "";
      t.addEventListener("click", () => {
        topTab = id;
        topEl.scrollTop = 0;
        renderTop();
      });
      tabs.appendChild(t);
    }
    head.append(row, tabs);
    topEl.appendChild(head);

    if (estMode) {
      topEl.appendChild(buildEstimate(computeStats()));
      topEl.scrollTop = keepScroll;
      return;
    }

    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "wmq-top-empty";
      empty.textContent = dupMode
        ? "Aucun doublon détecté. Si tu en as, clique sur « Tout rafraîchir » pour relire ta collection."
        : "Aucun prix pour l'instant : clique sur « Scanner les nouvelles ».";
      topEl.appendChild(empty);
      return;
    }
    const list = document.createElement("ol");
    for (const r of rows.slice(0, dupMode ? 200 : 50)) {
      const li = document.createElement("li");
      const nm = document.createElement("span");
      nm.className = "wmq-top-name";
      nm.textContent = r.name;
      nm.title = r.name;
      li.appendChild(nm);
      if (r.count > 1) {
        const x = document.createElement("span");
        x.className = "wmq-top-x";
        x.textContent = `×${r.count}`;
        li.appendChild(x);
      }
      const rar = document.createElement("span");
      rar.className = "wmq-top-rar";
      rar.textContent = r.rarity;
      const pr = document.createElement("span");
      pr.className = "wmq-top-price";
      pr.textContent = Number.isFinite(r.price) ? fmt(r.price) : "—";
      li.append(rar, pr);
      list.appendChild(li);
    }
    topEl.appendChild(list);
    topEl.scrollTop = keepScroll;
  }

  // ---------- barre flottante ----------
  let bar, inner, btnLogo, btnSort, btnScan, btnAll, btnTop, btnClear, infoEl;
  function buildBar() {
    if (bar) return;
    bar = document.createElement("div");
    bar.id = "wmq-bar";
    inner = document.createElement("div");
    inner.className = "wmq-inner";

    btnLogo = document.createElement("button");
    btnLogo.className = "wmq-logo";
    const fav = document.querySelector('link[rel~="icon"]')?.href;
    const letter = document.createElement("span");
    letter.textContent = "W";
    if (fav) {
      const img = document.createElement("img");
      img.src = fav;
      img.alt = "";
      img.addEventListener("load", () => letter.remove());
      img.addEventListener("error", () => img.remove());
      btnLogo.append(letter, img);
    } else btnLogo.append(letter);
    btnLogo.addEventListener("click", () => {
      collapsed = !collapsed;
      chrome.storage.local.set({ [COLLAPSED_KEY]: collapsed });
      if (collapsed) topOpen = false;
      renderTop();
      updateBar();
    });

    btnScan = document.createElement("button");
    btnScan.addEventListener("click", () => {
      if (scanning) {
        stopRequested = true;
        flushPrices(); // on enregistre tout de suite ce qui est déjà récupéré
        flushChecked();
      } else scanAll(false);
    });

    btnAll = document.createElement("button");
    btnAll.textContent = "Tout rafraîchir";
    btnAll.title = "Redemande aussi les prix déjà mémorisés (les prix évoluent)";
    btnAll.addEventListener("click", () => {
      if (!scanning) scanAll(true);
    });

    btnTop = document.createElement("button");
    btnTop.textContent = "Top prix";
    btnTop.addEventListener("click", () => {
      topOpen = !topOpen;
      renderTop();
      updateBar();
    });

    btnSort = document.createElement("button");
    btnSort.addEventListener("click", () => {
      // cycle : off → global-desc → desc → asc → off
      if (sortMode === "off") sortMode = "global-desc";
      else if (sortMode === "global-desc") sortMode = "desc";
      else if (sortMode === "desc") sortMode = "asc";
      else sortMode = "off";
      removeInjectedTiles();
      chrome.storage.local.set({ [SORT_KEY]: sortMode });
      updateBar();
      decorate();
    });


    btnClear = document.createElement("button");
    btnClear.textContent = "Réinitialiser";
    btnClear.title = "Efface les prix mémorisés";
    btnClear.addEventListener("click", () => {
      if (!confirm("Effacer tous les prix mémorisés ?")) return;
      prices = {};
      clearTimeout(saveTimer);
      saveTimer = null;
      checked = {};
      chrome.storage.local.remove([PRICES_KEY, CHECKED_KEY]);
      document.querySelectorAll(".wmq-badge").forEach((b) => b.remove());
      decorate();
      if (topOpen) renderTop();
    });

    infoEl = document.createElement("span");
    infoEl.className = "wmq-count";
    inner.append(btnScan, btnAll, btnTop, btnSort, btnClear, infoEl);
    bar.append(inner, btnLogo);
    document.body.appendChild(bar);
  }

  function updateBar(visible = 0) {
    buildBar();
    bar.classList.toggle("collapsed", collapsed);
    btnLogo.classList.toggle("busy", scanning);
    btnLogo.title = collapsed ? "Déplier la barre Wiki Masters QoL" : "Replier la barre";
    btnScan.textContent = scanning ? "Stop" : "Scanner les nouvelles";
    btnAll.disabled = scanning;
    btnTop.classList.toggle("on", topOpen);
    btnSort.textContent = { off: "Tri : off", "global-desc": "🏆 Top global ▼", desc: "Page ▼ (plus chères)", asc: "Page ▲ (moins chères)" }[sortMode] || "Tri : off";
    btnSort.classList.toggle("on", sortMode !== "off");
    infoEl.textContent =
      progress || `${Object.keys(ids).length} cartes · ${Object.keys(prices).length} prix · ${visible} visibles`;
  }

  // ---------- notification dans la page ----------
  function toast(text, isError) {
    const t = document.createElement("div");
    t.className = "wmq-toast" + (isError ? " err" : "");
    t.textContent = text;
    t.addEventListener("click", () => t.remove());
    document.body.appendChild(t);
    setTimeout(() => t.remove(), isError ? 20000 : 8000);
  }

  // ---------- boucle ----------
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
    if (uiTimer) return; // au plus ~1 mise à jour par seconde, même pendant un scan
    uiTimer = setTimeout(() => {
      uiTimer = null;
      refreshUI();
    }, 1000);
  }

  function refreshUI() {
    decorate();
    if (topOpen) renderTop();
  }

  chrome.storage.local.get([PRICES_KEY, IDS_KEY, SORT_KEY, META_KEY, CHECKED_KEY, COLLAPSED_KEY, CARD_META_KEY], (r) => {
    collapsed = !!r[COLLAPSED_KEY];
    prices = r[PRICES_KEY] || {};
    checked = r[CHECKED_KEY] || {};
    idsFullTs = r[META_KEY] || 0;
    cardMeta = r[CARD_META_KEY] || {};
    // migration de l'ancien format (v0.1)
    for (const e of Object.values(prices)) {
      if (!e.byRarity) {
        e.byRarity = e.avg != null ? { [firstLetter(e.rarity) || "?"]: e.avg } : {};
        delete e.avg;
        delete e.rarity;
      }
    }
    ids = r[IDS_KEY] || {};
    sortMode = r[SORT_KEY] || "off";
    try {
      sessionStorage.removeItem("__wmq_global_sort");
    } catch (_) {}

    const isOurs = (n) => {
      const el = n && n.nodeType === 1 ? n : n?.parentElement;
      return !!el?.closest?.("#wmq-bar, #wmq-top, #wmq-stats, .wmq-toast, .wmq-badge");
    };
    // rechargement / fermeture / onglet masqué : on enregistre immédiatement, sans attendre le minuteur
    const flushNow = () => {
      if (Object.keys(prices).length) chrome.storage.local.set({ [PRICES_KEY]: prices });
      if (Object.keys(checked).length) chrome.storage.local.set({ [CHECKED_KEY]: checked });
    };
    window.addEventListener("pagehide", flushNow);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushNow();
    });

    // synchronise les onglets : ce qu'un onglet enregistre apparaît dans les autres
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch[PRICES_KEY]) {
        prices = ch[PRICES_KEY].newValue ? mergePrices(ch[PRICES_KEY].newValue, prices) : {};
        scheduleUI();
      }
      if (ch[IDS_KEY]?.newValue) {
        ids = ch[IDS_KEY].newValue;
        scheduleUI();
      }
      if (ch[CHECKED_KEY]) checked = ch[CHECKED_KEY].newValue ? maxMerge(ch[CHECKED_KEY].newValue, checked) : {};
      if (ch[META_KEY]) idsFullTs = ch[META_KEY].newValue || 0;
      if (ch[COLLAPSED_KEY]) {
        collapsed = !!ch[COLLAPSED_KEY].newValue;
        if (collapsed) topOpen = false;
        renderTop();
        updateBar();
      }
    });

    new MutationObserver((recs) => {
      // on ignore nos propres modifications (badges, barre, panneau) pour ne pas se relancer en boucle
      const foreign = recs.some((r) => {
        if (isOurs(r.target)) return false;
        const nodes = [...r.addedNodes, ...r.removedNodes];
        return !(nodes.length && nodes.every(isOurs));
      });
      if (foreign) schedule();
    }).observe(document.body, { childList: true, subtree: true });
    schedule();
  });
})();
