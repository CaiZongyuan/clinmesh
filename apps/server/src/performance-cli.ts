import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performanceProfileSchema, assertPerformanceBaseline } from './performance/performance-contract.ts'
import {
  runCiPerformanceProfile,
  runFullImportPerformanceProfile,
  runSaturationPerformanceProfile,
  runTrajectoryPerformanceProfile,
} from './performance/performance-runner.ts'
import baselineData from '../performance-baselines.json' with { type: 'json' }

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

function requiredOption(name: string): string {
  const value = option(name)
  if (value === undefined) throw new Error(`${name} is required`)
  return value
}

async function runProfile(profile: ReturnType<typeof performanceProfileSchema.parse>) {
  switch (profile) {
    case 'ci': return runCiPerformanceProfile()
    case 'trajectory': return runTrajectoryPerformanceProfile()
    case 'saturation': return runSaturationPerformanceProfile()
    case 'full-import': return runFullImportPerformanceProfile(resolve(requiredOption('--manifest')))
  }
}

async function main(): Promise<void> {
  const profile = performanceProfileSchema.parse(option('--profile') ?? 'ci')
  const result = await runProfile(profile)
  if (profile === 'ci') assertPerformanceBaseline(result.workloads, baselineData)
  const output = `${JSON.stringify(result, null, 2)}\n`
  const outputPath = option('--output')
  if (outputPath !== undefined) await writeFile(resolve(outputPath), output, 'utf8')
  process.stdout.write(output)
}

await main()
