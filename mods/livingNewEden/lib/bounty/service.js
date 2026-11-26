"use strict";

const { performance } = require("node:perf_hooks");
const S = require("./schema");
const R = require("./repository");
const { rollTarget, pickNextSystem, gangSpecOf, slotLayout, bossOf } = require("./plan");
const { createRamIndex } = require("./ramIndex");
const { buildTerritory, territorySizes, allocateGangFactions, TERRITORY_CLASSES } = require("./territory");
const { SECURITY_RATING, CANONICAL_GANG_FACTIONS } = require("./data/gangNames");
const { createLiveStep, LIVE_COUNTER_NAMES } = require("./live");
const { createBountyPayoutPump, PAYOUT_COUNTER_NAMES } = require("./payouts");
const { createRevengeStep, REVENGE_COUNTER_NAMES } = require("./revenge");
const RR = require("./revengeRepository");
const { rankBoard, nearOf, compose } = require("./view");
const { deriveSeed } = require("../util/rng");
const { fameWantedIdOf } = require("../fame/schema");

const FAME_BOSS_MEMBER = 0;

const COUNTER_NAMES = Object.freeze(["created", "moved", "held", "expired", "noSystem", "noNeighbor", "noHomeStation",
  "casLost", "duplicate", "pruned", "recovered", "ensured", "ensureFailed", "errors", "notReady", "idle",
  "characterBusy", "memberPending", "noBudget", "ensureDeferred", "resync", "levelFallback", "classFallback",
  "territoryFailed", "factionOff", ...LIVE_COUNTER_NAMES, ...PAYOUT_COUNTER_NAMES, "claimLine", "claimLineFailed",
  ...REVENGE_COUNTER_NAMES,
  "fameCreated", "fameSkippedOpen", "fameNoGang", "fameGangNotReady", "fameFailed"]);
const UNKNOWN_BOSS = "a wanted outlaw";

function claimLineOf(name, level, amountIsk) {
  const isk = String(amountIsk).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `Bounty claimed: ${name || UNKNOWN_BOSS} (wanted level ${level}). Reward: ${isk} ISK.`;
}
const ACTIVE_READ_CAP = 1024;
const MAX_DETAIL = 160;
const LINKED = "LINKED";
const REFUSED = "REFUSED";
const WRITE_COUNTERS = Object.freeze(["created", "moved", "held", "expired", "noSystem", "noNeighbor", "casLost",
  "duplicate", "pruned", "errors", "levelFallback", "classFallback", "revengePruned"]);

const FINAL_ENSURE_REASONS = Object.freeze(["DISABLED", "INVALID_SPEC", "ENSURE_THREW", "no_result"]);

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const isId = (v) => Number.isSafeInteger(v) && v > 0;
function byLastEnsured(a, b) {
  if (a.lastEnsuredAt !== b.lastEnsuredAt) {
    if (a.lastEnsuredAt === null) return -1;
    if (b.lastEnsuredAt === null) return 1;
    return a.lastEnsuredAt - b.lastEnsuredAt;
  }
  return a.gangId - b.gangId;
}

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function createBountyService(deps) {
  const { store, worldSeed, levels } = deps;
  const P = deps.settings;
  const budget = Number.isSafeInteger(deps.ownerCharacterBudget) ? deps.ownerCharacterBudget : 0;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const excludedRegions = new Set(deps.excludedRegionIds || []);
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const slots = P.maxGangs * P.gangMembers;
  const ram = createRamIndex({ respawnCooldownMs: P.respawnCooldownMs, killedCooldownMs: P.killedCooldownMs });
  const memoryProbe = telemetry && typeof telemetry.registerMemoryProbe === "function"
    ? telemetry.registerMemoryProbe("bounty.ramIndex", () => ({ entries: ram.activeCount() })) : null;
  let stopped = false;
  let ready = false;
  let nextResyncAt = Infinity;
  let resyncDue = false;
  let nextPruneAt = 0;
  let linkedSlots = 0;
  let lastPass = null;
  let lastError = null;
  const blockedSlots = new Set();
  const isBlocked = (slot) => blockedSlots.has(slot);
  let passGraph = null;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0)) return;
    counters[name] += n;
    metric("count", `bounty.${name}`, n);
  }

  function log(line) {
    try {
      logger.log(`bounty: ${line}`);
    } catch (_err) {
    }
  }

  const gangs = new Map();
  let territory = null;
  let territoryRetryAt = 0;
  const awake = new Set(Array.isArray(deps.factionIds) ? deps.factionIds : []);

  const pickEscape = (row, now) => pickNextSystem({ seed: row.seed, stayIndex: row.stayIndex, systemId: row.systemId,
    level: row.level, factionId: row.factionId, levels, territory, graph: passGraph, busySystems: ram.busySystems(),
    now, minStayMs: P.minStayMs, highsecEnabled: P.highsecEnabled });
  const claims = [];
  const pump = createBountyPayoutPump({ store, settings: P,
    rewardCreditIsk: typeof deps.rewardCreditIsk === "function" ? deps.rewardCreditIsk
      : () => Promise.resolve({ ok: false, reason: "SEAM_UNAVAILABLE", permanent: false }),
    bump, metric, log: (line) => log(line), isStopped: () => stopped });
  const nemesis = typeof deps.createNemesisStep === "function" && deps.nemesisSettings
    && deps.nemesisSettings.enabled === true ? deps.createNemesisStep({ settings: deps.nemesisSettings, store,
      journal: deps.journal || null, worldSeed, metric, log: (line) => log(line) }) : null;
  let factionNames = null;
  const nemesisCtx = nemesis ? Object.freeze({
    getPresence: typeof deps.getPresence === "function" ? deps.getPresence : () => null,
    getGraph: () => passGraph,
    openFor: (characterId) => revenge.openFor(characterId),
    isWantedBusy: (characterId) => Boolean(ram.byCharacter(characterId)),
    isSquadCommander: (characterId) => revenge.isCommander(characterId),
    memberOf: (gangId, commanderId) => {
      const vc = vcOf();
      const idn = vc ? safeCall(() => vc.getOwnerIdentity(S.OUTLAW_OWNER_KIND, gangId), null) : null;
      if (!idn || idn.ok !== true || idn.state !== LINKED || !Array.isArray(idn.characterIds)) {
        return { member: null, corpName: null };
      }
      return { member: idn.characterIds.includes(commanderId), corpName: typeof idn.name === "string" ? idn.name : null };
    },
    adoptRevenge: (rows) => revenge.adopt(rows),
    rollOfficerLoot: typeof deps.rollOfficerLoot === "function" ? deps.rollOfficerLoot : null,
    typesKnown: typeof deps.typesKnown === "function" ? deps.typesKnown : null,
    ewarProfilesOf: typeof deps.ewarProfilesOf === "function" ? deps.ewarProfilesOf : null,
    excludedRegions,
    onStale: () => { resyncDue = true; },
    getNotices: () => (typeof deps.getNotices === "function" ? safeCall(() => deps.getNotices(), null) : null),
    getChatterAi: () => (typeof deps.getChatterAi === "function" ? safeCall(() => deps.getChatterAi(), null) : null),
    pilotNameOf: (characterId) => (typeof deps.characterNameOf === "function"
      ? safeCall(() => deps.characterNameOf(characterId), null) : null),
    factionNameOf: (factionId) => {
      if (factionNames === null && typeof deps.readFactionNames === "function") {
        const r = safeCall(() => deps.readFactionNames(), null);
        if (r && r.ok === true && r.names instanceof Map) factionNames = r.names;
      }
      const n = factionNames ? factionNames.get(factionId) : null;
      return typeof n === "string" && n !== "" ? n : null;
    } }) : null;
  const revenge = createRevengeStep({ settings: P, store, worldSeed, journal: deps.journal || null, excludedRegions,
    getPresence: typeof deps.getPresence === "function" ? deps.getPresence : () => null,
    getGraph: () => passGraph, bump, log: (line) => log(line), onStale: () => { resyncDue = true; },
    levels, getScene: typeof deps.getBountyScene === "function" ? deps.getBountyScene : () => null,
    getHuntScene: typeof deps.getHuntScene === "function" ? deps.getHuntScene : () => null,
    getHuntParams: typeof deps.getHuntParams === "function" ? deps.getHuntParams : () => null,
    getVirtualCorps: () => vcOf(), characterNameOf: typeof deps.characterNameOf === "function" ? deps.characterNameOf
      : null,
    sendCharacterSystemLine: typeof deps.sendCharacterSystemLine === "function" ? deps.sendCharacterSystemLine : null,
    isCharacterBusy: (characterId) => Boolean(ram.byCharacter(characterId))
      || Boolean(nemesis && nemesis.isCaptain(characterId)),
    onRevengeEndInTx: nemesis ? nemesis.onRevengeEndInTx : undefined,
    onRevengeEndCommitted: nemesis ? nemesis.onRevengeEndCommitted : undefined,
    nemesisSquadOf: nemesis ? (row) => nemesis.squadOf(row, nemesisCtx) : undefined,
    fameHighsec: deps.fameHighsec && typeof deps.fameHighsec === "object" ? deps.fameHighsec : null,
    getConcord: typeof deps.getConcord === "function" ? deps.getConcord : () => null });
  const onKilled = (k) => {
    if (k.payout && k.payout.planned) pump.notePlanned();
    claims.push({ characterId: k.characterId, systemId: k.target.systemId, bossId: k.target.characterId,
      level: k.target.level, amountIsk: k.target.rewardIsk });
    revenge.noteKill(k.revenge || null, k.target.wantedId);
  };
  const live = createLiveStep({ settings: P, store, ram, levels, journal: deps.journal || null, onKilled,
    revengeInTx: (tx, target, killerId, at) => revenge.createInTx(tx, target, killerId, at),
    rollOfficerLoot: typeof deps.rollOfficerLoot === "function" ? deps.rollOfficerLoot : null,
    getPresence: typeof deps.getPresence === "function" ? deps.getPresence : () => null,
    getScene: typeof deps.getBountyScene === "function" ? deps.getBountyScene : () => null,
    characterNameOf: typeof deps.characterNameOf === "function" ? deps.characterNameOf : null,
    admitScene: typeof deps.admitScene === "function" ? deps.admitScene : null,
    onResidentsChanged: typeof deps.onResidentsChanged === "function" ? deps.onResidentsChanged : null,
    pickEscape,
    secClassOf: (systemId) => {
      const sys = passGraph ? passGraph.getSystem(systemId) : null;
      return sys ? sys.secClass : null;
    },
    bump, log: (line) => log(line), onStale: () => { resyncDue = true; } });

  function buildGangs(factions) {
    const homes = new Map();
    for (let gangId = 1; gangId <= P.maxGangs; gangId += 1) {
      const factionId = factions[gangId - 1] || null;
      const off = factionId === null || !awake.has(factionId);
      if (!off && !homes.has(factionId)) {
        const home = safeCall(() => deps.homeStationOf(factionId), null);
        homes.set(factionId, home && isId(home.stationId) && isId(home.systemId) ? home : null);
      }
      const home = off ? null : homes.get(factionId);
      if (off) bump("factionOff");
      else if (!home) bump("noHomeStation");
      gangs.set(gangId, { gangId, factionId, home, off, ensuredAt: null, lastEnsuredAt: null, final: false,
        transientLogged: false, identity: "UNKNOWN" });
    }
    const noHome = [...gangs.values()].filter((g) => !g.off && !g.home).map((g) => `${g.gangId}:${g.factionId}`);
    if (noHome.length > 0) log(`no home station for gang ${noHome.join(", ")} - slots left empty (NO_HOME_STATION)`);
  }

  function postFameBounty(spec) {
    if (P.revengeEnabled !== true || P.liveEnabled !== true) return { outcome: "disabled" };
    if (stopped || !ready) return { outcome: "failed", reason: "NOT_READY" };
    const s = spec || {};
    if (!isId(s.characterId) || !isId(s.factionId) || !Number.isSafeInteger(s.period) || s.period < 0
      || !Number.isSafeInteger(s.level) || !isId(s.systemId) || !Number.isSafeInteger(s.at) || s.at < 0
      || !Number.isSafeInteger(s.delayMs) || s.delayMs < 0 || !Number.isSafeInteger(s.windowMs) || s.windowMs <= 0) {
      return { outcome: "failed", reason: "INVALID_INPUT" };
    }
    if (!territory) {
      bump("fameGangNotReady");
      return { outcome: "gangNotReady" };
    }
    const wantedId = fameWantedIdOf(s.characterId, s.factionId, s.period);
    const own = [...gangs.values()].filter((g) => g.factionId === s.factionId && !g.off && g.home)
      .sort((a, b) => a.gangId - b.gangId);
    if (own.length === 0) {
      bump("fameNoGang");
      return { outcome: "noGang" };
    }
    const g = own[deriveSeed(worldSeed >>> 0, S.RNG_STREAM_FAME, wantedId) % own.length];
    const vc = vcOf();
    const boss = bossOf(vc ? safeCall(() => vc.getOwnerIdentity(S.OUTLAW_OWNER_KIND, g.gangId), null) : null,
      FAME_BOSS_MEMBER);
    if (!boss.ok) {
      bump("fameGangNotReady");
      return { outcome: "gangNotReady" };
    }
    const res = safeCall(() => store.transaction("bounty.fame", (tx) => revenge.createFameInTx(tx,
      { wantedId, characterId: s.characterId, factionId: s.factionId, level: s.level, systemId: s.systemId, at: s.at,
        delayMs: s.delayMs, windowMs: s.windowMs }, { gangId: g.gangId, bossCharacterId: boss.characterId })), null);
    if (!res || res.ok !== true || !res.value) {
      const reason = String((res && res.reason) || "no_result");
      revenge.noteFame({ outcome: "failed", reason }, wantedId);
      return { outcome: "failed", reason };
    }
    const out = res.value;
    revenge.noteFame(out, wantedId);
    if (out.outcome === "created") {
      metric("gauge", "bounty.revengeOpen", revenge.openCount());
      return { outcome: "created", revengeId: out.revenge.revengeId };
    }
    if (out.outcome === "failed") return { outcome: "failed", reason: String(out.reason || "no_result") };
    return { outcome: out.outcome };
  }

  function systemsOf(graph) {
    let ids = typeof graph.getSystemIds === "function" ? safeCall(() => graph.getSystemIds(), null) : null;
    if (!Array.isArray(ids) && typeof graph.getSystemsBySecClass === "function") {
      ids = [];
      for (const c of TERRITORY_CLASSES) ids.push(...(safeCall(() => graph.getSystemsBySecClass(c), null) || []));
    }
    const out = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const sys = graph.getSystem(id);
      if (sys && TERRITORY_CLASSES.includes(sys.secClass) && !excludedRegions.has(sys.regionId)) {
        const neighbors = safeCall(() => graph.getNeighbors(id), null);
        out.push({ systemId: id, secClass: sys.secClass, regionId: sys.regionId,
          gated: Array.isArray(neighbors) && neighbors.length > 0 });
      }
    }
    return out;
  }

  function ensureTerritory(graph, now) {
    if (territory) return { ok: true };
    if (now < territoryRetryAt) return { ok: false, detail: "territory retry" };
    const t0 = nowMs();
    const fail = (detail) => {
      bump("territoryFailed");
      territoryRetryAt = now + P.territoryRetryMs;
      lastError = `territory ${detail}`;
      log(`territory refused - ${detail}, retry in ${P.territoryRetryMs} ms`);
      return { ok: false, detail: `territory ${detail}` };
    };
    const systems = systemsOf(graph);
    if (systems.length === 0) return fail("NO_SYSTEMS");
    if (typeof deps.systemFactionsOf !== "function") return fail("NO_FACTION_POLICY");
    const res = safeCall(() => deps.systemFactionsOf(systems.map((s) => s.systemId)), null);
    if (!res || res.ok !== true || !Array.isArray(res.entries)) {
      return fail(String((res && res.reason) || "FACTION_POLICY_FAILED"));
    }
    const factionOfSystem = new Map();
    for (const e of res.entries) {
      if (e && isId(e.systemId)) factionOfSystem.set(e.systemId, isId(e.factionId) ? e.factionId : null);
    }
    const built = buildTerritory({ systems, factionOfSystem, usableFactionIds: CANONICAL_GANG_FACTIONS,
      excludedRegionIds: excludedRegions });
    if (!built.ok) return fail(built.reason);
    territory = built;
    buildGangs(allocateGangFactions(territorySizes(built.lists), CANONICAL_GANG_FACTIONS, P.maxGangs));
    metric("observe", "bounty.territoryMs", Math.max(0, nowMs() - t0));
    const awakeSlots = [...gangs.values()].filter((g) => g.home).length * P.gangMembers;
    log(`territory systems=${built.factionOf.size} gangs=${gangs.size} awakeSlots=${awakeSlots}`);
    return { ok: true };
  }

  function graphOf() {
    const svc = safeCall(() => (typeof deps.getGraph === "function" ? deps.getGraph() : null), null);
    if (!svc) return null;
    if (typeof svc.getNeighbors === "function" && typeof svc.getSystem === "function") return svc;
    const r = typeof svc.getGraph === "function" ? safeCall(() => svc.getGraph(), null) : null;
    return r && r.ok === true && r.graph ? r.graph : null;
  }

  function vcOf() {
    const vc = safeCall(() => (typeof deps.getVirtualCorps === "function" ? deps.getVirtualCorps() : null), null);
    return vc && typeof vc.getOwnerIdentity === "function" ? vc : null;
  }

  function missingOf(idn) {
    if (!idn || idn.ok !== true || idn.state !== LINKED || !Array.isArray(idn.memberIndexes)) return P.gangMembers;
    const have = idn.memberIndexes.filter((n) => Number.isInteger(n) && n < P.gangMembers).length;
    const refused = Number.isSafeInteger(idn.refusedMemberCount) ? idn.refusedMemberCount : 0;
    return Math.max(0, P.gangMembers - have - refused);
  }

  function identityCache(vc) {
    const seen = new Map();
    return (gangId) => {
      if (seen.has(gangId)) return seen.get(gangId);
      const idn = vc ? safeCall(() => vc.getOwnerIdentity(S.OUTLAW_OWNER_KIND, gangId), null) : null;
      const g = gangs.get(gangId);
      if (g) g.identity = idn && idn.ok === true ? idn.state : "UNKNOWN";
      seen.set(gangId, idn);
      return idn;
    };
  }

  function ensureGangs(vc, graph, identityOf, pending, now) {
    if (!vc || typeof vc.ensureOwnerIdentity !== "function") return 0;
    let inFlight = 0;
    for (const g of gangs.values()) {
      if (g.ensuredAt === null) continue;
      const idn = identityOf(g.gangId);
      const done = Boolean(idn && idn.ok === true
        && ((idn.state === LINKED && missingOf(idn) === 0) || idn.state === REFUSED));
      if (done || now - g.ensuredAt >= P.ensureStaleMs || now < g.ensuredAt) {
        g.ensuredAt = null;
        continue;
      }
      inFlight += 1;
    }
    const queue = [...pending].map((id) => gangs.get(id))
      .filter((g) => g && g.home && !g.final && g.ensuredAt === null).sort(byLastEnsured);
    for (const g of queue) {
      if (inFlight >= P.maxEnsuringGangs) {
        bump("ensureDeferred");
        break;
      }
      const idn = identityOf(g.gangId);
      const need = idn && idn.ok === true && idn.state === LINKED ? missingOf(idn) : P.gangMembers;
      const counts = typeof vc.countOwnerCharacters === "function"
        ? safeCall(() => vc.countOwnerCharacters(), null) : null;
      if (!counts || counts.ok !== true || counts.ready !== true || !Number.isFinite(counts.total)
        || counts.total + inFlight * P.gangMembers + need > budget) {
        bump("noBudget");
        break;
      }
      const sys = graph.getSystem(g.home.systemId);
      const bloodlineIds = safeCall(() => deps.bloodlinesOf(g.factionId), null);
      const built = sys ? gangSpecOf({ slot: g.gangId, factionId: g.factionId, worldSeed, members: P.gangMembers,
        home: g.home, system: { constellationId: sys.constellationId, regionId: sys.regionId },
        bloodlineIds: Array.isArray(bloodlineIds) ? bloodlineIds : [], securityRating: SECURITY_RATING })
        : { ok: false, reason: "NO_SYSTEM" };
      if (!built.ok) {
        g.final = true;
        bump("ensureFailed");
        log(`gang ${g.gangId} spec refused - ${built.reason}`);
        continue;
      }
      const r = safeCall(() => vc.ensureOwnerIdentity(built.spec), { ok: false, reason: "ENSURE_THREW" });
      if (r && r.ok === true) {
        g.ensuredAt = now;
        g.lastEnsuredAt = now;
        inFlight += 1;
        bump("ensured");
      } else {
        bump("ensureFailed");
        const reason = String((r && r.reason) || "no_result");
        if (reason === "NOT_STARTED") break;
        if (!FINAL_ENSURE_REASONS.includes(reason)) {
          g.lastEnsuredAt = now;
          if (!g.transientLogged) {
            g.transientLogged = true;
            log(`gang ${g.gangId} ensureOwnerIdentity failed - ${reason}, retried later`);
          }
          break;
        }
        g.final = true;
        log(`gang ${g.gangId} ensureOwnerIdentity refused - ${reason}${r && r.detail ? ` (${r.detail})` : ""}`);
      }
    }
    return inFlight;
  }

  function planCreates(identityOf, now) {
    const candidates = [];
    const pending = new Set();
    const room = Math.min(P.createsPerPass, P.maxActive - ram.activeCount());
    if (room <= 0) return { candidates, pending };
    for (const { slot } of ram.readySlots(now, slots, slots, isBlocked)) {
      const lay = slotLayout(slot, P.gangMembers);
      const g = lay.ok ? gangs.get(lay.gangId) : null;
      if (!g || !g.home) {
        blockedSlots.add(slot);
        continue;
      }
      const idn = identityOf(g.gangId);
      const boss = bossOf(idn, lay.memberIndex);
      if (!boss.ok) {
        if (boss.reason === "MEMBER_PENDING") {
          bump("memberPending");
          if (missingOf(idn) > 0) pending.add(g.gangId);
          else blockedSlots.add(slot);
        } else if (idn && idn.ok === true && idn.state === REFUSED) {
          blockedSlots.add(slot);
        } else if (g.final) {
          blockedSlots.add(slot);
        } else {
          pending.add(g.gangId);
        }
        continue;
      }
      if (candidates.length >= room) continue;
      if (ram.byCharacter(boss.characterId) || revenge.isCommander(boss.characterId)) {
        bump("characterBusy");
        continue;
      }
      candidates.push({ slot, gangId: g.gangId, factionId: g.factionId, characterId: boss.characterId });
    }
    return { candidates, pending };
  }

  const readyAtOfLast = (last) => last.endedAt
    + (last.state === S.STATES.KILLED ? P.killedCooldownMs : P.respawnCooldownMs);

  function writePass(tx, now, graph, due, candidates, prune) {
    const out = { created: 0, moved: 0, held: 0, expired: 0, noSystem: 0, noNeighbor: 0, casLost: 0, duplicate: 0,
      pruned: 0, errors: 0, levelFallback: 0, classFallback: 0, revengePruned: 0 };
    const changes = [];
    const deferred = [];
    let stale = false;
    const busy = ram.busySystems();
    for (const r of due) {
      if (r.expiresAt <= now) {
        const e = R.expireInTx(tx, r, now);
        if (e.ok) {
          out.expired += 1;
          changes.push(e.target);
          if (ram.bySystem(r.systemId).length <= 1) busy.delete(r.systemId);
        } else {
          out.casLost += 1;
        }
        continue;
      }
      const pick = pickNextSystem({ seed: r.seed, stayIndex: r.stayIndex, systemId: r.systemId, level: r.level,
        factionId: r.factionId, levels, territory, graph, busySystems: busy, now, minStayMs: P.minStayMs,
        highsecEnabled: P.highsecEnabled });
      const m = pick.ok ? R.moveInTx(tx, r, pick.systemId, pick.nextMoveAt, now)
        : R.holdInTx(tx, r, now + P.minStayMs, now);
      if (!m.ok) {
        out.casLost += 1;
        continue;
      }
      changes.push(m.target);
      if (pick.ok) {
        out.moved += 1;
        if (ram.bySystem(r.systemId).length <= 1) busy.delete(r.systemId);
        busy.add(pick.systemId);
      } else {
        out.noNeighbor += 1;
        out.held += 1;
      }
    }
    for (const c of candidates) {
      const last = R.lastOfSlotInTx(tx, c.slot);
      if (last && (S.ACTIVE_STATES.includes(last.state) || last.endedAt === null || readyAtOfLast(last) > now)) {
        stale = true;
        continue;
      }
      const cycle = last ? last.cycle + 1 : 1;
      const roll = rollTarget({ worldSeed, slot: c.slot, cycle, factionId: c.factionId, now, levels, territory,
        busySystems: busy, smugglerPermille: P.smugglerPermille, minStayMs: P.minStayMs,
        highsecEnabled: P.highsecEnabled, rewardPermille: P.rewardPermille });
      if (!roll.ok) {
        if (roll.reason === "NO_SYSTEM") {
          out.noSystem += 1;
          deferred.push(c.slot);
        } else {
          out.errors += 1;
        }
        continue;
      }
      if (roll.fallback) out.levelFallback += 1;
      if (roll.classFallback) out.classFallback += 1;
      const made = R.createInTx(tx, { ...roll.row, slot: c.slot, cycle, factionId: c.factionId,
        characterId: c.characterId }, now);
      if (made.ok) {
        out.created += 1;
        changes.push(made.target);
        busy.add(made.target.systemId);
      } else if (made.reason === "DUPLICATE") {
        out.duplicate += 1;
        stale = true;
      } else {
        out.errors += 1;
      }
    }
    if (prune) {
      if (now - P.retentionMs > 0) {
        const p = R.pruneEndedInTx(tx, now - P.retentionMs, P.prunePerRun);
        if (p.ok) out.pruned = p.deleted;
        if (P.revengeEnabled === true) {
          const q = RR.pruneRevengeInTx(tx, now - P.retentionMs, P.prunePerRun);
          if (q.ok) out.revengePruned = q.pruned;
        }
      }
      if (nemesis) out.nemesisPruned = nemesis.pruneInTx(tx, now, P.prunePerRun).pruned;
    }
    return { out, changes, deferred, stale: stale || out.casLost > 0 };
  }

  function resync(now, name, recover) {
    const withRevenge = recover || P.revengeEnabled === true;
    const res = store.transaction(name, (tx) => {
      const r = recover ? R.recoverLiveInTx(tx, now, P.minStayMs) : null;
      return { recovered: r && r.ok ? r.recovered : 0, rows: R.listActiveInTx(tx, ACTIVE_READ_CAP),
        heads: R.listSlotHeadsInTx(tx), revenge: withRevenge ? revenge.readInTx(tx, now, recover) : null,
        nemesis: nemesis ? nemesis.readInTx(tx, now, recover) : null };
    });
    if (!res || res.ok !== true) {
      return { ok: false, reason: String((res && res.reason) || "no_result"),
        ...(res && res.error ? { detail: messageOf(res.error) } : {}) };
    }
    ram.load(res.value.rows, res.value.heads);
    if (res.value.revenge) {
      revenge.load(res.value.revenge.rows);
      bump("revengeRecovered", res.value.revenge.recovered);
      metric("gauge", "bounty.revengeOpen", revenge.openCount());
    }
    if (nemesis && res.value.nemesis) {
      nemesis.load(res.value.nemesis.rows, res.value.nemesis.recovered, res.value.nemesis.letters);
    }
    blockedSlots.clear();
    nextResyncAt = now + P.resyncMs;
    resyncDue = false;
    return { ok: true, recovered: res.value.recovered };
  }

  function sendClaims() {
    while (claims.length > 0) {
      const c = claims.shift();
      const name = deps.characterNameOf ? safeCall(() => deps.characterNameOf(c.bossId), null) : null;
      const r = typeof deps.sendCharacterSystemLine === "function" ? safeCall(() => deps.sendCharacterSystemLine({
        characterId: c.characterId, systemId: c.systemId, text: claimLineOf(typeof name === "string" ? name : null,
          c.level, c.amountIsk) }), null) : null;
      bump(r && r.ok === true ? "claimLine" : "claimLineFailed");
    }
  }

  function boot(now) {
    const r = resync(now, "bounty.boot", true);
    if (!r.ok) return { ok: false, reason: "BOOT_READ_FAILED", detail: r.reason };
    if (P.payoutEnabled === true) {
      const pb = pump.boot();
      if (!pb.ok) return { ok: false, reason: "BOOT_READ_FAILED", detail: `payouts ${pb.reason}` };
    }
    bump("recovered", r.recovered);
    nextPruneAt = now;
    ready = true;
    metric("gauge", "bounty.active", ram.activeCount());
    return { ok: true };
  }

  function runPass(now) {
    if (stopped) return { ok: false, reason: "STOPPED" };
    const t0 = nowMs();
    try {
      const graph = graphOf();
      if (!graph) {
        bump("notReady");
        return { ok: false, reason: "NOT_READY", detail: "graph" };
      }
      const terr = ensureTerritory(graph, now);
      if (!terr.ok) {
        bump("notReady");
        return { ok: false, reason: "NOT_READY", detail: terr.detail };
      }
      if (resyncDue || now >= nextResyncAt) {
        const r = resync(now, "bounty.resync", false);
        if (!r.ok) {
          bump("errors");
          lastError = `resync ${r.reason}${r.detail ? ` ${r.detail}` : ""}`;
          log(`resync refused - ${lastError}`);
          return { ok: false, reason: "TX_FAILED", detail: lastError };
        }
        bump("resync");
      }
      passGraph = graph;
      live.step(now);
      revenge.step(now);
      if (nemesis && P.revengeEnabled === true && P.liveEnabled === true) nemesis.step(now, nemesisCtx);
      if (nemesis) nemesis.lettersStep(now, nemesisCtx);
      sendClaims();
      const workAt = ram.nextWorkAt(now, { maxSlots: slots, maxActive: P.maxActive, nextPruneAt, nextResyncAt,
        skip: isBlocked });
      if (now < workAt) {
        bump("idle");
        return { ok: true, idle: true, active: ram.activeCount() };
      }
      const vc = vcOf();
      const identityOf = identityCache(vc);
      let linked = 0;
      for (let gangId = 1; gangId <= P.maxGangs; gangId += 1) {
        const idn = identityOf(gangId);
        if (idn && idn.ok === true && idn.state === LINKED && Array.isArray(idn.memberIndexes)) {
          linked += idn.memberIndexes.filter((n) => Number.isInteger(n) && n < P.gangMembers).length;
        }
      }
      linkedSlots = linked;
      metric("gauge", "bounty.linkedSlots", linkedSlots);
      const due = ram.dueRows(now, P.movesPerPass);
      const { candidates, pending } = planCreates(identityOf, now);
      const prune = now >= nextPruneAt;
      let out = null;
      if (due.length > 0 || candidates.length > 0 || prune) {
        const res = store.transaction("bounty.pass", (tx) => writePass(tx, now, graph, due, candidates, prune));
        if (!res || res.ok !== true) {
          bump("errors");
          lastError = `${(res && res.reason) || "no_result"}${res && res.error ? ` ${messageOf(res.error)}` : ""}`;
          log(`pass refused - ${lastError}`);
          return { ok: false, reason: "TX_FAILED", detail: lastError };
        }
        out = res.value.out;
        ram.apply(res.value.changes);
        for (const slot of res.value.deferred) ram.defer(slot, now + P.minStayMs);
        if (res.value.stale) resyncDue = true;
        if (prune) nextPruneAt = now + P.pruneEveryMs;
        for (const name of WRITE_COUNTERS) bump(name, out[name]);
        if (nemesis && out.nemesisPruned > 0) nemesis.notePruned(out.nemesisPruned);
      } else {
        bump("idle");
      }
      const ensuring = ensureGangs(vc, graph, identityOf, pending, now);
      metric("gauge", "bounty.active", ram.activeCount());
      if (!out) return { ok: true, idle: true, active: ram.activeCount(), ensuring };
      const ms = Math.max(0, nowMs() - t0);
      metric("observe", "bounty.passMs", ms);
      lastPass = Object.freeze({ at: now, ms, ...out, active: ram.activeCount(), linkedSlots, ensuring });
      return { ok: true, ...out, active: ram.activeCount() };
    } catch (err) {
      bump("errors");
      lastError = messageOf(err);
      log(`pass failed - ${lastError}`);
      return { ok: false, reason: "PASS_FAILED", detail: lastError };
    }
  }

  function residentsFor(systemIds, now) {
    if (stopped || !ready) return { ok: false, reason: "NOT_READY" };
    const bySystem = new Map();
    const leaders = revenge.residents();
    for (const systemId of new Set(Array.isArray(systemIds) ? systemIds.filter(isId) : [])) {
      const list = [];
      for (const r of ram.bySystem(systemId)) {
        if (r.state === S.STATES.ROAMING && Number.isFinite(now) && r.expiresAt <= now) continue;
        if (!list.includes(r.characterId)) list.push(r.characterId);
      }
      for (const id of leaders.get(systemId) || []) if (!list.includes(id)) list.push(id);
      if (list.length > 0) bySystem.set(systemId, list);
    }
    return { ok: true, bySystem };
  }

  let boardCache = null;
  let nicks = new Map();

  function nickOfRow(identityOf, t) {
    if (nicks.has(t.characterId)) return nicks.get(t.characterId);
    let nick = null;
    const lay = slotLayout(t.gangSlot, P.gangMembers);
    const idn = lay.ok ? identityOf(lay.gangId) : null;
    if (idn && idn.ok === true && Array.isArray(idn.memberIndexes) && Array.isArray(idn.memberNames)) {
      const at = idn.memberIndexes.indexOf(lay.memberIndex);
      const name = at >= 0 && Array.isArray(idn.characterIds) && idn.characterIds[at] === t.characterId
        ? idn.memberNames[at] : null;
      if (typeof name === "string" && name !== "") nick = name;
    }
    if (nick === null && deps.characterNameOf) {
      const name = safeCall(() => deps.characterNameOf(t.characterId), null);
      if (typeof name === "string" && name !== "") nick = name;
    }
    nicks.set(t.characterId, nick);
    return nick;
  }

  function listBoardRows(q) {
    if (P.boardEnabled !== true) return { ok: false, reason: "BOUNTY_DISABLED" };
    if (stopped || !ready) return { ok: false, reason: "NOT_READY" };
    const now = q && Number.isFinite(q.now) ? q.now : 0;
    const graph = graphOf();
    const identityOf = identityCache(vcOf());
    const nickOf = (t) => nickOfRow(identityOf, t);
    const o = { now, levels, graph, nickOf };
    const ttl = P.boardCacheTtlMs;
    if (!boardCache || ttl <= 0 || now < boardCache.at || now - boardCache.at >= ttl) {
      nicks = new Map();
      boardCache = { at: now, board: rankBoard(ram.activeRows(), { ...o, keep: P.boardTopRows + P.boardNearRows }) };
    }
    const distances = q && q.distances instanceof Map ? q.distances : null;
    const candidates = [];
    if (distances && P.boardNearRows > 0) {
      for (const [systemId, jumps] of distances) {
        if (jumps <= P.boardNearJumps) candidates.push(...ram.byTraceSystem(systemId));
      }
    }
    const near = nearOf(candidates, { ...o, distances, nearJumps: P.boardNearJumps, nearRows: P.boardNearRows });
    return { ok: true, ...compose(boardCache.board, near, P.boardTopRows) };
  }

  function censusOf(rows) {
    const graph = graphOf();
    const byClass = { highsec: 0, lowsec: 0, nullsec: 0 };
    const regions = new Set();
    for (const r of rows) {
      const sys = graph ? safeCall(() => graph.getSystem(r.systemId), null) : null;
      if (!sys) continue;
      if (Object.hasOwn(byClass, sys.secClass)) byClass[sys.secClass] += 1;
      regions.add(sys.regionId);
    }
    let terr = null;
    if (territory) {
      terr = {};
      for (const [f, l] of territory.lists) {
        terr[f] = { highsec: l.highsec.length, lowsec: l.lowsec.length, nullsec: l.nullsec.length, gangs: 0 };
      }
      for (const g of gangs.values()) if (g.factionId !== null && terr[g.factionId]) terr[g.factionId].gangs += 1;
    }
    return Object.freeze({ ...ram.census(), byClass, regions: regions.size, territory: terr });
  }

  function getStatus() {
    const all = [...gangs.values()];
    const rows = ram.activeRows();
    return Object.freeze({ state: stopped ? "stopped" : "running", ready, active: ram.activeCount(), slots,
      maxActive: P.maxActive, linkedSlots,
      targets: rows.slice(0, P.statusMaxTargets).map((r) => Object.freeze({ wantedId: r.wantedId,
        state: r.state, level: r.level, systemId: r.systemId, characterId: r.characterId })),
      census: censusOf(rows),
      gangs: Object.freeze({ total: all.length, noHome: all.filter((g) => !g.off && !g.home).length,
        off: all.filter((g) => g.off).length,
        ensuring: all.filter((g) => g.ensuredAt !== null).map((g) => g.gangId),
        refused: all.filter((g) => g.final).map((g) => g.gangId) }),
      live: live.status(), ...(P.payoutEnabled === true ? { payouts: pump.status() } : {}),
      ...(P.revengeEnabled === true ? { revenge: revenge.status() } : {}),
      ...(nemesis ? { nemesis: nemesis.status() } : {}), lastPass, lastError,
      counters: Object.freeze({ ...counters }) });
  }

  function runPayoutPass(now) {
    if (stopped || !ready) return Promise.resolve({ ok: false, reason: "NOT_READY" });
    return pump.runPayoutPass(now);
  }

  function onNpcKill(obs, now) {
    if (stopped || !ready) return { ok: false, reason: "NOT_READY" };
    try {
      if (obs && obs.role === "hunter") return revenge.onHunterKill(obs);
      return live.onNpcKill(obs, now);
    } catch (err) {
      bump("errors");
      return { ok: false, reason: "KILL_FAILED", detail: messageOf(err) };
    }
  }

  return {
    boot,
    runPass,
    residentsFor,
    listBoardRows,
    getStatus,
    onNpcKill,
    runPayoutPass,
    postFameBounty,
    stop() {
      stopped = true;
      safeCall(() => live.stop(), null);
      safeCall(() => revenge.stop(), null);
      if (nemesis) safeCall(() => nemesis.stop(), null);
      ram.load([], []);
      if (memoryProbe && memoryProbe.ok === true) safeCall(() => memoryProbe.unregister(), null);
    },
    isStopped: () => stopped,
  };
}

module.exports = { createBountyService, COUNTER_NAMES, ACTIVE_READ_CAP, claimLineOf };
