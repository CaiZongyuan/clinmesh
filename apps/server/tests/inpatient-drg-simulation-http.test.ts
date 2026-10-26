import { syntheticDrgSource, syntheticDrgIdentity } from './fixtures/drg-synthetic-program.ts'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClinMeshRuntime, type CreateClinMeshRuntimeOptions } from '../src/runtime.ts'
import { prepareDrgRulesPackage } from '../src/infrastructure/reference-data/drg-rules-prepare.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'
import { syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot } from '../src/application/scenario-data/medical-service-snapshot.ts'
import { inpatientSurgeryExecuteInputSchema } from '@clinmesh/contracts/inpatient-surgery'
import { createPatientResponseSchema, apiErrorSchema } from '@clinmesh/contracts/his'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientFullClinicalSchema, inpatientFullClinicalResponseSchema, inpatientPharmacySchema, inpatientPharmacyResponseSchema } from '@clinmesh/contracts/inpatient-clinical'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-drg-sim-'))
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
  const password = `Test-${randomUUID()}-Aa1!`
  const referenceDatabasePath = join(directory, 'reference.sqlite')
  const artifact = JSON.stringify({ schemaVersion: '1', concepts: [{ id: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', domain: 'diagnosis',
        system: 'urn:clinmesh:reference:nhsa-diagnosis', version: '2022', code: 'I10.x09', display: '合成真实目录高血压', status: 'active', sourceLocator: 'cn-health:nhc-icd10-clinical@2022.r4:diagnosis:12457' }],
      medicationProducts: syntheticNhsaMedicationProductSnapshot, services: syntheticNhcMedicalServiceSnapshot, valueSetEntries: syntheticWstValueSetSnapshot })
  await writeFile(join(directory, 'reference.json'), artifact)
  await writeFile(join(directory, 'release.json'), JSON.stringify({ releaseId: 'synthetic-clinical-2022', schemaVersion: '1', createdAt: '2026-08-28T00:00:00.000Z',
    sources: [{ sourceId: 'synthetic-clinical', artifactPath: 'reference.json', acquisitionMethod: 'generated', checksum: createHash('sha256').update(artifact).digest('hex'), licenseId: 'CC0-1.0',
        retrievedAt: '2026-08-28T00:00:00.000Z', sourceUrl: 'https://example.test/clinical', upstreamVersion: '2022' }] }))
  await runReferenceDatabaseCli(['migrate', '--database', referenceDatabasePath])
  await runReferenceDatabaseCli(['import', '--database', referenceDatabasePath, '--manifest', join(directory, 'release.json')])
  const base: CreateClinMeshRuntimeOptions = { authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'),
    referenceDatabasePath, activeReferenceReleaseId: 'synthetic-clinical-2022', demoPassword: password,
    migrationMode: 'apply', trustedOrigins: ['http://localhost'] }
  const groups = [
    { level: 'MDC', code: 'MDCR', name: '合成循环系统疾病', parentCode: null },
    { level: 'ADRG', code: 'RA1', name: '合成高血压组', parentCode: 'MDCR' },
    { level: 'DRG', code: 'RA15', name: '合成高血压组，不伴合并症或并发症', parentCode: 'RA1' },
    { level: 'ADRG', code: 'RA2', name: '合成PCI介入组', parentCode: 'MDCR' },
    { level: 'DRG', code: 'RA25', name: '合成PCI介入组，不伴合并症或并发症', parentCode: 'RA2' },
  ]
  const jsText = syntheticDrgSource('I10.x09', 'RA15', '00.6600')
  const drgRulesDirectory = join(directory, 'drg-rules')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(drgRulesDirectory, { recursive: true })
  const files = prepareDrgRulesPackage({ groups, jsText, complicationTables: { CC: {}, MCC: {}, CCE: {} },
    input: syntheticDrgIdentity(jsText, groups, { CC: {}, MCC: {}, CCE: {} }),
    releaseId: 'chs-drg-sim-test', sourceVersion: 'CHS-DRG-3.0-sim-test' })
  for (const [name, content] of Object.entries(files)) await writeFile(join(drgRulesDirectory, name), content, 'utf8')
  const runtime = await createClinMeshRuntime({ ...base, drgRulesDirectory })
  cleanups.push(async () => { await runtime.close() })
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
  const registrar = await login('registrar'), doctor = await login('inpatient-doctor'), nurse = await login('ward-nurse'), cashier = await login('cashier')
  const created = await runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: { cookie: registrar, origin: 'http://localhost',
      'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {}, input: {
        name: '合成推演患者', gender: 'male', birthDate: '1960-03-04', identifier: `SYN-${randomUUID()}`
      } }) })
  const patient = (await created.json()).data.patient
  const registered = (await (await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
    patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })).json()).data.admission
  const admission = (await (await request(nurse, `/api/his/v1/inpatient/admissions/${registered.id}/receive`, {
    encounterVersion: registered.versionId, bedId: 'bed-general-1'
  })).json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  const catalog = await (await request(doctor, '/api/his/v1/inpatient/surgery-catalog')).json()
  const clinicalCatalog = await (await request(doctor, '/api/his/v1/inpatient/clinical-catalog')).json()
  return { runtime, request, login, patient, admission, doctor, nurse, cashier, registrar, path, catalog, clinicalCatalog }
}

async function confirmPrimary(s: Awaited<ReturnType<typeof setup>>) {
  const clinical = await (await s.request(s.doctor, `${s.path}/clinical`)).json()
  return s.request(s.doctor, `${s.path}/diagnoses/confirm`, { encounterVersion: clinical.encounterVersion, expectedRevision: clinical.diagnosis.revision,
    entries: [{ catalogItemId: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', role: 'primary', admissionCondition: '1', note: '推演验证诊断' }] })
}

/** 出科到可提交首页：签离→出科→结算→清床。 */
async function finish(s: Awaited<ReturnType<typeof setup>>) {
  const admission = (await (await s.request(s.doctor, s.path)).json()).admission
  const issued = await (await s.request(s.doctor, `${s.path}/discharge/issue`, { encounterVersion: admission.versionId, reason: '治疗完成' })).json()
  expect((await s.request(s.nurse, `${s.path}/discharge/depart`, { encounterVersion: issued.data.admission.versionId, reason: '已核对', departureMethod: 'home' })).status).toBe(200)
  const p = await (await s.request(s.cashier, `${s.path}/discharge/preview`)).json()
  const settled = await (await s.request(s.cashier, `${s.path}/discharge/settle`, { encounterVersion: p.encounterVersion, fingerprint: p.fingerprint,
    expectedChargesFen: p.chargesFen, expectedBalanceFen: p.balanceFen })).json()
  expect((await s.request(s.nurse, `${s.path}/discharge/clear`, { encounterVersion: settled.data.encounterVersion, reason: '床单位已清洁' })).status).toBe(200)
}

describe('住院 DRG 处方推演公共 HTTP', () => {
  it('长期 QD 首次排程前保留未记费承诺，排程和发药后不重复计算', async () => {
    const s = await setup()
    const clinical = inpatientFullClinicalResponseSchema.parse(await (await confirmPrimary(s)).json()).data
    const issued = await s.request(s.doctor, `${s.path}/orders/issue`, {
      encounterVersion: clinical.encounterVersion, duration: 'long',
      selection: { kind: 'medication', catalogItemId: 'medication-amlodipine', catalogVersion: 1,
        doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' },
    })
    expect(issued.status).toBe(200)
    const order = inpatientFullClinicalResponseSchema.parse(await issued.json()).data.orders[0]!
    const simulate = async () => {
      const response = await s.request(s.doctor, `${s.path}/drg/simulation`, {})
      expect(response.status).toBe(200)
      return inpatientDrgSimulationSchema.parse(await response.json())
    }
    const expectedItem = { kind: 'medication', id: order.id, display: order.display, quantity: 1, estimatedFen: 1500 }
    expect((await simulate()).committed.items).toEqual([expectedItem])

    const verified = await s.request(s.nurse, `${s.path}/orders/verify`, { orderId: order.id, expectedOrderVersion: order.version })
    expect(verified.status).toBe(200)
    const checked = inpatientFullClinicalResponseSchema.parse(await verified.json()).data
    expect(checked.orders[0]?.state).toBe('verified')
    expect(checked.executions).toEqual([])
    expect(checked.dispenses).toEqual([])
    const beforeScheduling = await simulate()
    expect(beforeScheduling.committed.items).toEqual([expectedItem])
    expect(beforeScheduling.coverage.estimatedTotalFen).toBe(1500)

    const admin = await s.login('admin')
    expect((await s.request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time', {
      expectedVirtualTime: '2026-08-24T09:00:00+08:00', targetVirtualTime: '2026-08-25T08:00:00+08:00',
    })).status).toBe(200)
    const scheduled = inpatientFullClinicalSchema.parse(await (await s.request(s.doctor, `${s.path}/clinical`)).json())
    expect(scheduled.executions).toHaveLength(1)
    expect((await simulate()).committed.items).toEqual([expectedItem])

    const pharmacist = await s.login('pharmacist')
    const pharmacy = inpatientPharmacySchema.parse(await (await s.request(pharmacist, `${s.path}/pharmacy`)).json())
    const execution = pharmacy.executions[0]!, lot = pharmacy.medications.find(item => item.id === 'medication-amlodipine')!.lots[0]!
    const supplied = await s.request(pharmacist, `${s.path}/executions/dispense`, {
      executionId: execution.id, expectedExecutionVersion: execution.version,
      lotSelections: [{ lotId: lot.id, expectedVersion: lot.version, quantity: 1 }],
    })
    expect(supplied.status).toBe(200)
    expect(inpatientPharmacyResponseSchema.parse(await supplied.json()).data.executions[0]?.status).toBe('dispensed')
    const afterDispense = await simulate()
    expect(afterDispense.committed.items).toEqual([])
    expect(afterDispense.formal.items).toContainEqual(expect.objectContaining({ kind: 'medication', quantity: 1, estimatedFen: 1500 }))
    expect(afterDispense.coverage.estimatedTotalFen).toBe(afterDispense.formal.chargesFen)
  })

  it('相同事实的不同住院不能复用审阅指纹', async () => {
    const s = await setup()
    const service = s.clinicalCatalog.services[0]
    const draft = { medications: [], services: [{ serviceId: service.id, serviceVersion: service.version, quantity: 1 }] }
    const first = inpatientDrgSimulationSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/simulation`, draft)).json())
    const created = await s.runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: {
      cookie: s.registrar, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID(),
    }, body: JSON.stringify({ expectedVersions: {}, input: {
      name: '合成同龄患者', gender: 'male', birthDate: '1960-03-04', identifier: `SYN-${randomUUID()}`,
    } }) })
    expect(created.status).toBe(200)
    const patient = createPatientResponseSchema.parse(await created.json()).data.patient
    const registered = await s.request(s.registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1',
      patientId: patient.id, patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })
    expect(registered.status).toBe(200)
    const admission = inpatientCommandResponseSchema.parse(await registered.json()).data.admission
    const path = `/api/his/v1/inpatient/admissions/${admission.id}`
    const received = await s.request(s.nurse, `${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-2' })
    expect(received.status).toBe(200)
    const second = inpatientCommandResponseSchema.parse(await received.json()).data.admission
    const evaluated = inpatientDrgSimulationSchema.parse(await (await s.request(s.doctor, `${path}/drg/simulation`, draft)).json())
    expect(evaluated.fingerprint).not.toBe(first.fingerprint)
    const stale = await s.request(s.doctor, `${path}/orders/issue`, { encounterVersion: second.versionId, duration: 'temporary',
      selection: { kind: 'service', serviceId: service.id, serviceVersion: service.version, quantity: 1 }, expectedDrgFingerprint: first.fingerprint })
    expect(stale.status).toBe(409)
    expect(apiErrorSchema.parse(await stale.json()).error.code).toBe('INPATIENT_DRG_EVALUATION_STALE')
  })

  it('开具前重验审阅指纹，其他医嘱使旧评估过期，更新后重试仅产生一条医嘱', async () => {
    const s = await setup()
    expect((await confirmPrimary(s)).status).toBe(200)
    const service = s.clinicalCatalog.services[0]
    const selection = { kind: 'service', serviceId: service.id, serviceVersion: service.version, quantity: 1 }
    const draft = { medications: [], services: [{ serviceId: service.id, serviceVersion: service.version, quantity: 1 }] }
    const evaluated = await (await s.request(s.doctor, `${s.path}/drg/simulation`, draft)).json()
    const admission = (await (await s.request(s.doctor, s.path)).json()).admission
    expect((await s.request(s.doctor, `${s.path}/orders/issue`, {
      encounterVersion: admission.versionId, duration: 'temporary', selection,
    })).status).toBe(200)
    const stale = await s.request(s.doctor, `${s.path}/orders/issue`, {
      encounterVersion: admission.versionId, duration: 'temporary', selection, expectedDrgFingerprint: evaluated.fingerprint,
    })
    expect(stale.status).toBe(409)
    expect((await stale.json()).error.code).toBe('INPATIENT_DRG_EVALUATION_STALE')
    const before = await (await s.request(s.doctor, `${s.path}/clinical`)).json()
    expect(before.orders).toHaveLength(1)
    const fresh = await (await s.request(s.doctor, `${s.path}/drg/simulation`, draft)).json()
    const key = randomUUID()
    const input = { encounterVersion: admission.versionId, duration: 'temporary', selection, expectedDrgFingerprint: fresh.fingerprint }
    const accepted = await s.request(s.doctor, `${s.path}/orders/issue`, input, key)
    expect(accepted.status).toBe(200)
    const receipt = await accepted.json()
    expect(await (await s.request(s.doctor, `${s.path}/orders/issue`, input, key)).json()).toEqual(receipt)
    expect((await (await s.request(s.doctor, `${s.path}/clinical`)).json()).orders).toHaveLength(2)
  })

  it('草稿逐项计价、缺项显式标注、指纹稳定且开具后过期', async () => {
    const s = await setup()
    expect((await confirmPrimary(s)).status).toBe(200)
    const baseline = await (await s.request(s.doctor, `${s.path}/drg/simulation`, {})).json()
    expect(baseline.formal.chargesFen).toBe(0)
    expect(baseline.grouping.formal).toMatchObject({ status: 'grouped', drgCode: 'RA15' })
    expect(baseline.grouping.projected).toBeNull()
    expect(baseline.incompleteness).toEqual({ costMissing: true, paymentReferenceMissing: false })
    expect(baseline.paymentReference).toMatchObject({ drgCode: 'RA15', referenceFen: 300_000,
      parameterSetId: 'clinmesh-synthetic-hospital-drg-payment', parameterVersion: '2026-demo-3' })
    const again = await (await s.request(s.doctor, `${s.path}/drg/simulation`, {})).json()
    expect(again.fingerprint).toBe(baseline.fingerprint)
    const medication = s.clinicalCatalog.medications.find((item: { id: string }) => item.id === 'medication-amlodipine')!
      , service = s.clinicalCatalog.services[0]
    const draft = { medications: [{ catalogItemId: medication.id, catalogVersion: medication.version, doseText: '5 mg', frequencyCode: 'QD', doseQuantity: 1 },
        { catalogItemId: 'no-such-medication', catalogVersion: 1, doseText: '1g', frequencyCode: 'BID', doseQuantity: 1 }],
      services: [{ serviceId: service.id, serviceVersion: service.version, quantity: 3 }, { serviceId: 'no-such-service', serviceVersion: 1, quantity: 1 }] }
    const simulated = await (await s.request(s.doctor, `${s.path}/drg/simulation`, draft)).json()
    expect(simulated.draft.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'medication', id: medication.id, quantity: 1, estimatedFen: medication.priceFen }),
      expect.objectContaining({ kind: 'service', id: service.id, quantity: 3, estimatedFen: service.priceFen * 3 }),
    ]))
    expect(simulated.draft.missing).toEqual([{ kind: 'medication', id: 'no-such-medication' }, { kind: 'service', id: 'no-such-service' }])
    expect(simulated.fingerprint).not.toBe(baseline.fingerprint)
    // 未记费承诺：开具医嘱后推演出现 committed 条目且指纹过期；服务端重验不产生重复评估事实。
    const fresh = (await (await s.request(s.doctor, s.path)).json()).admission
    expect((await s.request(s.doctor, `${s.path}/orders/issue`, { encounterVersion: fresh.versionId, duration: 'temporary',
      selection: { kind: 'service', serviceId: service.id, serviceVersion: service.version, quantity: 3 } })).status).toBe(200)
    const afterIssue = await (await s.request(s.doctor, `${s.path}/drg/simulation`, draft)).json()
    expect(afterIssue.committed.items).toContainEqual(expect.objectContaining({ kind: 'service', id: expect.any(String),
      quantity: 3, estimatedFen: service.priceFen * 3 }))
    expect(afterIssue.fingerprint).not.toBe(simulated.fingerprint)
    for (const cookie of [s.nurse, s.cashier, s.registrar]) expect((await s.request(cookie, `${s.path}/drg/simulation`, {})).status).toBe(403)
    const coder = await s.login('medical-records')
    expect((await s.request(coder, `${s.path}/drg/simulation`, {})).status).toBe(200)
  })

  it('计划手术进入未记费承诺并给出「若实施」推演分组，不改正式病组', async () => {
    const s = await setup()
    expect((await confirmPrimary(s)).status).toBe(200)
    const procedure = s.catalog.procedures[0]
    const current = (await (await s.request(s.doctor, s.path)).json()).admission
    const requested = await s.request(s.doctor, `${s.path}/surgeries/request`, { encounterVersion: current.versionId,
      procedureId: procedure.id, catalogVersion: procedure.version, plannedFor: '2026-08-24T15:00:00+08:00', reason: '合成PCI推演' })
    expect(requested.status).toBe(200)
    const request = (await requested.json()).data.requests[0]
    const simulated = await (await s.request(s.doctor, `${s.path}/drg/simulation`, {})).json()
    expect(simulated.committed.items).toContainEqual({ kind: 'surgery', id: request.id, display: procedure.coding.display, quantity: 1,
      estimatedFen: procedure.chargeDefinition.priceFen })
    expect(simulated.grouping.formal).toMatchObject({ status: 'grouped', drgCode: 'RA15' })
    expect(simulated.grouping.projected).toMatchObject({ status: 'grouped', drgCode: 'RA25', adrgCode: 'RA2' })
  })

  it('多计划推演须明确主计划，选择只改变假想主次并绑定评估指纹', async () => {
    const s = await setup()
    expect((await confirmPrimary(s)).status).toBe(200)
    const procedure = s.catalog.procedures[0]
    const ids: string[] = []
    for (let index = 0; index < 2; index += 1) {
      const admission = (await (await s.request(s.doctor, s.path)).json()).admission
      const response = await s.request(s.doctor, `${s.path}/surgeries/request`, { encounterVersion: admission.versionId,
        procedureId: procedure.id, catalogVersion: procedure.version, plannedFor: '2026-08-24T15:00:00+08:00', reason: `合成计划${index}` })
      expect(response.status).toBe(200)
      const requests = (await response.json()).data.requests
      ids.push(requests.find((request: { id: string }) => !ids.includes(request.id)).id)
    }
    const unresolved = inpatientDrgSimulationSchema.parse(await (await s.request(s.doctor, `${s.path}/drg/simulation`, {})).json())
    expect(unresolved.grouping.projected).toMatchObject({ status: 'invalid-input' })
    const selectedResponse = await s.request(s.doctor, `${s.path}/drg/simulation`, { primarySurgeryRequestId: ids[0] })
    expect(selectedResponse.status).toBe(200)
    const selected = inpatientDrgSimulationSchema.parse(await selectedResponse.json())
    expect(selected.grouping.formal).toEqual(unresolved.grouping.formal)
    expect(selected.grouping.projected).toMatchObject({ status: 'grouped', drgCode: 'RA25' })
    expect(selected.fingerprint).not.toBe(unresolved.fingerprint)
    const missing = await s.request(s.doctor, `${s.path}/drg/simulation`, { primarySurgeryRequestId: 'missing-request' })
    expect(missing.status).toBe(409)
    expect(apiErrorSchema.parse(await missing.json()).error.code).toBe('INPATIENT_DRG_PLAN_CONFLICT')
  })

  it('预留替换不双计：执行时一次转为实际使用，替换后释放被拒绝', async () => {
    const s = await setup()
    expect((await confirmPrimary(s)).status).toBe(200)
    const procedure = s.catalog.procedures[0], material = s.catalog.materials[0]
    const current = (await (await s.request(s.doctor, s.path)).json()).admission
    const request = (await (await s.request(s.doctor, `${s.path}/surgeries/request`, { encounterVersion: current.versionId,
      procedureId: procedure.id, catalogVersion: procedure.version, plannedFor: '2026-08-24T15:00:00+08:00', reason: '合成PCI实施' })).json()).data.requests[0]
    const reserved = await s.request(s.doctor, `${s.path}/drg/reservations`, { encounterVersion: (await (await s.request(s.doctor, s.path)).json()).admission.versionId,
      materialId: material.id, catalogVersion: material.version, quantity: 2, requestId: request.id, reason: 'PCI耗材预留' })
    expect(reserved.status).toBe(200)
    const reservation = (await reserved.json()).data.reservations[0]
    expect(reservation).toMatchObject({ status: 'reserved', quantity: 2, priceFen: material.chargeDefinition.priceFen, requestId: request.id })
    let simulated = await (await s.request(s.doctor, `${s.path}/drg/simulation`, {})).json()
    expect(simulated.reserved.items).toContainEqual({ kind: 'material', id: reservation.id, display: material.display, quantity: 2,
      estimatedFen: material.chargeDefinition.priceFen * 2 })
    for (const [cookie, action] of [[s.nurse, 'check-preop'], [s.doctor, 'confirm-consent']] as const) {
      const version = (await (await s.request(s.doctor, `${s.path}/surgeries`)).json()).requests[0].version
      expect((await s.request(cookie, `${s.path}/surgeries/${action}`, { requestId: request.id, expectedRequestVersion: version, note: '合成准备完成' })).status).toBe(200)
    }
    // 跨目录版本置换被拒：预留冻结的是 v1 目录价，须按预留原版本替换。
    const stale = await s.request(s.doctor, `${s.path}/surgeries/execute`, { requestId: request.id,
      expectedRequestVersion: (await (await s.request(s.doctor, `${s.path}/surgeries`)).json()).requests[0].version,
      procedureId: procedure.id, catalogVersion: procedure.version, note: '跨版本置换验证',
      materials: [{ materialId: material.id, catalogVersion: material.version + 1, quantity: 2, reservationId: reservation.id }] })
    expect(stale.status).toBe(409)
    expect((await stale.json()).error.code).toBe('INPATIENT_RESERVATION_CONFLICT')
    const executed = await s.request(s.doctor, `${s.path}/surgeries/execute`, { requestId: request.id,
      expectedRequestVersion: (await (await s.request(s.doctor, `${s.path}/surgeries`)).json()).requests[0].version,
      procedureId: procedure.id, catalogVersion: procedure.version, note: '合成实际实施完成', materials: [{ materialId: material.id, catalogVersion: material.version, quantity: 2, reservationId: reservation.id }] })
    expect(executed.status).toBe(200)
    const execution = (await executed.json()).data.executions[0]
    // 首页修订显式确认主操作后，正式分组才切换到手术口径。
    await finish(s)
    const record = await (await s.request(s.doctor, `${s.path}/record`)).json()
    expect((await s.request(s.doctor, `${s.path}/record/submit`, { expectedRevision: 0, expectedSourcesHash: record.sourcesHash,
      mainProcedureExecutionId: execution.id })).status).toBe(200)
    const replaced = (await (await s.request(s.doctor, `${s.path}/drg/reservations`)).json()).reservations[0]
    expect(replaced).toMatchObject({ status: 'replaced', replacedByMaterialUseId: expect.any(String) })
    simulated = await (await s.request(s.doctor, `${s.path}/drg/simulation`, {})).json()
    expect(simulated.reserved.items).toEqual([])
    expect(simulated.formal.items.filter((item: { kind: string }) => item.kind === 'material')).toEqual([
      { kind: 'material', id: expect.any(String), display: material.display, quantity: 2, estimatedFen: material.chargeDefinition.priceFen * 2 }])
    expect(simulated.grouping.formal).toMatchObject({ status: 'grouped', drgCode: 'RA25' })
    const released = await s.request(s.doctor, `${s.path}/drg/reservations/${reservation.id}/release`, { encounterVersion: (await (await s.request(s.doctor, s.path)).json()).admission.versionId, reason: '重复释放重验' })
    expect(released.status).toBe(409)
    expect((await released.json()).error.code).toBe('INPATIENT_RESERVATION_CONFLICT')
    expect((await s.request(s.cashier, `${s.path}/drg/reservations`, { encounterVersion: '1', materialId: material.id,
      catalogVersion: material.version, quantity: 1, reason: '越岗验证' })).status).toBe(403)
  })

  it('床位费等正式收费进入推演 formal 条目', async () => {
    const s = await setup()
    expect((await confirmPrimary(s)).status).toBe(200)
    // 推进虚拟时钟跨上海时区午夜，按日产生床位费正式收费。
    const admin = await s.login('admin')
    const clock = await (await s.request(admin, '/api/sim/v1/scenario-runs/current')).json()
    expect((await s.request(admin, '/api/sim/v1/scenario-runs/scenario-run-1/actions/advance-time',
      { expectedVirtualTime: clock.virtualTime, targetVirtualTime: '2026-08-25T01:00:00.000Z' })).status).toBe(200)
    const simulated = await (await s.request(s.doctor, `${s.path}/drg/simulation`, {})).json()
    expect(simulated.formal.chargesFen).toBeGreaterThan(0)
    expect(simulated.formal.items).toContainEqual(expect.objectContaining({ kind: 'bed', display: '住院床位费', quantity: 1 }))
  })

  it('execute 校验多项无预留耗材合法，重复引用同一预留仍被拒绝', () => {
    const base = { admissionId: 'admission-1', requestId: 'request-1', expectedRequestVersion: 1, procedureId: 'procedure-1', catalogVersion: 1, note: '合成校验' }
    const material = (materialId: string) => ({ materialId, catalogVersion: 1, quantity: 1 })
    expect(inpatientSurgeryExecuteInputSchema.safeParse({ ...base, materials: [material('material-a'), material('material-b')] }).success).toBe(true)
    expect(inpatientSurgeryExecuteInputSchema.safeParse({ ...base,
      materials: [material('material-a'), { ...material('material-b'), reservationId: 'reservation-1' }, { ...material('material-c'), reservationId: 'reservation-1' }] }).success).toBe(false)
  })
})
