import { assertInpatientRecordWritable } from './inpatient-record-lock.ts'
import { InpatientError } from './inpatient-service.ts'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import type { ActorContext } from './command-executor.ts'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository } from '../infrastructure/sqlite/fhir-repository.ts'

export type InpatientEffects = Array<{ kind: 'created' | 'updated'; reference: string; versionId: string }>
/** 调用者持有 Command 事务；费用与 FHIR 投影一起提交。 */
export class InpatientBilling {
  constructor(readonly database: ClinMeshDatabase, readonly fhir: FhirRepository) {}
  record(context: ActorContext, input: { admissionId: string; organizationId: string; kind: 'bed' | 'medication' | 'service' | 'surgery' | 'material' | 'laboratory' | 'imaging'; sourceId: string;
    serviceDate: string; amountFen: number; virtualTime: string; label: string }, effects: InpatientEffects): boolean {
    assertInpatientRecordWritable(this.database,context,input.admissionId)
    const amount = z.number().int().nonnegative().safe().parse(input.amountFen)
    const patient = z.object({ patient_id: z.string(), financial_status: z.enum(['open','settled']) }).parse(this.database.driver.prepare(
      'SELECT patient_id, financial_status FROM inpatient_admission WHERE workspace_id=? AND epoch=? AND admission_id=?').get(context.workspaceId, context.epoch, input.admissionId))
    if (patient.financial_status !== 'open') throw new InpatientError('INPATIENT_ACCOUNT_SETTLED', '已结算住院账户不能新增费用')
    const id = uuidv7()
    const result = this.database.driver.prepare(`INSERT INTO inpatient_charge(workspace_id,epoch,charge_id,admission_id,organization_id,kind,source_id,service_date,amount_fen,virtual_time)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,epoch,admission_id,kind,source_id,service_date) DO NOTHING`)
      .run(context.workspaceId, context.epoch, id, input.admissionId, input.organizationId, input.kind, input.sourceId, input.serviceDate, amount, input.virtualTime)
    if (result.changes === 0) return false
    this.fhir.create(context, { resourceType: 'ChargeItem', id, status: 'billable', code: { text: input.label, ...(input.kind === 'bed' ? { coding: [{ system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/inpatient-charge', code: 'bed-day' }] } : {}) },
      subject: { reference: `Patient/${patient.patient_id}` }, encounter: { reference: `Encounter/${input.admissionId}` }, account: [{ reference: `Account/${input.admissionId}` }],
      occurrenceDateTime: input.virtualTime, performingOrganization: { reference: `Organization/${input.organizationId}` }, totalPriceComponent: { amount: { value: amount / 100, currency: 'CNY' } } })
    effects.push({ kind: 'created', reference: `ChargeItem/${id}`, versionId: '1' })
    return true
  }
  /** 原费用精确冲正，岗位授权由所属 Command 保持；不接受任意反向金额。 */
  reverse(context: ActorContext, input: { admissionId: string; chargeId: string; expectedChargeVersion: number;
    reason: string; serviceDate: string; virtualTime: string }, effects: InpatientEffects): string {
    assertInpatientRecordWritable(this.database, context, input.admissionId)
    const admission = z.object({ patient_id: z.string(), financial_status: z.string() }).parse(this.database.driver.prepare(
      'SELECT patient_id,financial_status FROM inpatient_admission WHERE workspace_id=? AND epoch=? AND admission_id=?')
      .get(context.workspaceId, context.epoch, input.admissionId))
    const charge = z.object({ charge_id: z.string(), organization_id: z.string(), version: z.number(), amount_fen: z.number().int().safe(),
      reversal_of: z.string().nullable() }).optional().parse(this.database.driver.prepare(
      'SELECT * FROM inpatient_charge WHERE workspace_id=? AND epoch=? AND admission_id=? AND charge_id=?')
      .get(context.workspaceId, context.epoch, input.admissionId, input.chargeId))
    if (admission.financial_status !== 'open' || !charge || charge.version !== input.expectedChargeVersion || charge.reversal_of !== null
      || this.database.driver.prepare('SELECT 1 FROM inpatient_charge WHERE workspace_id=? AND epoch=? AND reversal_of=?')
        .get(context.workspaceId, context.epoch, input.chargeId)) throw new InpatientError('INPATIENT_CHARGE_CONFLICT', '账目已结算、版本已变化或该费用已冲正')
    const id = uuidv7()
    this.database.driver.prepare(`INSERT INTO inpatient_charge(workspace_id,epoch,charge_id,admission_id,organization_id,kind,source_id,service_date,amount_fen,virtual_time,reversal_of,reason)
      VALUES(?,?,?,?,?,'reversal',?,?,?,?,?,?)`).run(context.workspaceId, context.epoch, id, input.admissionId, charge.organization_id,
        charge.charge_id, input.serviceDate, -charge.amount_fen, input.virtualTime, charge.charge_id, input.reason)
    this.fhir.create(context, { resourceType: 'ChargeItem', id, status: 'billable', code: { text: `费用冲正：${input.reason}` },
      partOf: [{ reference: `ChargeItem/${charge.charge_id}` }], subject: { reference: `Patient/${admission.patient_id}` },
      encounter: { reference: `Encounter/${input.admissionId}` }, account: [{ reference: `Account/${input.admissionId}` }],
      occurrenceDateTime: input.virtualTime, totalPriceComponent: { amount: { value: -charge.amount_fen / 100, currency: 'CNY' } } })
    effects.push({ kind: 'created', reference: `ChargeItem/${id}`, versionId: '1' })
    return id
  }

}
