import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import {
  billingCaseSchema, caseLaboratoryCatalogSearchSchema, clinicalDocumentDraftResponseSchema,
  clinicalDocumentSignPreviewResponseSchema, clinicalDocumentSignResponseSchema,
  doctorCaseDetailSchema, doctorCompletedCaseListSchema, doctorQueueSchema,
  encounterCompletionResponseSchema, issueLaboratoryRequestResponseSchema,
  patientSearchSchema, paymentPreviewResponseSchema, paymentResponseSchema,
  registrationCatalogSchema, registrationResponseSchema, sendConsultationMessageResponseSchema,
  startVisitResponseSchema, triageResponseSchema,
} from '@clinmesh/contracts/his'
import { doctorCaseHistoryDetailSchema, doctorCaseHistorySchema } from '@clinmesh/contracts/agent'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { inpatientAngiographyReportsSchema } from '@clinmesh/contracts/inpatient-angiography'
import {
  createPciPaymentDrgFixture, parsePciResponse, preparePciPaymentDrgFixture,
  type PciPaymentDrgFixture,
} from './fixtures/pci-payment-drg.ts'

const fixtures: PciPaymentDrgFixture[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close() })

it('completes a new consultation and exact follow-up investigation after PCI discharge using the same patient and authorized inpatient history', async () => {
  const prepared = await preparePciPaymentDrgFixture()
  let dialogueCalls = 0
  prepared.options.consultationModel = 'synthetic-post-discharge-dialogue'
  prepared.options.chatCompletionsProvider = { completeJson: async input => {
    expect(input.schemaName).toBe('patient_dialogue_reply')
    dialogueCalls += 1
    return { model: input.model, content: JSON.stringify({ reply: '医生您好，我今天按约定来复查。' }) }
  } }
  const fixture = await createPciPaymentDrgFixture(prepared)
  fixtures.push(fixture)
  const stay = await fixture.preparePciAdmission()
  await fixture.completePciLaboratories(stay)
  await fixture.dispensePciMedications(stay, 'preoperative')
  const angiography = await fixture.executeAngiography(stay)
  await fixture.runtime.dispatchPending()
  const angiographyReport = (await fixture.read('inpatient-doctor', `${stay.path}/angiography-reports`, inpatientAngiographyReportsSchema))
    .reports.find(item => item.procedureId === angiography.id)!
  const signedAngiography = await fixture.read('inpatient-doctor', `/fhir/R5/DiagnosticReport/${angiographyReport.id}`, fhirResourceSchema)
  expect(signedAngiography).toMatchObject({ conclusion: expect.stringMatching(/\S/) })
  const surgery = await fixture.executePci(stay)
  await fixture.dispensePostoperativePciAspirin(stay, surgery.id)
  const departed = await fixture.depart(stay)
  expect(departed.status).toBe('departed')

  const patients = await fixture.read('registrar', `/api/his/v1/patients?query=${encodeURIComponent('合成冠脉')}`, patientSearchSchema)
  const patient = patients.items.find(item => item.id === stay.patientId)
  expect(patient).toBeDefined()
  const registration = await fixture.read('registrar', '/api/his/v1/catalogs/registration', registrationCatalogSchema)
  const registrationInput = {
    patientId: stay.patientId, departmentId: registration.departments[0]!.id,
    locationId: registration.locations[0]!.id, visitTypeId: registration.visitTypes[0]!.id,
    visitDate: registration.virtualDate,
  }
  const registered = await parsePciResponse(registrationResponseSchema, await fixture.request('registrar',
    '/api/his/v1/registrations/actions/register', registrationInput, randomUUID(), { [`Patient/${stay.patientId}`]: patient!.versionId }))
  const encounterId = registered.data.encounterId
  expect(encounterId).not.toBe(stay.admissionId)
  expect(registered.data.patientId).toBe(stay.patientId)
  const triaged = await parsePciResponse(triageResponseSchema, await fixture.request('triage',
    `/api/his/v1/encounters/${encounterId}/actions/record-triage`, {
      acuityCode: 'level-3', chiefComplaint: '冠脉介入出院后随访复查',
      bloodPressure: { diastolicMmHg: 80, systolicMmHg: 122 }, oxygenSaturationPct: 98,
      pulseBpm: 72, respirationBpm: 18, temperatureC: 36.7,
    }, randomUUID(), { [`Encounter/${encounterId}`]: '1', [`Task/${registered.data.queueTaskId}`]: '1' }))
  await parsePciResponse(startVisitResponseSchema, await fixture.request('doctor',
    `/api/his/v1/encounters/${encounterId}/actions/start-first-visit`, {}, randomUUID(), {
      [`Encounter/${encounterId}`]: '2', [`Task/${triaged.data.doctorTaskId}`]: '1',
    }))
  const queue = await fixture.read('doctor', '/api/his/v1/doctor/queue', doctorQueueSchema)
  const current = queue.items.find(item => item.encounterId === encounterId)
  expect(current).toBeDefined()
  const caseId = current!.caseId
  const read = () => fixture.read('doctor', `/api/his/v1/doctor/cases/${caseId}`, doctorCaseDetailSchema)
  const post = async (action: string, input: unknown, method = 'POST') => {
    const detail = await read()
    return fixture.runtime.app.request(`/api/his/v1/encounters/${encounterId}/${action}`, {
      method, headers: { cookie: await fixture.login('doctor'), origin: 'http://localhost',
        'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ expectedVersions: {
        [`Encounter/${encounterId}`]: detail.encounter.versionId,
        ...(action === 'actions/ask-consultation-question' ? { [`Task/${detail.taskId}`]: detail.taskVersion } : {}),
      }, input }),
    })
  }
  expect((await read()).consultation).toBeDefined()
  const historyPath = `/api/his/v1/doctor/cases/${caseId}/history`
  const history = await fixture.read('doctor', `${historyPath}?source=local-completed&page=1&pageSize=20`, doctorCaseHistorySchema)
  expect(history.items.map(item => item.entryId)).toContain(`inpatient:${stay.admissionId}`)
  const inpatient = await fixture.read('doctor', `${historyPath}/detail?source=local-completed&entryId=${encodeURIComponent(`inpatient:${stay.admissionId}`)}`, doctorCaseHistoryDetailSchema)
  expect(inpatient).toMatchObject({ source: 'local-completed', record: {
    kind: 'inpatient', admissionId: stay.admissionId,
    diagnoses: expect.arrayContaining([expect.objectContaining({ code: 'I25.103' })]),
    procedures: expect.arrayContaining([expect.objectContaining({ code: '36.0700' })]),
    medications: expect.arrayContaining([expect.objectContaining({ state: 'completed' })]),
    reports: expect.arrayContaining([expect.objectContaining({ findings: expect.arrayContaining([expect.stringContaining('白细胞')]) })]),
  } })
  if (inpatient.source === 'local-completed' && 'kind' in inpatient.record) {
    expect(inpatient.record.procedures).toContainEqual(expect.objectContaining({ code: '88.5500', conclusion: signedAngiography.conclusion }))
  }
  expect(JSON.stringify(inpatient)).not.toMatch(/caseTruth|hiddenResources|source_case_id|rawBundle|assetId/)
  const visible = await fixture.read('doctor', `${historyPath}?source=visible-source&page=1&pageSize=20`, doctorCaseHistorySchema)
  expect(visible.availability).not.toBe('no-materialization')
  expect((await fixture.request('pharmacist', `${historyPath}?source=local-completed`)).status).toBe(403)
  const library = await fixture.read('doctor', '/api/his/v1/doctor/completed-cases', doctorCompletedCaseListSchema)
  expect(library.items.map(item => item.encounterId)).not.toContain(stay.admissionId)

  const beforeDialogue = await read()
  const dialogue = await parsePciResponse(sendConsultationMessageResponseSchema, await post('actions/ask-consultation-question', {
    expectedConsultationVersion: beforeDialogue.consultation!.version, message: '出院后休息得怎么样？',
  }))
  expect(dialogue.data.patientTurn.messageText).toBe('医生您好，我今天按约定来复查。')
  expect(dialogueCalls).toBe(1)
  const catalog = await fixture.read('doctor', `/api/his/v1/doctor/cases/${caseId}/reference-catalogs/laboratory?query=${encodeURIComponent('白细胞')}&page=1&pageSize=20`, caseLaboratoryCatalogSearchSchema)
  const laboratory = catalog.items.find(item => item.referenceConcept?.code === '6690-2')
  expect(laboratory).toBeDefined()
  const saved = await post('laboratory-request/draft', { catalogItemId: laboratory!.id,
    indicationCode: laboratory!.allowedIndicationCodes[0], expectedDraftVersion: 0 }, 'PUT')
  expect(saved.status, await saved.clone().text()).toBe(200)
  const issued = await parsePciResponse(issueLaboratoryRequestResponseSchema,
    await post('laboratory-request/actions/issue', { expectedDraftVersion: 1 }))
  const request = issued.data.request
  expect(request.billing).toBeDefined()
  const billing = await fixture.read('cashier', `/api/his/v1/billing/cases/${caseId}`, billingCaseSchema)
  const charge = billing.charges.find(item => item.chargeItemId === request.billing!.chargeItemId)!
  const versions = { [`ChargeItem/${charge.chargeItemId}`]: String(charge.chargeVersion) }
  const preview = await parsePciResponse(paymentPreviewResponseSchema, await fixture.request('cashier', '/api/his/v1/payments/actions/preview', {
    caseId, category: 'laboratory', chargeItemId: charge.chargeItemId, simulatorRule: 'success',
  }, randomUUID(), versions))
  const paid = await parsePciResponse(paymentResponseSchema, await fixture.request('cashier',
    `/api/his/v1/payments/${preview.data.previewId}/actions/confirm`, { commitToken: preview.data.commitToken }, randomUUID(), versions))
  expect(paid.data.outcome).toBe('success')
  await fixture.runtime.dispatchPending()
  const reported = (await read()).laboratoryRequests!.requests.find(item => item.id === request.id)!
  expect(reported.status, JSON.stringify(reported.generationError)).toBe('reported')
  expect(reported.report!.results.find(item => item.code === '6690-2')?.value).toBe(6.2)
  const acknowledged = await fixture.request('doctor', `/api/his/v1/laboratory-requests/${reported.id}/reports/${reported.report!.diagnosticReportId}/actions/acknowledge`, {
    expectedRequestVersion: reported.version,
  }, randomUUID(), { [`DiagnosticReport/${reported.report!.diagnosticReportId}`]: reported.report!.diagnosticReportVersion })
  expect(acknowledged.status, await acknowledged.clone().text()).toBe(200)

  expect((await post('diagnosis/draft', { expectedDraftVersion: 0,
    entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary' }] }, 'PUT')).status).toBe(200)
  expect((await post('diagnosis/actions/confirm', { expectedDraftVersion: 1 })).status).toBe(200)
  expect((await post('medication-conclusion/actions/confirm-no-medication', { expectedDraftVersion: 0 })).status).toBe(200)
  const document = {
    chiefComplaint: '冠脉介入出院后复查。', historyOfPresentIllness: '患者按约定返院复查，已核对本院住院摘要。',
    physicalExamination: '生命体征平稳，未见急性异常。', assessment: '已核对住院治疗及本次血常规报告。',
    disposition: '继续原出院安排。', followUp: '按约定复查，出现胸痛立即就医。',
  }
  const draft = await parsePciResponse(clinicalDocumentDraftResponseSchema,
    await post('clinical-document/draft', { document, expectedDraftVersion: 0 }, 'PUT'))
  const sign = await parsePciResponse(clinicalDocumentSignPreviewResponseSchema,
    await post('clinical-document/actions/preview-sign', { expectedDraftVersion: draft.data.draftVersion }))
  await parsePciResponse(clinicalDocumentSignResponseSchema, await post('clinical-document/actions/sign', {
    previewId: sign.data.previewId, commitToken: sign.data.commitToken,
  }))
  const completed = await parsePciResponse(encounterCompletionResponseSchema, await post('actions/complete', {}))
  expect(completed.data.status).toBe('completed')
  expect((await read()).patient.id).toBe(stay.patientId)
  expect(dialogueCalls).toBe(1)
}, 120_000)
