import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GuidelineDocument, GuidelineSourceStatus } from '../../application/guideline-corpus.ts'
import { GuidelineCorpus } from './guideline-corpus.ts'

function fileState(path: string): string | undefined {
  try {
    const info = statSync(path, { bigint: true })
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// SQLite may create/change -shm even for a readonly WAL connection. Preparation
// checks a stable copy instead; runtime readers keep the ordinary live connection.
export function inspectGuidelineDocuments(databasePath: string, documents: readonly GuidelineDocument[],
  options: { preserveRestrictions?: boolean } = {}): { matches: boolean; sources: GuidelineSourceStatus[] } {
  const paths = [databasePath, `${databasePath}-wal`, `${databasePath}-journal`]
  const before = paths.map(fileState)
  if (before[0] === undefined) return { matches: false, sources: [] }
  if (before[2] !== undefined) throw new Error('Guideline database has a rollback journal; retry after its writer finishes')
  const temporary = mkdtempSync(join(tmpdir(), 'clinmesh-guideline-check-'))
  const copy = join(temporary, 'guidelines.sqlite')
  const targets = [copy, `${copy}-wal`, `${copy}-journal`]
  try {
    for (const [index, path] of paths.entries()) if (before[index] !== undefined) copyFileSync(path, targets[index]!)
    // Include WAL bytes, not just the checkpointed database. Reject a concurrent
    // publication/checkpoint instead of accepting a mixture or opening the source.
    const matches = paths.every((path, index) => fileState(path) === before[index]
      && (before[index] === undefined || digest(path) === digest(targets[index]!)))
    if (!matches || paths.some((path, index) => fileState(path) !== before[index])) {
      throw new Error('Guideline database changed during read-only checking; retry after its writer finishes')
    }
    const reader = new GuidelineCorpus({ databasePath: copy })
    try {
      const matches = !reader.schemaUpgraded && reader.matchesDocuments(documents, options) && reader.hasValidSearchIndex()
      return { matches, sources: matches ? reader.sources() : [] }
    } finally { reader.close() }
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

export function matchesGuidelineDocuments(databasePath: string, documents: readonly GuidelineDocument[]): boolean {
  return inspectGuidelineDocuments(databasePath, documents).matches
}
