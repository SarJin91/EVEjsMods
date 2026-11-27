"use strict";

const CATALOG_VERSION = 1;
const MAX_CANDIDATES = 8;
const STATIONS_PER_LINE = 3;
const MAX_LINE = 120;

const KNOWN_SPACE = Object.freeze({ min: 30000000, max: 30999999 });
const WORMHOLE_SPACE = Object.freeze({ min: 31000000, max: 31999999 });
const MIN_PSEUDO_SECURITY = 0.05;
const LOWSEC_BELOW = 0.45;

function secClassOf(systemId, securityStatus) {
  if (systemId >= WORMHOLE_SPACE.min && systemId <= WORMHOLE_SPACE.max) return "wormhole";
  if (systemId < KNOWN_SPACE.min || systemId > KNOWN_SPACE.max) return "other";
  const raw = Number.isFinite(securityStatus) ? securityStatus : 0;
  let pseudo = Math.min(1, Math.max(0, raw));
  if (pseudo > 0 && pseudo < MIN_PSEUDO_SECURITY) pseudo = MIN_PSEUDO_SECURITY;
  if (pseudo <= 0) return "nullsec";
  return pseudo < LOWSEC_BELOW ? "lowsec" : "highsec";
}

const OWN_CLASSES = Object.freeze(["highsec", "lowsec"]);
const fail = (reason, detail) => ({ ok: false, reason, detail });
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const byNumber = (a, b) => a - b;

function bfs(adjacency, sources) {
  const dist = new Map();
  const queue = [];
  for (const s of [...sources].sort(byNumber)) {
    if (dist.has(s)) continue;
    dist.set(s, 0);
    queue.push(s);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head];
    const d = dist.get(at);
    for (const next of adjacency.get(at) || []) {
      if (dist.has(next)) continue;
      dist.set(next, d + 1);
      queue.push(next);
    }
  }
  return dist;
}

function adjacencyOf(gates) {
  const adjacency = new Map();
  const add = (a, b) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a).add(b);
  };
  for (const g of gates) {
    if (!isId(g.fromSystemId) || !isId(g.toSystemId)) continue;
    add(g.fromSystemId, g.toSystemId);
    add(g.toSystemId, g.fromSystemId);
  }
  const out = new Map();
  for (const [k, v] of adjacency) out.set(k, [...v].sort(byNumber));
  return out;
}

function borderCandidates(stations, toNullsec, factionCorp) {
  const rows = stations.filter((s) => toNullsec.has(s.systemId))
    .map((s) => ({ ...s, jumps: toNullsec.get(s.systemId) }))
    .sort((a, b) => a.jumps - b.jumps || (b.corporationId === factionCorp) - (a.corporationId === factionCorp)
      || a.stationId - b.stationId);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.systemId)) continue;
    seen.add(r.systemId);
    out.push([r.stationId, r.systemId, r.corporationId, r.jumps]);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

function nullsecCandidates(stations, hqSystemId, adjacency, factionCorp) {
  if (stations.length === 0) return { base: hqSystemId, rows: [], unreachable: 0 };
  let base = null;
  if (stations.some((s) => s.systemId === hqSystemId)) base = hqSystemId;
  else {
    const count = new Map();
    for (const s of stations) count.set(s.systemId, (count.get(s.systemId) || 0) + 1);
    let best = 0;
    for (const [systemId, n] of [...count].sort((a, b) => a[0] - b[0])) {
      if (n > best) {
        best = n;
        base = systemId;
      }
    }
  }
  const fromBase = bfs(adjacency, [base]);
  const rows = stations.filter((s) => fromBase.has(s.systemId))
    .map((s) => ({ ...s, jumps: fromBase.get(s.systemId) }))
    .sort((a, b) => (b.systemId === base) - (a.systemId === base) || a.jumps - b.jumps
      || (b.corporationId === factionCorp) - (a.corporationId === factionCorp) || a.stationId - b.stationId)
    .slice(0, MAX_CANDIDATES)
    .map((r) => [r.stationId, r.systemId, r.corporationId, r.jumps]);
  return { base, rows, unreachable: stations.filter((s) => !fromBase.has(s.systemId)).length };
}

function ascii(value) {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function serialize(header, catalog) {
  const out = [];
  out.push("\"use strict\";");
  out.push("");
  out.push("function deepFreeze(value) {");
  out.push("  if (value && typeof value === \"object\" && !Object.isFrozen(value)) {");
  out.push("    for (const key of Object.keys(value)) deepFreeze(value[key]);");
  out.push("    Object.freeze(value);");
  out.push("  }");
  out.push("  return value;");
  out.push("}");
  out.push("");
  out.push(`const FACTION_CATALOG_VERSION = ${CATALOG_VERSION};`);
  out.push("");
  out.push(`const FACTION_CATALOG_SDE = { buildNumber: ${ascii(header.buildNumber)}, `
    + `releaseDate: ${ascii(header.releaseDate)} };`);
  out.push("");
  out.push("const FACTION_CATALOG = [");
  for (const e of catalog) {
    out.push("  {");
    out.push(`    factionId: ${e.factionId}, name: ${ascii(e.name)},`);
    out.push(`    corporationId: ${ascii(e.corporationId)}, militiaCorporationId: ${ascii(e.militiaCorporationId)}, `
      + `sdeHqSystemId: ${ascii(e.sdeHqSystemId)},`);
    out.push(`    ownRegionIds: ${ascii(e.ownRegionIds)},`);
    out.push(`    borderRegionIds: ${ascii(e.borderRegionIds)},`);
    out.push("    corporations: [");
    for (const c of e.corporations) {
      const head = `      { corporationId: ${c.corporationId}, name: ${ascii(c.name)}, ticker: ${ascii(c.ticker)},`;
      const tail = `ceoId: ${ascii(c.ceoId)}, stationCount: ${c.stationCount} },`;
      if (head.length + 1 + tail.length <= MAX_LINE) out.push(`${head} ${tail}`);
      else out.push(head, `        ${tail}`);
    }
    out.push("    ],");
    out.push("    stations: [");
    for (let i = 0; i < e.stations.length; i += STATIONS_PER_LINE) {
      out.push(`      ${e.stations.slice(i, i + STATIONS_PER_LINE).map(ascii).join(", ")},`);
    }
    out.push("    ],");
    out.push("    candidates: {");
    for (const name of ["border", "nullsec"]) {
      const rows = e.candidates[name];
      if (rows.length === 0) {
        out.push(`      ${name}: [],`);
        continue;
      }
      out.push(`      ${name}: [`);
      for (const row of rows) out.push(`        ${ascii(row)},`);
      out.push("      ],");
    }
    out.push(`      suggestedBaseSystemId: ${ascii(e.candidates.suggestedBaseSystemId)},`);
    out.push("    },");
    out.push("  },");
  }
  out.push("];");
  out.push("");
  out.push("module.exports = deepFreeze({ FACTION_CATALOG_VERSION, FACTION_CATALOG_SDE, FACTION_CATALOG });");
  out.push("");
  return out.join("\n");
}

function buildCatalog(inputs) {
  const names = ["factions", "corporations", "stations", "systems", "constellations", "regions", "gates"];
  if (!inputs || !inputs.sde || names.some((n) => !Array.isArray(inputs[n]))) {
    return fail("INPUT_INVALID", `inputs need sde, ${names.join(", ")}`);
  }
  const regionFaction = new Map(inputs.regions.map((r) => [r.regionId, isId(r.factionId) ? r.factionId : null]));
  const constellationFaction = new Map(inputs.constellations.map((c) => [c.constellationId,
    isId(c.factionId) ? c.factionId : null]));
  const systems = new Map();
  for (const s of inputs.systems) {
    const factionId = isId(s.factionId) ? s.factionId
      : (constellationFaction.get(s.constellationId) || regionFaction.get(s.regionId) || null);
    systems.set(s.systemId, { systemId: s.systemId, regionId: s.regionId, factionId,
      secClass: secClassOf(s.systemId, s.securityStatus) });
  }
  const adjacency = adjacencyOf(inputs.gates);
  const nullsec = [...systems.values()].filter((s) => s.secClass === "nullsec").map((s) => s.systemId);
  const toNullsec = bfs(adjacency, nullsec);
  const isOwn = (sys, f) => Boolean(sys) && sys.factionId === f && OWN_CLASSES.includes(sys.secClass);

  const corpsByFaction = new Map();
  const corpFaction = new Map();
  for (const c of [...inputs.corporations].sort((a, b) => a.corporationId - b.corporationId)) {
    if (!isId(c.factionId)) continue;
    if (!corpsByFaction.has(c.factionId)) corpsByFaction.set(c.factionId, []);
    corpsByFaction.get(c.factionId).push(c);
    corpFaction.set(c.corporationId, c.factionId);
  }
  const stationsByFaction = new Map();
  const stationCount = new Map();
  for (const s of [...inputs.stations].sort((a, b) => a.stationId - b.stationId)) {
    const f = corpFaction.get(s.ownerId);
    if (f === undefined) continue;
    if (!stationsByFaction.has(f)) stationsByFaction.set(f, []);
    stationsByFaction.get(f).push({ stationId: s.stationId, systemId: s.systemId, corporationId: s.ownerId });
    stationCount.set(s.ownerId, (stationCount.get(s.ownerId) || 0) + 1);
  }

  const catalog = [];
  const stats = [];
  const sortedFactions = [...inputs.factions].sort((a, b) => a.factionId - b.factionId);
  for (let i = 1; i < sortedFactions.length; i += 1) {
    if (sortedFactions[i].factionId === sortedFactions[i - 1].factionId) {
      return fail("DUPLICATE_FACTION", String(sortedFactions[i].factionId));
    }
  }
  for (const f of sortedFactions) {
    const factionCorp = isId(f.corporationId) ? f.corporationId : null;
    const hq = isId(f.hqSystemId) ? f.hqSystemId : null;
    const ownRegionIds = [...regionFaction].filter(([, owner]) => owner === f.factionId).map(([id]) => id)
      .sort(byNumber);
    const own = new Set(ownRegionIds);
    const border = new Set();
    for (const sys of systems.values()) {
      if (!own.has(sys.regionId) || border.has(sys.regionId) || !isOwn(sys, f.factionId)) continue;
      const next = adjacency.get(sys.systemId) || [];
      if (next.some((id) => systems.has(id) && systems.get(id).secClass === "nullsec")) border.add(sys.regionId);
    }
    const stations = stationsByFaction.get(f.factionId) || [];
    const ownBorder = stations.filter((s) => {
      const sys = systems.get(s.systemId);
      return isOwn(sys, f.factionId) && border.has(sys.regionId);
    });
    const inNullsec = stations.filter((s) => systems.has(s.systemId)
      && systems.get(s.systemId).secClass === "nullsec");
    const rn = nullsecCandidates(inNullsec, hq, adjacency, factionCorp);
    catalog.push({
      factionId: f.factionId,
      name: String(f.name),
      corporationId: factionCorp,
      militiaCorporationId: isId(f.militiaCorporationId) ? f.militiaCorporationId : null,
      sdeHqSystemId: hq,
      ownRegionIds,
      borderRegionIds: [...border].sort(byNumber),
      corporations: (corpsByFaction.get(f.factionId) || []).map((c) => ({ corporationId: c.corporationId,
        name: String(c.name), ticker: String(c.ticker), ceoId: isId(c.ceoId) ? c.ceoId : null,
        stationCount: stationCount.get(c.corporationId) || 0 })),
      stations: stations.map((s) => [s.stationId, s.systemId, s.corporationId]),
      candidates: {
        border: borderCandidates(ownBorder, toNullsec, factionCorp),
        nullsec: rn.rows,
        suggestedBaseSystemId: rn.base,
      },
    });
    stats.push({ factionId: f.factionId,
      unreachableBorder: ownBorder.filter((s) => !toNullsec.has(s.systemId)).length,
      unreachableNullsec: rn.unreachable });
  }
  const header = { buildNumber: inputs.sde.buildNumber, releaseDate: inputs.sde.releaseDate,
    catalogVersion: CATALOG_VERSION };
  return { ok: true, header, catalog, stats, source: serialize(header, catalog) };
}

module.exports = { buildCatalog, secClassOf, CATALOG_VERSION, MAX_CANDIDATES };
