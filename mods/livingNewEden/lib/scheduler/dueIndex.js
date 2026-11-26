"use strict";

const { DeadlineQueue } = require("./deadlineQueue");
const { MIN_PRIORITY, MAX_PRIORITY } = require("./eventTypes");

const ALL_PRIORITIES = Object.freeze(Array.from({ length: MAX_PRIORITY - MIN_PRIORITY + 1 },
  (_v, i) => MIN_PRIORITY + i));

function isPriority(value) {
  return Number.isInteger(value) && value >= MIN_PRIORITY && value <= MAX_PRIORITY;
}

function createDueIndex() {
  const heaps = new Map(ALL_PRIORITIES.map((p) => [p, new DeadlineQueue()]));
  const priorityOf = new Map();

  function add(eventId, priority, dueAt, eventType) {
    if (typeof eventId !== "string" || eventId === "") throw new TypeError("dueIndex.add: eventId");
    if (!isPriority(priority)) throw new RangeError(`dueIndex.add: priority ${priority}`);
    if (!Number.isFinite(dueAt) || dueAt < 0) throw new RangeError(`dueIndex.add: dueAt ${dueAt}`);
    if (typeof eventType !== "string" || eventType === "") throw new TypeError("dueIndex.add: eventType");
    const known = priorityOf.get(eventId);
    if (known !== undefined && known !== priority) heaps.get(known).remove(eventId);
    heaps.get(priority).schedule(eventId, dueAt, eventType);
    priorityOf.set(eventId, priority);
  }

  function remove(eventId) {
    const known = priorityOf.get(eventId);
    if (known === undefined) return false;
    priorityOf.delete(eventId);
    return heaps.get(known).remove(eventId);
  }

  function popDue(now, opts) {
    const maxItems = opts && Number.isInteger(opts.maxItems) ? opts.maxItems : 0;
    const wanted = opts && Array.isArray(opts.priorities) ? opts.priorities : ALL_PRIORITIES;
    const overBudget = opts && typeof opts.overBudget === "function" ? opts.overBudget : () => false;
    const accept = opts && typeof opts.accept === "function" ? opts.accept : null;
    const entries = [];
    const rejected = [];
    const heldEntries = [];
    const done = (stoppedBy) => {
      for (const e of heldEntries) add(e.eventId, e.priority, e.dueAt, e.eventType);
      return { entries, rejected, held: heldEntries.length, stoppedBy };
    };
    if (maxItems < 1) return done("items");
    for (const priority of ALL_PRIORITIES) {
      if (!wanted.includes(priority)) continue;
      const heap = heaps.get(priority);
      for (;;) {
        const head = heap.popDue(now);
        if (head === null) break;
        priorityOf.delete(head.key);
        const entry = { eventId: head.key, priority, dueAt: head.dueAtMs, eventType: head.payload };
        const verdict = accept ? accept(entry) : true;
        if (verdict === "hold") {
          heldEntries.push(entry);
          if (overBudget()) return done("time");
          break;
        }
        if (verdict === false || verdict === "park") rejected.push(entry);
        else {
          entries.push(entry);
          if (entries.length >= maxItems) return done("items");
        }
        if (overBudget()) return done("time");
      }
    }
    return done("empty");
  }

  function countDue(cutoff, cap) {
    let count = 0;
    if (!(cap >= 1)) return { count, capped: false };
    for (const heap of heaps.values()) {
      const arr = heap._heap;
      const stack = [0];
      while (stack.length > 0) {
        const i = stack.pop();
        if (i >= arr.length || arr[i].dueAtMs > cutoff) continue;
        count += 1;
        if (count >= cap) return { count, capped: true };
        stack.push((i * 2) + 1, (i * 2) + 2);
      }
    }
    return { count, capped: false };
  }

  function size() {
    return priorityOf.size;
  }

  function sizes() {
    const out = {};
    for (const [p, heap] of heaps) out[p] = heap.size;
    return out;
  }

  function nextDueAt(priority) {
    const heap = heaps.get(priority);
    const head = heap ? heap.peek() : null;
    return head ? head.dueAtMs : null;
  }

  function has(eventId) {
    return priorityOf.has(eventId);
  }

  function clear() {
    for (const heap of heaps.values()) heap.clear();
    priorityOf.clear();
  }

  return Object.freeze({ add, remove, popDue, countDue, size, sizes, nextDueAt, has, clear });
}

module.exports = { createDueIndex, ALL_PRIORITIES, isPriority };
