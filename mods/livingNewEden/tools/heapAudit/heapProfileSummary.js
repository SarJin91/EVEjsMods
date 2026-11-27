"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MB = 1024 * 1024;
const DEFAULTS = Object.freeze({ top: 30 });
const TOP_STACKS = 15;
const STACK_APP_FRAMES = 6;
const RETAINED_MB = 100;
const EXIT = Object.freeze({ ok: 0, refused: 1, usage: 2 });
const RUNTIME_OWNER = "(runtime)";
const NON_APP_OWNERS = Object.freeze(["node", "native"]);

function refusal(reason, detail) {
  return { ok: false, reason, detail };
}

function normalizeUrl(url) {
  let p = typeof url === "string" ? url : "";
  if (p.startsWith("file://")) p = p.slice("file://".length);
  p = p.replace(/\\/g, "/");
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
  return p;
}

function ownerOf(url) {
  const raw = typeof url === "string" ? url : "";
  if (raw === "") return "native";
  if (raw.startsWith("node:") || raw.startsWith("internal/")) return "node";
  const p = `/${normalizeUrl(raw)}`;
  let m = /\/mods\/livingNewEden\/lib\/([^/]+)\//.exec(p);
  if (m) return `lne:${m[1]}`;
  if (p.includes("/mods/livingNewEden/")) return "lne:(root)";
  m = /\/mods\/([^/]+)\//.exec(p);
  if (m) return `mod:${m[1]}`;
  m = /\/server\/src\/(.+)$/.exec(p);
  if (m) {
    const parts = m[1].split("/");
    if (parts.length >= 3) return `vendor:${parts[0]}/${parts[1]}`;
    if (parts.length === 2) return `vendor:${parts[0]}`;
    return "vendor:(root)";
  }
  const nm = p.lastIndexOf("/node_modules/");
  if (nm >= 0) {
    const parts = p.slice(nm + "/node_modules/".length).split("/");
    if (parts[0].startsWith("@") && parts.length >= 3) return `npm:${parts[0]}/${parts[1]}`;
    if (parts.length >= 2 && parts[0] !== "") return `npm:${parts[0]}`;
  }
  return "other";
}

function displayPath(url) {
  const p = normalizeUrl(url);
  const app = p.indexOf("/app/");
  if (app >= 0) return p.slice(app + "/app/".length);
  for (const root of ["/mods/", "/server/", "/tools/"]) {
    const i = p.indexOf(root);
    if (i >= 0) return p.slice(i + 1);
  }
  return p;
}

function frameText(cf) {
  const fn = cf.functionName ? cf.functionName : "(anonymous)";
  const line = Number.isFinite(cf.lineNumber) ? cf.lineNumber + 1 : 0;
  return `${fn}@${displayPath(cf.url)}:${line}`;
}

function frameSig(cf) {
  return `${cf.functionName || ""}@${cf.url || ""}:${cf.lineNumber}:${cf.columnNumber}`;
}

function isNode(n) {
  return n !== null && typeof n === "object" && n.callFrame !== null && typeof n.callFrame === "object"
    && Array.isArray(n.children);
}

function add(map, key, v) {
  map.set(key, (map.get(key) || 0) + v);
}

function walkProfile(profile) {
  if (profile === null || typeof profile !== "object" || !isNode(profile.head)) {
    return refusal("BAD_PROFILE", "no head node with callFrame and children");
  }
  const ownerCache = new Map();
  const ownerOfCached = (url) => {
    const k = typeof url === "string" ? url : "";
    let o = ownerCache.get(k);
    if (o === undefined) {
      o = ownerOf(k);
      ownerCache.set(k, o);
    }
    return o;
  };
  const ownerBytes = new Map();
  const viaBytes = new Map();
  const frames = new Map();
  const stacks = new Map();
  const sigStacks = new Map();
  const nodeOwner = new Map();
  const pathFrames = [];
  let profileBytes = 0;
  const todo = [[profile.head, 0]];
  while (todo.length > 0) {
    const [node, depth] = todo.pop();
    if (!isNode(node)) return refusal("BAD_PROFILE", `node at depth ${depth} without callFrame/children`);
    pathFrames.length = depth;
    const cf = node.callFrame;
    const parentKey = depth > 0 ? pathFrames[depth - 1].key : "";
    const key = crypto.createHash("sha1").update(parentKey).update("\n").update(frameSig(cf)).digest("base64");
    pathFrames.push({ cf, owner: ownerOfCached(cf.url), key });
    const self = Number.isFinite(node.selfSize) && node.selfSize > 0 ? node.selfSize : 0;
    let owner = RUNTIME_OWNER;
    let leaf = -1;
    for (let i = pathFrames.length - 1; i >= 0; i -= 1) {
      if (!NON_APP_OWNERS.includes(pathFrames[i].owner)) {
        owner = pathFrames[i].owner;
        leaf = i;
        break;
      }
    }
    nodeOwner.set(node.id, owner);
    if (self > 0) {
      profileBytes += self;
      add(ownerBytes, owner, self);
      const seen = new Set();
      for (const f of pathFrames) {
        if ((f.owner.startsWith("lne:") || f.owner.startsWith("mod:")) && !seen.has(f.owner)) {
          seen.add(f.owner);
          add(viaBytes, f.owner, self);
        }
      }
      const app = [];
      for (let i = leaf; i >= 0 && app.length < STACK_APP_FRAMES; i -= 1) {
        if (!NON_APP_OWNERS.includes(pathFrames[i].owner)) app.push(frameText(pathFrames[i].cf));
      }
      const frame = leaf >= 0 ? app[0] : RUNTIME_OWNER;
      const fr = frames.get(frame) || { owner, bytes: 0 };
      fr.bytes += self;
      frames.set(frame, fr);
      const text = app.length > 0 ? app.join(" < ") : RUNTIME_OWNER;
      const st = stacks.get(text) || { owner, bytes: 0 };
      st.bytes += self;
      stacks.set(text, st);
      const sg = sigStacks.get(key) || { owner, text, bytes: 0 };
      sg.bytes += self;
      sigStacks.set(key, sg);
    }
    for (let i = node.children.length - 1; i >= 0; i -= 1) todo.push([node.children[i], depth + 1]);
  }
  const samples = Array.isArray(profile.samples) ? profile.samples : [];
  const ownerSamples = new Map();
  for (const s of samples) {
    if (s && nodeOwner.has(s.nodeId)) add(ownerSamples, nodeOwner.get(s.nodeId), 1);
  }
  return { ok: true, profileBytes, samples: samples.length, ownerBytes, ownerSamples, viaBytes, frames, stacks,
    sigStacks };
}

function pct(bytes, total) {
  return total > 0 ? Math.round((bytes / total) * 10000) / 100 : 0;
}

function topEntries(map, n) {
  return [...map.entries()].sort((x, y) => y[1].bytes - x[1].bytes || (x[0] < y[0] ? -1 : 1)).slice(0, n);
}

function summarizeProfile(profile, opts = {}) {
  const top = Number.isSafeInteger(opts.top) && opts.top > 0 ? opts.top : DEFAULTS.top;
  const w = walkProfile(profile);
  if (!w.ok) return w;
  const names = new Set([...w.ownerBytes.keys(), ...w.viaBytes.keys()]);
  const owners = [...names].map((owner) => ({
    owner,
    bytes: w.ownerBytes.get(owner) || 0,
    pct: pct(w.ownerBytes.get(owner) || 0, w.profileBytes),
    samples: w.ownerSamples.get(owner) || 0,
    viaBytes: w.viaBytes.has(owner) ? w.viaBytes.get(owner) : null,
  })).sort((x, y) => y.bytes - x.bytes || (y.viaBytes || 0) - (x.viaBytes || 0) || (x.owner < y.owner ? -1 : 1));
  return {
    ok: true,
    profileBytes: w.profileBytes,
    samples: w.samples,
    owners,
    topFrames: topEntries(w.frames, top).map(([frame, v]) => ({ frame, owner: v.owner, bytes: v.bytes })),
    topStacks: topEntries(w.stacks, TOP_STACKS).map(([stack, v]) => ({ stack, owner: v.owner, bytes: v.bytes })),
  };
}

function diffProfiles(a, b, opts = {}) {
  const top = Number.isSafeInteger(opts.top) && opts.top > 0 ? opts.top : DEFAULTS.top;
  const wa = walkProfile(a);
  if (!wa.ok) return { ...wa, detail: `a: ${wa.detail}` };
  const wb = walkProfile(b);
  if (!wb.ok) return { ...wb, detail: `b: ${wb.detail}` };
  const byAbs = (x, y) => Math.abs(y.delta) - Math.abs(x.delta) || (x.key < y.key ? -1 : 1);
  const ownerNames = new Set([...wa.ownerBytes.keys(), ...wb.ownerBytes.keys()]);
  const owners = [...ownerNames].map((owner) => {
    const va = wa.ownerBytes.get(owner) || 0;
    const vb = wb.ownerBytes.get(owner) || 0;
    return { key: owner, owner, a: va, b: vb, delta: vb - va };
  }).sort(byAbs).map(({ key, ...r }) => r);
  const keys = new Set([...wa.sigStacks.keys(), ...wb.sigStacks.keys()]);
  const stacks = [...keys].map((key) => {
    const sa = wa.sigStacks.get(key);
    const sb = wb.sigStacks.get(key);
    const ref = sb || sa;
    const va = sa ? sa.bytes : 0;
    const vb = sb ? sb.bytes : 0;
    return { key, stack: ref.text, owner: ref.owner, a: va, b: vb, delta: vb - va };
  }).filter((r) => r.delta !== 0).sort(byAbs).slice(0, top).map(({ key, ...r }) => r);
  return { ok: true, totalA: wa.profileBytes, totalB: wb.profileBytes, owners, stacks };
}

function classOf(chars) {
  if (chars === null) return "null";
  return chars > 0 ? ">0" : "0";
}

function median(values) {
  const s = values.slice().sort((x, y) => x - y);
  if (s.length === 0) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function isoOf(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function verdictOf(segments) {
  const first = segments.findIndex((s) => s.cls === ">0");
  if (first < 0) return { status: "no-play", baselineBytes: null, playBytes: null, afterBytes: null, deltaMb: null };
  let last = first;
  segments.forEach((s, i) => {
    if (s.cls === ">0") last = i;
  });
  let baseline = null;
  for (let i = first - 1; i >= 0; i -= 1) {
    if (segments[i].cls === "0") {
      baseline = segments[i].medianBytes;
      break;
    }
  }
  let after = null;
  for (let i = segments.length - 1; i > last; i -= 1) {
    if (segments[i].cls === "0") {
      after = segments[i].medianBytes;
      break;
    }
  }
  const play = Math.max(...segments.filter((s) => s.cls === ">0").map((s) => s.maxBytes));
  if (baseline === null || after === null) {
    return { status: "incomplete", baselineBytes: baseline, playBytes: play, afterBytes: after, deltaMb: null };
  }
  const deltaMb = Math.round(((after - baseline) / MB) * 10) / 10;
  return { status: deltaMb <= RETAINED_MB ? "released" : "retained", baselineBytes: baseline, playBytes: play,
    afterBytes: after, deltaMb };
}

function ringSegments(latest, timeline) {
  const heap = latest && latest.process && latest.process.heap;
  const ring = heap && heap.afterMajor ? heap.afterMajor.ring : undefined;
  if (!Array.isArray(ring)) return refusal("BAD_RING", "process.heap.afterMajor.ring is not an array");
  const segments = [];
  for (let i = 0; i < ring.length; i += 1) {
    const e = ring[i];
    if (!Array.isArray(e) || !Number.isFinite(e[0]) || !Number.isFinite(e[1])) {
      return refusal("BAD_RING", `ring entry ${i} is not [atMs, usedBytes, ...]`);
    }
    const chars = e.length >= 4 && Number.isFinite(e[3]) && e[3] >= 0 ? e[3] : null;
    const cls = classOf(chars);
    let seg = segments[segments.length - 1];
    if (!seg || seg.cls !== cls) {
      seg = { cls, startMs: e[0], endMs: e[0], used: [], maxCharacters: chars };
      segments.push(seg);
    }
    seg.endMs = e[0];
    seg.used.push(e[1]);
    if (chars !== null && (seg.maxCharacters === null || chars > seg.maxCharacters)) seg.maxCharacters = chars;
  }
  const out = segments.map((s) => ({
    cls: s.cls, n: s.used.length, startIso: isoOf(s.startMs), endIso: isoOf(s.endMs),
    minBytes: Math.min(...s.used), medianBytes: median(s.used), lastBytes: s.used[s.used.length - 1],
    maxBytes: Math.max(...s.used), maxCharacters: s.maxCharacters,
  }));
  let reads = [];
  if (timeline !== null && timeline !== undefined) {
    if (typeof timeline !== "object" || !Array.isArray(timeline.reads)) {
      return refusal("BAD_RING", "timeline.reads is not an array");
    }
    reads = timeline.reads.filter((r) => r && typeof r === "object").map((r) => ({
      n: Number.isFinite(r.n) ? r.n : null,
      atIso: typeof r.atIso === "string" ? r.atIso : isoOf(r.atMs),
      atMs: Number.isFinite(r.atMs) ? r.atMs : Date.parse(r.atIso),
      usedHeapBytes: Number.isFinite(r.usedHeapBytes) ? r.usedHeapBytes : null,
      profileBytes: Number.isFinite(r.profileBytes) ? r.profileBytes : null,
    })).sort((x, y) => (x.atMs || 0) - (y.atMs || 0));
  }
  return { ok: true, entries: ring.length, segments: out, reads, verdict: verdictOf(out) };
}

function mbText(bytes) {
  return bytes === null || bytes === undefined ? "-" : (bytes / MB).toFixed(1);
}

function signedMb(bytes) {
  return `${bytes > 0 ? "+" : ""}${(bytes / MB).toFixed(1)}`;
}

function cell(text) {
  return String(text).replace(/\|/g, "\\|");
}

function renderProfile(file, s, meta) {
  const lines = [`# heap profile ${cell(file)}`, "",
    `- profileBytes: ${s.profileBytes} (${mbText(s.profileBytes)} MB)`, `- samples: ${s.samples}`];
  if (meta && Number.isFinite(meta.samplingInterval)) lines.push(`- samplingInterval: ${meta.samplingInterval} B`);
  lines.push("- note: copies of vendor functions in mods (hotPathPerf, scenePerfFix) count as mod:<name>.",
    "", "## owners (deepest application frame; via = bytes with the owner anywhere on the stack, not exclusive, "
      + "does not sum to 100%)", "", "| owner | MB | % | samples | via MB |", "|---|---:|---:|---:|---:|");
  for (const o of s.owners) {
    lines.push(`| ${cell(o.owner)} | ${mbText(o.bytes)} | ${o.pct} | ${o.samples} | ${mbText(o.viaBytes)} |`);
  }
  lines.push("", `## top ${s.topFrames.length} application leaf frames`, "", "| frame | owner | MB |", "|---|---|---:|");
  for (const f of s.topFrames) lines.push(`| ${cell(f.frame)} | ${cell(f.owner)} | ${mbText(f.bytes)} |`);
  lines.push("", `## top ${s.topStacks.length} stacks (last ${STACK_APP_FRAMES} application frames, leaf first)`, "",
    "| stack | owner | MB |", "|---|---|---:|");
  for (const t of s.topStacks) lines.push(`| ${cell(t.stack)} | ${cell(t.owner)} | ${mbText(t.bytes)} |`);
  return lines;
}

function renderDiff(fileA, fileB, d) {
  const lines = [`# heap profile diff ${cell(fileA)} -> ${cell(fileB)}`, "",
    `- profileBytes a: ${d.totalA} (${mbText(d.totalA)} MB), b: ${d.totalB} (${mbText(d.totalB)} MB), `
      + `delta ${signedMb(d.totalB - d.totalA)} MB`, "", "## delta per owner (b - a)", "",
    "| owner | a MB | b MB | delta MB |", "|---|---:|---:|---:|"];
  for (const o of d.owners) {
    lines.push(`| ${cell(o.owner)} | ${mbText(o.a)} | ${mbText(o.b)} | ${signedMb(o.delta)} |`);
  }
  lines.push("", `## top ${d.stacks.length} stacks by delta (key = stack signature)`, "",
    "| stack | owner | a MB | b MB | delta MB |", "|---|---|---:|---:|---:|");
  for (const t of d.stacks) {
    lines.push(`| ${cell(t.stack)} | ${cell(t.owner)} | ${mbText(t.a)} | ${mbText(t.b)} | ${signedMb(t.delta)} |`);
  }
  return lines;
}

function renderRing(file, r) {
  const lines = [`# afterMajor ring ${cell(file)}`, "", `- entries: ${r.entries}`, "",
    "## segments (players online: 0 / >0 / null = no 4th field)", "",
    "| characters | n | start | end | min MB | median MB | last MB | max characters |",
    "|---|---:|---|---|---:|---:|---:|---:|"];
  for (const s of r.segments) {
    lines.push(`| ${s.cls} | ${s.n} | ${s.startIso} | ${s.endIso} | ${mbText(s.minBytes)} | ${mbText(s.medianBytes)} `
      + `| ${mbText(s.lastBytes)} | ${s.maxCharacters === null ? "-" : s.maxCharacters} |`);
  }
  lines.push("", "## timeline reads", "", "| n | at | usedHeap MB | profile MB |", "|---:|---|---:|---:|");
  for (const x of r.reads) {
    lines.push(`| ${x.n === null ? "-" : x.n} | ${x.atIso} | ${mbText(x.usedHeapBytes)} | ${mbText(x.profileBytes)} |`);
  }
  const v = r.verdict;
  let text;
  if (v.status === "no-play") text = "no-play (no segment with characters > 0)";
  else if (v.status === "incomplete") {
    text = `incomplete (baseline ${mbText(v.baselineBytes)} MB, play ${mbText(v.playBytes)} MB, `
      + `after ${mbText(v.afterBytes)} MB: no 0 segment before or after play)`;
  } else {
    const tail = v.status === "released"
      ? "session state is released: a session cost, not a leak; keep the top owners while playing"
      : "retention: diff play -> after, a BUG per owner >= 50 MB that did not drop by >= 50%";
    text = `${v.status} (after - baseline = ${v.deltaMb} MB, threshold ${RETAINED_MB} MB; baseline `
      + `${mbText(v.baselineBytes)} MB, play ${mbText(v.playBytes)} MB, after ${mbText(v.afterBytes)} MB): ${tail}`;
  }
  lines.push("", `verdict: ${text}`);
  return lines;
}

function readJson(file, badReason) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return refusal("READ_FAILED", `${file}: ${err && err.code ? err.code : String(err)}`);
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return refusal(badReason, `${file}: not JSON (${err.message})`);
  }
}

function siblingMeta(file) {
  const m = /^(hs-.+)-\d+\.heapprofile$/.exec(path.basename(file));
  if (!m) return null;
  const t = readJson(path.join(path.dirname(file), `${m[1]}.timeline.json`), "BAD_RING");
  if (!t.ok || !t.value || !Number.isFinite(t.value.intervalBytes)) return null;
  return { samplingInterval: t.value.intervalBytes };
}

const USAGE_TEXT = "usage: heapProfileSummary.js profile <file.heapprofile> [--top 30] [--json <out>]\n"
  + "       heapProfileSummary.js --diff <a.heapprofile> <b.heapprofile> [--top 30] [--json <out>]\n"
  + "       heapProfileSummary.js ring <latest.json> [--timeline <t.json>] [--json <out>]\n";

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const opts = { ok: true, mode: null, files: [], top: DEFAULTS.top, json: null, timeline: null };
  const first = args.shift();
  if (first === "profile" || first === "ring") opts.mode = first;
  else if (first === "--diff" || first === "diff") opts.mode = "diff";
  else return { ok: false, reason: "USAGE", detail: first === undefined ? "no command" : `unknown command ${first}` };
  while (args.length > 0) {
    const a = args.shift();
    if (a === "--diff" && opts.mode === "profile") {
      opts.mode = "diff";
    } else if (a.startsWith("--")) {
      if (args.length === 0) return { ok: false, reason: "USAGE", detail: `${a} needs a value` };
      const v = args.shift();
      if (a === "--top") {
        const n = Number(v);
        if (!Number.isSafeInteger(n) || n <= 0) return { ok: false, reason: "USAGE", detail: "bad --top" };
        opts.top = n;
      } else if (a === "--json") opts.json = v;
      else if (a === "--timeline" && opts.mode === "ring") opts.timeline = v;
      else return { ok: false, reason: "USAGE", detail: `unknown argument ${a}` };
    } else opts.files.push(a);
  }
  const want = opts.mode === "diff" ? 2 : 1;
  if (opts.files.length !== want) {
    return { ok: false, reason: "USAGE", detail: `${opts.mode} needs ${want} file(s), got ${opts.files.length}` };
  }
  return opts;
}

function run(opts) {
  if (opts.mode === "profile") {
    const p = readJson(opts.files[0], "BAD_PROFILE");
    if (!p.ok) return p;
    const s = summarizeProfile(p.value, { top: opts.top });
    if (!s.ok) return s;
    const meta = siblingMeta(opts.files[0]);
    return { ok: true, lines: renderProfile(opts.files[0], s, meta),
      json: { file: opts.files[0], samplingInterval: meta ? meta.samplingInterval : null, ...s } };
  }
  if (opts.mode === "diff") {
    const a = readJson(opts.files[0], "BAD_PROFILE");
    if (!a.ok) return a;
    const b = readJson(opts.files[1], "BAD_PROFILE");
    if (!b.ok) return b;
    const d = diffProfiles(a.value, b.value, { top: opts.top });
    if (!d.ok) return d;
    return { ok: true, lines: renderDiff(opts.files[0], opts.files[1], d),
      json: { fileA: opts.files[0], fileB: opts.files[1], ...d } };
  }
  const l = readJson(opts.files[0], "BAD_RING");
  if (!l.ok) return l;
  let timeline = null;
  if (opts.timeline !== null) {
    const t = readJson(opts.timeline, "BAD_RING");
    if (!t.ok) return t;
    timeline = t.value;
  }
  const r = ringSegments(l.value, timeline);
  if (!r.ok) return r;
  return { ok: true, lines: renderRing(opts.files[0], r), json: { file: opts.files[0], timeline: opts.timeline, ...r } };
}

function main(argv, print = (line) => process.stdout.write(`${line}\n`)) {
  const opts = parseArgs(argv);
  if (!opts.ok) {
    process.stderr.write(USAGE_TEXT);
    print(`refused: ${opts.reason} - ${opts.detail}`);
    return EXIT.usage;
  }
  const r = run(opts);
  if (!r.ok) {
    print(`refused: ${r.reason} - ${r.detail || ""}`);
    return EXIT.refused;
  }
  if (opts.json !== null) {
    try {
      fs.writeFileSync(opts.json, `${JSON.stringify(r.json, null, 2)}\n`);
    } catch (err) {
      print(`refused: WRITE_FAILED - ${opts.json}: ${err && err.code ? err.code : String(err)}`);
      return EXIT.refused;
    }
  }
  for (const line of r.lines) print(line);
  return EXIT.ok;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { DEFAULTS, RETAINED_MB, ownerOf, summarizeProfile, diffProfiles, ringSegments, parseArgs, main };
