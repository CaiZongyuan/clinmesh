import { describe, expect, it } from 'vitest'
import {
  latestTargetHistoryStart,
  scenarioGenerationRequestSchema,
  scenarioInvestigationCatalogItemSchema,
  scenarioInvestigationResultSchema,
  scenarioMedicationCatalogItemSchema,
  scenarioPhysiologyGeneratorSchema,
  scenarioUcumUnitSchema,
  syntheaKeepCriteriaSchema,
} from '../src/scenario.ts'

const request = {
  modules: ['fever'],
  name: '合成患者批次',
  population: {
    age: { maximum: 80, minimum: 18 },
    count: 10,
    gender: 'any',
  },
  providerId: 'synthea',
  seeds: { clinical: 7331, population: 4242 },
  timeRange: { end: '2026-08-01', start: '2011-08-01' },
  timeZone: 'Asia/Shanghai',
} as const

describe('Scenario generation request', () => {
  it('limits one generation batch to ten patients', () => {
    expect(scenarioGenerationRequestSchema.safeParse(request).success).toBe(true)
    expect(scenarioGenerationRequestSchema.safeParse({
      ...request,
      population: { ...request.population, count: 11 },
    }).success).toBe(false)
  })

  it.each([
    { end: '2026-08-01', expected: '1981-08-01', years: 45 },
    { end: '2024-02-29', expected: '1979-02-28', years: 45 },
    { end: '2024-02-29', expected: '2020-02-29', years: 4 },
    { end: '2000-02-29', expected: '1900-02-28', years: 100 },
    { end: '2080-02-29', expected: '2000-02-29', years: 80 },
  ])('keeps the history cutoff valid for $end minus $years years', ({ end, expected, years }) => {
    const start = latestTargetHistoryStart(end, years)

    expect(start).toBe(expected)
    expect(scenarioGenerationRequestSchema.safeParse({ ...request, timeRange: { end, start } }).success).toBe(true)
  })

  it('defaults Synthea generation to all modules and bounds advanced filters', () => {
    const { modules: _legacyModules, ...withoutModules } = request

    expect(scenarioGenerationRequestSchema.parse(withoutModules)).toMatchObject({
      moduleMode: 'all',
      modules: [],
    })
    expect(scenarioGenerationRequestSchema.parse({
      ...withoutModules,
      moduleMode: 'filter',
      modules: ['cardiovascular/hypertension', 'metabolic_syndrome_disease'],
    })).toMatchObject({
      moduleMode: 'filter',
      modules: ['cardiovascular/hypertension', 'metabolic_syndrome_disease'],
    })
    expect(scenarioGenerationRequestSchema.safeParse({
      ...withoutModules,
      moduleMode: 'all',
      modules: ['hypertension'],
    }).success).toBe(false)
    expect(scenarioGenerationRequestSchema.safeParse({
      ...withoutModules,
      moduleMode: 'filter',
      modules: [],
    }).success).toBe(false)
    expect(scenarioGenerationRequestSchema.safeParse({
      ...withoutModules,
      moduleMode: 'filter',
      modules: ['../secrets'],
    }).success).toBe(false)
  })
})

describe('Synthea keep criteria', () => {
  const keep = { activeAny: ['392021009'], activeNone: [] }

  it('accepts bounded coded Observation value conditions', () => {
    const observations = [
      { code: '85337-4', valueAny: ['10828004'] },
      { code: '21906-3', valueAny: ['1229973008', '1229978004', '1229984001'] },
    ]

    expect(syntheaKeepCriteriaSchema.parse(keep)).toStrictEqual(keep)
    expect(syntheaKeepCriteriaSchema.parse({ ...keep, observations })).toStrictEqual({ ...keep, observations })
  })

  it.each([
    { label: 'an empty list', observations: [] },
    { label: 'a non-LOINC code', observations: [{ code: '10828004', valueAny: ['10828004'] }] },
    { label: 'no accepted value', observations: [{ code: '85337-4', valueAny: [] }] },
    { label: 'a non-SNOMED value', observations: [{ code: '85337-4', valueAny: ['positive'] }] },
    { label: 'a numeric comparison', observations: [{ code: '33728-7', operator: '<', value: 2, valueAny: ['10828004'] }] },
    {
      label: 'a repeated Observation code',
      observations: [
        { code: '85337-4', valueAny: ['10828004'] },
        { code: '85337-4', valueAny: ['260385009'] },
      ],
    },
    {
      label: 'more than eight conditions',
      observations: Array.from({ length: 9 }, (_, index) => ({ code: `8533${index}-4`, valueAny: ['10828004'] })),
    },
  ])('rejects $label in Observation conditions', ({ observations }) => {
    expect(syntheaKeepCriteriaSchema.safeParse({ ...keep, observations }).success).toBe(false)
  })
})

describe('Scenario UCUM units', () => {
  it('normalizes a known legacy display without accepting arbitrary bare units', () => {
    expect(scenarioUcumUnitSchema.parse('°C')).toEqual({
      code: 'Cel',
      display: '°C',
      system: 'http://unitsofmeasure.org',
      version: '2.2',
    })
    expect(scenarioUcumUnitSchema.parse({
      code: 'mmol/L',
      display: 'mmol/L',
      system: 'http://unitsofmeasure.org',
      version: '2.2',
    })).toEqual({
      code: 'mmol/L',
      display: 'mmol/L',
      system: 'http://unitsofmeasure.org',
      version: '2.2',
    })
    expect(scenarioUcumUnitSchema.safeParse('made-up-unit').success).toBe(false)
  })

  it('normalizes reported investigation results at the package read boundary', () => {
    expect(scenarioInvestigationResultSchema.parse({
      outcome: 'reported',
      unit: 'mmol/L',
      value: 13.8,
    })).toEqual({
      outcome: 'reported',
      unit: {
        code: 'mmol/L',
        display: 'mmol/L',
        system: 'http://unitsofmeasure.org',
        version: '2.2',
      },
      value: 13.8,
    })
  })

  it('keeps local investigation codes separate from versioned LOINC and UCUM coding', () => {
    expect(scenarioInvestigationCatalogItemSchema.parse({
      active: true,
      allowedIndicationCodes: ['type-2-diabetes'],
      available: true,
      category: 'laboratory',
      code: 'GLUCOSE',
      coding: {
        code: '2339-0',
        display: 'Glucose [Mass/volume] in Blood',
        system: 'http://loinc.org',
        version: '2.83',
      },
      contraindicatedAllergyCodes: [],
      id: 'lab-random-glucose',
      name: '随机血糖',
      organizationId: 'organization-clinmesh',
      priceFen: 500,
      referenceRanges: [{ appliesToGender: 'any', text: '3.9-11.1 mmol/L' }],
      reportTemplate: '随机血糖 {value} mmol/L。',
      status: 'active',
      tatMinutes: 30,
      unit: 'mmol/L',
      valueType: 'quantity',
    })).toMatchObject({
      code: 'GLUCOSE',
      coding: { code: '2339-0', system: 'http://loinc.org', version: '2.83' },
      unit: { code: 'mmol/L', system: 'http://unitsofmeasure.org', version: '2.2' },
    })
    expect(scenarioPhysiologyGeneratorSchema.parse({
      id: 'body-temperature',
      kind: 'constant',
      source: 'scenario:vital-signs',
      unit: '°C',
      value: 38.6,
    })).toMatchObject({
      unit: { code: 'Cel', system: 'http://unitsofmeasure.org', version: '2.2' },
    })
  })
})

describe('Scenario medication compatibility', () => {
  it('reads a pre-product medication without rewriting its persisted shape', () => {
    const legacyMedication = {
      active: true,
      category: '解热镇痛药',
      code: 'ACETAMINOPHEN',
      defaultDose: '0.5 g',
      defaultFrequency: 'PRN',
      defaultRoute: '口服',
      dosageForm: '片剂',
      id: 'medication-acetaminophen',
      name: '对乙酰氨基酚片',
      organizationId: 'hospital-synthetic-renhe',
      priceFen: 120,
      restriction: '注意总剂量。',
      status: 'active',
      unit: '片',
      workflow: {
        allowedCombinationIds: [],
        allowedCourseDays: [3],
        allowedDiagnosisCodes: ['R50.9'],
        allowedDoseTexts: ['0.5 g'],
        allowedFrequencyCodes: ['PRN'],
        allowedQuantities: [6],
        defaultCourseDays: 3,
        defaultQuantity: 6,
      },
    }

    expect(scenarioMedicationCatalogItemSchema.parse(legacyMedication)).toEqual(legacyMedication)
  })
})
