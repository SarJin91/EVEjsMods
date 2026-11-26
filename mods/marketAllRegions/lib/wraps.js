"use strict";

const WRAPPED = Symbol.for("evejs.marketAllRegions.wrapped");

function toPositiveInteger(value) {
  let numeric = Number.NaN;
  if (typeof value === "number") numeric = value;
  else if (typeof value === "bigint") numeric = Number(value);
  else if (typeof value === "string") {
    const trimmed = value.trim();
    const pythonLong = trimmed.match(/^(-?\d+)[lL]$/u);
    numeric = trimmed === "" ? Number.NaN : Number(pythonLong ? pythonLong[1] : trimmed);
  } else if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")) {
    return toPositiveInteger(value.value);
  }
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function sessionRegionID(session) {
  for (const key of ["regionid", "regionID"]) {
    const value = toPositiveInteger(session && session[key]);
    if (value > 0) return value;
  }
  return 0;
}

function markWrapped(fn) {
  Object.defineProperty(fn, WRAPPED, { value: true });
  return fn;
}

function wrapGetOrders(proto, { als, state }) {
  const previous = proto && proto.Handle_GetOrders;
  if (typeof previous !== "function") return { ok: false, reason: "missing-method" };
  if (previous[WRAPPED]) return { ok: false, reason: "already-wrapped" };

  const wrapped = function Handle_GetOrders(args, session) {
    if (state.inert) return previous.apply(this, arguments);
    let scope = null;
    try {
      const typeID = Number(args && args.length > 0 ? args[0] : 0) || 0;
      const regionID = sessionRegionID(session);
      if (typeID && regionID) scope = { regionID, typeID, consumed: false };
    } catch (_error) {
      scope = null;
    }
    if (!scope) return previous.apply(this, arguments);
    return als.run(scope, () => previous.apply(this, arguments));
  };
  proto.Handle_GetOrders = markWrapped(wrapped);
  return { ok: true };
}

function wrapDaemonCall(proto, { als, state, reader }) {
  const previous = proto && proto.call;
  if (typeof previous !== "function") return { ok: false, reason: "missing-method" };
  if (previous[WRAPPED]) return { ok: false, reason: "already-wrapped" };

  const wrapped = function call(method, params, options) {
    if (state.inert) return previous.apply(this, arguments);
    const store = als.getStore();
    if (
      !store ||
      store.consumed ||
      method !== "GetOrders" ||
      !params ||
      params.region_id !== store.regionID ||
      params.type_id !== store.typeID
    ) {
      return previous.apply(this, arguments);
    }
    const self = this;
    const originalArguments = arguments;
    try {
      store.consumed = true;
      const typeID = store.typeID;
      return reader.read({
        ownRegionID: store.regionID,
        typeID,
        callRegion: (regionID) => previous.call(self, "GetOrders", { region_id: regionID, type_id: typeID }, options),
      });
    } catch (error) {
      reader.recordWrapperError(error);
      return previous.apply(self, originalArguments);
    }
  };
  proto.call = markWrapped(wrapped);
  return { ok: true };
}

module.exports = {
  WRAPPED,
  sessionRegionID,
  toPositiveInteger,
  wrapDaemonCall,
  wrapGetOrders,
};
