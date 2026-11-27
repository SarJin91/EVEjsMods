#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const REPORT_VERSION = 1;
const ROW_KEY_SEP = "\u001f";
const ROW_KEY_NEXT = " ";
const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const AGE_BUCKETS = Object.freeze([["lt1d", DAY_MS], ["d1to7", 7 * DAY_MS], ["d7to30", 30 * DAY_MS],
  ["gt30d", Number.POSITIVE_INFINITY]]);
const TERMINAL_OLD_MS = HOUR_MS;
const NPC_ID_MAX = 90000000;
const LIVE_VOLUME_PREFIX = "/var/lib/evejs/";
const DEFAULT_TOP = 30;
const TOP_INSTANCES = 10;
const TOP_SPAWN_KEYS = 3;
const TOP_TYPE_IDS = 10;
const DIFF_TOP = 20;
const MAX_LOCATOR_DEPTH = 6;
const FILETIME_EPOCH_OFFSET_MS = 11644473600000;
const FILETIME_TICKS_PER_MS = 10000;
const FILETIME_MIN = 1e16;
const MS_MIN = 1e11;

const LNE_PROVIDER_ID = "livingNewEden";
const LNE_SITE_ORIGIN = "lne_event";
const ACTIVE_STATES = new Set(["seeded", "active", "paused"]);
const TERMINAL_STATES = new Set(["completed", "failed", "despawned"]);
const PURGED_SITE_STATE = "PURGED";

const T_DUNGEON = "dungeonRuntimeState";
const T_KILLMAILS = "killmails";
const T_ITEMS = "items";
const T_MAIL = "mail";
const T_NOTIFICATIONS = "notifications";
const T_WRECKS = "npcWrecks";
const RECEIPT_GROUP = "__evejsInventoryGrantReceipts";
const OUTCOME_GROUPS = Object.freeze(["__evejsCareerCombatOutcomes", "__evejsIncursionCombatOutcomes"]);
const MAIL_GROUPS = Object.freeze(["messages", "mailboxes", "mailingLists"]);
const NPC_TABLES = Object.freeze(["npcEntities", "npcModules", "npcCargo", "npcRuntimeControllers", "npcWrecks",
  "npcWreckItems"]);
const RECEIPT_CLASSES = Object.freeze(["lne:trade:", "lne:fc:", "lne:season:", "lne-sentry", "lne-hraid:", "lne:tbr:",
  "lne:"]);
const LNE_CHARACTER_SOURCES = Object.freeze([
  { table: "world_virtual_identities", column: "evejs_id", where: "kind = 'character'", needs: ["kind"] },
  { table: "world_free_corp_members", column: "character_id" },
  { table: "world_free_corps", column: "ceo_character_id" },
  { table: "world_capsuleer_corps", column: "ceo_character_id" },
  { table: "world_capsuleer_corps", column: "member_ids_json", json: true },
  { table: "world_fleet_crew_seats", column: "character_id" },
  { table: "world_crew_pilots", column: "character_id" },
]);

const USAGE = "usage: heapGrowthReport.js <gamestore.sqlite> [--world <world.sqlite>] [--server <serverDir>] "
  + "[--now <ms>] [--json <out.json>] [--top <n>]\n"
  + "       heapGrowthReport.js --diff <a.json> <b.json> [--json <out.json>]";

const quoteIdent = (name) => `"${String(name).replace(/"/g, "\"\"")}"`;
const toNum = (v) => (typeof v === "bigint" ? Number(v) : Number(v));
const isPosId = (v) => Number.isFinite(Number(v)) && Number(v) > 0;
const groupRange = (group) => [`${group}${ROW_KEY_SEP}`, `${group}${ROW_KEY_NEXT}`];
const messageOf = (err) => String((err && err.message) || err);
const round2 = (v) => Math.round(v * 100) / 100;
const isValidDateMs = (ms) => Number.isFinite(new Date(ms).getTime());
const isoOf = (ms) => (isValidDateMs(ms) ? new Date(ms).toISOString() : "invalid date");

function findServerDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < MAX_LOCATOR_DEPTH; i += 1) {
    const candidate = path.join(dir, "server", "package.json");
    if (fs.existsSync(candidate)) return path.dirname(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function wrapBetter(raw) {
  return {
    all: (sql, ...p) => raw.prepare(sql).all(...p),
    get: (sql, ...p) => raw.prepare(sql).get(...p),
    iterate: (sql, ...p) => raw.prepare(sql).iterate(...p),
    exec: (sql) => raw.exec(sql),
    close: () => raw.close(),
  };
}

function wrapNode(raw) {
  return {
    all: (sql, ...p) => raw.prepare(sql).all(...p),
    get: (sql, ...p) => raw.prepare(sql).get(...p),
    iterate: (sql, ...p) => raw.prepare(sql).iterate(...p),
    exec: (sql) => raw.exec(sql),
    close: () => raw.close(),
  };
}

function loadDriver(serverDir) {
  const warnings = [];
  if (serverDir) {
    try {
      const Database = createRequire(path.join(serverDir, "package.json"))("better-sqlite3");
      if (typeof Database === "function") {
        return { ok: true, name: "better-sqlite3", warnings,
          open(file, opts = {}) {
            const readOnly = opts.readOnly !== false;
            return wrapBetter(new Database(file, { readonly: readOnly, fileMustExist: readOnly }));
          } };
      }
      warnings.push("better-sqlite3 export is not a constructor; node:sqlite used");
    } catch (err) {
      warnings.push(`better-sqlite3 not loaded (${messageOf(err).split("\n")[0]}); node:sqlite used`);
    }
  }
  try {
    const { DatabaseSync } = require("node:sqlite");
    return { ok: true, name: "node:sqlite", warnings,
      open(file, opts = {}) {
        return wrapNode(new DatabaseSync(file, { readOnly: opts.readOnly !== false }));
      } };
  } catch (err) {
    return { ok: false, reason: "NO_SQLITE_DRIVER", detail: messageOf(err) };
  }
}

function openReadOnly(driver, file) {
  const db = driver.open(path.resolve(file), { readOnly: true });
  db.exec("PRAGMA query_only = 1");
  return db;
}

function toMs(value) {
  let v = value;
  if (v && typeof v === "object" && "value" in v) v = v.value;
  if (typeof v === "bigint") v = Number(v);
  if (typeof v === "string") {
    if (!/^\d{1,20}$/.test(v.trim())) return 0;
    v = Number(v.trim());
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 0;
  if (v >= FILETIME_MIN) return Math.floor(v / FILETIME_TICKS_PER_MS) - FILETIME_EPOCH_OFFSET_MS;
  if (v >= MS_MIN) return Math.floor(v);
  return 0;
}

const newAges = () => ({ lt1d: 0, d1to7: 0, d7to30: 0, gt30d: 0, unknown: 0 });

function addAge(ages, nowMs, atMs) {
  if (!(atMs > 0)) {
    ages.unknown += 1;
    return;
  }
  const age = Math.max(0, nowMs - atMs);
  for (const [name, limit] of AGE_BUCKETS) {
    if (age < limit) {
      ages[name] += 1;
      return;
    }
  }
}

const newStat = () => ({ count: 0, bytes: 0, maxBytes: 0, avgBytes: 0, age: newAges() });

function addStat(stat, bytes, nowMs, atMs) {
  stat.count += 1;
  stat.bytes += bytes;
  if (bytes > stat.maxBytes) stat.maxBytes = bytes;
  if (nowMs !== null) addAge(stat.age, nowMs, atMs);
}

function finishStat(stat) {
  stat.avgBytes = stat.count > 0 ? Math.round(stat.bytes / stat.count) : 0;
  return stat;
}

function originOf(rec) {
  const origin = String((rec && rec.siteOrigin) || "unknown").toLowerCase();
  if (origin !== LNE_SITE_ORIGIN) return `vendor:${origin}`;
  const md = rec && rec.metadata && typeof rec.metadata === "object" ? rec.metadata : {};
  return md.providerID === LNE_PROVIDER_ID ? "lne" : "lne_foreign";
}

function killmailClass(rec, lneChars) {
  const ids = [rec && rec.victimCharacterID, rec && rec.finalCharacterID];
  for (const a of Array.isArray(rec && rec.attackers) ? rec.attackers : []) ids.push(a && a.characterID);
  const chars = ids.filter(isPosId).map(Number);
  if (chars.length === 0) return "NPC_ONLY";
  if (lneChars && chars.some((id) => lneChars.has(id))) return "LNE_CHAR";
  return "PLAYER";
}

function receiptClass(receiptKey) {
  const k = String(receiptKey || "");
  for (const prefix of RECEIPT_CLASSES) if (k.startsWith(prefix)) return prefix;
  return "other";
}

function jsonBytes(value) {
  return value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), "utf8");
}

function parseRow(text, warnings, where) {
  try {
    return JSON.parse(text);
  } catch (_err) {
    warnings.push(`${where}: a row is not JSON`);
    return null;
  }
}

function pushTop(list, entry, n) {
  if (list.length >= n && entry.bytes <= list[list.length - 1].bytes) return;
  list.push(entry);
  list.sort((a, b) => b.bytes - a.bytes);
  if (list.length > n) list.length = n;
}

function listTables(db) {
  const out = new Map();
  for (const t of db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")) {
    const cols = db.all("SELECT name FROM pragma_table_info(?)", t.name).map((c) => c.name);
    out.set(t.name, new Set(cols));
  }
  return out;
}

const BYTES_SQL = "COUNT(*) AS n, COALESCE(SUM(length(CAST(json AS BLOB))), 0) AS b, "
  + "COALESCE(MAX(length(CAST(json AS BLOB))), 0) AS m";

function aggregate(db, table, group) {
  const r = group === undefined
    ? db.get(`SELECT ${BYTES_SQL} FROM ${quoteIdent(table)}`)
    : db.get(`SELECT ${BYTES_SQL} FROM ${quoteIdent(table)} WHERE key >= ? AND key < ?`, ...groupRange(group));
  return { rows: toNum(r.n), bytes: toNum(r.b), maxRowBytes: toNum(r.m) };
}

function iterateGroup(db, table, group) {
  return db.iterate(`SELECT key, json, length(CAST(json AS BLOB)) AS bytes FROM ${quoteIdent(table)} `
    + "WHERE key >= ? AND key < ?", ...groupRange(group));
}

const isStoreTable = (tables, name) => tables.has(name) && tables.get(name).has("key") && tables.get(name).has("json");

function sectionTables(db, tables, top) {
  const byName = {};
  let totalRows = 0;
  let totalJsonBytes = 0;
  for (const [name, cols] of tables) {
    if (cols.has("json")) {
      const a = aggregate(db, name);
      byName[name] = { rows: a.rows, jsonBytes: a.bytes, maxRowBytes: a.maxRowBytes };
      totalJsonBytes += a.bytes;
    } else {
      byName[name] = { rows: toNum(db.get(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`).n), jsonBytes: 0,
        maxRowBytes: 0 };
    }
    totalRows += byName[name].rows;
  }
  const order = Object.keys(byName).sort((a, b) => byName[b].jsonBytes - byName[a].jsonBytes || a.localeCompare(b));
  return { count: order.length, totalRows, totalJsonBytes, top: order.slice(0, top), byName };
}

function topSpawnKeys(rec) {
  const ss = rec && rec.spawnState && typeof rec.spawnState === "object" ? rec.spawnState : {};
  return Object.keys(ss).filter((k) => k !== "ownership")
    .map((k) => ({ key: k, bytes: jsonBytes(ss[k]) }))
    .sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key))
    .slice(0, TOP_SPAWN_KEYS);
}

function sectionDungeon(db, ctx) {
  const out = { instances: 0, bytes: 0, buckets: {}, persistentSystems: 0,
    lne: { instances: 0, bytes: 0, staleActive: 0, terminalOld: 0, orphans: null }, foreignAlarm: 0, top: [] };
  if (ctx.lneSites) out.lne.orphans = { noRow: 0, purgedRow: 0, bytes: 0 };
  const systems = new Set();
  for (const row of iterateGroup(db, T_DUNGEON, "instancesByID")) {
    const bytes = toNum(row.bytes);
    const rec = parseRow(row.json, ctx.warnings, T_DUNGEON);
    if (!rec || typeof rec !== "object") continue;
    const cls = originOf(rec);
    const state = String(rec.lifecycleState || "unknown").toLowerCase();
    const persistent = !!(rec.runtimeFlags && rec.runtimeFlags.universePersistent === true);
    const timers = rec.timers && typeof rec.timers === "object" ? rec.timers : {};
    const createdAtMs = toNum(timers.createdAtMs) || 0;
    const bucketKey = `${cls}|${state}|${persistent ? "persistent" : "transient"}`;
    if (!out.buckets[bucketKey]) {
      out.buckets[bucketKey] = { class: cls, lifecycleState: state, universePersistent: persistent, ...newStat() };
    }
    addStat(out.buckets[bucketKey], bytes, ctx.now, createdAtMs);
    out.instances += 1;
    out.bytes += bytes;
    if (persistent && isPosId(rec.solarSystemID)) systems.add(Number(rec.solarSystemID));
    if (cls === "lne_foreign") out.foreignAlarm += 1;
    if (cls === "lne") {
      out.lne.instances += 1;
      out.lne.bytes += bytes;
      const expiresAtMs = toNum(timers.expiresAtMs) || 0;
      if (ACTIVE_STATES.has(state) && expiresAtMs > 0 && expiresAtMs < ctx.now) out.lne.staleActive += 1;
      const changedAtMs = toNum(timers.lastUpdatedAtMs) || createdAtMs;
      if (TERMINAL_STATES.has(state) && changedAtMs > 0 && ctx.now - changedAtMs > TERMINAL_OLD_MS) {
        out.lne.terminalOld += 1;
      }
      if (ctx.lneSites) {
        const siteKey = rec.metadata && typeof rec.metadata.lneSiteKey === "string" ? rec.metadata.lneSiteKey : null;
        const siteState = siteKey === null ? undefined : ctx.lneSites.get(siteKey);
        if (siteState === undefined) {
          out.lne.orphans.noRow += 1;
          out.lne.orphans.bytes += bytes;
        } else if (siteState === PURGED_SITE_STATE) {
          out.lne.orphans.purgedRow += 1;
          out.lne.orphans.bytes += bytes;
        }
      }
    }
    if (out.top.length < TOP_INSTANCES || bytes > out.top[out.top.length - 1].bytes) {
      pushTop(out.top, { instanceID: isPosId(rec.instanceID) ? Number(rec.instanceID) : null, class: cls,
        templateID: typeof rec.templateID === "string" ? rec.templateID : null, bytes,
        spawnStateTopKeys: topSpawnKeys(rec) }, TOP_INSTANCES);
    }
  }
  Object.values(out.buckets).forEach(finishStat);
  out.persistentSystems = systems.size;
  return out;
}

function sectionKillmails(db, ctx) {
  const out = { classes: {}, records: 0, bytes: 0, pending: aggregate(db, T_KILLMAILS, "pending").rows,
    meta: { bytes: 0, terminalEventKillIDs: 0, terminalEventKillIDsLne: 0 } };
  for (const row of iterateGroup(db, T_KILLMAILS, "records")) {
    const bytes = toNum(row.bytes);
    const rec = parseRow(row.json, ctx.warnings, T_KILLMAILS);
    if (!rec || typeof rec !== "object") continue;
    const cls = killmailClass(rec, ctx.lneChars);
    if (!out.classes[cls]) {
      out.classes[cls] = { ...newStat(), attackersSum: 0, attackersMax: 0, attackersAvg: 0, itemsSum: 0, itemsMax: 0,
        itemsAvg: 0 };
    }
    const c = out.classes[cls];
    addStat(c, bytes, ctx.now, toMs(rec.killTime));
    const attackers = Array.isArray(rec.attackers) ? rec.attackers.length : 0;
    const items = Array.isArray(rec.items) ? rec.items.length : 0;
    c.attackersSum += attackers;
    c.attackersMax = Math.max(c.attackersMax, attackers);
    c.itemsSum += items;
    c.itemsMax = Math.max(c.itemsMax, items);
    out.records += 1;
    out.bytes += bytes;
  }
  for (const c of Object.values(out.classes)) {
    finishStat(c);
    c.attackersAvg = c.count > 0 ? round2(c.attackersSum / c.count) : 0;
    c.itemsAvg = c.count > 0 ? round2(c.itemsSum / c.count) : 0;
  }
  const metaRow = db.get(`SELECT json, length(CAST(json AS BLOB)) AS bytes FROM ${quoteIdent(T_KILLMAILS)} `
    + "WHERE key = '_meta'");
  if (metaRow) {
    out.meta.bytes = toNum(metaRow.bytes);
    const meta = parseRow(metaRow.json, ctx.warnings, `${T_KILLMAILS}._meta`);
    const ids = meta && meta.terminalEventKillIDs && typeof meta.terminalEventKillIDs === "object"
      ? Object.keys(meta.terminalEventKillIDs) : [];
    out.meta.terminalEventKillIDs = ids.length;
    out.meta.terminalEventKillIDsLne = ids.filter((k) => k.startsWith("lne:")).length;
  }
  return out;
}

function receiptKeyOf(rec, rowKey) {
  if (rec && typeof rec.receiptKey === "string") return rec.receiptKey;
  const suffix = String(rowKey).slice(RECEIPT_GROUP.length + 1);
  try {
    return decodeURIComponent(suffix);
  } catch (_err) {
    return suffix;
  }
}

function sectionItems(db, ctx) {
  const out = { receipts: { rows: 0, bytes: 0, classes: {} }, outcomes: {}, items: { rows: 0, bytes: 0 } };
  for (const row of iterateGroup(db, T_ITEMS, RECEIPT_GROUP)) {
    const bytes = toNum(row.bytes);
    const rec = parseRow(row.json, ctx.warnings, T_ITEMS);
    const cls = receiptClass(receiptKeyOf(rec, row.key));
    if (!out.receipts.classes[cls]) out.receipts.classes[cls] = newStat();
    addStat(out.receipts.classes[cls], bytes, ctx.now, rec ? toNum(rec.completedAtMs) || 0 : 0);
    out.receipts.rows += 1;
    out.receipts.bytes += bytes;
  }
  Object.values(out.receipts.classes).forEach(finishStat);
  const total = aggregate(db, T_ITEMS);
  let groupRows = out.receipts.rows;
  let groupBytes = out.receipts.bytes;
  for (const g of OUTCOME_GROUPS) {
    const a = aggregate(db, T_ITEMS, g);
    out.outcomes[g] = { rows: a.rows, bytes: a.bytes };
    groupRows += a.rows;
    groupBytes += a.bytes;
  }
  out.items = { rows: total.rows - groupRows, bytes: total.bytes - groupBytes };
  return out;
}

function sectionMail(db, ctx) {
  const out = { messages: newStat(), senders: { npc: 0, other: 0 }, mailboxes: null, mailingLists: null };
  if (ctx.lneChars) out.senders.lne = 0;
  for (const row of iterateGroup(db, T_MAIL, "messages")) {
    const bytes = toNum(row.bytes);
    const rec = parseRow(row.json, ctx.warnings, T_MAIL);
    addStat(out.messages, bytes, ctx.now, rec ? toMs(rec.sentDate) : 0);
    const sender = rec && isPosId(rec.senderID) ? Number(rec.senderID) : 0;
    if (ctx.lneChars && ctx.lneChars.has(sender)) out.senders.lne += 1;
    else if (sender > 0 && sender < NPC_ID_MAX) out.senders.npc += 1;
    else out.senders.other += 1;
  }
  finishStat(out.messages);
  for (const g of ["mailboxes", "mailingLists"]) {
    const a = aggregate(db, T_MAIL, g);
    out[g] = { rows: a.rows, bytes: a.bytes };
  }
  return out;
}

function sectionNotifications(db, ctx) {
  const out = { boxes: 0, bytes: 0, notifications: 0, perBoxAvg: 0, perBoxMax: 0, topTypeIDs: [], age: newAges() };
  const types = new Map();
  for (const row of iterateGroup(db, T_NOTIFICATIONS, "boxes")) {
    out.boxes += 1;
    out.bytes += toNum(row.bytes);
    const box = parseRow(row.json, ctx.warnings, T_NOTIFICATIONS);
    const byID = box && box.byID && typeof box.byID === "object" ? Object.values(box.byID) : [];
    out.notifications += byID.length;
    out.perBoxMax = Math.max(out.perBoxMax, byID.length);
    for (const n of byID) {
      const typeID = n && isPosId(n.typeID) ? Number(n.typeID) : 0;
      types.set(typeID, (types.get(typeID) || 0) + 1);
      addAge(out.age, ctx.now, n ? toMs(n.created) : 0);
    }
  }
  out.perBoxAvg = out.boxes > 0 ? round2(out.notifications / out.boxes) : 0;
  out.topTypeIDs = [...types.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, TOP_TYPE_IDS)
    .map(([typeID, count]) => ({ typeID, count }));
  return out;
}

function sectionNpc(db, ctx, tables) {
  const out = { tables: {}, wrecks: null };
  for (const t of NPC_TABLES) {
    if (!isStoreTable(tables, t)) continue;
    const a = aggregate(db, t);
    out.tables[t] = { rows: a.rows, bytes: a.bytes };
  }
  if (!isStoreTable(tables, T_WRECKS)) return out;
  const w = { count: 0, expired: 0, age: newAges() };
  const add = (rec) => {
    if (!rec || typeof rec !== "object") return;
    w.count += 1;
    addAge(w.age, ctx.now, toNum(rec.createdAtMs) || 0);
    const exp = toNum(rec.expiresAtMs) || 0;
    if (exp > 0 && exp < ctx.now) w.expired += 1;
  };
  for (const row of db.iterate(`SELECT key, json FROM ${quoteIdent(T_WRECKS)}`)) {
    if (row.key === "wrecks") {
      const map = parseRow(row.json, ctx.warnings, T_WRECKS);
      if (map && typeof map === "object") Object.values(map).forEach(add);
    } else if (String(row.key).startsWith(`wrecks${ROW_KEY_SEP}`)) {
      add(parseRow(row.json, ctx.warnings, T_WRECKS));
    }
  }
  out.wrecks = w;
  return out;
}

function readLneCharacters(wdb, wtables, warnings) {
  const ids = new Set();
  for (const src of LNE_CHARACTER_SOURCES) {
    const cols = wtables.get(src.table);
    const needed = [src.column, ...(src.needs || [])];
    if (!cols || needed.some((c) => !cols.has(c))) {
      warnings.push(`lne characters: ${src.table}.${needed.join("/")} missing, skipped`);
      continue;
    }
    const sql = `SELECT ${quoteIdent(src.column)} AS v FROM ${quoteIdent(src.table)} WHERE ${quoteIdent(src.column)} `
      + `IS NOT NULL${src.where ? ` AND ${src.where}` : ""}`;
    for (const r of wdb.iterate(sql)) {
      if (src.json) {
        let list = null;
        try {
          list = JSON.parse(r.v);
        } catch (_err) {
          list = null;
        }
        if (Array.isArray(list)) for (const id of list) if (isPosId(id)) ids.add(Number(id));
      } else if (isPosId(r.v)) ids.add(Number(toNum(r.v)));
    }
  }
  return ids;
}

function readLneSites(wdb, wtables, warnings) {
  const cols = wtables.get("world_event_sites");
  if (!cols || !cols.has("site_key") || !cols.has("state")) {
    warnings.push("lne sites: world_event_sites.site_key/state missing, orphans not counted");
    return null;
  }
  const map = new Map();
  for (const r of wdb.iterate("SELECT site_key, state FROM world_event_sites")) map.set(String(r.site_key), r.state);
  return map;
}

function defaultNow(db, tables, file) {
  if (isStoreTable(tables, T_DUNGEON)) {
    const r = db.get(`SELECT MAX(CAST(json_extract(json, '$.timers.lastUpdatedAtMs') AS INTEGER)) AS t FROM `
      + `${quoteIdent(T_DUNGEON)} WHERE key >= ? AND key < ?`, ...groupRange("instancesByID"));
    const t = r ? toNum(r.t) : 0;
    if (t > 0) return { now: t, source: "dungeon.lastUpdatedAtMs" };
  }
  if (isStoreTable(tables, T_KILLMAILS)) {
    const r = db.get(`SELECT MAX(json_extract(json, '$.killTime')) AS t FROM ${quoteIdent(T_KILLMAILS)} `
      + "WHERE key >= ? AND key < ?", ...groupRange("records"));
    const t = r ? toMs(r.t) : 0;
    if (t > 0) return { now: t, source: "killmails.killTime" };
  }
  return { now: Math.floor(fs.statSync(file).mtimeMs), source: "file.mtime" };
}

function buildReport(opts) {
  const started = Date.now();
  let rssMax = process.memoryUsage().rss;
  const sample = () => {
    rssMax = Math.max(rssMax, process.memoryUsage().rss);
  };
  const warnings = [...opts.driver.warnings];
  const db = openReadOnly(opts.driver, opts.file);
  let wdb = null;
  try {
    const tables = listTables(db);
    const ctx = { warnings, now: 0, lneChars: null, lneSites: null };
    if (opts.world) {
      wdb = openReadOnly(opts.driver, opts.world);
      const wtables = listTables(wdb);
      ctx.lneChars = readLneCharacters(wdb, wtables, warnings);
      ctx.lneSites = readLneSites(wdb, wtables, warnings);
    }
    let nowSource = "--now";
    if (opts.now !== null) ctx.now = opts.now;
    else {
      const d = defaultNow(db, tables, opts.file);
      ctx.now = d.now;
      nowSource = d.source;
    }
    const report = { v: REPORT_VERSION, meta: null, tables: sectionTables(db, tables, opts.top), dungeon: null,
      killmails: null, items: null, mail: null, notifications: null, npc: null, missing: [] };
    sample();
    const run = (name, table, fn) => {
      if (!isStoreTable(tables, table)) {
        report.missing.push(table);
        return;
      }
      report[name] = fn();
      sample();
    };
    run("dungeon", T_DUNGEON, () => sectionDungeon(db, ctx));
    run("killmails", T_KILLMAILS, () => sectionKillmails(db, ctx));
    run("items", T_ITEMS, () => sectionItems(db, ctx));
    run("mail", T_MAIL, () => sectionMail(db, ctx));
    run("notifications", T_NOTIFICATIONS, () => sectionNotifications(db, ctx));
    report.npc = sectionNpc(db, ctx, tables);
    for (const t of NPC_TABLES) if (!isStoreTable(tables, t)) report.missing.push(t);
    if (report.dungeon && report.dungeon.instances === 0) report.missing.push(`${T_DUNGEON}.instancesByID`);
    if (report.killmails && report.killmails.records === 0) report.missing.push(`${T_KILLMAILS}.records`);
    if (report.mail && report.mail.messages.count === 0) report.missing.push(`${T_MAIL}.messages`);
    if (report.notifications && report.notifications.boxes === 0) report.missing.push(`${T_NOTIFICATIONS}.boxes`);
    sample();
    report.meta = { gamestore: path.basename(opts.file), world: opts.world ? path.basename(opts.world) : null,
      now: ctx.now, nowSource, driver: opts.driver.name, runMs: Date.now() - started, rssMaxBytes: rssMax,
      lneCharacters: ctx.lneChars ? ctx.lneChars.size : null, warnings };
    return report;
  } finally {
    db.close();
    if (wdb) wdb.close();
  }
}

const mb = (bytes) => (bytes / 1048576).toFixed(2);
const ageText = (a) => `${a.lt1d}/${a.d1to7}/${a.d7to30}/${a.gt30d}/${a.unknown}`;

function renderReport(r) {
  const L = [];
  L.push(`# heapGrowthReport ${r.meta.gamestore}`, "");
  L.push(`now ${r.meta.now} (${isoOf(r.meta.now)}, ${r.meta.nowSource}), driver ${r.meta.driver}, `
    + `${r.meta.runMs} ms, rss max ${mb(r.meta.rssMaxBytes)} MB, world ${r.meta.world || "-"}, `
    + `LNE characters ${r.meta.lneCharacters === null ? "-" : r.meta.lneCharacters}`, "");
  L.push("Age columns: <1d / 1-7d / 7-30d / >30d / unknown.", "");
  L.push(`## tables (${r.tables.count} tables, ${r.tables.totalRows} rows, ${mb(r.tables.totalJsonBytes)} MB JSON)`, "");
  L.push("| table | rows | JSON MB | max row KB |", "|---|---:|---:|---:|");
  for (const name of r.tables.top) {
    const t = r.tables.byName[name];
    L.push(`| ${name} | ${t.rows} | ${mb(t.jsonBytes)} | ${(t.maxRowBytes / 1024).toFixed(1)} |`);
  }
  L.push("");
  if (r.dungeon) {
    const d = r.dungeon;
    L.push(`## dungeon (${d.instances} instances, ${mb(d.bytes)} MB, persistent systems ${d.persistentSystems})`, "");
    L.push(`LNE: ${d.lne.instances} instances, ${mb(d.lne.bytes)} MB, staleActive ${d.lne.staleActive}, terminalOld `
      + `${d.lne.terminalOld}, orphans ${d.lne.orphans ? `${d.lne.orphans.noRow} no row + ${d.lne.orphans.purgedRow} `
        + `PURGED (${mb(d.lne.orphans.bytes)} MB)` : "- (no --world)"}, lne_foreign ${d.foreignAlarm}`, "");
    L.push("| class | lifecycle | persistent | count | MB | avg KB | max KB | age |", "|---|---|---|---:|---:|---:|---:|---|");
    for (const b of Object.values(d.buckets).sort((x, y) => y.bytes - x.bytes)) {
      L.push(`| ${b.class} | ${b.lifecycleState} | ${b.universePersistent ? "yes" : "no"} | ${b.count} | ${mb(b.bytes)} `
        + `| ${(b.avgBytes / 1024).toFixed(1)} | ${(b.maxBytes / 1024).toFixed(1)} | ${ageText(b.age)} |`);
    }
    L.push("", "| top instance | class | template | KB | largest spawnState keys (KB) |", "|---|---|---|---:|---|");
    for (const t of d.top) {
      L.push(`| ${t.instanceID} | ${t.class} | ${t.templateID} | ${(t.bytes / 1024).toFixed(1)} | `
        + `${t.spawnStateTopKeys.map((k) => `${k.key} ${(k.bytes / 1024).toFixed(1)}`).join(", ")} |`);
    }
    L.push("");
  }
  if (r.killmails) {
    const k = r.killmails;
    L.push(`## killmails (${k.records} records, ${mb(k.bytes)} MB, pending ${k.pending})`, "");
    L.push(`_meta ${(k.meta.bytes / 1024).toFixed(1)} KB, terminalEventKillIDs ${k.meta.terminalEventKillIDs} `
      + `(lne: ${k.meta.terminalEventKillIDsLne})`, "");
    L.push("| class | count | MB | avg KB | attackers avg/max | items avg/max | age |", "|---|---:|---:|---:|---|---|---|");
    for (const [cls, c] of Object.entries(k.classes)) {
      L.push(`| ${cls} | ${c.count} | ${mb(c.bytes)} | ${(c.avgBytes / 1024).toFixed(1)} | ${c.attackersAvg}/`
        + `${c.attackersMax} | ${c.itemsAvg}/${c.itemsMax} | ${ageText(c.age)} |`);
    }
    L.push("");
  }
  if (r.items) {
    const i = r.items;
    L.push(`## items (receipts ${i.receipts.rows} rows ${mb(i.receipts.bytes)} MB, items ${i.items.rows} rows `
      + `${mb(i.items.bytes)} MB)`, "");
    L.push("| receipt prefix | count | MB | age |", "|---|---:|---:|---|");
    for (const [cls, c] of Object.entries(i.receipts.classes)) {
      L.push(`| ${cls} | ${c.count} | ${mb(c.bytes)} | ${ageText(c.age)} |`);
    }
    for (const [g, o] of Object.entries(i.outcomes)) L.push(`| ${g} | ${o.rows} | ${mb(o.bytes)} | - |`);
    L.push("");
  }
  if (r.mail) {
    const m = r.mail;
    L.push(`## mail (messages ${m.messages.count}, ${mb(m.messages.bytes)} MB, age ${ageText(m.messages.age)})`, "");
    L.push(`senders: npc ${m.senders.npc}, ${m.senders.lne === undefined ? "" : `lne ${m.senders.lne}, `}other `
      + `${m.senders.other}; mailboxes ${m.mailboxes.rows} (${mb(m.mailboxes.bytes)} MB), mailingLists `
      + `${m.mailingLists.rows} (${mb(m.mailingLists.bytes)} MB)`, "");
  }
  if (r.notifications) {
    const n = r.notifications;
    L.push(`## notifications (${n.boxes} boxes, ${mb(n.bytes)} MB, ${n.notifications} notifications, per box avg `
      + `${n.perBoxAvg} max ${n.perBoxMax}, age ${ageText(n.age)})`, "");
    L.push(`top typeID: ${n.topTypeIDs.map((t) => `${t.typeID}x${t.count}`).join(", ") || "-"}`, "");
  }
  L.push("## npc", "");
  for (const [t, a] of Object.entries(r.npc.tables)) L.push(`- ${t}: ${a.rows} rows, ${mb(a.bytes)} MB`);
  if (r.npc.wrecks) {
    L.push(`- wrecks: ${r.npc.wrecks.count}, expired ${r.npc.wrecks.expired}, age ${ageText(r.npc.wrecks.age)}`);
  }
  L.push("", `missing: ${r.missing.join(", ") || "-"}`);
  if (r.meta.warnings.length > 0) L.push("", "warnings:", ...r.meta.warnings.map((w) => `- ${w}`));
  return L.join("\n");
}

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (prefix === "" && (k === "meta" || k === "v")) continue;
    const p = prefix === "" ? k : `${prefix}.${k}`;
    if (typeof v === "number" && Number.isFinite(v)) out.set(p, v);
    else if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, p, out);
  }
  return out;
}

function diffReports(a, b) {
  const nowA = a && a.meta ? Number(a.meta.now) : NaN;
  const nowB = b && b.meta ? Number(b.meta.now) : NaN;
  if (!Number.isFinite(nowA) || !Number.isFinite(nowB)) return { ok: false, reason: "NOT_A_REPORT", detail: "meta.now" };
  if (nowB <= nowA) return { ok: false, reason: "NOT_LATER", detail: `b.now ${nowB} <= a.now ${nowA}` };
  const days = (nowB - nowA) / DAY_MS;
  const fa = flatten(a, "", new Map());
  const fb = flatten(b, "", new Map());
  const keys = [...new Set([...fa.keys(), ...fb.keys()])].sort();
  const rows = keys.map((key) => {
    const va = fa.get(key) || 0;
    const vb = fb.get(key) || 0;
    const delta = vb - va;
    return { key, a: va, b: vb, delta, perDay: round2(delta / days) };
  });
  return { ok: true, diff: { v: REPORT_VERSION, aNow: nowA, bNow: nowB, days: round2(days),
    aFile: a.meta.gamestore || null, bFile: b.meta.gamestore || null, rows } };
}

const isBytesKey = (key) => /bytes$/i.test(key) && !/max/i.test(key) && !/avg/i.test(key);
const isCountKey = (key) => /\.(rows|count|instances|records|boxes|notifications|noRow|purgedRow|staleActive|terminalOld|pending)$/
  .test(key);

function renderDiff(d) {
  const L = [`# heapGrowthReport --diff (${d.days} days: ${isoOf(d.aNow)} -> ${isoOf(d.bNow)})`, ""];
  const table = (title, filter, fmt) => {
    L.push(`## ${title}`, "", "| key | a | b | delta | per day |", "|---|---:|---:|---:|---:|");
    const picked = d.rows.filter((r) => filter(r.key) && r.delta !== 0).sort((x, y) => y.delta - x.delta)
      .slice(0, DIFF_TOP);
    for (const r of picked) L.push(`| ${r.key} | ${fmt(r.a)} | ${fmt(r.b)} | ${fmt(r.delta)} | ${fmt(r.perDay)} |`);
    L.push("");
  };
  table(`top ${DIFF_TOP} byte growth (MB)`, isBytesKey, (v) => mb(v));
  table(`top ${DIFF_TOP} count growth`, isCountKey, (v) => String(v));
  return L.join("\n");
}

function isLiveVolume(p) {
  const raw = String(p).replace(/\\/g, "/");
  const resolved = path.resolve(p).replace(/\\/g, "/");
  return raw.startsWith(LIVE_VOLUME_PREFIX) || resolved.startsWith(LIVE_VOLUME_PREFIX)
    || /^[A-Za-z]:\/var\/lib\/evejs\//.test(resolved);
}

function parseArgs(argv, defaultServerDir) {
  const args = argv.slice();
  const o = { ok: true, file: null, world: null, serverDir: defaultServerDir, now: null, json: null, top: DEFAULT_TOP,
    diff: null };
  const value = (flag) => {
    if (args.length === 0) throw new Error(`${flag} needs a value`);
    return args.shift();
  };
  try {
    while (args.length > 0) {
      const a = args.shift();
      if (a === "--world") o.world = value(a);
      else if (a === "--server") o.serverDir = path.resolve(value(a));
      else if (a === "--json") o.json = value(a);
      else if (a === "--now" || a === "--top") {
        const n = Number(value(a));
        if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${a} needs a positive integer`);
        if (a === "--now" && !isValidDateMs(n)) throw new Error(`--now ${n} is not a valid date in ms`);
        if (a === "--now") o.now = n;
        else o.top = n;
      } else if (a === "--diff") o.diff = [value(a), value(a)];
      else if (a.startsWith("--")) throw new Error(`unknown argument ${a}`);
      else if (o.file === null) o.file = a;
      else throw new Error(`extra argument ${a}`);
    }
  } catch (err) {
    return { ok: false, reason: "USAGE", detail: messageOf(err) };
  }
  if ((o.file === null) === (o.diff === null)) return { ok: false, reason: "USAGE", detail: "give a file or --diff" };
  return o;
}

function refuseInputs(files) {
  for (const f of files) {
    if (isLiveVolume(f)) return `refused: ${f} is under ${LIVE_VOLUME_PREFIX} (live volume); use a copy from _backup`;
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return `refused: ${f} does not exist`;
  }
  return null;
}

const SQLITE_SIDECARS = Object.freeze(["", "-wal", "-shm", "-journal"]);

function samePathKey(p, platform = process.platform) {
  const resolved = path.resolve(p);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function outputClash(outFile, inputs, platform = process.platform) {
  const out = samePathKey(outFile, platform);
  for (const input of inputs) {
    for (const suffix of SQLITE_SIDECARS) {
      if (samePathKey(`${input}${suffix}`, platform) === out) return `${input}${suffix}`;
    }
  }
  return null;
}

function main(argv, deps = {}) {
  const print = deps.print || ((text) => process.stdout.write(`${text}\n`));
  const warn = deps.warn || ((text) => process.stderr.write(`${text}\n`));
  const o = parseArgs(argv, deps.serverDir !== undefined ? deps.serverDir : findServerDir(__dirname));
  if (!o.ok) {
    warn(`${USAGE}\n${o.detail}`);
    return 1;
  }
  const inputs = o.diff ? o.diff : [o.file, ...(o.world ? [o.world] : [])];
  const refusal = refuseInputs(inputs);
  if (refusal) {
    warn(refusal);
    return 2;
  }
  if (o.json && isLiveVolume(o.json)) {
    warn(`refused: --json ${o.json} is under ${LIVE_VOLUME_PREFIX}`);
    return 2;
  }
  const clash = o.json ? outputClash(o.json, inputs) : null;
  if (clash) {
    warn(`${USAGE}\n--json ${o.json} would overwrite the input ${clash}`);
    return 1;
  }
  let result;
  let markdown;
  if (o.diff) {
    let a;
    let b;
    try {
      a = JSON.parse(fs.readFileSync(o.diff[0], "utf8"));
      b = JSON.parse(fs.readFileSync(o.diff[1], "utf8"));
    } catch (err) {
      warn(`refused: ${messageOf(err)}`);
      return 2;
    }
    const d = diffReports(a, b);
    if (!d.ok) {
      warn(`refused: ${d.reason} ${d.detail}`);
      return 2;
    }
    result = d.diff;
    markdown = renderDiff(result);
  } else {
    const driver = loadDriver(o.serverDir);
    if (!driver.ok) {
      warn(`${driver.reason}: ${driver.detail}`);
      return 3;
    }
    try {
      result = buildReport({ driver, file: o.file, world: o.world, now: o.now, top: o.top });
    } catch (err) {
      warn(`read failed: ${messageOf(err)}`);
      return 3;
    }
    markdown = renderReport(result);
  }
  const json = JSON.stringify(result, null, 2);
  if (o.json) {
    fs.writeFileSync(o.json, `${json}\n`);
    print(markdown);
  } else {
    print(`${markdown}\n\n\`\`\`json\n${json}\n\`\`\``);
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, parseArgs, findServerDir, loadDriver, buildReport, diffReports, renderReport, renderDiff, originOf,
  killmailClass, receiptClass, toMs, isLiveVolume, outputClash, LNE_CHARACTER_SOURCES };
