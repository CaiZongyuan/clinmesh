# Doctor Clinical Workflows

## Consultation and diagnosis

Submit free-text `message` with the current Encounter, doctor Task and Consultation versions. The doctor message is saved before patient generation; each text reply is frozen. Report cards carry formal report references and do not count as text replies. After a timeout or ambiguous outcome, query the original Command receipt and refresh the case. An `executing` receipt proves acceptance, not an answered turn. If the last text turn is still the doctor’s, use `encounter.consultation.reply.retry` with the refreshed Consultation version and a new retry intent key; repeat that retry with the same key and identical payload only. Never resend the doctor message as a new intent. Completed Encounters and legacy question-topic personas are read-only. Case Truth is not a query surface; derive conclusions only from visible source history, triage, Consultation Records and signed results. Save diagnosis entries as a draft, then confirm only after exactly one entry is primary. A later draft and confirmation creates a new linear diagnosis revision and invalidates the superseded Conditions; re-read the case before using the diagnosis downstream.

## Laboratory and services

Search the case-scoped laboratory catalog and select one active Hospital Laboratory Service. The global Reference catalog defines terminology and cannot be submitted as a Clinical Request. Save one laboratory request draft and issue it only from its current version; the server freezes the service and report definition. Payment and LIS processing belong to downstream actors. A failed Investigation generation may be retried through its explicit command. The responsible doctor acknowledges the latest final report; an administrator uses a separate Grant for the controlled correction command, which the server binds to `lis-system`.

Hospital Service order and completion are separate high-risk Commands and create normal ServiceRequest, Task, and ChargeItem facts.

## Medication

A prescription draft is not a MedicationRequest. Issue it only after diagnosis confirmation and catalog validation. Confirming no medication is an alternative formal conclusion. A signed prescription may be withdrawn only before dispensing begins.

## Clinical document and completion

Save the structured document draft, create a version-bound signing preview, and sign from that preview. A signed document is immutable; correction creates a new revision.

Encounter Completion is independent of document signing, payment, dispensing, and Scenario Run completion. Read the completion preview and resolve every incomplete condition before submitting the completion Command.
