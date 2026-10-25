import { describe, expect, it } from 'vitest'
import { ciCommands, createCiPlan, requiredStages, verifyResults } from './ci.ts'

describe('CI checks selected for a pull request', () => {
  it('checks ordinary documentation without starting business tests', () => {
    const plan = createCiPlan('pull_request', [
      { status: 'M', path: 'docs/testing.md' },
      { status: 'A', path: 'docs/spec/synthetic-ci-example.md' },
    ])

    expect(plan.mode).toBe('docs')
    expect(requiredStages(plan)).toEqual(['checks'])
  })

  it.each(['A', 'M', 'D'])('checks engineering skill configuration in full for status %s', status => {
    const plan = createCiPlan('pull_request', [
      { status, path: 'docs/agents/issue-tracker.md' },
      { status: 'M', path: 'README.md' },
    ])

    expect(plan.mode).toBe('full')
    expect(requiredStages(plan)).toEqual(['checks', 'unit', 'browser', 'e2e'])
  })

  it('runs complete changed test files through their owning runners', () => {
    const files = [
      'apps/web/src/app/doctor/prescription-page.test.tsx',
      'apps/dsh-web/src/client/diagnosis-prescription.browser.test.ts',
      'apps/web/e2e/diagnosis-prescription.spec.ts',
    ]
    const plan = createCiPlan('pull_request', files.map(path => ({ status: 'M', path })))

    expect(plan.mode).toBe('tests')
    expect(plan.tests).toEqual(files)
    expect(plan.docs).toBe(false)
    expect(requiredStages(plan)).toEqual(['checks', 'unit', 'browser', 'e2e'])
  })

  it('checks frontend production changes with both complete browser projects', () => {
    const plan = createCiPlan('pull_request', [
      { status: 'M', path: 'apps/web/src/app/doctor/patient-summary.tsx' },
      { status: 'M', path: 'apps/web/src/app/doctor/patient-summary.test.tsx' },
      { status: 'M', path: 'packages/ui/src/components/input.tsx' },
    ])

    expect(plan.mode).toBe('frontend')
    expect(requiredStages(plan)).toEqual(['checks', 'unit', 'browser', 'e2e'])
  })

  it.each([
    ['M', 'apps/web/e2e/fixtures.ts'],
    ['M', 'apps/web/tests/outside-typecheck.test.tsx'],
    ['M', 'apps/web/--help.test.tsx'],
    ['M', 'apps/web/e2e/untyped.browser.test.ts'],
    ['M', 'apps/web/untyped.browser.test.ts'],
    ['M', 'apps/dsh-web/tests/untyped.browser.test.ts'],
    ['M', 'apps/dsh-web/src/client/catalog-dialogs.browser.fixture.tsx'],
    ['A', 'apps/web/src/app/doctor/new.test.tsx'],
    ['D', 'apps/web/src/app/doctor/patient-summary.test.tsx'],
    ['R100', 'apps/web/src/app/doctor/patient-summary.test.tsx'],
    ['M', 'apps/web/src/app/auth-workflow.tsx'],
    ['M', 'apps/web/src/app/web-app.tsx'],
    ['M', 'apps/web/src/app/inpatient-write-intent.ts'],
    ['M', 'apps/dsh-web/src/client/index.tsx'],
    ['M', 'apps/dsh-web/src/client/model-settings.tsx'],
    ['M', 'apps/dsh-web/src/model-bridge.ts'],
    ['M', 'packages/contracts/src/his.ts'],
    ['M', 'packages/core/src/platform.ts'],
    ['M', 'apps/server/src/runtime.ts'],
    ['M', 'apps/server/drizzle/0001_initial.sql'],
    ['M', 'pnpm-lock.yaml'],
    ['M', 'playwright.config.ts'],
    ['M', '.github/workflows/ci.yml'],
    ['M', 'skills/clinmesh-doctor/SKILL.md'],
    ['M', 'docs/AGENTS.md'],
    ['M', 'docs/../skills/clinmesh-doctor/SKILL.md'],
  ])('keeps full verification for %s %s', (status, path) => {
    expect(createCiPlan('pull_request', [{ status, path }]).mode).toBe('full')
  })

  it('always checks a mainline push in full, even for a documentation change', () => {
    expect(createCiPlan('push', [{ status: 'M', path: 'README.md' }]).mode).toBe('full')
  })

  it.each([undefined, []])('falls back to full checks when the complete diff is unavailable', changes => {
    expect(createCiPlan('pull_request', changes).mode).toBe('full')
  })
})

describe('CI stage execution contracts', () => {
  it('preserves every full check while separating the three test stages', () => {
    const plan = createCiPlan('push')
    expect(ciCommands(plan, 'checks')).toEqual([
      ['verify:boundaries'], ['typecheck'], ['lint'], ['perf:ci'],
      ['doc-sync'], ['build'], ['check:mobile'],
    ])
    expect(ciCommands(plan, 'unit')).toEqual([['test:unit']])
    expect(ciCommands(plan, 'browser')).toEqual([
      ['exec', 'playwright', 'install', '--with-deps', 'chromium'], ['test:browser'],
    ])
    expect(ciCommands(plan, 'e2e')).toEqual([
      ['exec', 'playwright', 'install', '--with-deps', 'chromium'], ['test:e2e'],
    ])
  })

  it('keeps all frontend consumers and real browser journeys without the full Server unit suite', () => {
    const plan = createCiPlan('pull_request', [{ status: 'M', path: 'packages/ui/src/components/input.tsx' }])
    const commands = ciCommands(plan, 'unit')
    expect(commands).toEqual([['-r', '--filter', '@clinmesh/ui', '--filter', '@clinmesh/views',
      '--filter', '@clinmesh/web', '--filter', '@clinmesh/dsh-web', '--filter', '@clinmesh/desktop', 'test']])
    expect(ciCommands(plan, 'browser').at(-1)).toEqual(['test:browser'])
    expect(ciCommands(plan, 'e2e').at(-1)).toEqual(['test:e2e'])
    expect(ciCommands(plan, 'checks')).not.toContainEqual(['check:mobile'])
  })

  it('checks a selected Server test from its package and types a selected Web E2E entry', () => {
    const plan = createCiPlan('pull_request', [
      { status: 'M', path: 'apps/server/tests/payment-ledger-migration.test.ts' },
      { status: 'M', path: 'apps/web/e2e/diagnosis-prescription.spec.ts' },
      { status: 'M', path: 'docs/testing.md' },
    ])
    expect(ciCommands(plan, 'unit')).toEqual([
      ['--filter', '@clinmesh/server', 'exec', 'vitest', 'run', 'tests/payment-ledger-migration.test.ts'],
    ])
    expect(ciCommands(plan, 'checks')).toEqual([
      ['--filter', '@clinmesh/server', 'typecheck'],
      ['--filter', '@clinmesh/web', 'typecheck'],
      ['exec', 'tsc', '--noEmit', '-p', 'tsconfig.browser.json'],
      ['exec', 'oxlint', '--deny-warnings', 'apps/server/tests/payment-ledger-migration.test.ts', 'apps/web/e2e/diagnosis-prescription.spec.ts'],
      ['doc-sync'],
    ])
    expect(ciCommands(plan, 'e2e').at(-1)).toEqual([
      'exec', 'playwright', 'test', '--project=web', 'apps/web/e2e/diagnosis-prescription\\.spec\\.ts$',
    ])
  })
})

describe('the final verify result', () => {
  it('fails if an expected test stage was skipped', () => {
    expect(() => verifyResults(createCiPlan('push'), {
      plan: { result: 'success' }, checks: { result: 'success' },
      unit: { result: 'skipped' }, browser: { result: 'success' }, e2e: { result: 'success' },
    })).toThrow()
  })

  it.each(['failure', 'cancelled', 'neutral', 'unknown'])('rejects an expected stage with result %s', result => {
    expect(() => verifyResults(createCiPlan('push'), {
      plan: { result: 'success' }, checks: { result: 'success' },
      unit: { result }, browser: { result: 'success' }, e2e: { result: 'success' },
    })).toThrow()
  })

  it('allows only the explicitly unneeded groups to be skipped', () => {
    const plan = createCiPlan('pull_request', [{ status: 'M', path: 'README.md' }])
    expect(() => verifyResults(plan, {
      plan: { result: 'success' }, checks: { result: 'success' },
      unit: { result: 'skipped' }, browser: { result: 'skipped' }, e2e: { result: 'skipped' },
    })).not.toThrow()
    expect(() => verifyResults(plan, { plan: { result: 'success' }, checks: { result: 'success' } })).toThrow()
  })
})
