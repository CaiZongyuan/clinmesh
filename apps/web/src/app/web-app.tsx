import {
  WorkspaceShell,
  type WorkspaceNavigationLinkProps,
  type WorkspaceSection,
} from '@clinmesh/views/workspace-shell'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { forwardRef, useEffect, useState } from 'react'
import { readWebPreferences, writeWebPreferences } from './preferences.ts'

const DARK_MODE_QUERY = '(prefers-color-scheme: dark)'

const workspaceRouteDefinitions = [
  { section: 'overview', path: '/' },
  { section: 'registration', path: '/registration' },
  { section: 'triage', path: '/triage' },
  { section: 'consultation', path: '/consultation' },
  { section: 'billing', path: '/billing' },
  { section: 'pharmacy', path: '/pharmacy' },
] as const satisfies ReadonlyArray<{ section: WorkspaceSection; path: string }>

const workspacePaths = new Map<WorkspaceSection, string>(
  workspaceRouteDefinitions.map(({ path, section }) => [section, path]),
)

function getWorkspacePath(section: WorkspaceSection): string {
  const path = workspacePaths.get(section)
  if (path === undefined) throw new Error(`No Web route is registered for workspace section: ${section}`)
  return path
}

const WorkspaceRouterLink = forwardRef<HTMLAnchorElement, WorkspaceNavigationLinkProps>(
  function WorkspaceRouterLink({ section, ...props }, ref) {
    return <Link {...props} ref={ref} to={getWorkspacePath(section)} />
  },
)

function WorkspacePage({ activeSection }: { activeSection: WorkspaceSection }): React.JSX.Element {
  const [preferences, setPreferences] = useState(readWebPreferences)

  useEffect(() => {
    document.documentElement.lang = preferences.locale
    writeWebPreferences(preferences)
  }, [preferences])

  useEffect(() => {
    const root = document.documentElement

    const applyTheme = (theme: 'light' | 'dark'): void => {
      root.classList.toggle('dark', theme === 'dark')
      root.dataset.theme = theme
      root.style.colorScheme = theme
    }

    if (preferences.theme !== 'system') {
      applyTheme(preferences.theme)
      return
    }

    const mediaQuery = window.matchMedia(DARK_MODE_QUERY)
    const applySystemTheme = (): void => applyTheme(mediaQuery.matches ? 'dark' : 'light')

    applySystemTheme()
    mediaQuery.addEventListener('change', applySystemTheme)

    return () => mediaQuery.removeEventListener('change', applySystemTheme)
  }, [preferences.theme])

  return (
    <WorkspaceShell
      NavigationLink={WorkspaceRouterLink}
      activeSection={activeSection}
      locale={preferences.locale}
      onLocaleChange={locale => setPreferences(current => ({ ...current, locale }))}
      onThemeChange={theme => setPreferences(current => ({ ...current, theme }))}
      theme={preferences.theme}
    />
  )
}

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: () => <WorkspacePage activeSection="overview" />,
})

const workspaceRoutes = workspaceRouteDefinitions.map(({ path, section }) => createRoute({
  component: () => <WorkspacePage activeSection={section} />,
  getParentRoute: () => rootRoute,
  path,
}))

const routeTree = rootRoute.addChildren(workspaceRoutes)

export function createWebRouter(): ReturnType<typeof createRouter<typeof routeTree>> {
  return createRouter({ routeTree })
}

type WebRouter = ReturnType<typeof createWebRouter>

declare module '@tanstack/react-router' {
  interface Register {
    router: WebRouter
  }
}

export function WebApp(): React.JSX.Element {
  const [router] = useState(createWebRouter)
  return <RouterProvider router={router} />
}
