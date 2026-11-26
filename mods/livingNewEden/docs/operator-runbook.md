# Operator runbook: Living New Eden

A document for the operator of a server in Docker. Every configuration key named here is described in the mod `.env.example`.

Rules:

- Run every command in the directory with `compose.yaml`.
- Mod state in the container: `/var/lib/evejs/mods/livingNewEden` (volume `evejs-data`).
- Do not write mod state into `/app/mods`.
- Write secrets (for example the webhook URL) only into the root `.env`. Do not commit them to the repository.

## 1. Start

1. Build the image: `docker compose build init`. Only the `init` service has `build:`. The `evejs-local` image is shared.
2. Start: `docker compose up -d`.
3. Check the log: `docker compose logs server | grep LivingNewEden`.

Expected lines:

- `ready (world process) v0.1.0 ...`: the mod runs in the world process.
- `probe passed (...)`: every EveJS symbol is in place.
- `services: telemetry=running persistence=running ...`: the state of the services. A service turned off by a flag has the state `disabled` with the reason `disabled_by_config`.

When the log shows `probe DRIFT` or `probe MISSING`, EveJS changed code the mod depends on. The services listed in `affects` do not start. See `docs/evejs-update.md`.

When the log shows `services not started - <reason>`, the mod world does not start. The game works as without the mod.

## 2. Flags

- Full list of keys and defaults: the mod `.env.example` (source: `SCHEMA` in `config.js`).
- Set the values for Docker in the root `.env` (next to `compose.yaml`). `compose.yaml` reads them as `${EVEJS_LNE_...:-<default>}`.
- After a change run `docker compose up -d server`. The mod reads the config only at start.
- Change one flag per restart. Watch the server for at least 1 h.
- Flag rollback: set `0` in the root `.env`, then `docker compose up -d server`.
- New features with the flag off: every `...enabled` key with default `false` in `.env.example`.
- Config preview without Docker: `node mods/livingNewEden/tools/effectiveConfig.js` (reads `compose.yaml`).

Turning off the whole mod without a rebuild (in `compose.override.yaml`, `services.server.environment`):

- `EVEJS_LNE_ENABLED: "0"`: the mod loads, the services do not start.
- `EVEJS_LNE_NO_INSTALL: "1"`: zero hooks.

## 3. Mod database copies

### 3.1 Cold archive (the only copy consistent with the gameStore)

1. Stop the writers: `docker compose stop server market`.
2. Archive the whole volume (PowerShell, `$stamp` = any date tag):
   `docker run --rm --entrypoint tar -v evejs-data:/data:ro -v "${PWD}/_backup:/backup" evejs-local czf "/backup/evejs-data-$stamp.tgz" --exclude=./sde --exclude=./downloads -C /data .`
   Always keep `world.sqlite` together with its `-wal` and `-shm` files.
3. Check the archive: `docker run --rm --entrypoint tar -v "${PWD}/_backup:/backup:ro" evejs-local tzvf "/backup/evejs-data-$stamp.tgz" | Select-String "sqlite"`.
4. Check the integrity of an unpacked copy (never of the live volume). The archive is unpacked to `/tmp/v` inside a throw-away container:
   `docker run --rm --entrypoint sh -v "${PWD}/_backup:/backup:ro" evejs-local -c "mkdir -p /tmp/v && tar xzf /backup/evejs-data-$stamp.tgz -C /tmp/v ./gameStore ./mods && node /app/mods/livingNewEden/tools/inspectGameStoreSchema.js /tmp/v/gameStore/gamestore.sqlite && node /app/mods/livingNewEden/tools/inspectGameStoreSchema.js /tmp/v/mods/livingNewEden/world.sqlite"`
   Expected: `"integrity": "ok"` for both files.
5. Start: `docker compose up -d`.

To restore the archive (PowerShell, `<stamp>` = the tag of the archive):

```powershell
$stamp = "<stamp>"
docker compose stop server market
# DESTRUCTIVE: checks the archive first; only then deletes everything in the evejs-data volume except sde and downloads and unpacks the archive
docker run --rm --entrypoint sh -v evejs-data:/data -v "${PWD}/_backup:/backup:ro" evejs-local -c `
  "set -e; test -s /backup/evejs-data-$stamp.tgz; tar tzf /backup/evejs-data-$stamp.tgz ./gameStore/manifest.json >/dev/null; find /data -mindepth 1 -maxdepth 1 ! -name sde ! -name downloads -exec rm -rf {} +; tar xzf /backup/evejs-data-$stamp.tgz -C /data"
if ($LASTEXITCODE -eq 0) {
  docker compose up -d
  docker compose logs --since 10m init server | Select-String "Existing game database found|Building the game database|cache ready"
} else {
  Write-Error "Restore failed - the server was not started. Check the archive and run the command again."
}
```

The `docker run` command replaces the whole current state of the volume (gameStore, mod databases, settings) and cannot be undone. Check the archive (steps 3 and 4) before you run it, and take a fresh archive of the current state first if you may want it back. The command stops without deleting anything when the archive is missing, empty or has no `gameStore/manifest.json`. After the restore, `init` must log `Existing game database found`; `Building the game database` means the restore did not work. At start the container finds the restored `gameStore/manifest.json` and does not rebuild the game database.

### 3.2 Online copy (flag `backup.enabled`, off by default)

- Turning it on: `EVEJS_LNE_BACKUP_ENABLED=1` in the root `.env`, then `docker compose up -d server`.
- Condition for flipping the default: 3 runs with p95 `finalStepMs` below `governor.emergencyMs`.
- Copies: `/var/lib/evejs/mods/livingNewEden/backups/world-YYYYMMDD-HHMMSSZ.sqlite` (UTC). Rotation keeps the 3 newest.
- List of copies: `docker compose exec server ls -l /var/lib/evejs/mods/livingNewEden/backups`.
- Checking a copy: `docker compose exec server node /app/mods/livingNewEden/tools/inspectGameStoreSchema.js /var/lib/evejs/mods/livingNewEden/backups/world-<stamp>.sqlite`. Expected: `"integrity": "ok"`.
- The online copy covers only the mod database. It does not cover the gameStore.

### 3.3 Restoring a mod copy

1. `docker compose stop server`.
2. `docker compose run --rm --no-deps --entrypoint sh server -c "cd /var/lib/evejs/mods/livingNewEden && rm -f world.sqlite-wal.pre-restore && cp world.sqlite world.sqlite.pre-restore && if [ -f world.sqlite-wal ]; then cp world.sqlite-wal world.sqlite-wal.pre-restore; fi && rm -f world.sqlite-wal world.sqlite-shm && cp backups/world-<stamp>.sqlite world.sqlite"`
3. `docker compose up -d`.

Always remove `world.sqlite-wal`. An old WAL is applied on top of the copy. The `*.pre-restore` files keep the current database in case of a mistake. To go back:

1. `docker compose stop server`.
2. `docker compose run --rm --no-deps --entrypoint sh server -c "cd /var/lib/evejs/mods/livingNewEden && rm -f world.sqlite-wal world.sqlite-shm && cp world.sqlite.pre-restore world.sqlite && if [ -f world.sqlite-wal.pre-restore ]; then cp world.sqlite-wal.pre-restore world.sqlite-wal; fi"`
3. `docker compose up -d`.

`world.sqlite.pre-restore` always goes back as `world.sqlite`. Copy the WAL back as `world.sqlite-wal` only if `world.sqlite-wal.pre-restore` exists; never copy back a `-shm` file.

Effect: the mod world goes back to the moment of the copy. OUTBOX entries applied after the copy come back as `PENDING`. Some EveJS seams reject a duplicate. Others can produce a duplicate (for example the wallet); this is not verified for every seam. EveJS objects created after the copy are left orphaned. When you need a state consistent for both databases, restore the cold archive (3.1).

## 4. Restart and the restart guard

- Container restart policy: `EVEJS_SERVER_RESTART` in the root `.env`, default `no`.
- Recommendation: `EVEJS_SERVER_RESTART=on-failure:5` together with `EVEJS_LNE_RESTART_GUARD_ENABLED=1`.
- After a change run `docker compose up -d server`. Docker creates a new container.

The `restartGuard` fuse (off by default):

- Every start is recorded in `/var/lib/evejs/mods/livingNewEden/runtime/boots.json`.
- A clean stop (`docker compose stop` or `restart`) closes the series.
- After 3 starts without a clean stop within 1 h the fuse latches. Log: `services not started - crash_loop_guard (...)`. The game works as without the mod. The observer and the alerts work.
- The latch does not clear by itself. Remove the cause. Then run:
  1. `docker compose exec server rm /var/lib/evejs/mods/livingNewEden/runtime/boots.json`
  2. `docker compose restart server`
  3. Check the line `services: telemetry=running ...`.
- A refusal because of DRIFT does not count as a start.

Before flipping the default of the flag, trip the fuse once by hand and clear it with the steps above.

## 5. Alerts

The `alerts` service sends events to one webhook. It is off by default.

1. In the root `.env` set `EVEJS_LNE_ALERTS_ENABLED=1`.
2. In the root `.env` set `EVEJS_LNE_ALERTS_WEBHOOK_URL=https://...`.
3. Optionally set `EVEJS_LNE_ALERTS_FORMAT=discord` (or `slack`; default `json`).
4. Run `docker compose up -d server`.
5. Check the log: `alerts: running host=<host> ...`. The log does not show the full URL.

Events: `BOOT`, `ALARM`, `SHED`, `PROBE_DRIFT`, `SERVICES_REFUSED`, `SERVICE_FAILED`, `RESTART_GUARD_TRIPPED`. The content holds no player data.

Only `https:`. The flag turned on without a URL gives `alerts=failed:ALERTS_NO_WEBHOOK`. A restart loses the alert queue.

The HTTPS transport was checked only by reading the code. Try it with a test webhook before relying on it.

## 6. Observer

- Address: `http://127.0.0.1:26410/`. A read-only page, no login.
- Docker publishes the port only on `127.0.0.1` of the host. Do not change this without a deliberate decision: the page has no login.
- Another port: `EVEJS_LNE_OBSERVER_PORT` in the root `.env`.
- The "status" panel shows the services, the probe result, the database state and the load governor.
- The "Effective config" panel (flag `observer.effectiveConfigEnabled`, off by default) shows the flags and their source.
- API: `GET /api/views` and `GET /api/views/<id>`.
- Turning it off: `EVEJS_LNE_OBSERVER_ENABLED=0`.

## 7. Logs and telemetry

- Server log: `docker compose logs server`. Mod lines have the prefix `[LivingNewEden]`.
- Docker log limit: 50 MB x 5 files. To change it: `EVEJS_LOG_MAX_SIZE` and `EVEJS_LOG_MAX_FILE` in the root `.env`, then `docker compose up -d --force-recreate server`.
- Metrics: `/var/lib/evejs/mods/livingNewEden/telemetry/latest.json` (every `telemetry.intervalSeconds`, default 10 s).
- Database audit: `tools/auditWorldDb.js` (`--snapshot --integrity quick` while running, `--integrity full` on a stopped server).

## 8. Offline tools (server stopped)

- `tools/compactWorld.js`: compacts the database. Run it first without `--apply`.
- `tools/resetWorld.js`: resets the mod world. Run it first without `--apply`.
- With `--apply` both tools make a `world.sqlite.pre-*` copy themselves (`--backup-dir <dir>` for another folder).
- `tools/compactWorld.js --list-backups` and `--prune-backups [--keep <n>] [--apply]` manage those copies.
- `tools/retentionStats.js`: row and byte counts of the queue and journal, read only.
