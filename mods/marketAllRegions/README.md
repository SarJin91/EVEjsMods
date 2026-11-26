# Market All Regions (EveJS loader mod)

The market window's order list for a type (`marketProxy.GetOrders`) shows sell
and buy orders from **every region**, not only the session region. Jump counts
are computed by vanilla EveJS as usual.

## What it does not do

- **No cross-region trading.** Buying, selling and placing orders still see
  only the session region's order book. "Buy" on an order in another region
  buys nothing.
- No change to region best prices (`GetRegionBest`), `GetSystemAsks`,
  `GetStationAsks` or the market group tree ("show only available").
- No per-player switch: the flag is global for the server. The EveJS web
  gateway, which calls the same handler, also gets every region.

## How it works

Two chained prototype wraps, installed from a `Module._load` hook (no game code
is required at preload):

1. `MarketProxyService.prototype.Handle_GetOrders` runs the original method
   unchanged inside an `AsyncLocalStorage` scope.
2. `MarketDaemonClient.prototype.call` answers the one matching
   `GetOrders(region, type)` read inside that scope: the session region is
   always read fresh and complete, then the best foreign rows (cheapest sells,
   highest buys) of all other regions are appended. Every other daemon call
   (transactions, other mods) passes through untouched.

The foreign part is cached per type (TTL) and shared by concurrent reads. A
failing foreign region is skipped and logged (rate-limited); an incomplete
fetch is never cached. A failing own region gives the vanilla
`MarketUnavailable` error. If a wrapped method is missing at load (DRIFT) the
mod logs one `DRIFT` line and stays inert: vanilla market.

## Settings

Environment variables (a real variable wins over `mods/marketAllRegions/.env`;
see `.env.example` for every key, default and range):

| Key | Default | Meaning |
|---|---|---|
| `EVEJS_MARKET_ALL_REGIONS` | `1` | `0` = vanilla market |
| `EVEJS_MARKET_ALL_REGIONS_MAX_FOREIGN_ROWS` | `150` | foreign rows per side (0..5000) |
| `EVEJS_MARKET_ALL_REGIONS_CACHE_TTL_MS` | `60000` | foreign part cache, 0 = off |
| `EVEJS_MARKET_ALL_REGIONS_CACHE_MAX_TYPES` | `200` | types in that cache |
| `EVEJS_MARKET_ALL_REGIONS_CONCURRENCY` | `8` | parallel daemon reads per fetch |
| `EVEJS_MARKET_ALL_REGIONS_INCLUDE_WORMHOLE` | `0` | include J-space regions |
| `EVEJS_MARKET_ALL_REGIONS_ERROR_LOG_INTERVAL_MS` | `60000` | region error log window |
| `EVEJS_MARKET_ALL_REGIONS_VERBOSE` | `0` | one log line per fetch |

A value out of range makes the mod install nothing (logged as invalid
configuration). If opening a type stutters the server, lower
`EVEJS_MARKET_ALL_REGIONS_MAX_FOREIGN_ROWS` (e.g. `100`): vanilla computes the
jump count of every shown row.

## Install / disable

Docker: `--require /app/mods/marketAllRegions/loader.js` in both server blocks
of `docker/entrypoint.sh`, then `docker compose build init` and
`docker compose up -d`. Disable with `EVEJS_MARKET_ALL_REGIONS=0` in the
server's `environment:` in `compose.yaml` (no rebuild), or remove the
`--require` line.

Startup log: `[marketAllRegions] v1.0.0 active - ...`, then, once the market
modules load, `wrapped daemon (...)` and `wrapped proxy (...)`. `active`
without both `wrapped` lines means the wraps are still pending (target not
loaded or at another path); `stats()` on `Symbol.for("evejs.marketAllRegions")`
reports `proxyWrapped` / `daemonWrapped`.
