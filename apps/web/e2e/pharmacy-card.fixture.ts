import { randomUUID } from 'node:crypto'
import { expect, type Page } from '@playwright/test'
import { z } from 'zod'
import {
  billingQueueSchema, clinicalDocumentDraftResponseSchema, clinicalDocumentSignPreviewResponseSchema, clinicalDocumentSignResponseSchema,
  confirmDiagnosisResponseSchema, diagnosisDraftResponseSchema, encounterCompletionResponseSchema, issuePrescriptionResponseSchema,
  paymentPreviewResponseSchema, paymentResponseSchema, pharmacyQueueSchema, prescriptionDraftResponseSchema, startVisitResponseSchema,
} from '@clinmesh/contracts/his'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'

/** Synthetic providers only; clinical, payment and pharmacy prerequisites use public HTTP. */
export async function startPharmacyCardServer(page: Page, webRoot: string) {
  const server = await startBrowserServer(webRoot, {
    patientPersonaModel: 'synthetic-persona', syntheaProvider: new StubSyntheaProvider(),
    chatCompletionsProvider: { async completeJson(input) {
      if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic-pharmacy' }
      if (input.schemaName === 'clinical_document_quality' || input.schemaName === 'clinical_document_quality_verification') {
        const payload = z.object({ agentFacts: z.array(z.object({ id: z.string() })), issues: z.array(z.unknown()).optional() }).parse(input.userPayload)
        return { content: JSON.stringify({ issues: input.schemaName === 'clinical_document_quality_verification'
          ? (payload.issues ?? []).map((_, index) => ({ index, supported: true })) : [],
          agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: true })) }), model: 'synthetic-pharmacy-quality' }
      }
      throw new Error(`Unexpected synthetic schema: ${input.schemaName}`)
    } },
  })
  try {
    const started = await startConsultationCase(server.runtime, server.password, server.origin)
    const signIn = async (role: string) => {
      const response = await page.request.post(`${server.origin}/api/auth/sign-in/email`, {
        headers: { origin: server.origin }, data: { email: `${role}@demo.clinmesh.local`, password: server.password },
      })
      expect(response.status()).toBe(200)
    }
    let encounterVersion = started.encounterVersion
    const encounter = `Encounter/${started.encounterId}`
    const path = `/api/his/v1/encounters/${started.encounterId}`
    const command = async (target: string, input: object, expectedVersions: Record<string, string> = { [encounter]: encounterVersion }, method = 'POST') => {
      const response = await page.request.fetch(`${server.origin}${target}`, { method,
        headers: { origin: server.origin, 'idempotency-key': randomUUID() }, data: { expectedVersions, input } })
      expect(response.status(), target).toBe(200)
      return response.json()
    }
    await signIn('doctor')
    const visit = startVisitResponseSchema.parse(await command(`${path}/actions/start-first-visit`, {}, { [encounter]: encounterVersion, [`Task/${started.doctorTaskId}`]: '1' })).data
    encounterVersion = visit.encounterVersion
    const draft = clinicalDocumentDraftResponseSchema.parse(await command(`${path}/clinical-document/draft`, { expectedDraftVersion: 0, document: {
      assessment: '合成流感诊断依据完整。', chiefComplaint: '合成发热伴咽痛一天。', disposition: '门诊口服抗病毒治疗。',
      followUp: '持续高热或气促时立即复诊。', historyOfPresentIllness: '一天前发热伴咽痛，无呼吸困难。', physicalExamination: '神志清楚，咽部充血，双肺呼吸音清。',
    } }, undefined, 'PUT')).data
    const documentPreview = clinicalDocumentSignPreviewResponseSchema.parse(await command(`${path}/clinical-document/actions/preview-sign`, { expectedDraftVersion: draft.draftVersion })).data
    clinicalDocumentSignResponseSchema.parse(await command(`${path}/clinical-document/actions/sign`, { previewId: documentPreview.previewId, commitToken: documentPreview.commitToken }))
    const diagnosis = diagnosisDraftResponseSchema.parse(await command(`${path}/diagnosis/draft`, { entries: [{ catalogItemId: 'diagnosis-influenza', role: 'primary' }], expectedDraftVersion: 0 }, undefined, 'PUT')).data
    encounterVersion = confirmDiagnosisResponseSchema.parse(await command(`${path}/diagnosis/actions/confirm`, { expectedDraftVersion: diagnosis.draftVersion })).data.encounterVersion
    const medication = prescriptionDraftResponseSchema.parse(await command(`${path}/prescription/draft`, { expectedDraftVersion: 0,
      items: [{ catalogItemId: 'medication-oseltamivir', courseDays: 5, doseText: '75 mg', frequencyCode: 'BID', quantity: 10 }] }, undefined, 'PUT')).data
    const prescription = issuePrescriptionResponseSchema.parse(await command(`${path}/prescription/actions/issue`, { expectedDraftVersion: medication.draftVersion })).data.prescription
    encounterVersion = encounterCompletionResponseSchema.parse(await command(`${path}/actions/complete`, {})).data.encounterVersion
    await signIn('cashier')
    const bill = billingQueueSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/billing/queue?category=medication&status=pending`)).json()).items.find(item => item.caseId === started.outpatientCaseId)!
    const preview = paymentPreviewResponseSchema.parse(await command('/api/his/v1/payments/actions/preview', { caseId: started.outpatientCaseId, category: 'medication', simulatorRule: 'success' }, { [`ChargeItem/${bill.chargeItemId}`]: String(bill.chargeVersion) })).data
    paymentResponseSchema.parse(await command(`/api/his/v1/payments/${preview.previewId}/actions/confirm`, { commitToken: preview.commitToken }, { [`ChargeItem/${preview.chargeItemId}`]: String(preview.chargeVersion) }))
    await signIn('pharmacist')
    const item = pharmacyQueueSchema.parse(await (await page.request.get(`${server.origin}/api/his/v1/pharmacy/queue?status=pending`)).json()).items.find(item => item.prescriptionId === prescription.id)
    if (item === undefined) throw new Error('The synthetic prescription is not available for pharmacy')
    return { ...server, item }
  } catch (error) { await server.close(); throw error }
}
