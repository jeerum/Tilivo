# Tilivo v0.2 Security Review

Kuupäev: 2026-09-02

See dokument on v0.2 Identity security review enne v0.3 Multi-Tenant/RLS arendust.
Dokument ei sisalda paroole, tokeneid, TOTP-võtmeid ega production-secret'e.

## Review scope

- Identity/session/CSRF/2FA/token/audit kood ja migratsioonid.
- Cookie- ja header-turvalisus, rate limiting/trust boundary, logi redaktsioon.
- dev_email_outbox isoleeritus, SQL/validation, error handling.
- Backup/restore, secrets, dependency audit, CI.

Ründaja tüübid: anonüümne internetikasutaja, registreeritud kasutaja, pahatahtlik kasutaja,
varastatud session tokeniga ründaja, DB dump'i saanud ründaja, logidele ligi saanud ründaja,
browser CSRF/XSS ründaja, race-condition ründaja, brute-force/credential stuffing ründaja.

Kaitstavad varad: paroolid, sessionid, reset/verification tokenid, TOTP secret'id, recovery codes,
audit history, e-mail, production secrets, backupid.

## Findings

| ID | Severity | Komponent | Leid | Staatus |
| --- | --- | --- | --- | --- |
| SEC-V02-001 | HIGH | Verification token | Konkurentne sama tokeni kasutus võis teha mitu state transitioni | FIXED + test |
| SEC-V02-002 | HIGH | Reset token | Konkurentne reset võis mitu korda parooli muuta | FIXED + test |
| SEC-V02-003 | HIGH | 2FA challenge | Challenge one-time garantiil puudus atomarne claim | FIXED + test |
| SEC-V02-004 | MEDIUM | TOTP | Sama TOTP kood oli samas ajavahemikus replay'tav | FIXED (last_used_counter) + test |
| SEC-V02-005 | HIGH | Session revoke | Teise kasutaja sessioni revoke andis 204 (IDOR) | FIXED (404) + test |
| SEC-V02-006 | MEDIUM | Enumeration | Register/login ajastus võis e-maili olemasolu lekitada | FIXED (dummy Argon2 verify + hash enne checki) |
| SEC-V02-007 | MEDIUM | dev e-mail | EMAIL_DRIVER=dev/outbox sai production'is sisse lülitada | FIXED (config guard) |
| SEC-V02-008 | MEDIUM | HTTP cache | Auth vastustel puudus Cache-Control: no-store | FIXED + test |
| SEC-V02-009 | MEDIUM | Trust boundary | trustProxy oli liiga lai (kõik allikad) | FIXED (explicit CIDR nimekiri) |
| SEC-V02-010 | LOW | 2FA brute force | TOTP/recovery katsetel puudus account-cooldown | FIXED |
| SEC-V02-011 | INFO | Rate limiting | Limiter on ühe instantsi mälu põhine – ühe instantsi puhul aktsepteeritud, dokumenteeritud | Documented |
| SEC-V02-012 | INFO | Audit | Append-only on rakenduse tasemel; DB owner saab otse muuta – WORM tuleb v0.4+ | Documented |

## Session security

- Login loob alati uue sessioni ja uue CSRF-tokeni; vana cookie ei muutu sessiooniks (test).
- Session token: 32 juhuslikku baiti base64url; DB-s SHA-256 hash.
- Revoke, expiry ja remember-me eristus on serveripoolne ja andmebaasis.
- Parooli reset/change revoke'ib teised sessioonid; logout revoke'ib praeguse.

## CSRF

- Mudel: same-site cookie + `x-csrf-token` päis; tokeni hash on sessiooni reas.
- Puuduv/vale token => 403 AUTH-012 (test).
- State-changing tegevused on kaetud (logout, revoke, password, 2FA).
- GET ei muuda olekut.

## Tokend ja 2FA

- Verification/reset/challenge/session tokenid DB-s ainult hash'ituna.
- One-time garantiid on nüüd atomarsed (conditional UPDATE + RETURNING).
- TOTP secret AES-256-GCM; replay protection salvestab viimase kasutatud counteri.
- Recovery code single-use on DB unique + conditional UPDATE; race testitud.
- 2FA ei muutu enne confirm'iks mõeldud TOTP koodi.

## Rate limiting / trust

- Per-IP piirid auth-endpointidel + piiratud progressiivne cooldown.
- Trust boundary: `TRUST_PROXY_CIDRS` (loopback + privaatvõrgud) – dokumenditud; avaliku reverse proxy
  lisamisel tuleb nimekiri kitsendada reaalsele proxy IP-le.

## Audit/logid

- Audit on append-only rakenduse tasemel; paroole/tokeneid/TOTP/recovery koode ei logita.
- pino redaktsioon: authorization/cookie/parooliväljad; marker-secret testidega kontrollitud.

## dev_email_outbox

- Production: `EMAIL_DRIVER=noop`, outbox keelatud config guard'iga; API-l puudub outboxi lugemise route.
- Tabel on loodud ka production DB-s (migratsioonist), aga sinna ei kirjuta production provider.
- Arendus/test: kirjutab ainult test/development keskkonnas.

## Backup/restore/secrets

- Backup systemd `tilivo-backup.timer`; restore-testid PASS.
- TOTP key enne/pärast rename'i sama; encrypted secretid jäävad dekrüpteeritavaks.
- `server.md`, `.env`, backupid ei ole Git'is.
- Dependency audit: 0 vulnerabilities (api prod + web).

## Security tests

Kõik läbivad serveris test-DB vastu (43/43):

```text
Session fixation/rotation      PASS
CSRF missing/wrong token       PASS
CSRF logout/revoke             PASS
IDOR session revoke            PASS
Verification token race        PASS
Password reset race            PASS
Recovery code race             PASS
TOTP replay                    PASS
2FA challenge reuse            PASS
User enumeration timing fix    PASS
Cache-Control no-store         PASS
Rate limit                     PASS
```

## Open risks (backlog)

- Ühe instantsi rate limiter (dokumenteeritud).
- Audit WORM/hash chain (v0.4+).
- Production SMTP driver puudub.
- Volume füüsiline legacy nimi säilib (andmete turvalisus).

