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

function mount(requests = [plan], activeSession = session, inProgress: Array<ReturnType<typeof inpatientSurgeryExecutionSchema.parse>> = [], post?: { wait: Promise<void>; fail?: boolean }, reservations: unknown[] = []) {
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
