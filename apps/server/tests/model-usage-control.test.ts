import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { signIn } from './fixtures/consultation.ts'

const dispose: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of dispose.splice(0).reverse()) await close() })

async function setup(extra: Partial<Parameters<typeof createClinMeshRuntime>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-model-control-'))
  dispose.push(() => rm(directory, { recursive: true, force: true }))
  const options = {
    authBaseUrl: 'http://localhost', authSecret: 'synthetic-auth-secret-at-least-32-characters',
    cursorSecret: 'synthetic-cursor-secret-at-least-32-characters',
    databasePath: join(directory, 'clinmesh.sqlite'), demoPassword: 'Synthetic-Demo-Password-2026!',
    migrationMode: 'apply' as const, trustedOrigins: ['http://localhost'], ...extra,
  }
  let runtime = await createClinMeshRuntime(options)
  dispose.push(() => runtime.close())
  return { get runtime() { return runtime }, restart: async () => {
    await runtime.close(); runtime = await createClinMeshRuntime(options)
  } }
}

it('persists administrator control with versioned idempotent writes and keeps member access read only', async () => {
  const fixture = await setup()
  const admin = await signIn(fixture.runtime, 'admin@demo.clinmesh.local')
  const doctor = await signIn(fixture.runtime, 'doctor@demo.clinmesh.local')
  const read = async (cookie = admin) => fixture.runtime.app.request('/api/model-usage/control', { headers: { cookie } })
  const write = (cookie: string, body: unknown, key = randomUUID()) => fixture.runtime.app.request('/api/model-usage/control', {
    method: 'PUT', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  })
  expect((await read('')).status).toBe(401)
  const initial = await read(doctor)
  expect(initial.status).toBe(200)
  expect(await initial.json()).toMatchObject({
    workspace: { enabled: true, requests: null, automaticRetries: true, version: 1, requestsStartedAt: null, used: 0, reserved: 0, remaining: null },
    deployment: { enabled: true, requests: null, automaticRetries: true, requestsStartedAt: null },
    effective: { enabled: true, automaticRetries: true }, waiting: 0, inFlight: 0, lastRejection: null,
  })
  const input = { expectedVersion: 1, enabled: false, requests: 0, automaticRetries: false }
  expect((await write(doctor, input)).status).toBe(403)
  const key = randomUUID()
  const changed = await write(admin, input, key)
  expect(changed.status).toBe(200)
  expect(await changed.json()).toMatchObject({ workspace: { enabled: false, requests: 0, automaticRetries: false, version: 2, remaining: 0 }, effective: { enabled: false, automaticRetries: false } })
  expect((await write(admin, input, key)).status).toBe(200)
  expect((await write(admin, { ...input, requests: 5 }, key)).status).toBe(409)
  expect((await write(admin, { ...input, requests: 5 })).status).toBe(409)
  expect((await write(admin, { ...input, expectedVersion: 2, requests: -1 })).status).toBe(400)
  expect((await write(admin, { ...input, expectedVersion: 2, workspaceId: 'workspace-other' })).status).toBe(400)
  await fixture.restart()
  expect(await (await read()).json()).toMatchObject({ workspace: { enabled: false, requests: 0, automaticRetries: false, version: 2, used: 0 } })
})
