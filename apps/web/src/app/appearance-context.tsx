import {
  applyAppearanceToDom,
  BUILT_IN_THEMES,
  DEFAULT_APPEARANCE_PREFERENCES,
  DEFAULT_THEME_ID,
  findBuiltInTheme,
  fontSizePxToLegacy,
  legacyFontSizeToPx,
  listInstalledThemes,
  readAppearancePreferences,
  readThemeSafeMode,
  removeInstalledTheme,
  resolveColorMode,
  saveInstalledTheme,
  updateThemeOptionValue,
  writeAppearancePreferences,
  writeThemeSafeMode,
  type AppearancePreferences,
  type AppRailMode,
  type CjkFont,
  type ColorMode,
  type ContentLeading,
  type Density,
  type FontSize,
  type ResolvedColorMode,
  type Theme,
  type ThemeOptionValue,
  type UiFont,
} from '@clinmesh/ui/appearance'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { FontSizePreference, ThemePreference } from './preferences.ts'

const DARK_MODE_QUERY = '(prefers-color-scheme: dark)'

export interface AppearanceContextValue {
  appearance: AppearancePreferences
  resolvedColorMode: ResolvedColorMode
  allThemes: readonly Theme[]
  installedThemes: readonly Theme[]
  activeTheme: Theme
  previewThemeId: string | null
  safeMode: boolean
  setColorMode: (mode: ColorMode) => void
  setTheme: (themeId: string) => void
  setThemeOption: (themeId: string, optionId: string, value: ThemeOptionValue) => void
  resetThemeOptions: (themeId: string) => void
  setFontSize: (size: FontSize) => void
  setLegacyFontSize: (size: FontSizePreference) => void
  setUiFont: (font: UiFont) => void
  setUiCjkFont: (font: CjkFont) => void
  setContentLeading: (leading: ContentLeading) => void
  setDensity: (density: Density) => void
  setRailMode: (mode: AppRailMode) => void
  setReduceMotion: (value: boolean) => void
  setHighContrast: (value: boolean) => void
  resetAllAppearance: () => void
  startThemePreview: (themeId: string) => void
  stopThemePreview: () => void
  enterSafeMode: () => void
  exitSafeMode: () => void
  installTheme: (theme: Theme) => Promise<void>
  uninstallTheme: (themeId: string) => Promise<void>
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null)

export function AppearanceProvider({
  appRootRef,
  legacyTheme,
  legacyFontSize,
  onSyncLegacyPreferences,
  children,
}: {
  appRootRef: React.RefObject<HTMLDivElement | null>
  legacyTheme: ThemePreference
  legacyFontSize: FontSizePreference
  onSyncLegacyPreferences: (patch: { theme?: ThemePreference; fontSize?: FontSizePreference }) => void
  children: ReactNode
}): React.JSX.Element {
  const [appearance, setAppearance] = useState<AppearancePreferences>(() => readAppearancePreferences())
  const [installedThemes, setInstalledThemes] = useState<readonly Theme[]>([])
  const [safeMode, setSafeMode] = useState<boolean>(() => readThemeSafeMode())
  const [previewThemeId, setPreviewThemeId] = useState<string | null>(null)
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(DARK_MODE_QUERY).matches
      : false,
  )

  const syncLegacyRef = useRef(onSyncLegacyPreferences)
  syncLegacyRef.current = onSyncLegacyPreferences

  // Keep in sync if legacy preferences are changed directly by existing topbar/user menu controls
  useEffect(() => {
    setAppearance(current => {
      const nextFontSize = fontSizePxToLegacy(current.fontSize) === legacyFontSize
        ? current.fontSize
        : legacyFontSizeToPx(legacyFontSize)
      if (current.colorMode === legacyTheme && current.fontSize === nextFontSize) {
        return current
      }
      return {
        ...current,
        colorMode: legacyTheme,
        fontSize: nextFontSize,
      }
    })
  }, [legacyFontSize, legacyTheme])

  // Load installed custom themes from IndexedDB
  useEffect(() => {
    let active = true
    void listInstalledThemes().then(items => {
      if (active) setInstalledThemes(items)
    })
    return () => { active = false }
  }, [])

  // Track OS dark preference when colorMode === 'system'
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(DARK_MODE_QUERY)
    const onChange = () => setSystemDark(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  // Persist appearance v2
  useEffect(() => {
    writeAppearancePreferences(appearance)
  }, [appearance])

  const resolvedColorMode: ResolvedColorMode = useMemo(() => {
    if (appearance.colorMode === 'system') return systemDark ? 'dark' : 'light'
    return resolveColorMode(appearance.colorMode)
  }, [appearance.colorMode, systemDark])

  const allThemes = useMemo<readonly Theme[]>(
    () => [...BUILT_IN_THEMES, ...installedThemes],
    [installedThemes],
  )

  const activeTheme = useMemo<Theme>(() => {
    const id = safeMode ? DEFAULT_THEME_ID : appearance.theme
    return findBuiltInTheme(id) ?? installedThemes.find(t => t.id === id) ?? BUILT_IN_THEMES[0]!
  }, [appearance.theme, installedThemes, safeMode])

  // Apply CSS variables, classes, attributes & theme stylesheet cleanly to <html> and .clinmesh-web-root
  useEffect(() => {
    applyAppearanceToDom({
      prefs: appearance,
      resolvedMode: resolvedColorMode,
      installedThemes,
      safeMode,
      previewThemeId,
      appRoot: appRootRef.current,
    })
  }, [appRootRef, appearance, installedThemes, previewThemeId, resolvedColorMode, safeMode])

  const setColorMode = useCallback((colorMode: ColorMode) => {
    setAppearance(current => ({ ...current, colorMode }))
    syncLegacyRef.current({ theme: colorMode })
  }, [])

  const setTheme = useCallback((theme: string) => {
    setPreviewThemeId(null)
    setSafeMode(false)
    writeThemeSafeMode(false)
    setAppearance(current => ({ ...current, theme }))
  }, [])

  const setThemeOption = useCallback((themeId: string, optionId: string, value: ThemeOptionValue) => {
    setAppearance(current => updateThemeOptionValue(current, themeId, optionId, value))
  }, [])

  const resetThemeOptions = useCallback((themeId: string) => {
    setAppearance(current => {
      const nextOptions = { ...current.themeOptions }
      delete nextOptions[themeId]
      return { ...current, themeOptions: nextOptions }
    })
  }, [])

  const setFontSize = useCallback((fontSize: FontSize) => {
    setAppearance(current => ({ ...current, fontSize }))
    syncLegacyRef.current({ fontSize: fontSizePxToLegacy(fontSize) })
  }, [])

  const setLegacyFontSize = useCallback((legacy: FontSizePreference) => {
    const fontSize = legacyFontSizeToPx(legacy)
    setAppearance(current => ({ ...current, fontSize }))
    syncLegacyRef.current({ fontSize: legacy })
  }, [])

  const setUiFont = useCallback((uiFont: UiFont) => {
    setAppearance(current => ({ ...current, uiFont }))
  }, [])

  const setUiCjkFont = useCallback((uiCjkFont: CjkFont) => {
    setAppearance(current => ({ ...current, uiCjkFont }))
  }, [])

  const setContentLeading = useCallback((contentLeading: ContentLeading) => {
    setAppearance(current => ({ ...current, contentLeading }))
  }, [])

  const setDensity = useCallback((density: Density) => {
    setAppearance(current => ({ ...current, density }))
  }, [])

  const setRailMode = useCallback((railMode: AppRailMode) => {
    setAppearance(current => ({ ...current, railMode }))
  }, [])

  const setReduceMotion = useCallback((reduceMotion: boolean) => {
    setAppearance(current => ({ ...current, reduceMotion }))
  }, [])

  const setHighContrast = useCallback((highContrast: boolean) => {
    setAppearance(current => ({ ...current, highContrast }))
  }, [])

  const resetAllAppearance = useCallback(() => {
    setPreviewThemeId(null)
    setSafeMode(false)
    writeThemeSafeMode(false)
    setAppearance(DEFAULT_APPEARANCE_PREFERENCES)
    syncLegacyRef.current({ theme: 'system', fontSize: 'standard' })
  }, [])

  const startThemePreview = useCallback((themeId: string) => {
    setPreviewThemeId(themeId)
  }, [])

  const stopThemePreview = useCallback(() => {
    setPreviewThemeId(null)
  }, [])

  const enterSafeMode = useCallback(() => {
    setPreviewThemeId(null)
    setSafeMode(true)
    writeThemeSafeMode(true)
  }, [])

  const exitSafeMode = useCallback(() => {
    setSafeMode(false)
    writeThemeSafeMode(false)
  }, [])

  const installTheme = useCallback(async (theme: Theme) => {
    const next = await saveInstalledTheme(theme)
    setInstalledThemes(next)
    setSafeMode(false)
    writeThemeSafeMode(false)
    setAppearance(current => ({ ...current, theme: theme.id }))
  }, [])

  const uninstallTheme = useCallback(async (themeId: string) => {
    const next = await removeInstalledTheme(themeId)
    setInstalledThemes(next)
    setAppearance(current => (
      current.theme === themeId ? { ...current, theme: DEFAULT_THEME_ID } : current
    ))
  }, [])

  const value = useMemo<AppearanceContextValue>(() => ({
    appearance,
    resolvedColorMode,
    allThemes,
    installedThemes,
    activeTheme,
    previewThemeId,
    safeMode,
    setColorMode,
    setTheme,
    setThemeOption,
    resetThemeOptions,
    setFontSize,
    setLegacyFontSize,
    setUiFont,
    setUiCjkFont,
    setContentLeading,
    setDensity,
    setRailMode,
    setReduceMotion,
    setHighContrast,
    resetAllAppearance,
    startThemePreview,
    stopThemePreview,
    enterSafeMode,
    exitSafeMode,
    installTheme,
    uninstallTheme,
  }), [
    activeTheme,
    allThemes,
    appearance,
    enterSafeMode,
    exitSafeMode,
    installTheme,
    installedThemes,
    previewThemeId,
    resetAllAppearance,
    resetThemeOptions,
    resolvedColorMode,
    safeMode,
    setColorMode,
    setContentLeading,
    setDensity,
    setFontSize,
    setHighContrast,
    setLegacyFontSize,
    setRailMode,
    setReduceMotion,
    setTheme,
    setThemeOption,
    setUiCjkFont,
    setUiFont,
    startThemePreview,
    stopThemePreview,
    uninstallTheme,
  ])

  return (
    <AppearanceContext.Provider value={value}>
      {children}
    </AppearanceContext.Provider>
  )
}

export function useAppearance(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext)
  if (ctx === null) {
    throw new Error('useAppearance must be used inside AppearanceProvider.')
  }
  return ctx
}
