"use strict";

const { entryOf } = require("./contracts");
const { priceCourier, courierTexts } = require("./couriers");
const { CONTRACT_STATES } = require("./schema");

const CS = CONTRACT_STATES;
const COURIER = "COURIER";
const MINUTE_MS = 60000;
const CHECK = "freeCorps.contracts.check";
const FUND_PERMANENT = Object.freeze(["CHARACTER_NOT_FOUND", "BALANCE_LIMIT"]);

function createCourierSteps(sh) {
  const { S, outbox, contracts, corps, bump, safe, safeAsync, must, throwCas, write, rescheduleTx, reasonOf,
    grantKeyOf, voidKeyOf, backoffMs, CLAIM_CONFLICT, SETTLE_CONFLICT, MODE } = sh;
  const CR = () => S.courier;
  const fundKeyOf = (c) => `${c.outbox_key}:fund`;
  const defundKeyOf = (c) => `${c.outbox_key}:defund`;
  const fundText = (c) => `lne-fc courier reward ${c.contract_key}`;
  const defundText = (c) => `lne-fc courier refund ${c.contract_key}`;
  const later = (c, now) => write(CHECK, rescheduleTx(c, now + S.pollMs, undefined, now));
  const acceptedNext = (deadlineAt, now) => (deadlineAt === null ? now + S.pollMs
    : Math.max(now, Math.min(now + S.pollMs, deadlineAt + CR().failGraceMs)));

  function claimTx(tx, now, out, ob) {
    const failOb = (error) => {
      throwCas(outbox.failInTx(tx, { key: ob.key, expectedVersion: ob.version, now, error }), CLAIM_CONFLICT,
        "outbox fail");
      out.wrote = true;
    };
    const key = safe(() => JSON.parse(ob.payload).contractKey, null);
    const got = typeof key === "string" ? must(contracts.getInTx(tx, key), "contract get") : { row: null };
    let c = got.row;
    if (!c || c.kind !== COURIER || (c.state !== CS.PLANNED && c.state !== CS.ISSUING)) {
      failOb(!c ? "NO_CONTRACT" : (c.kind !== COURIER ? `KIND_${c.kind}` : `STATE_${c.state}`));
      out.failed = (out.failed || 0) + 1;
      return;
    }
    const cancelPlanned = (reason) => {
      failOb(reason);
      throwCas(contracts.cancelInTx(tx, { contractKey: c.contract_key, expectedVersion: c.version, from: CS.PLANNED,
        endReason: reason, now }), CLAIM_CONFLICT, "cancel");
      out.cancelled += 1;
    };
    const facts = sh.facts();
    if (c.state === CS.PLANNED) {
      const goodsNow = sh.goods();
      const entry = goodsNow ? entryOf(goodsNow, c.goods, c.type_id) : null;
      const f = facts ? facts.get(c.type_id) : null;
      const priced = priceCourier({ goods: c.goods, entry, lotIsk: c.lot_isk, portionSize: f ? f.portionSize : null,
        volume: f ? f.volume : null, S });
      if (!priced.ok) {
        cancelPlanned(priced.reason);
        if (priced.reason === "NO_VOLUME") out.tallies.push("ctCourierSkipNoVolume");
        return;
      }
      const d = corps.debitIskInTx(tx, { corpId: c.corp_id, isk: c.reward_isk, at: now });
      if (!d.ok) {
        if (d.reason !== "INSUFFICIENT") throw new Error(`courier debit: ${d.reason}`);
        cancelPlanned("NO_FUNDS");
        out.tallies.push("ctCourierSkipNoFunds");
        return;
      }
      throwCas(contracts.freezeCourierInTx(tx, { contractKey: c.contract_key, expectedVersion: c.version,
        quantity: priced.quantity, collateralIsk: priced.collateralIsk, now }), CLAIM_CONFLICT, "freeze courier");
      if (priced.volumeCapped) out.tallies.push("ctCourierVolumeCapped");
      c = { ...c, state: CS.ISSUING, quantity: priced.quantity, price_isk: priced.collateralIsk,
        collateral_isk: priced.collateralIsk, version: c.version + 1 };
    }
    const cl = outbox.claimInTx(tx, { key: ob.key, expectedVersion: ob.version, now });
    throwCas(cl, CLAIM_CONFLICT, "claim");
    const corp = must(corps.getInTx(tx, c.corp_id), "corp").row;
    const f = facts ? facts.get(c.type_id) : null;
    const texts = courierTexts({ typeName: f ? f.name : null, quantity: c.quantity, corpName: corp ? corp.name : null,
      ticker: corp ? corp.ticker : null, contractKey: c.contract_key, destName: c.dest_system_id });
    out.issue = { ob: { ...ob, version: cl.version, attempts: ob.attempts + 1, attempted_at: now }, c, texts };
    out.wrote = true;
  }

  async function issueCall(a, issue) {
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
    const fund = await safeAsync(() => a.tradeAdjustWallet({ ownerKind: "character", ownerId: ceo,
      deltaIsk: c.reward_isk, commandId: fundKeyOf(c), description: fundText(c) }), null);
    if (!fund || fund.ok !== true) {
      return { kind: fund && FUND_PERMANENT.includes(fund.reason) ? "fail" : "retry", error: `FUND ${reasonOf(fund)}` };
    }
    const g = safe(() => a.tradeGrantStock({ ownerKind: "character", ownerId: ceo, npcStationId: c.station_id,
      typeId: c.type_id, quantity: c.quantity, packaged: false, key: grantKeyOf(c) }), null);
    if (!g || g.ok !== true) {
      const permanent = Boolean(g && g.permanent === true && g.ambiguous !== true);
      return { kind: permanent ? "fail" : "retry", error: `GRANT ${reasonOf(g)}` };
    }
    bump("ctIssueCalls");
    const r = await safeAsync(() => a.tradeCreateCourierContract({ offerId: c.contract_key,
      corporationId: c.issuer_corporation_id, ceoId: ceo, npcStationId: c.station_id,
      destinationStationId: c.dest_station_id, typeId: c.type_id, quantity: c.quantity, rewardIsk: c.reward_isk,
      collateralIsk: c.collateral_isk, numDays: CR().days, minutesExpire: Math.ceil(sh.ttlOf() / MINUTE_MS),
      title: texts.title, description: texts.description, grantItemIds: g.itemIds }), null);
    if (r && r.ok === true && Number.isSafeInteger(r.contractId) && r.contractId > 0) {
      return { kind: "open", contractId: r.contractId };
    }
    const permanent = Boolean(r && r.permanent === true && r.ambiguous !== true);
    return { kind: permanent ? "fail" : "retry", error: `CREATE ${reasonOf(r)}` };
  }

  function returnPlanOf(a, c, stationId, onlyIds) {
    const l = safe(() => a.tradeListDeliveredStacks({ ownerKind: "character", ownerId: c.issuer_character_id,
      npcStationId: stationId, typeId: c.type_id }), null);
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

  function planReturn(a, c, reason, now, spec, onDone) {
    let plan = [];
    if (spec.empty !== true) {
      plan = returnPlanOf(a, c, spec.stationId, spec.onlyIds || null);
      if (plan === null) return later(c, now);
    }
    const ok = write(CHECK, (tx) => throwCas(contracts.planCourierReturnInTx(tx, { contractKey: c.contract_key,
      expectedVersion: c.version, from: c.state, plan, refundIsk: spec.refundIsk, reason, now, nextCheckAt: now }),
    SETTLE_CONFLICT, "plan courier return"));
    if (ok) {
      bump("ctReturned");
      if (typeof onDone === "function") onDone();
    }
    return ok;
  }

  function confirmMissing(a, c, now) {
    const f = safe(() => a.tradeFindContract({ ownerId: c.issuer_character_id, offerId: c.contract_key }), null);
    if (f && f.ok === true && f.found === null) {
      return planReturn(a, c, "CONTRACT_MISSING", now, { stationId: c.station_id, refundIsk: c.reward_isk });
    }
    if (f && f.ok === true && f.found === "record") bump("ctFound");
    return later(c, now);
  }

  async function deleteOutstanding(a, c, now, budget) {
    const cleanup = sh.courierMode() === MODE.CLEANUP;
    const expired = c.expires_at !== null && now >= c.expires_at;
    if (!expired && !cleanup) {
      const next = Math.min(c.expires_at === null ? now + S.pollMs : c.expires_at, now + S.pollMs);
      return write(CHECK, rescheduleTx(c, next, undefined, now));
    }
    if (budget.deletes <= 0) return false;
    budget.deletes -= 1;
    const d = await safeAsync(() => a.tradeDeleteContract({ contractId: c.vendor_contract_id,
      ceoId: c.issuer_character_id, corporationId: c.issuer_corporation_id }), null);
    if (d && d.ok === true) {
      return planReturn(a, c, cleanup ? "DISABLED" : "EXPIRED", now, { stationId: c.station_id,
        refundIsk: c.reward_isk });
    }
    if (d && d.pending === true) return later(c, now);
    bump("ctDeleteRetry");
    const attempts = c.close_attempts + 1;
    return write(CHECK, rescheduleTx(c, now + backoffMs(attempts, S), attempts, now));
  }

  async function failWhenLate(a, c, now, budget) {
    if (c.deadline_at === null || now < c.deadline_at + CR().failGraceMs) {
      return write(CHECK, rescheduleTx(c, acceptedNext(c.deadline_at, now), undefined, now));
    }
    if (budget.deletes <= 0) return false;
    budget.deletes -= 1;
    bump("ctCourierFailCalls");
    const r = await safeAsync(() => a.tradeFailCourierContract({ contractId: c.vendor_contract_id,
      ceoId: c.issuer_character_id, corporationId: c.issuer_corporation_id }), null);
    if (r && r.ok === true) return write(CHECK, rescheduleTx(c, now, undefined, now));
    if (r && r.reason === "COURIER_FAIL_EARLY") {
      bump("ctCourierFailEarly");
      return later(c, now);
    }
    if (r && r.pending === true) return later(c, now);
    const attempts = c.close_attempts + 1;
    return write(CHECK, rescheduleTx(c, now + backoffMs(attempts, S), attempts, now));
  }

  async function check(a, c, now, budget) {
    const r = safe(() => a.tradeReadContract(c.vendor_contract_id), null);
    bump("ctPolls");
    if (!r || r.ok !== true) return later(c, now);
    const k = r.contract;
    if (k === null || k === undefined) return confirmMissing(a, c, now);
    const cr = k.courier;
    if (!cr || typeof cr !== "object") {
      bump("ctCourierOther");
      return later(c, now);
    }
    if (cr.phase === "FINISHED") {
      return planReturn(a, c, "DELIVERED", now, { stationId: c.dest_station_id, refundIsk: 0 }, () => {
        bump("ctCourierDelivered");
        bump("ctCourierRewardIsk", c.reward_isk);
      });
    }
    if (cr.phase === "FAILED") {
      return planReturn(a, c, "COURIER_FAILED", now, { empty: true,
        refundIsk: c.reward_isk + (c.collateral_isk || 0) }, () => bump("ctCourierFailed"));
    }
    if (cr.phase === "DELETED") {
      return planReturn(a, c, "DELETED_EXTERNALLY", now, { stationId: c.station_id, refundIsk: c.reward_isk });
    }
    if (k.pendingKind) return later(c, now);
    if (cr.phase === "OUTSTANDING" && c.state === CS.OPEN) return deleteOutstanding(a, c, now, budget);
    if (cr.phase === "IN_PROGRESS" && c.state === CS.OPEN) {
      const deadlineAt = Number.isSafeInteger(cr.deadlineMs) && cr.deadlineMs >= 0 ? cr.deadlineMs : null;
      const ok = write(CHECK, (tx) => throwCas(contracts.acceptInTx(tx, { contractKey: c.contract_key,
        expectedVersion: c.version, deadlineAt, nextCheckAt: acceptedNext(deadlineAt, now), now }), SETTLE_CONFLICT,
      "accept"));
      if (ok) bump("ctCourierAccepted");
      return ok;
    }
    if (cr.phase === "IN_PROGRESS") return failWhenLate(a, c, now, budget);
    bump("ctCourierOther");
    return later(c, now);
  }

  function abort(a, c, now) {
    const f = safe(() => a.tradeFindContract({ ownerId: c.issuer_character_id, offerId: c.contract_key }), null);
    if (!f || f.ok !== true || f.found === "pending") return later(c, now);
    if (f.found === "record" && Number.isSafeInteger(f.contractId) && f.contractId > 0) {
      bump("ctFound");
      return write(CHECK, (tx) => throwCas(contracts.openInTx(tx, { contractKey: c.contract_key,
        expectedVersion: c.version, vendorContractId: f.contractId, now, expiresAt: now + sh.ttlOf(),
        nextCheckAt: now }), SETTLE_CONFLICT, "open"));
    }
    const rc = safe(() => a.tradeGrantReceipt(grantKeyOf(c)), null);
    if (rc && rc.ok === true && rc.found === false) {
      return planReturn(a, c, "ISSUE_FAILED", now, { empty: true, refundIsk: c.reward_isk });
    }
    if ((rc && rc.ok === true) || (rc && rc.reason === "GRANT_RECEIPT_AMBIGUOUS")) {
      const ids = rc.ok === true && Array.isArray(rc.itemIds) && rc.itemIds.length > 0 ? new Set(rc.itemIds) : null;
      return planReturn(a, c, "ISSUE_FAILED", now, { stationId: c.station_id, onlyIds: ids, refundIsk: c.reward_isk });
    }
    return later(c, now);
  }

  const wallet = (a, c, deltaIsk, commandId, description) => safeAsync(() => a.tradeAdjustWallet({
    ownerKind: "character", ownerId: c.issuer_character_id, deltaIsk, commandId, description }), null);

  async function ret(a, c, now) {
    const plan = safe(() => JSON.parse(c.return_plan), null);
    const stationId = c.end_reason === "DELIVERED" ? c.dest_station_id : c.station_id;
    let voided = 0;
    for (const st of Array.isArray(plan) ? plan : []) {
      const v = safe(() => a.tradeVoidStack({ ownerKind: "character", ownerId: c.issuer_character_id,
        npcStationId: stationId, itemId: st.itemId, quantity: st.quantity, key: voidKeyOf(c, st.itemId) }), null);
      if (v && v.ok === true) {
        voided += st.quantity;
        continue;
      }
      if (v && v.reason === "ITEM_MISSING" && v.permanent === true) continue;
      if (voided > 0) bump("ctVoidedUnits", voided);
      return later(c, now);
    }
    const refund = Number.isSafeInteger(c.refund_isk) && c.refund_isk > 0 ? c.refund_isk : 0;
    let credited = false;
    let short = false;
    if (refund > 0) {
      if (c.end_reason === "ISSUE_FAILED") {
        const fr = await wallet(a, c, c.reward_isk, fundKeyOf(c), fundText(c));
        if (!fr || fr.ok !== true) {
          if (!(fr && fr.permanent === true)) {
            if (voided > 0) bump("ctVoidedUnits", voided);
            return later(c, now);
          }
          short = true;
        }
      }
      if (!short) {
        const d = await wallet(a, c, -refund, defundKeyOf(c), defundText(c));
        if (d && d.ok === true) credited = true;
        else if (d && d.permanent === true) short = true;
        else {
          if (voided > 0) bump("ctVoidedUnits", voided);
          return later(c, now);
        }
      }
    }
    const collateralPart = credited && c.end_reason === "COURIER_FAILED" ? Math.min(refund, c.collateral_isk || 0) : 0;
    const rewardPart = credited ? refund - collateralPart : 0;
    const ok = write(CHECK, (tx) => {
      throwCas(contracts.closeInTx(tx, { contractKey: c.contract_key, expectedVersion: c.version,
        endReason: c.end_reason || "RETURNED", now }), SETTLE_CONFLICT, "close courier");
      if (rewardPart > 0) must(corps.refundIskInTx(tx, { corpId: c.corp_id, isk: rewardPart, at: now }), "refund");
      if (collateralPart > 0) must(corps.creditIskInTx(tx, { corpId: c.corp_id, isk: collateralPart, at: now }),
        "collateral");
    });
    if (voided > 0) bump("ctVoidedUnits", voided);
    if (ok) {
      bump("ctClosed");
      if (rewardPart > 0) bump("ctCourierRefundIsk", rewardPart);
      if (collateralPart > 0) bump("ctCourierCollateralIsk", collateralPart);
      if (short) bump("ctCourierDefundShort");
    }
    return ok;
  }

  return Object.freeze({ claimTx, issueCall, check, abort, ret });
}

module.exports = { createCourierSteps };
