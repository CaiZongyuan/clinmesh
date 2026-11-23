import { z } from 'zod'
import {
  importReferenceDataRelease,
  openReferenceDatabase,
  verifyReferenceDatabase,
} from '../../src/infrastructure/sqlite/reference-database.ts'

const workerInputSchema = z.discriminatedUnion('mode', [
  z.object({
    databasePath: z.string().min(1),
    manifestPath: z.string().min(1),
    mode: z.literal('import'),
  }),
  z.object({
    databasePath: z.string().min(1),
    mode: z.literal('verify-readonly'),
  }),
])

const input = workerInputSchema.parse(JSON.parse(process.argv[2] ?? '{}'))

let maxSampledRss = process.memoryUsage().rss
const sampler = setInterval(() => {
  const current = process.memoryUsage().rss
  if (current > maxSampledRss) maxSampledRss = current
}, 10)
sampler.unref()

try {
  const database = openReferenceDatabase({
    busyTimeoutMs: 5_000,
    databasePath: input.databasePath,
    ...(input.mode === 'verify-readonly' ? { readonly: true } : {}),
  })
  let result: unknown
  try {
    result = input.mode === 'import'
      ? importReferenceDataRelease(database, input.manifestPath)
      : verifyReferenceDatabase(database)
  } finally {
    database.close()
  }
  clearInterval(sampler)
  const finalRss = process.memoryUsage().rss
  const kernelMaxRss = process.resourceUsage().maxRSS * 1024
  const peakRssBytes = Math.max(maxSampledRss, finalRss, kernelMaxRss)
  process.send?.({ kind: 'ok', peakRssBytes, result })
} catch (error) {
  clearInterval(sampler)
  process.send?.({
    kind: 'error',
    message: error instanceof Error ? error.message : String(error),
  })
  process.exitCode = 1
}
