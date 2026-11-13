// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientDrgRecordChecksSchema } from '@clinmesh/contracts/inpatient-drg-review'
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
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

function fixture(role: SessionContext['actor']['roleCode'] = 'inpatient-doctor') {
  let amount = 150000
  const reads: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    reads.push(path)
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', virtualTime: time, requests: [], executions: [], inProgress: [] })
    if (path.endsWith('/drg/simulation')) return Response.json({ ...simulation, formal: { ...simulation.formal, chargesFen: amount }, coverage: { ...simulation.coverage, coveredFen: amount, estimatedTotalFen: amount } })
    if (path.endsWith('/drg/record-checks')) return Response.json(inpatientDrgRecordChecksSchema.parse({ admissionId: admission.id, encounterVersion: '2', fingerprint: 'a'.repeat(64), status: 'complete', simulation, issues: [], sources: [], paymentStatus: 'available', paymentMessage: '合成参考', missing: [], costs: null, usage: [] }))
    return Response.json({ error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成次级资料未准备' } }, { status: 503 })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  const currentSession = { ...session, actor: { ...session.actor, roleCode: role } }
  function Harness() {
    const [open, setOpen] = useState(false)
    const query = useInpatientDrgQuery({ admission, session: currentSession, active: role === 'inpatient-doctor' })
    const write = useInpatientWriteIntent(currentSession, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <><InpatientDrgHeader admission={admission} session={currentSession} query={query} locale="zh-CN" onOpenDrg={() => setOpen(true)} />
      <button onClick={() => { void client.invalidateQueries({ queryKey: ['inpatient'] }) }}>刷新住院事实</button>
      {open ? <InpatientDrgPanel query={query} admission={admission} session={currentSession} locale="zh-CN" write={write} /> : null}</>
  }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  return { reads, update: () => { amount = 200000 } }
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
