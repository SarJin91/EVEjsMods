"use strict";

(function systemInteriorModule(global) {
  const AU_METRES = 149597870700;
  const MILLI = 1000;
  const MIN_DMAX_AU = 1;
  const MOON_RING_FRACTION = 0.03;
  const MOON_RING_MIN_PX = 6;
  const MOON_RING_MAX_PX = 20;
  const MOON_STEP_PX = 2;
  const FAN_PX = 10;
  const ENROUTE_FACTOR = 1.04;
  const COLLIDE_PX = 6;
  const LABEL_MOON_R_PX = 300;
  const DISC_BACKGROUND = "rgba(11, 15, 20, 0.92)";
  const DISC_EDGE = "rgba(120, 140, 170, 0.45)";
  const ORBIT_LINE = "rgba(160, 175, 195, 0.22)";
  const SUN_COLOR = "#ffd75e";
  const PLANET_COLOR = "#9aa4b1";
  const MOON_COLOR = "#6d7480";
  const BELT_COLOR = "#b08d5a";
  const GATE_COLOR = "#7fc4ff";
  const NPC_STATION_COLOR = "#d0d6de";
  const SITE_COLOR = "#e07ad6";
  const WRECK_COLOR = "#c9c9c9";
  const BATTLE_COLOR = "#e5534b";
  const NEUTRAL_COLOR = "#ffffff";
  const LABEL_COLOR = "rgba(230, 236, 245, 0.9)";
  const NOTE_COLOR = "rgba(230, 236, 245, 0.75)";
  const HOVER_COLOR = "#ffd75e";
  const LABEL_FONT = "11px system-ui, sans-serif";
  const TITLE_FONT = "bold 13px system-ui, sans-serif";
  const COUNT_FONT = "bold 10px system-ui, sans-serif";
  const SIZE = Object.freeze({ sun: 7, planet: 4, moon: 1.5, belt: 2.5, station: 3.5, gate: 4, fleet: 5,
    incoming: 5, battle: 6, modStation: 4.5, site: 4, wrecks: 5, salvage: 4 });
  const STATIC_KINDS = Object.freeze(["sun", "planet", "moon", "belt", "station", "gate"]);
  const KIND_LABELS = Object.freeze({ sun: "sun", planet: "planet", moon: "moon", belt: "asteroid belt",
    station: "NPC station", gate: "gate", fleet: "fleet", incoming: "inbound fleet", battle: "battle",
    modStation: "faction station", site: "site", wrecks: "wrecks", salvage: "salvage" });
  const MS_PER_SECOND = 1000;
  const SECONDS_PER_MINUTE = 60;
  const MINUTES_PER_HOUR = 60;
  const TITLE_GAP_PX = 10;
  const HEX_SIDES = 6;
  const CULL_MARGIN_PX = 160;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function logRadius(dMeters, dMaxMeters, R, baseMilliAu) {
    const b = Math.max(1, Number(baseMilliAu) || 0) / MILLI;
    const d = Math.max(0, Number(dMeters) || 0) / AU_METRES;
    const dMax = Math.max(MIN_DMAX_AU * AU_METRES, Number(dMaxMeters) || 0) / AU_METRES;
    return (R * Math.log(1 + d / b)) / Math.log(1 + dMax / b);
  }

  function leaveZoom(cfg) {
    return (Number(cfg.zoom) * Number(cfg.zoomOutPermille)) / MILLI;
  }

  function discRadius(zoomRel, cfg) {
    return (Number(cfg.startPx) * zoomRel) / Number(cfg.zoom);
  }

  function pointOnScreen(x, y, w, h, margin) {
    return x >= -margin && y >= -margin && x <= w + margin && y <= h + margin;
  }

  function circleOnScreen(cx, cy, r, w, h, margin) {
    const lo = -margin;
    const hiX = w + margin;
    const hiY = h + margin;
    const nx = Math.max(lo - cx, 0, cx - hiX);
    const ny = Math.max(lo - cy, 0, cy - hiY);
    const fx = Math.max(Math.abs(cx - lo), Math.abs(hiX - cx));
    const fy = Math.max(Math.abs(cy - lo), Math.abs(hiY - cy));
    return Math.hypot(nx, ny) <= r && Math.hypot(fx, fy) >= r;
  }

  function discOnScreen(cx, cy, r, w, h, margin) {
    const nx = Math.max(-margin - cx, 0, cx - (w + margin));
    const ny = Math.max(-margin - cy, 0, cy - (h + margin));
    return Math.hypot(nx, ny) <= r;
  }

  function interiorTarget(input) {
    const { prevId, zoomRel, cfg, selectedOnScreenId, nearestCenterId, prevDiscOnScreen } = input;
    if (!cfg || !Number.isFinite(zoomRel)) return null;
    const enter = Number(cfg.zoom);
    if (zoomRel < leaveZoom(cfg)) return null;
    const prev = prevId === null || prevId === undefined || prevDiscOnScreen === false ? null : prevId;
    if (zoomRel >= enter) {
      if (selectedOnScreenId !== null && selectedOnScreenId !== undefined) return selectedOnScreenId;
      if (prev !== null) return prev;
      return nearestCenterId === undefined ? null : nearestCenterId;
    }
    return prev;
  }

  function fanOffsets(n, px) {
    const out = [];
    if (n === 1) return [{ dx: 0, dy: -px }];
    for (let i = 0; i < n; i += 1) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      out.push({ dx: px * Math.cos(a), dy: px * Math.sin(a) });
    }
    return out;
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms)) return "-";
    const total = Math.max(0, Math.round(ms / MS_PER_SECOND));
    const s = total % SECONDS_PER_MINUTE;
    const minutes = Math.floor(total / SECONDS_PER_MINUTE);
    const pad = (v) => String(v).padStart(2, "0");
    if (minutes < MINUTES_PER_HOUR) return `${pad(minutes)}:${pad(s)}`;
    return `${Math.floor(minutes / MINUTES_PER_HOUR)}:${pad(minutes % MINUTES_PER_HOUR)}:${pad(s)}`;
  }

  function childOffset(d, dMin, dMax, ringPx) {
    if (!(ringPx > 0) || !(dMax > 0) || !(dMin > 0) || !(d > 0)) return 0;
    return (ringPx * Math.log(1 + Math.min(d, dMax) / dMin)) / Math.log(1 + dMax / dMin);
  }

  function layoutInterior(data, R, baseMilliAu, moonRingPermille) {
    const out = [];
    if (!data || !(R > 0)) return out;
    const statics = data.statics && Array.isArray(data.statics.objects) ? data.statics.objects : [];
    let dMax = 0;
    for (const o of statics) dMax = Math.max(dMax, Math.hypot(o.x, o.y));
    const ringPx = Number.isFinite(Number(moonRingPermille)) ? (R * Number(moonRingPermille)) / MILLI : 0;
    const refOf = new Map();
    for (const o of statics) refOf.set(o.itemId, o);
    let dChildMax = 0;
    let dChildMin = Infinity;
    for (const o of statics) {
      const p = o.parentId === null || o.parentId === undefined ? undefined : refOf.get(o.parentId);
      if (p && (o.kind === "moon" || o.kind === "belt" || o.kind === "station")) {
        const d = Math.hypot(o.x - p.x, o.y - p.y);
        dChildMax = Math.max(dChildMax, d);
        if (d > 0) dChildMin = Math.min(dChildMin, d);
      }
    }
    const offsetOf = (o, p) => childOffset(Math.hypot(o.x - p.x, o.y - p.y), dChildMin, dChildMax, ringPx);
    const polar = (x, y) => {
      const d = Math.hypot(x, y);
      if (d === 0) return { sx: 0, sy: 0 };
      const r = Math.min(R, logRadius(d, dMax, R, baseMilliAu));
      const a = Math.atan2(y, x);
      return { sx: r * Math.cos(a), sy: r * Math.sin(a) };
    };
    const byId = new Map();
    const add = (item) => {
      out.push(item);
      return item;
    };
    for (const o of statics) {
      if (o.kind !== "sun" && o.kind !== "planet" && o.kind !== "gate") continue;
      const p = o.kind === "sun" ? { sx: 0, sy: 0 } : polar(o.x, o.y);
      const item = add({ key: `s:${o.itemId}`, kind: o.kind, sx: p.sx, sy: p.sy, r: SIZE[o.kind], label: o.name,
        ref: o, orbit: o.kind === "planet" ? Math.hypot(p.sx, p.sy) : undefined });
      byId.set(o.itemId, item);
    }
    const ring = clamp(R * MOON_RING_FRACTION, MOON_RING_MIN_PX, MOON_RING_MAX_PX);
    const moonsOf = new Map();
    for (const o of statics) {
      if (o.kind !== "moon") continue;
      const parent = byId.get(o.parentId);
      const n = moonsOf.get(o.parentId) || 0;
      moonsOf.set(o.parentId, n + 1);
      let p;
      if (parent) {
        const a = Math.atan2(o.y - parent.ref.y, o.x - parent.ref.x);
        const rr = Math.max(ring + n * MOON_STEP_PX, offsetOf(o, parent.ref));
        p = { sx: parent.sx + rr * Math.cos(a), sy: parent.sy + rr * Math.sin(a) };
      } else p = polar(o.x, o.y);
      byId.set(o.itemId, add({ key: `s:${o.itemId}`, kind: "moon", sx: p.sx, sy: p.sy, r: SIZE.moon, label: o.name,
        ref: o }));
    }
    const cells = new Map();
    for (const o of statics) {
      if (o.kind !== "belt" && o.kind !== "station") continue;
      let p = polar(o.x, o.y);
      const parent = o.parentId === null || o.parentId === undefined ? undefined : byId.get(o.parentId);
      if (parent && parent.ref) {
        const natural = polar(parent.ref.x, parent.ref.y);
        const dx = p.sx - natural.sx;
        const dy = p.sy - natural.sy;
        const len = Math.hypot(dx, dy);
        const a = len > 0 ? Math.atan2(dy, dx) : Math.atan2(o.y - parent.ref.y, o.x - parent.ref.x);
        const rr = Math.max(len, offsetOf(o, parent.ref));
        p = { sx: parent.sx + rr * Math.cos(a), sy: parent.sy + rr * Math.sin(a) };
      }
      const cell = `${Math.round(p.sx / COLLIDE_PX)}:${Math.round(p.sy / COLLIDE_PX)}`;
      if (!cells.has(cell)) cells.set(cell, []);
      const item = add({ key: `s:${o.itemId}`, kind: o.kind, sx: p.sx, sy: p.sy, r: SIZE[o.kind], label: o.name,
        ref: o });
      cells.get(cell).push(item);
      byId.set(o.itemId, item);
    }
    for (const list of cells.values()) {
      if (list.length < 2) continue;
      const fan = fanOffsets(list.length, FAN_PX / 2);
      list.forEach((item, i) => {
        item.sx += fan[i].dx;
        item.sy += fan[i].dy;
      });
    }

    const groups = new Map();
    const place = (kind, keyPart, row, colourId, count) => {
      const base = { key: `${kind}:${keyPart}`, kind, sx: 0, sy: 0, r: SIZE[kind], label: null, ref: row,
        colourId: colourId === undefined ? null : colourId, count: count === undefined ? null : count };
      if (row.anchor === null && row.position) {
        const p = polar(row.position.x, row.position.y);
        base.sx = p.sx;
        base.sy = p.sy;
        return add(base);
      }
      const anchor = row.anchor || { kind: "sun", itemId: null };
      if (anchor.kind === "enroute") {
        const a = Number(anchor.angle) || 0;
        base.sx = R * ENROUTE_FACTOR * Math.cos(a);
        base.sy = R * ENROUTE_FACTOR * Math.sin(a);
        return add(base);
      }
      const at = anchor.itemId === null ? null : byId.get(anchor.itemId);
      const gk = at ? at.key : "centre";
      if (!groups.has(gk)) groups.set(gk, { at, items: [] });
      groups.get(gk).items.push(add(base));
      return base;
    };
    const rowsOf = (sec) => (sec && Array.isArray(sec.rows) ? sec.rows : []);
    for (const b of data.battles || []) {
      const a = b.sides && b.sides.A ? b.sides.A.factionId : null;
      place("battle", b.battleId, b, a);
    }
    for (const f of rowsOf(data.fleets)) place("fleet", f.fleetId, f, f.factionId, f.ships);
    for (const f of rowsOf(data.incoming)) place("incoming", f.fleetId, f, f.factionId, f.ships);
    for (const s of data.stations || []) place("modStation", s.stationId, s, s.ownerFactionId);
    for (const s of rowsOf(data.sites)) place("site", s.siteKey, s, s.factionId);
    if (data.wrecks) place("wrecks", "fields", data.wrecks, null, data.wrecks.fields);
    if (data.salvage) place("salvage", "anomalies", data.salvage, null, data.salvage.anomalies);
    for (const g of groups.values()) {
      const cx = g.at ? g.at.sx : 0;
      const cy = g.at ? g.at.sy : 0;
      const fan = fanOffsets(g.items.length, FAN_PX + (g.at ? g.at.r : SIZE.sun));
      g.items.forEach((item, i) => {
        item.sx = cx + fan[i].dx;
        item.sy = cy + fan[i].dy;
      });
    }
    return out;
  }

  function nameIn(names, id) {
    if (id === null || id === undefined) return "-";
    const n = names && typeof names.get === "function" ? names.get(id) : null;
    return n || `faction ${id}`;
  }

  function tooltipLines(item, names, systemName) {
    if (!item) return [];
    const sys = typeof systemName === "function" ? systemName : (id) => `system ${id}`;
    const r = item.ref || {};
    const kind = KIND_LABELS[item.kind] || item.kind;
    if (STATIC_KINDS.includes(item.kind)) {
      const lines = [r.name || `${kind} ${r.itemId}`, kind];
      if (item.kind === "gate" && r.toSystemId) lines.push(`to ${sys(r.toSystemId)}`);
      return lines;
    }
    switch (item.kind) {
      case "fleet": {
        const lines = [`${kind} ${r.fleetId}`, `${nameIn(names, r.factionId)} · ${r.role} · ${r.state} · ${r.ships} ships`];
        const l = r.live;
        if (l) {
          const what = l.source === "patrol" ? "patrol" : (l.source === "hunt" ? "hunt"
            : (l.source === "presence" ? "presence" : null));
          lines.push(what ? `in space · ${what}: ${l.phase || "-"}${l.mode ? ` (${l.mode})` : ""}`
            : "in space · position unknown");
          if (l.objectItemId !== null && l.objectItemId !== undefined) {
            lines.push(`current route target: ${l.objectName || `${l.objectKind || "object"} ${l.objectItemId}`}`);
          }
        }
        const p = r.presence;
        if (p) {
          lines.push(p.phase ? `presence: ${p.phase} · ${p.ships} ships in space`
            : `presence: hidden (${p.reason || "-"})`);
          if (p.transitTo) lines.push(`transit → ${sys(p.transitTo)}`);
        }
        return lines;
      }
      case "incoming":
        return [`${kind} ${r.fleetId}`, `${nameIn(names, r.factionId)} · ${r.role} · ${r.ships} ships`,
          `from ${sys(r.fromSystemId)} · ETA ${formatDuration(r.etaMs)}`];
      case "battle": {
        const a = r.sides && r.sides.A ? nameIn(names, r.sides.A.factionId) : "-";
        const b = r.sides && r.sides.B ? nameIn(names, r.sides.B.factionId) : "-";
        return [`${kind} ${r.battleId}`, `${a} vs ${b} · ${r.state} · ${r.mode || "-"}`];
      }
      case "site":
        return [r.label || r.templateId || kind, `${r.state} · expires in ${formatDuration(r.expiresMs)}`];
      case "modStation":
        return [r.name || `${kind} ${r.stationId}`, `${nameIn(names, r.ownerFactionId)} · ${r.state}`];
      case "wrecks":
        return [`wreck fields: ${r.fields}`];
      case "salvage":
        return [`salvage anomalies: ${r.anomalies}`];
      default:
        return [kind];
    }
  }

  function hitTest(layout, cx, cy, mx, my, radiusPx) {
    let best = null;
    let bestD = Infinity;
    for (const item of layout || []) {
      const d = Math.hypot(cx + item.sx - mx, cy + item.sy - my);
      if (d <= Math.max(radiusPx, item.r) && d <= bestD) {
        best = item;
        bestD = d;
      }
    }
    return best;
  }

  function circle(ctx, x, y, r, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function polygon(ctx, x, y, r, sides, rotation) {
    ctx.beginPath();
    for (let i = 0; i < sides; i += 1) {
      const a = rotation + (i * 2 * Math.PI) / sides;
      if (i === 0) ctx.moveTo(x + r * Math.cos(a), y + r * Math.sin(a));
      else ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
    }
    ctx.closePath();
  }

  function shape(ctx, item, x, y, colour) {
    const r = item.r;
    switch (item.kind) {
      case "sun": circle(ctx, x, y, r, SUN_COLOR); break;
      case "planet": circle(ctx, x, y, r, PLANET_COLOR); break;
      case "moon": circle(ctx, x, y, r, MOON_COLOR); break;
      case "belt":
        ctx.strokeStyle = BELT_COLOR;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, r + 1, Math.PI * 0.15, Math.PI * 0.85);
        ctx.stroke();
        circle(ctx, x, y, 1, BELT_COLOR);
        break;
      case "gate":
        ctx.fillStyle = GATE_COLOR;
        polygon(ctx, x, y, r, 4, 0);
        ctx.fill();
        break;
      case "station":
        ctx.fillStyle = NPC_STATION_COLOR;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
        break;
      case "modStation":
        ctx.fillStyle = colour;
        polygon(ctx, x, y, r, HEX_SIDES, 0);
        ctx.fill();
        break;
      case "fleet":
        ctx.fillStyle = colour;
        polygon(ctx, x, y, r, 3, -Math.PI / 2);
        ctx.fill();
        break;
      case "incoming": {
        const a = Math.atan2(-item.sy, -item.sx);
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.moveTo(x + r * Math.cos(a), y + r * Math.sin(a));
        ctx.lineTo(x + r * Math.cos(a + 2.5), y + r * Math.sin(a + 2.5));
        ctx.lineTo(x + r * Math.cos(a - 2.5), y + r * Math.sin(a - 2.5));
        ctx.closePath();
        ctx.fill();
        break;
      }
      case "battle":
        ctx.lineWidth = 2;
        ctx.strokeStyle = colour;
        ctx.beginPath();
        ctx.arc(x, y, r, Math.PI * 0.6, Math.PI * 1.4);
        ctx.stroke();
        ctx.strokeStyle = BATTLE_COLOR;
        ctx.beginPath();
        ctx.arc(x, y, r, -Math.PI * 0.4, Math.PI * 0.4);
        ctx.stroke();
        break;
      case "site":
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
        circle(ctx, x, y, 1.5, colour);
        break;
      case "wrecks":
      case "salvage":
        ctx.strokeStyle = WRECK_COLOR;
        ctx.lineWidth = 1.5;
        polygon(ctx, x, y, r, 3, -Math.PI / 2);
        ctx.stroke();
        break;
      default: circle(ctx, x, y, r, NEUTRAL_COLOR);
    }
  }

  function colourFor(item, colourOf) {
    if (item.kind === "site" && (item.colourId === null || item.colourId === undefined)) return SITE_COLOR;
    if (item.colourId === null || item.colourId === undefined) return NEUTRAL_COLOR;
    try {
      return typeof colourOf === "function" ? colourOf(item.colourId) : NEUTRAL_COLOR;
    } catch (_err) {
      return NEUTRAL_COLOR;
    }
  }

  function draw(ctx, layout, opts) {
    const { cx, cy, R } = opts;
    const w = Number.isFinite(opts.viewW) ? opts.viewW : Infinity;
    const h = Number.isFinite(opts.viewH) ? opts.viewH : Infinity;
    const seen = (x, y) => pointOnScreen(x, y, w, h, CULL_MARGIN_PX);
    const ringSeen = (r) => circleOnScreen(cx, cy, r, w, h, CULL_MARGIN_PX);
    const covers = Number.isFinite(w) && Number.isFinite(h) && !ringSeen(R)
      && Math.hypot(Math.max(Math.abs(cx), Math.abs(w - cx)), Math.max(Math.abs(cy), Math.abs(h - cy))) < R;
    if (covers) {
      ctx.fillStyle = DISC_BACKGROUND;
      ctx.fillRect(0, 0, w, h);
    } else if (ringSeen(R)) {
      circle(ctx, cx, cy, R, DISC_BACKGROUND);
      ctx.strokeStyle = DISC_EDGE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.font = TITLE_FONT;
    ctx.fillStyle = LABEL_COLOR;
    if (opts.title && seen(cx, cy - R - TITLE_GAP_PX)) ctx.fillText(opts.title, cx, cy - R - TITLE_GAP_PX);
    if (!layout || opts.message) {
      ctx.font = LABEL_FONT;
      ctx.fillStyle = NOTE_COLOR;
      ctx.fillText(opts.message || "loading…", cx, cy);
      if (!layout) return;
    }
    ctx.strokeStyle = ORBIT_LINE;
    ctx.lineWidth = 1;
    for (const item of layout) {
      if (item.kind !== "planet" || !(item.orbit > 0) || !ringSeen(item.orbit)) continue;
      ctx.beginPath();
      ctx.arc(cx, cy, item.orbit, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const item of layout) {
      if (seen(cx + item.sx, cy + item.sy)) shape(ctx, item, cx + item.sx, cy + item.sy, colourFor(item, opts.colourOf));
    }
    ctx.font = LABEL_FONT;
    ctx.fillStyle = LABEL_COLOR;
    ctx.textAlign = "left";
    for (const item of layout) {
      const x = cx + item.sx;
      const y = cy + item.sy;
      if (!seen(x, y)) continue;
      const labelled = item.kind === "planet" || item.kind === "sun" || (item.kind === "moon" && R >= LABEL_MOON_R_PX);
      if (labelled && item.label) ctx.fillText(item.label, x + item.r + 3, y);
      if (item.count !== null && item.count !== undefined && has(SIZE, item.kind) && !STATIC_KINDS.includes(item.kind)) {
        ctx.font = COUNT_FONT;
        ctx.fillText(item.kind === "wrecks" || item.kind === "salvage" ? `×${item.count}` : String(item.count),
          x + item.r + 2, y);
        ctx.font = LABEL_FONT;
      }
      if (opts.hoverKey && item.key === opts.hoverKey) {
        ctx.strokeStyle = HOVER_COLOR;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, item.r + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  global.LneSystemInterior = Object.freeze({
    draw,
    hitTest,
    _pure: Object.freeze({ layoutInterior, logRadius, interiorTarget, fanOffsets, tooltipLines, hitTest,
      formatDuration, childOffset, leaveZoom, discRadius, pointOnScreen, circleOnScreen, discOnScreen }),
  });
}(typeof window !== "undefined" ? window : globalThis));
