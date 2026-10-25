import { describe, expect, it } from 'vitest'
import { createCiPlan, requiredStages } from './ci.ts'

describe('CI checks selected for a pull request', () => {
  it('checks ordinary documentation without starting business tests', () => {
    const plan = createCiPlan('pull_request', [
      { status: 'M', path: 'docs/testing.md' },
      { status: 'A', path: 'docs/spec/synthetic-ci-example.md' },
    ])

    expect(plan.mode).toBe('docs')
    expect(requiredStages(plan)).toEqual(['checks'])
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
    ['M', 'apps/dsh-web/src/client/catalog-dialogs.browser.fixture.tsx'],
    ['A', 'apps/web/src/app/doctor/new.test.tsx'],
    ['D', 'apps/web/src/app/doctor/patient-summary.test.tsx'],
    ['R100', 'apps/web/src/app/doctor/patient-summary.test.tsx'],
    ['M', 'apps/web/src/app/auth-workflow.tsx'],
    ['M', 'apps/web/src/app/web-app.tsx'],
    ['M', 'apps/dsh-web/src/client/index.tsx'],
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
