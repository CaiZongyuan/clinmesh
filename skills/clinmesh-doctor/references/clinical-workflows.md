# Doctor Clinical Workflows

## Consultation and diagnosis

A new manual reply retry binds the current ClinMesh model settings; retransmitting the same retry intent keeps its resolved model. In-flight generation and internal output repair keep their model, and completed replies are reused. For `AI_AUTH_FAILED`, check model credentials or access; for `AI_REQUEST_FAILED` or `AI_TIMEOUT`, check availability or change the ClinMesh model before starting a new retry intent.

Submit free-text `message` with the current Encounter, doctor Task and Consultation versions. The doctor message is saved before patient generation; each text reply is frozen. Report cards carry formal report references and do not count as text replies. After a timeout or ambiguous outcome, query the original Command receipt and refresh the case. An `executing` receipt proves acceptance, not an answered turn. If the last text turn is still the doctor’s, use `encounter.consultation.reply.retry` with the refreshed Consultation version and a new retry intent key; repeat that retry with the same key and identical payload only. Never resend the doctor message as a new intent. Completed Encounters and legacy question-topic personas are read-only. Case Truth is not a query surface; derive conclusions only from visible source history, triage, Consultation Records and signed results. Save diagnosis entries as a draft, then confirm only after exactly one entry is primary. A later draft and confirmation creates a new linear diagnosis revision and invalidates the superseded Conditions; re-read the case before using the diagnosis downstream.

## Laboratory and services

Search the case-scoped laboratory catalog and select one active Hospital Laboratory Service. The global Reference catalog defines terminology and cannot be submitted as a Clinical Request. Save one laboratory request draft and issue it only from its current version; the server freezes the service and report definition. Payment and LIS processing belong to downstream actors. A failed Investigation generation may be retried through its explicit command: a new manual attempt binds the current ClinMesh model when generation starts, and its automatic retries and restart recovery keep that model. The responsible doctor acknowledges the latest final report; an administrator uses a separate Grant for the controlled correction command, which the server binds to `lis-system`.

Hospital Service order and completion are separate high-risk Commands and create normal ServiceRequest, Task, and ChargeItem facts.

## Medication

A prescription draft is not a MedicationRequest. Issue it only after diagnosis confirmation and catalog validation. Confirming no medication is an alternative formal conclusion. A signed prescription may be withdrawn only before dispensing begins.

## Clinical document and completion

Patient answers, proven doctor supplements and published report text are recorded directly across ten document fields after source and semantic validation. Read the latest draft and source-linked entries; no doctor acknowledgement or suggestion application is required. Save explicit text edits with the current version, preserving other fields. Create a complete version-bound document preview and sign from it; correction of a signed document creates a new revision. Signing never completes the Encounter.

Preparation fixes the document and the Consultation or source snapshot, including doctor-only cases without a Consultation, and invalidates in-flight recording. A changed Consultation or source snapshot requires cancellation and a new preview. Cancel with the current Encounter version and previewId to return to editing. A recovered or expired preparation remains visible through consultationRecording.signingPreparation, even without automatic recording. Cancellation preserves explicit pauses and failures; use the recording control to resume or retry. On an ambiguous commit recover the original receipt and reread the case before cancelling an unsigned preparation. Formal signing and Agent high-risk proposal approval keep their existing authorization.

Encounter Completion is independent of document signing, payment, dispensing, and Scenario Run completion. Read the completion preview and resolve every incomplete condition before submitting the completion Command.
