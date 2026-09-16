import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { listReferenceDataReleases, openReferenceDatabase } from './infrastructure/sqlite/reference-database.ts'

const lockSchema = z.object({ compositeRelease: z.object({ releaseId: z.string().min(1) }) })

export function referenceDatabaseIsReady(databasePath: string, repositoryRoot: string, releaseId?: string): boolean {
  if (!existsSync(databasePath)) return false
  const expected = releaseId ?? lockSchema.parse(JSON.parse(readFileSync(join(repositoryRoot, 'reference-data.lock.json'), 'utf8'))).compositeRelease.releaseId
  let database: ReturnType<typeof openReferenceDatabase> | undefined
  try {
    database = openReferenceDatabase({ databasePath, busyTimeoutMs: 5_000, readonly: true })
    return listReferenceDataReleases(database).items.some(release => release.releaseId === expected)
  } catch {
    return false
  } finally {
    database?.close()
  }
}
