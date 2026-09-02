# Document storage (v0.4)

- `documents` (tenant-owned, RLS+FORCE) ja `document_versions` (RLS+FORCE).
- Iga versioon: `storage_key`, filename, MIME, size, SHA-256.
- `confirmed_at` pandud versioon on immutable (DB trigger keelab UPDATE).
- Provider: `LocalObjectStorageProvider` (Docker volume `tilivo-document-storage`,
  path `/app/storage/documents`); hiljem S3-adapter.
- Faili alla laadimine ainult autentitud + tenant + permission + RLS kontrollitud endpointist.
- Lubatud: PDF, JPEG, PNG; max 10 MB; storage key on serveri genereeritud.
- Scanner: `NoopFileScannerProvider` (dokumenteeritud open risk; mitte väidetud malware-safe).

