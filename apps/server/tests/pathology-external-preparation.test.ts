import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PathologyPreparationService } from '../src/application/pathology-preparation-service.ts'
import { PathologyAssetLibrary } from '../src/infrastructure/imaging-assets/pathology-asset-library.ts'
import { PathologyPreparationRepository } from '../src/infrastructure/sqlite/pathology-preparation-repository.ts'
import { SyntheticCaseRepository } from '../src/infrastructure/sqlite/synthetic-case-repository.ts'
import { SyntheticPatientProfileRepository } from '../src/infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import { PatientPersonaRepository } from '../src/infrastructure/sqlite/patient-persona-repository.ts'
import { CommandExecutor } from '../src/application/command-executor.ts'
import { AuthoredCasePackService } from '../src/application/scenario-data/authored-case-pack-service.ts'
import { compiledPathologyAuthoredCasePack } from '../src/application/scenario-data/pathology-authored-case-pack.ts'
import { externalPathologyCatalogSchema, externalPathologyReportHash, type ExternalPathologyAsset } from '../src/application/pathology-external-catalog.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { signIn, startConsultation } from './fixtures/imaging-scenario.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function asset(organ: 'colorectal' | 'thyroid'): ExternalPathologyAsset {
  const output = { kind: 'pathjx' as const, instanceId: 'synthetic-pathjx-instance', assetKey: `synthetic-${organ}`, contentHash: (organ === 'thyroid' ? 'a' : 'b').repeat(64), organ, specimenType: 'resection' as const, stain: 'HE' as const }
  const report = { revision: 1, diagnosis: `${organ === 'thyroid' ? '甲状腺结节性增生' : '结直肠管状腺瘤'}（合成测试报告）。`, immunohistochemistry: '本次未提供免疫组化切片。', microscopy: '合成测试：既往标本 H&E 切片。', note: '完全合成的接入测试，不作医学诊断。' }
  return externalPathologyCatalogSchema.parse({ packId: 'synthetic-pathjx-slides', ruleVersion: 1, assets: [{
    assetId: `synthetic-${organ}-slide`, diagnosis: { system: 'http://snomed.info/sct', code: organ === 'thyroid' ? '237495005' : '68496003' },
    examCode: organ === 'thyroid' ? 'thyroid-slide-consultation' : 'colorectal-slide-consultation',
    license: { source: 'https://example.invalid/synthetic-pathjx', identifier: 'synthetic-fixture', attribution: 'Synthetic fixture', deidentified: true, synthetic: true },
    output, sourceSpecimenType: organ === 'thyroid' ? 'prior-thyroid-surgical-specimen' : 'prior-colorectal-polypectomy',
    reports: [{ ...report, review: { conclusion: 'approved', contentHash: externalPathologyReportHash({ output }, report), reviewedAt: '2026-11-20T00:00:00Z', reviewer: 'Synthetic Reviewer' } }],
  }] }).assets[0]!
}

it('prepares both prior-specimen cases with template Personas and freezes matching external slide identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-external-pathology-'))
  const runtime = await createClinMeshRuntime({ authBaseUrl: 'http://localhost', authSecret: 'test-auth-secret-with-at-least-32-characters', cursorSecret: 'test-cursor-secret-with-at-least-32-characters', databasePath: join(directory, 'runtime.sqlite'), demoPassword: 'Synthetic-Demo-Password-2026!', autoDispatchIntervalMs: 0, migrationMode: 'apply', trustedOrigins: ['http://localhost'] })
  cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
  const administrator = await signIn(runtime)
  const context = (await runtime.identity.resolveSessionContext(new Headers({ cookie: administrator }))).actor
  const commands = new CommandExecutor(runtime.database, runtime.fhir)
  const cases = new SyntheticCaseRepository(runtime.database)
  const profiles = new SyntheticPatientProfileRepository(runtime.database)
  const personas = new PatientPersonaRepository(runtime.database, cases)
  const pack = new AuthoredCasePackService(commands, profiles, cases, personas, compiledPathologyAuthoredCasePack)
  const prepared = pack.prepare(context, { expectedEpoch: context.epoch }, 'pathology-pack-first').data
  expect(prepared.readyCount).toBe(2)
  expect(pack.prepare(context, { expectedEpoch: context.epoch }, 'pathology-pack-repeat').data.cases.map(item => item.case?.caseId)).toEqual(prepared.cases.map(item => item.case?.caseId))
  const assets = [asset('colorectal'), asset('thyroid')]
  let sourceAvailable = true
  const external = { catalog: async () => ({ packId: 'synthetic-pathjx-slides', ruleVersion: 1, assets }), available: async (_asset: ExternalPathologyAsset, workspaceId: string) => sourceAvailable && workspaceId === context.workspaceId }
  const preparations = new PathologyPreparationRepository(runtime.database)
  const preparation = new PathologyPreparationService({ cases, commands, profiles, preparations, library: new PathologyAssetLibrary({ catalogDirectory: join(directory, 'missing'), assetDirectory: join(directory, 'missing-assets') }), external })
  const result = (await preparation.prepareBatch({ context, idempotencyKey: 'prepare-both' })).data
  expect(result.prepared).toHaveLength(2)
  for (const entry of result.prepared) {
    const ready = entry.preparation!.exams.filter(exam => exam.status === 'ready')
    expect(ready).toHaveLength(1)
    expect(ready[0]!.examCode).not.toBe('breast-slide-consultation')
    expect(ready[0]!.evidence.facts).toEqual([])
    expect(entry.bindings).toHaveLength(1)
  }
  const firstCaseId = prepared.cases[0]!.case!.caseId
  const visit = await startConsultation(runtime, administrator, firstCaseId)
  const offering = await preparation.offering(context, { encounterId: visit.encounterId })
  expect(offering.readyExamCodes).toEqual(new Set(['colorectal-slide-consultation', 'thyroid-slide-consultation']))
  expect(offering.sourceProcedures.get('colorectal-slide-consultation')).toHaveLength(1)
  expect(offering.sourceProcedures.get('thyroid-slide-consultation')).toHaveLength(0)
  const otherWorkspace = await preparation.offering({ ...context, workspaceId: 'unconfigured-workspace' }, { encounterId: visit.encounterId })
  expect(otherWorkspace.readyExamCodes.size).toBe(0)
  assets[0] = { ...asset('colorectal'), reports: asset('colorectal').reports.map(report => ({ ...report, diagnosis: '未经重新核对的报告变化' })) }
  const staleReport = await preparation.offering(context, { encounterId: visit.encounterId })
  expect(staleReport.readyExamCodes).toEqual(new Set(['thyroid-slide-consultation']))
  expect(staleReport.sourceProcedures.get('colorectal-slide-consultation')).toHaveLength(1)
  assets[0] = asset('colorectal')
  sourceAvailable = false
  expect((await preparation.offering(context, { encounterId: visit.encounterId })).readyExamCodes.size).toBe(0)
  sourceAvailable = true
  const frozen = preparation.getCasePreparation(context, firstCaseId).bindings
  assets[0] = { ...asset('colorectal'), assetId: 'synthetic-replacement' }
  await preparation.prepareBatch({ context, idempotencyKey: 'after-start-prepare' })
  expect(preparation.getCasePreparation(context, firstCaseId).bindings).toEqual(frozen)
})
