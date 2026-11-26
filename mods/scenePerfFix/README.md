# scenePerfFix

An EveJS loader mod that speeds up crowded systems. It does not change gameplay.

## Problem (CPU profile, 2026-10-20)

In a system with 164 wrecks after salvaging, a scene tick took ~10 s (p95) and the server used 100% of one core:

- **61% of the time: the scene movement plan.** `scene/tick.js:2436` calls `advanceEntityForActiveSceneTick` for every object. Each call (`destinyMovementEngine.js:804`) checks and recomputes the movement plan of the whole scene (`nativeSubwarp.js`), so the cost grows as N², stationary wrecks included.
- **15% of the time: wreck type by name.** For every killed NPC, `wreckUtils.js:332` calls `itemTypeRegistry.resolveItemByName`. When the name does not match exactly, it computes the Levenshtein distance to every type, from scratch each time.

## What the mod does

1. **Stationary wrecks out of the movement plan.** On the first object of a tick the mod removes from the plan every wreck in the STOP state with zero speed. It does this with the EveJS function `markEntityMovementAdvancedForActiveTick`, the same one the tractor beam uses. A moving wreck (tractored, pushed) is computed normally.
2. **Cache of type lookups by name.** The same (name, options) returns the same result from the cache (entry limit in the config).

It does not modify `server/**` files: a `Module._load` hook replaces the exports before `tick.js` and `wreckUtils.js` destructure them. After 60 s the log shows `probe: passed` or `DRIFT: …`. Every `statsLogMinutes` minutes it prints statistics. EveJS helper processes (chatEdge, redshiftEdge, walletAuthority, imageEdge, durableScheduler), which load nothing from `server/src/space/`, log neither the probe nor statistics.

## EveJS 261028.1 and newer

Upstream removed both hot paths itself. Movement is computed by Destiny Evolve (`space/destiny/simulation/evolve.js`) in a few O(N) passes per tick. `advanceEntityForActiveSceneTick` and `nativeSubwarp.js` are gone. `wreckUtils.js` looks up the wreck type with `{ exactOnly: true }` and has its own cache. When `destinyMovementEngine` has neither of the two functions, the "stationary wrecks" part is inactive: the log then shows a "not needed" line for stationary wrecks and `probe: passed` with the stationary wrecks part marked inactive, not DRIFT. The name cache still works but gains little. On these EveJS versions the mod can be removed from the load order once you have confirmed the tick time without it.

## Configuration

`settings.json` or environment variables (they win), see `.env.example`: `skipInertWrecks`, `inertKinds`, `inertSpeedEpsilon`, `cacheItemNameLookups`, `itemNameCacheMax`, `statsLogMinutes`.
