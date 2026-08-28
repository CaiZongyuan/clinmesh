import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { serviceCatalogSearchSchema } from '@clinmesh/contracts/his'
import { scenarioGenerationRequestSchema } from '@clinmesh/contracts/scenario'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { CommandExecutor, type ActorContext } from '../application/command-executor.ts'
import {
  applyReferenceMigrations,
  importReferenceDataRelease,
  openReferenceDatabase,
} from '../infrastructure/sqlite/reference-database.ts'
import { createClinMeshRuntime } from '../runtime.ts'
import {
  performanceResultSchema,
  summarizeDurations,
  type PerformanceWorkloadResult,
} from './performance-contract.ts'
import {
  readActionTraceMetrics,
  SqlitePerformanceProbe,
  type SqlitePerformanceSnapshot,
} from './sqlite-performance-probe.ts'

const performancePassword = 'Synthetic-performance-password-2026!'
const performanceOrigin = 'http://localhost'

async function databaseBytes(databasePath: string): Promise<number> {
  let total = 0
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      total += (await stat(path)).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return total
}

function workloadResult(input: {
  actors?: number
  afterBytes: number
  beforeBytes: number
  busyCount?: number
  elapsedMs: number
  errorCount?: number
  iterations: number
  latenciesMs: number[]
  name: string
  path: PerformanceWorkloadResult['path']
  probe: SqlitePerformanceSnapshot
  queryPlan?: string[]
  retryCount?: number
  trace?: { bytes: number; rows: number }
}): PerformanceWorkloadResult {
  return {
    actors: input.actors ?? 1,
    busyCount: input.busyCount ?? 0,
    databaseBytes: {
      after: input.afterBytes,
      before: input.beforeBytes,
      growth: input.afterBytes - input.beforeBytes,
    },
    errorCount: input.errorCount ?? 0,
    iterations: input.iterations,
    latencyMs: summarizeDurations(input.latenciesMs),
    name: input.name,
    path: input.path,
    queryCount: input.probe.queryCount,
    queryPlan: input.queryPlan ?? [],
    retryCount: input.retryCount ?? 0,
    rowsWritten: input.probe.rowsWritten,
    statementCount: input.probe.statementCount,
    throughputPerSecond: input.elapsedMs === 0 ? 0 : input.iterations / (input.elapsedMs / 1_000),
    trace: input.trace ?? { bytes: 0, rows: 0 },
    transactionMs: summarizeDurations(input.probe.transactionDurationsMs),
    writeCount: input.probe.writeCount,
  }
}

async function createRuntime(databasePath: string, probe: SqlitePerformanceProbe) {
  return createClinMeshRuntime({
    authBaseUrl: performanceOrigin,
    authSecret: 'synthetic-performance-auth-secret-123456789',
    cursorSecret: 'synthetic-performance-cursor-secret-123456',
    databasePath,
    demoPassword: performancePassword,
    migrationMode: 'apply',
    performanceObserver: probe,
    trustedOrigins: [performanceOrigin],
  })
}

async function signInAdministrator(
  runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>,
  email = 'admin@demo.clinmesh.local',
): Promise<string> {
  const response = await runtime.app.request('/api/auth/sign-in/email', {
    body: JSON.stringify({
      email,
      password: performancePassword,
    }),
    headers: { 'content-type': 'application/json', origin: performanceOrigin },
    method: 'POST',
  })
  if (!response.ok) throw new Error(`Performance administrator sign-in failed: ${response.status}`)
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
}

function administratorContext(epoch = 'epoch-1', scenarioRunId = 'scenario-run-1'): ActorContext {
  return {
    actorId: 'actor-administrator',
    epoch,
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-administrator',
    practitionerRoleId: 'practitioner-role-administrator',
    roleCode: 'administrator',
    scenarioRunId,
    workspaceId: 'workspace-demo',
  }
}

async function runCatalogSearch(directory: string): Promise<PerformanceWorkloadResult> {
  const probe = new SqlitePerformanceProbe()
  const databasePath = join(directory, 'catalog.sqlite')
  const runtime = await createRuntime(databasePath, probe)
  try {
    const cookie = await signInAdministrator(runtime)
    const unbounded = await runtime.app.request(
      '/api/his/v1/catalogs/services?page=1&pageSize=101',
      { headers: { cookie } },
    )
    if (unbounded.status !== 400) throw new Error('Catalog performance workload accepted an unbounded page')
    probe.reset()
    const beforeBytes = await databaseBytes(databasePath)
    const latenciesMs: number[] = []
    const iterations = 20
    let errorCount = 0
    const startedAt = performance.now()
    for (let index = 0; index < iterations; index += 1) {
      const sampleStartedAt = performance.now()
      const response = await runtime.app.request(
        `/api/his/v1/catalogs/services?page=${index % 2 + 1}&pageSize=2`,
        { headers: { cookie } },
      )
      latenciesMs.push(performance.now() - sampleStartedAt)
      if (!response.ok) {
        errorCount += 1
        continue
      }
      serviceCatalogSearchSchema.parse(await response.json())
    }
    const elapsedMs = performance.now() - startedAt
    const snapshot = probe.snapshot()
    const catalogQuerySources = [...new Set(snapshot.statementSources.filter(source => (
      /\bFROM hospital_service_catalog\b/u.test(source)
    )))]
    const searchBindings: unknown[] = ['workspace-demo', 'epoch-1', null, null, null, null]
    const queryPlan = catalogQuerySources.map((source) => {
      const bindings = /\bLIMIT \? OFFSET \?\s*$/u.test(source.trim())
        ? [...searchBindings, 2, 0]
        : searchBindings
      return (runtime.database.driver.prepare(
        `EXPLAIN QUERY PLAN ${source}`,
      ).all(...bindings) as Array<{ detail: string }>).map(row => row.detail).join('\n')
    })
    return workloadResult({
      afterBytes: await databaseBytes(databasePath),
      beforeBytes,
      elapsedMs,
      errorCount,
      iterations,
      latenciesMs,
      name: 'catalog-search-http',
      path: 'http',
      probe: snapshot,
      queryPlan,
      trace: readActionTraceMetrics(runtime.database),
    })
  } finally {
    await runtime.close()
  }
}

async function runCommandWorkload(
  directory: string,
  kind: 'heavy' | 'ordinary',
): Promise<PerformanceWorkloadResult> {
  const probe = new SqlitePerformanceProbe()
  const databasePath = join(directory, `command-${kind}.sqlite`)
  const runtime = await createRuntime(databasePath, probe)
  try {
    runtime.database.driver.exec(`
      CREATE TABLE performance_command_fixture (
        command_id TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (command_id, row_index)
      ) STRICT
    `)
    const commands = new CommandExecutor(runtime.database, runtime.fhir)
    const dataSchema = z.object({ sequence: z.number().int().nonnegative() }).strict()
    const context = administratorContext()
    const iterations = kind === 'heavy' ? 8 : 20
    const rowsPerCommand = kind === 'heavy' ? 25 : 0
    const insert = runtime.database.driver.prepare(`
      INSERT INTO performance_command_fixture (command_id, row_index, value)
      VALUES (?, ?, ?)
    `)
    probe.reset()
    const beforeBytes = await databaseBytes(databasePath)
    const latenciesMs: number[] = []
    let errorCount = 0
    const startedAt = performance.now()
    for (let sequence = 0; sequence < iterations; sequence += 1) {
      const sampleStartedAt = performance.now()
      try {
        commands.execute({
          context,
          dataSchema,
          expectedVersions: {},
          idempotencyKey: `performance-${kind}-${sequence}`,
          input: { sequence },
          operation: `performance.${kind}`,
        }, () => {
          const commandId = `${kind}-${sequence}`
          for (let rowIndex = 0; rowIndex < rowsPerCommand; rowIndex += 1) {
            insert.run(commandId, rowIndex, `synthetic-value-${rowIndex}`)
          }
          return {
            data: { sequence },
            effects: Array.from({ length: rowsPerCommand }, (_, rowIndex) => ({
              kind: 'created' as const,
              reference: `PerformanceFixture/${commandId}-${rowIndex}`,
              versionId: '1',
            })),
          }
        })
      } catch {
        errorCount += 1
      }
      latenciesMs.push(performance.now() - sampleStartedAt)
    }
    const elapsedMs = performance.now() - startedAt
    const snapshot = probe.snapshot()
    return workloadResult({
      afterBytes: await databaseBytes(databasePath),
      beforeBytes,
      elapsedMs,
      errorCount,
      iterations,
      latenciesMs,
      name: `command-${kind}-application`,
      path: 'application',
      probe: snapshot,
      trace: readActionTraceMetrics(runtime.database),
    })
  } finally {
    await runtime.close()
  }
}

async function runTraceControl(directory: string): Promise<PerformanceWorkloadResult> {
  const probe = new SqlitePerformanceProbe()
  const databasePath = join(directory, 'trace-control.sqlite')
  const runtime = await createRuntime(databasePath, probe)
  try {
    runtime.database.driver.exec(`
      CREATE TABLE performance_trace_control (
        command_id TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (command_id, row_index)
      ) STRICT
    `)
    const insert = runtime.database.driver.prepare(`
      INSERT INTO performance_trace_control (command_id, row_index, value)
      VALUES (?, ?, ?)
    `)
    const iterations = 8
    probe.reset()
    const beforeBytes = await databaseBytes(databasePath)
    const latenciesMs: number[] = []
    const startedAt = performance.now()
    for (let sequence = 0; sequence < iterations; sequence += 1) {
      const sampleStartedAt = performance.now()
      runtime.database.driver.exec('BEGIN IMMEDIATE')
      try {
        for (let rowIndex = 0; rowIndex < 25; rowIndex += 1) {
          insert.run(`control-${sequence}`, rowIndex, `synthetic-value-${rowIndex}`)
        }
        runtime.database.driver.exec('COMMIT')
      } catch (error) {
        if (runtime.database.driver.inTransaction) runtime.database.driver.exec('ROLLBACK')
        throw error
      }
      latenciesMs.push(performance.now() - sampleStartedAt)
    }
    const elapsedMs = performance.now() - startedAt
    const snapshot = probe.snapshot()
    return workloadResult({
      afterBytes: await databaseBytes(databasePath),
      beforeBytes,
      elapsedMs,
      iterations,
      latenciesMs,
      name: 'trace-control-sqlite',
      path: 'sqlite',
      probe: snapshot,
      trace: readActionTraceMetrics(runtime.database),
    })
  } finally {
    await runtime.close()
  }
}

async function runScenarioLifecycle(directory: string): Promise<PerformanceWorkloadResult> {
  const probe = new SqlitePerformanceProbe()
  const databasePath = join(directory, 'scenario-lifecycle.sqlite')
  const runtime = await createRuntime(databasePath, probe)
  try {
    probe.reset()
    const beforeBytes = await databaseBytes(databasePath)
    const latenciesMs: number[] = []
    let context = administratorContext()
    let errorCount = 0
    const startedAt = performance.now()
    for (let sequence = 0; sequence < 3; sequence += 1) {
      for (const operation of ['install', 'reset'] as const) {
        const sampleStartedAt = performance.now()
        try {
          const response = operation === 'install'
            ? runtime.scenario.install({
                context,
                idempotencyKey: `performance-install-${sequence}`,
                kind: 'candidate',
              })
            : runtime.scenario.reset({
                context,
                idempotencyKey: `performance-reset-${sequence}`,
                scenarioRunId: context.scenarioRunId,
              })
          context = administratorContext(response.data.epoch, response.data.scenarioRunId)
        } catch {
          errorCount += 1
        }
        latenciesMs.push(performance.now() - sampleStartedAt)
      }
    }
    const elapsedMs = performance.now() - startedAt
    const snapshot = probe.snapshot()
    return workloadResult({
      afterBytes: await databaseBytes(databasePath),
      beforeBytes,
      elapsedMs,
      errorCount,
      iterations: latenciesMs.length,
      latenciesMs,
      name: 'scenario-install-reset-application',
      path: 'application',
      probe: snapshot,
      trace: readActionTraceMetrics(runtime.database),
    })
  } finally {
    await runtime.close()
  }
}

async function writeSyntheticReferenceFixtures(directory: string, iterations: number): Promise<string[]> {
  await mkdir(directory, { recursive: true })
  const concepts = Array.from({ length: 200 }, (_, index) => ({
    code: `PERF-${String(index).padStart(4, '0')}`,
    display: `合成性能概念 ${index}`,
    domain: 'diagnosis',
    id: `performance-concept-${index}`,
    sourceLocator: `concepts[${index}]`,
    status: 'active',
    system: 'urn:clinmesh:performance:concept',
    version: 'synthetic-performance-v1',
  }))
  const artifactJson = `${JSON.stringify({ concepts, schemaVersion: '1' })}\n`
  await writeFile(join(directory, 'concepts.json'), artifactJson)
  const checksum = createHash('sha256').update(artifactJson).digest('hex')
  const manifests: string[] = []
  for (let index = 0; index < iterations; index += 1) {
    const manifestPath = join(directory, `release-${index}.json`)
    await writeFile(manifestPath, `${JSON.stringify({
      createdAt: `2026-08-28T00:00:0${index}.000Z`,
      releaseId: `performance-release-${index}`,
      schemaVersion: '1',
      sources: [{
        acquisitionMethod: 'generated',
        artifactPath: 'concepts.json',
        checksum,
        licenseId: 'CC0-1.0',
        retrievedAt: '2026-08-28T00:00:00.000Z',
        sourceId: 'synthetic-performance-concepts',
        sourceUrl: 'https://example.test/clinmesh/performance-concepts',
        upstreamVersion: 'synthetic-performance-v1',
      }],
    })}\n`)
    manifests.push(manifestPath)
  }
  return manifests
}

async function runReferenceImport(directory: string): Promise<PerformanceWorkloadResult> {
  const workloadDirectory = join(directory, 'reference-import')
  const iterations = 3
  const manifests = await writeSyntheticReferenceFixtures(workloadDirectory, iterations)
  const probe = new SqlitePerformanceProbe()
  const databasePath = join(workloadDirectory, 'reference.sqlite')
  const database = openReferenceDatabase({
    busyTimeoutMs: 5_000,
    databasePath,
    performanceObserver: probe,
  })
  try {
    applyReferenceMigrations(database)
    probe.reset()
    const beforeBytes = await databaseBytes(databasePath)
    const latenciesMs: number[] = []
    let errorCount = 0
    const startedAt = performance.now()
    for (const manifestPath of manifests) {
      const sampleStartedAt = performance.now()
      try {
        importReferenceDataRelease(database, manifestPath)
      } catch {
        errorCount += 1
      }
      latenciesMs.push(performance.now() - sampleStartedAt)
    }
    const elapsedMs = performance.now() - startedAt
    return workloadResult({
      afterBytes: await databaseBytes(databasePath),
      beforeBytes,
      elapsedMs,
      errorCount,
      iterations,
      latenciesMs,
      name: 'reference-import-application',
      path: 'application',
      probe: probe.snapshot(),
    })
  } finally {
    database.close()
  }
}

export async function runCiPerformanceProfile() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-performance-ci-'))
  const startedAt = new Date()
  try {
    const workloads = []
    workloads.push(await runReferenceImport(directory))
    workloads.push(await runCatalogSearch(directory))
    workloads.push(await runCommandWorkload(directory, 'ordinary'))
    workloads.push(await runTraceControl(directory))
    workloads.push(await runCommandWorkload(directory, 'heavy'))
    workloads.push(await runScenarioLifecycle(directory))
    return performanceResultSchema.parse({
      environment: { node: process.version, platform: process.platform, sqlite: sqliteVersion() },
      finishedAt: new Date().toISOString(),
      profile: 'ci',
      schemaVersion: '1',
      startedAt: startedAt.toISOString(),
      workloads,
    })
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

export async function runTrajectoryPerformanceProfile() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-performance-trajectory-'))
  const databasePath = join(directory, 'trajectory.sqlite')
  const probe = new SqlitePerformanceProbe()
  const startedAt = new Date()
  const runtime = await createRuntime(databasePath, probe)
  try {
    const administratorCookie = await signInAdministrator(runtime)
    const doctorCookie = await signInAdministrator(runtime, 'doctor@demo.clinmesh.local')
    const administratorContext = (await runtime.identity.resolveSessionContext(
      new Headers({ cookie: administratorCookie }),
    )).actor
    probe.reset()
    const beforeBytes = await databaseBytes(databasePath)
    const latenciesMs: number[] = []
    const measure = async <Result>(callback: () => Result | Promise<Result>): Promise<Result> => {
      const sampleStartedAt = performance.now()
      const result = await callback()
      latenciesMs.push(performance.now() - sampleStartedAt)
      return result
    }
    const workloadStartedAt = performance.now()
    const dataset = (await measure(() => runtime.scenarioData.generate({
      context: administratorContext,
      idempotencyKey: 'performance-trajectory-generate',
      request: scenarioGenerationRequestSchema.parse({
        modules: ['hypertension'],
        name: '合成高血压性能轨迹',
        population: { age: { maximum: 60, minimum: 60 }, count: 1, gender: 'female' },
        providerId: 'builtin',
        seeds: { clinical: 7331, population: 4242 },
        timeRange: { end: '2026-08-01', start: '2020-01-01' },
        timeZone: 'Asia/Shanghai',
      }),
    }))).data
    await measure(() => runtime.scenarioData.install({
      context: administratorContext,
      datasetId: dataset.datasetId,
      expectedVersion: dataset.version,
      idempotencyKey: 'performance-trajectory-install',
    }))
    const doctorContext = (await measure(() => runtime.identity.resolveSessionContext(
      new Headers({ cookie: doctorCookie }),
    ))).actor
    const candidate = (await measure(() => runtime.workflow.virtualPatients(doctorContext, 20))).items[0]
    if (candidate === undefined) throw new Error('Performance trajectory has no Virtual Patient')
    const started = (await measure(() => runtime.workflow.startVirtualPatient({
      context: doctorContext,
      expectedVersion: candidate.version,
      idempotencyKey: 'performance-trajectory-start',
      virtualPatientId: candidate.id,
    }))).data
    const encounterReference = `Encounter/${started.encounterId}`
    await measure(() => runtime.workflow.askConsultationQuestion({
      context: doctorContext,
      encounterId: started.encounterId,
      expectedVersion: 1,
      expectedVersions: {
        [encounterReference]: '1',
        [`Task/${started.queueTaskId}`]: '1',
      },
      idempotencyKey: 'performance-trajectory-question',
      questionCode: 'symptom-dizziness',
    }))
    const laboratoryDraft = (await measure(() => runtime.workflow.saveLaboratoryRequestDraft({
      catalogItemId: 'lab-cbc',
      context: doctorContext,
      encounterId: started.encounterId,
      expectedDraftVersion: 0,
      expectedVersions: { [encounterReference]: '1' },
      idempotencyKey: 'performance-trajectory-lab-draft',
      indicationCode: 'hypertension',
    }))).data
    const laboratory = (await measure(() => runtime.workflow.issueLaboratoryRequest({
      context: doctorContext,
      encounterId: started.encounterId,
      expectedDraftVersion: laboratoryDraft.draftVersion,
      expectedVersions: { [encounterReference]: '1' },
      idempotencyKey: 'performance-trajectory-lab-issue',
    }))).data.request
    for (let step = 0; step < 3; step += 1) {
      await measure(() => runtime.dispatcher.dispatchOnce())
    }
    const reportedCase = await measure(() => runtime.workflow.doctorCaseDetail(
      doctorContext,
      started.caseId,
    ))
    const reported = reportedCase.laboratoryRequests?.requests.find(request => (
      request.id === laboratory.id
    ))
    if (reported?.report === undefined) throw new Error('Performance trajectory report is missing')
    const report = reported.report
    await measure(() => runtime.workflow.acknowledgeLaboratoryReport({
      context: doctorContext,
      diagnosticReportId: report.diagnosticReportId,
      expectedRequestVersion: reported.version,
      expectedVersions: {
        [`DiagnosticReport/${report.diagnosticReportId}`]: report.diagnosticReportVersion,
      },
      idempotencyKey: 'performance-trajectory-lab-acknowledge',
      requestId: reported.id,
    }))
    const diagnosisDraft = (await measure(() => runtime.workflow.saveDiagnosisDraft({
      context: doctorContext,
      encounterId: started.encounterId,
      entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary' }],
      expectedDraftVersion: 0,
      expectedVersions: { [encounterReference]: '1' },
      idempotencyKey: 'performance-trajectory-diagnosis-draft',
    }))).data
    const diagnosis = (await measure(() => runtime.workflow.confirmDiagnosis({
      context: doctorContext,
      encounterId: started.encounterId,
      expectedDraftVersion: diagnosisDraft.draftVersion,
      expectedVersions: { [encounterReference]: '1' },
      idempotencyKey: 'performance-trajectory-diagnosis-confirm',
    }))).data
    const prescriptionDraft = (await measure(() => runtime.workflow.savePrescriptionDraft({
      context: doctorContext,
      encounterId: started.encounterId,
      expectedDraftVersion: 0,
      expectedVersions: { [encounterReference]: diagnosis.encounterVersion },
      idempotencyKey: 'performance-trajectory-prescription-draft',
      items: [{
        catalogItemId: 'medication-amlodipine',
        courseDays: 30,
        doseText: '5 mg',
        frequencyCode: 'QD',
        quantity: 30,
      }],
    }))).data
    await measure(() => runtime.workflow.issuePrescription({
      context: doctorContext,
      encounterId: started.encounterId,
      expectedDraftVersion: prescriptionDraft.draftVersion,
      expectedVersions: { [encounterReference]: diagnosis.encounterVersion },
      idempotencyKey: 'performance-trajectory-prescription-issue',
    }))
    const document = {
      assessment: '多次血压升高，诊断为高血压。',
      auxiliaryExamination: '血常规已报告并确认。',
      chiefComplaint: '发现血压升高，偶有头晕。',
      disposition: '门诊启动氨氯地平治疗。',
      followUp: '两至四周复查血压和外周水肿。',
      historyOfPresentIllness: '近期多次血压偏高，无胸痛或气促。',
      physicalExamination: '血压 162/96 mmHg，双下肢无水肿。',
      priorMedicalHistory: '两年前曾被告知高血压。',
    }
    const documentDraft = (await measure(() => runtime.workflow.saveClinicalDocumentDraft({
      context: doctorContext,
      document,
      encounterId: started.encounterId,
      expectedDraftVersion: 0,
      expectedVersions: { [encounterReference]: diagnosis.encounterVersion },
      idempotencyKey: 'performance-trajectory-document-draft',
    }))).data
    const preview = (await measure(() => runtime.workflow.previewStructuredClinicalDocumentSign({
      context: doctorContext,
      encounterId: started.encounterId,
      expectedDraftVersion: documentDraft.draftVersion,
      expectedVersions: { [encounterReference]: diagnosis.encounterVersion },
      idempotencyKey: 'performance-trajectory-document-preview',
    }))).data
    await measure(() => runtime.workflow.signStructuredClinicalDocument({
      commitToken: preview.commitToken,
      context: doctorContext,
      encounterId: started.encounterId,
      expectedVersions: { [encounterReference]: diagnosis.encounterVersion },
      idempotencyKey: 'performance-trajectory-document-sign',
      previewId: preview.previewId,
    }))
    await measure(() => runtime.workflow.completeEncounter({
      context: doctorContext,
      encounterId: started.encounterId,
      expectedVersions: { [encounterReference]: diagnosis.encounterVersion },
      idempotencyKey: 'performance-trajectory-complete',
    }))
    const completed = await measure(() => runtime.workflow.doctorCompletedCaseDetail(
      doctorContext,
      started.caseId,
    ))
    if (completed.encounter.status !== 'completed') {
      throw new Error('Performance trajectory did not complete its Encounter')
    }
    const elapsedMs = performance.now() - workloadStartedAt
    const snapshot = probe.snapshot()
    const workload = workloadResult({
      afterBytes: await databaseBytes(databasePath),
      beforeBytes,
      elapsedMs,
      iterations: latenciesMs.length,
      latenciesMs,
      name: 'hypertension-trajectory-application',
      path: 'application',
      probe: snapshot,
      trace: readActionTraceMetrics(runtime.database),
    })
    return performanceResultSchema.parse({
      environment: { node: process.version, platform: process.platform, sqlite: sqliteVersion() },
      finishedAt: new Date().toISOString(),
      profile: 'trajectory',
      schemaVersion: '1',
      startedAt: startedAt.toISOString(),
      workloads: [workload],
    })
  } finally {
    await runtime.close()
    await rm(directory, { force: true, recursive: true })
  }
}

interface SaturationWorkerResult {
  busyCount: number
  errorCount: number
  latenciesMs: number[]
  retryCount: number
  rowsWritten: number
  statementCount: number
  transactionDurationsMs: number[]
  writeCount: number
}

const saturationWorkerSource = `
  const { parentPort, workerData } = require('node:worker_threads');
  const Database = require('better-sqlite3');
  const database = new Database(workerData.databasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 1');
  const insert = database.prepare(
    'INSERT INTO performance_concurrency (actor_id, sequence, value) VALUES (?, ?, ?)'
  );
  const barrier = new Int32Array(workerData.barrier);
  const sleeper = new Int32Array(workerData.sleeper);
  Atomics.add(barrier, 0, 1);
  Atomics.notify(barrier, 0);
  parentPort.postMessage({ type: 'ready' });
  Atomics.wait(barrier, 1, 0);
  let busyCount = 0;
  let errorCount = 0;
  let retryCount = 0;
  let rowsWritten = 0;
  let statementCount = 0;
  let writeCount = 0;
  const latenciesMs = [];
  const transactionDurationsMs = [];
  for (let sequence = 0; sequence < workerData.iterations; sequence += 1) {
    const sampleStartedAt = performance.now();
    let complete = false;
    for (let attempt = 0; attempt < 1000 && !complete; attempt += 1) {
      const transactionStartedAt = performance.now();
      try {
        statementCount += 1;
        database.exec('BEGIN IMMEDIATE');
        statementCount += 1;
        writeCount += 1;
        const result = insert.run(
          workerData.actorId,
          sequence,
          'synthetic-concurrency-' + workerData.actorId + '-' + sequence
        );
        Atomics.wait(sleeper, 0, 0, 1);
        statementCount += 1;
        database.exec('COMMIT');
        rowsWritten += result.changes;
        transactionDurationsMs.push(performance.now() - transactionStartedAt);
        complete = true;
      } catch (error) {
        if (database.inTransaction) {
          statementCount += 1;
          database.exec('ROLLBACK');
        }
        if (error && error.code === 'SQLITE_BUSY') {
          busyCount += 1;
          retryCount += 1;
          Atomics.wait(sleeper, 0, 0, 1);
        } else {
          errorCount += 1;
          complete = true;
        }
      }
    }
    if (!complete) errorCount += 1;
    latenciesMs.push(performance.now() - sampleStartedAt);
  }
  database.close();
  parentPort.postMessage({
    result: {
      busyCount,
      errorCount,
      latenciesMs,
      retryCount,
      rowsWritten,
      statementCount,
      transactionDurationsMs,
      writeCount,
    },
    type: 'result',
  });
`

interface SaturationWorkerHandle {
  ready: Promise<void>
  result: Promise<SaturationWorkerResult>
  worker: Worker
}

function createDeferred<Result>() {
  let reject!: (reason?: unknown) => void
  let resolve!: (value: Result | PromiseLike<Result>) => void
  const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function startSaturationWorker(workerData: {
  actorId: number
  barrier: SharedArrayBuffer
  databasePath: string
  iterations: number
  sleeper: SharedArrayBuffer
}): SaturationWorkerHandle {
  let resultReceived = false
  const ready = createDeferred<void>()
  const result = createDeferred<SaturationWorkerResult>()
  void result.promise.catch(() => undefined)
  const worker = new Worker(saturationWorkerSource, { eval: true, workerData })
  worker.on('message', (message: { result?: SaturationWorkerResult; type: 'ready' | 'result' }) => {
    if (message.type === 'ready') {
      ready.resolve()
      return
    }
    if (message.result === undefined) {
      result.reject(new Error('Saturation worker returned no result'))
      return
    }
    resultReceived = true
    result.resolve(message.result)
  })
  worker.once('error', (error) => {
    const workerError = error instanceof Error ? error : new Error(String(error))
    ready.reject(workerError)
    result.reject(workerError)
  })
  worker.once('exit', (code) => {
    if (code !== 0) {
      const error = new Error(`Saturation worker exited with code ${code}`)
      ready.reject(error)
      result.reject(error)
    } else if (!resultReceived) {
      result.reject(new Error('Saturation worker exited without a result'))
    }
  })
  return { ready: ready.promise, result: result.promise, worker }
}

async function runSaturationLevel(
  directory: string,
  actors: number,
): Promise<PerformanceWorkloadResult> {
  const databasePath = join(directory, `saturation-${actors}.sqlite`)
  const setup = new Database(databasePath)
  setup.pragma('journal_mode = WAL')
  setup.exec(`
    CREATE TABLE performance_concurrency (
      actor_id INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (actor_id, sequence)
    ) STRICT
  `)
  setup.close()
  const beforeBytes = await databaseBytes(databasePath)
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)
  const sleeper = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const barrierView = new Int32Array(barrier)
  const iterationsPerActor = 20
  const workers = Array.from({ length: actors }, (_, actorId) => startSaturationWorker({
    actorId,
    barrier,
    databasePath,
    iterations: iterationsPerActor,
    sleeper,
  }))
  try {
    await Promise.all(workers.map(worker => worker.ready))
  } catch (error) {
    await Promise.all(workers.map(worker => worker.worker.terminate()))
    throw error
  }
  const startedAt = performance.now()
  Atomics.store(barrierView, 1, 1)
  Atomics.notify(barrierView, 1, actors)
  let workerResults: SaturationWorkerResult[]
  try {
    workerResults = await Promise.all(workers.map(worker => worker.result))
  } catch (error) {
    await Promise.all(workers.map(worker => worker.worker.terminate()))
    throw error
  }
  const elapsedMs = performance.now() - startedAt
  const latenciesMs = workerResults.flatMap(result => result.latenciesMs)
  const probe: SqlitePerformanceSnapshot = {
    queryCount: 0,
    rowsWritten: workerResults.reduce((sum, result) => sum + result.rowsWritten, 0),
    statementCount: workerResults.reduce((sum, result) => sum + result.statementCount, 0),
    statementDurationsMs: [],
    statementSources: [],
    transactionDurationsMs: workerResults.flatMap(result => result.transactionDurationsMs),
    writeCount: workerResults.reduce((sum, result) => sum + result.writeCount, 0),
  }
  return workloadResult({
    actors,
    afterBytes: await databaseBytes(databasePath),
    beforeBytes,
    busyCount: workerResults.reduce((sum, result) => sum + result.busyCount, 0),
    elapsedMs,
    errorCount: workerResults.reduce((sum, result) => sum + result.errorCount, 0),
    iterations: actors * iterationsPerActor,
    latenciesMs,
    name: `sqlite-saturation-${actors}-actors`,
    path: 'sqlite',
    probe,
    retryCount: workerResults.reduce((sum, result) => sum + result.retryCount, 0),
  })
}

function sqliteVersion(): string {
  const database = new Database(':memory:')
  const version = (database.prepare('SELECT sqlite_version() AS version').get() as {
    version: string
  }).version
  database.close()
  return version
}

export async function runSaturationPerformanceProfile() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-performance-saturation-'))
  const startedAt = new Date()
  try {
    const workloads: PerformanceWorkloadResult[] = []
    for (const actors of [1, 5, 10, 25]) {
      workloads.push(await runSaturationLevel(directory, actors))
    }
    return performanceResultSchema.parse({
      environment: { node: process.version, platform: process.platform, sqlite: sqliteVersion() },
      finishedAt: new Date().toISOString(),
      profile: 'saturation',
      schemaVersion: '1',
      startedAt: startedAt.toISOString(),
      workloads,
    })
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

export async function runFullImportPerformanceProfile(manifestPath: string) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-performance-full-import-'))
  const databasePath = join(directory, 'reference.sqlite')
  const probe = new SqlitePerformanceProbe()
  const startedAt = new Date()
  const database = openReferenceDatabase({
    busyTimeoutMs: 5_000,
    databasePath,
    performanceObserver: probe,
  })
  try {
    applyReferenceMigrations(database)
    probe.reset()
    const beforeBytes = await databaseBytes(databasePath)
    const sampleStartedAt = performance.now()
    importReferenceDataRelease(database, manifestPath)
    const elapsedMs = performance.now() - sampleStartedAt
    const workload = workloadResult({
      afterBytes: await databaseBytes(databasePath),
      beforeBytes,
      elapsedMs,
      iterations: 1,
      latenciesMs: [elapsedMs],
      name: 'reference-full-import-application',
      path: 'application',
      probe: probe.snapshot(),
    })
    return performanceResultSchema.parse({
      environment: { node: process.version, platform: process.platform, sqlite: sqliteVersion() },
      finishedAt: new Date().toISOString(),
      profile: 'full-import',
      schemaVersion: '1',
      startedAt: startedAt.toISOString(),
      workloads: [workload],
    })
  } finally {
    database.close()
    await rm(directory, { force: true, recursive: true })
  }
}
