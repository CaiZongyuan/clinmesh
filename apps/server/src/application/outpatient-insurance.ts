import { z } from 'zod'
import {
  insuranceSettlementSchema,
  type InsuranceSource,
  type InsuranceTarget,
} from '@clinmesh/contracts/insurance'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { ActorContext } from './command-executor.ts'
import { InsuranceError } from './insurance-service.ts'

const syntheticCoverage = {
  registration: { sourcePrefix: 'Registration/', included: false, priorSelfPayBps: 0 },
  laboratory: { sourcePrefix: 'ServiceRequest/', included: true, priorSelfPayBps: 1000 },
  imaging: { sourcePrefix: 'ServiceRequest/', included: false, priorSelfPayBps: 0 },
  pathology: { sourcePrefix: 'ServiceRequest/', included: false, priorSelfPayBps: 0 },
  medication: { sourcePrefix: 'Prescription/', included: true, priorSelfPayBps: 2000 },
} as const

export function readOutpatientInsuranceAllocations(
  database: ClinMeshDatabase,
  context: ActorContext,
  caseId: string,
) {
  const activeRows = z.array(z.object({ data_json: z.string() })).parse(
    database.driver
      .prepare(
        `SELECT data_json FROM insurance_event e
           WHERE workspace_id=? AND epoch=? AND target_kind='outpatient' AND target_id=?
             AND reverses_id IS NULL
             AND NOT EXISTS(
               SELECT 1 FROM insurance_event r
               WHERE r.workspace_id=e.workspace_id AND r.epoch=e.epoch
                 AND r.reverses_id=e.event_id
             )`,
      )
      .all(context.workspaceId, context.epoch, caseId),
  )
  return new Set(
    activeRows.flatMap((row) =>
      insuranceSettlementSchema
        .parse(JSON.parse(row.data_json))
        .allocations.map((item) => item.reference),
    ),
  )
}

/** 明确合成的普通门诊目录 v1：挂号目录外，检验先行10%，药品先行20%。 */
export function readOutpatientInsuranceSource(
  database: ClinMeshDatabase,
  context: ActorContext,
  target: InsuranceTarget,
): InsuranceSource {
  const patient = z
    .object({ patient_id: z.string(), account_id: z.string(), encounter_id: z.string() })
    .optional()
    .parse(
      database.driver
        .prepare('SELECT * FROM outpatient_case WHERE workspace_id=? AND epoch=? AND case_id=?')
        .get(context.workspaceId, context.epoch, target.id),
    )
  if (patient === undefined)
    throw new InsuranceError('INSURANCE_SOURCE_MISSING', '本次门诊不存在', 404)
  const charges = z
    .array(
      z.object({
        charge_item_id: z.string(),
        version: z.number().int(),
        amount_fen: z.number().int().nonnegative(),
        description_zh: z.string(),
        category: z.enum(['registration', 'laboratory', 'imaging', 'pathology', 'medication']),
        source_reference: z.string(),
      }),
    )
    .parse(
      database.driver
        .prepare(
          `SELECT c.*, c.total_fen - COALESCE((
             SELECT SUM(adjustment.amount_fen) FROM financial_charge_adjustment adjustment
             WHERE adjustment.workspace_id=c.workspace_id AND adjustment.epoch=c.epoch
               AND adjustment.charge_item_id=c.charge_item_id
           ),0) AS amount_fen FROM charge_record c
           WHERE c.workspace_id=? AND c.epoch=? AND c.case_id=?
             AND NOT EXISTS(
               SELECT 1 FROM prescription_withdrawal w
               WHERE w.workspace_id=c.workspace_id AND w.epoch=c.epoch
                 AND c.source_reference='Prescription/'||w.prescription_id
             )
           ORDER BY created_at,charge_id`,
        )
        .all(context.workspaceId, context.epoch, target.id),
    )
  const allocated = readOutpatientInsuranceAllocations(database, context, target.id)
  return {
    target,
    patientId: patient.patient_id,
    accountId: patient.account_id,
    encounterId: patient.encounter_id,
    charges: charges
      .filter((charge) => !allocated.has(`ChargeItem/${charge.charge_item_id}`))
      .map((charge) => {
        const coverage = syntheticCoverage[charge.category]
        if (!charge.source_reference.startsWith(coverage.sourcePrefix))
          throw new InsuranceError(
            'INSURANCE_COVERAGE_MISSING',
            '原费用缺少合成目录映射，不可按零值结算',
          )
        return {
          reference: `ChargeItem/${charge.charge_item_id}`,
          label: charge.description_zh,
          version: String(charge.version),
          amountFen: charge.amount_fen,
          coverage: {
            code: `synthetic-op-${charge.category}:${charge.source_reference}`,
            version: 'synthetic-op-directory-v1',
            included: coverage.included,
            priorSelfPayBps: coverage.priorSelfPayBps,
          },
        }
      }),
  }
}
