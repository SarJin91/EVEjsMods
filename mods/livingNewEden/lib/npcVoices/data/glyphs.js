"use strict";

function fromCodes(codes) {
  return Object.freeze(codes.map((c) => String.fromCodePoint(c)));
}

function range(from, to) {
  const out = [];
  for (let c = from; c <= to; c += 1) out.push(c);
  return out;
}

const DRIFTER = [0xa1, 0xa4, 0xa6, 0xa7, 0xb0, 0xb1, 0xb6, 0xbf, 0xd7, 0xd8, 0xde, 0xf7, 0xf8, 0xfe];
const SLEEPER = [0xa8, 0xab, 0xaf, 0xb2, 0xb3, 0xb5, 0xb7, 0xb8, 0xb9, 0xac, 0xbb, 0xc6, 0xd0, 0xdf, 0xe6, 0xf0];
const ROGUE_DRONE = [0x30, 0x31, 0x3a, 0x2d, 0x2e, 0x78, ...range(0x41, 0x46)];
const GREEK = [...range(0x391, 0x3a1), ...range(0x3a3, 0x3a9), ...range(0x3b1, 0x3c9)];
const MATH = range(0x2200, 0x22ff);
const SHAPES = range(0x25a0, 0x25ff);

const ALPHABETS = Object.freeze({
  DRIFTER: fromCodes(DRIFTER),
  SLEEPER: fromCodes(SLEEPER),
  ROGUE_DRONE: fromCodes(ROGUE_DRONE),
});

const EXTENDED_ALPHABETS = Object.freeze({
  DRIFTER: fromCodes([...DRIFTER, ...SHAPES]),
  SLEEPER: fromCodes([...SLEEPER, ...GREEK]),
  ROGUE_DRONE: fromCodes([...ROGUE_DRONE, ...MATH]),
});

module.exports = { ALPHABETS, EXTENDED_ALPHABETS };
