import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { drgRulesSchema, type DrgRules } from '@clinmesh/contracts/drg'
import { buildDrgRules } from './drg-rules-builder.ts'
import { extractOfficialMembers } from './drg-opendrg-extract.ts'

/**
 * DRG 规则数据包：官方分组器提取产物 + 官方层级投影 + OpenDRG 三表的物化形态。
 * prepare 在运维期执行（读取 OpenDRG JS 做文本解析，不执行 JS 本体）；
 * load 在服务启动期执行（只读 jsonl/json，校验 sha256 与行数）。
 */

const manifestSchema = z.object({
  schemaVersion: z.literal('clinmesh.drg-rules.v1'),
  releaseId: z.string().min(1),
  sourceVersion: z.string().min(1),
  inputs: z.object({
    openDrgJsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    openDrgTablesSha256: z.string().regex(/^[a-f0-9]{64}$/),
    r3GroupsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  extraction: z.object({
    medicalAdrgCount: z.number().int().nonnegative(),
    surgicalAdrgCount: z.number().int().nonnegative(),
    comboOperationAdrgs: z.array(z.string()),
  }).strict(),
  files: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    rows: z.number().int().nonnegative(),
  }).strict()).min(1),
}).strict()

export interface DrgRulesPackageFiles extends Record<string, string> {}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function jsonlRows(rows: readonly unknown[]): string {
  return `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
}

export function prepareDrgRulesPackage(input: {
  groups: readonly unknown[]
  jsText: string
  complicationTables: { CC: Record<string, string>, MCC: Record<string, string>, CCE: Record<string, string> }
  input: { openDrgJsSha256: string, openDrgTablesSha256: string, r3GroupsSha256: string }
  releaseId: string
  sourceVersion: string
}): DrgRulesPackageFiles {
  const officialMembers = extractOfficialMembers(input.jsText)
  const rules = buildDrgRules({
    groups: input.groups, officialMembers,
    // 物化文件保留 OpenDRG 原始大写键；构建器合同为小写。
    complicationTables: { cc: input.complicationTables.CC, mcc: input.complicationTables.MCC, cce: input.complicationTables.CCE },
    rulesId: input.releaseId, version: input.sourceVersion,
  })
  const memberRows = [
    ...Object.entries(officialMembers.medical).flatMap(([adrgCode, codes]) => codes.map(code => ({ adrgCode, chapter: 'medical', code }))),
    ...Object.entries(officialMembers.surgical).flatMap(([adrgCode, codes]) => codes.map(code => ({ adrgCode, chapter: 'surgical', code }))),
  ]
  // 规则包只物化运行时三表（CC/MCC/CCE）；SS_VALID 等源包事实由离线参考 inventory 登记保管。
  const ruleTables = { CC: input.complicationTables.CC, MCC: input.complicationTables.MCC, CCE: input.complicationTables.CCE }
  const files = {
    'groups.jsonl': jsonlRows(input.groups),
    'members.jsonl': jsonlRows(memberRows),
    'complication-tables.json': `${JSON.stringify(ruleTables)}\n`,
  }
  const manifest = {
    schemaVersion: 'clinmesh.drg-rules.v1',
    releaseId: input.releaseId,
    sourceVersion: input.sourceVersion,
    inputs: input.input,
    extraction: officialMembers.stats,
    files: Object.entries(files).map(([path, content]) => ({
      path,
      rows: content.split('\n').filter(line => line.trim() !== '').length,
      sha256: sha256(content),
    })),
  }
  return { 'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`, ...files }
}

async function containedPath(directory: string, path: string): Promise<string> {
  if (isAbsolute(path) || path.split('/').some(part => part === '..' || part === '')) {
    throw new Error('DRG rules package path must be a contained relative path')
  }
  const base = await realpath(directory)
  const target = await realpath(resolve(base, path))
  if (relative(base, target).startsWith(`..${sep}`) || relative(base, target) === '') {
    throw new Error('DRG rules package path escapes its directory')
  }
  return target
}

export async function loadDrgRules(directory: string): Promise<DrgRules> {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')))
  const contents: Record<string, string> = {}
  for (const file of manifest.files) {
    const content = await readFile(await containedPath(directory, file.path), 'utf8')
    if (sha256(content) !== file.sha256) throw new Error(`DRG rules package checksum mismatch: ${file.path}`)
    const rows = content.split('\n').filter(line => line.trim() !== '').length
    if (rows !== file.rows) throw new Error(`DRG rules package row count mismatch: ${file.path}`)
    contents[file.path] = content
  }
  const groups = z.array(z.unknown()).parse(
    (contents['groups.jsonl'] ?? '').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line)),
  )
  const rawTables = z.object({ CC: z.record(z.string(), z.string()), MCC: z.record(z.string(), z.string()),
    CCE: z.record(z.string(), z.string()) }).strict().parse(JSON.parse(contents['complication-tables.json'] ?? '{}'))
  // 成员直接取物化行，避免加载期重复解析官方 JS。
  const medical: Record<string, string[]> = {}
  const surgical: Record<string, string[]> = {}
  for (const line of (contents['members.jsonl'] ?? '').split('\n').filter(line => line.trim() !== '')) {
    const row = z.object({ adrgCode: z.string().min(1), chapter: z.enum(['medical', 'surgical']),
      code: z.string().min(1) }).strict().parse(JSON.parse(line))
    const target = row.chapter === 'medical' ? medical : surgical
    target[row.adrgCode] = [...(target[row.adrgCode] ?? []), row.code]
  }
  return drgRulesSchema.parse(buildDrgRules({ groups, officialMembers: { medical, surgical },
    complicationTables: { cc: rawTables.CC, mcc: rawTables.MCC, cce: rawTables.CCE },
    rulesId: manifest.releaseId, version: manifest.sourceVersion }))
}
