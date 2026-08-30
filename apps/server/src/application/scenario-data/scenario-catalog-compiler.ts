import type {
  ScenarioDatasetContent,
  ScenarioModule,
} from '@clinmesh/contracts/scenario'
import { resolveDiagnosisMapping } from './diagnosis-coding-package.ts'
import { resolveMedicationMapping } from './medication-coding-package.ts'
import { resolveObservationMapping, resolveUcumUnit } from './reference-coding-package.ts'
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
  const modules = [...new Set(input.modules)]
  const selected = {
    diagnoses: new Set<string>(),
    investigations: new Set<string>(),
    medications: new Set<string>(),
    services: new Set<string>(),
  }
  const origins = {
    diagnoses: new Map<string, Set<ScenarioModule>>(),
    investigations: new Map<string, Set<ScenarioModule>>(),
    medications: new Map<string, Set<ScenarioModule>>(),
    services: new Map<string, Set<ScenarioModule>>(),
  }
  let closureRevision = 0
  const entries: CoverageEntry[] = []
  const blockers: Array<{
    code: BlockerCode
    module: ScenarioModule
    targetId: string
  }> = []
  const mergeOrigins = (
    collection: ScenarioCatalogCollection,
    targetId: string,
    requiredBy: ReadonlySet<ScenarioModule>,
  ): void => {
    const current = origins[collection].get(targetId) ?? new Set<ScenarioModule>()
    for (const module of requiredBy) {
      if (current.has(module)) continue
      current.add(module)
      closureRevision += 1
    }
    origins[collection].set(targetId, current)
  }
  const addMissingWorkflowBlockers = (
    requiredBy: ReadonlySet<ScenarioModule>,
    targetId: string,
  ): void => {
    for (const module of requiredBy) {
      if (blockers.some(blocker => blocker.module === module && blocker.targetId === targetId)) continue
      blockers.push({ code: 'WORKFLOW_DEPENDENCY_MISSING', module, targetId })
    }
  }

  for (const module of modules) {
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
      if (resolution === 'mapped') {
        selected[dependency.collection].add(dependency.targetId)
        mergeOrigins(dependency.collection, dependency.targetId, new Set([module]))
      }
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
    requiredBy: ReadonlySet<ScenarioModule>,
  ): void => {
    if (selected[collection].has(targetId)) {
      mergeOrigins(collection, targetId, requiredBy)
      return
    }
    const present = collectionHas(input.baseline, collection, targetId)
    if (!entries.some(entry => (
      entry.requirement === 'workflow-required' && entry.targetId === targetId
    ))) {
      entries.push({
        module: requiredBy.values().next().value ?? 'baseline-workflow',
        requirement: 'workflow-required',
        resolution: present ? 'mapped' : 'hospital-not-enabled',
        targetId,
      })
    }
    if (present) {
      selected[collection].add(targetId)
      closureRevision += 1
      mergeOrigins(collection, targetId, requiredBy)
    } else {
      addMissingWorkflowBlockers(requiredBy, targetId)
    }
  }

  let changed = true
  while (changed) {
    const previousRevision = closureRevision
    for (const investigation of input.baseline.catalog.investigations) {
      if (!selected.investigations.has(investigation.id)) continue
      const requiredBy = origins.investigations.get(investigation.id) ?? new Set()
      for (const componentId of investigation.componentItemIds ?? []) {
        addWorkflowDependency('investigations', componentId, requiredBy)
      }
    }
    for (const service of input.baseline.catalog.services ?? []) {
      const requiredBy = new Set(origins.services.get(service.id) ?? [])
      for (const requestCatalogItemId of service.requestCatalogItemIds) {
        for (const module of origins.investigations.get(requestCatalogItemId) ?? []) {
          requiredBy.add(module)
        }
      }
      if (requiredBy.size === 0) continue
      addWorkflowDependency('services', service.id, requiredBy)
      const serviceOrigins = origins.services.get(service.id) ?? requiredBy
      for (const componentId of service.componentServiceIds ?? []) {
        addWorkflowDependency('services', componentId, serviceOrigins)
      }
    }
    changed = previousRevision !== closureRevision
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
  const inventory = input.baseline.inventory.filter(lot => selected.medications.has(lot.itemId))
  for (const medication of medications) {
    if (inventory.some(lot => lot.itemId === medication.id)) continue
    const requiredBy = origins.medications.get(medication.id) ?? new Set()
    entries.push({
      module: requiredBy.values().next().value ?? 'baseline-workflow',
      requirement: 'workflow-required',
      resolution: 'hospital-not-enabled',
      targetId: `inventory:${medication.id}`,
    })
    addMissingWorkflowBlockers(requiredBy, `inventory:${medication.id}`)
  }
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
    inventory,
  }
  const selectedGeneratedInventories = modules.map(module => ({
    module,
    ...inventoryArtifact.generated.inventories[module],
  }))
  const generatedOccurrences = new Map<string, number>()
  for (const generated of selectedGeneratedInventories) {
    for (const concept of generated.inventory.concepts) {
      const key = sourceCodingKey(concept)
      generatedOccurrences.set(key, (generatedOccurrences.get(key) ?? 0) + concept.occurrences)
    }
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
        generatedOccurrences: selectedGeneratedInventories.reduce((sum, generated) => (
          sum + (generated.inventory.resourceTypes
            .find(item => item.resourceType === resourceType)?.occurrences ?? 0)
        ), 0),
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
  const selectedModuleClosures = new Map(modules.map(module => (
    [module, new Set(inventoryArtifact.static.inventory.rootClosures[module] ?? [])] as const
  )))
  for (const concept of inventoryArtifact.static.inventory.concepts) {
    const module = modules.find(candidate => concept.modules.some(sourceModule => (
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
  for (const generated of selectedGeneratedInventories) {
    for (const concept of generated.inventory.concepts) {
      const key = sourceCodingKey(concept)
      if (classifiedCodingKeys.has(key)) continue
      classifiedCodingKeys.add(key)
      coverageEntries.push({
        generatedOccurrences: generatedOccurrences.get(key) ?? 0,
        module: generated.module,
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
  }
  const generatedUnits = new Map<string, {
    module: ScenarioModule
    occurrences: number
    source: { code: string; display: string; system: string }
  }>()
  for (const generated of selectedGeneratedInventories) {
    for (const unit of generated.inventory.units) {
      const key = `unit\u0000${sourceCodingKey(unit)}`
      const current = generatedUnits.get(key)
      generatedUnits.set(key, {
        module: current?.module ?? generated.module,
        occurrences: (current?.occurrences ?? 0) + unit.occurrences,
        source: { code: unit.code, display: unit.display, system: unit.system },
      })
    }
  }
  for (const [key, unit] of generatedUnits) {
    if (classifiedCodingKeys.has(key)) continue
    classifiedCodingKeys.add(key)
    coverageEntries.push({
      generatedOccurrences: unit.occurrences,
      module: unit.module,
      requirement: 'history-only',
      resolution: resolveUcumUnit(unit.source) === undefined ? 'hospital-not-enabled' : 'mapped',
      source: unit.source,
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
      caseDefinitions: modules.map((module) => {
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
        generated: selectedGeneratedInventories.map(generated => ({
          contentHash: generated.contentHash,
          corpusHash: generated.corpusHash,
          module: generated.module,
          patientCount: generated.inventory.patientCount,
        })),
        staticContentHash: inventoryArtifact.static.contentHash,
        syntheaCommit: inventoryArtifact.syntheaCommit,
      },
      supported: blockers.length === 0,
    },
  }
}
