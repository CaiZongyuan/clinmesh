// @vitest-environment jsdom
import { doctorCaseDetailSchema, imagingRequestSchema, pathologyRequestSchema, type SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDoctorCase } from '../api-client.ts'
import { ImagingPage, useImagingViewState } from './imaging-page.tsx'
import { PathologyPage } from './pathology-page.tsx'

const session: SessionContext = {
  actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor',
    practitionerId: 'practitioner-doctor', organizationId: 'organization-outpatient', locationId: 'location-outpatient', roleCode: 'outpatient-doctor' },
  user: { id: 'account-doctor', name: '合成医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [],
}
const service = { id: 'service-imaging', code: 'SYN-DX', name: '合成胸片', version: 1, bodySite: '胸部', department: '放射科', examCode: 'chest-radiograph',
  method: 'X线摄影', modality: 'DX', applicability: '合成病例检查', reportSections: ['technique', 'findings', 'impression'] }
function facts(pathology = false, count = 3) {
  const requests = Array.from({ length: count }, (_, offset) => offset + 1).map(index => {
    const common = { id: `request-${index}`, previousReports: [], serviceRequestId: `service-request-${index}`, serviceRequestVersion: '1', status: 'issued', taskId: `task-${index}`, taskVersion: '1', version: 1 }
    return pathology ? pathologyRequestSchema.parse({ ...common, purpose: '合成病例核对',
      sourceProcedure: { code: 'SYN-PROCEDURE', display: '合成既往手术', performedAt: '2025-01-01T08:00:00+08:00', sourceReference: 'urn:uuid:synthetic-procedure' },
      service: { id: 'service-pathology', code: 'SYN-PATH', name: `合成会诊${index}`, version: 1, bodySite: '乳腺', department: '病理科', applicability: '合成病例检查', examCode: 'breast-slide-consultation', specimenType: '合成石蜡切片', stain: 'HE', reportSections: ['specimen', 'microscopy', 'diagnosis', 'immunohistochemistry', 'note'] } })
      : imagingRequestSchema.parse({ ...common, service: { ...service, name: `合成胸片${index}` }, indication: '合成病例核对' })
  })
  return doctorCaseDetailSchema.parse({ registrationNumber: null, allergies: [], caseId: 'case-1', consultation: { turns: [], version: 1 },
    encounter: { id: 'encounter-1', versionId: '1', status: 'in-progress' },
    patient: { id: 'patient-1', identifier: 'SYN-1', name: '合成集中办理患者', synthetic: true, versionId: '1' },
    presentation: null, priorFacts: [], status: 'first-visit', taskId: 'case-task', taskVersion: '1',
    ...(pathology ? { pathologyRequests: { draftVersion: 0, requests } } : { imagingRequests: { draftVersion: 0, requests } }) })
}
function server(pathology = false, count = 3) {
  let current = facts(pathology, count)
  const controls = { lossSecond: true, receiptFailure: false, receiptMissing: false, reject: [] as string[] }
  const posts: { key: string; body: unknown; id: string }[] = [], receiptKeys: string[] = []
  const receipts = new Map<string, unknown>()
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/auth/context') return Response.json(session)
    if (path.includes('/command-receipts?')) {
      const key = new URL(path, 'https://example.test').searchParams.get('idempotencyKey')!
      receiptKeys.push(key)
      if (controls.receiptFailure) return Response.json({ error: { code: 'WORKFLOW_CONFLICT', message: '合成回执读取失败' } }, { status: 409 })
      if (controls.receiptMissing) return Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: '合成回执不存在' } }, { status: 404 })
      return Response.json({ operationId: pathology ? 'pathology-request.cancel' : 'imaging-request.cancel', idempotencyKey: key, status: 'completed', response: receipts.get(key) })
    }
    if (path.endsWith('/actions/cancel') && init?.method === 'POST') {
      const id = path.split('/').at(-3)!, key = new Headers(init.headers).get('idempotency-key')!
      const body = JSON.parse(String(init.body))
      posts.push({ key, body, id })
      if (controls.reject.includes(id)) return Response.json({ error: { code: 'WORKFLOW_CONFLICT', message: '合成费用竞争拒绝' } }, { status: 409 })
      const previous = (pathology ? current.pathologyRequests!.requests : current.imagingRequests!.requests).find(item => item.id === id)!
      expect(body).toEqual({ expectedVersions: { [`ServiceRequest/${previous.serviceRequestId}`]: '1', [`Task/${previous.taskId}`]: '1' },
        input: { expectedRequestVersion: 1, reasonCode: 'no-longer-needed' } })
      const request = (pathology ? pathologyRequestSchema : imagingRequestSchema).parse({ ...previous, status: 'cancelled', version: 2, serviceRequestVersion: '2', taskVersion: '2' })
      current = doctorCaseDetailSchema.parse(pathology ? { ...current, pathologyRequests: { ...current.pathologyRequests, requests: current.pathologyRequests!.requests.map(item => item.id === id ? request : item) } }
        : { ...current, imagingRequests: { ...current.imagingRequests, requests: current.imagingRequests!.requests.map(item => item.id === id ? request : item) } })
      const response = { auditId: `audit-${id}`, requestId: `command-${id}`, warnings: [], effects: [
        { kind: 'updated', reference: `ServiceRequest/${previous.serviceRequestId}`, versionId: '2' },
        { kind: 'updated', reference: `Task/${previous.taskId}`, versionId: '2' },
      ], data: { request } }
      receipts.set(key, response)
      if (controls.lossSecond && id === 'request-2') throw new TypeError('synthetic committed response loss')
      return Response.json(response)
    }
    if (path.endsWith('/imaging-services')) return Response.json({ items: [{ available: true, service }] })
    if (path.endsWith('/pathology-services')) return Response.json({ items: [] })
    if (path.includes('/recommendations/')) return Response.json({ caseId: 'case-1', kind: pathology ? 'pathology' : 'imaging', encounterId: 'encounter-1', encounterVersion: '1',
      inputFingerprint: 'a'.repeat(64), status: 'ready', generation: 1, missingInformation: [], stale: false, guidelines: [], caseEvidence: [], items: [] })
    if (path.endsWith('/doctor/cases/case-1')) return Response.json(current)
    throw new Error(`Unexpected ${init?.method ?? 'GET'} ${path}`)
  }))
  return { posts, receiptKeys, controls, facts: () => current, update: (value: unknown) => { current = doctorCaseDetailSchema.parse(value) } }
}
function Harness({ pathology = false }: { pathology?: boolean }) {
  const detail = useQuery({ queryKey: ['doctor-case', 'case-1'], queryFn: () => getDoctorCase('case-1') })
  const view = useImagingViewState('case-1')
  if (!detail.data) return null
  const props = { actions: { canCorrect: false, onChanged: () => detail.refetch(), view }, caseId: 'case-1', elementId: 'imaging',
    encounter: detail.data.encounter, locale: 'zh-CN' as const, readOnly: false, state: detail.data.imagingRequests,
    actionContext: { session, caseId: 'case-1', patientId: 'patient-1', encounterId: 'encounter-1', patientName: '合成集中办理患者', onChanged: () => detail.refetch() } }
  return pathology ? <PathologyPage {...props} state={detail.data.pathologyRequests} /> : <ImagingPage {...props} />
}
function mount(pathology = false) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><Harness pathology={pathology} /></QueryClientProvider>)
}
beforeEach(() => {
  sessionStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

it('已知现金全额或部分收款仍可临床取消，未知资金阻写，预览明确退款责任另办', async () => {
  const api = server(), user = userEvent.setup()
  api.controls.lossSecond = false
  api.update({ ...api.facts(), imagingRequests: { ...api.facts().imagingRequests, requests: api.facts().imagingRequests!.requests.map((request, index) => ({ ...request,
    billing: { chargeItemId: `charge-${index}`, insuranceFen: 0, paidFen: index === 0 ? 1000 : 500, remainingFen: index === 0 ? 0 : 500,
      price: { currency: 'CNY', effectiveOn: '2026-01-01', id: 'price-synthetic', priceFen: 1000, source: 'synthetic-price', unit: '项', version: 1 },
      quantity: 1, status: index === 0 ? 'paid' : index === 1 ? 'partial' : 'ambiguous' },
  })) } })
  mount()
  for (const index of [1, 2]) {
    const checkbox = await screen.findByRole('checkbox', { name: `选择取消：合成胸片${index}` })
    expect(checkbox.getAttribute('aria-disabled')).not.toBe('true')
    await user.click(checkbox)
  }
  expect(screen.getByRole('checkbox', { name: '选择取消：合成胸片3' }).getAttribute('aria-disabled')).toBe('true')
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  const preview = screen.getByRole('dialog', { name: '集中取消申请核对' })
  expect(preview.textContent).toContain('退款须按原交易另行办理')
  await user.click(within(preview).getByRole('button', { name: '确认取消申请' }))
  await waitFor(() => expect(screen.getByRole('region', { name: '取消申请逐项结果' }).textContent).toContain('成功 2/2'))
  expect(api.posts.map(item => item.id)).toEqual(['request-1', 'request-2'])
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it.each([false, true])('同类三申请集中取消逐项保留成功；第二项丢回执后停止、刷新原键恢复，余项重新核对（病理=%s）', async pathology => {
  const api = server(pathology), first = mount(pathology), user = userEvent.setup()
  for (const index of [1, 2, 3]) await user.click(await screen.findByRole('checkbox', { name: `选择取消：合成${pathology ? '会诊' : '胸片'}${index}` }))
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  const preview = screen.getByRole('dialog', { name: '集中取消申请核对' })
  expect(within(preview).getAllByRole('article')).toHaveLength(3)
  expect(preview.textContent).toContain('不再需要')
  expect(preview.textContent).toContain('取消不等于退款')
  await user.click(within(preview).getByRole('button', { name: '确认取消申请' }))
  await screen.findByRole('button', { name: '恢复原取消' })
  expect(api.posts.map(item => item.id)).toEqual(['request-1', 'request-2'])
  first.unmount()
  mount(pathology)
  await user.click(await screen.findByRole('button', { name: '恢复原取消' }))
  await waitFor(() => expect(api.receiptKeys).toEqual([api.posts[1]!.key]))
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原取消' })).toBeNull())
  expect(api.posts).toHaveLength(2)
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  const remaining = screen.getByRole('dialog', { name: '集中取消申请核对' })
  expect(within(remaining).getAllByRole('article')).toHaveLength(1)
  await user.click(within(remaining).getByRole('button', { name: '确认取消申请' }))
  await waitFor(() => expect((pathology ? api.facts().pathologyRequests!.requests : api.facts().imagingRequests!.requests).every(item => item.status === 'cancelled')).toBe(true))
  await waitFor(() => expect(screen.getByRole('region', { name: '取消申请逐项结果' }).textContent).toContain('成功 1/1'))
  expect(api.posts.map(item => item.id)).toEqual(['request-1', 'request-2', 'request-3'])
  expect(new Set(api.posts.map(item => item.key)).size).toBe(3)
})
