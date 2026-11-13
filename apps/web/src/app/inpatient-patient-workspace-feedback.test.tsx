// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema, inpatientCatalogSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullCatalogSchema, inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { Toaster } from '@clinmesh/ui/components/toast'
import { InpatientPatientWorkspace } from './inpatient-patient-workspace.tsx'
import { inpatientScopeKey } from './inpatient-scope.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { usageOverview } from './model-usage.test-fixture.ts'

const time = '2026-08-24T09:00:00+08:00'
let fixtureSequence = 0
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear() })

function fixture(mode: 'receive' | 'draft' | 'clock' | 'usage' | 'follow-stop' = 'receive', archived = false) {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const doctor = mode === 'draft' || mode === 'usage' || mode === 'follow-stop'
  const session: SessionContext = { actor: { actorId: 'feedback-actor', workspaceId: 'feedback-workspace', epoch: `feedback-epoch-${++fixtureSequence}`,
    scenarioRunId: 'feedback-run', practitionerRoleId: doctor ? 'feedback-doctor-role' : 'feedback-nurse-role', roleCode: doctor ? 'inpatient-doctor' : 'ward-nurse' },
    user: { id: 'feedback-user', name: '合成工作人员', email: 'feedback@example.test' }, availableRoles: [] }
  const admissions = ['A', 'B'].map(suffix => inpatientAdmissionSchema.parse({ id: `admission-${suffix}`, patientId: `patient-${suffix}`,
    patientName: `合成患者 ${suffix}`, inpatientNumber: `ZY-${suffix}`, admissionRoute: 'direct', wardId: 'feedback-ward', organizationId: 'feedback-hospital',
    status: doctor ? 'admitted' : 'registered', financialStatus: 'open', recordStatus: archived ? 'archived' : 'open', registeredAt: time, depositFen: 0, chargesFen: 0, outstandingFen: 0, versionId: '1' }))
  const catalog = inpatientCatalogSchema.parse({ wards: [{ id: 'feedback-ward', name: '合成病区', organizationId: 'feedback-hospital' }],
    beds: [{ id: 'feedback-bed', wardId: 'feedback-ward', roomId: 'feedback-room', name: '合成床位', dailyPriceFen: 1000 }] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  const scope = inpatientScopeKey(session), reads = new Map<string, unknown>()
  const scenario = { clinicalReview: null, epoch: session.actor.epoch, initialStateHash: 'synthetic', kind: 'golden', scenarioId: 'feedback-scenario',
    scenarioRunId: session.actor.scenarioRunId, seed: 1, status: 'active', virtualTime: time, workspaceId: session.actor.workspaceId }
  client.setQueryData(['scenario', 'virtual-time'], scenario)
  reads.set('/api/sim/v1/scenario-runs/current', scenario)
  const clinicalCatalog = inpatientFullCatalogSchema.parse({ diagnoses: [], medications: [], services: [] })
  client.setQueryData([...scope, 'clinical-catalog'], clinicalCatalog)
  reads.set('/api/his/v1/inpatient/clinical-catalog', clinicalCatalog)
  for (const admission of admissions) {
    const identity = { resourceType: 'Patient', id: admission.patientId, gender: 'female', birthDate: '1980-01-01' }
    const clinical = inpatientFullClinicalSchema.parse({ admissionId: admission.id, encounterVersion: '1', diagnosis: { revision: 0, entries: [] },
      orders: [], executions: [], dispenses: [], charges: [], chargesFen: 0 })
    const investigations = inpatientInvestigationsSchema.parse({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] })
    const surgery = inpatientSurgerySchema.parse({ admissionId: admission.id, encounterVersion: '1', virtualTime: time, requests: [], executions: [] })
    client.setQueryData([...scope, admission.patientId, 'patient-identity'], identity)
    client.setQueryData([...scope, admission.id, 'clinical'], clinical)
    client.setQueryData([...scope, admission.id, 'investigations'], investigations)
    client.setQueryData([...scope, admission.id, 'surgeries'], surgery)
    reads.set(`/fhir/R5/Patient/${admission.patientId}`, identity)
    reads.set(`/api/his/v1/inpatient/admissions/${admission.id}/clinical`, clinical)
    reads.set(`/api/his/v1/inpatient/admissions/${admission.id}/investigations`, investigations)
    reads.set(`/api/his/v1/inpatient/admissions/${admission.id}/surgeries`, surgery)
  }
  const parameters = { requestId: 'pci-plan', treatmentPlan: '合成 PCI 方案', targetSite: 'LAD 中段', measurements: [], plannedQuantities: [], approvedMaterialIds: [] }
  const response = { auditId: 'feedback-audit', requestId: 'feedback-request', effects: [], warnings: [], data: mode === 'draft'
    ? { admissionId: admissions[0]!.id, confirmation: null, history: [], candidates: [], evidencePackage: { id: 'feedback-evidence', version: 'v1', synthetic: true, limitation: '有限合成方案' },
      drafts: [{ requestId: 'pci-plan', version: 2, reportId: 'report-1', reportVersion: 1, edited: true, parameters, confirmedSelectionVersion: null }] }
    : mode === 'clock' ? { virtualTime: '2026-08-24T10:00:00+08:00', clockRevision: 2, bedChargesCreated: 0 }
      : { admission: { ...admissions[0]!, status: 'admitted', bedId: 'feedback-bed', admittedAt: time, versionId: '2' } } }
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const posts: Array<{ path: string; body: unknown }> = [], receipts: unknown[] = []
  const requested: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const url = new URL(path, 'http://localhost')
    requested.push(url)
    if (path === '/api/auth/context') return Response.json(session)
    if (url.pathname.endsWith('/drg/simulation')) return Response.json({ error: { code: 'DRG_RULES_NOT_CONFIGURED', message: '合成场景未配置分组规则' } }, { status: 409 })
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(String(init.body)) }); await held
      if (mode === 'follow-stop') return Response.json({ error: { code: 'VERSION_CONFLICT', message: '合成并发冲突，请重新核对' } }, { status: 409 })
      return Response.json(response)
    }
    if (reads.has(path)) return Response.json(reads.get(path))
    if (url.pathname.endsWith('/drg/followup')) return Response.json({ admissionId: admissions[0]!.id, encounterVersion: '1', task: mode === 'usage' || mode === 'follow-stop' ? {
      id: 'usage-followup', admissionId: admissions[0]!.id, status: mode === 'follow-stop' ? 'active' : archived ? 'archived' : 'authorization-lost', version: 1,
      startedAt: time, updatedAt: time, reason: '合成状态说明', ruleStatus: 'pending', fingerprint: null,
      simulation: null, errorCode: null, exceptionAlert: 'unknown', modelRequests: 0,
    } : null })
    if (url.pathname === '/api/model-usage/overview') return Response.json(usageOverview)
    if (url.pathname === '/api/model-usage/retention') return Response.json({ days: 90, version: 1, compactedRequests: 0, lastCompactedAt: null })
    if (mode === 'usage' || mode === 'follow-stop') return Response.json({ error: { code: 'SYNTHETIC_READ_FAILURE', message: '合成场景未提供此资料' } }, { status: 503 })
    throw new Error(`Unexpected request ${path}`)
  }))
  function Content() {
    const [selected, setSelected] = useState(admissions[0]!), [received, setReceived] = useState(0)
    const write = useInpatientWriteIntent(session, async (_command, receipt) => {
      await client.invalidateQueries({ queryKey: ['inpatient'] }); receipts.push(receipt); setReceived(value => value + 1)
    })
    return <>
      <button onClick={() => setSelected(admissions[1]!)}>切到合成患者 B</button>
      {mode === 'draft' ? <button onClick={() => write.mutation.mutate({ operation: 'inpatient.pci-selection.save', input: {
        admissionId: admissions[0]!.id, requestId: 'pci-plan', expectedDraftVersion: 1, parameters,
      } })}>保存 PCI 工作稿</button> : null}
      {mode === 'clock' ? <button onClick={() => write.mutation.mutate({ operation: 'scenario.advance-time', input: {
        expectedVirtualTime: time, targetVirtualTime: '2026-08-24T10:00:00+08:00',
      } })}>推进合成时钟</button> : null}
      <output aria-label="写操作状态">{write.mutation.status}</output>
      <output aria-label="已接收回执数">{received}</output>
      <InpatientPatientWorkspace key={selected.id} admission={selected} admissions={admissions} catalog={catalog} allowTransfers={false}
        session={session} locale="zh-CN" write={write} />
    </>
  }
  render(<QueryClientProvider client={client}><Toaster><Content /></Toaster></QueryClientProvider>)
  return { posts, receipts, response, release, requested, user: userEvent.setup() }
}

async function receive(f: ReturnType<typeof fixture>) {
  await f.user.click(screen.getByRole('button', { name: /合成床位/ }))
  await f.user.click(screen.getByRole('button', { name: '接诊并分床' }))
  await vi.waitFor(() => expect(f.posts).toHaveLength(1))
}

async function finish(f: ReturnType<typeof fixture>) {
  await act(async () => { f.release() })
  await vi.waitFor(() => expect(screen.getByLabelText('写操作状态').textContent).toBe('success'))
  expect(screen.getByLabelText('已接收回执数').textContent).toBe('1')
}

it('A 的分床确认已发送后切到 B，晚到的 A 回执不显示 B 完成或交接', async () => {
  const f = fixture()
  await receive(f)
  expect(screen.queryByText(/^已完成接诊分床/)).toBeNull()
  await f.user.click(screen.getByRole('button', { name: '切到合成患者 B' }))
  expect(screen.getByRole('region', { name: '当前住院患者' }).textContent).toContain('合成患者 B')
  await finish(f)
  expect(f.posts).toEqual([{ path: '/api/his/v1/inpatient/admissions/admission-A/receive', body: { input: { encounterVersion: '1', bedId: 'feedback-bed' } } }])
  expect(f.receipts).toEqual([f.response])
  expect(sessionStorage.length).toBe(0)
  expect(screen.queryByText('已完成接诊分床 · 合成患者 B')).toBeNull()
  expect(screen.queryByText('已完成本次操作')).toBeNull()
})

it('当前 A 的正式分床确认仍显示 A 的完成和下一步交接', async () => {
  const f = fixture()
  await receive(f)
  await finish(f)
  const title = await screen.findByText('已完成接诊分床 · 合成患者 A')
  expect(within(title.closest<HTMLElement>('[data-slot="toast"]')!).getByText('入科登记已完成')).toBeTruthy()
})

it('医生的 PCI 工作稿保存仍不显示正式完成或交接', async () => {
  const f = fixture('draft')
  await f.user.click(screen.getByRole('button', { name: '保存 PCI 工作稿' }))
  await vi.waitFor(() => expect(f.posts).toHaveLength(1))
  await finish(f)
  expect(screen.queryByText('已保存选型工作稿 · 合成患者 A')).toBeNull()
  expect(screen.queryByText('已完成本次操作')).toBeNull()
})

it('不带 admissionId 的全局时钟命令保持当前页面的完成反馈合同', async () => {
  const f = fixture('clock')
  await f.user.click(screen.getByRole('button', { name: '推进合成时钟' }))
  await vi.waitFor(() => expect(f.posts).toHaveLength(1))
  await f.user.click(screen.getByRole('button', { name: '切到合成患者 B' }))
  await finish(f)
  expect(await screen.findByText('已推进时间 · 合成患者 B')).toBeTruthy()
})

it.each([false, true])('医生在归档=%s时仍能打开本次住院累计用量，状态不伪装成正常跟进', async archived => {
  const f = fixture('usage', archived)
  const usageButton = screen.getByRole('button', { name: '本次住院 AI 用量' })
  expect(f.requested.some(url => url.pathname === '/api/model-usage/overview')).toBe(false)
  await screen.findByText(archived ? '已归档，停止临床分析' : '权限已失效，待交接')
  if (archived) expect(screen.queryByRole('button', { name: '助手自动跟进' })).toBeNull()
  await f.user.click(usageButton)
  const dialog = await screen.findByRole('dialog', { name: '本次住院 AI 用量' })
  expect((await within(dialog).findByLabelText('实际AI请求数')).textContent).toBe('3')
  const overview = f.requested.filter(url => url.pathname === '/api/model-usage/overview')
  expect(overview).toHaveLength(1)
  expect(overview[0]!.searchParams.get('caseId')).toBe('admission-A')
  expect(overview[0]!.searchParams.has('taskId')).toBe(false)
  await f.user.click(within(dialog).getByRole('button', { name: '关闭' }))
  expect(screen.queryByRole('dialog', { name: '本次住院 AI 用量' })).toBeNull()
})

it('停止跟进提交期间保护关闭，失败后保留理由与弹窗内错误', async () => {
  const f = fixture('follow-stop')
  const toggle = screen.getByRole('button', { name: '助手自动跟进' })
  await vi.waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('true'))
  await f.user.click(toggle)
  const dialog = screen.getByRole('dialog', { name: '停止助手自动跟进' })
  await f.user.type(within(dialog).getByLabelText('停止理由（必填）'), '准备交接给下一班医生')
  await f.user.click(within(dialog).getByRole('button', { name: '确认停止' }))
  await vi.waitFor(() => expect(f.posts).toHaveLength(1))
  expect(within(dialog).getByRole('button', { name: '取消' }).hasAttribute('disabled')).toBe(true)
  await f.user.keyboard('{Escape}')
  expect(screen.getByRole('dialog', { name: '停止助手自动跟进' })).toBe(dialog)
  await act(async () => { f.release() })
  await vi.waitFor(() => expect(screen.getByLabelText('写操作状态').textContent).toBe('error'))
  expect(within(dialog).getByRole('alert')).toBeTruthy()
  expect((within(dialog).getByLabelText('停止理由（必填）') as HTMLInputElement).value).toBe('准备交接给下一班医生')
  expect(toggle.getAttribute('aria-pressed')).toBe('true')
})
