import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { scenarioModuleSchema } from '@clinmesh/contracts/scenario'
import { scenarioCaseDefinitions } from './application/scenario-data/scenario-case-definitions.ts'
import { canonicalJsonHash } from './application/scenario-data/canonical-json.ts'
import {
  inventoryGeneratedSyntheaCorpus,
  scanSyntheaStaticInventory,
} from './application/scenario-data/synthea-dependency-inventory.ts'

const syntheaCommit = 'd9d07a6eef91ee5144293b42ab64224d84d124f8'

function option(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} is required`)
  }
  return resolve(value)
}

async function main(): Promise<void> {
  const moduleDirectory = option('--module-directory')
  const corpusDirectory = option('--corpus-directory')
  const outputPath = option('--output')
  const staticInventory = await scanSyntheaStaticInventory({
    moduleDirectory,
    roots: Object.fromEntries(Object.entries(scenarioCaseDefinitions).map(([module, definition]) => (
      [module, definition.syntheaModules]
    ))),
    syntheaCommit,
  })
  const generatedInventories = Object.fromEntries(await Promise.all(
    scenarioModuleSchema.options.map(async (module) => {
      const corpus = JSON.parse(await readFile(resolve(corpusDirectory, `${module}.json`), 'utf8')) as unknown
      const inventory = inventoryGeneratedSyntheaCorpus(corpus)
      const fixedCorpusIdentity = {
        clinicalSeed: 7331,
        modules: [module],
        patientCount: 10,
        populationSeed: 4242,
        syntheaCommit,
        timeRange: { end: '2026-08-01', start: '1986-08-01' },
        timeZone: 'Asia/Shanghai',
      }
      const actualCorpusIdentity = {
        clinicalSeed: inventory.reproduction.clinicalSeed,
        modules: inventory.reproduction.modules,
        patientCount: inventory.patientCount,
        populationSeed: inventory.reproduction.populationSeed,
        syntheaCommit: inventory.reproduction.syntheaCommit,
        timeRange: inventory.reproduction.timeRange,
        timeZone: inventory.reproduction.timeZone,
      }
      if (canonicalJsonHash(actualCorpusIdentity) !== canonicalJsonHash(fixedCorpusIdentity)) {
        throw new Error(`Generated ${module} corpus does not match the fixed inventory parameters`)
      }
      return [module, {
        contentHash: canonicalJsonHash(inventory),
        corpusHash: canonicalJsonHash(corpus),
        inventory,
      }] as const
    }),
  ))
  const artifact = {
    generated: {
      contentHash: canonicalJsonHash(generatedInventories),
      inventories: generatedInventories,
    },
    schemaVersion: '1',
    static: {
      contentHash: canonicalJsonHash(staticInventory),
      inventory: staticInventory,
    },
    syntheaCommit,
  }
  const generated = Object.values(generatedInventories)
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({
    generatedConcepts: generated.reduce((sum, item) => sum + item.inventory.concepts.length, 0),
    generatedResources: generated.reduce((sum, item) => sum + item.inventory.resourceTypes
      .reduce((resourceSum, resource) => resourceSum + resource.occurrences, 0), 0),
    output: outputPath,
    patients: generated.reduce((sum, item) => sum + item.inventory.patientCount, 0),
    staticConcepts: staticInventory.concepts.length,
    staticModules: staticInventory.modules.length,
  })}\n`)
}

await main()
