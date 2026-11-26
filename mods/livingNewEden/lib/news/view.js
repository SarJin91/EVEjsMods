"use strict";

const VIEW_ID = "news";
const VIEW_ORDER = 27;

function buildNewsView(deps) {
  const { store, repo } = deps;
  const s = deps.settings;
  const isOpen = () => {
    try {
      return Boolean(store && typeof store.isOpen === "function" && store.isOpen() === true);
    } catch (_err) {
      return false;
    }
  };
  const status = () => {
    try {
      return deps.getStatus() || {};
    } catch (_err) {
      return {};
    }
  };

  function cacheKey() {
    if (!isOpen()) return null;
    return `n${deps.getWrites()}:${status().nextBoundaryAt || 0}`;
  }

  function getData() {
    if (!isOpen()) return { available: false, reason: "STORE_CLOSED" };
    const r = store.transaction("observer.news", (db) => repo.listEditionsInTx(db, { limit: s.observerEditions }));
    const read = r && r.ok ? r.value : r;
    if (!r || !r.ok || !read || !read.ok) {
      return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    }
    const st = status();
    return { available: true, state: st.state || null, nextBoundaryAt: st.nextBoundaryAt || null,
      editions: read.editions.map((e) => ({ editionId: e.editionId, seq: e.seq, boundaryAt: e.boundaryAt,
        state: e.state, source: e.source, title: e.title !== null ? e.title : e.fallbackTitle,
        paragraphs: e.title !== null ? e.paragraphs : e.fallbackParagraphs, factCount: e.factCount,
        publishedAt: e.publishedAt, recipients: e.recipients })) };
  }

  return { title: "Galactic news", order: VIEW_ORDER, listed: true, cacheKey, getData };
}

module.exports = { buildNewsView, VIEW_ID, VIEW_ORDER };
