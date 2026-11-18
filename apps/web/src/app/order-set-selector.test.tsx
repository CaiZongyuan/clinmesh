// @vitest-environment jsdom
import type { CaseLaboratoryCatalogSearch, ClinicalCatalog, DoctorCaseDetail, SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { orderSetDraftBundleSchema, type OrderSetDraftBundle } from '@clinmesh/contracts/order-set-templates'
import type { DoctorRecommendationState } from '@clinmesh/contracts/doctor-recommendations'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentPageRegistryProvider } from './agent-page-context.tsx'
import { ExaminationPage } from './doctor/examination-page.tsx'
import { examinationFixture } from './doctor/examination.test-support.ts'
import { LaboratoryPage } from './doctor/laboratory-page.tsx'
import { PrescriptionPage, type PrescriptionPageActions } from './doctor/prescription-page.tsx'
import { InpatientClinical } from './inpatient-clinical.tsx'
import { InpatientInvestigations } from './inpatient-investigations.tsx'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { orderSetSelectorOptions } from './order-set-selector.tsx'
import { getWorkspaceMessages } from './workspace-i18n.ts'

const messages = getWorkspaceMessages('zh-CN')
const sha = 'a'.repeat(64)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

function emptyRecommendationState(kind: 'laboratory' | 'prescription', caseId: string, encounterId: string): DoctorRecommendationState {
  return {
    caseEvidence: [],
    caseId,
    encounterId,
    encounterVersion: '1',
    generation: 1,
    guidelines: [],
    inputFingerprint: sha,
    items: [],
    kind,
    missingInformation: [],
    stale: false,
    status: 'ready',
  }
}

describe('OrderSetSelectorBar outpatient & inpatient draft hydration', () => {
  it('hydrates chest-pain-stat-workup into outpatient laboratory and examination forms even when an examination server draft already exists', async () => {
    const tteDraftService = examinationFixture(true).service
    const ecgService = {
      ...examinationFixture(false).service,
      outpatientBilling: {
        currency: 'CNY' as const,
        effectiveOn: '2026-08-24',
        id: 'outpatient-charge-ecg',
        priceFen: 3000,
        source: 'synthetic-outpatient-investigation-2026-10-26-v1',
        unit: '次检查',
        version: 1,
      },
    }
    const labService: CaseLaboratoryCatalogSearch['items'][number] = {
      allowedIndicationCodes: ['clinical-evaluation'],
      componentServiceIds: [],
      doctorOrderable: true,
      executingDepartmentId: 'department-laboratory',
      id: 'hospital-lab-hs-ctni',
      localCode: 'LAB-HS-CTNI',
      nameEn: 'High-sensitivity troponin I',
      nameZh: '高敏心肌肌钙蛋白I测定',
      outpatientBilling: {
        currency: 'CNY',
        effectiveOn: '2026-08-24',
        id: 'outpatient-charge-hs-ctni',
        priceFen: 8000,
        source: 'synthetic-outpatient-investigation-2026-10-26-v1',
        unit: '项目',
        version: 1,
      },
      priceFen: 8000,
      referenceConcept: {
        code: '2100404B',
        display: '高敏心肌肌钙蛋白I测定',
        id: 'wst-886:2026:2100404B',
        sourceLocator: 'synthetic:2100404B',
        system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026',
        version: '2026',
      },
      referenceReleaseId: 'rel-1',
      reportDefinition: {
        conclusionTemplate: '合成检验结论',
        results: [{
          alternateCodings: [],
          referenceConcept: {
            code: '2100404B',
            display: '高敏心肌肌钙蛋白I测定',
            id: 'wst-886:2026:2100404B',
            sourceLocator: 'synthetic:2100404B',
            system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026',
            version: '2026',
          },
          referenceRange: { high: 16, text: '0-16 ng/L' },
          unit: { code: 'ng/L', display: 'ng/L', system: 'http://unitsofmeasure.org' },
          valueType: 'quantity',
        }],
      },
      serviceKind: 'laboratory',
      specimen: { code: 'serum', display: '血清' },
      tatMinutes: 30,
      version: 1,
    }
    const detail: DoctorCaseDetail = {
      allergies: [],
      caseId: 'case-chest-pain',
      consultation: { turns: [], version: 1 },
      encounter: { id: 'encounter-chest-pain', status: 'in-progress', versionId: '1' },
      examinationRequests: {
        draft: { indication: '既有超声草稿指征', service: tteDraftService },
        draftVersion: 2,
        requests: [],
      },
      laboratoryRequests: { draftVersion: 0, reportingSupported: true, requests: [] },
      patient: { id: 'patient-1', identifier: 'SYN-CP', name: '合成胸痛患者', synthetic: true, versionId: '1' },
      presentation: null,
      priorFacts: [],
      registrationNumber: 'MZ-001',
      status: 'first-visit',
      taskId: 'task-1',
      taskVersion: '1',
    }
    const ecgIndication = '急性胸痛首诊，10 分钟内完成 12 导联心电图评估 ST 段改变'
    const bundle: OrderSetDraftBundle = orderSetDraftBundleSchema.parse({
      drafts: [{
        counts: { excluded: 0, needsReview: 0, ready: 2, unavailable: 0 },
        fingerprint: sha,
        items: [
          {
            candidate: {
              catalogVersion: 1,
              display: ecgService.name,
              examCode: 'ecg-12-lead',
              indication: ecgIndication,
              kind: 'examination',
              outpatientBilling: ecgService.outpatientBilling,
              priceFen: 3000,
              serviceId: ecgService.id,
            },
            disposition: 'ready',
            key: 'ecg-12-lead',
            kind: 'examination',
            matchedCatalogId: ecgService.id,
            reasons: [],
            titleZh: '常规 12 导联心电图',
          },
          {
            candidate: {
              catalogItemId: labService.id,
              catalogVersion: 1,
              display: labService.nameZh,
              indicationCode: 'clinical-evaluation',
              indicationCodes: ['clinical-evaluation'],
              kind: 'laboratory',
              outpatientBilling: labService.outpatientBilling!,
              priceFen: 8000,
            },
            disposition: 'ready',
            key: 'hs-ctni',
            kind: 'laboratory',
            matchedCatalogId: labService.id,
            reasons: [],
            titleZh: '高敏心肌肌钙蛋白 I',
          },
        ],
        template: {
          descriptionZh: '急性胸痛首诊急查',
          fingerprint: sha,
          id: 'chest-pain-stat-workup',
          scopes: ['outpatient', 'inpatient'],
          titleEn: 'Chest pain stat work-up',
          titleZh: '胸痛首诊急查',
          version: '2026-11-18.r1',
        },
      }],
      evaluatedAt: '2026-11-18T09:05:00+08:00',
      patientFacts: {
        allergies: [],
        egfr: { missingInputs: ['serumCreatinine'], status: 'missing' },
        vitalSigns: { source: 'triage', status: 'missing' },
        weight: { status: 'missing' },
      },
      target: { caseId: detail.caseId, encounterId: detail.encounter.id, encounterVersion: '1', scope: 'outpatient' },
    })

    const writeMethods: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method !== 'GET') writeMethods.push(`${method} ${String(input)}`)
      const url = String(input)
      if (url.includes('/order-set-drafts')) return Response.json(bundle)
      if (url.endsWith('/examination-services')) {
        return Response.json({
          items: [
            { available: true, service: ecgService },
            { available: true, service: tteDraftService },
          ],
        })
      }
      return Response.json(emptyRecommendationState('laboratory', detail.caseId, detail.encounter.id))
    }))

    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    const user = userEvent.setup()
    render(
      <QueryClientProvider client={client}>
        <AgentPageRegistryProvider>
          <LaboratoryPage
            actions={{
              correct: { allowed: false, error: null, onSubmit: vi.fn(), pending: false },
              deleteDraft: { error: null, onSubmit: vi.fn(), pending: false },
              issue: { error: null, onSubmit: vi.fn(), pending: false },
              save: { error: null, onSubmit: vi.fn(), pending: false },
            }}
            catalogError={null}
            catalogPending={false}
            detail={detail}
            elementId="laboratory-tab"
            indicationCode=""
            issueLegacyOrderError={null}
            issueLegacyOrderPending={false}
            laboratoryCatalog={[]}
            laboratoryItemId=""
            locale="zh-CN"
            messages={messages}
            onIndicationChange={vi.fn()}
            onIssueLegacyOrder={vi.fn()}
            onLaboratoryItemChange={vi.fn()}
            readOnly={false}
            recommendationScope="scope-op"
            referenceSearch={{ data: { items: [labService], page: 1, pageSize: 20, total: 1 }, error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn() }}
            showCorrection={false}
          />
          <ExaminationPage
            actionContext={undefined}
            active
            detail={detail}
            elementId="examination-tab"
            locale="zh-CN"
            onSelectRequest={vi.fn()}
            readOnly={false}
            recommendationScope="scope-op"
          />
        </AgentPageRegistryProvider>
      </QueryClientProvider>,
    )

    const examSection = document.getElementById('examination-tab')!
    expect((within(examSection).getByLabelText('检查指征') as HTMLTextAreaElement).value).toBe('既有超声草稿指征')

    const labSection = document.getElementById('laboratory-tab')!
    await user.click(within(labSection).getByRole('button', { name: '套用专病组套' }))

    const pendingLabRegion = await screen.findByRole('region', { name: '待开具检验' })
    await waitFor(() => {
      expect(within(pendingLabRegion).getByRole('checkbox', { name: '选择高敏心肌肌钙蛋白I测定' }).getAttribute('aria-checked')).toBe('true')
    })
    expect(within(labSection).getByText(/已同步预填功能检查「常规十二导联心电图」/)).toBeTruthy()
    await waitFor(() => {
      expect((within(examSection).getByLabelText('检查指征') as HTMLTextAreaElement).value).toBe(ecgIndication)
    })

    // Also verify applying directly from ExaminationPage while state.draft exists keeps the ECG pre-fill
    await user.clear(within(examSection).getByLabelText('检查指征'))
    await user.click(within(examSection).getByRole('button', { name: '套用专病组套' }))
    await waitFor(() => {
      expect((within(examSection).getByLabelText('检查指征') as HTMLTextAreaElement).value).toBe(ecgIndication)
    })
    expect(writeMethods).toEqual([])
    client.clear()
  })

  it('marks PrescriptionPage dirty on apply and purges newly excluded items while unchecking needs-review items on re-apply', async () => {
    type Medication = Extract<ClinicalCatalog, { prescriptionConclusionSupported: true }>['medications'][number]
    const catalog: Medication[] = [
      {
        allowedCombinationIds: ['medication-pci-clopidogrel', 'medication-perindopril'],
        allowedCourseDays: [7],
        allowedDoseTexts: ['100 mg'],
        allowedFrequencyCodes: ['QD'],
        allowedQuantities: [7],
        defaultCourseDays: 7,
        defaultDoseText: '100 mg',
        defaultFrequencyCode: 'QD',
        defaultQuantity: 7,
        id: 'medication-pci-aspirin',
        nameEn: 'Aspirin',
        nameZh: '阿司匹林肠溶片',
        safety: {
          doseLimits: { maximumDailyDose: 300, maximumSingleDose: 300, minimumSingleDose: 50, unit: 'mg' },
          indicationPrefixes: ['I25'],
          maximumDailyQuantity: 3,
          pharmacologyClasses: ['antiplatelet-aspirin'],
        },
        version: 1,
      },
      {
        allowedCombinationIds: ['medication-pci-aspirin', 'medication-perindopril'],
        allowedCourseDays: [7],
        allowedDoseTexts: ['75 mg'],
        allowedFrequencyCodes: ['QD'],
        allowedQuantities: [7],
        defaultCourseDays: 7,
        defaultDoseText: '75 mg',
        defaultFrequencyCode: 'QD',
        defaultQuantity: 7,
        id: 'medication-pci-clopidogrel',
        nameEn: 'Clopidogrel',
        nameZh: '硫酸氢氯吡格雷片',
        safety: {
          doseLimits: { maximumDailyDose: 300, maximumSingleDose: 300, minimumSingleDose: 75, unit: 'mg' },
          indicationPrefixes: ['I25'],
          maximumDailyQuantity: 4,
          pharmacologyClasses: ['p2y12'],
        },
        version: 1,
      },
      {
        allowedCombinationIds: ['medication-pci-aspirin', 'medication-pci-clopidogrel'],
        allowedCourseDays: [7],
        allowedDoseTexts: ['4 mg'],
        allowedFrequencyCodes: ['QD'],
        allowedQuantities: [7],
        defaultCourseDays: 7,
        defaultDoseText: '4 mg',
        defaultFrequencyCode: 'QD',
        defaultQuantity: 7,
        id: 'medication-perindopril',
        nameEn: 'Perindopril',
        nameZh: '培哚普利片',
        safety: {
          doseLimits: { maximumDailyDose: 8, maximumSingleDose: 8, minimumSingleDose: 2, unit: 'mg' },
          indicationPrefixes: ['I25'],
          maximumDailyQuantity: 2,
          pharmacologyClasses: ['acei'],
        },
        version: 1,
      },
    ]
    const detail: DoctorCaseDetail = {
      allergies: [],
      caseId: 'case-rx-os',
      encounter: { id: 'encounter-rx-os', versionId: '1' },
      patient: { id: 'patient-rx', identifier: 'SYN-RX', name: '合成二级预防患者', synthetic: true, versionId: '1' },
      presentation: null,
      priorFacts: [],
      registrationNumber: 'MZ-002',
      status: 'first-visit',
      taskId: 'task-rx',
      taskVersion: '1',
    }
    const initialBundle: OrderSetDraftBundle = orderSetDraftBundleSchema.parse({
      drafts: [{
        counts: { excluded: 1, needsReview: 0, ready: 3, unavailable: 0 },
        fingerprint: sha,
        items: [
          {
            candidate: {
              catalogItemId: 'medication-pci-aspirin',
              catalogVersion: 1,
              display: '阿司匹林肠溶片',
              doseText: '100 mg',
              frequencyCode: 'QD',
              inpatient: null,
              instructionsZh: null,
              kind: 'medication',
              outpatient: { courseDays: 7, quantity: 7 },
            },
            disposition: 'ready',
            key: 'aspirin',
            kind: 'medication',
            matchedCatalogId: 'medication-pci-aspirin',
            reasons: [],
            titleZh: '阿司匹林',
          },
          {
            candidate: {
              catalogItemId: 'medication-pci-clopidogrel',
              catalogVersion: 1,
              display: '硫酸氢氯吡格雷片',
              doseText: '75 mg',
              frequencyCode: 'QD',
              inpatient: null,
              instructionsZh: null,
              kind: 'medication',
              outpatient: { courseDays: 7, quantity: 7 },
            },
            disposition: 'ready',
            key: 'p2y12-inhibitor',
            kind: 'medication',
            matchedCatalogId: 'medication-pci-clopidogrel',
            reasons: [],
            titleZh: '氯吡格雷（P2Y12 抑制剂）',
          },
          {
            candidate: null,
            disposition: 'excluded',
            key: 'beta-blocker',
            kind: 'medication',
            matchedCatalogId: 'medication-metoprolol',
            reasons: [{
              code: 'pulse-below-threshold',
              messageZh: '心率 46 次/分 低于 50 次/分：心动过缓时不在组套中起始 β 受体阻滞剂。',
              observedValue: 46,
              severity: 'exclude',
              sourceReference: 'Observation/vitals-1',
              threshold: 50,
            }],
            titleZh: 'β 受体阻滞剂',
          },
          {
            candidate: {
              catalogItemId: 'medication-perindopril',
              catalogVersion: 1,
              display: '培哚普利片',
              doseText: '4 mg',
              frequencyCode: 'QD',
              inpatient: null,
              instructionsZh: null,
              kind: 'medication',
              outpatient: { courseDays: 7, quantity: 7 },
            },
            disposition: 'ready',
            key: 'acei',
            kind: 'medication',
            matchedCatalogId: 'medication-perindopril',
            reasons: [],
            titleZh: '血管紧张素转换酶抑制剂',
          },
        ],
        template: {
          descriptionZh: '二级预防标准用药',
          fingerprint: sha,
          id: 'cad-pci-secondary-prevention',
          scopes: ['outpatient', 'inpatient'],
          titleEn: 'CAD/PCI secondary prevention',
          titleZh: '冠心病/PCI 二级预防',
          version: '2026-11-18.r1',
        },
      }],
      evaluatedAt: '2026-11-18T09:10:00+08:00',
      patientFacts: {
        allergies: [],
        egfr: { sourceReferences: [], status: 'present', valueMlMin173: 82 },
        vitalSigns: {
          diastolicMmHg: 72,
          pulseBpm: 46,
          recordedAt: '2026-11-18T08:50:00+08:00',
          reference: 'Observation/vitals-1',
          source: 'triage',
          status: 'present',
          systolicMmHg: 118,
          versionId: '1',
        },
        weight: { status: 'missing' },
      },
      target: { caseId: detail.caseId, encounterId: detail.encounter.id, encounterVersion: '1', scope: 'outpatient' },
    })

    const deterioratedBundle: OrderSetDraftBundle = orderSetDraftBundleSchema.parse({
      ...initialBundle,
      drafts: [{
        ...initialBundle.drafts[0]!,
        counts: { excluded: 2, needsReview: 1, ready: 1, unavailable: 0 },
        items: [
          initialBundle.drafts[0]!.items[0]!,
          {
            candidate: null,
            disposition: 'excluded',
            key: 'p2y12-inhibitor',
            kind: 'medication',
            matchedCatalogId: 'medication-pci-clopidogrel',
            reasons: [{
              allergen: { code: 'CLOPIDOGREL', display: '硫酸氢氯吡格雷' },
              code: 'allergy-contraindication',
              messageZh: '患者存在已确认的有效药物过敏（硫酸氢氯吡格雷，编码 CLOPIDOGREL），组套剔除该药。',
              observedValue: null,
              severity: 'exclude',
              sourceReference: 'AllergyIntolerance/a1',
              threshold: null,
            }],
            titleZh: '氯吡格雷（P2Y12 抑制剂）',
          },
          initialBundle.drafts[0]!.items[2]!,
          {
            ...initialBundle.drafts[0]!.items[3]!,
            disposition: 'needs-review',
            reasons: [{
              code: 'egfr-missing',
              messageZh: '缺少可计算 eGFR（CKD-EPI 2021）的血肌酐或人口学资料，不按肾功能正常处理；肾功能下降须按肌酐清除率减量，须核实后再开立。',
              observedValue: null,
              severity: 'pending-verification',
              sourceReference: null,
              threshold: null,
            }],
          },
        ],
      }],
      patientFacts: {
        ...initialBundle.patientFacts,
        allergies: [{ code: 'CLOPIDOGREL', display: '硫酸氢氯吡格雷', reference: 'AllergyIntolerance/a1' }],
        egfr: { missingInputs: ['serumCreatinine'], status: 'missing' },
      },
    })

    let activeBundle = initialBundle
    const writeMethods: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method !== 'GET') writeMethods.push(`${method} ${String(input)}`)
      if (String(input).includes('/order-set-drafts')) return Response.json(activeBundle)
      return Response.json(emptyRecommendationState('prescription', detail.caseId, detail.encounter.id))
    }))

    const actions: PrescriptionPageActions = {
      confirmNoMedication: { error: null, onSubmit: vi.fn(), pending: false },
      deleteDraft: { data: undefined, error: null, onSubmit: vi.fn(), pending: false },
      issue: { error: null, onSubmit: vi.fn(), pending: false },
      saveDraft: { error: null, onSubmit: vi.fn(), pending: false, savedRevision: undefined, success: false },
      withdraw: { error: null, onSubmit: vi.fn(), pending: false },
    }
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    const user = userEvent.setup()
    render(
      <QueryClientProvider client={client}>
        <AgentPageRegistryProvider>
          <PrescriptionPage
            actions={actions}
            allowWithdrawal={false}
            catalog={catalog}
            detail={detail}
            elementId="prescription-tab"
            locale="zh-CN"
            messages={messages}
            readOnly={false}
            recommendationScope="scope-rx"
            referenceSearch={{ data: { items: [], page: 1, pageSize: 20, releaseId: 'rel-1', total: 0 }, error: null, isError: false, isFetching: false, isPending: false, onSearch: vi.fn() }}
          />
        </AgentPageRegistryProvider>
      </QueryClientProvider>,
    )

    await user.click(screen.getByRole('button', { name: '套用专病组套' }))
    const pendingPanel = await screen.findByRole('region', { name: '待开具处方' })
    await waitFor(() => {
      expect(within(pendingPanel).getByRole('checkbox', { name: '选择阿司匹林肠溶片' }).getAttribute('aria-checked')).toBe('true')
      expect(within(pendingPanel).getByRole('checkbox', { name: '选择硫酸氢氯吡格雷片' }).getAttribute('aria-checked')).toBe('true')
      expect(within(pendingPanel).getByRole('checkbox', { name: '选择培哚普利片' }).getAttribute('aria-checked')).toBe('true')
    })
    expect(within(pendingPanel).queryByRole('checkbox', { name: /美托洛尔/ })).toBeNull()
    expect(screen.getByText('已按禁忌剔除')).toBeTruthy()
    expect(screen.getByText(/心率 46 次\/分 低于 50 次\/分/)).toBeTruthy()

    // Autosave syncs the prescription draft (dirty === true) while never issuing a formal prescription
    await waitFor(() => {
      expect(actions.saveDraft.onSubmit).toHaveBeenCalledTimes(1)
    }, { timeout: 2_000 })
    expect(actions.saveDraft.onSubmit).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({ catalogItemId: 'medication-pci-aspirin' }),
      expect.objectContaining({ catalogItemId: 'medication-pci-clopidogrel' }),
      expect.objectContaining({ catalogItemId: 'medication-perindopril' }),
    ]))
    expect(actions.issue.onSubmit).not.toHaveBeenCalled()

    // Re-apply after clopidogrel allergy + missing eGFR: clopidogrel is purged from draft and perindopril becomes unchecked
    activeBundle = deterioratedBundle
    await user.click(screen.getByRole('button', { name: '套用专病组套' }))
    await waitFor(() => {
      expect(within(pendingPanel).queryByRole('checkbox', { name: '选择硫酸氢氯吡格雷片' })).toBeNull()
      expect(within(pendingPanel).getByRole('checkbox', { name: '选择培哚普利片' }).getAttribute('aria-checked')).toBe('false')
      expect(within(pendingPanel).getByRole('checkbox', { name: '选择阿司匹林肠溶片' }).getAttribute('aria-checked')).toBe('true')
    })
    expect(screen.getByText(/已从待开清单移除受限项 1 项/)).toBeTruthy()
    expect(screen.getByText(/编码 CLOPIDOGREL/)).toBeTruthy()
    expect(actions.issue.onSubmit).not.toHaveBeenCalled()
    expect(writeMethods).toEqual([])
    client.clear()
  })

  it('scopes InpatientInvestigationComposer to pure investigation templates without dropping medications, and purges/unchecks restricted items on re-apply in InpatientOrderComposer', async () => {
    const pureInpatientInvestigations = orderSetSelectorOptions.filter(option =>
      option.scopes.includes('inpatient')
      && option.itemKinds.some(kind => kind === 'laboratory' || kind === 'examination')
      && !option.itemKinds.includes('medication'))
    expect(pureInpatientInvestigations.map(option => option.id)).toEqual([
      'chest-pain-stat-workup',
      'cad-admission-baseline',
    ])

    const session: SessionContext = {
      actor: {
        actorId: 'actor-ip-doc',
        epoch: 'epoch-1',
        organizationId: 'organization-inpatient',
        practitionerRoleId: 'role-ip-doc',
        roleCode: 'inpatient-doctor',
        scenarioRunId: 'run-1',
        workspaceId: 'workspace-demo',
      },
      availableRoles: [],
      user: { email: 'ip-doc@demo.clinmesh.local', id: 'user-ip-doc', name: '住院医生' },
    }
    const admission = inpatientAdmissionSchema.parse({
      admissionRoute: 'direct',
      chargesFen: 0,
      depositFen: 50000,
      financialStatus: 'open',
      id: 'admission-os-1',
      inpatientNumber: 'ZY-OS-1',
      organizationId: 'organization-inpatient',
      patientId: 'patient-ip-1',
      patientName: '合成住院患者',
      recordStatus: 'open',
      registeredAt: '2026-11-18T08:00:00+08:00',
      status: 'admitted',
      versionId: '2',
      wardId: 'ward-general',
    })
    const salineCatalogItem = {
      doseBasis: { amount: 500, unit: 'mL' },
      doses: [{ doseText: '500 mL', quantity: 1 }],
      display: '0.9%氯化钠注射液',
      frequencyCodes: ['QD', 'ONCE'] as const,
      id: 'medication-sodium-chloride',
      lots: [],
      maxDoseQuantity: 6,
      priceFen: 100,
      unit: '瓶',
      version: 1,
    }
    const hydrationReadyBundle: OrderSetDraftBundle = orderSetDraftBundleSchema.parse({
      drafts: [{
        counts: { excluded: 0, needsReview: 0, ready: 2, unavailable: 0 },
        fingerprint: sha,
        items: [
          {
            candidate: {
              catalogItemId: salineCatalogItem.id,
              catalogVersion: 1,
              display: salineCatalogItem.display,
              doseText: '1000 mL',
              frequencyCode: 'ONCE',
              inpatient: { doseQuantity: 2, duration: 'temporary' },
              instructionsZh: '静脉滴注，按 1 mL/kg/h 调整滴速',
              kind: 'medication',
              outpatient: null,
            },
            disposition: 'ready',
            key: 'isotonic-saline-hydration',
            kind: 'medication',
            matchedCatalogId: salineCatalogItem.id,
            reasons: [],
            titleZh: '0.9% 氯化钠围术期水化',
          },
          {
            candidate: {
              catalogItemId: 'hospital-lab-scr',
              catalogVersion: 1,
              display: '肌酐测定',
              indicationCode: 'clinical-evaluation',
              indicationCodes: ['clinical-evaluation'],
              kind: 'laboratory',
              outpatientBilling: null,
              priceFen: 1000,
            },
            disposition: 'ready',
            key: 'creatinine-recheck',
            kind: 'laboratory',
            matchedCatalogId: 'hospital-lab-scr',
            reasons: [],
            titleZh: '血肌酐复查',
          },
        ],
        template: {
          descriptionZh: '对比剂肾损高危围术期水化',
          fingerprint: sha,
          id: 'cin-perioperative-hydration',
          scopes: ['inpatient'],
          titleEn: 'Contrast nephropathy perioperative hydration',
          titleZh: '对比剂肾损高危围术期水化',
          version: '2026-11-18.r1',
        },
      }],
      evaluatedAt: '2026-11-18T09:15:00+08:00',
      patientFacts: {
        allergies: [],
        egfr: { sourceReferences: [], status: 'present', valueMlMin173: 41.2 },
        vitalSigns: {
          diastolicMmHg: 76,
          pulseBpm: 72,
          recordedAt: '2026-11-18T08:30:00+08:00',
          reference: 'Observation/ip-v1',
          source: 'inpatient-nursing',
          status: 'present',
          systolicMmHg: 124,
          versionId: '1',
        },
        weight: { recordedAt: '2026-11-18T08:30:00+08:00', reference: 'Observation/ip-v1', status: 'present', versionId: '1', weightKg: 68 },
      },
      target: { admissionId: admission.id, encounterVersion: '2', scope: 'inpatient' },
    })

    const hydrationReviewBundle: OrderSetDraftBundle = orderSetDraftBundleSchema.parse({
      ...hydrationReadyBundle,
      drafts: [{
        ...hydrationReadyBundle.drafts[0]!,
        counts: { excluded: 0, needsReview: 1, ready: 1, unavailable: 0 },
        items: [
          {
            ...hydrationReadyBundle.drafts[0]!.items[0]!,
            disposition: 'needs-review',
            reasons: [{
              code: 'weight-missing',
              messageZh: '缺少体重记录，无法按体重核定剂量或滴速；水化滴速按体重 1 mL/kg/h 核定，须核实后再开立。',
              observedValue: null,
              severity: 'pending-verification',
              sourceReference: null,
              threshold: null,
            }],
          },
          hydrationReadyBundle.drafts[0]!.items[1]!,
        ],
      }],
      patientFacts: { ...hydrationReadyBundle.patientFacts, weight: { status: 'missing' } },
    })

    const hydrationExcludedBundle: OrderSetDraftBundle = orderSetDraftBundleSchema.parse({
      ...hydrationReadyBundle,
      drafts: [{
        ...hydrationReadyBundle.drafts[0]!,
        counts: { excluded: 1, needsReview: 0, ready: 1, unavailable: 0 },
        items: [
          {
            candidate: null,
            disposition: 'excluded',
            key: 'isotonic-saline-hydration',
            kind: 'medication',
            matchedCatalogId: salineCatalogItem.id,
            reasons: [{
              allergen: { code: 'NACL', display: '氯化钠制剂' },
              code: 'allergy-contraindication',
              messageZh: '患者存在已确认的有效药物过敏（氯化钠制剂，编码 NACL），组套剔除该药。',
              observedValue: null,
              severity: 'exclude',
              sourceReference: 'AllergyIntolerance/ip-a1',
              threshold: null,
            }],
            titleZh: '0.9% 氯化钠围术期水化',
          },
          hydrationReadyBundle.drafts[0]!.items[1]!,
        ],
      }],
    })

    const chestPainInpatientBundle: OrderSetDraftBundle = orderSetDraftBundleSchema.parse({
      ...hydrationReadyBundle,
      drafts: [{
        counts: { excluded: 0, needsReview: 0, ready: 2, unavailable: 0 },
        fingerprint: sha,
        items: [
          {
            candidate: {
              catalogVersion: 1,
              display: '常规十二导联心电图',
              examCode: 'ecg-12-lead',
              indication: '急性胸痛首诊，10 分钟内完成 12 导联心电图评估 ST 段改变',
              kind: 'examination',
              outpatientBilling: null,
              priceFen: 3000,
              serviceId: 'examination-ecg-12-lead',
            },
            disposition: 'ready',
            key: 'ecg-12-lead',
            kind: 'examination',
            matchedCatalogId: 'examination-ecg-12-lead',
            reasons: [],
            titleZh: '常规 12 导联心电图',
          },
          {
            candidate: {
              catalogItemId: 'hospital-lab-hs-ctni',
              catalogVersion: 1,
              display: '高敏心肌肌钙蛋白I测定',
              indicationCode: 'clinical-evaluation',
              indicationCodes: ['clinical-evaluation'],
              kind: 'laboratory',
              outpatientBilling: null,
              priceFen: 8000,
            },
            disposition: 'ready',
            key: 'hs-ctni',
            kind: 'laboratory',
            matchedCatalogId: 'hospital-lab-hs-ctni',
            reasons: [],
            titleZh: '高敏心肌肌钙蛋白 I',
          },
        ],
        template: {
          descriptionZh: '胸痛首诊急查',
          fingerprint: sha,
          id: 'chest-pain-stat-workup',
          scopes: ['outpatient', 'inpatient'],
          titleEn: 'Chest pain stat work-up',
          titleZh: '胸痛首诊急查',
          version: '2026-11-18.r1',
        },
      }],
    })

    let currentHydration = hydrationReadyBundle
    const writeMethods: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const url = String(input)
      if (method !== 'GET') writeMethods.push(`${method} ${url}`)
      if (url.includes('templateId=chest-pain-stat-workup')) return Response.json(chestPainInpatientBundle)
      if (url.includes('/order-set-drafts')) return Response.json(currentHydration)
      if (url.endsWith('/clinical-catalog')) return Response.json({ diagnoses: [], medications: [salineCatalogItem], services: [] })
      if (url.endsWith('/clinical')) {
        return Response.json({
          admissionId: admission.id,
          charges: [],
          chargesFen: 0,
          diagnosis: {
            entries: [{
              admissionCondition: '1',
              coding: { code: 'I25.103', display: '冠状动脉粥样硬化性心脏病', id: 'diag-cad', sourceLocator: 'synthetic', system: 'urn:clinmesh:reference:nhsa-diagnosis', version: '2022' },
              conditionId: 'cond-1',
              ordinal: 1,
              role: 'primary',
            }],
            revision: 1,
          },
          dispenses: [],
          encounterVersion: '2',
          executions: [],
          orders: [],
        })
      }
      if (url.includes('/catalog-search?')) {
        return Response.json({
          items: [{ catalogItemId: salineCatalogItem.id, catalogVersion: 1, display: salineCatalogItem.display, id: salineCatalogItem.id, medication: salineCatalogItem, missingFields: [], status: 'available' }],
          kind: 'medication',
          page: 1,
          pageSize: 20,
          source: 'hospital',
          total: 1,
        })
      }
      if (url.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', executions: [], requests: [], virtualTime: '2026-11-18T09:00:00+08:00' })
      if (url.endsWith('/investigations')) return Response.json({ admissionId: admission.id, examinationRequests: [], imagingRequests: [], laboratoryRequests: [], sent: [] })
      if (url.endsWith('/investigation-catalog')) {
        return Response.json({
          items: [
            { available: true, display: '肌酐测定', id: 'hospital-lab-scr', indicationCodes: ['clinical-evaluation'], kind: 'laboratory', priceFen: 1000, version: 1 },
            { available: true, display: '高敏心肌肌钙蛋白I测定', id: 'hospital-lab-hs-ctni', indicationCodes: ['clinical-evaluation'], kind: 'laboratory', priceFen: 8000, version: 1 },
            { available: true, display: '常规十二导联心电图', id: 'examination-ecg-12-lead', indicationCodes: [], kind: 'examination', priceFen: 3000, version: 1 },
          ],
        })
      }
      throw new Error(`Unexpected request: ${method} ${url}`)
    }))

    function Harness() {
      const write = useInpatientWriteIntent(session, () => undefined)
      return (
        <>
          <InpatientWriteRecovery locale="zh-CN" write={write} />
          <InpatientClinical admission={admission} locale="zh-CN" session={session} write={write} />
          <InpatientInvestigations admission={admission} locale="zh-CN" session={session} write={write} />
        </>
      )
    }
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    const user = userEvent.setup()
    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    )

    // 1. Apply ready hydration in InpatientOrderComposer -> checked, and syncs creatinine recheck
    await user.click(await screen.findByRole('button', { name: '开立医嘱' }))
    const orderDialog = within(screen.getByRole('dialog', { name: '开立医嘱' }))
    await user.click(orderDialog.getByRole('button', { name: '套用专病组套' }))
    const salineSection = await orderDialog.findByRole('region', { name: '待开：0.9%氯化钠注射液' })
    expect(within(salineSection).getByRole('checkbox', { name: '选择待开0.9%氯化钠注射液' }).getAttribute('aria-checked')).toBe('true')
    expect((within(salineSection).getByRole('textbox', { name: '每次剂量' }) as HTMLInputElement).value).toBe('1000 mL')
    expect(within(salineSection).getByRole('button', { name: '临时' }).getAttribute('aria-pressed')).toBe('true')
    expect(orderDialog.getByText(/同时向「开立住院检查」待开清单加入 1 项/)).toBeTruthy()

    // 2. Re-apply when saline becomes needs-review -> existing row becomes unchecked
    currentHydration = hydrationReviewBundle
    await user.click(orderDialog.getByRole('button', { name: '套用专病组套' }))
    await waitFor(() => {
      expect(within(salineSection).getByRole('checkbox', { name: '选择待开0.9%氯化钠注射液' }).getAttribute('aria-checked')).toBe('false')
    })
    expect(orderDialog.getByText(/缺少体重记录/)).toBeTruthy()

    // 3. Re-apply when saline becomes excluded -> existing row is removed from pending orders
    currentHydration = hydrationExcludedBundle
    await user.click(orderDialog.getByRole('button', { name: '套用专病组套' }))
    await waitFor(() => {
      expect(orderDialog.queryByRole('region', { name: '待开：0.9%氯化钠注射液' })).toBeNull()
    })
    expect(orderDialog.getByText(/已从待开清单移除受限项 1 项/)).toBeTruthy()
    await user.click(orderDialog.getByRole('button', { name: '关闭' }))

    // 4. Open InpatientInvestigationComposer: defaults to pure-investigation template (chest-pain-stat-workup) and hydrates both lab & exam
    await user.click(screen.getByRole('button', { name: '开立住院检查' }))
    const invDialog = within(screen.getByRole('dialog', { name: '开立住院检查' }))
    expect(invDialog.getByRole('combobox', { name: '专病组套' }).textContent).toContain('胸痛首诊急查')
    const scrSection = await invDialog.findByRole('region', { name: '待开：肌酐测定' })
    expect(within(scrSection).getByRole('checkbox', { name: '选择待开肌酐测定' }).getAttribute('aria-checked')).toBe('true')

    await user.click(invDialog.getByRole('button', { name: '套用专病组套' }))
    expect(await invDialog.findByRole('region', { name: '待开：高敏心肌肌钙蛋白I测定' })).toBeTruthy()
    await user.click(invDialog.getByRole('button', { name: '功能检查' }))
    expect(await invDialog.findByRole('region', { name: '待开：常规十二导联心电图' })).toBeTruthy()
    expect(writeMethods).toEqual([])
    client.clear()
  })
})
