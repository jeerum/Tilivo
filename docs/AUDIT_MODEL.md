# Audit mudel (v0.4)

- `audit_events` on append-only: runtime roll saab INSERT/SELECT, mitte UPDATE/DELETE.
- Iga sündmus sisaldab `tenant_id` (kui teada), `user_id`, `action`, `object_type/id`,
  `metadata`, `ip_metadata`, `user_agent`, `trace_id`, `previous_hash`, `event_hash`.
- Hash-chain: event_hash = SHA-256 canonical payload + previous_hash; chain seeriatakse
  `pg_advisory_xact_lock`-iga.
- Tavaline API ega UI ei paku audit history muutmist; tenant-scoped lugemine vajab `audit.read`.

