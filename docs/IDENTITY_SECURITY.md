# Identity turvadokumentatsioon (v0.2)

## Paroolid

- Algoritm: **Argon2id** (hash-wasm, WASM).
- Parameetrid: iteratsioone 3, mälu 32 MiB, parallelism 1, output 32 bytes; dokumenteeritud koodis.
- Iga hash kasutab juhuslikku soola; paroole ei logita kunagi.

## Tokenid

- E-maili kinnitus, parooli lähtestamine, sessioonid ja 2FA challenge: 24–32 juhuslikku baiti.
- DB-s on ainult SHA-256 hash (`token_hash`); plaintexti DB-s ei hoita.
- Tokenid on ühekordsed (`used_at`) ja aeguvad (24h verification, 30 min reset, 8h/30d sessioon,
  5 min 2FA challenge).

## 2FA / TOTP

- Standard RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 numbrit, ±1 samm).
- Secret genereeritakse serveris ja salvestatakse **AES-256-GCM** krüpteerituna
  (`TOTP_ENCRYPTION_KEY` keskkonnast; envelope `v1:iv:tag:ciphertext`).
- Replay protection: `totp_credentials.last_used_counter` – sama ajavahemiku koodi ei saa uuesti kasutada.
- Recovery codes: 10 koodi, DB-s hash'itult, ühekordsed; uue komplekti loomine kustutab vana.
- Võtmerotatsioon tulevikus: dekrüpteeri vana, krüpteeri uue võtmega (dokumenteeritud, mitte veel CLI).

## Sessioonid

- Cookie HttpOnly; `SameSite=Lax`; production `Secure`.
- Serveris hoitakse `token_hash`, `csrf_token_hash`, `expires_at`, `revoked_at`, `remember_me`.
- Parooli lähtestamine/vahetamine revoke'ib teised sessioonid; logout revoke'ib praeguse.
- IP-d ei kasutata identiteedi tõeallikana; IP läheb ainult audit- ja auth_attempts-metadatasse.
- Trust boundary: `TRUST_PROXY_CIDRS` (loopback + privaatvõrgud); X-Forwarded-For usaldatakse ainult
  sealt. Avaliku reverse proxy lisamisel kitsenda nimekiri.

## Rate limiting / brute force

- Per-IP piirid auth-endpointidel (@fastify/rate-limit).
- Progresiivne piiratud cooldown per (e-mail, IP, endpoint) pärast 5 ebaõnnestumist,
  max 5 minutit – kasutajat ei saa lõputult lukustada.
- `auth_attempts` tabelisse salvestatakse ainult õnnestumise/ebaõnnestumise fakt, mitte parooli.

## Audit

- `audit_events` on append-only (kood ei paku update/delete).
- Audit ei sisalda paroole, tokeneid, TOTP secret'e ega recovery code'e.
- Auth vastustel on `Cache-Control: no-store`.

## Enumeration

- Register, resend ja forgot annavad alati sama generilise vastuse.
- Login annab üldise "Invalid email or password"; e-maili olemasolu selgub alles pärast õiget parooli
  (ja siis ainult kinnituse staatuse kaudu).
- Timing: register teeb hash'i enne konto olemasolu kontrolli; olematu konto login teeb dummy Argon2
  verifitseerimise, et ajastus ei lekiks e-maili olemasolu.

## dev e-mail

- `EMAIL_DRIVER=dev` ja `EMAIL_DEV_OUTBOX=true` on lubatud ainult development/test; production config
  lükkab need tagasi. Production API-l puudub outboxi lugemise route.
