import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { z } from 'zod'

const httpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol
  return protocol === 'http:' || protocol === 'https:'
}, 'URL must use HTTP or HTTPS')

const serverEnvironmentSchema = z.object({
  CLINMESH_AI_API_KEY: z.string().min(1).optional(),
  CLINMESH_AI_BASE_URL: httpUrlSchema.optional(),
  CLINMESH_AI_BRIEF_MODEL: z.string().trim().min(1).max(256).optional(),
  CLINMESH_AI_CATALOG_ENRICHMENT_MODEL: z.string().trim().min(1).max(256).optional(),
  CLINMESH_AI_INVESTIGATION_MODEL: z.string().trim().min(1).max(256).optional(),
  CLINMESH_AI_MAX_RESPONSE_BYTES: z.string().regex(/^\d+$/)
    .refine(value => Number(value) >= 1_024 && Number(value) <= 10 * 1_024 * 1_024)
    .default('1048576'),
  CLINMESH_AI_TIMEOUT_MS: z.string().regex(/^\d+$/)
    .refine(value => Number(value) >= 100 && Number(value) <= 10 * 60 * 1_000)
    .default('60000'),
  CLINMESH_AUTH_SECRET: z.string().min(32),
  CLINMESH_CURSOR_SECRET: z.string().min(32),
  CLINMESH_DATABASE_PATH: z.string().trim().min(1),
  CLINMESH_DEMO_PASSWORD: z.string().min(12),
  CLINMESH_HOST: z.string().trim().min(1).default('127.0.0.1'),
  CLINMESH_PORT: z.string()
    .regex(/^\d+$/)
    .default('51868')
    .transform(Number)
    .pipe(z.number().int().min(1).max(65_535)),
  CLINMESH_PUBLIC_ORIGIN: z.url().optional(),
  CLINMESH_REFERENCE_DATABASE_PATH: z.string().trim().min(1).optional(),
  CLINMESH_REFERENCE_RELEASE_ID: z.string().trim().min(1).max(256).optional(),
  CLINMESH_SYNTHEA_PROVIDER_URL: httpUrlSchema.optional(),
  CLINMESH_TRUSTED_ORIGINS: z.string().trim().min(1).optional(),
  CLINMESH_WEB_ROOT: z.string().trim().min(1).optional(),
}).superRefine((environment, context) => {
  const values = [
    environment.CLINMESH_AI_API_KEY,
    environment.CLINMESH_AI_BASE_URL,
    environment.CLINMESH_AI_BRIEF_MODEL,
    environment.CLINMESH_AI_INVESTIGATION_MODEL,
  ]
  if (values.some(value => value !== undefined) && values.some(value => value === undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'AI base URL, API key, Brief model, and Investigation model must be configured together',
      path: ['CLINMESH_AI_BASE_URL'],
    })
  }
})

export interface ServerConfig {
  ai?: {
    apiKey: string
    baseUrl: string
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
  demoPassword: string
  hostname: string
  port: number
  referenceDatabasePath?: string
  referenceReleaseId?: string
  syntheaProviderUrl?: string
  trustedOrigins: string[]
  webRoot?: string
}

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
    'CLINMESH_REFERENCE_DATABASE_PATH',
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

export function readServerConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  const parsed = serverEnvironmentSchema.parse(environment)
  const authBaseUrl = parsed.CLINMESH_PUBLIC_ORIGIN
    ?? `http://${parsed.CLINMESH_HOST}:${parsed.CLINMESH_PORT}`
  const defaultTrustedOrigins = [authBaseUrl]
  if (parsed.CLINMESH_PUBLIC_ORIGIN === undefined && parsed.CLINMESH_HOST === '127.0.0.1') {
    defaultTrustedOrigins.push('http://127.0.0.1:51888')
  }
  const trustedOrigins = parsed.CLINMESH_TRUSTED_ORIGINS === undefined
    ? defaultTrustedOrigins
    : parsed.CLINMESH_TRUSTED_ORIGINS.split(',').map(origin => z.url().parse(origin.trim()))

  return {
    ...(parsed.CLINMESH_AI_BASE_URL === undefined
      ? {}
      : {
          ai: {
            apiKey: parsed.CLINMESH_AI_API_KEY!,
            baseUrl: parsed.CLINMESH_AI_BASE_URL,
            briefModel: parsed.CLINMESH_AI_BRIEF_MODEL!,
            ...(parsed.CLINMESH_AI_CATALOG_ENRICHMENT_MODEL === undefined
              ? {}
              : { catalogEnrichmentModel: parsed.CLINMESH_AI_CATALOG_ENRICHMENT_MODEL }),
            investigationModel: parsed.CLINMESH_AI_INVESTIGATION_MODEL!,
            maxResponseBytes: Number(parsed.CLINMESH_AI_MAX_RESPONSE_BYTES),
            timeoutMs: Number(parsed.CLINMESH_AI_TIMEOUT_MS),
          },
        }),
    authBaseUrl,
    authSecret: parsed.CLINMESH_AUTH_SECRET,
    cursorSecret: parsed.CLINMESH_CURSOR_SECRET,
    databasePath: parsed.CLINMESH_DATABASE_PATH,
    demoPassword: parsed.CLINMESH_DEMO_PASSWORD,
    hostname: parsed.CLINMESH_HOST,
    port: parsed.CLINMESH_PORT,
    ...(parsed.CLINMESH_REFERENCE_DATABASE_PATH === undefined
      ? {}
      : { referenceDatabasePath: parsed.CLINMESH_REFERENCE_DATABASE_PATH }),
    ...(parsed.CLINMESH_REFERENCE_RELEASE_ID === undefined
      ? {}
      : { referenceReleaseId: parsed.CLINMESH_REFERENCE_RELEASE_ID }),
    ...(parsed.CLINMESH_SYNTHEA_PROVIDER_URL === undefined
      ? {}
      : { syntheaProviderUrl: parsed.CLINMESH_SYNTHEA_PROVIDER_URL }),
    trustedOrigins,
    ...(parsed.CLINMESH_WEB_ROOT === undefined ? {} : { webRoot: parsed.CLINMESH_WEB_ROOT }),
  }
}
