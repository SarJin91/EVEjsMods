# Credits

- `loader.js`, `config.js`, `lib/viability.js` - pattern of `mods/skyhookOrphanFix/`
  and `mods/industryOrphanCleanup/` (this repository).
- `lib/pack.js` - the blueprint definition fields mirror `industryBlueprints` rows built by
  EveJS `tools/DatabaseCreator/database-creator.js` (read only, not copied).
- `client/apply_client_data.py` - uses Elysian Item Forge and Elysian FSD Workbench
  (`tools/ElysianItemForge`, `tools/ElysianFSD`, shipped with EveJS): `ItemFsdEncoder`,
  `NativeLoaderHost`, `ResourceIndex`, localization patching. `content_path` follows
  Item Forge `deployment._content_path`; the SQLite merge follows Serenity Importer
  `auxiliary._merge_skin_cache_once` (`tools/SerenityImporter`).
- `client/apply_client_data.py` dogma overlay (`apply_smb_overlay`, `_set_dogma_attributes`) -
  the record mutation follows Elysian FSD `item_encoding.append_type_dogma_attributes` (vector
  rewrite sorted by attribute ID) and `_patch_dogma` (overwrite of an existing value); the batch
  uses `cfsd_shadow` `_split`, `_shadow_existing_bucket` and `_finish` exactly as
  `rewrite_integer_record` does, with one content hash for the whole table (`tools/ElysianFSD`,
  shipped with EveJS). Ship list and volumes from the EVE Online SDE 3396210 (`groups.jsonl`,
  `types.jsonl`; read at run time, not shipped).
- `client/apply_client_data.py` pack v2 - `_clone_record_in_body` / `clone_integer_records` are a
  port of Elysian FSD `cfsd_shadow.clone_integer_record` without its `_split` / `_finish` (one per
  table); `compile_tables` follows `item_encoding.ItemFsdEncoder.compile` and calls its mutators
  `_patch_types`, `_patch_dogma`, `_patch_icon_file`; `load_icon` follows Elysian Item Forge
  `icons.validate_icon` (64x64 RGBA PNG); the icon record and payload follow Item Forge
  `compiler.py` / `deployment.py` (`tools/ElysianFSD`, `tools/ElysianItemForge`, shipped with EveJS).
- `lib/shop/issuer.js` - port of `mods/livingNewEden/lib/adapter/corpContractIssuer.js`
  (this repository, Living New Eden; own marker symbol, the original is unchanged).
  `lib/shop/vendor.js` `createListing` / `deleteListing` follow `buildWantToSellCall`,
  `createWantToBuyFrom` and `deleteTradeContractFrom` of
  `mods/livingNewEden/lib/adapter/tradeContracts.js` (same repository). The shop calls the
  EveJS contract, industry and item APIs (read only, not copied).
- `tools/genPiBlueprints.js` / `data/pi-blueprints.json` - generated from the EVE Online
  Static Data Export 3396210 (CCP Games, static data; `planetSchematics.jsonl`, `types.jsonl`),
  used only as generator input. No SDE file is shipped with the mod.
- `data/listening-post.json` - source values (Scanner Array 16216 typeDogma, group 709, Scanner
  Array Blueprint 2821 copying / research / max runs, icon 24666) read from the EVE Online Static
  Data Export 3396210 (CCP Games, static data; `typeDogma.jsonl`, `groups.jsonl`,
  `blueprints.jsonl`, `icons.jsonl`); hand-written pack.
- `data/heavy-sentries.json` - source values (large battery typeDogma 16689/16692/16694/17773,
  vanilla blueprints 2805/2804/2830/2822 copying / research / max runs) read from the EVE Online
  Static Data Export 3396210 (CCP Games, static data; `typeDogma.jsonl`, `blueprints.jsonl`); type
  names and groups of the sources from the public EVE Swagger Interface (`/universe/types/`);
  hand-written pack.
