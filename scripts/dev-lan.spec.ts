import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, type NetworkInterfaceInfo } from 'node:os'
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
          args: ['--filter', '@clinmesh/server', 'dev:prepared'],
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

  it('starts Server against the same absolute data paths prepared from the repository root', () => {
    const repositoryRoot = resolve(import.meta.dirname, '..')
    const plan = createLanDevelopmentPlan(['192.168.1.23'], {
      CLINMESH_DATABASE_PATH: '.data/clinmesh.sqlite',
      CLINMESH_REFERENCE_DATABASE_PATH: '.data/clinmesh-reference.sqlite',
      CLINMESH_GUIDELINE_DATABASE_PATH: '.data/clinmesh-guidelines.sqlite',
      CLINMESH_DRG_RULES_DIRECTORY: '.data/drg-rules/reviewed-v2',
      CLINMESH_DRG_RULES_REVIEW_PATH: '.data/drg-rules/reviews/reviewed-v2.json',
      CLINMESH_WEB_ROOT: 'apps/web/dist',
    })

    expect(plan.processes[0]?.environment).toMatchObject({
      CLINMESH_DATABASE_PATH: join(repositoryRoot, '.data/clinmesh.sqlite'),
      CLINMESH_REFERENCE_DATABASE_PATH: join(repositoryRoot, '.data/clinmesh-reference.sqlite'),
      CLINMESH_GUIDELINE_DATABASE_PATH: join(repositoryRoot, '.data/clinmesh-guidelines.sqlite'),
      CLINMESH_DRG_RULES_DIRECTORY: join(repositoryRoot, '.data/drg-rules/reviewed-v2'),
      CLINMESH_DRG_RULES_REVIEW_PATH: join(repositoryRoot, '.data/drg-rules/reviews/reviewed-v2.json'),
      CLINMESH_WEB_ROOT: join(repositoryRoot, 'apps/web/dist'),
    })
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
    expect(renderStatusLine('warn', '缺少参考目录', false)).toBe('⚠ 缺少参考目录')
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
  function createDependencies(
    overrides: Partial<DataSourceReadinessDependencies> = {},
  ): DataSourceReadinessDependencies {
    return {
      environment: {},
      referenceDatabaseReady: () => false,
      runReferenceSync: async () => {
        throw new Error('reference sync should not run in this test')
      },
      runDrgReferenceSync: async () => {},
      runGuidelinePrepare: async () => {},
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

  it('prepares DRG data even when the clinical reference release is already available', async () => {
    const runDrgReferenceSync = vi.fn().mockResolvedValue(undefined)
    const write = vi.fn()
    await ensureDataSourcesReady(createDependencies({
      environment: { CLINMESH_REFERENCE_DATABASE_PATH: '.data/clinmesh-reference.sqlite' },
      referenceDatabaseReady: () => true,
      runDrgReferenceSync,
      write,
    }))

    expect(runDrgReferenceSync).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(expect.stringContaining('DRG 参考资料已就绪'))
  })

  it.each([false, true])('prepares guidelines independently of existing Reference data: %s', async referenceReady => {
    const runGuidelinePrepare = vi.fn().mockResolvedValue(undefined)
    const write = vi.fn()
    await ensureDataSourcesReady(createDependencies({
      environment: referenceReady ? { CLINMESH_REFERENCE_DATABASE_PATH: '.data/reference.sqlite' } : {},
      referenceDatabaseReady: () => referenceReady,
      runGuidelinePrepare,
      write,
    }))

    expect(runGuidelinePrepare).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(expect.stringContaining('指南资料已就绪'))
  })

  it('stops on guideline preparation failure without reporting readiness', async () => {
    const write = vi.fn()
    await expect(ensureDataSourcesReady(createDependencies({
      runGuidelinePrepare: async () => { throw new Error('Guideline archive checksum mismatch') },
      write,
    }))).rejects.toThrow('Guideline archive checksum mismatch')

    expect(write).not.toHaveBeenCalledWith(expect.stringContaining('指南资料已就绪'))
  })

  it('runs reference sync automatically when the database file is missing', async () => {
    const runReferenceSync = vi.fn()
    const runDrgReferenceSync = vi.fn()
    const write = vi.fn()
    await expect(ensureDataSourcesReady(createDependencies({
      environment: { CLINMESH_REFERENCE_DATABASE_PATH: '.data/clinmesh-reference.sqlite' },
      runReferenceSync,
      runDrgReferenceSync,
      write,
    }))).resolves.toBeUndefined()

    expect(runReferenceSync).toHaveBeenCalledTimes(1)
    expect(runDrgReferenceSync).not.toHaveBeenCalled()
    expect(write).toHaveBeenCalledWith(expect.stringContaining('参考目录数据库同步完成'))
  })

  it('warns without blocking when no reference database is configured', async () => {
    const write = vi.fn()
    const runDrgReferenceSync = vi.fn()
    await expect(ensureDataSourcesReady(createDependencies({ write, runDrgReferenceSync }))).resolves.toBeUndefined()

    expect(write).toHaveBeenCalledWith(expect.stringContaining('未配置 CLINMESH_REFERENCE_DATABASE_PATH'))
    expect(runDrgReferenceSync).not.toHaveBeenCalled()
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

    writeFileSync(fakePackageManagerPath, `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')

const role = process.argv.includes('dev:prepared') ? 'dev:server' : process.argv[2]
if (role === 'reference:sync' || process.argv.includes('drg:prepare') || process.argv.includes('guidelines:prepare')) process.exit(0)
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
      rmSync(temporaryDirectory, { force: true, recursive: true })
    }
  })
})
