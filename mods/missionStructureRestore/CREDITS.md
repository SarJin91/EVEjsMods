# Credits

- `loader.js`, `config.js`, `lib/viability.js`, `lib/wraps.js`, `test/run.js` -
  pattern of `mods/dailyGoalsPersist/` (this repository).
- `lib/objectiveMatch.js` - ported 1:1 from EveJS 261108.1
  `server/src/services/dungeon/dungeonUniverseSiteService.js`
  (`normalizeCompletionHints` objective targets part, `entityOrSpawnEntryMatchesObjectiveTarget`,
  `isObjectiveTargetSpawnEntry`, `isKillableStructureSpawnEntry`,
  `shouldKillableStructureBlockEncounterProgress` with the `hasNpcEntries` rule of
  `spawnEncounterPlan`, and the `toInt` / `normalizeText` / `normalizeLowerText` /
  `normalizeArray` helpers). `lib/restore.js` copies `normalizeIDList`, the
  progress flag step and the wave state membership fields of `spawnEncounterPlan`
  from the same file. EveJS license applies to these parts (see `server/` of the
  EveJS distribution).
