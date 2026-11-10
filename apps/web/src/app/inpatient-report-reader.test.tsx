// @vitest-environment jsdom
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientInvestigationResponseSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiGet, signOut } from './api-client.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientReportReader } from './inpatient-report-reader.tsx'
import { createDraftDiscard } from './draft-discard.ts'

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
  const controls = { loseSecond: false, receiptFailure: false, missing: false, wrongProof: false, wrongReceipt: false, available: true, studyFailure: false, holdBlock: async () => {}, holdResponse: async (_id: string) => {}, reject: [] as string[] }
  const posts: { id: string; key: string; input: unknown }[] = [], receipts = new Map<string, unknown>(), lookups: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/auth/context') return Response.json(session)
    if (path === '/api/auth/sign-out') return Response.json({})
    if (path.endsWith('/investigations')) return Response.json(current)
    if (path.includes('/imaging-studies/') && path.includes('/blocks/')) { await controls.holdBlock(); return new Response(new Uint8Array(new Int16Array([0, 0]).buffer)) }
    if (path.includes('/imaging-studies/') && controls.studyFailure) return Response.json({ error: { code: 'SYNTHETIC_METADATA_UNAVAILABLE', message: 'Synthetic private source failure' } }, { status: 503 })
    if (path.includes('/imaging-studies/')) return Response.json({ available: controls.available, examCode: 'chest-ct-plain', studyId: 'study-image',
      series: controls.available ? [{ kind: 'frame-stack', modality: 'CT', pixelFormat: 'int16', valueUnit: 'hu',
        frames: [{ blocks: [{ length: 4, rowCount: 1, rowStart: 0 }], columns: 2, pixelSpacingMm: [1, 1], positionMm: 0, rows: 1 }] }] : [] })
    if (path.includes('/command-receipts?')) {
      const key = new URL(path, 'https://synthetic.test').searchParams.get('idempotencyKey')!
      lookups.push(key)
      if (controls.receiptFailure) return Response.json({ error: { code: 'WORKFLOW_CONFLICT', message: 'Synthetic receipt failure' } }, { status: 409 })
      if (controls.missing) return Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: 'Synthetic missing receipt' } }, { status: 404 })
      const response = inpatientInvestigationResponseSchema.parse(receipts.get(key))
      return Response.json({ operationId: controls.wrongReceipt ? 'inpatient.investigation.retry' : 'inpatient.investigation.acknowledge', idempotencyKey: key, status: 'completed',
        response: controls.wrongProof ? { ...response, data: { ...response.data, admissionId: 'other-admission' } } : response })
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
      await controls.holdResponse(id)
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
  const view = render(<QueryClientProvider client={client}><Harness boundSession={boundSession} stay={stay} locale={locale} /></QueryClientProvider>)
  return { ...view, client, change: (nextSession = boundSession, nextStay = stay, nextLocale = locale) => view.rerender(<QueryClientProvider client={client}><Harness boundSession={nextSession} stay={nextStay} locale={nextLocale} /></QueryClientProvider>) }
}
async function readAndSelect(user: ReturnType<typeof userEvent.setup>, indices = [1, 2, 3]) {
  for (const n of indices) { await user.click(screen.getByRole('button', { name: `打开报告：合成检验${n}` })); await user.click(screen.getByRole('checkbox', { name: `选择已阅：合成检验${n}` })) }
}
async function confirmSelected(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '核对选中报告' })); await user.click(screen.getByRole('button', { name: '确认选中报告已阅' }))
}
beforeEach(() => {
  sessionStorage.clear(); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => ({ putImageData: () => undefined }) })
  vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} })
})
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

it('第二项提交后丢响应停止第三项，重挂载仅恢复原回执，剩余报告须重新打开确认', async () => {
  const api = server(), user = userEvent.setup(); api.controls.loseSecond = true
  const original = mount()
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' }))
  await readAndSelect(user)
  await confirmSelected(user)
  await waitFor(() => expect(api.posts).toHaveLength(2))
  await waitFor(() => expect(screen.getByRole('button', { name: '恢复原已阅' }).hasAttribute('disabled')).toBe(false))
  original.unmount(); mount()
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' }))
  await user.click(screen.getByRole('button', { name: '恢复原已阅' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原已阅' })).toBeNull())
  expect(api.lookups).toEqual([api.posts[1]!.key])
  expect(api.posts).toHaveLength(2)
  expect(screen.getByRole('button', { name: '核对选中报告' }).hasAttribute('disabled')).toBe(true)
  await user.click(screen.getByRole('button', { name: '打开报告：合成检验3' }))
  await confirmSelected(user)
  await waitFor(() => expect(screen.getByRole('region', { name: '报告已阅逐项结果' }).textContent).toContain('成功 1/1'))
  expect(api.posts.map(item => item.id)).toEqual(['request-1', 'request-2', 'request-3'])
  expect(new Set(api.posts.map(item => item.key)).size).toBe(3)
})

it('成功先落盘后清原写意图失败时仍能恢复同一原项，不重建新尝试或续办余项', async () => {
  const api = server(), user = userEvent.setup(); mount()
  const remove = Storage.prototype.removeItem
  let rejectClear = true
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key) {
    if (key.startsWith('clinmesh.inpatient-intent:') && rejectClear) { rejectClear = false; throw new Error('Synthetic storage unavailable') }
    return remove.call(this, key)
  })
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' }))
  await readAndSelect(user, [1, 2]); await confirmSelected(user)
  await waitFor(() => expect(api.posts).toHaveLength(1))
  const restore = await screen.findByRole('button', { name: '恢复原已阅' })
  await waitFor(() => expect(restore.hasAttribute('disabled')).toBe(false))
  await user.click(restore)
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原已阅' })).toBeNull())
  expect(api.posts).toHaveLength(1)
  expect(api.lookups).toEqual([api.posts[0]!.key])
  expect(screen.getByRole('button', { name: '核对选中报告' }).hasAttribute('disabled')).toBe(true)
})

it('影像须真实首帧；切到检验后不可读立即撤资格，恢复可读也必须等待新首帧', async () => {
  const api = server(1), user = userEvent.setup()
  api.update({ ...api.get(), imagingRequests: [{ id: 'image-request', previousReports: [], indication: '合成指征',
    service: { id: 'image-service', code: 'SYN-CT', name: '合成影像', version: 1, bodySite: '胸部', department: '放射科', examCode: 'chest-ct-plain',
      method: '合成CT平扫', modality: 'CT', applicability: '合成核对', reportSections: ['technique', 'findings', 'impression'] },
    serviceRequestId: 'image-sr', serviceRequestVersion: '1', taskId: 'image-task', taskVersion: '1', version: 1, status: 'reported',
    report: { diagnosticReportId: 'image-report', diagnosticReportVersion: '1', examinedAt: '2026-10-10T10:00:00+08:00', issuedAt: '2026-10-10T10:00:00+08:00',
      findings: '合成所见', impression: '合成影像结论', technique: '合成技术', studyId: 'study-image', revisionNumber: 1, status: 'final' } }] })
  let release: () => void = () => {}, blocks = 0; api.controls.holdBlock = () => new Promise<void>(resolve => { blocks++; release = resolve })
  const view = mount()
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' }))
  await user.click(screen.getByRole('button', { name: '打开报告：合成影像' }))
  await screen.findByText('合成影像结论')
  expect(screen.getByRole('checkbox', { name: '选择已阅：合成影像' }).getAttribute('aria-disabled')).toBe('true')
  await waitFor(() => expect(blocks).toBe(1), { timeout: 5_000 })
  release()
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '选择已阅：合成影像' }).getAttribute('aria-disabled')).not.toBe('true'))
  await user.click(screen.getByRole('checkbox', { name: '选择已阅：合成影像' }))
  await readAndSelect(user, [1])
  expect(screen.getByRole('button', { name: '核对选中报告' }).hasAttribute('disabled')).toBe(false)
  api.controls.available = false
  await view.client.invalidateQueries({ queryKey: ['inpatient-reader-study'] })
  await waitFor(() => expect(screen.getByRole('button', { name: '核对选中报告' }).hasAttribute('disabled')).toBe(true))
  await user.click(screen.getByRole('button', { name: '打开报告：合成影像' }))
  api.controls.available = true
  await view.client.invalidateQueries({ queryKey: ['inpatient-reader-study'] })
  expect(screen.getByRole('checkbox', { name: '选择已阅：合成影像' }).getAttribute('aria-disabled')).toBe('true')
  await waitFor(() => expect(blocks).toBe(2), { timeout: 5_000 })
  release()
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '选择已阅：合成影像' }).getAttribute('aria-disabled')).not.toBe('true'))
  expect(api.posts).toHaveLength(0)
})

it('影像不可读提供重新读取入口，保留原选择并等待恢复后的真实首帧', async () => {
  const api = server(1), user = userEvent.setup(); api.controls.available = false
  api.update({ ...api.get(), imagingRequests: [{ id: 'image-request', previousReports: [], indication: '合成指征',
    service: { id: 'image-service', code: 'SYN-CT', name: '合成影像', version: 1, bodySite: '胸部', department: '放射科', examCode: 'chest-ct-plain',
      method: '合成CT平扫', modality: 'CT', applicability: '合成核对', reportSections: ['technique', 'findings', 'impression'] },
    serviceRequestId: 'image-sr', serviceRequestVersion: '1', taskId: 'image-task', taskVersion: '1', version: 1, status: 'reported',
    report: { diagnosticReportId: 'image-report', diagnosticReportVersion: '1', examinedAt: '2026-10-10T10:00:00+08:00', issuedAt: '2026-10-10T10:00:00+08:00',
      findings: '合成所见', impression: '合成影像结论', technique: '合成技术', studyId: 'study-image', revisionNumber: 1, status: 'final' } }] })
  let release: () => void = () => {}, started = false
  api.controls.holdBlock = () => new Promise<void>(resolve => { started = true; release = resolve })
  mount(); await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' }))
  await readAndSelect(user, [1]); await user.click(screen.getByRole('button', { name: '打开报告：合成影像' }))
  const retry = await screen.findByRole('button', { name: '重新读取影像' })
  api.controls.available = true
  await user.click(retry)
  await waitFor(() => expect(started).toBe(true))
  expect(screen.getByRole('checkbox', { name: '选择已阅：合成影像' }).getAttribute('aria-disabled')).toBe('true')
  expect(screen.getByRole('checkbox', { name: '待确认已阅：合成检验1' }).getAttribute('aria-checked')).toBe('true')
  release()
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '选择已阅：合成影像' }).getAttribute('aria-disabled')).not.toBe('true'))
  expect(api.posts).toHaveLength(0)
})

it.each(['receiptFailure', 'wrongReceipt', 'wrongProof'] as const)('原回执%s时保持未知且不续办、不回退新写入', async failure => {
  const api = server(), user = userEvent.setup(); api.controls.loseSecond = true; mount()
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' }))
  await readAndSelect(user); await confirmSelected(user)
  await waitFor(() => expect(api.posts).toHaveLength(2))
  const recover = screen.getByRole('button', { name: '恢复原已阅' })
  await waitFor(() => expect(recover.hasAttribute('disabled')).toBe(false))
  api.controls[failure] = true
  await user.click(recover)
  await waitFor(() => expect(api.lookups).toHaveLength(1))
  await waitFor(() => expect(screen.getByRole('button', { name: '恢复原已阅' }).hasAttribute('disabled')).toBe(false))
  expect(api.posts).toHaveLength(2)
  expect(screen.getByRole('button', { name: '核对选中报告' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('region', { name: '报告已阅逐项结果' }).textContent).toContain('结果待查明')
})

it('只有明确原回执不存在时按原input及原key重放，仍只办理原项', async () => {
  const api = server(), user = userEvent.setup(); api.controls.loseSecond = true; mount()
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' }))
  await readAndSelect(user); await confirmSelected(user)
  await waitFor(() => expect(api.posts).toHaveLength(2))
  const recover = screen.getByRole('button', { name: '恢复原已阅' })
  await waitFor(() => expect(recover.hasAttribute('disabled')).toBe(false))
  api.controls.missing = true
  await user.click(recover)
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原已阅' })).toBeNull())
  expect(api.posts).toHaveLength(3)
  expect(api.posts[2]).toEqual(api.posts[1])
  expect(api.posts.some(item => item.id === 'request-3')).toBe(false)
  expect(screen.getByRole('button', { name: '核对选中报告' }).hasAttribute('disabled')).toBe(true)
})

it('关窗重开和页面重挂载保留明确选择，撤销本轮阅读资格', async () => {
  const api = server(), user = userEvent.setup(); const original = mount()
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' })); await readAndSelect(user, [1])
  await user.click(screen.getByRole('button', { name: '关闭阅读窗口' }))
  await user.click(screen.getByRole('button', { name: '连续阅读住院报告' }))
  expect(screen.getByRole('checkbox', { name: '待确认已阅：合成检验1' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByRole('button', { name: '核对选中报告' }).hasAttribute('disabled')).toBe(true)
  await user.click(screen.getByRole('button', { name: '打开报告：合成检验1' }))
  expect(screen.getByRole('button', { name: '核对选中报告' }).hasAttribute('disabled')).toBe(false)
  original.unmount(); mount()
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' }))
  expect(screen.getByRole('checkbox', { name: '待确认已阅：合成检验1' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByRole('button', { name: '核对选中报告' }).hasAttribute('disabled')).toBe(true)
  expect(api.posts).toHaveLength(0)
})

it.each(['account', 'actor', 'patient', 'admission'] as const)('完整%s切换隔离清单与本轮资格，返回原上下文仍须重读', async field => {
  const api = server(), user = userEvent.setup(); const view = mount()
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' })); await readAndSelect(user, [1])
  const nextSession = field === 'account' ? { ...session, user: { ...session.user, id: 'other-account' } }
    : field === 'actor' ? { ...session, actor: { ...session.actor, epoch: 'epoch-2' } } : session
  const nextAdmission = field === 'patient' ? { ...admission, patientId: 'other-patient' }
    : field === 'admission' ? { ...admission, id: 'other-admission' } : admission
  view.change(nextSession, nextAdmission)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' }))
  expect(within(screen.getByRole('region', { name: '报告完整待确认清单' })).queryByRole('checkbox')).toBeNull()
  expect(screen.getByRole('checkbox', { name: '选择已阅：合成检验1' }).getAttribute('aria-disabled')).toBe('true')
  view.change(session, admission)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' }))
  expect(screen.getByRole('checkbox', { name: '待确认已阅：合成检验1' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByRole('button', { name: '核对选中报告' }).hasAttribute('disabled')).toBe(true)
  expect(api.posts).toHaveLength(0)
})

it('已选报告更正或申请版本变化后保留原清单，重新打开并明确核对后使用新版本', async () => {
  const api = server(), user = userEvent.setup(); const view = mount()
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' })); await readAndSelect(user, [1, 2])
  const original = api.get().laboratoryRequests[0]!
  api.update({ ...api.get(), laboratoryRequests: api.get().laboratoryRequests.map(item => item.id === original.id
    ? { ...item, version: 2, report: { ...item.report, diagnosticReportVersion: '2', conclusion: '合成更正检验结论' } } : item) })
  await view.client.invalidateQueries({ queryKey: ['reader-facts'] })
  await waitFor(() => expect(screen.getByRole('button', { name: '核对选中报告' }).hasAttribute('disabled')).toBe(true))
  expect(screen.getByText('报告或申请已更新，请重新阅读并核对')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '打开报告：合成检验1' }))
  await screen.findByText('合成更正检验结论')
  await user.click(screen.getByRole('button', { name: '重新核对此报告' }))
  await confirmSelected(user)
  await waitFor(() => expect(api.posts).toHaveLength(2))
  expect(api.posts[1]!.input).toMatchObject({ requestId: 'request-1', expectedRequestVersion: 2, diagnosticReportVersion: '2' })
})

it('确定拒绝保留可信具体冲突并按当前语言显示，独立后项仍可完成', async () => {
  const api = server(), user = userEvent.setup(); api.controls.reject = ['request-1']; const view = mount()
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' })); await readAndSelect(user, [1, 2]); await confirmSelected(user)
  await waitFor(() => expect(screen.getByRole('region', { name: '报告已阅逐项结果' }).textContent).toContain('成功 1/2'))
  const zh = screen.getByRole('region', { name: '报告已阅逐项结果' }).textContent
  expect(zh).toContain('检验报告')
  expect(zh).not.toContain('Unsafe original key')
  view.change(session, admission, 'en-US')
  await waitFor(() => expect(screen.getByRole('region', { name: 'Report acknowledgement results' }).textContent).toContain('report'))
  expect(screen.getByRole('region', { name: 'Report acknowledgement results' }).textContent).not.toContain('Unsafe original key')
  expect(Object.values(sessionStorage).join('')).not.toContain('Unsafe original key')
  expect(api.posts.map(item => item.id)).toEqual(['request-1', 'request-2'])
})

it('发送后切到另有同报告草稿的账号，迟到成功只消费原账号原行', async () => {
  const api = server(), user = userEvent.setup(), view = mount()
  const nextSession = { ...session, user: { ...session.user, id: 'new-account' } }
  view.change(nextSession)
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' })); await readAndSelect(user, [1])
  view.change(session, admission)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  let release: () => void = () => {}
  api.controls.holdResponse = id => id === 'request-1' ? new Promise<void>(resolve => { release = resolve }) : Promise.resolve()
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' })); await readAndSelect(user, [1, 2]); await confirmSelected(user)
  await waitFor(() => expect(api.posts).toHaveLength(1))
  view.change(nextSession)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await user.click(screen.getByRole('button', { name: '连续阅读住院报告' })); await user.click(screen.getByRole('button', { name: '打开报告：合成检验1' }))
  release()
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '待确认已阅：合成检验1' }).getAttribute('aria-checked')).toBe('true'))
  await waitFor(() => expect(screen.getByRole('button', { name: '核对选中报告' }).hasAttribute('disabled')).toBe(false))
  view.change(session, admission)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await user.click(screen.getByRole('button', { name: '连续阅读住院报告' }))
  await waitFor(() => expect(within(screen.getByRole('region', { name: '报告完整待确认清单' })).queryByRole('checkbox', { name: '待确认已阅：合成检验1' })).toBeNull())
  expect(screen.getByRole('checkbox', { name: '待确认已阅：合成检验2' }).getAttribute('aria-checked')).toBe('true')
  expect(api.posts).toHaveLength(1)
})

it.each(['read', 'write'] as const)('清单%s存储不可用时保留输入并停止写入，可显式重新读取', async failure => {
  const api = server(), user = userEvent.setup()
  const originalRead = Storage.prototype.getItem, originalWrite = Storage.prototype.setItem
  let unavailable = true
  if (failure === 'read') vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
    if (unavailable && key.startsWith('clinmesh.inpatient-report-reader:')) throw new Error('Synthetic storage read failure')
    return originalRead.call(this, key)
  })
  else vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (unavailable && key.startsWith('clinmesh.inpatient-report-reader:')) throw new Error('Synthetic storage write failure')
    return originalWrite.call(this, key, value)
  })
  mount(); await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' }))
  if (failure === 'write') await readAndSelect(user, [1])
  await screen.findByText('待确认清单存储不可用')
  expect(screen.getByRole('button', { name: '核对选中报告' }).hasAttribute('disabled')).toBe(true)
  expect(api.posts).toHaveLength(0)
  unavailable = false
  await user.click(screen.getByRole('button', { name: '重新读取清单' }))
  await waitFor(() => expect(screen.queryByText('待确认清单存储不可用')).toBeNull())
})

it('只全选本页已实际阅读项，跨页保留完整二十项，清空选择、移除、确认丢弃分别办理', async () => {
  const api = server(21), user = userEvent.setup(); mount()
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' }))
  const list = () => screen.getByRole('region', { name: '报告完整待确认清单' })
  await user.click(screen.getByRole('button', { name: '全选本页可确认报告' }))
  expect(within(list()).queryAllByRole('checkbox')).toHaveLength(0)
  for (let page = 0; page < 2; page++) {
    for (let n = 1 + page * 10; n <= 10 + page * 10; n++) await user.click(screen.getByRole('button', { name: `打开报告：合成检验${n}` }))
    await user.click(screen.getByRole('button', { name: '全选本页可确认报告' }))
    expect(within(list()).getAllByRole('checkbox')).toHaveLength((page + 1) * 10)
    await user.click(screen.getByRole('button', { name: '下一页报告' }))
  }
  await user.click(screen.getByRole('button', { name: '打开报告：合成检验21' }))
  await user.click(screen.getByRole('checkbox', { name: '选择已阅：合成检验21' }))
  expect(screen.getByText('最多保留20项，请先移除不需要的报告')).toBeTruthy()
  expect(within(list()).getAllByRole('checkbox')).toHaveLength(20)
  await user.type(screen.getByRole('textbox', { name: '搜索报告' }), '合成检验21')
  expect(screen.getAllByRole('button', { name: /^打开报告：/ })).toHaveLength(1)
  expect(within(list()).getAllByRole('checkbox')).toHaveLength(20)
  await user.click(screen.getByRole('button', { name: '清空已阅选择' }))
  expect(within(list()).getAllByRole('checkbox').every(checkbox => checkbox.getAttribute('aria-checked') === 'false')).toBe(true)
  await user.click(screen.getByRole('button', { name: '移除已阅：合成检验1' }))
  expect(within(list()).getAllByRole('checkbox')).toHaveLength(19)
  await user.click(screen.getByRole('button', { name: '丢弃已阅清单' }))
  await user.click(screen.getByRole('button', { name: '保留清单' }))
  expect(within(list()).getAllByRole('checkbox')).toHaveLength(19)
  await user.click(screen.getByRole('button', { name: '丢弃已阅清单' })); await user.click(screen.getByRole('button', { name: '确认丢弃' }))
  expect(within(list()).queryAllByRole('checkbox')).toHaveLength(0)
  expect(api.posts).toHaveLength(0)
}, 30_000)

it('退出登录清理本轮住院报告待确认草稿', async () => {
  server(); const user = userEvent.setup(); mount()
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' })); await readAndSelect(user, [1])
  await signOut()
  await waitFor(() => expect(within(screen.getByRole('region', { name: '报告完整待确认清单' })).queryAllByRole('checkbox')).toHaveLength(0))
})

it('退出清理删除失败后重挂不回显住院报告私稿，持久标记补清理后可重新阅读选择', async () => {
  const api = server(), user = userEvent.setup(), original = mount()
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' }))
  await readAndSelect(user, [1])
  const prefix = 'clinmesh.inpatient-report-reader:v1:'
  const key = Object.keys(sessionStorage).find(key => key.startsWith(prefix))!
  expect(key).toBeDefined()
  const remove = Storage.prototype.removeItem
  const denied = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, target) {
    if (target.startsWith(prefix)) throw new DOMException('合成退出删除失败', 'SecurityError')
    remove.call(this, target)
  })
  try {
    await act(async () => { await expect(signOut()).resolves.toBeUndefined() })
    expect(sessionStorage.getItem(key)).not.toBeNull()
    original.unmount()
    const unavailable = mount()
    await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' }))
    expect(screen.queryByRole('checkbox', { name: '待确认已阅：合成检验1' })).toBeNull()
    unavailable.unmount()
    denied.mockRestore()
    expect(createDraftDiscard(prefix).read(key)).toBeNull()
    const restored = mount()
    await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' }))
    expect(screen.getByRole('checkbox', { name: '选择已阅：合成检验1' }).getAttribute('aria-disabled')).toBe('true')
    await readAndSelect(user, [2])
    restored.unmount()
    mount()
    await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' }))
    const list = screen.getByRole('region', { name: '报告完整待确认清单' })
    expect(within(list).getAllByRole('checkbox')).toHaveLength(1)
    expect(within(list).getByRole('checkbox', { name: '待确认已阅：合成检验2' }).getAttribute('aria-checked')).toBe('true')
    expect(list.textContent).not.toContain('合成检验1')
    expect(screen.getByRole('checkbox', { name: '选择已阅：合成检验2' }).getAttribute('aria-disabled')).toBe('true')
    expect(api.posts).toHaveLength(0)
  } finally { denied.mockRestore() }
})

it.each(['discharge-pending', 'departed', 'cleared'] as const)('未归档的%s住院报告仍可实际阅读并确认已阅', async status => {
  const api = server(1), user = userEvent.setup(); mount(session, { ...admission, status })
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' }))
  await user.click(screen.getByRole('button', { name: '打开报告：合成检验1' }))
  expect(screen.getByRole('checkbox', { name: '选择已阅：合成检验1' }).getAttribute('aria-disabled')).not.toBe('true')
  await user.click(screen.getByRole('checkbox', { name: '选择已阅：合成检验1' })); await confirmSelected(user)
  await waitFor(() => expect(screen.getByRole('region', { name: '报告已阅逐项结果' }).textContent).toContain('成功 1/1'))
  expect(api.posts.map(item => item.id)).toEqual(['request-1'])
})

it('归档后仅禁止新确认并说明原因，原成功已阅仍可查询原回执且不续办余项', async () => {
  const api = server(), user = userEvent.setup(); api.controls.loseSecond = true; const view = mount()
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' })); await readAndSelect(user); await confirmSelected(user)
  await waitFor(() => expect(api.posts).toHaveLength(2))
  await waitFor(() => expect(screen.getByRole('button', { name: '恢复原已阅' }).hasAttribute('disabled')).toBe(false))
  view.change(session, { ...admission, status: 'cleared', recordStatus: 'archived' })
  expect(screen.getByRole('button', { name: '恢复原已阅' }).hasAttribute('disabled')).toBe(false)
  await user.click(screen.getByRole('button', { name: '恢复原已阅' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原已阅' })).toBeNull())
  expect(api.lookups).toEqual([api.posts[1]!.key])
  await user.click(screen.getByRole('button', { name: '打开报告：合成检验3' }))
  expect(screen.getByRole('checkbox', { name: '选择已阅：合成检验3' }).getAttribute('aria-disabled')).toBe('true')
  expect(screen.getByRole('button', { name: '核对选中报告' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText('本次住院病历已归档，不能新增已阅确认；仍可恢复原已阅结果。')).toBeTruthy()
  expect(api.posts).toHaveLength(2)
})
