"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { STYLE_KEYS } = require("./styles");
const { nameKey, isValidCharacterName, MAX_NAME_LENGTH } = require("./validate");
const NICKNAMES = require("./data/nicknames");

const DATA = Object.freeze({
  caldari: require("./data/caldari"),
  minmatar: require("./data/minmatar"),
  amarr: require("./data/amarr"),
  gallente: require("./data/gallente"),
  triglavian: require("./data/triglavian"),
});

const RNG_STREAM = "npcname";
const ATTEMPTS_PER_TIER = 8;
const TIER_COUNT = 4;
const TIER_MIDDLE = 1;
const TIER_DOUBLE_LAST = 2;
const TIER_NICKNAME = 3;
const GENDERS = Object.freeze(["Male", "Female"]);

function pickOther(rng, list, not) {
  const i = Math.floor(rng.nextFloat() * list.length);
  return list[i] === not ? list[(i + 1) % list.length] : list[i];
}

function validParams(p) {
  return Boolean(p && typeof p === "object" && Number.isInteger(p.worldSeed)
    && typeof p.entityKey === "string" && p.entityKey !== "" && Number.isInteger(p.attempt) && p.attempt >= 0
    && STYLE_KEYS.includes(p.style) && GENDERS.includes(p.gender));
}

function candidateAt(p) {
  const data = DATA[p.style];
  const firsts = p.gender === "Female" ? data.female : data.male;
  const rng = createRng(deriveSeed(p.worldSeed, RNG_STREAM, p.entityKey, p.attempt));
  const first = rng.pick(firsts);
  const lastName = rng.pick(data.last);
  const base = `${first} ${lastName}`;
  const tier = Math.floor(p.attempt / ATTEMPTS_PER_TIER) % TIER_COUNT;
  let name = base;
  if (tier === TIER_MIDDLE) {
    name = `${first} ${pickOther(rng, firsts, first)} ${lastName}`;
  } else if (tier === TIER_DOUBLE_LAST || tier === TIER_NICKNAME) {
    let pattern = tier;
    if (tier === TIER_DOUBLE_LAST) {
      name = `${first} ${lastName}-${pickOther(rng, data.last, lastName)}`;
      if (name.length > MAX_NAME_LENGTH) pattern = TIER_NICKNAME;
    }
    if (pattern === TIER_NICKNAME) {
      name = p.nicknames === true
        ? `${first} '${rng.pick(NICKNAMES)}' ${lastName}`
        : `${first} ${pickOther(rng, firsts, first)} ${lastName}`;
    }
  }
  return isValidCharacterName(name).ok ? name : base;
}

function pickName(p) {
  const start = p && p.startAttempt !== undefined ? p.startAttempt : 0;
  if (!validParams({ ...(p || {}), attempt: start }) || typeof p.isTaken !== "function"
    || !Number.isInteger(p.maxAttempts) || p.maxAttempts < 1) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  for (let attempt = start; attempt < p.maxAttempts; attempt += 1) {
    const name = candidateAt({ worldSeed: p.worldSeed, entityKey: p.entityKey, attempt, style: p.style,
      nicknames: p.nicknames === true, gender: p.gender });
    if (isValidCharacterName(name).ok && p.isTaken(nameKey(name)) !== true) return { ok: true, name, attempt };
  }
  return { ok: false, reason: "NAME_UNAVAILABLE" };
}

module.exports = { candidateAt, pickName, DATA, NICKNAMES, ATTEMPTS_PER_TIER, RNG_STREAM };
