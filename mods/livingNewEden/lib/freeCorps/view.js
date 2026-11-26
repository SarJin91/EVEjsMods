"use strict";

const VIEW_ID = "free-corps";
const VIEW_ORDER = 206;
const WORK_CLASS = "MAINTENANCE";
const ROW_KEYS = Object.freeze(["corpId", "corporation", "archetype", "state", "band", "home", "members",
  "corporationId", "isk", "foundedAt", "treasury", "earned", "lost", "ventures", "recovering"]);
const VENTURE_ROW_KEYS = Object.freeze(["ventureId", "corp", "kind", "state", "system", "target", "crew", "step",
  "yieldIsk", "dueAt"]);
const WAR_ROW_KEYS = Object.freeze(["warId", "sideA", "sideB", "ally", "state", "kills", "iskLost", "skirmishes",
  "endsAt"]);
const SKIRMISH_ROW_KEYS = Object.freeze(["skirmishId", "at", "system", "attacker", "defender", "outcome", "lost",
  "loot", "war"]);
const RECENT_SKIRMISHES = 20;
const KM_ROW_KEYS = Object.freeze(["key", "state", "attempts", "killId", "lastError", "createdAt"]);
const RECENT_KILLMAILS = 10;
const KM_KIND = "KILLMAIL";
const CT_ROW_KEYS = Object.freeze(["contractKey", "corpId", "goods", "typeId", "quantity", "priceIsk", "state",
  "vendorContractId", "endReason", "createdAt"]);
const RECENT_CONTRACTS = 10;
const RC_ROW_KEYS = Object.freeze(["characterId", "originCorpId", "corpId", "state", "moves", "updatedAt"]);
const RECENT_MEMBERS = 10;
const ST_ROW_KEYS = Object.freeze(["key", "corpId", "systemId", "state", "itemId", "endReason", "updatedAt"]);
const RECENT_STRUCTURES = 10;
const WH_ROW_KEYS = Object.freeze(["corpId", "corporation", "jSystem", "staging", "lootIsk", "gasIsk", "cargoIsk",
  "cargoSeq", "piIskTotal", "soldIskTotal", "done", "venture", "treasury", "foundedAt"]);
const WH_COUNTER_PREFIX = "wh";
const DAY_MS = 86400000;

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function tallyOf(rows, key) {
  const out = {};
  for (const r of rows) out[r[key]] = (out[r[key]] || 0) + r.n;
  return out;
}

function buildFreeCorpsView(deps) {
  const { store, repository } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const getGraph = typeof deps.getGraph === "function" ? deps.getGraph : () => null;
  const maxRows = Number.isSafeInteger(deps.maxRows) && deps.maxRows > 0 ? deps.maxRows : 1;

  function admitted() {
    const governor = call(getGovernor, null);
    return !governor || typeof governor.admits !== "function" || call(() => governor.admits(WORK_CLASS), true) !== false;
  }

  function systemNameOf() {
    const graph = call(getGraph, null);
    return (id) => {
      const v = graph && typeof graph.getSystem === "function" ? call(() => graph.getSystem(id), null) : null;
      return v && typeof v.name === "string" ? v.name : String(id);
    };
  }

  const ventureRepository = deps.ventureRepository || null;
  const nowOf = typeof deps.now === "function" ? deps.now : () => 0;

  function rowOf(r, systemName, now) {
    return { corpId: r.corp_id, corporation: `${r.name} [${r.ticker}]`, archetype: r.archetype,
      state: r.end_reason ? `${r.state} (${r.end_reason})` : r.state, band: r.sec_band,
      home: `${systemName(r.home_system_id)} / ${r.home_station_id}`, members: r.members_target,
      corporationId: r.corporation_id === null ? "-" : r.corporation_id, isk: r.isk, foundedAt: r.founded_at,
      treasury: r.isk, earned: r.isk_earned, lost: r.isk_lost, ventures: `${r.ventures_done}/${r.ventures_lost}`,
      recovering: r.recover_until > now ? r.recover_crew : 0 };
  }

  function venturesOf(read, systemName) {
    if (!read.ventures) return { enabled: false };
    const names = new Map(read.rows.map((r) => [r.corp_id, `${r.name} [${r.ticker}]`]));
    const byKind = {};
    const byState = {};
    const closedByState = { DONE: 0, LOST: 0, ABORTED: 0 };
    let open = 0;
    for (const c of read.ventures.counts) {
      if (c.open === 1) {
        open += c.n;
        byKind[c.kind] = (byKind[c.kind] || 0) + c.n;
        byState[c.state] = (byState[c.state] || 0) + c.n;
      } else {
        closedByState[c.state] = (closedByState[c.state] || 0) + c.n;
      }
    }
    const rows = read.ventures.rows.map((v) => ({ ventureId: v.venture_id, corp: names.get(v.corp_id) || v.corp_id,
      kind: v.kind, state: v.state, system: systemName(v.system_id), target: systemName(v.target_system_id),
      crew: v.crew, step: `${v.step}/${v.steps_total}`, yieldIsk: v.yield_isk, dueAt: v.step_due_at }));
    return { enabled: true, open, byKind, byState, closedByState, rows, truncated: read.ventures.truncated };
  }

  const warRepository = deps.warRepository || null;
  const label = (name, ticker, id) => (name ? `${name} [${ticker}]` : String(id));

  function warsOf(read, systemName) {
    if (!read.wars) return { enabled: false };
    const rows = read.wars.rows.map((w) => ({ warId: w.war_id, sideA: label(w.name_a, w.ticker_a, w.corp_a),
      sideB: label(w.name_b, w.ticker_b, w.corp_b),
      ally: w.ally_corp_id === null ? "-" : `${label(w.name_ally, w.ticker_ally, w.ally_corp_id)} (${w.ally_side})`,
      state: w.state, kills: `${w.kills_a}/${w.kills_b}`, iskLost: `${w.isk_lost_a}/${w.isk_lost_b}`,
      skirmishes: w.skirmishes, endsAt: w.ends_at }));
    const recent = read.wars.recent.map((s) => ({ skirmishId: s.skirmish_id, at: s.at, system: systemName(s.system_id),
      attacker: s.ticker_a ? `[${s.ticker_a}] ${s.attacker_kind}` : String(s.attacker_corp_id),
      defender: s.ticker_d ? `[${s.ticker_d}] ${s.defender_kind}` : String(s.defender_corp_id), outcome: s.outcome,
      lost: `${s.crew_lost_a}/${s.crew_lost_d}`, loot: s.loot_isk, war: s.war_id || "-" }));
    return { enabled: true, open: rows.length, rows, truncated: read.wars.truncated, recent,
      last24h: { count: read.wars.last24h.count, byOutcome: read.wars.last24h.byOutcome } };
  }

  const outboxRepository = deps.outboxRepository || null;

  function killmailsOf(read) {
    if (!read.killmails) return { enabled: false };
    const k = read.killmails;
    return { enabled: true, pending: k.stats.pending,
      last24h: { done: k.stats.doneSince, failed: k.stats.failedSince }, lastKillId: k.stats.lastResultId,
      recent: k.recent.map((r) => ({ key: r.key, state: r.state, attempts: r.attempts, killId: r.result_id,
        lastError: r.last_error, createdAt: r.created_at })) };
  }

  const contractRepository = deps.contractRepository || null;
  const contractMode = typeof deps.contractMode === "function" ? deps.contractMode : () => null;
  const courierMode = typeof deps.courierMode === "function" ? deps.courierMode : () => null;

  function contractsOf(read) {
    if (!read.contracts) return { enabled: false };
    const k = read.contracts;
    return { enabled: true, mode: call(contractMode, null), open: k.stats.open,
      last24h: { sold: k.stats.soldSince, closed: k.stats.closedSince, revenueIsk: k.stats.revenueSince },
      recent: k.recent.map((r) => ({ contractKey: r.contract_key, corpId: r.corp_id, goods: r.goods, typeId: r.type_id,
        quantity: r.quantity, priceIsk: r.price_isk, state: r.state, vendorContractId: r.vendor_contract_id,
        endReason: r.end_reason, createdAt: r.created_at })),
      courier: k.courier ? { enabled: true, mode: call(courierMode, null), open: k.courier.open,
        last24h: { delivered: k.courier.delivered, failed: k.courier.failed, rewardIsk: k.courier.rewardIsk } }
        : { enabled: false } };
  }

  const membersRepository = deps.membersRepository || null;

  function recycleOf(read) {
    if (!read.recycle) return { enabled: false };
    const k = read.recycle;
    return { enabled: true, free: k.stats.free, joining: k.stats.joining, member: k.stats.member, lost: k.stats.lost,
      recent: k.recent.map((r) => ({ characterId: r.character_id, originCorpId: r.origin_corp_id, corpId: r.corp_id,
        state: r.state, moves: r.moves, updatedAt: r.updated_at })) };
  }

  const structureRepository = deps.structureRepository || null;

  function structuresOf(read) {
    if (!read.structures) return { enabled: false };
    const k = read.structures;
    return { enabled: true, mode: deps.structureMode || null, open: k.stats.open, byState: k.stats.byState,
      lost24h: k.stats.lostSince,
      recent: k.recent.map((r) => ({ key: r.structure_key, corpId: r.corp_id, systemId: r.system_id, state: r.state,
        itemId: r.evejs_item_id, endReason: r.end_reason, updatedAt: r.updated_at })) };
  }

  const whRepository = deps.whRepository || null;
  const whStatus = typeof deps.whStatus === "function" ? deps.whStatus : () => null;
  const whSettings = deps.whSettings || {};

  function whRowOf(r, systemName) {
    return { corpId: r.corp_id, corporation: `${r.name} [${r.ticker}]`, jSystem: systemName(r.j_system_id),
      staging: systemName(r.staging_system_id), lootIsk: r.loot_isk, gasIsk: r.gas_isk,
      cargoIsk: r.cargo_loot_isk + r.cargo_gas_isk, cargoSeq: r.cargo_venture_seq === null ? "-" : r.cargo_venture_seq,
      piIskTotal: r.pi_isk_total, soldIskTotal: r.sold_isk_total, done: `${r.home_done}/${r.haul_done}/${r.raid_done}`,
      venture: r.v_kind === null ? "-"
        : `${r.v_kind} ${r.v_state} @ ${systemName(r.v_system_id)} ${r.v_step}/${r.v_steps_total}`,
      treasury: r.isk, foundedAt: r.founded_at };
  }

  function whCorpsOf(read, systemName, status) {
    const st = call(whStatus, null) || {};
    const s = read.wh.stats;
    const counters = {};
    for (const [k, v] of Object.entries(status.counters || {})) if (k.startsWith(WH_COUNTER_PREFIX)) counters[k] = v;
    return { enabled: true, mode: st.mode === undefined ? null : st.mode, target: whSettings.target,
      open: s.open, flags: { haul: whSettings.haul === true, raid: whSettings.raid === true,
        contracts: whSettings.contracts === true },
      index: st.index === undefined ? null : st.index,
      totals: { lootIsk: s.lootIsk, gasIsk: s.gasIsk, cargoIsk: s.cargoIsk, piIskTotal: s.piIskTotal,
        soldIskTotal: s.soldIskTotal, homeDone: s.homeDone, haulDone: s.haulDone, raidDone: s.raidDone },
      counters, rows: read.wh.rows.map((r) => whRowOf(r, systemName)), truncated: read.wh.truncated };
  }

  function getData() {
    if (call(() => store.isOpen(), false) !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const now0 = call(nowOf, 0);
    const tx = store.transaction("observer.freeCorps", (db) => {
      const list = repository.listForViewInTx(db, { limit: maxRows });
      if (!list.ok) return list;
      const counts = repository.countsForViewInTx(db);
      if (!counts.ok) return counts;
      let ventures = null;
      if (ventureRepository) {
        const vl = ventureRepository.listOpenForViewInTx(db, { limit: maxRows });
        if (!vl.ok) return vl;
        const vc = ventureRepository.countsForViewInTx(db);
        if (!vc.ok) return vc;
        ventures = { rows: vl.rows, truncated: vl.truncated, counts: vc.rows };
      }
      let wars = null;
      if (warRepository) {
        const wl = warRepository.listForViewInTx(db, { limit: maxRows });
        if (!wl.ok) return wl;
        const rs = warRepository.recentSkirmishesInTx(db, { limit: RECENT_SKIRMISHES });
        if (!rs.ok) return rs;
        const ls = warRepository.countSkirmishesSinceInTx(db, Math.max(0, now0 - DAY_MS));
        if (!ls.ok) return ls;
        wars = { rows: wl.rows, truncated: wl.truncated, recent: rs.rows,
          last24h: { count: ls.count, byOutcome: ls.byOutcome } };
      }
      let killmails = null;
      if (outboxRepository) {
        const st = outboxRepository.statsInTx(db, { kind: KM_KIND, since: Math.max(0, now0 - DAY_MS) });
        if (!st.ok) return st;
        const rc = outboxRepository.recentInTx(db, { kind: KM_KIND, limit: RECENT_KILLMAILS });
        if (!rc.ok) return rc;
        killmails = { stats: st, recent: rc.rows };
      }
      let contracts = null;
      if (contractRepository) {
        const st = contractRepository.statsInTx(db, { since: Math.max(0, now0 - DAY_MS) });
        if (!st.ok) return st;
        const rc = contractRepository.recentInTx(db, { limit: RECENT_CONTRACTS });
        if (!rc.ok) return rc;
        contracts = { stats: st, recent: rc.rows, courier: null };
        if (call(courierMode, null) !== null) {
          const cs = contractRepository.courierStatsInTx(db, { since: Math.max(0, now0 - DAY_MS) });
          if (!cs.ok) return cs;
          contracts.courier = cs;
        }
      }
      let recycle = null;
      if (membersRepository) {
        const st = membersRepository.statsInTx(db);
        if (!st.ok) return st;
        const rc = membersRepository.recentInTx(db, { limit: RECENT_MEMBERS });
        if (!rc.ok) return rc;
        recycle = { stats: st, recent: rc.rows };
      }
      let structures = null;
      if (structureRepository) {
        const st = structureRepository.statsInTx(db, { since: Math.max(0, now0 - DAY_MS) });
        if (!st.ok) return st;
        const rc = structureRepository.recentInTx(db, { limit: RECENT_STRUCTURES });
        if (!rc.ok) return rc;
        structures = { stats: st, recent: rc.rows };
      }
      let wh = null;
      if (whRepository) {
        const wl = whRepository.listOpenForViewInTx(db, { limit: maxRows });
        if (!wl.ok) return wl;
        const ws = whRepository.statsForViewInTx(db);
        if (!ws.ok) return ws;
        wh = { rows: wl.rows, truncated: wl.truncated, stats: ws };
      }
      return { ok: true, rows: list.rows, truncated: list.truncated, counts: counts.rows, ventures, wars, killmails,
        contracts, recycle, structures, wh };
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    const status = call(deps.getStatus, null) || {};
    const systemName = systemNameOf();
    const now = call(nowOf, 0);
    return { available: true, state: status.state || "unknown", counters: status.counters || {},
      population: status.population || null, ownerCharacters: status.ownerCharacters || null,
      byState: tallyOf(read.counts, "state"), byArchetype: tallyOf(read.counts, "archetype"),
      byBand: tallyOf(read.counts, "secBand"), rows: read.rows.map((r) => rowOf(r, systemName, now)),
      truncated: read.truncated, ventures: venturesOf(read, systemName), wars: warsOf(read, systemName),
      killmails: killmailsOf(read), contracts: contractsOf(read), recycle: recycleOf(read),
      structures: structuresOf(read), ...(read.wh ? { whCorps: whCorpsOf(read, systemName, status) } : {}) };
  }

  function cacheKey() {
    return `fc-w${call(deps.getWriteVersion, 0)}`;
  }

  return { title: "Free Corporations", order: VIEW_ORDER, listed: true, getData, cacheKey };
}

function registerFreeCorpsView(deps) {
  const views = deps && deps.views;
  if (!views || typeof views.registerView !== "function") return null;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const def = buildFreeCorpsView(deps);
  const r = call(() => views.registerView(VIEW_ID, def), null);
  if (r && r.ok) return r;
  log(`view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
  return null;
}

module.exports = { VIEW_ID, VIEW_ORDER, ROW_KEYS, VENTURE_ROW_KEYS, WAR_ROW_KEYS, SKIRMISH_ROW_KEYS, KM_ROW_KEYS,
  CT_ROW_KEYS, RC_ROW_KEYS, ST_ROW_KEYS, WH_ROW_KEYS, buildFreeCorpsView, registerFreeCorpsView };
