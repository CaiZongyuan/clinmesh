---
name: clinmesh-pharmacy
description: ClinMesh pharmacist CLI workflow for reading the pharmacy queue, reviewing signed and paid prescriptions, selecting versioned inventory lots, and recording Dispense facts.
---

# ClinMesh Pharmacy

Read [`../clinmesh-shared/SKILL.md`](../clinmesh-shared/SKILL.md) first.

Review and dispense are separate high-risk Commands. Read current Prescription, Encounter, MedicationRequest and Inventory Lot versions from the queue before each action. Review only signed and paid prescriptions; dispense only an approved prescription with explicit lot selections and sufficient current quantity.

```bash
clinmesh pharmacy queue list --status pending
clinmesh prescription review --input @review.json --idempotency-key <key>
clinmesh prescription dispense --input @dispense.json --idempotency-key <key>
```

Dispense records the selected lots and quantities. It does not rewrite the original prescription or imply Administration. Re-read the pharmacy queue after a partial dispense and use new versions for the next intent. Completing all lines may complete the Scenario Run but does not complete the Encounter.
