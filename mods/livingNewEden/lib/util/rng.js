"use strict";

const UINT32_RANGE = 0x100000000;
const MULBERRY_INCREMENT = 0x6D2B79F5;
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;
const SEED_BYTES = 4;

const STREAM_NAMES = Object.freeze(["battle", "strategy", "events", "travel", "ids"]);

// Port 1:1 of stableHash32 from X-Eve livingRoamingKernel.js (see CREDITS.md).
function stableHash32(...parts) {
  const text = parts.map((part) => String(part)).join("|");
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

// Port 1:1 of deterministicUnit from X-Eve livingRoamingKernel.js (see CREDITS.md).
function deterministicUnit(...parts) {
  return stableHash32(...parts) / UINT32_RANGE;
}

function fmix32(value) {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

function assertSeed(seed, what) {
  if (typeof seed !== "number" || !Number.isFinite(seed) || !Number.isInteger(seed)) {
    throw new TypeError(`${what} must be an integer, got ${String(seed)}`);
  }
  return seed >>> 0;
}

function deriveSeed(baseSeed, ...keyParts) {
  return fmix32(stableHash32(assertSeed(baseSeed, "baseSeed"), ...keyParts));
}

function makeRng(initialState) {
  let state = initialState >>> 0;

  function nextUint32() {
    state = (state + MULBERRY_INCREMENT) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  function nextFloat() {
    return nextUint32() / UINT32_RANGE;
  }

  function nextInt(min, max) {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
      throw new RangeError(`nextInt(${min}, ${max}): bounds must be integers with min <= max`);
    }
    const span = max - min + 1;
    if (span > UINT32_RANGE) throw new RangeError(`nextInt(${min}, ${max}): range above 2^32`);
    return min + Math.floor(nextFloat() * span);
  }

  function chance(p) {
    return nextFloat() < p;
  }

  function pick(items) {
    if (!Array.isArray(items) || items.length === 0) return undefined;
    return items[Math.floor(nextFloat() * items.length)];
  }

  function getState() {
    return state;
  }

  return Object.freeze({ nextUint32, nextFloat, nextInt, chance, pick, getState });
}

function createRng(seed) {
  return makeRng(assertSeed(seed, "seed"));
}

function rngFromState(state) {
  return makeRng(assertSeed(state, "state"));
}

function createStreams(baseSeed) {
  const base = assertSeed(baseSeed, "baseSeed");
  const streams = new Map();
  function stream(name) {
    if (!STREAM_NAMES.includes(name)) throw new Error(`unknown rng stream "${name}"`);
    let rng = streams.get(name);
    if (!rng) {
      rng = createRng(deriveSeed(base, "stream", name));
      streams.set(name, rng);
    }
    return rng;
  }
  return Object.freeze({ stream, baseSeed: base });
}

const SETTLEMENT_SEED_KINDS = Object.freeze(["battle"]);

function settlementSeed(worldSeed, kind, id) {
  if (!SETTLEMENT_SEED_KINDS.includes(kind)) throw new TypeError(`settlementSeed: unknown kind ${String(kind)}`);
  const { isId } = require("./ids");
  if (!isId(id, kind)) throw new TypeError(`settlementSeed: id is not a ${kind} id`);
  return deriveSeed(worldSeed, kind, id);
}

function randomSeed() {
  const crypto = require("node:crypto");
  return crypto.randomBytes(SEED_BYTES).readUInt32LE(0);
}

module.exports = {
  STREAM_NAMES,
  stableHash32,
  deterministicUnit,
  deriveSeed,
  createRng,
  rngFromState,
  createStreams,
  randomSeed,
  SETTLEMENT_SEED_KINDS,
  settlementSeed,
};
