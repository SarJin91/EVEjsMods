# EVEjsMods

A collection of server mods for [EveJS](https://github.com/V0nCleef/evejs), the
EVE Online server emulator. All mods are Node.js loader mods: they hook EveJS
at startup and change no EveJS file.

[Polska wersja](README.pl.md)

## Mods

| Mod | Version | What it does |
|---|---|---|
| [livingNewEden](mods/livingNewEden/README.md) | 0.2.1 | A living universe: NPC factions hold territory, move fleets, run an economy and fight wars while you play; civilian traffic, miners, ratters and explorers fill the systems around you. |
| [shipWing](mods/shipWing/README.md) | 0.2.2 | Launch copies of the fitted ships in your current ship's Ship Maintenance Bay (any hull) as a wing that follows you; docked, it lists the bay read-only. Test build, off by default. |
| [hotPathPerf](mods/hotPathPerf/README.md) | 0.24.2 | Measures slow EveJS calls; optional fixes for long server stalls. |
| [sharedStorePerfFix](mods/sharedStorePerfFix/README.md) | 1.1.0 | Keeps the structures table save linear at startup (one SQLite planner statistic) and skips sovereignty mirror saves that change nothing. Workaround for EveJS bugs, changes no data. |
| [scenePerfFix](mods/scenePerfFix/README.md) | 1.0.0 | Faster busy systems on older EveJS builds (resting wrecks, name lookups). Mostly inactive on current EveJS. |
| [planetaryDrill](mods/planetaryDrill/README.md) | 1.1.0 | An Orbital Skyhook outside sov null-sec mines a planet P0 resource. Needs skyhookOrphanFix and customTypes. |
| [customTypes](mods/customTypes/README.md) | 1.0.0 | Custom item types and industry blueprints from data packs, with a client data tool. |
| [blueprintDrops](mods/blueprintDrops/README.md) | 1.0.0 | NPC wrecks can hold blueprints; optional pirate resonators and faction loot. |
| [dailyGoalsPersist](mods/dailyGoalsPersist/README.md) | 1.0.0 | Daily goal progress and claims survive a server restart. |
| [industryOrphanCleanup](mods/industryOrphanCleanup/README.md) | 1.0.0 | Removes leftover blueprint state records after a character deletion. |
| [marketAllRegions](mods/marketAllRegions/README.md) | 1.0.0 | The market window lists orders from every region (trading stays regional). |
| [missionStructureRestore](mods/missionStructureRestore/README.md) | 1.0.0 | Restores mission objective structures lost on a server restart. |
| [skyhookOrphanFix](mods/skyhookOrphanFix/README.md) | 1.0.0 | Skyhooks outside sov null-sec open their window instead of a 404. |

## Requirements

- EveJS **261126.2** (the version in `server/package.json`). Other versions
  may work, but are not tested; each mod checks the EveJS code it hooks and
  stays inactive (`DRIFT` in the log) if it does not match.
- EVE Online client build **3724492** (the build EveJS supports).
- Node.js as required by EveJS.

## Installation

Pick one of the three ways. Every mod is a folder under `mods/` of your EveJS
installation; the folder name must stay as in this repository. The release
ZIPs contain the mod folder with its loader disabled (`loader.js.disabled`), as
the launcher expects. For Docker or a manual install either copy the folder
from this repository, or rename `loader.js.disabled` to `loader.js` after
unpacking a ZIP.

### a) EveJS Launcher

1. Download `<Mod>-<version>.zip` from the
   [Releases](https://github.com/SarJin91/EVEjsMods/releases) page.
2. In the launcher open **Mods -> Add ZIP** and pick the file. The mod is added
   disabled.
3. Turn it on and use **Apply & Restart Server**.

Each mod declares this repository as its update source, so **Check mod
updates** in the launcher offers newer releases. Updates in the launcher keep
the `settings.json` written by **Configure**, but not a `.env` file inside the
mod folder: back it up before updating, or use environment variables.

### b) Docker

1. Copy the mod folder (for example `mods/livingNewEden`) into the `mods/`
   folder of your EveJS checkout.
2. In `docker/entrypoint.sh` add a line to **both** `node` blocks:

   ```sh
   --require /app/mods/<folder>/loader.js \
   ```

   Keep this order between the mods of this collection: sharedStorePerfFix,
   scenePerfFix, hotPathPerf, shipWing, blueprintDrops, marketAllRegions,
   dailyGoalsPersist, industryOrphanCleanup, skyhookOrphanFix, customTypes,
   planetaryDrill, missionStructureRestore, livingNewEden (its `loader.js`
   last).
3. Rebuild the image and restart: `docker compose build`, then
   `docker compose up -d`.

Keep the mod's persistent data in the data volume (`EVEJS_DATA_ROOT`), not in
the mod folder.

### c) Native, by hand

Copy the mod folder into `mods/` of your EveJS folder and start the server
with the loader preloaded, from the `server` folder:

```sh
node --require ../mods/<folder>/loader.js .
```

Several mods: one `--require` per mod, in the order above. This is what the
launcher does for a native start. A mod copied by hand may need **Adopt** in
the launcher before the launcher can manage it.

The mod folders in this repository are the full development tree: runtime
files, documentation, tests (`test/`, `RunTests.bat`), data generators and
operator tools (`tools/`). Tests, generators and tools are not needed to run a
mod. The release ZIPs leave out the tests (`test/`, `RunTests.bat`); some
developer tools that read test scenarios need a clone of this repository.

## Configuration

Each mod reads, from lowest to highest priority:

1. its built-in defaults;
2. `settings.json` in the mod folder, written by the launcher **Configure**
   dialog (mods that have one). `settings.example.json`, where present, shows
   the format;
3. `.env` in the mod folder (copy `.env.example`; every key is documented there);
4. environment variables (in Docker: the `environment:` of the server service).

Changes apply after a server restart. API keys (Living New Eden AI features)
are read only from `.env` or the environment; none ship with the mods.

## Known issues

- **customTypes:** keep the blueprint shop off on current EveJS
  (`EVEJS_CUSTOMTYPES_SHOP_ENABLED=0`) until a fix is released. Custom types
  and blueprints work without it.
- **livingNewEden:** the in-game job board and map windows need a second
  preload, `mods/livingNewEden/clientHook.js`, placed before shipWing. The
  launcher preloads only `loader.js`, so those two windows work only with the
  Docker or manual setup.

## Contributing

Pull requests are welcome; please read [`CONTRIBUTING.md`](CONTRIBUTING.md)
first. Branch from the current `main`, keep new features behind a flag that is
off by default, and keep the suite of every mod you touch green.

## Acknowledgements

- **greatguy** (EveJS Discord, [EJS]) - thank you for the ideas and the code
  shared with the community in the Living New Eden packages. What landed in
  Living New Eden from them:
  - durable table flushes, the launcher load order (`loadAfter`), the labels
    of the load governor settings and the sentry deploy timing log (package
    for EveJS 261125.3);
  - gate JumpIn / JumpOut effects of civilian traffic;
  - align before the warp of civilian traffic;
  - mining beams on civilian miners;
  - civilian haulers fleeing by warp after player aggression, and civilians
    near an attacked civilian fleeing too;
  - NPC capsules warping out after a ship is wrecked;
  - gate controller Arrival / Departure events;
  - miners approaching their rock at subwarp before the beam;
  - population activity events (ratting, exploring);
  - civilian ratters patrolling belts;
  - civilian explorers visiting public data and relic sites;
  - a visible warp effect for the instant warps of civilian traffic;
  - the arrival pose at a gate (a ship that jumps in stands still, turned
    away from its first target, before it aligns).

  The new civilian behaviours and effects are off by default. The file-level
  attribution is in
  [`mods/livingNewEden/CREDITS.md`](mods/livingNewEden/CREDITS.md).
- [EveJS](https://github.com/V0nCleef/evejs) and the
  [EveJS Launcher](https://github.com/V0nCleef/evejs-launcher)
  (AGPL-3.0-only) - the server these mods run on; small helpers are ported
  from it so the mods behave exactly like EveJS.
- [X-Eve Living Universe](https://github.com/kaiwren986/evejs-living-universe)
  (MIT, original patch contributions) - deterministic hashing and RNG, ledger
  fingerprints, the deadline queue, work budgets, telemetry percentiles, the
  load governor, route search, the warp travel model and the conflict
  materialization flow of Living New Eden, plus ideas for gate camps,
  salvage, NPC buy orders and wormhole routes.
- [Elysian Universe Site Seeder](https://github.com/Alanahwellordered661/elysian-universe-site-seeder-eve-online-evejs)
  (AGPL-3.0) and the EveJS content packs - site generation reference and site
  data.
- [Eve Fleet Simulator](https://github.com/MaruMaruOO/eve-fleet-simulator)
  (AGPL-3.0) - research reference for the battle resolver calibration; no
  code included.
- [zKillboard](https://zkillboard.com/) killmail dumps (killmail data by CCP
  Games via ESI) - used offline to calibrate the battle resolver; no killmail
  data ships with the mods.
- [Fuzzwork Market](https://market.fuzzwork.co.uk/) - optional Jita price
  lookup at run time.
- [Piper TTS](https://github.com/OHF-Voice/piper1-gpl) and
  [piper-voices](https://huggingface.co/rhasspy/piper-voices) - optional ship
  AI voice, run as a separate service you install yourself.
- Advanced Utility Drones, DroneClassBalance and MoonOreAnomalies (EveJS mods
  by their authors) and the ciefa EveJS fork - patterns and references (chat
  replies, client delivery, settings panel, read-only templates); no code
  copied unless a mod's `CREDITS.md` says so.
- CCP Games - the EVE Online Static Data Export (build 3396210) behind the
  generated data tables.

Each mod's `CREDITS.md` lists its sources file by file; the licences are
summarised in [`NOTICE.md`](NOTICE.md).

## Licence

AGPL-3.0, see [`LICENSE`](LICENSE). Upstream sources and their licences
(EveJS, X-Eve Living Universe, Elysian Site Seeder, CCP data) are listed in [`NOTICE.md`](NOTICE.md).

Not affiliated with CCP Games. EVE Online is a trademark of CCP hf.
