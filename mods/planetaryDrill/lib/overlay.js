"use strict";

const crypto = require("node:crypto");

const SKYHOOK_TYPE_ID = 81080;
const VERSION_TAG = "pdrill";
const TAG_PATTERN = /\[PI:(\d+)\]/iu;

function toPositiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function isDeploymentPending(orbital, pendingByPlanet) {
  const intent = pendingByPlanet && pendingByPlanet[String(orbital.planetID)];
  return Boolean(intent && !intent.completed && Number(intent.launchedItemID) === Number(orbital.itemID));
}

function planDrills(orbitals, { vendorPlanetIDs, pendingByPlanet = {}, itemOf, planetOf, cfg, pick = null, isDrill = null }) {
  const candidates = [];
  for (const orbital of Array.isArray(orbitals) ? orbitals : []) {
    if (!orbital || Number(orbital.typeID) !== SKYHOOK_TYPE_ID) continue;
    const skyhookID = toPositiveInteger(orbital.itemID);
    const planetID = toPositiveInteger(orbital.planetID);
    const solarSystemID = toPositiveInteger(orbital.solarSystemID);
    if (!skyhookID || !planetID || !solarSystemID) continue;
    if (orbital.destroyedAtMs) continue;
    if (isDeploymentPending(orbital, pendingByPlanet)) continue;
    if (vendorPlanetIDs && vendorPlanetIDs.has(planetID)) continue;
    const planet = planetOf(planetID);
    if (!planet || Number(planet.solarSystemID) !== solarSystemID) continue;
    const item = itemOf(skyhookID);
    if (!item) continue;
    candidates.push({
      skyhookID,
      planetID,
      solarSystemID,
      corporationID: toPositiveInteger(orbital.corporationID || orbital.ownerID),
      name: String(item.itemName || ""),
      planet,
    });
  }
  candidates.sort((left, right) => left.skyhookID - right.skyhookID);

  const perSystem = new Map();
  const perCorporation = new Map();
  const planets = new Set();
  const drills = [];
  const limited = [];
  const skipped = [];
  for (const drill of candidates) {
    if (planets.has(drill.planetID)) continue;
    if (pick) {
      const reagent = pick(drill);
      if (!reagent || !reagent.ok) {
        skipped.push({ drill, reason: reagent ? reagent.reason : "NO_RESULT" });
        continue;
      }
    }
    planets.add(drill.planetID);
    if (cfg.drillItemsOnly && isDrill && !isDrill(drill)) {
      limited.push({ ...drill, reason: "NOT_DRILL_ITEM" });
      continue;
    }
    const systemCount = perSystem.get(drill.solarSystemID) || 0;
    const corporationCount = perCorporation.get(drill.corporationID) || 0;
    if ((cfg.maxPerSystem > 0 && systemCount >= cfg.maxPerSystem) ||
        (cfg.maxPerCorporation > 0 && corporationCount >= cfg.maxPerCorporation)) {
      limited.push(drill);
      continue;
    }
    perSystem.set(drill.solarSystemID, systemCount + 1);
    perCorporation.set(drill.corporationID, corporationCount + 1);
    drills.push(drill);
  }
  return { drills, limited, skipped };
}

function selectDrills(orbitals, options) {
  return planDrills(orbitals, options).drills;
}

function pickReagent({ resourceTypeIDs, qualities, name, cfg, preferredTypeID = 0 }) {
  const typeIDs = [...new Set((Array.isArray(resourceTypeIDs) ? resourceTypeIDs : [])
    .map(toPositiveInteger).filter(Boolean))].sort((left, right) => left - right);
  const qualityOf = (typeID) => {
    const value = Number(qualities && qualities[String(typeID)]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const total = typeIDs.reduce((sum, typeID) => sum + qualityOf(typeID), 0);
  if (!(total > 0)) return { ok: false, reason: "NO_RESOURCES" };
  const amountOf = (typeID) => Math.floor(
    cfg.baseUnitsPerHour * (cfg.cycleSeconds / 3600) * qualityOf(typeID) / total,
  );

  const preferred = toPositiveInteger(preferredTypeID);
  if (preferred && typeIDs.includes(preferred) && qualityOf(preferred) > 0 && amountOf(preferred) > 0) {
    return { ok: true, reagentTypeID: preferred, amountPerCycle: amountOf(preferred), tag: "none", pick: "variant" };
  }

  let selected = 0;
  let tag = "none";
  const match = TAG_PATTERN.exec(String(name || ""));
  if (match) {
    const tagged = toPositiveInteger(match[1]);
    if (typeIDs.includes(tagged) && qualityOf(tagged) > 0) {
      selected = tagged;
      tag = "used";
    } else {
      tag = "ignored";
    }
  }
  if (!selected) {
    for (const typeID of typeIDs) {
      if (!selected || qualityOf(typeID) > qualityOf(selected)) selected = typeID;
    }
  }
  const amountPerCycle = amountOf(selected);
  if (!(amountPerCycle > 0)) return { ok: false, reason: "NO_RESOURCES" };
  const pick = preferred ? "variant-ignored" : tag === "used" ? "tag" : "auto";
  return { ok: true, reagentTypeID: selected, amountPerCycle, tag, pick };
}

function buildOverlay(drills, pick, cfg, extra = {}) {
  const entries = [];
  const skipped = [...(Array.isArray(extra.skipped) ? extra.skipped : [])];
  const add = (drill, limited) => {
    const reagent = pick(drill);
    if (!reagent || !reagent.ok) {
      skipped.push({ drill, reason: reagent ? reagent.reason : "NO_RESULT" });
      return;
    }
    entries.push({
      drill,
      reagent,
      limited,
      row: {
        planetID: drill.planetID,
        solarSystemID: drill.solarSystemID,
        power: 0,
        workforce: 0,
        reagentDefinitions: [{
          reagentTypeID: reagent.reagentTypeID,
          amountPerCycle: limited ? 0 : reagent.amountPerCycle,
          cyclePeriodSeconds: cfg.cycleSeconds,
          securedPercentage: 100,
          securedCapacity: reagent.amountPerCycle * cfg.storageCycles,
          unsecuredCapacity: 0,
          securedStock: 0,
          unsecuredStock: 0,
        }],
      },
    });
  };
  for (const drill of drills) add(drill, false);
  for (const drill of Array.isArray(extra.limited) ? extra.limited : []) add(drill, true);
  entries.sort((left, right) => left.row.planetID - right.row.planetID);
  const rows = entries.map((entry) => entry.row);
  const hash = crypto.createHash("sha1").update(JSON.stringify(rows)).digest("hex").slice(0, 8);
  return { rows, hash, entries, skipped };
}

const EMPTY_OVERLAY = Object.freeze({ rows: Object.freeze([]), hash: "", entries: Object.freeze([]), skipped: Object.freeze([]) });

function createBase(snapshot) {
  return {
    vendorPlanetIDs: new Set(snapshot.planetDefinitionsByPlanetID.keys()),
    originalVersion: snapshot.planetDefinitionsVersion,
    rows: [],
    key: null,
    lastRevision: undefined,
    reagentsBySkyhook: new Map(),
  };
}

function taggedVersion(original, hash) {
  const source = original && typeof original === "object" ? original : {};
  return {
    ...source,
    prerelease_tags: [...(Array.isArray(source.prerelease_tags) ? source.prerelease_tags : []), VERSION_TAG, hash],
    build_tags: [...(Array.isArray(source.build_tags) ? source.build_tags : [])],
  };
}

function applyOverlay(snapshot, overlay, state) {
  const rows = overlay.rows.filter((row) => !state.vendorPlanetIDs.has(row.planetID));
  const key = rows.length > 0 ? overlay.hash : null;
  if (key === state.key) return { changed: false };

  const map = snapshot.planetDefinitionsByPlanetID;
  const list = snapshot.planetDefinitions;
  const previous = new Set(state.rows);
  for (const row of state.rows) {
    if (Map.prototype.get.call(map, row.planetID) === row) Map.prototype.delete.call(map, row.planetID);
  }
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (previous.has(list[index])) list.splice(index, 1);
  }
  for (const row of rows) {
    list.push(row);
    Map.prototype.set.call(map, row.planetID, row);
  }
  snapshot.planetDefinitionsVersion = key ? taggedVersion(state.originalVersion, key) : state.originalVersion;
  state.rows = rows;
  state.key = key;
  return { changed: true };
}

function createSync({ vendor, cfg, logFn, logErrorFn, defer = queueMicrotask, readLaunchLedger = null }) {
  const bases = new WeakMap();
  const stats = { syncFastPath: 0, syncRebuild: 0, syncFailures: 0, invalidations: 0, notReady: 0 };
  let busy = false;
  let firstGood = false;
  let warnedEarly = false;
  function warnEarly(reason) {
    if (firstGood || warnedEarly) return;
    warnedEarly = true;
    try {
      logFn(`WARN overlay ${reason} before the first rebuild - the snapshot is served without drill rows (logged once)`);
    } catch (_error) {
    }
  }

  function ledgerView(intentsByPlanet) {
    let ledger = null;
    try {
      ledger = readLaunchLedger ? readLaunchLedger() : null;
    } catch (error) {
      logErrorFn("launch ledger read failed - DRILL_ITEMS_ONLY treats every Skyhook as not a drill, variant drills mine auto until the next rebuild", error);
    }
    const drills = (ledger && ledger.drills) || {};
    const pending = (ledger && ledger.pending) || {};
    const pendingOf = (drill) => {
      const intent = intentsByPlanet[String(drill.planetID)];
      if (!intent || Number(intent.launchedItemID) !== drill.skyhookID || !intent.sourceItem) return null;
      return pending[String(Number(intent.sourceItem.itemID))] || null;
    };
    return {
      isDrill(drill) {
        return Boolean(drills[String(drill.skyhookID)] || pendingOf(drill));
      },
      p0Of(drill) {
        const recorded = drills[String(drill.skyhookID)];
        if (recorded) return toPositiveInteger(recorded.p0TypeID);
        const entry = pendingOf(drill);
        return entry ? toPositiveInteger(entry.p0TypeID) : 0;
      },
    };
  }

  function scheduleInvalidate() {
    defer(() => {
      try {
        vendor.invalidate();
        stats.invalidations += 1;
      } catch (error) {
        logErrorFn("sovereignty cache invalidation failed", error);
      }
    });
  }

  function pickText(reagent) {
    return reagent.pick === "variant" ? "pick=variant" : `pick=${reagent.pick} tag=${reagent.tag}`;
  }

  function report(revision, overlay, p0Of = () => 0) {
    const planets = overlay.rows.map((row) => row.planetID).join(",");
    const limitedCount = overlay.entries.filter((entry) => entry.limited).length;
    const limitedText = limitedCount > 0 ? ` limited=${limitedCount}` : "";
    logFn(`overlay rev=${revision} drills=${overlay.rows.length - limitedCount}${limitedText} planets=[${planets}] hash=${overlay.hash || "-"}`);
    for (const { drill, reagent, limited } of overlay.entries) {
      if (reagent.pick === "variant-ignored") {
        logFn(`WARN skyhook=${drill.skyhookID} planet=${drill.planetID} variant=${p0Of(drill)} not on planet - mining ${reagent.reagentTypeID}`);
      }
      if (limited) {
        logFn(`skyhook=${drill.skyhookID} planet=${drill.planetID} reagent=${reagent.reagentTypeID} mode=P0 amount=0 reason=${drill.reason || "limit"} ${pickText(reagent)}`);
        continue;
      }
      logFn(`skyhook=${drill.skyhookID} planet=${drill.planetID} reagent=${reagent.reagentTypeID} mode=P0 amount=${reagent.amountPerCycle} ${pickText(reagent)}`);
    }
    for (const { drill, reason } of overlay.skipped) {
      logFn(`skyhook=${drill.skyhookID} planet=${drill.planetID} skipped reason=${reason}`);
    }
  }

  function warnStockLoss(previous, overlay) {
    const next = new Map();
    for (const { drill, reagent } of overlay.entries) {
      next.set(drill.skyhookID, { planetID: drill.planetID, reagentTypeID: reagent.reagentTypeID });
    }
    const skippedReason = new Map(overlay.skipped.map(({ drill, reason }) => [drill.skyhookID, reason]));
    for (const [skyhookID, old] of previous) {
      const now = next.get(skyhookID);
      if (!now) {
        const reason = skippedReason.get(skyhookID) || "gone";
        logFn(`WARN skyhook=${skyhookID} planet=${old.planetID} reagent=${old.reagentTypeID} left the overlay reason=${reason} - no longer produced, stock of ${old.reagentTypeID} will be lost`);
      } else if (now.reagentTypeID !== old.reagentTypeID) {
        logFn(`WARN skyhook=${skyhookID} planet=${now.planetID} reagent=${old.reagentTypeID}->${now.reagentTypeID} - stock of ${old.reagentTypeID} will be lost`);
      }
    }
    return next;
  }

  function syncInner(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.planetDefinitions) ||
        !(snapshot.planetDefinitionsByPlanetID instanceof Map)) {
      return { ok: false, reason: "no-snapshot" };
    }
    let base = bases.get(snapshot);
    if (!base) {
      base = createBase(snapshot);
      bases.set(snapshot, base);
    }
    if (!cfg.enabled) {
      if (applyOverlay(snapshot, EMPTY_OVERLAY, base).changed) {
        logFn("overlay removed (disabled)");
        scheduleInvalidate();
      }
      return { ok: true, reason: "disabled" };
    }
    if (!vendor.ready()) {
      stats.notReady += 1;
      warnEarly("not-ready");
      return { ok: false, reason: "not-ready" };
    }
    const revision = vendor.getRevision();
    if (base.lastRevision === revision) {
      stats.syncFastPath += 1;
      return { ok: true, reason: "fast-path" };
    }
    base.lastRevision = revision;
    stats.syncRebuild += 1;
    const orbitalState = vendor.readOrbitalState() || {};
    const view = ledgerView(orbitalState.replacementsByPlanet || {});
    const picked = new Map();
    const pick = (drill) => {
      if (!picked.has(drill.skyhookID)) {
        const resourceTypeIDs = vendor.resourceTypeIDs(drill.planet);
        picked.set(drill.skyhookID, pickReagent({
          resourceTypeIDs,
          qualities: vendor.qualities(drill.planet, resourceTypeIDs),
          name: drill.name,
          cfg,
          preferredTypeID: view.p0Of(drill),
        }));
      }
      return picked.get(drill.skyhookID);
    };
    const plan = planDrills(Object.values(orbitalState.orbitalsByID || {}), {
      vendorPlanetIDs: base.vendorPlanetIDs,
      pendingByPlanet: orbitalState.replacementsByPlanet || {},
      itemOf: (id) => vendor.findItem(id),
      planetOf: (id) => vendor.getCelestial(id),
      cfg,
      pick,
      isDrill: cfg.drillItemsOnly ? view.isDrill : null,
    });
    const overlay = buildOverlay(plan.drills, pick, cfg, { limited: plan.limited, skipped: plan.skipped });
    const { changed } = applyOverlay(snapshot, overlay, base);
    base.reagentsBySkyhook = warnStockLoss(base.reagentsBySkyhook, overlay);
    if (changed) {
      report(revision, overlay, view.p0Of);
      scheduleInvalidate();
    }
    firstGood = true;
    return { ok: true, reason: changed ? "rebuilt" : "unchanged" };
  }

  function sync(snapshot) {
    if (busy) {
      warnEarly("reentrant");
      return { ok: true, reason: "reentrant" };
    }
    busy = true;
    try {
      return syncInner(snapshot);
    } catch (error) {
      stats.syncFailures += 1;
      if (stats.syncFailures === 1 || stats.syncFailures % 100 === 0) {
        logErrorFn(`overlay failed (${stats.syncFailures}x) - last overlay kept until the next orbital change`, error);
      }
      return { ok: false, reason: "exception" };
    } finally {
      busy = false;
    }
  }

  return { sync, stats, basesOf: (snapshot) => bases.get(snapshot) || null };
}

module.exports = {
  EMPTY_OVERLAY,
  SKYHOOK_TYPE_ID,
  VERSION_TAG,
  applyOverlay,
  buildOverlay,
  createBase,
  createSync,
  isDeploymentPending,
  pickReagent,
  planDrills,
  selectDrills,
};
