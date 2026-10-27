import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createGuidelinePackage } from '../src/guideline-package.ts'
import { inspectGuidelineRelease } from '../src/infrastructure/guidelines/guideline-release.ts'
import { createGuidelineReleaseFixture, guidelineDigest } from './fixtures/guideline-release.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'clinmesh-guideline-package-'))
  roots.push(root)
  return { root, ...await createGuidelineReleaseFixture(root) }
}

async function updateVerification(input: Awaited<ReturnType<typeof fixture>>, patch: Record<string, unknown>) {
  const path = join(input.inputRoot, 'verification.json')
  const bytes = JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), ...patch })
  await writeFile(path, bytes)
  Object.assign(input.manifest.sources[0]!.verification, { sha256: guidelineDigest(bytes), sizeBytes: Buffer.byteLength(bytes) })
  await writeFile(join(input.inputRoot, 'manifest.json'), JSON.stringify(input.manifest))
}

async function inspect(input: Awaited<ReturnType<typeof fixture>>) {
  const bytes = await readFile(join(input.inputRoot, 'manifest.json'))
  return inspectGuidelineRelease(input.inputRoot, { path: 'manifest.json', sha256: guidelineDigest(bytes), sizeBytes: bytes.length })
}

async function pinJson(input: Awaited<ReturnType<typeof fixture>>, path: string, value: unknown) {
  const bytes = JSON.stringify(value)
  await writeFile(join(input.inputRoot, path), bytes)
  return { path, sha256: guidelineDigest(bytes), sizeBytes: Buffer.byteLength(bytes) }
}

async function reviewedFixture() {
  const input = await fixture()
  const original = JSON.parse(await readFile(join(input.inputRoot, 'extracted.json'), 'utf8'))
  original.passages.push({ locator: '合成第4节第1段', text: 'Independent synthetic passage outside the selected review scope.' })
  const current = structuredClone(original)
  current.passages[0] = { locator: '合成校对后第3节第1段', text: 'Corrected synthetic diabetes guidance with original-page review.' }
  const originalPin = await pinJson(input, 'before.json', original)
  const currentPin = await pinJson(input, 'extracted.json', current)
  Object.assign(input.manifest.sources[0]!.extracted, currentPin)
  const review = { schemaVersion: 1, sourceId: input.source.id, sourceSha256: input.source.sha256,
    originalExtractionSha256: originalPin.sha256, reviewerKind: 'agent', corrections: [{
      physicalPage: 3, originalLocator: original.passages[0].locator,
      beforeSha256: guidelineDigest(original.passages[0].text), afterSha256: guidelineDigest(current.passages[0].text),
      before: original.passages[0].text, after: current.passages[0].text,
    }] }
  const reviewPin = await pinJson(input, 'review.json', review)
  const otherInput = 'Non-JSON synthetic extraction input; preserve its pinned bytes.'
  await writeFile(join(input.inputRoot, 'input.txt'), otherInput)
  const extractionInputs = [originalPin, reviewPin,
    { path: 'input.txt', sha256: guidelineDigest(otherInput), sizeBytes: Buffer.byteLength(otherInput) }]
  Object.assign(input.manifest.sources[0]!, { extractionInputs })
  await updateVerification(input, { textSha256: currentPin.sha256 })
  return { ...input, original, current, originalPin, review, reviewPin, extractionInputs }
}

it('已固定的显式校对摘要链允许旧位置指向唯一的当前正文，兼容局部校对及非JSON输入', async () => {
  const input = await reviewedFixture()
  expect((await inspect(input)).counts).toMatchObject({ verifiedSourceCount: 1, passageCount: 2 })
  expect((await createGuidelinePackage({ inputRoot: input.inputRoot, outputPath: join(input.root, 'reviewed.tar.gz'),
    url: input.lock.artifact.url })).counts).toMatchObject({ verifiedSourceCount: 1, passageCount: 2 })
})

it.each(['review-source', 'review-original', 'missing-original-pin', 'extraction-source', 'extraction-original',
  'before-hash', 'after-hash', 'before-record', 'after-record', 'old-locator', 'duplicate-old-locator',
  'ambiguous-current-text', 'ambiguous-reviews', 'duplicate-correction', 'duplicate-resolved', 'duplicate-resolved-aliases'] as const)(
  '制包和检查拒绝断裂、跨源、歧义或重复的校对链：%s', async kind => {
    const input = await reviewedFixture()
    const correction = input.review.corrections[0]!
    if (kind === 'review-source') input.review.sourceId = 'different-synthetic-source'
    if (kind === 'review-original') input.review.sourceSha256 = 'a'.repeat(64)
    if (kind === 'missing-original-pin') input.review.originalExtractionSha256 = 'a'.repeat(64)
    if (kind === 'extraction-source') input.original.sourceId = 'different-synthetic-source'
    if (kind === 'extraction-original') input.original.originalSha256 = 'a'.repeat(64)
    if (kind === 'before-hash') correction.beforeSha256 = 'a'.repeat(64)
    if (kind === 'after-hash') correction.afterSha256 = 'a'.repeat(64)
    if (kind === 'before-record') correction.before = 'Different synthetic pre-correction text.'
    if (kind === 'after-record') correction.after = 'Different synthetic corrected text.'
    if (kind === 'old-locator') correction.originalLocator = '合成不存在的第999页'
    if (kind === 'duplicate-old-locator') input.original.passages.push({ ...input.original.passages[0] })
    if (kind === 'duplicate-correction') input.review.corrections.push({ ...correction })
    if (kind === 'duplicate-resolved-aliases') {
      input.original.passages.push({ ...input.original.passages[0], locator: '合成另一旧位置' })
      input.review.corrections.push({ ...correction, originalLocator: '合成另一旧位置' })
    }
    if (kind === 'extraction-source' || kind === 'extraction-original' || kind === 'duplicate-old-locator' || kind === 'duplicate-resolved-aliases') {
      Object.assign(input.originalPin, await pinJson(input, input.originalPin.path, input.original))
      input.review.originalExtractionSha256 = input.originalPin.sha256
    }
    if (kind === 'ambiguous-current-text') {
      input.current.passages.push({ ...input.current.passages[0], locator: '合成另一个位置但同正文' })
      Object.assign(input.manifest.sources[0]!.extracted, await pinJson(input, 'extracted.json', input.current))
    }
    if (kind === 'ambiguous-reviews') {
      const other = { ...input.review, corrections: [{ ...correction, after: input.current.passages[1].text,
        afterSha256: guidelineDigest(input.current.passages[1].text) }] }
      input.extractionInputs.push(await pinJson(input, 'other-review.json', other))
    }
    Object.assign(input.reviewPin, await pinJson(input, input.reviewPin.path, input.review))
    await updateVerification(input, { textSha256: input.manifest.sources[0]!.extracted.sha256,
      ...(kind === 'duplicate-resolved' ? { locators: [correction.originalLocator, input.current.passages[0].locator] }
        : kind === 'duplicate-resolved-aliases' ? { locators: [correction.originalLocator, '合成另一旧位置'] } : {}) })
    const message = kind === 'duplicate-resolved' || kind === 'duplicate-resolved-aliases' ? 'Duplicate resolved guideline verification locators'
      : 'Guideline verification locator does not match extracted passages'
    await expect(inspect(input)).rejects.toThrow(message)
    await expect(createGuidelinePackage({ inputRoot: input.inputRoot, outputPath: join(input.root, 'bad.tar.gz'),
      url: input.lock.artifact.url })).rejects.toThrow(message)
  })

it.each(['wrong', 'stale', 'duplicate'] as const)('制包和检查拒绝已核验记录中的无效校对位置：%s', async kind => {
  const input = await fixture()
  const verification = JSON.parse(await readFile(join(input.inputRoot, 'verification.json'), 'utf8'))
  if (kind === 'stale') {
    const path = join(input.inputRoot, 'extracted.json')
    const extracted = JSON.parse(await readFile(path, 'utf8'))
    extracted.passages[0].locator = '合成修订后第3节第1段'
    const bytes = JSON.stringify(extracted)
    await writeFile(path, bytes)
    Object.assign(input.manifest.sources[0]!.extracted, { sha256: guidelineDigest(bytes), sizeBytes: Buffer.byteLength(bytes) })
    await updateVerification(input, { textSha256: guidelineDigest(bytes) })
  } else {
    await updateVerification(input, { locators: kind === 'wrong' ? ['合成不存在的第999页']
      : [verification.locators[0], verification.locators[0]] })
  }
  const outputPath = join(input.root, 'bad.tar.gz')
  const message = kind === 'duplicate' ? 'Duplicate guideline verification locators' : 'Guideline verification locator does not match extracted passages'
  await expect(inspect(input)).rejects.toThrow(message)
  await expect(createGuidelinePackage({ inputRoot: input.inputRoot, outputPath,
    url: input.lock.artifact.url })).rejects.toThrow(message)
  await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('制包和检查允许只校对选定段落，不能要求全文校对', async () => {
  const input = await fixture()
  const path = join(input.inputRoot, 'extracted.json')
  const extracted = JSON.parse(await readFile(path, 'utf8'))
  extracted.passages.push({ locator: '合成第4节第1段', text: 'Additional synthetic passage outside the selected verification scope.' })
  const bytes = JSON.stringify(extracted)
  await writeFile(path, bytes)
  Object.assign(input.manifest.sources[0]!.extracted, { sha256: guidelineDigest(bytes), sizeBytes: Buffer.byteLength(bytes) })
  await updateVerification(input, { textSha256: guidelineDigest(bytes), locators: ['合成第3节第1段'] })
  expect((await inspect(input)).counts).toMatchObject({ verifiedSourceCount: 1, passageCount: 2 })
  expect((await createGuidelinePackage({ inputRoot: input.inputRoot, outputPath: join(input.root, 'selected.tar.gz'),
    url: input.lock.artifact.url })).counts).toMatchObject({ verifiedSourceCount: 1, passageCount: 2 })
})

it.each(['pending', 'unreadable'] as const)('无正文的%s记录保留待核验范围和原因且不标为已核验', async textStatus => {
  const input = await fixture()
  await rm(join(input.inputRoot, 'extracted.json'))
  Reflect.deleteProperty(input.manifest.sources[0]!, 'extracted')
  await updateVerification(input, { textStatus, textSha256: null, locators: ['待核验的合成原件第1页'], notes: '合成正文尚待核验。' })
  const inspected = await inspect(input)
  expect(inspected.counts).toMatchObject({ extractedSourceCount: 0, verifiedSourceCount: 0, passageCount: 0 })
  expect(inspected.items[0]).toMatchObject({ textStatus, reason: '合成正文尚待核验。' })
  expect(inspected.documents[0]).toMatchObject({ source: { distribution: { textStatus } }, passages: [] })
  expect((await createGuidelinePackage({ inputRoot: input.inputRoot, outputPath: join(input.root, `${textStatus}.tar.gz`),
    url: input.lock.artifact.url })).counts).toMatchObject({ extractedSourceCount: 0, verifiedSourceCount: 0 })
})

it('相同原件、正文与核验清单生成相同固定包和内容锁', async () => {
  const input = await fixture()
  const second = join(input.root, 'second.tar.gz')
  const lock = await createGuidelinePackage({ inputRoot: input.inputRoot, outputPath: second, url: input.lock.artifact.url })
  expect(await readFile(second)).toEqual(await readFile(input.archivePath))
  expect(lock).toEqual(input.lock)
})

it('相同精确路径与内容允许复用文件且只打包一次', async () => {
  const input = await fixture()
  await writeFile(join(input.inputRoot, 'manifest.json'), JSON.stringify({ ...input.manifest,
    bibliography: input.manifest.sources[0]!.original }))
  const lock = await createGuidelinePackage({ inputRoot: input.inputRoot, outputPath: join(input.root, 'shared.tar.gz'),
    url: input.lock.artifact.url })
  expect(lock.counts).toEqual(input.lock.counts)
  expect(lock.artifact.fileCount).toBe(input.lock.artifact.fileCount)
})

it.each(['Original.txt', 'Manifest.json'])('制包前拒绝仅大小写不同的文件别名：%s', async path => {
  const input = await fixture()
  const original = input.manifest.sources[0]!.original
  const alias = { ...original, path }
  await writeFile(join(input.inputRoot, alias.path), await readFile(join(input.inputRoot, original.path)))
  await writeFile(join(input.inputRoot, 'manifest.json'), JSON.stringify({ ...input.manifest, bibliography: alias }))
  const outputPath = join(input.root, 'bad.tar.gz')
  await expect(createGuidelinePackage({ inputRoot: input.inputRoot, outputPath,
    url: input.lock.artifact.url })).rejects.toThrow('Case-colliding guideline file paths')
  await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('制包前拒绝共用目录的大小写别名', async () => {
  const input = await fixture()
  const original = input.manifest.sources[0]!.original
  await mkdir(join(input.inputRoot, 'docs'))
  await mkdir(join(input.inputRoot, 'Docs'), { recursive: true })
  await rename(join(input.inputRoot, original.path), join(input.inputRoot, 'docs', original.path))
  original.path = 'docs/original.txt'
  const bibliography = { ...original, path: 'Docs/notes.txt' }
  await writeFile(join(input.inputRoot, bibliography.path), await readFile(join(input.inputRoot, original.path)))
  await writeFile(join(input.inputRoot, 'manifest.json'), JSON.stringify({ ...input.manifest, bibliography }))
  await expect(createGuidelinePackage({ inputRoot: input.inputRoot, outputPath: join(input.root, 'bad.tar.gz'),
    url: input.lock.artifact.url })).rejects.toThrow('Case-colliding guideline file paths')
})

it('拒绝有正确文件哈希却绑定其他来源的派生正文', async () => {
  const input = await fixture()
  const path = join(input.inputRoot, 'extracted.json')
  const extracted = JSON.parse(await readFile(path, 'utf8'))
  extracted.originalSha256 = 'a'.repeat(64)
  const bytes = JSON.stringify(extracted)
  await writeFile(path, bytes)
  const manifest = input.manifest
  manifest.sources[0]!.extracted = { path: 'extracted.json', sha256: guidelineDigest(bytes), sizeBytes: Buffer.byteLength(bytes) }
  await writeFile(join(input.inputRoot, 'manifest.json'), JSON.stringify(manifest))
  await expect(createGuidelinePackage({ inputRoot: input.inputRoot, outputPath: join(input.root, 'bad.tar.gz'),
    url: input.lock.artifact.url })).rejects.toThrow('provenance mismatch')
})

it('未通过正文核验的来源保留原件与原因，不能冒充已核验正文', async () => {
  const input = await fixture()
  const verification = JSON.parse(await readFile(join(input.inputRoot, 'verification.json'), 'utf8'))
  verification.locators = []
  const bytes = JSON.stringify(verification)
  await writeFile(join(input.inputRoot, 'verification.json'), bytes)
  input.manifest.sources[0]!.verification = { path: 'verification.json', sha256: guidelineDigest(bytes), sizeBytes: Buffer.byteLength(bytes) }
  await writeFile(join(input.inputRoot, 'manifest.json'), JSON.stringify(input.manifest))
  await expect(createGuidelinePackage({ inputRoot: input.inputRoot, outputPath: join(input.root, 'bad.tar.gz'),
    url: input.lock.artifact.url })).rejects.toThrow('Verified guideline requires')
})
