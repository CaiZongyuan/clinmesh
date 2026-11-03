// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientGuidelineAdviceSchema, inpatientGuidelineAdviceListSchema } from '@clinmesh/contracts/inpatient-guideline-advice'
import { InpatientGuidelineAdvicePanel } from './inpatient-guideline-advice.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { usageOverview } from './model-usage.test-fixture.ts'

const session: SessionContext = {
  actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'scenario-run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' },
  user: { id: 'user-doctor', name: '住院医生', email: 'inpatient-doctor@demo.clinmesh.local' }, availableRoles: [],
}
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成指南患者', inpatientNumber: 'ZY-0001',
  admissionRoute: 'direct', wardId: 'ward-general', organizationId: 'organization-inpatient', status: 'admitted', financialStatus: 'open', recordStatus: 'open',
  registeredAt: '2026-08-24T09:00:00+08:00', depositFen: 0, chargesFen: 0, versionId: '2' })
const evidence = [
  { id: 'guideline-stent', title: '合成血运重建指南', locator: 'PDF 物理第 35 页', text: 'In patients undergoing PCI, DES should be used in preference to BMS.' },
  { id: 'guideline-imaging', title: '合成血运重建指南', locator: 'PDF 物理第 36 页', text: 'IVUS can be useful in left main or complex stenting. OCT is a reasonable alternative except in ostial left main disease.' },
  { id: 'guideline-measurement', title: '合成 CVIT 测量共识', locator: 'PDF 物理第 6 页', text: 'Distinguish proximal and distal reference lumen and EEM. Length cannot be measured by manual pullback without longitudinal acquisition.' },
].map(item => ({ ...item, publisher: '合成指南机构', documentType: 'guideline' as const, version: '2021',
  url: 'https://example.test/verified-guideline', scope: '仅用于合成界面合同', sourceHash: 'c'.repeat(64) }))
const ready = inpatientGuidelineAdviceSchema.parse({ admissionId: admission.id, requestId: 'surgery-1', taskId: 'guideline-task-1', version: 1,
  fingerprint: 'a'.repeat(64), status: 'incomplete', message: '指南参考意见已准备；患者资料仍有缺项，仅供有条件核对。', missing: ['缺少近端参考管径。'], failureCode: null,
  result: { id: 'guideline-result-1', fingerprint: 'a'.repeat(64), model: 'synthetic-guideline-model', createdAt: '2026-08-24T09:00:00+08:00',
    topic: { id: 'pci-stent', version: '2026-11-02.r1', fingerprint: 'b'.repeat(64) }, guidelines: evidence, conclusions: [
      { kind: 'stent-category', applicability: 'conditional', text: '已提出 PCI 计划，可核对 DES 相对 BMS 的类别依据，具体患者适用条件仍待核实。', citations: [{ evidenceId: evidence[0]!.id, quote: evidence[0]!.text }] },
      { kind: 'imaging-guidance', applicability: 'conditional', text: 'IVUS 可用于左主干或复杂支架指导，OCT 替代保留左主干开口限制；不是所有 PCI 必须检查。', citations: [{ evidenceId: evidence[1]!.id, quote: evidence[1]!.text }] },
      { kind: 'measurement-requirements', applicability: 'conditional', text: '区分近远端管腔与 EEM 测量，手动回撤不等于已取得可靠病变长度。', citations: [{ evidenceId: evidence[2]!.id, quote: evidence[2]!.text }] },
    ], limitations: ['首期固定 2021 版来源，未完成现行版本全集核查。', '具体产品、规格与数量仍需独立依据。'] } })
const clients: QueryClient[] = []
afterEach(async () => {
  vi.useRealTimers()
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  await act(() => new Promise<void>(resolve => notifyManager.schedule(resolve)))
  vi.unstubAllGlobals(); sessionStorage.clear()
})

it.each(['idle', 'queued', 'running', 'no-evidence', 'blocked', 'unknown', 'rejected', 'failed', 'cancelled', 'stale'] as const)(
  '%s 状态即使带有旧结果也不展示意见和引文，不泄露内部失败码', async status => {
    const state = { ...ready, status, message: `当前状态：${status}`, failureCode: 'RAW_FAILURE_CODE' }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ admissionId: admission.id, advice: [state] })))
    mount()
    await screen.findByText(state.message)
    expect(screen.queryByText(ready.result!.conclusions[0]!.text)).toBeNull()
    expect(screen.queryByText(evidence[0]!.text)).toBeNull()
    expect(screen.queryByText(state.failureCode)).toBeNull()
  })

it('结果指纹不属于当前依据时不展示意见和原文', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ admissionId: admission.id, advice: [{ ...ready, fingerprint: 'e'.repeat(64) }] })))
  mount()
  await screen.findByText(ready.message)
  expect(screen.queryByText(ready.result!.conclusions[0]!.text)).toBeNull()
  expect(screen.queryByText(evidence[0]!.text)).toBeNull()
})

it('列表中的其他住院意见不会落在当前病例', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ admissionId: admission.id, advice: [{ ...ready, admissionId: 'other-admission' }] })))
  mount()
  await screen.findByText('尚无本计划指南参考意见')
  expect(screen.queryByText(ready.message)).toBeNull()
  expect(screen.queryByText(ready.result!.conclusions[0]!.text)).toBeNull()
})

it.each(['非医生', '已归档', '已出院'] as const)('%s的过期意见仍可读取，但没有模型重评操作', async state => {
  const stale = { ...ready, status: 'stale', result: null }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ admissionId: admission.id, advice: [stale] })))
  mount({ requestId: ready.requestId,
    ...(state === '非医生' ? { currentSession: { ...session, actor: { ...session.actor, roleCode: 'ward-nurse' as const } } } : {}),
    ...(state === '已归档' ? { stay: { ...admission, recordStatus: 'archived' as const } } : {}),
    ...(state === '已出院' ? { stay: { ...admission, status: 'departed' as const } } : {}),
  })
  await screen.findByText(stale.message)
  expect(screen.queryByRole('button', { name: '按当前依据重新评估指南' })).toBeNull()
})

it('读取失权后立即隐藏已展示的意见、原句和用量入口', async () => {
  let reads = 0
  vi.stubGlobal('fetch', vi.fn(async () => ++reads === 1
    ? Response.json({ admissionId: admission.id, advice: [ready] })
    : Response.json({ error: { code: 'FORBIDDEN', message: 'Synthetic access denied' } }, { status: 403 })))
  mount()
  await screen.findByText(ready.result!.conclusions[0]!.text)
  await userEvent.setup().click(screen.getByText('查看支架类别依据'))
  expect(screen.getByText(evidence[0]!.text)).toBeDefined()
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新指南状态' }))
  await screen.findByText('指南参考意见读取失败')
  expect(screen.queryByText(ready.result!.conclusions[0]!.text)).toBeNull()
  expect(screen.queryByText(evidence[0]!.text)).toBeNull()
  expect(screen.queryByRole('button', { name: '查看指南实际用量' })).toBeNull()
  expect(screen.queryByRole('button', { name: '按当前依据重新评估指南' })).toBeNull()
})

it.each(['读取失败', '依据版本变化'] as const)('重评预检遇到%s时停止提交', async situation => {
  const stale = { ...ready, status: 'stale', result: null }
  let reads = 0
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push(path)
    if (++reads === 1) return Response.json({ admissionId: admission.id, advice: [stale] })
    return situation === '读取失败' ? Response.json({ error: { code: 'READ_FAILED', message: 'Synthetic read failure' } }, { status: 503 })
      : Response.json({ admissionId: admission.id, advice: [{ ...stale, version: 2, fingerprint: 'e'.repeat(64) }] })
  }))
  mount()
  await screen.findByRole('button', { name: '按当前依据重新评估指南' })
  await userEvent.setup().click(screen.getByRole('button', { name: '按当前依据重新评估指南' }))
  await screen.findByText(situation === '读取失败' ? '指南参考意见读取失败' : '指南资料已更新，请核对当前内容后再次重评。')
  expect(posts).toEqual([])
})

it.each(['病例', '计划', '岗位', '归档', '计划已不可重评', '页面停用后恢复'] as const)('重评预检期间切换%s，迟到读取不能提交旧意图', async change => {
  let release!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { release = resolve })
  const stale = { ...ready, status: 'stale', result: null }
  let reads = 0
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push(path)
    if (path.endsWith('/guideline-advice') && ++reads === 2) return pending
    return Response.json({ admissionId: path.includes('admission-2') ? 'admission-2' : admission.id, advice: [stale] })
  }))
  const view = mount()
  await screen.findByRole('button', { name: '按当前依据重新评估指南' })
  await userEvent.setup().click(screen.getByRole('button', { name: '按当前依据重新评估指南' }))
  await waitFor(() => expect(reads).toBe(2))
  if (change === '病例') view.rerender({ stay: { ...admission, id: 'admission-2' }, requestId: ready.requestId })
  if (change === '计划') view.rerender({ requestId: 'surgery-2' })
  if (change === '岗位') view.rerender({ currentSession: { ...session, actor: { ...session.actor, roleCode: 'ward-nurse' } }, requestId: ready.requestId })
  if (change === '归档') view.rerender({ stay: { ...admission, recordStatus: 'archived' }, requestId: ready.requestId })
  if (change === '计划已不可重评') view.rerender({ requestId: ready.requestId, canReassess: false })
  if (change === '页面停用后恢复') {
    view.rerender({ requestId: ready.requestId, active: false })
    view.rerender({ requestId: ready.requestId, active: true })
  }
  await act(async () => { release(Response.json({ admissionId: admission.id, advice: [stale] })) })
  expect(posts).toEqual([])
})

it('共享Command会话预检期间离开当前计划，不晚发旧指南重评', async () => {
  let release!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { release = resolve })
  const stale = { ...ready, status: 'stale', result: null }
  let checkingSession = false
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') { checkingSession = true; return pending }
    if (init?.method === 'POST') posts.push(path)
    if (path.endsWith('/guideline-advice/request')) return Response.json({ data: { ...stale, status: 'queued' },
      requestId: 'command-request-1', auditId: 'audit-1', effects: [], warnings: [] })
    return Response.json({ admissionId: admission.id, advice: [stale] })
  }))
  const view = mount()
  await screen.findByRole('button', { name: '按当前依据重新评估指南' })
  await userEvent.setup().click(screen.getByRole('button', { name: '按当前依据重新评估指南' }))
  await waitFor(() => expect(checkingSession).toBe(true))
  view.rerender({ requestId: 'surgery-2' })
  await act(async () => { release(Response.json(session)) })
  expect(posts).toEqual([])
  expect(sessionStorage.length).toBe(0)
})

it('按指定计划过滤，未指定时可读取全部计划且不重复请求', async () => {
  const second = { ...ready, requestId: 'surgery-2', message: '第二计划的指南参考意见。', result: null }
  let reads = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    reads++; return Response.json({ admissionId: admission.id, advice: [ready, second] })
  }))
  const view = mount()
  await screen.findByText(ready.message)
  expect(screen.queryByText(second.message)).toBeNull()
  view.rerender({ requestId: second.requestId })
  expect(screen.getByText(second.message)).toBeDefined()
  expect(screen.queryByText(ready.message)).toBeNull()
  view.rerender({})
  expect(screen.getByText(ready.message)).toBeDefined()
  expect(screen.getByText(second.message)).toBeDefined()
  expect(reads).toBe(1)
})

it('未激活页面不读取，停用后停止轮询并隐藏操作', async () => {
  vi.useFakeTimers()
  let reads = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    reads++; return Response.json({ admissionId: admission.id, advice: [ready] })
  }))
  const view = mount({ active: false })
  expect(reads).toBe(0)
  expect(screen.queryByRole('region', { name: '指南参考意见' })).toBeNull()
  view.rerender({ active: true })
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(screen.getByText(ready.message)).toBeDefined()
  await act(() => vi.advanceTimersByTimeAsync(3_001))
  expect(reads).toBe(2)
  view.rerender({ active: false })
  await act(() => vi.advanceTimersByTimeAsync(9_001))
  expect(reads).toBe(2)
  expect(screen.queryByRole('region', { name: '指南参考意见' })).toBeNull()
})

it('模型受阻时只读核查，轮询可显示后端沿原准备恢复的已核验意见而不派发新Command', async () => {
  vi.useFakeTimers()
  const methods: string[] = []
  let reads = 0
  const blocked = { ...ready, status: 'blocked', message: 'AI暂不可用或用量控制未就绪，指南参考意见尚未生成。' }
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET')
    return Response.json({ admissionId: admission.id, advice: [++reads === 1 ? blocked : ready] })
  }))
  mount()
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(screen.getByText(blocked.message)).toBeDefined()
  expect(screen.queryByText(ready.result!.conclusions[0]!.text)).toBeNull()
  expect(screen.queryByRole('button', { name: '按当前依据重新评估指南' })).toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(3_001))
  expect(screen.getByText(ready.result!.conclusions[0]!.text)).toBeDefined()
  expect(reads).toBe(2)
  expect(methods).toEqual(['GET', 'GET'])
})

it('英文历史只读保留三类依据，冻结、归档和非医生岗位均无重评操作', async () => {
  const frozen = { ...ready, status: 'frozen' }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ admissionId: admission.id, advice: [frozen] })))
  const view = mount({ locale: 'en-US', requestId: ready.requestId, canReassess: false })
  const panel = await screen.findByRole('region', { name: 'Guideline reference advice' })
  await within(panel).findByText(/read-only history/)
  expect(within(panel).getByText('Stent category')).toBeDefined()
  expect(within(panel).getByText('IVUS / OCT guidance conditions')).toBeDefined()
  expect(within(panel).getByText('Sizing and measurement requirements')).toBeDefined()
  expect(within(panel).queryByRole('button', { name: 'Reassess guidelines with current sources' })).toBeNull()
  view.rerender({ stay: { ...admission, recordStatus: 'archived' }, requestId: ready.requestId })
  expect(screen.queryByRole('button', { name: '按当前依据重新评估指南' })).toBeNull()
  view.rerender({ currentSession: { ...session, actor: { ...session.actor, roleCode: 'ward-nurse' } }, requestId: ready.requestId })
  expect(screen.queryByRole('button', { name: '按当前依据重新评估指南' })).toBeNull()
})

type ViewProps = { stay?: typeof admission; currentSession?: SessionContext; requestId?: string; active?: boolean; canReassess?: boolean; locale?: WorkspaceLocale }
function mount(initial: ViewProps = { requestId: 'surgery-1' }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  function Harness({ stay = admission, currentSession = session, requestId, active = true, canReassess = true, locale = 'zh-CN' }: ViewProps) {
    const write = useInpatientWriteIntent(currentSession, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <><InpatientWriteRecovery write={write} locale={locale} />
      <InpatientGuidelineAdvicePanel admission={stay} session={currentSession} locale={locale} write={write} active={active} canReassess={canReassess}
        {...(requestId === undefined ? {} : { requestId })} /></>
  }
  const view = render(<QueryClientProvider client={client}><Harness {...initial} /></QueryClientProvider>)
  return { client, unmount: view.unmount, rerender: (props: ViewProps) => view.rerender(<QueryClientProvider client={client}><Harness {...props} /></QueryClientProvider>) }
}

it('只读展示三类条件意见、缺项及固定原文依据，挂载不派发模型或转成清单', async () => {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${path}`)
    if (path.endsWith('/guideline-advice')) return Response.json(inpatientGuidelineAdviceListSchema.parse({ admissionId: admission.id, advice: [ready] }))
    throw new Error(`Unexpected request ${path}`)
  }))
  mount()
  const panel = await screen.findByRole('region', { name: '指南参考意见' })
  await within(panel).findByText(ready.result!.conclusions[0]!.text)
  for (const conclusion of ready.result!.conclusions) expect(within(panel).getByText(conclusion.text)).toBeDefined()
  expect(within(panel).getByText('缺少近端参考管径。')).toBeDefined()
  expect(within(panel).getByText('首期固定 2021 版来源，未完成现行版本全集核查。')).toBeDefined()
  expect(within(panel).getByText(/未确认耗材清单与当前预留分别办理/)).toBeDefined()
  expect(within(panel).getAllByText('助手').length).toBeGreaterThan(0)
  await userEvent.setup().click(within(panel).getByText('查看支架类别依据'))
  const citation = within(panel).getByRole('group', { name: '支架类别依据' })
  expect(within(citation).getByText(evidence[0]!.title)).toBeDefined()
  expect(within(citation).getByText(/2021.*PDF 物理第 35 页/)).toBeDefined()
  expect(within(citation).getByText(evidence[0]!.text)).toBeDefined()
  expect(within(panel).queryByRole('checkbox')).toBeNull()
  expect(within(panel).queryByRole('button', { name: /批准|确认|采用到清单/ })).toBeNull()
  expect(requests).toEqual([`GET /api/his/v1/inpatient/admissions/${admission.id}/guideline-advice`])
})

it.each(['stale', 'frozen', 'cancelled'] as const)('%s意见在计划仍可重评时，沿共享可恢复Command显式提交当前版本与依据指纹', async status => {
  let current = inpatientGuidelineAdviceSchema.parse({ ...ready, version: 4, fingerprint: 'd'.repeat(64), status,
    message: '正式资料已变化，请显式重新评估。', result: null })
  const posts: Array<{ path: string; input: unknown; key: string | null }> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/guideline-advice')) return Response.json({ admissionId: admission.id, advice: [current] })
    if (path.endsWith('/guideline-advice/request')) {
      posts.push({ path, input: JSON.parse(String(init?.body)).input, key: new Headers(init?.headers).get('idempotency-key') })
      current = inpatientGuidelineAdviceSchema.parse({ ...current, version: 5, status: 'queued', message: '正在准备指南参考意见。' })
      return Response.json({ data: current, requestId: 'command-request-1', auditId: 'audit-1', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  mount()
  await screen.findByText('正式资料已变化，请显式重新评估。')
  expect(posts).toEqual([])
  await userEvent.setup().click(screen.getByRole('button', { name: '按当前依据重新评估指南' }))
  await screen.findByText('正在准备指南参考意见。')
  expect(posts).toEqual([{ path: `/api/his/v1/inpatient/admissions/${admission.id}/guideline-advice/request`,
    input: { requestId: ready.requestId, expectedVersion: 4, expectedFingerprint: 'd'.repeat(64) }, key: expect.any(String) }])
  expect(posts[0]!.key!.length).toBeGreaterThanOrEqual(8)
})

it.each(['frozen', 'cancelled'] as const)('父级确认计划不可重评时，%s只读且不产生POST', async status => {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${path}`)
    return Response.json({ admissionId: admission.id, advice: [{ ...ready, status }] })
  }))
  mount({ requestId: ready.requestId, canReassess: false })
  await screen.findByText(ready.message)
  expect(screen.queryByRole('button', { name: '按当前依据重新评估指南' })).toBeNull()
  expect(requests).toEqual([`GET /api/his/v1/inpatient/admissions/${admission.id}/guideline-advice`])
})

it('结果未知只核查原请求及真实指南用量，不显示旧意见或允许重新派发', async () => {
  const requests: URL[] = [], methods: string[] = []
  const unknown = { ...ready, status: 'unknown', message: '原模型请求结果未知，请核查原请求与用量。', failureCode: 'RAW_UNKNOWN_CODE' }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    requests.push(url); methods.push(init?.method ?? 'GET')
    if (url.pathname.endsWith('/guideline-advice')) return Response.json({ admissionId: admission.id, advice: [unknown] })
    if (url.pathname === '/api/model-usage/overview') return Response.json({ ...usageOverview, stages: [] })
    if (url.pathname === '/api/model-usage/retention') return Response.json({ days: 90, version: 1, compactedRequests: 0, lastCompactedAt: null })
    throw new Error(`Unexpected request ${url}`)
  }))
  mount()
  await screen.findByText(unknown.message)
  expect(screen.queryByText(ready.result!.conclusions[0]!.text)).toBeNull()
  expect(screen.queryByText(evidence[0]!.text)).toBeNull()
  expect(screen.queryByText(unknown.failureCode)).toBeNull()
  expect(screen.queryByRole('button', { name: '按当前依据重新评估指南' })).toBeNull()
  await userEvent.setup().click(screen.getByRole('button', { name: '核查原请求与实际用量' }))
  await screen.findByLabelText('实际AI请求数')
  expect(screen.getByLabelText('估算人民币费用').textContent).toBe('未知')
  const overview = requests.find(item => item.pathname === '/api/model-usage/overview')!
  expect(overview.searchParams.get('caseId')).toBe(admission.id)
  expect(overview.searchParams.get('taskId')).toBe(ready.taskId)
  expect(requests.filter(item => item.pathname.endsWith('/guideline-advice'))).toHaveLength(2)
  expect(methods.every(method => method === 'GET')).toBe(true)
  expect(screen.queryByText(/本次跟进/)).toBeNull()
})
