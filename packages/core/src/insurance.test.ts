import { describe, expect, it } from 'vitest'
import type { InsuranceSource } from '@clinmesh/contracts/insurance'
import {
  adjustChargeItemsToTotal,
  allocateInsuranceBenefits,
  InsuranceItemSumMismatchError,
  insuranceTier,
  splitItemCoverage,
} from './insurance.ts'

const freshBalance = {
  planCode: undefined,
  accountFen: 0,
  outpatientEligibleFen: 0,
  outpatientFundFen: 0,
  inpatientEligibleFen: 0,
  inpatientFundFen: 0,
}

describe('insurance pure math', () => {
  it('classifies A/B/C tiers deterministically', () => {
    expect(insuranceTier({ included: true, priorSelfPayBps: 0 })).toBe('A')
    expect(insuranceTier({ included: true, priorSelfPayBps: 1000 })).toBe('B')
    expect(insuranceTier({ included: true, priorSelfPayBps: 1500 })).toBe('B')
    expect(insuranceTier({ included: false, priorSelfPayBps: 0 })).toBe('C')
  })

  it('truncates prior self-pay in integer fen with BigInt precision', () => {
    expect(splitItemCoverage(10003, { included: true, priorSelfPayBps: 1000 })).toEqual({
      outsideFen: 0,
      priorSelfPayFen: 1000,
      eligibleFen: 9003,
    })
    expect(splitItemCoverage(333, { included: true, priorSelfPayBps: 1500 })).toEqual({
      outsideFen: 0,
      priorSelfPayFen: 49,
      eligibleFen: 284,
    })
    expect(splitItemCoverage(500, { included: false, priorSelfPayBps: 0 })).toEqual({
      outsideFen: 500,
      priorSelfPayFen: 0,
      eligibleFen: 0,
    })
  })

  it('aggregates mixed Class A + B + C prescription items onto a single ChargeItem allocation', () => {
    const source: InsuranceSource = {
      target: { kind: 'outpatient', id: 'case-1' },
      patientId: 'patient-1',
      accountId: 'account-1',
      encounterId: 'enc-1',
      charges: [
        {
          reference: 'ChargeItem/rx-1',
          label: '门诊药品',
          version: '1',
          amountFen: 3500,
          coverage: { code: 'synthetic-op-medication:Prescription/rx-1', version: 'synthetic-op-directory-v2', included: true, priorSelfPayBps: 0 },
          items: [
            { id: 'mr-1', label: '苯磺酸氨氯地平片', quantity: 10, amountFen: 1000, coverage: { code: 'synthetic-med:medication-amlodipine', version: 'item-v1', included: true, priorSelfPayBps: 0 } },
            { id: 'mr-2', label: '达格列净片', quantity: 10, amountFen: 2000, coverage: { code: 'synthetic-med:medication-dapagliflozin', version: 'item-v1', included: true, priorSelfPayBps: 1500 } },
            { id: 'mr-3', label: '依折麦布片', quantity: 5, amountFen: 500, coverage: { code: 'synthetic-med:medication-ezetimibe', version: 'item-v1', included: false, priorSelfPayBps: 0 } },
          ],
        },
      ],
    }
    const [allocation] = allocateInsuranceBenefits({ source, planCode: 'employee-v1', balance: freshBalance })
    expect(allocation).toMatchObject({
      reference: 'ChargeItem/rx-1',
      amountFen: 3500,
      outsideFen: 500,
      priorSelfPayFen: 300,
      eligibleFen: 2700,
      deductibleFen: 1000,
      fundFen: 1190,
      accountFen: 1810,
      patientFen: 500,
    })
    expect(allocation!.fundFen + allocation!.accountFen + allocation!.patientFen).toBe(3500)
    expect(allocation!.items).toEqual([
      expect.objectContaining({ label: '苯磺酸氨氯地平片', outsideFen: 0, priorSelfPayFen: 0, eligibleFen: 1000 }),
      expect.objectContaining({ label: '达格列净片', outsideFen: 0, priorSelfPayFen: 300, eligibleFen: 1700 }),
      expect.objectContaining({ label: '依折麦布片', outsideFen: 500, priorSelfPayFen: 0, eligibleFen: 0 }),
    ])
  })

  it('rejects mismatched item sums instead of silently overriding', () => {
    const source: InsuranceSource = {
      target: { kind: 'outpatient', id: 'case-1' },
      patientId: 'patient-1',
      accountId: 'account-1',
      encounterId: 'enc-1',
      charges: [
        {
          reference: 'ChargeItem/rx-1',
          label: '门诊药品',
          version: '1',
          amountFen: 1000,
          coverage: { code: 'synthetic-op-medication:Prescription/rx-1', version: 'v2', included: true, priorSelfPayBps: 0 },
          items: [
            { label: '对乙酰氨基酚片', amountFen: 900, coverage: { code: 'm1', version: 'v1', included: true, priorSelfPayBps: 0 } },
          ],
        },
      ],
    }
    expect(() => allocateInsuranceBenefits({ source, planCode: 'employee-v1', balance: freshBalance }))
      .toThrow(InsuranceItemSumMismatchError)
  })

  it('distributes cashier adjustments proportionally and deterministically in integer fen', () => {
    const items = [
      { id: 'a', amountFen: 100 },
      { id: 'b', amountFen: 100 },
      { id: 'c', amountFen: 100 },
    ]
    expect(adjustChargeItemsToTotal(items, 200)).toEqual([
      { id: 'a', amountFen: 67 },
      { id: 'b', amountFen: 67 },
      { id: 'c', amountFen: 66 },
    ])
    expect(adjustChargeItemsToTotal(items, 0)).toEqual([
      { id: 'a', amountFen: 0 },
      { id: 'b', amountFen: 0 },
      { id: 'c', amountFen: 0 },
    ])
    expect(adjustChargeItemsToTotal(items, 300)).toEqual(items)
  })
})
