import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { healthResponseSchema } from '@clinmesh/contracts/health'
import { sessionContextSchema } from '@clinmesh/contracts/his'
import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { startServer } from '../src/server.ts'

describe('Node.js runtime', () => {
  it('serves the Hono application over a real HTTP listener', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-node-runtime-'))
    const webRoot = join(directory, 'web')
    await mkdir(webRoot)
    await writeFile(join(webRoot, 'index.html'), '<main>ClinMesh runtime</main>', 'utf8')
    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://127.0.0.1',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      trustedOrigins: ['http://127.0.0.1'],
      webRoot,
    })
    const server = startServer({ app: runtime.app, hostname: '127.0.0.1', port: 0 })

    try {
      await new Promise<void>((resolve) => server.once('listening', resolve))
      const address = server.address() as AddressInfo
      const response = await fetch(`http://127.0.0.1:${address.port}/api/health`)

      expect(response.status).toBe(200)
      expect(healthResponseSchema.parse(await response.json())).toEqual({
        fhirVersion: '5.0.0',
        service: 'clinmesh-server',
        status: 'ok',
      })
      const signIn = await fetch(`http://127.0.0.1:${address.port}/api/auth/sign-in/email`, {
        body: JSON.stringify({ email: 'registrar@demo.clinmesh.local', password }),
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1' },
        method: 'POST',
      })
      expect(signIn.status).toBe(200)
      const cookie = signIn.headers.getSetCookie()[0]?.split(';', 1)[0]
      const session = await fetch(`http://127.0.0.1:${address.port}/api/auth/context`, {
        headers: { cookie: cookie ?? '' },
      })
      expect(session.status).toBe(200)
      expect(sessionContextSchema.parse(await session.json())).toMatchObject({ actor: { roleCode: 'registrar' } })
      expect(await (await fetch(`http://127.0.0.1:${address.port}/registration`)).text())
        .toContain('ClinMesh runtime')
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error))
      })
      await runtime.close()
      await rm(directory, { recursive: true })
    }
  }, 15_000)

  it('waits for an in-flight dispatch cycle before closing SQLite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-runtime-close-'))
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://127.0.0.1',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'clinmesh.sqlite'),
      demoPassword: `Test-${randomUUID()}-Aa1!`,
      migrationMode: 'apply',
      trustedOrigins: ['http://127.0.0.1'],
    })
    let releaseDispatch: (() => void) | undefined
    const dispatchEntered = new Promise<void>(resolve => {
      vi.spyOn(runtime.dispatcher, 'dispatchOnce').mockImplementation(async () => {
        resolve()
        await new Promise<void>(release => { releaseDispatch = release })
        return undefined
      })
    })
    const dispatch = runtime.dispatchPending()
    await dispatchEntered
    let closeFinished = false
    const close = Promise.resolve(runtime.close()).then(() => { closeFinished = true })
    await Promise.resolve()

    expect(closeFinished).toBe(false)
    releaseDispatch?.()
    await Promise.all([dispatch, close])
    expect(() => runtime.database.diagnostics()).toThrow()
    await rm(directory, { recursive: true })
  })
})
