# Doctor Clinical Workflows

## Consultation and diagnosis

Ask only a `questionCode` returned by the current case. Each answer appends a Consultation Record and advances its version. Case Truth is not a query surface; derive conclusions only from visible source history, triage, Consultation Records and signed results. Save diagnosis entries as a draft, then confirm only after exactly one entry is primary. A later draft and confirmation creates a new linear diagnosis revision and invalidates the superseded Conditions; re-read the case before using the diagnosis downstream.

## Laboratory and services

Search the case-scoped laboratory catalog and require a supported result-generation capability before selecting a Reference item. The global reference catalog defines concepts but cannot prove that the current case can produce a result. When the case query has no Reference items, use the hospital clinical catalog as the local fallback; an explicit unsupported capability cannot be bypassed this way. Save one laboratory request draft and issue it only from its current version. Payment and LIS processing belong to downstream actors. A failed Investigation generation may be retried through its explicit command. The responsible doctor acknowledges the latest final report; an administrator uses a separate Grant for the controlled correction command, which the server binds to `lis-system`.

Hospital Service order and completion are separate high-risk Commands and create normal ServiceRequest, Task, and ChargeItem facts.

## Medication

A prescription draft is not a MedicationRequest. Issue it only after diagnosis confirmation and catalog validation. Confirming no medication is an alternative formal conclusion. A signed prescription may be withdrawn only before dispensing begins.

## Clinical document and completion

Save the structured document draft, create a version-bound signing preview, and sign from that preview. A signed document is immutable; correction creates a new revision.

Encounter Completion is independent of document signing, payment, dispensing, and Scenario Run completion. Read the completion preview and resolve every incomplete condition before submitting the completion Command.
