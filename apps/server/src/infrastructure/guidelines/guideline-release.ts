import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { GuidelineDocument } from '../../application/guideline-corpus.ts'
import { guidelineSourceDefinitionSchema } from '../sqlite/guideline-corpus.ts'

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const guidelineDigest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
// Portable paths also exclude Windows device names, alternate streams and trailing-dot aliases.
export const guidelinePathSchema = z.string().min(1).max(512).refine(path =>
  path.split('/').every(part => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part)
    && !part.endsWith('.') && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)), 'Unsafe guideline path')
export const guidelineFileSchema = z.object({ path: guidelinePathSchema, sha256: digestSchema,
  sizeBytes: z.number().int().positive().max(128 * 1024 * 1024) }).strict()
const extractorSchema = z.object({ name: z.string().min(1), version: z.string().min(1) }).strict()
const passageSchema = z.object({ locator: z.string().trim().min(1).max(512),
  text: z.string().min(1).max(12_000).refine(text => text.trim().length > 0 && !text.includes('\0')) }).strict()
const extractedSchema = z.object({ schemaVersion: z.literal(1), sourceId: z.string().min(1), originalSha256: digestSchema,
  extractor: extractorSchema, passages: z.array(passageSchema).max(100_000) }).strict()
const verificationSchema = z.object({ schemaVersion: z.literal(1), sourceSha256: digestSchema,
  textSha256: digestSchema.nullable(), textStatus: z.enum(['verified', 'pending', 'unreadable']),
  method: z.string().min(1), reviewerKind: z.enum(['automated', 'agent', 'human']), reviewer: z.string().min(1),
  checkedAt: z.iso.date(), manualReview: z.enum(['pending', 'complete']), locators: z.array(z.string().min(1)),
  checks: z.array(z.string().min(1)), notes: z.string().min(1) }).strict()

export const guidelineReleaseManifestSchema = z.object({ schemaVersion: z.literal(1),
  packageId: z.string().regex(/^[a-zA-Z0-9_.-]+$/), releaseId: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  bibliography: guidelineFileSchema.optional(), sources: z.array(z.object({
    group: z.enum(['existing', 'coronary']), inputFilename: z.string().min(1), source: guidelineSourceDefinitionSchema,
    original: guidelineFileSchema, extracted: guidelineFileSchema.optional(), verification: guidelineFileSchema,
    extractionInputs: z.array(guidelineFileSchema).max(16).optional(),
    relatedSourceIds: z.array(z.string().min(1)),
  }).strict()).min(1).max(5_000),
}).strict().refine(manifest => new Set(manifest.sources.map(item => item.source.id)).size === manifest.sources.length,
  'Duplicate guideline source IDs')

const countsSchema = z.object({ sourceCount: z.number().int().positive(), originalFileCount: z.number().int().positive(),
  extractedSourceCount: z.number().int().nonnegative(), verifiedSourceCount: z.number().int().nonnegative(),
  passageCount: z.number().int().nonnegative() }).strict()
export const guidelineReleaseLockSchema = z.object({ schemaVersion: z.literal(1), packageId: z.string().min(1),
  releaseId: z.string().min(1), manifest: guidelineFileSchema, counts: countsSchema,
  artifact: z.object({ url: z.url().refine(value => {
    const url = new URL(value)
    return !url.username && !url.password && (url.protocol === 'https:'
      || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
  }), sha256: digestSchema, sizeBytes: z.number().int().positive().max(2_000_000_000),
  unpackedSizeBytes: z.number().int().positive().max(4_000_000_000), fileCount: z.number().int().positive().max(25_000) }).strict(),
}).strict()
export type GuidelineReleaseLock = z.infer<typeof guidelineReleaseLockSchema>
type FilePin = z.infer<typeof guidelineFileSchema>

async function readPinned(root: string, pin: FilePin): Promise<Buffer> {
  let path = root
  for (const [index, part] of pin.path.split('/').entries()) {
    path = join(path, part)
    const info = await lstat(path)
    const last = index === pin.path.split('/').length - 1
    if (last ? !info.isFile() || info.nlink !== 1 : !info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Guideline files must not contain links: ${pin.path}`)
    }
    if (last && info.size !== pin.sizeBytes) throw new Error(`Guideline size mismatch: ${pin.path}`)
  }
  const bytes = await readFile(path)
  if (bytes.length !== pin.sizeBytes || guidelineDigest(bytes) !== pin.sha256) throw new Error(`Guideline checksum mismatch: ${pin.path}`)
  return bytes
}

export async function inspectGuidelineRelease(inputRoot: string, manifestPin: FilePin) {
  const rootInfo = await lstat(inputRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Guideline root must be a regular directory')
  const manifest = guidelineReleaseManifestSchema.parse(JSON.parse((await readPinned(inputRoot, manifestPin)).toString('utf8')))
  const pins = new Map<string, FilePin>()
  const paths = new Map<string, string>()
  const addPin = (pin: FilePin) => {
    const parts = pin.path.split('/')
    for (let length = 1; length <= parts.length; length++) {
      const path = parts.slice(0, length).join('/')
      const previousPath = paths.get(path.toLowerCase())
      if (previousPath !== undefined && previousPath !== path) throw new Error(`Case-colliding guideline file paths: ${pin.path}`)
      paths.set(path.toLowerCase(), path)
    }
    const previous = pins.get(pin.path)
    if (previous !== undefined && (previous.sha256 !== pin.sha256 || previous.sizeBytes !== pin.sizeBytes)) {
      throw new Error(`Conflicting guideline file identities: ${pin.path}`)
    }
    pins.set(pin.path, pin)
  }
  addPin(manifestPin)
  if (manifest.bibliography !== undefined) addPin(manifest.bibliography)
  const documents: GuidelineDocument[] = []
  const items: Array<{ sourceId: string; textStatus: 'verified' | 'pending' | 'unreadable'; passageCount: number;
    manualReview: 'pending' | 'complete'; reason: string }> = []
  const sourceIds = new Set(manifest.sources.map(item => item.source.id))
  for (const item of manifest.sources) {
    for (const related of item.relatedSourceIds) if (related === item.source.id || !sourceIds.has(related)) throw new Error('Invalid related guideline source')
    if (item.source.distribution !== undefined) throw new Error('Release provenance is assigned by the installer')
    if (item.original.sha256 !== item.source.sha256) throw new Error('Original guideline identity differs from the source registry')
    addPin(item.original); addPin(item.verification)
    for (const pin of item.extractionInputs ?? []) addPin(pin)
    const original = await readPinned(inputRoot, item.original)
    if (item.source.format === 'pdf' && original.subarray(0, 5).toString() !== '%PDF-') throw new Error('Guideline original has no PDF signature')
    const verification = verificationSchema.parse(JSON.parse((await readPinned(inputRoot, item.verification)).toString('utf8')))
    if (verification.sourceSha256 !== item.original.sha256) throw new Error('Guideline verification refers to a different original')
    let passages: GuidelineDocument['passages'] = []
    if (item.extracted !== undefined) {
      addPin(item.extracted)
      const extracted = extractedSchema.parse(JSON.parse((await readPinned(inputRoot, item.extracted)).toString('utf8')))
      if (extracted.sourceId !== item.source.id || extracted.originalSha256 !== item.original.sha256
        || verification.textSha256 !== item.extracted.sha256) throw new Error('Guideline extraction provenance mismatch')
      if (new Set(extracted.passages.map(passage => passage.locator)).size !== extracted.passages.length) throw new Error('Duplicate guideline passage locators')
      passages = extracted.passages
    } else if (verification.textSha256 !== null) throw new Error('Missing verified extraction file')
    if (verification.textStatus === 'verified' && (passages.length === 0 || verification.locators.length === 0
      || verification.checks.length === 0)) throw new Error('Verified guideline requires readable, located original passages')
    documents.push({ source: { ...item.source, distribution: { packageId: manifest.packageId, releaseId: manifest.releaseId,
      textStatus: verification.textStatus, verificationRecord: item.verification.path } }, passages })
    items.push({ sourceId: item.source.id, textStatus: verification.textStatus, passageCount: passages.length,
      manualReview: verification.manualReview, reason: verification.notes })
  }
  for (const pin of pins.values()) await readPinned(inputRoot, pin)
  // Reject unlisted physical files, including hidden files and links in otherwise complete installations.
  const walk = async (directory: string, prefix = ''): Promise<string[]> => {
    const paths: string[] = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name
      if (entry.isDirectory()) paths.push(...await walk(join(directory, entry.name), `${path}/`))
      else if (entry.isFile()) paths.push(path)
      else throw new Error(`Unsupported guideline file: ${path}`)
    }
    return paths
  }
  const physical = await walk(inputRoot)
  if (physical.length !== pins.size || physical.some(path => !pins.has(path))) throw new Error('Guideline release contains unlisted files')
  const counts = { sourceCount: documents.length, originalFileCount: new Set(manifest.sources.map(item => item.original.path)).size,
    extractedSourceCount: manifest.sources.filter(item => item.extracted !== undefined).length,
    verifiedSourceCount: items.filter(item => item.textStatus === 'verified').length,
    passageCount: documents.reduce((total, item) => total + item.passages.length, 0) }
  return { manifest, documents, items, counts, files: [...pins.values()].sort((a, b) => a.path.localeCompare(b.path)),
    unpackedSizeBytes: [...pins.values()].reduce((total, pin) => total + pin.sizeBytes, 0) }
}
