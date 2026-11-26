# Ship Wing (EveJS mod)

A pilot launches "copies" of the fitted ships in their current ship's Ship Maintenance Bay. Any hull works: the mod has no host or wing-ship type limit. A ship only needs to be assembled and flyable with your skills. A copy follows the pilot, can mine, fight NPCs, salvage and repair, and comes back on command. The real ship stays in the bay and is locked while its copy is in space. If an NPC destroys the copy, the real ship is lost: wreck, killmail, and the ship leaves the bay.

Version 0.2.0 is a test version. The mod is off by default (`enabled=false`), and every feature has its own switch.

## Warning: test servers first

Turn the mod on for players only after you have tried it on a test server.

1. **Losing a copy loses the ship.** When an NPC destroys a copy, the mod deletes the real ship and its fit, drops part of the modules into a wreck under the normal loot rules and posts a killmail for the pilot. If settling the loss fails (for example the hull is in use), the mod retries every `lossSettleRetryMs`. After `lossSettleMaxAttempts` tries the ship stays locked until a restart, and the log has a `LOSS NOT SETTLED` line.
2. **Repackage and resale.** The loss is settled by ship item ID wherever the ship is (bay, or station hangar after the host ship was repackaged). If the ship was sold before a retry, the record ends as `OWNER_CHANGED`: the mod never destroys another player's ship, and it logs a line for the admin.
3. **Move scan limit.** While any wing record exists on the server (including `LOST`), every item move with more than `guardMaxScannedIds` items (default 4096) is refused, for every player.

## Requirements and basic rules

- The ship must be the pilot's own, assembled (not packaged), and the pilot must have the skills for the hull.
- While a copy is out, its real ship cannot be boarded, launched, refitted or moved (`Ship is deployed as a wing copy. Use !wing return first.`).
- A copy returns to the bay by itself when the pilot docks, jumps, warps, logs off or changes ship, when the host ship disappears, or when the copy stays further than `controlRangeMeters` for longer than `outOfRangeGraceMs`. Damage on the copy is written back to the real ship.
- A server restart ends every copy (copies are transient).
- Do not launch copies in a dungeon or in the Abyss: the copy's wreck has no dungeon scope and can end up out of reach.

## Docked

When you are docked, the window and `!wing status` list the ships in your active ship's Ship Maintenance Bay read-only. Every row shows why it cannot act: `you are docked` for your own ships, `not your ship` in chat (`not yours` in the window) for a ship owned by someone else. Launch, cargo and every other order need you to undock first.

## Chat commands (Local)

The reply goes only to the pilot as a system line. Other players do not see the command. Other chat lines pass through unchanged. The trigger is `chatTrigger` (default `!wing`).

| Command | Effect | Needs |
|---|---|---|
| `!wing launch` | Launches copies from the bay, lowest item ID first, up to `maxWingPerPilot`. | |
| `!wing launch <text>` | Launches the first ship whose name contains the text, or whose type or item ID equals it. | |
| `!wing return [text]` | Copies fly to the pilot and go back into the bay within `recallRangeMeters` (or after `recallTimeoutMs`). | |
| `!wing status` | Ships in the bay and copies in space: state, distance, task, refusal reason. | |
| `!wing ui` | Opens the Ship Wing window. `!wing ui auto on\|off` opens it at every login. | `clientWindowEnabled` |
| `!wing hold [text]` | Copies stop their task and follow the pilot. | `miningEnabled` or `combatEnabled` |
| `!wing mine [text]` | Copies pick rocks and mine; ore is unloaded to the pilot. | `miningEnabled` |
| `!wing attack [text]` | Copies attack the pilot's target (or pick an NPC themselves, see Auto target). | `combatEnabled` |
| `!wing salvage [text]` | Copies with a Salvager salvage wrecks; loot goes to the pilot's cargo hold. | `salvageEnabled` |
| `!wing drones auto\|off [text]` | Drone mode of the copies. `auto`: combat drones launch when the copy has a target. `off`: drones come back now. | `dronesEnabled` |
| `!wing board [text]` | Board your own copy: the copy ends and you sit in the real ship at its place. | `boardEnabled` |
| `!wing formation [name]` | Shows or sets the formation: `none`, `wedge`, `line`, `column`, `sphere`. | `formationEnabled` |
| `!wing store [name\|off]` | Sets the hauler: a ship in the bay that takes ore when the copies' own ships are full. Memory only. | `miningRealCargoEnabled`, `miningRealCargoStoreEnabled` |
| `!wing cargo [name\|host]` | Holds of the pilot's ship and of the ships in its bay: hold kind, used/capacity m3, items. | `cargoPanelEnabled` |
| `!wing move <from> to <to\|host> [type]` | Moves stacks between those holds (ore hold, then cargo, then the pilot's Fleet Hangar), as much as fits. | `cargoPanelEnabled` |

Common refusals: `no target - shoot or lock an NPC first`, `copies attack only NPC ships and NPC site structures`, `the target is too far from your ship`, `no module of the copy can be used on that target`, `no mining module online`, `no turret online`, `out of ammo - return it to reload`, `this order is not available now` (the feature is on but its hook is missing), `unknown order` (the feature is off or its probe failed).

## Features

Each feature has its own flag (all keys are in `.env.example`). A feature whose server functions changed in an EveJS update turns itself off with one log line `... NOT available - <reason>`; the rest of the mod keeps working.

- **Mining** (`miningEnabled`). Copies mine with their own fit, crystals and the pilot's skills. Ore goes to a virtual hold of the copy and is unloaded to the pilot's ore hold, then Fleet Hangar, within `miningTransferRangeMeters`. Search radius `miningSearchRangeMeters`; an ordered or locked rock may be up to `miningOrderRangeMeters`. Crystals do not wear out. Ore counts in the pilot's mining ledger (`miningLedgerEnabled`). Ore in the virtual hold is lost on a copy loss or a restart.
- **Overflow jetcans** (`miningOverflowCanEnabled`, on). Ore the pilot cannot take goes into the pilot's jetcan next to the copy, at most `miningOverflowMaxCansPerOwner` cans, each living `miningOverflowCanLifetimeMs`. With `miningOverflowOnEnd`, a copy that ends (warp, dock, logoff, out of range) drops its hold into a jetcan instead of losing it.
- **Ore in the real ship** (`miningRealCargoEnabled`). Every `miningRealCargoIntervalMs` the copy's ore moves into its real ship in the bay (ore hold, then cargo with `miningRealCargoUseCargoHold`), then into the hauler set with `!wing store`. A ship with ore inside can be launched and boarded, but cannot go back into the bay until it is empty (server rule).
- **Cargo panel** (`cargoPanelEnabled`). `!wing cargo`, `!wing move` and a separate "Ship Wing Cargo" window (button `Crg`). Each move is one server write: an item moves fully or not at all. The mod checks owners, locations and free space, and never moves ships, fitted modules, drones or other players' items.
- **Combat** (`combatEnabled`). Copies shoot NPC ships (and NPC site structures with `combatAllowNpcStructureTargets`) within `combatEngageRangeMeters` of the pilot, never players, other copies, drones, player structures or CONCORD; Drifters only with `combatAllowDrifterTargets`. With `combatAssistOnLaunch` a copy assists: it takes the pilot's weapon target, and with `combatDefendWhenAttacked` the nearest NPC that locks it or the pilot. Copies lock before they fire, fly into range of their shortest-range weapon with ammo, and give up an unreachable target after `combatApproachTimeoutMs`. Bounty, killmail, standing and SP go to the pilot. Each shot uses one charge of the copy; the used ammo is taken from the real stack when the copy comes back without a loss (`combatAmmoWriteBack`). No overheat, no reload from cargo, no capacitor use.
- **Auto target** (`combatAutoTargetEnabled`, on). An explicit Attack with no pilot target lets the copy pick NPCs itself (pilot's locks first, then NPCs locking the pilot or copies, nearest first) within `combatAutoTargetRangeMeters`.
- **More weapons**, each needing `combatEnabled`: missiles (`combatMissilesEnabled`), Entropic Disintegrators with spool (`combatPrecursorEnabled`), Vorton Projectors with arcs to allowed NPCs only (`combatVortonEnabled`, `combatVortonArcsEnabled`), smartbombs and point defense hitting allowed NPCs only (`combatAreaEnabled`; not in highsec unless `combatAreaAllowHighsec`; `combatAreaHoldWhenBystander` holds the wave near other players), breacher pods (`combatBreacherEnabled`) and bombs (`combatBombsEnabled`, not in empire space, within `combatBombMaxAngleDeg` of the flight direction). The `ready` log line lists the active weapon kinds in `weapons=`.
- **Active modules** (`activeModulesEnabled`). At launch the mod checks capacitor stability of the fit. Unstable fits follow `activeCapUnstablePolicy`: `shed` (turn modules off until stable: AB/MWD, EWAR, cap transfer, local repair, remote repair, hardeners; never weapons or zero-cost modules), `disable` (all active modules off) or `refuse` (that copy does not launch). Hardeners and damage controls are always on; local repair runs between `activeLocalRepStartPct` and `activeLocalRepStopPct`. In combat nothing uses capacitor. Not supported: cap boosters, sensor boosters, tracking computers, a second AB/MWD.
- **Remote repair** (`logiEnabled`, needs `activeModulesEnabled`). Copies repair only the pilot's ship and the pilot's other copies below `logiRepairThresholdPct`, never themselves or anyone else. Cap transfer to the pilot with `logiCapTransferEnabled`. `activeCapShedRemoteLast` keeps remote repair over hardeners when shedding.
- **AB/MWD** (`activePropEnabled`, needs `activeModulesEnabled`). The propulsion module runs while the copy flies to a target further than `activePropMinDistanceMeters`.
- **EWAR** (`ewarEnabled`, needs `activeModulesEnabled` and `combatEnabled`). Nosferatu, neutralizer, web, scrambler and disruptor work on the combat target. `activeCapNosCreditPct` counts Nosferatu income in the launch balance.
- **Combat drones** (`dronesEnabled`, works with `combatEnabled`). Copies launch real drones from their ship's drone bay at their target, up to `droneMaxPerCopy`, the pilot's drone skills and the hull bandwidth (`droneMaxPerPilot` > 0 adds a per-pilot cap). Idle drones return after `droneIdleRecallMs`. Drones come back before the copy ends; on a copy loss they are abandoned. Repair drones (`droneRepairEnabled`), mining drones (`droneMiningEnabled`, needs `miningEnabled`) and salvage drones (`droneSalvageEnabled`, needs `salvageEnabled`). Drones left in space by a restart return to their bay at the next start (`droneReclaimOnBoot`, journal `wingDrones.json`).
- **Salvage** (`salvageEnabled`). Copies salvage the wreck targeted or locked by the pilot, otherwise the nearest free wreck within `salvageSearchRangeMeters`. Loot goes to the pilot's cargo hold; with less than `salvageMinFreeCargoM3` free, modules stop and retry every `salvageFullRetryMs`.
- **Command mirror** (`commandMirrorEnabled`). The pilot's drone orders reach the copies: Engage (to copies whose F switch is on, `commandMirrorEngageEnabled`, new copies start with `commandMirrorEngageCopyDefault`), Mine repeatedly, and with `commandMirrorReturnEnabled` Return to drone bay and Return and orbit (only when the order covers all of the pilot's drones in space). Fighter abilities with a target and fighter recall work the same way.
- **Command bursts** (`burstEnabled`). The pilot's bursts reach the copies; with `burstShipStatsEnabled` (on) they also change the copies' HP, resists, signature, agility and targeting.
- **NPC aggression** (`npcAggroEnabled`). NPCs lock and shoot copies like player ships and answer their fire. Copies die more often, and a lost copy is a lost real ship. No crimewatch flags for the pilot. Read at server start.
- **Safe logoff** (`safeLogoffAbortOnOrder`, `safeLogoffBlockWhileDeployed`). An accepted copy order aborts a running safe logoff, and copies in space block starting one, like drones.
- **Formations** (`formationEnabled`, on). See below.
- **Boarding** (`boardEnabled`). See below.

Copies do not get: homefront weather, season bonuses, Abyssal effects, NPC EWAR on speed, or help from other players. The owner's implants apply to the copy.

## Client window

`clientWindowEnabled=true` (needs `enabled=true` and a restart) adds the `shipWingSvc` service and sends the client code `client/wing.py` in memory at login (nothing is written on the client's disk). The code needs a known `handshake.js` (`clientWindowHandshakeHashes`).

`!wing ui` opens the "Ship Wing" window; the first launch opens it by itself (`clientWindowAutoOpen`). The header shows `<out>/<limit> out` and the context refusal (for example `you are docked`). Below it is a group bar for the selected ships, then one two-line row per ship: name, state, the last refusal (for `clientWindowRowReasonMs`), shield/armor/hull in % (orange below `hpWarnPct`, red below `hpCriticalPct`), target, and the row buttons the server allows. The window refreshes every `clientWindowPollMs` and reads HP from the client every `clientWindowHpRefreshMs`. It closes on character change and disconnect.

| Button | Where | Meaning |
|---|---|---|
| `All` | bar | Select all |
| `Go` | bar, row | Launch |
| `Bk` | bar, row | Return to bay |
| `Fol` | bar, row | Follow (hold) |
| `Mn` | bar, row | Mine |
| `Atk` | bar, row | Attack |
| `Slv` | bar, row | Salvage |
| `Brd` | row | Board |
| `Dr` / `F` | bar | Drones auto / off, listens to F / ignores F |
| `D:A` / `D:0` | row | Drones auto / drones off |
| `F:1` / `F:0` | row | Listens to the pilot's F / ignores it |
| `Crg` / `Crg-` | bar | Cargo window (`-` = open, click closes) |
| `Mv` | Cargo window | Move to the target ship |

`Attack` and `Mine` use the player's active target. If button colors show as raw tags in your client, set `clientWindowButtonColors=false`.

**Load order.** `shipWing/loader.js` must come before `moonOreAnomalies` and `droneClassBalance` in the `--require` list; otherwise the log has `SHIPWING_UI:UNAVAILABLE:LOAD_ORDER` and there is no client code (the game and chat still work). A login in the first seconds after server start may get no client code; the next login does.

Log lines (prefix `[ShipWing]`):

| Line | Meaning |
|---|---|
| `SHIPWING_UI:WRAPPER_READY tail=<n> dcb=<0\|1> moon=<0\|1>` | Client code tail added after the other mods' tails. |
| `ready ... clientWindow=hook:WRAPPED service:ok` | Hook and service ready. Other `hook:` values: `HOOKED`, `CONFLICT`, `OFF:<reason>`. |
| `SHIPWING_UI:PROBE char=... build=... ok=... missing=...` | UI probe result from the client. |
| `SHIPWING_UI:EVENT char=... ok=... missing=...` | Window result or error items from the client (`ui.win`, `ui.open`, `ui.hp:<error>`, `ui.formation...`), at most one line per pilot per `clientWindowEventMinIntervalMs`. |
| `SHIPWING_UI:UNAVAILABLE:<reason>` | No client code: `LOAD_ORDER`, `HANDSHAKE_ALREADY_LOADED`, `HANDSHAKE_UNREADABLE`, `UNKNOWN_HANDSHAKE hash=...`, `SEAM_CHANGED`, `CLIENT_SOURCE`, `CONFLICTING_SOURCE`. |
| `SHIPWING_UI:UNAVAILABLE:WAIT` (client log) | The client code got no session in 120 s and stopped. |
| `SHIPWING_UI:UNAVAILABLE:COMPILE` (client log) | The client code did not compile or the payload is damaged; login goes on without it. A runtime error inside `wing.py` gives `SHIPWING_UI:UNAVAILABLE:DELIVERY` instead. |

To turn the window off: `clientWindowEnabled=false` and a restart.

## Formations

A formation places one pilot's copies around the flying host ship: `none` (default, plain follow), `wedge`, `line`, `column`, `sphere`. The choice is per pilot and is saved in `${EVEJS_DATA_ROOT}/mods/shipWing/wingFormations.json`; if the file cannot be written, the choice lasts until a restart (`(until restart, not saved)`). Set it in the window (`Formation:` row) or with `!wing formation <name>`.

- In combat and remote repair a copy holds its slot and acts only on targets in range. When mining, a copy mines from its slot while the rock is within module range minus `formationMineMarginMeters`, otherwise it flies to the rock.
- With a formation other than `none`, copies that end on a warp or gate jump launch again after landing or after the jump cloak drops (`formationRelaunchEnabled`, at most `formationRelaunchPerTick` per tick, given up after `formationRelaunchTimeoutMs`). Docking and logoff cancel the relaunch.
- Spacing `formationSpacingMeters`, farthest slot `formationMaxDistanceMeters` (keep it below `controlRangeMeters`).

## Boarding a copy

With `boardEnabled=true`, `!wing board [text]` or the `Brd` button boards your own copy within `boardRangeMeters` (at most 6550 m). The client greys out **Board Ship** on copies, so use the chat command or the button. The copy ends, the server launches the real ship from the bay at the copy's place and puts you in it. The ship keeps the copy's damage, the copy's drones go back to its drone bay, and ore goes to the host. The host stays empty in space. From then on it is a normal server ship. Your other copies end on the next tick, unless `boardOrphanEnabled` is on.

- **From the capsule** (`boardOrphanEnabled`). When you leave the host in the same scene, the copies hold next to the empty host for `boardOrphanGraceMs`. You can board them from your capsule within `boardHostRangeMeters` (5000 m) of the host and jump from copy to copy. Task orders are refused while the host is empty; `hold` and `return` work. Getting back into the host restores normal control.
- **Back to the host** (`boardBackStowEnabled`). Boarding the host again within 2500 m puts the empty ship back into its bay (within `boardBackStowMaxAgeMs`). The server refuses ships with ore or other cargo it does not allow in the bay; with `boardBackCargoUnloadEnabled` the mod first moves that cargo to the host's ore holds and Fleet Hangar (all or nothing, at most `boardBackCargoMaxStacks` stacks).
- **Scoop on a copy** (`scoopReturnEnabled`). "Scoop to Ship Maintenance Bay" on your living copy works as `return`.
- `boardResendRemoval` clears a leftover copy ball in your client after boarding.

## Losing a copy

- Launching needs the loss hook; without it every launch is refused (`LOSS_UNAVAILABLE`).
- A copy that disappears without combat (for example a GM command) counts as a loss without wreck or killmail (`lossOnMissingTwin=true`); with `false` the ship comes back.
- No insurance payout for a destroyed copy (`lossSkipInsurance=true`).
- The copy's wreck survives a restart (`durableWreck=true`).
- At start the mod settles losses left by the previous process: `lossSettle boot settled=... purged=... failed=...`.

## Configuration

Layers, the higher wins: defaults < `settings.json` (launcher) < `.env` in the mod folder < environment variables `EVEJS_SHIPWING_*` < `${EVEJS_DATA_ROOT}/mods/shipWing/settings.override.json` (ignored with `EVEJS_MOD_SETTINGS_OVERRIDES_IGNORE=1`). Every key with its range and default is in `.env.example`. A bad value keeps its default and prints a `config: warning` line; a bad `settings.json` or `enabled` value keeps the mod off with one `[ShipWing] not enabled - config error: ...` line.

Main keys:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. `false` = no hook at all (restart needed). |
| `maxWingPerPilot` | 2 | Copies out at once per pilot (1..10). |
| `controlRangeMeters` | 20000 | Copies further than this from the host are recalled after `outOfRangeGraceMs` (10000). |
| `recallRangeMeters` | 2500 | Distance at which a returning copy goes into the bay; `recallTimeoutMs` (60000) ends the return anyway. |
| `commandCooldownMs` | 2000 | Minimum time between two launches of one pilot. |
| `tickIntervalMs` | 500 | Mod tick (reaction to dock, jump, warp, logoff). |
| `guardMaxScannedIds` | 4096 | Item limit of one guarded move (see the warning). |
| `telemetryIntervalMs` | 600000 | `telemetry` log line, only when something changed, and at shutdown. |
| `chatTrigger` | `!wing` | Chat command prefix. |
| `clientWindowEnabled` | `false` | Client window. |
| `clientWindowMaxCommandsPerSecond` | 5 | Window calls per pilot per second. |
| `clientWindowMaxShipsPerCommand` | 20 | Ships in one window command. |
| `clientWindowMaxRows` | 30 | Rows in the window; copies in space are always listed. |
| `conditionWriteBack` | `true` | Copy damage goes back to the real ship. |
| `lossSettleRetryMs` / `lossSettleMaxAttempts` | 5000 / 20 | Loss settle retries. |
| `miningEnabled`, `combatEnabled`, `activeModulesEnabled`, `logiEnabled`, `activePropEnabled`, `ewarEnabled`, `dronesEnabled`, `salvageEnabled`, `commandMirrorEnabled`, `burstEnabled`, `npcAggroEnabled`, `cargoPanelEnabled`, `miningRealCargoEnabled`, `boardEnabled` | `false` | Feature switches (see Features). |
| `formationEnabled`, `miningOverflowCanEnabled`, `combatAutoTargetEnabled` | `true` | Feature switches that are on by default. |

State: `${EVEJS_DATA_ROOT}/mods/shipWing/wings.json` (Docker: volume `/var/lib/evejs`), never in the mod folder. A damaged file is moved aside as `wings.json.corrupt-<time>`.

## Docker

1. In `docker/entrypoint.sh`, in **both** `--require` blocks, add `--require /app/mods/shipWing/loader.js \` before `--require /app/mods/moonOreAnomalies/loader.js \`. Living New Eden stays last.
2. In `compose.yaml`, service `server`, `environment:`, add `EVEJS_SHIPWING_ENABLED: ${EVEJS_SHIPWING_ENABLED:-0}` (and the feature flags you want, for example `EVEJS_SHIPWING_CLIENT_WINDOW_ENABLED`). Set them in the root `.env`.
3. `docker compose build init`, then `docker compose up -d`.
4. `docker compose logs server | grep ShipWing` should show `probe passed (...)`, `bootSweep cleared=0 keptLost=0`, `guards installed (...)`, `chat installed (!wing launch|return|status in Local)` and `ready v0.2.0 ...`.

Without `EVEJS_SHIPWING_ENABLED=1` the mod logs nothing and installs no hook.


## License

MIT (`LICENSE`). Sources and patterns: `CREDITS.md`.
