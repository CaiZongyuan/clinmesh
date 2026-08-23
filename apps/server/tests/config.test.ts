import { describe, expect, it } from 'vitest'
import { readServerConfig } from '../src/config.ts'

describe('Node.js server configuration', () => {
  it('uses the local single-instance defaults', () => {
    expect(readServerConfig({})).toEqual({
      hostname: '127.0.0.1',
      port: 8787,
    })
  })

  it('rejects an invalid listener port before startup', () => {
    expect(() => readServerConfig({ CLINMESH_PORT: 'invalid' })).toThrow()
  })
})
