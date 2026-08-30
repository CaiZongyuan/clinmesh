import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../src/cli.ts'

function captureStream() {
  let value = ''
  return {
    stream: { write: (chunk: string) => { value += chunk } },
    value: () => value,
  }
}

describe('catalog-backed operation execution', () => {
  it('parses typed flags and validates the executor response', async () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const execute = vi.fn().mockResolvedValue({
      items: [],
      page: 2,
      pageSize: 20,
      releaseId: 'reference-release-current',
      total: 0,
    })

    const exitCode = await runCli([
      'reference',
      'diagnoses',
      'search',
      '--query',
      '糖尿病',
      '--page',
      '2',
    ], { stderr: stderr.stream, stdout: stdout.stream }, { execute })

    expect(exitCode).toBe(0)
    expect(stderr.value()).toBe('')
    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith('reference.diagnoses.search', {
      page: 2,
      pageSize: 20,
      query: '糖尿病',
    })
    expect(JSON.parse(stdout.value())).toMatchObject({
      data: {
        items: [],
        page: 2,
        releaseId: 'reference-release-current',
      },
      ok: true,
      operation: {
        id: 'reference.diagnoses.search',
        mode: 'query',
        version: 1,
      },
      schemaVersion: 1,
    })
  })

  it('reads strict nested input from a workspace file and keeps idempotency out of business input', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'clinmesh-cli-'))
    try {
      const inputPath = join(workspace, 'diagnosis-draft.json')
      await writeFile(inputPath, JSON.stringify({
        encounterId: 'encounter-1',
        encounterVersion: '3',
        entries: [{ catalogItemId: 'diagnosis-1', role: 'primary' }],
        expectedDraftVersion: 0,
      }))
      const stdout = captureStream()
      const stderr = captureStream()
      const execute = vi.fn().mockResolvedValue({
        auditId: 'audit-1',
        data: { draftVersion: 1 },
        effects: [],
        requestId: 'request-1',
        warnings: [],
      })

      const exitCode = await runCli([
        'encounter', 'diagnosis', 'draft', 'set',
        '--input', '@diagnosis-draft.json',
        '--idempotency-key', 'diagnosis-draft-call-1',
      ], { stderr: stderr.stream, stdout: stdout.stream }, {
        cwd: workspace,
        execute,
      })

      expect(exitCode).toBe(0)
      expect(stderr.value()).toBe('')
      expect(execute).toHaveBeenCalledWith(
        'encounter.diagnosis.draft.set',
        {
          encounterId: 'encounter-1',
          encounterVersion: '3',
          entries: [{ catalogItemId: 'diagnosis-1', role: 'primary' }],
          expectedDraftVersion: 0,
        },
        { idempotencyKey: 'diagnosis-draft-call-1' },
      )
    } finally {
      await rm(workspace, { force: true, recursive: true })
    }
  })
})
