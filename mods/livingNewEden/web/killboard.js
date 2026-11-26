"use strict";

(function killboardModule(global) {
  const PAGES = Object.freeze(["battles", "battle", "faction", "factions", "kills", "kill", "character"]);
  const PAGE_PARAMS = Object.freeze({
    battles: Object.freeze({ required: [], optional: ["faction", "system", "before"], view: "kb-battles" }),
    battle: Object.freeze({ required: ["battle"], optional: [], view: "kb-battle" }),
    faction: Object.freeze({ required: ["faction"], optional: ["before"], view: "kb-faction" }),
    factions: Object.freeze({ required: [], optional: [], view: "kb-factions" }),
    kills: Object.freeze({ required: [], optional: ["system", "before"], view: "kb-kills" }),
    kill: Object.freeze({ required: ["kill"], optional: [], view: "kb-kill" }),
    character: Object.freeze({ required: ["character"], optional: ["before"], view: "kb-character" }),
  });
  const KILL_PAGES = Object.freeze(["kills", "kill", "character"]);
  const DEFAULT = Object.freeze({ page: "battles", params: Object.freeze({}) });

  function idOf(text) {
    if (typeof text !== "string" || !/^[1-9][0-9]*$/.test(text)) return null;
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : null;
  }

  function queryOf(text) {
    const out = {};
    for (const pair of String(text || "").split("&")) {
      if (pair === "") continue;
      const i = pair.indexOf("=");
      const name = i < 0 ? pair : pair.slice(0, i);
      out[name] = i < 0 ? "" : pair.slice(i + 1);
    }
    return out;
  }

  function parseHash(hash) {
    let text = typeof hash === "string" ? hash.replace(/^#/, "") : "";
    if (text === "" || text === "/") return { page: DEFAULT.page, params: {} };
    if (text[0] !== "/") return { page: DEFAULT.page, params: {} };
    text = text.slice(1);
    const q = text.indexOf("?");
    const path = q < 0 ? text : text.slice(0, q);
    const query = queryOf(q < 0 ? "" : text.slice(q + 1));
    const parts = path.split("/");
    const page = parts[0] === "" ? "battles" : parts[0];
    if (!PAGES.includes(page)) return { page: DEFAULT.page, params: {} };
    const spec = PAGE_PARAMS[page];
    const params = {};
    if (spec.required.length === 1) {
      if (parts.length !== 2) return { page: DEFAULT.page, params: {} };
      const id = idOf(parts[1]);
      if (id === null) return { page: DEFAULT.page, params: {} };
      params[spec.required[0]] = id;
    } else if (parts.length !== 1) {
      return { page: DEFAULT.page, params: {} };
    }
    for (const name of spec.optional) {
      const id = idOf(query[name]);
      if (id !== null) params[name] = id;
    }
    return { page, params };
  }

  function formatHash(page, params) {
    const spec = PAGE_PARAMS[page];
    if (!spec) return "#/";
    const p = params || {};
    let path = page === "battles" ? "#/" : `#/${page}`;
    if (spec.required.length === 1) path += `/${p[spec.required[0]]}`;
    const pairs = spec.optional.filter((n) => Number.isSafeInteger(p[n]) && p[n] > 0).map((n) => `${n}=${p[n]}`);
    return pairs.length === 0 ? path : `${page === "battles" ? "#/battles" : path}?${pairs.join("&")}`;
  }

  function buildViewUrl(page, params) {
    const spec = Object.prototype.hasOwnProperty.call(PAGE_PARAMS, page) ? PAGE_PARAMS[page] : null;
    if (!spec) return null;
    const p = params && typeof params === "object" ? params : {};
    const allowed = spec.required.concat(spec.optional);
    for (const name of Object.keys(p)) {
      if (!allowed.includes(name)) return null;
      if (p[name] === undefined || p[name] === null) continue;
      if (!Number.isSafeInteger(p[name]) || p[name] <= 0) return null;
    }
    const pairs = [];
    for (const name of allowed) {
      const v = p[name];
      if (v === undefined || v === null) {
        if (spec.required.includes(name)) return null;
        continue;
      }
      pairs.push(`${name}=${v}`);
    }
    return `/api/views/${spec.view}${pairs.length === 0 ? "" : `?${pairs.join("&")}`}`;
  }

  function formatIsk(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    const a = Math.abs(n);
    if (a >= 1e9) return `${(n / 1e9).toFixed(2)} B`;
    if (a >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
    if (a >= 1e3) return `${(n / 1e3).toFixed(1)} k`;
    return String(Math.round(n));
  }

  function formatAgo(atMs, nowMs) {
    if (!Number.isFinite(atMs) || !Number.isFinite(nowMs)) return "—";
    const s = Math.max(0, Math.round((nowMs - atMs) / 1000));
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 172800) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }

  const RESULT_LABELS = Object.freeze({ W: "Win", L: "Loss", D: "Draw", U: "Undecided" });
  const resultLabel = (r) => RESULT_LABELS[r] || "—";

  const ROLE_LABELS = Object.freeze({ V: "Victim", A: "Attacker", F: "Final blow" });
  const roleLabel = (role) => (Object.prototype.hasOwnProperty.call(ROLE_LABELS, role) ? ROLE_LABELS[role] : "—");

  function killsUnavailableText(res) {
    return res && res.status === 404 && res.body && res.body.error && res.body.error.reason === "VIEW_NOT_FOUND"
      ? "killboard.killmailsEnabled = off" : null;
  }

  global.LneKillboard = Object.freeze({
    PAGES,
    _pure: Object.freeze({ parseHash, formatHash, buildViewUrl, formatIsk, formatAgo, resultLabel, roleLabel,
      killsUnavailableText }),
  });

  if (typeof document === "undefined" || typeof fetch !== "function") return;

  function el(tag, opts, children) {
    const node = document.createElement(tag);
    if (opts) {
      if (opts.cls) node.setAttribute("class", opts.cls);
      if (opts.text !== undefined && opts.text !== null) node.textContent = String(opts.text);
      if (opts.href) node.setAttribute("href", opts.href);
      if (opts.title) node.setAttribute("title", opts.title);
    }
    for (const child of children || []) if (child) node.appendChild(child);
    return node;
  }
  const $ = (id) => document.getElementById(id);
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }
  const num = (v) => (Number.isFinite(v) ? v.toLocaleString() : "—");

  function factionChip(f) {
    const label = f.name || `#${f.id}`;
    const a = el("a", { cls: "kb-faction", text: label, href: formatHash("faction", { faction: f.id }) });
    if (Number.isSafeInteger(f.id)) a.style.setProperty("border-color", `hsl(${(f.id * 47) % 360} 55% 50%)`);
    return a;
  }

  function table(headers, rows) {
    const head = el("tr", null, headers.map((h) => el("th", { text: h })));
    const body = el("tbody", null, rows.map((cells) => el("tr", null, cells.map((c) => (
      c instanceof Node ? el("td", null, [c]) : el("td", { text: c }))))));
    return el("table", { cls: "kb-table" }, [el("thead", null, [head]), body]);
  }

  function setBanner(text) {
    const b = $("kb-banner");
    b.textContent = text || "";
    b.classList.toggle("hidden", !text);
  }

  async function getJson(url) {
    const res = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
    let body = null;
    try {
      body = await res.json();
    } catch (_err) {
      body = null;
    }
    return { status: res.status, body };
  }

  const state = { factions: null, seq: 0 };

  async function loadFactions() {
    if (state.factions !== null) return;
    const url = buildViewUrl("factions", {});
    const r = await getJson(url);
    state.factions = r.status === 200 && r.body && r.body.data && r.body.data.available === true
      ? r.body.data.factions : [];
  }

  function systemLabel(d) {
    const name = d.systemName || `#${d.systemId}`;
    return Number.isFinite(d.security) ? `${name} (${d.security.toFixed(1)})` : name;
  }

  function moreLink(page, params, nextBefore) {
    if (!Number.isSafeInteger(nextBefore)) return null;
    return el("p", { cls: "kb-more" }, [el("a", { text: "Older →",
      href: formatHash(page, { ...params, before: nextBefore }) })]);
  }

  function renderBattles(root, data, params) {
    const form = el("div", { cls: "kb-filters" });
    const select = el("select", { cls: "kb-select" });
    select.appendChild(el("option", { text: "All factions" }));
    select.options[0].value = "";
    for (const f of state.factions || []) {
      const o = el("option", { text: f.name || `#${f.factionId}` });
      o.value = String(f.factionId);
      if (f.factionId === params.faction) o.selected = true;
      select.appendChild(o);
    }
    const sys = el("input", { cls: "kb-input" });
    sys.setAttribute("type", "text");
    sys.setAttribute("inputmode", "numeric");
    sys.setAttribute("placeholder", "System ID");
    if (params.system) sys.value = String(params.system);
    const go = el("button", { text: "Filter" });
    go.setAttribute("type", "button");
    go.addEventListener("click", () => {
      const next = {};
      const f = Number(select.value);
      const s = Number(sys.value.trim());
      if (Number.isSafeInteger(f) && f > 0) next.faction = f;
      if (Number.isSafeInteger(s) && s > 0) next.system = s;
      global.location.hash = formatHash("battles", next);
    });
    form.appendChild(el("label", { text: "Faction " }, [select]));
    form.appendChild(el("label", { text: "System " }, [sys]));
    form.appendChild(go);
    root.appendChild(form);
    const now = Date.now();
    const rows = (data.rows || []).map((r) => [
      el("a", { text: `#${r.no}`, href: formatHash("battle", { battle: r.no }) }),
      formatAgo(r.settledAt, now),
      systemLabel(r),
      el("span", null, (r.a.factions || []).map(([id, name, result]) => el("span", { cls: "kb-chipwrap" },
        [factionChip({ id, name }), el("span", { cls: `kb-res kb-res-${result}`, text: resultLabel(result) })]))),
      el("span", null, (r.b.factions || []).map(([id, name, result]) => el("span", { cls: "kb-chipwrap" },
        [factionChip({ id, name }), el("span", { cls: `kb-res kb-res-${result}`, text: resultLabel(result) })]))),
      `${num(r.a.shipsLost)} / ${num(r.b.shipsLost)}`,
      formatIsk(r.iskTotal),
    ]);
    root.appendChild(el("h2", { text: "Battles" }));
    if (rows.length === 0) root.appendChild(el("p", { cls: "kb-empty", text: "No settled battles." }));
    else root.appendChild(table(["No.", "Time", "System", "Side A", "Side B", "Destroyed A / B", "ISK"], rows));
    const more = moreLink("battles", params, data.nextBefore);
    if (more) root.appendChild(more);
  }

  function renderBattle(root, d) {
    root.appendChild(el("h2", { text: `Battle #${d.no}` }));
    const meta = [["System", systemLabel(d)], ["Settled", `${new Date(d.settledAt).toLocaleString()} (`
      + `${formatAgo(d.settledAt, Date.now())})`], ["Mode", d.mode], ["Environment", d.environment],
    ["Objective", d.objective], ["Outcome", d.outcome || "—"],
    ["Duration", Number.isFinite(d.durationSec) ? `${d.durationSec} s` : "—"],
    ["Unpriced", num(d.unpriced)]];
    if (d.structure) {
      meta.push(["Structure", `${d.structure.typeName || `#${d.structure.typeId}`} - `
        + `${d.structure.destroyed === true ? "destroyed" : (d.structure.destroyed === false ? "survived" : "—")}`]);
    }
    root.appendChild(table(["", ""], meta));
    if (d.summaryOnly) {
      root.appendChild(el("p", { cls: "kb-note", text: "Summary only (no battle details)." }));
    }
    for (const side of d.sides || []) {
      const box = el("section", { cls: "kb-side" });
      box.appendChild(el("h3", { text: `Side ${side.side}: ${num(side.shipsLost)} destroyed, `
        + `${formatIsk(side.iskLost)} ISK` }));
      box.appendChild(el("div", { cls: "kb-chips" }, (side.factions || []).map((f) => el("span", { cls: "kb-chipwrap" },
        [factionChip(f), el("span", { cls: `kb-res kb-res-${f.result}`, text: resultLabel(f.result) })]))));
      const rows = [];
      for (const fleet of side.fleets || []) {
        for (const h of fleet.hulls || []) {
          rows.push([fleet.fleetRole || "—", h.typeName || h.hullGroup, num(h.start), num(h.destroyed),
            num(h.escaped), num(h.surviving), formatIsk(h.iskDestroyed)]);
        }
      }
      if (rows.length > 0) {
        box.appendChild(table(["Fleet", "Hull", "Start", "Destroyed", "Escaped", "Survived", "ISK"], rows));
      }
      root.appendChild(box);
    }
    const kills = Array.isArray(d.capsuleerKills) ? d.capsuleerKills : [];
    root.appendChild(el("h3", { text: "Capsuleers in system during the battle" }));
    if (kills.length === 0) {
      root.appendChild(el("p", { cls: "kb-empty", text: "None." }));
    } else {
      const now = Date.now();
      root.appendChild(table(["Kill", "Time", "Victim", "Ship", "ISK", "Attackers"], kills.map((k) => [
        el("a", { text: `#${k.killId}`, href: formatHash("kill", { kill: k.killId }) }), formatAgo(k.killAt, now),
        charLink(k.victim && k.victim.characterId, k.victim && k.victim.name),
        shipLabel(k.victim && k.victim.shipName, k.victim && k.victim.shipTypeId), formatIsk(k.iskLost),
        num(k.attackerCount)])));
    }
  }

  const isId = (v) => Number.isSafeInteger(v) && v > 0;

  function charLink(id, name) {
    if (!isId(id)) return el("span", { text: name || "—" });
    return el("a", { text: name || `#${id}`, href: formatHash("character", { character: id }) });
  }

  function shipLabel(name, typeId) {
    return name || (isId(typeId) ? `#${typeId}` : "—");
  }

  function orgLabel(name, id) {
    return name || (isId(id) ? `#${id}` : "—");
  }

  function roleChip(role) {
    return el("span", { cls: `kb-role kb-role-${roleLabel(role) === "—" ? "X" : role}`, text: roleLabel(role) });
  }

  function renderKills(root, data, params) {
    const form = el("div", { cls: "kb-filters" });
    const sys = el("input", { cls: "kb-input" });
    sys.setAttribute("type", "text");
    sys.setAttribute("inputmode", "numeric");
    sys.setAttribute("placeholder", "System ID");
    if (params.system) sys.value = String(params.system);
    const go = el("button", { text: "Filter" });
    go.setAttribute("type", "button");
    go.addEventListener("click", () => {
      const s = Number(sys.value.trim());
      global.location.hash = formatHash("kills", isId(s) ? { system: s } : {});
    });
    form.appendChild(el("label", { text: "System " }, [sys]));
    form.appendChild(go);
    root.appendChild(form);
    root.appendChild(el("h2", { text: "Kills" }));
    const now = Date.now();
    const rows = (data.rows || []).map((k) => [
      el("a", { text: `#${k.killId}`, href: formatHash("kill", { kill: k.killId }) }), formatAgo(k.killAt, now),
      k.systemId === null ? "—" : systemLabel(k), charLink(k.victim.characterId, k.victim.characterName),
      shipLabel(k.victim.shipTypeName, k.victim.shipTypeId), formatIsk(k.iskLost),
      charLink(k.final.characterId, k.final.characterName), num(k.attackerCount)]);
    if (rows.length === 0) root.appendChild(el("p", { cls: "kb-empty", text: "No kills." }));
    else root.appendChild(table(["Kill", "Time", "System", "Victim", "Ship", "ISK", "Final blow", "Attackers"], rows));
    const more = moreLink("kills", params, data.nextBefore);
    if (more) root.appendChild(more);
  }

  function renderKill(root, d) {
    root.appendChild(el("h2", { text: `Kill #${d.killId}` }));
    const v = d.victim || {};
    root.appendChild(table(["", ""], [["Victim", charLink(v.characterId, v.characterName)],
      ["Corporation", orgLabel(v.corporationName, v.corporationId)], ["Alliance", orgLabel(v.allianceName, v.allianceId)],
      ["Ship", shipLabel(v.shipTypeName, v.shipTypeId)], ["ISK", formatIsk(d.iskLost)],
      ["System", d.systemId === null ? "—" : systemLabel(d)],
      ["Time", `${new Date(d.killAt).toLocaleString()} (${formatAgo(d.killAt, Date.now())})`],
      ["Attackers", `${num(d.attackerCount)} (${num(d.storedAttackers)} stored)`]]));
    const attackers = (d.attackers || []).map((a) => [charLink(a.characterId, a.characterName),
      orgLabel(a.corporationName, a.corporationId), shipLabel(a.shipTypeName, a.shipTypeId), num(a.damageDone),
      a.finalBlow ? roleChip("F") : ""]);
    root.appendChild(el("h3", { text: "Attackers" }));
    if (attackers.length > 0) root.appendChild(table(["Pilot", "Corporation", "Hull", "Damage", ""], attackers));
    else root.appendChild(el("p", { cls: "kb-empty", text: "None." }));
    root.appendChild(el("h3", { text: "LNE battles in this system at this time" }));
    const battles = (d.battles || []).map((b) => [el("a", { text: `#${b.no}`,
      href: formatHash("battle", { battle: b.no }) }), formatAgo(b.settledAt, Date.now()), b.outcome || "—"]);
    if (battles.length > 0) root.appendChild(table(["Battle", "Settled", "Outcome"], battles));
    else root.appendChild(el("p", { cls: "kb-empty", text: "None." }));
  }

  function renderCharacter(root, d, params) {
    root.appendChild(el("h2", { text: d.name || `Character #${d.characterId}` }));
    const t = d.totals;
    if (t) {
      root.appendChild(table(["", ""], [["Kills", num(t.kills)], ["Losses", num(t.losses)],
        ["ISK killed", formatIsk(t.iskKilled)], ["ISK lost", formatIsk(t.iskLost)]]));
    } else {
      root.appendChild(el("p", { cls: "kb-empty", text: "No totals for this character." }));
    }
    const now = Date.now();
    const rows = (d.kills || []).map((k) => [
      el("a", { text: `#${k.killId}`, href: formatHash("kill", { kill: k.killId }) }), formatAgo(k.killAt, now),
      roleChip(k.role), k.systemId === null ? "—" : systemLabel(k),
      charLink(k.victim.characterId, k.victim.characterName), shipLabel(k.victim.shipTypeName, k.victim.shipTypeId),
      formatIsk(k.iskLost)]);
    root.appendChild(el("h3", { text: "Recent kills and losses" }));
    if (rows.length > 0) root.appendChild(table(["Kill", "Time", "Role", "System", "Victim", "Ship", "ISK"], rows));
    else root.appendChild(el("p", { cls: "kb-empty", text: "None." }));
    const more = moreLink("character", { character: params.character }, d.nextBefore);
    if (more) root.appendChild(more);
  }

  function renderFaction(root, d, params) {
    root.appendChild(el("h2", { text: d.name || `Faction #${d.factionId}` }));
    const t = d.totals;
    if (t) {
      root.appendChild(table(["", ""], [["Battles", num(t.battles)], ["Wins", num(t.wins)],
        ["Losses", num(t.losses)], ["Draws", num(t.draws)], ["Undecided", num(t.undecided)],
        ["Ships lost", num(t.shipsLost)], ["Ships killed", num(t.shipsKilled)],
        ["ISK lost", formatIsk(t.iskLost)], ["ISK killed", formatIsk(t.iskKilled)]]));
    } else {
      root.appendChild(el("p", { cls: "kb-empty", text: "No totals for this faction." }));
    }
    const now = Date.now();
    const rows = (d.battles || []).map((b) => [
      el("a", { text: `#${b.no}`, href: formatHash("battle", { battle: b.no }) }), formatAgo(b.settledAt, now),
      systemLabel(b), resultLabel(b.result), num(b.shipsLost), formatIsk(b.iskLost), formatIsk(b.iskTotal)]);
    root.appendChild(el("h3", { text: "Recent battles" }));
    if (rows.length > 0) {
      root.appendChild(table(["No.", "Time", "System", "Result", "Destroyed", "ISK lost", "Battle ISK"], rows));
    }
    const more = moreLink("faction", { faction: params.faction }, d.nextBefore);
    if (more) root.appendChild(more);
  }

  function renderFactions(root, d) {
    root.appendChild(el("h2", { text: "Factions" }));
    const rows = (d.factions || []).map((f) => [factionChip({ id: f.factionId, name: f.name }), num(f.battles),
      num(f.wins), num(f.losses), num(f.draws), formatIsk(f.iskKilled), formatIsk(f.iskLost)]);
    if (rows.length === 0) root.appendChild(el("p", { cls: "kb-empty", text: "No data." }));
    else root.appendChild(table(["Faction", "Battles", "Wins", "Losses", "Draws", "ISK killed", "ISK lost"], rows));
  }

  async function render() {
    const seq = ++state.seq;
    const { page, params } = parseHash(global.location.hash);
    const root = $("kb-main");
    const url = buildViewUrl(page, params);
    setBanner("");
    let r;
    try {
      if (page === "battles") await loadFactions();
      r = await getJson(url);
    } catch (_err) {
      if (seq !== state.seq) return;
      clear(root);
      root.appendChild(el("p", { cls: "kb-error", text: "Server unavailable." }));
      return;
    }
    if (seq !== state.seq) return;
    clear(root);
    const killsOff = KILL_PAGES.includes(page) ? killsUnavailableText(r) : null;
    if (killsOff !== null) {
      root.appendChild(el("p", { cls: "kb-error", text: killsOff }));
      return;
    }
    if (r.status === 404 && r.body && r.body.error && r.body.error.reason === "VIEW_NOT_FOUND") {
      root.appendChild(el("p", { cls: "kb-error", text: "Killboard disabled (killboard.enabled)" }));
      return;
    }
    if (r.status !== 200 || !r.body || !r.body.data) {
      const reason = r.body && r.body.error ? r.body.error.reason : `HTTP ${r.status}`;
      root.appendChild(el("p", { cls: "kb-error", text: `Error: ${reason}` }));
      return;
    }
    const data = r.body.data;
    if (r.body.stale === true) setBanner("Cached data (the governor paused the read).");
    if (data.available !== true) {
      if (data.reason === "GOVERNOR_HOLD") {
        setBanner("No cached data (the governor paused the read). Try again later.");
      }
      root.appendChild(el("p", { cls: "kb-error",
        text: data.reason === "NOT_FOUND" ? "Not found." : `Unavailable: ${data.reason}` }));
      return;
    }
    if (page === "battles") renderBattles(root, data, params);
    else if (page === "battle") renderBattle(root, data);
    else if (page === "faction") renderFaction(root, data, params);
    else if (page === "kills") renderKills(root, data, params);
    else if (page === "kill") renderKill(root, data);
    else if (page === "character") renderCharacter(root, data, params);
    else renderFactions(root, data);
  }

  function start() {
    $("kb-refresh").addEventListener("click", () => {
      state.factions = null;
      render();
    });
    global.addEventListener("hashchange", () => render());
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}(typeof window !== "undefined" ? window : globalThis));
