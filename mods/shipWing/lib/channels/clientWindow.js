"use strict";

const { UI_CONTINUE, CLIENT_REFUSAL, ALL_VERBS } = require("../core/reasons");
const { FLYING_STATES } = require("../core/states");
const { ACTIVE_ORDER } = require("../core/twinRunning");

const WIRE_VERSION = 2;
const REPORT_PROTO = 1;
const RATE_WINDOW_MS = 1000;
const SWEEP_WINDOWS = 10;
const MAX_NAME_CHARS = 64;
const MAX_VERB_CHARS = 16;
const MAX_REPORT_ITEMS = 64;
const MAX_REPORT_ITEM_CHARS = 96;
const MAX_REPORT_LINE_CHARS = 2048;
const REPORT_ITEM_RE = /^[A-Za-z0-9_.:=-]+$/;
const EVENT_PREFIX = "ui.";
const VERB_RE = /^[\x21-\x7e]+$/;
const HP_MAX = 1000;
const FORMATION_NAME_RE = /^[a-z]{1,16}$/;
const BOARD_VERB = "board";
const BOARD_ROW_STATES = Object.freeze(["ACTIVE", "RETURNING"]);

function intOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function posSafeInt(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function textOrNull(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function shortText(value) {
  return Array.from(String(value === undefined || value === null ? "" : value)).slice(0, MAX_NAME_CHARS).join("");
}

function shortTextOrNull(value) {
  const text = textOrNull(value);
  return text === null ? null : shortText(text);
}

function hpOrNull(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const out = [];
  for (const raw of value) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
    out.push(Math.min(HP_MAX, Math.max(0, Math.round(raw))));
  }
  return out;
}

function rowVerbs(ship, supportedVerbs, board = null) {
  const s = ship && typeof ship === "object" ? ship : {};
  const supported = Array.isArray(supportedVerbs) ? supportedVerbs : [];
  let wanted = [];
  if (s.state === "IN_BAY" && s.eligible === true) wanted = ["launch"];
  else if (s.state === "ACTIVE") wanted = ["return", "hold", "mine", "attack", "salvage"];
  const out = ALL_VERBS.filter((verb) => wanted.includes(verb) && supported.includes(verb));
  if (board && Number.isFinite(board.rangeM) && BOARD_ROW_STATES.includes(s.state) && posSafeInt(s.entityId)
    && typeof s.distanceM === "number" && Number.isFinite(s.distanceM) && s.distanceM <= board.rangeM) {
    out.push(BOARD_VERB);
  }
  return out;
}

function rowDrones(ship) {
  const d = ship && ship.state === "ACTIVE" && ship.drones && typeof ship.drones === "object" ? ship.drones : null;
  if (!d || (d.mode !== "auto" && d.mode !== "off")) return undefined;
  return { mode: d.mode, out: Math.max(0, intOrNull(d.out) || 0), max: intOrNull(d.max) };
}

function rowEngage(ship) {
  if (!ship || ship.state !== "ACTIVE" || typeof ship.mirrorEngage !== "boolean") return undefined;
  return ship.mirrorEngage ? "on" : "off";
}

function rowActive(ship) {
  if (!ship || ship.state !== "ACTIVE" || !Array.isArray(ship.running)) return undefined;
  const codes = ACTIVE_ORDER.filter((code) => ship.running.includes(code));
  return codes.length > 0 ? codes : undefined;
}

function uiOf(config) {
  const c = config && typeof config === "object" ? config : {};
  return {
    pollMs: intOrNull(c.clientWindowPollMs) || 0,
    hpRefreshMs: intOrNull(c.clientWindowHpRefreshMs) || 0,
    rowReasonMs: intOrNull(c.clientWindowRowReasonMs) || 0,
    autoOpen: c.clientWindowAutoOpen === true,
    maxRows: intOrNull(c.clientWindowMaxRows) || 0,
    maxShips: intOrNull(c.clientWindowMaxShipsPerCommand) || 0,
    hpWarnPct: intOrNull(c.hpWarnPct) || 0,
    hpCriticalPct: intOrNull(c.hpCriticalPct) || 0,
    buttonColors: c.clientWindowButtonColors !== false,
    activeChars: intOrNull(c.clientWindowActiveChars) || 0,
  };
}

function toSnapshot(view, verbs, ui, formations, board = null) {
  const v = view && typeof view === "object" ? view : {};
  const u = ui && typeof ui === "object" ? ui : {};
  const all = (Array.isArray(v.ships) ? v.ships : []).filter((s) => s && typeof s === "object");
  const maxRows = posSafeInt(u.maxRows) ? u.maxRows : Infinity;
  let room = Math.max(0, maxRows - all.filter((s) => FLYING_STATES.includes(s.state)).length);
  const ships = all.filter((s) => {
    if (FLYING_STATES.includes(s.state)) return true;
    if (room <= 0) return false;
    room -= 1;
    return true;
  });
  const activeChars = Math.max(0, intOrNull(u.activeChars) || 0);
  const snapshot = {
    v: WIRE_VERSION,
    verbs: [...verbs],
    limit: intOrNull(v.limit) || 0,
    deployed: intOrNull(v.deployedCount) || 0,
    refusal: textOrNull(v.refusal),
    truncated: all.length - ships.length,
    ui: {
      pollMs: intOrNull(u.pollMs) || 0,
      hpRefreshMs: intOrNull(u.hpRefreshMs) || 0,
      rowReasonMs: intOrNull(u.rowReasonMs) || 0,
      autoOpen: u.autoOpen === true,
      maxShips: intOrNull(u.maxShips) || 0,
      hpWarnPct: intOrNull(u.hpWarnPct) || 0,
      hpCriticalPct: intOrNull(u.hpCriticalPct) || 0,
      buttonColors: u.buttonColors !== false,
      activeChars,
    },
    ships: ships.map((s) => {
      const row = {
        shipItemID: intOrNull(s.shipItemId) || 0,
        typeID: intOrNull(s.typeId) || 0,
        typeName: shortText(s.typeName),
        name: shortText(s.name),
        state: String(s.state || ""),
        task: textOrNull(s.task),
        eligible: s.eligible === true,
        refusal: textOrNull(s.refusal),
        entityID: intOrNull(s.entityId),
        distanceM: intOrNull(s.distanceM),
        targetID: intOrNull(s.targetId),
        targetName: shortTextOrNull(s.targetName),
        hp: hpOrNull(s.hp),
        verbs: rowVerbs(s, verbs, board),
      };
      const drones = rowDrones(s);
      if (drones) row.drones = drones;
      const engage = rowEngage(s);
      if (engage) row.engage = engage;
      const active = activeChars > 0 ? rowActive(s) : undefined;
      if (active) row.active = active;
      return row;
    }),
  };
  if (typeof v.formation === "string" && Array.isArray(formations)) {
    snapshot.formation = { current: v.formation, options: formations.filter((name) => typeof name === "string") };
  }
  return snapshot;
}

function parseReportItem(item) {
  if (typeof item !== "string" || item.length === 0 || item.length > MAX_REPORT_ITEM_CHARS) return null;
  if (!REPORT_ITEM_RE.test(item)) return null;
  const at = item.indexOf("=");
  if (at <= 0) return null;
  const key = item.slice(0, at);
  const rest = item.slice(at + 1);
  if (rest === "1") return { ok: true, text: key };
  if (rest === "0") return { ok: false, text: key };
  if (rest.startsWith("0:") && rest.length > 2) return { ok: false, text: `${key}:${rest.slice(2)}` };
  return null;
}

function createClientWindowChannel(deps) {
  const core = deps.core;
  const config = deps.config;
  const liveConfig = deps.liveConfig && typeof deps.liveConfig.get === "function" ? deps.liveConfig : null;
  const notify = deps.notify;
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const timers = deps.timers || { setTimeout, clearTimeout };
  const log = deps.log || null;
  const verbs = Array.isArray(core.SUPPORTED_VERBS) ? [...core.SUPPORTED_VERBS] : [];
  const formationOptions = core.formationOn === true && Array.isArray(core.FORMATIONS) ? [...core.FORMATIONS] : null;
  const serverBoard = typeof deps.board === "function" ? deps.board : null;
  const boardRow = serverBoard && Number.isFinite(config.boardRangeMeters) ? { rangeM: config.boardRangeMeters }
    : null;
  const cargoOn = core.cargoOn === true && typeof core.cargoOf === "function" && typeof core.moveCargo === "function";
  const uiPrefs = deps.uiPrefs && typeof deps.uiPrefs.get === "function" ? deps.uiPrefs : null;
  const loginOpenOn = uiPrefs !== null && config.clientWindowOpenAtLoginEnabled === true;
  const loginOpenDelayMs = Math.max(0, Number(config.clientWindowLoginOpenDelayMs) || 0);
  const autoOpened = new WeakMap();
  const loginTimers = new Set();

  const subscribers = new Map();
  const dirty = new Map();
  const lastSentAtMs = new Map();
  const rate = new Map();
  const lastReportAtMs = new Map();
  const lastOpenAtMs = new Map();
  const lastEventAtMs = new Map();
  const counters = {};
  let seq = 0;
  let stopped = false;
  let timer = null;
  let timerDueAt = Infinity;
  let lastSweepAt = -Infinity;
  let unsubscribe = null;

  function bump(name, by = 1) {
    counters[name] = (counters[name] || 0) + by;
  }

  function refuse(reason) {
    bump(`refused.${CLIENT_REFUSAL.includes(reason) ? reason : "INTERNAL"}`);
    return { ok: false, reason };
  }

  function debug(line) {
    try {
      if (log && typeof log.debug === "function") log.debug(line);
    } catch (_err) {
    }
  }

  function sweep(now) {
    if (now - lastSweepAt < RATE_WINDOW_MS * SWEEP_WINDOWS) return;
    lastSweepAt = now;
    for (const [charId, entry] of rate) {
      if (now - entry.windowStartMs >= RATE_WINDOW_MS * SWEEP_WINDOWS) rate.delete(charId);
    }
    for (const [charId, at] of lastReportAtMs) {
      if (now - at >= config.clientWindowReportMinIntervalMs) lastReportAtMs.delete(charId);
    }
    for (const [map, interval] of [[lastOpenAtMs, config.clientWindowOpenMinIntervalMs],
      [lastEventAtMs, config.clientWindowEventMinIntervalMs]]) {
      for (const [charId, at] of map) {
        if (now - at >= (Number(interval) || 0)) map.delete(charId);
      }
    }
    for (const [charId, ref] of subscribers) {
      if (!ref.deref()) {
        dropSubscriber(charId);
        bump("notify.swept");
      }
    }
  }

  function takeRate(charId) {
    const now = clock.now();
    sweep(now);
    let entry = rate.get(charId);
    if (!entry || now - entry.windowStartMs >= RATE_WINDOW_MS) {
      entry = { windowStartMs: now, count: 0 };
      rate.set(charId, entry);
    }
    if (entry.count >= config.clientWindowMaxCommandsPerSecond) return false;
    entry.count += 1;
    return true;
  }

  function gate(method, charId) {
    bump(`rpc.${method}`);
    if (stopped) return refuse("DISABLED");
    if (!posSafeInt(charId)) return refuse("NO_CHARACTER");
    if (!takeRate(charId)) return refuse("RATE_LIMIT");
    return null;
  }

  function dropSubscriber(charId) {
    subscribers.delete(charId);
    dirty.delete(charId);
    lastSentAtMs.delete(charId);
    lastOpenAtMs.delete(charId);
  }

  function snapshotOf(charId) {
    const snapshot = toSnapshot(core.listWing(charId), verbs, uiOf(liveConfig ? liveConfig.get() : config),
      formationOptions, boardRow);
    if (snapshot.truncated > 0) bump("snapshot.truncated", snapshot.truncated);
    const hpMissing = snapshot.ships.filter((s) => FLYING_STATES.includes(s.state) && s.hp === null).length;
    if (hpMissing > 0) bump("snapshot.hpMissing", hpMissing);
    if (cargoOn) snapshot.cargo = true;
    return snapshot;
  }

  function send(charId, notifyType) {
    const ref = subscribers.get(charId);
    const token = ref ? ref.deref() : undefined;
    if (!token) {
      dropSubscriber(charId);
      bump("notify.dropped");
      return { ok: false, reason: "SESSION_CHANGED" };
    }
    let result;
    try {
      result = notify(charId, token, notifyType, snapshotOf(charId));
    } catch (err) {
      debug(`client window: notify failed - ${(err && err.message) || err}`);
      result = { ok: false, reason: "SEND_FAILED" };
    }
    if (result && result.ok === true) {
      bump("notify.sent");
      lastSentAtMs.set(charId, clock.now());
      dirty.delete(charId);
      return { ok: true };
    }
    bump("notify.dropped");
    const reason = result && result.reason === "SESSION_CHANGED" ? "SESSION_CHANGED" : "SEND_FAILED";
    if (reason === "SESSION_CHANGED") dropSubscriber(charId);
    return { ok: false, reason };
  }

  function dueAt(charId, now) {
    const last = lastSentAtMs.get(charId);
    return last === undefined ? now : Math.max(now, last + config.clientWindowStateMinIntervalMs);
  }

  function arm(at) {
    if (stopped) return;
    if (timer !== null && timerDueAt <= at) return;
    if (timer !== null) timers.clearTimeout(timer);
    timerDueAt = at;
    timer = timers.setTimeout(flush, Math.max(0, at - clock.now()));
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function flush() {
    timer = null;
    timerDueAt = Infinity;
    if (stopped) return;
    const now = clock.now();
    let next = Infinity;
    for (const charId of [...dirty.keys()]) {
      if (!subscribers.has(charId)) {
        dirty.delete(charId);
        continue;
      }
      const due = dueAt(charId, now);
      if (due > now) {
        next = Math.min(next, due);
        continue;
      }
      const sent = send(charId, "OnShipWingState");
      if (!sent.ok && dirty.has(charId) && subscribers.has(charId)) {
        bump("notify.retry");
        next = Math.min(next, now + config.clientWindowStateMinIntervalMs);
      }
    }
    if (dirty.size > 0 && Number.isFinite(next)) arm(next);
  }

  function onWingChanged(charId) {
    try {
      if (stopped || !subscribers.has(charId)) return;
      if (dirty.has(charId)) {
        bump("notify.coalesced");
        return;
      }
      const now = clock.now();
      dirty.set(charId, now);
      arm(dueAt(charId, now));
    } catch (err) {
      debug(`client window: onWingChanged failed - ${(err && err.message) || err}`);
    }
  }

  function scheduleLoginOpen(charId, token) {
    try {
      if (!loginOpenOn || stopped || uiPrefs.get(charId) !== true) return;
      let done = autoOpened.get(token);
      if (done && done.has(charId)) return;
      if (!done) {
        done = new Set();
        autoOpened.set(token, done);
      }
      done.add(charId);
      bump("ui.autoOpen.scheduled");
      const handle = timers.setTimeout(() => {
        loginTimers.delete(handle);
        if (stopped) return;
        let out;
        try {
          out = open(charId);
        } catch (_err) {
          out = { ok: false, reason: "SEND_FAILED" };
        }
        bump(out && out.ok === true ? "ui.autoOpen.sent"
          : `ui.autoOpen.refused.${(out && out.reason) || "SEND_FAILED"}`);
      }, loginOpenDelayMs);
      loginTimers.add(handle);
      if (handle && typeof handle.unref === "function") handle.unref();
    } catch (err) {
      debug(`client window: login open failed - ${(err && err.message) || err}`);
    }
  }

  function getState(charId, token) {
    const refused = gate("GetState", charId);
    if (refused) return refused;
    if (token === null || typeof token !== "object") return refuse("INTERNAL");
    const prev = subscribers.get(charId);
    const fresh = !prev || prev.deref() !== token;
    subscribers.set(charId, new WeakRef(token));
    if (fresh) scheduleLoginOpen(charId, token);
    try {
      return { ok: true, snapshot: snapshotOf(charId) };
    } catch (err) {
      debug(`client window: listWing failed - ${(err && err.message) || err}`);
      return refuse("INTERNAL");
    }
  }

  function validIds(ids) {
    return Array.isArray(ids) && ids.length > 0 && ids.every(posSafeInt);
  }

  function validVerb(verb) {
    return typeof verb === "string" && verb.length >= 1 && verb.length <= MAX_VERB_CHARS && VERB_RE.test(verb);
  }

  function validTarget(targetId) {
    return targetId === null || targetId === undefined || posSafeInt(targetId);
  }

  function boardCommand(charId, ids) {
    seq += 1;
    const commandId = `ui-${seq}`;
    const [first, ...rest] = ids;
    let out;
    try {
      const row = core.listWing(charId).ships.find((s) => s && s.shipItemId === first) || null;
      out = row && posSafeInt(row.entityId) && BOARD_ROW_STATES.includes(row.state)
        ? serverBoard(charId, row.entityId) : { ok: false, reason: "NOT_DEPLOYED" };
    } catch (err) {
      debug(`client window: board failed - ${(err && err.message) || err}`);
      out = null;
    }
    const ok = Boolean(out && out.ok === true);
    const reason = ok ? null : (out && typeof out.reason === "string" && out.reason !== "" ? out.reason : "INTERNAL");
    const results = [{ shipItemID: first, ok, reason, state: null }];
    for (const id of rest) {
      bump("refused.SKIPPED");
      results.push({ shipItemID: id, ok: false, reason: "SKIPPED", state: null });
    }
    return { ok: true, result: { v: WIRE_VERSION, ok, reason, commandID: commandId, results } };
  }

  function command(charId, input) {
    const refused = gate("Command", charId);
    if (refused) return refused;
    const args = input && typeof input === "object" ? input : {};
    if (!validIds(args.ids) || !validVerb(args.verb) || !validTarget(args.targetId)) return refuse("BAD_ARGS");
    const ids = [...new Set(args.ids)];
    if (ids.length > config.clientWindowMaxShipsPerCommand) return refuse("TOO_MANY_SHIPS");
    if (args.verb === BOARD_VERB && serverBoard) return boardCommand(charId, ids);
    if (!verbs.includes(args.verb)) return refuse("UNSUPPORTED_VERB");
    seq += 1;
    const commandId = `ui-${seq}`;
    const targetId = args.targetId === undefined ? null : args.targetId;
    const results = [];
    let firstRefusal = null;
    let stoppedBy = null;
    for (const id of ids) {
      if (stoppedBy !== null) {
        bump("refused.SKIPPED");
        results.push({ shipItemID: id, ok: false, reason: "SKIPPED", state: null });
        continue;
      }
      let out;
      try {
        out = core.orderCopy(charId, id, args.verb, { commandId, targetId, source: "window" });
      } catch (err) {
        debug(`client window: orderCopy failed - ${(err && err.message) || err}`);
        out = null;
      }
      if (out && out.ok === true) {
        results.push({ shipItemID: id, ok: true, reason: null, state: textOrNull(out.state) });
        continue;
      }
      const reason = out && typeof out.reason === "string" && out.reason !== "" ? out.reason : "INTERNAL";
      results.push({ shipItemID: id, ok: false, reason, state: null });
      if (firstRefusal === null) firstRefusal = reason;
      if (!UI_CONTINUE.includes(reason)) stoppedBy = reason;
    }
    return { ok: true, result: { v: WIRE_VERSION, ok: firstRefusal === null, reason: firstRefusal, commandID: commandId,
      results } };
  }

  function setDrones(charId, input) {
    const refused = gate("SetDrones", charId);
    if (refused) return refused;
    const args = input && typeof input === "object" ? input : {};
    if (!validIds(args.ids) || (args.mode !== "auto" && args.mode !== "off")) return refuse("BAD_ARGS");
    const ids = [...new Set(args.ids)];
    if (ids.length > config.clientWindowMaxShipsPerCommand) return refuse("TOO_MANY_SHIPS");
    if (typeof core.setDroneMode !== "function") return refuse("UNSUPPORTED_VERB");
    const results = [];
    let firstRefusal = null;
    let stoppedBy = null;
    let changed = false;
    for (const id of ids) {
      if (stoppedBy !== null) {
        bump("refused.SKIPPED");
        results.push({ shipItemID: id, ok: false, reason: "SKIPPED", state: null });
        continue;
      }
      let out;
      try {
        out = core.setDroneMode(charId, id, args.mode);
      } catch (err) {
        debug(`client window: setDroneMode failed - ${(err && err.message) || err}`);
        out = null;
      }
      if (out && out.ok === true) {
        bump("setDrones.ok");
        changed = true;
        results.push({ shipItemID: id, ok: true, reason: null, state: textOrNull(out.state) });
        continue;
      }
      const reason = out && typeof out.reason === "string" && out.reason !== "" ? out.reason : "INTERNAL";
      bump(`setDrones.refused.${reason}`);
      results.push({ shipItemID: id, ok: false, reason, state: null });
      if (firstRefusal === null) firstRefusal = reason;
      if (!UI_CONTINUE.includes(reason)) stoppedBy = reason;
    }
    if (changed) onWingChanged(charId);
    return { ok: true, result: { v: WIRE_VERSION, ok: firstRefusal === null, reason: firstRefusal, results } };
  }

  function setEngage(charId, input) {
    const refused = gate("SetEngage", charId);
    if (refused) return refused;
    const args = input && typeof input === "object" ? input : {};
    if (!validIds(args.ids) || (args.mode !== "on" && args.mode !== "off")) return refuse("BAD_ARGS");
    const ids = [...new Set(args.ids)];
    if (ids.length > config.clientWindowMaxShipsPerCommand) return refuse("TOO_MANY_SHIPS");
    if (typeof core.setMirrorEngage !== "function") return refuse("UNSUPPORTED_VERB");
    const results = [];
    let firstRefusal = null;
    let stoppedBy = null;
    let changed = false;
    for (const id of ids) {
      if (stoppedBy !== null) {
        bump("refused.SKIPPED");
        results.push({ shipItemID: id, ok: false, reason: "SKIPPED", state: null });
        continue;
      }
      let out;
      try {
        out = core.setMirrorEngage(charId, id, args.mode === "on");
      } catch (err) {
        debug(`client window: setMirrorEngage failed - ${(err && err.message) || err}`);
        out = null;
      }
      if (out && out.ok === true) {
        bump("setEngage.ok");
        changed = true;
        results.push({ shipItemID: id, ok: true, reason: null, state: textOrNull(out.state) });
        continue;
      }
      const reason = out && typeof out.reason === "string" && out.reason !== "" ? out.reason : "INTERNAL";
      bump(`setEngage.refused.${reason}`);
      results.push({ shipItemID: id, ok: false, reason, state: null });
      if (firstRefusal === null) firstRefusal = reason;
      if (!UI_CONTINUE.includes(reason)) stoppedBy = reason;
    }
    if (changed) onWingChanged(charId);
    return { ok: true, result: { v: WIRE_VERSION, ok: firstRefusal === null, reason: firstRefusal, results } };
  }

  function setFormation(charId, input) {
    const refused = gate("SetFormation", charId);
    if (refused) return refused;
    const args = input && typeof input === "object" ? input : {};
    if (typeof args.name !== "string" || !FORMATION_NAME_RE.test(args.name)) return refuse("BAD_ARGS");
    if (typeof core.setFormation !== "function") return refuse("UNSUPPORTED_VERB");
    let out;
    try {
      out = core.setFormation(charId, args.name);
    } catch (err) {
      debug(`client window: setFormation failed - ${(err && err.message) || err}`);
      out = null;
    }
    const ok = Boolean(out && out.ok === true);
    const reason = ok ? null : (out && typeof out.reason === "string" && out.reason !== "" ? out.reason : "INTERNAL");
    bump(ok ? "setFormation.ok" : `setFormation.refused.${reason}`);
    if (ok) onWingChanged(charId);
    return { ok: true, result: { v: WIRE_VERSION, ok, reason, formation: ok ? textOrNull(out.formation) : null,
      persisted: ok ? out.persisted === true : null } };
  }

  function getCargo(charId) {
    const refused = gate("GetCargo", charId);
    if (refused) return refused;
    let view;
    try {
      view = core.cargoOf(charId);
    } catch (err) {
      debug(`client window: cargoOf failed - ${(err && err.message) || err}`);
      view = null;
    }
    if (!view || view.ok !== true) {
      const reason = view && typeof view.reason === "string" && view.reason !== "" ? view.reason : "INTERNAL";
      bump(`cargo.refused.${reason}`);
      return { ok: true, result: { v: WIRE_VERSION, ok: false, reason, hostShipID: null, truncated: 0, ships: [] } };
    }
    bump("cargo.list");
    const ships = (Array.isArray(view.ships) ? view.ships : []).map((s) => ({
      shipItemID: intOrNull(s.shipItemId) || 0, name: shortText(s.name), host: s.host === true,
      holds: (Array.isArray(s.holds) ? s.holds : []).map((h) => ({
        flag: intOrNull(h.flag) || 0, kind: String(h.kind || ""), cap: intOrNull(h.capacityM3) || 0,
        used: intOrNull(h.usedM3) || 0,
        items: (Array.isArray(h.items) ? h.items : []).map((i) => ({ itemID: intOrNull(i.itemId) || 0,
          typeID: intOrNull(i.typeId) || 0, name: shortText(i.name), qty: intOrNull(i.qty) || 0,
          m3: intOrNull(i.m3) || 0 })),
      })),
    }));
    return { ok: true, result: { v: WIRE_VERSION, ok: true, reason: null, hostShipID: intOrNull(view.hostShipId),
      truncated: intOrNull(view.truncated) || 0, ships } };
  }

  function moveCargo(charId, input) {
    const refused = gate("MoveCargo", charId);
    if (refused) return refused;
    const args = input && typeof input === "object" ? input : {};
    const optional = (v) => v === null || v === undefined || posSafeInt(v);
    if (!validIds(args.ids) || !posSafeInt(args.toShipItemId) || !optional(args.toFlag) || !optional(args.quantity)
      || (posSafeInt(args.quantity) && args.ids.length !== 1)) return refuse("BAD_ARGS");
    const ids = [...new Set(args.ids)];
    let out;
    try {
      out = core.moveCargo(charId, { items: ids.map((itemId) => ({ itemId,
        quantity: posSafeInt(args.quantity) ? args.quantity : null })), toShipItemId: args.toShipItemId,
      toFlag: posSafeInt(args.toFlag) ? args.toFlag : null });
    } catch (err) {
      debug(`client window: moveCargo failed - ${(err && err.message) || err}`);
      out = null;
    }
    const ok = Boolean(out && out.ok === true);
    const reason = ok ? null : (out && typeof out.reason === "string" && out.reason !== "" ? out.reason : "INTERNAL");
    bump(ok ? "cargo.move.ok" : `cargo.move.refused.${reason}`);
    const results = (out && Array.isArray(out.results) ? out.results : []).map((r) => ({
      itemID: intOrNull(r.itemId) || 0, ok: r.ok === true, reason: textOrNull(r.reason),
      movedQty: intOrNull(r.movedQty) || 0 }));
    return { ok: true, result: { v: WIRE_VERSION, ok, reason, movedQty: intOrNull(out && out.movedQty) || 0,
      movedM3: intOrNull(out && out.movedM3) || 0, skipped: intOrNull(out && out.skipped) || 0, results } };
  }

  function report(charId, input) {
    const refused = gate("Report", charId);
    if (refused) return refused;
    const args = input && typeof input === "object" ? input : {};
    if (args.proto !== REPORT_PROTO || !Array.isArray(args.items)) return refuse("BAD_ARGS");
    const now = clock.now();
    const ok = [];
    const missing = [];
    let dropped = Math.max(0, args.items.length - MAX_REPORT_ITEMS);
    for (const item of args.items.slice(0, MAX_REPORT_ITEMS)) {
      const parsed = parseReportItem(item);
      if (parsed === null) dropped += 1;
      else (parsed.ok ? ok : missing).push(parsed.text);
    }
    const parsedAll = [...ok, ...missing];
    const isEvent = parsedAll.length > 0 && parsedAll.every((text) => text.startsWith(EVENT_PREFIX));
    const lastAt = (isEvent ? lastEventAtMs : lastReportAtMs).get(charId);
    const minInterval = isEvent ? Number(config.clientWindowEventMinIntervalMs) || 0
      : config.clientWindowReportMinIntervalMs;
    if (lastAt !== undefined && now - lastAt < minInterval) {
      bump(isEvent ? "report.eventSuppressed" : "report.suppressed");
      return { ok: true };
    }
    const build = Number.isSafeInteger(args.clientBuild) && args.clientBuild >= 0 ? args.clientBuild : 0;
    const line = `SHIPWING_UI:${isEvent ? "EVENT" : "PROBE"} char=${charId} build=${build} proto=${REPORT_PROTO} `
      + `ok=${ok.join(",")} missing=${missing.join(",")} dropped=${dropped}`;
    (isEvent ? lastEventAtMs : lastReportAtMs).set(charId, now);
    bump(isEvent ? "report.event" : "report.logged");
    try {
      if (log && typeof log.log === "function") log.log(line.slice(0, MAX_REPORT_LINE_CHARS));
    } catch (_err) {
    }
    return { ok: true };
  }

  function open(charId) {
    if (stopped) return { ok: false, reason: "WINDOW_OFF" };
    if (!subscribers.has(charId)) return { ok: false, reason: "CLIENT_NOT_READY" };
    const now = clock.now();
    const minInterval = Number(config.clientWindowOpenMinIntervalMs) || 0;
    const last = lastOpenAtMs.get(charId);
    if (minInterval > 0 && last !== undefined && now - last < minInterval) {
      bump("refused.RATE_LIMIT");
      return { ok: false, reason: "RATE_LIMIT" };
    }
    lastOpenAtMs.set(charId, now);
    const sent = send(charId, "OnShipWingOpen");
    return sent.ok ? { ok: true } : { ok: false, reason: sent.reason };
  }

  function stats() {
    let storeCounters = {};
    try {
      const s = uiPrefs && typeof uiPrefs.stats === "function" ? uiPrefs.stats() : null;
      if (s && s.counters && typeof s.counters === "object") storeCounters = s.counters;
    } catch (_err) {
      storeCounters = {};
    }
    return { subscribers: subscribers.size, dirty: dirty.size, counters: { ...counters, ...storeCounters } };
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    timerDueAt = Infinity;
    for (const handle of loginTimers) timers.clearTimeout(handle);
    loginTimers.clear();
    if (typeof unsubscribe === "function") {
      try {
        unsubscribe();
      } catch (_err) {
      }
    }
    unsubscribe = null;
    subscribers.clear();
    dirty.clear();
    lastSentAtMs.clear();
    rate.clear();
    lastReportAtMs.clear();
    lastOpenAtMs.clear();
    lastEventAtMs.clear();
  }

  if (typeof core.onWingChanged === "function") unsubscribe = core.onWingChanged(onWingChanged);

  return Object.freeze({ getState, command, setDrones, setEngage, setFormation, report, open, onWingChanged, stats,
    stop, commandCount: () => seq, isListening: () => typeof unsubscribe === "function",
    ...(cargoOn ? { getCargo, moveCargo } : {}) });
}

module.exports = {
  WIRE_VERSION, REPORT_PROTO, RATE_WINDOW_MS, MAX_NAME_CHARS, MAX_VERB_CHARS, MAX_REPORT_ITEMS, MAX_REPORT_ITEM_CHARS,
  MAX_REPORT_LINE_CHARS, EVENT_PREFIX, HP_MAX,
  toSnapshot, rowVerbs, rowDrones, rowEngage, rowActive, uiOf, parseReportItem, createClientWindowChannel,
};
