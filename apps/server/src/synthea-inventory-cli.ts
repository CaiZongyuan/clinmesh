import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
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
  const corpusPath = option('--corpus')
  const outputPath = option('--output')
  const staticInventory = await scanSyntheaStaticInventory({
    moduleDirectory,
    roots: Object.fromEntries(Object.entries(scenarioCaseDefinitions).map(([module, definition]) => (
      [module, definition.syntheaModules]
    ))),
    syntheaCommit,
  })
  const corpus = JSON.parse(await readFile(corpusPath, 'utf8')) as unknown
  const generatedInventory = inventoryGeneratedSyntheaCorpus(corpus)
  if (generatedInventory.reproduction.syntheaCommit !== syntheaCommit) {
    throw new Error('Generated corpus Synthea commit does not match the fixed source commit')
  }
  const fixedCorpusIdentity = {
    clinicalSeed: 7331,
    modules: ['fever', 'type-2-diabetes', 'hypertension'],
    patientCount: 10,
    populationSeed: 4242,
    timeRange: { end: '2026-08-01', start: '1986-08-01' },
    timeZone: 'Asia/Shanghai',
  }
  const actualCorpusIdentity = {
    clinicalSeed: generatedInventory.reproduction.clinicalSeed,
    modules: generatedInventory.reproduction.modules,
    patientCount: generatedInventory.patientCount,
    populationSeed: generatedInventory.reproduction.populationSeed,
    timeRange: generatedInventory.reproduction.timeRange,
    timeZone: generatedInventory.reproduction.timeZone,
  }
  if (canonicalJsonHash(actualCorpusIdentity) !== canonicalJsonHash(fixedCorpusIdentity)) {
    throw new Error('Generated corpus does not match the fixed inventory parameters')
  }
  const artifact = {
    generated: {
      contentHash: canonicalJsonHash(generatedInventory),
      corpusHash: canonicalJsonHash(corpus),
      inventory: generatedInventory,
    },
    schemaVersion: '1',
    static: {
      contentHash: canonicalJsonHash(staticInventory),
      inventory: staticInventory,
    },
    syntheaCommit,
  }
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({
    generatedConcepts: generatedInventory.concepts.length,
    generatedResources: generatedInventory.resourceTypes.reduce((sum, item) => sum + item.occurrences, 0),
    output: outputPath,
    patients: generatedInventory.patientCount,
    staticConcepts: staticInventory.concepts.length,
    staticModules: staticInventory.modules.length,
  })}\n`)
}

await main()
