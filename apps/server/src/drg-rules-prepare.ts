import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { loadDrgRules, prepareDrgRulesPackage } from './infrastructure/reference-data/drg-rules-package.ts'

const sourceFileSchema = z.object({
  path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
const sourceLockSchema = z.object({
  schemaVersion: z.literal('clinmesh.drg-rules-source.v1'),
  releaseId: z.string().min(1), sourceVersion: z.string().min(1),
  inputs: z.object({ groups: sourceFileSchema, js: sourceFileSchema, tables: sourceFileSchema }).strict(),
}).strict()
const complicationTablesSchema = z.object({
  CC: z.record(z.string(), z.string()), MCC: z.record(z.string(), z.string()), CCE: z.record(z.string(), z.string()),
})

function sha256(content: string): string { return createHash('sha256').update(content).digest('hex') }

async function lockedInput(root: string, file: z.infer<typeof sourceFileSchema>): Promise<string> {
  if (isAbsolute(file.path)) throw new Error('DRG source path must be relative')
  const base = await realpath(root)
  const target = await realpath(resolve(base, file.path))
  const contained = relative(base, target)
  if (contained === '' || contained === '..' || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    throw new Error('DRG source path escapes its input root')
  }
  const content = await readFile(target, 'utf8')
  if (sha256(content) !== file.sha256) throw new Error(`DRG input checksum mismatch: ${file.path}`)
  return content
}

/** 只物化并核验锁定的离线输入；不执行上游程序、不生成启用审核。 */
export async function runDrgRulesPrepare(input: {
  inputRoot: string
  outputDirectory: string
  sourceLockPath?: string
}) {
  const sourceLockPath = input.sourceLockPath ?? join(import.meta.dirname, '../reference-data/drg-rules-source.lock.json')
  const source = sourceLockSchema.parse(JSON.parse(await readFile(sourceLockPath, 'utf8')))
  const [groupsText, jsText, tablesText] = await Promise.all([
    lockedInput(input.inputRoot, source.inputs.groups), lockedInput(input.inputRoot, source.inputs.js),
    lockedInput(input.inputRoot, source.inputs.tables),
  ])
  const files = prepareDrgRulesPackage({
    groups: groupsText.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line)),
    jsText, complicationTables: complicationTablesSchema.parse(JSON.parse(tablesText)),
    input: { openDrgJsSha256: source.inputs.js.sha256, openDrgTablesSha256: source.inputs.tables.sha256,
      r3GroupsSha256: source.inputs.groups.sha256 }, releaseId: source.releaseId, sourceVersion: source.sourceVersion,
  })
  const outputDirectory = resolve(input.outputDirectory)
  const result = { outputDirectory, releaseId: source.releaseId, sourceVersion: source.sourceVersion,
    manifestSha256: sha256(files['manifest.json']!), runtimeEnabled: false as const }
  let existingManifest: string | undefined
  try { existingManifest = await readFile(join(outputDirectory, 'manifest.json'), 'utf8') } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  if (existingManifest !== undefined) {
    if (existingManifest !== files['manifest.json']) throw new Error('DRG output already contains a different rules package')
    await loadDrgRules(outputDirectory)
    return { status: 'already-prepared' as const, ...result }
  }
  await mkdir(dirname(outputDirectory), { recursive: true })
  const staging = await mkdtemp(join(dirname(outputDirectory), '.drg-rules-'))
  try {
    for (const [name, content] of Object.entries(files)) await writeFile(join(staging, name), content, 'utf8')
    await loadDrgRules(staging)
    await rename(staging, outputDirectory)
  } finally { await rm(staging, { recursive: true, force: true }) }
  return { status: 'prepared' as const, ...result }
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--input-root' || args[2] !== '--output-directory' || !args[1] || !args[3]) {
    throw new Error('Usage: drg:rules:prepare --input-root <offline-root> --output-directory <versioned-package-directory>')
  }
  console.info(JSON.stringify(await runDrgRulesPrepare({ inputRoot: args[1], outputDirectory: args[3] })))
}
