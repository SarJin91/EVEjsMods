"use strict";

const rules = require("./rules");

const TYPE_ANSIBLEX = 35841;
const INSTALL_REASONS = Object.freeze(["NOT_ANSIBLEX", "ALREADY_INSTALLED", "NO_ALLIANCE", "NOT_OWNER", "NO_ROLE",
  "PAIR_LIMIT", "SAME_SYSTEM", "PARTNER_TOO_FAR"]);
const MAIL_KINDS = Object.freeze(["INSTALLED", "LINKED", "REFUSED"]);
const SAMPLE_MASSES = Object.freeze([
  Object.freeze({ label: "frigate (1.2e6 kg)", massKg: 1200000 }),
  Object.freeze({ label: "battleship (1e8 kg)", massKg: 100000000 }),
  Object.freeze({ label: "freighter (1e9 kg)", massKg: 1000000000 }),
  Object.freeze({ label: "titan (1.48e9 kg)", massKg: 1480000000 }),
]);
const MAIL_BREAK = "<br>";
const DIAG_RE = /^!\s*trigbridge(?:\s+(\S+))?\s*$/i;
const KEY_INSTALL_PREFIX = "lne:tbr:install:";
const KEY_MAIL_PREFIX = "tbr:mail:";
const LY_DECIMALS = 2;
const FILETIME_SCALE = 10000n;
const FILETIME_EPOCH_OFFSET = 116444736000000000n;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const markerOf = (row) => row.devFlags.lneTrigBridge;

function installKeyOf(structureId) {
  return `${KEY_INSTALL_PREFIX}${structureId}`;
}

function mailKeyOf(structureId, kind, partnerId) {
  return `${KEY_MAIL_PREFIX}${structureId}:${kind}:${isId(partnerId) ? partnerId : 0}`;
}

function markedViewOf(rows) {
  const marked = (Array.isArray(rows) ? rows : []).filter((r) => r && rules.isTrigMarker(r) && r.typeId === TYPE_ANSIBLEX);
  return marked.map((r) => {
    const partner = marked.find((q) => q.structureId !== r.structureId && q.allianceId === r.allianceId
      && q.systemId === r.destinationSystemId && q.destinationSystemId === r.systemId && r.systemId !== q.systemId);
    const m = markerOf(r);
    return { structureId: r.structureId, systemId: r.systemId, systemName: r.systemName || "",
      allianceId: r.allianceId, destinationSystemId: r.destinationSystemId, installedAt: m.installedAt,
      installedBy: m.installedBy, linked: Boolean(partner), partnerId: partner ? partner.structureId : null };
  });
}

function choosePartner(markedOfAlliance) {
  const free = (Array.isArray(markedOfAlliance) ? markedOfAlliance : []).filter((m) => m && m.linked !== true);
  free.sort(byAge);
  return free.length > 0 ? free[0] : null;
}

function byAge(a, b) {
  return (a.installedAt - b.installedAt) || (a.structureId - b.structureId);
}

function planPairs(marked, lyOf, maxRangeLy) {
  const free = (Array.isArray(marked) ? marked : []).filter((m) => m && m.linked !== true).sort(byAge);
  const used = new Set();
  const partial = [];
  for (const a of free) {
    if (used.has(a)) continue;
    const b = free.find((q) => q !== a && !used.has(q) && q.systemId === a.destinationSystemId
      && q.systemId !== a.systemId);
    if (b) {
      partial.push([a, b]);
      used.add(a);
      used.add(b);
    }
  }
  const rest = free.filter((m) => !used.has(m));
  const pairs = [];
  const unpaired = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (used.has(a)) continue;
    const b = rest.slice(i + 1).find((q) => !used.has(q) && q.systemId !== a.systemId
      && pairLyOf(a, q, lyOf) <= maxRangeLy);
    if (b) {
      pairs.push([a, b]);
      used.add(b);
    } else {
      unpaired.push(a);
    }
    used.add(a);
  }
  return { partial, pairs, unpaired };
}

function pairLyOf(a, b, lyOf) {
  const ly = typeof lyOf === "function" ? lyOf(a.systemId, b.systemId) : NaN;
  return Number.isFinite(ly) ? ly : NaN;
}

function decideInstall(input) {
  const { structure, hasRole, sameCorp, allianceId, markedOfAlliance, lyOf, cfg, now } = input || {};
  if (!structure || structure.typeId !== TYPE_ANSIBLEX) return { ok: false, reason: "NOT_ANSIBLEX" };
  if (structure.devFlags && structure.devFlags.lneTrigBridge) return { ok: false, reason: "ALREADY_INSTALLED" };
  if (!isId(allianceId)) return { ok: false, reason: "NO_ALLIANCE" };
  if (sameCorp !== true) return { ok: false, reason: "NOT_OWNER" };
  if (cfg.requireRole === true && hasRole !== true) return { ok: false, reason: "NO_ROLE" };
  const marked = Array.isArray(markedOfAlliance) ? markedOfAlliance : [];
  if (marked.length >= 2 * cfg.maxPairsPerAlliance) {
    return { ok: false, reason: "PAIR_LIMIT", detail: `${marked.length}/${2 * cfg.maxPairsPerAlliance}` };
  }
  if (!choosePartner(marked)) return { ok: true, partner: null };
  const self = { structureId: structure.structureId, systemId: structure.systemId,
    destinationSystemId: structure.destinationSystemId, installedAt: Number.isFinite(now) ? now : Infinity,
    linked: false };
  const plan = planPairs([...marked, self], lyOf, cfg.maxRangeLy);
  const mine = [...plan.partial, ...plan.pairs].find((p) => p[0] === self || p[1] === self);
  if (mine) {
    const partner = mine[0] === self ? mine[1] : mine[0];
    return { ok: true, partner: { structureId: partner.structureId, systemId: partner.systemId } };
  }
  const left = plan.unpaired.filter((m) => m !== self);
  if (left.length === 0) return { ok: true, partner: null };
  const other = left[0];
  if (other.systemId === structure.systemId) return { ok: false, reason: "SAME_SYSTEM" };
  const realLy = pairLyOf(self, other, lyOf);
  return { ok: false, reason: "PARTNER_TOO_FAR",
    detail: Number.isFinite(realLy) ? `${realLy.toFixed(LY_DECIMALS)} LY > ${cfg.maxRangeLy} LY` : "no position" };
}

function installRefusalText(reason, detail) {
  const texts = {
    NOT_ANSIBLEX: "A Triglavian Conduit Core fits only an Ansiblex Jump Bridge",
    ALREADY_INSTALLED: "This Ansiblex already carries a Triglavian Conduit Core",
    NO_ALLIANCE: "A Triglavian conduit needs an Ansiblex of an alliance",
    NOT_OWNER: "You can install a Triglavian Conduit Core only on a bridge of your own corporation",
    NO_ROLE: "You need the Station Manager or Director role to install a Triglavian Conduit Core",
    PAIR_LIMIT: "Your alliance already has its Triglavian conduit pairs",
    SAME_SYSTEM: "The other Triglavian bridge of your alliance is in this system",
    PARTNER_TOO_FAR: "The other Triglavian bridge of your alliance is too far away",
  };
  if (reason === "MARKER_PENDING") {
    return "The Triglavian conduit install did not finish. Deposit a core on this bridge again: "
      + "it finishes the install and is not consumed a second time.";
  }
  const base = texts[reason] || "The Triglavian Conduit Core could not be installed now";
  const extra = reason === "PARTNER_TOO_FAR" && detail ? ` (${detail})` : "";
  return `${base}${extra}. The core stays in your cargo hold.`;
}

function systemLabel(s) {
  if (!s) return "-";
  return s.systemName ? `${s.systemName} (${s.systemId})` : String(s.systemId);
}

function mailBodyOf(kind, facts) {
  const f = facts || {};
  const lines = [];
  const here = systemLabel(f.structure);
  if (kind === "REFUSED") {
    lines.push(`The Triglavian Conduit Core was not installed on the Ansiblex in ${here}.`,
      installRefusalText(f.reason, f.detail));
    return { title: "Triglavian conduit: install refused", body: lines.join(MAIL_BREAK) };
  }
  if (kind === "INSTALLED") {
    lines.push(`The Triglavian Conduit Core is installed on the Ansiblex in ${here}.`);
    if (!f.partner) {
      lines.push(`Install a second core on another Ansiblex of your alliance (at most ${f.maxRangeLy} LY away): `
        + "the two bridges link themselves.");
    } else {
      lines.push(`It links now with the Triglavian bridge in ${systemLabel(f.partner)}: the details follow in the`
        + " mail \"Triglavian conduit linked\".");
    }
    return { title: "Triglavian conduit installed", body: lines.join(MAIL_BREAK) };
  }
  lines.push(`The Triglavian bridges in ${here} and ${systemLabel(f.partner)} are linked.`);
  if (f.partner) {
    const realLy = Number.isFinite(f.realLy) ? f.realLy : 0;
    const effLy = rules.effectiveLy(realLy, f.fuelLyPermille, rules.VENDOR_RANGE_LY);
    lines.push(`Link: ${here} <-> ${systemLabel(f.partner)}, ${realLy.toFixed(LY_DECIMALS)} LY `
      + `(Liquid Ozone as for ${effLy.toFixed(LY_DECIMALS)} LY).`, "Liquid Ozone per jump:");
    for (const s of SAMPLE_MASSES) lines.push(`- ${s.label}: ${rules.estimateOzone(rules.effectiveMassKg(s.massKg), effLy)}`);
  }
  return { title: "Triglavian conduit linked", body: lines.join(MAIL_BREAK) };
}

function parseDiagCommand(text) {
  const m = DIAG_RE.exec(String(text === undefined || text === null ? "" : text).trim());
  if (!m) return null;
  return m[1] && m[1].toLowerCase() === "status" ? { cmd: "status" } : { cmd: "usage" };
}

function filetimeOf(ms) {
  return (BigInt(Math.max(0, Math.trunc(ms))) * FILETIME_SCALE + FILETIME_EPOCH_OFFSET).toString();
}

module.exports = { TYPE_ANSIBLEX, INSTALL_REASONS, MAIL_KINDS, SAMPLE_MASSES, DIAG_RE, KEY_INSTALL_PREFIX,
  KEY_MAIL_PREFIX, installKeyOf, mailKeyOf, markedViewOf, choosePartner, planPairs, decideInstall, installRefusalText, mailBodyOf,
  parseDiagCommand, filetimeOf };
