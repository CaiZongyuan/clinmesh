import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const entry = fileURLToPath(new URL('./ci.ts', import.meta.url))
const directories: string[] = []
const serverTest = 'apps/server/tests/example.test.ts'
const secondServerTest = 'apps/server/tests/second.test.ts'
const browserTest = 'apps/dsh-web/src/client/example.browser.test.ts'
const e2eTest = 'apps/web/e2e/example.spec.ts'

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function sandbox() {
  const directory = mkdtempSync(join(tmpdir(), 'clinmesh-ci-cli-'))
  directories.push(directory)
  const configuration = join(directory, 'gitconfig')
  writeFileSync(configuration, '')
  const env = { ...process.env, GIT_CONFIG_GLOBAL: configuration, GIT_CONFIG_NOSYSTEM: '1',
    GITHUB_EVENT_NAME: '', GITHUB_SHA: '', GITHUB_EVENT_PATH: '', GITHUB_OUTPUT: '', CI_PLAN: '', CI_RESULTS: '',
    CI_SUCCESS_DIR: '', GITHUB_STEP_SUMMARY: '', GITHUB_REPOSITORY: '', GITHUB_SERVER_URL: '', GITHUB_RUN_ID: '',
    GITHUB_RUN_ATTEMPT: '', RUNNER_OS: '', RUNNER_ARCH: '', ImageOS: '', ImageVersion: '' }
  const git = (args: string[], cwd = directory) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const write = (path: string, value: string) => {
    const target = join(directory, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, value)
  }
  return { directory, env, git, write }
}

function pullRequest(commits: Array<Record<string, string>>, baseline: Record<string, string> = {}) {
  const fixture = sandbox()
  const { directory, env, git, write } = fixture
  git(['init', '--initial-branch=main'])
  git(['config', 'user.name', 'Synthetic CI'])
  git(['config', 'user.email', 'synthetic-ci@example.test'])
  write('README.md', '# Synthetic baseline\n')
  for (const path of [serverTest, secondServerTest, browserTest, e2eTest]) {
    write(path, "import { test } from 'vitest'\ntest('synthetic baseline', () => {})\n")
  }
  for (const [path, value] of Object.entries(baseline)) write(path, value)
  git(['add', '.'])
  git(['commit', '-m', 'synthetic baseline'])
  const base = git(['rev-parse', 'HEAD'])
  git(['switch', '-c', 'synthetic-pr'])
  for (const [index, files] of commits.entries()) {
    for (const [path, value] of Object.entries(files)) write(path, value)
    git(['add', '.'])
    git(['commit', '--allow-empty', '-m', `synthetic change ${index}`])
  }
  const head = git(['rev-parse', 'HEAD'])
  git(['switch', 'main'])
  git(['merge', '--no-ff', 'synthetic-pr', '-m', 'synthetic candidate merge'])
  const merge = git(['rev-parse', 'HEAD'])
  const event = { number: 1, pull_request: { number: 1, base: { sha: base }, head: { sha: head } } }
  const eventPath = join(directory, 'event.json')
  const outputPath = join(directory, 'output.txt')
  writeFileSync(eventPath, JSON.stringify(event))
  return { ...fixture, base, head, merge, eventPath, outputPath, event,
    env: { ...env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: merge, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath } }
}

async function run(cwd: string, args: string[], env: NodeJS.ProcessEnv, script = entry) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [script, ...args], { cwd, env }, (error, stdout, stderr) => {
      if (!error) resolve({ code: 0, stdout, stderr })
      else if (typeof error.code === 'number') resolve({ code: error.code, stdout, stderr })
      else reject(error)
    })
  })
}

function readPlan(result: Awaited<ReturnType<typeof run>>): unknown {
  expect(result.code).toBe(0)
  expect(result.stdout.trim()).not.toBe('')
  return JSON.parse(result.stdout)
}

function commands() {
  const fixture = sandbox()
  for (const directory of ['apps/server', 'apps/web', 'apps/dsh-web', 'apps/cli',
    'apps/desktop', 'packages/contracts', 'packages/core', 'packages/ui', 'packages/views']) {
    mkdirSync(join(fixture.directory, directory), { recursive: true })
  }
  for (const path of [serverTest, browserTest, e2eTest]) fixture.write(path, '// synthetic test entry\n')
  return withPnpm(fixture)
}

function withPnpm<T extends ReturnType<typeof sandbox>>(fixture: T) {
  const log = join(fixture.directory, 'commands.jsonl')
  const binary = join(fixture.directory, 'bin', 'pnpm')
  fixture.write('bin/pnpm', `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.CI_TEST_COMMAND_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n')
if (process.env.CI_TEST_FAIL_ON && args.includes(process.env.CI_TEST_FAIL_ON)) process.exit(23)
`)
  chmodSync(binary, 0o755)
  if (process.platform === 'win32') fixture.write('bin/pnpm.cmd', `@"${process.execPath}" "${binary}" %*\r\n`)
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  return { ...fixture, env: { ...fixture.env,
    [pathKey]: `${dirname(binary)}${delimiter}${process.env[pathKey] ?? ''}`,
    CI_TEST_COMMAND_LOG: log },
    calls: (): Array<{ args: string[]; cwd: string }> => existsSync(log)
      ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] }
}

const fullPlan = { mode: 'full', tests: [], docs: true, reason: 'synthetic full verification' }
const testsPlan = { mode: 'tests', tests: [serverTest, browserTest, e2eTest], docs: false, reason: 'synthetic existing tests' }

describe('CI CLI with a real candidate merge', () => {
  it('prints the documentation plan and matching required-stage outputs', async () => {
    const fixture = pullRequest([{ 'README.md': '# Updated synthetic documentation\n' }])
    const result = await run(fixture.directory, ['plan'], fixture.env)
    const plan = readPlan(result)
    expect(plan).toMatchObject({ mode: 'docs', tests: [], docs: true, reason: expect.any(String) })
    const outputs = Object.fromEntries(readFileSync(fixture.outputPath, 'utf8').trim().split('\n').map(line => {
      const equals = line.indexOf('=')
      return [line.slice(0, equals), line.slice(equals + 1)]
    }))
    expect(JSON.parse(outputs.selection!)).toEqual(plan)
    expect(outputs).toMatchObject({ checks: 'true', unit: 'false', browser: 'false', e2e: 'false',
      unit_shards: '["1/1"]', browser_shards: '["1/1"]' })
  })

  it('runs every group for engineering skill configuration mixed with ordinary documentation', async () => {
    const fixture = pullRequest([{
      'docs/agents/issue-tracker.md': '# Updated engineering skill configuration\n',
      'README.md': '# Updated ordinary documentation\n',
    }], { 'docs/agents/issue-tracker.md': '# Existing engineering skill configuration\n' })

    expect(readPlan(await run(fixture.directory, ['plan'], fixture.env))).toMatchObject({ mode: 'full', tests: [], docs: true })
    const outputs = readFileSync(fixture.outputPath, 'utf8')
    for (const stage of ['checks', 'unit', 'browser', 'e2e']) expect(outputs).toContain(`${stage}=true\n`)
    expect(outputs).toContain('unit_shards=["1/2","2/2"]\n')
    expect(outputs).toContain('browser_shards=["1/2","2/2"]\n')
  })

  it('selects all test changes across the PR rather than only its last commit', async () => {
    const fixture = pullRequest([
      { [serverTest]: '// changed by the first PR commit\n' },
      { [secondServerTest]: '// changed by the second PR commit\n', 'README.md': '# Documentation updated too\n' },
    ])
    const plan = readPlan(await run(fixture.directory, ['plan'], fixture.env))
    expect(plan).toMatchObject({ mode: 'tests', tests: [serverTest, secondServerTest], docs: true })
  })

  it('can plan from the same depth-two checkout used by Actions', async () => {
    const fixture = pullRequest([{ [serverTest]: '// updated synthetic test\n' }])
    const shallow = join(fixture.directory, 'shallow')
    fixture.git(['clone', '--depth', '2', pathToFileURL(fixture.directory).href, shallow])
    expect(fixture.git(['rev-parse', '--is-shallow-repository'], shallow)).toBe('true')
    expect(readPlan(await run(shallow, ['plan'], fixture.env)))
      .toMatchObject({ mode: 'tests', tests: [serverTest], docs: false })
  })

  it.each(['checkout', 'base', 'head'])('falls back to full when the event %s binding does not match', async binding => {
    const fixture = pullRequest([{ 'README.md': '# Changed documentation\n' }])
    const env = { ...fixture.env }
    if (binding === 'checkout') env.GITHUB_SHA = fixture.head
    else {
      if (binding === 'base') fixture.event.pull_request.base.sha = 'a'.repeat(40)
      else fixture.event.pull_request.head.sha = 'a'.repeat(40)
      writeFileSync(fixture.eventPath, JSON.stringify(fixture.event))
    }
    expect(readPlan(await run(fixture.directory, ['plan'], env)))
      .toMatchObject({ mode: 'full', tests: [], docs: true })
  })

  it('falls back to full if the merge parent objects are unavailable', async () => {
    const fixture = pullRequest([{ 'README.md': '# Changed documentation\n' }])
    const shallow = join(fixture.directory, 'depth-one')
    fixture.git(['clone', '--depth', '1', pathToFileURL(fixture.directory).href, shallow])
    expect(readPlan(await run(shallow, ['plan'], fixture.env)))
      .toMatchObject({ mode: 'full', tests: [], docs: true })
  })

  it('keeps main push full even when the candidate diff contains only documentation', async () => {
    const fixture = pullRequest([{ 'README.md': '# Changed documentation\n' }])
    expect(readPlan(await run(fixture.directory, ['plan'], { ...fixture.env, GITHUB_EVENT_NAME: 'push' })))
      .toMatchObject({ mode: 'full', tests: [], docs: true })
  })

  it('falls back to full when the PR event cannot be read', async () => {
    const fixture = pullRequest([{ 'README.md': '# Changed documentation\n' }])
    expect(readPlan(await run(fixture.directory, ['plan'], { ...fixture.env, GITHUB_EVENT_PATH: join(fixture.directory, 'absent.json') })))
      .toMatchObject({ mode: 'full', tests: [], docs: true })
  })

  it('falls back to full for a candidate with no content changes', async () => {
    const fixture = pullRequest([{}])
    expect(readPlan(await run(fixture.directory, ['plan'], fixture.env))).toMatchObject({ mode: 'full' })
  })

  it('keeps an exported test helper out of the independent-test path', async () => {
    const fixture = pullRequest([{ [serverTest]: 'export const sharedTestValue = 1\n' }])
    expect(readPlan(await run(fixture.directory, ['plan'], fixture.env)))
      .toMatchObject({ mode: 'full', reason: '测试入口被共享或无法证明独立' })
  })

  it('keeps a test entry imported by another file out of the independent-test path', async () => {
    const fixture = pullRequest([{ [serverTest]: '// changed shared test\n' }], {
      'apps/server/shared.ts': "import './tests/example.test.ts'\n",
    })
    expect(readPlan(await run(fixture.directory, ['plan'], fixture.env)))
      .toMatchObject({ mode: 'full', reason: '测试入口被共享或无法证明独立' })
  })

  it('runs the planner and final gate without installed dependencies', async () => {
    const fixture = pullRequest([{ 'README.md': '# Documentation only\n' }])
    const script = join(fixture.directory, 'ci.ts')
    copyFileSync(entry, script)
    fixture.write('package.json', '{"type":"module"}\n')
    const plan = readPlan(await run(fixture.directory, ['plan'], fixture.env, script))
    const results = { plan: { result: 'success' }, checks: { result: 'success' },
      unit: { result: 'skipped' }, browser: { result: 'skipped' }, e2e: { result: 'skipped' } }
    expect((await run(fixture.directory, ['verify'], {
      ...fixture.env, CI_PLAN: JSON.stringify(plan), CI_RESULTS: JSON.stringify(results),
    }, script)).code).toBe(0)
    expect(existsSync(join(fixture.directory, 'node_modules'))).toBe(false)
  })
})

describe('CI command execution boundary', () => {
  it('prepares generated DSH styles separately for every non-document execution runner', async () => {
    const fixture = commands()
    expect((await run(fixture.directory, ['prepare'], {
      ...fixture.env, CI_PLAN: JSON.stringify(fullPlan),
    })).code).toBe(0)
    expect(fixture.calls().map(call => call.args)).toEqual([
      ['--filter', '@clinmesh/dsh-web', 'build:styles'],
    ])
  })

  it('does not prepare UI artifacts for a documentation-only runner', async () => {
    const fixture = commands()
    expect((await run(fixture.directory, ['prepare'], {
      ...fixture.env, CI_PLAN: JSON.stringify({ mode: 'docs', tests: [], docs: true, reason: 'documentation' }),
    })).code).toBe(0)
    expect(fixture.calls()).toEqual([])
  })

  it('keeps a documentation-only stage limited to documentation checks', async () => {
    const fixture = commands()
    const plan = { mode: 'docs', tests: [], docs: true, reason: 'synthetic documentation only' }
    expect((await run(fixture.directory, ['run', 'checks'], { ...fixture.env, CI_PLAN: JSON.stringify(plan) })).code).toBe(0)
    const scripts = fixture.calls().map(call => call.args[0])
    expect(scripts.length).toBeGreaterThan(0)
    expect(scripts.every(script => ['doc-sync', 'verify:docs', 'verify:agent-notes', 'docs:check', 'docs:build'].includes(script!))).toBe(true)
    expect(scripts.includes('doc-sync') || scripts.includes('verify:docs') && scripts.includes('docs:check')).toBe(true)
  })

  it('propagates a failed command and stops the remaining checks', async () => {
    const fixture = commands()
    const result = await run(fixture.directory, ['run', 'checks'], {
      ...fixture.env, CI_PLAN: JSON.stringify(fullPlan), CI_TEST_FAIL_ON: 'typecheck',
    })
    expect(result.code).not.toBe(0)
    expect(fixture.calls().map(call => call.args)).toEqual([['verify:boundaries'], ['typecheck']])
  })

  it('executes the existing full checks, including the short budget gate and Mobile', async () => {
    const fixture = commands()
    expect((await run(fixture.directory, ['run', 'checks'], { ...fixture.env, CI_PLAN: JSON.stringify(fullPlan) })).code).toBe(0)
    expect(fixture.calls().map(call => call.args)).toEqual([
      ['verify:boundaries'], ['typecheck'], ['lint'], ['perf:ci'], ['doc-sync'], ['build'], ['check:mobile'],
    ])
  })

  it.each([
    { stage: 'unit', shard: '2/2', expected: [['test:packages', '--', '--shard=2/2'], ['test:scripts', '--shard=2/2']] },
    { stage: 'browser', shard: '1/2', expected: [['exec', 'playwright', 'install', '--with-deps', 'chromium'],
      ['test:browser', '--shard=1/2', '--grep-invert=@surgery-flow'], ['test:browser', '--grep=@surgery-flow']] },
    { stage: 'browser', shard: '2/2', expected: [['exec', 'playwright', 'install', '--with-deps', 'chromium'],
      ['test:browser', '--shard=2/2', '--grep-invert=@surgery-flow']] },
    { stage: 'e2e', shard: '1/1', expected: [['exec', 'playwright', 'install', '--with-deps', 'chromium'],
      ['test:e2e', '--grep-invert=@surgery-flow'], ['test:e2e', '--grep=@surgery-flow']] },
  ])('runs complete $stage shard $shard on its own runner', async ({ stage, shard, expected }) => {
    const fixture = commands()
    expect((await run(fixture.directory, ['run', stage, shard], { ...fixture.env, CI_PLAN: JSON.stringify(fullPlan) })).code).toBe(0)
    expect(fixture.calls().map(call => call.args)).toEqual(expected)
  })

  it.each(['--grep-invert=@surgery-flow', '--grep=@surgery-flow'])('fails the browser stage when phase %s fails', async flag => {
    const fixture = commands()
    const result = await run(fixture.directory, ['run', 'browser', '1/2'], {
      ...fixture.env, CI_PLAN: JSON.stringify(fullPlan), CI_TEST_FAIL_ON: flag,
    })
    expect(result.code).not.toBe(0)
    expect(fixture.calls().map(call => call.args)).toEqual([
      ['exec', 'playwright', 'install', '--with-deps', 'chromium'],
      ['test:browser', '--shard=1/2', '--grep-invert=@surgery-flow'],
      ...(flag === '--grep=@surgery-flow' ? [['test:browser', '--grep=@surgery-flow']] : []),
    ])
  })

  it.each([
    { name: 'an unsharded complete unit suite', args: ['run', 'unit'] },
    { name: 'a shard beyond the count', args: ['run', 'unit', '3/2'] },
    { name: 'a malformed shard', args: ['run', 'browser', '1/2;touch injected.txt'] },
    { name: 'a sharded end-to-end suite', args: ['run', 'e2e', '1/2'] },
  ])('rejects $name before starting any pnpm process', async ({ args }) => {
    const fixture = commands()
    const result = await run(fixture.directory, args, { ...fixture.env, CI_PLAN: JSON.stringify(fullPlan) })
    expect(result.code).not.toBe(0)
    expect(fixture.calls()).toEqual([])
    expect(existsSync(join(fixture.directory, 'injected.txt'))).toBe(false)
  })

  it('selects the whole unit file through its owning package without passWithNoTests', async () => {
    const fixture = commands()
    fixture.write(serverTest, '// synthetic test entry\n')
    expect((await run(fixture.directory, ['run', 'unit'], { ...fixture.env, CI_PLAN: JSON.stringify(testsPlan) })).code).toBe(0)
    const calls = fixture.calls()
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.args).toContain('vitest')
    expect(call.args).toContain('run')
    expect(call.args.some(arg => arg.endsWith('tests/example.test.ts'))).toBe(true)
    expect(call.cwd === join(fixture.directory, 'apps/server')
      || call.args.some(arg => ['@clinmesh/server', './apps/server', 'apps/server', join(fixture.directory, 'apps/server')].includes(arg))).toBe(true)
    expect(call.args.some(arg => arg === '--passWithNoTests' || arg === '--passWithNoTests=true')).toBe(false)
    expect(call.args.some(arg => ['-t', '--testNamePattern', '--grep'].some(flag => arg === flag || arg.startsWith(`${flag}=`)))).toBe(false)
  })

  it('does not turn a selected runner failure into a passing stage', async () => {
    const fixture = commands()
    fixture.write(serverTest, '// synthetic test entry\n')
    const result = await run(fixture.directory, ['run', 'unit'], {
      ...fixture.env, CI_PLAN: JSON.stringify(testsPlan), CI_TEST_FAIL_ON: 'vitest',
    })
    expect(result.code).not.toBe(0)
    expect(fixture.calls()).toHaveLength(1)
  })

  it.each([
    { stage: 'browser', project: 'contracts', path: browserTest },
    { stage: 'e2e', project: 'web', path: e2eTest },
  ])('installs Chromium before selecting the complete $stage file', async ({ stage, project, path }) => {
    const fixture = commands()
    fixture.write(path, '// synthetic test entry\n')
    expect((await run(fixture.directory, ['run', stage], { ...fixture.env, CI_PLAN: JSON.stringify(testsPlan) })).code).toBe(0)
    const calls = fixture.calls()
    const install = calls.findIndex(call => call.args.includes('install') && call.args.includes('chromium'))
    const selected = calls.findIndex(call => call.args.includes('playwright') && call.args.includes('test'))
    expect(install).toBeGreaterThanOrEqual(0)
    expect(selected).toBeGreaterThan(install)
    const invocation = calls[selected]!.args
    expect(invocation.join(' ')).toMatch(new RegExp(`--project(?:=| )${project}`))
    expect(invocation.some(arg => arg.replaceAll('\\.', '.').replace(/\$$/, '').endsWith(path))).toBe(true)
    expect(invocation.some(arg => ['-g', '--grep', '--grep-invert'].some(flag => arg === flag || arg.startsWith(`${flag}=`)))).toBe(false)
    expect(invocation).not.toContain('--pass-with-no-tests')
  })

  it.each([
    { name: 'shell text in a path', tests: ['apps/server/tests/example.test.ts;touch injected.txt'] },
    { name: 'parent traversal', tests: ['apps/server/tests/../secret.test.ts'] },
    { name: 'unknown test owner', tests: ['apps/unknown/tests/example.test.ts'] },
    { name: 'empty test selection', tests: [] },
  ])('rejects $name before starting any pnpm process', async ({ tests }) => {
    const fixture = commands()
    const result = await run(fixture.directory, ['run', 'unit'], {
      ...fixture.env, CI_PLAN: JSON.stringify({ ...testsPlan, tests }),
    })
    expect(result.code).not.toBe(0)
    expect(fixture.calls()).toEqual([])
    expect(existsSync(join(fixture.directory, 'injected.txt'))).toBe(false)
  })
})

describe('CI result aggregation through the CLI', () => {
  const unitPlan = { ...testsPlan, tests: [serverTest] }
  const passing = {
    plan: { result: 'success' }, checks: { result: 'success' }, unit: { result: 'success' },
    browser: { result: 'skipped' }, e2e: { result: 'skipped' },
  }

  it.each(['skipped', 'success'])('accepts an explicitly unneeded group with result %s when required groups passed', async status => {
    const fixture = sandbox()
    expect((await run(fixture.directory, ['verify'], {
      ...fixture.env, CI_PLAN: JSON.stringify(unitPlan), CI_RESULTS: JSON.stringify({ ...passing, browser: { result: status } }),
    })).code).toBe(0)
  })

  it.each(['failure', 'cancelled', 'skipped', 'missing', 'unknown'])('rejects a required group with result %s', async status => {
    const fixture = sandbox()
    const results: Record<string, { result: string }> = { ...passing }
    if (status === 'missing') delete results.unit
    else results.unit = { result: status }
    expect((await run(fixture.directory, ['verify'], {
      ...fixture.env, CI_PLAN: JSON.stringify(unitPlan), CI_RESULTS: JSON.stringify(results),
    })).code).not.toBe(0)
  })

  it.each(['plan', 'browser'])('rejects failure in %s even when all selected test groups passed', async group => {
    const fixture = sandbox()
    const results = { ...passing, [group]: { result: 'failure' } }
    expect((await run(fixture.directory, ['verify'], {
      ...fixture.env, CI_PLAN: JSON.stringify(unitPlan), CI_RESULTS: JSON.stringify(results),
    })).code).not.toBe(0)
  })
})

describe('CI success reuse through the CLI', () => {
  const sourceChange = { 'apps/server/src/runtime.ts': 'export const runtime = 2\n' }
  const groups = [['checks'], ['unit', '1/2'], ['browser', '1/2'], ['e2e']] as const

  function reusable(commits: Array<Record<string, string>>, baseline: Record<string, string> = {}) {
    const fixture = withPnpm(pullRequest(commits, {
      'apps/server/src/runtime.ts': 'export const runtime = 1\n', 'docs/guide.md': '# 指南\n\n普通说明。\n', ...baseline,
    }))
    const records = sandbox().directory
    return { ...fixture, records: join(records, 'ci-success'), summary: join(records, 'summary.md'), env: { ...fixture.env,
      CI_SUCCESS_DIR: join(records, 'ci-success'), GITHUB_STEP_SUMMARY: join(records, 'summary.md'),
      GITHUB_REPOSITORY: 'synthetic/clinmesh', GITHUB_SERVER_URL: 'https://github.example', GITHUB_RUN_ID: '101',
      GITHUB_RUN_ATTEMPT: '1', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', ImageOS: 'ubuntu24', ImageVersion: '20261101.1' } }
  }

  function output(path: string, name: string): string | undefined {
    if (!existsSync(path)) return undefined
    return readFileSync(path, 'utf8').trim().split('\n').filter(line => line.startsWith(`${name}=`)).at(-1)?.slice(name.length + 1)
  }

  async function plannedEnv(fixture: ReturnType<typeof reusable>, env = fixture.env) {
    return { ...env, CI_PLAN: JSON.stringify(readPlan(await run(fixture.directory, ['plan'], env))) }
  }

  async function key(fixture: ReturnType<typeof reusable>, stage: string, shard?: string, env = fixture.env) {
    const outputPath = join(sandbox().directory, 'fingerprint.txt')
    const result = await run(fixture.directory, ['fingerprint', stage, ...(shard ? [shard] : [])],
      { ...await plannedEnv(fixture, env), GITHUB_OUTPUT: outputPath })
    expect(result.code, result.stderr).toBe(0)
    return output(outputPath, 'key')
  }

  async function keys(fixture: ReturnType<typeof reusable>) {
    return Object.fromEntries(await Promise.all(groups.map(async ([stage, shard]) => [stage, await key(fixture, stage, shard)])))
  }

  it('reuses identical candidate content after only the commit history changed', async () => {
    const fixture = reusable([sourceChange])
    const before = await keys(fixture)
    for (const value of Object.values(before)) expect(value).toMatch(/^ci-success-v1-pr1-/)
    const rebuilt = fixture.git(['commit-tree', `${fixture.merge}^{tree}`, '-p', fixture.base, '-p', fixture.head, '-m', 'rebuilt candidate'])
    fixture.git(['reset', '--hard', rebuilt])
    expect(rebuilt).not.toBe(fixture.merge)
    expect(await keys({ ...fixture, env: { ...fixture.env, GITHUB_SHA: rebuilt } })).toEqual(before)
  })

  it('separates records by pull request, shard and runner image', async () => {
    const fixture = reusable([sourceChange])
    const original = await key(fixture, 'unit', '1/2')
    expect(await key(fixture, 'unit', '2/2')).not.toBe(original)
    expect(await key(fixture, 'unit', '1/2', { ...fixture.env, ImageVersion: '20261108.1' })).not.toBe(original)
    writeFileSync(fixture.eventPath, JSON.stringify({ ...fixture.event, number: 2, pull_request: { ...fixture.event.pull_request, number: 2 } }))
    expect(await key(fixture, 'unit', '1/2')).toMatch(/^ci-success-v1-pr2-/)
  })

  it('reruns only documentation checks after an ordinary documentation edit', async () => {
    const before = await keys(reusable([sourceChange]))
    const after = await keys(reusable([sourceChange, {
      'docs/guide.md': '# 指南\n\n补充一段普通说明。\n', 'docs/new-note.md': '# 新说明\n\n仅有中文正文。\n',
    }]))
    expect(after.checks).not.toBe(before.checks)
    expect({ unit: after.unit, browser: after.browser, e2e: after.e2e }).toEqual({ unit: before.unit, browser: before.browser, e2e: before.e2e })
  })

  it('reruns test groups when documentation adds a Tailwind candidate', async () => {
    const before = await keys(reusable([sourceChange]))
    const after = await keys(reusable([sourceChange, { 'docs/guide.md': '# 指南\n\n普通说明 `bg-rose-500`。\n' }]))
    for (const stage of ['checks', 'unit', 'browser', 'e2e']) expect(after[stage]).not.toBe(before[stage])
  })

  it('reuses other test groups after an exclusive edit to an existing end-to-end test', async () => {
    const body = "import { test } from 'vitest'\ntest('synthetic baseline', () => {})\n"
    const before = await keys(reusable([sourceChange]))
    const after = await keys(reusable([sourceChange, { [e2eTest]: `${body}\n` }]))
    expect(after.e2e).not.toBe(before.e2e)
    expect(after.checks).not.toBe(before.checks)
    expect({ unit: after.unit, browser: after.browser }).toEqual({ unit: before.unit, browser: before.browser })
  })

  it.each([
    { name: 'an added end-to-end test', baseline: {}, change: { 'apps/web/e2e/added.spec.ts': "import { test } from 'vitest'\ntest('synthetic baseline', () => {})\n" } },
    { name: 'an exported end-to-end test', baseline: { [e2eTest]: 'export const shared = 1\n' }, change: { [e2eTest]: 'export const shared = 1\n\n' } },
    { name: 'a mainline source change', baseline: { 'packages/core/src/mainline.ts': 'export const mainline = 1\n' }, change: {} },
    { name: 'a referenced end-to-end test', baseline: { 'apps/web/e2e/runner.ts': "import './example.spec.ts'\n" }, change: { [e2eTest]: "import { test } from 'vitest'\ntest('synthetic baseline', () => {})\n\n" } },
    { name: 'a shared end-to-end fixture', baseline: { 'apps/web/e2e/fixtures.ts': 'export const fixture = 1\n' }, change: { 'apps/web/e2e/fixtures.ts': 'export const fixture = 1\n\n' } },
    { name: 'a test configuration change', baseline: { 'playwright.config.ts': 'export default {}\n' }, change: { 'playwright.config.ts': 'export default {}\n\n' } },
  ])('reruns every test group after $name', async ({ baseline, change }) => {
    const before = await keys(reusable([sourceChange], baseline))
    const after = await keys(reusable([{ ...sourceChange, ...change }], baseline))
    if (Object.keys(change).length) for (const stage of ['unit', 'browser', 'e2e']) expect(after[stage]).not.toBe(before[stage])
    else for (const stage of ['unit', 'browser', 'e2e']) expect(after[stage]).not.toBe((await keys(reusable([sourceChange])))[stage])
  })

  it.each(['deleted', 'renamed'])('reruns every test group after an end-to-end test is %s', async change => {
    const before = await keys(reusable([sourceChange]))
    const fixture = reusable([sourceChange])
    fixture.git(['switch', 'synthetic-pr'])
    if (change === 'deleted') fixture.git(['rm', '-q', e2eTest])
    else fixture.git(['mv', e2eTest, 'apps/web/e2e/renamed.spec.ts'])
    fixture.git(['commit', '-q', '-m', `synthetic ${change} test`])
    const head = fixture.git(['rev-parse', 'HEAD'])
    fixture.git(['switch', 'main'])
    fixture.git(['reset', '--hard', fixture.base])
    fixture.git(['merge', '--no-ff', 'synthetic-pr', '-m', 'synthetic candidate merge'])
    const merge = fixture.git(['rev-parse', 'HEAD'])
    writeFileSync(fixture.eventPath, JSON.stringify({ ...fixture.event, pull_request: { ...fixture.event.pull_request, head: { sha: head } } }))
    const after = await keys({ ...fixture, env: { ...fixture.env, GITHUB_SHA: merge } })
    for (const stage of ['unit', 'browser', 'e2e']) expect(after[stage]).not.toBe(before[stage])
  })

  it('reruns every group when a submodule reference changes', async () => {
    const fixture = reusable([sourceChange])
    mkdirSync(join(fixture.directory, 'vendor/synthetic'), { recursive: true })
    const pinned = async (commit: string) => {
      fixture.git(['update-index', '--add', '--cacheinfo', `160000,${commit},vendor/synthetic`])
      const candidate = fixture.git(['commit-tree', fixture.git(['write-tree']), '-p', fixture.base, '-p', fixture.head, '-m', 'pinned submodule'])
      fixture.git(['reset', '-q', '--soft', candidate])
      return keys({ ...fixture, env: { ...fixture.env, GITHUB_SHA: candidate } })
    }
    const first = await pinned(fixture.base)
    const second = await pinned(fixture.head)
    for (const stage of ['checks', 'unit', 'browser', 'e2e']) expect(second[stage]).not.toBe(first[stage])
  })

  it('keeps a unit record when a selected-test PR adds an exclusive end-to-end edit', async () => {
    const unitOnly = reusable([{ [serverTest]: "import { test } from 'vitest'\ntest('synthetic baseline', () => {})\n\n" }])
    const withEndToEnd = reusable([{ [serverTest]: "import { test } from 'vitest'\ntest('synthetic baseline', () => {})\n\n" },
      { [e2eTest]: "import { test } from 'vitest'\ntest('synthetic baseline', () => {})\n\n" }])
    expect(await key(withEndToEnd, 'unit')).toBe(await key(unitOnly, 'unit'))
  })

  it('disables reuse for a mainline push, an unknown runner image or a modified checkout', async () => {
    const fixture = reusable([sourceChange])
    expect(await key(fixture, 'checks', undefined, { ...fixture.env, GITHUB_EVENT_NAME: 'push' })).toBe('')
    expect(await key(fixture, 'checks', undefined, { ...fixture.env, ImageVersion: '' })).toBe('')
    fixture.write('apps/server/src/runtime.ts', 'export const runtime = 3\n')
    expect(await key(fixture, 'checks')).toBe('')
  })

  it('records a successful execution and reuses it without running tests again', async () => {
    const fixture = reusable([sourceChange])
    const expected = await key(fixture, 'unit', '1/2')
    const env = { ...await plannedEnv(fixture), GITHUB_OUTPUT: join(fixture.records, '..', 'run.txt') }
    expect((await run(fixture.directory, ['run', 'unit', '1/2'], env)).code).toBe(0)
    expect(fixture.calls().length).toBeGreaterThan(0)
    expect(output(env.GITHUB_OUTPUT, 'saved')).toBe('true')
    expect(output(env.GITHUB_OUTPUT, 'key')).toBe(expected)
    expect(JSON.parse(readFileSync(join(fixture.records, 'record.json'), 'utf8')))
      .toMatchObject({ stage: 'unit', shard: '1/2', run: 'https://github.example/synthetic/clinmesh/actions/runs/101/attempts/1' })

    rmSync(env.CI_TEST_COMMAND_LOG)
    const reused = await run(fixture.directory, ['run', 'unit', '1/2'], { ...env, GITHUB_RUN_ID: '102' })
    expect(reused.code).toBe(0)
    expect(fixture.calls()).toEqual([])
    expect(reused.stdout).toContain('https://github.example/synthetic/clinmesh/actions/runs/101/attempts/1')
    expect(readFileSync(fixture.summary, 'utf8')).toMatch(/unit 1\/2.*复用.*actions\/runs\/101/)
  })

  it.each([
    { name: 'a corrupt record', record: () => '{"version":' },
    { name: 'a record for another shard', record: (current: Record<string, unknown>) => JSON.stringify({ ...current, shard: '2/2' }) },
    { name: 'a record for other input', record: (current: Record<string, unknown>) => JSON.stringify({ ...current, fingerprint: '0'.repeat(64) }) },
  ])('runs the tests again for $name', async ({ record }) => {
    const fixture = reusable([sourceChange])
    const env = await plannedEnv(fixture)
    expect((await run(fixture.directory, ['run', 'unit', '1/2'], env)).code).toBe(0)
    const path = join(fixture.records, 'record.json')
    writeFileSync(path, record(JSON.parse(readFileSync(path, 'utf8'))))
    rmSync(env.CI_TEST_COMMAND_LOG)
    expect((await run(fixture.directory, ['run', 'unit', '1/2'], env)).code).toBe(0)
    expect(fixture.calls().length).toBeGreaterThan(0)
  })

  it('keeps a successful execution green when its record cannot be written', async () => {
    const fixture = reusable([sourceChange])
    const outputPath = join(sandbox().directory, 'run.txt')
    writeFileSync(join(fixture.records, '..', 'not-a-directory'), '')
    const result = await run(fixture.directory, ['run', 'checks'], {
      ...await plannedEnv(fixture), CI_SUCCESS_DIR: join(fixture.records, '..', 'not-a-directory'), GITHUB_OUTPUT: outputPath })
    expect(result.code, result.stderr).toBe(0)
    expect(fixture.calls().length).toBeGreaterThan(0)
    expect(output(outputPath, 'saved')).toBeUndefined()
  })

  it('does not record a failed execution or a mainline push', async () => {
    const fixture = reusable([sourceChange])
    const failed = await run(fixture.directory, ['run', 'checks'], { ...await plannedEnv(fixture), CI_TEST_FAIL_ON: 'typecheck' })
    expect(failed.code).not.toBe(0)
    expect(failed.stdout).toContain('checks 1/1：执行（未找到匹配的成功记录）')
    expect(existsSync(join(fixture.records, 'record.json'))).toBe(false)
    const push = { ...fixture.env, GITHUB_EVENT_NAME: 'push' }
    expect((await run(fixture.directory, ['run', 'checks'], await plannedEnv(fixture, push))).code).toBe(0)
    expect(existsSync(join(fixture.records, 'record.json'))).toBe(false)
  })
})
