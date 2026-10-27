import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime, type CreateClinMeshRuntimeOptions } from '../src/runtime.ts'
import { inpatientDrgFollowupSchema, inpatientDrgFollowupResponseSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { agentClientSchema, agentCapabilityGrantSchema } from '@clinmesh/contracts/agent'
import { prepareDrgRulesPackage } from '../src/infrastructure/reference-data/drg-rules-prepare.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { syntheticDrgSource, syntheticDrgIdentity } from './fixtures/drg-synthetic-program.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'
import { syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot } from '../src/application/scenario-data/medical-service-snapshot.ts'
import { addSecondaryInpatientWard } from './fixtures/inpatient-secondary-ward.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(withRules = false, groupCode = 'RA15') {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-drg-followup-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const password = `Test-${randomUUID()}-Aa1!`
  const options: CreateClinMeshRuntimeOptions = { authBaseUrl: 'http://localhost', trustedOrigins: ['http://localhost'], demoPassword: password,
    authSecret: 'test-auth-secret-with-at-least-32-characters', cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
    databasePath: join(directory, 'hospital.sqlite'), migrationMode: 'apply' as const }
  if (withRules) {
    const referenceDatabasePath = join(directory, 'reference.sqlite')
    const artifact = JSON.stringify({ schemaVersion: '1', concepts: [{ id: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', domain: 'diagnosis',
      system: 'urn:clinmesh:reference:nhsa-diagnosis', version: '2022', code: 'I10.x09', display: '合成跟进高血压', status: 'active', sourceLocator: 'cn-health:nhc-icd10-clinical@2022.r4:diagnosis:12457' }],
    medicationProducts: syntheticNhsaMedicationProductSnapshot, services: syntheticNhcMedicalServiceSnapshot, valueSetEntries: syntheticWstValueSetSnapshot })
    await writeFile(join(directory, 'reference.json'), artifact)
    await writeFile(join(directory, 'release.json'), JSON.stringify({ releaseId: 'synthetic-followup', schemaVersion: '1', createdAt: '2026-08-28T00:00:00.000Z', sources: [{
      sourceId: 'synthetic-clinical', artifactPath: 'reference.json', acquisitionMethod: 'generated', checksum: createHash('sha256').update(artifact).digest('hex'), licenseId: 'CC0-1.0',
      retrievedAt: '2026-08-28T00:00:00.000Z', sourceUrl: 'https://example.test/clinical', upstreamVersion: '2022' }] }))
    await runReferenceDatabaseCli(['migrate', '--database', referenceDatabasePath])
    await runReferenceDatabaseCli(['import', '--database', referenceDatabasePath, '--manifest', join(directory, 'release.json')])
    const groups = [{ level: 'MDC', code: 'MDCR', name: '合成系统', parentCode: null },
      { level: 'ADRG', code: groupCode.slice(0, 3), name: '合成组', parentCode: 'MDCR' }, { level: 'DRG', code: groupCode, name: '合成跟进组', parentCode: groupCode.slice(0, 3) }]
    const jsText = syntheticDrgSource('I10.x09', groupCode), tables = { CC: {}, MCC: {}, CCE: {} }
    const files = prepareDrgRulesPackage({ groups, jsText, complicationTables: tables,
      input: syntheticDrgIdentity(jsText, groups, tables), releaseId: 'synthetic-followup', sourceVersion: 'synthetic-followup-v1' })
    const drgRulesDirectory = join(directory, 'rules')
    await mkdir(drgRulesDirectory)
    for (const [name, content] of Object.entries(files)) await writeFile(join(drgRulesDirectory, name), content)
    Object.assign(options, { referenceDatabasePath, activeReferenceReleaseId: 'synthetic-followup', drgRulesDirectory })
  }
  let runtime = await createClinMeshRuntime(options)
  cleanups.push(() => runtime.close())
  async function login(name: string) {
    const response = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ email: `${name}@demo.clinmesh.local`, password }) })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';', 1)[0]!
  }
  async function request(cookie: string, path: string, input?: unknown, key = randomUUID()) {
    return runtime.app.request(path, { method: input === undefined ? 'GET' : 'POST',
      headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key },
      ...(input === undefined ? {} : { body: JSON.stringify({ input }) }) })
  }
  const registrar = await login('registrar'), doctor = await login('inpatient-doctor'), nurse = await login('ward-nurse')
  const created = await runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: {
    cookie: registrar, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
  body: JSON.stringify({ expectedVersions: {}, input: { name: '合成跟进患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } }) })
  expect(created.status).toBe(200)
  const patient = (await created.json()).data.patient
  const registered = await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
    patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0 })
  expect(registered.status).toBe(200)
  const admission = (await registered.json()).data.admission, path = `/api/his/v1/inpatient/admissions/${admission.id}`
  const received = await request(nurse, `${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })
  expect(received.status).toBe(200)
  const current = (await received.json()).data.admission
  if (withRules) {
    const clinical = await (await request(doctor, `${path}/clinical`)).json()
    expect((await request(doctor, `${path}/diagnoses/confirm`, { encounterVersion: clinical.encounterVersion, expectedRevision: clinical.diagnosis.revision,
      entries: [{ catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', role: 'primary', admissionCondition: '1', note: '合成跟进依据' }] })).status).toBe(200)
  }
  return { request, login, doctor, nurse, registrar, admission: current, path,
    runtime: () => runtime, restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(options) } }
}

describe('住院 DRG 后台规则跟进公开 HTTP', () => {
  it('重复开启、原意图恢复及重启保持唯一任务；缺规则如实显示，停止后不再分析', async () => {
    const s = await setup(), input = { encounterVersion: s.admission.versionId, expectedTaskVersion: 0 }, key = randomUUID()
    const response = await s.request(s.doctor, `${s.path}/drg/followup/start`, input, key)
    expect(response.status).toBe(200)
    const receipt = inpatientDrgFollowupResponseSchema.parse(await response.json()), task = receipt.data.task!
    expect(task).toMatchObject({ admissionId: s.admission.id, status: 'active' })
    expect(await (await s.request(s.doctor, `${s.path}/drg/followup/start`, input, key)).json()).toEqual(receipt)
    const repeated = await s.request(s.doctor, `${s.path}/drg/followup/start`, input)
    expect(repeated.status).toBe(200)
    expect((await repeated.json()).data.task.id).toBe(task.id)
    await s.runtime().dispatchPending()
    const result = await (await s.request(s.doctor, `${s.path}/drg/followup`)).json()
    expect(result.task).toMatchObject({ id: task.id, status: 'active', ruleStatus: 'incomplete', errorCode: 'DRG_RULES_NOT_CONFIGURED', modelRequests: 0 })
    expect(result.task.simulation).toBeNull()
    await s.restart()
    await s.runtime().dispatchPending()
    const restored = inpatientDrgFollowupSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/followup`)).json())
    expect(restored.task!.id).toBe(task.id)
    const stopped = await s.request(s.doctor, `${s.path}/drg/followup/stop`, {
      encounterVersion: restored.encounterVersion, expectedTaskVersion: restored.task!.version, reason: '医生结束本轮跟进' })
    expect(stopped.status).toBe(200)
    expect((await stopped.json()).data.task.status).toBe('stopped')
    await s.restart()
    await s.runtime().dispatchPending()
    expect((await (await s.request(s.doctor, `${s.path}/drg/followup`)).json()).task.status).toBe('stopped')
  })

  it('正式净收费严格超过3倍才提醒，恰好3倍及合法冲正后清除提醒', async () => {
    const s = await setup(true), admin = await s.login('admin'), cashier = await s.login('cashier')
    const admission = (await (await s.request(s.doctor, s.path)).json()).admission
    expect((await s.request(s.doctor, `${s.path}/drg/followup/start`, { encounterVersion: admission.versionId, expectedTaskVersion: 0 })).status).toBe(200)
    const advance = async (days: number) => {
      const clock = await (await s.request(admin, '/api/sim/v1/scenario-runs/current')).json()
      expect((await s.request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
        expectedVirtualTime: clock.virtualTime, targetVirtualTime: new Date(Date.parse(clock.virtualTime) + days * 86_400_000).toISOString(),
      })).status).toBe(200)
      await s.runtime().dispatchPending()
      return inpatientDrgFollowupSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/followup`)).json()).task!
    }
    const equal = await advance(180)
    expect(equal.simulation?.paymentReference?.referenceFen).toBe(300000)
    expect(equal.simulation?.formal.chargesFen).toBe(900000)
    expect(equal.exceptionAlert).toBe('below-threshold')
    const exceeded = await advance(1)
    expect(exceeded.simulation?.formal.chargesFen).toBe(905000)
    expect(exceeded.exceptionAlert).toBe('triggered')
    const charges = (await (await s.request(cashier, `${s.path}/charges`)).json()).charges
    const charge = charges.at(-1)
    expect((await s.request(cashier, `${s.path}/charges/reverse`, { chargeId: charge.id, expectedChargeVersion: charge.version, reason: '合成多记一日床位费更正' })).status).toBe(200)
    const stale = inpatientDrgFollowupSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/followup`)).json()).task!
    expect(stale.ruleStatus).toBe('stale')
    expect(stale.exceptionAlert).toBe('unknown')
    await s.runtime().dispatchPending()
    const corrected = inpatientDrgFollowupSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/followup`)).json()).task!
    expect(corrected.exceptionAlert).toBe('below-threshold')
    expect(corrected.simulation?.formal.chargesFen).toBe(900000)
    expect(corrected.modelRequests).toBe(0)
  })

  it('公开Agent授权撤销后原病例任务停止，失效页面权限不能继续规则分析', async () => {
    const s = await setup(), admin = await s.login('admin')
    const clientResponse = await s.runtime().app.request('/api/agent/v1/clients', { method: 'POST', headers: {
      cookie: admin, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ name: '合成跟进Agent' }) })
    const client = agentClientSchema.parse(await clientResponse.json())
    const grantResponse = await s.runtime().app.request('/api/agent/v1/grants', { method: 'POST', headers: {
      cookie: admin, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ agentClientId: client.agentClientId,
      operationIds: ['inpatient.drg.followup.start'], practitionerRoleId: 'practitioner-role-inpatient-doctor', ttlSeconds: 3600 }) })
    const grant = agentCapabilityGrantSchema.parse(await grantResponse.json())
    const response = await s.runtime().app.request(`${s.path}/drg/followup/start`, { method: 'POST', headers: {
      authorization: `Bearer ${grant.token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ input: { encounterVersion: s.admission.versionId, expectedTaskVersion: 0 } }) })
    expect(response.status).toBe(200)
    const taskId = inpatientDrgFollowupResponseSchema.parse(await response.json()).data.task!.id
    const revoked = await s.runtime().app.request(`/api/agent/v1/grants/${grant.grantId}/actions/revoke`, { method: 'POST',
      headers: { cookie: admin, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: '{}' })
    expect(revoked.status).toBe(200)
    await s.runtime().dispatchPending()
    const result = inpatientDrgFollowupSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/followup`)).json())
    expect(result.task).toMatchObject({ id: taskId, status: 'authorization-lost', ruleStatus: 'stale' })
    await s.restart()
    await s.runtime().dispatchPending()
    expect(inpatientDrgFollowupSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/followup`)).json()).task?.status).toBe('authorization-lost')
  })

  it('拒绝越岗、错误版本及不受信写入，转科后原责任绑定失效', async () => {
    const s = await setup(), input = { encounterVersion: s.admission.versionId, expectedTaskVersion: 0 }
    expect((await s.request(s.nurse, `${s.path}/drg/followup/start`, input)).status).toBe(403)
    expect((await s.request(s.registrar, `${s.path}/drg/followup`)).status).toBe(403)
    expect((await s.request(s.doctor, `${s.path}/drg/followup/start`, { ...input, encounterVersion: '999' })).status).toBe(409)
    expect((await s.runtime().app.request(`${s.path}/drg/followup/start`, { method: 'POST', headers: {
      cookie: s.doctor, origin: 'https://untrusted.example', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ input }) })).status).toBe(403)
    expect((await s.request(s.doctor, `${s.path}/drg/followup/start`, input)).status).toBe(200)
    await addSecondaryInpatientWard(s.runtime())
    const requested = await s.request(s.doctor, `${s.path}/transfers/request`, { encounterVersion: s.admission.versionId, targetWardId: 'ward-surgery', reason: '合成转科' })
    expect(requested.status).toBe(200)
    const transfer = (await requested.json()).data.transfers[0]
    const handover = await s.request(s.nurse, `${s.path}/transfers/handover`, { encounterVersion: s.admission.versionId,
      transferId: transfer.id, expectedTransferVersion: transfer.version })
    expect(handover.status).toBe(200)
    const handed = (await handover.json()).data.transfers[0]
    expect((await s.runtime().app.request('/api/auth/role', { method: 'POST', headers: { cookie: s.nurse, origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ practitionerRoleId: 'practitioner-role-ward-nurse-surgery' }) })).status).toBe(200)
    const received = await s.request(s.nurse, `${s.path}/transfers/receive`, { encounterVersion: s.admission.versionId, transferId: transfer.id,
      expectedTransferVersion: handed.version, bedId: 'bed-surgery-1' })
    expect(received.status).toBe(200)
    await s.runtime().dispatchPending()
    expect((await s.request(s.doctor, `${s.path}/drg/followup`)).status).toBe(403)
    const admin = await s.login('admin')
    expect((await s.runtime().app.request('/api/auth/role', { method: 'POST', headers: { cookie: admin, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ practitionerRoleId: 'practitioner-role-inpatient-doctor-surgery' }) })).status).toBe(200)
    expect(inpatientDrgFollowupSchema.parse(await (await s.request(admin, `${s.path}/drg/followup`)).json()).task?.status).toBe('authorization-lost')
  })


  it('病组缺支付参数时保留缺项，不把参考额或提醒判断写成零', async () => {
    const s = await setup(true, 'RA25')
    const admission = (await (await s.request(s.doctor, s.path)).json()).admission
    expect((await s.request(s.doctor, `${s.path}/drg/followup/start`, { encounterVersion: admission.versionId, expectedTaskVersion: 0 })).status).toBe(200)
    await s.runtime().dispatchPending()
    const result = inpatientDrgFollowupSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/followup`)).json()).task!
    expect(result).toMatchObject({ status: 'active', ruleStatus: 'incomplete', exceptionAlert: 'unknown', errorCode: 'DRG_PAYMENT_REFERENCE_MISSING' })
    expect(result.simulation?.paymentReference).toBeNull()
    expect(result.simulation?.grouping.formal.drgCode).toBe('RA25')
  })

  it('完整公开出院归档不被AI跟进阻断，归档停止临床分析且重启不恢复', async () => {
    const s = await setup(true), cashier = await s.login('cashier'), records = await s.login('medical-records')
    const currentAdmission = async () => (await (await s.request(s.doctor, s.path)).json()).admission
    const before = await currentAdmission()
    expect((await s.request(s.doctor, `${s.path}/drg/followup/start`, { encounterVersion: before.versionId, expectedTaskVersion: 0 })).status).toBe(200)
    await s.runtime().dispatchPending()
    const active = inpatientDrgFollowupSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/followup`)).json()).task!
    const issued = await s.request(s.doctor, `${s.path}/discharge/issue`, { encounterVersion: before.versionId, reason: '合成诊疗结束' })
    expect(issued.status).toBe(200)
    const discharge = (await issued.json()).data.admission
    expect((await s.request(s.nurse, `${s.path}/discharge/depart`, { encounterVersion: discharge.versionId, reason: '合成出区', departureMethod: 'home' })).status).toBe(200)
    const preview = await (await s.request(cashier, `${s.path}/discharge/preview`)).json()
    const settled = await s.request(cashier, `${s.path}/discharge/settle`, { encounterVersion: preview.encounterVersion,
      fingerprint: preview.fingerprint, expectedChargesFen: preview.chargesFen, expectedBalanceFen: preview.balanceFen })
    expect(settled.status).toBe(200)
    const settlement = (await settled.json()).data
    expect((await s.request(s.nurse, `${s.path}/discharge/clear`, { encounterVersion: settlement.encounterVersion, reason: '合成清床' })).status).toBe(200)
    const record = await (await s.request(s.doctor, `${s.path}/record`)).json()
    expect((await s.request(s.doctor, `${s.path}/record/submit`, { expectedRevision: 0, expectedSourcesHash: record.sourcesHash, mainProcedureExecutionId: null })).status).toBe(200)
    const submitted = await (await s.request(records, `${s.path}/record`)).json()
    expect((await s.request(records, `${s.path}/record/review`, { expectedRevision: submitted.revision.revision, expectedSourcesHash: submitted.sourcesHash, outcome: 'approved' })).status).toBe(200)
    const approved = await (await s.request(records, `${s.path}/record`)).json()
    expect((await s.request(records, `${s.path}/record/archive`, { expectedRevision: approved.revision.revision, expectedSourcesHash: approved.sourcesHash })).status).toBe(200)
    await s.runtime().dispatchPending()
    const archived = inpatientDrgFollowupSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/followup`)).json()).task!
    expect(archived.id).toBe(active.id)
    expect(archived.status).toBe('archived')
    expect(archived.simulation).not.toBeNull()
    await s.restart()
    await s.runtime().dispatchPending()
    expect(inpatientDrgFollowupSchema.parse(await (await s.request(records, `${s.path}/drg/followup`)).json()).task).toEqual(archived)
    const admission = await currentAdmission()
    expect((await s.request(s.doctor, `${s.path}/drg/followup/start`, { encounterVersion: admission.versionId, expectedTaskVersion: archived.version })).status).toBe(409)
  })

})
