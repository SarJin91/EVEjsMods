"use strict";

const { bfs } = require("./bfs");
const { controlledOf } = require("./structureAssault");

const ACTIVE = "ACTIVE";
const IDLE = "IDLE";
const READY = "ready";
const HARVEST_RAID_KIND = "harvest_raid";
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);

function byLoot(a, b) {
  return (Number(b.lootVolumeM3) || 0) - (Number(a.lootVolumeM3) || 0) || a.systemId - b.systemId
    || a.targetId - b.targetId;
}

function planHarvestRaid(snapshot, params, used, room, opts) {
  const out = { intents: [], notes: [], fleetIds: [] };
  const P = params && params.harvestRaid;
  if (!P || !(P.maxDispatchPerReview > 0) || !(room > 0)) return out;
  const hr = snapshot.harvestRaid;
  if (!hr || hr.mode !== READY || !Array.isArray(hr.targets)) return out;
  const entryKind = snapshot.entry && snapshot.entry.kind;
  if (!Array.isArray(P.factionKinds) || !P.factionKinds.includes(entryKind)) return out;
  if (!snapshot.faction || snapshot.faction.status !== ACTIVE) return out;
  if (snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true) return out;
  const d = snapshot.doctrine;
  const kind = (params.kinds || []).find((k) => k.kind === HARVEST_RAID_KIND);
  if (!kind || !d || !Array.isArray(d.operationTypes) || !d.operationTypes.includes(kind.operationType)) {
    if (hr.targets.length > 0) out.notes.push("HARVEST_RAID_NO_KIND");
    return out;
  }
  const open = (snapshot.operations || []).filter((op) => OPEN_OPERATION_STATES.includes(op.state));
  if ((Number(hr.open) || 0) > 0 || open.some((op) => op.operationType === kind.operationType)) {
    out.notes.push("HARVEST_RAID_BUSY");
    return out;
  }
  if (hr.targets.length === 0) return out;

  const launched = opts && opts.targets instanceof Set ? opts.targets : new Set();
  const covered = new Set(open.map((op) => op.targetSystemId));
  const controlled = controlledOf(snapshot);
  const limit = Math.min(room, P.maxDispatchPerReview);
  const taken = new Set();
  const noted = new Set();
  const note = (n) => {
    if (!noted.has(n)) out.notes.push(n);
    noted.add(n);
  };
  for (const t of [...hr.targets].sort(byLoot)) {
    if (out.intents.length >= limit) break;
    const T = t.systemId;
    if (!Number.isSafeInteger(T) || covered.has(T) || launched.has(T)) continue;
    const reach = bfs([T], snapshot.neighbors, { maxJumps: P.dispatchMaxJumps, maxSystems: params.maxBfsSystems });
    if (![...reach.keys()].some((id) => controlled.has(id))) continue;
    const distT = bfs([T], snapshot.neighbors, { maxJumps: params.maxAssemblyJumps, maxSystems: params.maxBfsSystems });
    const fleet = (snapshot.fleets || []).filter((x) => x.state === IDLE && x.refitPending !== true
      && !used.has(x.fleetId) && !taken.has(x.fleetId) && kind.fleetRoles.includes(x.fleetRole)
      && distT.has(x.systemId) && distT.get(x.systemId) >= 1)
      .sort((a, b) => distT.get(a.systemId) - distT.get(b.systemId) || (a.fleetId < b.fleetId ? -1 : 1))[0];
    if (!fleet) {
      note("HARVEST_RAID_NO_FLEET");
      continue;
    }
    covered.add(T);
    taken.add(fleet.fleetId);
    out.intents.push({ type: "LAUNCH", kind: kind.kind, target: { kind: "system", systemId: T, ref: null },
      originSystemId: fleet.systemId, fleets: [{ fleetId: fleet.fleetId, expectedVersion: fleet.version }],
      mobilize: [], dueAt: snapshot.at + params.attackWindowMs });
    out.notes.push(`HARVEST_RAID_LAUNCH:${T}`);
  }
  out.fleetIds = [...taken];
  return out;
}

module.exports = { planHarvestRaid, HARVEST_RAID_KIND };
