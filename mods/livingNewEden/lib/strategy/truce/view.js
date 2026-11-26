"use strict";

function targetHostilityOf(isHostile, partners) {
  if (!Array.isArray(partners) || partners.length === 0) return isHostile;
  const truced = new Set(partners);
  return (o) => !truced.has(o) && isHostile(o);
}

module.exports = { targetHostilityOf };
