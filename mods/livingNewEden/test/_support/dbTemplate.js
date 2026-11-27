"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { MIGRATIONS, runMigrations } = require("../../lib/persistence/migrations");

const TEMPLATE_DEFAULT_SEED = 1;
const TEMPLATE_DIR_PREFIX = "lne-tpl-";
const TEMPLATE_FILE_EXT = ".sqlite";

let templateDir = null;
const files = new Map();

function cacheKey(migrations, seed) {
  return `${migrations.map((m) => `${m.version}:${m.name}`).join("|")}#${seed}`;
}

function ensureDir() {
  if (templateDir) return templateDir;
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMPLATE_DIR_PREFIX));
  process.once("exit", () => {
    try {
      fs.rmSync(templateDir, { recursive: true, force: true });
    } catch (_err) {
    }
  });
  return templateDir;
}

function templateFile(driver, { migrations = MIGRATIONS, seed = TEMPLATE_DEFAULT_SEED } = {}) {
  const key = cacheKey(migrations, seed);
  const cached = files.get(key);
  if (cached) return cached;
  const file = path.join(ensureDir(), `t${files.size}${TEMPLATE_FILE_EXT}`);
  const db = new driver.Database(file);
  try {
    db.pragma("journal_mode = WAL");
    const migrated = runMigrations(db, migrations, { randomSeed: () => seed });
    if (!migrated.ok) throw new Error(`template migration failed: ${JSON.stringify(migrated)}`);
  } finally {
    db.close();
  }
  if (fs.existsSync(`${file}-wal`)) throw new Error(`template left a WAL file: ${file}-wal`);
  files.set(key, file);
  return file;
}

function seedDbFile(driver, filePath, opts) {
  if (fs.existsSync(filePath)) return false;
  fs.copyFileSync(templateFile(driver, opts), filePath);
  return true;
}

module.exports = { TEMPLATE_DEFAULT_SEED, templateFile, seedDbFile };
