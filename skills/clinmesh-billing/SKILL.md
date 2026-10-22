---
name: clinmesh-billing
description: ClinMesh cashier CLI workflow for reading bills, collecting combined or partial payments, correcting fees, refunding original transactions, and recovering unknown payment or refund attempts.
---

# ClinMesh Billing

Read [`../clinmesh-shared/SKILL.md`](../clinmesh-shared/SKILL.md) first.

Read the queue, then the selected case's unified bill. The bill includes registration, laboratory and medication charges, their paid and remaining amounts, and payment attempts with their current versions. Registration charges remain unpaid and read-only in this workflow.

`billing.case.get` returns complete bill balances and one page of `payments`, newest first by creation time and payment ID. Use `paymentsPagination` (`page`, `pageSize`, `total`) to request further pages; the default page size is 20 and the hard maximum is 100. A missing attempt on one page does not mean it never existed. Find the original unknown attempt before recovery; never replace it with a new collection. The Surface bill read accepts `page` and displays that history page for human review.

Payment uses preview then confirm. Optional `tenders` combine `cash`, `bank-card` and `mobile` amounts in positive integer fen; omitted tenders use the default full remaining amount. Keep the preview ID, commit token, ChargeItem version and each command's idempotency key together. Confirm freezes the previewed tenders. A successful partial payment leaves a balance; only a fully paid charge advances clinical fulfillment.

```bash
clinmesh billing queue list --category laboratory --status pending
clinmesh billing case get --case-id <case-id> --page 1 --page-size 20
clinmesh billing case get --case-id <case-id> --page 2 --page-size 20
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

## Fee corrections and original-payment refunds

Read `billing.refunds.get` before correcting fees or refunding. Each successful source reports its `version`, `refundedFen`, `reservedFen` and `refundableFen`. The current bill subtracts recorded fee corrections from receivables and successful refunds from collections; original charges, payment attempts and clinical execution remain in their original history.

`billing.charge.adjust` records a positive integer fen reduction with the original ChargeItem version and a specific financial-error reason. It creates refund allowance but sends no money. Refund only an original successful payment, bounded by both its remaining funds and the unconsumed correction allowance across every original payment for that charge. Refunds consume the original frozen tender order and remaining amount per method; do not choose a new refund method. Unknown refunds reserve these amounts; definite decline releases the reservation.

```bash
clinmesh billing refunds get --case-id <case-id>
clinmesh billing charge adjust --input @charge-adjustment.json --idempotency-key <adjustment-key>
clinmesh refund preview --input @refund-preview.json --idempotency-key <refund-preview-key>
clinmesh refund confirm --input @refund-confirm.json --idempotency-key <refund-confirm-key>
clinmesh command receipt get --operation-id refund.confirm --idempotency-key <refund-confirm-key>
clinmesh refund recover --input @refund-recover.json --idempotency-key <refund-recovery-key>
clinmesh command receipt get --operation-id refund.recover --idempotency-key <refund-recovery-key>
```

Preview input binds `paymentId`, `amountFen`, `expectedSourceVersion`, `chargeItemId`, `chargeVersion` and `simulatorRule`; confirm preserves its `previewId`, `commitToken` and original ChargeItem version. Query recovery uses the original `refundId`, `expectedRefundVersion` and latest ChargeItem version. Never supply an outcome to recovery or replace an unknown refund with a fresh refund. After response loss inspect the original Command receipt and reuse the original key and payload. A stale preview requires explicit review of a new preview. These outpatient operations require an active Scenario Run; they do not authorize post-settlement or archived-account correction.

Payment does not complete the clinical Encounter. Confirm the bill's remaining amounts and queue state before handing off a fully paid medication charge to a pharmacist Grant or continuing the applicable laboratory workflow.
