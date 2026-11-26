"use strict";

(function main() {
  const DEFAULT_REFRESH_MS = 5000;
  const state = { refreshMs: DEFAULT_REFRESH_MS, cards: new Map(), prevNewestId: null, telemetryAgeMs: null,
    activeTab: null, panes: new Map(), tabButtons: new Map(), timer: null, running: false, again: false,
    lastFactionId: null };
  const Tabs = window.LneTabs || null;

  function el(tag, opts, children) {
    const node = document.createElement(tag);
    if (opts) {
      if (opts.cls) node.setAttribute("class", opts.cls);
      if (opts.text !== undefined && opts.text !== null) node.textContent = String(opts.text);
      if (opts.title) node.setAttribute("title", opts.title);
    }
    for (const child of children || []) if (child) node.appendChild(child);
    return node;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }
  function $(id) {
    return document.getElementById(id);
  }
  function stateClass(value) {
    return `s-${String(value || "unknown").toLowerCase().replace(/[^a-z]/g, "")}`;
  }
  function badge(value, label) {
    return el("span", { cls: `badge ${stateClass(value)}`, text: label || value });
  }

  function fmtNum(v, digits) {
    if (v === null || v === undefined || Number.isNaN(v)) return "-";
    if (typeof v !== "number") return String(v);
    const d = digits === undefined ? (Number.isInteger(v) ? 0 : 2) : digits;
    return v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });
  }
  function fmtBytes(v) {
    if (typeof v !== "number") return "-";
    return `${fmtNum(v / 1048576, 1)} MiB`;
  }
  function fmtAge(ms) {
    if (typeof ms !== "number" || ms < 0) return "-";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 120000) return `${fmtNum(ms / 1000, 1)} s`;
    return `${fmtNum(ms / 60000, 1)} min`;
  }
  function fmtValue(v) {
    if (v === null || v === undefined) return "-";
    if (typeof v === "number") return fmtNum(v);
    if (typeof v === "boolean") return v ? "yes" : "no";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  function kvTable(rows) {
    const body = el("tbody");
    for (const [key, value, cls] of rows) {
      const cell = value instanceof Node ? el("td", null, [value]) : el("td", { cls, text: fmtValue(value) });
      body.appendChild(el("tr", null, [el("td", { text: key }), cell]));
    }
    return el("table", { cls: "kv" }, [body]);
  }
  function table(columns, rows) {
    const head = el("tr", null, columns.map((c) => el("th", { cls: c.num ? "num" : "", text: c.label })));
    const body = el("tbody");
    for (const row of rows) {
      body.appendChild(el("tr", null, columns.map((c) => {
        const v = c.get(row);
        if (v instanceof Node) return el("td", null, [v]);
        return el("td", { cls: [c.num ? "num" : "", c.cls ? c.cls(row) : ""].join(" ").trim(), text: fmtValue(v) });
      })));
    }
    return el("table", null, [el("thead", null, [head]), body]);
  }
  function isFlat(obj) {
    return obj && typeof obj === "object" && !Array.isArray(obj)
      && Object.values(obj).every((v) => v === null || typeof v !== "object");
  }
  function generic(value, depth) {
    const d = depth || 0;
    if (value === null || typeof value !== "object") return el("span", { cls: "mono", text: fmtValue(value) });
    if (Array.isArray(value)) {
      if (value.length === 0) return el("span", { cls: "note", text: "(empty)" });
      if (value.every(isFlat)) {
        const keys = [...new Set(value.flatMap((r) => Object.keys(r)))];
        return table(keys.map((k) => ({ label: k, get: (r) => r[k] })), value);
      }
      return el("div", null, value.map((v, i) => details(`[${i}]`, v, d + 1)));
    }
    const rows = [];
    const nested = [];
    for (const [k, v] of Object.entries(value)) {
      if (v !== null && typeof v === "object") nested.push([k, v]);
      else rows.push([k, v]);
    }
    return el("div", null, [rows.length ? kvTable(rows) : null, ...nested.map(([k, v]) => details(k, v, d + 1))]);
  }
  function details(label, value, depth) {
    const box = el("details");
    box.appendChild(el("summary", { text: label }));
    box.appendChild(el("div", null, [generic(value, depth)]));
    return box;
  }
  function unavailable(data) {
    const parts = [data.reason, data.stateReason, data.detail].filter(Boolean).join(" - ");
    return el("div", { cls: "banner banner-warn", text: `Not available: ${parts || "unknown"}` });
  }
  function clockText(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function staleText(data) {
    const g = (data && data.staleGovernor) || null;
    let mode = "governor hold";
    if (g && g.mode) {
      mode = g.overlay
        ? `governor ${g.mode} (spike overlay ${g.overlay}, base ${g.baseMode || "?"})`
        : `governor ${g.mode}`;
    }
    const at = data && Number.isFinite(data.staleSinceMs) ? `data from ${clockText(data.staleSinceMs)} (last read)`
      : "data from the last read";
    return `stale: ${mode}, ${at}`;
  }

  function renderHeader(data) {
    const overall = $("overall");
    overall.textContent = data.overall;
    overall.setAttribute("class", `badge ${stateClass(data.overall)}`);
    overall.setAttribute("title", "");
    if (data.mod && data.mod.version) $("mod-version").textContent = `v${data.mod.version} · pid ${data.mod.pid}`;
  }

  function renderStatus(data) {
    const out = [];
    if (data.problems && data.problems.length) {
      out.push(el("ul", { cls: `problems${data.overall === "refused" ? " refused" : ""}` },
        data.problems.map((p) => el("li", { text: p }))));
    }
    const svc = data.services || {};
    out.push(el("h3", { text: "Services" }));
    if (svc.available === false) out.push(unavailable(svc));
    else {
      if (svc.refusal) {
        out.push(el("div", { cls: "banner banner-error", text: `Mod refused to start services: ${svc.refusal}` }));
      }
      out.push(table([
        { label: "service", get: (s) => s.name },
        { label: "state", get: (s) => badge(s.state) },
        { label: "reason", get: (s) => s.reason, cls: () => "mono" },
        { label: "detail", get: (s) => s.detail, cls: () => "mono" },
      ], svc.services || []));
    }
    const probe = data.probe;
    out.push(el("h3", { text: "Probe (DRIFT)" }));
    if (!probe) out.push(el("div", { cls: "note", text: "no probe report" }));
    else {
      const c = probe.counts || {};
      out.push(kvTable([["result", badge(probe.passed ? "ok" : "failed", probe.passed ? "passed" : "failed")],
        ["ok / drift / missing", `${fmtNum(c.ok)} / ${fmtNum(c.drift)} / ${fmtNum(c.missing)}`]]));
      const bad = (probe.modules || []).filter((m) => m.status && m.status !== "ok");
      if (bad.length) out.push(generic(bad));
    }
    const p = data.persistence || {};
    out.push(el("h3", { text: "Persistence" }));
    if (!p.available) out.push(unavailable(p));
    else {
      out.push(kvTable([
        ["store", badge(p.open ? p.state : "closed")],
        ["state reason", p.stateReason], ["locking", p.lockingMode], ["schema", p.schemaVersion],
        ["file", p.filePath, "mono"],
      ]));
    }
    const g = data.governor || {};
    out.push(el("h3", { text: "Load governor" }));
    if (g.warnings && g.warnings.length) {
      out.push(el("div", { cls: "banner banner-warn", text: `Governor: ${g.warnings.join(", ")}` }));
    }
    if (g.status) {
      out.push(kvTable([
        ["mode", badge(g.status.mode)], ["reason", g.status.reason],
        ["p95 tick interval", `${fmtNum(g.status.p95Ms)} ms`],
        ["signal", g.status.signal],
        ["tick lateness share", `${fmtNum(g.status.latenessPercent)} %`],
        ["emergency / unplayable ticks",
          `${fmtNum(g.perTick.emergencySamples)} / ${fmtNum(g.perTick.unplayableSamples)}`],
        ["tick interval max", `${fmtNum(g.tickIntervalMaxMs)} ms`], ["mode changes", g.status.changes],
      ]));
    }
    out.push(el("div", { cls: "note", text: "Mode is a point reading every telemetry interval; short episodes "
      + "show in emergency/unplayable ticks and in tick interval max." }));
    const o = data.observer || {};
    out.push(el("h3", { text: "Observer" }));
    out.push(kvTable([
      ["listening", o.listening ? `${o.listening.host}:${o.listening.port}` : "-"],
      ["requests", o.requests], ["by status", o.byStatus], ["view errors", o.viewErrors],
      ["last error", o.lastError ? `${o.lastError.id}: ${o.lastError.reason} ${o.lastError.message}` : "-"],
      ["last journal read", typeof o.journalLastMs === "number" ? `${fmtNum(o.journalLastMs, 3)} ms` : "-"],
    ]));
    const cfg = data.config || {};
    if ((cfg.warnings || []).length || (cfg.errors || []).length) {
      const notes = [...(cfg.errors || []), ...(cfg.warnings || [])];
      out.push(el("ul", { cls: "problems" }, notes.map((w) => el("li", { text: w }))));
    }
    out.push(details("Configuration values", cfg.values));
    out.push(details("Configuration sources", cfg.sources));
    if (data.mod && data.mod.gate) out.push(details("World gate", data.mod.gate));
    return out;
  }

  function histRows(snap) {
    const rows = [
      ["tick interval", snap.tick && snap.tick.intervalMs], ["tick work", snap.tick && snap.tick.workMs],
      ["tick lateness", snap.tick && snap.tick.latenessMs], ["GC pause", snap.gc && snap.gc.pauseMs],
      ["DB transaction (incl. observer reads)", snap.persistence && snap.persistence.txMs],
    ];
    return rows.filter(([, h]) => h).map(([name, h]) => ({ name, ...h }));
  }

  function checkpointRow(c) {
    if (!c) return ["WAL checkpoint", "-"];
    const ms = c.ms || {};
    const frames = c.frames || {};
    const n = c.counts || {};
    const age = typeof c.lastAtAgeMs === "number" ? `${fmtAge(c.lastAtAgeMs)} ago` : "never";
    return ["WAL checkpoint", `p95 ${fmtNum(ms.p95)} / max ${fmtNum(ms.max)} ms, frames p95 ${fmtNum(frames.p95)}, `
      + `WAL est. ${fmtNum(c.walEstimatedFrames)} frames, last ${age}, force/target/interval/busy/failed `
      + `${fmtNum(n.force)}/${fmtNum(n.target)}/${fmtNum(n.interval)}/${fmtNum(n.busy)}/${fmtNum(n.failed)}`,
    n.failed > 0 ? "warnv" : ""];
  }

  function programmerError(label, n) {
    return n > 0 ? [label, `${n} - programmer error`, "bad"] : [label, n];
  }

  function renderTelemetryHeader(data, envelope) {
    state.telemetryAgeMs = null;
    if (!data.available) {
      renderAlarms([]);
      return;
    }
    const snap = data.snapshot || {};
    if (typeof snap.capturedAtMs === "number") state.telemetryAgeMs = envelope.generatedAtMs - snap.capturedAtMs;
    renderAlarms(snap.alarms || []);
  }

  function renderTelemetry(data) {
    if (!data.available) return [unavailable(data)];
    const snap = data.snapshot || {};
    const out = [];
    const st = snap.status || {};
    out.push(kvTable([
      ["snapshot", `#${fmtNum(snap.seq)} at ${snap.capturedAt || "-"}`],
      ["tick channel", badge(st.tick, `${st.tick}${st.tickReason ? ` (${st.tickReason})` : ""}`)],
      ["GC channel", badge(st.gc)],
      ["latest.json", badge(st.snapshotWrite,
        `${st.snapshotWrite}${st.snapshotWriteReason ? ` (${st.snapshotWriteReason})` : ""}`)],
    ]));
    out.push(el("h3", { text: "Timings (ms)" }));
    out.push(table([
      { label: "metric", get: (r) => r.name },
      { label: "p50", num: true, get: (r) => r.p50 }, { label: "p95", num: true, get: (r) => r.p95 },
      { label: "max", num: true, get: (r) => r.max }, { label: "avg", num: true, get: (r) => r.avg },
      { label: "window", num: true, get: (r) => `${fmtNum(r.samples)} samples / ${fmtAge(r.spanMs)}` },
    ], histRows(snap)));
    out.push(el("div", { cls: "note",
      text: "Percentiles cover the window shown (newest samples), not the time since start." }));
    const proc = snap.process || {};
    out.push(el("h3", { text: "Process" }));
    out.push(kvTable([["RSS", fmtBytes(proc.rssBytes)], ["heap used", fmtBytes(proc.heapUsedBytes)],
      ["CPU", proc.cpu],
      ["ticked scenes", snap.tick ? `${fmtNum(snap.tick.tickedSceneCount)} / ${fmtNum(snap.tick.sceneCount)}` : "-"]]));
    const j = snap.journal || {};
    const tx = (snap.persistence && snap.persistence.tx) || {};
    out.push(el("h3", { text: "Persistence and journal" }));
    out.push(kvTable([
      ["duplicate detections (also in rolled back tx)", j.duplicates],
      programmerError("idempotency conflicts", j.conflicts),
      ["tx ok", tx.ok],
      programmerError("tx TX_NESTED", tx.TX_NESTED),
      ["tx TX_FAILED", tx.TX_FAILED, tx.TX_FAILED > 0 ? "warnv" : ""],
      ["tx TX_CONSTRAINT / TX_ROW_LIMIT", `${fmtNum(tx.TX_CONSTRAINT)} / ${fmtNum(tx.TX_ROW_LIMIT)}`],
      checkpointRow(snap.persistence && snap.persistence.checkpoint),
      ["slow operations (> telemetry.slowOpMs)", snap.persistence ? snap.persistence.slowOps : "-"],
    ]));
    out.push(details("Channels", snap.channels));
    out.push(details("Capture", snap.capture));
    return out;
  }

  function renderModuleCost(data) {
    if (!data.available) return [unavailable(data)];
    const mc = data.moduleCost || {};
    const out = [];
    const other = mc.other || {};
    out.push(kvTable([
      ["snapshot", `#${fmtNum(data.seq)}, window ${fmtAge(mc.windowMs)}`],
      ["heap after last major GC", fmtBytes(data.heapAfterMajorBytes)],
      ["budget alarms", (data.alarms || []).map((a) => `${a.id} (${a.count})`).join(", ") || "none"],
      ["other (labels over maxLabels)", `${fmtNum(other.msPerMin)} ms/min, ${fmtNum(other.labels)} labels`],
    ]));
    out.push(el("h3", { text: "Modules (pollers + scheduler, ms/min)" }));
    out.push(table([
      { label: "module", get: (r) => r.module, cls: () => "mono" },
      { label: "ms/min", num: true, get: (r) => r.msPerMin },
    ], mc.modules || []));
    out.push(el("h3", { text: "Labels (top by ms/min)" }));
    out.push(table([
      { label: "label", get: (r) => r.label, cls: () => "mono" },
      { label: "module", get: (r) => r.module, cls: () => "mono" },
      { label: "ms/min", num: true, get: (r) => r.msPerMin, cls: (r) => (r.overBudget ? "warnv" : "") },
      { label: "calls", num: true, get: (r) => r.calls },
      { label: "max ms", num: true, get: (r) => r.maxMs },
    ], mc.labels || []));
    out.push(el("h3", { text: "Memory probes" }));
    out.push(table([
      { label: "name", get: (r) => r.name, cls: () => "mono" },
      { label: "entries", num: true, get: (r) => (r.error ? "error" : r.entries) },
      { label: "approx", num: true, get: (r) => (typeof r.approxBytes === "number" ? fmtBytes(r.approxBytes) : "-") },
    ], mc.memory || []));
    return out;
  }

  function renderJournal(data) {
    if (!data.available) return [unavailable(data)];
    const out = [];
    const prev = state.prevNewestId;
    if (prev !== null && data.count === data.limit && data.oldestId > prev + 1) {
      out.push(el("div", { cls: "banner banner-warn",
        text: `Skipped about ${data.oldestId - prev - 1} entries since the previous refresh `
          + `(only the newest ${data.limit} are shown).` }));
    }
    if (data.newestId !== null) state.prevNewestId = data.newestId;
    const noun = data.count === 1 ? "entry" : "entries";
    out.push(el("div", { cls: "note",
      text: `${data.count} ${noun} (newest ${data.limit}), read in ${fmtNum(data.txMs, 3)} ms` }));
    if (data.count === 0) return out;
    out.push(table([
      { label: "id", num: true, get: (e) => e.journalId },
      { label: "kind", get: (e) => e.kind },
      { label: "event", get: (e) => e.eventType },
      { label: "aggregate", get: (e) => `${e.aggregateType}:${e.aggregateId}`, cls: () => "mono" },
      { label: "state", get: (e) => badge(e.state) },
      { label: "created", get: (e) => e.createdAt },
      { label: "payload", get: (e) => `${e.payloadPreview}${e.payloadTruncated ? " …" : ""}`, cls: () => "mono" },
      { label: "error", get: (e) => e.error, cls: () => "mono" },
    ], data.entries));
    return out;
  }

  function renderActivity(data) {
    if (data.available === false) return [unavailable(data)];
    const CLS = { WORKING: "ok", WAITING: "off", BLOCKED: "warn", STALE: "warn", ERROR: "error", NO_OFFENSIVE: "warn" };
    return [table([
      { label: "Faction", get: (r) => r.frakcja },
      { label: "Verdict", get: (r) => badge(CLS[r.kod] || "unknown", r.werdykt) },
      { label: "Reason", get: (r) => r.uzasadnienie },
      { label: "Now", get: (r) => r.teraz },
      { label: "Plans", get: (r) => r.plany },
    ], data.summary || []), details("Faction details", data.factions || [], 1)];
  }

  const NEWS_SOURCE_LABEL = { AI: "AI", FALLBACK: "fallback text" };
  function fmtUtc(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "-";
    const iso = new Date(ms).toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  }
  function renderNews(data) {
    if (data.available === false) return [unavailable(data)];
    const editions = (Array.isArray(data.editions) ? data.editions : []).filter((e) => e && typeof e === "object")
      .slice().sort((a, b) => (Number(b.boundaryAt) || 0) - (Number(a.boundaryAt) || 0)
        || (Number(b.seq) || 0) - (Number(a.seq) || 0));
    const list = el("div", { cls: "news-list" });
    for (const e of editions) {
      const head = `Scope News #${e.seq === null || e.seq === undefined ? "?" : e.seq} · ${fmtUtc(e.boundaryAt)}`;
      if (e.state === "SKIPPED") {
        list.appendChild(el("div", { cls: "news-skipped", text: `${head} · edition skipped` }));
        continue;
      }
      const meta = [`facts ${fmtNum(e.factCount)}`];
      if (e.state === "PUBLISHED") meta.push(`recipients ${fmtNum(e.recipients)}`);
      else meta.push(`state ${e.state || "-"}`);
      const label = NEWS_SOURCE_LABEL[e.source];
      const headRow = el("div", { cls: "news-head" }, [el("span", { cls: "news-seq", text: head }),
        label ? el("span", { cls: `news-source news-source-${e.source === "AI" ? "ai" : "fallback"}`, text: label })
          : null]);
      const paragraphs = (Array.isArray(e.paragraphs) ? e.paragraphs : []).filter((p) => typeof p === "string" && p !== "")
        .map((p) => el("p", { cls: "news-para", text: p }));
      const title = typeof e.title === "string" && e.title !== "" ? el("h3", { cls: "news-title", text: e.title }) : null;
      list.appendChild(el("article", { cls: "news-edition" }, [headRow, title, ...paragraphs,
        el("div", { cls: "news-meta", text: meta.join(" · ") })]));
    }
    if (editions.length === 0) list.appendChild(el("div", { cls: "note", text: "No editions." }));
    const next = el("div", { cls: "news-next", text: `next edition: ${fmtUtc(data.nextBoundaryAt)}` });
    return [list, next];
  }

  const CONTROL_ROWS_MAX = 300;

  function createControlPanel() {
    const ui = { data: null, text: "", faction: "", region: null, regionNames: new Map(), factionNames: new Map() };
    const status = el("div", { cls: "note" });
    const errorSlot = el("div", { cls: "card-error hidden" });
    const input = el("input", { cls: "ctl-filter" });
    input.setAttribute("type", "search");
    input.setAttribute("placeholder", "Filter: region, system or faction");
    const select = el("select", { cls: "ctl-select" });
    const counter = el("span", { cls: "note" });
    const regionsBox = el("div");
    const systemsBox = el("div");
    const root = el("div", null, [errorSlot, status, el("div", { cls: "ctl-bar" }, [input, select, counter]),
      regionsBox, systemsBox]);

    function factionName(id) {
      if (id === null || id === undefined) return "-";
      return ui.factionNames.get(id) || `faction ${id}`;
    }
    function regionName(id) {
      return ui.regionNames.get(id) || `region ${id}`;
    }
    function systemMatches(row, text) {
      if (ui.faction !== "" && String(row[4]) !== ui.faction) return false;
      if (text === "") return true;
      return [String(row[1] || row[0]), regionName(row[2]), factionName(row[4])]
        .some((v) => v.toLowerCase().includes(text));
    }
    function moreNote(shown, total) {
      return total > shown ? el("div", { cls: "note", text: `… ${total - shown} more` }) : null;
    }

    function drawSystems(systems) {
      if (ui.region === null) return;
      const inRegion = systems.filter((row) => row[2] === ui.region);
      systemsBox.appendChild(el("h3", { text: `Systems of ${regionName(ui.region)}` }));
      const shown = inRegion.slice(0, CONTROL_ROWS_MAX);
      systemsBox.appendChild(table([
        { label: "system", get: (row) => row[1] || row[0] },
        { label: "sec", num: true, get: (row) => row[3] },
        { label: "controller", get: (row) => factionName(row[4]) },
        { label: "influence", num: true, get: (row) => row[5] },
        { label: "influence rows", get: (row) => `${row[6].length}: `
          + row[6].map(([id, v]) => `${factionName(id)} ${fmtNum(v)}`).join(", ") },
      ], shown));
      const more = moreNote(shown.length, inRegion.length);
      if (more) systemsBox.appendChild(more);
    }

    function draw() {
      const d = ui.data;
      if (!d) return;
      clear(regionsBox);
      clear(systemsBox);
      if (!d.available) {
        counter.textContent = "";
        regionsBox.appendChild(unavailable(d));
        return;
      }
      const text = ui.text.trim().toLowerCase();
      const systems = d.systems.filter((row) => systemMatches(row, text));
      counter.textContent = `${fmtNum(systems.length)} / ${fmtNum(d.totals.systems)} systems`;
      const inFilter = new Set(systems.map((row) => row[2]));
      const regions = d.regions.filter((r) => inFilter.has(r[0]));
      const shownRegions = regions.slice(0, CONTROL_ROWS_MAX);
      const head = el("tr", null, [["region", ""], ["systems", "num"], ["controlled", "num"],
        ["main faction", ""], ["its systems", "num"]].map(([t, cls]) => el("th", { cls, text: t })));
      const body = el("tbody");
      for (const r of shownRegions) {
        const tr = el("tr", { cls: `ctl-row${ui.region === r[0] ? " ctl-selected" : ""}` }, [
          el("td", { text: regionName(r[0]) }),
          el("td", { cls: "num", text: fmtNum(r[2]) }),
          el("td", { cls: "num", text: fmtNum(r[3]) }),
          el("td", { text: factionName(r[4]) }),
          el("td", { cls: "num", text: fmtNum(r[5]) }),
        ]);
        tr.addEventListener("click", () => {
          ui.region = ui.region === r[0] ? null : r[0];
          draw();
        });
        body.appendChild(tr);
      }
      regionsBox.appendChild(el("table", null, [el("thead", null, [head]), body]));
      const more = moreNote(shownRegions.length, regions.length);
      if (more) regionsBox.appendChild(more);
      drawSystems(systems);
    }

    function fillSelect(factions) {
      const wanted = ["", ...factions.map((f) => String(f[0]))];
      if (wanted.join(",") === [...select.options].map((o) => o.value).join(",")) return;
      clear(select);
      const all = el("option", { text: "All factions" });
      all.setAttribute("value", "");
      select.appendChild(all);
      for (const f of factions) {
        const option = el("option", { text: `${factionName(f[0])} (${fmtNum(f[2])})` });
        option.setAttribute("value", String(f[0]));
        select.appendChild(option);
      }
      select.value = wanted.includes(ui.faction) ? ui.faction : "";
      ui.faction = select.value;
    }

    input.addEventListener("input", () => {
      ui.text = input.value;
      draw();
    });
    select.addEventListener("change", () => {
      ui.faction = select.value;
      draw();
    });

    function update(data) {
      errorSlot.classList.add("hidden");
      ui.data = data;
      const seed = data.seed || {};
      const build = seed.sdeBuild === null || seed.sdeBuild === undefined ? "-" : seed.sdeBuild;
      status.textContent = `seed ${seed.state || "-"}${seed.reason ? ` (${seed.reason})` : ""} · scope `
        + `${seed.scope || "-"} · created ${fmtNum(seed.created)} duplicates ${fmtNum(seed.duplicates)} `
        + `existing ${fmtNum(seed.existing)} conflicts ${fmtNum(seed.conflicts)} · sdeBuild ${build}`
        + `${data.graphReady === false ? " · graph not ready (no names)" : ""}`;
      if (data.available) {
        ui.regionNames = new Map(data.regions.filter((r) => r[1]).map((r) => [r[0], r[1]]));
        ui.factionNames = new Map((data.factionNames || []).filter((f) => f[1]).map((f) => [f[0], f[1]]));
        fillSelect(data.factions);
      }
      draw();
    }

    function error(text) {
      errorSlot.textContent = text;
      errorSlot.classList.remove("hidden");
    }

    return { root, update, error };
  }

  const RENDERERS = { status: renderStatus, telemetry: renderTelemetry, journal: renderJournal,
    activity: renderActivity, news: renderNews, "module-cost": renderModuleCost };
  const STATEFUL = { control: createControlPanel };
  const WIDE = ["journal", "control", "galaxy", "activity", "faction-overview", "news", "module-cost"];
  if (window.LneGalaxy) STATEFUL.galaxy = () => window.LneGalaxy.createPanel({ el, clear, fmtNum, getJson });
  if (window.LneFactions) {
    STATEFUL["faction-overview"] = () => window.LneFactions.createPanel({ el, clear, badge, fmtNum, table, kvTable,
      getHash: readHash, setHash: writeHash });
  }

  function renderAlarms(alarms) {
    const box = $("alarms");
    clear(box);
    for (const a of alarms) {
      const red = a.level === "error" || a.level === "critical";
      box.appendChild(el("div", { cls: `banner ${red ? "banner-error" : "banner-warn"}`,
        text: `${a.level.toUpperCase()} ${a.id} (${a.count}): ${a.message}` }));
    }
  }

  function readHash() {
    return Tabs ? Tabs._pure.parseHash(window.location.hash) : { tab: null, factionId: null };
  }
  function writeHash(value) {
    if (!Tabs) return;
    const next = Tabs._pure.formatHash(value);
    if (window.location.hash !== next) window.location.hash = next;
  }
  let mapFocusId = null;
  function focusMap(systemId) {
    if (Number.isSafeInteger(systemId) && systemId > 0) mapFocusId = systemId;
    const c = state.cards.get("galaxy");
    if (mapFocusId === null || !c || !c.panel || typeof c.panel.focusSystem !== "function") return;
    const id = mapFocusId;
    mapFocusId = null;
    try {
      c.panel.focusSystem(id);
    } catch (err) {
      c.panel.error(`render failed: ${err && err.message}`);
    }
  }
  function tabOfView(viewId) {
    return Tabs ? Tabs._pure.tabOf(viewId) : null;
  }
  function isShown(viewId) {
    return !Tabs || tabOfView(viewId) === state.activeTab;
  }

  function setupPanes() {
    const main = $("panels");
    if (!Tabs) {
      const pane = el("div", { cls: "grid" });
      main.appendChild(pane);
      state.panes.set(null, pane);
      return;
    }
    const nav = $("tabs");
    for (const t of Tabs.TABS) {
      const button = el("button", { cls: "tab", text: t.label });
      button.setAttribute("type", "button");
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", "false");
      button.addEventListener("click", () => selectTab(t.id));
      if (t.id === Tabs.OTHER_TAB) button.hidden = true;
      nav.appendChild(button);
      state.tabButtons.set(t.id, button);
      const pane = el("div", { cls: "grid tab-pane" });
      pane.setAttribute("role", "tabpanel");
      pane.hidden = true;
      main.appendChild(pane);
      state.panes.set(t.id, pane);
    }
    nav.classList.remove("hidden");
  }

  function showTab(tabId) {
    state.activeTab = tabId;
    for (const [id, button] of state.tabButtons) button.setAttribute("aria-selected", id === tabId ? "true" : "false");
    for (const [id, pane] of state.panes) pane.hidden = id !== tabId;
  }

  function selectTab(tabId, fromHash) {
    if (!Tabs) return;
    const button = state.tabButtons.get(tabId);
    const tab = button && !button.hidden ? tabId : Tabs.DEFAULT_TAB;
    showTab(tab);
    if (!fromHash) {
      writeHash(Tabs._pure.hashForTab(tab, readHash(), state.lastFactionId));
    }
    clearTimeout(state.timer);
    state.timer = null;
    refresh();
  }

  function onHashChange() {
    const parsed = readHash();
    state.lastFactionId = Tabs._pure.rememberFaction(state.lastFactionId, parsed);
    if (parsed.tab !== state.activeTab) selectTab(parsed.tab, true);
    if (parsed.systemId !== null && parsed.systemId !== undefined) focusMap(parsed.systemId);
    const c = state.cards.get("faction-overview");
    if (c && c.panel && typeof c.panel.select === "function" && parsed.tab === Tabs.DEFAULT_TAB) {
      try {
        c.panel.select(parsed.factionId);
      } catch (err) {
        c.panel.error(`render failed: ${err && err.message}`);
      }
    }
  }

  function syncOtherTab(listed) {
    const button = state.tabButtons.get(Tabs.OTHER_TAB);
    if (!button) return;
    button.hidden = Tabs._pure.viewsForTab(Tabs.OTHER_TAB, listed).length === 0;
    if (button.hidden && state.activeTab === Tabs.OTHER_TAB) {
      showTab(Tabs.DEFAULT_TAB);
      writeHash(Tabs._pure.hashForTab(Tabs.DEFAULT_TAB, readHash(), state.lastFactionId));
    }
  }

  function card(view) {
    let c = state.cards.get(view.id);
    if (c) return c;
    const meta = el("span", { cls: "card-meta" });
    const body = el("div", { cls: "card-body", text: "loading…" });
    const root = el("section", { cls: `card${WIDE.includes(view.id) ? " wide" : ""}` },
      [el("div", { cls: "card-head" }, [el("h2", { text: view.title }), meta]), body]);
    state.panes.get(tabOfView(view.id)).appendChild(root);
    c = { root, meta, body };
    state.cards.set(view.id, c);
    return c;
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

  function renderHeaders(view, r) {
    const ok = r.body && r.body.ok === true;
    try {
      if (view.id === "status" && ok) renderHeader(r.body.data || {});
      if (view.id === "telemetry") {
        if (ok) renderTelemetryHeader(r.body.data || {}, r.body);
        else state.telemetryAgeMs = null;
      }
    } catch (err) {
      const overall = $("overall");
      if (overall) overall.setAttribute("title", `header (${view.id}) render failed: ${err && err.message}`);
    }
  }

  async function refreshView(view) {
    const r = await getJson(`/api/views/${encodeURIComponent(view.id)}`);
    renderHeaders(view, r);
    if (!isShown(view.id)) return;
    const c = card(view);
    if (STATEFUL[view.id]) {
      refreshStateful(view, c, r);
      return;
    }
    const opened = openDetailPaths(c.body);
    const scroll = c.body.scrollTop;
    clear(c.body);
    if (!r.body || r.body.ok !== true) {
      const err = (r.body && r.body.error) || {};
      c.meta.textContent = `HTTP ${r.status}`;
      const text = `${err.reason || "error"}${err.message ? `: ${err.message}` : ""}`;
      c.body.appendChild(el("div", { cls: "card-error", text }));
      return;
    }
    c.meta.textContent = r.body.stale ? "stale" : (r.body.cached ? "cached" : "");
    if (r.body.stale) c.body.appendChild(el("div", { cls: "banner banner-warn", text: staleText(r.body.data) }));
    const render = RENDERERS[view.id] || ((data) => [generic(data)]);
    try {
      for (const node of render(r.body.data || {}, r.body)) if (node) c.body.appendChild(node);
    } catch (err) {
      c.body.appendChild(el("div", { cls: "card-error", text: `render failed: ${err && err.message}` }));
    }
    restoreDetailPaths(c.body, opened);
    c.body.scrollTop = scroll;
  }

  function detailPath(box, root) {
    const parts = [];
    for (let n = box; n && n !== root; n = n.parentElement) {
      if (n.tagName === "DETAILS") {
        const s = n.querySelector(":scope > summary");
        parts.unshift(s ? s.textContent : "");
      }
    }
    return parts.join("\u0001");
  }
  function openDetailPaths(root) {
    const out = new Set();
    for (const box of root.querySelectorAll("details[open]")) out.add(detailPath(box, root));
    return out;
  }
  function restoreDetailPaths(root, paths) {
    if (!paths.size) return;
    for (const box of root.querySelectorAll("details")) if (paths.has(detailPath(box, root))) box.open = true;
  }

  function refreshStatefulFailed(c, r) {
    clear(c.body);
    c.meta.textContent = r.body && r.body.ok === true ? "" : `HTTP ${r.status}`;
    c.body.appendChild(el("div", { cls: "card-error", text: `panel failed: ${c.panelFailed}` }));
    if (r.body && r.body.ok === true) c.body.appendChild(generic(r.body.data || {}));
  }

  function refreshStateful(view, c, r) {
    if (c.panelFailed !== undefined) {
      refreshStatefulFailed(c, r);
      return;
    }
    if (!c.panel) {
      clear(c.body);
      try {
        c.panel = STATEFUL[view.id]();
        c.body.appendChild(c.panel.root);
        if (view.id === "galaxy") focusMap(null);
      } catch (err) {
        c.panel = null;
        c.panelFailed = String((err && err.message) || err);
        refreshStatefulFailed(c, r);
        return;
      }
    }
    if (!r.body || r.body.ok !== true) {
      const err = (r.body && r.body.error) || {};
      c.meta.textContent = `HTTP ${r.status}`;
      c.panel.error(`${err.reason || "error"}${err.message ? `: ${err.message}` : ""}`);
      return;
    }
    c.meta.textContent = r.body.stale ? staleText(r.body.data) : (r.body.cached ? "cached" : "");
    try {
      c.panel.update(r.body.data || {});
    } catch (err) {
      c.panel.error(`render failed: ${err && err.message}`);
    }
  }

  async function refresh() {
    if (state.running) {
      state.again = true;
      return;
    }
    state.running = true;
    clearTimeout(state.timer);
    state.timer = null;
    try {
      if (!document.hidden) {
        const list = await getJson("/api/views");
        if (!list.body || list.body.ok !== true) throw new Error(`views HTTP ${list.status}`);
        if (Number.isFinite(list.body.refreshMs) && list.body.refreshMs > 0) state.refreshMs = list.body.refreshMs;
        const listed = Array.isArray(list.body.views) ? list.body.views : [];
        if (Tabs) syncOtherTab(listed);
        const views = Tabs ? Tabs._pure.viewsToFetch(state.activeTab, listed) : listed;
        for (const view of views) {
          if (state.again) break;
          await refreshView(view);
        }
        $("offline").classList.add("hidden");
        $("refreshed").textContent = new Date().toLocaleTimeString();
        $("telemetry-age").textContent = fmtAge(state.telemetryAgeMs);
      }
    } catch (_err) {
      $("offline").classList.remove("hidden");
    } finally {
      state.running = false;
      if (state.again) {
        state.again = false;
        refresh();
      } else state.timer = setTimeout(refresh, state.refreshMs);
    }
  }

  setupPanes();
  if (Tabs) {
    const start = readHash();
    state.lastFactionId = Tabs._pure.rememberFaction(null, start);
    showTab(start.tab);
    focusMap(start.systemId);
    const normal = Tabs._pure.formatHash(start);
    if (window.location.hash !== normal && window.history && typeof window.history.replaceState === "function") {
      window.history.replaceState(null, "", normal);
    }
    window.addEventListener("hashchange", onHashChange);
  }
  refresh();
}());
