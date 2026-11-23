import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  referenceArtifactSchema,
  type ReferenceConcept,
  type ReferenceImportManifest,
  type ReferenceLaboratoryDefinition,
  type ReferenceLaboratoryPanelMember,
  type ReferenceLaboratorySpecimen,
  type ReferenceLaboratoryUnit,
  type ReferenceMedicalService,
  type ReferenceMedicationProduct,
  type ReferenceSourceManifest,
  type ReferenceValueSetEntry,
} from '@clinmesh/contracts/reference-data'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import {
  parseCnHealthCandidateReferenceArtifact,
} from '../src/infrastructure/reference-data/cn-health-candidate-importer.ts'
import {
  parseNhcMedicalServiceCsvArtifact,
  parseUcumXmlReferenceArtifact,
  parseWstValueSetCsvArtifact,
} from '../src/infrastructure/reference-data/reference-source-importers.ts'
import {
  applyReferenceMigrations,
  importReferenceDataRelease,
  listReferenceDataReleases,
  openReferenceDatabase,
  verifyReferenceDatabase,
} from '../src/infrastructure/sqlite/reference-database.ts'
import { writeDrgCompactFixtureIndex } from './fixtures/drg-reference.ts'

const memoryBudgetBytes = 384 * 1024 * 1024
const databaseListSchema = z.array(z.object({ name: z.string() }).loose())
const sqliteRowRecordSchema = z.record(z.string(), z.unknown())

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function fileSha256AndSize(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const bytes = await readFile(path)
  return { sha256: sha256(bytes), sizeBytes: (await stat(path)).size }
}

function canonicalNdjsonObject(value: Record<string, unknown>): string {
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${JSON.stringify(entry)}`)
    .join(',')}}`
}

function computeCandidateTableHash(
  database: Database.Database,
  table: string,
  orderColumns: readonly string[],
): { recordCount: number; sha256: string; table: string } {
  const digest = createHash('sha256')
  let recordCount = 0
  for (const row of database.prepare(`SELECT * FROM ${table} ORDER BY ${orderColumns.join(', ')}`).iterate()) {
    digest.update(canonicalNdjsonObject(sqliteRowRecordSchema.parse(row)))
    digest.update('\n')
    recordCount += 1
  }
  return { recordCount, sha256: digest.digest('hex'), table }
}

function legacyCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacyCanonicalize)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, legacyCanonicalize(entry)]))
}

function legacyReleaseObjectContentHash(input: {
  concepts: Array<ReferenceConcept & { sourceId: string }>
  laboratoryDefinitions: Array<ReferenceLaboratoryDefinition & { sourceId: string }>
  laboratoryPanelMembers: Array<ReferenceLaboratoryPanelMember & { sourceId: string }>
  laboratorySpecimens: Array<ReferenceLaboratorySpecimen & { sourceId: string }>
  laboratoryUnits: Array<ReferenceLaboratoryUnit & { sourceId: string }>
  medicationProducts: Array<ReferenceMedicationProduct & { sourceId: string }>
  release: Pick<ReferenceImportManifest, 'createdAt' | 'releaseId' | 'schemaVersion'>
  services: Array<ReferenceMedicalService & { sourceId: string }>
  sources: ReferenceSourceManifest[]
  valueSetEntries: Array<ReferenceValueSetEntry & { sourceId: string }>
}): string {
  const hashSources = input.sources.map(({ artifactFormat, ...source }) => (
    artifactFormat === 'clinmesh-reference-v1'
      ? source
      : { ...source, artifactFormat }
  ))
  const payload = JSON.stringify(legacyCanonicalize({
    concepts: input.concepts.toSorted((left, right) => (
      left.sourceId.localeCompare(right.sourceId) || left.id.localeCompare(right.id)
    )),
    createdAt: input.release.createdAt,
    releaseId: input.release.releaseId,
    schemaVersion: input.release.schemaVersion,
    sources: hashSources.toSorted((left, right) => left.sourceId.localeCompare(right.sourceId)),
    ...(input.medicationProducts.length === 0 ? {} : {
      medicationProducts: input.medicationProducts.toSorted((left, right) => (
        left.sourceId.localeCompare(right.sourceId) || left.id.localeCompare(right.id)
      )),
    }),
    ...(input.laboratoryDefinitions.length === 0 ? {} : {
      laboratoryDefinitions: input.laboratoryDefinitions.toSorted((left, right) => (
        left.sourceId.localeCompare(right.sourceId) || left.conceptId.localeCompare(right.conceptId)
      )),
    }),
    ...(input.laboratoryUnits.length === 0 ? {} : {
      laboratoryUnits: input.laboratoryUnits.toSorted((left, right) => (
        left.sourceId.localeCompare(right.sourceId)
        || left.conceptId.localeCompare(right.conceptId)
        || left.sourceLocator.localeCompare(right.sourceLocator)
      )),
    }),
    ...(input.laboratorySpecimens.length === 0 ? {} : {
      laboratorySpecimens: input.laboratorySpecimens.toSorted((left, right) => (
        left.sourceId.localeCompare(right.sourceId)
        || left.conceptId.localeCompare(right.conceptId)
        || left.partNumber.localeCompare(right.partNumber)
      )),
    }),
    ...(input.laboratoryPanelMembers.length === 0 ? {} : {
      laboratoryPanelMembers: input.laboratoryPanelMembers.toSorted((left, right) => (
        left.sourceId.localeCompare(right.sourceId)
        || left.panelConceptId.localeCompare(right.panelConceptId)
        || left.memberOrder - right.memberOrder
        || left.memberConceptId.localeCompare(right.memberConceptId)
        || left.sourceLocator.localeCompare(right.sourceLocator)
      )),
    }),
    ...(input.services.length === 0 ? {} : {
      services: input.services.toSorted((left, right) => (
        left.sourceId.localeCompare(right.sourceId) || left.id.localeCompare(right.id)
      )),
    }),
    ...(input.valueSetEntries.length === 0 ? {} : {
      valueSetEntries: input.valueSetEntries.toSorted((left, right) => (
        left.sourceId.localeCompare(right.sourceId) || left.id.localeCompare(right.id)
      )),
    }),
  }))
  return sha256(payload)
}

async function prepareOfflineDrgFixture(root: string, databasePath: string, count = 1): Promise<void> {
  await mkdir(join(root, 'prepared/services'), { recursive: true })
  const records = '{"code":"synthetic-service","unit":"次","runtimeEnabled":false}\n'
  await writeFile(join(root, 'prepared/services/records.jsonl'), records)
  const preparedManifest = JSON.stringify({
    archiveChecksumsSha256: '1'.repeat(64),
    createdAt: '2026-10-21T00:00:00.000Z',
    files: [{
      dataset: 'services',
      path: 'services/records.jsonl',
      rows: 1,
      sha256: sha256(records),
      sourceVersion: 'synthetic-2026',
      table: 'records',
    }],
    releaseId: 'synthetic-prepared-v1',
    schemaVersion: 'clinmesh.prepared-catalogues.v1',
    sources: {},
  })
  await writeFile(join(root, 'prepared/manifest.json'), preparedManifest)
  const compact = await writeDrgCompactFixtureIndex(root, [
    'prepared/manifest.json',
    'prepared/services/records.jsonl',
  ])
  const lockPath = join(root, 'offline.lock.json')
  const baseLock = {
    createdAt: '2026-10-21T00:00:00.000Z',
    inventoryId: 'synthetic-00',
    packages: [{
      format: 'prepared-catalogues-v1',
      id: 'prepared-five-catalogues',
      manifest: { path: 'manifest.json', sha256: sha256(preparedManifest) },
      quarantineReasons: ['coding-compatibility-unverified'],
      root: 'prepared',
      sourceUrl: 'https://example.test/synthetic-prepared',
      version: 'synthetic-prepared-v1',
    }],
    schemaVersion: 'clinmesh.offline-inventory.v1',
    scheme: 'CHS-DRG-3.0',
    storage: compact.storage,
  }
  for (let index = 0; index < count; index += 1) {
    await writeFile(lockPath, JSON.stringify({
      ...baseLock,
      inventoryId: `synthetic-${String(index).padStart(2, '0')}`,
    }))
    await runReferenceDatabaseCli([
      'prepare-inventory',
      '--database', databasePath,
      '--manifest', lockPath,
      '--input-root', root,
    ])
  }
}

async function createDiagnosisCandidate(directory: string, count: number): Promise<{
  databasePath: string
  manifestChecksum: string
  manifestPath: string
  releaseId: string
}> {
  await mkdir(directory, { recursive: true })
  const databasePath = join(directory, 'data.sqlite')
  const manifestPath = join(directory, 'manifest.json')
  const releaseId = 'nhc-icd10-clinical@2022.r4'
  const db = new Database(databasePath)
  try {
    db.pragma('application_id = 0x434e4844')
    db.exec(`
      CREATE TABLE diagnosis (
        code TEXT PRIMARY KEY,
        main_code TEXT,
        additional_code TEXT,
        name TEXT NOT NULL,
        source_row INTEGER NOT NULL UNIQUE,
        source_version TEXT NOT NULL,
        source_sha256 TEXT NOT NULL
      ) STRICT;
      WITH RECURSIVE seq(n) AS (
        SELECT 1
        UNION ALL
        SELECT n + 1 FROM seq WHERE n < ${count}
      )
      INSERT INTO diagnosis (
        code, main_code, additional_code, name, source_row, source_version, source_sha256
      )
      SELECT
        CASE
          WHEN n % 20 = 0 THEN printf('A%05d†', n)
          WHEN n % 20 = 1 THEN printf('a%05d.0', n)
          ELSE printf('I%05d.001', n)
        END,
        printf('I%05d', n),
        CASE WHEN n % 20 = 0 THEN 'G01*' ELSE NULL END,
        '合成临床诊断条目 ' || n,
        n + 1,
        '2022',
        '${'1'.repeat(64)}'
      FROM seq;
    `)
  } finally {
    db.close()
  }
  const sqliteMeta = await fileSha256AndSize(databasePath)
  const manifestJson = `${JSON.stringify({
    artifacts: [{
      mediaType: 'application/vnd.sqlite3',
      name: 'data.sqlite',
      sha256: sqliteMeta.sha256,
      sizeBytes: sqliteMeta.sizeBytes,
      url: 'data.sqlite',
    }],
    canonical: {
      recordCount: count,
      serialization: 'canonical-ndjson-v1',
      sha256: 'a'.repeat(64),
    },
    dataset: {
      datasetSchemaVersion: 1,
      id: 'nhc-icd10-clinical',
      sourceVersion: '2022',
    },
    release: { id: releaseId, revoked: false },
    schemaVersion: 1,
    validation: { passed: true },
  })}\n`
  await writeFile(manifestPath, manifestJson)
  return {
    databasePath,
    manifestChecksum: sha256(manifestJson),
    manifestPath,
    releaseId,
  }
}

async function createDrugCandidate(directory: string, count: number): Promise<{
  databasePath: string
  manifestChecksum: string
  manifestPath: string
  releaseId: string
}> {
  await mkdir(directory, { recursive: true })
  const databasePath = join(directory, 'data.sqlite')
  const manifestPath = join(directory, 'manifest.json')
  const releaseId = 'nhsa-drugs@2026-01-09.r4'
  const db = new Database(databasePath)
  try {
    db.pragma('application_id = 0x434e4844')
    db.exec(`
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
      WITH RECURSIVE seq(n) AS (
        SELECT 1
        UNION ALL
        SELECT n + 1 FROM seq WHERE n < ${count}
      )
      INSERT INTO drug
      SELECT
        CASE WHEN n % 17 = 0 THEN printf('x%07d', n) ELSE printf('X%07d', n) END,
        'synthetic-test',
        '合成对乙酰氨基酚制剂 ' || n,
        CASE WHEN n % 3 = 0 THEN '无' ELSE '合成商品名' || (n % 50) END,
        '片剂',
        '片剂',
        '500mg',
        '500mg',
        '铝塑泡罩',
        '24',
        '片',
        '盒',
        '合成医药企业',
        NULL,
        '仁和仿真制药厂',
        printf('国药准字H%08d', n),
        NULL,
        printf('869%011d', n),
        NULL,
        CASE WHEN n % 11 = 0 THEN '停产' ELSE '上市' END,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        n + 1,
        '2026-01-09',
        '${'2'.repeat(64)}'
      FROM seq;
    `)
  } finally {
    db.close()
  }
  const sqliteMeta = await fileSha256AndSize(databasePath)
  const manifestJson = `${JSON.stringify({
    artifacts: [{
      mediaType: 'application/vnd.sqlite3',
      name: 'data.sqlite',
      sha256: sqliteMeta.sha256,
      sizeBytes: sqliteMeta.sizeBytes,
      url: 'data.sqlite',
    }],
    canonical: {
      recordCount: count,
      serialization: 'canonical-ndjson-v1',
      sha256: 'b'.repeat(64),
    },
    dataset: {
      datasetSchemaVersion: 1,
      id: 'nhsa-drugs',
      sourceVersion: '2026-01-09',
    },
    release: { id: releaseId, revoked: false },
    schemaVersion: 1,
    validation: { passed: true },
  })}\n`
  await writeFile(manifestPath, manifestJson)
  return {
    databasePath,
    manifestChecksum: sha256(manifestJson),
    manifestPath,
    releaseId,
  }
}

async function createLaboratoryV2CandidateFixture(
  directory: string,
  options?: { omitQuantityUnit?: boolean },
): Promise<{
  databasePath: string
  manifestChecksum: string
  manifestPath: string
  releaseId: string
}> {
  await mkdir(directory, { recursive: true })
  const databasePath = join(directory, 'data.sqlite')
  const manifestPath = join(directory, 'manifest.json')
  const releaseId = 'laboratory-cn@2026-09-01.r1'
  const db = new Database(databasePath)
  let tables: Array<{ recordCount: number; sha256: string; table: string }>
  let canonicalSha256: string
  try {
    db.pragma('application_id = 0x434e4844')
    db.exec(`
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
    `)
    const unitDisplay = options?.omitQuantityUnit === true ? null : '×10^9/L'
    const unitUcum = options?.omitQuantityUnit === true ? null : '10*9/L'
    db.prepare(`
      INSERT INTO laboratory_test VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '0100101A',
      '白细胞计数',
      '血细胞分析',
      '白细胞',
      '全血',
      '定量',
      'quantity',
      unitDisplay,
      unitUcum,
      1,
      'uniform',
      '6690-2',
      'active',
      '2026-09-01',
    )
    db.prepare(`
      INSERT INTO laboratory_reference VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '0100101A',
      'all',
      'range',
      3.5,
      9.5,
      null,
      3.5,
      9.5,
      'national-standard',
      'WS/T 405-2012',
      '2012',
      '表 1',
      '成人静脉血',
    )
    db.prepare(`
      INSERT INTO laboratory_panel VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'CN-LAB-CBC',
      '合成血常规',
      '全血',
      'active',
      'project-authored',
      'fixture/panel/1',
      '合成组合',
    )
    db.prepare(`
      INSERT INTO laboratory_panel_member VALUES (?, ?, ?)
    `).run('CN-LAB-CBC', '0100101A', 1)

    tables = [
      computeCandidateTableHash(db, 'laboratory_test', ['code']),
      computeCandidateTableHash(db, 'laboratory_reference', ['test_code', 'sex']),
      computeCandidateTableHash(db, 'laboratory_panel', ['code']),
      computeCandidateTableHash(db, 'laboratory_panel_member', ['panel_code', 'sort_order', 'test_code']),
    ]
    canonicalSha256 = sha256(`[${tables.map(item => canonicalNdjsonObject(item)).join(',')}]`)
  } finally {
    db.close()
  }

  const sqliteMeta = await fileSha256AndSize(databasePath)
  const manifestJson = `${JSON.stringify({
    artifacts: [{
      mediaType: 'application/vnd.sqlite3',
      name: 'data.sqlite',
      sha256: sqliteMeta.sha256,
      sizeBytes: sqliteMeta.sizeBytes,
      url: 'data.sqlite',
    }],
    canonical: {
      recordCount: 1,
      serialization: 'canonical-multitable-ndjson-v1',
      sha256: canonicalSha256,
      tables,
    },
    dataset: {
      datasetSchemaVersion: 2,
      id: 'laboratory-cn',
      sourceVersion: '2026-09-01',
    },
    release: { id: releaseId, revoked: false },
    schemaVersion: 1,
    validation: { passed: true },
  })}\n`
  await writeFile(manifestPath, manifestJson)
  return {
    databasePath,
    manifestChecksum: sha256(manifestJson),
    manifestPath,
    releaseId,
  }
}

async function createLoincV2CandidateFixture(directory: string): Promise<{
  databasePath: string
  manifestChecksum: string
  manifestPath: string
  releaseId: string
}> {
  await mkdir(directory, { recursive: true })
  const databasePath = join(directory, 'data.sqlite')
  const manifestPath = join(directory, 'manifest.json')
  const releaseId = 'loinc-zh-cn@2.83.r2'
  const db = new Database(databasePath)
  let tables: Array<{ recordCount: number; sha256: string; table: string }>
  let canonicalSha256: string
  try {
    db.pragma('application_id = 0x434e4844')
    db.exec(`
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
        translation_metadata_json TEXT,
        source_row INTEGER NOT NULL UNIQUE,
        translation_source_row INTEGER,
        source_version TEXT NOT NULL,
        core_source_sha256 TEXT NOT NULL,
        translation_source_sha256 TEXT
      ) STRICT;
      CREATE TABLE loinc_unit (
        loinc_code TEXT NOT NULL REFERENCES loinc(code),
        ucum_unit TEXT NOT NULL,
        unit_kind TEXT NOT NULL,
        unit_ordinal INTEGER NOT NULL,
        source_member TEXT NOT NULL,
        source_row INTEGER NOT NULL,
        source_sha256 TEXT NOT NULL,
        PRIMARY KEY (loinc_code, unit_kind, source_member, source_row, unit_ordinal)
      ) STRICT;
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
      ) STRICT;
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
      ) STRICT;
    `)
    db.prepare(`
      INSERT INTO loinc VALUES (
        '24331-1', 'Lipid 1996 panel', '-', 'Pt', 'Ser/Plas', '-', NULL,
        'Lipid 1996 panel - Serum or Plasma', 'Lipid Pnl', NULL, 'PANEL.CHEM', 1,
        'Order', 'ACTIVE', NULL, NULL, NULL, NULL, '1.0', '2.83', 'Panel',
        '血脂组合', '{}', NULL, 2, 2, '2.83', '${'5'.repeat(64)}', '${'6'.repeat(64)}'
      )
    `).run()
    db.prepare(`
      INSERT INTO loinc VALUES (
        '2093-3', 'Cholesterol', 'MCnc', 'Pt', 'Ser/Plas', 'Qn', NULL,
        'Cholesterol [Mass/volume] in Serum or Plasma', 'Cholest', NULL, 'CHEM', 1,
        'Both', 'ACTIVE', NULL, NULL, NULL, NULL, '1.0', '2.83', NULL,
        '总胆固醇', '{}', NULL, 3, 3, '2.83', '${'5'.repeat(64)}', '${'6'.repeat(64)}'
      )
    `).run()
    db.prepare(`
      INSERT INTO loinc_unit VALUES ('2093-3', 'mmol/L', 'example', 1, 'Loinc.csv', 3, '${'5'.repeat(64)}')
    `).run()
    db.prepare(`
      INSERT INTO loinc_specimen VALUES ('2093-3', 'LP7567-3', 'Serum', '血清', 'Primary', 'Part.csv', 2, '${'7'.repeat(64)}')
    `).run()
    db.prepare(`
      INSERT INTO loinc_panel_member VALUES ('P1', 'M1', '24331-1', '2093-3', 1, 'contains', '{}', 'Panel.csv', 2, '${'8'.repeat(64)}')
    `).run()

    tables = [
      computeCandidateTableHash(db, 'loinc', ['code']),
      computeCandidateTableHash(db, 'loinc_unit', ['loinc_code', 'unit_kind', 'source_member', 'source_row', 'unit_ordinal']),
      computeCandidateTableHash(db, 'loinc_specimen', ['loinc_code', 'part_number', 'link_type']),
      computeCandidateTableHash(db, 'loinc_panel_member', ['parent_id', 'member_id']),
    ]
    canonicalSha256 = sha256(`{"tables":[${tables.map(item => canonicalNdjsonObject(item)).join(',')}]}`)
  } finally {
    db.close()
  }

  const sqliteMeta = await fileSha256AndSize(databasePath)
  const manifestJson = `${JSON.stringify({
    artifacts: [{
      mediaType: 'application/vnd.sqlite3',
      name: 'data.sqlite',
      sha256: sqliteMeta.sha256,
      sizeBytes: sqliteMeta.sizeBytes,
      url: 'data.sqlite',
    }],
    canonical: {
      recordCount: 5,
      serialization: 'canonical-table-hashes-v1',
      sha256: canonicalSha256,
      tables,
    },
    dataset: {
      datasetSchemaVersion: 2,
      id: 'loinc-zh-cn',
      sourceVersion: '2.83',
    },
    release: { id: releaseId, revoked: false },
    schemaVersion: 1,
    validation: { passed: true },
  })}\n`
  await writeFile(manifestPath, manifestJson)
  return {
    databasePath,
    manifestChecksum: sha256(manifestJson),
    manifestPath,
    releaseId,
  }
}

const workerReplySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    peakRssBytes: z.number().int().positive(),
    result: z.unknown(),
  }),
  z.object({
    kind: z.literal('error'),
    message: z.string(),
  }),
])

async function runRssWorker(payload: {
  databasePath: string
  manifestPath?: string
  mode: 'import' | 'verify-readonly'
}): Promise<{ peakRssBytes: number; result: unknown }> {
  const workerPath = fileURLToPath(new URL('./fixtures/reference-rss-worker.ts', import.meta.url))
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [JSON.stringify(payload)], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    let stderr = ''
    let reply: z.infer<typeof workerReplySchema> | undefined
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('message', (raw) => {
      reply = workerReplySchema.parse(raw)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (reply?.kind === 'error') {
        reject(new Error(reply.message))
        return
      }
      if (code !== 0 || reply === undefined) {
        reject(new Error(`RSS worker exited with ${code}: ${stderr}`))
        return
      }
      resolve({ peakRssBytes: reply.peakRssBytes, result: reply.result })
    })
  })
}

describe('streaming reference release import and verification', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })),
    )
  })

  it('verifies releases with dagger/mixed-case keys and >50 offline inventories over a readonly connection and rejects schema-invalid formal rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clinmesh-ref-readonly-verify-'))
    temporaryDirectories.push(root)
    const databasePath = join(root, 'reference.sqlite')

    const database = openReferenceDatabase({ busyTimeoutMs: 5_000, databasePath })
    try {
      applyReferenceMigrations(database)
    } finally {
      database.close()
    }

    await prepareOfflineDrgFixture(root, databasePath, 52)

    const diagnosisCsv = [
      'NHSA_DIAGNOSIS_CODE,NHSA_DIAGNOSIS_NAME,STATUS',
      'A17.001,结核性脑膜炎动态编码,ACTIVE',
      'A17.0†,结核性脑膜炎剑号编码,ACTIVE',
      'a00.9,小写前缀霍乱编码,INACTIVE',
    ].join('\n') + '\n'
    const servicesCsv = [
      'SERVICE_CODE,SERVICE_NAME,CATEGORY_CODE,BILLING_UNIT_CODE,STATUS',
      'SVC-B,合成服务大写B,LABORATORY,ITEM,ACTIVE',
      'SVC-a,合成服务小写a,LABORATORY,ITEM,ACTIVE',
    ].join('\n') + '\n'
    await writeFile(join(root, 'diagnosis.csv'), diagnosisCsv)
    await writeFile(join(root, 'services.csv'), servicesCsv)

    const releaseManifestPath = join(root, 'release.json')
    await writeFile(releaseManifestPath, JSON.stringify({
      createdAt: '2026-09-15T00:00:00.000Z',
      releaseId: 'clinmesh-readonly-verify-fixture',
      schemaVersion: '1',
      sources: [
        {
          acquisitionMethod: 'generated',
          artifactFormat: 'nhsa-diagnosis-csv',
          artifactPath: 'diagnosis.csv',
          checksum: sha256(diagnosisCsv),
          licenseId: 'CC0-1.0',
          retrievedAt: '2026-09-15T00:00:00.000Z',
          sourceId: 'Source-B',
          sourceUrl: 'https://example.test/diagnosis',
          upstreamVersion: '2026-09',
        },
        {
          acquisitionMethod: 'generated',
          artifactFormat: 'nhc-medical-service-csv',
          artifactPath: 'services.csv',
          checksum: sha256(servicesCsv),
          licenseId: 'CC0-1.0',
          retrievedAt: '2026-09-15T00:00:00.000Z',
          sourceId: 'source-a',
          sourceUrl: 'https://example.test/services',
          upstreamVersion: '2026-09',
        },
      ],
    }))

    const writable = openReferenceDatabase({ busyTimeoutMs: 5_000, databasePath })
    try {
      const imported = importReferenceDataRelease(writable, releaseManifestPath)
      expect(imported).toMatchObject({
        conceptCount: 3,
        created: true,
        serviceCount: 2,
        sourceCount: 2,
      })
    } finally {
      writable.close()
    }

    const readonlyDb = openReferenceDatabase({
      busyTimeoutMs: 5_000,
      databasePath,
      readonly: true,
    })
    try {
      expect(verifyReferenceDatabase(readonlyDb)).toEqual({
        integrity: 'ok',
        releaseCount: 1,
        schemaVersion: 11,
      })
    } finally {
      readonlyDb.close()
    }

    const tamperDb = openReferenceDatabase({ busyTimeoutMs: 5_000, databasePath })
    try {
      tamperDb.driver.prepare(`
        UPDATE reference_medical_service SET system = 'not-a-valid-url' WHERE code = 'SVC-a'
      `).run()
    } finally {
      tamperDb.close()
    }

    const readonlyTampered = openReferenceDatabase({
      busyTimeoutMs: 5_000,
      databasePath,
      readonly: true,
    })
    try {
      expect(() => verifyReferenceDatabase(readonlyTampered)).toThrow(/Invalid URL|url/i)
    } finally {
      readonlyTampered.close()
    }
  })

  it('rolls back multi-source staging failures without residual TEMP tables, lingering ATTACH handles, or query_only lockups', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clinmesh-ref-atomic-staging-'))
    temporaryDirectories.push(root)
    const databasePath = join(root, 'reference.sqlite')
    const database = openReferenceDatabase({ busyTimeoutMs: 5_000, databasePath })

    try {
      applyReferenceMigrations(database)

      // Publish baseline release first to verify failed imports never touch existing formal rows.
      const baselineArtifact = `${JSON.stringify({
        concepts: [{
          code: 'R50.9',
          display: '发热',
          domain: 'diagnosis',
          id: 'baseline:fever',
          sourceLocator: 'concepts[0]',
          status: 'active',
          system: 'http://hl7.org/fhir/sid/icd-10',
          version: '2026',
        }],
        schemaVersion: '1',
      })}\n`
      await writeFile(join(root, 'baseline.json'), baselineArtifact)
      const baselineManifestPath = join(root, 'baseline-release.json')
      await writeFile(baselineManifestPath, JSON.stringify({
        createdAt: '2026-09-01T00:00:00.000Z',
        releaseId: 'baseline-release',
        schemaVersion: '1',
        sources: [{
          acquisitionMethod: 'bundled-fixture',
          artifactPath: 'baseline.json',
          checksum: sha256(baselineArtifact),
          licenseId: 'CC0-1.0',
          retrievedAt: '2026-09-01T00:00:00.000Z',
          sourceId: 'baseline-source',
          sourceUrl: 'https://example.test/baseline',
          upstreamVersion: '2026',
        }],
      }))
      const baseline = importReferenceDataRelease(database, baselineManifestPath)
      expect(baseline.created).toBe(true)

      const assertCleanConnectionAndFormalState = () => {
        const attached = databaseListSchema.parse(database.driver.pragma('database_list'))
        expect(attached.map(entry => entry.name)).not.toContain('cn_health_candidate')
        expect(database.driver.pragma('query_only', { simple: true })).toBe(0)
        const tempStagingTables = database.driver.prepare(`
          SELECT name FROM sqlite_temp_master WHERE type = 'table' AND name LIKE 'staging_%'
        `).all()
        expect(tempStagingTables).toEqual([])
        const releases = listReferenceDataReleases(database)
        expect(releases.items.map(item => item.releaseId)).toEqual(['baseline-release'])
      }

      // Failure A: Candidate source 1 succeeds, Candidate source 2 fails superRefine (quantity without unit).
      const validDiag = await createDiagnosisCandidate(join(root, 'cand-diag'), 5)
      await chmod(validDiag.databasePath, 0o444)
      const invalidLab = await createLaboratoryV2CandidateFixture(join(root, 'cand-invalid-lab'), {
        omitQuantityUnit: true,
      })
      const superRefineManifestPath = join(root, 'fail-superrefine.json')
      await writeFile(superRefineManifestPath, JSON.stringify({
        createdAt: '2026-09-15T00:00:00.000Z',
        releaseId: 'failed-superrefine-release',
        schemaVersion: '1',
        sources: [
          {
            acquisitionMethod: 'documented-api',
            artifactFormat: 'cn-health-candidate',
            artifactPath: validDiag.manifestPath,
            checksum: validDiag.manifestChecksum,
            licenseId: 'LicenseRef-Test',
            retrievedAt: '2026-09-15T00:00:00.000Z',
            sourceId: 'source-1-diag',
            sourceUrl: 'https://example.test/diag',
            upstreamVersion: validDiag.releaseId,
          },
          {
            acquisitionMethod: 'documented-api',
            artifactFormat: 'cn-health-candidate',
            artifactPath: invalidLab.manifestPath,
            checksum: invalidLab.manifestChecksum,
            licenseId: 'LicenseRef-Test',
            retrievedAt: '2026-09-15T00:00:00.000Z',
            sourceId: 'source-2-invalid-lab',
            sourceUrl: 'https://example.test/lab',
            upstreamVersion: invalidLab.releaseId,
          },
        ],
      }))
      expect(() => importReferenceDataRelease(database, superRefineManifestPath)).toThrow(/UCUM unit/)
      assertCleanConnectionAndFormalState()
      // Verify Windows file handle on failed Candidate SQLite is completely detached and deletable!
      await rm(join(root, 'cand-invalid-lab'), { recursive: true })

      // Failure B: Cross-source value_set_entry duplicate (system, version, code) across distinct valueSet URIs.
      const vs1 = 'VALUE_SET_URI,SYSTEM,CODE,DISPLAY,STATUS\nhttps://example.test/vs-1,https://example.test/cs,DUP-01,条目一,ACTIVE\n'
      const vs2 = 'VALUE_SET_URI,SYSTEM,CODE,DISPLAY,STATUS\nhttps://example.test/vs-2,https://example.test/cs,DUP-01,条目二,ACTIVE\n'
      await writeFile(join(root, 'vs1.csv'), vs1)
      await writeFile(join(root, 'vs2.csv'), vs2)
      const duplicateVsManifestPath = join(root, 'fail-dup-vs.json')
      await writeFile(duplicateVsManifestPath, JSON.stringify({
        createdAt: '2026-09-15T00:00:00.000Z',
        releaseId: 'failed-dup-vs-release',
        schemaVersion: '1',
        sources: [
          {
            acquisitionMethod: 'generated',
            artifactFormat: 'wst-value-set-csv',
            artifactPath: 'vs1.csv',
            checksum: sha256(vs1),
            licenseId: 'CC0-1.0',
            retrievedAt: '2026-09-15T00:00:00.000Z',
            sourceId: 'vs-source-1',
            sourceUrl: 'https://example.test/vs1',
            upstreamVersion: 'WS-T-2026',
          },
          {
            acquisitionMethod: 'generated',
            artifactFormat: 'wst-value-set-csv',
            artifactPath: 'vs2.csv',
            checksum: sha256(vs2),
            licenseId: 'CC0-1.0',
            retrievedAt: '2026-09-15T00:00:00.000Z',
            sourceId: 'vs-source-2',
            sourceUrl: 'https://example.test/vs2',
            upstreamVersion: 'WS-T-2026',
          },
        ],
      }))
      expect(() => importReferenceDataRelease(database, duplicateVsManifestPath))
        .toThrow(/value set entry coding was repeated/)
      assertCleanConnectionAndFormalState()

      // Now verify the same connection cleanly imports a valid multi-source composite release!
      const validDrugs = await createDrugCandidate(join(root, 'cand-drugs'), 6)
      await chmod(validDrugs.databasePath, 0o444)
      const validLab = await createLaboratoryV2CandidateFixture(join(root, 'cand-valid-lab'))
      await chmod(validLab.databasePath, 0o444)
      const ucumXml = '<root version="2.2"><unit Code="mg/L"><name>milligram per liter</name><printSymbol>mg/L</printSymbol></unit></root>\n'
      await writeFile(join(root, 'ucum.xml'), ucumXml)
      const compositeManifestPath = join(root, 'valid-composite.json')
      await writeFile(compositeManifestPath, JSON.stringify({
        createdAt: '2026-09-15T00:00:00.000Z',
        releaseId: 'valid-composite-release',
        schemaVersion: '1',
        sources: [
          {
            acquisitionMethod: 'documented-api',
            artifactFormat: 'cn-health-candidate',
            artifactPath: validDiag.manifestPath,
            checksum: validDiag.manifestChecksum,
            licenseId: 'LicenseRef-Test',
            retrievedAt: '2026-09-15T00:00:00.000Z',
            sourceId: 'composite-diag',
            sourceUrl: 'https://example.test/diag',
            upstreamVersion: validDiag.releaseId,
          },
          {
            acquisitionMethod: 'documented-api',
            artifactFormat: 'cn-health-candidate',
            artifactPath: validDrugs.manifestPath,
            checksum: validDrugs.manifestChecksum,
            licenseId: 'LicenseRef-Test',
            retrievedAt: '2026-09-15T00:00:00.000Z',
            sourceId: 'composite-drugs',
            sourceUrl: 'https://example.test/drugs',
            upstreamVersion: validDrugs.releaseId,
          },
          {
            acquisitionMethod: 'documented-api',
            artifactFormat: 'cn-health-candidate',
            artifactPath: validLab.manifestPath,
            checksum: validLab.manifestChecksum,
            licenseId: 'LicenseRef-Test',
            retrievedAt: '2026-09-15T00:00:00.000Z',
            sourceId: 'composite-lab',
            sourceUrl: 'https://example.test/lab',
            upstreamVersion: validLab.releaseId,
          },
          {
            acquisitionMethod: 'generated',
            artifactFormat: 'ucum-xml',
            artifactPath: 'ucum.xml',
            checksum: sha256(ucumXml),
            licenseId: 'UCUM',
            retrievedAt: '2026-09-15T00:00:00.000Z',
            sourceId: 'composite-ucum',
            sourceUrl: 'https://example.test/ucum',
            upstreamVersion: '2.2',
          },
          {
            acquisitionMethod: 'generated',
            artifactFormat: 'wst-value-set-csv',
            artifactPath: 'vs1.csv',
            checksum: sha256(vs1),
            licenseId: 'CC0-1.0',
            retrievedAt: '2026-09-15T00:00:00.000Z',
            sourceId: 'composite-vs',
            sourceUrl: 'https://example.test/vs1',
            upstreamVersion: 'WS-T-2026',
          },
        ],
      }))

      const created = importReferenceDataRelease(database, compositeManifestPath)
      expect(created).toMatchObject({
        conceptCount: 8,
        created: true,
        laboratoryDefinitionCount: 2,
        laboratoryPanelMemberCount: 1,
        medicationProductCount: 6,
        sourceCount: 5,
        valueSetEntryCount: 1,
      })
      const repeated = importReferenceDataRelease(database, compositeManifestPath)
      expect(repeated).toEqual({ ...created, created: false })
      expect(verifyReferenceDatabase(database)).toEqual({
        integrity: 'ok',
        releaseCount: 2,
        schemaVersion: 11,
      })
    } finally {
      database.close()
      for (const candidateDir of ['cand-diag', 'cand-drugs', 'cand-valid-lab']) {
        await chmod(join(root, candidateDir, 'data.sqlite'), 0o666).catch(() => {})
      }
    }
  })

  it('matches the legacy object contentHash byte-for-byte across all 4 cn-health Candidate datasets and CSV/XML/JSON sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clinmesh-ref-golden-parity-'))
    temporaryDirectories.push(root)
    const databasePath = join(root, 'reference.sqlite')

    const [diag, drugs, lab, loinc] = await Promise.all([
      createDiagnosisCandidate(join(root, 'cand-diag'), 25),
      createDrugCandidate(join(root, 'cand-drugs'), 20),
      createLaboratoryV2CandidateFixture(join(root, 'cand-lab')),
      createLoincV2CandidateFixture(join(root, 'cand-loinc')),
    ])

    const ucumXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<root version="2.2" revision="synthetic">',
      '  <!-- synthetic comment -->',
      '  <prefix Code="m" CodeUC="M"><name>milli</name><printSymbol>m</printSymbol><value value="1e-3"/></prefix>',
      '  <base-unit Code="g" CodeUC="G" dim="M"><name>gram</name><printSymbol>g</printSymbol><property>mass</property></base-unit>',
      '  <unit Code="mmol/L" isMetric="yes" class="clinical">',
      '    <name>millimole per liter</name>',
      '    <printSymbol>mmol/L</printSymbol>',
      '    <property>amount-of-substance concentration</property>',
      '    <value Unit="mol/L" UNIT="MOL/L" value="1e-3">0.001</value>',
      '  </unit>',
      '  <prefix Code="u" CodeUC="U"><name>micro</name><printSymbol>u</printSymbol><value value="1e-6"/></prefix>',
      '</root>',
      '',
    ].join('\n')
    const servicesCsv = 'SERVICE_CODE,SERVICE_NAME,CATEGORY_CODE,BILLING_UNIT_CODE,STATUS\nSVC-B,合成服务B,LABORATORY,ITEM,ACTIVE\nSVC-a,合成服务a,LABORATORY,ITEM,INACTIVE\n'
    const valueSetsCsv = 'VALUE_SET_URI,SYSTEM,CODE,DISPLAY,STATUS\nhttps://example.test/vs,https://example.test/cs,VS-†,剑号条目,ACTIVE\nhttps://example.test/vs,https://example.test/cs,VS-01,普通条目,ACTIVE\n'
    // Deliberately place laboratoryDefinitions BEFORE concepts in clinmesh-reference-v1 JSON.
    const customV1Json = `{\n  "laboratoryDefinitions": [\n    {\n      "kind": "loinc",\n      "conceptId": "custom:lab:1",\n      "component": "Custom",\n      "property": "MCnc",\n      "timeAspect": "Pt",\n      "system": "Ser",\n      "scaleType": "Qn",\n      "methodType": null,\n      "classCode": "CHEM",\n      "classType": 1,\n      "orderObservation": "Both",\n      "panelType": null,\n      "sourceLocator": "custom:def:1"\n    }\n  ],\n  "schemaVersion": "1",\n  "concepts": [\n    {\n      "id": "custom:lab:1",\n      "domain": "laboratory",\n      "system": "https://example.test/custom-lab",\n      "version": "2026",\n      "code": "CL-†1",\n      "display": "自定义流式检验概念",\n      "status": "active",\n      "sourceLocator": "custom:concept:1"\n    }\n  ]\n}\n`

    await writeFile(join(root, 'ucum.xml'), ucumXml)
    await writeFile(join(root, 'services.csv'), servicesCsv)
    await writeFile(join(root, 'valuesets.csv'), valueSetsCsv)
    await writeFile(join(root, 'custom-v1.json'), customV1Json)

    const releaseManifest = {
      createdAt: '2026-09-15T00:00:00.000Z',
      releaseId: 'clinmesh-end-to-end-parity-release',
      schemaVersion: '1' as const,
      sources: [
        {
          acquisitionMethod: 'documented-api' as const,
          artifactFormat: 'cn-health-candidate' as const,
          artifactPath: diag.manifestPath,
          checksum: diag.manifestChecksum,
          licenseId: 'LicenseRef-Test',
          publishedAt: '2022-01-01',
          retrievedAt: '2026-09-15T00:00:00.000Z',
          sourceId: 'Source-B-icd10',
          sourceUrl: 'https://example.test/icd10',
          upstreamVersion: diag.releaseId,
        },
        {
          acquisitionMethod: 'documented-api' as const,
          artifactFormat: 'cn-health-candidate' as const,
          artifactPath: drugs.manifestPath,
          checksum: drugs.manifestChecksum,
          licenseId: 'LicenseRef-Test',
          publishedAt: '2026-01-09',
          retrievedAt: '2026-09-15T00:00:00.000Z',
          sourceId: 'source-a-drugs',
          sourceUrl: 'https://example.test/drugs',
          upstreamVersion: drugs.releaseId,
        },
        {
          acquisitionMethod: 'documented-api' as const,
          artifactFormat: 'cn-health-candidate' as const,
          artifactPath: lab.manifestPath,
          checksum: lab.manifestChecksum,
          licenseId: 'LicenseRef-Test',
          publishedAt: '2026-09-01',
          retrievedAt: '2026-09-15T00:00:00.000Z',
          sourceId: 'source-c-lab',
          sourceUrl: 'https://example.test/lab',
          upstreamVersion: lab.releaseId,
        },
        {
          acquisitionMethod: 'documented-api' as const,
          artifactFormat: 'cn-health-candidate' as const,
          artifactPath: loinc.manifestPath,
          checksum: loinc.manifestChecksum,
          licenseId: 'LicenseRef-Test',
          publishedAt: '2026-09-01',
          retrievedAt: '2026-09-15T00:00:00.000Z',
          sourceId: 'Source-A-loinc',
          sourceUrl: 'https://example.test/loinc',
          upstreamVersion: loinc.releaseId,
        },
        {
          acquisitionMethod: 'generated' as const,
          artifactFormat: 'ucum-xml' as const,
          artifactPath: 'ucum.xml',
          checksum: sha256(ucumXml),
          licenseId: 'UCUM',
          retrievedAt: '2026-09-15T00:00:00.000Z',
          sourceId: 'source-ucum',
          sourceUrl: 'https://example.test/ucum',
          upstreamVersion: '2.2',
        },
        {
          acquisitionMethod: 'generated' as const,
          artifactFormat: 'nhc-medical-service-csv' as const,
          artifactPath: 'services.csv',
          checksum: sha256(servicesCsv),
          licenseId: 'CC0-1.0',
          retrievedAt: '2026-09-15T00:00:00.000Z',
          sourceId: 'source-services',
          sourceUrl: 'https://example.test/services',
          upstreamVersion: '2026-09',
        },
        {
          acquisitionMethod: 'generated' as const,
          artifactFormat: 'wst-value-set-csv' as const,
          artifactPath: 'valuesets.csv',
          checksum: sha256(valueSetsCsv),
          licenseId: 'CC0-1.0',
          retrievedAt: '2026-09-15T00:00:00.000Z',
          sourceId: 'source-vs',
          sourceUrl: 'https://example.test/vs',
          upstreamVersion: 'WS-T-2026',
        },
        {
          acquisitionMethod: 'bundled-fixture' as const,
          artifactFormat: 'clinmesh-reference-v1' as const,
          artifactPath: 'custom-v1.json',
          checksum: sha256(customV1Json),
          licenseId: 'CC0-1.0',
          retrievedAt: '2026-09-15T00:00:00.000Z',
          sourceId: 'source-custom-v1',
          sourceUrl: 'https://example.test/custom-v1',
          upstreamVersion: '2026',
        },
      ],
    }
    const manifestPath = join(root, 'parity-release.json')
    await writeFile(manifestPath, JSON.stringify(releaseManifest))

    const database = openReferenceDatabase({ busyTimeoutMs: 5_000, databasePath })
    let importedHash = ''
    let persistedSources: ReferenceSourceManifest[] = []
    try {
      applyReferenceMigrations(database)
      const imported = importReferenceDataRelease(database, manifestPath)
      importedHash = imported.contentHash
      persistedSources = listReferenceDataReleases(database).items[0]!.sources
    } finally {
      database.close()
    }

    // Build expected hash independently via legacy parse* functions + legacy object canonicalize
    const parsedBySource = [
      { artifact: parseCnHealthCandidateReferenceArtifact(diag.manifestPath).artifact, sourceId: 'Source-B-icd10' },
      { artifact: parseCnHealthCandidateReferenceArtifact(drugs.manifestPath).artifact, sourceId: 'source-a-drugs' },
      { artifact: parseCnHealthCandidateReferenceArtifact(lab.manifestPath).artifact, sourceId: 'source-c-lab' },
      { artifact: parseCnHealthCandidateReferenceArtifact(loinc.manifestPath).artifact, sourceId: 'Source-A-loinc' },
      { artifact: parseUcumXmlReferenceArtifact({ content: ucumXml, version: '2.2' }), sourceId: 'source-ucum' },
      { artifact: parseNhcMedicalServiceCsvArtifact({ content: servicesCsv, version: '2026-09' }), sourceId: 'source-services' },
      { artifact: parseWstValueSetCsvArtifact({ content: valueSetsCsv, version: 'WS-T-2026' }), sourceId: 'source-vs' },
      { artifact: referenceArtifactSchema.parse(JSON.parse(customV1Json)), sourceId: 'source-custom-v1' },
    ]
    const withSource = <Item extends object>(items: Item[], sourceId: string) => (
      items.map(item => ({ ...item, sourceId }))
    )
    const expectedOracleHash = legacyReleaseObjectContentHash({
      concepts: parsedBySource.flatMap(entry => withSource(entry.artifact.concepts, entry.sourceId)),
      laboratoryDefinitions: parsedBySource.flatMap(entry => withSource(entry.artifact.laboratoryDefinitions, entry.sourceId)),
      laboratoryPanelMembers: parsedBySource.flatMap(entry => withSource(entry.artifact.laboratoryPanelMembers, entry.sourceId)),
      laboratorySpecimens: parsedBySource.flatMap(entry => withSource(entry.artifact.laboratorySpecimens, entry.sourceId)),
      laboratoryUnits: parsedBySource.flatMap(entry => withSource(entry.artifact.laboratoryUnits, entry.sourceId)),
      medicationProducts: parsedBySource.flatMap(entry => withSource(entry.artifact.medicationProducts, entry.sourceId)),
      release: releaseManifest,
      services: parsedBySource.flatMap(entry => withSource(entry.artifact.services, entry.sourceId)),
      sources: persistedSources,
      valueSetEntries: parsedBySource.flatMap(entry => withSource(entry.artifact.valueSetEntries, entry.sourceId)),
    })

    expect(importedHash).toBe(expectedOracleHash)

    const readonlyDb = openReferenceDatabase({
      busyTimeoutMs: 5_000,
      databasePath,
      readonly: true,
    })
    try {
      expect(verifyReferenceDatabase(readonlyDb)).toEqual({
        integrity: 'ok',
        releaseCount: 1,
        schemaVersion: 11,
      })
    } finally {
      readonlyDb.close()
    }
  })

  it('supports cross-source laboratory concept references regardless of manifest source order and rejects missing concepts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clinmesh-ref-cross-source-fk-'))
    temporaryDirectories.push(root)
    const databasePath = join(root, 'reference.sqlite')

    // Source 1 (listed FIRST in manifest) emits laboratory relationships referencing a member concept supplied by Source 2 (listed LATER).
    const relationsFirstJson = JSON.stringify({
      concepts: [{
        code: 'PANEL-01',
        display: '合成跨源检验组合',
        domain: 'laboratory',
        id: 'cross:panel:1',
        sourceLocator: 'relations-first.json:concept[1]',
        status: 'active',
        system: 'https://example.test/cross-lab',
        version: '2026',
      }],
      laboratoryDefinitions: [{
        classCode: 'CHEM',
        classType: 1,
        component: 'CrossMember',
        conceptId: 'loinc:2.83:90001-1',
        kind: 'loinc',
        methodType: null,
        orderObservation: 'Observation',
        panelType: null,
        property: 'MCnc',
        scaleType: 'Qn',
        sourceLocator: 'relations-first.json:def[1]',
        system: 'Ser',
        timeAspect: 'Pt',
      }],
      laboratoryPanelMembers: [{
        memberConceptId: 'loinc:2.83:90001-1',
        memberOrder: 1,
        panelConceptId: 'cross:panel:1',
        relationship: 'contains',
        sourceLocator: 'relations-first.json:panelMember[1]',
      }],
      laboratorySpecimens: [{
        conceptId: 'loinc:2.83:90001-1',
        display: '血清',
        linkType: 'Primary',
        partName: 'Ser',
        partNumber: 'LP7567-3',
        sourceLocator: 'relations-first.json:specimen[1]',
      }],
      laboratoryUnits: [{
        code: 'mmol/L',
        conceptId: 'loinc:2.83:90001-1',
        kind: 'example',
        ordinal: 1,
        sourceLocator: 'relations-first.json:unit[1]',
      }],
      schemaVersion: '1',
    })
    const loincCsv = [
      'LOINC_NUM,LONG_COMMON_NAME,STATUS',
      '90001-1,Synthetic cross-source laboratory member,ACTIVE',
      '',
    ].join('\n')
    const ucumWithSiblingsXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<root version="2.2">',
      '  <prefix Code="k" note="a > b"><name>kilo</name><printSymbol>k</printSymbol><value value="1e3"/></prefix>',
      '  <base-unit Code="m" dim="L"><name>meter</name><printSymbol>m</printSymbol><property><![CDATA[length > 0]]></property></base-unit>',
      '  <unit Code="mmol/L"><name>millimole per liter</name><printSymbol>mmol/L</printSymbol></unit>',
      '</root>',
      '',
    ].join('\n')

    await writeFile(join(root, 'relations-first.json'), relationsFirstJson)
    await writeFile(join(root, 'loinc.csv'), loincCsv)
    await writeFile(join(root, 'ucum-siblings.xml'), ucumWithSiblingsXml)

    const orphanManifestPath = join(root, 'orphan-manifest.json')
    await writeFile(orphanManifestPath, JSON.stringify({
      createdAt: '2026-09-15T00:00:00.000Z',
      releaseId: 'orphan-cross-source-release',
      schemaVersion: '1',
      sources: [{
        acquisitionMethod: 'bundled-fixture',
        artifactFormat: 'clinmesh-reference-v1',
        artifactPath: 'relations-first.json',
        checksum: sha256(relationsFirstJson),
        licenseId: 'CC0-1.0',
        retrievedAt: '2026-09-15T00:00:00.000Z',
        sourceId: 'source-1-relations',
        sourceUrl: 'https://example.test/relations',
        upstreamVersion: '2026',
      }],
    }))

    const validManifestPath = join(root, 'valid-cross-source-manifest.json')
    await writeFile(validManifestPath, JSON.stringify({
      createdAt: '2026-09-15T00:00:00.000Z',
      releaseId: 'valid-cross-source-release',
      schemaVersion: '1',
      sources: [
        {
          acquisitionMethod: 'bundled-fixture',
          artifactFormat: 'clinmesh-reference-v1',
          artifactPath: 'relations-first.json',
          checksum: sha256(relationsFirstJson),
          licenseId: 'CC0-1.0',
          retrievedAt: '2026-09-15T00:00:00.000Z',
          sourceId: 'source-1-relations',
          sourceUrl: 'https://example.test/relations',
          upstreamVersion: '2026',
        },
        {
          acquisitionMethod: 'documented-api',
          artifactFormat: 'loinc-csv',
          artifactPath: 'loinc.csv',
          checksum: sha256(loincCsv),
          licenseId: 'LicenseRef-LOINC',
          retrievedAt: '2026-09-15T00:00:00.000Z',
          sourceId: 'source-2-loinc',
          sourceUrl: 'https://example.test/loinc',
          upstreamVersion: '2.83',
        },
        {
          acquisitionMethod: 'generated',
          artifactFormat: 'ucum-xml',
          artifactPath: 'ucum-siblings.xml',
          checksum: sha256(ucumWithSiblingsXml),
          licenseId: 'UCUM',
          retrievedAt: '2026-09-15T00:00:00.000Z',
          sourceId: 'source-3-ucum',
          sourceUrl: 'https://example.test/ucum',
          upstreamVersion: '2.2',
        },
      ],
    }))

    const database = openReferenceDatabase({ busyTimeoutMs: 5_000, databasePath })
    try {
      applyReferenceMigrations(database)

      // Missing concept_id across all sources must fail cleanly and drop all temp staging tables.
      expect(() => importReferenceDataRelease(database, orphanManifestPath))
        .toThrow(/FOREIGN KEY constraint failed/)
      expect(database.driver.prepare(
        "SELECT name FROM sqlite_temp_schema WHERE type = 'table' AND name LIKE 'staging_%'",
      ).all()).toEqual([])
      expect(listReferenceDataReleases(database).items).toHaveLength(0)

      // Cross-source concept_id supplied by a later source in manifest.sources must succeed.
      const imported = importReferenceDataRelease(database, validManifestPath)
      expect(imported).toMatchObject({
        conceptCount: 3,
        created: true,
        laboratoryDefinitionCount: 1,
        laboratoryPanelMemberCount: 1,
        laboratorySpecimenCount: 1,
        laboratoryUnitCount: 1,
        sourceCount: 3,
      })
      expect(importReferenceDataRelease(database, validManifestPath)).toEqual({
        ...imported,
        created: false,
      })
      expect(verifyReferenceDatabase(database)).toEqual({
        integrity: 'ok',
        releaseCount: 1,
        schemaVersion: 11,
      })
    } finally {
      database.close()
    }
  })
})

describe('300k-row reference release subprocess RSS budget (< 384 MiB)', () => {
  let rootDirectory = ''
  let databasePath = ''
  let manifestPath = ''

  beforeAll(async () => {
    rootDirectory = await mkdtemp(join(tmpdir(), 'clinmesh-ref-300k-rss-'))
    databasePath = join(rootDirectory, 'reference.sqlite')
    manifestPath = join(rootDirectory, 'composite-300k-release.json')

    const database = openReferenceDatabase({ busyTimeoutMs: 5_000, databasePath })
    try {
      applyReferenceMigrations(database)
    } finally {
      database.close()
    }
    await prepareOfflineDrgFixture(rootDirectory, databasePath, 2)

    const [diagnosis, drugs, laboratory] = await Promise.all([
      createDiagnosisCandidate(join(rootDirectory, 'diagnosis'), 37_500),
      createDrugCandidate(join(rootDirectory, 'drugs'), 265_000),
      createLaboratoryV2CandidateFixture(join(rootDirectory, 'laboratory')),
    ])

    await writeFile(manifestPath, `${JSON.stringify({
      createdAt: '2026-09-15T00:00:00.000Z',
      releaseId: 'clinmesh-synthetic-300k-rss-release',
      schemaVersion: '1',
      sources: [
        {
          acquisitionMethod: 'documented-api',
          artifactFormat: 'cn-health-candidate',
          artifactPath: diagnosis.manifestPath,
          checksum: diagnosis.manifestChecksum,
          licenseId: 'LicenseRef-cn-health-source-terms',
          publishedAt: '2022-01-01',
          retrievedAt: '2026-09-15T00:00:00.000Z',
          sourceId: 'cn-health-nhc-icd10-clinical',
          sourceUrl: 'https://example.test/icd10',
          upstreamVersion: diagnosis.releaseId,
        },
        {
          acquisitionMethod: 'documented-api',
          artifactFormat: 'cn-health-candidate',
          artifactPath: drugs.manifestPath,
          checksum: drugs.manifestChecksum,
          licenseId: 'LicenseRef-cn-health-source-terms',
          publishedAt: '2026-01-09',
          retrievedAt: '2026-09-15T00:00:00.000Z',
          sourceId: 'cn-health-nhsa-drugs',
          sourceUrl: 'https://example.test/drugs',
          upstreamVersion: drugs.releaseId,
        },
        {
          acquisitionMethod: 'documented-api',
          artifactFormat: 'cn-health-candidate',
          artifactPath: laboratory.manifestPath,
          checksum: laboratory.manifestChecksum,
          licenseId: 'LicenseRef-cn-health-source-terms',
          publishedAt: '2026-09-01',
          retrievedAt: '2026-09-15T00:00:00.000Z',
          sourceId: 'cn-health-laboratory-cn',
          sourceUrl: 'https://example.test/laboratory',
          upstreamVersion: laboratory.releaseId,
        },
      ],
    })}\n`)
  }, 30_000)

  afterAll(async () => {
    if (rootDirectory !== '') {
      await rm(rootDirectory, { force: true, recursive: true })
    }
  })

  it('keeps fresh import, idempotent re-import, and readonly verification each under 384 MiB peak RSS for a 302,500+ row composite release', async () => {
    const freshImport = await runRssWorker({
      databasePath,
      manifestPath,
      mode: 'import',
    })
    const parsedFresh = z.object({
      conceptCount: z.number().int(),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      created: z.literal(true),
      laboratoryDefinitionCount: z.number().int(),
      laboratoryPanelMemberCount: z.number().int(),
      medicationProductCount: z.number().int(),
      sourceCount: z.number().int(),
    }).parse(freshImport.result)
    expect(parsedFresh).toMatchObject({
      conceptCount: 37_502,
      created: true,
      laboratoryDefinitionCount: 2,
      laboratoryPanelMemberCount: 1,
      medicationProductCount: 265_000,
      sourceCount: 3,
    })
    expect(freshImport.peakRssBytes).toBeLessThan(memoryBudgetBytes)

    const reimport = await runRssWorker({
      databasePath,
      manifestPath,
      mode: 'import',
    })
    expect(reimport.result).toMatchObject({
      conceptCount: 37_502,
      contentHash: parsedFresh.contentHash,
      created: false,
      medicationProductCount: 265_000,
    })
    expect(reimport.peakRssBytes).toBeLessThan(memoryBudgetBytes)

    const readonlyVerify = await runRssWorker({
      databasePath,
      mode: 'verify-readonly',
    })
    expect(readonlyVerify.result).toEqual({
      integrity: 'ok',
      releaseCount: 1,
      schemaVersion: 11,
    })
    expect(readonlyVerify.peakRssBytes).toBeLessThan(memoryBudgetBytes)
  }, 90_000)
})
