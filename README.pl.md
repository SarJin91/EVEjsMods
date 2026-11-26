# EVEjsMods

Zbiór modów serwera dla [EveJS](https://github.com/V0nCleef/evejs), emulatora
serwera EVE Online. Wszystkie mody to mody typu loader dla Node.js: podpinają
się pod EveJS przy starcie i nie zmieniają żadnego pliku EveJS.

[English version](README.md)

## Mody

| Mod | Wersja | Co robi |
|---|---|---|
| [livingNewEden](mods/livingNewEden/README.md) | 0.1.0 | Żywy wszechświat: frakcje NPC trzymają terytorium, przesuwają floty, prowadzą gospodarkę i wojny, kiedy grasz. |
| [shipWing](mods/shipWing/README.md) | 0.2.0 | Kopie zafitowanych statków z Ship Maintenance Bay twojego obecnego statku (dowolny kadłub) lecą za tobą jako skrzydło; w doku pokazuje zawartość SMB tylko do odczytu. Wersja testowa, domyślnie wyłączona. |
| [hotPathPerf](mods/hotPathPerf/README.md) | 0.24.1 | Mierzy wolne wywołania EveJS; opcjonalne poprawki długich zawieszeń serwera. |
| [scenePerfFix](mods/scenePerfFix/README.md) | 1.0.0 | Szybsze zatłoczone systemy na starszych wersjach EveJS (stojące wraki, wyszukiwanie po nazwie). Na 261115.2 w większości nieaktywny. |
| [planetaryDrill](mods/planetaryDrill/README.md) | 1.1.0 | Orbital Skyhook poza sov null-sec wydobywa surowiec P0 planety. Wymaga skyhookOrphanFix i customTypes. |
| [customTypes](mods/customTypes/README.md) | 1.0.0 | Własne typy przedmiotów i blueprinty z paczek danych, z narzędziem do danych klienta. |
| [blueprintDrops](mods/blueprintDrops/README.md) | 1.0.0 | Wraki NPC mogą zawierać blueprinty; opcjonalnie rezonatory piratów i łupy frakcji. |
| [dailyGoalsPersist](mods/dailyGoalsPersist/README.md) | 1.0.0 | Postęp i odebrane nagrody celów dziennych przetrwają restart serwera. |
| [industryOrphanCleanup](mods/industryOrphanCleanup/README.md) | 1.0.0 | Usuwa osierocone rekordy stanu blueprintów po usunięciu postaci. |
| [marketAllRegions](mods/marketAllRegions/README.md) | 1.0.0 | Okno rynku pokazuje zlecenia ze wszystkich regionów (handel zostaje regionalny). |
| [missionStructureRestore](mods/missionStructureRestore/README.md) | 1.0.0 | Przywraca struktury-cele misji utracone po restarcie serwera. |
| [skyhookOrphanFix](mods/skyhookOrphanFix/README.md) | 1.0.0 | Skyhooki poza sov null-sec otwierają okno zamiast błędu 404. |

Opisy poszczególnych modów (README w folderach) są po angielsku.

## Wymagania

- EveJS **261115.2** (wersja w `server/package.json`). Inne wersje mogą
  działać, ale nie są testowane; każdy mod sprawdza kod EveJS, pod który się
  podpina, i przy niezgodności pozostaje nieaktywny (`DRIFT` w logu).
- Klient EVE Online w buildzie **3396210** (build obsługiwany przez EveJS).
- Node.js w wersji wymaganej przez EveJS.

## Instalacja

Wybierz jeden z trzech sposobów. Każdy mod to folder w `mods/` instalacji
EveJS; nazwa folderu musi zostać taka jak w tym repozytorium. Pliki ZIP z
wydań zawierają folder moda z wyłączonym loaderem (`loader.js.disabled`), tak
jak oczekuje launcher. Przy Dockerze i instalacji ręcznej skopiuj folder z tego
repozytorium albo po rozpakowaniu ZIP zmień nazwę `loader.js.disabled` na
`loader.js`.

### a) EveJS Launcher

1. Pobierz `<Mod>-<wersja>.zip` ze strony
   [Releases](https://github.com/SarJin91/EVEjsMods/releases).
2. W launcherze otwórz **Mods -> Add ZIP** i wybierz plik. Mod zostanie dodany
   jako wyłączony.
3. Włącz go i użyj **Apply & Restart Server**.

Każdy mod wskazuje to repozytorium jako źródło aktualizacji, więc **Check mod
updates** w launcherze pokaże nowsze wydania. Aktualizacja w launcherze
zachowuje `settings.json` zapisany przez **Configure**, ale nie plik `.env` w
folderze moda: zrób jego kopię przed aktualizacją albo użyj zmiennych
środowiskowych.

### b) Docker

1. Skopiuj folder moda (np. `mods/livingNewEden`) do folderu `mods/` swojej
   kopii EveJS.
2. W `docker/entrypoint.sh` dopisz linię w **obu** blokach `node`:

   ```sh
   --require /app/mods/<folder>/loader.js \
   ```

   Zachowaj tę kolejność modów z tej kolekcji: scenePerfFix, hotPathPerf,
   shipWing, blueprintDrops, marketAllRegions, dailyGoalsPersist,
   industryOrphanCleanup, skyhookOrphanFix, customTypes, planetaryDrill,
   missionStructureRestore, livingNewEden (jego `loader.js` na końcu).
3. Przebuduj obraz i uruchom ponownie: `docker compose build`, potem
   `docker compose up -d`.

Trwałe dane modów trzymaj w wolumenie danych (`EVEJS_DATA_ROOT`), nie w
folderze moda.

### c) Natywnie, ręcznie

Skopiuj folder moda do `mods/` w folderze EveJS i uruchom serwer z
załadowanym loaderem, z folderu `server`:

```sh
node --require ../mods/<folder>/loader.js .
```

Kilka modów: jedno `--require` na mod, w kolejności podanej wyżej. Tak samo
robi launcher przy starcie natywnym. Mod skopiowany ręcznie może wymagać
**Adopt** w launcherze, zanim launcher będzie nim zarządzał.

Testy, benchmarki i generatory danych zostają w drzewie deweloperskim;
opublikowane mody zawierają pliki uruchomieniowe, dokumentację i kilka
narzędzi operatora (`tools/` w Living New Eden).

## Konfiguracja

Każdy mod czyta, od najniższego do najwyższego priorytetu:

1. wbudowane wartości domyślne;
2. `settings.json` w folderze moda, zapisywany przez okno **Configure**
   launchera (mody, które je mają);
3. `.env` w folderze moda (skopiuj `.env.example`; tam jest opis każdego klucza);
4. zmienne środowiskowe (w Dockerze: `environment:` usługi serwera).

Zmiany działają po restarcie serwera. Klucze API (funkcje AI w Living New Eden)
są czytane tylko z `.env` albo ze środowiska; mody nie zawierają żadnych kluczy.

## Znane problemy

- **customTypes:** na EveJS 261115.2 trzymaj sklep z blueprintami wyłączony
  (`EVEJS_CUSTOMTYPES_SHOP_ENABLED=0`) do czasu poprawki. Własne typy i
  blueprinty działają bez niego.
- **livingNewEden:** okna tablicy zleceń i mapy w grze wymagają drugiego
  preloadu, `mods/livingNewEden/clientHook.js`, przed shipWing. Launcher
  ładuje tylko `loader.js`, więc te dwa okna działają tylko przy instalacji
  przez Docker albo ręcznej.

## Licencja

AGPL-3.0, patrz [`LICENSE`](LICENSE). Źródła zewnętrzne i ich licencje (EveJS,
X-Eve Living Universe, Elysian Site Seeder, dane CCP) są w
[`NOTICE.md`](NOTICE.md).

Projekt niezwiązany z CCP Games. EVE Online jest znakiem towarowym CCP hf.
