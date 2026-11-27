"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { readCharacterStandingFrom } = require("../../lib/adapter/standingRead");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");

function functionBody(source, name) {
  const start = source.search(new RegExp(`^function ${name}\\(`, "m"));
  assert.ok(start >= 0, `${name} declared`);
  const rest = source.slice(start);
  return rest.slice(0, rest.search(/^\}/m));
}

function vendorFake(rows) {
  return {
    state: { peekCharacterRecord: (id) => (id === 140000008 ? { characterID: id } : null) },
    runtime: {
      getCharacterRawStandingFromRecord(record, ownerID, characterID) {
        if (!record) return null;
        return rows.find((r) => r.fromID === ownerID && r.toID === characterID) || null;
      },
    },
  };
}

module.exports = ({ test }) => {
  test("SR1 readCharacterStandingFrom: vendor row shape -> row.standing; missing row 0; number tolerated; non-finite 0", () => {
    const v = vendorFake([
      { fromID: 500004, toID: 140000008, standing: 4.5 },
      { fromID: 500011, toID: 140000008, standing: -0.001 },
      { fromID: 500010, toID: 140000008, standing: NaN },
    ]);
    const read = (owner) => readCharacterStandingFrom(v.state, v.runtime, 140000008, owner);
    assert.deepStrictEqual(read(500004), { ok: true, found: true, standing: 4.5 });
    assert.deepStrictEqual(read(500011), { ok: true, found: true, standing: -0.001 });
    assert.deepStrictEqual(read(500001), { ok: true, found: true, standing: 0 }, "no row -> 0");
    assert.deepStrictEqual(read(500010), { ok: true, found: true, standing: 0 }, "non-finite -> 0");
    assert.deepStrictEqual(readCharacterStandingFrom(v.state, v.runtime, 7, 500004),
      { ok: true, found: false, standing: 0 }, "no record");
    const num = { getCharacterRawStandingFromRecord: () => -6 };
    assert.strictEqual(readCharacterStandingFrom(v.state, num, 140000008, 500004).standing, -6, "bare number tolerated");
    const inf = { getCharacterRawStandingFromRecord: () => ({ fromID: 1, toID: 2, standing: Infinity }) };
    assert.strictEqual(readCharacterStandingFrom(v.state, inf, 140000008, 500004).standing, 0, "Infinity -> 0");
  });

  test("SR2 vendor fact: getCharacterRawStandingFromRecord returns the row; getCharacterRawStanding reads row.standing", () => {
    const src = fs.readFileSync(path.join(SERVER_SRC, "services", "character", "standingRuntime.js"), "utf8");
    const rawBody = functionBody(src, "getCharacterRawStandingFromRecord");
    assert.ok(/return directMatch;/.test(rawBody), "returns the matched row object");
    assert.ok(/entry\.fromID === normalizedOwnerID/.test(rawBody), "matches rows by fromID");
    const readerBody = functionBody(src, "getCharacterRawStanding");
    assert.ok(/row\s*\?\s*clampStanding\(row\.standing\)/.test(readerBody), "vendor reads row.standing");
    const normBody = functionBody(src, "normalizeStandingEntry");
    assert.ok(/standing:\s*clampStanding\(entry\.standing\)/.test(normBody), "row carries a numeric standing field");
  });
};
