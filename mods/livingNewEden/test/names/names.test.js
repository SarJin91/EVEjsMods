"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const names = require("../../lib/names");
const { BANNED } = require("../../lib/chatterAi/data/bannedWords");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SEED = 1234567;
const GENDERS = ["Male", "Female"];
const MIN_SIZES = Object.freeze({ caldari: [200, 200, 300], minmatar: [200, 200, 300], amarr: [200, 200, 300],
  gallente: [200, 200, 300], triglavian: [120, 120, 200] });

function bannedHits(word) {
  const w = word.toLowerCase();
  const hits = [];
  for (const lang of Object.keys(BANNED)) {
    for (const cat of Object.keys(BANNED[lang])) {
      for (const e of BANNED[lang][cat]) {
        const hit = e.startsWith("*") && e.endsWith("*") ? w.includes(e.slice(1, -1))
          : e.endsWith("*") ? w.startsWith(e.slice(0, -1)) : w === e;
        if (hit) hits.push(e);
      }
    }
  }
  return hits;
}

function sweep() {
  const out = [];
  for (const style of names.STYLE_KEYS) {
    for (const gender of GENDERS) {
      for (let i = 0; i < 3000; i += 1) {
        out.push(names.candidateAt({ worldSeed: SEED, entityKey: `f:500001:corp:${i % 7}:char:${i}`, attempt: i % 48,
          style, nicknames: i % 2 === 0, gender }));
      }
    }
  }
  return out;
}

module.exports = ({ test, skip }) => {
  test("N1 lib/names: 5 styles x 2 genders x 3000 keys (attempts 0..47) valid, no digit, deterministic", () => {
    const first = sweep();
    const bad = first.filter((n) => !names.isValidCharacterName(n).ok || /[0-9]/.test(n));
    assert.deepStrictEqual(bad, []);
    assert.ok(first.some((n) => / '[A-Za-z]+' /.test(n)), "a nickname appears");
    assert.ok(first.some((n) => /^\S+ \S+-\S+$/.test(n)), "a double surname appears");
    assert.ok(first.some((n) => /^\S+ [A-Za-z]+ \S+$/.test(n)), "a middle name appears");
    assert.deepStrictEqual(sweep(), first, "second run identical");
    assert.strictEqual(names.isValidCharacterName("Renard Moreau 2").reason, "DIGIT");
    assert.strictEqual(names.isValidCharacterName("GM Someone").reason, "RESERVED");
  });

  test("N2 lib/names: candidate 0 taken -> another name without a digit; all taken -> NAME_UNAVAILABLE", () => {
    const base = { worldSeed: SEED, entityKey: "f:500004:corp:0:char:3", style: "gallente", nicknames: false,
      gender: "Male", maxAttempts: 48 };
    const c0 = names.candidateAt({ ...base, attempt: 0 });
    const r = names.pickName({ ...base, isTaken: (key) => key === names.nameKey(c0) });
    assert.ok(r.ok && r.name !== c0 && r.attempt >= 1 && !/[0-9]/.test(r.name), JSON.stringify(r));
    assert.deepStrictEqual(names.pickName({ ...base, isTaken: () => true }), { ok: false, reason: "NAME_UNAVAILABLE" });
    assert.deepStrictEqual(names.pickName({ ...base, gender: "x", isTaken: () => false }),
      { ok: false, reason: "INVALID_INPUT" });
  });

  test("N3 lib/names: list sizes, no duplicates, no banned word, charset; 5000 characters 0 x unavailable",
    () => {
      const problems = [];
      const check = (label, list, re) => {
        const seen = new Set();
        for (const w of list) {
          if (seen.has(w.toLowerCase())) problems.push(`${label} duplicate ${w}`);
          seen.add(w.toLowerCase());
          if (!re.test(w)) problems.push(`${label} charset ${w}`);
          const hits = bannedHits(w);
          if (hits.length > 0) problems.push(`${label} banned ${w} (${hits.join(",")})`);
        }
      };
      for (const style of names.STYLE_KEYS) {
        const d = names.DATA[style];
        const [m, f, l] = MIN_SIZES[style];
        if (d.male.length < m || d.female.length < f || d.last.length < l) {
          problems.push(`${style} sizes ${d.male.length}/${d.female.length}/${d.last.length} < ${m}/${f}/${l}`);
        }
        for (const k of ["male", "female", "last"]) check(`${style}.${k}`, d[k], /^[A-Za-z'-]{2,14}$/);
      }
      if (names.NICKNAMES.length < 100) problems.push(`nicknames ${names.NICKNAMES.length} < 100`);
      check("nicknames", names.NICKNAMES, /^[A-Za-z]{2,14}$/);
      assert.deepStrictEqual(problems, []);

      const taken = new Set();
      let unavailable = 0;
      for (let i = 0; i < 5000; i += 1) {
        const r = names.pickName({ worldSeed: SEED, entityKey: `f:500026:corp:${i % 50}:char:${i}`, style: "triglavian",
          nicknames: false, gender: i % 2 === 0 ? "Male" : "Female", isTaken: (key) => taken.has(key), maxAttempts: 48 });
        if (r.ok) taken.add(names.nameKey(r.name)); else unavailable += 1;
      }
      assert.strictEqual(unavailable, 0);
      assert.strictEqual(taken.size, 5000);
    });

  test("N5 vendor fact: characterNameRuntime exports and name rules (EveJS 261108.1)", () => {
    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    if (!found.ok) return skip("N5 vendor fact", "no server/src");
    const text = fs.readFileSync(path.join(found.srcDir, "services", "character", "characterNameRuntime.js"), "utf8");
    const exportsBlock = /module\.exports\s*=\s*\{([\s\S]*?)\};/.exec(text);
    assert.ok(exportsBlock, "module.exports block");
    for (const name of ["getExistingCharacterNameKeys", "validateCharacterName", "VALIDATION_CODE",
      "getValidRandomName"]) {
      assert.ok(new RegExp(`\\b${name}\\b`).test(exportsBlock[1]), `export ${name}`);
    }
    assert.match(text, /const MAX_CHARACTER_NAME_LENGTH = 37;/);
    assert.match(text, /const MAX_SPACE_COUNT = 2;/);
    assert.match(text, /PROTECTED_NAME_PREFIXES = Object\.freeze\(\["ccp ", "gm ", "isd "\]\)/);
    assert.match(text, /VALIDATION_CODE = Object\.freeze\(\{\s*VALID: 1,/);
    return undefined;
  });
};
