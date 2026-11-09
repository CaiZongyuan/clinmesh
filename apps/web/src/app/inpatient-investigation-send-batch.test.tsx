// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { LaboratoryRequest, SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InpatientInvestigations } from './inpatient-investigations.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientActionOutlet, InpatientActionProvider } from './inpatient-workspace-actions.tsx'

const nurse: SessionContext = {
  actor: { actorId: 'actor-nurse', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'scenario-run-1', practitionerRoleId: 'role-nurse', roleCode: 'ward-nurse' },
  user: { id: 'user-nurse', name: '合成护士', email: 'ward-nurse@demo.clinmesh.local' }, availableRoles: [],
}
const admission = inpatientAdmissionSchema.parse({
  id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-0001', admissionRoute: 'direct', wardId: 'ward-general',
  organizationId: 'organization-inpatient', status: 'admitted', financialStatus: 'open', recordStatus: 'open',
  registeredAt: '2026-08-24T09:00:00+08:00', depositFen: 0, chargesFen: 0, versionId: '2',
})

function laboratory(index: number, name: string, status: LaboratoryRequest['status'] = 'issued') {
  const referenceConcept = { id: `laboratory-${index}`, code: `synthetic-${index}`, display: name, system: 'https://example.test/laboratory', version: '1', sourceLocator: 'synthetic-fixture' }
  return {
    id: `request-${index}`, catalogItemId: `laboratory-${index}`, indicationCode: 'screening', serviceRequestId: `service-request-${index}`,
    serviceRequestVersion: '1', taskId: `task-${index}`, taskVersion: '1', status, version: 1, referenceConcept,
    laboratoryService: {
      allowedIndicationCodes: ['screening'], componentServiceIds: [], doctorOrderable: true, executingDepartmentId: 'department-laboratory',
      id: `laboratory-${index}`, localCode: `synthetic-${index}`, nameZh: name, priceFen: 1000, referenceConcept, referenceReleaseId: 'synthetic-release',
      reportDefinition: { conclusionTemplate: '合成检验结论', results: [{ referenceConcept, referenceRange: { text: '合成正常' }, valueType: 'boolean', allowedValues: [false, true] }] },
      specimen: { code: 'whole-blood', display: '合成全血', system: 'https://example.test/specimen' }, serviceKind: 'laboratory', tatMinutes: 30, version: 1,
    },
  }
}

type Post = { requestId: string; key: string | null; body: unknown }

function server(requests = [laboratory(1, '合成白细胞计数'), laboratory(2, '合成血红蛋白'), laboratory(3, '合成血小板计数')]) {
  let facts = inpatientInvestigationsSchema.parse({ admissionId: admission.id, laboratoryRequests: requests, imagingRequests: [], sent: [] })
  const posts: Post[] = []
  const receiptKeys: string[] = []
  const receipts = new Map<string, unknown>()
  let loseResponseFor: string | undefined
  const envelope = () => ({ auditId: 'synthetic-audit', requestId: 'synthetic-command', effects: [], warnings: [], data: facts })
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/auth/context') return Response.json(nurse)
    if (path.startsWith('/api/his/v1/command-receipts?')) {
      const query = new URL(path, 'https://example.test').searchParams
      const key = query.get('idempotencyKey')!
      receiptKeys.push(key)
      expect(query.get('operationId')).toBe('inpatient.investigation.send')
      const response = receipts.get(key)
      return response === undefined
        ? Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: '合成回执不存在' } }, { status: 404 })
        : Response.json({ operationId: 'inpatient.investigation.send', idempotencyKey: key, status: 'completed', response })
    }
    if (init?.method === 'POST' && path.endsWith('/investigations/send')) {
      const body = JSON.parse(String(init.body)) as { input: { requestId: string } }
      const key = new Headers(init.headers).get('idempotency-key')
      posts.push({ requestId: body.input.requestId, key, body })
      if (!facts.sent.some(item => item.requestId === body.input.requestId)) {
        facts = inpatientInvestigationsSchema.parse({ ...facts, sent: [...facts.sent, { requestId: body.input.requestId, sentAt: '2026-08-24T09:10:00+08:00', sentBy: nurse.actor.actorId }] })
      }
      const response = envelope()
      receipts.set(key!, response)
      if (body.input.requestId === loseResponseFor) throw new TypeError('synthetic committed response loss')
      return Response.json(response)
    }
    if (path.endsWith('/investigations')) return Response.json(facts)
    throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${path}`)
  }))
  return { posts, receiptKeys, facts: () => facts, loseResponse: (requestId: string) => { loseResponseFor = requestId } }
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  function Subject() {
    const write = useInpatientWriteIntent(nurse, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <InpatientActionProvider stage="investigations">
      <InpatientInvestigations admission={admission} session={nurse} locale="zh-CN" write={write} />
      <aside aria-label="底部操作"><InpatientActionOutlet /></aside>
    </InpatientActionProvider>
  }
  const mounted = render(<QueryClientProvider client={client}><Subject /></QueryClientProvider>)
  return { ...mounted, refresh: () => client.invalidateQueries({ queryKey: ['inpatient'] }) }
}

beforeEach(() => sessionStorage.clear())
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('集中送检逐项结算；响应丢失后刷新只恢复原项，剩余申请须重新核对再发送', async () => {
  const api = server()
  api.loseResponse('request-2')
  const first = mount()
  const user = userEvent.setup()
  for (const name of ['合成白细胞计数', '合成血红蛋白', '合成血小板计数']) {
    await user.click(await screen.findByRole('checkbox', { name: `选择送检：${name}` }))
  }
  await user.click(screen.getByRole('button', { name: '集中送检' }))
  let preview = screen.getByRole('dialog', { name: '集中送检核对' })
  expect(preview.textContent).toContain('合成全血')
  expect(preview.textContent).toContain('检验')
  expect(preview.textContent).toContain('待送检')
  await user.click(within(preview).getByRole('button', { name: '确认送检' }))
  await waitFor(() => expect(api.posts.map(post => post.requestId)).toEqual(['request-1', 'request-2']))
  const results = await screen.findByRole('region', { name: '送检逐项结果' })
  expect(results.textContent).toContain('合成白细胞计数')
  expect(results.textContent).toMatch(/成功|已送检/)
  expect(results.textContent).toContain('合成血红蛋白')
  await screen.findByRole('button', { name: '恢复原送检' })
  first.unmount()

  mount()
  await user.click(await screen.findByRole('button', { name: '恢复原送检' }))
  await waitFor(() => expect(api.receiptKeys).toEqual([api.posts[1]!.key]))
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原送检' })).toBeNull())
  expect(api.posts.map(post => post.requestId)).toEqual(['request-1', 'request-2'])
  expect(api.facts().sent.map(item => item.requestId)).toEqual(['request-1', 'request-2'])
  expect(api.facts().laboratoryRequests.map(request => [request.status, request.version])).toEqual([['issued', 1], ['issued', 1], ['issued', 1]])

  await user.click(screen.getByRole('button', { name: '集中送检' }))
  preview = screen.getByRole('dialog', { name: '集中送检核对' })
  expect(preview.textContent).toContain('合成血小板计数')
  expect(api.posts).toHaveLength(2)
  await user.click(within(preview).getByRole('button', { name: '确认送检' }))
  await waitFor(() => expect(api.posts.map(post => post.requestId)).toEqual(['request-1', 'request-2', 'request-3']))
  expect(new Set(api.posts.map(post => post.key)).size).toBe(3)
  await waitFor(() => expect(api.facts().sent).toHaveLength(3))
})
