"use strict";

const ID_PREFIXES = Object.freeze(["fleet", "op", "battle", "event", "journal", "settle", "mt", "pj", "cv", "st",
  "sg", "to", "tp", "hp", "ts", "lc", "ct", "cc", "wx", "ps", "di"]);
const ID_PATTERN = /^[a-z]+_[0-9a-z]+_[0-9a-z]{4,}_[0-9a-z]{4}$/;
const RADIX = 36;
const COUNTER_WIDTH = 4;
const SUFFIX_WIDTH = 4;
const SUFFIX_RANGE = RADIX ** SUFFIX_WIDTH;

function createIdGenerator(deps) {
  const clock = deps && deps.clock;
  const rng = deps && deps.rng;
  if (!clock || typeof clock.now !== "function") throw new TypeError("createIdGenerator: deps.clock.now() required");
  if (!rng || typeof rng.nextUint32 !== "function") throw new TypeError("createIdGenerator: deps.rng.nextUint32() required");
  let counter = 0;

  function next(prefix) {
    if (!ID_PREFIXES.includes(prefix)) throw new Error(`unknown id prefix "${prefix}"`);
    counter += 1;
    const time = clock.now().toString(RADIX);
    const count = counter.toString(RADIX).padStart(COUNTER_WIDTH, "0");
    const suffix = (rng.nextUint32() % SUFFIX_RANGE).toString(RADIX).padStart(SUFFIX_WIDTH, "0");
    return `${prefix}_${time}_${count}_${suffix}`;
  }

  return Object.freeze({ next, getCounter: () => counter });
}

function isId(value, prefix) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) return false;
  const head = value.slice(0, value.indexOf("_"));
  if (!ID_PREFIXES.includes(head)) return false;
  return prefix === undefined || head === prefix;
}

module.exports = { ID_PREFIXES, ID_PATTERN, createIdGenerator, isId };
