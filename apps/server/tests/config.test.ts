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
      authBaseUrl: 'http://127.0.0.1:51868',
      authSecret: 'auth-secret-with-at-least-32-characters',
      cursorSecret: 'cursor-secret-with-at-least-32-characters',
      databasePath: '/var/lib/clinmesh/clinmesh.sqlite',
      demoPassword: 'Synthetic-password-2026!',
      hostname: '127.0.0.1',
      port: 51868,
      trustedOrigins: ['http://127.0.0.1:51868', 'http://127.0.0.1:51888'],
    })
  })

  it('requires runtime secrets and the controlled synthetic account password', () => {
    expect(() => readServerConfig({})).toThrow()
  })

  it('keeps explicit public and trusted origin configuration authoritative', () => {
    const requiredEnvironment = {
      CLINMESH_AUTH_SECRET: 'auth-secret-with-at-least-32-characters',
      CLINMESH_CURSOR_SECRET: 'cursor-secret-with-at-least-32-characters',
      CLINMESH_DATABASE_PATH: '/var/lib/clinmesh/clinmesh.sqlite',
      CLINMESH_DEMO_PASSWORD: 'Synthetic-password-2026!',
    }

    expect(readServerConfig({
      ...requiredEnvironment,
      CLINMESH_PUBLIC_ORIGIN: 'https://clinmesh.example',
    })).toMatchObject({
      authBaseUrl: 'https://clinmesh.example',
      trustedOrigins: ['https://clinmesh.example'],
    })

    expect(readServerConfig({
      ...requiredEnvironment,
      CLINMESH_TRUSTED_ORIGINS: 'https://clinmesh.example,https://review.clinmesh.example',
    })).toMatchObject({
      authBaseUrl: 'http://127.0.0.1:51868',
      trustedOrigins: ['https://clinmesh.example', 'https://review.clinmesh.example'],
    })
  })

  it('accepts only an explicit HTTP Synthea Provider URL', () => {
    const requiredEnvironment = {
      CLINMESH_AUTH_SECRET: 'auth-secret-with-at-least-32-characters',
      CLINMESH_CURSOR_SECRET: 'cursor-secret-with-at-least-32-characters',
      CLINMESH_DATABASE_PATH: '/var/lib/clinmesh/clinmesh.sqlite',
      CLINMESH_DEMO_PASSWORD: 'Synthetic-password-2026!',
    }
    expect(readServerConfig({
      ...requiredEnvironment,
      CLINMESH_SYNTHEA_PROVIDER_URL: 'http://synthea-provider:51878',
    })).toMatchObject({ syntheaProviderUrl: 'http://synthea-provider:51878' })
    expect(() => readServerConfig({
      ...requiredEnvironment,
      CLINMESH_SYNTHEA_PROVIDER_URL: 'file:///tmp/provider',
    })).toThrow()
  })

  it('requires one complete bounded server-side AI configuration', () => {
    const requiredEnvironment = {
      CLINMESH_AUTH_SECRET: 'auth-secret-with-at-least-32-characters',
      CLINMESH_CURSOR_SECRET: 'cursor-secret-with-at-least-32-characters',
      CLINMESH_DATABASE_PATH: '/var/lib/clinmesh/clinmesh.sqlite',
      CLINMESH_DEMO_PASSWORD: 'Synthetic-password-2026!',
    }
    expect(readServerConfig({
      ...requiredEnvironment,
      CLINMESH_AI_API_KEY: 'synthetic-test-key',
      CLINMESH_AI_BASE_URL: 'https://openrouter.example/api/v1',
      CLINMESH_AI_BRIEF_MODEL: 'brief-model',
      CLINMESH_AI_INVESTIGATION_MODEL: 'investigation-model',
      CLINMESH_AI_MAX_RESPONSE_BYTES: '2048',
      CLINMESH_AI_TIMEOUT_MS: '5000',
    })).toMatchObject({
      ai: {
        apiKey: 'synthetic-test-key',
        baseUrl: 'https://openrouter.example/api/v1',
        briefModel: 'brief-model',
        investigationModel: 'investigation-model',
        maxResponseBytes: 2048,
        timeoutMs: 5000,
      },
    })
    expect(() => readServerConfig({
      ...requiredEnvironment,
      CLINMESH_AI_BASE_URL: 'https://openrouter.example/api/v1',
    })).toThrow()
    expect(() => readServerConfig({
      ...requiredEnvironment,
      CLINMESH_AI_API_KEY: 'synthetic-test-key',
      CLINMESH_AI_BASE_URL: 'https://openrouter.example/api/v1',
      CLINMESH_AI_BRIEF_MODEL: 'brief-model',
      CLINMESH_AI_INVESTIGATION_MODEL: 'investigation-model',
      CLINMESH_AI_TIMEOUT_MS: '10',
    })).toThrow()
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
      'CLINMESH_PORT=51869',
      'CLINMESH_REFERENCE_DATABASE_PATH=.data/reference.sqlite',
      'CLINMESH_REFERENCE_RELEASE_ID=reference-production-v1',
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
      expect(readServerConfig(readServerEnvironment({ CLINMESH_PORT: '51867' }, serverDirectory)))
        .toMatchObject({
          databasePath: join(workspace, '.data/clinmesh.sqlite'),
          port: 51867,
          referenceDatabasePath: join(workspace, '.data/reference.sqlite'),
          referenceReleaseId: 'reference-production-v1',
        })
    } finally {
      await rm(workspace, { recursive: true })
    }
  })
})
