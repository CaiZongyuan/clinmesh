// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClinicalQualityCheck } from '@clinmesh/contracts/clinical-quality'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullCatalogSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationCatalogSchema } from '@clinmesh/contracts/inpatient-investigations'
import {
  inpatientSurgeryCatalogSchema,
  inpatientSurgeryCompletionPreviewSchema,
  inpatientSurgeryExecutionSchema,
  inpatientSurgeryRequestSchema,
} from '@clinmesh/contracts/inpatient-surgery'
import { orderSetDraftBundleSchema } from '@clinmesh/contracts/order-set-templates'
import { InpatientPostopComposer } from './inpatient-postop-composer.tsx'
import { InpatientSurgeryCompletion } from './inpatient-surgery-completion.tsx'
import { InpatientSurgery } from './inpatient-surgery.tsx'
import { InpatientActionOutlet, InpatientActionProvider } from './inpatient-workspace-actions.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const time = '2026-11-25T09:30:00+08:00'
const session: SessionContext = {
  actor: {
    actorId: 'doctor',
    epoch: 'epoch-1',
    practitionerId: 'practitioner-inpatient-doctor',
    practitionerRoleId: 'role-doctor',
    roleCode: 'inpatient-doctor',
    scenarioRunId: 'run-1',
    workspaceId: 'workspace-demo',
  },
  availableRoles: [],
  user: { email: 'doctor@demo.clinmesh.local', id: 'doctor', name: '住院医生' },
}
const admission = inpatientAdmissionSchema.parse({
  admissionRoute: 'direct',
  admittedAt: time,
  chargesFen: 0,
  depositFen: 100000,
  financialStatus: 'open',
  id: 'admission-postop-1',
  inpatientNumber: 'ZY-520',
  organizationId: 'org-1',
  patientId: 'patient-520',
  patientName: '合成术后重整患者',
  recordStatus: 'open',
  registeredAt: time,
  status: 'admitted',
  versionId: '4',
  wardId: 'ward-general',
})

const pciProcedure = {
  chargeDefinition: { id: 'charge-pci', priceFen: 320000, synthetic: true as const, trigger: 'execution' as const, unit: '次' },
  coding: {
    category: '介入治疗' as const,
    code: '36.0700',
    display: '药物洗脱冠状动脉支架置入术',
    releaseId: 'clinmesh-surgery-subset-2026-10-20',
    sourceLocator: 'synthetic',
    sourceSha256: 'a'.repeat(64),
    sourceUrl: 'https://example.com/synthetic',
    system: 'urn:clinmesh:classification:icd-9-cm-3-clinical',
    version: '3.0',
  },
  id: 'hospital-surgery-3',
  version: 1,
}
const choleProcedure = {
  chargeDefinition: { id: 'charge-chole', priceFen: 200000, synthetic: true as const, trigger: 'execution' as const, unit: '次' },
  coding: {
    category: '手术' as const,
    code: '51.2300',
    display: '腹腔镜下胆囊切除术',
    releaseId: 'clinmesh-surgery-subset-2026-10-20',
    sourceLocator: 'synthetic',
    sourceSha256: 'a'.repeat(64),
    sourceUrl: 'https://example.com/synthetic',
    system: 'urn:clinmesh:classification:icd-9-cm-3-clinical',
    version: '3.0',
  },
  id: 'hospital-surgery-4',
  version: 1,
}

const pciExecution = inpatientSurgeryExecutionSchema.parse({
  actualProcedure: pciProcedure,
  admissionId: admission.id,
  completedAt: time,
  id: 'exec-pci-1',
  materialHistory: [],
  materials: [],
  note: 'PCI 完成',
  organizationId: 'org-1',
  performedAt: time,
  performedBy: 'doctor',
  practitionerRoleId: 'role-doctor',
  requestId: 'req-pci-1',
})

const clinicalFixture = inpatientFullClinicalSchema.parse({
  admissionId: admission.id,
  charges: [],
  chargesFen: 0,
  diagnosis: {
    entries: [{
      admissionCondition: '1',
      coding: {
        code: 'I25.103',
        display: '冠状动脉粥样硬化性心脏病',
        id: 'diag-cad',
        releaseId: 'clinmesh-icd10-2026',
        sourceLocator: 'synthetic',
        system: 'urn:clinmesh:reference:nhsa-diagnosis',
        version: '2022',
      },
      conditionId: 'cond-1',
      ordinal: 1,
      role: 'primary',
    }],
    revision: 1,
  },
  dispenses: [],
  encounterVersion: '4',
  executions: [],
  orders: [],
})

const clinicalCatalogFixture = inpatientFullCatalogSchema.parse({
  diagnoses: [],
  medications: [
    {
      allowedRouteCodes: ['IVGTT'],
      defaultRouteCode: 'IVGTT',
      display: '0.9%氯化钠注射液',
      doseBasis: { amount: 500, unit: 'mL' },
      doses: [{ doseText: '1000 mL', quantity: 2 }],
      frequencyCodes: ['ONCE'],
      id: 'medication-sodium-chloride',
      lots: [],
      maxDoseQuantity: 4,
      priceFen: 600,
      strength: '500mL',
      unit: '袋',
      version: 1,
    },
    {
      allowedRouteCodes: ['PO'],
      defaultRouteCode: 'PO',
      display: '阿司匹林肠溶片',
      doseBasis: { amount: 100, unit: 'mg' },
      doses: [{ doseText: '100 mg', quantity: 1 }],
      frequencyCodes: ['QD'],
      id: 'medication-aspirin',
      lots: [],
      maxDoseQuantity: 3,
      priceFen: 100,
      strength: '100mg',
      unit: '片',
      version: 1,
    },
  ],
  services: [
    {
      display: '术后持续心电监护',
      id: 'hospital-service-postop-ecg-monitoring',
      priceFen: 6000,
      unit: '次',
      version: 1,
    },
  ],
})

const investigationCatalogFixture = inpatientInvestigationCatalogSchema.parse({
  items: [
    {
      available: true,
      display: '术后血常规（五分类）',
      id: 'lab-cbc',
      indicationCodes: ['postoperative-monitoring'],
      isPanel: true,
      kind: 'laboratory',
      laboratoryCategory: 'hematology-coagulation',
      memberCount: 5,
      priceFen: 2500,
      specimen: 'EDTA-K2 全血',
      specimenContainer: {
        capColor: 'purple',
        code: 'edta-k2-purple',
        collectionRequirementEn: 'Invert gently 8 times',
        collectionRequirementZh: '颠倒混匀 8 次',
        containerNameEn: 'Purple EDTA-K2 tube',
        containerNameZh: '紫头 EDTA-K2 抗凝管',
        mergeable: true,
        specimenCategoryEn: 'Anticoagulated whole blood',
        specimenCategoryZh: '抗凝全血',
      },
      version: 1,
    },
    {
      available: true,
      display: '十二导联心电图',
      id: 'examination-ecg-12-lead',
      indicationCodes: [],
      kind: 'examination',
      priceFen: 3000,
      version: 1,
    },
  ],
})

const pciDraftBundleFixture = orderSetDraftBundleSchema.parse({
  drafts: [{
    counts: { excluded: 1, needsReview: 1, ready: 3, skipped: 1, unavailable: 0 },
    fingerprint: 'f'.repeat(64),
    items: [
      {
        candidate: {
          catalogItemId: 'medication-sodium-chloride',
          catalogVersion: 1,
          display: '0.9%氯化钠注射液',
          doseText: '1000 mL',
          frequencyCode: 'ONCE',
          inpatient: { doseQuantity: 2, duration: 'temporary' },
          instructionsZh: '术后继续静脉滴注水化',
          kind: 'medication',
          outpatient: null,
          routeCode: 'IVGTT',
        },
        disposition: 'needs-review',
        key: 'isotonic-saline-hydration',
        kind: 'medication',
        matchedCatalogId: 'medication-sodium-chloride',
        reasons: [{
          code: 'weight-missing',
          messageZh: '缺少体重记录，无法按体重核定滴速',
          observedValue: null,
          severity: 'pending-verification',
          sourceReference: null,
          threshold: null,
        }],
        titleZh: '0.9% 氯化钠术后水化',
      },
      {
        candidate: null,
        disposition: 'skipped',
        key: 'aspirin',
        kind: 'medication',
        matchedCatalogId: 'medication-aspirin',
        reasons: [{
          code: 'already-active-order',
          messageZh: '术前已在用有效长期医嘱「阿司匹林肠溶片」，术后重整默认跳过重复开立。',
          observedValue: null,
          severity: 'skip',
          sourceReference: 'MedicationRequest/order-preop-asp',
          threshold: null,
        }],
        titleZh: '阿司匹林',
      },
      {
        candidate: null,
        disposition: 'excluded',
        key: 'beta-blocker',
        kind: 'medication',
        matchedCatalogId: 'medication-metoprolol',
        reasons: [{
          code: 'pulse-below-threshold',
          messageZh: '心率 46 次/分 低于 50 次/分：心动过缓时不起始 β 受体阻滞剂。',
          observedValue: 46,
          severity: 'exclude',
          sourceReference: 'Observation/vitals-1',
          threshold: 50,
        }],
        titleZh: 'β 受体阻滞剂',
      },
      {
        candidate: {
          display: '术后持续心电监护',
          duration: 'temporary',
          kind: 'service',
          priceFen: 6000,
          quantity: 1,
          serviceId: 'hospital-service-postop-ecg-monitoring',
          serviceVersion: 1,
          unit: '次',
        },
        disposition: 'ready',
        key: 'postop-ecg-monitoring',
        kind: 'service',
        matchedCatalogId: 'hospital-service-postop-ecg-monitoring',
        reasons: [],
        titleZh: '术后持续心电监护',
      },
      {
        candidate: {
          catalogItemId: 'lab-cbc',
          catalogVersion: 1,
          display: '术后血常规（五分类）',
          indicationCode: 'postoperative-monitoring',
          indicationCodes: ['postoperative-monitoring'],
          kind: 'laboratory',
          outpatientBilling: null,
          priceFen: 2500,
        },
        disposition: 'ready',
        key: 'postop-cbc',
        kind: 'laboratory',
        matchedCatalogId: 'lab-cbc',
        reasons: [],
        titleZh: '术后血常规（五分类）',
      },
      {
        candidate: {
          catalogVersion: 1,
          display: '十二导联心电图',
          examCode: 'ecg-12-lead',
          indication: 'PCI 术后复查 12 导联心电图',
          kind: 'examination',
          outpatientBilling: null,
          priceFen: 3000,
          serviceId: 'examination-ecg-12-lead',
        },
        disposition: 'ready',
        key: 'postop-ecg-12-lead',
        kind: 'examination',
        matchedCatalogId: 'examination-ecg-12-lead',
        reasons: [],
        titleZh: '术后常规 12 导联心电图复查',
      },
    ],
    template: {
      applicableProcedureCodes: ['36.0700'],
      descriptionZh: '冠脉介入术后标准重整组套',
      fingerprint: 'b'.repeat(64),
      id: 'pci-postop-standard',
      scopes: ['inpatient'],
      titleEn: 'PCI postoperative standard order set',
      titleZh: '冠脉介入/造影术后标准重整组套',
      version: '2026-11-25.r1',
    },
  }],
  evaluatedAt: time,
  patientFacts: {
    allergies: [],
    egfr: { missingInputs: ['serumCreatinine'], status: 'missing' },
    vitalSigns: { source: 'inpatient-nursing', status: 'missing' },
    weight: { status: 'missing' },
  },
  target: {
    admissionId: admission.id,
    encounterVersion: '4',
    preopOrderPolicy: 'continue-active',
    scope: 'inpatient',
    surgeryExecutionId: pciExecution.id,
    surgeryProcedureCode: '36.0700',
    surgeryProcedureDisplay: '药物洗脱冠状动脉支架置入术',
  },
})

const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('手术停续策略与术后医嘱重整前端组件', () => {
  it('申请手术弹窗按术式与麻醉自动推荐术前医嘱策略，支持人工切换；完术核实展示待自动停用长嘱', async () => {
    const submittedRequests: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/api/auth/context')) return Response.json(session)
      if (path.endsWith('/surgeries') && !init?.method) {
        return Response.json({
          admissionId: admission.id,
          encounterVersion: '4',
          executions: [],
          inProgress: [],
          requests: [],
          virtualTime: time,
        })
      }
      if (path.endsWith('/surgery-catalog')) {
        return Response.json(inpatientSurgeryCatalogSchema.parse({
          locations: [
            { id: 'location-catheterization-lab', name: '导管室', nameEn: 'Catheterization Lab' },
            { id: 'location-operating-center', name: '中心手术室', nameEn: 'Operating Center' },
          ],
          materials: [],
          practitioners: [{ id: 'practitioner-inpatient-doctor', name: '住院医生', title: '主治医师' }],
          procedures: [pciProcedure, choleProcedure],
        }))
      }
      if (path.endsWith('/clinical')) return Response.json(clinicalFixture)
      if (path.endsWith('/drg/reservations')) return Response.json({ admissionId: admission.id, encounterVersion: '4', reservationSets: [], reservations: [] })
      if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [], unprepared: [] })
      if (path.endsWith('/surgeries/request') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { input: Record<string, unknown> }
        submittedRequests.push(body.input)
        return Response.json({
          auditId: 'audit-req',
          data: { admissionId: admission.id, encounterVersion: '5', executions: [], inProgress: [], requests: [], virtualTime: time },
          effects: [],
          requestId: 'receipt-req',
          warnings: [],
        })
      }
      return Response.json({ error: { code: 'UNAVAILABLE', message: '未准备' } }, { status: 503 })
    }))

    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    clients.push(client)
    function SurgeryHarness() {
      const write = useInpatientWriteIntent(session, () => undefined)
      return (
        <InpatientActionProvider stage="surgery">
          <InpatientSurgery admission={admission} locale="zh-CN" session={session} write={write} />
          <InpatientActionOutlet />
        </InpatientActionProvider>
      )
    }
    const view = render(<QueryClientProvider client={client}><SurgeryHarness /></QueryClientProvider>)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: '申请手术' }))
    const dialog = await screen.findByRole('dialog', { name: '申请手术' })
    expect(within(dialog).getByLabelText('术前长期医嘱停续策略').textContent).toContain('继续术前有效长期医嘱')

    // 切换至腹腔镜胆囊切除术（全麻普外）-> 自动推荐停术前长嘱
    within(dialog).getByRole('combobox', { name: '计划术式' }).focus()
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('option', { name: /51\.2300/ }))
    expect(within(dialog).getByLabelText('术前长期医嘱停续策略').textContent).toContain('术后自动停术前长期医嘱')

    await user.type(within(dialog).getByLabelText('计划手术时间'), '2026-11-26T09:00')
    await user.type(within(dialog).getByLabelText('手术申请理由'), '胆囊结石择期手术')
    await user.click(within(dialog).getByRole('button', { name: '提交手术申请' }))
    await waitFor(() => expect(submittedRequests).toHaveLength(1))
    expect(submittedRequests[0]).toMatchObject({ preopOrderPolicy: 'stop-on-completion' })
    view.unmount()

    // 验证完术核实弹窗在 stop-on-completion 策略下渲染待自动停用长期医嘱清单
    const stopRequest = inpatientSurgeryRequestSchema.parse({
      admissionId: admission.id,
      id: 'req-chole-1',
      organizationId: 'org-1',
      plannedFor: time,
      plannedProcedure: choleProcedure,
      preopOrderPolicy: 'stop-on-completion',
      reason: '胆囊切除',
      requestedAt: time,
      requestedBy: 'doctor',
      status: 'ready',
      version: 3,
    })
    const stopExec = inpatientSurgeryExecutionSchema.parse({
      actualProcedure: choleProcedure,
      admissionId: admission.id,
      id: 'exec-chole-running',
      materialHistory: [],
      materials: [],
      note: '开始手术',
      organizationId: 'org-1',
      performedAt: time,
      performedBy: 'doctor',
      practitionerRoleId: 'role-doctor',
      requestId: stopRequest.id,
    })
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path.endsWith('/api/auth/context')) return Response.json(session)
      if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [], unprepared: [] })
      if (path.endsWith('/preview-completion')) {
        return Response.json(inpatientSurgeryCompletionPreviewSchema.parse({
          autoStopPreopOrders: [
            { display: '苯磺酸氨氯地平片', doseText: '5 mg', frequencyCode: 'QD', kind: 'medication', orderId: 'ord-1', orderVersion: 1, state: 'verified' },
          ],
          fingerprint: 'a'.repeat(64),
          linkedNursing: null,
          materialDeltaFen: 0,
          materials: [],
          nursingAmountFen: 0,
          preopOrderPolicy: 'stop-on-completion',
          procedureAmountFen: 200000,
          retainedReservations: [],
          totalDeltaFen: 200000,
        }))
      }
      return Response.json({ error: { code: 'UNAVAILABLE', message: '未准备' } }, { status: 503 })
    }))
    const client2 = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    clients.push(client2)
    function CompletionHarness() {
      const write = useInpatientWriteIntent(session, () => undefined)
      return (
        <InpatientSurgeryCompletion
          active
          admission={admission}
          catalog={inpatientSurgeryCatalogSchema.parse({ materials: [], procedures: [choleProcedure] })}
          dataReady
          execution={stopExec}
          locale="zh-CN"
          refresh={() => Promise.resolve()}
          request={stopRequest}
          reservations={[]}
          session={session}
          write={write}
        />
      )
    }
    render(<QueryClientProvider client={client2}><CompletionHarness /></QueryClientProvider>)
    await user.click(screen.getByRole('button', { name: '核实最终耗材并完成手术' }))
    const stopAlert = await screen.findByText(/以下 1 条术前长期医嘱转为「待停嘱核对」/)
    expect(stopAlert).toBeDefined()
    expect(screen.getByText(/苯磺酸氨氯地平片/)).toBeDefined()
  })

  it('术后医嘱重整编排器区分 skipped 与 excluded、展示采血管标记、自动附带 surgeryExecutionId，并在越权警示与不确定 5xx 后暂停双通道且按原回执恢复', async () => {
    const orderPosts: Array<{ input: Record<string, unknown>; key: string | null }> = []
    const investigationPosts: Array<{ input: Record<string, unknown>; key: string | null }> = []
    const receiptLookups: string[] = []
    let failFirstOrderWithQuality = true
    let failFirstInvestigationAmbiguous = true

    const alertPayload: ClinicalQualityCheck = {
      alerts: [{
        code: 'RENAL_CREATININE_MISSING',
        evidence: [],
        message: '缺少近期血肌酐记录，建议补查血肌酐',
        tier: 'alert',
      }],
      evaluatedAt: time,
      gate: 'inpatient-order',
      redLines: [],
      status: 'alert',
    }

    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/api/auth/context')) return Response.json(session)
      if (path.endsWith('/clinical')) return Response.json(clinicalFixture)
      if (path.endsWith('/clinical-catalog')) return Response.json(clinicalCatalogFixture)
      if (path.endsWith('/investigation-catalog')) return Response.json(investigationCatalogFixture)
      if (path.includes('/order-set-drafts')) return Response.json(pciDraftBundleFixture)
      if (path.endsWith('/orders/issue') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { input: Record<string, unknown> }
        const key = new Headers(init.headers).get('idempotency-key')
        orderPosts.push({ input: body.input, key })
        if (failFirstOrderWithQuality && (body.input.selection as { kind: string }).kind === 'service' && !body.input.clinicalOverride) {
          failFirstOrderWithQuality = false
          return Response.json({
            error: {
              clinicalQuality: alertPayload,
              code: 'CLINICAL_QUALITY_ALERT',
              message: '需确认越权理由',
            },
          }, { status: 409 })
        }
        return Response.json({
          auditId: 'audit-order',
          data: { ...clinicalFixture, encounterVersion: '5' },
          effects: [],
          requestId: 'receipt-order',
          warnings: [],
        })
      }
      if (path.endsWith('/investigations/issue') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { input: Record<string, unknown> }
        const key = new Headers(init.headers).get('idempotency-key')
        investigationPosts.push({ input: body.input, key })
        if (failFirstInvestigationAmbiguous) {
          failFirstInvestigationAmbiguous = false
          return Response.json({ error: { code: 'INTERNAL_ERROR', message: '模拟上游超时' } }, { status: 503 })
        }
        return Response.json({
          auditId: 'audit-inv',
          data: { admissionId: admission.id, examinationRequests: [], imagingRequests: [], laboratoryRequests: [], sent: [] },
          effects: [],
          requestId: 'receipt-inv',
          warnings: [],
        })
      }
      if (path.includes('/command-receipts?')) {
        receiptLookups.push(path)
        return Response.json({
          idempotencyKey: investigationPosts[0]?.key ?? 'unknown',
          operationId: 'inpatient.investigation.issue',
          response: {
            auditId: 'audit-inv-recovered',
            data: { admissionId: admission.id, examinationRequests: [], imagingRequests: [], laboratoryRequests: [], sent: [] },
            effects: [],
            requestId: 'receipt-inv-recovered',
            warnings: [],
          },
          status: 'completed',
        })
      }
      throw new Error(`Unexpected fetch ${path}`)
    }))

    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    clients.push(client)
    function PostopHarness() {
      const write = useInpatientWriteIntent(session, () => undefined)
      return (
        <InpatientPostopComposer
          active
          admission={admission}
          initialSurgeryExecutionId={pciExecution.id}
          locale="zh-CN"
          onOpenChange={() => undefined}
          open
          session={session}
          surgeries={[pciExecution]}
          write={write}
        />
      )
    }

    render(<QueryClientProvider client={client}><PostopHarness /></QueryClientProvider>)
    const user = userEvent.setup()

    const dialog = await screen.findByRole('dialog', { name: '开立术后医嘱（重整与复查）' })
    // 1. 清晰区分术前已在用跳过区、禁忌剔除区、采血管标记与待核实项（默认不勾选）
    expect(await within(dialog).findByText('术前已在用 · 默认跳过')).toBeDefined()
    expect(within(dialog).getByText('已按禁忌剔除')).toBeDefined()
    expect(within(dialog).getByText(/紫头 EDTA-K2 抗凝管/)).toBeDefined()
    // 3 项 ready（心电监护、血常规、心电图）默认勾选，1 项 needs-review（水化）默认未勾选
    const submitBtn = within(dialog).getByRole('button', { name: '提交术后医嘱与检查（3）' })
    expect(submitBtn.hasAttribute('disabled')).toBe(false)

    // 2. 首次提交：心电监护命中 409 CLINICAL_QUALITY_ALERT，暂停在该行等待行内越权，血常规收到 503 前不会先发（先执行完医嘱再执行检查；若医嘱 409 失败不阻碍检查，血常规遇 503 立即暂停心电图！）
    await user.click(submitBtn)
    await waitFor(() => expect(orderPosts).toHaveLength(1))
    expect(orderPosts[0]!.input).toMatchObject({ surgeryExecutionId: pciExecution.id })
    // 血常规已发出且遇 503 不确定结果 -> 立即暂停后续心电图，保留原回执恢复按钮
    await waitFor(() => expect(investigationPosts).toHaveLength(1))
    expect(investigationPosts[0]!.input).toMatchObject({ surgeryExecutionId: pciExecution.id })
    expect(await within(dialog).findByText(/已暂停后续提交/)).toBeDefined()
    const recoverBtn = await within(dialog).findByRole('button', { name: '恢复原开立：术后血常规（五分类）' })
    expect(recoverBtn).toBeDefined()

    // 3. 点击「恢复原开立」查询原幂等键回执并结清血常规
    await user.click(recoverBtn)
    await waitFor(() => expect(receiptLookups).toHaveLength(1))
    expect(receiptLookups[0]).toContain('operationId=inpatient.investigation.issue')
    expect(receiptLookups[0]).toContain(`idempotencyKey=${investigationPosts[0]!.key}`)
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: '恢复原开立：术后血常规（五分类）' })).toBeNull())

    // 4. 在保留的失败医嘱行（术后持续心电监护）通过行内 ClinicalQualityBanner 提交越权并成功开立
    const reasonCombo = await within(dialog).findByRole('combobox', { name: '受控越权原因' })
    await waitFor(() => expect(reasonCombo.hasAttribute('data-disabled')).toBe(false))
    reasonCombo.focus()
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('option', { name: '已核对外院或床旁近期检查结果' }))
    await user.type(within(dialog).getByLabelText('医学说明（至少 4 字）'), '已核实床旁肌酐与容量状态')
    await user.click(within(dialog).getByRole('button', { name: '登记说明并重新提交' }))
    await waitFor(() => expect(orderPosts).toHaveLength(2))
    expect(orderPosts[1]!.input).toMatchObject({
      clinicalOverride: {
        acknowledgedAlerts: ['RENAL_CREATININE_MISSING'],
        note: '已核实床旁肌酐与容量状态',
        reasonCode: 'external-result-verified',
      },
      surgeryExecutionId: pciExecution.id,
    })
  })

  it('多台已完成手术下切换目标手术后保留策略徽标与重新预筛按钮，并在 surgeries 数组刷新后保持所选手术与护理 quantity 透传', async () => {
    const choleExecution = inpatientSurgeryExecutionSchema.parse({
      actualProcedure: choleProcedure,
      admissionId: admission.id,
      completedAt: time,
      id: 'exec-chole-2',
      materialHistory: [],
      materials: [],
      note: '胆囊切除完成',
      organizationId: 'org-1',
      performedAt: time,
      performedBy: 'doctor',
      practitionerRoleId: 'role-doctor',
      requestId: 'req-chole-2',
    })
    const choleDraftBundle = orderSetDraftBundleSchema.parse({
      drafts: [{
        counts: { excluded: 0, needsReview: 0, ready: 1, skipped: 0, unavailable: 0 },
        fingerprint: 'e'.repeat(64),
        items: [{
          candidate: {
            display: '术后持续心电监护',
            duration: 'temporary',
            kind: 'service',
            priceFen: 6000,
            quantity: 2,
            serviceId: 'hospital-service-postop-ecg-monitoring',
            serviceVersion: 1,
            unit: '次',
          },
          disposition: 'ready',
          key: 'postop-ecg-monitoring',
          kind: 'service',
          matchedCatalogId: 'hospital-service-postop-ecg-monitoring',
          reasons: [],
          titleZh: '术后持续心电监护',
        }],
        template: {
          applicableProcedureCodes: ['51.2300'],
          descriptionZh: '普外术后重整组套',
          fingerprint: 'd'.repeat(64),
          id: 'general-surgery-postop-standard',
          scopes: ['inpatient'],
          titleEn: 'General surgery postoperative order set',
          titleZh: '普外科常规术后标准重整组套',
          version: '2026-11-25.r1',
        },
      }],
      evaluatedAt: time,
      patientFacts: {
        allergies: [],
        egfr: { missingInputs: ['serumCreatinine'], status: 'missing' },
        vitalSigns: { source: 'inpatient-nursing', status: 'missing' },
        weight: { status: 'missing' },
      },
      target: {
        admissionId: admission.id,
        encounterVersion: '4',
        preopOrderPolicy: 'stop-on-completion',
        scope: 'inpatient',
        surgeryExecutionId: choleExecution.id,
        surgeryProcedureCode: '51.2300',
        surgeryProcedureDisplay: '腹腔镜下胆囊切除术',
      },
    })
    const orderPosts: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/api/auth/context')) return Response.json(session)
      if (path.endsWith('/clinical')) return Response.json(clinicalFixture)
      if (path.endsWith('/clinical-catalog')) return Response.json(clinicalCatalogFixture)
      if (path.endsWith('/investigation-catalog')) return Response.json(investigationCatalogFixture)
      if (path.includes('/order-set-drafts')) {
        return Response.json(path.includes(choleExecution.id) ? choleDraftBundle : pciDraftBundleFixture)
      }
      if (path.endsWith('/orders/issue') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { input: Record<string, unknown> }
        orderPosts.push(body.input)
        return Response.json({
          auditId: 'audit-multi',
          data: { ...clinicalFixture, encounterVersion: '5' },
          effects: [],
          requestId: 'receipt-multi',
          warnings: [],
        })
      }
      throw new Error(`Unexpected fetch ${path}`)
    }))
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    clients.push(client)
    function MultiHarness({ list }: { list: typeof pciExecution[] }) {
      const write = useInpatientWriteIntent(session, () => undefined)
      return (
        <InpatientPostopComposer
          active
          admission={admission}
          initialSurgeryExecutionId={pciExecution.id}
          locale="zh-CN"
          onOpenChange={() => undefined}
          open
          session={session}
          surgeries={list}
          write={write}
        />
      )
    }
    const view = render(<QueryClientProvider client={client}><MultiHarness list={[pciExecution, choleExecution]} /></QueryClientProvider>)
    const user = userEvent.setup()
    const dialog = await screen.findByRole('dialog', { name: '开立术后医嘱（重整与复查）' })
    const surgeryCombo = within(dialog).getByRole('combobox', { name: '目标已完成手术' })
    surgeryCombo.focus()
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('option', { name: /51\.2300/ }))

    expect(await within(dialog).findByText('术后自动停术前长期医嘱并重整（外科/全麻）')).toBeDefined()
    expect(within(dialog).getByRole('button', { name: '按最新检查与体征重新预筛' })).toBeDefined()

    // 模拟提交过程中 TanStack Query 刷新 surgeries 返回新数组引用，不能把选中的非默认手术重置回 pciExecution
    view.rerender(<QueryClientProvider client={client}><MultiHarness list={[{ ...pciExecution }, { ...choleExecution }]} /></QueryClientProvider>)
    expect(within(dialog).getByText('术后自动停术前长期医嘱并重整（外科/全麻）')).toBeDefined()

    await user.click(within(dialog).getByRole('button', { name: '提交术后医嘱与检查（1）' }))
    await waitFor(() => expect(orderPosts).toHaveLength(1))
    expect(orderPosts[0]).toMatchObject({
      selection: { kind: 'service', quantity: 2, serviceId: 'hospital-service-postop-ecg-monitoring' },
      surgeryExecutionId: choleExecution.id,
    })
  })
})
