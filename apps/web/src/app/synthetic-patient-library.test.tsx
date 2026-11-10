// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SessionContext } from '@clinmesh/contracts/his'
import { syntheticPatientProfileDetailSchema, type SyntheticPatientProfileDetail } from '@clinmesh/contracts/scenario'
import { afterEach, expect, it, vi } from 'vitest'
import { SyntheticPatientLibrary } from './synthetic-patient-library.tsx'

const session: SessionContext = { user: { id: 'synthetic-admin', name: '合成管理员', email: 'synthetic@example.test' }, availableRoles: [],
  actor: { actorId: 'synthetic-admin', epoch: 'synthetic-epoch', workspaceId: 'synthetic-workspace', scenarioRunId: 'synthetic-run', roleCode: 'administrator',
    practitionerRoleId: 'synthetic-role', practitionerId: 'synthetic-practitioner', organizationId: 'synthetic-hospital', locationId: 'synthetic-location' } }
const clients: QueryClient[] = []
const draftChoices = [{ label: '就诊科室', choice: '合成第二科室' }, { label: '就诊地点', choice: '合成第二地点' }, { label: '门诊类型', choice: '合成专科门诊' }]
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function profile(id: string, name: string): SyntheticPatientProfileDetail {
  return syntheticPatientProfileDetailSchema.parse({ profileId: id, birthDate: '1988-03-16', gender: 'female', revision: 1, workspaceId: session.actor.workspaceId,
    createdAt: '2026-11-10T09:00:00+08:00', updatedAt: '2026-11-10T09:00:00+08:00',
    identity: { address: '合成地址', displayName: name, email: `${id}@example.test`, insuranceDisplay: '合成医保', mrn: `SYN-${id}`, nationalId: '320582198803160028', phone: '13800001234' },
    source: { batchId: 'synthetic-batch', batchName: '合成连续办理', format: 'fhir-r4-bundle', hash: 'a'.repeat(64), patientId: id, providerId: 'synthea' },
    case: { activeBriefRevision: 1, caseId: `case-${id}`, caseType: 'new-problem', createdAt: '2026-11-10T09:00:00+08:00', profileId: id, profileRevision: 1,
      revision: 2, sourceHash: 'a'.repeat(64), status: 'brief-ready', updatedAt: '2026-11-10T09:00:00+08:00', visibleHistoryCount: 0, workspaceId: session.actor.workspaceId } })
}
function setup(startGate?: Promise<void>) {
  const patients = [profile('a', '合成连续甲'), profile('b', '合成连续乙'), profile('c', '合成未就绪丙')]
  patients[2]!.case = { ...patients[2]!.case!, activeBriefRevision: null, status: 'brief-pending' }
  const posts: Array<{ caseId: string; body: unknown; key: string | null }> = []
  const detailReads: string[] = []
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (raw: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    if (url.pathname === '/api/auth/context') return Response.json(session)
    if (url.pathname === '/api/sim/v1/synthetic-patients') return Response.json({ page: Number(url.searchParams.get('page') ?? 1), pageSize: 20, total: patients.length,
      items: patients.map(item => ({ profileId: item.profileId, activeVisit: item.case?.status === 'started', batchId: item.source.batchId, batchName: item.source.batchName,
        birthDate: item.birthDate, createdAt: item.createdAt, gender: item.gender, historyCount: 0, mrn: item.identity.mrn, name: item.identity.displayName,
        providerId: 'synthea', revision: item.revision, updatedAt: item.updatedAt })) })
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

async function openLibrary() {
  const libraryTab = screen.queryByRole('tab', { name: '患者库' })
  if (libraryTab !== null) fireEvent.click(libraryTab)
  else {
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(within(await screen.findByRole('menu')).getByText('患者库', { exact: true }))
  }
}
async function startCurrentVisit() {
  fireEvent.click(await screen.findByRole('button', { name: '开始门诊就诊' }))
  const sheet = within(screen.getByRole('dialog', { name: '开始门诊就诊' }))
  const confirm = sheet.getByRole('button', { name: '开始门诊就诊' })
  await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false))
  fireEvent.click(confirm)
}

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
