# ADR-0022: Purchase duplicate/idempotency model

Date: 2026-09-03
Status: accepted

## Context

Sama e-arve sündmuse retry ei tohi tekitada mitut arvet ega kannet.

## Decision

- `integration_inbox(provider, external_event_id)` ja
  `purchase_invoices(tenant_id, source_type, source_external_id)` on DB
  taseme unikaalsuskaitse.
- Tarnija arve duplikaat: `(tenant_id, supplier_id, normalized number,
  invoice_date)` aktiivsete olekute puhul.
- Duplikaatimport tagastab olemasoleva arve; mitte unikaalne number üksinda.

## Consequences

- 100 paralleelset sama sündmuse importi => üks ostuarve.
