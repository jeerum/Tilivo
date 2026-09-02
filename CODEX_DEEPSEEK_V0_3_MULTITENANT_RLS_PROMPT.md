# Codex / DeepSeek tööülesanne – Tilivo v0.3 Multi-Tenant + PostgreSQL RLS

## Eesmärk

Tilivo v0.1 Infrastructure ja v0.2 Identity on valmis, turvareview läbitud ning:

```text
V0.3 SECURITY GATE: PASS
```

Nüüd ehita **v0.3 Multi-Tenant** koos PostgreSQL Row Level Security'ga.

See on Tilivo üks kõige kriitilisemaid turvapiire.

Peamine invariant:

> **Tenant A kasutaja ei tohi mitte ühegi API, ID manipuleerimise, SQL vea, connection pool'i lekke ega programmeerimisvea kaudu saada Tenant B andmeid.**

Ära alusta v0.4 Audit & Compliance funktsionaalsust peale selle, mis on v0.3 turvaliseks tööks otseselt vajalik.

Ära ava rakendust veel avalikku internetti.

---

# 1. Loe enne muutmist kogu kontekst läbi

Loe täielikult:

- `raamatupidamise_saas_ARCHITECTURE_v2.md`
- `server.md`
- `ARCHITECTURE.md`
- `DEPLOYMENT.md`
- `IMPLEMENTATION_STATUS.md`
- `CHANGELOG.md`
- `docs/IDENTITY_SECURITY.md`
- `docs/SECURITY_REVIEW_V0_2.md`
- `docs/BACKUP_STRATEGY.md`
- kõik `docs/decisions/ADR-*.md`
- kõik olemasolevad migrationid
- auth/session kood
- DB abstraction / pg kasutus
- request lifecycle / Fastify hooks
- testid
- compose/deploy/CI failid

Kontrolli:

```text
git status
git diff
git remote -v
git log --oneline -15
```

Ametlik repo:

```text
https://github.com/jeerum/Tilivo.git
```

Ära väljasta `server.md` ega `.env` saladusi.

---

# 2. Preflight gate

Enne v0.3 implementeerimist kontrolli:

```text
v0.2 regression          PASS
security tests           PASS
production backup        PASS
restore test             PASS
DB/API/Web health        PASS
Git state known          PASS
```

Kui mõni FAIL:
paranda enne v0.3 alustamist.

---

# 3. Serveri ohutus

Serveris töötavad teised teenused peavad jääma puutumata.

ÄRA:

- restardi serverit;
- peata võõraid containereid;
- tee `docker system prune`;
- tee `docker volume prune`;
- muuda host PostgreSQL-i;
- muuda MariaDB-d;
- muuda Postfixi;
- muuda nginx'i avalikku konfiguratsiooni;
- muuda firewalli;
- muuda cloudflared/fail2ban teenuseid;
- kasuta teiste projektide DB-sid või volume'e.

Deploy ainult Tilivo containeritele.

---

# 4. v0.3 scope

v0.3 peab sisaldama vähemalt:

```text
tenants
companies
memberships
roles
permissions
role_permissions
membership_roles (või põhjendatud lihtsam mudel)

tenant context resolution
tenant switch / active tenant
PostgreSQL RLS
RLS-safe DB transaction helper
tenant-aware API authorization
company create/read/update basics
membership management basics
role/permission enforcement
tenant security audit events
multi-tenant security tests
connection pool isolation tests
```

Ära ehita veel:

- Accounting Core
- invoices
- banking
- VAT
- payroll
- SaaS billing
- AI
- v0.4 WORM audit infrastruktuuri

---

# 5. Kontseptuaalne mudel

Erista:

## Tenant

Turvapiir ja andmete omanik.

```text
tenant
```

## Company

Äriline ettevõte / juriidiline üksus.

Esimeses versioonis võib üks tenant omada ühte company't, kuid andmemudel ei tohi põhjendamatult välistada tulevikus mitut company't ühe tenant'i all, kui arhitektuur seda vajab.

Ära sega `tenant_id` ja `company_id` semantikat.

Dokumenteeri valik ADR-is.

Lisa näiteks:

```text
docs/decisions/ADR-0007-tenant-company-model.md
```

---

# 6. DB skeem

Disaini migrationitega vähemalt:

```text
tenants
companies
memberships
roles
permissions
role_permissions
membership_roles
```

Võid kasutada teistsugust normaliseeritud skeemi, kui see on põhjendatud.

## tenants

Vähemalt:

```text
id UUID PK
name
slug
status
created_at
updated_at
```

Status näiteks:

```text
ACTIVE
SUSPENDED
ARCHIVED
```

## companies

Vähemalt:

```text
id UUID PK
tenant_id UUID NOT NULL
legal_name
business_id
country_code
base_currency
status
created_at
updated_at
```

Kõik tenant-owned tabelid peavad sisaldama:

```text
tenant_id NOT NULL
```

ja sobivaid foreign key constraints'e.

## memberships

Vähemalt:

```text
id
tenant_id
user_id
status
created_at
updated_at
```

Unique:

```text
(tenant_id, user_id)
```

Status näiteks:

```text
ACTIVE
INVITED
SUSPENDED
REMOVED
```

Ära kasuta removed membership'i ligipääsu lubamiseks.

---

# 7. Rollid ja permissionid

Algne built-in permission model võiks sisaldada näiteks:

```text
tenant.read
tenant.manage
company.read
company.update

member.read
member.invite
member.manage
member.remove

role.read
role.manage
```

Built-in rollid näiteks:

```text
Owner
Admin
Accountant
Employee
Viewer
```

Ära hardcode'i authorization loogikat kümnetesse route'idesse.

Tee tsentraalne permission service/middleware.

Role on permission'ite kogum.

Kui v0.3-s pole veel accounting permission'e, ära lisa neid kunstlikult liiga palju.

---

# 8. Owner invariant

Tenant'i loomisel peab alati tekkima vähemalt üks Owner.

Tenant creator:

```text
create tenant
→ create company
→ create membership
→ assign Owner role
```

Kõik ühe DB transaktsiooni sees.

Ei tohi tekkida olukorda:

```text
tenant exists
but no owner exists
```

Kui tenant creation failib keskel:
ROLLBACK kõik.

---

# 9. Viimane Owner

Ära luba eemaldada või downgrade'ida viimast aktiivset Owner'it.

Test:

```text
Tenant has 1 Owner
→ remove Owner
→ DENY
```

Kui Owner'e on 2:
ühe võib eemaldada/downgrade'ida vastavalt permissionitele.

Race condition peab olema DB/transaction tasemel maandatud.

---

# 10. Tenant context – oluline

Ära usalda tenant'i ainult:

```text
X-Tenant-ID
```

päise põhjal.

Tenant context peab tulema:

```text
authenticated user
+
requested tenant id
+
active membership validation
```

Client võib öelda, millise tenant'iga ta tahab töötada, kuid server peab iga requesti puhul kontrollima:

```text
user has ACTIVE membership in tenant
```

Kui mitte:

```text
404 või 403
```

Vali ühtne strateegia ja dokumenteeri.

Ära lase client'il saata suvalist tenant ID-d, mis jõuab otse RLS context'i ilma membership check'ita.

---

# 11. Active tenant

Kasutaja võib kuuluda mitmesse tenant'i.

Frontend peab võimaldama tenant'i vahetamist.

Esialgu võib tenant context tulla näiteks:

```text
X-Tilivo-Tenant-Id
```

või route segmentist:

```text
/api/v1/tenants/:tenantId/...
```

Vali üks põhimudel ning dokumenteeri ADR-is.

Ära säilita active tenant'i globaalselt serveriprotsessis.

See peab olema request-scoped.

---

# 12. PostgreSQL RLS – absoluutne nõue

Kõik tenant-owned tabelid peavad olema kaitstud RLS-iga.

Näiteks kontseptuaalselt:

```sql
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
```

Policy kasutab request transaction'i tenant context'i.

Näiteks:

```sql
current_setting('app.tenant_id', true)
```

Ära kopeeri seda pimesi – implementeeri turvaline variant.

---

# 13. FORCE ROW LEVEL SECURITY

Kontrolli väga tähelepanelikult:

- kas app DB role on tabeli owner;
- kas role'il on `BYPASSRLS`;
- kas owner bypassib policy't;
- kas `FORCE ROW LEVEL SECURITY` on vajalik.

Eesmärk:

**Tilivo application DB role EI TOHI RLS-i bypassida.**

Kui migration owner ja runtime app role peavad olema eraldi:
tee see õigesti ja dokumenteeri.

Kui olemasolev DB kasutaja on praegu liiga privilegeeritud:
paranda minimaalse privilege mudeliga, ilma production DB-d lõhkumata.

Lisa ADR:

```text
docs/decisions/ADR-0008-postgresql-rls-runtime-role.md
```

---

# 14. DB rollid

Eelista vähemalt kontseptuaalselt:

```text
migration role
runtime app role
```

Runtime app role:

- ei ole superuser;
- ei oma BYPASSRLS;
- ei ole põhjendamatult tabeli owner;
- saab ainult vajalikud SELECT/INSERT/UPDATE õigused.

Ära pane runtime appile schema alter/drop õigusi.

Kui eraldi migration role'i productionis kohe teha ei saa ilma liigse riskita:
dokumenteeri ja tee turvaline minimaalne samm.

---

# 15. SET LOCAL – mitte SET

Tenant context tuleb seada transaction-scoped kujul.

Eelistus:

```sql
BEGIN;
SET LOCAL app.tenant_id = '...';
...
COMMIT;
```

Mitte pika elueaga connection state:

```sql
SET app.tenant_id = ...
```

mis võib connection poolis järgmisele requestile lekkida.

Kõik tenant-owned DB toimingud peavad jooksma helperi kaudu, mis:

1. võtab poolist connection'i;
2. alustab transaction'i;
3. seab tenant context'i;
4. teeb callback'i;
5. commit/rollback;
6. release connection'i.

Näiteks kontseptuaalselt:

```ts
withTenantTransaction(tenantId, async (db) => {
  ...
});
```

Ära luba tenant-aware repository'l kasutada suvaliselt global pool.query't.

---

# 16. Connection pool leak test

See test on kohustuslik.

Test:

```text
Request A:
Tenant A
connection X
query A

Request B:
Tenant B
same pooled connection X
query B
```

B ei tohi näha A tenant context'i.

Tee test, mis sunnib connection reuse'i võimalikult deterministlikult.

Kontrolli ka error/rollback path'i:

```text
Tenant A transaction
→ throw
→ rollback
→ connection reused by Tenant B
```

Tenant A context ei tohi lekkida.

---

# 17. Missing tenant context fail-closed

Kui tenant-owned query tehakse ilma tenant context'ita:

```text
0 rows / deny
```

mitte:

```text
all rows
```

RLS policy peab olema fail-closed.

Test:

```text
runtime role
no app.tenant_id
SELECT companies
→ no tenant data
```

---

# 18. Invalid tenant context

Testi:

- malformed UUID;
- unknown tenant;
- suspended tenant;
- inactive membership;
- removed membership;
- user belongs Tenant A but sends Tenant B id.

Kõik peavad failima turvaliselt.

---

# 19. Cross-tenant IDOR testid

Loo vähemalt:

```text
User A → Tenant A
User B → Tenant B
```

Seejärel testi:

```text
User A GET Tenant B company by ID
User A UPDATE Tenant B company
User A list Tenant B members
User A revoke Tenant B membership
User A assign role in Tenant B
User A read Tenant B roles
```

Kõik:

```text
DENY / NOT FOUND
```

Mitte kunagi Tenant B data.

---

# 20. Direct DB RLS test

Ära piirdu API testidega.

Integration testis kasuta runtime DB role'i otse.

Test:

```text
SET LOCAL tenant A
SELECT tenant-owned tables
→ only A

SET LOCAL tenant B
→ only B

no tenant
→ none
```

Testi iga tenant-owned tabelit.

---

# 21. RLS INSERT protection

RLS peab kaitsma ka INSERT/UPDATE, mitte ainult SELECT.

Test:

Tenant A context:

```text
INSERT row with tenant_id = Tenant B
```

→ DENY.

Tenant A:

```text
UPDATE own row SET tenant_id = Tenant B
```

→ DENY.

Kasuta `WITH CHECK` policy't vastavalt vajadusele.

---

# 22. Tenant ID immutable

Tenant-owned objekti `tenant_id` ei tohi tavakasutuse käigus muuta.

Eelista:

- API ei luba seda;
- DB policy/constraint takistab cross-tenant move'i.

Objekti tenant'ite vahel liigutamine peab tulevikus olema eraldi kontrollitud migratsiooniprotsess, mitte CRUD update.

---

# 23. API endpointid

V0.3 minimaalne API võib sisaldada:

```text
POST   /api/v1/tenants
GET    /api/v1/tenants
GET    /api/v1/tenants/:tenantId

GET    /api/v1/companies/current
PATCH  /api/v1/companies/current

GET    /api/v1/members
POST   /api/v1/members/invite   (võib olla v0.3 skeleton, kui e-mail puudub)
PATCH  /api/v1/members/:id
DELETE /api/v1/members/:id

GET    /api/v1/roles
```

Ära lisa endpointi lihtsalt endpointide arvu pärast.

Kõik tenant-scoped endpointid peavad läbima:

```text
session auth
→ tenant context resolution
→ membership validation
→ permission check
→ RLS-backed DB transaction
```

---

# 24. Membership invite

Production SMTP puudub.

Seetõttu ära tee e-maili saatmist v0.3 blokeerijaks.

Võid:

- implementeerida invite domain/state mudeli;
- test provider/dev flow;
- või jätta päris e-maili delivery v0.3 TODO-ks.

Ära muuda serveri Postfixi.

Kui invite tokenit kasutatakse:
- DB-s ainult hash;
- expiry;
- single-use;
- tenant-bound;
- invited email-bound.

---

# 25. Existing v0.2 users migration

Production DB-s võivad olla v0.2 test/user kirjed ilma tenant membershipita.

Ära kustuta neid.

Mõtle läbi migration:

```text
existing user
→ no tenant until user creates/joins one
```

või kui productionis on üks teadaolev internal admin/testkonto ja selle jaoks on põhjendatud bootstrap:
tee see kontrollitult.

Ära automaatselt loo kõigile olemasolevatele useritele ühist tenant'i.

---

# 26. Bootstrap flow

Esimene authenticated user saab luua tenant'i:

```text
POST /api/v1/tenants
```

See loob atomaarse flow:

```text
tenant
company
membership
Owner assignment
audit events
```

Kui üks samm failib:
kogu transaction rollback.

---

# 27. Permission enforcement

Ära tee:

```ts
if (role === 'Owner')
```

kõikjal.

Tee permission service:

```text
requirePermission('member.manage')
```

Server kontrollib permissionit DB-st või turvaliselt cachitud mudelist.

Kui cache't veel pole vaja:
ära lisa.

Permission check peab olema tenant-bound.

---

# 28. Privilege escalation testid

Testi vähemalt:

```text
Viewer → assign self Owner
Employee → manage roles
Admin → modify Owner if not permitted by policy
User A → assign role in Tenant B
Removed member → call tenant API
Suspended member → call tenant API
```

Kõik peavad järgima permission policy't.

---

# 29. Role model

Built-in roles võivad olla seed data.

Mõtle, kas rollid on:

```text
global templates
```

või

```text
tenant-owned roles
```

Kui tulevikus tahame custom rolle, andmemudel peab seda lubama.

Üks mõistlik variant:

```text
permissions = global immutable keys
roles = tenant-owned or system role templates
role_permissions
membership_roles
```

Dokumenteeri ADR-is.

---

# 30. Audit events v0.3

Kasuta olemasolevat audit event süsteemi.

Lisa vähemalt:

```text
TENANT.CREATED
TENANT.UPDATED
TENANT.SUSPENDED

COMPANY.CREATED
COMPANY.UPDATED

MEMBERSHIP.CREATED
MEMBERSHIP.INVITED
MEMBERSHIP.ACTIVATED
MEMBERSHIP.SUSPENDED
MEMBERSHIP.REMOVED

ROLE.ASSIGNED
ROLE.REVOKED
```

Audit payload ei tohi sisaldada secret'e/invite tokeneid.

RLS ei tohi teha audit-logist nähtamatut turvaprobleemi.

Kui audit_events ei ole tenant-owned viisil veel mudeldatud:
tee minimaalne korrektne tenant linkage, kuid ära ehita v0.4 WORM süsteemi.

---

# 31. Trace ID

Kõik v0.3 endpointid peavad säilitama olemasoleva Trace ID infrastruktuuri.

Turvavea korral logi vähemalt:

```text
trace_id
user_id
tenant_id (kui valideeritud)
action
result
error_id
```

Ära logi võltsitud/unvalidated tenant ID-d väljana, mis näib autoriteetse tenant context'ina.

Vajadusel erista:

```text
requested_tenant_id
authorized_tenant_id
```

---

# 32. Error ID-d

Lisa v0.3 jaoks selge register näiteks:

```text
TENANT-001 INVALID_TENANT
TENANT-002 ACCESS_DENIED
TENANT-003 TENANT_SUSPENDED
TENANT-004 MEMBERSHIP_INACTIVE

MEMBER-001 NOT_FOUND
MEMBER-002 LAST_OWNER
MEMBER-003 PERMISSION_DENIED

ROLE-001 INVALID_ROLE
ROLE-002 PERMISSION_DENIED
```

Ära leki teise tenant'i objekti olemasolu.

---

# 33. Company model

Esialgne company UI võib sisaldada:

```text
legal_name
business_id
country_code = FI
base_currency = EUR
```

Ära ehita veel VAT/accounting profile detailset mudelit.

V0.5 Accounting Core / country rules tuleb hiljem.

Aga andmemudel peab võimaldama tulevasi välju migrationitega lisada.

---

# 34. Frontend

Lisa pärast login'i:

## Tenant onboarding

Kui useril pole tenant'i:

```text
Create your company
```

Vorm näiteks:

- company/legal name;
- Y-tunnus/business ID optional või valideeritav;
- country;
- base currency.

## Tenant switcher

Kui kasutajal on mitu membershipit:

```text
Tilivo
[ Company A ▼ ]
```

Tenant switch peab muutma ainult request context'i.

Ära cache'i teise tenant'i data't valesti.

## Settings

Minimaalne:

```text
Company
Members
Roles
```

Hoia UI endiselt hele ja lihtne.

ET/EN i18n säilib.

---

# 35. Frontend state isolation

Tenant switch'i järel:

- tühjenda tenant-scoped cache/state;
- ära näita eelmise tenant'i company/member andmeid;
- ära kasuta tenant-scoped query key'd ilma tenant ID-ta.

Kui kasutad React Query või muud cache'i:
tenant ID peab olema query key osa või cache tuleb switchil invalidate'ida.

Kui sellist library't pole:
lahenda olemasoleva state mudeli järgi.

Lisa UI test tenant switch leakage vastu.

---

# 36. CORS / CSRF

V0.2 security mudel peab säilima.

Tenant header/route ei tohi anda CSRF bypass'i.

Kõik tenant state-changing requestid vajavad endiselt:

```text
valid session
+
valid CSRF
+
valid tenant membership
+
permission
```

---

# 37. RLS migration safety

Enne production migrationit:

1. backup;
2. restore test;
3. test migration fresh DB-s;
4. test existing v0.2 DB snapshot'i upgrade;
5. test rollback test-DB-s;
6. RLS direct tests;
7. runtime DB role test.

Ära lülita productionis RLS-i sisse enne, kui runtime app role policy'd test-DB-s PASS.

---

# 38. Migration transaction

Kui PostgreSQL võimaldab antud migrationit ohutult ühe transactionina:
kasuta seda.

Kui role/ownership muudatus vajab eraldi samme:
dokumenteeri täpselt.

Ära jäta production DB-d pooleldi RLS-enabled seisundisse.

---

# 39. Indexing

Kõigil suureks kasvavatel tenant-owned tabelitel peab olema indeks, mis algab sageli `tenant_id`-ga, kui päringumuster seda nõuab.

Näiteks:

```text
(tenant_id, user_id)
(tenant_id, status)
```

Ära lisa pimesi kümneid indekseid.

Kontrolli query patterns.

---

# 40. UUID / ID mudel

Kasuta olemasolevat projekti ID standardit.

Kui UUID:
ära mine sequence/int ID peale ainult v0.3 jaoks.

Public API-s ID peab olema opaque.

Ära kasuta tenant slug'i security boundary'na.

---

# 41. Tests – unit

Lisa vähemalt:

```text
tenant context resolution
membership active/inactive
permission resolution
last-owner invariant
role assignment rules
tenant status rules
```

---

# 42. Tests – integration

Vähemalt:

```text
user creates tenant
creator becomes Owner
company created
list own tenants
user with no membership denied
inactive membership denied
suspended tenant denied
tenant switch works
member list scoped
role assignment scoped
last Owner protected
```

---

# 43. Tests – RLS hostile matrix

Tee vähemalt kaks tenant'i ja mitu kasutajat.

Näiteks:

```text
Tenant A:
  Owner A
  Viewer A

Tenant B:
  Owner B
```

Test matrix:

```text
Owner A → A data        ALLOW
Owner A → B data        DENY
Viewer A → A read       ALLOW
Viewer A → A manage     DENY
Viewer A → B read       DENY
Owner B → A data        DENY
No tenant context       DENY
Unknown tenant          DENY
Removed member          DENY
Suspended member        DENY
```

---

# 44. Connection pool hostile test

Käivita paralleelselt näiteks:

```text
100 requests Tenant A
100 requests Tenant B
```

sama väikese connection pooliga.

Kontroll:

```text
0 cross-tenant records
0 tenant context leaks
```

Lisa test error/rollback reuse kohta.

---

# 45. Tenant spoof test

Kui tenant context tuleb headerist:

```text
X-Tilivo-Tenant-Id
```

testi:

- puuduv;
- vale;
- Tenant B ID;
- malformed;
- duplicated header;
- casing;
- proxy-added header.

Server membership check on autoriteet.

---

# 46. Direct table test

Iga v0.3 tenant-owned tabel peab saama automaatse RLS test coverage'i:

```text
companies
memberships
roles (kui tenant-owned)
membership_roles
```

Kui mõni tabel on teadlikult global:
dokumenteeri, miks.

---

# 47. Permission source of truth

Frontend võib peita nuppe UX jaoks.

Aga backend on autoriteet.

Test:

```text
call forbidden endpoint directly
```

peab DENY sõltumata UI-st.

---

# 48. No implicit tenant from stale session

Ära kirjuta tenant ID-d session tabelisse ainsa autoriteetse väärtusena.

Membership võib muutuda pärast sessioni loomist.

Iga tundliku requesti puhul peab server suutma tuvastada, et membership on endiselt aktiivne.

Kui active tenant hint salvestatakse sessionisse:
see on ainult UX/context hint, mitte authorization proof.

---

# 49. Membership removal

Kui user eemaldatakse tenant'ist:

- olemasolev login session võib jääda kehtima teiste tenant'ide jaoks;
- kuid eemaldatud tenant'i request peab kohe DENY.

Ära nõua kogu account logout'i, kui see pole vajalik.

Test seda.

---

# 50. Tenant suspension

Kui tenant on `SUSPENDED`:

- tenant-scoped business requestid DENY;
- owner võib vajadusel näha piiratud account/billing infot tulevikus, kuid v0.3-s vali lihtne range mudel.

Dokumenteeri.

---

# 51. Rate limiter

Praegune in-memory limiter jääb ühe API instantsi puhul.

Tenant management endpointid peavad kasutama mõistlikku rate limitingut.

Eriti:

```text
tenant create
invite member
role changes
```

Ära ehita Redis limiterit ainult v0.3 pärast, kui üks instants on praegu arhitektuur.

---

# 52. Security scan

Pärast v0.3 muudatusi:

```text
npm audit
secret scan
git ls-files
```

0 CRITICAL/HIGH dependency issue't.

Ära tee `npm audit fix --force`.

---

# 53. CI

CI peab jooksutama:

```text
lint
typecheck
unit
integration
RLS tests
multi-tenant security tests
build
```

PostgreSQL test service peab võimaldama RLS runtime role testimist.

---

# 54. Dokumentatsioon

Loo/uuenda:

```text
docs/MULTI_TENANCY.md
docs/RLS_SECURITY.md
ARCHITECTURE.md
IMPLEMENTATION_STATUS.md
CHANGELOG.md
DEPLOYMENT.md
```

ADR-id vähemalt:

```text
ADR-0007-tenant-company-model.md
ADR-0008-postgresql-rls-runtime-role.md
ADR-0009-tenant-context-routing.md
```

kui need otsused pole mujal juba adekvaatselt dokumenteeritud.

---

# 55. Production deploy gate

Deploy ainult siis, kui lokaalselt/test-DB-s:

```text
v0.2 regression              PASS
v0.3 unit                    PASS
v0.3 integration             PASS
RLS direct tests             PASS
cross-tenant IDOR            PASS
pool leakage                 PASS
permission escalation        PASS
migration fresh DB           PASS
migration v0.2 snapshot      PASS
backup/restore               PASS
```

---

# 56. Production backup

Enne v0.3 migrationit:

```text
tilivo production backup
→ restore into isolated test DB
→ verify v0.2 schema/data
→ PASS
```

Alles siis migration.

---

# 57. Production migration

Pärast migrationit kontrolli vähemalt:

- v0.2 Identity tabelid alles;
- users alles;
- auth töötab;
- migrations state korrektne;
- v0.3 tabelid olemas;
- RLS enabled;
- FORCE RLS vastavalt disainile;
- runtime app role ei bypassi RLS;
- DB/API/Web healthy.

Ära avalda DB privilege detaile, mis sisaldavad secret'e.

---

# 58. Production smoke

SSH tunnel / localhost kaudu:

```text
login
create tenant
company created
owner membership
read own company
create second test tenant/user
attempt cross-tenant access
DENY
tenant switch
session still works
CSRF still works
2FA still works
```

Kasuta ainult testandmeid.

---

# 59. Existing services verification

Pärast deploy'd kontrolli:

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
muud server.md teenused
```

Kõik peavad olema vähemalt sama state'iga kui enne.

Kui mõni võõras teenus muutub unhealthy:

```text
STOP
rollback Tilivo changes only
```

---

# 60. Public exposure

Endiselt:

```text
NO public DNS
NO public nginx site
NO open registration
```

SMTP võib endiselt olla `noop`.

v0.3 ei vaja internetti avamist.

---

# 61. Security review v0.3 lõpus

Tee mini-review enne PASS-i.

Kontrolli vähemalt:

```text
cross-tenant SELECT
cross-tenant INSERT
cross-tenant UPDATE
cross-tenant DELETE
tenant header spoof
membership bypass
role escalation
last-owner race
connection pool leak
missing tenant context
RLS bypass by runtime role
frontend cache tenant leak
```

Kõik CRITICAL/HIGH leiud paranda enne v0.3 PASS-i.

---

# 62. Git

Tee loogilised commitid.

Näiteks:

```text
feat: add tenant and company domain
feat: add membership roles and permissions
security: enforce PostgreSQL row level security
test: add cross-tenant isolation suite
feat: add tenant onboarding and switcher
docs: document multi-tenant security model
```

Ära force push'i.
Ära commit'i secrets'e.
Push `main`, kui testid PASS.

---

# 63. Stop conditions

Peata ja küsi enne, kui:

- backup FAIL;
- restore FAIL;
- RLS test näitab cross-tenant data leak'i;
- runtime role bypassib RLS-i ja ohutut lahendust pole;
- production migration võib kaotada v0.2 andmeid;
- connection pool tenant leak'i ei saa kõrvaldada;
- vaja oleks muuta serveri võõraid teenuseid;
- vaja oleks public DNS/nginx sisse lülitada;
- Git nõuaks force push'i.

---

# 64. Lõpparuanne

Anna töö lõpus:

## 1. Preflight

```text
v0.2 regression:
backup:
restore:
server health:
```

## 2. DB schema

Loetle:

```text
tenants
companies
memberships
roles
permissions
role_permissions
membership_roles
```

ja reaalselt kasutatud skeem.

## 3. RLS

```text
RLS enabled:
FORCE RLS:
runtime role BYPASSRLS:
runtime role table owner:
tenant context mechanism:
SET LOCAL:
fail-closed without tenant:
```

Igaüks PASS/FAIL + lühiselgitus.

## 4. Authorization

```text
membership validation:
permission service:
last Owner protection:
suspended tenant:
removed membership:
```

## 5. Security tests

```text
cross-tenant SELECT
cross-tenant INSERT
cross-tenant UPDATE
cross-tenant IDOR
tenant spoof
pool reuse
rollback pool reuse
role escalation
last Owner race
session after membership removal
frontend tenant cache isolation
```

PASS/FAIL.

## 6. Testid

Täpsed käsud ja tulemused.

## 7. Production deploy

```text
pre-migration backup:
migration:
DB healthy:
API healthy:
Web healthy:
auth regression:
tenant smoke:
cross-tenant production smoke:
```

## 8. Existing services

PASS/FAIL.

## 9. GitHub

```text
repo:
branch:
latest commit:
push:
working tree:
```

## 10. Open risks

Kõik MEDIUM/LOW/INFO riskid.

## 11. v0.3 gate

Kirjuta üks:

```text
V0.3 MULTI-TENANT SECURITY GATE: PASS
```

või:

```text
V0.3 MULTI-TENANT SECURITY GATE: FAIL
```

Kui FAIL:
ära liigu edasi.

Kui PASS:
STOP ikkagi siin.

Ära alusta v0.4 ega v0.5.

---

# 65. Alusta nüüd

Tööjärjekord:

```text
Read docs/repo
→ preflight
→ backup/restore
→ design tenant/company model
→ ADRs
→ migrations
→ DB roles / RLS
→ tenant transaction helper
→ membership/permission service
→ tenant onboarding API
→ membership/role API
→ frontend onboarding/switcher
→ unit tests
→ RLS direct tests
→ hostile cross-tenant tests
→ pool leakage tests
→ privilege escalation tests
→ full regression
→ security mini-review
→ fix findings
→ production backup
→ deploy migration
→ production smoke
→ verify old services
→ docs
→ Git push
→ V0.3 MULTI-TENANT SECURITY GATE
→ STOP
```

Kõige tähtsam nõue:

> **Kui application-kihis tehakse viga, peab PostgreSQL RLS ikkagi takistama Tenant A-l Tenant B andmeid nägemast või muutmast.**

Ja vastupidi:

> **RLS ei asenda membership- ega permission-kontrolli. Mõlemad kihid peavad töötama koos.**
