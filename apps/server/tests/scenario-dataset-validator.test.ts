import { scenarioGenerationRequestSchema } from '@clinmesh/contracts/scenario'
import { describe, expect, it } from 'vitest'
import { validateScenarioDataset } from '../src/application/scenario-data/scenario-dataset-validator.ts'
import { BuiltInScenarioGenerationProvider } from '../src/infrastructure/scenario-generation/builtin-provider.ts'

describe('Scenario Dataset diagnostics', () => {
  it('reports mapping, reference, chronology, catalog and business-rule errors with stable paths', async () => {
    const provider = new BuiltInScenarioGenerationProvider()
    const generated = await provider.generate(scenarioGenerationRequestSchema.parse({
      modules: ['fever'],
      name: '待诊断病例',
      population: { age: { maximum: 40, minimum: 40 }, count: 1, gender: 'female' },
      providerId: 'builtin',
      seeds: { clinical: 22, population: 11 },
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    }))
    const patient = generated.content.patients[0]!
    const invalidContent = {
      ...generated.content,
      catalog: {
        ...generated.content.catalog,
        investigations: generated.content.catalog.investigations.map((item, index) => index === 0
          ? { ...item, componentItemIds: ['missing-investigation'] }
          : item),
      },
      inventory: [{ ...generated.content.inventory[0]!, itemId: 'missing-medication' }],
      patients: [{
        ...patient,
        fhirHistory: [...patient.fhirHistory, {
          clinicalStatus: 'active',
          code: { display: '悬空就诊诊断' },
          encounterId: 'history-encounter-missing',
          id: 'history-condition-dangling',
          resourceType: 'Condition' as const,
        }],
        investigations: [{
          ...patient.investigations[0]!,
          result: { message: '错误标记为本院未开展', outcome: 'catalog-boundary' as const },
          sourceLevel: 'L2' as const,
        }],
        longitudinalHistory: [{
          ...patient.longitudinalHistory[0]!,
          endedAt: '2025-01-01T00:00:00Z',
          mappedCode: null,
          occurredAt: '2026-01-01T00:00:00Z',
        }, ...patient.longitudinalHistory.slice(1)],
        physiologyBaseline: {
          ...patient.physiologyBaseline,
          generators: [...patient.physiologyBaseline.generators, {
            dependencies: ['missing-generator'],
            formula: 'bmi' as const,
            id: 'invalid-derived-generator',
            kind: 'derived' as const,
            source: 'scenario:invalid-test',
            unit: 'kg/m²',
          }],
        },
      }],
    }

    expect(validateScenarioDataset(invalidContent)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'CATALOG_REFERENCE_MISSING', path: 'inventory[0].itemId' }),
      expect.objectContaining({ code: 'CLINICAL_CODE_UNMAPPED', path: 'patients[0].longitudinalHistory[0].mappedCode' }),
      expect.objectContaining({ code: 'CLINICAL_TIME_INVERTED', path: 'patients[0].longitudinalHistory[0].endedAt' }),
      expect.objectContaining({ code: 'FHIR_HISTORY_REFERENCE_MISSING', path: 'patients[0].fhirHistory[3].encounterId' }),
      expect.objectContaining({ code: 'INVESTIGATION_CATALOG_CONFLICT', path: 'patients[0].investigations[0].result.outcome' }),
      expect.objectContaining({ code: 'INVESTIGATION_EXACT_SOURCE_INVALID', path: 'patients[0].investigations[0].sourceLevel' }),
      expect.objectContaining({ code: 'INVESTIGATION_COMPONENT_REFERENCE_MISSING', path: 'catalog.investigations[0].componentItemIds[0]' }),
      expect.objectContaining({ code: 'PHYSIOLOGY_DEPENDENCY_MISSING', path: expect.stringContaining('dependencies[0]') }),
    ]))
  })

  it('rejects cyclic investigation panels and physiology derivations before installation', async () => {
    const provider = new BuiltInScenarioGenerationProvider()
    const generated = await provider.generate(scenarioGenerationRequestSchema.parse({
      modules: ['fever'],
      name: '循环依赖病例',
      population: { age: { maximum: 40, minimum: 40 }, count: 1, gender: 'female' },
      providerId: 'builtin',
      seeds: { clinical: 44, population: 33 },
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    }))
    const patient = generated.content.patients[0]!
    const investigations = generated.content.catalog.investigations.map((item, index) => index === 0
      ? { ...item, componentItemIds: [item.id] }
      : item)
    const generators = [...patient.physiologyBaseline.generators, {
      dependencies: ['derived-cycle-b'],
      formula: 'bmi' as const,
      id: 'derived-cycle-a',
      kind: 'derived' as const,
      source: 'scenario:cycle-test',
      unit: 'kg/m²',
    }, {
      dependencies: ['derived-cycle-a'],
      formula: 'bmi' as const,
      id: 'derived-cycle-b',
      kind: 'derived' as const,
      source: 'scenario:cycle-test',
      unit: 'kg/m²',
    }]

    expect(validateScenarioDataset({
      ...generated.content,
      catalog: { ...generated.content.catalog, investigations },
      patients: [{
        ...patient,
        physiologyBaseline: { ...patient.physiologyBaseline, generators },
      }],
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'INVESTIGATION_COMPONENT_CYCLE',
        path: 'catalog.investigations[0].componentItemIds[0]',
      }),
      expect.objectContaining({
        code: 'PHYSIOLOGY_DEPENDENCY_CYCLE',
        path: expect.stringContaining('.dependencies[0]'),
      }),
    ]))
  })

  it('rejects an L3 sampling domain outside its numeric reference range', async () => {
    const provider = new BuiltInScenarioGenerationProvider()
    const generated = await provider.generate(scenarioGenerationRequestSchema.parse({
      modules: ['type-2-diabetes'],
      name: 'L3 参考范围冲突病例',
      population: { age: { maximum: 40, minimum: 40 }, count: 1, gender: 'female' },
      providerId: 'builtin',
      seeds: { clinical: 66, population: 55 },
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    }))
    const investigationIndex = generated.content.catalog.investigations.findIndex(
      item => item.id === 'lab-tsh',
    )
    const investigations = generated.content.catalog.investigations.map((item, index) => (
      index === investigationIndex && item.normalDistribution !== undefined
        ? {
            ...item,
            normalDistribution: { ...item.normalDistribution, minimum: -1 },
          }
        : item
    ))

    expect(validateScenarioDataset({
      ...generated.content,
      catalog: { ...generated.content.catalog, investigations },
    })).toContainEqual(expect.objectContaining({
      code: 'INVESTIGATION_L3_REFERENCE_CONFLICT',
      path: `catalog.investigations[${investigationIndex}].normalDistribution`,
      severity: 'error',
    }))
  })

  it('rejects a catalog physiology binding missing from a patient baseline', async () => {
    const provider = new BuiltInScenarioGenerationProvider()
    const generated = await provider.generate(scenarioGenerationRequestSchema.parse({
      modules: ['type-2-diabetes'],
      name: '生理引用冲突病例',
      population: { age: { maximum: 40, minimum: 40 }, count: 1, gender: 'female' },
      providerId: 'builtin',
      seeds: { clinical: 88, population: 77 },
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    }))
    const investigationIndex = generated.content.catalog.investigations.findIndex(
      item => item.id === 'lab-tsh',
    )
    const investigations = generated.content.catalog.investigations.map((item, index) => (
      index === investigationIndex
        ? { ...item, physiologyGeneratorId: 'missing-physiology-generator' }
        : item
    ))

    expect(validateScenarioDataset({
      ...generated.content,
      catalog: { ...generated.content.catalog, investigations },
    })).toContainEqual(expect.objectContaining({
      code: 'PHYSIOLOGY_GENERATOR_REFERENCE_MISSING',
      path: `catalog.investigations[${investigationIndex}].physiologyGeneratorId`,
      severity: 'error',
    }))
  })
})
