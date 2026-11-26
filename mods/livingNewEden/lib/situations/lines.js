"use strict";

const MAX_LINE = 160;

const SETS = Object.freeze({
  DISTRESS: Object.freeze([
    "Pirates jumped us at {belt}, need help!",
    "Mayday, {belt} in {system}: pirates on our mining ships, anyone around?",
    "Still under fire at {belt}. Please, anyone in {system}?",
    "We can't hold them at {belt} much longer. Help!",
  ]),
  THANKS: Object.freeze([
    "Thank you, pilots! You saved us at {belt}. We won't forget this.",
    "The pirates are gone from {belt}. Thanks for the help, o7",
    "Saved at {belt}. Drinks are on us next time you dock in {system}.",
  ]),
  LOST: Object.freeze([
    "They got us at {belt}. Nobody came...",
    "Lost the ships at {belt}. Stay safe out there in {system}.",
  ]),
  DISTRESS_GATE: Object.freeze([
    "Pirates on us at {anchor}, our haulers are taking fire!",
    "Mayday at {anchor} in {system}, anyone near the gate?",
    "Still under fire at {anchor}. We need help, {system}!",
  ]),
  THANKS_GATE: Object.freeze([
    "Cleared {anchor}, thank you pilots. Jumping out now, o7",
    "You saved our cargo at {anchor}. Thanks, pilots!",
  ]),
  LOST_GATE: Object.freeze([
    "They got our haulers at {anchor}...",
    "Lost the convoy at {anchor}. Fly safe in {system}.",
  ]),
  DISTRESS_POD: Object.freeze([
    "My ship blew up near {anchor}. Stuck in my pod, can anyone pick me up?",
    "Still floating near {anchor} in {system}, pod only, please",
    "Anyone in {system}? Pod pilot near {anchor} needs a lift.",
  ]),
  THANKS_POD: Object.freeze([
    "Thanks for the lift! Docking with you beats floating near {anchor}.",
    "Picked up at last. Thank you, pilot, o7",
  ]),
});

const LINE_SETS = Object.freeze(Object.keys(SETS));

function cleanValue(value, fallback) {
  const s = typeof value === "string" ? value.replace(/[^\x20-\x7e]/g, "").trim() : "";
  return (s === "" ? fallback : s).slice(0, 60);
}

function renderLine(set, index, vars) {
  const lines = Object.prototype.hasOwnProperty.call(SETS, set) ? SETS[set] : null;
  if (!lines || !Number.isSafeInteger(index) || index < 0) return { ok: false, reason: "INVALID_INPUT" };
  const v = vars && typeof vars === "object" ? vars : {};
  const belt = cleanValue(v.belt, "the belt");
  const system = cleanValue(v.system, "this system");
  const text = lines[index % lines.length].replace(/\{belt\}/g, belt).replace(/\{anchor\}/g, belt)
    .replace(/\{system\}/g, system);
  return { ok: true, text: text.slice(0, MAX_LINE) };
}

function beltLabelOf(name, ordinal) {
  const s = typeof name === "string" ? name.replace(/[^\x20-\x7e]/g, "").trim() : "";
  if (s !== "") return s.slice(0, 60);
  return `Belt ${Number.isSafeInteger(ordinal) && ordinal > 0 ? ordinal : 1}`;
}

function gateLabelOf(name) {
  const s = typeof name === "string" ? name.replace(/[^\x20-\x7e]/g, "").trim() : "";
  return s !== "" ? s.slice(0, 60) : "the gate";
}

module.exports = { SETS, LINE_SETS, MAX_LINE, renderLine, beltLabelOf, gateLabelOf };
