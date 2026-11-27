"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../../config");
const { fieldEligible, planSalvageDispatches } = require("../../../lib/strategy/capsuleers/salvageRules");
const { decideStep } = require("../../../lib/strategy/capsuleers/tripMachine");
const { salvageTimes } = require("../../../lib/fleets/salvageOps");

const CAPS = 500018;
const AMARR = 500003;
const CORP_ID = 98000001;
const BASE = 100;
const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const SALVAGE = Object.freeze({ ...config.resolveConfig({ modDir: MOD_DIR, env: {} }).config.salvage });
const RULES = Object.freeze({ salvageParams: SALVAGE, capsuleerFactionId: CAPS });
const AT = 1000000;

const fieldOf = (over = {}) => ({ fieldId: "wf-1", systemId: 300, winnerFactionId: null, shipsLost: 6,
  state: "ACTIVE", expiresAt: AT + 3600000, materializedAt: null, ...over });
const cand = (over = {}) => ({ field: fieldOf(), job: null, jobKnown: true, pool: 10, jumps: 2, at: AT, ...over });

const fleet = (fleetId, over = {}) => ({ fleetId, factionId: CAPS, corporationId: CORP_ID, fleetRole: "capsuleer",
  state: "IDLE", currentSystemId: BASE, refitPending: false, version: 3, ...over });
const CORPS = Object.freeze([{ corpSlot: 1, state: "ACTIVE", corporationId: CORP_ID, baseSystemId: BASE }]);
const FIELDS = Object.freeze([{ fieldId: "wf-a", systemId: 300, jumps: 1, pool: 20 },
  { fieldId: "wf-b", systemId: 301, jumps: 2, pool: 10 }]);
const snapOf = (over = {}) => ({ corps: CORPS, fleets: [fleet("f-a"), fleet("f-b")], fleetsTruncated: false,
  openTripFleetIds: new Set(), openFieldIds: new Set(), fieldsBySlot: new Map([[1, FIELDS.slice(0, 1)]]), ...over });
const PLAN = Object.freeze({ salvageEnabled: true, maxSalvageDispatchesPerReview: 8 });

const trip = (state, over = {}) => ({ tripId: "ct_1", state, kind: "salvage", baseSystemId: BASE,
  targetSystemId: 300, outboundOperationId: "op_out", returnOperationId: null, watchRound: 0, waitRound: 0,
  abortReason: null, fieldId: "wf-1", ...over });
const inTarget = { fleetId: "f-a", state: "STAGED", currentSystemId: 300, operationId: "op_out", version: 4 };
const facts = (over = {}) => ({ at: AT, trigger: "due", hostiles: false, controlled: true, fieldAlive: true,
  tooLate: false, ...over });

module.exports = ({ test }) => {
  test("CSV1 salvage rules: fieldEligible + planSalvageDispatches (one fleet per field, limit, skips)",
    () => {
      const t = salvageTimes(SALVAGE, { jumps: 2, shipsLost: 6 });
      assert.ok(t.ok, JSON.stringify(t));
      const reason = (c) => {
        const r = fieldEligible(c, RULES);
        return r.ok ? "ok" : r.reason;
      };
      const got = {
        noWinner: reason(cand()),
        caps: reason(cand({ field: fieldOf({ winnerFactionId: CAPS }) })),
        noHome: reason(cand({ field: fieldOf({ winnerFactionId: AMARR }), job: { state: "FAILED" } })),
        faction: reason(cand({ field: fieldOf({ winnerFactionId: AMARR }) })),
        jobActive: reason(cand({ field: fieldOf({ winnerFactionId: AMARR }), job: { state: "OUTBOUND" } })),
        materialized: reason(cand({ field: fieldOf({ materializedAt: AT - 1 }) })),
        empty: reason(cand({ pool: 0 })),
        tooLate: reason(cand({ field: fieldOf({ expiresAt: AT + t.travelMs + t.recoveryMs }) })),
        justInTime: reason(cand({ field: fieldOf({ expiresAt: AT + t.travelMs + t.recoveryMs + 1 }) })),
        noRepoFaction: reason(cand({ field: fieldOf({ winnerFactionId: AMARR }), jobKnown: false })),
        noRepoCaps: reason(cand({ field: fieldOf({ winnerFactionId: CAPS }), jobKnown: false })),
      };

      const ids = (plan) => plan.map((d) => [d.fleetId, d.fieldId, d.targetSystemId, d.kind]);
      got.twoFleets = ids(planSalvageDispatches(snapOf(), PLAN));
      got.openField = ids(planSalvageDispatches(snapOf({ openFieldIds: new Set(["wf-a"]) }), PLAN));
      got.limit = ids(planSalvageDispatches(snapOf({ fieldsBySlot: new Map([[1, FIELDS]]) }),
        { ...PLAN, maxSalvageDispatchesPerReview: 1 }));
      got.both = ids(planSalvageDispatches(snapOf({ fieldsBySlot: new Map([[1, FIELDS]]) }), PLAN));
      got.skipped = ids(planSalvageDispatches(snapOf({ fleets: [fleet("f-m", { fleetRole: "mercenary" }),
        fleet("f-o", { currentSystemId: 999 }), fleet("f-r", { refitPending: true }),
        fleet("f-t", { state: "STAGED" })], fieldsBySlot: new Map([[1, FIELDS]]) }), PLAN));
      got.busy = ids(planSalvageDispatches(snapOf({ openTripFleetIds: new Set(["f-a"]) }), PLAN));
      got.truncated = planSalvageDispatches(snapOf({ fleetsTruncated: true }), PLAN);
      got.off = planSalvageDispatches(snapOf(), { ...PLAN, salvageEnabled: false });

      assert.deepStrictEqual(got, {
        noWinner: "ok", caps: "ok", noHome: "ok", faction: "FACTION_FIELD", jobActive: "JOB_ACTIVE",
        materialized: "MATERIALIZED", empty: "EMPTY", tooLate: "TOO_LATE", justInTime: "ok",
        noRepoFaction: "FACTION_FIELD", noRepoCaps: "ok",
        twoFleets: [["f-a", "wf-a", 300, "salvage"]],
        openField: [],
        limit: [["f-a", "wf-a", 300, "salvage"]],
        both: [["f-a", "wf-a", 300, "salvage"], ["f-b", "wf-b", 301, "salvage"]],
        skipped: [],
        busy: [["f-b", "wf-a", 300, "salvage"]],
        truncated: [],
        off: [],
      });
    });

  test("CSV2 decideStep of a salvage trip: salvageCheck in OUTBOUND / RATTING, COLLECT; rat unchanged", () => {
    const P = { maxWatchRounds: 12 };
    const act = (t, f) => {
      const d = decideStep(t, inTarget, f, P);
      return d.reason ? `${d.action} ${d.reason}` : d.action;
    };
    const cases = {
      hostiles: facts({ hostiles: true }), gone: facts({ fieldAlive: false }), noRepo: facts({ fieldAlive: null }),
      tooLate: facts({ tooLate: true }), rest: facts(),
    };
    const got = { outbound: {}, ratting: {}, rat: {} };
    for (const [name, f] of Object.entries(cases)) got.outbound[name] = act(trip("OUTBOUND"), f);
    got.ratting = { nudge: act(trip("RATTING"), facts({ trigger: "arrival" })), due: act(trip("RATTING"), facts()),
      gone: act(trip("RATTING"), facts({ fieldAlive: false })), tooLate: act(trip("RATTING"), facts({ tooLate: true })) };
    for (const [name, f] of Object.entries(cases)) {
      got.rat[name] = [act(trip("OUTBOUND", { kind: "rat", fieldId: null }), f),
        act(trip("RATTING", { kind: "rat", fieldId: null }), f)];
    }
    assert.deepStrictEqual(got, {
      outbound: { hostiles: "RETURN HOSTILES", gone: "RETURN FIELD_GONE", noRepo: "RETURN WRECKS_UNAVAILABLE",
        tooLate: "RETURN TOO_LATE", rest: "START_RATTING" },
      ratting: { nudge: "IGNORE RATTING", due: "COLLECT", gone: "RETURN FIELD_GONE", tooLate: "COLLECT" },
      rat: { hostiles: ["RETURN HOSTILES", "RETURN HOSTILES"], gone: ["START_RATTING", "RAT"],
        noRepo: ["START_RATTING", "RAT"], tooLate: ["START_RATTING", "RAT"], rest: ["START_RATTING", "RAT"] },
    });
  });
};
