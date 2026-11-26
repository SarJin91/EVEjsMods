"use strict";

const { unknownOverrideTypeIDs } = require("./catalog");
const { planPass } = require("./plan");
const { tagOf } = require("./vendor");

const FILETIME_UNIX_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
const FILETIME_TICKS_PER_HOUR = 3600n * 10000000n;

function fileTimeOfMs(ms) {
  return BigInt(Math.trunc(ms)) * FILETIME_TICKS_PER_MS + FILETIME_UNIX_EPOCH_OFFSET;
}

function defaultSetTimer(fn, ms) {
  const handle = setTimeout(fn, ms);
  if (handle && typeof handle.unref === "function") handle.unref();
  return handle;
}

function createShopRunner(options) {
  const { cfg, vendor, catalogOf } = options;
  const log = options.log;
  const logError = options.logError || log;
  const now = options.now || Date.now;
  const setTimer = options.setTimer || defaultSetTimer;
  const baseIntervalMs = cfg.passSeconds * 1000;
  const maxIntervalMs = cfg.backoffMaxMinutes * 60 * 1000;

  const state = {
    started: false, active: false, running: false, passes: 0, intervalMs: baseIntervalMs,
    issuerName: null, ceoID: 0, stations: [],
  };
  const stats = { passes: 0, created: 0, deleted: 0, granted: 0, failed: 0 };

  function arm(ms) {
    try {
      setTimer(() => {
        runPass().catch(() => {}).then(() => arm(state.intervalMs));
      }, ms);
    } catch (error) {
      logError("shop: timer failed - shop stopped", error);
    }
  }

  function prepare() {
    const issuer = vendor.validateIssuer(cfg.issuerCorporationID);
    if (!issuer.ok) return { ok: false, reason: `issuer ${cfg.issuerCorporationID}: ${issuer.reason}` };
    const stations = [];
    for (const stationID of cfg.stations) {
      const station = vendor.validateStation(stationID);
      if (station.ok) stations.push(stationID);
      else logError(`shop: hub ${stationID} skipped - ${station.reason}`);
    }
    if (stations.length === 0) return { ok: false, reason: "no valid hub" };
    const catalog = catalogOf();
    if (!Array.isArray(catalog) || catalog.length === 0) return { ok: false, reason: "no blueprints in accepted packs" };
    for (const typeID of unknownOverrideTypeIDs(catalog, cfg)) {
      logError(`shop: price override for ${typeID} ignored - not a blueprint of an accepted pack`);
    }
    const officerCount = catalog.filter((entry) => entry.priceClass === "officer").length;
    const officerHubs = officerCount > 0 && Array.isArray(cfg.officerStations) ? cfg.officerStations : [];
    for (const stationID of officerHubs) {
      if (!stations.includes(stationID)) logError(`shop: officer hub ${stationID} skipped - not a shop hub`);
    }
    const validOfficerHubs = officerHubs.filter((stationID) => stations.includes(stationID)).length;
    const authority = vendor.ensureAuthority();
    if (!authority.ok) return { ok: false, reason: `authority wrap - ${authority.reason}` };
    state.issuerName = issuer.name;
    state.ceoID = issuer.ceoID;
    state.stations = stations;
    log(`shop ${cfg.delist ? "DELIST" : "active"} - issuer ${issuer.name} (${cfg.issuerCorporationID}), `
      + `${stations.length} hubs, ${catalog.length} blueprints, ${cfg.contractsPerType} per type`
      + (officerCount > 0 ? `, officer ${officerCount} blueprints at ${validOfficerHubs} hub(s), `
        + `${cfg.officerContractsPerType} per type` : ""));
    return { ok: true };
  }

  function start() {
    if (state.started) return { ok: false, reason: "already-started" };
    state.started = true;
    let prepared;
    try {
      prepared = prepare();
    } catch (error) {
      prepared = { ok: false, reason: `exception ${error && error.message}` };
    }
    if (!prepared.ok) {
      log(`shop off - ${prepared.reason}`);
      return prepared;
    }
    state.active = true;
    arm(cfg.firstPassSeconds * 1000);
    return { ok: true };
  }

  async function execute(plan, catalogByType, report, firstErrors, typeByContract) {
    const noteError = (key, line) => {
      if (firstErrors.has(key)) return;
      firstErrors.add(key);
      logError(line);
    };
    const causes = { EXPIRING: 0, STALE: 0, EXCESS: 0, DELIST: 0, delistUnknown: 0 };
    for (const action of plan.deletes) {
      const result = await vendor.deleteListing({ issuer: cfg.issuerCorporationID, ceoID: state.ceoID,
        contractID: action.contractID });
      if (result.ok) {
        report.deleted += 1;
        const bucket = action.cause.startsWith("STALE_") ? "STALE" : action.cause;
        causes[bucket] += 1;
        if (bucket === "DELIST" && !catalogByType.has(typeByContract.get(action.contractID))) causes.delistUnknown += 1;
      } else {
        report.failed += 1;
        noteError(`delete:${result.detail}`, `shop: delete failed for contract ${action.contractID}: ${result.detail}`);
      }
    }
    for (const action of plan.creates) {
      const entry = catalogByType.get(action.typeID);
      const runs = entry ? entry.runs : null;
      const where = `${action.stationID}/${action.typeID}`;
      const common = { issuer: cfg.issuerCorporationID, stationID: action.stationID, typeID: action.typeID, runs };
      const stock = vendor.takeStock(common);
      if (!stock.ok) {
        report.failed += 1;
        noteError(`stock:${stock.detail}`, `shop: create failed at ${where}: ${stock.detail}`);
        continue;
      }
      report.stockStale += stock.stale;
      let itemID = stock.itemID;
      if (itemID === null) {
        const granted = vendor.grantBlueprint(common);
        if (!granted.ok) {
          report.failed += 1;
          noteError(`grant:${granted.detail}`, `shop: create failed at ${where}: ${granted.detail}`);
          continue;
        }
        report.granted += 1;
        itemID = granted.itemID;
      }
      const created = await vendor.createListing({
        issuer: cfg.issuerCorporationID,
        ceoID: state.ceoID,
        accountKey: cfg.issuerAccountKey,
        stationID: action.stationID,
        itemID,
        price: action.price,
        minutesExpire: cfg.contractDays * 1440,
        title: action.title,
        description: `Blueprint sold by ${state.issuerName}. ${tagOf(entry ? entry.kindTag : "o")}`,
      });
      if (created.ok) {
        report.created += 1;
      } else {
        report.failed += 1;
        noteError(`create:${created.detail}`, `shop: create failed at ${where}: ${created.detail}`);
      }
    }
    return causes;
  }

  async function runPass() {
    const report = { ok: false, created: 0, deleted: 0, granted: 0, failed: 0, live: 0, target: 0, ms: 0, stockStale: 0 };
    if (!state.active || state.running) return { ...report, reason: state.running ? "RUNNING" : "INACTIVE" };
    state.running = true;
    const startedAt = now();
    let causes = { EXPIRING: 0, STALE: 0, EXCESS: 0, DELIST: 0 };
    let busy = 0;
    try {
      const authority = vendor.ensureAuthority();
      const ours = authority.ok ? vendor.readOurs(cfg.issuerCorporationID) : authority;
      if (!ours.ok) {
        report.failed += 1;
        logError(`shop: pass failed - ${ours.reason}${ours.detail ? ` (${ours.detail})` : ""}`);
      } else {
        const catalog = catalogOf();
        const plan = planPass({
          nowFt: fileTimeOfMs(now()),
          renewLeadFt: BigInt(cfg.renewHours) * FILETIME_TICKS_PER_HOUR,
          stations: state.stations,
          catalog,
          perType: cfg.contractsPerType,
          kindTag: catalog.length > 0 ? catalog[0].kindTag : "o",
          ours: ours.ours,
          busyStations: ours.busyStations,
          delist: cfg.delist,
          maxActions: cfg.maxActionsPerPass,
          outstandingStatus: ours.outstandingStatus,
        });
        report.target = cfg.delist ? 0 : plan.stats.target;
        busy = plan.stats.skippedBusy;
        const typeByContract = new Map((ours.ours || []).map((contract) => [contract.contractID, contract.typeID]));
        causes = await execute(plan, new Map(catalog.map((entry) => [entry.typeID, entry])), report, new Set(), typeByContract);
        report.live = Math.max(0, plan.stats.live + report.created - causes.EXCESS - (causes.DELIST - causes.delistUnknown));
        report.ok = report.failed === 0;
      }
    } catch (error) {
      report.failed += 1;
      logError("shop: pass failed - ignored", error);
    } finally {
      state.running = false;
    }
    report.ms = Math.max(0, now() - startedAt);
    const successes = report.created + report.deleted;
    state.intervalMs = report.failed > 0 && successes === 0
      ? Math.min(maxIntervalMs, Math.max(baseIntervalMs, state.intervalMs * 2))
      : baseIntervalMs;
    state.passes += 1;
    stats.passes += 1;
    stats.created += report.created;
    stats.deleted += report.deleted;
    stats.granted += report.granted;
    stats.failed += report.failed;
    if (state.passes === 1 || successes > 0 || report.failed > 0) {
      log(`shop pass: created ${report.created}, deleted ${report.deleted} (expiring ${causes.EXPIRING}, `
        + `stale ${causes.STALE}, excess ${causes.EXCESS}${cfg.delist ? `, delist ${causes.DELIST}` : ""}), `
        + `granted ${report.granted}, failed ${report.failed}, live ${report.live}/${report.target}, `
        + `stock-stale ${report.stockStale}, busy ${busy}, ${report.ms} ms`);
    }
    return report;
  }

  return { start, runPass, state, stats };
}

module.exports = {
  createShopRunner,
  fileTimeOfMs,
};
