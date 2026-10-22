import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { drgRulesSchema } from '@clinmesh/contracts/drg'
import { buildDrgRules } from '../src/infrastructure/reference-data/drg-rules-builder.ts'
import { extractOfficialMembers } from '../src/infrastructure/reference-data/drg-opendrg-extract.ts'
import { loadDrgRules, prepareDrgRulesPackage } from '../src/infrastructure/reference-data/drg-rules-package.ts'

const groups = [
  { level: 'MDC', code: 'MDCE', name: '呼吸系统疾病', parentCode: null },
  { level: 'ADRG', code: 'EZ1', name: '其他呼吸系统疾病', parentCode: 'MDCE' },
  { level: 'DRG', code: 'EZ15', name: '其他呼吸系统疾病，不伴合并症或并发症', parentCode: 'EZ1' },
]
const jsText = 'return ["A19.800","U07.000"].includes(x.zdList[0])){Q("符合EZ1入组条件，匹配规则：主诊断匹配");}'
const complicationTables = { CC: { 'J18.900x003': '2' }, MCC: { 'I50.000x002': '1' }, CCE: { 'U07.000': '2' } }

const directories: string[] = []
afterAll(async () => {
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })))
})

async function writePackage(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-drg-rules-'))
  directories.push(directory)
  const files = prepareDrgRulesPackage({
    groups, jsText, complicationTables,
    input: { openDrgJsSha256: 'a'.repeat(64), openDrgTablesSha256: 'b'.repeat(64), r3GroupsSha256: 'c'.repeat(64) },
    releaseId: 'chs-drg-30-test', sourceVersion: 'DRG-3.0-test',
  })
  for (const [path, content] of Object.entries(files)) await writeFile(join(directory, path), content, 'utf8')
  return directory
}

describe('DRG 规则数据包物化与加载', () => {
  it('物化产物经 loadDrgRules 重建出与直接构建一致的规则集', async () => {
    const directory = await writePackage()
    const loaded = await loadDrgRules(directory)
    const direct = buildDrgRules({
      groups, officialMembers: extractOfficialMembers(jsText),
      complicationTables: { cc: complicationTables.CC, mcc: complicationTables.MCC, cce: complicationTables.CCE },
    })
    expect(drgRulesSchema.parse(loaded)).toEqual(drgRulesSchema.parse(direct))
    expect(loaded.members).toContainEqual({ code: 'U07.000', adrgCode: 'EZ1' })
    expect(loaded.exclusionGroups).toContainEqual({ code: 'U07.000', groupRef: '2' })
  })

  it('manifest 登记各文件 sha256 与行数，输入哈希可追溯', async () => {
    const directory = await writePackage()
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    expect(manifest.schemaVersion).toBe('clinmesh.drg-rules.v1')
    expect(manifest.releaseId).toBe('chs-drg-30-test')
    expect(manifest.inputs).toEqual({
      openDrgJsSha256: 'a'.repeat(64), openDrgTablesSha256: 'b'.repeat(64), r3GroupsSha256: 'c'.repeat(64),
    })
    for (const file of manifest.files) {
      const content = await readFile(join(directory, file.path), 'utf8')
      expect(createHash('sha256').update(content).digest('hex')).toBe(file.sha256)
      expect(content.split('\n').filter(line => line.trim() !== '').length).toBe(file.rows)
    }
  })

  it('内容被篡改时加载显式失败，不静默降级', async () => {
    const directory = await writePackage()
    const groupsPath = join(directory, 'groups.jsonl')
    await writeFile(groupsPath, (await readFile(groupsPath, 'utf8')).replace('呼吸系统疾病', '循环系统疾病'), 'utf8')
    await expect(loadDrgRules(directory)).rejects.toThrow(/checksum mismatch/)
  })
})
