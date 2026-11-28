export const THEME_API_VERSION = 1 as const

export const APPEARANCE_STORAGE_KEY = 'clinmesh.appearance:v2' as const
export const LEGACY_PREFERENCES_STORAGE_KEY = 'clinmesh.preferences:v1' as const
export const INSTALLED_THEMES_DB_NAME = 'clinmesh_themes' as const
export const INSTALLED_THEMES_STORE_NAME = 'packages' as const
export const INSTALLED_THEMES_FALLBACK_KEY = 'clinmesh.installedThemes:v1' as const
export const THEME_SAFE_MODE_SESSION_KEY = 'clinmesh.themeSafeMode' as const

export const DEFAULT_THEME_ID = 'default' as const
export const MAX_INSTALLED_THEMES = 20 as const
export const THEME_PACKAGE_MAX_BYTES = 1024 * 1024
export const THEME_CSS_MAX_BYTES = 512 * 1024
export const THEME_MAX_ASSETS = 24 as const
export const THEME_MAX_OPTIONS = 24 as const
export const THEME_MAX_CHOICES = 8 as const

export const LOCKED_CLINICAL_VARIABLES = [
  'specimen-cap-purple',
  'specimen-cap-yellow',
  'specimen-cap-blue',
  'specimen-cap-black',
  'specimen-cap-amber',
  'specimen-cap-neutral',
] as const

export type LockedClinicalVariable = (typeof LOCKED_CLINICAL_VARIABLES)[number]

export type ColorMode = 'light' | 'dark' | 'system'
export type ResolvedColorMode = 'light' | 'dark'
export type AppRailMode = 'rail' | 'expanded' | 'hidden'
export type AppSpaceId = 'clinical' | 'chat' | 'agents' | 'research' | 'settings'

export type LocalizedText = string | Readonly<Record<string, string>>

export interface ThemedColor {
  light: string
  dark: string
}

interface ThemeOptionBase {
  id: string
  label: LocalizedText
  description?: LocalizedText
}

export interface ThemeHeadingOption extends ThemeOptionBase {
  type: 'heading'
}

export interface ThemeToggleOption extends ThemeOptionBase {
  type: 'toggle'
  default: boolean
}

export interface ThemeSelectOption extends ThemeOptionBase {
  type: 'select'
  default: string
  choices: readonly {
    value: string
    label: LocalizedText
    swatch?: string
  }[]
}

export interface ThemeColorOption extends ThemeOptionBase {
  type: 'color'
  default: ThemedColor
}

export interface ThemeNumberOption extends ThemeOptionBase {
  type: 'number' | 'slider'
  default: number
  min?: number
  max?: number
  step?: number
  unit?: string
}

export interface ThemeTextOption extends ThemeOptionBase {
  type: 'text' | 'font'
  default: string
}

export interface ThemeVariableSelectOption extends ThemeOptionBase {
  type: 'variable-select'
  default: string
  choices: readonly {
    value: string
    label: LocalizedText
  }[]
}

export type ThemeOption =
  | ThemeHeadingOption
  | ThemeToggleOption
  | ThemeSelectOption
  | ThemeColorOption
  | ThemeNumberOption
  | ThemeTextOption
  | ThemeVariableSelectOption

export type ThemeOptionValue =
  | string
  | boolean
  | number
  | Readonly<Partial<ThemedColor>>

export type ThemeOptionValues = Readonly<Record<string, ThemeOptionValue>>

export interface ThemeManifest {
  apiVersion: typeof THEME_API_VERSION
  id: string
  name: string
  enName?: string
  author?: string
  version?: string
  description?: LocalizedText
  options?: readonly ThemeOption[]
}

export interface ThemeSwatchPalette {
  shell: string
  canvas: string
  surface: string
  border: string
  selected: string
  fg: string
  muted: string
  brand: string
  warn: string
  info: string
  ok: string
}

export interface Theme extends ThemeManifest {
  css: string
  assets?: Readonly<Record<string, string>>
  swatch?: {
    light: ThemeSwatchPalette
    dark: ThemeSwatchPalette
  }
}

export type ThemeTokens = Readonly<Record<string, string>>

export interface BuiltInTheme extends Theme {
  readonly builtIn: true
  readonly author: 'ClinMesh'
  readonly swatch: {
    light: ThemeSwatchPalette
    dark: ThemeSwatchPalette
  }
  tokens: {
    light: ThemeTokens
    dark: ThemeTokens
  }
  extraCss?: string
}

export type BuiltInThemeId =
  | 'default'
  | 'quiet-studio'
  | 'ward-precision'
  | 'warm-chart'
  | 'scrub-fresh'
  | 'ink-editorial'

export const UI_FONTS = ['system', 'inter', 'serif', 'mono'] as const
export type UiFont = (typeof UI_FONTS)[number]

export const CJK_FONTS = ['sans', 'serif', 'kai'] as const
export type CjkFont = (typeof CJK_FONTS)[number]

export const FONT_SIZES = [12, 13, 14, 15, 16, 17, 18] as const
export type FontSize = (typeof FONT_SIZES)[number]
export const DEFAULT_FONT_SIZE: FontSize = 14

export const CONTENT_LEADINGS = ['compact', 'default', 'relaxed'] as const
export type ContentLeading = (typeof CONTENT_LEADINGS)[number]

export const DENSITIES = ['compact', 'default', 'comfortable'] as const
export type Density = (typeof DENSITIES)[number]

export interface AppearancePreferences {
  version: 2
  colorMode: ColorMode
  theme: string
  themeOptions: Readonly<Record<string, ThemeOptionValues>>
  uiFont: UiFont
  uiCjkFont: CjkFont
  fontSize: FontSize
  contentLeading: ContentLeading
  density: Density
  railMode: AppRailMode
  reduceMotion: boolean
  highContrast: boolean
}

export interface LegacyWebPreferencesV1 {
  fontSize: 'standard' | 'larger' | 'large'
  locale: 'zh-CN' | 'en-US'
  theme: 'system' | 'light' | 'dark'
}

export interface ThemeCssError {
  line: number
  message: string
}

export type ThemeCssResult =
  | { ok: true; css: string }
  | { ok: false; errors: readonly ThemeCssError[] }

export interface ThemePackageInput {
  manifest: unknown
  css: unknown
  assets?: unknown
}

export type ThemePackageResult =
  | { ok: true; theme: Theme }
  | { ok: false; errors: readonly string[] }

export interface ThemeCheckIssue {
  level: 'error' | 'warning'
  code:
    | 'INVALID_MANIFEST'
    | 'CSS_SANITIZE_ERROR'
    | 'LOCKED_CLINICAL_VARIABLE'
    | 'PROTECTED_SELECTOR_TAMPER'
    | 'CONTRAST_FAILURE'
  message: string
}

export interface ContrastCheck {
  mode: ResolvedColorMode
  area: 'surface-text' | 'surface-muted' | 'page-text' | 'brand-button'
  foreground: string
  background: string
  ratio: number
  required: 4.5 | 3
  passed: boolean
}

export interface ThemeCheckReport {
  ok: boolean
  theme?: Theme
  issues: readonly ThemeCheckIssue[]
  contrast: readonly ContrastCheck[]
}

export interface ArchiveFile {
  path: string
  data: Uint8Array
}

export function resolveLocalizedText(
  text: LocalizedText | undefined,
  locale: string,
): string {
  if (text === undefined) return ''
  if (typeof text === 'string') return text
  return text[locale] ?? text['zh-CN'] ?? text['en-US'] ?? Object.values(text)[0] ?? ''
}
