import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

interface Violation {
  file: string
  line: number
  rule: 'no-bare-html-control' | 'no-direct-ui-sdk-import' | 'no-hardcoded-color'
  detail: string
}

const REPO_ROOT = resolve(import.meta.dirname, '..')
const SCAN_ROOT = join(REPO_ROOT, 'apps', 'web', 'src')

const BARE_CONTROL_RE = /<(button|input|textarea|select)(?=[\s>/]|$)/g
const DIRECT_UI_SDK_IMPORT_RE =
  /(?:from\s+|import\s*\(\s*)['"](@ui-sdk\/(?:core|react)(?:\/[^'"]+)?)['"]/g
const ALLOWED_UI_SDK_IMPORTS = new Set(['@ui-sdk/react/agent'])
const RAW_TW_COLOR_RE =
  /\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|divide|decoration|accent|caret|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d+)?\b/g
const MAGIC_HEX_RE =
  /(?:^|[\s:'"(,:])#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-fA-F\w])/g

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkSourceFiles(fullPath, out)
    } else if (
      /\.(?:ts|tsx)$/.test(entry.name) &&
      !/\.test\.(?:ts|tsx)$/.test(entry.name)
    ) {
      out.push(fullPath)
    }
  }
  return out
}

function stripCommentsPreserveLines(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\r\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\r\n]*/g, (match, prefix: string) =>
      `${prefix}${' '.repeat(match.length - prefix.length)}`,
    )
}

function scanFile(filePath: string): Violation[] {
  const violations: Violation[] = []
  const relPath = relative(REPO_ROOT, filePath).replaceAll('\\', '/')
  const raw = readFileSync(filePath, 'utf8')
  const cleaned = stripCommentsPreserveLines(raw)
  const lines = cleaned.split(/\r?\n/)
  const isTsx = relPath.endsWith('.tsx')

  lines.forEach((line, index) => {
    const lineNumber = index + 1

    if (isTsx) {
      for (const match of line.matchAll(BARE_CONTROL_RE)) {
        violations.push({
          file: relPath,
          line: lineNumber,
          rule: 'no-bare-html-control',
          detail: `Bare <${match[1]}> element; use @clinmesh/ui component instead.`,
        })
      }
    }

    for (const match of line.matchAll(DIRECT_UI_SDK_IMPORT_RE)) {
      const specifier = match[1] ?? ''
      if (!ALLOWED_UI_SDK_IMPORTS.has(specifier)) {
        violations.push({
          file: relPath,
          line: lineNumber,
          rule: 'no-direct-ui-sdk-import',
          detail: `Direct import '${specifier}' is disallowed in apps/web; import from @clinmesh/ui instead.`,
        })
      }
    }

    for (const match of line.matchAll(RAW_TW_COLOR_RE)) {
      violations.push({
        file: relPath,
        line: lineNumber,
        rule: 'no-hardcoded-color',
        detail: `Raw Tailwind palette class '${match[0]}'; use semantic theme tokens instead.`,
      })
    }

    if (isTsx) {
      for (const match of line.matchAll(MAGIC_HEX_RE)) {
        violations.push({
          file: relPath,
          line: lineNumber,
          rule: 'no-hardcoded-color',
          detail: `Hardcoded hex color '${match[0].trim()}'; use semantic CSS tokens instead.`,
        })
      }
    }
  })

  return violations
}

function main(): void {
  const files = walkSourceFiles(SCAN_ROOT)
  const violations = files.flatMap(scanFile)

  if (violations.length > 0) {
    console.error(`UI consistency lint failed with ${violations.length} violation(s):`)
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} [${v.rule}] ${v.detail}`)
    }
    process.exitCode = 1
    return
  }

  console.log(`UI consistency lint passed (${files.length} files checked).`)
}

main()
