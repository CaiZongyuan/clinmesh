import { z } from 'zod'
import { clinicalDocumentFieldSchema, type ClinicalDocumentQualityEvidence } from '@clinmesh/contracts/his'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { ActorContext } from './command-executor.ts'

export const qualitySourceContextSchema = z.object({
  triage: z.object({ evidenceId: z.literal('clinical:triage'), recordId: z.string(), version: z.number().int().positive(),
    derivedProjection: z.literal('clinical:presentation') }).optional(),
  availability: z.array(z.object({ evidenceId: z.string(), availableAt: z.string() })),
})
export const qualityDocumentContextSchema = z.object({
  savedVersion: z.number().int().nonnegative(), savedAt: z.string().optional(), savedBy: z.string().optional(),
  changedFields: z.array(clinicalDocumentFieldSchema),
})

export const qualitySourceInstructions = [
  'sourceContext标明原始来源及派生关系：分诊初记是初始观察，clinical:presentation只是同一分诊记录的派生摘要，不能当成另一份独立佐证。保留分诊独有的生命体征；不能因存在新病历就整体排除初记。',
  'recordedAt是来源的业务记录时间，availability.availableAt仅在有实际保存时间时提供；缺失时间保持未知，不能按来源排列、保存先后或文书版本自动判断谁正确。',
  'documentContext只说明待检查文书的保存版本、保存者、保存时间及相对保存稿的改动字段，不是独立临床事实，也不表示医生已经核实。不得将document复制为doctor来源来证明自身正确。',
  '主诉不要求与分诊逐字一致：同义改写、合理概括、有原始来源的补充和不同时间的合理变化不算事实冲突。明确更正必须由实际患者问诊、医生补充或recordingContext可追溯关系支持，不能只凭编辑过、较晚保存或措辞变化推定更正。',
  '同时间、同语境且尚未解释的实质互斥仍须提示，包括医生编辑后的正文与患者明确否认胸痛相冲突。message指出具体冲突事实，suggestion给出最小核对动作，不使用笼统的“主诉有区别”或要求两版文字一致。',
].join('\n')

// readCase authorizes this read first. Historical missing timestamps stay missing.
export function readQualityInputContext(database: ClinMeshDatabase, context: ActorContext, caseId: string,
  evidence: ClinicalDocumentQualityEvidence[]) {
  const binding = [context.workspaceId, context.epoch, caseId]
  const triage = z.object({ triage_id: z.string(), version: z.number().int().positive(), recorded_at: z.string() }).optional()
    .parse(database.driver.prepare(`SELECT triage_id, version, recorded_at FROM triage_record
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?`).get(...binding))
  const initial = evidence.find(item => item.id === 'clinical:triage')
  if (initial !== undefined && triage !== undefined) {
    initial.label = '分诊初记'
    initial.recordedAt = triage.recorded_at
    initial.reference = `triage:${triage.triage_id}:${triage.version}`
  }
  const availability = z.array(z.object({ source_id: z.string(), saved_at: z.string() }))
    .parse(database.driver.prepare(`SELECT source_id, saved_at FROM consultation_recording_source
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND saved_at IS NOT NULL ORDER BY source_id`).all(...binding))
    .filter(row => evidence.some(item => item.id === row.source_id))
    .map(row => ({ evidenceId: row.source_id, availableAt: row.saved_at }))
  const saved = z.object({ updated_by: z.string() }).optional().parse(database.driver.prepare(`
    SELECT updated_by FROM clinical_document_draft WHERE workspace_id = ? AND epoch = ? AND case_id = ?`).get(...binding))
  return {
    sourceContext: { availability, ...(initial === undefined || triage === undefined ? {} : { triage: {
      evidenceId: 'clinical:triage' as const, recordId: triage.triage_id, version: triage.version,
      derivedProjection: 'clinical:presentation' as const,
    } }) },
    savedBy: saved?.updated_by,
  }
}
