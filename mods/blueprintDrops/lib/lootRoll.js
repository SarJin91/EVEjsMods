"use strict";

function shouldRollBlueprint(options) {
  return !(options !== null && typeof options === "object" && options.extraRoll === true);
}

module.exports = { shouldRollBlueprint };
