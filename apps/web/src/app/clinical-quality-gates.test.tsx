// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClinicalOverrideInput, ClinicalQualityCheck } from '@clinmesh/contracts/clinical-quality'
import type { DoctorRecommendationState } from '@clinmesh/contracts/doctor-recommendations'
import type { ClinicalCatalog, DoctorCaseDetail, EncounterCompletionPreview, SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientAngiographyReportsSchema } from '@clinmesh/contracts/inpatient-angiography'
import { inpatientMaterialEstimatesSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientSurgeryRequestSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { AgentPageRegistryProvider } from './agent-page-context.tsx'
import { AgentReviewProvider, useAgentReview, type AgentReviewTask } from './agent-review.tsx'
import { ApiClientError } from './api-client.ts'
import { ClinicalQualityBanner } from './clinical-quality-banner.tsx'
import { DoctorCompletionActionBar } from './doctor/doctor-completion-action.tsx'
import { PrescriptionPage, type PrescriptionPageActions } from './doctor/prescription-page.tsx'
import { InpatientClinical, isHandledInpatientRejection } from './inpatient-clinical.tsx'
import { InpatientDischarge } from './inpatient-discharge.tsx'
import { InpatientPciSelection } from './inpatient-pci-selection.tsx'
import { InpatientRecord } from './inpatient-record.tsx'
import { InpatientSurgery } from './inpatient-surgery.tsx'
import { InpatientActionOutlet, InpatientActionProvider } from './inpatient-workspace-actions.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { getWorkspaceMessages } from './workspace-i18n.ts'

const sampleRedLineCheck: ClinicalQualityCheck = {
  evaluatedAt: '2026-11-18T10:00:00+08:00',
  gate: 'outpatient-prescription',
  status: 'blocked',
  redLines: [{
    code: 'RENAL_CONTRAINDICATED_MEDICATION',
    tier: 'red-line',
    catalogItemId: 'medication-metformin',
    message: '患者已证实 eGFR 21.4 mL/min/1.73m²（< 30），严禁开立盐酸二甲双胍片。',
    evidence: [{ label: 'CKD-EPI 2021 eGFR 21.4', reference: 'Observation/obs-scr-1', versionId: '1' }],
  }],
  alerts: [],
}

const sampleCompletionAlertCheck: ClinicalQualityCheck = {
  evaluatedAt: '2026-11-18T10:05:00+08:00',
  gate: 'outpatient-completion',
  status: 'alert',
  redLines: [],
  alerts: [{
    code: 'CHEST_PAIN_WORKUP_INCOMPLETE',
    tier: 'alert',
    message: '急性胸痛尚未完成已签发 12 导联心电图及心肌损伤标志物评估。',
    evidence: [{ label: '主诉：突发胸痛 2 小时', reference: 'Encounter/enc-1', versionId: '3' }],
  }],
}

const sampleDischargeAlertCheck: ClinicalQualityCheck = {
  evaluatedAt: '2026-11-18T11:00:00+08:00',
  gate: 'inpatient-discharge',
  status: 'alert',
  redLines: [],
  alerts: [
    {
      code: 'DISCHARGE_ANTIPLATELET_MISSING',
      tier: 'alert',
      message: '冠心病或 PCI 患者出院前尚未开立在用长期抗血小板医嘱。',
      evidence: [{ label: '主诊断 I25.103', reference: 'Condition/cond-cad-1' }],
    },
    {
      code: 'DISCHARGE_STATIN_MISSING',
      tier: 'alert',
      message: '冠心病或 PCI 患者出院前尚未开立在用长期他汀调脂医嘱。',
      evidence: [{ label: '主诊断 I25.103', reference: 'Condition/cond-cad-1' }],
    },
  ],
}

const inpatientDoctorSession: SessionContext = {
  actor: {
    actorId: 'actor-inpatient-doctor',
    epoch: 'epoch-quality-1',
    locationId: 'ward-general',
    organizationId: 'dept-cardiology',
    practitionerId: 'practitioner-ip-1',
    practitionerRoleId: 'role-inpatient-doctor-1',
    roleCode: 'inpatient-doctor',
    scenarioRunId: 'run-quality-1',
    workspaceId: 'workspace-quality-1',
  },
  availableRoles: [{
    code: 'inpatient-doctor',
    id: 'role-inpatient-doctor-1',
    locationId: 'ward-general',
    organizationId: 'dept-cardiology',
    practitionerId: 'practitioner-ip-1',
    practitionerName: '合成住院医生',
  }],
  user: {
    email: 'inpatient-doctor@demo.clinmesh.local',
    id: 'user-ip-doc-1',
    name: '合成住院医生',
  },
}

const sampleAdmission: InpatientAdmission = {
  id: 'adm-quality-1',
  versionId: '3',
  inpatientNumber: 'IP-20261118-001',
  patientId: 'pat-quality-1',
  patientName: '合成冠脉患者',
  patientGender: 'male',
  patientBirthDate: '1962-04-12',
  wardId: 'ward-general',
  organizationId: 'dept-cardiology',
  bedId: 'bed-1',
  status: 'admitted',
  financialStatus: 'open',
  recordStatus: 'open',
  admissionRoute: 'direct',
  registeredAt: '2026-11-18T07:30:00+08:00',
  admittedAt: '2026-11-18T08:00:00+08:00',
  depositFen: 100000,
  chargesFen: 0,
  outstandingFen: 0,
}

type OutpatientMedication = Extract<ClinicalCatalog, { prescriptionConclusionSupported: true }>['medications'][number]

const sampleOutpatientMedication: OutpatientMedication = {
  allowedCombinationIds: [],
  allowedCourseDays: [7, 14],
  allowedDoseTexts: ['500 mg'],
  allowedFrequencyCodes: ['BID'],
  allowedQuantities: [14, 28],
  allowedRouteCodes: ['PO'],
  defaultCourseDays: 7,
  defaultDoseText: '500 mg',
  defaultFrequencyCode: 'BID',
  defaultQuantity: 14,
  defaultRouteCode: 'PO',
  id: 'medication-metformin',
  nameEn: 'Synthetic metformin',
  nameZh: '合成盐酸二甲双胍片',
  version: 1,
}

const sampleOutpatientDetail: DoctorCaseDetail = {
  registrationNumber: null,
  allergies: [],
  caseId: 'case-quality-rx',
  encounter: { id: 'enc-quality-rx', versionId: '2' },
  patient: { id: 'pat-quality-rx', identifier: 'SYN-RX-QUALITY', name: '合成门诊患者', synthetic: true, versionId: '1' },
  presentation: null,
  priorFacts: [],
  status: 'first-visit',
  taskId: 'task-quality-rx',
  taskVersion: '1',
}

describe('Clinical quality gates Web UI & AgentReviewProvider contracts', () => {
  afterEach(() => {
    cleanup()
    sessionStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders non-overridable destructive banner for Tier-1 red lines including WORKFLOW_CONFLICT / CATALOG_CONFLICT responses', () => {
    const onSubmitOverride = vi.fn()
    const renalError = new ApiClientError(
      409,
      'CLINICAL_QUALITY_RED_LINE',
      sampleRedLineCheck.redLines[0]!.message,
      undefined,
      undefined,
      { clinicalQuality: sampleRedLineCheck },
    )
    const { unmount } = render(
      <ClinicalQualityBanner
        error={renalError}
        locale="zh-CN"
        onSubmitOverride={onSubmitOverride}
      />,
    )

    const alert = screen.getByRole('alert', { name: '药事安全红线拦截' })
    expect(alert.textContent).toContain('药事安全红线拦截（不可越权）')
    expect(alert.textContent).toContain('RENAL_CONTRAINDICATED_MEDICATION')
    expect(alert.textContent).toContain('CKD-EPI 2021 eGFR 21.4')
    expect(screen.queryByLabelText('受控越权原因')).toBeNull()
    expect(screen.queryByRole('button', { name: '登记说明并重新提交' })).toBeNull()
    unmount()

    const allergyError = new ApiClientError(
      409,
      'WORKFLOW_CONFLICT',
      '与患者明确过敏记录冲突',
      undefined,
      undefined,
      {
        reason: 'PRESCRIPTION_ALLERGY_CONFLICT',
        clinicalQuality: {
          evaluatedAt: '2026-11-18T10:01:00+08:00',
          gate: 'outpatient-prescription',
          status: 'blocked',
          redLines: [{
            code: 'MEDICATION_ALLERGY_CONFLICT',
            tier: 'red-line',
            catalogItemId: 'medication-amoxicillin',
            message: '阿莫西林胶囊命中患者已登记青霉素类过敏红线，禁止开立。',
            evidence: [{ label: '活动性青霉素过敏', reference: 'AllergyIntolerance/allergy-1' }],
          }],
          alerts: [],
        },
      },
    )
    render(
      <ClinicalQualityBanner
        error={allergyError}
        locale="zh-CN"
        onSubmitOverride={onSubmitOverride}
      />,
    )
    const allergyAlert = screen.getByRole('alert', { name: '药事安全红线拦截' })
    expect(allergyAlert.textContent).toContain('MEDICATION_ALLERGY_CONFLICT')
    expect(screen.queryByRole('button', { name: '登记说明并重新提交' })).toBeNull()
  })

  it('Gate 1 (Outpatient PrescriptionPage): renders non-overridable red-line block and inline override resubmission on 409 alert', async () => {
    const user = userEvent.setup()
    const confirmCalls: Array<{ body: unknown; idempotencyKey: string | null }> = []
    let mode: 'red-line' | 'alert' = 'red-line'
    const recommendationPayload: DoctorRecommendationState = {
      caseEvidence: [{ id: 'synthetic-case-evidence', kind: 'draft', label: '合成已知资料', text: '合成病例资料，用于测试待开具清单。' }],
      caseId: sampleOutpatientDetail.caseId,
      encounterId: sampleOutpatientDetail.encounter.id,
      encounterVersion: sampleOutpatientDetail.encounter.versionId,
      generation: 1,
      guidelines: [{
        id: 'synthetic-guideline-evidence',
        documentType: 'guideline',
        locator: '合成测试条款',
        publisher: '合成指南发布者',
        scope: '合成测试病例',
        sourceHash: 'a'.repeat(64),
        text: '合成条款，仅用于界面合同测试。',
        title: '合成用药指南',
        url: 'https://example.test/guidelines/synthetic',
        version: '1',
      }],
      inputFingerprint: '1'.repeat(64),
      items: [{
        caseEvidenceIds: ['synthetic-case-evidence'],
        catalogItemId: sampleOutpatientMedication.id,
        courseDays: 7,
        doseText: '500 mg',
        frequencyCode: 'BID',
        routeCode: 'PO',
        guidelineEvidenceIds: ['synthetic-guideline-evidence'],
        id: 'rec-metformin-1',
        kind: 'prescription',
        label: sampleOutpatientMedication.nameZh,
        missingInformation: [],
        opposingInformation: [],
        quantity: 14,
        rationale: '合成推荐用药',
        supportingInformation: ['合成血糖升高记录'],
      }],
      kind: 'prescription',
      missingInformation: [],
      stale: false,
      status: 'ready',
    }

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
      if (!url.endsWith('/actions/confirm')) {
        return Response.json(recommendationPayload)
      }
      const headers = new Headers(init?.headers)
      const body = JSON.parse(String(init?.body ?? '{}')) as { input?: { clinicalOverride?: ClinicalOverrideInput } }
      confirmCalls.push({ body, idempotencyKey: headers.get('idempotency-key') })
      if (mode === 'red-line') {
        return Response.json({
          error: {
            code: 'WORKFLOW_CONFLICT',
            reason: 'PRESCRIPTION_ALLERGY_CONFLICT',
            message: '合成盐酸二甲双胍片与患者明确过敏冲突',
            clinicalQuality: {
              evaluatedAt: '2026-11-18T10:02:00+08:00',
              gate: 'outpatient-prescription',
              status: 'blocked',
              redLines: [{
                code: 'MEDICATION_ALLERGY_CONFLICT',
                tier: 'red-line',
                catalogItemId: sampleOutpatientMedication.id,
                message: '合成盐酸二甲双胍片命中明确过敏红线，不可越权开具。',
                evidence: [{ label: '过敏记录', reference: 'AllergyIntolerance/allergy-rx-1' }],
              }],
              alerts: [],
            },
          },
        }, { status: 409 })
      }
      if (body.input?.clinicalOverride === undefined) {
        return Response.json({
          error: {
            code: 'CLINICAL_QUALITY_ALERT',
            message: '开立肾排泄高危药物缺少近期血肌酐记录',
            clinicalQuality: {
              evaluatedAt: '2026-11-18T10:03:00+08:00',
              gate: 'outpatient-prescription',
              status: 'alert',
              redLines: [],
              alerts: [{
                code: 'RENAL_CREATININE_MISSING',
                tier: 'alert',
                catalogItemId: sampleOutpatientMedication.id,
                message: '尚未检出近期血肌酐记录，请核对肾功能依据。',
                evidence: [],
              }],
            },
          },
        }, { status: 409 })
      }
      return Response.json({
        auditId: '019a0000-0000-7000-8000-000000000021',
        effects: [],
        requestId: '019a0000-0000-7000-8000-000000000022',
        warnings: [],
        data: {
          draftVersion: 1,
          encounterVersion: '3',
          kind: 'prescription',
          recordIds: ['rx-quality-1'],
        },
      })
    }))

    const actions: PrescriptionPageActions = {
      confirmNoMedication: { error: null, onSubmit: vi.fn(), pending: false },
      deleteDraft: { data: undefined, error: null, onSubmit: vi.fn(), pending: false },
      issue: { error: null, onSubmit: vi.fn(), pending: false },
      saveDraft: { error: null, onSubmit: vi.fn(), pending: false, savedRevision: undefined, success: false },
      withdraw: { error: null, onSubmit: vi.fn(), pending: false },
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AgentPageRegistryProvider>
          <PrescriptionPage
            actions={actions}
            allowWithdrawal
            catalog={[sampleOutpatientMedication]}
            detail={sampleOutpatientDetail}
            elementId="prescription-page"
            locale="zh-CN"
            messages={getWorkspaceMessages('zh-CN')}
            readOnly={false}
            referenceSearch={{ data: undefined, error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn() }}
          />
        </AgentPageRegistryProvider>
      </QueryClientProvider>,
    )

    const issueBtn = await screen.findByRole('button', { name: '开具处方（1）' })
    await user.click(issueBtn)

    const redLineAlert = await screen.findByRole('alert', { name: '药事安全红线拦截' })
    expect(redLineAlert.textContent).toContain('MEDICATION_ALLERGY_CONFLICT')
    expect(screen.queryByRole('button', { name: '登记说明并重新提交' })).toBeNull()

    mode = 'alert'
    await user.click(screen.getByRole('button', { name: '开具处方（1）' }))
    const alertRegion = await screen.findByRole('region', { name: '临床质控警示' })
    expect(alertRegion.textContent).toContain('RENAL_CREATININE_MISSING')

    await user.click(screen.getByLabelText('受控越权原因'))
    await user.click(await screen.findByRole('option', { name: '已核对外院或床旁近期检查结果' }))
    await user.type(screen.getByLabelText('医学说明（至少 4 字）'), '外院昨日血肌酐 72 umol/L 肾功能正常')
    await user.click(screen.getByRole('button', { name: '登记说明并重新提交' }))

    await waitFor(() => expect(confirmCalls).toHaveLength(3))
    expect(confirmCalls[2]!.idempotencyKey).not.toBe(confirmCalls[1]!.idempotencyKey)
    expect(confirmCalls[2]!.body).toMatchObject({
      input: {
        clinicalOverride: {
          reasonCode: 'external-result-verified',
          note: '外院昨日血肌酐 72 umol/L 肾功能正常',
          acknowledgedAlerts: ['RENAL_CREATININE_MISSING'],
        },
      },
    })
  })

  it('Gate 1 (InpatientOrderComposer): renders non-overridable red-line block and inline override resubmission on 409 alert', async () => {
    const user = userEvent.setup()
    const orderCalls: Array<{ body: unknown; idempotencyKey: string | null }> = []
    let mode: 'red-line' | 'alert' = 'red-line'
    const inpatientMed = {
      id: 'medication-metformin',
      display: '盐酸二甲双胍片',
      version: 1,
      priceFen: 1200,
      unit: '片',
      doses: [{ doseText: '500 mg', quantity: 1 }],
      doseBasis: { amount: 500, unit: 'mg' },
      maxDoseQuantity: 4,
      frequencyCodes: ['BID'],
      defaultRouteCode: 'PO',
      allowedRouteCodes: ['PO'],
      lots: [],
    }

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
      if (url.endsWith('/api/auth/context')) return Response.json(inpatientDoctorSession)
      if (url.endsWith('/clinical-catalog')) return Response.json({ diagnoses: [], medications: [inpatientMed], services: [] })
      if (url.endsWith('/clinical')) {
        return Response.json({
          admissionId: sampleAdmission.id,
          encounterVersion: sampleAdmission.versionId,
          diagnosis: {
            revision: 1,
            entries: [{
              conditionId: 'cond-dm-1',
              role: 'primary',
              admissionCondition: '1',
              ordinal: 1,
              coding: { id: 'diag-e11', code: 'E11.900', display: '2型糖尿病', system: 'https://example.test/icd', version: '1', sourceLocator: 'synthetic' },
            }],
          },
          orders: [],
          executions: [],
          dispenses: [],
          charges: [],
          chargesFen: 0,
        })
      }
      if (url.includes('/catalog-search?')) {
        return Response.json({
          kind: 'medication',
          source: 'hospital',
          page: 1,
          pageSize: 50,
          total: 1,
          items: [{ id: inpatientMed.id, display: inpatientMed.display, status: 'available', missingFields: [], catalogItemId: inpatientMed.id, catalogVersion: 1, medication: inpatientMed }],
        })
      }
      if (url.endsWith('/surgeries')) {
        return Response.json({ admissionId: sampleAdmission.id, encounterVersion: sampleAdmission.versionId, virtualTime: '2026-11-18T09:00:00+08:00', requests: [], executions: [], inProgress: [] })
      }
      if (url.endsWith(`/inpatient/admissions/${sampleAdmission.id}/orders/issue`) && init?.method === 'POST') {
        const headers = new Headers(init.headers)
        const body = JSON.parse(String(init.body ?? '{}')) as { input?: { clinicalOverride?: ClinicalOverrideInput } }
        orderCalls.push({ body, idempotencyKey: headers.get('idempotency-key') })
        if (mode === 'red-line') {
          return Response.json({
            error: {
              code: 'CATALOG_CONFLICT',
              reason: 'MEDICATION_DOSAGE_NOT_ALLOWED',
              message: '盐酸二甲双胍片超出单次或单日剂量极量',
              clinicalQuality: {
                evaluatedAt: '2026-11-18T09:05:00+08:00',
                gate: 'inpatient-order',
                status: 'blocked',
                redLines: [{
                  code: 'MEDICATION_DOSE_LIMIT_EXCEEDED',
                  tier: 'red-line',
                  catalogItemId: inpatientMed.id,
                  message: '盐酸二甲双胍片超出目录允许的单次或单日最大剂量红线。',
                  evidence: [],
                }],
                alerts: [],
              },
            },
          }, { status: 409 })
        }
        if (body.input?.clinicalOverride === undefined) {
          return Response.json({
            error: {
              code: 'CLINICAL_QUALITY_ALERT',
              message: '住院开立盐酸二甲双胍片缺少近期血肌酐记录',
              clinicalQuality: {
                evaluatedAt: '2026-11-18T09:06:00+08:00',
                gate: 'inpatient-order',
                status: 'alert',
                redLines: [],
                alerts: [{
                  code: 'RENAL_CREATININE_MISSING',
                  tier: 'alert',
                  catalogItemId: inpatientMed.id,
                  message: '尚未检出近期血肌酐检验结果，请核实肾功能。',
                  evidence: [],
                }],
              },
            },
          }, { status: 409 })
        }
        return Response.json({
          auditId: '019a0000-0000-7000-8000-000000000031',
          correlationId: '019a0000-0000-7000-8000-000000000032',
          effects: [],
          data: {
            admissionId: sampleAdmission.id,
            encounterVersion: '4',
            diagnosis: { revision: 1, entries: [] },
            orders: [],
            executions: [],
            dispenses: [],
            charges: [],
            chargesFen: 0,
          },
        })
      }
      throw new Error(`Unexpected fetch in InpatientOrderComposer test: ${url}`)
    }))

    function OrderHarness() {
      const write = useInpatientWriteIntent(inpatientDoctorSession, () => undefined)
      return <InpatientClinical active admission={sampleAdmission} locale="zh-CN" session={inpatientDoctorSession} write={write} />
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><OrderHarness /></QueryClientProvider>)

    await user.click(await screen.findByRole('button', { name: '开立医嘱' }))
    const dialog = await screen.findByRole('dialog', { name: '开立医嘱' })
    await user.click(await within(dialog).findByRole('button', { name: /选择盐酸二甲双胍片/ }))
    await user.click(within(dialog).getByRole('button', { name: '开立所选医嘱（1）' }))

    const redLineAlert = await within(dialog).findByRole('alert', { name: '药事安全红线拦截' })
    expect(redLineAlert.textContent).toContain('MEDICATION_DOSE_LIMIT_EXCEEDED')
    expect(within(dialog).queryByRole('button', { name: '登记说明并重新提交' })).toBeNull()

    mode = 'alert'
    await user.click(within(dialog).getByRole('button', { name: '开立所选医嘱（1）' }))
    const alertRegion = await within(dialog).findByRole('region', { name: '临床质控警示' })
    expect(alertRegion.textContent).toContain('RENAL_CREATININE_MISSING')

    within(dialog).getByLabelText('受控越权原因').focus()
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('option', { name: '已同步开立检查并安排复诊随访' }))
    await user.type(within(dialog).getByLabelText('医学说明（至少 4 字）'), '已同步开立急查肾功能电解质并监测尿量')
    await user.click(within(dialog).getByRole('button', { name: '登记说明并重新提交' }))

    await waitFor(() => expect(orderCalls).toHaveLength(3))
    expect(orderCalls[2]!.idempotencyKey).not.toBe(orderCalls[1]!.idempotencyKey)
    expect(orderCalls[2]!.body).toMatchObject({
      input: {
        clinicalOverride: {
          reasonCode: 'result-pending-follow-up',
          note: '已同步开立急查肾功能电解质并监测尿量',
          acknowledgedAlerts: ['RENAL_CREATININE_MISSING'],
        },
      },
    })
  })

  it('Gate 2: renders inline ClinicalQualityBanner on outpatient completion 409 alert and resubmits with controlled ClinicalOverride', async () => {
    const user = userEvent.setup()
    const submitted: Array<ClinicalOverrideInput | undefined> = []
    const alertError = new ApiClientError(
      409,
      'CLINICAL_QUALITY_ALERT',
      sampleCompletionAlertCheck.alerts[0]!.message,
      undefined,
      undefined,
      { clinicalQuality: sampleCompletionAlertCheck },
    )
    const preview: EncounterCompletionPreview = {
      canComplete: true,
      encounterId: 'enc-1',
      encounterVersion: '3',
      items: [{ code: 'primary-diagnosis-confirmed', status: 'complete', statusText: '主诊断已确认', target: 'diagnosis' }],
    }

    render(
      <DoctorCompletionActionBar
        action={{
          error: alertError,
          onSubmit: override => submitted.push(override),
          pending: false,
        }}
        basisCurrent
        locale="zh-CN"
        messages={getWorkspaceMessages('zh-CN')}
        onBack={() => undefined}
        onNavigate={() => undefined}
        preview={preview}
      />,
    )

    const banner = screen.getByRole('region', { name: '临床质控警示' })
    expect(banner.textContent).toContain('CHEST_PAIN_WORKUP_INCOMPLETE')
    const resubmitBtn = screen.getByRole('button', { name: '登记说明并重新提交' })
    expect((resubmitBtn as HTMLButtonElement).disabled).toBe(true)

    await user.click(screen.getByLabelText('受控越权原因'))
    await user.click(await screen.findByRole('option', { name: '已核对外院或床旁近期检查结果' }))
    await user.type(screen.getByLabelText('医学说明（至少 4 字）'), '外院急诊心电图与肌钙蛋白均正常')
    expect((resubmitBtn as HTMLButtonElement).disabled).toBe(false)

    await user.click(resubmitBtn)
    expect(submitted).toEqual([{
      reasonCode: 'external-result-verified',
      note: '外院急诊心电图与肌钙蛋白均正常',
      acknowledgedAlerts: ['CHEST_PAIN_WORKUP_INCOMPLETE'],
    }])
  })

  it('supports prefilled clinicalOverride passthrough and single-gate 409 supplement in AgentReviewProvider (.propose)', async () => {
    const user = userEvent.setup()
    let review!: ReturnType<typeof useAgentReview>
    function Harness(): null {
      review = useAgentReview()
      return null
    }
    render(<AgentReviewProvider locale="zh-CN"><Harness /></AgentReviewProvider>)

    const receivedOverrides: Array<ClinicalOverrideInput | undefined> = []
    let prefilledTask!: AgentReviewTask
    act(() => {
      prefilledTask = review.request({
        allowClinicalOverride: true,
        clinicalOverride: {
          reasonCode: 'external-result-verified',
          note: '智能体已读取患者携带的外院心电图与肌钙蛋白记录',
          acknowledgedAlerts: ['CHEST_PAIN_WORKUP_INCOMPLETE'],
        },
        confirmLabel: '确认完诊',
        description: '合成胸痛患者',
        onConfirm: (_ack, override) => {
          receivedOverrides.push(override)
          return { status: 'completed' }
        },
        signal: new AbortController().signal,
        title: '确认完诊',
      })
      prefilledTask.bindDecisionGate(async () => undefined)
    })

    expect(await screen.findByLabelText('临床质控确认说明')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '确认完诊' }))
    await expect(prefilledTask.decision).resolves.toEqual({
      approved: true,
      data: { status: 'completed' },
    })
    expect(receivedOverrides).toEqual([{
      reasonCode: 'external-result-verified',
      note: '智能体已读取患者携带的外院心电图与肌钙蛋白记录',
      acknowledgedAlerts: ['CHEST_PAIN_WORKUP_INCOMPLETE'],
    }])

    const gateDecisions: string[] = []
    const attempts: Array<ClinicalOverrideInput | undefined> = []
    let supplementTask!: AgentReviewTask
    act(() => {
      supplementTask = review.request({
        allowClinicalOverride: true,
        confirmLabel: '开具处方',
        description: '合成上感患者 · 1 项药品',
        onConfirm: (_ack, override) => {
          attempts.push(override)
          if (override === undefined) {
            throw new ApiClientError(
              409,
              'CLINICAL_QUALITY_ALERT',
              '单纯病毒性感染无细菌指征开立抗菌药',
              undefined,
              undefined,
              {
                clinicalQuality: {
                  evaluatedAt: '2026-11-18T10:10:00+08:00',
                  gate: 'outpatient-prescription',
                  status: 'alert',
                  redLines: [],
                  alerts: [{
                    code: 'ANTIBIOTIC_WITHOUT_BACTERIAL_INDICATION',
                    tier: 'alert',
                    catalogItemId: 'medication-amoxicillin',
                    message: '当前仅确认病毒性上感诊断，缺乏细菌感染指征。',
                    evidence: [],
                  }],
                },
              },
            )
          }
          return { prescriptionId: 'rx-override-1' }
        },
        signal: new AbortController().signal,
        title: '开具处方',
      })
      supplementTask.bindDecisionGate(async decision => {
        gateDecisions.push(decision)
      })
    })

    await user.click(await screen.findByRole('button', { name: '开具处方' }))
    const inlineOverrideBox = await screen.findByLabelText('临床质控确认说明')
    expect(inlineOverrideBox.textContent).toContain('ANTIBIOTIC_WITHOUT_BACTERIAL_INDICATION')
    expect(gateDecisions).toEqual(['approved'])

    const confirmBtn = screen.getByRole('button', { name: '开具处方' })
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true)

    await user.click(screen.getByLabelText('受控越权原因'))
    await user.click(await screen.findByRole('option', { name: '经专科综合评估符合个体化诊疗方案' }))
    await user.type(screen.getByLabelText('医学说明（至少 4 字）'), '查体见双侧扁桃体化脓伴高热，临床判断合并细菌感染')
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(false)

    await user.click(confirmBtn)
    await expect(supplementTask.decision).resolves.toEqual({
      approved: true,
      data: { prescriptionId: 'rx-override-1' },
    })
    expect(gateDecisions).toEqual(['approved'])
    expect(attempts).toEqual([
      undefined,
      {
        reasonCode: 'clinical-judgement',
        note: '查体见双侧扁桃体化脓伴高热，临床判断合并细菌感染',
        acknowledgedAlerts: ['ANTIBIOTIC_WITHOUT_BACTERIAL_INDICATION'],
      },
    ])
  })

  it('Gate 3 (InpatientSurgery PciStepOneCard): keeps Step 1 open when angiography reveals FFR > 0.80 on auto-draft and resubmits inline override', async () => {
    const user = userEvent.setup()
    const pciConfirmCalls: Array<{ body: unknown; idempotencyKey: string | null }> = []
    const time = '2026-11-18T10:25:00+08:00'
    const pciProcedure = {
      id: 'procedure-pci-des',
      version: 1,
      coding: {
        system: 'urn:clinmesh:classification:icd-9-cm-3-clinical',
        version: '3.0',
        code: '36.0700',
        display: '冠状动脉药物洗脱支架置入术',
        category: '介入治疗' as const,
        releaseId: 'clinmesh-surgery-subset-2026-10-20',
        sourceUrl: 'https://example.com/synthetic',
        sourceSha256: 'a'.repeat(64),
        sourceLocator: 'synthetic',
      },
      chargeDefinition: { id: 'charge-pci-des', priceFen: 320000, unit: '次', synthetic: true, trigger: 'execution' as const },
    }
    const pciPlan = inpatientSurgeryRequestSchema.parse({
      id: 'req-pci-ffr-high',
      admissionId: sampleAdmission.id,
      version: 2,
      status: 'requested',
      plannedProcedure: pciProcedure,
      plannedFor: time,
      reason: '造影前拟行前降支介入评估与支架置入',
      requestedAt: time,
      requestedBy: 'actor-inpatient-doctor',
      organizationId: sampleAdmission.organizationId,
    })
    const report = {
      id: 'report-angio-ffr-86',
      admissionId: sampleAdmission.id,
      procedureId: 'exec-angio-1',
      version: 1,
      synthetic: true as const,
      status: 'final' as const,
      targetSite: 'LAD 中段',
      measurements: [
        { kind: 'lesion-length' as const, object: 'lesion' as const, site: 'LAD 中段', value: 14, unit: 'mm', method: 'QCA', source: { reference: 'DiagnosticReport/report-angio-ffr-86', version: '1', note: '本院合成造影报告测量', synthetic: true } },
        { kind: 'proximal-reference-diameter' as const, object: 'reference-lumen' as const, site: 'LAD 近端', value: 3, unit: 'mm', method: 'QCA', source: { reference: 'DiagnosticReport/report-angio-ffr-86', version: '1', note: '本院合成造影报告测量', synthetic: true } },
        { kind: 'distal-reference-diameter' as const, object: 'reference-lumen' as const, site: 'LAD 远端', value: 3, unit: 'mm', method: 'QCA', source: { reference: 'DiagnosticReport/report-angio-ffr-86', version: '1', note: '本院合成造影报告测量', synthetic: true } },
      ],
      vessels: [
        { vessel: 'LAD' as const, segment: 'mLAD', stenosisPercent: 60, timiFlow: 3, lesionCharacteristics: '中段临界病变', ffr: 0.86 },
      ],
      conclusion: '前降支中段 60% 狭窄，FFR 0.86 非缺血临界病变。',
      missing: [],
      issuedAt: time,
    }
    const pciAlertCheck: ClinicalQualityCheck = {
      evaluatedAt: time,
      gate: 'inpatient-pci-plan',
      status: 'alert',
      redLines: [],
      alerts: [{
        code: 'PCI_NON_ISCHEMIC_LESION',
        tier: 'alert',
        message: '冠脉造影功能学评估示非缺血病变（FFR 0.86 > 0.80），不建议常规支架植入。',
        evidence: [{ label: 'LAD FFR 0.86', reference: `DiagnosticReport/${report.id}`, versionId: '1' }],
      }],
    }
    let currentSelection = inpatientPciSelectionSchema.parse({
      admissionId: sampleAdmission.id,
      confirmation: null,
      history: [],
      evidencePackage: { id: 'pkg-pci-1', version: '1', synthetic: true, limitation: '仅用于合成验收' },
      candidates: [],
      drafts: [{
        requestId: pciPlan.id,
        version: 1,
        reportId: report.id,
        reportVersion: 1,
        edited: false,
        confirmedSelectionVersion: null,
        parameters: {
          requestId: pciPlan.id,
          treatmentPlan: pciProcedure.coding.display,
          targetSite: 'LAD 中段',
          measurements: report.measurements,
          plannedQuantities: [],
          approvedMaterialIds: [],
        },
      }],
    })

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
      if (url.endsWith('/api/auth/context')) return Response.json(inpatientDoctorSession)
      if (url.endsWith('/surgeries')) {
        return Response.json(inpatientSurgerySchema.parse({
          admissionId: sampleAdmission.id,
          encounterVersion: sampleAdmission.versionId,
          virtualTime: time,
          requests: [pciPlan],
          executions: [],
          inProgress: [],
        }))
      }
      if (url.endsWith('/surgery-catalog')) return Response.json({ procedures: [pciProcedure], materials: [] })
      if (url.endsWith('/drg/reservations')) return Response.json({ admissionId: sampleAdmission.id, encounterVersion: sampleAdmission.versionId, reservations: [], reservationSets: [] })
      if (url.endsWith('/pci-selection') && (!init?.method || init.method === 'GET')) return Response.json(currentSelection)
      if (url.endsWith('/angiography-reports')) return Response.json(inpatientAngiographyReportsSchema.parse({ admissionId: sampleAdmission.id, reports: [report] }))
      if (url.endsWith('/material-estimates')) return Response.json(inpatientMaterialEstimatesSchema.parse({ admissionId: sampleAdmission.id, estimates: [], unprepared: [] }))
      if (url.endsWith('/guideline-advice')) return Response.json({ admissionId: sampleAdmission.id, advice: [] })
      if (url.endsWith(`/inpatient/admissions/${sampleAdmission.id}/pci-selection/confirm`) && init?.method === 'POST') {
        const headers = new Headers(init.headers)
        const body = JSON.parse(String(init.body ?? '{}')) as { input?: { clinicalOverride?: ClinicalOverrideInput } }
        pciConfirmCalls.push({ body, idempotencyKey: headers.get('idempotency-key') })
        if (body.input?.clinicalOverride === undefined) {
          return Response.json({
            error: {
              code: 'CLINICAL_QUALITY_ALERT',
              message: pciAlertCheck.alerts[0]!.message,
              clinicalQuality: pciAlertCheck,
            },
          }, { status: 409 })
        }
        currentSelection = inpatientPciSelectionSchema.parse({
          ...currentSelection,
          confirmation: {
            id: 'pci-conf-after-override',
            version: 1,
            parameters: currentSelection.drafts![0]!.parameters,
            confirmedBy: 'actor-inpatient-doctor',
            practitionerRoleId: 'role-inpatient-doctor-1',
            confirmedAt: time,
          },
        })
        return Response.json({
          auditId: '019a0000-0000-7000-8000-000000000041',
          correlationId: '019a0000-0000-7000-8000-000000000042',
          effects: [],
          data: currentSelection,
        })
      }
      throw new Error(`Unexpected fetch in InpatientSurgery PCI test: ${url}`)
    }))

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    function PciSurgeryHarness() {
      const write = useInpatientWriteIntent(inpatientDoctorSession, () => queryClient.invalidateQueries({ queryKey: ['inpatient'] }))
      return (
        <InpatientActionProvider stage="surgery">
          <InpatientSurgery admission={sampleAdmission} locale="zh-CN" session={inpatientDoctorSession} write={write} />
          <InpatientActionOutlet />
        </InpatientActionProvider>
      )
    }
    render(<QueryClientProvider client={queryClient}><PciSurgeryHarness /></QueryClientProvider>)

    const stepTwo = await screen.findByRole('region', { name: '手术耗材' })
    expect(stepTwo.textContent).toContain('确认选型参数后')

    const confirmStepOneBtn = await screen.findByRole('button', { name: '确认选型参数' })
    await user.click(confirmStepOneBtn)

    const banner = await screen.findByRole('region', { name: '临床质控警示' })
    expect(banner.textContent).toContain('PCI_NON_ISCHEMIC_LESION')

    await user.click(screen.getByLabelText('受控越权原因'))
    await user.click(await screen.findByRole('option', { name: '经专科综合评估符合个体化诊疗方案' }))
    await user.type(screen.getByLabelText('医学说明（至少 4 字）'), 'OCT证实斑块破裂伴反复静息胸痛，需介入稳定斑块')
    await user.click(screen.getByRole('button', { name: '登记说明并重新提交' }))

    await waitFor(() => expect(pciConfirmCalls).toHaveLength(2))
    expect(pciConfirmCalls[1]!.idempotencyKey).not.toBe(pciConfirmCalls[0]!.idempotencyKey)
    expect(pciConfirmCalls[1]!.body).toMatchObject({
      input: {
        expectedVersion: 0,
        clinicalOverride: {
          reasonCode: 'clinical-judgement',
          note: 'OCT证实斑块破裂伴反复静息胸痛，需介入稳定斑块',
          acknowledgedAlerts: ['PCI_NON_ISCHEMIC_LESION'],
        },
      },
    })
  })

  it('Gate 4 (InpatientDischarge & InpatientRecord): releases inpatient write intent on 409 alert and resubmits both commands with fresh idempotency keys', async () => {
    const user = userEvent.setup()
    const dischargeCalls: Array<{ body: unknown; idempotencyKey: string | null }> = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
      if (url.endsWith('/api/auth/context') && (!init?.method || init.method === 'GET')) {
        return Response.json(inpatientDoctorSession)
      }
      if (url.endsWith(`/inpatient/admissions/${sampleAdmission.id}/discharge`) && (!init?.method || init.method === 'GET')) {
        return Response.json({ admissionId: sampleAdmission.id, events: [] })
      }
      if (url.endsWith(`/inpatient/admissions/${sampleAdmission.id}/discharge/issue`) && init?.method === 'POST') {
        const headers = new Headers(init.headers)
        const body = JSON.parse(String(init.body ?? '{}')) as { input?: { clinicalOverride?: ClinicalOverrideInput } }
        dischargeCalls.push({ body, idempotencyKey: headers.get('idempotency-key') })
        if (body.input?.clinicalOverride === undefined) {
          return Response.json({
            error: {
              code: 'CLINICAL_QUALITY_ALERT',
              message: '冠心病患者出院缺少抗血小板与他汀长期医嘱',
              clinicalQuality: sampleDischargeAlertCheck,
            },
          }, { status: 409 })
        }
        return Response.json({
          auditId: '019a0000-0000-7000-8000-000000000001',
          correlationId: '019a0000-0000-7000-8000-000000000002',
          effects: [],
          data: {
            admission: { ...sampleAdmission, status: 'discharge-pending', versionId: '4' },
          },
        })
      }
      throw new Error(`Unexpected fetch in discharge test: ${url}`)
    })

    let latestMutation: ReturnType<typeof useInpatientWriteIntent>['mutation'] | undefined
    function DischargeHarness() {
      const write = useInpatientWriteIntent(inpatientDoctorSession, () => undefined)
      latestMutation = write.mutation
      return (
        <InpatientDischarge
          admission={sampleAdmission}
          locale="zh-CN"
          session={inpatientDoctorSession}
          write={write}
        />
      )
    }

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const dischargeView = render(
      <QueryClientProvider client={queryClient}>
        <DischargeHarness />
      </QueryClientProvider>,
    )

    await user.type(screen.getByLabelText('出院处理说明'), '病情稳定准予出院')
    await user.click(screen.getByRole('button', { name: '开出院医嘱' }))

    const banner = await screen.findByRole('region', { name: '临床质控警示' })
    expect(banner.textContent).toContain('DISCHARGE_ANTIPLATELET_MISSING')
    expect(banner.textContent).toContain('DISCHARGE_STATIN_MISSING')
    expect(isHandledInpatientRejection(latestMutation!)).toBe(true)

    await user.click(screen.getByLabelText('受控越权原因'))
    await user.click(await screen.findByRole('option', { name: '存在明确禁忌或高出血/不良反应风险' }))
    await user.type(screen.getByLabelText('医学说明（至少 4 字）'), '合并活动性上消化道出血，暂缓双抗与他汀')
    await user.click(screen.getByRole('button', { name: '登记说明并重新提交' }))

    await waitFor(() => expect(dischargeCalls).toHaveLength(2))
    expect(dischargeCalls[1]!.idempotencyKey).not.toBe(dischargeCalls[0]!.idempotencyKey)
    expect(dischargeCalls[1]!.body).toMatchObject({
      input: {
        encounterVersion: '3',
        reason: '病情稳定准予出院',
        clinicalOverride: {
          reasonCode: 'documented-contraindication',
          note: '合并活动性上消化道出血，暂缓双抗与他汀',
          acknowledgedAlerts: ['DISCHARGE_ANTIPLATELET_MISSING', 'DISCHARGE_STATIN_MISSING'],
        },
      },
    })
    dischargeView.unmount()
  })

  it('Gate 4 (InpatientRecord): renders inline ClinicalQualityBanner on post-settlement record submit 409 alert and resubmits with fresh idempotency key', async () => {
    const user = userEvent.setup()
    const recordSubmitCalls: Array<{ body: unknown; idempotencyKey: string | null }> = []
    const settledAdmission: InpatientAdmission = {
      ...sampleAdmission,
      status: 'cleared',
      financialStatus: 'settled',
      departedAt: '2026-11-18T14:00:00+08:00',
      versionId: '6',
    }
    const settledRecord = inpatientRecordSchema.parse({
      admissionId: settledAdmission.id,
      recordNumber: 'BA-20261118-01',
      sourcesHash: 'f'.repeat(64),
      reviews: [],
      reviewCurrent: false,
      snapshot: {
        patient: {
          patientId: settledAdmission.patientId,
          patientVersion: '1',
          identifier: 'SYN-CAD-RECORD',
          name: settledAdmission.patientName,
          gender: 'male',
          birthDate: '1962-04-12',
          recordNumber: 'BA-20261118-01',
          admissionCount: 1,
        },
        stay: {
          admissionId: settledAdmission.id,
          inpatientNumber: settledAdmission.inpatientNumber,
          admissionRoute: 'direct',
          registeredAt: settledAdmission.registeredAt,
          admittedAt: settledAdmission.admittedAt,
          departedAt: '2026-11-18T14:00:00+08:00',
          departureMethod: 'home',
          initialWardId: settledAdmission.wardId,
          initialOrganizationId: settledAdmission.organizationId,
          dischargeWardId: settledAdmission.wardId,
          dischargeOrganizationId: settledAdmission.organizationId,
          transfers: [],
          events: [],
        },
        clinical: {
          diagnosis: {
            revision: 1,
            entries: [{
              conditionId: 'cond-cad-1',
              role: 'primary',
              admissionCondition: '1',
              ordinal: 1,
              coding: {
                id: 'diag-cad-1',
                code: 'I25.103',
                display: '冠状动脉粥样硬化性心脏病',
                system: 'urn:clinmesh:reference:nhsa-diagnosis',
                version: '2022',
                releaseId: 'synthetic-browser-1',
                sourceLocator: 'cn-health:diagnosis:1',
              },
            }],
          },
          operations: [],
          mainProcedureExecutionId: null,
        },
        fees: {
          admissionId: settledAdmission.id,
          encounterVersion: settledAdmission.versionId,
          status: 'cleared',
          financialStatus: 'settled',
          charges: [],
          chargesFen: 15000,
          depositFen: 100000,
          balanceFen: -85000,
          fingerprint: 'e'.repeat(64),
          transactions: [],
          categoryNetFen: { bed: 15000 },
        },
      },
    })
    const recordAlertCheck: ClinicalQualityCheck = sampleDischargeAlertCheck

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
      if (url.endsWith('/api/auth/context')) return Response.json(inpatientDoctorSession)
      if (url.endsWith(`/inpatient/admissions/${settledAdmission.id}/record`) && (!init?.method || init.method === 'GET')) {
        return Response.json(settledRecord)
      }
      if (url.endsWith(`/inpatient/admissions/${settledAdmission.id}/record/submit`) && init?.method === 'POST') {
        const headers = new Headers(init.headers)
        const body = JSON.parse(String(init.body ?? '{}')) as { input?: { clinicalOverride?: ClinicalOverrideInput } }
        recordSubmitCalls.push({ body, idempotencyKey: headers.get('idempotency-key') })
        if (body.input?.clinicalOverride === undefined) {
          return Response.json({
            error: {
              code: 'CLINICAL_QUALITY_ALERT',
              message: '提交病案首页时二级预防药物缺失需登记医学说明',
              clinicalQuality: recordAlertCheck,
            },
          }, { status: 409 })
        }
        return Response.json({
          auditId: '019a0000-0000-7000-8000-000000000051',
          correlationId: '019a0000-0000-7000-8000-000000000052',
          effects: [],
          data: {
            ...settledRecord,
            revision: {
              revision: 1,
              sourcesHash: settledRecord.sourcesHash,
              snapshot: settledRecord.snapshot,
              actorId: 'actor-inpatient-doctor',
              practitionerRoleId: 'role-inpatient-doctor-1',
              recordedAt: '2026-11-18T14:20:00+08:00',
            },
          },
        })
      }
      throw new Error(`Unexpected fetch in record submit test: ${url}`)
    })

    const recordClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    function RecordHarness() {
      const write = useInpatientWriteIntent(inpatientDoctorSession, () => undefined)
      return (
        <InpatientActionProvider stage="record">
          <InpatientRecord admission={settledAdmission} locale="zh-CN" session={inpatientDoctorSession} write={write} />
          <InpatientActionOutlet />
        </InpatientActionProvider>
      )
    }
    render(<QueryClientProvider client={recordClient}><RecordHarness /></QueryClientProvider>)

    const submitRecordBtn = await screen.findByRole('button', { name: '提交病案首页' })
    await waitFor(() => expect(submitRecordBtn.hasAttribute('disabled')).toBe(false))
    await user.click(submitRecordBtn)

    const recordBanner = await screen.findByRole('region', { name: '临床质控警示' })
    expect(recordBanner.textContent).toContain('DISCHARGE_ANTIPLATELET_MISSING')

    await user.click(screen.getByLabelText('受控越权原因'))
    await user.click(await screen.findByRole('option', { name: '存在明确禁忌或高出血/不良反应风险' }))
    await user.type(screen.getByLabelText('医学说明（至少 4 字）'), '消化道出血高风险期，出院随访评估恢复双抗与他汀')
    await user.click(screen.getByRole('button', { name: '登记说明并重新提交' }))

    await waitFor(() => expect(recordSubmitCalls).toHaveLength(2))
    expect(recordSubmitCalls[1]!.idempotencyKey).not.toBe(recordSubmitCalls[0]!.idempotencyKey)
    expect(recordSubmitCalls[1]!.body).toMatchObject({
      input: {
        expectedRevision: 0,
        expectedSourcesHash: settledRecord.sourcesHash,
        mainProcedureExecutionId: null,
        clinicalOverride: {
          reasonCode: 'documented-contraindication',
          note: '消化道出血高风险期，出院随访评估恢复双抗与他汀',
          acknowledgedAlerts: ['DISCHARGE_ANTIPLATELET_MISSING', 'DISCHARGE_STATIN_MISSING'],
        },
      },
    })
  })

  it('renders inline ClinicalQualityBanner on standalone InpatientPciSelection 409 alert and resubmits with controlled ClinicalOverride', async () => {
    const user = userEvent.setup()
    const pciCalls: Array<{ body: unknown; idempotencyKey: string | null }> = []
    const pciAlertCheck: ClinicalQualityCheck = {
      evaluatedAt: '2026-11-18T10:30:00+08:00',
      gate: 'inpatient-pci-plan',
      status: 'alert',
      redLines: [],
      alerts: [{
        code: 'PCI_NON_ISCHEMIC_LESION',
        tier: 'alert',
        message: '冠脉造影功能学评估示非缺血病变（FFR 0.86 > 0.80），不建议常规支架植入。',
        evidence: [{ label: 'LAD FFR 0.86', reference: 'DiagnosticReport/angio-1', versionId: '1' }],
      }],
    }
    const baseSelection = {
      admissionId: sampleAdmission.id,
      confirmation: null,
      history: [],
      evidencePackage: {
        id: 'clinmesh-pci-selection-synthetic',
        version: '2026-10-28.r1',
        synthetic: true as const,
        limitation: '仅供合成验收验证。',
      },
      candidates: [],
      alternatives: [],
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
      if (url.endsWith('/api/auth/context') && (!init?.method || init.method === 'GET')) {
        return Response.json(inpatientDoctorSession)
      }
      if (url.endsWith(`/inpatient/admissions/${sampleAdmission.id}/pci-selection`) && (!init?.method || init.method === 'GET')) {
        return Response.json(baseSelection)
      }
      if (url.endsWith(`/inpatient/admissions/${sampleAdmission.id}/surgeries`) && (!init?.method || init.method === 'GET')) {
        return Response.json({
          admissionId: sampleAdmission.id,
          encounterVersion: '3',
          virtualTime: '2026-11-18T10:30:00+08:00',
          requests: [],
          executions: [],
          inProgress: [],
        })
      }
      if (url.endsWith(`/inpatient/admissions/${sampleAdmission.id}/pci-selection/confirm`) && init?.method === 'POST') {
        const headers = new Headers(init.headers)
        const body = JSON.parse(String(init.body ?? '{}')) as { input?: { clinicalOverride?: ClinicalOverrideInput } }
        pciCalls.push({ body, idempotencyKey: headers.get('idempotency-key') })
        if (body.input?.clinicalOverride === undefined) {
          return Response.json({
            error: {
              code: 'CLINICAL_QUALITY_ALERT',
              message: pciAlertCheck.alerts[0]!.message,
              clinicalQuality: pciAlertCheck,
            },
          }, { status: 409 })
        }
        return Response.json({
          auditId: '019a0000-0000-7000-8000-000000000011',
          correlationId: '019a0000-0000-7000-8000-000000000012',
          effects: [],
          data: {
            ...baseSelection,
            confirmation: {
              id: 'pci-confirm-1',
              version: 1,
              parameters: {
                treatmentPlan: '拟行前降支介入处理',
                targetSite: '前降支中段',
                measurements: [],
                plannedQuantities: [],
                approvedMaterialIds: [],
              },
              confirmedBy: 'actor-inpatient-doctor',
              practitionerRoleId: 'role-inpatient-doctor-1',
              confirmedAt: '2026-11-18T10:30:00+08:00',
            },
          },
        })
      }
      throw new Error(`Unexpected fetch in test: ${url}`)
    })

    function PciSelectionHarness() {
      const write = useInpatientWriteIntent(inpatientDoctorSession, () => undefined)
      return (
        <InpatientPciSelection
          active
          admission={sampleAdmission}
          locale="zh-CN"
          session={inpatientDoctorSession}
          write={write}
        />
      )
    }

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <PciSelectionHarness />
      </QueryClientProvider>,
    )

    await user.click(screen.getByText('PCI 选型参数与候选依据'))
    await user.type(await screen.findByLabelText('治疗方向与术式'), '拟行前降支介入处理')
    await user.type(screen.getByLabelText('靶病变部位'), '前降支中段')
    await user.click(screen.getByRole('button', { name: '确认 PCI 参数' }))

    const banner = await screen.findByRole('region', { name: '临床质控警示' })
    expect(banner.textContent).toContain('PCI_NON_ISCHEMIC_LESION')

    await user.click(screen.getByLabelText('受控越权原因'))
    await user.click(await screen.findByRole('option', { name: '经专科综合评估符合个体化诊疗方案' }))
    await user.type(screen.getByLabelText('医学说明（至少 4 字）'), 'OCT示易损斑块破裂伴静息心绞痛发作')
    await user.click(screen.getByRole('button', { name: '登记说明并重新提交' }))

    await waitFor(() => expect(pciCalls).toHaveLength(2))
    expect(pciCalls[1]!.idempotencyKey).not.toBe(pciCalls[0]!.idempotencyKey)
    expect(pciCalls[1]!.body).toMatchObject({
      input: {
        expectedVersion: 0,
        clinicalOverride: {
          reasonCode: 'clinical-judgement',
          note: 'OCT示易损斑块破裂伴静息心绞痛发作',
          acknowledgedAlerts: ['PCI_NON_ISCHEMIC_LESION'],
        },
      },
    })
  })
})
