import { describe, expect, it } from 'vitest'
import {
  scenarioGenerationRequestSchema,
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
