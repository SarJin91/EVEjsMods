"use strict";

(function settingsModule(global) {
  const API = "/api/settings/";
  const CSRF_KEY = "lne-settings-csrf";
  const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
  const COLORS = Object.freeze({ ok: "var(--ok)", warn: "var(--warn)", error: "var(--error)" });

  function tokenOf(hash) {
    const text = String(hash || "").replace(/^#/, "");
    for (const part of text.split("&")) {
      const eq = part.indexOf("=");
      if (eq !== -1 && part.slice(0, eq) === "t" && TOKEN_RE.test(part.slice(eq + 1))) return part.slice(eq + 1);
    }
    return null;
  }

  function controlKind(row) {
    if (row.type === "boolean") return "checkbox";
    if (row.type === "enum" && Array.isArray(row.values)) return "select";
    if (row.type === "integer" || row.type === "number") return "number";
    return "text";
  }

  function valueOf(row, raw) {
    const kind = controlKind(row);
    if (kind === "checkbox") return { ok: true, value: raw === true };
    if (kind === "number") {
      const text = String(raw).trim();
      if (text === "" || !Number.isFinite(Number(text))) return { ok: false, reason: "not a number" };
      const n = Number(text);
      if (row.type === "integer" && !Number.isInteger(n)) return { ok: false, reason: "not an integer" };
      return { ok: true, value: n };
    }
    return { ok: true, value: String(raw) };
  }

  function valuesLine(row) {
    const show = (v) => (v === null || v === undefined ? "-" : JSON.stringify(v));
    return `running ${show(row.running)} | next ${show(row.next)} (${row.source || "-"}) | under the override `
      + `${show(row.underlying)} (${row.underlyingSource || "-"})`;
  }

  function resultText(r) {
    if (!r || r.ok !== true) {
      return `refused: ${(r && r.reason) || "no answer"}${r && r.detail ? ` - ${r.detail}` : ""}`;
    }
    const lines = [r.changed ? `saved, revision ${r.revision}` : `no change, revision ${r.revision}`];
    if (r.pending) lines.push("waits for restart");
    else if (r.apply === "live" && r.changed) lines.push("applied live");
    if (r.auditFailed) lines.push("the audit file could not be written");
    for (const w of r.warnings || []) lines.push(`warning: ${w}`);
    return lines.join("\n");
  }

  const pure = { tokenOf, controlKind, valueOf, valuesLine, resultText };
  global.LneSettings = { _pure: pure };

  const doc = global.document;
  if (!doc || typeof global.fetch !== "function") return;

  const state = { modId: null, group: "", q: "", offset: 0, limit: 0, total: 0, revision: 0 };
  const el = (id) => doc.getElementById(id);

  function make(tag, cls, text) {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function show(text, kind) {
    const box = el("msg");
    box.textContent = text;
    box.style.color = COLORS[kind] || "";
    box.classList.toggle("hidden", !text);
  }

  function csrf() {
    try {
      return global.sessionStorage.getItem(CSRF_KEY) || "";
    } catch (_err) {
      return "";
    }
  }

  async function call(method, path, body) {
    const headers = { Accept: "application/json" };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["X-LNE-CSRF"] = csrf();
    }
    const res = await global.fetch(API + path, { method, headers, credentials: "same-origin", cache: "no-store",
      body: method === "POST" ? JSON.stringify(body || {}) : undefined });
    let json = null;
    try {
      json = await res.json();
    } catch (_err) {
      json = { ok: false, reason: `HTTP ${res.status}` };
    }
    return { status: res.status, json };
  }

  function noSession() {
    clear(el("mods"));
    clear(el("rows"));
    el("tools").classList.add("hidden");
    el("logout").classList.add("hidden");
    el("who").textContent = "-";
    show("No panel session. Type !settings in Local in game and open the link (one use).", "warn");
  }

  async function loadMods() {
    const r = await call("GET", "mods");
    if (r.status === 401) return noSession();
    if (!r.json || r.json.ok !== true) return show(`mods: ${(r.json && r.json.reason) || r.status}`, "error");
    const who = r.json.character || {};
    el("who").textContent = `${who.characterName || "?"} (${who.characterId || "?"})`;
    el("logout").classList.remove("hidden");
    const nav = el("mods");
    clear(nav);
    for (const m of r.json.mods) {
      const b = make("button", m.modId === state.modId ? "active" : "", m.title || m.modId);
      b.type = "button";
      b.disabled = m.provider !== true;
      b.title = m.provider === true ? m.modId : `${m.modId}: ${m.reason || "no provider"}`;
      b.addEventListener("click", () => {
        Object.assign(state, { modId: m.modId, group: "", q: "", offset: 0 });
        el("q").value = "";
        loadMods().then(loadRows);
      });
      nav.appendChild(b);
    }
    return undefined;
  }

  function fillGroups(groups) {
    const sel = el("group");
    clear(sel);
    const all = make("option", "", "all");
    all.value = "";
    sel.appendChild(all);
    for (const g of groups || []) {
      const o = make("option", "", `${g.group} (${g.count})`);
      o.value = g.group;
      sel.appendChild(o);
    }
    sel.value = state.group;
  }

  function controlFor(row) {
    const kind = controlKind(row);
    let input;
    if (kind === "checkbox") {
      input = make("input");
      input.type = "checkbox";
      input.checked = row.next === true;
    } else if (kind === "select") {
      input = make("select");
      for (const v of row.values) {
        const o = make("option", "", v);
        o.value = v;
        input.appendChild(o);
      }
      input.value = typeof row.next === "string" ? row.next : "";
    } else {
      input = make("input");
      input.type = kind === "number" ? "number" : "text";
      if (kind === "number") {
        if (typeof row.min === "number") input.min = String(row.min);
        if (typeof row.max === "number") input.max = String(row.max);
        input.step = typeof row.step === "number" ? String(row.step) : (row.type === "integer" ? "1" : "any");
      }
      input.value = row.next === null || row.next === undefined ? "" : String(row.next);
    }
    input.disabled = row.locked === true;
    return input;
  }

  async function write(action, row, input, out) {
    let body = { key: row.key, expectedRevision: state.revision };
    if (action === "set") {
      const v = valueOf(row, controlKind(row) === "checkbox" ? input.checked : input.value);
      if (!v.ok) {
        out.textContent = `not sent: ${v.reason}`;
        out.style.color = COLORS.error;
        return;
      }
      body = { ...body, value: v.value };
    }
    const r = await call("POST", `mods/${encodeURIComponent(state.modId)}/${action}`, body);
    if (r.status === 401) return noSession();
    out.textContent = resultText(r.json);
    out.style.color = r.json && r.json.ok === true ? COLORS.ok : COLORS.error;
    if (r.json && Number.isSafeInteger(r.json.revision)) state.revision = r.json.revision;
    if (r.json && r.json.ok === true && r.json.changed) await loadRows(row.key, out.textContent, out.style.color);
    return undefined;
  }

  function rowNode(row, kept) {
    const node = make("div", "row");
    const left = make("div");
    left.appendChild(make("div", "key", row.key));
    if (row.label) left.appendChild(make("div", "", row.label));
    if (row.description) left.appendChild(make("div", "desc", row.description));
    const tags = make("div");
    tags.appendChild(make("span", "tag", row.type));
    if (row.hasOverride) tags.appendChild(make("span", "tag override", "override"));
    if (row.apply === "live") tags.appendChild(make("span", "tag live", "live"));
    if (row.pending) tags.appendChild(make("span", "tag pending", "waits for restart"));
    if (row.locked) tags.appendChild(make("span", "tag locked", `locked: ${row.lockReason || "?"}`));
    left.appendChild(tags);
    const mid = make("div", "vals", valuesLine(row));
    if (row.env) mid.appendChild(make("div", "", `env ${row.env}`));
    const edit = make("div", "edit");
    const input = controlFor(row);
    const out = make("div", "result");
    const save = make("button", "", "Save");
    save.type = "button";
    save.disabled = row.locked === true;
    save.addEventListener("click", () => write("set", row, input, out));
    const reset = make("button", "", "Reset");
    reset.type = "button";
    reset.disabled = row.hasOverride !== true;
    reset.title = "remove the in-game override of this key";
    reset.addEventListener("click", () => write("reset", row, input, out));
    edit.appendChild(input);
    edit.appendChild(save);
    edit.appendChild(reset);
    edit.appendChild(out);
    if (kept && kept.key === row.key) {
      out.textContent = kept.text;
      out.style.color = kept.color;
    }
    node.appendChild(left);
    node.appendChild(mid);
    node.appendChild(edit);
    return node;
  }

  async function loadRows(keptKey, keptText, keptColor) {
    if (!state.modId) return undefined;
    const params = new URLSearchParams({ group: state.group, q: state.q, offset: String(state.offset) });
    const r = await call("GET", `mods/${encodeURIComponent(state.modId)}?${params.toString()}`);
    if (r.status === 401) return noSession();
    const rows = el("rows");
    clear(rows);
    if (!r.json || r.json.ok !== true) return show(`${state.modId}: ${(r.json && r.json.reason) || r.status}`, "error");
    const d = r.json;
    Object.assign(state, { limit: d.limit, total: d.total, revision: d.overrideFile ? d.overrideFile.revision : 0 });
    el("tools").classList.remove("hidden");
    fillGroups(d.groups);
    const last = Math.min(d.offset + d.rows.length, d.total);
    el("page").textContent = d.total === 0 ? "no rows" : `${d.offset + 1}-${last} of ${d.total}`;
    el("prev").disabled = d.offset === 0;
    el("next").disabled = last >= d.total;
    const f = d.overrideFile || {};
    el("file").textContent = `override file: ${f.present ? `revision ${f.revision}` : "none"}`
      + `${f.ignored ? " (ignored: EVEJS_MOD_SETTINGS_OVERRIDES_IGNORE=1)" : ""}`;
    const notes = [...(f.warnings || []), ...(d.warnings || []), ...(d.errors || [])];
    show(notes.join("\n"), notes.length > 0 ? "warn" : "");
    const kept = keptKey ? { key: keptKey, text: keptText, color: keptColor } : null;
    for (const row of d.rows) rows.appendChild(rowNode(row, kept));
    return undefined;
  }

  async function start() {
    const token = tokenOf(global.location.hash);
    if (global.location.hash) {
      global.history.replaceState(null, "", global.location.pathname + global.location.search);
    }
    if (token) {
      const r = await call("POST", "session", { token });
      if (!r.json || r.json.ok !== true) {
        show(`The link is used or expired (${(r.json && r.json.reason) || r.status}). Type !settings again.`, "error");
        return;
      }
      try {
        global.sessionStorage.setItem(CSRF_KEY, r.json.csrf);
      } catch (_err) {
        show("sessionStorage is not available: saving will be refused.", "warn");
      }
    }
    await loadMods();
  }

  function wire() {
    el("group").addEventListener("change", () => {
      Object.assign(state, { group: el("group").value, offset: 0 });
      loadRows();
    });
    el("q").addEventListener("change", () => {
      Object.assign(state, { q: el("q").value.trim(), offset: 0 });
      loadRows();
    });
    el("prev").addEventListener("click", () => {
      state.offset = Math.max(0, state.offset - state.limit);
      loadRows();
    });
    el("next").addEventListener("click", () => {
      state.offset += state.limit;
      loadRows();
    });
    el("logout").addEventListener("click", async () => {
      await call("POST", "logout", {});
      try {
        global.sessionStorage.removeItem(CSRF_KEY);
      } catch (_err) {
      }
      noSession();
    });
  }

  wire();
  start().catch((err) => show(`panel error: ${String((err && err.message) || err)}`, "error"));
})(typeof window !== "undefined" ? window : globalThis);
