// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InsuranceSettlement } from '@clinmesh/contracts/insurance'
import type { z } from 'zod'
import type { inpatientFinancialSchema } from '@clinmesh/contracts/inpatient-finance'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InsurancePanel } from './insurance-panel.tsx'
import { InpatientFinancialInsurance } from './inpatient-financial-insurance.tsx'

const cashierSession: SessionContext = {
  actor: {
    actorId: 'cashier-1',
    workspaceId: 'workspace-demo',
    epoch: 'epoch-1',
    scenarioRunId: 'run-1',
    practitionerRoleId: 'role-cashier',
    roleCode: 'cashier',
  },
  user: { id: 'cashier-1', name: '收费员', email: 'cashier@demo.clinmesh.local' },
  availableRoles: [],
}

const clients: QueryClient[] = []
beforeEach(() => {
  sessionStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  vi.unstubAllGlobals()
})

const mixedOutpatientSettlement: InsuranceSettlement = {
  id: 'settlement-mixed-1',
  target: { kind: 'outpatient', id: 'case-1' },
  planCode: 'employee-v1',
  year: '2026',
  source: {
    target: { kind: 'outpatient', id: 'case-1' },
    patientId: 'patient-1',
    accountId: 'account-1',
    encounterId: 'enc-1',
    charges: [
      {
        reference: 'ChargeItem/exam-ecg',
        label: '常规十二导联心电图',
        version: '1',
        amountFen: 3000,
        coverage: { code: 'synthetic-op-examination:ServiceRequest/ecg', version: 'item-v1', included: true, priorSelfPayBps: 0 },
      },
      {
        reference: 'ChargeItem/rx-mixed',
        label: '门诊药品',
        version: '1',
        amountFen: 3500,
        coverage: { code: 'synthetic-op-medication:Prescription/rx-1', version: 'synthetic-op-directory-v2', included: true, priorSelfPayBps: 0 },
        items: [
          {
            id: 'mr-1',
            label: '苯磺酸氨氯地平片',
            quantity: 10,
            amountFen: 1000,
            coverage: { code: 'synthetic-med:medication-amlodipine', version: 'item-v1', included: true, priorSelfPayBps: 0 },
          },
          {
            id: 'mr-2',
            label: '达格列净片',
            quantity: 10,
            amountFen: 2000,
            coverage: { code: 'synthetic-med:medication-dapagliflozin', version: 'item-v1', included: true, priorSelfPayBps: 1500 },
          },
          {
            id: 'mr-3',
            label: '依折麦布片',
            quantity: 5,
            amountFen: 500,
            coverage: { code: 'synthetic-med:medication-ezetimibe', version: 'item-v1', included: false, priorSelfPayBps: 0 },
          },
        ],
      },
    ],
  },
  sourceFingerprint: 'a'.repeat(64),
  allocations: [
    {
      reference: 'ChargeItem/exam-ecg',
      amountFen: 3000,
      outsideFen: 0,
      priorSelfPayFen: 0,
      eligibleFen: 3000,
      deductibleFen: 1000,
      fundFen: 1400,
      accountFen: 1600,
      patientFen: 0,
    },
    {
      reference: 'ChargeItem/rx-mixed',
      amountFen: 3500,
      outsideFen: 500,
      priorSelfPayFen: 300,
      eligibleFen: 2700,
      deductibleFen: 0,
      fundFen: 1890,
      accountFen: 400,
      patientFen: 1210,
      items: [
        {
          id: 'mr-1',
          label: '苯磺酸氨氯地平片',
          quantity: 10,
          amountFen: 1000,
          coverage: { code: 'synthetic-med:medication-amlodipine', version: 'item-v1', included: true, priorSelfPayBps: 0 },
          outsideFen: 0,
          priorSelfPayFen: 0,
          eligibleFen: 1000,
        },
        {
          id: 'mr-2',
          label: '达格列净片',
          quantity: 10,
          amountFen: 2000,
          coverage: { code: 'synthetic-med:medication-dapagliflozin', version: 'item-v1', included: true, priorSelfPayBps: 1500 },
          outsideFen: 0,
          priorSelfPayFen: 300,
          eligibleFen: 1700,
        },
        {
          id: 'mr-3',
          label: '依折麦布片',
          quantity: 5,
          amountFen: 500,
          coverage: { code: 'synthetic-med:medication-ezetimibe', version: 'item-v1', included: false, priorSelfPayBps: 0 },
          outsideFen: 500,
          priorSelfPayFen: 0,
          eligibleFen: 0,
        },
      ],
    },
  ],
  totalFen: 6500,
  fundFen: 3290,
  accountFen: 2000,
  patientFen: 1210,
  eligibleFen: 5700,
  deductibleFen: 1000,
  balanceVersion: 0,
  createdAt: '2026-11-19T09:00:00+08:00',
}

it('门诊医保面板展示混合处方甲乙丙品规明细与单项目甲类标签', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/insurance/outpatient/case-1')) {
      return Response.json({
        target: { kind: 'outpatient', id: 'case-1' },
        balance: {
          patientId: 'patient-1',
          year: '2026',
          version: 1,
          planCode: 'employee-v1',
          accountFen: 0,
          eligibleFen: 5700,
          fundFen: 3290,
          outpatientEligibleFen: 5700,
          outpatientFundFen: 3290,
          inpatientEligibleFen: 0,
          inpatientFundFen: 0,
        },
        annualBalances: [],
        active: mixedOutpatientSettlement,
        activeSettlements: [mixedOutpatientSettlement],
        history: [mixedOutpatientSettlement],
      })
    }
    return Response.json({ error: { code: 'UNEXPECTED', message: 'unexpected' } }, { status: 500 })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <InsurancePanel target={{ kind: 'outpatient', id: 'case-1' }} session={cashierSession} locale="zh-CN" onChanged={() => undefined} />
    </QueryClientProvider>,
  )
  await userEvent.setup().click(screen.getByRole('button', { name: '患者医保待遇（合成）' }))
  const region = screen.getByRole('region', { name: '患者医保待遇' })
  await screen.findByText('常规十二导联心电图')
  expect(region.textContent).toContain('甲类')
  expect(region.textContent).toContain('混合')
  expect(region.textContent).toContain('苯磺酸氨氯地平片 · 甲类')
  expect(region.textContent).toContain('达格列净片 · 乙类 15%')
  expect(region.textContent).toContain('先行 ¥3.00')
  expect(region.textContent).toContain('依折麦布片 · 丙类')
  expect(region.textContent).toContain('目录外 ¥5.00')
})

it('住院医保更正面板按品规展示甲乙丙标签与目录外/先行自付', () => {
  const inpatientSettlement: InsuranceSettlement = {
    id: 'settlement-ip-1',
    target: { kind: 'inpatient', id: 'adm-1' },
    planCode: 'employee-v1',
    year: '2026',
    source: {
      target: { kind: 'inpatient', id: 'adm-1' },
      patientId: 'patient-1',
      accountId: 'adm-1',
      encounterId: 'adm-1',
      charges: [
        {
          reference: 'ChargeItem/c-ecg',
          label: '常规十二导联心电图',
          version: 'v1',
          amountFen: 3000,
          coverage: { code: 'synthetic-inpatient-examination:examination-ecg-12-lead', version: 'item-v1', included: true, priorSelfPayBps: 0 },
        },
        {
          reference: 'ChargeItem/c-tte',
          label: '经胸超声心动图',
          version: 'v2',
          amountFen: 18000,
          coverage: { code: 'synthetic-inpatient-examination:examination-tte', version: 'item-v1', included: true, priorSelfPayBps: 1000 },
        },
        {
          reference: 'ChargeItem/c-mat',
          label: '冠脉导丝',
          version: 'v3',
          amountFen: 20000,
          coverage: { code: 'synthetic-inpatient-material:mat-1', version: 'item-v1', included: false, priorSelfPayBps: 0 },
        },
      ],
    },
    sourceFingerprint: 'b'.repeat(64),
    allocations: [
      { reference: 'ChargeItem/c-ecg', amountFen: 3000, outsideFen: 0, priorSelfPayFen: 0, eligibleFen: 3000, deductibleFen: 3000, fundFen: 0, accountFen: 2000, patientFen: 1000 },
      { reference: 'ChargeItem/c-tte', amountFen: 18000, outsideFen: 0, priorSelfPayFen: 1800, eligibleFen: 16200, deductibleFen: 2000, fundFen: 11360, accountFen: 0, patientFen: 6640 },
      { reference: 'ChargeItem/c-mat', amountFen: 20000, outsideFen: 20000, priorSelfPayFen: 0, eligibleFen: 0, deductibleFen: 0, fundFen: 0, accountFen: 0, patientFen: 20000 },
    ],
    totalFen: 41000,
    fundFen: 11360,
    accountFen: 2000,
    patientFen: 27640,
    eligibleFen: 19200,
    deductibleFen: 5000,
    balanceVersion: 0,
    createdAt: '2026-11-19T09:00:00+08:00',
  }
  const bill = {
    admissionId: 'adm-1',
    fingerprint: 'c'.repeat(64),
    financialStatus: 'settled',
    originalChargesFen: 41000,
    adjustedChargesFen: 41000,
    chargesFen: 41000,
    paidFen: 27640,
    refundedFen: 0,
    reservedFen: 0,
    reservedCollectFen: 0,
    patientDueFen: 27640,
    differenceFen: 0,
    charges: [],
    adjustments: [],
    payments: [],
    refunds: [],
    sources: [],
    insurance: {
      original: inpatientSettlement,
      active: inpatientSettlement,
      balance: {
        patientId: 'patient-1',
        year: '2026',
        version: 1,
        planCode: 'employee-v1',
        accountFen: 0,
        eligibleFen: 19200,
        fundFen: 11360,
        outpatientEligibleFen: 0,
        outpatientFundFen: 0,
        inpatientEligibleFen: 19200,
        inpatientFundFen: 11360,
      },
      sourceFingerprint: 'b'.repeat(64),
      ready: true,
      cycles: [],
    },
  } as unknown as z.infer<typeof inpatientFinancialSchema>
  render(<InpatientFinancialInsurance bill={bill} locale="zh-CN" fetching={false} />)
  const section = screen.getByRole('region', { name: '后续医保更正' })
  expect(section.textContent).toContain('常规十二导联心电图 · 甲类')
  expect(section.textContent).toContain('经胸超声心动图 · 乙类 10%')
  expect(section.textContent).toContain('先行 ¥18.00')
  expect(section.textContent).toContain('冠脉导丝 · 丙类')
  expect(section.textContent).toContain('目录外 ¥200.00')
  expect(section.querySelectorAll('ul')).toHaveLength(1)
})

it('住院医保更正面板在替代待遇确认后分别在首次固定待遇与当前待遇下渲染各自品规明细', () => {
  const originalSettlement: InsuranceSettlement = {
    id: 'settlement-ip-orig',
    target: { kind: 'inpatient', id: 'adm-2' },
    planCode: 'employee-v1',
    year: '2026',
    source: {
      target: { kind: 'inpatient', id: 'adm-2' },
      patientId: 'patient-1',
      accountId: 'adm-2',
      encounterId: 'adm-2',
      charges: [
        {
          reference: 'ChargeItem/c-orig-tte',
          label: '原经胸超声心动图',
          version: 'v1',
          amountFen: 18000,
          coverage: { code: 'synthetic-inpatient-examination:examination-tte', version: 'item-v1', included: true, priorSelfPayBps: 1000 },
        },
      ],
    },
    sourceFingerprint: 'd'.repeat(64),
    allocations: [
      { reference: 'ChargeItem/c-orig-tte', amountFen: 18000, outsideFen: 0, priorSelfPayFen: 1800, eligibleFen: 16200, deductibleFen: 5000, fundFen: 8960, accountFen: 0, patientFen: 9040 },
    ],
    totalFen: 18000,
    fundFen: 8960,
    accountFen: 0,
    patientFen: 9040,
    eligibleFen: 16200,
    deductibleFen: 5000,
    balanceVersion: 0,
    createdAt: '2026-11-19T09:00:00+08:00',
  }
  const activeSettlement: InsuranceSettlement = {
    ...originalSettlement,
    id: 'settlement-ip-repl',
    source: {
      ...originalSettlement.source,
      charges: [
        ...originalSettlement.source.charges,
        {
          reference: 'ChargeItem/c-added-ecg',
          label: '更正追加十二导联心电图',
          version: 'v2',
          amountFen: 3000,
          coverage: { code: 'synthetic-inpatient-examination:examination-ecg-12-lead', version: 'item-v1', included: true, priorSelfPayBps: 0 },
        },
      ],
    },
    sourceFingerprint: 'e'.repeat(64),
    allocations: [
      ...originalSettlement.allocations,
      { reference: 'ChargeItem/c-added-ecg', amountFen: 3000, outsideFen: 0, priorSelfPayFen: 0, eligibleFen: 3000, deductibleFen: 0, fundFen: 2400, accountFen: 0, patientFen: 600 },
    ],
    totalFen: 21000,
    fundFen: 11360,
    patientFen: 9640,
    eligibleFen: 19200,
  }
  const bill = {
    admissionId: 'adm-2',
    fingerprint: 'e'.repeat(64),
    financialStatus: 'settled',
    originalChargesFen: 18000,
    adjustedChargesFen: 21000,
    chargesFen: 21000,
    paidFen: 9640,
    refundedFen: 0,
    reservedFen: 0,
    reservedCollectFen: 0,
    patientDueFen: 9640,
    differenceFen: 0,
    charges: [],
    adjustments: [],
    payments: [],
    refunds: [],
    sources: [],
    insurance: {
      original: originalSettlement,
      active: activeSettlement,
      balance: {
        patientId: 'patient-1',
        year: '2026',
        version: 3,
        planCode: 'employee-v1',
        accountFen: 0,
        eligibleFen: 19200,
        fundFen: 11360,
        outpatientEligibleFen: 0,
        outpatientFundFen: 0,
        inpatientEligibleFen: 19200,
        inpatientFundFen: 11360,
      },
      sourceFingerprint: 'e'.repeat(64),
      ready: true,
      cycles: [],
    },
  } as unknown as z.infer<typeof inpatientFinancialSchema>
  render(<InpatientFinancialInsurance bill={bill} locale="zh-CN" fetching={false} />)
  const section = screen.getByRole('region', { name: '后续医保更正' })
  const lists = section.querySelectorAll('ul')
  expect(lists).toHaveLength(2)
  expect(lists[0]!.textContent).toContain('原经胸超声心动图 · 乙类 10%')
  expect(lists[0]!.textContent).not.toContain('更正追加十二导联心电图')
  expect(lists[1]!.textContent).toContain('更正追加十二导联心电图 · 甲类')
  const activeHeading = screen.getByTestId('financial-insurance-active')
  expect(activeHeading.nextElementSibling).toBe(lists[1])
})
