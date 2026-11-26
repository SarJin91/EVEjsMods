"use strict";

const { createAbortSentinel } = require("../persistence/store");
const { createRng, deriveSeed } = require("../util/rng");
const { STATE: SITE_STATE } = require("../events/sites/schema");
const data = require("../events/salvage/data");
const S = require("./schema");

const OPEN_SCAN_LIMIT = 16;
const SEED_STREAM = "wbrwd";
const DEFAULT_HULL = "battleship";
const LAST_DEGREE = 359;
const RAD_PER_DEGREE = Math.PI / 180;
const REWARD_ABORT = createAbortSentinel("worldBosses.REWARD_REFUSED");

const messageOf = (err) => String((err && err.message) || err).slice(0, 160);

function safe(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function decideReward(row, facts, P) {
  if (facts.keyFound === true) return { action: "MARK" };
  const endedAt = Number.isSafeInteger(row.endedAt) ? row.endedAt : 0;
  if (facts.now - endedAt > P.rewards.maxAgeMs) return { action: "SKIP", reason: S.REWARD_REASONS.STALE };
  if (!(facts.participants > 0)) return { action: "SKIP", reason: S.REWARD_REASONS.NO_PARTICIPANTS };
  if (facts.liveEnd !== true) return { action: "SKIP", reason: S.REWARD_REASONS.VIRTUAL };
  if (row.rewardAttempts >= P.rewards.maxAttempts) return { action: "SKIP", reason: S.REWARD_REASONS.ATTEMPTS };
  if (facts.siteActive !== true) return { action: "SKIP", reason: S.REWARD_REASONS.NO_SITE };
  return { action: "PLACE" };
}

function payoutPlanOf(bossId, systemId, characterIds, P) {
  const ids = [...new Set(Array.isArray(characterIds) ? characterIds : [])]
    .filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b);
  if (ids.length === 0) return [];
  const amount = Math.min(P.rewards.iskMaxPerCharacter, Math.floor(P.rewards.iskPool / ids.length));
  if (!(amount > 0)) return [];
  return ids.map((characterId) => Object.freeze({ payoutKey: S.payoutKeyOf(bossId, characterId), bossId, characterId,
    systemId, amountIsk: amount }));
}

function chestHullOf(kindEntry) {
  const phases = kindEntry && Array.isArray(kindEntry.phases) ? kindEntry.phases : [];
  const last = phases.length > 0 ? phases[phases.length - 1] : null;
  const flagships = last && Array.isArray(last.units) ? last.units.filter((u) => Boolean(u.profileId)) : [];
  return flagships.length > 0 ? flagships[flagships.length - 1].hullGroup : DEFAULT_HULL;
}

function chestSpecOf(row, site, kindEntry, P, now) {
  if (!site || typeof site.siteKey !== "string" || site.siteKey === "") return { ok: false, reason: "NO_SITE" };
  const hullGroup = chestHullOf(kindEntry);
  const rng = createRng(deriveSeed(row.seed, SEED_STREAM));
  const angle = rng.nextInt(0, LAST_DEGREE) * RAD_PER_DEGREE;
  const R = P.rewards;
  return { ok: true, spec: {
    anomalyId: S.beaconEventIdOf(row.bossId, row.visitNo),
    slot: S.BEACON_SLOT,
    siteKey: site.siteKey,
    systemId: row.systemId,
    offset: { x: Math.round(R.chestOffsetM * Math.cos(angle)), y: 0, z: Math.round(R.chestOffsetM * Math.sin(angle)) },
    shipTypeId: 0,
    hullGroup,
    factionName: data.wreckFactionNameOf(row.factionId),
    ownerId: data.ownerCorporationOf(row.factionId),
    lootRolls: R.lootRolls,
    lootTableId: data.resolveLootTable(row.factionId, hullGroup, { sizedDefault: true,
      fallbackId: R.fallbackLootTableId }),
    nowMs: now,
    expiresAtMs: now + R.aftermathMs,
    fallbackWreckNames: data.fallbackWreckNamesOf(hullGroup, row.factionId),
    adopt: true,
  } };
}

function createRewards(env) {
  const { store, journal, repo, kinds, settings: P } = env;
  const bump = (name, n) => safe(() => env.bump(name, n), null);
  const refuse = (line) => safe(() => env.refuse(line), null);
  const getter = (name) => () => safe(() => (typeof env[name] === "function" ? env[name]() : null), null);
  const getSites = getter("getSites");
  const getWrecks = getter("getWrecks");

  function write(name, fn) {
    const r = store.transaction(`worldBosses.${name}`, fn);
    if (r.ok) return r.value;
    if (r.error !== REWARD_ABORT) bump("passErrors");
    refuse(`REWARD ${name} ${r.reason || "TX_FAILED"}${r.error && r.error !== REWARD_ABORT ? ` ${messageOf(r.error)}`
      : ""}`);
    return null;
  }

  function beaconOf(tx, row) {
    if (!row.siteEventId) return { readable: true, site: null };
    const sites = getSites();
    if (!sites || typeof sites.listSitesByEvent !== "function") return { readable: false, site: null };
    const listed = safe(() => sites.listSitesByEvent(row.siteEventId, tx), null);
    if (!listed || listed.ok !== true || !Array.isArray(listed.sites)) return { readable: false, site: null };
    return { readable: true, site: listed.sites.find((x) => x && x.slot === S.BEACON_SLOT) || null };
  }

  function readDue(now) {
    return store.transaction("worldBosses.rewardRead", (tx) => {
      const due = repo.listRewardDueInTx(tx, now - P.retentionMs, OPEN_SCAN_LIMIT);
      if (!due.ok) throw REWARD_ABORT;
      const items = [];
      for (const row of due.rows) {
        const seen = journal.findByKey(tx, S.keyReward(row.bossId));
        if (!seen || seen.ok !== true) throw REWARD_ABORT;
        const end = journal.findByKey(tx, S.keyEnd(row.bossId));
        if (!end || end.ok !== true) throw REWARD_ABORT;
        const liveEnd = end.found === true && Boolean(end.entry && end.entry.payload)
          && end.entry.payload.mode === S.MODES.LIVE;
        const parts = repo.listParticipantsInTx(tx, row.bossId, P.live.maxParticipants);
        if (!parts.ok) throw REWARD_ABORT;
        const beacon = beaconOf(tx, row);
        if (!beacon.readable && seen.found !== true) continue;
        const site = beacon.site;
        const siteActive = Boolean(site && site.state === SITE_STATE.ACTIVE && typeof site.siteKey === "string");
        const characterIds = parts.rows.map((p) => p.characterId);
        const d = decideReward(row, { now, keyFound: seen.found === true, participants: characterIds.length,
          siteActive, liveEnd }, P);
        const outcome = seen.found === true && seen.entry && seen.entry.payload
          && seen.entry.payload.outcome === S.REWARD_STATES.SKIPPED ? S.REWARD_STATES.SKIPPED : S.REWARD_STATES.PLACED;
        items.push({ row, d, site: siteActive ? site : null, characterIds, outcome, liveEnd });
      }
      return items;
    });
  }

  function currentInTx(tx, row) {
    const got = repo.getInTx(tx, row.bossId);
    if (!got.ok || !got.row || got.row.state !== S.STATES.DEFEATED
      || got.row.rewardState !== S.REWARD_STATES.PENDING || got.row.version !== row.version) {
      throw REWARD_ABORT;
    }
    return got.row;
  }

  function settle(row, characterIds, outcome, reason, now, wreckId) {
    const plan = payoutPlanOf(row.bossId, row.systemId, characterIds, P);
    return write(outcome === S.REWARD_STATES.PLACED ? "rewardPlaced" : "rewardSkipped", (tx) => {
      const current = currentInTx(tx, row);
      const skip = outcome === S.REWARD_STATES.SKIPPED;
      const payload = { bossId: row.bossId, outcome, ...(reason ? { reason } : {}),
        ...(Number.isSafeInteger(wreckId) ? { wreckId } : {}), payouts: plan.length,
        amountIsk: plan.length > 0 ? plan[0].amountIsk : 0 };
      const marked = journal.applyOnce(tx, { key: S.keyReward(row.bossId), aggregate: { type: S.JOURNAL_AGGREGATE,
        id: row.bossId }, eventType: S.EVENT.REWARD, payload }, () => {
        const ins = repo.insertPayoutsInTx(tx, plan, now);
        if (!ins.ok) throw REWARD_ABORT;
        if (skip) env.cleanupInTx(tx, current.siteEventId, "EVENT_END");
        return ins.inserted;
      });
      if (!marked || marked.ok !== true || marked.duplicate === true) throw REWARD_ABORT;
      const w = repo.rewardMarkInTx(tx, { bossId: row.bossId, expectedVersion: current.version, now,
        patch: skip ? { rewardState: outcome, siteEventId: null } : { rewardState: outcome } }, null);
      if (!w.ok) throw REWARD_ABORT;
      return { payouts: Number(marked.value) || 0 };
    });
  }

  function mark(item, now) {
    const done = write("rewardMark", (tx) => {
      const current = currentInTx(tx, item.row);
      const skip = item.outcome === S.REWARD_STATES.SKIPPED;
      if (skip) env.cleanupInTx(tx, current.siteEventId, "EVENT_END");
      const w = repo.rewardMarkInTx(tx, { bossId: item.row.bossId, expectedVersion: current.version, now,
        patch: skip ? { rewardState: item.outcome, siteEventId: null } : { rewardState: item.outcome } }, null);
      if (!w.ok) throw REWARD_ABORT;
      return true;
    });
    if (done) bump(item.outcome === S.REWARD_STATES.SKIPPED ? "rewardSkipped" : "rewardPlaced");
  }

  function attempt(row, now) {
    write("rewardAttempt", (tx) => {
      const current = currentInTx(tx, row);
      const w = repo.rewardMarkInTx(tx, { bossId: row.bossId, expectedVersion: current.version, now,
        patch: { rewardAttempts: current.rewardAttempts + 1 } }, null);
      if (!w.ok) throw REWARD_ABORT;
      return true;
    });
  }

  function place(item, now) {
    const built = chestSpecOf(item.row, item.site, kinds.get(item.row.kind), P, now);
    if (!built.ok) {
      const v = settle(item.row, item.characterIds, S.REWARD_STATES.SKIPPED, built.reason, now, null);
      if (v) {
        bump("rewardSkipped");
        safe(() => env.notePayouts(v.payouts), null);
      }
      return;
    }
    const wrecks = getWrecks();
    const res = wrecks && typeof wrecks.place === "function"
      ? safe(() => wrecks.place(built.spec), { ok: false, reason: "PLACE_THREW" }) || { ok: false }
      : { ok: false, reason: "SEAM_UNAVAILABLE" };
    if (res.ok === true && Number.isSafeInteger(res.vendorWrites) && res.vendorWrites > 0 && wrecks
      && typeof wrecks.flush === "function") {
      safe(() => wrecks.flush(), null);
    }
    if (res.ok !== true) {
      bump("rewardFailed");
      refuse(`REWARD place ${item.row.bossId} ${res.reason || "PLACE_FAILED"}${res.detail ? ` ${res.detail}` : ""}`);
      attempt(item.row, now);
      return;
    }
    const v = settle(item.row, item.characterIds, S.REWARD_STATES.PLACED, null, now,
      Number.isSafeInteger(res.wreckId) ? res.wreckId : null);
    if (!v) return;
    bump("rewardPlaced");
    safe(() => env.notePayouts(v.payouts), null);
  }

  function pass(now) {
    try {
      const read = readDue(now);
      if (!read.ok) {
        if (read.error !== REWARD_ABORT) bump("passErrors");
        refuse(`REWARD read ${read.reason || "TX_FAILED"}`);
        return;
      }
      for (const item of read.value) {
        try {
          if (item.d.action === "MARK") mark(item, now);
          else if (item.d.action === "PLACE") place(item, now);
          else {
            const ids = item.liveEnd === true ? item.characterIds : [];
            const v = settle(item.row, ids, S.REWARD_STATES.SKIPPED, item.d.reason, now, null);
            if (v) {
              bump("rewardSkipped");
              safe(() => env.notePayouts(v.payouts), null);
            }
          }
        } catch (err) {
          bump("passErrors");
          refuse(`REWARD ${item.row.bossId} ${messageOf(err)}`);
        }
      }
    } catch (err) {
      bump("passErrors");
      refuse(`REWARD_THREW ${messageOf(err)}`);
    }
  }

  function releasePass(now) {
    try {
      const read = store.transaction("worldBosses.releaseRead", (tx) => {
        const r = repo.listReleaseDueInTx(tx, now - P.rewards.aftermathMs, OPEN_SCAN_LIMIT);
        if (!r.ok) throw REWARD_ABORT;
        return r.rows;
      });
      if (!read.ok) {
        refuse(`RELEASE read ${read.reason || "TX_FAILED"}`);
        return;
      }
      for (const row of read.value) {
        const v = write("rewardRelease", (tx) => {
          const got = repo.getInTx(tx, row.bossId);
          if (!got.ok || !got.row || got.row.version !== row.version || !got.row.siteEventId) throw REWARD_ABORT;
          const current = got.row;
          const rel = journal.applyOnce(tx, { key: S.keyRelease(row.bossId), aggregate: { type: S.JOURNAL_AGGREGATE,
            id: row.bossId }, eventType: S.EVENT.RELEASED, payload: { bossId: row.bossId,
            siteEventId: current.siteEventId } }, () => {
            env.cleanupInTx(tx, current.siteEventId, "EVENT_END");
            return true;
          });
          if (!rel || rel.ok !== true) throw REWARD_ABORT;
          const w = repo.rewardMarkInTx(tx, { bossId: row.bossId, expectedVersion: current.version, now,
            patch: { siteEventId: null } }, null);
          if (!w.ok) throw REWARD_ABORT;
          return { duplicate: rel.duplicate === true };
        });
        if (v && !v.duplicate) bump("rewardReleased");
      }
    } catch (err) {
      bump("passErrors");
      refuse(`RELEASE_THREW ${messageOf(err)}`);
    }
  }

  return Object.freeze({ pass, releasePass });
}

module.exports = { createRewards, decideReward, payoutPlanOf, chestSpecOf, chestHullOf, OPEN_SCAN_LIMIT };
