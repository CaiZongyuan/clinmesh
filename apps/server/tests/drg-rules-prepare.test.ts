import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runDrgRulesPrepare } from '../src/drg-rules-prepare.ts'
import { loadDrgRules } from '../src/infrastructure/reference-data/drg-rules-package.ts'

const directories: string[] = []
afterAll(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))) })

describe('离线 DRG 规则制包入口', () => {
  it('按固定输入哈希可重复制包，保留运行隔离并在输入被改动时拒绝覆盖', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-drg-prepare-'))
    directories.push(directory)
    const inputRoot = join(directory, 'input')
    await mkdir(inputRoot)
    const contents = {
      groups: `${[
        { level: 'MDC', code: 'MDCE', name: '合成呼吸疾病', parentCode: null },
        { level: 'ADRG', code: 'EZ1', name: '合成其他呼吸疾病', parentCode: 'MDCE' },
        { level: 'DRG', code: 'EZ15', name: '合成其他呼吸疾病，不伴合并症或并发症', parentCode: 'EZ1' },
      ].map(row => JSON.stringify(row)).join('\n')}\n`,
      js: 'globalThis.sideEffect = true; return ["U07.000"].includes(x.zdList[0])){Q("符合EZ1入组条件，匹配规则：主诊断匹配");}',
      tables: JSON.stringify({ CC: {}, MCC: {}, CCE: {}, SS_VALID: {} }),
    }
    const inputs = Object.fromEntries(Object.entries(contents).map(([key, content]) => [key, {
      path: `${key}.txt`, sha256: createHash('sha256').update(content).digest('hex'),
    }]))
    for (const [key, content] of Object.entries(contents)) await writeFile(join(inputRoot, `${key}.txt`), content, 'utf8')
    const sourceLockPath = join(directory, 'source.lock.json')
    await writeFile(sourceLockPath, JSON.stringify({ schemaVersion: 'clinmesh.drg-rules-source.v1',
      releaseId: 'synthetic-rules', sourceVersion: 'synthetic-v1', inputs }), 'utf8')
    const outputDirectory = join(directory, 'rules')
    const options = { inputRoot, outputDirectory, sourceLockPath }
    expect(await runDrgRulesPrepare(options)).toMatchObject({ status: 'prepared', runtimeEnabled: false, releaseId: 'synthetic-rules' })
    const manifest = await readFile(join(outputDirectory, 'manifest.json'), 'utf8')
    expect((await loadDrgRules(outputDirectory)).members).toContainEqual({ adrgCode: 'EZ1', code: 'U07.000' })
    expect(await runDrgRulesPrepare(options)).toMatchObject({ status: 'already-prepared', runtimeEnabled: false })
    await writeFile(join(inputRoot, 'js.txt'), `${contents.js}\nchanged`, 'utf8')
    await expect(runDrgRulesPrepare(options)).rejects.toThrow(/input checksum mismatch/)
    expect(await readFile(join(outputDirectory, 'manifest.json'), 'utf8')).toBe(manifest)
    expect(globalThis).not.toHaveProperty('sideEffect')
  })
})
