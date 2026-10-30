import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GuidelinePassage } from '../../src/application/guideline-corpus.ts'
import { createGuidelinePackage } from '../../src/guideline-package.ts'
import { syntheticGuidelineDocument } from './guideline-corpus.ts'

export const guidelineDigest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')

export async function createGuidelineReleaseFixture(root: string, passages: GuidelinePassage[] = syntheticGuidelineDocument.passages) {
  const inputRoot = join(root, 'input')
  await mkdir(inputRoot, { recursive: true })
  const source = structuredClone(syntheticGuidelineDocument.source)
  source.license.usage = 'unverified'
  const original = syntheticGuidelineDocument.passages[0]!.text
  const extracted = JSON.stringify({ schemaVersion: 1, sourceId: source.id, originalSha256: source.sha256,
    extractor: { name: 'synthetic-original-text', version: '1' }, passages })
  const verification = JSON.stringify({ schemaVersion: 1, sourceSha256: source.sha256,
    textSha256: guidelineDigest(extracted), textStatus: 'verified', method: 'synthetic-original-text',
    reviewerKind: 'automated', reviewer: 'synthetic-test', checkedAt: '2026-10-26', manualReview: 'pending',
    locators: passages.slice(0, 1).map(passage => passage.locator), checks: ['original-hash', 'text-identity', 'locator'], notes: '合成测试记录，非医学审校。' })
  const pin = async (path: string, bytes: string) => {
    await writeFile(join(inputRoot, path), bytes)
    return { path, sha256: guidelineDigest(bytes), sizeBytes: Buffer.byteLength(bytes) }
  }
  const manifest = { schemaVersion: 1, packageId: 'synthetic-guidelines', releaseId: 'synthetic-guidelines-v1',
    sources: [{ group: 'existing', inputFilename: 'synthetic.txt', source,
      original: await pin('original.txt', original), extracted: await pin('extracted.json', extracted),
      verification: await pin('verification.json', verification), relatedSourceIds: [] }] }
  await writeFile(join(inputRoot, 'manifest.json'), `${JSON.stringify(manifest)}\n`)
  const archivePath = join(root, 'guidelines.tar.gz')
  const lock = await createGuidelinePackage({ inputRoot, outputPath: archivePath,
    url: 'https://example.org/synthetic-guidelines-v1.tar.gz' })
  const lockPath = join(root, 'lock.json')
  await writeFile(lockPath, JSON.stringify(lock))
  return { inputRoot, archivePath, lockPath, lock, manifest, source }
}
