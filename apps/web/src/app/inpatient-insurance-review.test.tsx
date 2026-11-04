// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InpatientInsuranceReview } from './inpatient-insurance-review.tsx'

const session: SessionContext = { actor: { actorId: 'insurer', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-insurer', roleCode: 'medical-insurance' }, user: { id: 'insurer', name: '医保办', email: 'insurer@demo.clinmesh.local' }, availableRoles: [] }
const items = Array.from({ length: 12 }, (_, index) => inpatientAdmissionSchema.parse({
  id: `admission-${index + 1}`, patientId: `patient-${index + 1}`, patientName: `合成归档医保${String(index + 1).padStart(2, '0')}`, inpatientNumber: `ZY-${index + 1}`,
  admissionRoute: 'direct', wardId: 'ward-general', organizationId: 'org-inpatient', status: 'cleared', financialStatus: 'settled', recordStatus: 'archived',
  registeredAt: '2026-11-03T09:00:00+08:00', depositFen: 0, chargesFen: 5000, versionId: '2',
}))
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
