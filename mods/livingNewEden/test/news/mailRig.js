"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { newsSettingsOf } = require("../../lib/news/schema");
const { createNewsRepository } = require("../../lib/news/repository");
const { weightOf } = require("../../lib/news/data/kinds");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const B = Date.UTC(2026, 10, 15, 17, 0, 0);
const H = 3600000;

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_NEWS_ENABLED: "1", EVEJS_LNE_NEWS_MAIL_ENABLED: "1",
    ...env } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.config;
}

function settingsOf(env) {
  const r = newsSettingsOf(configOf(env));
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

function txOf(store) {
  return (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r && r.reason));
    return r.value;
  };
}

function addFact(store, key, boundaryAt, systemName = "Jita") {
  const repo = createNewsRepository({ weightOf });
  txOf(store)((db) => repo.upsertFactsInTx(db, [{ factKey: key, kind: "SYSTEM_CAPTURED", at: boundaryAt - H,
    systemId: 30000142, weight: 80, data: { v: 1, systemName, regionName: "The Forge", factionA: "Caldari State",
      factionB: "Gallente Federation" } }], boundaryAt - H));
}

function publishEdition(store, { boundaryAt, now, title, paragraphs, activeSince, limit }) {
  const repo = createNewsRepository({ weightOf });
  return txOf(store)((db) => {
    const editionId = `ed:${boundaryAt}`;
    const opened = repo.openEditionInTx(db, { editionId, boundaryAt, language: "en", skipped: false,
      fallback: { title, paragraphs }, selectedKeys: [], droppedKeys: [], now });
    assert.ok(opened.ok, JSON.stringify(opened));
    const ready = repo.readyEditionInTx(db, { editionId, expectedVersion: opened.edition.version, source: "FALLBACK",
      title, paragraphs, now });
    assert.ok(ready.ok, JSON.stringify(ready));
    const q = repo.queueDeliveriesInTx(db, { editionId, activeSince, limit, now });
    assert.ok(q.ok, JSON.stringify(q));
    const pub = repo.publishEditionInTx(db, { editionId, expectedVersion: ready.edition.version,
      recipients: q.queued, now });
    assert.ok(pub.ok, JSON.stringify(pub));
    return { ok: true, editionId, queued: q.queued };
  });
}

function deliveries(store) {
  return txOf(store)((db) => ({ ok: true, rows: db.prepare("SELECT edition_id AS e, character_id AS c, state, "
    + "sender_id AS s, sent_date AS d, title, message_id AS m, error FROM lne_news_deliveries "
    + "ORDER BY edition_id, character_id").all() })).rows;
}

function touchAt(store, ids, at) {
  const repo = createNewsRepository({ weightOf });
  txOf(store)((db) => repo.touchReadersInTx(db, ids, at));
}

module.exports = { B, H, MOD_DIR, configOf, settingsOf, txOf, addFact, publishEdition, deliveries, touchAt };
