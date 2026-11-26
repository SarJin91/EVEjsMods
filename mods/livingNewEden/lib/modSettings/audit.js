"use strict";

const fs = require("node:fs");
const path = require("node:path");

const AUDIT_FILE_NAME = "settings-audit.jsonl";
const ROTATED_SUFFIX = ".1";

function auditPathOf(dataDir) {
  return path.join(String(dataDir), AUDIT_FILE_NAME);
}

function createAudit(deps) {
  const f = (deps && deps.fsApi) || fs;
  const filePath = String(deps && deps.filePath);
  const maxBytes = deps && deps.maxBytes;

  function sizeOf() {
    try {
      return f.statSync(filePath).size;
    } catch (err) {
      if (err && err.code === "ENOENT") return 0;
      throw err;
    }
  }

  function append(record) {
    try {
      let rotated = false;
      if (sizeOf() >= maxBytes) {
        const old = `${filePath}${ROTATED_SUFFIX}`;
        f.rmSync(old, { force: true });
        f.renameSync(filePath, old);
        rotated = true;
      }
      f.mkdirSync(path.dirname(filePath), { recursive: true });
      f.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
      return { ok: true, rotated };
    } catch (err) {
      return { ok: false, reason: "AUDIT_FAILED", detail: `${AUDIT_FILE_NAME}: ${(err && err.code) || "error"}` };
    }
  }

  return Object.freeze({ append });
}

module.exports = { AUDIT_FILE_NAME, ROTATED_SUFFIX, auditPathOf, createAudit };
