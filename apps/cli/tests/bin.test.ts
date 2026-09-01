import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('clinmesh process entrypoint', () => {
  it('forwards arguments through the repository root entrypoint', () => {
    const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
    const result = spawnSync('pnpm', ['clinmesh', '--help'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).not.toContain('"ok": false')
    expect(result.stdout).toContain('Usage: clinmesh')
  })

  it('prints help successfully', () => {
    const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url))
    const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
    const result = spawnSync(tsx, [entry, '--help'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Usage: clinmesh')
  })

  it('runs local operation discovery without credentials or network', () => {
    const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url))
    const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
    const result = spawnSync(tsx, [entry, 'operations', 'list'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
      },
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const envelope = JSON.parse(result.stdout)
    expect(envelope).toMatchObject({ ok: true, schemaVersion: 1 })
    expect(envelope.data.operations).toHaveLength(53)
  })
})
