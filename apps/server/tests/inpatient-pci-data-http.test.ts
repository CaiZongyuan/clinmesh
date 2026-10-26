import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { inpatientPciDataSchema, inpatientPciDataResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { clinicalCatalogSchema, sessionContextSchema } from '@clinmesh/contracts/his'
import { inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { inpatientCatalogSearchSchema } from '@clinmesh/contracts/inpatient-clinical'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-pci-data-http-'))
  const password = `Synthetic-${randomUUID()}-Aa1!`
  const runtime = await createClinMeshRuntime({
    authBaseUrl: 'http://localhost', authSecret: randomUUID() + randomUUID(),
    cursorSecret: randomUUID() + randomUUID(), demoPassword: password,
    databasePath: join(directory, 'hospital.sqlite'), migrationMode: 'apply',
    trustedOrigins: ['http://localhost'],
  })
  cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true }) })
  async function login(name: string) {
    const response = await runtime.app.request('/api/auth/sign-in/email', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ email: `${name}@demo.clinmesh.local`, password }),
    })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';', 1)[0]!
  }
  return { runtime, login }
}

it('公开住院 PCI 资料读取入口只向管理员和住院医生开放', async () => {
  const { runtime, login } = await setup()
  for (const role of ['admin', 'inpatient-doctor']) {
    const response = await runtime.app.request('/api/his/v1/inpatient/pci-data', { headers: { cookie: await login(role) } })
    expect(response.status).toBe(200)
  }
  for (const role of ['ward-nurse', 'pharmacist', 'cashier']) {
    const response = await runtime.app.request('/api/his/v1/inpatient/pci-data', { headers: { cookie: await login(role) } })
    expect(response.status).toBe(403)
  }
})

it('准备入口验证 Origin、当前场景及管理员，原键回放和新键补缺都不重复增加库存', async () => {
  const { runtime, login } = await setup()
  const admin = await login('admin'), doctor = await login('inpatient-doctor'), registrar = await login('registrar')
  const context = sessionContextSchema.parse(await (await runtime.app.request('/api/auth/context', { headers: { cookie: admin } })).json())
  const input = { expectedEpoch: context.actor.epoch }
  const prepare = (cookie: string, body: unknown, key = randomUUID(), origin: string | null = 'http://localhost') =>
    runtime.app.request('/api/his/v1/inpatient/pci-data/prepare', { method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'idempotency-key': key, ...(origin === null ? {} : { origin }) },
      body: JSON.stringify({ input: body }),
    })
  const read = async () => inpatientPciDataSchema.parse(await (await runtime.app.request('/api/his/v1/inpatient/pci-data', { headers: { cookie: doctor } })).json())
  const admissions = async () => inpatientListSchema.parse(await (await runtime.app.request('/api/his/v1/inpatient/admissions', { headers: { cookie: registrar } })).json())
  const before = await read(), originalAdmissions = await admissions()
  expect((await prepare(doctor, input)).status).toBe(403)
  expect((await prepare(admin, input, randomUUID(), null)).status).toBe(403)
  expect((await prepare(admin, input, randomUUID(), 'https://untrusted.example')).status).toBe(403)
  const stale = await prepare(admin, { expectedEpoch: 'different-epoch' })
  expect(stale.status).toBe(409)
  expect(await stale.json()).toMatchObject({ error: { code: 'INPATIENT_PCI_EPOCH_CONFLICT' } })
  expect((await prepare(admin, { ...input, patientId: 'injected-patient' })).status).toBe(400)
  expect(await read()).toEqual(before)

  const key = randomUUID()
  const first = await prepare(admin, input, key)
  expect(first.status).toBe(200)
  const prepared = inpatientPciDataResponseSchema.parse(await first.json())
  expect(prepared.data.contentHash).toBe(before.contentHash)
  expect(prepared.data.installed.medications).toHaveLength(before.package.medications.length)
  expect(prepared.data.installed.medications.every(item => item.lots.length === 1)).toBe(true)
  const replay = inpatientPciDataResponseSchema.parse(await (await prepare(admin, input, key)).json())
  expect(replay.auditId).toBe(prepared.auditId)
  expect(replay.data).toEqual(prepared.data)
  const repeated = inpatientPciDataResponseSchema.parse(await (await prepare(admin, input)).json())
  expect(repeated.effects).toEqual([])
  expect(repeated.data.installed).toEqual(prepared.data.installed)
  expect(await admissions()).toEqual(originalAdmissions)
})

it('准备的 PCI 药品和检验能从实际住院目录选用', async () => {
  const { runtime, login } = await setup()
  const admin = await login('admin'), doctor = await login('inpatient-doctor')
  const context = sessionContextSchema.parse(await (await runtime.app.request('/api/auth/context', { headers: { cookie: admin } })).json())
  const response = await runtime.app.request('/api/his/v1/inpatient/pci-data/prepare', { method: 'POST',
    headers: { cookie: admin, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ input: { expectedEpoch: context.actor.epoch } }),
  })
  expect(response.status).toBe(200)
  const prepared = inpatientPciDataResponseSchema.parse(await response.json()).data
  for (const [kind, ids] of [
    ['medication', prepared.installed.medications.map(item => item.catalogItemId)],
    ['laboratory', prepared.installed.laboratories.map(item => item.catalogItemId)],
  ] as const) {
    const result = await runtime.app.request(`/api/his/v1/inpatient/catalog-search?kind=${kind}&source=hospital&pageSize=50`, { headers: { cookie: doctor } })
    expect(result.status).toBe(200)
    const catalog = inpatientCatalogSearchSchema.parse(await result.json())
    expect(catalog.items.filter(item => item.status === 'available').map(item => item.catalogItemId)).toEqual(expect.arrayContaining(ids))
  }
  const outpatient = await runtime.app.request('/api/his/v1/catalogs/clinical', { headers: { cookie: await login('doctor') } })
  expect(outpatient.status).toBe(200)
  expect(clinicalCatalogSchema.parse(await outpatient.json()).prescriptionConclusionSupported).toBe(true)
})
