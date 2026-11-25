// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientAngiographyReportSchema } from '@clinmesh/contracts/inpatient-angiography'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientMaterialEstimateSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientRecordResponseSchema, inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { InpatientSurgery } from './inpatient-surgery.tsx'
import { InpatientActionOutlet, InpatientActionProvider } from './inpatient-workspace-actions.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const time = '2026-11-25T09:00:00+08:00'
const session: SessionContext = {
  actor: {
    actorId: 'doctor',
    workspaceId: 'workspace-demo',
    epoch: 'epoch-1',
    scenarioRunId: 'run-1',
    practitionerId: 'practitioner-inpatient-doctor',
    practitionerRoleId: 'role-doctor',
    roleCode: 'inpatient-doctor',
  },
  user: { id: 'doctor', name: '住院医生', email: 'doctor@demo.clinmesh.local' },
  availableRoles: [],
}
const admission = inpatientAdmissionSchema.parse({
  id: 'admission-adhoc-1',
  patientId: 'patient-adhoc-1',
  patientName: '合成同台患者',
  inpatientNumber: 'ZY-ADHOC-01',
  admissionRoute: 'direct',
  wardId: 'ward-1',
  organizationId: 'org-1',
  status: 'admitted',
  financialStatus: 'open',
  recordStatus: 'open',
  registeredAt: time,
  depositFen: 500000,
  chargesFen: 88000,
  versionId: '2',
})
const angioProc = {
  id: 'hospital-surgery-7',
  version: 1,
  coding: {
    system: 'urn:clinmesh:classification:icd-9-cm-3-clinical' as const,
    version: '3.0' as const,
    code: '88.5500',
    display: '单根导管的冠状动脉造影术',
    category: '诊断性操作' as const,
    releaseId: 'clinmesh-surgery-subset-2026-10-20' as const,
    sourceUrl: 'https://example.com/s',
    sourceSha256: 'a'.repeat(64),
    sourceLocator: 's',
  },
  chargeDefinition: { id: 'c-angio', priceFen: 80000, unit: '次', synthetic: true as const, trigger: 'execution' as const },
}
const pciProc = {
  ...angioProc,
  id: 'hospital-surgery-8',
  coding: { ...angioProc.coding, code: '36.0700', display: '药物洗脱冠状动脉支架置入术', category: '介入治疗' as const },
  chargeDefinition: { id: 'c-pci', priceFen: 180000, unit: '次', synthetic: true as const, trigger: 'execution' as const },
}
const appendProc = {
  ...angioProc,
  id: 'hospital-surgery-4',
  coding: { ...angioProc.coding, code: '47.0100', display: '腹腔镜下阑尾切除术', category: '手术' as const },
  chargeDefinition: { id: 'c-append', priceFen: 200000, unit: '次', synthetic: true as const, trigger: 'execution' as const },
}
const stentMaterial = {
  id: 'hospital-material-pci-stent',
  version: 1,
  display: '合成演示冠脉药物支架',
  chargeDefinition: { id: 'c-stent', priceFen: 80000, unit: '个', synthetic: true as const, trigger: 'execution' as const },
}
const catalogResponse = {
  procedures: [angioProc, pciProc, appendProc],
  materials: [stentMaterial],
  locations: [
    { id: 'location-catheterization-lab', name: '导管室', nameEn: 'Catheterization Lab' },
    { id: 'location-operating-center', name: '中心手术室', nameEn: 'Operating Center' },
  ],
  practitioners: [{ id: 'practitioner-inpatient-doctor', name: '住院医生', title: '主治医师' }],
  baseStockMedications: [],
  medicationPackages: [],
  nursingBindings: [
    {
      serviceId: 'service-nursing-interventional',
      serviceVersion: 1,
      display: '术中介入专科护理',
      unit: '次',
      priceFen: 8000,
      procedureIds: [angioProc.id, pciProc.id],
    },
  ],
}
const clinicalResponse = inpatientFullClinicalSchema.parse({
  admissionId: admission.id,
  encounterVersion: '2',
  diagnosis: {
    revision: 1,
    entries: [
      {
        conditionId: 'cond-1',
        role: 'primary',
        admissionCondition: '1',
        ordinal: 1,
        coding: {
          id: 'diag-1',
          system: 'urn:clinmesh:reference:nhsa-diagnosis',
          version: '2022',
          code: 'I25.103',
          display: '冠状动脉粥样硬化性心脏病',
          releaseId: 'clinmesh-icd10-2026',
          sourceLocator: 'cn-health:1',
        },
      },
    ],
  },
  orders: [],
  executions: [],
  dispenses: [],
  charges: [],
  chargesFen: 88000,
})

const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

function renderSurgery(fetchImpl: (path: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  function Harness() {
    const write = useInpatientWriteIntent(session, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return (
      <InpatientActionProvider stage="surgery">
        <InpatientSurgery admission={admission} session={session} locale="zh-CN" write={write} />
        <InpatientActionOutlet />
      </InpatientActionProvider>
    )
  }
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  )
}

describe('同台造影转 PCI（Ad-hoc PCI）工作台交互', () => {
  it('申请手术弹窗仅对冠脉造影展示 standbyAdHocPci 复选框、切换非造影自动复位，并预览联合知情同意书', async () => {
    const requestsPosted: Array<Record<string, unknown>> = []
    let createdRequest = false
    renderSurgery(async (path, init) => {
      if (path.endsWith('/api/auth/context')) return Response.json(session)
      if (path.endsWith('/surgery-catalog')) return Response.json(catalogResponse)
      if (path.endsWith('/clinical')) return Response.json(clinicalResponse)
      if (path.endsWith('/drg/reservations')) return Response.json({ admissionId: admission.id, encounterVersion: '2', reservationSets: [], reservations: [] })
      if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [], unprepared: [] })
      if (path.endsWith('/angiography-reports')) return Response.json({ admissionId: admission.id, reports: [] })
      if (path.endsWith('/surgeries/request') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { input: Record<string, unknown> }
        requestsPosted.push(body.input)
        createdRequest = true
        return Response.json(inpatientSurgeryResponseSchema.parse({
          auditId: '019a0000-0000-7000-8000-000000000101',
          requestId: '019a0000-0000-7000-8000-000000000102',
          warnings: [],
          effects: [],
          data: {
            admissionId: admission.id,
            encounterVersion: '3',
            virtualTime: time,
            requests: [
              {
                id: 'req-joint-1',
                admissionId: admission.id,
                version: 1,
                status: 'requested',
                surgeryType: 'elective',
                plannedProcedure: angioProc,
                plannedFor: time,
                location: { id: 'location-catheterization-lab', name: '导管室' },
                surgeon: { id: 'practitioner-inpatient-doctor', name: '住院医生', title: '主治医师' },
                anesthesiaMethod: 'local-infiltration',
                standbyAdHocPci: true,
                reason: '造影备选同台 PCI',
                requestedAt: time,
                requestedBy: 'doctor',
                organizationId: 'org-1',
              },
            ],
            executions: [],
            inProgress: [],
          },
        }))
      }
      if (path.endsWith('/surgeries')) {
        return Response.json({
          admissionId: admission.id,
          encounterVersion: createdRequest ? '3' : '2',
          virtualTime: time,
          requests: createdRequest
            ? [
                {
                  id: 'req-joint-1',
                  admissionId: admission.id,
                  version: 1,
                  status: 'requested',
                  surgeryType: 'elective',
                  plannedProcedure: angioProc,
                  plannedFor: time,
                  location: { id: 'location-catheterization-lab', name: '导管室' },
                  surgeon: { id: 'practitioner-inpatient-doctor', name: '住院医生', title: '主治医师' },
                  anesthesiaMethod: 'local-infiltration',
                  standbyAdHocPci: true,
                  reason: '造影备选同台 PCI',
                  requestedAt: time,
                  requestedBy: 'doctor',
                  organizationId: 'org-1',
                },
              ]
            : [],
          executions: [],
          inProgress: [],
        })
      }
      return Response.json({ error: { code: 'UNAVAILABLE', message: '未准备' } }, { status: 503 })
    })

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '申请手术' }))
    const dialog = await screen.findByRole('dialog', { name: '申请手术' })
    expect(within(dialog).queryByRole('checkbox', { name: /备选同台介入治疗/ })).toBeNull()

    // 选择冠脉造影 -> 复选框出现并勾选
    within(dialog).getByRole('combobox', { name: '计划术式' }).focus()
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('option', { name: '88.5500 · 单根导管的冠状动脉造影术' }))
    const standbyCheckbox = within(dialog).getByRole('checkbox', { name: /备选同台介入治疗/ })
    await user.click(standbyCheckbox)
    expect(standbyCheckbox.getAttribute('aria-checked')).toBe('true')

    // 切至非造影术式 -> 复选框消失；切回造影 -> 已自动复位未勾选
    within(dialog).getByRole('combobox', { name: '计划术式' }).focus()
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('option', { name: '47.0100 · 腹腔镜下阑尾切除术' }))
    expect(within(dialog).queryByRole('checkbox', { name: /备选同台介入治疗/ })).toBeNull()

    within(dialog).getByRole('combobox', { name: '计划术式' }).focus()
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('option', { name: '88.5500 · 单根导管的冠状动脉造影术' }))
    const resetCheckbox = within(dialog).getByRole('checkbox', { name: /备选同台介入治疗/ })
    expect(resetCheckbox.getAttribute('aria-checked')).toBe('false')
    await user.click(resetCheckbox)

    await user.type(within(dialog).getByLabelText('计划手术时间'), '2026-11-25T10:00')
    await user.type(within(dialog).getByLabelText('手术申请理由'), '造影备选同台 PCI')
    await user.click(within(dialog).getByRole('button', { name: '提交手术申请' }))

    await waitFor(() => expect(requestsPosted).toHaveLength(1))
    expect(requestsPosted[0]).toMatchObject({ procedureId: angioProc.id, standbyAdHocPci: true })

    // 打开联合知情同意书弹窗 -> 预览联合模板标题与同台备选告知
    await user.click(await screen.findByRole('button', { name: '确认已签' }))
    const consentDialog = await screen.findByRole('dialog', { name: '手术知情同意书' })
    const jointArticle = await within(consentDialog).findByRole('article', {
      name: '冠状动脉造影及必要时同台经皮冠状动脉介入治疗（PCI）知情同意书',
    })
    expect(jointArticle.textContent).toContain('同台备选方案')
    expect(jointArticle.textContent).toContain('支架内血栓')
  }, 15_000)

  it('standby-pci 待决策卡片在造影报告生成中或不可用时禁用转 PCI、就绪后处理 FFR>0.80 警示并支持直接转行或结束造影', async () => {
    let reportMode: 'processing' | 'unavailable' | 'final' = 'processing'
    const convertCalls: Array<Record<string, unknown>> = []
    const finalizeCalls: Array<Record<string, unknown>> = []
    const standbyRequest = {
      id: 'req-standby-1',
      admissionId: admission.id,
      version: 4,
      status: 'standby-pci' as const,
      surgeryType: 'elective' as const,
      plannedProcedure: angioProc,
      plannedFor: time,
      location: { id: 'location-catheterization-lab' as const, name: '导管室' },
      surgeon: { id: 'practitioner-inpatient-doctor', name: '住院医生', title: '主治医师' },
      anesthesiaMethod: 'local-infiltration' as const,
      standbyAdHocPci: true as const,
      reason: '同台造影待决策',
      requestedAt: time,
      requestedBy: 'doctor',
      organizationId: 'org-1',
      consentConfirmation: { actorId: 'doctor', practitionerRoleId: 'role-doctor', recordedAt: time, note: '已签联合同意书' },
      preopCheck: { actorId: 'nurse', practitionerRoleId: 'role-nurse', recordedAt: time, note: '已核对' },
    }
    const cagExec = {
      id: 'exec-cag-1',
      admissionId: admission.id,
      requestId: standbyRequest.id,
      actualProcedure: angioProc,
      performedAt: time,
      completedAt: time,
      performedBy: 'doctor',
      practitionerRoleId: 'role-doctor',
      organizationId: 'org-1',
      note: '造影完成',
      materials: [],
      materialHistory: [],
      linkedNursing: {
        serviceId: 'service-nursing-interventional',
        serviceVersion: 1,
        display: '术中介入专科护理',
        unit: '次',
        amountFen: 8000,
        chargeId: 'charge-nursing-1',
      },
    }
    const finalReport = inpatientAngiographyReportSchema.parse({
      id: 'report-cag-1',
      version: 1,
      admissionId: admission.id,
      procedureId: cagExec.id,
      status: 'final',
      synthetic: true,
      targetSite: '前降支中段',
      measurements: [],
      vessels: [{ vessel: 'LAD', segment: '前降支中段', stenosisPercent: 60, timiFlow: 3, lesionCharacteristics: '临界病变', ffr: 0.86 }],
      conclusion: '前降支中段临界病变，FFR 0.86。',
      missing: [],
      issuedAt: time,
    })

    const { rerender } = renderSurgery(async (path, init) => {
      if (path.endsWith('/api/auth/context')) return Response.json(session)
      if (path.endsWith('/surgery-catalog')) return Response.json(catalogResponse)
      if (path.endsWith('/drg/reservations')) return Response.json({ admissionId: admission.id, encounterVersion: '2', reservationSets: [], reservations: [] })
      if (path.endsWith('/angiography-reports')) {
        return Response.json({
          admissionId: admission.id,
          reports: [
            reportMode === 'final'
              ? finalReport
              : reportMode === 'unavailable'
                ? { ...finalReport, status: 'unavailable', targetSite: null, measurements: [], vessels: [], conclusion: null, missing: ['无造影真值来源'] }
                : { ...finalReport, status: 'processing', targetSite: null, measurements: [], vessels: [], conclusion: null },
          ],
        })
      }
      if (path.endsWith('/surgeries')) {
        return Response.json({
          admissionId: admission.id,
          encounterVersion: '2',
          virtualTime: time,
          requests: [standbyRequest],
          executions: [cagExec],
          inProgress: [],
        })
      }
      if (path.endsWith('/surgeries/convert-to-pci') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { input: Record<string, unknown> }
        convertCalls.push(body.input)
        if (!body.input.clinicalOverride) {
          return Response.json(
            {
              error: {
                code: 'CLINICAL_QUALITY_ALERT',
                message: '最新造影提示非缺血病变（FFR 0.86 > 0.80），请确认临床指征或登记越权原因',
                clinicalQuality: {
                  gate: 'inpatient-pci-plan',
                  evaluatedAt: time,
                  status: 'alert',
                  redLines: [],
                  alerts: [
                    {
                      code: 'PCI_NON_ISCHEMIC_LESION',
                      tier: 'alert',
                      message: 'LAD 前降支中段 FFR 0.86 > 0.80，功能学非缺血病变拟行 PCI',
                      evidence: [{ label: '冠脉造影 FFR', reference: 'DiagnosticReport/report-cag-1' }],
                    },
                  ],
                },
              },
            },
            { status: 409 },
          )
        }
        return Response.json(inpatientSurgeryResponseSchema.parse({
          auditId: '019a0000-0000-7000-8000-000000000103',
          requestId: '019a0000-0000-7000-8000-000000000104',
          warnings: [],
          effects: [],
          data: { admissionId: admission.id, encounterVersion: '3', virtualTime: time, requests: [standbyRequest], executions: [cagExec], inProgress: [] },
        }))
      }
      if (path.endsWith('/surgeries/finalize-standby') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { input: Record<string, unknown> }
        finalizeCalls.push(body.input)
        return Response.json(inpatientSurgeryResponseSchema.parse({
          auditId: '019a0000-0000-7000-8000-000000000105',
          requestId: '019a0000-0000-7000-8000-000000000106',
          warnings: [],
          effects: [],
          data: { admissionId: admission.id, encounterVersion: '3', virtualTime: time, requests: [{ ...standbyRequest, status: 'completed' }], executions: [cagExec], inProgress: [] },
        }))
      }
      return Response.json({ error: { code: 'UNAVAILABLE', message: '未准备' } }, { status: 503 })
    })
    void rerender

    const decisionCard = await screen.findByRole('region', { name: '待同台决策' })
    expect(within(decisionCard).getByText(/冠脉造影报告正在生成/)).toBeDefined()
    const actionBar = screen.getByRole('region', { name: '当前操作' })
    expect(within(actionBar).getByRole('button', { name: '同台转行 PCI' }).hasAttribute('disabled')).toBe(true)
    expect(within(actionBar).getByRole('button', { name: '仅完成造影，结束本台手术' }).hasAttribute('disabled')).toBe(false)

    // 报告不可用（unavailable）时仍禁转 PCI 并提示仅完成造影结束本台手术
    reportMode = 'unavailable'
    await clients[0]!.invalidateQueries({ queryKey: ['inpatient'] })
    await within(decisionCard).findByText(/本次冠脉造影未产出有效报告结果/)
    expect(within(actionBar).getByRole('button', { name: '同台转行 PCI' }).hasAttribute('disabled')).toBe(true)
    expect(within(actionBar).getByRole('button', { name: '仅完成造影，结束本台手术' }).hasAttribute('disabled')).toBe(false)

    // 报告就绪后解锁转 PCI 并验证内联 FFR > 0.80 警示
    reportMode = 'final'
    await clients[0]!.invalidateQueries({ queryKey: ['inpatient'] })
    await waitFor(() =>
      expect(within(actionBar).getByRole('button', { name: '同台转行 PCI' }).hasAttribute('disabled')).toBe(false),
    )

    const user = userEvent.setup()
    await user.click(within(actionBar).getByRole('button', { name: '同台转行 PCI' }))
    await waitFor(() => expect(convertCalls).toHaveLength(1))
    const qualityBanner = await within(decisionCard).findByRole('region', { name: '临床质控警示' })
    expect(qualityBanner.textContent).toContain('PCI_NON_ISCHEMIC_LESION')

    await user.click(within(actionBar).getByRole('button', { name: '仅完成造影，结束本台手术' }))
    await waitFor(() => expect(finalizeCalls).toHaveLength(1))
    expect(finalizeCalls[0]).toMatchObject({ requestId: standbyRequest.id, expectedRequestVersion: 4 })
  })

  it('已转同台 PCI 跳过二次同意书与核对，完术后展示单次专科护理不重复计收与显式在院主操作确认按钮', async () => {
    let phase: 'converted' | 'completed' = 'converted'
    const recordSubmits: Array<Record<string, unknown>> = []
    const convertedReq = {
      id: 'req-conv-1',
      admissionId: admission.id,
      version: 5,
      status: 'standby-pci' as const,
      surgeryType: 'elective' as const,
      plannedProcedure: angioProc,
      plannedFor: time,
      location: { id: 'location-catheterization-lab' as const, name: '导管室' },
      surgeon: { id: 'practitioner-inpatient-doctor', name: '住院医生', title: '主治医师' },
      anesthesiaMethod: 'local-infiltration' as const,
      standbyAdHocPci: true as const,
      adHocPci: {
        status: 'converted' as const,
        procedure: pciProc,
        convertedAt: time,
        convertedBy: 'doctor',
        practitionerRoleId: 'role-doctor',
        note: '造影后直接转 PCI',
        angiographyExecutionId: 'exec-cag-1',
        angiographyReportId: 'report-1',
      },
      reason: '同台造影转 PCI',
      requestedAt: time,
      requestedBy: 'doctor',
      organizationId: 'org-1',
      consentConfirmation: { actorId: 'doctor', practitionerRoleId: 'role-doctor', recordedAt: time, note: '已签联合同意书' },
      preopCheck: { actorId: 'nurse', practitionerRoleId: 'role-nurse', recordedAt: time, note: '已核对' },
    }
    const pciDoneExec = {
      id: 'exec-pci-adhoc-1',
      admissionId: admission.id,
      requestId: convertedReq.id,
      executionStage: 'ad-hoc-pci' as const,
      actualProcedure: pciProc,
      performedAt: time,
      completedAt: time,
      performedBy: 'doctor',
      practitionerRoleId: 'role-doctor',
      organizationId: 'org-1',
      note: '同台 PCI 完成',
      materials: [],
      materialHistory: [],
      sameSessionNursingIncluded: true as const,
    }
    const adHocEstimate = inpatientMaterialEstimateSchema.parse({
      id: 'est-adhoc-1',
      admissionId: admission.id,
      requestId: convertedReq.id,
      surgeryStage: 'ad-hoc-pci',
      version: 1,
      requestVersion: 5,
      status: 'succeeded',
      basisFingerprint: 'a'.repeat(64),
      failureCode: null,
      missing: [],
      candidates: [],
      analysis: null,
      candidateItems: [],
      draft: {
        revision: 1,
        basisFingerprint: 'a'.repeat(64),
        analysisId: null,
        items: [{ materialId: stentMaterial.id, catalogVersion: 1, quantity: 1, reason: '同台 PCI 选型' }],
        note: '',
        edited: false,
        updatedAt: time,
        updatedBy: 'doctor',
        confirmedRevision: 1,
        reservationIds: ['res-adhoc-1'],
      },
    })
    const recordPayload = inpatientRecordSchema.parse({
      admissionId: admission.id,
      recordNumber: 'BA-ADHOC-1',
      sourcesHash: 'c'.repeat(64),
      reviewCurrent: false,
      reviews: [],
      snapshot: {
        patient: {
          patientId: admission.patientId,
          patientVersion: '1',
          name: admission.patientName,
          gender: 'male',
          birthDate: '1966-05-20',
          recordNumber: 'BA-ADHOC-1',
          identifier: 'SYN-ADHOC-1',
          admissionCount: 1,
        },
        stay: {
          admissionId: admission.id,
          inpatientNumber: admission.inpatientNumber,
          admissionRoute: 'direct',
          registeredAt: time,
          initialWardId: 'ward-1',
          initialOrganizationId: 'org-1',
          dischargeWardId: 'ward-1',
          dischargeOrganizationId: 'org-1',
          admittedAt: time,
          transfers: [],
          events: [],
        },
        clinical: {
          diagnosis: { revision: 1, entries: clinicalResponse.diagnosis.entries },
          operations: [
            {
              ...pciDoneExec,
              procedureVersion: '1',
              primary: false,
            },
          ],
          mainProcedureExecutionId: null,
        },
        fees: {
          admissionId: admission.id,
          encounterVersion: '2',
          status: 'admitted',
          charges: [],
          chargesFen: 268000,
          depositFen: 0,
          balanceFen: 268000,
          fingerprint: 'd'.repeat(64),
          transactions: [],
          categoryNetFen: { surgery: 260000, service: 8000 },
          financialStatus: 'open',
        },
      },
    })

    renderSurgery(async (path, init) => {
      if (path.endsWith('/api/auth/context')) return Response.json(session)
      if (path.endsWith('/surgery-catalog')) return Response.json(catalogResponse)
      if (path.endsWith('/drg/reservations')) {
        return Response.json({
          admissionId: admission.id,
          encounterVersion: '2',
          reservationSets: [],
          reservations: [
            {
              id: 'res-adhoc-1',
              admissionId: admission.id,
              requestId: convertedReq.id,
              surgeryStage: 'ad-hoc-pci',
              materialId: stentMaterial.id,
              materialDisplay: stentMaterial.display,
              quantity: 1,
              catalogVersion: 1,
              consumedQuantity: 0,
              priceFen: 80000,
              status: 'reserved',
              reason: '同台 PCI 选型',
              createdAt: time,
            },
          ],
        })
      }
      if (path.endsWith('/pci-selection')) {
        return Response.json({
          admissionId: admission.id,
          confirmation: null,
          history: [],
          evidencePackage: { id: 'synthetic', version: '1', synthetic: true, limitation: '仅合成' },
          candidates: [],
          drafts: [
            {
              requestId: convertedReq.id,
              version: 1,
              reportId: 'report-1',
              reportVersion: 1,
              edited: true,
              confirmedSelectionVersion: 1,
              parameters: { requestId: convertedReq.id, treatmentPlan: '支架置入', targetSite: 'LAD', measurements: [], plannedQuantities: [], approvedMaterialIds: [] },
            },
          ],
        })
      }
      if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [adHocEstimate], unprepared: [] })
      if (path.endsWith('/angiography-reports')) return Response.json({ admissionId: admission.id, reports: [] })
      if (path.endsWith('/record')) return Response.json(recordPayload)
      if (path.endsWith('/record/submit') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { input: Record<string, unknown> }
        recordSubmits.push(body.input)
        return Response.json(inpatientRecordResponseSchema.parse({
          auditId: '019a0000-0000-7000-8000-000000000107',
          requestId: '019a0000-0000-7000-8000-000000000108',
          warnings: [],
          effects: [],
          data: {
            ...recordPayload,
            revision: {
              revision: 1,
              actorId: 'doctor',
              practitionerRoleId: 'role-doctor',
              recordedAt: time,
              sourcesHash: recordPayload.sourcesHash,
              snapshot: recordPayload.snapshot,
            },
            snapshot: {
              ...recordPayload.snapshot,
              clinical: { ...recordPayload.snapshot.clinical, mainProcedureExecutionId: pciDoneExec.id },
            },
          },
        }))
      }
      if (path.endsWith('/surgeries')) {
        return Response.json({
          admissionId: admission.id,
          encounterVersion: '2',
          virtualTime: time,
          requests: [phase === 'converted' ? convertedReq : { ...convertedReq, status: 'completed' }],
          executions: phase === 'completed' ? [pciDoneExec] : [],
          inProgress: [],
        })
      }
      return Response.json({ error: { code: 'UNAVAILABLE', message: '未准备' } }, { status: 503 })
    })

    // 阶段 2 待实施：展示免二次核对与知情同意徽章，且底部直接提供「开始同台 PCI」
    expect(await screen.findByText('同台转 PCI · 已免二次核对与知情同意')).toBeDefined()
    const actionBar = screen.getByRole('region', { name: '当前操作' })
    expect(within(actionBar).getByRole('button', { name: '开始同台 PCI' }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('button', { name: '确认已签' })).toBeNull()

    // 切到同台 PCI 已完成态 -> 展示单次专科护理不重复计收 + 显式「确认 36.0700 为在院主操作」按钮
    phase = 'completed'
    await clients[0]!.invalidateQueries({ queryKey: ['inpatient'] })
    const finalCard = await screen.findByRole('region', { name: '最终耗材' })
    expect(within(finalCard).getByText('已包含于同台造影阶段，不重复计收')).toBeDefined()
    const primaryCta = await within(finalCard).findByRole('button', { name: '确认 36.0700 为在院主操作' })
    const user = userEvent.setup()
    await user.click(primaryCta)
    await waitFor(() => expect(recordSubmits).toHaveLength(1))
    expect(recordSubmits[0]).toMatchObject({
      expectedRevision: 0,
      expectedSourcesHash: recordPayload.sourcesHash,
      mainProcedureExecutionId: pciDoneExec.id,
    })
  })
})
