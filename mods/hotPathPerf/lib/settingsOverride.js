"use strict";

const fs = require("node:fs");
const path = require("node:path");

const OVERRIDE_FILE_NAME = "settings.override.json";
const IGNORE_ENV = "EVEJS_MOD_SETTINGS_OVERRIDES_IGNORE";
const OVERRIDE_SCHEMA_VERSION = 1;

function overridePathOf(dataDir) {
  return path.join(String(dataDir), OVERRIDE_FILE_NAME);
}

function readOverrideFile(filePath, env) {
  const result = (values, revision, present, ignored, warnings) => ({ ok: true, values, revision, present, ignored,
    warnings });
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  try {
    if (env && env[IGNORE_ENV] === "1") {
      return result({}, 0, false, true, [`${OVERRIDE_FILE_NAME} ignored - ${IGNORE_ENV}=1`]);
    }
    let text;
    try {
      text = fs.readFileSync(String(filePath), "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") return result({}, 0, false, false, []);
      return result({}, 0, true, false, [`${OVERRIDE_FILE_NAME}: cannot read (${(err && err.code) || "error"}) - ignored`]);
    }
    let doc;
    try {
      doc = JSON.parse(String(text).charCodeAt(0) === 0xfeff ? String(text).slice(1) : String(text));
    } catch (_err) {
      return result({}, 0, true, false, [`${OVERRIDE_FILE_NAME}: not valid JSON - ignored`]);
    }
    if (!isObject(doc)) return result({}, 0, true, false, [`${OVERRIDE_FILE_NAME}: root is not an object - ignored`]);
    if (doc.schemaVersion !== OVERRIDE_SCHEMA_VERSION) {
      return result({}, 0, true, false,
        [`${OVERRIDE_FILE_NAME}: schemaVersion is not ${OVERRIDE_SCHEMA_VERSION} - ignored`]);
    }
    const revision = Number.isSafeInteger(doc.revision) && doc.revision >= 0 ? doc.revision : 0;
    if (!isObject(doc.values)) {
      return result({}, revision, true, false, [`${OVERRIDE_FILE_NAME}: values is not an object - ignored`]);
    }
    return result(Object.fromEntries(Object.entries(doc.values)), revision, true, false, []);
  } catch (err) {
    return result({}, 0, true, false, [`${OVERRIDE_FILE_NAME}: unreadable (${(err && err.message) || err}) - ignored`]);
  }
}

module.exports = { OVERRIDE_FILE_NAME, IGNORE_ENV, OVERRIDE_SCHEMA_VERSION, overridePathOf, readOverrideFile };
