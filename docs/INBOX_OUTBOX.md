# Inbox/Outbox (v0.4)

- `integration_inbox`: unique `(provider, external_event_id)` – idempotentne vastuvõtt.
- `integration_outbox`: event kirjutatakse samas DB transaktsioonis äritegevusega.
- Worker: `tilivo-worker` container, roll `tilivo_worker` (NOSUPERUSER/NOBYPASSRLS);
  claim `FOR UPDATE SKIP LOCKED`, retry `2^n` backoff max 1h, pärast 10 katset FAILED.
- Runtime API roll ei saa otse queue't lugeda; outboxi lisamine käib security definer funktsiooni kaudu
  pärast membership/permission kontrolli.

