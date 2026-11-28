import { BUILT_IN_THEMES, findBuiltInTheme } from './built-in-themes.ts'
import { collectThemeOptionAttributes, compileAppearanceOverrides } from './theme-css.ts'
import type {
  AppearancePreferences,
  AppRailMode,
  CjkFont,
  ColorMode,
  ContentLeading,
  Density,
  FontSize,
  LegacyWebPreferencesV1,
  ResolvedColorMode,
  Theme,
  ThemeOptionValue,
  UiFont,
} from './types.ts'
import {
  APPEARANCE_STORAGE_KEY,
  CJK_FONTS,
  CONTENT_LEADINGS,
  DEFAULT_FONT_SIZE,
  DEFAULT_THEME_ID,
  DENSITIES,
  FONT_SIZES,
  INSTALLED_THEMES_DB_NAME,
  INSTALLED_THEMES_FALLBACK_KEY,
  INSTALLED_THEMES_STORE_NAME,
  LEGACY_PREFERENCES_STORAGE_KEY,
  MAX_INSTALLED_THEMES,
  THEME_SAFE_MODE_SESSION_KEY,
  UI_FONTS,
} from './types.ts'

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  version: 2,
  colorMode: 'system',
  theme: DEFAULT_THEME_ID,
  themeOptions: {},
  uiFont: 'system',
  uiCjkFont: 'sans',
  fontSize: DEFAULT_FONT_SIZE,
  contentLeading: 'default',
  density: 'default',
  railMode: 'rail',
  reduceMotion: false,
  highContrast: false,
}

export function legacyFontSizeToPx(size: LegacyWebPreferencesV1['fontSize']): FontSize {
  if (size === 'large') return 18
  if (size === 'larger') return 16
  return 14
}

export function fontSizePxToLegacy(px: FontSize): LegacyWebPreferencesV1['fontSize'] {
  if (px >= 17) return 'large'
  if (px >= 15) return 'larger'
  return 'standard'
}

export function fontSizePxToScale(px: FontSize): number {
  if (px === 18) return 1.25 // preserves exact 17.5px on 14px base for existing E2E contracts
  if (px === 16) return 1.125
  return Number((px / 14).toFixed(4))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isColorMode(v: unknown): v is ColorMode {
  return v === 'light' || v === 'dark' || v === 'system'
}

function isRailMode(v: unknown): v is AppRailMode {
  return v === 'rail' || v === 'expanded' || v === 'hidden'
}

function isUiFont(v: unknown): v is UiFont {
  return typeof v === 'string' && (UI_FONTS as readonly string[]).includes(v)
}

function isCjkFont(v: unknown): v is CjkFont {
  return typeof v === 'string' && (CJK_FONTS as readonly string[]).includes(v)
}

function isFontSize(v: unknown): v is FontSize {
  return typeof v === 'number' && (FONT_SIZES as readonly number[]).includes(v)
}

function isContentLeading(v: unknown): v is ContentLeading {
  return typeof v === 'string' && (CONTENT_LEADINGS as readonly string[]).includes(v)
}

function isDensity(v: unknown): v is Density {
  return typeof v === 'string' && (DENSITIES as readonly string[]).includes(v)
}

export function migrateLegacyPreferences(rawV1: unknown): AppearancePreferences {
  if (!isRecord(rawV1)) return DEFAULT_APPEARANCE_PREFERENCES
  const colorMode: ColorMode = isColorMode(rawV1.theme) ? rawV1.theme : 'system'
  const fontSize: FontSize = rawV1.fontSize === 'large' || rawV1.fontSize === 'larger' || rawV1.fontSize === 'standard'
    ? legacyFontSizeToPx(rawV1.fontSize)
    : DEFAULT_FONT_SIZE
  return {
    ...DEFAULT_APPEARANCE_PREFERENCES,
    colorMode,
    fontSize,
  }
}

export function readAppearancePreferences(): AppearancePreferences {
  if (typeof localStorage === 'undefined') return DEFAULT_APPEARANCE_PREFERENCES
  try {
    const rawV2 = localStorage.getItem(APPEARANCE_STORAGE_KEY)
    if (rawV2 !== null) {
      const parsed: unknown = JSON.parse(rawV2)
      if (isRecord(parsed) && parsed.version === 2) {
        return {
          version: 2,
          colorMode: isColorMode(parsed.colorMode) ? parsed.colorMode : 'system',
          theme: typeof parsed.theme === 'string' && parsed.theme.length > 0 ? parsed.theme : DEFAULT_THEME_ID,
          themeOptions: isRecord(parsed.themeOptions)
            ? (parsed.themeOptions as AppearancePreferences['themeOptions'])
            : {},
          uiFont: isUiFont(parsed.uiFont) ? parsed.uiFont : 'system',
          uiCjkFont: isCjkFont(parsed.uiCjkFont) ? parsed.uiCjkFont : 'sans',
          fontSize: isFontSize(parsed.fontSize) ? parsed.fontSize : DEFAULT_FONT_SIZE,
          contentLeading: isContentLeading(parsed.contentLeading) ? parsed.contentLeading : 'default',
          density: isDensity(parsed.density) ? parsed.density : 'default',
          railMode: isRailMode(parsed.railMode) ? parsed.railMode : 'rail',
          reduceMotion: parsed.reduceMotion === true,
          highContrast: parsed.highContrast === true,
        }
      }
    }
    const rawV1 = localStorage.getItem(LEGACY_PREFERENCES_STORAGE_KEY)
    if (rawV1 !== null) {
      return migrateLegacyPreferences(JSON.parse(rawV1))
    }
  } catch {
    // Storage access is optional.
  }
  return DEFAULT_APPEARANCE_PREFERENCES
}

export function writeAppearancePreferences(prefs: AppearancePreferences): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Ignore storage quota errors.
  }
}

export function resolveColorMode(colorMode: ColorMode): ResolvedColorMode {
  if (colorMode === 'light' || colorMode === 'dark') return colorMode
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}

export function readThemeSafeMode(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('theme') === DEFAULT_THEME_ID) {
      window.sessionStorage.setItem(THEME_SAFE_MODE_SESSION_KEY, '1')
      return true
    }
    return window.sessionStorage.getItem(THEME_SAFE_MODE_SESSION_KEY) === '1'
  } catch {
    return false
  }
}

export function writeThemeSafeMode(active: boolean): void {
  if (typeof window === 'undefined') return
  try {
    if (active) window.sessionStorage.setItem(THEME_SAFE_MODE_SESSION_KEY, '1')
    else window.sessionStorage.removeItem(THEME_SAFE_MODE_SESSION_KEY)
  } catch {
    // Session storage optional.
  }
}

/* ── IndexedDB + localStorage Fallback for Installed Custom Themes ───────── */

function openThemesDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise(resolve => {
    try {
      const req = indexedDB.open(INSTALLED_THEMES_DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(INSTALLED_THEMES_STORE_NAME)) {
          db.createObjectStore(INSTALLED_THEMES_STORE_NAME, { keyPath: 'id' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function listInstalledThemes(): Promise<Theme[]> {
  const db = await openThemesDb()
  if (db !== null) {
    return new Promise(resolve => {
      try {
        const tx = db.transaction(INSTALLED_THEMES_STORE_NAME, 'readonly')
        const req = tx.objectStore(INSTALLED_THEMES_STORE_NAME).getAll()
        req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as Theme[]) : [])
        req.onerror = () => resolve([])
      } catch {
        resolve([])
      }
    })
  }
  try {
    const raw = localStorage.getItem(INSTALLED_THEMES_FALLBACK_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as Theme[]) : []
  } catch {
    return []
  }
}

export async function saveInstalledTheme(theme: Theme): Promise<Theme[]> {
  const current = await listInstalledThemes()
  const filtered = current.filter(t => t.id !== theme.id)
  if (filtered.length >= MAX_INSTALLED_THEMES) {
    throw new Error(`Maximum of ${MAX_INSTALLED_THEMES} custom themes reached.`)
  }
  const db = await openThemesDb()
  if (db !== null) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(INSTALLED_THEMES_STORE_NAME, 'readwrite')
      tx.objectStore(INSTALLED_THEMES_STORE_NAME).put(theme)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('Failed to store theme.'))
    })
    return listInstalledThemes()
  }
  const next = [...filtered, theme]
  localStorage.setItem(INSTALLED_THEMES_FALLBACK_KEY, JSON.stringify(next))
  return next
}

export async function removeInstalledTheme(id: string): Promise<Theme[]> {
  const db = await openThemesDb()
  if (db !== null) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(INSTALLED_THEMES_STORE_NAME, 'readwrite')
      tx.objectStore(INSTALLED_THEMES_STORE_NAME).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('Failed to delete theme.'))
    })
    return listInstalledThemes()
  }
  const current = await listInstalledThemes()
  const next = current.filter(t => t.id !== id)
  localStorage.setItem(INSTALLED_THEMES_FALLBACK_KEY, JSON.stringify(next))
  return next
}

/* ── DOM Application Engine ──────────────────────────────────────────────── */

const THEME_STYLE_ID = 'clinmesh-theme-css'
const OVERRIDE_STYLE_ID = 'clinmesh-appearance-overrides'

function ensureStyleElement(id: string): HTMLStyleElement {
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (el === null) {
    el = document.createElement('style')
    el.id = id
    document.head.appendChild(el)
  }
  return el
}

function clearThemeOptionAttributes(el: HTMLElement): void {
  const toRemove: string[] = []
  for (let i = 0; i < el.attributes.length; i += 1) {
    const name = el.attributes[i]?.name
    if (name && name.startsWith('data-theme-option-')) toRemove.push(name)
  }
  for (const name of toRemove) el.removeAttribute(name)
}

export function applyAppearanceToDom(options: {
  prefs: AppearancePreferences
  resolvedMode: ResolvedColorMode
  installedThemes: readonly Theme[]
  safeMode: boolean
  previewThemeId: string | null
  appRoot?: HTMLElement | null
}): Theme {
  const { prefs, resolvedMode, installedThemes, safeMode, previewThemeId, appRoot } = options
  const targetId = safeMode ? DEFAULT_THEME_ID : (previewThemeId ?? prefs.theme)
  const theme: Theme =
    findBuiltInTheme(targetId) ??
    installedThemes.find(t => t.id === targetId) ??
    BUILT_IN_THEMES[0]!

  if (typeof document === 'undefined') return theme

  const targets: HTMLElement[] = [document.documentElement]
  if (appRoot) targets.push(appRoot)

  const optionAttrs = collectThemeOptionAttributes(theme, prefs.themeOptions[theme.id])
  const legacySize = fontSizePxToLegacy(prefs.fontSize)
  const fontScale = String(fontSizePxToScale(prefs.fontSize))

  for (const el of targets) {
    el.classList.toggle('dark', resolvedMode === 'dark')
    el.classList.toggle('theme-dark', resolvedMode === 'dark')
    el.classList.toggle('theme-light', resolvedMode !== 'dark')
    el.style.colorScheme = resolvedMode
    el.dataset.theme = theme.id
    el.dataset.colorMode = resolvedMode
    el.dataset.density = prefs.density
    el.dataset.fontSize = legacySize
    el.style.setProperty('--clinmesh-font-scale', fontScale)
    clearThemeOptionAttributes(el)
    for (const [attr, val] of Object.entries(optionAttrs)) {
      el.setAttribute(attr, val)
    }
  }

  ensureStyleElement(THEME_STYLE_ID).textContent = theme.css
  ensureStyleElement(OVERRIDE_STYLE_ID).textContent = compileAppearanceOverrides(theme, prefs)
  return theme
}

export function updateThemeOptionValue(
  prefs: AppearancePreferences,
  themeId: string,
  optionId: string,
  value: ThemeOptionValue,
): AppearancePreferences {
  return {
    ...prefs,
    themeOptions: {
      ...prefs.themeOptions,
      [themeId]: {
        ...prefs.themeOptions[themeId],
        [optionId]: value,
      },
    },
  }
}
