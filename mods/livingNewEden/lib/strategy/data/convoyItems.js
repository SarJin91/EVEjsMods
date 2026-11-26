"use strict";

function convoyItemsOf(convoy) {
  const items = convoy && convoy.items;
  if (!items || typeof items !== "object" || Array.isArray(items)) return [];
  const out = [];
  for (const k of Object.keys(items).sort()) {
    const slash = k.indexOf("/");
    if (slash <= 0 || slash === k.length - 1) continue;
    out.push({ itemKind: k.slice(0, slash), itemKey: k.slice(slash + 1), quantity: items[k] });
  }
  return out;
}

module.exports = { convoyItemsOf };
