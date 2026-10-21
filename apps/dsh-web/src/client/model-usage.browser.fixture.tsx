import { createRoot } from 'react-dom/client'
import { createMemoryHistory } from '@tanstack/react-router'
import { WebApp } from '../../../web/src/app/web-app.tsx'
import { usageAttempt, usageOverview, usageSession } from '../../../web/src/app/model-usage.test-fixture.ts'
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
async function fixtureFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input), 'http://synthetic.test')
  if (url.pathname === '/clinmesh/api/auth/context') return Response.json(usageSession)
  document.documentElement.dataset.usageCredentials = init?.credentials ?? ''
  if (url.pathname === '/clinmesh/api/model-usage/overview') return Response.json(usageOverview)
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
