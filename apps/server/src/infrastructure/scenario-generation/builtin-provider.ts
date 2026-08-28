import { createHash } from 'node:crypto'
import type {
  ScenarioDatasetContent,
  ScenarioGenerationRequest,
  ScenarioProviderCapabilities,
} from '@clinmesh/contracts/scenario'
import { scenarioPatientSchema } from '@clinmesh/contracts/scenario'
import type {
  ScenarioGenerationProvider,
  SourcePatientCorpus,
} from '../../application/scenario-data/provider.ts'
import {
  generatedScenarioSimulatorRules,
  sourceArtifactHash,
} from '../../application/scenario-data/provider.ts'
import { createHospitalBaseline } from '../../application/scenario-data/hospital-baseline.ts'
import { compileSyntheaR4Bundle } from '../../application/scenario-data/synthea-case-truth-compiler.ts'

const syntheticNames = ['林晓', '王晓明', '李静', '张伟', '刘洋', '陈勇'] as const

function deterministicNumber(input: unknown): number {
  return Number.parseInt(createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 8), 16)
}

function birthDate(request: ScenarioGenerationRequest, ordinal: number): string {
  const span = request.population.age.maximum - request.population.age.minimum + 1
  const age = request.population.age.minimum
    + deterministicNumber([request.seeds.population, ordinal, 'age']) % span
  return `${Number(request.timeRange.end.slice(0, 4)) - age}-01-01`
}

function gender(request: ScenarioGenerationRequest, ordinal: number): 'female' | 'male' {
  if (request.population.gender !== 'any') return request.population.gender
  return deterministicNumber([request.seeds.population, ordinal, 'gender']) % 2 === 0
    ? 'female'
    : 'male'
}

function patient(request: ScenarioGenerationRequest, ordinal: number) {
  const module = request.modules[ordinal % request.modules.length] ?? 'fever'
  const idSuffix = createHash('sha256')
    .update(JSON.stringify([request.seeds, ordinal, module]))
    .digest('hex')
    .slice(0, 12)
  const isDiabetes = module === 'type-2-diabetes'
  const patientId = `builtin-source-${idSuffix}`
  const patientReference = `Patient/${patientId}`
  const encounterId = `builtin-encounter-${idSuffix}`
  const encounterReference = `Encounter/${encounterId}`
  const observationInputs = isDiabetes
    ? [{ code: '2339-0', display: 'Glucose [Mass/volume] in Blood', id: `glucose-${idSuffix}`, unit: 'mmol/L', value: 13.8 },
        { code: '4548-4', display: 'Hemoglobin A1c/Hemoglobin.total in Blood', id: `hba1c-${idSuffix}`, unit: '%', value: 9.2 }]
    : [{ code: '8310-5', display: 'Body temperature', id: `temperature-${idSuffix}`, unit: '°C', value: 38.6 }]
  const conditionInputs = isDiabetes
    ? [{ code: '44054006', display: 'Diabetes mellitus type 2', id: `diabetes-${idSuffix}` },
        { code: '38341003', display: 'Hypertension', id: `hypertension-${idSuffix}` }]
    : [{ code: '386661006', display: 'Fever', id: `fever-${idSuffix}` }]
  const compiled = compileSyntheaR4Bundle({
    bundle: {
      entry: [{
        resource: {
          birthDate: birthDate(request, ordinal),
          gender: gender(request, ordinal),
          id: patientId,
          resourceType: 'Patient',
        },
      }, {
        resource: {
          class: { code: 'AMB' },
          id: encounterId,
          period: {
            end: `${request.timeRange.end}T09:40:00+08:00`,
            start: `${request.timeRange.end}T09:00:00+08:00`,
          },
          resourceType: 'Encounter',
          status: 'finished',
          subject: { reference: patientReference },
        },
      }, ...conditionInputs.map(condition => ({
        resource: {
          clinicalStatus: { coding: [{ code: 'active' }] },
          code: { coding: [{ code: condition.code, display: condition.display, system: 'http://snomed.info/sct' }] },
          encounter: { reference: encounterReference },
          id: condition.id,
          onsetDateTime: `${request.timeRange.end}T08:00:00+08:00`,
          recordedDate: `${request.timeRange.end}T09:05:00+08:00`,
          resourceType: 'Condition',
          subject: { reference: patientReference },
        },
      })), ...observationInputs.map(observation => ({
        resource: {
          code: { coding: [{ code: observation.code, display: observation.display, system: 'http://loinc.org' }] },
          effectiveDateTime: `${request.timeRange.end}T09:10:00+08:00`,
          encounter: { reference: encounterReference },
          id: observation.id,
          resourceType: 'Observation',
          status: 'final',
          subject: { reference: patientReference },
          valueQuantity: { unit: observation.unit, value: observation.value },
        },
      }))],
      resourceType: 'Bundle',
      type: 'collection',
    },
    ordinal,
    request,
  })
  return scenarioPatientSchema.parse({
    ...compiled,
    id: `synthetic-patient-${idSuffix}`,
    name: syntheticNames[deterministicNumber([request.seeds.population, ordinal, 'name']) % syntheticNames.length]!,
    physiologyBaseline: {
      ...compiled.physiologyBaseline,
      generators: compiled.physiologyBaseline.generators.map(generator => ({
        ...generator,
        source: generator.source.replace('synthea-r4:', 'builtin:'),
      })),
    },
  })
}

export class BuiltInScenarioGenerationProvider implements ScenarioGenerationProvider {
  async capabilities(): Promise<ScenarioProviderCapabilities> {
    return {
      available: true,
      maxPopulation: 10,
      modules: ['fever', 'type-2-diabetes'],
      providerId: 'builtin',
      providerName: 'ClinMesh 内置生成器',
    }
  }

  async generate(request: ScenarioGenerationRequest): Promise<SourcePatientCorpus> {
    const patients = Array.from({ length: request.population.count }, (_, index) => patient(request, index))
    const baseline = createHospitalBaseline()
    const content: ScenarioDatasetContent = {
      catalog: baseline.catalog,
      hiddenFacts: patients.map(patient => ({
        code: `objective-primary-diagnosis-${patient.id}`,
        patientId: patient.id,
        value: patient.diagnosisSpace.primary.display,
      })),
      hospital: baseline.hospital,
      inventory: baseline.inventory,
      patients,
      reproduction: {
        clinicalSeed: request.seeds.clinical,
        generator: 'clinmesh-builtin-v1',
        modules: request.modules,
        populationSeed: request.seeds.population,
        timeRange: request.timeRange,
        timeZone: request.timeZone,
      },
      revealPolicies: patients.map(patient => ({
        code: `policy-primary-diagnosis-${patient.id}`,
        factCode: `objective-primary-diagnosis-${patient.id}`,
        patientId: patient.id,
        triggerCode: 'evaluator-only',
      })),
      schemaVersion: '1',
      simulatorRules: generatedScenarioSimulatorRules,
    }
    return {
      content,
      kind: 'case-truth',
      sources: patients.map(compiledPatient => ({
        format: 'clinmesh-template',
        hash: sourceArtifactHash(compiledPatient),
        patientId: compiledPatient.id,
        raw: null,
      })),
    }
  }
}
