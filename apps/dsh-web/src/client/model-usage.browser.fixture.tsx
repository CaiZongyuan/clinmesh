import { createRoot } from 'react-dom/client'
import { createMemoryHistory } from '@tanstack/react-router'
import { WebApp } from '../../../web/src/app/web-app.tsx'
import { usageAttempt, usageControl, usageOverview, usagePricing, usageSession } from '../../../web/src/app/model-usage.test-fixture.ts'
import { modelUsageControlUpdateSchema, modelUsageReconcileSchema, modelUsageRepriceSchema, modelUsageRetentionUpdateSchema } from '@clinmesh/contracts/model-usage'
import { WorkspaceNavigation, createWorkspaceNavigation } from './workspace-navigation.tsx'
import { createStyledRoot } from './styled-root.ts'

const locale = document.documentElement.lang === 'en-US' ? 'en-US' : 'zh-CN'
const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
const navigation = createWorkspaceNavigation()
const history = createMemoryHistory({ initialEntries: ['/settings/model-usage'] })
const launcher = document.createElement('aside')
const surface = document.createElement('main')
document.body.style.margin = '0'
launcher.style.height = '40px'
surface.style.height = 'calc(100vh - 40px)'
surface.hidden = true
document.body.append(launcher, surface)
const { root } = createStyledRoot(surface)
root.style.height = '100%'
let control = structuredClone(usageControl)
let attempt = structuredClone(usageAttempt)
const compacted = document.documentElement.dataset.usageCompacted === 'true'
let retention = { days: 90 as number | null, version: 1, compactedRequests: compacted ? 3 : 0,
  lastCompactedAt: compacted ? '2026-10-21T01:00:00.000Z' : null }
if (compacted) control.workspace = { ...control.workspace, requests: 10, used: 3, remaining: 7,
  requestsStartedAt: '2026-06-01T00:00:00.000Z', tokensUsed: 120 }
if (document.documentElement.dataset.usageKnown === 'true') attempt.usage.totalTokens = 150
if (document.documentElement.dataset.usageKnownConsumption === 'true') {
  attempt.dispatch = 'unknown'
  attempt.usage.totalTokens = 150
  attempt.cost = { status: 'priced', currency: 'CNY', original: 0.2, cny: 0.2, originalMicro: 200000, cnyMicro: 200000 }
}
async function fixtureFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input), 'http://synthetic.test')
  if (url.pathname === '/clinmesh/api/auth/context') return Response.json(document.documentElement.dataset.usageAdministrator === 'true'
    ? { ...usageSession, actor: { ...usageSession.actor, roleCode: 'administrator' } } : usageSession)
  document.documentElement.dataset.usageCredentials = init?.credentials ?? ''
  if (url.pathname === '/clinmesh/api/model-usage/overview') return Response.json(usageOverview)
  if (url.pathname === '/clinmesh/api/model-usage/pricing') return Response.json(usagePricing)
  if (url.pathname === '/clinmesh/api/model-usage/retention') {
    if (init?.method === 'PUT') {
      const update = modelUsageRetentionUpdateSchema.parse(JSON.parse(String(init.body)))
      document.documentElement.dataset.usageRetentionWrite = JSON.stringify(update)
      document.documentElement.dataset.usageIdempotency = new Headers(init.headers).get('idempotency-key') ?? ''
      retention = { ...retention, days: update.days, version: update.expectedVersion + 1 }
    }
    return Response.json(retention)
  }
  if (url.pathname === '/clinmesh/api/model-usage/control') {
    if (init?.method === 'PUT') {
      const update = modelUsageControlUpdateSchema.parse(JSON.parse(String(init.body)))
      document.documentElement.dataset.usageControlWrite = JSON.stringify(update)
      document.documentElement.dataset.usageIdempotency = new Headers(init.headers).get('idempotency-key') ?? ''
      const { expectedVersion, ...policy } = update
      control = { ...control, workspace: { ...control.workspace, ...policy, tokens: policy.tokens ?? null, cny: policy.cny ?? null, version: expectedVersion + 1,
        requestsStartedAt: update.requests === null ? control.workspace.requestsStartedAt : '2026-10-20T00:00:00.000Z',
        remaining: update.requests, tokensRemaining: update.tokens ?? null, cnyRemaining: update.cny ?? null }, effective: { enabled: update.enabled && (control.deployment?.enabled ?? true),
        automaticRetries: update.automaticRetries && (control.deployment?.automaticRetries ?? true) } }
    }
    return Response.json({ ...control, deployment: document.documentElement.dataset.usageAdministrator === 'true' ? control.deployment : null })
  }
  if (url.pathname === '/clinmesh/api/model-usage/requests') {
    document.documentElement.dataset.usageFilter = url.search
    return Response.json({ items: compacted ? [] : [attempt], total: compacted ? 0 : 1 })
  }
  if (url.pathname.endsWith('/reconcile') || url.pathname.endsWith('/reprice')) {
    const reprice = url.pathname.endsWith('/reprice')
    const payload = JSON.parse(String(init?.body))
    let body: { expectedRevision: number; evidence: string }
    let totalTokens: number | undefined
    let cny: number | undefined
    if (reprice) body = modelUsageRepriceSchema.parse(payload)
    else {
      const reconciliation = modelUsageReconcileSchema.parse(payload)
      body = reconciliation
      totalTokens = reconciliation.totalTokens
      cny = reconciliation.cny
    }
    document.documentElement.dataset.usageCorrection = JSON.stringify(body)
    document.documentElement.dataset.usageCorrectionKind = reprice ? 'reprice' : 'reconcile'
    document.documentElement.dataset.usageIdempotency = new Headers(init?.headers).get('idempotency-key') ?? ''
    const cost = reprice ? { status: 'priced' as const, currency: 'USD', original: 0.00042, cny: 0.00294, originalMicro: 420, cnyMicro: 2940 } : null
    attempt = { ...attempt, accounting: { totalTokens: totalTokens ?? attempt.accounting?.totalTokens ?? attempt.usage.totalTokens,
      cny: cny ?? cost?.cny ?? attempt.accounting?.cny ?? attempt.cost.cny }, ...(cost === null ? {} : { effectiveCost: cost }),
      corrections: [...attempt.corrections, { revision: body.expectedRevision + 1, evidence: body.evidence,
        at: '2026-10-21T01:00:00.000Z', actorId: 'synthetic-admin', kind: reprice ? 'reprice' : 'reconcile',
        totalTokens: totalTokens ?? null, cny: cny ?? cost?.cny ?? null, cost, priceSnapshot: cost === null ? null : {
          provider: 'synthetic-provider', model: 'historical-actual-model', price: { version: 'prices-v2', currency: 'USD', rates: usagePricing.prices[0].rates },
          exchangeRate: { version: 'fx-v2', cnyPerUnit: 7 } } }] }
    return Response.json(attempt)
  }
  if (url.pathname === `/clinmesh/api/model-usage/requests/${usageAttempt.id}`) return Response.json(attempt)
  throw new Error(`Unexpected synthetic request ${url.pathname}`)
}
Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fixtureFetch })
createRoot(root).render(<WebApp history={history} runtime={{ mode: 'surface', surfaceLocale: locale,
  surfaceColorScheme: theme, apiBasePath: '/clinmesh/api', surfaceNavigation: navigation }} />)
createRoot(launcher).render(<WorkspaceNavigation navigation={navigation} wide open={() => { surface.hidden = false }}
  locale={locale} colorScheme={theme} active />)
