import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  scenarioModuleSchema,
  syntheaCnLocalizationProvenanceSchema,
} from '@clinmesh/contracts/scenario'
import { z } from 'zod'
import { canonicalJsonHash } from './canonical-json.ts'

const syntheaCodingSchema = z.object({
  code: z.union([z.string(), z.number()]).transform(String),
  display: z.string().min(1),
  system: z.string().min(1),
}).passthrough()

const syntheaQuantityUnitSchema = z.object({
  code: z.string().min(1),
  system: z.string().min(1),
  unit: z.string().min(1),
}).passthrough().transform(value => ({
  code: value.code,
  display: value.unit,
  system: value.system,
}))

const syntheaStateSchema = z.record(z.string(), z.unknown())

const syntheaModuleSchema = z.object({
  name: z.string().min(1),
  states: z.record(z.string(), syntheaStateSchema),
}).passthrough()

const generatedCorpusSchema = z.object({
  bundles: z.array(z.object({
    entry: z.array(z.object({
      resource: z.object({
        resourceType: z.string().min(1),
      }).passthrough(),
    }).passthrough()),
    resourceType: z.literal('Bundle'),
    type: z.literal('collection'),
  }).passthrough()),
  metadata: z.object({
    clinicalSeed: z.number().int(),
    configHash: z.string().min(1),
    localization: syntheaCnLocalizationProvenanceSchema.optional(),
    modules: z.array(z.string().min(1)).min(1),
    populationSeed: z.number().int(),
    syntheaCommit: z.string().regex(/^[a-f0-9]{40}$/),
    timeRange: z.object({
      end: z.iso.date(),
      start: z.iso.date(),
    }).strict(),
    timeZone: z.string().min(1),
  }).strict(),
}).strict()

const inventoryConceptSchema = z.object({
  code: z.string().min(1),
  display: z.string().min(1),
  occurrences: z.number().int().positive(),
  system: z.string().min(1),
}).strict()

const inventoryReproductionSchema = generatedCorpusSchema.shape.metadata
const generatedInventorySchema = z.object({
  concepts: z.array(inventoryConceptSchema),
  patientCount: z.number().int().positive(),
  reproduction: inventoryReproductionSchema,
  resourceTypes: z.array(z.object({
    occurrences: z.number().int().positive(),
    resourceType: z.string().min(1),
  }).strict()),
  units: z.array(inventoryConceptSchema),
}).strict()

export const syntheaDependencyInventoryArtifactSchema = z.object({
  generated: z.object({
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    inventories: z.record(scenarioModuleSchema, z.object({
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      corpusHash: z.string().regex(/^[a-f0-9]{64}$/),
      inventory: generatedInventorySchema,
    }).strict()),
  }).strict(),
  schemaVersion: z.literal('1'),
  static: z.object({
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    inventory: z.object({
      concepts: z.array(inventoryConceptSchema.extend({
        modules: z.array(z.string().min(1)).min(1),
      }).strict()),
      modules: z.array(z.string().min(1)).min(1),
      rootClosures: z.record(z.string(), z.array(z.string().min(1)).min(1)),
      roots: z.record(z.string(), z.array(z.string().min(1)).min(1)),
      syntheaCommit: z.string().regex(/^[a-f0-9]{40}$/),
    }).strict(),
  }).strict(),
  syntheaCommit: z.string().regex(/^[a-f0-9]{40}$/),
}).strict().superRefine((value, context) => {
  if (value.static.inventory.syntheaCommit !== value.syntheaCommit
    || Object.values(value.generated.inventories).some(item => (
      item.inventory.reproduction.syntheaCommit !== value.syntheaCommit
    ))) {
    context.addIssue({
      code: 'custom',
      message: 'Synthea inventory source commits do not match',
      path: ['syntheaCommit'],
    })
  }
  if (canonicalJsonHash(value.static.inventory) !== value.static.contentHash) {
    context.addIssue({
      code: 'custom',
      message: 'Static Synthea inventory content hash does not match',
      path: ['static', 'contentHash'],
    })
  }
  for (const module of scenarioModuleSchema.options) {
    const generated = value.generated.inventories[module]
    if (generated.inventory.reproduction.modules.length !== 1
      || generated.inventory.reproduction.modules[0] !== module) {
      context.addIssue({
        code: 'custom',
        message: 'Generated Synthea inventory module does not match its key',
        path: ['generated', 'inventories', module, 'inventory', 'reproduction', 'modules'],
      })
    }
    if (canonicalJsonHash(generated.inventory) !== generated.contentHash) {
      context.addIssue({
        code: 'custom',
        message: 'Generated Synthea inventory content hash does not match',
        path: ['generated', 'inventories', module, 'contentHash'],
      })
    }
  }
  if (canonicalJsonHash(value.generated.inventories) !== value.generated.contentHash) {
    context.addIssue({
      code: 'custom',
      message: 'Generated Synthea inventory content hash does not match',
      path: ['generated', 'contentHash'],
    })
  }
})

interface InventoryConcept {
  code: string
  display: string
  modules: string[]
  occurrences: number
  system: string
}

function conceptIdentity(concept: Pick<InventoryConcept, 'code' | 'display' | 'system'>): string {
  return `${concept.system}\u0000${concept.code}\u0000${concept.display}`
}

function compareConcepts(
  left: Pick<InventoryConcept, 'code' | 'display' | 'system'>,
  right: Pick<InventoryConcept, 'code' | 'display' | 'system'>,
): number {
  return left.system.localeCompare(right.system)
    || left.code.localeCompare(right.code)
    || left.display.localeCompare(right.display)
}

function codings(value: unknown): Array<z.infer<typeof syntheaCodingSchema>> {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const parsed = syntheaCodingSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

function stateConcepts(state: Record<string, unknown>): Array<z.infer<typeof syntheaCodingSchema>> {
  const concepts = [
    ...codings(state.codes),
    ...codings(state.activities),
  ]
  if (Array.isArray(state.observations)) {
    for (const observation of state.observations) {
      const parsed = syntheaStateSchema.safeParse(observation)
      if (parsed.success) concepts.push(...stateConcepts(parsed.data))
    }
  }
  const prescription = syntheaStateSchema.safeParse(state.prescription)
  if (prescription.success) concepts.push(...codings(prescription.data.instructions))
  const dischargeDisposition = syntheaCodingSchema.safeParse(state.discharge_disposition)
  if (dischargeDisposition.success) concepts.push(dischargeDisposition.data)
  return concepts
}

export async function scanSyntheaStaticInventory(input: {
  moduleDirectory: string
  roots: Record<string, readonly string[]>
  syntheaCommit: string
}) {
  const concepts = new Map<string, InventoryConcept>()
  const dependencies = new Map<string, string[]>()
  const modules: string[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()

  const visit = async (modulePath: string): Promise<void> => {
    if (visited.has(modulePath)) return
    if (visiting.has(modulePath)) {
      throw new Error(`Synthea submodule dependency cycle at ${modulePath}`)
    }
    visiting.add(modulePath)
    let source: string
    try {
      source = await readFile(join(input.moduleDirectory, `${modulePath}.json`), 'utf8')
    } catch (error) {
      throw new Error(`Synthea module was not found: ${modulePath}`, { cause: error })
    }
    let value: unknown
    try {
      value = JSON.parse(source) as unknown
    } catch (error) {
      throw new Error(`Synthea module is not valid JSON: ${modulePath}`, { cause: error })
    }
    const module = syntheaModuleSchema.parse(value)
    modules.push(modulePath)
    const submodules: string[] = []
    for (const state of Object.values(module.states)) {
      for (const coding of stateConcepts(state)) {
        const identity = conceptIdentity(coding)
        const current = concepts.get(identity)
        if (current === undefined) {
          concepts.set(identity, {
            ...coding,
            modules: [modulePath],
            occurrences: 1,
          })
        } else {
          current.occurrences += 1
          if (!current.modules.includes(modulePath)) current.modules.push(modulePath)
        }
      }
      if (state.type === 'CallSubmodule' && typeof state.submodule === 'string') {
        if (!submodules.includes(state.submodule)) submodules.push(state.submodule)
        await visit(state.submodule)
      }
    }
    dependencies.set(modulePath, submodules)
    visiting.delete(modulePath)
    visited.add(modulePath)
  }

  for (const root of Object.values(input.roots).flat()) await visit(root)
  const rootClosures = Object.fromEntries(Object.entries(input.roots).map(([module, roots]) => {
    const closure: string[] = []
    const collect = (modulePath: string): void => {
      if (closure.includes(modulePath)) return
      closure.push(modulePath)
      for (const submodule of dependencies.get(modulePath) ?? []) collect(submodule)
    }
    for (const root of roots) collect(root)
    return [module, closure]
  }))
  return {
    concepts: [...concepts.values()]
      .map(concept => ({ ...concept, modules: concept.modules.sort() }))
      .sort(compareConcepts),
    modules,
    rootClosures,
    roots: Object.fromEntries(Object.entries(input.roots).map(([module, paths]) => (
      [module, [...paths]]
    ))),
    syntheaCommit: input.syntheaCommit,
  }
}

function collectGeneratedCodings(
  value: unknown,
  concepts: Map<string, Omit<InventoryConcept, 'modules'>>,
  units: Map<string, Omit<InventoryConcept, 'modules'>>,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectGeneratedCodings(entry, concepts, units)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'coding' && Array.isArray(entry)) {
      for (const coding of codings(entry)) addGeneratedConcept(concepts, coding)
      continue
    }
    if (key === 'valueQuantity') {
      const unit = syntheaQuantityUnitSchema.safeParse(entry)
      if (unit.success) addGeneratedConcept(units, unit.data)
    }
    collectGeneratedCodings(entry, concepts, units)
  }
}

function addGeneratedConcept(
  inventory: Map<string, Omit<InventoryConcept, 'modules'>>,
  coding: z.infer<typeof syntheaCodingSchema>,
): void {
  const identity = conceptIdentity(coding)
  const current = inventory.get(identity)
  if (current === undefined) {
    inventory.set(identity, { ...coding, occurrences: 1 })
  } else {
    current.occurrences += 1
  }
}

export function inventoryGeneratedSyntheaCorpus(input: unknown) {
  const corpus = generatedCorpusSchema.parse(input)
  const concepts = new Map<string, Omit<InventoryConcept, 'modules'>>()
  const resourceTypes = new Map<string, number>()
  const units = new Map<string, Omit<InventoryConcept, 'modules'>>()
  for (const bundle of corpus.bundles) {
    for (const entry of bundle.entry) {
      resourceTypes.set(
        entry.resource.resourceType,
        (resourceTypes.get(entry.resource.resourceType) ?? 0) + 1,
      )
      collectGeneratedCodings(entry.resource, concepts, units)
    }
  }
  return {
    concepts: [...concepts.values()].sort(compareConcepts),
    patientCount: corpus.bundles.length,
    reproduction: corpus.metadata,
    resourceTypes: [...resourceTypes.entries()]
      .map(([resourceType, occurrences]) => ({ occurrences, resourceType }))
      .sort((left, right) => left.resourceType.localeCompare(right.resourceType)),
    units: [...units.values()].sort(compareConcepts),
  }
}
