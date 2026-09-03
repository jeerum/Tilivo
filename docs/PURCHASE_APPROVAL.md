# Purchase approval

- `review` viib NEEDS_REVIEW/DRAFT/INGESTED -> READY_FOR_APPROVAL ja nõuab
  tarnija snapshoti.
- `approve` nõuab `purchase.approve`; kui `require_separate_approver=true`,
  ei saa looja ise kinnitada.
- `post` nõuab `purchase.post`; `auto_post_on_approval` käivitab sama
  transactioni sees postituse (vajab ka `purchase.post` õigust).
- `reject` on lubatud NEEDS_REVIEW/READY_FOR_APPROVAL olekutest.

Kinnituste ajalugu on append-only (`purchase_invoice_approvals`) ja audit
hash-chain'i kaudu.
