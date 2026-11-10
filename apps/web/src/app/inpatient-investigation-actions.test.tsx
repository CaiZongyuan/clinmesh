// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientInvestigationResponseSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InpatientInvestigations } from './inpatient-investigations.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const session: SessionContext = { actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1',
  scenarioRunId: 'scenario-run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor', locationId: 'doctor-room' },
  user: { id: 'user-doctor', name: '合成住院医生', email: 'inpatient-doctor@demo.clinmesh.local' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成取消患者', inpatientNumber: 'ZY-SYNTHETIC',
  admissionRoute: 'direct', wardId: 'ward-general', organizationId: 'organization-inpatient', status: 'admitted', financialStatus: 'open', recordStatus: 'open',
  registeredAt: '2026-08-24T09:00:00+08:00', admittedAt: '2026-08-24T09:10:00+08:00', depositFen: 0, chargesFen: 0, versionId: '2' })
type Facts = ReturnType<typeof inpatientInvestigationsSchema.parse>
const makeRequest = (index: number) => ({ id: `request-${index}`, catalogItemId: `laboratory-${index}`, indicationCode: 'routine',
  referenceConcept: { id: `concept-${index}`, code: `LAB-${index}`, display: `合成检验项目${index}`, sourceLocator: `synthetic:${index}`, system: 'https://synthetic.invalid/laboratory', version: '1' },
  serviceRequestId: `service-${index}`, serviceRequestVersion: '1', taskId: `task-${index}`, taskVersion: '1', version: 1, status: 'issued', previousReports: [] })

function fixture(count = 2, options: { dropResponse?: number; rejectRequest?: number } = {}) {
  let facts = inpatientInvestigationsSchema.parse({ admissionId: admission.id, laboratoryRequests: Array.from({ length: count }, (_, index) => makeRequest(index + 1)), imagingRequests: [], sent: [] })
  const posts: { path: string; key: string | null; input: { requestId: string } }[] = []
  const receipts = new Map<string, ReturnType<typeof inpatientInvestigationResponseSchema.parse>>()
  const receiptKeys: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/investigation-catalog')) return Response.json({ items: [] })
    if (path.endsWith('/investigations')) return Response.json(facts)
    if (path.startsWith('/api/his/v1/command-receipts?')) {
      const key = new URL(path, 'http://localhost').searchParams.get('idempotencyKey')!
      receiptKeys.push(key)
      const response = receipts.get(key)!
      return Response.json({ operationId: new URL(path, 'http://localhost').searchParams.get('operationId'), idempotencyKey: key, status: 'completed', response })
    }
    if (init?.method === 'POST') {
      const { input } = JSON.parse(String(init.body))
      posts.push({ path, key: new Headers(init.headers).get('idempotency-key'), input })
      if (options.rejectRequest === posts.length) return Response.json({ error: { code: 'INPATIENT_INVESTIGATION_VERSION_CONFLICT', message: '合成申请已变化，请重新核对' } }, { status: 409 })
      const original = facts.laboratoryRequests.find(item => item.id === input.requestId)!
      const retry = path.endsWith('/retry')
      facts = { ...facts, laboratoryRequests: facts.laboratoryRequests.map(item => item.id === input.requestId ? {
        ...item, status: retry ? 'in-progress' : 'cancelled', version: item.version + 1,
        serviceRequestVersion: String(Number(item.serviceRequestVersion) + (retry ? 0 : 1)), taskVersion: String(Number(item.taskVersion) + 1),
      } : item) }
      const response = inpatientInvestigationResponseSchema.parse({ auditId: 'audit-synthetic', requestId: 'http-synthetic', warnings: [], effects: [
        ...(!retry ? [{ kind: 'updated', reference: `ServiceRequest/${original.serviceRequestId}`, versionId: String(Number(original.serviceRequestVersion) + 1) }] : []),
        { kind: 'updated', reference: `Task/${original.taskId}`, versionId: String(Number(original.taskVersion) + 1) },
      ], data: facts })
      receipts.set(new Headers(init.headers).get('idempotency-key')!, response)
      if (options.dropResponse === posts.length) throw new TypeError('合成已提交但响应丢失')
      return Response.json(response)
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  function Content() {
    const write = useInpatientWriteIntent(session, async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
    return <InpatientInvestigations admission={admission} session={session} locale="zh-CN" write={write} />
  }
  const mount = () => render(<QueryClientProvider client={client}><Content /></QueryClientProvider>)
  return { mount, posts, receiptKeys, read: () => facts, update: (value: Facts) => { facts = value }, client }
}

beforeEach(() => {
  sessionStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

it('失败重试独立选择两条可恢复申请，不选择不支持的失败，也不将重新生成显示成已出报告', async () => {
  const s = fixture(3), user = userEvent.setup()
  s.update({ ...s.read(), laboratoryRequests: s.read().laboratoryRequests.map((item, index) => ({ ...item, status: 'generation-failed',
    generationError: { code: index === 2 ? 'INVESTIGATION_UNSUPPORTED' : 'SYNTHETIC_PROVIDER_UNAVAILABLE', message: index === 2 ? '合成来源不支持' : '合成生成暂不可用' } })) })
  s.mount()
  await user.click(await screen.findByRole('button', { name: '失败重试' }))
  expect(screen.getByRole('checkbox', { name: /^选择重新生成：合成检验项目3/ }).getAttribute('aria-disabled')).toBe('true')
  await user.click(screen.getByRole('button', { name: '全选本页可重新生成' }))
  await user.click(screen.getByRole('button', { name: '集中重新生成' }))
  const dialog = screen.getByRole('dialog', { name: '集中重试结果生成' })
  expect(within(dialog).getAllByRole('article')).toHaveLength(2)
  await user.click(within(dialog).getByRole('button', { name: '确认重新生成' }))
  await waitFor(() => expect(within(screen.getByRole('region', { name: '重新生成逐项结果' })).getByText('成功 2/2')).toBeDefined())
  expect(s.posts.every(item => item.path.endsWith('/investigations/retry'))).toBe(true)
  expect(s.read().laboratoryRequests.map(item => item.status)).toEqual(['in-progress', 'in-progress', 'generation-failed'])
  expect(screen.getByRole('status').textContent).toBe('已提交重新生成')
})

it('第二项已提交但响应丢失时停止第三项，刷新后按原回执恢复且余项必须重新核对', async () => {
  const s = fixture(3, { dropResponse: 2 }), user = userEvent.setup()
  const first = s.mount()
  await user.click(await screen.findByRole('button', { name: '全选本页可取消申请' }))
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认取消申请' }))
  await screen.findByRole('button', { name: '恢复原取消申请' })
  await waitFor(() => expect(s.posts).toHaveLength(2))
  expect(s.read().laboratoryRequests.map(item => item.status)).toEqual(['cancelled', 'cancelled', 'issued'])
  const originalKey = s.posts[1]!.key
  first.unmount()
  s.mount()
  await user.click(await screen.findByRole('button', { name: '恢复原取消申请' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原取消申请' })).toBeNull())
  expect(s.receiptKeys).toEqual([originalKey])
  expect(s.posts).toHaveLength(2)
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  const review = screen.getByRole('dialog', { name: '集中取消检查申请' })
  expect(within(review).getAllByRole('article')).toHaveLength(1)
  expect(review.textContent).toContain('合成检验项目3')
  await user.click(within(review).getByRole('button', { name: '确认取消申请' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('已完成取消申请'))
  expect(s.posts).toHaveLength(3)
  expect(new Set(s.posts.map(item => item.input.requestId)).size).toBe(3)
  expect(new Set(s.posts.map(item => item.key)).size).toBe(3)
})

it('核对窗口使用临床指征中文与安全失败说明，并明确既有固定取消理由', async () => {
  const s = fixture(), user = userEvent.setup()
  s.update({ ...s.read(), laboratoryRequests: s.read().laboratoryRequests.map(item => ({ ...item, indicationCode: 'clinical-assessment', status: 'generation-failed',
    generationError: { code: 'AI_REQUEST_FAILED', message: 'Provider private upstream unavailable' } })) })
  s.mount()
  const actions = await screen.findByRole('region', { name: '检查申请集中办理' })
  expect(actions.textContent).not.toContain('Provider private upstream unavailable')
  expect(actions.textContent).not.toContain('clinical-assessment')
  expect(actions.textContent).toContain('临床评估')
  expect(actions.textContent).toContain('无法连接结果生成服务')
  await user.click(screen.getByRole('button', { name: '全选本页可取消申请' }))
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  const dialog = screen.getByRole('dialog', { name: '集中取消检查申请' })
  for (const item of within(dialog).getAllByRole('article')) expect(item.textContent).toContain('取消理由：不再需要')
  expect(within(dialog).queryByRole('textbox')).toBeNull()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('医生一次核对两条同住院申请后逐项取消，保留原申请且不将取消显示成退款', async () => {
  const s = fixture(), user = userEvent.setup()
  s.mount()
  await user.click(await screen.findByRole('button', { name: '全选本页可取消申请' }))
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  const dialog = screen.getByRole('dialog', { name: '集中取消检查申请' })
  expect(within(dialog).getAllByRole('article')).toHaveLength(2)
  expect(dialog.textContent).toContain('合成检验项目1')
  expect(dialog.textContent).toContain('合成检验项目2')
  expect(s.posts).toHaveLength(0)
  await user.click(within(dialog).getByRole('button', { name: '确认取消申请' }))
  await waitFor(() => expect(within(screen.getByRole('region', { name: '取消申请逐项结果' })).getByText('成功 2/2')).toBeDefined())
  expect(s.posts.map(item => item.path)).toEqual([
    '/api/his/v1/inpatient/admissions/admission-1/investigations/cancel',
    '/api/his/v1/inpatient/admissions/admission-1/investigations/cancel',
  ])
  expect(new Set(s.posts.map(item => item.key)).size).toBe(2)
  expect(s.read().laboratoryRequests.map(item => item.status)).toEqual(['cancelled', 'cancelled'])
  expect(screen.queryByRole('button', { name: '取消检查申请' })).toBeNull()
  expect(screen.queryByText('退款成功')).toBeNull()
})
