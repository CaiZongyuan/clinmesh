import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createGuidelinePackage } from '../src/guideline-package.ts'
import { createGuidelineReleaseFixture, guidelineDigest } from './fixtures/guideline-release.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'clinmesh-guideline-package-'))
  roots.push(root)
  return { root, ...await createGuidelineReleaseFixture(root) }
}

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
