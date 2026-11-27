"use strict";

function isThenable(value) {
  return value !== null && (typeof value === "object" || typeof value === "function")
    && typeof value.then === "function";
}

function afterValue(value, onValue, onError) {
  if (!isThenable(value)) return onValue(value);
  return Promise.resolve(value).then(onValue, onError);
}

module.exports = { isThenable, afterValue };
