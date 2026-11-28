import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { modelUsageListSchema, modelUsageOverviewSchema } from '@clinmesh/contracts/model-usage'
import { laboratoryServiceSnapshotSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientInvestigationResponseSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { OpenAIChatCompletionsClient } from '../src/infrastructure/ai/openai-chat-completions.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from './fixtures/consultation.ts'
import { WorkspaceRepository } from '../src/infrastructure/sqlite/workspace-repository.ts'
import { addSecondaryInpatientWard } from './fixtures/inpatient-secondary-ward.ts'

const dispose: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of dispose.splice(0).reverse()) await close() })

async function setup(extra: Partial<Parameters<typeof createClinMeshRuntime>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-model-usage-'))
  dispose.push(() => rm(directory, { recursive: true, force: true }))
  const options = {
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters',
    databasePath: join(directory, 'clinmesh.sqlite'), demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply' as const, trustedOrigins: ['http://localhost'],
    ...extra,
  }
  let runtime = await createClinMeshRuntime(options)
  dispose.push(() => runtime.close())
  return { directory, get runtime() { return runtime }, restart: async (databasePath = options.databasePath) => {
    await runtime.close(); runtime = await createClinMeshRuntime({ ...options, databasePath })
  } }
}

it('opens an empty unlimited overview for members and requires authentication', async () => {
  const { runtime } = await setup()
  const anonymous = await runtime.app.request('/api/model-usage/overview')
  expect(anonymous.status).toBe(401)
  const cookie = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const response = await runtime.app.request('/api/model-usage/overview', { headers: { cookie } })
  expect(response.status).toBe(200)
  expect(modelUsageOverviewSchema.parse(await response.json())).toMatchObject({
    coverage: 'server-direct-bridge-and-host', totals: { requests: 0, knownTokens: 0, cny: null },
    policy: { enabled: true, requests: null, tokens: null, cny: null },
  })
})

it('meters actual direct requests, keeps actual model across restart and restricts administrative details', async () => {
  let dispatched = 0
  const fixture = await setup({ syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'configured-model',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic-private-key', baseUrl: 'http://[::1]:11434/v1',
      fetch: async () => { dispatched++; return Response.json({ id: 'synthetic-request-1', model: 'actual-model-v1',
        choices: [{ message: { content: JSON.stringify(persona) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 5 } },
      }) },
    }),
  })
  await startConsultationCase(fixture.runtime)
  const admin = await signIn(fixture.runtime, 'admin@demo.clinmesh.local')
  const doctor = await signIn(fixture.runtime, 'doctor@demo.clinmesh.local')
  const read = async (path: string, cookie = admin) => fixture.runtime.app.request(path, { headers: { cookie } })
  const overview = modelUsageOverviewSchema.parse(await (await read('/api/model-usage/overview', doctor)).json())
  const split = { knownInputTokens: 100, knownOutputTokens: 20, unknownInputTokenRequests: 0, unknownOutputTokenRequests: 0 }
  expect(overview.totals).toMatchObject({ requests: 1, knownTokens: 120, unknownTokenRequests: 0, unpricedRequests: 1, cny: null, ...split })
  expect(dispatched).toBe(1)
  const records = modelUsageListSchema.parse(await (await read('/api/model-usage/requests')).json())
  expect(records.total).toBe(1)
  expect(records.items[0]).toMatchObject({ provider: '[::1]', actualModel: 'actual-model-v1', requestedModel: 'configured-model',
    feature: 'patient_persona', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30, reasoningOutputTokens: 5, totalTokens: 120 },
    cost: { cny: null, status: 'price-not-configured' } })
  const id = records.items[0]!.id
  expect(modelUsageListSchema.parse(await (await read('/api/model-usage/requests', doctor)).json())).toEqual({ items: [], total: 0 })
  expect((await read(`/api/model-usage/requests/${id}`, doctor)).status).toBe(404)
  expect(JSON.stringify(records)).not.toContain('synthetic-private-key')
  expect(JSON.stringify(records)).not.toContain(persona.chiefComplaint)
  expect((await read('/api/model-usage/requests?limit=100000')).status).toBe(400)
  expect(modelUsageListSchema.parse(await (await read('/api/model-usage/requests?model=other-model')).json()).total).toBe(0)
  await fixture.restart()
  const recovered = modelUsageListSchema.parse(await (await read('/api/model-usage/requests')).json())
  expect(recovered.items[0]).toEqual(records.items[0])
  expect(dispatched).toBe(1)
  // Real timestamps remain UTC in storage; date filters and trend use Asia/Shanghai.
  const midnightRecord = { ...recovered.items[0]!, startedAt: '2026-10-20T16:30:00.000Z' }
  fixture.runtime.database.driver.prepare('UPDATE model_usage_attempt SET started_at = ?, record_json = ? WHERE attempt_id = ?')
    .run(midnightRecord.startedAt, JSON.stringify(midnightRecord), id)
  const localDay = modelUsageOverviewSchema.parse(await (await read('/api/model-usage/overview?from=2026-10-21&to=2026-10-21')).json())
  expect(localDay.totals.requests).toBe(1)
  expect(localDay.trend).toEqual([{ date: '2026-10-21', requests: 1, knownTokens: 120, ...split }])
  expect(modelUsageListSchema.parse(await (await read('/api/model-usage/requests?from=2026-10-20&to=2026-10-20')).json()).total).toBe(0)
})

it('requires durable accounting before dispatch even when every limit is unlimited', async () => {
  let dispatched = 0
  const { runtime } = await setup({ syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'synthetic-model',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid',
      fetch: async () => { dispatched++; return Response.json({ choices: [{ message: { content: JSON.stringify(persona) } }] }) },
    }),
  })
  // Storage-boundary failure injection; no private service or request hook is replaced.
  runtime.database.driver.exec(`CREATE TRIGGER synthetic_usage_failure BEFORE INSERT ON model_usage_attempt
    BEGIN SELECT RAISE(ABORT, 'synthetic ledger unavailable'); END`)
  await expect(startConsultationCase(runtime)).rejects.toThrow('Persona generation failed')
  expect(dispatched).toBe(0)
  const admin = await signIn(runtime, 'admin@demo.clinmesh.local')
  const list = await runtime.app.request('/api/model-usage/requests', { headers: { cookie: admin } })
  expect(modelUsageListSchema.parse(await list.json())).toEqual({ items: [], total: 0 })
})

it('retains per-attempt unknown usage and cross-Epoch summaries without exposing historical details to members', async () => {
  let dispatched = 0
  const { runtime } = await setup({ syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'synthetic-model',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid',
      fetch: async () => { dispatched++; return Response.json({ model: 'actual-synthetic',
        choices: [{ message: { content: JSON.stringify(dispatched < 3 ? {} : persona) } }],
      }) },
    }),
  })
  await startConsultationCase(runtime)
  const admin = await signIn(runtime, 'admin@demo.clinmesh.local')
  const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const list = modelUsageListSchema.parse(await (await runtime.app.request('/api/model-usage/requests', { headers: { cookie: admin } })).json())
  expect(dispatched).toBe(3)
  expect(list.total).toBe(3)
  expect(new Set(list.items.map(item => item.id)).size).toBe(3)
  expect(list.items.every(item => item.usage.totalTokens === null && item.cost.cny === null)).toBe(true)
  expect(list.items.filter(item => item.kind === 'format-repair')).toHaveLength(2)
  const reset = await runtime.app.request('/api/sim/v1/scenario-runs/scenario-run-1/actions/reset', { method: 'POST',
    headers: { cookie: admin, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: '{}' })
  expect(reset.status, await reset.text()).toBe(200)
  const overview = modelUsageOverviewSchema.parse(await (await runtime.app.request('/api/model-usage/overview', { headers: { cookie: doctor } })).json())
  expect(overview.totals).toMatchObject({ requests: 3, unknownTokenRequests: 3, knownTokens: 0, cny: null })
  expect(modelUsageListSchema.parse(await (await runtime.app.request('/api/model-usage/requests', { headers: { cookie: admin } })).json()).total).toBe(3)
  expect((await runtime.app.request(`/api/model-usage/requests/${list.items[0]!.id}`, { headers: { cookie: doctor } })).status).toBe(404)
})

it('uses current case responsibility for details and isolates every query from other Workspaces', async () => {
  let dispatched = 0
  const { runtime } = await setup({ syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'synthetic-model', consultationModel: 'synthetic-model',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid',
      fetch: async () => { dispatched++; return Response.json({ model: 'actual-synthetic',
        choices: [{ message: { content: JSON.stringify(dispatched === 1 ? persona : { reply: '站起来的时候会晕。' }) } }],
      }) },
    }),
  })
  const started = await startConsultationCase(runtime)
  const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const admin = await signIn(runtime, 'admin@demo.clinmesh.local')
  const ask = await runtime.app.request(`/api/his/v1/encounters/${started.encounterId}/actions/ask-consultation-question`, {
    method: 'POST', headers: { cookie: doctor, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ expectedVersions: { [`Encounter/${started.encounterId}`]: started.encounterVersion, [`Task/${started.doctorTaskId}`]: '1' },
      input: { expectedConsultationVersion: 2, message: '什么时候晕？' } }),
  })
  expect(ask.status, await ask.text()).toBe(200)
  const listFor = async (cookie: string) => modelUsageListSchema.parse(await (await runtime.app.request('/api/model-usage/requests', { headers: { cookie } })).json())
  const clinical = await listFor(doctor)
  expect(clinical.items.map(item => item.feature)).toEqual(['patient_dialogue_reply'])
  const id = clinical.items[0]!.id
  expect((await runtime.app.request(`/api/model-usage/requests/${id}`, { headers: { cookie: doctor } })).status).toBe(200)
  runtime.database.driver.prepare('DELETE FROM outpatient_case_responsibility WHERE workspace_id = ? AND epoch = ? AND case_id = ?')
    .run('workspace-demo', 'epoch-1', started.outpatientCaseId)
  expect((await listFor(doctor)).total).toBe(0)
  expect((await runtime.app.request(`/api/model-usage/requests/${id}`, { headers: { cookie: doctor } })).status).toBe(404)

  // A foreign Workspace fixture at the database boundary must not enter either query.
  new WorkspaceRepository(runtime.database).install({ workspaceId: 'workspace-other', workspaceName: 'Synthetic other',
    epoch: 'epoch-other', scenarioId: 'synthetic-other', scenarioRunId: 'run-other' })
  const foreign = { ...clinical.items[0]!, id: randomUUID(), context: { ...clinical.items[0]!.context, workspaceId: 'workspace-other', epoch: 'epoch-other' } }
  runtime.database.driver.prepare(`INSERT INTO model_usage_attempt
    (attempt_id, workspace_id, epoch, case_id, feature, provider, requested_model, actual_model, status, started_at, record_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(foreign.id, foreign.context.workspaceId, foreign.context.epoch,
      foreign.context.caseId ?? null, foreign.feature, foreign.provider, foreign.requestedModel, foreign.actualModel, foreign.status, foreign.startedAt, JSON.stringify(foreign))
  expect((await listFor(admin)).total).toBe(2)
  const overview = modelUsageOverviewSchema.parse(await (await runtime.app.request('/api/model-usage/overview', { headers: { cookie: doctor } })).json())
  expect(overview.totals.requests).toBe(2)
  expect((await runtime.app.request(`/api/model-usage/requests/${foreign.id}`, { headers: { cookie: admin } })).status).toBe(404)
})

it('按当前住院科室和病区授权模型明细，岗位切换和 Epoch 重置立即撤销访问', async () => {
  const generated = { conclusion: '合成检查结果正常。', results: [{ code: 'synthetic-ip-result', value: 7,
    interpretation: 'normal', referenceRange: { low: 4, high: 10, text: '4-10' },
    unit: { system: 'http://unitsofmeasure.org', code: '1', display: '1' } }] }
  let dispatched = 0
  const { runtime } = await setup({ syntheaProvider: new StubSyntheaProvider(), patientPersonaModel: 'synthetic-model', investigationModel: 'synthetic-model',
    chatCompletionsProvider: new OpenAIChatCompletionsClient({ apiKey: 'synthetic-only', baseUrl: 'https://synthetic.invalid',
      fetch: async () => Response.json({ model: 'synthetic-model', choices: [{ message: {
        content: JSON.stringify(++dispatched === 1 ? persona : generated),
      } }] }),
    }),
  })
  const started = await startConsultationCase(runtime)
  await addSecondaryInpatientWard(runtime)
  const admin = started.adminCookie
  const registrar = await signIn(runtime, 'registrar@demo.clinmesh.local')
  const doctor = await signIn(runtime, 'inpatient-doctor@demo.clinmesh.local')
  const nurse = await signIn(runtime, 'ward-nurse@demo.clinmesh.local')
  const outpatient = await signIn(runtime, 'doctor@demo.clinmesh.local')
  const request = (cookie: string, path: string, input?: unknown) => runtime.app.request(path, input === undefined
    ? { headers: { cookie } }
    : { method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ input }) })
  const encounter = z.object({ subject: z.object({ reference: z.string() }) }).parse(await (await request(admin, `/fhir/R5/Encounter/${started.encounterId}`)).json())
  const patient = fhirResourceSchema.parse(await (await request(admin, `/fhir/R5/${encounter.subject.reference}`)).json())
  const registered = inpatientCommandResponseSchema.parse(await (await request(registrar, '/api/his/v1/inpatient/admissions', {
    expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.meta!.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000,
  })).json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${registered.id}`
  const admission = inpatientCommandResponseSchema.parse(await (await request(nurse, `${path}/receive`, {
    encounterVersion: registered.versionId, bedId: 'bed-general-1',
  })).json()).data.admission
  const concept = { id: 'synthetic-ip-result', system: 'urn:synthetic:lab', code: 'synthetic-ip-result', display: '合成住院项目', version: '1', sourceLocator: 'synthetic:ip-result' }
  const service = laboratoryServiceSnapshotSchema.parse({ id: 'synthetic-ip-lab', version: 1, serviceKind: 'laboratory', doctorOrderable: true,
    localCode: 'SYN-IP-LAB', nameZh: '合成住院检验', referenceConcept: concept, referenceReleaseId: 'synthetic-release', componentServiceIds: [],
    executingDepartmentId: 'department-laboratory', allowedIndicationCodes: ['clinical-assessment'], specimen: { code: '119297000', display: '血液标本' }, tatMinutes: 20, priceFen: 800,
    reportDefinition: { conclusionTemplate: '合成检查结果。', results: [{ referenceConcept: concept, valueType: 'quantity', referenceRange: generated.results[0]!.referenceRange, unit: generated.results[0]!.unit }] },
  })
  runtime.database.driver.prepare('INSERT INTO hospital_service_catalog(workspace_id,epoch,service_id,code,name_zh,name_en,version,active,config_json) VALUES(?,?,?,?,?,?,1,1,?)')
    .run('workspace-demo', 'epoch-1', service.id, service.localCode, service.nameZh, service.nameZh, JSON.stringify({ laboratoryService: service,
      billingUnit: { display: '项目' }, availableScopes: ['inpatient'], chargeDefinition: { id: 'synthetic-ip-charge', currency: 'CNY', priceFen: 800 } }))
  const issueResponse = await request(doctor, `${path}/investigations/issue`, {
    encounterVersion: admission.versionId, catalogVersion: 1, selection: { kind: 'laboratory', catalogItemId: service.id, indicationCode: 'clinical-assessment' },
  })
  expect(issueResponse.status, await issueResponse.clone().text()).toBe(200)
  const issued = inpatientInvestigationResponseSchema.parse(await issueResponse.json()).data.laboratoryRequests[0]!
  expect((await request(nurse, `${path}/investigations/send`, { requestId: issued.id, expectedRequestVersion: issued.version,
    serviceRequestVersion: issued.serviceRequestVersion, taskVersion: issued.taskVersion })).status).toBe(200)
  while (await runtime.dispatcher.dispatchOnce() !== undefined) { /* drain synthetic outbox */ }
  const reports = inpatientInvestigationsSchema.parse(await (await request(doctor, `${path}/investigations`)).json())
  expect(reports.laboratoryRequests[0]).toMatchObject({ status: 'reported', report: { results: [{ value: 7 }] } })
  const list = async (cookie: string) => modelUsageListSchema.parse(await (await request(cookie, '/api/model-usage/requests?limit=1')).json())
  const adminList = await list(admin)
  expect(adminList.total).toBe(2)
  const id = adminList.items[0]!.id
  expect(adminList.items[0]).toMatchObject({ feature: 'investigation_service_result', context: { caseId: admission.id } })
  for (const cookie of [doctor, nurse]) {
    expect(await list(cookie)).toMatchObject({ total: 1, items: [{ id }] })
    expect((await request(cookie, `/api/model-usage/requests/${id}`)).status).toBe(200)
  }
  for (const cookie of [outpatient, registrar]) {
    expect(await list(cookie)).toEqual({ total: 0, items: [] })
    expect((await request(cookie, `/api/model-usage/requests/${id}`)).status).toBe(404)
  }
  const selectRole = (cookie: string, practitionerRoleId: string) => runtime.app.request('/api/auth/role', {
    method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ practitionerRoleId }),
  })
  for (const [cookie, role] of [[doctor, 'inpatient-doctor'], [nurse, 'ward-nurse']] as const) {
    expect((await selectRole(cookie, `practitioner-role-${role}-surgery`)).status).toBe(200)
    expect(await list(cookie)).toEqual({ total: 0, items: [] })
    expect((await request(cookie, `/api/model-usage/requests/${id}`)).status).toBe(404)
    expect((await selectRole(cookie, `practitioner-role-${role}`)).status).toBe(200)
  }
  const reset = await runtime.app.request('/api/sim/v1/scenario-runs/scenario-run-1/actions/reset', { method: 'POST',
    headers: { cookie: admin, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: '{}' })
  expect(reset.status).toBe(200)
  expect((await list(admin)).total).toBe(2)
  for (const cookie of [doctor, nurse]) {
    expect(await list(cookie)).toEqual({ total: 0, items: [] })
    expect((await request(cookie, `/api/model-usage/requests/${id}`)).status).toBe(404)
  }
})
