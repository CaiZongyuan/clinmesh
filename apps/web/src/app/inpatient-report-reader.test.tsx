// @vitest-environment jsdom
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientInvestigationResponseSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiGet } from './api-client.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientReportReader } from './inpatient-report-reader.tsx'

vi.setConfig({ testTimeout: 15_000 })
const session: SessionContext = { actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1',
  scenarioRunId: 'scenario-run-1', practitionerRoleId: 'role-doctor', practitionerId: 'practitioner-doctor', roleCode: 'inpatient-doctor', locationId: 'doctor-room' },
  user: { id: 'user-doctor', name: '合成住院医生', email: 'inpatient-doctor@demo.clinmesh.local' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成报告患者', inpatientNumber: 'ZY-SYNTHETIC',
  admissionRoute: 'direct', wardId: 'ward-general', organizationId: 'organization-inpatient', status: 'admitted', financialStatus: 'open', recordStatus: 'open',
  registeredAt: '2026-08-24T09:00:00+08:00', admittedAt: '2026-08-24T09:10:00+08:00', depositFen: 0, chargesFen: 0, versionId: '2' })
function facts(count = 3) {
  return inpatientInvestigationsSchema.parse({ admissionId: admission.id, imagingRequests: [], sent: [], laboratoryRequests: Array.from({ length: count }, (_, n) => ({
    id: `request-${n + 1}`, catalogItemId: `service-${n + 1}`, indicationCode: 'clinical-evaluation',
    referenceConcept: { id: `reference-${n + 1}`, code: `SYN-${n + 1}`, display: `合成检验${n + 1}`, system: 'urn:synthetic', version: '1', sourceLocator: 'synthetic:test' },
    previousReports: [], serviceRequestId: `service-request-${n + 1}`, serviceRequestVersion: '1', taskId: `task-${n + 1}`, taskVersion: '1', status: 'reported', version: 1,
    report: { conclusion: `合成检验结论${n + 1}`, diagnosticReportId: `report-${n + 1}`, diagnosticReportVersion: '1', issuedAt: '2026-10-10T10:00:00+08:00',
      revisionNumber: 1, specimenId: 'synthetic-specimen', status: 'final', results: [{ code: 'SYN-1', display: '合成指标', interpretation: 'high', observationId: `observation-${n + 1}`,
        referenceRange: { low: 0, high: 10, text: '0–10' }, unit: { code: 'mg/L', display: 'mg/L', system: 'http://unitsofmeasure.org' }, value: 12 }] },
  })) })
}
function server(count = 3) {
  let current = facts(count)
  const controls = { loseSecond: false, receiptFailure: false, missing: false, wrongProof: false, wrongReceipt: false, available: true, holdBlock: async () => {}, reject: [] as string[] }
  const posts: { id: string; key: string; input: unknown }[] = [], receipts = new Map<string, unknown>(), lookups: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/auth/context') return Response.json(session)
    if (path === '/api/auth/sign-out') return Response.json({})
    if (path.endsWith('/investigations')) return Response.json(current)
    if (path.includes('/command-receipts?')) {
      const key = new URL(path, 'https://synthetic.test').searchParams.get('idempotencyKey')!
      lookups.push(key)
      if (controls.receiptFailure) return Response.json({ error: { code: 'WORKFLOW_CONFLICT', message: 'Synthetic receipt failure' } }, { status: 409 })
      if (controls.missing) return Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: 'Synthetic missing receipt' } }, { status: 404 })
      return Response.json({ operationId: controls.wrongReceipt ? 'inpatient.investigation.retry' : 'inpatient.investigation.acknowledge', idempotencyKey: key, status: 'completed', response: receipts.get(key) })
    }
    if (path.endsWith('/investigations/acknowledge') && init?.method === 'POST') {
      const { input: body } = JSON.parse(String(init.body)), id: string = body.requestId, key = new Headers(init.headers).get('idempotency-key')!
      posts.push({ id, key, input: body })
      if (controls.reject.includes(id)) return Response.json({ error: { code: 'WORKFLOW_CONFLICT', message: `Unsafe original key ${key}`,
        conflict: { owner: 'laboratory-report', resource: 'DiagnosticReport/report-1', currentStatus: 'superseded', currentVersion: '2', expectedVersion: '1' } } }, { status: 409 })
      if (receipts.has(key)) return Response.json(receipts.get(key))
      current = inpatientInvestigationsSchema.parse({ ...current, laboratoryRequests: current.laboratoryRequests.map(item => item.id !== id ? item
        : { ...item, version: item.version + 1, status: 'acknowledged', report: { ...item.report, acknowledgement: { id: `ack-${id}`, acknowledgedAt: '2026-10-10T11:00:00+08:00', acknowledgedBy: session.actor.practitionerId } } }) })
      const response = inpatientInvestigationResponseSchema.parse({ auditId: `audit-${id}`, requestId: `command-${id}`, effects: [], warnings: [], data: current })
      receipts.set(key, response)
      if (controls.wrongProof) return Response.json({ ...response, data: { ...response.data, admissionId: 'other-admission' } })
      if (controls.loseSecond && id === 'request-2') throw new TypeError('Synthetic response loss after commit')
      return Response.json(response)
    }
    throw new Error(`Unexpected ${init?.method ?? 'GET'} ${path}`)
  }))
  return { controls, posts, lookups, get: () => current, update: (value: unknown) => { current = inpatientInvestigationsSchema.parse(value) } }
}
function Harness({ boundSession = session, stay = admission, locale = 'zh-CN' as 'zh-CN' | 'en-US' }) {
  const data = useQuery({ queryKey: ['reader-facts', stay.id], queryFn: () => apiGet(`/api/his/v1/inpatient/admissions/${stay.id}/investigations`, inpatientInvestigationsSchema) })
  const write = useInpatientWriteIntent(boundSession, async () => { await data.refetch() })
  if (!data.data) return null
  return <InpatientReportReader admission={stay} session={boundSession} locale={locale} write={write} data={data.data}
    refresh={async () => { const result = await data.refetch(); return result.isSuccess ? result.data : undefined }} loading={data.isError} />
}
function mount(boundSession = session, stay = admission, locale: 'zh-CN' | 'en-US' = 'zh-CN') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return { ...render(<QueryClientProvider client={client}><Harness boundSession={boundSession} stay={stay} locale={locale} /></QueryClientProvider>), client }
}
async function readAndSelect(user: ReturnType<typeof userEvent.setup>, indices = [1, 2, 3]) {
  for (const n of indices) { await user.click(screen.getByRole('button', { name: `打开报告：合成检验${n}` })); await user.click(screen.getByRole('checkbox', { name: `选择已阅：合成检验${n}` })) }
}
async function confirmSelected(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '核对选中报告' })); await user.click(screen.getByRole('button', { name: '确认选中报告已阅' }))
}
beforeEach(() => { sessionStorage.clear(); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('仅实际打开的住院报告可选择，切报告保留本轮资格并逐项确认两份，原任务与报告版本不变', async () => {
  const api = server(), user = userEvent.setup(); mount()
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' }))
  const reader = screen.getByRole('dialog', { name: '住院报告阅读与已阅确认' })
  for (const checkbox of within(reader).getAllByRole('checkbox', { name: /^选择已阅：/ })) expect(checkbox.getAttribute('aria-disabled')).toBe('true')
  expect(within(reader).queryByText('合成检验结论1')).toBeNull()
  await readAndSelect(user, [1, 2])
  expect(api.posts).toHaveLength(0)
  await confirmSelected(user)
  await waitFor(() => expect(screen.getByRole('region', { name: '报告已阅逐项结果' }).textContent).toContain('成功 2/2'))
  expect(api.posts.map(item => item.id)).toEqual(['request-1', 'request-2'])
  expect(api.posts[0]!.input).toEqual({ requestId: 'request-1', expectedRequestVersion: 1, serviceRequestVersion: '1', taskVersion: '1', diagnosticReportId: 'report-1', diagnosticReportVersion: '1' })
  expect(api.get().laboratoryRequests.map(item => [item.status, item.report!.diagnosticReportVersion, item.serviceRequestVersion, item.taskVersion])).toEqual([['acknowledged', '1', '1', '1'], ['acknowledged', '1', '1', '1'], ['reported', '1', '1', '1']])
})
