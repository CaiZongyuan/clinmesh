// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
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

function fixture(count = 2) {
  let facts = inpatientInvestigationsSchema.parse({ admissionId: admission.id, laboratoryRequests: Array.from({ length: count }, (_, index) => makeRequest(index + 1)), imagingRequests: [], sent: [] })
  const posts: { path: string; key: string | null; input: { requestId: string } }[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/investigation-catalog')) return Response.json({ items: [] })
    if (path.endsWith('/investigations')) return Response.json(facts)
    if (init?.method === 'POST') {
      const { input } = JSON.parse(String(init.body))
      posts.push({ path, key: new Headers(init.headers).get('idempotency-key'), input })
      const original = facts.laboratoryRequests.find(item => item.id === input.requestId)!
      facts = { ...facts, laboratoryRequests: facts.laboratoryRequests.map(item => item.id === input.requestId ? {
        ...item, status: 'cancelled', version: item.version + 1, serviceRequestVersion: String(Number(item.serviceRequestVersion) + 1), taskVersion: String(Number(item.taskVersion) + 1),
      } : item) }
      return Response.json({ auditId: 'audit-synthetic', requestId: 'http-synthetic', warnings: [], effects: [
        { kind: 'updated', reference: `ServiceRequest/${original.serviceRequestId}`, versionId: String(Number(original.serviceRequestVersion) + 1) },
        { kind: 'updated', reference: `Task/${original.taskId}`, versionId: String(Number(original.taskVersion) + 1) },
      ], data: facts })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  function Content() {
    const write = useInpatientWriteIntent(session, async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
    return <InpatientInvestigations admission={admission} session={session} locale="zh-CN" write={write} />
  }
  const mount = () => render(<QueryClientProvider client={client}><Content /></QueryClientProvider>)
  return { mount, posts, read: () => facts, update: (value: Facts) => { facts = value }, client }
}

beforeEach(() => {
  sessionStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
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
