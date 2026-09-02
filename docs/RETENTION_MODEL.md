# Retention mudel (v0.4 foundation)

Eristatakse tulevikus: soft delete, archive, legal retention, anonymisation, hard delete.

- `retention_policies` – object_type/country/retention_days/effective_from/effective_to/rule_version.
- `retention_holds` – tenant-specific hold objektidele.
- v0.4 ei hardcode'i Soome tähtaegu äriloogikasse; country rules tulevad hiljem.
- Kinnitatud finants/õigusdokumentide automaatset kustutamist pole v0.4-s.

