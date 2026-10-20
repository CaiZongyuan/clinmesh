import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import type { ActorContext } from './command-executor.ts'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository } from '../infrastructure/sqlite/fhir-repository.ts'

export type InpatientEffects = Array<{ kind: 'created' | 'updated'; reference: string; versionId: string }>
/** 调用者持有 Command 事务；费用与 FHIR 投影一起提交。 */
export class InpatientBilling {
  constructor(readonly database: ClinMeshDatabase, readonly fhir: FhirRepository) {}
  record(context: ActorContext, input: { admissionId: string; organizationId: string; kind: 'bed' | 'medication' | 'service'; sourceId: string;
    serviceDate: string; amountFen: number; virtualTime: string; label: string }, effects: InpatientEffects): boolean {
    const amount = z.number().int().nonnegative().safe().parse(input.amountFen)
    const patient = z.object({ patient_id: z.string() }).parse(this.database.driver.prepare(
      'SELECT patient_id FROM inpatient_admission WHERE workspace_id=? AND epoch=? AND admission_id=?').get(context.workspaceId, context.epoch, input.admissionId))
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
}
