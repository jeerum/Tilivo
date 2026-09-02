# ADR-0002 – Andmebaasipöördus ja migratsioonid

Kuupäev: 2026-09-02

## Probleem

Kuidas pääseda PostgreSQL'ile, hoida skeemi source control'is ja tagada parameteriseeritud SQL?

## Variandid

1. ORM (TypeORM/Prisma/Drizzle)
2. Query builder (Knex)
3. Natuke `pg` + migratsioonitööriist

## Valik

**`pg` (pool) + node-pg-migrate**, SQL parameteriseeritud; esialgu ilma ORM-ita.

## Põhjendus

- v0.1-s on SQL-kiht väike; ORM tooks lisaraskuse ja peidaks raamatupidamise nõudliku SQL-i.
- Raha ja kanded nõuavad hiljem täpset transaktsioonikontrolli; otse SQL annab selle kätte.
- node-pg-migrate on küps, versioonid on failid source control'is; rollback on võimalik.
- Parameteriseeritud päringud väldivad SQL injection'i.

## Tagajärjed

- Iga tabeli loomine/muutmine käib migratsiooni kaudu.
- RLS-i ja tenant-contexti saab hiljem lisada ilma ORM-i võitluseta.

