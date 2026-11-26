"use strict";

const { createSentryHostility } = require("../sentries/hostility");
const { isPassiveKind } = require("../adapter/data/sentryTypes");
const { defendTargets, DEFEND_KINDS } = require("../sentries/defendTargets");

const COUNTER_NAMES = Object.freeze(["engaged", "released", "engageFailed", "proxyHits", "proxyDeferred", "proxyKills",
  "liveKills", "standingDeferred", "proxyCatalogShips", "proxyFlatShips", "engagedLne", "engagedRat",
  "engagedAggressor", "defendScanTruncated", "defendRefuseSkipped", "engagedPlayer", "defendPlayerDeferred",
  "defendPlayerReadFailed"]);
const KIND_COUNTER = Object.freeze({ [DEFEND_KINDS.LNE]: "engagedLne", [DEFEND_KINDS.RAT]: "engagedRat",
  [DEFEND_KINDS.AGGRESSOR]: "engagedAggressor", [DEFEND_KINDS.PLAYER]: "engagedPlayer" });
const LE_DEFERRED = "deferred";
const PLAYER = "player";
const METRIC_STEP_MS = "sentries.stepMs";
const MS_DECIMALS = 1000;
const FACTION = "faction";
const FALLBACK_ENGAGE_TRIES = 3;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isObj = (v) => v !== null && typeof v === "object";

function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function distance(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function createSentryStep(deps) {
  const d = isObj(deps) ? deps : {};
  const L = isObj(d.settings) ? d.settings : {};
  const pumpMs = Number.isSafeInteger(d.pumpMs) && d.pumpMs > 0 ? d.pumpMs : 0;
  const telemetry = d.telemetry || null;
  const nowMs = typeof d.nowMs === "function" ? d.nowMs : () => 0;
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const intOf = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const catalogOn = L.proxyDpsFromCatalog === true && isObj(d.strengthGroups);
  const splitOn = L.proxySplitEnabled === true;
  const defendOn = L.defendEnabled === true;
  const playersOn = defendOn && L.defendPlayersEnabled === true;
  const maxTries = Number.isSafeInteger(L.maxEngageTriesPerSentry) && L.maxEngageTriesPerSentry > 0
    ? L.maxEngageTriesPerSentry : FALLBACK_ENGAGE_TRIES;
  const refuseTtl = defendOn ? intOf(L.defendRefuseTtlPasses) : 0;
  const refuseMax = intOf(L.defendRefuseMaxEntries);
  const refuseOn = refuseTtl > 0 && refuseMax > 0;
  const refused = new Map();
  let passNo = 0;
  let lastPassAt = null;
  let stopped = false;
  let lastSystems = 0;

  function bump(name, n = 1) {
    if (!(n > 0)) return;
    counters[name] += n;
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(`sentries.${name}`, n);
    } catch (_err) {
    }
  }

  function observe(ms) {
    if (!telemetry || typeof telemetry.observe !== "function") return;
    try {
      telemetry.observe(METRIC_STEP_MS, Math.max(0, Math.round(ms * MS_DECIMALS) / MS_DECIMALS));
    } catch (_err) {
    }
  }

  function isRefused(key) {
    const until = refused.get(key);
    if (until === undefined) return false;
    if (until >= passNo) return true;
    refused.delete(key);
    return false;
  }

  function rememberRefusal(key) {
    refused.delete(key);
    if (refused.size >= refuseMax) {
      for (const [k, until] of refused) if (until < passNo) refused.delete(k);
    }
    while (refused.size >= refuseMax) refused.delete(refused.keys().next().value);
    refused.set(key, passNo + refuseTtl);
  }

  function candidateSystems(presence, sentries) {
    const out = [];
    const observed = safeCall(() => presence.observedSystems(), []);
    for (const systemId of Array.isArray(observed) || observed instanceof Set ? observed : []) {
      if (!isId(systemId)) continue;
      const list = safeCall(() => sentries.listLiveInSystem(systemId), []);
      if (Array.isArray(list) && list.length > 0) out.push({ systemId, refs: list });
    }
    out.sort((a, b) => a.systemId - b.systemId);
    return out;
  }

  function lneBySystemOf(now) {
    const map = new Map();
    const groups = typeof d.relationGroups === "function" ? safeCall(() => d.relationGroups(), []) : [];
    for (const g of Array.isArray(groups) ? groups : []) {
      if (!isObj(g) || !isId(g.systemId) || !isId(g.factionId) || !Array.isArray(g.entityIds)) continue;
      if (Number.isSafeInteger(g.engageAfter) && g.engageAfter > now) continue;
      if (!map.has(g.systemId)) map.set(g.systemId, []);
      const list = map.get(g.systemId);
      const hulls = Array.isArray(g.hullGroups) ? g.hullGroups : [];
      g.entityIds.forEach((entityId, i) => {
        if (isId(entityId)) {
          list.push({ entityId, factionId: g.factionId, hullGroup: typeof hulls[i] === "string" ? hulls[i] : null });
        }
      });
    }
    return map;
  }

  function rowDps(hullGroup) {
    const table = isObj(d.strengthGroups) ? d.strengthGroups : null;
    if (table === null || typeof hullGroup !== "string" || !Object.prototype.hasOwnProperty.call(table, hullGroup)) {
      return 0;
    }
    const row = table[hullGroup];
    return isObj(row) && Number.isFinite(row.dps) && row.dps > 0 ? row.dps : 0;
  }

  function step(now, presence, out) {
    if (stopped) return;
    if (refuseOn) passNo += 1;
    const t0 = nowMs();
    let worked = false;
    try {
      const sentries = typeof d.getSentries === "function" ? safeCall(() => d.getSentries()) : null;
      if (!isObj(sentries) || safeCall(() => sentries.getMode()) !== "ready") return;
      const elapsedMs = lastPassAt === null ? pumpMs : Math.min(Math.max(0, now - lastPassAt), 2 * pumpMs);
      lastPassAt = now;
      const systems = candidateSystems(presence, sentries);
      lastSystems = 0;
      if (systems.length === 0) return;
      worked = true;
      const seam = typeof d.getSeam === "function" ? safeCall(() => d.getSeam()) : null;
      if (!isObj(seam) || typeof seam.readSentryScene !== "function") return;
      const lneBySystem = lneBySystemOf(now);
      const res = { systems: 0, engaged: 0, released: 0, proxyHits: 0, kills: 0 };
      const budget = { engages: intOf(L.maxEngagesPerPass), proxyHits: intOf(L.maxProxyHitsPerPass) };
      const hostility = createSentryHostility({ readStanding: d.readStanding, getFactionKind: d.getFactionKind,
        thresholds: d.thresholds, neutralPolicy: d.neutralPolicy || {}, isFactionEnemy: d.isFactionEnemy,
        maxReads: intOf(L.maxStandingReadsPerPass), onDeferred: () => bump("standingDeferred") });
      const standingHostile = hostility.standingHostile;
      const isHostile = hostility.isHostile;

      const release = (systemId, itemId, reason) => {
        const r = safeCall(() => seam.release(systemId, itemId, reason));
        if (isObj(r) && r.ok === true) {
          res.released += 1;
          bump("released");
        }
      };

      const target = (systemId, ref, view, hostiles, remember = false) => {
        const candidates = hostiles.filter((h) => h.dist <= view.maxRangeM);
        if (view.targetId !== null && candidates.some((c) => c.entityId === view.targetId)) {
          if (view.active || budget.engages <= 0) return;
          budget.engages -= 1;
          const r = safeCall(() => seam.engage(systemId, ref.itemId, view.targetId));
          if (!isObj(r) || r.ok !== true) bump("engageFailed");
          return;
        }
        if (view.targetId !== null || view.active) {
          release(systemId, ref.itemId, candidates.length === 0 ? "noTarget" : "targetIneligible");
        }
        const memo = remember && refuseOn;
        let tries = 0;
        for (const c of candidates) {
          if (tries >= maxTries || budget.engages <= 0) break;
          const key = memo ? `${ref.itemId}:${c.entityId}` : null;
          if (key !== null && isRefused(key)) {
            bump("defendRefuseSkipped");
            continue;
          }
          tries += 1;
          budget.engages -= 1;
          const r = safeCall(() => seam.engage(systemId, ref.itemId, c.entityId));
          if (isObj(r) && r.ok === true) {
            if (key !== null) refused.delete(key);
            res.engaged += 1;
            bump("engaged");
            if (typeof c.kind === "string" && Object.prototype.hasOwnProperty.call(KIND_COUNTER, c.kind)) {
              bump(KIND_COUNTER[c.kind]);
            }
            return;
          }
          bump("engageFailed");
          if (remember) {
            if (isObj(r) && r.scope === "target") {
              if (key !== null) rememberRefusal(key);
            } else {
              break;
            }
          }
        }
      };

      const end = (ref, reason, counter) => {
        const r = safeCall(() => sentries.markEnded(ref.sentryId, reason));
        if (isObj(r) && r.ok === true) {
          res.kills += 1;
          bump(counter);
        }
      };

      const shipRow = (h) => (catalogOn ? rowDps(h.hullGroup) : 0);

      const proxy = (ref, view, hostiles) => {
        const flat = intOf(L.proxyDpsPerShip);
        if (flat === 0) return;
        const near = hostiles.filter((h) => h.dist <= L.proxyRangeM);
        if (near.length === 0) return;
        let dps = 0;
        let fromCatalog = 0;
        for (const h of near) {
          const row = shipRow(h);
          if (row > 0) fromCatalog += 1;
          dps += row > 0 ? row : flat;
        }
        land(ref, dps, near.length, fromCatalog);
      };

      const proxySplit = (shooters) => {
        const flat = intOf(L.proxyDpsPerShip);
        if (flat === 0) return;
        const pick = new Map();
        shooters.forEach((s, idx) => {
          for (const h of s.hostiles) {
            if (!(h.dist <= L.proxyRangeM)) continue;
            const cur = pick.get(h.entityId);
            if (cur === undefined || h.dist < cur.dist || (h.dist === cur.dist && s.ref.itemId < cur.itemId)) {
              pick.set(h.entityId, { idx, dist: h.dist, itemId: s.ref.itemId });
            }
          }
        });
        if (pick.size === 0) return;
        shooters.forEach((s, idx) => {
          let dps = 0;
          let ships = 0;
          let fromCatalog = 0;
          for (const h of s.hostiles) {
            const p = pick.get(h.entityId);
            if (p === undefined || p.idx !== idx || !(h.dist <= L.proxyRangeM)) continue;
            const row = shipRow(h);
            if (row > 0) fromCatalog += 1;
            dps += row > 0 ? row : flat;
            ships += 1;
          }
          if (ships > 0) land(s.ref, dps, ships, fromCatalog);
        });
      };

      const land = (ref, dps, ships, fromCatalog) => {
        const hp = Math.round(dps * elapsedMs / 1000);
        if (!(hp >= 1)) return;
        if (budget.proxyHits <= 0) {
          bump("proxyDeferred");
          return;
        }
        budget.proxyHits -= 1;
        const r = safeCall(() => seam.applySentryDamage(ref.itemId, hp));
        if (!isObj(r) || r.ok !== true) return;
        res.proxyHits += 1;
        bump("proxyHits");
        if (catalogOn) {
          bump("proxyCatalogShips", fromCatalog);
          bump("proxyFlatShips", ships - fromCatalog);
        }
        if (r.destroyed === true) end(ref, "PROXY_KILL", "proxyKills");
      };

      let lneAll = null;
      const lneAllOf = () => {
        if (lneAll === null) {
          const s = typeof d.lneEntityIdsAll === "function" ? safeCall(() => d.lneEntityIdsAll(), null) : null;
          lneAll = s instanceof Set ? s : new Set();
        }
        return lneAll;
      };
      const scanOpts = !defendOn ? undefined : (playersOn ? { defendScanMax: intOf(L.defendMaxSceneScan),
        defendPlayers: true } : { defendScanMax: intOf(L.defendMaxSceneScan) });
      const leMemo = new Map();
      let leReads = intOf(L.defendMaxPlayerReadsPerPass);
      const leOf = (ownerId, pilotId) => {
        const key = ownerId < pilotId ? `${ownerId}:${pilotId}` : `${pilotId}:${ownerId}`;
        if (leMemo.has(key)) return leMemo.get(key) === true;
        if (leReads <= 0) {
          leMemo.set(key, LE_DEFERRED);
          bump("defendPlayerDeferred");
          return false;
        }
        leReads -= 1;
        const r = safeCall(() => seam.hasLimitedEngagement(ownerId, pilotId));
        if (isObj(r) && r.ok === true) {
          leMemo.set(key, r.active === true);
        } else {
          leMemo.set(key, false);
          bump("defendPlayerReadFailed");
        }
        return leMemo.get(key) === true;
      };
      const playerAggressorsOf = (ref, view, prot, players) => {
        const out = [];
        if (!playersOn || !isId(ref.characterId) || typeof seam.hasLimitedEngagement !== "function") return out;
        for (const p of players) {
          if (!isObj(p) || !isId(p.characterId) || p.characterId === ref.characterId || !isId(p.entityId)
            || prot.has(p.entityId) || !isObj(p.position)) continue;
          if (!Array.isArray(p.lockedIds) || !p.lockedIds.some((id) => prot.has(id))) continue;
          if (!(distance(view.position, p.position) <= view.maxRangeM)) continue;
          if (leOf(ref.characterId, p.characterId)) out.push({ entityId: p.entityId, position: p.position });
        }
        return out;
      };

      for (const { systemId, refs } of systems) {
        const lne = lneBySystem.get(systemId) || [];
        const scene = safeCall(() => (scanOpts === undefined
          ? seam.readSentryScene(systemId, refs.map((r) => r.itemId), lne.map((e) => e.entityId))
          : seam.readSentryScene(systemId, refs.map((r) => r.itemId), lne.map((e) => e.entityId), scanOpts)));
        if (!isObj(scene) || scene.ok !== true || scene.loaded !== true) continue;
        res.systems += 1;
        if (defendOn && scene.npcScanTruncated === true) bump("defendScanTruncated");
        const npcs = defendOn && Array.isArray(scene.npcs) ? scene.npcs : [];
        const protectedMemo = new Map();
        const npcCorp = new Map();
        const protectedOf = (ref) => {
          const corp = isId(ref.ownerCorpId) ? ref.ownerCorpId : 0;
          if (corp > 0 && !npcCorp.has(corp)) {
            const r = typeof seam.isNpcCorporation === "function" ? safeCall(() => seam.isNpcCorporation(corp)) : null;
            npcCorp.set(corp, !(isObj(r) && r.ok === true && r.npc === false));
          }
          const byCorp = corp > 0 && npcCorp.get(corp) === false;
          const charId = isId(ref.characterId) ? ref.characterId : 0;
          const key = byCorp ? `c:${corp}` : `p:${charId}:${ref.itemId}`;
          if (protectedMemo.has(key)) return protectedMemo.get(key);
          const set = new Set([ref.itemId]);
          for (const p of players) {
            if (!isObj(p) || !isId(p.entityId)) continue;
            if ((charId > 0 && p.characterId === charId) || (byCorp && p.corporationId === corp)) set.add(p.entityId);
          }
          for (const r of refs) {
            if (!isObj(r) || !isId(r.itemId)) continue;
            if ((byCorp && r.ownerCorpId === corp) || (charId > 0 && r.characterId === charId)) set.add(r.itemId);
          }
          protectedMemo.set(key, set);
          return set;
        };
        const views = new Map();
        for (const v of Array.isArray(scene.sentries) ? scene.sentries : []) if (isObj(v)) views.set(v.itemId, v);
        const positions = scene.positions instanceof Map ? scene.positions : new Map();
        const players = Array.isArray(scene.players) ? scene.players : [];
        const shooters = [];
        const ownerOnline = new Map();
        const postTargetable = (ref) => {
          const key = isId(ref.ownerCorpId) ? ref.ownerCorpId : 0;
          if (!ownerOnline.has(key)) {
            ownerOnline.set(key, typeof sentries.ownerOnlineOf === "function"
              && safeCall(() => sentries.ownerOnlineOf(ref, now), false) === true);
          }
          return ownerOnline.get(key);
        };
        for (const ref of refs) {
          const view = views.get(ref.itemId);
          if (!view) continue;
          if (view.gone === true) {
            end(ref, "LIVE_KILL", "liveKills");
            continue;
          }
          if (view.alive !== true || view.position === null) continue;
          const passive = typeof sentries.kindOf === "function"
            && isPassiveKind(safeCall(() => sentries.kindOf(ref), "sentry"));
          if (passive && !postTargetable(ref)) continue;
          const hostiles = [];
          for (const e of lne) {
            const p = positions.get(e.entityId);
            if (p && isHostile(ref, e.factionId)) {
              hostiles.push({ entityId: e.entityId, dist: distance(view.position, p), hullGroup: e.hullGroup });
            }
          }
          hostiles.sort((a, b) => a.dist - b.dist || a.entityId - b.entityId);
          let targets = hostiles;
          let defendRule = false;
          if (ref.ownerKind === FACTION && isId(ref.factionId)) {
            const hostilePlayers = [];
            for (const p of players) {
              if (isObj(p) && isId(p.characterId) && isId(p.entityId) && isObj(p.position)
                && standingHostile(p.characterId, ref.factionId)) {
                hostilePlayers.push({ entityId: p.entityId, dist: distance(view.position, p.position) });
              }
            }
            if (hostilePlayers.length > 0) {
              targets = [...hostiles, ...hostilePlayers].sort((a, b) => a.dist - b.dist || a.entityId - b.entityId);
            }
          } else if (defendOn && ref.ownerKind === PLAYER && !passive) {
            const prot = protectedOf(ref);
            const input = { ref, sentryPos: view.position, maxRangeM: view.maxRangeM, protectedIds: prot,
              lneHostiles: hostiles, lneAll: npcs.length > 0 ? lneAllOf() : new Set(), npcs,
              maxCandidates: intOf(L.defendMaxCandidates) };
            if (playersOn) input.playerAggressors = playerAggressorsOf(ref, view, prot, players);
            targets = defendTargets(input);
            defendRule = true;
          }
          if (!passive && view.incapacitated === true) {
            if (view.targetId !== null || view.active) release(systemId, ref.itemId, "incapacitated");
          } else if (!passive && safeCall(() => sentries.isArmed(ref.itemId), false) === true) {
            target(systemId, ref, view, targets, defendRule);
          }
          if (splitOn) shooters.push({ ref, hostiles });
          else proxy(ref, view, hostiles);
        }
        if (splitOn) proxySplit(shooters);
      }
      lastSystems = res.systems;
      if (isObj(out)) out.sentries = res;
    } catch (_err) {
    } finally {
      if (worked) observe(nowMs() - t0);
    }
  }

  return Object.freeze({
    step,
    stats: () => Object.freeze({ state: stopped ? "stopped" : "running", systems: lastSystems,
      counters: Object.freeze({ ...counters }) }),
    stop() {
      stopped = true;
    },
  });
}

module.exports = { createSentryStep, COUNTER_NAMES };
