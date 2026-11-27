"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { DED_TEMPLATES, EXCLUDED_ESCALATION_TEMPLATES } = require("../../lib/escalations/catalog");
const { findPack, packLabel, authoredTemplates, isNativeRef } = require("../_support/contentPacks");

const DED_PACK = findPack("ded-rated-sites");
const PIRATE_POLICY = path.resolve(__dirname, "..", "..", "..", "..", "server", "src", "space", "npc",
  "pirateFactionPolicy.js");
const MAX_LABEL_LENGTH = 64;
const UNKNOWN_FACTION = 500021;
const ROGUE_DRONES = 500025;

module.exports = ({ test, skip }) => {
  const name = "ESP2 DED catalog vs pack: 48 unique sorted entries, each with the pack faction key, dedRating, "
    + "siteKind signature, securityBands containing bands, a native name; the 2 escalation templates left out";
  if (DED_PACK === null || !fs.existsSync(PIRATE_POLICY)) {
    skip(name, `${packLabel("ded-rated-sites")} or server/src pirateFactionPolicy.js not found`);
    return;
  }
  test(name, () => {
    assert.strictEqual(DED_TEMPLATES.length, 48);
    const ids = DED_TEMPLATES.map((t) => t.templateId);
    assert.strictEqual(new Set(ids).size, 48, "unique IDs");
    assert.deepStrictEqual(ids, [...ids].sort(), "sorted by templateId");
    const policy = fs.readFileSync(PIRATE_POLICY, "utf8").replace(/\r\n/g, "\n");
    const keyOf = (factionId) => {
      const id = factionId === UNKNOWN_FACTION ? ROGUE_DRONES : factionId;
      const m = new RegExp(`\\n {2}${id}: "([a-z_]+)",`).exec(policy);
      return m ? m[1] : null;
    };
    assert.ok(policy.includes("tags rogue drone, Sleeper and several event sites with the generic\n// \"Unknown\" "
      + "faction (500021)"), "the client tags rogue drone sites with 500021");
    const templates = authoredTemplates(DED_PACK);
    const problems = [];
    for (const t of DED_TEMPLATES) {
      const h = templates.get(t.templateId);
      if (!h) {
        problems.push(`${t.templateId} missing`);
        continue;
      }
      const bands = Array.isArray(h.securityBands) ? h.securityBands : [];
      const ok = h.siteKind === "signature" && h.factionKey === keyOf(t.factionId) && h.factionKey !== null
        && isNativeRef(h.factionID) && h.dedRating === t.dedRating
        && t.bands.length > 0 && t.bands.every((b) => bands.includes(b)) && isNativeRef(h.resolvedName)
        && t.name.length <= MAX_LABEL_LENGTH;
      if (!ok) {
        problems.push(`${t.templateId} kind=${h.siteKind} key=${h.factionKey} ded=${h.dedRating} bands=${bands}`);
      }
    }
    for (const id of EXCLUDED_ESCALATION_TEMPLATES) {
      const h = templates.get(id);
      if (!h || h.siteKind !== "escalation") problems.push(`${id} is not an escalation`);
      if (ids.includes(id)) problems.push(`${id} in the catalog`);
    }
    const packDed = [...templates.entries()].filter(([, t]) => Number.isInteger(t.dedRating)).map(([id]) => id);
    assert.deepStrictEqual([...packDed].sort(), [...ids, ...EXCLUDED_ESCALATION_TEMPLATES].sort());
    assert.deepStrictEqual(problems, []);
  });
};
