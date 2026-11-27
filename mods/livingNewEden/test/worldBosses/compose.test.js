"use strict";

const assert = require("node:assert");
const fs = require("node:fs");

const config = require("../../config");
const { findCompose, readCompose } = require("../config/composeKeys.test");

module.exports = ({ test, skip }) => {
  const composeFile = findCompose();
  if (!composeFile) {
    skip("WBCOMP world boss compose keys", "compose.yaml not found above the mod (Docker image)");
    return;
  }
  test("WBCOMP compose: every worldBosses.* SCHEMA key has a ${NAME:-} line, booleans:-0, others", () => {
    const text = fs.readFileSync(composeFile, "utf8");
    const { env } = readCompose(composeFile);
    const rows = config.SCHEMA.filter((row) => row.key.startsWith("worldBosses."));
    assert.ok(rows.length >= 70, `worldBosses.* SCHEMA rows: ${rows.length}`);
    const missing = rows.filter((row) => !Object.prototype.hasOwnProperty.call(env, row.env)).map((row) => row.env);
    assert.deepStrictEqual(missing, [], `missing in compose env: ${missing.join(", ")}`);
    const wrong = rows.filter((row) => {
      const want = row.type === "boolean" ? `\${${row.env}:-0}` : `\${${row.env}:-}`;
      return !text.includes(`${row.env}: ${want}`);
    }).map((row) => row.env);
    assert.deepStrictEqual(wrong, [], `compose default other than :-0 (flag) / :- : ${wrong.join(", ")}`);
  });
};
