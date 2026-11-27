"use strict";

const fs = require("node:fs");

const BLOCK_BYTES = 4 * 1024 * 1024;
const HEADER_MAX_BYTES = 1024 * 1024;
const MB = 1024 * 1024;
const RESOLVE_MIN_SELF_BYTES = 64 * 1024;
const MAX_NAME_BYTES = 200;
const MAX_KEYS_PER_GROUP = 31;
const DEFAULTS = Object.freeze({ top: 40, maxAnchors: 5, maxMemMb: 8192 });
const VALUE_TYPES = Object.freeze(["string", "concatenated string", "sliced string", "number"]);
const VALUES_NAME = "(values)";
const WALK_EDGE_TYPES = Object.freeze(["property", "element", "internal"]);
const SKIP_EDGE_NAMES = Object.freeze(["map", "__proto__", "constructor", "prototype"]);
const SKIP_NODE_TYPES = Object.freeze(["closure", "code", "hidden", "object shape", "native", "synthetic", "symbol"]);
const GRAPH_BYTES_PER_NODE = 18;
const GRAPH_BYTES_PER_EDGE = 9;
const EXIT = Object.freeze({ ok: 0, refused: 1, usage: 2 });
const DELTA = String.fromCharCode(0x394);
const C =Object.freeze({ quote: 34, backslash: 92, comma: 44, open: 91, close: 93, zero: 48, nine: 57, space: 32,
  tab: 9, lf: 10, cr: 13 });

class SnapshotError extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
}

function bad(detail) {
  return new SnapshotError("BAD_SNAPSHOT", detail);
}

function isSpace(c) {
  return c === C.space || c === C.lf || c === C.cr || c === C.tab;
}

function openReader(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
  } catch (err) {
    throw new SnapshotError("READ_FAILED", String((err && err.message) || err));
  }
  const buf = Buffer.allocUnsafe(BLOCK_BYTES);
  return {
    buf,
    read(offset) {
      return fs.readSync(fd, buf, 0, BLOCK_BYTES, offset);
    },
    close() {
      try {
        fs.closeSync(fd);
      } catch (_err) {
      }
    },
  };
}

function withReader(file, fn) {
  const reader = openReader(file);
  try {
    return fn(reader);
  } finally {
    reader.close();
  }
}

function seekKey(reader, offset, key) {
  const pattern = Buffer.from(`"${key}":`, "utf8");
  let pos = offset;
  for (;;) {
    const n = reader.read(pos);
    if (n <= 0) throw bad(`no "${key}" section`);
    const at = reader.buf.subarray(0, n).indexOf(pattern);
    if (at >= 0) return pos + at + pattern.length;
    if (n < BLOCK_BYTES) throw bad(`no "${key}" section`);
    pos += n - pattern.length + 1;
  }
}

function readNumbers(reader, offset, onNumber) {
  let pos = offset;
  let started = false;
  let inNum = false;
  let cur = 0;
  for (;;) {
    const n = reader.read(pos);
    if (n <= 0) throw bad("file ends inside a number array");
    const b = reader.buf;
    for (let i = 0; i < n; i += 1) {
      const c = b[i];
      if (c >= C.zero && c <= C.nine) {
        if (!started) throw bad("number before [");
        cur = cur * 10 + (c - C.zero);
        inNum = true;
        continue;
      }
      if (inNum) {
        onNumber(cur);
        cur = 0;
        inNum = false;
      }
      if (c === C.comma || isSpace(c)) continue;
      if (c === C.open && !started) {
        started = true;
        continue;
      }
      if (c === C.close && started) return pos + i + 1;
      throw bad(`unexpected byte ${c} in a number array`);
    }
    pos += n;
  }
}

function decodeName(parts) {
  let raw = Buffer.concat(parts).toString("utf8");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return JSON.parse(`"${raw}"`);
    } catch (_err) {
      raw = raw.replace(/\\(u[0-9a-fA-F]{0,3})?$/, "");
    }
  }
  return raw;
}

function readStrings(reader, offset, want, onString) {
  let pos = offset;
  let state = 0;
  let index = 0;
  let collecting = false;
  let parts = [];
  let kept = 0;
  const keep = (b, from, to) => {
    if (!collecting || kept >= MAX_NAME_BYTES) return;
    const end = Math.min(to, from + (MAX_NAME_BYTES - kept));
    parts.push(Buffer.from(b.subarray(from, end)));
    kept += end - from;
  };
  for (;;) {
    const n = reader.read(pos);
    if (n <= 0) throw bad("file ends inside the strings array");
    const b = reader.buf;
    let segStart = 0;
    for (let i = 0; i < n; i += 1) {
      const c = b[i];
      if (state === 2) {
        if (c === C.backslash) state = 3;
        else if (c === C.quote) {
          keep(b, segStart, i);
          if (collecting) onString(index, decodeName(parts));
          index += 1;
          state = 1;
        }
      } else if (state === 3) state = 2;
      else if (state === 1) {
        if (c === C.quote) {
          state = 2;
          collecting = want(index);
          parts = [];
          kept = 0;
          segStart = i + 1;
        } else if (c === C.close) return { end: pos + i + 1, count: index };
        else if (c !== C.comma && !isSpace(c)) throw bad(`unexpected byte ${c} in the strings array`);
      } else if (c === C.open) state = 1;
      else if (!isSpace(c)) throw bad("strings is not an array");
    }
    if (state === 2 || state === 3) keep(b, segStart, n);
    pos += n;
  }
}

function fieldIndex(fields, name) {
  const at = Array.isArray(fields) ? fields.indexOf(name) : -1;
  if (at < 0) throw bad(`meta has no field ${name}`);
  return at;
}

function readHeader(file) {
  return withReader(file, (reader) => {
    const n = reader.read(0);
    const text = reader.buf.subarray(0, Math.min(n, HEADER_MAX_BYTES)).toString("utf8");
    const at = text.indexOf("\"nodes\"");
    if (at < 0) throw bad("no nodes section in the first MiB");
    let parsed = null;
    try {
      parsed = JSON.parse(`${text.slice(0, at).replace(/[\s,]+$/, "")}}`);
    } catch (err) {
      throw bad(`header: ${String(err.message).slice(0, 120)}`);
    }
    const s = parsed && parsed.snapshot;
    const meta = s && s.meta;
    if (!meta || !Number.isSafeInteger(s.node_count) || !Number.isSafeInteger(s.edge_count)) {
      throw bad("header without meta / node_count / edge_count");
    }
    const nodeTypes = Array.isArray(meta.node_types) && Array.isArray(meta.node_types[0]) ? meta.node_types[0] : null;
    const edgeTypes = Array.isArray(meta.edge_types) && Array.isArray(meta.edge_types[0]) ? meta.edge_types[0] : null;
    if (!nodeTypes || !edgeTypes) throw bad("meta without node_types / edge_types");
    return {
      nodeCount: s.node_count, edgeCount: s.edge_count, nodeTypes, edgeTypes,
      nodeFieldCount: meta.node_fields.length, edgeFieldCount: meta.edge_fields.length,
      nf: { type: fieldIndex(meta.node_fields, "type"), name: fieldIndex(meta.node_fields, "name"),
        self: fieldIndex(meta.node_fields, "self_size"), edges: fieldIndex(meta.node_fields, "edge_count") },
      ef: { type: fieldIndex(meta.edge_fields, "type"), name: fieldIndex(meta.edge_fields, "name_or_index"),
        to: fieldIndex(meta.edge_fields, "to_node") },
    };
  });
}

function eachNode(reader, header, onNode) {
  const fields = new Array(header.nodeFieldCount).fill(0);
  let k = 0;
  let ordinal = 0;
  const end = readNumbers(reader, seekKey(reader, 0, "nodes"), (v) => {
    fields[k] = v;
    k += 1;
    if (k === header.nodeFieldCount) {
      onNode(ordinal, fields);
      ordinal += 1;
      k = 0;
    }
  });
  if (k !== 0 || ordinal !== header.nodeCount) throw bad(`nodes: ${ordinal} read, header says ${header.nodeCount}`);
  return end;
}

function aggregateNodes(file, header) {
  const valueTypeIds = new Set(VALUE_TYPES.map((t) => header.nodeTypes.indexOf(t)).filter((i) => i >= 0));
  const keys = new Map();
  const byType = header.nodeTypes.map(() => ({ count: 0, selfBytes: 0 }));
  let totalSelfBytes = 0;
  const { nf } = header;
  withReader(file, (reader) => eachNode(reader, header, (_ordinal, f) => {
    const type = f[nf.type];
    const self = f[nf.self];
    const key = valueTypeIds.has(type) ? -(type + 1) : type * 4294967296 + f[nf.name];
    let agg = keys.get(key);
    if (agg === undefined) {
      agg = { count: 0, selfBytes: 0 };
      keys.set(key, agg);
    }
    agg.count += 1;
    agg.selfBytes += self;
    if (byType[type]) {
      byType[type].count += 1;
      byType[type].selfBytes += self;
    }
    totalSelfBytes += self;
  }));
  return { keys, byType, totalSelfBytes };
}

function splitKey(key) {
  if (key < 0) return { type: -key - 1, nameIndex: -1 };
  return { type: Math.floor(key / 4294967296), nameIndex: key % 4294967296 };
}

function summarize(file, opts = {}) {
  try {
    const top = Number.isSafeInteger(opts.top) && opts.top > 0 ? opts.top : DEFAULTS.top;
    const header = readHeader(file);
    const agg = aggregateNodes(file, header);
    const sorted = [...agg.keys.entries()].sort((a, b) => b[1].selfBytes - a[1].selfBytes);
    const wanted = opts.resolveAll === true ? sorted
      : sorted.filter((e, i) => i < top || e[1].selfBytes >= RESOLVE_MIN_SELF_BYTES);
    const need = new Set();
    for (const [key] of wanted) {
      const { nameIndex } = splitKey(key);
      if (nameIndex >= 0) need.add(nameIndex);
    }
    const names = new Map();
    withReader(file, (reader) => {
      readStrings(reader, seekKey(reader, 0, "strings"), (i) => need.has(i), (i, s) => names.set(i, s));
    });
    const rows = wanted.map(([key, a]) => {
      const { type, nameIndex } = splitKey(key);
      const name = nameIndex < 0 ? VALUES_NAME : (names.has(nameIndex) ? names.get(nameIndex) : `#${nameIndex}`);
      return { type: header.nodeTypes[type] || `type${type}`, name, count: a.count, selfBytes: a.selfBytes };
    });
    const byType = {};
    header.nodeTypes.forEach((t, i) => {
      if (agg.byType[i].count > 0) byType[t] = { ...agg.byType[i] };
    });
    return { ok: true, header: { nodeCount: header.nodeCount, edgeCount: header.edgeCount,
      totalSelfBytes: agg.totalSelfBytes, byType }, top: rows.slice(0, top), rows };
  } catch (err) {
    return failure(err);
  }
}

function failure(err) {
  if (err instanceof SnapshotError) return { ok: false, reason: err.reason, detail: err.detail };
  if (err && (err.code === "ENOENT" || err.code === "EACCES" || err.code === "EISDIR")) {
    return { ok: false, reason: "READ_FAILED", detail: String(err.message) };
  }
  return { ok: false, reason: "BAD_SNAPSHOT", detail: String((err && err.message) || err).slice(0, 200) };
}

function diffRows(newer, older) {
  const key = (r) => `${r.type}\u0000${r.name}`;
  const map = new Map();
  for (const r of older.rows) map.set(key(r), { type: r.type, name: r.name, countA: r.count, selfA: r.selfBytes,
    countB: 0, selfB: 0 });
  for (const r of newer.rows) {
    const e = map.get(key(r)) || { type: r.type, name: r.name, countA: 0, selfA: 0, countB: 0, selfB: 0 };
    e.countB += r.count;
    e.selfB += r.selfBytes;
    map.set(key(r), e);
  }
  return [...map.values()].map((e) => ({ ...e, deltaCount: e.countB - e.countA, deltaSelf: e.selfB - e.selfA }))
    .sort((a, b) => b.deltaSelf - a.deltaSelf);
}

function graphBytes(header) {
  return GRAPH_BYTES_PER_NODE * header.nodeCount + GRAPH_BYTES_PER_EDGE * header.edgeCount;
}

function loadGraph(file, header) {
  const N = header.nodeCount;
  const E = header.edgeCount;
  const g = { nodeType: new Uint8Array(N), nodeName: new Uint32Array(N), nodeSelf: new Uint32Array(N),
    firstEdge: new Uint32Array(N + 1), edgeType: new Uint8Array(E), edgeName: new Uint32Array(E),
    edgeTo: new Uint32Array(E) };
  const { nf, ef } = header;
  withReader(file, (reader) => {
    let edgeSum = 0;
    const nodesEnd = eachNode(reader, header, (i, f) => {
      g.nodeType[i] = f[nf.type];
      g.nodeName[i] = f[nf.name];
      g.nodeSelf[i] = Math.min(f[nf.self], 4294967295);
      g.firstEdge[i] = edgeSum;
      edgeSum += f[nf.edges];
    });
    g.firstEdge[N] = edgeSum;
    if (edgeSum !== E) throw bad(`edge_count sum ${edgeSum}, header says ${E}`);
    const fields = new Array(header.edgeFieldCount).fill(0);
    let k = 0;
    let e = 0;
    readNumbers(reader, seekKey(reader, nodesEnd, "edges"), (v) => {
      fields[k] = v;
      k += 1;
      if (k < header.edgeFieldCount) return;
      k = 0;
      if (e >= E) throw bad("more edges than edge_count");
      const to = fields[ef.to] / header.nodeFieldCount;
      if (!Number.isInteger(to) || to >= N) throw bad(`edge ${e} points outside the nodes`);
      g.edgeType[e] = fields[ef.type];
      g.edgeName[e] = fields[ef.name];
      g.edgeTo[e] = to;
      e += 1;
    });
    if (k !== 0 || e !== E) throw bad(`edges: ${e} read, header says ${E}`);
  });
  return g;
}

function anchorReport(file, groups, opts = {}) {
  try {
    const maxAnchors = Number.isSafeInteger(opts.maxAnchors) && opts.maxAnchors > 0 ? opts.maxAnchors
      : DEFAULTS.maxAnchors;
    const maxMemMb = typeof opts.maxMemMb === "number" && opts.maxMemMb >= 0 ? opts.maxMemMb : DEFAULTS.maxMemMb;
    if (!Array.isArray(groups) || groups.some((g) => !Array.isArray(g) || g.length === 0
      || g.length > MAX_KEYS_PER_GROUP)) {
      return { ok: false, reason: "USAGE", detail: `1..${MAX_KEYS_PER_GROUP} keys per --anchor-keys` };
    }
    const header = readHeader(file);
    const needBytes = graphBytes(header);
    if (needBytes > maxMemMb * MB) {
      return { ok: false, reason: "OVER_MEMORY", detail: `graph needs ${Math.ceil(needBytes / MB)} MB > --max-mem-mb `
        + `${maxMemMb}` };
    }
    const watched = new Set([...groups.flat(), ...SKIP_EDGE_NAMES]);
    const indicesOf = new Map([...watched].map((s) => [s, new Set()]));
    withReader(file, (reader) => {
      readStrings(reader, seekKey(reader, 0, "strings"), () => true, (i, s) => {
        if (indicesOf.has(s)) indicesOf.get(s).add(i);
      });
    });
    const g = loadGraph(file, header);
    const typeId = (list, name) => list.indexOf(name);
    const walkEdge = new Set(WALK_EDGE_TYPES.map((t) => typeId(header.edgeTypes, t)).filter((i) => i >= 0));
    const propertyType = typeId(header.edgeTypes, "property");
    const internalType = typeId(header.edgeTypes, "internal");
    const skipNode = new Set(SKIP_NODE_TYPES.map((t) => typeId(header.nodeTypes, t)).filter((i) => i >= 0));
    const skipName = new Set();
    for (const s of SKIP_EDGE_NAMES) for (const i of indicesOf.get(s)) skipName.add(i);
    const visited = new Uint8Array(header.nodeCount);
    const queue = new Uint32Array(header.nodeCount);

    function reach(anchor, starts) {
      visited.fill(0);
      visited[anchor] = 1;
      let head = 0;
      let tail = 0;
      let bytes = 0;
      for (const s of starts) {
        if (visited[s] || skipNode.has(g.nodeType[s])) continue;
        visited[s] = 1;
        queue[tail] = s;
        tail += 1;
      }
      while (head < tail) {
        const n = queue[head];
        head += 1;
        bytes += g.nodeSelf[n];
        for (let e = g.firstEdge[n]; e < g.firstEdge[n + 1]; e += 1) {
          const t = g.edgeType[e];
          if (!walkEdge.has(t)) continue;
          if ((t === propertyType || t === internalType) && skipName.has(g.edgeName[e])) continue;
          const to = g.edgeTo[e];
          if (visited[to] || skipNode.has(g.nodeType[to])) continue;
          visited[to] = 1;
          queue[tail] = to;
          tail += 1;
        }
      }
      return { nodes: tail, bytes };
    }

    const out = [];
    for (const keys of groups) {
      const keyBit = new Map();
      keys.forEach((k, bit) => {
        for (const i of indicesOf.get(k)) keyBit.set(i, bit);
      });
      const full = 2 ** keys.length - 1;
      const found = [];
      for (let n = 0; n < header.nodeCount; n += 1) {
        let mask = 0;
        for (let e = g.firstEdge[n]; e < g.firstEdge[n + 1]; e += 1) {
          if (g.edgeType[e] !== propertyType) continue;
          const bit = keyBit.get(g.edgeName[e]);
          if (bit !== undefined) mask |= 2 ** bit;
        }
        if (mask === full) found.push(n);
      }
      found.sort((a, b) => (g.firstEdge[b + 1] - g.firstEdge[b]) - (g.firstEdge[a + 1] - g.firstEdge[a]));
      const anchors = found.slice(0, maxAnchors).map((n) => {
        const targets = keys.map((k) => {
          for (let e = g.firstEdge[n]; e < g.firstEdge[n + 1]; e += 1) {
            if (g.edgeType[e] === propertyType && indicesOf.get(k).has(g.edgeName[e])) return g.edgeTo[e];
          }
          return null;
        });
        const rows = keys.map((k, i) => ({ key: k, ...reach(n, [targets[i]]) }));
        rows.push({ key: "union", ...reach(n, targets) });
        return { node: n, nameIndex: g.nodeName[n], type: header.nodeTypes[g.nodeType[n]] || "",
          edgeCount: g.firstEdge[n + 1] - g.firstEdge[n], reach: rows };
      });
      out.push({ keys, anchorsFound: found.length, anchors });
    }
    const need = new Set(out.flatMap((grp) => grp.anchors.map((a) => a.nameIndex)));
    const names = new Map();
    withReader(file, (reader) => {
      readStrings(reader, seekKey(reader, 0, "strings"), (i) => need.has(i), (i, s) => names.set(i, s));
    });
    for (const grp of out) {
      for (const a of grp.anchors) {
        a.name = names.get(a.nameIndex) || "";
        delete a.nameIndex;
      }
    }
    return { ok: true, graphBytes: needBytes, groups: out };
  } catch (err) {
    return failure(err);
  }
}

const mbText = (bytes) => (bytes / MB).toFixed(2);
const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

function renderSummary(file, s) {
  const lines = [`# Heap snapshot summary: ${cell(file)}`, "",
    `nodes ${s.header.nodeCount}, edges ${s.header.edgeCount}, self ${mbText(s.header.totalSelfBytes)} MB`, "",
    "| type | count | self MB | % |", "|---|---:|---:|---:|"];
  const total = s.header.totalSelfBytes || 1;
  const types = Object.entries(s.header.byType).sort((a, b) => b[1].selfBytes - a[1].selfBytes);
  for (const [t, v] of types) {
    lines.push(`| ${cell(t)} | ${v.count} | ${mbText(v.selfBytes)} | ${((v.selfBytes / total) * 100).toFixed(1)} |`);
  }
  lines.push("", "| type | name | count | self MB | % |", "|---|---|---:|---:|---:|");
  for (const r of s.top) {
    lines.push(`| ${cell(r.type)} | ${cell(r.name)} | ${r.count} | ${mbText(r.selfBytes)} | `
      + `${((r.selfBytes / total) * 100).toFixed(1)} |`);
  }
  return lines;
}

function renderDiff(newerFile, olderFile, rows, top) {
  const lines = [`# Heap snapshot diff: A = ${cell(olderFile)}, B = ${cell(newerFile)}`, "",
    `| type | name | count A | count B | ${DELTA}count | ${DELTA}self MB |`, "|---|---|---:|---:|---:|---:|"];
  for (const r of rows.slice(0, top)) {
    lines.push(`| ${cell(r.type)} | ${cell(r.name)} | ${r.countA} | ${r.countB} | ${r.deltaCount} | `
      + `${mbText(r.deltaSelf)} |`);
  }
  return lines;
}

function renderAnchors(report) {
  const lines = ["", "## Anchors (approximation, upper bound of retained; shared nodes counted in every key)", "",
    `graph arrays ${mbText(report.graphBytes)} MB`];
  for (const group of report.groups) {
    lines.push("", `### keys ${cell(group.keys.join(","))}: ${group.anchorsFound} objects found`);
    for (const a of group.anchors) {
      lines.push("", `node #${a.node} ${cell(a.type)} ${cell(a.name)}, ${a.edgeCount} edges`, "",
        "| key | reachable nodes | reachable MB |", "|---|---:|---:|");
      for (const r of a.reach) lines.push(`| ${cell(r.key)} | ${r.nodes} | ${mbText(r.bytes)} |`);
    }
  }
  return lines;
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const opts = { ok: true, file: null, top: DEFAULTS.top, diff: null, groups: [], maxAnchors: DEFAULTS.maxAnchors,
    maxMemMb: DEFAULTS.maxMemMb };
  while (args.length > 0) {
    const a = args.shift();
    if (a.startsWith("--")) {
      if (args.length === 0) return { ok: false, reason: "USAGE", detail: `${a} needs a value` };
      const v = args.shift();
      if (a === "--diff") opts.diff = v;
      else if (a === "--anchor-keys") opts.groups.push(v.split(",").map((s) => s.trim()).filter((s) => s !== ""));
      else if (a === "--top" || a === "--max-anchors" || a === "--max-mem-mb") {
        const n = Number(v);
        const okInt = Number.isSafeInteger(n) && (a === "--max-mem-mb" ? n >= 0 : n > 0);
        if (!okInt) return { ok: false, reason: "USAGE", detail: `bad ${a}` };
        if (a === "--top") opts.top = n;
        else if (a === "--max-anchors") opts.maxAnchors = n;
        else opts.maxMemMb = n;
      } else return { ok: false, reason: "USAGE", detail: `unknown argument ${a}` };
    } else if (opts.file === null) opts.file = a;
    else return { ok: false, reason: "USAGE", detail: `extra argument ${a}` };
  }
  if (opts.file === null) return { ok: false, reason: "USAGE", detail: "no snapshot file" };
  return opts;
}

function main(argv, print = (line) => process.stdout.write(`${line}\n`)) {
  const opts = parseArgs(argv);
  if (!opts.ok) {
    process.stderr.write("usage: snapshotSummary.js <file> [--top 40] [--diff <older>] [--anchor-keys k1,k2]... "
      + "[--max-anchors 5] [--max-mem-mb 8192]\n");
    print(`refused: ${opts.reason} - ${opts.detail}`);
    return EXIT.usage;
  }
  const refuse = (r) => {
    print(`refused: ${r.reason} - ${r.detail || ""}`);
    return r.reason === "USAGE" ? EXIT.usage : EXIT.refused;
  };
  const resolveAll = opts.diff !== null;
  const s = summarize(opts.file, { top: opts.top, resolveAll });
  if (!s.ok) return refuse(s);
  let lines = renderSummary(opts.file, s);
  if (opts.diff !== null) {
    const older = summarize(opts.diff, { top: opts.top, resolveAll: true });
    if (!older.ok) return refuse(older);
    lines = lines.concat([""], renderDiff(opts.file, opts.diff, diffRows(s, older), opts.top));
  }
  if (opts.groups.length > 0) {
    const report = anchorReport(opts.file, opts.groups, { maxAnchors: opts.maxAnchors, maxMemMb: opts.maxMemMb });
    if (!report.ok) return refuse(report);
    lines = lines.concat(renderAnchors(report));
  }
  for (const line of lines) print(line);
  return EXIT.ok;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { DEFAULTS, summarize, diffRows, anchorReport, graphBytes, parseArgs, main };
