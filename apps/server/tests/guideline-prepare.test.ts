import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, expect, it } from 'vitest'
import { create } from 'tar'
import { runGuidelinePrepare } from '../src/guideline-prepare.ts'
import { runGuidelineSync } from '../src/guideline-sync.ts'
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

async function files(directory: string): Promise<unknown[]> {
  const result: unknown[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    result.push(entry.isDirectory() ? [entry.name, await files(path)]
      : [entry.name, (await stat(path, { bigint: true })).mtimeNs, guidelineDigest(await readFile(path))])
  }
  return result
}

it('从固定包安装到空目录，真实检索正文，完整安装离线重复准备且只读检查不改库', async () => {
  const input = await fixture()
  expect(await runGuidelinePrepare(input.options)).toMatchObject({ created: true, source: 'download',
    sourceCount: 1, originalFileCount: 1, extractedSourceCount: 1, searchableSourceCount: 1 })
  const before = await files(join(input.root, 'new-install'))
  expect(await runGuidelinePrepare(input.options)).toMatchObject({ created: false, source: 'installed' })
  expect(await runGuidelinePrepare({ ...input.options, checkOnly: true })).toMatchObject({ created: false, source: 'installed' })
  expect(await files(join(input.root, 'new-install'))).toEqual(before)
  const corpus = new GuidelineCorpus({ databasePath: input.options.databasePath, readOnly: true, deploymentPolicy: 'internal-testing' })
  try {
    expect(corpus.search('糖尿病').guidelines).toContainEqual(expect.objectContaining({ title: input.source.title,
      sourceHash: input.source.sha256, locator: '合成第3节第1段' }))
    expect(corpus.sources()[0]!.source.license.usage).toBe('unverified')
  } finally { corpus.close() }
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

it('离线重复准备保留维护同步发布的撤回，不能恢复旧建议的检索版本', async () => {
  const input = await fixture()
  await runGuidelinePrepare(input.options)
  const before = new GuidelineCorpus({ databasePath: input.options.databasePath, readOnly: true, deploymentPolicy: 'internal-testing' })
  let originalRevision: string
  try {
    expect(before.search('diabetes').guidelines).toHaveLength(1)
    originalRevision = before.search('diabetes').revision
  } finally { before.close() }
  const registry = join(input.root, 'withdrawn.json')
  await writeFile(registry, JSON.stringify({ schemaVersion: 1, sources: [{ ...input.source, status: 'withdrawn' }] }))
  expect(await runGuidelineSync(['--manifest', registry, '--database', input.options.databasePath], {
    fetch: async () => { throw new Error('Withdrawal must not fetch') },
  })).toMatchObject({ searchableSourceCount: 0, failedSourceCount: 0 })

  expect(await runGuidelinePrepare(input.options)).toMatchObject({ searchableSourceCount: 0,
    items: [{ withheldReason: '来源状态：withdrawn' }] })
  const reader = new GuidelineCorpus({ databasePath: input.options.databasePath, readOnly: true, deploymentPolicy: 'internal-testing' })
  try {
    expect(reader.sources()[0]!.source.status).toBe('withdrawn')
    expect(reader.search('diabetes').guidelines).toEqual([])
    expect(reader.search('diabetes').revision).not.toBe(originalRevision)
  } finally { reader.close() }
  const preserved = await files(join(input.root, 'new-install'))
  expect(await runGuidelinePrepare({ ...input.options, checkOnly: true })).toMatchObject({ created: false, searchableSourceCount: 0 })
  expect(await files(join(input.root, 'new-install'))).toEqual(preserved)
  expect(input.requests()).toBe(1)
})

it.each(['superseded', 'pending', 'unreadable'] as const)('资料修复保留来源限制，只有显式维护可以重新启用：%s', async restriction => {
  const input = await fixture()
  await runGuidelinePrepare(input.options)
  const writer = new GuidelineCorpus({ databasePath: input.options.databasePath })
  const installed = writer.sources()[0]!.source
  try {
    writer.importDocument({ source: restriction === 'superseded' ? { ...installed, status: restriction }
      : { ...installed, distribution: { ...installed.distribution!, textStatus: restriction } }, passages: [] })
  } finally { writer.close() }
  // Repair the loaded metadata from the release while preserving the independently
  // published restriction, even when the original metadata can no longer be read.
  const { default: Database } = await import('better-sqlite3')
  const damaged = new Database(input.options.databasePath)
  damaged.prepare('UPDATE guideline_source SET metadata = ? WHERE id = ?').run('{damaged', input.source.id)
  damaged.close()
  expect(await runGuidelinePrepare(input.options)).toMatchObject({ searchableSourceCount: 0, failedSourceCount: restriction === 'unreadable' ? 1 : 0,
    items: [{ withheldReason: restriction === 'superseded' ? '来源状态：superseded' : `正文核验状态：${restriction}` }] })
  const reader = new GuidelineCorpus({ databasePath: input.options.databasePath, readOnly: true, deploymentPolicy: 'internal-testing' })
  try {
    expect(reader.search('diabetes').guidelines).toEqual([])
    expect(reader.sources()[0]!.source).toMatchObject(restriction === 'superseded' ? { status: restriction }
      : { distribution: { textStatus: restriction } })
  } finally { reader.close() }
  const maintainer = new GuidelineCorpus({ databasePath: input.options.databasePath })
  try { maintainer.importDocument({ source: installed, passages: syntheticGuidelineDocument.passages }) }
  finally { maintainer.close() }
  expect(await runGuidelinePrepare({ ...input.options, checkOnly: true })).toMatchObject({ created: false, searchableSourceCount: 1 })
  expect(input.requests()).toBe(1)
})

it('旧注册表没有正文复核状态时，维护同步不能解除已发布的正文限制', async () => {
  const input = await fixture()
  await runGuidelinePrepare(input.options)
  const writer = new GuidelineCorpus({ databasePath: input.options.databasePath })
  try {
    const source = writer.sources()[0]!.source
    writer.importDocument({ source: { ...source, distribution: { ...source.distribution!, textStatus: 'pending' } }, passages: [] })
  } finally { writer.close() }
  const registry = join(input.root, 'old-registry.json')
  await writeFile(registry, JSON.stringify({ schemaVersion: 1, sources: [input.source] }))
  expect(await runGuidelineSync(['--manifest', registry, '--database', input.options.databasePath, '--cache-dir', join(input.root, 'cache')], {
    fetch: async () => new Response(syntheticGuidelineDocument.passages[0]!.text),
  })).toMatchObject({ failedSourceCount: 1, searchableSourceCount: 0 })
  expect(await runGuidelinePrepare(input.options)).toMatchObject({ searchableSourceCount: 0,
    items: [{ withheldReason: '正文核验状态：pending' }] })
})

it('旧版指南库升级保留已撤回来源，只读检查不迁移正式库', async () => {
  const input = await fixture()
  await runGuidelinePrepare(input.options)
  const writer = new GuidelineCorpus({ databasePath: input.options.databasePath })
  try { writer.importDocument({ source: { ...writer.sources()[0]!.source, status: 'withdrawn' }, passages: syntheticGuidelineDocument.passages }) }
  finally { writer.close() }
  // Version 1 has the same source, passage and FTS tables, without the restriction table.
  const { default: Database } = await import('better-sqlite3')
  const legacy = new Database(input.options.databasePath)
  legacy.exec('DROP TABLE guideline_source_restriction; PRAGMA user_version = 1')
  legacy.close()
  const reader = new GuidelineCorpus({ databasePath: input.options.databasePath, readOnly: true, deploymentPolicy: 'internal-testing' })
  try { expect(reader.search('diabetes').guidelines).toEqual([]) } finally { reader.close() }
  const original = await files(join(input.root, 'new-install'))
  expect(await runGuidelinePrepare({ ...input.options, checkOnly: true })).toMatchObject({ searchableSourceCount: 0 })
  expect(await files(join(input.root, 'new-install'))).toEqual(original)
  const registry = join(input.root, 'legacy-withdrawn.json')
  await writeFile(registry, JSON.stringify({ schemaVersion: 1, sources: [{ ...input.source, status: 'withdrawn' }] }))
  await runGuidelineSync(['--manifest', registry, '--database', input.options.databasePath])
  expect(await runGuidelinePrepare(input.options)).toMatchObject({ searchableSourceCount: 0 })
  expect(await runGuidelinePrepare({ ...input.options, checkOnly: true })).toMatchObject({ searchableSourceCount: 0 })
})

it.each([false, true])('固定包和重复维护同步都不能撤销后续收紧的用途限制（旧库：%s）', async legacy => {
  const input = await fixture()
  const openSource = { ...input.source, license: { ...input.source.license, usage: 'open' as const } }
  // Prepare a release that predates a later restriction of the source rights.
  input.manifest.sources[0]!.source = openSource
  await writeFile(join(input.inputRoot, 'manifest.json'), JSON.stringify(input.manifest))
  const { createGuidelinePackage } = await import('../src/guideline-package.ts')
  const lock = await createGuidelinePackage({ inputRoot: input.inputRoot, outputPath: join(input.root, 'open.tar.gz'), url: input.lock.artifact.url })
  await writeFile(input.lockPath, JSON.stringify(lock))
  input.respondWith(await readFile(join(input.root, 'open.tar.gz')))
  await runGuidelinePrepare(input.options)
  const registry = join(input.root, 'restricted-license.json')
  await writeFile(registry, JSON.stringify({ schemaVersion: 1, sources: [input.source] }))
  const args = ['--manifest', registry, '--database', input.options.databasePath, '--cache-dir', join(input.root, 'cache')]
  for (let attempt = 0; attempt < 2; attempt++) {
    await runGuidelineSync(args, { fetch: async () => new Response(syntheticGuidelineDocument.passages[0]!.text) })
    if (legacy && attempt === 0) {
      const writer = new GuidelineCorpus({ databasePath: input.options.databasePath })
      try { writer.importDocument({ source: input.source, passages: syntheticGuidelineDocument.passages }) } finally { writer.close() }
      const { default: Database } = await import('better-sqlite3')
      const database = new Database(input.options.databasePath)
      database.exec('DROP TABLE guideline_source_restriction; PRAGMA user_version = 1')
      database.close()
    }
    expect(await runGuidelinePrepare(input.options)).toMatchObject({ searchableSourceCount: 0,
      items: [{ withheldReason: '当前部署用途策略未启用该来源' }] })
    if (legacy && attempt === 0) {
      // Even when the effective body already matches, save the inferred legacy
      // restriction before another release happens to use the same license.
      input.manifest.sources[0]!.source = input.source
      await writeFile(join(input.inputRoot, 'manifest.json'), JSON.stringify(input.manifest))
      const nextPath = join(input.root, 'next.tar.gz')
      const next = await createGuidelinePackage({ inputRoot: input.inputRoot, outputPath: nextPath, url: input.lock.artifact.url })
      await writeFile(input.lockPath, JSON.stringify(next))
      input.respondWith(await readFile(nextPath))
      expect(await runGuidelinePrepare(input.options)).toMatchObject({ searchableSourceCount: 0 })
    }
  }
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

it('只读检查拒绝独立损坏的全文索引，离线准备恢复检索并保留其他来源', async () => {
  const input = await fixture()
  await runGuidelinePrepare(input.options)
  const other = structuredClone(syntheticGuidelineDocument)
  other.source.id = 'separate-maintained-source'
  const writer = new GuidelineCorpus({ databasePath: input.options.databasePath })
  writer.importDocument(other)
  writer.close()
  const { default: Database } = await import('better-sqlite3')
  const database = new Database(input.options.databasePath)
  database.exec("INSERT INTO guideline_passage_fts(guideline_passage_fts) VALUES('delete-all')")
  database.close()
  const broken = new GuidelineCorpus({ databasePath: input.options.databasePath, readOnly: true, deploymentPolicy: 'internal-testing' })
  try { expect(broken.search('diabetes').guidelines).toEqual([]) }
  finally { broken.close() }
  const before = await files(join(input.root, 'new-install'))
  await expect(runGuidelinePrepare({ ...input.options, checkOnly: true })).rejects.toThrow('does not match')
  expect(await files(join(input.root, 'new-install'))).toEqual(before)
  expect(await runGuidelinePrepare(input.options)).toMatchObject({ source: 'installed', created: true })
  const restored = new GuidelineCorpus({ databasePath: input.options.databasePath, readOnly: true, deploymentPolicy: 'internal-testing' })
  try {
    expect(restored.search('diabetes').guidelines).toHaveLength(2)
    expect(restored.sources().map(item => item.source.id)).toContain(other.source.id)
  } finally { restored.close() }
  expect(await runGuidelinePrepare({ ...input.options, checkOnly: true })).toMatchObject({ created: false })
  expect(await runGuidelinePrepare(input.options)).toMatchObject({ created: false })
  expect(input.requests()).toBe(1)
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
