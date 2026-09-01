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
import { SqliteReferenceDataRepository } from '../src/infrastructure/sqlite/reference-data-repository.ts'
import { openReferenceDatabase } from '../src/infrastructure/sqlite/reference-database.ts'

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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'null'
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`
}

function canonicalTable(
  database: Database.Database,
  table: string,
  order: readonly string[],
) {
  const hash = createHash('sha256')
  let recordCount = 0
  for (const row of database.prepare(`SELECT * FROM ${table} ORDER BY ${order.join(', ')}`).iterate()) {
    hash.update(canonicalJson(row))
    hash.update('\n')
    recordCount += 1
  }
  return { recordCount, sha256: hash.digest('hex'), table }
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

async function createLoincV2Candidate(root: string): Promise<{
  canonicalSha256: string
  manifestChecksum: string
  manifestPath: string
  releaseId: string
}> {
  const directory = join(root, 'loinc-zh-cn-v2')
  const databasePath = join(directory, 'data.sqlite')
  const manifestPath = join(directory, 'manifest.json')
  const releaseId = 'loinc-zh-cn@2.83.r1'
  await mkdir(directory)
  const database = new Database(databasePath)
  database.pragma('application_id = 0x434e4844')
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
      short_name TEXT,
      consumer_name TEXT,
      class TEXT,
      class_type INTEGER,
      order_obs TEXT,
      status TEXT NOT NULL,
      status_reason TEXT,
      status_text TEXT,
      change_type TEXT,
      definition_description TEXT,
      version_first_released TEXT,
      version_last_changed TEXT,
      panel_type TEXT,
      zh_display TEXT,
      source_metadata_json TEXT NOT NULL,
      translation_metadata_json TEXT NOT NULL,
      source_row INTEGER NOT NULL UNIQUE,
      translation_source_row INTEGER UNIQUE,
      source_version TEXT NOT NULL,
      core_source_sha256 TEXT NOT NULL,
      translation_source_sha256 TEXT NOT NULL
    );
    CREATE TABLE loinc_unit (
      loinc_code TEXT NOT NULL REFERENCES loinc(code),
      ucum_unit TEXT NOT NULL,
      unit_kind TEXT NOT NULL,
      unit_ordinal INTEGER NOT NULL,
      source_member TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      source_sha256 TEXT NOT NULL,
      PRIMARY KEY (loinc_code, unit_kind, source_member, source_row, unit_ordinal)
    ) WITHOUT ROWID;
    CREATE TABLE loinc_specimen (
      loinc_code TEXT NOT NULL REFERENCES loinc(code),
      part_number TEXT NOT NULL,
      part_name TEXT NOT NULL,
      part_display_name TEXT,
      link_type TEXT NOT NULL,
      source_member TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      source_sha256 TEXT NOT NULL,
      PRIMARY KEY (loinc_code, part_number, link_type)
    ) WITHOUT ROWID;
    CREATE TABLE loinc_panel_member (
      parent_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      panel_code TEXT NOT NULL REFERENCES loinc(code),
      member_code TEXT NOT NULL REFERENCES loinc(code),
      member_order INTEGER NOT NULL,
      relationship TEXT NOT NULL,
      source_metadata_json TEXT NOT NULL,
      source_member TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      source_sha256 TEXT NOT NULL,
      PRIMARY KEY (parent_id, member_id)
    ) WITHOUT ROWID;
  `)
  const sourceHash = '3'.repeat(64)
  const rows = [
    ['100000-9', 'Synthetic analyte', 'MCnc', 'Pt', 'Ser', 'Qn', null,
      'Synthetic analyte [Mass/volume] in Serum', '合成分析物', 'CHEM', 1, 'Both',
      'ACTIVE', null],
    ['90002-9', 'Synthetic panel', '-', 'Pt', 'Ser', '-', null,
      'Synthetic laboratory panel', '合成检验组合', 'PANEL.CHEM', 1, 'Order',
      'ACTIVE', 'Panel'],
    ['8310-5', 'Body temperature', 'Temp', 'Pt', 'XXX', 'Qn', null,
      'Body temperature', '体温', 'CLIN', 2, 'Observation', 'ACTIVE', null],
  ] as const
  const insertLoinc = database.prepare(`
    INSERT INTO loinc (
      code, component, property, time_aspect, system, scale_type, method_type,
      long_common_name, short_name, consumer_name, class, class_type, order_obs,
      status, status_reason, status_text, change_type, definition_description,
      version_first_released, version_last_changed, panel_type, zh_display,
      source_metadata_json, translation_metadata_json, source_row,
      translation_source_row, source_version, core_source_sha256,
      translation_source_sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL, NULL,
      NULL, NULL, NULL, ?, ?, '{}', '{}', ?, ?, '2.83', ?, ?)
  `)
  rows.forEach((row, index) => insertLoinc.run(
    ...row.slice(0, 8),
    row[9],
    row[10],
    row[11],
    row[12],
    row[13],
    row[8],
    index + 2,
    index + 2,
    sourceHash,
    sourceHash,
  ))
  database.prepare(`
    INSERT INTO loinc_unit VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('100000-9', 'mg/L', 'example', 1, 'Loinc.csv', 2, sourceHash)
  const insertSpecimen = database.prepare(`
    INSERT INTO loinc_specimen VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  insertSpecimen.run('100000-9', 'LP7567-4', 'Serum', '血清', 'Primary', 'Part.csv', 2, sourceHash)
  insertSpecimen.run('90002-9', 'LP7567-4', 'Serum', '血清', 'Primary', 'Part.csv', 3, sourceHash)
  insertSpecimen.run('8310-5', 'LP7057-5', 'Patient', '患者', 'Primary', 'Part.csv', 4, sourceHash)
  database.prepare(`
    INSERT INTO loinc_panel_member VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'panel-root',
    'panel-member-1',
    '90002-9',
    '100000-9',
    1,
    'contains',
    '{}',
    'PanelsAndForms.csv',
    2,
    sourceHash,
  )
  const tables = [
    canonicalTable(database, 'loinc', ['code']),
    canonicalTable(database, 'loinc_unit', [
      'loinc_code', 'unit_kind', 'source_member', 'source_row', 'unit_ordinal',
    ]),
    canonicalTable(database, 'loinc_specimen', ['loinc_code', 'part_number', 'link_type']),
    canonicalTable(database, 'loinc_panel_member', ['parent_id', 'member_id']),
  ]
  const canonicalSha256 = createHash('sha256')
    .update(canonicalJson({ tables }))
    .digest('hex')
  database.close()
  const sqliteSha256 = await sha256(databasePath)
  const sqliteSizeBytes = (await stat(databasePath)).size
  const manifest = {
    artifacts: [{
      compression: 'zstd',
      mediaType: 'application/zstd',
      name: 'data.sqlite.zst',
      sha256: 'e'.repeat(64),
      sizeBytes: 1,
      uncompressedName: 'data.sqlite',
      uncompressedSha256: sqliteSha256,
      uncompressedSizeBytes: sqliteSizeBytes,
      url: 'data.sqlite.zst',
    }],
    canonical: {
      recordCount: 8,
      serialization: 'canonical-table-hashes-v1',
      sha256: canonicalSha256,
      tables,
    },
    dataset: {
      datasetSchemaVersion: 2,
      id: 'loinc-zh-cn',
      sourceVersion: '2.83',
      status: 'experimental',
    },
    release: {
      buildRevision: 1,
      createdAt: '2026-09-01T06:20:30Z',
      id: releaseId,
      revoked: false,
      sequence: 1,
      storageKey: '2.83.r1',
      supersedes: null,
    },
    schemaVersion: 1,
    validation: { passed: true, report: 'validation.json', sha256: 'f'.repeat(64) },
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
  return {
    canonicalSha256,
    manifestChecksum: await sha256(manifestPath),
    manifestPath,
    releaseId,
  }
}

async function createLaboratoryV2Candidate(root: string): Promise<{
  canonicalSha256: string
  manifestChecksum: string
  manifestPath: string
  releaseId: string
}> {
  const directory = join(root, 'laboratory-cn-v2')
  const databasePath = join(directory, 'data.sqlite')
  const manifestPath = join(directory, 'manifest.json')
  const releaseId = 'laboratory-cn@2026-09-01.r1'
  await mkdir(directory)
  const database = new Database(databasePath)
  database.pragma('application_id = 0x434e4844')
  database.exec(`
    CREATE TABLE laboratory_test (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      analyte TEXT NOT NULL,
      specimen TEXT NOT NULL,
      scale TEXT NOT NULL,
      result_kind TEXT NOT NULL,
      unit_display TEXT,
      unit_ucum TEXT,
      precision INTEGER NOT NULL,
      healthy_strategy TEXT NOT NULL,
      loinc_code TEXT,
      status TEXT NOT NULL,
      source_version TEXT NOT NULL
    ) STRICT;
    CREATE TABLE laboratory_reference (
      test_code TEXT NOT NULL REFERENCES laboratory_test(code),
      sex TEXT NOT NULL,
      reference_kind TEXT NOT NULL,
      low_value REAL,
      high_value REAL,
      normal_value TEXT,
      simulation_low REAL,
      simulation_high REAL,
      source_type TEXT NOT NULL,
      source_standard TEXT NOT NULL,
      source_version TEXT NOT NULL,
      source_location TEXT NOT NULL,
      notes TEXT NOT NULL,
      PRIMARY KEY (test_code, sex)
    ) STRICT;
    CREATE TABLE laboratory_panel (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      specimen TEXT NOT NULL,
      status TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_location TEXT NOT NULL,
      notes TEXT NOT NULL
    ) STRICT;
    CREATE TABLE laboratory_panel_member (
      panel_code TEXT NOT NULL REFERENCES laboratory_panel(code),
      test_code TEXT NOT NULL REFERENCES laboratory_test(code),
      sort_order INTEGER NOT NULL,
      PRIMARY KEY (panel_code, test_code),
      UNIQUE (panel_code, sort_order)
    ) STRICT;
    INSERT INTO laboratory_test VALUES
      ('0100101A', '白细胞计数', '血细胞分析', '白细胞(数量)', '全血', '定量',
       'quantity', '×10^9/L', '10*9/L', 1, 'uniform', '6690-2', 'active', '2026-09-01'),
      ('0100201A', '红细胞计数', '血细胞分析', '红细胞(数量)', '全血', '定量',
       'quantity', '×10^12/L', '10*12/L', 1, 'uniform', '789-8', 'active', '2026-09-01'),
      ('0600401A', 'C反应蛋白测定', '蛋白质测定', 'C反应蛋白', '血清', '定量',
       'quantity', 'mg/L', 'mg/L', 1, 'uniform', '1988-5', 'active', '2026-09-01'),
      ('9900001A', '合成尿液酸碱度', '尿液分析', '酸碱度', '尿液', '序数',
       'ordinal', NULL, NULL, 0, 'fixed-normal', NULL, 'active', '2026-09-01');
    INSERT INTO laboratory_reference VALUES
      ('0100101A', 'all', 'range', 3.5, 9.5, NULL, 3.5, 9.5,
       'national-standard', 'WS/T 405-2012', '2012', '表 1', '成人静脉血'),
      ('0100201A', 'male', 'range', 4.3, 5.8, NULL, 4.3, 5.8,
       'national-standard', 'WS/T 405-2012', '2012', '表 1', '成年男性静脉血'),
      ('0100201A', 'female', 'range', 3.8, 5.1, NULL, 3.8, 5.1,
       'national-standard', 'WS/T 405-2012', '2012', '表 1', '成年女性静脉血'),
      ('0600401A', 'all', 'upper-bound', NULL, 8.0, NULL, 0.1, 7.9,
       'project-curated', 'CN Health Data adult healthy baseline', '2026-09-01',
       '0600401A/all', '成人健康模拟值'),
      ('9900001A', 'all', 'ordinal', NULL, NULL, '5.0～8.0', NULL, NULL,
       'project-curated', 'CN Health Data adult healthy baseline', '2026-09-01',
       '9900001A/all', '固定正常字符串');
    INSERT INTO laboratory_panel VALUES
      ('CN-LAB-CBC', '合成血常规', '全血', 'active', 'project-authored',
       'fixture/panel/1', '合成多叶子 panel'),
      ('CN-LAB-URINE-PH', '合成尿液酸碱度', '尿液', 'active', 'project-authored',
       'fixture/panel/2', '合成 fixed-normal panel');
    INSERT INTO laboratory_panel_member VALUES
      ('CN-LAB-CBC', '0100101A', 1),
      ('CN-LAB-CBC', '0100201A', 2),
      ('CN-LAB-URINE-PH', '9900001A', 1);
  `)
  const tables = [
    canonicalTable(database, 'laboratory_test', ['code']),
    canonicalTable(database, 'laboratory_reference', ['test_code', 'sex']),
    canonicalTable(database, 'laboratory_panel', ['code']),
    canonicalTable(database, 'laboratory_panel_member', ['panel_code', 'sort_order', 'test_code']),
  ]
  const canonicalSha256 = createHash('sha256')
    .update(canonicalJson(tables))
    .digest('hex')
  database.close()
  const sqliteSha256 = await sha256(databasePath)
  const sqliteSizeBytes = (await stat(databasePath)).size
  const manifest = {
    artifacts: [{
      compression: 'zstd',
      mediaType: 'application/zstd',
      name: 'data.sqlite.zst',
      sha256: 'e'.repeat(64),
      sizeBytes: 1,
      uncompressedName: 'data.sqlite',
      uncompressedSha256: sqliteSha256,
      uncompressedSizeBytes: sqliteSizeBytes,
      url: 'data.sqlite.zst',
    }],
    canonical: {
      recordCount: 4,
      serialization: 'canonical-multitable-ndjson-v1',
      sha256: canonicalSha256,
      tables,
    },
    dataset: {
      datasetSchemaVersion: 2,
      id: 'laboratory-cn',
      sourceVersion: '2026-09-01',
      status: 'beta',
    },
    release: {
      buildRevision: 1,
      createdAt: '2026-09-01T14:59:21Z',
      id: releaseId,
      revoked: false,
      sequence: 3,
      storageKey: '2026-09-01.r1',
      supersedes: 'laboratory-cn@2026-08-30.r2',
    },
    schemaVersion: 1,
    validation: { passed: true, report: 'validation.json', sha256: 'f'.repeat(64) },
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
  return {
    canonicalSha256,
    manifestChecksum: await sha256(manifestPath),
    manifestPath,
    releaseId,
  }
}

describe('cn-health Candidate importer', () => {
  it('imports Schema v2 adult laboratory definitions, rules, and ordered panels', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-laboratory-v2-candidate-'))
    temporaryDirectories.push(directory)
    const candidate = await createLaboratoryV2Candidate(directory)

    expect(parseCnHealthCandidateReferenceArtifact(candidate.manifestPath)).toMatchObject({
      artifact: {
        concepts: expect.arrayContaining([
          expect.objectContaining({
            code: '0100101A',
            id: 'wst-886:2026:0100101A',
            system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026',
          }),
          expect.objectContaining({
            code: 'CN-LAB-CBC',
            id: 'laboratory-panel-cn:2026-09-01:CN-LAB-CBC',
            system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-panel-cn',
          }),
        ]),
        laboratoryDefinitions: expect.arrayContaining([
          expect.objectContaining({
            adultReferenceRules: [expect.objectContaining({
              high: 9.5,
              low: 3.5,
              referenceKind: 'range',
              sex: 'all',
              simulationHigh: 9.5,
              simulationLow: 3.5,
              sourceType: 'national-standard',
            })],
            alternateCodings: [{ code: '6690-2', system: 'http://loinc.org', version: '2.83' }],
            conceptId: 'wst-886:2026:0100101A',
            healthyStrategy: 'uniform',
            kind: 'laboratory-cn-test',
            precision: 1,
            resultKind: 'quantity',
            specimen: '全血',
            unit: {
              code: '10*9/L',
              display: '×10^9/L',
              system: 'http://unitsofmeasure.org',
            },
          }),
          expect.objectContaining({
            conceptId: 'laboratory-panel-cn:2026-09-01:CN-LAB-CBC',
            kind: 'laboratory-cn-panel',
            sourceType: 'project-authored',
            specimen: '全血',
          }),
        ]),
        laboratoryPanelMembers: expect.arrayContaining([
          expect.objectContaining({
            memberConceptId: 'wst-886:2026:0100101A',
            memberOrder: 1,
            panelConceptId: 'laboratory-panel-cn:2026-09-01:CN-LAB-CBC',
          }),
        ]),
      },
      provenance: {
        canonicalSha256: candidate.canonicalSha256,
        datasetId: 'laboratory-cn',
        datasetSchemaVersion: 2,
        recordCount: 4,
        releaseId: candidate.releaseId,
      },
    })
  })

  it('publishes Schema v2 adult laboratory definitions through the Reference Database interface', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-laboratory-v2-release-'))
    temporaryDirectories.push(directory)
    const candidate = await createLaboratoryV2Candidate(directory)
    const manifestPath = join(directory, 'reference-release.json')
    await writeFile(manifestPath, `${JSON.stringify({
      createdAt: '2026-09-02T00:00:00.000Z',
      releaseId: 'clinmesh-laboratory-v2-synthetic-fixture',
      schemaVersion: '1',
      sources: [{
        acquisitionMethod: 'manual-download',
        artifactFormat: 'cn-health-candidate',
        artifactPath: candidate.manifestPath,
        checksum: candidate.manifestChecksum,
        licenseId: 'LicenseRef-Synthetic-Test',
        retrievedAt: '2026-09-02T00:00:00.000Z',
        sourceId: 'laboratory-cn-2026-09-01',
        sourceUrl: 'https://example.test/laboratory-cn',
        upstreamVersion: candidate.releaseId,
      }],
    })}\n`)
    const databasePath = join(directory, 'reference.sqlite')

    await runReferenceDatabaseCli(['migrate', '--database', databasePath])
    await expect(runReferenceDatabaseCli([
      'import', '--database', databasePath, '--manifest', manifestPath,
    ])).resolves.toMatchObject({
      conceptCount: 6,
      laboratoryDefinitionCount: 6,
      laboratoryPanelMemberCount: 3,
    })
    await expect(runReferenceDatabaseCli([
      'list', '--database', databasePath,
    ])).resolves.toMatchObject({
      items: [{
        sources: [{
          importDiagnostics: { acceptedCount: 14, rejectedCount: 0, warnings: [] },
          recordCount: 14,
        }],
      }],
    })

    const database = openReferenceDatabase({ busyTimeoutMs: 5_000, databasePath, readonly: true })
    const repository = new SqliteReferenceDataRepository(database)
    expect(repository.laboratoryRecord(
      'clinmesh-laboratory-v2-synthetic-fixture',
      'laboratory-panel-cn:2026-09-01:CN-LAB-CBC',
    )).toMatchObject({
      definition: { kind: 'laboratory-cn-panel', sourceType: 'project-authored' },
      panelMembers: [
        { memberConceptId: 'wst-886:2026:0100101A', memberOrder: 1 },
        { memberConceptId: 'wst-886:2026:0100201A', memberOrder: 2 },
      ],
    })
    expect(repository.laboratoryRecord(
      'clinmesh-laboratory-v2-synthetic-fixture',
      'wst-886:2026:0100201A',
    )).toMatchObject({
      definition: {
        adultReferenceRules: [
          expect.objectContaining({ sex: 'female' }),
          expect.objectContaining({ sex: 'male' }),
        ],
        kind: 'laboratory-cn-test',
      },
    })
    database.close()
  })

  it('imports a Schema v2 LOINC Candidate with laboratory relationships and excludes clinical observations from the laboratory domain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-loinc-v2-candidate-'))
    temporaryDirectories.push(directory)
    const candidate = await createLoincV2Candidate(directory)

    expect(parseCnHealthCandidateReferenceArtifact(candidate.manifestPath)).toMatchObject({
      artifact: {
        concepts: expect.arrayContaining([
          expect.objectContaining({ code: '100000-9', domain: 'laboratory' }),
          expect.objectContaining({ code: '90002-9', domain: 'laboratory' }),
          expect.objectContaining({ code: '8310-5', domain: 'other' }),
        ]),
        laboratoryDefinitions: expect.arrayContaining([
          expect.objectContaining({
            classType: 1,
            conceptId: `loinc:${candidate.releaseId}:100000-9`,
            orderObservation: 'Both',
            scaleType: 'Qn',
          }),
        ]),
        laboratoryPanelMembers: [{
          memberConceptId: `loinc:${candidate.releaseId}:100000-9`,
          memberOrder: 1,
          panelConceptId: `loinc:${candidate.releaseId}:90002-9`,
          relationship: 'contains',
          sourceLocator: 'cn-health:loinc-zh-cn@2.83.r1:loinc-panel-member:panel-root:panel-member-1',
        }],
        laboratorySpecimens: expect.arrayContaining([
          expect.objectContaining({
            conceptId: `loinc:${candidate.releaseId}:100000-9`,
            display: '血清',
            partNumber: 'LP7567-4',
          }),
        ]),
        laboratoryUnits: [{
          code: 'mg/L',
          conceptId: `loinc:${candidate.releaseId}:100000-9`,
          kind: 'example',
          ordinal: 1,
          sourceLocator: 'cn-health:loinc-zh-cn@2.83.r1:loinc-unit:Loinc.csv:2:1',
        }],
      },
      provenance: {
        canonicalSha256: candidate.canonicalSha256,
        datasetId: 'loinc-zh-cn',
        datasetSchemaVersion: 2,
        recordCount: 8,
        releaseId: candidate.releaseId,
      },
    })
    const manifest = JSON.parse(await readFile(candidate.manifestPath, 'utf8')) as {
      canonical: { tables: Array<{ sha256: string }> }
    }
    manifest.canonical.tables[0]!.sha256 = '0'.repeat(64)
    await writeFile(candidate.manifestPath, `${JSON.stringify(manifest)}\n`)
    expect(() => parseCnHealthCandidateReferenceArtifact(candidate.manifestPath))
      .toThrow('canonical SHA256 mismatch: loinc')
  })

  it('publishes Schema v2 LOINC relationships through the Reference Database interface', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-loinc-v2-release-'))
    temporaryDirectories.push(directory)
    const candidate = await createLoincV2Candidate(directory)
    const manifestPath = join(directory, 'reference-release.json')
    await writeFile(manifestPath, `${JSON.stringify({
      createdAt: '2026-09-01T07:00:00.000Z',
      releaseId: 'clinmesh-loinc-v2-synthetic-fixture',
      schemaVersion: '1',
      sources: [{
        acquisitionMethod: 'manual-download',
        artifactFormat: 'cn-health-candidate',
        artifactPath: candidate.manifestPath,
        checksum: candidate.manifestChecksum,
        licenseId: 'LOINC-5.8',
        retrievedAt: '2026-09-01T07:00:00.000Z',
        sourceId: 'loinc-zh-cn-2.83',
        sourceUrl: 'https://loinc.org/download/loinc-complete/',
        upstreamVersion: candidate.releaseId,
      }],
    })}\n`)
    const databasePath = join(directory, 'reference.sqlite')

    await runReferenceDatabaseCli(['migrate', '--database', databasePath])
    await expect(runReferenceDatabaseCli([
      'import', '--database', databasePath, '--manifest', manifestPath,
    ])).resolves.toMatchObject({
      conceptCount: 3,
      laboratoryDefinitionCount: 3,
      laboratoryPanelMemberCount: 1,
      laboratorySpecimenCount: 3,
      laboratoryUnitCount: 1,
    })
    await expect(runReferenceDatabaseCli([
      'list', '--database', databasePath,
    ])).resolves.toMatchObject({
      items: [{
        conceptCount: 3,
        laboratoryDefinitionCount: 3,
        laboratoryPanelMemberCount: 1,
        laboratorySpecimenCount: 3,
        laboratoryUnitCount: 1,
        sources: [{
          importDiagnostics: { acceptedCount: 8, rejectedCount: 0, warnings: [] },
          recordCount: 8,
        }],
      }],
    })

    const database = openReferenceDatabase({
      busyTimeoutMs: 5_000,
      databasePath,
      readonly: true,
    })
    const repository = new SqliteReferenceDataRepository(database)
    expect(repository.laboratoryRecord(
      'clinmesh-loinc-v2-synthetic-fixture',
      `loinc:${candidate.releaseId}:90002-9`,
    )).toMatchObject({
      concept: { code: '90002-9', domain: 'laboratory' },
      definition: { classType: 1, orderObservation: 'Order', panelType: 'Panel' },
      panelMembers: [{
        memberConceptId: `loinc:${candidate.releaseId}:100000-9`,
        memberOrder: 1,
      }],
      specimens: [{ display: '血清', partNumber: 'LP7567-4' }],
      units: [],
    })
    database.close()
    await expect(runReferenceDatabaseCli([
      'verify', '--database', databasePath,
    ])).resolves.toMatchObject({ integrity: 'ok', releaseCount: 1, schemaVersion: 10 })
  })

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
      schemaVersion: 10,
    })
    const published = new Database(databasePath, { readonly: true })
    expect(JSON.parse((published.prepare(`
      SELECT laboratory_metadata_json
      FROM reference_concept
      WHERE concept_id LIKE 'laboratory-cn:%'
    `).get() as { laboratory_metadata_json: string }).laboratory_metadata_json)).toEqual({
      category: 'vital-sign',
      resultType: 'quantity',
      specimen: 'body',
      unit: { code: 'Cel', display: 'Cel', system: 'http://unitsofmeasure.org' },
    })
    published.close()

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
