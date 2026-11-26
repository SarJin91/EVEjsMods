"use strict";

function positive(v) {
  return Number.isSafeInteger(v) && v > 0 ? v : null;
}

function mergePriceRefs(local, ext, params) {
  const localAsk = local ? positive(local.askMilli) : null;
  const base = local ? positive(local.baseMilli) : null;
  let extRejected = null;
  const extBid = ext ? positive(ext.bidMilli) : null;
  const extAsk = ext ? positive(ext.askMilli) : null;
  if (localAsk === null && !(params && params.localClean === true)) return { refs: null, extRejected: null };
  if (extBid !== null && extAsk !== null) {
    const ratio = params && Number.isSafeInteger(params.maxRatio) && params.maxRatio > 0 ? params.maxRatio : null;
    if (base !== null && ratio !== null && (extBid > base * ratio || extBid * ratio < base)) {
      extRejected = "DEVIATION";
    } else {
      return {
        refs: {
          bidMilli: extBid,
          askMilli: localAsk === null ? extAsk
            : (params && params.askCapIncludesExternal === true ? Math.min(localAsk, extAsk) : localAsk),
          baseMilli: base,
          origin: "external",
        },
        extRejected: null,
      };
    }
  }
  if (localAsk === null) return { refs: null, extRejected };
  return {
    refs: {
      bidMilli: local.bidMilli === undefined ? null : local.bidMilli,
      askMilli: localAsk,
      baseMilli: local.baseMilli === undefined ? null : local.baseMilli,
      origin: "local",
    },
    extRejected,
  };
}

function mulDivCeil(a, b, d) {
  const r = Math.floor(a / d) * b + Math.ceil(((a % d) * b) / d);
  return Number.isSafeInteger(r) ? r : null;
}

function basePriceRefs(local, params) {
  if (!local || positive(local.askMilli) !== null) return null;
  const base = positive(local.baseMilli);
  if (base === null || !params) return null;
  const permille = params.askPermille;
  if (!Number.isSafeInteger(permille) || permille < 1000 || permille > 3000) return null;
  const max = params.maxUnitPriceMilli;
  if (!Number.isSafeInteger(max) || max < 1) return null;
  const ask = mulDivCeil(base, permille, 1000);
  if (ask === null || ask > max) return null;
  return { bidMilli: null, askMilli: ask, baseMilli: base, origin: "base" };
}

module.exports = { mergePriceRefs, basePriceRefs };
