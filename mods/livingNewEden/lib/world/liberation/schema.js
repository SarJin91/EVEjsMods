"use strict";

const EVENT_TYPE = "LIBERATION_CHECK";

const LIBERATION_ROWS_BASE = 5;
const rowsBound = (maxFactionsPerSystem) => LIBERATION_ROWS_BASE + maxFactionsPerSystem;

const MS_PER_HOUR = 3600000;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;

const killKey = (systemId, characterId, factionId, atMs, victimId) =>
  `libkill:${systemId}:${characterId}:${factionId}:${atMs}${isId(victimId) ? `.${victimId}` : ""}`;
const legacyKillKey = (systemId, characterId, factionId, atMs, victimId) =>
  (isId(victimId) ? killKey(systemId, characterId, factionId, atMs) : null);
const bucketOf = (dueAt) => Math.floor(dueAt / MS_PER_HOUR);
const checkKeyOfBucket = (systemId, phaseSeq, bucket) => `lib:${systemId}:${phaseSeq}:t:${bucket}`;
const checkKey = (systemId, phaseSeq, dueAt) => checkKeyOfBucket(systemId, phaseSeq, bucketOf(dueAt));

function parsePayload(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (!isId(p.systemId) || !isTime(p.seq)) return null;
  const keys = Object.keys(p).sort().join();
  if (keys === "bucket,seq,systemId" && isTime(p.bucket)) return { systemId: p.systemId, seq: p.seq, bucket: p.bucket };
  if (keys === "dueAt,seq,systemId" && isTime(p.dueAt)) {
    return { systemId: p.systemId, seq: p.seq, bucket: bucketOf(p.dueAt) };
  }
  return null;
}

module.exports = { EVENT_TYPE, LIBERATION_ROWS_BASE, rowsBound, MS_PER_HOUR, isId, isTime, killKey, legacyKillKey,
  bucketOf,
  checkKeyOfBucket, checkKey, parsePayload };
