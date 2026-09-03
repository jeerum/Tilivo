# Business Registry Integration (v0.7.5)

## Goal

Tilivo v0.7.5 adds a reusable Finnish business registry integration. Users can
look up a company by name or Finnish Business ID (Y-tunnus) from the customer
and supplier forms. Registry data fills the form for review; it is an
assistant, never a hard dependency for manual entry.

## Provider

Selected provider: **PRH YTJ open data API v3** (Finnish Patent and
Registration Office / Business Information System).

- Base URL: `https://avoindata.prh.fi/opendata-ytj-api/v3`
- Search: `GET /companies?name=...` and `GET /companies?businessId=...`
- OpenAPI schema: `https://avoindata.prh.fi/opendata-ytj-api/v3/schema?lang=en`
- License: Creative Commons Attribution 4.0 (CC BY 4.0) - source
  attribution belongs in the UI/docs wherever registry data is presented.
- No API key; data is public. Rate limits are documented as HTTP 429.

The adapter is intentionally not called "customer form -> Finnish registry".
The application talks to a provider-neutral
`BusinessRegistryProvider` interface; customer/supplier UI never touches PRH
directly. A future Estonia (Äriregister) or Sweden (Bolagsverket) provider can
be added without touching the customer/supplier forms.

## Architecture

```text
SalesPage / PurchasesPage
        |
        v
GET /api/v1/business-registry/search?q=...   (requires registry.read)
        |
        v
BusinessRegistryService
  - Y-tunnus normalize/validate (modulus-11) before any network call
  - DB cache (business_registry_cache) with TTL
  - app-level sliding window rate limiter per provider/tenant/user
        |
        v
BusinessRegistryProvider (interface)
        |
        v
PrhYtjRegistryProvider (global fetch + zod validation + normalization)
```

The normalized model is defined in
`apps/api/src/services/businessRegistryTypes.ts` and is validated by zod
end-to-end (`registryCompanySchema` validates both search results and the
`registry_snapshot` accepted when a party is saved).

## API

```text
GET /api/v1/business-registry/search?q=<name or Y-tunnus>[&limit=20]
GET /api/v1/business-registry/companies/:businessId
```

- Requires tenant context header and `registry.read` permission (seeded to
  Owner/Admin/Accountant/Employee/Viewer roles).
- A structurally valid Y-tunnus with a bad check digit returns HTTP 400
  `REG-001` without contacting the provider.
- A valid but unknown Y-tunnus returns an empty `results` array on the search
  endpoint and HTTP 404 `REG-002` on the exact lookup endpoint.
- Provider downtime returns HTTP 503 `REG-003`; rate limits HTTP 429
  `REG-004`; disabled feature HTTP 503 `REG-005`.

## Persisted registry metadata

`business_parties` gains four nullable columns (existing manual rows keep
NULLs):

| Column | Meaning |
|---|---|
| `registry_source` | provider id, e.g. `PRH_YTJ_V3` |
| `registry_source_id` | canonical Business ID, e.g. `0112038-9` |
| `registry_fetched_at` | when the provider result was fetched server-side |
| `registry_snapshot` | normalized `RegistryCompany` object (statuses + codes, no large raw payload) |

Customers and suppliers accept these fields on POST/PATCH. Clearing them (null)
detaches provenance. The UI only sends them when the selected registry company
still matches the current form Business ID, so editing a value after selection
does not attach misleading metadata.

Audit events on the existing hash chain:

- `CUSTOMER.REGISTRY_IMPORTED` / `SUPPLIER.REGISTRY_IMPORTED` (create)
- `CUSTOMER.REGISTRY_REFRESHED` / `SUPPLIER.REGISTRY_REFRESHED` (update)

Plain searches are deliberately not audited to avoid high-volume noise.

## Field mapping (PRH YTJ v3 -> normalized)

| Normalized | Source |
|---|---|
| `business_id` | `businessId.value`, normalized + checksum-validated |
| `legal_name` | current type-1 company name (version 1 / no end date preferred) |
| `vat_id` | derived `FI` + eight digits (format only - not registration evidence) |
| `status` | derived from `status` (STATUS3), `endDate`, company situations (SANE/SELTILA/KONK) and trade register status |
| `status_code` | raw Business ID status code (1/2/5) |
| `trade_register_status` | raw PRH value |
| `registration_date` / `end_date` | `registrationDate` / `endDate` |
| `company_form` | current `companyForms` entry + FI/EN descriptions |
| `address` | street address (type 1) preferred, postal address (type 2) used as fallback / PO box |
| registers | interpreted from `registeredEntries` using PRH `REK` register codes + `REK_KDI` entry codes |

Register interpretation:

| Register state | `register` | active `type` values |
|---|---|---|
| Trade register | 1 | 1 |
| VAT liability | 6 | 80, 82-88, V80 |
| Prepayment register | 5 | 55 |
| Employer register | 7 | 41, 42 |

`registers.vat.registered` is only true when a VAT register entry exists - a
derived `FI` VAT identifier alone never implies VAT registration.

## Cache and rate limiting

- `business_registry_cache` stores normalized result payloads keyed by
  `(provider, lookup_type, lookup_key)`. Public registry data is not
  tenant-scoped, so the table intentionally has no RLS policy; grants are
  limited to `tilivo_runtime`.
- A fresh cache hit (`fetched_at` within TTL) avoids the provider completely;
  responses include `from_cache`.
- The app-level rate limiter is a per-provider/tenant/user sliding window that
  counts actual provider calls (cache hits are free). The web UI also debounces
  typing (500 ms) to avoid typeahead storms.

## Configuration

See `apps/api/.env.example`:

| Env | Default | Meaning |
|---|---|---|
| `BUSINESS_REGISTRY_ENABLED` | `true` | set `false` to disable live lookups (manual entry still works) |
| `BUSINESS_REGISTRY_BASE_URL` | PRH YTJ v3 URL | configured provider endpoint; no generic URL fetching is allowed |
| `BUSINESS_REGISTRY_TIMEOUT_MS` | `8000` | per-request AbortSignal timeout |
| `BUSINESS_REGISTRY_CACHE_TTL_SECONDS` | `43200` | cache TTL for both Business ID and name lookups |
| `BUSINESS_REGISTRY_RATE_LIMIT_PER_MINUTE` | `20` | external provider calls per tenant/user/minute |

No secrets are exposed to the browser: the provider runs server-side and no
API key is needed for the current source.

## Error handling / resilience

The provider maps timeouts, DNS/network failures, non-2xx HTTP, malformed JSON
and schema-invalid payloads to user-friendly `REG-003` errors; HTTP 429 is
preserved as `REG-004`. Errors never expose raw stack traces. Registry
downtime never blocks customer/supplier creation - the form is always
available for manual entry.

## Testing

The external provider is mocked everywhere; automated tests never depend on
the live registry.

- `apps/api/tests/businessId.test.ts` - normalization, checksum, VAT format.
- `apps/api/tests/prhYtjRegistryProvider.test.ts` - live-shaped fixture,
  not-found, HTTP/network/timeout/malformed mapping, rate limit, VAT and
  register normalization (global fetch stubbed).
- `apps/api/tests/businessRegistryService.test.ts` - validation before
  network, cache hits, rate limiting, disabled mode (in-memory fake cache DB).
- `apps/api/tests/businessRegistry.integration.test.ts` - full HTTP flows with
  a fake provider against a server test DB (`TEST_DATABASE_URL`), including
  customer/supplier autofill metadata, refresh/clear and manual fallback.
- `apps/web/src/lib/businessRegistry.test.ts` - form patch/conflict helpers.

Optional manual live verification (not part of CI):

```text
GET https://avoindata.prh.fi/opendata-ytj-api/v3/companies?businessId=0112038-9
```

Local full-suite run (2026-09-03 gate):

1. Start a local PostgreSQL 17 (project image is `postgres:17-alpine`) with
   roles `tilivo_app` (owner), `tilivo_runtime` and `tilivo_worker`.
2. Reset the test database before every run (repo convention):
   `DROP DATABASE tilivo_accounting_test`, recreate with owner `tilivo_app`,
   grant CONNECT to `tilivo_runtime` and `tilivo_worker`.
3. Run migrations with `MIGRATION_DATABASE_URL` pointing at the test DB,
   then run tests with `TEST_DATABASE_URL` and `WORKER_TEST_DATABASE_URL`.
4. Local `.env` files are gitignored; do not commit passwords.

Final gate result (2026-09-03): migration validated on dev + test DB, API
suite 137/137 PASS (registry integration 9/9, 0 skipped), live PRH smoke PASS,
Playwright registry flows 9/9 PASS on desktop/tablet/mobile.

## Limitations

- v0.7.5 is Finland-first. Estonia/Sweden providers are not implemented.
- `tradeRegisterStatus` and situations are interpreted conservatively; the raw
  provider codes are preserved alongside normalized statuses.
- Name search may match auxiliary/former names; the result list shows the
  current primary legal name with the Business ID, city and status so the user
  can disambiguate before selection.
- Registry data is a snapshot at selection time; refresh happens through the
  edit form (re-lookup + review) rather than a background scheduled refresh.

## Manual QA checklist

Desktop:

1. Customers -> add -> search by name -> multiple results -> select one.
2. Search by valid Y-tunnus; by invalid Y-tunnus (validation message).
3. Confirm autofill; edit a field first, then select registry data
   (overwrite confirmation appears).
4. Provider-error simulation (disable registry or network): clean message and
   manual form still usable.
5. Suppliers: same flows incl. address/phone/payment terms fields.
6. Edit an existing registry-imported party: fields are prefilled from local
   values, and re-lookup + save persists refreshed metadata.

Mobile (narrow viewport):

7. Registry search, result list, selection and autofill on a narrow screen.
8. No horizontal overflow; buttons reachable; no hover-only interactions.
