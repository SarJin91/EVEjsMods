"use strict";

const { hullTargets } = require("./production");

const NO_SIGNAL = Object.freeze({ cover: null, limiting: null });

function mineralCoverOf(snapshot, params) {
  const pr = snapshot && snapshot.production;
  const P = params && params.production;
  if (!pr || pr.mode !== "ready" || pr.truncated === true || !P) return NO_SIGNAL;
  const targets = hullTargets(snapshot.doctrine, P);
  const recipes = pr.recipes || {};
  const need = {};
  for (const g of Object.keys(targets)) {
    const recipe = recipes[g];
    if (!recipe || !recipe.minerals) continue;
    for (const k of Object.keys(recipe.minerals)) {
      const q = targets[g] * recipe.minerals[k];
      if (q > 0) need[k] = (need[k] || 0) + q;
    }
  }
  const keys = Object.keys(need).sort();
  if (keys.length === 0) return NO_SIGNAL;
  const stock = {};
  for (const s of pr.stations || []) {
    const minerals = (s && s.minerals) || {};
    for (const k of keys) if (minerals[k] > 0) stock[k] = (stock[k] || 0) + minerals[k];
  }
  let cover = null;
  let limiting = null;
  for (const k of keys) {
    const c = Math.floor((stock[k] || 0) / need[k]);
    if (cover === null || c < cover) {
      cover = c;
      limiting = k;
    }
  }
  return { cover, limiting };
}

module.exports = { mineralCoverOf };
