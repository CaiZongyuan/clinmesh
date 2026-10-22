import { z } from 'zod'
import type { InsuranceSource, InsuranceTarget } from '@clinmesh/contracts/insurance'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { ActorContext } from './command-executor.ts'
import { InsuranceError } from './insurance-service.ts'

/** 明确合成的普通门诊目录 v1：挂号目录外，检验先行10%，药品先行20%。 */
export function readOutpatientInsuranceSource(database: ClinMeshDatabase, context: ActorContext, target: InsuranceTarget): InsuranceSource {
  const patient=z.object({patient_id:z.string(),account_id:z.string(),encounter_id:z.string()}).optional().parse(database.driver.prepare('SELECT * FROM outpatient_case WHERE workspace_id=? AND epoch=? AND case_id=?').get(context.workspaceId,context.epoch,target.id))
  if(patient===undefined)throw new InsuranceError('INSURANCE_SOURCE_MISSING','本次门诊不存在',404)
  const charges=z.array(z.object({charge_item_id:z.string(),version:z.number().int(),total_fen:z.number().int(),description_zh:z.string(),category:z.enum(['registration','laboratory','medication']),source_reference:z.string()})).parse(database.driver.prepare(`SELECT * FROM charge_record c WHERE workspace_id=? AND epoch=? AND case_id=? AND NOT EXISTS(SELECT 1 FROM prescription_withdrawal w WHERE w.workspace_id=c.workspace_id AND w.epoch=c.epoch AND c.source_reference='Prescription/'||w.prescription_id) ORDER BY created_at,charge_id`).all(context.workspaceId,context.epoch,target.id))
  return {target,patientId:patient.patient_id,accountId:patient.account_id,encounterId:patient.encounter_id,charges:charges.map(charge=>{
    const prefix={registration:'Registration/',laboratory:'ServiceRequest/',medication:'Prescription/'}[charge.category]
    if(!charge.source_reference.startsWith(prefix))throw new InsuranceError('INSURANCE_COVERAGE_MISSING','原费用缺少合成目录映射，不可按零值结算')
    return {reference:`ChargeItem/${charge.charge_item_id}`,label:charge.description_zh,version:String(charge.version),amountFen:charge.total_fen,coverage:{code:`synthetic-op-${charge.category}:${charge.source_reference}`,version:'synthetic-op-directory-v1',included:charge.category!=='registration',priorSelfPayBps:charge.category==='laboratory'?1000:charge.category==='medication'?2000:0}}
  })}
}
