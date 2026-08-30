import { execFile, spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ServerType } from '@hono/node-server'
import {
  agentCapabilityGrantSchema,
  agentClientSchema,
} from '@clinmesh/contracts/agent'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { startServer } from '../src/server.ts'
import { z } from 'zod'
import {
  acknowledgeLaboratoryReportResponseSchema,
  askConsultationQuestionResponseSchema,
  billingQueueSchema,
  clinicalDocumentDraftResponseSchema,
  clinicalDocumentSignPreviewResponseSchema,
  clinicalDocumentSignResponseSchema,
  commandResponseSchema,
  confirmDiagnosisResponseSchema,
  diagnosisDraftResponseSchema,
  dispenseResponseSchema,
  doctorCaseDetailSchema,
  doctorQueueSchema,
  encounterCompletionPreviewSchema,
  encounterCompletionResponseSchema,
  issueLaboratoryRequestResponseSchema,
  issuePrescriptionResponseSchema,
  laboratoryRequestDraftResponseSchema,
  paymentPreviewResponseSchema,
  paymentResponseSchema,
  pharmacyQueueSchema,
  prescriptionDraftResponseSchema,
  prescriptionReviewResponseSchema,
  registrationCatalogSchema,
  triageQueueSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import {
  patientBriefJobSchema,
  scenarioGenerationJobSchema,
  startSyntheticCaseResultSchema,
  syntheticCaseInstanceSchema,
  type PatientBriefContent,
  type ScenarioGenerationRequest,
  type ScenarioProviderCapabilities,
} from '@clinmesh/contracts/scenario'
import type {
  ScenarioGenerationProvider,
  SourcePatientCorpus,
} from '../src/application/scenario-data/provider.ts'
import { sourceArtifactHash } from '../src/application/scenario-data/provider.ts'
import type {
  JsonChatCompletionInput,
  JsonChatCompletionsProvider,
} from '../src/infrastructure/ai/openai-chat-completions.ts'

const cleanups: Array<() => Promise<void>> = []
const execFileAsync = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))

function generatedPatientBundle() {
  const patient = {
    birthDate: '1988-03-12',
    gender: 'female',
    id: 'synthea-patient',
    name: [{ text: '合成全流程患者' }],
    resourceType: 'Patient',
  }
  const encounter = {
    id: 'synthea-index-encounter',
    period: {
      end: '2026-08-01T09:30:00+08:00',
      start: '2026-08-01T09:00:00+08:00',
    },
    reasonCode: [{ text: '发热伴咽痛' }],
    resourceType: 'Encounter',
    status: 'finished',
    subject: { reference: 'urn:uuid:synthea-patient' },
  }
  const condition = {
    code: {
      coding: [{ code: 'J10.1', display: '流感伴呼吸道表现', system: 'http://hl7.org/fhir/sid/icd-10' }],
    },
    encounter: { reference: 'urn:uuid:synthea-index-encounter' },
    id: 'synthea-index-condition',
    recordedDate: '2026-08-01T09:10:00+08:00',
    resourceType: 'Condition',
    subject: { reference: 'urn:uuid:synthea-patient' },
  }
  const observation = {
    code: {
      coding: [{
        code: 'CBC',
        display: '血常规',
        system: 'urn:clinmesh:operational:laboratory',
      }],
    },
    effectiveDateTime: '2026-08-01T09:15:00+08:00',
    encounter: { reference: 'urn:uuid:synthea-index-encounter' },
    id: 'synthea-index-observation',
    referenceRange: [{
      high: { code: '10*9/L', system: 'http://unitsofmeasure.org', unit: '10^9/L', value: 9.5 },
      low: { code: '10*9/L', system: 'http://unitsofmeasure.org', unit: '10^9/L', value: 3.5 },
      text: '3.5-9.5 x10^9/L',
    }],
    resourceType: 'Observation',
    status: 'final',
    subject: { reference: 'urn:uuid:synthea-patient' },
    valueQuantity: {
      code: '10*9/L',
      system: 'http://unitsofmeasure.org',
      unit: '10^9/L',
      value: 11.2,
    },
  }
  return {
    entry: [
      { fullUrl: 'urn:uuid:synthea-patient', resource: patient },
      { fullUrl: 'urn:uuid:synthea-index-encounter', resource: encounter },
      { fullUrl: 'urn:uuid:synthea-index-condition', resource: condition },
      { fullUrl: 'urn:uuid:synthea-index-observation', resource: observation },
    ],
    resourceType: 'Bundle',
    type: 'collection',
  }
}

class CliE2eSyntheaProvider implements ScenarioGenerationProvider {
  async capabilities(): Promise<ScenarioProviderCapabilities> {
    return {
      available: true,
      maxPopulation: 1,
      modules: ['fever'],
      providerId: 'synthea',
      providerName: 'Synthetic CLI E2E Synthea',
    }
  }

  async generate(_request: ScenarioGenerationRequest): Promise<SourcePatientCorpus> {
    const raw = generatedPatientBundle()
    return {
      kind: 'synthea-r4',
      sources: [{
        format: 'fhir-r4-bundle',
        hash: sourceArtifactHash(raw),
        patientId: 'synthea-patient',
        raw,
      }],
    }
  }
}

class CliE2eChatProvider implements JsonChatCompletionsProvider {
  readonly #outputs: unknown[]

  constructor(brief: PatientBriefContent) {
    this.#outputs = [
      brief,
      { conclusion: '白细胞计数升高。', interpretation: 'high', value: 11.2 },
    ]
  }

  async completeJson(_input: JsonChatCompletionInput) {
    const output = this.#outputs.shift()
    if (output === undefined) throw new Error('No synthetic CLI E2E model output remains')
    return { content: JSON.stringify(output), model: 'synthetic-cli-e2e-model' }
  }
}

beforeAll(async () => {
  await execFileAsync('pnpm', ['--filter', '@clinmesh/cli', 'build'], { cwd: repositoryRoot })
})

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function listen(server: ServerType): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })
}

async function reservePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await listen(server)
  const port = (server.address() as AddressInfo).port
  await closeServer(server)
  return port
}

async function runCli(
  args: string[],
  env: Record<string, string>,
  stdin?: string,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const entry = fileURLToPath(new URL('../../cli/dist/clinmesh.js', import.meta.url))
  const child = spawn(process.execPath, [entry, ...args], {
    env: {
      PATH: process.env.PATH,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.stdin.end(stdin)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return { code, stderr, stdout }
}

function cliData<Schema extends z.ZodType>(
  result: Awaited<ReturnType<typeof runCli>>,
  operationId: string,
  schema: Schema,
): z.infer<Schema> {
  expect(result).toMatchObject({ code: 0, stderr: '' })
  const envelope = z.object({
    data: z.unknown(),
    ok: z.literal(true),
    operation: z.object({ id: z.literal(operationId) }).loose(),
    schemaVersion: z.literal(1),
  }).loose().parse(JSON.parse(result.stdout) as unknown)
  return schema.parse(envelope.data)
}

function responseDroppingProxy(upstreamOrigin: string): Server {
  let dropped = false
  return createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || ['connection', 'content-length', 'host'].includes(name)) continue
        for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
      }
      const body = Buffer.concat(chunks)
      const upstream = await fetch(new URL(request.url ?? '/', upstreamOrigin), {
        ...(body.length === 0 ? {} : { body }),
        headers,
        method: request.method ?? 'GET',
      })
      const payload = Buffer.from(await upstream.arrayBuffer())
      if (
        !dropped
        && request.method === 'POST'
        && request.url?.startsWith('/api/his/v1/patients') === true
      ) {
        dropped = true
        response.destroy()
        return
      }
      const responseHeaders: Record<string, string> = {}
      upstream.headers.forEach((value, name) => { responseHeaders[name] = value })
      response.writeHead(upstream.status, responseHeaders)
      response.end(payload)
    } catch {
      response.destroy()
    }
  })
}

describe('clinmesh CLI process over real HTTP', () => {
  it('recovers one response-lost Agent write through its Command receipt without duplicating the Effect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-cli-process-'))
    const password = 'synthetic-cli-process-password'
    const port = await reservePort()
    const serverOrigin = `http://127.0.0.1:${port}`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: serverOrigin,
      authSecret: 'synthetic-cli-process-secret-32-bytes',
      cursorSecret: 'synthetic-cli-process-cursor-secret',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: [serverOrigin],
    })
    const server = startServer({ app: runtime.app, hostname: '127.0.0.1', port })
    expect(await listen(server)).toBe(serverOrigin)
    cleanups.push(async () => {
      await closeServer(server)
      await runtime.close()
      await rm(directory, { force: true, recursive: true })
    })

    const humanEnv = { CLINMESH_CONFIG_DIR: join(directory, 'cli-config') }
    const humanLogin = await runCli([
      'auth', 'login',
      '--profile', 'admin',
      '--server-url', serverOrigin,
      '--email', 'admin@demo.clinmesh.local',
      '--password-stdin',
    ], humanEnv, `${password}\n`)
    expect(humanLogin).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(humanLogin.stdout)).toMatchObject({
      data: { authMode: 'human', profile: 'admin', serverUrl: serverOrigin },
      ok: true,
    })
    const humanContext = await runCli(
      ['context', 'show', '--profile', 'admin'],
      humanEnv,
    )
    expect(humanContext).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(humanContext.stdout)).toMatchObject({
      data: { actor: { roleCode: 'administrator', workspaceId: 'workspace-demo' } },
      ok: true,
    })

    const signIn = await fetch(`${serverOrigin}/api/auth/sign-in/email`, {
      body: JSON.stringify({ email: 'admin@demo.clinmesh.local', password }),
      headers: { 'content-type': 'application/json', origin: serverOrigin },
      method: 'POST',
    })
    expect(signIn.status).toBe(200)
    const cookie = signIn.headers.getSetCookie()[0]?.split(';', 1)[0] ?? ''
    const controlHeaders = {
      'content-type': 'application/json',
      cookie,
      origin: serverOrigin,
    }
    const clientResponse = await fetch(`${serverOrigin}/api/agent/v1/clients`, {
      body: JSON.stringify({ name: 'CLI process registrar' }),
      headers: { ...controlHeaders, 'idempotency-key': 'cli-e2e-client-create-1' },
      method: 'POST',
    })
    const client = agentClientSchema.parse(await clientResponse.json())
    const grantResponse = await fetch(`${serverOrigin}/api/agent/v1/grants`, {
      body: JSON.stringify({
        agentClientId: client.agentClientId,
        operationIds: ['fhir.metadata.read', 'patient.create', 'patient.search'],
        practitionerRoleId: 'practitioner-role-registrar',
        ttlSeconds: 3600,
      }),
      headers: { ...controlHeaders, 'idempotency-key': 'cli-e2e-registrar-grant-1' },
      method: 'POST',
    })
    expect(grantResponse.status).toBe(200)
    const grant = agentCapabilityGrantSchema.parse(await grantResponse.json())
    const agentEnv = {
      CLINMESH_AGENT_ID: 'cli-process-agent',
      CLINMESH_AGENT_TASK_ID: 'cli-process-task',
      CLINMESH_SERVER_URL: serverOrigin,
      CLINMESH_TOKEN: grant.token,
    }

    const metadata = await runCli(['fhir', 'metadata'], agentEnv)
    expect(metadata).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(metadata.stdout)).toMatchObject({
      data: { fhirVersion: '5.0.0', resourceType: 'CapabilityStatement' },
      ok: true,
      operation: { id: 'fhir.metadata.read' },
    })

    const initialQuery = await runCli(
      ['patient', 'search', '--query', 'MZ20260826001'],
      agentEnv,
    )
    expect(initialQuery).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(initialQuery.stdout)).toMatchObject({
      ok: true,
      operation: { id: 'patient.search' },
    })

    const proxy = responseDroppingProxy(serverOrigin)
    proxy.listen(0, '127.0.0.1')
    const proxyOrigin = await listen(proxy)
    cleanups.push(() => closeServer(proxy))
    const patientInput = JSON.stringify({
      birthDate: '1992-05-06',
      gender: 'female',
      identifier: 'CLI-E2E-0001',
      name: '合成 CLI 患者',
    })
    const idempotencyKey = 'cli-e2e-patient-create-0001'
    const ambiguous = await runCli([
      'patient', 'create',
      '--input', '-',
      '--idempotency-key', idempotencyKey,
    ], { ...agentEnv, CLINMESH_SERVER_URL: proxyOrigin }, patientInput)
    expect(ambiguous.code).toBe(7)
    expect(ambiguous.stdout).toBe('')
    expect(JSON.parse(ambiguous.stderr)).toMatchObject({
      error: {
        code: 'ambiguous_outcome',
        idempotencyKey,
        operationId: 'patient.create',
        outcome: 'ambiguous',
      },
      ok: false,
    })

    const receipt = await runCli([
      'command', 'receipt', 'get',
      '--operation-id', 'patient.create',
      '--idempotency-key', idempotencyKey,
    ], agentEnv)
    expect(receipt).toMatchObject({ code: 0, stderr: '' })
    const receiptEnvelope = JSON.parse(receipt.stdout)
    expect(receiptEnvelope).toMatchObject({
      data: {
        idempotencyKey,
        operationId: 'patient.create',
        status: 'completed',
      },
      ok: true,
    })

    const triageGrantResponse = await fetch(`${serverOrigin}/api/agent/v1/grants`, {
      body: JSON.stringify({
        agentClientId: client.agentClientId,
        operationIds: ['triage.record'],
        practitionerRoleId: 'practitioner-role-triage-nurse',
        ttlSeconds: 3600,
      }),
      headers: { ...controlHeaders, 'idempotency-key': 'cli-e2e-triage-grant-1' },
      method: 'POST',
    })
    expect(triageGrantResponse.status).toBe(200)
    const triageGrant = agentCapabilityGrantSchema.parse(await triageGrantResponse.json())
    const crossGrantReceipt = await runCli([
      'command', 'receipt', 'get',
      '--operation-id', 'patient.create',
      '--idempotency-key', idempotencyKey,
    ], { ...agentEnv, CLINMESH_TOKEN: triageGrant.token })
    expect(crossGrantReceipt).toMatchObject({ code: 3, stdout: '' })
    expect(JSON.parse(crossGrantReceipt.stderr)).toMatchObject({
      error: { code: 'OPERATION_NOT_ALLOWED', type: 'authorization' },
      ok: false,
    })

    const replay = await runCli([
      'patient', 'create',
      '--input', '-',
      '--idempotency-key', idempotencyKey,
    ], agentEnv, patientInput)
    expect(replay).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(replay.stdout).data).toEqual(receiptEnvelope.data.response)

    const finalQuery = await runCli(
      ['patient', 'search', '--query', 'CLI-E2E-0001'],
      agentEnv,
    )
    expect(finalQuery).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(finalQuery.stdout)).toMatchObject({
      data: {
        items: [expect.objectContaining({ identifier: 'CLI-E2E-0001' })],
        total: 1,
      },
      ok: true,
    })
  }, 30_000)

  it('completes one generated Synthetic Case across all HIS roles through built CLI processes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-cli-cross-role-'))
    const password = 'synthetic-cli-cross-role-password'
    const port = await reservePort()
    const serverOrigin = `http://127.0.0.1:${port}`
    const brief: PatientBriefContent = {
      chiefComplaint: '发热伴咽痛两天',
      knownHistorySummary: '既往体健，无已知药物过敏。',
      openingStatement: '医生您好，我发热两天了，吞咽时咽痛。',
      symptomTopics: [{
        answerPoints: ['两天前开始发热。', '最高体温 38.8 摄氏度。'],
        id: 'fever-course',
        name: '发热经过',
      }],
    }
    const chatProvider = new CliE2eChatProvider(brief)
    const runtime = await createClinMeshRuntime({
      authBaseUrl: serverOrigin,
      authSecret: 'synthetic-cli-cross-role-secret-32-bytes',
      chatCompletionsProvider: chatProvider,
      cursorSecret: 'synthetic-cli-cross-role-cursor-secret',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      investigationModel: 'synthetic-cli-investigation-model',
      migrationMode: 'apply',
      patientBriefModel: 'synthetic-cli-brief-model',
      syntheaProvider: new CliE2eSyntheaProvider(),
      trustedOrigins: [serverOrigin],
    })
    const server = startServer({ app: runtime.app, hostname: '127.0.0.1', port })
    expect(await listen(server)).toBe(serverOrigin)
    cleanups.push(async () => {
      await closeServer(server)
      await runtime.close()
      await rm(directory, { force: true, recursive: true })
    })

    const signIn = await fetch(`${serverOrigin}/api/auth/sign-in/email`, {
      body: JSON.stringify({ email: 'admin@demo.clinmesh.local', password }),
      headers: { 'content-type': 'application/json', origin: serverOrigin },
      method: 'POST',
    })
    expect(signIn.status).toBe(200)
    const cookie = signIn.headers.getSetCookie()[0]?.split(';', 1)[0] ?? ''
    const controlHeaders = {
      'content-type': 'application/json',
      cookie,
      origin: serverOrigin,
    }
    const generationResponse = await fetch(`${serverOrigin}/api/sim/v1/scenario-generation-jobs`, {
      body: JSON.stringify({
        name: 'CLI 跨岗位病例',
        population: { age: { maximum: 65, minimum: 18 }, count: 1, gender: 'any' },
        providerId: 'synthea',
        seeds: { clinical: 7331, population: 4242 },
        timeRange: { end: '2026-08-01', start: '2020-01-01' },
        timeZone: 'Asia/Shanghai',
      }),
      headers: { ...controlHeaders, 'idempotency-key': 'cli-cross-role-generation-1' },
      method: 'POST',
    })
    expect(generationResponse.status).toBe(200)
    commandResponseSchema(scenarioGenerationJobSchema).parse(await generationResponse.json())
    const generation = await runtime.scenarioData.processNextGenerationJob()
    expect(generation).toMatchObject({ status: 'succeeded' })
    const caseId = generation?.caseIds[0]
    if (caseId === undefined) throw new Error('CLI cross-role generation produced no Synthetic Case')

    const briefResponse = await fetch(
      `${serverOrigin}/api/sim/v1/synthetic-cases/${encodeURIComponent(caseId)}/patient-brief-jobs`,
      {
        body: '{}',
        headers: { ...controlHeaders, 'idempotency-key': 'cli-cross-role-brief-1' },
        method: 'POST',
      },
    )
    expect(briefResponse.status).toBe(200)
    commandResponseSchema(patientBriefJobSchema).parse(await briefResponse.json())
    expect(await runtime.patientBrief.processNext()).toMatchObject({ status: 'succeeded' })
    const caseResponse = await fetch(
      `${serverOrigin}/api/sim/v1/synthetic-cases/${encodeURIComponent(caseId)}`,
      { headers: { cookie } },
    )
    const syntheticCase = syntheticCaseInstanceSchema.parse(await caseResponse.json())
    expect(syntheticCase).toMatchObject({ activeBriefRevision: 1, status: 'brief-ready' })

    const clientResponse = await fetch(`${serverOrigin}/api/agent/v1/clients`, {
      body: JSON.stringify({ name: 'CLI cross-role Agent' }),
      headers: { ...controlHeaders, 'idempotency-key': 'cli-cross-role-client-1' },
      method: 'POST',
    })
    const client = agentClientSchema.parse(await clientResponse.json())
    const mintGrant = async (
      role: string,
      operationIds: string[],
      idempotencyKey: string,
    ) => {
      const response = await fetch(`${serverOrigin}/api/agent/v1/grants`, {
        body: JSON.stringify({
          agentClientId: client.agentClientId,
          operationIds,
          practitionerRoleId: `practitioner-role-${role}`,
          ttlSeconds: 3600,
        }),
        headers: { ...controlHeaders, 'idempotency-key': idempotencyKey },
        method: 'POST',
      })
      expect(response.status).toBe(200)
      return agentCapabilityGrantSchema.parse(await response.json()).token
    }
    const agentEnv = (token: string) => ({
      CLINMESH_AGENT_ID: 'cli-cross-role-agent',
      CLINMESH_AGENT_TASK_ID: 'cli-cross-role-task',
      CLINMESH_SERVER_URL: serverOrigin,
      CLINMESH_TOKEN: token,
    })
    const execute = (
      token: string,
      args: string[],
      input?: unknown,
    ) => runCli(args, agentEnv(token), input === undefined ? undefined : JSON.stringify(input))

    const registrarToken = await mintGrant('registrar', [
      'catalog.registration.read',
      'registration.synthetic-case.start',
    ], 'cli-cross-role-registrar-grant-1')
    const registrationCatalog = cliData(
      await execute(registrarToken, ['catalog', 'registration', 'get']),
      'catalog.registration.read',
      registrationCatalogSchema,
    )
    const started = cliData(
      await execute(registrarToken, [
        'registration', 'synthetic-case', 'start',
        '--input', '-',
        '--idempotency-key', 'cli-cross-role-start-1',
      ], {
        activeBriefRevision: syntheticCase.activeBriefRevision,
        caseId,
        departmentId: registrationCatalog.departments[0]?.id,
        expectedCaseRevision: syntheticCase.revision,
        locationId: registrationCatalog.locations[0]?.id,
        visitDate: registrationCatalog.virtualDate,
        visitTypeId: registrationCatalog.visitTypes[0]?.id,
      }),
      'registration.synthetic-case.start',
      commandResponseSchema(startSyntheticCaseResultSchema),
    ).data
    const administratorToken = await mintGrant('administrator', [
      'registration.synthetic-case.start',
    ], 'cli-cross-role-administrator-grant-1')
    const crossRoleReceipt = await execute(administratorToken, [
      'command', 'receipt', 'get',
      '--operation-id', 'registration.synthetic-case.start',
      '--idempotency-key', 'cli-cross-role-start-1',
    ])
    expect(crossRoleReceipt).toMatchObject({ code: 1, stdout: '' })
    expect(JSON.parse(crossRoleReceipt.stderr)).toMatchObject({
      error: { code: 'COMMAND_RECEIPT_NOT_FOUND' },
      ok: false,
    })

    const triageToken = await mintGrant('triage-nurse', [
      'triage.queue.list',
      'triage.record',
    ], 'cli-cross-role-triage-grant-1')
    const triageQueue = cliData(
      await execute(triageToken, ['triage', 'queue', 'list', '--status', 'pending']),
      'triage.queue.list',
      triageQueueSchema,
    )
    const triageItem = triageQueue.items.find(item => item.encounterId === started.encounterId)
    if (triageItem === undefined) throw new Error('Synthetic Case did not enter the triage queue')
    const triage = cliData(
      await execute(triageToken, [
        'triage', 'record', '--input', '-', '--idempotency-key', 'cli-cross-role-triage-1',
      ], {
        acuityCode: 'level-3',
        bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 },
        chiefComplaint: '发热伴咽痛两天',
        encounterId: triageItem.encounterId,
        encounterVersion: triageItem.encounterVersion,
        oxygenSaturationPct: 98,
        pulseBpm: 102,
        respirationBpm: 20,
        taskId: triageItem.taskId,
        taskVersion: triageItem.taskVersion,
        temperatureC: 38.6,
      }),
      'triage.record',
      triageResponseSchema,
    ).data
    expect(triage.status).toBe('awaiting-doctor')

    const doctorToken = await mintGrant('outpatient-doctor', [
      'doctor.case.get',
      'doctor.queue.list',
      'encounter.clinical-document.draft.set',
      'encounter.clinical-document.sign.preview',
      'encounter.clinical-document.sign',
      'encounter.complete',
      'encounter.completion.preview',
      'encounter.consultation.ask',
      'encounter.diagnosis.confirm',
      'encounter.diagnosis.draft.set',
      'encounter.laboratory-request.draft.set',
      'encounter.laboratory-request.issue',
      'encounter.prescription.draft.set',
      'encounter.prescription.issue',
      'laboratory-report.acknowledge',
    ], 'cli-cross-role-doctor-grant-1')
    const doctorQueue = cliData(
      await execute(doctorToken, ['doctor', 'queue', 'list']),
      'doctor.queue.list',
      doctorQueueSchema,
    )
    const doctorItem = doctorQueue.items.find(item => item.encounterId === started.encounterId)
    if (doctorItem === undefined) throw new Error('Triaged case did not enter the doctor queue')
    const initialCase = cliData(
      await execute(doctorToken, ['doctor', 'case', 'get', '--case-id', doctorItem.caseId]),
      'doctor.case.get',
      doctorCaseDetailSchema,
    )
    const question = initialCase.consultation?.questions[0]
    if (question === undefined || initialCase.consultation === undefined) {
      throw new Error('Generated case has no consultation question')
    }
    cliData(
      await execute(doctorToken, [
        'encounter', 'consultation', 'ask',
        '--input', '-',
        '--idempotency-key', 'cli-cross-role-question-1',
      ], {
        encounterId: doctorItem.encounterId,
        encounterVersion: doctorItem.encounterVersion,
        expectedVersion: initialCase.consultation.version,
        questionCode: question.code,
        taskId: doctorItem.taskId,
        taskVersion: doctorItem.taskVersion,
      }),
      'encounter.consultation.ask',
      askConsultationQuestionResponseSchema,
    )
    const activeDoctorItem = cliData(
      await execute(doctorToken, ['doctor', 'queue', 'list']),
      'doctor.queue.list',
      doctorQueueSchema,
    ).items.find(item => item.encounterId === started.encounterId)
    if (activeDoctorItem === undefined) throw new Error('Consultation did not start the first visit')
    const laboratoryDraft = cliData(
      await execute(doctorToken, [
        'encounter', 'laboratory-request', 'draft', 'set',
        '--input', '-',
        '--idempotency-key', 'cli-cross-role-lab-draft-1',
      ], {
        catalogItemId: 'lab-cbc',
        encounterId: doctorItem.encounterId,
        encounterVersion: activeDoctorItem.encounterVersion,
        expectedDraftVersion: 0,
        indicationCode: 'fever',
      }),
      'encounter.laboratory-request.draft.set',
      laboratoryRequestDraftResponseSchema,
    ).data
    cliData(
      await execute(doctorToken, [
        'encounter', 'laboratory-request', 'issue',
        '--input', '-',
        '--idempotency-key', 'cli-cross-role-lab-issue-1',
      ], {
        encounterId: doctorItem.encounterId,
        encounterVersion: activeDoctorItem.encounterVersion,
        expectedDraftVersion: laboratoryDraft.draftVersion,
      }),
      'encounter.laboratory-request.issue',
      issueLaboratoryRequestResponseSchema,
    )
    await runtime.dispatchPending()
    const reportedCase = cliData(
      await execute(doctorToken, ['doctor', 'case', 'get', '--case-id', doctorItem.caseId]),
      'doctor.case.get',
      doctorCaseDetailSchema,
    )
    const laboratoryRequest = reportedCase.laboratoryRequests?.requests[0]
    if (laboratoryRequest?.report === undefined) throw new Error('LIS did not create a report')
    cliData(
      await execute(doctorToken, [
        'laboratory-report', 'acknowledge',
        '--input', '-',
        '--idempotency-key', 'cli-cross-role-report-ack-1',
      ], {
        diagnosticReportId: laboratoryRequest.report.diagnosticReportId,
        diagnosticReportVersion: laboratoryRequest.report.diagnosticReportVersion,
        expectedRequestVersion: laboratoryRequest.version,
        requestId: laboratoryRequest.id,
      }),
      'laboratory-report.acknowledge',
      acknowledgeLaboratoryReportResponseSchema,
    )

    const diagnosisDraft = cliData(
      await execute(doctorToken, [
        'encounter', 'diagnosis', 'draft', 'set',
        '--input', '-',
        '--idempotency-key', 'cli-cross-role-diagnosis-draft-1',
      ], {
        encounterId: doctorItem.encounterId,
        encounterVersion: activeDoctorItem.encounterVersion,
        entries: [{ catalogItemId: 'diagnosis-influenza', role: 'primary' }],
        expectedDraftVersion: 0,
      }),
      'encounter.diagnosis.draft.set',
      diagnosisDraftResponseSchema,
    ).data
    const diagnosis = cliData(
      await execute(doctorToken, [
        'encounter', 'diagnosis', 'confirm',
        '--input', '-',
        '--idempotency-key', 'cli-cross-role-diagnosis-confirm-1',
      ], {
        encounterId: doctorItem.encounterId,
        encounterVersion: activeDoctorItem.encounterVersion,
        expectedDraftVersion: diagnosisDraft.draftVersion,
      }),
      'encounter.diagnosis.confirm',
      confirmDiagnosisResponseSchema,
    ).data
    const prescriptionDraft = cliData(
      await execute(doctorToken, [
        'encounter', 'prescription', 'draft', 'set',
        '--input', '-',
        '--idempotency-key', 'cli-cross-role-prescription-draft-1',
      ], {
        encounterId: doctorItem.encounterId,
        encounterVersion: diagnosis.encounterVersion,
        expectedDraftVersion: 0,
        items: [{
          catalogItemId: 'medication-oseltamivir',
          courseDays: 5,
          doseText: '75 mg',
          frequencyCode: 'BID',
          quantity: 10,
        }],
      }),
      'encounter.prescription.draft.set',
      prescriptionDraftResponseSchema,
    ).data
    const prescription = cliData(
      await execute(doctorToken, [
        'encounter', 'prescription', 'issue',
        '--input', '-',
        '--idempotency-key', 'cli-cross-role-prescription-issue-1',
      ], {
        encounterId: doctorItem.encounterId,
        encounterVersion: diagnosis.encounterVersion,
        expectedDraftVersion: prescriptionDraft.draftVersion,
      }),
      'encounter.prescription.issue',
      issuePrescriptionResponseSchema,
    ).data.prescription
    const document = {
      assessment: '结合问诊和检验结果，考虑甲型流感。',
      chiefComplaint: '发热伴咽痛两天。',
      disposition: '门诊口服抗病毒药物治疗。',
      followUp: '三天后复诊，持续高热或气促时立即就医。',
      historyOfPresentIllness: '两天前出现发热，最高体温 38.8 摄氏度，伴咽痛。',
      physicalExamination: '神志清楚，咽部充血，双肺呼吸音清。',
    }
    const documentDraft = cliData(
      await execute(doctorToken, [
        'encounter', 'clinical-document', 'draft', 'set',
        '--input', '-',
        '--idempotency-key', 'cli-cross-role-document-draft-1',
      ], {
        document,
        encounterId: doctorItem.encounterId,
        encounterVersion: diagnosis.encounterVersion,
        expectedDraftVersion: 0,
      }),
      'encounter.clinical-document.draft.set',
      clinicalDocumentDraftResponseSchema,
    ).data
    const documentPreview = cliData(
      await execute(doctorToken, [
        'encounter', 'clinical-document', 'sign', 'preview',
        '--input', '-',
        '--idempotency-key', 'cli-cross-role-document-preview-1',
      ], {
        encounterId: doctorItem.encounterId,
        encounterVersion: diagnosis.encounterVersion,
        expectedDraftVersion: documentDraft.draftVersion,
      }),
      'encounter.clinical-document.sign.preview',
      clinicalDocumentSignPreviewResponseSchema,
    ).data
    cliData(
      await execute(doctorToken, [
        'encounter', 'clinical-document', 'sign', 'commit',
        '--input', '-',
        '--idempotency-key', 'cli-cross-role-document-sign-1',
      ], {
        commitToken: documentPreview.commitToken,
        encounterId: doctorItem.encounterId,
        encounterVersion: diagnosis.encounterVersion,
        previewId: documentPreview.previewId,
      }),
      'encounter.clinical-document.sign',
      clinicalDocumentSignResponseSchema,
    )
    const completionPreview = cliData(
      await execute(doctorToken, [
        'encounter', 'completion', 'preview', '--encounter-id', doctorItem.encounterId,
      ]),
      'encounter.completion.preview',
      encounterCompletionPreviewSchema,
    )
    expect(completionPreview.canComplete).toBe(true)
    const completion = cliData(
      await execute(doctorToken, [
        'encounter', 'complete', '--input', '-', '--idempotency-key', 'cli-cross-role-complete-1',
      ], {
        encounterId: doctorItem.encounterId,
        encounterVersion: diagnosis.encounterVersion,
      }),
      'encounter.complete',
      encounterCompletionResponseSchema,
    ).data

    const cashierToken = await mintGrant('cashier', [
      'billing.queue.list',
      'payment.confirm',
      'payment.preview',
    ], 'cli-cross-role-cashier-grant-1')
    const medicationBilling = cliData(
      await execute(cashierToken, [
        'billing', 'queue', 'list', '--category', 'medication', '--status', 'pending',
      ]),
      'billing.queue.list',
      billingQueueSchema,
    ).items.find(item => item.caseId === doctorItem.caseId)
    if (medicationBilling === undefined) throw new Error('Medication charge did not enter billing')
    const medicationPreview = cliData(
      await execute(cashierToken, [
        'payment', 'preview', '--input', '-', '--idempotency-key', 'cli-cross-role-med-preview-1',
      ], {
        caseId: doctorItem.caseId,
        category: 'medication',
        chargeItemId: medicationBilling.chargeItemId,
        chargeVersion: medicationBilling.chargeVersion,
        simulatorRule: 'success',
      }),
      'payment.preview',
      paymentPreviewResponseSchema,
    ).data
    cliData(
      await execute(cashierToken, [
        'payment', 'confirm', '--input', '-', '--idempotency-key', 'cli-cross-role-med-payment-1',
      ], {
        chargeItemId: medicationPreview.chargeItemId,
        chargeVersion: medicationPreview.chargeVersion,
        commitToken: medicationPreview.commitToken,
        previewId: medicationPreview.previewId,
      }),
      'payment.confirm',
      paymentResponseSchema,
    )

    const pharmacistToken = await mintGrant('pharmacist', [
      'pharmacy.queue.list',
      'prescription.dispense',
      'prescription.review',
    ], 'cli-cross-role-pharmacist-grant-1')
    const pharmacyBeforeReview = cliData(
      await execute(pharmacistToken, ['pharmacy', 'queue', 'list', '--status', 'pending']),
      'pharmacy.queue.list',
      pharmacyQueueSchema,
    ).items.find(item => item.prescriptionId === prescription.id)
    if (pharmacyBeforeReview === undefined) throw new Error('Paid prescription did not enter pharmacy')
    const medicationVersions = pharmacyBeforeReview.medications.map(medication => ({
      medicationRequestId: medication.medicationRequestId,
      medicationRequestVersion: medication.medicationRequestVersion,
    }))
    const review = cliData(
      await execute(pharmacistToken, [
        'prescription', 'review', '--input', '-', '--idempotency-key', 'cli-cross-role-review-1',
      ], {
        encounterId: pharmacyBeforeReview.encounterId,
        encounterVersion: completion.encounterVersion,
        medications: medicationVersions,
        note: '合成处方审核通过。',
        prescriptionId: pharmacyBeforeReview.prescriptionId,
        prescriptionVersion: pharmacyBeforeReview.prescriptionVersion,
      }),
      'prescription.review',
      prescriptionReviewResponseSchema,
    ).data
    const pharmacyBeforeDispense = cliData(
      await execute(pharmacistToken, ['pharmacy', 'queue', 'list', '--status', 'pending']),
      'pharmacy.queue.list',
      pharmacyQueueSchema,
    ).items.find(item => item.prescriptionId === prescription.id)
    if (pharmacyBeforeDispense === undefined) throw new Error('Reviewed prescription left pharmacy')
    const medication = pharmacyBeforeDispense.medications[0]
    const lot = medication?.lots[0]
    if (medication === undefined || lot === undefined) throw new Error('No dispensable inventory lot exists')
    const dispense = cliData(
      await execute(pharmacistToken, [
        'prescription', 'dispense', '--input', '-', '--idempotency-key', 'cli-cross-role-dispense-1',
      ], {
        encounterId: pharmacyBeforeDispense.encounterId,
        encounterVersion: completion.encounterVersion,
        lotSelections: [{
          expectedVersion: lot.version,
          lotId: lot.id,
          quantity: medication.remainingQuantity,
        }],
        medications: medicationVersions,
        prescriptionId: pharmacyBeforeDispense.prescriptionId,
        prescriptionVersion: review.prescriptionVersion,
      }),
      'prescription.dispense',
      dispenseResponseSchema,
    ).data
    expect(dispense).toMatchObject({ scenarioStatus: 'completed', status: 'completed' })
  }, 60_000)
})
