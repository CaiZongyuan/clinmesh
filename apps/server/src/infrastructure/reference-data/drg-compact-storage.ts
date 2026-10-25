import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { OfflineReferenceLock } from '@clinmesh/contracts/reference-data'
import { z } from 'zod'
import { derivedRecipeSchema, renderDerivedRecipe } from './drg-derived-codecs.ts'
import { normalizedRecipeSchema, renderNormalizedRecipe } from './drg-normalized-codecs.ts'

export const compactFormat = 'clinmesh.drg-compact.v1' as const
export const compactDigest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export function safeArtifactPath(path: string): boolean {
  return !path.includes('\\') && !path.includes(':') && !path.startsWith('/')
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}
const pathSchema = z.string().min(1).refine(safeArtifactPath, 'Invalid artifact path')
const metadataSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().nonnegative().max(4_000_000_000),
}).strict()
export const compactRecipeSchema = z.union([
  z.object({ kind: z.literal('file'), path: pathSchema }).strict(), derivedRecipeSchema, normalizedRecipeSchema,
])
export const compactIndexSchema = z.object({
  schemaVersion: z.literal(compactFormat),
  files: z.record(pathSchema, metadataSchema.extend({ recipe: compactRecipeSchema }).strict()),
  objects: z.record(pathSchema, metadataSchema),
}).strict()
export type CompactIndex = z.infer<typeof compactIndexSchema>

/** Resolve existing directory links even when the output itself does not exist. */
export async function resolveArtifactOutput(path: string): Promise<string> {
  const output = resolve(path)
  let parent = dirname(output)
  const suffix = [basename(output)]
  while (true) {
    try { return join(await realpath(parent), ...suffix) }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT') || parent === dirname(parent)) throw error
      suffix.unshift(basename(parent)); parent = dirname(parent)
    }
  }
}

/** Enumerate original logical files from the pinned, unchanged source indexes. */
export async function listPinnedArtifacts(lock: OfflineReferenceLock, read: (path: string) => Promise<Buffer>): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const sourceIndexSchema = z.object({ files: z.array(z.object({ path: pathSchema, sha256: metadataSchema.shape.sha256 }).loose()) }).loose()
  for (const input of lock.packages) {
    if (!safeArtifactPath(input.root)) throw new Error('Invalid package root path')
    const pins = [input.manifest, ...(input.checksums === undefined ? [] : [input.checksums])]
    for (const pin of pins) {
      if (!safeArtifactPath(pin.path)) throw new Error('Invalid package index path')
      files.set(`${input.root}/${pin.path}`, pin.sha256)
    }
    const pin = input.format === 'prepared-catalogues-v1' ? input.manifest : input.checksums!
    const bytes = await read(`${input.root}/${pin.path}`)
    if (compactDigest(bytes) !== pin.sha256) throw new Error(`Offline index checksum mismatch: ${pin.path}`)
    for (const file of sourceIndexSchema.parse(JSON.parse(bytes.toString('utf8'))).files) {
      const path = `${input.root}/${file.path}`
      const existing = files.get(path)
      if (existing !== undefined && existing !== file.sha256) throw new Error(`Conflicting pinned artifact: ${path}`)
      files.set(path, file.sha256)
    }
  }
  return new Map([...files].sort(([left], [right]) => left.localeCompare(right, 'en')))
}

export async function containedArtifactPath(root: string, path: string): Promise<string> {
  if (!safeArtifactPath(path)) throw new Error(`Invalid artifact path: ${path}`)
  const base = await realpath(root)
  const requested = resolve(base, path)
  const target = await realpath(requested)
  const delta = relative(base, target)
  const info = await lstat(requested)
  const samePath = process.platform === 'win32' ? target.toLowerCase() === requested.toLowerCase() : target === requested
  if (!info.isFile() || info.nlink !== 1 || isAbsolute(delta) || delta === '..' || delta.startsWith(`..${sep}`)
    || !samePath) throw new Error(`Artifact path must be contained and without links: ${path}`)
  return target
}

export interface CompactStorage {
  index: CompactIndex
  read(path: string): Promise<Buffer>
  verifyObjects(): Promise<void>
}

export async function openCompactStorage(lock: OfflineReferenceLock, inputRoot: string): Promise<CompactStorage> {
  const manifest = lock.storage.manifest
  const bytes = await readFile(await containedArtifactPath(inputRoot, manifest.path))
  if (compactDigest(bytes) !== manifest.sha256) throw new Error('Compact storage index checksum mismatch')
  const index = compactIndexSchema.parse(JSON.parse(bytes.toString('utf8')))
  const storageRoot = dirname(manifest.path).replaceAll('\\', '/')
  if (!safeArtifactPath(storageRoot)) throw new Error('Invalid compact storage path')
  const logicalPath = (path: string) => lock.packages.some(input => path.startsWith(`${input.root}/`))
  for (const path of Object.keys(index.files)) if (!logicalPath(path)) throw new Error(`Unlisted logical package path: ${path}`)
  for (const path of Object.keys(index.objects)) {
    if ((!logicalPath(path) && !path.startsWith(`${storageRoot}/`)) || path === manifest.path) throw new Error(`Invalid object path: ${path}`)
  }
  async function object(path: string): Promise<Buffer> {
    const metadata = index.objects[path]
    if (metadata === undefined) throw new Error(`Compact object missing or unlisted: ${path}`)
    const result = await readFile(await containedArtifactPath(inputRoot, path))
    if (result.length !== metadata.sizeBytes || compactDigest(result) !== metadata.sha256) throw new Error(`Compact object checksum or size mismatch: ${path}`)
    return result
  }
  const dependencies = new Map<string, Buffer>()
  async function read(path: string, ancestors = new Set<string>(), dependency = false): Promise<Buffer> {
    if (ancestors.has(path) || ancestors.size >= 32) throw new Error(`Compact recipe dependency cycle: ${path}`)
    const cached = dependency ? dependencies.get(path) : undefined
    if (cached !== undefined) return cached
    const file = index.files[path]
    if (file === undefined) throw new Error(`Compact logical file is unlisted: ${path}`)
    const next = new Set([...ancestors, path])
    const readDependency = (source: string): Promise<Buffer> => index.files[source] === undefined ? object(source) : read(source, next, true)
    const recipe = file.recipe
    const result = recipe.kind === 'file' ? await object(recipe.path)
      : recipe.kind === 'readiness-templates' || recipe.kind === 'member-page-lines'
        ? await renderNormalizedRecipe(recipe, readDependency)
        : await renderDerivedRecipe(recipe, readDependency)
    if (result.length !== file.sizeBytes || compactDigest(result) !== file.sha256) throw new Error(`Compact logical file checksum or size mismatch: ${path}`)
    if (dependency && /\/(?:rules\/rule-dat-pack\.json|drg\/native-page-text\.jsonl)$/.test(path)) dependencies.set(path, result)
    return result
  }
  return {
    index,
    read,
    async verifyObjects() {
      for (const [path, metadata] of Object.entries(index.objects)) {
        const digest = createHash('sha256')
        let size = 0
        for await (const chunk of createReadStream(await containedArtifactPath(inputRoot, path))) { digest.update(chunk); size += chunk.length }
        if (size !== metadata.sizeBytes || digest.digest('hex') !== metadata.sha256) throw new Error(`Compact object checksum or size mismatch: ${path}`)
      }
    },
  }
}
