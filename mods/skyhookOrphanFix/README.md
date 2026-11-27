# Skyhook Orphan Fix (EveJS loader mod)

An Orbital Skyhook (type 81080) deployed at a planet outside sovereignty
null-sec (high-sec, low-sec) becomes known to the sovereignty state. Its window
opens with an inactive, empty state (no reagents) instead of failing with
`404 SKYHOOK_NOT_FOUND`. This is a workaround for an EveJS bug (EveJS 261028.1);
remove the mod once EveJS fixes it upstream.

## Why vanilla fails

- `sovStaticData.buildPlanetDefinitionsAndIndex()` builds
  `planetDefinitionsByPlanetID` for planets of `getSovNullSystems()` only.
- `sovModernState.bootstrapSkyhooksFromSystems()` skips a deployed Skyhook
  whose planet is not in that map (`if (!definition) continue;`), and
  `readDeployedSkyhookOrbitals()` filters on the same map.
- The launch path does not check security or sovereignty, so a Skyhook in
  high-sec deploys fine, but `requireSkyhookAccess()` answers 404 and the
  client raises `AttributeError: 'NoneType' object has no attribute 'active'`
  (`IsProductionActiveAtSkyhook`).

## What it does

A `Module._load` hook wraps the `getSovereigntyStaticSnapshot` export of
`services/sovereignty/sovStaticData.js` when it first loads (three vendor
modules destructure it). The returned snapshot keeps its identity; only the
`get` of its `planetDefinitionsByPlanetID` map is patched (an own property on
the same Map instance):

- a planet the vendor map knows: the vendor definition, unchanged;
- any other planet celestial (`worldData.getCelestialByID`, group 7):
  a frozen `{ planetID, solarSystemID, power: 0, workforce: 0, reagentDefinitions: [] }`;
- anything else: `undefined` (vanilla).

`has`, `keys`, `values`, `size`, the `planetDefinitions` list and the
definitions version are not touched, so the client definition list and the
sovereignty `resources` table stay vanilla. The vendor bootstrap then writes a
normal Skyhook row (no reagents, `workforceAmount: null`), and the gateway
answers `GetRequest` / `GetAllLocal` with 200. With no reagents: harvest
settles nothing, Extract refuses `SKYHOOK_NO_REAGENTS`, a raid link refuses
`SKYHOOK_SURPLUS_EMPTY`, switching offline/online is allowed. Like a vanilla
sov null-sec Skyhook on a power/workforce planet, the row still gets a silo
and theft windows.

Another mod (e.g. `planetaryDrill`) may chain its own `get` patch on top: load
it after this mod. This mod calls whatever `get` it found.

The mod has no own state and writes no table. Off, the next sovereignty
bootstrap removes these rows (they hold no stock) and vanilla 404 returns.

## Safety

- Nothing from `server/` is required at preload. The text probe
  (`lib/viability.js`) and the log lines run only when `sovStaticData` loads,
  so helper processes stay silent. A probe mismatch or a missing export =
  `DRIFT` line, no patch, vanilla behaviour.
- Every hook and wrapper is guarded; a mod error never reaches the server.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `EVEJS_SKYHOOKFIX_ENABLED` | `1` | whole mod on/off |
| `EVEJS_SKYHOOKFIX_NO_INSTALL` | unset | any value: the preload does nothing (tests) |

Layers: defaults < `mods/skyhookOrphanFix/.env` < environment. See `.env.example`.

## Deployment (Docker)

`docker/entrypoint.sh`, both `node` blocks:
`--require /app/mods/skyhookOrphanFix/loader.js` after `moonOreAnomalies`,
before `livingNewEden` (and before `planetaryDrill`). Expected log line:

```text
[skyhookOrphanFix] v1.0.0 active - wrapped sovStaticData.getSovereigntyStaticSnapshot (probe ok)
[skyhookOrphanFix] sov static snapshot patched (empty definition for non-sov planets)
```

## Tests

`node mods/skyhookOrphanFix/test/run.js` (or `RunTests.bat`). No server, no
game database; the real `sovStaticData`, `worldData` and `skyhookHarvest`
modules are loaded.

## Upstream bug report (text to submit)

> **Orbital Skyhook outside sov-null is deployable but unknown to the sovereignty gateway (window 404 + client exceptions)**
>
> Version: EveJS 261028.1, client V24.01.
>
> Steps: as a Station Manager of a player corporation in a high-sec system
> (e.g. 30003830 Orvolle), launch an Orbital Skyhook (81080) at a planet with an
> InterBus customs office. After onlining, the office is replaced by the
> Skyhook. Open the Skyhook window.
>
> Expected: the window opens without errors; with no reagent definition for a
> non-sov planet it shows an empty / inactive state.
>
> Actual: `eve_public.sovereignty.skyhook.api.GetRequest` answers 404
> `SKYHOOK_NOT_FOUND`; the client raises
> `AttributeError: 'NoneType' object has no attribute 'active'`
> (`sovereigntyResourceSvc.py IsProductionActiveAtSkyhook`) and
> `ValueError: need more than 3 values to unpack` (`skyhookWnd.py LoadProducing_thread`).
>
> Root cause: `sovStaticData.buildPlanetDefinitionsAndIndex()` builds
> `planetDefinitionsByPlanetID` only for `getSovNullSystems()`;
> `sovModernState.bootstrapSkyhooksFromSystems()` does
> `if (!definition) continue;` and `readDeployedSkyhookOrbitals()` filters on
> the same map, so the Skyhook never reaches `skyhooksByID` and
> `requireSkyhookAccess()` returns 404. The launch path
> (`orbitalLaunchRuntime.js`, `skyhookOfficeReplacement.js`) does not check
> security or sovereignty, so deployment and sovereignty disagree about where a
> Skyhook may exist.
>
> Suggested fix (either): A) refuse launching 81080 outside sov null-sec (as on
> Tranquility; strands Skyhooks already deployed elsewhere); B) register a
> deployed Skyhook at a planet without a sov definition with an empty
> definition (`reagentDefinitions: []`, `workforceAmount: null`), so
> `GetRequest`, `GetAllLocal` and the notices return a valid inactive Skyhook.
> We work around it locally with a loader mod implementing B.
