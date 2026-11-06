import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'
import {
  apiErrorSchema,
  billingCaseSchema,
  billingQueueSchema,
  clinicalCatalogSchema,
  clinicalDocumentDraftResponseSchema,
  clinicalDocumentSignPreviewResponseSchema,
  clinicalDocumentSignResponseSchema,
  confirmDiagnosisResponseSchema,
  confirmNoMedicationResponseSchema,
  diagnosisDraftResponseSchema,
  doctorCaseDetailSchema,
  encounterCompletionPreviewSchema,
  encounterCompletionResponseSchema,
  issuePrescriptionResponseSchema,
  pharmacyQueueSchema,
  prescriptionDraftResponseSchema,
  withdrawPrescriptionResponseSchema,
} from '@clinmesh/contracts/his'
import { confirmDoctorPreparationResponseSchema } from '@clinmesh/contracts/doctor-recommendations'
import { referenceMedicationCatalogSearchSchema } from '@clinmesh/contracts/reference-data'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { completeSyntheticOutpatient, FinancialAcceptanceProvider } from './fixtures/complete-synthetic-outpatient.ts'
import { signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'

describe('Outpatient prescription catalog split, reason codes, and external prescription loop', () => {
  const runtimes: Array<Awaited<ReturnType<typeof createClinMeshRuntime>>> = []
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
  })

  async function setupRuntime() {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-outpatient-rx-catalog-'))
    temporaryDirectories.push(directory)
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      chatCompletionsProvider: new FinancialAcceptanceProvider(),
      consultationModel: 'fake-consultation-model',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      investigationModel: 'fake-investigation-model',
      migrationMode: 'apply',
      patientPersonaModel: 'fake-persona-model',
      syntheaProvider: new StubSyntheaProvider(),
      trustedOrigins: ['http://localhost'],
    })
    runtimes.push(runtime)
    return { password, runtime }
  }

  function commandHeaders(cookie: string) {
    return {
      'content-type': 'application/json',
      cookie,
      'idempotency-key': randomUUID(),
      origin: 'http://localhost',
    }
  }

  async function startActiveVisit(
    runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
    password: string,
    options: { includeBillingRoles?: boolean } = {},
  ) {
    const started = await startConsultationCase(runtime, password)
    const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local', password)
    const cashier = options.includeBillingRoles
      ? await signIn(runtime, 'cashier@demo.clinmesh.local', password)
      : ''
    const pharmacist = options.includeBillingRoles
      ? await signIn(runtime, 'pharmacist@demo.clinmesh.local', password)
      : ''
    const encounterRef = `Encounter/${started.encounterId}`
    const firstVisit = await runtime.app.request(
      `/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`,
      {
        body: JSON.stringify({
          expectedVersions: {
            [encounterRef]: started.encounterVersion,
            [`Task/${started.doctorTaskId}`]: '1',
          },
          input: {},
        }),
        headers: commandHeaders(doctor),
        method: 'POST',
      },
    )
    expect(firstVisit.status).toBe(200)
    const parsed = z.object({
      data: z.object({ encounterVersion: z.string(), patientId: z.string().optional() }),
    }).parse(await firstVisit.json())
    const detail = doctorCaseDetailSchema.parse(
      await (await runtime.app.request(`/api/his/v1/doctor/cases/${started.outpatientCaseId}`, {
        headers: { cookie: doctor },
      })).json(),
    )
    return {
      caseId: started.outpatientCaseId,
      cashier,
      doctor,
      encounterId: started.encounterId,
      encounterRef,
      encounterVersion: parsed.data.encounterVersion,
      patientId: detail.patient.id,
      pharmacist,
      started,
    }
  }

  async function confirmDiagnosis(
    runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
    doctor: string,
    encounterId: string,
    encounterVersion: string,
    catalogItemId: string,
    expectedDraftVersion = 0,
  ): Promise<string> {
    const encounterRef = `Encounter/${encounterId}`
    const draftResponse = await runtime.app.request(`/api/his/v1/encounters/${encounterId}/diagnosis/draft`, {
      body: JSON.stringify({
        expectedVersions: { [encounterRef]: encounterVersion },
        input: { entries: [{ catalogItemId, role: 'primary' }], expectedDraftVersion },
      }),
      headers: commandHeaders(doctor),
      method: 'PUT',
    })
    expect(draftResponse.status).toBe(200)
    const draft = diagnosisDraftResponseSchema.parse(await draftResponse.json()).data
    const confirmResponse = await runtime.app.request(`/api/his/v1/encounters/${encounterId}/diagnosis/actions/confirm`, {
      body: JSON.stringify({
        expectedVersions: { [encounterRef]: encounterVersion },
        input: { expectedDraftVersion: draft.draftVersion },
      }),
      headers: commandHeaders(doctor),
      method: 'POST',
    })
    expect(confirmResponse.status).toBe(200)
    return confirmDiagnosisResponseSchema.parse(await confirmResponse.json()).data.encounterVersion
  }

  async function signClinicalDocument(
    runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
    doctor: string,
    encounterId: string,
    encounterVersion: string,
  ): Promise<void> {
    const encounterRef = `Encounter/${encounterId}`
    const document = {
      assessment: '合成门诊诊断依据完整。',
      chiefComplaint: '合成发热伴咽痛一天。',
      disposition: '门诊对症治疗。',
      followUp: '症状加重时立即复诊。',
      historyOfPresentIllness: '一天前开始发热伴咽痛，无气促。',
      physicalExamination: '神志清楚，咽部充血，双肺呼吸音清。',
    }
    const draft = clinicalDocumentDraftResponseSchema.parse(
      await (await runtime.app.request(`/api/his/v1/encounters/${encounterId}/clinical-document/draft`, {
        body: JSON.stringify({ expectedVersions: { [encounterRef]: encounterVersion }, input: { document, expectedDraftVersion: 0 } }),
        headers: commandHeaders(doctor),
        method: 'PUT',
      })).json(),
    ).data
    const preview = clinicalDocumentSignPreviewResponseSchema.parse(
      await (await runtime.app.request(`/api/his/v1/encounters/${encounterId}/clinical-document/actions/preview-sign`, {
        body: JSON.stringify({ expectedVersions: { [encounterRef]: encounterVersion }, input: { expectedDraftVersion: draft.draftVersion } }),
        headers: commandHeaders(doctor),
        method: 'POST',
      })).json(),
    ).data
    const signed = await runtime.app.request(`/api/his/v1/encounters/${encounterId}/clinical-document/actions/sign`, {
      body: JSON.stringify({
        expectedVersions: { [encounterRef]: encounterVersion },
        input: { commitToken: preview.commitToken, previewId: preview.previewId },
      }),
      headers: commandHeaders(doctor),
      method: 'POST',
    })
    expect(signed.status).toBe(200)
    clinicalDocumentSignResponseSchema.parse(await signed.json())
  }

  it('exposes hospital pharmacy medication specifications and unit prices in clinicalCatalog', async () => {
    const { password, runtime } = await setupRuntime()
    const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local', password)
    const response = await runtime.app.request('/api/his/v1/catalogs/clinical', {
      headers: { cookie: doctor },
    })
    expect(response.status).toBe(200)
    const catalog = clinicalCatalogSchema.parse(await response.json())
    expect(catalog.prescriptionConclusionSupported).toBe(true)
    expect(catalog.medications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'medication-oseltamivir',
        nameZh: '磷酸奥司他韦胶囊',
        priceFen: 760,
        strength: '75 mg',
      }),
      expect.objectContaining({
        dosageForm: '片剂',
        id: 'medication-acetaminophen',
        nameZh: '对乙酰氨基酚片',
        packageDescription: '20片/盒',
        priceFen: 120,
        strength: '500 mg',
      }),
    ]))
  })

  it('rejects mixing hospital pharmacy and national reference medications across draft save, direct issue, and recommendation confirm', async () => {
    const { password, runtime } = await setupRuntime()
    const visit = await startActiveVisit(runtime, password)
    const encounterVersion = await confirmDiagnosis(
      runtime,
      visit.doctor,
      visit.encounterId,
      visit.encounterVersion,
      'diagnosis-influenza',
    )
    const referenceProduct = syntheticNhsaMedicationProductSnapshot[0]!
    const localItem = {
      catalogItemId: 'medication-oseltamivir',
      courseDays: 5,
      doseText: '75 mg',
      frequencyCode: 'BID',
      quantity: 10,
    }
    const referenceItem = {
      catalogItemId: referenceProduct.id,
      courseDays: 3,
      doseText: referenceProduct.strength,
      frequencyCode: 'BID',
      quantity: 1,
    }

    const draftMixed = await runtime.app.request(
      `/api/his/v1/encounters/${visit.encounterId}/prescription/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [visit.encounterRef]: encounterVersion },
          input: { expectedDraftVersion: 0, items: [localItem, referenceItem] },
        }),
        headers: commandHeaders(visit.doctor),
        method: 'PUT',
      },
    )
    expect(draftMixed.status).toBe(409)
    expect(apiErrorSchema.parse(await draftMixed.json())).toMatchObject({
      error: { code: 'CATALOG_CONFLICT', reason: 'PRESCRIPTION_MIXED_CATALOG_SOURCES' },
    })

    const confirmMixed = await runtime.app.request(
      `/api/his/v1/doctor/cases/${visit.caseId}/recommendations/prescription/actions/confirm`,
      {
        body: JSON.stringify({
          expectedVersions: { [visit.encounterRef]: encounterVersion },
          input: {
            expectedDraftVersion: 0,
            selections: [
              { ...localItem, kind: 'prescription', source: 'manual' },
              { ...referenceItem, kind: 'prescription', referenceProduct, source: 'manual' },
            ],
          },
        }),
        headers: commandHeaders(visit.doctor),
        method: 'POST',
      },
    )
    expect(confirmMixed.status).toBe(409)
    expect(apiErrorSchema.parse(await confirmMixed.json())).toMatchObject({
      error: { code: 'CATALOG_CONFLICT', reason: 'PRESCRIPTION_MIXED_CATALOG_SOURCES' },
    })

    // Also guard direct issue if a persisted draft state ever contains mixed items.
    runtime.database.driver.prepare(`
      INSERT INTO prescription_draft_state (
        workspace_id, epoch, case_id, version, draft_json, updated_by, updated_at
      ) VALUES ('workspace-demo', 'epoch-1', ?, 1, ?, 'actor-outpatient-doctor', '2026-08-24T09:00:00+08:00')
    `).run(visit.caseId, JSON.stringify({
      items: [localItem, { ...referenceItem, referenceProduct }],
    }))

    const issueMixed = await runtime.app.request(
      `/api/his/v1/encounters/${visit.encounterId}/prescription/actions/issue`,
      {
        body: JSON.stringify({
          expectedVersions: { [visit.encounterRef]: encounterVersion },
          input: { expectedDraftVersion: 1 },
        }),
        headers: commandHeaders(visit.doctor),
        method: 'POST',
      },
    )
    expect(issueMixed.status).toBe(409)
    expect(apiErrorSchema.parse(await issueMixed.json())).toMatchObject({
      error: { code: 'CATALOG_CONFLICT', reason: 'PRESCRIPTION_MIXED_CATALOG_SOURCES' },
    })
  })

  it('returns fine-grained PRESCRIPTION_* reasons from recommendation prescription confirmation', async () => {
    const { password, runtime } = await setupRuntime()
    const visit = await startActiveVisit(runtime, password)
    const confirmPrepared = (
      encounterVersion: string,
      selection: Record<string, unknown>,
      expectedDraftVersion = 0,
      resolveExistingDraft?: boolean,
    ) => runtime.app.request(
      `/api/his/v1/doctor/cases/${visit.caseId}/recommendations/prescription/actions/confirm`,
      {
        body: JSON.stringify({
          expectedVersions: { [visit.encounterRef]: encounterVersion },
          input: {
            expectedDraftVersion,
            ...(resolveExistingDraft === undefined ? {} : { resolveExistingDraft }),
            selections: [{ kind: 'prescription', source: 'manual', ...selection }],
          },
        }),
        headers: commandHeaders(visit.doctor),
        method: 'POST',
      },
    )

    const oseltamivir = {
      catalogItemId: 'medication-oseltamivir',
      courseDays: 5,
      doseText: '75 mg',
      frequencyCode: 'BID',
      quantity: 10,
    }

    // 1. Unconfirmed primary diagnosis
    const unconfirmed = await confirmPrepared(visit.encounterVersion, oseltamivir)
    expect(unconfirmed.status).toBe(409)
    expect(apiErrorSchema.parse(await unconfirmed.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT', reason: 'PRESCRIPTION_DIAGNOSIS_UNCONFIRMED' },
    })

    // 2. Confirmed diagnosis not allowed for selected medication (R50.9 fever vs oseltamivir J10.1)
    let encounterVersion = await confirmDiagnosis(
      runtime,
      visit.doctor,
      visit.encounterId,
      visit.encounterVersion,
      'diagnosis-fever',
    )
    const diagnosisDisallowed = await confirmPrepared(encounterVersion, oseltamivir)
    expect(diagnosisDisallowed.status).toBe(409)
    expect(apiErrorSchema.parse(await diagnosisDisallowed.json())).toMatchObject({
      error: { code: 'CATALOG_CONFLICT', reason: 'PRESCRIPTION_DIAGNOSIS_NOT_ALLOWED' },
    })

    // 3. Disallowed dose/frequency & disallowed course/quantity
    const doseDisallowed = await confirmPrepared(encounterVersion, {
      ...oseltamivir,
      doseText: '150 mg',
    })
    expect(doseDisallowed.status).toBe(409)
    expect(apiErrorSchema.parse(await doseDisallowed.json())).toMatchObject({
      error: { code: 'CATALOG_CONFLICT', reason: 'PRESCRIPTION_DOSAGE_NOT_ALLOWED' },
    })

    const quantityDisallowed = await confirmPrepared(encounterVersion, {
      ...oseltamivir,
      quantity: 99,
    })
    expect(quantityDisallowed.status).toBe(409)
    expect(apiErrorSchema.parse(await quantityDisallowed.json())).toMatchObject({
      error: { code: 'CATALOG_CONFLICT', reason: 'PRESCRIPTION_DOSAGE_NOT_ALLOWED' },
    })

    // 4. Stale draft version
    const staleDraft = await confirmPrepared(encounterVersion, {
      catalogItemId: 'medication-acetaminophen',
      courseDays: 3,
      doseText: '0.5 g',
      frequencyCode: 'PRN',
      quantity: 6,
    }, 9)
    expect(staleDraft.status).toBe(409)
    expect(apiErrorSchema.parse(await staleDraft.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT', reason: 'PRESCRIPTION_DRAFT_STALE' },
    })

    // 5. Active medication allergy conflict
    runtime.fhir.create({ epoch: 'epoch-1', workspaceId: 'workspace-demo' }, {
      category: ['medication'],
      clinicalStatus: {
        coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical' }],
      },
      code: {
        coding: [{
          code: 'ACETAMINOPHEN',
          display: '对乙酰氨基酚',
          system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/synthetic-medication',
        }],
        text: '对乙酰氨基酚过敏',
      },
      criticality: 'high',
      id: `allergy-${randomUUID()}`,
      patient: { reference: `Patient/${visit.patientId}` },
      recordedDate: '2026-08-24T08:30:00+08:00',
      resourceType: 'AllergyIntolerance',
      verificationStatus: {
        coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification' }],
      },
    })
    const allergyConflict = await confirmPrepared(encounterVersion, {
      catalogItemId: 'medication-acetaminophen',
      courseDays: 3,
      doseText: '0.5 g',
      frequencyCode: 'PRN',
      quantity: 6,
    })
    expect(allergyConflict.status).toBe(409)
    expect(apiErrorSchema.parse(await allergyConflict.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT', reason: 'PRESCRIPTION_ALLERGY_CONFLICT' },
    })

    // 6. Confirm influenza and issue oseltamivir, then verify PRESCRIPTION_ALREADY_ISSUED
    encounterVersion = await confirmDiagnosis(
      runtime,
      visit.doctor,
      visit.encounterId,
      encounterVersion,
      'diagnosis-influenza',
      2,
    )
    const issued = await confirmPrepared(encounterVersion, oseltamivir)
    expect(issued.status).toBe(200)
    const issuedData = confirmDoctorPreparationResponseSchema.parse(await issued.json()).data

    const alreadyIssued = await confirmPrepared(encounterVersion, oseltamivir, issuedData.draftVersion)
    expect(alreadyIssued.status).toBe(409)
    expect(apiErrorSchema.parse(await alreadyIssued.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT', reason: 'PRESCRIPTION_ALREADY_ISSUED' },
    })

    // 7. Complete encounter, then verify PRESCRIPTION_ENCOUNTER_NOT_ACTIVE
    await signClinicalDocument(runtime, visit.doctor, visit.encounterId, encounterVersion)
    const completed = await runtime.app.request(
      `/api/his/v1/encounters/${visit.encounterId}/actions/complete`,
      {
        body: JSON.stringify({ expectedVersions: { [visit.encounterRef]: encounterVersion }, input: {} }),
        headers: commandHeaders(visit.doctor),
        method: 'POST',
      },
    )
    expect(completed.status).toBe(200)
    const completedVersion = encounterCompletionResponseSchema.parse(await completed.json()).data.encounterVersion
    const inactiveEncounter = await confirmPrepared(completedVersion, oseltamivir, issuedData.draftVersion)
    expect(inactiveEncounter.status).toBe(409)
    expect(apiErrorSchema.parse(await inactiveEncounter.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT', reason: 'PRESCRIPTION_ENCOUNTER_NOT_ACTIVE' },
    })
  })

  it('returns PRESCRIPTION_NO_MEDICATION_RECORDED from recommendation confirmation after no-medication is confirmed', async () => {
    const second = await setupRuntime()
    const secondVisit = await startActiveVisit(second.runtime, second.password)
    const oseltamivir = {
      catalogItemId: 'medication-oseltamivir',
      courseDays: 5,
      doseText: '75 mg',
      frequencyCode: 'BID',
      quantity: 10,
    }
    const noMedRes = await second.runtime.app.request(
      `/api/his/v1/encounters/${secondVisit.encounterId}/medication-conclusion/actions/confirm-no-medication`,
      {
        body: JSON.stringify({
          expectedVersions: { [secondVisit.encounterRef]: secondVisit.encounterVersion },
          input: { expectedDraftVersion: 0 },
        }),
        headers: commandHeaders(secondVisit.doctor),
        method: 'POST',
      },
    )
    expect(noMedRes.status).toBe(200)
    const noMedDraftVersion = confirmNoMedicationResponseSchema.parse(await noMedRes.json()).data.draftVersion
    const noMedBlocked = await second.runtime.app.request(
      `/api/his/v1/doctor/cases/${secondVisit.caseId}/recommendations/prescription/actions/confirm`,
      {
        body: JSON.stringify({
          expectedVersions: { [secondVisit.encounterRef]: secondVisit.encounterVersion },
          input: {
            expectedDraftVersion: noMedDraftVersion,
            selections: [{ ...oseltamivir, kind: 'prescription', source: 'manual' }],
          },
        }),
        headers: commandHeaders(secondVisit.doctor),
        method: 'POST',
      },
    )
    expect(noMedBlocked.status).toBe(409)
    expect(apiErrorSchema.parse(await noMedBlocked.json())).toMatchObject({
      error: { code: 'WORKFLOW_CONFLICT', reason: 'PRESCRIPTION_NO_MEDICATION_RECORDED' },
    })
  })

  it('issues pure national reference prescriptions without ChargeItem or billing/pharmacy entries, satisfies completion, and supports withdrawal', async () => {
    const { password, runtime } = await setupRuntime()
    const referenceProduct = syntheticNhsaMedicationProductSnapshot[0]!

    // Visit A: Issue external prescription -> complete encounter -> verify zero medication ChargeItem/billing/pharmacy
    const visitA = await startActiveVisit(runtime, password, { includeBillingRoles: true })
    await signClinicalDocument(runtime, visitA.doctor, visitA.encounterId, visitA.encounterVersion)
    const encounterVersionA = await confirmDiagnosis(
      runtime,
      visitA.doctor,
      visitA.encounterId,
      visitA.encounterVersion,
      'diagnosis-fever',
    )

    const confirmRes = await runtime.app.request(
      `/api/his/v1/doctor/cases/${visitA.caseId}/recommendations/prescription/actions/confirm`,
      {
        body: JSON.stringify({
          expectedVersions: { [visitA.encounterRef]: encounterVersionA },
          input: {
            expectedDraftVersion: 0,
            selections: [{
              catalogItemId: referenceProduct.id,
              courseDays: 5,
              doseText: referenceProduct.strength,
              frequencyCode: 'BID',
              kind: 'prescription',
              quantity: 2,
              referenceProduct,
              source: 'manual',
            }],
          },
        }),
        headers: commandHeaders(visitA.doctor),
        method: 'POST',
      },
    )
    expect(confirmRes.status).toBe(200)
    const confirmed = confirmDoctorPreparationResponseSchema.parse(await confirmRes.json())
    expect(confirmed.effects.some(effect => effect.reference.startsWith('ChargeItem/'))).toBe(false)
    expect(confirmed.effects.some(effect => effect.reference.startsWith('Prescription/'))).toBe(true)
    expect(confirmed.effects.some(effect => effect.reference.startsWith('MedicationRequest/'))).toBe(true)

    const detailAfterIssue = doctorCaseDetailSchema.parse(
      await (await runtime.app.request(`/api/his/v1/doctor/cases/${visitA.caseId}`, {
        headers: { cookie: visitA.doctor },
      })).json(),
    )
    expect(detailAfterIssue.medicationConclusion?.draft).toBeUndefined()
    expect(detailAfterIssue.medicationConclusion?.prescription).toMatchObject({
      items: [{
        catalogItemId: referenceProduct.id,
        display: referenceProduct.genericName,
        referenceProduct: expect.objectContaining({
          id: referenceProduct.id,
          packageDescription: referenceProduct.packageDescription,
        }),
      }],
      status: 'signed',
    })

    const medicationRequests = fhirBundleSchema.parse(
      await (await runtime.app.request(
        `/fhir/R5/MedicationRequest?encounter=Encounter/${visitA.encounterId}&_total=accurate`,
        { headers: { cookie: visitA.doctor } },
      )).json(),
    )
    expect(medicationRequests.total).toBe(1)

    const chargeCount = z.object({ count: z.number() }).parse(
      runtime.database.driver.prepare(`
        SELECT COUNT(*) AS count FROM charge_record
        WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
          AND case_id = ? AND category = 'medication'
      `).get(visitA.caseId),
    ).count
    expect(chargeCount).toBe(0)

    const completionPreview = encounterCompletionPreviewSchema.parse(
      await (await runtime.app.request(`/api/his/v1/encounters/${visitA.encounterId}/completion`, {
        headers: { cookie: visitA.doctor },
      })).json(),
    )
    expect(completionPreview.canComplete).toBe(true)
    expect(completionPreview.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'medication-conclusion-recorded', status: 'complete' }),
    ]))

    const completeRes = await runtime.app.request(
      `/api/his/v1/encounters/${visitA.encounterId}/actions/complete`,
      {
        body: JSON.stringify({ expectedVersions: { [visitA.encounterRef]: encounterVersionA }, input: {} }),
        headers: commandHeaders(visitA.doctor),
        method: 'POST',
      },
    )
    expect(completeRes.status).toBe(200)

    const billingQueue = billingQueueSchema.parse(
      await (await runtime.app.request('/api/his/v1/billing/queue?category=medication&status=pending&pageSize=20', {
        headers: { cookie: visitA.cashier },
      })).json(),
    )
    expect(billingQueue.items.find(item => item.caseId === visitA.caseId)).toBeUndefined()

    const billingCaseRes = await runtime.app.request(`/api/his/v1/billing/cases/${visitA.caseId}`, {
      headers: { cookie: visitA.cashier },
    })
    expect(billingCaseRes.status).toBe(200)
    const billingCase = billingCaseSchema.parse(await billingCaseRes.json())
    expect(billingCase.charges.filter(charge => charge.category === 'medication')).toEqual([])

    const pharmacyQueue = pharmacyQueueSchema.parse(
      await (await runtime.app.request('/api/his/v1/pharmacy/queue?status=pending&pageSize=20', {
        headers: { cookie: visitA.pharmacist },
      })).json(),
    )
    expect(pharmacyQueue.items.find(item => item.caseId === visitA.caseId)).toBeUndefined()
  })

  it('issues a pure national reference prescription directly from draft and withdraws it cleanly', async () => {
    const { password, runtime } = await setupRuntime()
    const referenceProduct = syntheticNhsaMedicationProductSnapshot[0]!
    const visitB = await startActiveVisit(runtime, password)
    const encounterVersionB = await confirmDiagnosis(
      runtime,
      visitB.doctor,
      visitB.encounterId,
      visitB.encounterVersion,
      'diagnosis-fever',
    )
    const draftB = prescriptionDraftResponseSchema.parse(
      await (await runtime.app.request(`/api/his/v1/encounters/${visitB.encounterId}/prescription/draft`, {
        body: JSON.stringify({
          expectedVersions: { [visitB.encounterRef]: encounterVersionB },
          input: {
            expectedDraftVersion: 0,
            items: [{
              catalogItemId: referenceProduct.id,
              courseDays: 3,
              doseText: referenceProduct.strength,
              frequencyCode: 'QD',
              quantity: 1,
            }],
          },
        }),
        headers: commandHeaders(visitB.doctor),
        method: 'PUT',
      })).json(),
    ).data
    const issueResB = await runtime.app.request(
      `/api/his/v1/encounters/${visitB.encounterId}/prescription/actions/issue`,
      {
        body: JSON.stringify({
          expectedVersions: { [visitB.encounterRef]: encounterVersionB },
          input: { expectedDraftVersion: draftB.draftVersion },
        }),
        headers: commandHeaders(visitB.doctor),
        method: 'POST',
      },
    )
    expect(issueResB.status).toBe(200)
    const issuedB = issuePrescriptionResponseSchema.parse(await issueResB.json())
    expect(issuedB.effects.some(effect => effect.reference.startsWith('ChargeItem/'))).toBe(false)
    const rxB = issuedB.data.prescription

    const withdrawResB = await runtime.app.request(
      `/api/his/v1/prescriptions/${rxB.id}/actions/withdraw`,
      {
        body: JSON.stringify({
          expectedVersions: Object.fromEntries(
            rxB.items.map(item => [`MedicationRequest/${item.medicationRequestId}`, item.medicationRequestVersion]),
          ),
          input: { expectedPrescriptionVersion: rxB.version },
        }),
        headers: commandHeaders(visitB.doctor),
        method: 'POST',
      },
    )
    expect(withdrawResB.status).toBe(200)
    expect(withdrawPrescriptionResponseSchema.parse(await withdrawResB.json()).data.status).toBe('withdrawn')
  })

  it('preserves the hospital pharmacy billing, payment, and batch dispensing closed loop', async () => {
    const thirdEnv = await setupRuntime()
    const dispensed = await completeSyntheticOutpatient(thirdEnv.runtime, thirdEnv.password)
    expect(dispensed.status).toBe('completed')
  })

  it('keeps external prescription and no-medication conclusions available when all hospital outpatient medications are inactive or inpatient-only', async () => {
    const { password, runtime } = await setupRuntime()
    const visit = await startActiveVisit(runtime, password)
    const encounterVersion = await confirmDiagnosis(
      runtime,
      visit.doctor,
      visit.encounterId,
      visit.encounterVersion,
      'diagnosis-fever',
    )

    // Outpatient medication with unit: null still preserves product presentation metadata while active
    runtime.database.driver.prepare(`
      UPDATE outpatient_catalog
      SET config_json = json_set(config_json, '$.unit', null)
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND kind = 'medication' AND item_id = 'medication-acetaminophen'
    `).run()
    const withNullUnitCatalog = clinicalCatalogSchema.parse(
      await (await runtime.app.request('/api/his/v1/catalogs/clinical', {
        headers: { cookie: visit.doctor },
      })).json(),
    )
    expect(withNullUnitCatalog.medications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dosageForm: '片剂',
        id: 'medication-acetaminophen',
        packageDescription: '20片/盒',
        strength: '500 mg',
      }),
    ]))

    // Deactivate all outpatient medications and add an active inpatient-only medication with non-outpatient config
    runtime.database.driver.prepare(`
      UPDATE outpatient_catalog
      SET active = 0
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1' AND kind = 'medication'
    `).run()
    runtime.database.driver.prepare(`
      INSERT INTO outpatient_catalog (
        workspace_id, epoch, item_id, kind, code, name_zh, name_en, price_fen, version, active, config_json
      ) VALUES (
        'workspace-demo', 'epoch-1', 'medication-inpatient-only-test', 'medication', 'SYN-INP-001',
        '合成住院专用注射液', 'Synthetic inpatient injection', 3200, 1, 1, ?
      )
    `).run(JSON.stringify({
      availableScopes: ['inpatient'],
      unit: 17,
    }))

    const emptyLocalCatalog = clinicalCatalogSchema.parse(
      await (await runtime.app.request('/api/his/v1/catalogs/clinical', {
        headers: { cookie: visit.doctor },
      })).json(),
    )
    expect(emptyLocalCatalog.medications).toEqual([])
    expect(emptyLocalCatalog.prescriptionConclusionSupported).toBe(true)

    const referenceProduct = syntheticNhsaMedicationProductSnapshot[0]!
    const singleCharKeyword = [...referenceProduct.genericName][0]!
    const singleCharSearchRes = await runtime.app.request(
      `/api/his/v1/reference-catalogs/medications?page=1&pageSize=20&query=${encodeURIComponent(singleCharKeyword)}`,
      { headers: { cookie: visit.doctor } },
    )
    expect(singleCharSearchRes.status).toBe(200)
    const singleCharSearch = referenceMedicationCatalogSearchSchema.parse(await singleCharSearchRes.json())
    expect(singleCharSearch.items.some(item => item.id === referenceProduct.id)).toBe(true)

    const draftRes = await runtime.app.request(
      `/api/his/v1/encounters/${visit.encounterId}/prescription/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [visit.encounterRef]: encounterVersion },
          input: {
            expectedDraftVersion: 0,
            items: [{
              catalogItemId: referenceProduct.id,
              courseDays: 3,
              doseText: referenceProduct.strength,
              frequencyCode: 'BID',
              quantity: 1,
            }],
          },
        }),
        headers: commandHeaders(visit.doctor),
        method: 'PUT',
      },
    )
    expect(draftRes.status).toBe(200)
    const draft = prescriptionDraftResponseSchema.parse(await draftRes.json()).data

    const issueRes = await runtime.app.request(
      `/api/his/v1/encounters/${visit.encounterId}/prescription/actions/issue`,
      {
        body: JSON.stringify({
          expectedVersions: { [visit.encounterRef]: encounterVersion },
          input: { expectedDraftVersion: draft.draftVersion },
        }),
        headers: commandHeaders(visit.doctor),
        method: 'POST',
      },
    )
    expect(issueRes.status).toBe(200)
    const issuedPayload = issuePrescriptionResponseSchema.parse(await issueRes.json()).data
    const issued = issuedPayload.prescription

    const withdrawRes = await runtime.app.request(
      `/api/his/v1/prescriptions/${issued.id}/actions/withdraw`,
      {
        body: JSON.stringify({
          expectedVersions: Object.fromEntries(
            issued.items.map(item => [`MedicationRequest/${item.medicationRequestId}`, item.medicationRequestVersion]),
          ),
          input: { expectedPrescriptionVersion: issued.version },
        }),
        headers: commandHeaders(visit.doctor),
        method: 'POST',
      },
    )
    expect(withdrawRes.status).toBe(200)

    const noMedRes = await runtime.app.request(
      `/api/his/v1/encounters/${visit.encounterId}/medication-conclusion/actions/confirm-no-medication`,
      {
        body: JSON.stringify({
          expectedVersions: { [visit.encounterRef]: encounterVersion },
          input: { expectedDraftVersion: issuedPayload.draftVersion },
        }),
        headers: commandHeaders(visit.doctor),
        method: 'POST',
      },
    )
    expect(noMedRes.status).toBe(200)
    expect(confirmNoMedicationResponseSchema.parse(await noMedRes.json()).data.noMedication.version).toBe(1)
  })
})
