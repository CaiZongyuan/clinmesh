import { existsSync, globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..')

const ALLOWED_NON_PRODUCTION_PATHS = [
  /\.test\.tsx?$/,
  /\.spec\.tsx?$/,
  /\.browser\.test\.tsx?$/,
  /^apps\/server\/src\/application\/scenario-data\/pci-data\.ts$/,
  /^apps\/server\/src\/application\/scenario-data\/pci-selection-evidence\.ts$/,
  /^packages\/core\/src\/phenotype-synthetic-kb\.ts$/,
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, ch => `\\${ch}`)
}

/**
 * Dynamically collect all pack IDs and pack-owned guideline topic IDs declared under
 * `apps/server/disease-packs/*` plus `'synthetic-test-syndrome'`.
 * Adding any new pack JSON directory automatically puts its packId and topicIds under this guard.
 */
export function loadForbiddenPackAndTopicIds(root: string = REPOSITORY_ROOT): readonly string[] {
  const ids = new Set<string>(['synthetic-test-syndrome'])
  const packsDir = resolve(root, 'apps/server/disease-packs')
  if (existsSync(packsDir)) {
    for (const manifestPath of globSync('*/manifest.json', { cwd: packsDir }).sort()) {
      const parsed = JSON.parse(readFileSync(resolve(packsDir, manifestPath), 'utf8')) as { id?: unknown }
      if (typeof parsed.id === 'string' && parsed.id.length > 0) ids.add(parsed.id)
    }
    for (const knowledgePath of globSync('*/knowledge.json', { cwd: packsDir }).sort()) {
      const parsed = JSON.parse(readFileSync(resolve(packsDir, knowledgePath), 'utf8')) as {
        guidelineTopics?: Array<{ id?: unknown }>
      }
      for (const topic of parsed.guidelineTopics ?? []) {
        if (typeof topic?.id === 'string' && topic.id.length > 0) ids.add(topic.id)
      }
    }
  }
  return [...ids].sort()
}

export const FORBIDDEN_DISEASE_PACK_IDS: readonly string[] = loadForbiddenPackAndTopicIds(REPOSITORY_ROOT)

function buildIdPattern(ids: readonly string[]): RegExp {
  return new RegExp(
    `(?<![a-z0-9-])(?:${ids.map(escapeRegExp).join('|')})(?![a-z0-9-])`,
    'g',
  )
}

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
  forbiddenIds: readonly string[] = FORBIDDEN_DISEASE_PACK_IDS,
): HardcodedPackIdViolation[] {
  if (!isPackIdScanTarget(relativePath) || forbiddenIds.length === 0) return []
  const normalized = relativePath.split(sep).join('/')
  const pattern = buildIdPattern(forbiddenIds)
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
    pattern.lastIndex = 0
    for (const match of lineText.matchAll(pattern)) {
      violations.push({
        line: index + 1,
        packId: match[0],
        path: normalized,
      })
    }
  }
  return violations
}

export function findHardcodedPackIdViolations(root: string = REPOSITORY_ROOT): HardcodedPackIdViolation[] {
  const forbiddenIds = loadForbiddenPackAndTopicIds(root)
  const files = globSync('{apps,packages}/*/src/**/*.{ts,tsx}', { cwd: root })
    .map(item => item.split(sep).join('/'))
    .filter(isPackIdScanTarget)
    .sort()

  const violations: HardcodedPackIdViolation[] = []
  for (const relativePath of files) {
    const content = readFileSync(resolve(root, relativePath), 'utf8')
    violations.push(...scanSourceTextForHardcodedPackIds(relativePath, content, forbiddenIds))
  }
  return violations
}

const isMainEntry = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(import.meta.filename)

if (isMainEntry) {
  const root = resolve(import.meta.dirname, '..')
  const violations = findHardcodedPackIdViolations(root)
  if (violations.length === 0) {
    console.log('verify-no-hardcoded-pack-ids: zero hardcoded disease pack or topic IDs in production sources.')
  } else {
    console.error('verify-no-hardcoded-pack-ids: violations found:')
    for (const v of violations) {
      console.error(`  ${v.path}:${v.line}: forbidden hardcoded pack/topic ID '${v.packId}'`)
    }
    process.exitCode = 1
  }
}
