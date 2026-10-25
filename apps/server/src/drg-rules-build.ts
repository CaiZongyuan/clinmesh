import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { prepareDrgRulesPackage } from './infrastructure/reference-data/drg-rules-prepare.ts'

/** 维护期显式制包；仅读取指定来源，成功前不发布输出，也不配置运行库。 */
export async function buildDrgRulesPackageFromFiles(input: {
  source: string, tables: string, groups: string, output: string,
  release: string, sourceVersion: string, expectedSourceSha256: string,
}) {
  const [source, tables, groups] = await Promise.all([readFile(input.source, 'utf8'), readFile(input.tables, 'utf8'), readFile(input.groups, 'utf8')])
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  if (hash(source) !== input.expectedSourceSha256) throw new Error('DRG source sha256 identity mismatch')
  const sourceTables = z.object({ CC: z.record(z.string(), z.string()), MCC: z.record(z.string(), z.string()),
    CCE: z.record(z.string(), z.string()), SS_VALID: z.array(z.string()) }).parse(JSON.parse(tables))
  const files = prepareDrgRulesPackage({ jsText: source, groups: groups.split(/\r?\n/).filter(line => line.trim() !== '').map(line => JSON.parse(line)),
    complicationTables: sourceTables, releaseId: input.release, sourceVersion: input.sourceVersion,
    input: { openDrgJsSha256: hash(source), openDrgTablesSha256: hash(tables), r3GroupsSha256: hash(groups) } })
  const output = resolve(input.output)
  if (await stat(output).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error })) {
    throw new Error('DRG output already exists; use a new immutable release directory')
  }
  await mkdir(dirname(output), { recursive: true })
  const staging = await mkdtemp(join(dirname(output), `.${basename(output)}-`))
  try {
    for (const [name, content] of Object.entries(files)) await writeFile(join(staging, name), content, { flag: 'wx' })
    await rename(staging, output)
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error }
  return { output, manifest: JSON.parse(files['manifest.json']!) }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(['source', 'tables', 'groups', 'output', 'release', 'source-version', 'expected-source-sha256']
      .map(name => [name, { type: 'string' as const }])) })
    const options = z.object({ source: z.string().min(1), tables: z.string().min(1), groups: z.string().min(1), output: z.string().min(1),
      release: z.string().min(1), 'source-version': z.string().min(1), 'expected-source-sha256': z.string().regex(/^[a-f0-9]{64}$/) }).parse(values)
    const result = await buildDrgRulesPackageFromFiles({ ...options, sourceVersion: options['source-version'], expectedSourceSha256: options['expected-source-sha256'] })
    console.info(JSON.stringify({ output: result.output, schemaVersion: result.manifest.schemaVersion,
      inputs: result.manifest.inputs, coverage: { mdc: result.manifest.coverage.mdcCodes.length,
        adrg: result.manifest.coverage.adrgCodes.filter((code: string) => !code.includes('QY')).length, drg: result.manifest.coverage.drgCodes.length },
      files: result.manifest.files }))
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
