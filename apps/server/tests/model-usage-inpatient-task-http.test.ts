import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { modelUsageListSchema, modelUsageOverviewSchema, unknownModelTokenUsage } from '@clinmesh/contracts/model-usage'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { CommandExecutor } from '../src/application/command-executor.ts'
import { ModelUsageService } from '../src/application/model-usage-service.ts'
import { openClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'
import { signIn } from './fixtures/consultation.ts'
import { addSecondaryInpatientWard } from './fixtures/inpatient-secondary-ward.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.useRealTimers()
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-task-usage-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const options = {
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'),
    demoPassword: 'Synthetic-Demo-Password-2026!', migrationMode: 'apply' as const, trustedOrigins: ['http://localhost'],
  }
  let runtime = await createClinMeshRuntime(options)
  let usage = new ModelUsageService(runtime.database, new CommandExecutor(runtime.database, runtime.fhir))
  cleanups.push(() => runtime.close())
  const admin = await signIn(runtime, 'admin@demo.clinmesh.local')
  const registrar = await signIn(runtime, 'registrar@demo.clinmesh.local')
  const doctor = await signIn(runtime, 'inpatient-doctor@demo.clinmesh.local')
  const nurse = await signIn(runtime, 'ward-nurse@demo.clinmesh.local')
  const outpatient = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const read = (path: string, cookie = doctor) => runtime.app.request(`/api/model-usage${path}`, { headers: { cookie } })
  const command = (cookie: string, path: string, body: unknown) => runtime.app.request(path, {
    method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify(body),
  })
  const created = await command(registrar, '/api/his/v1/patients', { expectedVersions: {}, input: {
    name: '合成用量患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}`,
  } })
  const patient = z.object({ data: z.object({ patient: z.object({ id: z.string(), versionId: z.string() }) }) }).parse(await created.json()).data.patient
  const registered = inpatientCommandResponseSchema.parse(await (await command(registrar, '/api/his/v1/inpatient/admissions', { input: {
    expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000,
  } })).json()).data.admission
  const admission = inpatientCommandResponseSchema.parse(await (await command(nurse, `/api/his/v1/inpatient/admissions/${registered.id}/receive`, {
    input: { encounterVersion: registered.versionId, bedId: 'bed-general-1' },
  })).json()).data.admission
  const actor = (await runtime.identity.resolveSessionContext(new Headers({ cookie: doctor }))).actor
  const record = (taskId: string, stage: string, caseId = admission.id, feature = 'investigation_service_result',
    status: 'succeeded' | 'unknown' | 'in-flight' = 'succeeded') => {
    const id = usage.begin({ context: { workspaceId: actor.workspaceId, epoch: actor.epoch, actorId: actor.actorId,
      practitionerRoleId: actor.practitionerRoleId!, taskId, caseId, encounterId: caseId, stage, trigger: 'automatic', sources: [] },
    feature, provider: 'synthetic', model: 'synthetic', outputLimit: null, kind: 'initial' })
    if (status !== 'in-flight') usage.settle(id, { status, dispatch: status === 'unknown' ? 'unknown' : 'dispatched', usage: status === 'unknown' ? unknownModelTokenUsage : {
      inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 30, reasoningOutputTokens: 5, mapping: 'openai-v1',
    } })
    return id
  }
  return { get runtime() { return runtime }, get usage() { return usage }, read, record, admission, admin, doctor, nurse, outpatient, registrar,
    async restart(legacyDaily = false) {
      await runtime.close()
      if (legacyDaily) {
        const database = openClinMeshDatabase({ databasePath: options.databasePath, busyTimeoutMs: 5000 })
        try {
          const retention = readFileSync('drizzle/0076_model-usage-retention.sql', 'utf8')
          const daily = retention.slice(retention.indexOf('CREATE TABLE model_usage_daily'), retention.indexOf('-- Only necessary'))
          database.driver.exec(`DROP INDEX model_usage_daily_workspace_date;
            ALTER TABLE model_usage_daily RENAME TO model_usage_daily_current;
            ${daily}
            ${readFileSync('drizzle/0077_model-usage-token-breakdown.sql', 'utf8')}
            INSERT INTO model_usage_daily
              (workspace_id, epoch, date, case_id, feature, provider, requested_model, actual_model, status,
                requests, unknown_requests, known_tokens, unknown_token_requests, cny_micro, unpriced_requests,
                known_input_tokens, known_output_tokens, unknown_input_token_requests, unknown_output_token_requests)
            SELECT workspace_id, epoch, date, case_id, feature, provider, requested_model, actual_model, status,
              requests, unknown_requests, known_tokens, unknown_token_requests, cny_micro, unpriced_requests,
              known_input_tokens, known_output_tokens, unknown_input_token_requests, unknown_output_token_requests
            FROM model_usage_daily_current;
            DROP TABLE model_usage_daily_current;
            DELETE FROM schema_migration WHERE migration_id = '0097_model-usage-task-dimensions.sql'`)
        } finally { database.close() }
      }
      runtime = await createClinMeshRuntime(options)
      usage = new ModelUsageService(runtime.database, new CommandExecutor(runtime.database, runtime.fhir))
    } }
}

it('任务用量筛选同时绑定住院、任务与当前病例读取权限，原工作区总览保持兼容', async () => {
  const f = await setup()
  await addSecondaryInpatientWard(f.runtime)
  const id = f.record('followup-one', 'preoperative-generation')
  f.record('followup-two', 'preoperative-generation')
  f.record('followup-one', 'intraoperative-generation', 'other-admission')
  const query = `caseId=${f.admission.id}&taskId=followup-one`
  const response = await f.read(`/overview?${query}`)
  expect(response.status, await response.clone().text()).toBe(200)
  expect(modelUsageOverviewSchema.parse(await response.json()).totals).toMatchObject({ requests: 1, knownTokens: 120 })
  for (const cookie of [f.doctor, f.nurse]) {
    const list = modelUsageListSchema.parse(await (await f.read(`/requests?${query}`, cookie)).json())
    expect(list).toMatchObject({ total: 1, items: [{ id }] })
  }
  for (const cookie of [f.outpatient, f.registrar]) {
    expect(modelUsageOverviewSchema.parse(await (await f.read(`/overview?${query}`, cookie)).json()).totals.requests).toBe(0)
    expect(modelUsageListSchema.parse(await (await f.read(`/requests?${query}`, cookie)).json())).toEqual({ total: 0, items: [] })
  }
  expect((await f.read('/overview?taskId=followup-one')).status).toBe(400)
  expect((await f.read('/requests?stage=preoperative-generation')).status).toBe(400)
  expect(modelUsageOverviewSchema.parse(await (await f.read('/overview', f.registrar)).json()).totals.requests).toBe(3)
  expect((await f.runtime.app.request('/api/auth/role', { method: 'POST', headers: {
    cookie: f.doctor, origin: 'http://localhost', 'content-type': 'application/json',
  }, body: JSON.stringify({ practitionerRoleId: 'practitioner-role-inpatient-doctor-surgery' }) })).status).toBe(200)
  expect(modelUsageOverviewSchema.parse(await (await f.read(`/overview?${query}`)).json()).totals.requests).toBe(0)
  expect(modelUsageListSchema.parse(await (await f.read(`/requests?${query}`)).json())).toEqual({ total: 0, items: [] })
})

it('未知与在途请求保留已知分项及不完整状态，过期和重启不把未知消费归零', async () => {
  const f = await setup()
  const now = Date.now()
  vi.setSystemTime(new Date(now - 91 * 24 * 60 * 60 * 1000))
  const partial = f.record('followup-unknown', 'intraoperative-generation', f.admission.id, 'inpatient_drg_recommendation', 'in-flight')
  f.usage.checkpoint(partial, { ...unknownModelTokenUsage, inputTokens: 100, cachedInputTokens: 30, mapping: 'openai-v1' })
  f.record('followup-unknown', 'postoperative-verification', f.admission.id, 'inpatient_drg_verification', 'unknown')
  vi.setSystemTime(now)
  const query = `caseId=${f.admission.id}&taskId=followup-unknown`
  const totals = async () => modelUsageOverviewSchema.parse(await (await f.read(`/overview?${query}`)).json()).totals
  expect(await totals()).toMatchObject({ requests: 2, inFlight: 1, unknownRequests: 1, knownTokens: 100,
    knownInputTokens: 100, knownOutputTokens: 0, unknownInputTokenRequests: 1, unknownOutputTokenRequests: 2,
    unknownTokenRequests: 2, unpricedRequests: 2, cny: null })
  expect(modelUsageListSchema.parse(await (await f.read(`/requests?${query}`)).json()).total).toBe(2)
  await f.restart()
  expect(await totals()).toMatchObject({ requests: 2, inFlight: 0, unknownRequests: 2, knownTokens: 100,
    unknownTokenRequests: 2, unpricedRequests: 2, cny: null })
})

it('住院生成与独立核验分别入账，可按围术期步骤筛选且同用病例权限', async () => {
  const f = await setup()
  f.record('followup-drg', 'preoperative-generation', f.admission.id, 'inpatient_drg_recommendation')
  f.record('followup-drg', 'preoperative-verification', f.admission.id, 'inpatient_drg_verification')
  const query = `caseId=${f.admission.id}&taskId=followup-drg`
  const all = modelUsageListSchema.parse(await (await f.read(`/requests?${query}`)).json())
  expect(all.total).toBe(2)
  expect(all.items.map(item => item.feature).sort()).toEqual(['inpatient_drg_recommendation', 'inpatient_drg_verification'])
  const generation = modelUsageOverviewSchema.parse(await (await f.read(`/overview?${query}&stage=preoperative-generation`)).json())
  expect(generation.totals).toMatchObject({ requests: 1, knownTokens: 120, knownInputTokens: 100, knownOutputTokens: 20 })
  expect(modelUsageListSchema.parse(await (await f.read(`/requests?${query}`, f.outpatient)).json())).toEqual({ total: 0, items: [] })
})

it('明细到期后仍保留本任务各阶段累计，重启和重复清理不清零或双计', async () => {
  const f = await setup()
  const now = Date.now()
  vi.setSystemTime(new Date(now - 91 * 24 * 60 * 60 * 1000))
  f.record('followup-retained', 'preoperative-generation', f.admission.id, 'inpatient_drg_recommendation')
  f.record('followup-retained', 'postoperative-verification', f.admission.id, 'inpatient_drg_verification')
  f.record('another-followup', 'preoperative-generation', f.admission.id, 'inpatient_drg_recommendation')
  const query = `caseId=${f.admission.id}&taskId=followup-retained`
  const before = modelUsageOverviewSchema.parse(await (await f.read(`/overview?${query}`)).json())
  expect(before.totals).toMatchObject({ requests: 2, knownTokens: 240, knownInputTokens: 200, knownOutputTokens: 40, cny: null, unpricedRequests: 2 })
  vi.setSystemTime(now)
  expect(modelUsageListSchema.parse(await (await f.read(`/requests?${query}`)).json())).toEqual({ total: 0, items: [] })
  expect(modelUsageOverviewSchema.parse(await (await f.read(`/overview?${query}`)).json())).toEqual(before)
  await f.restart()
  expect(modelUsageOverviewSchema.parse(await (await f.read(`/overview?${query}`)).json())).toEqual(before)
  expect(modelUsageOverviewSchema.parse(await (await f.read(`/overview?${query}&stage=postoperative-verification`)).json()).totals)
    .toMatchObject({ requests: 1, knownTokens: 120, knownInputTokens: 100, knownOutputTokens: 20 })
})

it('非空旧日汇总升级保留原消费与缺价，不补造已清理请求的任务和阶段', async () => {
  const f = await setup()
  const now = Date.now()
  vi.setSystemTime(new Date(now - 91 * 24 * 60 * 60 * 1000))
  f.record('legacy-task', 'preoperative-generation', f.admission.id, 'inpatient_drg_recommendation')
  vi.setSystemTime(now)
  const before = modelUsageOverviewSchema.parse(await (await f.read('/overview', f.admin)).json())
  expect(before.totals).toMatchObject({ requests: 1, knownTokens: 120, knownInputTokens: 100, knownOutputTokens: 20, unpricedRequests: 1, cny: null })
  await f.restart(true)
  expect(modelUsageOverviewSchema.parse(await (await f.read('/overview', f.admin)).json())).toEqual(before)
  expect(modelUsageOverviewSchema.parse(await (await f.read(`/overview?caseId=${f.admission.id}&taskId=legacy-task`)).json()).totals.requests).toBe(0)
})
