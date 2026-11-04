// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientSurgeryExecutionSchema, inpatientSurgeryRequestSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientSurgery } from './inpatient-surgery.tsx'
import { InpatientActionOutlet, InpatientActionProvider } from './inpatient-workspace-actions.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const time = '2026-11-03T09:00:00+08:00'
const session: SessionContext = { actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' }, user: { id: 'doctor', name: '住院医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-001', admissionRoute: 'direct', wardId: 'ward-1', organizationId: 'org-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: time, depositFen: 0, chargesFen: 0, versionId: '1' })
const procedure = { id: 'procedure-1', version: 1, coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code: '51.2300', display: '腹腔镜下胆囊切除术', category: '手术', releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://example.com/synthetic', sourceSha256: 'a'.repeat(64), sourceLocator: 'synthetic' }, chargeDefinition: { id: 'procedure-price', priceFen: 10000, unit: '次', synthetic: true, trigger: 'execution' } }
const plan = inpatientSurgeryRequestSchema.parse({ id: 'request-1', admissionId: admission.id, version: 3, status: 'requested', plannedProcedure: procedure, plannedFor: time, reason: '合成胆囊手术计划', requestedAt: time, requestedBy: 'doctor', organizationId: 'org-1', consentConfirmation: { actorId: 'doctor', practitionerRoleId: 'role-doctor', recordedAt: time, note: '已核实同意书' } })
const clients: QueryClient[] = []

afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.unstubAllGlobals(); sessionStorage.clear() })

function mount(requests = [plan], activeSession = session, inProgress: Array<ReturnType<typeof inpatientSurgeryExecutionSchema.parse>> = [], post?: { wait: Promise<void>; fail?: boolean }) {
  const data = inpatientSurgerySchema.parse({ admissionId: admission.id, encounterVersion: '1', virtualTime: time, requests, executions: [], inProgress })
  const posts: Array<{ path: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/auth/context')) return Response.json(activeSession)
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(String(init.body)) })
      await post?.wait
      if (post?.fail) throw new TypeError('合成回执未知')
      return Response.json({ data, auditId: 'synthetic-audit', requestId: 'synthetic-receipt', effects: [], warnings: [] })
    }
    if (path.endsWith('/surgeries')) return Response.json(data)
    if (path.endsWith('/surgery-catalog')) return Response.json({ procedures: [procedure], materials: [] })
    if (path.endsWith('/drg/reservations')) return Response.json({ admissionId: admission.id, encounterVersion: '1', reservations: [], reservationSets: [] })
    return Response.json({ error: { code: 'UNAVAILABLE', message: '合成次级资料暂不可用' } }, { status: 503 })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Harness({ sessionContext }: { sessionContext: SessionContext }) {
    const write = useInpatientWriteIntent(sessionContext, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <InpatientActionProvider stage="surgery"><InpatientSurgery admission={admission} session={sessionContext} locale="zh-CN" write={write} /><InpatientActionOutlet /><output aria-label="写入状态">{write.mutation.status}</output></InpatientActionProvider>
  }
  const view = (sessionContext: SessionContext) => <QueryClientProvider client={client}><Harness sessionContext={sessionContext} /></QueryClientProvider>
  const rendered = render(view(activeSession))
  return { posts, changeSession: (sessionContext: SessionContext) => rendered.rerender(view(sessionContext)) }
}

it('默认突出当前手术计划和真实准备清单，实际术式仅在开始手术弹窗出现且术前耗材预计收为一块', async () => {
  mount()
  const current = await screen.findByRole('region', { name: '当前手术计划' })
  expect(screen.queryByRole('combobox', { name: '实际术式' })).toBeNull()
  expect(screen.queryByRole('combobox', { name: '计划术式' })).toBeNull()
  expect(screen.queryByRole('combobox', { name: '手术耗材' })).toBeNull()
  expect(within(current).getByRole('heading', { name: '腹腔镜下胆囊切除术' })).toBeDefined()
  const preparation = screen.getByRole('region', { name: '开始手术还差' })
  const action = screen.getByRole('region', { name: '当前操作' })
  expect(current.compareDocumentPosition(preparation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(preparation.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(within(preparation).getByText('术前核对', { exact: true })).toBeDefined()
  expect(within(preparation).getByText('病区护士', { exact: true })).toBeDefined()
  expect(within(preparation).getByText('手术知情同意书已签', { exact: true })).toBeDefined()
  expect(within(preparation).getByText('住院医生', { exact: true })).toBeDefined()
  expect(within(preparation).getByText('已完成', { exact: true })).toBeDefined()
  expect(preparation.querySelector('time')?.getAttribute('dateTime')).toBe(time)
  expect(preparation.textContent).toContain('病区护士')
  expect(preparation.textContent).toContain('待完成')
  expect(preparation.textContent).toContain('住院医生')
  expect(screen.getByRole('button', { name: '开始手术逐笔登记' }).hasAttribute('disabled')).toBe(true)
  expect(screen.queryByRole('button', { name: '整台补录' })).toBeNull()
  expect(screen.getByRole('region', { name: '术前耗材预计' })).toBeDefined()
  const user = userEvent.setup()
  await user.click(screen.getByText('新增手术申请', { selector: 'summary' }))
  expect(await screen.findByRole('combobox', { name: '计划术式' })).toBeDefined()
})

it('可开始阶段在操作栏提供整台补录次级入口，开始手术弹窗默认带入计划术式并提交开始说明', async () => {
  const ready = inpatientSurgeryRequestSchema.parse({ ...plan, status: 'ready', preopCheck: { actorId: 'nurse', practitionerRoleId: 'role-nurse', recordedAt: time, note: '术前核对已完成' } })
  const second = inpatientSurgeryRequestSchema.parse({ ...ready, id: 'request-2', version: 7, reason: '第二台合成手术计划' })
  const { posts } = mount([ready, second])
  const user = userEvent.setup()
  const select = async (name: string, option: string | RegExp) => {
    screen.getByRole('combobox', { name }).focus()
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('option', { name: option }))
  }
  const current = await screen.findByRole('region', { name: '当前手术计划' })
  await user.click(within(current).getByRole('button', { name: '取消申请' }))
  await user.type(within(current).getByRole('textbox', { name: '取消理由' }), '第一台保留取消草稿')
  await select('当前计划', /第二台合成手术计划/)
  expect(within(current).queryByRole('textbox', { name: '取消理由' })).toBeNull()
  await select('当前计划', /合成胆囊手术计划/)
  expect(within(current).getByRole<HTMLInputElement>('textbox', { name: '取消理由' }).value).toBe('第一台保留取消草稿')
  await select('当前计划', /第二台合成手术计划/)
  expect(screen.getByRole('button', { name: '整台补录' })).toBeDefined()
  const start = screen.getByRole('button', { name: '开始手术逐笔登记' })
  expect(start.hasAttribute('disabled')).toBe(false)
  await user.click(start)
  const dialog = await screen.findByRole('dialog', { name: '开始手术' })
  expect(within(dialog).getByRole('combobox', { name: '实际术式' }).textContent).toContain('腹腔镜下胆囊切除术')
  await user.type(within(dialog).getByRole('textbox', { name: '开始说明' }), '第二台实际开始依据')
  await user.click(within(dialog).getByRole('button', { name: '开始手术' }))
  await waitFor(() => expect(posts).toHaveLength(1))
  expect(posts).toEqual([{ path: '/api/his/v1/inpatient/admissions/admission-1/surgeries/start', body: { input: { requestId: 'request-2', expectedRequestVersion: 7, note: '第二台实际开始依据', procedureId: 'procedure-1', catalogVersion: 1 } } }])
})

it('护士仍可核对当前计划，但不出现医生开始、整台补录或新增申请入口', async () => {
  const nurse: SessionContext = { ...session, actor: { ...session.actor, actorId: 'nurse', practitionerRoleId: 'role-nurse', roleCode: 'ward-nurse' } }
  mount([plan], nurse)
  const check = await screen.findByRole('button', { name: '术前核对' })
  expect(check.hasAttribute('disabled')).toBe(true)
  expect(screen.queryByRole('combobox', { name: '实际术式' })).toBeNull()
  expect(screen.queryByRole('button', { name: '开始手术逐笔登记' })).toBeNull()
  expect(screen.queryByText('新增手术申请', { selector: 'summary' })).toBeNull()
  expect(screen.queryByRole('button', { name: '整台补录' })).toBeNull()
})

it('手术进行中隐藏术前耗材预计并显示本台耗材与逐笔登记，其他计划仍可从次级入口继续准备', async () => {
  const execution = inpatientSurgeryExecutionSchema.parse({ id: 'execution-1', admissionId: admission.id, requestId: plan.id, actualProcedure: procedure, performedAt: time, performedBy: 'doctor', practitionerRoleId: 'role-doctor', organizationId: 'org-1', note: '合成手术已开始', materials: [], materialHistory: [] })
  const second = inpatientSurgeryRequestSchema.parse({ ...plan, id: 'request-2', reason: '第二台合成手术计划' })
  mount([plan, second], session, [execution])
  expect(await screen.findByRole('combobox', { name: '耗材' })).toBeDefined()
  expect(screen.getByRole('button', { name: '登记这笔' })).toBeDefined()
  expect(screen.getByRole('region', { name: '本台耗材' })).toBeDefined()
  expect(screen.queryByRole('region', { name: '术前耗材预计' })).toBeNull()
  expect(screen.queryByRole('region', { name: '当前手术计划' })).toBeNull()
  expect(screen.getByRole('button', { name: '核实最终耗材并完成手术' })).toBeDefined()
  await userEvent.setup().click(screen.getByText('其他待实施手术', { selector: 'summary' }))
  const current = await screen.findByRole('region', { name: '当前手术计划' })
  expect(within(current).getByText(/第二台合成手术计划/)).toBeDefined()
  expect(screen.getByRole('combobox', { name: '耗材' })).toBeDefined()
})

it.each(['success', 'unknown', 'changed-session'])('新申请确认结果为%s时只收起原上下文已成功的表单并保留输入', async outcome => {
  let finish: () => void = () => undefined
  const wait = new Promise<void>(resolve => { finish = resolve })
  const { posts, changeSession } = mount([plan], session, [], { wait, fail: outcome === 'unknown' })
  const user = userEvent.setup()
  await user.click(screen.getByText('新增手术申请', { selector: 'summary' }))
  const procedureSelect = await screen.findByRole('combobox', { name: '计划术式' })
  procedureSelect.focus()
  await user.keyboard('{Enter}')
  await user.click(await screen.findByRole('option', { name: '51.2300 · 腹腔镜下胆囊切除术' }))
  const planned = screen.getByLabelText('计划手术时间（上海时间）')
  await user.type(planned, '2026-11-03T10:00')
  await user.type(screen.getByRole('textbox', { name: '手术申请理由' }), '保留原手术申请草稿')
  await user.click(screen.getByRole('button', { name: '申请手术' }))
  await waitFor(() => expect(posts).toHaveLength(1))
  if (outcome === 'changed-session') changeSession({ ...session, actor: { ...session.actor, actorId: 'other-doctor', practitionerRoleId: 'other-doctor-role' } })
  finish()
  const disclosure = screen.getByText('新增手术申请', { selector: 'summary' }).closest('details')!
  if (outcome === 'success') {
    await waitFor(() => expect(disclosure.open).toBe(false))
    expect(screen.getByRole('button', { name: '开始手术逐笔登记' })).toBeDefined()
    await user.click(screen.getByText('新增手术申请', { selector: 'summary' }))
  } else {
    await waitFor(() => expect(screen.getByLabelText('写入状态').textContent).toBe(outcome === 'unknown' ? 'error' : 'success'))
    expect(disclosure.open).toBe(true)
  }
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '手术申请理由' }).value).toBe('保留原手术申请草稿')
})
