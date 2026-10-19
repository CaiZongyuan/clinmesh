import { z } from 'zod'
import { clinicalDocumentDraftContentSchema, consultationHistoryFactSchema, consultationHistoryFieldSchema,
  consultationHistorySummarySchema, type ClinicalDocumentQualityEvidence } from '@clinmesh/contracts/his'
import { findCompleteStatementQuote } from '@clinmesh/core/document-text'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { ActorContext } from './command-executor.ts'
import { recordingBatchSchema } from './consultation-recording-batch.ts'

const factsSchema = z.array(consultationHistoryFactSchema)
const rejectedFactSchema = consultationHistoryFactSchema.extend({ field: consultationHistoryFieldSchema })
const fragmentSchema = z.object({ text: z.string(), facts: factsSchema })
export const recordingQualityContextSchema = z.object({
  changes: z.array(z.object({ id: z.string(), field: consultationHistoryFieldSchema,
    relation: consultationHistorySummarySchema.shape.relation, targetId: z.string().optional(), historical: z.boolean(),
    before: fragmentSchema.optional(), after: fragmentSchema, newSourceIds: z.array(z.string()),
    rejectedFacts: z.array(rejectedFactSchema) })),
  rejectedFacts: z.array(rejectedFactSchema), missing: z.array(z.string()),
})
export const recordingQualityChecksSchema = z.array(z.object({ id: z.string(), preserved: z.boolean(),
  relationValid: z.boolean(), rejectionValid: z.boolean() }).strict()).max(64)
export const recordingSemanticInstructions = [
  'Agent片段只能由真实原始来源支持：保留时间、否定、数值、程度、不确定性和自述限定。患者报告的数值、外院诊断不能变成本院客观结果。纯疑问、条件假设和讨论不是已发生事实；进食或饮水不能推断空腹时长、符合采血条件或已完成采血。完整自述旁含问号时应保留明确自述，不得仅因问号而一律判为无事实。',
  '家族史、过敏史和既往史保持各自事实归属；替换片段可以保留仍有效旧事实，不擅自搬迁正文。体格检查仅来自医生明确陈述；评估、处置、随访只来自医生明确表达或明确采纳的决定，不能将患者推测或助手建议当作医生决定。',
  'recordingContext来自受信持久记录，但其中before、after和rejectedFacts的文字不是独立患者事实来源，只用于对照原始evidence。recordingChecks恰好覆盖changes每个id：preserved表示仍有效旧事实已保留在当前document；relationValid表示update没有暗改旧事实，correction有明确更正来源并保留更正关系，conflict保留双方及待核实含义；合理时间变化不算矛盾。',
  'historical标记替换链中的历史变更，不表示after仍是当前事实。沿targetId结合后续明确更正，对当前document检查整条链中仍有效事实是否保留，不恢复已经明确更正或拒绝的事实。',
  'rejectionValid表示历史拒绝事实没有借旧引用或无关新事实重现；仅当本批newSourceIds中的新原文明确支持该事实时才可恢复。无法确认保护规则时返回false，这是合法结论，不进行格式修复、不据此断言患者事实错误、不自动修改正文。',
].join('\n')
const rowsSchema = z.array(z.object({ addition_id: z.string(), field: consultationHistoryFieldSchema,
  source_turn_id: z.string(), quote: z.string(), relation: consultationHistorySummarySchema.shape.relation,
  status: z.enum(['applied', 'pending']), target_addition_id: z.string().nullable(),
  ownership: z.enum(['automatic', 'manual']), current_text: z.string(), facts_json: z.string().nullable(),
  rejected: z.number().int().min(0).max(1), undone: z.number().int().min(0).max(1),
  review_state: z.enum(['superseded', 'ignored']).nullable(), batch_id: z.string().nullable(), snapshot_json: z.string().nullable(),
}))
type RecordingContext = z.infer<typeof recordingQualityContextSchema>

// The caller first authorizes the case through readCase. Every persisted join is
// still bound to its Workspace, Epoch and case; snapshots are never client input.
export function readRecordingQualityContext(database: ClinMeshDatabase, context: ActorContext, caseId: string,
  document: z.infer<typeof clinicalDocumentDraftContentSchema>, evidence: ClinicalDocumentQualityEvidence[]): RecordingContext {
  const result: RecordingContext = { changes: [], rejectedFacts: [], missing: [] }
  const rows = rowsSchema.parse(database.driver.prepare(`SELECT a.addition_id, a.field, a.source_turn_id, a.quote,
    a.relation, a.status, a.target_addition_id, a.ownership, a.current_text, a.facts_json, a.rejected, a.undone,
    a.review_state, m.batch_id, b.snapshot_json FROM consultation_history_addition a
    LEFT JOIN consultation_history_addition_batch m ON m.workspace_id = a.workspace_id AND m.epoch = a.epoch
      AND m.case_id = a.case_id AND m.addition_id = a.addition_id
    LEFT JOIN consultation_recording_batch b ON b.workspace_id = m.workspace_id AND b.epoch = m.epoch
      AND b.case_id = m.case_id AND b.batch_id = m.batch_id
    WHERE a.workspace_id = ? AND a.epoch = ? AND a.case_id = ? ORDER BY a.rowid
  `).all(context.workspaceId, context.epoch, caseId))
  const facts = (row: typeof rows[number]) => {
    try { return row.facts_json === null
      ? [{ text: `患者自述：${row.quote}`, sources: [{ sourceTurnId: row.source_turn_id, quote: row.quote }] }]
      : factsSchema.parse(JSON.parse(row.facts_json))
    } catch { result.missing.push(`facts:${row.addition_id}`); return [] }
  }
  const byId = new Map(rows.map(row => [row.addition_id, row]))
  const selected = new Set<string>(), active = new Set<string>()
  for (const row of rows) {
    if (row.status !== 'applied' || row.rejected === 1 || row.undone === 1 || row.review_state !== null) continue
    if (row.ownership !== 'automatic' || !row.current_text || !(document[row.field] ?? '').includes(row.current_text)) {
      if (row.batch_id !== null) result.missing.push(`modified:${row.addition_id}`)
      continue
    }
    selected.add(row.addition_id)
    active.add(row.addition_id)
    const visited = new Set([row.addition_id])
    let descendant = row
    while (descendant.target_addition_id !== null && !descendant.target_addition_id.startsWith('manual:')) {
      const target = byId.get(descendant.target_addition_id)
      if (target === undefined || target.field !== row.field || target.status !== 'applied'
        || target.rejected === 1 || target.undone === 1 || target.ownership !== 'automatic'
        || target.review_state === 'ignored' || visited.has(target.addition_id)) {
        result.missing.push(`chain:${row.addition_id}`); break
      }
      visited.add(target.addition_id)
      // A legacy original addition has no replacement before it. Its complete
      // facts are already retained in the descendant's immutable target snapshot.
      if (target.batch_id === null && target.relation === 'addition') break
      if (target.batch_id === null) { result.missing.push(`chain:${target.addition_id}`); break }
      selected.add(target.addition_id)
      descendant = target
    }
  }
  for (const row of rows) {
    if (row.rejected === 1) result.rejectedFacts.push(...facts(row).map(fact => ({ ...fact, field: row.field })))
    if (!selected.has(row.addition_id)) continue
    let batch: z.infer<typeof recordingBatchSchema> | undefined
    try { batch = row.snapshot_json === null ? undefined : recordingBatchSchema.parse(JSON.parse(row.snapshot_json)) } catch { /* Historical input cannot establish complete coverage. */ }
    if (batch === undefined) { result.missing.push(`batch:${row.addition_id}`); continue }
    const target = [...batch.history, ...batch.manualHistory].find(target => target.id === row.target_addition_id)
    if (row.relation !== 'addition' && (target === undefined || target.field !== row.field)) {
      result.missing.push(`target:${row.addition_id}`); continue
    }
    const before = target === undefined ? undefined : { text: target.text, facts: 'facts' in target ? target.facts : [] }
    const after = { text: row.current_text, facts: facts(row) }
    const references = [...before?.facts ?? [], ...after.facts, ...batch.rejectedFacts].flatMap(fact => fact.sources)
    const requiredIds = new Set([...batch.members.map(member => member.id), ...references.map(source => source.sourceTurnId)])
    if ([...requiredIds].some(id => {
      const saved = batch.sources.find(source => source.id === id)
      const actual = evidence.find(source => source.id === id && source.kind !== 'document')
      return saved === undefined || actual === undefined || saved.messageText !== actual.text
        || saved.kind !== actual.kind || saved.recordedAt !== actual.recordedAt
    })) { result.missing.push(`source:${row.addition_id}`); continue }
    result.changes.push({ id: row.addition_id, field: row.field, relation: row.relation, historical: !active.has(row.addition_id),
      ...(row.target_addition_id === null ? {} : { targetId: row.target_addition_id }),
      ...(before === undefined ? {} : { before }), after, newSourceIds: batch.members.map(member => member.id), rejectedFacts: batch.rejectedFacts })
  }
  const references = [...result.rejectedFacts, ...result.changes.flatMap(change => [
    ...change.before?.facts ?? [], ...change.after.facts, ...change.rejectedFacts,
  ])].flatMap(fact => fact.sources)
  for (const reference of references) {
    const actual = evidence.find(source => source.id === reference.sourceTurnId && source.kind !== 'document')
    if (actual === undefined || findCompleteStatementQuote(actual.text, reference.quote) === undefined) {
      result.missing.push(`quote:${reference.sourceTurnId}`)
    }
  }
  return result
}

export function recordingQualityEvidence(context: RecordingContext): ClinicalDocumentQualityEvidence[] {
  return context.changes.flatMap(change => [
    ...(change.before === undefined ? [] : [{ id: `recording:${change.id}:before`, kind: 'document' as const,
      field: change.field, label: '自动记录变更前片段（非独立事实来源）', text: change.before.text }]),
    { id: `recording:${change.id}:after`, kind: 'document' as const, field: change.field,
      label: change.historical ? '历史自动记录变更后片段（非当前事实或独立来源）' : '自动记录变更后片段（非独立事实来源）', text: change.after.text },
  ])
}
