import { createHash } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { inpatientDischargeInputSchema, inpatientDischargeResponseSchema, inpatientSettlementPreviewSchema,
  inpatientSettleInputSchema, inpatientSettlementResponseSchema, inpatientDepartInputSchema, inpatientDischargeEventsSchema } from '@clinmesh/contracts/inpatient-discharge'
import type { ActorContext } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'

export class InpatientDischarge {
  constructor(readonly owner: InpatientService) {}
  read(context: ActorContext, admissionId: string) {
    this.owner.assertRole(context, ['inpatient-doctor','ward-nurse','medical-records'])
    this.owner.admissionBinding(context, admissionId)
    return inpatientDischargeEventsSchema.parse({ admissionId, events: this.events(context, admissionId) })
  }
  events(context: ActorContext, admissionId: string) {
    return z.array(z.object({ event_id: z.string(), kind: inpatientDischargeEventsSchema.shape.events.element.shape.kind,
      reason: z.string(), bed_id: z.string(), departure_method: z.string().nullable(), reverses_event_id: z.string().nullable(),
      actor_id: z.string(), practitioner_role_id: z.string(), virtual_time: z.string(),
    })).parse(this.owner.database.driver.prepare('SELECT * FROM inpatient_discharge_event WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY julianday(virtual_time),event_id')
      .all(context.workspaceId, context.epoch, admissionId)).map(row => ({ id: row.event_id, kind: row.kind, reason: row.reason, bedId: row.bed_id,
      ...(row.departure_method === null ? {} : { departureMethod: row.departure_method }), ...(row.reverses_event_id === null ? {} : { reversesEventId: row.reverses_event_id }),
      actorId: row.actor_id, practitionerRoleId: row.practitioner_role_id, virtualTime: row.virtual_time }))
  }
  action(context: ActorContext, raw: unknown, idempotencyKey: string, action: 'issue' | 'depart' | 'recall' | 'clear') {
    const input = (action === 'depart' ? inpatientDepartInputSchema : inpatientDischargeInputSchema).parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: `inpatient.discharge.${action}`,
      expectedVersions: { [`Encounter/${input.admissionId}`]: input.encounterVersion }, dataSchema: inpatientDischargeResponseSchema.shape.data,
      authorize: () => this.owner.assertRole(context, ['depart','clear'].includes(action) ? ['ward-nurse'] : ['inpatient-doctor']) }, () => {
      const admission = this.owner.detail(context, input.admissionId).admission
      const from = action === 'issue' ? 'admitted' : action === 'depart' ? 'discharge-pending' : 'departed'
      const to = action === 'issue' ? 'discharge-pending' : action === 'depart' ? 'departed' : action === 'clear' ? 'cleared' : 'admitted'
      if (admission.status !== from || admission.financialStatus !== (action === 'clear' ? 'settled' : 'open') || admission.bedId === undefined) {
        throw new InpatientError('INPATIENT_STATE_CONFLICT', '当前住院、财务或床位状态不允许此出院动作')
      }
      this.#assertNoPending(context, input.admissionId)
      const departure = action === 'recall' ? this.events(context, input.admissionId).filter(event => event.kind === 'depart').at(-1) : undefined
      if (action === 'recall' && (departure === undefined || departure.bedId !== admission.bedId)) throw new InpatientError('INPATIENT_RECALL_WINDOW_CLOSED', '原床未保留，不能召回')
      if (action === 'depart') this.assertOrdersFinished(context, input.admissionId)
      const changed = this.owner.database.driver.prepare("UPDATE inpatient_admission SET status=? WHERE workspace_id=? AND epoch=? AND admission_id=? AND status=? AND financial_status=?")
        .run(to, context.workspaceId, context.epoch, input.admissionId, from, action === 'clear' ? 'settled' : 'open')
      if (changed.changes !== 1) throw new InpatientError('INPATIENT_STATE_CONFLICT', '住院状态已变化')
      const id = uuidv7(), now = this.owner.virtualTime(context)
      if (action === 'clear') this.owner.database.driver.prepare('UPDATE inpatient_bed_occupancy SET ended_at=? WHERE workspace_id=? AND epoch=? AND admission_id=? AND ended_at IS NULL').run(now, context.workspaceId, context.epoch, input.admissionId)
      this.owner.database.driver.prepare('INSERT INTO inpatient_discharge_event VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(context.workspaceId, context.epoch, id, input.admissionId, action, input.reason, admission.bedId,
          'departureMethod' in input ? input.departureMethod : null, departure?.id ?? null, context.actorId, context.practitionerRoleId, now)
      const existing = this.owner.fhir.read(context, 'Encounter', input.admissionId)
      const locations = z.array(z.object({ location: z.object({ reference: z.string() }), status: z.string(),
        period: z.object({ start: z.string(), end: z.string().optional() }) })).parse(existing.location)
      const actualPeriod = z.object({ start: z.string(), end: z.string().optional() }).parse(existing.actualPeriod)
      const encounter = this.owner.fhir.update(context, { ...existing, status: action === 'clear' ? 'completed' : action === 'depart' ? 'discharged' : 'in-progress',
        actualPeriod: action === 'depart' ? { ...actualPeriod, end: now } : action === 'recall' ? { start: actualPeriod.start } : actualPeriod,
        extension: [...(Array.isArray(existing.extension) ? existing.extension.filter(value => z.object({ url: z.string() }).parse(value).url !== 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/inpatient-administrative-status') : []), { url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/inpatient-administrative-status', valueCode: to }],
        location: action === 'depart' ? locations.map(location => location.status === 'active' ? { ...location, status: 'completed', period: { ...location.period, end: now } } : location)
          : action === 'recall' ? [...locations, { location: { reference: `Location/${admission.bedId}` }, status: 'active', period: { start: now } }] : locations,
      }, input.encounterVersion)
      return { data: this.owner.detail(context, input.admissionId), effects: [
        { kind: 'updated' as const, reference: `Encounter/${input.admissionId}`, versionId: encounter.meta!.versionId! },
        { kind: 'created' as const, reference: `InpatientDischargeEvent/${id}`, versionId: '1' },
      ] }
    })
  }
  #assertNoPending(context: ActorContext, admissionId: string) {
    this.owner.surgery.assertNoPending(context, admissionId)
    this.owner.investigations.assertNoPending(context, admissionId)
    this.owner.transfers.assertNoPending(context, admissionId)
  }
  assertOrdersFinished(context: ActorContext, admissionId: string) {
    if (this.owner.database.driver.prepare(`SELECT 1 FROM inpatient_order o WHERE o.workspace_id=? AND o.epoch=? AND o.admission_id=?
      AND (o.state NOT IN ('stopped','completed') OR EXISTS (SELECT 1 FROM inpatient_execution e
        WHERE e.workspace_id=o.workspace_id AND e.epoch=o.epoch AND e.order_id=o.order_id AND e.status NOT IN ('completed','cancelled'))) LIMIT 1`)
      .get(context.workspaceId, context.epoch, admissionId)) {
      throw new InpatientError('INPATIENT_DISCHARGE_PENDING_ORDERS', '请先停嘱并核停，完成或取消在途执行单')
    }
  }
  preview(context: ActorContext, admissionId: string) {
    this.owner.assertRole(context, ['cashier'])
    this.owner.database.driver.exec('BEGIN')
    try { const result = this.snapshot(context, admissionId); this.owner.database.driver.exec('COMMIT'); return result }
    catch (error) { if (this.owner.database.driver.inTransaction) this.owner.database.driver.exec('ROLLBACK'); throw error }
  }
  snapshot(context: ActorContext, admissionId: string) {
    const admission = this.owner.admissionBinding(context, admissionId)
    const encounterVersion = this.owner.fhir.read(context, 'Encounter', admissionId).meta!.versionId!
    const facts = this.owner.orders.chargeFacts(context, admissionId)
    const deposits = z.array(z.object({ transaction_id: z.string(), amount_fen: z.number().int().positive().safe(), virtual_time: z.string() })).parse(
      this.owner.database.driver.prepare('SELECT transaction_id,amount_fen,virtual_time FROM inpatient_deposit WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY transaction_id').all(context.workspaceId, context.epoch, admissionId))
    const depositFen = z.number().int().nonnegative().safe().parse(deposits.reduce((sum, row) => sum + row.amount_fen, 0))
    const transactions = [
      ...deposits.map(row => ({ id: row.transaction_id, kind: 'deposit' as const, amountFen: row.amount_fen, virtualTime: row.virtual_time })),
      ...z.array(z.object({ transaction_id: z.string(), kind: z.enum(['supplement','refund']), amount_fen: z.number().int().safe(), source_deposit_id: z.string().nullable(), virtual_time: z.string() })).parse(
        this.owner.database.driver.prepare('SELECT * FROM inpatient_settlement_transaction WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY transaction_id').all(context.workspaceId, context.epoch, admissionId))
        .map(row => ({ id: row.transaction_id, kind: row.kind, amountFen: row.amount_fen, virtualTime: row.virtual_time,
          ...(row.source_deposit_id === null ? {} : { sourceDepositId: row.source_deposit_id }) })),
    ]
    const stored = z.object({ settlement_id: z.string(), preview_json: z.string(), settled_at: z.string() }).optional().parse(this.owner.database.driver.prepare(
      'SELECT * FROM inpatient_settlement WHERE workspace_id=? AND epoch=? AND admission_id=?').get(context.workspaceId, context.epoch, admissionId))
    const settledPreview = stored === undefined ? undefined : inpatientSettlementPreviewSchema.parse(JSON.parse(stored.preview_json))
    const data = { admissionId, encounterVersion, status: admission.status, financialStatus: admission.financialStatus, ...facts, depositFen, balanceFen: facts.chargesFen - depositFen,
      transactions, ...(stored === undefined || settledPreview === undefined ? {} : { settlement: { id: stored.settlement_id, fingerprint: settledPreview.fingerprint,
        chargesFen: settledPreview.chargesFen, depositFen: settledPreview.depositFen, balanceFen: settledPreview.balanceFen, settledAt: stored.settled_at } }) }
    const accountVersion = this.owner.fhir.read(context, 'Account', admissionId).meta!.versionId!
    return inpatientSettlementPreviewSchema.parse({ ...data, fingerprint: createHash('sha256').update(JSON.stringify({ ...data, accountVersion })).digest('hex') })
  }
  settle(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientSettleInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.discharge.settle',
      expectedVersions: { [`Encounter/${input.admissionId}`]: input.encounterVersion }, dataSchema: inpatientSettlementResponseSchema.shape.data,
      authorize: () => this.owner.assertRole(context, ['cashier']) }, () => {
      const preview = this.snapshot(context, input.admissionId)
      if (preview.status !== 'departed' || preview.financialStatus !== 'open') throw new InpatientError('INPATIENT_STATE_CONFLICT', '仅已出区且未结算住院可结算')
      this.#assertNoPending(context, input.admissionId)
      this.assertOrdersFinished(context, input.admissionId)
      if (preview.fingerprint !== input.fingerprint || preview.chargesFen !== input.expectedChargesFen || preview.balanceFen !== input.expectedBalanceFen) {
        throw new InpatientError('INPATIENT_SETTLEMENT_PREVIEW_STALE', '账目或资金已变化，请明确重新预览后结算')
      }
      const changed = this.owner.database.driver.prepare("UPDATE inpatient_admission SET financial_status='settled' WHERE workspace_id=? AND epoch=? AND admission_id=? AND status='departed' AND financial_status='open'")
        .run(context.workspaceId, context.epoch, input.admissionId)
      if (changed.changes !== 1) throw new InpatientError('INPATIENT_STATE_CONFLICT', '出区或财务状态已变化')
      const id = uuidv7(), now = this.owner.virtualTime(context)
      this.owner.database.driver.prepare('INSERT INTO inpatient_settlement VALUES(?,?,?,?,?,?)').run(context.workspaceId, context.epoch, id, input.admissionId, JSON.stringify(preview), now)
      const effects: Array<{ kind: 'created' | 'updated'; reference: string; versionId: string }> = [{ kind: 'created', reference: `InpatientSettlement/${id}`, versionId: '1' }]
      const addTransaction = (kind: 'supplement' | 'refund', amount: number, sourceId: string | null) => {
        const transactionId = uuidv7()
        this.owner.database.driver.prepare('INSERT INTO inpatient_settlement_transaction VALUES(?,?,?,?,?,?,?,?,?)')
          .run(context.workspaceId, context.epoch, transactionId, input.admissionId, id, kind, amount, sourceId, now)
        effects.push({ kind: 'created', reference: `InpatientSettlementTransaction/${transactionId}`, versionId: '1' })
      }
      if (preview.balanceFen > 0) addTransaction('supplement', preview.balanceFen, null)
      else if (preview.balanceFen < 0) {
        let remaining = -preview.balanceFen
        for (const deposit of preview.transactions.filter(transaction => transaction.kind === 'deposit')) {
          const refund = Math.min(remaining, deposit.amountFen)
          if (refund > 0) addTransaction('refund', -refund, deposit.id)
          remaining -= refund
        }
        if (remaining !== 0) throw new InpatientError('INPATIENT_SETTLEMENT_FUNDS_CONFLICT', '退款无法关联足额原预交金')
      }
      const account = this.owner.fhir.read(context, 'Account', input.admissionId)
      const updatedAccount = this.owner.fhir.update(context, { ...account, status: 'inactive' }, account.meta!.versionId!)
      const encounter = this.owner.fhir.read(context, 'Encounter', input.admissionId)
      const updatedEncounter = this.owner.fhir.update(context, { ...encounter, extension: [...(Array.isArray(encounter.extension) ? encounter.extension : []),
        { url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/inpatient-financial-status', valueCode: 'settled' }] }, input.encounterVersion)
      effects.push({ kind: 'updated', reference: `Account/${input.admissionId}`, versionId: updatedAccount.meta!.versionId! },
        { kind: 'updated', reference: `Encounter/${input.admissionId}`, versionId: updatedEncounter.meta!.versionId! })
      return { data: this.snapshot(context, input.admissionId), effects }
    })
  }
}
