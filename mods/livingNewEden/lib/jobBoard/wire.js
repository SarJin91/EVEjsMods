"use strict";

const WIRE_VERSION = 1;
const LEN = Object.freeze({ sysName: 32, title: 80, reward: 60, progress: 24, mine: 24, state: 16, kind: 16, ref: 48,
  refusal: 40, nearRef: 64, nearKind: 24, src: 8, level: 10, frontLine: 96, newsTitle: 100, nick: 37, seen: 40,
  wantedKind: 13, wantedReward: 16 });
const MAX_REFUSALS = 9;
const COMBINING = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, "g");
const L_STROKE_LOWER = new RegExp(String.fromCharCode(0x0142), "g");
const L_STROKE_UPPER = new RegExp(String.fromCharCode(0x0141), "g");
const MS_PER_SECOND = 1000;
const PIN_MAX = 2;

function asciiText(value, max) {
  const text = String(value ?? "").replace(/[^\x20-\x7e]/g, "?");
  return text.length > max ? text.slice(0, max) : text;
}

function asciiFold(value, max) {
  const text = String(value ?? "").normalize("NFD").replace(COMBINING, "").replace(L_STROKE_LOWER, "l")
    .replace(L_STROKE_UPPER, "L");
  return asciiText(text, max);
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : fallback;
}

function jobOf(row) {
  return { ref: asciiText(row.ref, LEN.ref), kind: asciiText(row.kind, LEN.kind),
    title: asciiText(row.title, LEN.title), sys: toInt(row.sys), sysName: asciiText(row.sysName, LEN.sysName),
    jumps: toInt(row.jumps, -1), reward: asciiText(row.reward, LEN.reward),
    progress: asciiText(row.progress, LEN.progress), mine: asciiText(row.mine, LEN.mine),
    endsIn: Math.max(0, toInt(row.endsIn)), state: asciiText(row.state, LEN.state),
    pin: Math.min(PIN_MAX, Math.max(0, toInt(row.pin))) };
}

function warOf(row) {
  return { ref: asciiText(row.ref, LEN.ref), contractId: Math.max(0, toInt(row.contractId)),
    title: asciiText(row.title, LEN.title), sys: toInt(row.sys), sysName: asciiText(row.sysName, LEN.sysName),
    jumps: toInt(row.jumps, -1), reward: asciiText(row.reward, LEN.reward), endsIn: Math.max(0, toInt(row.endsIn)) };
}

function nearOf(row) {
  return { ref: asciiText(row.ref, LEN.nearRef), src: asciiText(row.src, LEN.src),
    kind: asciiText(row.kind, LEN.nearKind), title: asciiText(row.title, LEN.title), sys: toInt(row.sys),
    sysName: asciiText(row.sysName, LEN.sysName), jumps: toInt(row.jumps, -1), level: asciiText(row.level, LEN.level),
    scan: row.scan === true, reward: asciiText(row.reward, LEN.reward), endsIn: Math.max(0, toInt(row.endsIn)),
    state: asciiText(row.state, LEN.state) };
}

function wantedOf(row) {
  const seen = row.seen && typeof row.seen === "object" ? row.seen : null;
  return { nick: asciiFold(row.nick, LEN.nick), lv: Math.max(0, toInt(row.level)),
    rw: asciiText(row.reward, LEN.wantedReward), sm: row.smuggler === true,
    seen: seen ? asciiFold(seen.name, LEN.seen) : "", kind: seen ? asciiText(seen.kind, LEN.wantedKind) : "",
    age: seen && row.ageS !== null && row.ageS !== undefined ? Math.max(0, toInt(row.ageS)) : -1,
    j: seen && row.jumps !== null && row.jumps !== undefined ? Math.max(0, toInt(row.jumps)) : -1,
    sid: seen && toInt(row.systemId) > 0 ? toInt(row.systemId) : -1 };
}

function toWireV1(snapshot, ui) {
  const s = snapshot || {};
  const withMine = Array.isArray(s.mine);
  const wire = {
    v: WIRE_VERSION,
    at: Math.floor(toInt(s.now) / MS_PER_SECOND),
    sys: toInt(s.sys),
    sysName: asciiText(s.sysName, LEN.sysName),
    ui: { pollMs: Math.max(0, toInt(ui && ui.pollMs)), travel: Boolean(ui && ui.travel === true),
      contracts: Boolean(ui && ui.contracts === true), pins: Boolean(ui && ui.pins === true) },
    jobs: (Array.isArray(s.jobs) ? s.jobs : []).map(jobOf),
    wars: (Array.isArray(s.wars) ? s.wars : []).map(warOf),
    more: { jobs: Math.max(0, toInt(s.more && s.more.jobs)), wars: Math.max(0, toInt(s.more && s.more.wars)) },
    refusals: (Array.isArray(s.refusals) ? s.refusals : []).slice(0, MAX_REFUSALS)
      .map((r) => asciiText(r, LEN.refusal)),
  };
  if (withMine) {
    wire.mine = s.mine.map(jobOf);
    wire.more.mine = Math.max(0, toInt(s.more && s.more.mine));
  }
  if (Array.isArray(s.near)) {
    wire.near = s.near.map(nearOf);
    wire.more.near = Math.max(0, toInt(s.more && s.more.near));
  }
  if (s.front && Array.isArray(s.front.lines)) {
    wire.front = { sys: toInt(s.front.sys), lines: s.front.lines.map((l) => asciiFold(l, LEN.frontLine)) };
  }
  if (s.news && typeof s.news === "object") {
    const maxText = Math.max(0, toInt(s.news.maxChars));
    wire.news = { seq: toInt(s.news.seq), title: asciiFold(s.news.title, LEN.newsTitle),
      text: asciiFold(s.news.text, maxText), ageS: Math.max(0, toInt(s.news.ageS)) };
  }
  if (s.wanted && typeof s.wanted === "object") {
    const w = s.wanted;
    const levels = Array.isArray(w.byLevel) ? w.byLevel : [];
    wire.wanted = { s: [Math.max(0, toInt(w.total)), ...levels.map((n) => Math.max(0, toInt(n)))],
      n: (Array.isArray(w.near) ? w.near : []).map(wantedOf), t: (Array.isArray(w.top) ? w.top : []).map(wantedOf),
      m: Math.max(0, toInt(w.more)) };
  }
  return wire;
}

module.exports = { WIRE_VERSION, LEN, MAX_REFUSALS, asciiText, asciiFold, toInt, toWireV1 };
