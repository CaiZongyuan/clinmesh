import { describe, expect, it } from 'vitest'
import { listHisOperations } from '@clinmesh/contracts/his-operations'
import { runCli } from '../src/cli.ts'

function captureStream() {
  let value = ''
  return {
    stream: {
      write(chunk: string) {
        value += chunk
      },
    },
    value: () => value,
  }
}

describe('clinmesh operations', () => {
  it('lists the local HIS operation catalog as one JSON envelope', async () => {
    const stdout = captureStream()
    const stderr = captureStream()

    const exitCode = await runCli(['operations', 'list'], {
      stderr: stderr.stream,
      stdout: stdout.stream,
    })

    expect(exitCode).toBe(0)
    expect(stderr.value()).toBe('')
    const envelope = JSON.parse(stdout.value())
    expect(envelope).toMatchObject({
      data: { operations: expect.any(Array) },
      ok: true,
      schemaVersion: 1,
    })
    expect(envelope.data.operations).toHaveLength(listHisOperations().length)
    expect(envelope.data.operations[0]).toEqual({
      cliPath: ['admin', 'laboratory-services', 'candidates', 'search'],
      handlerOwner: 'LaboratoryServicePublisher',
      id: 'admin.laboratory-services.candidates.search',
      identities: ['agent', 'human'],
      mode: 'query',
      previewToken: 'none',
      risk: 'read',
      roles: ['administrator'],
      skill: 'clinmesh-administrator',
      summary: 'Search laboratory publication candidates by source and panel status',
      version: 2,
    })
  })

  it('renders machine-readable input and output schemas without exposing the raw route', async () => {
    const stdout = captureStream()
    const stderr = captureStream()

    const exitCode = await runCli(
      ['operations', 'schema', 'reference.diagnoses.search'],
      { stderr: stderr.stream, stdout: stdout.stream },
    )

    expect(exitCode).toBe(0)
    expect(stderr.value()).toBe('')
    const envelope = JSON.parse(stdout.value())
    expect(envelope).toMatchObject({
      data: {
        operation: {
          cliPath: ['reference', 'diagnoses', 'search'],
          id: 'reference.diagnoses.search',
          inputSchema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            additionalProperties: false,
            properties: {
              page: { default: 1, type: 'integer' },
              pageSize: { default: 20, maximum: 50, type: 'integer' },
              query: { maxLength: 100, minLength: 3, type: 'string' },
            },
            type: 'object',
          },
          outputSchema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
          },
          requirements: {
            expectedVersions: false,
            idempotency: 'none',
          },
        },
      },
      ok: true,
      schemaVersion: 1,
    })
    expect(stdout.value()).not.toContain('/api/his/v1')
  })

  it('renders successful human discovery as an ASCII table on request', async () => {
    const stdout = captureStream()
    const stderr = captureStream()

    const exitCode = await runCli(
      ['operations', 'list', '--output', 'table'],
      { stderr: stderr.stream, stdout: stdout.stream },
      { authMode: 'human' },
    )

    expect(exitCode).toBe(0)
    expect(stderr.value()).toBe('')
    expect(stdout.value()).toContain('cliPath')
    expect(stdout.value()).toContain('reference.diagnoses.search')
    expect(() => JSON.parse(stdout.value())).toThrow()
  })
})
