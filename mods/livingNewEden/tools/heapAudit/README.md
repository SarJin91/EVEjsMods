# heapAudit — heap measurement tools

Tools for measuring the V8 heap of the running game server. They use only `node:*` modules (Node ≥ 22, no `npm install`, no `server/src`). They run inside the container (Node 24) and on the host (Node 24/26).

## Files

| File | What it does |
|---|---|
| `cdp.js stats` | Reads through the Node inspector: `pid`, `process.memoryUsage()`, V8 heap statistics and heap spaces. `--gc` forces one full GC (one pause, about 1 s). |
| `cdp.js snapshot` | Heap snapshot to `<out>.partial`, then `rename` to `<out>`. Stops the game process while it writes. |
| `cdp.js heapsample` | Heap sampling (`HeapProfiler.startSampling`, every 128 KiB) for `--duration-s` (3000). Every `--every-s` (300): a full GC (`--no-gc` turns it off), writes `hs-<runId>-<nn>.heapprofile` and a read into `hs-<runId>.timeline.json`. The game process does not stop (only the GC pause of about 1 s). |
| `snapshotSummary.js` | Reads a snapshot without DevTools: types, top (type, name), `--diff <older>`, `--anchor-keys`. |
| `heapProfileSummary.js` | Reads a `.heapprofile`: `profile <file> [--top 30] [--json <out>]` (bytes per owner and a "via" column), `--diff <a> <b>` (delta per stack signature), `ring <latest.json> [--timeline <t.json>]` (segments of the telemetry ring `afterMajor` by player count and a `verdict` line). |
| `../inspectGameStoreSchema.js` | `--online-copy <live> <dest>`: online copy of the live database. `--bytes`: JSON bytes per table. |

## Usage

```
node cdp.js stats (--port <n> | --ws <url>) [--gc] [--timeout-s 60]
node cdp.js snapshot (--port <n> | --ws <url>) --out <file> [--mem-factor 1.5] [--disk-factor 1.5] [--force] [--timeout-s 1800]
node cdp.js heapsample (--port <n> | --ws <url>) --out-dir <dir> [--duration-s 3000] [--every-s 300]
     [--interval-bytes 131072] [--no-gc] [--call-timeout-s 120] [--min-free-mb 256]
node snapshotSummary.js <file> [--top 40] [--diff <older>] [--anchor-keys k1,k2]... [--max-anchors 5] [--max-mem-mb 8192]
node heapProfileSummary.js profile <file.heapprofile> [--top 30] [--json <out>]
node heapProfileSummary.js --diff <a.heapprofile> <b.heapprofile> [--top 30] [--json <out>]
node heapProfileSummary.js ring <latest.json> [--timeline <t.json>] [--json <out>]
node ../inspectGameStoreSchema.js <file.sqlite> [--bytes] [--server <serverDir>]
node ../inspectGameStoreSchema.js --online-copy <live> <dest> [--server <serverDir>]
```

## Output and exit codes

- `cdp.js`: one JSON object on stdout. Exit 0 = `ok:true`, 1 = refusal (`reason`), 2 = bad arguments.
- `cdp.js` refusals: `NO_TARGET`, `NO_WEBSOCKET`, `CDP_ERROR`, `CDP_CLOSED`, `TIMEOUT`, `OUT_EXISTS`, `OUT_DIR_FAILED`, `LOW_MEMORY`, `LOW_DISK`.
- `snapshotSummary.js`: markdown on stdout. Exit 1 = `BAD_SNAPSHOT`, `OVER_MEMORY`, `READ_FAILED`; 2 = bad arguments.
- `heapProfileSummary.js`: markdown on stdout. Exit 1 = `BAD_PROFILE`, `READ_FAILED`, `BAD_RING`, `WRITE_FAILED` (`--json`); 2 = bad arguments.
- Byte owner = the deepest application frame (`lne:<module>`, `mod:<name>`, `vendor:<a>/<b>`, `npm:<pkg>`; `node`/`native` frames are skipped, none = `(runtime)`). Copies of vendor functions in mods (hotPathPerf, scenePerfFix) count as `mod:<name>`. "via" does not add up to 100%.
- `ring` verdict: `no-play` (no segment with characters > 0), `incomplete` (no segment with 0 characters before or after play), `released` (after − baseline ≤ 100 MB: session state is released, a session cost, not a leak) or `retained` (after − baseline > 100 MB: compare play → after with `--diff`; an owner of ≥ 50 MB that did not drop by ≥ 50% is a retention bug).
- A sampling profile contains only function names, paths and sizes: its `.md` output may be shared; keep the raw files in `_local/` anyway.

## Rules

1. Take a snapshot only in a window without players. Write the file to `/var/lib/evejs/logs/heap/`, copy it to `_local/heap/` on the host and delete it in the container.
2. A snapshot contains the whole server memory (accounts, mail, tokens, secrets). Never send it to git, external services or AI tools. Share only the `snapshotSummary.js` output.
3. `snapshot` refuses when `MemAvailable` < 1.5 × `used_heap_size` (`LOW_MEMORY`) or free disk < 1.5 × `used_heap_size` (`LOW_DISK`). `--force` skips these two refusals; use it only when you accept the risk of running out of memory or disk.
4. Without `/proc/meminfo` (outside Linux) the memory check is skipped; the output shows `memCheck: "unavailable"`.
5. After a `kill -9` of the tool a `<out>.partial` can remain. Delete it by hand. On an ordinary error the tool deletes it itself.
6. `kill -USR1 <pid>` opens the inspector on 127.0.0.1:9229 inside the container until the process restarts. The tool does not close the inspector and never calls `Profiler.*`.
7. `--anchor-keys` counts the size reachable from an object property. It is an approximation, an upper bound of the retained size. Shared nodes count in every key. Memory: about 18 B × nodes + 9 B × edges (`OVER_MEMORY` above `--max-mem-mb`).
8. `--online-copy` copies the database in one SQLite backup step (one consistent WAL snapshot). Server writes do not restart the copy and the WAL writer does not wait. Until the copy ends the checkpoint cannot move past the snapshot, so the `-wal` file can grow for a while. After an interruption (`Ctrl+C`, `kill`) an incomplete `<dest>` remains. Delete `<dest>*` before the next run, otherwise the tool refuses (`DEST_EXISTS`). On an ordinary error the tool deletes `<dest>` itself.
9. Before every `docker compose cp ... server:/tmp/heapAudit` delete the old directory: `docker compose exec server sh -c "rm -rf /tmp/heapAudit"`. With an existing directory `docker cp` creates `/tmp/heapAudit/heapAudit/` and the old files stay in use. After a container restart the directory is gone, so always start with the `cp` step.

## Command summary (PowerShell, cwd = repository root)

```powershell
docker compose exec server sh -c "rm -rf /tmp/heapAudit"
docker compose cp mods/livingNewEden/tools/heapAudit server:/tmp/heapAudit
docker compose exec server sh -c "kill -USR1 <pid>"
docker compose exec -T server node /tmp/heapAudit/cdp.js stats --port 9229 > _local\heap\stats-before-gc.json
docker compose exec -T server node /tmp/heapAudit/cdp.js snapshot --port 9229 --out /var/lib/evejs/logs/heap/A.heapsnapshot
node mods/livingNewEden/tools/heapAudit/snapshotSummary.js _local\heap\A.heapsnapshot --top 40 > _local\heap\A-summary.md
```

## Heap while playing (about 50 min)

Needs an image whose telemetry ring records the player count. Without it `heapsample` still works, but the `ring` segments have `characters = null`.

1. `rm -rf /tmp/heapAudit` + `docker compose cp` as above, `kill -USR1 <pid>` of the game process.
2. With the player logged out: `docker compose exec -T server node /tmp/heapAudit/cdp.js heapsample --port 9229 --out-dir /var/lib/evejs/logs/heap --duration-s 3000 --every-s 300 > _local\heap\hs-run.json` (the window stays open; a pause of about 1 s every 5 min).
3. After about 6 min log in and play for 15–20 min (flying, combat, docking, map); note the login and logout times. Then log out completely and wait until the tool ends.
4. `docker compose cp server:/var/lib/evejs/logs/heap _local/heap/hs` and `docker compose cp server:/var/lib/evejs/mods/livingNewEden/telemetry/latest.json _local/heap/hs/latest.json` (before a server restart: a restart clears the ring). Delete the `hs-*` files in the container.
5. `node mods/livingNewEden/tools/heapAudit/heapProfileSummary.js ring _local\heap\hs\latest.json --timeline _local\heap\hs\hs-<runId>.timeline.json > _local\heap\hs-ring.md`
6. `node mods/livingNewEden/tools/heapAudit/heapProfileSummary.js profile <read while playing> --top 40 > _local\heap\hs-play.md` and `node mods/livingNewEden/tools/heapAudit/heapProfileSummary.js --diff <read while playing> <last read> > _local\heap\hs-after-logout.md`
7. Read the `verdict` line of `hs-ring.md` (see "Output and exit codes"). For `retained`, the owners in `hs-after-logout.md` with ≥ 50 MB that did not drop by ≥ 50% are the candidates; a `vendor:*` owner without LNE or another mod in "via" points at EveJS itself.
8. After a `kill -9` of the tool delete `hs-*.partial`.
