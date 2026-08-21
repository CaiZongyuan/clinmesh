import type { HealthResponse } from '@clinmesh/contracts/health'
import { Hono } from 'hono'

export interface ServerBindings {
  ASSETS: Fetcher
}

export const app = new Hono<{ Bindings: ServerBindings }>()

app.get('/api/health', (context) => {
  const response: HealthResponse = {
    service: 'clinmesh-server',
    status: 'ok',
    fhirVersion: '5.0.0',
  }
  return context.json(response)
})

app.get('/fhir/R5/metadata', (context) => context.json({
  resourceType: 'CapabilityStatement',
  status: 'active',
  date: new Date().toISOString(),
  kind: 'instance',
  fhirVersion: '5.0.0',
  format: ['json'],
  rest: [{ mode: 'server', resource: [] }],
}))

app.all('*', (context) => context.env.ASSETS.fetch(context.req.raw))
