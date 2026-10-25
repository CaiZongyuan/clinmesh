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

export type CiStage = 'checks' | 'unit' | 'browser' | 'e2e'

const testPackages = ['apps/server', 'apps/web', 'apps/dsh-web', 'apps/cli',
  'packages/contracts', 'packages/core', 'packages/ui']

function testStage(path: string): Exclude<CiStage, 'checks'> | undefined {
  if (!isSafePath(path)) return
  if (/^apps\/(web|dsh-web)\/.*\.browser\.test\.ts$/.test(path)) return 'browser'
  if (/^apps\/web\/e2e\/[^/]+\.spec\.ts$/.test(path)) return 'e2e'
  if (path.includes('/e2e/') || path.includes('.browser.test.')) return
  if (/\.(test|spec)\.tsx?$/.test(path) && testPackages.some(directory => path.startsWith(`${directory}/`))) return 'unit'
}

function isSafePath(path: string): boolean {
  return /^[\w./-]+$/.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function isDocumentation(path: string): boolean {
  return (path === 'README.md' || path.startsWith('docs/') && path.endsWith('.md'))
    && !/(^|\/)(AGENTS|CLAUDE)\.md$/.test(path)
}

function isFrontendSource(path: string): boolean {
  if (!isSafePath(path) || path.endsWith('.d.ts')
    || /(^|[./_-])(test|spec|fixture|fixtures|stub|setup|journey)([./_-]|$)/.test(path)
    || /(^|[./_-])(auth|agent|api|bridge|proof|session|binding|permission|runtime|recovery|receipt|adapter|controller)([./_-]|$)/.test(path)
    || ['apps/web/src/app/web-app.tsx', 'apps/dsh-web/src/client/index.tsx'].includes(path)) return false
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
  if (plan.mode === 'tests') return (['checks', 'unit', 'browser', 'e2e'] as const)
    .filter(stage => stage === 'checks' || plan.tests.some(path => testStage(path) === stage))
  return ['checks', 'unit', 'browser', 'e2e']
}
