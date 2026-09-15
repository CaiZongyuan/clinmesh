import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { appendFile, chmod, cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { candidatePath, lockDigest, parseCandidate, parseLock, type UpstreamLock } from './dsh-upstreams.ts'

const execute = promisify(execFile)
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('非法 package.json 对象')
  return Object.fromEntries(Object.entries(value))
}
async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}
async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function restoreInstallerBinMode(root: string) {
  if (process.platform === 'win32') return
  const cwd = join(root, 'vendor/dsh-react-surface')
  const path = 'packages/build/src/cli.ts'
  const tracked = await execute('git', ['ls-tree', 'HEAD', '--', path], { cwd })
  if (!tracked.stdout.startsWith('100644 ')) return
  const original = await execute('git', ['show', `HEAD:${path}`], { cwd, encoding: 'buffer' })
  const current = await readFile(join(cwd, path))
  if (current.equals(original.stdout)) await chmod(join(cwd, path), 0o644)
}

export async function prepareManifests(root: string, baseline: UpstreamLock, target: UpstreamLock) {
  const oldHost = baseline.components.find(item => item.name === '@deepseek-ai/dsh')?.version
  const newHost = target.components.find(item => item.name === '@deepseek-ai/dsh')?.version
  if (!oldHost || !newHost) throw new Error('缺少 DSH 宿主版本')
  const writes: { path: string; manifest: Record<string, unknown> }[] = []
  for (const path of ['deployment/dsh/host/package.json', 'deployment/dsh/profile/package.json', 'apps/dsh-web/package.json']) {
    const manifest = record(await readJson(join(root, path)))
    let changed = false
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (!manifest[section]) continue
      const dependencies = record(manifest[section])
      for (const [name, version] of Object.entries(dependencies)) {
        if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
        if (version !== oldHost && version !== newHost) throw new Error(`保留人工适配：${path} ${name}=${String(version)}；请手动协调候选`)
        if (version !== newHost) { dependencies[name] = newHost; changed = true }
      }
      manifest[section] = dependencies
    }
    if (changed) writes.push({ path, manifest })
  }
  for (const { path, manifest } of writes) await writeJson(join(root, path), manifest)
  return writes.map(item => item.path)
}

async function run(command: string, args: string[], cwd: string, log: string, env = process.env) {
  let bin = command
  let parameters = args
  if (command === 'pnpm' && process.env.npm_execpath) {
    bin = process.execPath
    parameters = [process.env.npm_execpath, ...args]
  } else if (command === 'npm' && process.platform === 'win32') {
    bin = process.execPath
    parameters = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args]
  }
  const started = Date.now()
  const heading = `\n$ ${command} ${args.join(' ')}\n`
  console.log(heading.trim())
  await appendFile(log, heading)
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, parameters, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', chunk => { chunks.push(chunk); process.stdout.write(chunk) })
    child.stderr.on('data', chunk => { chunks.push(chunk); process.stderr.write(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      const output = Buffer.concat(chunks).toString('utf8')
      appendFile(log, `${output}\nexit=${code} durationMs=${Date.now() - started}\n`)
        .then(() => code === 0 ? resolve(output) : reject(new Error(`${command} 失败，退出码 ${code}；候选保持待适配`)), reject)
    })
  })
}

async function verifyBridgeHost(path: string, expected: string) {
  const manifest = record(await readJson(path))
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (!manifest[section]) continue
    for (const [name, version] of Object.entries(record(manifest[section]))) {
      if (name.startsWith('@deepseek-ai/dsh-') && version !== expected) {
        throw new Error(`${manifest.name} 的 ${name}=${String(version)} 不匹配候选宿主 ${expected}；需要 owner 适配，不能自动降低宿主版本`)
      }
    }
  }
}

async function smokeHost(cli: string, runtime: string, expected: string, log: string) {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法分配 smoke 端口')
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  const env = { ...process.env, DSH_HOME: join(runtime, 'data') }
  const version = await execute(process.execPath, [cli, '--version'], { env, windowsHide: true })
  if (!version.stdout.includes(expected)) throw new Error('实际 DSH 版本与候选不匹配')
  const child = spawn(process.execPath, [cli, 'web', '--port', String(port), '--no-open'], {
    cwd: runtime, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let failure: Error | undefined
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  child.on('error', error => { failure = error })
  try {
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      if (failure) throw failure
      if (child.exitCode !== null) throw new Error('候选 DSH 启动失败')
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })
        if (response.ok && (await response.text()).includes('<html')) return
      } catch { /* 启动期间端口尚未监听。 */ }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error('候选 DSH Web 启动超时')
  } finally {
    if (child.pid && child.exitCode === null) {
      if (process.platform === 'win32') await execute('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(() => undefined)
      else { try { process.kill(-child.pid, 'SIGTERM') } catch { /* 进程已退出。 */ } }
    }
    await appendFile(log, `\nDSH ${expected} Web smoke\n${output}\n`)
  }
}

export async function verifyCandidate(root: string) {
  const branch = await execute('git', ['branch', '--show-current'], { cwd: root })
  if (['main', 'master'].includes(branch.stdout.trim())) throw new Error('不能在主分支准备候选；请使用独立升级 checkout')
  const candidate = parseCandidate(await readJson(join(root, candidatePath)))
  const baseline = parseLock(await readJson(join(root, 'dsh-upstreams.lock.json')))
  const baselineDigest = lockDigest(baseline)
  const receiptPath = join(root, 'deployment/dsh/automation.json')
  const receipt = existsSync(receiptPath) ? record(await readJson(receiptPath)) : undefined
  const previouslyPrepared = receipt?.schemaVersion === 1 && receipt.baselineDigest === candidate.baselineDigest && receipt.targetDigest === baselineDigest
  if (candidate.baselineDigest !== baselineDigest && lockDigest(candidate.target) !== baselineDigest && !previouslyPrepared) throw new Error('候选基线已变化，请重新发现或人工协调适配提交')
  await restoreInstallerBinMode(root)
  const dirty = await execute('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root })
  if (dirty.stdout.trim()) throw new Error('验收必须在干净的独立 checkout 中运行，保留未提交改动')
  const evidence = join(root, '.upstream-evidence')
  await mkdir(evidence, { recursive: true })
  const log = join(evidence, 'verification.log')
  await writeFile(log, '')
  const runtime = await mkdtemp(join(tmpdir(), 'clinmesh-upstream-'))
  const target = candidate.target
  const host = target.components.find(item => item.name === '@deepseek-ai/dsh')!
  const manager = target.components.find(item => item.name === '@dsh-so/dshvm')!
  const surface = target.components.find(item => item.name === 'dsh-react-surface')!
  const bridge = target.components.find(item => item.name === 'dsh-ag-ui')!
  if (!host?.version || !manager?.version || !surface?.commit || !bridge?.commit) throw new Error('候选缺少必要组合组件')
  const env = {
    ...process.env,
    pnpm_config_verify_deps_before_run: 'error',
    DSH_HOME: join(runtime, 'data'),
    DSHVM_HOME: join(runtime, 'versions'),
    DSHVM_BIN_DIR: join(runtime, 'bin'),
  }
  try {
    await prepareManifests(root, baseline, target)
    const checkout = join(root, 'vendor/dsh-react-surface')
    const actual = (await execute('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim()
    const previous = baseline.components.find(item => item.name === surface.name)?.commit
    if (actual !== previous && actual !== surface.commit) throw new Error('保留人工适配的 React Surface commit；请协调候选')
    await run('git', ['fetch', surface.source, surface.commit], checkout, log)
    await run('git', ['checkout', '--detach', surface.commit], checkout, log)
    await verifyBridgeHost(join(checkout, 'packages/runtime/package.json'), host.version)
    await verifyBridgeHost(join(checkout, 'packages/build/package.json'), host.version)
    await run('bun', ['install', '--frozen-lockfile'], checkout, log)
    await run('bun', ['run', 'build:runtime'], checkout, log)
    await run('pnpm', ['install', '--no-frozen-lockfile'], root, log, env)
    await run('pnpm', ['--filter', '@clinmesh/dsh-web', 'build'], root, log, env)
    await run('git', ['clone', '--no-checkout', bridge.source, join(runtime, 'ag-ui')], runtime, log)
    await run('git', ['checkout', '--detach', bridge.commit], join(runtime, 'ag-ui'), log)
    await verifyBridgeHost(join(runtime, 'ag-ui/package.json'), host.version)
    await run('pnpm', ['install', '--frozen-lockfile'], join(runtime, 'ag-ui'), log, env)
    await run('pnpm', ['build'], join(runtime, 'ag-ui'), log, env)
    const hostDirectory = join(runtime, 'host')
    await mkdir(hostDirectory)
    for (const file of ['package.json', 'package-lock.json']) await cp(join(root, 'deployment/dsh/host', file), join(hostDirectory, file))
    if (host.version !== baseline.components.find(item => item.name === host.name)?.version) {
      await run('npm', ['install', '--package-lock-only', '--ignore-scripts'], hostDirectory, log, env)
    }
    await run('npm', ['ci'], hostDirectory, log, env)
    await cp(join(hostDirectory, 'package-lock.json'), join(root, 'deployment/dsh/host/package-lock.json'))
    await run('npm', ['install', '--prefix', join(runtime, 'tooling'), '--ignore-scripts', `@dsh-so/dshvm@${manager.version}`], runtime, log, env)
    await run(process.execPath, [join(runtime, 'tooling/node_modules/@dsh-so/dshvm/bin/dshvm.js'), '--version'], runtime, log, env)
    const profile = join(runtime, 'data/profiles/web')
    await mkdir(join(profile, 'plugins'), { recursive: true })
    await cp(join(root, 'deployment/dsh/profile'), profile, { recursive: true })
    for (const [name, destination] of [
      ['ag-ui', join(runtime, 'ag-ui')], ['react-surface', join(checkout, 'packages/runtime')], ['clinmesh', join(root, 'apps/dsh-web')],
    ]) await symlink(destination!, join(profile, 'plugins', name!), process.platform === 'win32' ? 'junction' : 'dir')
    await run('pnpm', ['install', host.version === baseline.components.find(item => item.name === host.name)?.version ? '--frozen-lockfile' : '--no-frozen-lockfile'], profile, log, env)
    await cp(join(profile, 'pnpm-lock.yaml'), join(root, 'deployment/dsh/profile/pnpm-lock.yaml'))
    const cli = join(hostDirectory, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    const plugins = await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'list'], runtime, log, { ...env, DSH_HOME: join(runtime, 'data') })
    for (const name of ['dsh-react-surface', 'dsh-ag-ui', '@clinmesh/dsh-web']) {
      if (!plugins.includes(name)) throw new Error(`临时 Profile 缺少插件：${name}`)
    }
    await smokeHost(cli, runtime, host.version, log)
    await run('pnpm', ['check'], root, log, env)
    await writeJson(join(root, 'dsh-upstreams.lock.json'), target)
    await writeJson(receiptPath, { schemaVersion: 1, baselineDigest: candidate.baselineDigest, targetDigest: lockDigest(target) })
    await writeJson(join(evidence, 'result.json'), { status: 'automated-checks-passed', targetDigest: lockDigest(target), humanAcceptance: 'required' })
  } catch (error) {
    await writeJson(join(evidence, 'result.json'), { status: 'awaiting-adaptation', error: error instanceof Error ? error.message : '验收失败' })
    throw error
  } finally {
    await restoreInstallerBinMode(root)
    const patch = await execute('git', ['diff', '--binary'], { cwd: root, maxBuffer: 20 * 1024 * 1024 })
    await writeFile(join(evidence, 'prepared.patch'), patch.stdout)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2 || !existsSync(candidatePath)) {
    console.error('用法：在含 deployment/dsh/candidate.json 的干净独立 checkout 中运行 pnpm upstream:verify')
    process.exitCode = 1
  } else verifyCandidate(process.cwd()).catch(error => {
    console.error(error instanceof Error ? error.message : '候选验收失败')
    process.exitCode = 1
  })
}
