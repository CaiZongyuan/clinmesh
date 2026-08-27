import { spawn } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir, type NetworkInterfaceInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  createLanDevelopmentPlan,
  findPrivateIpv4Addresses,
  resolveLanAddresses,
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

describe.skipIf(process.platform === 'win32')('pnpm dev:lan process supervision', () => {
  it('stops both development process trees after SIGINT', async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clinmesh-dev-lan-'))
    const fakePackageManagerPath = join(temporaryDirectory, 'pnpm')
    const pidPathPrefix = join(temporaryDirectory, 'grandchild')
    const serverGrandchildPidPath = `${pidPathPrefix}.dev-server.pid`
    const webGrandchildPidPath = `${pidPathPrefix}.dev-web.pid`
    const repositoryRoot = resolve(import.meta.dirname, '..')
    const grandchildPids: number[] = []

    writeFileSync(fakePackageManagerPath, `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')

const role = process.argv[2]
const pidPathPrefix = process.env.CLINMESH_TEST_GRANDCHILD_PID_PREFIX
if (pidPathPrefix === undefined) process.exit(2)

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
})
writeFileSync(pidPathPrefix + '.' + role.replace(':', '-') + '.pid', String(grandchild.pid))
setInterval(() => {}, 1000)
`)
    chmodSync(fakePackageManagerPath, 0o755)

    try {
      const command = spawn(resolve(repositoryRoot, 'node_modules/.bin/tsx'), ['scripts/dev-lan.ts'], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CLINMESH_LAN_IP: '192.168.50.4',
          CLINMESH_TEST_GRANDCHILD_PID_PREFIX: pidPathPrefix,
          PATH: `${temporaryDirectory}:${process.env.PATH ?? ''}`,
        },
        stdio: 'ignore',
      })

      await Promise.all([
        waitForFile(serverGrandchildPidPath),
        waitForFile(webGrandchildPidPath),
      ])
      grandchildPids.push(
        Number(readFileSync(serverGrandchildPidPath, 'utf8')),
        Number(readFileSync(webGrandchildPidPath, 'utf8')),
      )

      command.kill('SIGINT')
      const exitCode = await new Promise<number | null>((resolveExitCode, reject) => {
        command.once('error', reject)
        command.once('close', resolveExitCode)
      })

      expect(exitCode).toBe(0)
      await Promise.all(grandchildPids.map(waitForProcessExit))
    } finally {
      for (const pid of grandchildPids) {
        if (isProcessRunning(pid)) process.kill(pid, 'SIGKILL')
      }
      rmSync(temporaryDirectory, { force: true, recursive: true })
    }
  })

  it('stops the other development process tree when one process fails', async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clinmesh-dev-lan-'))
    const fakePackageManagerPath = join(temporaryDirectory, 'pnpm')
    const grandchildPidPath = join(temporaryDirectory, 'grandchild.pid')
    const repositoryRoot = resolve(import.meta.dirname, '..')
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

    try {
      const command = spawn(resolve(repositoryRoot, 'node_modules/.bin/tsx'), ['scripts/dev-lan.ts'], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CLINMESH_LAN_IP: '192.168.50.4',
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
      rmSync(temporaryDirectory, { force: true, recursive: true })
    }
  })
})
