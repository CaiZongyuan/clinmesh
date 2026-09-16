import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseLock } from './dsh-upstreams.ts'
import {
  createDshCommandRunner,
  createDshFilesystem,
  awaitDshReadiness,
  createDshDevelopmentPlan,
  ensureDshRuntimeReady,
  extractRuntimeVersions,
  resolveDshSandboxPaths,
  resolveDshTrustedOrigins,
  type DshEnsureDependencies,
  type DshReadinessDependencies,
} from './dev-dsh.ts'

describe('DSH command execution', () => {
  it('runs the installed npm launcher', async () => {
    await expect(createDshCommandRunner()('npm', ['--version'], process.cwd(), undefined, { quiet: true }))
      .resolves.toMatch(/^\d+\.\d+\.\d+/)
  })

  it('passes arguments literally through a package manager script in a Unicode path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh 中文 & commands-'))
    try {
      await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { echo: 'node echo.cjs' } }))
      await writeFile(join(directory, 'echo.cjs'), 'console.log(JSON.stringify(process.argv.slice(2)))')
      const args = ['中文 空格', 'a&b', 'a|b', 'a>b', 'a<b', 'a^b', '"quoted"', '%PATH%', 'tail\\']
      const output = await createDshCommandRunner()('npm', ['--silent', 'run', 'echo', '--', ...args], directory, undefined, { quiet: true })
      expect(JSON.parse(output.trim())).toEqual(args)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

it('repairs a dangling profile directory link without removing its target data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh links 中文 '))
  const filesystem = createDshFilesystem()
  const target = join(directory, 'target')
  const link = join(directory, 'plugin')
  try {
    await symlink(join(directory, 'missing'), link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(filesystem.exists(link)).toBe(true)
    await filesystem.rm(link)
    await mkdir(target)
    await writeFile(join(target, 'keep.txt'), 'keep')
    await filesystem.symlink(target, link)
    expect(await filesystem.readlink(link)).toBe(target)
    expect(await readFile(join(link, 'keep.txt'), 'utf8')).toBe('keep')
    await filesystem.rm(link)
    expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('keep')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const upstreamLock = parseLock(
  JSON.parse(readFileSync(join(import.meta.dirname, '..', 'dsh-upstreams.lock.json'), 'utf8')),
)

describe('extractRuntimeVersions', () => {
  it('reads DSH, dshvm and ag-ui inputs from the upstream lock', () => {
    expect(extractRuntimeVersions(upstreamLock)).toEqual({
      dshVersion: '0.1.5-rc.2',
      dshvmVersion: '0.1.1',
      agUiCommit: '521740953be41cc37bd770ecf41b36bd7b0824d9',
      agUiSource: 'https://github.com/keaideppk/dsh-ag-ui.git',
    })
  })

  it('rejects a lock that is missing a required component', () => {
    const incomplete = structuredClone(upstreamLock)
    incomplete.components = incomplete.components.filter(
      component => component.name !== '@dsh-so/dshvm',
    )

    expect(() => extractRuntimeVersions(incomplete)).toThrow('dshvm')
  })
})

describe('resolveDshSandboxPaths', () => {
  it('derives the sandbox layout from the repository root and DSH version', () => {
    expect(resolveDshSandboxPaths('/repo', undefined, '0.1.5-rc.2')).toEqual({
      root: normalize('/repo/.data/dsh-runtime'),
      toolingDir: normalize('/repo/.data/dsh-runtime/tooling'),
      dshvmCli: normalize('/repo/.data/dsh-runtime/tooling/node_modules/@dsh-so/dshvm/bin/dshvm.js'),
      versionsDir: normalize('/repo/.data/dsh-runtime/versions'),
      binDir: normalize('/repo/.data/dsh-runtime/bin'),
      slotDir: normalize('/repo/.data/dsh-runtime/versions/dsh-0.1.5-rc.2'),
      dshHome: normalize('/repo/.data/dsh-runtime/versions/isolate/0.1.5-rc.2'),
      agUiDir: normalize('/repo/.data/dsh-runtime/ag-ui'),
      profileDir: normalize('/repo/.data/dsh-runtime/versions/isolate/0.1.5-rc.2/profiles/web'),
      stampPath: normalize('/repo/.data/dsh-runtime/build-stamps.json'),
    })
  })

  it('honors an explicit sandbox override outside the repository', () => {
    expect(resolveDshSandboxPaths('/repo', '/elsewhere/runtime', '0.1.5-rc.2').root)
      .toBe('/elsewhere/runtime')
  })
})

describe('resolveDshTrustedOrigins', () => {
  it('defaults to the local server, web and DSH origins', () => {
    expect(resolveDshTrustedOrigins({}))
      .toBe('http://127.0.0.1:51868,http://127.0.0.1:51888,http://127.0.0.1:3080')
  })

  it('follows a custom server port', () => {
    expect(resolveDshTrustedOrigins({ CLINMESH_PORT: '60001' }))
      .toBe('http://127.0.0.1:60001,http://127.0.0.1:51888,http://127.0.0.1:3080')
  })

  it('unions user-configured origins with the local defaults without duplicating', () => {
    expect(resolveDshTrustedOrigins({
      CLINMESH_TRUSTED_ORIGINS: 'http://localhost:51888,http://127.0.0.1:3080',
    })).toBe('http://localhost:51888,http://127.0.0.1:3080,http://127.0.0.1:51868,http://127.0.0.1:51888')
    expect(resolveDshTrustedOrigins({
      CLINMESH_TRUSTED_ORIGINS: 'http://localhost:51888',
    })).toBe('http://localhost:51888,http://127.0.0.1:51868,http://127.0.0.1:51888,http://127.0.0.1:3080')
  })
})

describe('createDshDevelopmentPlan', () => {
  const paths = resolveDshSandboxPaths('/repo', undefined, '0.1.5-rc.2')

  it('starts the ClinMesh server directly and the DSH host with the shared bridge secret', () => {
    const plan = createDshDevelopmentPlan({
      paths,
      bridgeSecret: 'bridge-secret-value',
      trustedOrigins: 'http://127.0.0.1:51868,http://127.0.0.1:3080',
      repositoryRoot: '/repo',
      environment: {
        CLINMESH_DATABASE_PATH: '.data/clinmesh.sqlite',
        CLINMESH_REFERENCE_DATABASE_PATH: '.data/clinmesh-reference.sqlite',
        CLINMESH_WEB_ROOT: '/absolute/web-root',
        CLINMESH_PORT: '51869',
      },
    })

    expect(plan.processes).toEqual([
      {
        name: 'Server',
        command: 'pnpm',
        args: ['--filter', '@clinmesh/server', 'dev'],
        environment: {
          CLINMESH_TRUSTED_ORIGINS: 'http://127.0.0.1:51868,http://127.0.0.1:3080',
          CLINMESH_DATABASE_PATH: resolve('/repo/.data/clinmesh.sqlite'),
          CLINMESH_REFERENCE_DATABASE_PATH: resolve('/repo/.data/clinmesh-reference.sqlite'),
          CLINMESH_WEB_ROOT: '/absolute/web-root',
        },
        output: { prefix: '[Server]' },
      },
      {
        name: 'DSH Host',
        command: 'node',
        args: [paths.dshvmCli, 'exec', 'web', '--port', '3080', '--no-open'],
        environment: {
          DSHVM_HOME: paths.versionsDir,
          DSHVM_BIN_DIR: paths.binDir,
          DSH_HOME: paths.dshHome,
          CLINMESH_DSH_BRIDGE_SECRET: 'bridge-secret-value',
        },
        output: { prefix: '[DSH]' },
      },
    ])
    expect(plan.urls).toEqual(['http://127.0.0.1:51869/api/health'])
  })

  it('omits server path overrides that the environment does not define', () => {
    const plan = createDshDevelopmentPlan({
      paths,
      bridgeSecret: 'bridge-secret-value',
      trustedOrigins: 'http://127.0.0.1:51868,http://127.0.0.1:3080',
      repositoryRoot: '/repo',
      environment: {},
    })

    const server = plan.processes[0]!
    expect(Object.keys(server.environment)).toEqual(['CLINMESH_TRUSTED_ORIGINS'])
  })
})

describe('awaitDshReadiness', () => {
  function createReadinessDependencies(
    overrides: Partial<DshReadinessDependencies> = {},
  ): DshReadinessDependencies {
    return {
      fetchServerHealth: async () => false,
      hostUrl: () => undefined,
      isStopped: () => false,
      intervalMs: 0,
      timeoutMs: 30,
      sleep: async () => {},
      write: () => {},
      ...overrides,
    }
  }

  it('resolves once the server health passes and the host token URL is captured', async () => {
    let healthCalls = 0
    const result = await awaitDshReadiness(createReadinessDependencies({
      fetchServerHealth: async () => {
        healthCalls += 1
        return healthCalls >= 2
      },
      hostUrl: () => 'http://127.0.0.1:3080/?token=abc',
    }))

    expect(result).toEqual({
      serverReady: true,
      hostUrl: 'http://127.0.0.1:3080/?token=abc',
    })
  })

  it('returns early without waiting when the processes already stopped', async () => {
    const fetchServerHealth = vi.fn(async () => false)
    const result = await awaitDshReadiness(createReadinessDependencies({
      fetchServerHealth,
      isStopped: () => true,
    }))

    expect(result.serverReady).toBe(false)
    expect(fetchServerHealth).not.toHaveBeenCalled()
  })

  it('reports partial readiness after the timeout instead of hanging', async () => {
    const write = vi.fn()
    const result = await awaitDshReadiness(createReadinessDependencies({
      fetchServerHealth: async () => true,
      hostUrl: () => undefined,
      write,
    }))

    expect(result).toEqual({ serverReady: true, hostUrl: undefined })
    expect(write).toHaveBeenCalledWith(expect.stringContaining('未能在'))
  })
})

const surfaceCommit = '025c003c7dce5fbbc76f6caa31196aeb65b531e1'

interface FakeRuntime {
  dependencies: DshEnsureDependencies
  files: Map<string, string>
  links: Map<string, string>
  directories: Set<string>
  commands: Array<{ command: string, args: string[], cwd: string, environment?: Record<string, string> }>
  writes: string[]
  surfaceCommitRef: { value: string }
  agUiCommitRef: { value: string }
}

function createFakeDependencies(
  options: {
    bunVersion?: string
    environment?: Record<string, string | undefined>
    failureInjection?: { command: string, argument: string, times: number }
    preexisting?: (runtime: Pick<FakeRuntime, 'files' | 'links' | 'directories'>) => void
  } = {},
): FakeRuntime {
  const repositoryRoot = '/repo'
  const versions = extractRuntimeVersions(upstreamLock)
  const sandboxPaths = resolveDshSandboxPaths(repositoryRoot, undefined, versions.dshVersion)
  const files = new Map<string, string>([
    [join(repositoryRoot, '.env'), 'CLINMESH_AUTH_SECRET=dev-only\n'],
    [join(repositoryRoot, 'vendor/dsh-react-surface/packages/runtime/package.json'), '{"name":"dsh-react-surface"}'],
    [join(repositoryRoot, 'deployment/dsh/host/package.json'), '{"name":"dshvm-slot"}'],
    [join(repositoryRoot, 'deployment/dsh/host/package-lock.json'), '{"lockfileVersion":3}'],
    [join(repositoryRoot, 'deployment/dsh/profile/package.json'), '{"name":"dsh-profile-web"}'],
    [join(repositoryRoot, 'deployment/dsh/profile/pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n'],
    [join(repositoryRoot, 'deployment/dsh/profile/pnpm-workspace.yaml'), 'packages: []\n'],
    [join(repositoryRoot, 'deployment/dsh/profile/cordis.yml'), 'plugins: []\n'],
  ])
  const links = new Map<string, string>()
  const directories = new Set<string>()
  const commands: FakeRuntime['commands'] = []
  const writes: string[] = []
  const surfaceCommitRef = { value: surfaceCommit }
  const agUiCommitRef = { value: versions.agUiCommit }
  const failures = options.failureInjection
  let failureCount = 0
  const runCommand = async (command: string, args: readonly string[], cwd: string, environment?: Record<string, string>) => {
    commands.push({ command, args: [...args], cwd, environment: environment ? { ...environment } : undefined })
    if (failures && command === failures.command && args.includes(failures.argument)) {
      failureCount += 1
      if (failureCount <= failures.times) throw new Error('network down')
    }
    if (command === 'bun' && args[0] === '--version') return `${options.bunVersion ?? '1.4.0'}\n`
    if (command === 'git' && args[0] === 'rev-parse' && cwd.endsWith(join('vendor', 'dsh-react-surface'))) {
      return `${surfaceCommitRef.value}\n`
    }
    if (command === 'git' && args[0] === 'rev-parse' && cwd.endsWith('ag-ui')) {
      return `${agUiCommitRef.value}\n`
    }
    if (command === 'node' && args.at(-2) === 'which') return `${sandboxPaths.slotDir}/bin/dsh\n`
    if (command === 'npm' && args[0] === 'install' && args[1] === '--prefix') {
      files.set(sandboxPaths.dshvmCli, '#!/usr/bin/env node\n')
    }
    if (command === 'node' && args.includes('install')) directories.add(sandboxPaths.slotDir)
    if (command === 'npm' && args[0] === 'ci') {
      files.set(join(sandboxPaths.slotDir, 'node_modules', '@deepseek-ai', 'dsh'), '{}')
    }
    if (command === 'node' && args.includes('isolate')) directories.add(sandboxPaths.dshHome)
    if (command === 'git' && args[0] === 'clone') files.set(join(sandboxPaths.agUiDir, '.git'), 'ref: refs/heads/main')
    if (command === 'pnpm' && args[0] === 'install' && cwd === sandboxPaths.profileDir) {
      files.set(join(sandboxPaths.profileDir, 'node_modules'), '')
    }
    return ''
  }
  const filesystem = {
    exists: (path: string) => files.has(path) || links.has(path) || directories.has(path),
    readFile: async (path: string) => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content)
    },
    appendFile: async (path: string, content: string) => {
      files.set(path, `${files.get(path) ?? ''}${content}`)
    },
    readlink: async (path: string) => {
      const target = links.get(path)
      if (target === undefined) throw new Error(`ENOENT: ${path}`)
      return target
    },
    symlink: async (target: string, path: string) => {
      links.set(path, target)
    },
    rm: async (path: string) => {
      files.delete(path)
      links.delete(path)
      directories.delete(path)
    },
    cp: async (from: string, to: string) => {
      const content = files.get(from)
      if (content === undefined) throw new Error(`ENOENT: ${from}`)
      files.set(to, content)
    },
    mkdir: async (path: string) => {
      directories.add(path)
    },
  }
  options.preexisting?.({ files, links, directories })
  const dependencies: DshEnsureDependencies = {
    environment: { CLINMESH_DSH_BRIDGE_SECRET: 'existing-bridge-secret', ...options.environment },
    repositoryRoot,
    sandbox: sandboxPaths,
    versions,
    filesystem,
    runCommand,
    randomBytes: size => Buffer.alloc(size, 7),
    write: message => writes.push(message),
  }
  return { dependencies, files, links, directories, commands, writes, surfaceCommitRef, agUiCommitRef }
}

describe('ensureDshRuntimeReady', () => {
  it('reports missing commands without a network retry', async () => {
    const fake = createFakeDependencies()
    const run = fake.dependencies.runCommand
    fake.dependencies.runCommand = async (...args) => {
      if (args[0] === 'npm') throw Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' })
      return run(...args)
    }
    await expect(ensureDshRuntimeReady(fake.dependencies)).rejects.toMatchObject({ hint: expect.stringContaining('PATH') })
    expect(fake.writes.some(message => message.includes('重试'))).toBe(false)
  })
  it('provisions the whole runtime on a cold sandbox', async () => {
    const { dependencies, files, links, commands } = createFakeDependencies()
    const { repositoryRoot, sandbox, versions } = dependencies
    const checkout = join(repositoryRoot, 'vendor/dsh-react-surface')
    const result = await ensureDshRuntimeReady(dependencies)

    const sequence = commands.map(({ command, args, cwd }) => `${command} ${args.join(' ')} @ ${cwd}`)
    const markers = [
      `bun --version @ ${repositoryRoot}`,
      `npm install --prefix ${sandbox.toolingDir} @dsh-so/dshvm@${versions.dshvmVersion} @ ${repositoryRoot}`,
      `node ${sandbox.dshvmCli} install ${versions.dshVersion} @ ${sandbox.root}`,
      `npm ci @ ${sandbox.slotDir}`,
      `node ${sandbox.dshvmCli} isolate ${versions.dshVersion} @ ${sandbox.root}`,
      `bun install --frozen-lockfile @ ${checkout}`,
      `bun run build:runtime @ ${checkout}`,
      `git clone ${versions.agUiSource} ${sandbox.agUiDir} @ ${sandbox.root}`,
      `pnpm install --frozen-lockfile @ ${sandbox.agUiDir}`,
      `pnpm build @ ${sandbox.agUiDir}`,
      `pnpm --filter @clinmesh/dsh-web build @ ${repositoryRoot}`,
      `pnpm install --frozen-lockfile @ ${sandbox.profileDir}`,
    ]
    let cursor = -1
    for (const marker of markers) {
      const index = sequence.indexOf(marker, cursor + 1)
      expect(index, `缺少或乱序：${marker}`).toBeGreaterThan(cursor)
      cursor = index
    }
    const useIndex = commands.findIndex(({ command, args }) =>
      command === 'node' && args.includes('use'))
    const isolateIndex = commands.findIndex(({ command, args }) =>
      command === 'node' && args.includes('isolate'))
    expect(useIndex).toBeGreaterThan(isolateIndex)

    const dshvmInstall = commands.find(({ args }) => args.includes('install') && args[0] !== 'install')
    expect(dshvmInstall?.environment).toMatchObject({ DSHVM_HOME: sandbox.versionsDir })

    expect(result.profileNewlyAssembled).toBe(true)
    expect(files.get(join(sandbox.slotDir, 'package.json'))).toBe(files.get(join(repositoryRoot, 'deployment/dsh/host/package.json')))
    expect(files.get(join(sandbox.profileDir, 'package.json'))).toBe(files.get(join(repositoryRoot, 'deployment/dsh/profile/package.json')))
    expect(links.get(join(sandbox.profileDir, 'plugins/ag-ui'))).toBe(sandbox.agUiDir)
    expect(links.get(join(sandbox.profileDir, 'plugins/react-surface'))).toBe(join(checkout, 'packages/runtime'))
    expect(links.get(join(sandbox.profileDir, 'plugins/clinmesh'))).toBe(join(repositoryRoot, 'apps/dsh-web'))
    expect(JSON.parse(files.get(sandbox.stampPath) ?? '{}')).toEqual({
      surfaceCommit,
      agUiCommit: versions.agUiCommit,
    })
    expect(files.get(join(repositoryRoot, '.env'))).toBe('CLINMESH_AUTH_SECRET=dev-only\n')
  })

  it('skips provisioning on a warm sandbox', async () => {
    const fake = createFakeDependencies()
    const { dependencies, commands } = fake
    await ensureDshRuntimeReady(dependencies)
    commands.length = 0
    const result = await ensureDshRuntimeReady(dependencies)

    const provisioning = commands.filter(({ command, args }) => {
      const invocation = `${command} ${args.join(' ')}`
      if (invocation === 'pnpm --filter @clinmesh/dsh-web build') return true
      return /install|clone|^npm ci|isolate|build:runtime|^pnpm build/.test(invocation)
    })
    expect(provisioning).toEqual([
      expect.objectContaining({ command: 'pnpm', args: ['--filter', '@clinmesh/dsh-web', 'build'] }),
    ])
    expect(result.profileNewlyAssembled).toBe(false)
  })

  it('re-points stale profile links after the repository moves without reinstalling', async () => {
    const fake = createFakeDependencies()
    const { dependencies, links, commands } = fake
    await ensureDshRuntimeReady(dependencies)
    const pluginLinks = join(dependencies.sandbox.profileDir, 'plugins')
    for (const name of ['ag-ui', 'react-surface', 'clinmesh']) {
      links.set(join(pluginLinks, name), join('/old-repo', name))
    }
    commands.length = 0

    await ensureDshRuntimeReady(dependencies)

    expect(links.get(join(pluginLinks, 'ag-ui'))).toBe(dependencies.sandbox.agUiDir)
    expect(links.get(join(pluginLinks, 'react-surface'))).toBe(
      join(dependencies.repositoryRoot, 'vendor/dsh-react-surface/packages/runtime'),
    )
    expect(links.get(join(pluginLinks, 'clinmesh'))).toBe(
      join(dependencies.repositoryRoot, 'apps/dsh-web'),
    )
    expect(commands.filter(({ args }) => args.includes('install'))).toEqual([])
  })

  it('rebuilds only the surface runtime when the submodule commit changes', async () => {
    const fake = createFakeDependencies()
    const { dependencies, commands, files } = fake
    await ensureDshRuntimeReady(dependencies)
    fake.surfaceCommitRef.value = 'e'.repeat(40)
    commands.length = 0

    await ensureDshRuntimeReady(dependencies)

    const checkout = join(dependencies.repositoryRoot, 'vendor/dsh-react-surface')
    const sequence = commands.map(({ command, args, cwd }) => `${command} ${args.join(' ')} @ ${cwd}`)
    expect(sequence).toContain(`bun install --frozen-lockfile @ ${checkout}`)
    expect(sequence).toContain(`bun run build:runtime @ ${checkout}`)
    expect(sequence.some(entry => entry.startsWith('pnpm build @ ') && entry.endsWith('/ag-ui'))).toBe(false)
    expect(JSON.parse(files.get(dependencies.sandbox.stampPath) ?? '{}'))
      .toMatchObject({ surfaceCommit: 'e'.repeat(40), agUiCommit: dependencies.versions.agUiCommit })
  })

  it('re-checks out and rebuilds only ag-ui when its commit drifts from the lock', async () => {
    const fake = createFakeDependencies()
    const { dependencies, commands, files } = fake
    await ensureDshRuntimeReady(dependencies)
    fake.agUiCommitRef.value = '9'.repeat(40)
    commands.length = 0

    await ensureDshRuntimeReady(dependencies)

    const checkout = join(dependencies.repositoryRoot, 'vendor/dsh-react-surface')
    const sequence = commands.map(({ command, args, cwd }) => `${command} ${args.join(' ')} @ ${cwd}`)
    expect(sequence).toContain(`git checkout --detach ${dependencies.versions.agUiCommit} @ ${dependencies.sandbox.agUiDir}`)
    expect(sequence).toContain(`pnpm install --frozen-lockfile @ ${dependencies.sandbox.agUiDir}`)
    expect(sequence).toContain(`pnpm build @ ${dependencies.sandbox.agUiDir}`)
    expect(sequence).not.toContain(`bun install --frozen-lockfile @ ${checkout}`)
    expect(JSON.parse(files.get(dependencies.sandbox.stampPath) ?? '{}'))
      .toMatchObject({ surfaceCommit, agUiCommit: dependencies.versions.agUiCommit })
  })

  it('restores host dependencies when the deployment host template changes', async () => {
    const fake = createFakeDependencies()
    const { dependencies, commands, files } = fake
    await ensureDshRuntimeReady(dependencies)
    files.set(
      join(dependencies.repositoryRoot, 'deployment/dsh/host/package.json'),
      '{"name":"dshvm-slot","changed":true}',
    )
    commands.length = 0

    await ensureDshRuntimeReady(dependencies)

    expect(files.get(join(dependencies.sandbox.slotDir, 'package.json'))).toContain('changed')
    const sequence = commands.map(({ command, args, cwd }) => `${command} ${args.join(' ')} @ ${cwd}`)
    expect(sequence).toContain(`npm ci @ ${dependencies.sandbox.slotDir}`)
  })

  it('generates and appends a bridge secret when .env lacks one', async () => {
    const fake = createFakeDependencies({ environment: { CLINMESH_DSH_BRIDGE_SECRET: undefined } })
    const { dependencies, files } = fake
    await ensureDshRuntimeReady(dependencies)

    const env = files.get(join(dependencies.repositoryRoot, '.env')) ?? ''
    const secret = /CLINMESH_DSH_BRIDGE_SECRET=([0-9a-f]+)/.exec(env)?.[1]
    expect(secret?.length).toBeGreaterThanOrEqual(64)
    expect(env.startsWith('CLINMESH_AUTH_SECRET=dev-only\n')).toBe(true)
  })

  it('fails before provisioning when .env is missing', async () => {
    const fake = createFakeDependencies()
    fake.files.delete(join(fake.dependencies.repositoryRoot, '.env'))

    await expect(ensureDshRuntimeReady(fake.dependencies)).rejects.toThrow('.env')
    expect(fake.commands.filter(({ args }) => args.includes('install') || args[0] === 'ci')).toEqual([])
  })

  it('retries a failing network step once and continues', async () => {
    const fake = createFakeDependencies({
      failureInjection: { command: 'npm', argument: '--prefix', times: 1 },
    })
    const { dependencies, writes } = fake

    await expect(ensureDshRuntimeReady(dependencies)).resolves.toMatchObject({ profileNewlyAssembled: true })

    const toolingInstalls = fake.commands.filter(({ command, args }) =>
      command === 'npm' && args[0] === 'install' && args[1] === '--prefix')
    expect(toolingInstalls).toHaveLength(2)
    expect(writes).toContain('⚠ 安装 dshvm 工具目录失败，自动重试一次…')
  })

  it('fails fast with a reason after the retry exhausts', async () => {
    const fake = createFakeDependencies({
      failureInjection: { command: 'npm', argument: '--prefix', times: 5 },
    })

    await expect(ensureDshRuntimeReady(fake.dependencies)).rejects.toThrow('dshvm 工具目录')
    expect(fake.commands.some(({ args }) => args.includes('isolate'))).toBe(false)
  })

  it('fails before any provisioning when Bun 1.4.x is unavailable', async () => {
    const fake = createFakeDependencies({ bunVersion: '1.3.0' })

    await expect(ensureDshRuntimeReady(fake.dependencies)).rejects.toThrow('Bun 1.4.x')
    expect(fake.commands.filter(({ args }) => args.includes('install'))).toEqual([])
  })
})
