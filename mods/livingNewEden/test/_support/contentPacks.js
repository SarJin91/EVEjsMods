"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PACK_DIR = path.resolve(__dirname, "..", "..", "..", "..", "content-packs");

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function findPack(name, dir = PACK_DIR) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (_err) {
    return null;
  }
  const re = new RegExp(`^evejs-${escapeRegExp(name)}-(\\d+)\\.(\\d+)\\.(\\d+)\\.json$`);
  let best = null;
  for (const file of files) {
    const m = re.exec(file);
    if (!m) continue;
    const version = m.slice(1, 4).map(Number);
    if (!best || compareVersions(version, best.version) > 0) best = { version, file };
  }
  return best ? path.join(dir, best.file) : null;
}

function packLabel(name) {
  return `content pack evejs-${name}-<version>.json`;
}

function authoredTemplates(file) {
  const pack = JSON.parse(fs.readFileSync(file, "utf8"));
  const templates = (pack.payload && pack.payload.dungeon && pack.payload.dungeon.templatesByID) || {};
  const out = new Map();
  for (const [id, t] of Object.entries(templates)) {
    out.set(id, t && t.dedAuthoring && typeof t.dedAuthoring === "object" ? { ...t, ...t.dedAuthoring } : t);
  }
  return out;
}

function isNativeRef(value) {
  return Boolean(value && typeof value === "object" && typeof value.$combatNative === "string");
}

module.exports = { PACK_DIR, findPack, packLabel, authoredTemplates, isNativeRef };
