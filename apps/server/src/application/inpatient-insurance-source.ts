import { z } from 'zod'
import type { ActorContext } from './command-executor.ts'
import type { InsuranceSource } from '@clinmesh/contracts/insurance'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

// These are synthetic coverage rules, independent of prices and hospital DRG payment.
const coverageRules: Record<string, { included: boolean; priorSelfPayBps: number }> = {
  bed: { included: true, priorSelfPayBps: 0 },
  service: { included: true, priorSelfPayBps: 0 },
  laboratory: { included: true, priorSelfPayBps: 0 },
  surgery: { included: true, priorSelfPayBps: 0 },
  medication: { included: true, priorSelfPayBps: 1000 },
  imaging: { included: true, priorSelfPayBps: 1000 },
  material: { included: false, priorSelfPayBps: 0 },
}

/** Reads the authoritative inpatient charges without creating a second bill. */
export class InpatientInsuranceSource {
  constructor(private readonly owner: InpatientService) {}

  read(context: ActorContext, target: { kind: 'inpatient'; id: string }): InsuranceSource {
    const { row } = this.owner.readAdmissionBinding(context, target.id)
    const { charges } = this.owner.orders.chargeFacts(context, target.id)
    return {
      target,
      patientId: row.patient_id,
      accountId: target.id,
      encounterId: target.id,
      charges: charges.filter(charge => charge.reversalOf === undefined).map(charge => {
        const rule = coverageRules[charge.kind]
        if (rule === undefined) {
          throw new InpatientError('INSURANCE_COVERAGE_UNAVAILABLE', '该住院费用尚未配置合成医保覆盖规则')
        }
        const reversals = charges.filter(item => item.reversalOf === charge.id)
        const amountFen = z.number().int().nonnegative().safe().parse(
          charge.amountFen + reversals.reduce((sum, item) => sum + item.amountFen, 0),
        )
        return {
          reference: `ChargeItem/${charge.id}`,
          label: charge.label,
          version: canonicalJsonHash({ charge, reversals }),
          amountFen,
          coverage: { code: `synthetic-inpatient-${charge.kind}`, version: '1', ...rule },
        }
      }),
    }
  }

  assertFirstSettlementWritable(context: ActorContext, admissionId: string): void {
    const { row } = this.owner.readAdmissionBinding(context, admissionId)
    if (row.status !== 'departed' || row.financial_status !== 'open' || row.record_status === 'archived') {
      throw new InpatientError('INSURANCE_INPATIENT_STATE_CONFLICT', '仅已出区且首次财务尚未完成的住院可办理本次医保结算或撤销')
    }
  }
}
