// @vitest-environment jsdom
import { doctorCaseDetailSchema, type DoctorCaseDetail, type SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDoctorCase } from '../api-client.ts'
import { OutpatientReportReader } from './outpatient-report-reader.tsx'

const session: SessionContext = {
  actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor',
    practitionerId: 'practitioner-doctor', organizationId: 'organization-outpatient', locationId: 'location-outpatient', roleCode: 'outpatient-doctor' },
  user: { id: 'account-doctor', name: '合成医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [],
}
function facts(count = 3): DoctorCaseDetail {
  return doctorCaseDetailSchema.parse({ registrationNumber: null, allergies: [], caseId: 'case-1', consultation: { turns: [], version: 1 },
    encounter: { id: 'encounter-1', versionId: '1', status: 'in-progress' },
    patient: { id: 'patient-1', identifier: 'SYN-1', name: '合成报告患者', synthetic: true, versionId: '1' },
    presentation: null, priorFacts: [], status: 'first-visit', taskId: 'case-task', taskVersion: '1',
    laboratoryRequests: { draftVersion: 0, reportingSupported: true, requests: Array.from({ length: count }, (_, n) => ({
      id: `request-${n + 1}`, catalogItemId: `service-${n + 1}`, indicationCode: 'clinical-evaluation',
      referenceConcept: { id: `reference-${n + 1}`, code: `SYN-${n + 1}`, display: `合成检验${n + 1}`, system: 'urn:synthetic', version: '1', sourceLocator: 'synthetic:test' },
      previousReports: [], serviceRequestId: `service-request-${n + 1}`, serviceRequestVersion: '1', taskId: `task-${n + 1}`, taskVersion: '1', status: 'reported', version: 1,
      report: { conclusion: `合成检验结论${n + 1}`, diagnosticReportId: `report-${n + 1}`, diagnosticReportVersion: '1', issuedAt: '2026-10-10T10:00:00+08:00',
        revisionNumber: 1, specimenId: 'synthetic-specimen', status: 'final', results: [{ code: 'SYN-1', display: '合成指标', interpretation: 'high', observationId: `observation-${n + 1}`,
          referenceRange: { low: 0, high: 10, text: '0–10' }, unit: { code: 'mg/L', display: 'mg/L', system: 'http://unitsofmeasure.org' }, value: 12 }] },
    })) } })
}
function server(count = 3) {
  let current = facts(count)
  const controls = { loseSecond: true, receiptFailure: false, missing: false, wrongProof: false }
  const posts: { id: string; key: string; body: unknown }[] = [], receipts = new Map<string, unknown>(), lookups: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/doctor/cases/case-1')) return Response.json(current)
    if (path.includes('/command-receipts?')) {
      const key = new URL(path, 'https://synthetic.test').searchParams.get('idempotencyKey')!
      lookups.push(key)
      if (controls.receiptFailure) return Response.json({ error: { code: 'WORKFLOW_CONFLICT', message: 'Synthetic receipt failure' } }, { status: 409 })
      if (controls.missing) return Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: 'Synthetic missing receipt' } }, { status: 404 })
      return Response.json({ operationId: 'laboratory-report.acknowledge', idempotencyKey: key, status: 'completed', response: receipts.get(key) })
    }
    if (path.endsWith('/actions/acknowledge') && init?.method === 'POST') {
      const id = path.split('/').at(-5)!, key = new Headers(init.headers).get('idempotency-key')!, body: unknown = JSON.parse(String(init.body))
      posts.push({ id, key, body })
      if (receipts.has(key)) return Response.json(receipts.get(key))
      const request = current.laboratoryRequests!.requests.find(item => item.id === id)!
      const ack = { id: `ack-${id}`, acknowledgedAt: '2026-10-10T11:00:00+08:00', acknowledgedBy: session.actor.practitionerId }
      current = doctorCaseDetailSchema.parse({ ...current, laboratoryRequests: { ...current.laboratoryRequests, requests: current.laboratoryRequests!.requests.map(item => item.id !== id ? item
        : { ...item, version: item.version + 1, status: 'acknowledged', report: { ...item.report, acknowledgement: ack } }) } })
      const response = { auditId: `audit-${id}`, requestId: `command-${id}`, effects: [], warnings: [], data: { acknowledgementId: ack.id, acknowledgedAt: ack.acknowledgedAt,
        acknowledgedBy: ack.acknowledgedBy, diagnosticReportId: request.report!.diagnosticReportId, requestId: id, requestVersion: request.version + 1, status: 'acknowledged' } }
      receipts.set(key, response)
      if (controls.wrongProof) return Response.json({ ...response, data: { ...response.data, requestId: 'other-request' } })
      if (controls.loseSecond && id === 'request-2') throw new TypeError('Synthetic response loss after commit')
      return Response.json(response)
    }
    throw new Error(`Unexpected ${init?.method ?? 'GET'} ${path}`)
  }))
  return { controls, posts, lookups, get: () => current, update: (value: unknown) => { current = doctorCaseDetailSchema.parse(value) } }
}
function Harness({ boundSession = session, locale = 'zh-CN' as 'zh-CN' | 'en-US' }) {
  const detail = useQuery({ queryKey: ['doctor-case', 'case-1'], queryFn: () => getDoctorCase('case-1') })
  if (!detail.data) return null
  return <OutpatientReportReader context={{ session: boundSession, caseId: 'case-1', patientId: detail.data.patient.id, encounterId: detail.data.encounter.id,
    patientName: detail.data.patient.name, onChanged: () => detail.refetch() }} detail={detail.data} locale={locale} readOnly={false} />
}
function mount(boundSession = session, locale: 'zh-CN' | 'en-US' = 'zh-CN') {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><Harness boundSession={boundSession} locale={locale} /></QueryClientProvider>)
}
beforeEach(() => { sessionStorage.clear(); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('同窗口实际阅读后才可选择；第二项提交后丢响应停止第三项，刷新恢复原回执后余项必须重读再确认', async () => {
  const api = server(), user = userEvent.setup(), original = mount()
  await user.click(await screen.findByRole('button', { name: '连续阅读报告' }))
  const reader = screen.getByRole('dialog', { name: '报告阅读与已阅确认' })
  for (const checkbox of within(reader).getAllByRole('checkbox', { name: /^选择已阅：/ })) expect(checkbox.getAttribute('aria-disabled')).toBe('true')
  for (const n of [1, 2, 3]) {
    await user.click(within(reader).getByRole('button', { name: `打开报告：合成检验${n}` }))
    expect(within(reader).getByText(`合成检验结论${n}`)).toBeTruthy()
    await user.click(within(reader).getByRole('checkbox', { name: `选择已阅：合成检验${n}` }))
  }
  expect(api.posts).toHaveLength(0)
  await user.click(within(reader).getByRole('button', { name: '核对选中报告' }))
  await user.click(screen.getByRole('button', { name: '确认选中报告已阅' }))
  await screen.findByRole('button', { name: '恢复原已阅' })
  await waitFor(() => expect(api.posts).toHaveLength(2))
  await waitFor(() => expect(screen.getByRole('button', { name: '恢复原已阅' }).hasAttribute('disabled')).toBe(false))
  original.unmount(); mount()
  await user.click(await screen.findByRole('button', { name: '连续阅读报告' }))
  await user.click(screen.getByRole('button', { name: '恢复原已阅' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原已阅' })).toBeNull())
  expect(api.posts).toHaveLength(2)
  expect(api.lookups).toEqual([api.posts[1]!.key])
  expect(screen.getByRole('button', { name: '核对选中报告' }).hasAttribute('disabled')).toBe(true)
  await user.click(screen.getByRole('button', { name: '打开报告：合成检验3' }))
  await user.click(screen.getByRole('button', { name: '核对选中报告' }))
  await user.click(screen.getByRole('button', { name: '确认选中报告已阅' }))
  await waitFor(() => expect(screen.getByRole('region', { name: '报告已阅逐项结果' }).textContent).toContain('成功 1/1'))
  expect(api.posts.map(item => item.id)).toEqual(['request-1', 'request-2', 'request-3'])
  expect(new Set(api.posts.map(item => item.key)).size).toBe(3)
})
