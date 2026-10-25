import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'

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
