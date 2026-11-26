"use strict";

const { DeadlineQueue } = require("../../scheduler/deadlineQueue");
const { createRng, deriveSeed } = require("../../util/rng");
const { MEMORY_ESTIMATE } = require("../schema");
const { CORP_STATE, CORP_NAME_ID_OFFSET, NAME_ARCHETYPE_OF_FOCUS, CORP_REC_BYTES, EXTRA_ENTRY_BYTES } =
  require("./schema");
const rules = require("./rules");

const keyOf = (corpId) => `c:${corpId}`;
const nameKeyOf = (name) => String(name).trim().toLowerCase();
const validName = (g) => g && typeof g.name === "string" && g.name.length >= 1 && g.name.length <= 50
  && typeof g.ticker === "string" && g.ticker.length >= 2 && g.ticker.length <= 5;

function createCorpsService(deps) {
  const C = deps.S.corps;
  const worldSeed = deps.worldSeed;
  const pilots = deps.pilots;
  const standings = deps.standings;
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const metric = typeof deps.metric === "function" ? deps.metric : () => {};
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => 0;
  const activity = deps.activity && typeof deps.activity.isActive === "function"
    && typeof deps.activity.isEligible === "function" ? deps.activity : null;
  const compactAt = activity && Number.isSafeInteger(activity.compactAt) && activity.compactAt > 0
    ? activity.compactAt : Infinity;

  const queue = new DeadlineQueue();
  const corps = new Map();
  const members = new Map();
  const nameKeys = new Set();
  const dirty = new Set();
  const recruitCursor = new Map();
  let dissolvedQueue = [];
  let byHomeRegion = new Map();
  let regionBytes = 0;
  let foundCursor = 1;
  let nextFoundingAt = 0;
  let maxIdSeen = 0;
  let open = 0;
  let totalMembers = 0;
  let loaded = false;
  let lastStep = Object.freeze({ founded: 0, reviewed: 0, foundScans: 0, maxReviewScans: 0, ms: 0 });
  const extraByRegion = new Map();
  let extraCount = 0;
  let compactions = 0;

  function regionOf(homeId) {
    const table = deps.getTable();
    const i = table && table.indexOf ? table.indexOf.get(homeId) : undefined;
    return i !== undefined ? table.regionId[i] : 0;
  }

  function touch(rec) {
    if (dirty.has(rec.corpId)) return;
    rec.version += 1;
    dirty.add(rec.corpId);
  }

  function schedule(rec) {
    queue.schedule(keyOf(rec.corpId), rec.nextAt, rec.corpId);
  }

  function corplessPermille() {
    const size = pilots.size();
    return size > 0 ? Math.floor(((size - totalMembers) * 1000) / size) : 0;
  }

  function lowestOf(set) {
    let min = 0;
    for (const id of set) if (min === 0 || id < min) min = id;
    return min;
  }

  function countActive(set) {
    let n = 0;
    for (const id of set) if (activity.isActive(id)) n += 1;
    return n;
  }

  function load(rows, now) {
    corps.clear();
    members.clear();
    nameKeys.clear();
    dirty.clear();
    recruitCursor.clear();
    queue.clear();
    dissolvedQueue = [];
    open = 0;
    totalMembers = 0;
    maxIdSeen = 0;
    extraByRegion.clear();
    extraCount = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || !Number.isSafeInteger(row.corpId) || row.corpId <= 0 || corps.has(row.corpId)) continue;
      const rec = { ...row };
      corps.set(rec.corpId, rec);
      nameKeys.add(nameKeyOf(rec.name));
      if (rec.corpId > maxIdSeen) maxIdSeen = rec.corpId;
      if (rec.state === CORP_STATE.ACTIVE) {
        members.set(rec.corpId, new Set());
        open += 1;
      } else {
        dissolvedQueue.push(rec);
      }
    }
    dissolvedQueue.sort((a, b) => a.endedAt - b.endedAt || a.corpId - b.corpId);
    const lists = new Map();
    let orphans = 0;
    for (let id = 1; id <= pilots.capacity; id += 1) {
      if (!pilots.has(id)) continue;
      const region = regionOf(pilots.homeOf(id));
      const list = lists.get(region);
      if (list) list.push(id);
      else lists.set(region, [id]);
      const corpId = pilots.corpOf(id);
      if (corpId === 0) continue;
      const set = members.get(corpId);
      if (set) {
        set.add(id);
        totalMembers += 1;
      } else {
        pilots.setCorp(id, 0);
        orphans += 1;
      }
    }
    byHomeRegion = new Map();
    regionBytes = 0;
    for (const [region, list] of lists) {
      const arr = Int32Array.from(list);
      byHomeRegion.set(region, arr);
      regionBytes += arr.byteLength + MEMORY_ESTIMATE.MAP_ENTRY_BYTES;
    }
    for (const [corpId, set] of members) {
      const rec = corps.get(corpId);
      let changed = rec.members !== set.size;
      rec.members = set.size;
      if (!set.has(rec.ceoPilotId)) {
        rec.ceoPilotId = lowestOf(set);
        changed = true;
      }
      if (set.size === 0) rec.nextAt = now;
      if (changed) touch(rec);
      schedule(rec);
    }
    if (orphans > 0) bump("corps.orphanMembers", orphans);
    nextFoundingAt = now;
    foundCursor = 1;
    loaded = true;
    return { ok: true, orphans };
  }

  function findFounder(stats) {
    const cap = pilots.capacity;
    if (cap <= 0) return 0;
    let skipped = 0;
    let founder = 0;
    for (let i = 0; i < C.scanPerReview; i += 1) {
      const id = foundCursor;
      foundCursor = foundCursor >= cap ? 1 : foundCursor + 1;
      stats.foundScans += 1;
      if (!(pilots.has(id) && pilots.corpOf(id) === 0 && pilots.homeOf(id) > 0)) continue;
      if (activity && !activity.isEligible(id)) {
        skipped += 1;
        continue;
      }
      founder = id;
      break;
    }
    if (skipped > 0) bump("corps.skippedInactive", skipped);
    return founder;
  }

  function pickName(corpId, focus) {
    for (let attempt = 0; attempt < C.maxNameAttempts; attempt += 1) {
      let g = null;
      try {
        g = deps.generateName({ worldSeed, corpId: CORP_NAME_ID_OFFSET + corpId,
          archetype: NAME_ARCHETYPE_OF_FOCUS[focus], attempt });
      } catch (_err) {
        g = null;
      }
      if (validName(g) && !nameKeys.has(nameKeyOf(g.name))) return g;
    }
    return null;
  }

  function found(now, stats) {
    const founder = findFounder(stats);
    if (founder === 0) return false;
    const corpId = maxIdSeen + 1;
    maxIdSeen = corpId;
    const focus = rules.focusOf(pilots.archetypeOf(founder));
    const g = pickName(corpId, focus);
    if (!g) {
      bump("corps.nameRefused");
      return false;
    }
    const rng = createRng(deriveSeed(worldSeed, "pcorp-found", corpId));
    const homeId = pilots.homeOf(founder);
    const profile = standings.profileOfPilot(founder);
    const rec = { corpId, name: g.name, ticker: g.ticker, focus, state: CORP_STATE.ACTIVE, homeId,
      regionId: regionOf(homeId), profile: Number.isSafeInteger(profile) && profile >= 0 ? profile : 0,
      ceoPilotId: founder, members: 1, seq: 0, foundedAt: now,
      nextAt: now + 1 + Math.floor(rng.nextFloat() * C.reviewMs),
      lowSince: 1 < C.membersMin ? now : 0, endedAt: 0, version: 0 };
    corps.set(corpId, rec);
    nameKeys.add(nameKeyOf(rec.name));
    members.set(corpId, new Set([founder]));
    pilots.setCorp(founder, corpId);
    totalMembers += 1;
    open += 1;
    touch(rec);
    schedule(rec);
    bump("corps.founded");
    return true;
  }

  function leave(set, id) {
    set.delete(id);
    pilots.setCorp(id, 0);
    totalMembers -= 1;
  }

  function dissolve(rec, set, now) {
    for (const id of set) pilots.setCorp(id, 0);
    totalMembers -= set.size;
    members.delete(rec.corpId);
    recruitCursor.delete(rec.corpId);
    queue.remove(keyOf(rec.corpId));
    rec.state = CORP_STATE.DISSOLVED;
    rec.members = 0;
    rec.endedAt = now;
    open -= 1;
    dissolvedQueue.push(rec);
    bump("corps.dissolved");
  }

  function recruit(rec, set, rng, stats, leavers) {
    const list = byHomeRegion.get(rec.regionId);
    const extra = activity ? extraByRegion.get(rec.regionId) : undefined;
    const baseLen = list ? list.length : 0;
    const len = baseLen + (extra ? extra.length : 0);
    if (len === 0 || C.recruitsPerReview <= 0) return;
    let cursor = recruitCursor.get(rec.corpId) || 0;
    if (cursor >= len) cursor = 0;
    const scanMax = Math.min(C.scanPerReview, len);
    let scans = 0;
    let accepted = 0;
    let skipped = 0;
    while (scans < scanMax && accepted < C.recruitsPerReview && set.size < C.membersMax
      && corplessPermille() > C.corplessPermille) {
      const id = cursor < baseLen ? list[cursor] : extra[cursor - baseLen];
      cursor = cursor + 1 >= len ? 0 : cursor + 1;
      scans += 1;
      const corpId = pilots.corpOf(id);
      if (corpId !== 0 || (leavers && leavers.has(id))) continue;
      if (activity && (!activity.isEligible(id) || regionOf(pilots.homeOf(id)) !== rec.regionId)) {
        skipped += 1;
        continue;
      }
      const distance = standings.distance(standings.profileOfPilot(id), rec.profile);
      if (!(distance <= C.joinMaxDistance)) continue;
      if (!rules.accepts(rec, { archetype: pilots.archetypeOf(id), corpId }, distance, rng.nextFloat(), C)) continue;
      set.add(id);
      pilots.setCorp(id, rec.corpId);
      totalMembers += 1;
      accepted += 1;
    }
    recruitCursor.set(rec.corpId, cursor);
    if (scans > stats.maxReviewScans) stats.maxReviewScans = scans;
    if (accepted > 0) bump("corps.joined", accepted);
    if (skipped > 0) bump("corps.skippedInactive", skipped);
  }

  function review(corpId, now, stats) {
    const rec = corps.get(corpId);
    const set = members.get(corpId);
    if (!rec || rec.state !== CORP_STATE.ACTIVE || !set) return;
    rec.seq += 1;
    const rng = createRng(deriveSeed(worldSeed, "pcorp", corpId, rec.seq));
    const k = rules.leaveCount(set.size, rng, C);
    let leavers = null;
    if (k > 0) {
      leavers = new Set();
      const arr = [...set].sort((a, b) => a - b);
      for (let i = 0; i < k && arr.length > 0; i += 1) {
        const j = rng.nextInt(0, arr.length - 1);
        const id = arr[j];
        arr[j] = arr[arr.length - 1];
        arr.pop();
        leave(set, id);
        leavers.add(id);
      }
      bump("corps.left", k);
    }
    recruit(rec, set, rng, stats, leavers);
    if (!set.has(rec.ceoPilotId)) rec.ceoPilotId = lowestOf(set);
    const d = activity ? rules.shouldDissolveActive(rec, set.size, countActive(set), now, C)
      : rules.shouldDissolve(rec, set.size, now, C);
    if (d.dissolve) {
      dissolve(rec, set, now);
      if (d.inactive === true) bump("corps.dissolvedInactive");
    } else {
      rec.members = set.size;
      rec.lowSince = d.lowSince;
      rec.nextAt = now + C.reviewMs;
      schedule(rec);
    }
    touch(rec);
  }

  function foundingDue(now) {
    return C.foundPerPass > 0 && open < C.targetCorps && now >= nextFoundingAt;
  }

  function pending(now) {
    if (!loaded) return false;
    const head = queue.peek();
    return foundingDue(now) || Boolean(head && head.dueAtMs <= now);
  }

  function step(now) {
    if (!loaded) return { ok: true, work: 0, founded: 0, reviewed: 0 };
    const t0 = nowMs();
    const stats = { founded: 0, reviewed: 0, foundScans: 0, maxReviewScans: 0 };
    let work = 0;
    if (foundingDue(now)) {
      for (let i = 0; i < C.foundPerPass && open < C.targetCorps; i += 1) {
        work += 1;
        if (!found(now, stats)) break;
        stats.founded += 1;
      }
      nextFoundingAt = now + C.foundingIntervalMs;
    }
    while (stats.reviewed < C.maxCorpsPerPass) {
      const head = queue.peek();
      if (!head || head.dueAtMs > now) break;
      queue.remove(head.key);
      review(head.payload, now, stats);
      stats.reviewed += 1;
      work += 1;
    }
    const ms = Math.max(0, nowMs() - t0);
    lastStep = Object.freeze({ ...stats, ms });
    metric("observe", "population.corpsStepMs", ms);
    metric("gauge", "population.corps.open", open);
    metric("gauge", "population.corps.members", totalMembers);
    metric("gauge", "population.corps.corplessPermille", corplessPermille());
    return { ok: true, work, founded: stats.founded, reviewed: stats.reviewed };
  }

  function takeDirty(limit) {
    const out = [];
    for (const corpId of dirty) {
      if (out.length >= limit) break;
      dirty.delete(corpId);
      const rec = corps.get(corpId);
      if (!rec) continue;
      const set = members.get(corpId);
      out.push(Object.freeze({ ...rec, members: set ? set.size : 0 }));
    }
    return out;
  }

  function markDirty(corpId) {
    if (corps.has(corpId)) dirty.add(corpId);
  }

  function expiredIds(beforeAt, limit) {
    const out = [];
    for (const rec of dissolvedQueue) {
      if (out.length >= limit || rec.endedAt >= beforeAt) break;
      if (!dirty.has(rec.corpId)) out.push(rec.corpId);
    }
    return out;
  }

  function forget(corpIds) {
    if (!Array.isArray(corpIds) || corpIds.length === 0) return;
    const gone = new Set(corpIds);
    for (const id of gone) {
      const rec = corps.get(id);
      if (!rec || rec.state !== CORP_STATE.DISSOLVED) continue;
      corps.delete(id);
      nameKeys.delete(nameKeyOf(rec.name));
    }
    dissolvedQueue = dissolvedQueue.filter((rec) => !gone.has(rec.corpId));
  }

  function removeMember(pilotId) {
    const corpId = pilots.corpOf(pilotId);
    const set = corpId > 0 ? members.get(corpId) : null;
    const rec = corpId > 0 ? corps.get(corpId) : null;
    if (!set || !rec || rec.state !== CORP_STATE.ACTIVE || !set.has(pilotId)) return { removed: false };
    leave(set, pilotId);
    rec.members = set.size;
    if (!set.has(rec.ceoPilotId)) rec.ceoPilotId = lowestOf(set);
    touch(rec);
    bump("corps.left");
    return { removed: true };
  }

  function compactRegion(region) {
    const base = byHomeRegion.get(region);
    const extra = extraByRegion.get(region) || [];
    const seen = new Set();
    const out = [];
    const keep = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      if (pilots.has(id) && regionOf(pilots.homeOf(id)) === region) out.push(id);
    };
    if (base) for (const id of base) keep(id);
    for (const id of extra) keep(id);
    if (base) regionBytes -= base.byteLength + MEMORY_ESTIMATE.MAP_ENTRY_BYTES;
    const arr = Int32Array.from(out);
    byHomeRegion.set(region, arr);
    regionBytes += arr.byteLength + MEMORY_ESTIMATE.MAP_ENTRY_BYTES;
    extraCount -= extra.length;
    extraByRegion.delete(region);
    compactions += 1;
  }

  function noteHomeChange(pilotId) {
    if (!activity || !loaded || !pilots.has(pilotId)) return { noted: false, compacted: false };
    const homeId = pilots.homeOf(pilotId);
    if (!(homeId > 0)) return { noted: false, compacted: false };
    const region = regionOf(homeId);
    let list = extraByRegion.get(region);
    if (!list) {
      list = [];
      extraByRegion.set(region, list);
    }
    list.push(pilotId);
    extraCount += 1;
    if (list.length <= compactAt) return { noted: true, compacted: false };
    compactRegion(region);
    return { noted: true, compacted: true };
  }

  function profileOf(pilotId) {
    const corpId = pilots.corpOf(pilotId);
    if (!(corpId > 0)) return -1;
    const rec = corps.get(corpId);
    return rec && rec.state === CORP_STATE.ACTIVE ? rec.profile : -1;
  }

  function corp(corpId) {
    const rec = corps.get(corpId);
    if (!rec) return null;
    const set = members.get(corpId);
    return Object.freeze({ ...rec, members: set ? set.size : 0 });
  }

  function membersOf(corpId) {
    const set = members.get(corpId);
    return set ? Object.freeze([...set].sort((a, b) => a - b)) : Object.freeze([]);
  }

  function getStatus() {
    return Object.freeze({ enabled: true, loaded, open, members: totalMembers, corplessPermille: corplessPermille(),
      dissolvedKept: dissolvedQueue.length, dirty: dirty.size, maxIdSeen, queue: queue.size, lastStep,
      ...(activity ? { activity: Object.freeze({ extraEntries: extraCount, compactions }) } : {}) });
  }

  function approxBytes() {
    const K = MEMORY_ESTIMATE;
    return corps.size * (K.MAP_ENTRY_BYTES + CORP_REC_BYTES) + totalMembers * K.SET_ENTRY_BYTES
      + members.size * K.MAP_ENTRY_BYTES + nameKeys.size * K.NAME_ENTRY_BYTES + queue.size * K.QUEUE_ENTRY_BYTES
      + recruitCursor.size * K.MAP_ENTRY_BYTES + regionBytes
      + extraCount * EXTRA_ENTRY_BYTES + extraByRegion.size * K.MAP_ENTRY_BYTES;
  }

  return Object.freeze({ load, step, pending, takeDirty, markDirty, expiredIds, forget, profileOf, corp, membersOf,
    getStatus, approxBytes, removeMember, noteHomeChange,
    dirtyCount: () => dirty.size,
    size: () => corps.size });
}

module.exports = { createCorpsService };
