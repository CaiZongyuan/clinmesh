import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runDrgRulesPrepare } from '../src/drg-rules-prepare.ts'
import { loadDrgRules } from '../src/infrastructure/reference-data/drg-rules-package.ts'
import { groupDrgCase } from '../src/application/drg-grouping.ts'
import type { CompactIndex } from '../src/infrastructure/reference-data/drg-compact-storage.ts'
import { syntheticDrgSource } from './fixtures/drg-synthetic-program.ts'

const directories: string[] = []
const hash = (content: string) => createHash('sha256').update(content).digest('hex')
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

async function setup(tables: Record<string, unknown> = { CC: {}, MCC: {}, CCE: {}, SS_VALID: [] }) {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-drg-prepare-'))
  directories.push(directory)
  const inputRoot = join(directory, 'input'), packageRoot = '.data/synthetic-source'
  const storageRoot = '.data/drg-compact/v1'
  const contents = {
    groups: `${[
      { level: 'MDC', code: 'MDCR', name: '合成系统', parentCode: null },
      { level: 'ADRG', code: 'RA1', name: '合成入口', parentCode: 'MDCR' },
      { level: 'DRG', code: 'RA15', name: '合成终端', parentCode: 'RA1' },
    ].map(row => JSON.stringify(row)).join('\n')}\n`,
    js: `globalThis.syntheticDrgPrepareExecuted = true;\n${syntheticDrgSource()}`,
    tables: JSON.stringify(tables),
  }
  const inputs = Object.fromEntries(Object.entries(contents).map(([key, content]) => [key, {
    path: `${packageRoot}/${key}.txt`, sha256: hash(content),
  }]))
  const manifestText = JSON.stringify({ files: Object.values(inputs).map(file => ({
    path: file.path.slice(packageRoot.length + 1), sha256: file.sha256,
  })) })
  const index: CompactIndex = { schemaVersion: 'clinmesh.drg-compact.v1', files: {}, objects: {} }
  await mkdir(join(inputRoot, storageRoot), { recursive: true })
  for (const [key, content] of Object.entries({ ...contents, manifest: manifestText })) {
    const path = key === 'manifest' ? `${packageRoot}/manifest.json` : inputs[key]!.path
    const physicalPath = `${storageRoot}/${key}.txt`
    const metadata = { sha256: hash(content), sizeBytes: Buffer.byteLength(content) }
    index.files[path] = { ...metadata, recipe: { kind: 'file', path: physicalPath } }
    index.objects[physicalPath] = metadata
    await writeFile(join(inputRoot, physicalPath), content)
  }
  const indexPath = `${storageRoot}/index.json`, indexText = JSON.stringify(index)
  await writeFile(join(inputRoot, indexPath), indexText)
  const offlineLockPath = join(directory, 'offline.lock.json')
  await writeFile(offlineLockPath, JSON.stringify({ schemaVersion: 'clinmesh.offline-inventory.v1',
    inventoryId: 'synthetic-rules-source', createdAt: '2026-10-25T00:00:00.000Z', scheme: 'CHS-DRG-3.0',
    storage: { format: 'clinmesh.drg-compact.v1', manifest: { path: indexPath, sha256: hash(indexText) } },
    packages: [{ id: 'synthetic-rules-source', format: 'prepared-catalogues-v1', root: packageRoot, version: 'synthetic-v2',
      manifest: { path: 'manifest.json', sha256: hash(manifestText) }, sourceUrl: 'https://example.test/synthetic-source',
      quarantineReasons: ['usage-terms-unconfirmed'] }],
  }))
  const sourceLock = { schemaVersion: 'clinmesh.drg-rules-source.v1', releaseId: 'synthetic-rules-v2', sourceVersion: 'synthetic-v2', inputs }
  const sourceLockPath = join(directory, 'source.lock.json')
  await writeFile(sourceLockPath, JSON.stringify(sourceLock))
  return { directory, contents, sourceLock, options: { inputRoot, outputDirectory: join(directory, 'rules'), sourceLockPath, offlineLockPath } }
}

describe('离线 DRG 规则制包入口', () => {
  it('从当前精简资料生成可装载的 v2 规则，重复准备不覆盖且不执行来源程序', async () => {
    const { options } = await setup()
    expect(await runDrgRulesPrepare(options)).toMatchObject({ status: 'prepared', runtimeEnabled: false, releaseId: 'synthetic-rules-v2' })
    const rules = await loadDrgRules(options.outputDirectory)
    expect(groupDrgCase(rules, { diagnoses: [{ code: 'I10.x09', role: 'main' }], operations: [], gender: 'female',
      ageYears: 48, ageDays: null, birthWeightGrams: null, dischargeMode: 'home', inpatientDays: 2 })).toMatchObject({ status: 'grouped', drgCode: 'RA15' })
    expect(await runDrgRulesPrepare(options)).toMatchObject({ status: 'already-prepared', runtimeEnabled: false })
    expect(globalThis).not.toHaveProperty('syntheticDrgPrepareExecuted')
  })

  it('缺少有效操作参数表时拒绝制包，不把缺项当空表', async () => {
    const { options } = await setup({ CC: {}, MCC: {}, CCE: {} })
    await expect(runDrgRulesPrepare(options)).rejects.toThrow(/SS_VALID/)
  })

  it('已有目录缺少 Manifest 时要求新不可变目录，不能覆盖旧内容', async () => {
    const { options } = await setup()
    await mkdir(options.outputDirectory)
    await writeFile(join(options.outputDirectory, 'retained.txt'), 'retained')
    await expect(runDrgRulesPrepare(options)).rejects.toThrow(/exists without a manifest/)
    expect(await readFile(join(options.outputDirectory, 'retained.txt'), 'utf8')).toBe('retained')
  })

  it.each([
    { table: 'SS_VALID', value: ['36.0000'] },
    { table: 'CC', value: { 'I11.000': '1' } },
  ])('独立参数表 $table 与来源程序不一致时拒绝制包', async ({ table, value }) => {
    const { options } = await setup({ CC: {}, MCC: {}, CCE: {}, SS_VALID: [], [table]: value })
    await expect(runDrgRulesPrepare(options)).rejects.toThrow(`parameter mismatch: ${table}`)
  })

  it.each(['../outside.js', '/outside.js', 'C:/outside.js', '.data\\outside.js'])(
    '拒绝越界或非逻辑来源路径 %s', async path => {
      const { options, sourceLock } = await setup()
      sourceLock.inputs.js!.path = path
      await writeFile(options.sourceLockPath, JSON.stringify(sourceLock))
      await expect(runDrgRulesPrepare(options)).rejects.toThrow(/contained logical path/)
    },
  )

  it('来源锁的哈希必须属于离线清单，不能自行替换来源身份', async () => {
    const { options, sourceLock } = await setup()
    sourceLock.inputs.js!.sha256 = '0'.repeat(64)
    await writeFile(options.sourceLockPath, JSON.stringify(sourceLock))
    await expect(runDrgRulesPrepare(options)).rejects.toThrow(/not pinned by the offline inventory/)
  })

  it('精简对象被篡改时失败，保留已发布规则包', async () => {
    const { options } = await setup()
    await runDrgRulesPrepare(options)
    await writeFile(join(options.inputRoot, '.data/drg-compact/v1/js.txt'), 'changed')
    await expect(runDrgRulesPrepare(options)).rejects.toThrow(/checksum or size mismatch/)
    expect((await loadDrgRules(options.outputDirectory)).rulesId).toBe('synthetic-rules-v2')
  })

  it('不同规则身份不覆盖已有包，同身份坏包也不静默修复', async () => {
    const { options, sourceLock } = await setup()
    await runDrgRulesPrepare(options)
    const manifest = await readFile(join(options.outputDirectory, 'manifest.json'), 'utf8')
    await writeFile(options.sourceLockPath, JSON.stringify({ ...sourceLock, releaseId: 'synthetic-other-release' }))
    await expect(runDrgRulesPrepare(options)).rejects.toThrow(/different rules package/)
    expect(await readFile(join(options.outputDirectory, 'manifest.json'), 'utf8')).toBe(manifest)
    await writeFile(options.sourceLockPath, JSON.stringify(sourceLock))
    await writeFile(join(options.outputDirectory, 'program.json'), 'changed')
    await expect(runDrgRulesPrepare(options)).rejects.toThrow(/checksum mismatch/)
    expect(await readFile(join(options.outputDirectory, 'program.json'), 'utf8')).toBe('changed')
  })
})
