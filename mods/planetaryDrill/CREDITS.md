# Credits

- `loader.js`, `config.js`, `lib/viability.js` — pattern of
  `mods/skyhookOrphanFix/` and `mods/dailyGoalsPersist/` (this repository).
- `lib/overlay.js` — the planet definition row mirrors the shape of
  `buildPlanetDefinitionFromSource` in EveJS
  `server/src/services/sovereignty/sovStaticData.js`; the pending-deployment
  rule mirrors `isSkyhookDeploymentPending` in
  `server/src/services/planet/planetOrbitalState.js` (read only, not copied).
- `lib/vendor.js` — the planet meta mirrors `getPlanetMeta` in EveJS
  `server/src/services/planet/planetMgrService.js` (read only, not copied).
- `lib/launch.js` — the session context mirrors `getSessionContext` and the
  client sync mirrors `syncInventoryChange` in EveJS
  `server/src/services/ship/orbitalLaunchRuntime.js` (read only, not copied).
  No new external sources.
