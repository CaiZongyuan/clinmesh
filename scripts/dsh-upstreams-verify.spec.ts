import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareManifests, verificationEnvironment } from './dsh-upstreams-verify.ts'
import { parseLock } from './dsh-upstreams.ts'
import { startManagedProcess } from './dsh-upstreams-process.ts'

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
    for (const [index, path] of paths.entries()) await writeFile(join(directory, path), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': index === 2 ? '0.1.7' : '0.1.5-rc.2' } }))
    const before = await Promise.all(paths.map(path => readFile(join(directory, path), 'utf8')))
    await expect(prepareManifests(directory, baseline, target)).rejects.toThrow('人工适配')
    expect(await Promise.all(paths.map(path => readFile(join(directory, path), 'utf8')))).toEqual(before)
  })

  it('候选进程只继承运行工具所需环境，凭证和日常 Profile 不进入子进程', () => {
    const environment = verificationEnvironment('/isolated', {
      PATH: '/tools', GH_TOKEN: 'synthetic-sentinel', NODE_AUTH_TOKEN: 'synthetic-sentinel',
      CLINMESH_AI_API_KEY: 'synthetic-sentinel', CLINMESH_DATABASE_PATH: '/daily/database',
      DSH_HOME: '/daily/profile', DSHVM_HOME: '/daily/versions', npm_config_userconfig: '/daily/npmrc',
    })
    expect(environment.PATH).toBe('/tools')
    expect(environment.DSH_HOME).toBe(join('/isolated', 'data'))
    expect(Object.values(environment)).not.toContain('synthetic-sentinel')
    expect(environment.CLINMESH_DATABASE_PATH).toBeUndefined()
    expect(environment.npm_config_userconfig).toBe(join('/isolated', 'npmrc'))
  })

  it.skipIf(process.platform === 'win32')('launcher 先退出时仍回收其后台子进程', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-upstream-process-'))
    directories.push(directory)
    const heartbeat = join(directory, 'heartbeat')
    const worker = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(heartbeat)},'ready'); process.stdout.write('ready'); setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),20)`
    const launcher = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:['ignore','pipe','ignore']}); child.stdout.once('data',()=>process.exit(0))`
    const managed = startManagedProcess(process.execPath, ['-e', launcher], { env: verificationEnvironment(directory), cwd: directory })
    await new Promise<void>((resolve, reject) => { managed.child.once('close', () => resolve()); managed.child.once('error', reject) })
    await managed.stop()
    const before = await readFile(heartbeat, 'utf8')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(await readFile(heartbeat, 'utf8')).toBe(before)
  })

  it('显式停止等待前台命令结束并移除信号监听', async () => {
    const before = process.listenerCount('SIGTERM')
    const managed = startManagedProcess(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(()=>{},1000)"], { env: verificationEnvironment(tmpdir()) })
    const closed = new Promise(resolve => managed.child.once('close', resolve))
    await new Promise(resolve => managed.child.stdout?.once('data', resolve))
    await managed.stop()
    await closed
    expect(process.listenerCount('SIGTERM')).toBe(before)
    expect(managed.child.exitCode !== null || managed.child.signalCode !== null).toBe(true)
  })
})
