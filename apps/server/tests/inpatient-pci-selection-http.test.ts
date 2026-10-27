import { inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { addSecondaryInpatientWard } from './fixtures/inpatient-secondary-ward.ts'
import { apiErrorSchema } from '@clinmesh/contracts/his'
import { inpatientPciSelectionSchema, inpatientPciSelectionResponseSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createClinMeshRuntime, type CreateClinMeshRuntimeOptions } from '../src/runtime.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-pci-selection-'))
  const password = `Test-${randomUUID()}-Aa1!`
  const options: CreateClinMeshRuntimeOptions = { authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters',
    cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'hospital.sqlite'), demoPassword: password,
    migrationMode: 'apply', trustedOrigins: ['http://localhost'] }
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
  const registrar = await login('registrar'), doctor = await login('inpatient-doctor'), nurse = await login('ward-nurse'), cashier = await login('cashier')
  const created = await runtime.app.request('/api/his/v1/patients', { method: 'POST', headers: { cookie: registrar, origin: 'http://localhost',
    'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ expectedVersions: {}, input: {
      name: '合成手术患者', gender: 'female', birthDate: '1980-01-01', identifier: `SYN-${randomUUID()}` } }) })
  const patient = (await created.json()).data.patient
  const registered = (await (await request(registrar, '/api/his/v1/inpatient/admissions', { expectedEpoch: 'epoch-1', patientId: patient.id,
    patientVersion: patient.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000 })).json()).data.admission
  const admission = (await (await request(nurse, `/api/his/v1/inpatient/admissions/${registered.id}/receive`, {
    encounterVersion: registered.versionId, bedId: 'bed-general-1' })).json()).data.admission
  return { runtime, options, request, login, patient, admission, doctor, nurse, cashier, registrar, restart: async () => { await runtime.close(); runtime = await createClinMeshRuntime(options) }, path: `/api/his/v1/inpatient/admissions/${admission.id}` }
}

const parameters = {
  treatmentPlan: '择期单病变 PCI，医生确认合成治疗方案', targetSite: 'LAD 中段',
  measurements: [
    { kind: 'lesion-length', object: 'lesion', site: 'LAD 中段', value: 12, unit: 'mm', method: 'IVUS 电动回撤', source: { reference: 'synthetic-report-1', version: '1', note: '合成测量依据', synthetic: true } },
    { kind: 'proximal-reference-diameter', object: 'reference-lumen', site: 'LAD 近端参考段', value: 3, unit: 'mm', method: 'IVUS', source: { reference: 'synthetic-report-1', version: '1', note: '合成近端测量', synthetic: true } },
    { kind: 'distal-reference-diameter', object: 'reference-lumen', site: 'LAD 远端参考段', value: 3, unit: 'mm', method: 'IVUS', source: { reference: 'synthetic-report-1', version: '1', note: '合成远端测量', synthetic: true } },
  ],
  plannedQuantities: ['guidewire', 'guiding-catheter', 'balloon', 'stent'].map(category => ({ category, quantity: 1, basis: '医生确认本次合成单病变计划各一件' })),
  approvedMaterialIds: ['hospital-material-pci-guidewire', 'hospital-material-pci-guiding-catheter', 'hospital-material-pci-balloon', 'hospital-material-pci-stent'],
}

it('公开入口确认本次住院参数，保留来源与版本且刷新不丢失', async () => {
  const s = await setup()
  const before = await s.request(s.doctor, `${s.path}/pci-selection`)
  expect(before.status).toBe(200)
  expect(inpatientPciSelectionSchema.parse(await before.json())).toMatchObject({ admissionId: s.admission.id, confirmation: null, history: [] })
  const confirmed = await s.request(s.doctor, `${s.path}/pci-selection/confirm`, { expectedVersion: 0, parameters })
  expect(confirmed.status).toBe(200)
  const body = inpatientPciSelectionResponseSchema.parse(await confirmed.json())
  expect(body.data.confirmation).toMatchObject({ version: 1, parameters, confirmedBy: expect.any(String), confirmedAt: expect.any(String) })
  const refreshed = await s.request(s.doctor, `${s.path}/pci-selection`)
  expect(inpatientPciSelectionSchema.parse(await refreshed.json())).toEqual(body.data)
})

it('未安装候选不能推荐；安装后已确认的合成参数产生可核验候选及独立数量依据', async () => {
  const s = await setup()
  await s.request(s.doctor, `${s.path}/pci-selection/confirm`, { expectedVersion: 0, parameters })
  const before = inpatientPciSelectionSchema.parse(await (await s.request(s.doctor, `${s.path}/pci-selection`)).json())
  expect(before.candidates).toHaveLength(4)
  expect(before.candidates.every((candidate: { eligibility: string }) => candidate.eligibility === 'unavailable')).toBe(true)
  const admin = await s.login('admin')
  expect((await s.request(admin, '/api/his/v1/inpatient/pci-data/prepare', { expectedEpoch: 'epoch-1' })).status).toBe(200)
  const installed = inpatientPciSelectionSchema.parse(await (await s.request(s.doctor, `${s.path}/pci-selection`)).json())
  expect(installed.evidencePackage).toMatchObject({ id: 'clinmesh-pci-selection-evidence', version: '2026-10-27.r1', synthetic: true })
  expect(installed.candidates.map((candidate: { eligibility: string; expectedQuantity: number }) => [candidate.eligibility, candidate.expectedQuantity])).toEqual([
    ['valid', 1], ['valid', 1], ['valid', 1], ['valid', 1],
  ])
  expect(installed.candidates[3]).toMatchObject({ materialId: 'hospital-material-pci-stent', materialVersion: 1,
    evidence: { synthetic: true, specification: '药物洗脱支架，3.0×18 mm，合成院内规格', compatibility: expect.stringContaining('合成') },
    item: { id: 'hospital-material-pci-stent', version: 1, chargeDefinition: { unit: '枚' } }, expectedQuantity: 1,
  })
  expect(installed.candidates.every((candidate: { missing: unknown[]; expectedAmountFen: number }) => candidate.missing.length === 0 && candidate.expectedAmountFen > 0)).toBe(true)
})

it('未知与矛盾测量、缺单位和未认可候选均保留缺项，不由规格反推参数', async () => {
  const s = await setup(), admin = await s.login('admin')
  await s.request(admin, '/api/his/v1/inpatient/pci-data/prepare', { expectedEpoch: 'epoch-1' })
  const empty = inpatientPciSelectionSchema.parse(await (await s.request(s.doctor, `${s.path}/pci-selection`)).json())
  expect(empty.candidates.every((candidate: { eligibility: string }) => candidate.eligibility === 'incomplete')).toBe(true)
  const unknown = structuredClone(parameters)
  unknown.measurements = []
  unknown.approvedMaterialIds = []
  await s.request(s.doctor, `${s.path}/pci-selection/confirm`, { expectedVersion: 0, parameters: unknown })
  const missing = inpatientPciSelectionSchema.parse(await (await s.request(s.doctor, `${s.path}/pci-selection`)).json())
  expect(missing.confirmation.parameters.measurements).toEqual([])
  expect(missing.candidates.every((candidate: { eligibility: string; missing: string[] }) => candidate.eligibility === 'incomplete' && candidate.missing.some(reason => reason.includes('测量')))).toBe(true)
  const contradictory = structuredClone(parameters)
  contradictory.measurements[1]!.object = 'external-elastic-membrane'
  contradictory.measurements[2]!.unit = 'cm'
  const updated = await s.request(s.doctor, `${s.path}/pci-selection/confirm`, { expectedVersion: 1, parameters: contradictory })
  expect(updated.status).toBe(200)
  const body = inpatientPciSelectionResponseSchema.parse(await updated.json())
  expect(body.data.candidates.every((candidate: { eligibility: string; missing: string[] }) => candidate.eligibility === 'inapplicable' && candidate.missing.some(reason => reason.includes('测量对象')) && candidate.missing.some(reason => reason.includes('单位')))).toBe(true)
  expect(body.data.history).toHaveLength(2)
  expect(body.data.history[1].parameters.measurements).toEqual([])
})


it('重复确认重放同一回执，旧版本冲突，新版本保留历史且重启后仍可读', async () => {
  const s = await setup(), key = randomUUID(), input = { expectedVersion: 0, parameters }
  const first = inpatientPciSelectionResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/pci-selection/confirm`, input, key)).json())
  const replay = inpatientPciSelectionResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/pci-selection/confirm`, input, key)).json())
  expect(replay).toEqual(first)
  const conflict = await s.request(s.doctor, `${s.path}/pci-selection/confirm`, input)
  expect(conflict.status).toBe(409)
  expect(apiErrorSchema.parse(await conflict.json()).error.code).toBe('INPATIENT_PCI_SELECTION_CONFLICT')
  const updated = inpatientPciSelectionResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/pci-selection/confirm`, {
    expectedVersion: 1, parameters: { ...parameters, treatmentPlan: '医生修订的合成计划' },
  })).json())
  expect(updated.data.confirmation).toMatchObject({ id: first.data.confirmation!.id, version: 2 })
  expect(updated.data.history.map(item => item.version)).toEqual([2, 1])
  await s.restart()
  const persisted = inpatientPciSelectionSchema.parse(await (await s.request(s.doctor, `${s.path}/pci-selection`)).json())
  expect(persisted).toEqual(updated.data)
})

it('公开确认拒绝错误岗位、跨责任病区和不受信Origin，并保留原参数', async () => {
  const s = await setup(), input = { expectedVersion: 0, parameters }
  for (const cookie of [s.nurse, s.cashier, s.registrar]) {
    const rejected = await s.request(cookie, `${s.path}/pci-selection/confirm`, input)
    expect(rejected.status).toBe(403)
    apiErrorSchema.parse(await rejected.json())
  }
  for (const origin of [undefined, 'https://untrusted.example']) {
    const rejected = await s.runtime.app.request(`${s.path}/pci-selection/confirm`, { method: 'POST',
      headers: { cookie: s.doctor, 'content-type': 'application/json', 'idempotency-key': randomUUID(), ...(origin === undefined ? {} : { origin }) }, body: JSON.stringify({ input }) })
    expect(rejected.status).toBe(403)
    expect(apiErrorSchema.parse(await rejected.json()).error.code).toBe('CSRF_REJECTED')
  }
  expect((await s.request(s.cashier, `${s.path}/pci-selection`)).status).toBe(403)
  await addSecondaryInpatientWard(s.runtime)
  const switched = await s.runtime.app.request('/api/auth/role', { method: 'POST', headers: { cookie: s.doctor, origin: 'http://localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ practitionerRoleId: 'practitioner-role-inpatient-doctor-surgery' }) })
  expect(switched.status).toBe(200)
  for (const response of [await s.request(s.doctor, `${s.path}/pci-selection`), await s.request(s.doctor, `${s.path}/pci-selection/confirm`, input)]) {
    expect(response.status).toBe(403)
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('INPATIENT_SCOPE_FORBIDDEN')
  }
  const nurseRead = inpatientPciSelectionSchema.parse(await (await s.request(s.nurse, `${s.path}/pci-selection`)).json())
  expect(nurseRead.confirmation).toBeNull()
})

it('独立反对照覆盖仿真边界、未认可、缺单位与目录版本漂移', async () => {
  const s = await setup(), admin = await s.login('admin')
  await s.request(admin, '/api/his/v1/inpatient/pci-data/prepare', { expectedEpoch: 'epoch-1' })
  const negative = [
    { ...parameters, measurements: parameters.measurements.map(item => item.kind === 'lesion-length' ? { ...item, value: 17 } : item) },
    { ...parameters, measurements: parameters.measurements.map(item => item.kind === 'proximal-reference-diameter' ? { ...item, value: 3.1 } : item) },
    { ...parameters, measurements: parameters.measurements.map(item => ({ ...item, unit: null })) },
    { ...parameters, approvedMaterialIds: [] },
    { ...parameters, plannedQuantities: parameters.plannedQuantities.map(item => ({ ...item, quantity: 2 })) },
  ]
  for (const [index, values] of negative.entries()) {
    const result = inpatientPciSelectionResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/pci-selection/confirm`, { expectedVersion: index, parameters: values })).json())
    expect(result.data.candidates.every(item => item.eligibility === (index === 2 || index === 3 ? 'incomplete' : 'inapplicable'))).toBe(true)
  }
  const boundary = { ...parameters, measurements: parameters.measurements.map(item => item.kind === 'lesion-length' ? { ...item, value: 16 } : item) }
  const valid = inpatientPciSelectionResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/pci-selection/confirm`, { expectedVersion: negative.length, parameters: boundary })).json())
  expect(valid.data.candidates.every(item => item.eligibility === 'valid')).toBe(true)
  s.runtime.database.driver.prepare("UPDATE inpatient_surgery_catalog SET version=2,snapshot_json=json_set(snapshot_json,'$.version',2) WHERE item_id='hospital-material-pci-stent'").run()
  const drift = inpatientPciSelectionSchema.parse(await (await s.request(s.doctor, `${s.path}/pci-selection`)).json())
  expect(drift.candidates.find(item => item.category === 'stent')).toMatchObject({ eligibility: 'unavailable', item: null })
  expect(drift.candidates.filter(item => item.category !== 'stent').every(item => item.eligibility === 'incomplete')).toBe(true)
})

it.each([0, Number.MAX_SAFE_INTEGER])('院内价%s未形成可用预计金额时返回null与具体缺项，整个公开读取仍可用', async priceFen => {
  const s = await setup(), admin = await s.login('admin')
  await s.request(admin, '/api/his/v1/inpatient/pci-data/prepare', { expectedEpoch: 'epoch-1' })
  const input = { expectedVersion: 0, parameters: { ...parameters,
    plannedQuantities: parameters.plannedQuantities.map(item => item.category === 'stent' ? { ...item, quantity: 2 } : item) } }
  const confirmed = await s.request(s.doctor, `${s.path}/pci-selection/confirm`, input)
  expect(confirmed.status).toBe(200)
  inpatientPciSelectionResponseSchema.parse(await confirmed.json())
  s.runtime.database.driver.prepare("UPDATE inpatient_surgery_catalog SET snapshot_json=json_set(snapshot_json,'$.chargeDefinition.priceFen',?) WHERE item_id='hospital-material-pci-stent'").run(priceFen)
  const response = await s.request(s.doctor, `${s.path}/pci-selection`)
  expect(response.status).toBe(200)
  const read = inpatientPciSelectionSchema.parse(await response.json())
  const stent = read.candidates.find(item => item.category === 'stent')!
  expect(stent.expectedAmountFen).toBeNull()
  expect(stent.missing).toContain(priceFen === 0 ? '缺少有效正数院内收费价' : '预计收费超出安全整数范围')
  expect(read.candidates.filter(item => item.category !== 'stent').every(item => item.eligibility === 'valid' && item.expectedAmountFen !== null)).toBe(true)
})


it('参数关联只接受本次有效PCI计划，其他术式不能混作PCI依据', async () => {
  const s = await setup()
  const create = async (procedureId: string) => inpatientSurgeryResponseSchema.parse(await (await s.request(s.doctor, `${s.path}/surgeries/request`, {
    encounterVersion: s.admission.versionId, procedureId, catalogVersion: 1, plannedFor: '2026-08-25T09:00:00+08:00', reason: '合成关联计划',
  })).json())
  const other = await create('hospital-surgery-4')
  const rejected = await s.request(s.doctor, `${s.path}/pci-selection/confirm`, { expectedVersion: 0, parameters: { ...parameters, requestId: other.data.requests[0]!.id } })
  expect(rejected.status).toBe(409)
  expect(apiErrorSchema.parse(await rejected.json()).error.code).toBe('INPATIENT_SURGERY_CONFLICT')
  const pci = await create('hospital-surgery-3')
  const requestId = pci.data.requests.find(item => item.plannedProcedure.id === 'hospital-surgery-3')!.id
  const accepted = await s.request(s.doctor, `${s.path}/pci-selection/confirm`, { expectedVersion: 0, parameters: { ...parameters, requestId } })
  expect(accepted.status).toBe(200)
  expect(inpatientPciSelectionResponseSchema.parse(await accepted.json()).data.confirmation?.parameters.requestId).toBe(requestId)
})
