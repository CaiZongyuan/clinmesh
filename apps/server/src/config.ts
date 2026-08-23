import { z } from 'zod'

const serverEnvironmentSchema = z.object({
  CLINMESH_HOST: z.string().trim().min(1).default('127.0.0.1'),
  CLINMESH_PORT: z.string()
    .regex(/^\d+$/)
    .default('8787')
    .transform(Number)
    .pipe(z.number().int().min(1).max(65_535)),
  CLINMESH_WEB_ROOT: z.string().trim().min(1).optional(),
})

export interface ServerConfig {
  hostname: string
  port: number
  webRoot?: string
}

export function readServerConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  const parsed = serverEnvironmentSchema.parse(environment)

  return {
    hostname: parsed.CLINMESH_HOST,
    port: parsed.CLINMESH_PORT,
    ...(parsed.CLINMESH_WEB_ROOT === undefined ? {} : { webRoot: parsed.CLINMESH_WEB_ROOT }),
  }
}
