import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadDrgRules } from '../src/infrastructure/reference-data/drg-rules-package.ts'
import { prepareDrgRulesPackage } from '../src/infrastructure/reference-data/drg-rules-prepare.ts'
import { groupDrgCase } from '../src/application/drg-grouping.ts'
import { syntheticDrgSource, syntheticDrgIdentity } from './fixtures/drg-synthetic-program.ts'
const groups = [
  { level: 'MDC', code: 'MDCR', name: '合成系统', parentCode: null },
  { level: 'ADRG', code: 'RA1', name: '合成入口', parentCode: 'MDCR' },
  { level: 'DRG', code: 'RA15', name: '合成终端', parentCode: 'RA1' },
]
const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
async function writePackage() {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-drg-rules-v2-'))
  directories.push(directory)
  const jsText = syntheticDrgSource(), complicationTables = { CC: {}, MCC: {}, CCE: {} }
  const identity = syntheticDrgIdentity(jsText, groups, complicationTables)
  const files = prepareDrgRulesPackage({ groups, jsText, complicationTables, input: identity, releaseId: 'synthetic-v2', sourceVersion: 'test-v2' })
  for (const [path, content] of Object.entries(files)) await writeFile(join(directory, path), content)
  return { directory, files, identity }
}
describe('完整条件规则包装载', () => {
  it('从持久规则包恢复有序程序及来源身份，所有文件有哈希与行数', async () => {
    const { directory, files, identity } = await writePackage()
    const loaded = await loadDrgRules(directory)
    const manifest = JSON.parse(files['manifest.json']!)
    expect(manifest.schemaVersion).toBe('clinmesh.drg-rules.v2')
    expect(manifest.inputs).toEqual(identity)
    expect(loaded.program.coverage.drgCodes).toEqual(['RA15'])
    for (const file of manifest.files) {
      expect(createHash('sha256').update(files[file.path]!).digest('hex')).toBe(file.sha256)
      expect(files[file.path]!.split('\n').filter(line => line.trim() !== '').length).toBe(file.rows)
    }
    expect(groupDrgCase(loaded, { diagnoses: [{ code: 'I10.x09', role: 'main' }], operations: [], gender: 'female',
      ageYears: 48, ageDays: null, birthWeightGrams: null, dischargeMode: '2', inpatientDays: 2 })).toMatchObject({ status: 'grouped', drgCode: 'RA15' })
  })
  it('内容篡改和缺条件旧格式拒绝装载，历史结果由归档快照独立保留', async () => {
    const { directory } = await writePackage()
    await writeFile(join(directory, 'groups.jsonl'), 'changed\n')
    await expect(loadDrgRules(directory)).rejects.toThrow(/checksum mismatch/)
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    manifest.schemaVersion = 'clinmesh.drg-rules.v1'
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
    await expect(loadDrgRules(directory)).rejects.toThrow()
  })
  it('文件哈希合法仍核对程序引用与完整覆盖，缺条件不能伪装成功', async () => {
    const { directory } = await writePackage()
    const program = JSON.parse(await readFile(join(directory, 'program.json'), 'utf8'))
    delete program.terminals.RA15
    const bytes = JSON.stringify(program) + '\n'
    await writeFile(join(directory, 'program.json'), bytes)
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    manifest.files.find((file: { path: string }) => file.path === 'program.json').sha256 = createHash('sha256').update(bytes).digest('hex')
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
    await expect(loadDrgRules(directory)).rejects.toThrow(/终端|覆盖/)
  })
  it.each([
    { name: '读取未声明变量', error: '未声明变量 missing', statements: [{ kind: 'return', value: { kind: 'variable', name: 'missing' } }] },
    { name: '赋值未声明变量', error: '未声明变量 missing', statements: [{ kind: 'expression', value: { kind: 'assign', name: 'missing', value: { kind: 'literal', value: true } } }] },
    { name: '块内变量遮蔽', error: '重复声明或变量遮蔽 selected', statements: [
      { kind: 'let', name: 'selected', value: { kind: 'literal', value: true } },
      { kind: 'block', statements: [{ kind: 'let', name: 'selected', value: { kind: 'literal', value: false } }] },
      { kind: 'return', value: { kind: 'variable', name: 'selected' } },
    ] },
  ])('哈希合法的规则包仍在装载时拒绝不受支持的变量绑定：$name', async ({ statements, error }) => {
    const { directory } = await writePackage()
    const program = JSON.parse(await readFile(join(directory, 'program.json'), 'utf8'))
    program.terminals.RA15 = statements
    const bytes = JSON.stringify(program) + '\n'
    await writeFile(join(directory, 'program.json'), bytes)
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    manifest.files.find((file: { path: string }) => file.path === 'program.json').sha256 = createHash('sha256').update(bytes).digest('hex')
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
    await expect(loadDrgRules(directory)).rejects.toThrow(error)
  })
})
