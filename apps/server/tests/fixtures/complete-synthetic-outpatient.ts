import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { z } from 'zod'
import {
  clinicalDocumentDraftResponseSchema, clinicalDocumentSignPreviewResponseSchema, clinicalDocumentSignResponseSchema,
  diagnosisDraftResponseSchema, confirmDiagnosisResponseSchema, prescriptionDraftResponseSchema, issuePrescriptionResponseSchema,
  encounterCompletionPreviewSchema, encounterCompletionResponseSchema, billingQueueSchema, paymentPreviewResponseSchema, paymentResponseSchema,
  pharmacyQueueSchema, prescriptionReviewResponseSchema, dispenseResponseSchema,
} from '@clinmesh/contracts/his'
import type { createClinMeshRuntime } from '../../src/runtime.ts'
import type { JsonChatCompletionInput, JsonChatCompletionsProvider } from '../../src/infrastructure/ai/openai-chat-completions.ts'
import { persona, signIn, startConsultationCase } from './consultation.ts'

/** Only synthetic model output; every clinical and money transition below uses public HTTP. */
export class FinancialAcceptanceProvider implements JsonChatCompletionsProvider {
  async completeJson(input: JsonChatCompletionInput) {
    if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic-financial-persona' }
    if (input.schemaName === 'clinical_document_quality' || input.schemaName === 'clinical_document_quality_verification') {
      const payload = z.object({ agentFacts: z.array(z.object({ id: z.string() })), issues: z.array(z.unknown()).optional() }).parse(input.userPayload)
      return { content: JSON.stringify({ issues: input.schemaName === 'clinical_document_quality_verification' ? (payload.issues ?? []).map((_, index) => ({ index, supported: true })) : [],
        agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })) }), model: 'synthetic-financial-quality' }
    }
    throw new Error(`Unexpected synthetic model request: ${input.schemaName}`)
  }
}

export async function completeSyntheticOutpatient(runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>, password: string) {
  const started = await startConsultationCase(runtime, password)
  const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local', password)
  const cashier = await signIn(runtime, 'cashier@demo.clinmesh.local', password)
  const pharmacist = await signIn(runtime, 'pharmacist@demo.clinmesh.local', password)
  const reference = `Encounter/${started.encounterId}`
  let encounterVersion = started.encounterVersion
  async function command(cookie: string, path: string, input: unknown, expectedVersions: Record<string, string> = { [reference]: encounterVersion }, method = 'POST') {
    const response = await runtime.app.request(path, { method, headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ expectedVersions, input }) })
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
    return response
  }
  const encounterPath = `/api/his/v1/encounters/${started.encounterId}`
  const firstVisit = await command(doctor, `${encounterPath}/actions/start-first-visit`, {}, { [reference]: encounterVersion, [`Task/${started.doctorTaskId}`]: '1' })
  encounterVersion = z.object({ data: z.object({ encounterVersion: z.string() }) }).parse(await firstVisit.json()).data.encounterVersion
  const document = { assessment: '合成流感门诊诊断依据完整。', chiefComplaint: '合成发热伴咽痛一天。', disposition: '门诊口服抗病毒治疗。',
    followUp: '持续高热或出现气促时立即复诊。', historyOfPresentIllness: '一天前开始发热伴咽痛，无呼吸困难。', physicalExamination: '神志清楚，咽部充血，双肺呼吸音清。' }
  const draft = clinicalDocumentDraftResponseSchema.parse(await (await command(doctor, `${encounterPath}/clinical-document/draft`, { document, expectedDraftVersion: 0 }, undefined, 'PUT')).json()).data
  const documentPreview = clinicalDocumentSignPreviewResponseSchema.parse(await (await command(doctor, `${encounterPath}/clinical-document/actions/preview-sign`, { expectedDraftVersion: draft.draftVersion })).json()).data
  clinicalDocumentSignResponseSchema.parse(await (await command(doctor, `${encounterPath}/clinical-document/actions/sign`, { previewId: documentPreview.previewId, commitToken: documentPreview.commitToken })).json())
  const diagnosis = diagnosisDraftResponseSchema.parse(await (await command(doctor, `${encounterPath}/diagnosis/draft`, {
    entries: [{ catalogItemId: 'diagnosis-influenza', role: 'primary' }], expectedDraftVersion: 0 }, undefined, 'PUT')).json()).data
  encounterVersion = confirmDiagnosisResponseSchema.parse(await (await command(doctor, `${encounterPath}/diagnosis/actions/confirm`, { expectedDraftVersion: diagnosis.draftVersion })).json()).data.encounterVersion
  const prescriptionDraft = prescriptionDraftResponseSchema.parse(await (await command(doctor, `${encounterPath}/prescription/draft`, { expectedDraftVersion: 0,
    items: [{ catalogItemId: 'medication-oseltamivir', courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', quantity: 10 }] }, undefined, 'PUT')).json()).data
  const prescription = issuePrescriptionResponseSchema.parse(await (await command(doctor, `${encounterPath}/prescription/actions/issue`, { expectedDraftVersion: prescriptionDraft.draftVersion })).json()).data.prescription
  const completion = await runtime.app.request(`${encounterPath}/completion`, { headers: { cookie: doctor } })
  expect(completion.status).toBe(200)
  expect(encounterCompletionPreviewSchema.parse(await completion.json()).canComplete).toBe(true)
  encounterVersion = encounterCompletionResponseSchema.parse(await (await command(doctor, `${encounterPath}/actions/complete`, {})).json()).data.encounterVersion
  const bill = billingQueueSchema.parse(await (await runtime.app.request('/api/his/v1/billing/queue?category=medication&status=pending&pageSize=20', { headers: { cookie: cashier } })).json())
    .items.find(item => item.caseId === started.outpatientCaseId)!
  expect(bill).toBeDefined()
  const paymentPreview = paymentPreviewResponseSchema.parse(await (await command(cashier, '/api/his/v1/payments/actions/preview', {
    caseId: started.outpatientCaseId, category: 'medication', simulatorRule: 'success' }, { [`ChargeItem/${bill.chargeItemId}`]: String(bill.chargeVersion) })).json()).data
  paymentResponseSchema.parse(await (await command(cashier, `/api/his/v1/payments/${paymentPreview.previewId}/actions/confirm`, { commitToken: paymentPreview.commitToken },
    { [`ChargeItem/${paymentPreview.chargeItemId}`]: String(paymentPreview.chargeVersion) })).json())
  const queue = pharmacyQueueSchema.parse(await (await runtime.app.request('/api/his/v1/pharmacy/queue?status=pending&pageSize=20', { headers: { cookie: pharmacist } })).json())
  const item = queue.items.find(candidate => candidate.prescriptionId === prescription.id)!
  expect(item).toBeDefined()
  const expectedVersions = { [reference]: encounterVersion, ...Object.fromEntries(item.medications.map(medication => [`MedicationRequest/${medication.medicationRequestId}`, medication.medicationRequestVersion])) }
  const reviewed = prescriptionReviewResponseSchema.parse(await (await command(pharmacist, `/api/his/v1/prescriptions/${item.prescriptionId}/actions/review`, {
    expectedPrescriptionVersion: item.prescriptionVersion, note: '合成公共流程处方审核通过。' }, expectedVersions)).json()).data
  const lotSelections = item.medications.map(medication => {
    const lot = medication.lots.find(candidate => candidate.quantityOnHand >= medication.remainingQuantity)!
    expect(lot).toBeDefined()
    return { expectedVersion: lot.version, lotId: lot.id, quantity: medication.remainingQuantity }
  })
  const dispensed = await command(pharmacist, `/api/his/v1/prescriptions/${item.prescriptionId}/actions/dispense`, {
    expectedPrescriptionVersion: reviewed.prescriptionVersion, lotSelections }, expectedVersions)
  return dispenseResponseSchema.parse(await dispensed.json()).data
}
