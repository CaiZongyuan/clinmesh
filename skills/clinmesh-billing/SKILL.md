---
name: clinmesh-billing
description: ClinMesh cashier CLI workflow for reading billable laboratory or medication charges, creating payment previews, confirming success/decline/ambiguous simulator outcomes, and reconciling uncertain Commands.
---

# ClinMesh Billing

Read [`../clinmesh-shared/SKILL.md`](../clinmesh-shared/SKILL.md) first.

Payment uses preview then confirm. Read the pending queue entry, keep the preview ID, commit token, ChargeItem version and each command's idempotency key together, then confirm exactly once. A preview is not payment. An ambiguous confirmation is not decline or failure and must be reconciled before another attempt.

```bash
clinmesh billing queue list --category laboratory --status pending
clinmesh payment preview --input @payment-preview.json --idempotency-key <key>
clinmesh payment confirm --input @payment-confirm.json --idempotency-key <key>
clinmesh command receipt get --operation-id payment.confirm --idempotency-key <key>
```

Payment does not complete the clinical Encounter. A declined result stays distinct from ambiguous. Successful medication payment makes an issued prescription eligible for a pharmacist Grant; successful laboratory payment advances the applicable laboratory workflow. Confirm the queue state before handing off.
