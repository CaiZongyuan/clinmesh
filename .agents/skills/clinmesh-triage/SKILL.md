---
name: clinmesh-triage
description: ClinMesh triage CLI workflow for reading the triage queue and recording structured acuity, complaint, and vital signs before handing an Encounter to the doctor queue.
---

# ClinMesh Triage

Read [`../clinmesh-shared/SKILL.md`](../clinmesh-shared/SKILL.md) first.

Take Encounter and Task versions from the current pending queue item. Record one structured triage intent with those exact versions; a conflict means the queue item changed and must be read again. Do not infer vitals or acuity from a diagnosis that has not been established.

```bash
clinmesh triage queue list --status pending
clinmesh operations schema triage.record
clinmesh triage record --input @triage.json --idempotency-key <key>
```

Success creates structured vital-sign Observations and moves work to the doctor queue. Confirm the item leaves the pending triage queue, hand the Encounter to an outpatient-doctor Grant, and stop. Triage does not diagnose, order treatment, or complete the Encounter.
