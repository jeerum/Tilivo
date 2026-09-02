# ADR-0005 – Sessiooni- ja CSRF-mudel

Kuupäev: 2026-09-02

> Ajakohastatud 2026-09-02 (rename): cookie nimed on nüüd `tilivo_session` ja `tilivo_csrf`.
> Ülejäänud mudel (SameSite, HttpOnly, Secure, double-submit) on muutmata.

## Probleem

Identity kasutab brauseri cookie-põhist autentimist. Tuleb valida sessiooni tokeni eluiga, cookie lipud,
SameSite ja CSRF-kaitse ning dokumenteerida CORS/allowed origins.

## Valik

- Sessioonitoken: juhuslik 32-byte `base64url`, DB-s **SHA-256 hash**.
- Cookie: `tilivo_session`, `HttpOnly`, `SameSite=Lax`, `Path=/`; `Secure` lülitatakse sisse
  `COOKIE_SECURE=true` (production) ja keelatakse testis/localhostis.
- Sessiooni eluiga: tavaline 8 tundi; `remember_me=true` annab eraldi 30-päevase sessiooni
  (serveris jälgitav, revoke'itav, hash'itud).
- CSRF: **double-submit** mudel.
  - Teine cookie `tilivo_csrf` (mitte HttpOnly, sest JS peab seda lugema) sisaldab juhuslikku tokenit;
  - sama tokeni SHA-256 hash on sessiooni reas;
  - kõik muutvad päringud (POST/PUT/PATCH/DELETE), millel on sessioon, peavad saatma päise
    `x-csrf-token`, mis peab kattuma cookie'ga;
  - erandiks ainult `register`, `login`, `forgot`, `reset`, `email/verify` (sessioon puudub).
- CORS: rakendus on sama-origin (frontend proksib `/api`); CORS pole lubatud ühelegi teisele originile.
- Allowed origins: sama origin (praegune host); väliseid origin'e ei aksepteerita.

## Tagajärjed

- CSRF-rünne eeldab nii sessiooniküpsist kui ka loetavat CSRF-cookie't + päist, mida cross-site request
  ei saa tekitada.
- Tulevikus subdomain'ide puhul tuleb mudel uuesti üle vaadata (nt `__Host-` prefiks, origin-allowlist).
