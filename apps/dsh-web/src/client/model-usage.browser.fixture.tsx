import { createRoot } from 'react-dom/client'
import { createMemoryHistory } from '@tanstack/react-router'
import { WebApp } from '../../../web/src/app/web-app.tsx'
import { usageAttempt, usageControl, usageOverview, usageSession } from '../../../web/src/app/model-usage.test-fixture.ts'
import { modelUsageControlUpdateSchema } from '@clinmesh/contracts/model-usage'
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
async function fixtureFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input), 'http://synthetic.test')
  if (url.pathname === '/clinmesh/api/auth/context') return Response.json(document.documentElement.dataset.usageAdministrator === 'true'
    ? { ...usageSession, actor: { ...usageSession.actor, roleCode: 'administrator' } } : usageSession)
  document.documentElement.dataset.usageCredentials = init?.credentials ?? ''
  if (url.pathname === '/clinmesh/api/model-usage/overview') return Response.json(usageOverview)
  if (url.pathname === '/clinmesh/api/model-usage/control') {
    if (init?.method === 'PUT') {
      const update = modelUsageControlUpdateSchema.parse(JSON.parse(String(init.body)))
      document.documentElement.dataset.usageControlWrite = JSON.stringify(update)
      document.documentElement.dataset.usageIdempotency = new Headers(init.headers).get('idempotency-key') ?? ''
      const { expectedVersion, ...policy } = update
      control = { ...control, workspace: { ...control.workspace, ...policy, version: expectedVersion + 1,
        requestsStartedAt: update.requests === null ? control.workspace.requestsStartedAt : '2026-10-20T00:00:00.000Z',
        remaining: update.requests }, effective: { enabled: update.enabled && (control.deployment?.enabled ?? true),
        automaticRetries: update.automaticRetries && (control.deployment?.automaticRetries ?? true) } }
    }
    return Response.json({ ...control, deployment: document.documentElement.dataset.usageAdministrator === 'true' ? control.deployment : null })
  }
  if (url.pathname === '/clinmesh/api/model-usage/requests') {
    document.documentElement.dataset.usageFilter = url.search
    return Response.json({ items: [usageAttempt], total: 1 })
  }
  if (url.pathname === `/clinmesh/api/model-usage/requests/${usageAttempt.id}`) return Response.json(usageAttempt)
  throw new Error(`Unexpected synthetic request ${url.pathname}`)
}
Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fixtureFetch })
createRoot(root).render(<WebApp history={history} runtime={{ mode: 'surface', surfaceLocale: locale,
  surfaceColorScheme: theme, apiBasePath: '/clinmesh/api', surfaceNavigation: navigation }} />)
createRoot(launcher).render(<WorkspaceNavigation navigation={navigation} wide open={() => { surface.hidden = false }}
  locale={locale} colorScheme={theme} active />)
