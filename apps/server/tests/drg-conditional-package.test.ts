import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadDrgRules } from '../src/infrastructure/reference-data/drg-rules-package.ts'
import { prepareDrgRulesPackage } from '../src/infrastructure/reference-data/drg-rules-prepare.ts'
import { groupDrgCase } from '../src/application/drg-grouping.ts'
import { syntheticDrgIdentity, syntheticDrgSource } from './fixtures/drg-synthetic-program.ts'

const groups = [
  { level: 'MDC', code: 'MDCR', parentCode: null, name: '合成系统' },
  { level: 'ADRG', code: 'RA1', parentCode: 'MDCR', name: '合成入口' },
  { level: 'DRG', code: 'RA15', parentCode: 'RA1', name: '名称不声明任何计算条件' },
]
const complicationTables = { CC: {}, MCC: {}, CCE: {} }

it('规则包保留程序条件而不按组名推断，重载后仍可分组', async () => {
  const jsText = syntheticDrgSource()
  const files = prepareDrgRulesPackage({ groups, jsText, complicationTables,
    input: syntheticDrgIdentity(jsText, groups, complicationTables), releaseId: 'synthetic-condition-v2', sourceVersion: 'test-v2' })
  expect(JSON.parse(files['manifest.json']!).schemaVersion).toBe('clinmesh.drg-rules.v2')
  const directory = await mkdtemp(join(tmpdir(), 'drg-conditional-package-'))
  try {
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(directory, name), bytes)
    const rules = await loadDrgRules(directory)
    expect(groupDrgCase(rules, { diagnoses: [{ code: 'I10.x09', role: 'main' }], operations: [],
      gender: 'female', ageYears: 45, ageDays: null, birthWeightGrams: null, dischargeMode: '2', inpatientDays: 5 }))
      .toMatchObject({ status: 'grouped', drgCode: 'RA15', adrgCode: 'RA1', mdcCode: 'MDCR' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('拒绝源码身份失配与未解析条件，不能生成看似完整的规则包', () => {
  const jsText = syntheticDrgSource()
  const prepare = (source: string, identity: string) => prepareDrgRulesPackage({ groups, jsText: source, complicationTables,
    input: { ...syntheticDrgIdentity(source, groups, complicationTables), openDrgJsSha256: identity },
    releaseId: 'synthetic-condition-v2', sourceVersion: 'test-v2' })
  expect(() => prepare(jsText, '0'.repeat(64))).toThrow(/sha256|identity|身份/i)
  const unknown = jsText.replace('return true', 'return fetch(x.gender)')
  expect(() => prepare(unknown, syntheticDrgIdentity(unknown, groups, complicationTables).openDrgJsSha256)).toThrow()
})
