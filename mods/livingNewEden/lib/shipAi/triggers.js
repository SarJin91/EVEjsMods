"use strict";

const { TRIGGER_PRIORITY, TRIGGER_TEXT, WHERE_TEXT } = require("./data/triggers");
const { formatIsk } = require("./persona");

const TRIGGER_KINDS_A = Object.freeze(["CRIMINAL", "SUSPECT", "CRIME_CLEAR", "CAP_LOW", "SEC_STATUS_DROP",
  "DOCK_DAMAGED"]);
const CRIME = Object.freeze({ NONE: "none", SUSPECT: "suspect", CRIMINAL: "criminal" });
const MS_PER_MINUTE = 60000;
const MS_PER_DAY = 86400000;
const MS_PER_HOUR = 3600000;
const SEC_MAX_MARKS = 5;
const SEC_MIN = -10;
const SEC_MAX = 0;
const SEC_MARK_RE = /^-?\d{1,2}(\.\d)?$/;
const PERMILLE_PER_PERCENT = 10;

const isObj = (v) => Boolean(v) && typeof v === "object";
const permille = (v) => (Number.isSafeInteger(v) ? v : null);

function emptyTriggerState() {
  return { crime: null, crimeUntil: 0, crimeMiss: 0, capArmed: null, secStatus: null, secSaid: new Map(),
    lastAt: new Map(), pending: new Map(), lastWorldBySystem: new Map() };
}

function copyOf(state) {
  const s = isObj(state) ? state : emptyTriggerState();
  return { crime: s.crime === undefined ? null : s.crime, capArmed: typeof s.capArmed === "boolean" ? s.capArmed : null,
    crimeUntil: Number.isFinite(s.crimeUntil) ? s.crimeUntil : 0,
    crimeMiss: Number.isSafeInteger(s.crimeMiss) ? s.crimeMiss : 0,
    secStatus: Number.isFinite(s.secStatus) ? s.secStatus : null,
    secSaid: new Map(s.secSaid instanceof Map ? s.secSaid : []),
    lastAt: new Map(s.lastAt instanceof Map ? s.lastAt : []),
    pending: new Map(s.pending instanceof Map ? s.pending : []),
    lastWorldBySystem: new Map(s.lastWorldBySystem instanceof Map ? s.lastWorldBySystem : []) };
}

function crimeOf(crime, nowMs) {
  if (!isObj(crime) || crime.ok !== true) return null;
  if (crime.found !== true) return CRIME.NONE;
  const live = Number.isFinite(crime.timerExpiresAtMs) && crime.timerExpiresAtMs > nowMs;
  if (crime.criminal === true && live) return CRIME.CRIMINAL;
  if (crime.suspect === true && live) return CRIME.SUSPECT;
  return CRIME.NONE;
}

function parseSecThresholds(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const out = [];
  for (const part of trimmed.split(",")) {
    const token = part.trim();
    if (!SEC_MARK_RE.test(token)) return null;
    const n = Number(token);
    if (!Number.isFinite(n) || n < SEC_MIN || n > SEC_MAX) return null;
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > SEC_MAX_MARKS) return null;
  return out.sort((a, b) => b - a);
}

function planTriggers(state, reading, nowMs, S) {
  const st = copyOf(state);
  const r = isObj(reading) ? reading : {};
  const muted = S && S.muted instanceof Set ? S.muted : new Set();
  const out = { state: st, changes: 0, suppressed: 0, dropped: 0, muted: 0 };
  const minute = Math.floor(nowMs / MS_PER_MINUTE);
  const place = typeof r.systemName === "string" && r.systemName !== "" ? r.systemName : null;
  const dropKinds = (kinds) => {
    for (const [key, e] of [...st.pending]) if (kinds.includes(e.kind)) st.pending.delete(key);
  };
  const push = (kind, key, values) => {
    if (muted.has(kind)) {
      out.muted += 1;
      return;
    }
    st.pending.set(key, Object.freeze({ kind, priority: TRIGGER_PRIORITY[kind], key,
      values: Object.freeze({ system: place, ...values }), at: nowMs }));
    out.changes += 1;
  };

  for (const [key, e] of [...st.pending]) {
    if (nowMs - e.at > S.triggerPendingMaxAgeMs) {
      st.pending.delete(key);
      out.dropped += 1;
    }
  }

  let crime = crimeOf(r.crime, nowMs);
  if (crime !== null) {
    const flagged = st.crime === CRIME.SUSPECT || st.crime === CRIME.CRIMINAL;
    if (r.crime.found !== true) {
      if (flagged && st.crimeUntil > nowMs && st.crimeMiss < 1) {
        st.crimeMiss += 1;
        crime = null;
      } else {
        st.crimeMiss = 0;
      }
    } else {
      st.crimeMiss = 0;
      st.crimeUntil = Number.isFinite(r.crime.timerExpiresAtMs) ? r.crime.timerExpiresAtMs : 0;
    }
  }
  if (crime !== null) {
    const prev = st.crime;
    if (prev !== null && prev !== crime) {
      if (crime === CRIME.CRIMINAL) {
        dropKinds(["SUSPECT"]);
        push("CRIMINAL", `crim:${minute}`, {});
      } else if (crime === CRIME.SUSPECT && prev === CRIME.NONE) {
        push("SUSPECT", `susp:${minute}`, {});
      } else if (crime === CRIME.NONE) {
        dropKinds(["SUSPECT", "CRIMINAL"]);
        push("CRIME_CLEAR", `crimeclear:${minute}`, {});
      }
    }
    st.crime = crime;
  }

  const cap = permille(r.capacitorPermille);
  if (r.docked === true) {
    st.capArmed = true;
  } else if (r.inSpace === true && cap !== null) {
    const low = cap < S.capLowPermille;
    if (st.capArmed === null) {
      st.capArmed = !low;
    } else if (st.capArmed === true && low && r.warping !== true) {
      st.capArmed = false;
      const last = st.lastAt.get("CAP_LOW");
      if (last !== undefined && nowMs - last < S.capLowCooldownMs) {
        out.suppressed += 1;
      } else {
        st.lastAt.set("CAP_LOW", nowMs);
        push("CAP_LOW", `cap:${minute}`, {});
      }
    } else if (st.capArmed === false && cap > S.capLowRearmPermille) {
      st.capArmed = true;
    }
  }

  if (typeof r.securityStatus === "number" && Number.isFinite(r.securityStatus)) {
    const next = r.securityStatus;
    const prev = st.secStatus;
    if (prev !== null && next < prev) {
      const marks = (parseSecThresholds(S.secStatusThresholds) || []).filter((t) => prev >= t && t > next);
      if (marks.length > 0) {
        const deepest = Math.min(...marks);
        const day = Math.floor(nowMs / MS_PER_DAY);
        if (st.secSaid.get(deepest) === day) {
          out.suppressed += 1;
        } else {
          push("SEC_STATUS_DROP", `sec:${Math.round(deepest * 10)}:${day}`, { threshold: deepest,
            status: Math.round(next * 10) / 10 });
        }
        for (const t of marks) st.secSaid.set(t, day);
      }
    }
    st.secStatus = next;
  }

  if (isObj(r.dock) && Number.isSafeInteger(r.dock.armorPermille) && Number.isSafeInteger(r.dock.structurePermille)) {
    const hullWorse = r.dock.structurePermille < r.dock.armorPermille;
    const worst = hullWorse ? r.dock.structurePermille : r.dock.armorPermille;
    if (worst < S.dockRepairPermille) {
      push("DOCK_DAMAGED", `dockdmg:${Number.isSafeInteger(r.systemId) ? r.systemId : 0}:${minute}`,
        { layer: hullWorse ? "hull" : "armor", pct: Math.floor(worst / PERMILLE_PER_PERCENT) });
    }
  }

  while (st.pending.size > Math.max(1, S.triggerQueueMax)) {
    let oldest = null;
    for (const e of st.pending.values()) if (oldest === null || e.at < oldest.at) oldest = e;
    st.pending.delete(oldest.key);
    out.dropped += 1;
  }
  return out;
}

function takeTrigger(state) {
  if (!isObj(state) || !(state.pending instanceof Map)) return null;
  let best = null;
  for (const e of state.pending.values()) {
    if (best === null || e.priority > best.priority || (e.priority === best.priority
      && (e.at < best.at || (e.at === best.at && e.key < best.key)))) best = e;
  }
  return best;
}

const TRIGGER_KINDS_B = Object.freeze(["MINING_CARGO_FULL", "MINING_CRYSTAL", "SITE_CLEARED", "NAVY_KILL",
  "NOTABLE_KILL"]);
const NAME_LIST_MAX = 16;
const NAME_TOKEN_RE = /^[\p{L}\p{N} -]{2,40}$/u;
const COOLDOWN_KEY = Object.freeze({ MINING_CARGO_FULL: "miningCooldownMs", MINING_CRYSTAL: "miningCooldownMs",
  NAVY_KILL: "navyKillCooldownMs", NOTABLE_KILL: "killCooldownMs",
  WORLD_NEWS: "worldNewsCooldownMs", BATTLE_HERE: "worldHereCooldownMs", EVENT_HERE: "worldHereCooldownMs" });
const MINING_KIND = Object.freeze({ cargo: "MINING_CARGO_FULL", ammo: "MINING_CRYSTAL" });

const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const textOrNull = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

function parseNameList(text) {
  if (typeof text !== "string") return null;
  const out = [];
  for (const part of text.split(",")) {
    const token = part.trim();
    if (!NAME_TOKEN_RE.test(token)) return null;
    const low = token.toLowerCase();
    if (!out.includes(low)) out.push(low);
  }
  return out.length > 0 && out.length <= NAME_LIST_MAX ? out : null;
}

function isNotableKill(label, classes, patterns) {
  const name = isObj(label) ? textOrNull(label.name) : null;
  const cls = isObj(label) ? textOrNull(label.cls) : null;
  if (name === null || cls === null) return false;
  const n = name.toLowerCase();
  const c = cls.toLowerCase();
  const list = (v) => (Array.isArray(v) ? v : []);
  return list(classes).some((t) => c.includes(t)) || list(patterns).some((t) => n.includes(t) || c.includes(t));
}

function activityEntryOf(fact, names, S) {
  if (!isObj(fact) || !Number.isFinite(fact.atMs) || !isObj(S)) return null;
  const call = (fn, v) => (typeof fn === "function" ? fn(v) : null);
  const system = textOrNull(call(names && names.system, fact.systemId));
  const factionName = isPosInt(fact.factionId) || isPosInt(fact.victimFactionId)
    ? textOrNull(call(names && names.faction, isPosInt(fact.factionId) ? fact.factionId : fact.victimFactionId)) : null;
  const entry = (kind, key, values, model) => Object.freeze({ kind, priority: TRIGGER_PRIORITY[kind], key,
    values: Object.freeze({ system, ...values }), at: fact.atMs, model });
  if (fact.type === "mining") {
    const kind = MINING_KIND[fact.reason];
    if (!kind || S.miningLinesEnabled !== true) return null;
    const minute = Math.floor(fact.atMs / MS_PER_MINUTE);
    return entry(kind, `mine:${fact.reason}:${isPosInt(fact.shipId) ? fact.shipId : 0}:${minute}`, {}, false);
  }
  if (fact.type === "site") {
    const id = fact.instanceId;
    if (S.siteClearedEnabled !== true || !(isPosInt(id) || (typeof id === "string" && id !== ""))) return null;
    const values = {};
    const siteKind = textOrNull(fact.siteKind);
    if (siteKind !== null) values.siteKind = siteKind;
    if (factionName !== null) values.faction = factionName;
    return entry("SITE_CLEARED", `site:${id}`, values, true);
  }
  if (fact.type === "kill") {
    if (S.killLinesEnabled !== true || !isPosInt(fact.victimId)) return null;
    const label = isPosInt(fact.victimTypeId) ? call(names && names.label, fact.victimTypeId) : null;
    const name = isObj(label) ? textOrNull(label.name) : null;
    const cls = isObj(label) ? textOrNull(label.cls) : null;
    const values = {};
    if (name !== null) values.name = name;
    if (factionName !== null) values.faction = factionName;
    if (fact.navy === true) return entry("NAVY_KILL", `navy:${fact.victimId}`, values, false);
    if (!isNotableKill(label, S.notableClasses, S.notablePatterns)) return null;
    if (cls !== null) values.cls = cls;
    return entry("NOTABLE_KILL", `kill:${fact.victimId}`, values, true);
  }
  return null;
}

function noteActivity(state, entries, nowMs, S) {
  const st = copyOf(state);
  const muted = S && S.muted instanceof Set ? S.muted : new Set();
  const out = { state: st, queued: 0, suppressed: 0, muted: 0, dropped: 0 };
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!isObj(e) || typeof e.kind !== "string") continue;
    if (muted.has(e.kind)) {
      out.muted += 1;
      continue;
    }
    const cdKey = COOLDOWN_KEY[e.kind];
    const last = st.lastAt.get(e.kind);
    const waiting = Boolean(cdKey) && [...st.pending.values()].some((p) => p.kind === e.kind);
    if (cdKey && ((last !== undefined && nowMs - last < S[cdKey]) || waiting)) {
      out.suppressed += 1;
      continue;
    }
    if (st.pending.has(e.key)) continue;
    st.pending.set(e.key, e);
    out.queued += 1;
  }
  while (st.pending.size > Math.max(1, S.triggerQueueMax)) {
    let oldest = null;
    for (const e of st.pending.values()) if (oldest === null || e.at < oldest.at) oldest = e;
    st.pending.delete(oldest.key);
    out.dropped += 1;
  }
  return out;
}

function markActivitySpoken(state, kind, nowMs) {
  if (!isObj(state) || !(state.lastAt instanceof Map) || !COOLDOWN_KEY[kind] || !Number.isFinite(nowMs)) return;
  state.lastAt.set(kind, nowMs);
}

const ISK_IN_TEMPLATE = Object.freeze({ insurance: "ISK_IN_INSURANCE", mission: "ISK_IN_MISSION",
  donation: "ISK_IN_DONATION" });

function watchTemplateOf(event) {
  const kind = isObj(event) && typeof event.kind === "string" ? event.kind : "";
  if (kind !== "ISK_IN") return kind;
  const source = isObj(event.payload) ? event.payload.source : null;
  return Object.prototype.hasOwnProperty.call(ISK_IN_TEMPLATE, source) ? ISK_IN_TEMPLATE[source] : kind;
}

function watchValuesOf(event, language) {
  if (!isObj(event) || (event.kind !== "BOUNTY_PAID" && event.kind !== "ISK_IN")) return {};
  const isk = isObj(event.payload) ? event.payload.isk : null;
  return Number.isFinite(isk) ? { isk: formatIsk(isk, language) } : {};
}

function welcomeDecision(lastSeenAt, nowMs, quiet, S) {
  if (!isObj(S) || S.welcomeEnabled !== true) return { welcome: false, hours: 0, reason: "OFF" };
  if (!Number.isFinite(lastSeenAt)) return { welcome: false, hours: 0, reason: "NEW" };
  const away = nowMs - lastSeenAt;
  const hours = Math.max(0, Math.floor(away / MS_PER_HOUR));
  if (!(away >= S.welcomeMinOfflineMs)) return { welcome: false, hours, reason: "RECENT" };
  if (quiet === true) return { welcome: false, hours, reason: "QUIET" };
  return { welcome: true, hours, reason: "OK" };
}

const TRIGGER_KINDS_D = Object.freeze(["WORLD_NEWS", "BATTLE_HERE", "EVENT_HERE"]);
const WORLD_NOTICE_KINDS = Object.freeze(["ATTACK_STARTED", "SYSTEM_CAPTURED", "SYSTEM_RELEASED", "ATTACK_REPELLED",
  "SIEGE_STARTED", "SIEGE_ENDED", "PLAYER_IMPACT", "STRUCTURE_SIEGE_STARTED", "STRUCTURE_SIEGE_ENDED",
  "PLAYER_SOV_SIEGE", "PLAYER_SOV_REINFORCED", "PLAYER_SOV_LOST", "HEAVY_EVENT_STARTED"]);
const PERSONAL_WORLD_KINDS = Object.freeze(["PLAYER_IMPACT", "STRUCTURE_SIEGE_STARTED", "STRUCTURE_SIEGE_ENDED",
  "PLAYER_SOV_SIEGE", "PLAYER_SOV_REINFORCED", "PLAYER_SOV_LOST"]);
const EVENT_KEY_MAX_CHARS = 80;
const WORLD_JUMPS_WORDS_FROM = 5;

function parseWorldKinds(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  const out = new Set();
  for (const part of text.split(",")) {
    const k = part.trim().toUpperCase();
    if (!WORLD_NOTICE_KINDS.includes(k)) return false;
    out.add(k);
  }
  return out;
}

function whereOf(jumps, language) {
  const t = WHERE_TEXT[language] || WHERE_TEXT.en;
  if (!Number.isSafeInteger(jumps) || jumps < 0) return t.near;
  if (jumps === 0) return t.here;
  if (jumps === 1) return t.one;
  const tpl = jumps >= WORLD_JUMPS_WORDS_FROM ? t.many : t.few;
  return tpl.replace("{n}", String(jumps));
}

function namesUsedBy(template) {
  const used = { attacker: false, defender: false };
  for (const lang of Object.keys(TRIGGER_TEXT)) {
    for (const line of TRIGGER_TEXT[lang][template] || []) {
      if (line.includes("{attacker}")) used.attacker = true;
      if (line.includes("{defender}")) used.defender = true;
    }
  }
  return used;
}

function worldTemplateOf(view) {
  const kind = isObj(view) && typeof view.kind === "string" ? view.kind : "";
  const main = `WORLD_NEWS_${kind}`;
  const used = namesUsedBy(main);
  const missing = (used.attacker && textOrNull(view.attackerName) === null)
    || (used.defender && textOrNull(view.defenderName) === null);
  const plain = `${main}_PLAIN`;
  return missing && Object.keys(TRIGGER_TEXT).some((l) => Array.isArray(TRIGGER_TEXT[l][plain])) ? plain : main;
}

function worldEntriesOf(views, players, within, states, nowMs, S) {
  const out = { byPlayer: new Map(), outOfRange: 0, systemCooldown: 0, notObserved: 0, kindOff: 0, noGraph: 0 };
  const kinds = S && S.worldKinds instanceof Set ? S.worldKinds : null;
  const who = players instanceof Map ? players : new Map();
  const lang = S && typeof S.language === "string" ? S.language : "en";
  for (const v of Array.isArray(views) ? views : []) {
    if (!isObj(v) || typeof v.kind !== "string" || typeof v.eventKey !== "string" || v.eventKey === ""
      || !isPosInt(v.systemId)) continue;
    const key = `world:${v.eventKey}`;
    if (key.length > EVENT_KEY_MAX_CHARS) continue;
    if (!WORLD_NOTICE_KINDS.includes(v.kind) || (kinds && !kinds.has(v.kind))) {
      out.kindOff += 1;
      continue;
    }
    let near = null;
    try {
      near = typeof within === "function" ? within(v.systemId) : null;
    } catch (_err) {
      near = null;
    }
    if (!(near instanceof Map)) near = null;
    const targets = [];
    const taken = new Set();
    const jumpsOf = (sys) => (near && near.has(sys) ? near.get(sys) : (sys === v.systemId ? 0 : null));
    for (const id of Array.isArray(v.recipients) ? v.recipients : []) {
      if (taken.has(id)) continue;
      if (!who.has(id)) {
        out.notObserved += 1;
        continue;
      }
      taken.add(id);
      targets.push([id, jumpsOf(who.get(id))]);
    }
    if (!PERSONAL_WORLD_KINDS.includes(v.kind)) {
      if (!near) out.noGraph += 1;
      for (const [id, sys] of who) {
        if (taken.has(id)) continue;
        const jumps = near ? near.get(sys) : (sys === v.systemId ? 0 : undefined);
        if (jumps === undefined) {
          out.outOfRange += 1;
          continue;
        }
        taken.add(id);
        targets.push([id, jumps]);
      }
    }
    const template = worldTemplateOf(v);
    for (const [id, jumps] of targets) {
      const st = states instanceof Map ? states.get(id) : null;
      const last = st && st.lastWorldBySystem instanceof Map ? st.lastWorldBySystem.get(v.systemId) : undefined;
      if (last !== undefined && nowMs - last < S.worldNewsSystemCooldownMs) {
        out.systemCooldown += 1;
        continue;
      }
      const values = { notice: v.kind, where: whereOf(jumps, lang) };
      const system = textOrNull(v.systemName);
      const attacker = textOrNull(v.attackerName);
      const defender = textOrNull(v.defenderName);
      const outcome = textOrNull(v.outcome);
      if (system !== null) values.system = system;
      if (Number.isSafeInteger(jumps)) values.jumps = jumps;
      if (attacker !== null) values.attacker = attacker;
      if (defender !== null) values.defender = defender;
      if (outcome !== null) values.outcome = outcome;
      const list = out.byPlayer.get(id) || [];
      list.push(Object.freeze({ kind: "WORLD_NEWS", priority: TRIGGER_PRIORITY.WORLD_NEWS, key,
        model: S.worldNewsModel === true, values: Object.freeze(values), template, systemId: v.systemId,
        at: nowMs }));
      out.byPlayer.set(id, list);
    }
  }
  return out;
}

function planHere(hereState, reading, systemName, nowMs, S) {
  const prev = isObj(hereState) && hereState.seen instanceof Map ? hereState.seen : null;
  const r = isObj(reading) ? reading : {};
  const battles = Array.isArray(r.battles) ? r.battles : null;
  const events = Array.isArray(r.events) ? r.events : null;
  const out = { state: { seen: prev ? new Map(prev) : null }, entries: [], liveSkipped: 0 };
  if (battles === null && events === null) return out;
  const first = prev === null;
  const seen = out.state.seen || new Map();
  const system = textOrNull(systemName);
  const refresh = (key) => {
    seen.delete(key);
    seen.set(key, nowMs);
  };
  const entry = (kind, key, values, template) => Object.freeze({ kind, priority: TRIGGER_PRIORITY[kind], key,
    model: true, values: Object.freeze(system === null ? values : { system, ...values }), template, at: nowMs });
  for (const b of battles || []) {
    if (!isObj(b) || typeof b.battleId !== "string" || b.battleId === "") continue;
    const key = `battle:${b.battleId}`;
    if (key.length > EVENT_KEY_MAX_CHARS) continue;
    if (seen.has(key)) {
      refresh(key);
      continue;
    }
    seen.set(key, nowMs);
    if (first) continue;
    if (b.mode === "LIVE_EVEJS" || b.state === "LIVE") {
      out.liveSkipped += 1;
      continue;
    }
    const a = textOrNull(b.a);
    const bb = textOrNull(b.b);
    out.entries.push(entry("BATTLE_HERE", key, a !== null && bb !== null ? { a, b: bb } : {},
      a !== null && bb !== null ? "BATTLE_HERE" : "BATTLE_HERE_PLAIN"));
  }
  for (const e of events || []) {
    if (!isObj(e) || typeof e.eventId !== "string" || e.eventId === "") continue;
    const key = `event:${e.eventId}`;
    if (key.length > EVENT_KEY_MAX_CHARS) continue;
    if (seen.has(key)) {
      refresh(key);
      continue;
    }
    seen.set(key, nowMs);
    if (first) continue;
    const values = {};
    if (textOrNull(e.eventType) !== null) values.eventType = textOrNull(e.eventType);
    if (textOrNull(e.label) !== null) values.label = textOrNull(e.label);
    out.entries.push(entry("EVENT_HERE", key, values, "EVENT_HERE"));
  }
  const max = isObj(S) && Number.isSafeInteger(S.worldHereSeenMax) && S.worldHereSeenMax > 0 ? S.worldHereSeenMax : 1;
  while (seen.size > max) seen.delete(seen.keys().next().value);
  out.state.seen = seen;
  return out;
}

module.exports = { emptyTriggerState, planTriggers, takeTrigger, crimeOf, parseSecThresholds, TRIGGER_KINDS_A,
  CRIME, TRIGGER_KINDS_B, parseNameList, isNotableKill, activityEntryOf, noteActivity, markActivitySpoken,
  watchTemplateOf, watchValuesOf, welcomeDecision, TRIGGER_KINDS_D, WORLD_NOTICE_KINDS, PERSONAL_WORLD_KINDS,
  parseWorldKinds, whereOf, worldTemplateOf, worldEntriesOf, planHere };
