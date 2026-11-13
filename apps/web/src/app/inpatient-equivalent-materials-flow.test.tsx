// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientMaterialEstimatesSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientDrgSimulationSchema, inpatientCostsSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientSurgeryRequestSchema, inpatientSurgeryExecutionSchema, inpatientSurgeryCatalogSchema } from '@clinmesh/contracts/inpatient-surgery'
import { IntraoperativeMaterialRows } from './inpatient-surgery-intraoperative.tsx'
import { InpatientSurgery } from './inpatient-surgery.tsx'
import { InpatientDrgHeader } from './inpatient-drg-progress.tsx'
import { InpatientDrgPanel } from './inpatient-drg.tsx'
import { useInpatientDrgQuery } from './inpatient-drg-query.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const time = '2026-11-13T09:00:00+08:00'
const session: SessionContext = { actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' }, user: { id: 'doctor', name: '合成医生', email: 'doctor@example.test' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成并行计划患者', inpatientNumber: 'ZY-495', admissionRoute: 'direct', wardId: 'ward-1', organizationId: 'org-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: time, depositFen: 0, chargesFen: 810000, versionId: '1' })
const procedure = { id: 'pci', version: 1, coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code: '36.0700', display: '合成 PCI 支架置入', category: '介入治疗', releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://example.test/synthetic', sourceSha256: 'a'.repeat(64), sourceLocator: 'synthetic' }, chargeDefinition: { id: 'pci-price', priceFen: 100000, unit: '次', synthetic: true, trigger: 'execution' } }
const plans = ['a', 'b'].map(suffix => inpatientSurgeryRequestSchema.parse({ id: `plan-${suffix}`, admissionId: admission.id, version: 1, status: 'requested', plannedProcedure: procedure, plannedFor: time, reason: `合成计划${suffix.toUpperCase()}`, requestedAt: time, requestedBy: 'doctor', organizationId: 'org-1' }))
const from = { id: 'stent-a', version: 1, display: '合成支架 A', chargeDefinition: { id: 'price-a', priceFen: 73000, unit: '枚', synthetic: true, trigger: 'execution' } }
const to = { id: 'stent-b', version: 1, display: '合成支架 B', chargeDefinition: { id: 'price-b', priceFen: 53000, unit: '枚', synthetic: true, trigger: 'execution' } }
const evidence = { id: 'synthetic-evidence', version: '1', synthetic: true, scope: '合成范围', applicability: '合成适用', compatibility: '显式同组兼容', specification: '3.0×18 mm', quantityBasis: '医生确认一枚', sourceLocator: 'synthetic' }
const candidates = [from, to].map((item, index) => ({ materialId: item.id, catalogVersion: 1, item, evidence, quantityBasis: '医生确认一枚', selected: index === 0, equivalenceGroupId: 'synthetic-stent', expectedQuantity: 1, eligibility: 'valid', missing: [] }))
const formal = { status: 'grouped', drgCode: 'FR59', mdcCode: 'F', adrgCode: 'FR5', reason: null, steps: [] }, projected = { ...formal, drgCode: 'FM39', adrgCode: 'FM3' }
const reference = { parameterSetId: 'synthetic-ref', parameterVersion: '1', drgCode: 'FM39', referenceFen: 1200000, note: '合成参考' }
const baseCosts = inpatientCostsSchema.parse({ fingerprint: 'a'.repeat(64), components: { formalChargesFen: 810000, pendingOrdersFen: 0, remainingMaterialsFen: 70000, plannedSurgeryFen: 200000, projectedTotalFen: 1080000 }, currentGrouping: formal, projectedGrouping: projected,
  currentPaymentReference: { ...reference, drgCode: 'FR59', referenceFen: 400000 }, projectedPaymentReference: reference, currentDifferenceFen: -680000, projectedDifferenceFen: 120000, paymentStatus: 'available', paymentMessage: '合成参考可用', exceptionAlert: 'below-threshold' })
const selection = inpatientPciSelectionSchema.parse({ admissionId: admission.id, confirmation: { id: 'confirmation-a', version: 1, parameters: { requestId: 'plan-a', treatmentPlan: '合成PCI', targetSite: 'LAD', measurements: [], plannedQuantities: [], approvedMaterialIds: ['stent-a'] }, confirmedBy: 'doctor', practitionerRoleId: 'role-doctor', confirmedAt: time }, history: [], evidencePackage: { id: 'synthetic', version: '1', synthetic: true, limitation: '合成范围' }, candidates: [], drafts: [] })
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); sessionStorage.clear() })

function fixture(held = false, unpriced = false, oldReservationBasis = false) {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const posts: Array<{ expectedDraftRevision: number; items: Array<{ materialId: string; quantity: number }>; note: string }> = []
  const makeState = (requestId: string, reservedFen: number) => ({ id: `estimate-${requestId}`, admissionId: admission.id, requestId, version: 1, requestVersion: 1, status: 'blocked', basisFingerprint: 'a'.repeat(64), failureCode: null, missing: [], candidates, analysis: null, candidateItems: [],
    materialDraftDeltaFen: 73000 - reservedFen,
    materialDraftReservationBasis: oldReservationBasis ? [] : [['general', 1, 40000], ['reserved-b', 1, 30000]],
    costs: { ...baseCosts, components: { ...baseCosts.components, remainingMaterialsFen: 186000, projectedTotalFen: 1196000 } },
    draft: { revision: 1, basisFingerprint: 'a'.repeat(64), analysisId: null, items: [{ materialId: 'stent-a', catalogVersion: 1, quantity: 1, reason: '医生确认一枚' }], note: '', edited: true, updatedAt: time, updatedBy: 'doctor', confirmedRevision: null, reservationIds: [] },
    equivalentSuggestions: [{ groupId: 'synthetic-stent', from, to, quantity: 1, unitSavingsFen: 20000, totalSavingsFen: 20000, beforeTotalFen: 1196000, afterTotalFen: 1176000, paymentReferenceFen: 1200000 }],
  })
  let estimates = inpatientMaterialEstimatesSchema.parse({ admissionId: admission.id, estimates: [makeState('plan-a', 0), makeState('plan-b', 30000)], unprepared: [] })
  if (unpriced) { estimates.estimates[0]!.materialDraftDeltaFen = null; estimates.estimates[0]!.costs!.projectionComplete = false; estimates.estimates[0]!.costs!.projectionMissing = ['合成未核验价格'] }
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/auth/context')) return Response.json(session)
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '1', virtualTime: time, requests: plans, executions: [], inProgress: [] })
    if (path.endsWith('/surgery-catalog')) return Response.json({ procedures: [procedure], materials: [from, to] })
    if (path.endsWith('/pci-selection')) return Response.json(selection)
    if (path.endsWith('/drg/reservations')) return Response.json({ admissionId: admission.id, encounterVersion: '1', reservations: [], reservationSets: plans.map(plan => ({ requestId: plan.id, fingerprint: 'b'.repeat(64) })) })
    if (path.endsWith('/material-estimates')) return Response.json(estimates)
    if (path.endsWith('/material-estimates/save')) {
      const input = JSON.parse(String(init?.body)).input
      posts.push(input)
      if (held && posts.length === 1) await gate
      const materialFen = input.items.reduce((sum: number, row: { materialId: string; quantity: number }) => sum + (row.materialId === 'stent-b' ? 53000 : 73000) * row.quantity, 0)
      const state = estimates.estimates[0]!
      const saved = { ...state, materialDraftDeltaFen: materialFen, draft: { ...state.draft!, revision: input.expectedDraftRevision + 1, items: input.items, note: input.note },
        costs: { ...state.costs!, components: { ...state.costs!.components, remainingMaterialsFen: 113000 + materialFen, projectedTotalFen: 1123000 + materialFen } } }
      estimates = { ...estimates, estimates: [saved, estimates.estimates[1]!] }
      return Response.json({ data: saved, auditId: 'synthetic-audit', requestId: 'synthetic-save', effects: [], warnings: [] })
    }
    if (path.endsWith('/drg/simulation')) {
      const input = JSON.parse(String(init?.body)).input
      return Response.json(inpatientDrgSimulationSchema.parse({ admissionId: admission.id, evaluatedAt: time, fingerprint: 'a'.repeat(64), rulesId: 'synthetic', rulesVersion: '1', formal: { chargesFen: 810000, items: [] }, committed: { items: plans.map(plan => ({ kind: 'surgery', id: plan.id, display: '合成PCI', quantity: 1, estimatedFen: 100000 })) }, reserved: { items: [{ kind: 'material', id: 'reserved-b', display: '计划B已预留', quantity: 1, estimatedFen: 30000 }, { kind: 'material', id: 'general', display: '通用预留', quantity: 1, estimatedFen: 40000 }] }, draft: { items: [], missing: [] }, coverage: { coveredFen: 810000, estimatedTotalFen: 1080000, coveredRatioBp: 7500, note: '合成费用' }, grouping: { formal, projected: input.primarySurgeryRequestId ? projected : { ...projected, status: 'ambiguous', drgCode: null }, note: '合成主计划' }, paymentReference: baseCosts.currentPaymentReference, incompleteness: { costMissing: false, paymentReferenceMissing: false } }))
    }
    if (path.endsWith('/drg/record-checks')) return Response.json({ admissionId: admission.id, encounterVersion: '1', fingerprint: 'a'.repeat(64), status: 'complete', simulation: null, issues: [], sources: [], paymentStatus: 'available', paymentMessage: '合成参考', missing: [], costs: baseCosts, usage: [] })
    return Response.json({ error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成次级资料未准备' } }, { status: 503 })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Harness() {
    const query = useInpatientDrgQuery({ admission, session, active: true })
    const write = useInpatientWriteIntent(session, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <><InpatientDrgHeader query={query} admission={admission} session={session} locale="zh-CN" onOpenDrg={() => {}} /><InpatientDrgPanel query={query} admission={admission} session={session} locale="zh-CN" write={write} /><InpatientSurgery admission={admission} session={session} locale="zh-CN" write={write} /></>
  }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  return { posts, release }
}

it('两份未确认计划的草稿各合并一次，当前计划采用换回同步头部和DRG正文且保留主计划支付参考', async () => {
  fixture()
  const user = userEvent.setup()
  const primary = await screen.findByRole('combobox', { name: '计划主操作（仅预计）' })
  primary.focus(); await user.keyboard('{Enter}')
  await user.click(await screen.findByRole('option', { name: /合成计划A/ }))
  const header = () => screen.getByRole('button', { name: 'DRG 费用进度，点击查看 DRG 预分组' })
  await waitFor(() => expect(header().textContent).toContain('做完预计 ¥11,960.00'))
  expect(header().textContent).toContain('支付参考 ¥12,000.00')
  expect(screen.getByRole('region', { name: '做完计划手术后' }).textContent).toContain('预计总费用 = 当前已用 ¥8,100.00 + 手术费 ¥2,000.00 + 预计耗材 ¥1,860.00')
  expect(screen.getByRole('region', { name: '手术耗材' }).textContent).toContain('做完预计 ¥11,960.00')
  expect(screen.getByRole('region', { name: '手术耗材' }).textContent).toContain('换后预计 ¥11,760.00')
  await user.click(screen.getByRole('button', { name: '换成这个' }))
  await waitFor(() => expect(header().textContent).toContain('做完预计 ¥11,760.00'))
  expect(screen.getByRole('region', { name: '做完计划手术后' }).textContent).toContain('预计住院总费用 ¥11,760.00')
  await user.click(screen.getByRole('button', { name: '换回原耗材' }))
  await waitFor(() => expect(header().textContent).toContain('做完预计 ¥11,960.00'))
  expect(screen.getByRole('region', { name: '做完计划手术后' }).textContent).toContain('预计住院总费用 ¥11,960.00')
})

it('等效保存回执延迟时仍可改数量与说明，迟到成功只消费原提交并保留新输入和新工作稿修订', async () => {
  const f = fixture(true), user = userEvent.setup()
  const material = await screen.findByRole('region', { name: '手术耗材' })
  await user.click(await within(material).findByRole('button', { name: '换成这个' }))
  await waitFor(() => expect(f.posts).toHaveLength(1))
  const quantity = within(material).getByRole('spinbutton', { name: /预计数量：合成支架/ })
  await user.clear(quantity); await user.type(quantity, '2')
  await user.type(within(material).getByLabelText('耗材清单说明'), '保存期间新增说明')
  await act(async () => { f.release() })
  await within(material).findByRole('button', { name: '换回原耗材' })
  expect(within(material).getByRole('spinbutton', { name: '预计数量：合成支架 B' }).getAttribute('value')).toBe('2')
  expect(within(material).getByLabelText('耗材清单说明').getAttribute('value')).toBe('保存期间新增说明')
  await user.click(within(material).getByRole('button', { name: '换回原耗材' }))
  await waitFor(() => expect(f.posts).toHaveLength(2))
  expect(f.posts[1]).toMatchObject({ expectedDraftRevision: 2, items: [{ materialId: 'stent-a', quantity: 2 }], note: '保存期间新增说明' })
})


it('术中从当前手术的确认候选给出等效建议，另一较新手术确认不会遮掉它', async () => {
  const ownCandidates = candidates.map(candidate => ({ ...candidate, materialVersion: 1, category: 'stent', expectedAmountFen: candidate.item.chargeDefinition.priceFen }))
  const { catalogVersion: _v, quantityBasis: _b, selected: _s, ...candidateA } = ownCandidates[0]!
  const { catalogVersion: _v2, quantityBasis: _b2, selected: _s2, ...candidateB } = ownCandidates[1]!
  let genericReads = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/pci-selection')) { genericReads += 1; return Response.json({ ...selection, confirmation: { ...selection.confirmation!, parameters: { ...selection.confirmation!.parameters, requestId: 'plan-b' } } }) }
    if (path.endsWith('/drg/agent')) return Response.json({ admissionId: admission.id, taskId: null, status: 'inactive', basisFingerprint: null, stage: null, missing: [], failureCode: null, costs: baseCosts, usage: [], analysis: null, confirmedPlan: null, planHistory: [],
      intraoperativePlans: [{ requestId: 'plan-a', reference: 'InpatientMaterialPlan/plan-a', items: [{ materialId: 'stent-a', catalogVersion: 1, quantity: 1, display: from.display, unit: '枚', unitPriceFen: 73000, estimatedFen: 73000, quantityBasis: '医生确认一枚', reason: '合成依据', evidenceIds: ['synthetic-evidence'] }], candidates: [candidateA], alternatives: [candidateB] }], intraoperativeReviews: [] })
    throw new Error(`Unexpected request ${path}`)
  }))
  const execution = inpatientSurgeryExecutionSchema.parse({ id: 'execution-a', admissionId: admission.id, requestId: 'plan-a', actualProcedure: procedure, performedAt: time, performedBy: 'doctor', practitionerRoleId: 'role-doctor', organizationId: 'org-1', note: '合成开始', materials: [], materialHistory: [] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  function Harness() { const write = useInpatientWriteIntent(session, () => undefined); return <IntraoperativeMaterialRows admissionId={admission.id} session={session} locale="zh-CN" execution={execution} catalog={inpatientSurgeryCatalogSchema.parse({ procedures: [plans[0]!.plannedProcedure], materials: [candidateA.item, candidateB.item] })} reservations={[]} active dataReady editable onCorrect={() => {}} write={write} requestVersion={1} /> }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '登记计划外的其他耗材' }))
  const material = screen.getByRole('combobox', { name: '耗材' }); material.focus(); await user.keyboard('{Enter}')
  await user.click(await screen.findByRole('option', { name: '合成支架 A' }))
  await user.click(await screen.findByRole('button', { name: '换成这个' }))
  expect(material.textContent).toContain('合成支架 B')
  expect(genericReads).toBe(0)
})


it('未选主计划时缺价格不遮住当前口径，选定计划后明确保持预计未知', async () => {
  fixture(false, true)
  const header = () => screen.getByRole('button', { name: 'DRG 费用进度，点击查看 DRG 预分组' })
  await within(await screen.findByRole('region', { name: '费用与支付参考' })).findByText('计划耗材费用待核对，预计总费用暂不可用')
  expect(header().textContent).toContain('当前病组 FR59')
  expect(header().textContent).toContain('支付参考 ¥4,000.00')
  expect(header().textContent).toContain('已超出 ¥4,100.00')
  const user = userEvent.setup(), primary = screen.getByRole('combobox', { name: '计划主操作（仅预计）' })
  primary.focus(); await user.keyboard('{Enter}'); await user.click(await screen.findByRole('option', { name: /合成计划A/ }))
  await waitFor(() => expect(header().textContent).toContain('计划耗材费用待核对，预计总费用暂不可用'))
  expect(screen.queryByRole('region', { name: '做完计划手术后' })).toBeNull()
  expect(screen.getByRole('region', { name: '费用与支付参考' }).textContent).toContain('计划耗材费用待核对，预计总费用暂不可用')
})


it('正式预留先刷新时旧草稿增量暂不可用，避免与新基线短暂重复计价', async () => {
  fixture(false, false, true)
  const user = userEvent.setup(), primary = await screen.findByRole('combobox', { name: '计划主操作（仅预计）' })
  primary.focus(); await user.keyboard('{Enter}'); await user.click(await screen.findByRole('option', { name: /合成计划A/ }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'DRG 费用进度，点击查看 DRG 预分组' }).textContent).toContain('预计总费用暂不可用'))
  expect(screen.getByRole('button', { name: 'DRG 费用进度，点击查看 DRG 预分组' }).textContent).toContain('已用 ¥8,100.00')
  expect(screen.getByRole('button', { name: 'DRG 费用进度，点击查看 DRG 预分组' }).textContent).not.toContain('做完预计')
})
