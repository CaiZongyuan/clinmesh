import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ReferenceConcept,
  ReferenceImportManifest,
  ReferenceLaboratoryDefinition,
  ReferenceLaboratoryPanelMember,
  ReferenceLaboratorySpecimen,
  ReferenceLaboratoryUnit,
  ReferenceMedicalService,
  ReferenceMedicationProduct,
  ReferenceSourceManifest,
  ReferenceValueSetEntry,
} from '@clinmesh/contracts/reference-data'
import { afterEach, describe, expect, it } from 'vitest'
import {
  computeStreamingReleaseContentHash,
} from '../src/infrastructure/reference-data/canonical-json-hasher.ts'

function referenceCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(referenceCanonicalize)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, referenceCanonicalize(entry)]))
}

function referenceObjectContentHash(input: {
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
  const payload = JSON.stringify(referenceCanonicalize({
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
  return createHash('sha256').update(payload).digest('hex')
}

describe('streaming canonical JSON release hasher', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('matches the legacy legacy-v1 release golden hash when optional child tables are empty', () => {
    const release = {
      createdAt: '2026-08-28T00:00:00.000Z',
      releaseId: 'reference-synthetic-2026-08-28',
      schemaVersion: '1' as const,
    }
    const sources: ReferenceSourceManifest[] = [{
      acquisitionMethod: 'bundled-fixture',
      artifactFormat: 'clinmesh-reference-v1',
      checksum: 'b1d09a8c7259bb3b882b18da7bbaeebc51ea06599ea9b19c32f830fac10e8db7',
      importDiagnostics: { acceptedCount: 1, rejectedCount: 0, warnings: [] },
      licenseId: 'CC0-1.0',
      publishedAt: '2026-08-28',
      recordCount: 1,
      retrievedAt: '2026-08-28T00:00:00.000Z',
      sourceId: 'synthetic-diagnosis',
      sourceUrl: 'https://example.test/reference/synthetic-diagnosis',
      upstreamVersion: 'synthetic-2026',
    }]
    const concepts: Array<ReferenceConcept & { sourceId: string }> = [{
      code: 'R50.9',
      display: '发热，未特指',
      domain: 'diagnosis',
      id: 'diagnosis:fever',
      sourceId: 'synthetic-diagnosis',
      sourceLocator: 'concepts[0]',
      status: 'active',
      system: 'http://hl7.org/fhir/sid/icd-10',
      version: 'synthetic-2026',
    }]

    const actual = computeStreamingReleaseContentHash({
      concepts,
      release,
      sources,
    })

    expect(actual).toBe('34805f47f23bc8e705006949b8fe446726eaa8f00516f150f4211b99f3855c90')
  })

  it('reproduces byte-identical SHA-256 across all 8 child tables, dagger codes, mixed-case keys, and external temp-file merge', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'clinmesh-canonical-hash-test-'))
    temporaryDirectories.push(tempDirectory)

    const release = {
      createdAt: '2026-09-15T00:00:00.000Z',
      releaseId: 'clinmesh-golden-comparison-release',
      schemaVersion: '1' as const,
    }
    const sources: ReferenceSourceManifest[] = [
      {
        acquisitionMethod: 'documented-api',
        artifactFormat: 'cn-health-candidate',
        candidate: {
          canonicalSha256: 'a'.repeat(64),
          datasetId: 'nhc-icd10-clinical',
          datasetSchemaVersion: 1,
          recordCount: 6,
          releaseId: 'nhc-icd10-clinical@2022.r4',
          sourceVersion: '2022',
          sqliteSha256: 'b'.repeat(64),
          sqliteSizeBytes: 4096,
        },
        checksum: '1'.repeat(64),
        importDiagnostics: { acceptedCount: 6, rejectedCount: 0, warnings: [] },
        licenseId: 'LicenseRef-cn-health-source-terms',
        materialization: {
          cliVersion: '0.5.2',
          manifestSha256: '1'.repeat(64),
          registryKeyId: '39a4b92d69269839',
          registryUrl: 'https://example.test/registry.json',
          sqliteSha256: 'b'.repeat(64),
          sqliteSizeBytes: 4096,
        },
        publishedAt: '2022-01-01',
        recordCount: 6,
        retrievedAt: '2026-09-02T00:00:00.000Z',
        sourceId: 'source-B-upper',
        sourceUrl: 'https://example.test/icd10',
        upstreamVersion: 'nhc-icd10-clinical@2022.r4',
      },
      {
        acquisitionMethod: 'bundled-fixture',
        artifactFormat: 'clinmesh-reference-v1',
        checksum: '2'.repeat(64),
        importDiagnostics: { acceptedCount: 5, rejectedCount: 0, warnings: ['synthetic warning'] },
        licenseId: 'CC0-1.0',
        recordCount: 5,
        retrievedAt: '2026-09-02T00:00:00.000Z',
        sourceId: 'source-a-lower',
        sourceUrl: 'https://example.test/v1',
        upstreamVersion: '2026-09',
      },
    ]

    // Intentionally supply items in SQLite BINARY order where 'B' < 'a' and 'A17.001' < 'A17.0†',
    // which disagrees with localeCompare ('a' < 'B' and 'A17.0†' < 'A17.001').
    const concepts: Array<ReferenceConcept & { sourceId: string }> = [
      {
        code: 'A17.001',
        display: '结核性脑膜炎动态观察',
        domain: 'diagnosis',
        id: 'nhsa-diagnosis:2022:A17.001',
        sourceId: 'source-B-upper',
        sourceLocator: 'row:3',
        status: 'active',
        system: 'urn:clinmesh:reference:nhsa-diagnosis',
        version: '2022',
      },
      {
        code: 'A17.0†',
        display: '结核性脑膜炎(G01*)',
        domain: 'diagnosis',
        id: 'nhsa-diagnosis:2022:A17.0†',
        sourceId: 'source-B-upper',
        sourceLocator: 'row:1',
        status: 'active',
        system: 'urn:clinmesh:reference:nhsa-diagnosis',
        version: '2022',
      },
      {
        code: 'A17.0*',
        display: '星号测试编码',
        domain: 'diagnosis',
        id: 'nhsa-diagnosis:2022:A17.0*',
        sourceId: 'source-B-upper',
        sourceLocator: 'row:2',
        status: 'inactive',
        system: 'urn:clinmesh:reference:nhsa-diagnosis',
        version: '2022',
      },
      {
        code: 'Z00',
        display: '大写前缀编码',
        domain: 'laboratory',
        id: 'lab:Z00',
        laboratory: {
          category: 'chemistry',
          referenceRange: { high: 9.5, low: 3.5, text: '3.5-9.5' },
          resultType: 'quantity',
          specimen: 'blood',
          unit: { code: 'mg/L', display: 'mg/L', system: 'http://unitsofmeasure.org' },
        },
        sourceId: 'source-a-lower',
        sourceLocator: 'row:4',
        status: 'active',
        system: 'http://loinc.org',
        version: '2.83',
      },
      {
        code: 'a00',
        display: '小写前缀组合',
        domain: 'laboratory',
        id: 'lab:a00',
        laboratory: {
          category: 'hematology',
          resultType: 'panel',
          specimen: 'blood',
        },
        sourceId: 'source-a-lower',
        sourceLocator: 'row:5',
        status: 'active',
        system: 'http://loinc.org',
        version: '2.83',
      },
    ]

    const laboratoryDefinitions: Array<ReferenceLaboratoryDefinition & { sourceId: string }> = [
      {
        classCode: 'CHEM',
        classType: 1,
        component: 'Analyte',
        conceptId: 'lab:Z00',
        kind: 'loinc',
        methodType: null,
        orderObservation: 'Both',
        panelType: null,
        property: 'MCnc',
        scaleType: 'Qn',
        sourceId: 'source-a-lower',
        sourceLocator: 'def:2',
        system: 'Ser',
        timeAspect: 'Pt',
      },
      {
        adultReferenceRules: [{
          high: 9.5,
          low: 3.5,
          notes: '',
          referenceKind: 'range',
          sex: 'all',
          simulationHigh: 9.5,
          simulationLow: 3.5,
          sourceLocation: '表 1',
          sourceStandard: 'WS/T 405-2012',
          sourceType: 'national-standard',
          sourceVersion: '2012',
        }],
        alternateCodings: [{ code: '6690-2', system: 'http://loinc.org', version: '2.83' }],
        analyte: '白细胞',
        category: '血细胞',
        conceptId: 'lab:a00†',
        datasetReleaseId: 'laboratory-cn@2026-09-01.r1',
        healthyStrategy: 'uniform',
        kind: 'laboratory-cn-test',
        precision: 1,
        resultKind: 'quantity',
        scale: '定量',
        sourceId: 'source-a-lower',
        sourceLocator: 'def:1',
        sourceVersion: '2026-09-01',
        specimen: '全血',
        unit: { code: '10*9/L', display: '×10^9/L', system: 'http://unitsofmeasure.org' },
      },
    ]

    const laboratoryUnits: Array<ReferenceLaboratoryUnit & { sourceId: string }> = [
      { code: 'mg/L', conceptId: 'lab:Z00', kind: 'example', ordinal: 2, sourceId: 'source-a-lower', sourceLocator: 'loc:B' },
      { code: 'g/L', conceptId: 'lab:Z00', kind: 'example', ordinal: 1, sourceId: 'source-a-lower', sourceLocator: 'loc:†' },
      { code: 'ug/L', conceptId: 'lab:Z00', kind: 'example', ordinal: 3, sourceId: 'source-a-lower', sourceLocator: 'loc:a' },
    ]

    const laboratorySpecimens: Array<ReferenceLaboratorySpecimen & { sourceId: string }> = [
      { conceptId: 'lab:Z00', display: '血清', linkType: 'Primary', partName: 'Serum', partNumber: 'LP001', sourceId: 'source-a-lower', sourceLocator: 'spec:2' },
      { conceptId: 'lab:Z00', display: '全血', linkType: 'Primary', partName: 'Blood', partNumber: 'LP†01', sourceId: 'source-a-lower', sourceLocator: 'spec:1' },
    ]

    const laboratoryPanelMembers: Array<ReferenceLaboratoryPanelMember & { sourceId: string }> = [
      { memberConceptId: 'lab:Z00', memberOrder: 10, panelConceptId: 'lab:a00', relationship: 'contains', sourceId: 'source-a-lower', sourceLocator: 'pm:2' },
      { memberConceptId: 'lab:Z00', memberOrder: 2, panelConceptId: 'lab:a00', relationship: 'contains', sourceId: 'source-a-lower', sourceLocator: 'pm:b' },
      { memberConceptId: 'lab:Z00', memberOrder: 2, panelConceptId: 'lab:a00', relationship: 'contains', sourceId: 'source-a-lower', sourceLocator: 'pm:†' },
    ]

    const medicationProducts: Array<ReferenceMedicationProduct & { sourceId: string }> = [
      {
        approvalNumber: 'APP-2',
        brandName: null,
        code: 'DRUG-001',
        dosageForm: '片剂',
        genericName: '阿司匹林肠溶片',
        id: 'drug:001',
        manufacturer: '合成药厂',
        packageDescription: '30片/盒',
        sourceId: 'source-B-upper',
        sourceLocator: 'drug:2',
        status: 'active',
        strength: '100mg',
        system: 'urn:clinmesh:reference:nhsa-medication-product',
        version: '2026',
      },
      {
        approvalNumber: 'APP-1',
        brandName: '商品名',
        code: 'DRUG-†',
        dosageForm: '胶囊剂',
        genericName: '氯吡格雷',
        id: 'drug:†',
        manufacturer: '合成药厂',
        packageDescription: '7粒/盒',
        sourceId: 'source-B-upper',
        sourceLocator: 'drug:1',
        status: 'inactive',
        strength: '75mg',
        system: 'urn:clinmesh:reference:nhsa-medication-product',
        version: '2026',
      },
    ]

    const services: Array<ReferenceMedicalService & { sourceId: string }> = [
      {
        billingUnitCode: 'ITEM',
        categoryCode: 'LAB',
        code: 'SVC-B',
        display: '服务B',
        id: 'svc:B',
        sourceId: 'source-a-lower',
        sourceLocator: 'svc:2',
        status: 'active',
        system: 'urn:clinmesh:reference:nhc-medical-service',
        version: '2026',
      },
      {
        billingUnitCode: 'ITEM',
        categoryCode: 'LAB',
        code: 'SVC-a',
        display: '服务a',
        id: 'svc:a',
        sourceId: 'source-a-lower',
        sourceLocator: 'svc:1',
        status: 'active',
        system: 'urn:clinmesh:reference:nhc-medical-service',
        version: '2026',
      },
    ]

    const valueSetEntries: Array<ReferenceValueSetEntry & { sourceId: string }> = [
      {
        code: 'VS-01',
        display: '条目01',
        id: 'vs:01',
        sourceId: 'source-a-lower',
        sourceLocator: 'vs:2',
        status: 'active',
        system: 'urn:clinmesh:wst:test',
        valueSet: 'urn:clinmesh:wst:ValueSet:test',
        version: '2026',
      },
      {
        code: 'VS-†',
        display: '条目†',
        id: 'vs:†',
        sourceId: 'source-a-lower',
        sourceLocator: 'vs:1',
        status: 'active',
        system: 'urn:clinmesh:wst:test',
        valueSet: 'urn:clinmesh:wst:ValueSet:test',
        version: '2026',
      },
    ]

    const expected = referenceObjectContentHash({
      concepts,
      laboratoryDefinitions,
      laboratoryPanelMembers,
      laboratorySpecimens,
      laboratoryUnits,
      medicationProducts,
      release,
      services,
      sources,
      valueSetEntries,
    })

    // Force multi-chunk external merge with maxChunkRows = 2
    const actualExternalMerge = computeStreamingReleaseContentHash({
      concepts,
      laboratoryDefinitions,
      laboratoryPanelMembers,
      laboratorySpecimens,
      laboratoryUnits,
      medicationProducts,
      release,
      services,
      sources,
      valueSetEntries,
    }, { maxChunkRows: 2, tempDirectory })

    const actualInMemory = computeStreamingReleaseContentHash({
      concepts,
      laboratoryDefinitions,
      laboratoryPanelMembers,
      laboratorySpecimens,
      laboratoryUnits,
      medicationProducts,
      release,
      services,
      sources,
      valueSetEntries,
    }, { maxChunkRows: 1000, tempDirectory })

    expect(actualExternalMerge).toBe(expected)
    expect(actualInMemory).toBe(expected)
    // Verify temporary merge file was removed in finally
    expect(await readdir(tempDirectory)).toEqual([])
  })

  it('cleans up temporary merge files and closes iterators when an input stream throws mid-merge', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'clinmesh-canonical-hash-error-'))
    temporaryDirectories.push(tempDirectory)

    let iteratorClosed = false
    const failingConcepts: Iterable<ReferenceConcept & { sourceId: string }> = {
      [Symbol.iterator]() {
        let index = 0
        return {
          next() {
            index += 1
            if (index <= 5) {
              return {
                done: false,
                value: {
                  code: `C${index}`,
                  display: `概念 ${index}`,
                  domain: 'diagnosis',
                  id: `concept:${index}`,
                  sourceId: 's1',
                  sourceLocator: `row:${index}`,
                  status: 'active',
                  system: 'http://hl7.org/fhir/sid/icd-10',
                  version: '2026',
                },
              }
            }
            throw new Error('stream read failed after first spilled chunk')
          },
          return() {
            iteratorClosed = true
            return { done: true, value: undefined }
          },
        }
      },
    }

    expect(() => computeStreamingReleaseContentHash({
      concepts: failingConcepts,
      release: {
        createdAt: '2026-09-15T00:00:00.000Z',
        releaseId: 'failing-stream-release',
        schemaVersion: '1',
      },
      sources: [{
        acquisitionMethod: 'generated',
        artifactFormat: 'clinmesh-reference-v1',
        checksum: '3'.repeat(64),
        importDiagnostics: { acceptedCount: 5, rejectedCount: 0, warnings: [] },
        licenseId: 'CC0-1.0',
        recordCount: 5,
        retrievedAt: '2026-09-15T00:00:00.000Z',
        sourceId: 's1',
        sourceUrl: 'https://example.test/s1',
        upstreamVersion: '2026',
      }],
    }, { maxChunkRows: 2, tempDirectory })).toThrow('stream read failed after first spilled chunk')

    expect(iteratorClosed).toBe(true)
    expect(await readdir(tempDirectory)).toEqual([])
  })
})
