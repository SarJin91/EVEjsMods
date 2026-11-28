"use strict";

const { LIVE_OPERATOR_KIND, TRAFFIC_OPERATOR_KIND } = require("./data/liveProfiles");

function createDscanNames(getRuntime) {
  const scans = new WeakMap();
  const sceneOf = (session) => getRuntime()?.getSceneForSession?.(session);

  function wrapScan(original) {
    return function scanWithNames(args, session) {
      const results = original.call(this, args, session);
      if (!session || !Array.isArray(results)) return results;
      const scene = sceneOf(session);
      const names = new Map();
      for (const row of results) {
        const id = row?.args?.entries?.find(([key]) => key === "id")?.[1];
        const entity = Number.isSafeInteger(id) ? scene?.getEntityByID(id) : null;
        if (entity?.kind !== "ship" || entity.nativeNpc !== true ||
          (entity.operatorKind !== TRAFFIC_OPERATOR_KIND &&
            !(entity.operatorKind === LIVE_OPERATOR_KIND && entity.lneCivilianOperation))) continue;
        const name = [entity.slimName, entity.itemName, entity.name].find((value) => typeof value === "string" && value.trim());
        if (name) names.set(id, { entity, name: name.trim() });
      }
      scans.set(session, { scene, names, expiresAt: Date.now() + 15000 });
      return results;
    };
  }

  function wrapLocations(original) {
    return function locationsWithScanNames(args, session) {
      const response = original.call(this, args, session);
      const scan = scans.get(session);
      if (!scan || scan.expiresAt < Date.now() || !scan.names.size || !Array.isArray(response?.[1]) ||
        scan.scene !== sceneOf(session)) return response;
      const rows = response[1].map((row) => {
        const id = Number(row[0]);
        const entry = scan.names.get(id);
        if (!entry || row[1] !== "Location " + id || scan.scene.getEntityByID(id) !== entry.entity ||
          entry.entity.cloaked || entry.entity.isCloaked || Number(entry.entity.cloakMode) > 0) return row;
        return [row[0], entry.name, null, ...row.slice(3)];
      });
      return [response[0], rows];
    };
  }

  return { wrapScan, wrapLocations };
}

module.exports = { createDscanNames };

