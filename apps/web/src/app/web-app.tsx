import { WorkspaceShell, type WorkspaceSection } from '@clinmesh/views/workspace-shell'
import { useEffect, useState } from 'react'
import { readWebPreferences, writeWebPreferences } from './preferences.ts'

const DARK_MODE_QUERY = '(prefers-color-scheme: dark)'

const workspaceSections: Record<string, WorkspaceSection> = {
  '/': 'overview',
  '/registration': 'registration',
  '/triage': 'triage',
  '/consultation': 'consultation',
  '/billing': 'billing',
  '/pharmacy': 'pharmacy',
}

function getActiveSection(pathname: string): WorkspaceSection {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return workspaceSections[normalizedPath] ?? 'overview'
}

export function WebApp(): React.JSX.Element {
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
      activeSection={getActiveSection(window.location.pathname)}
      locale={preferences.locale}
      onLocaleChange={locale => setPreferences(current => ({ ...current, locale }))}
      onThemeChange={theme => setPreferences(current => ({ ...current, theme }))}
      theme={preferences.theme}
    />
  )
}
