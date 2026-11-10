import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReferenceMedicationProduct } from '@clinmesh/contracts/reference-data'
import { runReferenceDatabaseCli } from '../../server/src/reference-database-cli.ts'

export type InvestigationReferenceOptions = {
  includeCbc?: boolean
  laboratoryNames?: Readonly<Record<string, string>>
  additionalLaboratoryItems?: ReadonlyArray<{ code: string; display: string; loinc: string }>
}

export async function createInvestigationReferenceDatabase(directory: string, medicationProducts: ReferenceMedicationProduct[] = [], options: InvestigationReferenceOptions = {}) {
  const { laboratoryNames = {}, additionalLaboratoryItems = [] } = options
  const sourceVersion = '2026-09-01'
  const system = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026'
  const tests = [{
    code: '0100101A', display: laboratoryNames['0100101A'] ?? '合成白细胞计数', loinc: '6690-2', low: 3.5, high: 9.5,
    unitCode: '10*9/L', unitDisplay: '×10^9/L',
  }, {
    code: '0100501A', display: '合成血红蛋白', loinc: '718-7', low: 115, high: 150,
    unitCode: 'g/L', unitDisplay: 'g/L',
  }, {
    code: '0101901A', display: '合成不兼容检验', loinc: '1988-5', low: 0, high: 8,
    unitCode: 'mmol/L', unitDisplay: 'mmol/L',
  }, ...additionalLaboratoryItems.map(item => ({ ...item, low: 1, high: 9, unitCode: '10*9/L', unitDisplay: '×10^9/L' }))]
  const panelId = `laboratory-panel-cn:${sourceVersion}:CN-LAB-CBC`
  const artifactJson = `${JSON.stringify({
    schemaVersion: '1',
    medicationProducts,
    concepts: [...tests.map(item => ({
      code: item.code, display: item.display, domain: 'laboratory',
      id: `wst-886:2026:${item.code}`, sourceLocator: `synthetic:e2e:${item.code}`,
      status: 'active', system, version: '2026',
    })), ...(options.includeCbc ? [{
      id: panelId, code: 'CN-LAB-CBC', display: '合成血常规（白细胞计数与血红蛋白联合检查）', domain: 'laboratory',
      system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-panel-cn',
      version: sourceVersion, status: 'active', sourceLocator: 'synthetic:e2e:CN-LAB-CBC',
    }] : [])],
    laboratoryDefinitions: [...tests.map(item => ({
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
    })), ...(options.includeCbc ? [{
      conceptId: panelId, datasetReleaseId: `laboratory-cn@${sourceVersion}.r1`, kind: 'laboratory-cn-panel',
      notes: '合成白细胞与血红蛋白组合', sourceLocation: 'synthetic:e2e:CN-LAB-CBC',
      sourceLocator: 'synthetic:e2e:CN-LAB-CBC', sourceType: 'project-authored', sourceVersion, specimen: '全血',
    }] : [])],
    laboratoryPanelMembers: options.includeCbc ? tests.slice(0, 2).map((item, index) => ({
      panelConceptId: panelId, memberConceptId: `wst-886:2026:${item.code}`, memberOrder: index + 1,
      relationship: 'contains', sourceLocator: `synthetic:e2e:CN-LAB-CBC:${index + 1}`,
    })) : [],
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
