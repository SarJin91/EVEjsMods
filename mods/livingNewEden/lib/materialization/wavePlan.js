"use strict";

const { pickDetachment } = require("../playerHunt/huntRepository");

const SIDES = Object.freeze(["A", "B"]);

const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;
const tooLarge = (detail) => ({ ok: false, reason: "LIVE_TOO_LARGE", detail });

function sideOrder(list) {
  if (list.length <= 1) return [...list];
  const head = pickDetachment(list, list.length - 1);
  const taken = new Set(head);
  return head.concat(list.filter((m) => !taken.has(m)));
}

function slotsSafe(slotsOf, members) {
  try {
    const n = slotsOf(members);
    return Number.isFinite(n) ? n : Infinity;
  } catch (_err) {
    return Infinity;
  }
}

function planWave(members, opts) {
  if (!Array.isArray(members) || members.length === 0) return tooLarge("members: empty");
  if (!opts || typeof opts !== "object" || typeof opts.slotsOf !== "function") return tooLarge("opts");
  const W = opts.maxShips;
  if (!Number.isSafeInteger(W) || W < 2) return tooLarge(`maxShips ${W} < 2`);
  if (!isPositiveInt(opts.maxSlots)) return tooLarge("maxSlots");
  const bySide = { A: [], B: [] };
  for (const m of members) {
    if (!m || !SIDES.includes(m.side)) return tooLarge("member side");
    bySide[m.side].push(m);
  }
  const order = { A: sideOrder(bySide.A), B: sideOrder(bySide.B) };
  const nA = order.A.length;
  const nB = order.B.length;
  const n = nA + nB;
  const q = { A: 0, B: 0 };
  if (nA === 0 || nB === 0) {
    const side = nA === 0 ? "B" : "A";
    q[side] = Math.min(order[side].length, W);
  } else {
    q.A = Math.min(nA, Math.max(1, Math.floor((W * nA + Math.floor(n / 2)) / n)));
    q.B = Math.min(nB, W - q.A);
    if (q.B < 1) {
      q.B = 1;
      q.A = Math.min(nA, W - 1);
    }
  }
  const wave = { A: order.A.slice(0, q.A), B: order.B.slice(0, q.B) };
  const slotsOfSide = (x) => slotsSafe(opts.slotsOf, wave[x]);
  const total = () => slotsOfSide("A") + slotsOfSide("B");
  while (total() > opts.maxSlots) {
    const bigger = slotsOfSide("A") >= slotsOfSide("B") ? "A" : "B";
    const other = bigger === "A" ? "B" : "A";
    const minOf = (x) => (order[x].length > 0 ? 1 : 0);
    if (wave[bigger].length > minOf(bigger)) wave[bigger].pop();
    else if (wave[other].length > minOf(other)) wave[other].pop();
    else return tooLarge(`slots ${total()} > ${opts.maxSlots} with one member per side`);
  }
  const quota = { A: slotsOfSide("A"), B: slotsOfSide("B") };
  return { ok: true, wave: wave.A.concat(wave.B),
    reserve: { A: order.A.slice(wave.A.length), B: order.B.slice(wave.B.length) }, quota, slots: quota.A + quota.B };
}

function pickRefill(s, opts) {
  const out = { A: [], B: [] };
  if (!s || typeof s !== "object" || !s.reserve || !s.quota || !s.aliveSlots) return out;
  if (!opts || typeof opts.slotsOf !== "function" || !isPositiveInt(opts.budget)) return out;
  const used = { A: Number(s.aliveSlots.A) || 0, B: Number(s.aliveSlots.B) || 0 };
  const taken = { A: new Set(), B: new Set() };
  let count = 0;
  const pickOne = (x) => {
    const list = Array.isArray(s.reserve[x]) ? s.reserve[x] : [];
    const quota = Number(s.quota[x]) || 0;
    for (let i = 0; i < list.length; i += 1) {
      if (taken[x].has(i)) continue;
      const slots = slotsSafe(opts.slotsOf, [list[i]]);
      if (used[x] + slots > quota) continue;
      taken[x].add(i);
      used[x] += slots;
      out[x].push(list[i]);
      count += 1;
      return true;
    }
    return false;
  };
  let progress = true;
  while (progress && count < opts.budget) {
    progress = false;
    for (const x of SIDES) {
      if (count >= opts.budget) break;
      if (pickOne(x)) progress = true;
    }
  }
  return out;
}

module.exports = { planWave, pickRefill };
