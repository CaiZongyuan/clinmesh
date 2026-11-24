import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  billingCaseSchema,
  confirmDiagnosisResponseSchema,
  diagnosisDraftResponseSchema,
  doctorCaseDetailSchema,
  encounterCompletionResponseSchema,
  examinationRequestDraftResponseSchema,
  issueExaminationRequestResponseSchema,
  issuePrescriptionResponseSchema,
  laboratoryServiceCandidateSearchSchema,
  prescriptionDraftResponseSchema,
  publishLaboratoryServicesResponseSchema,
  startVisitResponseSchema,
} from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import {
  inpatientFullCatalogSchema,
  inpatientFullClinicalResponseSchema,
  inpatientPharmacyResponseSchema,
  inpatientPharmacySchema,
} from '@clinmesh/contracts/inpatient-clinical'
import {
  inpatientDischargeResponseSchema,
  inpatientSettlementPreviewSchema,
  inpatientSettlementResponseSchema,
} from '@clinmesh/contracts/inpatient-discharge'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { inpatientFinancialResponseSchema, inpatientFinancialSchema } from '@clinmesh/contracts/inpatient-finance'
import {
  inpatientInvestigationCatalogSchema,
  inpatientInvestigationResponseSchema,
} from '@clinmesh/contracts/inpatient-investigations'
import { insurancePreviewResponseSchema, insuranceResponseSchema } from '@clinmesh/contracts/insurance'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'
import {
  persona,
  signIn,
  startConsultationCase,
  StubSyntheaProvider,
} from './fixtures/consultation.ts'
import {
  acuteBronchitis,
  caseBundle,
  createImagingRuntime,
  generateCase,
  startConsultation,
} from './fixtures/imaging-scenario.ts'
import { inpatientInsuranceFixture } from './fixtures/insurance-inpatient.ts'
import { satisfyOutpatientOrderPrerequisites, signInitialOutpatientDocument } from './fixtures/outpatient-order-gate.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

async function createLabCnReferenceDatabase(directory: string): Promise<string> {
  const databasePath = join(directory, 'reference.sqlite')
  const wstSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026'
  const panelSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-panel-cn'
  const ruleMeta = {
    sourceLocation: 'synthetic-reference',
    sourceStandard: 'WS/T 886-2026',
    sourceType: 'national-standard' as const,
    sourceVersion: '2026',
  }
  const artifact = {
    concepts: [
      {
        code: 'CN-LAB-CBC',
        display: '血常规组合',
        domain: 'laboratory',
        id: 'laboratory-panel-cn:2026-09-01:CN-LAB-CBC',
        sourceLocator: 'synthetic:cn-lab-cbc',
        status: 'active',
        system: panelSystem,
        version: '2026-09-01',
      },
      {
        code: '0100101A',
        display: '白细胞计数',
        domain: 'laboratory',
        id: 'wst-886:2026:0100101A',
        sourceLocator: 'synthetic:0100101A',
        status: 'active',
        system: wstSystem,
        version: '2026',
      },
      {
        code: '1100301A',
        display: '糖化血红蛋白测定',
        domain: 'laboratory',
        id: 'wst-886:2026:1100301A',
        sourceLocator: 'synthetic:1100301A',
        status: 'active',
        system: wstSystem,
        version: '2026',
      },
      {
        code: '2100404A',
        display: '心肌肌钙蛋白I测定',
        domain: 'laboratory',
        id: 'wst-886:2026:2100404A',
        sourceLocator: 'synthetic:2100404A',
        status: 'active',
        system: wstSystem,
        version: '2026',
      },
    ],
    laboratoryDefinitions: [
      {
        conceptId: 'laboratory-panel-cn:2026-09-01:CN-LAB-CBC',
        datasetReleaseId: 'laboratory-cn@2026-09-01.r1',
        kind: 'laboratory-cn-panel',
        notes: '合成血常规组合',
        sourceLocation: 'synthetic:cn-lab-cbc',
        sourceLocator: 'synthetic:cn-lab-cbc',
        sourceType: 'project-authored',
        sourceVersion: '2026-09-01',
        specimen: '全血',
      },
      {
        adultReferenceRules: [{ low: 3.5, high: 9.5, notes: '成人白细胞参考范围', referenceKind: 'range', sex: 'all', simulationLow: 4, simulationHigh: 8, ...ruleMeta }],
        alternateCodings: [],
        analyte: '白细胞计数',
        category: '血细胞分析',
        conceptId: 'wst-886:2026:0100101A',
        datasetReleaseId: 'laboratory-cn@2026-09-01.r1',
        healthyStrategy: 'uniform',
        kind: 'laboratory-cn-test',
        precision: 2,
        resultKind: 'quantity',
        scale: '定量',
        sourceLocator: 'synthetic:0100101A',
        sourceVersion: '2026',
        specimen: '全血',
        unit: { code: '10*9/L', display: '10^9/L', system: 'http://unitsofmeasure.org' },
      },
      {
        adultReferenceRules: [{ low: 4, high: 6, notes: '成人糖化血红蛋白参考范围', referenceKind: 'range', sex: 'all', simulationLow: 4.5, simulationHigh: 5.5, ...ruleMeta }],
        alternateCodings: [],
        analyte: '糖化血红蛋白',
        category: '糖代谢',
        conceptId: 'wst-886:2026:1100301A',
        datasetReleaseId: 'laboratory-cn@2026-09-01.r1',
        healthyStrategy: 'uniform',
        kind: 'laboratory-cn-test',
        precision: 1,
        resultKind: 'quantity',
        scale: '定量',
        sourceLocator: 'synthetic:1100301A',
        sourceVersion: '2026',
        specimen: '全血',
        unit: { code: '%', display: '%', system: 'http://unitsofmeasure.org' },
      },
      {
        adultReferenceRules: [{ high: 40, notes: '成人心肌肌钙蛋白I参考上限', referenceKind: 'upper-bound', sex: 'all', simulationLow: 1, simulationHigh: 15, ...ruleMeta }],
        alternateCodings: [],
        analyte: '心肌肌钙蛋白I',
        category: '心脏标志物',
        conceptId: 'wst-886:2026:2100404A',
        datasetReleaseId: 'laboratory-cn@2026-09-01.r1',
        healthyStrategy: 'uniform',
        kind: 'laboratory-cn-test',
        precision: 1,
        resultKind: 'quantity',
        scale: '定量',
        sourceLocator: 'synthetic:2100404A',
        sourceVersion: '2026',
        specimen: '血清、血浆',
        unit: { code: 'ng/L', display: 'ng/L', system: 'http://unitsofmeasure.org' },
      },
    ],
    laboratoryPanelMembers: [
      {
        memberConceptId: 'wst-886:2026:0100101A',
        memberOrder: 1,
        panelConceptId: 'laboratory-panel-cn:2026-09-01:CN-LAB-CBC',
        relationship: 'contains',
        sourceLocator: 'synthetic:member:cbc:wbc',
      },
    ],
    laboratorySpecimens: [],
    laboratoryUnits: [],
    schemaVersion: '1',
  }
  const artifactJson = `${JSON.stringify(artifact)}\n`
  const artifactPath = join(directory, 'reference.json')
  const manifestPath = join(directory, 'release.json')
  await writeFile(artifactPath, artifactJson)
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      createdAt: '2026-09-01T07:00:00.000Z',
      releaseId: 'item-insurance-ref-v1',
      schemaVersion: '1',
      sources: [
        {
          acquisitionMethod: 'generated',
          artifactPath: 'reference.json',
          checksum: createHash('sha256').update(artifactJson).digest('hex'),
          licenseId: 'LicenseRef-Synthetic-Test',
          retrievedAt: '2026-09-01T07:00:00.000Z',
          sourceId: 'synthetic-lab-cn',
          sourceUrl: 'https://example.test/synthetic-lab-cn',
          upstreamVersion: '2026-test',
        },
      ],
    })}\n`,
  )
  await runReferenceDatabaseCli(['migrate', '--database', databasePath])
  await runReferenceDatabaseCli(['import', '--database', databasePath, '--manifest', manifestPath])
  return databasePath
}

async function setupOutpatient(options: { withLabCnReference?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-item-insurance-'))
  const referenceDatabasePath = options.withLabCnReference ? await createLabCnReferenceDatabase(directory) : undefined
  const runtime = await createClinMeshRuntime({
    authBaseUrl: 'http://localhost',
    authSecret: 'synthetic-item-insurance-secret-at-least-32-chars',
    cursorSecret: 'synthetic-item-insurance-cursor-at-least-32-chars',
    databasePath: join(directory, 'test.sqlite'),
    ...(referenceDatabasePath === undefined ? {} : { referenceDatabasePath }),
    demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply',
    trustedOrigins: ['http://localhost'],
    patientPersonaModel: 'synthetic',
    syntheaProvider: new StubSyntheaProvider(),
    chatCompletionsProvider: {
      async completeJson() {
        return { content: JSON.stringify(persona), model: 'synthetic' }
      },
    },
  })
  cleanups.push(async () => {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  })
  const started = await startConsultationCase(runtime)
  const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const cashier = await signIn(runtime, 'cashier@demo.clinmesh.local')
  const admin = await signIn(runtime, 'admin@demo.clinmesh.local')
  const write = (
    path: string,
    input: object,
    cookie = cashier,
    expectedVersions: Record<string, string> = {},
    method = 'POST',
  ) =>
    runtime.app.request(path, {
      method,
      body: JSON.stringify({ expectedVersions, input }),
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost',
        'idempotency-key': randomUUID(),
      },
    })
  const visit = await write(
    `/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`,
    {},
    doctor,
    { [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1' },
  )
  expect(visit.status, await visit.clone().text()).toBe(200)
  startVisitResponseSchema.parse(await visit.json())
  const readDetail = async () =>
    doctorCaseDetailSchema.parse(
      await (
        await runtime.app.request(`/api/his/v1/doctor/cases/${started.outpatientCaseId}`, {
          headers: { cookie: doctor },
        })
      ).json(),
    )
  const readBill = async () =>
    billingCaseSchema.parse(
      await (
        await runtime.app.request(`/api/his/v1/billing/cases/${started.outpatientCaseId}`, {
          headers: { cookie: cashier },
        })
      ).json(),
    )
  const confirmDiagnoses = async (catalogItemIds: string[]) => {
    const detail = await readDetail()
    const expectedVersions = { [`Encounter/${started.encounterId}`]: detail.encounter.versionId }
    const draft = diagnosisDraftResponseSchema.parse(
      await (
        await write(
          `/api/his/v1/encounters/${started.encounterId}/diagnosis/draft`,
          {
            entries: catalogItemIds.map((catalogItemId, index) => ({
              catalogItemId,
              role: index === 0 ? 'primary' : 'secondary',
            })),
            expectedDraftVersion: detail.diagnosis?.draftVersion ?? 0,
          },
          doctor,
          expectedVersions,
          'PUT',
        )
      ).json(),
    ).data
    const confirmed = await write(
      `/api/his/v1/encounters/${started.encounterId}/diagnosis/actions/confirm`,
      { expectedDraftVersion: draft.draftVersion },
      doctor,
      expectedVersions,
    )
    expect(confirmed.status, await confirmed.clone().text()).toBe(200)
    confirmDiagnosisResponseSchema.parse(await confirmed.json())
  }
  const issuePrescription = async (
    items: Array<{ catalogItemId: string; courseDays: number; doseText: string; frequencyCode: string; quantity: number; routeCode?: string }>,
  ) => {
    await signInitialOutpatientDocument(runtime, doctor, started.outpatientCaseId)
    const detail = await readDetail()
    const expectedVersions = { [`Encounter/${started.encounterId}`]: detail.encounter.versionId }
    const draftRes = await write(
      `/api/his/v1/encounters/${started.encounterId}/prescription/draft`,
      {
        expectedDraftVersion: detail.medicationConclusion?.draftVersion ?? 0,
        items: items.map(item => ({ routeCode: 'PO', ...item })),
      },
      doctor,
      expectedVersions,
      'PUT',
    )
    expect(draftRes.status, await draftRes.clone().text()).toBe(200)
    const draft = prescriptionDraftResponseSchema.parse(await draftRes.json()).data
    const issuedRes = await write(
      `/api/his/v1/encounters/${started.encounterId}/prescription/actions/issue`,
      { expectedDraftVersion: draft.draftVersion },
      doctor,
      expectedVersions,
    )
    expect(issuedRes.status, await issuedRes.clone().text()).toBe(200)
    return issuePrescriptionResponseSchema.parse(await issuedRes.json()).data
  }
  const completeEncounter = async () => {
    await signInitialOutpatientDocument(runtime, doctor, started.outpatientCaseId)
    const detail = await readDetail()
    const expected = { [`Encounter/${started.encounterId}`]: detail.encounter.versionId }
    const encPath = `/api/his/v1/encounters/${started.encounterId}`
    const completedRes = await write(`${encPath}/actions/complete`, {}, doctor, expected)
    expect(completedRes.status, await completedRes.clone().text()).toBe(200)
    encounterCompletionResponseSchema.parse(await completedRes.json())
  }
  return { runtime, started, doctor, cashier, admin, write, readDetail, readBill, confirmDiagnoses, issuePrescription, completeEncounter }
}

describe('品规级甲乙丙医保属性、混合处方明细结算与冻结快照', () => {
  it('门诊混合甲/乙/丙处方按品规明细拆分、目录变更不漂移且支持收费员冲减按比例确定性分摊', async () => {
    const s = await setupOutpatient()
    await s.confirmDiagnoses(['diagnosis-coronary-heart-disease', 'diagnosis-dyslipidemia'])
    const issued = await s.issuePrescription([
      { catalogItemId: 'medication-perindopril', courseDays: 10, doseText: '4 mg', frequencyCode: 'QD', quantity: 10 }, // 甲类 0%, 80*10=800
      { catalogItemId: 'medication-ticagrelor', courseDays: 5, doseText: '90 mg', frequencyCode: 'BID', quantity: 10 }, // 乙类 15%, 150*10=1500
      { catalogItemId: 'medication-ezetimibe', courseDays: 10, doseText: '10 mg', frequencyCode: 'QD', quantity: 10 }, // 丙类, 100*10=1000
    ])
    await s.completeEncounter()

    // Mutate catalog coverage AFTER prescription is issued; frozen snapshot must not drift!
    s.runtime.database.driver
      .prepare(
        `UPDATE outpatient_catalog
         SET config_json = json_set(config_json, '$.insuranceCoverage', json('{"included":false,"priorSelfPayBps":0}'))
         WHERE item_id IN ('medication-perindopril', 'medication-ticagrelor')`,
      )
      .run()
    s.runtime.database.driver
      .prepare(
        `UPDATE outpatient_catalog
         SET config_json = json_set(config_json, '$.insuranceCoverage', json('{"included":true,"priorSelfPayBps":0}'))
         WHERE item_id = 'medication-ezetimibe'`,
      )
      .run()

    const path = `/api/his/v1/insurance/outpatient/${s.started.outpatientCaseId}`
    const previewRes = await s.write(`${path}/preview`, { planCode: 'employee-v1' })
    expect(previewRes.status, await previewRes.clone().text()).toBe(200)
    const preview = insurancePreviewResponseSchema.parse(await previewRes.json()).data
    const rxCharge = (await s.readBill()).charges.find((c) => c.category === 'medication')!
    const rxAlloc = preview.settlement.allocations.find((a) => a.reference === `ChargeItem/${rxCharge.chargeItemId}`)!
    expect(rxAlloc).toMatchObject({
      amountFen: 3300,
      outsideFen: 1000,
      priorSelfPayFen: 225,
      eligibleFen: 2075,
      deductibleFen: 1000,
      fundFen: 752,
      accountFen: 1548,
      patientFen: 1000,
    })
    expect(rxAlloc.items).toEqual([
      expect.objectContaining({ label: '培哚普利片', amountFen: 800, outsideFen: 0, priorSelfPayFen: 0, eligibleFen: 800 }),
      expect.objectContaining({ label: '替格瑞洛片', amountFen: 1500, outsideFen: 0, priorSelfPayFen: 225, eligibleFen: 1275 }),
      expect.objectContaining({ label: '依折麦布片', amountFen: 1000, outsideFen: 1000, priorSelfPayFen: 0, eligibleFen: 0 }),
    ])
    expect(preview.settlement.source.charges.find((c) => c.reference === `ChargeItem/${rxCharge.chargeItemId}`)?.coverage.code).toBe(
      `synthetic-op-medication:Prescription/${issued.prescription.id}`,
    )

    const confirmRes = await s.write(`${path}/confirm`, { previewId: preview.previewId, commitToken: preview.commitToken })
    expect(confirmRes.status, await confirmRes.clone().text()).toBe(200)
    const confirmed = insuranceResponseSchema.parse(await confirmRes.json()).data
    const billAfterConfirm = await s.readBill()
    expect(billAfterConfirm.charges.find((c) => c.chargeItemId === rxCharge.chargeItemId)).toMatchObject({
      insuranceFen: 2300,
      remainingFen: 1000,
    })

    // Cancel settlement, apply cashier fee adjustment (-300 fen -> net 3000 fen), re-preview deterministically.
    const cancelRes = await s.write(`${path}/cancel`, {
      settlementId: confirmed.active!.id,
      expectedBalanceVersion: confirmed.balance.version,
    })
    expect(cancelRes.status, await cancelRes.clone().text()).toBe(200)
    const billAfterCancel = await s.readBill()
    const rxAfterCancel = billAfterCancel.charges.find((c) => c.chargeItemId === rxCharge.chargeItemId)!
    const adjustRes = await s.write(
      `/api/his/v1/billing/cases/${s.started.outpatientCaseId}/adjustments`,
      { chargeItemId: rxCharge.chargeItemId, amountFen: 300, reason: '合成混合处方减免核对' },
      s.cashier,
      { [`ChargeItem/${rxCharge.chargeItemId}`]: String(rxAfterCancel.chargeVersion) },
    )
    expect(adjustRes.status, await adjustRes.clone().text()).toBe(200)
    const adjustedPreviewRes = await s.write(`${path}/preview`, { planCode: 'employee-v1' })
    expect(adjustedPreviewRes.status, await adjustedPreviewRes.clone().text()).toBe(200)
    const adjustedAlloc = insurancePreviewResponseSchema
      .parse(await adjustedPreviewRes.json())
      .data.settlement.allocations.find((a) => a.reference === `ChargeItem/${rxCharge.chargeItemId}`)!
    expect(adjustedAlloc.amountFen).toBe(3000)
    expect(adjustedAlloc.items!.reduce((sum, item) => sum + item.amountFen, 0)).toBe(3000)
    expect(adjustedAlloc.fundFen + adjustedAlloc.accountFen + adjustedAlloc.patientFen).toBe(3000)
  }, 60000)

  it('门诊功能检查区分 ECG 甲类 0% 与 TTE 乙类 10%，且目录变更不影响已开立费用', async () => {
    const s = await setupOutpatient()
    await satisfyOutpatientOrderPrerequisites(s.runtime, s.doctor, s.started.outpatientCaseId)
    const issueExam = async (serviceId: 'examination-ecg-12-lead' | 'examination-tte') => {
      const detail = await s.readDetail()
      const expectedVersions = { [`Encounter/${s.started.encounterId}`]: detail.encounter.versionId }
      const draft = examinationRequestDraftResponseSchema.parse(
        await (
          await s.write(
            `/api/his/v1/encounters/${s.started.encounterId}/examination-request/draft`,
            { expectedDraftVersion: detail.examinationRequests?.draftVersion ?? 0, indication: '合成心功能评估', serviceId },
            s.doctor,
            expectedVersions,
            'PUT',
          )
        ).json(),
      ).data
      return issueExaminationRequestResponseSchema.parse(
        await (
          await s.write(
            `/api/his/v1/encounters/${s.started.encounterId}/examination-request/actions/issue`,
            { expectedDraftVersion: draft.draftVersion },
            s.doctor,
            expectedVersions,
          )
        ).json(),
      ).data.request
    }
    const ecg = await issueExam('examination-ecg-12-lead')
    const tte = await issueExam('examination-tte')
    s.runtime.database.driver
      .prepare(
        `UPDATE hospital_service_catalog
         SET config_json = json_set(config_json, '$.examinationService.insuranceCoverage', json('{"included":false,"priorSelfPayBps":0}'))
         WHERE service_id IN ('examination-ecg-12-lead', 'examination-tte')`,
      )
      .run()
    const previewRes = await s.write(`/api/his/v1/insurance/outpatient/${s.started.outpatientCaseId}/preview`, {
      planCode: 'employee-v1',
    })
    expect(previewRes.status, await previewRes.clone().text()).toBe(200)
    const allocations = insurancePreviewResponseSchema.parse(await previewRes.json()).data.settlement.allocations
    expect(allocations.find((a) => a.reference === `ChargeItem/${ecg.billing!.chargeItemId}`)).toMatchObject({
      amountFen: 3000,
      outsideFen: 0,
      priorSelfPayFen: 0,
      eligibleFen: 3000,
    })
    expect(allocations.find((a) => a.reference === `ChargeItem/${tte.billing!.chargeItemId}`)).toMatchObject({
      amountFen: 18000,
      outsideFen: 0,
      priorSelfPayFen: 1800,
      eligibleFen: 16200,
    })
  }, 60000)

  it('住院医嘱与检查按开立时冻结甲乙丙快照结算，目录变更不漂移且后续医保更正沿用原冻结属性', async () => {
    const bundle = caseBundle({
      gender: 'male',
      index: [{ ...acuteBronchitis, resourceType: 'Condition' }],
      name: '住院品规医保合成患者',
    })
    const item = await createImagingRuntime([
      { ...bundle, entry: bundle.entry.filter((entry) => entry.resource.id !== 'prior-fact-0') },
    ], { persona: true })
    cleanups.push(async () => {
      await item.runtime.close()
      await rm(item.directory, { recursive: true, force: true })
    })
    const admin = await signIn(item.runtime, 'admin@demo.clinmesh.local')
    const source = await generateCase(item.runtime, admin)
    const visit = await startConsultation(item.runtime, admin, source, { pulseBpm: 76 })
    const s = { runtime: item.runtime }
    const cookies = new Map<string, string>()
    const login = async (role: string) => {
      if (!cookies.has(role)) cookies.set(role, await signIn(s.runtime, `${role}@demo.clinmesh.local`))
      return cookies.get(role)!
    }
    const req = async (role: string, url: string, input?: unknown) =>
      s.runtime.app.request(url, {
        method: input === undefined ? 'GET' : 'POST',
        headers: {
          cookie: await login(role),
          origin: 'http://localhost',
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        ...(input === undefined ? {} : { body: JSON.stringify({ input }) }),
      })
    const insurance = async (admissionId: string, action: string, input: unknown) =>
      s.runtime.app.request(`/api/his/v1/insurance/inpatient/${admissionId}/${action}`, {
        method: 'POST',
        headers: {
          cookie: await login('cashier'),
          origin: 'http://localhost',
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify({ input, expectedVersions: {} }),
      })
    const patient = fhirResourceSchema.parse(
      await (await req('registrar', `/fhir/R5/Patient/${visit.patientId}`)).json(),
    )
    const regRes = await req('registrar', '/api/his/v1/inpatient/admissions', {
      expectedEpoch: 'epoch-1',
      patientId: patient.id,
      patientVersion: patient.meta!.versionId,
      admissionRoute: 'direct',
      wardId: 'ward-general',
      depositFen: 50000,
    })
    expect(regRes.status, await regRes.clone().text()).toBe(200)
    const registered = inpatientCommandResponseSchema.parse(await regRes.json()).data.admission
    const recRes = await req('ward-nurse', `/api/his/v1/inpatient/admissions/${registered.id}/receive`, {
      encounterVersion: registered.versionId,
      bedId: 'bed-general-1',
    })
    expect(recRes.status, await recRes.clone().text()).toBe(200)
    const admission = inpatientCommandResponseSchema.parse(await recRes.json()).data.admission
    const path = `/api/his/v1/inpatient/admissions/${admission.id}`
    let encounterVersion = admission.versionId

    // Issue ECG (甲类 0%, 3000) and TTE (乙类 10%, 18000) before confirming cardiovascular diagnoses
    const invCatalog = inpatientInvestigationCatalogSchema.parse(
      await (await req('inpatient-doctor', '/api/his/v1/inpatient/investigation-catalog')).json(),
    )
    const runExam = async (serviceId: 'examination-ecg-12-lead' | 'examination-tte') => {
      const item = invCatalog.items.find((i) => i.id === serviceId)!
      const issued = await req('inpatient-doctor', `${path}/investigations/issue`, {
        encounterVersion,
        catalogVersion: item.version,
        selection: { kind: 'examination', serviceId, indication: '合成住院心功能评估' },
      })
      expect(issued.status, await issued.clone().text()).toBe(200)
      const inv = inpatientInvestigationResponseSchema.parse(await issued.json()).data
      const examReq = inv.examinationRequests.find((r) => r.service.id === serviceId)!
      const sent = await req('ward-nurse', `${path}/investigations/send`, {
        requestId: examReq.id,
        expectedRequestVersion: examReq.version,
        serviceRequestVersion: examReq.serviceRequestVersion,
        taskVersion: examReq.taskVersion,
      })
      expect(sent.status, await sent.clone().text()).toBe(200)
      while ((await s.runtime.dispatcher.dispatchOnce()) !== undefined) { /* drain deterministic examination outbox */ }
    }
    await runExam('examination-ecg-12-lead')
    await runExam('examination-tte')
    const examFacts = await (await req('inpatient-doctor', `${path}/investigations`)).json()
    expect(examFacts.examinationRequests.map((r: { service: { id: string }; status: string }) => ({ id: r.service.id, status: r.status }))).toEqual([
      { id: 'examination-ecg-12-lead', status: 'reported' },
      { id: 'examination-tte', status: 'reported' },
    ])

    const confirmDiag = await req('inpatient-doctor', `${path}/diagnoses/confirm`, {
      encounterVersion,
      expectedRevision: 0,
      entries: [
        { catalogItemId: 'diagnosis-coronary-heart-disease', role: 'primary', admissionCondition: '1' },
        { catalogItemId: 'diagnosis-dyslipidemia', role: 'secondary', admissionCondition: '1' },
      ],
    })
    expect(confirmDiag.status, await confirmDiag.clone().text()).toBe(200)
    encounterVersion = inpatientFullClinicalResponseSchema.parse(await confirmDiag.json()).data.encounterVersion
    const catalog = inpatientFullCatalogSchema.parse(await (await req('inpatient-doctor', '/api/his/v1/inpatient/clinical-catalog')).json())

    const issueAndRunOrder = async (selection: Record<string, unknown>) => {
      const issued = await req('inpatient-doctor', `${path}/orders/issue`, {
        encounterVersion,
        duration: 'temporary',
        selection,
      })
      expect(issued.status, await issued.clone().text()).toBe(200)
      const data = inpatientFullClinicalResponseSchema.parse(await issued.json()).data
      encounterVersion = data.encounterVersion
      const order = data.orders.at(-1)!
      const verified = await req('ward-nurse', `${path}/orders/verify`, {
        orderId: order.id,
        expectedOrderVersion: order.version,
      })
      expect(verified.status, await verified.clone().text()).toBe(200)
      const afterVerify = inpatientFullClinicalResponseSchema.parse(await verified.json()).data
      const execution = afterVerify.executions.find((e) => e.orderId === order.id)!
      if (order.kind === 'medication') {
        const pharmacy = inpatientPharmacySchema.parse(await (await req('pharmacist', `${path}/pharmacy`)).json())
        const lot = pharmacy.medications.find((m) => m.id === order.catalogItemId)!.lots[0]!
        const dispensed = await req('pharmacist', `${path}/executions/dispense`, {
          executionId: execution.id,
          expectedExecutionVersion: execution.version,
          lotSelections: [{ lotId: lot.id, expectedVersion: lot.version, quantity: order.doseQuantity }],
        })
        expect(dispensed.status, await dispensed.clone().text()).toBe(200)
        const afterDispense = inpatientPharmacyResponseSchema.parse(await dispensed.json()).data
        const dispensedExec = afterDispense.executions.find((e) => e.id === execution.id)!
        const administered = await req('ward-nurse', `${path}/executions/administer`, {
          executionId: dispensedExec.id,
          expectedExecutionVersion: dispensedExec.version,
        })
        expect(administered.status, await administered.clone().text()).toBe(200)
      } else {
        const completed = await req('ward-nurse', `${path}/executions/complete`, {
          executionId: execution.id,
          expectedExecutionVersion: execution.version,
        })
        expect(completed.status, await completed.clone().text()).toBe(200)
      }
    }

    const perindopril = catalog.medications.find((m) => m.id === 'medication-perindopril')!
    const ticagrelor = catalog.medications.find((m) => m.id === 'medication-ticagrelor')!
    const ezetimibe = catalog.medications.find((m) => m.id === 'medication-ezetimibe')!
    const education = catalog.services.find((svc) => svc.id === 'hospital-service-diabetes-education')!

    await issueAndRunOrder({ kind: 'medication', catalogItemId: perindopril.id, catalogVersion: perindopril.version, doseText: '4 mg', doseQuantity: 1, frequencyCode: 'ONCE', routeCode: 'PO' }) // 甲类 0%, 80
    await issueAndRunOrder({ kind: 'medication', catalogItemId: ticagrelor.id, catalogVersion: ticagrelor.version, doseText: '90 mg', doseQuantity: 1, frequencyCode: 'ONCE', routeCode: 'PO' }) // 乙类 15%, 150 -> prior 22, eligible 128
    await issueAndRunOrder({ kind: 'medication', catalogItemId: ezetimibe.id, catalogVersion: ezetimibe.version, doseText: '10 mg', doseQuantity: 1, frequencyCode: 'ONCE', routeCode: 'PO' }) // 丙类, 100
    await issueAndRunOrder({ kind: 'service', serviceId: education.id, serviceVersion: education.version, quantity: 1 }) // 丙类, 3000

    // Mutate BOTH catalogs before departure/settlement to prove snapshot immutability!
    s.runtime.database.driver
      .prepare("UPDATE outpatient_catalog SET config_json = json_set(config_json, '$.insuranceCoverage', json('{\"included\":false,\"priorSelfPayBps\":0}'))")
      .run()
    s.runtime.database.driver
      .prepare("UPDATE hospital_service_catalog SET config_json = json_set(config_json, '$.insuranceCoverage', json('{\"included\":false,\"priorSelfPayBps\":0}'))")
      .run()

    const latestDetail = await (await req('inpatient-doctor', path)).json()
    const issueDischarge = await req('inpatient-doctor', `${path}/discharge/issue`, {
      encounterVersion: latestDetail.admission.versionId,
      reason: '合成治疗完成',
      clinicalOverride: {
        acknowledgedAlerts: ['DISCHARGE_ANTIPLATELET_MISSING', 'DISCHARGE_STATIN_MISSING'],
        reasonCode: 'clinical-judgement',
        note: '合成医保单测确认临时医嘱覆盖说明',
      },
    })
    expect(issueDischarge.status, await issueDischarge.clone().text()).toBe(200)
    const issuedDischarge = inpatientDischargeResponseSchema.parse(await issueDischarge.json()).data.admission
    const departRes = await req('ward-nurse', `${path}/discharge/depart`, {
      encounterVersion: issuedDischarge.versionId,
      reason: '合成出区核对完成',
      departureMethod: 'home',
    })
    expect(departRes.status, await departRes.clone().text()).toBe(200)

    const previewRes = await insurance(admission.id, 'preview', { planCode: 'employee-v1' })
    expect(previewRes.status, await previewRes.clone().text()).toBe(200)
    const preview = insurancePreviewResponseSchema.parse(await previewRes.json()).data
    const byLabel = (prefix: string) => {
      const charge = preview.settlement.source.charges.find((c) => c.label.startsWith(prefix))!
      return preview.settlement.allocations.find((a) => a.reference === charge.reference)!
    }
    expect(byLabel('培哚普利片')).toMatchObject({ amountFen: 80, outsideFen: 0, priorSelfPayFen: 0, eligibleFen: 80 })
    expect(byLabel('替格瑞洛片')).toMatchObject({ amountFen: 150, outsideFen: 0, priorSelfPayFen: 22, eligibleFen: 128 })
    expect(byLabel('依折麦布片')).toMatchObject({ amountFen: 100, outsideFen: 100, priorSelfPayFen: 0, eligibleFen: 0 })
    expect(byLabel('糖尿病健康教育')).toMatchObject({ amountFen: 3000, outsideFen: 3000, priorSelfPayFen: 0, eligibleFen: 0 })
    expect(byLabel('常规十二导联心电图')).toMatchObject({ amountFen: 3000, outsideFen: 0, priorSelfPayFen: 0, eligibleFen: 3000 })
    expect(byLabel('经胸超声心动图')).toMatchObject({ amountFen: 18000, outsideFen: 0, priorSelfPayFen: 1800, eligibleFen: 16200 })

    // Confirm insurance, settle first financial bill, then test post-settlement InpatientInsuranceAdjustments!
    const confirmRes = await insurance(admission.id, 'confirm', { previewId: preview.previewId, commitToken: preview.commitToken })
    expect(confirmRes.status, await confirmRes.clone().text()).toBe(200)
    const settlementPreview = inpatientSettlementPreviewSchema.parse(
      await (await req('cashier', `${path}/discharge/preview`)).json(),
    )
    const settleRes = await req('cashier', `${path}/discharge/settle`, {
      encounterVersion: settlementPreview.encounterVersion,
      fingerprint: settlementPreview.fingerprint,
      expectedChargesFen: settlementPreview.chargesFen,
      expectedBalanceFen: settlementPreview.balanceFen,
    })
    expect(settleRes.status, await settleRes.clone().text()).toBe(200)
    inpatientSettlementResponseSchema.parse(await settleRes.json())

    // Post-settlement decrease on TTE (乙类 10%) by 1000 fen -> verify replacement settlement preserves 10% priorSelfPayBps!
    const financialBefore = inpatientFinancialSchema.parse(await (await req('cashier', `${path}/financial-adjustments`)).json())
    const tteCharge = financialBefore.charges.find((c) => c.label === '经胸超声心动图')!
    const adjRes = await req('cashier', `${path}/financial-adjustments`, {
      chargeId: tteCharge.chargeId,
      amountFen: 1000,
      reason: '合成 TTE 费用更正验证冻结覆盖率',
      expectedFingerprint: financialBefore.fingerprint,
    })
    expect(adjRes.status, await adjRes.clone().text()).toBe(200)
    const afterAdj = inpatientFinancialResponseSchema.parse(await adjRes.json()).data
    const adjId = afterAdj.adjustments.at(-1)!.adjustmentId
    const cancelAdjRes = await req('cashier', `${path}/financial-adjustments/${adjId}/insurance/cancel`, {
      settlementId: afterAdj.insurance!.active!.id,
      expectedBalanceVersion: afterAdj.insurance!.balance.version,
      expectedFingerprint: afterAdj.fingerprint,
    })
    expect(cancelAdjRes.status, await cancelAdjRes.clone().text()).toBe(200)
    const afterAdjCancel = inpatientFinancialResponseSchema.parse(await cancelAdjRes.json()).data
    const revPreviewRes = await req('cashier', `${path}/financial-adjustments/${adjId}/insurance/preview`, {
      expectedFingerprint: afterAdjCancel.fingerprint,
    })
    expect(revPreviewRes.status, await revPreviewRes.clone().text()).toBe(200)
    const revPreview = insurancePreviewResponseSchema.parse(await revPreviewRes.json()).data
    const revTte = revPreview.settlement.allocations.find((a) => a.reference === `ChargeItem/${tteCharge.chargeId}`)!
    expect(revTte).toMatchObject({ amountFen: 17000, outsideFen: 0, priorSelfPayFen: 1700, eligibleFen: 15300 })
  }, 90000)

  it('缺少品规医保映射的门诊处方与住院费用以 409 INSURANCE_COVERAGE_UNAVAILABLE 拒绝，不回退零待遇', async () => {
    const s = await setupOutpatient()
    await s.confirmDiagnoses(['diagnosis-fever'])
    s.runtime.database.driver
      .prepare("UPDATE outpatient_catalog SET config_json = json_remove(config_json, '$.insuranceCoverage') WHERE item_id = 'medication-acetaminophen'")
      .run()
    await s.issuePrescription([
      { catalogItemId: 'medication-acetaminophen', courseDays: 3, doseText: '0.5 g', frequencyCode: 'PRN', quantity: 6 },
    ])
    await s.completeEncounter()
    const deniedOutpatient = await s.write(`/api/his/v1/insurance/outpatient/${s.started.outpatientCaseId}/preview`, {
      planCode: 'employee-v1',
    })
    expect(deniedOutpatient.status).toBe(409)
    expect(await deniedOutpatient.json()).toMatchObject({ error: { code: 'INSURANCE_COVERAGE_UNAVAILABLE' } })

    const ip = await inpatientInsuranceFixture()
    cleanups.push(ip.close)
    const admission = await ip.admit()
    const path = `/api/his/v1/inpatient/admissions/${admission.id}`
    ip.runtime.database.driver
      .prepare("UPDATE hospital_service_catalog SET config_json = json_remove(config_json, '$.insuranceCoverage') WHERE service_id = 'hospital-service-diabetes-education'")
      .run()
    const issued = await ip.request('inpatient-doctor', `${path}/orders/issue`, {
      encounterVersion: admission.versionId,
      duration: 'temporary',
      selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 },
    })
    expect(issued.status, await issued.clone().text()).toBe(200)
    const order = inpatientFullClinicalResponseSchema.parse(await issued.json()).data.orders.at(-1)!
    const verified = await ip.request('ward-nurse', `${path}/orders/verify`, {
      orderId: order.id,
      expectedOrderVersion: order.version,
    })
    const execution = inpatientFullClinicalResponseSchema.parse(await verified.json()).data.executions.find((e) => e.orderId === order.id)!
    expect(
      (await ip.request('ward-nurse', `${path}/executions/complete`, { executionId: execution.id, expectedExecutionVersion: execution.version })).status,
    ).toBe(200)
    const latest = await (await ip.request('inpatient-doctor', path)).json()
    await ip.depart(latest.admission)
    const deniedInpatient = await ip.insurance(admission.id, 'preview', { planCode: 'employee-v1' })
    expect(deniedInpatient.status).toBe(409)
    expect(await deniedInpatient.json()).toMatchObject({ error: { code: 'INSURANCE_COVERAGE_UNAVAILABLE' } })
  }, 60000)

  it('已发布 laboratory-cn 区分常规甲类与专科标志物乙类 10%，且支持发布时覆盖 insuranceCoverage', async () => {
    const s = await setupOutpatient({ withLabCnReference: true })
    const readLabCoverage = (code: string) => {
      const row = s.runtime.database.driver
        .prepare(
          `SELECT json_extract(config_json, '$.laboratoryService.insuranceCoverage') AS cov
           FROM hospital_service_catalog
           WHERE active = 1 AND json_extract(config_json, '$.laboratoryService.referenceConcept.code') = ?
             AND json_extract(config_json, '$.laboratoryService.doctorOrderable') = 1`,
        )
        .get(code) as { cov: string } | undefined
      return row ? JSON.parse(row.cov) : undefined
    }
    expect(readLabCoverage('CN-LAB-CBC')).toEqual({ included: true, priorSelfPayBps: 0 })
    expect(readLabCoverage('1100301A')).toEqual({ included: true, priorSelfPayBps: 1000 })
    expect(readLabCoverage('2100404B')).toEqual({ included: true, priorSelfPayBps: 1000 })

    // Re-publish hs-cTnI (2100404B) with an explicit insuranceCoverage override
    const candidatesRes = await s.runtime.app.request(
      '/api/his/v1/admin/laboratory-services/candidates?sourceDataset=laboratory-cn&page=1&pageSize=50&query=2100404B',
      { headers: { cookie: s.admin } },
    )
    expect(candidatesRes.status, await candidatesRes.clone().text()).toBe(200)
    const candidate = laboratoryServiceCandidateSearchSchema
      .parse(await candidatesRes.json())
      .items.find((item) => item.concept.code === '2100404B')!
    const publishRes = await s.runtime.app.request('/api/his/v1/admin/laboratory-services/actions/publish', {
      method: 'POST',
      body: JSON.stringify({
        input: {
          entries: [
            {
              conceptId: candidate.concept.id,
              expectedVersion: candidate.version,
              insuranceCoverage: { included: true, priorSelfPayBps: 1500 },
            },
          ],
        },
      }),
      headers: {
        'content-type': 'application/json',
        cookie: s.admin,
        origin: 'http://localhost',
        'idempotency-key': randomUUID(),
      },
    })
    expect(publishRes.status, await publishRes.clone().text()).toBe(200)
    publishLaboratoryServicesResponseSchema.parse(await publishRes.json())
    await s.runtime.laboratoryServicePublisher.processNext()
    expect(readLabCoverage('2100404B')).toEqual({ included: true, priorSelfPayBps: 1500 })
  }, 60000)
})
