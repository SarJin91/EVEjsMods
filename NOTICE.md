# Notices and attribution

All mods in this repository are distributed under the GNU Affero General Public
License v3.0 (see `LICENSE`). They are loader mods for
[EveJS](https://github.com/V0nCleef/evejs), which is itself AGPL-3.0-only, and
several of them contain code ported from EveJS or from other projects listed
below. This file lists those sources per mod; a mod's `CREDITS.md`, where
present, gives the file-level details.

This project is not affiliated with, endorsed by or sponsored by CCP Games.
EVE Online and all related names, marks and data belong to CCP hf.

## Shared sources

| Source | Licence | Used for |
|---|---|---|
| [EveJS](https://github.com/V0nCleef/evejs) server (versions 0.12.9 to 261115.2), distributed with the [EveJS Launcher](https://github.com/V0nCleef/evejs-launcher) | AGPL-3.0-only | Small helpers and predicates ported from EveJS so a mod reproduces EveJS behaviour exactly; data shapes and seams read from EveJS sources. Used by most mods. |
| EVE Online Static Data Export (SDE) build 3396210, CCP Games ([developers.eveonline.com](https://developers.eveonline.com/static-data)) | CCP developer licence / EULA | Generated data tables (names, type, blueprint, dogma and map facts). No SDE file is shipped. |

## livingNewEden

| Source | Licence | Used for |
|---|---|---|
| [X-Eve Living Universe](https://github.com/kaiwren986/evejs-living-universe) v0.2.2 | MIT (original patch contributions only, notice below) | Ported or adapted: deterministic hashing and RNG, ledger fingerprinting, deadline queue, work budget, telemetry percentiles, load governor, route search, warp travel model, conflict materialization flow; ideas for gate camps, salvage, NPC buy orders and wormhole routes. |
| EveJS | AGPL-3.0-only | Seams and ported helpers (NPC spawn, chat/XMPP presence format, incursions, ESS, fighters, sentries, liberation rewards and others). |
| [Elysian Universe Site Seeder](https://github.com/Alanahwellordered661/elysian-universe-site-seeder-eve-online-evejs) and EveJS content packs | AGPL-3.0 | Site generation reference; site and archaeology data read from the EveJS content packs. |
| [Eve Fleet Simulator](https://github.com/MaruMaruOO/eve-fleet-simulator) | AGPL-3.0 | Research reference for the battle resolver calibration only. No EFS code is included. |
| Advanced Utility Drones 1.0.3 (EveJS mod) | AGPL-3.0 | Idea for plain chat replies; settings panel pattern. No code copied. |
| EVE SDE build 3396210 | CCP | `data/mapNames.json`, strength, hull, capital, commodity and industry catalogs under `lib/**/data/`. |
| [Fuzzwork Market](https://market.fuzzwork.co.uk/) (CCP market data via ESI) | CCP data | Optional Jita price lookup at run time. No data shipped. |
| [Piper TTS](https://github.com/OHF-Voice/piper1-gpl) and [piper-voices](https://huggingface.co/rhasspy/piper-voices) | GPL-3.0-or-later / per-voice licences | Optional ship AI voice. Piper runs as a separate HTTP service that you install yourself; it is not included or linked. |

## shipWing

| Source | Licence | Used for |
|---|---|---|
| EveJS | AGPL-3.0-only | Remote repair display spec shape; jetcan creation without a session (ported with changes). |
| livingNewEden (this repository) | AGPL-3.0 | Boot wrapper and loader pattern. |
| Advanced Utility Drones 1.0.3, DroneClassBalance 0.2.3, MoonOreAnomalies 0.5.3 (EveJS mods by their authors) | AGPL-3.0 | Patterns only (chat reply, client delivery, handshake tail). No code copied. |

## hotPathPerf

| Source | Licence | Used for |
|---|---|---|
| EveJS | AGPL-3.0-only | Ported 1:1 so results match EveJS: dungeon instance summary, blueprint list by owner, native wreck list, structure helpers, sovereignty capture and cyno helpers, incursion tale filters. |
| scenePerfFix, livingNewEden (this repository) | AGPL-3.0 | Loader pattern, session location rule. |

## scenePerfFix, dailyGoalsPersist, marketAllRegions

Own code. Seams read from EveJS sources (AGPL-3.0-only); no third-party code.

## industryOrphanCleanup

| Source | Licence | Used for |
|---|---|---|
| EveJS | AGPL-3.0-only | The repair rule mirrors `getRecoverableIndustrySourceIntent` in `industryRuntimeState.js`. |

## missionStructureRestore

| Source | Licence | Used for |
|---|---|---|
| EveJS 261108.1 | AGPL-3.0-only | `lib/objectiveMatch.js` and parts of `lib/restore.js` are ported 1:1 from `services/dungeon/dungeonUniverseSiteService.js`. |

## skyhookOrphanFix, planetaryDrill

| Source | Licence | Used for |
|---|---|---|
| EveJS | AGPL-3.0-only | Planet definition, planet meta and orbital launch shapes mirrored from EveJS sovereignty and planet services (read, not copied). |

## customTypes

| Source | Licence | Used for |
|---|---|---|
| EveJS | AGPL-3.0-only | Blueprint definition fields; contract, industry and item APIs. |
| Elysian Item Forge, Elysian FSD Workbench, Serenity Importer (tools shipped with EveJS) | as shipped with EveJS | The client tool `client/apply_client_data.py` calls them and ports small parts (record cloning, dogma rewrite, icon checks). The tools themselves are not included; the client tool uses the copy in your EveJS installation. |
| livingNewEden (this repository) | AGPL-3.0 | NPC corporation contract issuer for the blueprint shop. |
| EVE SDE build 3396210 | CCP | Values in the `data/*.json` packs. |

## blueprintDrops

| Source | Licence | Used for |
|---|---|---|
| EveJS | AGPL-3.0-only | Wraps the NPC loot roll and the salvage container transfer. |
| EVE SDE build 3396210 | CCP | `data/factionLoot.json`, `data/pirateNpcGroups.json`. |

## X-Eve Living Universe MIT notice

The following notice covers the code in `mods/livingNewEden` that is ported or
adapted from X-Eve Living Universe.

```text
MIT License - Original Patch Contributions Only

Copyright (c) 2026 X-Eve Living Universe patch contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of the original contributions contained in this patch repository (the
"Patch Contributions"), to deal in the Patch Contributions without
restriction, including without limitation the rights to use, copy, modify,
merge, publish, distribute, sublicense, and/or sell copies of the Patch
Contributions, and to permit persons to whom the Patch Contributions are
furnished to do so, subject to the following conditions:

The above copyright notice, this permission notice, and the scope notice below
shall be included in all copies or substantial portions of the Patch
Contributions.

THE PATCH CONTRIBUTIONS ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE PATCH CONTRIBUTIONS OR THE USE
OR OTHER DEALINGS IN THE PATCH CONTRIBUTIONS.

Scope and third-party notice
----------------------------

This license applies only to original contributions authored for the X-Eve
Living Universe patch, and only to the extent that the contributors have the
right to license those contributions. It does not license or redistribute any
compatible server source baseline, an EVE Online client, CCP Games assets,
trademarks, databases, or any other third-party material. Applying the patch
requires a separately obtained compatible v0.12.3.1 installation, whose own terms
continue to apply.

This independent project is not affiliated with, endorsed by, or sponsored by
CCP Games or any upstream server project. EVE Online and related trademarks
belong to CCP Games. All other third-party names and marks belong to their
respective owners.
```
