# Codex / DeepSeek tööülesanne – raamatupidamise SaaS-i ehitamise alustamine

Sul on selles projektikaustas kaks väga olulist lähtefaili:

1. `raamatupidamise_saas_ARCHITECTURE_v2.md`
2. `server.md`

## Eesmärk

Hakka raamatupidamise SaaS-i **rahulikult, etapiviisiliselt ja testitavalt päriselt ehitama** vastavalt `raamatupidamise_saas_ARCHITECTURE_v2.md` plaanile.

Lahendus peab lõpuks töötama Linuxi serveris.

Olemasolevat Linuxi serverit võib kasutada, kuid `server.md` kirjeldab serverit ja seal juba töötavaid teenuseid. **Ühtegi olemasolevat teenust ei tohi ära rikkuda, peatada, ümber seadistada ega juhuslikult üle kirjutada.**

Ära tee ainult plaani. Pärast kontrolli ja ettevalmistust alusta reaalselt v0.1 implementeerimist, testi seda ja paranda leitud vead.

---

# 1. Kõigepealt loe lähtefailid TÄIELIKULT läbi

Enne ühegi faili muutmist või serveris midagi käivitamist:

- loe `raamatupidamise_saas_ARCHITECTURE_v2.md` täielikult;
- loe `server.md` täielikult;
- vaata läbi kogu olemasolev projektikaust ja repo struktuur;
- vaata läbi olemasolevad config-, Docker-, reverse-proxy-, deployment- ja environment-failid, kui need eksisteerivad;
- kontrolli, kas projektis on juba koodi, mida tuleb säilitada või edasi kasutada.

`raamatupidamise_saas_ARCHITECTURE_v2.md` on toote ja arhitektuuri **source of truth**.

`server.md` on olemasoleva serveri, teenuste, portide, deploy-keskkonna ja piirangute **source of truth**.

Kui nende vahel on vastuolu:
- ära arva;
- vali turvalisem variant;
- dokumenteeri vastuolu;
- ära ohusta olemasolevaid teenuseid.

Ära prindi ega kopeeri oma vastusesse `server.md` sees olevaid paroole, võtmeid, tokeneid ega muid saladusi.

---

# 2. Serveri ohutus on absoluutne nõue

Serveris töötab juba mitu teenust.

Enne deploy'd tee inventuur ja tuvasta vähemalt:

- Linuxi distributsioon ja versioon;
- CPU/RAM/disk kasutus;
- aktiivsed systemd teenused;
- töötavad Docker containerid, kui Docker on kasutusel;
- Docker Compose projektid;
- kasutuses olevad TCP/UDP pordid;
- nginx / Apache / Caddy / Traefik või muu reverse proxy;
- olemasolevad PostgreSQL/MySQL/Redis instantsid;
- olemasolevad domeenid/subdomeenid;
- SSL sertifikaatide haldus;
- tulemüüri olek;
- olemasolevad projektikaustad;
- backup-mehhanismid.

## Keelatud ilma vältimatu vajaduse ja selge põhjenduseta

ÄRA:

- peata olemasolevaid teenuseid;
- restardi tervet serverit;
- tee `docker system prune`;
- tee `docker volume prune`;
- kustuta võõraid containereid, võrke või volume'e;
- tee `apt full-upgrade` / distributsiooni upgrade'i;
- muuda globaalset PostgreSQL konfiguratsiooni;
- muuda olemasolevate andmebaaside skeeme;
- muuda SSH konfiguratsiooni;
- muuda firewalli üldreegleid;
- muuda olemasoleva veebiserveri globaalset konfiguratsiooni;
- kirjuta üle olemasolevaid `.env` faile;
- kasuta olemasoleva teenuse andmebaasi selle projekti jaoks;
- hõiva juba kasutusel olevat porti;
- kustuta või nimeta ümber serveris olevaid võõraid faile;
- tee destruktiivseid migratsioone pärisandmete vastu.

Kui olemasolevat reverse proxy konfiguratsiooni on vaja täiendada, tee ainult **selle projekti isoleeritud site/service konfiguratsioon**, valideeri konfiguratsioon enne reload'i ja tee eelmisest failist backup.

Serveri restart ei ole aktsepteeritav tavapärase deploy-meetodina.

---

# 3. Isoleeri uus projekt olemasolevatest teenustest

Uus raamatupidamise SaaS peab olema serveris selgelt eraldatud.

Eelista:

- oma projektikausta;
- oma service/container nimesid;
- oma Docker Compose project name'i, kui Docker on kasutusel;
- oma Docker network'i;
- oma volume'e;
- oma andmebaasi;
- oma DB kasutajat;
- oma `.env` faili;
- oma logisid;
- oma backup-kausta;
- oma vaba porti.

Ära kasuta üldnimesid nagu:

```text
app
db
postgres
backend
frontend
```

kui need võivad teiste teenustega konflikti minna.

Kasuta projekti-spetsiifilist prefiksit, näiteks:

```text
accounting-*
raamatupidamine-*
```

või repo tegelikust nimest tuletatud üheselt eristatavat nime.

Kui `server.md` näitab olemasolevat nimekonventsiooni, järgi seda.

---

# 4. Arhitektuuri põhireegleid ei tohi rikkuda

Järgi `raamatupidamise_saas_ARCHITECTURE_v2.md` põhimõtteid.

Eriti:

- alguses modulaarne monoliit, mitte mikroteenuste rägastik;
- frontend ja backend selgelt eraldatud;
- PostgreSQL;
- API versioneerimine kohe algusest, nt `/api/v1/...`;
- DEV / STAGING / PROD kontseptsioon;
- multi-tenant süsteem;
- tenant isolation;
- hiljem PostgreSQL RLS;
- immutable postitatud finantskanded;
- debit == credit invariant;
- audit trail;
- Trace ID ja Error ID;
- idempotentsus;
- inbox/outbox;
- deterministlik raamatupidamisloogika;
- AI ei ole finantsreeglite tõeallikas;
- country rules on versioonitud;
- raha ei arvutata JavaScript floating point'iga;
- tehnilised timestamp'id UTC-s ja business date eraldi.

Ära ehita praegu ette suuri tulevasi mooduleid, mida v0.1 ei vaja.

Ära loo abstraktsioone lihtsalt abstraktsioonide pärast.

---

# 5. Tehnoloogiapinu

Kui repo tehnoloogiapinu ei ole veel lukustatud, vali konservatiivne, pikaajaliselt hooldatav ja Linuxis hästi töötav stack.

Enne valikut kontrolli olemasolevat repot ja `server.md`.

Eelistused:

## Frontend

- TypeScript
- React
- kaasaegne, stabiilne framework/tooling
- lihtne hele UI
- i18n valmidus kohe algusest

## Backend

- TypeScript või muu projektiga hästi sobiv tugevalt tüübitud lahendus
- selge module/service/repository piir
- OpenAPI
- tugev request validation
- structured logging
- PostgreSQL

## Andmebaas

- PostgreSQL
- migrations source control'is
- mitte kunagi production schema käsitsi muutmine ilma migrationita

## Deployment

Kui serveris on Docker/Compose juba normaalselt kasutusel, eelista projekti isoleeritud Docker Compose lahendust.

Kui serveri olemasolev arhitektuur kasutab teist kindlat deployment mudelit, järgi pigem serveri olemasolevat ohutut mustrit.

Ära paigalda uut rasket infrastruktuurikihti lihtsalt sellepärast, et see on võimalik.

---

# 6. Esimene tööetapp: v0.1 Infrastructure

Alusta ainult v0.1-st.

v0.1 eesmärk:

- repo struktuur;
- frontend skeleton;
- backend skeleton;
- `/api/v1` alus;
- health endpoint;
- PostgreSQL ühendus;
- migration system;
- config/environment validation;
- structured logging;
- Trace ID/request ID middleware;
- Error ID infrastruktuuri alus;
- background jobs/worker skeleton ainult juhul, kui see on vundamendiks vajalik;
- test framework;
- lint;
- typecheck;
- CI skeleton;
- Docker/deployment alus;
- health checks;
- backup-strateegia dokumentatsioon;
- DEV/STAGING/PROD konfiguratsiooni eraldamise alus.

Ära hakka v0.1-s veel müügiarveid, panka, payroll'i või AI-d ehitama.

---

# 7. v0.1 minimaalne töötav tulemus

v0.1 lõpus peab olema võimalik Linuxi serveris käivitada süsteem nii, et vähemalt:

```text
GET /api/v1/health
```

annab tervisliku vastuse.

Backend peab suutma kontrollida andmebaasi ühendust.

Frontend peab avanema.

Rakenduse logides peab iga request olema seotud Trace ID-ga.

Viga peab olema võimalik logida struktureeritud kujul.

Näiteks kontseptuaalselt:

```json
{
  "level": "error",
  "module": "system",
  "error_id": "SYS-001",
  "trace_id": "...",
  "action": "database_healthcheck"
}
```

Secrets ei tohi logidesse sattuda.

---

# 8. Testi enne deploy'd

Enne serverisse deploy'd käivita lokaalselt või build-keskkonnas:

- dependency install;
- lint;
- typecheck;
- unit tests;
- integration tests;
- production build;
- migration test puhta andmebaasi vastu;
- startup test;
- healthcheck.

Kõik vead paranda enne deploy'd.

Ära märgi testi PASS, kui sa seda tegelikult ei käivitanud.

---

# 9. Deploy olemasolevasse Linux serverisse

Alles pärast kohalike testide PASS-i:

1. kontrolli veel kord kasutatavat porti;
2. kontrolli, et service/container name ei konflikti;
3. kontrolli DB nime ja kasutajat;
4. tee vajalikest muudetavatest serverikonfidest backup;
5. deploy ainult uue projekti komponendid;
6. ära puutu teisi teenuseid;
7. kontrolli startup logisid;
8. kontrolli health endpointi;
9. kontrolli frontendi;
10. kontrolli DB connection'it;
11. kontrolli serveri olemasolevaid teenuseid ka PÄRAST deploy'd.

Pärast deploy'd tõesta, et olemasolevad teenused töötavad endiselt.

Vähemalt:

- nende container/service status on sama;
- kriitilised olemasolevad portid kuulavad;
- reverse proxy config on valid;
- olemasolevate teenuste health-checkid või HTTP endpointid töötavad, kui neid saab turvaliselt kontrollida.

---

# 10. Kui midagi läheb serveris valesti

Kui uus deploy põhjustab vea:

- lõpeta uue projekti deploy;
- rollback'i ainult enda tehtud muudatused;
- ära hakka olemasolevaid teenuseid “parandama”, kui need enne töötasid;
- taasta muudetud config backupist;
- dokumenteeri põhjus.

Kõik deploy'd peavad olema võimalikult lihtsalt tagasi pööratavad.

---

# 11. Testi pidevalt arenduse käigus

Pärast iga sisulist muudatust:

```text
implement
↓
lint
↓
typecheck
↓
tests
↓
fix
↓
tests again
```

Ära kogu kümneid muudatusi enne esimest testimist.

Kui lisad DB migrationi:

```text
migration up
↓
test
↓
fresh DB migration
↓
test
```

Kui rollback on selle migrationi puhul mõistlik, testi ka rollback'i.

---

# 12. Security-by-default

Kohe algusest:

- secrets ainult environment/secrets lahenduses;
- `.env` gitignore'i;
- repo sisse ainult `.env.example`;
- production secrets ei tohi outputti sattuda;
- SQL parameterized/query builder/ORM kaudu;
- schema validation kõigile API inputidele;
- secure HTTP headers;
- dependency audit;
- minimaalsed DB õigused;
- eraldi rakenduse DB user;
- productionis debug stack trace'i kasutajale ei näidata.

Ära pane ühtegi parooli või tokenit source code'i.

---

# 13. Dokumentatsioon, mida jooksvalt hoida

Loo või uuenda vähemalt:

```text
README.md
ARCHITECTURE.md
DEPLOYMENT.md
IMPLEMENTATION_STATUS.md
CHANGELOG.md
```

Ära kirjuta `ARCHITECTURE.md` nullist ümber nii, et algne plaan kaob.

Kasuta `raamatupidamise_saas_ARCHITECTURE_v2.md` alusena ja säilita selle põhimõtted.

`IMPLEMENTATION_STATUS.md` peab näitama vähemalt:

```text
Current version
Completed
In progress
Not started
Known issues
Tests
Deployment status
Next step
```

---

# 14. Otsuste logi

Kui pead tegema arhitektuurilise valiku, mida plaan otseselt ei määra, dokumenteeri see.

Näiteks:

```text
docs/decisions/ADR-0001-backend-framework.md
docs/decisions/ADR-0002-database-access.md
```

ADR-is:

- probleem;
- variandid;
- valik;
- põhjendus;
- tagajärjed.

Ära tee suurt tehnoloogilist otsust vaikides.

---

# 15. Pärast v0.1 PASS-i

Kui v0.1:

- buildib;
- testid läbivad;
- serveris töötab;
- healthcheck on PASS;
- olemasolevad teenused pole mõjutatud;
- dokumentatsioon on uuendatud;

siis liigu `raamatupidamise_saas_ARCHITECTURE_v2.md` järgi v0.2 Identity juurde.

v0.2 juures ehita järk-järgult:

- users;
- register;
- e-mail verification;
- login;
- logout;
- password reset;
- TOTP 2FA;
- remember me 30 päeva;
- sessions;
- rate limiting;
- brute-force protection.

Ära mine v0.3 juurde enne, kui v0.2 testid on korras.

---

# 16. Arendamise tempo

Tee väikesed, kontrollitavad sammud.

Eelista:

```text
üks töötav ja testitud slice
```

mitte:

```text
20 poolikut moodulit
```

Kui mingi arhitektuuriosa on tulevikus vajalik, pane liides/skeleton valmis ainult siis, kui see aitab praegust etappi, mitte ära implementeeri kogu tulevast funktsionaalsust ette.

---

# 17. Git

Kui projekt on Git repos:

- ära kustuta olemasolevat history't;
- ära force-push'i;
- ära reset'i kasutaja muudatusi;
- ära commit'i secrets'e;
- hoia muudatused loogiliste väikeste commit'itena, kui commitimine on selles töökeskkonnas lubatud.

Enne muutmist vaata:

```text
git status
git diff
```

Kui kasutajal on pooleliolevaid muudatusi, säilita need.

---

# 18. Esimese töötsükli väljund

Esimeses töötsüklis tee reaalselt tööd, mitte ainult analüüsi.

Lõpus anna kokkuvõte:

## 1. Mida sa enne muutmist tuvastasid

- repo seis;
- tehnoloogiapinu;
- serveri deploy mudel;
- olemasolevad teenused, mida tuli kaitsta;
- valitud vaba port / teenusenimi / DB nimi ilma saladusi avaldamata.

## 2. Mida muutsid

Täielik failide nimekiri.

## 3. Arhitektuurilised otsused

Mida valisid ja miks.

## 4. Testid

Täpsed käivitatud käsud ja tulemused:

```text
PASS / FAIL
```

## 5. Serveri deploy

- kas deploy tehti;
- uus service/container;
- healthcheck;
- frontend;
- DB;
- kas olemasolevad teenused kontrolliti pärast deploy'd.

## 6. Probleemid

Kõik teadaolevad vead või riskid.

## 7. Järgmine samm

Mis on järgmine väike tööpakett vastavalt roadmap'ile.

---

# 19. Oluline käitumisreegel

Ära küsi minult kinnitust iga väikese faili või tavapärase arendusotsuse jaoks.

Tee ise mõistlikud ja konservatiivsed valikud, testi need ja dokumenteeri.

KÜSI enne ainult siis, kui:

- on reaalne oht olemasolevale serveriteenusele;
- oleks vaja kustutada pärisandmeid;
- oleks vaja muuta olemasoleva teenuse võrgu-, DB-, SSH- või turvaseadistust;
- on vaja teha otsus, mida ei saa lähtefailidest ega olemasolevast projektist turvaliselt tuletada;
- vajad puuduvat credential'i või välist teenust.

Muul juhul jätka tööd.

---

# 20. Alusta nüüd

Alusta järgmises järjekorras:

```text
1. Loe täielikult ARCHITECTURE fail
2. Loe täielikult server.md
3. Inventuuri repo
4. Inventuuri server – read-only kontroll
5. Kontrolli konflikte
6. Lukusta v0.1 tehniline lahendus
7. Dokumenteeri vajalikud ADR-id
8. Implementeeri v0.1
9. Testi
10. Paranda
11. Testi uuesti
12. Deploy isoleeritult Linux serverisse
13. Smoke test
14. Kontrolli, et vanad teenused töötavad endiselt
15. Uuenda dokumentatsioon
16. Raporteeri tehtu ja järgmine samm
```

Ära hüppa otse hilisematesse raamatupidamismoodulitesse.

Eesmärk on saada kõigepealt **väga tugev, testitud ja serveris töötav v0.1 vundament**, mille peale saame järgmised versioonid rahulikult ehitada.
