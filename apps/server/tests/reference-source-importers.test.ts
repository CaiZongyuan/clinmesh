import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  parseLoincCsvReferenceArtifact,
  parseNhsaDiagnosisCsvReferenceArtifact,
  parseNhsaMedicationProductCsvArtifact,
  parseUcumXmlReferenceArtifact,
} from '../src/infrastructure/reference-data/reference-source-importers.ts'
import { createHospitalBaseline } from '../src/application/scenario-data/hospital-baseline.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'

const fixture = (name: string) => fileURLToPath(
  new URL(`./fixtures/reference-data/${name}`, import.meta.url),
)

describe('Reference Data source importers', () => {
  it('converts the synthetic LOINC 2.83 CSV shape into strict reference concepts', async () => {
    const artifact = parseLoincCsvReferenceArtifact({
      content: await readFile(fixture('synthetic-loinc-2.83-shape.csv'), 'utf8'),
      version: '2.83',
    })

    expect(artifact.schemaVersion).toBe('1')
    expect(artifact.concepts[0]).toEqual({
      code: '90001-1',
      display: 'Synthetic laboratory concept alpha',
      domain: 'laboratory',
      id: 'loinc:2.83:90001-1',
      sourceLocator: 'LoincTableCore.csv:2',
      status: 'active',
      system: 'http://loinc.org',
      version: '2.83',
    })
    expect(artifact.concepts.map(concept => concept.code)).toEqual([
      '90001-1',
      '90002-2',
      '90003-3',
    ])
  })

  it('converts the synthetic UCUM 2.2 XML shape without treating display as code', async () => {
    const artifact = parseUcumXmlReferenceArtifact({
      content: await readFile(fixture('synthetic-ucum-2.2-shape.xml'), 'utf8'),
      version: '2.2',
    })

    expect(artifact.concepts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: '{clinmesh_synthetic_a}',
        display: 'synthetic-a',
        domain: 'unit',
        id: 'ucum:2.2:{clinmesh_synthetic_a}',
        sourceLocator: 'ucum-essence.xml:unit[1]',
        system: 'http://unitsofmeasure.org',
        version: '2.2',
      }),
      expect.objectContaining({ code: '{clinmesh_synthetic_b}', display: 'synthetic-b' }),
      expect.objectContaining({ code: '{clinmesh_synthetic_c}', display: 'synthetic-c' }),
    ]))
    expect(artifact.concepts).toHaveLength(3)
  })

  it('converts the synthetic NHSA diagnosis CSV shape with version, status and source rows', async () => {
    const artifact = parseNhsaDiagnosisCsvReferenceArtifact({
      content: await readFile(fixture('synthetic-nhsa-diagnosis-shape.csv'), 'utf8'),
      version: 'nhsa-diagnosis-2026-08-07',
    })

    expect(artifact.concepts).toEqual([{
      code: 'CM-DX-A',
      display: 'Synthetic diagnosis alpha',
      domain: 'diagnosis',
      id: 'nhsa-diagnosis:nhsa-diagnosis-2026-08-07:CM-DX-A',
      sourceLocator: 'nhsa-diagnosis.csv:2',
      status: 'active',
      system: 'urn:clinmesh:reference:nhsa-diagnosis',
      version: 'nhsa-diagnosis-2026-08-07',
    }, {
      code: 'CM-DX-B',
      display: 'Synthetic diagnosis beta',
      domain: 'diagnosis',
      id: 'nhsa-diagnosis:nhsa-diagnosis-2026-08-07:CM-DX-B',
      sourceLocator: 'nhsa-diagnosis.csv:3',
      status: 'inactive',
      system: 'urn:clinmesh:reference:nhsa-diagnosis',
      version: 'nhsa-diagnosis-2026-08-07',
    }])
  })

  it('preserves every NHSA medication product field without turning a product into a concept', async () => {
    const artifact = parseNhsaMedicationProductCsvArtifact({
      content: await readFile(fixture('synthetic-nhsa-medication-products.csv'), 'utf8'),
      version: 'nhsa-medication-products-2026-08-07',
    })

    expect(artifact.concepts).toEqual([])
    expect(artifact.medicationProducts).toEqual([{
      approvalNumber: 'CM-APPROVAL-ACETAMINOPHEN',
      brandName: null,
      code: 'CM-NHSA-PRODUCT-ACETAMINOPHEN',
      dosageForm: '片剂',
      genericName: '对乙酰氨基酚片',
      id: 'nhsa-medication-product:nhsa-medication-products-2026-08-07:CM-NHSA-PRODUCT-ACETAMINOPHEN',
      manufacturer: '仁和仿真制药一厂',
      packageDescription: '20片/盒',
      sourceLocator: 'nhsa-medication-products.csv:2',
      status: 'active',
      strength: '500 mg',
      system: 'urn:clinmesh:reference:nhsa-medication-product',
      version: 'nhsa-medication-products-2026-08-07',
    }, expect.objectContaining({
      brandName: null,
      code: 'CM-NHSA-PRODUCT-METFORMIN',
      status: 'active',
    }), expect.objectContaining({ code: 'CM-NHSA-PRODUCT-AMLODIPINE' })])
    expect(artifact.medicationProducts).toEqual(syntheticNhsaMedicationProductSnapshot)
    const hospitalBaseline = createHospitalBaseline(artifact.medicationProducts)
    expect(hospitalBaseline.catalog.medications.map(medication => medication.product.id)).toEqual(
      artifact.medicationProducts.map(product => product.id),
    )
    expect(() => createHospitalBaseline(artifact.medicationProducts.map(product => (
      product.code === 'CM-NHSA-PRODUCT-METFORMIN'
        ? { ...product, status: 'inactive' as const }
        : product
    )))).toThrow('is not active')
  })

  it('rejects malformed rows and duplicate source coding', () => {
    expect(() => parseLoincCsvReferenceArtifact({
      content: 'LOINC_NUM,LONG_COMMON_NAME\n8310-5,Body temperature\n',
      version: '2.83',
    })).toThrow()
    expect(() => parseLoincCsvReferenceArtifact({
      content: 'LOINC_NUM,LONG_COMMON_NAME,STATUS\n8310-5,Body temperature,ACTIVE\n8310-5,Other,ACTIVE\n',
      version: '2.83',
    })).toThrow('repeated')
  })
})
