// @vitest-environment jsdom
import { doctorCaseDetailSchema, laboratoryRequestSchema, type SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDoctorCase } from '../api-client.ts'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { LaboratoryPage } from './laboratory-page.tsx'

const session: SessionContext = {
  actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor',
    practitionerId: 'practitioner-doctor', organizationId: 'organization-outpatient', locationId: 'location-outpatient', roleCode: 'outpatient-doctor' },
  user: { id: 'account-doctor', name: '合成医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [],
}
function server() {
  let detail = doctorCaseDetailSchema.parse({ registrationNumber: null, allergies: [], caseId: 'case-1', consultation: { turns: [], version: 1 },
    encounter: { id: 'encounter-1', versionId: '1', status: 'in-progress' },
    patient: { id: 'patient-1', identifier: 'SYN-1', name: '合成检验患者', synthetic: true, versionId: '1' },
    presentation: null, priorFacts: [], status: 'first-visit', taskId: 'case-task', taskVersion: '1',
    laboratoryRequests: { draftVersion: 0, reportingSupported: true, requests: [1, 2, 3].map(index => laboratoryRequestSchema.parse({
      id: `request-${index}`, catalogItemId: `synthetic-lab-${index}`, indicationCode: 'clinical-evaluation',
      referenceConcept: { id: `synthetic-reference-${index}`, code: `SYN-${index}`, display: `合成检验${index}`, system: 'urn:synthetic:lab', version: '1', sourceLocator: 'synthetic:test' },
      previousReports: [], serviceRequestId: `service-request-${index}`, serviceRequestVersion: '1', status: 'generation-failed',
      generationError: { code: index === 3 ? 'INVESTIGATION_UNSUPPORTED' : 'PROVIDER_TEMPORARY_FAILURE', message: '合成失败' },
      taskId: `task-${index}`, taskVersion: '1', version: 1,
    })) } })
  const posts: { id: string; key: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/doctor/cases/case-1')) return Response.json(detail)
    if (path.endsWith('/actions/retry-generation') && init?.method === 'POST') {
      const id = path.split('/').at(-3)!, key = new Headers(init.headers).get('idempotency-key')!
      posts.push({ id, key })
      const previous = detail.laboratoryRequests!.requests.find(item => item.id === id)!
      expect(JSON.parse(String(init.body))).toEqual({ expectedVersions: { [`Task/${previous.taskId}`]: '1' }, input: { expectedRequestVersion: 1 } })
      const request = laboratoryRequestSchema.parse({ ...previous, status: 'in-progress', generationError: undefined, version: 2, taskVersion: '2' })
      detail = doctorCaseDetailSchema.parse({ ...detail, laboratoryRequests: { ...detail.laboratoryRequests, requests: detail.laboratoryRequests!.requests.map(item => item.id === id ? request : item) } })
      return Response.json({ auditId: `audit-${id}`, requestId: `command-${id}`, warnings: [], effects: [
        { kind: 'updated', reference: `Task/${previous.taskId}`, versionId: '2' },
      ], data: { request } })
    }
    if (path.includes('/recommendations/')) return Response.json({ caseId: 'case-1', kind: 'laboratory', encounterId: 'encounter-1', encounterVersion: '1',
      inputFingerprint: 'a'.repeat(64), status: 'ready', generation: 1, missingInformation: [], stale: false, guidelines: [], caseEvidence: [], items: [] })
    throw new Error(`Unexpected ${init?.method ?? 'GET'} ${path}`)
  }))
  return { posts, facts: () => detail }
}
function Harness() {
  const detail = useQuery({ queryKey: ['doctor-case', 'case-1'], queryFn: () => getDoctorCase('case-1') })
  if (!detail.data) return null
  const unused = () => { throw new Error('Unrelated legacy action') }
  const action = { error: null, onSubmit: unused, pending: false }
  const props = { actions: { acknowledge: action, cancel: action, correct: { ...action, allowed: false }, deleteDraft: action, issue: action, retry: action, save: action },
    catalogError: null, catalogPending: false, detail: detail.data, elementId: 'laboratory', indicationCode: '', issueLegacyOrderError: null, issueLegacyOrderPending: false,
    laboratoryCatalog: [], laboratoryItemId: '', locale: 'zh-CN' as const, messages: getWorkspaceMessages('zh-CN'),
    onIndicationChange: unused, onIssueLegacyOrder: unused, onLaboratoryItemChange: unused, readOnly: false, showCorrection: false,
    referenceSearch: { data: undefined, error: null, isError: false, isFetching: false, isPending: false, onSearch: unused },
    actionContext: { session, caseId: 'case-1', patientId: 'patient-1', encounterId: 'encounter-1', patientName: '合成检验患者', onChanged: () => detail.refetch() } }
  return <LaboratoryPage {...props} />
}
beforeEach(() => { sessionStorage.clear(); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('检验集中重试只选可重试项目，与取消清单分别核对并逐项使用原重试Command', async () => {
  const api = server(), user = userEvent.setup()
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Harness /></QueryClientProvider>)
  const unsupported = await screen.findByRole('checkbox', { name: '选择重试：合成检验3' })
  expect(unsupported.getAttribute('aria-disabled')).toBe('true')
  await user.click(screen.getByRole('button', { name: '全选本页可重试申请' }))
  await user.click(screen.getByRole('button', { name: '集中重试申请' }))
  const preview = screen.getByRole('dialog', { name: '集中重试申请核对' })
  expect(within(preview).getAllByRole('article')).toHaveLength(2)
  expect(screen.queryByRole('dialog', { name: '集中取消申请核对' })).toBeNull()
  await user.click(within(preview).getByRole('button', { name: '确认重试申请' }))
  await waitFor(() => expect(screen.getByRole('region', { name: '重试申请逐项结果' }).textContent).toContain('成功 2/2'))
  expect(api.posts.map(item => item.id)).toEqual(['request-1', 'request-2'])
  expect(new Set(api.posts.map(item => item.key)).size).toBe(2)
  expect(api.facts().laboratoryRequests!.requests.map(item => item.status)).toEqual(['in-progress', 'in-progress', 'generation-failed'])
})
