import { scenarioGenerationRequestSchema } from '@clinmesh/contracts/scenario'
import { describe, expect, it } from 'vitest'
import {
  compileSyntheaR4Bundle,
  syntheaR4BundleSchema,
} from '../src/application/scenario-data/synthea-case-truth-compiler.ts'

const request = scenarioGenerationRequestSchema.parse({
  modules: ['fever'],
  name: 'Synthea 发热病例',
  population: { age: { maximum: 65, minimum: 18 }, count: 1, gender: 'female' },
  providerId: 'synthea',
  seeds: { clinical: 7331, population: 4242 },
  timeRange: { end: '2026-08-01', start: '2020-01-01' },
  timeZone: 'Asia/Shanghai',
})

function catchCompilerError(callback: () => unknown): unknown {
  try {
    callback()
  } catch (error) {
    return error
  }
  throw new Error('Expected CaseTruth compilation to fail')
}

describe('Synthea R4 CaseTruth compiler', () => {
  it('compiles a fever history into deterministic Chinese CaseTruth without US semantics', () => {
    const patientReference = 'urn:uuid:patient-fever'
    const bundle = {
      entry: [{
        fullUrl: patientReference,
        resource: {
          address: [{ city: 'Boston', country: 'US', state: 'Massachusetts' }],
          birthDate: '1988-03-16',
          gender: 'female',
          id: 'patient-fever',
          identifier: [{ system: 'http://hl7.org/fhir/sid/us-ssn', value: '999-99-9999' }],
          name: [{ family: 'Synthetic', given: ['Alice'] }],
          resourceType: 'Patient',
        },
      }, {
        fullUrl: 'urn:uuid:encounter-fever',
        resource: {
          class: { code: 'EMER', system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode' },
          id: 'encounter-fever',
          period: { end: '2026-08-01T08:30:00Z', start: '2026-08-01T08:00:00Z' },
          resourceType: 'Encounter',
          status: 'finished',
          subject: { reference: patientReference },
          type: [{ text: 'Ambulatory encounter' }],
        },
      }, {
        fullUrl: 'urn:uuid:condition-fever',
        resource: {
          clinicalStatus: { coding: [{ code: 'active' }] },
          code: { coding: [{ code: '386661006', display: 'Fever', system: 'http://snomed.info/sct' }] },
          encounter: { reference: 'urn:uuid:encounter-fever' },
          id: 'condition-fever',
          onsetDateTime: '2026-07-31T15:00:00Z',
          recordedDate: '2026-08-01T08:05:00Z',
          resourceType: 'Condition',
          subject: { reference: patientReference },
        },
      }, {
        fullUrl: 'urn:uuid:temperature-fever',
        resource: {
          code: { coding: [{ code: '8310-5', display: 'Body temperature', system: 'http://loinc.org' }] },
          effectiveDateTime: '2026-08-01T08:03:00Z',
          encounter: { reference: 'urn:uuid:encounter-fever' },
          id: 'temperature-fever',
          resourceType: 'Observation',
          status: 'final',
          subject: { reference: patientReference },
          valueQuantity: { code: 'Cel', system: 'http://unitsofmeasure.org', unit: '°C', value: 38.6 },
        },
      }, {
        fullUrl: 'urn:uuid:medication-request-fever',
        resource: {
          authoredOn: '2026-08-01T08:20:00Z',
          id: 'medication-request-fever',
          intent: 'order',
          medicationCodeableConcept: { text: 'Acetaminophen 500 MG Oral Tablet' },
          resourceType: 'MedicationRequest',
          status: 'completed',
          subject: { reference: patientReference },
        },
      }, {
        fullUrl: 'urn:uuid:coverage-us',
        resource: {
          beneficiary: { reference: patientReference },
          id: 'coverage-us',
          payor: [{ reference: 'urn:uuid:organization-us' }],
          resourceType: 'Coverage',
          status: 'active',
        },
      }, {
        fullUrl: 'urn:uuid:organization-us',
        resource: {
          address: [{ country: 'US', state: 'Massachusetts' }],
          id: 'organization-us',
          identifier: [{ system: 'https://github.com/synthetichealth/synthea', value: 'provider-us' }],
          name: 'Massachusetts General Hospital',
          resourceType: 'Organization',
        },
      }],
      resourceType: 'Bundle',
      type: 'collection',
    }

    const compiled = compileSyntheaR4Bundle({ bundle, ordinal: 0, request })

    expect(compiled).toMatchObject({
      birthDate: '1988-03-16',
      encounter: { openingStatement: '发热一天，伴咽部不适。' },
      examinationFindings: [expect.objectContaining({ id: 'exam-vital-signs', name: '生命体征' })],
      gender: 'female',
      id: 'synthea-patient-patient-fever',
      name: '林安宁',
      patientKnowledge: expect.objectContaining({
        chiefComplaint: '发热一天，伴咽部不适。',
        neverKnows: expect.arrayContaining(['本次尚未告知的检查数值']),
      }),
      symptomResponses: [expect.objectContaining({
        id: 'symptom-fever',
        passive: false,
      })],
    })
    expect(compiled.investigations).toContainEqual(expect.objectContaining({
      catalogItemId: 'lab-body-temperature',
      result: expect.objectContaining({
        flag: 'H',
        unit: {
          code: 'Cel',
          display: '°C',
          system: 'http://unitsofmeasure.org',
          version: '2.2',
        },
        value: 38.6,
      }),
      sourceLevel: 'L1',
    }))
    expect(compiled.fhirHistory.map(resource => resource.resourceType)).toEqual([
      'Encounter',
      'Condition',
      'Observation',
      'MedicationRequest',
    ])
    expect(compiled.fhirHistory[0]).toMatchObject({ classCode: 'EMER', resourceType: 'Encounter' })
    expect(compiled.fhirHistory.find(resource => resource.resourceType === 'Observation')).toMatchObject({
      code: {
        code: '8310-5',
        display: 'Body temperature',
        system: 'http://loinc.org',
        version: '2.83',
      },
      value: {
        unit: {
          code: 'Cel',
          display: '°C',
          system: 'http://unitsofmeasure.org',
          version: '2.2',
        },
      },
    })
    expect(compiled.longitudinalHistory.find(event => (
      event.sourceResourceType === 'Encounter'
    ))).toMatchObject({ code: 'EMER', mappedCode: null })
    expect(JSON.stringify(compiled)).not.toMatch(/Boston|Massachusetts|Alice|Synthetic|Coverage|999-99-9999/)
    expect(compileSyntheaR4Bundle({ bundle, ordinal: 0, request })).toEqual(compiled)

    const wrongSystemBundle = structuredClone(bundle)
    const wrongSystemObservation = wrongSystemBundle.entry.find(entry => (
      entry.resource.id === 'temperature-fever'
    ))?.resource
    if (wrongSystemObservation?.resourceType !== 'Observation') {
      throw new Error('Temperature fixture was not found')
    }
    const wrongSystemCoding = wrongSystemObservation.code?.coding?.[0]
    if (wrongSystemCoding === undefined) throw new Error('Temperature coding was not found')
    wrongSystemCoding.system = 'https://example.test/not-loinc'
    expect(catchCompilerError(() => compileSyntheaR4Bundle({
      bundle: wrongSystemBundle,
      ordinal: 0,
      request,
    }))).toMatchObject({
      code: 'OBSERVATION_CODING_MISMATCH',
      sourceResourceId: 'temperature-fever',
    })

    const wrongVersionBundle = structuredClone(bundle)
    const wrongVersionObservation = wrongVersionBundle.entry.find(entry => (
      entry.resource.id === 'temperature-fever'
    ))?.resource
    if (wrongVersionObservation?.resourceType !== 'Observation') {
      throw new Error('Temperature fixture was not found')
    }
    const wrongVersionCoding = wrongVersionObservation.code?.coding?.[0]
    if (wrongVersionCoding === undefined) throw new Error('Temperature coding was not found')
    Object.assign(wrongVersionCoding, { version: '2.82' })
    expect(catchCompilerError(() => compileSyntheaR4Bundle({
      bundle: wrongVersionBundle,
      ordinal: 0,
      request,
    }))).toMatchObject({
      code: 'OBSERVATION_CODING_MISMATCH',
      sourceResourceId: 'temperature-fever',
    })

    const wrongDisplayBundle = structuredClone(bundle)
    const wrongDisplayObservation = wrongDisplayBundle.entry.find(entry => (
      entry.resource.id === 'temperature-fever'
    ))?.resource
    if (wrongDisplayObservation?.resourceType !== 'Observation') {
      throw new Error('Temperature fixture was not found')
    }
    const wrongDisplayCoding = wrongDisplayObservation.code?.coding?.[0]
    if (wrongDisplayCoding === undefined) throw new Error('Temperature coding was not found')
    wrongDisplayCoding.display = 'Blood glucose'
    expect(catchCompilerError(() => compileSyntheaR4Bundle({
      bundle: wrongDisplayBundle,
      ordinal: 0,
      request,
    }))).toMatchObject({
      code: 'OBSERVATION_CODING_MISMATCH',
      sourceResourceId: 'temperature-fever',
    })
  })

  it('keeps T2DM objective truth separate from patient knowledge in the same schema', () => {
    const diabetesRequest = scenarioGenerationRequestSchema.parse({
      ...request,
      modules: ['type-2-diabetes'],
      name: 'Synthea 2型糖尿病病例',
    })
    const patientReference = 'urn:uuid:patient-diabetes'
    const encounterReference = 'urn:uuid:encounter-diabetes'
    const bundle = {
      entry: [{
        fullUrl: patientReference,
        resource: {
          address: [{ city: 'Springfield', country: 'US' }],
          birthDate: '1971-06-18',
          gender: 'male',
          id: 'patient-diabetes',
          name: [{ family: 'Smith', given: ['John'] }],
          resourceType: 'Patient',
        },
      }, {
        fullUrl: encounterReference,
        resource: {
          class: { code: 'AMB', system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode' },
          id: 'encounter-diabetes',
          period: { end: '2026-08-01T09:40:00Z', start: '2026-08-01T09:00:00Z' },
          resourceType: 'Encounter',
          status: 'finished',
          subject: { reference: patientReference },
        },
      }, ...[{
        code: { coding: [{ code: '44054006', display: 'Diabetes mellitus type 2', system: 'http://snomed.info/sct' }] },
        id: 'condition-diabetes',
      }, {
        code: { coding: [{ code: '38341003', display: 'Hypertension', system: 'http://snomed.info/sct' }] },
        id: 'condition-hypertension',
      }].map(resource => ({
        fullUrl: `urn:uuid:${resource.id}`,
        resource: {
          ...resource,
          clinicalStatus: { coding: [{ code: 'active' }] },
          encounter: { reference: encounterReference },
          onsetDateTime: '2021-03-01T00:00:00Z',
          recordedDate: '2021-03-01T01:00:00Z',
          resourceType: 'Condition',
          subject: { reference: patientReference },
        },
      })), ...[{
        code: '2339-0',
        display: 'Glucose [Mass/volume] in Blood',
        effectiveDateTime: '2024-08-01T09:10:00Z',
        id: 'observation-glucose-historical',
        unit: 'mmol/L',
        value: 7.4,
      }, {
        code: '4548-4',
        display: 'Hemoglobin A1c/Hemoglobin.total in Blood',
        effectiveDateTime: '2024-08-01T09:10:00Z',
        id: 'observation-hba1c-historical',
        unit: '%',
        value: 7.1,
      }, {
        code: '2339-0',
        display: 'Glucose [Mass/volume] in Blood',
        effectiveDateTime: '2026-08-01T09:10:00Z',
        id: 'observation-glucose',
        unit: 'mg/dL',
        value: 248.65,
      }, {
        code: '4548-4',
        display: 'Hemoglobin A1c/Hemoglobin.total in Blood',
        effectiveDateTime: '2026-08-01T09:10:00Z',
        id: 'observation-hba1c',
        unit: '%',
        value: 9.2,
      }].map(resource => ({
        fullUrl: `urn:uuid:${resource.id}`,
        resource: {
          code: { coding: [{ code: resource.code, display: resource.display, system: 'http://loinc.org' }] },
          effectiveDateTime: resource.effectiveDateTime,
          encounter: { reference: encounterReference },
          id: resource.id,
          resourceType: 'Observation',
          status: 'final',
          subject: { reference: patientReference },
          valueQuantity: { unit: resource.unit, value: resource.value },
        },
      })), {
        fullUrl: 'urn:uuid:allergy-penicillin',
        resource: {
          clinicalStatus: { coding: [{ code: 'active' }] },
          code: { coding: [{ code: '91936005', display: 'Allergy to penicillin', system: 'http://snomed.info/sct' }] },
          id: 'allergy-penicillin',
          patient: { reference: patientReference },
          recordedDate: '2018-05-06T08:00:00Z',
          resourceType: 'AllergyIntolerance',
        },
      }],
      resourceType: 'Bundle',
      type: 'collection',
    }

    const compiled = compileSyntheaR4Bundle({ bundle, ordinal: 0, request: diabetesRequest })

    expect(compiled.diagnosisSpace).toMatchObject({
      comorbidities: [expect.objectContaining({ code: 'I10' })],
      primary: expect.objectContaining({ code: 'E11.65' }),
    })
    expect(compiled.investigations).toEqual(expect.arrayContaining([
      expect.objectContaining({ catalogItemId: 'lab-random-glucose', result: expect.objectContaining({ value: 13.8 }) }),
      expect.objectContaining({ catalogItemId: 'lab-hba1c', result: expect.objectContaining({ value: 9.2 }) }),
    ]))
    expect(compiled.investigations).toHaveLength(2)
    expect(compiled.symptomResponses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'symptom-foot-numbness', passive: true }),
      expect.objectContaining({ id: 'symptom-medication-adherence', secondAskConcede: expect.any(Object) }),
    ]))
    expect(JSON.stringify(compiled.patientKnowledge)).not.toMatch(/13\.8|9\.2/)
    expect(compiled.patientKnowledge.neverKnows).toContain('本次尚未告知的检查数值')
    expect(compiled.fhirHistory.map(resource => resource.resourceType)).toEqual([
      'Encounter',
      'Condition',
      'Condition',
      'Observation',
      'Observation',
      'Observation',
      'Observation',
      'AllergyIntolerance',
    ])
    expect(compiled.longitudinalHistory.find(event => (
      event.sourceResourceType === 'AllergyIntolerance'
    ))).toMatchObject({ mappedCode: null })
    expect(compiled.diagnosisSpace.primary.evidence).toEqual(expect.arrayContaining([
      '随机血糖 13.8 mmol/L',
      'HbA1c 9.2%',
    ]))
    expect(JSON.stringify(compiled)).not.toMatch(/Springfield|Smith|John/)

    const invalidQuantities = [{
      value: 248.65,
    }, {
      unit: 'mg%',
      value: 248.65,
    }, {
      code: 'mg/dL',
      system: 'http://unitsofmeasure.org',
      unit: 'mmol/L',
      value: 248.65,
    }, {
      code: 'mg%',
      system: 'http://unitsofmeasure.org',
      unit: 'mg/dL',
      value: 248.65,
    }]
    for (const valueQuantity of invalidQuantities) {
      const invalidUnitBundle = syntheaR4BundleSchema.parse(structuredClone(bundle))
      invalidUnitBundle.entry = invalidUnitBundle.entry.filter(entry => (
        entry.resource.id !== 'observation-glucose-historical'
      ))
      const glucose = invalidUnitBundle.entry.find(entry => (
        entry.resource.id === 'observation-glucose'
      ))?.resource
      if (glucose?.resourceType !== 'Observation' || glucose.valueQuantity === undefined) {
        throw new Error('Glucose fixture was not found')
      }
      glucose.valueQuantity = valueQuantity

      expect(catchCompilerError(() => compileSyntheaR4Bundle({
        bundle: invalidUnitBundle,
        ordinal: 0,
        request: diabetesRequest,
      }))).toMatchObject({
        code: 'OBSERVATION_UNIT_INVALID',
        sourceResourceId: 'observation-glucose',
      })
    }
  })
})
