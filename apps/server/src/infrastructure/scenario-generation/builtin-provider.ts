import { createHash } from 'node:crypto'
import type {
  ScenarioDatasetContent,
  ScenarioGenerationRequest,
  ScenarioProviderCapabilities,
} from '@clinmesh/contracts/scenario'
import { scenarioModuleSchema, scenarioModules } from '@clinmesh/contracts/scenario'
import type {
  ReferenceConcept,
  ReferenceMedicalService,
  ReferenceMedicationProduct,
  ReferenceValueSetEntry,
} from '@clinmesh/contracts/reference-data'
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
import { scenarioCaseDefinitions } from '../../application/scenario-data/scenario-case-definitions.ts'
import { compileScenarioCatalog } from '../../application/scenario-data/scenario-catalog-compiler.ts'
import { syntheticNhsaMedicationProductSnapshot } from '../../application/scenario-data/medication-product-snapshot.ts'
import {
  syntheticNhcMedicalServiceSnapshot,
  syntheticWstValueSetSnapshot,
} from '../../application/scenario-data/medical-service-snapshot.ts'
import { compileSyntheaR4Bundle } from '../../application/scenario-data/synthea-case-truth-compiler.ts'
import type { ReferenceHospitalSelection } from '../../application/reference-hospital-selection.ts'

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
  const module = scenarioModuleSchema.parse(
    request.modules[ordinal % request.modules.length] ?? 'fever',
  )
  const definition = scenarioCaseDefinitions[module]
  const idSuffix = createHash('sha256')
    .update(JSON.stringify([request.seeds, ordinal, module]))
    .digest('hex')
    .slice(0, 12)
  const patientId = `builtin-source-${idSuffix}`
  const patientReference = `Patient/${patientId}`
  const encounterId = `builtin-encounter-${idSuffix}`
  const encounterReference = `Encounter/${encounterId}`
  const observationInputs = definition.builtInSource.observations.map((observation, index) => ({
    ...observation,
    id: `observation-${index}-${idSuffix}`,
  }))
  const conditionInputs = definition.builtInSource.conditions.map((condition, index) => ({
    ...condition,
    id: `condition-${index}-${idSuffix}`,
  }))
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
      })), ...definition.builtInSource.medications.map((medication, index) => ({
        resource: {
          authoredOn: `${request.timeRange.end}T09:20:00+08:00`,
          encounter: { reference: encounterReference },
          id: `medication-request-${index}-${idSuffix}`,
          intent: 'order',
          medicationCodeableConcept: {
            coding: [{
              code: medication.code,
              display: medication.display,
              system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
            }],
          },
          resourceType: 'MedicationRequest',
          status: 'completed',
          subject: { reference: patientReference },
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
  readonly #medicalServices: readonly ReferenceMedicalService[]
  readonly #medicationProducts: readonly ReferenceMedicationProduct[]
  readonly #referenceSelection: ReferenceHospitalSelection | undefined
  readonly #referenceConcepts: readonly ReferenceConcept[]
  readonly #valueSetEntries: readonly ReferenceValueSetEntry[]

  constructor(
    medicationProducts = syntheticNhsaMedicationProductSnapshot,
    medicalServices = syntheticNhcMedicalServiceSnapshot,
    valueSetEntries = syntheticWstValueSetSnapshot,
    referenceSelection?: ReferenceHospitalSelection,
    referenceConcepts: readonly ReferenceConcept[] = [],
  ) {
    this.#medicalServices = medicalServices
    this.#medicationProducts = medicationProducts
    this.#referenceSelection = referenceSelection
    this.#referenceConcepts = referenceConcepts
    this.#valueSetEntries = valueSetEntries
  }

  async capabilities(): Promise<ScenarioProviderCapabilities> {
    return {
      available: true,
      maxPopulation: 10,
      modules: [...scenarioModules],
      providerId: 'builtin',
      providerName: 'ClinMesh 内置生成器',
    }
  }

  async generate(request: ScenarioGenerationRequest): Promise<SourcePatientCorpus> {
    const selectedModules = request.moduleMode === 'all'
      ? [...scenarioModules]
      : request.modules.map(module => scenarioModuleSchema.parse(module))
    const compatibilityRequest = { ...request, modules: selectedModules }
    const patients = Array.from(
      { length: request.population.count },
      (_, index) => patient(compatibilityRequest, index),
    )
    const baseline = compileScenarioCatalog({
      baseline: createHospitalBaseline(
        this.#medicationProducts,
        this.#medicalServices,
        this.#valueSetEntries,
        this.#referenceSelection,
        this.#referenceConcepts,
      ),
      modules: selectedModules,
    })
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
        catalogCompilation: baseline.report,
        clinicalSeed: request.seeds.clinical,
        generator: 'clinmesh-builtin-v1',
        modules: selectedModules,
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
