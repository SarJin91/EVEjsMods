"use strict";

const assert = require("node:assert");
const fs = require("node:fs");

const config = require("../../config");
const { findCompose, readCompose } = require("../config/composeKeys.test");

module.exports = ({ test, skip }) => {
  const composeFile = findCompose();
  if (!composeFile) {
    skip("ARC1 archaeology compose keys", "compose.yaml not found above the mod (Docker image)");
    return;
  }
  test("ARC1 compose: every archaeology.* SCHEMA key has a ${NAME:-...} line, flags (default false) :-0", () => {
    const text = fs.readFileSync(composeFile, "utf8");
    const { env } = readCompose(composeFile);
    const rows = config.SCHEMA.filter((row) => row.key.startsWith("archaeology."));
    assert.ok(rows.length >= 24, `archaeology.* SCHEMA rows: ${rows.length}`);
    const missing = rows.filter((row) => !Object.prototype.hasOwnProperty.call(env, row.env)).map((row) => row.env);
    assert.deepStrictEqual(missing, [], `missing in compose env: ${missing.join(", ")}`);
    const noDefault = rows.filter((row) => !text.includes(`\${${row.env}:-`)).map((row) => row.env);
    assert.deepStrictEqual(noDefault, [], `no \${NAME:-} line: ${noDefault.join(", ")}`);
    const flags = rows.filter((row) => row.type === "boolean" && row.default === false);
    assert.ok(flags.some((row) => row.key === "archaeology.enabled"), "archaeology.enabled is a flag");
    const wrong = flags.filter((row) => env[row.env] !== "0").map((row) => `${row.env}=${env[row.env]}`);
    assert.deepStrictEqual(wrong, [], `flags without :-0: ${wrong.join(", ")}`);
  });
};
