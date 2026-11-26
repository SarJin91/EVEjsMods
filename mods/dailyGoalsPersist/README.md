# Daily Goals Persist (EveJS loader mod)

Daily goal progress, claimed (`redeemed`) goals, pending reward settlements and
the Monthly Reward Track survive a server restart. Without this mod EveJS
0.12.9 writes the `dailyGoals` table to disk only once (the first write on an
empty table); everything after that lives only in memory.

## Why vanilla loses the state

- `gameStore.read("dailyGoals", "/")` returns the cache object itself
  (`server/src/gameStore/index.js`, `read`).
- `dailyGoalsState` mutates that object in place and writes it back with
  `database.write(TABLE_NAME, "/", { ...root, version })`
  (`services/dailyGoals/dailyGoalsState.js`, `readRoot` / `writeRoot`).
- `gameStore.write` compares the cache with the new value; they are deep-equal
  (same nested objects), so it returns early without marking the table dirty
  or scheduling a flush. Only `options.force === true` skips that check.

## What it does

1. **Persistence (S1).** Wraps the `write` export of `gameStore`: a root write
   (`"/"`) of the `dailyGoals` table gets `force: true`. That is the vanilla
   "value changed" branch: the table is marked dirty and flushed (2 s debounce,
   or at once where `dailyGoalsState` already calls `flushTableSync`). Every
   other table, row-path writes, transient writes and writes that already
   force are passed through untouched; the caller's options object is never
   modified.
2. **404 diagnostics (S2).** When the web gateway answers a daily-goal
   `RedeemRequest` with 404 (`redeemGoal` failed, then `claimMonthlyMilestone`
   failed), one line is logged:

   ```text
   [dailyGoalsPersist] redeem 404 char=140000005 uuid=<goal uuid> daily=GOAL_NOT_FOUND monthly=NOT_EARNED
   ```

   Rate-limited: one line per character + UUID + codes per interval, a global
   cap per interval, repeats shown as `(+N suppressed)`.

No game code is required at preload. A `Module._load` hook wraps the exports
when `gameStore/index.js` and `dailyGoalsState.js` load. A text probe of the
three vendor files runs first; if a seam changed (DRIFT) or an export is
missing at load, the mod logs `DRIFT ...` and stays inert: vanilla EveJS.

## Cost

A forced root write costs what a real change costs in vanilla: the next flush
re-serializes the `dailyGoals` rows and writes only rows that differ from the
last flushed copy. `dailyGoalsState` writes only after an actual change (goal
progress from a kill, mining cycle, jump, scan, salvage, LP or job install; a
redeem; a daily or monthly rollover), and the 2 s debounce coalesces bursts.
No extra throttle: skipping a forced write would lose that change again.

## Settings

Environment variables (a real variable wins over `mods/dailyGoalsPersist/.env`;
see `.env.example` for every key, default and range):

| Variable | Default | Meaning |
|---|---|---|
| `EVEJS_DAILY_GOALS_PERSIST` | `1` | whole mod on/off |
| `EVEJS_DAILY_GOALS_PERSIST_REDEEM_LOG` | `1` | 404 log line on/off |
| `EVEJS_DAILY_GOALS_PERSIST_LOG_INTERVAL_MS` | `60000` | per-key interval |
| `EVEJS_DAILY_GOALS_PERSIST_LOG_MAX_PER_INTERVAL` | `20` | global lines per interval |
| `EVEJS_DAILY_GOALS_PERSIST_LOG_MAX_KEYS` | `256` | remembered keys |

## Install

Docker: `docker/entrypoint.sh` preloads
`--require /app/mods/dailyGoalsPersist/loader.js` in both server blocks.
Native launcher: activate as a loader mod (`loader_rename`).


## Not covered

- The "phantom" Claim button (404 on a goal UUID from a previous period or an
  unearned milestone) is not fixed here; the S2 log line is there to tell the
  two cases apart first.
- Other vendor services with the same read-mutate-write pattern
  (`corpGoalsState`, `missionRewardSettlementState`) are not touched.
