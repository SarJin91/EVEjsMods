"use strict";

const S = require("./schema");
const NR = require("./repository");
const { decideNemesisOnEnd, profileOf, historyPush, decideNemesisReturn, squadSpecOf,
  decideNemesisOnEncounter } = require("./policy");
const { returnLineOf } = require("./data/ranks");
const { buildGroupIndex, hullClassOf } = require("../playerHunt/policy");
const { locateCharacter } = require("../playerHunt/pursuit");
const { TYPES } = require("../battle/data/strengthCatalog");
const { deriveSeed } = require("../util/rng");
const RR = require("../bounty/revengeRepository");
const { revengeIdOf } = require("../bounty/schema");
const { slimNameOf } = require("../bounty/live");
const { doctrineOf } = require("./doctrine");
const DOCTRINE_DATA = require("./data/doctrine");
const { createKillboardRepository } = require("../killboard/repository");
const { createLetterPump } = require("./letters");

const NEMESIS_STEP_METHODS = Object.freeze(["readInTx", "load", "onRevengeEndInTx", "onRevengeEndCommitted",
  "pruneInTx", "notePruned", "isCaptain", "status", "stop", "step", "squadOf", "lettersStep"]);
const MAX_CARGO = 32;
const RETIRE_REASONS = Object.freeze(["IDLE", "MEMBER_GONE"]);
const OPEN_EXISTS = "OPEN_EXISTS";
const CAS_LOST = "CAS_LOST";
const COUNT_REASONS = Object.freeze(["LIMIT_PLAYER", "LIMIT_TOTAL", "KNOWN", "COMMANDER_OPEN", "OK"]);
const SKIP_COUNTERS = Object.freeze({ LIMIT_PLAYER: "nemesisSkippedLimit", LIMIT_TOTAL: "nemesisSkippedLimit",
  KNOWN: "nemesisSkippedKnown", COMMANDER_OPEN: "nemesisSkippedCommander" });
const ZERO_COUNTS = Object.freeze({ openForPlayer: 0, openTotal: 0, commanderOpen: false, pairKnown: false });
const DONE = "DONE";
const MAX_DETAIL = 160;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

let groupIndex = null;
function hullOf(o) {
  if (!isId(o.quarryTypeId)) return null;
  if (!groupIndex) groupIndex = buildGroupIndex(TYPES);
  const cls = hullClassOf({ typeId: o.quarryTypeId, groupId: o.quarryGroupId, capsule: false }, TYPES, groupIndex);
  return typeof cls === "string" && cls !== "" && cls !== "capsule" ? cls : null;
}

const ATTACKER_SHIP = 4;
function killboardProfileOf(rows, characterId, maxEntries) {
  let out = {};
  for (const k of Array.isArray(rows) ? rows : []) {
    if (!k) continue;
    let typeId = null;
    if (k.role === "V") typeId = k.shipTypeId;
    else if (k.role === "A" || k.role === "F") {
      const a = Array.isArray(k.attackers) ? k.attackers.find((x) => Array.isArray(x) && x[0] === characterId) : null;
      typeId = a ? a[ATTACKER_SHIP] : null;
    }
    const hull = hullOf({ quarryTypeId: typeId, quarryGroupId: null });
    if (hull !== null) out = profileOf(out, hull, maxEntries);
  }
  return out;
}

function mergedProfileOf(a, b) {
  const out = {};
  for (const p of [a, b]) {
    if (!p || typeof p !== "object" || Array.isArray(p)) continue;
    for (const [k, v] of Object.entries(p)) if (Number.isSafeInteger(v) && v > 0) out[k] = (out[k] || 0) + v;
  }
  return out;
}

function createNemesisStep(deps) {
  const N = deps.settings;
  const metric = typeof deps.metric === "function" ? deps.metric : () => {};
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const historyMax = Number.isSafeInteger(deps.historyMax) ? deps.historyMax : N.historyMax;
  const counters = Object.fromEntries(S.NEMESIS_COUNTER_NAMES.map((n) => [n, 0]));
  const open = new Map();
  const captains = new Set();
  let cut = false;
  const lastReturn = new Map();
  let nextCheckAt = 0;
  let cursor = "";
  const trophyIds = S.parseTrophyTypeIds(N.trophyTypeIds) || [];
  const kbProfiles = new Map();
  const kb = N.adaptEnabled === true && N.killboardProfileEnabled === true ? createKillboardRepository() : null;
  const seamLogged = new Set();
  const maxEntries = Number.isSafeInteger(N.profileMaxEntries) ? N.profileMaxEntries : undefined;

  function bump(name, n = 1) {
    if (!(n > 0)) return;
    counters[name] += n;
    try {
      metric("count", `bounty.${name}`, n);
    } catch (_err) {
    }
  }

  const letters = createLetterPump({ settings: N, store: deps.store, bump, log });
  const letterKindOf = (action) => (N.letterEnabled === true && Object.hasOwn(S.LETTER_KINDS, action)
    ? S.LETTER_KINDS[action] : null);

  function gauge() {
    try {
      metric("gauge", "bounty.nemesisOpen", open.size);
    } catch (_err) {
    }
  }

  function rebuildCaptains() {
    captains.clear();
    for (const r of open.values()) captains.add(r.commanderId);
  }

  function noteRow(nem) {
    if (S.OPEN_STATES.includes(nem.state)) open.set(nem.nemesisId, nem);
    else {
      open.delete(nem.nemesisId);
      kbProfiles.delete(nem.nemesisId);
    }
    rebuildCaptains();
    gauge();
  }

  function readInTx(tx, now, _recover) {
    const rec = Number.isSafeInteger(now) ? NR.recoverHuntingInTx(tx, now, N.returnCooldownMs) : null;
    const list = NR.listOpenNemesisInTx(tx, N.maxActiveTotal + 1);
    const rows = list.ok ? list.rows : [];
    cut = rows.length > N.maxActiveTotal;
    const pend = N.letterEnabled === true ? NR.listPendingLettersInTx(tx, N.maxActiveTotal) : null;
    return { rows: rows.slice(0, N.maxActiveTotal), recovered: rec && rec.ok ? rec.recovered : 0,
      letters: pend && pend.ok ? pend.rows : [] };
  }

  function load(rows, recovered = 0, letterRows = undefined) {
    if (Array.isArray(letterRows)) letters.load(letterRows);
    open.clear();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!S.OPEN_STATES.includes(r.state)) continue;
      open.set(r.nemesisId, r);
      if (r.returns > 0 && !(lastReturn.get(r.characterId) >= r.updatedAt)) lastReturn.set(r.characterId, r.updatedAt);
    }
    rebuildCaptains();
    for (const id of [...kbProfiles.keys()]) if (!open.has(id)) kbProfiles.delete(id);
    if (cut) {
      cut = false;
      bump("nemesisReadCut");
      log(`nemesis read cut at ${N.maxActiveTotal} open rows`);
    }
    if (recovered > 0) {
      bump("nemesisRecovered", recovered);
      log(`nemesis recovered ${recovered} HUNTING row(s) without an open revenge -> ACTIVE`);
    }
    gauge();
  }

  const params = () => ({ createOn: N.createOn, maxActivePerPlayer: N.maxActivePerPlayer,
    maxActiveTotal: N.maxActiveTotal });

  function createInTx(tx, row, o, now) {
    const nemesisId = S.nemesisIdOf(o.characterId, o.commanderId);
    const hull = hullOf(o);
    const systemId = isId(o.systemId) ? o.systemId : o.killSystemId;
    const spec = { nemesisId, characterId: o.characterId, commanderId: o.commanderId, factionId: o.factionId,
      gangId: o.gangId, name: String(o.commanderName).slice(0, S.MAX_NAME_LENGTH), baseLevel: o.hunterLevel,
      originRevengeId: o.revengeId, originSystemId: systemId,
      seed: deriveSeed(deps.worldSeed >>> 0, S.RNG_STREAM_NEMESIS, nemesisId),
      profile: profileOf(null, hull, maxEntries),
      history: historyPush([], [now, S.HISTORY_KINDS.CREATED, systemId, hull], historyMax),
      letterKind: letterKindOf(S.LETTER_KINDS.CREATED) };
    const j = deps.journal.applyOnce(tx, { key: S.encounterKeyOf(o.revengeId),
      aggregate: { type: S.NEMESIS_AGGREGATE, id: nemesisId }, eventType: S.EVENT_NEMESIS_CREATED,
      payload: { nemesisId, characterId: o.characterId, commanderId: o.commanderId, factionId: o.factionId,
        level: o.hunterLevel, at: now } },
    (db) => {
      const r = NR.createNemesisInTx(db, spec, now);
      return r.ok && r.created ? r : { ok: false, reason: r.reason || "NOT_CREATED" };
    });
    if (j && j.ok === true) {
      return j.duplicate !== true && j.value && j.value.nemesis ? { outcome: "created", nemesis: j.value.nemesis }
        : { outcome: "duplicate" };
    }
    const why = j && j.refusal ? j.refusal.reason : null;
    if (why === "KNOWN" || why === "COMMANDER_OPEN") return { outcome: "none", reason: why };
    return { outcome: "failed", reason: String(why || (j && j.reason) || "no_result") };
  }

  function encounterInTx(tx, nemesisId, o, now) {
    const journal = deps.journal;
    if (!journal || typeof journal.applyOnce !== "function" || typeof journal.findByKey !== "function") {
      return { outcome: "failed", reason: "NO_JOURNAL" };
    }
    const key = S.encounterKeyOf(o.revengeId);
    const seen = journal.findByKey(tx, key);
    if (seen && seen.ok === true && seen.found === true) return { outcome: "duplicate" };
    const read = NR.readNemesisInTx(tx, nemesisId);
    if (!read.ok) return { outcome: "failed", reason: read.reason };
    const nem = read.nemesis;
    if (!nem || nem.state !== S.STATES.HUNTING || nem.openRevengeId !== o.revengeId) {
      return { outcome: "none", reason: "NOT_OPEN" };
    }
    const d = decideNemesisOnEncounter(nem, o, { maxMissedReturns: N.maxMissedReturns });
    if (d.action === "NONE") return { outcome: "none", reason: d.reason };
    const hull = o.engaged === true ? hullOf(o) : null;
    const systemId = isId(o.systemId) ? o.systemId : o.killSystemId;
    const enc = { action: d.action, revengeId: o.revengeId,
      rank: d.action === "WON" && nem.rank < N.maxRank ? nem.rank + 1 : nem.rank,
      nextReturnAt: now + N.returnCooldownMs, profile: profileOf(nem.profile, hull, maxEntries),
      history: historyPush(nem.history, [now, S.HISTORY_KINDS[d.action], systemId, hull], historyMax),
      endReason: d.action === "DEFEATED" || d.action === "RETIRED" ? d.reason : null,
      letterKind: letterKindOf(d.action) };
    const j = journal.applyOnce(tx, { key, aggregate: { type: S.NEMESIS_AGGREGATE, id: nem.nemesisId },
      eventType: S.EVENT_NEMESIS_ENCOUNTER, payload: { nemesisId: nem.nemesisId, revengeId: o.revengeId,
        action: d.action, rank: enc.rank, at: now } },
    (db) => {
      const a = NR.applyEncounterInTx(db, nem, enc, now);
      return a.ok ? a : { ok: false, reason: a.reason };
    });
    if (j && j.ok === true) {
      return j.duplicate !== true && j.value && j.value.nemesis
        ? { outcome: "encounter", action: d.action, nemesis: j.value.nemesis } : { outcome: "duplicate" };
    }
    const why = j && j.refusal ? j.refusal.reason : null;
    return { outcome: "failed", reason: String(why || (j && j.reason) || "no_result") };
  }

  function onRevengeEndInTx(tx, row, o, now) {
    try {
      if (!o) return { outcome: "none", reason: "NO_OUTCOME" };
      const returnOf = (row && row.nemesisId) || (o.nemesisId !== null && o.nemesisId !== undefined ? o.nemesisId
        : null);
      if (returnOf) return encounterInTx(tx, returnOf, o, now);
      if (o.state !== DONE) return { outcome: "none", reason: "NOT_DONE" };
      if (o.engaged !== true) return { outcome: "none", reason: "NOT_ENGAGED" };
      const pre = decideNemesisOnEnd(null, o, ZERO_COUNTS, params());
      if (!COUNT_REASONS.includes(pre.reason)) return { outcome: "none", reason: pre.reason };
      const journal = deps.journal;
      if (!journal || typeof journal.applyOnce !== "function" || typeof journal.findByKey !== "function") {
        return { outcome: "failed", reason: "NO_JOURNAL" };
      }
      const seen = journal.findByKey(tx, S.encounterKeyOf(o.revengeId));
      if (seen && seen.ok === true && seen.found === true) return { outcome: "duplicate" };
      const c = NR.countsInTx(tx, o.characterId, o.commanderId);
      if (!c.ok) return { outcome: "failed", reason: c.reason };
      const d = decideNemesisOnEnd(null, o, c, params());
      if (d.action !== "CREATE") return { outcome: "none", reason: d.reason };
      return createInTx(tx, row, o, now);
    } catch (err) {
      if (tx && tx.inTransaction !== true) throw err;
      return { outcome: "failed", reason: messageOf(err) };
    }
  }

  function onRevengeEndCommitted(res) {
    if (!res) return;
    if (res.outcome === "created" && res.nemesis) {
      open.set(res.nemesis.nemesisId, res.nemesis);
      captains.add(res.nemesis.commanderId);
      bump("nemesisCreated");
      gauge();
      letters.noteCommitted(res.nemesis);
    } else if (res.outcome === "encounter" && res.nemesis) {
      noteRow(res.nemesis);
      letters.noteCommitted(res.nemesis);
      if (S.ENCOUNTER_COUNTERS[res.action]) bump(S.ENCOUNTER_COUNTERS[res.action]);
    } else if (res.outcome === "none") {
      if (SKIP_COUNTERS[res.reason]) bump(SKIP_COUNTERS[res.reason]);
    } else if (res.outcome === "failed") {
      bump("nemesisHookFailed");
      log(`nemesis hook refused - ${res.reason}`);
    }
  }

  function pruneInTx(tx, now, limit) {
    if (!(now - N.retentionMs > 0)) return { pruned: 0 };
    const r = NR.pruneEndedNemesisInTx(tx, now - N.retentionMs, limit);
    return { pruned: r.ok ? r.pruned : 0 };
  }

  const call = (fn, fallback, ...args) => (typeof fn === "function" ? safeCall(() => fn(...args), fallback) : fallback);
  const busyOf = (ctx, id) => Boolean(call(ctx.isWantedBusy, true, id)) || Boolean(call(ctx.isSquadCommander, true, id));
  function memberFacts(ctx, nem) {
    const m = call(ctx.memberOf, null, nem.gangId, nem.commanderId);
    return { member: m && typeof m.member === "boolean" ? m.member : null,
      corpName: m && typeof m.corpName === "string" && m.corpName !== "" ? m.corpName : null };
  }

  function factsOf(nem, ctx, presence, graph, now) {
    const located = presence ? locateCharacter(presence, nem.characterId) : null;
    const sys = located && graph && typeof graph.getSystem === "function"
      ? safeCall(() => graph.getSystem(located.systemId), null) : null;
    const lastAt = lastReturn.get(nem.characterId);
    return { now, located, system: sys ? { secClass: sys.secClass, regionId: sys.regionId } : null,
      openRevenge: Boolean(call(ctx.openFor, true, nem.characterId)),
      lastReturnAt: Number.isSafeInteger(lastAt) ? lastAt : null, commanderBusy: busyOf(ctx, nem.commanderId),
      member: memberFacts(ctx, nem).member };
  }

  function killboardClassesInTx(tx, characterId) {
    try {
      const r = kb.listCharacterKills(tx, { characterId, limit: N.profileKills });
      if (!r || r.ok !== true || !Array.isArray(r.rows)) return { ok: false, reason: String((r && r.reason) || "READ") };
      return { ok: true, profile: killboardProfileOf(r.rows, characterId, maxEntries) };
    } catch (err) {
      return { ok: false, reason: messageOf(err) };
    }
  }

  function returnOne(nem, systemId, now, ctx) {
    const journal = deps.journal;
    if (!journal || typeof journal.applyOnce !== "function") {
      bump("nemesisReturnFailed");
      return false;
    }
    const n = nem.returns + 1;
    const spec = squadSpecOf(nem, N);
    const wantedId = S.returnWantedIdOf(nem.nemesisId, n);
    const history = historyPush(nem.history, [now, S.HISTORY_KINDS.RETURN, systemId, null], historyMax);
    let kbRead = null;
    const res = safeCall(() => deps.store.transaction("bounty.revenge", (tx) => journal.applyOnce(tx, {
      key: S.returnKeyOf(nem.nemesisId, n), aggregate: { type: S.NEMESIS_AGGREGATE, id: nem.nemesisId },
      eventType: S.EVENT_NEMESIS_RETURN, payload: { nemesisId: nem.nemesisId, characterId: nem.characterId, n,
        level: spec.hunterLevel, systemId, at: now } },
    (db) => {
      const m = NR.markHuntingInTx(db, nem, { openRevengeId: revengeIdOf(wantedId), history }, now);
      if (!m.ok) return { ok: false, reason: m.reason };
      const c = RR.createRevengeInTx(db, { wantedId, characterId: nem.characterId, factionId: nem.factionId,
        gangId: nem.gangId, bossCharacterId: nem.commanderId, targetLevel: spec.hunterLevel + 1,
        killSystemId: systemId, killedAt: now, seed: deriveSeed(nem.seed >>> 0, S.RNG_STREAM_RETURN, n),
        delayMs: N.returnLeadMs, windowMs: N.returnWindowMs, nemesisId: nem.nemesisId }, now);
      if (!c.ok || c.created !== true) return { ok: false, reason: c.reason || "NOT_CREATED" };
      kbRead = kb ? killboardClassesInTx(db, nem.characterId) : null;
      return { ok: true, nemesis: m.nemesis, revenge: c.revenge };
    })), null);
    const j = res && res.ok === true ? res.value : null;
    if (j && j.ok === true && j.duplicate !== true && j.value && j.value.nemesis) {
      noteRow(j.value.nemesis);
      if (kbRead) {
        if (kbRead.ok) kbProfiles.set(nem.nemesisId, kbRead.profile);
        else kbProfiles.delete(nem.nemesisId);
        bump(kbRead.ok ? "nemesisKillboardRead" : "nemesisKillboardFailed");
      }
      lastReturn.set(nem.characterId, now);
      call(ctx.adoptRevenge, null, [j.value.revenge]);
      bump("nemesisReturnCreated");
      letters.prepareReturn(j.value.nemesis, j.value.revenge.revengeId, now, ctx);
      return true;
    }
    const why = j && j.refusal ? j.refusal.reason : j && j.duplicate === true ? "DUPLICATE"
      : String((j && j.reason) || (res && res.reason) || "no_result");
    if (why === OPEN_EXISTS) {
      bump("nemesisWaitOpenRevenge");
      return false;
    }
    bump("nemesisReturnFailed");
    if (why === CAS_LOST || why === "DUPLICATE") call(ctx.onStale, null);
    else log(`nemesis return ${nem.nemesisId} refused - ${why}`);
    return false;
  }

  function retireOne(nem, reason, now, ctx) {
    const journal = deps.journal;
    if (!journal || typeof journal.applyOnce !== "function") {
      bump("nemesisRetireFailed");
      log(`nemesis retire ${nem.nemesisId} refused - NO_JOURNAL`);
      return false;
    }
    const history = historyPush(nem.history, [now, S.HISTORY_KINDS.RETIRED, nem.originSystemId, null], historyMax);
    const res = safeCall(() => deps.store.transaction("bounty.nemesis", (tx) => journal.applyOnce(tx, {
      key: S.retireKeyOf(nem.nemesisId), aggregate: { type: S.NEMESIS_AGGREGATE, id: nem.nemesisId },
      eventType: S.EVENT_NEMESIS_RETIRED, payload: { nemesisId: nem.nemesisId, reason, at: now } },
    (db) => {
      const r = NR.retireInTx(db, nem, { reason, history }, now);
      return r.ok ? r : { ok: false, reason: r.reason };
    })), null);
    const j = res && res.ok === true ? res.value : null;
    if (j && j.ok === true && j.duplicate !== true && j.value && j.value.nemesis) {
      noteRow(j.value.nemesis);
      bump("nemesisRetired");
      return true;
    }
    const why = j && j.refusal ? j.refusal.reason : j && j.duplicate === true ? "DUPLICATE"
      : String((j && j.reason) || (res && res.reason) || "no_result");
    bump("nemesisRetireFailed");
    if (why !== CAS_LOST && why !== "DUPLICATE") log(`nemesis retire ${nem.nemesisId} refused - ${why}`);
    call(ctx.onStale, null);
    return false;
  }

  function step(now, ctx) {
    const out = { checked: 0, returned: 0, retired: 0 };
    if (!ctx || !Number.isSafeInteger(now) || now < nextCheckAt) return out;
    nextCheckAt = now + N.checkEveryMs;
    const actives = [...open.values()].filter((r) => r.state === S.STATES.ACTIVE)
      .sort((a, b) => (a.nemesisId < b.nemesisId ? -1 : a.nemesisId > b.nemesisId ? 1 : 0));
    if (actives.length === 0) return out;
    const at = actives.findIndex((r) => r.nemesisId > cursor);
    const order = at <= 0 ? actives : [...actives.slice(at), ...actives.slice(0, at)];
    const batch = order.slice(0, N.checksPerPass);
    cursor = batch.length < actives.length ? batch[batch.length - 1].nemesisId : "";
    const presence = call(ctx.getPresence, null);
    const graph = call(ctx.getGraph, null);
    const params = { idleRetireMs: N.idleRetireMs, returnCooldownMs: N.returnCooldownMs, playerGapMs: N.playerGapMs,
      excludedRegions: ctx.excludedRegions instanceof Set ? ctx.excludedRegions : null };
    for (const nem of batch) {
      const cur = open.get(nem.nemesisId);
      if (!cur || cur.state !== S.STATES.ACTIVE) continue;
      out.checked += 1;
      const d = decideNemesisReturn(cur, factsOf(cur, ctx, presence, graph, now), params);
      if (d.ready) {
        if (returnOne(cur, d.systemId, now, ctx)) out.returned += 1;
        continue;
      }
      if (S.RETURN_REASON_COUNTERS[d.reason]) bump(S.RETURN_REASON_COUNTERS[d.reason]);
      if (RETIRE_REASONS.includes(d.reason) && retireOne(cur, d.reason, now, ctx)) out.retired += 1;
    }
    return out;
  }

  function trophyOf(nem, ctx) {
    const byType = new Map();
    let skipped = 0;
    if (trophyIds.length > 0) {
      const k = call(ctx.typesKnown, null, trophyIds);
      const missing = k && k.ok === true && Array.isArray(k.missing) ? k.missing : null;
      for (const id of trophyIds) {
        if (missing && !missing.includes(id)) byType.set(id, 1);
        else skipped += 1;
      }
    }
    for (let i = 0; i < N.trophyOfficerRolls; i += 1) {
      const o = call(ctx.rollOfficerLoot, null, nem.factionId, deriveSeed(nem.seed >>> 0, S.RNG_STREAM_TROPHY,
        nem.returns, i));
      if (!o || o.ok !== true || !Array.isArray(o.items)) {
        skipped += 1;
        continue;
      }
      for (const it of o.items) {
        if (it && isId(it.typeId) && isId(it.quantity)) byType.set(it.typeId, (byType.get(it.typeId) || 0) + it.quantity);
      }
      skipped += Number.isSafeInteger(o.skipped) && o.skipped > 0 ? o.skipped : 0;
    }
    const all = [...byType].sort((a, b) => a[0] - b[0]).map(([typeId, quantity]) => ({ typeId, quantity }));
    if (all.length > MAX_CARGO) skipped += all.length - MAX_CARGO;
    return { cargo: all.slice(0, MAX_CARGO), skipped };
  }

  function adaptedEscorts(nem, row, base, ctx, pend) {
    if (!Array.isArray(base) || base.length === 0) return base;
    try {
      const d = doctrineOf({ profile: mergedProfileOf(nem.profile, kbProfiles.get(nem.nemesisId)),
        hunterLevel: row.hunterLevel, rank: nem.rank, seed: row.seed, escortCount: base.length }, DOCTRINE_DATA,
      { maxEwarEscorts: N.maxEwarEscorts });
      if (!d.adapted) return base;
      let noProfile = 0;
      let seamFailed = 0;
      const escorts = d.escorts.map((e, i) => {
        if (e.ewarFamily === null) return { hullClass: e.hullClass };
        const p = call(ctx.ewarProfilesOf, null, nem.factionId, e.hullClass, e.ewarFamily);
        const ids = p && p.ok === true && Array.isArray(p.profileIds) ? p.profileIds : [];
        if (ids.length === 0) {
          if (p && p.ok === false && p.reason === "SEAM_UNAVAILABLE") {
            seamFailed += 1;
            const pairKey = `${nem.factionId}/${e.hullClass}`;
            if (!seamLogged.has(pairKey)) {
              seamLogged.add(pairKey);
              log(`nemesis EWAR seam failed ${pairKey} - ${String(p.detail || "SEAM_UNAVAILABLE").slice(0, MAX_DETAIL)}`);
            }
          } else noProfile += 1;
          return { hullClass: e.hullClass };
        }
        const at = deriveSeed(row.seed >>> 0, S.RNG_STREAM_DOCTRINE, "profile", i) % ids.length;
        return { hullClass: e.hullClass, profileId: ids[at] };
      });
      pend.doctrine = 1;
      pend.noProfile = noProfile;
      pend.seamFailed = seamFailed;
      return escorts;
    } catch (_err) {
      return base;
    }
  }

  function squadOf(row, ctx) {
    try {
      const nem = row && typeof row.nemesisId === "string" ? open.get(row.nemesisId) || null : null;
      if (!nem || nem.state !== S.STATES.HUNTING || nem.openRevengeId !== row.revengeId) return null;
      const c = ctx || {};
      if (busyOf(c, nem.commanderId)) return null;
      const spec = squadSpecOf(nem, N);
      const { corpName } = memberFacts(c, nem);
      const slimName = slimNameOf(nem.name);
      const t = trophyOf(nem, c);
      const pend = { doctrine: 0, noProfile: 0, seamFailed: 0 };
      const out = { commanderId: nem.commanderId, slimName, corpName, hunterLevel: spec.hunterLevel,
        extraEscorts: spec.extraEscorts, cargo: t.cargo,
        line: letters.takeReturnLine(row.revengeId) || returnLineOf(slimName, corpName, nem.rank),
        onSpawn: (r) => {
          const cargo = r && r.cargo && typeof r.cargo === "object" ? r.cargo : null;
          const sceneSkipped = cargo && Number.isSafeInteger(cargo.skipped) ? cargo.skipped : 0;
          if (cargo) bump("nemesisTrophySeeded", Number.isSafeInteger(cargo.seeded) ? cargo.seeded : 0);
          bump("nemesisTrophySkipped", t.skipped + sceneSkipped);
          bump("nemesisDoctrine", pend.doctrine);
          bump("nemesisEwarNoProfile", pend.noProfile);
          bump("nemesisEwarSeamFailed", pend.seamFailed);
        } };
      if (N.adaptEnabled === true) out.escortsFor = (base) => adaptedEscorts(nem, row, base, c, pend);
      return out;
    } catch (_err) {
      return null;
    }
  }

  function status() {
    let active = 0;
    let hunting = 0;
    const byRank = {};
    for (const r of open.values()) {
      if (r.state === S.STATES.ACTIVE) active += 1;
      else if (r.state === S.STATES.HUNTING) hunting += 1;
      byRank[r.rank] = (byRank[r.rank] || 0) + 1;
    }
    return Object.freeze({ active, hunting, byRank: Object.freeze(byRank), counters: Object.freeze({ ...counters }),
      letters: letters.status() });
  }

  function lettersStep(now, ctx) {
    try {
      return letters.step(now, ctx);
    } catch (err) {
      bump("nemesisLetterFailed");
      log(`nemesis letters refused - ${messageOf(err)}`);
      return { sent: 0, requested: false };
    }
  }

  return {
    readInTx,
    load,
    onRevengeEndInTx,
    onRevengeEndCommitted,
    pruneInTx,
    notePruned: (n) => bump("nemesisPruned", n),
    isCaptain: (id) => captains.has(id),
    status,
    stop() {
      open.clear();
      captains.clear();
      lastReturn.clear();
      kbProfiles.clear();
      seamLogged.clear();
      letters.stop();
    },
    step,
    squadOf,
    lettersStep,
  };
}

module.exports = { createNemesisStep, NEMESIS_STEP_METHODS, killboardProfileOf };
