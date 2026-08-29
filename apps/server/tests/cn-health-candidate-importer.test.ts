import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import {
  parseCnHealthCandidateReferenceArtifact,
} from '../src/infrastructure/reference-data/cn-health-candidate-importer.ts'

type CandidateDataset =
  | 'laboratory-cn'
  | 'loinc-zh-cn'
  | 'nhc-icd10-clinical'
  | 'nhsa-drugs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
})

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function populateCandidate(database: Database.Database, datasetId: CandidateDataset): void {
  database.pragma('application_id = 0x434e4844')
  if (datasetId === 'laboratory-cn') {
    database.exec(`
      CREATE TABLE laboratory_concept (
        code TEXT PRIMARY KEY,
        system TEXT NOT NULL,
        terminology_version TEXT NOT NULL,
        display_zh TEXT NOT NULL,
        category TEXT NOT NULL,
        specimen TEXT NOT NULL,
        result_type TEXT NOT NULL,
        ucum_unit TEXT,
        status TEXT NOT NULL,
        source_note TEXT NOT NULL,
        source_row INTEGER NOT NULL UNIQUE,
        source_version TEXT NOT NULL,
        source_sha256 TEXT NOT NULL
      ) STRICT;
      INSERT INTO laboratory_concept VALUES (
        '8310-5', 'http://loinc.org', '2.83', '体温', 'vital-sign', 'body',
        'quantity', 'Cel', 'active', 'project-authored fixture', 2,
        '2026-08-30', '${'4'.repeat(64)}'
      );
    `)
    return
  }
  if (datasetId === 'nhc-icd10-clinical') {
    database.exec(`
      CREATE TABLE diagnosis (
        code TEXT PRIMARY KEY,
        main_code TEXT,
        additional_code TEXT,
        name TEXT NOT NULL,
        source_row INTEGER NOT NULL UNIQUE,
        source_version TEXT NOT NULL,
        source_sha256 TEXT NOT NULL
      ) STRICT;
      INSERT INTO diagnosis VALUES (
        'R50.900', 'R50.900', NULL, '发热', 2, '2022', '${'1'.repeat(64)}'
      );
    `)
    return
  }
  if (datasetId === 'nhsa-drugs') {
    database.exec(`
      CREATE TABLE drug (
        code TEXT PRIMARY KEY,
        data_source TEXT NOT NULL,
        registered_name TEXT NOT NULL,
        trade_name TEXT NOT NULL,
        registered_dosage_form TEXT NOT NULL,
        dosage_form TEXT NOT NULL,
        registered_specification TEXT NOT NULL,
        specification TEXT NOT NULL,
        packaging_material TEXT NOT NULL,
        minimum_package_quantity TEXT NOT NULL,
        minimum_dosage_unit TEXT NOT NULL,
        minimum_package_unit TEXT NOT NULL,
        drug_company TEXT NOT NULL,
        repackaging_company TEXT,
        manufacturer TEXT NOT NULL,
        approval_number TEXT NOT NULL,
        previous_approval_number TEXT,
        standard_drug_code TEXT NOT NULL,
        marketing_authorization_holder TEXT,
        market_status TEXT NOT NULL,
        insurance_name TEXT,
        reimbursement_class_2025 TEXT,
        insurance_dosage_form TEXT,
        insurance_number TEXT,
        note TEXT,
        former_code TEXT,
        source_row INTEGER NOT NULL UNIQUE,
        source_version TEXT NOT NULL,
        source_sha256 TEXT NOT NULL
      ) STRICT;
      INSERT INTO drug VALUES (
        'XTEST001', 'synthetic-test', '合成对乙酰氨基酚片', '无', '片剂', '片剂',
        '500mg', '500mg', '铝塑', '20', '片', '盒', '合成企业', NULL,
        '合成制药厂', 'TEST-APPROVAL-001', NULL, 'TEST-STANDARD-001', NULL,
        '上市', NULL, NULL, NULL, NULL, NULL, NULL, 2, '2026-01-09', '${'2'.repeat(64)}'
      );
    `)
    return
  }
  database.exec(`
    CREATE TABLE loinc (
      code TEXT PRIMARY KEY,
      component TEXT,
      property TEXT,
      time_aspect TEXT,
      system TEXT,
      scale_type TEXT,
      method_type TEXT,
      long_common_name TEXT NOT NULL,
      status TEXT,
      zh_display TEXT,
      source_version TEXT NOT NULL,
      source_sha256 TEXT NOT NULL
    ) STRICT;
    INSERT INTO loinc VALUES (
      '90001-1', 'Synthetic component', 'Synthetic property', 'Pt', 'Ser', 'Qn', NULL,
      'Synthetic laboratory concept', 'ACTIVE', '合成检验概念', '2.83', '${'3'.repeat(64)}'
    );
  `)
}

async function createCandidate(
  root: string,
  datasetId: CandidateDataset,
): Promise<{ manifestChecksum: string; manifestPath: string; releaseId: string }> {
  const releaseVersion = datasetId === 'nhc-icd10-clinical'
    ? '2022.r1'
    : datasetId === 'nhsa-drugs'
      ? '2026-01-09.r1'
      : datasetId === 'laboratory-cn'
        ? '2026-08-30.r1'
        : '2.83.r1'
  const sourceVersion = releaseVersion.replace(/\.r1$/, '')
  const releaseId = `${datasetId}@${releaseVersion}`
  const directory = join(root, datasetId)
  const databasePath = join(directory, 'data.sqlite')
  const manifestPath = join(directory, 'manifest.json')
  await mkdir(directory)
  const database = new Database(databasePath)
  populateCandidate(database, datasetId)
  database.close()
  const sqliteSha256 = await sha256(databasePath)
  const sqliteSizeBytes = (await stat(databasePath)).size
  const manifest = {
    artifacts: [{
      mediaType: 'application/vnd.sqlite3',
      name: 'data.sqlite',
      sha256: sqliteSha256,
      sizeBytes: sqliteSizeBytes,
      url: 'data.sqlite',
    }],
    canonical: {
      recordCount: 1,
      serialization: 'canonical-ndjson-v1',
      sha256: datasetId === 'nhc-icd10-clinical'
        ? 'a'.repeat(64)
        : datasetId === 'nhsa-drugs'
          ? 'b'.repeat(64)
          : 'c'.repeat(64),
    },
    dataset: { datasetSchemaVersion: 1, id: datasetId, sourceVersion, status: 'experimental' },
    release: {
      buildRevision: 1,
      createdAt: '2026-08-30T00:00:00Z',
      id: releaseId,
      revoked: false,
      sequence: 1,
      storageKey: releaseVersion,
      supersedes: null,
    },
    schemaVersion: 1,
    validation: { passed: true, report: 'validation.json', sha256: 'd'.repeat(64) },
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
  return { manifestChecksum: await sha256(manifestPath), manifestPath, releaseId }
}

describe('cn-health Candidate importer', () => {
  it('validates and converts diagnosis, medication and LOINC Candidate SQLite artifacts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-cn-health-candidates-'))
    temporaryDirectories.push(directory)
    const diagnosis = await createCandidate(directory, 'nhc-icd10-clinical')
    const medication = await createCandidate(directory, 'nhsa-drugs')
    const loinc = await createCandidate(directory, 'loinc-zh-cn')
    const laboratory = await createCandidate(directory, 'laboratory-cn')

    const diagnosisResult = parseCnHealthCandidateReferenceArtifact(diagnosis.manifestPath)
    expect(diagnosisResult).toMatchObject({
      artifact: {
        concepts: [{
          code: 'R50.900',
          display: '发热',
          domain: 'diagnosis',
          status: 'active',
          system: 'urn:clinmesh:reference:nhsa-diagnosis',
          version: '2022',
        }],
      },
      provenance: {
        canonicalSha256: 'a'.repeat(64),
        datasetId: 'nhc-icd10-clinical',
        recordCount: 1,
        releaseId: diagnosis.releaseId,
      },
    })
    expect(parseCnHealthCandidateReferenceArtifact(medication.manifestPath)).toMatchObject({
      artifact: {
        concepts: [],
        medicationProducts: [{
          approvalNumber: 'TEST-APPROVAL-001',
          brandName: null,
          code: 'XTEST001',
          dosageForm: '片剂',
          genericName: '合成对乙酰氨基酚片',
          manufacturer: '合成制药厂',
          packageDescription: '铝塑；20片/盒',
          status: 'active',
          strength: '500mg',
          version: '2026-01-09',
        }],
      },
      provenance: { datasetId: 'nhsa-drugs', releaseId: medication.releaseId },
    })
    expect(parseCnHealthCandidateReferenceArtifact(loinc.manifestPath)).toMatchObject({
      artifact: {
        concepts: [{
          code: '90001-1',
          display: '合成检验概念',
          domain: 'laboratory',
          status: 'active',
          system: 'http://loinc.org',
          version: '2.83',
        }],
      },
      provenance: { datasetId: 'loinc-zh-cn', releaseId: loinc.releaseId },
    })
    expect(parseCnHealthCandidateReferenceArtifact(laboratory.manifestPath)).toMatchObject({
      artifact: {
        concepts: [{
          code: '8310-5',
          display: '体温',
          domain: 'laboratory',
          status: 'active',
          system: 'http://loinc.org',
          version: '2.83',
        }],
      },
      provenance: {
        datasetId: 'laboratory-cn',
        releaseId: laboratory.releaseId,
        sourceVersion: '2026-08-30',
      },
    })

    const invalidRoot = join(directory, 'invalid-application-id')
    await mkdir(invalidRoot)
    const invalid = await createCandidate(invalidRoot, 'loinc-zh-cn')
    const invalidDatabasePath = join(invalidRoot, 'loinc-zh-cn', 'data.sqlite')
    const invalidDatabase = new Database(invalidDatabasePath)
    invalidDatabase.pragma('application_id = 0')
    invalidDatabase.close()
    const invalidManifest = JSON.parse(await readFile(invalid.manifestPath, 'utf8')) as {
      artifacts: Array<{ name: string; sha256: string; sizeBytes: number }>
    }
    const invalidSqlite = invalidManifest.artifacts.find(artifact => artifact.name === 'data.sqlite')!
    invalidSqlite.sha256 = await sha256(invalidDatabasePath)
    invalidSqlite.sizeBytes = (await stat(invalidDatabasePath)).size
    await writeFile(invalid.manifestPath, `${JSON.stringify(invalidManifest)}\n`)
    expect(() => parseCnHealthCandidateReferenceArtifact(invalid.manifestPath))
      .toThrow('application ID')
  })

  it('publishes all Candidate sources atomically and records their exact provenance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-cn-health-release-'))
    temporaryDirectories.push(directory)
    const candidates = await Promise.all(([
      'nhc-icd10-clinical',
      'nhsa-drugs',
      'loinc-zh-cn',
      'laboratory-cn',
    ] as const).map(datasetId => createCandidate(directory, datasetId)))
    const manifestPath = join(directory, 'reference-release.json')
    const referenceManifest = {
      createdAt: '2026-08-30T00:00:00.000Z',
      releaseId: 'clinmesh-cn-health-synthetic-fixture',
      schemaVersion: '1',
      sources: candidates.map((candidate, index) => ({
        acquisitionMethod: 'generated',
        artifactFormat: 'cn-health-candidate',
        artifactPath: candidate.manifestPath,
        checksum: candidate.manifestChecksum,
        licenseId: 'LicenseRef-Synthetic-Test',
        retrievedAt: '2026-08-30T00:00:00.000Z',
        sourceId: `cn-health-source-${index + 1}`,
        sourceUrl: 'https://example.test/cn-health-candidate',
        upstreamVersion: candidate.releaseId,
      })),
    }
    await writeFile(manifestPath, `${JSON.stringify(referenceManifest)}\n`)
    const databasePath = join(directory, 'reference.sqlite')

    await runReferenceDatabaseCli(['migrate', '--database', databasePath])
    await expect(runReferenceDatabaseCli([
      'import', '--database', databasePath, '--manifest', manifestPath,
    ])).resolves.toMatchObject({
      conceptCount: 3,
      created: true,
      medicationProductCount: 1,
      sourceCount: 4,
    })
    await expect(runReferenceDatabaseCli(['list', '--database', databasePath])).resolves.toMatchObject({
      items: [{
        conceptCount: 3,
        medicationProductCount: 1,
        sources: expect.arrayContaining([
          expect.objectContaining({
            artifactFormat: 'cn-health-candidate',
            candidate: expect.objectContaining({ releaseId: candidates[0]!.releaseId }),
          }),
        ]),
      }],
    })
    await expect(runReferenceDatabaseCli(['verify', '--database', databasePath])).resolves.toMatchObject({
      integrity: 'ok',
      releaseCount: 1,
      schemaVersion: 6,
    })

    const failedDatabasePath = join(directory, 'failed-reference.sqlite')
    await runReferenceDatabaseCli(['migrate', '--database', failedDatabasePath])
    const tamperedDatabase = join(directory, 'loinc-zh-cn', 'data.sqlite')
    await writeFile(tamperedDatabase, 'tampered')
    await expect(runReferenceDatabaseCli([
      'import', '--database', failedDatabasePath, '--manifest', manifestPath,
    ])).rejects.toThrow('SQLite SHA256 or size')
    await expect(runReferenceDatabaseCli([
      'list', '--database', failedDatabasePath,
    ])).resolves.toEqual({ items: [] })
  })
})
