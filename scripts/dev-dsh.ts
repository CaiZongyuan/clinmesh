import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createConnection } from 'node:net'
import { existsSync } from 'node:fs'
import { appendFile, cp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { parseLock, type UpstreamLock } from './dsh-upstreams.ts'
import { loadRepositoryEnvironment } from './synthea-runtime.ts'
import {
  createDataSourceReadinessDependencies,
  ensureDataSourcesReady,
  renderHeading,
  supportsAnsiColor,
} from './dev-lan.ts'
import { runDevelopmentProcesses, type DevelopmentProcess } from './development-processes.ts'

export interface DshRuntimeVersions {
  dshVersion: string
  dshvmVersion: string
  agUiCommit: string
  agUiSource: string
}

export function extractRuntimeVersions(lock: UpstreamLock): DshRuntimeVersions {
  const dsh = lock.components.find(component => component.name === '@deepseek-ai/dsh')
  const dshvm = lock.components.find(component => component.name === '@dsh-so/dshvm')
  const agUi = lock.components.find(component => component.name === 'dsh-ag-ui')
  if (!dsh?.version) throw new Error('上游锁缺少 @deepseek-ai/dsh 版本')
  if (!dshvm?.version) throw new Error('上游锁缺少 dshvm（@dsh-so/dshvm）版本')
  if (!agUi?.commit) throw new Error('上游锁缺少 dsh-ag-ui 锁定 commit')
  return {
    dshVersion: dsh.version,
    dshvmVersion: dshvm.version,
    agUiCommit: agUi.commit,
    agUiSource: agUi.source,
  }
}

export interface DshSandboxPaths {
  root: string
  toolingDir: string
  dshvmCli: string
  versionsDir: string
  binDir: string
  slotDir: string
  dshHome: string
  agUiDir: string
  profileDir: string
  stampPath: string
}

export function resolveDshSandboxPaths(
  repositoryRoot: string,
  sandboxOverride: string | undefined,
  dshVersion: string,
): DshSandboxPaths {
  const root = sandboxOverride ?? join(repositoryRoot, '.data', 'dsh-runtime')
  const versionsDir = join(root, 'versions')
  const dshHome = join(versionsDir, 'isolate', dshVersion)
  return {
    root,
    toolingDir: join(root, 'tooling'),
    dshvmCli: join(root, 'tooling', 'node_modules', '@dsh-so', 'dshvm', 'bin', 'dshvm.js'),
    versionsDir,
    binDir: join(root, 'bin'),
    slotDir: join(versionsDir, `dsh-${dshVersion}`),
    dshHome,
    agUiDir: join(root, 'ag-ui'),
    profileDir: join(dshHome, 'profiles', 'web'),
    stampPath: join(root, 'build-stamps.json'),
  }
}

const dshWebPort = '3080'
export const dshWebOrigin = `http://127.0.0.1:${dshWebPort}`

export function resolveDshTrustedOrigins(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const serverPort = environment.CLINMESH_PORT ?? '51868'
  const defaults = [
    `http://127.0.0.1:${serverPort}`,
    'http://127.0.0.1:51888',
    dshWebOrigin,
  ]
  const configured = environment.CLINMESH_TRUSTED_ORIGINS?.split(',').map(origin => origin.trim())
    .filter(origin => origin.length > 0)
  return [...new Set([...configured ?? [], ...defaults])].join(',')
}

export interface DshDevelopmentPlanInput {
  paths: DshSandboxPaths
  bridgeSecret: string
  trustedOrigins: string
  repositoryRoot: string
  environment: Readonly<Record<string, string | undefined>>
  /** 收到 DSH Host 原始输出时调用；入口用它捕获 `dsh web: <token URL>` 日志行。 */
  onHostText?: (text: string) => void
}

export interface DshDevelopmentPlan {
  processes: DevelopmentProcess[]
  urls: string[]
}

export interface DshReadinessDependencies {
  fetchServerHealth: () => Promise<boolean>
  hostUrl: () => string | undefined
  isStopped: () => boolean
  intervalMs: number
  timeoutMs: number
  sleep: (milliseconds: number) => Promise<void>
  write: (message: string) => void
}

/** 轮询 Server 健康与 DSH Host 打印的 token URL；两者齐备即返回，超时返回部分状态并提示。 */
export async function awaitDshReadiness(
  dependencies: DshReadinessDependencies,
): Promise<{ serverReady: boolean, hostUrl: string | undefined }> {
  const deadline = Date.now() + dependencies.timeoutMs
  let serverReady = false
  let hostUrl = dependencies.hostUrl()
  while (Date.now() < deadline) {
    if (dependencies.isStopped()) return { serverReady, hostUrl }
    serverReady = await dependencies.fetchServerHealth().catch(() => false)
    hostUrl = dependencies.hostUrl()
    if (serverReady && hostUrl !== undefined) return { serverReady, hostUrl }
    await dependencies.sleep(dependencies.intervalMs)
  }
  dependencies.write(
    `⚠ 未能在 ${Math.round(dependencies.timeoutMs / 1000)} 秒内确认就绪`
    + `（Server：${serverReady ? '健康检查通过' : '未通过'}；DSH Web：${hostUrl === undefined ? '尚未打印访问地址' : '已打印'}）；进程继续运行，详见下方日志。`,
  )
  return { serverReady, hostUrl }
}

/** Server 自身会把 .env 中的这三个相对路径按 .env 所在目录绝对化；进程 env 的原始相对值会覆盖该结果，因此直启前先按同一规则绝对化。 */
const serverResolvedEnvironmentKeys = [
  'CLINMESH_DATABASE_PATH',
  'CLINMESH_REFERENCE_DATABASE_PATH',
  'CLINMESH_WEB_ROOT',
] as const

export function dshvmEnvironmentFor(paths: Pick<DshSandboxPaths, 'versionsDir' | 'binDir'>): Record<string, string> {
  return {
    DSHVM_HOME: paths.versionsDir,
    DSHVM_BIN_DIR: paths.binDir,
  }
}

export function createDshDevelopmentPlan(input: DshDevelopmentPlanInput): DshDevelopmentPlan {
  const serverEnvironment: Record<string, string> = {
    CLINMESH_TRUSTED_ORIGINS: input.trustedOrigins,
  }
  for (const name of serverResolvedEnvironmentKeys) {
    const value = input.environment[name]
    if (value !== undefined) {
      serverEnvironment[name] = isAbsolute(value) ? value : resolve(input.repositoryRoot, value)
    }
  }
  return {
    processes: [
      {
        name: 'Server',
        command: 'pnpm',
        args: ['--filter', '@clinmesh/server', 'dev'],
        environment: serverEnvironment,
        output: { prefix: '[Server]' },
      },
      {
        name: 'DSH Host',
        command: 'node',
        args: [input.paths.dshvmCli, 'exec', 'web', '--port', dshWebPort, '--no-open'],
        environment: {
          ...dshvmEnvironmentFor(input.paths),
          DSH_HOME: input.paths.dshHome,
          CLINMESH_DSH_BRIDGE_SECRET: input.bridgeSecret,
        },
        output: { prefix: '[DSH]', onText: input.onHostText },
      },
    ],
    urls: [
      `http://127.0.0.1:${input.environment.CLINMESH_PORT ?? '51868'}/api/health`,
    ],
  }
}

export class DevDshEnsureError extends Error {
  constructor(
    message: string,
    readonly step: string,
    readonly hint?: string,
  ) {
    super(message)
  }
}

export interface DshEnsureFilesystem {
  exists(path: string): boolean
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  appendFile(path: string, content: string): Promise<void>
  readlink(path: string): Promise<string>
  symlink(target: string, path: string): Promise<void>
  rm(path: string): Promise<void>
  cp(from: string, to: string): Promise<void>
  mkdir(path: string): Promise<void>
}

export interface DshEnsureDependencies {
  environment: Readonly<Record<string, string | undefined>>
  repositoryRoot: string
  sandbox: DshSandboxPaths
  versions: DshRuntimeVersions
  filesystem: DshEnsureFilesystem
  runCommand: (
    command: string,
    args: readonly string[],
    cwd: string,
    environment?: Readonly<Record<string, string>>,
    options?: { quiet?: boolean },
  ) => Promise<string>
  randomBytes: (size: number) => Buffer
  write: (message: string) => void
}

interface BuildStamps {
  surfaceCommit?: string
  agUiCommit?: string
}

const surfaceCheckoutRelative = join('vendor', 'dsh-react-surface')
const hostTemplateFiles = ['package.json', 'package-lock.json'] as const
const profileTemplateFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml'] as const

function isBuildStamps(value: unknown): value is BuildStamps {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record: Record<string, unknown> = value
  return ['surfaceCommit', 'agUiCommit'].every(key =>
    record[key] === undefined || typeof record[key] === 'string')
}

async function readBuildStamps(
  filesystem: DshEnsureFilesystem,
  stampPath: string,
): Promise<BuildStamps> {
  if (!filesystem.exists(stampPath)) return {}
  try {
    const parsed: unknown = JSON.parse(await filesystem.readFile(stampPath))
    return isBuildStamps(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function writeBuildStamps(
  filesystem: DshEnsureFilesystem,
  stampPath: string,
  stamps: BuildStamps,
): Promise<void> {
  await filesystem.writeFile(stampPath, `${JSON.stringify(stamps, null, 2)}\n`)
}

async function retryNetworkStep(
  dependencies: Pick<DshEnsureDependencies, 'write'>,
  step: string,
  hint: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run()
  } catch {
    dependencies.write(`⚠ ${step}失败，自动重试一次…`)
    try {
      await run()
    } catch (error) {
      throw new DevDshEnsureError(
        `${step}失败：${error instanceof Error ? error.message : String(error)}`,
        step,
        hint,
      )
    }
  }
}

async function copyTemplateIfChanged(
  filesystem: DshEnsureFilesystem,
  from: string,
  to: string,
): Promise<boolean> {
  const template = await filesystem.readFile(from)
  if (await filesystem.readFile(to).catch(() => undefined) === template) return false
  await filesystem.cp(from, to)
  return true
}

async function copyTemplatesIfChanged(
  filesystem: DshEnsureFilesystem,
  fromDirectory: string,
  toDirectory: string,
  files: readonly string[],
): Promise<boolean> {
  let changed = false
  for (const file of files) {
    changed = await copyTemplateIfChanged(filesystem, join(fromDirectory, file), join(toDirectory, file)) || changed
  }
  return changed
}

export async function ensureDshRuntimeReady(
  dependencies: DshEnsureDependencies,
): Promise<{ profileNewlyAssembled: boolean, bridgeSecret: string }> {
  const { environment, repositoryRoot, sandbox, versions, filesystem } = dependencies
  const checkout = join(repositoryRoot, surfaceCheckoutRelative)
  const envPath = join(repositoryRoot, '.env')
  const dshvmEnvironment = dshvmEnvironmentFor(sandbox)

  const bunVersion = await dependencies.runCommand('bun', ['--version'], repositoryRoot, undefined, { quiet: true })
    .catch(() => undefined)
  if (typeof bunVersion !== 'string' || !bunVersion.trim().startsWith('1.4.')) {
    throw new DevDshEnsureError(
      `Bun 1.4.x 不可用（当前：${bunVersion?.trim() || '未安装'}）`,
      'bun',
      '安装 Bun 1.4.0 后重试（DSH React Surface artifact 构建依赖 bun）',
    )
  }
  if (!filesystem.exists(join(checkout, 'packages', 'runtime', 'package.json'))) {
    throw new DevDshEnsureError(
      'vendor/dsh-react-surface 子模块不存在',
      'submodule',
      '先运行 git submodule update --init --recursive 并重新 pnpm install',
    )
  }
  if (!filesystem.exists(envPath)) {
    throw new DevDshEnsureError(
      '仓库根缺少 .env',
      'env',
      '先运行 cp .env.example .env 并按需填写',
    )
  }
  let bridgeSecret = environment.CLINMESH_DSH_BRIDGE_SECRET
  if (bridgeSecret === undefined) {
    bridgeSecret = dependencies.randomBytes(32).toString('hex')
    await filesystem.appendFile(
      envPath,
      `\n# 由 pnpm dev:dsh 自动生成本地 bridge secret\nCLINMESH_DSH_BRIDGE_SECRET=${bridgeSecret}\n`,
    )
    dependencies.write('✓ 已生成 CLINMESH_DSH_BRIDGE_SECRET 并写入 .env')
  }

  await filesystem.mkdir(sandbox.root)
  await filesystem.mkdir(sandbox.binDir)
  if (!filesystem.exists(sandbox.dshvmCli)) {
    await retryNetworkStep(
      dependencies,
      '安装 dshvm 工具目录',
      '检查网络与 npm registry 可用性',
      async () => {
        await dependencies.runCommand(
          'npm',
          ['install', '--prefix', sandbox.toolingDir, `@dsh-so/dshvm@${versions.dshvmVersion}`],
          repositoryRoot,
        )
      },
    )
    dependencies.write('✓ dshvm 工具目录已安装')
  } else {
    dependencies.write('✓ dshvm 工具目录已就绪')
  }

  if (!filesystem.exists(sandbox.slotDir)) {
    await retryNetworkStep(dependencies, 'dshvm 槽位安装', '检查网络与 npm registry 可用性', async () => {
      await dependencies.runCommand(
        'node',
        [sandbox.dshvmCli, 'install', versions.dshVersion],
        sandbox.root,
        dshvmEnvironment,
      )
    })
  }
  const slotManifestChanged = await copyTemplatesIfChanged(
    filesystem,
    join(repositoryRoot, 'deployment', 'dsh', 'host'),
    sandbox.slotDir,
    hostTemplateFiles,
  )
  if (!filesystem.exists(join(sandbox.slotDir, 'node_modules', '@deepseek-ai', 'dsh')) || slotManifestChanged) {
    await retryNetworkStep(dependencies, '恢复宿主依赖（npm ci）', '检查网络与 npm registry 可用性', async () => {
      await dependencies.runCommand('npm', ['ci'], sandbox.slotDir)
    })
  }

  if (!filesystem.exists(sandbox.dshHome)) {
    await retryNetworkStep(dependencies, 'dshvm isolate', '检查沙箱目录可写性', async () => {
      await dependencies.runCommand(
        'node',
        [sandbox.dshvmCli, 'isolate', versions.dshVersion],
        sandbox.root,
        dshvmEnvironment,
      )
    })
  }
  await dependencies.runCommand(
    'node',
    [sandbox.dshvmCli, 'use', versions.dshVersion],
    sandbox.root,
    dshvmEnvironment,
    { quiet: true },
  )
  const selectedSlot = await dependencies.runCommand(
    'node',
    [sandbox.dshvmCli, 'which', versions.dshVersion],
    sandbox.root,
    dshvmEnvironment,
    { quiet: true },
  )
  if (!selectedSlot.includes(`dsh-${versions.dshVersion}`)) {
    throw new DevDshEnsureError(
      `dshvm 未选择隔离槽位 dsh-${versions.dshVersion}`,
      'dshvm-use',
      '删除沙箱后重新运行 pnpm dsh:setup',
    )
  }

  const stamps = await readBuildStamps(filesystem, sandbox.stampPath)
  const currentSurfaceCommit = (await dependencies.runCommand(
    'git',
    ['rev-parse', 'HEAD'],
    checkout,
    undefined,
    { quiet: true },
  )).trim()
  if (stamps.surfaceCommit !== currentSurfaceCommit) {
    await retryNetworkStep(dependencies, '安装 React Surface 依赖', '检查网络可用性', async () => {
      await dependencies.runCommand('bun', ['install', '--frozen-lockfile'], checkout)
    })
    await dependencies.runCommand('bun', ['run', 'build:runtime'], checkout)
    stamps.surfaceCommit = currentSurfaceCommit
    await writeBuildStamps(filesystem, sandbox.stampPath, stamps)
    dependencies.write('✓ React Surface runtime 已构建')
  } else {
    dependencies.write('✓ React Surface runtime 已就绪')
  }

  if (!filesystem.exists(join(sandbox.agUiDir, '.git'))) {
    await retryNetworkStep(dependencies, '克隆 dsh-ag-ui', '检查网络与 GitHub 可达性', async () => {
      await dependencies.runCommand(
        'git',
        ['clone', versions.agUiSource, sandbox.agUiDir],
        sandbox.root,
      )
    })
  }
  const currentAgUiCommit = (await dependencies.runCommand(
    'git',
    ['rev-parse', 'HEAD'],
    sandbox.agUiDir,
    undefined,
    { quiet: true },
  )).trim()
  const agUiCommitDrifted = currentAgUiCommit !== versions.agUiCommit
  if (agUiCommitDrifted) {
    await dependencies.runCommand('git', ['checkout', '--detach', versions.agUiCommit], sandbox.agUiDir)
  }
  if (agUiCommitDrifted || stamps.agUiCommit !== versions.agUiCommit) {
    await retryNetworkStep(dependencies, '安装 dsh-ag-ui 依赖', '检查网络可用性', async () => {
      await dependencies.runCommand('pnpm', ['install', '--frozen-lockfile'], sandbox.agUiDir)
    })
    await dependencies.runCommand('pnpm', ['build'], sandbox.agUiDir)
    stamps.agUiCommit = versions.agUiCommit
    await writeBuildStamps(filesystem, sandbox.stampPath, stamps)
    dependencies.write('✓ dsh-ag-ui 已构建')
  } else {
    dependencies.write('✓ dsh-ag-ui 已就绪')
  }

  await dependencies.runCommand('pnpm', ['--filter', '@clinmesh/dsh-web', 'build'], repositoryRoot)
  dependencies.write('✓ ClinMesh DSH artifact 已构建')

  const profileNewlyAssembled = !filesystem.exists(join(sandbox.profileDir, 'package.json'))
  await filesystem.mkdir(join(sandbox.profileDir, 'plugins'))
  const profileTemplateChanged = await copyTemplatesIfChanged(
    filesystem,
    join(repositoryRoot, 'deployment', 'dsh', 'profile'),
    sandbox.profileDir,
    profileTemplateFiles,
  )
  const linkTargets: Array<[name: string, target: string]> = [
    ['ag-ui', sandbox.agUiDir],
    ['react-surface', join(checkout, 'packages', 'runtime')],
    ['clinmesh', join(repositoryRoot, 'apps', 'dsh-web')],
  ]
  for (const [name, target] of linkTargets) {
    const linkPath = join(sandbox.profileDir, 'plugins', name)
    if (filesystem.exists(linkPath)) {
      const current = await filesystem.readlink(linkPath).catch(() => undefined)
      if (current === target) continue
      await filesystem.rm(linkPath)
    }
    await filesystem.symlink(target, linkPath)
  }
  if (!filesystem.exists(join(sandbox.profileDir, 'node_modules')) || profileTemplateChanged) {
    await retryNetworkStep(dependencies, '安装 DSH Profile 依赖', '检查网络与 npm registry 可用性', async () => {
      await dependencies.runCommand('pnpm', ['install', '--frozen-lockfile'], sandbox.profileDir)
    })
  }
  dependencies.write('✓ DSH Web Profile 已就绪')

  return { profileNewlyAssembled, bridgeSecret }
}

function createRealFilesystem(): DshEnsureFilesystem {
  return {
    exists: existsSync,
    readFile: path => readFile(path, 'utf8'),
    writeFile: (path, content) => writeFile(path, content, 'utf8'),
    appendFile: (path, content) => appendFile(path, content, 'utf8'),
    readlink: path => readlink(path, 'utf8'),
    symlink: (target, path) => symlink(target, path, 'dir'),
    rm: path => rm(path, { force: true, recursive: true }),
    cp: (from, to) => cp(from, to),
    mkdir: path => mkdir(path, { recursive: true }),
  }
}

function createRealRunCommand(): DshEnsureDependencies['runCommand'] {
  return (command, args, cwd, environment, options) => new Promise((resolveCommand, reject) => {
    const quiet = options?.quiet === true
    const child = spawn(command, [...args], {
      cwd,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    const output = () => Buffer.concat(chunks).toString('utf8')
    const failureTail = () => {
      const text = output()
      return text.length <= 2000 ? text : `…${text.slice(-2000)}`
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      if (!quiet) process.stdout.write(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      if (!quiet) process.stderr.write(chunk)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolveCommand(output())
        return
      }
      if (quiet && failureTail().length > 0) {
        process.stderr.write(failureTail())
      }
      reject(new Error(`${command} ${args.join(' ')} 退出码 ${code ?? 'signal'}`))
    })
  })
}

function isTcpPortOpen(port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolveProbe(true)
    })
    socket.once('error', () => {
      resolveProbe(false)
    })
  })
}

export async function runDshDevelopment(mode: 'run' | 'setup'): Promise<number> {
  loadRepositoryEnvironment()
  const repositoryRoot = resolve(import.meta.dirname, '..')
  const color = supportsAnsiColor(process.stdout, process.env)
  const versions = extractRuntimeVersions(
    parseLock(JSON.parse(await readFile(join(repositoryRoot, 'dsh-upstreams.lock.json'), 'utf8'))),
  )
  const sandbox = resolveDshSandboxPaths(
    repositoryRoot,
    process.env.CLINMESH_DSH_SANDBOX,
    versions.dshVersion,
  )

  console.info(renderHeading('ClinMesh DSH Web 开发环境', color))
  console.info('')
  console.info(renderHeading('DSH 运行时', color))
  const { profileNewlyAssembled, bridgeSecret } = await ensureDshRuntimeReady({
    environment: process.env,
    repositoryRoot,
    sandbox,
    versions,
    filesystem: createRealFilesystem(),
    runCommand: createRealRunCommand(),
    randomBytes,
    write: message => console.info(message),
  })
  console.info('')
  console.info(renderHeading('数据源', color))
  await ensureDataSourcesReady(createDataSourceReadinessDependencies(repositoryRoot))

  if (mode === 'setup') {
    console.info('')
    console.info(renderHeading('完成', color))
    console.info('✓ DSH Web 运行时已就绪；运行 pnpm dev:dsh 启动 ClinMesh Server 与 DSH Web。')
    return 0
  }

  if (await isTcpPortOpen(Number(dshWebPort))) {
    throw new DevDshEnsureError(
      `DSH Web 端口 ${dshWebPort} 已被占用`,
      'dsh-port',
      'DSH 遇端口占用会静默改用其他端口，导致 trusted origin 与登录校验错位；请先停止已有的 DSH Web 进程',
    )
  }
  const capturedHostUrl: { url: string | undefined } = { url: undefined }
  const plan = createDshDevelopmentPlan({
    paths: sandbox,
    bridgeSecret,
    trustedOrigins: resolveDshTrustedOrigins(process.env),
    repositoryRoot,
    environment: process.env,
    onHostText: (text) => {
      const match = /dsh web: (\S+)/.exec(text)
      if (match !== null && capturedHostUrl.url === undefined) capturedHostUrl.url = match[1]
    },
  })
  if (profileNewlyAssembled) {
    console.info('⚠ 首次使用该 DSH Profile：模型 Provider 需在隔离宿主的设置页单独配置。')
  }
  console.info('')
  console.info(renderHeading('启动 ClinMesh Server 与 DSH Web（Ctrl+C 同时退出）', color))
  console.info('')
  const processes = runDevelopmentProcesses(plan)
  const stopped = { value: false }
  void processes.then(() => {
    stopped.value = true
  })
  const readiness = await awaitDshReadiness({
    fetchServerHealth: async () => {
      try {
        const response = await fetch(plan.urls[0]!, { signal: AbortSignal.timeout(2000) })
        return response.ok
      } catch {
        return false
      }
    },
    hostUrl: () => capturedHostUrl.url,
    isStopped: () => stopped.value,
    intervalMs: 2_000,
    timeoutMs: 180_000,
    sleep: milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds)),
    write: message => console.info(message),
  })
  if (!stopped.value && readiness.serverReady && readiness.hostUrl !== undefined) {
    console.info('')
    console.info(renderHeading('✓ 就绪', color))
    console.info(`  DSH Web   ${readiness.hostUrl}  ← 含本次启动 token，直接打开`)
    console.info(`  Server    ${plan.urls[0]}`)
    console.info('  Ctrl+C 退出全部进程')
    console.info('')
  }
  return await processes
}

const entryPath = process.argv[1]
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  const mode = process.argv[2] === 'setup' ? 'setup' : process.argv[2] === undefined ? 'run' : undefined
  if (mode === undefined) {
    console.error('用法：tsx scripts/dev-dsh.ts [setup]')
    process.exitCode = 1
  } else {
    runDshDevelopment(mode)
      .then((exitCode) => {
        process.exitCode = exitCode
      })
      .catch((error: unknown) => {
        if (error instanceof DevDshEnsureError) {
          console.error(`${error.message}${error.hint === undefined ? '' : `；${error.hint}`}`)
        } else {
          console.error(error instanceof Error ? error.message : error)
        }
        process.exitCode = 1
      })
  }
}
