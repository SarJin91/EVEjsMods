"use strict";

const LAYER_ID = "layer-players";
const LAYER_ORDER = 10;
const STYLE_SPACE = "space";
const STYLE_DOCKED = "docked";
const LEGEND = Object.freeze([
  Object.freeze([STYLE_SPACE, "in space", "#3ee07a"]),
  Object.freeze([STYLE_DOCKED, "docked", "#5aa0ff"]),
]);
const STATE_TEXT = Object.freeze({ space: "in space", docked: "docked", transit: "in transit" });
const UNKNOWN_COUNT_LABEL = "?";

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function buildPlayersLayerView(deps) {
  const { presence } = deps;
  const maxNames = Math.max(0, Math.trunc(Number(deps.maxNames) || 0));

  function getData() {
    const items = [];
    let players = 0;
    for (const p of presence.listPresence()) {
      players += p.total;
      const style = p.space > 0 || p.transit > 0 || p.total === 0 ? STYLE_SPACE : STYLE_DOCKED;
      let lines = null;
      if (maxNames > 0) {
        lines = p.characters.slice(0, maxNames).map((c) => `${c.name} - ${STATE_TEXT[c.state] || c.state}`);
        if (p.characters.length > maxNames) lines.push(`+${p.characters.length - maxNames} more`);
      }
      items.push([p.systemId, style, p.total > 0 ? String(p.total) : UNKNOWN_COUNT_LABEL, lines]);
    }
    return {
      available: true,
      key: `p${presence.getVersion()}`,
      legend: LEGEND.map((l) => [...l]),
      items,
      note: `${plural(players, "player")} in ${plural(items.length, "system")}`,
    };
  }

  return {
    title: "Players",
    listed: false,
    mapLayer: { kind: "marks", order: LAYER_ORDER },
    cacheKey: () => `p${presence.getVersion()}`,
    getData,
  };
}

module.exports = { LAYER_ID, LEGEND, buildPlayersLayerView };
