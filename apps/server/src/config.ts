import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { z } from 'zod'

const httpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol
  return protocol === 'http:' || protocol === 'https:'
}, 'URL must use HTTP or HTTPS')

const serverEnvironmentSchema = z.object({
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
  CLINMESH_SYNTHEA_PROVIDER_URL: httpUrlSchema.optional(),
  CLINMESH_TRUSTED_ORIGINS: z.string().trim().min(1).optional(),
  CLINMESH_WEB_ROOT: z.string().trim().min(1).optional(),
})

export interface ServerConfig {
  authBaseUrl: string
  authSecret: string
  cursorSecret: string
  databasePath: string
  demoPassword: string
  hostname: string
  port: number
  referenceDatabasePath?: string
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
    ...(parsed.CLINMESH_SYNTHEA_PROVIDER_URL === undefined
      ? {}
      : { syntheaProviderUrl: parsed.CLINMESH_SYNTHEA_PROVIDER_URL }),
    trustedOrigins,
    ...(parsed.CLINMESH_WEB_ROOT === undefined ? {} : { webRoot: parsed.CLINMESH_WEB_ROOT }),
  }
}
