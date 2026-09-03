import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

type SyntheaRuntimeCommand = 'doctor' | 'down' | 'up'

interface ProviderHealth {
  moduleCount: number
  profileId: string
  syntheaCommit: string
}

export interface SyntheaRuntimeDependencies {
  fetch: (input: string, init: RequestInit) => Promise<Response>
  providerUrl: string
  runDocker: (arguments_: string[]) => Promise<void>
  write: (message: string) => void
}

const composeArguments = ['compose', '--file', 'compose.synthea-provider.yaml']
const removeRuntimeArguments = [
  ...composeArguments,
  'rm',
  '--force',
  '--stop',
  'synthea-provider',
  'cn-health-localizer',
]
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const maximumHealthBytes = 256 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseProviderHealth(value: unknown): ProviderHealth {
  if (!isRecord(value) || value.status !== 'ok' || !Array.isArray(value.modules)) {
    throw new Error('Synthea Provider 健康响应无效')
  }
  if (
    value.modules.length === 0
    || value.modules.length > 2_000
    || value.modules.some(module => typeof module !== 'string' || module.length === 0)
    || value.syntheaCommit !== 'd9d07a6eef91ee5144293b42ab64224d84d124f8'
    || !isRecord(value.localization)
    || typeof value.localization.profileId !== 'string'
    || value.localization.profileId.length === 0
  ) {
    throw new Error('Synthea Provider 健康响应无效')
  }
  return {
    moduleCount: value.modules.length,
    profileId: value.localization.profileId,
    syntheaCommit: value.syntheaCommit,
  }
}

async function readProviderHealth(
  dependencies: SyntheaRuntimeDependencies,
): Promise<ProviderHealth> {
  const response = await dependencies.fetch(`${dependencies.providerUrl}/health`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Synthea Provider 健康检查返回 HTTP ${response.status}`)
  }
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && Number(declaredLength) > maximumHealthBytes) {
    await response.body?.cancel()
    throw new Error('Synthea Provider 健康响应过大')
  }
  const body = await readBoundedBody(response)
  try {
    return parseProviderHealth(JSON.parse(body) as unknown)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Synthea Provider 健康响应')) {
      throw error
    }
    throw new Error('Synthea Provider 健康响应无效', { cause: error })
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > maximumHealthBytes) {
      await reader.cancel()
      throw new Error('Synthea Provider 健康响应过大')
    }
    chunks.push(next.value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

export async function runSyntheaRuntimeCommand(
  command: SyntheaRuntimeCommand,
  dependencies: SyntheaRuntimeDependencies,
): Promise<void> {
  if (command === 'down') {
    await dependencies.runDocker(removeRuntimeArguments)
    return
  }
  if (command === 'up') {
    let health: ProviderHealth
    try {
      await dependencies.runDocker([
        ...composeArguments,
        'up',
        '--detach',
        '--pull',
        'always',
        '--wait',
        '--wait-timeout',
        '180',
        'cn-health-localizer',
        'synthea-provider',
      ])
      health = await readProviderHealth(dependencies)
    } catch (error) {
      try {
        await dependencies.runDocker(removeRuntimeArguments)
      } catch (cleanupError) {
        throw new Error('Synthea runtime 启动失败且无法清理部分容器', {
          cause: new AggregateError([error, cleanupError]),
        })
      }
      throw error
    }
    dependencies.write(
      `Synthea Provider 已就绪：Synthea ${health.syntheaCommit}，${health.profileId}，${health.moduleCount} 个模块。`,
    )
    return
  }

  const health = await readProviderHealth(dependencies)
  dependencies.write(
    `Synthea Provider 健康：Synthea ${health.syntheaCommit}，${health.profileId}，${health.moduleCount} 个模块。`,
  )
  await dependencies.runDocker([
    ...composeArguments,
    'exec',
    '--no-TTY',
    'synthea-provider',
    'java',
    '-cp',
    '/opt/provider:/opt/synthea/synthea.jar',
    'ProviderServer',
    '--smoke',
  ])
  dependencies.write('Synthea Provider 全模块患者 smoke 通过。')
}

export function providerUrlFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const value = environment.CLINMESH_SYNTHEA_PROVIDER_PORT ?? '51878'
  const port = Number(value)
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('CLINMESH_SYNTHEA_PROVIDER_PORT 必须是有效端口')
  }
  return `http://127.0.0.1:${port}`
}

function runDocker(arguments_: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', arguments_, {
      cwd: repositoryRoot,
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`docker ${arguments_.join(' ')} 失败：${signal ?? code}`))
    })
  })
}

async function main(): Promise<void> {
  try {
    loadEnvFile(resolve(repositoryRoot, '.env'))
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') throw error
  }
  const command = process.argv[2]
  if (!['doctor', 'down', 'up'].includes(command ?? '')) {
    throw new Error('用法：pnpm synthea:up | pnpm synthea:down | pnpm synthea:doctor')
  }
  await runSyntheaRuntimeCommand(command as SyntheaRuntimeCommand, {
    fetch: globalThis.fetch,
    providerUrl: providerUrlFromEnvironment(process.env),
    runDocker,
    write: console.log,
  })
}

const entryPath = process.argv[1]
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
