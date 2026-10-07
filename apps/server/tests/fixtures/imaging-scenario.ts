import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentPageBindingRevision, agentPageContextBindingSchema, type AgentPageContextBinding } from '@clinmesh/contracts/agent'
import {
  commandResponseSchema,
  registrationCatalogSchema,
  startVisitResponseSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { imagingPreparationBatchSchema } from '@clinmesh/contracts/imaging'
import {
  startSyntheticCaseResultSchema,
  syntheticCaseInstanceSchema,
  type PatientPersonaContent,
  type ScenarioGenerationRequest,
  type ScenarioProviderCapabilities,
  type SyntheaKeepCriteria,
} from '@clinmesh/contracts/scenario'
import { expect } from 'vitest'
import type { ScenarioGenerationProvider, SourcePatientCorpus } from '../../src/application/scenario-data/provider.ts'
import { sourceArtifactHash } from '../../src/application/scenario-data/provider.ts'
import type {
  JsonChatCompletionInput,
  JsonChatCompletionsProvider,
} from '../../src/infrastructure/ai/openai-chat-completions.ts'
import type { SqlitePerformanceObserver } from '../../src/infrastructure/sqlite/performance-observer.ts'
import { createClinMeshRuntime } from '../../src/runtime.ts'

export type Runtime = Awaited<ReturnType<typeof createClinMeshRuntime>>

export const snomed = 'http://snomed.info/sct'
export const lungCancer = { code: '254637007', display: '非小细胞肺癌' }
export const acuteBronchitis = { code: '10509002', display: '急性支气管炎' }
export const pneumonia = { code: '233604007', display: '肺炎' }
export const hypertension = { code: '59621000', display: '高血压' }
export const chestRadiographProcedure = { code: '399208008', display: '胸部 X 线平片' }
export const lungTransplant = { code: '88039007', display: '肺移植术' }

export interface SourceFact {
  code: string
  display: string
  /** 来源记录了缓解时间：既往事实在当次就诊时缓解；本次就诊的疾病与 Synthea 导出一致，在就诊两周后缓解。 */
  resolved?: boolean
  resourceType: 'Condition' | 'Procedure'
}

/** 合成 Synthea R4 病例：一次既往就诊承载既往事实，最后一次就诊是 Index Encounter。 */
export function caseBundle(input: {
  birthDate?: string
  gender: 'female' | 'male'
  history?: SourceFact[]
  index: SourceFact[]
  name: string
}) {
  const fact = (item: SourceFact, encounter: string, date: string, id: string, abatement = date) => ({
    fullUrl: `urn:uuid:${id}`,
    resource: {
      code: { coding: [{ code: item.code, display: item.display, system: snomed }] },
      encounter: { reference: `urn:uuid:${encounter}` },
      id,
      resourceType: item.resourceType,
      subject: { reference: 'urn:uuid:patient' },
      ...(item.resourceType === 'Condition'
        ? { recordedDate: date, ...(item.resolved === true ? { abatementDateTime: abatement } : {}) }
        : { performedPeriod: { end: date, start: date }, status: 'completed' }),
    },
  })
  return {
    entry: [
      {
        fullUrl: 'urn:uuid:patient',
        resource: {
          birthDate: input.birthDate ?? '1970-01-01',
          gender: input.gender,
          id: 'patient',
          name: [{ text: input.name }],
          resourceType: 'Patient',
        },
      },
      {
        fullUrl: 'urn:uuid:prior-encounter',
        resource: {
          id: 'prior-encounter',
          period: { end: '2025-01-10T09:30:00+08:00', start: '2025-01-10T09:00:00+08:00' },
          resourceType: 'Encounter',
          status: 'finished',
          subject: { reference: 'urn:uuid:patient' },
        },
      },
      ...[{ ...hypertension, resourceType: 'Condition' as const }, ...input.history ?? []]
        .map((item, index) => fact(item, 'prior-encounter', '2025-01-10T09:05:00+08:00', `prior-fact-${index}`)),
      {
        fullUrl: 'urn:uuid:index-encounter',
        resource: {
          id: 'index-encounter',
          period: { end: '2026-06-01T10:30:00+08:00', start: '2026-06-01T10:00:00+08:00' },
          reasonCode: [{ text: '门诊就诊' }],
          resourceType: 'Encounter',
          status: 'finished',
          subject: { reference: 'urn:uuid:patient' },
        },
      },
      ...input.index.map((item, index) => fact(
        item,
        'index-encounter',
        '2026-06-01T10:05:00+08:00',
        `index-fact-${index}`,
        '2026-06-15T10:05:00+08:00',
      )),
    ],
    resourceType: 'Bundle',
    type: 'collection',
  }
}

export class SequenceSyntheaProvider implements ScenarioGenerationProvider {
  readonly #bundles: unknown[]
  readonly #targetedGeneration: boolean
  /** 每次生成收到的保留条件，未定向时为 undefined。 */
  readonly keeps: Array<SyntheaKeepCriteria | undefined> = []

  constructor(bundles: unknown[], options: { targetedGeneration?: boolean } = {}) {
    this.#bundles = [...bundles]
    this.#targetedGeneration = options.targetedGeneration ?? false
  }

  async capabilities(): Promise<ScenarioProviderCapabilities> {
    return {
      available: true,
      maxPopulation: 10,
      modules: [],
      providerId: 'synthea',
      providerName: 'Synthea',
      targetedGeneration: this.#targetedGeneration,
    }
  }

  async generate(
    _request: ScenarioGenerationRequest,
    _signal?: AbortSignal,
    keep?: SyntheaKeepCriteria,
  ): Promise<SourcePatientCorpus> {
    this.keeps.push(keep)
    const bundle = this.#bundles.shift()
    if (bundle === undefined) throw new Error('No synthetic patient bundle remains')
    // 队列中的错误代表这一次 Provider 调用失败，例如保留条件未满足。
    if (bundle instanceof Error) throw bundle
    return {
      kind: 'synthea-r4',
      sources: [{ format: 'fhir-r4-bundle', hash: sourceArtifactHash(bundle), patientId: 'patient', raw: bundle }],
    }
  }
}

export const persona: PatientPersonaContent = {
  chiefComplaint: '咳嗽两周',
  knownHistorySummary: '既往有高血压病史。',
  medicationMemory: '每天吃一片降压药。',
  openingStatement: '医生您好，我咳嗽两周了。',
  persona: {
    attitude: '配合检查',
    character: '话不多',
    healthLiteracy: '初中文化',
    speechStyle: '句子短',
  },
  symptomExperience: '两周前开始咳嗽，夜里更明显。',
}

/** 临时目录中的运行时：合成 Synthea 来源、可选的患者 Persona 模型和一个待写入的合成素材清单目录。 */
const dshBridgeSecret = 'test-dsh-bridge-secret-with-at-least-32-characters'
let pageContextRevision = 0

/** 以医生“接诊”页选中某个病例的状态签发 Agent Page Context，返回绑定。 */
export async function agentPageContext(
  runtime: Runtime,
  cookie: string,
  claim: { activeSection: string; caseId: string; encounterVersion: string; viewRevision: string },
) {
  pageContextRevision += 1
  const response = await runtime.app.request('/api/agent/v1/page-contexts', {
    body: JSON.stringify({
      claim: {
        activeSection: claim.activeSection,
        selection: { id: claim.caseId, kind: 'case', version: claim.encounterVersion },
        ui: { status: 'ready' },
        version: 1,
        viewId: 'consultation',
        viewRevision: claim.viewRevision,
      },
      client: { id: 'imaging-agent-test', revision: pageContextRevision },
      dshSessionId: 'dsh-session-imaging',
    }),
    headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
    method: 'POST',
  })
  expect(response.status).toBe(201)
  return agentPageContextBindingSchema.parse(await response.json())
}

/** 以 DSH 宿主的身份授权一次 Tool 调用，返回 HTTP 响应。 */
export async function authorizeAgentTool(
  runtime: Runtime,
  cookie: string,
  binding: AgentPageContextBinding,
  call: { input: unknown; operationId: string; toolName: string },
) {
  const now = new Date()
  const encoded = Buffer.from(JSON.stringify({
    callId: `call-${call.operationId}-${now.getTime()}`,
    contextId: binding.snapshot.id,
    pageRevision: agentPageBindingRevision(binding.snapshot.claim),
    dshSessionId: binding.snapshot.dshSessionId,
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    issuedAt: now.toISOString(),
    scopeKey: binding.snapshot.scopeKey,
    toolName: call.toolName,
    version: 2,
  })).toString('base64url')
  const signature = createHmac('sha256', dshBridgeSecret).update(encoded).digest('base64url')
  return await runtime.app.request('/api/agent/v1/tool-calls', {
    body: JSON.stringify({
      contextToken: binding.token,
      executionProof: `${encoded}.${signature}`,
      input: call.input,
      operationId: call.operationId,
    }),
    headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
    method: 'POST',
  })
}

export async function createImagingRuntime(bundles: unknown[], options: {
  assets?: boolean
  catalog?: boolean
  performanceObserver?: SqlitePerformanceObserver
  persona?: boolean
  targetedGeneration?: boolean
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-imaging-'))
  const syntheaProvider = new SequenceSyntheaProvider(bundles, { targetedGeneration: options.targetedGeneration ?? false })
  const catalogDirectory = join(directory, 'imaging-catalog')
  const assetDirectory = join(directory, 'imaging-assets')
  const pathologyCatalogDirectory = join(directory, 'pathology-catalog')
  const pathologyAssetDirectory = join(directory, 'pathology-assets')
  // 患者 Persona 与患者对话共用一个记录请求的模型替身。
  const modelRequests: JsonChatCompletionInput[] = []
  const briefProvider: JsonChatCompletionsProvider = {
    completeJson: async (input) => {
      modelRequests.push(input)
      return {
        content: JSON.stringify(input.schemaName === 'patient_dialogue_reply' ? { reply: '好的，医生。' } : persona),
        model: 'fake-brief-model',
      }
    },
  }
  const runtime = await createClinMeshRuntime({
    authBaseUrl: 'http://localhost',
    authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
    databasePath: join(directory, 'clinmesh.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!',
    dshBridgeSecret,
    ...(options.assets === false ? {} : { imagingAssetDirectory: assetDirectory }),
    ...(options.catalog === false ? {} : { imagingCatalogDirectory: catalogDirectory }),
    migrationMode: 'apply',
    outboxRetryDelayMs: 0,
    pathologyAssetDirectory,
    pathologyCatalogDirectory,
    ...(options.performanceObserver === undefined ? {} : { performanceObserver: options.performanceObserver }),
    ...(options.persona === true
      ? {
          chatCompletionsProvider: briefProvider,
          consultationModel: 'fake-consultation-model',
          investigationModel: 'fake-investigation-model',
          patientPersonaModel: 'fake-brief-model',
        }
      : {}),
    syntheaProvider,
    trustedOrigins: ['http://localhost'],
  })
  return {
    assetDirectory,
    catalogDirectory,
    directory,
    modelRequests,
    pathologyAssetDirectory,
    pathologyCatalogDirectory,
    runtime,
    syntheaProvider,
  }
}

export async function signIn(runtime: Runtime, email = 'admin@demo.clinmesh.local') {
  const response = await runtime.app.request('/api/auth/sign-in/email', {
    body: JSON.stringify({ email, password: 'Synthetic-Demo-Password-2026!' }),
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    method: 'POST',
  })
  expect(response.status).toBe(200)
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
}

export function mutation(cookie: string, body: unknown, method: 'DELETE' | 'POST' | 'PUT' = 'POST') {
  return {
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      cookie,
      'idempotency-key': randomUUID(),
      origin: 'http://localhost',
    },
    method,
  }
}

export async function generateCase(runtime: Runtime, cookie: string): Promise<string> {
  const response = await runtime.app.request('/api/sim/v1/scenario-generation-jobs', mutation(cookie, {
    name: '影像准备患者',
    population: { age: { maximum: 90, minimum: 0 }, count: 1, gender: 'any' },
    providerId: 'synthea',
    seeds: { clinical: 7331, population: 4242 },
    timeRange: { end: '2026-08-01', start: '2020-01-01' },
    timeZone: 'Asia/Shanghai',
  }))
  expect(response.status).toBe(200)
  const processed = await runtime.scenarioData.processNextGenerationJob()
  expect(processed?.status).toBe('succeeded')
  return processed!.caseIds[0]!
}

export async function prepareImaging(runtime: Runtime, cookie: string, caseIds?: string[]) {
  const response = await runtime.app.request('/api/sim/v1/admin/imaging-preparations', mutation(cookie, {
    input: caseIds === undefined ? {} : { caseIds },
  }))
  expect(response.status).toBe(200)
  return commandResponseSchema(imagingPreparationBatchSchema).parse(await response.json()).data
}

/** 生成 Persona 并由挂号员开始门诊就诊；运行时需以 `persona: true` 创建。 */
export async function startOutpatientVisit(runtime: Runtime, administrator: string, caseId: string) {
  await runtime.app.request(
    `/api/sim/v1/synthetic-cases/${encodeURIComponent(caseId)}/patient-persona-jobs`,
    mutation(administrator, {}),
  )
  await runtime.patientPersona.processNext()
  const readyCase = syntheticCaseInstanceSchema.parse(await (await runtime.app.request(
    `/api/sim/v1/synthetic-cases/${encodeURIComponent(caseId)}`,
    { headers: { cookie: administrator } },
  )).json())
  const registrar = await signIn(runtime, 'registrar@demo.clinmesh.local')
  const registration = registrationCatalogSchema.parse(await (await runtime.app.request(
    '/api/his/v1/catalogs/registration',
    { headers: { cookie: registrar } },
  )).json())
  const start = await runtime.app.request(
    `/api/his/v1/synthetic-cases/${encodeURIComponent(caseId)}/actions/start-outpatient-visit`,
    mutation(registrar, {
      activeBriefRevision: readyCase.activeBriefRevision,
      departmentId: registration.departments[0]!.id,
      expectedCaseRevision: readyCase.revision,
      locationId: registration.locations[0]!.id,
      visitDate: registration.virtualDate,
      visitTypeId: registration.visitTypes[0]!.id,
    }),
  )
  expect(start.status).toBe(200)
  return commandResponseSchema(startSyntheticCaseResultSchema).parse(await start.json()).data
}

/** 从开始就诊走到医生接诊：分诊、医生开始首诊。返回医生会话与本院就诊标识。 */
export async function startConsultation(runtime: Runtime, administrator: string, caseId: string) {
  const visit = await startOutpatientVisit(runtime, administrator, caseId)
  const triageNurse = await signIn(runtime, 'triage@demo.clinmesh.local')
  const triageResponse = await runtime.app.request(
    `/api/his/v1/encounters/${visit.encounterId}/actions/record-triage`,
    mutation(triageNurse, {
      expectedVersions: { [`Encounter/${visit.encounterId}`]: '1', [`Task/${visit.queueTaskId}`]: '1' },
      input: {
        acuityCode: 'level-3',
        bloodPressure: { diastolicMmHg: 80, systolicMmHg: 122 },
        chiefComplaint: persona.chiefComplaint,
        oxygenSaturationPct: 98,
        pulseBpm: 86,
        respirationBpm: 18,
        temperatureC: 36.7,
      },
    }),
  )
  expect(triageResponse.status).toBe(200)
  const triage = triageResponseSchema.parse(await triageResponse.json()).data
  const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const startVisit = await runtime.app.request(
    `/api/his/v1/encounters/${visit.encounterId}/actions/start-first-visit`,
    mutation(doctor, {
      expectedVersions: { [`Encounter/${visit.encounterId}`]: '2', [`Task/${triage.doctorTaskId}`]: '1' },
      input: {},
    }),
  )
  expect(startVisit.status).toBe(200)
  startVisitResponseSchema.parse(await startVisit.json())
  return { doctor, encounterId: visit.encounterId, outpatientCaseId: visit.outpatientCaseId, patientId: visit.patientId }
}
