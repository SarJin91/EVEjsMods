# Mining Capital Measurement Tool

**Living New Eden** — `tools/measure/mining-capital.js`

Standalone measurement script for the effectiveness of mining capital fleets (Rorqual, Porpoise, Orca) in LNE systems. It reads a read-only copy of `world.sqlite` and prints metrics per faction, with a PASS/FAIL hint for the related config keys.

---

## Prerequisites

- Node.js with `better-sqlite3` resolvable from the tool folder. The package ships with the server (`server/node_modules`), so on the host run with `NODE_PATH=server/node_modules`.
- A **read-only copy** of the production `world.sqlite` (with `-wal` and `-shm` if present).

> **Important**: never run against the live database. Copy it first (the server keeps running):
> ```bash
> docker compose cp server:/var/lib/evejs/mods/livingNewEden/world.sqlite /tmp/xb/world.sqlite
> docker compose cp server:/var/lib/evejs/mods/livingNewEden/world.sqlite-wal /tmp/xb/ 2>/dev/null || true
> docker compose cp server:/var/lib/evejs/mods/livingNewEden/world.sqlite-shm /tmp/xb/ 2>/dev/null || true
> ```

The metrics are meaningful once these flags have been on for the whole measurement window:
- `production.capitalLadderEnabled=1`
- `production.minerPriorityEnabled=1`
- `production.industryEnabled=1` (default true)

---

## Usage

```bash
node mods/livingNewEden/tools/measure/mining-capital.js <db-path> --since <ms> [--json] [--top <n>]
```

### Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<db-path>` | Yes | Path to the read-only SQLite database copy |
| `--since <ms>` | Yes | Lower bound timestamp (milliseconds since epoch) for `ended_at` / `created_at`. A positive integer; the window must be at least 48 h, so the tool refuses (exit 1) a value less than 48 h (172800000 ms) before the current time. |
| `--json` | No | Machine-readable JSON output (default: ASCII table) |
| `--top <n>` | No | Top N belts per faction for detail (default: 5) |
| `--help`, `-h` | No | Print the usage and exit 0 |

Exit: `0` OK, `1` bad arguments, `--since` refused, or a database error.

### Example

```bash
# 49 hours ago in milliseconds
SINCE_MS=$(( $(date +%s) * 1000 - 176400000 ))
NODE_PATH=server/node_modules node mods/livingNewEden/tools/measure/mining-capital.js /tmp/xb/world.sqlite --since $SINCE_MS --json > /tmp/mining-capital-measure.json
```

---

## Output Format (JSON)

```json
{
  "scenario": "mining-capital-measure",
  "durationMinutes": 720,
  "iskPerHour": { "500001": 123456789 },
  "orePerHour": { "highsec": { "500001": 1000000 }, "lowsec": { "500001": 2000000 }, "nullsec": { "500001": 5000000 } },
  "riskScore": { "500001": 0.15 },
  "factionEconomyImpact": { "500001": { "treasuryDrain": 12345, "mineralUnitsPerDay": 50000 } },
  "M1_tripsPerFleetPerDay": { "500001": 6.2 },
  "M2_boosterSharePermille": { "500001": 650 },
  "M2_bargeExhumerSharePermille": { "500001": 720 },
  "M2_avgMinersPerFleet": { "500001": 10.5 },
  "M3_mineralUnitsPerDay": { "500001": 50000 },
  "M3_mineralUnitsPerDayBySec": { "500001": { "highsec": 10000, "lowsec": 15000, "nullsec": 25000 } },
  "M3_bindingMineral": { "500001": "type:35" },
  "M4_industryJobLeadTimeMs": { "500001": 172800000 },
  "M4_industryNoMineralsPerDay": { "500001": 2 },
  "M4_industryJobCompletePerDay": { "500001": 3 },
  "M5_capitalLadderBufferPermille": { "500001": 850 },
  "daysToTitan": { "500001": { "highsec": 120, "lowsec": 45, "nullsec": 28 } },
  "daysToCarrier": { "500001": { "highsec": 25, "lowsec": 10, "nullsec": 6 } },
  "recommendations": {
    "500001": {
      "maxActiveIndustryJobsPerFaction": "PASS",
      "maxIndustryJobsPerReview": "PASS",
      "titanRecipePermille": "PASS",
      "supercarrierRecipePermille": "PASS",
      "maxFleetsPerFaction": "OK"
    }
  },
  "timestamp": "2026-11-08T12:00:00.000Z"
}
```

---

## Metrics Explained

### M1: Trips per Fleet per Day (`M1_tripsPerFleetPerDay`)
- **Source**: `world_mining_trips` where `state = 'DELIVERED'`
- **Formula**: `COUNT(*) / COUNT(DISTINCT fleet_id) / days_in_window`
- **PASS threshold**: ≥ 6
- **Interpretation**: how many mining cycles each fleet completes per day. Low values point to travel time issues, belt contention or idle fleets.

### M2: Fleet Composition (`M2_boosterSharePermille`, `M2_bargeExhumerSharePermille`, `M2_avgMinersPerFleet`)
- **Source**: `virtual_fleets.composition_json` for all faction fleets (not just `role=mining` — boosters may be `role=industry`)
- **boosterSharePermille**: ‰ of fleets with a Porpoise/Orca/Rorqual
- **bargeExhumerSharePermille**: ‰ of barge+exhumer ships per fleet
- **avgMinersPerFleet**: average mining ships (frigate/barge/exhumer) per mining fleet
- **PASS thresholds**: booster ≥ 500‰ (50%), barge+exhumer ≥ 600‰ (60%)

### M3: Mineral Yield per Day + Binding Mineral (`M3_mineralUnitsPerDay`, `M3_mineralUnitsPerDayBySec`, `M3_bindingMineral`)
- **Source**: `world_mining_totals.mineral_units` (total) + `world_mining_trips.delivered_json` per `sec_class`
- **mineralUnitsPerDay**: total mineral units delivered per day per faction
- **mineralUnitsPerDayBySec**: breakdown by highsec/lowsec/nullsec
- **bindingMineral**: the mineral with the lowest `(daily_yield / titan_recipe_requirement)` ratio — the bottleneck for titan production
- **PASS thresholds**: days to titan (nullsec) ≤ 30, days to carrier (nullsec) ≤ 7

### M4: Industry Lead Time (`M4_industryJobLeadTimeMs`, `M4_industryNoMineralsPerDay`, `M4_industryJobCompletePerDay`)
- **Source**: `world_production_jobs` for hull_group IN (porpoise, orca, rorqual) + journal notes
- **leadTimeMs**: time from the first Orca/Rorqual job `created_at` to its `DELIVERED` `ended_at`
- **industryNoMineralsPerDay**: count of `INDUSTRY_NO_MINERALS:*` notes per day (mineral starvation)
- **industryJobCompletePerDay**: count of `INDUSTRY_JOB_COMPLETE` notes per day
- **PASS threshold**: leadTimeMs ≤ 48 h (172800000 ms)

### M5: Capital Ladder Buffer Permille (`M5_capitalLadderBufferPermille`)
- **Source**: `world_station_stock` (minerals on ONLINE stations) vs an estimated buffer target
- **Formula**: `min(1000, mineral_stock / (target_fleets * avg_fleet_cost) * 1000)`
- **PASS threshold**: ≥ 800‰ (matches `ladderUnlockPermille`)

### Days to Titan / Carrier (`daysToTitan`, `daysToCarrier`)
- **Formula**: `recipe_minerals[binding] / (daily_mineral_yield * binding_share)`
- Per faction, per sec_class (highsec/lowsec/nullsec)
- Uses the generated recipes in `lib/economy/data/capitalRecipes.js`

### Risk Score (`riskScore`)
- **Formula**: `mining_fleets_destroyed / total_mining_trips` in the window
- Proxy for gank probability

### Faction Economy Impact (`factionEconomyImpact`)
- **treasuryDrain**: placeholder (needs historical resource_units)
- **mineralUnitsPerDay**: same as the M3 total

### ISK/h & Ore/h (`iskPerHour`, `orePerHour`)
- **iskPerHour**: `mineralUnitsPerDay * 100 ISK/unit / 24` (rough estimate)
- **orePerHour**: `world_mining_trips` ore_units (m³) per hour per sec_class

---

## Recommendations (PASS/FAIL/REVIEW)

| Config Key | PASS Condition |
|------------|----------------|
| `production.maxActiveIndustryJobsPerFaction` | boosterShare ≥ 50% |
| `production.maxIndustryJobsPerReview` | industryJobCompletePerDay > 0 |
| `production.titanRecipePermille` | daysToTitan(nullsec) ≤ 30 |
| `production.supercarrierRecipePermille` | daysToCarrier(nullsec) ≤ 7 |
| `mining.maxFleetsPerFaction` | boosterShare ≥ 80% AND daysToTitan > 30 → REVIEW, otherwise OK |

---

## Database Schema References

| Table | Purpose |
|-------|---------|
| `world_mining_trips` | Individual mining trips (state, sec_class, delivered_json, ended_at) |
| `world_mining_totals` | Aggregate mineral/ore counters per faction |
| `virtual_fleets` | Fleet compositions (composition_json), roles, state |
| `world_production_jobs` | Industry jobs (hull_group, created_at, ended_at, state) |
| `world_production_totals` | Aggregate job counters per faction |
| `world_station_stock` | Station inventory (minerals, hulls) |
| `world_stations` | Station ownership, state (ONLINE) |
| `world_event_journal` | AI notes (INDUSTRY_*, etc.) |
| `world_factions` | Active factions list |

---

## Performance

- Database: ~500k rows in `world_mining_trips` (55 h run)
- Runtime: < 30 seconds on a copied database
- Memory: < 200 MB (read-only, no heavy aggregation in JS)

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `SQLITE_BUSY` | WAL not copied / server writing | Copy `-wal` and `-shm`; the script opens with `readonly: true` and `busy_timeout = 5000` |
| `Cannot find module 'better-sqlite3'` | package not resolvable from the tool folder | Set `NODE_PATH=server/node_modules` (or the server's `node_modules` in the image) |
| Empty results | Window too short / flags not enabled | Make sure `capitalLadderEnabled=1` and `minerPriorityEnabled=1` were on for the whole window |
| `bindingMineral` always Tritanium | No nullsec mining | Check the `sec_class` distribution in trips; nullsec is needed for rare minerals |
| `leadTimeMs` null | No industry jobs for capital hulls | Check `production.industryEnabled=1` and `capitalLadderEnabled=1` |

---

## Related Files

- **Capital recipes**: `lib/economy/data/capitalRecipes.js` (generated by `tools/buildCapitalRecipes.js`)
- **Mining rates**: `lib/economy/mining/rates.js`, `lib/economy/mining/yield.js`
- **Config keys**: `config.js` (`production.maxActiveIndustryJobsPerFaction`, `production.maxIndustryJobsPerReview`, `production.titanRecipePermille`, `production.supercarrierRecipePermille`, `mining.maxFleetsPerFaction`)

---

## License

Part of the Living New Eden mod. See `CREDITS.md` for upstream sources.

---

# freeCorpsScaleReport (free corporations at scale)

Read-only tool: it reads the observer HTTP views, a copy of `world.sqlite`, and the text of `docker stats` and of the server log. It writes nothing to the server or the database.

Files: `freeCorpsScaleReport.js` (CLI), `freeCorpsScale/extract.js` (views → row, closed list `FIELDS`), `freeCorpsScale/aggregate.js` (`summarize`, `verdict`, `recommend`, thresholds `THRESHOLDS`, hold causes `HOLD_TABLE`), `freeCorpsScale/census.js` (counts from the database). Tests: `test/tools/freeCorpsScaleReport.test.js`.

## Commands

```
node mods/livingNewEden/tools/measure/freeCorpsScaleReport.js sample --label <L> --out <file.jsonl>
     [--minutes 1500] [--every-s 300] [--views-every-s 1800] [--base-url http://127.0.0.1:26410]
node mods/livingNewEden/tools/measure/freeCorpsScaleReport.js census [--snapshot] [--tmp-dir <dir>] --out <file.json> [--db <file>]
node mods/livingNewEden/tools/measure/freeCorpsScaleReport.js report --in <seg.jsonl> [--in ...] --target start|stretch
     [--phase core|pvp|full] [--step S0..S4] [--early] [--census-start f] [--census-end f] [--docker-start f]
     [--docker-end f] [--log f] [--audit f] [--prev report.json] [--threshold <path>=<n>] [--md f] [--json f]
```

- `sample` polls the observer views and appends one row per interval to `--out` (JSONL). `--out` must not exist: after every container restart use a new file (`seg1.jsonl`, `seg2.jsonl`, …) and pass them all to `report` with repeated `--in`. Stop it with SIGINT (`pkill -INT -f freeCorpsScaleReport.js`).
- `census` counts from the database. While the server runs the database is locked; use `--snapshot` (works on a copy, in `--tmp-dir`).
- `docker stats` files: `docker stats --no-stream --format "{{.Name}} {{.MemUsage}} {{.CPUPerc}}" > docker-t0.txt`.

Example of a full report at the end of a run:

```
node mods/livingNewEden/tools/measure/freeCorpsScaleReport.js report --in seg1.jsonl [--in seg2.jsonl] \
  --target start --phase pvp --step S0 --census-start census-t0.json --census-end census-t24.json \
  --docker-start docker-t0.txt --docker-end docker-t24.txt --log log.txt --audit audit-t24.json \
  --md report.md --json report.json
```

The next step uses the same report with `--target stretch --step SN --prev <report.json of the previous step>`.

## Rules and verdict

- A 30 min warm-up is discarded. Coverage = sum of gaps ≤ 2 × `everyS` inside one process; ≥ 20 h of steady state is required (`freeCorps.open ≥ 0.95 × targetCorps`); with `--early` ≥ 2 h.
- Tick = median of the p95 of disjoint windows. Module and vendor histograms = the worst window (a sparse histogram without a window of ≥ 20 samples: the p95 of the last row of each segment). Counters = `counterDelta` per segment.
- Gates G0–G13 + I1. A flag that is off, or a feature without code (`null`) = N/A. A flag that is on with a missing metric = FAIL.
- Verdict `GO` / `NO_GO` / `INCOMPLETE` (with `--early`: `CONTINUE` / `ABORT`). Recommendation: `NEXT Sn+1` (with the env lines), `HOLD` (cause from `HOLD_TABLE`; also a GO whose entry condition for the next step is not met, for example S4 only with `fleets.active` max ≤ 790, threshold `entry.S4.fleetsActiveMax`), `REPEAT`, `DONE`. On a GO without phase `full`, the line `ENTRY S2` reminds that `freeCorps.contracts.enabled`, `freeCorps.recycle.enabled` and `freeCorps.structures.enabled` stay off in S2.
- G8: `capsuleers.fleetBudgetEnabled` on without the gauge `capsuleers.fleets` = FAIL.
- `--threshold <path>=<number>` overrides a threshold, for example `--threshold G2.start.p95Ms=5` (existing leaves only).
- Exit: 0 (also NO_GO / INCOMPLETE / ABORT), 1 usage / missing file / `--out` exists, 2 refusal (database locked without `--snapshot`, not an LNE database), 3 tool failure (bad JSONL/JSON, no sqlite driver, unreadable copy).

---

# populationGateReport (10k population gate)

Read-only tool: it reads the observer HTTP views (`telemetry`, `status`, `population`) and the log text. It does not open the database.

Files: `populationGateReport.js` (CLI `sample` / `report`), `populationGate/extract.js` (views → row, closed lists `FIELDS`, `PROFILE_KEYS`), `populationGate/aggregate.js` (`summarizePhase`, `verdict`, thresholds `THRESHOLDS`, `withThreshold`), `populationGate/logScan.js` (UTF-8 / UTF-16LE with BOM, lines `: slow `). Tests: `test/tools/populationGateReport.test.js`.

```
node mods/livingNewEden/tools/measure/populationGateReport.js sample --label <0|A|B> --out <dir>/samples.jsonl
     [--minutes 125] [--every-s 30] [--views-every-s 300] [--base-url http://127.0.0.1:26410]
node mods/livingNewEden/tools/measure/populationGateReport.js report --phase 0=<dir> --phase A=<dir> --phase B=<dir>
     [--base A=0] [--threshold <name>=<n>] [--no-log] [--md f] [--json f]
```

Example:

```
node /app/mods/livingNewEden/tools/measure/populationGateReport.js sample --label A --out /var/lib/evejs/lne-bench/pop-A/samples.jsonl
node mods/livingNewEden/tools/measure/populationGateReport.js report --phase 0=pop-0 --phase A=pop-A --phase B=pop-B --md pop-gate.md --json pop-gate.json
```

- The phase role = the first character of the label (`0` base, `A` FAR, `B` LIVE; life cycle gate: `T`, `L`, `N`, see below). Steady state = `uptime` ≥ `warmupMin` (10 min).
- Flat thresholds: `--threshold passP95Ms=4`, `--threshold steadyMinA=15` and so on (existing names only).
- `--no-log` only for a liveSim trial: a missing `log.txt` = INFO, the verdict is at most `INCOMPLETE`.
- Exit: 0 (also NO_GO / INCOMPLETE), 1 usage / missing file / `--out` exists, 2 bad JSONL, 3 write failure.

## Life cycle gate (phases T / L / N)

Module `populationGate/lifecycle.js` (`summarizeTempo`, `lifecycleChecks`, pure). The run is meant for liveSim.

```
node mods/livingNewEden/tools/measure/populationGateReport.js report --phase T=life-T --phase L=life-L --phase N=life-N --md life-gate.md
```

- `T` (tempo): `--speed 100` and raised pass limits. It judges the model, not the cost. The row day = the panel's `generatedAt` (population clock = virtual time). Checks: `tempo days` (< `tempoMinDays` = `TOO_SHORT`), `lagMs p95` (> `tempoLagP95Ms` = `TEMPO_LAGGING`), `pilots constant` (FAIL `PILOTS_CHANGED`), in the window from `awayFromDay`: median `awayPermille` (FAIL out of range), `reborn per day` (WARN out of range), tempos INFO; growth of `wakeFailed` (FAIL), `rookieFallback` / `awayCapped` (WARN), `UNASSIGNED` ‰ (WARN), `corps open ratio` (WARN `CORPS_SHRINKING`; no `corps` block = `NO_CORPS`), `skipped candidates` INFO (skipped candidates, not inactive pilots). `passMs` = INFO. `log.txt` optional.
- `L` (with life cycle) and `N` (without): `--speed 1`, the cost block as in phases A/B (steady state `steadyMinL` / `steadyMinN`), `flushMs` = INFO. `log.txt` required (liveSim stdout); a `node:sqlite shim` line = WARN `SHIM_DRIVER` (verdict unchanged). L: a `lifecycle` block in the panel (FAIL without it), growth of `wakeFailed` = 0. N: no `AWAY` and no `lifecycle` block in any panel row (FAIL `AWAY_WITH_FLAG_OFF`), `loadNormalized` INFO.
- Profile: T and L = `population.enabled`, `standings.enabled`, `corps.enabled`, `lifecycle.enabled`, `lifecycle.careerEnabled`, `lifecycle.corpsActivityEnabled` = true, `size` = the `size` threshold; N = the same with `lifecycle.enabled` false. No check of `context.enabled` or of the NEAR/LIVE flags.
- `verdict`: L is compared with N by default (`--base L=N`): governor, heap and `passMs p95 delta` (> `lifeDeltaP95Ms` = WARN, an indicative comparison). A missing role = `MISSING_PHASE tempo|lifecycle|nolife`; `0/A/B` together with `T/L/N` = `MIXED_GATES`.

| threshold | value | meaning |
|---|---|---|
| `steadyMinL`, `steadyMinN` | 30 | steady-state minutes of phases L, N (after `warmupMin` 10) |
| `tempoMinDays` | 25 | shortest phase T (virtual days) |
| `tempoLagP95Ms` | 300000 | p95 of `lagMs` in phase T |
| `awayFromDay` | 22 | from this day of phase T the AWAY share is a steady state |
| `awayMinPermille`, `awayMaxPermille` | 100, 250 | range of the AWAY share |
| `rebornMinPerDay`, `rebornMaxPerDay` | 5, 60 | range of new pilots per day |
| `unassignedMaxPermille` | 100 | pilots without a rank at the end of phase T |
| `corpsOpenMinRatio` | 0.5 | median `open` of the last quarter / max `open` |
| `lifeDeltaP95Ms` | 1 | `passMs` p95 L − N |
| `minTempoRows` | 3 | fewest panel rows in the steady-state window |

---

# heapGrowthReport (heap growth from game data)

The tool reads only a **copy** of `gamestore.sqlite` (unpacked from `_backup/evejs-data-*.tgz`) and optionally a copy of the mod's `world.sqlite` (`--world`). It opens the database read-only and sets `PRAGMA query_only = 1`. No server is needed. Driver: `better-sqlite3` from `<serverDir>/node_modules` (`--server`, default: the nearest `server/` above the file), otherwise `node:sqlite` (Node 24 and newer). A path under `/var/lib/evejs/` (the live volume) is refused.

Output: markdown on stdout, JSON in `--json` (without `--json` the JSON is at the end of stdout in a ```json block). Sections: `tables` (top N by JSON bytes), `dungeon` (origin `lne` / `lne_foreign` / `vendor:<siteOrigin>` × `lifecycleState` × persistent, age, `staleActive`, `terminalOld`, LNE orphans with `--world`, top 10 instances), `killmails` (NPC_ONLY / LNE_CHAR / PLAYER), `items` (receipts by key prefix, outcomes, items), `mail`, `notifications`, `npc`, `meta`. Age columns: `<1d / 1-7d / 7-30d / >30d / unknown`. The output has no personal data: only counts, sizes, origin and age; no names, titles, content or player character IDs.

```
node mods/livingNewEden/tools/measure/heapGrowthReport.js <gamestore.sqlite> [--world <world.sqlite>] [--server <dir>]
     [--now <ms>] [--json <out.json>] [--top <n=30>]
node mods/livingNewEden/tools/measure/heapGrowthReport.js --diff <a.json> <b.json> [--json <out.json>]
```

- `--now` default: the largest `timers.lastUpdatedAtMs` in `dungeonRuntimeState` (repeatable output for one copy).
- `--diff`: for every number `a`, `b`, `delta`, `perDay`; markdown = top 20 byte growths and top 20 row count growths. `b.now <= a.now` is refused.
- Exit: 0 OK, 1 bad argument, 2 refusal (missing file, `/var/lib/evejs/`, `b.now <= a.now`), 3 no SQLite driver or read error.
- Tests: `test/tools/heapGrowthReport.test.js` (synthetic database in a temporary directory).

## Example: growth between two backups (no server needed)

1. Pick two backups at least 3 days apart, for example `_backup/evejs-data-20261115-2138.tgz` and `_backup/evejs-data-202611201142.tgz`.
2. Check the paths in the archive: `tar -tzf _backup\evejs-data-202611201142.tgz | findstr /i "gamestore.sqlite world.sqlite"`.
3. Extract only those files (with `-wal`, if present) to a separate folder: `mkdir _local\heap\b2` and `tar -xzf _backup\evejs-data-202611201142.tgz -C _local\heap\b2 <path>/gamestore.sqlite <path>/gamestore.sqlite-wal <world-path>/world.sqlite`. The same for the older backup into `_local\heap\b1`. The copy folder must be writable (SQLite may create a `-shm` file next to a copy with `-wal`); this does not change the data.
4. Run the script on each copy:
   - A (Node 24 on the host, `node:sqlite`):
     `node mods\livingNewEden\tools\measure\heapGrowthReport.js _local\heap\b1\<path>\gamestore.sqlite --world _local\heap\b1\<world-path>\world.sqlite --json _local\heap\growth-b1.json > _local\heap\growth-b1.md`
   - B (image with the server's `better-sqlite3`):
     `docker run --rm -v "%cd%:/w" evejs-local node /w/mods/livingNewEden/tools/measure/heapGrowthReport.js /w/_local/heap/b1/<path>/gamestore.sqlite --world /w/_local/heap/b1/<world-path>/world.sqlite --server /app/server --json /w/_local/heap/growth-b1.json`
5. The same for `b2`, then `node mods\livingNewEden\tools\measure\heapGrowthReport.js --diff _local\heap\growth-b1.json _local\heap\growth-b2.json > _local\heap\growth-diff.md`.
6. `growth-diff.md` and the top 30 table of `growth-b2.md` show which tables and dungeon instances grow per day. The output has no personal data.
7. Delete the extracted copies: `rmdir /s /q _local\heap\b1 _local\heap\b2`. Database copies do not go to git or to external services.
