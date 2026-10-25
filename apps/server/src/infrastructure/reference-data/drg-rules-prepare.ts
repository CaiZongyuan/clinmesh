import { createHash } from 'node:crypto'
import { buildDrgRules } from './drg-rules-builder.ts'
import { extractOfficialProgram } from './drg-opendrg-extract.ts'
import { drgRulesManifestSchema, type DrgRulesPackageFiles } from './drg-rules-package.ts'

/** 离线维护边界；编译器不进入服务启动装载路径。 */
export function prepareDrgRulesPackage(input: {
  groups: readonly unknown[]
  jsText: string
  complicationTables: { CC: Record<string, string>, MCC: Record<string, string>, CCE: Record<string, string>, SS_VALID?: string[] }
  input: { openDrgJsSha256: string, openDrgTablesSha256: string, r3GroupsSha256: string }
  releaseId: string
  sourceVersion: string
}): DrgRulesPackageFiles {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  if (hash(input.jsText) !== input.input.openDrgJsSha256) throw new Error('DRG source sha256 identity mismatch')
  const rules = buildDrgRules({ ...input, program: extractOfficialProgram(input.jsText), rulesId: input.releaseId, version: input.sourceVersion })
  const files = {
    'groups.jsonl': `${input.groups.map(row => JSON.stringify(row)).join('\n')}\n`,
    'program.json': `${JSON.stringify(rules.program)}\n`,
  }
  const manifest = drgRulesManifestSchema.parse({
    schemaVersion: 'clinmesh.drg-rules.v2', releaseId: input.releaseId, sourceVersion: input.sourceVersion,
    inputs: input.input, coverage: rules.program.coverage,
    applicability: 'simulation-source-equivalence-only',
    files: Object.entries(files).map(([path, content]) => ({ path, sha256: hash(content),
      rows: content.split('\n').filter(line => line.trim() !== '').length })),
  })
  return { 'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`, ...files }
}
