import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, expect, it } from 'vitest'
import { create } from 'tar'
import { runGuidelinePrepare } from '../src/guideline-prepare.ts'
import { GuidelineCorpus } from '../src/infrastructure/sqlite/guideline-corpus.ts'
import type { GuidelinePassage } from '../src/application/guideline-corpus.ts'
import { createGuidelineReleaseFixture, guidelineDigest } from './fixtures/guideline-release.ts'
import { syntheticGuidelineDocument } from './fixtures/guideline-corpus.ts'

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
})

async function fixture(passages?: GuidelinePassage[]) {
  const root = await mkdtemp(join(tmpdir(), 'clinmesh-guideline-release-'))
  roots.push(root)
  const input = await createGuidelineReleaseFixture(root, passages)
  let requests = 0
  let bytes: Buffer = await readFile(input.archivePath)
  const server = createServer((_request, response) => { requests++; response.end(bytes) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected TCP test server')
  input.lock.artifact.url = `http://127.0.0.1:${address.port}/guidelines.tar.gz`
  await writeFile(input.lockPath, JSON.stringify(input.lock))
  return { ...input, root, requests: () => requests,
    respondWith: (value: Buffer) => { bytes = value },
    options: { databasePath: join(root, 'new-install', 'guidelines.sqlite'), lockPath: input.lockPath,
      installDirectory: join(root, 'new-install', 'files'), deploymentPolicy: 'internal-testing' as const } }
}

it('从固定包安装到空目录，真实检索正文，完整安装离线重复准备且只读检查不改库', async () => {
  const input = await fixture()
  expect(await runGuidelinePrepare(input.options)).toMatchObject({ created: true, source: 'download',
    sourceCount: 1, originalFileCount: 1, extractedSourceCount: 1, searchableSourceCount: 1 })
  const corpus = new GuidelineCorpus({ databasePath: input.options.databasePath, readOnly: true, deploymentPolicy: 'internal-testing' })
  try {
    expect(corpus.search('糖尿病').guidelines).toContainEqual(expect.objectContaining({ title: input.source.title,
      sourceHash: input.source.sha256, locator: '合成第3节第1段' }))
    expect(corpus.sources()[0]!.source.license.usage).toBe('unverified')
  } finally { corpus.close() }
  const before = await readFile(input.options.databasePath)
  expect(await runGuidelinePrepare(input.options)).toMatchObject({ created: false, source: 'installed' })
  expect(await runGuidelinePrepare({ ...input.options, checkOnly: true })).toMatchObject({ created: false, source: 'installed' })
  expect(await readFile(input.options.databasePath)).toEqual(before)
  expect(input.requests()).toBe(1)
  expect((await readdir(input.options.installDirectory)).filter(name => name.startsWith('.'))).toEqual([])
})

it.each([true, false])('准备统计与实际检索一致，保留但隔离提取异常段落（包含正常段：%s）', async includeUsable => {
  const unusable = { locator: '合成异常段', text: '糖尿病阈值 5\u0002参考值，不能猜测运算符。' }
  const passages = [...(includeUsable ? syntheticGuidelineDocument.passages : []), unusable]
  const input = await fixture(passages)
  const result = await runGuidelinePrepare(input.options)
  expect(result).toMatchObject({ passageCount: passages.length, unusablePassageCount: 1,
    searchableSourceCount: includeUsable ? 1 : 0,
    searchablePassageCount: includeUsable ? syntheticGuidelineDocument.passages.length : 0 })
  expect(result.items[0]).toMatchObject({ unusablePassageCount: 1,
    ...(includeUsable ? {} : { withheldReason: '没有可可靠读取的正文段落' }) })
  const corpus = new GuidelineCorpus({ databasePath: input.options.databasePath, readOnly: true, deploymentPolicy: 'internal-testing' })
  try {
    expect(corpus.sources()[0]).toMatchObject({ passageCount: passages.length, unusablePassageCount: 1 })
    expect(corpus.search('糖尿病').guidelines.every(item => !item.text.includes('\u0002'))).toBe(true)
  } finally { corpus.close() }
})

it('损坏文件修复失败保留旧库与其他来源，恢复下载后修复完整资料', async () => {
  const input = await fixture()
  await runGuidelinePrepare(input.options)
  const writer = new GuidelineCorpus({ databasePath: input.options.databasePath })
  const other = structuredClone(syntheticGuidelineDocument)
  other.source.id = 'separate-maintained-source'
  writer.importDocument(other)
  const before = writer.search('糖尿病')
  writer.close()
  const installedRoot = join(input.options.installDirectory, input.lock.manifest.sha256)
  await writeFile(join(installedRoot, 'original.txt'), 'damaged')
  input.respondWith(Buffer.from('truncated'))
  await expect(runGuidelinePrepare(input.options)).rejects.toThrow('SHA-256 mismatch')
  const preserved = new GuidelineCorpus({ databasePath: input.options.databasePath, readOnly: true })
  try { expect(preserved.search('糖尿病')).toEqual(before); expect(preserved.sources()).toHaveLength(2) }
  finally { preserved.close() }
  expect(await readFile(join(installedRoot, 'original.txt'), 'utf8')).toBe('damaged')
  input.respondWith(await readFile(input.archivePath))
  expect(await runGuidelinePrepare(input.options)).toMatchObject({ source: 'download', created: false })
  expect(await readFile(join(installedRoot, 'original.txt'), 'utf8')).toContain('Synthetic diabetes guidance')
})

it('只读检查缺失安装时不下载、不创建目录或库', async () => {
  const input = await fixture()
  await expect(runGuidelinePrepare({ ...input.options, checkOnly: true })).rejects.toThrow('missing or damaged')
  expect(input.requests()).toBe(0)
  await expect(readdir(join(input.root, 'new-install'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('只读检查发现已加载正文损坏，重复准备修复实际正文而非仅相信存储摘要', async () => {
  const input = await fixture()
  await runGuidelinePrepare(input.options)
  const { default: Database } = await import('better-sqlite3')
  const database = new Database(input.options.databasePath)
  database.prepare('UPDATE guideline_passage SET text = ?').run('damaged-but-same-metadata')
  database.close()
  const before = await readFile(input.options.databasePath)
  await expect(runGuidelinePrepare({ ...input.options, checkOnly: true })).rejects.toThrow('does not match')
  expect(await readFile(input.options.databasePath)).toEqual(before)
  expect(await runGuidelinePrepare(input.options)).toMatchObject({ source: 'installed', created: true })
  const reader = new GuidelineCorpus({ databasePath: input.options.databasePath, readOnly: true, deploymentPolicy: 'internal-testing' })
  try { expect(reader.search('糖尿病').guidelines[0]!.text).toContain('Synthetic diabetes guidance') }
  finally { reader.close() }
})

it.each(['wrong-release', 'missing-file', 'extra-file', 'extraction-limit'] as const)(
  '拒绝不完整或不安全归档且不发布库：%s', async kind => {
    const input = await fixture()
    const physical = ['manifest.json', 'original.txt', 'extracted.json', 'verification.json']
    if (kind === 'wrong-release') input.lock.releaseId = 'different-release'
    else if (kind === 'extraction-limit') input.lock.artifact.unpackedSizeBytes--
    else {
      if (kind === 'missing-file') physical.pop()
      if (kind === 'extra-file') { await writeFile(join(input.inputRoot, 'unexpected.txt'), 'unexpected'); physical.push('unexpected.txt') }
      const path = join(input.root, 'invalid.tar.gz')
      await create({ cwd: input.inputRoot, file: path, gzip: true, portable: true }, physical)
      const bytes = await readFile(path)
      input.respondWith(bytes)
      input.lock.artifact.sha256 = guidelineDigest(bytes)
      input.lock.artifact.sizeBytes = bytes.length
      input.lock.artifact.fileCount = physical.length
      if (kind === 'extra-file') input.lock.artifact.unpackedSizeBytes += 1000
    }
    await writeFile(input.lockPath, JSON.stringify(input.lock))
    await expect(runGuidelinePrepare(input.options)).rejects.toThrow()
    await expect(readFile(input.options.databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(input.options.installDirectory)).toEqual([])
  })

it.each([['../escape', '0'], ['/absolute', '0'], ['linked', '1'], ['symlink', '2'], ['nul.txt', '0'],
  ['C:stream', '0'], ['a\\b', '0']] as const)('拒绝危险归档路径或链接 %s/%s', async (path, type) => {
  const input = await fixture()
  const header = Buffer.alloc(512)
  header.write(path, 0, 100); header.write('0000644\0', 100)
  header.write('0000000\0', 108); header.write('0000000\0', 116)
  header.write(type === '0' ? '00000000001\0' : '00000000000\0', 124)
  header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write(type, 156)
  if (type !== '0') header.write('../../escape', 157)
  header.write('ustar\0', 257)
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148)
  const bytes = gzipSync(Buffer.concat([header, ...(type === '0' ? [Buffer.from('x'), Buffer.alloc(511)] : []), Buffer.alloc(1024)]))
  input.respondWith(bytes)
  Object.assign(input.lock.artifact, { sha256: guidelineDigest(bytes), sizeBytes: bytes.length, fileCount: 1, unpackedSizeBytes: 1 })
  await writeFile(input.lockPath, JSON.stringify(input.lock))
  await expect(runGuidelinePrepare(input.options)).rejects.toThrow()
  await expect(readFile(input.options.databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(input.options.installDirectory)).toEqual([])
})
