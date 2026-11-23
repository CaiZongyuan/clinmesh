import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'

type Runtime = Awaited<ReturnType<typeof createClinMeshRuntime>>
const fixtures: Array<{ runtime: Runtime; directory: string }> = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.runtime.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

async function setup(options: Partial<Parameters<typeof createClinMeshRuntime>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-pathology-reading-'))
  const runtime = await createClinMeshRuntime({ authBaseUrl: 'http://localhost', authSecret: 'synthetic-reading-auth-secret-with-32-characters',
    cursorSecret: 'synthetic-cursor-secret', databasePath: join(directory, 'hospital.sqlite'), demoPassword: 'synthetic-demo-password',
    migrationMode: 'apply', trustedOrigins: ['http://localhost'], ...options })
  fixtures.push({ runtime, directory })
  return runtime
}

async function login(runtime: Runtime, email: string) {
  const response = await runtime.app.request('/api/auth/sign-in/email', { method: 'POST',
    headers: { origin: 'http://localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'synthetic-demo-password' }) })
  expect(response.status).toBe(200)
  return response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')
}

it('未接入 PathJX 时 HIS 正常启动，只有管理员可查看阅片服务配置状态', async () => {
  const runtime = await setup()
  const admin = await login(runtime, 'admin@demo.clinmesh.local')
  const doctor = await login(runtime, 'doctor@demo.clinmesh.local')
  const path = '/api/sim/v1/admin/pathology-reading/status'
  expect((await runtime.app.request('/api/health')).status).toBe(200)
  expect((await runtime.app.request(path)).status).toBe(401)
  expect((await runtime.app.request(path, { headers: { cookie: doctor } })).status).toBe(403)
  const response = await runtime.app.request(path, { headers: { cookie: admin } })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(await response.json()).toMatchObject({ state: 'not-configured', config: null, capabilities: [] })
})

it('外部阅片配置拒绝临床岗位和不受信来源，缺少部署凭据时不启用外部服务', async () => {
  const runtime = await setup()
  const admin = await login(runtime, 'admin@demo.clinmesh.local')
  const doctor = await login(runtime, 'doctor@demo.clinmesh.local')
  const path = '/api/sim/v1/admin/pathology-reading/config'
  const body = JSON.stringify({ expectedVersion: 0, enabled: true, instanceId: 'synthetic-pathjx', endpoint: 'http://127.0.0.1:51890', viewerOrigin: 'http://127.0.0.1:51890' })
  const mutation = (cookie: string, origin = 'http://localhost') => ({ method: 'PUT', body,
    headers: { cookie, origin, 'content-type': 'application/json', 'idempotency-key': randomUUID() } })
  expect((await runtime.app.request(path, mutation(doctor))).status).toBe(403)
  expect((await runtime.app.request(path, mutation(admin, 'http://untrusted.invalid'))).status).toBe(403)
  const response = await runtime.app.request(path, mutation(admin))
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: { code: 'PATHOLOGY_READING_CREDENTIALS_UNAVAILABLE' } })
})

it('管理员配置受信服务后显示实际模型能力，停用保留配置且不再访问外部服务', async () => {
  let calls = 0
  const runtime = await setup({ pathologyReading: { serviceToken: 'synthetic-pathjx-service-credential', trustedOrigins: ['http://127.0.0.1:51890'],
    fetch: async (url, options) => {
      calls++
      expect(String(url)).toBe('http://127.0.0.1:51890/api/integrations/clinmesh/v1/capabilities')
      expect(new Headers(options?.headers).get('cookie')).toBeNull()
      expect(new Headers(options?.headers).get('authorization')).toBe('Bearer synthetic-pathjx-service-credential')
      return Response.json({ protocol: 'clinmesh.pathology-reading.v1', instanceId: 'synthetic-pathjx', capabilities: [{
        taskCode: 'thyroid-review', modelVersion: 'synthetic-model-v1', modelDigest: 'a'.repeat(64), organ: 'thyroid',
        specimenTypes: ['thyroid-surgical'], stain: 'HE', available: true, limitations: ['合成执行器，仅验证接线'] }] })
    } } })
  const admin = await login(runtime, 'admin@demo.clinmesh.local')
  const input = { expectedVersion: 0, enabled: true, instanceId: 'synthetic-pathjx', endpoint: 'http://127.0.0.1:51890', viewerOrigin: 'http://127.0.0.1:51890' }
  const save = async (body: typeof input) => runtime.app.request('/api/sim/v1/admin/pathology-reading/config', { method: 'PUT',
    headers: { cookie: admin, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(body) })
  expect((await save(input)).status).toBe(200)
  const status = await runtime.app.request('/api/sim/v1/admin/pathology-reading/status', { headers: { cookie: admin } })
  expect(await status.json()).toMatchObject({ state: 'ready', config: { version: 1 }, capabilities: [{ modelVersion: 'synthetic-model-v1' }] })
  expect(calls).toBe(1)
  expect((await save({ ...input, expectedVersion: 1, enabled: false })).status).toBe(200)
  const disabled = await runtime.app.request('/api/sim/v1/admin/pathology-reading/status', { headers: { cookie: admin } })
  expect(await disabled.json()).toMatchObject({ state: 'disabled', config: { enabled: false, version: 2 }, capabilities: [] })
  expect(calls).toBe(1)
  expect((await save({ ...input, expectedVersion: 0 })).status).toBe(409)
})
