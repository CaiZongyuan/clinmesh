import { spawn, type ChildProcess } from 'node:child_process'
import { isIPv4 } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

interface DevelopmentProcess {
  args: string[]
  environment: Record<string, string>
  name: string
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

async function runDevelopmentProcesses(plan: LanDevelopmentPlan): Promise<number> {
  const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const repositoryRoot = resolve(import.meta.dirname, '..')
  const running: Array<{ child: ChildProcess, name: string }> = plan.processes.map(configuration => ({
    child: spawn(packageManager, configuration.args, {
      cwd: repositoryRoot,
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
        if (child.exitCode === null && child.signalCode === null) child.kill(signal)
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

export async function runLanDevelopment(): Promise<number> {
  const plan = createLanDevelopmentPlan(
    resolveLanAddresses(process.env.CLINMESH_LAN_IP),
  )
  console.info('ClinMesh LAN development URLs:')
  for (const url of plan.urls) console.info(`  ${url}`)
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
