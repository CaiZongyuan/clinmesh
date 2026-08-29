import {
  referenceDataReleaseListSchema,
  referenceMedicationProductSchema,
  type ReferenceConcept,
  type ReferenceDataReleaseList,
  type ReferenceMedicalService,
  type ReferenceMedicationProduct,
  type ReferenceValueSetEntry,
} from '@clinmesh/contracts/reference-data'
import { describe, expect, it } from 'vitest'
import {
  createReferenceHospitalSelection,
  parseReferenceHospitalSelection,
} from '../src/application/reference-hospital-selection.ts'
import {
  ReferenceDataService,
  type ReferenceDataReader,
} from '../src/application/reference-data-service.ts'
import { createHospitalBaseline } from '../src/application/scenario-data/hospital-baseline.ts'
import { laboratoryServiceCodings } from '../src/application/workflow-service.ts'

const releaseId = 'clinmesh-cn-health-synthetic-selection-source'
const productSystem = 'urn:clinmesh:reference:nhsa-medication-product'
const diagnosisSystem = 'urn:clinmesh:reference:nhsa-diagnosis'

function product(code: string, genericName: string, strength: string): ReferenceMedicationProduct {
  return referenceMedicationProductSchema.parse({
    approvalNumber: `TEST-APPROVAL-${code}`,
    brandName: null,
    code,
    dosageForm: '片剂',
    genericName,
    id: `nhsa-medication-product:2026-01-09:${code}`,
    manufacturer: '合成映射验证制药厂',
    packageDescription: '铝塑；20片/盒',
    sourceLocator: `cn-health:drug:${code}`,
    status: 'active',
    strength,
    system: productSystem,
    version: '2026-01-09',
  })
}

const selectedProducts = [
  product('X-ACETAMINOPHEN', '对乙酰氨基酚片', '500mg'),
  product('X-METFORMIN', '盐酸二甲双胍片', '500mg'),
  product('X-AMLODIPINE', '苯磺酸氨氯地平片', '5mg'),
]

const selectedDiagnoses: ReferenceConcept[] = [{
  code: 'R50.900',
  display: '发热',
  domain: 'diagnosis',
  id: 'nhsa-diagnosis:2022:R50.900',
  sourceLocator: 'cn-health:diagnosis:2',
  status: 'active',
  system: diagnosisSystem,
  version: '2022',
}, {
  code: '8310-5',
  display: '体温',
  domain: 'laboratory',
  id: 'loinc:2.83:8310-5',
  sourceLocator: 'cn-health:loinc:8310-5',
  status: 'active',
  system: 'http://loinc.org',
  version: '2.83',
}]

const releases = referenceDataReleaseListSchema.parse({
  items: [{
    conceptCount: 37_294,
    contentHash: 'a'.repeat(64),
    createdAt: '2026-08-30T00:00:00.000+08:00',
    medicationProductCount: 269_110,
    releaseId,
    schemaVersion: '1',
    serviceCount: 0,
    sourceCount: 2,
    sources: [{
      acquisitionMethod: 'manual-download',
      artifactFormat: 'cn-health-candidate',
      candidate: {
        canonicalSha256: 'b'.repeat(64),
        datasetId: 'nhc-icd10-clinical',
        datasetSchemaVersion: 1,
        recordCount: 37_294,
        releaseId: 'nhc-icd10-clinical@2022.r3',
        sourceVersion: '2022',
        sqliteSha256: 'c'.repeat(64),
        sqliteSizeBytes: 1,
      },
      checksum: 'd'.repeat(64),
      importDiagnostics: { acceptedCount: 37_294, rejectedCount: 0, warnings: [] },
      licenseId: 'LicenseRef-Source-Terms',
      recordCount: 37_294,
      retrievedAt: '2026-08-30T00:00:00.000+08:00',
      sourceId: 'cn-health-diagnosis',
      sourceUrl: 'https://example.test/cn-health',
      upstreamVersion: 'nhc-icd10-clinical@2022.r3',
    }, {
      acquisitionMethod: 'manual-download',
      artifactFormat: 'cn-health-candidate',
      candidate: {
        canonicalSha256: 'e'.repeat(64),
        datasetId: 'nhsa-drugs',
        datasetSchemaVersion: 1,
        recordCount: 269_110,
        releaseId: 'nhsa-drugs@2026-01-09.r3',
        sourceVersion: '2026-01-09',
        sqliteSha256: 'f'.repeat(64),
        sqliteSizeBytes: 1,
      },
      checksum: '1'.repeat(64),
      importDiagnostics: { acceptedCount: 269_110, rejectedCount: 0, warnings: [] },
      licenseId: 'LicenseRef-Source-Terms',
      recordCount: 269_110,
      retrievedAt: '2026-08-30T00:00:00.000+08:00',
      sourceId: 'cn-health-medications',
      sourceUrl: 'https://example.test/cn-health',
      upstreamVersion: 'nhsa-drugs@2026-01-09.r3',
    }],
    status: 'published',
    valueSetEntryCount: 0,
  }],
})

class SelectionReader implements ReferenceDataReader {
  readonly requestedConcepts: string[] = []
  readonly requestedProducts: string[] = []

  concepts(_releaseId: string, codings: readonly { code: string }[]): ReferenceConcept[] {
    this.requestedConcepts.push(...codings.map(coding => coding.code))
    return selectedDiagnoses.filter(concept => this.requestedConcepts.includes(concept.code))
  }

  list(): ReferenceDataReleaseList {
    return releases
  }

  medicalServices(): ReferenceMedicalService[] {
    return []
  }

  medicationProducts(
    _releaseId: string,
    codings?: readonly { code: string }[],
  ): ReferenceMedicationProduct[] {
    this.requestedProducts.push(...(codings ?? []).map(coding => coding.code))
    return selectedProducts.filter(product => this.requestedProducts.includes(product.code))
  }

  valueSetEntries(): ReferenceValueSetEntry[] {
    return []
  }
}

const selection = createReferenceHospitalSelection({
  bindings: [{
    catalogItemId: 'diagnosis-fever',
    coding: { code: 'R50.900', system: diagnosisSystem, version: '2022' },
    kind: 'diagnosis',
  }, {
    catalogItemId: 'lab-body-temperature',
    coding: { code: '8310-5', system: 'http://loinc.org', version: '2.83' },
    kind: 'laboratory',
  }, {
    catalogItemId: 'medication-acetaminophen',
    coding: { code: 'X-ACETAMINOPHEN', system: productSystem, version: '2026-01-09' },
    kind: 'medication-product',
  }, {
    catalogItemId: 'medication-metformin',
    coding: { code: 'X-METFORMIN', system: productSystem, version: '2026-01-09' },
    kind: 'medication-product',
  }, {
    catalogItemId: 'medication-amlodipine',
    coding: { code: 'X-AMLODIPINE', system: productSystem, version: '2026-01-09' },
    kind: 'medication-product',
  }],
  referenceReleaseId: releaseId,
  schemaVersion: '1',
  selectionId: 'synthetic-cn-health-selection',
  version: '1',
})

describe('Hospital Reference selection', () => {
  it('rejects a selection whose declared content hash has drifted', () => {
    expect(() => parseReferenceHospitalSelection({
      ...selection,
      contentHash: 'f'.repeat(64),
    })).toThrow('content hash')
    const { contentHash: _contentHash, ...payload } = selection
    expect(parseReferenceHospitalSelection(payload)).toEqual(selection)
  })

  it('selects only exact Candidate rows and composes explicit support provenance', () => {
    const reader = new SelectionReader()
    const service = new ReferenceDataService(reader, selection)

    const selected = service.hospitalReferenceSelection()
    const baseline = createHospitalBaseline(
      selected.products,
      selected.services,
      selected.valueSetEntries,
      selected.bindings,
      selected.concepts,
    )

    expect(reader.requestedConcepts).toEqual(['R50.900', '8310-5'])
    expect(reader.requestedProducts).toEqual([
      'X-ACETAMINOPHEN',
      'X-METFORMIN',
      'X-AMLODIPINE',
    ])
    expect(selected.products).toHaveLength(3)
    expect(selected.services.length).toBeGreaterThan(0)
    expect(selected.valueSetEntries.length).toBeGreaterThan(0)
    expect(selected.release).toMatchObject({
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      medicationProductCount: 3,
      releaseId: 'reference-selection:synthetic-cn-health-selection@1',
      serviceCount: selected.services.length,
      valueSetEntryCount: selected.valueSetEntries.length,
    })
    expect(baseline.catalog.medications.map(item => item.product.code)).toEqual([
      'X-ACETAMINOPHEN',
      'X-METFORMIN',
      'X-AMLODIPINE',
    ])
    expect(baseline.catalog.diagnoses.find(item => item.id === 'diagnosis-fever'))
      .toMatchObject({
        referenceConcept: {
          code: 'R50.900',
          display: '发热',
          system: diagnosisSystem,
          version: '2022',
        },
      })
    expect(baseline.catalog.investigations.find(item => item.id === 'lab-body-temperature'))
      .toMatchObject({
        referenceConcept: {
          code: '8310-5',
          display: '体温',
          system: 'http://loinc.org',
          version: '2.83',
        },
      })
    expect(laboratoryServiceCodings(
      { code: 'BODY-TEMP', name_zh: '体温' },
      {
        allowedIndicationCodes: ['fever'],
        contraindicatedAllergyCodes: [],
        referenceConcept: baseline.catalog.investigations.find(
          item => item.id === 'lab-body-temperature',
        )?.referenceConcept,
      },
    )).toEqual([{
      code: 'BODY-TEMP',
      display: '体温',
      system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-service',
    }, {
      code: '8310-5',
      display: '体温',
      system: 'http://loinc.org',
      version: '2.83',
    }])
    expect(baseline.catalog.medications.map(item => item.regulatoryVerification)).toEqual(
      Array.from({ length: 3 }, () => expect.objectContaining({
        result: 'source-record',
        selection: {
          contentHash: selection.contentHash,
          selectionId: selection.selectionId,
          version: selection.version,
        },
        source: 'cn-health-candidate',
      })),
    )
    expect(service.provenance()).toEqual({
      contentHash: selected.release.contentHash,
      releaseId: selected.release.releaseId,
    })
  })

  it('fails closed when an exact binding target is unavailable', () => {
    const reader = new SelectionReader()
    const missing = createReferenceHospitalSelection({
      bindings: selection.bindings.map(binding => (
        binding.catalogItemId === 'medication-metformin'
          ? { ...binding, coding: { ...binding.coding, code: 'MISSING' } }
          : binding
      )),
      referenceReleaseId: selection.referenceReleaseId,
      schemaVersion: selection.schemaVersion,
      selectionId: selection.selectionId,
      version: selection.version,
    })

    expect(() => new ReferenceDataService(reader, missing).hospitalReferenceSelection())
      .toThrow('medication-metformin')
  })
})
