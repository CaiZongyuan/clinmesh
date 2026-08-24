import { z } from 'zod'

const serverEnvironmentSchema = z.object({
  CLINMESH_AUTH_SECRET: z.string().min(32),
  CLINMESH_CURSOR_SECRET: z.string().min(32),
  CLINMESH_DATABASE_PATH: z.string().trim().min(1),
  CLINMESH_DEMO_PASSWORD: z.string().min(12),
  CLINMESH_HOST: z.string().trim().min(1).default('127.0.0.1'),
  CLINMESH_PORT: z.string()
    .regex(/^\d+$/)
    .default('8787')
    .transform(Number)
    .pipe(z.number().int().min(1).max(65_535)),
  CLINMESH_PUBLIC_ORIGIN: z.url().optional(),
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
  trustedOrigins: string[]
  webRoot?: string
}

export function readServerConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  const parsed = serverEnvironmentSchema.parse(environment)
  const authBaseUrl = parsed.CLINMESH_PUBLIC_ORIGIN
    ?? `http://${parsed.CLINMESH_HOST}:${parsed.CLINMESH_PORT}`
  const trustedOrigins = parsed.CLINMESH_TRUSTED_ORIGINS === undefined
    ? [authBaseUrl]
    : parsed.CLINMESH_TRUSTED_ORIGINS.split(',').map(origin => z.url().parse(origin.trim()))

  return {
    authBaseUrl,
    authSecret: parsed.CLINMESH_AUTH_SECRET,
    cursorSecret: parsed.CLINMESH_CURSOR_SECRET,
    databasePath: parsed.CLINMESH_DATABASE_PATH,
    demoPassword: parsed.CLINMESH_DEMO_PASSWORD,
    hostname: parsed.CLINMESH_HOST,
    port: parsed.CLINMESH_PORT,
    trustedOrigins,
    ...(parsed.CLINMESH_WEB_ROOT === undefined ? {} : { webRoot: parsed.CLINMESH_WEB_ROOT }),
  }
}
