import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { z } from 'zod'
import { createClinMeshProxyHandler, CLINMESH_PROXY_PATH } from './proxy.ts'
import { installAgentProofBridge } from './agent-proof-bridge.ts'

export const inject = ['webServer', 'tools']

const configSchema = z.object({
  bridgeSecret: z.string().min(32).optional(),
  maxRequestBytes: z.number().int().positive().max(8 * 1024 * 1024).optional(),
  maxResponseBytes: z.number().int().positive().max(16 * 1024 * 1024).optional(),
  requestTimeoutMs: z.number().int().positive().max(5 * 60_000).optional(),
  upstreamOrigin: z.url(),
}).strict()

export function apply(ctx: Context, config: unknown): void {
  const parsed = configSchema.parse(config)
  const handler = createClinMeshProxyHandler({
    ...(parsed.maxRequestBytes === undefined ? {} : { maxRequestBytes: parsed.maxRequestBytes }),
    ...(parsed.maxResponseBytes === undefined ? {} : { maxResponseBytes: parsed.maxResponseBytes }),
    ...(parsed.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: parsed.requestTimeoutMs }),
    upstreamOrigin: parsed.upstreamOrigin,
  })
  ctx.effect(
    () => ctx.webServer.register({
      handler,
      kind: 'prefix',
      path: CLINMESH_PROXY_PATH,
    }),
    'clinmesh-dsh-web: application proxy',
  )
  if (parsed.bridgeSecret !== undefined) installAgentProofBridge(ctx, parsed.bridgeSecret)
}
