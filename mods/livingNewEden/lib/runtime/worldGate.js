"use strict";

const WORLD_ROLE = "world";

function evaluateWorldGate(input) {
  const diag = {
    pid: process.pid,
    isMainThread: input.isMainThread === true,
    envRole: input.envRole,
    processRole: input.processRole,
    hasProcessSend: input.hasProcessSend === true,
    mainFilename: input.mainFilename === undefined ? null : input.mainFilename,
  };
  let reason = null;
  if (input.isMainThread !== true) reason = "not_main_thread";
  else if (input.envRole !== WORLD_ROLE) reason = `env_role_not_world:${input.envRole || "unset"}`;
  else if (input.processRole === undefined) reason = "gamestore_role_unknown";
  else if (input.processRole !== WORLD_ROLE) reason = `gamestore_role_not_world:${input.processRole}`;
  return { ok: reason === null, reason, diag };
}

module.exports = {
  WORLD_ROLE,
  evaluateWorldGate,
};
