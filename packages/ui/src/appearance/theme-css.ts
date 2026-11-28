import {
  LOCKED_CLINICAL_VARIABLES,
  THEME_CSS_MAX_BYTES,
  THEME_OPTION_ATTR_PREFIX_VAL,
} from './constants.ts'
import type {
  AppearancePreferences,
  ThemeCssError,
  ThemeCssResult,
  ThemeManifest,
} from './types.ts'

const FORBIDDEN_AT_RULES = /@(?:import|namespace)\b/gi
const FORBIDDEN_FUNCTIONS = /\b(?:image-set|-webkit-image-set|expression)\s*\(/gi
const FORBIDDEN_PROPERTIES = /\b(?:-moz-binding|behavior)\s*:/gi
const PROTECTED_SELECTOR_TAMPER = /\[data-agent-confirm[^\]]*\][^{]*\{[^}]*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?(?:\s|;|!|\})|pointer-events\s*:\s*none)/gi

function lineAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1
  }
  return line
}

function stripCommentsPreserveLines(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
}

/**
 * Tokenizer-safe CSS sanitizer for zero-JS custom theme packages:
 * - Blocks `@import`, `@namespace`, `image-set()`, `expression()`, `-moz-binding`, `behavior:`
 * - Blocks any external/data/javascript `url(...)` and rewrites validated relative `url(...)` to base64 data URLs
 * - Rejects overrides of `LOCKED_CLINICAL_VARIABLES` (`--specimen-cap-*`)
 * - Rejects rules attempting to hide or disable `[data-agent-confirm]` clinical confirmation gates
 */
export function sanitizeThemeCss(
  rawCss: string,
  assets: Readonly<Record<string, string>> = {},
): ThemeCssResult {
  if (new TextEncoder().encode(rawCss).byteLength > THEME_CSS_MAX_BYTES) {
    return {
      ok: false,
      errors: [{ line: 1, message: 'Theme CSS exceeds the 512 KiB size limit.' }],
    }
  }

  const errors: ThemeCssError[] = []
  const cleaned = stripCommentsPreserveLines(rawCss)

  for (const match of cleaned.matchAll(FORBIDDEN_AT_RULES)) {
    errors.push({
      line: lineAt(cleaned, match.index ?? 0),
      message: `Disallowed CSS at-rule "${match[0]}". External imports are blocked.`,
    })
  }
  for (const match of cleaned.matchAll(FORBIDDEN_FUNCTIONS)) {
    errors.push({
      line: lineAt(cleaned, match.index ?? 0),
      message: `Disallowed CSS function "${match[0].trim()}".`,
    })
  }
  for (const match of cleaned.matchAll(FORBIDDEN_PROPERTIES)) {
    errors.push({
      line: lineAt(cleaned, match.index ?? 0),
      message: `Disallowed CSS property "${match[0].trim()}".`,
    })
  }
  for (const locked of LOCKED_CLINICAL_VARIABLES) {
    const lockedRe = new RegExp(`--${locked}\\s*:`, 'g')
    for (const match of cleaned.matchAll(lockedRe)) {
      errors.push({
        line: lineAt(cleaned, match.index ?? 0),
        message: `Clinical safety guardrail: "--${locked}" is locked and cannot be overridden by themes.`,
      })
    }
  }
  for (const match of cleaned.matchAll(PROTECTED_SELECTOR_TAMPER)) {
    errors.push({
      line: lineAt(cleaned, match.index ?? 0),
      message: 'Clinical safety guardrail: themes cannot hide or disable [data-agent-confirm] controls.',
    })
  }

  const rewritten = cleaned.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/gi,
    (full, dq: string | undefined, sq: string | undefined, bare: string | undefined, offset: number) => {
      const target = (dq ?? sq ?? bare ?? '').trim()
      if (target === '' || target.startsWith('#')) return full
      if (/^(?:https?:|data:|javascript:|vbscript:|file:|\/\/)/i.test(target)) {
        errors.push({
          line: lineAt(cleaned, offset),
          message: `External or inline URL "${target.slice(0, 48)}" is blocked in themes. Bundle local files inside the theme package instead.`,
        })
        return 'none'
      }
      const normalized = target.replace(/^\.\//, '').replaceAll('\\', '/')
      const resolved = assets[normalized]
      if (resolved === undefined) {
        errors.push({
          line: lineAt(cleaned, offset),
          message: `Referenced local asset "${normalized}" was not found in the theme package.`,
        })
        return 'none'
      }
      return `url("${resolved}")`
    },
  )

  if (errors.length > 0) {
    return { ok: false, errors }
  }
  return { ok: true, css: rewritten }
}

const FONT_UI_STACKS: Record<AppearancePreferences['uiFont'], string> = {
  system: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial',
  inter: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial',
  serif: '"Source Serif 4", Georgia, "Times New Roman", serif',
  mono: '"SFMono-Regular", Consolas, "Liberation Mono", ui-monospace, Menlo, monospace',
}

const FONT_CJK_STACKS: Record<AppearancePreferences['uiCjkFont'], string> = {
  sans: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif',
  serif: '"Songti SC", "STSong", "Source Han Serif SC", "Noto Serif SC", "SimSun", serif',
  kai: '"LXGW WenKai", "Kaiti SC", "STKaiti", "KaiTi", "Songti SC", serif',
}

const CONTENT_LEADING_MAP: Record<AppearancePreferences['contentLeading'], string> = {
  compact: '1.45',
  default: '1.625',
  relaxed: '1.85',
}

function safeCssColorOrValue(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 160) return null
  if (/[;{}<>\\]|url\(|expression\(|@import/i.test(trimmed)) return null
  return trimmed
}

export function collectThemeOptionAttributes(
  manifest: ThemeManifest,
  values: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, string>> {
  const attrs: Record<string, string> = {}
  for (const option of manifest.options ?? []) {
    const raw = values?.[option.id]
    if (option.type === 'toggle') {
      const enabled = typeof raw === 'boolean' ? raw : option.default
      if (enabled) attrs[`${THEME_OPTION_ATTR_PREFIX_VAL}${option.id}`] = 'on'
    } else if (option.type === 'select') {
      const selected = typeof raw === 'string' && option.choices.some(c => c.value === raw)
        ? raw
        : option.default
      attrs[`${THEME_OPTION_ATTR_PREFIX_VAL}${option.id}`] = selected
    }
  }
  return attrs
}

export function compileAppearanceOverrides(
  manifest: ThemeManifest,
  prefs: Pick<
    AppearancePreferences,
    'themeOptions' | 'uiFont' | 'uiCjkFont' | 'fontSize' | 'contentLeading' | 'highContrast' | 'reduceMotion'
  >,
): string {
  const rules: string[] = []
  const values = prefs.themeOptions[manifest.id]
  const lightVars: string[] = []
  const darkVars: string[] = []
  const sharedVars: string[] = []

  for (const option of manifest.options ?? []) {
    const raw = values?.[option.id]
    if (option.type === 'color') {
      const colorObj = (typeof raw === 'object' && raw !== null ? raw : {}) as {
        light?: unknown
        dark?: unknown
      }
      const lightVal = safeCssColorOrValue(
        typeof colorObj.light === 'string' ? colorObj.light : option.default.light,
      )
      const darkVal = safeCssColorOrValue(
        typeof colorObj.dark === 'string' ? colorObj.dark : option.default.dark,
      )
      if (lightVal) lightVars.push(`  --${option.id}: ${lightVal};`)
      if (darkVal) darkVars.push(`  --${option.id}: ${darkVal};`)
    } else if (option.type === 'number' || option.type === 'slider') {
      const num = typeof raw === 'number' && Number.isFinite(raw) ? raw : option.default
      const clamped = Math.min(option.max ?? num, Math.max(option.min ?? num, num))
      sharedVars.push(`  --${option.id}: ${clamped}${option.unit ?? ''};`)
    } else if (option.type === 'variable-select') {
      const val = typeof raw === 'string' && option.choices.some(c => c.value === raw)
        ? raw
        : option.default
      const safe = safeCssColorOrValue(val)
      if (safe) sharedVars.push(`  --${option.id}: ${safe};`)
    } else if (option.type === 'text' || option.type === 'font') {
      const safe = safeCssColorOrValue(typeof raw === 'string' ? raw : option.default)
      if (safe) sharedVars.push(`  --${option.id}: ${safe};`)
    }
  }

  // Font stack & scale overrides (only emit when departing from default so default baseline stays untouched)
  if (prefs.uiFont !== 'system' || prefs.uiCjkFont !== 'sans') {
    sharedVars.push(`  --font-ui: ${FONT_UI_STACKS[prefs.uiFont]}, ${FONT_CJK_STACKS[prefs.uiCjkFont]};`)
  }
  sharedVars.push(`  --content-leading: ${CONTENT_LEADING_MAP[prefs.contentLeading]};`)

  if (sharedVars.length > 0) {
    rules.push(`:root, .clinmesh-web-root {\n${sharedVars.join('\n')}\n}`)
  }
  if (lightVars.length > 0) {
    rules.push(`:root.theme-light, .clinmesh-web-root:not(.dark) {\n${lightVars.join('\n')}\n}`)
  }
  if (darkVars.length > 0) {
    rules.push(`:root.theme-dark, .clinmesh-web-root.dark {\n${darkVars.join('\n')}\n}`)
  }

  if (prefs.highContrast) {
    rules.push(`:root.theme-light, .clinmesh-web-root:not(.dark), :root.theme-dark, .clinmesh-web-root.dark {
  --muted-foreground: color-mix(in oklab, var(--foreground) 80%, var(--background));
  --border: color-mix(in oklab, var(--foreground) 28%, var(--background));
  --input: color-mix(in oklab, var(--foreground) 44%, var(--background));
}`)
  }

  if (prefs.reduceMotion) {
    rules.push(`*, *::before, *::after {
  animation-duration: 0.01ms !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0.01ms !important;
  scroll-behavior: auto !important;
}`)
  }

  return rules.join('\n\n')
}
