import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { z } from 'zod'
import { modelUsagePolicyConfigSchema, type ModelUsagePolicyConfig } from '@clinmesh/contracts/model-usage'
import { modelPricingConfigSchema, type ModelPricingConfig } from '@clinmesh/contracts/model-pricing'
import { sambertVoiceIdSchema, type SambertVoiceId } from '@clinmesh/contracts/voice'
import type { GuidelineDeploymentPolicy } from './application/guideline-corpus.ts'

export const guidelineNonCommercialUseSchema = z.enum(['true', 'false']).default('false').transform(value => value === 'true')
export const guidelineDeploymentPolicySchema = z.enum(['default', 'internal-testing']).default('default')
export const guidelineLocalEvaluationSchema = guidelineNonCommercialUseSchema

const httpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol
  return protocol === 'http:' || protocol === 'https:'
}, 'URL must use HTTP or HTTPS')

const serverEnvironmentSchema = z.object({
  CLINMESH_MODEL_CONTROL_PATH: z.string().trim().min(1).optional(),
  CLINMESH_MODEL_PRICING_PATH: z.string().trim().min(1).optional(),
  CLINMESH_AI_API_KEY: z.string().min(1).optional(),
  CLINMESH_AI_BASE_URL: httpUrlSchema.optional(),
  CLINMESH_AI_CONSULTATION_MODEL: z.string().trim().min(1).max(256).optional(),
  CLINMESH_AI_BRIEF_MODEL: z.string().trim().min(1).max(256).optional(),
  CLINMESH_AI_CATALOG_ENRICHMENT_MODEL: z.string().trim().min(1).max(256).optional(),
  CLINMESH_AI_INVESTIGATION_MODEL: z.string().trim().min(1).max(256).optional(),
  CLINMESH_AI_MAX_RESPONSE_BYTES: z.string().regex(/^\d+$/)
    .refine(value => Number(value) >= 1_024 && Number(value) <= 10 * 1_024 * 1_024)
    .default('1048576'),
  CLINMESH_AI_TIMEOUT_MS: z.string().regex(/^\d+$/)
    .refine(value => Number(value) >= 100 && Number(value) <= 10 * 60 * 1_000)
    .optional(),
  CLINMESH_AUTH_SECRET: z.string().min(32),
  CLINMESH_CURSOR_SECRET: z.string().min(32),
  CLINMESH_DATABASE_PATH: z.string().trim().min(1),
  CLINMESH_GUIDELINE_DATABASE_PATH: z.string().trim().min(1).optional(),
  CLINMESH_GUIDELINE_NON_COMMERCIAL_USE: guidelineNonCommercialUseSchema,
  CLINMESH_GUIDELINE_DEPLOYMENT_POLICY: guidelineDeploymentPolicySchema,
  CLINMESH_GUIDELINE_LOCAL_EVALUATION: guidelineLocalEvaluationSchema,
  CLINMESH_DEMO_PASSWORD: z.string().min(12),
  CLINMESH_DRG_RULES_DIRECTORY: z.string().trim().min(1).optional(),
  CLINMESH_DRG_RULES_REVIEW_PATH: z.string().trim().min(1).optional(),
  CLINMESH_HOST: z.string().trim().min(1).default('127.0.0.1'),
  CLINMESH_IMAGING_ASSET_DIRECTORY: z.string().trim().min(1).optional(),
  CLINMESH_IMAGING_CATALOG_DIRECTORY: z.string().trim().min(1).optional(),
  CLINMESH_PATHOLOGY_ASSET_DIRECTORY: z.string().trim().min(1).optional(),
  CLINMESH_PATHOLOGY_CATALOG_DIRECTORY: z.string().trim().min(1).optional(),
  CLINMESH_LOCAL_CLI_PROVIDERS: z.enum(['true', 'false']).default('true').transform(value => value === 'true'),
  CLINMESH_PORT: z.string()
    .regex(/^\d+$/)
    .default('51868')
    .transform(Number)
    .pipe(z.number().int().min(1).max(65_535)),
  CLINMESH_PUBLIC_ORIGIN: z.url().optional(),
  CLINMESH_REFERENCE_DATABASE_PATH: z.string().trim().min(1).optional(),
  CLINMESH_REFERENCE_RELEASE_ID: z.string().trim().min(1).max(256).optional(),
  CLINMESH_TRUSTED_ORIGINS: z.string().trim().min(1).optional(),
  CLINMESH_WEB_ROOT: z.string().trim().min(1).optional(),
  CLINMESH_VOICE_ENV_FILE: z.string().trim().min(1).optional(),
  BAILIAN_TOKEN: z.string().trim().min(1).optional(),
  'BAILIAN-TOKEN': z.string().trim().min(1).optional(),
  DASHSCOPE_API_KEY: z.string().trim().min(1).optional(),
  BAILIAN_WORKSPACE: z.string().trim().min(1).optional(),
  BAILIAN_VOICE_WS_URL: z.url().optional(),
  BAILIAN_TTS_VOICE: sambertVoiceIdSchema.optional(),
}).superRefine((environment, context) => {
  if ((environment.CLINMESH_DRG_RULES_DIRECTORY === undefined) !== (environment.CLINMESH_DRG_RULES_REVIEW_PATH === undefined)) {
    context.addIssue({ code: 'custom', path: ['CLINMESH_DRG_RULES_REVIEW_PATH'],
      message: 'DRG runtime rules require both a package directory and an explicit review file' })
  }
  const values = [
    environment.CLINMESH_AI_API_KEY,
    environment.CLINMESH_AI_BASE_URL,
    environment.CLINMESH_AI_BRIEF_MODEL,
    environment.CLINMESH_AI_INVESTIGATION_MODEL,
  ]
  if ((values.some(value => value !== undefined) || environment.CLINMESH_AI_CONSULTATION_MODEL !== undefined) && values.some(value => value === undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'AI base URL, API key, Brief model, and Investigation model must be configured together',
      path: ['CLINMESH_AI_BASE_URL'],
    })
  }
})

export interface ServerConfig {
  modelUsageControl?: ModelUsagePolicyConfig
  modelPricing?: ModelPricingConfig
  ai?: {
    apiKey: string
    baseUrl: string
    consultationModel?: string | undefined
    briefModel: string
    catalogEnrichmentModel?: string
    investigationModel: string
    maxResponseBytes: number
    timeoutMs: number
  }
  authBaseUrl: string
  authSecret: string
  cursorSecret: string
  databasePath: string
  guidelineDatabasePath: string
  guidelineNonCommercialUse: boolean
  guidelineDeploymentPolicy: GuidelineDeploymentPolicy
  guidelineLocalEvaluation: boolean
  demoPassword: string
  drgRulesDirectory?: string
  drgRulesReviewPath?: string
  hostname: string
  imagingAssetDirectory: string
  imagingCatalogDirectory: string
  pathologyAssetDirectory: string
  pathologyCatalogDirectory: string
  localCliProvidersEnabled: boolean
  port: number
  referenceDatabasePath?: string
  referenceReleaseId?: string
  trustedOrigins: string[]
  voice?: {
    bailianToken?: string
    bailianWorkspace?: string
    bailianWsUrl?: string
    defaultVoice?: SambertVoiceId
  }
  webRoot?: string
}

/** 影像素材的默认位置：清单随仓库提交，像素安装在不进入版本库的 `.data` 下。 */
export const defaultImagingCatalogDirectory = resolve(import.meta.dirname, '../../../imaging-assets')
export const defaultImagingAssetDirectory = resolve(import.meta.dirname, '../../../.data/imaging-assets')
/** 病理切片素材包与放射分开：清单目录与素材目录各自独立，安装、修复与备份互不影响。 */
export const defaultPathologyCatalogDirectory = resolve(import.meta.dirname, '../../../pathology-assets')
export const defaultPathologyAssetDirectory = resolve(import.meta.dirname, '../../../.data/pathology-assets')
export const defaultGuidelineDatabasePath = resolve(import.meta.dirname, '../../../.data/clinmesh-guidelines.sqlite')

function findWorkspaceEnvironmentFile(startDirectory: string): string | undefined {
  let directory = resolve(startDirectory)
  while (true) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) {
      const environmentFile = join(directory, '.env')
      return existsSync(environmentFile) ? environmentFile : undefined
    }

    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

function findWorkspaceLockedReferenceReleaseId(startDirectory: string): string | undefined {
  let directory = resolve(startDirectory)
  while (true) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) {
      const lockFile = join(directory, 'reference-data.lock.json')
      if (!existsSync(lockFile)) return undefined
      try {
        const lock = JSON.parse(readFileSync(lockFile, 'utf8')) as {
          compositeRelease?: { releaseId?: unknown }
        }
        const releaseId = lock.compositeRelease?.releaseId
        return typeof releaseId === 'string' && releaseId.length > 0 ? releaseId : undefined
      } catch {
        return undefined
      }
    }

    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

export function readServerEnvironment(
  environment: NodeJS.ProcessEnv,
  startDirectory = process.cwd(),
): NodeJS.ProcessEnv {
  const environmentFile = findWorkspaceEnvironmentFile(startDirectory)
  if (environmentFile === undefined) return environment

  const fromFile: NodeJS.ProcessEnv = parseEnv(readFileSync(environmentFile, 'utf8'))
  const environmentDirectory = dirname(environmentFile)
  for (const name of [
    'CLINMESH_DATABASE_PATH',
    'CLINMESH_DRG_RULES_DIRECTORY',
    'CLINMESH_DRG_RULES_REVIEW_PATH',
    'CLINMESH_MODEL_CONTROL_PATH',
    'CLINMESH_MODEL_PRICING_PATH',
    'CLINMESH_GUIDELINE_DATABASE_PATH',
    'CLINMESH_IMAGING_ASSET_DIRECTORY',
    'CLINMESH_IMAGING_CATALOG_DIRECTORY',
    'CLINMESH_PATHOLOGY_ASSET_DIRECTORY',
    'CLINMESH_PATHOLOGY_CATALOG_DIRECTORY',
    'CLINMESH_REFERENCE_DATABASE_PATH',
    'CLINMESH_VOICE_ENV_FILE',
    'CLINMESH_WEB_ROOT',
  ] as const) {
    const value = fromFile[name]
    if (value !== undefined && !isAbsolute(value)) fromFile[name] = resolve(environmentDirectory, value)
  }
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) fromFile[name] = value
  }
  return fromFile
}

export function readServerConfig(
  environment: NodeJS.ProcessEnv,
  startDirectory: string = process.cwd(),
): ServerConfig {
  const parsed = serverEnvironmentSchema.parse(environment)
  const referenceReleaseId = parsed.CLINMESH_REFERENCE_RELEASE_ID
    ?? findWorkspaceLockedReferenceReleaseId(startDirectory)
  const authBaseUrl = parsed.CLINMESH_PUBLIC_ORIGIN
    ?? `http://${parsed.CLINMESH_HOST}:${parsed.CLINMESH_PORT}`
  const defaultTrustedOrigins = [authBaseUrl]
  if (parsed.CLINMESH_PUBLIC_ORIGIN === undefined && parsed.CLINMESH_HOST === '127.0.0.1') {
    defaultTrustedOrigins.push('http://127.0.0.1:51888')
  }
  const trustedOrigins = parsed.CLINMESH_TRUSTED_ORIGINS === undefined
    ? defaultTrustedOrigins
    : parsed.CLINMESH_TRUSTED_ORIGINS.split(',').map(origin => z.url().parse(origin.trim()))

  // Optional external env file for local voice credentials (e.g., CLINMESH_VOICE_ENV_FILE).
  let voiceEnvOverrides: Record<string, string | undefined> = {}
  if (parsed.CLINMESH_VOICE_ENV_FILE !== undefined) {
    const voiceEnvPath = resolve(startDirectory, parsed.CLINMESH_VOICE_ENV_FILE)
    if (existsSync(voiceEnvPath)) {
      voiceEnvOverrides = parseEnv(readFileSync(voiceEnvPath, 'utf8'))
    }
  }
  const bailianToken = parsed.BAILIAN_TOKEN
    ?? parsed['BAILIAN-TOKEN']
    ?? parsed.DASHSCOPE_API_KEY
    ?? voiceEnvOverrides.BAILIAN_TOKEN?.trim()
    ?? voiceEnvOverrides['BAILIAN-TOKEN']?.trim()
    ?? voiceEnvOverrides.DASHSCOPE_API_KEY?.trim()
  const bailianWorkspace = parsed.BAILIAN_WORKSPACE ?? voiceEnvOverrides.BAILIAN_WORKSPACE?.trim()
  const bailianWsUrl = parsed.BAILIAN_VOICE_WS_URL ?? voiceEnvOverrides.BAILIAN_VOICE_WS_URL?.trim()
  const defaultVoice = parsed.BAILIAN_TTS_VOICE
  const hasVoiceConfig = Boolean(bailianToken || bailianWorkspace || bailianWsUrl || defaultVoice)

  return {
    ...(parsed.CLINMESH_MODEL_PRICING_PATH === undefined ? {} : {
      modelPricing: modelPricingConfigSchema.parse(JSON.parse(readFileSync(resolve(startDirectory, parsed.CLINMESH_MODEL_PRICING_PATH), 'utf8'))),
    }),
    ...(parsed.CLINMESH_MODEL_CONTROL_PATH === undefined ? {} : {
      modelUsageControl: modelUsagePolicyConfigSchema.parse(JSON.parse(readFileSync(resolve(startDirectory, parsed.CLINMESH_MODEL_CONTROL_PATH), 'utf8'))),
    }),
    ...(parsed.CLINMESH_AI_BASE_URL === undefined
      ? {}
      : {
          ai: {
            apiKey: parsed.CLINMESH_AI_API_KEY!,
            baseUrl: parsed.CLINMESH_AI_BASE_URL,
            consultationModel: parsed.CLINMESH_AI_CONSULTATION_MODEL,
            briefModel: parsed.CLINMESH_AI_BRIEF_MODEL!,
            ...(parsed.CLINMESH_AI_CATALOG_ENRICHMENT_MODEL === undefined
              ? {}
              : { catalogEnrichmentModel: parsed.CLINMESH_AI_CATALOG_ENRICHMENT_MODEL }),
            investigationModel: parsed.CLINMESH_AI_INVESTIGATION_MODEL!,
            maxResponseBytes: Number(parsed.CLINMESH_AI_MAX_RESPONSE_BYTES),
            timeoutMs: Number(parsed.CLINMESH_AI_TIMEOUT_MS ?? 60_000),
          },
        }),
    authBaseUrl,
    authSecret: parsed.CLINMESH_AUTH_SECRET,
    cursorSecret: parsed.CLINMESH_CURSOR_SECRET,
    databasePath: parsed.CLINMESH_DATABASE_PATH,
    guidelineDatabasePath: parsed.CLINMESH_GUIDELINE_DATABASE_PATH ?? defaultGuidelineDatabasePath,
    guidelineNonCommercialUse: parsed.CLINMESH_GUIDELINE_NON_COMMERCIAL_USE,
    guidelineDeploymentPolicy: parsed.CLINMESH_GUIDELINE_DEPLOYMENT_POLICY,
    guidelineLocalEvaluation: parsed.CLINMESH_GUIDELINE_LOCAL_EVALUATION,
    demoPassword: parsed.CLINMESH_DEMO_PASSWORD,
    ...(parsed.CLINMESH_DRG_RULES_DIRECTORY === undefined ? {} : {
      drgRulesDirectory: parsed.CLINMESH_DRG_RULES_DIRECTORY,
      drgRulesReviewPath: parsed.CLINMESH_DRG_RULES_REVIEW_PATH!,
    }),
    hostname: parsed.CLINMESH_HOST,
    imagingAssetDirectory: parsed.CLINMESH_IMAGING_ASSET_DIRECTORY ?? defaultImagingAssetDirectory,
    imagingCatalogDirectory: parsed.CLINMESH_IMAGING_CATALOG_DIRECTORY ?? defaultImagingCatalogDirectory,
    pathologyAssetDirectory: parsed.CLINMESH_PATHOLOGY_ASSET_DIRECTORY ?? defaultPathologyAssetDirectory,
    pathologyCatalogDirectory: parsed.CLINMESH_PATHOLOGY_CATALOG_DIRECTORY ?? defaultPathologyCatalogDirectory,
    localCliProvidersEnabled: parsed.CLINMESH_LOCAL_CLI_PROVIDERS,
    port: parsed.CLINMESH_PORT,
    ...(parsed.CLINMESH_REFERENCE_DATABASE_PATH === undefined
      ? {}
      : { referenceDatabasePath: parsed.CLINMESH_REFERENCE_DATABASE_PATH }),
    ...(referenceReleaseId === undefined ? {} : { referenceReleaseId }),
    trustedOrigins,
    ...(hasVoiceConfig
      ? {
          voice: {
            ...(bailianToken ? { bailianToken } : {}),
            ...(bailianWorkspace ? { bailianWorkspace } : {}),
            ...(bailianWsUrl ? { bailianWsUrl } : {}),
            ...(defaultVoice ? { defaultVoice } : {}),
          },
        }
      : {}),
    ...(parsed.CLINMESH_WEB_ROOT === undefined ? {} : { webRoot: parsed.CLINMESH_WEB_ROOT }),
  }
}
