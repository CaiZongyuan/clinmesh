import type { WorkspaceLocale } from './workspace-i18n.ts'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedWebTheme = Exclude<ThemePreference, 'system'>

export interface WebPreferences {
  locale: WorkspaceLocale
  theme: ThemePreference
}

export const WEB_PREFERENCES_KEY = 'clinmesh.preferences:v1'

const defaultPreferences: WebPreferences = {
  locale: 'zh-CN',
  theme: 'system',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isLocale(value: unknown): value is WorkspaceLocale {
  return value === 'zh-CN' || value === 'en-US'
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function readWebPreferences(): WebPreferences {
  try {
    const stored = localStorage.getItem(WEB_PREFERENCES_KEY)
    if (stored === null) return defaultPreferences

    const parsed: unknown = JSON.parse(stored)
    if (!isRecord(parsed) || !isLocale(parsed.locale) || !isThemePreference(parsed.theme)) {
      return defaultPreferences
    }

    return { locale: parsed.locale, theme: parsed.theme }
  } catch {
    return defaultPreferences
  }
}

export function writeWebPreferences(preferences: WebPreferences): void {
  try {
    localStorage.setItem(WEB_PREFERENCES_KEY, JSON.stringify(preferences))
  } catch {
    // The shell remains usable when browser storage is unavailable.
  }
}

export function applyResolvedWebTheme(theme: ResolvedWebTheme): void {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.dataset.theme = theme
  root.style.colorScheme = theme
}
