"use strict";

const TITLES = Object.freeze({
  CHAMPION: Object.freeze({ en: "Season {n} Champion", pl: "Mistrz sezonu {n}" }),
  HERO: Object.freeze({ en: "Season {n} Hero", pl: "Bohater sezonu {n}" }),
  VETERAN: Object.freeze({ en: "Season {n} Veteran", pl: "Weteran sezonu {n}" }),
  PARTICIPANT: Object.freeze({ en: "Season {n} Participant", pl: "Uczestnik sezonu {n}" }),
});

function titleOf(tier, seasonNo, language) {
  const t = Object.prototype.hasOwnProperty.call(TITLES, tier) ? TITLES[tier] : null;
  const text = t ? t[language === "pl" ? "pl" : "en"] : null;
  return text ? text.replace("{n}", String(seasonNo)) : null;
}

module.exports = { TITLES, titleOf };
