# Codex / DeepSeek tööülesanne – v0.1 hardening + v0.2 Identity

Sul on olemas töötav raamatupidamise SaaS-i **v0.1**, mis on juba Linux serverisse isoleeritult deploy'itud.

Olulised lähtefailid:

- `raamatupidamise_saas_ARCHITECTURE_v2.md`
- `server.md`
- `ARCHITECTURE.md`
- `DEPLOYMENT.md`
- `IMPLEMENTATION_STATUS.md`
- `CHANGELOG.md`
- `docs/BACKUP_STRATEGY.md`
- olemasolevad ADR-id `docs/decisions/`
- kogu praegune repo

Praegune v0.1 seis:

- Backend: Node 22 LTS + TypeScript + Fastify 5
- Frontend: React 19 + Vite
- DB: PostgreSQL 17 konteineris
- DB access: `pg + SQL`
- Deploy: isoleeritud Docker Compose
- Linux serveris projekt: `/opt/mrjkp-accounting`
- API localhost port: `3100`
- Web localhost port: `3101`
- API health: `/api/v1/health`
- olemasolevaid serveriteenuseid ei tohi rikkuda
- nginx'i pole veel selle projekti jaoks avalikult kasutusele võetud
- DNS/subdomain pole veel avalikult ühendatud
- Git repo on olemas ja v0.1 on commititud

## Eesmärk

Tee kõigepealt v0.1 vajalik hardening ning seejärel ehita **v0.2 Identity**.

Ära mine v0.3 Multi-tenant juurde.

Ära ava veel rakendust avalikku internetti.

Ära muuda ega häiri olemasolevaid serveriteenuseid.

Tee väikeste etappidena:

```text
inspect
→ implement
→ test
→ fix
→ test again
→ deploy
→ smoke test
→ verify old services
```

---

# 1. Loe enne muutmist kõik vajalikud failid läbi

Enne koodi muutmist:

1. loe täielikult `raamatupidamise_saas_ARCHITECTURE_v2.md`;
2. loe täielikult `server.md`;
3. loe `ARCHITECTURE.md`;
4. loe `DEPLOYMENT.md`;
5. loe `IMPLEMENTATION_STATUS.md`;
6. loe `docs/BACKUP_STRATEGY.md`;
7. loe olemasolevad ADR-id;
8. vaata kogu repo struktuur;
9. vaata `git status` ja `git diff`;
10. vaata praegused Docker Compose failid, `.env.example`, migratsioonid ja testid.

Ära väljasta vastusesse `server.md` saladusi, paroole, võtmeid ega tokeneid.

Kui dokumentatsioon ja päris kood erinevad, dokumenteeri erinevus ning käsitle töötavat production konfiguratsiooni ettevaatlikult.

---

# 2. Serveri ohutus jääb absoluutseks nõudeks

Serveris juba töötavad teenused peavad jääma puutumata.

ÄRA:

- peata ega restardi võõraid containereid;
- peata nginx'i, PostgreSQL-i, MariaDB-d, postfixi, cloudflared'i, fail2ban'i ega muid olemasolevaid teenuseid;
- muuda olemasolevate projektide `.env` faile;
- tee `docker system prune`;
- tee `docker volume prune`;
- muuda globaalseid nginx või DB seadeid;
- kasuta olemasolevate projektide DB-sid;
- hõiva juba kasutatud porti;
- tee serverile reboot'i;
- tee distributsiooni upgrade'i;
- muuda firewalli ilma selge vältimatu vajaduseta.

Kui mingi tegevus võib mõjutada teist teenust, ära tee seda automaatselt.

---

# 3. Enne v0.2 – lõpeta v0.1 hardening

Enne päris kasutajaandmete loomist tee järgmised kontrollid ja parandused.

## 3.1 Backup peab päriselt töötama

Praegu on backup-strateegia dokumenteeritud, kuid scheduler pole veel sisse lülitatud.

Tee **ainult selle projekti** jaoks automaatne DB backup.

Nõuded:

- ära kasuta võõra projekti backup-kausta;
- backup peab olema projekti-spetsiifiline;
- failiõigused peavad olema piiratud;
- paroolid ei tohi backup scripti sisse hardcode'ituna sattuda;
- backup peab ebaõnnestumisel andma non-zero exit code'i;
- logi peab näitama timestamp'i, kestust ja tulemust;
- logi ei tohi sisaldada DB parooli;
- retention peab olema mõistlik ja dokumenteeritud.

Kui kasutatakse cron'i või systemd timer'it, loo ainult projekti-spetsiifiline job.

### Kohustuslik restore-test

Tee vähemalt üks päris restore-test:

```text
production backup
→ eraldi ajutine test-DB
→ restore
→ integrity/health check
→ test-DB eemaldamine
```

Ära restore'i production DB peale.

Raporteeri:

```text
BACKUP: PASS/FAIL
RESTORE TEST: PASS/FAIL
```

---

## 3.2 Container restart policy

Kontrolli:

- DB
- API
- Web

restart-policy.

Vali teadlikult sobiv policy, näiteks `unless-stopped`, kui see sobib praeguse deploy mudeliga.

Kontrolli ka:

- DB healthcheck;
- API healthcheck;
- web healthcheck;
- startup dependency loogika.

API ei tohi lihtsalt eeldada, et DB on kohe valmis.

Ära testi seda serveri reboot'iga.

Testi konteinerite tasemel ohutult.

---

## 3.3 Production secrets ja failide õigused

Kontrolli production `.env` ja teiste secret failide õigusi.

Nõuded:

- neid ei commitita;
- world-readable ei ole lubatud;
- ainult vajalik kasutaja/root saab lugeda;
- `.env.example` ei sisalda päris credential'e;
- DB parool peab olema piisavalt tugev;
- secrets ei tohi logidesse sattuda.

Dokumenteeri kasutatav õiguste mudel.

---

## 3.4 PostgreSQL 17 otsus

Projekt kasutab containeris PostgreSQL 17, serveri hostis on muu major-version.

See on lubatud ja isolatsiooni mõttes mõistlik, kuid tee ADR:

```text
docs/decisions/ADR-0004-postgresql-version-policy.md
```

ADR peab kirjeldama:

- miks kasutatakse konteineris PostgreSQL 17;
- miks ei kasutata hosti PostgreSQL instantsi;
- kuidas major-version pin'itakse;
- kuidas tulevikus upgrade tehakse;
- kuidas backup/restore major upgrade puhul käsitletakse.

Ära muuda praegu PostgreSQL major versionit, kui selleks pole tehnilist põhjust.

---

## 3.5 Health endpoint hardening

Kontrolli `/api/v1/health`.

Production vastus võib näidata näiteks:

```json
{
  "status": "ok",
  "checks": {
    "database": "up"
  },
  "trace_id": "..."
}
```

See EI TOHI avaldada:

- DB hostname'i;
- DB versiooni;
- sisemist IP-d;
- connection stringi;
- credential'e;
- stack trace'i;
- container metadata't.

Kui vaja, tee eraldi internal readiness/liveness endpointid, kuid ära avalda tundlikku infot.

---

# 4. Alles pärast hardening PASS-i alusta v0.2 Identity moodulit

v0.2 peab sisaldama:

- users;
- register;
- email verification;
- login;
- logout;
- password reset;
- TOTP 2FA;
- recovery codes;
- remember me 30 päeva;
- session management;
- device/session list;
- remote session revoke;
- rate limiting;
- brute-force protection;
- audit events;
- auth Error ID-d;
- testid.

Ära ehita v0.3 tenant logic'ut veel valmis.

---

# 5. Identity andmemudel

Koosta migratsioonidega vähemalt mõistlikud tabelid:

```text
users
email_verification_tokens
password_reset_tokens
sessions
totp_credentials
recovery_codes
auth_attempts
```

Vajadusel lisa eraldi tabelid, kuid ära tee ühte hiiglaslikku `users` tabelit, kuhu kõik saladused ja sessioonid kokku topitakse.

## Users

Vähemalt:

```text
id
email
email_normalized
password_hash
email_verified_at
status
created_at
updated_at
```

Mõtle läbi email uniqueness ja case normalization.

## Tokens

Verification/reset/session tokenit ei salvestata DB-s plaintextina.

DB-s säilitatakse tokeni:

```text
hash
expires_at
used_at / revoked_at
```

Kasutajale saadetakse ainult algne token.

Kui DB lekib, ei tohi attacker saada aktiivseid reset/verification/session tokeneid otse kasutada.

---

# 6. Parooli hashing

Kasuta:

**Argon2id**

Ära kasuta:

- SHA256 password hashinguks;
- plaintext;
- custom crypto;
- vana nõrka hashing skeemi.

Vali parameetrid konservatiivselt ja dokumenteeri.

Lisa testid:

- õige parool PASS;
- vale parool FAIL;
- hash erineb sama parooli korduvhashimisel salt'i tõttu.

Ära logi paroole.

---

# 7. Register

Endpoint näiteks:

```text
POST /api/v1/auth/register
```

Nõuded:

- request schema validation;
- email normalization;
- duplicate account leakage vältimine;
- password hash;
- verification token;
- audit event;
- structured log;
- Trace ID;
- Error ID.

Ära anna attackerile liiga täpset infot selle kohta, millised emailid süsteemis eksisteerivad.

---

# 8. Email verification

Endpointid näiteks:

```text
POST /api/v1/auth/email/verify
POST /api/v1/auth/email/resend
```

Verification token:

- cryptographically random;
- DB-s ainult hash;
- expiry;
- single-use;
- rate limited.

Audit:

```text
AUTH.EMAIL_VERIFICATION_REQUESTED
AUTH.EMAIL_VERIFIED
AUTH.EMAIL_VERIFICATION_FAILED
```

---

# 9. EmailProvider adapter

Ära seo identity loogikat otse serveri Postfixiga.

Tee liides:

```text
EmailProvider
```

Implementatsioonid võivad olla:

```text
DevelopmentEmailProvider
SmtpEmailProvider
```

Development/test režiimis peab saama verification/reset flow'd testida ilma päris kirja saatmata.

Võid uurida olemasolevat Postfixi read-only, kuid:

**ÄRA muuda serveri Postfix konfiguratsiooni selle ülesande raames.**

Kui production e-mail vajab hiljem eraldi seadistust, dokumenteeri see TODO-na.

---

# 10. Login

Endpoint:

```text
POST /api/v1/auth/login
```

Nõuded:

- email normalization;
- password verification;
- rate limit;
- brute-force protection;
- generic invalid-credentials response;
- audit success/failure;
- session creation;
- Trace ID;
- Error ID.

Ära logi:

- password;
- session token;
- TOTP code.

---

# 11. Sessions

Session token:

- cryptographically random;
- DB-s ainult hash;
- cookie peab olema HttpOnly;
- productionis Secure;
- SameSite teadlikult valitud;
- expiry;
- last_seen;
- revoke support.

Tabelis näiteks:

```text
id
user_id
token_hash
created_at
expires_at
last_seen_at
revoked_at
ip_metadata
user_agent_metadata
remember_me
```

Ära kasuta IP-d identiteedi tõeallikana.

---

# 12. Remember me 30 päeva

Ära tee lihtsalt tavalisest session cookiest 30-päevast tokenit.

Tee teadlik persistent session.

Remember-me session peab olema:

- revocable;
- server-side tracked;
- hashed;
- expire'uv;
- nähtav kasutaja session listis.

Kui turvalisem rotatsioon on mõistlik, implementeeri token rotation.

---

# 13. Logout ja session revoke

Endpointid:

```text
POST /api/v1/auth/logout
POST /api/v1/auth/sessions/:id/revoke
POST /api/v1/auth/sessions/revoke-others
```

Logout:

- revoke current session;
- clear cookie;
- audit event.

Kasutaja peab saama teised seadmed välja logida.

---

# 14. Password reset

Flow:

```text
request reset
→ generic response
→ token
→ verify token
→ new password
→ revoke existing sessions
```

Token:

- random;
- DB-s hash;
- expiry;
- single-use.

Password reset lõpetamisel:

- muuda password hash;
- märgi token kasutatuks;
- revoke olemasolevad sessionid;
- audit event.

Ära avalda reset-request endpointis, kas e-mail eksisteerib.

---

# 15. Password change

Autenditud kasutaja password change:

- nõuab current password'i või tugevamat re-auth'i;
- pärast muutmist revoke teised sessionid;
- praeguse sessioni säilitamise otsus dokumenteeri;
- audit event.

---

# 16. TOTP 2FA

Kasuta standardset TOTP lahendust.

Flow:

```text
start setup
→ generate secret
→ show QR / otpauth URI
→ user confirms current TOTP
→ enable 2FA
```

TOTP secret:

- EI TOHI olla plaintextina DB-s;
- kasuta application-layer encryption'i;
- encryption key tuleb secrets keskkonnast;
- võtme rotatsiooni tulevane võimalus dokumenteeri.

Ära logi TOTP secret'i ega koodi.

---

# 17. Recovery codes

2FA aktiveerimisel genereeri recovery codes.

Nõuded:

- kasutajale näidatakse ainult loomise hetkel;
- DB-s ainult hash;
- single-use;
- kasutatud kood märgitakse kasutatuks;
- võimalik genereerida uus komplekt;
- uue komplekti loomine invalideerib vana;
- audit.

---

# 18. 2FA login flow

Kui kasutajal on TOTP aktiivne:

```text
email/password
→ partial auth challenge
→ TOTP/recovery code
→ session created
```

Ära loo täielikult autentitud sessionit enne 2FA läbimist.

Kui kasutad ajutist challenge tokenit, tee see:

- lühikese expiry'ga;
- single-purpose;
- server-side kontrollitav;
- turvaliselt salvestatud.

---

# 19. Rate limiting ja brute-force protection

Vähemalt:

- register;
- login;
- resend verification;
- password reset;
- TOTP verify;
- recovery-code attempt.

Piirang ei tohi olla ainult emaili järgi.

Arvesta kombineeritult:

- IP;
- account/email;
- endpoint;
- ajavahemik.

Ära loo lihtsat account-lockout süsteemi, millega attacker saab ohvri konto lõputult lukku panna.

Eelista progressive delay / cooldown / bounded lockout.

---

# 20. Auth audit events

Lisa vähemalt:

```text
AUTH.REGISTERED
AUTH.EMAIL_VERIFICATION_REQUESTED
AUTH.EMAIL_VERIFIED
AUTH.LOGIN_SUCCEEDED
AUTH.LOGIN_FAILED
AUTH.LOGOUT
AUTH.PASSWORD_RESET_REQUESTED
AUTH.PASSWORD_RESET_COMPLETED
AUTH.PASSWORD_CHANGED
AUTH.2FA_SETUP_STARTED
AUTH.2FA_ENABLED
AUTH.2FA_DISABLED
AUTH.2FA_FAILED
AUTH.RECOVERY_CODE_USED
AUTH.SESSION_REVOKED
AUTH.ALL_OTHER_SESSIONS_REVOKED
```

Audit logisse ei lähe parool, token, TOTP secret ega recovery code.

---

# 21. Auth Error ID süsteem

Loo selge register.

Näiteks:

```text
AUTH-001 INVALID_REQUEST
AUTH-002 INVALID_CREDENTIALS
AUTH-003 EMAIL_NOT_VERIFIED
AUTH-004 RATE_LIMITED
AUTH-005 SESSION_INVALID
AUTH-006 SESSION_EXPIRED
AUTH-007 VERIFICATION_TOKEN_INVALID
AUTH-008 RESET_TOKEN_INVALID
AUTH-009 TWO_FACTOR_REQUIRED
AUTH-010 TWO_FACTOR_INVALID
AUTH-011 RECOVERY_CODE_INVALID
```

Kasutaja response ja sisemine logi ei pea alati sisaldama sama detailitaset.

Turvalisuse huvides väldi user enumeration'i.

---

# 22. CSRF ja cookie auth

Kui auth kasutab browser cookie't, tee CSRF mudel teadlikult.

Dokumenteeri ADR-is:

- SameSite valik;
- CSRF token või muu kaitse;
- CORS;
- allowed origins;
- production cookie flags.

Tee vajadusel:

```text
docs/decisions/ADR-0005-session-and-csrf-model.md
```

---

# 23. Frontend Identity UI

Hoia UI puhas ja hele.

Vähemalt:

- Register;
- Verify email state;
- Login;
- Forgot password;
- Reset password;
- 2FA challenge;
- 2FA setup;
- Recovery codes display;
- Sessions/device list;
- Logout.

Ära ehita veel raamatupidamise dashboard'i funktsionaalsust.

Pärast login'i võib olla lihtne placeholder authenticated home.

---

# 24. i18n

Praegune ET/EN lahendus peab säilima.

Ära hardcode'i uusi auth tekste komponentidesse, kui olemasolev i18n süsteem võimaldab tõlkefaili.

Struktuur peab hiljem lubama FI keele lisamist ilma auth loogikat muutmata.

---

# 25. Testid – kohustuslikud

v0.2 ei ole valmis, kui ainult happy path töötab.

## Unit tests

Vähemalt:

- password hash/verify;
- token hashing;
- token expiry;
- email normalization;
- TOTP verify;
- recovery code hash/use;
- session expiry;
- remember-me expiry;
- auth Error ID mapping.

## Integration tests

Vähemalt:

```text
register
duplicate register behavior
email verification
expired verification
login before verification
login after verification
wrong password
rate limit
logout
session revoke
password reset
expired reset token
password reset revokes sessions
2FA enable
2FA login
wrong TOTP
recovery code login
recovery code cannot be reused
```

## Security tests

Vähemalt:

- response ei leki password hash'i;
- response ei leki token hash'i;
- logs ei sisalda plaintext password'i;
- logs ei sisalda TOTP secret'i;
- reset endpoint ei võimalda account enumeration'i;
- revoked session ei tööta;
- expired session ei tööta;
- CSRF mudel töötab vastavalt valitud arhitektuurile.

---

# 26. Migration testid

Kõik v0.2 tabelid migrationite kaudu.

Testi:

```text
fresh DB
→ migrate up
→ tests
```

Kui migration down on mõistlikult toetatav:

```text
down
→ up
→ tests
```

Production DB-s ei tee destruktiivset down-migrationit lihtsalt testimise pärast.

---

# 27. CI

Uuenda CI nii, et vähemalt:

```text
lint
typecheck
unit tests
integration tests
build
```

jooksevad automaatselt.

Kui integration test vajab PostgreSQL-i, lisa CI jaoks isoleeritud test DB/service.

---

# 28. Deploy v0.2 serverisse

Deploy alles siis, kui lokaalsed/build testid PASS.

Serveris:

1. backup enne migrationit;
2. kontrolli backup PASS;
3. deploy ainult `mrjkp-accounting`;
4. migration;
5. API startup;
6. web startup;
7. healthcheck;
8. auth smoke tests;
9. kontrolli logisid;
10. kontrolli, et vanad serveriteenused töötavad.

Ära ava DNS-i ega nginx public site'i.

Ligipääs jääb localhost/SSH tunnel tasemele.

---

# 29. Production smoke test

Tee serveris või SSH tunneli kaudu testkonto, mis EI ole päris kliendiandmetega.

Testi vähemalt:

```text
register
verification development flow
login
logout
password reset
2FA enable
2FA login
sessions list
session revoke
```

Kui production EmailProvider pole ühendatud, kasuta turvalist development/test meetodit, mis ei logi plaintext tokenit production logisse.

Kui verification tokeni testimiseks on vaja spetsiaalset test-only mehhanismi, see peab olema:

- disabled tavarežiimis;
- selgelt piiratud;
- dokumenteeritud;
- mitte avaliku endpointina productionis.

---

# 30. Ära ava veel avalikku aadressi

Selles ülesandes:

```text
NO public DNS
NO public nginx site
NO internet-facing registration
```

Põhjus: enne avalikku exposure'it tahame v0.2 security review'd.

Nginx template'i võib vajadusel uuendada, kuid ära aktiveeri seda.

---

# 31. Dokumentatsioon

Uuenda:

```text
README.md
ARCHITECTURE.md
DEPLOYMENT.md
IMPLEMENTATION_STATUS.md
CHANGELOG.md
docs/BACKUP_STRATEGY.md
```

Lisa vajadusel:

```text
docs/IDENTITY_SECURITY.md
docs/decisions/ADR-0004-postgresql-version-policy.md
docs/decisions/ADR-0005-session-and-csrf-model.md
```

---

# 32. Git

Enne töö algust:

```text
git status
git diff
```

Ära kaota kasutaja olemasolevaid muudatusi.

Tee loogilised commitid.

Ära commit'i `.env`, `server.md`, secrets'e, backup-faile ega päris kasutajaandmeid.

---

# 33. Stop conditions

Peata töö ja küsi enne, kui:

- backup restore test ebaõnnestub;
- migration võib hävitada olemasolevaid andmeid;
- serveris tekib port/container/DB konflikt;
- vaja oleks muuta Postfixi globaalset config'i;
- vaja oleks muuta nginx'i avalikku production config'i;
- vaja oleks avalik DNS sisse lülitada;
- vajad päris SMTP/API credential'i;
- olemasolev võõras teenus muutub deploy käigus unhealthy'ks;
- tekib olukord, kus kasutajaandmete turvalisust ei saa olemasoleva info põhjal kindlalt lahendada.

Muul juhul tee iseseisvalt mõistlikud konservatiivsed otsused.

---

# 34. Lõpparuanne

Ära vasta ainult "done".

Anna töö lõpus täpne aruanne:

## 1. v0.1 hardening

```text
Backup scheduler:
Restore test:
Restart policy:
Health checks:
Secrets permissions:
PostgreSQL version ADR:
Health endpoint hardening:
```

Igaühel `PASS / FAIL / TODO`.

## 2. Loodud/muudetud failid

Täielik nimekiri.

## 3. DB migratsioonid

- tabelid;
- indeksid;
- constraints;
- token hash storage;
- session storage;
- 2FA secret encryption.

## 4. Identity funktsioonid

Igaüks:

```text
Register              PASS/FAIL
Email verification    PASS/FAIL
Login                 PASS/FAIL
Logout                PASS/FAIL
Password reset        PASS/FAIL
Remember me           PASS/FAIL
Sessions              PASS/FAIL
TOTP 2FA              PASS/FAIL
Recovery codes        PASS/FAIL
Rate limiting         PASS/FAIL
Audit events          PASS/FAIL
```

## 5. Testid

Täpsed käsud ja päris tulemused.

## 6. Security kontroll

- plaintext secrets in DB?
- plaintext tokens in DB?
- plaintext password in logs?
- TOTP secret encryption?
- revoked sessions rejected?
- reset revokes sessions?
- account enumeration mitigated?
- CSRF model implemented?

## 7. Server deploy

- backup before migration;
- migration status;
- containers;
- API;
- web;
- smoke tests;
- existing services after deploy.

## 8. Teadaolevad riskid

Kõik ausalt kirja.

## 9. Järgmine samm

Ära alusta automaatselt v0.3.

Pärast v0.2 lõpetamist peatu ja anna raport.

---

# 35. Alusta nüüd

Tööjärjekord:

```text
1. Read all source docs
2. Inspect git/repo
3. Read-only server verification
4. Implement real backup scheduler
5. Perform isolated restore test
6. Check restart/health policies
7. Harden secrets permissions
8. Add PostgreSQL version ADR
9. Harden health endpoint
10. Run v0.1 regression tests
11. Design v0.2 Identity schema
12. Implement migrations
13. Implement password/token primitives
14. Implement register + email verification
15. Implement sessions + login/logout
16. Implement password reset/change
17. Implement TOTP + recovery codes
18. Implement rate limiting/brute-force protection
19. Implement audit events + Error IDs
20. Implement frontend auth flows
21. Run full local test suite
22. Fix all failures
23. Backup server
24. Deploy v0.2
25. Run migrations
26. Run server tests/smoke tests
27. Verify all old services remain healthy
28. Update docs
29. Commit logical changes
30. STOP and report – do not start v0.3
```

Eesmärk on saada **v0.2 Identity turvaliselt ja päriselt valmis**, mitte lihtsalt teha login-formi.
