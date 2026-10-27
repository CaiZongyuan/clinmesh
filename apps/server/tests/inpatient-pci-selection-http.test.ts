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
  const runtime = await createClinMeshRuntime(options)
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
  return { runtime, options, request, login, patient, admission, doctor, nurse, cashier, registrar, path: `/api/his/v1/inpatient/admissions/${admission.id}` }
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
