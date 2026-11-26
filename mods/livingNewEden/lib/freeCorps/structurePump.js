"use strict";

const { createPoller } = require("../presence/poller");
const { createAbortSentinel } = require("../persistence/store");
const { backoffMs } = require("./killmails");
const { OUTBOX_KIND_ANCHOR, STRUCTURE_STATES: SS, STRUCTURES_MAX_TOTAL } = require("./schema");
const rules = require("./structures");

const RECORD_CONFLICT = createAbortSentinel("freeCorps.structures.recordConflict");
const CLAIM_CONFLICT = createAbortSentinel("freeCorps.structures.claimConflict");
const MODE = Object.freeze({ ON: "on", CLEANUP: "cleanup" });
const ANCHOR_MODE_NATIVE = "native";
const DOCKING = "none";
const PERMANENT = Object.freeze(["INVALID_INPUT", "TYPE_UNKNOWN", "TAG_REQUIRED", "TAG_MISMATCH"]);
const NOT_EMPTY = "NOT_EMPTY";
const ALREADY_TAGGED = "ALREADY_TAGGED";
const MAX_DETAIL = 200;
const MS_DECIMALS = 10;
const READ_FACTOR = 2;
const PLAN_COUNTERS = Object.freeze({ CAP: "stCap", ISK: "stSkipIsk", CORP_CAP: "stSkipCorpCap",
  SYSTEM_CAP: "stSkipSystemCap", COOLDOWN: "stSkipCooldown", SOV: "stBlockedSov", STATION: "stBlockedStation",
  UNKNOWN: "stBlockedUnknown" });
const FAR_FUTURE = Number.MAX_SAFE_INTEGER;

function safe(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

const detailOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const parse = (text) => safe(() => JSON.parse(text), null);
const reasonOf = (r) => String((r && r.reason) || "NO_RESULT");
const must = (r, what) => {
  if (!r || r.ok !== true) {
    if (r && r.reason === "CAS_CONFLICT") throw RECORD_CONFLICT;
    throw new Error(`${what}: ${(r && r.reason) || "no_result"}${r && r.detail ? ` ${r.detail}` : ""}`);
  }
  return r;
};

function createStructurePump(deps) {
  const { store, repo, srepo, outbox, clock, S } = deps;
  const kit = deps.structureKit;
  const R = deps.retention || { ventureRetentionMs: 0, pruneBatch: 0 };
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => 0;
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const metric = typeof deps.metric === "function" ? deps.metric : () => {};
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const onWrite = typeof deps.onWrite === "function" ? deps.onWrite : () => {};
  const isRunning = typeof deps.isRunning === "function" ? deps.isRunning : () => true;
  const systemNameOf = typeof deps.systemNameOf === "function" ? deps.systemNameOf : () => null;
  const mode = S.mode === MODE.CLEANUP ? MODE.CLEANUP : MODE.ON;
  const worldSeed = deps.worldSeed;
  const readLimit = STRUCTURES_MAX_TOTAL * READ_FACTOR;
  const minIsk = Math.max(S.minCorpIsk, S.anchorCostIsk);
  let stopped = false;
  let running = false;
  let reconciledOnce = false;
  let nextReconcileAt = 0;
  let nextPlanAt = 0;
  let seamOk = null;
  let open = null;
  let lastRefusal = null;
  let lastCallMs = null;
  let poller = null;

  const refusal = (what, r) => {
    lastRefusal = `${what} ${reasonOf(r)}${r && r.detail ? ` ${r.detail}` : ""}`.slice(0, MAX_DETAIL);
  };

  function removeVendor(seam, ctx, itemId, tag, now) {
    if (ctx.writes >= S.maxWritesPerPass) return false;
    ctx.writes += 1;
    let r = safe(() => seam.removeFcTaggedStructure(itemId, tag), { ok: false, reason: "SEAM_THROW" });
    if (r && r.ok !== true && r.reason === NOT_EMPTY) {
      r = safe(() => seam.destroyFcTaggedStructure(itemId, tag, now), { ok: false, reason: "SEAM_THROW" });
    }
    if (!r || r.ok !== true) {
      refusal("remove", r);
      return false;
    }
    ctx.vendorWrites += 1;
    return true;
  }

  function reconcile(seam, ctx, now) {
    const listed = safe(() => seam.listFcTaggedStructures(), null);
    if (!listed || listed.ok !== true) {
      refusal("list", listed);
      return false;
    }
    const live = listed.rows.filter((v) => v && v.tag && v.destroyedAt === null)
      .sort((a, b) => a.structureId - b.structureId);
    const read = store.transaction("freeCorps.structures.reconcileRead", (tx) => {
      const o = must(srepo.listOpenInTx(tx, { limit: readLimit }), "open");
      const byKey = new Map(o.rows.map((r) => [r.structure_key, r]));
      for (const v of live) {
        if (byKey.has(v.tag.fcKey)) continue;
        const g = srepo.getInTx(tx, v.tag.fcKey);
        byKey.set(v.tag.fcKey, g.ok ? g.row : null);
      }
      return byKey;
    });
    if (!read || read.ok !== true) {
      refusal("reconcileRead", read);
      return false;
    }
    const byKey = read.value;
    const seen = new Set();
    let complete = true;
    for (const v of live) {
      const row = byKey.get(v.tag.fcKey) || null;
      const ours = v.tag.world === worldSeed && row !== null && row.open === 1 && !seen.has(v.tag.fcKey);
      if (ours && row.state === SS.PLANNED && mode === MODE.ON) {
        seen.add(v.tag.fcKey);
        ctx.records.push({ type: "adopt", row, itemId: v.structureId });
        continue;
      }
      if (ours && row.evejs_item_id === v.structureId) {
        seen.add(v.tag.fcKey);
        continue;
      }
      if (removeVendor(seam, ctx, v.structureId, v.tag, now)) bump("stOrphanRemoved");
      else complete = false;
    }
    return complete;
  }

  function watch(seam, states, ctx, now) {
    const read = store.transaction("freeCorps.structures.watchRead", (tx) => ({
      rows: must(srepo.listOpenWithItemInTx(tx, { limit: readLimit }), "watch").rows,
      open: must(srepo.countOpenInTx(tx), "count").count }));
    if (!read || read.ok !== true) {
      refusal("watchRead", read);
      return;
    }
    open = read.value.open;
    for (const row of read.value.rows) {
      const g = safe(() => seam.getFcStructure(row.evejs_item_id), null);
      if (!g || g.ok !== true) {
        refusal("get", g);
        continue;
      }
      const view = g.row;
      const act = rules.watchAction({ state: row.state, corpOpen: row.corp_open === true }, view,
        { key: row.structure_key, world: worldSeed, states: states.states, upkeep: states.upkeep, mode, now,
          conditionFull: kit.CONDITION_FULL });
      if (act.op === "NONE") continue;
      if (act.op === "LOST" || act.op === "ENDED") {
        ctx.records.push({ type: act.op, reason: act.reason, row });
      } else if (act.op === "ONLINE") {
        ctx.records.push({ type: "ONLINE", row });
      } else if (act.op === "REMOVE") {
        if (removeVendor(seam, ctx, row.evejs_item_id, view.tag, now)) {
          ctx.records.push({ type: "ENDED", reason: act.reason, row });
        }
      } else if (act.op === "PATCH" && ctx.writes < S.maxWritesPerPass) {
        ctx.writes += 1;
        const r = safe(() => seam.updateFcTaggedStructure(row.evejs_item_id, view.tag, act.patch),
          { ok: false, reason: "SEAM_THROW" });
        if (r && r.ok === true) {
          ctx.vendorWrites += 1;
          bump("stPatched");
          if (act.then === null) bump("stUpkeepRestored");
        } else {
          refusal("patch", r);
        }
      }
    }
  }

  function refundInTx(tx, row, now, tally) {
    if (!(row.cost_isk > 0)) return;
    const c = must(repo.getOpenInTx(tx, row.corp_id), "refund corp");
    if (!c.row) {
      tally.push("stRefundClosed");
      return;
    }
    must(repo.advanceCorpInTx(tx, { corpId: row.corp_id, expectedVersion: c.row.version, expectedState: c.row.state,
      row: rules.refundValues(c.row, row.cost_isk), at: now }), "refund");
    tally.push("stRefund");
  }

  function failPlannedInTx(tx, ob, row, reason, now, refund, tally) {
    must(outbox.failInTx(tx, { key: ob.key, expectedVersion: ob.version, now, error: reason }), "fail outbox");
    if (!row || row.state !== SS.PLANNED) return;
    must(srepo.endInTx(tx, { key: row.structure_key, expectedVersion: row.version, expectedState: SS.PLANNED,
      state: SS.FAILED, reason, now }), "fail row");
    if (refund) refundInTx(tx, row, now, tally);
  }

  function claimTx(tx, now, adopting) {
    const out = { op: "idle", ob: null, row: null, tally: [] };
    const due = must(outbox.nextDueInTx(tx, { kind: OUTBOX_KIND_ANCHOR, now }), "next").row;
    if (!due || adopting.has(due.key)) return out;
    const payload = parse(due.payload);
    const key = payload && typeof payload.structureKey === "string" ? payload.structureKey : null;
    const g = key ? must(srepo.getInTx(tx, key), "row") : { row: null };
    const row = g.row;
    if (due.attempts === 0 && due.created_at < now - S.anchorMaxAgeMs) {
      failPlannedInTx(tx, due, row, "EXPIRED", now, true, out.tally);
      out.op = "expired";
      return out;
    }
    const last = must(outbox.lastAttemptAtInTx(tx, { kind: OUTBOX_KIND_ANCHOR }), "last").at;
    if (last !== null && now < last + S.anchorSpacingMs) {
      out.op = "spacing";
      return out;
    }
    if (!row || row.state !== SS.PLANNED) {
      must(outbox.failInTx(tx, { key: due.key, expectedVersion: due.version, now, error: "SUPERSEDED" }), "superseded");
      out.op = "superseded";
      return out;
    }
    if (!row.corp_open) {
      failPlannedInTx(tx, due, row, "CORP_CLOSED", now, false, out.tally);
      out.op = "corpClosed";
      return out;
    }
    const cl = outbox.claimInTx(tx, { key: due.key, expectedVersion: due.version, now });
    if (!cl || cl.ok !== true) throw CLAIM_CONFLICT;
    out.op = "call";
    out.ob = { ...due, version: cl.version, attempts: due.attempts + 1, attempted_at: now };
    out.row = row;
    return out;
  }

  function positionOf(seam, ctx, row, attempts) {
    const anchors = safe(() => seam.listPlacementAnchors(row.system_id), null);
    if (!anchors || anchors.ok !== true) return { ok: false, reason: reasonOf(anchors) };
    const cands = kit.placementCandidates({ seed: rules.placementSeed(worldSeed, row.corp_id, row.n, attempts),
      anchors: anchors.anchors, clearanceM: S.placementClearanceM, attempts: S.placementAttempts });
    let checks = 0;
    for (const position of cands) {
      if (checks >= S.placementChecksPerPass || ctx.writes >= S.maxWritesPerPass) break;
      checks += 1;
      ctx.writes += 1;
      const v = safe(() => seam.validatePlacement({ systemId: row.system_id, typeId: row.type_id, position }), null);
      if (!v || v.ok !== true) return { ok: false, reason: reasonOf(v) };
      if (v.valid === true) return { ok: true, position };
    }
    return { ok: false, reason: "NO_POSITION" };
  }

  function anchor(seam, states, ctx, claimed, now) {
    const { ob, row } = claimed;
    const tag = { fcKey: row.structure_key, world: worldSeed };
    const t0 = nowMs();
    const done = (a) => {
      lastCallMs = Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS;
      metric("observe", "freeCorps.structureCallMs", lastCallMs);
      return a;
    };
    if (ob.attempts > 1) {
      const listed = safe(() => seam.listFcTaggedStructures(), null);
      const hit = listed && listed.ok === true ? listed.rows.find((v) => v && v.tag && v.destroyedAt === null
        && v.tag.fcKey === tag.fcKey && v.tag.world === tag.world) : null;
      if (hit) return done({ ob, row, itemId: hit.structureId, vendor: false, adopted: true });
    }
    const known = safe(() => seam.isStructureTypeKnown(row.type_id), null);
    if (!known || known.ok !== true) return done({ ob, row, fail: reasonOf(known) });
    if (known.known !== true) return done({ ob, row, fail: "TYPE_UNKNOWN" });
    const pos = positionOf(seam, ctx, row, ob.attempts);
    if (!pos.ok) {
      if (pos.reason === "NO_POSITION") bump("stNoPosition");
      return done({ ob, row, fail: pos.reason });
    }
    const nativeAnchor = S.anchorMode === ANCHOR_MODE_NATIVE && Number.isSafeInteger(states.states.ONLINING_VULNERABLE);
    const stage = nativeAnchor
      ? { state: states.states.ANCHOR_VULNERABLE, stateEndsAt: now + S.anchorVulnerableMs,
        condition: { ...kit.CONDITION_ARMOR_STAGE } }
      : { state: states.states.SHIELD_VULNERABLE, stateEndsAt: null, condition: { ...kit.CONDITION_FULL } };
    bump("stCalls");
    ctx.writes += 1;
    const r = safe(() => seam.createFcTaggedStructure({ tag, typeId: row.type_id, systemId: row.system_id,
      ownerCorpId: row.corporation_id, name: rules.structureName(safe(() => systemNameOf(row.system_id), null),
        row.corp_name), position: pos.position, ...stage, docking: DOCKING, quantumCore: false, at: now }),
    { ok: false, reason: "SEAM_THROW" });
    if (r && r.ok === true) {
      ctx.vendorWrites += 1;
      return done({ ob, row, itemId: r.structureId, vendor: true });
    }
    if (r && r.reason === ALREADY_TAGGED && Number.isSafeInteger(r.structureId) && r.structureId > 0) {
      return done({ ob, row, itemId: r.structureId, vendor: false, adopted: true });
    }
    return done({ ob, row, fail: reasonOf(r) });
  }

  const freshInTx = (tx, key) => must(srepo.getInTx(tx, key), "fresh").row;

  function recordOneTx(tx, rec, now) {
    const tally = [];
    const row = freshInTx(tx, rec.row.structure_key);
    if (!row || row.version !== rec.row.version || row.state !== rec.row.state) throw RECORD_CONFLICT;
    if (rec.type === "adopt") {
      must(srepo.anchoredInTx(tx, { key: row.structure_key, expectedVersion: row.version, itemId: rec.itemId, now }),
        "adopt");
      const ob = must(outbox.getInTx(tx, row.structure_key), "adopt outbox").row;
      if (ob && ob.state === "PENDING") {
        must(outbox.completeInTx(tx, { key: ob.key, expectedVersion: ob.version, now, resultId: rec.itemId }),
          "adopt complete");
      }
      tally.push("stAdopted");
    } else if (rec.type === "ONLINE") {
      must(srepo.onlineInTx(tx, { key: row.structure_key, expectedVersion: row.version, now }), "online");
      tally.push("stOnline");
    } else if (rec.type === "LOST" && rec.reason === "DESTROYED") {
      let penaltyIsk = 0;
      const c = must(repo.getOpenInTx(tx, row.corp_id), "loss corp");
      if (c.row) {
        const lv = rules.lossValues(c.row, S);
        penaltyIsk = lv.penaltyIsk;
        must(repo.advanceCorpInTx(tx, { corpId: row.corp_id, expectedVersion: c.row.version,
          expectedState: c.row.state, row: lv.values, at: now }), "loss");
      }
      must(srepo.endInTx(tx, { key: row.structure_key, expectedVersion: row.version, expectedState: row.state,
        state: SS.LOST, reason: "DESTROYED", penaltyIsk, now }), "lost");
      tally.push("stLostDestroyed");
    } else if (rec.type === "LOST") {
      must(srepo.endInTx(tx, { key: row.structure_key, expectedVersion: row.version, expectedState: row.state,
        state: SS.LOST, reason: rec.reason, now }), "vanished");
      tally.push("stLostVanished");
    } else {
      must(srepo.endInTx(tx, { key: row.structure_key, expectedVersion: row.version, expectedState: row.state,
        state: SS.REMOVED, reason: rec.reason, now }), "removed");
      tally.push("stRemoved");
    }
    return tally;
  }

  function recordAnchorTx(tx, a, now) {
    const tally = [];
    const key = { key: a.ob.key, expectedVersion: a.ob.version, now };
    if (a.itemId) {
      const row = freshInTx(tx, a.row.structure_key);
      if (!row || row.version !== a.row.version || row.state !== SS.PLANNED) throw RECORD_CONFLICT;
      must(srepo.anchoredInTx(tx, { key: row.structure_key, expectedVersion: row.version, itemId: a.itemId, now }),
        "anchored");
      must(outbox.completeInTx(tx, { ...key, resultId: a.itemId }), "complete");
      tally.push(a.adopted ? "stAdopted" : "stAnchored");
    } else if (PERMANENT.includes(a.fail) || a.ob.attempts >= S.anchorMaxAttempts) {
      failPlannedInTx(tx, a.ob, freshInTx(tx, a.row.structure_key), a.fail, now, true, tally);
      tally.push("stFailed");
    } else {
      must(outbox.retryInTx(tx, { key: a.ob.key, expectedVersion: a.ob.version,
        nextAt: now + backoffMs(a.ob.attempts, S), error: a.fail }), "retry");
      tally.push("stRetry");
    }
    return tally;
  }

  function cleanupAnchorsTx(tx, now) {
    const tally = [];
    for (let i = 0; i < S.maxWritesPerPass; i += 1) {
      const due = must(outbox.nextDueInTx(tx, { kind: OUTBOX_KIND_ANCHOR, now: FAR_FUTURE }), "next").row;
      if (!due) break;
      const payload = parse(due.payload);
      const key = payload && typeof payload.structureKey === "string" ? payload.structureKey : null;
      const row = key ? must(srepo.getInTx(tx, key), "row").row : null;
      failPlannedInTx(tx, due, row, "CLEANUP", now, true, tally);
      tally.push("stFailed");
    }
    return tally;
  }

  function planTx(tx, now) {
    const tally = [];
    const openTotal = must(srepo.countOpenInTx(tx), "count").count;
    if (openTotal >= S.maxTotal) {
      tally.push("stCap");
    } else {
      const cands = must(srepo.candidatesInTx(tx, { minIsk, limit: S.candidateRows }), "candidates").rows;
      const blockedMemo = new Map();
      const blocked = (systemId) => {
        if (!blockedMemo.has(systemId)) {
          const b = safe(() => deps.systemBlockedInTx(tx, systemId), null);
          blockedMemo.set(systemId, b && b.ok === true ? b.blocked : "UNKNOWN");
        }
        return blockedMemo.get(systemId);
      };
      const inSystem = new Map();
      const openInSystem = (systemId) => {
        if (!inSystem.has(systemId)) {
          inSystem.set(systemId, must(srepo.countOpenInSystemInTx(tx, systemId), "system").count);
        }
        return inSystem.get(systemId);
      };
      const plan = rules.planAnchors({ now, openTotal, candidates: cands, openInSystem, blocked, S });
      for (const [reason, n] of Object.entries(plan.skipped)) {
        const name = PLAN_COUNTERS[reason];
        for (let i = 0; name && i < n; i += 1) tally.push(name);
      }
      const byCorp = new Map(cands.map((c) => [c.corp_id, c]));
      for (const p of plan.picks) {
        const c = must(repo.getOpenInTx(tx, p.corpId), "plan corp").row;
        const cand = byCorp.get(p.corpId);
        if (!c || !cand || c.version !== cand.version) throw new Error(`plan: corporation ${p.corpId} changed`);
        const values = rules.debitValues(c, p.costIsk, p.n);
        if (!values) throw new Error(`plan: corporation ${p.corpId} cannot pay`);
        must(repo.advanceCorpInTx(tx, { corpId: p.corpId, expectedVersion: c.version, expectedState: c.state,
          row: values, at: now }), "plan debit");
        must(srepo.insertPlannedInTx(tx, { key: p.key, corpId: p.corpId, n: p.n, systemId: p.systemId,
          typeId: S.typeId, costIsk: p.costIsk, now }), "plan insert");
        must(outbox.enqueueInTx(tx, { key: p.key, kind: OUTBOX_KIND_ANCHOR, payload: { v: 1, structureKey: p.key },
          now }), "plan enqueue");
        tally.push("stPlanned");
      }
    }
    if (R.pruneBatch > 0) {
      must(srepo.pruneInTx(tx, { before: Math.max(0, now - R.ventureRetentionMs), now,
        cooldownMs: S.rebuildCooldownMs, limit: R.pruneBatch }), "prune");
    }
    return tally;
  }

  const commit = (tally) => {
    for (const name of tally) bump(name);
  };

  function runNow() {
    if (stopped || safe(isRunning, false) !== true) return { ok: true, ran: false, reason: "NOT_RUNNING" };
    if (running) return { ok: true, ran: false, reason: "BUSY" };
    const governor = safe(() => deps.getGovernor(), null);
    if (governor && typeof governor.admits === "function"
      && safe(() => governor.admits(deps.workClass), true) === false) {
      bump("stDeferred");
      return { ok: true, ran: false, reason: "DEFERRED" };
    }
    const seams = safe(() => deps.freeCorpStructureSeams(), null);
    const seam = seams && seams.ok === true && seams.seam ? seams.seam : null;
    const states = seam ? safe(() => seam.readStructureStates(), null) : null;
    seamOk = Boolean(states && states.ok === true);
    if (!seamOk) {
      bump("stSeamUnavailable");
      refusal("seam", seam ? states : seams);
      return { ok: true, ran: false, reason: "SEAM_UNAVAILABLE" };
    }
    running = true;
    const now = clock.now();
    const ctx = { writes: 0, vendorWrites: 0, records: [], anchor: null };
    let wrote = false;
    try {
      if (now >= nextReconcileAt) {
        if (reconcile(seam, ctx, now)) {
          reconciledOnce = true;
          nextReconcileAt = now + S.reconcileMs;
        }
      }
      watch(seam, states, ctx, now);
      if (mode === MODE.CLEANUP) {
        const c = store.transaction("freeCorps.structures.cleanup", (tx) => cleanupAnchorsTx(tx, now));
        if (c && c.ok === true) {
          commit(c.value);
          if (c.value.length > 0) wrote = true;
        } else {
          refusal("cleanup", c);
        }
      } else {
        const adopting = new Set(ctx.records.filter((r) => r.type === "adopt").map((r) => r.row.structure_key));
        const c = store.transaction("freeCorps.structures.claim", (tx) => claimTx(tx, now, adopting));
        if (!c || c.ok !== true) {
          if (c && (c.error === CLAIM_CONFLICT || c.error === RECORD_CONFLICT)) bump("stRecordConflict");
          else refusal("claim", c);
        } else {
          commit(c.value.tally);
          if (c.value.op === "spacing") bump("stSpacing");
          else if (c.value.op === "expired") bump("stExpired");
          if (c.value.op !== "idle" && c.value.op !== "spacing") wrote = true;
          if (c.value.op === "call") ctx.anchor = anchor(seam, states, ctx, c.value, now);
        }
      }
      if (ctx.vendorWrites > 0) {
        const f = safe(() => seam.flushStructures(), { ok: false, reason: "FLUSH_FAILED" });
        if (!f || f.ok !== true) {
          bump("stFlushFailed");
          refusal("flush", f);
          if (ctx.anchor && ctx.anchor.vendor === true) ctx.anchor = { ob: ctx.anchor.ob, row: ctx.anchor.row,
            fail: "FLUSH_FAILED" };
        }
      }
      const settle = (fn) => {
        const r = store.transaction("freeCorps.structures.record", fn);
        if (r && r.ok === true) {
          commit(r.value);
          wrote = true;
        } else if (r && r.error === RECORD_CONFLICT) {
          bump("stRecordConflict");
        } else {
          bump("stRecordFailed");
          refusal("record", r);
          log(`structures record failed - ${reasonOf(r)}${r && r.error ? ` ${detailOf(r.error)}` : ""}`);
        }
      };
      for (const rec of ctx.records) settle((tx) => recordOneTx(tx, rec, now));
      if (ctx.anchor) settle((tx) => recordAnchorTx(tx, ctx.anchor, now));
      if (mode === MODE.ON && reconciledOnce && now >= nextPlanAt) {
        nextPlanAt = now + S.planMs;
        const p = store.transaction("freeCorps.structures.plan", (tx) => planTx(tx, now));
        if (p && p.ok === true) {
          commit(p.value);
          if (p.value.includes("stPlanned")) wrote = true;
        } else {
          refusal("plan", p);
          log(`structures plan failed - ${reasonOf(p)}${p && p.error ? ` ${detailOf(p.error)}` : ""}`);
        }
      }
      const n = store.transaction("freeCorps.structures.count", (tx) => must(srepo.countOpenInTx(tx), "count").count);
      if (n && n.ok === true) {
        open = n.value;
        metric("gauge", "freeCorps.structuresOpen", open);
      }
      if (wrote) onWrite();
      return { ok: true, ran: true };
    } catch (err) {
      log(`structure pump failed - ${detailOf(err)}`);
      return { ok: false, reason: "PUMP_FAILED" };
    } finally {
      running = false;
    }
  }

  poller = createPoller({ runPass: () => { runNow(); }, intervalMs: S.pumpMs, now: () => clock.now(),
    setTimer: deps.setTimer, onError: (err) => log(`structure pump timer - ${detailOf(err)}`) });

  return Object.freeze({
    start: () => poller.start(),
    stop: () => {
      stopped = true;
      poller.stop();
    },
    runNow,
    status: () => Object.freeze({ mode, seam: seamOk === false ? "UNAVAILABLE" : "OK", open, lastRefusal,
      lastCallMs }),
  });
}

module.exports = { createStructurePump, STRUCTURE_PUMP_MODE: MODE };
