// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientDrgRecordChecksSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientDrgExplanationSchema } from '@clinmesh/contracts/inpatient-drg-explanation'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientDrgRecordChecksPanel } from './inpatient-drg-record-checks.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const session: SessionContext = {
  actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'scenario-run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' },
  user: { id: 'user-doctor', name: '住院医生', email: 'inpatient-doctor@demo.clinmesh.local' }, availableRoles: [],
}
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成核对患者', inpatientNumber: 'ZY-0001', admissionRoute: 'direct', wardId: 'ward-general', organizationId: 'organization-inpatient', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-08-24T09:00:00+08:00', depositFen: 0, chargesFen: 0, versionId: '2' })
const checks = inpatientDrgRecordChecksSchema.parse({ admissionId: admission.id, encounterVersion: '2', fingerprint: 'a'.repeat(64), status: 'complete', simulation: null,
  issues: [{ key: 'primary-procedure-difference:procedure-1', kind: 'primary-procedure-difference', ownerRole: 'inpatient-doctor', materialId: null,
    display: '实际 PCI 与首页主操作选择不同', plannedQuantity: null, actualQuantity: null, explanation: '已记录实际 PCI，首页仍选择冠脉造影，请核对两份记录。', evidence: ['Procedure/procedure-1', 'InpatientRecord/admission-1/revision/1'] }],
  sources: [{ reference: 'Procedure/procedure-1', display: '实际手术：经皮冠状动脉介入治疗', target: 'surgery' },
    { reference: 'InpatientRecord/admission-1/revision/1', display: '首页主操作：冠脉造影', target: 'record' }],
  paymentStatus: 'missing', paymentMessage: '分组成功，金额暂不可估。', missing: [],
})
const clients: QueryClient[] = []
afterEach(async () => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  await act(() => new Promise<void>(resolve => notifyManager.schedule(resolve)))
  vi.unstubAllGlobals(); sessionStorage.clear()
})
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const navigate = vi.fn()
  function Harness({ stay = admission, currentSession = session }: { stay?: typeof admission; currentSession?: SessionContext }) {
    const write = useInpatientWriteIntent(currentSession, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <InpatientDrgRecordChecksPanel admission={stay} session={currentSession} locale="zh-CN" write={write} active onOpenRecord={navigate} />
  }
  const view = render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  return { client, navigate, rerender: (stay: typeof admission, currentSession = session) => view.rerender(<QueryClientProvider client={client}><Harness stay={stay} currentSession={currentSession} /></QueryClientProvider>) }
}

it('无需跟进即读取规则核对、支付缺参与两份原记录入口，读取不请求解释', async () => {
  const reads: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    reads.push(path)
    if (path.endsWith('/drg/record-checks')) return Response.json(checks)
    throw new Error(`Unexpected read ${path}`)
  }))
  const { navigate } = mount()
  const panel = await screen.findByRole('region', { name: '分组记录核对' })
  expect((await within(panel).findByText('实际 PCI 与首页主操作选择不同')).textContent).toBe('实际 PCI 与首页主操作选择不同')
  expect(within(panel).getByText('分组成功，金额暂不可估。')).toBeDefined()
  const user = userEvent.setup()
  await user.click(within(panel).getByRole('button', { name: '前往手术原记录' }))
  await user.click(within(panel).getByRole('button', { name: '前往病案首页原记录' }))
  expect(navigate.mock.calls).toEqual([['surgery'], ['record']])
  expect(reads.every(path => path.endsWith('/drg/record-checks'))).toBe(true)
})

it('医生展开时才请求解释，已成功的当前依据在收起重开与刷新后复用', async () => {
  let explanation = inpatientDrgExplanationSchema.parse({ admissionId: admission.id, taskId: null, version: 0,
    fingerprint: checks.fingerprint, status: 'idle', failureCode: null, result: null })
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/drg/record-checks')) return Response.json(checks)
    if (path.endsWith('/drg/record-checks/explanation')) return Response.json(explanation)
    if (path.endsWith('/drg/record-checks/explain')) {
      writes.push(JSON.parse(String(init?.body)).input)
      explanation = inpatientDrgExplanationSchema.parse({ ...explanation, version: 1, status: 'succeeded', result: {
        id: 'explanation-1', fingerprint: checks.fingerprint, model: 'synthetic-record-model', createdAt: '2026-10-30T01:00:00Z',
        observations: [{ key: checks.issues[0]!.key, explanation: '已核验的合成解释：请对照实际手术与首页选择，不替医生改写主操作。', evidenceIds: checks.issues[0]!.evidence }],
      } })
      return Response.json({ data: explanation, auditId: 'audit-1', requestId: 'request-1', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const { client } = mount(), user = userEvent.setup()
  const panel = await screen.findByRole('region', { name: '分组记录核对' })
  const expand = await within(panel).findByRole('button', { name: '展开 AI 解释' })
  expect(writes).toEqual([])
  await user.click(expand)
  await within(panel).findByText('已核验的合成解释：请对照实际手术与首页选择，不替医生改写主操作。')
  expect(writes).toEqual([{ expectedFingerprint: checks.fingerprint, expectedVersion: 0 }])
  await user.click(within(panel).getByRole('button', { name: '收起 AI 解释' }))
  await user.click(within(panel).getByRole('button', { name: '展开 AI 解释' }))
  await act(async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
  expect(writes).toHaveLength(1)
  expect(within(panel).getByText('实际 PCI 与首页主操作选择不同')).toBeDefined()
})

it('加载与读取失败分别表达，成功空结论在后续读取失败后不冒充当前结果', async () => {
  let release!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { release = resolve })
  let response: Response | undefined
  vi.stubGlobal('fetch', vi.fn(async () => response?.clone() ?? pending))
  const { client } = mount()
  expect(screen.getByText('正在读取分组记录核对')).toBeDefined()
  expect(screen.queryByText('当前无本范围核对差异')).toBeNull()
  release(Response.json({ error: { code: 'SYNTHETIC_READ_FAILED', message: '合成读取失败' } }, { status: 503 }))
  await screen.findByText('分组核对读取失败')
  expect(screen.queryByText('当前无本范围核对差异')).toBeNull()
  response = Response.json({ ...checks, issues: [], paymentStatus: 'available', paymentMessage: '医院支付参考参数可用。' })
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新分组核对' }))
  await screen.findByText('当前无本范围核对差异')
  response = Response.json({}, { status: 503 })
  await act(async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
  await screen.findByText('分组核对读取失败')
  expect(screen.queryByText('当前无本范围核对差异')).toBeNull()
})

it.each(['unknown', 'frozen'] as const)('解释为 %s 时仅核查原尝试，不重新派发且规则仍可读', async status => {
  const writes: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') writes.push(path)
    if (path.endsWith('/drg/record-checks')) return Response.json(checks)
    if (path.endsWith('/drg/record-checks/explanation')) return Response.json({ admissionId: admission.id, taskId: null, version: 1,
      fingerprint: checks.fingerprint, status, failureCode: status === 'unknown' ? 'MODEL_OUTCOME_UNKNOWN' : null, result: null })
    throw new Error(`Unexpected request ${path}`)
  }))
  const { client } = mount(), user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '展开 AI 解释' }))
  await screen.findByText(status === 'unknown' ? '原解释请求结果未知，请先核查原用量明细；不会自动重发。' : '病案已归档，解释状态与原请求只读可查，不再发起模型请求。')
  await user.click(screen.getByRole('button', { name: '核查原解释请求' }))
  await act(async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
  expect(writes).toEqual([])
  expect(screen.getByText('实际 PCI 与首页主操作选择不同')).toBeDefined()
})

it('核对依据更新使旧解释失效，刷新不自动派发当前依据解释', async () => {
  let currentChecks = checks
  const explained = { admissionId: admission.id, taskId: null, version: 1, fingerprint: checks.fingerprint, status: 'succeeded', failureCode: null,
    result: { id: 'old-explanation', fingerprint: checks.fingerprint, model: 'synthetic', createdAt: '2026-10-30T01:00:00Z',
      observations: [{ key: checks.issues[0]!.key, explanation: '旧依据解释不应继续显示', evidenceIds: checks.issues[0]!.evidence }] } }
  const writes: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') writes.push(path)
    if (path.endsWith('/drg/record-checks')) return Response.json(currentChecks)
    if (path.endsWith('/drg/record-checks/explanation')) return Response.json(currentChecks === checks ? explained
      : { ...explained, fingerprint: currentChecks.fingerprint, status: 'stale', result: null })
    throw new Error(`Unexpected request ${path}`)
  }))
  const { client } = mount()
  await userEvent.setup().click(await screen.findByRole('button', { name: '展开 AI 解释' }))
  await screen.findByText('旧依据解释不应继续显示')
  currentChecks = { ...checks, fingerprint: 'b'.repeat(64) }
  await act(async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
  await screen.findByText('核对依据已变化，旧解释已失效；可按当前依据重新请求。')
  expect(screen.queryByText('旧依据解释不应继续显示')).toBeNull()
  expect(writes).toEqual([])
})

it('切换病例后晚到的解释状态不启动原病例的模型请求', async () => {
  let release!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { release = resolve })
  const writes: string[] = []
  const second = { ...admission, id: 'admission-2', patientId: 'patient-2', patientName: '合成第二位患者' }
  let started = false
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') writes.push(path)
    if (path.endsWith('/drg/record-checks')) return Response.json(path.includes(second.id) ? { ...checks, admissionId: second.id, fingerprint: 'b'.repeat(64) } : checks)
    if (path.endsWith('/drg/record-checks/explanation')) {
      if (!path.includes(second.id)) { started = true; return pending }
      return Response.json({ admissionId: second.id, taskId: null, version: 0, fingerprint: 'b'.repeat(64), status: 'idle', failureCode: null, result: null })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const { rerender } = mount(), user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '展开 AI 解释' }))
  await waitFor(() => expect(started).toBe(true))
  rerender(second)
  await screen.findByRole('button', { name: '展开 AI 解释' })
  await act(async () => { release(Response.json({ admissionId: admission.id, taskId: null, version: 0, fingerprint: checks.fingerprint, status: 'idle', failureCode: null, result: null })); await pending })
  expect(writes).toEqual([])
})
