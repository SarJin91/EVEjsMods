# EVEjsMods

A collection of server mods for [EveJS](https://github.com/V0nCleef/evejs), the
EVE Online server emulator. All mods are Node.js loader mods: they hook EveJS
at startup and change no EveJS file.

[Polska wersja](README.pl.md)

## Mods

| Mod | Version | What it does |
|---|---|---|
| [livingNewEden](mods/livingNewEden/README.md) | 0.1.0 | A living universe: NPC factions hold territory, move fleets, run an economy and fight wars while you play. |
| [shipWing](mods/shipWing/README.md) | 0.2.0 | Launch copies of the fitted ships in your current ship's Ship Maintenance Bay (any hull) as a wing that follows you; docked, it lists the bay read-only. Test build, off by default. |
| [hotPathPerf](mods/hotPathPerf/README.md) | 0.24.1 | Measures slow EveJS calls; optional fixes for long server stalls. |
| [scenePerfFix](mods/scenePerfFix/README.md) | 1.0.0 | Faster busy systems on older EveJS builds (resting wrecks, name lookups). Mostly inactive on 261115.2. |
| [planetaryDrill](mods/planetaryDrill/README.md) | 1.1.0 | An Orbital Skyhook outside sov null-sec mines a planet P0 resource. Needs skyhookOrphanFix and customTypes. |
| [customTypes](mods/customTypes/README.md) | 1.0.0 | Custom item types and industry blueprints from data packs, with a client data tool. |
| [blueprintDrops](mods/blueprintDrops/README.md) | 1.0.0 | NPC wrecks can hold blueprints; optional pirate resonators and faction loot. |
| [dailyGoalsPersist](mods/dailyGoalsPersist/README.md) | 1.0.0 | Daily goal progress and claims survive a server restart. |
| [industryOrphanCleanup](mods/industryOrphanCleanup/README.md) | 1.0.0 | Removes leftover blueprint state records after a character deletion. |
| [marketAllRegions](mods/marketAllRegions/README.md) | 1.0.0 | The market window lists orders from every region (trading stays regional). |
| [missionStructureRestore](mods/missionStructureRestore/README.md) | 1.0.0 | Restores mission objective structures lost on a server restart. |
| [skyhookOrphanFix](mods/skyhookOrphanFix/README.md) | 1.0.0 | Skyhooks outside sov null-sec open their window instead of a 404. |

## Requirements

- EveJS **261115.2** (the version in `server/package.json`). Other versions
  may work, but are not tested; each mod checks the EveJS code it hooks and
  stays inactive (`DRIFT` in the log) if it does not match.
- EVE Online client build **3396210** (the build EveJS supports).
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

   Keep this order between the mods of this collection: scenePerfFix,
   hotPathPerf, shipWing, blueprintDrops, marketAllRegions, dailyGoalsPersist,
   industryOrphanCleanup, skyhookOrphanFix, customTypes, planetaryDrill,
   missionStructureRestore, livingNewEden (its `loader.js` last).
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

Tests, benchmarks and data generators stay in the development tree; the
published mods contain the runtime files, documentation and a few operator
tools (Living New Eden `tools/`).

## Configuration

Each mod reads, from lowest to highest priority:

1. its built-in defaults;
2. `settings.json` in the mod folder, written by the launcher **Configure**
   dialog (mods that have one);
3. `.env` in the mod folder (copy `.env.example`; every key is documented there);
4. environment variables (in Docker: the `environment:` of the server service).

Changes apply after a server restart. API keys (Living New Eden AI features)
are read only from `.env` or the environment; none ship with the mods.

## Known issues

- **customTypes:** keep the blueprint shop off on EveJS 261115.2
  (`EVEJS_CUSTOMTYPES_SHOP_ENABLED=0`) until a fix is released. Custom types
  and blueprints work without it.
- **livingNewEden:** the in-game job board and map windows need a second
  preload, `mods/livingNewEden/clientHook.js`, placed before shipWing. The
  launcher preloads only `loader.js`, so those two windows work only with the
  Docker or manual setup.

## Licence

AGPL-3.0, see [`LICENSE`](LICENSE). Upstream sources and their licences
(EveJS, X-Eve Living Universe, Elysian Site Seeder, CCP data) are listed in [`NOTICE.md`](NOTICE.md).

Not affiliated with CCP Games. EVE Online is a trademark of CCP hf.
