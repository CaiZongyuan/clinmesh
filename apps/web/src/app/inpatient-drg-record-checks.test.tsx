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
  const panel = await screen.findByRole('region', { name: '分组核对' })
  expect((await within(panel).findByText('实际 PCI 与首页主操作选择不同')).textContent).toBe('实际 PCI 与首页主操作选择不同')
  expect(within(panel).getByText('1 项待处理')).toBeDefined()
  expect(within(panel).getByText('分组成功，金额暂不可估。')).toBeDefined()
  const list = within(panel).getByRole('list', { name: '分组核对清单' })
  const primary = within(list).getByText('首页主操作').closest<HTMLElement>('li')!
  expect(primary.textContent).toContain('冠脉造影')
  expect(within(panel).queryByRole('button', { name: '刷新分组核对' })).toBeNull()
  expect(within(panel).queryByRole('button', { name: '前往病案首页原记录' })).toBeNull()
  expect(within(panel).queryByText(/InpatientRecord\/admission-1\/revision\/1/)).toBeNull()
  const user = userEvent.setup()
  await user.click(within(list).getByRole('button', { name: '去手术' }))
  await user.click(within(primary).getByRole('button', { name: '去病案首页' }))
  expect(navigate.mock.calls).toEqual([['surgery'], ['record']])
  expect(reads.some(path => path.endsWith('/drg/record-checks'))).toBe(true)
})

it('术后材料和财务差异展示手术、计划与实际数量、收费净额并进入对应原记录', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...checks, issues: [
    { ...checks.issues[0]!, key: 'extra-use:wire', kind: 'extra-use', display: '导丝', procedureDisplay: '经皮冠状动脉介入治疗', plannedQuantity: 1, actualQuantity: 2, target: 'surgery' },
    { ...checks.issues[0]!, key: 'billing-mismatch:wire', kind: 'billing-mismatch', ownerRole: 'cashier', display: '导丝收费不一致', procedureDisplay: '经皮冠状动脉介入治疗', expectedChargeFen: 20000, actualChargeFen: 10000, chargeDifferenceFen: -10000, target: 'charges' },
  ] })))
  const { navigate } = mount()
  const issue = (await screen.findByText('导丝')).closest<HTMLElement>('[role="alert"]')!
  expect(issue.textContent).toContain('经皮冠状动脉介入治疗')
  expect(issue.textContent).toContain('计划量：1')
  expect(issue.textContent).toContain('实际量：2')
  const billing = screen.getByText('导丝收费不一致').closest<HTMLElement>('[role="alert"]')!
  expect(billing.textContent).toContain('应计费用：¥200.00')
  expect(billing.textContent).toContain('正式费用合计（已扣除退费）：¥100.00')
  expect(billing.textContent).toContain('收费差额：-¥100.00')
  const user = userEvent.setup()
  await user.click(within(issue).getByRole('button', { name: '前往手术原记录' }))
  await user.click(within(billing).getByRole('button', { name: '前往费用原记录' }))
  expect(navigate.mock.calls).toEqual([['surgery'], ['fees']])
})

it('分组核对自动嵌入已核验行内解释，不渲染顶部「AI 解释」按钮，刷新不自动派发模型写请求', async () => {
  const explanation = inpatientDrgExplanationSchema.parse({
    admissionId: admission.id, taskId: null, version: 1,
    fingerprint: checks.fingerprint, status: 'succeeded', failureCode: null,
    result: {
      id: 'explanation-1', fingerprint: checks.fingerprint, model: 'synthetic-record-model', createdAt: '2026-10-30T01:00:00Z',
      observations: [{ key: checks.issues[0]!.key, explanation: '已核验的合成解释：请对照实际手术与首页选择，不替医生改写主操作。', evidenceIds: checks.issues[0]!.evidence }],
    },
  })
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') writes.push(path)
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/drg/record-checks')) return Response.json(checks)
    if (path.endsWith('/drg/record-checks/explanation')) return Response.json(explanation)
    throw new Error(`Unexpected request ${path}`)
  }))
  const { client } = mount()
  const panel = await screen.findByRole('region', { name: '分组核对' })
  expect(within(panel).queryByRole('button', { name: 'AI 解释' })).toBeNull()
  await within(panel).findByText('已核验的合成解释：请对照实际手术与首页选择，不替医生改写主操作。')
  await act(async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
  expect(writes).toEqual([])
  expect(within(panel).getByText('实际 PCI 与首页主操作选择不同')).toBeDefined()
})

it('加载与读取失败分别表达，成功空结论在后续读取失败后不冒充当前结果', async () => {
  let release!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { release = resolve })
  let response: Response | undefined
  vi.stubGlobal('fetch', vi.fn(async () => response?.clone() ?? pending))
  const { client } = mount()
  expect(screen.getByText('正在读取分组核对')).toBeDefined()
  expect(screen.queryByText('当前无本范围核对差异')).toBeNull()
  release(Response.json({ error: { code: 'SYNTHETIC_READ_FAILED', message: '合成读取失败' } }, { status: 503 }))
  await screen.findByText('分组核对读取失败')
  expect(screen.queryByText('当前无本范围核对差异')).toBeNull()
  response = Response.json({ ...checks, issues: [], paymentStatus: 'available', paymentMessage: '医院支付参考参数可用。' })
  await userEvent.setup().click(screen.getByRole('button', { name: '重新读取' }))
  await screen.findByText('当前无本范围核对差异')
  expect(screen.getByText('无差异')).toBeDefined()
  response = Response.json({}, { status: 503 })
  await act(async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
  await screen.findByText('分组核对读取失败')
  expect(screen.queryByText('当前无本范围核对差异')).toBeNull()
})

it('核对依据更新使旧解释失效时不显示旧解释文本且不自动派发模型写请求', async () => {
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
  await screen.findByText('旧依据解释不应继续显示')
  currentChecks = { ...checks, fingerprint: 'b'.repeat(64) }
  await act(async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
  await waitFor(() => expect(screen.queryByText('旧依据解释不应继续显示')).toBeNull())
  expect(writes).toEqual([])
})
