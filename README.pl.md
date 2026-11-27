# EVEjsMods

Zbiór modów serwera dla [EveJS](https://github.com/V0nCleef/evejs), emulatora
serwera EVE Online. Wszystkie mody to mody typu loader dla Node.js: podpinają
się pod EveJS przy starcie i nie zmieniają żadnego pliku EveJS.

[English version](README.md)

## Mody

| Mod | Wersja | Co robi |
|---|---|---|
| [livingNewEden](mods/livingNewEden/README.md) | 0.2.1 | Żywy wszechświat: frakcje NPC trzymają terytorium, przesuwają floty, prowadzą gospodarkę i wojny, kiedy grasz; ruch cywilny, górnicy, ratterzy i eksploratorzy wypełniają systemy wokół ciebie. |
| [shipWing](mods/shipWing/README.md) | 0.2.2 | Kopie zafitowanych statków z Ship Maintenance Bay twojego obecnego statku (dowolny kadłub) lecą za tobą jako skrzydło; w doku pokazuje zawartość SMB tylko do odczytu. Wersja testowa, domyślnie wyłączona. |
| [hotPathPerf](mods/hotPathPerf/README.md) | 0.24.2 | Mierzy wolne wywołania EveJS; opcjonalne poprawki długich zawieszeń serwera. |
| [sharedStorePerfFix](mods/sharedStorePerfFix/README.md) | 1.1.0 | Zapis tabeli struktur przy starcie zostaje liniowy (jedna statystyka planera SQLite), a zapisy lustra suwerenności bez zmian są pomijane. Obejście błędów EveJS, nie zmienia danych. |
| [scenePerfFix](mods/scenePerfFix/README.md) | 1.0.0 | Szybsze zatłoczone systemy na starszych wersjach EveJS (stojące wraki, wyszukiwanie po nazwie). Na obecnym EveJS w większości nieaktywny. |
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

- EveJS **261126.2** (wersja w `server/package.json`). Inne wersje mogą
  działać, ale nie są testowane; każdy mod sprawdza kod EveJS, pod który się
  podpina, i przy niezgodności pozostaje nieaktywny (`DRIFT` w logu).
- Klient EVE Online w buildzie **3724492** (build obsługiwany przez EveJS).
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

   Zachowaj tę kolejność modów z tej kolekcji: sharedStorePerfFix,
   scenePerfFix, hotPathPerf, shipWing, blueprintDrops, marketAllRegions,
   dailyGoalsPersist, industryOrphanCleanup, skyhookOrphanFix, customTypes,
   planetaryDrill, missionStructureRestore, livingNewEden (jego `loader.js`
   na końcu).
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

Foldery modów w tym repozytorium to pełne drzewo deweloperskie: pliki
uruchomieniowe, dokumentacja, testy (`test/`, `RunTests.bat`), generatory
danych i narzędzia operatora (`tools/`). Testy, generatory i narzędzia nie są
potrzebne do działania moda. Pliki ZIP z wydań nie zawierają testów (`test/`,
`RunTests.bat`); część narzędzi deweloperskich, które czytają scenariusze
testowe, wymaga klona tego repozytorium.

## Konfiguracja

Każdy mod czyta, od najniższego do najwyższego priorytetu:

1. wbudowane wartości domyślne;
2. `settings.json` w folderze moda, zapisywany przez okno **Configure**
   launchera (mody, które je mają). `settings.example.json`, jeśli jest,
   pokazuje format;
3. `.env` w folderze moda (skopiuj `.env.example`; tam jest opis każdego klucza);
4. zmienne środowiskowe (w Dockerze: `environment:` usługi serwera).

Zmiany działają po restarcie serwera. Klucze API (funkcje AI w Living New Eden)
są czytane tylko z `.env` albo ze środowiska; mody nie zawierają żadnych kluczy.

## Znane problemy

- **customTypes:** na obecnym EveJS trzymaj sklep z blueprintami wyłączony
  (`EVEJS_CUSTOMTYPES_SHOP_ENABLED=0`) do czasu poprawki. Własne typy i
  blueprinty działają bez niego.
- **livingNewEden:** okna tablicy zleceń i mapy w grze wymagają drugiego
  preloadu, `mods/livingNewEden/clientHook.js`, przed shipWing. Launcher
  ładuje tylko `loader.js`, więc te dwa okna działają tylko przy instalacji
  przez Docker albo ręcznej.

## Współpraca

Pull requesty są mile widziane; najpierw przeczytaj
[`CONTRIBUTING.md`](CONTRIBUTING.md) (po angielsku). Gałąź od aktualnego
`main`, nowe funkcje za flagą domyślnie wyłączoną, zielona suita testów
każdego zmienianego moda.

## Podziękowania

- **greatguy** (Discord EveJS, [EJS]) - dziękujemy za pomysły i kod
  udostępnione społeczności w paczkach Living New Eden. Co z nich trafiło do
  Living New Eden:
  - trwały zapis tabel (durable flush), kolejność ładowania w launcherze
    (`loadAfter`), etykiety ustawień governora obciążenia i log czasu deployu
    sentry (paczka dla EveJS 261125.3);
  - efekty JumpIn / JumpOut ruchu cywilnego przy bramach;
  - align przed warpem ruchu cywilnego;
  - wiązki górnicze cywilnych górników;
  - ucieczka cywilnych haulerów warpem po agresji gracza oraz ucieczka
    cywili w pobliżu zaatakowanego cywila;
  - kapsuły NPC odlatujące warpem po zniszczeniu statku;
  - zdarzenia Arrival / Departure kontrolera bramy;
  - podlot górników do skały na subwarpie przed wiązką;
  - zdarzenia aktywności populacji (ratting, eksploracja);
  - patrole cywilnych ratterów po pasach;
  - wizyty cywilnych eksploratorów na publicznych site'ach data i relic;
  - widoczny efekt warpu przy natychmiastowych warpach ruchu cywilnego;
  - poza przylotu przy bramie (statek po skoku stoi odwrócony od pierwszego
    celu, zanim zrobi align).

  Nowe zachowania i efekty cywili są domyślnie wyłączone. Szczegółowe
  przypisanie (plik po pliku) jest w
  [`mods/livingNewEden/CREDITS.md`](mods/livingNewEden/CREDITS.md).
- [EveJS](https://github.com/V0nCleef/evejs) i
  [EveJS Launcher](https://github.com/V0nCleef/evejs-launcher)
  (AGPL-3.0-only) - serwer, na którym działają mody; drobne helpery są z
  niego przeniesione, żeby mody zachowywały się dokładnie jak EveJS.
- [X-Eve Living Universe](https://github.com/kaiwren986/evejs-living-universe)
  (MIT, własny wkład patcha) - deterministyczne hashowanie i RNG, odciski
  księgi, kolejka terminów, budżety pracy, percentyle telemetrii, governor
  obciążenia, wyszukiwanie tras, model podróży warpem i przebieg
  materializacji konfliktów w Living New Eden, a także pomysły na gate campy,
  salvage, zlecenia kupna NPC i trasy przez wormhole.
- [Elysian Universe Site Seeder](https://github.com/Alanahwellordered661/elysian-universe-site-seeder-eve-online-evejs)
  (AGPL-3.0) i paczki treści EveJS - wzorzec generowania site'ów i dane
  site'ów.
- [Eve Fleet Simulator](https://github.com/MaruMaruOO/eve-fleet-simulator)
  (AGPL-3.0) - materiał badawczy do kalibracji resolvera bitew; bez kodu.
- [zKillboard](https://zkillboard.com/) - zrzuty killmaili (dane killmaili
  CCP Games przez ESI) użyte offline do kalibracji resolvera bitew; mody nie
  zawierają danych killmaili.
- [Fuzzwork Market](https://market.fuzzwork.co.uk/) - opcjonalny odczyt cen
  Jity w czasie działania.
- [Piper TTS](https://github.com/OHF-Voice/piper1-gpl) i
  [piper-voices](https://huggingface.co/rhasspy/piper-voices) - opcjonalny
  głos AI statku, uruchamiany jako osobna usługa, którą instalujesz sam.
- Advanced Utility Drones, DroneClassBalance i MoonOreAnomalies (mody EveJS
  ich autorów) oraz fork EveJS ciefa - wzorce i odniesienia (odpowiedzi na
  czacie, dostarczanie do klienta, panel ustawień, szablony tylko do
  odczytu); bez kopiowania kodu, chyba że `CREDITS.md` moda mówi inaczej.
- CCP Games - EVE Online Static Data Export (build 3396210), z którego
  wygenerowano tabele danych.

`CREDITS.md` każdego moda wymienia źródła plik po pliku; licencje są zebrane w
[`NOTICE.md`](NOTICE.md).

## Licencja

AGPL-3.0, patrz [`LICENSE`](LICENSE). Źródła zewnętrzne i ich licencje (EveJS,
X-Eve Living Universe, Elysian Site Seeder, dane CCP) są w
[`NOTICE.md`](NOTICE.md).

Projekt niezwiązany z CCP Games. EVE Online jest znakiem towarowym CCP hf.
