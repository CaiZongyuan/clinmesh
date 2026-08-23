import {
  WorkspaceShell,
  type WorkspaceSection,
  workspaceRoutes,
} from './workspace-shell.tsx'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { readWebPreferences, writeWebPreferences } from './preferences.ts'

const DARK_MODE_QUERY = '(prefers-color-scheme: dark)'

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

const routes = workspaceRoutes.map(({ key, path }) => createRoute({
  component: () => <WorkspacePage activeSection={key} />,
  getParentRoute: () => rootRoute,
  path,
}))

const routeTree = rootRoute.addChildren(routes)

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
