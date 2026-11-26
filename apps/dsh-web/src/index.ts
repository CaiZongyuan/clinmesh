import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { z } from 'zod'
import { createClinMeshProxyHandler, CLINMESH_PROXY_PATH } from './proxy.ts'
import { installAgentProofBridge } from './agent-proof-bridge.ts'
import { createModelBridgeHandler, createModelCapabilitiesHandler } from './model-bridge.ts'
import {
  modelBridgePath,
  modelCapabilitiesPath,
  modelReasoningEffortAutoLowest,
  modelReasoningEffortDefault,
} from '@clinmesh/contracts/model-bridge'

export const inject = ['webServer', 'tools', 'llm']

export const Config = Schema.object({
  bridgeSecret: Schema.string().role('secret'),
  upstreamOrigin: Schema.string().required(),
  maxRequestBytes: Schema.number(), maxResponseBytes: Schema.number(), requestTimeoutMs: Schema.number(),
  generationModel: Schema.string().default('default').volatile(),
  generationReasoningEffort: Schema.string().default(modelReasoningEffortDefault).volatile(),
  fastModel: Schema.string().default('default').volatile(),
  fastReasoningEffort: Schema.string().default(modelReasoningEffortAutoLowest).volatile(),
})

const volatileStringSchema = z.custom<Volatile<string>>(value => typeof value === 'object' && value !== null && 'get' in value)

const configSchema = z.object({
  bridgeSecret: z.string().min(32).optional(),
  maxRequestBytes: z.number().int().positive().max(8 * 1024 * 1024).optional(),
  maxResponseBytes: z.number().int().positive().max(16 * 1024 * 1024).optional(),
  requestTimeoutMs: z.number().int().positive().max(5 * 60_000).optional(),
  upstreamOrigin: z.url(),
  generationModel: volatileStringSchema.optional(),
  generationReasoningEffort: volatileStringSchema.optional(),
  fastModel: volatileStringSchema.optional(),
  fastReasoningEffort: volatileStringSchema.optional(),
}).strict()

export function apply(ctx: Context, config: unknown): void {
  const parsed = configSchema.parse(config)
  // src/ and the bundled lib/ share this path to the owning Web brand asset.
  const mark = readFileSync(resolve(import.meta.dirname, '../../web/src/assets/clinmesh-mark.webp'))
  const icon = `<link rel="icon" type="image/webp" href="data:image/webp;base64,${mark.toString('base64')}">`
  // Normalize host assignments synchronously: observers leave a transient native tab title.
  const titleGuard = `<script>(() => {
    const title = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
    Object.defineProperty(document, 'title', {
      configurable: true,
      get() { return title.get.call(document); },
      set() { title.set.call(document, 'ClinMesh'); }
    });
    const restore = () => {
      if (document.title !== 'ClinMesh') document.title = 'ClinMesh';
    };
    new MutationObserver(restore).observe(document.head, {
      childList: true, characterData: true, subtree: true
    });
    restore();
  })();</script>`
  ctx.effect(
    () => ctx.webServer.tapIndex(html => html
      .replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, '')
      .replace(/<link\b(?=[^>]*\brel\s*=\s*["'](?:shortcut\s+)?icon["'])[^>]*>/gi, '')
      .replace(/<head\b[^>]*>/i, head => `${head}<meta charset="utf-8"><title>ClinMesh</title>${titleGuard}${icon}`)),
    'clinmesh-dsh-web: initial browser tab identity',
  )
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
  if (typeof ctx.inject === 'function') {
    ctx.inject(['llm'], child => {
      const capabilities = createModelCapabilitiesHandler(child)
      child.effect(() => child.webServer.register({ kind: 'exact', path: modelCapabilitiesPath, handler: capabilities.handler }), 'clinmesh-dsh-web: model capabilities')
      child.effect(() => capabilities.dispose, 'clinmesh-dsh-web: cancel model capability requests')
    })
  }
  if (parsed.bridgeSecret !== undefined) installAgentProofBridge(ctx, parsed.bridgeSecret, { upstreamOrigin: parsed.upstreamOrigin })
  if (parsed.bridgeSecret !== undefined) {
    const secret = parsed.bridgeSecret
    ctx.inject(['llm', 'agentDefaultModel'], child => {
      const bridge = createModelBridgeHandler(child, secret, () => ({
        generationModel: parsed.generationModel?.get() ?? 'default',
        generationReasoningEffort: parsed.generationReasoningEffort?.get() ?? modelReasoningEffortDefault,
        fastModel: parsed.fastModel?.get() ?? 'default',
        fastReasoningEffort: parsed.fastReasoningEffort?.get() ?? modelReasoningEffortAutoLowest,
      }))
      child.effect(() => child.webServer.register({ kind: 'exact', path: modelBridgePath, handler: bridge.handler }), 'clinmesh-dsh-web: model bridge')
      child.effect(() => bridge.dispose, 'clinmesh-dsh-web: cancel model requests')
    })
  }
}
