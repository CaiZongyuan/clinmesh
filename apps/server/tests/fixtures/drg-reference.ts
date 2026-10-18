import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyReferenceMigrations, importReferenceDataRelease, openReferenceDatabase } from '../../src/infrastructure/sqlite/reference-database.ts'
import { importPreparedCatalogues, preparedManifestSchema } from '../../src/infrastructure/reference-data/prepared-catalogues.ts'
import { simulationReferenceRelease, simulationRules } from '../../src/application/drg-simulation-service.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../../src/application/scenario-data/medication-product-snapshot.ts'
import { syntheticNhcMedicalServiceSnapshot, syntheticWstValueSetSnapshot } from '../../src/application/scenario-data/medical-service-snapshot.ts'

export async function createDrgReferenceFixture(directory: string) {
  await mkdir(directory, { recursive: true })
  const source = (id: string, code: string | null, name: string, extra = {}) => ({
    id, code, name, kind: 'leaf', source: { pdfPage: 1, sourceVersion: 'synthetic-reference-fixture' },
    reviewFlags: [], runtimeEnabled: false, ...extra,
  })
  const data = [
    { dataset: 'icd10', table: 'records', rows: [
      source(simulationRules.mainDiagnosisId, 'J18.900', '肺炎'),
      source(simulationRules.complicationId, 'J96.000', '急性呼吸衰竭'),
      source('icd10-p1310-r03', 'I10.x00', '特发性（原发性）高血压'),
    ] },
    { dataset: 'icd9', table: 'records', rows: [source(simulationRules.completedProcedureId, '96.0400', '气管内插管'),
      source('hierarchy-only', null, '', { kind: 'hierarchy_only' })] },
    { dataset: 'drugs', table: 'records', rows: [source('drugs-p039-t0-r018', null, '阿莫西林'),
      source('drugs-p041-t0-r006', null, '头孢曲松'), source('drugs-p009-t0-r027', null, '奥美拉唑', { paymentStandard: { raw: '*', amount: null, state: 'confidential' } })] },
    { dataset: 'services', table: 'records', rows: [source('services-p0026-t0-r010', '12040000601', '静脉输液（住院/含输液器）', { billingUnit: '床日', price: { amount: '999', state: 'numeric' } })] },
    { dataset: 'drg', table: 'groups', rows: [source('fixture-drg', 'FIXTURE', '合成来源测试组')] },
  ]
  const files = []
  for (const table of data) {
    const path = `${table.dataset}-${table.table}.jsonl`
    const bytes = table.rows.map(row => JSON.stringify(row)).join('\n') + '\n'
    await writeFile(join(directory, path), bytes)
    files.push({ path, dataset: table.dataset, table: table.table, sha256: createHash('sha256').update(bytes).digest('hex'),
      rows: table.rows.length, sourceVersion: 'synthetic-reference-fixture' })
  }
  const manifest = preparedManifestSchema.parse({ schemaVersion: 'clinmesh.prepared-catalogues.v1',
    releaseId: simulationReferenceRelease, createdAt: '2026-10-18T00:00:00.000Z', archiveChecksumsSha256: 'a'.repeat(64),
    sources: { fixture: { synthetic: true } }, files })
  const manifestPath = join(directory, 'manifest.json')
  const manifestText = JSON.stringify(manifest) + '\n'
  await writeFile(manifestPath, manifestText)
  const lock = { releaseId: simulationReferenceRelease, manifestPath, manifestSha256: createHash('sha256').update(manifestText).digest('hex') }
  const databasePath = join(directory, 'reference.sqlite')
  const db = openReferenceDatabase({ databasePath, busyTimeoutMs: 5000 })
  try {
    applyReferenceMigrations(db)
    const artifact = JSON.stringify({ schemaVersion: '1', concepts: [], medicationProducts: syntheticNhsaMedicationProductSnapshot,
      services: syntheticNhcMedicalServiceSnapshot, valueSetEntries: syntheticWstValueSetSnapshot }) + '\n'
    await writeFile(join(directory, 'hospital.json'), artifact)
    const hospitalManifest = join(directory, 'hospital-release.json')
    await writeFile(hospitalManifest, JSON.stringify({ releaseId: 'clinmesh-hospital-reference-fixture-2026-08-28',
      createdAt: '2026-08-28T00:00:00.000Z', schemaVersion: '1', sources: [{
        sourceId: 'synthetic-hospital', artifactPath: 'hospital.json', acquisitionMethod: 'generated',
        checksum: createHash('sha256').update(artifact).digest('hex'), licenseId: 'LicenseRef-ClinMesh-Proprietary',
        retrievedAt: '2026-10-18T00:00:00.000Z', sourceUrl: 'https://example.test/synthetic-reference', upstreamVersion: 'synthetic-test',
      }] }))
    importReferenceDataRelease(db, hospitalManifest)
    await importPreparedCatalogues(db, manifestPath, lock)
  } finally { db.close() }
  return { databasePath, manifestPath, lock }
}
