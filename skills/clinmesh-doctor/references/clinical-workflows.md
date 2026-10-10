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

Save the structured document draft, create a version-bound signing preview, and sign from that preview. A signed document is immutable; correction creates a new revision.

Read the preview's `consultationReview` before signing: `remainingCount` includes processing, failed and paused omissions; `conflictCount` and `unreviewedCount` identify unfinished history review. Compare the frozen document with the saved Consultation Record. Only after human review may the commit input include `consultationReviewed: true`; this does not bypass required fields, responsibility, versions or the preview lifetime. A changed Consultation invalidates the preview even after acknowledgement.

These review requirements apply even without automatic recording: the preview still binds the Consultation version, and patient text not recorded automatically counts as unfinished. Use structured document signing for every case with a Consultation; combined legacy signing previews and commits return `WORKFLOW_CONFLICT`, including previously issued legacy tokens. An unconsumed structured preparation remains visible through `consultationRecording.signingPreparation` even when recording is unavailable; cancellation releases it without starting unavailable extraction.

Preparation freezes automatic writes and invalidates in-flight extraction. Use `encounter clinical-document sign cancel` with `encounterId`, the current `encounterVersion` and `previewId` to return to review or retry. It also cancels expired previews and preparations recovered through `consultationRecording.signingPreparation` after reconnect. Cancellation preserves explicit pauses and failures: resume paused recording or retry a failed head through the recording control. On a failed or ambiguous commit, first recover its original receipt and reread the case; cancel only an unsigned preparation. Never treat a closed browser dialog as server cancellation.

Encounter Completion is independent of document signing, payment, dispensing, and Scenario Run completion. Read the completion preview and resolve every incomplete condition before submitting the completion Command.
