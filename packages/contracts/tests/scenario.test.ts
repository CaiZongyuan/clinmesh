import { describe, expect, it } from 'vitest'
import {
  scenarioGenerationRequestSchema,
  scenarioInvestigationCatalogItemSchema,
  scenarioInvestigationResultSchema,
  scenarioMedicationCatalogItemSchema,
  scenarioPhysiologyGeneratorSchema,
  scenarioUcumUnitSchema,
  syntheticPatientMappingCatalogSchema,
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

describe('Synthetic Patient mapping catalog', () => {
  it('publishes only resource types backed by a platform catalog', () => {
    expect(syntheticPatientMappingCatalogSchema.parse({
      items: [{
        catalogItemId: 'diagnosis-acute-upper-respiratory-infection',
        code: 'J06.9',
        nameEn: 'Acute upper respiratory infection',
        nameZh: '急性上呼吸道感染',
        sourceResourceType: 'Condition',
        system: 'http://hl7.org/fhir/sid/icd-10',
        version: 1,
      }, {
        catalogItemId: 'encounter-class-ambulatory',
        code: 'AMB',
        nameEn: 'Ambulatory encounter',
        nameZh: '门诊就诊',
        sourceResourceType: 'Encounter',
        system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
        version: 1,
      }],
    }).items).toHaveLength(2)
    expect(syntheticPatientMappingCatalogSchema.safeParse({
      items: [{
        catalogItemId: 'allergy-penicillin',
        code: 'ALLERGY-001',
        nameEn: 'Allergy',
        nameZh: '过敏',
        sourceResourceType: 'AllergyIntolerance',
        system: 'http://snomed.info/sct',
        version: 1,
      }],
    }).success).toBe(false)
  })
})
