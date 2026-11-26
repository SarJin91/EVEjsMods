"use strict";

const { MAX_LINE } = require("../notices/schema");
const { onlineCharacters } = require("../frontJobs/mail");
const { formatAwardLine, formatAnnounceLine } = require("./format");
const S = require("./schema");

const KIND_AWARD = "WAR_CONTRACT_AWARD";
const KIND_NEW = "WAR_CONTRACT_NEW";
const ANNOUNCE_KEY_PREFIX = "wcann:";
const NO_SYSTEM = 0;
const MAX_DETAIL = 120;
const PRESENCE_SCAN_MAX = Number.MAX_SAFE_INTEGER;

const announceKeyOf = (offerId) => `${ANNOUNCE_KEY_PREFIX}${offerId}`;

function createWarMail(deps) {
  const { settings, bump, log } = deps;
  const safe = (fn) => {
    try {
      return fn() || null;
    } catch (_err) {
      return null;
    }
  };

  function enqueue(tx, items, now, counter) {
    const notices = safe(() => deps.getNotices());
    if (!notices || typeof notices.enqueueItemsInTx !== "function") {
      bump("noticeRefused");
      return;
    }
    try {
      const r = notices.enqueueItemsInTx(tx, items, now);
      if (r && r.ok === true) bump(counter, r.inserted);
      else bump("noticeRefused");
    } catch (err) {
      bump("noticeRefused");
      log(`notice enqueue threw - ${String((err && err.message) || err).slice(0, MAX_DETAIL)}`);
    }
  }

  function stockOf(tx, row) {
    try {
      const repo = deps.getStationsRepository();
      if (!repo || typeof repo.getStock !== "function") return null;
      const r = repo.getStock(tx, row.stationId, { limit: settings.maxStockItems });
      if (!r || r.ok !== true || !Array.isArray(r.items)) return null;
      const item = r.items.find((it) => it && it.itemKind === row.itemKind && it.itemKey === row.itemKey);
      if (item) return Number.isSafeInteger(Number(item.quantity)) ? Number(item.quantity) : null;
      return r.truncated === true ? null : 0;
    } catch (_err) {
      return null;
    }
  }

  function awardInTx(tx, row, done) {
    if (settings.awardMailEnabled !== true) return;
    if (!row || !done || !Number.isSafeInteger(done.characterId) || done.characterId <= 0) return;
    const stockQuantity = stockOf(tx, row);
    if (stockQuantity === null) bump("stockLineMissing");
    const line = formatAwardLine(row, { outcome: done.outcome, stockQuantity, stationName: null, maxLine: MAX_LINE },
      deps.names);
    enqueue(tx, [{ eventKey: S.payoutKeyOf(row.offerId), characterId: done.characterId, kind: KIND_AWARD,
      systemId: row.systemId, line, eventAt: done.at }], done.at, "awardMails");
  }

  function announceInTx(tx, rows, at) {
    if (settings.announceMailEnabled !== true || !Array.isArray(rows) || rows.length === 0) return;
    const presence = safe(() => deps.getPresence());
    const online = safe(() => onlineCharacters(presence, PRESENCE_SCAN_MAX));
    if (!online || online.ok !== true || online.characterIds.length === 0) return;
    const regionOfCharacter = new Map();
    for (const sys of safe(() => presence.listPresence()) || []) {
      const region = sys ? safe(() => deps.regionOf(sys.systemId)) : null;
      if (region === null) continue;
      for (const c of (Array.isArray(sys.characters) ? sys.characters : [])) {
        const id = Number(c && c.characterId);
        if (Number.isSafeInteger(id) && id > 0) regionOfCharacter.set(id, region);
      }
    }
    const rowsOfRegion = new Map();
    for (const row of [...rows].sort((a, b) => (a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0))) {
      const region = safe(() => deps.regionOf(row.systemId));
      if (region === null) continue;
      if (!rowsOfRegion.has(region)) rowsOfRegion.set(region, []);
      rowsOfRegion.get(region).push(row);
    }
    const items = [];
    for (const characterId of online.characterIds) {
      if (items.length >= settings.announceMaxRecipients) break;
      const list = rowsOfRegion.get(regionOfCharacter.get(characterId));
      if (!list) continue;
      items.push({ eventKey: announceKeyOf(list[0].offerId), characterId, kind: KIND_NEW, systemId: NO_SYSTEM,
        line: formatAnnounceLine(list, deps.names, MAX_LINE), eventAt: at });
    }
    if (items.length > 0) enqueue(tx, items, at, "announceMails");
  }

  const guarded = (fn, what) => (...args) => {
    try {
      fn(...args);
    } catch (err) {
      bump("noticeRefused");
      log(`${what} mail failed - ${String((err && err.message) || err).slice(0, MAX_DETAIL)}`);
    }
  };
  return Object.freeze({ awardInTx: guarded(awardInTx, "award"), announceInTx: guarded(announceInTx, "announce") });
}

module.exports = { createWarMail, announceKeyOf, KIND_AWARD, KIND_NEW };
