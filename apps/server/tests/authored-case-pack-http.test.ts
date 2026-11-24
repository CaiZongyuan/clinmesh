import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { clinicalQualityCheckSchema } from '@clinmesh/contracts/clinical-quality'
import { clinicalScoreBundleSchema } from '@clinmesh/contracts/clinical-scores'
import { fhirBundleSchema } from '@clinmesh/contracts/fhir'
import {
  acknowledgeLaboratoryReportResponseSchema,
  apiErrorSchema,
  billingCaseSchema,
  caseLaboratoryCatalogSearchSchema,
  clinicalDocumentRevisionResponseSchema,
  confirmDiagnosisResponseSchema,
  confirmNoMedicationResponseSchema,
  diagnosisDraftResponseSchema,
  doctorCaseDetailSchema,
  doctorQueueSchema,
  encounterCompletionResponseSchema,
  examinationRequestSchema,
  issueLaboratoryRequestResponseSchema,
  issuePrescriptionResponseSchema,
  laboratoryRequestDraftResponseSchema,
  patientSearchSchema,
  paymentPreviewResponseSchema,
  paymentResponseSchema,
  prescriptionDraftResponseSchema,
  registrationCatalogSchema,
  registrationResponseSchema,
  sendConsultationMessageResponseSchema,
  sessionContextSchema,
  startVisitResponseSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { doctorCaseHistorySchema } from '@clinmesh/contracts/agent'
import { commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations-runtime'
import { inpatientCommandResponseSchema, inpatientDetailSchema, inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { inpatientAngiographyReportsSchema } from '@clinmesh/contracts/inpatient-angiography'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationCatalogSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import {
  authoredCasePackPrepareResponseSchema,
  authoredCasePackSummarySchema,
  pciCaseSourceResponseSchema,
  startSyntheticInpatientCaseResponseSchema,
} from '@clinmesh/contracts/inpatient-pci-data'
import { inpatientSurgeryCatalogSchema, inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import {
  administratorCaseTruthSchema,
  patientPersonaJobSchema,
  patientPersonaRevisionListSchema,
  patientPersonaRevisionSchema,
  startSyntheticCaseResultSchema,
  syntheticPatientProfileListSchema,
} from '@clinmesh/contracts/scenario'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { defaultOutpatientGateDocument, satisfyOutpatientOrderPrerequisites } from './fixtures/outpatient-order-gate.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function createCardiologyReferenceDb(directory: string) {
  const databasePath = join(directory, 'cardiology-reference.sqlite')
  const wstSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026'
  const panelSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-panel-cn'
  const datasetReleaseId = 'laboratory-cn@2026-09-01.r1'
  const rangeRule = (low: number, high: number, sex: 'all' | 'female' | 'male' = 'all') => ({
    high, low, notes: '合成成人参考区间', referenceKind: 'range' as const, sex,
    simulationHigh: high, simulationLow: low, sourceLocation: '表 1',
    sourceStandard: 'WS/T 886-2026', sourceType: 'national-standard' as const, sourceVersion: '2026',
  })
  const upperRule = (high: number, simulationLow: number, sex: 'all' | 'female' | 'male' = 'all') => ({
    high, notes: '合成成人参考上限', referenceKind: 'upper-bound' as const, sex,
    simulationHigh: high, simulationLow, sourceLocation: '表 1',
    sourceStandard: 'WS/T 886-2026', sourceType: 'project-curated' as const, sourceVersion: '2026-09-01',
  })
  const testItem = (
    code: string,
    display: string,
    specimen: string,
    unitCode: string,
    precision: number,
    rules: Array<ReturnType<typeof rangeRule> | ReturnType<typeof upperRule>>,
  ) => ({
    concept: {
      code, display, domain: 'laboratory' as const, id: `wst-886:2026:${code}`,
      sourceLocator: `synthetic:laboratory-cn:test:${code}`, status: 'active' as const,
      system: wstSystem, version: '2026',
    },
    definition: {
      adultReferenceRules: rules, alternateCodings: [], analyte: display, category: '临床检验',
      conceptId: `wst-886:2026:${code}`, datasetReleaseId, healthyStrategy: 'uniform' as const,
      kind: 'laboratory-cn-test' as const, precision, resultKind: 'quantity' as const, scale: '定量',
      sourceLocator: `synthetic:laboratory-cn:test:${code}`, sourceVersion: '2026', specimen,
      unit: { code: unitCode, display: unitCode, system: 'http://unitsofmeasure.org' as const },
    },
  })
  const panelItem = (code: string, display: string, specimen: string, members: string[]) => ({
    concept: {
      code, display, domain: 'laboratory' as const, id: `laboratory-panel-cn:2026-09-01:${code}`,
      sourceLocator: `synthetic:laboratory-cn:panel:${code}`, status: 'active' as const,
      system: panelSystem, version: '2026-09-01',
    },
    definition: {
      conceptId: `laboratory-panel-cn:2026-09-01:${code}`, datasetReleaseId,
      kind: 'laboratory-cn-panel' as const, notes: display, sourceLocation: '检验组合',
      sourceLocator: `synthetic:laboratory-cn:panel:${code}`, sourceType: 'project-authored' as const,
      sourceVersion: '2026-09-01', specimen,
    },
    members: members.map((memberCode, index) => ({
      memberConceptId: `wst-886:2026:${memberCode}`, memberOrder: index + 1,
      panelConceptId: `laboratory-panel-cn:2026-09-01:${code}`, relationship: 'contains' as const,
      sourceLocator: `synthetic:laboratory-cn:panel:${code}:${index + 1}`,
    })),
  })
  const tests = [
    testItem('0100101A', '白细胞计数', '全血', '10*9/L', 2, [rangeRule(3.5, 9.5)]),
    testItem('0100201A', '红细胞计数', '全血', '10*12/L', 2, [rangeRule(4.3, 5.8, 'male'), rangeRule(3.8, 5.1, 'female')]),
    testItem('0100301A', '血小板计数', '全血', '10*9/L', 0, [rangeRule(125, 350)]),
    testItem('0100401A', '血红蛋白测定', '全血', 'g/L', 0, [rangeRule(130, 175, 'male'), rangeRule(115, 150, 'female')]),
    testItem('0100501A', '红细胞比容', '全血', 'L/L', 2, [rangeRule(0.4, 0.5, 'male'), rangeRule(0.35, 0.45, 'female')]),
    testItem('0100601A', '平均红细胞体积', '全血', 'fL', 1, [rangeRule(82, 100)]),
    testItem('0100701A', '平均红细胞血红蛋白含量', '全血', 'pg', 1, [rangeRule(27, 34)]),
    testItem('0100801A', '平均红细胞血红蛋白浓度', '全血', 'g/L', 0, [rangeRule(316, 354)]),
    testItem('2100104A', '肌酸激酶同工酶测定', '血清、血浆', 'U/L', 1, [upperRule(24, 2)]),
    testItem('2100304A', '肌红蛋白测定', '血清、血浆', 'ng/mL', 1, [upperRule(72, 10)]),
    testItem('2100404A', '心肌肌钙蛋白I测定', '血清、血浆', 'ng/mL', 3, [upperRule(0.04, 0.002)]),
    testItem('2100504A', '心肌肌钙蛋白T测定', '血清、血浆', 'ng/mL', 3, [upperRule(0.014, 0.003)]),
    testItem('2100604A', '脑利钠肽测定', '血清、血浆', 'ng/L', 1, [upperRule(100, 5)]),
    testItem('2100704A', '氨基末端脑利钠肽前体测定', '血清、血浆', 'ng/L', 0, [upperRule(125, 15)]),
    testItem('2000104A', '总胆固醇测定', '血清、血浆', 'mmol/L', 2, [upperRule(5.2, 3.1)]),
    testItem('2000204A', '甘油三酯测定', '血清、血浆', 'mmol/L', 2, [upperRule(1.7, 0.4)]),
    testItem('2000304A', '高密度脂蛋白胆固醇测定', '血清、血浆', 'mmol/L', 2, [rangeRule(1.0, 2.0)]),
    testItem('2000404A', '低密度脂蛋白胆固醇测定', '血清、血浆', 'mmol/L', 2, [upperRule(3.4, 1.5)]),
    testItem('2000604A', '载脂蛋白A1测定', '血清、血浆', 'g/L', 2, [rangeRule(1.0, 1.6)]),
    testItem('2000704A', '载脂蛋白B测定', '血清、血浆', 'g/L', 2, [rangeRule(0.6, 1.1)]),
    testItem('1700204A', '尿素测定', '血清、血浆', 'mmol/L', 2, [rangeRule(2.8, 7.6)]),
    testItem('1700304A', '尿酸测定', '血清、血浆', 'umol/L', 0, [rangeRule(208, 428, 'male'), rangeRule(155, 357, 'female')]),
    testItem('1700404A', '肌酐测定', '血清、血浆', 'umol/L', 0, [rangeRule(57, 97, 'male'), rangeRule(41, 73, 'female')]),
    testItem('1101204A', '胱抑素C测定', '血清、血浆', 'mg/L', 2, [rangeRule(0.51, 1.09)]),
    testItem('1400205A', '钠测定', '血清、血浆', 'mmol/L', 1, [rangeRule(137, 147)]),
    testItem('1400305A', '镁测定', '血清、血浆', 'mmol/L', 2, [rangeRule(0.75, 1.02)]),
    testItem('1400404A', '无机磷测定', '血清、血浆', 'mmol/L', 2, [rangeRule(0.85, 1.51)]),
    testItem('1400505A', '氯测定', '血清、血浆', 'mmol/L', 1, [rangeRule(99, 110)]),
    testItem('1400605A', '钾测定', '血清、血浆', 'mmol/L', 2, [rangeRule(3.5, 5.3)]),
    testItem('1400705A', '总钙测定', '血清、血浆', 'mmol/L', 2, [rangeRule(2.11, 2.52)]),
    testItem('1100301A', '糖化血红蛋白测定', '全血', '%', 1, [rangeRule(4.0, 6.0)]),
    testItem('0501703A', 'D-二聚体测定', '血浆', 'mg/L', 2, [upperRule(0.5, 0.05)]),
  ]
  const panels = [
    panelItem('CN-LAB-CBC-5DIFF', '血常规（五分类）', '全血', ['0100101A', '0100201A', '0100301A', '0100401A', '0100501A', '0100601A', '0100701A', '0100801A']),
    panelItem('CN-LAB-CARDIAC', '心肌损伤标志物组合', '血清、血浆', ['2100104A', '2100304A', '2100404A', '2100504A', '2100604A', '2100704A']),
    panelItem('CN-LAB-LIPIDS', '血脂组合', '血清、血浆', ['2000104A', '2000204A', '2000304A', '2000404A', '2000604A', '2000704A']),
    panelItem('CN-LAB-RENAL', '肾功能组合', '血清、血浆', ['1700204A', '1700304A', '1700404A', '1101204A']),
    panelItem('CN-LAB-ELECTROLYTES', '电解质组合', '血清、血浆', ['1400205A', '1400305A', '1400404A', '1400505A', '1400605A', '1400705A']),
    panelItem('CN-LAB-HBA1C', '糖化血红蛋白组合', '全血', ['1100301A']),
    panelItem('CN-LAB-COAGULATION', '凝血筛查组合', '血浆', ['0501703A']),
  ]
  const artifactJson = `${JSON.stringify({
    concepts: [...tests.map(item => item.concept), ...panels.map(item => item.concept)],
    laboratoryDefinitions: [...tests.map(item => item.definition), ...panels.map(item => item.definition)],
    laboratoryPanelMembers: panels.flatMap(item => item.members),
    laboratorySpecimens: [],
    laboratoryUnits: [],
    schemaVersion: '1',
  })}\n`
  const manifestPath = join(directory, 'cardiology-release.json')
  await writeFile(join(directory, 'cardiology-reference.json'), artifactJson)
  await writeFile(manifestPath, `${JSON.stringify({
    createdAt: '2026-09-02T00:00:00.000Z',
    releaseId: 'cardiology-reference-v1',
    schemaVersion: '1',
    sources: [{
      acquisitionMethod: 'generated',
      artifactPath: 'cardiology-reference.json',
      checksum: createHash('sha256').update(artifactJson).digest('hex'),
      licenseId: 'LicenseRef-Synthetic-Test',
      retrievedAt: '2026-09-02T00:00:00.000Z',
      sourceId: 'cn-health-laboratory-cn',
      sourceUrl: 'https://example.test/laboratory-cn',
      upstreamVersion: '2026-09-01',
    }],
  })}\n`)
  await runReferenceDatabaseCli(['migrate', '--database', databasePath])
  await runReferenceDatabaseCli(['import', '--database', databasePath, '--manifest', manifestPath])
  return databasePath
}

async function setup(options: { withCardiologyLabs?: boolean; withDialogue?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-authored-pack-'))
  const password = `Synthetic-${randomUUID()}-Aa1!`
  const unexpectedModelCalls: string[] = []
  const dialogueInputs: Array<{ systemPrompt: string; userPayload: unknown }> = []
  const referenceDatabasePath = options.withCardiologyLabs ? await createCardiologyReferenceDb(directory) : undefined
  const runtime = await createClinMeshRuntime({
    ...(referenceDatabasePath === undefined
      ? {}
      : { activeReferenceReleaseId: 'cardiology-reference-v1', referenceDatabasePath }),
    ...(options.withDialogue ? { consultationModel: 'synthetic-authored-dialogue' } : {}),
    authBaseUrl: 'http://localhost',
    authSecret: randomUUID() + randomUUID(),
    chatCompletionsProvider: {
      async completeJson(input) {
        if (options.withDialogue && input.schemaName === 'patient_dialogue_reply') {
          dialogueInputs.push({ systemPrompt: input.systemPrompt, userPayload: input.userPayload })
          return { content: JSON.stringify({ reply: '医生您好，我胸口闷痛一阵一阵的，走路快了更明显。' }), model: input.model }
        }
        if (options.withDialogue && (input.usageContext?.stage === 'recording' || input.schemaName === 'clinical_document_quality' || input.schemaName === 'clinical_document_quality_verification')) {
          return { content: JSON.stringify(input.schemaName.startsWith('clinical_document_quality') ? { issues: [], agentFactChecks: [], recordingChecks: [] } : { changes: [], additions: [] }), model: input.model }
        }
        unexpectedModelCalls.push(input.schemaName)
        throw new Error(`专病合成病例包确定性路径不应调用模型: ${input.schemaName}`)
      },
    },
    cursorSecret: randomUUID() + randomUUID(),
    databasePath: join(directory, 'hospital.sqlite'),
    demoPassword: password,
    investigationModel: 'unexpected-investigation-model',
    migrationMode: 'apply',
    patientPersonaModel: 'synthetic',
    trustedOrigins: ['http://localhost'],
  })
  cleanups.push(async () => {
    await runtime.close()
    await rm(directory, { force: true, maxRetries: 5, retryDelay: 100, recursive: true })
  })

  const cookies = new Map<string, string>()
  async function login(role: string) {
    const cached = cookies.get(role)
    if (cached !== undefined) return cached
    const res = await runtime.app.request('/api/auth/sign-in/email', {
      body: JSON.stringify({ email: `${role}@demo.clinmesh.local`, password }),
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie')!.split(';', 1)[0]!
    cookies.set(role, cookie)
    return cookie
  }
  async function get(role: string, path: string) {
    return runtime.app.request(path, { headers: { cookie: await login(role) } })
  }
  async function mutate(role: string, path: string, body: unknown, method = 'POST', key = randomUUID()) {
    return runtime.app.request(path, {
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        cookie: await login(role),
        'idempotency-key': key,
        origin: 'http://localhost',
      },
      method,
    })
  }
  async function dispatchAll() {
    while (await runtime.dispatcher.dispatchOnce() !== undefined) { /* drain outbox */ }
  }
  async function preparePack(epoch = 'epoch-1', key = randomUUID()) {
    const res = await mutate('admin', '/api/sim/v1/synthetic-cases/authored-pack/prepare', { input: { expectedEpoch: epoch } }, 'POST', key)
    expect(res.status, await res.clone().text()).toBe(200)
    return authoredCasePackPrepareResponseSchema.parse(await res.json())
  }
  async function startOutpatient(caseId: string, revision: number, activeBriefRevision: number, chiefComplaint: string) {
    const regCatalog = registrationCatalogSchema.parse(await (await get('registrar', '/api/his/v1/catalogs/registration')).json())
    const startRes = await mutate('registrar', `/api/his/v1/synthetic-cases/${caseId}/actions/start-outpatient-visit`, {
      activeBriefRevision,
      departmentId: regCatalog.departments[0]!.id,
      expectedCaseRevision: revision,
      locationId: regCatalog.locations[0]!.id,
      visitDate: regCatalog.virtualDate,
      visitTypeId: regCatalog.visitTypes[0]!.id,
    })
    expect(startRes.status, await startRes.clone().text()).toBe(200)
    const started = startSyntheticCaseResultSchema.parse((await startRes.json()).data)
    const triageRes = await mutate('triage', `/api/his/v1/encounters/${started.encounterId}/actions/record-triage`, {
      expectedVersions: { [`Encounter/${started.encounterId}`]: '1', [`Task/${started.queueTaskId}`]: '1' },
      input: {
        acuityCode: 'level-3',
        bloodPressure: { diastolicMmHg: 82, systolicMmHg: 138 },
        chiefComplaint,
        oxygenSaturationPct: 98,
        pulseBpm: 84,
        respirationBpm: 18,
        temperatureC: 36.6,
      },
    })
    expect(triageRes.status, await triageRes.clone().text()).toBe(200)
    const triaged = triageResponseSchema.parse(await triageRes.json()).data
    const firstVisitRes = await mutate('doctor', `/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, {
      expectedVersions: { [`Encounter/${started.encounterId}`]: '2', [`Task/${triaged.doctorTaskId}`]: '1' },
      input: {},
    })
    expect(firstVisitRes.status, await firstVisitRes.clone().text()).toBe(200)
    startVisitResponseSchema.parse(await firstVisitRes.json())
    return { caseId: started.outpatientCaseId, encounterId: started.encounterId, patientId: started.patientId }
  }
  async function startDirectInpatient(caseId: string, revision: number, activeBriefRevision: number, epoch = 'epoch-1', bedId = 'bed-general-1') {
    const startRes = await mutate('registrar', `/api/his/v1/synthetic-cases/${caseId}/actions/start-inpatient-visit`, {
      activeBriefRevision, expectedCaseRevision: revision, expectedEpoch: epoch, wardId: 'ward-general',
    })
    expect(startRes.status, await startRes.clone().text()).toBe(200)
    const started = startSyntheticInpatientCaseResponseSchema.parse(await startRes.json()).data
    const list = inpatientListSchema.parse(await (await get('ward-nurse', '/api/his/v1/inpatient/admissions')).json())
    const adm = list.items.find(item => item.id === started.admissionId)!
    const recvRes = await mutate('ward-nurse', `/api/his/v1/inpatient/admissions/${started.admissionId}/receive`, {
      input: { bedId, encounterVersion: adm.versionId },
    })
    expect(recvRes.status, await recvRes.clone().text()).toBe(200)
    const received = inpatientCommandResponseSchema.parse(await recvRes.json()).data.admission
    return { ...started, admission: received }
  }
  async function payOutpatientCharge(input: {
    caseId: string
    category: 'examination' | 'laboratory'
    chargeItemId: string
  }) {
    const billRes = await get('cashier', `/api/his/v1/billing/cases/${input.caseId}`)
    expect(billRes.status, await billRes.clone().text()).toBe(200)
    const charge = billingCaseSchema.parse(await billRes.json()).charges.find(item => item.chargeItemId === input.chargeItemId)!
    expect(charge).toBeDefined()
    const expectedVersions = { [`ChargeItem/${charge.chargeItemId}`]: String(charge.chargeVersion) }
    const previewRes = await mutate('cashier', '/api/his/v1/payments/actions/preview', {
      expectedVersions,
      input: { ...input, simulatorRule: 'success' },
    })
    expect(previewRes.status, await previewRes.clone().text()).toBe(200)
    const preview = paymentPreviewResponseSchema.parse(await previewRes.json()).data
    const confirmRes = await mutate('cashier', `/api/his/v1/payments/${preview.previewId}/actions/confirm`, {
      expectedVersions,
      input: { commitToken: preview.commitToken },
    })
    expect(confirmRes.status, await confirmRes.clone().text()).toBe(200)
    expect(paymentResponseSchema.parse(await confirmRes.json()).data.outcome).toBe('success')
  }
  async function runOutpatientLab(caseId: string, encounterId: string, code: string) {
    const search = caseLaboratoryCatalogSearchSchema.parse(
      await (await get('doctor', `/api/his/v1/doctor/cases/${caseId}/reference-catalogs/laboratory?query=${encodeURIComponent(code)}&page=1&pageSize=20`)).json(),
    )
    const item = search.items.find(candidate => candidate.referenceConcept?.code === code)
    expect(item, `Missing outpatient lab for code ${code}`).toBeDefined()
    const detail = doctorCaseDetailSchema.parse(await (await get('doctor', `/api/his/v1/doctor/cases/${caseId}`)).json())
    const draftRes = await mutate('doctor', `/api/his/v1/encounters/${encounterId}/laboratory-request/draft`, {
      expectedVersions: { [`Encounter/${encounterId}`]: detail.encounter.versionId },
      input: {
        catalogItemId: item!.id,
        expectedDraftVersion: detail.laboratoryRequests?.draftVersion ?? 0,
        indicationCode: item!.allowedIndicationCodes[0] ?? 'clinical-assessment',
      },
    }, 'PUT')
    expect(draftRes.status, await draftRes.clone().text()).toBe(200)
    const draft = laboratoryRequestDraftResponseSchema.parse(await draftRes.json()).data
    const issueRes = await mutate('doctor', `/api/his/v1/encounters/${encounterId}/laboratory-request/actions/issue`, {
      expectedVersions: { [`Encounter/${encounterId}`]: detail.encounter.versionId },
      input: { expectedDraftVersion: draft.draftVersion },
    })
    expect(issueRes.status, await issueRes.clone().text()).toBe(200)
    const issued = issueLaboratoryRequestResponseSchema.parse(await issueRes.json()).data.request
    await payOutpatientCharge({
      caseId,
      category: 'laboratory',
      chargeItemId: issued.billing!.chargeItemId,
    })
    await dispatchAll()
    const updated = doctorCaseDetailSchema.parse(await (await get('doctor', `/api/his/v1/doctor/cases/${caseId}`)).json())
    const reported = updated.laboratoryRequests!.requests.find(req => req.id === issued.id)!
    expect(reported.status, JSON.stringify(reported.generationError)).toBe('reported')
    return reported
  }
  async function runOutpatientExam(caseId: string, encounterId: string, serviceId: 'examination-ecg-12-lead' | 'examination-tte') {
    const detail = doctorCaseDetailSchema.parse(await (await get('doctor', `/api/his/v1/doctor/cases/${caseId}`)).json())
    const draftRes = await mutate('doctor', `/api/his/v1/encounters/${encounterId}/examination-request/draft`, {
      expectedVersions: { [`Encounter/${encounterId}`]: detail.encounter.versionId },
      input: {
        expectedDraftVersion: detail.examinationRequests?.draftVersion ?? 0,
        indication: '心血管专病临床评估',
        serviceId,
      },
    }, 'PUT')
    expect(draftRes.status, await draftRes.clone().text()).toBe(200)
    const draftVersion = (await draftRes.json()).data.draftVersion as number
    const issueRes = await mutate('doctor', `/api/his/v1/encounters/${encounterId}/examination-request/actions/issue`, {
      expectedVersions: { [`Encounter/${encounterId}`]: detail.encounter.versionId },
      input: { expectedDraftVersion: draftVersion },
    })
    expect(issueRes.status, await issueRes.clone().text()).toBe(200)
    const issued = examinationRequestSchema.parse((await issueRes.json()).data.request)
    await payOutpatientCharge({
      caseId,
      category: 'examination',
      chargeItemId: issued.billing!.chargeItemId,
    })
    await dispatchAll()
    const updated = doctorCaseDetailSchema.parse(await (await get('doctor', `/api/his/v1/doctor/cases/${caseId}`)).json())
    const reported = updated.examinationRequests!.requests.find(req => req.id === issued.id)!
    expect(reported.status, JSON.stringify(reported.generationError)).toBe('reported')
    return reported
  }
  async function runInpatientLab(admissionId: string, displayQuery: string) {
    const adm = inpatientDetailSchema.parse(await (await get('inpatient-doctor', `/api/his/v1/inpatient/admissions/${admissionId}`)).json()).admission
    const catalog = inpatientInvestigationCatalogSchema.parse(await (await get('inpatient-doctor', '/api/his/v1/inpatient/investigation-catalog')).json())
    const service = catalog.items.find(item => item.kind === 'laboratory' && item.available && item.display.includes(displayQuery))
    expect(service, `Missing inpatient lab matching ${displayQuery}`).toBeDefined()
    const issueRes = await mutate('inpatient-doctor', `/api/his/v1/inpatient/admissions/${admissionId}/investigations/issue`, {
      input: {
        catalogVersion: service!.version,
        encounterVersion: adm.versionId,
        selection: { catalogItemId: service!.id, indicationCode: service!.indicationCodes[0] ?? 'clinical-assessment', kind: 'laboratory' },
      },
    })
    expect(issueRes.status, await issueRes.clone().text()).toBe(200)
    const afterIssue = inpatientInvestigationsSchema.parse((await issueRes.json()).data)
    const req = afterIssue.laboratoryRequests.find(item => item.status === 'issued' && item.catalogItemId === service!.id)!
    const sendRes = await mutate('ward-nurse', `/api/his/v1/inpatient/admissions/${admissionId}/investigations/send`, {
      input: {
        expectedRequestVersion: req.version,
        requestId: req.id,
        serviceRequestVersion: req.serviceRequestVersion,
        taskVersion: req.taskVersion,
      },
    })
    expect(sendRes.status, await sendRes.clone().text()).toBe(200)
    await dispatchAll()
    const afterReport = inpatientInvestigationsSchema.parse(await (await get('inpatient-doctor', `/api/his/v1/inpatient/admissions/${admissionId}/investigations`)).json())
    const reported = afterReport.laboratoryRequests.find(item => item.id === req.id)!
    expect(reported.status, JSON.stringify(reported.generationError)).toBe('reported')
    return reported
  }
  async function runInpatientExam(admissionId: string, serviceId: 'examination-ecg-12-lead' | 'examination-tte') {
    const adm = inpatientDetailSchema.parse(await (await get('inpatient-doctor', `/api/his/v1/inpatient/admissions/${admissionId}`)).json()).admission
    const issueRes = await mutate('inpatient-doctor', `/api/his/v1/inpatient/admissions/${admissionId}/investigations/issue`, {
      input: {
        catalogVersion: 1,
        encounterVersion: adm.versionId,
        selection: { indication: '住院心血管功能检查', kind: 'examination', serviceId },
      },
    })
    expect(issueRes.status, await issueRes.clone().text()).toBe(200)
    const afterIssue = inpatientInvestigationsSchema.parse((await issueRes.json()).data)
    const req = afterIssue.examinationRequests.find(item => item.status === 'issued' && item.service.id === serviceId)!
    const sendRes = await mutate('ward-nurse', `/api/his/v1/inpatient/admissions/${admissionId}/investigations/send`, {
      input: {
        expectedRequestVersion: req.version,
        requestId: req.id,
        serviceRequestVersion: req.serviceRequestVersion,
        taskVersion: req.taskVersion,
      },
    })
    expect(sendRes.status, await sendRes.clone().text()).toBe(200)
    await dispatchAll()
    const afterReport = inpatientInvestigationsSchema.parse(await (await get('inpatient-doctor', `/api/his/v1/inpatient/admissions/${admissionId}/investigations`)).json())
    const reported = afterReport.examinationRequests.find(item => item.id === req.id)!
    expect(reported.status, JSON.stringify(reported.generationError)).toBe('reported')
    return reported
  }
  async function executeAngiography(admissionId: string) {
    const catalog = inpatientSurgeryCatalogSchema.parse(await (await get('inpatient-doctor', '/api/his/v1/inpatient/surgery-catalog')).json())
    const angioProc = catalog.procedures.find(item => item.coding.code === '88.5500')!
    const adm = inpatientDetailSchema.parse(await (await get('inpatient-doctor', `/api/his/v1/inpatient/admissions/${admissionId}`)).json()).admission
    const reqRes = await mutate('inpatient-doctor', `/api/his/v1/inpatient/admissions/${admissionId}/surgeries/request`, {
      input: {
        anesthesiaMethod: 'local-infiltration',
        catalogVersion: angioProc.version,
        encounterVersion: adm.versionId,
        locationId: 'location-catheterization-lab',
        plannedFor: '2026-08-24T11:00:00+08:00',
        procedureId: angioProc.id,
        reason: '冠脉造影评估血管病变',
        surgeonPractitionerId: 'practitioner-inpatient-doctor',
        surgeryType: 'elective',
      },
    })
    expect(reqRes.status, await reqRes.clone().text()).toBe(200)
    const reqData = inpatientSurgeryResponseSchema.parse(await reqRes.json()).data.requests.find(item => item.plannedProcedure.id === angioProc.id)!
    const preop = await mutate('ward-nurse', `/api/his/v1/inpatient/admissions/${admissionId}/surgeries/check-preop`, {
      input: { expectedRequestVersion: reqData.version, note: '术前核查完成', requestId: reqData.id },
    })
    expect(preop.status, await preop.clone().text()).toBe(200)
    const afterPreop = inpatientSurgeryResponseSchema.parse(await preop.json()).data.requests.find(item => item.id === reqData.id)!
    const clinical = inpatientFullClinicalSchema.parse(await (await get('inpatient-doctor', `/api/his/v1/inpatient/admissions/${admissionId}/clinical`)).json())
    const consent = await mutate('inpatient-doctor', `/api/his/v1/inpatient/admissions/${admissionId}/surgeries/confirm-consent`, {
      input: {
        expectedDiagnosisRevision: clinical.diagnosis.revision,
        expectedRequestVersion: afterPreop.version,
        note: '已签署知情同意书',
        patientChoice: 'agree',
        requestId: reqData.id,
        signerName: adm.patientName,
        signerRole: 'patient',
      },
    })
    expect(consent.status, await consent.clone().text()).toBe(200)
    const afterConsent = inpatientSurgeryResponseSchema.parse(await consent.json()).data.requests.find(item => item.id === reqData.id)!
    const exec = await mutate('inpatient-doctor', `/api/his/v1/inpatient/admissions/${admissionId}/surgeries/execute`, {
      input: {
        catalogVersion: angioProc.version,
        expectedRequestVersion: afterConsent.version,
        materials: [],
        note: '完成选择性冠脉造影检查',
        procedureId: angioProc.id,
        requestId: reqData.id,
      },
    })
    expect(exec.status, await exec.clone().text()).toBe(200)
    await dispatchAll()
    const reports = inpatientAngiographyReportsSchema.parse(
      await (await get('inpatient-doctor', `/api/his/v1/inpatient/admissions/${admissionId}/angiography-reports`)).json(),
    )
    return reports.reports[0]!
  }

  async function dischargeAndStartOutpatientRevisit(input: {
    admissionId: string
    patientId: string
    patientName: string
    chiefComplaint: string
  }) {
    const admNow = inpatientDetailSchema.parse(await (await get('inpatient-doctor', `/api/his/v1/inpatient/admissions/${input.admissionId}`)).json()).admission
    const issueDischarge = await mutate('inpatient-doctor', `/api/his/v1/inpatient/admissions/${input.admissionId}/discharge/issue`, {
      input: {
        clinicalOverride: {
          acknowledgedAlerts: ['DISCHARGE_ANTIPLATELET_MISSING', 'DISCHARGE_STATIN_MISSING'],
          note: '本测试聚焦分阶段真值链路验证，出院带药另行验证',
          reasonCode: 'clinical-judgement',
        },
        encounterVersion: admNow.versionId,
        reason: '已完成住院评估与治疗，病情稳定准予出院随访。',
      },
    })
    expect(issueDischarge.status, await issueDischarge.clone().text()).toBe(200)
    const admDischarging = inpatientDetailSchema.parse(await (await get('ward-nurse', `/api/his/v1/inpatient/admissions/${input.admissionId}`)).json()).admission
    const departRes = await mutate('ward-nurse', `/api/his/v1/inpatient/admissions/${input.admissionId}/discharge/depart`, {
      input: { departureMethod: 'home', encounterVersion: admDischarging.versionId, reason: '患者办理出院离区' },
    })
    expect(departRes.status, await departRes.clone().text()).toBe(200)

    const patients = patientSearchSchema.parse(await (await get('registrar', `/api/his/v1/patients?query=${encodeURIComponent(input.patientName)}`)).json())
    const patient = patients.items.find(p => p.id === input.patientId)!
    const regCatalog = registrationCatalogSchema.parse(await (await get('registrar', '/api/his/v1/catalogs/registration')).json())
    const revisitReg = await mutate('registrar', '/api/his/v1/registrations/actions/register', {
      expectedVersions: { [`Patient/${input.patientId}`]: patient.versionId },
      input: {
        departmentId: regCatalog.departments[0]!.id,
        locationId: regCatalog.locations[0]!.id,
        patientId: input.patientId,
        visitDate: regCatalog.virtualDate,
        visitTypeId: regCatalog.visitTypes[0]!.id,
      },
    })
    expect(revisitReg.status, await revisitReg.clone().text()).toBe(200)
    const revisitData = registrationResponseSchema.parse(await revisitReg.json()).data
    const revisitTriage = await mutate('triage', `/api/his/v1/encounters/${revisitData.encounterId}/actions/record-triage`, {
      expectedVersions: { [`Encounter/${revisitData.encounterId}`]: '1', [`Task/${revisitData.queueTaskId}`]: '1' },
      input: {
        acuityCode: 'level-3',
        bloodPressure: { diastolicMmHg: 76, systolicMmHg: 124 },
        chiefComplaint: input.chiefComplaint,
        oxygenSaturationPct: 99,
        pulseBpm: 68,
        respirationBpm: 18,
        temperatureC: 36.6,
      },
    })
    expect(revisitTriage.status).toBe(200)
    const revisitTriaged = triageResponseSchema.parse(await revisitTriage.json()).data
    expect((await mutate('doctor', `/api/his/v1/encounters/${revisitData.encounterId}/actions/start-first-visit`, {
      expectedVersions: { [`Encounter/${revisitData.encounterId}`]: '2', [`Task/${revisitTriaged.doctorTaskId}`]: '1' },
      input: {},
    })).status).toBe(200)
    const queue = doctorQueueSchema.parse(await (await get('doctor', '/api/his/v1/doctor/queue')).json())
    return {
      caseId: queue.items.find(item => item.encounterId === revisitData.encounterId)!.caseId,
      encounterId: revisitData.encounterId,
    }
  }

  return {
    dialogueInputs,
    dischargeAndStartOutpatientRevisit,
    dispatchAll,
    executeAngiography,
    get,
    login,
    modelCalls: () => unexpectedModelCalls.length,
    unexpectedModelCalls: () => [...unexpectedModelCalls],
    mutate,
    preparePack,
    runInpatientExam,
    runInpatientLab,
    runOutpatientExam,
    runOutpatientLab,
    runtime,
    startDirectInpatient,
    startOutpatient,
  }
}

it('幂等准备五例专病病例包，保持角色/世代/人工修订/兼容固定 PCI 及双模式 Epoch 重置', async () => {
  const s = await setup()
  // Role guards & zero Case Truth leakage on summary read
  expect((await s.get('doctor', '/api/sim/v1/synthetic-cases/authored-pack')).status).toBe(403)
  expect((await s.mutate('registrar', '/api/sim/v1/synthetic-cases/authored-pack/prepare', { input: { expectedEpoch: 'epoch-1' } })).status).toBe(403)

  const beforeRes = await s.get('admin', '/api/sim/v1/synthetic-cases/authored-pack')
  expect(beforeRes.status).toBe(200)
  const beforeText = await beforeRes.clone().text()
  expect(beforeText).not.toMatch(/hiddenResources|caseTruth|rawBundle|angiography-conclusion/)
  const before = authoredCasePackSummarySchema.parse(await beforeRes.json())
  expect(before).toMatchObject({ readyCount: 0, totalCount: 5 })

  const stale = await s.mutate('admin', '/api/sim/v1/synthetic-cases/authored-pack/prepare', { input: { expectedEpoch: 'stale-epoch' } })
  expect(stale.status).toBe(409)
  expect(apiErrorSchema.parse(await stale.json()).error.code).toBe('AUTHORED_CASE_PACK_EPOCH_CONFLICT')

  // First prepare: creates all 5 cases, brief-ready, clinmesh-authored-template, zero LLM calls
  const key = randomUUID()
  const first = await s.preparePack('epoch-1', key)
  expect(first.data).toMatchObject({ readyCount: 5, totalCount: 5 })
  expect(first.effects.length).toBeGreaterThan(0)
  const receiptRes = await s.get('admin', `/api/his/v1/command-receipts?operationId=admin.authored-case-pack.prepare&idempotencyKey=${encodeURIComponent(key)}`)
  expect(receiptRes.status, await receiptRes.clone().text()).toBe(200)
  expect(commandReceiptLookupSchema.parse(await receiptRes.json())).toMatchObject({
    idempotencyKey: key, operationId: 'admin.authored-case-pack.prepare', status: 'completed',
  })
  expect((await s.get('doctor', `/api/his/v1/command-receipts?operationId=admin.authored-case-pack.prepare&idempotencyKey=${encodeURIComponent(key)}`)).status).toBe(404)
  for (const item of first.data.cases) {
    expect(item.case).toMatchObject({ activeBriefRevision: 1, revision: 2, status: 'brief-ready' })
    const revisions = patientPersonaRevisionListSchema.parse(
      await (await s.get('admin', `/api/sim/v1/synthetic-cases/${item.case!.caseId}/patient-persona-revisions`)).json(),
    )
    expect(revisions.items).toHaveLength(1)
    expect(revisions.items[0]!.model).toBe('clinmesh-authored-template')
    const truth = administratorCaseTruthSchema.parse(
      await (await s.get('admin', `/api/sim/v1/admin/synthetic-cases/${item.case!.caseId}/truth`)).json(),
    )
    expect(truth.items.length).toBeGreaterThan(10)
  }

  // Exact replay with same key & repeat prepare with new key
  const replay = await s.preparePack('epoch-1', key)
  expect(replay).toEqual(first)
  const repeat = await s.preparePack('epoch-1')
  expect(repeat.effects).toEqual([])
  expect(repeat.data).toEqual(first.data)

  // Manual persona edit is preserved on repeat prepare
  const firstCase = first.data.cases[0]!.case!
  const revisionsBefore = patientPersonaRevisionListSchema.parse(
    await (await s.get('admin', `/api/sim/v1/synthetic-cases/${firstCase.caseId}/patient-persona-revisions`)).json(),
  )
  const edited = await s.mutate('admin', `/api/sim/v1/synthetic-cases/${firstCase.caseId}/patient-persona-revisions`, {
    input: { content: { ...revisionsBefore.items[0]!.content, openingStatement: '医生您好，我今天早上胸口闷痛，请帮我看看。' } },
  })
  expect(edited.status).toBe(200)
  const manual = patientPersonaRevisionSchema.parse((await edited.json()).data)
  expect((await s.mutate('admin', `/api/sim/v1/synthetic-cases/${firstCase.caseId}/patient-persona-revisions/active`, {
    expectedCaseRevision: firstCase.revision, personaRevision: manual.revision,
  }, 'PUT')).status).toBe(200)
  const afterManualRepeat = await s.preparePack('epoch-1')
  expect(afterManualRepeat.effects).toEqual([])
  expect(afterManualRepeat.data.cases[0]!.case!.activeBriefRevision).toBe(manual.revision)

  // Queued persona job on legacy brief-pending case is superseded cleanly
  const case2 = first.data.cases[1]!.case!
  s.runtime.database.driver.prepare('UPDATE synthetic_case_instance SET active_brief_revision=NULL, status=?, revision=1 WHERE case_id=?').run('brief-pending', case2.caseId)
  s.runtime.database.driver.prepare('DELETE FROM patient_persona_revision WHERE case_id=?').run(case2.caseId)
  const queued = await s.mutate('admin', `/api/sim/v1/synthetic-cases/${case2.caseId}/patient-persona-jobs`, {})
  expect(queued.status).toBe(200)
  const job = patientPersonaJobSchema.parse((await queued.json()).data)
  const repaired = await s.preparePack('epoch-1')
  expect(repaired.effects).toContainEqual({ kind: 'updated', reference: `PatientPersonaJob/${job.jobId}`, versionId: 'failed' })
  const stoppedJob = patientPersonaJobSchema.parse(await (await s.get('admin', `/api/sim/v1/patient-persona-jobs/${job.jobId}`)).json())
  expect(stoppedJob).toMatchObject({ error: { code: 'PERSONA_JOB_SUPERSEDED' }, status: 'failed' })

  // Backward compatibility: legacy pci/prepare works side by side without conflicts
  const pciRes = await s.mutate('admin', '/api/sim/v1/synthetic-cases/pci/prepare', { input: { expectedEpoch: 'epoch-1' } })
  expect(pciRes.status).toBe(200)
  pciCaseSourceResponseSchema.parse(await pciRes.json())
  const profiles = syntheticPatientProfileListSchema.parse(await (await s.get('admin', '/api/sim/v1/synthetic-patients')).json())
  expect(profiles.total).toBe(6)

  // Epoch replay: clearPatientLibrary=false replays started visit; clearPatientLibrary=true restores & bumps profile revision
  const readyCase2 = repaired.data.cases[1]!.case!
  const started = await s.startDirectInpatient(readyCase2.caseId, readyCase2.revision, readyCase2.activeBriefRevision!)
  const ctx = async () => sessionContextSchema.parse(await (await s.get('admin', '/api/auth/context')).json()).actor
  const beforeReset = await ctx()
  expect((await s.mutate('admin', `/api/sim/v1/scenario-runs/${beforeReset.scenarioRunId}/actions/reset`, { clearPatientLibrary: false })).status).toBe(200)
  const replayedList = inpatientListSchema.parse(await (await s.get('registrar', '/api/his/v1/inpatient/admissions')).json())
  expect(replayedList.items).toHaveLength(1)
  expect(replayedList.items[0]!.id).not.toBe(started.admissionId)

  const midReset = await ctx()
  expect((await s.mutate('admin', `/api/sim/v1/scenario-runs/${midReset.scenarioRunId}/actions/reset`, { clearPatientLibrary: true })).status).toBe(200)
  const clearedSummary = authoredCasePackSummarySchema.parse(await (await s.get('admin', '/api/sim/v1/synthetic-cases/authored-pack')).json())
  expect(clearedSummary.readyCount).toBe(0)
  const afterClearCtx = await ctx()
  const rePrepared = await s.preparePack(afterClearCtx.epoch)
  expect(rePrepared.data.readyCount).toBe(5)
  expect(rePrepared.data.cases[1]!.profileId).toBe(repaired.data.cases[1]!.profileId)
  expect(rePrepared.data.cases[1]!.case!.profileRevision).toBe(readyCase2.profileRevision + 1)
  expect(rePrepared.data.cases[1]!.case!.caseId).not.toBe(readyCase2.caseId)
  expect(s.modelCalls()).toBe(0)
}, 60_000)

it('病例①完成门诊首诊、患者问诊防泄漏、复测肌钙蛋白、住院造影与出院后门诊随访的分阶段真值解析', async () => {
  const s = await setup({ withCardiologyLabs: true, withDialogue: true })
  const prepared = await s.preparePack()
  const case1 = prepared.data.cases[0]!.case!

  // 1. Outpatient initial visit + real consultation dialogue zero Case Truth leakage check
  const op = await s.startOutpatient(case1.caseId, case1.revision, case1.activeBriefRevision!, '间断胸骨后闷痛 6 小时')
  const beforeAsk = doctorCaseDetailSchema.parse(await (await s.get('doctor', `/api/his/v1/doctor/cases/${op.caseId}`)).json())
  const askRes = await s.mutate('doctor', `/api/his/v1/encounters/${op.encounterId}/actions/ask-consultation-question`, {
    expectedVersions: {
      [`Encounter/${op.encounterId}`]: beforeAsk.encounter.versionId,
      [`Task/${beforeAsk.taskId}`]: beforeAsk.taskVersion,
    },
    input: {
      expectedConsultationVersion: beforeAsk.consultation!.version,
      message: '请问胸痛是什么时候开始的，有没有出汗或者放射痛？',
    },
  })
  expect(askRes.status, await askRes.clone().text()).toBe(200)
  const askText = await askRes.clone().text()
  const dialogue = sendConsultationMessageResponseSchema.parse(await askRes.json())
  expect(dialogue.data.patientTurn.messageText).toContain('胸口闷痛')
  expect(s.dialogueInputs).toHaveLength(1)
  for (const payload of [askText, s.dialogueInputs[0]!.systemPrompt, JSON.stringify(s.dialogueInputs[0]!.userPayload)]) {
    expect(payload).not.toMatch(/hiddenResources|caseTruth|angiography-conclusion|truth-stage|I21\.4|90%/)
  }
  const fhirConditionsBeforePrereq = fhirBundleSchema.parse(await (await s.get('doctor', `/fhir/R5/Condition?patient=Patient/${op.patientId}`)).json())
  expect(fhirConditionsBeforePrereq.entry ?? []).toHaveLength(0)

  const opPrereq = await satisfyOutpatientOrderPrerequisites(s.runtime, await s.login('doctor'), op.caseId, {
    diagnosisCatalogItemId: 'diagnosis-coronary-heart-disease',
  })
  await s.dispatchAll()

  const ecgInitial = await s.runOutpatientExam(op.caseId, op.encounterId, 'examination-ecg-12-lead')
  expect(ecgInitial.report!.impression).toContain('ST段压低')
  expect(ecgInitial.report!.results.find(r => r.code === 'st-t-anterior')?.value).toContain('ST 段水平型压低')
  expect(ecgInitial.report!.results.find(r => r.code === 'ventricular-rate')?.value).toBe(96)

  // Initial hs-cTnI (0.68 ng/mL -> 680 ng/L) -> repeat hs-cTnI (1.45 ng/mL -> 1450 ng/L)
  const ctni1 = await s.runOutpatientLab(op.caseId, op.encounterId, '2100404B')
  expect(ctni1.report!.results.find(r => r.code === '2100404B')).toMatchObject({ interpretation: 'high', value: 680 })
  const ctni2 = await s.runOutpatientLab(op.caseId, op.encounterId, '2100404B')
  expect(ctni2.report!.results.find(r => r.code === '2100404B')).toMatchObject({ interpretation: 'high', value: 1450 })

  // Baseline LDL-C (3.60) & Scr (118)
  const ldlBase = await s.runOutpatientLab(op.caseId, op.encounterId, '2000404A')
  expect(ldlBase.report!.results.find(r => r.code === '2000404A')?.value).toBe(3.6)
  const scrBase = await s.runOutpatientLab(op.caseId, op.encounterId, '1700404A')
  expect(scrBase.report!.results.find(r => r.code === '1700404A')?.value).toBe(118)

  // Verify zero Case Truth leakage across clinical endpoints & visible history
  const clinicalDetailText = await (await s.get('doctor', `/api/his/v1/doctor/cases/${op.caseId}`)).text()
  const visibleHistoryRes = await s.get('doctor', `/api/his/v1/doctor/cases/${op.caseId}/history?source=visible-source&page=1&pageSize=20`)
  expect(visibleHistoryRes.status).toBe(200)
  const visibleHistoryText = await visibleHistoryRes.clone().text()
  expect(doctorCaseHistorySchema.parse(await visibleHistoryRes.json()).items.length).toBeGreaterThan(0)
  for (const payload of [clinicalDetailText, visibleHistoryText]) {
    expect(payload).not.toMatch(/hiddenResources|caseTruth|angiography-conclusion|truth-stage/)
  }
  expect((await s.get('doctor', `/api/sim/v1/admin/synthetic-cases/${case1.caseId}/truth`)).status).toBe(403)
  const fhirConditions = fhirBundleSchema.parse(await (await s.get('doctor', `/fhir/R5/Condition?patient=Patient/${op.patientId}`)).json())
  expect(fhirConditions.entry ?? []).toHaveLength(1)
  expect(JSON.stringify(fhirConditions)).not.toMatch(/I21\.4|hiddenResources/)

  // 2. Complete outpatient encounter after issuing referral -> Inpatient admission -> TTE (LVEF 52%) + Multivessel Angiography (pLAD 90% TIMI 2 + QCA 15mm)
  const opDetail = doctorCaseDetailSchema.parse(await (await s.get('doctor', `/api/his/v1/doctor/cases/${op.caseId}`)).json())
  const refRes = await s.mutate('doctor', '/api/his/v1/inpatient/referrals', {
    input: {
      encounterId: op.encounterId,
      encounterVersion: opDetail.encounter.versionId,
      reason: '高危 NSTEMI，拟收住院行冠脉造影及血运重建',
      wardId: 'ward-general',
    },
  })
  expect(refRes.status, await refRes.clone().text()).toBe(200)
  const referral = (await refRes.json()).data.referral as { id: string; patientVersion: string }
  // Acknowledge all outpatient reports, confirm no outpatient medication, revise signed note, and complete initial outpatient visit
  for (const labReq of opDetail.laboratoryRequests?.requests ?? []) {
    if (labReq.status === 'reported' && labReq.report !== undefined) {
      const ack = await s.mutate('doctor', `/api/his/v1/laboratory-requests/${labReq.id}/reports/${labReq.report.diagnosticReportId}/actions/acknowledge`, {
        expectedVersions: { [`DiagnosticReport/${labReq.report.diagnosticReportId}`]: labReq.report.diagnosticReportVersion },
        input: { expectedRequestVersion: labReq.version },
      })
      expect(ack.status, await ack.clone().text()).toBe(200)
      acknowledgeLaboratoryReportResponseSchema.parse(await ack.json())
    }
  }
  for (const examReq of opDetail.examinationRequests?.requests ?? []) {
    if (examReq.status === 'reported' && examReq.report !== undefined) {
      const ack = await s.mutate('doctor', `/api/his/v1/examination-requests/${examReq.id}/reports/${examReq.report.diagnosticReportId}/actions/acknowledge`, {
        expectedVersions: { [`DiagnosticReport/${examReq.report.diagnosticReportId}`]: examReq.report.diagnosticReportVersion },
        input: { expectedRequestVersion: examReq.version },
      })
      expect(ack.status, await ack.clone().text()).toBe(200)
    }
  }
  const opForClose = () => s.get('doctor', `/api/his/v1/doctor/cases/${op.caseId}`).then(async r => doctorCaseDetailSchema.parse(await r.json()))
  const d2 = await opForClose()
  const noMed = await s.mutate('doctor', `/api/his/v1/encounters/${op.encounterId}/medication-conclusion/actions/confirm-no-medication`, {
    expectedVersions: { [`Encounter/${op.encounterId}`]: d2.encounter.versionId },
    input: { expectedDraftVersion: 0 },
  })
  expect(noMed.status, await noMed.clone().text()).toBe(200)
  confirmNoMedicationResponseSchema.parse(await noMed.json())
  const d3 = await opForClose()
  const revisedOpDoc = await s.mutate('doctor', `/api/his/v1/clinical-documents/${opPrereq.compositionId}/actions/revise`, {
    expectedVersions: {
      [`Composition/${opPrereq.compositionId}`]: opPrereq.compositionVersion,
      [`Encounter/${op.encounterId}`]: d3.encounter.versionId,
    },
    input: {
      document: {
        ...defaultOutpatientGateDocument,
        assessment: '急性非ST段抬高型心肌梗死高危表现，已开具住院证转入心内科。',
        chiefComplaint: '间断胸骨后闷痛 6 小时。',
        disposition: '转住院行冠脉造影及血运重建。',
        followUp: '住院治疗后门诊随访。',
        historyOfPresentIllness: '胸痛伴出汗，心电图示前壁 ST 段压低，高敏肌钙蛋白动态升高。',
        physicalExamination: '神清，生命体征平稳。',
      },
      reason: '检验检查回报并开具住院证后完善门诊病历。',
    },
  })
  expect(revisedOpDoc.status, await revisedOpDoc.clone().text()).toBe(200)
  clinicalDocumentRevisionResponseSchema.parse(await revisedOpDoc.json())
  await s.dispatchAll()
  const d6 = await opForClose()
  const completedOp = await s.mutate('doctor', `/api/his/v1/encounters/${op.encounterId}/actions/complete`, {
    expectedVersions: { [`Encounter/${op.encounterId}`]: d6.encounter.versionId },
    input: {},
  })
  expect(completedOp.status, await completedOp.clone().text()).toBe(200)
  encounterCompletionResponseSchema.parse(await completedOp.json())
  const regAdmRes = await s.mutate('registrar', '/api/his/v1/inpatient/admissions', {
    input: {
      admissionRoute: 'outpatient',
      depositFen: 0,
      expectedEpoch: 'epoch-1',
      patientId: op.patientId,
      patientVersion: referral.patientVersion,
      referralId: referral.id,
      wardId: 'ward-general',
    },
  })
  expect(regAdmRes.status, await regAdmRes.clone().text()).toBe(200)
  const admId = inpatientCommandResponseSchema.parse(await regAdmRes.json()).data.admission.id
  const admVersion = inpatientDetailSchema.parse(await (await s.get('ward-nurse', `/api/his/v1/inpatient/admissions/${admId}`)).json()).admission.versionId
  expect((await s.mutate('ward-nurse', `/api/his/v1/inpatient/admissions/${admId}/receive`, {
    input: { bedId: 'bed-general-1', encounterVersion: admVersion },
  })).status).toBe(200)

  const tte = await s.runInpatientExam(admId, 'examination-tte')
  expect(tte.report!.results.find(r => r.code === 'lvef')?.value).toBe(52)
  expect(tte.report!.impression).toContain('LVEF 52%')

  const angio = await s.executeAngiography(admId)
  expect(angio.status).toBe('final')
  expect(angio.vessels).toContainEqual(expect.objectContaining({ segment: 'LAD 近段', stenosisPercent: 90, timiFlow: 2, vessel: 'LAD' }))
  expect(angio.measurements.find(m => m.kind === 'lesion-length')?.value).toBe(15)
  expect(angio.conclusion).toContain('90%')

  // 3. Discharge & depart -> Post-discharge outpatient revisit resolves follow-up stage truth!
  const revisit = await s.dischargeAndStartOutpatientRevisit({
    admissionId: admId,
    chiefComplaint: '出院后门诊随访复查',
    patientId: op.patientId,
    patientName: '陈志远',
  })
  await satisfyOutpatientOrderPrerequisites(s.runtime, await s.login('doctor'), revisit.caseId, {
    diagnosisCatalogItemId: 'diagnosis-coronary-heart-disease',
  })
  await s.dispatchAll()

  const ecgFollowUp = await s.runOutpatientExam(revisit.caseId, revisit.encounterId, 'examination-ecg-12-lead')
  expect(ecgFollowUp.report!.results.find(r => r.code === 'ventricular-rate')?.value).toBe(68)
  expect(ecgFollowUp.report!.results.find(r => r.code === 'st-t-anterior')?.value).toContain('回落')
  expect(ecgFollowUp.report!.impression).toContain('回落')

  // Normalized post-PCI cardiac markers on revisit (never leak acute-MI initial/repeat elevations)
  const ctniFollowUp = await s.runOutpatientLab(revisit.caseId, revisit.encounterId, '2100404B')
  expect(ctniFollowUp.report!.results.find(r => r.code === '2100404B')).toMatchObject({ interpretation: 'normal', value: 12 })
  const cardiacFollowUp = await s.runOutpatientLab(revisit.caseId, revisit.encounterId, 'CN-LAB-CARDIAC')
  expect(cardiacFollowUp.report!.results.find(r => r.code === '2100504A')).toMatchObject({ interpretation: 'normal', value: 0.008 })
  expect(cardiacFollowUp.report!.results.find(r => r.code === '2100104A')).toMatchObject({ interpretation: 'normal', value: 14 })
  expect(cardiacFollowUp.report!.results.find(r => r.code === '2100304A')).toMatchObject({ interpretation: 'normal', value: 42 })

  const ldlFollowUp = await s.runOutpatientLab(revisit.caseId, revisit.encounterId, '2000404A')
  expect(ldlFollowUp.report!.results.find(r => r.code === '2000404A')?.value).toBe(1.25)
  const scrFollowUp = await s.runOutpatientLab(revisit.caseId, revisit.encounterId, '1700404A')
  expect(scrFollowUp.report!.results.find(r => r.code === '1700404A')?.value).toBe(112)
  expect(s.unexpectedModelCalls()).toEqual([])
}, 60_000)

it('病例②③④直接住院验证择期 PCI、女性临界 FFR 阴性过度介入警示、CKD 3b 复测肌酐及出院后门诊随访', async () => {
  const s = await setup({ withCardiologyLabs: true })
  const prepared = await s.preparePack()
  const case2 = prepared.data.cases[1]!.case!
  const case3 = prepared.data.cases[2]!.case!
  const case4 = prepared.data.cases[3]!.case!

  // Case 2: elective LAD 85% FFR 0.72 + normal hs-cTnI
  const stay2 = await s.startDirectInpatient(case2.caseId, case2.revision, case2.activeBriefRevision!, 'epoch-1', 'bed-general-1')
  const ctni2 = await s.runInpatientLab(stay2.admissionId, '高敏心肌肌钙蛋白I')
  expect(ctni2.report!.results.find(r => r.code === '2100404B')).toMatchObject({ interpretation: 'normal', value: 10 })
  const angio2 = await s.executeAngiography(stay2.admissionId)
  expect(angio2.status).toBe('final')
  expect(angio2.vessels).toContainEqual(expect.objectContaining({ ffr: 0.72, stenosisPercent: 85, vessel: 'LAD' }))

  // Case 3: female borderline LAD 60% FFR 0.86 -> PCI_NON_ISCHEMIC_LESION alert on PCI plan!
  const stay3 = await s.startDirectInpatient(case3.caseId, case3.revision, case3.activeBriefRevision!, 'epoch-1', 'bed-general-2')
  const angio3 = await s.executeAngiography(stay3.admissionId)
  expect(angio3.status).toBe('final')
  expect(angio3.vessels).toContainEqual(expect.objectContaining({ ffr: 0.86, stenosisPercent: 60, vessel: 'LAD' }))
  const pciQuality = clinicalQualityCheckSchema.parse(
    await (await s.get('inpatient-doctor', `/api/his/v1/inpatient/admissions/${stay3.admissionId}/clinical-quality?gate=inpatient-pci-plan`)).json(),
  )
  expect(pciQuality.alerts).toContainEqual(expect.objectContaining({ code: 'PCI_NON_ISCHEMIC_LESION', tier: 'alert' }))

  // Case 4: 68yo male CKD 3b -> baseline Scr 175 (eGFR 36.1 G3b), TTE LVEF 56%, angio FFR 0.74, repeat Scr 168
  const stay4 = await s.startDirectInpatient(case4.caseId, case4.revision, case4.activeBriefRevision!, 'epoch-1', 'bed-general-3')
  const scr4Initial = await s.runInpatientLab(stay4.admissionId, '肌酐')
  expect(scr4Initial.report!.results.find(r => r.code === '1700404A')?.value).toBe(175)
  const scores4 = clinicalScoreBundleSchema.parse(
    await (await s.get('inpatient-doctor', `/api/his/v1/inpatient/admissions/${stay4.admissionId}/clinical-scores`)).json(),
  )
  const egfr4 = scores4.scores.find(item => item.id === 'ckd-epi-2021-egfr')!
  expect(egfr4).toMatchObject({ status: 'complete', tierCode: 'G3b' })
  if (egfr4.status === 'complete') expect(egfr4.value).toBeCloseTo(36.1, 1)

  const tte4 = await s.runInpatientExam(stay4.admissionId, 'examination-tte')
  expect(tte4.report!.results.find(r => r.code === 'lvef')?.value).toBe(56)
  const angio4 = await s.executeAngiography(stay4.admissionId)
  expect(angio4.status).toBe('final')
  expect(angio4.vessels).toContainEqual(expect.objectContaining({ ffr: 0.74, stenosisPercent: 85, vessel: 'LAD' }))

  const scr4Repeat = await s.runInpatientLab(stay4.admissionId, '肌酐')
  expect(scr4Repeat.report!.results.find(r => r.code === '1700404A')?.value).toBe(168)

  // Direct-inpatient Case 4 -> discharge & depart -> post-discharge outpatient revisit resolves follow-up truth (even on 2nd repeat order!)
  const revisit4 = await s.dischargeAndStartOutpatientRevisit({
    admissionId: stay4.admissionId,
    chiefComplaint: 'PCI 术后伴慢性肾病门诊随访复查肾功能与血脂',
    patientId: stay4.patientId,
    patientName: '赵德明',
  })
  await satisfyOutpatientOrderPrerequisites(s.runtime, await s.login('doctor'), revisit4.caseId, {
    diagnosisCatalogItemId: 'diagnosis-coronary-heart-disease',
  })
  const scr4FollowUp1 = await s.runOutpatientLab(revisit4.caseId, revisit4.encounterId, '1700404A')
  expect(scr4FollowUp1.report!.results.find(r => r.code === '1700404A')?.value).toBe(170)
  const scr4FollowUp2 = await s.runOutpatientLab(revisit4.caseId, revisit4.encounterId, '1700404A')
  expect(scr4FollowUp2.report!.results.find(r => r.code === '1700404A')?.value).toBe(170)
  const ldl4FollowUp = await s.runOutpatientLab(revisit4.caseId, revisit4.encounterId, '2000404A')
  expect(ldl4FollowUp.report!.results.find(r => r.code === '2000404A')?.value).toBe(1.3)
  expect(s.modelCalls()).toBe(0)
}, 60_000)

it('病例⑤（64 岁女性 T2DM+高血压+CKD 4 期）门诊算出 eGFR=26.0 并红线拦截二甲双胍与达格列净，未缴费发药仍拦截重复挂号', async () => {
  const s = await setup({ withCardiologyLabs: true })
  const prepared = await s.preparePack()
  const case5 = prepared.data.cases[4]!.case!
  const op = await s.startOutpatient(case5.caseId, case5.revision, case5.activeBriefRevision!, '近期血糖偏高 1 个月复诊调药')
  const op5Prereq = await satisfyOutpatientOrderPrerequisites(s.runtime, await s.login('doctor'), op.caseId, {
    diagnosisCatalogItemId: 'diagnosis-type-2-diabetes-hyperglycemia',
  })

  const scr = await s.runOutpatientLab(op.caseId, op.encounterId, '1700404A')
  expect(scr.report!.results.find(r => r.code === '1700404A')?.value).toBe(184.6)
  const hba1c = await s.runOutpatientLab(op.caseId, op.encounterId, '1100301A')
  expect(hba1c.report!.results.find(r => r.code === '1100301A')?.value).toBe(8.2)
  const k = await s.runOutpatientLab(op.caseId, op.encounterId, '1400605A')
  expect(k.report!.results.find(r => r.code === '1400605A')?.value).toBe(4.8)
  const ldl = await s.runOutpatientLab(op.caseId, op.encounterId, '2000404A')
  expect(ldl.report!.results.find(r => r.code === '2000404A')?.value).toBe(3.1)

  const scores = clinicalScoreBundleSchema.parse(
    await (await s.get('doctor', `/api/his/v1/doctor/cases/${op.caseId}/clinical-scores`)).json(),
  )
  const egfr = scores.scores.find(item => item.id === 'ckd-epi-2021-egfr')!
  expect(egfr).toMatchObject({ status: 'complete', tierCode: 'G4' })
  if (egfr.status === 'complete') expect(egfr.value).toBeCloseTo(26.0, 1)

  // Acknowledge reported labs before confirming diagnosis & closing encounter
  const detailBeforeAck = doctorCaseDetailSchema.parse(await (await s.get('doctor', `/api/his/v1/doctor/cases/${op.caseId}`)).json())
  for (const labReq of detailBeforeAck.laboratoryRequests?.requests ?? []) {
    if (labReq.status === 'reported' && labReq.report !== undefined) {
      const ack = await s.mutate('doctor', `/api/his/v1/laboratory-requests/${labReq.id}/reports/${labReq.report.diagnosticReportId}/actions/acknowledge`, {
        expectedVersions: { [`DiagnosticReport/${labReq.report.diagnosticReportId}`]: labReq.report.diagnosticReportVersion },
        input: { expectedRequestVersion: labReq.version },
      })
      expect(ack.status, await ack.clone().text()).toBe(200)
    }
  }

  // Confirm T2DM + hypertension diagnoses then attempt to prescribe metformin & dapagliflozin -> hard red-line block!
  const detail = doctorCaseDetailSchema.parse(await (await s.get('doctor', `/api/his/v1/doctor/cases/${op.caseId}`)).json())
  const diagDraft = await s.mutate('doctor', `/api/his/v1/encounters/${op.encounterId}/diagnosis/draft`, {
    expectedVersions: { [`Encounter/${op.encounterId}`]: detail.encounter.versionId },
    input: {
      entries: [
        { catalogItemId: 'diagnosis-type-2-diabetes-hyperglycemia', role: 'primary' },
        { catalogItemId: 'diagnosis-hypertension', role: 'secondary' },
      ],
      expectedDraftVersion: detail.diagnosis?.draftVersion ?? 0,
    },
  }, 'PUT')
  expect(diagDraft.status, await diagDraft.clone().text()).toBe(200)
  const diagConfirm = await s.mutate('doctor', `/api/his/v1/encounters/${op.encounterId}/diagnosis/actions/confirm`, {
    expectedVersions: { [`Encounter/${op.encounterId}`]: detail.encounter.versionId },
    input: { expectedDraftVersion: diagnosisDraftResponseSchema.parse(await diagDraft.json()).data.draftVersion },
  })
  expect(diagConfirm.status, await diagConfirm.clone().text()).toBe(200)
  confirmDiagnosisResponseSchema.parse(await diagConfirm.json())

  let rxDraftVersion = 0
  for (const med of [
    { courseDays: 30, doseText: '0.5 g', frequencyCode: 'BID', id: 'medication-metformin', quantity: 60 },
    { courseDays: 1, doseText: '10 mg', frequencyCode: 'QD', id: 'medication-dapagliflozin', quantity: 1 },
  ]) {
    const cur = doctorCaseDetailSchema.parse(await (await s.get('doctor', `/api/his/v1/doctor/cases/${op.caseId}`)).json())
    const rxDraftRes = await s.mutate('doctor', `/api/his/v1/encounters/${op.encounterId}/prescription/draft`, {
      expectedVersions: { [`Encounter/${op.encounterId}`]: cur.encounter.versionId },
      input: {
        expectedDraftVersion: rxDraftVersion,
        items: [{
          catalogItemId: med.id,
          courseDays: med.courseDays,
          doseText: med.doseText,
          frequencyCode: med.frequencyCode,
          quantity: med.quantity,
          routeCode: 'PO',
        }],
      },
    }, 'PUT')
    expect(rxDraftRes.status, await rxDraftRes.clone().text()).toBe(200)
    const rxDraft = prescriptionDraftResponseSchema.parse(await rxDraftRes.json()).data
    rxDraftVersion = rxDraft.draftVersion
    const issueRx = await s.mutate('doctor', `/api/his/v1/encounters/${op.encounterId}/prescription/actions/issue`, {
      expectedVersions: { [`Encounter/${op.encounterId}`]: cur.encounter.versionId },
      input: { expectedDraftVersion: rxDraft.draftVersion },
    })
    expect(issueRx.status).toBe(409)
    expect(apiErrorSchema.parse(await issueRx.json()).error).toMatchObject({
      clinicalQuality: {
        redLines: [expect.objectContaining({ catalogItemId: med.id, code: 'RENAL_CONTRAINDICATED_MEDICATION' })],
      },
      code: 'CLINICAL_QUALITY_RED_LINE',
    })
  }

  // Regression guard: issue renal-safe amlodipine, sign note, complete encounter (leaves unpaid/undispensed prescription) -> duplicate outpatient registration MUST still be blocked with 409!
  const readOp = () => s.get('doctor', `/api/his/v1/doctor/cases/${op.caseId}`).then(async r => doctorCaseDetailSchema.parse(await r.json()))
  const curBeforeSafeRx = await readOp()
  const safeRxDraftRes = await s.mutate('doctor', `/api/his/v1/encounters/${op.encounterId}/prescription/draft`, {
    expectedVersions: { [`Encounter/${op.encounterId}`]: curBeforeSafeRx.encounter.versionId },
    input: {
      expectedDraftVersion: rxDraftVersion,
      items: [{
        catalogItemId: 'medication-amlodipine',
        courseDays: 30,
        doseText: '5 mg',
        frequencyCode: 'QD',
        quantity: 30,
        routeCode: 'PO',
      }],
    },
  }, 'PUT')
  expect(safeRxDraftRes.status, await safeRxDraftRes.clone().text()).toBe(200)
  const safeRxDraft = prescriptionDraftResponseSchema.parse(await safeRxDraftRes.json()).data
  const safeIssueRx = await s.mutate('doctor', `/api/his/v1/encounters/${op.encounterId}/prescription/actions/issue`, {
    expectedVersions: { [`Encounter/${op.encounterId}`]: curBeforeSafeRx.encounter.versionId },
    input: { expectedDraftVersion: safeRxDraft.draftVersion },
  })
  expect(safeIssueRx.status, await safeIssueRx.clone().text()).toBe(200)
  issuePrescriptionResponseSchema.parse(await safeIssueRx.json())

  const dDoc = await readOp()
  const revisedCase5Doc = await s.mutate('doctor', `/api/his/v1/clinical-documents/${op5Prereq.compositionId}/actions/revise`, {
    expectedVersions: {
      [`Composition/${op5Prereq.compositionId}`]: op5Prereq.compositionVersion,
      [`Encounter/${op.encounterId}`]: dDoc.encounter.versionId,
    },
    input: {
      document: {
        ...defaultOutpatientGateDocument,
        assessment: '2型糖尿病伴高血糖、高血压、慢性肾脏病4期（eGFR 26.0），停用经肾禁忌降糖药，维持氨氯地平降压。',
        chiefComplaint: '近期血糖偏高 1 个月复诊调药。',
        disposition: '开具苯磺酸氨氯地平片继续控制血压，肾内科及内分泌联合随访降糖方案。',
        followUp: '2 周内复查肾功能、血钾及空腹/餐后血糖。',
        historyOfPresentIllness: '既往糖尿病、高血压及慢性肾脏病史，近期血糖控制欠佳。',
        physicalExamination: '神清，双下肢轻度水肿。',
      },
      reason: '复查肾功能及处方调整后完善门诊病历。',
    },
  })
  expect(revisedCase5Doc.status, await revisedCase5Doc.clone().text()).toBe(200)
  clinicalDocumentRevisionResponseSchema.parse(await revisedCase5Doc.json())
  const dComplete = await readOp()
  const completeRes = await s.mutate('doctor', `/api/his/v1/encounters/${op.encounterId}/actions/complete`, {
    expectedVersions: { [`Encounter/${op.encounterId}`]: dComplete.encounter.versionId },
    input: {},
  })
  expect(completeRes.status, await completeRes.clone().text()).toBe(200)
  encounterCompletionResponseSchema.parse(await completeRes.json())

  const patients5 = patientSearchSchema.parse(await (await s.get('registrar', `/api/his/v1/patients?query=${encodeURIComponent('王淑芬')}`)).json())
  const patient5 = patients5.items.find(p => p.id === op.patientId)!
  const regCatalog5 = registrationCatalogSchema.parse(await (await s.get('registrar', '/api/his/v1/catalogs/registration')).json())
  const dupReg = await s.mutate('registrar', '/api/his/v1/registrations/actions/register', {
    expectedVersions: { [`Patient/${op.patientId}`]: patient5.versionId },
    input: {
      departmentId: regCatalog5.departments[0]!.id,
      locationId: regCatalog5.locations[0]!.id,
      patientId: op.patientId,
      visitDate: regCatalog5.virtualDate,
      visitTypeId: regCatalog5.visitTypes[0]!.id,
    },
  })
  expect(dupReg.status).toBe(409)
  expect(apiErrorSchema.parse(await dupReg.json()).error.code).toBe('WORKFLOW_CONFLICT')
  expect(s.modelCalls()).toBe(0)
}, 60_000)
