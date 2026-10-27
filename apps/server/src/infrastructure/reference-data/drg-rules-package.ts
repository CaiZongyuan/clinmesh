import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { DrgRules } from '@clinmesh/contracts/drg'
import { drgProgramSchema } from '@clinmesh/contracts/drg-program'
import { buildDrgRules } from './drg-rules-builder.ts'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const drgRulesManifestSchema = z.object({
  schemaVersion: z.literal('clinmesh.drg-rules.v2'),
  releaseId: z.string().min(1), sourceVersion: z.string().min(1),
  inputs: z.object({ openDrgJsSha256: hash, openDrgTablesSha256: hash, r3GroupsSha256: hash }).strict(),
  coverage: drgProgramSchema.shape.coverage,
  applicability: z.literal('simulation-source-equivalence-only'),
  files: z.array(z.object({ path: z.enum(['program.json', 'groups.jsonl']), sha256: hash,
    rows: z.number().int().nonnegative() }).strict()).length(2),
}).strict().refine(manifest => new Set(manifest.files.map(file => file.path)).size === 2, 'duplicate DRG rules files')

const verifiedCheckSchema = z.object({
  status: z.literal('verified'),
  evidence: z.array(z.string().trim().min(1)).min(1),
}).strict()

/** 受信部署配置中的人工核验记录；完整性检查不能生成或代替这些结论。 */
export const drgRulesReviewSchema = z.object({
  schemaVersion: z.literal('clinmesh.drg-rules-review.v1'),
  scope: z.literal('hospital-simulation'),
  releaseId: z.string().min(1),
  sourceVersion: z.string().min(1),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  referenceReleaseId: z.string().min(1),
  reviewedBy: z.string().trim().min(1),
  reviewedAt: z.iso.datetime(),
  checks: z.object({
    usageTerms: verifiedCheckSchema,
    codingCompatibility: verifiedCheckSchema,
    sourceApplicability: verifiedCheckSchema,
    algorithmValidation: verifiedCheckSchema,
  }).strict(),
}).strict()

export interface DrgRulesPackageFiles extends Record<string, string> {}

async function containedPath(directory: string, path: string): Promise<string> {
  if (isAbsolute(path) || path.split(/[\\/]/).some(part => part === '..' || part === '')) {
    throw new Error('DRG rules package path must be a contained relative path')
  }
  const base = await realpath(directory)
  const target = await realpath(resolve(base, path))
  const inside = relative(base, target)
  if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`) || inside === '') {
    throw new Error('DRG rules package path escapes its directory')
  }
  return target
}

/** 服务启动仅读取完整v2声明式程序；缺条件的v1规则必须重新准备。 */
async function loadManifestRules(directory: string, manifest: z.infer<typeof drgRulesManifestSchema>): Promise<DrgRules> {
  const contents: Record<string, string> = {}
  for (const file of manifest.files) {
    const content = await readFile(await containedPath(directory, file.path), 'utf8')
    if (createHash('sha256').update(content).digest('hex') !== file.sha256) throw new Error(`DRG rules package checksum mismatch: ${file.path}`)
    const rows = content.split('\n').filter(line => line.trim() !== '').length
    if (rows !== file.rows) throw new Error(`DRG rules package row count mismatch: ${file.path}`)
    contents[file.path] = content
  }
  const groups = contents['groups.jsonl']!.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
  const rules = buildDrgRules({ groups, program: JSON.parse(contents['program.json']!), rulesId: manifest.releaseId, version: manifest.sourceVersion })
  const { program } = rules
  if (program.coverage.sourceSha256 !== manifest.inputs.openDrgJsSha256
    || JSON.stringify(program.coverage) !== JSON.stringify(manifest.coverage)) throw new Error('DRG rules package source coverage mismatch')
  return rules
}

/** 仅验证物化数据完整性，供离线制包与受控测试使用；不表示来源已获运行批准。 */
export async function loadDrgRules(directory: string): Promise<DrgRules> {
  const manifest = drgRulesManifestSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')))
  return loadManifestRules(directory, manifest)
}

export async function loadReviewedDrgRules(input: {
  directory: string
  reviewPath: string
  referenceReleaseId: string | undefined
}): Promise<DrgRules> {
  const review = drgRulesReviewSchema.parse(JSON.parse(await readFile(input.reviewPath, 'utf8')))
  if (review.referenceReleaseId !== input.referenceReleaseId) throw new Error('DRG review reference release mismatch')
  const manifestText = await readFile(join(input.directory, 'manifest.json'), 'utf8')
  if (createHash('sha256').update(manifestText).digest('hex') !== review.manifestSha256) throw new Error('DRG review manifest checksum mismatch')
  const manifest = drgRulesManifestSchema.parse(JSON.parse(manifestText))
  if (review.releaseId !== manifest.releaseId || review.sourceVersion !== manifest.sourceVersion) {
    throw new Error('DRG review rules release mismatch')
  }
  return loadManifestRules(input.directory, manifest)
}
