"use strict";

const { stableJson } = require("../util/fingerprint");
const { DESTROYED_STATE } = require("../fleets/schema");
const { crewTargets, diffSeats, pickPilots, pickReclaim } = require("./plan");
const { CAUSES, LOSS_CAUSES, PRIORITY, PROTECTED_FLEET_STATES } = require("./schema");

const VERSION_CONFLICT = "VERSION_CONFLICT";

function isTx(tx) {
  return Boolean(tx && typeof tx.prepare === "function");
}

function createReconciler(deps) {
  const repo = deps.repo;
  const S = deps.settings;
  const isObserved = typeof deps.isObserved === "function" ? deps.isObserved : () => false;

  function newShared(budget) {
    return { taken: null, cooling: null, protectedIds: new Set(),
      budget: { seats: budget && Number.isFinite(budget.seats) ? budget.seats : S.maxCrewPerFleet * 2,
        reclaim: budget && Number.isFinite(budget.reclaim) ? budget.reclaim : S.maxReclaimPerPass } };
  }

  function headerChanged(a, b) {
    return a.factionId !== b.factionId || a.corporationId !== b.corporationId || a.compositionSig !== b.compositionSig
      || a.wanted !== b.wanted || a.seated !== b.seated || a.lastSeenAt !== b.lastSeenAt;
  }

  function writeHeader(tx, header, next, at) {
    if (!header) {
      repo.insertHeader(tx, next, at);
      return;
    }
    if (!headerChanged(header, next)) return;
    if (!repo.updateHeader(tx, next, header.version, at)) throw new Error(`${VERSION_CONFLICT} ${next.fleetId}`);
  }

  function takeFrom(tx, heads, need, at, eligible, fleetRepo) {
    if (heads.length === 0 || need <= 0) return [];
    const read = fleetRepo.getFleets(tx, heads.map((h) => h.fleetId));
    if (!read || read.ok !== true) return [];
    const live = new Map(read.fleets.map((f) => [f.fleetId, f]));
    const open = heads.filter((h) => {
      const f = live.get(h.fleetId);
      return f && f.state !== DESTROYED_STATE && !PROTECTED_FLEET_STATES.includes(f.state)
        && !isObserved(f.currentSystemId);
    });
    if (open.length === 0) return [];
    const seatsOf = repo.seatsIn(tx, open.map((h) => h.fleetId));
    const victims = open.map((h) => ({ fleetId: h.fleetId, lastSeenAt: h.lastSeenAt,
      seats: (seatsOf.get(h.fleetId) || []).filter((s) => eligible.has(s.characterId)) }));
    const picks = pickReclaim({ need, victims, minIdleMs: S.reclaimMinIdleMs, at });
    const perFleet = new Map();
    for (const p of picks) {
      repo.deleteSeat(tx, p.fleetId, p.seat);
      perFleet.set(p.fleetId, (perFleet.get(p.fleetId) || 0) + 1);
    }
    for (const h of open) {
      const n = perFleet.get(h.fleetId);
      if (!n) continue;
      writeHeader(tx, h, { ...h, seated: Math.max(0, h.seated - n) }, at);
    }
    return picks;
  }

  function reclaimFor(tx, fleet, need, at, sh, pool, fleetRepo) {
    const corp = fleet.corporationId !== null && pool.byCorp.has(fleet.corporationId) ? fleet.corporationId : null;
    const eligible = new Set([...(corp !== null ? pool.byCorp.get(corp) : []),
      ...(pool.byFaction.get(fleet.factionId) || [])]);
    const seen = new Set([fleet.fleetId]);
    const headsOf = (corporationId) => repo.reclaimCandidates(tx, { factionId: fleet.factionId, corporationId,
      seenBefore: at - S.reclaimMinIdleMs, limit: S.maxFleetsPerPass })
      .filter((h) => !seen.has(h.fleetId) && !sh.protectedIds.has(h.fleetId));
    const first = headsOf(corp);
    for (const h of first) seen.add(h.fleetId);
    const picks = takeFrom(tx, first, need, at, eligible, fleetRepo);
    if (corp !== null && picks.length < need) {
      picks.push(...takeFrom(tx, headsOf(null), need - picks.length, at, eligible, fleetRepo));
    }
    sh.budget.reclaim -= picks.length;
    return picks;
  }

  function reconcileInTx(tx, fleetId, opts, shared) {
    if (!isTx(tx)) return { ok: false, reason: "TX_REQUIRED" };
    if (typeof fleetId !== "string" || fleetId === "") return { ok: false, reason: "INVALID_ARGUMENT", detail: "fleetId" };
    if (!opts || !Number.isSafeInteger(opts.at) || opts.at < 0) return { ok: false, reason: "INVALID_ARGUMENT", detail: "at" };
    if (!Object.values(CAUSES).includes(opts.cause)) return { ok: false, reason: "INVALID_ARGUMENT", detail: "cause" };
    const fleetRepo = deps.getFleetRepository();
    if (!fleetRepo || typeof fleetRepo.getFleet !== "function") return { ok: false, reason: "FLEET_READ_FAILED" };
    const read = fleetRepo.getFleet(tx, fleetId);
    if (!read || read.ok !== true) return { ok: false, reason: "FLEET_READ_FAILED", detail: read && read.reason };
    const fleet = read.fleet;
    const at = opts.at;
    const sh = shared || newShared(opts.budget);
    const loss = LOSS_CAUSES.includes(opts.cause);
    const pool = deps.getPool();
    const header = repo.getHeader(tx, fleetId);
    const seats = repo.seatsOf(tx, fleetId);
    const res = { ok: true, removed: 0, lost: 0, enlisted: 0, reclaimed: 0, stale: 0, shortfall: 0, wanted: 0,
      seated: seats.length, writes: 0, truncated: 0, lostIds: [] };
    const maxRows = Number.isSafeInteger(opts.maxRows) ? opts.maxRows : Infinity;
    const fits = (cause) => res.writes + (LOSS_CAUSES.includes(cause) ? 2 : 1) + 1 <= maxRows;

    function leave(seat, cause) {
      repo.deleteSeat(tx, fleetId, seat.seat);
      res.writes += 1;
      if (sh.taken) sh.taken.delete(seat.characterId);
      if (LOSS_CAUSES.includes(cause)) {
        const until = at + S.lostCooldownMs;
        repo.recordLoss(tx, seat.characterId, until, fleetId, at);
        res.writes += 1;
        if (sh.cooling) sh.cooling.set(seat.characterId, until);
        res.lost += 1;
        res.lostIds.push(seat.characterId);
      } else if (cause === CAUSES.STALE) {
        res.stale += 1;
      } else {
        res.removed += 1;
      }
    }

    if (!fleet || fleet.state === DESTROYED_STATE) {
      const cause = loss ? opts.cause : CAUSES.GONE;
      for (const s of seats) {
        if (fits(cause)) leave(s, cause);
        else res.truncated += 1;
      }
      res.seated = res.truncated;
      if (header && res.truncated === 0) repo.deleteHeader(tx, fleetId);
      else if (header) writeHeader(tx, header, { ...header, seated: res.seated }, at);
      sh.budget.seats -= res.writes;
      return res;
    }
    if (!pool.ready && !loss) {
      res.wanted = header ? header.wanted : 0;
      return res;
    }
    let kept = seats;
    let staleLeft = 0;
    if (pool.ready) {
      kept = [];
      for (const s of seats) {
        if (pool.info.has(s.characterId)) kept.push(s);
        else if (fits(CAUSES.STALE)) leave(s, CAUSES.STALE);
        else staleLeft += 1;
      }
    }
    const targets = crewTargets(fleet.composition, S);
    const diff = diffSeats(kept, targets);
    const bySeat = new Map(kept.map((s) => [s.seat, s]));
    const released = [];
    let removed = 0;
    for (const n of diff.remove) {
      const s = bySeat.get(n);
      const cause = loss ? opts.cause : CAUSES.SHRINK;
      if (!fits(cause)) {
        res.truncated += 1;
        continue;
      }
      leave(s, cause);
      removed += 1;
      if (!loss) released.push(s.characterId);
    }
    res.truncated += staleLeft;
    const sig = res.truncated > 0 ? (header ? header.compositionSig : "") : stableJson(targets);
    let seated = kept.length - removed + staleLeft;
    res.wanted = diff.wanted;
    const enlist = opts.enlist === true && pool.ready && res.truncated === 0;
    if (enlist && diff.add.length > 0) {
      const allowed = Math.min(diff.add.length, Math.max(0, sh.budget.seats - res.writes));
      if (allowed > 0) {
        if (!sh.taken) sh.taken = repo.takenIds(tx);
        if (!sh.cooling) sh.cooling = repo.cooling(tx, at);
        const pick = pickPilots({ need: allowed, preferred: released, corporationId: fleet.corporationId,
          factionId: fleet.factionId, pool, taken: sh.taken, cooldown: sh.cooling, at });
        const chars = pick.picked.slice();
        res.enlisted = chars.length;
        if (pick.shortfall > 0 && opts.priority !== PRIORITY.BACKGROUND && sh.budget.reclaim > 0) {
          const taken = reclaimFor(tx, fleet, Math.min(pick.shortfall, sh.budget.reclaim), at, sh, pool, fleetRepo);
          res.writes += taken.length;
          res.reclaimed = taken.length;
          for (const p of taken) chars.push(p.characterId);
        }
        for (let i = 0; i < chars.length; i += 1) {
          const a = diff.add[i];
          repo.insertSeat(tx, fleetId, { seat: a.seat, characterId: chars[i], hullGroup: a.hullGroup,
            typeId: a.typeId }, at);
          sh.taken.add(chars[i]);
          res.writes += 1;
        }
        seated += chars.length;
      }
      res.shortfall = diff.add.length - (seated - (kept.length - diff.remove.length));
    }
    res.seated = seated;
    let lastSeenAt = header ? header.lastSeenAt : null;
    if (opts.touchSeen === true && (lastSeenAt === null || lastSeenAt < at - S.seenWriteMs)) lastSeenAt = at;
    const keep = seated > 0 || (diff.wanted > 0 && (header !== null
      || (enlist && opts.priority !== undefined && opts.priority !== PRIORITY.BACKGROUND)));
    if (!keep) {
      if (header) repo.deleteHeader(tx, fleetId);
    } else {
      writeHeader(tx, header, { fleetId, factionId: fleet.factionId, corporationId: fleet.corporationId,
        compositionSig: sig, wanted: diff.wanted, seated, lastSeenAt }, at);
    }
    sh.budget.seats -= res.writes;
    return res;
  }

  return Object.freeze({ reconcileInTx, newShared });
}

module.exports = { createReconciler, VERSION_CONFLICT };
