import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inpatientFinancialSchema, inpatientFinancialResponseSchema, inpatientFinancialRefundPreviewResponseSchema } from '@clinmesh/contracts/inpatient-finance'
import { inpatientPaymentPreviewResponseSchema, inpatientPaymentResponseSchema, inpatientPaymentsSchema, inpatientSettlementPreviewSchema, inpatientSettlementResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientChargesSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientRecordSchema, inpatientRecordResponseSchema } from '@clinmesh/contracts/inpatient-record'
import { refundResponseSchema } from '@clinmesh/contracts/refunds'
import { apiErrorSchema, scenarioStateSchema, scenarioCommandResponseSchema } from '@clinmesh/contracts/his'
import { agentCapabilityGrantSchema, agentClientSchema } from '@clinmesh/contracts/agent'
import { createClinMeshRuntime, type CreateClinMeshRuntimeOptions } from '../src/runtime.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'
import { syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot } from '../src/application/scenario-data/medical-service-snapshot.ts'
import { StubSyntheaProvider } from './fixtures/consultation.ts'
import { completeSyntheticOutpatient, FinancialAcceptanceProvider } from './fixtures/complete-synthetic-outpatient.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function setup(splitSources = false) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-financial-acceptance-'))
  const password = `Test-${randomUUID()}-Aa1!`
  const referenceDatabasePath = join(directory, 'reference.sqlite')
  const artifact = JSON.stringify({ schemaVersion: '1', concepts: [{ id: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', domain: 'diagnosis',
    system: 'urn:clinmesh:reference:nhsa-diagnosis', version: '2022', code: 'I10.x09', display: '合成正式目录高血压', status: 'active',
    sourceLocator: 'cn-health:nhc-icd10-clinical@2022.r4:diagnosis:12457' }], medicationProducts: syntheticNhsaMedicationProductSnapshot,
    services: syntheticNhcMedicalServiceSnapshot, valueSetEntries: syntheticWstValueSetSnapshot })
  await writeFile(join(directory, 'reference.json'), artifact)
  await writeFile(join(directory, 'release.json'), JSON.stringify({ releaseId: 'synthetic-financial-acceptance', schemaVersion: '1', createdAt: '2026-08-28T00:00:00.000Z',
    sources: [{ sourceId: 'synthetic-financial-acceptance', artifactPath: 'reference.json', acquisitionMethod: 'generated', checksum: createHash('sha256').update(artifact).digest('hex'),
      licenseId: 'CC0-1.0', retrievedAt: '2026-08-28T00:00:00.000Z', sourceUrl: 'https://example.test/clinical', upstreamVersion: '2022' }] }))
  await runReferenceDatabaseCli(['migrate', '--database', referenceDatabasePath])
  await runReferenceDatabaseCli(['import', '--database', referenceDatabasePath, '--manifest', join(directory, 'release.json')])
  const options: CreateClinMeshRuntimeOptions = { authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'), referenceDatabasePath,
    activeReferenceReleaseId: 'synthetic-financial-acceptance', demoPassword: password, migrationMode: 'apply', trustedOrigins: ['http://localhost'],
    chatCompletionsProvider: new FinancialAcceptanceProvider(), patientPersonaModel: 'synthetic-financial-persona',
    consultationModel: 'synthetic-financial-quality', syntheaProvider: new StubSyntheaProvider() }
  let runtime = await createClinMeshRuntime(options)
  cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true }) })
  async function login(name: string) {
    const response = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ email: `${name}@demo.clinmesh.local`, password }) })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';', 1)[0]!
  }
  async function request(cookie: string, path: string, input?: unknown, key: string = randomUUID()) {
    return runtime.app.request(path, { method: input === undefined ? 'GET' : 'POST', headers: { cookie, origin: 'http://localhost',
      'content-type': 'application/json', 'idempotency-key': key }, ...(input === undefined ? {} : { body: JSON.stringify({ input }) }) })
  }
  const registrar = await login('registrar'), cashier = await login('cashier'), doctor = await login('inpatient-doctor'), nurse = await login('ward-nurse'), coder = await login('medical-records'), admin = await login('admin')
  const created = await runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: { cookie: registrar, origin: 'http://localhost',
    'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {}, input: {
      name: '合成财务验收患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } }) })
  expect(created.status).toBe(200)
  const patient = (await created.json()).data.patient
  const registeredResponse = await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
    patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: splitSources ? 2500 : 5000 })
  expect(registeredResponse.status).toBe(200)
  const registered = (await registeredResponse.json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${registered.id}`
  const received = await request(nurse, `${path}/receive`, { encounterVersion: registered.versionId, bedId: 'bed-general-1' })
  expect(received.status).toBe(200)
  if (splitSources) {
    const previewResponse = await request(cashier, `${path}/payments/preview`, { kind: 'deposit', amountFen: 2500,
      tenders: [{ method: 'mobile', amountFen: 2500 }], simulatorRule: 'success' })
    expect(previewResponse.status).toBe(200)
    const preview = inpatientPaymentPreviewResponseSchema.parse(await previewResponse.json()).data
    expect((await request(cashier, `${path}/payments/confirm`, { previewId: preview.previewId, commitToken: preview.commitToken })).status).toBe(200)
  }
  expect((await request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', { expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-25T00:00:00+08:00' })).status).toBe(200)
  const issued = await request(doctor, `${path}/discharge/issue`, { encounterVersion: (await received.json()).data.admission.versionId, reason: '合成临床治疗完成' })
  expect(issued.status).toBe(200)
  expect((await request(nurse, `${path}/discharge/depart`, { encounterVersion: (await issued.json()).data.admission.versionId, reason: '合成出区核对完成', departureMethod: 'home' })).status).toBe(200)
  const preview = inpatientSettlementPreviewSchema.parse(await (await request(cashier, `${path}/discharge/preview`)).json())
  const settled = await request(cashier, `${path}/discharge/settle`, { encounterVersion: preview.encounterVersion, fingerprint: preview.fingerprint,
    expectedChargesFen: preview.chargesFen, expectedBalanceFen: preview.balanceFen })
  expect(settled.status).toBe(200)
  const settlement = inpatientSettlementResponseSchema.parse(await settled.json()).data
  expect((await request(nurse, `${path}/discharge/clear`, { encounterVersion: settlement.encounterVersion, reason: '完成床单位清洁' })).status).toBe(200)
  const read = async () => inpatientFinancialSchema.parse(await (await request(cashier, `${path}/financial-adjustments`)).json())
  return { path, request, login, read, cashier, doctor, nurse, coder, registrar, admin, password, runtime: () => runtime,
    restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(options) } }
}

type Setup = Awaited<ReturnType<typeof setup>>
async function adjust(s: Setup, direction: 'increase' | 'decrease', amountFen: number) {
  const before = await s.read()
  const response = await s.request(s.cashier, `${s.path}/financial-adjustments`, { chargeId: before.charges[0]!.chargeId, direction, amountFen,
    expectedFingerprint: before.fingerprint, reason: direction === 'increase' ? '合成原费用漏计补正' : '合成原费用金额冲减' })
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
  return inpatientFinancialResponseSchema.parse(await response.json()).data
}
async function refund(s: Setup, amountFen: number, sourceKind?: 'inpatient-supplement') {
  const bill = await s.read(), adjustment = bill.adjustments.find(item => item.direction === 'decrease' && item.remainingFen >= amountFen)!
  const source = bill.sources.find(item => item.refundableFen >= amountFen && (sourceKind === undefined || item.sourceKind === sourceKind))!
  expect(source).toBeDefined()
  const response = await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/preview`, { adjustmentId: adjustment.adjustmentId,
    sourceKind: source.sourceKind, sourceId: source.sourceId, amountFen, expectedFingerprint: bill.fingerprint, expectedSourceVersion: source.version, simulatorRule: 'success' })
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
  const preview = inpatientFinancialRefundPreviewResponseSchema.parse(await response.json()).data
  const confirmed = await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/confirm`, { previewId: preview.previewId, commitToken: preview.commitToken })
  expect(confirmed.status, JSON.stringify(await confirmed.clone().json())).toBe(200)
  return refundResponseSchema.parse(await confirmed.json()).data
}
async function archive(s: Setup) {
  const clinical = await (await s.request(s.doctor, `${s.path}/clinical`)).json()
  const diagnosis = await s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: clinical.encounterVersion, expectedRevision: clinical.diagnosis.revision,
    entries: [{ catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', role: 'primary', admissionCondition: '1', note: '合成正式病案诊断依据' }] })
  expect(diagnosis.status).toBe(200)
  const record = inpatientRecordSchema.parse(await (await s.request(s.doctor, `${s.path}/record`)).json())
  const expected = { expectedRevision: 1, expectedSourcesHash: record.sourcesHash }
  expect((await s.request(s.doctor, `${s.path}/record/submit`, { ...expected, expectedRevision: 0, mainProcedureExecutionId: null })).status).toBe(200)
  expect((await s.request(s.coder, `${s.path}/record/review`, { ...expected, outcome: 'approved' })).status).toBe(200)
  const response = await s.request(s.coder, `${s.path}/record/archive`, expected)
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
  return inpatientRecordResponseSchema.parse(await response.json()).data
}
async function financialGrant(s: Setup) {
  const control = async (path: string, input: unknown) => s.runtime().app.request(path, { method: 'POST', headers: {
    cookie: s.admin, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(input) })
  const clientResponse = await control('/api/agent/v1/clients', { name: '合成财务验收Agent' })
  expect(clientResponse.status).toBe(200)
  const client = agentClientSchema.parse(await clientResponse.json())
  const grantResponse = await control('/api/agent/v1/grants', { agentClientId: client.agentClientId, practitionerRoleId: 'practitioner-role-cashier', ttlSeconds: 3600,
    operationIds: ['inpatient.financial.read', 'inpatient.financial.adjust', 'inpatient.financial.refund.preview', 'inpatient.financial.refund.confirm', 'inpatient.financial.refund.recover',
      'inpatient.financial.payment.preview', 'inpatient.financial.payment.confirm', 'inpatient.financial.payment.recover'] })
  expect(grantResponse.status, JSON.stringify(await grantResponse.clone().json())).toBe(200)
  const grant = agentCapabilityGrantSchema.parse(await grantResponse.json())
  const request = (path: string, input?: unknown) => s.runtime().app.request(path, { method: input === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    ...(input === undefined ? {} : { body: JSON.stringify({ input }) }) })
  expect((await request(`${s.path}/financial-adjustments`)).status).toBe(200)
  return request
}

describe('结算后独立财务验收公共 HTTP', () => {
  it('同Run真实门诊完诊发药后仅收费员可窄财务写，其他业务写和不受信Origin不获放行', async () => {
    const s = await setup()
    const archived = await archive(s)
    const agentRequest = await financialGrant(s)
    expect(await completeSyntheticOutpatient(s.runtime(), s.password)).toMatchObject({ status: 'completed', scenarioStatus: 'completed' })
    const state = scenarioStateSchema.parse(await (await s.request(s.admin, '/api/sim/v1/scenario-runs/current')).json())
    expect(state).toMatchObject({ scenarioRunId: 'scenario-run-1', epoch: 'epoch-1', status: 'completed' })
    const before = await s.read(), input = { chargeId: before.charges[0]!.chargeId, direction: 'decrease', amountFen: 1000,
      expectedFingerprint: before.fingerprint, reason: '合成完成场景财务冲减' }
    const inactiveAgent = await agentRequest(`${s.path}/financial-adjustments`, input)
    expect(inactiveAgent.status).toBe(401)
    expect(apiErrorSchema.parse(await inactiveAgent.json()).error.code).toBe('AGENT_TOKEN_INVALID')
    for (const cookie of [s.doctor, s.nurse, s.registrar, s.coder, s.admin, await s.login('pharmacist'), await s.login('doctor')]) {
      const denied = await s.request(cookie, `${s.path}/financial-adjustments`, input)
      expect(denied.status, JSON.stringify(await denied.clone().json())).toBe(403)
    }
    for (const origin of [undefined, 'https://untrusted.example']) {
      for (const action of ['', '/refunds/preview', '/refunds/confirm', '/refunds/recover', '/payments/preview', '/payments/confirm', '/payments/recover']) {
        const denied = await s.runtime().app.request(`${s.path}/financial-adjustments${action}`, { method: 'POST',
          headers: { cookie: s.cashier, 'content-type': 'application/json', 'idempotency-key': randomUUID(), ...(origin === undefined ? {} : { origin }) }, body: JSON.stringify({ input }) })
        expect(denied.status).toBe(403)
      }
    }
    expect(await s.read()).toEqual(before)
    await adjust(s, 'decrease', 1000)
    expect(await refund(s, 1000)).toMatchObject({ outcome: 'success', amountFen: 1000 })
    expect((await s.request(s.cashier, `${s.path}/payments/preview`, { kind: 'deposit', amountFen: 100,
      tenders: [{ method: 'cash', amountFen: 100 }], simulatorRule: 'success' })).status).toBe(409)
    expect((await s.request(s.nurse, `${s.path}/discharge/clear`, { encounterVersion: archived.snapshot.fees.encounterVersion, reason: '不得重新清床' })).status).toBe(409)
    expect(await (await s.request(s.coder, `${s.path}/record`)).json()).toEqual(archived)
    expect(scenarioStateSchema.parse(await (await s.request(s.admin, '/api/sim/v1/scenario-runs/current')).json())).toMatchObject({ status: 'completed' })
  }, 30_000)

  it('公共reset关闭原Run并切换Epoch后，旧住院ID和原Grant不能写入新Epoch', async () => {
    const s = await setup(), before = await s.read(), agentRequest = await financialGrant(s)
    const input = { chargeId: before.charges[0]!.chargeId, amountFen: 1000, expectedFingerprint: before.fingerprint, reason: '合成旧Epoch不得更正' }
    const reset = await s.runtime().app.request('/api/sim/v1/scenario-runs/scenario-run-1/actions/reset', { method: 'POST', headers: {
      cookie: s.admin, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: '{}' })
    expect(reset.status).toBe(200)
    expect(scenarioCommandResponseSchema.parse(await reset.json()).data).toMatchObject({ epoch: 'epoch-2', scenarioRunId: 'scenario-run-2' })
    const staleAgent = await agentRequest(`${s.path}/financial-adjustments`, input)
    expect(staleAgent.status).toBe(401)
    expect(apiErrorSchema.parse(await staleAgent.json()).error.code).toBe('AGENT_TOKEN_INVALID')
    expect((await s.request(s.cashier, `${s.path}/financial-adjustments`, input)).status).toBe(404)
    expect((await s.request(s.cashier, `${s.path}/financial-adjustments`)).status).toBe(404)
    expect((await s.request(s.cashier, `${s.path}/financial-adjustments`, { ...input, epoch: 'epoch-1' })).status).toBe(400)
  })

  it('外部closed Run上下文只允许读取，不能因current财务例外继续追加更正', async () => {
    const s = await setup(), archived = await archive(s), before = await s.read()
    // reset是唯一公共关闭入口且会同时换Epoch；此夹具只注入外部已关闭上下文，归档由真实流程生成。
    s.runtime().database.driver.prepare("UPDATE scenario_run SET status='closed' WHERE workspace_id=? AND epoch=? AND scenario_run_id=?")
      .run('workspace-demo', 'epoch-1', 'scenario-run-1')
    const denied = await s.request(s.cashier, `${s.path}/financial-adjustments`, { chargeId: before.charges[0]!.chargeId,
      amountFen: 1000, expectedFingerprint: before.fingerprint, reason: '合成closed场景不得更正' })
    expect(denied.status).toBe(403)
    expect(apiErrorSchema.parse(await denied.json()).error.code).toBe('INPATIENT_FINANCIAL_CONTEXT_FORBIDDEN')
    expect(await s.read()).toEqual(before)
    expect(await (await s.request(s.coder, `${s.path}/record`)).json()).toEqual(archived)
  })

  it.each(['same', 'different'] as const)('并发%s原款退款只占用一次共享冲减依据，跨原款累计不超过待退差额', async sourceMode => {
    const s = await setup(true), bill = await adjust(s, 'decrease', 3000)
    expect(bill.sources).toHaveLength(2)
    const sources = sourceMode === 'same' ? [bill.sources[0]!, bill.sources[0]!] : [bill.sources[0]!, bill.sources[1]!]
    const previews = await Promise.all(sources.map(async source => {
      const response = await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/preview`, { adjustmentId: bill.adjustments[0]!.adjustmentId,
        sourceKind: source.sourceKind, sourceId: source.sourceId, amountFen: 2000, expectedFingerprint: bill.fingerprint,
        expectedSourceVersion: source.version, simulatorRule: 'success' })
      expect(response.status).toBe(200)
      return inpatientFinancialRefundPreviewResponseSchema.parse(await response.json()).data
    }))
    const confirmations = await Promise.all(previews.map(preview => s.request(s.cashier, `${s.path}/financial-adjustments/refunds/confirm`, {
      previewId: preview.previewId, commitToken: preview.commitToken })))
    expect(confirmations.map(response => response.status).sort()).toEqual([200, 409])
    const current = await s.read()
    expect(current).toMatchObject({ currentFundsFen: 3000, currentChargesFen: 2000, remainingRefundFen: 1000, reservedFen: 0 })
    expect(current.refunds).toHaveLength(1)
    const unused = current.sources.find(source => source.refundableFen >= 1500)!
    const excessive = await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/preview`, { adjustmentId: current.adjustments[0]!.adjustmentId,
      sourceKind: unused.sourceKind, sourceId: unused.sourceId, amountFen: 1500, expectedFingerprint: current.fingerprint,
      expectedSourceVersion: unused.version, simulatorRule: 'success' })
    expect(excessive.status).toBe(409)
    expect(await s.read()).toEqual(current)
    expect(await refund(s, 1000)).toMatchObject({ amountFen: 1000, outcome: 'success' })
    expect(await s.read()).toMatchObject({ currentFundsFen: 2000, currentChargesFen: 2000, remainingRefundFen: 0 })
  })

  it.each(['decline', 'ambiguous-decline', 'ambiguous-pending'] as const)('归档后%s退款重启查询原尝试，只有确定拒付释放原款和依据预占', async rule => {
    const s = await setup(true)
    const archived = await archive(s), bill = await adjust(s, 'decrease', 3000), source = bill.sources[0]!
    const previewResponse = await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/preview`, { adjustmentId: bill.adjustments[0]!.adjustmentId,
      sourceKind: source.sourceKind, sourceId: source.sourceId, amountFen: 2000, expectedFingerprint: bill.fingerprint,
      expectedSourceVersion: source.version, simulatorRule: rule })
    expect(previewResponse.status).toBe(200)
    const preview = inpatientFinancialRefundPreviewResponseSchema.parse(await previewResponse.json()).data
    const input = { previewId: preview.previewId, commitToken: preview.commitToken }, key = randomUUID()
    const confirmed = await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/confirm`, input, key)
    expect(confirmed.status).toBe(200)
    const receipt = refundResponseSchema.parse(await confirmed.json())
    expect(receipt.data).toMatchObject({ amountFen: 2000, outcome: rule === 'decline' ? 'declined' : 'ambiguous' })
    expect(await s.read()).toMatchObject({ reservedFen: rule === 'decline' ? 0 : 2000, currentFundsFen: 5000, currentChargesFen: 2000 })
    await s.restart()
    expect(await (await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/confirm`, input, key)).json()).toEqual(receipt)
    const recovery = { refundId: receipt.data.refundId, expectedRefundVersion: 1 }, recoveryKey = randomUUID()
    const recovered = await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/recover`, recovery, recoveryKey)
    expect(recovered.status).toBe(200)
    const result = refundResponseSchema.parse(await recovered.json())
    expect(result.data).toMatchObject({ refundId: receipt.data.refundId, initialOutcome: receipt.data.initialOutcome,
      outcome: rule === 'ambiguous-pending' ? 'ambiguous' : 'declined', version: rule === 'ambiguous-decline' ? 2 : 1 })
    expect(await (await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/recover`, recovery, recoveryKey)).json()).toEqual(result)
    const current = await s.read()
    expect(current.refunds).toHaveLength(1)
    expect(current).toMatchObject({ reservedFen: rule === 'ambiguous-pending' ? 2000 : 0, remainingRefundFen: 3000 })
    expect(current.adjustments[0]!.status).toBe(rule === 'ambiguous-pending' ? 'unknown' : 'pending')
    expect((await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/recover`, { ...recovery, amountFen: 1, outcome: 'success' })).status).toBe(400)
    if (rule === 'ambiguous-pending') {
      const unused = current.sources[1]!
      const excessive = await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/preview`, { adjustmentId: current.adjustments[0]!.adjustmentId,
        sourceKind: unused.sourceKind, sourceId: unused.sourceId, amountFen: 1001, expectedFingerprint: current.fingerprint,
        expectedSourceVersion: unused.version, simulatorRule: 'success' })
      expect(excessive.status).toBe(409)
      const repeated = await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/recover`, recovery)
      expect(repeated.status).toBe(200)
      expect(refundResponseSchema.parse(await repeated.json()).data).toEqual(result.data)
      expect(await s.read()).toEqual(current)
    } else {
      expect(await refund(s, 2000)).toMatchObject({ amountFen: 2000, outcome: 'success' })
      expect(await s.read()).toMatchObject({ reservedFen: 0, currentFundsFen: 3000, remainingRefundFen: 1000 })
    }
    expect(await (await s.request(s.coder, `${s.path}/record`)).json()).toEqual(archived)
  })

  it('跨患者费用、原款、预览和恢复不能互用，窄body不能覆盖路径绑定', async () => {
    const s = await setup(), archived = await archive(s)
    const created = await s.runtime().app.request('/api/his/v1/patients', { method: 'POST', headers: { cookie: s.registrar,
      origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {}, input: {
        name: '合成另一位财务患者', gender: 'male', birthDate: '1975-01-01', identifier: `SYN-${randomUUID()}` } }) })
    expect(created.status).toBe(200)
    const patient = (await created.json()).data.patient
    const registered = await s.request(s.registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
      patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 5000 })
    expect(registered.status).toBe(200)
    const admission = (await registered.json()).data.admission, otherPath = `/api/his/v1/inpatient/admissions/${admission.id}`
    expect((await s.request(s.nurse, `${otherPath}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })).status).toBe(200)
    expect((await s.request(s.admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
      expectedVirtualTime: '2026-08-25T00:00:00+08:00', targetVirtualTime: '2026-08-26T00:00:00+08:00' })).status).toBe(200)
    const otherCharges = inpatientChargesSchema.parse(await (await s.request(s.cashier, `${otherPath}/charges`)).json())
    const otherFunds = inpatientPaymentsSchema.parse(await (await s.request(s.cashier, `${otherPath}/payments`)).json())
    const before = await s.read()
    expect((await s.request(s.cashier, `${s.path}/financial-adjustments`, { chargeId: otherCharges.charges[0]!.id,
      amountFen: 1000, expectedFingerprint: before.fingerprint, reason: '合成禁止串用另一患者费用' })).status).toBe(409)
    expect(await s.read()).toEqual(before)
    const bill = await adjust(s, 'decrease', 1000), source = bill.sources[0]!, otherSource = otherFunds.sources[0]!
    const previewInput = { adjustmentId: bill.adjustments[0]!.adjustmentId, sourceKind: source.sourceKind, sourceId: source.sourceId,
      amountFen: 1000, expectedFingerprint: bill.fingerprint, expectedSourceVersion: source.version, simulatorRule: 'ambiguous' }
    expect((await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/preview`, { ...previewInput,
      sourceKind: otherSource.kind, sourceId: otherSource.id, expectedSourceVersion: otherSource.version })).status).toBe(409)
    expect(await s.read()).toEqual(bill)
    const preview = inpatientFinancialRefundPreviewResponseSchema.parse(await (await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/preview`, previewInput)).json()).data
    const confirmation = { previewId: preview.previewId, commitToken: preview.commitToken }
    expect((await s.request(s.cashier, `${otherPath}/financial-adjustments/refunds/confirm`, confirmation)).status).toBe(409)
    expect((await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/confirm`, { ...confirmation, admissionId: admission.id })).status).toBe(400)
    const confirmed = await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/confirm`, confirmation)
    expect(confirmed.status).toBe(200)
    const refund = refundResponseSchema.parse(await confirmed.json()).data
    expect((await s.request(s.cashier, `${otherPath}/financial-adjustments/refunds/recover`, { refundId: refund.refundId, expectedRefundVersion: 1 })).status).toBe(409)
    expect((await s.request(s.cashier, `${s.path}/financial-adjustments/refunds/recover`, { refundId: refund.refundId, expectedRefundVersion: 1 })).status).toBe(200)
    expect(await (await s.request(s.cashier, `${otherPath}/payments`)).json()).toEqual(otherFunds)
    expect(await (await s.request(s.coder, `${s.path}/record`)).json()).toEqual(archived)
  })

  it('真实病案归档前后办理冲减退款与补收，原首页、首次结算和清床事实保持不变', async () => {
    const s = await setup()
    const settlement = await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()
    const events = await (await s.request(s.nurse, `${s.path}/discharge`)).json()
    const charges = await (await s.request(s.cashier, `${s.path}/charges`)).json()
    await adjust(s, 'decrease', 1000)
    expect(await refund(s, 1000)).toMatchObject({ outcome: 'success', amountFen: 1000 })
    expect(await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()).toEqual(settlement)
    expect(await (await s.request(s.cashier, `${s.path}/charges`)).json()).toEqual(charges)
    const archived = await archive(s)
    expect(archived.archive).toBeDefined()
    expect(archived.archive!.snapshot.fees).toMatchObject({ chargesFen: 5000, depositFen: 5000 })
    // 正式诊断确认会合法升级 Encounter；财务操作分别对照归档前后的当前读取基线。
    const archivedSettlement = await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()
    const archivedCharges = await (await s.request(s.cashier, `${s.path}/charges`)).json()
    const increased = await adjust(s, 'increase', 1500)
    const previewResponse = await s.request(s.cashier, `${s.path}/financial-adjustments/payments/preview`, {
      adjustmentId: increased.adjustments.find(item => item.direction === 'increase')!.adjustmentId, amountFen: 1500, expectedFingerprint: increased.fingerprint,
      tenders: [{ method: 'cash', amountFen: 500 }, { method: 'bank-card', amountFen: 1000 }], simulatorRule: 'success' })
    expect(previewResponse.status).toBe(200)
    const preview = inpatientPaymentPreviewResponseSchema.parse(await previewResponse.json()).data
    const payment = await s.request(s.cashier, `${s.path}/financial-adjustments/payments/confirm`, { previewId: preview.previewId, commitToken: preview.commitToken })
    expect(payment.status).toBe(200)
    expect(inpatientPaymentResponseSchema.parse(await payment.json()).data).toMatchObject({ amountFen: 1500, outcome: 'success' })
    await adjust(s, 'decrease', 500)
    expect(await refund(s, 500, 'inpatient-supplement')).toMatchObject({ sourceKind: 'inpatient-supplement', amountFen: 500, outcome: 'success', tenders: [{ method: 'cash', amountFen: 500 }] })
    expect(await s.read()).toMatchObject({ recordStatus: 'archived', currentChargesFen: 5000, currentFundsFen: 5000, remainingCollectFen: 0, remainingRefundFen: 0 })
    expect(await (await s.request(s.coder, `${s.path}/record`)).json()).toEqual(archived)
    expect(await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()).toEqual(archivedSettlement)
    expect(await (await s.request(s.nurse, `${s.path}/discharge`)).json()).toEqual(events)
    expect(await (await s.request(s.cashier, `${s.path}/charges`)).json()).toEqual(archivedCharges)
    await s.restart()
    expect(await (await s.request(s.coder, `${s.path}/record`)).json()).toEqual(archived)
    expect(await s.read()).toMatchObject({ recordStatus: 'archived', currentChargesFen: 5000, currentFundsFen: 5000 })
  })
})
