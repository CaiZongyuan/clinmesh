---
name: clinmesh-billing
description: ClinMesh cashier CLI workflow for reading unified bills, previewing combined or partial payments, confirming laboratory or medication charges, and recovering recorded ambiguous payment attempts.
---

# ClinMesh Billing

Read [`../clinmesh-shared/SKILL.md`](../clinmesh-shared/SKILL.md) first.

Read the queue, then the selected case's unified bill. The bill includes registration, laboratory and medication charges, their paid and remaining amounts, and payment attempts with their current versions. Registration charges remain unpaid and read-only in this workflow.

Payment uses preview then confirm. Optional `tenders` combine `cash`, `bank-card` and `mobile` amounts in positive integer fen; omitted tenders use the default full remaining amount. Keep the preview ID, commit token, ChargeItem version and each command's idempotency key together. Confirm freezes the previewed tenders. A successful partial payment leaves a balance; only a fully paid charge advances clinical fulfillment.

```bash
clinmesh billing queue list --category laboratory --status pending
clinmesh billing case get --case-id <case-id>
clinmesh operations schema payment.preview
clinmesh payment preview --input @payment-preview.json --idempotency-key <key>
clinmesh payment confirm --input @payment-confirm.json --idempotency-key <key>
clinmesh command receipt get --operation-id payment.confirm --idempotency-key <key>
```

If the response is lost or the CLI reports `ambiguous_outcome`, read the original Command receipt with the original operation ID and key first. A completed confirm receipt can itself report a recorded ambiguous payment: that receipt proves the payment attempt exists, not that the channel collected funds.

For a recorded ambiguous payment, read the latest bill and recover that existing `paymentId`, binding its `expectedPaymentVersion` and current ChargeItem version. Recovery queries the channel without collecting again. Simulator `ambiguous` resolves to success, `ambiguous-decline` resolves to declined, and `ambiguous-pending` remains ambiguous. Pending stays blocked for new payment; a definite decline permits a fresh preview. When a recovery response is lost, inspect its receipt with the recovery key before another query.

```bash
clinmesh billing queue list --category laboratory --status ambiguous
clinmesh billing case get --case-id <case-id>
clinmesh operations schema payment.recover
clinmesh payment recover --input @payment-recover.json --idempotency-key <recovery-key>
clinmesh command receipt get --operation-id payment.recover --idempotency-key <recovery-key>
```

Payment does not complete the clinical Encounter. Confirm the bill's remaining amounts and queue state before handing off a fully paid medication charge to a pharmacist Grant or continuing the applicable laboratory workflow.
