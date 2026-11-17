// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientDrgSimulationSchema, inpatientCostsSchema, type InpatientDrgSimulationInput } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDrgRecordChecksSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { InpatientDrgHeader } from './inpatient-drg-progress.tsx'
import { InpatientDrgPanel } from './inpatient-drg.tsx'
import { useInpatientDrgQuery } from './inpatient-drg-query.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const time = '2026-11-13T10:00:00+08:00'
const session: SessionContext = {
  actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' },
  user: { id: 'doctor', name: '合成医生', email: 'doctor@example.test' }, availableRoles: [],
}
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成DRG进度患者', inpatientNumber: 'ZY-490',
  admissionRoute: 'direct', wardId: 'ward-1', organizationId: 'org-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: time, admittedAt: time, depositFen: 500000, chargesFen: 150000, versionId: '2' })
const grouped = { status: 'grouped', drgCode: 'FR59', mdcCode: 'F', adrgCode: 'FR5', reason: null, steps: [] }
const simulation = inpatientDrgSimulationSchema.parse({ admissionId: admission.id, evaluatedAt: time, fingerprint: 'a'.repeat(64), rulesId: 'synthetic', rulesVersion: '1',
  formal: { chargesFen: 150000, items: [] }, committed: { items: [] }, reserved: { items: [] }, draft: { items: [], missing: [] },
  coverage: { coveredFen: 150000, estimatedTotalFen: 150000, coveredRatioBp: 10000, note: '合成费用' }, grouping: { formal: grouped, projected: null, note: '合成分组' },
  paymentReference: { parameterSetId: 'synthetic-reference', parameterVersion: '1', drgCode: 'FR59', referenceFen: 400000, note: '合成参考' }, incompleteness: { costMissing: false, paymentReferenceMissing: false } })
const costs = inpatientCostsSchema.parse({ fingerprint: 'c'.repeat(64), components: { formalChargesFen: 150000, pendingOrdersFen: 0, remainingMaterialsFen: 0, plannedSurgeryFen: 0, projectedTotalFen: 150000 }, currentGrouping: grouped, projectedGrouping: null, currentPaymentReference: simulation.paymentReference, projectedPaymentReference: null, currentDifferenceFen: 250000, projectedDifferenceFen: null, paymentStatus: 'available', paymentMessage: '合成参考可用', exceptionAlert: 'below-threshold' })
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

function fixture(role: SessionContext['actor']['roleCode'] = 'inpatient-doctor', postoperative = false, planned = false) {
  let amount = 150000
  let pendingMainProcedure = postoperative, mainConfirmed = false, simulationFailed = false, costsIncomplete = false
  const postoperativeGroup = { ...grouped, drgCode: 'FM39' }
  const postoperativeReference = { ...simulation.paymentReference!, drgCode: 'FM39', referenceFen: 1200000 }
  const plan = inpatientSurgeryRequestSchema.parse({ id: 'plan-pci', admissionId: admission.id, version: 1, status: 'requested',
    plannedProcedure: { id: 'pci', version: 1, coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code: '36.0700', display: '合成 PCI', category: '介入治疗', releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://example.test/synthetic', sourceSha256: 'a'.repeat(64), sourceLocator: 'synthetic' },
      chargeDefinition: { id: 'pci-price', priceFen: 180000, unit: '次', synthetic: true, trigger: 'execution' } },
    plannedFor: time, reason: '合成计划', requestedAt: time, requestedBy: 'doctor', organizationId: 'org-1' })
  const reads: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    reads.push(path)
    const previewingOrder = path.endsWith('/drg/simulation') && JSON.parse(String(init?.body)).input.services?.length > 0
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', virtualTime: time, requests: planned ? [plan] : [], executions: [], inProgress: [] })
    if (path.endsWith('/drg/simulation')) return simulationFailed ? Response.json({ error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成分组读取失败' } }, { status: 503 })
      : Response.json({ ...simulation, formal: { ...simulation.formal, chargesFen: amount }, coverage: { ...simulation.coverage, coveredFen: amount, estimatedTotalFen: previewingOrder ? 380000 : planned ? 330000 : amount },
        draft: { items: previewingOrder ? [{ kind: 'service', id: 'synthetic-service', display: '合成待提交项目', quantity: 1, estimatedFen: 50000 }] : [], missing: [] },
        committed: { items: planned ? [{ kind: 'surgery', id: plan.id, display: '合成 PCI', quantity: 1, estimatedFen: 180000 }] : [] },
        grouping: { ...simulation.grouping, formal: mainConfirmed ? postoperativeGroup : grouped, projected: planned ? postoperativeGroup : null },
        paymentReference: mainConfirmed ? postoperativeReference : simulation.paymentReference,
        postoperativeEstimate: pendingMainProcedure ? { pendingExecutionIds: ['completed-pci'], grouping: postoperativeGroup, paymentReference: postoperativeReference } : null })
    if (path.endsWith('/drg/record-checks')) return Response.json(inpatientDrgRecordChecksSchema.parse({ admissionId: admission.id, encounterVersion: '2', fingerprint: 'a'.repeat(64), status: 'complete', simulation, issues: [], sources: [], paymentStatus: 'available', paymentMessage: '合成参考', missing: [], costs: { ...costs, projectionComplete: !costsIncomplete,
      ...(planned ? { components: { ...costs.components, plannedSurgeryFen: 180000, remainingMaterialsFen: 750000, projectedTotalFen: 1080000 }, projectedGrouping: postoperativeGroup, projectedPaymentReference: postoperativeReference, projectedDifferenceFen: 120000 } : {}) }, usage: [] }))
    return Response.json({ error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成次级资料未准备' } }, { status: 503 })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  const currentSession = { ...session, actor: { ...session.actor, roleCode: role } }
  function Harness() {
    const [open, setOpen] = useState(false)
    const [draft, setDraft] = useState<InpatientDrgSimulationInput>()
    const query = useInpatientDrgQuery({ admission, session: currentSession, active: role === 'inpatient-doctor', draft })
    const write = useInpatientWriteIntent(currentSession, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <><InpatientDrgHeader admission={admission} session={currentSession} query={query} locale="zh-CN" onOpenDrg={() => setOpen(true)} />
      <button onClick={() => { void client.invalidateQueries({ queryKey: ['inpatient'] }) }}>刷新住院事实</button>
      <button onClick={() => setDraft({ medications: [], services: [{ serviceId: 'synthetic-service', serviceVersion: 1, quantity: 1 }] })}>预览待提交医嘱</button>
      {open ? <InpatientDrgPanel query={query} admission={admission} session={currentSession} locale="zh-CN" write={write} /> : null}</>
  }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  return { reads, update: (next = 200000) => { amount = next }, confirmMain: () => { pendingMainProcedure = false; mainConfirmed = true },
    failSimulation: () => { simulationFailed = true }, markCostsIncomplete: () => { costsIncomplete = true } }
}

it('患者头部与 DRG 页复用一次查询，登记后的失效刷新同时更新两处金额', async () => {
  const f = fixture(), user = userEvent.setup()
  const header = () => screen.getByRole('button', { name: 'DRG 费用进度，点击查看 DRG 预分组' })
  await waitFor(() => expect(header().textContent).toContain('已用 ¥1,500.00'))
  await user.click(header())
  const monitor = await screen.findByRole('region', { name: '费用与支付参考' })
  expect(monitor.textContent).toContain('¥1,500.00')
  expect(f.reads.filter(path => path.endsWith('/drg/simulation'))).toHaveLength(1)
  f.update()
  await user.click(screen.getByRole('button', { name: '刷新住院事实' }))
  await waitFor(() => expect(header().textContent).toContain('已用 ¥2,000.00'))
  expect(within(monitor).getByRole('img').getAttribute('aria-label')).toContain('已用 ¥2,000.00')
})

it('未访问手术页的冷入口保留服务端完整草稿费用，头部和DRG正文均按10800元比较', async () => {
  const f = fixture('inpatient-doctor', false, true), user = userEvent.setup()
  const header = () => screen.getByRole('button', { name: 'DRG 费用进度，点击查看 DRG 预分组' })
  await waitFor(() => expect(header().textContent).toContain('做完预计 ¥10,800.00'))
  expect(header().textContent).toContain('接近')
  expect(header().textContent).toContain('预计还剩 ¥1,200.00')
  await user.click(header())
  const projected = await screen.findByRole('region', { name: '做完计划手术后' })
  expect(projected.textContent).toContain('预计住院总费用 ¥10,800.00')
  expect(projected.textContent).toContain('预计耗材 ¥7,500.00')
  expect(f.reads.filter(path => path.endsWith('/material-estimates'))).toHaveLength(0)
  f.markCostsIncomplete()
  await user.click(screen.getByRole('button', { name: '刷新住院事实' }))
  await waitFor(() => expect(header().textContent).toContain('预计总费用暂不可用'))
  expect(header().textContent).toContain('已用 ¥1,500.00 / ¥12,000.00')
  expect(header().textContent).not.toMatch(/未超|接近|已超|还剩|做完预计/)
  f.update(1250000)
  await user.click(screen.getByRole('button', { name: '刷新住院事实' }))
  await waitFor(() => expect(header().textContent).toContain('已用 ¥12,500.00 / ¥12,000.00'))
  expect(header().textContent).toContain('已超')
  expect(header().textContent).not.toMatch(/还剩|超出|做完预计/)
  expect(screen.queryByRole('region', { name: '做完计划手术后' })).toBeNull()
  expect(within(header()).queryByRole('img')).toBeNull()
})

it('带待提交医嘱的独立推演使用该次simulation，不被共享费用核查缓存覆盖', async () => {
  fixture('inpatient-doctor', false, true)
  const user = userEvent.setup()
  const header = () => screen.getByRole('button', { name: 'DRG 费用进度，点击查看 DRG 预分组' })
  await waitFor(() => expect(header().textContent).toContain('做完预计 ¥10,800.00'))
  await user.click(screen.getByRole('button', { name: '预览待提交医嘱' }))
  await waitFor(() => expect(header().textContent).toContain('做完预计 ¥3,800.00'))
})

it.each<SessionContext['actor']['roleCode']>(['ward-nurse', 'cashier', 'pharmacist', 'medical-records', 'medical-insurance'])('患者头部对 %s 岗位不显示进度也不读取 DRG', async role => {
  const f = fixture(role)
  await act(async () => {})
  expect(screen.queryByRole('button', { name: 'DRG 费用进度，点击查看 DRG 预分组' })).toBeNull()
  expect(f.reads).toEqual([])
})

it('页面隐藏时停止患者头部的 DRG 轮询，恢复可见后继续更新', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const f = fixture()
  await waitFor(() => expect(screen.getByRole('button', { name: 'DRG 费用进度，点击查看 DRG 预分组' }).textContent).toContain('¥1,500.00'))
  visibility.mockReturnValue('hidden')
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  const before = f.reads.length
  await act(async () => { await vi.advanceTimersByTimeAsync(9_000) })
  expect(f.reads).toHaveLength(before)
  f.update()
  visibility.mockReturnValue('visible')
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  await waitFor(() => expect(screen.getByRole('button', { name: 'DRG 费用进度，点击查看 DRG 预分组' }).textContent).toContain('已用 ¥2,000.00'))
})

it('术后预计持续读取当前费用，主操作确认后自然切换正式口径', async () => {
  const f = fixture('inpatient-doctor', true), user = userEvent.setup()
  const header = () => screen.getByRole('button', { name: 'DRG 费用进度，点击查看 DRG 预分组' })
  await waitFor(() => expect(header().textContent).toContain('术后预计 FM39'))
  expect(header().textContent).toContain('待确认主操作')
  expect(header().textContent).toContain('支付参考 ¥12,000.00')
  f.update()
  await user.click(screen.getByRole('button', { name: '刷新住院事实' }))
  await waitFor(() => expect(header().textContent).toContain('已用 ¥2,000.00'))
  expect(header().textContent).toContain('待确认主操作')
  f.confirmMain()
  await user.click(screen.getByRole('button', { name: '刷新住院事实' }))
  await waitFor(() => expect(header().textContent).toContain('当前病组 FM39'))
  expect(header().textContent).not.toContain('待确认主操作')
  expect(header().textContent).toContain('支付参考 ¥12,000.00')
})

it('术后预计费用缺价或重新读取失败时不使用部分总额与旧支付参考继续画进度', async () => {
  const f = fixture('inpatient-doctor', true), user = userEvent.setup()
  const header = () => screen.getByRole('button', { name: 'DRG 费用进度，点击查看 DRG 预分组' })
  await waitFor(() => expect(header().textContent).toContain('待确认主操作'))
  f.markCostsIncomplete()
  await user.click(screen.getByRole('button', { name: '刷新住院事实' }))
  await waitFor(() => expect(header().textContent).toContain('预计总费用暂不可用'))
  expect(header().textContent).toContain('待确认主操作')
  expect(header().textContent).toContain('已用 ¥1,500.00 / ¥12,000.00')
  expect(screen.queryByRole('img')).toBeNull()
  f.failSimulation()
  await user.click(screen.getByRole('button', { name: '刷新住院事实' }))
  await waitFor(() => expect(header().textContent).toContain('暂无支付参考'))
  expect(header().textContent).not.toContain('FM39')
  expect(header().textContent).not.toContain('¥12,000.00')
  expect(screen.queryByRole('img')).toBeNull()
})
