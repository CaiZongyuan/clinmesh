// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientSurgeryExecutionSchema, inpatientSurgeryRequestSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientMaterialEstimateSchema, inpatientMaterialEstimatesSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientSurgery } from './inpatient-surgery.tsx'
import { InpatientSurgeryDetails } from './inpatient-surgery-details.tsx'
import { InpatientActionOutlet, InpatientActionProvider } from './inpatient-workspace-actions.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const time = '2026-11-03T09:00:00+08:00'
const session: SessionContext = { actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' }, user: { id: 'doctor', name: '住院医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-001', admissionRoute: 'direct', wardId: 'ward-1', organizationId: 'org-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: time, depositFen: 0, chargesFen: 0, versionId: '1' })
const procedure = { id: 'procedure-1', version: 1, coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code: '51.2300', display: '腹腔镜下胆囊切除术', category: '手术', releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://example.com/synthetic', sourceSha256: 'a'.repeat(64), sourceLocator: 'synthetic' }, chargeDefinition: { id: 'procedure-price', priceFen: 10000, unit: '次', synthetic: true, trigger: 'execution' } }
const material = { id: 'material-1', version: 1, display: '合成钛夹', chargeDefinition: { id: 'material-price', priceFen: 2000, unit: '枚', synthetic: true, trigger: 'execution' } }
const plan = inpatientSurgeryRequestSchema.parse({ id: 'request-1', admissionId: admission.id, version: 3, status: 'requested', plannedProcedure: procedure, plannedFor: time, reason: '合成胆囊手术计划', requestedAt: time, requestedBy: 'doctor', organizationId: 'org-1', consentConfirmation: { actorId: 'doctor', practitionerRoleId: 'role-doctor', recordedAt: time, note: '已核实同意书' } })
const clients: QueryClient[] = []

afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.unstubAllGlobals(); sessionStorage.clear() })

it.each(['request', 'correction', 'estimate', 'reservations'] as const)('%s 弹窗的真实写入失败只属于当前患者和当前任务', async kind => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  let currentStay = admission, currentPlanId = plan.id
  const getPlan = () => inpatientSurgeryRequestSchema.parse({ ...plan, id: currentPlanId, admissionId: currentStay.id, status: kind === 'correction' ? 'completed' : 'requested' })
  const getSurgery = () => {
    const use = { id: 'use-scope', item: material, quantity: 1, amountFen: 2000, reservationId: null, recordedAt: time, recordedBy: 'doctor', practitionerRoleId: 'role-doctor', note: '合成原记录', correction: null }
    const execution = { id: `execution-${currentPlanId}`, admissionId: currentStay.id, requestId: currentPlanId, actualProcedure: procedure, performedAt: time, performedBy: 'doctor', practitionerRoleId: 'role-doctor', organizationId: 'org-1', note: '合成手术完成', materials: [{ id: use.id, item: material, quantity: 1, amountFen: 2000 }], materialHistory: [use] }
    return inpatientSurgerySchema.parse({ admissionId: currentStay.id, encounterVersion: '1', virtualTime: time, requests: [getPlan()], executions: kind === 'correction' ? [execution] : [], inProgress: [] })
  }
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/auth/context')) return Response.json(session)
    if (init?.method === 'POST') return Response.json({ error: { code: 'VERSION_CONFLICT', message: '合成当前任务写入失败' } }, { status: 409 })
    if (path.endsWith('/surgeries')) return Response.json(getSurgery())
    if (path.endsWith('/surgery-catalog')) return Response.json({ procedures: [procedure], materials: [material] })
    if (path.endsWith('/drg/reservations')) return Response.json({ admissionId: currentStay.id, encounterVersion: '1', reservations: [], reservationSets: [] })
    return Response.json({ error: { code: 'UNAVAILABLE', message: '合成次级资料暂不可用' } }, { status: 503 })
  }))
  function Harness({ stay, selectedPlan }: { stay: typeof admission; selectedPlan: typeof plan }) {
    const write = useInpatientWriteIntent(session, () => undefined)
    const estimate = inpatientMaterialEstimateSchema.parse({ id: 'estimate-scope', admissionId: stay.id, requestId: selectedPlan.id, version: 2, requestVersion: selectedPlan.version,
      status: 'failed', basisFingerprint: 'a'.repeat(64), failureCode: 'MODEL_FAILED', missing: [], candidates: [], analysis: null, draft: null, candidateItems: [] })
    return <InpatientActionProvider stage="surgery">{kind === 'request' || kind === 'correction'
      ? <InpatientSurgery admission={stay} session={session} locale="zh-CN" write={write} />
      : <InpatientSurgeryDetails key={`${stay.id}:${selectedPlan.id}`} admission={stay} session={session} locale="zh-CN" write={write} plan={selectedPlan} estimate={estimate} selection={undefined} onOpenUsage={undefined} />}
      <InpatientActionOutlet /><output aria-label="失败作用域状态">{write.mutation.status}</output></InpatientActionProvider>
  }
  const view = () => <QueryClientProvider client={client}><Harness stay={currentStay} selectedPlan={getPlan()} /></QueryClientProvider>
  const rendered = render(view()), user = userEvent.setup()
  const open = async () => {
    if (kind === 'request') {
      await user.click(await screen.findByRole('button', { name: '申请手术' }))
      return screen.findByRole('dialog', { name: '申请手术' })
    }
    if (kind === 'correction') {
      await user.click(await screen.findByRole('button', { name: '补登记与更正耗材' }))
      return screen.findByRole('dialog', { name: '术后耗材补登记、更正与历史' })
    }
    if (kind === 'estimate') {
      await user.click(screen.getByRole('button', { name: '预计依据' }))
      return screen.findByRole('dialog', { name: '完整预计依据与扩展参数' })
    }
    await user.click(screen.getByRole('button', { name: '手工预留维护' }))
    const maintenance = await screen.findByRole('dialog', { name: '手工预留维护' })
    const select = await within(maintenance).findByRole('combobox', { name: '预留耗材' })
    select.focus(); await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('option', { name: '合成钛夹' }))
    await user.type(within(maintenance).getByRole('textbox', { name: '预留或释放理由' }), '合成预留失败草稿')
    await user.click(within(maintenance).getByRole('button', { name: '审阅新增预留' }))
    return screen.findByRole('region', { name: '确认耗材预留变更' })
  }
  const dialog = await open()
  if (kind === 'request') {
    within(dialog).getByRole('combobox', { name: '计划术式' }).focus(); await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('option', { name: '51.2300 · 腹腔镜下胆囊切除术' }))
    await user.type(within(dialog).getByLabelText('计划手术时间（上海时间）'), '2026-11-03T10:00')
    await user.type(within(dialog).getByRole('textbox', { name: '手术申请理由' }), '合成申请失败草稿')
    await user.click(within(dialog).getByRole('button', { name: '提交手术申请' }))
  } else if (kind === 'correction') {
    await user.click(within(dialog).getByRole('button', { name: '更正 合成钛夹 × 1' }))
    await user.type(within(dialog).getByRole('textbox', { name: '更正依据' }), '合成更正失败草稿')
    await user.click(within(dialog).getByRole('button', { name: '确认更正' }))
  } else await user.click(within(dialog).getByRole('button', { name: kind === 'estimate' ? '重新预计，保留耗材清单' : '确认预留变更' }))
  await waitFor(() => expect(screen.getByLabelText('失败作用域状态').textContent).toBe('error'))
  expect(within(dialog).getByRole('alert').textContent).toBeTruthy()
  await user.keyboard('{Escape}')
  if (kind === 'reservations') {
    const maintenance = screen.getByRole('dialog', { name: '手工预留维护' })
    await user.click(within(maintenance).getByRole('button', { name: '审阅新增预留' }))
    expect(within(await screen.findByRole('region', { name: '确认耗材预留变更' })).queryByRole('alert')).toBeNull()
    await user.keyboard('{Escape}'); await user.keyboard('{Escape}')
  }
  currentStay = { ...admission, id: 'admission-B', patientId: 'patient-B', patientName: '合成患者B' }
  rendered.rerender(view())
  expect(within(await open()).queryByRole('alert')).toBeNull()
  await user.keyboard('{Escape}')
  if (kind === 'reservations') await user.keyboard('{Escape}')
  if (kind === 'correction' || kind === 'estimate') {
    currentStay = admission; currentPlanId = 'request-other'
    client.setQueryData(['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id, 'surgeries'], getSurgery())
    rendered.rerender(view())
    expect(within(await open()).queryByRole('alert')).toBeNull()
  }
})

it('补登记恢复被拒绝时在原弹窗显示冲突并保留刷新入口和输入', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  let posts = 0, surgeryReads = 0, currentStay = admission
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/auth/context')) return Response.json(session)
    if (path.includes('/command-receipts?')) return Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: '原请求未落地' } }, { status: 404 })
    if (path.endsWith('/surgeries/supplement-material') && init?.method === 'POST') {
      if (++posts === 1) throw new TypeError('合成发送前断线')
      return Response.json({ error: { code: 'INPATIENT_SURGERY_CONFLICT', message: '手术申请版本已变化' } }, { status: 409 })
    }
    if (path.endsWith('/surgeries')) {
      surgeryReads++
      return Response.json(inpatientSurgerySchema.parse({ admissionId: currentStay.id, encounterVersion: '1', virtualTime: time,
        requests: [{ ...plan, admissionId: currentStay.id, status: 'completed' }], inProgress: [], executions: [{
          id: 'execution-recovery', admissionId: currentStay.id, requestId: plan.id, actualProcedure: procedure, performedAt: time,
          performedBy: 'doctor', practitionerRoleId: 'role-doctor', organizationId: 'org-1', note: '合成原手术', materials: [], materialHistory: [],
        }] }))
    }
    if (path.endsWith('/surgery-catalog')) return Response.json({ procedures: [procedure], materials: [material] })
    if (path.endsWith('/drg/reservations')) return Response.json({ admissionId: currentStay.id, encounterVersion: '1', reservations: [], reservationSets: [] })
    return Response.json({ error: { code: 'UNAVAILABLE', message: '合成次级资料暂不可用' } }, { status: 503 })
  }))
  function Harness({ stay }: { stay: typeof admission }) {
    const write = useInpatientWriteIntent(session, () => undefined)
    return <InpatientActionProvider stage="surgery"><InpatientSurgery admission={stay} session={session} locale="zh-CN" write={write} /></InpatientActionProvider>
  }
  const view = () => <QueryClientProvider client={client}><Harness stay={currentStay} /></QueryClientProvider>
  const rendered = render(view()), user = userEvent.setup()
  const open = async () => {
    await user.click(await screen.findByRole('button', { name: '补登记与更正耗材' }))
    return screen.findByRole('dialog', { name: '术后耗材补登记、更正与历史' })
  }
  const dialog = await open()
  within(dialog).getByRole('combobox', { name: '耗材' }).focus(); await user.keyboard('{Enter}')
  await user.click(await screen.findByRole('option', { name: '合成钛夹' }))
  await user.type(within(dialog).getByRole('textbox', { name: '补登记依据' }), '合成漏记使用依据')
  await user.click(within(dialog).getByRole('button', { name: '确认补登记' }))
  await user.click(await within(dialog).findByRole('button', { name: '恢复原住院操作' }))
  const conflict = await within(dialog).findByRole('alert')
  expect(conflict.textContent).toContain('手术申请或准备状态已变化，请刷新后重新核对。')
  expect(within(dialog).queryByRole('button', { name: '恢复原住院操作' })).toBeNull()
  expect(within(dialog).getByRole('button', { name: '确认补登记' }).hasAttribute('disabled')).toBe(false)
  const readsBeforeRefresh = surgeryReads
  await user.click(within(conflict).getByRole('button', { name: '刷新目录与记录，保留编辑' }))
  await waitFor(() => expect(surgeryReads).toBeGreaterThan(readsBeforeRefresh))
  expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: '补登记依据' }).value).toBe('合成漏记使用依据')
  await user.keyboard('{Escape}')
  currentStay = { ...admission, id: 'admission-B', patientId: 'patient-B', patientName: '合成患者B' }
  rendered.rerender(view())
  expect(within(await open()).queryByRole('alert')).toBeNull()
})

it('预计未决请求保留原任务恢复入口，手工预留只在打开时查询并保留关闭前草稿', async () => {
  const reads: string[] = [], posts: string[] = [], onOpenUsage = vi.fn()
  const estimate = inpatientMaterialEstimateSchema.parse({ id: 'estimate-unknown', admissionId: admission.id, requestId: plan.id,
    version: 2, requestVersion: plan.version, status: 'unknown', basisFingerprint: 'a'.repeat(64), failureCode: 'OUTCOME_UNKNOWN',
    missing: [], candidates: [], analysis: null, draft: null, candidateItems: [] })
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push(path)
    reads.push(path)
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '1', virtualTime: time, requests: [plan], executions: [], inProgress: [] })
    if (path.endsWith('/surgery-catalog')) return Response.json({ procedures: [procedure], materials: [material] })
    if (path.endsWith('/drg/reservations')) return Response.json({ admissionId: admission.id, encounterVersion: '1', reservations: [], reservationSets: [] })
    throw new Error(`Unexpected request ${path}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Harness({ stay }: { stay: typeof admission }) {
    const write = useInpatientWriteIntent(session, () => undefined)
    return <InpatientSurgeryDetails admission={stay} session={session} locale="zh-CN" write={write} plan={plan} estimate={estimate} selection={undefined} onOpenUsage={onOpenUsage} />
  }
  const view = (stay = admission) => <QueryClientProvider client={client}><Harness stay={stay} /></QueryClientProvider>
  const rendered = render(view())
  expect(reads).toEqual([])
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '预计依据' }))
  expect(screen.queryByRole('button', { name: '重新预计，保留耗材清单' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '核查原预计请求' }))
  expect(onOpenUsage).toHaveBeenCalledWith('estimate-unknown', 'estimate')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  const trigger = screen.getByRole('button', { name: '手工预留维护' })
  await user.click(trigger)
  await screen.findByRole('combobox', { name: '预留耗材' })
  await waitFor(() => expect(reads).toHaveLength(3))
  await user.type(screen.getByRole('textbox', { name: '预留或释放理由' }), '核对合成预留的未提交草稿')
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await client.invalidateQueries({ queryKey: ['inpatient'] })
  expect(reads).toHaveLength(3)
  await user.click(trigger)
  expect(await screen.findByRole<HTMLInputElement>('textbox', { name: '预留或释放理由' })).toHaveProperty('value', '核对合成预留的未提交草稿')
  rendered.rerender(view({ ...admission, recordStatus: 'archived' }))
  expect(screen.getByRole('spinbutton', { name: '预留数量' }).closest('fieldset')?.disabled).toBe(true)
  expect(posts).toEqual([])
})

function mount(requests = [plan], activeSession = session, inProgress: Array<ReturnType<typeof inpatientSurgeryExecutionSchema.parse>> = [], post?: { wait: Promise<void>; fail?: boolean }, reservations: unknown[] = [], executions: Array<ReturnType<typeof inpatientSurgeryExecutionSchema.parse>> = []) {
  const data = inpatientSurgerySchema.parse({ admissionId: admission.id, encounterVersion: '1', virtualTime: time, requests, executions, inProgress })
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
    if (path.endsWith('/surgery-catalog')) return Response.json({ procedures: [procedure], materials: [material] })
    if (path.endsWith('/drg/reservations')) return Response.json({ admissionId: admission.id, encounterVersion: '1', reservations, reservationSets: [] })
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

it('空态底栏申请入口关闭后归还焦点并保留申请理由', async () => {
  mount([])
  const action = await screen.findByRole('region', { name: '当前操作' })
  const trigger = within(action).getByRole('button', { name: '申请手术' }), user = userEvent.setup()
  await user.click(trigger)
  await user.type(screen.getByRole('textbox', { name: '手术申请理由' }), '空态合成申请草稿')
  await user.keyboard('{Escape}')
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  await user.click(trigger)
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '手术申请理由' }).value).toBe('空态合成申请草稿')
})

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
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '申请手术' }))
  expect(await screen.findByRole('dialog', { name: '申请手术' })).toBeDefined()
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
  expect(screen.queryByRole('button', { name: '申请手术' })).toBeNull()
  expect(screen.queryByRole('button', { name: '整台补录' })).toBeNull()
})

it('手术进行中隐藏术前耗材预计并显示本台耗材与逐笔登记，整笔用完预留后改数量更正仍保留原预留关联', async () => {
  const use = { id: 'use-1', item: material, quantity: 2, amountFen: 4000, reservationId: 'reservation-1', recordedAt: time, recordedBy: 'doctor', practitionerRoleId: 'role-doctor', note: '原登记两枚', correction: null }
  const execution = inpatientSurgeryExecutionSchema.parse({ id: 'execution-1', admissionId: admission.id, requestId: plan.id, actualProcedure: procedure, performedAt: time, performedBy: 'doctor', practitionerRoleId: 'role-doctor', organizationId: 'org-1', note: '合成手术已开始', materials: [{ id: use.id, item: material, quantity: 2, amountFen: 4000 }], materialHistory: [use] })
  const second = inpatientSurgeryRequestSchema.parse({ ...plan, id: 'request-2', reason: '第二台合成手术计划' })
  const { posts } = mount([plan, second], session, [execution], undefined, [
    { id: 'reservation-1', admissionId: admission.id, requestId: plan.id, materialId: material.id, materialDisplay: material.display, unit: '枚', catalogVersion: 1, priceFen: 2000, quantity: 2, consumedQuantity: 2, remainingQuantity: 0, status: 'replaced', version: 4, reason: '原计划预留', createdAt: time },
    { id: 'reservation-2', admissionId: admission.id, requestId: plan.id, materialId: material.id, materialDisplay: material.display, unit: '枚', catalogVersion: 1, priceFen: 2000, quantity: 1, consumedQuantity: 0, remainingQuantity: 1, status: 'reserved', version: 1, reason: '另一条未用预留', createdAt: time },
  ])
  const user = userEvent.setup()
  expect(await screen.findByRole('combobox', { name: '耗材' })).toBeDefined()
  expect(await screen.findByText(/剩 1/)).toBeDefined()
  expect(screen.getByRole('button', { name: '登记这笔' })).toBeDefined()
  expect(screen.getByRole('region', { name: '本台耗材' })).toBeDefined()
  expect(screen.queryByRole('region', { name: '术前耗材预计' })).toBeNull()
  expect(screen.queryByRole('region', { name: '当前手术计划' })).toBeNull()
  expect(screen.getByRole('button', { name: '核实最终耗材并完成手术' })).toBeDefined()
  await user.click(screen.getByRole('button', { name: '更正 合成钛夹 × 2' }))
  screen.getByRole('combobox', { name: '更正方式' }).focus()
  await user.keyboard('{Enter}')
  await user.click(await screen.findByRole('option', { name: '改数量（合成钛夹）' }))
  const qty = screen.getByRole('spinbutton', { name: '更正后数量' })
  await user.clear(qty); await user.type(qty, '1')
  await user.type(screen.getByRole('textbox', { name: '更正依据' }), '核实实际仅用一枚，保留原预留关联')
  await user.click(screen.getByRole('button', { name: '确认更正' }))
  await waitFor(() => expect(posts).toHaveLength(1))
  expect(posts[0]).toMatchObject({ path: '/api/his/v1/inpatient/admissions/admission-1/surgeries/correct-material',
    body: { input: { materialUseId: 'use-1', replacement: { materialId: material.id, catalogVersion: 1, quantity: 1, reservationId: 'reservation-1', expectedReservationVersion: 4 } } } })
  await user.click(screen.getByText('其他待实施手术', { selector: 'summary' }))
  const current = await screen.findByRole('region', { name: '当前手术计划' })
  expect(within(current).getByText(/第二台合成手术计划/)).toBeDefined()
  expect(screen.getByRole('combobox', { name: '耗材' })).toBeDefined()
})

it.each(['success', 'unknown', 'changed-session'])('申请弹窗在%s时保护提交并隔离上下文，失败后保留输入', async outcome => {
  let finish: () => void = () => undefined
  const wait = new Promise<void>(resolve => { finish = resolve })
  const { posts, changeSession } = mount([plan], session, [], { wait, fail: outcome === 'unknown' })
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '申请手术' }))
  const procedureSelect = await screen.findByRole('combobox', { name: '计划术式' })
  procedureSelect.focus()
  await user.keyboard('{Enter}')
  await user.click(await screen.findByRole('option', { name: '51.2300 · 腹腔镜下胆囊切除术' }))
  const planned = screen.getByLabelText('计划手术时间（上海时间）')
  await user.type(planned, '2026-11-03T10:00')
  await user.type(screen.getByRole('textbox', { name: '手术申请理由' }), '保留原手术申请草稿')
  await user.click(screen.getByRole('button', { name: '提交手术申请' }))
  await waitFor(() => expect(posts).toHaveLength(1))
  await user.keyboard('{Escape}')
  expect(screen.getByRole('dialog', { name: '申请手术' })).toBeDefined()
  if (outcome === 'changed-session') changeSession({ ...session, actor: { ...session.actor, actorId: 'other-doctor', practitionerRoleId: 'other-doctor-role' } })
  finish()
  if (outcome === 'success' || outcome === 'changed-session') {
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '申请手术' })).toBeNull())
    expect(await screen.findByRole('button', { name: '开始手术逐笔登记' })).toBeDefined()
    await waitFor(() => expect(screen.getByRole('button', { name: '申请手术' }).hasAttribute('disabled')).toBe(false))
    await user.click(screen.getByRole('button', { name: '申请手术' }))
  } else {
    await waitFor(() => expect(screen.getByLabelText('写入状态').textContent).toBe(outcome === 'unknown' ? 'error' : 'success'))
    expect(within(screen.getByRole('dialog', { name: '申请手术' })).getByRole('alert')).toBeDefined()
  }
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '手术申请理由' }).value).toBe(outcome === 'changed-session' ? '' : '保留原手术申请草稿')
})

it.each([null, '盒'])('补登记不提供计费单位未知或不一致（%s）的预留', async unit => {
  const completed = inpatientSurgeryRequestSchema.parse({ ...plan, status: 'completed' })
  const execution = inpatientSurgeryExecutionSchema.parse({ id: 'execution-unit', admissionId: admission.id, requestId: plan.id,
    actualProcedure: procedure, performedAt: time, performedBy: 'doctor', practitionerRoleId: 'role-doctor', organizationId: 'org-1', note: '合成原手术', materials: [], materialHistory: [] })
  mount([completed], session, [], undefined, [{ id: 'reservation-unit', admissionId: admission.id, requestId: plan.id,
    materialId: material.id, materialDisplay: material.display, catalogVersion: 1, unit, quantity: 2, consumedQuantity: 0,
    remainingQuantity: 2, version: 1, priceFen: 2000, status: 'reserved', reason: '合成旧计费单位预留', createdAt: time }], [execution])
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '补登记与更正耗材' }))
  const dialog = await screen.findByRole('dialog', { name: '术后耗材补登记、更正与历史' })
  within(dialog).getByRole('combobox', { name: '耗材' }).focus(); await user.keyboard('{Enter}')
  await user.click(await screen.findByRole('option', { name: /^合成钛夹/ }))
  within(dialog).getByRole('combobox', { name: '预留处理' }).focus(); await user.keyboard('{Enter}')
  const options = await screen.findAllByRole('option')
  expect(options.map(option => option.textContent)).toEqual(['额外使用，不消耗预留'])
})

it('有后续待做手术时仍可选择原已完成手术补登记', async () => {
  const completed = inpatientSurgeryRequestSchema.parse({ ...plan, status: 'completed' })
  const newer = inpatientSurgeryRequestSchema.parse({ ...completed, id: 'request-newer' })
  const pending = inpatientSurgeryRequestSchema.parse({ ...plan, id: 'request-pending', status: 'ready' })
  const original = inpatientSurgeryExecutionSchema.parse({ id: 'execution-original', admissionId: admission.id, requestId: completed.id,
    actualProcedure: procedure, performedAt: time, performedBy: 'doctor', practitionerRoleId: 'role-doctor', organizationId: 'org-1', note: '合成原手术', materials: [], materialHistory: [] })
  const later = inpatientSurgeryExecutionSchema.parse({ ...original, id: 'execution-newer', requestId: newer.id })
  mount([completed, newer, pending], session, [], undefined, [], [original, later])
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '补登记与更正耗材' }))
  const dialog = await screen.findByRole('dialog', { name: '术后耗材补登记、更正与历史' })
  const selector = within(dialog).getByRole('combobox', { name: '已完成手术' })
  selector.focus(); await user.keyboard('{Enter}')
  await user.click((await screen.findAllByRole('option'))[0]!)
  expect(within(dialog).getByLabelText('补登记依据').id).toContain(original.id)
  expect(within(dialog).getByRole('button', { name: '确认补登记' })).toBeDefined()
})

it('已完成手术保留最终汇总，术后更正和历史按需在弹窗内查看', async () => {
  const use = { id: 'use-postop', item: material, quantity: 1, amountFen: 2000, reservationId: null, recordedAt: time, recordedBy: 'doctor', practitionerRoleId: 'role-doctor', note: '合成术后原记录', correction: null }
  const completed = inpatientSurgeryRequestSchema.parse({ ...plan, status: 'completed' })
  const execution = inpatientSurgeryExecutionSchema.parse({ id: 'execution-postop', admissionId: admission.id, requestId: plan.id, actualProcedure: procedure, performedAt: time, performedBy: 'doctor', practitionerRoleId: 'role-doctor', organizationId: 'org-1', note: '合成手术完成', materials: [{ id: use.id, item: material, quantity: 1, amountFen: 2000 }], materialHistory: [use] })
  mount([completed], session, [], undefined, [], [execution])
  const user = userEvent.setup()
  expect(await screen.findByRole('region', { name: '最终耗材' })).toBeDefined()
  expect(screen.queryByRole('region', { name: '本台耗材' })).toBeNull()
  const trigger = screen.getByRole('button', { name: '补登记与更正耗材' })
  await user.click(trigger)
  const dialog = await screen.findByRole('dialog', { name: '术后耗材补登记、更正与历史' })
  await user.click(within(dialog).getByRole('button', { name: '更正 合成钛夹 × 1' }))
  await user.type(within(dialog).getByRole('textbox', { name: '更正依据' }), '核对后撤销原记录')
  expect(within(dialog).getByRole('button', { name: '确认更正' })).toBeDefined()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(trigger)
  await user.click(trigger)
  expect(within(await screen.findByRole('dialog', { name: '术后耗材补登记、更正与历史' })).getByRole<HTMLInputElement>('textbox', { name: '更正依据' }).value).toBe('核对后撤销原记录')
})

it('第 ② 步编辑耗材清单后先保存草稿并以新 revision 确认预留，确认成功后再进入第 ③ 步', async () => {
  const evidence = { id: 'estimate-evidence-1', version: 'v1', synthetic: true, scope: '有限合成单病变', applicability: '仅支持合成方案', compatibility: '仅核对已发布组合', specification: '合成钛夹', quantityBasis: '单次手术一枚', sourceLocator: 'synthetic:estimate-1' }
  let currentEstimate = inpatientMaterialEstimateSchema.parse({
    id: 'estimate-1',
    admissionId: admission.id,
    requestId: plan.id,
    version: 1,
    requestVersion: plan.version,
    status: 'succeeded',
    basisFingerprint: 'a'.repeat(64),
    failureCode: null,
    missing: [],
    candidates: [{ materialId: material.id, catalogVersion: 1, item: material, evidence, quantityBasis: evidence.quantityBasis, expectedQuantity: 1, eligibility: 'valid', missing: [] }],
    analysis: { id: 'analysis-1', revision: 1, basisFingerprint: 'a'.repeat(64), stage: 'preoperative', createdAt: time, model: 'synthetic-estimate-model', items: [{ materialId: material.id, catalogVersion: 1, display: material.display, unit: '枚', quantity: 1, unitPriceFen: 2000, estimatedFen: 2000, reason: '原预计说明', quantityBasis: evidence.quantityBasis, evidenceIds: [evidence.id] }], sources: { requestId: plan.id, evidencePackageId: 'estimate-evidence', evidencePackageVersion: 'v1', materialEvidence: [evidence] } },
    draft: { revision: 1, basisFingerprint: 'a'.repeat(64), analysisId: 'analysis-1', items: [{ materialId: material.id, catalogVersion: 1, quantity: 1, reason: '原预计说明' }], note: '', edited: false, updatedAt: time, updatedBy: 'doctor', confirmedRevision: null, reservationIds: [] },
    candidateItems: [],
  })
  const data = inpatientSurgerySchema.parse({ admissionId: admission.id, encounterVersion: '1', virtualTime: time, requests: [plan], executions: [], inProgress: [] })
  const posts: Array<{ path: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/auth/context')) return Response.json(session)
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      posts.push({ path, body })
      if (path.endsWith('/material-estimates/save')) {
        currentEstimate = inpatientMaterialEstimateSchema.parse({
          ...currentEstimate,
          version: 2,
          draft: { ...currentEstimate.draft!, revision: 2, items: body.input.items, note: body.input.note, edited: true },
        })
        return Response.json({ data: currentEstimate, auditId: 'synthetic-audit-save', requestId: 'synthetic-receipt-save', effects: [], warnings: [] })
      }
      if (path.endsWith('/material-estimates/confirm')) {
        currentEstimate = inpatientMaterialEstimateSchema.parse({
          ...currentEstimate,
          version: 3,
          draft: { ...currentEstimate.draft!, confirmedRevision: 2 },
        })
        return Response.json({ data: currentEstimate, auditId: 'synthetic-audit-confirm', requestId: 'synthetic-receipt-confirm', effects: [], warnings: [] })
      }
      return Response.json({ data, auditId: 'synthetic-audit', requestId: 'synthetic-receipt', effects: [], warnings: [] })
    }
    if (path.endsWith('/surgeries')) return Response.json(data)
    if (path.endsWith('/surgery-catalog')) return Response.json({ procedures: [procedure], materials: [material] })
    if (path.endsWith('/drg/reservations')) return Response.json({ admissionId: admission.id, encounterVersion: '1', reservations: [], reservationSets: [{ requestId: plan.id, fingerprint: 'c'.repeat(64) }] })
    if (path.endsWith('/material-estimates')) return Response.json(inpatientMaterialEstimatesSchema.parse({ admissionId: admission.id, estimates: [currentEstimate], unprepared: [] }))
    return Response.json({ error: { code: 'UNAVAILABLE', message: '合成次级资料暂不可用' } }, { status: 503 })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Harness() {
    const write = useInpatientWriteIntent(session, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <InpatientActionProvider stage="surgery"><InpatientSurgery admission={admission} session={session} locale="zh-CN" write={write} /><InpatientActionOutlet /></InpatientActionProvider>
  }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  const user = userEvent.setup()
  await screen.findByRole('region', { name: '当前手术计划' })
  const stepTwo = await screen.findByRole('region', { name: '手术耗材' })
  const qtyInput = await within(stepTwo).findByRole('spinbutton', { name: '预计数量：合成钛夹' })
  await user.clear(qtyInput)
  await user.type(qtyInput, '2')
  const noteInput = within(stepTwo).getByRole('textbox', { name: '耗材清单说明' })
  await user.type(noteInput, '医生核对后更新说明')
  await user.click(screen.getByRole('button', { name: '确认并预留' }))
  await waitFor(() => expect(posts).toHaveLength(2))
  expect(posts[0]).toMatchObject({
    path: '/api/his/v1/inpatient/admissions/admission-1/material-estimates/save',
    body: { input: { requestId: plan.id, expectedVersion: 1, expectedDraftRevision: 1 } },
  })
  expect(posts[1]).toMatchObject({
    path: '/api/his/v1/inpatient/admissions/admission-1/material-estimates/confirm',
    body: { input: { requestId: plan.id, expectedVersion: 2, expectedDraftRevision: 2 } },
  })
  expect(await screen.findByRole('region', { name: '当前手术计划' })).toBeDefined()
})
