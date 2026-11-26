"use strict";

const { createPoller } = require("../presence/poller");
const { createAbortSentinel } = require("../persistence/store");
const { priceLot, contractTexts, entryOf, backoffMs } = require("./contracts");
const { OUTBOX_KIND_CONTRACT_WTS, OUTBOX_KIND_CONTRACT_COURIER, CONTRACT_STATES, CONTRACT_TAG_PREFIX } = require("./schema");
const { createCourierSteps } = require("./courierSteps");

const CLAIM_CONFLICT = createAbortSentinel("freeCorps.contracts.claimConflict");
const SETTLE_CONFLICT = createAbortSentinel("freeCorps.contracts.settleConflict");
const MAX_DETAIL = 200;
const MS_DECIMALS = 10;
const MINUTE_MS = 60000;
const CHARACTER_ACCOUNT_KEY = 1000;
const MODE = Object.freeze({ RUN: "RUN", CLEANUP: "CLEANUP" });
const CS = CONTRACT_STATES;
const KIND = OUTBOX_KIND_CONTRACT_WTS;
const COURIER_KIND = OUTBOX_KIND_CONTRACT_COURIER;
const COURIER = "COURIER";

function safe(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

async function safeAsync(fn, fallback) {
  try {
    return await fn();
  } catch (_err) {
    return fallback;
  }
}

const detailOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const reasonOf = (r) => `${(r && r.reason) || "NO_RESULT"}${r && r.detail ? ` ${r.detail}` : ""}`;
const grantKeyOf = (c) => `${c.outbox_key}:grant`;
const voidKeyOf = (c, itemId) => `${c.outbox_key}:void:${itemId}`;

function createContractPump(deps) {
  const { store, outbox, contracts, corps, clock, S } = deps;
  const R = deps.retention || { ventureRetentionMs: 0, pruneBatch: 0 };
  const nowMs = deps.nowMs;
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const metric = typeof deps.metric === "function" ? deps.metric : () => {};
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const onWrite = typeof deps.onWrite === "function" ? deps.onWrite : () => {};
  const isRunning = typeof deps.isRunning === "function" ? deps.isRunning : () => true;
  const mode = deps.mode === MODE.CLEANUP ? MODE.CLEANUP : MODE.RUN;
  const courierMode = mode === MODE.RUN && deps.courierMode === MODE.RUN ? MODE.RUN : MODE.CLEANUP;
  const nudged = new Set();
  let stopped = false;
  let running = false;
  let facts = null;
  let gasKnown = null;
  let seamOk = null;
  let openCount = null;
  let lastIssueMs = null;
  let hook = null;
  let poller = null;
  let courierSeam = null;
  let courierSeamLast = null;
  let courierOpen = null;

  const ttlOf = () => S.contractTtlMs;
  const throwCas = (w, sentinel, what) => {
    if (w.ok) return;
    if (w.reason === "CAS_CONFLICT") throw sentinel;
    throw new Error(`${what}: ${w.reason}`);
  };
  const must = (r, what) => {
    if (!r || r.ok !== true) throw new Error(`${what}: ${(r && r.reason) || "NO_RESULT"}`);
    return r;
  };

  function failOutboxInTx(tx, c, now, error) {
    const ob = must(outbox.getInTx(tx, c.outbox_key), "outbox get");
    if (!ob.row || ob.row.state !== "PENDING") return;
    throwCas(outbox.failInTx(tx, { key: ob.row.key, expectedVersion: ob.row.version, now, error }), CLAIM_CONFLICT,
      "outbox fail");
  }

  function cleanupKindTx(tx, kind, now, out) {
    for (let k = 0; k < S.maxPollsPerRun; k += 1) {
      const due = must(outbox.nextDueInTx(tx, { kind, now: Number.MAX_SAFE_INTEGER }), "next due");
      if (!due.row) break;
      throwCas(outbox.failInTx(tx, { key: due.row.key, expectedVersion: due.row.version, now, error: "DISABLED" }),
        CLAIM_CONFLICT, "outbox fail");
      out.wrote = true;
      const key = safe(() => JSON.parse(due.row.payload).contractKey, null);
      const c = typeof key === "string" ? must(contracts.getInTx(tx, key), "contract get").row : null;
      if (c && c.state === CS.PLANNED) {
        throwCas(contracts.cancelInTx(tx, { contractKey: c.contract_key, expectedVersion: c.version,
          from: CS.PLANNED, endReason: "DISABLED", now }), CLAIM_CONFLICT, "cancel");
        out.cancelled += 1;
      } else if (c && c.state === CS.ISSUING) {
        throwCas(contracts.rescheduleCheckInTx(tx, { contractKey: c.contract_key, expectedVersion: c.version,
          state: CS.ISSUING, nextCheckAt: now, closeAttempts: c.close_attempts, now }), CLAIM_CONFLICT, "abort");
      }
    }
  }

  function claimTx(tx, now, nudgedIds) {
    const out = { issue: null, checks: [], open: 0, pruned: 0, expired: 0, cancelled: 0, spacing: false,
      wrote: false, tallies: [] };
    if (R.pruneBatch > 0) {
      const before = Math.max(0, now - R.ventureRetentionMs);
      const pc = must(contracts.pruneInTx(tx, { before, limit: R.pruneBatch }), "contract prune");
      const po = must(outbox.pruneInTx(tx, { before, limit: R.pruneBatch }), "outbox prune");
      out.pruned = pc.deleted;
      if (pc.deleted + po.deleted > 0) out.wrote = true;
    }
    if (courierMode === MODE.CLEANUP) cleanupKindTx(tx, COURIER_KIND, now, out);
    if (mode === MODE.CLEANUP) {
      cleanupKindTx(tx, KIND, now, out);
    } else {
      const limit = Math.max(1, R.pruneBatch);
      const stale = must(contracts.listStalePlannedInTx(tx, { before: Math.max(0, now - S.maxIssueAgeMs), limit }),
        "stale");
      for (const c of stale.rows) {
        failOutboxInTx(tx, c, now, "EXPIRED");
        throwCas(contracts.cancelInTx(tx, { contractKey: c.contract_key, expectedVersion: c.version, from: CS.PLANNED,
          endReason: "EXPIRED", now }), CLAIM_CONFLICT, "expire");
        out.expired += 1;
        out.wrote = true;
      }
      if (facts !== null) claimIssueTx(tx, now, out);
    }
    out.open = must(contracts.countOpenInTx(tx), "count").count;
    if (courierMode === MODE.RUN) out.courierOpen = must(contracts.countOpenByKindInTx(tx, COURIER), "courier count").count;
    const seen = new Set();
    for (const id of nudgedIds) {
      const g = must(contracts.getByVendorIdInTx(tx, id), "by vendor id");
      if (g.row && g.row.state === CS.OPEN && !seen.has(g.row.contract_key)) {
        seen.add(g.row.contract_key);
        out.checks.push(g.row);
      }
    }
    const dueAt = mode === MODE.CLEANUP ? Number.MAX_SAFE_INTEGER : now;
    const due = must(contracts.listDueChecksInTx(tx, { now: dueAt, limit: S.maxPollsPerRun }), "due checks");
    for (const c of due.rows) {
      if (c.close_attempts > 0 && c.next_check_at > now) continue;
      if (!seen.has(c.contract_key)) {
        seen.add(c.contract_key);
        out.checks.push(c);
      }
    }
    return out;
  }

  function claimIssueTx(tx, now, out) {
    const kinds = [KIND, ...(courierMode === MODE.RUN && courierSeam === true ? [COURIER_KIND] : [])]
      .map((kind) => ({ kind, at: must(outbox.lastAttemptAtInTx(tx, { kind }), "last attempt").at }));
    kinds.sort((x, y) => (x.at === null ? (y.at === null ? 0 : -1) : (y.at === null ? 1 : x.at - y.at)));
    for (const k of kinds) {
      if (k.at !== null && now < k.at + S.issueSpacingMs) {
        out.spacing = true;
        continue;
      }
      const due = must(outbox.nextDueInTx(tx, { kind: k.kind, now }), "next due");
      if (!due.row) continue;
      if (k.kind === COURIER_KIND) courier.claimTx(tx, now, out, due.row);
      else claimWtsTx(tx, now, out, due.row);
      return;
    }
  }

  function claimWtsTx(tx, now, out, ob) {
    const key = safe(() => JSON.parse(ob.payload).contractKey, null);
    const got = typeof key === "string" ? must(contracts.getInTx(tx, key), "contract get") : { row: null };
    let c = got.row;
    if (!c || (c.state !== CS.PLANNED && c.state !== CS.ISSUING)) {
      throwCas(outbox.failInTx(tx, { key: ob.key, expectedVersion: ob.version, now,
        error: c ? `STATE_${c.state}` : "NO_CONTRACT" }), CLAIM_CONFLICT, "outbox fail");
      out.failed = (out.failed || 0) + 1;
      out.wrote = true;
      return;
    }
    if (c.state === CS.PLANNED) {
      const goodsNow = safe(() => deps.goods(), null);
      const entry = goodsNow ? entryOf(goodsNow, c.goods, c.type_id) : null;
      const f = facts.get(c.type_id);
      const priced = priceLot({ goods: c.goods, entry, lotIsk: c.lot_isk, portionSize: f ? f.portionSize : null, S });
      if (!priced.ok) {
        throwCas(outbox.failInTx(tx, { key: ob.key, expectedVersion: ob.version, now, error: priced.reason }),
          CLAIM_CONFLICT, "outbox fail");
        throwCas(contracts.cancelInTx(tx, { contractKey: c.contract_key, expectedVersion: c.version,
          from: CS.PLANNED, endReason: priced.reason, now }), CLAIM_CONFLICT, "cancel");
        out.cancelled += 1;
        out.wrote = true;
        return;
      }
      throwCas(contracts.freezeIssueInTx(tx, { contractKey: c.contract_key, expectedVersion: c.version,
        quantity: priced.quantity, priceIsk: priced.priceIsk, now }), CLAIM_CONFLICT, "freeze");
      c = { ...c, state: CS.ISSUING, quantity: priced.quantity, price_isk: priced.priceIsk, version: c.version + 1 };
    }
    const cl = outbox.claimInTx(tx, { key: ob.key, expectedVersion: ob.version, now });
    throwCas(cl, CLAIM_CONFLICT, "claim");
    const corp = must(corps.getInTx(tx, c.corp_id), "corp").row;
    const f = facts.get(c.type_id);
    const texts = contractTexts({ typeName: f ? f.name : null, quantity: c.quantity,
      corpName: corp ? corp.name : null, ticker: corp ? corp.ticker : null, contractKey: c.contract_key });
    out.issue = { ob: { ...ob, version: cl.version, attempts: ob.attempts + 1, attempted_at: now }, c, texts };
    out.wrote = true;
  }

  async function issueCall(a, issue) {
    if (issue.c.kind === COURIER) return courier.issueCall(a, issue);
    const { ob, c, texts } = issue;
    const ceo = c.issuer_character_id;
    if (ob.attempts >= 2) {
      const f = safe(() => a.tradeFindContract({ ownerId: ceo, offerId: c.contract_key }), null);
      if (!f || f.ok !== true) return { kind: "retry", error: `FIND ${reasonOf(f)}` };
      if (f.found === "record" && Number.isSafeInteger(f.contractId) && f.contractId > 0) {
        bump("ctFound");
        return { kind: "open", contractId: f.contractId };
      }
      if (f.found === "pending") return { kind: "retry", error: "CREATE_PENDING" };
    }
    const g = safe(() => a.tradeGrantStock({ ownerKind: "character", ownerId: ceo, npcStationId: c.station_id,
      typeId: c.type_id, quantity: c.quantity, packaged: c.goods === "HULL", key: grantKeyOf(c) }), null);
    if (!g || g.ok !== true) {
      const permanent = Boolean(g && g.permanent === true && g.ambiguous !== true);
      return { kind: permanent ? "fail" : "retry", error: `GRANT ${reasonOf(g)}` };
    }
    bump("ctIssueCalls");
    const r = await safeAsync(() => a.tradeCreateSellContract({ offerId: c.contract_key, issuerKind: "character",
      corporationId: c.issuer_corporation_id, ceoId: ceo, ownerId: ceo, accountKey: CHARACTER_ACCOUNT_KEY,
      npcStationId: c.station_id, typeId: c.type_id, quantity: c.quantity, priceIsk: c.price_isk,
      minutesExpire: Math.ceil(ttlOf() / MINUTE_MS), title: texts.title, description: texts.description,
      grantItemIds: g.itemIds }), null);
    if (r && r.ok === true && Number.isSafeInteger(r.contractId) && r.contractId > 0) {
      return { kind: "open", contractId: r.contractId };
    }
    const permanent = Boolean(r && r.permanent === true && r.ambiguous !== true);
    return { kind: permanent ? "fail" : "retry", error: `CREATE ${reasonOf(r)}` };
  }

  function settleTx(tx, issue, outcome, now) {
    const { ob, c } = issue;
    if (outcome.kind === "open") {
      throwCas(outbox.completeInTx(tx, { key: ob.key, expectedVersion: ob.version, now, resultId: outcome.contractId }),
        SETTLE_CONFLICT, "complete");
      throwCas(contracts.openInTx(tx, { contractKey: c.contract_key, expectedVersion: c.version,
        vendorContractId: outcome.contractId, now, expiresAt: now + ttlOf(), nextCheckAt: now + S.pollMs }),
      SETTLE_CONFLICT, "open");
      return "issued";
    }
    if (outcome.kind === "fail" || ob.attempts >= S.maxAttempts) {
      throwCas(outbox.failInTx(tx, { key: ob.key, expectedVersion: ob.version, now, error: outcome.error }),
        SETTLE_CONFLICT, "fail");
      throwCas(contracts.rescheduleCheckInTx(tx, { contractKey: c.contract_key, expectedVersion: c.version,
        state: CS.ISSUING, nextCheckAt: now, closeAttempts: c.close_attempts, now }), SETTLE_CONFLICT, "abort");
      return "failed";
    }
    throwCas(outbox.retryInTx(tx, { key: ob.key, expectedVersion: ob.version,
      nextAt: now + backoffMs(ob.attempts, S), error: outcome.error }), SETTLE_CONFLICT, "retry");
    return "retry";
  }

  function write(name, fn) {
    const r = store.transaction(name, fn);
    if (r && r.ok === true) {
      onWrite();
      return true;
    }
    if (r && (r.error === SETTLE_CONFLICT || r.error === CLAIM_CONFLICT)) bump("ctSettleConflict");
    else log(`contract ${name} failed - ${(r && r.reason) || "TX_FAILED"}${r && r.error ? ` ${detailOf(r.error)}` : ""}`);
    return false;
  }

  const rescheduleTx = (c, nextCheckAt, closeAttempts, now) => (tx) => throwCas(contracts.rescheduleCheckInTx(tx, {
    contractKey: c.contract_key, expectedVersion: c.version, state: c.state, nextCheckAt,
    closeAttempts: closeAttempts === undefined ? c.close_attempts : closeAttempts, now }), SETTLE_CONFLICT,
  "reschedule");

  function returnPlanOf(a, c, onlyIds) {
    const l = safe(() => a.tradeListDeliveredStacks({ ownerKind: "character", ownerId: c.issuer_character_id,
      npcStationId: c.station_id, typeId: c.type_id }), null);
    if (!l || l.ok !== true || !Array.isArray(l.stacks)) return null;
    const plan = [];
    let rest = Number.isSafeInteger(c.quantity) && c.quantity > 0 ? c.quantity : Number.MAX_SAFE_INTEGER;
    for (const st of l.stacks) {
      if (rest <= 0 || plan.length >= S.maxReturnStacks) break;
      if (onlyIds && !onlyIds.has(st.itemId)) continue;
      const take = Math.min(st.quantity, rest);
      if (take > 0) {
        plan.push({ itemId: st.itemId, quantity: take });
        rest -= take;
      }
    }
    return plan;
  }

  function planReturn(a, c, reason, now, onlyIds) {
    const plan = returnPlanOf(a, c, onlyIds);
    if (plan === null) return write("freeCorps.contracts.check", rescheduleTx(c, now + S.pollMs, undefined, now));
    const ok = write("freeCorps.contracts.check", (tx) => throwCas(contracts.planReturnInTx(tx, {
      contractKey: c.contract_key, expectedVersion: c.version, from: c.state, plan, reason, now, nextCheckAt: now }),
    SETTLE_CONFLICT, "plan return"));
    if (ok) bump("ctReturned");
    return ok;
  }

  function confirmMissing(a, c, now) {
    const f = safe(() => a.tradeFindContract({ ownerId: c.issuer_character_id, offerId: c.contract_key }), null);
    if (f && f.ok === true && f.found === null) return planReturn(a, c, "CONTRACT_MISSING", now, null);
    if (f && f.ok === true && f.found === "record") bump("ctFound");
    return write("freeCorps.contracts.check", rescheduleTx(c, now + S.pollMs, undefined, now));
  }

  async function checkOpen(a, c, now, budget) {
    const r = safe(() => a.tradeReadContract(c.vendor_contract_id), null);
    bump("ctPolls");
    if (!r || r.ok !== true) return write("freeCorps.contracts.check", rescheduleTx(c, now + S.pollMs, undefined, now));
    const k = r.contract;
    if (k === null || k === undefined) return confirmMissing(a, c, now);
    if (k.status === "FINISHED") {
      let closedCorp = false;
      const ok = write("freeCorps.contracts.sold", (tx) => {
        throwCas(contracts.soldInTx(tx, { contractKey: c.contract_key, expectedVersion: c.version,
          revenueIsk: c.price_isk, now }), SETTLE_CONFLICT, "sold");
        const cr = must(corps.creditIskInTx(tx, { corpId: c.corp_id, isk: c.price_isk, at: now }), "credit");
        closedCorp = cr.open !== true;
      });
      if (ok) {
        bump("ctSold");
        bump("ctRevenueIsk", c.price_isk);
        if (closedCorp) bump("ctRevenueClosedCorp");
      }
      return ok;
    }
    if (k.status !== "OUTSTANDING") return planReturn(a, c, "DELETED_EXTERNALLY", now, null);
    if (k.pendingKind) return write("freeCorps.contracts.check", rescheduleTx(c, now + S.pollMs, undefined, now));
    const expired = c.expires_at !== null && now >= c.expires_at;
    if (!expired && mode !== MODE.CLEANUP) {
      const next = Math.min(c.expires_at === null ? now + S.pollMs : c.expires_at, now + S.pollMs);
      return write("freeCorps.contracts.check", rescheduleTx(c, next, undefined, now));
    }
    if (budget.deletes <= 0) return false;
    budget.deletes -= 1;
    const d = await safeAsync(() => a.tradeDeleteContract({ contractId: c.vendor_contract_id,
      ceoId: c.issuer_character_id, corporationId: c.issuer_corporation_id }), null);
    if (d && d.ok === true) return planReturn(a, c, mode === MODE.CLEANUP ? "DISABLED" : "EXPIRED", now, null);
    if (d && d.pending === true) return write("freeCorps.contracts.check", rescheduleTx(c, now + S.pollMs, undefined, now));
    bump("ctDeleteRetry");
    const attempts = c.close_attempts + 1;
    return write("freeCorps.contracts.check", rescheduleTx(c, now + backoffMs(attempts, S), attempts, now));
  }

  function checkAbort(a, c, now) {
    const f = safe(() => a.tradeFindContract({ ownerId: c.issuer_character_id, offerId: c.contract_key }), null);
    if (!f || f.ok !== true || f.found === "pending") {
      return write("freeCorps.contracts.check", rescheduleTx(c, now + S.pollMs, undefined, now));
    }
    if (f.found === "record" && Number.isSafeInteger(f.contractId) && f.contractId > 0) {
      bump("ctFound");
      return write("freeCorps.contracts.check", (tx) => throwCas(contracts.openInTx(tx, { contractKey: c.contract_key,
        expectedVersion: c.version, vendorContractId: f.contractId, now, expiresAt: now + ttlOf(), nextCheckAt: now }),
      SETTLE_CONFLICT, "open"));
    }
    const rc = safe(() => a.tradeGrantReceipt(grantKeyOf(c)), null);
    if (rc && rc.ok === true && rc.found === false) {
      const ok = write("freeCorps.contracts.check", (tx) => throwCas(contracts.cancelInTx(tx, {
        contractKey: c.contract_key, expectedVersion: c.version, from: CS.ISSUING, endReason: "ISSUE_FAILED", now }),
      SETTLE_CONFLICT, "cancel"));
      if (ok) bump("ctCancelled");
      return ok;
    }
    if ((rc && rc.ok === true) || (rc && rc.reason === "GRANT_RECEIPT_AMBIGUOUS")) {
      const ids = rc.ok === true && Array.isArray(rc.itemIds) && rc.itemIds.length > 0 ? new Set(rc.itemIds) : null;
      return planReturn(a, c, "ISSUE_FAILED", now, ids);
    }
    return write("freeCorps.contracts.check", rescheduleTx(c, now + S.pollMs, undefined, now));
  }

  function checkReturn(a, c, now) {
    const plan = safe(() => JSON.parse(c.return_plan), null);
    let voided = 0;
    for (const st of Array.isArray(plan) ? plan : []) {
      const v = safe(() => a.tradeVoidStack({ ownerKind: "character", ownerId: c.issuer_character_id,
        npcStationId: c.station_id, itemId: st.itemId, quantity: st.quantity, key: voidKeyOf(c, st.itemId) }), null);
      if (v && v.ok === true) {
        voided += st.quantity;
        continue;
      }
      if (v && v.reason === "ITEM_MISSING" && v.permanent === true) continue;
      if (voided > 0) bump("ctVoidedUnits", voided);
      return write("freeCorps.contracts.check", rescheduleTx(c, now + S.pollMs, undefined, now));
    }
    const ok = write("freeCorps.contracts.check", (tx) => throwCas(contracts.closeInTx(tx, {
      contractKey: c.contract_key, expectedVersion: c.version, endReason: c.end_reason || "RETURNED", now }),
    SETTLE_CONFLICT, "close"));
    if (voided > 0) bump("ctVoidedUnits", voided);
    if (ok) bump("ctClosed");
    return ok;
  }

  async function runChecks(a, checks, now) {
    const budget = { polls: S.maxPollsPerRun, deletes: 1, returns: 1 };
    for (const c of checks) {
      if (stopped) break;
      if (c.kind === COURIER) {
        if (!courierSeamOk()) {
          write("freeCorps.contracts.check", rescheduleTx(c, now + S.pollMs, undefined, now));
          continue;
        }
        if (c.state === CS.OPEN || c.state === CS.ACCEPTED) {
          if (budget.polls <= 0) continue;
          budget.polls -= 1;
          await courier.check(a, c, now, budget);
        } else if (c.state === CS.ISSUING || c.state === CS.RETURNING) {
          if (budget.returns <= 0) continue;
          budget.returns -= 1;
          if (c.state === CS.ISSUING) courier.abort(a, c, now);
          else await courier.ret(a, c, now);
        }
        continue;
      }
      if (c.state === CS.OPEN) {
        if (budget.polls <= 0) continue;
        budget.polls -= 1;
        await checkOpen(a, c, now, budget);
      } else if (c.state === CS.ISSUING || c.state === CS.RETURNING) {
        if (budget.returns <= 0) continue;
        budget.returns -= 1;
        if (c.state === CS.ISSUING) checkAbort(a, c, now);
        else checkReturn(a, c, now);
      }
    }
  }

  function courierSeamOk() {
    if (courierSeam === null) {
      const s = safe(() => deps.courierSeams(), null);
      courierSeam = Boolean(s && s.ok === true);
      courierSeamLast = courierSeam;
      if (!courierSeam) bump("ctCourierSeamUnavailable");
    }
    return courierSeam;
  }

  function adapterOf() {
    const a = safe(() => deps.adapter(), null);
    return a && typeof a === "object" ? a : null;
  }

  function ensureFacts(a) {
    if (facts !== null) {
      if (gasKnown === null) ensureGasFacts(a);
      return true;
    }
    const g = safe(() => deps.goods(), null);
    if (!g || !Array.isArray(g.typeIds)) return false;
    const r = safe(() => a.readItemTypeFacts(g.typeIds), null);
    if (!r || r.ok !== true || !(r.facts instanceof Map) || (Array.isArray(r.missing) && r.missing.length > 0)) {
      bump("ctFactsMissing");
      return false;
    }
    facts = r.facts;
    ensureGasFacts(a);
    return true;
  }

  function ensureGasFacts(a) {
    const g = safe(() => deps.goods(), null);
    if (!g || !Array.isArray(g.gasTypeIds) || g.gasTypeIds.length === 0) return;
    const r = safe(() => a.readItemTypeFacts(g.gasTypeIds), null);
    if (!r || r.ok !== true || !(r.facts instanceof Map)) return;
    facts = new Map([...facts, ...r.facts]);
    gasKnown = Object.freeze(new Set(r.facts.keys()));
    if (Array.isArray(r.missing) && r.missing.length > 0) bump("ctGasFactsMissing", r.missing.length);
  }

  async function runInner() {
    const a = adapterOf();
    const seam = a ? safe(() => deps.seams(), null) : null;
    seamOk = Boolean(seam && seam.ok === true);
    if (!seamOk) {
      bump("ctSeamUnavailable");
      return { ok: true, ran: false, reason: "SEAM_UNAVAILABLE" };
    }
    if (mode === MODE.RUN) ensureFacts(a);
    courierSeam = null;
    if (courierMode === MODE.RUN) courierSeamOk();
    const now = clock.now();
    const ids = [...nudged];
    nudged.clear();
    const c = store.transaction("freeCorps.contracts.claim", (tx) => claimTx(tx, now, ids));
    if (!c || c.ok !== true) {
      if (c && c.error === CLAIM_CONFLICT) bump("ctClaimConflict");
      else log(`contract claim failed - ${(c && c.reason) || "TX_FAILED"}${c && c.error ? ` ${detailOf(c.error)}` : ""}`);
      return { ok: false, reason: "CLAIM_FAILED" };
    }
    const v = c.value;
    if (v.wrote) onWrite();
    if (v.pruned > 0) bump("ctPruned", v.pruned);
    if (v.expired > 0) bump("ctIssueExpired", v.expired);
    if (v.cancelled > 0) bump("ctCancelled", v.cancelled);
    if (v.failed > 0) bump("ctIssueFailed", v.failed);
    if (v.spacing) bump("ctSpacing");
    for (const t of v.tallies) bump(t);
    if (v.courierOpen !== undefined) courierOpen = v.courierOpen;
    openCount = v.open;
    metric("gauge", "freeCorps.contractsOpen", v.open);
    let issued = null;
    if (v.issue) {
      const t0 = nowMs();
      const outcome = await issueCall(a, v.issue);
      lastIssueMs = Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS;
      metric("observe", "freeCorps.contractIssueMs", lastIssueMs);
      const s = store.transaction("freeCorps.contracts.settle", (tx) => settleTx(tx, v.issue, outcome, now));
      if (!s || s.ok !== true) {
        if (s && s.error === SETTLE_CONFLICT) bump("ctSettleConflict");
        else log(`contract settle failed - ${(s && s.reason) || "TX_FAILED"}${s && s.error ? ` ${detailOf(s.error)}` : ""}`);
        issued = "SETTLE_FAILED";
      } else {
        onWrite();
        issued = s.value;
        if (s.value === "issued") bump(v.issue.c.kind === COURIER ? "ctCourierIssued" : "ctIssued");
        else if (s.value === "failed") bump("ctIssueFailed");
        else bump("ctIssueRetry");
      }
    }
    await runChecks(a, v.checks, now);
    if (mode === MODE.CLEANUP && v.open === 0 && !stopped) {
      bump("ctCleanupDone");
      log("contract cleanup done - pump stopped");
      stopPump();
      return { ok: true, ran: true, issued, cleanupDone: true };
    }
    return { ok: true, ran: true, issued, checks: v.checks.length };
  }

  async function runNow() {
    if (stopped || safe(isRunning, false) !== true) return { ok: true, ran: false, reason: "NOT_RUNNING" };
    if (running) return { ok: true, ran: false, reason: "BUSY" };
    const governor = safe(() => deps.getGovernor(), null);
    if (governor && typeof governor.admits === "function"
      && safe(() => governor.admits(deps.workClass), true) === false) {
      bump("ctDeferred");
      return { ok: true, ran: false, reason: "DEFERRED" };
    }
    running = true;
    try {
      return await runInner();
    } catch (err) {
      log(`contract pump failed - ${detailOf(err)}`);
      return { ok: false, reason: "PUMP_FAILED" };
    } finally {
      running = false;
    }
  }

  function stopPump() {
    stopped = true;
    if (poller) poller.stop();
    if (hook && typeof hook.remove === "function") safe(() => hook.remove(), null);
    hook = null;
  }

  function nudge(contractId) {
    if (stopped || !Number.isSafeInteger(contractId) || contractId <= 0) return;
    bump("ctNudges");
    if (nudged.size < S.maxOpen) nudged.add(contractId);
    if (poller) poller.arm(0);
  }

  const courier = createCourierSteps({ S, outbox, contracts, corps, bump, safe, safeAsync, must, throwCas, write,
    rescheduleTx, reasonOf, grantKeyOf, voidKeyOf, backoffMs, CLAIM_CONFLICT, SETTLE_CONFLICT, MODE,
    courierMode: () => courierMode, facts: () => facts, goods: () => safe(() => deps.goods(), null), ttlOf });

  poller = createPoller({ runPass: () => { runNow(); }, intervalMs: S.pumpMs, now: () => clock.now(),
    setTimer: deps.setTimer, onError: (err) => log(`contract pump timer - ${detailOf(err)}`) });

  function start() {
    const started = poller.start();
    if (!started.ok) return started;
    if (typeof deps.addListener === "function") {
      const h = safe(() => deps.addListener({ name: "freeCorps", tagPrefix: CONTRACT_TAG_PREFIX, fn: nudge }), null);
      if (h && h.ok === true) hook = h;
      else log(`contract accept hook not installed (${(h && h.reason) || "NO_RESULT"}) - poll only`);
    }
    return { ok: true };
  }

  return Object.freeze({
    start,
    stop: stopPump,
    runNow,
    nudge,
    gasTypesKnown: () => gasKnown,
    status:() => Object.freeze({ mode, seam: seamOk === false ? "UNAVAILABLE" : "OK", open: openCount,
      hook: hook !== null, lastIssueMs,
      ...(courierMode === MODE.RUN ? { courier: Object.freeze({ mode: courierMode,
        seam: courierSeamLast === false ? "UNAVAILABLE" : "OK", open: courierOpen }) } : {}) }),
  });
}

module.exports = { createContractPump, CONTRACT_PUMP_MODE: MODE };
