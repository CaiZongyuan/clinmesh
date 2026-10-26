import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { canonicalJsonHash } from './application/scenario-data/canonical-json.ts'
import { createDrgIndependentVerificationCases, createDrgProgramOracle, createDrgSourceVerificationCases,
  inspectDrgProgramSource, lockedOpenDrg30SourceSha256, verifyDrgProgramCases } from './infrastructure/reference-data/drg-program-verification.ts'

const tablesSchema = z.object({ CC: z.record(z.string(), z.string()), MCC: z.record(z.string(), z.string()),
  CCE: z.record(z.string(), z.string()), SS_VALID: z.array(z.string()) }).strict()

/** 显式离线功能核验；只读取锁定来源、创建独立报告，不访问业务数据库。 */
export async function runDrgRulesVerificationCli(args: string[]): Promise<{ exitCode: number, summary: unknown }> {
  const { values } = parseArgs({ args, allowPositionals: false, strict: true, options: {
    source: { type: 'string' }, tables: { type: 'string' }, report: { type: 'string' }, program: { type: 'string' }, rules: { type: 'string' },
  } })
  if (values.source === undefined || values.tables === undefined || values.report === undefined) {
    throw new Error('Usage: drg-rules-verify --source <锁定原程序.js> --tables <chs_drg_30.json> --report <新报告.json> [--program <新规则程序.json>] [--rules <已物化规则包目录>]')
  }
  const [source, tableBytes] = await Promise.all([readFile(resolve(values.source), 'utf8'), readFile(resolve(values.tables), 'utf8')])
  const oracle = createDrgProgramOracle(source, lockedOpenDrg30SourceSha256)
  const tables = tablesSchema.parse(JSON.parse(tableBytes))
  const { compileDrgProgram } = await import('./infrastructure/reference-data/drg-program-compiler.ts')
  const { evaluateDrgProgram } = await import('./application/drg-program.ts')
  const compiled = compileDrgProgram(source)
  const loaded = values.rules === undefined ? null : await (await import('./infrastructure/reference-data/drg-rules-package.ts')).loadDrgRules(resolve(values.rules))
  const program = loaded?.program ?? compiled
  if (canonicalJsonHash(compiled) !== canonicalJsonHash(program)) throw new Error('Materialized DRG program differs from the complete source compilation')
  const { groupDrgCase } = await import('./application/drg-grouping.ts')
  if (canonicalJsonHash(tables) !== canonicalJsonHash({ CC: program.complications.cc, MCC: program.complications.mcc,
    CCE: program.complications.cce, SS_VALID: program.validOperations })) throw new Error('OpenDRG parameter tables disagree with the locked source program')
  const programBytes = `${JSON.stringify(program)}\n`
  const inventory = inspectDrgProgramSource(source)
  const report = verifyDrgProgramCases({ sourceSha256: lockedOpenDrg30SourceSha256, oracle,
    cases: [...createDrgIndependentVerificationCases(), ...createDrgSourceVerificationCases(source, tables)],
    evaluate: input => loaded === null ? evaluateDrgProgram(program, input) : groupDrgCase(loaded, input), inventory })
  const originalCodes = new Set(inventory.terminals.map(terminal => terminal.code))
  const compiledCodes = new Set(program.coverage.drgCodes)
  const missingCompiledCodes = [...originalCodes].filter(code => !compiledCodes.has(code))
  const unexpectedCompiledCodes = [...compiledCodes].filter(code => !originalCodes.has(code))
  const artifact = { ...report, sourceTablesSha256: createHash('sha256').update(tableBytes).digest('hex'),
    programSha256: createHash('sha256').update(programBytes).digest('hex'),
    rulesIdentity: loaded === null ? null : { rulesId: loaded.rulesId, version: loaded.version },
    corpusVersion: 'clinmesh.drg-source-cases.v1', missingCompiledCodes, unexpectedCompiledCodes }
  await mkdir(dirname(resolve(values.report)), { recursive: true })
  await writeFile(resolve(values.report), `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' })
  if (values.program !== undefined) {
    await mkdir(dirname(resolve(values.program)), { recursive: true })
    await writeFile(resolve(values.program), programBytes, { flag: 'wx' })
  }
  const complete = report.mismatchCount === 0 && report.coverage.unselectedDrgCodes.length === 0
    && report.coverage.unexplainedRouteCodes.length === 0 && missingCompiledCodes.length === 0 && unexpectedCompiledCodes.length === 0
  return { exitCode: complete ? 0 : 1, summary: { report: resolve(values.report), sourceSha256: report.sourceSha256,
    caseCount: report.caseCount, mismatchCount: report.mismatchCount,
    selectedDrgCount: report.coverage.selectedDrgCodes.length, sourceDrgCount: originalCodes.size,
    unselectedDrgCodes: report.coverage.unselectedDrgCodes, unmatchedRouteCodes: report.coverage.unmatchedRouteCodes,
    shadowedRoutes: inventory.shadowedRoutes, unexplainedRouteCodes: report.coverage.unexplainedRouteCodes,
    terminalPredicateClassCount: report.coverage.terminalPredicateClasses.length, missingCompiledCodes, unexpectedCompiledCodes } }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runDrgRulesVerificationCli(process.argv.slice(2))
    console.info(JSON.stringify(result.summary, null, 2))
    process.exitCode = result.exitCode
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
