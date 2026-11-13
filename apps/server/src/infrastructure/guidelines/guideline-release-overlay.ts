import { z } from 'zod'
import defaultOverlayJson from '../../../reference-data/guideline-release-overlay.json' with { type: 'json' }
import { isGuidelinePassageUsable, type GuidelineDocument } from '../../application/guideline-corpus.ts'
import { guidelineSourceDefinitionSchema } from '../sqlite/guideline-corpus.ts'
import { guidelineDigest } from './guideline-release.ts'

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const identitySchema = z.string().trim().min(1).max(256)
const physicalPagePrefix = /^PDF 物理第 (\d+) 页/

export const guidelineReleaseOverlaySchema = z.object({
  schemaVersion: z.literal(1),
  packageId: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  releaseId: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  sources: z.record(identitySchema, z.object({
    population: z.enum(['adult', 'pediatric', 'all']),
    specialty: identitySchema,
  }).strict()),
  errata: z.array(z.object({
    sourceId: identitySchema,
    sourceSha256: digestSchema,
    originalLocator: z.string().trim().min(1).max(2_000),
    beforeSha256: digestSchema,
    afterLocator: z.string().trim().min(1).max(2_000),
    afterSha256: digestSchema,
    afterText: z.string().min(1).max(12_000),
    reason: z.string().trim().min(1).max(2_000),
  }).strict()).max(1_000),
}).strict().refine(
  overlay => new Set(overlay.errata.map(item => `${item.sourceId}\0${item.originalLocator}`)).size === overlay.errata.length,
  'Duplicate guideline release errata targets',
)

export type GuidelineReleaseOverlay = z.infer<typeof guidelineReleaseOverlaySchema>
export const defaultGuidelineReleaseOverlay: GuidelineReleaseOverlay = guidelineReleaseOverlaySchema.parse(defaultOverlayJson)

export function applyGuidelineReleaseOverlay<
  T extends { manifest: { packageId: string; releaseId: string }; documents: GuidelineDocument[] },
>(snapshot: T, overlay: GuidelineReleaseOverlay): T {
  const parsed = guidelineReleaseOverlaySchema.parse(overlay)
  if (parsed.packageId !== snapshot.manifest.packageId || parsed.releaseId !== snapshot.manifest.releaseId) {
    throw new Error(`Guideline release overlay identity mismatch: expected ${snapshot.manifest.packageId}@${snapshot.manifest.releaseId}`)
  }
  const snapshotSourceIds = snapshot.documents.map(document => document.source.id)
  const overlaySourceIds = Object.keys(parsed.sources)
  if (snapshotSourceIds.length !== overlaySourceIds.length
    || snapshotSourceIds.some(sourceId => parsed.sources[sourceId] === undefined)) {
    throw new Error('Guideline release overlay requires 1-to-1 coverage of all release sources')
  }
  const documentsById = new Map(snapshot.documents.map(document => [document.source.id, document]))
  const errataBySource = new Map<string, GuidelineReleaseOverlay['errata']>()
  for (const erratum of parsed.errata) {
    const target = documentsById.get(erratum.sourceId)
    if (target === undefined || target.source.sha256 !== erratum.sourceSha256) {
      throw new Error(`Guideline release erratum target source mismatch: ${erratum.sourceId}`)
    }
    if (guidelineDigest(erratum.afterText) !== erratum.afterSha256) {
      throw new Error(`Guideline release erratum afterSha256 mismatch: ${erratum.sourceId}`)
    }
    if (!isGuidelinePassageUsable({ text: erratum.afterText })) {
      throw new Error(`Guideline release erratum afterText is not usable: ${erratum.sourceId}`)
    }
    const originalPage = physicalPagePrefix.exec(erratum.originalLocator)?.[1]
    const afterPage = physicalPagePrefix.exec(erratum.afterLocator)?.[1]
    if (originalPage !== undefined && afterPage !== originalPage) {
      throw new Error(`Guideline release erratum must preserve physical page locator prefix: ${erratum.sourceId}`)
    }
    errataBySource.set(erratum.sourceId, [...(errataBySource.get(erratum.sourceId) ?? []), erratum])
  }
  const documents = snapshot.documents.map(document => {
    const meta = parsed.sources[document.source.id]!
    const source = guidelineSourceDefinitionSchema.parse({ ...document.source, ...meta })
    const sourceErrata = errataBySource.get(source.id)
    if (sourceErrata === undefined) return { ...document, source }
    const passages = document.passages.map(passage => ({ ...passage }))
    for (const erratum of sourceErrata) {
      const indices = passages.flatMap((passage, index) => passage.locator === erratum.originalLocator ? [index] : [])
      if (indices.length !== 1) {
        throw new Error(`Guideline release erratum locator not uniquely found: ${source.id} (${erratum.originalLocator})`)
      }
      const index = indices[0]!
      const current = passages[index]!
      if (guidelineDigest(current.text) !== erratum.beforeSha256) {
        throw new Error(`Guideline release erratum beforeSha256 mismatch: ${source.id} (${erratum.originalLocator})`)
      }
      passages[index] = { locator: erratum.afterLocator, text: erratum.afterText }
    }
    if (new Set(passages.map(passage => passage.locator)).size !== passages.length) {
      throw new Error(`Guideline release errata produced duplicate locators: ${source.id}`)
    }
    return { source, passages }
  })
  return { ...snapshot, documents }
}
