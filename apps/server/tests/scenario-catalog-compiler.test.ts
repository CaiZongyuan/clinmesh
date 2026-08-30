import { describe, expect, it } from 'vitest'
import { createHospitalBaseline } from '../src/application/scenario-data/hospital-baseline.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'
import {
  syntheticNhcMedicalServiceSnapshot,
  syntheticWstValueSetSnapshot,
} from '../src/application/scenario-data/medical-service-snapshot.ts'
import { compileScenarioCatalog } from '../src/application/scenario-data/scenario-catalog-compiler.ts'

function fullBaseline() {
  return createHospitalBaseline(
    syntheticNhsaMedicationProductSnapshot,
    syntheticNhcMedicalServiceSnapshot,
    syntheticWstValueSetSnapshot,
  )
}

describe('Scenario catalog compiler', () => {
  it('compiles the hypertension catalog closure with transitive workflow dependencies', () => {
    const compiled = compileScenarioCatalog({
      baseline: fullBaseline(),
      modules: ['hypertension'],
    })

    expect(compiled.catalog.departments.map(item => item.id)).toEqual([
      'department-general-medicine',
      'department-laboratory',
    ])
    expect(compiled.catalog.diagnoses.map(item => item.id)).toEqual([
      'diagnosis-hypertension',
    ])
    expect(compiled.catalog.investigations.map(item => item.id)).toEqual([
      'lab-cbc',
      'lab-wbc',
      'lab-hemoglobin',
      'lab-rbc',
      'lab-mcv',
      'lab-hematocrit',
      'lab-creatinine',
      'lab-egfr',
    ])
    expect(compiled.catalog.medications.map(item => item.id)).toEqual([
      'medication-amlodipine',
    ])
    expect(compiled.catalog.services?.map(item => item.id)).toEqual([
      'hospital-service-cbc',
      'hospital-service-wbc',
      'hospital-service-hgb',
      'hospital-service-rbc',
      'hospital-service-mcv',
      'hospital-service-hct',
    ])
    expect(compiled.inventory.map(lot => lot.itemId)).toEqual([
      'medication-amlodipine',
    ])
    expect(compiled.report).toMatchObject({
      blockers: [],
      counts: {
        requirements: {
          criticalTruth: 2,
          explicitlyIgnored: expect.any(Number),
          historyOnly: expect.any(Number),
          workflowRequired: expect.any(Number),
        },
        resolutions: {
          ambiguous: 0,
          hospitalNotEnabled: expect.any(Number),
          mapped: expect.any(Number),
          missing: 0,
        },
      },
      supported: true,
    })
    expect(compiled.report.entries).toContainEqual(expect.objectContaining({
      generatedOccurrences: expect.any(Number),
      module: 'hypertension',
      requirement: 'critical-truth',
      source: expect.objectContaining({ code: '59621000' }),
      staticOccurrences: expect.any(Number),
      targetId: 'diagnosis-hypertension',
    }))
    const coveredSourceCodes = new Set(compiled.report.entries.flatMap(entry => (
      entry.source !== undefined && 'code' in entry.source ? [entry.source.code] : []
    )))
    expect(coveredSourceCodes.has('44054006')).toBe(false)
    expect(coveredSourceCodes.has('386661006')).toBe(false)
  })

  it('blocks supported promotion when a critical dependency is absent', () => {
    const baseline = fullBaseline()
    const compiled = compileScenarioCatalog({
      baseline: {
        ...baseline,
        catalog: {
          ...baseline.catalog,
          medications: baseline.catalog.medications.filter(item => (
            item.id !== 'medication-amlodipine'
          )),
        },
      },
      modules: ['hypertension'],
    })

    expect(compiled.report).toMatchObject({
      blockers: [{
        code: 'CRITICAL_DEPENDENCY_MISSING',
        module: 'hypertension',
        targetId: 'medication-amlodipine',
      }],
      supported: false,
    })
    expect(compiled.report.entries).toContainEqual(expect.objectContaining({
      module: 'hypertension',
      requirement: 'critical-truth',
      resolution: 'hospital-not-enabled',
      targetId: 'medication-amlodipine',
    }))
  })

  it('blocks supported promotion when a required workflow dependency is absent', () => {
    const baseline = fullBaseline()
    const compiled = compileScenarioCatalog({
      baseline: {
        ...baseline,
        catalog: {
          ...baseline.catalog,
          investigations: baseline.catalog.investigations.filter(item => item.id !== 'lab-cbc'),
        },
      },
      modules: ['hypertension'],
    })

    expect(compiled.report).toMatchObject({
      blockers: [{
        code: 'WORKFLOW_DEPENDENCY_MISSING',
        module: 'hypertension',
        targetId: 'lab-cbc',
      }],
      supported: false,
    })

    const missingComponent = compileScenarioCatalog({
      baseline: {
        ...baseline,
        catalog: {
          ...baseline.catalog,
          investigations: baseline.catalog.investigations.filter(item => item.id !== 'lab-wbc'),
        },
      },
      modules: ['hypertension'],
    })
    expect(missingComponent.report).toMatchObject({
      blockers: expect.arrayContaining([{
        code: 'WORKFLOW_DEPENDENCY_MISSING',
        module: 'hypertension',
        targetId: 'lab-wbc',
      }]),
      supported: false,
    })
    expect(missingComponent.report.entries.filter(entry => entry.targetId === 'lab-wbc'))
      .toHaveLength(1)
  })

  it('classifies generated UCUM units against the enabled unit package', () => {
    const compiled = compileScenarioCatalog({
      baseline: fullBaseline(),
      modules: ['type-2-diabetes'],
    })

    expect(compiled.report.entries).toContainEqual(expect.objectContaining({
      generatedOccurrences: expect.any(Number),
      requirement: 'history-only',
      resolution: 'mapped',
      source: {
        code: '%',
        display: '%',
        system: 'http://unitsofmeasure.org',
      },
    }))
  })
})
