import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  agentCapabilityGrantSchema,
  agentClientSchema,
  agentPageBindingRevision,
  agentPageContextBindingSchema,
  agentToolAuthorizationResponseSchema,
  agentToolCatalog,
  agentToolCompletionResponseSchema,
  doctorCaseHistorySchema,
  doctorCompletedHistoryDetailSchema,
  type AgentPageContextBinding,
  type AgentPageContextClaim,
} from '@clinmesh/contracts/agent'
import { clinicalQualityCheckSchema } from '@clinmesh/contracts/clinical-quality'
import { clinicalScoreBundleSchema } from '@clinmesh/contracts/clinical-scores'
import { guidelineTopicBundleSchema } from '@clinmesh/contracts/guideline-topics'
import {
  apiErrorSchema,
  billingCaseSchema,
  caseLaboratoryCatalogSearchSchema,
  clinicalDocumentDraftResponseSchema,
  clinicalDocumentSignPreviewResponseSchema,
  clinicalDocumentSignResponseSchema,
  confirmDiagnosisResponseSchema,
  confirmNoMedicationResponseSchema,
  diagnosisDraftResponseSchema,
  dispenseResponseSchema,
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
  pharmacyQueueSchema,
  prescriptionDraftResponseSchema,
  prescriptionReviewResponseSchema,
  registrationCatalogSchema,
  registrationResponseSchema,
  sendConsultationMessageResponseSchema,
  sessionContextSchema,
  startVisitResponseSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { hisOperationCatalog } from '@clinmesh/contracts/his-operations'
import { commandReceiptLookupSchema, getHisOperation } from '@clinmesh/contracts/his-operations-runtime'
import { inpatientCommandResponseSchema, inpatientDetailSchema, inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { inpatientAngiographyReportsSchema } from '@clinmesh/contracts/inpatient-angiography'
import { inpatientFullCatalogSchema, inpatientFullClinicalResponseSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientInvestigationCatalogSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import {
  authoredCasePackPrepareResponseSchema,
  authoredCasePackSummarySchema,
  inpatientPciDataResponseSchema,
  startSyntheticInpatientCaseResponseSchema,
} from '@clinmesh/contracts/inpatient-pci-data'
import { inpatientPciSelectionResponseSchema, inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientSurgeryCatalogSchema, inpatientSurgeryResponseSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { insurancePreviewResponseSchema, insuranceResponseSchema } from '@clinmesh/contracts/insurance'
import { orderSetDraftBundleSchema } from '@clinmesh/contracts/order-set-templates'
import { startSyntheticCaseResultSchema } from '@clinmesh/contracts/scenario'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'

const dshSecret = 'specialist-dsh-bridge-secret-with-at-least-32-chars'
const leakPattern = /hiddenResources|caseTruth|rawBundle|angiography-conclusion|truth-stage/

async function createSpecialistReferenceDb(directory: string) {
  const databasePath = join(directory, 'specialist-reference.sqlite')
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
  const diagnosisConcepts = [
    { code: 'I21.401', display: '急性非ST段抬高型心肌梗死', row: 12550 },
    { code: 'I25.103', display: '冠状动脉粥样硬化性心脏病', row: 12670 },
    { code: 'I10.x09', display: '高血压', row: 12457 },
  ].map(({ code, display, row }) => ({
    code, display, domain: 'diagnosis' as const,
    id: `nhsa-diagnosis:nhc-icd10-clinical@2022.r4:${code}`,
    sourceLocator: `cn-health:nhc-icd10-clinical@2022.r4:diagnosis:${row}`,
    status: 'active' as const, system: 'urn:clinmesh:reference:nhsa-diagnosis', version: '2022',
  }))
  const artifactJson = `${JSON.stringify({
    concepts: [...diagnosisConcepts, ...tests.map(item => item.concept), ...panels.map(item => item.concept)],
    laboratoryDefinitions: [...tests.map(item => item.definition), ...panels.map(item => item.definition)],
    laboratoryPanelMembers: panels.flatMap(item => item.members),
    laboratorySpecimens: [],
    laboratoryUnits: [],
    schemaVersion: '1',
  })}\n`
  const manifestPath = join(directory, 'specialist-release.json')
  await writeFile(join(directory, 'specialist-reference.json'), artifactJson)
  await writeFile(manifestPath, `${JSON.stringify({
    createdAt: '2026-09-02T00:00:00.000Z',
    releaseId: 'specialist-five-cases-reference-v1',
    schemaVersion: '1',
    sources: [{
      acquisitionMethod: 'generated',
      artifactPath: 'specialist-reference.json',
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

describe('专病临床内核 CLI / Agent Capability Grant / DSH Surface 五例典型病例全链路验收', () => {
  let directory = ''
  let runtime!: Awaited<ReturnType<typeof createClinMeshRuntime>>
  const cookies = new Map<string, string>()
  const grants = new Map<string, string>()
  const unexpectedModelCalls: string[] = []
  const dialoguePayloads: Array<{ systemPrompt: string; userPayload: unknown }> = []
  let preparedPack!: z.infer<typeof authoredCasePackSummarySchema>
  let clientRevisions = 0

  function assertNoCaseTruthLeak(text: string, label: string) {
    expect(text, `Case Truth leaked in ${label}`).not.toMatch(leakPattern)
  }

  async function invokeOperationRaw(token: string, operationId: string, rawInput: unknown = {}, key = randomUUID()) {
    const op = getHisOperation(operationId)
    const parsedInput = op.input.parse(rawInput) as Record<string, unknown>
    const pathParams = new Set<string>()
    const resolvedPath = op.http.path.replace(/:([A-Za-z0-9_]+)/g, (_match, param: string) => {
      pathParams.add(param)
      const value = parsedInput[param]
      if (value === undefined) throw new Error(`Missing path param ${param} for ${operationId}`)
      return encodeURIComponent(String(value))
    })
    let url = resolvedPath
    let body: string | undefined
    if (op.http.method === 'GET') {
      const queryRecord = op.http.encodeQuery
        ? op.http.encodeQuery(parsedInput)
        : Object.fromEntries(
            Object.entries(parsedInput).flatMap(([k, v]) => pathParams.has(k) || v === undefined ? [] : [[k, String(v)]]),
          )
      const qs = new URLSearchParams(
        Object.entries(queryRecord).flatMap(([k, v]) =>
          v === undefined ? [] : Array.isArray(v) ? v.map(item => [k, String(item)] as [string, string]) : [[k, String(v)]],
        ),
      ).toString()
      if (qs) url += `?${qs}`
    } else if (op.http.encodeBody) {
      const encoded = op.http.encodeBody(parsedInput)
      body = encoded === undefined ? undefined : JSON.stringify(encoded)
    } else {
      const rest = Object.fromEntries(Object.entries(parsedInput).filter(([k]) => !pathParams.has(k)))
      body = JSON.stringify(rest)
    }
    const res = await runtime.app.request(url, {
      ...(body === undefined ? {} : { body }),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(op.http.method === 'GET' ? {} : { 'idempotency-key': key }),
      },
      method: op.http.method,
    })
    const text = await res.clone().text()
    assertNoCaseTruthLeak(text, `Grant ${operationId}`)
    return { op, res, text }
  }

  async function grantOp<T>(role: string, operationId: string, rawInput: unknown = {}, schema?: z.ZodType<T>, key = randomUUID()): Promise<T> {
    const token = grants.get(role)
    expect(token, `Missing Grant for ${role}`).toBeDefined()
    const { op, res, text } = await invokeOperationRaw(token!, operationId, rawInput, key)
    expect(res.status, `${operationId} failed: ${text}`).toBe(200)
    const json = JSON.parse(text) as unknown
    const validated = op.output.parse(json)
    return schema ? schema.parse(validated) : (validated as T)
  }

  function makeExecutionProof(binding: AgentPageContextBinding, operationId: string, callId = randomUUID()): string {
    const definition = agentToolCatalog.find(item => item.operationId === operationId)!
    const now = new Date()
    const pageRevision = agentPageBindingRevision(binding.snapshot.claim)
    const doctorOrigin = operationId.startsWith('outpatient.')
      ? {
          origin: {
            request: { pageRevision, scopeKey: binding.snapshot.scopeKey },
            task: {
              acceptedAt: now.toISOString(),
              messageId: `msg-${callId}`,
              pageRevision,
              rpcId: `rpc-${callId}`,
              scopeKey: binding.snapshot.scopeKey,
              turn: 1,
            },
          },
        }
      : {}
    const payload = {
      callId,
      contextId: binding.snapshot.id,
      dshSessionId: binding.snapshot.dshSessionId,
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      issuedAt: now.toISOString(),
      pageRevision,
      scopeKey: binding.snapshot.scopeKey,
      toolName: definition.toolName,
      version: 3,
      ...doctorOrigin,
    }
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const signature = createHmac('sha256', dshSecret).update(encoded).digest('base64url')
    return `${encoded}.${signature}`
  }

  async function surfaceContext(role: string, claim: AgentPageContextClaim, dshSessionId = `dsh-${role}`): Promise<AgentPageContextBinding> {
    const normalizedClaim: AgentPageContextClaim = claim.viewId === 'consultation' && claim.taskEpoch === undefined
      ? { ...claim, taskEpoch: 'a1b2c3d4-1234-4234-8234-123456789abc' }
      : claim
    const res = await runtime.app.request('/api/agent/v1/page-contexts', {
      body: JSON.stringify({ claim: normalizedClaim, client: { id: `surface-${role}`, revision: ++clientRevisions }, dshSessionId }),
      headers: { 'content-type': 'application/json', cookie: cookies.get(role)!, origin: 'http://localhost' },
      method: 'POST',
    })
    const text = await res.clone().text()
    expect(res.status, text).toBe(201)
    assertNoCaseTruthLeak(text, `PageContext ${role}:${claim.viewId}`)
    return agentPageContextBindingSchema.parse(JSON.parse(text))
  }

  async function surfaceDoctorQuery<T>(
    binding: AgentPageContextBinding,
    operationId: string,
    input: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const cookie = cookies.get('doctor')!
    const authRes = await runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: binding.token,
        executionProof: makeExecutionProof(binding, operationId),
        input,
        operationId,
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(authRes.status, await authRes.clone().text()).toBe(201)
    const authorized = agentToolAuthorizationResponseSchema.parse(await authRes.json())
    const queryRes = await runtime.app.request('/api/agent/v1/doctor-queries', {
      body: JSON.stringify({ contextToken: binding.token, input, receiptToken: authorized.receiptToken }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    const queryText = await queryRes.clone().text()
    expect(queryRes.status, queryText).toBe(200)
    assertNoCaseTruthLeak(queryText, `DSH doctor-queries ${operationId}`)
    const parsed = schema.parse(JSON.parse(queryText))
    const doneRes = await runtime.app.request('/api/agent/v1/tool-calls/result', {
      body: JSON.stringify({ ok: true, receiptToken: authorized.receiptToken, result: JSON.parse(queryText) }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(doneRes.status, await doneRes.clone().text()).toBe(200)
    expect(agentToolCompletionResponseSchema.parse(await doneRes.json()).status).toBe('completed')
    return parsed
  }

  async function surfaceInpatientQuery<T>(
    role: string,
    binding: AgentPageContextBinding,
    operationId: string,
    admissionId: string,
    subPath: string,
    input: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const cookie = cookies.get(role)!
    const authRes = await runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: binding.token,
        executionProof: makeExecutionProof(binding, operationId),
        input,
        operationId,
      }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(authRes.status, await authRes.clone().text()).toBe(201)
    const authorized = agentToolAuthorizationResponseSchema.parse(await authRes.json())
    const qs = new URLSearchParams(Object.entries(input).flatMap(([k, v]) => v === undefined ? [] : [[k, String(v)]])).toString()
    const readRes = await runtime.app.request(`/api/his/v1/inpatient/admissions/${encodeURIComponent(admissionId)}${subPath}${qs ? `?${qs}` : ''}`, {
      headers: { cookie },
    })
    const readText = await readRes.clone().text()
    expect(readRes.status, readText).toBe(200)
    assertNoCaseTruthLeak(readText, `DSH inpatient ${operationId}`)
    const parsed = schema.parse(JSON.parse(readText))
    const doneRes = await runtime.app.request('/api/agent/v1/tool-calls/result', {
      body: JSON.stringify({ ok: true, receiptToken: authorized.receiptToken, result: JSON.parse(readText) }),
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(doneRes.status, await doneRes.clone().text()).toBe(200)
    expect(agentToolCompletionResponseSchema.parse(await doneRes.json()).status).toBe('completed')
    return parsed
  }

  async function dispatchAll() {
    while (await runtime.dispatcher.dispatchOnce() !== undefined) { /* drain outbox */ }
  }

  async function startOutpatientByGrant(caseId: string, revision: number, activeBriefRevision: number, chiefComplaint: string) {
    const regCatalog = await grantOp('registrar', 'catalog.registration.read', {}, registrationCatalogSchema)
    const started = (await grantOp('registrar', 'registration.synthetic-case.start', {
      activeBriefRevision,
      caseId,
      departmentId: regCatalog.departments[0]!.id,
      expectedCaseRevision: revision,
      locationId: regCatalog.locations[0]!.id,
      visitDate: regCatalog.virtualDate,
      visitTypeId: regCatalog.visitTypes[0]!.id,
    }, z.object({ data: startSyntheticCaseResultSchema }).passthrough())).data
    const triaged = (await grantOp('triage', 'triage.record', {
      acuityCode: 'level-3',
      bloodPressure: { diastolicMmHg: 82, systolicMmHg: 138 },
      chiefComplaint,
      encounterId: started.encounterId,
      encounterVersion: '1',
      oxygenSaturationPct: 98,
      pulseBpm: 92,
      respirationBpm: 18,
      taskId: started.queueTaskId,
      taskVersion: '1',
      temperatureC: 36.6,
      weightKg: 74,
    }, triageResponseSchema)).data
    const firstVisitRes = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/start-first-visit`, {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${started.encounterId}`]: '2', [`Task/${triaged.doctorTaskId}`]: '1' },
        input: {},
      }),
      headers: {
        'content-type': 'application/json',
        cookie: cookies.get('doctor')!,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(firstVisitRes.status, await firstVisitRes.clone().text()).toBe(200)
    startVisitResponseSchema.parse(await firstVisitRes.json())
    return { caseId: started.outpatientCaseId, encounterId: started.encounterId, patientId: started.patientId }
  }

  async function payOutpatientByGrant(caseId: string, category: 'examination' | 'laboratory' | 'medication', chargeItemId: string) {
    const bill = await grantOp('cashier', 'billing.case.get', { caseId }, billingCaseSchema)
    const charge = bill.charges.find(item => item.chargeItemId === chargeItemId)!
    expect(charge).toBeDefined()
    if (charge.remainingFen <= 0) return
    const preview = (await grantOp('cashier', 'payment.preview', {
      caseId,
      category,
      chargeItemId: charge.chargeItemId,
      chargeVersion: charge.chargeVersion,
      simulatorRule: 'success',
    }, paymentPreviewResponseSchema)).data
    const confirmed = (await grantOp('cashier', 'payment.confirm', {
      chargeItemId: charge.chargeItemId,
      chargeVersion: charge.chargeVersion,
      commitToken: preview.commitToken,
      previewId: preview.previewId,
    }, paymentResponseSchema)).data
    expect(confirmed.outcome).toBe('success')
  }

  async function runOutpatientLabByGrant(caseId: string, encounterId: string, code: string, useInsurance = false) {
    const search = await grantOp('doctor', 'doctor.case.laboratory-catalog.search', { caseId, page: 1, pageSize: 20, query: code }, caseLaboratoryCatalogSearchSchema)
    const item = search.items.find(candidate => candidate.referenceConcept?.code === code)!
    expect(item, `Missing outpatient lab ${code}`).toBeDefined()
    const detail = await grantOp('doctor', 'doctor.case.get', { caseId }, doctorCaseDetailSchema)
    const draft = (await grantOp('doctor', 'encounter.laboratory-request.draft.set', {
      catalogItemId: item.id,
      encounterId,
      encounterVersion: detail.encounter.versionId,
      expectedDraftVersion: detail.laboratoryRequests?.draftVersion ?? 0,
      indicationCode: item.allowedIndicationCodes[0] ?? 'clinical-assessment',
    }, laboratoryRequestDraftResponseSchema)).data
    const issued = (await grantOp('doctor', 'encounter.laboratory-request.issue', {
      encounterId,
      encounterVersion: detail.encounter.versionId,
      expectedDraftVersion: draft.draftVersion,
    }, issueLaboratoryRequestResponseSchema)).data.request
    if (useInsurance) {
      const insPrev = (await grantOp('cashier', 'insurance.preview', {
        id: caseId,
        kind: 'outpatient',
        planCode: 'employee-v1',
      }, insurancePreviewResponseSchema)).data
      await grantOp('cashier', 'insurance.confirm', {
        commitToken: insPrev.commitToken,
        id: caseId,
        kind: 'outpatient',
        previewId: insPrev.previewId,
      }, insuranceResponseSchema)
    }
    await payOutpatientByGrant(caseId, 'laboratory', issued.billing!.chargeItemId)
    await dispatchAll()
    const updated = await grantOp('doctor', 'doctor.case.get', { caseId }, doctorCaseDetailSchema)
    const reported = updated.laboratoryRequests!.requests.find(req => req.id === issued.id)!
    expect(reported.status, JSON.stringify(reported.generationError)).toBe('reported')
    await grantOp('doctor', 'laboratory-report.acknowledge', {
      diagnosticReportId: reported.report!.diagnosticReportId,
      diagnosticReportVersion: reported.report!.diagnosticReportVersion,
      expectedRequestVersion: reported.version,
      requestId: reported.id,
    })
    return reported
  }

  async function runOutpatientExamByGrant(caseId: string, encounterId: string, serviceId: 'examination-ecg-12-lead' | 'examination-tte') {
    const detail = await grantOp('doctor', 'doctor.case.get', { caseId }, doctorCaseDetailSchema)
    const draft = await grantOp('doctor', 'encounter.examination-request.draft.set', {
      encounterId,
      encounterVersion: detail.encounter.versionId,
      expectedDraftVersion: detail.examinationRequests?.draftVersion ?? 0,
      indication: '心血管专病功能学检查',
      serviceId,
    }, z.object({ data: z.object({ draftVersion: z.number() }) }).passthrough())
    const issued = examinationRequestSchema.parse(
      (await grantOp('doctor', 'encounter.examination-request.issue', {
        encounterId,
        encounterVersion: detail.encounter.versionId,
        expectedDraftVersion: draft.data.draftVersion,
      }, z.object({ data: z.object({ request: examinationRequestSchema }) }).passthrough())).data.request,
    )
    await payOutpatientByGrant(caseId, 'examination', issued.billing!.chargeItemId)
    await dispatchAll()
    const updated = await grantOp('doctor', 'doctor.case.get', { caseId }, doctorCaseDetailSchema)
    const reported = updated.examinationRequests!.requests.find(req => req.id === issued.id)!
    expect(reported.status).toBe('reported')
    await grantOp('doctor', 'examination-report.acknowledge', {
      diagnosticReportId: reported.report!.diagnosticReportId,
      diagnosticReportVersion: reported.report!.diagnosticReportVersion,
      expectedRequestVersion: reported.version,
      requestId: reported.id,
    })
    return reported
  }

  async function startDirectInpatientByGrant(caseId: string, revision: number, activeBriefRevision: number, bedId: string) {
    const started = (await grantOp('registrar', 'registration.synthetic-case.start-inpatient', {
      activeBriefRevision,
      caseId,
      expectedCaseRevision: revision,
      expectedEpoch: 'epoch-1',
      wardId: 'ward-general',
    }, startSyntheticInpatientCaseResponseSchema)).data
    const list = await grantOp('ward-nurse', 'inpatient.admission.list', {}, inpatientListSchema)
    const adm = list.items.find(item => item.id === started.admissionId)!
    const received = (await grantOp('ward-nurse', 'inpatient.admission.receive', {
      admissionId: started.admissionId,
      bedId,
      encounterVersion: adm.versionId,
    }, inpatientCommandResponseSchema)).data.admission
    return { ...started, admission: received }
  }

  async function runInpatientLabByGrant(admissionId: string, displayQuery: string, acknowledge = true) {
    const adm = (await grantOp('inpatient-doctor', 'inpatient.admission.read', { admissionId }, inpatientDetailSchema)).admission
    const catalog = await grantOp('inpatient-doctor', 'inpatient.investigation.catalog', {}, inpatientInvestigationCatalogSchema)
    const service = catalog.items.find(item => item.kind === 'laboratory' && item.available && item.display.includes(displayQuery))!
    expect(service, `Missing inpatient lab ${displayQuery}`).toBeDefined()
    const afterIssue = (await grantOp('inpatient-doctor', 'inpatient.investigation.issue', {
      admissionId,
      catalogVersion: service.version,
      encounterVersion: adm.versionId,
      selection: { catalogItemId: service.id, indicationCode: service.indicationCodes[0] ?? 'clinical-assessment', kind: 'laboratory' },
    }, z.object({ data: inpatientInvestigationsSchema }).passthrough())).data
    const req = afterIssue.laboratoryRequests.find(item => item.status === 'issued' && item.catalogItemId === service.id)!
    await grantOp('ward-nurse', 'inpatient.investigation.send', {
      admissionId,
      expectedRequestVersion: req.version,
      requestId: req.id,
      serviceRequestVersion: req.serviceRequestVersion,
      taskVersion: req.taskVersion,
    })
    await dispatchAll()
    const afterReport = await grantOp('inpatient-doctor', 'inpatient.investigation.read', { admissionId }, inpatientInvestigationsSchema)
    const reported = afterReport.laboratoryRequests.find(item => item.id === req.id)!
    expect(reported.status).toBe('reported')
    if (acknowledge) {
      await grantOp('inpatient-doctor', 'inpatient.investigation.acknowledge', {
        admissionId,
        diagnosticReportId: reported.report!.diagnosticReportId,
        diagnosticReportVersion: reported.report!.diagnosticReportVersion,
        expectedRequestVersion: reported.version,
        requestId: reported.id,
        serviceRequestVersion: reported.serviceRequestVersion,
        taskVersion: reported.taskVersion,
      })
    }
    return reported
  }

  async function executeAngiographyByGrant(admissionId: string) {
    const catalog = await grantOp('inpatient-doctor', 'inpatient.surgery.catalog', {}, inpatientSurgeryCatalogSchema)
    const angioProc = catalog.procedures.find(item => item.coding.code === '88.5500')!
    const adm = (await grantOp('inpatient-doctor', 'inpatient.admission.read', { admissionId }, inpatientDetailSchema)).admission
    const requested = (await grantOp('inpatient-doctor', 'inpatient.surgery.request', {
      admissionId,
      anesthesiaMethod: 'local-infiltration',
      catalogVersion: angioProc.version,
      encounterVersion: adm.versionId,
      locationId: 'location-catheterization-lab',
      plannedFor: '2026-08-24T11:00:00+08:00',
      procedureId: angioProc.id,
      reason: '选择性冠脉造影评估',
      surgeonPractitionerId: 'practitioner-inpatient-doctor',
      surgeryType: 'elective',
    }, inpatientSurgeryResponseSchema)).data.requests.find(item => item.plannedProcedure.id === angioProc.id && item.status === 'requested')!
    const preop = (await grantOp('ward-nurse', 'inpatient.surgery.check-preop', {
      admissionId,
      expectedRequestVersion: requested.version,
      note: '术前核查完成',
      requestId: requested.id,
    }, inpatientSurgeryResponseSchema)).data.requests.find(item => item.id === requested.id)!
    const clinical = await grantOp('inpatient-doctor', 'inpatient.clinical.read', { admissionId }, inpatientFullClinicalSchema)
    const consent = (await grantOp('inpatient-doctor', 'inpatient.surgery.confirm-consent', {
      admissionId,
      expectedDiagnosisRevision: clinical.diagnosis.revision,
      expectedRequestVersion: preop.version,
      note: '知情同意书已签署',
      patientChoice: 'agree',
      requestId: requested.id,
      signerName: adm.patientName,
      signerRole: 'patient',
    }, inpatientSurgeryResponseSchema)).data.requests.find(item => item.id === requested.id)!
    await grantOp('inpatient-doctor', 'inpatient.surgery.execute', {
      admissionId,
      catalogVersion: angioProc.version,
      expectedRequestVersion: consent.version,
      materials: [],
      note: '完成选择性冠脉造影及生理学评估',
      procedureId: angioProc.id,
      requestId: requested.id,
    }, inpatientSurgeryResponseSchema)
    await dispatchAll()
    const reports = await grantOp('inpatient-doctor', 'inpatient.angiography-reports.read', { admissionId }, inpatientAngiographyReportsSchema)
    return reports.reports[0]!
  }

  async function executeSingleStentPciByGrant(admissionId: string) {
    const catalog = await grantOp('inpatient-doctor', 'inpatient.surgery.catalog', {}, inpatientSurgeryCatalogSchema)
    const pciProc = catalog.procedures.find(item => item.coding.code === '36.0700')!
    const adm = (await grantOp('inpatient-doctor', 'inpatient.admission.read', { admissionId }, inpatientDetailSchema)).admission
    const requested = (await grantOp('inpatient-doctor', 'inpatient.surgery.request', {
      admissionId,
      anesthesiaMethod: 'local-infiltration',
      catalogVersion: pciProc.version,
      encounterVersion: adm.versionId,
      locationId: 'location-catheterization-lab',
      plannedFor: '2026-08-24T14:00:00+08:00',
      procedureId: pciProc.id,
      reason: '缺血靶病变单支架 PCI 血运重建',
      surgeonPractitionerId: 'practitioner-inpatient-doctor',
      surgeryType: 'elective',
    }, inpatientSurgeryResponseSchema)).data.requests.find(item => item.plannedProcedure.id === pciProc.id && item.status === 'requested')!
    const materialIds = [
      'hospital-material-pci-guidewire',
      'hospital-material-pci-guiding-catheter',
      'hospital-material-pci-balloon',
      'hospital-material-pci-stent',
    ] as const
    let reservations: z.infer<typeof inpatientMaterialReservationListSchema>['reservations'] = []
    for (const materialId of materialIds) {
      const material = catalog.materials.find(item => item.id === materialId)!
      const curAdm = (await grantOp('inpatient-doctor', 'inpatient.admission.read', { admissionId }, inpatientDetailSchema)).admission
      const res = await grantOp('inpatient-doctor', 'inpatient.drg.reservation.create', {
        admissionId,
        catalogVersion: material.version,
        encounterVersion: curAdm.versionId,
        materialId,
        quantity: 1,
        reason: '单支架 PCI 术前耗材预留',
        requestId: requested.id,
      }, z.object({ data: inpatientMaterialReservationListSchema }).passthrough())
      reservations = res.data.reservations
    }
    const sel = await grantOp('inpatient-doctor', 'inpatient.pci-selection.read', { admissionId }, inpatientPciSelectionSchema)
    const draft = sel.drafts!.find(item => item.requestId === requested.id)!
    await grantOp('inpatient-doctor', 'inpatient.pci-selection.confirm', {
      admissionId,
      expectedVersion: sel.confirmation?.version ?? 0,
      parameters: {
        ...draft.parameters,
        approvedMaterialIds: [...materialIds],
      },
    }, inpatientPciSelectionResponseSchema)
    const preop = (await grantOp('ward-nurse', 'inpatient.surgery.check-preop', {
      admissionId,
      expectedRequestVersion: requested.version,
      note: 'PCI 术前核查完成',
      requestId: requested.id,
    }, inpatientSurgeryResponseSchema)).data.requests.find(item => item.id === requested.id)!
    const clinical = await grantOp('inpatient-doctor', 'inpatient.clinical.read', { admissionId }, inpatientFullClinicalSchema)
    const consent = (await grantOp('inpatient-doctor', 'inpatient.surgery.confirm-consent', {
      admissionId,
      expectedDiagnosisRevision: clinical.diagnosis.revision,
      expectedRequestVersion: preop.version,
      note: 'PCI 知情同意已确认',
      patientChoice: 'agree',
      requestId: requested.id,
      signerName: adm.patientName,
      signerRole: 'patient',
    }, inpatientSurgeryResponseSchema)).data.requests.find(item => item.id === requested.id)!
    const executed = await grantOp('inpatient-doctor', 'inpatient.surgery.execute', {
      admissionId,
      catalogVersion: pciProc.version,
      expectedRequestVersion: consent.version,
      materials: reservations
        .filter(item => item.requestId === requested.id)
        .map(item => ({
          catalogVersion: catalog.materials.find(m => m.id === item.materialId)!.version,
          materialId: item.materialId,
          quantity: item.quantity,
          reservationId: item.id,
        })),
      note: '完成前降支单枚药物洗脱支架置入术，TIMI 3 级血流',
      procedureId: pciProc.id,
      requestId: requested.id,
    }, inpatientSurgeryResponseSchema)
    return executed.data.executions.find(item => item.requestId === requested.id)!
  }

  async function issueSecondaryPreventionLongOrders(admissionId: string, includeP2y12 = true) {
    const clinicalCatalog = await grantOp('inpatient-doctor', 'inpatient.clinical.catalog', {}, inpatientFullCatalogSchema)
    const specs = [
      ['medication-pci-aspirin', '100 mg', 1, 'QD'],
      ...(includeP2y12 ? [['medication-pci-clopidogrel', '75 mg', 1, 'QD'] as const] : []),
      ['medication-pci-atorvastatin', '20 mg', 2, 'QD'],
    ] as const
    for (const [id, doseText, doseQuantity, frequencyCode] of specs) {
      const med = clinicalCatalog.medications.find(item => item.id === id)!
      const curAdm = (await grantOp('inpatient-doctor', 'inpatient.admission.read', { admissionId }, inpatientDetailSchema)).admission
      await grantOp('inpatient-doctor', 'inpatient.order.issue', {
        admissionId,
        duration: 'long',
        encounterVersion: curAdm.versionId,
        selection: {
          catalogItemId: med.id,
          catalogVersion: med.version,
          doseQuantity,
          doseText,
          frequencyCode,
          kind: 'medication',
          routeCode: med.defaultRouteCode,
        },
      }, inpatientFullClinicalResponseSchema)
    }
  }

  async function dischargeDepartAndOptionallyClear(admissionId: string, clearBed = false) {
    const quality = await grantOp('inpatient-doctor', 'inpatient.clinical-quality.read', {
      admissionId,
      gate: 'inpatient-discharge',
    }, clinicalQualityCheckSchema)
    expect(quality).toMatchObject({ alerts: [], redLines: [], status: 'pass' })
    const admBeforeIssue = (await grantOp('inpatient-doctor', 'inpatient.admission.read', { admissionId }, inpatientDetailSchema)).admission
    await grantOp('inpatient-doctor', 'inpatient.discharge.issue', {
      admissionId,
      encounterVersion: admBeforeIssue.versionId,
      reason: '病情稳定，二级预防方案齐备，准予出院随访',
    })
    const clinical = await grantOp('inpatient-doctor', 'inpatient.clinical.read', { admissionId }, inpatientFullClinicalSchema)
    for (const order of clinical.orders.filter(item => item.state !== 'stopped' && item.state !== 'completed')) {
      const stopped = (await grantOp('inpatient-doctor', 'inpatient.order.request-stop', {
        admissionId,
        expectedOrderVersion: order.version,
        orderId: order.id,
        reason: '患者拟离区出院，按出区流程停长期/未执行医嘱',
      }, inpatientFullClinicalResponseSchema)).data.orders.find(item => item.id === order.id)!
      await grantOp('ward-nurse', 'inpatient.order.verify-stop', {
        admissionId,
        expectedOrderVersion: stopped.version,
        orderId: order.id,
      }, inpatientFullClinicalResponseSchema)
    }
    const admBeforeDepart = (await grantOp('ward-nurse', 'inpatient.admission.read', { admissionId }, inpatientDetailSchema)).admission
    await grantOp('ward-nurse', 'inpatient.discharge.depart', {
      admissionId,
      departureMethod: 'home',
      encounterVersion: admBeforeDepart.versionId,
      reason: '患者办理出院离区',
    })
    if (clearBed) {
      const preview = await grantOp('cashier', 'inpatient.discharge.preview', { admissionId }, inpatientSettlementPreviewSchema)
      if (preview.balanceFen > 0) {
        const payPrev = (await grantOp('cashier', 'inpatient.payment.preview', {
          admissionId,
          amountFen: preview.balanceFen,
          kind: 'supplement',
          simulatorRule: 'success',
          tenders: [{ amountFen: preview.balanceFen, method: 'cash' }],
        }) as { data: { commitToken: string; previewId: string } }).data
        await grantOp('cashier', 'inpatient.payment.confirm', {
          admissionId,
          commitToken: payPrev.commitToken,
          previewId: payPrev.previewId,
        })
      }
      const freshPreview = await grantOp('cashier', 'inpatient.discharge.preview', { admissionId }, inpatientSettlementPreviewSchema)
      await grantOp('cashier', 'inpatient.discharge.settle', {
        admissionId,
        encounterVersion: freshPreview.encounterVersion,
        expectedBalanceFen: freshPreview.balanceFen,
        expectedChargesFen: freshPreview.chargesFen,
        fingerprint: freshPreview.fingerprint,
      }, inpatientSettlementResponseSchema)
      const admBeforeClear = (await grantOp('ward-nurse', 'inpatient.admission.read', { admissionId }, inpatientDetailSchema)).admission
      await grantOp('ward-nurse', 'inpatient.discharge.clear', {
        admissionId,
        encounterVersion: admBeforeClear.versionId,
        reason: '出院结算完成，释放床位',
      })
    }
  }

  async function startOutpatientFollowUpByGrant(patientId: string, patientName: string, chiefComplaint: string) {
    const patients = await grantOp('registrar', 'patient.search', { query: patientName }, patientSearchSchema)
    const patient = patients.items.find(item => item.id === patientId)!
    const regCatalog = await grantOp('registrar', 'catalog.registration.read', {}, registrationCatalogSchema)
    const reg = (await grantOp('registrar', 'registration.create', {
      departmentId: regCatalog.departments[0]!.id,
      locationId: regCatalog.locations[0]!.id,
      patientId,
      patientVersion: patient.versionId,
      visitDate: regCatalog.virtualDate,
      visitTypeId: regCatalog.visitTypes[0]!.id,
    }, registrationResponseSchema)).data
    const triaged = (await grantOp('triage', 'triage.record', {
      acuityCode: 'level-3',
      bloodPressure: { diastolicMmHg: 76, systolicMmHg: 124 },
      chiefComplaint,
      encounterId: reg.encounterId,
      encounterVersion: '1',
      oxygenSaturationPct: 99,
      pulseBpm: 68,
      respirationBpm: 18,
      taskId: reg.queueTaskId,
      taskVersion: '1',
      temperatureC: 36.5,
      weightKg: 74,
    }, triageResponseSchema)).data
    const firstVisitRes = await runtime.app.request(`/api/his/v1/encounters/${reg.encounterId}/actions/start-first-visit`, {
      body: JSON.stringify({
        expectedVersions: { [`Encounter/${reg.encounterId}`]: '2', [`Task/${triaged.doctorTaskId}`]: '1' },
        input: {},
      }),
      headers: {
        'content-type': 'application/json',
        cookie: cookies.get('doctor')!,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(firstVisitRes.status, await firstVisitRes.clone().text()).toBe(200)
    startVisitResponseSchema.parse(await firstVisitRes.json())
    const queue = await grantOp('doctor', 'doctor.queue.list', { page: 1, pageSize: 20 }, doctorQueueSchema)
    return {
      caseId: queue.items.find(item => item.encounterId === reg.encounterId)!.caseId,
      encounterId: reg.encounterId,
    }
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'clinmesh-specialist-five-cases-'))
    const password = `Synthetic-${randomUUID()}-Aa1!`
    const referenceDatabasePath = await createSpecialistReferenceDb(directory)
    runtime = await createClinMeshRuntime({
      activeReferenceReleaseId: 'specialist-five-cases-reference-v1',
      authBaseUrl: 'http://localhost',
      authSecret: randomUUID() + randomUUID(),
      chatCompletionsProvider: {
        async completeJson(input) {
          if (input.schemaName === 'patient_dialogue_reply') {
            dialoguePayloads.push({ systemPrompt: input.systemPrompt, userPayload: input.userPayload })
            return { content: JSON.stringify({ reply: '医生您好，我胸口闷痛一阵一阵的，伴轻微出汗。' }), model: input.model }
          }
          if (input.schemaName === 'clinical_document_quality' || input.usageContext?.stage === 'recording') {
            return {
              content: JSON.stringify(input.schemaName === 'clinical_document_quality' ? { agentFactChecks: [], issues: [], recordingChecks: [] } : { changes: [] }),
              model: input.model,
            }
          }
          unexpectedModelCalls.push(input.schemaName)
          throw new Error(`专病确定性内核全链路不应触发非预期模型调用: ${input.schemaName}`)
        },
      },
      consultationModel: 'synthetic-specialist-dialogue',
      cursorSecret: randomUUID() + randomUUID(),
      databasePath: join(directory, 'specialist.sqlite'),
      demoPassword: password,
      dshBridgeSecret: dshSecret,
      investigationModel: 'unexpected-investigation-model',
      migrationMode: 'apply',
      patientPersonaModel: 'synthetic',
      referenceDatabasePath,
      trustedOrigins: ['http://localhost'],
    })

    const roles = ['admin', 'registrar', 'triage', 'doctor', 'inpatient-doctor', 'ward-nurse', 'cashier', 'pharmacist'] as const
    for (const role of roles) {
      const signInRes = await runtime.app.request('/api/auth/sign-in/email', {
        body: JSON.stringify({ email: `${role}@demo.clinmesh.local`, password }),
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        method: 'POST',
      })
      expect(signInRes.status).toBe(200)
      cookies.set(role, signInRes.headers.get('set-cookie')!.split(';', 1)[0]!)
    }

    const adminCookie = cookies.get('admin')!
    const agentClient = agentClientSchema.parse(await (await runtime.app.request('/api/agent/v1/clients', {
      body: JSON.stringify({ name: 'Specialist Five-Case Journey CLI Agent' }),
      headers: { 'content-type': 'application/json', cookie: adminCookie, 'idempotency-key': randomUUID(), origin: 'http://localhost' },
      method: 'POST',
    })).json())

    for (const role of roles) {
      const session = sessionContextSchema.parse(await (await runtime.app.request('/api/auth/context', {
        headers: { cookie: cookies.get(role)! },
      })).json())
      const operationIds = hisOperationCatalog
        .filter(op => (op.roles as readonly string[]).includes(session.actor.roleCode))
        .map(op => op.id)
      const grantRes = await runtime.app.request('/api/agent/v1/grants', {
        body: JSON.stringify({
          agentClientId: agentClient.agentClientId,
          operationIds,
          practitionerRoleId: session.actor.practitionerRoleId,
          ttlSeconds: 3_600,
        }),
        headers: { 'content-type': 'application/json', cookie: adminCookie, 'idempotency-key': randomUUID(), origin: 'http://localhost' },
        method: 'POST',
      })
      expect(grantRes.status, await grantRes.clone().text()).toBe(200)
      grants.set(role, agentCapabilityGrantSchema.parse(await grantRes.json()).token)
    }

    // Admin Grant prepares PCI catalog & 5-case Authored Case Pack and verifies durable receipt
    await grantOp('admin', 'inpatient.pci-data.prepare', { expectedEpoch: 'epoch-1' }, inpatientPciDataResponseSchema)
    const initialSummary = await grantOp('admin', 'admin.authored-case-pack.read', {}, authoredCasePackSummarySchema)
    expect(initialSummary).toMatchObject({ readyCount: 0, totalCount: 5 })
    const packKey = randomUUID()
    const preparedRes = await grantOp('admin', 'admin.authored-case-pack.prepare', { expectedEpoch: 'epoch-1' }, authoredCasePackPrepareResponseSchema, packKey)
    expect(preparedRes.data).toMatchObject({ readyCount: 5, totalCount: 5 })
    const receipt = await grantOp('admin', 'command.receipt.get', {
      idempotencyKey: packKey,
      operationId: 'admin.authored-case-pack.prepare',
    }, commandReceiptLookupSchema)
    expect(receipt).toMatchObject({ idempotencyKey: packKey, operationId: 'admin.authored-case-pack.prepare', status: 'completed' })
    preparedPack = await grantOp('admin', 'admin.authored-case-pack.read', {}, authoredCasePackSummarySchema)
    expect(preparedPack.readyCount).toBe(5)
  }, 30_000)

  afterAll(async () => {
    await runtime?.close()
    if (directory) await rm(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 })
  })

  it('病例①（cardio-nstemi-chest-pain-v1）：贯通门诊胸痛质控、心电图与复测肌钙蛋白、住院 GRACE/TIMI/指南/多支造影/PCI、二级预防出院及门诊随访 LDL-C/PRECISE-DAPT', async () => {
    const case1 = preparedPack.cases.find(item => item.draftId === 'cardio-nstemi-chest-pain-v1')!.case!
    const op = await startOutpatientByGrant(case1.caseId, case1.revision, case1.activeBriefRevision!, '间断胸骨后闷痛 6 小时')

    // Patient consultation dialogue: verify zero Case Truth leakage in prompt, payload, and response
    const detail0 = await grantOp('doctor', 'doctor.case.get', { caseId: op.caseId }, doctorCaseDetailSchema)
    const dialogue = await grantOp('doctor', 'encounter.consultation.ask', {
      encounterId: op.encounterId,
      encounterVersion: detail0.encounter.versionId,
      expectedConsultationVersion: detail0.consultation!.version,
      message: '请问胸痛持续多久，走路时是否加重？',
      taskId: detail0.taskId,
      taskVersion: detail0.taskVersion,
    }, sendConsultationMessageResponseSchema)
    expect(dialogue.data.patientTurn.messageText).toContain('胸口闷痛')
    expect(dialoguePayloads).toHaveLength(1)
    assertNoCaseTruthLeak(dialoguePayloads[0]!.systemPrompt, 'dialogue systemPrompt')
    assertNoCaseTruthLeak(JSON.stringify(dialoguePayloads[0]!.userPayload), 'dialogue userPayload')

    // Verify DSH Page Context section isolation (`laboratory` stays <= 32 without decision read tools; `diagnosis` exposes them)
    const detail1 = await grantOp('doctor', 'doctor.case.get', { caseId: op.caseId }, doctorCaseDetailSchema)
    const labCtx = await surfaceContext('doctor', {
      activeSection: 'laboratory',
      selection: { id: op.caseId, kind: 'case', version: detail1.encounter.versionId },
      ui: { status: 'ready' },
      version: 1,
      viewId: 'consultation',
      viewRevision: 'case1-lab',
    })
    expect(labCtx.snapshot.allowedOperationIds.length).toBeLessThanOrEqual(32)
    expect(labCtx.snapshot.allowedOperationIds).not.toContain('outpatient.clinical-scores.read')
    expect(labCtx.snapshot.allowedOperationIds).not.toContain('outpatient.clinical-quality.read')

    const diagCtx = await surfaceContext('doctor', {
      activeSection: 'diagnosis',
      selection: { id: op.caseId, kind: 'case', version: detail1.encounter.versionId },
      ui: { status: 'ready' },
      version: 1,
      viewId: 'consultation',
      viewRevision: 'case1-diag',
    })
    expect(diagCtx.snapshot.allowedOperationIds).toEqual(expect.arrayContaining([
      'outpatient.clinical-scores.read',
      'outpatient.guideline-topics.read',
      'outpatient.clinical-quality.read',
      'outpatient.order-set-drafts.read',
    ]))

    // Before ECG & hs-cTnI: DSH `outpatient.clinical-quality.read` flags CHEST_PAIN_WORKUP_INCOMPLETE
    const preWorkupQuality = await surfaceDoctorQuery(diagCtx, 'outpatient.clinical-quality.read', { gate: 'outpatient-completion' }, clinicalQualityCheckSchema)
    expect(preWorkupQuality.alerts).toContainEqual(expect.objectContaining({ code: 'CHEST_PAIN_WORKUP_INCOMPLETE', tier: 'alert' }))

    // Read `chest-pain-stat-workup` via DSH `outpatient.order-set-drafts.read`, then run ECG + hs-cTnI x2 + baseline LDL-C & Scr
    const opOrderSet = await surfaceDoctorQuery(diagCtx, 'outpatient.order-set-drafts.read', { templateId: 'chest-pain-stat-workup' }, orderSetDraftBundleSchema)
    expect(opOrderSet.drafts[0]!.template.id).toBe('chest-pain-stat-workup')

    const preWorkupUnrevealedPattern = /I21\.4|急性非ST段抬高型心肌梗死|LAD 近段|90%|V2-V5/
    const internalSystemPrompt = dialoguePayloads[0]!.systemPrompt
    expect(internalSystemPrompt.trim().length).toBeGreaterThan(0)
    for (const [label, payload] of [
      ['detail0', detail0],
      ['dialogue', dialogue],
      ['labCtx', labCtx],
      ['diagCtx', diagCtx],
      ['preWorkupQuality', preWorkupQuality],
      ['opOrderSet', opOrderSet],
    ] as const) {
      const serialized = JSON.stringify(payload)
      expect(serialized, `${label} must not leak unrevealed Case Truth`).not.toMatch(preWorkupUnrevealedPattern)
      expect(serialized, `${label} must not echo internal systemPrompt`).not.toContain(internalSystemPrompt)
    }

    const ecg = await runOutpatientExamByGrant(op.caseId, op.encounterId, 'examination-ecg-12-lead')
    expect(ecg.report!.impression).toContain('ST段压低')
    const ctni1 = await runOutpatientLabByGrant(op.caseId, op.encounterId, '2100404B')
    expect(ctni1.report!.results.find(r => r.code === '2100404B')?.value).toBe(680)
    const ctni2 = await runOutpatientLabByGrant(op.caseId, op.encounterId, '2100404B')
    expect(ctni2.report!.results.find(r => r.code === '2100404B')?.value).toBe(1450)
    await runOutpatientLabByGrant(op.caseId, op.encounterId, '2000404A')
    await runOutpatientLabByGrant(op.caseId, op.encounterId, '1700404A')

    const postWorkupDetail = await grantOp('doctor', 'doctor.case.get', { caseId: op.caseId }, doctorCaseDetailSchema)
    const postWorkupCtx = await surfaceContext('doctor', {
      activeSection: 'record',
      selection: { id: op.caseId, kind: 'case', version: postWorkupDetail.encounter.versionId },
      ui: { status: 'ready' },
      version: 1,
      viewId: 'consultation',
      viewRevision: 'case1-record-after-workup',
    })
    const postWorkupQuality = await surfaceDoctorQuery(postWorkupCtx, 'outpatient.clinical-quality.read', { gate: 'outpatient-completion' }, clinicalQualityCheckSchema)
    expect(postWorkupQuality).toMatchObject({ alerts: [], redLines: [], status: 'pass' })

    // Referral & complete initial outpatient visit -> inpatient admission & receive
    const referral = (await grantOp('doctor', 'inpatient.referral.issue', {
      encounterId: op.encounterId,
      encounterVersion: postWorkupDetail.encounter.versionId,
      reason: '高危 NSTEMI，收住院急诊/早期冠脉造影与 PCI',
      wardId: 'ward-general',
    }) as { data: { referral: { id: string; patientVersion: string } } }).data.referral

    const d1 = await grantOp('doctor', 'doctor.case.get', { caseId: op.caseId }, doctorCaseDetailSchema)
    const diagDraft = (await grantOp('doctor', 'encounter.diagnosis.draft.set', {
      encounterId: op.encounterId,
      encounterVersion: d1.encounter.versionId,
      entries: [{ catalogItemId: 'diagnosis-coronary-heart-disease', role: 'primary' }],
      expectedDraftVersion: 0,
    }, diagnosisDraftResponseSchema)).data
    await grantOp('doctor', 'encounter.diagnosis.confirm', {
      encounterId: op.encounterId,
      encounterVersion: d1.encounter.versionId,
      expectedDraftVersion: diagDraft.draftVersion,
    }, confirmDiagnosisResponseSchema)
    const d2 = await grantOp('doctor', 'doctor.case.get', { caseId: op.caseId }, doctorCaseDetailSchema)
    await grantOp('doctor', 'encounter.medication-conclusion.confirm-none', {
      encounterId: op.encounterId,
      encounterVersion: d2.encounter.versionId,
      expectedDraftVersion: 0,
    }, confirmNoMedicationResponseSchema)
    const d3 = await grantOp('doctor', 'doctor.case.get', { caseId: op.caseId }, doctorCaseDetailSchema)
    const docDraft = (await grantOp('doctor', 'encounter.clinical-document.draft.set', {
      document: {
        assessment: '急性非ST段抬高型心肌梗死高危，转入心内科病房。',
        chiefComplaint: '间断胸骨后闷痛 6 小时。',
        disposition: '开具住院证转住院行冠脉造影及 PCI。',
        followUp: '出院后心内科门诊随访。',
        historyOfPresentIllness: '胸痛伴心电图前壁 ST 段压低，高敏肌钙蛋白动态升高。',
        physicalExamination: '神清，双肺呼吸音清。',
      },
      encounterId: op.encounterId,
      encounterVersion: d3.encounter.versionId,
      expectedDraftVersion: 0,
    }, clinicalDocumentDraftResponseSchema)).data
    const d4 = await grantOp('doctor', 'doctor.case.get', { caseId: op.caseId }, doctorCaseDetailSchema)
    const signPrev = (await grantOp('doctor', 'encounter.clinical-document.sign.preview', {
      encounterId: op.encounterId,
      encounterVersion: d4.encounter.versionId,
      expectedDraftVersion: docDraft.draftVersion,
    }, clinicalDocumentSignPreviewResponseSchema)).data
    const d5 = await grantOp('doctor', 'doctor.case.get', { caseId: op.caseId }, doctorCaseDetailSchema)
    await grantOp('doctor', 'encounter.clinical-document.sign', {
      commitToken: signPrev.commitToken,
      encounterId: op.encounterId,
      encounterVersion: d5.encounter.versionId,
      previewId: signPrev.previewId,
    }, clinicalDocumentSignResponseSchema)
    const d6 = await grantOp('doctor', 'doctor.case.get', { caseId: op.caseId }, doctorCaseDetailSchema)
    await grantOp('doctor', 'encounter.complete', {
      encounterId: op.encounterId,
      encounterVersion: d6.encounter.versionId,
    }, encounterCompletionResponseSchema)

    const admReg = (await grantOp('registrar', 'inpatient.admission.register', {
      admissionRoute: 'outpatient',
      depositFen: 500_000,
      expectedEpoch: 'epoch-1',
      patientId: op.patientId,
      patientVersion: referral.patientVersion,
      referralId: referral.id,
      wardId: 'ward-general',
    }, inpatientCommandResponseSchema)).data.admission
    const admReceived = (await grantOp('ward-nurse', 'inpatient.admission.receive', {
      admissionId: admReg.id,
      bedId: 'bed-general-1',
      encounterVersion: admReg.versionId,
    }, inpatientCommandResponseSchema)).data.admission

    // Inpatient vitals, risk assessment, labs, ECG + TTE (with DSH functional examination report acknowledgement!)
    await grantOp('ward-nurse', 'inpatient.vital-signs.record', {
      admissionId: admReg.id,
      bloodPressure: { diastolicMmHg: 80, systolicMmHg: 134 },
      encounterVersion: admReceived.versionId,
      expectedRevision: 0,
      oxygenSaturationPct: 98,
      pulseBpm: 88,
      respirationBpm: 18,
      temperatureC: 36.6,
      weightKg: 74,
    }, inpatientFullClinicalResponseSchema)
    const admAfterVitals = (await grantOp('inpatient-doctor', 'inpatient.admission.read', { admissionId: admReg.id }, inpatientDetailSchema)).admission
    await grantOp('inpatient-doctor', 'inpatient.risk-assessment.record', {
      admissionId: admReg.id,
      encounterVersion: admAfterVitals.versionId,
      expectedRevision: 0,
      fields: {
        anginaEpisodes24h: 2,
        aspirinUsedLast7Days: true,
        cardiacArrestOnAdmission: false,
        familyHistoryPrematureCad: true,
        killipClass: 'I',
        knownCoronaryStenosisGe50: false,
        priorBleedingHistory: 'negative',
        smokingStatus: 'current',
        stSegmentDeviation: true,
      },
    }, inpatientFullClinicalResponseSchema)
    const admAfterRisk = (await grantOp('inpatient-doctor', 'inpatient.admission.read', { admissionId: admReg.id }, inpatientDetailSchema)).admission
    await grantOp('inpatient-doctor', 'inpatient.diagnosis.confirm', {
      admissionId: admReg.id,
      encounterVersion: admAfterRisk.versionId,
      entries: [
        { admissionCondition: '1', catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I21.401', role: 'primary' },
        { admissionCondition: '1', catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I25.103', role: 'secondary' },
        { admissionCondition: '1', catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', role: 'secondary' },
      ],
      expectedRevision: 0,
    }, inpatientFullClinicalResponseSchema)

    await runInpatientLabByGrant(admReg.id, '高敏心肌肌钙蛋白I')
    await runInpatientLabByGrant(admReg.id, '肌酐')
    await runInpatientLabByGrant(admReg.id, '血常规')

    // Inpatient TTE functional examination + DSH `inpatient.report.acknowledge.propose`
    const admBeforeTte = (await grantOp('inpatient-doctor', 'inpatient.admission.read', { admissionId: admReg.id }, inpatientDetailSchema)).admission
    const tteIssued = (await grantOp('inpatient-doctor', 'inpatient.investigation.issue', {
      admissionId: admReg.id,
      catalogVersion: 1,
      encounterVersion: admBeforeTte.versionId,
      selection: { indication: '住院超声心动图评估左室收缩功能', kind: 'examination', serviceId: 'examination-tte' },
    }, z.object({ data: inpatientInvestigationsSchema }).passthrough())).data.examinationRequests[0]!
    await grantOp('ward-nurse', 'inpatient.investigation.send', {
      admissionId: admReg.id,
      expectedRequestVersion: tteIssued.version,
      requestId: tteIssued.id,
      serviceRequestVersion: tteIssued.serviceRequestVersion,
      taskVersion: tteIssued.taskVersion,
    })
    await dispatchAll()
    const tteReported = (await grantOp('inpatient-doctor', 'inpatient.investigation.read', { admissionId: admReg.id }, inpatientInvestigationsSchema)).examinationRequests[0]!
    expect(tteReported.report?.results.find(r => r.code === 'lvef')?.value).toBe(52)

    const admForInvCtx = (await grantOp('inpatient-doctor', 'inpatient.admission.read', { admissionId: admReg.id }, inpatientDetailSchema)).admission
    const invCtx = await surfaceContext('inpatient-doctor', {
      activeSection: 'investigations',
      selection: { id: admReg.id, kind: 'inpatient-admission', version: admForInvCtx.versionId },
      ui: { status: 'ready' },
      version: 1,
      viewId: 'inpatient',
      viewRevision: 'case1-ip-inv',
    })
    const ackInput = {
      diagnosticReportId: tteReported.report!.diagnosticReportId,
      diagnosticReportVersion: tteReported.report!.diagnosticReportVersion,
      expectedRequestVersion: tteReported.version,
      requestId: tteReported.id,
      serviceRequestVersion: tteReported.serviceRequestVersion,
      taskVersion: tteReported.taskVersion,
    }
    const ackAuthRes = await runtime.app.request('/api/agent/v1/tool-calls', {
      body: JSON.stringify({
        contextToken: invCtx.token,
        executionProof: makeExecutionProof(invCtx, 'inpatient.report.acknowledge.propose'),
        input: ackInput,
        operationId: 'inpatient.report.acknowledge.propose',
      }),
      headers: { 'content-type': 'application/json', cookie: cookies.get('inpatient-doctor')!, origin: 'http://localhost' },
      method: 'POST',
    })
    expect(ackAuthRes.status, await ackAuthRes.clone().text()).toBe(201)
    const ackAuthorized = agentToolAuthorizationResponseSchema.parse(await ackAuthRes.json())
    expect((await runtime.app.request('/api/agent/v1/tool-calls/review', {
      body: JSON.stringify({ decision: 'approved', receiptToken: ackAuthorized.receiptToken }),
      headers: { 'content-type': 'application/json', cookie: cookies.get('inpatient-doctor')!, origin: 'http://localhost' },
      method: 'POST',
    })).status).toBe(200)
    const ackCmd = await runtime.app.request(`/api/his/v1/inpatient/admissions/${admReg.id}/investigations/acknowledge`, {
      body: JSON.stringify({ input: ackInput }),
      headers: {
        'content-type': 'application/json',
        cookie: cookies.get('inpatient-doctor')!,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(ackCmd.status).toBe(200)
    const ackCmdJson = await ackCmd.json() as { auditId: string; requestId: string }
    expect((await runtime.app.request('/api/agent/v1/tool-calls/result', {
      body: JSON.stringify({ ok: true, receiptToken: ackAuthorized.receiptToken, result: { approved: true, data: ackCmdJson } }),
      headers: { 'content-type': 'application/json', cookie: cookies.get('inpatient-doctor')!, origin: 'http://localhost' },
      method: 'POST',
    })).status).toBe(200)

    // GRACE & TIMI UA/NSTEMI scores + `acute-chest-pain-acs` guideline topic via DSH inpatient read tools
    const admForOrdersCtx = (await grantOp('inpatient-doctor', 'inpatient.admission.read', { admissionId: admReg.id }, inpatientDetailSchema)).admission
    const ordersCtx = await surfaceContext('inpatient-doctor', {
      activeSection: 'orders',
      selection: { id: admReg.id, kind: 'inpatient-admission', version: admForOrdersCtx.versionId },
      ui: { status: 'ready' },
      version: 1,
      viewId: 'inpatient',
      viewRevision: 'case1-ip-orders',
    })
    const ipScores = await surfaceInpatientQuery('inpatient-doctor', ordersCtx, 'inpatient.clinical-scores.read', admReg.id, '/clinical-scores', {}, clinicalScoreBundleSchema)
    expect(ipScores.scores.find(s => s.id === 'grace-acs')?.status).toBe('complete')
    expect(ipScores.scores.find(s => s.id === 'timi-ua-nstemi')?.status).toBe('complete')
    const ipTopics = await surfaceInpatientQuery('inpatient-doctor', ordersCtx, 'inpatient.guideline-topics.read', admReg.id, '/guideline-topics', { topicId: 'acute-chest-pain-acs' }, guidelineTopicBundleSchema)
    expect(ipTopics.items[0]!.topic.id).toBe('acute-chest-pain-acs')

    // Multivessel angiography (`inpatient.angiography-reports.read` via BOTH Agent Grant & DSH Surface tool) + PCI
    const angio = await executeAngiographyByGrant(admReg.id)
    expect(angio.vessels).toContainEqual(expect.objectContaining({ segment: 'LAD 近段', stenosisPercent: 90, timiFlow: 2, vessel: 'LAD' }))
    const admForSurgCtx = (await grantOp('inpatient-doctor', 'inpatient.admission.read', { admissionId: admReg.id }, inpatientDetailSchema)).admission
    const surgCtx = await surfaceContext('inpatient-doctor', {
      activeSection: 'surgery',
      selection: { id: admReg.id, kind: 'inpatient-admission', version: admForSurgCtx.versionId },
      ui: { status: 'ready' },
      version: 1,
      viewId: 'inpatient',
      viewRevision: 'case1-ip-surgery',
    })
    const dshAngio = await surfaceInpatientQuery('inpatient-doctor', surgCtx, 'inpatient.angiography-reports.read', admReg.id, '/angiography-reports', {}, inpatientAngiographyReportsSchema)
    expect(dshAngio.reports[0]!.id).toBe(angio.id)

    await executeSingleStentPciByGrant(admReg.id)
    const ipPostPciScores = await grantOp('inpatient-doctor', 'inpatient.clinical-scores.read', { admissionId: admReg.id }, clinicalScoreBundleSchema)
    expect(ipPostPciScores.scores.find(s => s.id === 'precise-dapt')?.status).toBe('complete')
    await issueSecondaryPreventionLongOrders(admReg.id)
    await dischargeDepartAndOptionallyClear(admReg.id, true)

    // Post-discharge outpatient revisit: read `local-completed` inpatient summary + follow-up LDL-C / `ascvd-ldl-target` / `PRECISE-DAPT`
    const revisit = await startOutpatientFollowUpByGrant(op.patientId, '陈志远', 'PCI 术后门诊随访复查血脂与双抗评估')
    const localHistory = await grantOp('doctor', 'doctor.case.history.search', {
      caseId: revisit.caseId,
      page: 1,
      pageSize: 20,
      source: 'local-completed',
    }, doctorCaseHistorySchema)
    const ipEntry = localHistory.items.find(item => item.entryId === `inpatient:${admReg.id}`)!
    expect(ipEntry).toBeDefined()
    const ipSummary = await grantOp('doctor', 'doctor.case.history.read', {
      caseId: revisit.caseId,
      entryId: ipEntry.entryId,
      source: 'local-completed',
    }, doctorCompletedHistoryDetailSchema)
    expect(JSON.stringify(ipSummary)).toContain('36.0700')

    const ldlFollowUp = await runOutpatientLabByGrant(revisit.caseId, revisit.encounterId, '2000404A')
    expect(ldlFollowUp.report!.results.find(r => r.code === '2000404A')?.value).toBe(1.25)
    await runOutpatientLabByGrant(revisit.caseId, revisit.encounterId, '1700404A')
    await runOutpatientLabByGrant(revisit.caseId, revisit.encounterId, 'CN-LAB-CBC-5DIFF')

    const revDetail1 = await grantOp('doctor', 'doctor.case.get', { caseId: revisit.caseId }, doctorCaseDetailSchema)
    const revDiagDraft = (await grantOp('doctor', 'encounter.diagnosis.draft.set', {
      encounterId: revisit.encounterId,
      encounterVersion: revDetail1.encounter.versionId,
      entries: [{ catalogItemId: 'diagnosis-coronary-heart-disease', role: 'primary' }],
      expectedDraftVersion: 0,
    }, diagnosisDraftResponseSchema)).data
    await grantOp('doctor', 'encounter.diagnosis.confirm', {
      encounterId: revisit.encounterId,
      encounterVersion: revDetail1.encounter.versionId,
      expectedDraftVersion: revDiagDraft.draftVersion,
    }, confirmDiagnosisResponseSchema)
    const revDetail2 = await grantOp('doctor', 'doctor.case.get', { caseId: revisit.caseId }, doctorCaseDetailSchema)
    await grantOp('doctor', 'encounter.risk-assessment.record', {
      encounterId: revisit.encounterId,
      encounterVersion: revDetail2.encounter.versionId,
      expectedRevision: 0,
      fields: { priorBleedingHistory: 'negative' },
    })
    const revDetailBeforeRx = await grantOp('doctor', 'doctor.case.get', { caseId: revisit.caseId }, doctorCaseDetailSchema)
    const revRxDraft = (await grantOp('doctor', 'encounter.prescription.draft.set', {
      encounterId: revisit.encounterId,
      encounterVersion: revDetailBeforeRx.encounter.versionId,
      expectedDraftVersion: 0,
      items: [
        { catalogItemId: 'medication-pci-aspirin', courseDays: 30, doseText: '100 mg', frequencyCode: 'QD', quantity: 30, routeCode: 'PO' },
        { catalogItemId: 'medication-pci-clopidogrel', courseDays: 30, doseText: '75 mg', frequencyCode: 'QD', quantity: 30, routeCode: 'PO' },
        { catalogItemId: 'medication-pci-atorvastatin', courseDays: 30, doseText: '20 mg', frequencyCode: 'QD', quantity: 60, routeCode: 'PO' },
      ],
    }, prescriptionDraftResponseSchema)).data
    const revIssuedRx = (await grantOp('doctor', 'encounter.prescription.issue', {
      encounterId: revisit.encounterId,
      encounterVersion: revDetailBeforeRx.encounter.versionId,
      expectedDraftVersion: revRxDraft.draftVersion,
    }, issuePrescriptionResponseSchema)).data
    const revDetail3 = await grantOp('doctor', 'doctor.case.get', { caseId: revisit.caseId }, doctorCaseDetailSchema)
    const revRxCtx = await surfaceContext('doctor', {
      activeSection: 'prescription',
      selection: { id: revisit.caseId, kind: 'case', version: revDetail3.encounter.versionId },
      ui: { status: 'ready' },
      version: 1,
      viewId: 'consultation',
      viewRevision: 'case1-revisit-rx',
    })
    const revScoresBeforeDispense = await surfaceDoctorQuery(revRxCtx, 'outpatient.clinical-scores.read', {}, clinicalScoreBundleSchema)
    expect(revScoresBeforeDispense.scores.find(s => s.id === 'ascvd-ldl-target')?.status).toBe('complete')

    // Complete revisit, pay & dispense DAPT prescription -> outpatient PRECISE-DAPT also becomes complete
    const revDocDraft = (await grantOp('doctor', 'encounter.clinical-document.draft.set', {
      document: {
        assessment: 'NSTEMI PCI 术后随访，LDL-C 1.25 mmol/L 达标，继续双联抗血小板及强化他汀治疗。',
        chiefComplaint: 'PCI 术后门诊随访复查血脂与双抗评估。',
        disposition: '续方阿司匹林、氯吡格雷与阿托伐他汀。',
        followUp: '1 个月后复诊评估出血风险与肝肾功能。',
        historyOfPresentIllness: '本院 NSTEMI 单支架 PCI 术后规律服药，无胸痛复发及出血表现。',
        physicalExamination: '神清，穿刺处愈合良好。',
      },
      encounterId: revisit.encounterId,
      encounterVersion: revDetail3.encounter.versionId,
      expectedDraftVersion: 0,
    }, clinicalDocumentDraftResponseSchema)).data
    const revD4 = await grantOp('doctor', 'doctor.case.get', { caseId: revisit.caseId }, doctorCaseDetailSchema)
    const revSignPrev = (await grantOp('doctor', 'encounter.clinical-document.sign.preview', {
      encounterId: revisit.encounterId,
      encounterVersion: revD4.encounter.versionId,
      expectedDraftVersion: revDocDraft.draftVersion,
    }, clinicalDocumentSignPreviewResponseSchema)).data
    const revD5 = await grantOp('doctor', 'doctor.case.get', { caseId: revisit.caseId }, doctorCaseDetailSchema)
    await grantOp('doctor', 'encounter.clinical-document.sign', {
      commitToken: revSignPrev.commitToken,
      encounterId: revisit.encounterId,
      encounterVersion: revD5.encounter.versionId,
      previewId: revSignPrev.previewId,
    }, clinicalDocumentSignResponseSchema)
    const revD6 = await grantOp('doctor', 'doctor.case.get', { caseId: revisit.caseId }, doctorCaseDetailSchema)
    await grantOp('doctor', 'encounter.complete', {
      encounterId: revisit.encounterId,
      encounterVersion: revD6.encounter.versionId,
    }, encounterCompletionResponseSchema)
    const revBill = await grantOp('cashier', 'billing.case.get', { caseId: revisit.caseId }, billingCaseSchema)
    await payOutpatientByGrant(revisit.caseId, 'medication', revBill.charges.find(c => c.category === 'medication')!.chargeItemId)
    const revPharm = (await grantOp('pharmacist', 'pharmacy.queue.list', { page: 1, pageSize: 20, status: 'pending' }, pharmacyQueueSchema))
      .items.find(item => item.prescriptionId === revIssuedRx.prescription.id)!
    const revReviewed = (await grantOp('pharmacist', 'prescription.review', {
      encounterId: revPharm.encounterId,
      encounterVersion: revPharm.encounterVersion,
      medications: revPharm.medications.map(m => ({ medicationRequestId: m.medicationRequestId, medicationRequestVersion: m.medicationRequestVersion })),
      note: 'PCI 术后双抗续方审核通过',
      prescriptionId: revPharm.prescriptionId,
      prescriptionVersion: revPharm.prescriptionVersion,
    }, prescriptionReviewResponseSchema)).data
    const revPharm2 = (await grantOp('pharmacist', 'pharmacy.queue.list', { page: 1, pageSize: 20, status: 'pending' }, pharmacyQueueSchema))
      .items.find(item => item.prescriptionId === revIssuedRx.prescription.id)!
    await grantOp('pharmacist', 'prescription.dispense', {
      encounterId: revPharm2.encounterId,
      encounterVersion: revPharm2.encounterVersion,
      lotSelections: revPharm2.medications.map(m => ({ expectedVersion: m.lots[0]!.version, lotId: m.lots[0]!.id, quantity: m.quantity })),
      medications: revPharm2.medications.map(m => ({ medicationRequestId: m.medicationRequestId, medicationRequestVersion: m.medicationRequestVersion })),
      prescriptionId: revPharm2.prescriptionId,
      prescriptionVersion: revReviewed.prescriptionVersion,
    }, dispenseResponseSchema)
    const revScoresAfterDispense = await grantOp('doctor', 'doctor.case.clinical-scores.read', { caseId: revisit.caseId }, clinicalScoreBundleSchema)
    expect(revScoresAfterDispense.scores.find(s => s.id === 'ascvd-ldl-target')?.status).toBe('complete')
    expect(revScoresAfterDispense.scores.find(s => s.id === 'precise-dapt')?.status).toBe('complete')
    expect(unexpectedModelCalls).toEqual([])
  }, 45_000)

  it('病例②（cardio-elective-lad-pci-v1）与病例③（cardio-borderline-ffr-gdmt-v1）：区分缺血性 FFR=0.72 单支架 PCI 与临界 FFR=0.86 阴性 409 拦截转保守 GDMT 出院随访', async () => {
    const case2 = preparedPack.cases.find(item => item.draftId === 'cardio-elective-lad-pci-v1')!.case!
    const stay2 = await startDirectInpatientByGrant(case2.caseId, case2.revision, case2.activeBriefRevision!, 'bed-general-1')
    await grantOp('inpatient-doctor', 'inpatient.diagnosis.confirm', {
      admissionId: stay2.admissionId,
      encounterVersion: stay2.admission.versionId,
      entries: [{ admissionCondition: '1', catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I25.103', role: 'primary' }],
      expectedRevision: 0,
    }, inpatientFullClinicalResponseSchema)
    const angio2 = await executeAngiographyByGrant(stay2.admissionId)
    expect(angio2.vessels).toContainEqual(expect.objectContaining({ ffr: 0.72, stenosisPercent: 85, vessel: 'LAD' }))
    const pci2 = await executeSingleStentPciByGrant(stay2.admissionId)
    expect(pci2.actualProcedure.coding.code).toBe('36.0700')
    await issueSecondaryPreventionLongOrders(stay2.admissionId)
    await dischargeDepartAndOptionallyClear(stay2.admissionId)
    const followUp2 = await startOutpatientFollowUpByGrant(stay2.patientId, stay2.admission.patientName, '择期单支架 PCI 术后门诊随访')
    const hist2 = await grantOp('doctor', 'doctor.case.history.search', {
      caseId: followUp2.caseId,
      page: 1,
      pageSize: 20,
      source: 'local-completed',
    }, doctorCaseHistorySchema)
    expect(hist2.items.some(item => item.entryId === `inpatient:${stay2.admissionId}`)).toBe(true)

    // Case ③: mLAD 60%, FFR = 0.86 -> PCI plan triggers 409 PCI_NON_ISCHEMIC_LESION -> switch to conservative GDMT discharge + outpatient follow-up
    const case3 = preparedPack.cases.find(item => item.draftId === 'cardio-borderline-ffr-gdmt-v1')!.case!
    const stay3 = await startDirectInpatientByGrant(case3.caseId, case3.revision, case3.activeBriefRevision!, 'bed-general-2')
    await grantOp('inpatient-doctor', 'inpatient.diagnosis.confirm', {
      admissionId: stay3.admissionId,
      encounterVersion: stay3.admission.versionId,
      entries: [{ admissionCondition: '1', catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I25.103', role: 'primary' }],
      expectedRevision: 0,
    }, inpatientFullClinicalResponseSchema)
    const angio3 = await executeAngiographyByGrant(stay3.admissionId)
    expect(angio3.vessels).toContainEqual(expect.objectContaining({ ffr: 0.86, stenosisPercent: 60, vessel: 'LAD' }))

    const adm3BeforePci = (await grantOp('inpatient-doctor', 'inpatient.admission.read', { admissionId: stay3.admissionId }, inpatientDetailSchema)).admission
    const surg3Ctx = await surfaceContext('inpatient-doctor', {
      activeSection: 'surgery',
      selection: { id: stay3.admissionId, kind: 'inpatient-admission', version: adm3BeforePci.versionId },
      ui: { status: 'ready' },
      version: 1,
      viewId: 'inpatient',
      viewRevision: 'case3-ip-surgery',
    })
    const dshSurgeryList = await surfaceInpatientQuery('inpatient-doctor', surg3Ctx, 'inpatient.surgery.read', stay3.admissionId, '/surgeries', {}, inpatientSurgerySchema)
    expect(dshSurgeryList.requests[0]?.consentConfirmation?.document?.templateId).toBe('coronary-angiography')
    const dshPciPreflight = await surfaceInpatientQuery('inpatient-doctor', surg3Ctx, 'inpatient.clinical-quality.read', stay3.admissionId, '/clinical-quality', { gate: 'inpatient-pci-plan' }, clinicalQualityCheckSchema)
    expect(dshPciPreflight.alerts).toContainEqual(expect.objectContaining({ code: 'PCI_NON_ISCHEMIC_LESION', tier: 'alert' }))

    const surgCatalog = await grantOp('inpatient-doctor', 'inpatient.surgery.catalog', {}, inpatientSurgeryCatalogSchema)
    const pciProc = surgCatalog.procedures.find(item => item.coding.code === '36.0700')!
    const blockedPci = await invokeOperationRaw(grants.get('inpatient-doctor')!, 'inpatient.surgery.request', {
      admissionId: stay3.admissionId,
      anesthesiaMethod: 'local-infiltration',
      catalogVersion: pciProc.version,
      encounterVersion: adm3BeforePci.versionId,
      locationId: 'location-catheterization-lab',
      plannedFor: '2026-08-24T15:00:00+08:00',
      procedureId: pciProc.id,
      reason: '拟行前降支支架置入术',
      surgeonPractitionerId: 'practitioner-inpatient-doctor',
      surgeryType: 'elective',
    })
    expect(blockedPci.res.status).toBe(409)
    expect(apiErrorSchema.parse(JSON.parse(blockedPci.text)).error).toMatchObject({
      clinicalQuality: { alerts: [expect.objectContaining({ code: 'PCI_NON_ISCHEMIC_LESION' })] },
      code: 'CLINICAL_QUALITY_ALERT',
    })
    expect((await grantOp('inpatient-doctor', 'inpatient.surgery.read', { admissionId: stay3.admissionId }, inpatientSurgerySchema)).requests.filter(r => r.plannedProcedure.coding.code === '36.0700')).toHaveLength(0)

    // Switch to conservative GDMT orders -> verify discharge quality check via DSH tool -> discharge + outpatient follow-up
    await issueSecondaryPreventionLongOrders(stay3.admissionId, false)
    const adm3BeforeDischarge = (await grantOp('inpatient-doctor', 'inpatient.admission.read', { admissionId: stay3.admissionId }, inpatientDetailSchema)).admission
    const dis3Ctx = await surfaceContext('inpatient-doctor', {
      activeSection: 'discharge',
      selection: { id: stay3.admissionId, kind: 'inpatient-admission', version: adm3BeforeDischarge.versionId },
      ui: { status: 'ready' },
      version: 1,
      viewId: 'inpatient',
      viewRevision: 'case3-ip-discharge',
    })
    const dis3Quality = await surfaceInpatientQuery('inpatient-doctor', dis3Ctx, 'inpatient.clinical-quality.read', stay3.admissionId, '/clinical-quality', { gate: 'inpatient-discharge' }, clinicalQualityCheckSchema)
    expect(dis3Quality).toMatchObject({ alerts: [], redLines: [], status: 'pass' })

    await dischargeDepartAndOptionallyClear(stay3.admissionId)
    const followUp3 = await startOutpatientFollowUpByGrant(stay3.patientId, stay3.admission.patientName, '临界冠脉病变保守药物治疗随访')
    const hist3 = await grantOp('doctor', 'doctor.case.history.search', {
      caseId: followUp3.caseId,
      page: 1,
      pageSize: 20,
      source: 'local-completed',
    }, doctorCaseHistorySchema)
    expect(hist3.items.some(item => item.entryId === `inpatient:${stay3.admissionId}`)).toBe(true)
    expect(unexpectedModelCalls).toEqual([])
  }, 45_000)

  it('病例④（cardio-cad-ckd3b-hydration-pci-v1）：贯通 CKD 3b（Scr 175 / eGFR 36.1）、cin-perioperative-hydration 水化套餐、PCI 及术后复测 Scr 168（eGFR 37.9）出院', async () => {
    const case4 = preparedPack.cases.find(item => item.draftId === 'cardio-cad-ckd3b-hydration-pci-v1')!.case!
    const stay4 = await startDirectInpatientByGrant(case4.caseId, case4.revision, case4.activeBriefRevision!, 'bed-general-3')

    await grantOp('ward-nurse', 'inpatient.vital-signs.record', {
      admissionId: stay4.admissionId,
      bloodPressure: { diastolicMmHg: 76, systolicMmHg: 128 },
      encounterVersion: stay4.admission.versionId,
      expectedRevision: 0,
      oxygenSaturationPct: 98,
      pulseBpm: 72,
      respirationBpm: 18,
      temperatureC: 36.5,
      weightKg: 70,
    }, inpatientFullClinicalResponseSchema)
    const admAfterVitals = (await grantOp('inpatient-doctor', 'inpatient.admission.read', { admissionId: stay4.admissionId }, inpatientDetailSchema)).admission
    await grantOp('inpatient-doctor', 'inpatient.diagnosis.confirm', {
      admissionId: stay4.admissionId,
      encounterVersion: admAfterVitals.versionId,
      entries: [{ admissionCondition: '1', catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I25.103', role: 'primary' }],
      expectedRevision: 0,
    }, inpatientFullClinicalResponseSchema)

    const scrBase = await runInpatientLabByGrant(stay4.admissionId, '肌酐')
    expect(scrBase.report!.results.find(r => r.code === '1700404A')?.value).toBe(175)
    const scoresBase = await grantOp('inpatient-doctor', 'inpatient.clinical-scores.read', { admissionId: stay4.admissionId }, clinicalScoreBundleSchema)
    const egfrBase = scoresBase.scores.find(s => s.id === 'ckd-epi-2021-egfr')!
    expect(egfrBase).toMatchObject({ status: 'complete', tierCode: 'G3b' })
    if (egfrBase.status === 'complete') expect(egfrBase.value).toBeCloseTo(36.1, 1)

    // Read `cin-perioperative-hydration` via DSH `inpatient.order-set-drafts.read` and issue 0.9% NaCl hydration order
    const admBeforeHydration = (await grantOp('inpatient-doctor', 'inpatient.admission.read', { admissionId: stay4.admissionId }, inpatientDetailSchema)).admission
    const orders4Ctx = await surfaceContext('inpatient-doctor', {
      activeSection: 'orders',
      selection: { id: stay4.admissionId, kind: 'inpatient-admission', version: admBeforeHydration.versionId },
      ui: { status: 'ready' },
      version: 1,
      viewId: 'inpatient',
      viewRevision: 'case4-ip-orders',
    })
    const hydrationBundle = await surfaceInpatientQuery(
      'inpatient-doctor',
      orders4Ctx,
      'inpatient.order-set-drafts.read',
      stay4.admissionId,
      '/order-set-drafts',
      { templateId: 'cin-perioperative-hydration' },
      orderSetDraftBundleSchema,
    )
    const salineItem = hydrationBundle.drafts[0]!.items.find(item => item.key === 'isotonic-saline-hydration')!
    expect(salineItem.disposition).toBe('ready')
    const salineCandidate = salineItem.candidate
    expect(salineCandidate?.kind).toBe('medication')
    if (salineCandidate?.kind === 'medication' && salineCandidate.inpatient !== null) {
      expect(salineCandidate.routeCode).toBe('IVGTT')
      const issuedSaline = (await grantOp('inpatient-doctor', 'inpatient.order.issue', {
        admissionId: stay4.admissionId,
        duration: salineCandidate.inpatient.duration,
        encounterVersion: admBeforeHydration.versionId,
        selection: {
          catalogItemId: salineCandidate.catalogItemId,
          catalogVersion: salineCandidate.catalogVersion,
          doseQuantity: salineCandidate.inpatient.doseQuantity,
          doseText: salineCandidate.doseText,
          frequencyCode: salineCandidate.frequencyCode,
          ...(salineCandidate.instructionsZh ? { instructions: salineCandidate.instructionsZh } : {}),
          kind: 'medication',
          routeCode: salineCandidate.routeCode,
        },
      }, inpatientFullClinicalResponseSchema)).data
      expect(issuedSaline.orders.some(o => o.catalogItemId === salineCandidate.catalogItemId)).toBe(true)
    }

    const angio4 = await executeAngiographyByGrant(stay4.admissionId)
    expect(angio4.vessels).toContainEqual(expect.objectContaining({ ffr: 0.74, stenosisPercent: 85, vessel: 'LAD' }))
    await executeSingleStentPciByGrant(stay4.admissionId)

    const scrRepeat = await runInpatientLabByGrant(stay4.admissionId, '肌酐')
    expect(scrRepeat.report!.results.find(r => r.code === '1700404A')?.value).toBe(168)
    const scoresAfter = await grantOp('inpatient-doctor', 'inpatient.clinical-scores.read', { admissionId: stay4.admissionId }, clinicalScoreBundleSchema)
    const egfrAfter = scoresAfter.scores.find(s => s.id === 'ckd-epi-2021-egfr')!
    expect(egfrAfter).toMatchObject({ status: 'complete', tierCode: 'G3b' })
    if (egfrAfter.status === 'complete') expect(egfrAfter.value).toBeCloseTo(37.9, 1)

    await issueSecondaryPreventionLongOrders(stay4.admissionId)
    await dischargeDepartAndOptionallyClear(stay4.admissionId)
    expect(unexpectedModelCalls).toEqual([])
  }, 45_000)

  it('病例⑤（renal-t2dm-htn-ckd4-control-v1）：贯通 CKD 4 期（eGFR 26.0）、指南专题、二甲双胍与达格列净红线拦截（含越权参数仍 409）及甲/乙/丙混合处方医保结算发药', async () => {
    const case5 = preparedPack.cases.find(item => item.draftId === 'renal-t2dm-htn-ckd4-control-v1')!.case!
    const op = await startOutpatientByGrant(case5.caseId, case5.revision, case5.activeBriefRevision!, '近期血糖偏高 1 个月复诊调药')

    expect((await runOutpatientLabByGrant(op.caseId, op.encounterId, '1700404A', true)).report!.results.find(r => r.code === '1700404A')?.value).toBe(184.6)
    expect((await runOutpatientLabByGrant(op.caseId, op.encounterId, '1100301A', true)).report!.results.find(r => r.code === '1100301A')?.value).toBe(8.2)
    expect((await runOutpatientLabByGrant(op.caseId, op.encounterId, '1400605A', true)).report!.results.find(r => r.code === '1400605A')?.value).toBe(4.8)
    expect((await runOutpatientLabByGrant(op.caseId, op.encounterId, '2000404A', true)).report!.results.find(r => r.code === '2000404A')?.value).toBe(3.1)

    const d1 = await grantOp('doctor', 'doctor.case.get', { caseId: op.caseId }, doctorCaseDetailSchema)
    const diagDraft = (await grantOp('doctor', 'encounter.diagnosis.draft.set', {
      encounterId: op.encounterId,
      encounterVersion: d1.encounter.versionId,
      entries: [
        { catalogItemId: 'diagnosis-type-2-diabetes-hyperglycemia', role: 'primary' },
        { catalogItemId: 'diagnosis-hypertension', role: 'secondary' },
        { catalogItemId: 'diagnosis-dyslipidemia', role: 'secondary' },
      ],
      expectedDraftVersion: 0,
    }, diagnosisDraftResponseSchema)).data
    await grantOp('doctor', 'encounter.diagnosis.confirm', {
      encounterId: op.encounterId,
      encounterVersion: d1.encounter.versionId,
      expectedDraftVersion: diagDraft.draftVersion,
    }, confirmDiagnosisResponseSchema)

    // Read eGFR = 26.0 (G4) & `t2dm-renal-medication` guideline topic via DSH `doctor-queries`
    const d2 = await grantOp('doctor', 'doctor.case.get', { caseId: op.caseId }, doctorCaseDetailSchema)
    const rxCtx = await surfaceContext('doctor', {
      activeSection: 'prescription',
      selection: { id: op.caseId, kind: 'case', version: d2.encounter.versionId },
      ui: { status: 'ready' },
      version: 1,
      viewId: 'consultation',
      viewRevision: 'case5-rx',
    })
    const scores5 = await surfaceDoctorQuery(rxCtx, 'outpatient.clinical-scores.read', {}, clinicalScoreBundleSchema)
    const egfr5 = scores5.scores.find(s => s.id === 'ckd-epi-2021-egfr')!
    expect(egfr5).toMatchObject({ status: 'complete', tierCode: 'G4' })
    if (egfr5.status === 'complete') expect(egfr5.value).toBeCloseTo(26.0, 1)
    const topics5 = await surfaceDoctorQuery(rxCtx, 'outpatient.guideline-topics.read', { topicId: 't2dm-renal-medication' }, guidelineTopicBundleSchema)
    expect(topics5.items[0]!.topic.id).toBe('t2dm-renal-medication')

    // Hard Tier-1 red-line block on metformin & dapagliflozin EVEN when `clinicalOverride` is passed!
    let rxDraftVersion = 0
    for (const contra of [
      { courseDays: 30, doseText: '0.5 g', frequencyCode: 'BID', id: 'medication-metformin', quantity: 60 },
      { courseDays: 1, doseText: '10 mg', frequencyCode: 'QD', id: 'medication-dapagliflozin', quantity: 1 },
    ] as const) {
      const cur = await grantOp('doctor', 'doctor.case.get', { caseId: op.caseId }, doctorCaseDetailSchema)
      const draft = (await grantOp('doctor', 'encounter.prescription.draft.set', {
        encounterId: op.encounterId,
        encounterVersion: cur.encounter.versionId,
        expectedDraftVersion: rxDraftVersion,
        items: [{
          catalogItemId: contra.id,
          courseDays: contra.courseDays,
          doseText: contra.doseText,
          frequencyCode: contra.frequencyCode,
          quantity: contra.quantity,
          routeCode: 'PO',
        }],
      }, prescriptionDraftResponseSchema)).data
      rxDraftVersion = draft.draftVersion

      const blocked = await invokeOperationRaw(grants.get('doctor')!, 'encounter.prescription.issue', {
        clinicalOverride: {
          acknowledgedAlerts: ['RENAL_CREATININE_MISSING'],
          note: '尝试对肾功能禁忌红线提交临床越权应被硬拦截',
          reasonCode: 'clinical-judgement',
        },
        encounterId: op.encounterId,
        encounterVersion: cur.encounter.versionId,
        expectedDraftVersion: draft.draftVersion,
      })
      expect(blocked.res.status).toBe(409)
      expect(apiErrorSchema.parse(JSON.parse(blocked.text)).error).toMatchObject({
        clinicalQuality: {
          redLines: [expect.objectContaining({ catalogItemId: contra.id, code: 'RENAL_CONTRAINDICATED_MEDICATION' })],
          status: 'blocked',
        },
        code: 'CLINICAL_QUALITY_RED_LINE',
      })
    }

    // Issue mixed Class A (`medication-amlodipine` 0%) + Class B (`medication-valsartan` 10%) + Class C (`medication-ezetimibe` 100% self-pay) prescription
    const dSafe = await grantOp('doctor', 'doctor.case.get', { caseId: op.caseId }, doctorCaseDetailSchema)
    const mixedDraft = (await grantOp('doctor', 'encounter.prescription.draft.set', {
      encounterId: op.encounterId,
      encounterVersion: dSafe.encounter.versionId,
      expectedDraftVersion: rxDraftVersion,
      items: [
        { catalogItemId: 'medication-amlodipine', courseDays: 10, doseText: '5 mg', frequencyCode: 'QD', quantity: 10, routeCode: 'PO' },
        { catalogItemId: 'medication-valsartan', courseDays: 1, doseText: '80 mg', frequencyCode: 'QD', quantity: 1, routeCode: 'PO' },
        { catalogItemId: 'medication-ezetimibe', courseDays: 1, doseText: '10 mg', frequencyCode: 'QD', quantity: 1, routeCode: 'PO' },
      ],
    }, prescriptionDraftResponseSchema)).data
    const issuedRx = (await grantOp('doctor', 'encounter.prescription.issue', {
      encounterId: op.encounterId,
      encounterVersion: dSafe.encounter.versionId,
      expectedDraftVersion: mixedDraft.draftVersion,
    }, issuePrescriptionResponseSchema)).data

    const dDoc = await grantOp('doctor', 'doctor.case.get', { caseId: op.caseId }, doctorCaseDetailSchema)
    const docDraft = (await grantOp('doctor', 'encounter.clinical-document.draft.set', {
      document: {
        assessment: '2型糖尿病伴高血糖、高血压、血脂异常、慢性肾脏病4期（eGFR 26.0），严禁双胍与达格列净。',
        chiefComplaint: '近期血糖偏高 1 个月复诊调药。',
        disposition: '开具氨氯地平、缬沙坦与依折麦布控制血压血脂，肾内内分泌联合制定降糖方案。',
        followUp: '1-2 周复查肾功能、血钾与血糖。',
        historyOfPresentIllness: '慢性肾脏病4期合并血糖血脂升高。',
        menstrualHistory: '已绝经。',
        obstetricHistory: '孕2产2。',
        physicalExamination: '神清，心肺无殊。',
      },
      encounterId: op.encounterId,
      encounterVersion: dDoc.encounter.versionId,
      expectedDraftVersion: 0,
    }, clinicalDocumentDraftResponseSchema)).data
    const dPrev = await grantOp('doctor', 'doctor.case.get', { caseId: op.caseId }, doctorCaseDetailSchema)
    const signPrev = (await grantOp('doctor', 'encounter.clinical-document.sign.preview', {
      encounterId: op.encounterId,
      encounterVersion: dPrev.encounter.versionId,
      expectedDraftVersion: docDraft.draftVersion,
    }, clinicalDocumentSignPreviewResponseSchema)).data
    const dSign = await grantOp('doctor', 'doctor.case.get', { caseId: op.caseId }, doctorCaseDetailSchema)
    await grantOp('doctor', 'encounter.clinical-document.sign', {
      commitToken: signPrev.commitToken,
      encounterId: op.encounterId,
      encounterVersion: dSign.encounter.versionId,
      previewId: signPrev.previewId,
    }, clinicalDocumentSignResponseSchema)
    const dComp = await grantOp('doctor', 'doctor.case.get', { caseId: op.caseId }, doctorCaseDetailSchema)
    await grantOp('doctor', 'encounter.complete', {
      encounterId: op.encounterId,
      encounterVersion: dComp.encounter.versionId,
    }, encounterCompletionResponseSchema)

    // Item-level mixed-prescription Insurance Settlement (`outsideFen`, `priorSelfPayFen`, `fundFen`, `accountFen`) + self-pay + pharmacy dispense
    const billBefore = await grantOp('cashier', 'billing.case.get', { caseId: op.caseId }, billingCaseSchema)
    const rxCharge = billBefore.charges.find(c => c.category === 'medication')!
    const insPrev = (await grantOp('cashier', 'insurance.preview', {
      id: op.caseId,
      kind: 'outpatient',
      planCode: 'employee-v1',
    }, insurancePreviewResponseSchema)).data
    const rxAlloc = insPrev.settlement.allocations.find(a => a.reference === `ChargeItem/${rxCharge.chargeItemId}`)!
    expect(rxAlloc.outsideFen).toBe(100) // ezetimibe 100% outside
    expect(rxAlloc.priorSelfPayFen).toBe(8) // valsartan 80 * 10% = 8
    expect(rxAlloc.fundFen).toBeGreaterThan(0)
    expect(rxAlloc.accountFen).toBeGreaterThanOrEqual(0)
    expect(rxAlloc.items).toEqual([
      expect.objectContaining({ outsideFen: 0, priorSelfPayFen: 0 }),
      expect.objectContaining({ outsideFen: 0, priorSelfPayFen: 8 }),
      expect.objectContaining({ outsideFen: 100, priorSelfPayFen: 0 }),
    ])

    await grantOp('cashier', 'insurance.confirm', {
      commitToken: insPrev.commitToken,
      id: op.caseId,
      kind: 'outpatient',
      previewId: insPrev.previewId,
    }, insuranceResponseSchema)
    await payOutpatientByGrant(op.caseId, 'medication', rxCharge.chargeItemId)

    const pharmQueue = await grantOp('pharmacist', 'pharmacy.queue.list', { page: 1, pageSize: 20, status: 'pending' }, pharmacyQueueSchema)
    const pharmItem = pharmQueue.items.find(item => item.prescriptionId === issuedRx.prescription.id)!
    expect(pharmItem).toBeDefined()
    const medsForReview = pharmItem.medications.map(item => ({
      medicationRequestId: item.medicationRequestId,
      medicationRequestVersion: item.medicationRequestVersion,
    }))
    const reviewed = (await grantOp('pharmacist', 'prescription.review', {
      encounterId: pharmItem.encounterId,
      encounterVersion: pharmItem.encounterVersion,
      medications: medsForReview,
      note: '肾功能与品规剂量核对通过',
      prescriptionId: pharmItem.prescriptionId,
      prescriptionVersion: pharmItem.prescriptionVersion,
    }, prescriptionReviewResponseSchema)).data
    const pharmAfterReview = (await grantOp('pharmacist', 'pharmacy.queue.list', { page: 1, pageSize: 20, status: 'pending' }, pharmacyQueueSchema))
      .items.find(item => item.prescriptionId === issuedRx.prescription.id)!
    const dispensed = (await grantOp('pharmacist', 'prescription.dispense', {
      encounterId: pharmAfterReview.encounterId,
      encounterVersion: pharmAfterReview.encounterVersion,
      lotSelections: pharmAfterReview.medications.map(item => ({
        expectedVersion: item.lots[0]!.version,
        lotId: item.lots[0]!.id,
        quantity: item.quantity,
      })),
      medications: pharmAfterReview.medications.map(item => ({
        medicationRequestId: item.medicationRequestId,
        medicationRequestVersion: item.medicationRequestVersion,
      })),
      prescriptionId: pharmAfterReview.prescriptionId,
      prescriptionVersion: reviewed.prescriptionVersion,
    }, dispenseResponseSchema)).data
    expect(dispensed.status).toBe('completed')
    expect(unexpectedModelCalls).toEqual([])
  }, 45_000)
})
