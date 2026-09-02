# ADR-0006 – TOTP replay protection ja trust boundary

Kuupäev: 2026-09-02

## Probleem

Security review leidis:

1. Sama TOTP kood oli samas 30-sekundilises aknas korduvalt kasutatav.
2. `trustProxy: true` usaldas X-Forwarded-For kõikidelt allikatelt, mis võimaldaks rate-limit bypass'i.

## Valik

1. TOTP replay protection: `totp_credentials.last_used_counter` (bigint). Iga õnnestunud TOTP kasutus
   salvestab TOTP counteri; sama või vanema counteriga kood lükatakse tagasi. Muudatus on atomarne
   (`UPDATE ... WHERE last_used_counter IS NULL OR last_used_counter < $counter`).
2. Trust boundary: `TRUST_PROXY_CIDRS` environment; vaikimisi loopback + privaatvõrgud. Avalikuks
   kasutuseks tuleb nimekiri kitsendada reaalsele reverse proxy aadressile.

## Tagajärjed

- TOTP koodi replay ei loo uut sessiooni; migratsioon
  `20260902150000_totp_replay_protection` lisab columni.
- Rate limiting tugineb ainult usaldatud proxy-aadressidelt saadud IP-le.

