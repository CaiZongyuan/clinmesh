import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertPerformanceBaseline,
  performanceResultSchema,
  performanceWorkloadResultSchema,
  summarizeDurations,
} from '../src/performance/performance-contract.ts'
import { SqlitePerformanceProbe } from '../src/performance/sqlite-performance-probe.ts'
import { applyMigrations, openClinMeshDatabase } from '../src/infrastructure/sqlite/database.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { force: true, recursive: true })
  )))
})

const workload = performanceWorkloadResultSchema.parse({
  actors: 1,
  busyCount: 0,
  databaseBytes: { after: 4_096, before: 0, growth: 4_096 },
  errorCount: 0,
  iterations: 10,
  latencyMs: { maximum: 10, mean: 5.5, minimum: 1, p50: 5, p95: 10, p99: 10 },
  name: 'catalog-search-http',
  path: 'http',
  queryCount: 20,
  queryPlan: ['SEARCH hospital_service_catalog USING INDEX hospital_service_catalog_search_idx'],
  retryCount: 0,
  rowsWritten: 0,
  statementCount: 20,
  throughputPerSecond: 100,
  trace: { bytes: 0, rows: 0 },
  transactionMs: { maximum: 0, mean: 0, minimum: 0, p50: 0, p95: 0, p99: 0 },
  writeCount: 0,
})

describe('Performance contract', () => {
  it('uses fixed nearest-rank percentiles and rejects a fabricated rows-read metric', () => {
    expect(summarizeDurations(Array.from({ length: 100 }, (_, index) => index + 1))).toEqual({
      maximum: 100,
      mean: 50.5,
      minimum: 1,
      p50: 50,
      p95: 95,
      p99: 99,
    })
    const result = {
      environment: { node: process.version, platform: process.platform, sqlite: '3.0.0' },
      finishedAt: '2026-08-28T00:00:01.000Z',
      profile: 'ci',
      schemaVersion: '1',
      startedAt: '2026-08-28T00:00:00.000Z',
      workloads: [workload],
    }
    expect(performanceResultSchema.parse(result)).toEqual(result)
    expect(performanceResultSchema.safeParse({
      ...result,
      workloads: [{ ...workload, rowsRead: 20 }],
    }).success).toBe(false)
  })

  it('gates stable count and storage metrics without gating reported latency', () => {
    const baseline = {
      schemaVersion: '1',
      workloads: {
        'catalog-search-http': {
          maximumBusyCount: 0,
          maximumDatabaseGrowthBytes: 8_192,
          maximumErrorCount: 0,
          maximumQueriesPerIteration: 2,
          maximumRetryCount: 0,
          maximumRowsWrittenPerIteration: 0,
          maximumStatementsPerIteration: 2,
          maximumTraceBytesPerIteration: 0,
          maximumTraceRowsPerIteration: 0,
          maximumWritesPerIteration: 0,
          minimumRowsWrittenPerIteration: 0,
          requiredQueryPlan: 'hospital_service_catalog_search_idx',
        },
      },
    } as const
    expect(() => assertPerformanceBaseline([workload], baseline)).not.toThrow()
    expect(() => assertPerformanceBaseline([{
      ...workload,
      latencyMs: { ...workload.latencyMs, p99: 99_999 },
      statementCount: 21,
    }], baseline)).toThrow('statement budget')
    expect(() => assertPerformanceBaseline([{
      ...workload,
      queryCount: 21,
    }], baseline)).toThrow('query budget')
    expect(() => assertPerformanceBaseline([{
      ...workload,
      rowsWritten: 1,
    }], baseline)).toThrow('rows-written ceiling')
    expect(() => assertPerformanceBaseline([
      workload,
      { ...workload, name: 'unbudgeted-workload' },
    ], baseline)).toThrow('Performance baseline is missing: unbudgeted-workload')
  })

  it('observes real SQLite query, write, row, and transaction metrics', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-performance-probe-'))
    temporaryDirectories.push(directory)
    const probe = new SqlitePerformanceProbe()
    const database = openClinMeshDatabase({
      busyTimeoutMs: 5_000,
      databasePath: join(directory, 'clinmesh.sqlite'),
      performanceObserver: probe,
    })
    applyMigrations(database)
    probe.reset()

    database.driver.prepare('SELECT COUNT(*) AS count FROM workspace').get()
    database.driver.exec('BEGIN IMMEDIATE')
    database.driver.prepare(`
      INSERT INTO workspace (workspace_id, name, active_epoch, created_at)
      VALUES ('performance-workspace', '合成性能工作区', NULL, '2026-08-28T00:00:00.000Z')
    `).run()
    database.driver.exec('COMMIT')

    expect(probe.snapshot()).toMatchObject({
      queryCount: 1,
      rowsWritten: 1,
      statementCount: 4,
      writeCount: 1,
    })
    expect(probe.snapshot().transactionDurationsMs).toHaveLength(1)
    database.close()
  })
})
