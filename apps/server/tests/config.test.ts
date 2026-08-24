import { describe, expect, it } from 'vitest'
import { readServerConfig } from '../src/config.ts'

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
})
