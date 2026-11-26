"use strict";

const { bfs } = require("./bfs");
const { isForeignBastion } = require("./bastions");

const ACTIVE = "ACTIVE";
const IDLE = "IDLE";
const GANK_KIND = "gank";
const RAID_OPERATION_TYPE = "raid";
const PERMILLE = 1000;
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);
const CAPSULEER_PURSUIT_PURPOSE = "CAPSULEER_PURSUIT";

const byFleetId = (a, b) => (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0));

function planCapsuleerPursuit(snapshot, supply, params, used, room, opts) {
  const intents = [];
  const notes = [];
  let seen = 0;
  const out = () => ({ intents, notes, seen });
  const P = params && params.capsuleerPursuit;
  if (!P || !(P.maxPerReview > 0)) return out();
  const ct = snapshot.capsuleerTargets;
  if (!ct || typeof ct !== "object" || !Array.isArray(ct.targets)) return out();
  if (!snapshot.faction || snapshot.faction.status !== ACTIVE) return out();
  if (snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true) return out();
  const d = snapshot.doctrine;
  if (!d || !Array.isArray(d.operationTypes) || !d.operationTypes.includes(RAID_OPERATION_TYPE)) return out();
  const kind = (params.kinds || []).find((k) => k.kind === GANK_KIND);
  if (!kind) return out();
  if (ct.truncated === true) notes.push("CAPSULEER_PURSUIT_TARGETS_TRUNCATED");

  const f = snapshot.factionId;
  const rows = new Map((snapshot.systems || []).map((r) => [r.systemId, r]));
  const ships = new Map();
  for (const t of ct.targets) {
    if (!t || !Number.isSafeInteger(t.systemId)) continue;
    const row = rows.get(t.systemId);
    if (!row || row.controllerFactionId !== f) continue;
    ships.set(t.systemId, (ships.get(t.systemId) || 0) + (Number.isSafeInteger(t.ships) ? t.ships : 0));
  }
  seen = ships.size;
  const launched = opts && opts.targets instanceof Set ? opts.targets : new Set();
  const opTargets = new Set((snapshot.operations || []).filter((op) => OPEN_OPERATION_STATES.includes(op.state))
    .map((op) => op.targetSystemId));
  for (const id of [...ships.keys()]) if (opTargets.has(id) || launched.has(id)) ships.delete(id);
  if (P.skipForeignBastions === true) {
    let dropped = 0;
    for (const id of [...ships.keys()]) if (isForeignBastion(snapshot, id)) { ships.delete(id); dropped += 1; }
    if (dropped > 0) notes.push("CAPSULEER_PURSUIT_FOREIGN_BASTION");
  }
  if (ships.size === 0) return out();
  if (!(room >= 1)) {
    notes.push("CAPSULEER_PURSUIT_NO_ROOM");
    return out();
  }
  const isHome = (id) => (rows.get(id).homeFactionId === f ? 0 : 1);
  const targets = [...ships.keys()].sort((a, b) => isHome(a) - isHome(b) || ships.get(b) - ships.get(a) || a - b);

  const pool = (snapshot.fleets || []).filter((x) => x.state === IDLE && x.operationId === null
    && x.refitPending !== true && !used.has(x.fleetId) && Number.isSafeInteger(x.systemId)
    && kind.fleetRoles.includes(x.fleetRole) && x.shipCount >= 1).sort(byFleetId)
    .slice(0, Math.max(0, P.maxFleetsScanned));

  const limit = Math.min(room, P.maxPerReview);
  const noted = new Set();
  const note = (n) => {
    if (!noted.has(n)) notes.push(n);
    noted.add(n);
  };
  const bfsOpts = { maxJumps: P.maxJumps, maxSystems: params.maxBfsSystems };
  for (const T of targets) {
    if (intents.length >= limit) break;
    const dist = bfs([T], snapshot.neighbors, bfsOpts);
    const inRange = pool.filter((x) => !used.has(x.fleetId) && dist.has(x.systemId) && dist.get(x.systemId) >= 1);
    const strong = inRange.filter((x) => x.shipCount * PERMILLE >= ships.get(T) * P.minShipRatioPermille);
    if (strong.length === 0) {
      note(inRange.length > 0 ? "CAPSULEER_PURSUIT_TOO_WEAK" : "CAPSULEER_PURSUIT_NO_FLEET");
      continue;
    }
    strong.sort((a, b) => dist.get(a.systemId) - dist.get(b.systemId) || byFleetId(a, b));
    const x = strong[0];
    used.add(x.fleetId);
    intents.push({ type: "LAUNCH", kind: GANK_KIND, target: { kind: "system", systemId: T, ref: null },
      originSystemId: x.systemId, fleets: [{ fleetId: x.fleetId, expectedVersion: x.version }], mobilize: [],
      dueAt: snapshot.at + P.windowMs, purpose: CAPSULEER_PURSUIT_PURPOSE });
    notes.push(`CAPSULEER_PURSUIT:${T}`);
  }
  return out();
}

module.exports = { planCapsuleerPursuit, CAPSULEER_PURSUIT_PURPOSE };
