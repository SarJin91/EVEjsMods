"use strict";

(function factionsModule(global) {
  const MINUS = "−";
  const SCALE = Object.freeze([[1e3, "k"], [1e6, "M"], [1e9, "B"], [1e12, "T"]]);
  const FLEET_STATE_ORDER = Object.freeze(["ENGAGED", "TRAVELLING", "RETREATING", "STAGED", "PLANNED", "REFITTING",
    "IDLE", "MATERIALIZED"]);
  const VERDICT_CLASS = Object.freeze({ WORKING: "ok", WAITING: "off", BLOCKED: "warn", STALE: "warn", ERROR: "error",
    NO_OFFENSIVE: "warn" });
  const NOTE_ORDER = Object.freeze(["blokada", "oczekiwane", "informacja"]);
  const NOTE_CLASS = Object.freeze({ blokada: "warn", oczekiwane: "muted", informacja: "normal" });
  const SECTION_IDS = Object.freeze(["isk", "fleets", "operations", "production", "mining", "territory", "strategy"]);
  const MS = Object.freeze({ s: 1000, min: 60000, h: 3600000, d: 86400000 });
  const ROLE_BADGE = Object.freeze({ "sde-only": "outside AI", capsuleers: "capsuleers" });
  const ROLE_LABEL = Object.freeze({ ai: "faction AI", invader: "invader (invasion module)", hive: "hive (no treasury)",
    capsuleers: "capsuleers (player-style NPC corporations)", "sde-only": "outside AI (SDE data only)" });
  const NO_TREASURY = "no treasury";
  const LIST_HEAD = Object.freeze([["faction", "", ""], ["treasury", "num", "faction ISK treasury balance"],
    ["fleets/ships", "num", "number of virtual fleets / ships in them"],
    ["systems", "num", "systems controlled in the LNE world (not fleets)"]]);

  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const dash = (v) => (v === null || v === undefined || v === "" ? "-" : String(v));

  function fmtScaled(v, unit) {
    if (!isNum(v)) return "-";
    const sign = v < 0 ? MINUS : "";
    const abs = Math.abs(v);
    const whole = Math.round(abs);
    if (whole < SCALE[0][0]) {
      const text = whole === 0 ? "0" : `${sign}${whole}`;
      return unit ? `${text} ${unit}` : text;
    }
    for (let i = 0; i < SCALE.length; i += 1) {
      const [step, name] = SCALE[i];
      const fixed = (abs / step).toFixed(2);
      if (Number(fixed) < 1000 || i === SCALE.length - 1) return `${sign}${fixed} ${name}`;
    }
    return "-";
  }
  function fmtIsk(v) {
    return fmtScaled(v, "ISK");
  }
  function fmtQty(v) {
    return fmtScaled(v, "");
  }
  function withSign(v, fmt) {
    if (!isNum(v)) return "-";
    if (Math.round(v) === 0) return fmt(0);
    return v > 0 ? `+${fmt(v)}` : fmt(v);
  }
  function fmtSigned(v) {
    return withSign(v, fmtIsk);
  }
  function fmtSignedQty(v) {
    return withSign(v, fmtQty);
  }
  function fmtOutflow(v) {
    return fmtSigned(isNum(v) ? -v : null);
  }
  function perPeriodText(per) {
    if (!isObject(per)) return "-";
    return `${fmtSignedQty(per.income)} ${isNum(per.cost) ? fmtSignedQty(-per.cost) : "-"} = ${fmtSignedQty(per.net)}`;
  }
  function fmtSpan(ms) {
    const m = Math.floor(ms / MS.min);
    if (ms < MS.min) return `${Math.max(0, Math.floor(ms / MS.s))} s`;
    if (ms < MS.h) return `${m} min`;
    if (ms < MS.d) return `${Math.floor(ms / MS.h)} h ${Math.floor((ms % MS.h) / MS.min)} min`;
    return `${Math.floor(ms / MS.d)} d ${Math.floor((ms % MS.d) / MS.h)} h`;
  }
  function fmtEta(dueAt, nowMs) {
    if (!isNum(dueAt) || !isNum(nowMs)) return "-";
    const diff = dueAt - nowMs;
    return diff >= 0 ? `in ${fmtSpan(diff)}` : `overdue ${fmtSpan(-diff)}`;
  }
  function hullsText(hulls) {
    const parts = arr(hulls).filter((h) => Array.isArray(h) && h.length >= 2).map(([g, n]) => `${g} ×${n}`);
    return parts.length ? parts.join(" · ") : "-";
  }
  function groupsText(groups) {
    if (!isObject(groups)) return "-";
    const rows = Object.entries(groups).filter(([, n]) => isNum(n) && n !== 0);
    rows.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return hullsText(rows);
  }
  function stateRank(state) {
    const i = FLEET_STATE_ORDER.indexOf(state);
    return i === -1 ? FLEET_STATE_ORDER.length : i;
  }
  function sortFleets(list) {
    const ships = (f) => (isNum(f && f.ships) ? f.ships : 0);
    const id = (f) => String((f && f.fleetId) || "");
    return arr(list).slice().sort((a, b) => stateRank(a && a.state) - stateRank(b && b.state)
      || ships(b) - ships(a) || (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0));
  }
  function noteRank(note) {
    const i = NOTE_ORDER.indexOf(note && note.category);
    return i === -1 ? NOTE_ORDER.length : i;
  }
  function noteClass(category) {
    return NOTE_CLASS[category] || "normal";
  }
  function verdictClass(code) {
    return Object.prototype.hasOwnProperty.call(VERDICT_CLASS, code) ? VERDICT_CLASS[code] : "unknown";
  }
  function shortId(id) {
    const text = String(id === null || id === undefined ? "" : id);
    const parts = text.split("_");
    return parts[parts.length - 1] || text || "-";
  }

  function sourceOk(sources, id) {
    const s = isObject(sources) ? sources[id] : null;
    return isObject(s) && s.available === true;
  }
  function missingText(sources, id) {
    const s = isObject(sources) ? sources[id] : null;
    const reason = isObject(s) && typeof s.reason === "string" && s.reason ? s.reason : "UNKNOWN";
    return `no data: ${id} (${reason})`;
  }
  function missing(sources, id) {
    return { type: "missing", text: missingText(sources, id) };
  }
  function controlledSystems(faction, sources) {
    const t = isObject(faction) && isObject(faction.territory) ? faction.territory : null;
    if (t && isNum(t.controlledSystems)) return t.controlledSystems;
    return sourceOk(sources, "control") ? 0 : null;
  }

  function listRows(data) {
    const d = isObject(data) ? data : {};
    return arr(d.factions).filter(isObject).map((f) => {
      const verdict = isObject(f.verdict) ? f.verdict : null;
      const treasury = isObject(f.isk) && isObject(f.isk.treasury) ? f.isk.treasury : null;
      const fl = isObject(f.fleets) ? f.fleets : null;
      const systems = controlledSystems(f, d.sources);
      const role = typeof f.role === "string" ? f.role : null;
      return {
        factionId: f.factionId,
        name: f.name || `faction ${f.factionId}`,
        role,
        roleBadge: role && Object.prototype.hasOwnProperty.call(ROLE_BADGE, role) ? ROLE_BADGE[role] : null,
        verdictClass: verdictClass(verdict && verdict.code),
        verdictLabel: verdict && verdict.label ? verdict.label : "-",
        balance: role === "hive" ? NO_TREASURY : treasury ? fmtIsk(treasury.balanceIsk) : "-",
        fleets: fl ? `${dash(fl.fleets)}/${dash(fl.ships)}` : "-",
        systems: systems === null ? "-" : String(systems),
      };
    });
  }

  function pickFaction(data, factionId) {
    const list = arr(isObject(data) ? data.factions : null).filter(isObject);
    return list.find((f) => f.factionId === factionId) || list[0] || null;
  }

  const kv = (rows) => ({ type: "kv", rows });
  const sub = (text) => ({ type: "h", text });
  const note = (text) => ({ type: "note", text });

  function iskSection(f, sources) {
    const blocks = [sub("Treasury")];
    const isk = isObject(f.isk) ? f.isk : {};
    if (f.role === "hive") blocks.push(note(`${NO_TREASURY} (hive, by design)`));
    else if (!sourceOk(sources, "factions")) blocks.push(missing(sources, "factions"));
    else if (!isObject(isk.treasury)) blocks.push(note("faction treasury inactive"));
    else {
      const t = isk.treasury;
      const today = isObject(t.today) ? t.today : {};
      const fc = isObject(t.forecast) ? t.forecast : {};
      const delta = isNum(t.balanceIsk) && isNum(t.initialIsk) ? t.balanceIsk - t.initialIsk : null;
      const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
      const fullDay = [];
      if (has(today, "admin")) fullDay.push(["today: administration", fmtIsk(today.admin)]);
      if (has(today, "warSpend")) fullDay.push(["today: war spending", fmtIsk(today.warSpend)]);
      if (has(today, "mercFees") || has(today, "mercRefunds")) {
        fullDay.push(["today: mercenaries (fees / refunds)",
          `${fmtOutflow(today.mercFees)} / ${fmtSigned(today.mercRefunds)}`]);
      }
      if (has(today, "net")) {
        fullDay.push(["today: net", fmtSigned(today.net), isNum(today.net) && today.net < 0 ? "warnv" : ""]);
      }
      if (has(t, "avg7dNetIsk")) {
        fullDay.push(["7-day average net", fmtSigned(t.avg7dNetIsk),
          isNum(t.avg7dNetIsk) && t.avg7dNetIsk < 0 ? "warnv" : ""]);
      }
      blocks.push(kv([
        ["balance", fmtIsk(t.balanceIsk)],
        ["change since start", fmtSigned(delta), isNum(delta) && delta < 0 ? "warnv" : ""],
        ["mode", dash(t.mode)],
        ["today: trade", `${fmtOutflow(today.tradeOut)} / ${fmtSigned(today.tradeIn)}`],
        ["today: production fees", fmtIsk(today.productionFees)],
        ["today: fleet upkeep", fmtIsk(today.fleetUpkeep)],
        ["today: battle losses (fit, ISK)", fmtIsk(today.losses)],
        ["today: income", fmtIsk(today.income)],
        ...fullDay,
        ["forecast", `${dash(fc.trend)} · days to zero ${dash(fc.daysToZero)} · days to austerity `
          + `${dash(fc.daysToAusterity)}`],
      ]));
    }
    blocks.push(sub("Trade budget"));
    if (!sourceOk(sources, "trade")) blocks.push(missing(sources, "trade"));
    else if (!isObject(isk.trade)) blocks.push(note("no faction entry in trade"));
    else {
      const t = isk.trade;
      const c = isObject(t.contracts) ? t.contracts : null;
      blocks.push(kv([
        ["available", fmtIsk(t.availableIsk)], ["reserved", fmtIsk(t.reservedIsk)],
        ["cap", fmtIsk(t.capIsk)], ["headroom", fmtIsk(t.headroomIsk)],
        ["funded", fmtIsk(t.fundedTotal)], ["spent", fmtIsk(t.spentTotal)],
        ["open offers", dash(t.openOffers)],
        ["contracts", c ? `${dash(c.open)}/${dash(c.cap)}` : "-"],
      ]));
    }
    blocks.push(sub("Resources"));
    if (!sourceOk(sources, "factions")) blocks.push(missing(sources, "factions"));
    else if (!isObject(isk.resources)) blocks.push(note("no faction entry in factions"));
    else {
      const r = isk.resources;
      const per = isObject(r.perPeriod) ? r.perPeriod : null;
      blocks.push(kv([
        ["units", fmtQty(r.units)], ["reserve", fmtQty(r.reserves)],
        ["per period", perPeriodText(per)],
        ["unpaid periods", dash(r.unpaidPeriods), isNum(r.unpaidPeriods) && r.unpaidPeriods > 0 ? "warnv" : ""],
      ]));
    }
    return blocks;
  }

  function fleetsSection(f, sources) {
    if (!sourceOk(sources, "faction-fleets")) return [missing(sources, "faction-fleets")];
    const fl = isObject(f.fleets) ? f.fleets : null;
    if (!fl) return [note("no fleets")];
    const byState = isObject(fl.byState) ? fl.byState : {};
    const chips = Object.keys(byState).sort((a, b) => stateRank(a) - stateRank(b))
      .map((st) => ({ text: `${st} ${byState[st]}`, cls: st.toLowerCase() }));
    const blocks = [
      kv([["fleets / ships", `${dash(fl.fleets)} / ${dash(fl.ships)}`], ["hulls", hullsText(fl.hulls)]]),
      { type: "chips", items: chips },
    ];
    const list = sortFleets(fl.list);
    if (list.length) {
      blocks.push({ type: "table",
        columns: [{ label: "fleet" }, { label: "role" }, { label: "state" }, { label: "system" }, { label: "target" },
          { label: "ships", num: true }, { label: "hulls" }, { label: "operation" }, { label: "supply" }],
        rows: list.map((r) => [
          { text: shortId(r.fleetId), title: dash(r.fleetId) }, dash(r.role), dash(r.state),
          dash(r.systemName || r.systemId), dash(r.targetName || r.targetSystemId), dash(r.ships), hullsText(r.hulls),
          r.operationId ? { text: shortId(r.operationId), title: String(r.operationId) } : "-",
          `${dash(r.supply)}${r.refitPending ? " (refit)" : ""}`,
        ]) });
    }
    const more = isNum(fl.fleets) ? fl.fleets - list.length : 0;
    if (fl.truncated && more > 0) blocks.push(note(`+${more} more`));
    return blocks;
  }

  function operationsSection(f, sources, nowMs) {
    if (!sourceOk(sources, "faction-fleets")) return [missing(sources, "faction-fleets")];
    const ops = isObject(f.fleets) && isObject(f.fleets.operations) ? f.fleets.operations : null;
    const list = ops ? arr(ops.list).filter(isObject) : [];
    const blocks = [];
    if (!list.length) blocks.push(note("no open operations"));
    else {
      blocks.push({ type: "table",
        columns: [{ label: "type / objective" }, { label: "state" }, { label: "target system" }, { label: "fleets", num: true },
          { label: "ETA" }],
        rows: list.map((o) => [`${dash(o.type)} / ${dash(o.objective)}`, dash(o.state),
          dash(o.targetName || o.targetSystemId), dash(o.fleets), fmtEta(o.dueAt, nowMs)]) });
    }
    if (ops && ops.truncated === true && list.length) blocks.push(note("+ more"));
    return blocks;
  }

  function productionSection(f, sources, nowMs) {
    if (!sourceOk(sources, "production")) return [missing(sources, "production")];
    const p = isObject(f.production) ? f.production : null;
    if (!p) return [note("no faction entry in production")];
    const lines = isObject(p.lines) ? p.lines : {};
    const pool = isObject(p.hullPool) ? p.hullPool : null;
    const d24 = isObject(p.last24h) ? p.last24h : {};
    const blocks = [kv([
      ["lines", `${dash(lines.used)}/${dash(lines.total)}`],
      ["hull pool", pool ? `${dash(pool.total)}: ${groupsText(pool.groups)}` : "-"],
      ["in production", groupsText(p.inProduction)],
      ["deficit", groupsText(p.deficit), groupsText(p.deficit) !== "-" ? "warnv" : ""],
      ["24 h from lines: delivered / lost in build", `${dash(d24.hullsDelivered)} / ${dash(d24.hullsLost)}`],
    ])];
    const jobs = arr(p.jobs).filter(isObject);
    if (jobs.length) {
      blocks.push({ type: "table",
        columns: [{ label: "hull" }, { label: "runs", num: true }, { label: "station" }, { label: "system" },
          { label: "ETA" }],
        rows: jobs.map((j) => [dash(j.hullGroup), dash(j.runs), dash(j.station), dash(j.systemName || j.systemId),
          fmtEta(j.dueAt, nowMs)]) });
    }
    const more = isNum(p.jobsTotal) ? p.jobsTotal - jobs.length : 0;
    if (more > 0) blocks.push(note(`+${more}`));
    return blocks;
  }

  function miningSection(f, sources) {
    if (!sourceOk(sources, "mining")) return [missing(sources, "mining")];
    const m = isObject(f.mining) ? f.mining : null;
    if (!m) return [note("no faction entry in mining")];
    const miners = isObject(m.miners) ? m.miners : {};
    const d24 = isObject(m.last24h) ? m.last24h : {};
    const stock = isObject(m.mineralStock) ? m.mineralStock : null;
    const minerals = stock ? arr(stock.minerals).filter((x) => Array.isArray(x))
      .map(([name, q]) => `${dash(name)} ${fmtQty(q)}`).join(" · ") : "";
    return [kv([
      ["miners live / idle / on trip", `${dash(miners.live)} / ${dash(miners.idle)} / ${dash(miners.onTrip)}`],
      ["24 h delivered / lost", `${fmtQty(d24.delivered)} / ${fmtQty(d24.lost)}`],
      ["mineral stock", stock ? fmtQty(stock.total) : "-"],
      ["minerals", minerals || "-"],
    ])];
  }

  function territorySection(f, sources) {
    const t = isObject(f.territory) ? f.territory : {};
    const blocks = [];
    const rows = [];
    const systems = controlledSystems(f, sources);
    rows.push(["controlled systems (LNE world)", systems === null ? missingText(sources, "control") : String(systems),
      systems === null ? "fx-missing" : ""]);
    if (sourceOk(sources, "factions")) {
      const fr = isObject(t.fronts) ? t.fronts : null;
      rows.push(["border systems", dash(t.borderSystems)]);
      rows.push(["fronts", fr ? `${dash(fr.count)}/${dash(fr.limit)}` : "-"]);
    } else rows.push(["border systems, fronts", missingText(sources, "factions"), "fx-missing"]);
    blocks.push(kv(rows));
    blocks.push(sub("Stations"));
    if (!sourceOk(sources, "stations")) blocks.push(missing(sources, "stations"));
    else if (!isObject(t.stations)) blocks.push(note("no stations"));
    else {
      const st = t.stations;
      blocks.push(kv([["stations", dash(st.total)], ["kinds", groupsText(st.byKind)], ["states", groupsText(st.byState)]]));
      const list = arr(st.list).filter(isObject);
      if (list.length) {
        blocks.push({ type: "details", label: `Station list (${list.length}${st.truncated ? "+" : ""})`, blocks: [
          { type: "table", columns: [{ label: "station" }, { label: "system" }, { label: "kind" }, { label: "state" }],
            rows: list.map((s) => [dash(s.station), dash(s.system), dash(s.kind), dash(s.state)]) }] });
      }
    }
    blocks.push(sub("Convoys"));
    if (!sourceOk(sources, "logistics")) blocks.push(missing(sources, "logistics"));
    else {
      const l = isObject(f.logistics) ? f.logistics : null;
      const d24 = l && isObject(l.last24h) ? l.last24h : {};
      const tot = l && isObject(l.totals) ? l.totals : {};
      blocks.push(kv([["open", l ? dash(l.open) : "0"],
        ["24 h delivered / lost", `${dash(d24.delivered)} / ${dash(d24.lost)}`],
        ["total delivered / lost", `${dash(tot.delivered)} / ${dash(tot.lost)}`]]));
    }
    return blocks;
  }

  function strategySection(f, sources, nowMs) {
    const s = isObject(f.strategy) ? f.strategy : {};
    const blocks = [];
    const rows = [];
    if (sourceOk(sources, "factions")) {
      const r = isObject(s.lastReview) ? s.lastReview : null;
      rows.push(["last review", r ? `round ${dash(r.round)} · ${dash(r.outcome)} · target ${dash(r.target)}` : "-"]);
    } else rows.push(["last review", missingText(sources, "factions"), "fx-missing"]);
    if (!sourceOk(sources, "activity")) {
      rows.push(["plans", missingText(sources, "activity"), "fx-missing"]);
      blocks.push(kv(rows));
      return blocks;
    }
    const p = isObject(s.plans) ? s.plans : {};
    const target = isObject(p.target) ? p.target : null;
    const decision = arr(p.decision).filter(isObject).map((d) => `${dash(d.label || d.type)} ×${dash(d.count)}`);
    rows.push(["target", target ? dash(target.name || target.systemId) : "-"]);
    rows.push(["decision", decision.length ? decision.join(" · ") : "-"]);
    rows.push(["next review", fmtEta(p.nextReviewAt, nowMs)]);
    const off = isObject(s.offensive) ? s.offensive : null;
    const idle = off && isObject(off.idleInvasion) ? off.idleInvasion : null;
    if (idle && isNum(idle.fleets) && idle.fleets > 0) {
      rows.push(["idle invasion fleets", `${idle.fleets}${idle.truncated ? "+" : ""} (${dash(idle.ships)} ships)`
        + `${isNum(idle.oldestSince) && isNum(nowMs) ? `, oldest idle for ${fmtAgeMs(nowMs - idle.oldestSince)}` : ""}`]);
    }
    const tr = isObject(s.truces) && s.truces.status === "ok" ? s.truces : null;
    if (tr) {
      for (const t of arr(tr.items).filter(isObject)) {
        if (!isNum(t.until) || (isNum(nowMs) && t.until <= nowMs)) continue;
        const partner = dash(t.partnerName || t.partnerId);
        const asker = t.initiator === f.factionId ? ", asked by this faction" : (isNum(t.initiator) ? `, asked by ${partner}` : "");
        rows.push([`truce with ${partner}`, `ends ${fmtEta(t.until, nowMs)}${asker}`]);
      }
      if (tr.truncated) rows.push(["+ more truces", "…"]);
    }
    blocks.push(kv(rows));
    const notes = arr(s.notes).filter(isObject);
    if (notes.length) {
      blocks.push({ type: "notes", items: notes.map((n) => ({
        text: `${dash(n.text || n.code)}${n.arg ? ` (${n.arg})` : ""}`, cls: noteClass(n.category),
        title: dash(n.code) })) });
    } else blocks.push(note("no notes"));
    if (isNum(s.notesTruncated) && s.notesTruncated > 0) blocks.push(note(`+${s.notesTruncated} notes`));
    return blocks;
  }

  function fmtAgeMs(ms) {
    return isNum(ms) ? fmtSpan(Math.max(0, ms)) : "-";
  }

  function detailModel(faction, sources, nowMs) {
    const f = isObject(faction) ? faction : {};
    const verdict = isObject(f.verdict) ? f.verdict : null;
    const corp = isObject(f.corporation) ? f.corporation : null;
    const header = {
      factionId: f.factionId === undefined ? null : f.factionId,
      name: f.name || `faction ${dash(f.factionId)}`,
      verdictClass: verdictClass(verdict && verdict.code),
      verdictLabel: verdict && verdict.label ? verdict.label : "-",
      rows: [
        ["role", Object.prototype.hasOwnProperty.call(ROLE_LABEL, f.role) ? ROLE_LABEL[f.role] : dash(f.role)],
        ["kind", dash(f.kind)], ["status", dash(f.status)], ["base", dash(f.base)], ["doctrine", dash(f.doctrine)],
        ["campaigns", arr(f.campaigns).length ? arr(f.campaigns).map((c) => (isObject(c) ? dash(c.id || c.name)
          : dash(c))).join(", ") : "none"],
        ["corporation", corp ? dash(corp.name || corp.id) : "-"],
      ],
      sentence: verdict && verdict.sentence ? verdict.sentence
        : (sourceOk(sources, "activity") ? "" : missingText(sources, "activity")),
    };
    const sections = [
      { id: "isk", title: "ISK", blocks: iskSection(f, sources) },
      { id: "fleets", title: "Fleets", blocks: fleetsSection(f, sources) },
      { id: "operations", title: "Operations", blocks: operationsSection(f, sources, nowMs) },
      { id: "production", title: "Production", blocks: productionSection(f, sources, nowMs) },
      { id: "mining", title: "Mining", blocks: miningSection(f, sources) },
      { id: "territory", title: "Territory and stations", blocks: territorySection(f, sources) },
      { id: "strategy", title: "Strategy", blocks: strategySection(f, sources, nowMs) },
    ];
    const src = isObject(sources) ? sources : {};
    const down = Object.keys(src).filter((id) => !sourceOk(src, id)).map((id) => missingText(src, id));
    let oldest = null;
    for (const id of Object.keys(src)) {
      const a = isObject(src[id]) && src[id].available === true ? src[id].ageMs : null;
      if (isNum(a) && (oldest === null || a > oldest.ageMs)) oldest = { id, ageMs: a };
    }
    const footer = { unavailable: down,
      oldest: oldest ? `oldest source: ${oldest.id} (${fmtAgeMs(oldest.ageMs)})` : "" };
    return { header, sections, footer };
  }

  function createPanel(h) {
    const { el, clear } = h;
    const ui = { data: null, selected: null, nowMs: 0 };
    if (typeof h.getHash === "function") {
      const parsed = h.getHash();
      if (parsed && Number.isSafeInteger(parsed.factionId)) ui.selected = parsed.factionId;
    }
    const errorSlot = el("div", { cls: "card-error hidden" });
    const banner = el("div");
    const listBox = el("div", { cls: "fx-list" });
    const detailBox = el("div", { cls: "fx-detail" });
    const root = el("div", { cls: "fx" }, [errorSlot, banner, el("div", { cls: "fx-layout" }, [listBox, detailBox])]);

    function cell(v) {
      if (isObject(v)) return el("span", { text: v.text, title: v.title });
      return v;
    }
    function block(b) {
      switch (b.type) {
        case "h": return el("h4", { cls: "fx-sub", text: b.text });
        case "kv": return h.kvTable(b.rows.map(([k, v, cls]) => [k, v, cls || ""]));
        case "note": return el("div", { cls: "note", text: b.text });
        case "missing": return el("div", { cls: "fx-missing", text: b.text });
        case "chips": return el("div", { cls: "fx-chips" },
          b.items.map((c) => el("span", { cls: `fx-chip fx-st-${String(c.cls).replace(/[^a-z]/g, "")}`, text: c.text })));
        case "notes": return el("ul", { cls: "fx-notes" },
          b.items.map((n) => el("li", { cls: `fx-note-${n.cls}`, text: n.text, title: n.title })));
        case "table": return h.table(b.columns.map((c, i) => ({ label: c.label, num: c.num === true,
          get: (row) => cell(row[i]) })), b.rows);
        case "details": {
          const box = el("details", null, [el("summary", { text: b.label })]);
          box.appendChild(el("div", null, b.blocks.map(block)));
          return box;
        }
        default: return null;
      }
    }

    function openLabels() {
      const out = new Set();
      for (const d of detailBox.querySelectorAll("details[open]")) {
        const s = d.querySelector("summary");
        if (s) out.add(s.textContent.replace(/\s*\(.*$/, ""));
      }
      return out;
    }

    function choose(id) {
      ui.selected = id;
      if (typeof h.setHash === "function") h.setHash({ tab: "factions", factionId: id });
      draw();
    }

    function drawList(rows, chosenId) {
      clear(listBox);
      const body = el("tbody");
      for (const r of rows) {
        const tr = el("tr", { cls: `fx-row${r.factionId === chosenId ? " fx-selected" : ""}` }, [
          el("td", null, [el("div", { cls: "fx-name", text: r.name }), h.badge(r.verdictClass, r.verdictLabel),
            r.roleBadge ? h.badge("unknown", r.roleBadge) : null]),
          el("td", { cls: "num", text: r.balance }),
          el("td", { cls: "num", text: r.fleets }),
          el("td", { cls: "num", text: r.systems }),
        ]);
        tr.addEventListener("click", () => choose(r.factionId));
        body.appendChild(tr);
      }
      const head = el("tr", null, LIST_HEAD.map(([t, cls, title]) => el("th", { cls, text: t, title })));
      listBox.appendChild(el("table", { cls: "fx-table" }, [el("thead", null, [head]), body]));
    }

    function drawDetail(model) {
      const opened = openLabels();
      clear(detailBox);
      const hd = model.header;
      detailBox.appendChild(el("div", { cls: "fx-head" }, [el("h3", { cls: "fx-title", text: hd.name }),
        h.badge(hd.verdictClass, hd.verdictLabel)]));
      if (hd.sentence) detailBox.appendChild(el("div", { cls: "note", text: hd.sentence }));
      detailBox.appendChild(h.kvTable(hd.rows));
      const grid = el("div", { cls: "fx-sections" });
      for (const s of model.sections) {
        grid.appendChild(el("section", { cls: `fx-section fx-sec-${s.id}` },
          [el("h3", { text: s.title }), ...s.blocks.map(block)]));
      }
      detailBox.appendChild(grid);
      const foot = [...model.footer.unavailable, model.footer.oldest].filter(Boolean);
      if (foot.length) detailBox.appendChild(el("div", { cls: "note fx-foot", text: foot.join(" · ") }));
      for (const d of detailBox.querySelectorAll("details")) {
        const s = d.querySelector("summary");
        if (s && opened.has(s.textContent.replace(/\s*\(.*$/, ""))) d.open = true;
      }
    }

    function draw() {
      const d = ui.data;
      clear(banner);
      if (!d) return;
      if (d.available === false) {
        const parts = [d.reason, d.detail].filter(Boolean).join(" - ");
        banner.appendChild(el("div", { cls: "banner banner-warn", text: `Not available: ${parts || "unknown"}` }));
        clear(listBox);
        clear(detailBox);
        return;
      }
      const chosen = pickFaction(d, ui.selected);
      drawList(listRows(d), chosen ? chosen.factionId : null);
      if (!chosen) {
        clear(detailBox);
        detailBox.appendChild(el("div", { cls: "note", text: "no faction" }));
        return;
      }
      drawDetail(detailModel(chosen, d.sources, ui.nowMs));
      if (isNum(d.factionsTruncated) && d.factionsTruncated > 0) {
        listBox.appendChild(el("div", { cls: "note", text: `+${d.factionsTruncated} factions not listed` }));
      }
    }

    function update(data) {
      errorSlot.classList.add("hidden");
      ui.data = isObject(data) ? data : null;
      ui.nowMs = ui.data && isNum(ui.data.generatedAt) ? ui.data.generatedAt : Date.now();
      draw();
    }
    function error(text) {
      errorSlot.textContent = text;
      errorSlot.classList.remove("hidden");
    }
    function select(factionId) {
      ui.selected = Number.isSafeInteger(factionId) ? factionId : null;
      draw();
    }
    return { root, update, error, select };
  }

  global.LneFactions = Object.freeze({
    createPanel, SECTION_IDS, ROLE_BADGE,
    _pure: Object.freeze({ fmtIsk, fmtQty, fmtEta, hullsText, groupsText, sortFleets, noteRank, noteClass,
      verdictClass, listRows, pickFaction, detailModel, controlledSystems, fmtSigned, fmtOutflow, perPeriodText }),
  });
}(typeof window !== "undefined" ? window : globalThis));
