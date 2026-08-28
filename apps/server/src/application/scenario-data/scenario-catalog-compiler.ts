import type {
  ScenarioDatasetContent,
  ScenarioModule,
} from '@clinmesh/contracts/scenario'
import { resolveDiagnosisMapping } from './diagnosis-coding-package.ts'
import { resolveMedicationMapping } from './medication-coding-package.ts'
import { resolveObservationMapping } from './reference-coding-package.ts'
import {
  scenarioCaseDefinitions,
  type ScenarioCatalogCollection,
  type ScenarioCatalogDependency,
  type ScenarioCoverageRequirement,
} from './scenario-case-definitions.ts'
import { canonicalJsonHash } from './canonical-json.ts'
import inventoryData from '../../../reference-data/synthea-dependency-inventory.json' with { type: 'json' }
import { syntheaDependencyInventoryArtifactSchema } from './synthea-dependency-inventory.ts'

const inventoryArtifact = syntheaDependencyInventoryArtifactSchema.parse(inventoryData)

type HospitalBaseline = Pick<ScenarioDatasetContent, 'catalog' | 'hospital' | 'inventory'>
type CoverageResolution =
  | 'ambiguous'
  | 'hospital-not-enabled'
  | 'mapped'
  | 'missing'
  | 'not-applicable'
type DependencyResolution = Exclude<CoverageResolution, 'not-applicable'>
type BlockerCode =
  | 'CRITICAL_DEPENDENCY_AMBIGUOUS'
  | 'CRITICAL_DEPENDENCY_MISSING'
  | 'WORKFLOW_DEPENDENCY_AMBIGUOUS'
  | 'WORKFLOW_DEPENDENCY_MISSING'

interface CoverageEntry {
  generatedOccurrences?: number
  module: ScenarioModule | 'baseline-workflow'
  requirement: ScenarioCoverageRequirement
  resolution: CoverageResolution
  source?: ScenarioCatalogDependency['source'] | { resourceType: string }
  staticOccurrences?: number
  targetId?: string
}

function normalizedSourceSystem(system: string): string {
  if (system === 'LOINC') return 'http://loinc.org'
  if (system === 'RxNorm') return 'http://www.nlm.nih.gov/research/umls/rxnorm'
  if (system === 'SNOMED-CT') return 'http://snomed.info/sct'
  return system
}

function sourceCodingKey(source: { code: string; system: string }): string {
  return `${normalizedSourceSystem(source.system)}\u0000${source.code}`
}

function sourceResolution(dependency: ScenarioCatalogDependency): 'ambiguous' | 'mapped' | 'missing' {
  if (dependency.source === undefined || dependency.mappingKind === undefined) return 'mapped'
  const input = dependency.source
  const resolution = dependency.mappingKind === 'diagnosis'
    ? resolveDiagnosisMapping(input)
    : dependency.mappingKind === 'medication'
      ? resolveMedicationMapping(input)
      : resolveObservationMapping(input)
  if (resolution === undefined) return 'missing'
  if ('status' in resolution) {
    if (resolution.status === 'ambiguous') return 'ambiguous'
    if (resolution.status !== 'mapped') return 'missing'
  }
  return 'mapped'
}

function dependencyResolution(
  baseline: HospitalBaseline,
  dependency: ScenarioCatalogDependency,
): DependencyResolution {
  const mappingResolution = sourceResolution(dependency)
  if (mappingResolution !== 'mapped') return mappingResolution
  return collectionHas(baseline, dependency.collection, dependency.targetId)
    ? 'mapped'
    : 'hospital-not-enabled'
}

const blockerCodes = {
  'critical-truth': {
    ambiguous: 'CRITICAL_DEPENDENCY_AMBIGUOUS',
    missing: 'CRITICAL_DEPENDENCY_MISSING',
  },
  'workflow-required': {
    ambiguous: 'WORKFLOW_DEPENDENCY_AMBIGUOUS',
    missing: 'WORKFLOW_DEPENDENCY_MISSING',
  },
} as const

function blockerCode(
  requirement: ScenarioCatalogDependency['requirement'],
  resolution: Exclude<DependencyResolution, 'mapped'>,
): BlockerCode {
  return blockerCodes[requirement][resolution === 'ambiguous' ? 'ambiguous' : 'missing']
}

function collectionHas(
  baseline: HospitalBaseline,
  collection: ScenarioCatalogCollection,
  targetId: string,
): boolean {
  return (baseline.catalog[collection] ?? []).some(item => item.id === targetId)
}

const requirementCountKeys = {
  'critical-truth': 'criticalTruth',
  'explicitly-ignored': 'explicitlyIgnored',
  'history-only': 'historyOnly',
  'workflow-required': 'workflowRequired',
} as const

const resolutionCountKeys = {
  ambiguous: 'ambiguous',
  'hospital-not-enabled': 'hospitalNotEnabled',
  mapped: 'mapped',
  missing: 'missing',
  'not-applicable': 'notApplicable',
} as const

export function compileScenarioCatalog(input: {
  baseline: HospitalBaseline
  modules: readonly ScenarioModule[]
}) {
  const selected = {
    diagnoses: new Set<string>(),
    investigations: new Set<string>(),
    medications: new Set<string>(),
    services: new Set<string>(),
  }
  const entries: CoverageEntry[] = []
  const blockers: Array<{
    code: BlockerCode
    module: ScenarioModule
    targetId: string
  }> = []

  for (const module of [...new Set(input.modules)]) {
    const definition = scenarioCaseDefinitions[module]
    for (const dependencyValue of definition.catalogDependencies) {
      const dependency: ScenarioCatalogDependency = dependencyValue
      const resolution = dependencyResolution(input.baseline, dependency)
      entries.push({
        module,
        requirement: dependency.requirement,
        resolution,
        ...(dependency.source === undefined ? {} : { source: dependency.source }),
        targetId: dependency.targetId,
      })
      if (resolution === 'mapped') selected[dependency.collection].add(dependency.targetId)
      if (resolution !== 'mapped') {
        blockers.push({
          code: blockerCode(dependency.requirement, resolution),
          module,
          targetId: dependency.targetId,
        })
      }
    }
    entries.push(...definition.coverageOnlyDependencies.map(dependency => ({
      module,
      ...dependency,
    })))
  }

  const addWorkflowDependency = (
    collection: ScenarioCatalogCollection,
    targetId: string,
  ): void => {
    if (selected[collection].has(targetId)) return
    const present = collectionHas(input.baseline, collection, targetId)
    entries.push({
      module: 'baseline-workflow',
      requirement: 'workflow-required',
      resolution: present ? 'mapped' : 'hospital-not-enabled',
      targetId,
    })
    if (present) selected[collection].add(targetId)
  }

  let changed = true
  while (changed) {
    const sizes = Object.values(selected).map(items => items.size).join(':')
    for (const investigation of input.baseline.catalog.investigations) {
      if (!selected.investigations.has(investigation.id)) continue
      for (const componentId of investigation.componentItemIds ?? []) {
        addWorkflowDependency('investigations', componentId)
      }
    }
    for (const service of input.baseline.catalog.services ?? []) {
      if (
        selected.services.has(service.id)
        || service.requestCatalogItemIds.some(id => selected.investigations.has(id))
      ) {
        addWorkflowDependency('services', service.id)
        for (const componentId of service.componentServiceIds ?? []) {
          addWorkflowDependency('services', componentId)
        }
      }
    }
    changed = sizes !== Object.values(selected).map(items => items.size).join(':')
  }

  const services = (input.baseline.catalog.services ?? []).filter(item => selected.services.has(item.id))
  const executingDepartments = new Set(services.map(service => service.executingDepartmentId))
  for (const department of input.baseline.catalog.departments) {
    if (department.registrationAvailable === true || executingDepartments.has(department.id)) {
      entries.push({
        module: 'baseline-workflow',
        requirement: 'workflow-required',
        resolution: 'mapped',
        targetId: department.id,
      })
    }
  }
  const diagnosisCodes = new Set(input.baseline.catalog.diagnoses
    .filter(item => selected.diagnoses.has(item.id))
    .map(item => item.code))
  const medications = input.baseline.catalog.medications
    .filter(item => selected.medications.has(item.id))
    .map(item => ({
      ...item,
      workflow: {
        ...item.workflow,
        allowedCombinationIds: item.workflow.allowedCombinationIds.filter(id => (
          selected.medications.has(id)
        )),
        allowedDiagnosisCodes: item.workflow.allowedDiagnosisCodes.filter(code => (
          diagnosisCodes.has(code)
        )),
      },
    }))
  const compiled = {
    catalog: {
      departments: input.baseline.catalog.departments.filter(item => (
        item.registrationAvailable === true || executingDepartments.has(item.id)
      )),
      diagnoses: input.baseline.catalog.diagnoses.filter(item => selected.diagnoses.has(item.id)),
      investigations: input.baseline.catalog.investigations.filter(item => selected.investigations.has(item.id)),
      medications,
      services,
    },
    hospital: input.baseline.hospital,
    inventory: input.baseline.inventory.filter(lot => selected.medications.has(lot.itemId)),
  }
  const generatedOccurrences = new Map<string, number>()
  for (const concept of inventoryArtifact.generated.inventory.concepts) {
    const key = sourceCodingKey(concept)
    generatedOccurrences.set(key, (generatedOccurrences.get(key) ?? 0) + concept.occurrences)
  }
  const staticOccurrences = new Map<string, number>()
  for (const concept of inventoryArtifact.static.inventory.concepts) {
    const key = sourceCodingKey(concept)
    staticOccurrences.set(key, (staticOccurrences.get(key) ?? 0) + concept.occurrences)
  }
  const classifiedCodingKeys = new Set<string>()
  const coverageEntries: CoverageEntry[] = entries.map((entry) => {
    if (entry.source === undefined) return entry
    if ('resourceType' in entry.source) {
      const resourceType = entry.source.resourceType
      return {
        ...entry,
        generatedOccurrences: inventoryArtifact.generated.inventory.resourceTypes
          .find(item => item.resourceType === resourceType)?.occurrences ?? 0,
        staticOccurrences: 0,
      }
    }
    const key = sourceCodingKey(entry.source)
    classifiedCodingKeys.add(key)
    return {
      ...entry,
      generatedOccurrences: generatedOccurrences.get(key) ?? 0,
      staticOccurrences: staticOccurrences.get(key) ?? 0,
    }
  })
  const selectedModuleClosures = new Map(input.modules.map(module => (
    [module, new Set(inventoryArtifact.static.inventory.rootClosures[module] ?? [])] as const
  )))
  for (const concept of inventoryArtifact.static.inventory.concepts) {
    const module = input.modules.find(candidate => concept.modules.some(sourceModule => (
      selectedModuleClosures.get(candidate)?.has(sourceModule) === true
    )))
    if (module === undefined) continue
    const key = sourceCodingKey(concept)
    if (classifiedCodingKeys.has(key)) continue
    classifiedCodingKeys.add(key)
    coverageEntries.push({
      generatedOccurrences: generatedOccurrences.get(key) ?? 0,
      module,
      requirement: 'history-only',
      resolution: 'hospital-not-enabled',
      source: {
        code: concept.code,
        display: concept.display,
        system: concept.system,
      },
      staticOccurrences: staticOccurrences.get(key) ?? 0,
    })
  }
  for (const concept of inventoryArtifact.generated.inventory.concepts) {
    const key = sourceCodingKey(concept)
    if (classifiedCodingKeys.has(key)) continue
    classifiedCodingKeys.add(key)
    coverageEntries.push({
      generatedOccurrences: generatedOccurrences.get(key) ?? 0,
      module: 'baseline-workflow',
      requirement: 'history-only',
      resolution: 'hospital-not-enabled',
      source: {
        code: concept.code,
        display: concept.display,
        system: concept.system,
      },
      staticOccurrences: staticOccurrences.get(key) ?? 0,
    })
  }
  for (const unit of inventoryArtifact.generated.inventory.units) {
    const key = `unit\u0000${sourceCodingKey(unit)}`
    if (classifiedCodingKeys.has(key)) continue
    classifiedCodingKeys.add(key)
    coverageEntries.push({
      generatedOccurrences: unit.occurrences,
      module: 'baseline-workflow',
      requirement: 'history-only',
      resolution: 'hospital-not-enabled',
      source: {
        code: unit.code,
        display: unit.display,
        system: unit.system,
      },
      staticOccurrences: 0,
    })
  }
  const requirementCounts = {
    criticalTruth: 0,
    explicitlyIgnored: 0,
    historyOnly: 0,
    workflowRequired: 0,
  }
  const resolutionCounts = {
    ambiguous: 0,
    hospitalNotEnabled: 0,
    mapped: 0,
    missing: 0,
    notApplicable: 0,
  }
  for (const entry of coverageEntries) {
    requirementCounts[requirementCountKeys[entry.requirement]] += 1
    resolutionCounts[resolutionCountKeys[entry.resolution]] += 1
  }
  return {
    ...compiled,
    report: {
      blockers,
      caseDefinitions: input.modules.map((module) => {
        const definition = scenarioCaseDefinitions[module]
        const { buildCaseTruth, ...definitionData } = definition
        return {
          contentHash: canonicalJsonHash({
            ...definitionData,
            defaultCaseTruth: buildCaseTruth({ conditions: [], observations: new Map() }),
          }),
          module,
          version: definition.version,
        }
      }),
      catalogHash: canonicalJsonHash(compiled),
      compiler: { id: 'clinmesh-scenario-catalog-compiler' as const, version: '1' },
      counts: {
        requirements: requirementCounts,
        resolutions: resolutionCounts,
      },
      entries: coverageEntries,
      hospitalBaselineHash: canonicalJsonHash(input.baseline),
      sourceInventory: {
        generatedContentHash: inventoryArtifact.generated.contentHash,
        generatedCorpusHash: inventoryArtifact.generated.corpusHash,
        generatedPatientCount: inventoryArtifact.generated.inventory.patientCount,
        staticContentHash: inventoryArtifact.static.contentHash,
        syntheaCommit: inventoryArtifact.syntheaCommit,
      },
      supported: blockers.length === 0,
    },
  }
}
