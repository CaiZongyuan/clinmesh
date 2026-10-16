import { once } from 'node:events'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, cpus } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { serve } from '@hono/node-server'
import { chromium } from '@playwright/test'
import { build } from 'vite'
import { z } from 'zod'
import { agentPageContextBindingSchema, doctorRecordingSourceResponseSchema } from '../../../packages/contracts/src/agent.ts'
import { createPatientResponseSchema, doctorQueueSchema, registrationResponseSchema, startVisitResponseSchema,
  triageResponseSchema } from '../../../packages/contracts/src/his.ts'
import { readServerEnvironment } from '../../server/src/config.ts'
import { createClinMeshRuntime } from '../../server/src/runtime.ts'
import { DshModelProvider } from '../../server/src/infrastructure/ai/dsh-model-provider.ts'
import { dshDefaultModel } from '../../../packages/contracts/src/model-bridge.ts'
import { signIn } from '../../server/tests/fixtures/consultation.ts'

// Explicit opt-in live benchmark. Only aggregate timing metadata leaves the temporary database.
const seconds = Number(process.argv[2] ?? 600)
const caseCount = Number(process.argv[3] ?? 10)
const workload = process.argv[5] ?? 'measurements'
if (!Number.isInteger(seconds) || seconds < 3 || seconds > 3600 || !Number.isInteger(caseCount) || caseCount < 1 || caseCount > 10) {
  throw new Error('Usage: pnpm exec tsx apps/web/e2e/recording-benchmark.ts [seconds:3..3600] [cases:1..10] [report-path] [measurements|repeated-exam]')
}
if (!['measurements', 'repeated-exam'].includes(workload)) throw new Error('Unknown synthetic workload')
const environment = readServerEnvironment(process.env)
const secret = z.string().min(32).parse(environment.CLINMESH_DSH_BRIDGE_SECRET)
const provider = new DshModelProvider({ origin: environment.CLINMESH_DSH_MODEL_ORIGIN ?? 'http://127.0.0.1:3080',
  secret, timeoutMs: 120_000, maxResponseBytes: 1_048_576 })
const model = await provider.resolveModel(environment.CLINMESH_AI_RECORDING_MODEL ?? dshDefaultModel)
const directory = await mkdtemp(join(tmpdir(), 'clinmesh-recording-benchmark-'))
const webRoot = join(directory, 'web')
await build({ root: resolve('apps/web'), envDir: false, logLevel: 'silent', build: { outDir: webRoot, emptyOutDir: true } })
let runtime: Awaited<ReturnType<typeof createClinMeshRuntime>> | undefined
const server = serve({ hostname: '127.0.0.1', port: 0, fetch: request => runtime?.app.fetch(request) ?? new Response('Starting', { status: 503 }) })
await once(server, 'listening')
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('Missing listener')
const origin = `http://127.0.0.1:${address.port}`
const password = `Synthetic-${randomUUID()}-Aa1!`
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
const samples: Array<{ caseIndex: number; sourceId: string; savedAt: number; visibleAt?: number }> = []
const backlog: Array<{ elapsedSeconds: number; saved: number; visible: number; queued: number }> = []
try {
  runtime = await createClinMeshRuntime({ authBaseUrl: origin, authSecret: randomUUID() + randomUUID(),
    cursorSecret: randomUUID() + randomUUID(), databasePath: join(directory, 'benchmark.sqlite'), demoPassword: password,
    migrationMode: 'apply', trustedOrigins: [origin], webRoot, autoDispatchIntervalMs: 100,
    dshBridgeSecret: secret, chatCompletionsProvider: provider, consultationModel: model, consultationRecordingModel: model,
    dshModelBridge: { origin: environment.CLINMESH_DSH_MODEL_ORIGIN ?? 'http://127.0.0.1:3080', secret, timeoutMs: 120_000, maxResponseBytes: 1_048_576 } })
  const app = runtime
  const registrar = await signIn(app, 'registrar@demo.clinmesh.local', password, origin)
  const nurse = await signIn(app, 'triage@demo.clinmesh.local', password, origin)
  const doctor = await signIn(app, 'doctor@demo.clinmesh.local', password, origin)
  const post = async (path: string, cookie: string, body: unknown) => {
    const response = await app.app.request(path, { method: 'POST', headers: { cookie, origin,
      'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`Synthetic setup or source rejected: ${response.status}`)
    return response.json()
  }
  const context = await browser.newContext({ locale: 'zh-CN' })
  context.setDefaultTimeout(15_000)
  const [cookieName, ...cookieValue] = doctor.split('=')
  await context.addCookies([{ name: cookieName!, value: cookieValue.join('='), url: origin }])
  const cases = []
  for (let index = 0; index < caseCount; index++) {
    const name = `合成测量患者${index + 1}`
    const patient = createPatientResponseSchema.parse(await post('/api/his/v1/patients', registrar, { expectedVersions: {},
      input: { birthDate: '1990-05-10', gender: 'male', identifier: `CM-SYN-${randomUUID()}`, name } })).data.patient
    const visit = registrationResponseSchema.parse(await post('/api/his/v1/registrations/actions/register', registrar,
      { expectedVersions: { [`Patient/${patient.id}`]: patient.versionId }, input: { departmentId: 'department-general-medicine',
        locationId: 'location-outpatient', patientId: patient.id, visitDate: '2026-08-24', visitTypeId: 'visit-general' } })).data
    const triage = triageResponseSchema.parse(await post(`/api/his/v1/encounters/${visit.encounterId}/actions/record-triage`, nurse,
      { expectedVersions: { [`Encounter/${visit.encounterId}`]: '1', [`Task/${visit.queueTaskId}`]: '1' }, input: {
        acuityCode: 'level-3', bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 }, chiefComplaint: '合成随访查体',
        oxygenSaturationPct: 98, pulseBpm: 72, respirationBpm: 18, temperatureC: 36.5 } })).data
    const started = startVisitResponseSchema.parse(await post(`/api/his/v1/encounters/${visit.encounterId}/actions/start-first-visit`, doctor,
      { expectedVersions: { [`Encounter/${visit.encounterId}`]: '2', [`Task/${triage.doctorTaskId}`]: '1' }, input: {} })).data
    const queue = doctorQueueSchema.parse(await (await app.app.request('/api/his/v1/doctor/queue', { headers: { cookie: doctor } })).json())
    const caseId = queue.items.find(item => item.encounterId === visit.encounterId)!.caseId
    const claim = { taskEpoch: randomUUID(), activeSection: 'record', version: 1, viewId: 'consultation', viewRevision: 'live-benchmark',
      ui: { status: 'ready' }, selection: { kind: 'case', id: caseId, version: started.encounterVersion } }
    const page = await context.newPage()
    await page.goto(`${origin}/consultation`)
    await page.getByRole('tab', { name: '在诊', exact: true }).click()
    await page.getByText(name, { exact: true }).first().click()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await page.getByLabel('体格检查', { exact: true }).waitFor()
    cases.push({ caseId, claim, page })
    console.log(JSON.stringify({ phase: 'case-ready', caseIndex: index }))
  }
  console.log(JSON.stringify({ phase: 'started', seconds, caseCount, workload, intervalMs: 3000, model }))
  let observing = true
  const observer = (async () => {
    while (observing) {
      await Promise.all(cases.map(async ({ page, caseId }, index) => {
        const values = await page.locator('textarea').evaluateAll(nodes => nodes.map(node => node instanceof HTMLTextAreaElement ? node.value : ''))
        const rows = z.array(z.object({ current_text: z.string(), facts_json: z.string().nullable() })).parse(app.database.driver.prepare(
          "SELECT current_text, facts_json FROM consultation_history_addition WHERE case_id = ? AND status = 'applied'").all(caseId))
        for (const row of rows) {
          if (!values.some(value => value.includes(row.current_text))) continue
          const facts = row.facts_json === null ? [] : z.array(z.object({ sources: z.array(z.object({ sourceTurnId: z.string() })) })).parse(JSON.parse(row.facts_json))
          for (const source of facts.flatMap(fact => fact.sources)) {
            const sample = samples.find(sample => sample.caseIndex === index && sample.sourceId === source.sourceTurnId)
            if (sample !== undefined) sample.visibleAt ??= Date.now()
          }
        }
      }))
      await delay(100)
    }
  })()
  const start = Date.now()
  for (let round = 0; round < Math.floor(seconds / 3); round++) {
    await delay(Math.max(0, start + round * 3000 - Date.now()))
    await Promise.all(cases.map(async ({ claim }, index) => {
      const binding = agentPageContextBindingSchema.parse(await post('/api/agent/v1/page-contexts', doctor, { claim,
        client: { id: `benchmark-client-${index}`, revision: round + 1 }, dshSessionId: `benchmark-session-${index}` }))
      const content = workload === 'repeated-exam' ? `第${round + 1}次查体：心律齐。`
        : `第${round + 1}分钟复测心率${60 + round % 40}次/分。`
      const permitted = z.object({ permit: z.string() }).parse(await post('/api/agent/v1/doctor-tasks/permit', doctor,
        { contextToken: binding.token, content, rpcId: `benchmark-${index}-${round}` }))
      const payload = { ...JSON.parse(Buffer.from(permitted.permit.split('.')[0]!, 'base64url').toString()),
        purpose: 'clinmesh-doctor-recording-source', version: 1, messageId: `benchmark-${index}-${round}`, recordedAt: new Date().toISOString() }
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
      const saved = doctorRecordingSourceResponseSchema.parse(await post('/api/agent/v1/doctor-inputs', doctor, { contextToken: binding.token,
        content, sourceProof: `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}` })).data
      const timing = z.object({ saved_at: z.string() }).parse(app.database.driver.prepare(
        'SELECT saved_at FROM consultation_recording_source WHERE source_id = ?').get(saved.sourceId))
      samples.push({ caseIndex: index, sourceId: saved.sourceId, savedAt: Date.parse(timing.saved_at) })
    }))
    if (round % 20 === 19) {
      const queued = z.object({ count: z.number() }).parse(app.database.driver.prepare(
        "SELECT count(*) AS count FROM consultation_recording_job WHERE status = 'queued'").get()).count
      const progress = { elapsedSeconds: (Date.now() - start) / 1000,
        saved: samples.length, visible: samples.filter(sample => sample.visibleAt !== undefined).length, queued }
      backlog.push(progress)
      console.log(JSON.stringify({ phase: 'progress', ...progress }))
    }
  }
  await delay(15_000)
  observing = false
  await observer
  const percentile = (values: number[], p: number) => values.length === 0 ? null : values.toSorted((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? null
  const latencies = samples.flatMap(sample => sample.visibleAt === undefined ? [] : [sample.visibleAt - sample.savedAt])
  const results = app.database.driver.prepare('SELECT status, result, error_code, count(*) AS count FROM consultation_recording_job GROUP BY status, result, error_code').all()
  const batches = app.database.driver.prepare('SELECT timings_json FROM consultation_recording_batch').all()
  const verification = app.database.driver.prepare('SELECT status, count(*) AS count, avg(elapsed_ms) AS averageMs FROM consultation_recording_verification GROUP BY status').all()
  const report = { timestamp: new Date().toISOString(), model, device: { platform: process.platform, cpu: cpus()[0]?.model, cores: cpus().length },
    seconds, caseCount, workload, intervalMs: 3000, sourceCount: samples.length, visibleCount: latencies.length, missingVisibleCount: samples.length - latencies.length,
    p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95), results, batches, verification, backlog,
    perCase: cases.map((_, index) => { const subset = samples.filter(sample => sample.caseIndex === index)
      return { caseIndex: index, sources: subset.length, visible: subset.filter(sample => sample.visibleAt !== undefined).length } }) }
  await writeFile(resolve(process.argv[4] ?? '.cache/issue-215-live-benchmark.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ...report, batches: undefined }))
  // A non-zero exit keeps a measured failure from looking like passed acceptance.
  if (latencies.length !== samples.length || report.p50Ms === null || report.p50Ms > 3000 || report.p95Ms === null || report.p95Ms > 8000) process.exitCode = 1
} finally {
  await browser.close()
  if ('closeAllConnections' in server) server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await runtime?.close()
  await rm(directory, { recursive: true, force: true })
}
