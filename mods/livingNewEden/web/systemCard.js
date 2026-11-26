"use strict";

(function systemCardModule(global) {
  const PHASES = Object.freeze([["RECON", "Recon"], ["CONTESTED", "Contested"], ["INVASION", "Invasion"],
    ["OCCUPIED", "Occupied"], ["CONSOLIDATING", "Consolidating"], ["STABLE", "Stable"]]);
  const PHASE_LABELS = Object.freeze(Object.fromEntries(PHASES));
  const BLOCKERS = Object.freeze({ NO_ATTACKER_FLEET: "no fleet", FIELD_DISPUTED: "field disputed",
    FIELD_LOST: "field lost", NO_GARRISON: "no garrison", OUT_OF_RANGE: "out of range",
    RANGE_UNKNOWN: "range unknown", DEFENDER_STATION: "defender station stands", SCORE_STALLED: "influence stalled",
    NO_CONSOLIDATION: "faction not consolidating", CORE_PROTECTED: "core system protected",
    DATA_PENDING: "waiting for station data", FLEETS_TRUNCATED: "too many fleets in the read",
    SOV_FOREIGN_STRUCTURE: "foreign sovereignty structure",
    SOV_SIEGE_OBSERVED: "structure siege waiting (player in system)" });
  const LIMITING = Object.freeze({ TIME: "time", SCORE: "attacker influence", DEFENDER: "defender influence",
    RESIDUAL: "hostile influence", SOV: "sovereignty structure" });
  const SOV_HAVE = Object.freeze({ none: "none", ANCHORING: "anchoring", ONLINE: "online" });
  const MARKS = Object.freeze({ INVASION_MIN: "Invasion threshold", OCCUPY_MIN: "Takeover threshold",
    DEFENDER_MAX: "Defender max", STABLE_MIN: "Stabilization threshold", RESIDUAL_MAX: "Hostile max" });
  const FLEET_ROLES = Object.freeze({ invasion: "invasion", garrison: "garrison", logistics: "logistics", scout: "scout",
    patrol: "patrol", wormhole: "wormhole", reserve: "reserve", mining: "mining", hunter: "hunters",
    capsuleer: "capsuleer", mercenary: "mercenaries" });
  const FLEET_STATES = Object.freeze({ IDLE: "idle", PLANNED: "planned", TRAVELLING: "in flight",
    STAGED: "staged", ENGAGED: "in combat", RETREATING: "retreating", REFITTING: "refitting",
    MATERIALIZED: "near a player", DESTROYED: "destroyed" });
  const OPERATION_TYPES = Object.freeze({ invasion: "invasion", defense: "defense", reinforce: "reinforcement",
    patrol: "patrol", recon: "recon", logistics: "logistics", raid: "raid", expedition: "expedition",
    mining: "mining", return: "return", salvage: "salvage", intercept: "intercept", camp: "gate camp",
    ratting: "ratting", gank: "gank", pursuit: "pursuit", blockade: "blockade",
    escort: "escort", structure_assault: "structure assault", counter: "counteroffensive",
    harvest_raid: "harvest raid" });
  const OPERATION_STATES = Object.freeze({ PLANNED: "planned", ACTIVE: "in progress" });
  const STATION_STATES = Object.freeze({ ONLINE: "online", ANCHORING: "anchoring",
    ARMOR_REINFORCE: "armor reinforced", HULL_REINFORCE: "hull reinforced", DESTROYED: "destroyed" });
  const SIEGE_STATES = Object.freeze({ SHIELD_ASSAULT: "shield", ARMOR_TIMER: "break before armor",
    ARMOR_ASSAULT: "armor", HULL_TIMER: "break before hull", HULL_ASSAULT: "hull",
    ANCHOR_ASSAULT: "anchor" });
  const INVASION_STATES = Object.freeze({ ACTIVE: "beachhead active", WITHDRAWING: "withdrawing" });
  const OUTCOMES = Object.freeze({ A_WIN: "A wins", B_WIN: "B wins", DRAW: "draw",
    BOTH_RETREAT: "both sides retreated" });
  const ROLES = Object.freeze({ attacker: "attacker", defender: "defender", hostile: "hostile" });
  const REASONS = Object.freeze({ GOVERNOR_HOLD: "Server under load, the data will be back shortly.",
    STORE_CLOSED: "The mod database is closed.", NO_SYSTEM: "No system selected." });

  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const ETA_MINUTE_STEP = 5;
  const ETA_HOUR_LIMIT = 48;
  const PERCENT_DIVISOR = 10;
  const PERCENT_MAX = 100;
  const SECURITY_TENTHS = 10;
  const SKELETONS = 3;
  const MODULE_OFF = "module disabled";

  const has = (dict, code) => Object.prototype.hasOwnProperty.call(dict, code);
  function label(dict, code) {
    return has(dict, code) ? dict[code] : String(code);
  }
  function plural(n, one, few, many) {
    if (n === 1) return one;
    const tens = n % 100;
    const units = n % 10;
    return units >= 2 && units <= 4 && !(tens >= 12 && tens <= 14) ? few : many;
  }
  const fleetsText = (n) => `${n} ${plural(n, "fleet", "fleets", "fleets")}`;
  function fmtEta(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return "-";
    if (ms < MINUTE) return "< 1 min";
    if (ms < HOUR) {
      const minutes = Math.max(ETA_MINUTE_STEP, Math.round(ms / MINUTE / ETA_MINUTE_STEP) * ETA_MINUTE_STEP);
      return minutes * MINUTE >= HOUR ? "~1 h" : `~${minutes} min`;
    }
    if (ms < ETA_HOUR_LIMIT * HOUR) return `~${Math.round(ms / HOUR)} h`;
    return `~${Math.round(ms / DAY)} days`;
  }
  function staleText(sinceMs) {
    if (typeof sinceMs !== "number" || !Number.isFinite(sinceMs)) {
      return "⚠ Data from the last read (server under load)";
    }
    const d = new Date(sinceMs);
    const pad = (n) => String(n).padStart(2, "0");
    return `⚠ Data from ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} `
      + "(last read, server under load)";
  }
  function fmtAge(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "-";
    if (ms < MINUTE) return `${Math.floor(ms / SECOND)} s`;
    if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min`;
    if (ms < 2 * DAY) return `${Math.floor(ms / HOUR)} h`;
    return `${Math.floor(ms / DAY)} days`;
  }
  function percent(ratio) {
    const v = Math.round((Number(ratio) || 0) / PERCENT_DIVISOR);
    return Math.max(0, Math.min(PERCENT_MAX, v));
  }
  const firstBlocker = (p) => (Array.isArray(p.blockers) && p.blockers.length > 0
    ? label(BLOCKERS, p.blockers[0]) : null);
  function timedInvasionText(p, data) {
    const inv = data && data.attackerInvasion;
    if (!inv || !Array.isArray(p.blockers) || !p.blockers.includes("NO_CONSOLIDATION")) return null;
    if (inv.state === "WITHDRAWING") return "timed invasion · withdrawing";
    if (inv.withdrawMs === null || inv.withdrawMs === undefined) return "timed invasion · no deadline";
    return `timed invasion · withdrawal in ${fmtEta(inv.withdrawMs)}`;
  }
  function statusText(p, data) {
    const timed = timedInvasionText(p, data);
    if (timed !== null) return timed;
    const blocker = firstBlocker(p);
    switch (p.status) {
      case "READY": return "at the next evaluation";
      case "COUNTDOWN": return `expires in ${fmtEta(p.fallback ? p.fallback.etaMs : null)}`;
      case "BLOCKED": return blocker === null ? "no progress" : `no progress: ${blocker}`;
      case "REVERTING": return blocker === null ? "reverting" : `reverting: ${blocker}`;
      default: return fmtEta(p.etaMs);
    }
  }
  function sovText(p) {
    const s = p && p.sov;
    if (!s || typeof s !== "object") return null;
    const eta = typeof s.etaMs === "number" && Number.isFinite(s.etaMs) && s.etaMs > 0 ? ` · ${fmtEta(s.etaMs)}` : "";
    return `Sovereignty structure: ${label(SOV_HAVE, s.have)}${eta}`;
  }
  function fallbackText(p) {
    return p.status === "BLOCKED" && p.fallback ? `repelled in ${fmtEta(p.fallback.etaMs)}` : null;
  }
  const phaseLabel = (state) => label(PHASE_LABELS, state);
  function barLine(item) {
    return `${phaseLabel(item.state)} ${percent(item.ratio)}% · ${statusText(item)}`;
  }
  function opRowModel(item) {
    const blocked = item.status === "BLOCKED" || item.status === "REVERTING";
    let right = statusText(item);
    if (item.status === "BLOCKED") right = "no progress";
    else if (item.status === "REVERTING") right = "reverting";
    const reason = blocked ? firstBlocker(item) : null;
    return { phase: phaseLabel(item.state), right, note: reason === null ? `${percent(item.ratio)}%` : reason };
  }
  function stepperModel(state, status) {
    const at = PHASES.findIndex(([id]) => id === state);
    return PHASES.map(([id, text], i) => {
      let cls = "is-todo";
      if (at !== -1 && i < at) cls = "is-done";
      else if (i === at) {
        cls = "is-current";
        if (status === "REVERTING") cls += " is-warn";
        else if (status === "BLOCKED") cls += " is-held";
      }
      return { id, label: text, cls };
    });
  }
  const markTitle = (mark) => `${label(MARKS, mark.code)} ${mark.score}`;
  const markLeft = (score, scoreMax) => Math.max(0, Math.min(PERCENT_MAX, (score / scoreMax) * PERCENT_MAX));
  function isCalm(data) {
    const empty = (rows) => !rows || rows.length === 0;
    if (!data.system || data.system.state !== "STABLE") return false;
    if (data.progress !== null && data.progress !== undefined) return false;
    if (!empty(data.operations && data.operations.rows) || !empty(data.sieges) || !empty(data.invasions)
      || !empty(data.battles)) return false;
    const owner = data.system ? data.system.controller : null;
    return !data.fleets || data.fleets.groups.every((g) => g.factionId === owner);
  }
  function phaseFallbackText(data) {
    if (data.progress || !data.system || data.system.state === "STABLE") return null;
    return `${phaseLabel(data.system.state)} · progress unavailable`;
  }
  function opsEmptyText(loaded, unavailable) {
    if (loaded) return "No takeovers in progress";
    if (unavailable) return `Takeovers unavailable (${unavailable})`;
    return "Loading takeovers…";
  }
  function garrisonText(data, fmtNum) {
    const owner = data.system ? data.system.controller : null;
    const groups = data.fleets ? data.fleets.groups : [];
    const fleets = groups.filter((g) => g.factionId === owner && g.role === "garrison")
      .reduce((n, g) => n + g.fleets, 0);
    const row = (data.influence || []).find((r) => r.factionId === owner);
    const strength = row ? row.garrison : 0;
    const parts = [];
    if (fleets > 0) parts.push(fleetsText(fleets));
    if (strength > 0) parts.push(`strength ${fmtNum(strength)}`);
    return `Garrison: ${parts.length > 0 ? parts.join(" · ") : "none"}`;
  }
  function battleText(b) {
    if (b.open) return "ongoing";
    return b.outcome === null || b.outcome === undefined ? "interrupted" : label(OUTCOMES, b.outcome);
  }
  function messageFor(reason) {
    return has(REASONS, reason) ? REASONS[reason] : `No data (${reason || "unknown reason"}).`;
  }

  function crewModel(crews) {
    if (!crews || !Array.isArray(crews.fleets) || crews.fleets.length === 0) return null;
    const fleets = crews.fleets.map((f) => {
      const pilots = (f.pilots || []).map((p) => {
        const org = [p.corporationName, p.allianceName].filter((x) => x).join(" · ");
        const losses = p.losses > 0 ? `losses ${p.losses}` : "";
        return { name: p.name || `#${p.characterId}`, detail: [org, losses].filter((x) => x).join(" · ") };
      });
      return { fleetId: f.fleetId, factionId: f.factionId, seats: `${f.seated}/${f.wanted}`, pilots,
        more: Math.max(0, (Number(f.seated) || 0) - pilots.length) };
    });
    return { fleets, truncated: crews.truncated === true };
  }

  function createCard(h) {
    const { el, clear, fmtNum, colourOf } = h;
    const nameEl = el("div", { cls: "gc-name" });
    const secEl = el("span", { cls: "gc-sec" });
    const subEl = el("div", { cls: "gc-sub" });
    const ownerEl = el("div", { cls: "gc-owner" });
    const head = el("div", { cls: "gc-head" }, [el("div", { cls: "gc-title" }, [nameEl, secEl]), subEl, ownerEl]);
    const staleEl = el("div", { cls: "gc-stale hidden" });
    const msgEl = el("div", { cls: "gc-msg hidden" });
    const bodyEl = el("div", { cls: "gc-body" });
    const layerRows = el("div");
    const layersEl = el("details", { cls: "gc-layers hidden" },
      [el("summary", { text: "Layer details" }), layerRows]);
    const emptyEl = el("div", { cls: "gc-empty", text: "Click a system on the map" });
    const main = el("div", { cls: "gc-main hidden" }, [head, staleEl, msgEl, bodyEl, layersEl]);
    const root = el("div", { cls: "gc-card" }, [emptyEl, main]);
    let names = new Map();

    const nameOf = (id) => (names.get(id) || h.factionName(id));
    function dot(id) {
      const node = el("span", { cls: "gc-dot", title: nameOf(id) });
      node.style.setProperty("--fx", colourOf(id));
      return node;
    }
    function bar(pct, colour, large) {
      const fill = el("span", { cls: "gc-fill" });
      fill.style.width = `${pct}%`;
      const track = el("div", { cls: large ? "gc-bar gc-bar--lg" : "gc-bar" }, [fill]);
      if (colour) track.style.setProperty("--fx", colour);
      return track;
    }
    function row(children) {
      return el("div", { cls: "gc-row" }, children);
    }
    const cell = (text, cls) => el("span", { cls: cls || "gc-cell", text });
    function sectionTitle(text) {
      return el("h3", { cls: "gc-sec-title", text });
    }
    function setOwner(controller) {
      clear(ownerEl);
      ownerEl.classList.toggle("hidden", controller === undefined);
      if (controller === undefined) return;
      if (controller === null) {
        ownerEl.appendChild(cell("No controller", "gc-owner-name"));
        return;
      }
      ownerEl.appendChild(dot(controller));
      ownerEl.appendChild(cell(nameOf(controller), "gc-owner-name"));
      ownerEl.appendChild(cell("controller", "gc-owner-role"));
    }
    function showHeader(hd) {
      nameEl.textContent = hd.name;
      secEl.textContent = (hd.tenths / SECURITY_TENTHS).toFixed(1);
      secEl.style.setProperty("--sec", h.secColor(hd.tenths, hd.cls));
      subEl.textContent = `${hd.region} · ${hd.classLabel}`;
      setOwner(hd.controller);
      emptyEl.classList.add("hidden");
      main.classList.remove("hidden");
    }
    function setLoading() {
      clear(bodyEl);
      for (let i = 0; i < SKELETONS; i += 1) bodyEl.appendChild(el("div", { cls: "gc-skel" }));
    }

    function drawPhase(p, data) {
      const colour = p.attacker === null ? null : colourOf(p.attacker);
      const steps = el("div", { cls: "gc-steps" }, stepperModel(p.state, p.status).map((s) => el("div",
        { cls: `gc-step ${s.cls}`, title: s.label }, [el("span", { cls: "gc-step-dot" }),
          cell(s.label, "gc-step-label")])));
      const blocked = p.status === "BLOCKED" || p.status === "REVERTING";
      const pct = percent(p.ratio);
      const out = el("div", { cls: "gc-progress" }, [steps,
        el("div", { cls: "gc-phase" }, [cell(phaseLabel(p.state), "gc-phase-name"),
          blocked ? null : cell(statusText(p, data), "gc-phase-eta")]),
        el("div", { cls: "gc-bar-row" }, [bar(pct, colour, true), cell(`${pct}%`, "gc-pct")])]);
      if (colour) steps.style.setProperty("--fx", colour);
      if (p.attacker !== null) {
        out.appendChild(el("div", { cls: "gc-attacker" }, [cell("Attacker:", "gc-muted"), dot(p.attacker),
          cell(nameOf(p.attacker))]));
      }
      if (p.limiting && p.ratio < PERCENT_MAX * PERCENT_DIVISOR && !blocked) {
        out.appendChild(el("div", { cls: "gc-limit", text: `Held back by: ${label(LIMITING, p.limiting)}` }));
      }
      if (blocked) {
        out.appendChild(el("div", { cls: p.status === "REVERTING" ? "gc-blocker is-warn" : "gc-blocker",
          text: statusText(p, data) }));
      }
      const second = fallbackText(p);
      if (second !== null) out.appendChild(el("div", { cls: "gc-limit", text: second }));
      const sovLine = sovText(p);
      if (sovLine !== null) out.appendChild(el("div", { cls: "gc-limit", text: sovLine }));
      return out;
    }

    function drawInfluence(data) {
      if (data.influence.length === 0) return null;
      const list = el("div", { cls: "gc-section" }, [sectionTitle("Influence")]);
      for (const r of data.influence) {
        const track = bar(markLeft(r.score, data.scoreMax), colourOf(r.factionId), false);
        for (const mark of r.marks) {
          const tick = el("span", { cls: "gc-tick", title: markTitle(mark) });
          tick.style.left = `${markLeft(mark.score, data.scoreMax)}%`;
          track.appendChild(tick);
        }
        const roleText = r.role === null ? null : cell(label(ROLES, r.role), "gc-muted gc-role");
        list.appendChild(el("div", { cls: "gc-inf" }, [row([dot(r.factionId), cell(nameOf(r.factionId), "gc-grow"),
          roleText, cell(fmtNum(r.score), "gc-num")]), track]));
      }
      return list;
    }

    function drawFleets(data) {
      const inbound = data.operations ? data.operations.rows.filter((r) => r.inFlight > 0) : [];
      if (data.fleets === null) {
        return el("div", { cls: "gc-section" }, [sectionTitle("Fleets"), el("div", { cls: "note", text: MODULE_OFF })]);
      }
      if (data.fleets.groups.length === 0 && inbound.length === 0) return null;
      const out = el("div", { cls: "gc-section" }, [sectionTitle("Fleets"),
        el("div", { cls: "gc-kpi", text: garrisonText(data, fmtNum) })]);
      if (data.fleets.groups.length > 0) {
        out.appendChild(el("div", { cls: "gc-sub-title", text: "In system" }));
        for (const g of data.fleets.groups) {
          out.appendChild(row([dot(g.factionId), cell(`${label(FLEET_ROLES, g.role)} ${label(FLEET_STATES, g.state)}`,
            "gc-grow"), cell(fleetsText(g.fleets), "gc-num"), cell(`${fmtNum(g.ships)} ships`, "gc-num")]));
        }
      }
      if (data.fleets.truncated) out.appendChild(el("div", { cls: "note", text: "Some fleets are not shown." }));
      if (inbound.length > 0) {
        out.appendChild(el("div", { cls: "gc-sub-title", text: "Inbound" }));
        for (const r of inbound) {
          out.appendChild(row([dot(r.factionId),
            cell(`${label(OPERATION_TYPES, r.type)} from ${h.systemName(r.originSystemId)}`, "gc-grow"),
            cell(fleetsText(r.inFlight), "gc-num"), cell(r.etaMs === null ? "-" : `in ${fmtEta(r.etaMs)}`, "gc-num")]));
        }
      }
      return out;
    }

    function drawStations(data) {
      if (data.stations === null && data.sieges === null) {
        return el("div", { cls: "gc-section" }, [sectionTitle("Stations and sieges"),
          el("div", { cls: "note", text: MODULE_OFF })]);
      }
      const stations = data.stations || [];
      const sieges = data.sieges || [];
      if (stations.length === 0 && sieges.length === 0) return null;
      const out = el("div", { cls: "gc-section" }, [sectionTitle("Stations and sieges")]);
      const siegeLine = (x) => {
        const end = x.phaseEndsMs === null ? "" : `, ends in ${fmtEta(x.phaseEndsMs)}`;
        return el("div", { cls: "gc-sub-row", text: `siege: ${label(SIEGE_STATES, x.state)}${end}` });
      };
      const known = new Set(stations.map((st) => st.stationId));
      for (const st of stations) {
        out.appendChild(row([dot(st.ownerFactionId), cell(st.name || st.stationId, "gc-grow"),
          cell(label(STATION_STATES, st.state), "gc-num")]));
        for (const x of sieges) if (x.stationId === st.stationId) out.appendChild(siegeLine(x));
      }
      for (const x of sieges) {
        if (known.has(x.stationId)) continue;
        out.appendChild(row([dot(x.ownerFactionId), cell(x.stationId, "gc-grow")]));
        out.appendChild(siegeLine(x));
      }
      return out;
    }

    function drawOperations(data) {
      const rows = data.operations ? data.operations.rows : null;
      if (rows === null && data.invasions === null) {
        return el("div", { cls: "gc-section" }, [sectionTitle("Operations"),
          el("div", { cls: "note", text: MODULE_OFF })]);
      }
      const invasions = data.invasions || [];
      if ((rows || []).length === 0 && invasions.length === 0) return null;
      const out = el("div", { cls: "gc-section" }, [sectionTitle("Operations")]);
      for (const x of invasions) {
        const withdraw = x.withdrawMs === null || x.withdrawMs === undefined ? null
          : cell(`withdrawal in ${fmtEta(x.withdrawMs)}`, "gc-num");
        out.appendChild(row([dot(x.factionId), cell(`invasion · ${label(INVASION_STATES, x.state)}`, "gc-grow"),
          withdraw]));
      }
      for (const r of rows || []) {
        const due = r.dueMs !== null && r.dueMs > 0 ? cell(`due in ${fmtEta(r.dueMs)}`, "gc-num") : null;
        out.appendChild(row([dot(r.factionId),
          cell(`${label(OPERATION_TYPES, r.type)} · ${label(OPERATION_STATES, r.state)}`, "gc-grow"), due]));
      }
      if (data.operations && data.operations.truncated) {
        out.appendChild(el("div", { cls: "note", text: "Some operations are not shown." }));
      }
      return out;
    }

    function drawCrews(data) {
      const model = crewModel(data.crews);
      if (model === null) return null;
      const out = el("div", { cls: "gc-section" }, [sectionTitle("Pilots")]);
      for (const f of model.fleets) {
        out.appendChild(row([dot(f.factionId), cell(f.fleetId, "gc-grow"), cell(nameOf(f.factionId), "gc-muted"),
          cell(f.seats, "gc-num")]));
        for (const p of f.pilots) {
          out.appendChild(el("div", { cls: "gc-sub-row", text: p.detail ? `${p.name} · ${p.detail}` : p.name }));
        }
        if (f.more > 0) out.appendChild(el("div", { cls: "gc-sub-row gc-muted", text: `+${f.more}` }));
      }
      if (model.truncated) out.appendChild(el("div", { cls: "note", text: "Some pilots are not shown." }));
      return out;
    }

    function drawBattles(data) {
      if (data.battles === null) {
        return el("div", { cls: "gc-section" }, [sectionTitle("Recent battles"),
          el("div", { cls: "note", text: MODULE_OFF })]);
      }
      if (data.battles.length === 0) return null;
      const out = el("div", { cls: "gc-section" }, [sectionTitle("Recent battles")]);
      for (const b of data.battles) {
        const a = b.sides && b.sides.A ? dot(b.sides.A.factionId) : null;
        const z = b.sides && b.sides.B ? dot(b.sides.B.factionId) : null;
        const versus = a && z ? cell("×", "gc-muted") : null;
        out.appendChild(row([a, versus, z, cell(battleText(b), "gc-grow"), cell(`${fmtAge(b.ageMs)} ago`, "gc-num")]));
      }
      return out;
    }

    function setData(data) {
      clear(bodyEl);
      if (!data) return;
      names = new Map((data.names || []).filter((n) => n[1]).map((n) => [n[0], n[1]]));
      if (!data.inWorld) {
        setOwner(undefined);
        bodyEl.appendChild(el("div", { cls: "gc-outside", text: "System outside the simulation" }));
        return;
      }
      setOwner(data.system.controller);
      if (isCalm(data)) {
        const stations = data.stations === null ? "-" : fmtNum(data.stations.length);
        bodyEl.appendChild(el("div", { cls: "gc-calm", text: "✓ Stable · no conflict" }));
        bodyEl.appendChild(el("div", { cls: "gc-kpi", text: `${garrisonText(data, fmtNum)} · Stations: ${stations}` }));
        const crews = drawCrews(data);
        if (crews) bodyEl.appendChild(crews);
        return;
      }
      if (data.progress) bodyEl.appendChild(drawPhase(data.progress, data));
      const phaseFallback = phaseFallbackText(data);
      if (phaseFallback !== null) {
        bodyEl.appendChild(el("div", { cls: "gc-progress" }, [cell(phaseFallback, "gc-phase-name")]));
      }
      for (const part of [drawInfluence(data), drawFleets(data), drawCrews(data), drawStations(data),
        drawOperations(data), drawBattles(data)]) {
        if (part) bodyEl.appendChild(part);
      }
    }
    function setStale(sinceMs) {
      const on = sinceMs !== null && sinceMs !== undefined;
      root.classList.toggle("is-stale", on);
      staleEl.classList.toggle("hidden", !on);
      staleEl.textContent = on ? staleText(sinceMs) : "";
    }
    function setMessage(text) {
      msgEl.classList.toggle("hidden", text === null);
      msgEl.textContent = text === null ? "" : text;
    }
    function setLayerLines(rows) {
      clear(layerRows);
      layersEl.classList.toggle("hidden", rows.length === 0);
      for (const info of rows) {
        const text = info.lines ? info.lines.join(", ") : (info.label || "-");
        layerRows.appendChild(el("div", { cls: "gc-layer-row" }, [cell(info.title, "gc-muted"), cell(text)]));
      }
    }
    function hide() {
      main.classList.add("hidden");
      emptyEl.classList.remove("hidden");
      setStale(null);
      setMessage(null);
      clear(bodyEl);
    }

    return { root, showHeader, setLoading, setData, setStale, setMessage, setLayerLines, hide };
  }

  global.LneSystemCard = Object.freeze({
    createCard,
    _pure: Object.freeze({ label, plural, fmtEta, fmtAge, staleText, percent, statusText, fallbackText, phaseLabel, barLine,
      opRowModel, stepperModel, markTitle, markLeft, isCalm, phaseFallbackText, opsEmptyText, garrisonText, battleText,
      timedInvasionText, messageFor, crewModel, sovText }),
  });
}(typeof window !== "undefined" ? window : globalThis));
