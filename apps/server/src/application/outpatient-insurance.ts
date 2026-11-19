import { z } from 'zod'
import {
  insuranceSettlementSchema,
  type InsuranceSource,
  type InsuranceTarget,
} from '@clinmesh/contracts/insurance'
import { adjustChargeItemsToTotal } from '@clinmesh/core/insurance'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import { parseFrozenCoverageJson } from './catalog-insurance-coverage.ts'
import type { ActorContext } from './command-executor.ts'
import { InsuranceError } from './insurance-service.ts'

const syntheticCoverage = {
  registration: { sourcePrefix: 'Registration/', included: false, priorSelfPayBps: 0 },
  laboratory: { sourcePrefix: 'ServiceRequest/', included: true, priorSelfPayBps: 1000 },
  examination: { sourcePrefix: 'ServiceRequest/', included: true, priorSelfPayBps: 1000 },
  imaging: { sourcePrefix: 'ServiceRequest/', included: false, priorSelfPayBps: 0 },
  pathology: { sourcePrefix: 'ServiceRequest/', included: false, priorSelfPayBps: 0 },
  medication: { sourcePrefix: 'Prescription/', included: true, priorSelfPayBps: 2000 },
} as const

const prescriptionItemRowSchema = z.object({
  medication_request_id: z.string(),
  medication_id: z.string(),
  medication_snapshot_json: z.string(),
  quantity: z.number().int().positive(),
  unit_price_fen: z.number().int().nonnegative().nullable(),
  coverage_json: z.string().nullable(),
})

function prescriptionItemLabel(snapshotJson: string, fallbackId: string): string {
  try {
    const parsed = z.object({
      genericName: z.string().min(1).optional(),
      display: z.string().min(1).optional(),
    }).safeParse(JSON.parse(snapshotJson))
    if (parsed.success) return parsed.data.genericName ?? parsed.data.display ?? fallbackId
  } catch {
    /* Fall back to medication_id when snapshot lacks display fields. */
  }
  return fallbackId
}

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

/** 优先读取原费用/处方明细冻结的品规级甲乙丙快照；仅历史 NULL 行回退分类合成规则。 */
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
        category: z.string().min(1),
        source_reference: z.string(),
        coverage_json: z.string().nullable(),
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
               SELECT 1 FROM outpatient_investigation_billing b
               JOIN laboratory_request request USING(workspace_id,epoch,request_id)
               WHERE b.workspace_id=c.workspace_id AND b.epoch=c.epoch
                 AND b.charge_item_id=c.charge_item_id AND request.status='cancelled'
             )
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
  const selectPrescriptionItems = database.driver.prepare(
    `SELECT medication_request_id, medication_id, medication_snapshot_json, quantity, unit_price_fen, coverage_json
       FROM prescription_item
       WHERE workspace_id=? AND epoch=? AND prescription_id=?
       ORDER BY rowid`,
  )
  return {
    target,
    patientId: patient.patient_id,
    accountId: patient.account_id,
    encounterId: patient.encounter_id,
    charges: charges
      .filter((charge) => !allocated.has(`ChargeItem/${charge.charge_item_id}`))
      .map((charge) => {
        const legacy = Object.hasOwn(syntheticCoverage, charge.category)
          ? syntheticCoverage[charge.category as keyof typeof syntheticCoverage]
          : undefined
        if (legacy === undefined) {
          throw new InsuranceError(
            'INSURANCE_COVERAGE_UNAVAILABLE',
            '原费用缺少合成医保目录映射，不可按零值结算',
            409,
          )
        }
        if (!charge.source_reference.startsWith(legacy.sourcePrefix))
          throw new InsuranceError(
            'INSURANCE_COVERAGE_MISSING',
            '原费用缺少合成目录映射，不可按零值结算',
          )
        const outerCode = `synthetic-op-${charge.category}:${charge.source_reference}`
        if (charge.category === 'medication') {
          const prescriptionId = charge.source_reference.slice('Prescription/'.length)
          const itemRows = z.array(prescriptionItemRowSchema).parse(
            selectPrescriptionItems.all(context.workspaceId, context.epoch, prescriptionId),
          )
          const hasFrozenItemData = itemRows.some(
            (row) => row.unit_price_fen !== null || row.coverage_json !== null,
          )
          if (hasFrozenItemData) {
            const rawItems = itemRows.map((row) => {
              const resolved = parseFrozenCoverageJson(row.coverage_json)
              if (row.unit_price_fen === null || resolved.status !== 'valid') {
                throw new InsuranceError(
                  'INSURANCE_COVERAGE_UNAVAILABLE',
                  '处方明细缺少合成医保目录映射，不可按零值结算',
                  409,
                )
              }
              return {
                id: row.medication_request_id,
                label: prescriptionItemLabel(row.medication_snapshot_json, row.medication_id),
                quantity: row.quantity,
                amountFen: row.unit_price_fen * row.quantity,
                coverage: resolved.coverage,
              }
            })
            const adjustedItems = adjustChargeItemsToTotal(rawItems, charge.amount_fen)
            const first = adjustedItems[0]!
            const single = adjustedItems.length === 1
            const anyIncluded = adjustedItems.some((item) => item.coverage.included)
            const uniform = adjustedItems.every(
              (item) =>
                item.coverage.included === first.coverage.included &&
                item.coverage.priorSelfPayBps === first.coverage.priorSelfPayBps,
            )
            return {
              reference: `ChargeItem/${charge.charge_item_id}`,
              label: charge.description_zh,
              version: String(charge.version),
              amountFen: charge.amount_fen,
              coverage: {
                code: outerCode,
                version: single ? first.coverage.version : 'synthetic-op-directory-v2',
                included: anyIncluded,
                priorSelfPayBps: uniform ? first.coverage.priorSelfPayBps : 0,
              },
              items: adjustedItems,
            }
          }
        }
        const resolved = parseFrozenCoverageJson(charge.coverage_json)
        if (resolved.status === 'invalid') {
          throw new InsuranceError(
            'INSURANCE_COVERAGE_UNAVAILABLE',
            '原费用缺少合成医保目录映射，不可按零值结算',
            409,
          )
        }
        if (resolved.status === 'valid') {
          return {
            reference: `ChargeItem/${charge.charge_item_id}`,
            label: charge.description_zh,
            version: String(charge.version),
            amountFen: charge.amount_fen,
            coverage: {
              ...resolved.coverage,
              code: outerCode,
            },
          }
        }
        return {
          reference: `ChargeItem/${charge.charge_item_id}`,
          label: charge.description_zh,
          version: String(charge.version),
          amountFen: charge.amount_fen,
          coverage: {
            code: outerCode,
            version: 'synthetic-op-directory-v1',
            included: legacy.included,
            priorSelfPayBps: legacy.priorSelfPayBps,
          },
        }
      }),
  }
}
