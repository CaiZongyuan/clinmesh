import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runReferenceDatabaseCli } from '../../server/src/reference-database-cli.ts'

export async function createInvestigationReferenceDatabase(directory: string) {
  const sourceVersion = '2026-09-01'
  const system = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026'
  const tests = [{
    code: '0100101A', display: '合成白细胞计数', loinc: '6690-2', low: 3.5, high: 9.5,
    unitCode: '10*9/L', unitDisplay: '×10^9/L',
  }, {
    code: '0100501A', display: '合成血红蛋白', loinc: '718-7', low: 115, high: 150,
    unitCode: 'g/L', unitDisplay: 'g/L',
  }]
  const artifactJson = `${JSON.stringify({
    schemaVersion: '1',
    concepts: tests.map(item => ({
      code: item.code, display: item.display, domain: 'laboratory',
      id: `wst-886:2026:${item.code}`, sourceLocator: `synthetic:e2e:${item.code}`,
      status: 'active', system, version: '2026',
    })),
    laboratoryDefinitions: tests.map(item => ({
      adultReferenceRules: [{
        high: item.high, low: item.low, notes: '合成成人静脉血定义', referenceKind: 'range', sex: 'all',
        simulationHigh: item.high, simulationLow: item.low,
        sourceLocation: '合成测试定义', sourceStandard: 'WS/T 405-2012',
        sourceType: 'national-standard', sourceVersion: '2012',
      }],
      alternateCodings: [{ code: item.loinc, system: 'http://loinc.org', version: '2.83' }],
      analyte: item.display, category: '血细胞分析', conceptId: `wst-886:2026:${item.code}`,
      datasetReleaseId: `laboratory-cn@${sourceVersion}.r1`, healthyStrategy: 'uniform',
      kind: 'laboratory-cn-test', precision: 1, resultKind: 'quantity', scale: '定量',
      sourceLocator: `synthetic:e2e:${item.code}`, sourceVersion, specimen: '全血',
      unit: { code: item.unitCode, display: item.unitDisplay, system: 'http://unitsofmeasure.org' },
    })),
  })}\n`
  await writeFile(join(directory, 'reference.json'), artifactJson)
  const manifestPath = join(directory, 'release.json')
  await writeFile(manifestPath, `${JSON.stringify({
    createdAt: '2026-09-01T07:00:00.000Z', releaseId: 'investigation-e2e-v1', schemaVersion: '1',
    sources: [{
      acquisitionMethod: 'generated', artifactPath: 'reference.json',
      checksum: createHash('sha256').update(artifactJson).digest('hex'),
      licenseId: 'LicenseRef-Synthetic-Test', retrievedAt: '2026-09-01T07:00:00.000Z',
      sourceId: 'synthetic-laboratory-cn', sourceUrl: 'https://example.test/synthetic-laboratory-cn',
      upstreamVersion: sourceVersion,
    }],
  })}\n`)
  const databasePath = join(directory, 'reference.sqlite')
  await runReferenceDatabaseCli(['migrate', '--database', databasePath])
  await runReferenceDatabaseCli(['import', '--database', databasePath, '--manifest', manifestPath])
  return databasePath
}
