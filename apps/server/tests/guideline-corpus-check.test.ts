import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { matchesGuidelineDocuments } from '../src/infrastructure/sqlite/guideline-corpus-check.ts'
import { GuidelineCorpus } from '../src/infrastructure/sqlite/guideline-corpus.ts'
import { syntheticGuidelineDocument } from './fixtures/guideline-corpus.ts'

let afterCopy: (() => void) | undefined
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, copyFileSync: (...args: Parameters<typeof copyFileSync>) => {
    original.copyFileSync(...args)
    const action = afterCopy
    afterCopy = undefined
    action?.()
  } }
})

const roots: string[] = []
afterEach(() => {
  afterCopy = undefined
  for (const path of roots.splice(0)) rmSync(path, { force: true, recursive: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'clinmesh-guideline-snapshot-test-'))
  roots.push(root)
  const databasePath = join(root, 'guidelines.sqlite')
  const writer = new GuidelineCorpus({ databasePath })
  writer.importDocument(syntheticGuidelineDocument)
  return { root, databasePath, writer }
}
function files(root: string, activeWriteTransaction = false) {
  return readdirSync(root).sort().map(name => {
    const path = join(root, name)
    const info = statSync(path, { bigint: true })
    return { name, size: info.size, modified: info.mtimeNs,
      // Windows locks the SHM lock-byte region during a write transaction.
      // Its name/size/mtime remain checked; DB and WAL bytes are still compared.
      digest: activeWriteTransaction && name.endsWith('-shm') ? undefined
        : createHash('sha256').update(readFileSync(path)).digest('hex') }
  })
}

it.each([false, true])('无WAL或空WAL时核对不创建正式sidecar（空WAL：%s）', emptyWal => {
  const input = fixture()
  input.writer.close()
  if (emptyWal) writeFileSync(`${input.databasePath}-wal`, Buffer.alloc(0))
  const before = files(input.root)
  expect(matchesGuidelineDocuments(input.databasePath, [syntheticGuidelineDocument])).toBe(true)
  expect(files(input.root)).toEqual(before)
})

it('包含未checkpoint的已提交WAL内容并忽略未提交帧，正式DB和sidecar字节与mtime不变', () => {
  const input = fixture()
  const driver = new Database(input.databasePath)
  try {
    driver.pragma('wal_checkpoint(TRUNCATE)')
    const latest = structuredClone(syntheticGuidelineDocument)
    latest.passages[0]!.text += ' A committed revision must be visible.'
    input.writer.importDocument(latest)
    expect(statSync(`${input.databasePath}-wal`).size).toBeGreaterThan(32)
    let before = files(input.root)
    expect(matchesGuidelineDocuments(input.databasePath, [latest])).toBe(true)
    expect(matchesGuidelineDocuments(input.databasePath, [syntheticGuidelineDocument])).toBe(false)
    expect(files(input.root)).toEqual(before)
    driver.pragma('cache_size = 1')
    const committedWalBytes = statSync(`${input.databasePath}-wal`).size
    driver.exec('BEGIN IMMEDIATE')
    driver.prepare('UPDATE guideline_passage SET text = text || ?').run(' uncommitted'.repeat(3000))
    expect(statSync(`${input.databasePath}-wal`).size).toBeGreaterThan(committedWalBytes)
    before = files(input.root, true)
    expect(matchesGuidelineDocuments(input.databasePath, [latest])).toBe(true)
    expect(files(input.root, true)).toEqual(before)
    driver.exec('ROLLBACK')
  } finally {
    if (driver.inTransaction) driver.exec('ROLLBACK')
    driver.close()
    input.writer.close()
  }
})

it('复制期间writer提交导致WAL变化时显式失败，普通只读连接继续看到writer的新版本', () => {
  const input = fixture()
  const liveReader = new GuidelineCorpus({ databasePath: input.databasePath, readOnly: true })
  try {
    const changed = structuredClone(syntheticGuidelineDocument)
    changed.passages[0]!.text += ' A concurrent committed publication.'
    afterCopy = () => { input.writer.importDocument(changed) }
    expect(() => matchesGuidelineDocuments(input.databasePath, [syntheticGuidelineDocument])).toThrow('changed during read-only checking')
    expect(liveReader.matchesDocuments([changed])).toBe(true)
    expect(matchesGuidelineDocuments(input.databasePath, [changed])).toBe(true)
  } finally { liveReader.close(); input.writer.close() }
})

it.each(['disappear', 'replace', 'journal'] as const)('复制期间源文件消失、替换或出现journal时拒绝核对：%s', change => {
  const input = fixture()
  input.writer.close()
  afterCopy = () => {
    if (change === 'disappear') rmSync(input.databasePath)
    else if (change === 'replace') {
      const bytes = readFileSync(input.databasePath)
      rmSync(input.databasePath)
      writeFileSync(input.databasePath, bytes)
    } else writeFileSync(`${input.databasePath}-journal`, Buffer.from('active journal'))
  }
  expect(() => matchesGuidelineDocuments(input.databasePath, [syntheticGuidelineDocument])).toThrow('changed during read-only checking')
})
