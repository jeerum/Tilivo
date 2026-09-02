# Codex / DeepSeek tööülesanne – Tilivo v0.4 Completion / Gate Closure

## Eesmärk

Tilivo v0.4 on osaliselt implementeeritud ja production’is deploy’itud, kuid gate on hetkel:

```text
V0.4 PLATFORM + DESKTOP UI GATE: FAIL
```

Ära alusta v0.5 Accounting Core’i.

Selle tööülesande eesmärk on lõpetada **AINULT v0.4 puuduvad osad**, parandada leitud vead, deploy’da parandused ja jõuda ausalt kas:

```text
V0.4 PLATFORM + DESKTOP UI GATE: PASS
```

või:

```text
V0.4 PLATFORM + DESKTOP UI GATE: FAIL
```

Olemasolevat töötavat v0.4 funktsionaalsust ära kirjuta ümber ilma põhjuseta.

---

# 1. Praegune teadaolev seis

Valmis ja PASS:

```text
Desktop-first shell
Sidebar
Topbar
Tenant switcher
Audit append-only privileges
Audit tenant/API filtering
Audit hash-chain foundation
Documents + document_versions
Document RLS + FORCE RLS
LocalObjectStorageProvider
SHA-256 document hash
Confirmed version immutability trigger
Upload size/type/zero-byte validation
Retention foundation
Inbox idempotency
Outbox transactionality
Worker FOR UPDATE SKIP LOCKED
Retry/backoff
Worker tenant/security separation
DB backup/restore
Production DB/API/Web/worker health
```

Puuduvad või osalised:

```text
Settings desktop navigation
Mobile drawer/responsive UX completion
Session device parsing
Document hostile security matrix
Audit hash-chain tamper detection test
Object-storage backup scheduler
Object-storage restore + SHA-256 verification
Production document smoke test
Production audit smoke test
UI responsive/E2E coverage
FileScannerProvider production-safe posture
```

Ära korda kogu v0.4 tööd algusest.

---

# 2. Preflight

Enne muutmist:

```text
git status
git diff
git remote -v
git log --oneline -15
```

Loe:

- `IMPLEMENTATION_STATUS.md`
- `CHANGELOG.md`
- `docs/AUDIT_MODEL.md`
- `docs/DOCUMENT_STORAGE.md`
- `docs/RETENTION_MODEL.md`
- `docs/INBOX_OUTBOX.md`
- `docs/UI_DESIGN.md`
- kõik v0.4 ADR-id
- praegused document/audit/storage/worker testid
- backup scriptid ja systemd unitid
- frontend AppShell/settings/session komponendid
- compose/deploy failid

Kontrolli production health.

Ära väljasta secrets'e.

---

# 3. Prioriteedijärjekord

Tee järgmises järjekorras:

```text
A. Document hostile tests
B. Object storage backup + restore/hash test
C. Audit tamper test
D. Settings desktop UX
E. Mobile drawer / responsive completion
F. Session device parsing
G. UI responsive/E2E tests
H. Production document/audit smoke
I. Full regression
J. Gate decision
```

Turvalisus ja backup enne kosmeetikat.

---

# 4. Document hostile security matrix

Lisa päris hostile/integration testid.

Vähemalt:

## Cross-tenant metadata read

```text
Tenant A document
User B / Tenant B
GET metadata
→ 404/403
→ no metadata leak
```

## Cross-tenant version read

```text
Tenant B attempts Tenant A version lookup
→ DENY
```

## Cross-tenant download

```text
Tenant B knows Tenant A document UUID
→ download
→ DENY
```

## Cross-tenant upload spoof

Kui API request võimaldab document/tenant identifiers:

```text
Tenant A request
attempt tenant_id = Tenant B
→ DENY / ignored server-side
```

Client-supplied tenant_id ei tohi olla autoriteet.

## Storage key guessing

Kui attacker arvab storage key:

```text
direct storage access
→ impossible
```

Object storage ei tohi olla public static path.

## Path traversal

Testi failinimed vähemalt:

```text
../../etc/passwd
..\..\secret
%2e%2e%2f
foo/../../bar.pdf
```

Originaalfailinimi ei tohi määrata filesystem storage path'i.

## Invalid MIME / extension mismatch

Testi:

```text
.exe renamed .pdf
text/plain with .pdf
invalid image bytes with image/jpeg
```

Ära usalda ainult browser MIME headerit.

Vähemalt magic-byte/signature validation PDF/JPEG/PNG jaoks.

## Oversized

```text
> 10 MB
→ reject
```

## Zero-byte

```text
0 bytes
→ reject
```

## Confirmed overwrite

```text
confirmed version
attempt UPDATE file/hash/storage key
→ DB deny/trigger
```

## Version spoof

Tenant A ei saa lisada document_version’it Tenant B document_id alla.

Kõik peavad olema CI testides.

---

# 5. Upload content validation

Praeguse MIME allowlisti kõrval lisa vähemalt lightweight content signature validation:

```text
PDF: %PDF-
JPEG: FF D8 FF
PNG: 89 50 4E 47 0D 0A 1A 0A
```

Kui fail ei vasta deklareeritud tüübile:

```text
DOC-xxx INVALID_FILE_TYPE
```

Ära tee OCR-i ega keerulist parserit.

---

# 6. FileScannerProvider

Praegu Noop scanner on open risk.

Tee arhitektuur selgeks:

```text
FileScannerProvider
NoopFileScannerProvider
```

Production käitumine peab olema teadlik.

Kui päris malware scannerit (nt ClamAV) ei ole mõistlik selle etapi jooksul lisada ilma serveri teiste teenuste riskita:

- ära installi serverisse agressiivselt uusi daemon'e;
- dokumenteeri Noop kui limitation;
- UI/API ei tohi nimetada faili "safe" või "scanned clean";
- lisa status näiteks `NOT_SCANNED`, mitte `CLEAN`.

See EI BLOKEERI v0.4 PASS-i, kui upload security + isolation + backup on tugev ja risk on ausalt dokumenteeritud.

---

# 7. Object-storage backup – kohustuslik

See on gate blocker.

Kui production kasutab:

```text
LocalObjectStorageProvider
Docker volume: tilivo-document-storage
```

siis lisa päris automaatne object backup.

Nõuded:

- projektispetsiifiline;
- eraldi backup path;
- permissions minimaalsed;
- ei backup’i `/tmp`;
- ei logi secrets;
- retention dokumenteeritud;
- backup error → non-zero;
- systemd service + timer või olemasolevasse Tilivo backup orchestration'i ohutult integreeritud.

DB ja document backup peavad olema ajaliselt/correlation mõttes jälitatavad.

---

# 8. Object restore + integrity test

Tee päris test:

```text
1. loo test tenant/document
2. upload test PDF/PNG/JPG
3. confirm document/version
4. salvesta DB metadata + expected SHA-256
5. käivita object backup
6. taasta object isoleeritud restore path'i
7. verify restored file exists
8. calculate SHA-256
9. compare DB/document hash
10. PASS only if exact match
11. cleanup test data/restore path
```

Ära testi production storage üle kirjutades.

Raport:

```text
OBJECT BACKUP: PASS/FAIL
OBJECT RESTORE: PASS/FAIL
SHA-256 VERIFY: PASS/FAIL
```

---

# 9. Backup coordination

Dokumenteeri:

```text
DB backup
Object storage backup
```

ja kuidas neid taastamisel kokku viiakse.

Kui transactional point-in-time consistency DB ja filesystem vahel pole v0.4-s täielikult võimalik:

- dokumenteeri piir;
- kasuta vähemalt ordered backup strategy;
- document SHA-256 võimaldab missing/mismatch avastada.

Ära väida atomic snapshot'i, kui seda pole.

---

# 10. Audit hash-chain tamper test

Hash-chain foundation on olemas.

Lisa test, mis tõestab:

```text
valid chain → verify PASS
tamper event payload → verify FAIL
tamper previous_hash → verify FAIL
delete middle event simulation in isolated test DB → verify FAIL
```

Ära muuda production audit data't testimiseks.

Kui audit chain on tenant-specific või global:
testi vastavalt tegelikule disainile.

Lisa verify helper/service ainult siis, kui see on arhitektuuriliselt puhas.

---

# 11. Audit UI smoke

Settings/Audit lehel testi:

```text
Owner/Admin with audit.read → sees oma tenant auditit
Viewer without permission → deny / UI hidden
Tenant A → Tenant B audit IDs → DENY
Trace ID visible
No secrets/tokens/passwords shown
```

Production smoke võib kasutada test tenant'i.

---

# 12. Settings desktop navigation

Praegune settings layout on ainult osaliselt valmis.

Tee desktopis päris settings navigation:

```text
Settings
├─ Profile
├─ Security
├─ Sessions & devices
├─ Two-factor authentication
├─ Password
├─ Company
├─ Members
├─ Roles
└─ Audit log
```

Desktop:

```text
left settings nav
+
wide content area
```

Ära topi kõike ühte pikka vertikaalsesse kaarti.

Säilita route/deep-link võimalus mõistlikult.

---

# 13. Session device parsing

Raw User-Agent ei ole hea default UX.

Lisa server-side või frontend helper, mis muudab vähemalt:

```text
Edge + Windows 11
Chrome + Windows
Safari + iPhone
Firefox + Linux
curl / API client
Unknown device
```

Näide:

```text
Microsoft Edge · Windows
Current device
Last active 2 min ago
```

Raw UA võib olla details/debug metadata, mitte põhivaade.

Ära kasuta parserit authorization/security otsuseks.

Lisa unit testid tuntud UA-dele.

---

# 14. Mobile drawer

Desktop sidebar peab <900px puhul muutuma accessible drawer'iks.

Nõuded:

- hamburger;
- open/close;
- Escape sulgeb;
- focus management;
- overlay;
- click outside sulgeb;
- route valik sulgeb;
- aria-expanded / label;
- background scroll kontroll.

Desktop >=900px:
persistent sidebar.

Mobiil:
drawer.

---

# 15. Responsive layouts

Kontrolli vähemalt:

```text
1920x1080
1440x900
1280x720
1024x768
768x1024
390x844
```

Desktop:
- workspace kasutab ekraani;
- settings 2-column;
- tables wide;
- sidebar persistent.

Mobile:
- no horizontal page overflow;
- cards/forms fit;
- tables responsive/scrollable;
- drawer works;
- buttons touch-friendly.

---

# 16. UI E2E / responsive tests

Lisa võimalusel Playwright.

Kui Playwright pole veel projektis:

- lisa ainult siis, kui see ei too põhjendamatut raskust;
- kasuta vähemalt Chromiumit CI jaoks.

Testid vähemalt:

```text
login
authenticated shell desktop
sidebar visible desktop
mobile hamburger visible
drawer opens/closes
settings navigation
tenant switch does not show stale data
documents page
sessions device friendly label
```

Responsive assertions viewportidega:

```text
1440x900
390x844
```

Kui screenshot testing on stabiilne:
võib lisada smoke screenshots.

Ära tee brittle pixel-perfect test suite'i.

---

# 17. Tenant cache leakage UI test

v0.3 invariant säilib.

E2E:

```text
Tenant A selected
A document/company data visible
switch Tenant B
A content disappears before/while B loads
B content only
```

0 stale cross-tenant UI leakage.

---

# 18. Production document smoke

Pärast backup + hostile testide PASS-i tee productionis kontrollitud test.

Kasuta eraldi test tenant'i või selgelt tähistatud testdocument'i.

Flow:

```text
login
active tenant
upload small generated test PDF
metadata PASS
SHA-256 stored
confirm
download
downloaded bytes == uploaded bytes
audit event exists
cleanup/archive according to implemented lifecycle
```

Ära kasuta päris kliendi dokumenti.

---

# 19. Production cross-tenant document smoke

Kui ohutult võimalik kahe test tenant'iga:

```text
Tenant A uploads doc
Tenant B authenticated
attempt metadata/download
→ DENY
```

Kui productionisse testdata jätmine pole soovitav:
cleanup pärast.

---

# 20. Public security

Tilivo on avalik:

```text
https://tilivo.mrjaak.com
```

Kontrolli pärast UI/deploy muudatusi:

- no directory listing;
- document volume not directly accessible;
- no debug routes;
- no dev email outbox route;
- no stack traces;
- auth cookies Secure/HttpOnly as designed;
- CSP säilib;
- no `unsafe-eval`;
- source maps policy teadlik.

---

# 21. Full regression

Käivita vähemalt:

```text
npm run test:ci
```

Serveris:

```text
docker compose --profile test run --rm --build tilivo-test
```

Uued testid peavad katma:

```text
document hostile matrix
audit tamper
backup restore/hash
UA parsing
mobile drawer/component behavior
responsive/E2E
```

0 failing tests.

---

# 22. Dependency audit

Käivita:

```text
npm audit
```

API + web.

0 CRITICAL/HIGH.

Ära kasuta `npm audit fix --force`.

---

# 23. Production deploy

Deploy ainult pärast gate-blocker testide PASS-i.

Enne:

```text
DB backup PASS
Object backup PASS
Restore/hash verification PASS
```

Seejärel:

- deploy ainult Tilivo;
- migration ainult kui vajalik;
- restart ainult Tilivo service/containerid;
- healthcheck;
- worker;
- public HTTPS smoke;
- document smoke;
- audit smoke;
- desktop/mobile smoke;
- verify old services.

---

# 24. Existing services

Kontrolli pärast deploy'd vähemalt:

```text
nginx
Docker
MariaDB
host PostgreSQL
postfix
cloudflared
fail2ban
wordgame
multipower
baltik
mrjaak
server.md muud teenused
```

Kui võõras teenus muutub unhealthy:

```text
STOP
rollback only Tilivo changes
```

---

# 25. Documentation

Uuenda:

```text
IMPLEMENTATION_STATUS.md
CHANGELOG.md
DEPLOYMENT.md
docs/DOCUMENT_STORAGE.md
docs/AUDIT_MODEL.md
docs/UI_DESIGN.md
docs/BACKUP_STRATEGY.md
```

Lisa vajadusel:

```text
docs/V0_4_GATE_REPORT.md
```

Dokumenteeri:

- object backup schedule;
- restore procedure;
- hash verification;
- scanner limitation;
- desktop/mobile breakpoints;
- audit chain verification.

---

# 26. Git

Loogilised commitid, näiteks:

```text
test: add hostile document security coverage
feat: add document object backup and restore verification
test: verify audit hash chain tamper detection
feat: complete desktop settings and responsive navigation
feat: improve session device labels
test: add responsive application shell e2e coverage
docs: close v0.4 platform gate
```

Push:

```text
https://github.com/jeerum/Tilivo
main
```

No force push.
No secrets.
Working tree clean lõpuks.

---

# 27. Gate requirements

V0.4 PASS ainult siis, kui vähemalt:

```text
document cross-tenant metadata     PASS
document cross-tenant download     PASS
path traversal                     PASS
file signature validation          PASS
confirmed overwrite denied         PASS
object backup scheduler            PASS
object restore                     PASS
object SHA-256 verification        PASS
audit tamper detection             PASS
settings desktop navigation        PASS
mobile drawer                      PASS
session device parsing             PASS
responsive/E2E coverage            PASS
production document smoke          PASS
production audit smoke             PASS
v0.2 auth regression               PASS
v0.3 RLS regression                PASS
existing services                  PASS
CRITICAL/HIGH findings open        0
```

NoopFileScannerProvider võib jääda dokumenteeritud MEDIUM/INFO riskiks, kui süsteem ei valeta scan-status'e kohta.

SMTP `noop` ei ole selle gate blocker.

---

# 28. Lõpparuanne

Anna lõpus täpne raport.

## 1. Document security

```text
Cross-tenant metadata:
Cross-tenant version:
Cross-tenant download:
Tenant spoof:
Storage key guessing:
Path traversal:
MIME/signature validation:
Oversized:
Zero-byte:
Confirmed overwrite:
Version spoof:
```

PASS/FAIL.

## 2. Object backup

```text
Scheduler:
Backup path:
Permissions:
Retention:
Backup run:
Restore:
SHA-256 verify:
```

PASS/FAIL.

Ära näita secret/path detaile, mis pole vajalikud.

## 3. Audit

```text
Append-only:
Hash chain verify:
Payload tamper:
Previous-hash tamper:
Missing event detection:
Tenant isolation:
Audit UI smoke:
```

## 4. Desktop UI

```text
Desktop shell:
Settings nav:
Session device labels:
1440x900:
1280x720:
1024x768:
```

## 5. Mobile

```text
Drawer:
Keyboard:
Focus:
390x844:
768x1024:
No horizontal page overflow:
```

## 6. E2E

Täpsed testid ja tulemused.

## 7. Full tests

Täpsed käsud ja pass counts.

## 8. Production

```text
DB:
API:
Web:
Worker:
HTTPS:
Document upload:
Document download:
Cross-tenant deny:
Audit:
Desktop:
Mobile:
```

## 9. Existing services

PASS/FAIL.

## 10. GitHub

```text
repo:
branch:
latest commit:
push:
working tree:
```

## 11. Remaining risks

Kõik MEDIUM/LOW/INFO.

## 12. Final gate

Kirjuta üks:

```text
V0.4 PLATFORM + DESKTOP UI GATE: PASS
```

või:

```text
V0.4 PLATFORM + DESKTOP UI GATE: FAIL
```

Kui PASS:

```text
STOP – v0.5 ei alusta.
```

Kui FAIL:
näita täpselt gate blockerid.

---

# 29. Alusta nüüd

```text
Preflight
→ hostile document tests
→ content signature validation
→ object backup
→ restore/hash verification
→ audit tamper test
→ settings desktop navigation
→ mobile drawer
→ session device parsing
→ responsive/E2E tests
→ full regression
→ security mini-review
→ production backup
→ deploy
→ production document/audit smoke
→ verify old services
→ docs
→ Git push
→ final v0.4 gate
→ STOP
```

Kõige tähtsam:

> **Ära alusta v0.5-t enne, kui v0.4 dokumentide turvapiir ja document-storage backup/restore on päriselt tõestatud.**

> **Desktop peab jääma Tilivo peamiseks UX-iks, mobiil peab olema korralikult responsive kõrvalvaade.**
