# tools/downtime — data copy "aged" by N days

Offline tool. It is not part of the mod runtime.

## What it does

`ageDataCopy.js` takes an **unpacked** volume backup (a directory with `gameStore/` and `mods/`), copies the whole tree to a **new** directory and, in the copy, moves every absolute time back by `N × 86 400 000 ms`. A server started on such a copy behaves like a start after N days of downtime.

- gameStore (`gameStore/gamestore.sqlite`), tables `scheduledJobs`, `dynamicResourceRuntime`, `sovereignty` (change the list with `--vendor-tables a,b,c`):
  - a number under a key ending in `Ms` inside the window `[2020-01-01, 2100-01-01)` → `− Δ`,
  - a FILETIME inside the window (a string of 17–18 digits or a number ≥ 1e17) → `− Δ × 10 000` (a string stays a string).
- LNE (`mods/livingNewEden/world.sqlite`), all user tables: INTEGER columns named `…_at`, `…_until`, `…_at_ms`, `…_until_ms` with a value inside the window → `− Δ`. One `UPDATE` per table shifts all time columns at once, so a `CHECK` between two time columns never sees a half-shifted row.
- Unchanged: row keys, `jobID`, `captureEpoch`, `generation`, settlement IDs, LNE TEXT/JSON columns, durations (`durationMs`, `travel_ms`), `0`, `"0"`, `NULL`, the tables `_persistence_*` and `_migrations`.
- The source (`--src`) is only copied. The tool never opens it as a database.
- At the end the copy gets `lne-aged-copy.json`. This file blocks a second ageing of the same copy (`ALREADY_AGED`).

## Usage

```
node mods/livingNewEden/tools/downtime/ageDataCopy.js --src <dir> --out <dir> --days <1..365>
     [--dry-run] [--server <serverDir>] [--vendor-tables a,b,c]
     [--gamestore <rel>] [--world <rel>] [--json <file>]
```

- `--days` is required (1..365).
- `--dry-run`: copies only the two SQLite files to a temporary directory, ages them, prints the report and removes the directory. It does not create `--out` (so `--out` is not needed).
- `--gamestore` / `--world`: paths of the two databases relative to `--src`, when they differ from the defaults above.
- Driver: the server's better-sqlite3 (`--server`), otherwise `node:sqlite` (Node ≥ 22.5).
- Output: markdown on stdout, JSON in `--json`. The report contains only table names, key paths, columns, job types and counts.
- Exit: `0` OK, `1` usage, `2` refusal, `3` failure.

| reason | when | exit |
|---|---|---|
| `LIVE_DATA_ROOT` | `--src`, `--out` or `--json` inside `EVEJS_DATA_ROOT` | 2 |
| `LIVE_VOLUME_PATH` | a path inside `/var/lib/evejs` | 2 |
| `OUT_EXISTS` | `--out` exists | 2 |
| `PATH_OVERLAP` | `--out` inside `--src` or the other way round, `--json` inside `--src` | 2 |
| `SRC_INCOMPLETE` | `<src>/gameStore/gamestore.sqlite` is missing | 2 |
| `ALREADY_AGED` | `<src>/lne-aged-copy.json` exists | 2 |
| `OUTBOX_PENDING` | `_persistence_outbox` has a `pending` row for a listed table (copy removed) | 2 |
| `SCHEMA_DRIFT` | a listed table lacks the columns `key`, `json` (copy removed) | 3 |
| `CHECK_FAILED` | a constraint failed in an LNE `UPDATE`, table name in the message (copy removed) | 3 |
| `NO_SQLITE_DRIVER` | no SQLite driver | 3 |

Warnings (no refusal): `LNE_DB_MISSING`, `OWNER_ACTIVE` (backup taken without a clean stop), `TABLE_MISSING:<t>`, `ROW_UNPARSED:<t>:<n>`.

A copy error (for example a full disk or a locked file) gives exit 3 (`FAILED`). The tool then removes `--out` or the temporary `lne-age-*` directory. If the directory cannot be removed, the error message ends with `OUT_NOT_REMOVED <path>`; remove that directory by hand. Interrupting the process (for example Ctrl+C) leaves a partial `--out`; remove it and run the tool again. The copy needs disk space of twice the backup size (`src` and `out`).

## Report

- `jobs.byType`: `total`, `dueAfter` (jobs with `dueAtMs <= now` after the shift = an approximation of `scheduler.due` in the first worker pass), `staleIdentity` (the jobID contains the old time, for example ESS `…:${dueAtMs}`). Old jobIDs are kept, so at boot ESS can have up to 2 jobs per (system, kind), and sov ticks whose jobID is based on `vulnerableStartMs` report `stale: true`. The load is therefore higher than after a real downtime.
- `suspects` (gameStore) and `lneSuspects` (LNE): numbers inside the ms window that no rule covers. They are not changed. If such a column looks like a time, the copy does not model the downtime correctly; do not use it until the rule covers that column.

## Example: boot after a long downtime (Docker)

The database copies stay local (keep them out of git and out of external services).

1. Take a fresh backup: `docker compose stop server market`, then tar the `evejs-data` volume to `_backup/evejs-data-$stamp.tgz` (see the backup section of the mod README). This is the restore point.
2. `mkdir _local\aged\src` → `tar -xzf _backup\evejs-data-$stamp.tgz -C _local\aged\src`.
3. Preview: `node mods\livingNewEden\tools\downtime\ageDataCopy.js --src _local\aged\src --days 30 --dry-run > _local\aged\dry.md`. Check `jobs.byType` and `suspects` / `lneSuspects`.
4. Ageing: the same without `--dry-run`, with `--out _local\aged\out --json _local\aged\age.json`. Exit 0; `out` contains `lne-aged-copy.json`. Inside the image: `docker run --rm -v "${PWD}:/w" evejs-local node /w/mods/livingNewEden/tools/downtime/ageDataCopy.js --src /w/_local/aged/src --out /w/_local/aged/out --days 30 --server /app/server`.
5. `tar -czf _backup\evejs-data-aged30-$stamp.tgz -C _local\aged\out .`.
6. Restore `evejs-data-aged30-$stamp.tgz` into the volume (a restore from backup; it replaces the current state).
7. Note `T0`, run `docker compose up -d`, then `docker compose ps server` every 10 s until `healthy` (`T1`).
8. `docker compose logs server > _local\aged\boot.log` and look for `boot_rejected`, `AUTHORITY_REQUEST_TIMEOUT`, `timed out after`, and for the scheduler catch-up lines (`scheduler: catch-up start`).
9. Go back: `docker compose stop server market` → restore the backup from step 1 → `docker compose up -d` → `healthy`. The aged world does not stay on the server. Clean up with `rmdir /s /q _local\aged`.
