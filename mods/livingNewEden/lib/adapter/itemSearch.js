"use strict";

const MAX_NAME_CHARS = 80;
const WEIGHT = Object.freeze({ NAME: 3, GROUP: 2, CATEGORY: 1, RACE: 1, WHOLE_GROUP: 1 });
const BLUEPRINT_PENALTY = 2;
const PARTIAL_MIN_WORDS = 3;
const PLURAL_MIN_CHARS = 3;
const CATEGORY_BLUEPRINT = 9;
const FALLBACK_SIZE = 1;
const ALIASES = Object.freeze(new Map([["bp", "blueprint"], ["bpc", "blueprint"], ["bpo", "blueprint"]]));
const RACES = Object.freeze(new Map([[1, "caldari"], [2, "minmatar"], [4, "amarr"], [8, "gallente"], [32, "jove"],
  [64, "concord"], [128, "ore"], [256, "triglavian"], [512, "edencom"]]));
const CATEGORIES = Object.freeze(new Map([[2, "celestial"], [3, "station"], [4, "material"], [5, "accessories"],
  [6, "ship"], [7, "module"], [8, "charge"], [9, "blueprint"], [16, "skill"], [17, "commodity"], [18, "drone"],
  [20, "implant"], [22, "deployable"], [23, "starbase"], [25, "asteroid"], [32, "subsystem"], [65, "structure"],
  [66, "structure module"], [87, "fighter"]]));

const words = (text) => {
  const n = String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return n === "" ? [] : n.split(" ");
};
const queryWords = (text) => [...new Set(words(text).map((w) => ALIASES.get(w) || w))];

const hits = (q, t) => t.startsWith(q) || (q.length > PLURAL_MIN_CHARS && q.endsWith("s") && t === q.slice(0, -1));
const hitsAny = (q, list) => list.some((t) => hits(q, t));
const same = (q, t) => q === t || (q.length > PLURAL_MIN_CHARS && q.endsWith("s") && t === q.slice(0, -1));

const indexes = new WeakMap();

function indexOf(registry) {
  const cached = indexes.get(registry);
  if (cached) return cached;
  if (!registry || typeof registry.listItemTypes !== "function") return null;
  const list = registry.listItemTypes();
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const e of list) {
    const typeId = Number(e && e.typeID);
    if (!Number.isSafeInteger(typeId) || typeId <= 0 || e.published === false || typeof e.name !== "string") continue;
    const name = e.name.trim();
    if (name === "") continue;
    const cat = Number(e.categoryID);
    const vol = Number(e.volume);
    const groupName = typeof e.groupName === "string" && e.groupName.trim() !== "" ? e.groupName.trim() : null;
    out.push({ typeId, name: name.slice(0, MAX_NAME_CHARS), n: words(name), g: words(groupName),
      c: words(CATEGORIES.get(cat)), r: words(RACES.get(Number(e.raceID))),
      groupName: groupName === null ? null : groupName.slice(0, MAX_NAME_CHARS),
      categoryId: Number.isSafeInteger(cat) && cat > 0 ? cat : null,
      volume: e.volume !== null && e.volume !== undefined && Number.isFinite(vol) && vol >= 0 ? vol : null });
  }
  if (out.length > FALLBACK_SIZE) indexes.set(registry, out);
  return out;
}

function scoreOf(entry, qs) {
  let matched = 0;
  let named = 0;
  let score = 0;
  for (const q of qs) {
    const w = hitsAny(q, entry.n) ? WEIGHT.NAME : hitsAny(q, entry.g) ? WEIGHT.GROUP
      : hitsAny(q, entry.c) ? WEIGHT.CATEGORY : hitsAny(q, entry.r) ? WEIGHT.RACE : 0;
    if (w > 0) matched += 1;
    if (w === WEIGHT.NAME) named += 1;
    score += w;
  }
  const byName = named === qs.length;
  if (entry.g.length > 0 && entry.g.every((t) => qs.some((q) => same(q, t)))) score += WEIGHT.WHOLE_GROUP;
  if (entry.categoryId === CATEGORY_BLUEPRINT && !qs.includes(CATEGORIES.get(CATEGORY_BLUEPRINT))) {
    score -= BLUEPRINT_PENALTY;
  }
  return { matched, score, byName };
}

function searchItemTypesFrom(registry, query, maxRows) {
  try {
    const index = indexOf(registry);
    if (!index) return { ok: false, reason: "SEAM_UNAVAILABLE" };
    const qs = queryWords(query);
    const rows = Number.isSafeInteger(maxRows) && maxRows > 0 ? maxRows : 1;
    if (qs.length === 0) return { ok: true, matched: "none", candidates: [], more: 0 };
    const full = [];
    const partial = [];
    for (const e of index) {
      const s = scoreOf(e, qs);
      if (s.matched === qs.length) full.push({ e, score: s.score, byName: s.byName });
      else if (qs.length >= PARTIAL_MIN_WORDS && s.matched === qs.length - 1) {
        partial.push({ e, score: s.score, byName: false });
      }
    }
    const pick = full.length > 0 ? full : partial;
    pick.sort((a, b) => b.score - a.score || a.e.name.length - b.e.name.length
      || (a.e.name < b.e.name ? -1 : a.e.name > b.e.name ? 1 : a.e.typeId - b.e.typeId));
    const seen = new Set();
    const unique = pick.filter((x) => (seen.has(x.e.name) ? false : seen.add(x.e.name)));
    return { ok: true, matched: full.length > 0 ? "all" : partial.length > 0 ? "partial" : "none",
      candidates: unique.slice(0, rows).map(({ e, byName }) => ({ typeId: e.typeId, name: e.name,
        groupName: e.groupName, categoryId: e.categoryId, volume: e.volume, byName })),
      more: Math.max(0, unique.length - rows) };
  } catch (_err) {
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }
}

module.exports = { searchItemTypesFrom };
