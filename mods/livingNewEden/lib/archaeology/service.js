"use strict";

const S = require("./schema");
const defaultRepo = require("./repository");
const { gateWin, rollStart, checkLimits } = require("./startPolicy");
const { bfsOf, orderOf, regionsToRead, pickNextPlace, pickTemplate, pickWormholeStage } = require("./places");
const { transition, stageStepOf } = require("./machine");
const { hintLine, startLine, loreOf, loreLine, foundLine, endLine, stolenHintLine, stolenEndLine,
  whClosedHintLine } = require("./hints");
const { validateReward } = require("./reward");
const { THEMES } = require("./data/themes");
const { LORE_MIN_CHARS, buildLorePrompt, filterLore, loreReasonOf } = require("./lore");
const { deriveSeed, deterministicUnit } = require("../util/rng");

const MAX_DETAIL = 120;
const PERMILLE = 1000;
const HALF = 0.5;
const FIRST_STAGE = 1;
const DAY_MS = 86400000;
const LORE_PENDING = defaultRepo.LORE_PENDING;
const LORE_AI = defaultRepo.LORE_AI;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function safeCall(fn, fallback = null) {
  try {
    return typeof fn === "function" ? fn() : fallback;
  } catch (_err) {
    return fallback;
  }
}

function viewOf(c) {
  return Object.freeze({ chainId: c.chainId, theme: c.theme, stageNo: c.stageNo, stageCount: c.stageCount,
    state: c.state, stageState: c.stageState, stageKind: c.stageKind, systemId: c.stageSystemId,
    regionId: c.stageRegionId, entrySystemId: c.stageEntrySystemId, deadlineAt: c.deadlineAt });
}

function createArchaeologyService(deps) {
  const { store, worldSeed, settings: P } = deps;
  const repo = deps.repository || defaultRepo;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const getNotices = typeof deps.getNotices === "function" ? deps.getNotices : () => null;
  const getGraph = typeof deps.getGraph === "function" ? deps.getGraph : () => null;
  const getWorld = typeof deps.getWorld === "function" ? deps.getWorld : () => null;
  const getSeasons = typeof deps.getSeasons === "function" ? deps.getSeasons : () => null;
  const onQueued = typeof deps.onQueued === "function" ? deps.onQueued : () => {};
  const getSites = typeof deps.getSites === "function" ? deps.getSites : () => null;
  const getPresence = typeof deps.getPresence === "function" ? deps.getPresence : () => null;
  const adapter = deps.adapter || null;
  const getChatterAi = typeof deps.getChatterAi === "function" ? deps.getChatterAi : () => null;
  const excludedRegionIds = new Set(deps.excludedRegionIds || []);
  const recentLore = new Map();
  const counters = Object.fromEntries(S.COUNTER_NAMES.map((n) => [n, 0]));
  const queue = [];
  const wake = new Set();
  let stopped = false;
  let passes = 0;
  let last = null;
  let chainsActive = null;
  let whFallbackLogged = false;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", `archaeology.${name}`, n);
  }

  function admits(workClass) {
    const governor = safeCall(getGovernor);
    if (!governor || typeof governor.admits !== "function") return true;
    return safeCall(() => governor.admits(workClass) !== false, true);
  }

  function noticesNow() {
    const n = safeCall(getNotices);
    if (!n || typeof n.enqueueItemsInTx !== "function" || typeof n.getStatus !== "function") return null;
    const st = safeCall(() => n.getStatus());
    return st && st.state === "running" ? n : null;
  }

  function graphNow() {
    const g = safeCall(getGraph);
    return g && typeof g.getSystem === "function" && typeof g.getNeighbors === "function" ? g : null;
  }

  function seasonKeyNow() {
    const seasons = safeCall(getSeasons);
    const key = seasons && typeof seasons.currentSeasonKey === "function"
      ? safeCall(() => seasons.currentSeasonKey()) : null;
    return S.isSeasonKey(key) ? key : P.seasonKey;
  }

  function systemOf(graph, id) {
    const sys = graph ? safeCall(() => graph.getSystem(id)) : null;
    return sys && typeof sys === "object" ? sys : null;
  }

  function regionNameOf(graph, regionId) {
    const n = graph && typeof graph.getRegionName === "function" ? safeCall(() => graph.getRegionName(regionId)) : null;
    return typeof n === "string" && n !== "" ? n : null;
  }

  function bfsFor(graph, win) {
    const origin = systemOf(graph, win.systemId);
    if (!origin) return null;
    const bfs = bfsOf(graph, { fromSystemId: win.systemId, minJumps: P.minJumps, maxJumps: P.maxJumps,
      maxBfsNodes: P.maxBfsNodes, excludedRegionIds });
    metric("observe", "archaeology.bfsNodes", bfs.nodes);
    return { bfs, originRegionId: isId(origin.regionId) ? origin.regionId : null };
  }

  function controllersInTx(tx, ids) {
    if (ids.length === 0) return new Map();
    const world = safeCall(getWorld);
    const wr = world && world.repository && typeof world.repository.getSystems === "function" ? world.repository : null;
    if (!wr) return null;
    const r = wr.getSystems(tx, ids, { includeInfluence: false });
    if (!r || r.ok !== true || !Array.isArray(r.systems)) return null;
    return new Map(r.systems.map((s) => [s.systemId, isId(s.controllerFactionId) ? s.controllerFactionId : null]));
  }

  function startInTx(tx, o) {
    const { win, seasonKey, now, pre } = o;
    const dup = repo.getByOriginInTx(tx, win.instanceId, win.outcomeId);
    if (dup) return { ok: true, chainId: dup.chainId, created: false };
    const characterId = win.characterId;
    const st = repo.seasonStatsInTx(tx, characterId, seasonKey, now - P.retentionMs);
    const seasonCount = seasonKey === P.seasonKey ? st.recent : st.maxNo;
    const lim = checkLimits({ hasActive: repo.hasActiveInTx(tx, characterId), seasonCount,
      lastEndedAt: repo.lastEndedAtInTx(tx, characterId), activeTotal: repo.countActiveInTx(tx) }, P, now);
    if (!lim.ok) return lim;
    const chainNo = st.maxNo + 1;
    const seed = deriveSeed(worldSeed, "arch", seasonKey, characterId, chainNo);
    const theme = deterministicUnit(seed, "theme") < HALF ? S.THEME.JOVE : S.THEME.DRIFTER;
    const stageCount = P.stageCountMin
      + Math.floor(deterministicUnit(seed, "count") * (P.stageCountMax - P.stageCountMin + 1));
    let kind = deterministicUnit(seed, "kind", FIRST_STAGE) * PERMILLE < P.hostileNullPermille
      ? S.STAGE_KIND.HOSTILE_NULL : S.STAGE_KIND.NULL;
    const visitedRegionIds = isId(pre.originRegionId) ? [pre.originRegionId] : [];
    const cands = orderOf(pre.bfs, { seed, stageNo: FIRST_STAGE, visitedRegionIds });
    let controllerOf = new Map();
    let worldUnavailable = false;
    if (kind === S.STAGE_KIND.HOSTILE_NULL) {
      const read = controllersInTx(tx, regionsToRead(cands, { kind, hostileRegionTries: P.hostileRegionTries,
        maxReadIds: o.maxReadIds }));
      if (read === null) {
        kind = S.STAGE_KIND.NULL;
        worldUnavailable = true;
      } else controllerOf = read;
    }
    const place = pickNextPlace(cands, { kind, seed, stageNo: FIRST_STAGE, controllerOf });
    if (!place.ok) return place;
    const tpl = pickTemplate({ theme, controllerFactionId: controllerOf.get(place.systemId) || null, seed,
      stageNo: FIRST_STAGE });
    if (!tpl.ok) return tpl;
    const chainId = S.chainIdOf(seasonKey, characterId, chainNo);
    const deadlineAt = now + P.chainMaxMs;
    const ins = repo.insertChainInTx(tx, { chainId, characterId, seasonKey, chainNo, originInstanceId: win.instanceId,
      originOutcomeId: win.outcomeId, originSystemId: win.systemId, theme, seed, stageCount, stageKind: place.kind,
      stageSystemId: place.systemId, stageRegionId: place.regionId, stageTemplateId: tpl.templateId,
      stageFactionId: tpl.factionId, visitedRegions: [...visitedRegionIds, place.regionId],
      nextCheckAt: now, deadlineAt, now });
    if (!ins.ok) throw new Error(`archaeology insert ${ins.reason} ${ins.detail || ""}`.trim());
    let mail = "skipped";
    const notices = noticesNow();
    if (notices) {
      const graph = o.graph;
      const line = hintLine({ language: P.language, theme, stageNo: FIRST_STAGE, stageCount,
        systemId: place.systemId, systemName: (systemOf(graph, place.systemId) || {}).name || null,
        regionId: place.regionId, regionName: regionNameOf(graph, place.regionId),
        hostile: place.kind === S.STAGE_KIND.HOSTILE_NULL, radiusJumps: P.spawnRadiusJumps, deadlineAt });
      const q = notices.enqueueItemsInTx(tx, [{ eventKey: `arch:hint:${chainId}:${FIRST_STAGE}`, characterId,
        kind: S.KIND_HINT, systemId: place.systemId, line, eventAt: now }], now);
      if (q && q.ok === false && q.reason === "INVALID_INPUT") {
        throw new Error(`archaeology notices INVALID_INPUT ${q.detail || ""}`.trim());
      }
      if (q && q.ok === true && Number(q.inserted) > 0) mail = "queued";
    }
    return { ok: true, chainId, created: true, theme, mail, regionReused: place.regionReused === true,
      worldUnavailable };
  }

  function runStart(win, seasonKey, now, graph) {
    const pre = bfsFor(graph, win);
    if (!pre) return { ok: false, reason: "SYSTEM_UNKNOWN" };
    const r = store.transaction("archaeology.start", (tx) => startInTx(tx, { win, seasonKey, now, pre, graph,
      maxReadIds: deps.maxReadIds }));
    if (!r || r.ok !== true) {
      bump("errors");
      logger.log(`archaeology: start failed - ${(r && r.reason) || "no result"}`
        + `${r && r.error ? ` ${messageOf(r.error)}` : ""}`);
      return { ok: false, reason: "TX_FAILED" };
    }
    return r.value;
  }

  function afterStart(res, win) {
    if (!res.ok) {
      if (S.START_REFUSAL.includes(res.reason)) bump(`starts.refused.${res.reason}`);
      return;
    }
    if (!res.created) {
      bump("starts.duplicate");
      return;
    }
    bump("chains.started");
    bump(res.mail === "queued" ? "mail.queued" : "mail.skipped");
    if (res.regionReused) bump("stages.regionReused");
    if (res.worldUnavailable) bump("places.worldUnavailable");
    logger.log(`archaeology: chain started theme=${res.theme} mail=${res.mail}`);
    const sent = adapter && typeof adapter.sendCharacterSystemLine === "function"
      ? safeCall(() => adapter.sendCharacterSystemLine({ characterId: win.characterId, systemId: win.systemId,
        text: startLine({ language: P.language, theme: res.theme }) })) : null;
    bump(sent && sent.ok === true ? "line.sent" : "line.refused");
  }

  function onHackWin(w) {
    try {
      if (stopped || !w) return;
      bump("hacks.seen");
      if (w.own === true && typeof w.lneEventId === "string" && w.lneEventId.startsWith(S.CHAIN_ID_PREFIX)) {
        bump("hacks.own");
        const id = S.parseStageEventId(w.lneEventId);
        if (id && (wake.has(id.chainId) || wake.size < P.maxHackQueue)) {
          wake.add(id.chainId);
          bump("hacks.ownWake");
          onQueued();
        }
        return;
      }
      if (queue.length >= P.maxHackQueue) {
        bump("hacks.queueDropped");
        return;
      }
      queue.push(w);
      onQueued();
    } catch (_err) {
      bump("errors");
    }
  }

  function handleWin(w, now, graph, seasonKey) {
    if (!graph) {
      bump("starts.refused.GRAPH_NOT_READY");
      return;
    }
    const gate = gateWin(w, { secClass: (systemOf(graph, w.systemId) || {}).secClass || null,
      allowedSecClasses: P.startSecClassSet });
    if (!gate.ok) {
      bump(`starts.refused.${gate.reason}`);
      return;
    }
    bump("starts.rolled");
    if (!rollStart(worldSeed, w, P.startChancePermille).hit) return;
    bump("starts.hit");
    afterStart(runStart(w, seasonKey, now, graph), w);
  }

  function sitesNow() {
    const s = safeCall(getSites);
    if (!s || typeof s.createSiteInTx !== "function" || typeof s.getStatus !== "function") return null;
    const st = safeCall(() => s.getStatus());
    return st && st.state === "running" ? s : null;
  }

  const eventIdOf = (c) => S.stageEventIdOf(c.chainId, c.stageNo, c.stageSpawnNo);
  const kindOf = (seed, stageNo) => (deterministicUnit(seed, "kind", stageNo) * PERMILLE < P.hostileNullPermille
    ? S.STAGE_KIND.HOSTILE_NULL : S.STAGE_KIND.NULL);

  function presenceOf(chain, graph) {
    const p = safeCall(getPresence);
    const st = p && typeof p.getStatus === "function" ? safeCall(() => p.getStatus()) : null;
    if (!graph || !p || typeof p.getSystemPresence !== "function" || !st || st.available === false || st.stale === true) {
      return "unavailable";
    }
    const seen = new Set([chain.stageSystemId]);
    let layer = [chain.stageSystemId];
    for (let d = 0; d <= P.spawnRadiusJumps && layer.length > 0; d += 1) {
      for (const id of layer) {
        const here = safeCall(() => p.getSystemPresence(id));
        const chars = here && Array.isArray(here.characters) ? here.characters : [];
        if (chars.some((c) => c && c.characterId === chain.characterId)) return "near";
      }
      if (d === P.spawnRadiusJumps) break;
      const next = [];
      for (const id of layer) {
        const near = safeCall(() => graph.getNeighbors(id));
        if (!Array.isArray(near)) continue;
        for (const n of near) {
          if (seen.has(n)) continue;
          seen.add(n);
          next.push(n);
        }
      }
      layer = next;
    }
    return "far";
  }

  function siteFactsOf(chain) {
    const sites = sitesNow();
    if (!sites || typeof sites.listSitesByEvent !== "function") return null;
    const list = safeCall(() => sites.listSitesByEvent(eventIdOf(chain)));
    if (!list || list.ok !== true || !Array.isArray(list.sites)) return null;
    const row = list.sites.find((s) => s && s.slot === S.STAGE_SLOT) || null;
    const read = row && adapter && typeof adapter.readSiteHackWins === "function"
      ? safeCall(() => adapter.readSiteHackWins(row.siteKey)) : null;
    return { row, read };
  }

  const originOf = (chain) => (chain.stageKind === S.STAGE_KIND.WH && isId(chain.stageEntrySystemId)
    ? chain.stageEntrySystemId : chain.stageSystemId);

  function pairsReaderOf() {
    let memo;
    return () => {
      if (memo !== undefined) return memo;
      const r = adapter && typeof adapter.readWormholePairs === "function"
        ? safeCall(() => adapter.readWormholePairs({ maxPairs: P.whMaxPairs })) : null;
      if (r && r.ok === true && r.vendorDisabled !== true && Array.isArray(r.pairs)) memo = r.pairs;
      else {
        memo = null;
        if (!whFallbackLogged) {
          whFallbackLogged = true;
          logger.log(`archaeology: wormhole stages fall back - ${r && r.ok === true ? "vendor_disabled"
            : String((r && r.reason) || "no_adapter")}`);
        }
      }
      return memo;
    };
  }

  function prePlace(chain, graph, o) {
    const rollWh = P.wormholeStagesEnabled === true && o.noWh !== true && typeof o.pairsOnce === "function"
      && deterministicUnit(o.seed, "wh", o.stageNo) * PERMILLE < P.wormholePermille;
    const bfs = bfsOf(graph, { fromSystemId: originOf(chain), minJumps: P.minJumps, maxJumps: P.maxJumps,
      maxBfsNodes: P.maxBfsNodes, excludedRegionIds, ...(rollWh ? { withJumps: true } : {}) });
    metric("observe", "archaeology.bfsNodes", bfs.nodes);
    const pre = { cands: orderOf(bfs, { seed: o.seed, stageNo: o.stageNo, visitedRegionIds: o.avoid }),
      kind: kindOf(chain.seed, o.stageNo), seed: o.seed, stageNo: o.stageNo, wh: null, whFallback: false };
    if (rollWh) {
      const pairs = o.pairsOnce();
      const w = pairs ? pickWormholeStage(graph, pairs, { jumpsOf: bfs.jumpsOf, minJumps: P.minJumps, now: o.now,
        whMinRemainingMs: P.whMinRemainingMs, excludedRegionIds, seed: o.seed, stageNo: o.stageNo }) : null;
      if (w && w.ok) pre.wh = w;
      else pre.whFallback = true;
    }
    return pre;
  }

  function placePatchOf(place, now) {
    const wh = place.kind === S.STAGE_KIND.WH;
    return { stageKind: place.kind, stageSystemId: place.systemId, stageRegionId: place.regionId,
      stageEntrySystemId: wh ? place.entrySystemId : null,
      stageDueAt: wh ? Math.min(place.pairExpiresAt > 0 ? place.pairExpiresAt : Number.POSITIVE_INFINITY,
        now + P.whStageMs) : null };
  }

  function pickPlaceInTx(tx, pre, theme) {
    if (pre.wh) {
      const whTpl = pickTemplate({ theme, controllerFactionId: null, seed: pre.seed, stageNo: pre.stageNo });
      if (!whTpl.ok) return whTpl;
      return { ok: true, place: pre.wh, tpl: whTpl, worldUnavailable: false, notes: ["stages.wh"] };
    }
    const notes = pre.whFallback ? ["stages.whFallback"] : [];
    let kind = pre.kind;
    let controllerOf = new Map();
    let worldUnavailable = false;
    if (kind === S.STAGE_KIND.HOSTILE_NULL) {
      const read = controllersInTx(tx, regionsToRead(pre.cands, { kind, hostileRegionTries: P.hostileRegionTries,
        maxReadIds: deps.maxReadIds }));
      if (read === null) {
        kind = S.STAGE_KIND.NULL;
        worldUnavailable = true;
      } else controllerOf = read;
    }
    const place = pickNextPlace(pre.cands, { kind, seed: pre.seed, stageNo: pre.stageNo, controllerOf });
    if (!place.ok) return place;
    const tpl = pickTemplate({ theme, controllerFactionId: controllerOf.get(place.systemId) || null, seed: pre.seed,
      stageNo: pre.stageNo });
    if (!tpl.ok) return tpl;
    return { ok: true, place, tpl, worldUnavailable, notes: [...notes,
      ...(worldUnavailable ? ["places.worldUnavailable"] : [])] };
  }

  function enqueueInTx(tx, items, now) {
    const notices = noticesNow();
    if (!notices) return "skipped";
    const q = notices.enqueueItemsInTx(tx, items, now);
    if (q && q.ok === false && q.reason === "INVALID_INPUT") {
      throw new Error(`archaeology notices INVALID_INPUT ${q.detail || ""}`.trim());
    }
    return q && q.ok === true && Number(q.inserted) > 0 ? "queued" : "skipped";
  }

  function hintOf(cur, stageNo, place, graph, variant, closesAt = null) {
    const spec = { language: P.language, theme: cur.theme, stageNo, stageCount: cur.stageCount,
      systemId: place.systemId, systemName: (systemOf(graph, place.systemId) || {}).name || null,
      regionId: place.regionId, regionName: regionNameOf(graph, place.regionId),
      hostile: place.kind === S.STAGE_KIND.HOSTILE_NULL, radiusJumps: P.spawnRadiusJumps, deadlineAt: cur.deadlineAt,
      ...(place.kind === S.STAGE_KIND.WH ? { kind: S.STAGE_KIND.WH, entrySystemId: place.entrySystemId,
        entrySystemName: (systemOf(graph, place.entrySystemId) || {}).name || null, closesAt } : {}) };
    if (variant === "stolen") return stolenHintLine(spec);
    return variant === "whClosed" ? whClosedHintLine(spec) : hintLine(spec);
  }

  const mailSystemOf = (place) => (place.kind === S.STAGE_KIND.WH ? place.entrySystemId : place.systemId);

  function cleanupInTx(tx, cur, reason) {
    const sites = sitesNow();
    if (sites && typeof sites.cleanupSitesInTx === "function") sites.cleanupSitesInTx(tx, eventIdOf(cur), reason);
  }

  function endInTx(tx, cur, event, now, notes = []) {
    const t = transition(cur.state, event);
    if (!t.ok) throw new Error(`archaeology step ${t.reason}`);
    if (t.to === S.CHAIN_STATE.EXPIRED) cleanupInTx(tx, cur, "EVENT_END");
    const u = repo.endChainInTx(tx, cur.chainId, cur.version, { state: t.to, endReason: t.endReason, now });
    if (!u.ok) throw new Error(`archaeology end ${u.reason} ${u.detail || ""}`.trim());
    return { changed: u.changed, ended: u.changed ? t.to : null, notes: u.changed ? notes : [] };
  }

  function updateInTx(tx, cur, patch, now, extra = {}) {
    const u = repo.updateStageInTx(tx, cur.chainId, cur.version, patch, now);
    if (!u.ok) throw new Error(`archaeology stage ${u.reason} ${u.detail || ""}`.trim());
    return { changed: u.changed, ended: null, ...extra, notes: u.changed ? (extra.notes || []) : [] };
  }

  function spawnInTx(tx, cur, now) {
    const sites = sitesNow();
    if (!sites) return updateInTx(tx, cur, { nextCheckAt: now + P.retryMs }, now);
    const wh = cur.stageKind === S.STAGE_KIND.WH && Number.isSafeInteger(cur.stageDueAt);
    const expiresAt = wh ? cur.stageDueAt : now + P.stageSiteMs;
    const theme = THEMES[cur.theme];
    const c = sites.createSiteInTx(tx, { eventId: eventIdOf(cur), slot: S.STAGE_SLOT, systemId: cur.stageSystemId,
      templateId: cur.stageTemplateId, label: theme ? theme.siteLabel : cur.theme, factionId: cur.stageFactionId,
      expiresAt });
    if (c && c.ok === true) {
      return updateInTx(tx, cur, { stageState: S.STAGE_STATE.SITE_PENDING, ...(wh ? {} : { stageDueAt: expiresAt }),
        nextCheckAt: now + P.sitePollMs }, now, { notes: ["stages.spawned"], nudge: true });
    }
    const reason = (c && c.reason) || "NO_RESULT";
    if (reason === "SITES_FULL" || reason === "SYSTEM_WINDOW_FULL") {
      return updateInTx(tx, cur, { nextCheckAt: now + P.retryMs }, now, { notes: [`sites.refused.${reason}`] });
    }
    return updateInTx(tx, cur, { stageSpawnNo: cur.stageSpawnNo + 1, nextCheckAt: now + P.retryMs }, now,
      { notes: ["sites.refused.OTHER", "errors"], log: `site refused ${reason}${c && c.detail ? ` ${c.detail}` : ""}` });
  }

  function foundInTx(tx, cur, now) {
    const f = repo.insertFragmentInTx(tx, { chainId: cur.chainId, stageNo: cur.stageNo, systemId: cur.stageSystemId,
      regionId: cur.stageRegionId, foundAt: now });
    if (!f.ok) throw new Error(`archaeology fragment ${f.reason} ${f.detail || ""}`.trim());
    return updateInTx(tx, cur, { stageState: S.STAGE_STATE.FOUND, nextCheckAt: now }, now,
      { notes: ["stages.found"], line: foundLine({ language: P.language }), wakeAgain: true });
  }

  function relocatedRegions(cur, regionId) {
    const list = [...cur.visitedRegions];
    const i = list.lastIndexOf(cur.stageRegionId);
    if (i >= 0) list.splice(i, 1);
    return [...list, regionId].slice(-(S.MAX_STAGE_COUNT + 1));
  }

  function stealInTx(tx, cur, now, pre, graph) {
    if (cur.stageNo >= cur.stageCount) {
      const end = endInTx(tx, cur, "STOLEN", now, ["stages.stolen"]);
      if (!end.changed) return end;
      const mail = enqueueInTx(tx, [{ eventKey: `arch:stolen:${cur.chainId}`, characterId: cur.characterId,
        kind: S.KIND_HINT, systemId: cur.stageSystemId, line: stolenEndLine({ language: P.language, theme: cur.theme }),
        eventAt: now }], now);
      end.notes.push(`mail.${mail}`);
      return end;
    }
    if (cur.stageRelocations + 1 > P.maxRelocations) {
      return endInTx(tx, cur, "RELOCATIONS", now, ["stages.stolen"]);
    }
    const pp = pickPlaceInTx(tx, pre, cur.theme);
    if (!pp.ok) return endInTx(tx, cur, "NO_PLACE", now, ["stages.stolen", "stages.noPlace"]);
    const relocations = cur.stageRelocations + 1;
    const placed = placePatchOf(pp.place, now);
    const res = updateInTx(tx, cur, { stageState: S.STAGE_STATE.REVEALED, ...placed, stageTemplateId: pp.tpl.templateId,
      stageFactionId: pp.tpl.factionId, stageSpawnNo: cur.stageSpawnNo + 1, stageRelocations: relocations,
      visitedRegions: relocatedRegions(cur, pp.place.regionId), nextCheckAt: now }, now,
    { notes: ["stages.stolen", "stages.relocated", ...pp.notes] });
    if (!res.changed) return res;
    const mail = enqueueInTx(tx, [{ eventKey: `arch:hint:${cur.chainId}:${cur.stageNo}:m${relocations}`,
      characterId: cur.characterId, kind: S.KIND_HINT, systemId: mailSystemOf(pp.place),
      line: hintOf(cur, cur.stageNo, pp.place, graph, "stolen", placed.stageDueAt), eventAt: now }], now);
    res.notes.push(`mail.${mail}`);
    return res;
  }

  function whReplaceInTx(tx, cur, now, pre, graph, step) {
    if (!pre) throw new Error("archaeology wh replace without place");
    const lost = step && step.lostWin ? ["stages.lostWin"] : [];
    const pp = pickPlaceInTx(tx, pre, cur.theme);
    if (!pp.ok) return endInTx(tx, cur, "NO_PLACE", now, ["stages.noPlace", ...lost]);
    cleanupInTx(tx, cur, "EVENT_END");
    const spawnNo = cur.stageSpawnNo + 1;
    const placed = placePatchOf(pp.place, now);
    const res = updateInTx(tx, cur, { stageState: S.STAGE_STATE.REVEALED, ...placed, stageTemplateId: pp.tpl.templateId,
      stageFactionId: pp.tpl.factionId, stageSpawnNo: spawnNo, visitedRegions: relocatedRegions(cur, pp.place.regionId),
      nextCheckAt: now }, now, { notes: ["stages.whReplaced", ...lost, ...pp.notes] });
    if (!res.changed) return res;
    const mail = enqueueInTx(tx, [{ eventKey: `arch:hint:${cur.chainId}:${cur.stageNo}:w${spawnNo}`,
      characterId: cur.characterId, kind: S.KIND_HINT, systemId: mailSystemOf(pp.place),
      line: hintOf(cur, cur.stageNo, pp.place, graph, "whClosed", placed.stageDueAt), eventAt: now }], now);
    res.notes.push(`mail.${mail}`);
    return res;
  }

  function respawnInTx(tx, cur, now, step, pre, graph) {
    if (cur.stageKind === S.STAGE_KIND.WH) return whReplaceInTx(tx, cur, now, pre, graph, step);
    cleanupInTx(tx, cur, "EVENT_END");
    const patch = { stageState: S.STAGE_STATE.REVEALED, stageSpawnNo: cur.stageSpawnNo + 1, stageDueAt: null,
      nextCheckAt: now };
    const notes = ["stages.respawned", ...(step.lostWin ? ["stages.lostWin"] : [])];
    if (step.specInvalid) {
      notes.push("stages.templateRefused");
      const tpl = pickTemplate({ theme: cur.theme, controllerFactionId: cur.stageKind === S.STAGE_KIND.HOSTILE_NULL
        ? cur.stageFactionId : null, seed: deriveSeed(cur.seed, "respawn", cur.stageSpawnNo + 1),
      stageNo: cur.stageNo });
      if (tpl.ok) Object.assign(patch, { stageTemplateId: tpl.templateId, stageFactionId: tpl.factionId });
    }
    return updateInTx(tx, cur, patch, now, { notes });
  }

  function deliverInTx(tx, cur, now, pre, graph, step) {
    let frag = repo.getFragmentInTx(tx, cur.chainId, cur.stageNo);
    if (!frag) {
      repo.insertFragmentInTx(tx, { chainId: cur.chainId, stageNo: cur.stageNo, systemId: cur.stageSystemId,
        regionId: cur.stageRegionId, foundAt: now });
      frag = repo.getFragmentInTx(tx, cur.chainId, cur.stageNo);
    }
    const last = cur.stageNo >= cur.stageCount;
    let pp = null;
    if (!last) {
      pp = pre ? pickPlaceInTx(tx, pre, cur.theme) : { ok: false, reason: "GRAPH_NOT_READY" };
      if (!pp.ok) {
        if (now - frag.foundAt >= (P.maxPlaceRetries - 1) * P.retryMs) {
          return endInTx(tx, cur, "NO_PLACE", now, ["stages.noPlace"]);
        }
        return updateInTx(tx, cur, { nextCheckAt: now + P.retryMs }, now, { notes: ["stages.noPlace"] });
      }
    }
    const aiLore = frag.loreSource === LORE_AI && typeof frag.loreText === "string" && frag.loreText !== ""
      ? frag.loreText : null;
    const loreNotes = aiLore ? ["lore.ai.delivered"]
      : ["lore.template", ...(step && step.loreNote ? [step.loreNote] : [])];
    let lore = aiLore;
    if (!lore) {
      const used = repo.listFragmentsInTx(tx, cur.chainId).map((x) => x.loreText).filter((t) => typeof t === "string");
      lore = loreOf({ theme: cur.theme, language: P.language, seed: cur.seed, stageNo: cur.stageNo,
        usedTexts: used }) || "";
    }
    const loreText = loreLine({ language: P.language, theme: cur.theme, stageNo: cur.stageNo,
      stageCount: cur.stageCount, lore });
    const placed = last ? null : placePatchOf(pp.place, now);
    const hintText = last ? endLine({ language: P.language, theme: cur.theme, stageCount: cur.stageCount })
      : hintOf(cur, cur.stageNo + 1, pp.place, graph, "plain", placed.stageDueAt);
    let res;
    if (last) res = endInTx(tx, cur, "COMPLETED", now, loreNotes);
    else {
      const reward = pre && pre.reward ? pre.reward : null;
      res = updateInTx(tx, cur, { stageNo: cur.stageNo + 1, stageState: S.STAGE_STATE.REVEALED, ...placed,
        stageTemplateId: pp.tpl.templateId, stageFactionId: pp.tpl.factionId, stageSpawnNo: 0, stageRelocations: 0,
        visitedRegions: [...cur.visitedRegions, pp.place.regionId].slice(-(S.MAX_STAGE_COUNT + 1)),
        ...(reward ? { reward: reward.entries } : {}), nextCheckAt: now }, now, { notes: [...loreNotes,
        ...pp.notes, ...(pp.place.regionReused ? ["stages.regionReused"] : []),
        ...(reward ? ["reward.frozen", ...(reward.missing.length > 0 ? ["reward.typeMissing"] : [])] : [])] });
    }
    if (!res.changed) return res;
    const d = repo.deliverFragmentInTx(tx, cur.chainId, cur.stageNo, { loreSource: aiLore ? LORE_AI : "template",
      loreText, hintText, now });
    if (!d.ok) throw new Error(`archaeology deliver ${d.reason} ${d.detail || ""}`.trim());
    const mail = enqueueInTx(tx, [
      { eventKey: `arch:lore:${cur.chainId}:${cur.stageNo}`, characterId: cur.characterId, kind: S.KIND_LORE,
        systemId: cur.stageSystemId, line: loreText, eventAt: now },
      { eventKey: last ? `arch:end:${cur.chainId}` : `arch:hint:${cur.chainId}:${cur.stageNo + 1}`,
        characterId: cur.characterId, kind: S.KIND_HINT, systemId: last ? cur.stageSystemId : mailSystemOf(pp.place),
        line: hintText, eventAt: now },
    ], now);
    res.notes.push(`mail.${mail}`);
    return res;
  }

  function applyStepInTx(tx, cur, step, now, pre, graph) {
    switch (step.action) {
      case "END": return endInTx(tx, cur, step.event, now);
      case "RESCHEDULE": return updateInTx(tx, cur, { nextCheckAt: step.nextCheckAt }, now,
        { notes: step.note ? [step.note] : [] });
      case "SPAWN": return spawnInTx(tx, cur, now);
      case "ACTIVATE": return updateInTx(tx, cur, { stageState: S.STAGE_STATE.SITE_ACTIVE,
        nextCheckAt: step.nextCheckAt }, now);
      case "FOUND": return foundInTx(tx, cur, now);
      case "STEAL": return stealInTx(tx, cur, now, pre, graph);
      case "RESPAWN": return respawnInTx(tx, cur, now, step, pre, graph);
      case "DELIVER": return deliverInTx(tx, cur, now, pre, graph, step);
      case "LORE_ASK": return loreAskInTx(tx, cur, step, now);
      default: throw new Error(`archaeology step ${step.action}`);
    }
  }

  function chatterAiNow() {
    const ai = safeCall(getChatterAi);
    if (!ai || typeof ai.complete !== "function" || typeof ai.getStatus !== "function") return null;
    const st = safeCall(() => ai.getStatus());
    return st && st.state === "running" ? ai : null;
  }

  const dayStartOf = (now) => now - (now % DAY_MS);
  const epochNow = () => (deps.clock && typeof deps.clock.now === "function" ? deps.clock.now()
    : (last ? last.at : 0));

  const askable = (frag) => Boolean(frag && frag.deliveredAt === null && frag.loreSource === LORE_PENDING
    && frag.loreAttempts === 0);

  function lorePlanOf(chain, now, graph) {
    const r = store.transaction("archaeology.lorePlan", (tx) => ({
      frag: repo.getFragmentInTx(tx, chain.chainId, chain.stageNo),
      asks: repo.countLoreAsksSinceInTx(tx, dayStartOf(now)) }));
    if (!r || r.ok !== true || !r.value.asks || r.value.asks.ok !== true) return { error: true };
    const { frag } = r.value;
    if (askable(frag)) {
      if (r.value.asks.count >= P.maxLoreRequestsPerDay) return { loreNote: "lore.dayLimit" };
      if (!chatterAiNow()) return { loreNote: "lore.refused.OFF" };
      const theme = THEMES[chain.theme];
      const prompt = buildLorePrompt({ theme: chain.theme, stageNo: chain.stageNo, stageCount: chain.stageCount,
        regionName: regionNameOf(graph, chain.stageRegionId), analyzer: theme ? theme.analyzer : null,
        language: P.language, maxLoreChars: P.maxLoreChars });
      return prompt.ok ? { ask: prompt.messages } : { loreNote: "lore.refused.BAD_SPEC" };
    }
    if (frag && frag.deliveredAt === null && frag.loreSource === LORE_PENDING && frag.loreAttempts >= 1
      && now < chain.nextCheckAt) return { skip: true };
    return null;
  }

  function loreAskInTx(tx, cur, step, now) {
    if (cur.stageState !== S.STAGE_STATE.FOUND) return { changed: false };
    const frag = repo.getFragmentInTx(tx, cur.chainId, cur.stageNo);
    const asks = repo.countLoreAsksSinceInTx(tx, dayStartOf(now));
    if (!askable(frag) || !asks.ok || asks.count >= P.maxLoreRequestsPerDay) return { changed: false };
    const m = repo.markLoreAskedInTx(tx, cur.chainId, cur.stageNo);
    if (!m.ok || !m.changed) throw new Error(`archaeology lore mark ${m.ok ? "unchanged" : m.reason}`);
    const res = updateInTx(tx, cur, { nextCheckAt: Math.min(now + P.loreWaitMs, cur.deadlineAt) }, now,
      { notes: ["lore.asked"] });
    if (!res.changed) throw new Error("archaeology lore ask unchanged");
    res.askLore = { chainId: cur.chainId, stageNo: cur.stageNo, theme: cur.theme, messages: step.messages };
    return res;
  }

  function rememberLore(chainId, text) {
    const list = recentLore.get(chainId) || [];
    recentLore.delete(chainId);
    recentLore.set(chainId, [...list, text].slice(-S.MAX_STAGE_COUNT));
    while (recentLore.size > P.maxActiveChains) recentLore.delete(recentLore.keys().next().value);
  }

  function onLoreResult(a, res) {
    try {
      if (stopped) {
        bump("lore.late");
        return;
      }
      const now = epochNow();
      const r = store.transaction("archaeology.lore", (tx) => {
        const cur = repo.getByIdInTx(tx, a.chainId);
        if (!cur || cur.state !== S.CHAIN_STATE.ACTIVE || cur.stageNo !== a.stageNo
          || cur.stageState !== S.STAGE_STATE.FOUND) return { late: true };
        let note;
        let text = null;
        if (res && res.ok === true) {
          const f = filterLore(res.line, { maxLoreChars: P.maxLoreChars });
          if (f.ok) {
            const s = repo.setAiLoreInTx(tx, a.chainId, a.stageNo, f.text);
            if (!s.ok) throw new Error(`archaeology lore ${s.reason}`);
            if (!s.changed) return { late: true };
            note = "lore.ai";
            text = f.text;
          } else note = `lore.refused.${f.reason}`;
        } else note = `lore.refused.${loreReasonOf(res && res.reason)}`;
        const u = repo.rescheduleInTx(tx, a.chainId, cur.version, now, now);
        if (!u.ok) throw new Error(`archaeology lore reschedule ${u.reason}`);
        return { late: false, note, text };
      });
      if (!r || r.ok !== true) {
        bump("errors");
        logger.log(`archaeology: lore result failed - ${(r && r.reason) || "no result"}`);
        return;
      }
      if (r.value.late) {
        bump("lore.late");
        return;
      }
      bump(r.value.note);
      if (r.value.text) rememberLore(a.chainId, r.value.text);
      wake.add(a.chainId);
      onQueued();
    } catch (_err) {
      bump("errors");
    }
  }

  function dispatchLore(a) {
    const ai = chatterAiNow();
    const p = ai ? safeCall(() => ai.complete({ lane: "talk", key: `arch:${String(a.theme).toLowerCase()}`,
      messages: a.messages, minChars: LORE_MIN_CHARS, maxChars: P.maxLoreChars, names: [],
      recent: [...(recentLore.get(a.chainId) || [])] })) : null;
    if (!p || typeof p.then !== "function") {
      onLoreResult(a, { ok: false, reason: ai ? "OTHER" : "OFF" });
      return;
    }
    p.then((res) => onLoreResult(a, res), () => onLoreResult(a, { ok: false, reason: "OTHER" }));
  }

  function stepPlanOf(chain, now, graph, pairsOnce) {
    const facts = {};
    const whStage = chain.stageKind === S.STAGE_KIND.WH;
    if (now < chain.deadlineAt) {
      if (chain.stageState === S.STAGE_STATE.REVEALED) {
        if (!whStage) facts.presence = presenceOf(chain, graph);
      } else if (chain.stageState === S.STAGE_STATE.SITE_PENDING || chain.stageState === S.STAGE_STATE.SITE_ACTIVE) {
        const site = siteFactsOf(chain);
        if (!site) return { step: { action: "RESCHEDULE", nextCheckAt: now + P.sitePollMs }, pre: null };
        facts.site = site;
      }
    }
    let step = stageStepOf(chain, now, facts, P);
    if (step.action === "DELIVER" && P.loreAiEnabled === true && now < chain.deadlineAt) {
      const lore = lorePlanOf(chain, now, graph);
      if (lore && lore.error) {
        return { step: { action: "RESCHEDULE", nextCheckAt: now + P.sitePollMs, note: "errors" }, pre: null };
      }
      if (lore && lore.skip) return { step: { action: "SKIP" }, pre: null };
      if (lore && lore.ask) return { step: { action: "LORE_ASK", messages: lore.ask }, pre: null };
      if (lore && lore.loreNote) step = { ...step, loreNote: lore.loreNote };
    }
    let pre = null;
    const needsPlace = (step.action === "STEAL" && chain.stageNo < chain.stageCount
      && chain.stageRelocations + 1 <= P.maxRelocations)
      || (step.action === "DELIVER" && chain.stageNo < chain.stageCount)
      || (step.action === "RESPAWN" && whStage);
    const ctx = { now, pairsOnce };
    if (needsPlace && graph) {
      if (step.action === "STEAL") {
        pre = prePlace(chain, graph, { ...ctx, stageNo: chain.stageNo, avoid: chain.visitedRegions,
          seed: deriveSeed(chain.seed, "reloc", chain.stageNo, chain.stageRelocations + 1) });
      } else if (step.action === "RESPAWN") {
        pre = prePlace(chain, graph, { ...ctx, stageNo: chain.stageNo, avoid: chain.visitedRegions,
          seed: deriveSeed(chain.seed, "whgone", chain.stageNo, chain.stageSpawnNo + 1), noWh: true });
      } else pre = prePlace(chain, graph, { ...ctx, stageNo: chain.stageNo + 1, avoid: chain.visitedRegions,
        seed: chain.seed });
    } else if (needsPlace) {
      return { step: { action: "RESCHEDULE", nextCheckAt: now + P.retryMs }, pre: null };
    }
    if (pre && step.action === "DELIVER" && chain.stageNo + 1 === chain.stageCount) {
      const entries = (P.finalReward && P.finalReward[chain.theme]) || [];
      if (entries.length === 0) pre.reward = { entries: [], missing: [] };
      else {
        const r = adapter && typeof adapter.readItemTypeFacts === "function"
          ? safeCall(() => adapter.readItemTypeFacts(entries.map((e) => e.typeId))) : null;
        if (!r || r.ok !== true || !(r.facts instanceof Map)) {
          return { step: { action: "RESCHEDULE", nextCheckAt: now + P.retryMs, note: "reward.readRefused" }, pre: null };
        }
        pre.reward = validateReward(entries, r.facts);
      }
    }
    return { step, pre };
  }

  function afterStep(v, chain) {
    for (const name of v.notes || []) bump(name);
    if (v.ended) bump(`chains.ended.${v.ended}`);
    if (v.log) logger.log(`archaeology: ${chain.chainId} ${v.log}`);
    if (v.nudge) {
      const sites = sitesNow();
      if (sites && typeof sites.nudge === "function") safeCall(() => sites.nudge());
    }
    if (v.line) {
      const sent = adapter && typeof adapter.sendCharacterSystemLine === "function"
        ? safeCall(() => adapter.sendCharacterSystemLine({ characterId: chain.characterId,
          systemId: chain.stageSystemId, text: v.line })) : null;
      bump(sent && sent.ok === true ? "line.sent" : "line.refused");
    }
    if (v.wakeAgain) {
      wake.add(chain.chainId);
      onQueued();
    }
    if (v.askLore) dispatchLore(v.askLore);
  }

  function stepRow(chain, now, graph, pairsOnce) {
    if (!chain || chain.state !== S.CHAIN_STATE.ACTIVE) return 0;
    const { step, pre } = stepPlanOf(chain, now, graph, pairsOnce);
    if (step.action === "SKIP") return 0;
    const r = store.transaction("archaeology.step", (tx) => {
      const cur = repo.getByIdInTx(tx, chain.chainId);
      if (!cur || cur.version !== chain.version || cur.state !== S.CHAIN_STATE.ACTIVE) return { changed: false };
      return applyStepInTx(tx, cur, step, now, pre, graph);
    });
    if (!r || r.ok !== true) {
      bump("errors");
      logger.log(`archaeology: step failed - ${(r && r.reason) || "no result"}`
        + `${r && r.error ? ` ${messageOf(r.error)}` : ""}`);
      return 0;
    }
    if (r.value.changed) afterStep(r.value, chain);
    return r.value.changed ? 1 : 0;
  }

  function stepDue(now) {
    const graph = graphNow();
    const pairsOnce = P.wormholeStagesEnabled === true ? pairsReaderOf() : null;
    const done = new Set();
    let steps = 0;
    if (wake.size > 0) {
      const ids = [...wake].slice(0, P.maxRowsPerPass);
      wake.clear();
      const woke = store.transaction("archaeology.due", (tx) => ids.map((id) => repo.getByIdInTx(tx, id))
        .filter(Boolean));
      if (!woke || woke.ok !== true) bump("errors");
      else {
        for (const chain of woke.value) {
          done.add(chain.chainId);
          steps += stepRow(chain, now, graph, pairsOnce);
        }
      }
    }
    const left = P.maxRowsPerPass - done.size;
    if (left <= 0) return steps;
    const list = store.transaction("archaeology.due", (tx) => repo.listDueInTx(tx, now, P.maxRowsPerPass));
    if (!list || list.ok !== true || !list.value || list.value.ok !== true) {
      bump("errors");
      return steps;
    }
    for (const chain of list.value.chains.filter((c) => !done.has(c.chainId)).slice(0, left)) {
      steps += stepRow(chain, now, graph, pairsOnce);
    }
    return steps;
  }

  function retain(now) {
    const before = now - P.retentionMs;
    if (before <= 0) return 0;
    const r = store.transaction("archaeology.retention", (tx) => repo.deleteEndedInTx(tx, before,
      deps.retentionLimit));
    if (r && r.ok === true && r.value && r.value.ok === true) {
      bump("retention.deleted", r.value.deleted);
      return r.value.deleted;
    }
    bump("errors");
    logger.log(`archaeology: retention failed - ${(r && (r.reason || (r.value && r.value.reason))) || "no result"}`);
    return 0;
  }

  function gaugeActive() {
    const r = store.transaction("archaeology.count", (tx) => repo.countActiveInTx(tx));
    if (r && r.ok === true && Number.isSafeInteger(r.value)) {
      chainsActive = r.value;
      metric("gauge", "archaeology.chains.active", chainsActive);
    }
  }

  function runPass(now) {
    if (stopped) return { ok: true, starts: 0, steps: 0, retained: 0, skipped: "STOPPED" };
    if (!admits("MAINTENANCE")) return { ok: true, starts: 0, steps: 0, retained: 0, skipped: "GOVERNOR" };
    const t0 = nowMs();
    const out = { ok: true, starts: 0, steps: 0, retained: 0, skipped: null };
    const graph = queue.length > 0 ? graphNow() : null;
    const seasonKey = queue.length > 0 ? seasonKeyNow() : P.seasonKey;
    while (queue.length > 0 && out.starts < P.maxRowsPerPass) {
      const w = queue.shift();
      out.starts += 1;
      try {
        handleWin(w, now, graph, seasonKey);
      } catch (err) {
        bump("errors");
        logger.log(`archaeology: win dropped - ${messageOf(err)}`);
      }
    }
    try {
      out.steps = stepDue(now);
      out.retained = retain(now);
      gaugeActive();
    } catch (err) {
      bump("errors");
      logger.log(`archaeology: pass threw - ${messageOf(err)}`);
    }
    passes += 1;
    last = Object.freeze({ at: now, starts: out.starts, steps: out.steps, retained: out.retained });
    metric("observe", "archaeology.passMs", Math.max(0, nowMs() - t0));
    return out;
  }

  function startChainInTx(tx, o) {
    if (stopped) return { ok: false, reason: "ARCHAEOLOGY_UNAVAILABLE" };
    const graph = graphNow();
    if (!graph) return { ok: false, reason: "GRAPH_NOT_READY" };
    const pre = bfsFor(graph, o.win);
    if (!pre) return { ok: false, reason: "NO_PLACE" };
    return startInTx(tx, { win: o.win, seasonKey: S.isSeasonKey(o.seasonKey) ? o.seasonKey : seasonKeyNow(),
      now: o.now, pre, graph, maxReadIds: deps.maxReadIds });
  }

  function readChainOf(characterId) {
    if (stopped) return { ok: false, reason: "ARCHAEOLOGY_UNAVAILABLE" };
    if (!isId(characterId)) return { ok: true, chain: null };
    const r = store.transaction("archaeology.read", (tx) => repo.getActiveByCharacterInTx(tx, characterId));
    if (!r || r.ok !== true) return { ok: false, reason: "TX_FAILED" };
    return { ok: true, chain: r.value ? viewOf(r.value) : null };
  }

  return Object.freeze({
    onHackWin,
    runPass,
    startChainInTx,
    readChainOf,
    bump,
    getStatus: () => Object.freeze({ state: stopped ? "stopped" : "running", queued: queue.length, passes, last,
      chainsActive, seasonKey: seasonKeyNow(), counters: Object.freeze({ ...counters }) }),
    isStopped: () => stopped,
    stop() {
      if (stopped) return;
      stopped = true;
      queue.length = 0;
      wake.clear();
      recentLore.clear();
    },
  });
}

function drainInTx(tx, now, limit, repository, sites) {
  const repo = repository || defaultRepo;
  const list = repo.listActiveInTx(tx, limit + 1);
  if (!list.ok) return list;
  const cleanup = sites && typeof sites.cleanupSitesInTx === "function" ? sites : null;
  let cancelled = 0;
  for (const c of list.chains.slice(0, limit)) {
    const t = transition(c.state, "DISABLED");
    if (!t.ok) continue;
    const u = repo.endChainInTx(tx, c.chainId, c.version, { state: t.to, endReason: t.endReason, now });
    if (!u.ok || !u.changed) continue;
    cancelled += 1;
    if (cleanup) cleanup.cleanupSitesInTx(tx, S.stageEventIdOf(c.chainId, c.stageNo, c.stageSpawnNo), "EVENT_CANCELLED");
  }
  return { ok: true, cancelled, more: list.chains.length > limit };
}

module.exports = { createArchaeologyService, drainInTx, viewOf };
