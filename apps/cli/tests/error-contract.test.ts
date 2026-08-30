import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/cli.ts'
import { createHttpExecutor } from '../src/http-executor.ts'
import { createProfileStore } from '../src/profile-store.ts'

function captureStream() {
  let value = ''
  return {
    stream: { write: (chunk: string) => { value += chunk } },
    value: () => value,
  }
}

describe('clinmesh error contract', () => {
  it('returns one structured error for an unknown command without Commander prose', async () => {
    const stdout = captureStream()
    const stderr = captureStream()

    const exitCode = await runCli(
      ['unknown-command'],
      { stderr: stderr.stream, stdout: stdout.stream },
    )

    expect(exitCode).toBe(2)
    expect(stdout.value()).toBe('')
    expect(JSON.parse(stderr.value())).toMatchObject({
      error: {
        code: 'invalid_command',
        outcome: 'definitely_not_sent',
        retryable: false,
        type: 'validation',
      },
      ok: false,
    })
  })

  it('rejects table output in Agent context before executing an operation', async () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const execute = vi.fn()

    const exitCode = await runCli([
      'reference', 'diagnoses', 'search',
      '--query', '糖尿病',
      '--output', 'table',
    ], { stderr: stderr.stream, stdout: stdout.stream }, {
      authMode: 'agent',
      execute,
    })

    expect(exitCode).toBe(2)
    expect(stdout.value()).toBe('')
    expect(execute).not.toHaveBeenCalled()
    expect(JSON.parse(stderr.value())).toMatchObject({
      error: {
        code: 'invalid_output_mode',
        outcome: 'definitely_not_sent',
        retryable: false,
        type: 'validation',
      },
      ok: false,
    })
  })

  it('rejects a human profile in Agent context before executing an operation', async () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const execute = vi.fn()

    const exitCode = await runCli([
      'reference', 'diagnoses', 'search',
      '--query', '糖尿病',
      '--profile', 'doctor',
    ], { stderr: stderr.stream, stdout: stdout.stream }, {
      authMode: 'agent',
      execute,
    })

    expect(exitCode).toBe(3)
    expect(stdout.value()).toBe('')
    expect(execute).not.toHaveBeenCalled()
    expect(JSON.parse(stderr.value())).toMatchObject({
      error: {
        code: 'human_profile_forbidden',
        outcome: 'definitely_not_sent',
        retryable: false,
        type: 'authentication',
      },
      ok: false,
    })
  })

  it('classifies a workspace-escaping input path before executing an operation', async () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const execute = vi.fn()

    const exitCode = await runCli([
      'encounter', 'diagnosis', 'draft', 'set',
      '--input', '@../outside.json',
      '--idempotency-key', 'diagnosis-draft-path-error',
    ], { stderr: stderr.stream, stdout: stdout.stream }, {
      cwd: '/synthetic/workspace',
      execute,
    })

    expect(exitCode).toBe(2)
    expect(stdout.value()).toBe('')
    expect(execute).not.toHaveBeenCalled()
    expect(JSON.parse(stderr.value())).toMatchObject({
      error: {
        code: 'invalid_input_source',
        outcome: 'definitely_not_sent',
        retryable: false,
        type: 'validation',
      },
      ok: false,
    })
  })

  it('classifies a missing human profile as configuration without issuing a request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-missing-profile-'))
    try {
      const stdout = captureStream()
      const stderr = captureStream()
      const fetch = vi.fn()
      const profiles = createProfileStore({ directory })

      const exitCode = await runCli(
        ['agent', 'client', 'list', '--profile', 'missing'],
        { stderr: stderr.stream, stdout: stdout.stream },
        { fetch, profiles },
      )

      expect(exitCode).toBe(3)
      expect(stdout.value()).toBe('')
      expect(fetch).not.toHaveBeenCalled()
      expect(JSON.parse(stderr.value())).toMatchObject({
        error: {
          code: 'profile_not_found',
          outcome: 'definitely_not_sent',
          retryable: false,
          type: 'config',
        },
        ok: false,
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('returns a structured definitely-not-sent validation error', async () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const execute = vi.fn()

    const exitCode = await runCli([
      'reference', 'diagnoses', 'search', '--query', '短',
    ], { stderr: stderr.stream, stdout: stdout.stream }, { execute })

    expect(exitCode).toBe(2)
    expect(stdout.value()).toBe('')
    expect(execute).not.toHaveBeenCalled()
    expect(JSON.parse(stderr.value())).toMatchObject({
      error: {
        code: 'invalid_input',
        outcome: 'definitely_not_sent',
        param: 'query',
        retryable: false,
        type: 'validation',
      },
      ok: false,
      schemaVersion: 1,
    })
  })

  it('requires explicit confirmation for a high-risk human command', async () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const execute = vi.fn()

    const exitCode = await runCli([
      'encounter', 'complete',
      '--encounter-id', 'encounter-1',
      '--encounter-version', '3',
      '--idempotency-key', 'encounter-complete-call-1',
    ], { stderr: stderr.stream, stdout: stdout.stream }, {
      authMode: 'human',
      execute,
    })

    expect(exitCode).toBe(10)
    expect(stdout.value()).toBe('')
    expect(execute).not.toHaveBeenCalled()
    expect(JSON.parse(stderr.value())).toMatchObject({
      error: {
        code: 'confirmation_required',
        outcome: 'definitely_not_sent',
        retryable: false,
        type: 'confirmation',
      },
      ok: false,
    })
  })

  it('reports a write transport failure as ambiguous without retrying or leaking the token', async () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const execute = createHttpExecutor({
      baseUrl: 'http://127.0.0.1:51868',
      credential: { kind: 'agent', token: 'cma_secret_task_token_00000000000000000000' },
      fetch,
    })

    const exitCode = await runCli([
      'encounter', 'diagnosis', 'draft', 'set',
      '--input', '-',
      '--idempotency-key', 'diagnosis-draft-call-ambiguous',
    ], { stderr: stderr.stream, stdout: stdout.stream }, {
      authMode: 'agent',
      execute,
      readStdin: async () => JSON.stringify({
        encounterId: 'encounter-1',
        encounterVersion: '3',
        entries: [{ catalogItemId: 'diagnosis-1', role: 'primary' }],
        expectedDraftVersion: 0,
      }),
    })

    expect(exitCode).toBe(7)
    expect(fetch).toHaveBeenCalledOnce()
    expect(stdout.value()).toBe('')
    const output = stderr.value()
    expect(output).not.toContain('cma_secret')
    expect(JSON.parse(output)).toMatchObject({
      error: {
        code: 'ambiguous_outcome',
        idempotencyKey: 'diagnosis-draft-call-ambiguous',
        operationId: 'encounter.diagnosis.draft.set',
        outcome: 'ambiguous',
        retryable: false,
        type: 'network',
      },
      ok: false,
    })
  })

  it('preserves a server version conflict as a structured non-retryable error', async () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const fetch = vi.fn().mockResolvedValue(Response.json({
      error: {
        code: 'EXPECTED_VERSION_CONFLICT',
        conflict: {
          currentVersion: '4',
          expectedVersion: '3',
          owner: 'prescription-draft',
          resource: 'Encounter/encounter-1',
        },
        message: 'The draft version changed',
      },
    }, { status: 409 }))
    const execute = createHttpExecutor({
      baseUrl: 'http://127.0.0.1:51868',
      credential: { kind: 'agent', token: 'cma_secret_task_token_00000000000000000000' },
      fetch,
    })

    const exitCode = await runCli([
      'encounter', 'diagnosis', 'draft', 'set',
      '--input', '-',
      '--idempotency-key', 'diagnosis-draft-call-conflict',
    ], { stderr: stderr.stream, stdout: stdout.stream }, {
      authMode: 'agent',
      execute,
      readStdin: async () => JSON.stringify({
        encounterId: 'encounter-1',
        encounterVersion: '3',
        entries: [{ catalogItemId: 'diagnosis-1', role: 'primary' }],
        expectedDraftVersion: 0,
      }),
    })

    expect(exitCode).toBe(5)
    expect(stdout.value()).toBe('')
    expect(JSON.parse(stderr.value())).toMatchObject({
      error: {
        code: 'EXPECTED_VERSION_CONFLICT',
        conflict: {
          currentVersion: '4',
          expectedVersion: '3',
          owner: 'prescription-draft',
        },
        outcome: 'definitely_not_sent',
        retryable: false,
        type: 'conflict',
      },
      ok: false,
    })
  })
})
