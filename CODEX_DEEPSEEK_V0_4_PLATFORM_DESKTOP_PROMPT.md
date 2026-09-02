# Codex / DeepSeek tööülesanne – Tilivo v0.4 Platform Foundation + Desktop-First Application Shell

## Eesmärk

Tilivo v0.1 Infrastructure, v0.2 Identity ja v0.3 Multi-Tenant + PostgreSQL RLS on valmis, testitud ja production’is.

Viimane gate:

```text
V0.3 MULTI-TENANT SECURITY GATE: PASS
```

Nüüd ehita **Tilivo v0.4**.

v0.4 eesmärk on kaks asja korraga:

1. ehitada valmis päris **desktop-first application shell**, mille sisse hilisemad raamatupidamise moodulid tulevad;
2. lõpetada roadmap’i v0.4 platform-foundation:
   - audit trail hardening;
   - document storage foundation;
   - retention foundation;
   - inbox/outbox foundation;
   - Trace ID / Error ID ühtlustamine.

Ära alusta veel v0.5 Accounting Core’i.

Ära implementeeri veel:
- chart of accounts;
- journal entries;
- VAT engine;
- invoices;
- purchases;
- banking;
- payroll;
- AI.

---

# 1. UX suund – DESKTOP FIRST

Tilivo on eelkõige **arvutis kasutatav töövahend**.

Praegune UI meenutab liiga kitsast mobiilivaadet.

v0.4 peab muutma põhilise rakenduse desktop-first lahenduseks.

Prioriteet:

```text
Desktop / laptop
→ tablet
→ mobile
```

Mobiilivaade peab töötama ja olema responsive, kuid desktop ei tohi enam olla venitatud telefonivaade.

Põhivaade disaini vähemalt:

```text
>= 1280 px desktop primary
1024–1279 tablet/small desktop
< 768 mobile responsive
```

Ära tee fikseeritud telefone meenutavat keskset 400px laiust tulpa desktopis.

---

# 2. Desktop application shell

Ehita põhiline layout:

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Tilivo      Company / Tenant ▼          Search     ET   User ▼      │
├───────────────┬──────────────────────────────────────────────────────┤
│ Dashboard     │                                                      │
│ Sales         │                                                      │
│ Purchases     │                  PAGE CONTENT                        │
│ Banking       │                                                      │
│ Documents     │                                                      │
│ Reports       │                                                      │
│               │                                                      │
│ Settings      │                                                      │
└───────────────┴──────────────────────────────────────────────────────┘
```

Praegu veel mittevalmis moodulid võivad olla:

```text
disabled
coming soon
või placeholder route
```

Ära implementeeri nende äriloogikat.

---

# 3. Navigation

Desktop:

- vasakul persistent sidebar;
- üleval topbar;
- company/tenant switcher;
- kasutaja menüü;
- keelevalik;
- vajadusel breadcrumb.

Mobile:

- sidebar → drawer/hamburger;
- topbar kompaktsem;
- sisu ühe tulbana;
- nupud puutetundlikud.

Ära tee desktopi mobile breakpoint’i järgi.

---

# 4. Tenant / company switcher

v0.3 tenant switching peab jääma korrektseks.

Switcher peab:

- näitama active company/tenant;
- võimaldama kiiresti tenant’i vahetada;
- reset'ima tenant-scoped frontend state/cache;
- mitte näitama eelmist tenant’i data't hetkekski pärast switchi;
- säilitama RLS/security mudeli.

Desktop topbar on selle peamine koht.

---

# 5. Account / Security Settings desktop layout

Praegune konto leht tuleb ümber teha desktop-vaateks.

Näiteks:

```text
Settings
├─ Profile
├─ Security
├─ Sessions & devices
├─ Two-factor authentication
├─ Password
├─ Company
├─ Members
└─ Roles
```

Desktopis:

```text
left settings navigation
+
wide content panel
```

Mobiilis:
üks tulp / collapsible navigation.

---

# 6. Session device UX

Ära kuva kasutajale vaikimisi kogu raw User-Agent stringi.

Parse vähemalt:

```text
Browser
OS
device type
```

Näiteks:

```text
Microsoft Edge · Windows 11
Current device

Safari · iPhone
Last active ...
```

Raw user-agent võib jääda:
- detailidesse;
- audit/log metadata’sse;
- debug/internal kasutusse.

Ära kasuta UA parse tulemust security-authority'na.

---

# 7. UI design language

Tilivo visuaal:

- hele;
- valge / väga hele hall;
- professionaalne;
- õhuline;
- minimaalne;
- punane ainult warning/error/attention jaoks;
- mitte “AI purple dark dashboard”;
- mõistlik borders/shadows;
- tabelid desktopis laiad ja selged.

Lisa reusable komponendid vähemalt:

```text
AppShell
Sidebar
Topbar
PageHeader
Card
DataTable foundation
EmptyState
Badge
Alert
Modal/Dialog
Dropdown
Tabs
FormField
Button variants
Skeleton/loading
ErrorState
```

Ära lisa rasket UI framework'i ilma vajaduseta.

Kui olemasolev stack sobib, jätka olemasoleva CSS/component mudeliga.

---

# 8. Accessibility

Vähemalt:

- keyboard navigation;
- visible focus;
- semantic HTML;
- form labels;
- aria vajadusel;
- kontrast;
- color ei ole ainus status signal;
- modal focus management;
- sidebar mobile drawer accessibility.

Hoia eesmärgiks mõistlik WCAG 2.1 AA tase.

---

# 9. i18n

ET/EN peab säilima.

Kõik uued UI stringid tõlkefailides.

Struktuur peab lubama hiljem FI lisamist ilma komponentide ümberkirjutamiseta.

Ära pane ingliskeelseid placeholder’e juhuslikult otse komponentidesse.

---

# 10. Audit trail hardening

v0.4 roadmap nõuab audit foundation'i tugevdamist.

Praegune `audit_events` on olemas.

Tee selge immutable/append-only mudel.

Nõuded:

- application runtime role ei tohi audit event'i UPDATE/DELETE teha;
- audit event lisatakse append-only;
- tenant linkage korrektne;
- actor user;
- action;
- object type;
- object id;
- timestamp;
- trace_id;
- metadata;
- request context;
- old/new values ainult siis, kui see on ohutu ja vajalik;
- secrets/tokens/password/TOTP/recovery data auditisse ei lähe.

Tavaline app/admin ei tohi audit history't muuta.

---

# 11. Audit DB privileges

Kontrolli PostgreSQL õigusi.

Runtime role:

```text
INSERT audit_events
SELECT audit_events vastavalt tulevasele vajadusele
NO UPDATE
NO DELETE
```

Kui RLS audit_events peal on vajalik, implementeeri korrektne tenant isolation.

Security event'id, kus tenant puudub (näiteks pre-tenant auth), peavad säilima ilma turvaauku tekitamata.

Dokumenteeri mudel ADR-is.

Näiteks:

```text
ADR-0010-audit-immutability-model.md
```

---

# 12. Audit hash chain – foundation

Kui see on mõistlik ilma liigse keerukuseta, lisa hash-chain foundation:

```text
previous_hash
event_hash
```

kus event_hash arvutatakse canonical audit payload'ist.

Eesmärk:
hiljem oleks võimalik tuvastada muutmist/kustutamist.

Kui production-grade chain’i korrektne implementeerimine vajab eraldi suuremat tööd:
tee vähemalt arhitektuur ja testitud foundation.

Ära loo pseudo-security lahendust.

Kui hash chain implementeeritakse:
testi tamper detection.

---

# 13. Audit API / UI

Lisa vähemalt turvaline tenant-scoped audit view:

```text
Settings / Audit log
```

või admin/settings sektsiooni.

Näita näiteks:

```text
Time
Actor
Action
Object
Result
Trace ID
```

Filtrid foundation:

```text
date
actor
action
object type
```

Ära kuva secrets'e.

Viewer/Employee ei pea automaatselt auditit nägema.

Lisa permission näiteks:

```text
audit.read
```

Owner/Admin saavad vastavalt role mapping'ule.

---

# 14. Documents foundation

v0.4 peab looma document storage domain foundation'i.

Ära ehita veel purchase invoice OCR workflow'd.

Loo vähemalt:

```text
documents
document_versions
```

Võimalikud väljad:

```text
documents:
id
tenant_id
type
status
created_by
created_at
updated_at

document_versions:
id
tenant_id
document_id
version_number
storage_key
original_filename
mime_type
size_bytes
sha256
uploaded_by
created_at
confirmed_at
```

Confirmed version peab olema immutable.

Uus fail:
uus version, mitte vana confirmed faili overwrite.

---

# 15. Object storage adapter

Ära seo business logic'ut otse local filesystemiga.

Tee adapter:

```text
ObjectStorageProvider
```

Võimalikud implementatsioonid:

```text
LocalObjectStorageProvider
S3CompatibleObjectStorageProvider
```

Kui productionis kasutatakse v0.4 ajal local storage'i:
- path peab olema projektispetsiifiline;
- Docker volume;
- backup strateegia;
- path traversal kaitse;
- random/internal storage key.

Ära kasuta kasutaja originaalfailinime storage path'ina.

---

# 16. File upload security

Vähemalt:

- max file size;
- allowlist MIME/types;
- filename sanitization display jaoks;
- storage key server generated;
- path traversal test;
- zero-byte handling;
- oversized file reject;
- hash SHA-256;
- tenant ownership;
- auth;
- CSRF;
- permissions.

Allowed foundation tüübid näiteks:

```text
PDF
JPG/JPEG
PNG
```

Kui Office/Excel pole veel vajalik:
ära lisa.

---

# 17. Malware scanning adapter

Loo foundation:

```text
FileScannerProvider
```

Production võib esialgu kasutada:

```text
NoopFileScannerProvider
```

ainult siis, kui see on selgelt dokumenteeritud kui open risk.

Ära väida, et fail on malware-safe, kui scanner puudub.

Hiljem saab lisada ClamAV või muu provider'i.

---

# 18. Document lifecycle

Näiteks:

```text
UPLOADED
CONFIRMED
REPLACED
ARCHIVED
```

Ära luba confirmed document version'i mutateerida.

Delete v0.4-s:

- draft/unconfirmed võib olla soft-delete;
- confirmed/legal source doc ei kustutata hard-delete'iga tavakasutaja kaudu.

Täielik legal retention policy tuleb rules engine'i abil hiljem, kuid foundation peab seda toetama.

---

# 19. Retention foundation

Loo domain/foundation:

```text
retention_policies
retention_holds
```

või põhjendatud lihtsam mudel.

Retention policy peab olema tulevikus määratav:

```text
object_type
country
retention_period
effective_from
effective_to
rule_version
```

Ära hardcode'i kõiki Soome retention aastaid v0.4 äriloogikasse.

Roadmap'i country rules tuleb hiljem.

Eesmärk:
arhitektuur toetab legal archive/retention'i.

---

# 20. Deletion model

Dokumenteeri selgelt erinevus:

```text
soft delete
archive
legal retention
anonymisation
hard delete
```

Tenant/user/account delete ei tohi tulevikus automaatselt legal financial data't kustutada.

v0.4-s tee foundation, mitte kogu GDPR workflow.

Lisa dokument:

```text
docs/RETENTION_MODEL.md
```

---

# 21. Inbox foundation

Loo transactional inbox external eventide jaoks.

Näiteks:

```text
integration_inbox
```

Väljad:

```text
id
tenant_id nullable if pre-routing event
provider
event_type
external_event_id
payload/reference
received_at
processed_at
status
attempt_count
last_error_code
```

Unique/idempotency näiteks:

```text
(provider, external_event_id)
```

vajadusel tenant contextiga.

Ära pane secrets payload'i pimesi DB-sse.

---

# 22. Outbox foundation

Loo transactional outbox:

```text
integration_outbox
```

Väljad näiteks:

```text
id
tenant_id
event_type
aggregate_type
aggregate_id
payload
status
attempt_count
available_at
created_at
processed_at
last_error_code
```

Business transaction:

```text
DB change
+
outbox event
```

samas transaction'is.

Worker saadab hiljem provider'ile.

---

# 23. Worker foundation

Kui v0.1 worker skeleton oli olemas:
kasuta seda.

Muidu lisa minimaalne worker:

```text
claim pending outbox rows
→ process
→ mark processed
→ retry
```

Nõuded:

- idempotency;
- bounded retry/backoff;
- concurrency-safe claim;
- crash-safe;
- structured logs;
- trace/correlation metadata.

Ära integreeri veel päris panka/e-arvet.

Test provider võib demonstreerida flow'd.

---

# 24. Inbox/outbox security

Tenant-owned event ei tohi lekkida teisele tenant'ile.

Kui worker vajab cross-tenant system processingut:
ära anna tavalisel API runtime role'il BYPASSRLS õigust.

Kasuta eraldi väga piiratud worker/system role'i või turvalist service function mudelit.

Dokumenteeri.

See peab olema teadlik arhitektuuriotsus.

---

# 25. Trace ID / Correlation ID

Praegune Trace ID säilib.

v0.4-s ühtlusta:

```text
HTTP request trace_id
audit trace_id
inbox correlation
outbox correlation
worker logs
```

Üks business flow peab olema support'i jaoks jälitatav.

Näiteks:

```text
request
→ document create
→ audit event
→ outbox event
```

kõigil sama trace/correlation seos.

---

# 26. Error ID registry

Koonda Error ID-d dokumenteeritud registry’sse.

Näiteks:

```text
AUTH-xxx
TENANT-xxx
MEMBER-xxx
ROLE-xxx
DOC-xxx
AUDIT-xxx
INBOX-xxx
OUTBOX-xxx
```

Lisa dokument:

```text
docs/ERROR_IDS.md
```

Ära muuda olemasolevaid ID-sid ilma põhjuseta.

---

# 27. Documents permissions

Lisa vähemalt:

```text
document.read
document.upload
document.manage
audit.read
```

Built-in roles mapping mõistlikult.

Näiteks:
Owner/Admin täielik;
Accountant document access;
Viewer read vastavalt mudelile.

Ära hakka v0.4-s ehitama liiga keerukat ACL süsteemi.

Tenant + permission + RLS on autoriteet.

---

# 28. Document RLS

Kõik tenant-owned document tabelid:

```text
RLS ENABLED
FORCE RLS
```

Runtime role:
no BYPASSRLS.

Testi:

```text
Tenant A document
Tenant B user
→ cannot read metadata
→ cannot read version
→ cannot download
```

Ka storage download path peab kontrollima tenant ownership'i enne faili tagastamist.

---

# 29. Object download

Ära tee:

```text
GET /uploads/<filename>
```

avalikku staatilist kausta.

Download peab olema auth + tenant permission kontrolliga endpoint või signed internal URL mudel.

Esialgu:

```text
GET /api/v1/documents/:id/download
```

võib stream'ida providerist pärast authorization'i.

---

# 30. UI – Documents

Desktop-first Documents leht:

```text
Documents
[Upload document]

------------------------------------------------
Name | Type | Status | Uploaded | Size | Actions
------------------------------------------------
```

Lai desktop table.

Mobile:
card/compact responsive representation.

Upload flow võib olla minimaalne:

```text
select file
upload
show status/hash metadata
confirm
```

Ära implementeeri OCR-i.

---

# 31. UI – Dashboard foundation

Loo päris desktop dashboard shell, kuid ära tee fake accounting numbers.

Näita ainult olemasolevat päris infot, näiteks:

```text
Company
Members
Documents
Security/account status
Recent audit activity
```

Kui finantsandmeid veel pole:
kasuta empty states:

```text
Sales module will become available in a later version
```

Ära genereeri väljamõeldud revenue/graafikuid.

---

# 32. UI – table foundation

Kuna hilisem Tilivo on tabelirohke, tee reusable desktop DataTable foundation:

- column headers;
- sorting foundation;
- filters foundation;
- empty state;
- loading;
- pagination foundation;
- row actions;
- keyboard usability;
- responsive behavior.

Ära ehita üleliigset generic framework'i.

---

# 33. Responsive test

Kontrolli vähemalt viewportid:

```text
1920x1080
1440x900
1280x720
1024x768
768x1024
390x844
```

Desktopi vaatel ei tohi sisu olla kunstlikult 400–500px lai.

Lisa võimalusel Playwright/E2E screenshot/layout test või DOM assertion.

---

# 34. Existing auth UI regression

Pärast AppShell'i refactorit peavad töötama:

```text
login
register
verify
forgot/reset
2FA challenge
sessions
password change
logout
```

Public auth pages võivad olla keskse card layoutiga.

Authenticated app EI TOHI olla kitsas auth-card layout.

---

# 35. Public production reality

Tilivo on praegu avalikult nähtav:

```text
https://tilivo.mrjaak.com
```

Seega käsitle productionit internet-facing rakendusena.

Ära jäta productionis:

- dev email read endpointi;
- debug endpoints;
- stack trace;
- directory listing;
- public upload directory;
- source maps, kui need lekivad tundlikku infot ja pole teadlikult lubatud;
- test credentials.

Registration olemasolu ära muuda ilma kasutaja eraldi otsuseta.

SMTP on endiselt noop – dokumenteeri.

---

# 36. Security headers / CSP

UI refactor ei tohi nõrgendada:

```text
CSP
X-Content-Type-Options
frame protection
Referrer-Policy
Cache-Control auth data jaoks
CSRF
Secure cookies
```

Kui lisad inline styles/scripts, ära lahenda CSP-d `unsafe-eval` või põhjendamatu `unsafe-inline` abil.

---

# 37. Audit hostile tests

Testi:

```text
runtime role UPDATE audit_events → DENY
runtime role DELETE audit_events → DENY
Tenant A read Tenant B audit → DENY
audit payload secret marker → not stored
```

Kui hash-chain:
tamper detection test.

---

# 38. Document hostile tests

Testi vähemalt:

```text
cross-tenant document read
cross-tenant document version read
cross-tenant download
path traversal filename
oversized upload
wrong MIME/type
zero-byte
confirmed version overwrite
tenant_id spoof
direct storage-key guessing
```

Kõik peavad failima turvaliselt.

---

# 39. Inbox/outbox tests

Vähemalt:

```text
duplicate inbox external_event_id
→ one logical event

business transaction rollback
→ no orphan outbox event

business transaction commit
→ outbox exists

worker retries
→ no duplicate logical side effect

two workers claim same event
→ only one processes
```

---

# 40. DB migration safety

Enne production deploy'd:

```text
fresh DB migrate
v0.3 snapshot upgrade
down/up test test-DB-s kui ohutu
RLS tests
runtime grants tests
```

Productionis ei tee destructive down migrationit.

---

# 41. Backup

Enne v0.4 production migrationit:

```text
backup
→ isolated restore
→ verify identity + tenant schema/data
```

Kui lisad object-storage local volume:
lisa ka selle backup strateegia.

DB backup üksi ei ole enam piisav, kui production dokumente hakatakse salvestama.

---

# 42. Document backup strategy

Kui kasutatakse local object storage'i:

dokumenteeri ja võimalusel implementeeri:

```text
DB backup
+
document object backup
+
restore test
```

Restore integrity:

```text
document metadata
storage object exists
sha256 matches
```

Kui object backup scheduler jääb v0.4 jooksul TODO:
ära luba production real document upload'i enne selle lahendamist.

Eelistus:
tee see kohe korralikult.

---

# 43. Production storage data path

Kasuta Tilivo-spetsiifilist volume'i/path'i.

Ära salvesta upload'e:

```text
/tmp
web public directory
repo working tree
```

Permissions minimaalsed.

---

# 44. Monitoring

Lisa vähemalt mõõdetavad/logitavad sündmused:

```text
document upload failures
storage failures
inbox failures
outbox retry failures
worker failures
audit write failures
```

Health endpoint võib saada internal component checks, kuid public response jääb minimal.

---

# 45. Performance

Ära tee audit/document list endpointi N+1 päringutega.

Pagination foundation:

```text
limit
cursor või offset
```

Vali üks ja dokumenteeri.

Ära tagasta tuhandeid audit event'e korraga.

---

# 46. CI

CI peab jooksutama vähemalt:

```text
lint
typecheck
unit
auth regression
multi-tenant/RLS tests
audit security tests
document security tests
inbox/outbox tests
frontend tests
production build
dependency audit
```

---

# 47. Documentation

Loo/uuenda vähemalt:

```text
README.md
ARCHITECTURE.md
DEPLOYMENT.md
IMPLEMENTATION_STATUS.md
CHANGELOG.md

docs/AUDIT_MODEL.md
docs/DOCUMENT_STORAGE.md
docs/RETENTION_MODEL.md
docs/INBOX_OUTBOX.md
docs/ERROR_IDS.md
docs/UI_DESIGN.md
```

ADR-id vähemalt vajaduse korral:

```text
ADR-0010-audit-immutability-model.md
ADR-0011-object-storage-provider.md
ADR-0012-inbox-outbox-worker-security.md
ADR-0013-desktop-first-ui.md
```

---

# 48. Git

Enne:

```text
git status
git diff
git remote -v
```

Pärast loogilised commitid.

Näiteks:

```text
feat: add desktop-first Tilivo application shell
feat: add immutable audit foundation
feat: add tenant-scoped document storage foundation
feat: add retention model foundation
feat: add transactional inbox and outbox
test: add v0.4 security and isolation coverage
docs: document v0.4 platform architecture
```

Push:

```text
jeerum/Tilivo
main
```

Ära force push'i.

---

# 49. Production deploy gate

Deploy ainult kui:

```text
v0.2 auth regression          PASS
v0.3 RLS regression           PASS
desktop UI tests              PASS
audit security                PASS
documents isolation           PASS
inbox/outbox idempotency      PASS
migration tests               PASS
backup/restore                PASS
secret scan                   PASS
npm audit                     PASS
```

---

# 50. Production smoke

Pärast deploy'd kontrolli:

```text
public HTTPS site
login
2FA/session
tenant switch
desktop shell
company settings
members/roles
audit list
document upload test
document download test
cross-tenant denial
mobile responsive basic check
```

Kasuta testdokumente, mitte päris raamatupidamise dokumente, kui backup/storage retention pole täielikult PASS.

---

# 51. Existing server services

Pärast deploy'd kontrolli server.md järgi kõik varasemad teenused.

Tilivo deploy ei tohi neid mõjutada.

Kui võõras teenus muutub unhealthy:

```text
STOP
rollback Tilivo changes only
```

---

# 52. v0.4 security mini-review

Enne PASS-i kontrolli:

```text
audit tampering
audit cross-tenant leak
document cross-tenant leak
storage path traversal
storage object guessing
upload abuse
outbox duplicate processing
inbox duplicate processing
worker privilege boundary
frontend tenant cache leak
desktop auth regression
public debug/dev exposure
```

CRITICAL/HIGH = 0 open.

---

# 53. Stop conditions

Peata ja küsi enne, kui:

- backup FAIL;
- restore FAIL;
- document storage backup pole usaldusväärne, kuid production real upload läheks aktiivseks;
- RLS leak;
- audit event saab runtime API kaudu muuta/kustutada;
- storage path traversal;
- cross-tenant document download;
- worker vajaks superuser/BYPASSRLS õigust ilma kontrollitud arhitektuurita;
- production migration võib andmeid kaotada;
- vaja oleks muuta serveri teisi teenuseid.

---

# 54. Lõpparuanne

Anna lõpuks:

## 1. UI

```text
Desktop-first shell:
Sidebar:
Topbar:
Tenant switcher:
Settings desktop layout:
Mobile responsive:
Session device parsing:
```

PASS/FAIL.

Lisa kasutatud breakpointid.

## 2. Audit

```text
append-only:
runtime UPDATE denied:
runtime DELETE denied:
tenant isolation:
trace linkage:
hash chain:
```

PASS/FAIL/TODO.

## 3. Documents

```text
documents:
document_versions:
object storage provider:
SHA-256:
confirmed immutable:
RLS:
cross-tenant download denied:
upload validation:
scanner provider:
```

## 4. Retention

Kirjelda foundation ja mis jääb tulevikku.

## 5. Inbox/outbox

```text
inbox idempotency:
outbox transactionality:
worker claim safety:
retry:
tenant isolation:
```

## 6. Testid

Täpsed käsud ja tulemused.

## 7. Backup/restore

```text
DB backup:
DB restore:
object backup:
object restore/hash verification:
```

## 8. Production

```text
migration:
DB:
API:
Web:
HTTPS:
desktop smoke:
mobile smoke:
document smoke:
audit smoke:
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

## 11. Open risks

Kõik MEDIUM/LOW/INFO.

## 12. v0.4 gate

Kirjuta üks:

```text
V0.4 PLATFORM + DESKTOP UI GATE: PASS
```

või

```text
V0.4 PLATFORM + DESKTOP UI GATE: FAIL
```

Kui FAIL:
ära liigu edasi.

Kui PASS:
STOP.

Ära alusta v0.5 Accounting Core'i automaatselt.

---

# 55. Alusta nüüd

```text
Read docs/repo
→ preflight
→ backup/restore
→ desktop-first UX architecture
→ application shell
→ settings responsive refactor
→ audit hardening
→ document storage foundation
→ retention foundation
→ inbox/outbox foundation
→ worker foundation
→ RLS/security tests
→ desktop/mobile UI tests
→ full regression
→ security mini-review
→ fix findings
→ production backup
→ deploy
→ production smoke
→ verify existing services
→ docs
→ Git push
→ V0.4 PLATFORM + DESKTOP UI GATE
→ STOP
```

Kõige tähtsamad nõuded:

> **Tilivo authenticated application peab desktopis tunduma päris töölauarakendusena, mitte keskele paigutatud telefonivaatena.**

> **Mobiil jääb toetatud ja responsive, kuid desktop on peamine UX.**

> **Audit, dokumendid, retention ja inbox/outbox peavad olema multi-tenant/RLS mudeliga turvaliselt kooskõlas enne Accounting Core’i ehitamist.**
