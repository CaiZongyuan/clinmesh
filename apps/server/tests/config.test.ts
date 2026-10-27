import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultImagingAssetDirectory,
  defaultImagingCatalogDirectory,
  defaultGuidelineDatabasePath,
  defaultPathologyAssetDirectory,
  defaultPathologyCatalogDirectory,
  readServerConfig,
  readServerEnvironment,
} from '../src/config.ts'

describe('Node.js server configuration', () => {
  it('requires an explicit review file alongside a DRG rules package and leaves offline downloads disabled', () => {
    const environment = {
      CLINMESH_AUTH_SECRET: 'synthetic-auth-secret-at-least-32-characters',
      CLINMESH_CURSOR_SECRET: 'synthetic-cursor-secret-at-least-32-characters',
      CLINMESH_DATABASE_PATH: '/synthetic/hospital.sqlite',
      CLINMESH_DEMO_PASSWORD: 'Synthetic-password-2026!',
    }
    expect(readServerConfig(environment)).not.toHaveProperty('drgRulesDirectory')
    expect(() => readServerConfig({ ...environment, CLINMESH_DRG_RULES_DIRECTORY: '/synthetic/rules' })).toThrow(/DRG/)
    expect(() => readServerConfig({ ...environment, CLINMESH_DRG_RULES_REVIEW_PATH: '/synthetic/review.json' })).toThrow(/DRG/)
    expect(readServerConfig({ ...environment, CLINMESH_DRG_RULES_DIRECTORY: '/synthetic/rules',
      CLINMESH_DRG_RULES_REVIEW_PATH: '/synthetic/review.json' })).toMatchObject({
      drgRulesDirectory: '/synthetic/rules', drgRulesReviewPath: '/synthetic/review.json',
    })
  })
  it('validates deployment pricing and independent finite dimensions without reading network prices', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-pricing-config-'))
    try {
      const environment = { CLINMESH_AUTH_SECRET: 'synthetic-auth-secret-at-least-32-characters', CLINMESH_CURSOR_SECRET: 'synthetic-cursor-secret-at-least-32-characters',
        CLINMESH_DATABASE_PATH: join(directory, 'synthetic.sqlite'), CLINMESH_DEMO_PASSWORD: 'Synthetic-password-2026!',
        CLINMESH_MODEL_PRICING_PATH: join(directory, 'prices.json'), CLINMESH_MODEL_CONTROL_PATH: join(directory, 'control.json') }
      const pricing = { prices: [{ provider: 'synthetic', model: 'example', version: 'price-v1', currency: 'USD', rates: { input: 2, output: 4 } }],
        exchangeRates: [{ currency: 'USD', version: 'fx-v1', cnyPerUnit: 7 }] }
      await writeFile(environment.CLINMESH_MODEL_PRICING_PATH, JSON.stringify(pricing))
      await writeFile(environment.CLINMESH_MODEL_CONTROL_PATH, JSON.stringify({ tokens: 0, cny: 1.234567 }))
      expect(readServerConfig(environment)).toMatchObject({ modelPricing: pricing, modelUsageControl: { tokens: 0, cny: 1.234567 } })
      await writeFile(environment.CLINMESH_MODEL_PRICING_PATH, JSON.stringify({ ...pricing, prices: [{ ...pricing.prices[0], secret: 'forbidden-field' }] }))
      expect(() => readServerConfig(environment)).toThrow()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('validates an optional deployment model policy file and keeps zero distinct from unlimited', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-control-config-'))
    try {
      const path = join(directory, 'model-control.json')
      const environment = { CLINMESH_AUTH_SECRET: 'synthetic-auth-secret-at-least-32-characters',
        CLINMESH_CURSOR_SECRET: 'synthetic-cursor-secret-at-least-32-characters',
        CLINMESH_DATABASE_PATH: join(directory, 'synthetic.sqlite'), CLINMESH_DEMO_PASSWORD: 'Synthetic-password-2026!',
        CLINMESH_MODEL_CONTROL_PATH: path }
      await writeFile(path, JSON.stringify({ enabled: false, requests: 0, automaticRetries: false }))
      expect(readServerConfig(environment)).toHaveProperty('modelUsageControl', { enabled: false, requests: 0, automaticRetries: false })
      await writeFile(path, JSON.stringify({ requests: null }))
      expect(readServerConfig(environment)).toHaveProperty('modelUsageControl', { enabled: true, requests: null, automaticRetries: true })
      await writeFile(path, JSON.stringify({ requests: -1 }))
      expect(() => readServerConfig(environment)).toThrow()
      await writeFile(path, JSON.stringify({ requests: 'unlimited' }))
      expect(() => readServerConfig(environment)).toThrow()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('resolves an independent local guideline corpus and preserves an explicit override', () => {
    const environment = {
      CLINMESH_AUTH_SECRET: 'synthetic-auth-secret-at-least-32-characters',
      CLINMESH_CURSOR_SECRET: 'synthetic-cursor-secret-at-least-32-characters',
      CLINMESH_DATABASE_PATH: '/synthetic/hospital.sqlite',
      CLINMESH_DEMO_PASSWORD: 'Synthetic-password-2026!',
    }
    expect(readServerConfig({ ...environment, CLINMESH_GUIDELINE_DATABASE_PATH: '/synthetic/guidelines.sqlite' }))
      .toMatchObject({ guidelineDatabasePath: '/synthetic/guidelines.sqlite' })
    expect(readServerConfig(environment)).toHaveProperty('guidelineDatabasePath',
      expect.stringMatching(/[\\/]\.data[\\/]clinmesh-guidelines\.sqlite$/))
    expect(() => readServerConfig({ ...environment, CLINMESH_GUIDELINE_DATABASE_PATH: ' ' })).toThrow()
    expect(readServerConfig(environment, '/clinmesh-config-test-isolated')).toHaveProperty('guidelineNonCommercialUse', false)
    expect(readServerConfig(environment, '/clinmesh-config-test-isolated')).toHaveProperty('guidelineDeploymentPolicy', 'default')
    expect(readServerConfig({ ...environment, CLINMESH_GUIDELINE_DEPLOYMENT_POLICY: 'internal-testing' }))
      .toHaveProperty('guidelineDeploymentPolicy', 'internal-testing')
    for (const value of ['', 'true', 'non-commercial']) {
      expect(() => readServerConfig({ ...environment, CLINMESH_GUIDELINE_DEPLOYMENT_POLICY: value })).toThrow()
    }
    expect(readServerConfig({ ...environment, CLINMESH_GUIDELINE_NON_COMMERCIAL_USE: 'true' }))
      .toHaveProperty('guidelineNonCommercialUse', true)
    expect(readServerConfig({ ...environment, CLINMESH_GUIDELINE_NON_COMMERCIAL_USE: 'false' }))
      .toHaveProperty('guidelineNonCommercialUse', false)
    expect(readServerConfig(environment, '/clinmesh-config-test-isolated')).toHaveProperty('guidelineLocalEvaluation', false)
    expect(readServerConfig({ ...environment, CLINMESH_GUIDELINE_LOCAL_EVALUATION: 'true' }))
      .toHaveProperty('guidelineLocalEvaluation', true)
    expect(readServerConfig({ ...environment, CLINMESH_GUIDELINE_LOCAL_EVALUATION: 'false' }))
      .toHaveProperty('guidelineLocalEvaluation', false)
    for (const value of ['', 'yes', '1']) {
      expect(() => readServerConfig({ ...environment, CLINMESH_GUIDELINE_NON_COMMERCIAL_USE: value })).toThrow()
      expect(() => readServerConfig({ ...environment, CLINMESH_GUIDELINE_LOCAL_EVALUATION: value })).toThrow()
    }
  })

  it('uses DSH without duplicate Provider configuration and requires a trusted bridge', () => {
    const environment = {
      CLINMESH_AUTH_SECRET: 'synthetic-auth-secret-at-least-32-characters',
      CLINMESH_CURSOR_SECRET: 'synthetic-cursor-secret-at-least-32-characters',
      CLINMESH_DATABASE_PATH: '/synthetic/clinmesh.sqlite',
      CLINMESH_DEMO_PASSWORD: 'Synthetic-password-2026!',
      CLINMESH_AI_SOURCE: 'dsh',
      CLINMESH_DSH_BRIDGE_SECRET: 'synthetic-bridge-secret-at-least-32-characters',
    }
    expect(readServerConfig(environment)).toMatchObject({ dshModelBridge: {
      origin: 'http://127.0.0.1:3080', secret: environment.CLINMESH_DSH_BRIDGE_SECRET,
      timeoutMs: 120000, maxResponseBytes: 1048576,
    } })
    expect(readServerConfig(environment)).not.toHaveProperty('ai')
    expect(readServerConfig(environment)).not.toHaveProperty('consultationRecordingTimeoutMs')
    expect(readServerConfig({ ...environment, CLINMESH_AI_RECORDING_MODEL: 'dsh:synthetic-fast',
      CLINMESH_AI_RECORDING_TIMEOUT_MS: '6000' })).toMatchObject({ consultationRecordingModel: 'dsh:synthetic-fast' })
    expect(readServerConfig({ ...environment, CLINMESH_AI_RECORDING_TIMEOUT_MS: '6000' }))
      .not.toHaveProperty('consultationRecordingTimeoutMs')
    expect(readServerConfig({ ...environment, CLINMESH_AI_TIMEOUT_MS: '180000' }).dshModelBridge?.timeoutMs).toBe(180000)
    expect(() => readServerConfig({ ...environment, CLINMESH_DSH_BRIDGE_SECRET: undefined })).toThrow()
    for (const origin of ['https://127.0.0.1:3080', 'http://remote.example', 'http://127.0.0.1:3080/path', 'http://user:password@127.0.0.1:3080']) {
      expect(() => readServerConfig({ ...environment, CLINMESH_DSH_MODEL_ORIGIN: origin })).toThrow()
    }
  })
  it('reads an explicit persistent single-instance configuration without exposing secrets', () => {
    expect(readServerConfig({
      CLINMESH_AUTH_SECRET: 'auth-secret-with-at-least-32-characters',
      CLINMESH_CURSOR_SECRET: 'cursor-secret-with-at-least-32-characters',
      CLINMESH_DATABASE_PATH: '/var/lib/clinmesh/clinmesh.sqlite',
      CLINMESH_DEMO_PASSWORD: 'Synthetic-password-2026!',
    }, '/clinmesh-config-test-isolated')).toEqual({
      authBaseUrl: 'http://127.0.0.1:51868',
      authSecret: 'auth-secret-with-at-least-32-characters',
      cursorSecret: 'cursor-secret-with-at-least-32-characters',
      databasePath: '/var/lib/clinmesh/clinmesh.sqlite',
      guidelineDatabasePath: defaultGuidelineDatabasePath,
      guidelineNonCommercialUse: false,
      guidelineDeploymentPolicy: 'default',
      guidelineLocalEvaluation: false,
      demoPassword: 'Synthetic-password-2026!',
      hostname: '127.0.0.1',
      // 影像素材默认位置：清单在仓库根目录，像素安装在 .data 下。
      imagingAssetDirectory: defaultImagingAssetDirectory,
      imagingCatalogDirectory: defaultImagingCatalogDirectory,
      pathologyAssetDirectory: defaultPathologyAssetDirectory,
      pathologyCatalogDirectory: defaultPathologyCatalogDirectory,
      port: 51868,
      trustedOrigins: ['http://127.0.0.1:51868', 'http://127.0.0.1:51888'],
    })
    expect(defaultImagingCatalogDirectory).toMatch(/[\\/]imaging-assets$/)
    expect(defaultImagingAssetDirectory).toMatch(/[\\/]\.data[\\/]imaging-assets$/)
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
      CLINMESH_AI_CATALOG_ENRICHMENT_MODEL: 'catalog-enrichment-model',
      CLINMESH_AI_INVESTIGATION_MODEL: 'investigation-model',
      CLINMESH_AI_MAX_RESPONSE_BYTES: '2048',
      CLINMESH_AI_TIMEOUT_MS: '5000',
    })).toMatchObject({
      ai: {
        apiKey: 'synthetic-test-key',
        baseUrl: 'https://openrouter.example/api/v1',
        briefModel: 'brief-model',
        catalogEnrichmentModel: 'catalog-enrichment-model',
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

  it('defaults the current reference release to the locked composite release', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'clinmesh-server-lock-'))
    const serverDirectory = join(workspace, 'apps/server')
    await mkdir(serverDirectory, { recursive: true })
    await writeFile(join(workspace, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8')
    await writeFile(join(workspace, 'reference-data.lock.json'), JSON.stringify({
      compositeRelease: { releaseId: 'clinmesh-cn-health-locked.r1' },
    }), 'utf8')
    const requiredEnvironment = {
      CLINMESH_AUTH_SECRET: 'auth-secret-with-at-least-32-characters',
      CLINMESH_CURSOR_SECRET: 'cursor-secret-with-at-least-32-characters',
      CLINMESH_DATABASE_PATH: '/var/lib/clinmesh/clinmesh.sqlite',
      CLINMESH_DEMO_PASSWORD: 'Synthetic-password-2026!',
    }

    try {
      expect(readServerConfig({ ...requiredEnvironment }, serverDirectory)).toMatchObject({
        referenceReleaseId: 'clinmesh-cn-health-locked.r1',
      })
      expect(readServerConfig({
        ...requiredEnvironment,
        CLINMESH_REFERENCE_RELEASE_ID: 'explicit-release',
      }, serverDirectory)).toMatchObject({ referenceReleaseId: 'explicit-release' })
    } finally {
      await rm(workspace, { force: true, recursive: true })
    }
  })

  it('keeps the reference release unset when no valid lock exists in the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'clinmesh-server-nolock-'))
    await writeFile(join(workspace, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8')
    await writeFile(join(workspace, 'reference-data.lock.json'), 'not json', 'utf8')
    const requiredEnvironment = {
      CLINMESH_AUTH_SECRET: 'auth-secret-with-at-least-32-characters',
      CLINMESH_CURSOR_SECRET: 'cursor-secret-with-at-least-32-characters',
      CLINMESH_DATABASE_PATH: '/var/lib/clinmesh/clinmesh.sqlite',
      CLINMESH_DEMO_PASSWORD: 'Synthetic-password-2026!',
    }

    try {
      expect(readServerConfig({ ...requiredEnvironment }, workspace)).not.toHaveProperty('referenceReleaseId')
    } finally {
      await rm(workspace, { force: true, recursive: true })
    }
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
      'CLINMESH_GUIDELINE_DATABASE_PATH=.data/guidelines.sqlite',
      'CLINMESH_REFERENCE_RELEASE_ID=reference-production-v1',
      'CLINMESH_DRG_RULES_DIRECTORY=.data/drg-rules/versioned',
      'CLINMESH_DRG_RULES_REVIEW_PATH=.data/drg-rules-review.json',
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
          guidelineDatabasePath: join(workspace, '.data/guidelines.sqlite'),
          referenceReleaseId: 'reference-production-v1',
          drgRulesDirectory: join(workspace, '.data/drg-rules/versioned'),
          drgRulesReviewPath: join(workspace, '.data/drg-rules-review.json'),
        })
    } finally {
      await rm(workspace, { recursive: true })
    }
  })
})
