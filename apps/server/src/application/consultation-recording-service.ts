import {
  clinicalDocumentDraftContentSchema,
  consultationHistoryAdditionSchema,
  consultationHistoryFactSchema,
  consultationRecordingSourceSchema,
  consultationRecordingErrorCodeSchema,
  consultationRecordingSchema,
} from '@clinmesh/contracts/his'
import { hasStatementBoundaries, trackDocumentFragment } from '@clinmesh/core/document-text'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import { ChatCompletionsError, type JsonChatCompletionsProvider } from '../infrastructure/ai/openai-chat-completions.ts'
import type { ActorContext, CommandExecutor, CommandTransaction } from './command-executor.ts'
import type { GenerationModelBinding } from './generation-model-binding.ts'
import type { OutboxHandlerInput, OutboxHandlerResult } from './outbox-dispatcher.ts'
import { WorkflowError } from './workflow-error.ts'
import type { QualityAgentFact } from './clinical-document-quality.ts'
import { historySummaryOutputSchema, historySummaryPrompt, validateHistorySummaries, RecordingSourceError, recordingSourceDiagnosticSchema,
  summaryText, verifyHistorySummaries, type HistoryFact, type HistorySummary, type RejectedHistoryFact } from './consultation-history-summary.ts'

const contextSchema = z.object({
  agentGrantId: z.uuid().optional(),
  actorId: z.string().min(1), workspaceId: z.string().min(1), epoch: z.string().min(1),
  scenarioRunId: z.string().min(1), roleCode: z.literal('outpatient-doctor'),
  practitionerId: z.string().min(1), practitionerRoleId: z.string().min(1),
  organizationId: z.string().min(1), locationId: z.string().min(1),
}).strict().transform(({ agentGrantId, ...context }) => ({
  ...context, ...(agentGrantId === undefined ? {} : { agentGrantId }),
}))
const jobSchema = z.object({
  case_id: z.string(), encounter_id: z.string(), actor_context_json: z.string(),
  status: z.enum(['queued', 'completed', 'failed']),
  generation: z.number().int().positive(),
})
const recordingStateSchema = z.object({ version: z.number().int().positive(), paused: z.number().int().min(0).max(1),
  start_sequence: z.number().int().positive(), actor_context_json: z.string().nullable() })
const sourceRowSchema = z.object({ source_id: z.string(), source_kind: consultationRecordingSourceSchema.shape.kind,
  message_text: z.string(), recorded_at: z.string(), metadata_json: z.string() })
const sourceMetadataSchema = consultationRecordingSourceSchema.omit({ id: true, kind: true, messageText: true, recordedAt: true })
const orderedJobsSchema = z.array(z.object({ turn_id: z.string(), status: jobSchema.shape.status,
  generation: jobSchema.shape.generation, scheduled: z.number().int().min(0).max(1),
  error_code: consultationRecordingErrorCodeSchema.nullable() }))
const draftSchema = z.object({ content_json: z.string(), version: z.number().int().positive() })
const failureDiagnosticSchema = recordingSourceDiagnosticSchema.partial({ reason: true }).extend({
  stage: z.enum(['summary', 'verification', 'apply']),
})
// Decode historical receipts without exposing removed review fields or pending suggestions.
const recordingReceiptSchema = consultationRecordingSchema.extend({
  status: z.enum([...consultationRecordingSchema.shape.status.options, 'pending']),
  additions: z.array(consultationRecordingSchema.shape.additions.element.extend({
    status: z.enum(['applied', 'pending', 'superseded', 'ignored', 'undone']),
    reviewStatus: z.enum(['unreviewed', 'confirmed', 'undo-pending']).optional(),
    reviewable: z.boolean().optional(),
  }).transform(({ reviewStatus: _reviewStatus, reviewable: _reviewable, ...addition }) => ({
    ...addition, status: addition.status === 'pending' ? 'superseded' as const : addition.status,
  }))),
}).transform(recording => ({ ...recording, status: recording.status === 'pending' ? 'processing' as const : recording.status }))
const additionRowsSchema = z.array(z.object({
  addition_id: z.string(), field: consultationHistoryAdditionSchema.shape.field,
  source_turn_id: z.string(), quote: z.string(), relation: consultationHistoryAdditionSchema.shape.relation,
  status: z.enum(['applied', 'pending']),
  target_addition_id: z.string().nullable(),
  ownership: z.enum(['automatic', 'manual']),
  start_offset: z.number().int().nonnegative().nullable(), end_offset: z.number().int().nonnegative().nullable(),
  current_text: z.string(), review_state: z.enum(['superseded', 'ignored']).nullable(),
  review_status: z.enum(['unreviewed', 'confirmed', 'undo-pending']),
  rejected: z.number().int().min(0).max(1), undone: z.number().int().min(0).max(1),
  inverse_text: z.string().nullable(),
  facts_json: z.string().nullable(),
}))

type Addition = HistorySummary & { sourceTurnId: string; quote: string }
type Draft = z.infer<typeof clinicalDocumentDraftContentSchema>
type HistoryRow = z.infer<typeof additionRowsSchema>[number]
interface ManualFragment { id: string; field: Addition['field']; text: string; start: number; end: number }
const manualTargetPrefix = 'manual:'

function rowFacts(row: HistoryRow) {
  return row.facts_json === null ? [] : z.array(consultationHistoryFactSchema).min(1).max(12).parse(JSON.parse(row.facts_json))
}

function rowText(row: HistoryRow): string {
  return row.facts_json === null ? `患者自述：${row.quote}` : summaryText(rowFacts(row))
}

function historyEvidenceKey(field: HistorySummary['field'], source: HistoryFact['sources'][number]): string {
  return JSON.stringify([field, source.sourceTurnId, normalizeQuoteEnding(source.quote)])
}

function historyFacts(row: HistoryRow): HistoryFact[] {
  return row.facts_json === null ? [{ text: rowText(row), sources: [{ sourceTurnId: row.source_turn_id, quote: row.quote }] }]
    : rowFacts(row)
}

function historyEvidence(rows: HistoryRow[]) {
  const rejectedFacts: RejectedHistoryFact[] = rows.filter(row => row.rejected === 1)
    .flatMap(row => historyFacts(row).map(fact => ({ ...fact, field: row.field })))
  const rejected = new Set(rejectedFacts.flatMap(fact => fact.sources.map(source => historyEvidenceKey(fact.field, source))))
  const active = new Set(rows.filter(row => row.undone === 0
    && row.review_state === null && row.rejected === 0)
    .flatMap(row => historyFacts(row).flatMap(fact => fact.sources.map(source => historyEvidenceKey(row.field, source)))))
  return { rejectedFacts, rejected, blocked: new Set([...rejected].filter(key => !active.has(key))) }
}

function removeRejectedHistorySources(additions: HistorySummary[], blocked: ReadonlySet<string>): HistorySummary[] {
  return additions.flatMap(addition => {
    const facts = addition.facts.flatMap(fact => {
      const sources = fact.sources.filter(source => !blocked.has(historyEvidenceKey(addition.field, source)))
      return sources.length === 0 ? [] : [{ ...fact, sources }]
    })
    return facts.length === 0 ? [] : [{ ...addition, facts }]
  })
}

function hasNewHistoryEvidence(addition: HistorySummary, turnId: string, rejected: ReadonlySet<string>): boolean {
  return addition.facts.some(fact => fact.sources.some(source => source.sourceTurnId === turnId
    && !rejected.has(historyEvidenceKey(addition.field, source))))
}

function isHistoryRange(row: HistoryRow, text: string, start: number, end: number): boolean {
  if (row.facts_json === null) return isCompleteStatementRange(text, start, end)
  return hasStatementBoundaries(text, start, end) && (row.ownership !== 'manual'
    || statements(text.slice(start, end)).length <= rowFacts(row).flatMap(fact => statements(fact.text)).length)
}

function statements(quote: string): string[] {
  return (quote.match(/.*?(?:[。！？!?；;\n]+|$)/gs) ?? []).map(text => text.trim()).filter(Boolean)
}

function isCompleteStatementRange(text: string, start: number, end: number): boolean {
  return statements(text.slice(start, end)).length === 1 && hasStatementBoundaries(text, start, end)
}

function normalizeQuoteEnding(quote: string): string {
  return quote.replace(/[。！？!?；;\s]+$/u, '')
}

function recoverLegacyHistoryRows(rows: HistoryRow[], document: Draft): HistoryRow[] {
  const fragments: HistoryRow[] = []
  const recovered = rows.map(row => {
    if (row.status !== 'applied' || row.undone === 1 || row.review_state !== null || row.start_offset !== null) return row
    const text = rowText(row)
    const field = document[row.field] ?? ''
    const start = field.indexOf(text)
    const quotes = row.facts_json === null ? statements(row.quote) : [row.quote]
    if (start < 0 || field.indexOf(text, start + text.length) >= 0
      || quotes.length === 0 || quotes.some(quote => !consultationHistoryAdditionSchema.shape.quote.safeParse(quote).success)) {
      return row.ownership === 'manual' ? row : { ...row, ownership: 'manual' as const }
    }
    if (quotes.length === 1) return { ...row, start_offset: start, end_offset: start + text.length, current_text: text }
    let cursor = '患者自述：'.length
    for (const [index, quote] of quotes.entries()) {
      const offset = text.indexOf(quote, cursor)
      const fragmentStart = index === 0 ? start : start + offset
      const fragment = index === 0 ? text.slice(0, offset + quote.length) : quote
      fragments.push({ ...row, addition_id: createHash('sha256').update(JSON.stringify([row.addition_id, index, quote])).digest('hex'),
        quote, start_offset: fragmentStart, end_offset: fragmentStart + fragment.length, current_text: fragment })
      cursor = offset + quote.length
    }
    return { ...row, review_state: 'superseded' as const }
  })
  // Query and Command must expose the same IDs without making reads persist recovery.
  return [...recovered, ...fragments]
}


export class ConsultationRecordingService {
  readonly #database: ClinMeshDatabase
  readonly #commands: CommandExecutor
  readonly #enabled: boolean
  readonly #assertAccess: (context: ActorContext, encounterId: string) => { caseId: string; editable: boolean }
  readonly #now: () => Date
  readonly #virtualTime: (context: ActorContext) => string
  readonly #contextStatus: (context: ActorContext) => 'active' | 'inactive' | 'superseded'
  readonly #qualityChanged: (context: ActorContext, transaction: CommandTransaction, caseId: string) => void
  readonly #trackQualityDraft: (context: ActorContext, caseId: string, before: Draft, after: Draft) => void
  readonly #prepareReports: (context: ActorContext, transaction: CommandTransaction, caseId: string) => void

  constructor(input: {
    database: ClinMeshDatabase
    commands: CommandExecutor
    enabled: boolean
    assertAccess: (context: ActorContext, encounterId: string) => { caseId: string; editable: boolean }
    now: () => Date
    virtualTime: (context: ActorContext) => string
    contextStatus: (context: ActorContext) => 'active' | 'inactive' | 'superseded'
    prepareReports: (context: ActorContext, transaction: CommandTransaction, caseId: string) => void
    qualityChanged?: (context: ActorContext, transaction: CommandTransaction, caseId: string) => void
    trackQualityDraft?: (context: ActorContext, caseId: string, before: Draft, after: Draft) => void
  }) {
    this.#database = input.database
    this.#commands = input.commands
    this.#enabled = input.enabled
    this.#assertAccess = input.assertAccess
    this.#now = input.now
    this.#virtualTime = input.virtualTime
    this.#contextStatus = input.contextStatus
    this.#prepareReports = input.prepareReports
    this.#qualityChanged = input.qualityChanged ?? (() => {})
    this.#trackQualityDraft = input.trackQualityDraft ?? (() => {})
  }

  recoverQueued(): void {
    if (!this.#enabled) return
    const jobs = z.array(jobSchema.extend({ turn_id: z.string(), workspace_id: z.string(), epoch: z.string() })).parse(
      this.#database.driver.prepare(`SELECT j.*, j.turn_id FROM consultation_recording_job j
        JOIN workspace w ON w.workspace_id = j.workspace_id AND w.active_epoch = j.epoch
        WHERE j.status = 'queued' AND j.scheduled = 0`).all())
    for (const job of jobs) {
      const context = contextSchema.parse(JSON.parse(job.actor_context_json))
      if (context.workspaceId !== job.workspace_id || context.epoch !== job.epoch) throw new Error('Recording recovery context mismatch')
      if (this.#contextStatus(context) === 'superseded') continue
      this.#commands.execute({ context, operation: 'consultation.recording.recover', contextRequirement: 'current', expectedVersions: {},
        idempotencyKey: `history:recover:${job.turn_id}:${job.generation}`, input: { turnId: job.turn_id, generation: job.generation },
        dataSchema: z.object({ caseId: z.string() }),
      }, transaction => {
        this.#scheduleNext(context, transaction, job.case_id)
      this.#qualityChanged(context, transaction, job.case_id)
        return { data: { caseId: job.case_id }, effects: [] }
      })
    }
  }

  create(context: ActorContext, caseId: string): void {
    if (!this.#enabled) return
    this.#database.driver.prepare(`INSERT INTO consultation_recording (workspace_id, epoch, case_id, start_sequence)
      VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, epoch, case_id) DO NOTHING`).run(context.workspaceId, context.epoch, caseId,
        this.#hasConsultation(context, caseId) ? 2 : 1)
  }

  bindDoctorContext(context: ActorContext, caseId: string): void {
    this.#database.driver.prepare(`UPDATE consultation_recording SET actor_context_json = ?
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?`).run(JSON.stringify(context), context.workspaceId, context.epoch, caseId)
  }

  activate(input: { context: ActorContext; encounterId: string; expectedVersions: Record<string, string>; idempotencyKey: string;
    expectedRecordingVersion?: number }) {
    return this.#commands.execute({ ...input, operation: 'consultation.recording.control',
      input: { encounterId: input.encounterId, action: 'activate', expectedRecordingVersion: input.expectedRecordingVersion ?? 0 },
      dataSchema: recordingReceiptSchema,
    }, transaction => {
      const access = this.#assertAccess(input.context, input.encounterId)
      if (!access.editable || this.isSigning(input.context, access.caseId) || !this.#enabled
        || input.expectedVersions[`Encounter/${input.encounterId}`] === undefined
        || (this.#state(input.context, access.caseId)?.version ?? 0) !== (input.expectedRecordingVersion ?? 0)) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The recording context is not editable')
      }
      if (this.#state(input.context, access.caseId) === undefined && !this.#hasConsultation(input.context, access.caseId)) {
        this.create(input.context, access.caseId)
      }
      this.bindDoctorContext(input.context, access.caseId)
      this.#prepareReports(input.context, transaction, access.caseId)
      if (this.#state(input.context, access.caseId) !== undefined) {
        const source = this.#sources(input.context, access.caseId).find(source => source.kind === 'report')
        if (source !== undefined) this.enqueueSource(input.context, transaction, { ...source, caseId: access.caseId, encounterId: input.encounterId })
      }
      this.#scheduleNext(input.context, transaction, access.caseId)
      return { data: this.read(input.context, access.caseId)!, effects: [{ kind: 'updated' as const,
        reference: `ConsultationRecording/${access.caseId}`, versionId: String(this.#state(input.context, access.caseId)?.version ?? 0) }] }
    })
  }

  recordDoctorSupplement(input: { context: ActorContext; encounterId: string; content: string; sourceId: string;
    sessionId: string; messageId: string; rpcId: string; recordedAt: string;
    expectedVersions: Record<string, string>; idempotencyKey: string }) {
    const { context, encounterId, content, sourceId, sessionId, messageId, rpcId, recordedAt } = input
    const source = consultationRecordingSourceSchema.parse({ id: sourceId, kind: 'doctor', messageText: content,
      sessionId, messageId, rpcId, recordedAt })
    const authorize = () => {
      const access = this.#assertAccess(context, encounterId)
      if (!access.editable || this.isSigning(context, access.caseId)
        || input.expectedVersions[`Encounter/${encounterId}`] === undefined || !this.#enabled) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The doctor source context is not editable')
      }
      return access
    }
    // Receipt replay must obey the current responsibility and signing boundary.
    authorize()
    return this.#commands.execute({ context, operation: 'consultation.doctor-supplement.record',
      expectedVersions: input.expectedVersions, idempotencyKey: input.idempotencyKey,
      input: { encounterId, source }, dataSchema: z.object({ caseId: z.string(), sourceId: z.string() }).strict(),
    }, transaction => {
      const access = authorize()
      if (this.#state(context, access.caseId) === undefined && !this.#hasConsultation(context, access.caseId)) this.create(context, access.caseId)
      this.#syncPatientSources(context, access.caseId)
      this.enqueueSource(context, transaction, { ...source, caseId: access.caseId, encounterId })
      this.#prepareReports(context, transaction, access.caseId)
      return { data: { caseId: access.caseId, sourceId }, effects: [{ kind: 'created' as const,
        reference: `ConsultationRecordingSource/${sourceId}`, versionId: '1' }] }
    })
  }

  enqueue(context: ActorContext, transaction: CommandTransaction, input: {
    caseId: string; encounterId: string; turnId: string
  }): void {
    this.#syncPatientSources(context, input.caseId)
    const turn = z.object({ message_text: z.string(), recorded_at: z.string() }).parse(this.#database.driver.prepare(`
      SELECT message_text, recorded_at FROM consultation_turn WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND turn_id = ?
    `).get(context.workspaceId, context.epoch, input.caseId, input.turnId))
    this.enqueueSource(context, transaction, { caseId: input.caseId, encounterId: input.encounterId,
      id: input.turnId, kind: 'patient', messageText: turn.message_text,
      recordedAt: turn.recorded_at, consultationTurnId: input.turnId })
    this.#prepareReports(context, transaction, input.caseId)
  }

  #syncPatientSources(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, caseId: string): void {
    const turns = z.array(z.object({ turn_id: z.string(), message_text: z.string(), recorded_at: z.string() })).parse(
      this.#database.driver.prepare(`SELECT turn_id, message_text, recorded_at FROM consultation_turn
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND speaker = 'patient' AND kind = 'text'
          AND NOT EXISTS (SELECT 1 FROM consultation_recording_source s WHERE s.workspace_id = consultation_turn.workspace_id
            AND s.epoch = consultation_turn.epoch AND s.source_id = consultation_turn.turn_id) ORDER BY sequence
      `).all(context.workspaceId, context.epoch, caseId))
    for (const turn of turns) this.#database.driver.prepare(`INSERT INTO consultation_recording_source
      (workspace_id, epoch, case_id, source_id, source_kind, message_text, sequence, recorded_at, metadata_json)
      VALUES (?, ?, ?, ?, 'patient', ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM consultation_recording_source
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?), ?, ?)
    `).run(context.workspaceId, context.epoch, caseId, turn.turn_id, turn.message_text,
      context.workspaceId, context.epoch, caseId, turn.recorded_at, JSON.stringify({ consultationTurnId: turn.turn_id }))
  }

  enqueueSource(context: ActorContext, transaction: CommandTransaction, input: {
    caseId: string; encounterId: string
  } & z.infer<typeof consultationRecordingSourceSchema>): void {
    const { caseId, encounterId, ...source } = input
    this.#saveSource(context, caseId, source)
    const state = this.#state(context, caseId)
    if (state === undefined) { this.#qualityChanged(context, transaction, caseId); return }
    this.bindDoctorContext(context, caseId)
    this.#database.driver.prepare(`INSERT INTO consultation_recording_job
      (workspace_id, epoch, case_id, encounter_id, turn_id, actor_context_json, status, scheduled)
      SELECT workspace_id, epoch, case_id, ?, source_id, ?, 'queued', 0 FROM consultation_recording_source s
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND sequence >= ?
        AND NOT EXISTS (SELECT 1 FROM consultation_recording_job j WHERE j.workspace_id = s.workspace_id
          AND j.epoch = s.epoch AND j.turn_id = s.source_id) ORDER BY sequence
    `).run(encounterId, JSON.stringify(context), context.workspaceId, context.epoch, caseId, state.start_sequence)
    this.#scheduleNext(context, transaction, caseId)
    this.#qualityChanged(context, transaction, caseId)
  }

  enqueueReport(context: ActorContext, transaction: CommandTransaction, input: {
    caseId: string; encounterId: string; reportReference: string; messageText: string; recordedAt: string; reportContentHash?: string
  }): void {
    this.#syncPatientSources(context, input.caseId)
    const source = consultationRecordingSourceSchema.parse({ id: createHash('sha256').update(input.reportReference).digest('hex'),
      kind: 'report', reportReference: input.reportReference, messageText: input.messageText, recordedAt: input.recordedAt,
      ...(input.reportContentHash === undefined ? {} : { reportContentHash: input.reportContentHash }) })
    const recorder = z.object({ actor_context_json: z.string().nullable() }).optional().parse(this.#database.driver.prepare(`
      SELECT actor_context_json FROM consultation_recording WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).get(context.workspaceId, context.epoch, input.caseId))
    this.#saveSource(context, input.caseId, source)
    this.#qualityChanged(context, transaction, input.caseId)
    const doctor = this.#boundContext(context, recorder?.actor_context_json ?? null)
    if (doctor === undefined) return
    this.enqueueSource(doctor, transaction, { ...source, caseId: input.caseId, encounterId: input.encounterId })
  }

  #saveSource(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, caseId: string,
    source: z.infer<typeof consultationRecordingSourceSchema>): void {
    const { id, kind, messageText, recordedAt, ...metadata } = consultationRecordingSourceSchema.parse(source)
    const prior = sourceRowSchema.extend({ case_id: z.string() }).optional().parse(this.#database.driver.prepare(`
      SELECT case_id, source_id, source_kind, message_text, recorded_at, metadata_json FROM consultation_recording_source
      WHERE workspace_id = ? AND epoch = ? AND source_id = ?`).get(context.workspaceId, context.epoch, id))
    if (prior !== undefined && (prior.case_id !== caseId || prior.source_kind !== kind || prior.message_text !== messageText
      || prior.recorded_at !== recordedAt || JSON.stringify(sourceMetadataSchema.parse(JSON.parse(prior.metadata_json))) !== JSON.stringify(metadata))) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The saved recording source identity has different content or belongs to another case')
    }
    if (prior === undefined) this.#database.driver.prepare(`INSERT INTO consultation_recording_source
      (workspace_id, epoch, case_id, source_id, source_kind, message_text, sequence, recorded_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM consultation_recording_source
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?), ?, ?)
    `).run(context.workspaceId, context.epoch, caseId, id, kind, messageText,
      context.workspaceId, context.epoch, caseId, recordedAt, JSON.stringify(metadata))
  }

  #state(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, caseId: string) {
    return recordingStateSchema.optional().parse(this.#database.driver.prepare(`SELECT version, paused, start_sequence, actor_context_json
      FROM consultation_recording WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).get(context.workspaceId, context.epoch, caseId))
  }

  #hasConsultation(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, caseId: string): boolean {
    return this.#database.driver.prepare(`SELECT 1 FROM consultation
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).get(context.workspaceId, context.epoch, caseId) !== undefined
  }

  #jobs(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, caseId: string) {
    return orderedJobsSchema.parse(this.#database.driver.prepare(`SELECT j.turn_id, j.status, j.generation, j.scheduled, j.error_code
      FROM consultation_recording_job j JOIN consultation_recording_source t
        ON t.workspace_id = j.workspace_id AND t.epoch = j.epoch AND t.source_id = j.turn_id
      WHERE j.workspace_id = ? AND j.epoch = ? AND j.case_id = ? ORDER BY t.sequence
    `).all(context.workspaceId, context.epoch, caseId))
  }

  #scheduleNext(context: ActorContext, transaction: CommandTransaction, caseId: string): void {
    if (this.#state(context, caseId)?.paused !== 0 || this.isSigning(context, caseId)) return
    const next = this.#jobs(context, caseId).find(job => job.status !== 'completed')
    if (next?.status !== 'queued' || next.scheduled === 1) return
    transaction.enqueue({ kind: 'consultation.record-history', dedupKey: `history:${next.turn_id}:${next.generation}`,
      payload: { turnId: next.turn_id, generation: next.generation } })
    this.#database.driver.prepare(`UPDATE consultation_recording_job SET scheduled = 1
      WHERE workspace_id = ? AND epoch = ? AND turn_id = ?
    `).run(context.workspaceId, context.epoch, next.turn_id)
  }

  #current(context: ActorContext, turnId: string, job: z.infer<typeof jobSchema>): boolean {
    const head = this.#jobs(context, job.case_id).find(item => item.status !== 'completed')
    return this.#state(context, job.case_id)?.paused === 0 && !this.isSigning(context, job.case_id)
      && head?.turn_id === turnId && head.generation === job.generation && head.status === 'queued'
  }

  control(input: { context: ActorContext; encounterId: string; action: 'activate' | 'pause' | 'resume' | 'backfill' | 'retry';
    expectedRecordingVersion: number; expectedVersions: Record<string, string>; idempotencyKey: string }) {
    const { context, encounterId, action } = input
    if (action === 'activate') return this.activate(input)
    return this.#commands.execute({ context, operation: 'consultation.recording.control',
      expectedVersions: input.expectedVersions, idempotencyKey: input.idempotencyKey,
      input: { encounterId, action, expectedRecordingVersion: input.expectedRecordingVersion },
      dataSchema: recordingReceiptSchema,
    }, transaction => {
      const access = this.#assertAccess(context, encounterId)
      const state = this.#state(context, access.caseId)
      if (!access.editable || this.isSigning(context, access.caseId)
        || input.expectedVersions[`Encounter/${encounterId}`] === undefined
        || (state?.version ?? 0) !== input.expectedRecordingVersion
        || (action === 'backfill' ? state !== undefined : state === undefined)
        || (action === 'backfill' && !this.#hasConsultation(context, access.caseId))
        || (action === 'resume' && state?.paused !== 1)
        || (action === 'pause' && state?.paused !== 0)
        || (action === 'retry' && (state?.paused !== 0 || !this.#jobs(context, access.caseId).some(job => job.status === 'failed')))) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'Refresh the consultation recording state before controlling it')
      }
      if (action !== 'pause' && !this.#enabled) throw new WorkflowError('WORKFLOW_CONFLICT', 'The recording model is unavailable')
      const version = (state?.version ?? 0) + 1
      this.#database.driver.prepare(`INSERT INTO consultation_recording (workspace_id, epoch, case_id, version, paused, start_sequence, actor_context_json)
        VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT (workspace_id, epoch, case_id)
        DO UPDATE SET version = excluded.version, paused = excluded.paused, actor_context_json = excluded.actor_context_json
      `).run(context.workspaceId, context.epoch, access.caseId, version, action === 'pause' ? 1 : 0, JSON.stringify(context))
      // 使在途结果失效；恢复由本次受信控制意图授权，不借用旧任务的 Grant。
      this.#database.driver.prepare(`UPDATE consultation_recording_job SET generation = generation + 1, scheduled = 0,
        status = 'queued', error_code = NULL, actor_context_json = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status != 'completed'
      `).run(JSON.stringify(context), context.workspaceId, context.epoch, access.caseId)
      if (action !== 'pause') {
        this.#syncPatientSources(context, access.caseId)
        const turn = z.object({ turn_id: z.string() }).optional().parse(this.#database.driver.prepare(`SELECT t.source_id AS turn_id
          FROM consultation_recording_source t WHERE t.workspace_id = ? AND t.epoch = ? AND t.case_id = ?
            AND t.sequence >= ?
            AND NOT EXISTS (SELECT 1 FROM consultation_recording_job j
              WHERE j.workspace_id = t.workspace_id AND j.epoch = t.epoch AND j.turn_id = t.source_id)
          ORDER BY t.sequence LIMIT 1
        `).get(context.workspaceId, context.epoch, access.caseId, state?.start_sequence ?? 1))
        if (turn !== undefined) this.enqueueSource(context, transaction, { caseId: access.caseId, encounterId,
          ...this.#sources(context, access.caseId).find(source => source.id === turn.turn_id)! })
        this.#prepareReports(context, transaction, access.caseId)
        this.#scheduleNext(context, transaction, access.caseId)
      }
      return { data: this.read(context, access.caseId)!, effects: [
        { kind: state === undefined ? 'created' as const : 'updated' as const,
          reference: `ConsultationRecording/${access.caseId}`, versionId: String(version) },
      ] }
    })
  }

  read(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, caseId: string) {
    const state = this.#state(context, caseId)
    const requiresContextBinding = state !== undefined && this.#enabled && this.#boundContext(context, state.actor_context_json) === undefined
    const signingPreparation = this.signingPreparation(context, caseId)
    if (state === undefined && (!this.#hasConsultation(context, caseId)
      || (!this.#enabled && signingPreparation === undefined))) return undefined
    const jobs = this.#jobs(context, caseId)
    const sourceCount = this.#sourceCount(context, caseId, state?.start_sequence ?? 1)
    const total = state !== undefined || this.#enabled ? sourceCount : z.object({ count: z.number().int().nonnegative() }).parse(
      this.#database.driver.prepare(`SELECT count(*) AS count FROM consultation_turn
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND speaker = 'patient' AND kind = 'text'
      `).get(context.workspaceId, context.epoch, caseId)).count
    const processedCount = jobs.filter(job => job.status === 'completed').length
    const failedCount = jobs.filter(job => job.status === 'failed').length
    const rows = this.#rows(context, caseId)
    const additions = rows.filter(row => row.status === 'applied').map(row => ({
      id: row.addition_id, field: row.field, sourceTurnId: row.source_turn_id,
      quote: row.quote, relation: row.relation, status: row.undone === 1 ? 'undone' as const : row.review_state ?? row.status,
      summary: row.facts_json === null ? '' : rowText(row), facts: rowFacts(row),
      ownership: row.ownership,
      currentText: row.current_text,
      ...(row.target_addition_id === null ? {} : { targetAdditionId: row.target_addition_id }),
    }))
    return consultationRecordingSchema.parse({
      requiresContextBinding,
      sources: this.#sources(context, caseId),
      signingPreparation,
      hasSavedDraft: this.#database.driver.prepare(`SELECT 1 FROM command_effect
        WHERE workspace_id = ? AND epoch = ? AND operation = 'clinical-document.save-draft'
          AND reference = ? LIMIT 1
      `).get(context.workspaceId, context.epoch, `ClinicalDocumentDraft/${caseId}`) !== undefined,
      version: state?.version ?? 0, paused: state?.paused === 1,
      processedCount, remainingCount: total - processedCount, failedCount,
      status: state === undefined ? 'backfill' : state.paused === 1 ? 'paused' : failedCount > 0 ? 'failed' : requiresContextBinding ? 'idle'
        : jobs.some(job => job.status === 'queued') ? 'processing'
        : jobs.length > 0 ? 'updated' : 'idle',
      additions,
      failures: jobs.filter(job => job.status !== 'completed' && job.error_code !== null).map(job => ({
        sourceTurnId: job.turn_id, code: job.error_code!, retrying: job.status === 'queued',
      })),
    })
  }

  #boundContext(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, stored: string | null) {
    const parsed = stored === null ? undefined : contextSchema.safeParse(JSON.parse(stored))
    return parsed?.success && parsed.data.workspaceId === context.workspaceId && parsed.data.epoch === context.epoch ? parsed.data : undefined
  }

  #sourceCount(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, caseId: string, startSequence: number): number {
    return z.object({ count: z.number().int().nonnegative() }).parse(this.#database.driver.prepare(`SELECT count(*) AS count
      FROM (SELECT sequence FROM consultation_recording_source WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        UNION ALL SELECT t.sequence FROM consultation_turn t WHERE t.workspace_id = ? AND t.epoch = ? AND t.case_id = ?
          AND t.speaker = 'patient' AND t.kind = 'text' AND NOT EXISTS (SELECT 1 FROM consultation_recording_source s
            WHERE s.workspace_id = t.workspace_id AND s.epoch = t.epoch AND s.source_id = t.turn_id)) WHERE sequence >= ?
    `).get(context.workspaceId, context.epoch, caseId, context.workspaceId, context.epoch, caseId, startSequence)).count
  }

  #sources(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, caseId: string) {
    return z.array(sourceRowSchema).parse(this.#database.driver.prepare(`SELECT source_id, source_kind,
      message_text, recorded_at, metadata_json FROM consultation_recording_source
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? ORDER BY sequence
    `).all(context.workspaceId, context.epoch, caseId)).map(row => consultationRecordingSourceSchema.parse({
      id: row.source_id, kind: row.source_kind, messageText: row.message_text, recordedAt: row.recorded_at,
      ...sourceMetadataSchema.parse(JSON.parse(row.metadata_json)),
    }))
  }

  #storedRows(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, caseId: string) {
    return additionRowsSchema.parse(this.#database.driver.prepare(`SELECT addition_id, field,
      source_turn_id, quote, relation, status, target_addition_id, ownership, start_offset, end_offset,
      current_text, review_state, review_status, rejected, undone, inverse_text, facts_json FROM consultation_history_addition
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? ORDER BY rowid
    `).all(context.workspaceId, context.epoch, caseId))
  }

  #rows(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, caseId: string) {
    const rows = this.#storedRows(context, caseId)
    if (!rows.some(row => row.status === 'applied' && row.undone === 0 && row.start_offset === null && row.review_state === null)) return rows
    return recoverLegacyHistoryRows(rows, this.#draft(context, caseId).content)
  }

  #manualHistory(context: ActorContext, caseId: string, document: Draft): ManualFragment[] {
    const rows = this.#rows(context, caseId)
    const manual: ManualFragment[] = []
    for (const field of consultationHistoryAdditionSchema.shape.field.options) {
      const text = document[field] ?? ''
      const anchored = rows.filter(row => row.field === field && row.status === 'applied' && row.undone === 0
        && row.review_state === null && row.start_offset !== null && row.end_offset !== null
        && text.slice(row.start_offset, row.end_offset) === row.current_text)
        .sort((left, right) => left.start_offset! - right.start_offset!)
      const addGap = (start: number, end: number) => {
        let cursor = start
        for (const sentence of statements(text.slice(start, end))) {
          const offset = text.indexOf(sentence, cursor)
          manual.push({ id: manualTargetPrefix + createHash('sha256').update(JSON.stringify([field, offset, sentence])).digest('hex'),
            field, text: sentence, start: offset, end: offset + sentence.length })
          cursor = offset + sentence.length
        }
      }
      let cursor = 0
      for (const row of anchored) {
        addGap(cursor, row.start_offset!)
        if (row.ownership === 'manual' && row.current_text) manual.push({ id: row.addition_id, field,
          text: row.current_text, start: row.start_offset!, end: row.end_offset! })
        cursor = Math.max(cursor, row.end_offset!)
      }
      addGap(cursor, text.length)
    }
    return manual
  }

  qualityFacts(context: ActorContext, caseId: string): QualityAgentFact[] {
    const document = this.#draft(context, caseId).content
    return this.#rows(context, caseId).filter(row => row.status === 'applied' && row.undone === 0 && row.review_state === null
      && row.ownership === 'automatic' && row.start_offset !== null && row.end_offset !== null
      && (document[row.field] ?? '').slice(row.start_offset, row.end_offset) === row.current_text)
      .flatMap(row => historyFacts(row).map((fact, index) => ({ ...fact, id: `${row.addition_id}:${index}`, field: row.field })))
  }

  #restoreLegacyRows(context: ActorContext, caseId: string, document = this.#draft(context, caseId).content): HistoryRow[] {
    const stored = this.#storedRows(context, caseId)
    const originals = new Map(stored.map(row => [row.addition_id, row]))
    const recovered = recoverLegacyHistoryRows(stored, document)
    for (const row of recovered) {
      const original = originals.get(row.addition_id)
      if (row === original) continue
      if (original !== undefined) {
        this.#database.driver.prepare(`UPDATE consultation_history_addition SET start_offset = ?, end_offset = ?,
          current_text = ?, ownership = ?, review_state = ?
          WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND addition_id = ?
        `).run(row.start_offset, row.end_offset, row.current_text, row.ownership, row.review_state,
          context.workspaceId, context.epoch, caseId, row.addition_id)
      } else {
        this.#database.driver.prepare(`INSERT INTO consultation_history_addition
          (workspace_id, epoch, case_id, addition_id, source_turn_id, field, quote, relation, status,
            target_addition_id, ownership, start_offset, end_offset, current_text, review_status, rejected, undone, inverse_text)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(context.workspaceId, context.epoch, caseId, row.addition_id, row.source_turn_id, row.field, row.quote,
          row.relation, row.status, row.target_addition_id, row.ownership, row.start_offset, row.end_offset,
          row.current_text, row.review_status, row.rejected, row.undone, row.inverse_text)
      }
    }
    return recovered
  }

  #trackEdits(context: ActorContext, caseId: string, before: Draft, after: Draft): void {
    this.#restoreLegacyRows(context, caseId)
    for (const row of this.#rows(context, caseId)) {
      if (row.status !== 'applied' || row.undone === 1
        || row.review_state !== null || row.start_offset === null || row.end_offset === null) continue
      const tracked = trackDocumentFragment(before[row.field] ?? '', after[row.field] ?? '', row.start_offset, row.end_offset)
      if (row.facts_json !== null && tracked.modified) {
        // Inserted attribution prefixes belong to the edited summary. Preserve
        // the preceding complete statement rather than anchoring inside it.
        const field = after[row.field] ?? ''
        if (!hasStatementBoundaries(field, tracked.start, tracked.end)) {
          const prefix = field.slice(0, tracked.start)
          const boundary = Math.max(...['。', '！', '？', ';', '；', '\n'].map(delimiter => prefix.lastIndexOf(delimiter)))
          tracked.start = boundary + 1
          tracked.text = field.slice(tracked.start, tracked.end)
        }
      }
      this.#database.driver.prepare(`UPDATE consultation_history_addition SET start_offset = ?, end_offset = ?,
        current_text = ?, ownership = ? WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND addition_id = ?
      `).run(tracked.start,
        tracked.end, tracked.text, tracked.modified ? 'manual' : row.ownership,
        context.workspaceId, context.epoch, caseId, row.addition_id)
    }
  }

  trackDraftSave(context: ActorContext, caseId: string, document: Draft): void {
    this.#trackEdits(context, caseId, this.#draft(context, caseId).content, document)
  }

  #trackReplacement(context: ActorContext, caseId: string, field: Addition['field'],
    before: string, after: string, start: number, end: number): void {
    // Command-owned edits have an exact range. A character diff can align repeated
    // "患者自述：" prefixes to the wrong sentence and falsely claim a neighbour was edited.
    const delta = after.length - before.length
    for (const row of this.#rows(context, caseId)) {
      if (row.field !== field || row.status !== 'applied' || row.undone === 1 || row.review_state !== null
        || row.start_offset === null || row.end_offset === null || row.end_offset <= start) continue
      const tracked = row.start_offset >= end
        ? { start: row.start_offset + delta, end: row.end_offset + delta, text: row.current_text, modified: false }
        : trackDocumentFragment(before, after, row.start_offset, row.end_offset)
      this.#database.driver.prepare(`UPDATE consultation_history_addition SET start_offset = ?, end_offset = ?,
        current_text = ?, ownership = ? WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND addition_id = ?
      `).run(tracked.start,
        tracked.end, tracked.text, tracked.modified ? 'manual' : row.ownership,
        context.workspaceId, context.epoch, caseId, row.addition_id)
    }
  }

  async process(event: OutboxHandlerInput, model: {
    models: GenerationModelBinding; model?: string; provider?: JsonChatCompletionsProvider; signal: AbortSignal; shutdownSignal?: AbortSignal
  }): Promise<OutboxHandlerResult> {
    const { turnId, generation } = z.object({ turnId: z.string().min(1), generation: z.number().int().positive().default(1) }).strict().parse(event.payload)
    const job = jobSchema.optional().parse(this.#database.driver.prepare(`SELECT case_id, encounter_id,
      actor_context_json, status, generation FROM consultation_recording_job WHERE workspace_id = ? AND epoch = ? AND turn_id = ?
    `).get(event.workspaceId, event.epoch, turnId))
    if (job === undefined || job.status !== 'queued' || job.generation !== generation) return { status: 'completed' }
    const context = contextSchema.parse(JSON.parse(job.actor_context_json))
    if (context.workspaceId !== event.workspaceId || context.epoch !== event.epoch
      || context.scenarioRunId !== event.scenarioRunId) throw new Error('Recording context does not match the durable event')
    if (!this.#current(context, turnId, job)) {
      // 迁移前每轮都有事件；较晚轮次交由前一轮成功后的顺序调度重新排队。
      this.#database.driver.prepare(`UPDATE consultation_recording_job SET scheduled = 0
        WHERE workspace_id = ? AND epoch = ? AND turn_id = ? AND generation = ?
      `).run(context.workspaceId, context.epoch, turnId, generation)
      return { status: 'completed' }
    }
    if (this.#stopIfInactive(context, event, turnId, job)) return { status: 'completed' }
    let stage: z.infer<typeof failureDiagnosticSchema>['stage'] = 'summary'
    try {
      const access = this.#assertAccess(context, job.encounter_id)
      if (access.caseId !== job.case_id) throw new Error('Recording case changed')
      if (!access.editable || this.isSigning(context, job.case_id)) {
        this.#finish(context, event, turnId, job, 'failed', 'CONSULTATION_RECORDING_NOT_EDITABLE')
        return { status: 'completed' }
      }
      if (this.#storedRows(context, job.case_id).some(row => row.status === 'applied'
        && row.undone === 0 && row.review_state === null && row.start_offset === null && row.ownership === 'automatic')) {
        this.#commands.execute({ context, operation: 'consultation.history.restore-ownership', expectedVersions: {},
          idempotencyKey: `history:${event.eventId}:anchors`, input: { caseId: job.case_id },
          dataSchema: z.object({ caseId: z.string() }),
        }, () => {
          this.#restoreLegacyRows(context, job.case_id)
          return { data: { caseId: job.case_id }, effects: [
            { kind: 'updated', reference: `ConsultationRecording/${job.case_id}`, versionId: turnId },
          ] }
        })
      }
      const turns = z.array(sourceRowSchema).parse(this.#database.driver.prepare(`SELECT
        source_id, source_kind, message_text, recorded_at, metadata_json FROM consultation_recording_source
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND sequence <= (
          SELECT sequence FROM consultation_recording_source WHERE workspace_id = ? AND epoch = ? AND source_id = ?)
        ORDER BY sequence
      `).all(context.workspaceId, context.epoch, job.case_id, context.workspaceId, context.epoch, turnId))
        .map(turn => ({ id: turn.source_id, speaker: turn.source_kind, kind: turn.source_kind, messageText: turn.message_text }))
      if (model.provider === undefined || model.model === undefined) throw new Error('Recording model unavailable')
      // 首代沿用升级前的任务身份，保留已经固定的模型路由。
      const taskId = `history:${context.epoch}:${turnId}${generation === 1 ? '' : `:${generation}`}`
      const pinned = await model.models.bind(context.workspaceId, taskId, model.model, model.signal)
      const baseline = this.#draft(context, job.case_id)
      const history = this.#rows(context, job.case_id).filter(row => row.status === 'applied' && row.undone === 0 && row.review_state === null)
        .filter(row => turns.some(turn => turn.id === row.source_turn_id))
        .map(row => ({ id: row.addition_id, field: row.field, text: row.current_text || rowText(row),
          facts: rowFacts(row), quote: row.quote, sourceTurnId: row.source_turn_id }))
      const manualHistory = this.#manualHistory(context, job.case_id, baseline.content)
      const evidence = historyEvidence(this.#rows(context, job.case_id))
      const parseOutput = (value: unknown) => {
        const output = historySummaryOutputSchema.parse(value)
        // A restored predecessor keeps its valid facts. Other rejected citations
        // cannot support new text; remaining sources must pass semantic verification.
        const additions = removeRejectedHistorySources(output.additions, evidence.blocked)
        validateHistorySummaries(additions, turns, history, manualHistory)
        return { additions: additions.filter(addition => hasNewHistoryEvidence(addition, turnId, evidence.rejected)) }
      }
      const result = await model.provider.completeJson({
        model: pinned, signal: model.signal, schemaName: 'consultation_history_summary',
        jsonSchema: z.toJSONSchema(historySummaryOutputSchema) as Record<string, unknown>, systemPrompt: historySummaryPrompt,
        userPayload: { turns, history: history.map(({ sourceTurnId: _sourceTurnId, ...item }) => item), rejectedFacts: evidence.rejectedFacts,
          ...(manualHistory.length === 0 ? {} : { manualHistory: manualHistory.map(({ start: _start, end: _end, ...item }) => item) }) },
        validate: value => { parseOutput(value); return true },
      })
      model.signal.throwIfAborted()
      const output = parseOutput(JSON.parse(result.content))
      stage = 'verification'
      await verifyHistorySummaries(model.provider, pinned, model.signal, output.additions, turns, history, manualHistory, evidence.rejectedFacts)
      if (this.#stopIfInactive(context, event, turnId, job)) return { status: 'completed' }
      stage = 'apply'
      if (this.#current(context, turnId, job)) this.#apply(context, event, turnId, job, baseline, output.additions, manualHistory, evidence.rejectedFacts)
      return { status: 'completed' }
    } catch (error) {
      if (!this.#current(context, turnId, job)) return { status: 'completed' }
      if (model.shutdownSignal?.aborted && event.attempt < 3) return { status: 'retryable-failed' }
      if (this.#stopIfInactive(context, event, turnId, job)) return { status: 'completed' }
      const code = model.shutdownSignal?.aborted ? 'CONSULTATION_RECORDING_FAILED'
        : model.signal.aborted ? 'AI_TIMEOUT' : error instanceof ChatCompletionsError ? error.code
        : error instanceof RecordingSourceError ? 'CONSULTATION_RECORDING_SOURCE_INVALID'
          : error instanceof z.ZodError ? 'CONSULTATION_RECORDING_OUTPUT_INVALID' : 'CONSULTATION_RECORDING_FAILED'
      // A timeout or exhausted structured-output repair must settle instead of multiplying long model calls.
      const retrying = event.attempt < 3 && ['AI_REQUEST_FAILED', 'CONSULTATION_RECORDING_FAILED',
        'CONSULTATION_RECORDING_OUTPUT_INVALID', 'CONSULTATION_RECORDING_SOURCE_INVALID'].includes(code)
      const sourceError = error instanceof RecordingSourceError ? error
        : error instanceof ChatCompletionsError && error.code === 'AI_RESPONSE_INVALID' && error.cause instanceof RecordingSourceError
          ? error.cause : undefined
      this.#finish(context, event, turnId, job, 'failed', code, retrying,
        { stage, ...sourceError?.diagnostic })
      return { status: retrying ? 'retryable-failed' : 'completed' }
    }
  }

  #stopIfInactive(context: ActorContext, event: OutboxHandlerInput, turnId: string, job: z.infer<typeof jobSchema>): boolean {
    const status = this.#contextStatus(context)
    if (status === 'active') return false
    if (status === 'inactive') this.#finish(context, event, turnId, job, 'failed', 'CONSULTATION_RECORDING_CONTEXT_INACTIVE')
    return true
  }

  #draft(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, caseId: string) {
    const row = draftSchema.optional().parse(this.#database.driver.prepare(`SELECT content_json, version
      FROM clinical_document_draft WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).get(context.workspaceId, context.epoch, caseId))
    return { version: row?.version ?? 0, content: row === undefined ? {
      assessment: '', chiefComplaint: '', disposition: '', followUp: '', historyOfPresentIllness: '', physicalExamination: '',
    } satisfies Draft : clinicalDocumentDraftContentSchema.parse(JSON.parse(row.content_json)) }
  }

  signingPreparation(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, caseId: string) {
    const preview = z.object({ preview_id: z.string(), expires_at: z.string() }).optional().parse(
      this.#database.driver.prepare(`SELECT preview_id, expires_at FROM clinical_document_sign_preview
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND consumed_at IS NULL ORDER BY rowid DESC LIMIT 1
      `).get(context.workspaceId, context.epoch, caseId))
    return preview === undefined ? undefined : { previewId: preview.preview_id, expiresAt: preview.expires_at,
      active: Date.parse(preview.expires_at) > this.#now().getTime() }
  }

  isSigning(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, caseId: string): boolean {
    return this.signingPreparation(context, caseId)?.active === true
  }

  signingProgress(context: Pick<ActorContext, 'workspaceId' | 'epoch'>, caseId: string) {
    const state = this.#state(context, caseId)
    const counts = z.object({ total: z.number().int().nonnegative(), additional: z.number().int().nonnegative(), doctors: z.number().int().nonnegative() }).parse(
      this.#database.driver.prepare(`SELECT count(*) AS total, count(CASE WHEN source_kind != 'patient' THEN 1 END) AS additional,
        count(CASE WHEN source_kind = 'doctor' THEN 1 END) AS doctors
        FROM consultation_recording_source WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, caseId))
    const remainingCount = state === undefined ? counts.doctors + z.object({ count: z.number().int().nonnegative() }).parse(
      this.#database.driver.prepare(`SELECT count(*) AS count FROM consultation_turn
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND speaker = 'patient' AND kind = 'text'
      `).get(context.workspaceId, context.epoch, caseId)).count
      : this.#sourceCount(context, caseId, state.start_sequence) - this.#jobs(context, caseId).filter(job => job.status === 'completed').length
    return { hasRegisteredSources: state !== undefined || counts.doctors > 0, remainingCount,
      sourceCount: counts.additional === 0 ? undefined : counts.total }
  }

  suspendForSigning(context: ActorContext, caseId: string): void {
    // Keep unfinished answers and failures; an old model response never regains authority after cancel/expiry.
    this.#database.driver.prepare(`UPDATE consultation_recording_job SET generation = generation + 1, scheduled = 0
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status != 'completed'
    `).run(context.workspaceId, context.epoch, caseId)
  }

  resumeAfterSigning(context: ActorContext, transaction: CommandTransaction, caseId: string): void {
    this.#database.driver.prepare(`UPDATE consultation_recording_job SET actor_context_json = ?
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status != 'completed'
    `).run(JSON.stringify(context), context.workspaceId, context.epoch, caseId)
    this.#scheduleNext(context, transaction, caseId)
  }

  #apply(context: ActorContext, event: OutboxHandlerInput, turnId: string,
    job: z.infer<typeof jobSchema>, baseline: { version: number; content: Draft }, additions: HistorySummary[], manualHistory: ManualFragment[],
    rejectedFacts: RejectedHistoryFact[]) {
    const fragments: Addition[] = additions.map(item => {
      const sources = item.facts.flatMap(fact => fact.sources)
      const source = sources.find(source => source.sourceTurnId === turnId)!
      return { ...item, ...source }
    })
    this.#commands.execute({ context, operation: 'consultation.history.apply', expectedVersions: {},
      idempotencyKey: `history:${event.eventId}`, input: { turnId, baselineVersion: baseline.version, additions },
      dataSchema: z.object({ draftVersion: z.number().int().nonnegative() }),
    }, transaction => {
      if (!this.#current(context, turnId, job)) return { data: { draftVersion: this.#draft(context, job.case_id).version }, effects: [] }
      const access = this.#assertAccess(context, job.encounter_id)
      const current = this.#draft(context, job.case_id)
      const existing = this.#restoreLegacyRows(context, job.case_id, current.content)
      const evidence = historyEvidence(existing)
      if (JSON.stringify(rejectedFacts) !== JSON.stringify(evidence.rejectedFacts)) {
        throw new Error('History rejection changed during summarization')
      }
      // Compare every affected field against current manual text before recording.
      const writableFields = new Set(additions.map(item => item.field))
      const comparison = (items: ManualFragment[]) => JSON.stringify(items.filter(item => writableFields.has(item.field)))
      if (comparison(manualHistory) !== comparison(this.#manualHistory(context, job.case_id, current.content))) {
        throw new Error('Manual history comparison changed during extraction')
      }
      const seenIds = new Set(existing.map(item => item.addition_id))
      const seenSummaries = new Set(existing.filter(item => item.rejected === 0 && item.undone === 0 && item.review_state === null)
        .map(item => JSON.stringify([item.field, normalizeQuoteEnding(rowText(item))])))
      if (!access.editable) return { data: { draftVersion: current.version }, effects: [] }
      const document = { ...current.content }
      const sourceKind = this.#sources(context, job.case_id).find(source => source.id === turnId)!.kind
      const sourceLabel = sourceKind === 'doctor' ? '医生补充' : sourceKind === 'report' ? '报告内容' : '患者自述'
      let changed = false
      for (const addition of fragments) {
        const id = createHash('sha256').update(JSON.stringify(['direct', addition])).digest('hex')
        const summary = summaryText(addition.facts)

        const key = JSON.stringify([addition.field, normalizeQuoteEnding(summary)])
        if (!hasNewHistoryEvidence(addition, turnId, evidence.rejected) || seenIds.has(id)
          || (addition.relation === 'addition' && seenSummaries.has(key))) continue
        seenIds.add(id)
        seenSummaries.add(key)
        const target = this.#rows(context, job.case_id).find(item => item.addition_id === addition.targetAdditionId)
        const fieldText = document[addition.field] ?? ''
        const anchored = target !== undefined && target.undone === 0 && target.review_state === null && target.status === 'applied'
          && target.start_offset !== null && target.end_offset !== null
          && isHistoryRange(target, fieldText, target.start_offset, target.end_offset)
          && fieldText.slice(target.start_offset, target.end_offset) === target.current_text
        if (addition.relation === 'update' && anchored && summary === target.current_text) continue
        // The independent verifier evaluates the relation against every fact's
        // sources; the legacy representative quote cannot decide it.
        const replace = anchored && (addition.relation === 'update' || addition.relation === 'correction')
          && target.ownership === 'automatic'
        const text = addition.relation === 'conflict' ? `${sourceLabel}存在矛盾，待核实：${summary}`
          : addition.relation === 'correction' && !replace ? `${sourceKind === 'patient' ? '患者' : sourceLabel}更正：${summary}` : summary
        const start = replace ? target.start_offset! : fieldText.length + (fieldText ? 1 : 0)
        const next = replace ? fieldText.slice(0, start) + text + fieldText.slice(target.end_offset!)
          : [fieldText, text].filter(Boolean).join('\n')
        const limit = addition.field === 'chiefComplaint' ? 1_000 : addition.field === 'historyOfPresentIllness' ? 5_000 : 4_000
        if (next.length > limit) throw new RecordingSourceError(['additions'], 'Recorded history exceeds the document field limit', { reason: 'field-limit' })

        if (replace) this.#supersede(context, job.case_id, target.addition_id)
        this.#trackReplacement(context, job.case_id, addition.field, fieldText, next,
            replace ? start : fieldText.length, replace ? target.end_offset! : fieldText.length)
        this.#database.driver.prepare(`INSERT INTO consultation_history_addition
          (workspace_id, epoch, case_id, addition_id, source_turn_id, field, quote, relation, status,
            target_addition_id, start_offset, end_offset, current_text, inverse_text, facts_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(context.workspaceId, context.epoch, job.case_id, id, addition.sourceTurnId, addition.field,
          addition.quote, addition.relation, 'applied', addition.targetAdditionId ?? null,
          start,
          start + text.length,
          text,
          replace ? target.current_text : null, JSON.stringify(addition.facts))
        document[addition.field] = next
        changed = true
      }
      const draftVersion = current.version + (changed ? 1 : 0)
      if (changed) this.#trackQualityDraft(context, job.case_id, current.content, document)
      if (changed) this.#database.driver.prepare(`INSERT INTO clinical_document_draft
        (workspace_id, epoch, case_id, version, content_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, epoch, case_id) DO UPDATE SET version = excluded.version,
          content_json = excluded.content_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at
      `).run(context.workspaceId, context.epoch, job.case_id, draftVersion,
        JSON.stringify(clinicalDocumentDraftContentSchema.parse(document)), context.actorId, this.#virtualTime(context))
      this.#database.driver.prepare(`UPDATE consultation_recording_job SET status = 'completed', error_code = NULL
        WHERE workspace_id = ? AND epoch = ? AND turn_id = ?
      `).run(context.workspaceId, context.epoch, turnId)
      this.#scheduleNext(context, transaction, job.case_id)
      return { data: { draftVersion }, effects: [
        { kind: 'updated' as const, reference: `ConsultationRecording/${job.case_id}`, versionId: turnId },
        ...(changed ? [{ kind: current.version === 0 ? 'created' as const : 'updated' as const,
          reference: `ClinicalDocumentDraft/${job.case_id}`, versionId: String(draftVersion) }] : []),
      ] }
    })
  }

  #supersede(context: ActorContext, caseId: string, id: string): void {
    this.#database.driver.prepare(`UPDATE consultation_history_addition SET review_state = 'superseded'
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND addition_id = ?
    `).run(context.workspaceId, context.epoch, caseId, id)
  }

  #finish(context: ActorContext, event: OutboxHandlerInput, turnId: string,
    job: z.infer<typeof jobSchema>, status: 'failed', code: z.infer<typeof consultationRecordingErrorCodeSchema>, retrying = false,
    diagnostic?: z.infer<typeof failureDiagnosticSchema>) {
    if (!this.#current(context, turnId, job)) return
    const nextStatus = retrying ? 'queued' : status
    this.#commands.execute({ context, operation: 'consultation.history.fail', expectedVersions: {},
      contextRequirement: 'current',
      idempotencyKey: `history:${event.eventId}:failure:${event.attempt}`, input: { turnId, code },
      dataSchema: z.object({ status: z.literal('failed'), code: consultationRecordingErrorCodeSchema,
        diagnostic: failureDiagnosticSchema.optional() }),
    }, () => {
      this.#database.driver.prepare(`UPDATE consultation_recording_job SET status = ?, error_code = ?
        WHERE workspace_id = ? AND epoch = ? AND turn_id = ? AND generation = ? AND status != 'completed'
      `).run(nextStatus, code, context.workspaceId, context.epoch, turnId, job.generation)
      // Keep bounded reasons after a later retry clears the job's current error.
      // Never persist provider messages, prompts or rejected clinical text here.
      return { data: { status, code, ...(diagnostic === undefined ? {} : { diagnostic }) },
        effects: [{ kind: 'updated', reference: `ConsultationRecording/${job.case_id}`, versionId: turnId }] }
    })
  }
}
