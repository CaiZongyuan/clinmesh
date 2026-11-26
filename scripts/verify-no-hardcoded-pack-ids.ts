import { globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export const FORBIDDEN_DISEASE_PACK_IDS = [
  'coronary-cad',
  'familial-hypercholesterolemia',
  't2dm-renal-care',
  'synthetic-test-syndrome',
] as const

const PACK_ID_PATTERN = new RegExp(
  `(?<![a-z0-9-])(?:${FORBIDDEN_DISEASE_PACK_IDS.join('|')})(?![a-z0-9-])`,
  'g',
)

const ALLOWED_NON_PRODUCTION_PATHS = [
  /\.test\.tsx?$/,
  /\.spec\.tsx?$/,
  /\.browser\.test\.tsx?$/,
  /^apps\/server\/src\/application\/scenario-data\//,
  /^apps\/server\/src\/application\/reference-data\//,
  /^packages\/core\/src\/phenotype-synthetic-kb\.ts$/,
]

export interface HardcodedPackIdViolation {
  readonly line: number
  readonly packId: string
  readonly path: string
}

export function isPackIdScanTarget(relativePath: string): boolean {
  const normalized = relativePath.split(sep).join('/')
  return !ALLOWED_NON_PRODUCTION_PATHS.some(pattern => pattern.test(normalized))
}

export function scanSourceTextForHardcodedPackIds(
  relativePath: string,
  content: string,
): HardcodedPackIdViolation[] {
  if (!isPackIdScanTarget(relativePath)) return []
  const normalized = relativePath.split(sep).join('/')
  const violations: HardcodedPackIdViolation[] = []
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index]!
    const trimmed = lineText.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    // Public diagnosis concept slug shares disease name in PUBLIC_CONCEPT_VOCABULARY; still catch any packId branching in the file.
    if (
      normalized === 'packages/core/src/concept-vocabulary.ts'
      && trimmed.startsWith("pubNode('familial-hypercholesterolemia',")
    ) {
      continue
    }
    PACK_ID_PATTERN.lastIndex = 0
    for (const match of lineText.matchAll(PACK_ID_PATTERN)) {
      violations.push({
        line: index + 1,
        packId: match[0],
        path: normalized,
      })
    }
  }
  return violations
}

export function findHardcodedPackIdViolations(root: string): HardcodedPackIdViolation[] {
  const files = globSync('{apps,packages}/*/src/**/*.{ts,tsx}', { cwd: root })
    .map(item => item.split(sep).join('/'))
    .filter(isPackIdScanTarget)
    .sort()

  const violations: HardcodedPackIdViolation[] = []
  for (const relativePath of files) {
    const content = readFileSync(resolve(root, relativePath), 'utf8')
    violations.push(...scanSourceTextForHardcodedPackIds(relativePath, content))
  }
  return violations
}

const isMainEntry = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(import.meta.filename)

if (isMainEntry) {
  const root = resolve(import.meta.dirname, '..')
  const violations = findHardcodedPackIdViolations(root)
  if (violations.length === 0) {
    console.log('verify-no-hardcoded-pack-ids: zero hardcoded disease pack IDs in production sources.')
  } else {
    console.error('verify-no-hardcoded-pack-ids: violations found:')
    for (const v of violations) {
      console.error(`  ${v.path}:${v.line}: forbidden hardcoded pack ID '${v.packId}'`)
    }
    process.exitCode = 1
  }
}
