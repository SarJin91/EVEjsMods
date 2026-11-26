# Player guide: Living New Eden

A short description of what a player sees in a world with the Living New Eden mod. The description covers the default settings of the mod. The server operator can turn on more features. The list of features that are off is at the end.

Note: the `compose.yaml` in the repository (the Docker server) turns on the Danger group and the player hunts. On that server you can see features from the list "What we do not promise": faction fleets as ships in space, hunts and gate pursuit.

## What the mod does

NPC factions (pirates, empires, CONCORD, invaders) hold territory and wage wars. Faction fleets travel across the map, attack systems, take them and lose them. This war goes on also when you are not playing.

Faction fleets are virtual. You do not see them in space as ships. You see the effects of the war in the systems.

## What you see in the game

### Belt rats

In a system controlled by a pirate faction of the mod, the belt rats belong to that faction. When the controller of the system changes, the faction of the rats changes too.

### Empire fleet on belts

In nullsec controlled by an empire, an empire fleet appears on the belts.

- The fleet attacks you when your standing with that empire is below 0.
- The fleet does not attack you when your standing is 0 or higher.
- When you attack the fleet, the whole group attacks you.
- Attacking the fleet and killing a ship of the fleet lower your standing with the empire.

### Standing for fighting pirates

Kill a pirate NPC in a pirate or contested system. You get a small standing gain with an empire or with CONCORD. The faction depends on the system: first the side that fights the pirate for the system, then the faction of the system from the game data, then the empire that is the rival of that pirate. The pirate never gets a gain. In an empire system and in a quiet system without a pirate you get nothing.

When the server has the pirate side turned on: killing an empire or CONCORD NPC in pirate space gives a small standing gain with the pirate of that space. From standing 2.0 with a faction, its fleets stop hunting you (when the server has loyal-pilot sparing turned on).

When the server has docking refusal turned on: an NPC station in a system controlled by a faction does not accept you if your standing with that faction is -5 or lower. In a capsule you can always dock.

### Faction contracts

Factions buy minerals at their stations. The offers are contracts of NPC corporations.

1. Find a contract of a faction corporation at a station.
2. Deliver the minerals to the station of the contract.
3. You get the ISK of the contract and a small standing gain with the faction.

The price depends on market prices. The server can fetch Jita prices from the internet.

**Faction buy orders.** When the server has faction buy orders turned on, a faction also buys ships through the market (a buy order of an NPC corporation at a station). Sell the ship packaged. Modules, cargo and drones in an assembled ship disappear together with it. A market sale gives no standing and no LP.

### Liberating systems

When you kill NPCs of the faction that controls a system, the influence of that faction in the system drops. When the influence stays too low for some time, the faction loses the system. The system is then left without a controller. Other factions can take it later. ISK and LP rewards for liberation are off by default.

### War map in the browser

The server operator can show you the observer page (`http://127.0.0.1:26410/` on the server machine). The page shows the galaxy map, system control, fronts and fleets. The page only shows data. It does not change the game.

## What we do not promise with the default settings

These features are in the mod, but they are off by default. The server operator decides whether to turn them on. When a feature is off, you do not see it in the game.

- Faction fleets as real ships in space and live combat with them.
- Faction fleet hunts on a player and pursuit through gates.
- A player stops an invasion by fighting the invader fleet.
- War sites (anomalies, events) from the mod factions.
- Faction convoys and miners as ships you can attack.
- Sovereignty and Upwell structures of the factions in EveJS.
- The `!front` command in local chat.
- EVE mail about war events.
- ISK and LP payouts for liberating a system.
- A Rogue Drone swarm as a faction.
- Faction AI that reacts to your kills.
- Faction loot crates in pirate war sites (described below).

### Faction loot crates (when the operator turns them on)

In a nullsec system that a pirate is fighting for, or that a pirate has just taken, a "Supply Depot" or "War Vault" site of that pirate can appear. The site starts when you are in the system or 1 jump from it. In the site, about 5 km from the center, there is a wreck crate. The crate holds normal loot and can hold ammunition or a faction module of the pirate (for example Domination, Dark Blood). The chance of a faction module is small. There is one crate per event. The number of crates per day has a limit. The crate disappears after the event ends. The sites are visible on the observer map (events layer).

### DED complexes and battle ruins (when the operator turns them on)

In a nullsec system held by a pirate, a "Deadspace Complex" signature of that pirate (DED 6 to 10) can appear. Find it with probes. The gate lets in only battleships and T3 cruisers. When you clear the complex, the pirate loses influence in the system. In a nullsec system where a faction lost a battle, a "Battlefield Ruins" signature of that faction can appear: a relic or data site without NPCs, with containers to hack. Ruins do not change the influence of the faction.

### LNE Board window (when the operator turns it on)

Type `!board` in local chat. The "LNE Board" window opens with front orders and war contracts. Next to a front order, click `Accept` to track it. The order moves to the "Mine" section at the top of the window. `Drop` removes it from that section. Accept does not reserve the order and does not change the reward: other players can work on it too, and every contribution of yours counts the same as without Accept. You can track at most 5 orders. The "Mine" section also shows the orders you have already contributed to, and your rewards from the last 24 hours (payout state: `PAID` or `PENDING`).

Below the war contracts there are three sections:

- "Nearby": events, heavy events, power sites, event anomalies (for example "Regroup Camp", "Invasion Staging", "Mutineer Flotilla", "Smuggling Run", "Forward Supply Cache", "Convoy Wreckage") and wreck fields up to 8 jumps from you. The difficulty of an event anomaly is in brackets: `[L4]`, `[L5]` or `[INCURSION]`. The nearest ones are at the top. `Route` sets the travel destination, `Info` opens the system information. The state `WAITING` means the site is waiting for a player. Without a player nearby it expires. The row `[SIG] Unknown signature` is a signature: the window shows only the system. Fly there and find it with probes.
- "Front": the state of the war in your system and region (the same lines as `!front`).
- "News": the headline of the latest Scope News issue (when the operator turned the news on).

The operator knows which of these features are on for your server. The operator finds every flag in the mod `.env.example`.
