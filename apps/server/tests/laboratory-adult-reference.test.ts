import { laboratoryServiceSnapshotSchema } from '@clinmesh/contracts/his'
import { describe, expect, it } from 'vitest'
import {
  AdultReferenceApplicabilityError,
  generateAdultReferenceResult,
  selectAdultReferenceRule,
} from '../src/application/laboratory-adult-reference.ts'

const service = laboratoryServiceSnapshotSchema.parse({
  allowedIndicationCodes: ['clinical-evaluation'],
  componentServiceIds: [],
  doctorOrderable: true,
  executingDepartmentId: 'department-laboratory',
  id: 'hospital-laboratory-service-adult-reference-test',
  localCode: 'CM-LAB-ADULT-REFERENCE-TEST',
  nameZh: '合成成人参考规则测试',
  priceFen: 0,
  referenceConcept: {
    code: 'CN-LAB-ADULT-TEST',
    display: '合成成人参考规则测试',
    id: 'laboratory-panel-cn:2026-09-01:CN-LAB-ADULT-TEST',
    sourceLocator: 'synthetic:panel',
    system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-panel-cn',
    version: '2026-09-01',
  },
  referenceReleaseId: 'clinmesh-reference-test',
  reportDefinition: {
    conclusionTemplate: '合成成人参考规则测试。',
    results: [{
      adultReferenceRules: [{
        high: 5.8,
        low: 4.3,
        notes: '成年男性',
        referenceKind: 'range',
        sex: 'male',
        simulationHigh: 5.8,
        simulationLow: 4.3,
        sourceLocation: '表 1',
        sourceStandard: 'Synthetic Standard',
        sourceType: 'national-standard',
        sourceVersion: '1',
      }, {
        high: 5.1,
        low: 3.8,
        notes: '成年女性',
        referenceKind: 'range',
        sex: 'female',
        simulationHigh: 5.1,
        simulationLow: 3.8,
        sourceLocation: '表 1',
        sourceStandard: 'Synthetic Standard',
        sourceType: 'national-standard',
        sourceVersion: '1',
      }],
      alternateCodings: [],
      healthyStrategy: 'uniform',
      precision: 1,
      referenceConcept: {
        code: '0100201A',
        display: '红细胞计数',
        id: 'wst-886:2026:0100201A',
        sourceLocator: 'synthetic:test',
        system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026',
        version: '2026',
      },
      referenceRange: { text: '按成人适用规则' },
      unit: { code: '10*12/L', display: '×10^12/L', system: 'http://unitsofmeasure.org' },
      valueType: 'quantity',
    }],
  },
  serviceKind: 'laboratory',
  sourceDataset: { datasetId: 'laboratory-cn', releaseId: 'laboratory-cn@fixture.r1' },
  specimen: { code: 'CN-SP-BLOOD', display: '全血' },
  tatMinutes: 180,
  version: 1,
})

const definition = service.reportDefinition.results[0]!

describe('adult laboratory reference policy', () => {
  it('uses Virtual Time for the adult boundary and exact sex rule', () => {
    expect(() => selectAdultReferenceRule(
      definition,
      { birthDate: '2008-09-03', gender: 'female' },
      '2026-09-02T09:00:00.000Z',
    )).toThrow(AdultReferenceApplicabilityError)
    expect(selectAdultReferenceRule(
      definition,
      { birthDate: '2008-09-02', gender: 'female' },
      '2026-09-02T09:00:00.000Z',
    )).toMatchObject({ high: 5.1, low: 3.8, sex: 'female' })
    expect(selectAdultReferenceRule(
      definition,
      { birthDate: '2008-09-02', gender: 'female' },
      '2026-09-02T00:30:00.000+08:00',
    )).toMatchObject({ high: 5.1, low: 3.8, sex: 'female' })
  })

  it('allows other or unknown gender only through an all rule', () => {
    expect(() => selectAdultReferenceRule(
      definition,
      { birthDate: '1970-01-01', gender: 'unknown' },
      '2026-09-02T09:00:00.000Z',
    )).toThrow('administrative gender')
    const withAll = {
      ...definition,
      adultReferenceRules: [{ ...definition.adultReferenceRules![0]!, sex: 'all' as const }],
    }
    expect(selectAdultReferenceRule(
      withAll,
      { birthDate: '1970-01-01', gender: 'other' },
      '2026-09-02T09:00:00.000Z',
    ).sex).toBe('all')
  })

  it('generates deterministic precision-bounded values from explicit simulation bounds', () => {
    const rule = selectAdultReferenceRule(
      definition,
      { birthDate: '1970-01-01', gender: 'female' },
      '2026-09-02T09:00:00.000Z',
    )
    const first = generateAdultReferenceResult({
      definition,
      inputHash: '1'.repeat(64),
      rule,
      serviceVersion: 1,
    })
    const replay = generateAdultReferenceResult({
      definition,
      inputHash: '1'.repeat(64),
      rule,
      serviceVersion: 1,
    })
    const changed = generateAdultReferenceResult({
      definition,
      inputHash: '2'.repeat(64),
      rule,
      serviceVersion: 1,
    })
    expect(replay).toEqual(first)
    for (const result of [first, changed]) {
      expect(result.value).toBeGreaterThanOrEqual(3.8)
      expect(result.value).toBeLessThanOrEqual(5.1)
      expect(Number.isInteger(Number(result.value) * 10)).toBe(true)
    }
  })

  it('keeps one-sided clinical limits separate from generation and preserves fixed strings', () => {
    const upperRule = {
      ...definition.adultReferenceRules![0]!,
      high: 8,
      low: undefined,
      referenceKind: 'upper-bound' as const,
      sex: 'all' as const,
      simulationHigh: 7.9,
      simulationLow: 0.1,
    }
    expect(generateAdultReferenceResult({
      definition: { ...definition, adultReferenceRules: [upperRule] },
      inputHash: '3'.repeat(64),
      rule: upperRule,
      serviceVersion: 1,
    })).toMatchObject({
      referenceRange: { high: 8, text: '≤8 ×10^12/L' },
      value: expect.any(Number),
    })
    const fixedRule = {
      ...upperRule,
      high: undefined,
      normalValue: '5.0～8.0',
      referenceKind: 'ordinal' as const,
      simulationHigh: undefined,
      simulationLow: undefined,
    }
    expect(generateAdultReferenceResult({
      definition: {
        ...definition,
        adultReferenceRules: [fixedRule],
        healthyStrategy: 'fixed-normal',
        precision: 0,
        unit: undefined,
        valueType: 'string',
      },
      inputHash: '4'.repeat(64),
      rule: fixedRule,
      serviceVersion: 1,
    })).toMatchObject({ referenceRange: { text: '5.0～8.0' }, value: '5.0～8.0' })
  })
})
