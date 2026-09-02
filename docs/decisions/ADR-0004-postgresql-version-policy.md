# ADR-0004 – PostgreSQL versioonipoliitika

Kuupäev: 2026-09-02

## Probleem

Serveri hostis töötab PostgreSQL 18 (`postgresql@18-main`), aga see projekt kasutab oma Docker containeris
PostgreSQL 17. Kas see on õige ning kuidas hoitakse versiooni kontrolli all?

## Taust / otsus

Kasutame projekti jaoks **PostgreSQL 17 (`postgres:17-alpine`)** oma isoleeritud Docker volume'is.

Põhjused:

1. **Isolatsioon**: hosti PostgreSQL 18 instants teenindab teisi projekte (`lahedal` jt). Selle projekti
   DB-kasutajat, skeeme ega globaalset konfiguratsiooni me ei puuduta.
2. **Ennustatavus**: iga arendaja ja server kasutavad sama image'i/versiooni; migrationid käivad sama
   major-versiooni vastu.
3. **Turvalisus**: uus projekt ei saa kogemata hosti DB õigusi ega teiste projektide andmeid.
4. **Pikaajaline tugi**: PostgreSQL 17 on toetatud kuni 2029, v0.2/v0.3 arenduse ajaks piisav.

## Versiooni pin'imine

- `compose.yaml` määrab image'i täpselt: `postgres:17-alpine`.
- Täpsem commit-pin on Dockerfile/image digest; tahtlikud major-versiooni uuendused tehakse eraldi
  muudatusena, mitte jooksva `latest` tõmbamisena.

## Tulevane upgrade

Major-uuring tehakse enne üleminekut:

1. dokumenteeri uue major-versiooni muudatused;
2. tee täis backup (pg_dump);
3. taasta backup eraldi test-containerisse uue versiooniga;
4. jooksuta migratsioonid + integratisioonitestid;
5. alles siis vaheta image ja volume/andmete migreerimine (pg_upgrade või dump/restore);
6. hoia vana backup alles kuni uus versioon on mitu päeva stabiilne.

## Backup/restore major upgrade puhul

- Backup on `pg_dump` tekstikujuline dump, mis on major-versioonist sõltumatu restore'itav.
- Restore-test on kohustuslik enne iga major-upgrade't.
- Production DB peale kunagi otse ei restore'ita ilma eraldi protseduurita.

