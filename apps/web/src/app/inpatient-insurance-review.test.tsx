// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InpatientInsuranceReview } from './inpatient-insurance-review.tsx'

const session: SessionContext = { actor: { actorId: 'insurer', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-insurer', roleCode: 'medical-insurance' }, user: { id: 'insurer', name: '医保办', email: 'insurer@demo.clinmesh.local' }, availableRoles: [] }
const items = Array.from({ length: 12 }, (_, index) => inpatientAdmissionSchema.parse({
  id: `admission-${index + 1}`, patientId: `patient-${index + 1}`, patientName: `合成归档医保${String(index + 1).padStart(2, '0')}`, inpatientNumber: `ZY-${index + 1}`,
  admissionRoute: 'direct', wardId: 'ward-general', organizationId: 'org-inpatient', status: 'cleared', financialStatus: 'settled', recordStatus: 'archived',
  registeredAt: '2026-11-03T09:00:00+08:00', depositFen: 0, chargesFen: 5000, versionId: '2',
}))
function syntheticReview(admissionId: string) {
  return { id: 'review-1', admissionId, archiveSourcesHash: 'a'.repeat(64), recordRevision: 1, frozenRulesId: 'synthetic-rules', frozenRulesVersion: '1', frozenResultHash: 'b'.repeat(64),
    drgCode: 'FM39', parameterSetId: 'synthetic-parameters', parameterVersion: '1', simulatedPaymentFen: 1200000, hospitalChargesFen: 5000, differenceFen: 1195000, note: '合成核定', reason: '合成核定说明', reviewedAt: '2026-11-04T10:05:00+08:00' }
}
const clients: QueryClient[] = []
beforeEach(() => { sessionStorage.clear(); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals() })

function stubQueue(failedId?: string, indexed = () => items) {
  const reads: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: indexed() })
    const match = path.match(/\/admissions\/([^/]+)\/drg\/payer-reviews$/)
    if (match) {
      const id = match[1]!
      reads.push(id)
      return id === failedId ? Response.json({ error: { code: 'SYNTHETIC_READ_FAILURE', message: '合成核定状态读取失败' } }, { status: 503 }) : Response.json({ admissionId: id, reviews: [] })
    }
    return Response.json({ error: { code: 'SYNTHETIC_DETAIL_UNAVAILABLE', message: '合成详情不参与队列读取计数' } }, { status: 503 })
  }))
  return reads
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  const view = (currentSession: SessionContext) => <QueryClientProvider client={client}><InpatientInsuranceReview session={currentSession} locale="zh-CN" /></QueryClientProvider>
  const mounted = render(view(session))
  return { ...mounted, client, changeSession: (next: SessionContext) => mounted.rerender(view(next)) }
}

it('核定队列每页最多读取10份归档状态，显式翻页才读取其他病案', async () => {
  const reads = stubQueue()
  mount()
  const queue = await screen.findByRole('region', { name: '核定队列' })
  await within(queue).findByRole('button', { name: /合成归档医保10/ })
  expect(new Set(reads).size).toBe(10)
  expect(reads).not.toContain('admission-11')
  expect(within(queue).getAllByRole('button', { name: /合成归档医保/ })).toHaveLength(10)
  expect(within(queue).getByText('核定分组与计数仅限本页病案')).toBeDefined()
  await userEvent.setup().click(within(queue).getByRole('button', { name: '下一页' }))
  await within(queue).findByRole('button', { name: /合成归档医保12/ })
  expect(new Set(reads).size).toBe(12)
  expect(within(queue).getAllByRole('button', { name: /合成归档医保/ })).toHaveLength(2)
  expect(within(queue).getByRole('button', { name: '下一页' }).hasAttribute('disabled')).toBe(true)
})

it('本页核定状态读取失败保持未知，不计入未核定或已核定', async () => {
  stubQueue('admission-2')
  mount()
  const queue = await screen.findByRole('region', { name: '核定队列' })
  await waitFor(() => expect(within(queue).getByRole('alert').textContent).toContain('核定状态读取失败'))
  expect(within(within(queue).getByRole('region', { name: '已归档病案' })).queryByRole('button', { name: /合成归档医保02/ })).toBeNull()
  expect(within(within(queue).getByRole('region', { name: '已核定' })).queryByRole('button', { name: /合成归档医保02/ })).toBeNull()
  expect(within(queue).getByRole('button', { name: '重试核定状态' })).toBeDefined()
})

it('恢复完成导航后，队列读取失败不继续宣称本页完成，重试成功才恢复提示', async () => {
  const binding = { accountId: session.user.id, actor: sessionContextSchema.shape.actor.parse(session.actor) }
  sessionStorage.setItem('clinmesh.inpatient-review-queue:v1:' + encodeURIComponent(JSON.stringify([binding, 'admission-1', 'inpatient.drg.payer.review'])), JSON.stringify({
    version: 1, binding, sourceId: 'admission-1', operation: 'inpatient.drg.payer.review', signature: 'original-command',
    filter: 'unassessed', page: 1, queue: ['admission-1'], complete: true,
  }))
  let fail = false
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: items.slice(0, 1) })
    if (path.endsWith('/drg/payer-reviews')) return fail
      ? Response.json({ error: { code: 'SYNTHETIC_READ_FAILURE', message: '合成核定状态读取失败' } }, { status: 503 })
      : Response.json({ admissionId: 'admission-1', reviews: [syntheticReview('admission-1')] })
    return Response.json({ error: { code: 'SYNTHETIC_DETAIL_UNAVAILABLE', message: '合成详情不参与队列读取' } }, { status: 503 })
  }))
  const { client } = mount()
  const completed = () => screen.queryAllByRole('status').filter(element => element.textContent === '本页核定已完成')
  await waitFor(() => expect(completed()).toHaveLength(1))
  fail = true
  await client.invalidateQueries({ queryKey: ['inpatient'] })
  const queue = screen.getByRole('region', { name: '核定队列' })
  await waitFor(() => expect(within(queue).getByRole('alert').textContent).toContain('核定状态读取失败'))
  expect(completed()).toHaveLength(0)
  expect(screen.getByRole('region', { name: '当前住院患者' }).textContent).toContain('合成归档医保01')
  fail = false
  await userEvent.setup().click(within(queue).getByRole('button', { name: '重试核定状态' }))
  await waitFor(() => expect(completed()).toHaveLength(1))
})

it('具名核定目标暂读失败可原名重试，确定失格后须显式重选同页下一份', async () => {
  const binding = { accountId: session.user.id, actor: sessionContextSchema.shape.actor.parse(session.actor) }
  const [first, second, third] = items
  sessionStorage.setItem('clinmesh.inpatient-review-queue:v1:' + encodeURIComponent(JSON.stringify([binding, first!.id, 'inpatient.drg.payer.review'])), JSON.stringify({
    version: 1, binding, sourceId: first!.id, operation: 'inpatient.drg.payer.review', signature: 'original-command',
    filter: 'unassessed', page: 1, queue: items.slice(0, 10).map(item => item.id), complete: true,
    target: { id: second!.id, patientId: second!.patientId, patientName: second!.patientName, versionId: second!.versionId },
  }))
  const reads: string[] = [], posts: string[] = []
  let conflict = false
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    if (options?.method === 'POST') posts.push(path)
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items })
    const match = path.match(/\/admissions\/([^/]+)\/drg\/(payer-reviews|payer-review-preview)$/)
    if (match) {
      const id = match[1]!
      reads.push(id)
      if (match[2] === 'payer-reviews') return Response.json({ admissionId: id, reviews: id === first!.id ? [syntheticReview(id)] : [] })
      if (id === second!.id) return Response.json({ error: { code: conflict ? 'DRG_PAYMENT_PARAMETER_MISSING' : 'SYNTHETIC_READ_FAILURE', message: '合成核定预览不可用' } }, { status: conflict ? 409 : 503 })
      return Response.json({ admissionId: id, encounterVersion: '2', fingerprint: 'a'.repeat(64), archiveSourcesHash: 'b'.repeat(64), frozenResultHash: 'c'.repeat(64),
        drgCode: 'FM39', parameterSetId: 'synthetic-parameters', parameterVersion: '1', simulatedPaymentFen: 6000, hospitalChargesFen: 5000, differenceFen: 1000, note: '合成核定',
        caseSummary: { recordRevision: 1, rulesId: 'synthetic-rules', rulesVersion: '1', inputCoding: 'nhc-icd10-clinical@2022.r4', codingNote: '合成病例',
          groupingInput: { diagnoses: [], operations: [], gender: 'female', ageYears: 46, ageDays: null, birthWeightGrams: null, dischargeMode: 'home', inpatientDays: 1 }, diagnoses: [], operations: [] } })
    }
    return Response.json({ error: { code: 'SYNTHETIC_DETAIL_UNAVAILABLE', message: '合成详情不参与交接' } }, { status: 503 })
  }))
  mount()
  const user = userEvent.setup()
  const secondName = `下一份：${second!.patientName}`, thirdName = `下一份：${third!.patientName}`
  await user.click(await screen.findByRole('button', { name: secondName }))
  await screen.findByText('目标病案暂时无法确认，请重试')
  expect(screen.queryByRole('button', { name: '刷新队列并重选下一份' })).toBeNull()
  conflict = true
  await user.click(screen.getByRole('button', { name: secondName }))
  await screen.findByText('目标病案状态已变化，请刷新队列后重新选择')
  expect(screen.queryByRole('button', { name: thirdName })).toBeNull()
  const current = () => screen.getByRole('region', { name: '当前住院患者' }).textContent
  expect(current()).toContain(first!.patientName)
  await user.click(screen.getByRole('button', { name: '刷新队列并重选下一份' }))
  const replacement = await screen.findByRole('button', { name: thirdName })
  expect(current()).toContain(first!.patientName)
  await user.click(replacement)
  await waitFor(() => expect(current()).toContain(third!.patientName))
  expect(new Set(reads).size).toBe(10)
  expect(posts).toEqual([])
})

it('恢复原核定时的确定拒绝只提示在原病例，手动切换后不串到新病例', async () => {
  const binding = { accountId: session.user.id, actor: sessionContextSchema.shape.actor.parse(session.actor) }
  const original = items[1]!, next = items[0]!
  sessionStorage.setItem('clinmesh.inpatient-intent:v1:' + encodeURIComponent(JSON.stringify(binding)), JSON.stringify({
    version: 1, binding, idempotencyKey: '5dbf002c-de9b-4ebd-9751-189522e24c65', command: { operation: 'inpatient.drg.payer.review',
      input: { admissionId: original.id, encounterVersion: '2', expectedFingerprint: 'a'.repeat(64), reason: '合成原核定说明' } },
  }))
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    if (path.endsWith('/auth/context')) return Response.json(session)
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: items.slice(0, 2) })
    if (path.includes('/command-receipts?')) return Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: '合成回执缺失' } }, { status: 404 })
    if (options?.method === 'POST' && path.endsWith('/drg/payer-review')) {
      calls.push(path)
      return Response.json({ error: { code: 'INPATIENT_DRG_PAYER_PREVIEW_STALE', message: '合成原核定依据已变化' } }, { status: 409 })
    }
    const match = path.match(/\/admissions\/([^/]+)\/drg\/payer-reviews$/)
    if (match) return Response.json({ admissionId: match[1], reviews: [] })
    return Response.json({ error: { code: 'SYNTHETIC_DETAIL_UNAVAILABLE', message: '合成详情不参与原核定恢复' } }, { status: 503 })
  }))
  mount()
  const user = userEvent.setup(), rejected = '诊疗、费用或目录已变化，请刷新依据并重新审阅后提交。'
  await user.click(await screen.findByRole('button', { name: '恢复原住院操作' }))
  await screen.findByText(rejected)
  expect(screen.getByRole('region', { name: '当前住院患者' }).textContent).toContain(original.patientName)
  expect(calls).toEqual([`/api/his/v1/inpatient/admissions/${original.id}/drg/payer-review`])
  await user.click(await screen.findByRole('button', { name: new RegExp(next.patientName) }))
  expect(screen.getByRole('region', { name: '当前住院患者' }).textContent).toContain(next.patientName)
  expect(screen.queryByText(rejected)).toBeNull()
})

it.each(['actorId', 'workspaceId', 'epoch'] as const)('%s变化后不带入旧身份的核定页码或初选', async dimension => {
  stubQueue()
  const mounted = mount()
  const user = userEvent.setup()
  await screen.findByRole('button', { name: /合成归档医保10/ })
  await user.click(screen.getByRole('button', { name: '下一页' }))
  await screen.findByRole('button', { name: /合成归档医保12/ })
  mounted.changeSession({ ...session, actor: { ...session.actor, [dimension]: `${session.actor[dimension]}-other` } })
  await screen.findByRole('button', { name: /合成归档医保01/ })
  expect(screen.getByText('1 / 2')).toBeDefined()
  expect(screen.queryByRole('button', { name: /合成归档医保12/ })).toBeNull()
})

it('新增归档改变页边界后保留已选病例，人工翻页才重新初选', async () => {
  let indexed = items
  stubQueue(undefined, () => indexed)
  const { client } = mount()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /合成归档医保10/ }))
  const header = screen.getByRole('region', { name: '当前住院患者' })
  expect(header.textContent).toContain('合成归档医保10')
  indexed = [inpatientAdmissionSchema.parse({ ...items[0], id: 'new-admission', patientId: 'new-patient', patientName: '合成新归档医保' }), ...items]
  await client.invalidateQueries({ queryKey: ['inpatient'] })
  await screen.findByRole('button', { name: /合成新归档医保/ })
  expect(header.textContent).toContain('合成归档医保10')
  expect(screen.queryByRole('button', { name: /合成归档医保10/ })).toBeNull()
  await user.click(screen.getByRole('button', { name: '下一页' }))
  await waitFor(() => expect(header.textContent).toContain('合成归档医保10'))
})

it('单页核定队列不显示分页说明，行内标明待核定或已核定病组与核定时间', async () => {
  const review = syntheticReview('admission-2')
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: items.slice(0, 2) })
    const match = path.match(/\/admissions\/([^/]+)\/drg\/payer-reviews$/)
    if (match) return Response.json({ admissionId: match[1], reviews: match[1] === 'admission-2' ? [review] : [] })
    return Response.json({ error: { code: 'SYNTHETIC_DETAIL_UNAVAILABLE', message: '合成详情不参与队列读取计数' } }, { status: 503 })
  }))
  mount()
  const queue = await screen.findByRole('region', { name: '核定队列' })
  const assessed = await within(queue).findByRole('button', { name: /合成归档医保02/ })
  expect(assessed.textContent).toContain('已核定')
  expect(assessed.textContent).toContain('FM39 · 11-04 10:05 核定')
  expect(within(queue).getByRole('button', { name: /合成归档医保01/ }).textContent).toContain('待核定')
  expect(within(queue).queryByText('核定分组与计数仅限本页病案')).toBeNull()
})
