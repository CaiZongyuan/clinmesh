import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  agentPageBindingRevision, agentPageContextBindingSchema, agentToolCatalog,
  agentToolAuthorizationResponseSchema,
  type AgentPageContextBinding,
} from '@clinmesh/contracts/agent'
import { createPatientResponseSchema, laboratoryServiceSnapshotSchema } from '@clinmesh/contracts/his'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalResponseSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientDischargeResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientInvestigationsSchema, inpatientInvestigationResponseSchema } from '@clinmesh/contracts/inpatient-investigations'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { acuteBronchitis, caseBundle, createImagingRuntime, generateCase, startOutpatientVisit } from './fixtures/imaging-scenario.ts'
import { addSecondaryInpatientWard } from './fixtures/inpatient-secondary-ward.ts'

const secret = 'test-dsh-bridge-secret-with-at-least-32-characters'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })

async function setup(withReports = false) {
  const base = caseBundle({ gender: 'male', index: [{ ...acuteBronchitis, resourceType: 'Condition' }], name: '合成住院报告患者' })
  const source = withReports ? await createImagingRuntime([{ ...base, entry: [...base.entry, {
    fullUrl: 'urn:uuid:agent-wbc-source', resource: {
      resourceType: 'Observation', id: 'agent-wbc-source', status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '6690-2', display: '白细胞计数' }] },
      subject: { reference: 'urn:uuid:patient' }, encounter: { reference: 'urn:uuid:index-encounter' },
      effectiveDateTime: '2026-06-01T10:10:00+08:00',
      valueQuantity: { value: 7.2, unit: '10^9/L', system: 'http://unitsofmeasure.org', code: '10*9/L' },
    },
  }] }], { persona: true, assets: false, catalog: false }) : undefined
  const directory = source?.directory ?? await mkdtemp(join(tmpdir(), 'clinmesh-agent-inpatient-'))
  const password = source?.runtimeOptions.demoPassword ?? `Test-${randomUUID()}-Aa1!`
  const runtime = source?.runtime ?? await createClinMeshRuntime({
    authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
    databasePath: join(directory, 'hospital.sqlite'), demoPassword: password,
    dshBridgeSecret: secret, migrationMode: 'apply', trustedOrigins: ['http://localhost'],
  })
  cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true }) })
  const cookies = new Map<string, string>()
  async function request(role: string, path: string, body?: unknown, key = randomUUID()) {
    if (!cookies.has(role)) {
      const response = await runtime.app.request('/api/auth/sign-in/email', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify({ email: `${role}@demo.clinmesh.local`, password }),
      })
      expect(response.status).toBe(200)
      cookies.set(role, response.headers.get('set-cookie')!.split(';', 1)[0]!)
    }
    return runtime.app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie: cookies.get(role)!, 'content-type': 'application/json',
        origin: 'http://localhost', 'idempotency-key': key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  let patient: { id: string; versionId: string }
  if (source !== undefined) {
    await request('admin', '/api/auth/context')
    const caseId = await generateCase(runtime, cookies.get('admin')!)
    const visit = await startOutpatientVisit(runtime, cookies.get('admin')!, caseId)
    const resource = fhirResourceSchema.parse(await (await request('registrar', `/fhir/R5/Patient/${visit.patientId}`)).json())
    patient = { id: visit.patientId, versionId: resource.meta!.versionId! }
  } else {
    const patientResponse = await request('registrar', '/api/his/v1/patients', { expectedVersions: {}, input: {
      name: '合成助手住院患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}`,
    } })
    patient = createPatientResponseSchema.parse(await patientResponse.json()).data.patient
  }
  const registered = await request('registrar', '/api/his/v1/inpatient/admissions', { input: {
    expectedEpoch: 'epoch-1', patientId: patient.id, patientVersion: patient.versionId,
    admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0,
  } })
  const registration = inpatientCommandResponseSchema.parse(await registered.json()).data.admission
  const received = await request('ward-nurse', `/api/his/v1/inpatient/admissions/${registration.id}/receive`, {
    input: { encounterVersion: registration.versionId, bedId: 'bed-general-1' },
  })
  const admission = inpatientCommandResponseSchema.parse(await received.json()).data.admission
  let revision = 0
  const context = (role: string, stage = 'orders', changes: Record<string, unknown> = {}) => request(role,
    '/api/agent/v1/page-contexts', {
      client: { id: `inpatient-${role}`, revision: ++revision }, dshSessionId: 'inpatient-session',
      claim: { version: 1, viewId: 'inpatient', viewRevision: 'inpatient-1', activeSection: stage,
        selection: { kind: 'inpatient-admission', id: admission.id, version: admission.versionId },
        ui: { status: 'ready' }, ...changes },
    })
  return { runtime, request, admission, context }
}

it('住院上下文绑定当前住院、环节和岗位，拒绝自报患者资料及过期版本', async () => {
  const s = await setup()
  const response = await s.context('ward-nurse')
  expect(response.status).toBe(201)
  const binding = agentPageContextBindingSchema.parse(await response.json())
  expect(binding.snapshot.claim).toMatchObject({ activeSection: 'orders',
    selection: { kind: 'inpatient-admission', id: s.admission.id, version: s.admission.versionId } })
  expect(binding.snapshot.allowedOperationIds).toContain('inpatient.stage.select')
  expect(binding.snapshot.allowedOperationIds).not.toContain('inpatient.report.acknowledge.propose')
  expect((await s.context('ward-nurse', 'orders', { patientName: '自报患者' })).status).toBe(400)
  expect((await s.context('ward-nurse', 'orders', {
    selection: { kind: 'inpatient-admission', id: s.admission.id, version: '999' },
  })).status).toBe(409)
  expect((await s.context('registrar')).status).toBe(403)
  expect((await s.context('ward-nurse', 'drg')).status).toBe(409)
  expect((await s.request('ward-nurse', '/api/agent/v1/tool-calls', toolCall(binding,
    'inpatient.stage.select', { stage: 'drg' }))).status).toBe(409)
  await addSecondaryInpatientWard(s.runtime)
  expect((await s.request('ward-nurse', '/api/auth/role', {
    practitionerRoleId: 'practitioner-role-ward-nurse-surgery',
  })).status).toBe(200)
  expect((await s.context('ward-nurse')).status).toBe(409)
})

function toolCall(binding: AgentPageContextBinding, operationId: string, input: unknown, callId = randomUUID()) {
  const definition = agentToolCatalog.find(tool => tool.operationId === operationId)!
  const now = new Date()
  const payload = {
    callId, contextId: binding.snapshot.id, dshSessionId: binding.snapshot.dshSessionId,
    expiresAt: new Date(now.getTime() + 60_000).toISOString(), issuedAt: now.toISOString(),
    pageRevision: agentPageBindingRevision(binding.snapshot.claim), scopeKey: binding.snapshot.scopeKey,
    toolName: definition.toolName, version: 3,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url')
  return { contextToken: binding.token, executionProof: `${encoded}.${signature}`, operationId, input }
}

it('护士只能准备当前住院医嘱校对，批准后关联同键唯一的正式Command与审计', async () => {
  const s = await setup()
  const path = `/api/his/v1/inpatient/admissions/${s.admission.id}`
  const issued = await s.request('inpatient-doctor', `${path}/orders/issue`, { input: {
    encounterVersion: s.admission.versionId, duration: 'temporary',
    selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 },
  } })
  expect(issued.status).toBe(200)
  const order = inpatientFullClinicalResponseSchema.parse(await issued.json()).data.orders[0]!
  const binding = agentPageContextBindingSchema.parse(await (await s.context('ward-nurse')).json())
  expect(binding.snapshot.allowedOperationIds).toContain('inpatient.order.verify.propose')
  const input = { orderId: order.id, expectedOrderVersion: order.version }
  expect((await s.request('ward-nurse', '/api/agent/v1/tool-calls', toolCall(binding,
    'inpatient.order.verify.propose', { ...input, expectedOrderVersion: 999 }))).status).toBe(409)
  expect((await s.request('ward-nurse', '/api/agent/v1/tool-calls', toolCall(binding,
    'inpatient.order.verify.propose', { ...input, orderId: 'other-admission-order' }))).status).toBe(409)
  expect((await s.request('ward-nurse', '/api/agent/v1/tool-calls', toolCall(binding,
    'inpatient.order.verify.propose', { ...input, admissionId: s.admission.id }))).status).toBe(400)
  const doctor = agentPageContextBindingSchema.parse(await (await s.context('inpatient-doctor')).json())
  expect((await s.request('inpatient-doctor', '/api/agent/v1/tool-calls', toolCall(doctor,
    'inpatient.order.verify.propose', input))).status).toBe(403)
  const call = toolCall(binding, 'inpatient.order.verify.propose', input)
  const authorization = await s.request('ward-nurse', '/api/agent/v1/tool-calls', call)
  expect(authorization.status).toBe(201)
  const authorized = agentToolAuthorizationResponseSchema.parse(await authorization.json())
  expect((await s.request('ward-nurse', '/api/agent/v1/tool-calls', call)).status).toBe(409)
  const clinical = inpatientFullClinicalSchema.parse(await (await s.request('ward-nurse', `${path}/clinical`)).json())
  expect(clinical.orders[0]?.state).toBe('signed')
  expect((await s.request('ward-nurse', '/api/agent/v1/tool-calls/review', {
    decision: 'approved', receiptToken: authorized.receiptToken,
  })).status).toBe(200)
  const key = randomUUID()
  const verified = await s.request('ward-nurse', `${path}/orders/verify`, { input }, key)
  expect(verified.status).toBe(200)
  const command = inpatientFullClinicalResponseSchema.parse(await verified.json())
  expect(command.data.orders[0]?.state).toBe('verified')
  expect(await (await s.request('ward-nurse', `${path}/orders/verify`, { input }, key)).json()).toEqual(command)
  const completed = await s.request('ward-nurse', '/api/agent/v1/tool-calls/result', {
    ok: true, receiptToken: authorized.receiptToken, result: { approved: true, data: command },
  })
  expect(completed.status).toBe(200)
  expect(await completed.json()).toMatchObject({ auditId: command.auditId, requestId: command.requestId,
    proposalStatus: 'approved', status: 'completed' })
})

it('医嘱行在审阅期间发生变化时拒绝批准，不校对医嘱或增加执行记录', async () => {
  const s = await setup()
  const path = `/api/his/v1/inpatient/admissions/${s.admission.id}`
  const issued = await s.request('inpatient-doctor', `${path}/orders/issue`, { input: {
    encounterVersion: s.admission.versionId, duration: 'temporary',
    selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 },
  } })
  expect(issued.status).toBe(200)
  const order = inpatientFullClinicalResponseSchema.parse(await issued.json()).data.orders[0]!
  const binding = agentPageContextBindingSchema.parse(await (await s.context('ward-nurse')).json())
  const authorization = await s.request('ward-nurse', '/api/agent/v1/tool-calls', toolCall(binding,
    'inpatient.order.verify.propose', { orderId: order.id, expectedOrderVersion: order.version }))
  expect(authorization.status).toBe(201)
  const authorized = agentToolAuthorizationResponseSchema.parse(await authorization.json())
  expect((await s.request('inpatient-doctor', `${path}/orders/request-stop`, { input: {
    orderId: order.id, expectedOrderVersion: order.version, reason: '合成方案调整',
  } })).status).toBe(200)
  const before = inpatientFullClinicalSchema.parse(await (await s.request('ward-nurse', `${path}/clinical`)).json())
  expect((await s.request('ward-nurse', '/api/agent/v1/tool-calls/review', {
    decision: 'approved', receiptToken: authorized.receiptToken,
  })).status).toBe(409)
  expect(inpatientFullClinicalSchema.parse(await (await s.request('ward-nurse', `${path}/clinical`)).json())).toEqual(before)
  expect(before.orders[0]?.state).toBe('stop-requested')
  expect(before.executions).toEqual([])
})

it('另一条医嘱的Command回执不能伪造当前校对提案完成', async () => {
  const s = await setup()
  const path = `/api/his/v1/inpatient/admissions/${s.admission.id}`
  const issue = () => s.request('inpatient-doctor', `${path}/orders/issue`, { input: {
    encounterVersion: s.admission.versionId, duration: 'temporary',
    selection: { kind: 'service', serviceId: 'hospital-service-diabetes-education', serviceVersion: 1, quantity: 1 },
  } })
  const first = inpatientFullClinicalResponseSchema.parse(await (await issue()).json()).data.orders[0]!
  const second = inpatientFullClinicalResponseSchema.parse(await (await issue()).json()).data.orders.find(order => order.id !== first.id)!
  const binding = agentPageContextBindingSchema.parse(await (await s.context('ward-nurse')).json())
  const authorization = await s.request('ward-nurse', '/api/agent/v1/tool-calls', toolCall(binding,
    'inpatient.order.verify.propose', { orderId: first.id, expectedOrderVersion: first.version }))
  expect(authorization.status).toBe(201)
  const authorized = agentToolAuthorizationResponseSchema.parse(await authorization.json())
  expect((await s.request('ward-nurse', '/api/agent/v1/tool-calls/review', {
    decision: 'approved', receiptToken: authorized.receiptToken,
  })).status).toBe(200)
  const verified = await s.request('ward-nurse', `${path}/orders/verify`, { input: {
    orderId: second.id, expectedOrderVersion: second.version,
  } })
  expect(verified.status).toBe(200)
  const command = inpatientFullClinicalResponseSchema.parse(await verified.json())
  const completion = await s.request('ward-nurse', '/api/agent/v1/tool-calls/result', {
    ok: true, receiptToken: authorized.receiptToken, result: { approved: true, data: command },
  })
  expect(completion.status).toBe(403)
  const facts = inpatientFullClinicalSchema.parse(await (await s.request('ward-nurse', `${path}/clinical`)).json())
  expect(facts.orders.find(order => order.id === first.id)?.state).toBe('signed')
  expect(facts.orders.find(order => order.id === second.id)?.state).toBe('verified')
})

it('收费员只可准备当前住院出院补交和结算预览，不能通过Agent直接收款或结算', async () => {
  const s = await setup()
  const path = `/api/his/v1/inpatient/admissions/${s.admission.id}`
  const issued = inpatientDischargeResponseSchema.parse(await (await s.request('inpatient-doctor', `${path}/discharge/issue`, {
    input: { encounterVersion: s.admission.versionId, reason: '合成治疗结束' },
  })).json()).data.admission
  const departed = inpatientDischargeResponseSchema.parse(await (await s.request('ward-nurse', `${path}/discharge/depart`, {
    input: { encounterVersion: issued.versionId, reason: '合成交接结束', departureMethod: 'home' },
  })).json()).data.admission
  const response = await s.context('cashier', 'discharge', { selection: {
    kind: 'inpatient-admission', id: departed.id, version: departed.versionId,
  } })
  expect(response.status).toBe(201)
  const binding = agentPageContextBindingSchema.parse(await response.json())
  expect(binding.snapshot.allowedOperationIds).toEqual(expect.arrayContaining([
    'inpatient.payment.draft.set', 'inpatient.payment.preview', 'inpatient.settlement.preview',
  ]))
  expect(binding.snapshot.allowedOperationIds).not.toContain('inpatient.payment.confirm')
  expect(binding.snapshot.allowedOperationIds).not.toContain('inpatient.discharge.settle')
  const before = await (await s.request('cashier', `${path}/payments`)).json()
  const authorization = await s.request('cashier', '/api/agent/v1/tool-calls', toolCall(binding,
    'inpatient.payment.draft.set', { tenders: [{ method: 'cash', amountFen: 100 }] }))
  expect(authorization.status).toBe(201)
  expect((await s.request('cashier', '/api/agent/v1/tool-calls', toolCall(binding,
    'inpatient.payment.draft.set', { tenders: [{ method: 'cash', amountFen: -1 }] }))).status).toBe(400)
  expect((await s.request('cashier', '/api/agent/v1/tool-calls', toolCall(binding,
    'inpatient.payment.draft.set', { tenders: [{ method: 'cash', amountFen: 100 }, { method: 'cash', amountFen: 200 }] }))).status).toBe(400)
  expect((await s.request('cashier', '/api/agent/v1/tool-calls', toolCall(binding,
    'inpatient.settlement.preview', { admissionId: 'other' }))).status).toBe(400)
  expect(await (await s.request('cashier', `${path}/payments`)).json()).toEqual(before)
})

async function report(s: Awaited<ReturnType<typeof setup>>) {
  const concept = { id: 'loinc:synthetic:6690-2', system: 'http://loinc.org', code: '6690-2', display: '白细胞计数', version: '2.83', sourceLocator: 'synthetic:loinc:6690-2' }
  const service = laboratoryServiceSnapshotSchema.parse({
    id: 'synthetic-agent-wbc', version: 1, serviceKind: 'laboratory', doctorOrderable: true,
    localCode: 'SYN-AGENT-WBC', nameZh: '合成白细胞计数', referenceConcept: concept,
    referenceReleaseId: 'synthetic-laboratory-release', componentServiceIds: [], executingDepartmentId: 'department-laboratory',
    allowedIndicationCodes: ['clinical-assessment'], specimen: { code: '119297000', display: '血液标本' }, tatMinutes: 20, priceFen: 800,
    reportDefinition: { conclusionTemplate: '白细胞计数结果已完成。', results: [{ referenceConcept: concept,
      valueType: 'quantity', referenceRange: { low: 4, high: 10, text: '4.0-10.0 x10^9/L' },
      unit: { system: 'http://unitsofmeasure.org', code: '10*9/L', display: '10^9/L' } }] },
  })
  s.runtime.database.driver.prepare('INSERT OR IGNORE INTO hospital_service_catalog(workspace_id,epoch,service_id,code,name_zh,name_en,version,active,config_json) VALUES(?,?,?,?,?,?,1,1,?)')
    .run('workspace-demo', 'epoch-1', service.id, service.localCode, service.nameZh, service.nameZh,
      JSON.stringify({ laboratoryService: service, availableScopes: ['outpatient', 'inpatient'], billingUnit: { display: '项目' },
        chargeDefinition: { id: 'synthetic-agent-wbc-charge', currency: 'CNY', priceFen: 800 } }))
  const path = `/api/his/v1/inpatient/admissions/${s.admission.id}`
  const issued = await s.request('inpatient-doctor', `${path}/investigations/issue`, { input: {
    encounterVersion: s.admission.versionId, catalogVersion: 1,
    selection: { kind: 'laboratory', catalogItemId: service.id, indicationCode: 'clinical-assessment' },
  } })
  expect(issued.status).toBe(200)
  const request = inpatientInvestigationResponseSchema.parse(await issued.json()).data.laboratoryRequests.find(request => request.status === 'issued')!
  expect((await s.request('ward-nurse', `${path}/investigations/send`, { input: {
    requestId: request.id, expectedRequestVersion: request.version,
    serviceRequestVersion: request.serviceRequestVersion, taskVersion: request.taskVersion,
  } })).status).toBe(200)
  while (await s.runtime.dispatcher.dispatchOnce() !== undefined) { /* drain the synthetic request */ }
  const current = inpatientInvestigationsSchema.parse(await (await s.request('inpatient-doctor', `${path}/investigations`)).json())
    .laboratoryRequests.find(item => item.id === request.id)!
  expect(current.status).toBe('reported')
  return { requestId: current.id, expectedRequestVersion: current.version,
    serviceRequestVersion: current.serviceRequestVersion, taskVersion: current.taskVersion,
    diagnosticReportId: current.report!.diagnosticReportId, diagnosticReportVersion: current.report!.diagnosticReportVersion }
}

it('医生报告已阅提案绑定本次住院的当前报告及全部预期版本，由人工确认后记录审计', async () => {
  const s = await setup(true)
  const input = await report(s)
  const binding = agentPageContextBindingSchema.parse(await (await s.context('inpatient-doctor', 'investigations')).json())
  expect(binding.snapshot.allowedOperationIds).toContain('inpatient.report.acknowledge.propose')
  const authorize = (values: unknown) => s.request('inpatient-doctor', '/api/agent/v1/tool-calls',
    toolCall(binding, 'inpatient.report.acknowledge.propose', values))
  expect((await authorize({ ...input, expectedRequestVersion: 999 })).status).toBe(409)
  expect((await authorize({ ...input, diagnosticReportId: 'other-report' })).status).toBe(409)
  const authorization = await authorize(input)
  expect(authorization.status).toBe(201)
  const authorized = agentToolAuthorizationResponseSchema.parse(await authorization.json())
  expect((await s.request('inpatient-doctor', '/api/agent/v1/tool-calls/review', {
    decision: 'approved', receiptToken: authorized.receiptToken,
  })).status).toBe(200)
  const path = `/api/his/v1/inpatient/admissions/${s.admission.id}`
  const response = await s.request('inpatient-doctor', `${path}/investigations/acknowledge`, { input })
  expect(response.status).toBe(200)
  const command = inpatientInvestigationResponseSchema.parse(await response.json())
  expect(command.data.laboratoryRequests.find(request => request.id === input.requestId)?.status).toBe('acknowledged')
  const completed = await s.request('inpatient-doctor', '/api/agent/v1/tool-calls/result', {
    ok: true, receiptToken: authorized.receiptToken, result: { approved: true, data: command },
  })
  expect(completed.status).toBe(200)
  expect(await completed.json()).toMatchObject({ auditId: command.auditId, requestId: command.requestId,
    proposalStatus: 'approved', status: 'completed' })
})

it('报告行在审阅期间已改变时拒绝批准，另一报告的回执不能替代当前已阅提案', async () => {
  const s = await setup(true)
  const first = await report(s), second = await report(s)
  const binding = agentPageContextBindingSchema.parse(await (await s.context('inpatient-doctor', 'investigations')).json())
  const authorize = async (input: unknown) => {
    const response = await s.request('inpatient-doctor', '/api/agent/v1/tool-calls',
      toolCall(binding, 'inpatient.report.acknowledge.propose', input))
    expect(response.status).toBe(201)
    return agentToolAuthorizationResponseSchema.parse(await response.json())
  }
  const stale = await authorize(second), targeted = await authorize(first)
  expect((await s.request('inpatient-doctor', '/api/agent/v1/tool-calls/review', {
    decision: 'approved', receiptToken: targeted.receiptToken,
  })).status).toBe(200)
  const path = `/api/his/v1/inpatient/admissions/${s.admission.id}`
  const acknowledged = await s.request('inpatient-doctor', `${path}/investigations/acknowledge`, { input: second })
  expect(acknowledged.status).toBe(200)
  const command = inpatientInvestigationResponseSchema.parse(await acknowledged.json())
  expect((await s.request('inpatient-doctor', '/api/agent/v1/tool-calls/review', {
    decision: 'approved', receiptToken: stale.receiptToken,
  })).status).toBe(409)
  expect((await s.request('inpatient-doctor', '/api/agent/v1/tool-calls/result', {
    ok: true, receiptToken: targeted.receiptToken, result: { approved: true, data: command },
  })).status).toBe(403)
  const after = inpatientInvestigationsSchema.parse(await (await s.request('inpatient-doctor', `${path}/investigations`)).json())
  expect(after).toEqual(command.data)
  expect(after.laboratoryRequests.find(request => request.id === first.requestId)?.status).toBe('reported')
  expect(after.laboratoryRequests.find(request => request.id === second.requestId)?.status).toBe('acknowledged')
})
