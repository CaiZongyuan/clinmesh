// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SessionContext } from '@clinmesh/contracts/his'
import { syntheticPatientProfileDetailSchema, type SyntheticPatientProfileDetail } from '@clinmesh/contracts/scenario'
import { afterEach, expect, it, vi } from 'vitest'
import { SyntheticPatientLibrary } from './synthetic-patient-library.tsx'
import { useSyntheticPatientLibraryViewStore } from './synthetic-patient-library-view-store.ts'

const session: SessionContext = { user: { id: 'synthetic-admin', name: '合成管理员', email: 'synthetic@example.test' }, availableRoles: [],
  actor: { actorId: 'synthetic-admin', epoch: 'synthetic-epoch', workspaceId: 'synthetic-workspace', scenarioRunId: 'synthetic-run', roleCode: 'administrator',
    practitionerRoleId: 'synthetic-role', practitionerId: 'synthetic-practitioner', organizationId: 'synthetic-hospital', locationId: 'synthetic-location' } }
const clients: QueryClient[] = []
const draftChoices = [{ label: '就诊科室', choice: '合成第二科室' }, { label: '就诊地点', choice: '合成第二地点' }, { label: '门诊类型', choice: '合成专科门诊' }]
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); useSyntheticPatientLibraryViewStore.getState().reset(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function profile(id: string, name: string): SyntheticPatientProfileDetail {
  return syntheticPatientProfileDetailSchema.parse({ profileId: id, birthDate: '1988-03-16', gender: 'female', revision: 1, workspaceId: session.actor.workspaceId,
    createdAt: '2026-11-10T09:00:00+08:00', updatedAt: '2026-11-10T09:00:00+08:00',
    identity: { address: '合成地址', displayName: name, email: `${id}@example.test`, insuranceDisplay: '合成医保', mrn: `SYN-${id}`, nationalId: '320582198803160028', phone: '13800001234' },
    source: { batchId: 'synthetic-batch', batchName: '合成连续办理', format: 'fhir-r4-bundle', hash: 'a'.repeat(64), patientId: id, providerId: 'synthea' },
    case: { activeBriefRevision: 1, caseId: `case-${id}`, caseType: 'new-problem', createdAt: '2026-11-10T09:00:00+08:00', profileId: id, profileRevision: 1,
      revision: 2, sourceHash: 'a'.repeat(64), status: 'brief-ready', updatedAt: '2026-11-10T09:00:00+08:00', visibleHistoryCount: 0, workspaceId: session.actor.workspaceId } })
}
function setup(startGate?: Promise<void>, rejectRecovery = false, pageSize = 20) {
  const patients = [profile('a', '合成连续甲'), profile('b', '合成连续乙'), profile('c', '合成未就绪丙')]
  patients[2]!.case = { ...patients[2]!.case!, activeBriefRevision: null, status: 'brief-pending' }
  const posts: Array<{ caseId: string; body: unknown; key: string | null }> = []
  const detailReads: string[] = []
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (raw: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    if (url.pathname === '/api/auth/context') return Response.json(session)
    if (rejectRecovery && url.pathname === '/api/his/v1/command-receipts') return Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: '合成原回执缺失' } }, { status: 404 })
    if (url.pathname === '/api/sim/v1/synthetic-patients') {
      const page = Number(url.searchParams.get('page') ?? 1)
      const search = url.searchParams.get('search') ?? ''
      const matches = patients.filter(item => item.identity.displayName.includes(search))
      return Response.json({ page, pageSize, total: matches.length,
        items: matches.slice((page - 1) * pageSize, page * pageSize).map(item => ({ profileId: item.profileId, activeVisit: item.case?.status === 'started', batchId: item.source.batchId, batchName: item.source.batchName,
          birthDate: item.birthDate, createdAt: item.createdAt, gender: item.gender, historyCount: 0, mrn: item.identity.mrn, name: item.identity.displayName,
          providerId: 'synthea', revision: item.revision, updatedAt: item.updatedAt })) })
    }
    const selected = patients.find(item => url.pathname === `/api/sim/v1/synthetic-patients/${item.profileId}`)
    if (selected !== undefined) { detailReads.push(selected.profileId); return Response.json(selected) }
    if (url.pathname.endsWith('/patient-persona-revisions')) return Response.json({ activeRevision: 1, items: [] })
    if (url.pathname.endsWith('/history')) return Response.json({ items: [], page: 1, pageSize: 20, total: 0 })
    if (url.pathname === '/api/his/v1/catalogs/registration') return Response.json({ departments: [{ id: 'department-a', nameZh: '合成科室', nameEn: 'Synthetic department', version: 1 }, { id: 'department-b', nameZh: '合成第二科室', nameEn: 'Synthetic second department', version: 1 }],
      locations: [{ id: 'location-a', nameZh: '合成地点', nameEn: 'Synthetic location', version: 1 }, { id: 'location-b', nameZh: '合成第二地点', nameEn: 'Synthetic second location', version: 1 }],
      visitTypes: [{ id: 'visit-a', nameZh: '普通门诊', nameEn: 'Synthetic visit', version: 1 }, { id: 'visit-b', nameZh: '合成专科门诊', nameEn: 'Synthetic specialty visit', version: 1 }], virtualDate: '2026-11-10' })
    const starting = patients.find(item => url.pathname === `/api/his/v1/synthetic-cases/${item.case?.caseId}/actions/start-outpatient-visit`)
    if (starting !== undefined) {
      posts.push({ caseId: starting.case!.caseId, body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get('idempotency-key') })
      if (startGate !== undefined) await startGate
      if (rejectRecovery) {
        if (posts.length === 1) throw new TypeError('synthetic lost response')
        return Response.json({ error: { code: 'INVALID_INPUT', message: '合成原开始请求被拒绝' } }, { status: 400 })
      }
      starting.case = { ...starting.case!, status: 'started', revision: 3 }
      return Response.json({ auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [], data: { syntheticCaseId: starting.case.caseId,
        encounterId: `encounter-${starting.profileId}`, outpatientCaseId: `outpatient-${starting.profileId}`, patientId: `patient-${starting.profileId}`,
        queueTaskId: `queue-${starting.profileId}`, registrationId: `registration-${starting.profileId}`, status: 'awaiting-triage' } })
    }
    return Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: '合成次要资料不可读' } }, { status: 503 })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const renderLibrary = (auth = session) => <QueryClientProvider client={client}><SyntheticPatientLibrary locale="zh-CN" session={auth} /></QueryClientProvider>
  return { patients, posts, detailReads, renderLibrary, client }
}

async function openLibrary(section = '患者库') {
  const libraryTab = screen.queryByRole('tab', { name: section })
  if (libraryTab !== null) fireEvent.click(libraryTab)
  else {
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(within(await screen.findByRole('menu')).getByText(section, { exact: true }))
  }
}
async function startCurrentVisit() {
  fireEvent.click(await screen.findByRole('button', { name: '开始门诊就诊' }))
  const sheet = within(screen.getByRole('dialog', { name: '开始门诊就诊' }))
  const confirm = sheet.getByRole('button', { name: '开始门诊就诊' })
  await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false))
  fireEvent.click(confirm)
}

it('搜索后详情和门诊开始使用当前结果患者，不沿用原队列首位', async () => {
  const { posts, renderLibrary } = setup()
  render(renderLibrary())
  await openLibrary()
  await screen.findByRole('heading', { name: '合成连续甲' })
  const search = screen.getByRole('textbox', { name: '搜索患者' })
  fireEvent.change(search, { target: { value: '合成连续乙' } })
  fireEvent.submit(search.closest('form')!)
  await screen.findByRole('heading', { name: '合成连续乙' })
  expect(screen.queryByRole('heading', { name: '合成连续甲' })).toBeNull()
  await startCurrentVisit()
  await waitFor(() => expect(posts.map(item => item.caseId)).toEqual(['case-b']))
})

it('往返翻页时详情跟随可见队列，第二页开始只提交第二页患者', async () => {
  const { posts, renderLibrary } = setup(undefined, false, 1)
  render(renderLibrary())
  await openLibrary()
  await screen.findByRole('heading', { name: '合成连续甲' })
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await screen.findByRole('heading', { name: '合成连续乙' })
  expect(screen.queryByRole('heading', { name: '合成连续甲' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '上一页' }))
  await screen.findByRole('heading', { name: '合成连续甲' })
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await screen.findByRole('heading', { name: '合成连续乙' })
  await startCurrentVisit()
  await waitFor(() => expect(posts.map(item => item.caseId)).toEqual(['case-b']))
  expect(await screen.findByRole('heading', { name: '合成连续乙' })).toBeTruthy()
})

it('明确选择患者后搜索无结果时移除旧详情和开始入口，清除检索选回可见首位', async () => {
  const { posts, renderLibrary } = setup()
  render(renderLibrary())
  await openLibrary()
  fireEvent.click(await screen.findByRole('button', { name: /合成连续乙/ }))
  await screen.findByRole('heading', { name: '合成连续乙' })
  const search = screen.getByRole('textbox', { name: '搜索患者' })
  fireEvent.change(search, { target: { value: '不存在的合成患者' } })
  fireEvent.submit(search.closest('form')!)
  await screen.findByText('没有匹配的患者')
  expect(screen.queryByRole('heading', { name: '合成连续乙' })).toBeNull()
  expect(screen.queryByRole('button', { name: '开始门诊就诊' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '清除检索' }))
  await screen.findByRole('heading', { name: '合成连续甲' })
  expect(posts).toHaveLength(0)
})

it.each(['合成连续乙', '不存在的合成患者'])('搜索“%s”等待期间生成完成，不选中列表外的生成患者', async searchText => {
  const { patients, posts, renderLibrary } = setup()
  const fetchLibrary = fetch
  let releaseSearch: () => void = () => undefined
  const searchGate = new Promise<void>(resolve => { releaseSearch = resolve })
  let searchStarted = false, generationFinished = false
  let request: unknown
  const job = () => ({ jobId: 'synthetic-generation', workspaceId: session.actor.workspaceId, request,
    status: generationFinished ? 'succeeded' : 'running', profileIds: generationFinished ? ['g'] : [], caseIds: generationFinished ? ['case-g'] : [],
    createdAt: '2026-11-10T09:00:00+08:00', updatedAt: '2026-11-10T09:01:00+08:00', startedAt: '2026-11-10T09:00:00+08:00',
    finishedAt: generationFinished ? '2026-11-10T09:01:00+08:00' : null, error: null })
  vi.stubGlobal('fetch', vi.fn(async (raw: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    if (url.pathname.endsWith('/scenario-runs/current')) return Response.json({ clinicalReview: null, epoch: session.actor.epoch, initialStateHash: 'synthetic-hash',
      kind: 'candidate', scenarioId: 'synthetic-scenario', scenarioRunId: session.actor.scenarioRunId, seed: 1, status: 'active',
      virtualTime: '2026-11-10T09:00:00+08:00', workspaceId: session.actor.workspaceId })
    if (url.pathname.endsWith('/scenario-providers')) return Response.json({ items: [{ providerId: 'synthea', providerName: '合成Provider', available: true, maxPopulation: 100, modules: [] }] })
    if (url.pathname.endsWith('/scenario-generation-jobs')) {
      request = JSON.parse(String(init?.body))
      return Response.json({ auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [], data: job() })
    }
    if (url.pathname.endsWith('/scenario-generation-jobs/synthetic-generation')) return Response.json(job())
    if (url.pathname.endsWith('/synthetic-patients') && url.searchParams.has('search')) { searchStarted = true; await searchGate }
    return fetchLibrary(raw, init)
  }))
  render(renderLibrary())
  await openLibrary('演示准备')
  fireEvent.click(await screen.findByRole('button', { name: '生成患者' }))
  const generation = within(screen.getByRole('dialog', { name: '生成患者' }))
  await waitFor(() => expect(generation.getByRole('button', { name: '生成患者' }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(generation.getByRole('button', { name: '生成患者' }))
  await screen.findByRole('status', { name: '患者生成中' })
  await openLibrary()
  await screen.findByRole('heading', { name: '合成连续甲' })
  const search = screen.getByRole('textbox', { name: '搜索患者' })
  fireEvent.change(search, { target: { value: searchText } })
  fireEvent.submit(search.closest('form')!)
  await waitFor(() => expect(searchStarted).toBe(true))
  patients.push(profile('g', '合成后台生成患者'))
  generationFinished = true
  await screen.findByRole('status', { name: '患者档案与病例已生成' }, { timeout: 3_000 })
  releaseSearch()
  if (searchText === '合成连续乙') await screen.findByRole('heading', { name: '合成连续乙' })
  else {
    await screen.findByText('没有匹配的患者')
    expect(screen.queryByRole('button', { name: '开始门诊就诊' })).toBeNull()
  }
  expect(screen.queryByRole('heading', { name: '合成后台生成患者' })).toBeNull()
  expect(posts).toHaveLength(0)
})

it('患者库开始成功停在当前，点具名固定下一位只导航，仍需再次确认才开始', async () => {
  const { posts, detailReads, renderLibrary } = setup()
  render(renderLibrary())
  await openLibrary()
  await startCurrentVisit()
  const continuation = await screen.findByRole('region', { name: '连续开始门诊' })
  expect(screen.getByRole('heading', { name: '合成连续甲' })).toBeTruthy()
  expect(posts).toHaveLength(1)
  expect(detailReads).toContain('c')
  const beforeNext = detailReads.filter(id => id === 'b').length
  fireEvent.click(within(continuation).getByRole('button', { name: '下一位：合成连续乙' }))
  await screen.findByRole('heading', { name: '合成连续乙' })
  expect(detailReads.filter(id => id === 'b').length).toBeGreaterThan(beforeNext)
  expect(posts).toHaveLength(1)
  await startCurrentVisit()
  await waitFor(() => expect(posts).toHaveLength(2))
  expect(posts.map(item => item.caseId)).toEqual(['case-a', 'case-b'])
  expect(posts[0]!.key).not.toBe(posts[1]!.key)
})

it('身份编辑后的当前Profile仍可用原Case进入具名下一位，导航后需确认才开始', async () => {
  const { patients, posts, renderLibrary } = setup()
  patients[1]!.revision = 2
  patients[1]!.identity.displayName = '合成已编辑乙'
  render(renderLibrary())
  await openLibrary()
  await startCurrentVisit()
  const continuation = within(await screen.findByRole('region', { name: '连续开始门诊' }))
  fireEvent.click(continuation.getByRole('button', { name: '下一位：合成已编辑乙' }))
  expect(await screen.findByRole('heading', { name: '合成已编辑乙' })).toBeTruthy()
  expect(posts).toHaveLength(1)
  await startCurrentVisit()
  await waitFor(() => expect(posts).toHaveLength(2))
  expect(posts.map(item => item.caseId)).toEqual(['case-a', 'case-b'])
})

it.each(['revision', 'name'] as const)('身份编辑后冻结的下一位再改%s时仍留在当前，不自动补第三位', async changed => {
  const { patients, posts, renderLibrary } = setup()
  patients[1]!.revision = 2
  patients[2]!.case = { ...patients[2]!.case!, activeBriefRevision: 1, status: 'brief-ready' }
  render(renderLibrary())
  await openLibrary()
  await startCurrentVisit()
  const continuation = within(await screen.findByRole('region', { name: '连续开始门诊' }))
  const next = continuation.getByRole('button', { name: '下一位：合成连续乙' })
  if (changed === 'revision') patients[1]!.revision = 3
  else patients[1]!.identity.displayName = '合成再次编辑乙'
  fireEvent.click(next)
  expect(await continuation.findByRole('alert')).toHaveProperty('textContent', '下一位患者已不符合开始条件，请刷新本页队列。')
  expect(screen.getByRole('heading', { name: '合成连续甲' })).toBeTruthy()
  expect(continuation.getByRole('button', { name: '下一位：合成连续乙' })).toBeTruthy()
  expect(continuation.queryByRole('button', { name: '下一位：合成未就绪丙' })).toBeNull()
  expect(posts).toHaveLength(1)
})

it('固定下一位外部已开始时留在当前并刷新事实，显式刷新队列后才可重选第三位', async () => {
  const { patients, posts, renderLibrary } = setup()
  patients[2]!.case = { ...patients[2]!.case!, activeBriefRevision: 1, status: 'brief-ready' }
  render(renderLibrary())
  await openLibrary()
  await startCurrentVisit()
  const continuation = within(await screen.findByRole('region', { name: '连续开始门诊' }))
  const next = continuation.getByRole('button', { name: '下一位：合成连续乙' })
  patients[1]!.case = { ...patients[1]!.case!, status: 'started', revision: 3 }
  fireEvent.click(next)
  expect(await continuation.findByRole('alert')).toHaveProperty('textContent', '下一位患者已不符合开始条件，请刷新本页队列。')
  expect(screen.getByRole('heading', { name: '合成连续甲' })).toBeTruthy()
  expect(continuation.getByRole('button', { name: '下一位：合成连续乙' })).toBeTruthy()
  expect(continuation.queryByRole('button', { name: '下一位：合成未就绪丙' })).toBeNull()
  expect(posts).toHaveLength(1)
  fireEvent.click(continuation.getByRole('button', { name: '刷新本页队列' }))
  fireEvent.click(await continuation.findByRole('button', { name: '下一位：合成未就绪丙' }))
  expect(await screen.findByRole('heading', { name: '合成未就绪丙' })).toBeTruthy()
  expect(posts).toHaveLength(1)
})

it('未发门诊表单刷新后恢复三项原稿，完整Actor变化时不串入另一身份', async () => {
  const { posts, renderLibrary } = setup()
  const first = render(renderLibrary())
  await openLibrary()
  fireEvent.click(await screen.findByRole('button', { name: '开始门诊就诊' }))
  const original = within(screen.getByRole('dialog', { name: '开始门诊就诊' }))
  const user = userEvent.setup()
  for (const { label, choice } of draftChoices) {
    await user.click(await original.findByRole('combobox', { name: label }))
    await user.click(await screen.findByRole('option', { name: choice }))
    expect(original.getByRole('combobox', { name: label }).textContent).toContain(choice)
  }
  first.unmount()
  const restored = render(renderLibrary())
  await openLibrary()
  fireEvent.click(await screen.findByRole('button', { name: '开始门诊就诊' }))
  const sheet = within(screen.getByRole('dialog', { name: '开始门诊就诊' }))
  for (const { label, choice } of draftChoices) {
    expect((await sheet.findByRole('combobox', { name: label })).textContent).toContain(choice)
  }
  restored.rerender(renderLibrary({ ...session, actor: { ...session.actor, practitionerRoleId: 'synthetic-other-role' } }))
  await openLibrary()
  fireEvent.click(await screen.findByRole('button', { name: '开始门诊就诊' }))
  const other = within(screen.getByRole('dialog', { name: '开始门诊就诊' }))
  expect((await other.findByRole('combobox', { name: '就诊科室' })).textContent).toContain('合成科室')
  expect(other.getByRole('combobox', { name: '就诊地点' }).textContent).toContain('合成地点')
  expect(other.getByRole('combobox', { name: '门诊类型' }).textContent).toContain('普通门诊')
  expect(posts).toHaveLength(0)
})

it('门诊开始提交中挡用户关闭和重复确认，成功后关闭并停在当前患者', async () => {
  let finish: () => void = () => undefined
  const gate = new Promise<void>(resolve => { finish = resolve })
  const { posts, renderLibrary } = setup(gate)
  render(renderLibrary())
  await openLibrary()
  await startCurrentVisit()
  await waitFor(() => expect(posts).toHaveLength(1))
  const sheet = screen.getByRole('dialog', { name: '开始门诊就诊' })
  fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
  fireEvent.keyDown(sheet, { key: 'Escape' })
  expect(screen.getByRole('dialog', { name: '开始门诊就诊' })).toBe(sheet)
  const confirm = within(sheet).getByRole('button', { name: '开始门诊就诊' })
  expect(confirm.hasAttribute('disabled')).toBe(true)
  fireEvent.click(confirm)
  expect(posts).toHaveLength(1)
  finish()
  await screen.findByRole('region', { name: '连续开始门诊' })
  expect(screen.queryByRole('dialog', { name: '开始门诊就诊' })).toBeNull()
  expect(screen.getByRole('heading', { name: '合成连续甲' })).toBeTruthy()
})

it('在乙的资料页恢复甲的门诊失败时，明确标注原患者且不改变当前患者', async () => {
  const { posts, renderLibrary } = setup(undefined, true)
  render(renderLibrary())
  await openLibrary()
  await startCurrentVisit()
  const sheet = within(screen.getByRole('dialog', { name: '开始门诊就诊' }))
  await sheet.findByText('门诊就诊启动失败')
  fireEvent.click(sheet.getByRole('button', { name: 'Close' }))
  fireEvent.click(await screen.findByRole('button', { name: /合成连续乙/ }))
  await screen.findByRole('heading', { name: '合成连续乙' })
  fireEvent.click(screen.getByRole('button', { name: '查询原门诊开始结果' }))
  expect((await screen.findByText('原门诊办理未完成：合成连续甲')).closest('[role="alert"]')).toBeTruthy()
  expect(screen.getByRole('heading', { name: '合成连续乙' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '查询原门诊开始结果' })).toBeNull()
  expect(posts).toEqual([expect.objectContaining({ caseId: 'case-a' }), posts[0]])
})
