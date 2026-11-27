# Living New Eden

A living universe for EveJS. NPC factions hold territory, gain and lose
influence, build stations, run an economy, move fleets and fight wars while
you play. Most of this is simulated as records in the mod's own SQLite
database (a fleet far from players is a row, not a ship in space), and battles
far from players are settled by the mod's own resolver. Some effects are
visible in the game.

Version 0.2.1, for EveJS 261126.2. Runs on Node 24 and newer.

## What you see with the default settings

- Belt rats in a system held by a pirate faction belong to that faction.
- In empire-held null-sec, empire navy fleets guard the belts. They attack
  pilots with negative standing; attacking them costs standing.
- Killing pirate NPCs in a pirate-held or contested system gives a small
  standing plus with the empire (or CONCORD) fighting them.
- Factions post buy contracts for minerals at their stations; delivering pays ISK.
- Player kills lower the influence of the system holder and can free the system.
- A hostile faction can besiege a player Upwell structure in null-sec (hull
  phase only with asset safety and recent activity of the owner corporation).
- A faction takes a system only after anchoring a sovereignty structure (TCU).
- A read-only status page in your browser: `http://127.0.0.1:26410/`.

Network: by default the server reads Jita prices over HTTPS from
`market.fuzzwork.co.uk` (at most every few hours). Turn it off with
`EVEJS_LNE_TRADE_EXTERNAL_PRICE_ENABLED=0`.

## Off by default

- The **Danger** group of modules: `events`, `sites`, `materialization`,
  `virtualCorps`, `sovProjection`, `structures` (see the table below). Without
  `materialization`, mod fleets never appear in space as ships and there are no
  hunts on players.
- Newer features (world bosses, galactic seasons, nemesis captains, NPC pilot
  population, wormhole corporations, faction and native incursions, Triglavian
  bridge, archaeology, in-game map and job board, online backups, webhook
  alerts, and others) each have their own `...enabled` flag, all off. Every flag
  is listed with its description in `.env.example`.
- AI features: Local chatter lines (`EVEJS_LNE_CHATTER_AI_*`) and the ship AI
  companion (`EVEJS_LNE_SHIP_AI_*`) use an OpenAI-compatible chat completions
  API (default base URL `https://integrate.api.nvidia.com/v1`). They are off by
  default and need your own API key. The key is read **only from the
  environment or `.env`**, never from `settings.json`; no key ships with the mod.
  The optional ship AI voice needs a separate Piper TTS HTTP service that is not
  included.

## Modules

Each core module has a switch. A module that is off leaves its tables as they
are; switching it on again continues from the stored state. Services that need
a disabled module stay off with the reason `dependency_disabled`.

| Key | Env | Default | When off |
|---|---|---|---|
| `modules.graph.enabled` | `EVEJS_LNE_GRAPH_ENABLED` | `true` | No galaxy graph: routes and the faction AI have no map; wormhole routing is off too. |
| `modules.world.enabled` | `EVEJS_LNE_WORLD_ENABLED` | `true` | Territory, influence and occupation stand still; occupation, liberation, standings, invasions, salvage, mining, construction and sov projection are off too. |
| `modules.fleets.enabled` | `EVEJS_LNE_FLEETS_ENABLED` | `true` | Virtual fleets stand still and their events wait; battles, hunts, logistics, sieges and invasions are off too. |
| `modules.scheduler.enabled` | `EVEJS_LNE_SCHEDULER_ENABLED` | `true` | No deadline queue passes; due events wait in the table. Nearly every gameplay service is off too. |
| `modules.strategy.enabled` | `EVEJS_LNE_STRATEGY_ENABLED` | `true` | Factions make no reviews (no targets, fronts, upkeep or tribute); stations, economy, sieges and hunts are off too. |
| `modules.battle.enabled` | `EVEJS_LNE_BATTLE_ENABLED` | `true` | Battle events wait, engaged fleets wait, the world state is untouched. |
| `modules.events.enabled` | `EVEJS_LNE_EVENTS_ENABLED` | `false` | The Event Director creates no events near players; queued director pulses wait. |
| `modules.sites.enabled` | `EVEJS_LNE_SITES_ENABLED` | `false` | No new sites in space; sites being cleaned up wait until it is on again. |
| `modules.materialization.enabled` | `EVEJS_LNE_MATERIALIZATION_ENABLED` | `false` | Fleets near players stay virtual, no live ships; live battles of a previous boot are finished virtually. |
| `modules.persistence.enabled` | `EVEJS_LNE_PERSISTENCE_ENABLED` | `true` | The mod does not open its database; every service with state is off. |
| `modules.telemetry.enabled` | `EVEJS_LNE_TELEMETRY_ENABLED` | `true` | No metrics timer, tick sampling or metrics file; the load governor is off too. |
| `modules.presence.enabled` | `EVEJS_LNE_PRESENCE_ENABLED` | `true` | The mod does not know where players are. Read only, nothing changes in the database. |
| `modules.virtualCorps.enabled` | `EVEJS_LNE_VIRTUALCORPS_ENABLED` | `false` | No new EveJS characters and corporations for factions. Identities already created stay in EveJS unchanged. |
| `modules.sovProjection.enabled` | `EVEJS_LNE_SOVPROJECTION_ENABLED` | `false` | No sovereignty writes into EveJS; the last projected sovereignty stays as it is. |
| `modules.structures.enabled` | `EVEJS_LNE_STRUCTURES_ENABLED` | `false` | Faction structures in EveJS are frozen; switching on again adopts them. |

## Configuration

Layers, the higher one wins per key:

1. defaults in `config.js`;
2. `settings.json` next to the mod (written by the EveJS Launcher **Configure** dialog);
3. `.env` next to the mod (copy `.env.example`; every key is documented there);
4. environment variables `EVEJS_LNE_*`.

A setting changes only after a server restart. A bad value logs a
`config: warning` line and the lower layer applies. The status page shows the
effective configuration and where each value comes from;
`node mods/livingNewEden/tools/effectiveConfig.js [--compose <file>] [--json]`
prints it from the command line.

- Whole mod off: `EVEJS_LNE_ENABLED=0` (services do not start) or
  `EVEJS_LNE_NO_INSTALL=1` (no hooks at all).
- Mod data: `${EVEJS_DATA_ROOT}/mods/livingNewEden`, or
  `<EveJS folder>/_local/mods/livingNewEden` on a native install. Back it up
  with the rest of your server data.
- Work limits (fleets in the world, events per scheduler pass, live ships per
  system and in total, new sites per system, sovereignty writes) are the
  `limits.*` keys. Every limit is a setting; none is hard-coded.

## Install notes

- The mod runs its services only in the EveJS world process, after the world
  has booted. Look for `[LivingNewEden] ready (world process)` in the console,
  then a `services: ...` line with the state of every service.
- At start the mod checks the EveJS functions it hooks. A changed EveJS logs
  `DRIFT` and the affected part of the mod stays off; the game keeps running.
  See `docs/evejs-update.md` before updating EveJS.
- Load `loader.js` **after** the other mods of this collection: with Docker
  or a manual `--require` setup, put its `--require` last. The launcher
  manifest has no `loadAfter` entry, so the launcher does not enforce this
  order.
- `clientHook.js` is a second, optional preload used only by the in-game job
  board and map windows. With Docker or a manual `--require` setup, add
  `--require <path>/mods/livingNewEden/clientHook.js` **before** `shipWing` and
  other mods that patch the client handshake. The launcher preloads only
  `loader.js`, so those two windows are not available there.
- Docker: add `--require /app/mods/livingNewEden/loader.js` to the server
  command and rebuild the image. Keep the data directory on a volume.

## Operator tools

Run with the server stopped, from the EveJS folder:

- `node mods/livingNewEden/tools/resetWorld.js [--dry-run|--apply]` resets the
  mod's world state (makes a backup first).
- `node mods/livingNewEden/tools/compactWorld.js [--dry-run|--apply]` compacts
  the mod database (with a backup).
- `node mods/livingNewEden/tools/retentionStats.js` shows table sizes (read only).
- `node mods/livingNewEden/tools/inspectGameStoreSchema.js <world.sqlite copy>`
  checks the integrity of a database copy (never run it on the live file).
- `node mods/livingNewEden/tools/account/setGm.js on|off <account> [--dry-run]`
  removes or restores GM rights of an account; `setGm.js status [<account>]`
  shows them.

More documentation:

- `docs/player-guide.md`: what a player sees in the world.
- `docs/operator-runbook.md`: start, switches, backups, restart guard, alerts, status page.
- `docs/evejs-update.md`: checklist for an EveJS update.
- `docs/game-master.md`: the AI Game Master hint sources and steps.
- `tools/downtime/README.md`, `tools/measure/README.md`, `tools/heapAudit/README.md`:
  measurement tools.

## Backups

Stop the server, then copy the mod data directory, always with the
`world.sqlite-wal` and `world.sqlite-shm` files. `compactWorld.js --apply` and
`resetWorld.js --apply` make their own copy first. An optional online backup
(`EVEJS_LNE_BACKUP_ENABLED=1`) copies `world.sqlite` in small steps while the
server runs and keeps the newest copies in `<data dir>/backups/`. It copies only
the mod database: a cold copy of the whole server data is the only state that
is consistent for both EveJS and the mod.

## Chat commands

`!mods` in Local lists the chat commands of the installed mods. With the
matching features on: `!front` (war state here), `!jobs` (front job board),
`!map` (link to the mod map on the status page), `!board` (the job board
window), `!settings` (mod settings panel, allowed characters only).

## Known limits

- Catch-up after a long downtime is bounded, not complete.
- No guaranteed number of virtual NPCs without a benchmark on your hardware.
  The limit is the scheduler throughput, not the server tick.
- Wormhole space has no sovereignty like null-sec.
- Some tables grow without retention; use `compactWorld.js` offline. The
  server never runs `VACUUM`.
- The battle resolver is the mod's own model, calibrated offline; EFS is not a
  dependency.
- `--require` is baked into a Docker image: enabling or disabling the mod
  there means a rebuild, or `EVEJS_LNE_NO_INSTALL=1` in the environment.

## Tests

`node mods/livingNewEden/test/run.js` (or `RunTests.bat`). Tests that use
SQLite need `better-sqlite3`; without it, preload the `node:sqlite` shim:
`node --require ./mods/livingNewEden/tools/liveSim/sqliteShim/preload.js mods/livingNewEden/test/run.js`.

Credits for ported code: `CREDITS.md`.
