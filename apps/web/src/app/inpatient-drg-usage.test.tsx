// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientDrgUsagePanel } from './inpatient-drg-usage.tsx'
import { usageAttempt, usageOverview, usageSession } from './model-usage.test-fixture.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear() })
const session: SessionContext = { ...usageSession, actor: { ...usageSession.actor, roleCode: 'inpatient-doctor' } }
const admission: InpatientAdmission = { id: 'admission-one', patientId: 'patient-one', patientName: '合成用量患者', inpatientNumber: 'ZY-1',
  admissionRoute: 'direct', wardId: 'ward-general', organizationId: 'organization-inpatient', bedId: 'bed-1', status: 'admitted',
  financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-10-27T09:00:00+08:00', admittedAt: '2026-10-27T09:10:00+08:00',
  depositFen: 100000, chargesFen: 0, versionId: '2' }
const task = { id: 'followup-one' }

it.each([
  ['estimate', 'estimate-2-verification', '第 2 轮预计核验'],
  ['explanation', 'record-check-2-generation', '第 2 轮核对解释生成'],
  ['explanation', 'record-check-2-verification', '第 2 轮核对解释核验'],
  ['explanation', 'record-check-generation', '核对解释生成'],
  ['guideline', 'guideline-2-generation', '第 2 轮指南意见生成'],
  ['guideline', 'guideline-2-verification', '第 2 轮指南意见核验'],
] as const)('%s 的 %s 用量显示对应轮次并保留任务筛选', async (taskKind, stage, label) => {
  const requests: URL[] = []
  const taskId = `${taskKind}-one`
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    requests.push(url)
    if (url.pathname === '/api/model-usage/overview') return Response.json({ ...usageOverview, stages: [] })
    if (url.pathname === '/api/model-usage/retention') return Response.json({ days: 90, version: 1, compactedRequests: 0, lastCompactedAt: null })
    if (url.pathname === '/api/model-usage/requests') return Response.json({ total: 1, items: [{ ...usageAttempt,
      context: { ...usageAttempt.context, taskId, caseId: admission.id, encounterId: admission.id,
        stage, sources: [{ kind: 'document', id: 'ServiceRequest/plan-one', relationship: 'trigger' }] } }] })
    throw new Error(`Unexpected URL ${url}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><InpatientDrgUsagePanel admissionId={admission.id} taskId={taskId}
    session={session} locale="zh-CN" active taskKind={taskKind} /></QueryClientProvider>)
  const panel = await screen.findByRole('region', { name: '本次住院AI用量' })
  await userEvent.setup().click(await within(panel).findByRole('button', { name: '展开AI请求明细' }))
  const table = await within(panel).findByRole('table', { name: '本次住院AI请求明细' })
  expect(table.textContent).toContain(label)
  expect(table.textContent).toContain('手术计划更新')
  expect(panel.textContent).not.toMatch(/尚无术前|尚无术中|尚无术后|本次跟进/)
  for (const url of requests.filter(item => item.pathname !== '/api/model-usage/retention')) {
    expect(url.searchParams.get('taskId')).toBe(taskId)
    expect(url.searchParams.get('caseId')).toBe(admission.id)
  }
})

it('精简用量保留累计与未决状态，仅在核查时读取请求明细', async () => {
  const reads: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    reads.push(url)
    if (url.pathname === '/api/model-usage/overview') return Response.json({ ...usageOverview,
      stages: [{ stage: 'preoperative-generation', requests: 3, inFlight: 1, unknownRequests: 1, knownTokens: 120,
        knownInputTokens: 120, knownOutputTokens: 0, unknownInputTokenRequests: 0, unknownOutputTokenRequests: 0,
        unknownTokenRequests: 0, unpricedRequests: 0, cny: 0.2 }] })
    if (url.pathname === '/api/model-usage/retention') return Response.json({ days: 90, version: 1, compactedRequests: 0, lastCompactedAt: null })
    if (url.pathname === '/api/model-usage/requests') return Response.json({ total: 1, items: [usageAttempt] })
    throw new Error(`Unexpected URL ${url}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const view = render(<QueryClientProvider client={client}><InpatientDrgUsagePanel admissionId={admission.id} session={session} locale="zh-CN" active compact /></QueryClientProvider>)
  await screen.findByLabelText('实际AI请求数')
  expect(reads.filter(url => url.pathname === '/api/model-usage/requests')).toHaveLength(0)
  await userEvent.setup().click(screen.getByRole('button', { name: '查看阶段累计' }))
  const table = screen.getByRole('table', { name: 'AI用途汇总' })
  expect(table.textContent).toContain('结果未知 1')
  expect(table.textContent).toContain('进行中 1')
  expect(table.textContent).not.toContain('成功')
  await userEvent.setup().click(screen.getByRole('button', { name: '核查未决请求（1）' }))
  await screen.findByRole('table', { name: '本次住院AI请求明细' })
  expect(reads.filter(url => url.pathname === '/api/model-usage/requests')).toHaveLength(1)
  expect(reads.filter(url => url.pathname === '/api/model-usage/overview').every(url => !url.searchParams.has('taskId'))).toBe(true)
  view.unmount()
  client.clear()
})

it('住院累计与当前跟进阶段分别读取，阶段明细不会替换全部任务总额', async () => {
  const reads: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    reads.push(url)
    if (url.pathname === '/api/model-usage/retention') return Response.json({ days: 90, version: 1, compactedRequests: 0, lastCompactedAt: null })
    if (url.searchParams.has('taskId')) return Response.json({ ...usageOverview, totals: { ...usageOverview.totals, requests: 2 },
      stages: [{ stage: 'preoperative-generation', requests: 2, inFlight: 0, unknownRequests: 0, knownTokens: 120,
        knownInputTokens: 120, knownOutputTokens: 0, unknownInputTokenRequests: 0, unknownOutputTokenRequests: 0,
        unknownTokenRequests: 0, unpricedRequests: 0, cny: 0.2 }] })
    return Response.json(usageOverview)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><InpatientDrgUsagePanel admissionId={admission.id} stageTaskId={task.id} session={session} locale="zh-CN" active compact /></QueryClientProvider>)
  expect((await screen.findByLabelText('实际AI请求数')).textContent).toBe('3')
  expect(reads.some(url => url.searchParams.has('taskId'))).toBe(false)
  await userEvent.setup().click(screen.getByRole('button', { name: '查看阶段累计' }))
  const stages = await screen.findByRole('table', { name: 'AI阶段累计' })
  expect(stages.textContent).toContain('术前生成2')
  expect(within(stages).getByRole('cell', { name: '120 / 0 / 120' })).toBeTruthy()
  expect(screen.getByLabelText('实际AI请求数').textContent).toBe('3')
  expect(reads.filter(url => url.searchParams.has('taskId'))[0]?.searchParams.get('taskId')).toBe(task.id)
  expect(screen.getByRole('table', { name: 'AI用途汇总' }).textContent).toContain('当前跟进任务用途汇总；住院累计包含全部任务。')
  await userEvent.setup().click(screen.getByRole('button', { name: '收起阶段累计' }))
  expect(screen.queryByRole('table', { name: 'AI用途汇总' })).toBeNull()
  client.clear()
})
