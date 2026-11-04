import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ChangedFile {
  status: string
  path: string
}

export interface CiPlan {
  mode: 'full' | 'docs' | 'tests' | 'frontend'
  tests: string[]
  docs: boolean
  reason: string
}

const stages = ['checks', 'unit', 'browser', 'e2e'] as const
export type CiStage = typeof stages[number]

const testPackages = [
  ['apps/server', '@clinmesh/server', /^(src|tests)\/.*\.(test|spec)\.ts$/],
  ['apps/web', '@clinmesh/web', /^src\/.*\.(test|spec)\.tsx?$/],
  ['apps/dsh-web', '@clinmesh/dsh-web', /^src\/.*\.(test|spec)\.tsx?$/],
  ['apps/cli', '@clinmesh/cli', /^(src|tests)\/.*\.(test|spec)\.ts$/],
  ['packages/contracts', '@clinmesh/contracts', /^(src|tests)\/.*\.(test|spec)\.ts$/],
  ['packages/core', '@clinmesh/core', /^(src|tests)\/.*\.(test|spec)\.ts$/],
  ['packages/ui', '@clinmesh/ui', /^(src|tests)\/.*\.(test|spec)\.tsx?$/],
] as const

function testOwner(path: string) {
  return testPackages.find(([directory]) => path.startsWith(`${directory}/`))
}

function testStage(path: string): Exclude<CiStage, 'checks'> | undefined {
  if (!isSafePath(path)) return
  if (/^apps\/(web|dsh-web)\/src\/.*\.browser\.test\.ts$/.test(path)) return 'browser'
  if (/^apps\/web\/e2e\/[^/]+\.spec\.ts$/.test(path)) return 'e2e'
  if (path.includes('/e2e/') || path.includes('.browser.test.')) return
  const owner = testOwner(path)
  if (owner?.[2].test(path.slice(owner[0].length + 1))) return 'unit'
}

function isSafePath(path: string): boolean {
  return /^[\w./-]+$/.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function isDocumentation(path: string): boolean {
  return (path === 'README.md' || path.startsWith('docs/') && path.endsWith('.md'))
    && !path.startsWith('docs/agents/')
    && !/(^|\/)(AGENTS|CLAUDE)\.md$/.test(path)
}

function isFrontendSource(path: string): boolean {
  if (!isSafePath(path) || path.endsWith('.d.ts')
    || /(^|[./_-])(test|spec|fixture|fixtures|stub|setup|journey)([./_-]|$)/.test(path)
    || /(^|[./_-])(auth|agent|api|bridge|proof|session|binding|permission|runtime|recovery|receipt|adapter|controller)([./_-]|$)/.test(path)
    || ['apps/web/src/app/web-app.tsx', 'apps/web/src/app/inpatient-write-intent.ts',
      'apps/dsh-web/src/client/index.tsx', 'apps/dsh-web/src/client/model-settings.tsx'].includes(path)) return false
  return /^apps\/web\/src\/app\/.*\.(tsx?|css)$/.test(path)
    || /^apps\/dsh-web\/src\/client\/.*\.(tsx|css)$/.test(path)
    || /^packages\/(ui|views)\/src\/.*\.(tsx?|css)$/.test(path)
}

export function createCiPlan(event: string, changes?: ChangedFile[]): CiPlan {
  if (event === 'pull_request' && changes?.length) {
    const tests: string[] = []
    let docs = false
    let frontend = false
    for (const file of changes) {
      if (isSafePath(file.path) && ['A', 'M', 'D'].includes(file.status) && isDocumentation(file.path)) docs = true
      else if (testStage(file.path)) {
        if (file.status !== 'M') return { mode: 'full', tests: [], docs: true, reason: '测试入口新增、删除或重命名' }
        tests.push(file.path)
      }
      else if (['A', 'M'].includes(file.status) && isFrontendSource(file.path)) frontend = true
      else return { mode: 'full', tests: [], docs: true, reason: '包含关键、共享或未知改动' }
    }
    if (frontend) {
      if (tests.some(path => /^(apps\/(server|cli)|packages\/(contracts|core))\//.test(path))) {
        return { mode: 'full', tests: [], docs: true, reason: '前端与非前端测试的混合改动' }
      }
      return { mode: 'frontend', tests: [], docs: true, reason: '普通前端代码变化，保留全部浏览器合同及 Web E2E' }
    }
    if (tests.length) return { mode: 'tests', tests: [...new Set(tests)], docs, reason: '只有已有独立测试及普通文档变化' }
    return { mode: 'docs', tests: [], docs: true, reason: '只有普通说明文档变化' }
  }
  return { mode: 'full', tests: [], docs: true, reason: '无法可靠缩小检查范围' }
}

export function requiredStages(plan: CiPlan): CiStage[] {
  if (plan.mode === 'docs') return ['checks']
  if (plan.mode === 'tests') return stages
    .filter(stage => stage === 'checks' || plan.tests.some(path => testStage(path) === stage))
  return [...stages]
}

export function stageShards(plan: CiPlan, stage: CiStage): string[] {
  return (stage === 'unit' || stage === 'browser') && (plan.mode === 'full' || plan.mode === 'frontend')
    ? ['1/2', '2/2'] : ['1/1']
}

export function ciCommands(plan: CiPlan, stage: CiStage, shard = '1/1'): string[][] {
  if (!requiredStages(plan).includes(stage)) throw new Error(`不应执行未选中的 ${stage}`)
  if (!stageShards(plan, stage).includes(shard)) throw new Error(`${stage} 不应执行分片 ${shard}`)
  const shardArgs = shard === '1/1' ? [] : [`--shard=${shard}`]
  if (stage === 'checks') {
    if (plan.mode === 'docs') return [['doc-sync']]
    if (plan.mode === 'tests') {
      const packages = [...new Set(plan.tests.map(path => testOwner(path)?.[1]))]
      if (packages.includes(undefined)) throw new Error('测试所属包不明')
      const commands = packages.map(name => ['--filter', name!, 'typecheck'])
      if (plan.tests.some(path => testStage(path) === 'e2e')) commands.push(['exec', 'tsc', '--noEmit', '-p', 'tsconfig.browser.json'])
      commands.push(['exec', 'oxlint', '--deny-warnings', ...plan.tests])
      if (plan.docs) commands.push(['doc-sync'])
      return commands
    }
    return [['verify:boundaries'], ['typecheck'], ['lint'], ['perf:ci'],
      ['doc-sync'], ['build'], ...(plan.mode === 'full' ? [['check:mobile']] : [])]
  }
  if (stage === 'unit') {
    if (plan.mode === 'tests') return plan.tests.filter(path => testStage(path) === 'unit').map(path => {
      const owner = testOwner(path)
      if (!owner) throw new Error('测试所属包不明')
      return ['--filter', owner[1], 'exec', 'vitest', 'run', path.slice(owner[0].length + 1)]
    })
    if (plan.mode === 'frontend') return [['-r', '--filter', '@clinmesh/ui', '--filter', '@clinmesh/views',
      '--filter', '@clinmesh/web', '--filter', '@clinmesh/dsh-web', '--filter', '@clinmesh/desktop', 'test', ...shardArgs]]
    return [['test:packages', '--', ...shardArgs], ['test:scripts', ...shardArgs]]
  }
  if (plan.mode === 'tests') return [
    ['exec', 'playwright', 'install', '--with-deps', 'chromium'],
    ...plan.tests.filter(path => testStage(path) === stage).map(path =>
      ['exec', 'playwright', 'test', stage === 'browser' ? '--project=contracts' : '--project=web', path.replaceAll('.', '\\.') + '$']),
  ]
  return [['exec', 'playwright', 'install', '--with-deps', 'chromium'],
    [stage === 'browser' ? 'test:browser' : 'test:e2e', ...shardArgs]]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function verifyResults(plan: CiPlan, results: unknown): void {
  if (!isObject(results) || !isObject(results.plan) || results.plan.result !== 'success') {
    throw new Error('检查计划没有成功完成')
  }
  for (const stage of stages) {
    const job = results[stage]
    const allowed = requiredStages(plan).includes(stage) ? ['success'] : ['success', 'skipped']
    if (!isObject(job) || typeof job.result !== 'string' || !allowed.includes(job.result)) {
      throw new Error(`${stage} 缺失、未通过或被意外跳过`)
    }
  }
}

function parsePlan(encoded: string | undefined): CiPlan {
  if (!encoded || Buffer.byteLength(encoded) > 60_000) throw new Error('缺少或过大的 CI 计划')
  const value: unknown = JSON.parse(encoded)
  if (!isObject(value) || typeof value.docs !== 'boolean' || typeof value.reason !== 'string'
    || value.reason.length > 512 || !Array.isArray(value.tests)) throw new Error('无效的 CI 计划')
  const mode = (['full', 'docs', 'tests', 'frontend'] as const).find(mode => mode === value.mode)
  const tests: unknown[] = value.tests
  if (!mode || !tests.every((path): path is string => typeof path === 'string' && testStage(path) !== undefined)
    || (mode === 'tests' ? tests.length === 0 : tests.length !== 0 || !value.docs)
    || new Set(tests).size !== tests.length) throw new Error('无效的 CI 计划范围')
  return { mode, tests, docs: value.docs, reason: value.reason }
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function sharedEntries(paths: string[]): Set<string> {
  const shared = new Set<string>()
  if (!paths.length) return shared
  const stems = new Map(paths.map(path => [path, basename(path).replace(/\.[cm]?[jt]sx?$/, '')]))
  const share = (referenced: (stem: string) => boolean) => {
    for (const [path, stem] of stems) if (referenced(stem)) shared.add(path)
  }
  for (const path of paths) {
    if (!lstatSync(path).isFile() || /\bexports?\b/.test(readFileSync(path, 'utf8'))) shared.add(path)
  }
  let references: string
  try {
    references = git(['grep', '-l', '-z', '-F', ...[...new Set(stems.values())].flatMap(stem => ['-e', stem]),
      '--', '*.ts', '*.tsx', '*.js', '*.mjs', '*.cjs', '*.json'])
  } catch (error) {
    if (isObject(error) && error.status === 1) return shared
    throw error
  }
  for (const path of references.split('\0').filter(Boolean)) {
    if (!lstatSync(path).isFile()) return new Set(paths)
    const source = readFileSync(path, 'utf8')
    if (path.endsWith('.json')) share(stem => source.includes(stem))
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const specifier = basename(match[1]?.split(/[?#]/)[0] ?? '').replace(/\.[cm]?[jt]sx?$/, '')
      share(stem => stem === specifier)
    }
  }
  return shared
}

function independentEntries(paths: string[]): boolean {
  return sharedEntries(paths).size === 0
}

export function planFromCheckout(environment: NodeJS.ProcessEnv = process.env): CiPlan {
  if (environment.GITHUB_EVENT_NAME !== 'pull_request') return createCiPlan(environment.GITHUB_EVENT_NAME ?? '')
  try {
    const event: unknown = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH ?? '', 'utf8'))
    if (!isObject(event) || !isObject(event.pull_request) || !isObject(event.pull_request.base)
      || !isObject(event.pull_request.head)) throw new Error('缺少 PR 提交身份')
    const base = event.pull_request.base.sha
    const head = event.pull_request.head.sha
    if (typeof base !== 'string' || typeof head !== 'string' || !/^[a-f0-9]{40}$/.test(base)
      || !/^[a-f0-9]{40}$/.test(head)) throw new Error('无效的 PR 提交身份')
    const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/)
    if (parents.length !== 3 || parents[0] !== environment.GITHUB_SHA || parents[1] !== base || parents[2] !== head) {
      throw new Error('检出结果与 PR 事件不一致')
    }
    const diff = git(['diff', '--name-status', '-z', '--no-renames', 'HEAD^1', 'HEAD', '--'])
    if (diff && !diff.endsWith('\0')) throw new Error('改动列表不完整')
    const fields = diff ? diff.slice(0, -1).split('\0') : []
    if (fields.length % 2 !== 0) throw new Error('改动列表不完整')
    const changes: ChangedFile[] = []
    for (let i = 0; i < fields.length; i += 2) {
      changes.push({ status: fields[i]!, path: fields[i + 1]! })
    }
    const plan = createCiPlan('pull_request', changes)
    const entries = changes.map(file => file.path).filter(path => testStage(path) !== undefined)
    if (plan.mode !== 'full' && entries.length && !independentEntries(entries)) {
      return { mode: 'full', tests: [], docs: true, reason: '测试入口被共享或无法证明独立' }
    }
    if (Buffer.byteLength(JSON.stringify(plan)) > 60_000) throw new Error('计划过大')
    return plan
  } catch {
    return { mode: 'full', tests: [], docs: true, reason: 'PR 事件、完整差异或检出快照无法核验' }
  }
}

const runnerIdentity = ['GITHUB_REPOSITORY', 'RUNNER_OS', 'RUNNER_ARCH', 'ImageOS', 'ImageVersion'] as const
const successRecordFile = 'record.json'

interface SuccessIdentity {
  key: string
  fingerprint: string
}

interface Scanner {
  scanFiles(input: Array<{ content: string; extension: string }>): unknown
}

function tailwindCandidates(paths: string[]): string[] {
  const vite = createRequire(new URL('../apps/dsh-web/package.json', import.meta.url)).resolve('@tailwindcss/vite')
  const load = createRequire(vite)
  const oxide: unknown = load(load.resolve('@tailwindcss/oxide'))
  if (!isObject(oxide) || typeof oxide.Scanner !== 'function') throw new Error('Tailwind 扫描器不可用')
  const scanner = new (oxide.Scanner as new (options: object) => Scanner)({})
  const candidates = scanner.scanFiles(paths.map(path => ({ content: readFileSync(path, 'utf8'), extension: extname(path).slice(1) })))
  if (!Array.isArray(candidates) || !candidates.every(candidate => typeof candidate === 'string')) {
    throw new Error('Tailwind 扫描结果无效')
  }
  return [...new Set(candidates)].sort()
}

function stageInputs(stage: CiStage): { tree: string[]; candidates: string[] } {
  const entries = git(['ls-tree', '-r', '-z', '--full-tree', 'HEAD']).split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t')
    return { meta: line.slice(0, tab), path: line.slice(tab + 1) }
  })
  if (stage === 'checks') return { tree: entries.map(({ meta, path }) => `${meta}\t${path}`), candidates: [] }
  const others = entries.map(({ path }) => path).filter(path => {
    const owner = testStage(path)
    return owner !== undefined && owner !== stage
  })
  const shared = sharedEntries(others)
  const excluded = new Set(others.filter(path => !shared.has(path)))
  // 测试组只依赖其他组专属测试的路径与模式；这些文件和普通文档仍经仓库根 Tailwind 扫描影响生成样式。
  const tree = entries.filter(({ path }) => !isDocumentation(path)).map(({ meta, path }) =>
    excluded.has(path) ? `${meta.split(' ')[0]}\t${path}` : `${meta}\t${path}`)
  const documents = entries.map(({ path }) => path).filter(isDocumentation)
  return { tree, candidates: tailwindCandidates([...documents, ...excluded]) }
}

function successIdentity(plan: CiPlan, stage: CiStage, shard: string,
  environment: NodeJS.ProcessEnv = process.env): SuccessIdentity | { reason: string } {
  if (environment.GITHUB_EVENT_NAME !== 'pull_request') return { reason: '主线 push 不复用成功记录' }
  const runner = runnerIdentity.map(name => environment[name])
  if (runner.some(value => !value)) return { reason: '运行环境无法识别' }
  try {
    const event: unknown = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH ?? '', 'utf8'))
    const number = isObject(event) && isObject(event.pull_request) ? event.pull_request.number : undefined
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return { reason: '无法识别 PR' }
    if (git(['rev-parse', 'HEAD']).trim() !== environment.GITHUB_SHA) return { reason: '检出结果与本次事件不一致' }
    if (git(['status', '--porcelain', '--untracked-files=no'])) return { reason: '工作区与候选提交不一致' }
    const { tree, candidates } = stageInputs(stage)
    const fingerprint = createHash('sha256').update(JSON.stringify({
      version: 1, pr: number, stage, shard, commands: ciCommands(plan, stage, shard),
      runner: [...runner, process.version, process.platform, process.arch],
      tree, candidates,
    })).digest('hex')
    return { fingerprint, key: `ci-success-v1-pr${number}-${stage}-${shard.replace('/', 'of')}-${fingerprint}` }
  } catch (error) {
    return { reason: `无法计算检查输入：${(error instanceof Error ? error.message : String(error)).split('\n')[0]}` }
  }
}

function sourceRun(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: id, GITHUB_RUN_ATTEMPT: attempt } = environment
  if (!server?.startsWith('https://') || !repository || !id || !attempt) return undefined
  return `${server}/${repository}/actions/runs/${id}/attempts/${attempt}`
}

function recordedSuccess(directory: string, identity: SuccessIdentity, stage: CiStage, shard: string): { run: string } | { reason: string } {
  const path = join(directory, successRecordFile)
  if (!existsSync(path)) return { reason: '未找到匹配的成功记录' }
  try {
    const record: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (isObject(record) && record.version === 1 && record.fingerprint === identity.fingerprint && record.stage === stage
      && record.shard === shard && typeof record.run === 'string' && record.run.length <= 512 && /^https:\/\/\S+$/.test(record.run)) {
      return { run: record.run }
    }
  } catch {
    // 损坏的记录按不匹配处理，继续正常执行。
  }
  return { reason: '成功记录无效或与本次输入不一致' }
}

function report(label: string, result: string): void {
  console.log(`${label}：${result}`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${label}：${result}\n`)
}

async function execute(args: string[]): Promise<void> {
  const { default: spawn } = await import('cross-spawn')
  const result = spawn.sync('pnpm', args, { stdio: 'inherit' })
  if (result.error || result.status !== 0) throw new Error(`pnpm ${args.join(' ')} 未通过`)
}

const usage = '用法：ci.ts plan | prepare | fingerprint <阶段> [<序号>/<总数>] | run <阶段> [<序号>/<总数>] | verify'

async function main(): Promise<void> {
  const [command, stage, shardArg, ...extra] = process.argv.slice(2)
  const staged = command === 'run' || command === 'fingerprint'
  if (extra.length || !staged && shardArg !== undefined) throw new Error(usage)
  if (command === 'plan' && stage === undefined) {
    const plan = planFromCheckout()
    console.log(JSON.stringify(plan, null, 2))
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      `selection=${JSON.stringify(plan)}\n` + stages
        .map(name => `${name}=${requiredStages(plan).includes(name)}\n`).join('')
        + `unit_shards=${JSON.stringify(stageShards(plan, 'unit'))}\nbrowser_shards=${JSON.stringify(stageShards(plan, 'browser'))}\n`)
    return
  }
  const plan = parsePlan(process.env.CI_PLAN)
  if (command === 'prepare' && stage === undefined) {
    if (plan.mode !== 'docs') await execute(['--filter', '@clinmesh/dsh-web', 'build:styles'])
    return
  }
  if (command === 'verify' && stage === undefined) {
    verifyResults(plan, JSON.parse(process.env.CI_RESULTS ?? 'null'))
    console.log('verify: 所有必需检查组已通过')
    return
  }
  const selected = stages.find(name => name === stage)
  if (!selected || !staged) throw new Error(usage)
  const shard = shardArg ?? '1/1'
  const commands = ciCommands(plan, selected, shard)
  const label = `${selected} ${shard}`
  if (command === 'fingerprint') {
    const identity = successIdentity(plan, selected, shard)
    console.log(`${label}：${'key' in identity ? identity.key : identity.reason}`)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `key=${'key' in identity ? identity.key : ''}\n`)
    return
  }
  const directory = process.env.CI_SUCCESS_DIR
  const source = sourceRun()
  const identity = !directory ? { reason: '未启用成功记录' } : !source ? { reason: '缺少来源运行身份' }
    : successIdentity(plan, selected, shard)
  const recorded = !('key' in identity) ? identity : directory ? recordedSuccess(directory, identity, selected, shard)
    : { reason: '未启用成功记录' }
  if ('run' in recorded) return report(label, `复用，来源 ${recorded.run}`)
  report(label, `执行（${recorded.reason}）`)
  for (const args of commands) {
    console.log(`::group::pnpm ${args.join(' ')}`)
    try { await execute(args) }
    finally { console.log('::endgroup::') }
  }
  if (!directory || !source || !('key' in identity)) return
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, successRecordFile), `${JSON.stringify({
      version: 1, fingerprint: identity.fingerprint, stage: selected, shard, run: source })}\n`)
  } catch (error) {
    // 记录写入失败只放弃本次复用，不改变已经通过的检查结果。
    return report(label, `成功记录未保存：${error instanceof Error ? error.message : String(error)}`)
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `saved=true\nkey=${identity.key}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'CI 执行失败')
    process.exitCode = 1
  })
}
