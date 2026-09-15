import { spawn, type ChildProcess } from 'node:child_process'
import { isIPv4 } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  createSyntheaRuntimeDependencies,
  formatProviderHealthSummary,
  loadRepositoryEnvironment,
  providerUrlFromEnvironment,
  readProviderHealth,
  runSyntheaRuntimeCommand,
  type ProviderHealth,
} from './synthea-runtime.ts'

import { referenceDatabaseIsReady } from '../apps/server/src/reference-readiness.ts'

interface DevelopmentProcess {
  args: string[]
  environment: Record<string, string>
  name: string
}

export interface DataSourceReadinessDependencies {
  environment: Readonly<Record<string, string | undefined>>
  managedProviderUrl: string | undefined
  readProviderHealth: (providerUrl: string) => Promise<ProviderHealth>
  referenceDatabaseReady: (configuredPath: string) => boolean
  runReferenceSync: () => Promise<void>
  runSyntheaUp: () => Promise<void>
  write: (message: string) => void
}

type StatusMarker = 'ok' | 'warn'

export function supportsAnsiColor(
  output: { isTTY: boolean },
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return output.isTTY && environment.NO_COLOR === undefined
}

export function renderStatusLine(status: StatusMarker, message: string, color: boolean): string {
  if (!color) return `${status === 'ok' ? '✓' : '⚠'} ${message}`
  const code = status === 'ok' ? '\x1b[32m' : '\x1b[33m'
  const marker = status === 'ok' ? '✓' : '⚠'
  return `${code}${marker}\x1b[0m ${message}`
}

export function renderHeading(text: string, color: boolean): string {
  return color ? `\x1b[1m${text}\x1b[0m` : text
}

export interface LanDevelopmentPlan {
  origins: string[]
  processes: DevelopmentProcess[]
  urls: string[]
}

function isPrivateIpv4(address: string): boolean {
  if (!isIPv4(address)) return false
  const [first, second] = address.split('.').map(Number)
  return first === 10
    || (first === 172 && second !== undefined && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254)
}

export function findPrivateIpv4Addresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  return [...new Set(Object.values(interfaces)
    .flatMap(entries => entries ?? [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal && isPrivateIpv4(entry.address))
    .map(entry => entry.address))]
    .sort()
}

export function resolveLanAddresses(
  explicitAddress: string | undefined,
  detectAddresses: () => string[] = findPrivateIpv4Addresses,
): string[] {
  if (explicitAddress === undefined) return detectAddresses()
  if (!isPrivateIpv4(explicitAddress)) {
    throw new Error('CLINMESH_LAN_IP must be a private IPv4 address')
  }
  return [explicitAddress]
}

export function createLanDevelopmentPlan(
  detectedAddresses: string[],
): LanDevelopmentPlan {
  const addresses = [...new Set(detectedAddresses.filter(isPrivateIpv4))].sort()
  if (addresses.length === 0) {
    throw new Error('No private IPv4 address detected; set CLINMESH_LAN_IP explicitly')
  }

  const origins = [
    'http://127.0.0.1:51868',
    'http://127.0.0.1:51888',
    'http://localhost:51888',
    ...addresses.map(address => `http://${address}:51888`),
  ]

  return {
    origins,
    processes: [
      {
        args: ['dev:server'],
        environment: { CLINMESH_TRUSTED_ORIGINS: origins.join(',') },
        name: 'Server',
      },
      {
        args: ['dev:web', '--', '--host', '0.0.0.0'],
        environment: {},
        name: 'Web',
      },
    ],
    urls: addresses.map(address => `http://${address}:51888/`),
  }
}

const referenceFixtureFallback
  = '将使用内置合成 fixture，医生无法下诊断或开检验。完整目录可运行 pnpm reference:sync 同步。'

export async function ensureDataSourcesReady(
  dependencies: DataSourceReadinessDependencies,
): Promise<void> {
  await ensureReferenceDatabase(dependencies)
  await ensureSyntheaProvider(dependencies)
}

function writeStatus(
  dependencies: DataSourceReadinessDependencies,
  status: StatusMarker,
  message: string,
): void {
  dependencies.write(
    renderStatusLine(status, message, supportsAnsiColor(process.stdout, process.env)),
  )
}

async function ensureReferenceDatabase(dependencies: DataSourceReadinessDependencies): Promise<void> {
  const configuredPath = dependencies.environment.CLINMESH_REFERENCE_DATABASE_PATH
  if (configuredPath === undefined) {
    writeStatus(
      dependencies,
      'warn',
      `未配置 CLINMESH_REFERENCE_DATABASE_PATH；${referenceFixtureFallback}`,
    )
    return
  }
  if (dependencies.referenceDatabaseReady(configuredPath)) {
    writeStatus(dependencies, 'ok', `参考目录数据库已就绪：${configuredPath}。`)
    return
  }
  writeStatus(
    dependencies,
    'warn',
    `参考目录数据库 ${configuredPath} 缺失或版本不匹配，自动执行 pnpm reference:sync（同步疾病、药品和 laboratory-cn，请稍候）…`,
  )
  try {
    await dependencies.runReferenceSync()
  } catch (error) {
    writeStatus(
      dependencies,
      'warn',
      `参考目录自动同步失败：${error instanceof Error ? error.message : String(error)}；${referenceFixtureFallback}`,
    )
    return
  }
  writeStatus(dependencies, 'ok', `参考目录数据库同步完成：${configuredPath}。`)
}

const loopbackHostnames = new Set(['127.0.0.1', 'localhost', '::1'])

function isLocallyManagedProviderUrl(
  providerUrl: string,
  managedUrl: string | undefined,
): boolean {
  if (managedUrl === undefined) return false
  const candidate = new URL(providerUrl)
  const managed = new URL(managedUrl)
  return loopbackHostnames.has(candidate.hostname) && candidate.port === managed.port
}

async function ensureSyntheaProvider(dependencies: DataSourceReadinessDependencies): Promise<void> {
  const providerUrl = dependencies.environment.CLINMESH_SYNTHEA_PROVIDER_URL
  if (providerUrl === undefined) {
    writeStatus(
      dependencies,
      'warn',
      '未配置 CLINMESH_SYNTHEA_PROVIDER_URL；ClinMesh 将继续启动，HIS 可正常使用，仅新的患者生成任务不可用。',
    )
    return
  }

  const health = await dependencies.readProviderHealth(providerUrl).catch(() => undefined)
  if (health !== undefined) {
    writeStatus(
      dependencies,
      'ok',
      `Synthea Provider 已就绪：${providerUrl}（${formatProviderHealthSummary(health)}）。`,
    )
    return
  }
  if (!isLocallyManagedProviderUrl(providerUrl, dependencies.managedProviderUrl)) {
    writeStatus(
      dependencies,
      'warn',
      `Synthea Provider 不可达：${providerUrl}；ClinMesh 将继续启动，HIS 可正常使用，仅新的患者生成任务不可用。`,
    )
    return
  }
  try {
    await dependencies.runSyntheaUp()
  } catch (error) {
    writeStatus(
      dependencies,
      'warn',
      `Synthea Provider 自动拉起失败：${error instanceof Error ? error.message : String(error)}`,
    )
    writeStatus(
      dependencies,
      'warn',
      'ClinMesh 将继续启动，HIS 可正常使用，仅新的患者生成任务不可用。可稍后运行 pnpm synthea:up。',
    )
  }
}

async function runDevelopmentProcesses(plan: LanDevelopmentPlan): Promise<number> {
  const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const repositoryRoot = resolve(import.meta.dirname, '..')
  const useProcessGroups = process.platform !== 'win32'
  const running: Array<{ child: ChildProcess, name: string }> = plan.processes.map(configuration => ({
    child: spawn(packageManager, configuration.args, {
      cwd: repositoryRoot,
      detached: useProcessGroups,
      env: { ...process.env, ...configuration.environment },
      stdio: 'inherit',
    }),
    name: configuration.name,
  }))

  return await new Promise((resolveExitCode) => {
    let closed = 0
    let exitCode = 0
    let stopping = false

    const stop = (signal: NodeJS.Signals, code: number): void => {
      if (stopping) return
      stopping = true
      exitCode = code
      for (const { child } of running) {
        if (child.exitCode !== null || child.signalCode !== null) continue
        if (!useProcessGroups || child.pid === undefined) {
          child.kill(signal)
          continue
        }
        try {
          process.kill(-child.pid, signal)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
    }

    process.once('SIGINT', () => stop('SIGINT', 0))
    process.once('SIGTERM', () => stop('SIGTERM', 0))

    for (const { child, name } of running) {
      child.once('error', (error) => {
        console.error(`${name} failed to start:`, error)
        stop('SIGTERM', 1)
      })
      child.once('close', (code, signal) => {
        closed += 1
        if (!stopping) {
          if (code !== 0) console.error(`${name} exited with ${code ?? signal ?? 'unknown status'}`)
          stop('SIGTERM', code ?? 1)
        }
        if (closed === running.length) resolveExitCode(exitCode)
      })
    }
  })
}

function managedProviderUrlFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  write: (message: string) => void,
): string | undefined {
  try {
    return providerUrlFromEnvironment(environment)
  } catch (error) {
    write(
      `${error instanceof Error ? error.message : String(error)}；将跳过 Synthea Provider 自动拉起。`,
    )
    return undefined
  }
}

function runPackageManagerCommand(args: string[]): Promise<void> {
  const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const repositoryRoot = resolve(import.meta.dirname, '..')
  return new Promise((resolveCommand, reject) => {
    const child = spawn(packageManager, args, {
      cwd: repositoryRoot,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveCommand()
      else reject(new Error(`pnpm ${args.join(' ')} 失败：${signal ?? code}`))
    })
  })
}

export async function runLanDevelopment(): Promise<number> {
  loadRepositoryEnvironment()
  const repositoryRoot = resolve(import.meta.dirname, '..')
  const color = supportsAnsiColor(process.stdout, process.env)
  console.info(renderHeading('ClinMesh 局域网开发环境', color))
  console.info('')
  console.info(renderHeading('数据源', color))
  await ensureDataSourcesReady({
    environment: process.env,
    managedProviderUrl: process.env.CLINMESH_SYNTHEA_PROVIDER_URL === undefined
      ? undefined
      : managedProviderUrlFromEnvironment(process.env, console.info),
    readProviderHealth: providerUrl => readProviderHealth({
      fetch: globalThis.fetch,
      providerUrl,
    }),
    referenceDatabaseReady: configuredPath => referenceDatabaseIsReady(resolve(repositoryRoot, configuredPath), repositoryRoot, process.env.CLINMESH_REFERENCE_RELEASE_ID),
    runReferenceSync: () => runPackageManagerCommand(['reference:sync', '--database', resolve(repositoryRoot, process.env.CLINMESH_REFERENCE_DATABASE_PATH!)]),
    runSyntheaUp: () => runSyntheaRuntimeCommand(
      'up',
      createSyntheaRuntimeDependencies(process.env, console.info),
    ),
    write: console.info,
  })
  const plan = createLanDevelopmentPlan(
    resolveLanAddresses(process.env.CLINMESH_LAN_IP),
  )
  console.info('')
  console.info(renderHeading('访问地址', color))
  for (const url of plan.urls) console.info(`  局域网  ${url}`)
  console.info('  本机    http://127.0.0.1:51888/')
  console.info('')
  return await runDevelopmentProcesses(plan)
}

const entryPath = process.argv[1]
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  runLanDevelopment()
    .then((exitCode) => {
      process.exitCode = exitCode
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    })
}
