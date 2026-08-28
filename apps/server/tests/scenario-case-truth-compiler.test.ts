import {
  scenarioDatasetContentSchema,
  scenarioGenerationRequestSchema,
  type ScenarioPatient,
} from '@clinmesh/contracts/scenario'
import { describe, expect, it } from 'vitest'
import {
  compileSyntheaR4Bundle,
  pinSyntheaSourceVersions,
  syntheaR4BundleSchema,
} from '../src/application/scenario-data/synthea-case-truth-compiler.ts'
import { createHospitalBaseline } from '../src/application/scenario-data/hospital-baseline.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../src/application/scenario-data/medication-product-snapshot.ts'
import {
  syntheticNhcMedicalServiceSnapshot,
  syntheticWstValueSetSnapshot,
} from '../src/application/scenario-data/medical-service-snapshot.ts'
import { validateScenarioDataset } from '../src/application/scenario-data/scenario-dataset-validator.ts'

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

function datasetDiagnostics(patient: ScenarioPatient) {
  const baseline = createHospitalBaseline(
    syntheticNhsaMedicationProductSnapshot,
    syntheticNhcMedicalServiceSnapshot,
    syntheticWstValueSetSnapshot,
  )
  return validateScenarioDataset(scenarioDatasetContentSchema.parse({
    ...baseline,
    hiddenFacts: [],
    patients: [patient],
    reproduction: {
      clinicalSeed: request.seeds.clinical,
      generator: 'synthea-fhir-r4',
      modules: request.modules,
      populationSeed: request.seeds.population,
      timeRange: request.timeRange,
      timeZone: request.timeZone,
    },
    revealPolicies: [],
    schemaVersion: '1',
    simulatorRules: [],
  }))
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
          medicationCodeableConcept: {
            coding: [{
              code: '198440',
              display: 'Acetaminophen 500 MG Oral Tablet',
              system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
            }],
          },
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
    expect(compiled.fhirHistory.find(resource => resource.resourceType === 'Condition')).toMatchObject({
      code: {
        code: 'R50.9',
        display: '发热，未特指',
        system: 'urn:clinmesh:reference:nhsa-diagnosis',
        version: 'nhsa-diagnosis-2026-08-07',
      },
    })
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
    expect(compiled.fhirHistory.find(resource => resource.resourceType === 'MedicationRequest'))
      .toMatchObject({
        medication: {
          code: 'CM-DRUG-ACETAMINOPHEN-500MG-ORAL-TABLET',
          display: '对乙酰氨基酚 500 mg 口服片剂',
          system: 'urn:clinmesh:reference:drug-concept',
          version: 'clinmesh-drug-concepts-2026-08-28',
        },
      })
    expect(compiled.longitudinalHistory.find(event => (
      event.sourceResourceType === 'Encounter'
    ))).toMatchObject({ code: 'EMER', mappedCode: null })
    expect(compiled.longitudinalHistory.find(event => (
      event.sourceResourceId === 'condition-fever'
    ))).toMatchObject({
      sourceDisplay: 'Fever',
      sourceSystem: 'http://snomed.info/sct',
      sourceVersion: 'http://snomed.info/sct/900000000000207008/version/20250201',
    })
    expect(compiled.longitudinalHistory.find(event => (
      event.sourceResourceId === 'medication-request-fever'
    ))).toMatchObject({
      mappedCode: 'CM-DRUG-ACETAMINOPHEN-500MG-ORAL-TABLET',
      sourceDisplay: 'Acetaminophen 500 MG Oral Tablet',
      sourceSystem: 'http://www.nlm.nih.gov/research/umls/rxnorm',
      sourceVersion: 'rxnorm-2026-08-03',
    })
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

    const wrongConditionSystemBundle = syntheaR4BundleSchema.parse(structuredClone(bundle))
    const wrongSystemCondition = wrongConditionSystemBundle.entry.find(entry => (
      entry.resource.id === 'condition-fever'
    ))?.resource
    if (wrongSystemCondition?.resourceType !== 'Condition') {
      throw new Error('Fever condition fixture was not found')
    }
    const wrongConditionCoding = wrongSystemCondition.code?.coding?.[0]
    if (wrongConditionCoding === undefined) throw new Error('Fever condition coding was not found')
    wrongConditionCoding.system = 'https://example.test/not-snomed'
    const wrongSystemConditionPatient = compileSyntheaR4Bundle({
      bundle: wrongConditionSystemBundle,
      ordinal: 0,
      request,
    })
    expect(wrongSystemConditionPatient.fhirHistory.find(resource => (
      resource.resourceType === 'Condition'
    ))).toMatchObject({
      code: {
        code: '386661006',
        display: 'Fever',
        system: 'https://example.test/not-snomed',
      },
    })
    expect(wrongSystemConditionPatient.longitudinalHistory).toContainEqual(expect.objectContaining({
      mappedCode: null,
      sourceResourceId: 'condition-fever',
    }))
    const diagnostics = datasetDiagnostics(wrongSystemConditionPatient)
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'CLINICAL_CODE_UNMAPPED',
      message: 'Condition/condition-fever has no ClinMesh mapping',
      severity: 'warning',
    }))

    const displayOnlyConditionBundle = syntheaR4BundleSchema.parse(structuredClone(bundle))
    const displayOnlyCondition = displayOnlyConditionBundle.entry.find(entry => (
      entry.resource.id === 'condition-fever'
    ))?.resource
    if (displayOnlyCondition?.resourceType !== 'Condition' || displayOnlyCondition.code === undefined) {
      throw new Error('Fever condition fixture was not found')
    }
    displayOnlyCondition.code.coding = [{ display: 'Fever' }]
    const displayOnlyConditionPatient = compileSyntheaR4Bundle({
      bundle: displayOnlyConditionBundle,
      ordinal: 0,
      request,
    })
    expect(displayOnlyConditionPatient.longitudinalHistory).toContainEqual(expect.objectContaining({
      mappedCode: null,
      sourceResourceId: 'condition-fever',
    }))

    const multipleCodingBundle = syntheaR4BundleSchema.parse(structuredClone(bundle))
    const multipleCodingRequest = multipleCodingBundle.entry.find(entry => (
      entry.resource.id === 'medication-request-fever'
    ))?.resource
    if (
      multipleCodingRequest?.resourceType !== 'MedicationRequest'
      || multipleCodingRequest.medicationCodeableConcept?.coding === undefined
    ) {
      throw new Error('MedicationRequest fixture was not found')
    }
    multipleCodingRequest.medicationCodeableConcept.coding.unshift({
      code: 'LOCAL-ACETAMINOPHEN',
      display: 'Local acetaminophen product',
      system: 'https://example.test/local-medications',
    }, {
      code: '999998',
      display: 'Unknown RxNorm drug before active coding',
      system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
    })
    expect(compileSyntheaR4Bundle({
      bundle: multipleCodingBundle,
      ordinal: 0,
      request,
    }).longitudinalHistory).toContainEqual(expect.objectContaining({
      mappedCode: 'CM-DRUG-ACETAMINOPHEN-500MG-ORAL-TABLET',
      sourceResourceId: 'medication-request-fever',
      sourceSystem: 'http://www.nlm.nih.gov/research/umls/rxnorm',
    }))

    const ambiguousMedicationBundle = syntheaR4BundleSchema.parse(structuredClone(bundle))
    const ambiguousMedicationRequest = ambiguousMedicationBundle.entry.find(entry => (
      entry.resource.id === 'medication-request-fever'
    ))?.resource
    if (
      ambiguousMedicationRequest?.resourceType !== 'MedicationRequest'
      || ambiguousMedicationRequest.medicationCodeableConcept?.coding === undefined
    ) {
      throw new Error('MedicationRequest fixture was not found')
    }
    ambiguousMedicationRequest.medicationCodeableConcept.coding.push({
      code: '860975',
      display: 'Metformin hydrochloride 500 MG Oral Tablet',
      system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
    })
    const ambiguousMedicationPatient = compileSyntheaR4Bundle({
      bundle: ambiguousMedicationBundle,
      ordinal: 0,
      request,
    })
    expect(ambiguousMedicationPatient.fhirHistory.find(resource => (
      resource.resourceType === 'MedicationRequest'
    ))).toMatchObject({
      medication: {
        sourceCodings: [
          expect.objectContaining({ code: '198440', version: 'rxnorm-2026-08-03' }),
          expect.objectContaining({ code: '860975', version: 'rxnorm-2026-08-03' }),
        ],
      },
    })
    expect(ambiguousMedicationPatient.longitudinalHistory).toContainEqual(expect.objectContaining({
      mappedCode: null,
      sourceResourceId: 'medication-request-fever',
    }))
    expect(datasetDiagnostics(ambiguousMedicationPatient)).toContainEqual(expect.objectContaining({
      code: 'CLINICAL_CODE_UNMAPPED',
      message: 'MedicationRequest/medication-request-fever has no ClinMesh mapping',
    }))
    const pinnedAmbiguousBundle = pinSyntheaSourceVersions(
      ambiguousMedicationBundle,
      ambiguousMedicationPatient,
    )
    const pinnedAmbiguousRequest = pinnedAmbiguousBundle.entry.find(entry => (
      entry.resource.id === 'medication-request-fever'
    ))?.resource
    if (
      pinnedAmbiguousRequest?.resourceType !== 'MedicationRequest'
      || pinnedAmbiguousRequest.medicationCodeableConcept?.coding === undefined
    ) {
      throw new Error('MedicationRequest fixture was not found')
    }
    expect(pinnedAmbiguousRequest.medicationCodeableConcept.coding.filter(coding => (
      coding.system === 'http://www.nlm.nih.gov/research/umls/rxnorm'
    )).map(coding => coding.version)).toEqual([
      'rxnorm-2026-08-03',
      'rxnorm-2026-08-03',
    ])
    expect(ambiguousMedicationRequest.medicationCodeableConcept.coding.some(coding => (
      coding.version !== undefined
    ))).toBe(false)

    const withMedicationReference = (
      reference: string,
      medicationId: string,
      fullUrl = `Medication/${medicationId}`,
    ) => ({
      ...bundle,
      entry: [...bundle.entry.map((entry) => {
        if (entry.resource.id !== 'medication-request-fever') return entry
        const { medicationCodeableConcept: _medication, ...resource } = entry.resource
        return {
          ...entry,
          resource: { ...resource, medicationReference: { reference } },
        }
      }), {
        fullUrl,
        resource: {
          code: {
            coding: [{
              code: '198440',
              display: 'Acetaminophen 500 MG Oral Tablet',
              system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
            }],
          },
          id: medicationId,
          resourceType: 'Medication',
        },
      }],
    })
    const referencedMedicationPatient = compileSyntheaR4Bundle({
      bundle: withMedicationReference(
        'urn:uuid:medication-acetaminophen-source',
        'medication-acetaminophen-source',
        'urn:uuid:medication-acetaminophen-source',
      ),
      ordinal: 0,
      request,
    })
    expect(referencedMedicationPatient.fhirHistory.find(resource => (
      resource.resourceType === 'MedicationRequest'
    ))?.medication).toEqual(compiled.fhirHistory.find(resource => (
      resource.resourceType === 'MedicationRequest'
    ))?.medication)

    for (const invalidReferenceBundle of [
      withMedicationReference('Medication/missing-medication', 'other-medication'),
      withMedicationReference('Condition/condition-fever', 'condition-fever'),
    ]) {
      expect(catchCompilerError(() => compileSyntheaR4Bundle({
        bundle: invalidReferenceBundle,
        ordinal: 0,
        request,
      }))).toMatchObject({
        code: 'MEDICATION_SOURCE_INVALID',
        sourceResourceId: 'medication-request-fever',
      })
    }

    const unknownMedicationBundle = syntheaR4BundleSchema.parse(structuredClone(bundle))
    const unknownMedicationRequest = unknownMedicationBundle.entry.find(entry => (
      entry.resource.id === 'medication-request-fever'
    ))?.resource
    if (unknownMedicationRequest?.resourceType !== 'MedicationRequest') {
      throw new Error('MedicationRequest fixture was not found')
    }
    unknownMedicationRequest.medicationCodeableConcept = {
      coding: [{
        code: '999999',
        display: 'Unknown synthetic RxNorm drug',
        system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
        version: 'rxnorm-2026-08-03',
      }],
    }
    const unknownMedicationPatient = compileSyntheaR4Bundle({
      bundle: unknownMedicationBundle,
      ordinal: 0,
      request,
    })
    expect(unknownMedicationPatient.fhirHistory.find(resource => (
      resource.resourceType === 'MedicationRequest'
    ))).toMatchObject({
      medication: {
        code: '999999',
        display: 'Unknown synthetic RxNorm drug',
        system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
        version: 'rxnorm-2026-08-03',
      },
    })
    expect(unknownMedicationPatient.longitudinalHistory).toContainEqual(expect.objectContaining({
      mappedCode: null,
      sourceResourceId: 'medication-request-fever',
      sourceVersion: 'rxnorm-2026-08-03',
    }))
    expect(datasetDiagnostics(unknownMedicationPatient)).toContainEqual(expect.objectContaining({
      code: 'CLINICAL_CODE_UNMAPPED',
      message: 'MedicationRequest/medication-request-fever has no ClinMesh mapping',
      severity: 'warning',
    }))

    const conflictingMedicationBundle = syntheaR4BundleSchema.parse(structuredClone(bundle))
    const conflictingMedicationRequest = conflictingMedicationBundle.entry.find(entry => (
      entry.resource.id === 'medication-request-fever'
    ))?.resource
    if (conflictingMedicationRequest?.resourceType !== 'MedicationRequest') {
      throw new Error('MedicationRequest fixture was not found')
    }
    conflictingMedicationRequest.medicationReference = {
      reference: 'Medication/medication-acetaminophen-source',
    }
    expect(catchCompilerError(() => compileSyntheaR4Bundle({
      bundle: conflictingMedicationBundle,
      ordinal: 0,
      request,
    }))).toMatchObject({
      code: 'MEDICATION_SOURCE_INVALID',
      sourceResourceId: 'medication-request-fever',
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
    expect(compiled.fhirHistory.filter(resource => resource.resourceType === 'Condition'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: expect.objectContaining({
            code: 'E11.65',
            system: 'urn:clinmesh:reference:nhsa-diagnosis',
            version: 'nhsa-diagnosis-2026-08-07',
          }),
        }),
        expect.objectContaining({
          code: expect.objectContaining({
            code: 'I10',
            system: 'urn:clinmesh:reference:nhsa-diagnosis',
            version: 'nhsa-diagnosis-2026-08-07',
          }),
        }),
      ]))
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

  it('compiles hypertension through the shared case-definition registry', () => {
    const hypertensionRequest = scenarioGenerationRequestSchema.parse({
      ...request,
      modules: ['hypertension'],
      name: 'Synthea 高血压病例',
    })
    const patientReference = 'urn:uuid:patient-hypertension'
    const encounterReference = 'urn:uuid:encounter-hypertension'
    const bundle = {
      entry: [{
        fullUrl: patientReference,
        resource: {
          birthDate: '1965-11-03',
          gender: 'female',
          id: 'patient-hypertension',
          resourceType: 'Patient',
        },
      }, {
        fullUrl: encounterReference,
        resource: {
          class: { code: 'AMB' },
          id: 'encounter-hypertension',
          period: { end: '2026-08-01T09:40:00Z', start: '2026-08-01T09:00:00Z' },
          resourceType: 'Encounter',
          status: 'finished',
          subject: { reference: patientReference },
        },
      }, {
        fullUrl: 'urn:uuid:condition-hypertension',
        resource: {
          clinicalStatus: { coding: [{ code: 'active' }] },
          code: {
            coding: [{
              code: '59621000',
              display: 'Essential hypertension (disorder)',
              system: 'http://snomed.info/sct',
            }],
          },
          encounter: { reference: encounterReference },
          id: 'condition-hypertension',
          onsetDateTime: '2024-08-01T09:00:00Z',
          recordedDate: '2024-08-01T09:05:00Z',
          resourceType: 'Condition',
          subject: { reference: patientReference },
        },
      }, {
        fullUrl: 'urn:uuid:medication-request-amlodipine',
        resource: {
          authoredOn: '2025-08-01T09:20:00Z',
          encounter: { reference: encounterReference },
          id: 'medication-request-amlodipine',
          intent: 'order',
          medicationCodeableConcept: {
            coding: [{
              code: '308136',
              display: 'amLODIPine 2.5 MG Oral Tablet',
              system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
            }],
          },
          resourceType: 'MedicationRequest',
          status: 'completed',
          subject: { reference: patientReference },
        },
      }],
      resourceType: 'Bundle',
      type: 'collection',
    }

    const compiled = compileSyntheaR4Bundle({ bundle, ordinal: 0, request: hypertensionRequest })

    expect(compiled.diagnosisSpace).toMatchObject({
      primary: { code: 'I10', display: '高血压' },
    })
    expect(compiled.investigations).toEqual([
      expect.objectContaining({
        catalogItemId: 'lab-creatinine',
        result: expect.objectContaining({ value: 78 }),
        sourceLevel: 'L1',
      }),
      expect.objectContaining({
        catalogItemId: 'lab-egfr',
        result: expect.objectContaining({ value: 92 }),
        sourceLevel: 'L1',
      }),
    ])
    expect(compiled.physiologyBaseline.vitalSigns).toMatchObject({
      diastolicMmHg: 96,
      systolicMmHg: 162,
    })
    expect(compiled.patientKnowledge).toMatchObject({
      chiefComplaint: '最近量血压总是偏高，偶尔头晕。',
      toldDiagnoses: ['高血压'],
    })
    expect(compiled.fhirHistory.find(resource => resource.resourceType === 'MedicationRequest'))
      .toMatchObject({
        medication: {
          code: 'CM-DRUG-AMLODIPINE-2.5MG-ORAL-TABLET',
          display: '氨氯地平 2.5 mg 口服片剂',
          system: 'urn:clinmesh:reference:drug-concept',
        },
      })
    expect(datasetDiagnostics(compiled)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error' }),
    ]))
  })
})
