---
name: clinmesh-registration
description: ClinMesh registrar CLI workflows for finding or creating synthetic patients, registering outpatient visits, and starting a ready Synthetic Case Instance. Use for registrar work and the registration-to-triage handoff.
---

# ClinMesh Registration

Read [`../clinmesh-shared/SKILL.md`](../clinmesh-shared/SKILL.md) first.

Start with the registration catalog, then search by the strongest available synthetic identifier before creating a Patient Identity. A new patient and a new Registration are separate intents with separate idempotency keys. Use the returned Patient and Encounter versions rather than inventing them.

```bash
clinmesh catalog registration get
clinmesh patient search --query <name-or-identifier>
clinmesh patient create --input @patient.json --idempotency-key <key>
clinmesh registration create --input @registration.json --idempotency-key <key>
clinmesh registration list
```

For a generated case with an active successful Patient Brief, start the normal outpatient flow directly. Do not use the retired Virtual Patient or Scenario Dataset entrypoints.

```bash
clinmesh registration synthetic-case start --input @case-start.json --idempotency-key <key>
```

The ordinary and Synthetic Case paths converge on the same Registration, Encounter, and triage Queue Task. Registration work is complete only when `registration list` returns those references; hand them to a triage-nurse Grant and stop acting as registrar.
