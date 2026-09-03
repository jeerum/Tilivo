# Employee Registry v0.14

The employee registry stores tenant-scoped employees and employment history. It supports searchable list/detail views, status lifecycle, protected personal identity and bank/tax fields, insurance/readiness metadata, and one active employment per employee.

API endpoints are available under `/api/v1/employees`. Sensitive fields are returned only with `employees.manage_sensitive`; all mutations write audit events. PostgreSQL RLS and tenant-qualified foreign keys protect cross-company access.
