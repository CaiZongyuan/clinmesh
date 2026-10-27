import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { buildDrgRulesPackageFromFiles } from '../src/drg-rules-build.ts'
import { syntheticDrgIdentity, syntheticDrgSource } from './fixtures/drg-synthetic-program.ts'

it('维护入口验证原始文件身份并发布不可覆盖的规则包，失败保留原产物', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drg-rules-build-'))
  try {
    const groups = [
      { level: 'MDC', code: 'MDCR', parentCode: null, name: '合成系统' },
      { level: 'ADRG', code: 'RA1', parentCode: 'MDCR', name: '合成入口' },
      { level: 'DRG', code: 'RA15', parentCode: 'RA1', name: '合成终端' },
    ]
    const source = syntheticDrgSource(), tables = { CC: {}, MCC: {}, CCE: {}, SS_VALID: [] }
    await writeFile(join(directory, 'source.js'), source)
    await writeFile(join(directory, 'tables.json'), JSON.stringify(tables))
    await writeFile(join(directory, 'groups.jsonl'), groups.map(row => JSON.stringify(row)).join('\n') + '\n')
    const options = { source: join(directory, 'source.js'), tables: join(directory, 'tables.json'), groups: join(directory, 'groups.jsonl'),
      output: join(directory, 'release'), release: 'synthetic-v2', sourceVersion: 'test-v2',
      expectedSourceSha256: syntheticDrgIdentity(source, groups, tables).openDrgJsSha256 }
    await expect(buildDrgRulesPackageFromFiles({ ...options, expectedSourceSha256: '0'.repeat(64) })).rejects.toThrow(/identity mismatch/)
    await buildDrgRulesPackageFromFiles(options)
    const before = await readFile(join(options.output, 'program.json'), 'utf8')
    await expect(buildDrgRulesPackageFromFiles(options)).rejects.toThrow(/already exists/)
    expect(await readFile(join(options.output, 'program.json'), 'utf8')).toBe(before)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
