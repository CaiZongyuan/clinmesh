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

  it('rejects L1 fee, TAT and critical flags that disagree with the hospital catalog', async () => {
    const provider = new BuiltInScenarioGenerationProvider()
    const generated = await provider.generate(scenarioGenerationRequestSchema.parse({
      modules: ['type-2-diabetes'],
      name: '跨投影冲突病例',
      population: { age: { maximum: 40, minimum: 40 }, count: 1, gender: 'female' },
      providerId: 'builtin',
      seeds: { clinical: 99, population: 90 },
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    }))
    const patient = generated.content.patients[0]!
    const exactIndex = patient.investigations.findIndex(investigation => {
      const catalogItem = generated.content.catalog.investigations.find(
        item => item.id === investigation.catalogItemId,
      )
      return investigation.result.outcome === 'reported'
        && typeof investigation.result.value === 'number'
        && (catalogItem?.criticalMinimum !== undefined || catalogItem?.criticalMaximum !== undefined)
    })
    const exact = patient.investigations[exactIndex]!
    const catalogItem = generated.content.catalog.investigations.find(
      item => item.id === exact.catalogItemId,
    )!
    if (exact.result.outcome !== 'reported' || typeof exact.result.value !== 'number') {
      throw new Error('Expected one numeric exact investigation with critical thresholds')
    }
    const shouldBeCritical = (
      (catalogItem.criticalMinimum !== undefined && exact.result.value < catalogItem.criticalMinimum)
      || (catalogItem.criticalMaximum !== undefined && exact.result.value > catalogItem.criticalMaximum)
    )

    const diagnostics = validateScenarioDataset({
      ...generated.content,
      patients: [{
        ...patient,
        investigations: patient.investigations.map((investigation, index) => index === exactIndex
          ? {
              ...investigation,
              critical: !shouldBeCritical,
              feeFen: catalogItem.priceFen + 1,
              tatMinutes: catalogItem.tatMinutes + 1,
            }
          : investigation),
      }],
    })

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'INVESTIGATION_CRITICAL_THRESHOLD_CONFLICT',
        path: `patients[0].investigations[${exactIndex}].critical`,
      }),
      expect.objectContaining({
        code: 'INVESTIGATION_FEE_CONFLICT',
        path: `patients[0].investigations[${exactIndex}].feeFen`,
      }),
      expect.objectContaining({
        code: 'INVESTIGATION_TAT_CONFLICT',
        path: `patients[0].investigations[${exactIndex}].tatMinutes`,
      }),
    ]))
  })

  it('rejects duplicate runtime identifiers before installation', async () => {
    const provider = new BuiltInScenarioGenerationProvider()
    const generated = await provider.generate(scenarioGenerationRequestSchema.parse({
      modules: ['fever'],
      name: '重复标识病例',
      population: { age: { maximum: 40, minimum: 40 }, count: 1, gender: 'female' },
      providerId: 'builtin',
      seeds: { clinical: 122, population: 111 },
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    }))
    const patient = generated.content.patients[0]!
    const hiddenFact = generated.content.hiddenFacts[0]!
    const revealPolicy = generated.content.revealPolicies[0]!

    expect(validateScenarioDataset({
      ...generated.content,
      hiddenFacts: [hiddenFact, { ...hiddenFact }],
      patients: [patient, { ...patient }],
      revealPolicies: [revealPolicy, { ...revealPolicy }],
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'DUPLICATE_HIDDEN_FACT_CODE',
        path: 'hiddenFacts[1].code',
      }),
      expect.objectContaining({
        code: 'DUPLICATE_PATIENT_ID',
        path: 'patients[1].id',
      }),
      expect.objectContaining({
        code: 'DUPLICATE_REVEAL_POLICY_CODE',
        path: 'revealPolicies[1].code',
      }),
    ]))
  })

  it('rejects multiple exact results for the same patient catalog item', async () => {
    const provider = new BuiltInScenarioGenerationProvider()
    const generated = await provider.generate(scenarioGenerationRequestSchema.parse({
      modules: ['fever'],
      name: '重复精确检查病例',
      population: { age: { maximum: 40, minimum: 40 }, count: 1, gender: 'female' },
      providerId: 'builtin',
      seeds: { clinical: 188, population: 177 },
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    }))
    const patient = generated.content.patients[0]!
    const duplicateIndex = patient.investigations.length
    const duplicate = {
      ...patient.investigations[0]!,
      id: 'investigation-duplicate-catalog-item',
    }

    expect(validateScenarioDataset({
      ...generated.content,
      patients: [{
        ...patient,
        investigations: [...patient.investigations, duplicate],
      }],
    })).toContainEqual(expect.objectContaining({
      code: 'DUPLICATE_INVESTIGATION_CATALOG_ITEM',
      path: `patients[0].investigations[${duplicateIndex}].catalogItemId`,
      severity: 'error',
    }))
  })

  it('rejects an after-topic policy bound to a different patient than its Hidden Fact', async () => {
    const provider = new BuiltInScenarioGenerationProvider()
    const generated = await provider.generate(scenarioGenerationRequestSchema.parse({
      modules: ['fever'],
      name: '跨患者揭示病例',
      population: { age: { maximum: 40, minimum: 40 }, count: 1, gender: 'female' },
      providerId: 'builtin',
      seeds: { clinical: 144, population: 133 },
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    }))
    const firstPatient = generated.content.patients[0]!
    const secondPatient = { ...firstPatient, id: 'synthetic-patient-002', name: '合成患者乙' }
    const factCode = 'patient-one-topic-fact'

    expect(validateScenarioDataset({
      ...generated.content,
      hiddenFacts: [
        ...generated.content.hiddenFacts,
        { code: factCode, patientId: firstPatient.id, value: '只属于患者甲的事实' },
      ],
      patients: [firstPatient, secondPatient],
      revealPolicies: [
        ...generated.content.revealPolicies,
        {
          code: 'cross-patient-topic-policy',
          factCode,
          patientId: secondPatient.id,
          triggerCode: 'after-topic',
          triggerId: secondPatient.symptomResponses[0]!.id,
        },
      ],
    })).toContainEqual(expect.objectContaining({
      code: 'REVEAL_TOPIC_PATIENT_MISMATCH',
      path: `revealPolicies[${generated.content.revealPolicies.length}].patientId`,
      severity: 'error',
    }))
  })

  it('rejects ambiguous after-topic policies for the same patient topic', async () => {
    const provider = new BuiltInScenarioGenerationProvider()
    const generated = await provider.generate(scenarioGenerationRequestSchema.parse({
      modules: ['fever'],
      name: '重复问诊揭示病例',
      population: { age: { maximum: 40, minimum: 40 }, count: 1, gender: 'female' },
      providerId: 'builtin',
      seeds: { clinical: 166, population: 155 },
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    }))
    const patient = generated.content.patients[0]!
    const triggerId = patient.symptomResponses[0]!.id
    const factCode = 'ambiguous-topic-fact'
    const firstPolicyIndex = generated.content.revealPolicies.length

    expect(validateScenarioDataset({
      ...generated.content,
      hiddenFacts: [
        ...generated.content.hiddenFacts,
        { code: factCode, patientId: patient.id, value: '同一主题只能绑定一个事实' },
      ],
      revealPolicies: [
        ...generated.content.revealPolicies,
        {
          code: 'ambiguous-topic-policy-one',
          factCode,
          patientId: patient.id,
          triggerCode: 'after-topic',
          triggerId,
        },
        {
          code: 'ambiguous-topic-policy-two',
          factCode,
          patientId: patient.id,
          triggerCode: 'after-topic',
          triggerId,
        },
      ],
    })).toContainEqual(expect.objectContaining({
      code: 'DUPLICATE_REVEAL_TOPIC_POLICY',
      path: `revealPolicies[${firstPolicyIndex + 1}].triggerId`,
      severity: 'error',
    }))
  })

  it('rejects inverted clinical ranges and an L3 mean outside its sampling domain', async () => {
    const provider = new BuiltInScenarioGenerationProvider()
    const generated = await provider.generate(scenarioGenerationRequestSchema.parse({
      modules: ['type-2-diabetes'],
      name: '非法检查范围病例',
      population: { age: { maximum: 40, minimum: 40 }, count: 1, gender: 'female' },
      providerId: 'builtin',
      seeds: { clinical: 188, population: 177 },
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
            criticalMaximum: 4,
            criticalMinimum: 5,
            normalDistribution: {
              ...item.normalDistribution,
              maximum: 2,
              mean: 4,
              minimum: 3,
            },
            referenceRanges: [{
              ...item.referenceRanges[0]!,
              maximum: 1,
              minimum: 10,
            }, ...item.referenceRanges.slice(1)],
          }
        : item
    ))

    expect(validateScenarioDataset({
      ...generated.content,
      catalog: { ...generated.content.catalog, investigations },
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'INVESTIGATION_CRITICAL_RANGE_INVERTED',
        path: `catalog.investigations[${investigationIndex}].criticalMinimum`,
      }),
      expect.objectContaining({
        code: 'INVESTIGATION_L3_MEAN_OUTSIDE_RANGE',
        path: `catalog.investigations[${investigationIndex}].normalDistribution.mean`,
      }),
      expect.objectContaining({
        code: 'INVESTIGATION_L3_RANGE_INVERTED',
        path: `catalog.investigations[${investigationIndex}].normalDistribution.minimum`,
      }),
      expect.objectContaining({
        code: 'INVESTIGATION_REFERENCE_RANGE_INVERTED',
        path: `catalog.investigations[${investigationIndex}].referenceRanges[0].minimum`,
      }),
    ]))
  })
})
