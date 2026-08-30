import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runFullImportPerformanceProfile,
  runTrajectoryPerformanceProfile,
} from '../src/performance/performance-runner.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { force: true, recursive: true })
  )))
})

describe('Performance runner', () => {
  it('runs the fixed hypertension clinical trajectory through completion', async () => {
    const result = await runTrajectoryPerformanceProfile()

    expect(result.workloads).toEqual([expect.objectContaining({
      errorCount: 0,
      name: 'hypertension-trajectory-application',
      rowsWritten: expect.any(Number),
      trace: { bytes: expect.any(Number), rows: expect.any(Number) },
    })])
    expect(result.workloads[0]!.trace.rows).toBeGreaterThan(0)
  })

  it('runs a supplied full-import manifest without committing its source data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-performance-full-import-test-'))
    temporaryDirectories.push(directory)
    const artifactJson = `${JSON.stringify({
      concepts: [{
        code: 'PERF-001',
        display: '合成全量导入概念',
        domain: 'diagnosis',
        id: 'performance-full-import-concept',
        sourceLocator: 'concepts[0]',
        status: 'active',
        system: 'urn:clinmesh:performance:concept',
        version: 'synthetic-performance-v1',
      }],
      schemaVersion: '1',
    })}\n`
    await writeFile(join(directory, 'concepts.json'), artifactJson)
    const manifestPath = join(directory, 'manifest.json')
    await writeFile(manifestPath, `${JSON.stringify({
      createdAt: '2026-08-28T00:00:00.000Z',
      releaseId: 'performance-full-import-test',
      schemaVersion: '1',
      sources: [{
        acquisitionMethod: 'generated',
        artifactPath: 'concepts.json',
        checksum: createHash('sha256').update(artifactJson).digest('hex'),
        licenseId: 'CC0-1.0',
        retrievedAt: '2026-08-28T00:00:00.000Z',
        sourceId: 'synthetic-performance-concepts',
        sourceUrl: 'https://example.test/clinmesh/performance-concepts',
        upstreamVersion: 'synthetic-performance-v1',
      }],
    })}\n`)

    const result = await runFullImportPerformanceProfile(manifestPath)

    expect(result.workloads).toEqual([expect.objectContaining({
      errorCount: 0,
      name: 'reference-full-import-application',
      rowsWritten: expect.any(Number),
    })])
    expect(result.workloads[0]!.rowsWritten).toBeGreaterThan(0)
  })
})
