import type { AddressInfo } from 'node:net'
import { healthResponseSchema } from '@clinmesh/contracts/health'
import { describe, expect, it } from 'vitest'
import { startServer } from '../src/server.ts'

describe('Node.js runtime', () => {
  it('serves the Hono application over a real HTTP listener', async () => {
    const server = startServer({ hostname: '127.0.0.1', port: 0 })

    try {
      await new Promise<void>((resolve) => server.once('listening', resolve))
      const address = server.address() as AddressInfo
      const response = await fetch(`http://127.0.0.1:${address.port}/api/health`)

      expect(response.status).toBe(200)
      expect(healthResponseSchema.parse(await response.json())).toEqual({
        fhirVersion: '5.0.0',
        service: 'clinmesh-server',
        status: 'ok',
      })
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error))
      })
    }
  })
})
