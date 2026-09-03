# Error ID registry

```text
SYS-001      internal error
DB-001       database health
API-001/002  not found / invalid request
CFG-001      configuration
AUTH-001..014 auth
TENANT-001..004 tenant
MEMBER-001..003 members
ROLE-001..002 roles
DOC-001..003 documents
AUDIT-001    audit
INBOX-001    duplicate inbox
OUTBOX-001   outbox claim/worker
ACC-001..003 account not found / inactive / duplicate code
PERIOD-001..004 period not found / closed / soft closed / invalid range
JRN-001..006 journal not found / not draft / not balanced / line invalid /
             immutable / already reversed
TAX-001..003 tax code not found / invalid / duplicate
FX-001..003  fx rate not found / duplicate / invalid
CUR-001      currency not found
CUST-001..003 customer not found / inactive / invalid customer
INV-001..013 invoice not found / not draft / no lines / line invalid /
             due date invalid / series missing / account mapping missing /
             tax code invalid / immutable / already credited / pdf not ready /
             reference invalid / currency invalid
SUP-001..003 supplier not found / inactive / match ambiguous
PUR-001..012 purchase not found / not editable / no lines / line invalid /
             duplicate / approval required / approver not allowed / account
             mapping missing / tax mapping missing / immutable / invalid source
             document / ingestion failed
EINV-001..004 unsupported format / invalid XML / duplicate external event /
             missing required field
OCR-001..002 extraction unavailable / failed
```
