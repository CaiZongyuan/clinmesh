// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientCostsSchema, inpatientDrgSimulationSchema, inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDrgRecordChecksSchema, inpatientDrgReviewSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { inpatientDrgAgentSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientSurgeryExecutionSchema, inpatientSurgeryRequestSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientDrgPanel } from './inpatient-drg.tsx'
import { InpatientSurgery } from './inpatient-surgery.tsx'
import { InpatientActionOutlet, InpatientActionProvider } from './inpatient-workspace-actions.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const time = '2026-11-04T15:00:00+08:00'
const session: SessionContext = {
  actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' },
  user: { id: 'doctor', name: '住院医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [],
}
const admission = inpatientAdmissionSchema.parse({
  id: 'admission-1', patientId: 'patient-1', patientName: '合成手术与分组患者', inpatientNumber: 'ZY-395',
  admissionRoute: 'direct', wardId: 'ward-1', organizationId: 'org-1', status: 'admitted',
  financialStatus: 'open', recordStatus: 'open', registeredAt: time, admittedAt: time, depositFen: 500000, chargesFen: 210000, versionId: '2',
})
const wire = { id: 'hospital-material-pci-guidewire', version: 1, display: '导丝', chargeDefinition: { id: 'charge-wire', priceFen: 150000, unit: '根', synthetic: true, trigger: 'execution' as const } }
const catheter = { id: 'hospital-material-pci-guiding-catheter', version: 1, display: '导引导管', chargeDefinition: { id: 'charge-catheter', priceFen: 120000, unit: '根', synthetic: true, trigger: 'execution' as const } }
const procedure = {
  id: 'procedure-pci', version: 1,
  coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code: '00.6600', display: '经皮冠状动脉球囊扩张成形术', category: '介入治疗', releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://example.com/synthetic', sourceSha256: 'a'.repeat(64), sourceLocator: 'synthetic' },
  chargeDefinition: { id: 'charge-pci', priceFen: 320000, unit: '次', synthetic: true, trigger: 'execution' as const },
}
const plan = inpatientSurgeryRequestSchema.parse({
  id: 'request-1', admissionId: admission.id, version: 3, status: 'ready', plannedProcedure: procedure, plannedFor: time,
  reason: '前降支近段狭窄介入治疗', requestedAt: time, requestedBy: 'doctor', organizationId: 'org-1',
  consentConfirmation: { actorId: 'doctor', practitionerRoleId: 'role-doctor', recordedAt: time, note: '患者及家属已签字' },
  preopCheck: { actorId: 'nurse', practitionerRoleId: 'role-nurse', recordedAt: time, note: '术前核对完成' },
})
const runningExecution = inpatientSurgeryExecutionSchema.parse({
  id: 'execution-1', admissionId: admission.id, requestId: plan.id, actualProcedure: procedure,
  performedAt: time, performedBy: 'doctor', practitionerRoleId: 'role-doctor', organizationId: 'org-1',
  note: '股动脉入路开始手术', materials: [{ id: 'use-1', item: wire, quantity: 1, amountFen: 150000 }],
  materialHistory: [{ id: 'use-1', item: wire, quantity: 1, amountFen: 150000, recordedAt: time, recordedBy: 'doctor', practitionerRoleId: 'role-doctor', note: '首根导丝通过病变', reservationId: 'res-wire', chargeId: 'charge-1', correction: null }],
})
const reservations = inpatientMaterialReservationListSchema.parse({
  admissionId: admission.id, encounterVersion: '2', reservationSets: [],
  reservations: [
    { id: 'res-wire', admissionId: admission.id, requestId: plan.id, materialId: wire.id, materialDisplay: wire.display, unit: '根', specification: null, quantity: 1, catalogVersion: 1, consumedQuantity: 1, remainingQuantity: 0, version: 2, priceFen: 150000, status: 'replaced', reason: '术前预留导丝', createdAt: time, replacedByMaterialUseId: 'use-1' },
    { id: 'res-catheter', admissionId: admission.id, requestId: plan.id, materialId: catheter.id, materialDisplay: catheter.display, unit: '根', specification: null, quantity: 1, catalogVersion: 1, consumedQuantity: 0, remainingQuantity: 1, version: 1, priceFen: 120000, status: 'reserved', reason: '术前预留导引导管', createdAt: time },
  ],
})
const reviewPayload = inpatientDrgReviewSchema.parse({
  admissionId: admission.id, taskId: null, version: 1, status: 'complete', fingerprint: 'a'.repeat(64), freezeReason: null,
  summary: { formalDrgCode: 'FM39', formalChargesFen: 530000, projectedTotalFen: 530000 }, simulation: null,
  comparisons: [{ requestId: plan.id, executionId: runningExecution.id, procedureDisplay: procedure.coding.display, materialId: wire.id, catalogVersion: 1, display: wire.display, plannedQuantity: 1, actualQuantity: 2 }],
  planBases: [], missing: [], todos: [], resolvedTodos: [], actions: [], model: null, handedOver: null,
})

const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.unstubAllGlobals(); sessionStorage.clear() })

it('完成手术弹窗填写最终总量、勾选释放余量并预览差额后确认，不暴露耗材内部编号，完成后展示术后核查与责任交接', async () => {
  const posts: Array<{ path: string; body: unknown }> = []
  let completed = false
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/auth/context')) return Response.json(session)
    if (path.endsWith('/surgeries/preview-completion') && init?.method === 'POST') {
      return Response.json({
        fingerprint: 'd'.repeat(64),
        materials: [
          { item: wire, materialUseIds: ['use-1'], reservationId: 'res-wire', previousQuantity: 1, quantity: 2, deltaQuantity: 1, deltaFen: 150000 },
          { item: catheter, materialUseIds: [], reservationId: 'res-catheter', previousQuantity: 0, quantity: 0, deltaQuantity: 0, deltaFen: 0 },
        ],
        retainedReservations: [],
        materialDeltaFen: 150000,
        procedureAmountFen: 320000,
        totalDeltaFen: 470000,
      })
    }
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      posts.push({ path, body })
      completed = true
      const done = { ...runningExecution, completedAt: time, materials: [{ id: 'use-1', item: wire, quantity: 2, amountFen: 300000 }] }
      return Response.json({
        data: inpatientSurgerySchema.parse({ admissionId: admission.id, encounterVersion: '3', virtualTime: time, requests: [{ ...plan, status: 'completed' }], executions: [done], inProgress: [] }),
        auditId: 'audit-complete', requestId: 'req-complete', effects: [], warnings: [],
      })
    }
    if (path.endsWith('/surgeries')) {
      return Response.json(completed
        ? inpatientSurgerySchema.parse({ admissionId: admission.id, encounterVersion: '3', virtualTime: time, requests: [{ ...plan, status: 'completed' }], executions: [{ ...runningExecution, completedAt: time, materials: [{ id: 'use-1', item: wire, quantity: 2, amountFen: 300000 }] }], inProgress: [] })
        : inpatientSurgerySchema.parse({ admissionId: admission.id, encounterVersion: '2', virtualTime: time, requests: [plan], executions: [], inProgress: [runningExecution] }))
    }
    if (path.endsWith('/surgery-catalog')) return Response.json({ procedures: [procedure], materials: [wire, catheter] })
    if (path.endsWith('/drg/reservations')) return Response.json(reservations)
    if (path.endsWith('/drg/review')) return Response.json(reviewPayload)
    return Response.json({ error: { code: 'UNAVAILABLE', message: '合成次级资料暂不可用' } }, { status: 503 })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Harness() {
    const write = useInpatientWriteIntent(session, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <InpatientActionProvider stage="surgery"><InpatientSurgery admission={admission} session={session} locale="zh-CN" write={write} /><InpatientActionOutlet /></InpatientActionProvider>
  }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  await screen.findByText('导引导管')
  const completeTrigger = await screen.findByRole('button', { name: '核实最终耗材并完成手术' })
  const user = userEvent.setup()
  await user.click(completeTrigger)
  const dialog = await screen.findByRole('dialog', { name: '核实最终耗材并完成手术' })
  expect(dialog.textContent).not.toContain('hospital-material-pci-guidewire')
  expect(dialog.textContent).not.toContain('hospital-material-pci-guiding-catheter')
  const wireInput = within(dialog).getByRole('spinbutton', { name: '导丝 · 最终总量 1' })
  await user.clear(wireInput)
  await user.type(wireInput, '2')
  const releaseCatheter = within(dialog).getByRole('checkbox', { name: /释放剩余预留 · 导引导管/ })
  await user.click(releaseCatheter)
  await user.type(within(dialog).getByRole('textbox', { name: '核实说明' }), '导丝实际使用两根，导引导管未用释放')
  await user.click(within(dialog).getByRole('button', { name: '预览本次差额' }))
  const preview = await within(dialog).findByRole('region', { name: '本次差额' })
  expect(preview.textContent).toContain('导丝 补登 1 根')
  expect(preview.textContent).toContain('释放预留 · 导引导管')
  await user.click(within(dialog).getByRole('button', { name: '确认完成手术' }))
  await waitFor(() => expect(posts).toHaveLength(1))
  expect(posts[0]).toEqual({
    path: `/api/his/v1/inpatient/admissions/${admission.id}/surgeries/complete`,
    body: {
      input: {
        requestId: plan.id,
        executionId: runningExecution.id,
        expectedRequestVersion: 3,
        note: '导丝实际使用两根，导引导管未用释放',
        reconciliation: {
          finalMaterials: [
            { materialId: wire.id, catalogVersion: 1, quantity: 2, materialUseIds: ['use-1'], reservationId: 'res-wire', expectedReservationVersion: 2 },
            { materialId: catheter.id, catalogVersion: 1, quantity: 0, materialUseIds: [], reservationId: 'res-catheter', expectedReservationVersion: 1 },
          ],
          releaseReservations: [{ reservationId: 'res-catheter', expectedReservationVersion: 1 }],
          expectedFingerprint: 'd'.repeat(64),
        },
      },
    },
  })
  const doneSection = await screen.findByRole('region', { name: '最终耗材' })
  expect(doneSection.textContent).toContain('导丝')
  expect(doneSection.textContent).not.toContain('hospital-material-pci-guidewire')
  expect(await screen.findByRole('region', { name: '术后核查与责任交接' })).toBeDefined()
})

it('DRG预分组展示费用与支付参考、计划手术预计与中文未入组原因、高倍率提醒、收费构成跳转及核对跟进块', async () => {
  const formalGroup = { status: 'grouped' as const, drgCode: 'FM39', mdcCode: 'MDCF', adrgCode: 'FM3', reason: null, steps: [] }
  const incompatibleProjected = {
    status: 'ungroupable' as const, drgCode: null, mdcCode: null, adrgCode: null,
    reason: 'coding-incompatible：当前来源规则未声明兼容操作编码 36.0700', steps: [],
  }
  let simData = inpatientDrgSimulationSchema.parse({
    admissionId: admission.id, evaluatedAt: time, fingerprint: 'a'.repeat(64), rulesId: 'synthetic-rules', rulesVersion: '1',
    formal: {
      chargesFen: 210000,
      items: [
        { kind: 'laboratory', id: 'lab-1', display: '心肌损伤标志物', quantity: 1, estimatedFen: 150000 },
        { kind: 'bed', id: 'bed-1', display: '普通病房床位费', quantity: 2, estimatedFen: 60000 },
      ],
    },
    committed: {
      items: [
        { kind: 'medication', id: 'med-1', display: '阿司匹林肠溶片', quantity: 1, estimatedFen: 30000 },
        { kind: 'surgery', id: 'surg-1', display: '经皮冠状动脉支架置入术', quantity: 1, estimatedFen: 320000 },
      ],
    },
    reserved: { items: [{ kind: 'material', id: 'mat-1', display: '药物洗脱支架', quantity: 1, estimatedFen: 420000 }] },
    draft: { items: [], missing: [] },
    coverage: { coveredFen: 210000, estimatedTotalFen: 980000, coveredRatioBp: 2143, note: '合成覆盖' },
    grouping: { formal: formalGroup, projected: incompatibleProjected, note: '合成计划比较' },
    paymentReference: { parameterSetId: 'param-1', parameterVersion: '1', drgCode: 'FM39', referenceFen: 300000, note: '合成参考' },
    incompleteness: { costMissing: false, paymentReferenceMissing: false },
  })
  const costs = inpatientCostsSchema.parse({
    fingerprint: 'b'.repeat(64),
    components: { formalChargesFen: 210000, pendingOrdersFen: 30000, remainingMaterialsFen: 420000, plannedSurgeryFen: 320000, projectedTotalFen: 980000 },
    currentGrouping: formalGroup, projectedGrouping: incompatibleProjected,
    currentPaymentReference: simData.paymentReference, projectedPaymentReference: null,
    currentDifferenceFen: -680000, projectedDifferenceFen: null,
    paymentStatus: 'available', paymentMessage: '医院支付参考与患者医保待遇分别核对；费用说明不改变临床选择。',
    exceptionAlert: 'below-threshold',
  })
  const checks = inpatientDrgRecordChecksSchema.parse({
    admissionId: admission.id, encounterVersion: '2', fingerprint: 'a'.repeat(64), status: 'complete',
    simulation: simData, issues: [],
    sources: [
      { reference: 'InpatientRecord/admission-1', display: '首页主操作：尚未选择', target: 'record' },
      { reference: 'Condition/main-1', display: '主诊断：I20.000 不稳定型心绞痛', target: 'orders' },
      { reference: 'ServiceRequest/request-1', display: '计划操作：36.0700 经皮冠状动脉支架置入术', target: 'surgery' },
    ],
    paymentStatus: 'available', paymentMessage: '医院支付参考参数可用。', missing: [], costs, usage: [],
  })
  const followup = inpatientDrgFollowupSchema.parse({ admissionId: admission.id, encounterVersion: '2', task: null })
  const agent = inpatientDrgAgentSchema.parse({
    admissionId: admission.id, taskId: null, status: 'inactive', basisFingerprint: null, stage: null,
    missing: [], failureCode: null, costs, usage: [], analysis: null, confirmedPlan: null, planHistory: [],
  })
  const pciSelection = inpatientPciSelectionSchema.parse({
    admissionId: admission.id, confirmation: null, history: [],
    evidencePackage: { id: 'ev-1', version: 'v1', synthetic: true, limitation: '合成限制' }, candidates: [],
  })
  const openRecord = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/drg/simulation')) return Response.json(simData)
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', virtualTime: time, requests: [plan], executions: [], inProgress: [] })
    if (path.endsWith('/drg/record-checks')) return Response.json(checks)
    if (path.endsWith('/drg/followup')) return Response.json(followup)
    if (path.endsWith('/drg/agent')) return Response.json(agent)
    if (path.endsWith('/pci-selection')) return Response.json(pciSelection)
    throw new Error(`Unexpected request ${path}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Harness() {
    const write = useInpatientWriteIntent(session, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <InpatientDrgPanel admission={admission} session={session} locale="zh-CN" write={write} onOpenRecord={openRecord} />
  }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)

  const monitor = await screen.findByRole('region', { name: '费用与支付参考' })
  expect(screen.getByText(/随诊断、手术和收费自动更新 · 15:00/)).toBeDefined()
  expect(screen.queryByRole('heading', { name: 'DRG 预分组' })).toBeNull()
  expect(within(monitor).getByText('未超支付参考')).toBeDefined()
  expect(within(monitor).getByText('FM39')).toBeDefined()
  expect(within(monitor).getByText('¥3,000.00')).toBeDefined()
  expect(within(monitor).getByText('¥600.00')).toBeDefined()

  const planned = within(monitor).getByRole('region', { name: '做完计划手术后' })
  expect(within(planned).getByText('无法预分组')).toBeDefined()
  expect(planned.textContent).toContain('计划术式不在当前分组规则可识别的操作编码里，暂不能预分组；规则更新或病案编码审核时再确定。')
  expect(planned.textContent).not.toContain('coding-incompatible')
  expect(planned.textContent).not.toContain('36.0700')
  expect(planned.textContent).toContain('预计总费用 = 当前已用 ¥2,400.00 + 手术费 ¥3,200.00 + 预留耗材 ¥4,200.00')

  const mix = screen.getByRole('region', { name: '已发生收费构成' })
  expect(mix.textContent).toContain('检验费用')
  expect(mix.textContent).toContain('71%')
  expect(mix.textContent).toContain('床位费用')
  expect(mix.textContent).toContain('29%')
  const user = userEvent.setup()
  await user.click(within(mix).getByRole('button', { name: /逐笔明细在「费用」页签/ }))
  expect(openRecord).toHaveBeenCalledWith('fees')

  expect(await screen.findByRole('region', { name: '分组记录核对' })).toBeDefined()
  expect(await screen.findByRole('region', { name: '住院自动跟进' })).toBeDefined()
  expect(await screen.findByRole('region', { name: '住院耗材建议' })).toBeDefined()
  expect(screen.queryByRole('region', { name: '治疗耗材预留' })).toBeNull()
  expect(screen.queryByRole('region', { name: '术后核查与责任交接' })).toBeNull()

  // 当已发生收费超过支付参考 3 倍时，主块展示高倍率特例单议提醒
  simData = { ...simData, fingerprint: 'c'.repeat(64), formal: { ...simData.formal, chargesFen: 950000 } }
  await user.click(screen.getByRole('button', { name: '重新计算' }))
  await within(monitor).findByText(/已发生正式收费合计严格超过当前 DRG 支付参考额的 3 倍/)
  expect(within(monitor).getByText('已超支付参考')).toBeDefined()
})
