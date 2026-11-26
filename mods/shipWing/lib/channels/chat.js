"use strict";

const { REFUSAL, PER_SHIP_REFUSAL, CARGO_REFUSAL } = require("../core/reasons");
const { EWAR_KIND } = require("../adapter/ewarAccess");

const VERBS = Object.freeze(["launch", "return", "status", "ui", "hold", "mine", "attack", "salvage", "drones",
  "formation", "board", "store", "cargo", "move"]);
const HOST_WORD = "host";
const HOLD_TEXT = Object.freeze({ mining: "mining", cargo: "cargo", fleet: "fleet" });
const CARGO_TEXT = Object.freeze({
  COOLDOWN: "wait a moment before the next move",
  TARGET_INVALID: "the target is not your ship or a ship in its bay",
  HOST_INVALID: "your ship is not available",
  ITEM_NOT_FOUND: "the item is gone",
  ITEM_INVALID: "ships are not moved this way",
  SOURCE_INVALID: "the item is not in a hold of your ship or its bay ships",
  FLAG_INVALID: "that hold does not exist there",
  SAME_HOLD: "it is already there",
  TYPE_NOT_ALLOWED: "no hold there takes it",
  NO_ROOM: "no room there",
  QUANTITY_INVALID: "nothing to move",
  MOVE_FAILED: "the server refused the move",
});
const STORE_TEXT = Object.freeze({
  NONE: "Ship Wing: hauler none - ore of full copies goes to your ship.",
  OFF: "Ship Wing: hauler off - ore of full copies goes to your ship.",
});
const BOARD_STATES = Object.freeze(["ACTIVE", "RETURNING"]);
const BOARD_OFF_TEXT = "Ship Wing: boarding a copy is off on this server.";
const TASK_DONE_TEXT = Object.freeze({ hold: "holding", mine: "mining", attack: "attacking", salvage: "salvaging" });

const REFUSAL_TEXT = Object.freeze({
  DISABLED: "Ship Wing is not running on this server",
  UNSUPPORTED_VERB: "unknown order",
  NOT_IN_SPACE: "you must be in space, in a ship with a Ship Maintenance Bay",
  OWNER_WARPING: "not while you warp or dock",
  NOT_IN_SMB: "not in your Ship Maintenance Bay",
  NOT_OWNER: "not your ship",
  SHIP_NOT_ASSEMBLED: "packaged",
  MISSING_SKILLS: "you cannot fly it (skills)",
  LIMIT: "wing limit reached",
  ALREADY_DEPLOYED: "already out",
  NOT_DEPLOYED: "not out",
  SCENE_NOT_LOADED: "your system is not ready, try again",
  SPAWN_FAILED: "the copy could not be launched",
  STORE_WRITE_FAILED: "Ship Wing cannot save its state, nothing launched",
  GUARDS_UNAVAILABLE: "Ship Wing protection is not active, nothing launched",
  COOLDOWN: "wait a moment before the next launch",
  LOST_UNSETTLED: "its copy was lost, the ship stays locked",
  LOSS_UNAVAILABLE: "Ship Wing loss handling is not active, nothing launched",
  NO_MINING_MODULE: "no mining module online",
  NO_MINEABLE: "no rock in range",
  TARGET_INVALID: "no module of the copy can be used on that target",
  TASK_UNAVAILABLE: "this order is not available now",
  DERIVED_GUARD_UNAVAILABLE: "Ship Wing copy protection is not active, nothing launched",
  NO_WEAPONS: "no turret online",
  NO_TARGET: "no target - shoot or lock an NPC first",
  TARGET_NOT_NPC: "copies attack only NPC ships and NPC site structures",
  TARGET_OUT_OF_RANGE: "the target is too far from your ship",
  NO_AMMO: "out of ammo - return it to reload",
  ENDING: "it is already going back",
  CAP_UNSTABLE: "capacitor not stable - launch refused (policy refuse)",
  TICK_UNAVAILABLE: "Ship Wing tick is not running, nothing launched",
  DRONES_UNAVAILABLE: "copy drones are off on this server",
  MODE_INVALID: "the drone mode is auto or off",
  ENGAGE_UNAVAILABLE: "the F mirror is off on this server",
  FORMATION_UNAVAILABLE: "formations are off on this server",
  FORMATION_INVALID: "the formation is none, wedge, line, column or sphere",
  NO_SALVAGER: "no salvager online",
  NO_WRECK: "no wreck in range",
  HOST_EMPTY: "the ship that launched it is empty - the copy only holds",
});

const STATE_TEXT = Object.freeze({
  IN_BAY: "in bay", LAUNCHING: "launching", ACTIVE: "out", RETURNING: "returning", LOST: "LOST",
});

const TASK_TEXT = Object.freeze({ FOLLOW: "following", HOLD: "holding", MINE: "mining", ATTACK: "attacking",
  SALVAGE: "salvaging" });

const PER_SHIP = PER_SHIP_REFUSAL;

const WINDOW_TEXT = Object.freeze({
  OFF: "Ship Wing: the wing window is off on this server.",
  NOT_READY: "Ship Wing: the window is not available on your client (see the server log).",
  FAILED: "Ship Wing: the window could not be opened, try again.",
  OPENED: "Ship Wing: window opened.",
});

const UI_AUTO_TEXT = Object.freeze({
  ON: "Ship Wing: the wing window opens at login: on.",
  OFF: "Ship Wing: the wing window opens at login: off.",
  SET_ON: "Ship Wing: the wing window will open at each login",
  SET_OFF: "Ship Wing: the wing window will not open at login",
  NOT_SAVED: " (until restart, not saved)",
  FULL: "Ship Wing: the login window list is full on this server, not saved.",
  USAGE: "ui auto on|off",
});

function parse(text, trigger) {
  const word = String(trigger || "").trim().toLowerCase();
  if (word === "") return null;
  const parts = String(text === undefined || text === null ? "" : text).trim().split(/\s+/);
  if (parts[0].toLowerCase() !== word) return null;
  const verb = String(parts[1] || "").toLowerCase();
  if (!VERBS.includes(verb)) return { verb: "help", filter: "" };
  return { verb, filter: parts.slice(2).join(" ") };
}

function refusalText(code) {
  return Object.prototype.hasOwnProperty.call(REFUSAL_TEXT, code) ? REFUSAL_TEXT[code] : String(code);
}

function cargoText(code) {
  return Object.prototype.hasOwnProperty.call(CARGO_TEXT, code) ? CARGO_TEXT[code] : refusalText(code);
}

function label(ship) {
  return ship.name ? String(ship.name) : `ship ${ship.shipItemId}`;
}

function matches(ship, filter) {
  if (!filter) return true;
  const f = filter.toLowerCase();
  return label(ship).toLowerCase().includes(f) || String(ship.typeId) === filter || String(ship.shipItemId) === filter;
}

function formatUsage(trigger, windowOn = false, holdOn = false, mineOn = false, attackOn = false, dronesOn = false,
  formationOn = false, salvageOn = false, boardOn = false, uiAutoOn = false, storeOn = false, cargoOn = false) {
  return `Ship Wing: ${trigger} launch [name] | ${trigger} return [name] | ${trigger} status`
    + `${holdOn ? ` | ${trigger} hold [name]` : ""}${mineOn ? ` | ${trigger} mine [name]` : ""}`
    + `${storeOn ? ` | ${trigger} store [name|off]` : ""}`
    + `${cargoOn ? ` | ${trigger} cargo [name] | ${trigger} move <from> to <to|${HOST_WORD}> [type]` : ""}`
    + `${attackOn ? ` | ${trigger} attack [name]` : ""}${salvageOn ? ` | ${trigger} salvage [name]` : ""}`
    + `${dronesOn ? ` | ${trigger} drones auto|off [name]` : ""}`
    + `${formationOn ? ` | ${trigger} formation [name]` : ""}${boardOn ? ` | ${trigger} board [name]` : ""}`
    + `${windowOn ? ` | ${trigger} ui${uiAutoOn ? " [auto on|off]" : ""}` : ""}`;
}

function runBoard(board, core, session, charId, filter) {
  const view = core.listWing(charId);
  const flying = view.ships.filter((s) => BOARD_STATES.includes(s.state) && Number(s.entityId) > 0
    && matches(s, filter));
  if (flying.length === 0) {
    return filter ? `Ship Wing: no wing copy matching "${filter}" out.` : "Ship Wing: no wing copy out.";
  }
  const dist = (s) => (Number.isFinite(s.distanceM) ? s.distanceM : Infinity);
  const target = filter ? flying[0] : flying.reduce((best, s) => (dist(s) < dist(best) ? s : best));
  let result;
  try {
    result = board(charId, Number(target.entityId), session);
  } catch (_err) {
    result = null;
  }
  if (result && result.ok === true) return `Ship Wing: you board ${label(target)}.`;
  const text = result && typeof result.text === "string" && result.text !== "" ? result.text
    : "That wing copy is not available to board.";
  return `Ship Wing: ${label(target)} not boarded - ${text}`;
}

function runFormation(core, charId, filter) {
  if (core.formationOn !== true || typeof core.setFormation !== "function") {
    return `Ship Wing: ${refusalText("FORMATION_UNAVAILABLE")}.`;
  }
  const name = String(filter || "").trim().split(/\s+/)[0] || "";
  if (name === "") {
    const view = core.listWing(charId);
    const current = view && typeof view.formation === "string" ? view.formation : "none";
    const options = Array.isArray(core.FORMATIONS) ? core.FORMATIONS.join("|") : "";
    return `Ship Wing: formation ${current} (${options})`;
  }
  const result = core.setFormation(charId, name);
  if (result && result.ok === true) {
    return `Ship Wing: formation ${result.formation}${result.persisted === true ? "" : " (until restart, not saved)"}.`;
  }
  return `Ship Wing: formation not set (${refusalText(result ? result.reason : "FORMATION_UNAVAILABLE")}).`;
}

function runStore(core, charId, filter) {
  const word = String(filter || "").trim();
  if (word.toLowerCase() === "off") {
    const result = core.setCargoStore(charId, null);
    return result && result.ok === true ? STORE_TEXT.OFF
      : `Ship Wing: hauler not set (${refusalText(result ? result.reason : "DISABLED")}).`;
  }
  const view = core.listWing(charId);
  const ships = Array.isArray(view && view.ships) ? view.ships : [];
  if (word === "") {
    const id = typeof core.cargoStoreOf === "function" ? Number(core.cargoStoreOf(view && view.hostShipId)) || 0 : 0;
    if (id <= 0) return STORE_TEXT.NONE;
    const ship = ships.find((s) => Number(s.shipItemId) === id);
    return `Ship Wing: hauler ${ship ? label(ship) : `ship ${id}`}.`;
  }
  const target = ships.find((s) => s.state === "IN_BAY" && matches(s, word));
  if (!target) return `Ship Wing: no ship matching "${word}" in your bay.`;
  const result = core.setCargoStore(charId, Number(target.shipItemId));
  if (result && result.ok === true) return `Ship Wing: hauler ${label(target)}.`;
  return `Ship Wing: hauler not set (${refusalText(result ? result.reason : "DISABLED")}).`;
}

function cargoShip(view, text) {
  const word = String(text || "").trim();
  if (word === "") return null;
  const ships = Array.isArray(view && view.ships) ? view.ships : [];
  if (word.toLowerCase() === HOST_WORD) return ships.find((s) => s.host === true) || null;
  return ships.find((s) => matches(s, word)) || null;
}

function cargoLabel(ship) {
  return ship.host === true ? `${label(ship)} (your ship)` : label(ship);
}

function cargoItemsText(items) {
  const byType = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = `${item.typeId}:${item.name}`;
    const row = byType.get(key) || { name: item.name, qty: 0 };
    row.qty += Number(item.qty) || 0;
    byType.set(key, row);
  }
  return [...byType.values()].map((r) => `${r.name} x${r.qty}`).join(", ");
}

function formatCargo(view, filter) {
  const ships = (Array.isArray(view.ships) ? view.ships : []).filter((s) => !filter
    || (filter.trim().toLowerCase() === HOST_WORD ? s.host === true : matches(s, filter)));
  if (ships.length === 0) return `Ship Wing: no ship matching "${filter}" (your ship or its bay).`;
  const rows = ships.map((s) => {
    const holds = (Array.isArray(s.holds) ? s.holds : []).map((h) => {
      const items = cargoItemsText(h.items);
      return `${HOLD_TEXT[h.kind] || h.kind} ${Math.round(h.usedM3)}/${Math.round(h.capacityM3)} m3`
        + `${items ? `: ${items}` : ""}`;
    });
    return `${cargoLabel(s)} [${holds.length > 0 ? holds.join("; ") : "no holds"}]`;
  });
  const more = Number(view.truncated) > 0 ? ` (+${view.truncated} more stacks)` : "";
  return `Ship Wing cargo: ${rows.join(" | ")}${more}`;
}

function runCargo(core, charId, filter) {
  const view = core.cargoOf(charId);
  if (!view || view.ok !== true) return `Ship Wing: no cargo list (${cargoText(view ? view.reason : "DISABLED")}).`;
  return formatCargo(view, String(filter || "").trim());
}

function runMove(core, charId, filter, trigger) {
  const words = String(filter || "").trim().split(/\s+/).filter(Boolean);
  const at = words.findIndex((w, i) => i > 0 && w.toLowerCase() === "to");
  const usage = `Ship Wing: ${trigger} move <from> to <to|${HOST_WORD}> [type]`;
  if (at < 1 || at === words.length - 1) return usage;
  const view = core.cargoOf(charId);
  if (!view || view.ok !== true) return `Ship Wing: cargo not moved (${cargoText(view ? view.reason : "DISABLED")}).`;
  const fromText = words.slice(0, at).join(" ");
  let from = cargoShip(view, fromText);
  if (!from) return `Ship Wing: no ship matching "${fromText}" (your ship or its bay).`;
  if (Number(from.truncated) > 0) {
    const again = core.cargoOf(charId, from.shipItemId);
    const ship = again && again.ok === true && Array.isArray(again.ships)
      ? again.ships.find((s) => s.shipItemId === from.shipItemId) : null;
    if (ship) from = ship;
  }
  const rest = words.slice(at + 1);
  let to = null;
  let type = "";
  for (let k = rest.length; k >= 1 && !to; k -= 1) {
    to = cargoShip(view, rest.slice(0, k).join(" "));
    if (to) type = rest.slice(k).join(" ");
  }
  if (!to) return `Ship Wing: no ship matching "${rest.join(" ")}" (your ship or its bay).`;
  if (to.shipItemId === from.shipItemId) return "Ship Wing: from and to are the same ship.";
  const t = type.toLowerCase();
  const items = (Array.isArray(from.holds) ? from.holds : []).flatMap((h) => (Array.isArray(h.items) ? h.items : []))
    .filter((i) => !t || String(i.name).toLowerCase().includes(t) || String(i.typeId) === type);
  if (items.length === 0) return `Ship Wing: no cargo${type ? ` matching "${type}"` : ""} in ${label(from)}.`;
  const result = core.moveCargo(charId, { items: items.map((i) => ({ itemId: i.itemId, quantity: null })),
    toShipItemId: to.shipItemId, toFlag: null });
  if (!result || !Array.isArray(result.results) || result.results.length === 0) {
    return `Ship Wing: cargo not moved (${cargoText(result ? result.reason : "DISABLED")}).`;
  }
  const done = cargoItemsText(result.results.filter((r) => r.ok === true)
    .map((r) => ({ typeId: r.typeId, name: r.name, qty: r.movedQty })));
  const reasons = [...new Set(result.results.filter((r) => r.ok !== true).map((r) => r.reason))];
  const parts = [];
  if (done) parts.push(`moved ${done} (${Math.round(result.movedM3 || 0)} m3) from ${label(from)} to ${label(to)}`);
  for (const r of result.results) {
    if (r.ok !== true || !(Number(r.leftQty) > 0)) continue;
    const why = typeof r.stopReason === "string" && r.stopReason !== "" ? r.stopReason : "NO_ROOM";
    if (!reasons.includes(why)) reasons.push(why);
  }
  if (reasons.length > 0) parts.push(`${done ? "the rest " : ""}not moved (${reasons.map(cargoText).join(", ")})`);
  if (Number(result.skipped) > 0) parts.push(`${result.skipped} more stacks next time`);
  if (Number(from.truncated) > 0) parts.push(`${from.truncated} stacks not listed, move again for them`);
  return `Ship Wing: ${parts.join("; ")}.`;
}

function runOpenWindow(openWindow, charId) {
  if (typeof openWindow !== "function") return WINDOW_TEXT.OFF;
  let result;
  try {
    result = openWindow(charId);
  } catch (_err) {
    return WINDOW_TEXT.FAILED;
  }
  if (result && result.ok === true) return WINDOW_TEXT.OPENED;
  const reason = result ? result.reason : null;
  if (reason === "WINDOW_OFF") return WINDOW_TEXT.OFF;
  if (reason === "CLIENT_NOT_READY" || reason === "SESSION_CHANGED") return WINDOW_TEXT.NOT_READY;
  return WINDOW_TEXT.FAILED;
}

function runUiAuto(uiAuto, charId, word, trigger) {
  const mode = String(word || "").toLowerCase();
  const has = uiAuto && typeof uiAuto.get === "function" && typeof uiAuto.set === "function";
  if (mode === "") {
    if (!has) return UI_AUTO_TEXT.OFF;
    let got;
    try {
      got = uiAuto.get(charId);
    } catch (_err) {
      got = null;
    }
    return got && got.ok === true && got.openAtLogin === true ? UI_AUTO_TEXT.ON : UI_AUTO_TEXT.OFF;
  }
  if (mode !== "on" && mode !== "off") return `Ship Wing: ${trigger} ${UI_AUTO_TEXT.USAGE}`;
  if (!has) return WINDOW_TEXT.OFF;
  let result;
  try {
    result = uiAuto.set(charId, mode === "on");
  } catch (_err) {
    result = null;
  }
  if (result && result.ok === true) {
    return `${result.openAtLogin ? UI_AUTO_TEXT.SET_ON : UI_AUTO_TEXT.SET_OFF}`
      + `${result.persisted === true ? "" : UI_AUTO_TEXT.NOT_SAVED}.`;
  }
  if (result && result.reason === "FULL") return UI_AUTO_TEXT.FULL;
  if (result && result.reason === "WINDOW_OFF") return WINDOW_TEXT.OFF;
  return WINDOW_TEXT.FAILED;
}

function formatOutcome(verbText, outcome) {
  const parts = [];
  if (outcome.done.length > 0) parts.push(`${verbText} ${outcome.done.join(", ")}`);
  if (outcome.refused.length > 0) {
    const refused = outcome.refused.map(([name, code]) => `${name} (${refusalText(code)})`);
    parts.push(`not ${verbText}: ${refused.join(", ")}`);
  }
  return `Ship Wing: ${parts.join("; ")}.`;
}

function activeText(active) {
  if (!active || typeof active !== "object" || typeof active.cap !== "string") return "";
  let text = `, cap ${active.cap}`;
  const names = Array.isArray(active.shedNames) ? active.shedNames.filter((n) => typeof n === "string" && n) : [];
  if (Number(active.shed) > 0) text += names.length > 0 ? ` (off: ${names.join(", ")})` : ` (${active.shed} off)`;
  if (Number(active.nosCreditGJs) > 0) text += `, nos +${Number(active.nosCreditGJs).toFixed(1)} GJ/s`;
  if (Number(active.alwaysOn) > 0) text += `, always-on ${active.alwaysOn}`;
  if (Number(active.localRep) > 0) text += `, local rep ${active.localRep}`;
  if (active.logi === true && Number(active.remote) > 0) text += `, RR ${active.remote}`;
  if (active.repairing === "host" || active.repairing === "twin") {
    text += `, repairing ${active.repairing === "host" ? "host" : "copy"}`;
  }
  if (Number(active.ewar) > 0) {
    text += `, EWAR ${active.ewar}`;
    const on = Array.isArray(active.ewarOn) ? active.ewarOn.filter((k) => EWAR_KIND.includes(k)) : [];
    if (on.length > 0) text += ` (on: ${on.join(", ")})`;
  }
  return text;
}

function formatStatus(view) {
  const head = `Ship Wing ${view.deployedCount}/${view.limit} out`
    + `${view.refusal ? ` (${refusalText(view.refusal)})` : ""}`;
  if (!Array.isArray(view.ships) || view.ships.length === 0) return `${head}: no ships in the bay.`;
  const rows = view.ships.map((s) => {
    let detail = STATE_TEXT[s.state] || String(s.state);
    if (Number.isFinite(s.distanceM)) detail += ` ${Math.round(s.distanceM)} m`;
    if (typeof s.task === "string" && s.task !== "") detail += `, ${TASK_TEXT[s.task] || s.task.toLowerCase()}`;
    if (typeof s.taskSub === "string" && s.taskSub !== "") detail += ` (${s.taskSub.toLowerCase().replace("_", " ")})`;
    if (Number.isFinite(s.holdM3) && s.holdM3 > 0) detail += `, ${Math.round(s.holdM3)} m3`;
    detail += activeText(s.active);
    if (s.state === "ACTIVE" && s.drones && typeof s.drones === "object") {
      detail += `, drones ${Number(s.drones.out) || 0}/${Number.isFinite(s.drones.max) ? s.drones.max : "?"} `
        + `${String(s.drones.mode || "")}`;
    }
    if (s.state === "IN_BAY" && !s.eligible && s.refusal && s.refusal !== view.refusal) {
      detail += ` - ${refusalText(s.refusal)}`;
    }
    return `${label(s)} [${detail}]`;
  });
  return `${head}: ${rows.join(" | ")}`;
}

function runLaunch(core, charId, filter, commandId) {
  const view = core.listWing(charId);
  const inBay = view.ships.filter((s) => s.state === "IN_BAY" && matches(s, filter));
  let targets = inBay.filter((s) => s.eligible);
  if (filter) targets = targets.slice(0, 1);
  if (targets.length === 0) {
    if (view.refusal) return `Ship Wing: ${refusalText(view.refusal)}.`;
    if (inBay.length === 0) {
      return filter ? `Ship Wing: no ship matching "${filter}" in your bay.` : "Ship Wing: no ships in your bay.";
    }
    const first = filter ? inBay.slice(0, 1) : inBay;
    return formatOutcome("launched", { done: [], refused: first.map((s) => [label(s), s.refusal]) });
  }
  const outcome = { done: [], refused: [] };
  for (const ship of targets) {
    const result = core.orderCopy(charId, ship.shipItemId, "launch", { commandId });
    if (result && result.ok) {
      outcome.done.push(label(ship));
      continue;
    }
    const code = result ? result.reason : "SPAWN_FAILED";
    outcome.refused.push([label(ship), code]);
    if (!PER_SHIP.includes(code)) break;
  }
  return formatOutcome("launched", outcome);
}

function runReturn(core, charId, filter) {
  const view = core.listWing(charId);
  let targets = view.ships.filter((s) => s.state === "ACTIVE" && matches(s, filter));
  if (filter) targets = targets.slice(0, 1);
  if (targets.length === 0) {
    const returning = view.ships.some((s) => s.state === "RETURNING");
    return returning ? "Ship Wing: your wing is already returning." : "Ship Wing: no wing copy out.";
  }
  const outcome = { done: [], refused: [] };
  for (const ship of targets) {
    const result = core.orderCopy(charId, ship.shipItemId, "return");
    if (result && result.ok) outcome.done.push(label(ship));
    else outcome.refused.push([label(ship), result ? result.reason : "NOT_DEPLOYED"]);
  }
  return formatOutcome("returning", outcome);
}

function runTask(core, charId, verb, filter) {
  const view = core.listWing(charId);
  let targets = view.ships.filter((s) => s.state === "ACTIVE" && matches(s, filter));
  if (filter) targets = targets.slice(0, 1);
  if (targets.length === 0) return "Ship Wing: no wing copy out.";
  const outcome = { done: [], refused: [] };
  for (const ship of targets) {
    const result = core.orderCopy(charId, ship.shipItemId, verb);
    if (result && result.ok) {
      outcome.done.push(label(ship));
      continue;
    }
    const code = result ? result.reason : "TASK_UNAVAILABLE";
    outcome.refused.push([label(ship), code]);
    if (!PER_SHIP.includes(code)) break;
  }
  return formatOutcome(TASK_DONE_TEXT[verb], outcome);
}

function runDrones(core, charId, filter, trigger) {
  const words = String(filter || "").trim().split(/\s+/).filter(Boolean);
  const mode = String(words[0] || "").toLowerCase();
  if (mode !== "auto" && mode !== "off") return `Ship Wing: ${trigger} drones auto|off [name]`;
  const name = words.slice(1).join(" ");
  const view = core.listWing(charId);
  let targets = view.ships.filter((s) => s.state === "ACTIVE" && matches(s, name));
  if (name) targets = targets.slice(0, 1);
  if (targets.length === 0) return "Ship Wing: no wing copy out.";
  const outcome = { done: [], refused: [] };
  for (const ship of targets) {
    const result = core.setDroneMode(charId, ship.shipItemId, mode);
    if (result && result.ok) {
      outcome.done.push(label(ship));
      continue;
    }
    const code = result ? result.reason : "DRONES_UNAVAILABLE";
    outcome.refused.push([label(ship), code]);
    if (!PER_SHIP.includes(code)) break;
  }
  return formatOutcome(`drones ${mode}`, outcome);
}

function createChatChannel(deps) {
  const trigger = String(deps.trigger || "!wing");
  const windowOn = typeof deps.openWindow === "function";
  const supported = Array.isArray(deps.core.SUPPORTED_VERBS) ? deps.core.SUPPORTED_VERBS : [];
  const holdOn = supported.includes("hold");
  const mineOn = supported.includes("mine");
  const attackOn = supported.includes("attack");
  const salvageOn = supported.includes("salvage");
  const dronesOn = deps.core.dronesOn === true && typeof deps.core.setDroneMode === "function";
  const formationOn = deps.core.formationOn === true && typeof deps.core.setFormation === "function";
  const boardOn = typeof deps.board === "function";
  const uiAutoOn = Boolean(deps.uiAuto && typeof deps.uiAuto.get === "function"
    && typeof deps.uiAuto.set === "function");
  const storeOn = deps.core.cargoStoreOn === true && typeof deps.core.setCargoStore === "function";
  const cargoOn = deps.core.cargoOn === true && typeof deps.core.cargoOf === "function"
    && typeof deps.core.moveCargo === "function";
  const usage = () => formatUsage(trigger, windowOn, holdOn, mineOn, attackOn, dronesOn, formationOn, salvageOn,
    boardOn, uiAutoOn, storeOn, cargoOn);
  let seq = 0;
  return {
    match: (text) => parse(text, trigger) !== null,
    handle(session, text) {
      const cmd = parse(text, trigger);
      if (cmd === null) return usage();
      const charId = deps.characterIdOf(session);
      if (!(charId > 0)) return "Ship Wing: no character on this session.";
      if (cmd.verb === "ui") {
        const words = cmd.filter.split(/\s+/).filter(Boolean);
        return String(words[0] || "").toLowerCase() === "auto" ? runUiAuto(deps.uiAuto, charId, words[1], trigger)
          : runOpenWindow(deps.openWindow, charId);
      }
      if (cmd.verb === "status") return formatStatus(deps.core.listWing(charId));
      if (cmd.verb === "return") return runReturn(deps.core, charId, cmd.filter);
      if (cmd.verb === "hold" || cmd.verb === "mine" || cmd.verb === "attack" || cmd.verb === "salvage") {
        return supported.includes(cmd.verb) ? runTask(deps.core, charId, cmd.verb, cmd.filter)
          : `Ship Wing: ${refusalText("UNSUPPORTED_VERB")}.`;
      }
      if (cmd.verb === "launch") {
        seq += 1;
        return runLaunch(deps.core, charId, cmd.filter, `chat-${seq}`);
      }
      if (cmd.verb === "drones") {
        return typeof deps.core.setDroneMode === "function" ? runDrones(deps.core, charId, cmd.filter, trigger)
          : `Ship Wing: ${refusalText("DRONES_UNAVAILABLE")}.`;
      }
      if (cmd.verb === "formation") return runFormation(deps.core, charId, cmd.filter);
      if (cmd.verb === "store") return storeOn ? runStore(deps.core, charId, cmd.filter) : usage();
      if (cmd.verb === "cargo") return cargoOn ? runCargo(deps.core, charId, cmd.filter) : usage();
      if (cmd.verb === "move") return cargoOn ? runMove(deps.core, charId, cmd.filter, trigger) : usage();
      if (cmd.verb === "board") {
        return boardOn ? runBoard(deps.board, deps.core, session, charId, cmd.filter) : BOARD_OFF_TEXT;
      }
      return usage();
    },
    commandCount: () => seq,
  };
}

const MISSING_TEXT = REFUSAL.filter((code) => !Object.prototype.hasOwnProperty.call(REFUSAL_TEXT, code));
const MISSING_CARGO_TEXT = CARGO_REFUSAL.filter((code) => cargoText(code) === code);

module.exports = {
  VERBS, REFUSAL_TEXT, STATE_TEXT, TASK_TEXT, PER_SHIP, WINDOW_TEXT, UI_AUTO_TEXT, MISSING_TEXT, CARGO_TEXT,
  MISSING_CARGO_TEXT, parse, refusalText, cargoText, formatUsage, formatOutcome, formatStatus, formatCargo,
  createChatChannel,
};
