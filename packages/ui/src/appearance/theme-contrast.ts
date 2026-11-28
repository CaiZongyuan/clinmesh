import { contrastRatio, parseColor } from '@ui-sdk/core/color'
import { sanitizeThemeCss } from './theme-css.ts'
import type {
  BuiltInTheme,
  ContrastCheck,
  ResolvedColorMode,
  Theme,
  ThemeCheckIssue,
  ThemeCheckReport,
  ThemeManifest,
  ThemeOption,
  ThemePackageInput,
  ThemePackageResult,
  ThemeTokens,
} from './types.ts'
import {
  THEME_API_VERSION,
  THEME_MAX_CHOICES,
  THEME_MAX_OPTIONS,
} from './types.ts'

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const OPTION_ID_RE = /^[a-z][a-z0-9-]{0,47}$/

const DEFAULT_FALLBACK_TOKENS: Record<ResolvedColorMode, Record<string, string>> = {
  light: {
    background: '#f5f6f7',
    card: '#ffffff',
    foreground: '#0f1115',
    'muted-foreground': '#61666b',
    primary: '#0f1115',
    'primary-foreground': '#ffffff',
    info: '#1764c0',
  },
  dark: {
    background: '#151517',
    card: '#232324',
    foreground: '#f9fafb',
    'muted-foreground': '#cfd3d6',
    primary: '#f9fafb',
    'primary-foreground': '#151517',
    info: '#8dbbff',
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function measureContrastRatio(fg: string, bg: string): number | null {
  try {
    const fgColor = parseColor(fg.trim())
    const bgColor = parseColor(bg.trim())
    if (fgColor === null || bgColor === null) return null
    return Number(contrastRatio(fgColor, bgColor).toFixed(2))
  } catch {
    return null
  }
}

function evaluateTokenPair(
  mode: ResolvedColorMode,
  area: ContrastCheck['area'],
  fg: string,
  bg: string,
  required: 4.5 | 3,
): ContrastCheck | null {
  const ratio = measureContrastRatio(fg, bg)
  if (ratio === null) return null
  return {
    mode,
    area,
    foreground: fg,
    background: bg,
    ratio,
    required,
    passed: ratio >= required,
  }
}

export function auditTokenTableContrast(
  tokens: { light: ThemeTokens; dark: ThemeTokens },
): ContrastCheck[] {
  const results: ContrastCheck[] = []
  for (const mode of ['light', 'dark'] as const) {
    const merged = { ...DEFAULT_FALLBACK_TOKENS[mode], ...tokens[mode] }
    const pairs: Array<[ContrastCheck['area'], string, string, 4.5 | 3]> = [
      ['surface-text', merged.foreground ?? '', merged.card ?? '', 4.5],
      ['surface-muted', merged['muted-foreground'] ?? '', merged.card ?? '', 4.5],
      ['page-text', merged.foreground ?? '', merged.background ?? '', 4.5],
      ['brand-button', merged['primary-foreground'] ?? '', merged.primary ?? '', 4.5],
    ]
    for (const [area, fg, bg, req] of pairs) {
      const check = evaluateTokenPair(mode, area, fg, bg, req)
      if (check !== null) results.push(check)
    }
  }
  return results
}

export function auditBuiltInTheme(theme: BuiltInTheme): ThemeCheckReport {
  const issues: ThemeCheckIssue[] = []
  const sanitized = sanitizeThemeCss(theme.css)
  if (!sanitized.ok) {
    for (const err of sanitized.errors) {
      issues.push({
        level: 'error',
        code: err.message.includes('specimen-cap')
          ? 'LOCKED_CLINICAL_VARIABLE'
          : err.message.includes('data-agent-confirm')
            ? 'PROTECTED_SELECTOR_TAMPER'
            : 'CSS_SANITIZE_ERROR',
        message: `Line ${err.line}: ${err.message}`,
      })
    }
  }
  const contrast = auditTokenTableContrast(theme.tokens)
  for (const check of contrast) {
    if (!check.passed) {
      issues.push({
        level: 'error',
        code: 'CONTRAST_FAILURE',
        message: `[${theme.id}/${check.mode}] ${check.area} contrast ${check.ratio}:1 < ${check.required}:1 (${check.foreground} on ${check.background})`,
      })
    }
  }
  return {
    ok: issues.every(i => i.level !== 'error'),
    theme,
    issues,
    contrast,
  }
}

function validateThemeOptions(raw: unknown): { ok: true; options: ThemeOption[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, options: [] }
  if (!Array.isArray(raw)) return { ok: false, error: 'manifest.options must be an array.' }
  if (raw.length > THEME_MAX_OPTIONS) {
    return { ok: false, error: `manifest.options exceeds maximum of ${THEME_MAX_OPTIONS}.` }
  }
  const seen = new Set<string>()
  const options: ThemeOption[] = []
  for (const item of raw) {
    if (!isRecord(item)) return { ok: false, error: 'Each theme option must be an object.' }
    const id = item.id
    const type = item.type
    const label = item.label
    if (typeof id !== 'string' || !OPTION_ID_RE.test(id)) {
      return { ok: false, error: `Invalid theme option id "${String(id)}".` }
    }
    if (seen.has(id)) return { ok: false, error: `Duplicate theme option id "${id}".` }
    seen.add(id)
    if (typeof label !== 'string' && !isRecord(label)) {
      return { ok: false, error: `Theme option "${id}" is missing a label.` }
    }
    if (type === 'select' && Array.isArray(item.choices) && item.choices.length > THEME_MAX_CHOICES) {
      return { ok: false, error: `Theme option "${id}" exceeds ${THEME_MAX_CHOICES} choices.` }
    }
    options.push(item as unknown as ThemeOption)
  }
  return { ok: true, options }
}

export function validateThemeManifest(raw: unknown): { ok: true; manifest: ThemeManifest } | { ok: false; errors: string[] } {
  if (!isRecord(raw)) return { ok: false, errors: ['manifest.json must be a JSON object.'] }
  const errors: string[] = []
  if (raw.apiVersion !== THEME_API_VERSION) {
    errors.push(`manifest.apiVersion must be ${THEME_API_VERSION}.`)
  }
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) {
    errors.push('manifest.id must be 1–40 lowercase alphanumeric/hyphen characters.')
  }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    errors.push('manifest.name must be a non-empty string.')
  }
  const optCheck = validateThemeOptions(raw.options)
  if (!optCheck.ok) errors.push(optCheck.error)
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    manifest: {
      apiVersion: THEME_API_VERSION,
      id: raw.id as string,
      name: (raw.name as string).trim(),
      ...(typeof raw.enName === 'string' ? { enName: raw.enName.trim() } : {}),
      ...(typeof raw.author === 'string' ? { author: raw.author.trim() } : {}),
      ...(typeof raw.version === 'string' ? { version: raw.version.trim() } : {}),
      ...(typeof raw.description === 'string'
        ? { description: raw.description }
        : isRecord(raw.description)
          ? { description: raw.description as Readonly<Record<string, string>> }
          : {}),
      ...(optCheck.ok && optCheck.options.length > 0 ? { options: optCheck.options } : {}),
    },
  }
}

function extractSimpleCssVars(css: string): { light: Record<string, string>; dark: Record<string, string> } {
  const light: Record<string, string> = {}
  const dark: Record<string, string> = {}
  const blockRe = /([^{}]+)\{([^{}]+)\}/g
  for (const match of css.matchAll(blockRe)) {
    const sel = (match[1] ?? '').trim()
    const body = match[2] ?? ''
    const isDark = /\.dark\b|\.theme-dark\b/.test(sel)
    const isLight = /:root\b|\.theme-light\b/.test(sel) && !isDark
    if (!isDark && !isLight) continue
    const target = isDark ? dark : light
    for (const decl of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      const key = decl[1]
      const val = decl[2]?.trim()
      if (key && val) target[key] = val
    }
  }
  return { light, dark }
}

export function parseThemePackage(input: ThemePackageInput): ThemePackageResult {
  const manifestResult = validateThemeManifest(input.manifest)
  if (!manifestResult.ok) return { ok: false, errors: manifestResult.errors }
  if (typeof input.css !== 'string') return { ok: false, errors: ['theme.css must be a string.'] }
  const assets: Record<string, string> = {}
  if (isRecord(input.assets)) {
    for (const [key, val] of Object.entries(input.assets)) {
      if (typeof val === 'string' && val.startsWith('data:')) assets[key] = val
    }
  }
  const sanitized = sanitizeThemeCss(input.css, assets)
  if (!sanitized.ok) {
    return {
      ok: false,
      errors: sanitized.errors.map(e => `Line ${e.line}: ${e.message}`),
    }
  }
  const theme: Theme = {
    ...manifestResult.manifest,
    css: sanitized.css,
    ...(Object.keys(assets).length > 0 ? { assets } : {}),
  }
  return { ok: true, theme }
}

export function checkThemePackage(input: ThemePackageInput): ThemeCheckReport {
  const issues: ThemeCheckIssue[] = []
  const parsed = parseThemePackage(input)
  if (!parsed.ok) {
    for (const message of parsed.errors) {
      issues.push({
        level: 'error',
        code: message.includes('specimen-cap')
          ? 'LOCKED_CLINICAL_VARIABLE'
          : message.includes('data-agent-confirm')
            ? 'PROTECTED_SELECTOR_TAMPER'
            : message.startsWith('manifest.')
              ? 'INVALID_MANIFEST'
              : 'CSS_SANITIZE_ERROR',
        message,
      })
    }
    return { ok: false, issues, contrast: [] }
  }

  const extracted = extractSimpleCssVars(parsed.theme.css)
  const contrast = auditTokenTableContrast(extracted)
  for (const check of contrast) {
    if (!check.passed) {
      issues.push({
        level: 'error',
        code: 'CONTRAST_FAILURE',
        message: `[${check.mode}] ${check.area} contrast ${check.ratio}:1 < ${check.required}:1 (${check.foreground} on ${check.background})`,
      })
    }
  }

  return {
    ok: issues.every(i => i.level !== 'error'),
    theme: parsed.theme,
    issues,
    contrast,
  }
}
