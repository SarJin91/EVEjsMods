"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { mask, matchClose, topLevelKeys } = require("../_support/sourceScan");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const LIB_DIR = path.join(MOD_DIR, "lib");
const MAX_DYNAMIC_SHARE = 1 / 3;
const IDENT = "[A-Za-z_$][\\w$]*";
const UNAVAILABLE_RETENTION = "createUnavailableRetention of lib/retention/index.js (ctx.retention when the service is "
  + "not running), read only when state === \"unavailable\"";

const PAIRS = Object.freeze([
  { view: "lib/battle/battlesView.js", vars: ["st"], service: "lib/battle/index.js", def: "const getStatus = () =>" },
  { view: "lib/battle/battlesView.js", vars: ["ws"], service: "lib/world/wrecks.js",
    def: "getStatus: () => Object.freeze({ state, reason: stopReason, layer:" },
  { view: "lib/economy/extraction/extractionView.js", vars: ["st"],
    service: "lib/economy/extraction/extractionService.js", def: "function getStatus()" },
  { view: "lib/economy/logistics/logisticsView.js", vars: ["st"],
    service: "lib/economy/logistics/logisticsService.js", def: "getStatus: () =>" },
  { view: "lib/economy/mining/miningView.js", vars: ["st"], service: "lib/economy/mining/miningService.js",
    def: "getStatus: () =>" },
  { view: "lib/economy/production/productionView.js", vars: ["st"],
    service: "lib/economy/production/productionService.js", def: "getStatus: () =>" },
  { view: "lib/economy/trade/tradeView.js", vars: ["st"], service: "lib/economy/trade/index.js",
    def: "const fullStatus = () =>" },
  { view: "lib/economy/trade/tradeView.js", vars: ["status"], service: "lib/economy/trade/localResources.js",
    def: "function getStatus()", allowedExtra: { warm: "added by localStatus in lib/economy/trade/index.js" } },
  { view: "lib/events/salvage/salvageView.js", vars: [], via: ["status"], service: "lib/events/salvage/index.js",
    def: "getStatus: () => Object.freeze({ state: stopped ?" },
  { view: "lib/fleets/fleetsView.js", vars: ["status"], service: "lib/fleets/index.js",
    def: "getStatus: () => Object.freeze({ state, reason: stopReason, counters:" },
  { view: "lib/fleets/fleetsView.js", vars: ["st"], service: "lib/scheduler/index.js", def: "function getStatus()" },
  { view: "lib/observer/builtinViews.js", vars: ["services"], via: ["servicesStatus"],
    service: "lib/runtime/services.js", def: "function getStatus()" },
  { view: "lib/scheduler/schedulerView.js", vars: ["status"], direct: true, service: "lib/scheduler/index.js",
    def: "function getStatus()" },
  { view: "lib/stations/construction/constructionView.js", vars: ["st"],
    service: "lib/stations/construction/constructionService.js", def: "function getStatus()" },
  { view: "lib/stations/siege/siegesView.js", vars: ["st"], service: "lib/stations/siege/siegeService.js",
    def: "function getStatus()" },
  { view: "lib/stations/siege/siegesView.js", vars: ["pst"], service: "lib/stations/playerSiege/service.js",
    def: "function getStatus()" },
  { view: "lib/stations/stationsView.js", vars: ["st"], service: "lib/stations/index.js", def: "function getStatus()" },
  { view: "lib/stations/structures/structuresView.js", vars: ["st"],
    service: "lib/stations/structures/structuresService.js", def: "function getStatus()" },
  { view: "lib/strategy/activity/activityView.js", vars: [], via: ["strategyStatus"],
    service: "lib/strategy/index.js", def: "function getStatus()" },
  { view: "lib/strategy/activity/activityView.js", vars: ["st"], service: "lib/runtime/services.js",
    def: "function getStatus()" },
  { view: "lib/strategy/activity/activityView.js", vars: ["reviewStatus"], service: "lib/strategy/reviewService.js",
    def: "function getStatus()" },
  { view: "lib/strategy/expeditions/expeditionsView.js", vars: ["st"],
    service: "lib/strategy/expeditions/expeditionService.js", def: "function getStatus()" },
  { view: "lib/strategy/factionsView.js", vars: ["st"], service: "lib/strategy/index.js", def: "function getStatus()" },
  { view: "lib/world/invasions/invasionsView.js", vars: ["st"],
    service: "lib/world/invasions/invasionService.js", def: "function getStatus()" },
  { view: "lib/world/liberation/liberationView.js", vars: ["st"],
    service: "lib/world/liberation/liberationService.js", def: "function getStatus()" },
  { view: "lib/world/occupation/occupationView.js", vars: ["st"],
    service: "lib/world/occupation/occupationService.js", def: "function getStatus()" },
  { view: "lib/world/sovProjection/statusView.js", vars: ["st"], service: "lib/world/sovProjection/index.js",
    def: "getStatus: () => Object.freeze({\n        state: stopped ? STATE_STOPPED" },
  { view: "lib/observer/views/effectiveConfig.js", vars: [], via: ["callStatus"],
    service: "lib/retention/retentionService.js", def: "function getStatus()",
    allowedExtra: { reason: UNAVAILABLE_RETENTION, detail: UNAVAILABLE_RETENTION } },
]);

const EXEMPT = Object.freeze({
  "lib/observer/views/systemInterior.js": "running(service) reads only `state === \"running\"` of two services "
    + "(ctx.sites, ctx.salvageAnomaly; their stubs say unavailable), no fixed service; readLive reads "
    + "ctx.materialization hunts.hunts / patrols.list as optional arrays (stub without them -> empty map)",
});

const OTHER_VARS = Object.freeze({
  "lib/economy/trade/tradeView.js": { priceCacheStatus: "priceCache.getStatus() goes whole into the panel, no key read" },
});

function read(rel) {
  return fs.readFileSync(path.join(MOD_DIR, rel), "utf8").replace(/\r\n/g, "\n");
}

const sources = new Map();

function source(rel) {
  if (!sources.has(rel)) {
    const raw = read(rel);
    sources.set(rel, { text: mask(raw, { strings: false }), ms: mask(raw, { strings: true }) });
  }
  return sources.get(rel);
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith(".js")) out.push(path.relative(MOD_DIR, full).split(path.sep).join("/"));
  }
  return out;
}

function viewFilesReadingStatus() {
  return walk(LIB_DIR, []).filter((rel) => /View[^/]*\.js$/.test(rel.split("/").pop())
    || /^lib\/observer\/views\/[^/]+\.js$/.test(rel)).filter((rel) => read(rel).includes("getStatus")).sort();
}

function exprEnd(ms, from) {
  let depth = 0;
  for (let i = from; i < ms.length; i += 1) {
    const c = ms[i];
    if (c === "{" || c === "(" || c === "[") depth += 1;
    else if (c === "}" || c === ")" || c === "]") {
      if (depth === 0) return i;
      depth -= 1;
    } else if (depth === 0 && (c === "," || c === ";")) return i;
  }
  return ms.length;
}

function skipSpace(ms, at) {
  let i = at;
  while (i < ms.length && /\s/.test(ms[i])) i += 1;
  return i;
}

function unwrap(ms, start, end) {
  let s = skipSpace(ms, start);
  let e = end;
  while (e > s && /\s/.test(ms[e - 1])) e -= 1;
  const m = /^Object\.freeze\s*\(/.exec(ms.slice(s, e));
  if (m) {
    const open = s + m[0].length - 1;
    if (matchClose(ms, open) === e - 1) return unwrap(ms, open + 1, e - 1);
  }
  return { s, e };
}

function exprKeys(text, ms, start, end, body, depth) {
  const { s, e } = unwrap(ms, start, end);
  const src = ms.slice(s, e);
  if (src[0] === "{" && matchClose(ms, s) === e - 1) {
    const k = topLevelKeys(text, ms, s);
    if (k.spread) return { dynamic: "top-level spread" };
    if (k.computed) return { dynamic: "computed key" };
    return { keys: k.keys };
  }
  if (new RegExp(`^${IDENT}$`).test(src) && body && depth === 0) {
    const scope = ms.slice(body.s, body.e);
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${src.replace(/\$/g, "\\$")}\\s*=\\s*`).exec(scope);
    if (!decl) return { dynamic: `return ${src} (not initialized in the function)` };
    const from = body.s + decl.index + decl[0].length;
    const init = exprKeys(text, ms, from, exprEnd(ms, from), body, depth + 1);
    if (init.dynamic) return init;
    const assigned = [...scope.matchAll(new RegExp(`\\b${src.replace(/\$/g, "\\$")}\\.(${IDENT})\\s*=(?!=)`, "g"))]
      .map((m) => m[1]);
    return { keys: [...init.keys, ...assigned] };
  }
  return { dynamic: `unresolved expression "${text.slice(s, Math.min(e, s + 40)).replace(/\s+/g, " ")}"` };
}

function nestedRanges(ms, body) {
  const out = [];
  const scope = ms.slice(body.s, body.e);
  for (const m of scope.matchAll(/=>\s*\{/g)) {
    const open = body.s + m.index + m[0].length - 1;
    out.push([open, matchClose(ms, open)]);
  }
  for (const m of scope.matchAll(/\bfunction\b[^(]*\(/g)) {
    const paren = body.s + m.index + m[0].length - 1;
    const close = matchClose(ms, paren);
    const open = ms.indexOf("{", close);
    if (close > 0 && open > 0) out.push([open, matchClose(ms, open)]);
  }
  return out;
}

function serviceKeys(rel, def) {
  const { text, ms } = source(rel);
  const defRe = new RegExp(def.trim().split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "g");
  const hits = [...text.matchAll(defRe)];
  assert.ok(hits.length > 0, `${rel}: definition "${def}" not found`);
  assert.strictEqual(hits.length, 1, `${rel}: definition "${def}" is not unique`);
  const at = hits[0].index;
  const arrow = ms.indexOf("=>", at);
  const brace = ms.indexOf("{", at);
  let body;
  if (arrow >= 0 && arrow < brace) {
    const startAt = skipSpace(ms, arrow + 2);
    if (ms[startAt] !== "{") {
      const r = exprKeys(text, ms, startAt, exprEnd(ms, startAt), null, 0);
      return r.dynamic ? r : { keys: new Set(r.keys) };
    }
    body = { s: startAt + 1, e: matchClose(ms, startAt) };
  } else {
    body = { s: brace + 1, e: matchClose(ms, brace) };
  }
  const nested = nestedRanges(ms, body);
  const keys = new Set();
  let returns = 0;
  for (const m of ms.slice(body.s, body.e).matchAll(/\breturn\b/g)) {
    const from = body.s + m.index + m[0].length;
    if (nested.some(([a, b]) => from > a && from < b)) continue;
    returns += 1;
    const r = exprKeys(text, ms, from, exprEnd(ms, from), body, 0);
    if (r.dynamic) return r;
    for (const k of r.keys) keys.add(k);
  }
  if (returns === 0) return { dynamic: "no return" };
  return { keys };
}

function scopeEnd(ms, at) {
  let depth = 0;
  for (let i = at; i < ms.length; i += 1) {
    const c = ms[i];
    if (c === "{" || c === "(" || c === "[") depth += 1;
    else if (c === "}" || c === ")" || c === "]") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return ms.length;
}

const STATUS_CALLEES = new Set(["getStatus", "call", "safeCall"]);
const DIRECT = "getStatus()";

function viewReads(rel, via) {
  const { text, ms } = source(rel);
  const helpers = new Set(via || []);
  const decls = [];
  const keysIn = (name, from, to, keys) => {
    const scope = ms.slice(from, to);
    const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*(?:\\?\\.|\\.)\\s*(${IDENT})`, "g");
    for (const r of scope.matchAll(re)) keys.add(r[1]);
  };
  for (const m of ms.matchAll(new RegExp(`\\b(?:const|let)\\s+(${IDENT})\\s*=\\s*`, "g"))) {
    const from = m.index + m[0].length;
    const end = exprEnd(ms, from);
    const init = text.slice(from, end);
    const name = m[1];
    const callee = new RegExp(`^(?:${IDENT}\\s*\\.\\s*)*(${IDENT})\\s*\\(`).exec(ms.slice(from, end));
    const decl = { name, via: null, keys: new Set() };
    if (callee && (helpers.has(callee[1]) || (STATUS_CALLEES.has(callee[1]) && init.includes("getStatus")))) {
      if (helpers.has(callee[1])) decl.via = callee[1];
      const close = matchClose(ms, from + callee[0].length - 1);
      const rest = ms.slice(close + 1, end);
      const direct = new RegExp(`^\\s*\\??\\.\\s*(${IDENT})`).exec(rest);
      if (direct) decl.keys.add(direct[1]);
      else if (/^\s*(?:$|\|\||\?\?)/.test(rest)) keysIn(name, end, scopeEnd(ms, end), decl.keys);
      else continue;
    } else if (!callee && /getStatus\s*[()]|"getStatus"/.test(init)) {
      keysIn(name, end, scopeEnd(ms, end), decl.keys);
    } else {
      continue;
    }
    decls.push(decl);
  }
  const direct = { name: DIRECT, via: DIRECT, keys: new Set() };
  for (const r of ms.matchAll(new RegExp(`(?<![\\w$.])(?:deps\\s*\\.\\s*)?getStatus\\s*\\(\\s*\\)\\s*\\??\\.\\s*(${IDENT})`, "g"))) {
    direct.keys.add(r[1]);
  }
  if (direct.keys.size > 0) decls.push(direct);
  return decls;
}

function rowDecls(row, decls) {
  return decls.filter((d) => (d.via === null && row.vars.includes(d.name))
    || (d.via === DIRECT ? row.direct === true : d.via !== null && (row.via || []).includes(d.via)));
}

function viaOf(view) {
  return PAIRS.filter((r) => r.view === view).flatMap((r) => r.via || []);
}

function rowLabel(row) {
  const parts = [...row.vars, ...(row.via || []).map((v) => `${v}()`), ...(row.direct ? [DIRECT] : [])];
  return `${row.view} [${parts.join(", ")}] -> ${row.service}`;
}

module.exports = ({ test }) => {
  test("SVK1 status keys: every view reading getStatus is in PAIRS / EXEMPT, every status variable has a row", () => {
    const tabled = new Set(PAIRS.map((r) => r.view));
    const missing = viewFilesReadingStatus().filter((rel) => !tabled.has(rel) && !EXEMPT[rel]);
    assert.deepStrictEqual(missing, [], `views reading getStatus without a PAIRS row or EXEMPT reason: ${missing.join(", ")}`);
    const unclaimed = [];
    for (const view of tabled) {
      const rows = PAIRS.filter((r) => r.view === view);
      const decls = viewReads(view, viaOf(view));
      const claimed = new Set(rows.flatMap((r) => rowDecls(r, decls)));
      for (const d of decls) {
        if (!claimed.has(d) && !(OTHER_VARS[view] && OTHER_VARS[view][d.name])) unclaimed.push(`${view}: ${d.name}`);
      }
    }
    assert.deepStrictEqual(unclaimed, [], `status variables without a PAIRS row or OTHER_VARS reason: ${unclaimed.join(", ")}`);
  });

  test("SVK2 status keys: the keys a view reads are returned by its service getStatus()", () => {
    const bad = [];
    const dynamic = [];
    const empty = [];
    for (const row of PAIRS) {
      const decls = rowDecls(row, viewReads(row.view, viaOf(row.view)));
      if (!decls.some((d) => d.keys.size > 0)) empty.push(`${rowLabel(row)}: no status read found - update vars/via`);
      const svc = serviceKeys(row.service, row.def);
      if (svc.dynamic) { dynamic.push(`${rowLabel(row)}: ${svc.dynamic}`); continue; }
      const allowed = row.allowedExtra || {};
      for (const d of decls) {
        for (const key of d.keys) {
          if (!svc.keys.has(key) && !allowed[key]) bad.push(`${rowLabel(row)}: ${d.name}.${key}`);
        }
      }
    }
    if (dynamic.length > 0) console.log(`     SVK2 dynamic (not asserted): ${dynamic.join("; ")}`);
    assert.deepStrictEqual(empty, [], `PAIRS rows without a status read: ${empty.join("; ")}`);
    assert.deepStrictEqual(bad, [], `view keys missing from the service getStatus(): ${bad.join("; ")}`);
    assert.ok(dynamic.length <= PAIRS.length * MAX_DYNAMIC_SHARE,
      `${dynamic.length} of ${PAIRS.length} rows dynamic (max a third) - the test would be empty`);
  });
};

module.exports.scan = { serviceKeys, viewReads, viewFilesReadingStatus, PAIRS };
