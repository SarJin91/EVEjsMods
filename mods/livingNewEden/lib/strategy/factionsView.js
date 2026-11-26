"use strict";

const VIEW_ID = "factions";
const VIEW_ORDER = 50;
const WORK_CLASS = "MAINTENANCE";
const STABLE = "STABLE";

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function buildFactionsView(deps) {
  const { store, repository, registry } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const factionNames = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const aiMemory = (f) => {
    try {
      return typeof deps.getAiMemory === "function" ? deps.getAiMemory(f) : null;
    } catch (_err) {
      return null;
    }
  };
  const treasury = () => {
    try {
      const t = typeof deps.getTreasury === "function" ? deps.getTreasury() : null;
      return t && typeof t.listForPanel === "function" && typeof t.getMode === "function" && t.getMode() === "run"
        ? t : null;
    } catch (_err) {
      return null;
    }
  };
  const aiSeq = () => {
    try {
      return typeof deps.getAiSeq === "function" ? deps.getAiSeq() : 0;
    } catch (_err) {
      return 0;
    }
  };

  function hasOwnSpace(row, def) {
    if (typeof registry.getDoctrine !== "function") return true;
    const doctrine = registry.getDoctrine(row.doctrineId) || (def ? registry.getDoctrine(def.doctrineId) : null);
    return !doctrine || (doctrine.ownSpace !== null && doctrine.ownSpace !== undefined);
  }

  function admitted() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function systemName(id) {
    const res = deps.graph && typeof deps.graph.getGraph === "function" ? call(deps.graph, "getGraph") : null;
    const vertex = res && res.ok === true && res.graph ? res.graph.getSystem(id) : null;
    return vertex ? vertex.name : null;
  }

  function campaignRow(campaign, st) {
    const entry = (st.campaigns || []).find((c) => c.campaignId === campaign.campaignId) || null;
    let ownerControlled = null;
    let unstable = null;
    const world = deps.world;
    if (world && typeof world.getSystems === "function") {
      const r = world.getSystems([...campaign.systemIds], { includeInfluence: false });
      if (r && r.ok) {
        ownerControlled = r.systems.filter((s) => s.controllerFactionId === campaign.ownerFactionId).length;
        unstable = r.systems.filter((s) => s.occupationState !== STABLE).length;
      }
    }
    return {
      campaignId: campaign.campaignId,
      owner: campaign.ownerFactionId,
      systems: campaign.systemIds.length,
      ecc: entry && entry.check ? entry.check.eccentricity : null,
      ownerControlled,
      unstable,
      status: entry ? entry.state : "inactive",
      reason: entry ? entry.reason : null,
    };
  }

  function corporationRef(corporationId) {
    if (corporationId === null || corporationId === undefined) return null;
    let corp = null;
    try {
      corp = typeof registry.getCorporation === "function" ? registry.getCorporation(corporationId) : null;
    } catch (_err) {
      corp = null;
    }
    return { id: corporationId, name: corp && typeof corp.name === "string" ? corp.name : null };
  }

  function roleCorporations(def) {
    const roles = def && def.corporationRoles ? def.corporationRoles : {};
    return Object.fromEntries(Object.keys(roles).sort().map((role) => [role, corporationRef(roles[role])]));
  }

  function upkeepRow(r, memory) {
    const u = memory && memory.upkeep ? memory.upkeep : null;
    return {
      paidUntil: r.upkeepPaidUntil === undefined ? null : r.upkeepPaidUntil,
      unpaidPeriods: r.upkeepUnpaidPeriods || 0,
      totals: { income: r.incomeTotal || 0, upkeep: r.upkeepTotal || 0, unpaid: r.upkeepUnpaidTotal || 0,
        tradeFunded: r.tradeFundedTotal || 0 },
      perPeriod: u ? { income: u.income, cost: u.cost, net: u.income - u.tradeUnits - u.cost,
        reserveIncome: u.reserveIncome, tradeUnits: u.tradeUnits, offensiveAllowed: u.offensiveAllowed,
        round: u.round,
        ...(u.homeIncome === undefined ? {} : { homeIncome: u.homeIncome }),
        ...(u.shipRoom === undefined ? {} : { shipRoom: u.shipRoom }) } : null,
    };
  }

  function treasuryRow(x) {
    if (!x) return null;
    return { ...x.treasury, today: x.today, yesterday: x.yesterday, avg7dNetIsk: x.avg7dNetIsk,
      forecast: x.forecast };
  }

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const tx = store.transaction("observer.factions", (db) => repository.listFactions(db));
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    const st = call({ getStatus: deps.getStatus }, "getStatus") || {};
    const active = new Set((st.campaigns || []).map((c) => c.campaignId));
    const tre = treasury();
    const panel = tre ? call(tre, "listForPanel") : null;
    const treasuryOf = new Map(panel && panel.ok === true ? panel.rows.map((x) => [x.factionId, x]) : []);
    const rows = read.records.map((r) => {
      const def = registry.getFaction(r.factionId);
      const stations = def ? def.startStations : [];
      return {
        factionId: r.factionId,
        name: factionNames.get(r.factionId) || null,
        kind: def ? def.kind : null,
        corporation: def ? corporationRef(def.ownerCorporationId) : null,
        roleCorporations: roleCorporations(def),
        status: r.status,
        base: r.homeSystemId === null ? null : (systemName(r.homeSystemId) || r.homeSystemId),
        resources: r.resourceUnits,
        reserves: r.reserveUnits,
        frontLimit: r.frontLimit,
        doctrine: r.doctrineId,
        campaigns: registry.getCampaignsForFaction(r.factionId).map((c) => c.campaignId).filter((id) => active.has(id)),
        startStations: { npc: stations.filter((s) => s.kind === "npc").length,
          upwell: stations.filter((s) => s.kind === "upwell").length },
        inRegistry: def !== null,
        fronts: aiMemory(r.factionId) && aiMemory(r.factionId).fronts ? aiMemory(r.factionId).fronts : null,
        borderSystems: !hasOwnSpace(r, def) ? null
          : aiMemory(r.factionId) && aiMemory(r.factionId).borderSystems !== undefined
            ? aiMemory(r.factionId).borderSystems : null,
        upkeep: upkeepRow(r, aiMemory(r.factionId)),
        treasury: treasuryRow(treasuryOf.get(r.factionId)),
        lastReview: aiMemory(r.factionId) ? { round: aiMemory(r.factionId).round,
          outcome: aiMemory(r.factionId).outcome,
          target: aiMemory(r.factionId).target ? aiMemory(r.factionId).target.systemId : null,
          notes: aiMemory(r.factionId).notes } : null,
      };
    });
    return {
      available: true,
      state: st.state || null,
      reason: st.reason || null,
      seed: st.seed || null,
      registryVersion: { factions: registry.version.factions, doctrines: registry.version.doctrines,
        campaigns: registry.version.campaigns },
      factions: rows,
      campaigns: registry.listCampaigns().filter((c) => active.has(c.campaignId)).map((c) => campaignRow(c, st)),
    };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    const st = call({ getStatus: deps.getStatus }, "getStatus") || {};
    const worldRepo = deps.world && deps.world.repository;
    const worldChanges = worldRepo && typeof worldRepo.getChangeCount === "function" ? worldRepo.getChangeCount() : 0;
    const tre = treasury();
    const tk = tre ? `|t${call(tre, "getChangeCount") || 0}.${call(tre, "getSeq") || 0}.${call(tre, "getDay")}` : "";
    return `s${repository.getChangeCount()}|${st.seq === undefined ? 0 : st.seq}|${worldChanges}|a${aiSeq()}${tk}`;
  }

  return { title: "Factions", order: VIEW_ORDER, cacheKey, getData };
}

module.exports = { VIEW_ID, buildFactionsView };
