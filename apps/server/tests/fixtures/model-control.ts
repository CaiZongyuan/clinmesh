import { randomUUID } from 'node:crypto'
import { modelUsageControlSchema, type ModelUsagePolicyConfig } from '@clinmesh/contracts/model-usage'
import type { createClinMeshRuntime } from '../../src/runtime.ts'

export async function setModelControl(runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>, cookie: string,
  policy: ModelUsagePolicyConfig, origin = 'http://localhost') {
  const headers = { cookie, origin, 'content-type': 'application/json', 'idempotency-key': randomUUID() }
  const current = modelUsageControlSchema.parse(await (await runtime.app.request('/api/model-usage/control', { headers })).json())
  const response = await runtime.app.request('/api/model-usage/control', { method: 'PUT', headers,
    body: JSON.stringify({ expectedVersion: current.workspace.version, ...policy }) })
  if (response.status !== 200) throw new Error(await response.text())
  return modelUsageControlSchema.parse(await response.json())
}
