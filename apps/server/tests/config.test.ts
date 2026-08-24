import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readServerConfig, readServerEnvironment } from '../src/config.ts'

describe('Node.js server configuration', () => {
  it('reads an explicit persistent single-instance configuration without exposing secrets', () => {
    expect(readServerConfig({
      CLINMESH_AUTH_SECRET: 'auth-secret-with-at-least-32-characters',
      CLINMESH_CURSOR_SECRET: 'cursor-secret-with-at-least-32-characters',
      CLINMESH_DATABASE_PATH: '/var/lib/clinmesh/clinmesh.sqlite',
      CLINMESH_DEMO_PASSWORD: 'Synthetic-password-2026!',
    })).toEqual({
      authBaseUrl: 'http://127.0.0.1:8787',
      authSecret: 'auth-secret-with-at-least-32-characters',
      cursorSecret: 'cursor-secret-with-at-least-32-characters',
      databasePath: '/var/lib/clinmesh/clinmesh.sqlite',
      demoPassword: 'Synthetic-password-2026!',
      hostname: '127.0.0.1',
      port: 8787,
      trustedOrigins: ['http://127.0.0.1:8787'],
    })
  })

  it('requires runtime secrets and the controlled synthetic account password', () => {
    expect(() => readServerConfig({})).toThrow()
  })

  it('rejects an invalid listener port before startup', () => {
    expect(() => readServerConfig({ CLINMESH_PORT: 'invalid' })).toThrow()
  })

  it('loads the workspace .env while preserving explicit environment overrides', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'clinmesh-server-env-'))
    const serverDirectory = join(workspace, 'apps/server')
    await mkdir(serverDirectory, { recursive: true })
    await writeFile(join(workspace, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8')
    await writeFile(join(workspace, '.env'), [
      'CLINMESH_AUTH_SECRET=env-auth-secret-with-at-least-32-characters',
      'CLINMESH_CURSOR_SECRET=env-cursor-secret-with-at-least-32-characters',
      'CLINMESH_DATABASE_PATH=.data/clinmesh.sqlite',
      'CLINMESH_DEMO_PASSWORD=Env-demo-password-2026!',
      'CLINMESH_PORT=8787',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(serverDirectory, '.env'), [
      'CLINMESH_AUTH_SECRET=package-auth-secret-with-at-least-32-characters',
      'CLINMESH_CURSOR_SECRET=package-cursor-secret-with-at-least-32-characters',
      'CLINMESH_DATABASE_PATH=.data/package.sqlite',
      'CLINMESH_DEMO_PASSWORD=Package-demo-password-2026!',
      '',
    ].join('\n'), 'utf8')

    try {
      expect(readServerConfig(readServerEnvironment({ CLINMESH_PORT: '8790' }, serverDirectory)))
        .toMatchObject({
          databasePath: join(workspace, '.data/clinmesh.sqlite'),
          port: 8790,
        })
    } finally {
      await rm(workspace, { recursive: true })
    }
  })
})
