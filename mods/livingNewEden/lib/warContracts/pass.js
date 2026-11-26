"use strict";

const S = require("./schema");
const { isWarOffer, isLateWarOffer, rewardOf, decideSettle, descriptionOf } = require("./rules");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const BUDGET_LIST_LIMIT = 256;
const DELIVER = "DELIVER";

function must(r, what) {
  if (!r || r.ok !== true) throw new Error(`warContracts: ${what} - ${(r && (r.detail || r.reason)) || "no result"}`);
  return r;
}

function pickFactions(ids, afterFactionId, limit) {
  const sorted = [...new Set(ids.filter(isId))].sort((a, b) => a - b);
  const cursor = Number.isSafeInteger(afterFactionId) ? afterFactionId : 0;
  return [...sorted.filter((id) => id > cursor), ...sorted.filter((id) => id <= cursor)].slice(0, limit);
}

function deliverRefsOf(tx, deps) {
  if (!deps.frontJobRepo) return { refs: new Set(), failed: 0 };
  try {
    const r = deps.frontJobRepo.listOpenOfKindInTx(tx, DELIVER, S.DELIVER_REF_LIMIT);
    if (!r || r.ok !== true) return { refs: new Set(), failed: 1 };
    return { refs: new Set(r.jobs.map((j) => j.ref).filter((v) => typeof v === "string")), failed: 0 };
  } catch (_err) {
    return { refs: new Set(), failed: 1 };
  }
}

function deliverRefAnyState(tx, deps, offerId) {
  const reader = deps.frontJobRefs;
  if (!reader || typeof reader.hasJobWithRefInTx !== "function") return null;
  try {
    const r = reader.hasJobWithRefInTx(tx, DELIVER, offerId);
    return r && r.ok === true ? r.exists === true : null;
  } catch (_err) {
    return null;
  }
}

function adoptInTx(tx, deps, now) {
  const P = deps.params;
  const listed = deps.budgets.listBudgets(tx, { limit: BUDGET_LIST_LIMIT });
  if (!listed || listed.ok !== true) {
    return { ok: false, reason: "BUDGETS_READ_FAILED", detail: String((listed && listed.reason) || "no result") };
  }
  const factions = pickFactions(listed.budgets.map((b) => b.factionId), deps.afterFactionId, P.factionsPerPass);
  const delivered = deliverRefsOf(tx, deps);
  const out = { ok: true, adopted: 0, adoptedLate: 0, skippedFrontJob: 0, scanTruncated: 0,
    readFailed: delivered.failed, nextAfterFactionId: factions.length > 0 ? factions[factions.length - 1] : 0,
    adoptedRows: [] };
  const lateOn = Number.isSafeInteger(P.adoptLateMs) && P.adoptLateMs > 0;
  const seen = new Set();
  const consider = (offer) => {
    if (out.adopted >= P.maxAdoptPerPass || !offer || seen.has(offer.offerId)) return;
    seen.add(offer.offerId);
    const fresh = isWarOffer(offer, P, now);
    const late = !fresh && lateOn && isLateWarOffer(offer, P, now);
    if (!fresh && !late) return;
    if (must(deps.repo.getInTx(tx, offer.offerId), "row read").row !== null) return;
    if (delivered.refs.has(offer.offerId)) {
      out.skippedFrontJob += 1;
      return;
    }
    const ref = deliverRefAnyState(tx, deps, offer.offerId);
    if (ref !== false) {
      if (ref === true) out.skippedFrontJob += 1;
      else out.readFailed += 1;
      return;
    }
    const reward = rewardOf(offer, P, deps.lpCorpOf);
    const row = { offerId: offer.offerId, factionId: offer.factionId, stationId: offer.stationId,
      systemId: offer.systemId, itemKind: offer.itemKind, itemKey: offer.itemKey, typeId: offer.typeId,
      quantity: offer.quantity, iskTotal: offer.iskTotal, ...reward, at: now };
    row.description = descriptionOf(row, deps.names);
    const w = deps.repo.insertOpenInTx(tx, row);
    if (w.ok) {
      out.adopted += 1;
      if (late) out.adoptedLate += 1;
      else out.adoptedRows.push(Object.freeze({ ...row, adoptedAt: now }));
    } else if (w.reason !== "EXISTS") must(w, `insert ${offer.offerId}`);
  };
  for (const factionId of factions) {
    if (out.adopted >= P.maxAdoptPerPass) break;
    const r = deps.offers.listOpenOfFaction(tx, factionId, P.offerScanLimit);
    if (!r || r.ok !== true) {
      out.readFailed += 1;
      continue;
    }
    if (r.truncated === true) out.scanTruncated += 1;
    for (const offer of r.offers) consider(offer);
    if (!lateOn || out.adopted >= P.maxAdoptPerPass || typeof deps.offers.listRecent !== "function") continue;
    const recent = deps.offers.listRecent(tx, { factionId, since: Math.max(1, now - P.adoptLateMs),
      limit: P.offerScanLimit });
    if (!recent || recent.ok !== true) {
      out.readFailed += 1;
      continue;
    }
    if (recent.truncated === true) out.scanTruncated += 1;
    for (const offer of recent.offers) consider(offer);
  }
  return out;
}

function settleInTx(tx, deps, now) {
  const P = deps.params;
  const listed = must(deps.repo.listOpenInTx(tx, { afterOfferId: deps.afterOfferId || "", limit: P.settlePerPass }),
    "open rows");
  const out = { ok: true, awarded: 0, capped: 0, lapsed: 0, waits: 0, readFailed: 0,
    nextAfterOfferId: listed.nextAfter === null ? "" : listed.nextAfter, open: 0 };
  for (const row of listed.rows) {
    const read = deps.offers.getOffer(tx, row.offerId);
    if (!read || read.ok !== true) {
      out.readFailed += 1;
      continue;
    }
    const offer = read.offer;
    const acceptor = offer && isId(offer.acceptorCharacterId) ? offer.acceptorCharacterId : null;
    const awardsInWindow = acceptor === null ? 0
      : must(deps.repo.countAwardsSinceInTx(tx, acceptor, now - P.awardWindowMs), "awards").count;
    const d = decideSettle(row, offer, { awardsInWindow, maxAwards: P.maxAwards,
      tradeStandingGrant: P.tradeStandingGrant === true });
    if (d.action === "WAIT") {
      out.waits += 1;
      continue;
    }
    const base = { offerId: row.offerId, expectedVersion: row.version, at: now };
    const spec = d.action === "AWARD" ? { ...base, to: S.STATE.AWARDED, characterId: d.characterId, legs: d.legs,
      payoutState: d.payoutState }
      : d.action === "CAP" ? { ...base, to: S.STATE.CAPPED, characterId: d.characterId }
        : { ...base, to: S.STATE.LAPSED, reason: d.reason };
    const w = must(deps.repo.settleInTx(tx, spec), `settle ${row.offerId}`);
    if (!w.changed) continue;
    if (d.action === "AWARD") out.awarded += 1;
    else if (d.action === "CAP") out.capped += 1;
    else out.lapsed += 1;
    if (deps.mail && (d.action === "AWARD" || d.action === "CAP")) {
      deps.mail.awardInTx(tx, row, { characterId: d.characterId, outcome: d.action === "AWARD" ? "AWARDED" : "CAPPED",
        at: now });
    }
  }
  out.open = must(deps.repo.countOpenInTx(tx), "open count").count;
  return out;
}

module.exports = { adoptInTx, settleInTx, pickFactions };
