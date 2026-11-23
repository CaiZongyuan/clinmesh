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
  doctorCompletedCaseDetailSchema,
  encounterCompletionPreviewSchema,
  encounterCompletionResponseSchema,
  issuePrescriptionResponseSchema,
  paymentPreviewResponseSchema,
  paymentResponseSchema,
  pharmacyQueueSchema,
  prescriptionDraftResponseSchema,
  withdrawPrescriptionResponseSchema,
} from '@clinmesh/contracts/his'
import { confirmDoctorPreparationResponseSchema } from '@clinmesh/contracts/doctor-recommendations'
import { inpatientCatalogSearchSchema, inpatientFullCatalogSchema } from '@clinmesh/contracts/inpatient-clinical'
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
      menstrualHistory: '患者自述已绝经，年龄记不清。', obstetricHistory: '患者自述孕2产2。',
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

  it('允许冠心病跨类联合处方并在整单拒绝药理互斥与超单日极量后保留可重试状态', async () => {
    const { password, runtime } = await setupRuntime()
    const visit = await startActiveVisit(runtime, password)
    const encounterVersion = await confirmDiagnosis(runtime, visit.doctor, visit.encounterId, visit.encounterVersion, 'diagnosis-coronary-heart-disease')
    const regimen = [
      { catalogItemId: 'medication-pci-aspirin', doseText: '100 mg', frequencyCode: 'QD', routeCode: 'PO', courseDays: 30, quantity: 30 },
      { catalogItemId: 'medication-pci-clopidogrel', doseText: '75 mg', frequencyCode: 'QD', routeCode: 'PO', courseDays: 30, quantity: 30 },
      { catalogItemId: 'medication-pci-atorvastatin', doseText: '20 mg', frequencyCode: 'QN', routeCode: 'PO', courseDays: 30, quantity: 60 },
      { catalogItemId: 'medication-metoprolol', doseText: '47.5 mg', frequencyCode: 'QD', routeCode: 'PO', courseDays: 30, quantity: 30 },
      { catalogItemId: 'medication-perindopril', doseText: '4 mg', frequencyCode: 'QD', routeCode: 'PO', courseDays: 30, quantity: 30 },
    ]
    const save = (items: typeof regimen) => runtime.app.request(`/api/his/v1/encounters/${visit.encounterId}/prescription/draft`, {
      method: 'PUT', headers: commandHeaders(visit.doctor), body: JSON.stringify({ expectedVersions: { [visit.encounterRef]: encounterVersion }, input: { expectedDraftVersion: 0, items } }),
    })
    const duplicateClass = await save([...regimen, { ...regimen[1]!, catalogItemId: 'medication-ticagrelor', doseText: '90 mg', frequencyCode: 'BID' }])
    expect(duplicateClass.status).toBe(409)
    expect(await duplicateClass.json()).toMatchObject({ error: { reason: 'PRESCRIPTION_COMBINATION_NOT_ALLOWED' } })
    const extremeDose = await save([{ ...regimen[2]!, doseText: '80 mg', frequencyCode: 'BID' }])
    expect(extremeDose.status).toBe(409)
    expect(await extremeDose.json()).toMatchObject({ error: { reason: 'PRESCRIPTION_DOSAGE_NOT_ALLOWED' } })
    const saved = await save(regimen)
    expect(saved.status, await saved.clone().text()).toBe(200)
    const draft = prescriptionDraftResponseSchema.parse(await saved.json()).data
    const issued = await runtime.app.request(`/api/his/v1/encounters/${visit.encounterId}/prescription/actions/issue`, {
      method: 'POST', headers: commandHeaders(visit.doctor), body: JSON.stringify({ expectedVersions: { [visit.encounterRef]: encounterVersion }, input: { expectedDraftVersion: draft.draftVersion } }),
    })
    expect(issued.status, await issued.clone().text()).toBe(200)
    expect(issuePrescriptionResponseSchema.parse(await issued.json()).data.prescription.items).toHaveLength(5)
  })

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
        dosageForm: '胶囊剂',
        id: 'medication-oseltamivir',
        nameZh: '磷酸奥司他韦胶囊',
        packageDescription: '10粒/盒',
        priceFen: 760,
        strength: '75 mg',
        unit: '粒',
      }),
      expect.objectContaining({
        dosageForm: '片剂',
        id: 'medication-acetaminophen',
        nameZh: '对乙酰氨基酚片',
        packageDescription: '20片/盒',
        priceFen: 120,
        strength: '500 mg',
      }),
      expect.objectContaining({
        id: 'medication-sodium-chloride',
        nameZh: '0.9%氯化钠注射液',
        packageDescription: '1瓶/盒',
        strength: '500 mL',
        unit: '瓶',
      }),
    ]))
    for (const item of catalog.medications) {
      expect(item.strength, item.id).toBeTruthy()
      expect(item.packageDescription, item.id).toBeTruthy()
      expect(item.packageDescription, item.id).not.toContain('合成单')
    }

    const inpatientDoctor = await signIn(runtime, 'inpatient-doctor@demo.clinmesh.local', password)
    const inpatientCatalog = inpatientFullCatalogSchema.parse(
      await (await runtime.app.request('/api/his/v1/inpatient/clinical-catalog', { headers: { cookie: inpatientDoctor } })).json(),
    )
    expect(inpatientCatalog.medications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'medication-oseltamivir',
        packageDescription: '10粒/盒',
        strength: '75 mg',
        unit: '粒',
      }),
    ]))
    for (const item of inpatientCatalog.medications) {
      expect(item.strength, item.id).toBeTruthy()
      expect(item.packageDescription, item.id).toBeTruthy()
      expect(item.packageDescription, item.id).not.toContain('合成单')
    }
    const searchRes = await runtime.app.request('/api/his/v1/inpatient/catalog-search?kind=medication&source=hospital&query=奥司他韦&page=1&pageSize=20', {
      headers: { cookie: inpatientDoctor },
    })
    const search = inpatientCatalogSearchSchema.parse(await searchRes.json())
    expect(search.items[0]?.medication).toMatchObject({
      id: 'medication-oseltamivir',
      packageDescription: '10粒/盒',
      strength: '75 mg',
    })
  })

  it('persists hospital prescription specification snapshots and resolves prescription_authorship doctor name with legacy fallbacks', async () => {
    const { password, runtime } = await setupRuntime()
    const visit = await startActiveVisit(runtime, password)
    const encounterVersion = await confirmDiagnosis(
      runtime,
      visit.doctor,
      visit.encounterId,
      visit.encounterVersion,
      'diagnosis-influenza',
    )
    const draftRes = await runtime.app.request(
      `/api/his/v1/encounters/${visit.encounterId}/prescription/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [visit.encounterRef]: encounterVersion },
          input: {
            expectedDraftVersion: 0,
            items: [{
              catalogItemId: 'medication-oseltamivir',
              courseDays: 5,
              doseText: '75 mg',
              frequencyCode: 'BID',
              quantity: 10,
              routeCode: 'PO',
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
    const issued = issuePrescriptionResponseSchema.parse(await issueRes.json()).data.prescription
    expect(issued).toMatchObject({
      authoredByName: '合成门诊医生',
      authoredByPractitionerRoleId: 'practitioner-role-outpatient-doctor',
      items: [{
        catalogItemId: 'medication-oseltamivir',
        display: '磷酸奥司他韦胶囊',
        packageDescription: '10粒/盒',
        strength: '75 mg',
        unit: '粒',
      }],
    })
    expect(issued.items[0]?.referenceProduct).toBeUndefined()

    // Snapshot takes priority even if current catalog packageDescription changes afterwards
    runtime.database.driver.prepare(`
      UPDATE outpatient_catalog
      SET config_json = json_set(config_json, '$.product.packageDescription', '99粒/瓶')
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1' AND item_id = 'medication-oseltamivir'
    `).run()
    const detailFromSnapshot = doctorCaseDetailSchema.parse(
      await (await runtime.app.request(`/api/his/v1/doctor/cases/${visit.caseId}`, { headers: { cookie: visit.doctor } })).json(),
    )
    expect(detailFromSnapshot.medicationConclusion?.prescription).toMatchObject({
      authoredByName: '合成门诊医生',
      items: [{
        catalogItemId: 'medication-oseltamivir',
        packageDescription: '10粒/盒',
        strength: '75 mg',
        unit: '粒',
      }],
    })

    // Legacy snapshot without strength/packageDescription safely falls back to current catalog without throwing
    runtime.database.driver.prepare(`
      UPDATE prescription_item
      SET medication_snapshot_json = ?
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1' AND prescription_id = ?
    `).run(JSON.stringify({
      code: 'OSELTAMIVIR',
      display: '磷酸奥司他韦胶囊',
      id: 'medication-oseltamivir',
      sourceLocator: 'operational:outpatient_catalog',
      system: 'urn:clinmesh:operational:medication',
      version: '1',
    }), issued.id)
    const detailLegacyFallback = doctorCaseDetailSchema.parse(
      await (await runtime.app.request(`/api/his/v1/doctor/cases/${visit.caseId}`, { headers: { cookie: visit.doctor } })).json(),
    )
    expect(detailLegacyFallback.medicationConclusion?.prescription?.items[0]).toMatchObject({
      packageDescription: '99粒/瓶',
      strength: '75 mg',
      unit: '粒',
    })
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
      routeCode: 'PO',
    }
    const referenceItem = {
      catalogItemId: referenceProduct.id,
      courseDays: 3,
      doseText: referenceProduct.strength,
      frequencyCode: 'BID',
      quantity: 1,
      routeCode: 'PO',
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
      items: [localItem, { ...referenceItem, referenceProduct: { ...referenceProduct, defaultRouteCode: 'PO', allowedRouteCodes: ['PO'] } }],
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
      routeCode: 'PO',
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
      doseText: '300 mg',
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
      routeCode: 'PO',
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
      routeCode: 'PO',
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
      routeCode: 'PO',
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
              routeCode: 'PO',
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
              routeCode: 'PO',
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
              routeCode: 'PO',
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

  it('exposes synthetic packageInsert summaries across outpatient and inpatient catalogs, backfills existing epochs without bumping version, and keeps unconfigured items orderable', async () => {
    const { password, runtime } = await setupRuntime()
    const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local', password)
    const inpatientDoctor = await signIn(runtime, 'inpatient-doctor@demo.clinmesh.local', password)
    const admin = await signIn(runtime, 'admin@demo.clinmesh.local', password)

    const outpatientCatalog = clinicalCatalogSchema.parse(
      await (await runtime.app.request('/api/his/v1/catalogs/clinical', { headers: { cookie: doctor } })).json(),
    )
    expect(outpatientCatalog.medications).toHaveLength(22)
    expect(outpatientCatalog.medications.every(item => item.packageInsert !== undefined)).toBe(true)

    const doctorContext = z.object({ actor: z.any() }).parse(
      await (await runtime.app.request('/api/auth/context', { headers: { cookie: doctor } })).json(),
    )
    const recommendationMedications = runtime.workflow.doctorRecommendationMedications(doctorContext.actor)
    expect(recommendationMedications).toHaveLength(22)
    expect(recommendationMedications.every(item => !('packageInsert' in item))).toBe(true)

    const prepareRes = await runtime.app.request('/api/his/v1/inpatient/pci-data/prepare', {
      body: JSON.stringify({ input: { expectedEpoch: 'epoch-1' } }),
      headers: commandHeaders(admin),
      method: 'POST',
    })
    expect(prepareRes.status).toBe(200)

    const inpatientCatalog = inpatientFullCatalogSchema.parse(
      await (await runtime.app.request('/api/his/v1/inpatient/clinical-catalog', { headers: { cookie: inpatientDoctor } })).json(),
    )
    const iohexol = inpatientCatalog.medications.find(item => item.id === 'medication-pci-iohexol')
    expect(iohexol?.packageInsert?.genericName).toBe('碘海醇注射液')

    // Simulate pre-upgrade PCI rows missing packageInsert and verify prepare-pci-data backfills in-place without bumping version
    runtime.database.driver.prepare(`
      UPDATE outpatient_catalog
      SET config_json = json_remove(config_json, '$.packageInsert')
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND item_id IN ('medication-atorvastatin', 'medication-pci-iohexol')
    `).run()
    const pciBeforeVersions = z.array(z.object({ item_id: z.string(), version: z.number() })).parse(
      runtime.database.driver.prepare(`
        SELECT item_id, version FROM outpatient_catalog
        WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
          AND item_id IN ('medication-atorvastatin', 'medication-pci-iohexol')
        ORDER BY item_id
      `).all(),
    )
    const rePrepareRes = await runtime.app.request('/api/his/v1/inpatient/pci-data/prepare', {
      body: JSON.stringify({ input: { expectedEpoch: 'epoch-1' } }),
      headers: commandHeaders(admin),
      method: 'POST',
    })
    expect(rePrepareRes.status).toBe(200)
    expect(z.object({ effects: z.array(z.object({ kind: z.string(), reference: z.string() })) }).parse(await rePrepareRes.json()).effects).toEqual([])
    const pciAfterVersions = z.array(z.object({ item_id: z.string(), version: z.number() })).parse(
      runtime.database.driver.prepare(`
        SELECT item_id, version FROM outpatient_catalog
        WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
          AND item_id IN ('medication-atorvastatin', 'medication-pci-iohexol')
        ORDER BY item_id
      `).all(),
    )
    expect(pciAfterVersions).toEqual(pciBeforeVersions)

    // Simulate pre-upgrade active epoch rows missing packageInsert and verify seedInpatientEnvironment via ensureInitialEpoch preserves version
    runtime.database.driver.prepare(`
      UPDATE outpatient_catalog
      SET config_json = json_remove(config_json, '$.packageInsert')
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND item_id IN ('medication-metformin', 'medication-pci-iohexol')
    `).run()
    const beforeVersions = z.array(z.object({ item_id: z.string(), version: z.number() })).parse(
      runtime.database.driver.prepare(`
        SELECT item_id, version FROM outpatient_catalog
        WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
          AND item_id IN ('medication-metformin', 'medication-pci-iohexol')
        ORDER BY item_id
      `).all(),
    )
    runtime.scenario.ensureInitialEpoch({
      epoch: 'epoch-1',
      scenarioRunId: 'scenario-run-1',
      workspaceId: 'workspace-demo',
    })
    const afterVersions = z.array(z.object({ item_id: z.string(), version: z.number() })).parse(
      runtime.database.driver.prepare(`
        SELECT item_id, version FROM outpatient_catalog
        WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
          AND item_id IN ('medication-metformin', 'medication-pci-iohexol')
        ORDER BY item_id
      `).all(),
    )
    expect(afterVersions).toEqual(beforeVersions)

    const searchAfterBackfill = inpatientCatalogSearchSchema.parse(
      await (await runtime.app.request('/api/his/v1/inpatient/catalog-search?kind=medication&source=hospital&page=1&pageSize=50', {
        headers: { cookie: inpatientDoctor },
      })).json(),
    )
    expect(searchAfterBackfill.items.find(item => item.id === 'medication-metformin')?.medication?.packageInsert?.contraindications).toContain('eGFR < 30')
    expect(searchAfterBackfill.items.find(item => item.id === 'medication-pci-iohexol')?.medication?.packageInsert?.genericName).toBe('碘海醇注射液')

    // Custom hospital medication without packageInsert stays available with zero missingFields
    runtime.database.driver.prepare(`
      UPDATE outpatient_catalog
      SET config_json = json_remove(config_json, '$.packageInsert')
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND item_id = 'medication-amlodipine'
    `).run()
    const unconfiguredSearch = inpatientCatalogSearchSchema.parse(
      await (await runtime.app.request('/api/his/v1/inpatient/catalog-search?kind=medication&source=hospital&query=氨氯地平&page=1&pageSize=20', {
        headers: { cookie: inpatientDoctor },
      })).json(),
    )
    const unconfiguredAmlodipine = unconfiguredSearch.items.find(item => item.id === 'medication-amlodipine')
    expect(unconfiguredAmlodipine?.status).toBe('available')
    expect(unconfiguredAmlodipine?.missingFields).toEqual([])
    expect(unconfiguredAmlodipine?.medication?.packageInsert).toBeUndefined()

    // Malformed optional packageInsert degrades to undefined without failing outpatient or inpatient catalog reads
    runtime.database.driver.prepare(`
      UPDATE outpatient_catalog
      SET config_json = json_set(config_json, '$.packageInsert', json('{"genericName":""}'))
      WHERE workspace_id = 'workspace-demo' AND epoch = 'epoch-1'
        AND item_id = 'medication-amlodipine'
    `).run()
    const degradedOutpatient = clinicalCatalogSchema.parse(
      await (await runtime.app.request('/api/his/v1/catalogs/clinical', { headers: { cookie: doctor } })).json(),
    )
    const degradedOutpatientAmlodipine = degradedOutpatient.medications.find(item => item.id === 'medication-amlodipine')
    expect(degradedOutpatientAmlodipine?.packageInsert).toBeUndefined()
    expect(degradedOutpatientAmlodipine?.strength).toBe('5 mg')
    expect(degradedOutpatientAmlodipine?.packageDescription).toBeDefined()
    const degradedInpatientCatalog = inpatientFullCatalogSchema.parse(
      await (await runtime.app.request('/api/his/v1/inpatient/clinical-catalog', { headers: { cookie: inpatientDoctor } })).json(),
    )
    expect(degradedInpatientCatalog.medications.find(item => item.id === 'medication-amlodipine')?.packageInsert).toBeUndefined()
    const degradedInpatientSearch = inpatientCatalogSearchSchema.parse(
      await (await runtime.app.request('/api/his/v1/inpatient/catalog-search?kind=medication&source=hospital&query=氨氯地平&page=1&pageSize=20', {
        headers: { cookie: inpatientDoctor },
      })).json(),
    )
    expect(degradedInpatientSearch.items.find(item => item.id === 'medication-amlodipine')?.status).toBe('available')
    expect(degradedInpatientSearch.items.find(item => item.id === 'medication-amlodipine')?.medication?.packageInsert).toBeUndefined()
  })

  it('validates hospital and external prescription routes, switches multi-route nitroglycerin SL/PO, and projects routeCode to FHIR, pharmacy queue, and completed cases', async () => {
    const { password, runtime } = await setupRuntime()
    const visit = await startActiveVisit(runtime, password, { includeBillingRoles: true })
    await signClinicalDocument(runtime, visit.doctor, visit.encounterId, visit.encounterVersion)
    const encounterVersion = await confirmDiagnosis(
      runtime,
      visit.doctor,
      visit.encounterId,
      visit.encounterVersion,
      'diagnosis-coronary-heart-disease',
    )
    const referenceProduct = syntheticNhsaMedicationProductSnapshot[0]!

    // 1. Disallowed route on hospital medication -> 409 PRESCRIPTION_ROUTE_NOT_ALLOWED, zero partial write
    const badHospitalRoute = await runtime.app.request(
      `/api/his/v1/encounters/${visit.encounterId}/prescription/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [visit.encounterRef]: encounterVersion },
          input: {
            expectedDraftVersion: 0,
            items: [{
              catalogItemId: 'medication-nitroglycerin',
              courseDays: 30,
              doseText: '0.5 mg',
              frequencyCode: 'PRN',
              quantity: 10,
              routeCode: 'IV',
            }],
          },
        }),
        headers: commandHeaders(visit.doctor),
        method: 'PUT',
      },
    )
    expect(badHospitalRoute.status).toBe(409)
    expect(apiErrorSchema.parse(await badHospitalRoute.json())).toMatchObject({
      error: { code: 'CATALOG_CONFLICT', reason: 'PRESCRIPTION_ROUTE_NOT_ALLOWED' },
    })

    // 2. Disallowed route on national reference external medication -> 409 PRESCRIPTION_ROUTE_NOT_ALLOWED
    const badExternalRoute = await runtime.app.request(
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
              frequencyCode: 'QD',
              quantity: 1,
              routeCode: 'IVGTT',
            }],
          },
        }),
        headers: commandHeaders(visit.doctor),
        method: 'PUT',
      },
    )
    expect(badExternalRoute.status).toBe(409)
    expect(apiErrorSchema.parse(await badExternalRoute.json())).toMatchObject({
      error: { code: 'CATALOG_CONFLICT', reason: 'PRESCRIPTION_ROUTE_NOT_ALLOWED' },
    })
    expect((await (await runtime.app.request(`/api/his/v1/doctor/cases/${visit.caseId}`, { headers: { cookie: visit.doctor } })).json()).medicationConclusion?.draft).toBeUndefined()

    // 3. Multi-route nitroglycerin supports switching PO -> SL in draft and persists SL on formal issue
    const draftPoRes = await runtime.app.request(
      `/api/his/v1/encounters/${visit.encounterId}/prescription/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [visit.encounterRef]: encounterVersion },
          input: {
            expectedDraftVersion: 0,
            items: [{
              catalogItemId: 'medication-nitroglycerin',
              courseDays: 30,
              doseText: '0.5 mg',
              frequencyCode: 'PRN',
              quantity: 10,
              routeCode: 'PO',
            }],
          },
        }),
        headers: commandHeaders(visit.doctor),
        method: 'PUT',
      },
    )
    expect(draftPoRes.status).toBe(200)
    const draftPo = prescriptionDraftResponseSchema.parse(await draftPoRes.json()).data

    const draftSlRes = await runtime.app.request(
      `/api/his/v1/encounters/${visit.encounterId}/prescription/draft`,
      {
        body: JSON.stringify({
          expectedVersions: { [visit.encounterRef]: encounterVersion },
          input: {
            expectedDraftVersion: draftPo.draftVersion,
            items: [{
              catalogItemId: 'medication-nitroglycerin',
              courseDays: 30,
              doseText: '0.5 mg',
              frequencyCode: 'PRN',
              instructions: '心绞痛发作时舌下含服',
              quantity: 10,
              routeCode: 'SL',
            }],
          },
        }),
        headers: commandHeaders(visit.doctor),
        method: 'PUT',
      },
    )
    expect(draftSlRes.status).toBe(200)
    const draftSl = prescriptionDraftResponseSchema.parse(await draftSlRes.json()).data

    const issueRes = await runtime.app.request(
      `/api/his/v1/encounters/${visit.encounterId}/prescription/actions/issue`,
      {
        body: JSON.stringify({
          expectedVersions: { [visit.encounterRef]: encounterVersion },
          input: { expectedDraftVersion: draftSl.draftVersion },
        }),
        headers: commandHeaders(visit.doctor),
        method: 'POST',
      },
    )
    expect(issueRes.status, await issueRes.clone().text()).toBe(200)
    const issued = issuePrescriptionResponseSchema.parse(await issueRes.json()).data.prescription
    expect(issued.items[0]).toMatchObject({ catalogItemId: 'medication-nitroglycerin', routeCode: 'SL' })

    const medRequestRes = await runtime.app.request(
      `/fhir/R5/MedicationRequest/${issued.items[0]!.medicationRequestId}`,
      { headers: { cookie: visit.doctor } },
    )
    expect(medRequestRes.status).toBe(200)
    expect(await medRequestRes.json()).toMatchObject({
      dosageInstruction: [expect.objectContaining({
        route: {
          coding: [{
            code: 'SL',
            display: '舌下含服',
            system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/medication-route',
          }],
          text: '舌下含服（sl）',
        },
      })],
    })

    const completeRes = await runtime.app.request(
      `/api/his/v1/encounters/${visit.encounterId}/actions/complete`,
      {
        body: JSON.stringify({ expectedVersions: { [visit.encounterRef]: encounterVersion }, input: {} }),
        headers: commandHeaders(visit.doctor),
        method: 'POST',
      },
    )
    expect(completeRes.status).toBe(200)

    const completedCase = doctorCompletedCaseDetailSchema.parse(
      await (await runtime.app.request(`/api/his/v1/doctor/completed-cases/${visit.caseId}`, { headers: { cookie: visit.doctor } })).json(),
    )
    expect(completedCase.medicationConclusion?.prescription?.items[0]).toMatchObject({ routeCode: 'SL' })

    const bill = billingQueueSchema.parse(
      await (await runtime.app.request('/api/his/v1/billing/queue?category=medication&status=pending&pageSize=20', {
        headers: { cookie: visit.cashier },
      })).json(),
    ).items.find(item => item.caseId === visit.caseId)!
    const payPreview = paymentPreviewResponseSchema.parse(
      await (await runtime.app.request('/api/his/v1/payments/actions/preview', {
        body: JSON.stringify({
          expectedVersions: { [`ChargeItem/${bill.chargeItemId}`]: String(bill.chargeVersion) },
          input: { caseId: visit.caseId, category: 'medication', simulatorRule: 'success' },
        }),
        headers: commandHeaders(visit.cashier),
        method: 'POST',
      })).json(),
    ).data
    paymentResponseSchema.parse(
      await (await runtime.app.request(`/api/his/v1/payments/${payPreview.previewId}/actions/confirm`, {
        body: JSON.stringify({
          expectedVersions: { [`ChargeItem/${payPreview.chargeItemId}`]: String(payPreview.chargeVersion) },
          input: { commitToken: payPreview.commitToken },
        }),
        headers: commandHeaders(visit.cashier),
        method: 'POST',
      })).json(),
    )
    const pharmacyQueue = pharmacyQueueSchema.parse(
      await (await runtime.app.request('/api/his/v1/pharmacy/queue?status=pending&pageSize=20', {
        headers: { cookie: visit.pharmacist },
      })).json(),
    )
    expect(pharmacyQueue.items.find(item => item.prescriptionId === issued.id)?.medications[0]).toMatchObject({
      medicationId: 'medication-nitroglycerin',
      routeCode: 'SL',
    })
  })
})
