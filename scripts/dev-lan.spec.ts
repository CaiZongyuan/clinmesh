import { spawn } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir, type NetworkInterfaceInfo } from 'node:os'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  createLanDevelopmentPlan,
  ensureDataSourcesReady,
  findPrivateIpv4Addresses,
  renderHeading,
  renderStatusLine,
  resolveLanAddresses,
  supportsAnsiColor,
  type DataSourceReadinessDependencies,
} from './dev-lan.ts'

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 500
  while (Date.now() < deadline) {
    try {
      readFileSync(path)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await delay(10)
  }
  throw new Error(`File ${path} was not created`)
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 500
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return
    await delay(10)
  }
  throw new Error(`Process ${pid} did not exit`)
}

function networkAddress(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    cidr: `${address}/24`,
    family: 'IPv4',
    internal,
    mac: '00:00:00:00:00:00',
    netmask: '255.255.255.0',
  }
}

const pinnedSyntheaCommit = 'd9d07a6eef91ee5144293b42ab64224d84d124f8'

async function startFakeProviderServer(): Promise<Server> {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      localization: { profileId: 'synthea-cn-test-profile' },
      modules: ['test-module'],
      status: 'ok',
      syntheaCommit: pinnedSyntheaCommit,
    }))
  })
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  return server
}

function fakeProviderUrl(server: Server): string {
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

describe('findPrivateIpv4Addresses', () => {
  it('returns private LAN addresses without loopback or public interfaces', () => {
    expect(findPrivateIpv4Addresses({
      docker0: [networkAddress('172.17.0.1')],
      ethernet: [networkAddress('192.168.1.23'), networkAddress('203.0.113.8')],
      loopback: [networkAddress('127.0.0.1', true)],
      wifi: [networkAddress('10.0.0.7')],
    })).toEqual(['10.0.0.7', '172.17.0.1', '192.168.1.23'])
  })
})

describe('createLanDevelopmentPlan', () => {
  it('creates one Server and Web process with trusted LAN origins', () => {
    expect(createLanDevelopmentPlan(['192.168.1.23'])).toEqual({
      origins: [
        'http://127.0.0.1:51868',
        'http://127.0.0.1:51888',
        'http://localhost:51888',
        'http://192.168.1.23:51888',
      ],
      processes: [
        {
          args: ['dev:server'],
          environment: {
            CLINMESH_TRUSTED_ORIGINS: 'http://127.0.0.1:51868,http://127.0.0.1:51888,http://localhost:51888,http://192.168.1.23:51888',
          },
          name: 'Server',
        },
        {
          args: ['dev:web', '--', '--host', '0.0.0.0'],
          environment: {},
          name: 'Web',
        },
      ],
      urls: ['http://192.168.1.23:51888/'],
    })
  })

  it('requires a private IPv4 address', () => {
    expect(() => createLanDevelopmentPlan([])).toThrow('CLINMESH_LAN_IP')
  })

  it('trusts the localhost URL advertised by Vite', () => {
    expect(createLanDevelopmentPlan(['192.168.1.23']).origins).toContain(
      'http://localhost:51888',
    )
  })
})

describe('resolveLanAddresses', () => {
  it('skips interface detection when an explicit address is provided', () => {
    const detectAddresses = vi.fn(() => {
      throw new Error('interface detection failed')
    })

    expect(resolveLanAddresses('192.168.50.4', detectAddresses)).toEqual(['192.168.50.4'])
    expect(detectAddresses).not.toHaveBeenCalled()
  })

  it('rejects an explicit public address', () => {
    expect(() => resolveLanAddresses('203.0.113.8')).toThrow('private IPv4')
  })
})

describe('supportsAnsiColor', () => {
  it('enables color only for an interactive terminal without NO_COLOR', () => {
    expect(supportsAnsiColor({ isTTY: true }, {})).toBe(true)
    expect(supportsAnsiColor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false)
    expect(supportsAnsiColor({ isTTY: false }, {})).toBe(false)
    expect(supportsAnsiColor({ isTTY: false }, { NO_COLOR: '1' })).toBe(false)
  })
})

describe('renderStatusLine', () => {
  it('prefixes ok and warn messages with markers', () => {
    expect(renderStatusLine('ok', '参考目录数据库已就绪', false)).toBe('✓ 参考目录数据库已就绪')
    expect(renderStatusLine('warn', '仅新的患者生成任务不可用', false)).toBe('⚠ 仅新的患者生成任务不可用')
  })

  it('colors the marker only when color output is enabled', () => {
    expect(renderStatusLine('ok', '就绪', true)).toBe(`\x1b[32m✓\x1b[0m 就绪`)
    expect(renderStatusLine('warn', '警告', true)).toBe(`\x1b[33m⚠\x1b[0m 警告`)
    expect(renderStatusLine('ok', '就绪', false)).not.toContain('\x1b')
  })
})

describe('renderHeading', () => {
  it('boldens headings only when color output is enabled', () => {
    expect(renderHeading('数据源', true)).toBe('\x1b[1m数据源\x1b[0m')
    expect(renderHeading('数据源', false)).toBe('数据源')
  })
})

describe('ensureDataSourcesReady', () => {
  const health = {
    moduleCount: 12,
    profileId: 'synthea-cn@2026-08-29.r4',
    syntheaCommit: 'd9d07a6eef91ee5144293b42ab64224d84d124f8',
  }

  function createDependencies(
    overrides: Partial<DataSourceReadinessDependencies> = {},
  ): DataSourceReadinessDependencies {
    return {
      environment: {},
      managedProviderUrl: 'http://127.0.0.1:51878',
      readProviderHealth: async () => {
        throw new Error('provider probe should not run in this test')
      },
      referenceDatabaseReady: () => false,
      runReferenceSync: async () => {
        throw new Error('reference sync should not run in this test')
      },
      runSyntheaUp: async () => {
        throw new Error('synthea up should not run in this test')
      },
      write: () => {},
      ...overrides,
    }
  }

  it('reports the reference database as ready when the configured release is available', async () => {
    const runReferenceSync = vi.fn()
    const write = vi.fn()
    await ensureDataSourcesReady(createDependencies({
      environment: { CLINMESH_REFERENCE_DATABASE_PATH: '.data/clinmesh-reference.sqlite' },
      referenceDatabaseReady: () => true,
      runReferenceSync,
      write,
    }))

    expect(runReferenceSync).not.toHaveBeenCalled()
    expect(write).toHaveBeenCalledWith(expect.stringContaining('参考目录数据库已就绪'))
  })

  it('runs reference sync automatically when the database file is missing', async () => {
    const runReferenceSync = vi.fn()
    const write = vi.fn()
    await expect(ensureDataSourcesReady(createDependencies({
      environment: { CLINMESH_REFERENCE_DATABASE_PATH: '.data/clinmesh-reference.sqlite' },
      runReferenceSync,
      write,
    }))).resolves.toBeUndefined()

    expect(runReferenceSync).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(expect.stringContaining('自动执行 pnpm reference:sync'))
    expect(write).toHaveBeenCalledWith(expect.stringContaining('参考目录数据库同步完成'))
  })

  it('warns and continues when automatic reference sync fails', async () => {
    const write = vi.fn()
    await expect(ensureDataSourcesReady(createDependencies({
      environment: { CLINMESH_REFERENCE_DATABASE_PATH: '.data/clinmesh-reference.sqlite' },
      runReferenceSync: async () => {
        throw new Error('network unreachable')
      },
      write,
    }))).resolves.toBeUndefined()

    expect(write).toHaveBeenCalledWith(expect.stringContaining('参考目录自动同步失败'))
    expect(write).toHaveBeenCalledWith(expect.stringContaining('内置合成 fixture'))
    expect(write).toHaveBeenCalledWith(expect.stringContaining('pnpm reference:sync'))
  })

  it('warns without blocking when no reference database is configured', async () => {
    const write = vi.fn()
    await expect(ensureDataSourcesReady(createDependencies({ write }))).resolves.toBeUndefined()

    expect(write).toHaveBeenCalledWith(expect.stringContaining('未配置 CLINMESH_REFERENCE_DATABASE_PATH'))
    expect(write).toHaveBeenCalledWith(expect.stringContaining('内置合成 fixture'))
  })

  it('reports a healthy configured provider without starting Synthea', async () => {
    const runSyntheaUp = vi.fn()
    const write = vi.fn()
    await ensureDataSourcesReady(createDependencies({
      environment: { CLINMESH_SYNTHEA_PROVIDER_URL: 'http://127.0.0.1:51878' },
      readProviderHealth: async () => health,
      runSyntheaUp,
      write,
    }))

    expect(runSyntheaUp).not.toHaveBeenCalled()
    expect(write).toHaveBeenCalledWith(expect.stringContaining('Synthea Provider 已就绪'))
  })

  it('only warns when no provider URL is configured', async () => {
    const readProviderHealth = vi.fn()
    const runSyntheaUp = vi.fn()
    const write = vi.fn()
    await expect(ensureDataSourcesReady(createDependencies({
      readProviderHealth,
      runSyntheaUp,
      write,
    }))).resolves.toBeUndefined()

    expect(readProviderHealth).not.toHaveBeenCalled()
    expect(runSyntheaUp).not.toHaveBeenCalled()
    expect(write).toHaveBeenCalledWith(expect.stringContaining('未配置 CLINMESH_SYNTHEA_PROVIDER_URL'))
    expect(write).toHaveBeenCalledWith(expect.stringContaining('HIS 可正常使用'))
  })

  it('starts the managed runtime once when the default provider is unreachable', async () => {
    const runSyntheaUp = vi.fn()
    const write = vi.fn()
    await expect(ensureDataSourcesReady(createDependencies({
      environment: { CLINMESH_SYNTHEA_PROVIDER_URL: 'http://127.0.0.1:51878' },
      readProviderHealth: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:51878')
      },
      runSyntheaUp,
      write,
    }))).resolves.toBeUndefined()

    expect(runSyntheaUp).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalledWith(expect.stringContaining('患者生成任务不可用'))
  })

  it('starts the managed runtime for a localhost provider URL', async () => {
    const runSyntheaUp = vi.fn()
    const write = vi.fn()
    await expect(ensureDataSourcesReady(createDependencies({
      environment: { CLINMESH_SYNTHEA_PROVIDER_URL: 'http://localhost:51878' },
      readProviderHealth: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:51878')
      },
      runSyntheaUp,
      write,
    }))).resolves.toBeUndefined()

    expect(runSyntheaUp).toHaveBeenCalledTimes(1)
  })

  it('warns and continues when the managed runtime fails to start', async () => {
    const write = vi.fn()
    await expect(ensureDataSourcesReady(createDependencies({
      environment: { CLINMESH_SYNTHEA_PROVIDER_URL: 'http://127.0.0.1:51878' },
      readProviderHealth: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:51878')
      },
      runSyntheaUp: async () => {
        throw new Error('docker compose 失败')
      },
      write,
    }))).resolves.toBeUndefined()

    expect(write).toHaveBeenCalledWith(expect.stringContaining('自动拉起失败'))
    expect(write).toHaveBeenCalledWith(expect.stringContaining('HIS 可正常使用'))
    expect(write).toHaveBeenCalledWith(expect.stringContaining('pnpm synthea:up'))
  })

  it('only warns when a custom provider URL is unreachable', async () => {
    const runSyntheaUp = vi.fn()
    const write = vi.fn()
    await expect(ensureDataSourcesReady(createDependencies({
      environment: { CLINMESH_SYNTHEA_PROVIDER_URL: 'http://192.0.2.10:51878' },
      readProviderHealth: async () => {
        throw new Error('request timed out')
      },
      runSyntheaUp,
      write,
    }))).resolves.toBeUndefined()

    expect(runSyntheaUp).not.toHaveBeenCalled()
    expect(write).toHaveBeenCalledWith(expect.stringContaining('Synthea Provider 不可达'))
    expect(write).toHaveBeenCalledWith(expect.stringContaining('HIS 可正常使用'))
  })
})

describe.skipIf(process.platform === 'win32')('pnpm dev:lan process supervision', () => {
  it('stops both development process trees after SIGINT', async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clinmesh-dev-lan-'))
    const fakePackageManagerPath = join(temporaryDirectory, 'pnpm')
    const pidPathPrefix = join(temporaryDirectory, 'grandchild')
    const serverGrandchildPidPath = `${pidPathPrefix}.dev-server.pid`
    const webGrandchildPidPath = `${pidPathPrefix}.dev-web.pid`
    const referenceDatabasePath = join(temporaryDirectory, 'reference.sqlite')
    const repositoryRoot = resolve(import.meta.dirname, '..')
    const grandchildPids: number[] = []
    let command: ReturnType<typeof spawn> | undefined
    const providerServer = await startFakeProviderServer()

    writeFileSync(fakePackageManagerPath, `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')

const role = process.argv[2]
if (role === 'reference:sync') process.exit(0)
const pidPathPrefix = process.env.CLINMESH_TEST_GRANDCHILD_PID_PREFIX
if (pidPathPrefix === undefined) process.exit(2)

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
})
writeFileSync(pidPathPrefix + '.' + role.replace(':', '-') + '.pid', String(grandchild.pid))
setInterval(() => {}, 1000)
`)
    chmodSync(fakePackageManagerPath, 0o755)
    writeFileSync(referenceDatabasePath, '')

    try {
      command = spawn(resolve(repositoryRoot, 'node_modules/.bin/tsx'), ['scripts/dev-lan.ts'], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CLINMESH_LAN_IP: '192.168.50.4',
          CLINMESH_REFERENCE_DATABASE_PATH: referenceDatabasePath,
          CLINMESH_SYNTHEA_PROVIDER_URL: fakeProviderUrl(providerServer),
          CLINMESH_TEST_GRANDCHILD_PID_PREFIX: pidPathPrefix,
          PATH: `${temporaryDirectory}:${process.env.PATH ?? ''}`,
        },
        stdio: ['ignore', 'pipe', 'ignore'],
      })

      const startedCommand = command
      await new Promise<void>((resolveReady, rejectReady) => {
        let output = ''
        startedCommand.stdout!.on('data', chunk => {
          output += String(chunk)
          if (output.includes('访问地址')) resolveReady()
        })
        startedCommand.once('error', rejectReady)
        startedCommand.once('exit', () => rejectReady(new Error('Launcher exited before starting development processes')))
      })
      await Promise.all([
        waitForFile(serverGrandchildPidPath),
        waitForFile(webGrandchildPidPath),
      ])
      grandchildPids.push(
        Number(readFileSync(serverGrandchildPidPath, 'utf8')),
        Number(readFileSync(webGrandchildPidPath, 'utf8')),
      )

      startedCommand.kill('SIGINT')
      const exitCode = await new Promise<number | null>((resolveExitCode, reject) => {
        startedCommand.once('error', reject)
        startedCommand.once('close', resolveExitCode)
      })

      expect(exitCode).toBe(0)
      await Promise.all(grandchildPids.map(waitForProcessExit))
    } finally {
      if (command?.exitCode === null) command.kill('SIGINT')
      for (const pid of grandchildPids) {
        if (isProcessRunning(pid)) process.kill(pid, 'SIGKILL')
      }
      providerServer.close()
      rmSync(temporaryDirectory, { force: true, recursive: true })
    }
  })

  it('stops the other development process tree when one process fails', async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clinmesh-dev-lan-'))
    const fakePackageManagerPath = join(temporaryDirectory, 'pnpm')
    const grandchildPidPath = join(temporaryDirectory, 'grandchild.pid')
    const referenceDatabasePath = join(temporaryDirectory, 'reference.sqlite')
    const repositoryRoot = resolve(import.meta.dirname, '..')
    const providerServer = await startFakeProviderServer()
    let grandchildPid: number | undefined

    writeFileSync(fakePackageManagerPath, `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const { existsSync, writeFileSync } = require('node:fs')

const role = process.argv[2]
const pidPath = process.env.CLINMESH_TEST_GRANDCHILD_PID_FILE
if (pidPath === undefined) process.exit(2)

if (role === 'dev:server') {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  writeFileSync(pidPath, String(grandchild.pid))
  setInterval(() => {}, 1000)
} else {
  const poll = setInterval(() => {
    if (!existsSync(pidPath)) return
    clearInterval(poll)
    process.exit(1)
  }, 10)
  setTimeout(() => process.exit(2), 2000)
}
`)
    chmodSync(fakePackageManagerPath, 0o755)
    writeFileSync(referenceDatabasePath, '')

    try {
      const command = spawn(resolve(repositoryRoot, 'node_modules/.bin/tsx'), ['scripts/dev-lan.ts'], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CLINMESH_LAN_IP: '192.168.50.4',
          CLINMESH_REFERENCE_DATABASE_PATH: referenceDatabasePath,
          CLINMESH_SYNTHEA_PROVIDER_URL: fakeProviderUrl(providerServer),
          CLINMESH_TEST_GRANDCHILD_PID_FILE: grandchildPidPath,
          PATH: `${temporaryDirectory}:${process.env.PATH ?? ''}`,
        },
        stdio: 'ignore',
      })
      const exitCode = await new Promise<number | null>((resolveExitCode, reject) => {
        command.once('error', reject)
        command.once('close', resolveExitCode)
      })

      expect(exitCode).toBe(1)
      grandchildPid = Number(readFileSync(grandchildPidPath, 'utf8'))
      await waitForProcessExit(grandchildPid)
    } finally {
      if (grandchildPid !== undefined && isProcessRunning(grandchildPid)) {
        process.kill(grandchildPid, 'SIGKILL')
      }
      providerServer.close()
      rmSync(temporaryDirectory, { force: true, recursive: true })
    }
  })
})
