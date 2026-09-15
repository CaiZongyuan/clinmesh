import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareManifests } from './dsh-upstreams-verify.ts'
import { parseLock } from './dsh-upstreams.ts'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

describe('候选安装准备入口', () => {
  it('人工修改的依赖不能被候选覆盖，拒绝前不写任何文件', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-upstream-test-'))
    directories.push(directory)
    const baseline = parseLock({ schemaVersion: 1, hostDependencyLock: 'deployment/dsh/host/package-lock.json', profileDependencyLock: 'deployment/dsh/profile/pnpm-lock.yaml', components: [{ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2', source: 'https://registry.npmjs.org/dsh.tgz', integrity: 'sha512-YQ==', owner: 'https://github.com/example/host', role: '宿主' }] })
    const target = structuredClone(baseline)
    target.components.find(item => item.name === '@deepseek-ai/dsh')!.version = '0.1.6'
    await mkdir(join(directory, 'deployment/dsh/host'), { recursive: true })
    await mkdir(join(directory, 'deployment/dsh/profile'), { recursive: true })
    await mkdir(join(directory, 'apps/dsh-web'), { recursive: true })
    const paths = ['deployment/dsh/host/package.json', 'deployment/dsh/profile/package.json', 'apps/dsh-web/package.json']
    for (const path of paths) await writeFile(join(directory, path), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.1.7' } }))
    const before = await readFile(join(directory, paths[0]!), 'utf8')
    await expect(prepareManifests(directory, baseline, target)).rejects.toThrow('人工适配')
    expect(await readFile(join(directory, paths[0]!), 'utf8')).toBe(before)
  })
})
