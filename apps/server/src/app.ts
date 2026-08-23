import { extname } from 'node:path'
import type { HealthResponse } from '@clinmesh/contracts/health'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { createCapabilityStatement } from './fhir/capabilities.ts'

export interface CreateAppOptions {
  webRoot?: string
}

function isServicePath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/') || path === '/fhir' || path.startsWith('/fhir/')
}

function isStaticAssetPath(path: string): boolean {
  return extname(path) !== ''
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const app = new Hono()

  app.get('/api/health', (context) => {
    const response: HealthResponse = {
      service: 'clinmesh-server',
      status: 'ok',
      fhirVersion: '5.0.0',
    }
    return context.json(response)
  })

  app.get('/fhir/R5/metadata', (context) => context.json(
    createCapabilityStatement(),
    200,
    { 'Content-Type': 'application/fhir+json' },
  ))

  if (options.webRoot !== undefined) {
    app.use('*', serveStatic({ root: options.webRoot, precompressed: true }))
    const serveEntryPoint = serveStatic({ root: options.webRoot, path: 'index.html' })

    app.get('*', async (context, next) => {
      if (isServicePath(context.req.path) || isStaticAssetPath(context.req.path)) return context.notFound()

      const response = await serveEntryPoint(context, next)
      return response ?? context.notFound()
    })
  }

  return app
}
