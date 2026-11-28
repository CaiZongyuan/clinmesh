// @vitest-environment jsdom

import type { SessionContext } from '@clinmesh/contracts/his'
import { toast, Toaster } from '@clinmesh/ui/components/toast'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createAgent } from '@ui-sdk/react/agent'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BillingWorkspace } from './billing-workspace.tsx'
import { OutpatientClinicalScoresDisclosure } from './clinical-scores-panel.tsx'
import { PatientCaseTruth } from './patient-case-truth.tsx'
import { PharmacyWorkspace } from './pharmacy-workspace.tsx'
import { ScenarioResetControl } from './scenario-reset-control.tsx'
import { TriageWorkspace } from './triage-workspace.tsx'
import { WebApp } from './web-app.tsx'
import { getWorkspaceMessages } from './workspace-i18n.ts'

declare global {
  var __UI_SDK_STRICT__: boolean | undefined
}

let allowConfirm = false
const confirmPrompts: string[] = []

const agent = createAgent({
  allow: (step) => {
    if (!step.confirm) return true
    confirmPrompts.push(step.confirm)
    return allowConfirm
  },
})

function liveComponents() {
  return agent
    .snapshot()
    .filter((entry) => !entry.offPage && entry.component !== 'more')
}

function expectEveryComponentNamed() {
  const entries = liveComponents()
  expect(entries.length).toBeGreaterThan(0)
  for (const entry of entries) {
    expect(
      entry.label,
      `${entry.component} (${entry.ref}) is missing an accessible label`,
    ).toBeTruthy()
  }
  return entries
}

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  })
}

function commandResponse<Data>(data: Data) {
  return {
    auditId: 'audit-agent-1',
    data,
    effects: [],
    requestId: 'request-agent-1',
    warnings: [],
  }
}

const pagination = (total: number) => ({ page: 1, pageSize: 20, total })

const samplePatient = {
  birthDate: '1990-05-10',
  gender: 'male' as const,
  id: 'patient-1',
  identifier: 'CM-SYN-001',
  name: '合成患者周明',
  synthetic: true as const,
  versionId: '1',
}

function makeSession(roleCode: SessionContext['actor']['roleCode'], name: string): SessionContext {
  return {
    actor: {
      actorId: `actor-${roleCode}`,
      epoch: 'epoch-1',
      locationId: `location-${roleCode}`,
      organizationId: 'organization-clinmesh',
      practitionerId: `practitioner-${roleCode}`,
      practitionerRoleId: `practitioner-role-${roleCode}`,
      roleCode,
      scenarioRunId: 'scenario-run-1',
      workspaceId: 'workspace-demo',
    },
    availableRoles: [{
      code: roleCode,
      id: `practitioner-role-${roleCode}`,
      locationId: `location-${roleCode}`,
      organizationId: 'organization-clinmesh',
      practitionerId: `practitioner-${roleCode}`,
      practitionerName: name,
    }],
    user: {
      email: `${roleCode}@demo.clinmesh.local`,
      id: `user-${roleCode}`,
      name,
    },
  }
}

let previousStrictMode: boolean | undefined

beforeAll(() => {
  previousStrictMode = globalThis.__UI_SDK_STRICT__
  globalThis.__UI_SDK_STRICT__ = true
})

afterAll(() => {
  globalThis.__UI_SDK_STRICT__ = previousStrictMode
})

beforeEach(() => {
  allowConfirm = false
  confirmPrompts.length = 0
  localStorage.clear()
  vi.stubGlobal('scrollTo', vi.fn())
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
    matches: false,
    media: '',
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn(),
  })))
})

afterEach(() => {
  toast.dismiss()
  cleanup()
  vi.restoreAllMocks()
})

describe('Agent-ready UI SDK contracts', () => {
  it('names sign-in inputs, updates DOM via agent.act, and redacts data-agent-secret password values', async () => {
    const messages = getWorkspaceMessages('zh-CN')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/auth/context') {
        return new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Sign in required' } }), {
          headers: { 'content-type': 'application/json' },
          status: 401,
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))

    render(<WebApp />)
    await screen.findByLabelText(messages.passwordLabel)

    const entries = expectEveryComponentNamed()
    const labels = entries.map((entry) => entry.label)
    expect(labels).toContain(messages.emailLabel)
    expect(labels).toContain(messages.passwordLabel)

    const actResult = await agent.act({
      steps: [
        { action: 'setValue', args: ['doctor@demo.clinmesh.local'], ref: messages.emailLabel },
        { action: 'setValue', args: ['synthetic-secret-pass'], ref: messages.passwordLabel },
      ],
    })
    expect(actResult.ok, actResult.error?.message).toBe(true)

    expect(screen.getByLabelText<HTMLInputElement>(messages.emailLabel).value).toBe('doctor@demo.clinmesh.local')
    expect(screen.getByLabelText<HTMLInputElement>(messages.passwordLabel).value).toBe('synthetic-secret-pass')

    const passwordSnapshot = liveComponents().find((entry) => entry.label === messages.passwordLabel)
    expect(passwordSnapshot).toBeDefined()
    expect(JSON.stringify(passwordSnapshot)).not.toContain('synthetic-secret-pass')
  })

  it('hides administrator case truth controls from agent.snapshot via data-agent-hidden', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unavailable', { status: 500 })))
    const queryClient = createTestQueryClient()

    render(
      <QueryClientProvider client={queryClient}>
        <PatientCaseTruth caseId="case-truth-1" locale="zh-CN" />
      </QueryClientProvider>,
    )

    const summary = screen.getByText('本次病例真值')
    const details = summary.closest('details')
    expect(details?.hasAttribute('data-agent-hidden')).toBe(true)
    if (details) {
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    }
    await screen.findByRole('button', { name: '重试' })

    expect(liveComponents()).toEqual([])
  })

  it('gates ScenarioResetControl confirm button with data-agent-confirm while allowing the dialog trigger and checkbox', async () => {
    const onReset = vi.fn(async () => undefined)
    render(
      <ScenarioResetControl
        disabled={false}
        error={null}
        locale="zh-CN"
        onReset={onReset}
        pending={false}
      />,
    )

    expectEveryComponentNamed()

    const openResult = await agent.act({
      steps: [{ action: 'press', ref: '重置数据' }],
    })
    expect(openResult.ok, openResult.error?.message).toBe(true)
    await screen.findByRole('alertdialog')

    const toggleResult = await agent.act({
      steps: [{ action: 'setChecked', args: [true], ref: '同时清空合成患者库' }],
    })
    expect(toggleResult.ok, toggleResult.error?.message).toBe(true)

    allowConfirm = false
    const denied = await agent.act({
      steps: [{ action: 'press', ref: '确认重置' }],
    })
    expect(denied.ok).toBe(false)
    expect(onReset).not.toHaveBeenCalled()
    expect(confirmPrompts).toContain('确认重置场景数据')

    // Reopen if refusal closed the dialog, keep checkbox checked, then approve.
    if (!screen.queryByRole('alertdialog')) {
      await agent.act({
        steps: [
          { action: 'press', ref: '重置数据' },
          { action: 'setChecked', args: [true], ref: '同时清空合成患者库' },
        ],
      })
    }
    allowConfirm = true
    const approved = await agent.act({
      steps: [{ action: 'press', ref: '确认重置' }],
    })
    expect(approved.ok, approved.error?.message).toBe(true)
    await waitFor(() => expect(onReset).toHaveBeenCalledWith(true))
  })

  it('lets an agent read and update clinical risk selects inside OutpatientClinicalScoresDisclosure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/his/v1/doctor/cases/case-1/clinical-scores') {
        return Response.json({
          encounterId: 'enc-1',
          encounterVersion: '3',
          evaluatedAt: '2026-10-25T10:00:00+08:00',
          riskAssessment: {
            effectiveStSegmentDeviation: null,
            observationId: null,
            observationVersion: null,
            provenanceId: null,
            recordedAt: null,
            recordedBy: null,
            revision: 0,
            values: {
              anginaEpisodes24h: null,
              aspirinUsedLast7Days: null,
              cardiacArrestOnAdmission: null,
              killipClass: null,
              priorBleedingHistory: null,
              smokingStatus: null,
              stSegmentDeviation: null,
            },
          },
          scores: ([
            'ckd-epi-2021-egfr',
            'cockcroft-gault-crcl',
            'grace-acs',
            'timi-ua-nstemi',
            'precise-dapt',
            'ascvd-ldl-target',
          ] as const).map((id) => ({
            id,
            missingInputs: ['weightKg'],
            sourceReferences: [],
            status: 'incomplete' as const,
            summaryEn: 'Missing required inputs: Body weight (kg)',
            summaryZh: '待补齐：体重 (kg)',
            tierCode: null,
            tierLabelEn: null,
            tierLabelZh: null,
            titleEn: id,
            titleZh: id,
            unit: '分',
            value: null,
          })),
          vitalSigns: null,
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))

    const queryClient = createTestQueryClient()

    render(
      <QueryClientProvider client={queryClient}>
        <OutpatientClinicalScoresDisclosure
          caseId="case-1"
          clinicalRevision="rev-1"
          encounterId="enc-1"
          encounterVersion="3"
          locale="zh-CN"
          readOnly={false}
          scope="scope-agent-1"
        />
      </QueryClientProvider>,
    )

    const disclosure = screen.getByText('专病风险评估与临床评分').closest('details')!
    disclosure.open = true
    disclosure.dispatchEvent(new Event('toggle'))

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Killip 分级' }).hasAttribute('disabled')).toBe(false)
    })
    expectEveryComponentNamed()

    const selectResult = await agent.act({
      steps: [{ action: 'setValue', args: ['Killip II'], ref: 'Killip 分级' }],
    })
    expect(selectResult.ok, selectResult.error?.message).toBe(true)
    expect(screen.getByRole('combobox', { name: 'Killip 分级' }).textContent).toContain('Killip II')
  })

  it('operates TriageWorkspace controls via agent.act and blocks/permits completeTriage via data-agent-confirm', async () => {
    const messages = getWorkspaceMessages('zh-CN')
    let triagePostCount = 0
    let lastTriageBody: Record<string, unknown> | undefined
    const queueItem = {
      arrivedAt: '2026-08-24T09:00:00+08:00',
      caseId: 'case-1',
      department: { id: 'dept-1', nameEn: 'General Medicine', nameZh: '全科医学科' },
      encounterId: 'encounter-1',
      encounterVersion: '1',
      location: { id: 'loc-1', nameEn: 'Clinic', nameZh: '门诊诊疗区' },
      patient: samplePatient,
      registrationNumber: 'CM-OP-20260824-0001',
      riskFlags: [],
      status: 'awaiting-triage',
      taskId: 'task-triage-1',
      taskVersion: '1',
      visitType: { id: 'visit-1', nameEn: 'General', nameZh: '普通门诊挂号费' },
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/his/v1/triage/queue') {
        const status = url.searchParams.get('status') ?? 'pending'
        const hasItem = status === (triagePostCount > 0 ? 'completed' : 'pending')
        return Response.json({ items: hasItem ? [queueItem] : [], ...pagination(hasItem ? 1 : 0) })
      }
      if (url.pathname === '/api/his/v1/encounters/encounter-1/actions/record-triage') {
        triagePostCount += 1
        lastTriageBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json(commandResponse({
          doctorTaskId: 'task-doctor-1',
          encounterId: 'encounter-1',
          encounterVersion: '2',
          observationId: 'obs-1',
          status: 'awaiting-doctor',
        }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))

    const queryClient = createTestQueryClient()
    render(
      <QueryClientProvider client={queryClient}>
        <TriageWorkspace locale="zh-CN" session={makeSession('triage-nurse', '合成护士')} />
        <Toaster />
      </QueryClientProvider>,
    )

    await screen.findByLabelText(messages.chiefComplaint)
    const entries = expectEveryComponentNamed()
    const acuityEntry = entries.find((entry) => entry.label === messages.acuity)
    expect(acuityEntry).toBeDefined()

    const fillResult = await agent.act({
      steps: [
        { action: 'toggle', ref: '三级 · 急症' },
        { action: 'setValue', args: ['发热伴咽痛两天'], ref: messages.chiefComplaint },
        { action: 'setValue', args: ['38.2'], ref: messages.temperatureC },
        { action: 'setValue', args: ['92'], ref: messages.pulseBpm },
        { action: 'setValue', args: ['18'], ref: messages.respirationBpm },
        { action: 'setValue', args: ['118'], ref: messages.systolicMmHg },
        { action: 'setValue', args: ['78'], ref: messages.diastolicMmHg },
        { action: 'setValue', args: ['98'], ref: messages.oxygenSaturationPct },
      ],
    })
    expect(fillResult.ok, fillResult.error?.message).toBe(true)

    allowConfirm = false
    const denied = await agent.act({
      steps: [{ action: 'press', ref: messages.completeTriage }],
    })
    expect(denied.ok).toBe(false)
    expect(triagePostCount).toBe(0)
    expect(confirmPrompts).toContain(messages.completeTriage)

    allowConfirm = true
    const approved = await agent.act({
      steps: [{ action: 'press', ref: messages.completeTriage }],
    })
    expect(approved.ok, approved.error?.message).toBe(true)
    await waitFor(() => expect(triagePostCount).toBe(1))
    expect(lastTriageBody?.input).toMatchObject({
      acuityCode: 'level-3',
      chiefComplaint: '发热伴咽痛两天',
      temperatureC: 38.2,
    })
  })

  it('gates BillingWorkspace payment commit behind data-agent-confirm while allowing preview trigger', async () => {
    const messages = getWorkspaceMessages('zh-CN')
    let confirmCalls = 0
    const queueItem = {
      accountId: 'account-1',
      amountFen: 6800,
      caseId: 'case-1',
      category: 'laboratory' as const,
      chargeItemId: 'charge-laboratory-1',
      chargeVersion: 1,
      descriptionEn: 'Fever laboratory panel',
      descriptionZh: '发热检验组合',
      encounterId: 'encounter-1',
      lines: [{
        descriptionEn: 'Fever laboratory panel',
        descriptionZh: '发热检验组合',
        quantity: 1,
        sourceReference: 'ServiceRequest/service-request-1',
        subtotalFen: 6800,
        unitPriceFen: 6800,
      }],
      patient: samplePatient,
      price: {
        currency: 'CNY' as const,
        effectiveOn: '2026-08-24',
        id: 'synthetic-price',
        priceFen: 6800,
        source: 'synthetic-outpatient-investigation-2026-10-26-v1',
        unit: '项目',
        version: 1,
      },
      requestId: 'original-request-1',
      sourceReference: 'ServiceRequest/service-request-1',
      status: 'billable' as const,
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/his/v1/billing/queue') {
        const hasItem = url.searchParams.get('status') === (confirmCalls > 0 ? 'paid' : 'pending')
        return Response.json({ items: hasItem ? [queueItem] : [], ...pagination(hasItem ? 1 : 0) })
      }
      if (url.pathname === '/api/his/v1/billing/cases/case-1') {
        return Response.json({
          accountId: 'account-1',
          caseId: 'case-1',
          charges: [{ ...queueItem, paidFen: confirmCalls > 0 ? 6800 : 0, remainingFen: confirmCalls > 0 ? 0 : 6800 }],
          encounterId: 'encounter-1',
          paidFen: confirmCalls > 0 ? 6800 : 0,
          patient: samplePatient,
          payments: [],
          paymentsPagination: pagination(0),
          remainingFen: confirmCalls > 0 ? 0 : 6800,
          totalFen: 6800,
        })
      }
      if (url.pathname === '/api/his/v1/payments/actions/preview') {
        return Response.json(commandResponse({
          allocations: [{ amountFen: 6800, chargeItemId: 'charge-laboratory-1' }],
          amountFen: 6800,
          channel: 'synthetic-payment',
          chargeItemId: 'charge-laboratory-1',
          chargeVersion: 1,
          commitToken: 'payment-preview-token-123456',
          expectedOutcome: 'success',
          expiresAt: '2026-08-24T09:05:00+08:00',
          previewId: 'payment-preview-1',
        }))
      }
      if (url.pathname === '/api/his/v1/payments/payment-preview-1/actions/confirm') {
        confirmCalls += 1
        return Response.json(commandResponse({
          amountFen: 6800,
          outcome: 'success',
          paymentId: 'payment-1',
          status: 'awaiting-lis',
        }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))

    const queryClient = createTestQueryClient()
    render(
      <QueryClientProvider client={queryClient}>
        <BillingWorkspace locale="zh-CN" session={makeSession('cashier', '合成收费员')} />
        <Toaster />
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: messages.previewPayment }).hasAttribute('disabled')).toBe(false)
    })
    expectEveryComponentNamed()

    const previewStep = await agent.act({
      steps: [{ action: 'press', ref: messages.previewPayment }],
    })
    expect(previewStep.ok, previewStep.error?.message).toBe(true)
    await screen.findByRole('button', { name: messages.confirmPayment })

    const openConfirmStep = await agent.act({
      steps: [{ action: 'press', ref: messages.confirmPayment }],
    })
    expect(openConfirmStep.ok, openConfirmStep.error?.message).toBe(true)
    await screen.findByRole('region', { name: messages.confirmPaymentTitle })

    allowConfirm = false
    const denied = await agent.act({
      steps: [{ action: 'press', ref: messages.submitPayment }],
    })
    expect(denied.ok).toBe(false)
    expect(confirmCalls).toBe(0)
    expect(confirmPrompts).toContain(messages.submitPayment)

    allowConfirm = true
    const approved = await agent.act({
      steps: [{ action: 'press', ref: messages.submitPayment }],
    })
    expect(approved.ok, approved.error?.message).toBe(true)
    await waitFor(() => expect(confirmCalls).toBe(1))
  })

  it('gates PharmacyWorkspace prescription approval behind data-agent-confirm after agent fills review note', async () => {
    const messages = getWorkspaceMessages('zh-CN')
    let reviewCalls = 0
    const pendingPrescription = {
      allergyWarnings: [],
      authoredBy: 'actor-outpatient-doctor',
      caseId: 'case-1',
      encounterId: 'encounter-1',
      encounterStatus: 'completed',
      encounterVersion: '7',
      medications: [{
        dispensedQuantity: 0,
        doseText: '75 mg',
        frequencyCode: 'BID',
        lots: [{
          expiresOn: '2027-12-31',
          id: 'lot-oseltamivir-001',
          locationId: 'location-pharmacist',
          lotNumber: 'SYN-OS-001',
          quantityOnHand: 1000,
          version: 1,
        }],
        medicationId: 'medication-oseltamivir',
        medicationRequestId: 'medication-request-1',
        medicationRequestVersion: '2',
        nameEn: 'Oseltamivir capsules',
        nameZh: '磷酸奥司他韦胶囊',
        quantity: 10,
        remainingQuantity: 10,
        routeCode: 'PO',
        unitPriceFen: 760,
      }],
      patient: samplePatient,
      prescriptionId: 'prescription-1',
      prescriptionNumber: 'CM-RX-20260824-0001',
      prescriptionStatus: 'paid',
      prescriptionVersion: 3,
      status: 'awaiting-review',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/his/v1/pharmacy/queue') {
        const hasItem = url.searchParams.get('status') !== 'completed'
        return Response.json({
          items: hasItem ? [{
            ...pendingPrescription,
            prescriptionVersion: 3 + reviewCalls,
            ...(reviewCalls > 0 ? {
              review: {
                note: '已核对剂量与禁忌。',
                reviewId: 'prescription-review-1',
                reviewedAt: '2026-08-24T10:00:00+08:00',
                reviewedBy: 'actor-pharmacist',
              },
              status: 'awaiting-dispense',
            } : {}),
          }] : [],
          ...pagination(hasItem ? 1 : 0),
        })
      }
      if (url.pathname === '/api/his/v1/prescriptions/prescription-1/actions/review') {
        reviewCalls += 1
        return Response.json(commandResponse({
          prescriptionId: 'prescription-1',
          prescriptionVersion: 4,
          reviewId: 'prescription-review-1',
          status: 'awaiting-dispense',
        }))
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))

    const queryClient = createTestQueryClient()
    render(
      <QueryClientProvider client={queryClient}>
        <PharmacyWorkspace locale="zh-CN" session={makeSession('pharmacist', '合成药师')} />
        <Toaster />
      </QueryClientProvider>,
    )

    await screen.findByLabelText(messages.reviewNote)
    expectEveryComponentNamed()

    const prepareResult = await agent.act({
      steps: [
        { action: 'setValue', args: ['已核对剂量与禁忌。'], ref: messages.reviewNote },
        { action: 'press', ref: '审核处方' },
      ],
    })
    expect(prepareResult.ok, prepareResult.error?.message).toBe(true)
    await screen.findByRole('button', { name: messages.approvePrescription })

    allowConfirm = false
    const denied = await agent.act({
      steps: [{ action: 'press', ref: messages.approvePrescription }],
    })
    expect(denied.ok).toBe(false)
    expect(reviewCalls).toBe(0)
    expect(confirmPrompts).toContain(messages.approvePrescription)

    allowConfirm = true
    const approved = await agent.act({
      steps: [{ action: 'press', ref: messages.approvePrescription }],
    })
    expect(approved.ok, approved.error?.message).toBe(true)
    await waitFor(() => expect(reviewCalls).toBe(1))
  })
})
