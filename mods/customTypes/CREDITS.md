# Credits

- `loader.js`, `config.js`, `lib/viability.js` - pattern of `mods/skyhookOrphanFix/`
  and `mods/industryOrphanCleanup/` (this repository).
- `lib/pack.js` - the blueprint definition fields mirror `industryBlueprints` rows built by
  EveJS `tools/DatabaseCreator/database-creator.js` (read only, not copied).
- `client/fsd/` - ported from Elysian FSD Workbench and Elysian Item Forge (shipped with EveJS,
  `../../tools/ElysianFSD`, `../../tools/ElysianItemForge`; EveJS is AGPL-3.0, so these files carry
  `SPDX-License-Identifier: AGPL-3.0-only`): `cfsd.py` from `elysian_fsd/cfsd_shadow.py`
  (integer-keyed shadow buckets, content hash, `clone_integer_record`, `rewrite_integer_record`),
  `items.py` from `elysian_fsd/item_encoding.py` (`ItemCloneRequest`, `_patch_types`,
  `_patch_dogma`, `_patch_icon_file`, `append_type_dogma_attributes`), `resource_index.py` from
  `elysian_fsd/resource_index.py` and `hashing.py`, `localization.py` from
  `elysian_item_forge/localization.py`, `native_loader.py` from `elysian_fsd/native_loader.py`
  (key probes only), `profile.py` discovery from `elysian_fsd/discovery.py` and the mutation proof
  from `elysian_fsd/item_verification.py` (item tables only). `client/profiles/build-3396210.json`
  takes its table values from `tools/ElysianFSD/profiles/build-3396210/profile.json` and the item
  encoder proof of that build; `build-3724492.json` was derived by `ApplyClientData.bat profile`.
- `client/apply_client_data.py` - `content_path` follows Item Forge `deployment._content_path`;
  the SQLite merge follows Serenity Importer `auxiliary._merge_skin_cache_once`
  (`../../tools/SerenityImporter`). The type and message ID ranges follow Item Forge
  `allocation.py`.
- `client/apply_client_data.py` dogma overlay (`apply_smb_overlay`, `_set_dogma_attributes`) -
  the record mutation follows Elysian FSD `item_encoding.append_type_dogma_attributes` (vector
  rewrite sorted by attribute ID) and `_patch_dogma` (overwrite of an existing value); the batch
  uses `_split`, `_shadow_existing_bucket` and `_finish` of `client/fsd/cfsd.py` exactly as
  `rewrite_integer_record` does, with one content hash for the whole table. Ship list and volumes
  from the EVE Online SDE of the client build (`groups.jsonl`, `types.jsonl`; read at run time,
  not shipped).
- `client/apply_client_data.py` pack v2 - `clone_integer_records` runs `clone_record_in_body`
  (port of Elysian FSD `cfsd_shadow.clone_integer_record` without its `_split` / `_finish`) once
  per table; `compile_tables` follows `item_encoding.ItemFsdEncoder.compile` and calls the
  mutators `_patch_types`, `_patch_dogma`, `_patch_icon_file`; `load_icon` follows Elysian Item
  Forge `icons.validate_icon` (64x64 RGBA PNG); the icon record and payload follow Item Forge
  `compiler.py` / `deployment.py`.
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
