# Custom Types (EveJS loader mod)

Server half of custom item types and their industry blueprints. Each pack in
`data/*.json` (loaded in file-name order) declares types cloned from an
existing type and, optionally, blueprint definitions for them. The mod adds
them in memory when EveJS starts; no EveJS table is written. The client half
(type row, name, blueprint activity data) is written by the operator with
`client/ApplyClientData.bat` from the same pack files (`client/README.md`).

Off by default. Shipped packs:

- `data/pi-blueprints.json`: **68 blueprints, one per SDE planet schematic**,
  typeID = 340300 + schematicID (340365-340435; P1 15, P2 24, P3 21, P4 8).
  Manufacturing only: schematic inputs -> materials, output x quantity ->
  product, cycleTime -> time; skills Industry 1/2/3/4 (P1-P4) plus Advanced
  Industry 1 (P3) or 3 (P4); max 100 runs. Type = clone of Spatial Attunement
  Unit Blueprint 33196 (group 447 Construction Component Blueprints) with the
  product's icon, no market group. **Generated** by `tools/genPiBlueprints.js`
  - do not edit by hand (see "Regenerating PI blueprints"). Example: Bacteria
  Blueprint 340431 (3000 Microorganisms -> 20 Bacteria, 1800 s, Industry I).
- `data/planetary-drill.json`: **Planetary Drill 340100** (clone of Orbital
  Skyhook 81080) and **Planetary Drill Blueprint 340101** (clone of Spatial
  Attunement Unit Blueprint 33196 like the PI blueprints, `groupID` 1045
  Sovereignty Structure Blueprint = the Orbital Skyhook Blueprint group; not a
  clone of 81086, which has no `typeDogma` record the client encoder could
  clone). Manufacturing = Vexor Blueprint 971 at ME0: Tritanium 540000,
  Pyerite 180000, Mexallon 36000, Isogen 10000, Nocxium 1500, Zydrine 350,
  Megacyte 140; 12000 s, Industry I, max 10 runs; copy 9600 s, ME/TE research
  4200 s; no invention. The `planetaryDrill` mod turns the item into an
  Orbital Skyhook 81080 at launch. 32 types: 340100 is "auto" (the planet's
  highest-quality P0), plus **15 Planetary Drill (<P0>) variants
  340102-340116** (clones of 81080, one per P0; the launched item fixes the
  P0, a launch at a planet without it is refused) and their **blueprints
  340202-340216** (= 340101 with the product swapped). 16 blueprints in total.
- `data/mobile-sentries.json`: **4 Mobile Sentry types 340500-340503** and
  **their blueprints 340510-340513** (8 types, 4 blueprints; typeID range
  3405xx). Each sentry is a clone of a small starbase battery **without a group
  change** (category 23, so EveJS serves its shooting, ammunition and
  destruction): 340500 Projectile <- Small Artillery Battery 16631, 340501
  Hybrid <- Small Railgun Battery 16690, 340502 Laser <- Small Beam Laser
  Battery 17167, 340503 Missile <- Cruise Missile Battery 16696. Ammunition is
  the battery's own (medium projectile / medium hybrid / medium crystals /
  cruise missiles). The blueprints are clones of 33196 with the battery
  blueprint group (854/855/853/871, category 9); copying, research, time
  and max runs = the vanilla battery blueprints 2816/2815/2826/2823: 6000 s,
  max 30, copy 4800 s, ME/TE 2100 s (Missile: 12000 s, max 10, copy 9600 s,
  ME/TE 4200 s); Industry V; no invention. Manufacturing takes plain highsec
  minerals only = the SDE ME0 minerals of the T1 weapon
  (Tritanium/Pyerite/Mexallon) + a fixed core block of 5000 Tritanium, 2500
  Pyerite, 600 Mexallon:

  | Blueprint | Product | Tritanium (34) | Pyerite (35) | Mexallon (36) |
  |---|---|---|---|---|
  | 340510 | Mobile Sentry (Projectile) 340500 | 7729 | 2648 | 771 |
  | 340511 | Mobile Sentry (Hybrid) 340501 | 7729 | 2648 | 771 |
  | 340512 | Mobile Sentry (Laser) 340502 | 7200 | 3309 | 621 |
  | 340513 | Mobile Sentry (Missile) 340503 | 8258 | 5426 | 707 |

  Existing blueprint items keep their ME/TE and runs when a recipe changes;
  new jobs use the new recipe after a server restart. The shop sells them in
  price class `default`. No fuel and no control tower; anchoring and the
  shooting rules come from the Living New Eden mod; without it the item is
  only a battery clone.
- `data/officer-blueprints.json`: **593 blueprints, one per published officer
  module** (SDE metaGroupID 5) whose parent (`variationParentTypeID`) has a
  faction or deadspace variant; typeIDs **341000-341592** (range
  341000-341999, fixed per officer in `tools/officer-blueprints.spec.json`
  `allocations`). Manufacturing only, 1 run per blueprint (no copying,
  research or invention); Industry V + Advanced Industry V. Recipe: the
  faction and the deadspace variant x1 each (only one of them: x2), the T2
  variant x3 (no T2: the T1 parent x10), 10 + 5 faction tags of the officer's
  pirate family (Guristas, Angel, Blood, Sansha, Serpentis; other officers =
  `generic`: no tags, moon composites x2), moon composites and 2 000 000
  Tritanium ... 1000 Morphite, all scaled by module size (S 0.25, M 0.5, L 1,
  XL 2, others 1; turrets and launchers x1.5); time 7 days x (0.25 / 0.5 / 1 /
  1.5 / 1). The modules themselves are not scaled. Type = clone of 33196 with
  the parent's blueprint group, the officer's icon and a description that
  lists the modules. Sizes: S 21, M 24, L 126, XL 14, unsized 408; families:
  Guristas 89, Angel 84, Blood 106, Sansha 106, Serpentis 112, generic 96. 30
  officer types get no blueprint (`--report`): `VANILLA_BLUEPRINT` 12,
  `NO_PARENT` 10 (officer blueprints themselves), `NO_FACTION_OR_DEADSPACE` 5,
  `NOT_PUBLISHED` 3. **Generated** by `tools/genOfficerBlueprints.js` - do not
  edit by hand (see "Regenerating officer blueprints"). The shop sells them in
  price class `officer` (Jita only, 1 per type, see "Blueprint shop").
- `data/archaeology-relics.json`: the final reward of a Living New Eden
  archaeology trail (6 types, 2 blueprints, 341606-341619 reserved): 341600
  `Jovian Archive Analyzer` (clone of Data Analyzer II 30834, virus strength
  35) and its blueprint 341601 (clone of 30835), 341602 `Drifter Lattice
  Analyzer` (clone of Relic Analyzer II 30832, virus strength 32) and its
  blueprint 341603 (clone of 30833), trophies 341604 `Jovian Archive Core` /
  341605 `Drifter Lattice Core` (clones of 16686). Blueprints: the recipe of
  the source, max 3 runs, not in the shop (`shop.listed: false`). The last
  archive of a trail holds the blueprint copy and the trophy.
- `data/trig-bridge.json`: **Triglavian Conduit Core 341640** and **its
  blueprint 341641** (2 types, 1 blueprint; 341642 reserved). The Living New
  Eden mod uses up the core at Cargo Deposit to an Ansiblex (it makes that
  Ansiblex a Triglavian long-range bridge). The core is a clone of Organic
  Mortar Applicators 2870 without a group change (group 1041, category 43): it
  is **not a fuel** (not group 1136 Fuel Block, not Liquid Ozone 16273), so
  the structure fuel bay never takes it and it never burns as fuel. Not a
  clone of Triglavian Survey Database 48121: that type has no `typeDogma`
  record. Icon 21982 (Triglavian survey data) on both types. Blueprint = clone
  of 33196 (group 447, category 9); manufacturing 200 Zero-Point Condensate
  48112, 400 Crystalline Isogen-10 47975, 50 Triglavian Survey Database 48121
  (Abyssal Deadspace loot), 3 days (259200 s); skill 3400 level 1, max 2 runs
  and copying 720000 s as the Ansiblex blueprint 36961; no research. Shop:
  listed, 500 000 000 ISK (`shop.price`).
- `data/season-trophies.json`: **four season trophies** of the Living New Eden
  galactic seasons, 341620 `Season Trophy: Champion`, 341621 `Season Trophy:
  Hero`, 341622 `Season Trophy: Veteran`, 341623 `Season Trophy: Participant`
  (4 types, no blueprint, not in the shop). Source type = Manufacturing Tools
  16686 (group 314 Miscellaneous, category 17 Commodity, has a `typeDogma`
  record, no weapon); not the Replica Federation Trophies 48136/48137 (no
  `typeDogma` record) and not a Security Tag (CONCORD takes those). Icon 21622
  (the gold award icon of 48536). The season reward pump grants them only when
  `EVEJS_LNE_SEASONS_TIER<N>_ITEM_TYPE_ID` is set (default 0 = no item). Apply
  the client data before that, otherwise the client shows an unknown type.
- `data/listening-post.json`: **Listening Post 340520** and **its blueprint
  340521** (2 types, 1 blueprint; typeID range 340520-340539 reserved for the
  listening post and the heavy sentries). The post is a clone of the Scanner
  Array 16216 without a group change (group 709, category 23, anchorable, no
  weapon) with `dogma.attributes` hp 9 = 50000, shieldCapacity 263 = 50000,
  armorHP 265 = 100000 (200 000 HP). The Living New Eden mod anchors it by its
  sentry path (`listeningPost.*`, low/null only by default) and makes it a
  target of the faction battles only while someone of the owner corporation is
  online. Icon 24666 (d-scan); the client keeps the source look. Blueprint =
  clone of 33196 (group 447, category 9): 12000 Tritanium, 4000 Pyerite, 1500
  Mexallon, 500 Isogen, Industry V, 6000 s; copying 14400 s, ME/TE 6300 s and
  max 10 runs as the Scanner Array Blueprint 2821. Shop: listed, 100 000 000
  ISK (`shop.price`).
- `data/heavy-sentries.json`: **Heavy Sentry 340522-340525** and **their
  blueprints 340526-340529** (8 types, 4 blueprints). Clones of the large
  starbase batteries without a group change (category 23): Projectile <-
  Large Artillery Battery 16689 (426), Hybrid <- Large Railgun Battery 16692
  (449), Laser <- Large Beam Laser Battery 16694 (430), Missile <- XL Torpedo
  Battery 17773 (417). Source values, no dogma override: 1.7 million HP
  (shield 100 000, armor 1 500 000, hull 100 000), XL ammunition. The Living
  New Eden mod anchors them by its sentry path (`sentries.heavy.*`, off by
  default, low/null/wormhole, max 2 per system). Icons 389/349/352/169 as the
  Mobile Sentry; the client keeps the large battery look. Blueprints = clones
  of 33196 (groups 854/855/853/871): 77 290 Tritanium, 26 480 Pyerite, 7 710
  Mexallon (Laser 72 000 / 33 090 / 6 210, Missile 82 580 / 54 260 / 7 070)
  + 5 000 Isogen, 1 000 Nocxium, 250 Zydrine, Industry V, 24 000 s; copying
  9 600 s, ME/TE 4 200 s and max 10 runs as the vanilla large battery
  blueprints 2805/2804/2830/2822. Shop: listed, 750 000 000 ISK each
  (`shop.price`).

**Every new or changed pack needs `client\ApplyClientData.bat apply` again**
(a new pack = a new sha256: the tool rolls back and applies everything).

## PI blueprints (list)

The table between the markers is generated from the shipped
`data/pi-blueprints.json` with SDE names - do not edit it by hand:

```text
node mods/customTypes/tools/genPiBlueprints.js --readme-table --sde _local/sde/eve-online-static-data-3396210-jsonl [--check]
```

The test suite (T10) re-renders the block from the pack and fails when the
table drifts from it (typeIDs, quantities, times, product names, tiers).

<!-- pi-blueprints-table:begin (generated by tools/genPiBlueprints.js --readme-table, do not edit) -->

68 blueprints (P1 15, P2 24, P3 21, P4 8), pack `pi-blueprints` version 2. Manufacturing only, one run = one schematic cycle, max 100 runs. Skills by tier: P1: Industry (3380) 1; P2: Industry (3380) 2; P3: Industry (3380) 3, Advanced Industry (3388) 1; P4: Industry (3380) 4, Advanced Industry (3388) 3.

| Blueprint typeID | Name | Tier | Product | Output qty | Time | Inputs |
|---|---|---|---|---|---|---|
| 340421 | Water Blueprint | P1 | Water (3645) | 20 | 1800 s | 3000 Aqueous Liquids (2268) |
| 340422 | Plasmoids Blueprint | P1 | Plasmoids (2389) | 20 | 1800 s | 3000 Suspended Plasma (2308) |
| 340423 | Electrolytes Blueprint | P1 | Electrolytes (2390) | 20 | 1800 s | 3000 Ionic Solutions (2309) |
| 340424 | Oxygen Blueprint | P1 | Oxygen (3683) | 20 | 1800 s | 3000 Noble Gas (2310) |
| 340425 | Oxidizing Compound Blueprint | P1 | Oxidizing Compound (2392) | 20 | 1800 s | 3000 Reactive Gas (2311) |
| 340426 | Reactive Metals Blueprint | P1 | Reactive Metals (2398) | 20 | 1800 s | 3000 Base Metals (2267) |
| 340427 | Precious Metals Blueprint | P1 | Precious Metals (2399) | 20 | 1800 s | 3000 Noble Metals (2270) |
| 340428 | Toxic Metals Blueprint | P1 | Toxic Metals (2400) | 20 | 1800 s | 3000 Heavy Metals (2272) |
| 340429 | Chiral Structures Blueprint | P1 | Chiral Structures (2401) | 20 | 1800 s | 3000 Non-CS Crystals (2306) |
| 340430 | Silicon Blueprint | P1 | Silicon (9828) | 20 | 1800 s | 3000 Felsic Magma (2307) |
| 340431 | Bacteria Blueprint | P1 | Bacteria (2393) | 20 | 1800 s | 3000 Microorganisms (2073) |
| 340432 | Biomass Blueprint | P1 | Biomass (3779) | 20 | 1800 s | 3000 Planktic Colonies (2286) |
| 340433 | Proteins Blueprint | P1 | Proteins (2395) | 20 | 1800 s | 3000 Complex Organisms (2287) |
| 340434 | Biofuels Blueprint | P1 | Biofuels (2396) | 20 | 1800 s | 3000 Carbon Compounds (2288) |
| 340435 | Industrial Fibers Blueprint | P1 | Industrial Fibers (2397) | 20 | 1800 s | 3000 Autotrophs (2305) |
| 340365 | Superconductors Blueprint | P2 | Superconductors (9838) | 5 | 3600 s | 40 Plasmoids (2389), 40 Water (3645) |
| 340366 | Coolant Blueprint | P2 | Coolant (9832) | 5 | 3600 s | 40 Electrolytes (2390), 40 Water (3645) |
| 340367 | Rocket Fuel Blueprint | P2 | Rocket Fuel (9830) | 5 | 3600 s | 40 Plasmoids (2389), 40 Electrolytes (2390) |
| 340368 | Synthetic Oil Blueprint | P2 | Synthetic Oil (3691) | 5 | 3600 s | 40 Electrolytes (2390), 40 Oxygen (3683) |
| 340369 | Oxides Blueprint | P2 | Oxides (2317) | 5 | 3600 s | 40 Oxidizing Compound (2392), 40 Oxygen (3683) |
| 340370 | Silicate Glass Blueprint | P2 | Silicate Glass (3697) | 5 | 3600 s | 40 Oxidizing Compound (2392), 40 Silicon (9828) |
| 340371 | Transmitter Blueprint | P2 | Transmitter (9840) | 5 | 3600 s | 40 Plasmoids (2389), 40 Chiral Structures (2401) |
| 340372 | Water-Cooled CPU Blueprint | P2 | Water-Cooled CPU (2328) | 5 | 3600 s | 40 Reactive Metals (2398), 40 Water (3645) |
| 340373 | Mechanical Parts Blueprint | P2 | Mechanical Parts (3689) | 5 | 3600 s | 40 Reactive Metals (2398), 40 Precious Metals (2399) |
| 340374 | Construction Blocks Blueprint | P2 | Construction Blocks (3828) | 5 | 3600 s | 40 Reactive Metals (2398), 40 Toxic Metals (2400) |
| 340375 | Enriched Uranium Blueprint | P2 | Enriched Uranium (44) | 5 | 3600 s | 40 Precious Metals (2399), 40 Toxic Metals (2400) |
| 340376 | Consumer Electronics Blueprint | P2 | Consumer Electronics (9836) | 5 | 3600 s | 40 Toxic Metals (2400), 40 Chiral Structures (2401) |
| 340377 | Miniature Electronics Blueprint | P2 | Miniature Electronics (9842) | 5 | 3600 s | 40 Chiral Structures (2401), 40 Silicon (9828) |
| 340378 | Nanites Blueprint | P2 | Nanites (2463) | 5 | 3600 s | 40 Bacteria (2393), 40 Reactive Metals (2398) |
| 340379 | Biocells Blueprint | P2 | Biocells (2329) | 5 | 3600 s | 40 Biofuels (2396), 40 Precious Metals (2399) |
| 340380 | Microfiber Shielding Blueprint | P2 | Microfiber Shielding (2327) | 5 | 3600 s | 40 Industrial Fibers (2397), 40 Silicon (9828) |
| 340381 | Viral Agent Blueprint | P2 | Viral Agent (3775) | 5 | 3600 s | 40 Bacteria (2393), 40 Biomass (3779) |
| 340382 | Fertilizer Blueprint | P2 | Fertilizer (3693) | 5 | 3600 s | 40 Bacteria (2393), 40 Proteins (2395) |
| 340383 | Genetically Enhanced Livestock Blueprint | P2 | Genetically Enhanced Livestock (15317) | 5 | 3600 s | 40 Proteins (2395), 40 Biomass (3779) |
| 340384 | Livestock Blueprint | P2 | Livestock (3725) | 5 | 3600 s | 40 Proteins (2395), 40 Biofuels (2396) |
| 340385 | Polytextiles Blueprint | P2 | Polytextiles (3695) | 5 | 3600 s | 40 Biofuels (2396), 40 Industrial Fibers (2397) |
| 340386 | Test Cultures Blueprint | P2 | Test Cultures (2319) | 5 | 3600 s | 40 Bacteria (2393), 40 Water (3645) |
| 340387 | Supertensile Plastics Blueprint | P2 | Supertensile Plastics (2312) | 5 | 3600 s | 40 Oxygen (3683), 40 Biomass (3779) |
| 340388 | Polyaramids Blueprint | P2 | Polyaramids (2321) | 5 | 3600 s | 40 Oxidizing Compound (2392), 40 Industrial Fibers (2397) |
| 340389 | Ukomi Superconductors Blueprint | P3 | Ukomi Superconductors (17136) | 3 | 3600 s | 10 Synthetic Oil (3691), 10 Superconductors (9838) |
| 340390 | Condensates Blueprint | P3 | Condensates (2344) | 3 | 3600 s | 10 Oxides (2317), 10 Coolant (9832) |
| 340391 | Camera Drones Blueprint | P3 | Camera Drones (2345) | 3 | 3600 s | 10 Silicate Glass (3697), 10 Rocket Fuel (9830) |
| 340392 | Synthetic Synapses Blueprint | P3 | Synthetic Synapses (2346) | 3 | 3600 s | 10 Supertensile Plastics (2312), 10 Test Cultures (2319) |
| 340394 | High-Tech Transmitters Blueprint | P3 | High-Tech Transmitters (17898) | 3 | 3600 s | 10 Polyaramids (2321), 10 Transmitter (9840) |
| 340395 | Gel-Matrix Biopaste Blueprint | P3 | Gel-Matrix Biopaste (2348) | 3 | 3600 s | 10 Oxides (2317), 10 Biocells (2329), 10 Superconductors (9838) |
| 340396 | Supercomputers Blueprint | P3 | Supercomputers (2349) | 3 | 3600 s | 10 Water-Cooled CPU (2328), 10 Coolant (9832), 10 Consumer Electronics (9836) |
| 340397 | Robotics Blueprint | P3 | Robotics (9848) | 3 | 3600 s | 10 Mechanical Parts (3689), 10 Consumer Electronics (9836) |
| 340398 | Smartfab Units Blueprint | P3 | Smartfab Units (2351) | 3 | 3600 s | 10 Construction Blocks (3828), 10 Miniature Electronics (9842) |
| 340399 | Nuclear Reactors Blueprint | P3 | Nuclear Reactors (2352) | 3 | 3600 s | 10 Enriched Uranium (44), 10 Microfiber Shielding (2327) |
| 340400 | Guidance Systems Blueprint | P3 | Guidance Systems (9834) | 3 | 3600 s | 10 Water-Cooled CPU (2328), 10 Transmitter (9840) |
| 340402 | Neocoms Blueprint | P3 | Neocoms (2354) | 3 | 3600 s | 10 Biocells (2329), 10 Silicate Glass (3697) |
| 340403 | Planetary Vehicles Blueprint | P3 | Planetary Vehicles (9846) | 3 | 3600 s | 10 Supertensile Plastics (2312), 10 Mechanical Parts (3689), 10 Miniature Electronics (9842) |
| 340404 | Biotech Research Reports Blueprint | P3 | Biotech Research Reports (2358) | 3 | 3600 s | 10 Nanites (2463), 10 Livestock (3725), 10 Construction Blocks (3828) |
| 340405 | Vaccines Blueprint | P3 | Vaccines (28974) | 3 | 3600 s | 10 Livestock (3725), 10 Viral Agent (3775) |
| 340406 | Industrial Explosives Blueprint | P3 | Industrial Explosives (2360) | 3 | 3600 s | 10 Fertilizer (3693), 10 Polytextiles (3695) |
| 340407 | Hermetic Membranes Blueprint | P3 | Hermetic Membranes (2361) | 3 | 3600 s | 10 Polyaramids (2321), 10 Genetically Enhanced Livestock (15317) |
| 340408 | Transcranial Microcontrollers Blueprint | P3 | Transcranial Microcontrollers (12836) | 3 | 3600 s | 10 Biocells (2329), 10 Nanites (2463) |
| 340409 | Data Chips Blueprint | P3 | Data Chips (17392) | 3 | 3600 s | 10 Supertensile Plastics (2312), 10 Microfiber Shielding (2327) |
| 340410 | Hazmat Detection Systems Blueprint | P3 | Hazmat Detection Systems (2366) | 3 | 3600 s | 10 Polytextiles (3695), 10 Viral Agent (3775), 10 Transmitter (9840) |
| 340411 | Cryoprotectant Solution Blueprint | P3 | Cryoprotectant Solution (2367) | 3 | 3600 s | 10 Test Cultures (2319), 10 Synthetic Oil (3691), 10 Fertilizer (3693) |
| 340412 | Organic Mortar Applicators Blueprint | P4 | Organic Mortar Applicators (2870) | 1 | 3600 s | 6 Condensates (2344), 40 Bacteria (2393), 6 Robotics (9848) |
| 340413 | Sterile Conduits Blueprint | P4 | Sterile Conduits (2875) | 1 | 3600 s | 6 Smartfab Units (2351), 40 Water (3645), 6 Vaccines (28974) |
| 340414 | Nano-Factory Blueprint | P4 | Nano-Factory (2869) | 1 | 3600 s | 6 Industrial Explosives (2360), 40 Reactive Metals (2398), 6 Ukomi Superconductors (17136) |
| 340415 | Self-Harmonizing Power Core Blueprint | P4 | Self-Harmonizing Power Core (2872) | 1 | 3600 s | 6 Camera Drones (2345), 6 Nuclear Reactors (2352), 6 Hermetic Membranes (2361) |
| 340416 | Recursive Computing Module Blueprint | P4 | Recursive Computing Module (2871) | 1 | 3600 s | 6 Synthetic Synapses (2346), 6 Guidance Systems (9834), 6 Transcranial Microcontrollers (12836) |
| 340417 | Broadcast Node Blueprint | P4 | Broadcast Node (2867) | 1 | 3600 s | 6 Neocoms (2354), 6 Data Chips (17392), 6 High-Tech Transmitters (17898) |
| 340418 | Integrity Response Drones Blueprint | P4 | Integrity Response Drones (2868) | 1 | 3600 s | 6 Gel-Matrix Biopaste (2348), 6 Hazmat Detection Systems (2366), 6 Planetary Vehicles (9846) |
| 340419 | Wetware Mainframe Blueprint | P4 | Wetware Mainframe (2876) | 1 | 3600 s | 6 Supercomputers (2349), 6 Biotech Research Reports (2358), 6 Cryoprotectant Solution (2367) |

<!-- pi-blueprints-table:end -->

## Pack format

```json
{ "packID": "pi-blueprints", "version": 1,
  "types": [{ "typeID": 340431, "sourceTypeID": 971,
              "overrides": { "name": "Bacteria Blueprint", "groupID": 106, "iconID": 10029,
                             "basePrice": 0, "published": true, "marketGroupID": null } }],
  "blueprints": [{ "blueprintTypeID": 340431, "productTypeID": 2393, "maxProductionLimit": 100,
                   "activities": { "manufacturing": { "materials": [...], "products": [...],
                                                      "skills": [...], "time": 1800 } } }] }
```

`activities` is the SDE `blueprints.jsonl` format. The item row is a copy of
the `sourceTypeID` row of `itemTypes` with the overrides (`groupID` also sets
`groupName` and `categoryID` from that group). Optional `description` (non-empty
string, at most 2000 characters): the client tool uses it as the item description
(default: a generic "Custom type" line); the server copies it only onto a row
that already has a `description` field (EveJS `itemTypes` rows do not).

## Pack v2 (dogma, type fields, icons, ships, shop)

Backward compatible: v1 packs load unchanged. New fields (the same contract
as the client tool):

```json
{ "packID": "design-<slug>", "version": 1,
  "types": [{ "typeID": 342000, "sourceTypeID": 587,
              "overrides": { "name": "Rifter Mk II", "mass": 1100000, "volume": 27289,
                             "capacity": 160, "radius": 31 },
              "dogma": { "attributes": { "37": 420, "14": 4 } } }],
  "icons": [{ "iconID": 950000, "templateIconID": 21, "file": "icons/950000.png",
              "sha256": "<64 hex>" }],
  "blueprints": [{ "...": "as in v1", "shop": { "listed": true, "price": 250000000 } }] }
```

- Strict key lists (an unknown key refuses the pack): pack `packID, version,
  types, blueprints, icons, source, description`; type `typeID, sourceTypeID,
  overrides, dogma`; overrides = the v1 list + `mass, volume, capacity, radius`
  (finite numbers > 0, set on the item row); `dogma` only `attributes`;
  blueprint `blueprintTypeID, productTypeID, maxProductionLimit, activities,
  shop`; `shop` only `listed` (boolean) and `price` (ISK 1-1e12).
- `dogma.attributes`: only attributes the source `typeDogma` record carries
  (else `dogma attribute <id> not on source <sourceTypeID>`); the value is set on
  the clone's copy, `attributeCount` unchanged. No `typeDogma` table = packs with
  `dogma` refused (`typeDogma table unavailable`), others unaffected.
- Absolute guards (`lib/limits.js`, also used by the Design Studio; safety
  constants, not config): finite; no sign change against the source (source >= 0
  -> value >= 0, source < 0 -> value <= 0); attributes named `*Resonance` within
  0.1-1; `hiSlots`/`medSlots`/`lowSlots`/`turretSlotsLeft`/`launcherSlotsLeft`
  (14/13/12/102/101) integer 0-8, `rigSlots` (1137) integer 0-3. Every range is
  widened by the source value, so an unchanged clone always passes. The refusal
  names the attribute: `dogma attribute 37 (maxVelocity) must be >= 0`.
- `icons[]`: structure only (the server never reads the PNG): iconID
  950000-959999, unique in and across packs, `templateIconID` positive integer,
  `file` = `icons/<digits>.png`, `sha256` 64 hex, every entry used by an
  `overrides.iconID` of the pack.
- Ships (source of category 6): besides `itemTypes`/`typeDogma`, the clone
  gets one row in `shipTypes` (`published: false`, so the fallback market
  skips it), `shipDogmaAttributes` (copy of the source entry with the dogma
  overrides; Show Info reads only this table) and `movementAttributes` (copy of
  the source row: `mass` <- attribute 4 or `overrides.mass`, `maxVelocity` <- 37,
  `inertia` <- 70, `radius` <- 162 or `overrides.radius`, `signatureRadius` <-
  552, `warpSpeedMultiplier` <- 600). A DRIFT of the ship table probe
  (`inspectShips`) refuses only the packs with a ship (`ship tables drift`).
  NPC spawns and Living New Eden pick hulls from explicit typeID lists, so
  clones never spawn as NPCs.
- `shop` (blueprint shop): `listed: false` = never sold; `price` = the contract
  price of that blueprint, but `EVEJS_CUSTOMTYPES_SHOP_PRICE_OVERRIDES` wins.

Known limits: a custom ship has no insurance (`shipInsurancePrices`) and no
SKINs; the client shows the source's (or empty) traits text; the client overlay
"SMB for every ship" is built from the SDE ships, so a custom ship does not get
it in Show Info.

Log: `pack <id>: N types (S ships), B blueprints, I icons` (the ships and icons
parts only when present).

## Guards (a pack is refused whole, one log line)

- typeID in 340000-349999, not in the SDE, not declared twice; source type exists;
  overrides only from the list above; `groupID` exists;
- blueprint type is a type of the pack with category 9; it has no vanilla definition;
- product exists, has no vanilla blueprint and no other custom one;
- activity keys only `manufacturing`, `research_time`, `research_material`,
  `copying`, `invention`, `reaction`; every material/product/skill type exists;
  `manufacturing.products[0]` is the product.

Log: `[customTypes] pack archaeology-relics: 6 types, 2 blueprints`,
`[customTypes] pack heavy-sentries: 8 types, 4 blueprints`,
`[customTypes] pack listening-post: 2 types, 1 blueprints`,
`[customTypes] pack mobile-sentries: 8 types, 4 blueprints`,
`[customTypes] pack officer-blueprints: 593 types, 593 blueprints`,
`[customTypes] pack pi-blueprints: 68 types, 68 blueprints`,
`[customTypes] pack planetary-drill: 32 types, 16 blueprints`,
`[customTypes] pack season-trophies: 4 types, 0 blueprints`,
`[customTypes] pack trig-bridge: 2 types, 1 blueprints` and
`[customTypes] industryBlueprints: +689 custom blueprint definitions`, or
`[customTypes] pack <id> (<file>) refused: <reason> - whole pack skipped`.

Known limit ("whole pack or nothing" is checked at plan time only): if
`industryBlueprints` cannot be read later (`industryBlueprints not readable
through gameStore - custom blueprints not added`) or the definitions cannot be
added (`<reason> - custom blueprints not added`), the item rows of the pack stay.
The blueprint types then exist without blueprint data until the next start.
Practically unlikely: the plan already read this table.

## How it hooks EveJS (no `server/**` edits)

- `services/_shared/referenceData`: `readStaticTable` / `readStaticRows` wrapped
  at first load; on the first read of `itemTypes` and `typeDogma` (and, for
  ships, `shipTypes`, `shipDogmaAttributes`, `movementAttributes`) the pack rows
  are added to the memoised payload (once per payload object). The item type
  registry is built from these rows, so `/createitem 340431` works.
- `services/industry/industryStaticData`: when it loads, the definitions are
  appended to the live `industryBlueprints` cache of gameStore and
  `clearIndustryStaticCaches()` is called. No export is wrapped.
- `gameStore`: `preloadAll` is wrapped. `bootWorld` calls it after
  industryStaticData is already loaded, and it replaces every cache object with
  a fresh parse of the table file, so the definitions are appended again to the
  new `industryBlueprints` object (log line
  `industryBlueprints: +N custom blueprint definitions (again after gameStore.preloadAll)`).
  Without this the server would have no definition for any pack blueprint and
  the Industry window would show no materials.
- `services/industry/industryMonitorService` (ConnectJob trace only): the
  `Handle_ConnectJob` prototype method is wrapped, log only (reply unchanged).
- A text probe of the vendor files runs at install. DRIFT = no hooks, vanilla
  EveJS, a named log line.

## Settings (`.env` next to the mod or the environment)

| Key | Default | Effect |
|---|---|---|
| `EVEJS_CUSTOMTYPES_ENABLED` | `0` | `1` = the pack types and blueprints exist on the server |
| `EVEJS_CUSTOMTYPES_CLEANUP` | `0` | **Danger.** `1` (with ENABLED) = after the world boots, delete every item of a typeID of an accepted pack (refused packs and typeIDs present in vanilla `itemTypes` are never touched); an item that holds other items (container, ship with cargo) is skipped and logged, its contents are not moved. Refused while an outstanding or in-progress courier contract holds such an item (see "Remove") |
| `EVEJS_CUSTOMTYPES_CONNECTJOB_TRACE` | `1` | Diagnostic, log only. The `industryMonitor.Handle_ConnectJob` prototype method is wrapped; when the Industry window opens a blueprint of an accepted pack, one `CONNECTJOB_TRACE` line (blueprint item and owner, facility, input location, definition materials, the materials sent to the client, `short=` types below 1 run, error of the vendor handler) per character/blueprint/activity per window. The reply and exceptions are not changed. A bad value or a probe DRIFT turns off the trace only |
| `EVEJS_CUSTOMTYPES_CONNECTJOB_TRACE_MINUTES` | `10` | Window of the trace, 1-1440 minutes |

The `EVEJS_CUSTOMTYPES_SHOP_*` keys are in "Blueprint shop" below.

## Blueprint shop (public NPC contracts in the trade hubs)

With `EVEJS_CUSTOMTYPES_SHOP_ENABLED=1` (the mod default is `0`; the Docker
`compose.yaml` of this project sets it to `1`) the world process keeps
**public item exchange contracts** of the NPC corporation **Outer Ring
Excavations (1000129)** in Jita IV-4 CNAP (60003760), Amarr VIII Oris EFA
(60008494), Dodixie IX-19 FNAP (60011866), Rens VI-8 BTT (60004588) and Hek
VIII-12 BC (60005686). One contract = 1 blueprint; every listed blueprint of
an accepted pack (except officer blueprints, see below) gets
`CONTRACTS_PER_TYPE` contracts per hub (default 3). No market orders: the
types have no market group, a contract needs none.

- A player finds them in **Contracts -> Search**, location = current station,
  type Item Exchange, category Blueprint; accepts, pays the price and gets the
  BPO in the hangar. The ISK goes to the ORE wallet, division
  `ISSUER_ACCOUNT_KEY` (an ISK sink).
- Every `PASS_SECONDS` (30 s) a pass refills sold contracts and relists a
  contract with less than `RENEW_HOURS` left (the same blueprint item, a new
  contract). A price or kind change deletes the old contract; the next pass
  lists the new one. More than N contracts of a pair: the extra ones are
  deleted. At most `MAX_ACTIONS_PER_PASS` vendor actions per pass (the first
  fill of about 1300 contracts takes about 33 passes, ~15-20 minutes).
- No state file: the truth is the EveJS contract table. A shop contract is a
  corporation contract of the issuer with the tag `[customTypes:shop:v1:o]`
  (BPO) or `[customTypes:shop:v1:c<runs>]` (BPC) in its description. Unsold
  blueprints of the issuer in the hub's Corp Deliveries (flag 62) are stock,
  used before a new blueprint is created. A restart never duplicates: an item
  can be in one contract only, a hub with a contract operation in progress is
  skipped for that pass, and an excess is deleted.
- BPC (`BLUEPRINT_KIND=copy`): the buyer gets a real copy, but the contract
  window shows it like an original (the EveJS contract row has `copy=0`), and
  the BPC search filter does not find it. Hence the BPO default.
- Off switches: `SHOP_ENABLED=0` = no contracts are touched and no shop wrap
  is installed (existing contracts stay); `SHOP_DELIST=1` = delete every shop
  contract (blueprints go back to the issuer's flag 62), create none. A bad
  shop key or a shop DRIFT turns off the shop alone (types and blueprints
  keep working).
- `SHOP_LIVE_CONTRACT_READ=1` (default 0): the scan of the shop's contracts
  filters the live `contractRuntime` rows of the gameStore cache instead of a
  clone of every contract (`listContractRecords`); the result is the same, a
  failed read falls back to `listContractRecords`.
- How it reaches EveJS: `contractRuntimeState.createContract` / `deleteContract`
  with a session of the issuer's CEO (3004501 from the SDE). EveJS gives an
  NPC corporation no corporation authority, so `lib/shop/issuer.js` wraps
  `corporationAuthority.getPersistedCorporationAuthority` and answers only for
  a session the shop marked with a private symbol (port of the Living New Eden
  `corpContractIssuer.js`; both wraps coexist). Blueprints are created with
  `industryRuntimeState.seedBlueprintForOwner` (BPO = ME0/TE0).

Log:
`[customTypes] shop active - issuer Outer Ring Excavations (1000129), 5 hubs, <n> blueprints, 3 per type`
(or `shop off - <reason>`, `shop: hub <id> skipped - <reason>`), then
`[customTypes] shop pass: created C, deleted D (expiring E, stale S, excess X), granted G, failed F, live L/T, stock-stale K, busy B, N ms`
on the first pass and on every pass with actions or failures; after the
first fill `live T/T`. A failure: `shop: create failed at <station>/<type>: <detail>`
(one line per reason per pass). Passes that only fail double the interval up
to `BACKOFF_MAX_MINUTES`.

| Key (`EVEJS_CUSTOMTYPES_SHOP_` + ) | Default | Range / effect |
|---|---|---|
| `ENABLED` | `0` (compose: `1`) | needs `EVEJS_CUSTOMTYPES_ENABLED=1` |
| `DELIST` | `0` | `1` = delete all shop contracts, create none (before CLEANUP or an issuer change) |
| `STATIONS` | `60003760,60008494,60011866,60004588,60005686` | 1-20 station IDs; an unknown station or a structure is logged and skipped |
| `ISSUER_CORPORATION_ID` | `1000129` | a corporation whose record has a `ceoID` |
| `ISSUER_ACCOUNT_KEY` | `1000` | 1000-1006; each sale is one wallet receipt, EveJS keeps at most 8192 per division - then switch to the next division |
| `CONTRACTS_PER_TYPE` | `3` | 1-10 |
| `BLUEPRINT_KIND` | `original` | `original` (BPO) / `copy` (BPC) |
| `COPY_RUNS` | `10` | 1-1000, clipped to the blueprint's max runs |
| `CONTRACT_DAYS` | `30` | 1-90 |
| `RENEW_HOURS` | `24` | 1-168, below `CONTRACT_DAYS*24` |
| `PRICE_P1` / `_P2` / `_P3` / `_P4` | `2000000` / `8000000` / `25000000` / `60000000` | ISK 1-1e12; PI tier = Industry skill level of the blueprint |
| `PRICE_DRILL` | `150000000` | pack `planetary-drill` (340101, 340202-340216) |
| `PRICE_DEFAULT` | `10000000` | blueprints of other packs |
| `PRICE_OFFICER` | `1000000000` | pack `officer-blueprints` (price class `officer`) |
| `OFFICER_STATIONS` | `60003760` | 1-20 station IDs; officer blueprints are listed only at these hubs (those not in `STATIONS` or invalid are logged and skipped) |
| `OFFICER_CONTRACTS_PER_TYPE` | `1` | 0-10 per officer hub; `0` = no officer contracts (live ones are deleted as excess) |
| `PRICE_OVERRIDES` | empty | `typeID=isk,...`; a typeID that is no blueprint of an accepted pack is logged and ignored |
| `LIVE_CONTRACT_READ` | `0` | `1` = scan the live contract rows instead of a clone (see above) |
| `PASS_SECONDS` | `30` | 10-3600 |
| `FIRST_PASS_SECONDS` | `30` | 0-3600, after `bootWorld` |
| `MAX_ACTIONS_PER_PASS` | `40` | 1-500 (creates + deletes) |
| `BACKOFF_MAX_MINUTES` | `30` | 1-240 |

Changing the issuer: `DELIST=1`, restart, wait for `live 0/0` passes with
`deleted 0`, then change `ISSUER_CORPORATION_ID` and set `DELIST=0` (contracts
of the old issuer are no longer recognised as the shop's). Cost: each shop
contract is a row of the EveJS contract table (EveJS clones all rows on every
contract search); if the Contracts window gets slow, lower
`CONTRACTS_PER_TYPE` or the hub list.

Officer blueprints (pack `officer-blueprints`): price class `officer`
(`PRICE_OFFICER`, default 1 000 000 000 ISK). They go only to
`OFFICER_STATIONS` (default Jita IV-4, only hubs also in `STATIONS` count)
with `OFFICER_CONTRACTS_PER_TYPE` contracts each (default 1), so their count
is not multiplied by the 5 hubs and `CONTRACTS_PER_TYPE` (~590 contracts
instead of ~8850). A contract of an officer blueprint at another hub is
deleted as stale. When the catalog has officer blueprints the start line ends
with `, officer <n> blueprints at <h> hub(s), <p> per type`; an officer hub
outside the valid hubs logs `shop: officer hub <id> skipped - not a shop hub`.

## Enable (Docker)

1. `docker/entrypoint.sh`: `--require /app/mods/customTypes/loader.js` in both
   blocks, before `livingNewEden`; `EVEJS_CUSTOMTYPES_ENABLED=true` in the
   environment of the server.
2. `docker compose build init`, `docker compose up -d server`.
3. `docker compose logs server | grep customTypes` shows the lines of "Guards"
   above plus `[customTypes] v1.1.0 active - wrapped referenceData.readStaticTable/readStaticRows (probe ok)`.
4. Client (see "Client data" below): `client\ApplyClientData.bat apply --client "<client folder>"`.
5. In game, docked: the `/createitem` examples below.

## `/createitem` examples (docked, GM chat)

Syntax `/createitem <typeID> [amount]`. One blueprint per tier, the P4 one with
a P1 input (Bacteria), plus the drill:

| Command | Item | Manufacturing (one run) |
|---|---|---|
| `/createitem 340431` | Bacteria Blueprint (P1) | 3000 Microorganisms -> 20 Bacteria, 1800 s, Industry 1 |
| `/createitem 340386` | Test Cultures Blueprint (P2) | 40 Bacteria + 40 Water -> 5 Test Cultures, 3600 s, Industry 2 |
| `/createitem 340390` | Condensates Blueprint (P3) | 10 Oxides + 10 Coolant -> 3 Condensates, 3600 s, Industry 3 + Advanced Industry 1 |
| `/createitem 340412` | Organic Mortar Applicators Blueprint (P4) | 6 Condensates + 40 Bacteria + 6 Robotics -> 1, 3600 s, Industry 4 + Advanced Industry 3 |
| `/createitem 340101` | Planetary Drill Blueprint | Vexor 971 ME0 minerals -> 1 Planetary Drill, 12000 s, Industry 1 |
| `/createitem 340100` | Planetary Drill | launches as Orbital Skyhook 81080 (`mods/planetaryDrill`), mines the best P0 (auto) |
| `/createitem 340104` | Planetary Drill (Aqueous Liquids) | launches as Orbital Skyhook 81080, mines Aqueous Liquids; refused at a planet without it (variants 340102-340116, blueprints 340202-340216) |
| `/createitem 340511` | Mobile Sentry (Hybrid) Blueprint | 7729 Tritanium + 2648 Pyerite + 771 Mexallon -> 1 Mobile Sentry (Hybrid), 6000 s, Industry 5 (blueprints 340510-340513) |
| `/createitem 340501` | Mobile Sentry (Hybrid) | clone of the Small Railgun Battery 16690 (group kept); anchoring rules come from Living New Eden (types 340500-340503) |

Materials for a quick test: `/createitem 2073 3000` (Microorganisms),
`/createitem 2393 40` (Bacteria), `/createitem 3645 40` (Water). Mobile
Sentry blueprints (enough for any of 340510-340513): `/createitem 34 8258`
(Tritanium), `/createitem 35 5426` (Pyerite), `/createitem 36 771`
(Mexallon). The server row of a blueprint is unpublished (see "Known
interactions"): the reply says "[unpublished]".

## Client data (apply / rollback)

Details: `client/README.md`. With the **EVE client and the launcher closed**,
from the repo root:

```bat
mods\customTypes\client\ApplyClientData.bat apply --client "D:\EVE Online"
mods\customTypes\client\ApplyClientData.bat status
```

- `apply` writes all packs of `data/*.json` at once; a second `apply` after a
  pack changed rolls back first, then applies again; with unchanged packs it
  prints `Already applied ... nothing to do`.
- Rollback (client back to vanilla data):
  `mods\customTypes\client\ApplyClientData.bat rollback` (refuses if the client
  index changed after apply - client update, launcher repair; `--force`
  overrides it, see `client/README.md`).
- Server and client must carry the same pack (otherwise `MISMATCH_TIME` /
  `MISMATCH_MATERIAL` in the Industry window).

## Remove

> **Warning: do not switch the mod off while industry jobs of custom
> blueprints are running.** With `EVEJS_CUSTOMTYPES_ENABLED=0` (or the
> `--require` line removed) the server no longer knows the blueprint
> definitions: such a job is never settled (no product delivered, the
> materials already consumed) and the custom items (blueprints 3403xx/3404xx,
> Planetary Drill 340100/340101, variants 340102-340116 and 340202-340216,
> Mobile Sentry 340500-340503 and 340510-340513, officer blueprints
> 341000-341999) are of an unknown type. Deliver or cancel every such job
> first, then follow the steps below.

Items of a custom type become unknown to the server when the mod is off, and
an industry job of a custom blueprint is never delivered. Before removing:

0. blueprint shop: `EVEJS_CUSTOMTYPES_SHOP_DELIST=1`, restart, wait until the
   `shop pass:` lines show `live 0/0` and no more deletes; players' own
   contracts with custom items must be finished or deleted as well (CLEANUP
   refuses with `CLEANUP refused: N outstanding contracts hold custom types`
   while any outstanding contract holds one); a courier contract in progress
   carrying a custom item (plastic wrap) also blocks CLEANUP until the delivery
   ends (`CLEANUP refused: N courier contracts in progress carry custom types -
   wait until the courier contracts finish`). The DELIST pass also deletes shop
   contracts of a type whose pack was refused or removed in the meantime;
1. finish or cancel the jobs of custom blueprints;
2. `EVEJS_CUSTOMTYPES_CLEANUP=1` (ENABLED stays 1), restart once: log
   `CLEANUP removed N items of M custom types (F failed, S skipped with contents)`;
   if S > 0, empty those items in game (lines `CLEANUP: item ... has contents`)
   and restart once more; `CLEANUP refused: vanilla itemTypes rows were not read`
   means the SDE item types could not be read, so nothing is removed (the check
   against other mods' typeIDs would be blind);
3. remove the `--require` line, `CLEANUP=0`, `SHOP_ENABLED=0`, rebuild, restart;
4. client: `client\ApplyClientData.bat rollback`.

Example of a non-blueprint type:
`{ "typeID": 340001, "sourceTypeID": 81826, "overrides": { "name": "Planetary Drill (probe)" } }`.

## Regenerating PI blueprints

`data/pi-blueprints.json` is the output of a deterministic generator (the
server and the client tool read the same file). Balance and template live in
`tools/pi-blueprints.spec.json` (not in `data/`: every `data/*.json` must be a
pack): `typeIDBase` 340300, `sourceTypeID` 33196, `groupID` 447,
`maxProductionLimit` 100, `timeFactor` 1.0, `tierByOutputQuantity` (output 20
= P1, 5 = P2, 3 = P3, 1 = P4), `skillsByTier`.

```text
node mods/customTypes/tools/genPiBlueprints.js --sde _local/sde/eve-online-static-data-3396210-jsonl
     [--spec <file>] [--out <file>] [--check] [--schematics 131,65]
```

- writes `data/pi-blueprints.json` (via `.tmp` + rename) and prints
  `pi-blueprints: 68 blueprints (P1 15, P2 24, P3 21, P4 8), typeID 340365-340435, wrote ...`;
  the same input gives the same bytes; `source` holds the SHA1 of the spec,
  `planetSchematics.jsonl` and `types.jsonl`;
- `--check` writes nothing: exit 0 `up to date`, exit 1 `differs`;
- `--schematics 131` builds only those schematics (for isolated tests, e.g.
  `sourceTypeID` 971 / `groupID` 106 in a copy of the spec plus
  `--schematics 131` gives a one-blueprint pack);
- any problem (unknown output quantity, typeID or name already in the SDE,
  product without icon, ...) is `refused: <reason>`, exit 1, nothing written.
  The run reads `types.jsonl` (143 MB) and takes a few seconds; it is not
  part of the test suite.

**A change of the spec (`timeFactor`, skills, materials via a new SDE) must
reach both sides**: regenerate -> rebuild the server image (`docker compose
build init`, `up -d server`) -> `client\ApplyClientData.bat apply` (it rolls
back and re-applies because the pack's sha256 changed). Otherwise the client
shows other times/materials than the server checks (`MISMATCH_TIME`,
`MISMATCH_MATERIAL`).

## Regenerating officer blueprints

`data/officer-blueprints.json` is the output of a deterministic generator
(like the PI pack). Recipe, sizes, families and the fixed typeIDs live in
`tools/officer-blueprints.spec.json`: `sizeFactor` / `timeFactor` /
`weaponFactor`, `turretSizeByChargeSize` (dogma attribute 128),
`launcherSizeByGroup`, `sizeTokens` (name regexes for other modules),
`moduleCounts`, `minerals`, `moonMaterials`, `genericMoonFactor`, `families`
(officer names, faction/deadspace prefixes, tags) and `allocations` (officer
typeID -> blueprint typeID).

```text
node mods/customTypes/tools/genOfficerBlueprints.js --sde _local/sde/eve-online-static-data-3396210-jsonl
     [--spec <file>] [--out <file>] [--check] [--allocate] [--report]
```

- writes the pack (via `.tmp` + rename) and prints
  `officer-blueprints: 593 blueprints (30 officers excluded), typeID 341000-341592, <bytes> bytes, wrote ...`;
  the same input gives the same bytes; `source` holds the SHA1 of the spec,
  `types.jsonl`, `groups.jsonl`, `blueprints.jsonl` and `typeDogma.jsonl`
  (CRLF read as LF);
- an officer without an entry in `allocations` is `refused: officer <id> has no
  allocation (run --allocate)`; `--allocate` gives every new officer the next
  free typeID of 341000-341999 (not allocated, not in the SDE) in typeID order
  and also writes the spec (`.tmp` + rename, only the `allocations` object
  changes). An allocation is never removed: old blueprints keep their typeID,
  an officer that drops out keeps its ID reserved;
- `--check` writes nothing: exit 0 `up to date`, exit 1 `differs` or a missing
  allocation; `--check --allocate` is refused;
- `--report` prints the count, the excluded officers per reason
  (`NOT_PUBLISHED`, `NO_PARENT`, `VANILLA_BLUEPRINT`, `NO_FACTION_OR_DEADSPACE`,
  `NO_PARENT_BLUEPRINT`, `NO_ICON`), the size and family split and the number
  of launchers on `launcherDefaultSize` (0 on SDE 3396210);
- a bad spec, a duplicate / out-of-range / SDE-taken allocation, a blueprint
  name already in the SDE or an exhausted range is `refused: <reason>`, exit 1,
  nothing written. The run reads `types.jsonl` (143 MB), about 3 s.

**A change of the spec or a new SDE must reach both sides**: regenerate ->
rebuild the server image (`docker compose build init`, `up -d server`) ->
`client\ApplyClientData.bat apply` (rollback + apply, the pack's sha256
changed).

## Known interactions

- The **server** row of every blueprint type of a pack gets
  `published: false` (the pack value is ignored for blueprints; the client row
  keeps it). `blueprintDrops` builds its drop pool from published category-9
  `itemTypes` rows, so custom blueprints never drop. Industry does not read
  `published`; `/createitem 340431` works and reports "[unpublished]".

## Tests

`RunTests.bat` or `node mods/customTypes/test/run.js` (about 1 s, no server).
The tests build the PI pack from a 3-schematic fixture through the generator;
T6 checks the shipped pack against `planetSchematics.jsonl` when the local SDE
is present. Byte equality with the full SDE is `genPiBlueprints.js --check`.
T10 checks the README table against the shipped pack (after a regeneration
run `genPiBlueprints.js --readme-table --sde ...` too). OB1-OB3 run the officer
generator on an in-memory SDE fixture; OB4/OB5 check the shipped officer pack
(range, allocations, `buildPlan` together with the other packs). Byte equality
with the full SDE is `genOfficerBlueprints.js --check`. CS1-CS6 cover pack v2
(dogma overrides, guards, the three ship tables, shop hints, ship table probe,
icons).
