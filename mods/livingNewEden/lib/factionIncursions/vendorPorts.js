"use strict";

const PORTS = Object.freeze([
  Object.freeze({ file: "services/incursion/incursionLifecycleContract.js", symbol: "projectInfluence",
    sha256: "c0ce12e218f8252d4d3084e6f5c54f2cd268eec66af2fc0509db286a58c2d7fe", lne: "lib/factionIncursions/influence.js",
    differences: Object.freeze(["milli integers 0..1000 instead of the float 0..1", "invalid input -> null, no throw",
      "the decay floored to whole milli"]) }),
  Object.freeze({ file: "services/incursion/incursionSiteSlots.js", symbol: "complete",
    sha256: "7cb6b73cadae4da99ced3b3f33d0bf87c6ec6b14e64cd41f80d426815f26ec78", lne: "lib/factionIncursions/influence.js",
    differences: Object.freeze(["only the influence rule (projection at max(lastUpdated, completedAt), min(1, before + "
      + "per), cutoff at expiresAtMs) -> applyCompletion", "no receipt proof, slot history or retirement work"]) }),
  Object.freeze({ file: "services/incursion/incursionFocusPlacement.js", symbol: "buildCatalog",
    sha256: "fd63e30c77cf417148adf2b1884ac47cf400badb485011f751c9dd90ad2cd115", lne: "lib/factionIncursions/placement.js",
    differences: Object.freeze(["the edge rule only (same constellation, region, band, gate both ways, neighbours "
      + "ascending)", "the LNE Universe Graph instead of the static rows, no components, no catalog fingerprint"]) }),
  Object.freeze({ file: "services/incursion/incursionFocusPlacement.js", symbol: "selectPlacement",
    sha256: "3c0c3ae958a1038a49d34121dda6b4bdeea1cdf4857ee829426b23cd9e633302", lne: "lib/factionIncursions/placement.js",
    differences: Object.freeze(["the BFS starts at the claim target (no seed rank)", "the target = hq, roles reversed",
      "no positions"]) }),
  Object.freeze({ file: "services/incursion/incursionSiteModel.js", symbol: "keyValid",
    sha256: "150758f04cf4cbcbfb357d29f63b9305b5c9a382122fd220451776eade73ba5a", lne: "lib/factionIncursions/rules.js",
    differences: Object.freeze(["1..32 characters without ':' (a part of the site event id)"]) }),
  Object.freeze({ file: "services/incursion/incursionSiteModel.js", symbol: "validateCondition",
    sha256: "ad5bc8cf381dd0235008ca4ee312fd9135c857a1201356be2986e02703b83916", lne: "lib/factionIncursions/rules.js",
    differences: Object.freeze(["leaf destroyed removed", "new leaves influenceAtLeast and objective clears:<stage>:<n>",
      "a refusal value instead of a throw"]) }),
  Object.freeze({ file: "services/incursion/incursionSiteModel.js", symbol: "validatePolicyContent",
    sha256: "632c18669a2a9660b92808f6503271d41d533a1f378acdf8d308b258461207d3", lne: "lib/factionIncursions/rules.js",
    differences: Object.freeze(["only the stage keys, prerequisites, cycles (also through the stages an unlock reads) "
      + "and the unfinishable stage (no slot, a non-repeated stage cleared more often than its slots)",
    "no actors, objectives of cargo/hack, participation or reward checks"]) }),
  Object.freeze({ file: "services/incursion/incursionSiteModel.js", symbol: "condition",
    sha256: "a9baf2d34b2c3684c4fc4051e1f908bc79c4f4555b793d503243b89577623355", lne: "lib/factionIncursions/rules.js",
    differences: Object.freeze(["objective = the clear count of a stage", "influenceAtLeast against the projected "
      + "influence", "no destroyed leaf"]) }),
  Object.freeze({ file: "services/incursion/incursionSiteModel.js", symbol: "refresh",
    sha256: "529e20c4e81be426bc6e13e9f19d84b0912138e9fa1882a12d407077952bf6bf", lne: "lib/factionIncursions/rules.js",
    differences: Object.freeze(["activates a stage (prerequisites completed + unlock); completed comes from the clears",
      "an active stage stays active (vendor activateRoom)"]) }),
  Object.freeze({ file: "services/incursion/incursionSiteModel.js", symbol: "recordObjective",
    sha256: "3f3b0bde271d8ef5c5cda1998d25d19c32a8106ac0464d2a356cd422e844cdd2", lne: "lib/factionIncursions/rules.js",
    differences: Object.freeze(["the receipt rule only (the same receipt twice = no-op, a receipt limit)",
      "receipt = the heavyEvents event id, no proof fingerprint"]) }),
  Object.freeze({ file: "services/incursion/incursionLifecycle.js", symbol: "advanceBoundary",
    sha256: "26afabcf480b570a6855429b5afffb86dc3b6c3da6d2480eb7d0bc5533de9c7d", lne: "lib/factionIncursions/decide.js",
    differences: Object.freeze(["only the terminal: expired at the last boundary (decided_at = expires_at)",
      "phases computed from the times (timeline.js), never written"]) }),
  Object.freeze({ file: "services/incursion/incursionLifecycle.js", symbol: "acceptFinalCompletion",
    sha256: "084163107cb30b4baba9bed2c6f57950d99341e9586f120f14e1dd2acff26698", lne: "lib/factionIncursions/decide.js",
    differences: Object.freeze(["defeated only when the HQ clear time < expires_at, else expired",
      "the clear time = ended_at (or updated_at) of the heavyEvents row"]) }),
]);

function bodyOf(text, symbol) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const fnRe = new RegExp(`^(\\s*)function ${symbol}\\(`);
  const constRe = new RegExp(`^(\\s*)const ${symbol} = `);
  for (let i = 0; i < lines.length; i += 1) {
    if (constRe.test(lines[i])) return lines[i];
    const m = fnRe.exec(lines[i]);
    if (!m) continue;
    const close = `${m[1]}}`;
    if (lines[i].trimEnd().endsWith("}") && lines[i].includes("{")) {
      let depth = 0;
      for (const ch of lines[i]) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
      if (depth === 0) return lines[i];
    }
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j] === close) return lines.slice(i, j + 1).join("\n");
    }
    return null;
  }
  return null;
}

module.exports = { PORTS, bodyOf };
