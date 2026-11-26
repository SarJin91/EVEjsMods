"use strict";

(function tabsModule(global) {
  const DEFAULT_TAB = "factions";
  const OTHER_TAB = "other";
  const ALWAYS = Object.freeze(["status", "telemetry"]);
  const TABS = Object.freeze([
    { id: "factions", label: "Factions", views: ["faction-overview", "activity"] },
    { id: "map", label: "Map", views: ["galaxy"] },
    { id: "economy", label: "Economy", views: ["production", "mining", "logistics", "trade", "stations",
      "construction", "structures"] },
    { id: "war", label: "War and territory", views: ["fleets", "battles", "occupation", "liberation", "control",
      "invasions", "native-incursions", "sieges", "hunts", "expeditions", "capsuleers", "materialization",
      "salvage"] },
    { id: "system", label: "System", views: ["status", "telemetry", "module-cost", "journal", "effective-config",
      "scheduler", "graph", "virtual-corps", "sov-facts"] },
    { id: OTHER_TAB, label: "Other", views: [] },
  ].map((t) => Object.freeze({ ...t, views: Object.freeze([...t.views]) })));

  const TAB_IDS = new Set(TABS.map((t) => t.id));
  const TAB_OF = new Map();
  for (const t of TABS) t.views.forEach((v, i) => TAB_OF.set(v, { tab: t.id, index: i }));

  function idOfEntry(entry) {
    if (typeof entry === "string") return entry;
    return entry && typeof entry.id === "string" ? entry.id : null;
  }

  function tabOf(viewId) {
    const e = TAB_OF.get(viewId);
    return e ? e.tab : OTHER_TAB;
  }

  function viewsForTab(tabId, listed) {
    const rows = [];
    (Array.isArray(listed) ? listed : []).forEach((entry, order) => {
      const id = idOfEntry(entry);
      if (id === null || tabOf(id) !== tabId) return;
      const e = TAB_OF.get(id);
      rows.push({ entry, order, index: e ? e.index : Infinity });
    });
    rows.sort((a, b) => (a.index === b.index ? a.order - b.order : (a.index < b.index ? -1 : 1)));
    return rows.map((r) => r.entry);
  }

  function viewsToFetch(tabId, listed) {
    const list = Array.isArray(listed) ? listed : [];
    const out = [];
    const seen = new Set();
    const add = (entry) => {
      const id = idOfEntry(entry);
      if (id === null || seen.has(id)) return;
      seen.add(id);
      out.push(entry);
    };
    for (const id of ALWAYS) {
      const entry = list.find((e) => idOfEntry(e) === id);
      if (entry !== undefined) add(entry);
    }
    for (const entry of viewsForTab(tabId, list)) add(entry);
    return out;
  }

  function idPart(parts) {
    if (parts.length !== 2 || !/^[1-9][0-9]*$/.test(parts[1])) return null;
    const n = Number(parts[1]);
    return Number.isSafeInteger(n) ? n : null;
  }

  function parseHash(hash) {
    const text = typeof hash === "string" ? hash.replace(/^#/, "") : "";
    const parts = text.split("/");
    const tab = TAB_IDS.has(parts[0]) ? parts[0] : DEFAULT_TAB;
    if (tab !== parts[0]) return { tab: DEFAULT_TAB, factionId: null, systemId: null };
    const id = idPart(parts);
    return { tab, factionId: tab === DEFAULT_TAB ? id : null, systemId: tab === "map" ? id : null };
  }

  function formatHash(value) {
    const v = value || {};
    const tab = TAB_IDS.has(v.tab) ? v.tab : DEFAULT_TAB;
    if (tab === DEFAULT_TAB && Number.isSafeInteger(v.factionId) && v.factionId > 0) {
      return `#${tab}/${v.factionId}`;
    }
    if (tab === "map" && Number.isSafeInteger(v.systemId) && v.systemId > 0) return `#${tab}/${v.systemId}`;
    return `#${tab}`;
  }

  function rememberFaction(remembered, parsed) {
    const p = parsed || {};
    if (p.tab === DEFAULT_TAB && Number.isSafeInteger(p.factionId) && p.factionId > 0) return p.factionId;
    return Number.isSafeInteger(remembered) && remembered > 0 ? remembered : null;
  }

  function hashForTab(tab, current, remembered) {
    if (tab !== DEFAULT_TAB) return { tab, factionId: null };
    return { tab, factionId: rememberFaction(remembered, current) };
  }

  global.LneTabs = Object.freeze({
    TABS, DEFAULT_TAB, OTHER_TAB, ALWAYS,
    _pure: Object.freeze({ tabOf, viewsForTab, viewsToFetch, parseHash, formatHash, rememberFaction, hashForTab }),
  });
}(typeof window !== "undefined" ? window : globalThis));
