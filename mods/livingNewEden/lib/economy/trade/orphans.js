"use strict";

const S = require("./schema");
const { issuerOf } = require("./executorRules");
const { SCHEMA } = require("../../../config");

const MAX_ORPHAN_SCAN_CORPORATIONS_DEFAULT = (SCHEMA.find((r) => r.key === "trade.maxOrphanScanCorporations")
  || { default: 1 }).default;

function characterSeamsOk(adapter) {
  if (!adapter || typeof adapter.tradeVirtualIssuerSeams !== "function") return false;
  try {
    const r = adapter.tradeVirtualIssuerSeams();
    return Boolean(r && r.ok === true);
  } catch (_err) {
    return false;
  }
}

const ORPHAN_SEAM_UNAVAILABLE = Object.freeze({ ok: false, reason: "ORPHAN_SEAM_UNAVAILABLE" });
const METRIC_WTS_ORPHANS = "trade.wtsOrphans";
const FULL_SCAN_LIMIT = 1000;

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function registryCorporationIds(getRegistry, logger, telemetry) {
  const out = [];
  const add = (v) => { if (isId(v) && !out.includes(v)) out.push(v); };
  try {
    const registry = getRegistry ? getRegistry() : null;
    if (!registry || typeof registry.listFactions !== "function") return out;
    for (const f of registry.listFactions() || []) {
      if (!f) continue;
      add(f.ownerCorporationId);
      for (const id of Object.values(f.corporationRoles || {})) add(id);
      for (const s of f.startStations || []) if (s && s.kind === "npc") add(s.corporationId);
    }
  } catch (err) {
    if (!registryErrorLogged) {
      registryErrorLogged = true;
      log(logger, `[tradeOrphans] faction registry unreadable, corporate orphans of the registry skipped: ${
        String((err && err.message) || err).slice(0, 200)}`);
    }
    metric(telemetry, "trade.seamError", 1);
  }
  return out;
}

let registryErrorLogged = false;

function canAct(deps) {
  try {
    if (typeof deps.isStopped === "function" && deps.isStopped() === true) return false;
    const st = deps.store;
    if (st && typeof st.getState === "function" && st.getState() !== "open") return false;
    return true;
  } catch (_err) {
    return false;
  }
}

async function runOrphanScan(deps, fullScan = false, afterContractId = 0) {
  const { store, journal, offers, adapter, config, clock, telemetry, logger, getStations, getGovernor, getRegistry } = deps;
  const tradeCfg = config.trade || {};
  const maxOrphansPerPass = Math.max(1, Math.trunc(tradeCfg.maxOrphansPerPass || 2));
  const after = Math.max(0, Math.trunc(Number(afterContractId) || 0));
  const deferred = Object.freeze({ processed: 0, deleted: 0, errors: 0, deferred: true, nextCursor: after });

  const governor = typeof getGovernor === "function" ? getGovernor() : null;
  if (governor && typeof governor.admits === "function" && governor.admits("OPERATIONAL") === false) {
    return deferred;
  }

  const stationsModule = getStations ? getStations() : null;
  if (!stationsModule) return deferred;

  const corporationIds = registryCorporationIds(typeof getRegistry === "function" ? getRegistry : null, logger, telemetry);
  const maxCorps = Math.max(1, Math.trunc(tradeCfg.maxOrphanScanCorporations || MAX_ORPHAN_SCAN_CORPORATIONS_DEFAULT));
  const corpRes = typeof offers.listIssuerCorporationIds === "function"
    ? store.transaction("trade.orphan.issuer_corporations", (db) => offers.listIssuerCorporationIds(db, maxCorps))
    : null;
  if (corpRes && corpRes.ok && corpRes.value && corpRes.value.ok) {
    for (const id of corpRes.value.corporationIds) if (!corporationIds.includes(id)) corporationIds.push(id);
  }
  if (typeof stationsModule.getAll === "function") {
    for (const s of stationsModule.getAll()) {
      if (s.kind === "npc" && s.online === true && s.npcStationId && s.ownerCorporationId) {
        corporationIds.push(s.ownerCorporationId);
      }
    }
  } else if (stationsModule instanceof Map) {
    for (const s of stationsModule.values()) {
      if (s.kind === "npc" && s.online === true && s.stationId && s.ownerCorporationId) {
        corporationIds.push(s.ownerCorporationId);
      }
    }
  }

  let ownerIds = [];
  const idsRes = typeof offers.listIssuerCharacterIds === "function"
    ? store.transaction("trade.orphan.issuer_characters", (db) => offers.listIssuerCharacterIds(db))
    : null;
  if (idsRes && idsRes.ok && idsRes.value && idsRes.value.ok) ownerIds = idsRes.value.characterIds;

  if (typeof adapter.tradeVirtualIssuerSeams === "function") {
    const vcSeams = adapter.tradeVirtualIssuerSeams();
    if (vcSeams && vcSeams.ok && typeof adapter.getVirtualCorps === "function") {
      const vc = adapter.getVirtualCorps();
      if (vc && typeof vc.listTradeIssuers === "function") {
        const issuersRes = vc.listTradeIssuers();
        if (issuersRes && issuersRes.ok && issuersRes.issuers) {
          for (const iss of issuersRes.issuers) {
            if (isId(iss.characterId) && !ownerIds.includes(iss.characterId)) ownerIds.push(iss.characterId);
          }
        }
      }
    }
  }

  if (corporationIds.length === 0 && ownerIds.length === 0) return deferred;

  const limit = fullScan ? FULL_SCAN_LIMIT : maxOrphansPerPass;
  const live = tradeCfg.contractListLiveRead === true ? { liveRead: true } : {};
  const listRes = await adapter.tradeListTaggedContracts({ ownerIds, corporationIds, limit, afterContractId: after,
    ...live });
  if (!listRes.ok) {
    log(logger, `[tradeOrphans] tradeListTaggedContracts failed: ${listRes.reason}`);
    metric(telemetry, "trade.seamError", 1);
    return { ...deferred, errors: 1 };
  }

  let processed = 0;
  let deleted = 0;
  let errors = 0;
  let lastExamined = 0;
  let stoppedEarly = false;
  let halted = false;

  for (const contract of listRes.contracts) {
    if (processed >= maxOrphansPerPass && !fullScan) { stoppedEarly = true; break; }
    if (!canAct(deps)) { halted = true; break; }

    const offerRes = store.transaction("trade.orphan.find_by_offer", (db) => offers.getOffer(db, contract.offerId));
    if (!offerRes || offerRes.ok !== true || !offerRes.value || offerRes.value.ok !== true) {
      const reason = (offerRes && (offerRes.reason || (offerRes.value && offerRes.value.reason))) || "OFFER_READ_FAILED";
      log(logger, `[tradeOrphans] offer read failed for contract ${contract.contractId}: ${reason}, scan deferred`);
      metric(telemetry, "trade.seamError", 1);
      errors += 1;
      halted = true;
      break;
    }
    const offer = offerRes.value.offer || null;

    let isOrphan = !offer || S.TERMINAL_OFFER_STATES.includes(offer.state);
    if (offer && offer.state === S.ISSUING) {
      isOrphan = false;
    }

    const w = contract.issuerWallet;
    const characterWallet = Boolean(w && w.kind === S.ISSUER_KIND_CHARACTER);
    if (isOrphan && characterWallet && !characterSeamsOk(adapter)) {
      log(logger, `[tradeOrphans] orphan ${contract.contractId}: character issuer seams unavailable, waits`);
      isOrphan = false;
    }

    if (isOrphan && fullScan && deleted >= maxOrphansPerPass) { stoppedEarly = true; break; }
    lastExamined = contract.contractId;

    if (isOrphan) {
      const delRes = await adapter.tradeDeleteContract({
        contractId: contract.contractId,
        ceoId: contract.issuerId || 0,
        corporationId: offer ? issuerOf(offer, tradeCfg.walletAccountKey).corporationId : contract.issuerOwnerId,
      });
      if (!delRes.ok) {
        if (delRes.pending) {
          continue;
        }
        log(logger, `[tradeOrphans] deleteContract failed for ${contract.contractId}: ${delRes.reason}`);
        metric(telemetry, "trade.seamError", 1);
        errors += 1;
        continue;
      }

      const settled = offer !== null && (offer.state === S.DELIVERED || offer.state === S.LOST);
      const wts = offer !== null
        ? offer.side === S.SIDE_SELL
        : (String(contract.offerId || "").startsWith(S.WTS_ORPHAN_ID_PREFIX) || !(Number(contract.reward) > 0));
      if (wts) {
        metric(telemetry, METRIC_WTS_ORPHANS, 1);
        log(logger, `[tradeOrphans] WTS orphan ${contract.contractId} (offer ${contract.offerId}): deleted, no defund`);
      } else if (settled) {
        metric(telemetry, "trade.orphanDefundSkipped", 1);
        log(logger, `[tradeOrphans] orphan ${contract.contractId} of settled offer ${contract.offerId} (${offer.state}): deleted, no defund`);
      } else {
        const accountKey = characterWallet
          ? S.CHARACTER_ACCOUNT_KEY
          : (w && w.kind === "corporation" && Number.isInteger(w.accountKey))
            ? w.accountKey
            : (tradeCfg.walletAccountKey || 1006);
        const amount = offer ? offer.iskTotal : (characterWallet ? Math.floor(Number(contract.reward) || 0) : contract.reward);
        const defundRes = characterWallet && !(amount > 0)
          ? { ok: false, reason: "WALLET_FAILED", permanent: true, detail: "invalid_delta" }
          : await adapter.tradeAdjustWallet({
            ownerKind: characterWallet ? S.ISSUER_KIND_CHARACTER : S.ISSUER_KIND_CORPORATION,
            ownerId: characterWallet ? w.ownerId : contract.issuerOwnerId,
            corporationId: contract.issuerOwnerId,
            accountKey,
            deltaIsk: -amount,
            commandId: S.walletCommandId(contract.offerId, "defund"),
            description: `lne-trade defund ${contract.offerId}`,
          });
        if (defundRes && defundRes.ok === true && defundRes.fingerprintMismatch === true) {
          metric(telemetry, "trade.walletKeyCollision", 1);
          log(logger, `[tradeOrphans] wallet key collision (fingerprintMismatch) orphan ${contract.contractId}`);
        }
        if (!defundRes.ok) {
          log(logger, `[tradeOrphans] defund failed for orphan ${contract.contractId}: ${defundRes.reason}`);
          if (defundRes.reason === "INSUFFICIENT_FUNDS") metric(telemetry, "trade.defundShort", 1);
        }
      }

      deleted += 1;
      metric(telemetry, "trade.orphans", 1);
    }

    processed += 1;
  }

  if (halted) {
    return { processed, deleted, errors, deferred: true, nextCursor: lastExamined > 0 ? lastExamined : after };
  }
  const more = stoppedEarly || listRes.truncated === true;
  const nextCursor = more ? (lastExamined > 0 ? lastExamined : after) : 0;
  if (fullScan && more) {
    return { processed, deleted, errors, deferred: true, nextCursor };
  }
  return { processed, deleted, errors, nextCursor };
}

async function findOfferByContractId(offers, store, contractId) {
  return store.transaction("trade.orphan.find_by_contract", (db) => {
    return offers.findByContractId(db, contractId);
  });
}

function metric(telemetry, name, value) {
  if (!telemetry || typeof telemetry.count !== "function") return;
  try { telemetry.count(name, value); } catch (_err) {}
}

function log(logger, ...args) {
  if (logger && typeof logger.log === "function") logger.log(...args);
}

module.exports = { runOrphanScan, ORPHAN_SEAM_UNAVAILABLE, characterSeamsOk, METRIC_WTS_ORPHANS };