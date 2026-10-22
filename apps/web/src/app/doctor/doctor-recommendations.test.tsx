// @vitest-environment jsdom
import { doctorRecommendationStateSchema, confirmDoctorPreparationRequestSchema, type DoctorRecommendationState } from '@clinmesh/contracts/doctor-recommendations'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { act, cleanup, fireEvent, isInaccessible, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DoctorPreparationProvider, useDoctorPreparation } from './doctor-preparation-state.tsx'
import { DoctorRecommendationsPanel } from './doctor-recommendations.tsx'
import { DoctorOrderWorkspace } from './doctor-order-workspace.tsx'

function state(overrides: Partial<DoctorRecommendationState> = {}): DoctorRecommendationState {
  return doctorRecommendationStateSchema.parse({
    caseId: 'case-fever', kind: 'diagnosis', encounterId: 'encounter-fever', encounterVersion: '2',
    inputFingerprint: 'a'.repeat(64), status: 'ready', generation: 1, stale: false, missingInformation: [],
    items: [{
      id: 'recommendation-fever', kind: 'diagnosis', role: 'primary', catalogItemId: 'diagnosis-fever', label: '发热，未特指',
      rationale: '现有资料支持症状性候选，仍须核实病因。', supportingInformation: ['合成患者自述发热伴咳嗽。'],
      opposingInformation: ['尚无病原学检查结果。'], missingInformation: ['待核实病原学资料。'],
      guidelineEvidenceIds: ['nhc-influenza-2025-diagnosis'], caseEvidenceIds: ['patient-statement-fever'],
      referenceConcept: { id: 'diagnosis-fever', code: 'R50.9', display: '发热，未特指',
        sourceLocator: 'operational:diagnosis_catalog', system: 'http://hl7.org/fhir/sid/icd-10', version: '1' },
    }],
    guidelines: [{
      id: 'nhc-influenza-2025-diagnosis', title: '流行性感冒诊疗方案（2025 年版）',
      publisher: '国家卫生健康委办公厅、国家中医药局综合司', documentType: 'official-protocol', version: '2025',
      publishedAt: '2025-01-20', locator: '第六节“诊断”，印刷第 5 页',
      scope: '流感诊疗；需结合流行病学、临床表现和病原学资料。',
      text: '主要结合流行病学史、临床表现和病原学检查进行诊断。',
      url: 'https://www.nhc.gov.cn/ylyjs/zcwj/202501/f8fcecca59a048bebc4a71847ce57594/files/1741764832851_94226.pdf',
      sourceHash: 'd19f8cba72af08fd11fe17c0d6c3614c9aaac8d8c77fa803e7e9b999abea1125',
    }],
    caseEvidence: [{ id: 'patient-statement-fever', kind: 'consultation', label: '合成患者回答',
      text: '合成患者自述发热伴咳嗽三天，近期接触流感病例，尚无病原学结果。' }],
    ...overrides,
  })
}

function props(overrides: Partial<ComponentProps<typeof DoctorRecommendationsPanel>> = {}): ComponentProps<typeof DoctorRecommendationsPanel> {
  return { caseId: 'case-fever', kind: 'diagnosis', enabled: true, scope: 'workspace-demo:epoch-1:doctor:case-fever', inputRevision: 'case-source-1', ...overrides }
}
function prescriptionState(overrides: Partial<DoctorRecommendationState> = {}): DoctorRecommendationState {
  const first = state().items[0]!
  if (first.kind !== 'diagnosis') throw new Error('Expected diagnosis fixture')
  const { role: _role, referenceConcept: _referenceConcept, ...common } = first
  return state({ kind: 'prescription', items: [{ ...common, kind: 'prescription', id: 'prescription-1', catalogItemId: 'medication-1', label: '合成药品',
    doseText: '5 mg', frequencyCode: 'QD', courseDays: 30, quantity: 30 }], ...overrides })
}
function receipt(kind: DoctorRecommendationState['kind'] = 'diagnosis') {
  return Response.json({ data: { kind, draftVersion: 2, encounterVersion: '3', recordIds: ['formal-record-1'] }, auditId: 'audit-confirm', requestId: 'request-confirm', effects: [], warnings: [] })
}
function deferredResponse() {
  let complete!: (response: Response) => void
  const response = new Promise<Response>(resolve => { complete = resolve })
  return { response, complete }
}
function stubRequests(get: () => DoctorRecommendationState = () => state(), confirm: () => Promise<Response> | Response = () => receipt(get().kind), generate?: () => Promise<Response> | Response, disposition?: (body: unknown) => Promise<Response> | Response) {
  const calls: Array<{ path: string; method: string; body: unknown; key: string | null }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), key: new Headers(init?.headers).get('idempotency-key') })
    if (path.endsWith('/actions/confirm')) return confirm()
    if (path.endsWith('/considerations/disposition')) return disposition === undefined ? Response.json({ dispositions: [] }) : disposition(JSON.parse(String(init?.body)))
    if (path.endsWith('/actions/generate')) return generate?.() ?? Response.json({ data: get(), auditId: 'audit-generate', requestId: 'request-generate', effects: [], warnings: [] })
    return Response.json(get())
  }))
  return calls
}
const clients: QueryClient[] = []
// 测试内重演服务端 upsert/clear 语义：按归一化标题（此处仅 trim）覆盖或移除处置。
function dispositionStore(initial: DoctorRecommendationState) {
  const ref = { current: initial }
  return {
    state: () => ref.current,
    respond: (body: unknown) => {
      const input = (body as { input: { label: string; status: 'verified' | 'dismissed' | 'clear' } }).input
      const labelKey = input.label.trim()
      const rest = (ref.current.considerationDispositions ?? []).filter(entry => entry.labelKey !== labelKey)
      ref.current = input.status === 'clear'
        ? { ...ref.current, considerationDispositions: rest.length > 0 ? rest : undefined }
        : { ...ref.current, considerationDispositions: [...rest, { labelKey, status: input.status, label: input.label }] }
      return Response.json({ dispositions: ref.current.considerationDispositions ?? [] })
    },
  }
}
function SubmissionProbe() {
  const preparation = useDoctorPreparation()
  return <><p data-testid="submitting">{preparation?.submitting('diagnosis') ? '提交中' : '空闲'}</p><p data-testid="confirmed-revision">{preparation?.confirmedRevision('diagnosis') ?? 0}</p></>
}
function InlineDiagnosisWorkspace() {
  const [note, setNote] = useState('初始备注')
  return <DoctorOrderWorkspace hasRecords
    entry={<textarea aria-label="手动诊断备注" onChange={event => setNote(event.currentTarget.value)} value={note} />}
    pending={<DoctorRecommendationsPanel {...props({
      encounter: { id: 'encounter-fever', versionId: '2' },
      manualItems: [{ label: '医生待确认诊断', value: { source: 'manual', kind: 'diagnosis', catalogItemId: 'diagnosis-fever', role: 'primary', note } }],
      onManualChange: ({ value }) => { if (value.kind !== 'diagnosis') return false; setNote(value.note ?? ''); return true },
    })} />}
    records={<button type="button">查看正式诊断</button>} details={<p>正式诊断只读详情</p>} />
}
function mount(panelProps: ComponentProps<typeof DoctorRecommendationsPanel>, provider = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const content = (next: ComponentProps<typeof DoctorRecommendationsPanel>) => <QueryClientProvider client={client}>{provider
    ? <DoctorPreparationProvider caseId={next.caseId} detail={undefined} enabled={next.enabled} inputRevision={next.inputRevision ?? '1'} scope={next.scope ?? ''}><DoctorRecommendationsPanel {...next} /><SubmissionProbe /></DoctorPreparationProvider>
    : <DoctorRecommendationsPanel {...next} />}</QueryClientProvider>
  const rendered = render(content(panelProps))
  return { ...rendered, client, rerenderPanel: (next: ComponentProps<typeof DoctorRecommendationsPanel>) => rendered.rerender(content(next)) }
}
const confirmButton = () => screen.getByRole('button', { name: /确认选中诊断|开具处方|开具选中项目|Confirm selected|Issue prescription|Issue selected/ })
const selectionCheckbox = (label = '发热，未特指') => screen.getByRole('checkbox', { name: `选择${label}` })
async function details() { await userEvent.setup().click(screen.getByRole('button', { name: /依据与说明|Evidence and details/ })); return within(await screen.findByRole('dialog')) }
async function edit() { await userEvent.setup().click(screen.getByRole('button', { name: '调整' })); return within(await screen.findByRole('dialog')) }
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals() })

describe('prepared clinical confirmation', () => {
  it('refreshes a clean inline adjustment from newer manual fields without writing the old note back', async () => {
    stubRequests()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    render(<QueryClientProvider client={client}><InlineDiagnosisWorkspace /></QueryClientProvider>)
    const user = userEvent.setup()
    const open = await screen.findByRole('button', { name: '查看待开具 医生待确认诊断' })
    await user.click(open)
    fireEvent.change(screen.getByRole('textbox', { name: '备注' }), { target: { value: '右栏保留的旧备注' } })
    await user.click(screen.getByRole('button', { name: '保留本次调整' }))
    const manual = screen.getByRole('textbox', { name: '手动诊断备注' })
    expect(manual).toHaveProperty('value', '右栏保留的旧备注')
    fireEvent.change(manual, { target: { value: '医生后来填写的新备注' } })
    await user.click(open)
    expect(screen.getByRole('textbox', { name: '备注' })).toHaveProperty('value', '医生后来填写的新备注')
    await user.click(screen.getByRole('button', { name: '保留本次调整' }))
    expect(manual).toHaveProperty('value', '医生后来填写的新备注')
  })
  it('keeps a clean inline adjustment synchronized while the manual fields change', async () => {
    stubRequests()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    render(<QueryClientProvider client={client}><InlineDiagnosisWorkspace /></QueryClientProvider>)
    await userEvent.setup().click(await screen.findByRole('button', { name: '查看待开具 医生待确认诊断' }))
    fireEvent.change(screen.getByRole('textbox', { name: '手动诊断备注' }), { target: { value: '左侧实时更新的备注' } })
    expect(screen.getByRole('textbox', { name: '备注' })).toHaveProperty('value', '左侧实时更新的备注')
  })
  it('preserves dirty inline text and flags newer manual fields before the doctor keeps the adjustment', async () => {
    stubRequests()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    render(<QueryClientProvider client={client}><InlineDiagnosisWorkspace /></QueryClientProvider>)
    const user = userEvent.setup()
    const open = await screen.findByRole('button', { name: '查看待开具 医生待确认诊断' })
    await user.click(open)
    const raw = '右栏尚未完成的填写\n医生保留原文'
    fireEvent.change(screen.getByRole('textbox', { name: '备注' }), { target: { value: raw } })
    const manual = screen.getByRole('textbox', { name: '手动诊断备注' })
    fireEvent.change(manual, { target: { value: '左侧后来填写的备注' } })
    await user.click(open)
    expect(screen.getByRole('textbox', { name: '备注' })).toHaveProperty('value', raw)
    expect(manual).toHaveProperty('value', '左侧后来填写的备注')
    expect(screen.getByText('左侧填写已更新，当前调整已保留，请核对后再保留。')).toBeTruthy()
    expect(confirmButton()).toHaveProperty('disabled', true)
    await user.click(screen.getByRole('button', { name: '保留本次调整' }))
    expect(manual).toHaveProperty('value', raw)
    expect(screen.queryByText('左侧填写已更新，当前调整已保留，请核对后再保留。')).toBeNull()
  })
  it('opens the remaining prepared item in the issued workspace detail column', async () => {
    stubRequests(() => prescriptionState())
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    const view = render(<QueryClientProvider client={client}>
      <DoctorOrderWorkspace hasRecords entry={null}
        pending={<DoctorRecommendationsPanel {...props({ kind: 'prescription' })} />}
        records={<button type="button">查看已开具药品</button>}
        details={<p>已开具药品只读详情</p>} />
    </QueryClientProvider>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '调整' }))
    const detail = within(view.container.querySelector('[data-order-details]')!)
    expect(detail.getByRole('textbox', { name: '每次剂量' })).toHaveProperty('value', '5 mg')
    expect(screen.queryByRole('dialog', { name: '调整项目' })).toBeNull()
    expect(isInaccessible(screen.getByText('已开具药品只读详情'))).toBe(true)
  })
  it('preserves unsaved pending fields across record selection and temporary action blocking', async () => {
    const calls = stubRequests(() => prescriptionState())
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    const content = (disabled = false) => <QueryClientProvider client={client}>
      <DoctorOrderWorkspace hasRecords entry={null}
        pending={<DoctorRecommendationsPanel {...props({ kind: 'prescription', disabled })} />}
        records={<button type="button">查看已开具药品</button>}
        details={<section aria-label="正式详情">已开具药品只读详情</section>} />
    </QueryClientProvider>
    const mounted = render(content())
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '查看待开具 合成药品' }))
    const pending = within(screen.getByRole('region', { name: '待开具项目详情' }))
    await user.clear(pending.getByRole('textbox', { name: '每次剂量' }))
    await user.type(pending.getByRole('textbox', { name: '每次剂量' }), '10 mg')
    expect(confirmButton()).toHaveProperty('disabled', true)
    mounted.rerender(content(true))
    expect(pending.getByRole('textbox', { name: '每次剂量' })).toHaveProperty('value', '10 mg')
    expect(pending.getByRole('button', { name: '保留本次调整' })).toHaveProperty('disabled', true)
    await user.click(screen.getByRole('button', { name: '查看已开具药品' }))
    expect(screen.getByRole('region', { name: '正式详情' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '待开具项目详情' })).toBeNull()
    expect(confirmButton()).toHaveProperty('disabled', true)
    mounted.rerender(content())
    await user.click(screen.getByRole('button', { name: '查看待开具 合成药品' }))
    expect(pending.getByRole('textbox', { name: '每次剂量' })).toHaveProperty('value', '10 mg')
    await user.click(pending.getByRole('button', { name: '保留本次调整' }))
    expect(confirmButton()).toHaveProperty('disabled', false)
    expect(screen.getAllByRole('button', { name: /开具处方/ })).toHaveLength(1)
    await user.click(confirmButton())
    await waitFor(() => expect(calls.filter(call => call.path.endsWith('/actions/confirm'))).toHaveLength(1))
    expect(confirmDoctorPreparationRequestSchema.parse(calls.find(call => call.path.endsWith('/actions/confirm'))!.body).input.selections).toEqual([
      { source: 'manual', kind: 'prescription', catalogItemId: 'medication-1', doseText: '10 mg', frequencyCode: 'QD', courseDays: 30, quantity: 30 },
    ])
    expect(await screen.findByRole('region', { name: '正式详情' })).toBeTruthy()
  })
  it('loads the selected pending item fields and confirms the clearly selected group', async () => {
    const first = prescriptionState().items[0]!
    if (first.kind !== 'prescription') throw new Error('Expected prescription fixture')
    const calls = stubRequests(() => prescriptionState({ items: [first,
      { ...first, id: 'second-prescription', catalogItemId: 'medication-2', label: '第二项待开具药品', doseText: '20 mg' },
    ] }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    render(<QueryClientProvider client={client}><DoctorOrderWorkspace hasRecords entry={null}
      pending={<DoctorRecommendationsPanel {...props({ kind: 'prescription' })} />}
      records={<button type="button">查看正式记录</button>} details={<p>正式记录</p>} /></QueryClientProvider>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '查看待开具 合成药品' }))
    await user.click(screen.getByRole('button', { name: '查看待开具 第二项待开具药品' }))
    expect(screen.getByRole('textbox', { name: '每次剂量' })).toHaveProperty('value', '20 mg')
    expect(screen.getByRole('button', { name: '开具处方（2）' })).toHaveProperty('disabled', false)
    await user.click(screen.getByRole('button', { name: '开具处方（2）' }))
    await waitFor(() => expect(calls.some(call => call.path.endsWith('/actions/confirm'))).toBe(true))
    expect(confirmDoctorPreparationRequestSchema.parse(calls.find(call => call.path.endsWith('/actions/confirm'))!.body).input.selections).toMatchObject([
      { source: 'agent', catalogItemId: 'medication-1', doseText: '5 mg' },
      { source: 'agent', catalogItemId: 'medication-2', doseText: '20 mg' },
    ])
  })
  it('asks the doctor to keep unsaved edits before opening a different pending item', async () => {
    const first = prescriptionState().items[0]!
    if (first.kind !== 'prescription') throw new Error('Expected prescription fixture')
    stubRequests(() => prescriptionState({ items: [first,
      { ...first, id: 'second-prescription', catalogItemId: 'medication-2', label: '第二项待开具药品', doseText: '20 mg' },
    ] }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    render(<QueryClientProvider client={client}><DoctorOrderWorkspace hasRecords entry={null}
      pending={<DoctorRecommendationsPanel {...props({ kind: 'prescription' })} />}
      records={<button type="button">查看正式记录</button>} details={<p>正式记录</p>} /></QueryClientProvider>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '查看待开具 合成药品' }))
    fireEvent.change(screen.getByRole('textbox', { name: '每次剂量' }), { target: { value: '尚未填完的剂量' } })
    await user.click(screen.getByRole('button', { name: '查看待开具 第二项待开具药品' }))
    expect(screen.getByRole('textbox', { name: '每次剂量' })).toHaveProperty('value', '尚未填完的剂量')
    expect(screen.getByText('请先保留当前调整，再查看其他待开具项目。')).toBeTruthy()
  })
  it.each(['prescription', 'diagnosis'] as const)('preserves raw %s input when the first formal record moves the dialog into the detail column', async kind => {
    stubRequests(() => kind === 'prescription' ? prescriptionState() : state())
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    const content = (hasRecords: boolean) => <QueryClientProvider client={client}>
      <DoctorOrderWorkspace hasRecords={hasRecords} entry={null}
        pending={<DoctorRecommendationsPanel {...props({ kind })} />}
        records={<button type="button">查看已开具药品</button>} details={<p>已开具药品只读详情</p>} />
    </QueryClientProvider>
    const mounted = render(content(false))
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '调整' }))
    const dialog = within(screen.getByRole('dialog', { name: '调整项目' }))
    const field = kind === 'prescription' ? '每次剂量' : '备注'
    const raw = '尚未完成的填写\n医生保留原文'
    fireEvent.change(dialog.getByRole('textbox', { name: field }), { target: { value: raw } })
    if (kind === 'prescription') fireEvent.change(dialog.getByRole('spinbutton', { name: '数量' }), { target: { value: '' } })
    mounted.rerender(content(true))
    await user.click(screen.getByRole('button', { name: `查看待开具 ${kind === 'prescription' ? '合成药品' : '发热，未特指'}` }))
    const pending = within(screen.getByRole('region', { name: '待开具项目详情' }))
    expect(pending.getByRole('textbox', { name: field })).toHaveProperty('value', kind === 'prescription' ? raw.replace('\n', '') : raw)
    if (kind === 'prescription') expect(pending.getByRole('spinbutton', { name: '数量' })).toHaveProperty('value', '')
    expect(confirmButton()).toHaveProperty('disabled', true)
  })
  it('keeps a form-deleted adjusted item removed when its automatic copy remains and the case is revisited', async () => {
    stubRequests(() => prescriptionState())
    const value = { source: 'manual' as const, kind: 'prescription' as const, catalogItemId: 'medication-1', doseText: '5 mg', frequencyCode: 'QD', courseDays: 30, quantity: 30 }
    const initial = props({ kind: 'prescription', onManualChange: () => true, manualItems: [{ label: '合成药品', value }] })
    const mounted = mount(initial, true)
    await screen.findByRole('checkbox', { name: '选择合成药品' })
    const form = await edit()
    fireEvent.change(form.getByLabelText('每次剂量'), { target: { value: '10 mg' } })
    await userEvent.setup().click(form.getByRole('button', { name: '保留本次调整' }))
    mounted.rerenderPanel({ ...initial, manualItems: [{ label: '合成药品', value: { ...value, doseText: '10 mg' } }] })
    mounted.rerenderPanel({ ...initial, manualItems: [] })
    expect(screen.queryByRole('checkbox', { name: '选择合成药品' })).toBeNull()
    mounted.rerenderPanel({ ...initial, scope: 'another-scope', enabled: false, manualItems: [] })
    mounted.rerenderPanel({ ...initial, manualItems: [] })
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新' })).toHaveProperty('disabled', false))
    expect(screen.queryByRole('checkbox', { name: '选择合成药品' })).toBeNull()
    expect(confirmButton()).toHaveProperty('disabled', true)
  })
  it.each(['CATALOG_CONFLICT', 'WORKFLOW_CONFLICT'])('keeps the prescription-specific explanation for a %s rejection', async code => {
    stubRequests(() => prescriptionState(), () => Response.json({ error: { code, message: 'private-prescription-rule' } }, { status: 409 }))
    mount(props({ kind: 'prescription' }))
    await screen.findByText('合成药品')
    await userEvent.setup().click(confirmButton())
    expect(await screen.findByText('当前诊断、过敏信息、目录或处方状态不允许正式开具，请检查后重试。')).toBeTruthy()
    expect(screen.queryByText('private-prescription-rule')).toBeNull()
  })
  it('preserves unsaved adjustment text while autosave temporarily disables actions', async () => {
    stubRequests()
    const onManualChange = vi.fn()
    const initial = props({ onManualChange })
    const mounted = mount(initial)
    await screen.findByText('发热，未特指')
    const form = await edit()
    fireEvent.change(form.getByRole('textbox', { name: '备注' }), { target: { value: '正在调整\n尚未提交的备注' } })
    mounted.rerenderPanel({ ...initial, disabled: true })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '备注' })).toHaveProperty('value', '正在调整\n尚未提交的备注')
    const keep = screen.getByRole('button', { name: '保留本次调整' })
    expect(keep).toHaveProperty('disabled', true)
    fireEvent.submit(keep.closest('form')!)
    expect(onManualChange).not.toHaveBeenCalled()
    mounted.rerenderPanel(initial)
    await userEvent.setup().click(screen.getByRole('button', { name: '保留本次调整' }))
    expect(onManualChange).toHaveBeenCalledWith(expect.objectContaining({ value: expect.objectContaining({ note: '正在调整\n尚未提交的备注' }) }))
  })
  it('preserves line breaks when a doctor adjusts a diagnosis note', async () => {
    stubRequests()
    const onManualChange = vi.fn()
    mount(props({ onManualChange }))
    await screen.findByText('发热，未特指')
    const form = await edit()
    const note = form.getByRole('textbox', { name: '备注' })
    fireEvent.change(note, { target: { value: '第一行诊断依据\n第二行医生备注' } })
    expect(note).toHaveProperty('maxLength', 500)
    await userEvent.setup().click(form.getByRole('button', { name: '保留本次调整' }))
    expect(onManualChange).toHaveBeenCalledWith(expect.objectContaining({ value: expect.objectContaining({ note: '第一行诊断依据\n第二行医生备注' }) }))
  })
  it.each([
    ['DIAGNOSIS_PRIMARY_REQUIRED', '必须且只能选择一个主诊断。'],
    ['CATALOG_CONFLICT', '目录或业务规则已变化，请刷新后重新选择。'],
  ])('explains the current %s confirmation rejection without exposing internal details', async (code, explanation) => {
    stubRequests(() => state(), () => Response.json({ error: { code, message: 'private-internal-rule-detail' } }, { status: 409 }))
    mount(props())
    await screen.findByText('发热，未特指')
    await userEvent.setup().click(confirmButton())
    expect(await screen.findByText(explanation)).toBeTruthy()
    expect(screen.queryByText('private-internal-rule-detail')).toBeNull()
    expect(selectionCheckbox().getAttribute('aria-checked')).toBe('true')
  })
  it.each([{ enabled: false }, { disabled: true }, { inputRevision: 'new-source' }])('consumes unchanged manual values after %j while preserving record notification', async change => {
    const delayed = deferredResponse()
    stubRequests(() => state({ items: [] }), () => delayed.response)
    const onConfirmed = vi.fn()
    const value = { source: 'manual' as const, kind: 'diagnosis' as const, catalogItemId: 'manual-diagnosis', role: 'primary' as const }
    const original = props({ encounter: { id: 'encounter-fever', versionId: '2' }, manualItems: [{ label: '医生主诊断', value }], onConfirmed })
    const mounted = mount(original)
    await screen.findByText('医生主诊断')
    await userEvent.setup().click(confirmButton())
    mounted.rerenderPanel({ ...original, ...change })
    await act(async () => { delayed.complete(receipt()) })
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(onConfirmed).toHaveBeenCalledWith([value], expect.objectContaining({ recordIds: ['formal-record-1'] }))
    mounted.rerenderPanel(original)
    expect(screen.queryByRole('checkbox', { name: '选择医生主诊断' })).toBeNull()
  })
  it('consumes only unchanged submitted manual rows when a different unselected row changes', async () => {
    const delayed = deferredResponse()
    stubRequests(() => prescriptionState({ items: [] }), () => delayed.response)
    const selected = { source: 'manual' as const, kind: 'prescription' as const, catalogItemId: 'medication-selected', doseText: '5 mg', frequencyCode: 'QD', courseDays: 3, quantity: 3 }
    const unselected = { ...selected, catalogItemId: 'medication-unselected' }
    const onConfirmed = vi.fn()
    const original = props({ kind: 'prescription', encounter: { id: 'encounter-fever', versionId: '2' }, onConfirmed, manualItems: [
      { label: '已选药品', value: selected }, { label: '未选药品', value: unselected },
    ] })
    const mounted = mount(original)
    await screen.findByText('已选药品')
    const user = userEvent.setup()
    await user.click(selectionCheckbox('未选药品'))
    await user.click(confirmButton())
    mounted.rerenderPanel({ ...original, manualItems: [original.manualItems![0]!, { label: '未选药品', value: { ...unselected, doseText: '10 mg' } }] })
    await act(async () => { delayed.complete(receipt('prescription')) })
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(onConfirmed).toHaveBeenCalledWith([selected], expect.objectContaining({ recordIds: ['formal-record-1'] }))
    expect(screen.queryByRole('checkbox', { name: '选择已选药品' })).toBeNull()
    expect(selectionCheckbox('未选药品').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(/10 mg/)).toBeTruthy()
  })
  it('keeps a submitted manual row that was edited and then restored before success', async () => {
    const delayed = deferredResponse()
    stubRequests(() => prescriptionState({ items: [] }), () => delayed.response)
    const value = { source: 'manual' as const, kind: 'prescription' as const, catalogItemId: 'manual-medication', doseText: '5 mg', frequencyCode: 'QD', courseDays: 3, quantity: 3 }
    const onConfirmed = vi.fn()
    const original = props({ kind: 'prescription', encounter: { id: 'encounter-fever', versionId: '2' }, manualItems: [{ label: '医生药品', value }], onConfirmed })
    const mounted = mount(original)
    await screen.findByText('医生药品')
    await userEvent.setup().click(confirmButton())
    mounted.rerenderPanel({ ...original, manualItems: [{ label: '医生药品', value: { ...value, doseText: '10 mg' } }] })
    mounted.rerenderPanel(original)
    await act(async () => { delayed.complete(receipt('prescription')) })
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(onConfirmed).toHaveBeenCalledWith([], expect.objectContaining({ recordIds: ['formal-record-1'] }))
    expect(selectionCheckbox('医生药品')).toBeTruthy()
  })
  it.each([{ caseId: 'other-case' }, { scope: 'other-doctor' }])('does not notify an identity after an A to B to A transition through %j', async change => {
    const delayed = deferredResponse()
    stubRequests(() => state(), () => delayed.response)
    const onConfirmed = vi.fn()
    const original = props({ onConfirmed })
    const mounted = mount(original)
    await screen.findByText('发热，未特指')
    await userEvent.setup().click(confirmButton())
    mounted.rerenderPanel({ ...original, ...change })
    mounted.rerenderPanel(original)
    await act(async () => { delayed.complete(receipt()) })
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(onConfirmed).not.toHaveBeenCalled()
  })
  it('submits only physician items while automatic preparation is paused', async () => {
    const current = state({ items: state().items.map(item => item.kind === 'diagnosis' ? { ...item, role: 'secondary' } : item) })
    const calls = stubRequests(() => current)
    mount(props({ encounter: { id: 'encounter-fever', versionId: '2' }, manualItems: [{ label: '医生主诊断',
      value: { source: 'manual', kind: 'diagnosis', catalogItemId: 'manual-diagnosis', role: 'primary' } }] }), true)
    const user = userEvent.setup(); await screen.findByText('发热，未特指')
    await user.click(screen.getByRole('button', { name: '暂停自动准备' }))
    expect(confirmButton()).toHaveProperty('disabled', false)
    await user.click(confirmButton())
    await waitFor(() => expect(calls.some(call => call.path.endsWith('/actions/confirm'))).toBe(true))
    expect(calls.find(call => call.path.endsWith('/actions/confirm'))!.body).toEqual({ expectedVersions: { 'Encounter/encounter-fever': '2' },
      input: { expectedDraftVersion: 0, selections: [{ source: 'manual', kind: 'diagnosis', catalogItemId: 'manual-diagnosis', role: 'primary' }] } })
  })
  it('does not reveal the old automatic copy after a confirmed manual item is removed from its form', async () => {
    const current = prescriptionState(); stubRequests(() => current)
    const value = { source: 'manual' as const, kind: 'prescription' as const, catalogItemId: 'medication-1', doseText: '5 mg', frequencyCode: 'QD', courseDays: 30, quantity: 30 }
    const initial = props({ kind: 'prescription', encounter: { id: 'encounter-fever', versionId: '2' }, manualItems: [{ label: '合成药品', value }], onManualChange: vi.fn(), onConfirmed: vi.fn() })
    const mounted = mount(initial)
    await screen.findByText('合成药品'); await userEvent.setup().click(confirmButton())
    await waitFor(() => expect(initial.onConfirmed).toHaveBeenCalled())
    mounted.rerenderPanel({ ...initial, manualItems: [] })
    expect(screen.queryByRole('checkbox', { name: '选择合成药品' })).toBeNull()
    await mounted.client.invalidateQueries({ queryKey: ['doctor-recommendations'] })
    expect(screen.queryByRole('checkbox', { name: '选择合成药品' })).toBeNull()
  })
  it('applies the refreshed formal record after its success callback consumes the matching manual form', async () => {
    let confirmed = false
    stubRequests(() => state({ items: [] }), () => { confirmed = true; return receipt() })
    const initial = props({ encounter: { id: 'encounter-fever', versionId: '2' }, manualItems: [{ label: '医生主诊断',
      value: { source: 'manual' as const, kind: 'diagnosis' as const, catalogItemId: 'manual-diagnosis', role: 'primary' as const } }],
      onConfirmed: () => mounted.rerenderPanel({ ...initial, manualItems: [] }),
    })
    const mounted = mount(initial, true)
    const observer = new QueryObserver(mounted.client, { queryKey: ['doctor-case', 'scope', 'case-fever'], queryFn: async () => doctorCaseDetailSchema.parse({
      registrationNumber: null,
      caseId: 'case-fever', allergies: [], encounter: { id: 'encounter-fever', versionId: confirmed ? '3' : '2', status: 'in-progress' },
      patient: { id: 'synthetic-patient', identifier: 'SYNTHETIC', name: '合成患者', synthetic: true, versionId: '1' },
      presentation: null, priorFacts: [], status: 'first-visit', taskId: 'task', taskVersion: '1',
      ...confirmed ? { diagnosis: { draftVersion: 2, confirmation: { id: 'formal-record-1', confirmedAt: '2026-10-18T12:00:00+08:00', provenanceId: 'provenance-1', entries: [{
        catalogItemId: 'manual-diagnosis', role: 'primary', code: 'R50.9', conditionId: 'condition-1', conditionVersion: '1', display: '发热', system: 'http://hl7.org/fhir/sid/icd-10',
      }] } } } : {},
    }) })
    const unsubscribe = observer.subscribe(() => {})
    try {
      await screen.findByText('医生主诊断'); await userEvent.setup().click(confirmButton())
      await waitFor(() => expect(screen.getByTestId('confirmed-revision').textContent).toBe('1'))
      expect(screen.queryByRole('checkbox', { name: '选择医生主诊断' })).toBeNull()
    } finally { unsubscribe() }
  })
  it.each(['idle', 'pending', 'failed', 'missing-evidence', 'stale'] as const)('lets a doctor submit a manual item while preparation is %s', async status => {
    const current = state({ items: [], status: status === 'stale' ? 'ready' : status,
      stale: status === 'stale', generation: status === 'idle' ? 0 : 1 })
    const calls = stubRequests(() => current)
    const onConfirmed = vi.fn()
    mount(props({ encounter: { id: 'encounter-fever', versionId: '7' }, expectedDraftVersion: 3, onConfirmed,
      resolveExistingDraft: true,
      manualItems: [{ label: '医生填写诊断', value: { source: 'manual', kind: 'diagnosis', catalogItemId: 'manual-diagnosis', role: 'primary', note: '医生已核对' } }] }))
    const user = userEvent.setup(); await screen.findByText('医生填写诊断')
    expect(confirmButton()).toHaveProperty('disabled', false)
    await user.click(confirmButton())
    await waitFor(() => expect(calls.filter(call => call.path.endsWith('/actions/confirm'))).toHaveLength(1))
    expect(calls.find(call => call.path.endsWith('/actions/confirm'))!.body).toEqual({
      expectedVersions: { 'Encounter/encounter-fever': '7' }, input: { expectedDraftVersion: 3, resolveExistingDraft: true,
        selections: [{ source: 'manual', kind: 'diagnosis', catalogItemId: 'manual-diagnosis', role: 'primary', note: '医生已核对' }] },
    })
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith([
      expect.objectContaining({ source: 'manual', catalogItemId: 'manual-diagnosis' }),
    ], expect.objectContaining({ recordIds: ['formal-record-1'] })))
  })
  it('keeps manual confirmation available when recommendation reading fails', async () => {
    const calls: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/actions/confirm')) { calls.push(JSON.parse(String(init?.body))); return receipt() }
      return Response.json({ error: { code: 'INTERNAL_ERROR', message: 'Synthetic failure' } }, { status: 503 })
    }))
    mount(props({ encounter: { id: 'encounter-fever', versionId: '4' },
      manualItems: [{ label: '医生填写诊断', value: { source: 'manual', kind: 'diagnosis', catalogItemId: 'manual-diagnosis', role: 'primary' } }] }))
    await screen.findByText('更新或提交未完成，草稿已保留。')
    expect(confirmButton()).toHaveProperty('disabled', false)
    await userEvent.setup().click(confirmButton())
    await waitFor(() => expect(calls).toHaveLength(1))
  })

  it('shares physician form values with row edits and exposes the manual entry in the same list', async () => {
    const current = prescriptionState(); stubRequests(() => current)
    const onManualChange = vi.fn(), onManualRemove = vi.fn()
    const initial = props({ kind: 'prescription', onManualChange, onManualRemove,
      manualControls: <button type="button">添加药品</button>,
      manualItems: [{ label: '合成药品', value: { source: 'manual', kind: 'prescription', catalogItemId: 'medication-1', doseText: '5 mg', frequencyCode: 'QD', courseDays: 30, quantity: 30 } }] })
    const mounted = mount(initial)
    await screen.findByText('合成药品')
    const user = userEvent.setup(); await edit()
    fireEvent.change(screen.getByLabelText('每次剂量'), { target: { value: '10 mg' } })
    await user.click(screen.getByRole('button', { name: '保留本次调整' }))
    expect(onManualChange).toHaveBeenCalledWith({ label: '合成药品', value: expect.objectContaining({ source: 'manual', doseText: '10 mg' }) })
    mounted.rerenderPanel({ ...initial, manualItems: [{ label: '合成药品', value: { ...initial.manualItems![0]!.value, kind: 'prescription', source: 'manual', catalogItemId: 'medication-1', doseText: '20 mg', frequencyCode: 'QD', courseDays: 30, quantity: 30 } }] })
    expect(screen.getByText(/20 mg/)).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getByRole('button', { name: '添加药品' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '移除合成药品' }))
    expect(onManualRemove).toHaveBeenCalledWith(expect.objectContaining({ source: 'manual', doseText: '20 mg' }))
  })

  it('keeps the actual preparation result and source-change status inside the details button', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(state())))
    mount(props())
    await screen.findByText('发热，未特指')
    expect(screen.queryByRole('region', { name: '准备记录' })).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: '依据与说明' }))
    const log = within(screen.getByRole('region', { name: '准备记录' }))
    expect(log.getByText('第 1 轮准备')).toBeTruthy()
    expect(log.getByText('已读取 1 份病例依据、1 条指南依据。')).toBeTruthy()
    expect(log.getByText('独立核验后发布 1 项，另有 0 项待核实思路。')).toBeTruthy()
  })

  it('shows complete executable items selected and keeps explanations under one button', async () => {
    const current = state(); stubRequests(() => current); mount(props())
    await screen.findByText('发热，未特指')
    expect(selectionCheckbox().getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByText(current.items[0]!.rationale)).toBeNull()
    expect(screen.queryByText(current.guidelines[0]!.text)).toBeNull()
    expect((await details()).getByText(current.items[0]!.rationale)).toBeTruthy()
  })
  it('submits the selected current preparation directly through the formal confirmation API', async () => {
    const calls = stubRequests(); mount(props({ expectedDraftVersion: 4 }))
    await screen.findByText('发热，未特指'); await userEvent.setup().click(confirmButton())
    await waitFor(() => expect(calls.filter(call => call.path.endsWith('/actions/confirm'))).toHaveLength(1))
    const submitted = calls.find(call => call.path.endsWith('/actions/confirm'))!
    expect(confirmDoctorPreparationRequestSchema.parse(submitted.body)).toMatchObject({ expectedVersions: { 'Encounter/encounter-fever': '2' }, input: {
      generation: 1, inputFingerprint: 'a'.repeat(64), expectedDraftVersion: 4,
      selections: [{ source: 'agent', suggestionId: 'recommendation-fever', catalogItemId: 'diagnosis-fever', role: 'primary' }],
    } })
    expect(calls.some(call => call.path.includes('/draft'))).toBe(false)
  })
  it('preserves a manual item with the same clinical identity and asks the doctor to review a conflicting new proposal', async () => {
    const current = prescriptionState(); stubRequests(() => current)
    mount(props({ kind: 'prescription', manualItems: [{ label: '医生手改药品', value: { source: 'manual', kind: 'prescription', catalogItemId: 'medication-1', doseText: '10 mg', frequencyCode: 'QD', courseDays: 30, quantity: 30 } }] }))
    await screen.findByText('医生手改药品')
    expect(screen.queryByText('合成药品')).toBeNull()
    expect(screen.getByText(/10 mg/)).toBeTruthy()
    expect(await screen.findByText('新建议与医生填写内容不同，请核对。')).toBeTruthy()
    expect(confirmButton()).toHaveProperty('disabled', true)
  })
  it('retains adjustment text during confirmation and applies it only after submission finishes', async () => {
    const delayed = deferredResponse(); const current = prescriptionState()
    stubRequests(() => current, () => delayed.response); const mounted = mount(props({ kind: 'prescription' }))
    await screen.findByText('合成药品'); const user = userEvent.setup()
    await edit(); fireEvent.change(screen.getByLabelText('每次剂量'), { target: { value: '10 mg' } })
    await user.click(screen.getByRole('button', { name: '保留本次调整' })); await user.click(confirmButton())
    await waitFor(() => expect(mounted.client.isMutating()).toBe(1))
    await edit(); fireEvent.change(screen.getByLabelText('每次剂量'), { target: { value: '20 mg' } })
    fireEvent.change(screen.getByLabelText('每次剂量'), { target: { value: '10 mg' } })
    expect(screen.getByRole('button', { name: '保留本次调整' })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('每次剂量')).toHaveProperty('value', '10 mg')
    await act(async () => { delayed.complete(receipt('prescription')) })
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    await user.click(screen.getByRole('button', { name: '保留本次调整' }))
    expect(screen.getByText(/10 mg/)).toBeTruthy()
  })
  it.each([
    { name: 'identity', next: { scope: 'doctor-b' } },
    { name: 'input revision', next: { inputRevision: 'source-2' } },
    { name: 'case', next: { caseId: 'other-case' } },
    { name: 'enabled state', next: { enabled: false } },
  ])('does not clear a new view when the $name changes A to B to A before an old confirmation succeeds', async ({ next }) => {
    const delayed = deferredResponse(); stubRequests(() => state(), () => delayed.response)
    const original = props(); const mounted = mount(original); const user = userEvent.setup()
    await screen.findByText('发热，未特指'); await user.click(confirmButton())
    await waitFor(() => expect(mounted.client.isMutating()).toBe(1))
    mounted.rerenderPanel({ ...original, ...next }); mounted.rerenderPanel(original)
    await screen.findByText('发热，未特指'); await user.click(selectionCheckbox())
    await act(async () => { delayed.complete(receipt()) })
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(screen.getByText('发热，未特指')).toBeTruthy()
    expect(selectionCheckbox().getAttribute('aria-checked')).toBe('false')
  })
  it('invalidates the actual submitted case even when confirmation finishes after unmount', async () => {
    const delayed = deferredResponse(); stubRequests(() => state(), () => delayed.response)
    const mounted = mount(props()); mounted.client.setQueryData(['doctor-case', 'old-scope', 'case-fever'], { id: 'case-fever' })
    await screen.findByText('发热，未特指'); await userEvent.setup().click(confirmButton())
    await waitFor(() => expect(mounted.client.isMutating()).toBe(1)); mounted.unmount()
    await act(async () => { delayed.complete(receipt()) })
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(mounted.client.getQueryState(['doctor-case', 'old-scope', 'case-fever'])?.isInvalidated).toBe(true)
  })

})


it.each([
  ['national-standard', '国家标准'], ['health-standard', '卫生行业标准'], ['official-protocol', '诊疗方案'],
  ['guideline', '临床指南'], ['product-information', '药品说明书'],
] as const)('keeps source document type %s inside the collapsed evidence dialog', async (documentType, label) => {
  const original = state()
  const current = state({ guidelines: [{ ...original.guidelines[0]!, documentType }] })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(current)))
  mount(props())
  await screen.findByText('发热，未特指')
  expect(screen.queryByText(label)).toBeNull()
  await userEvent.setup().click(screen.getByRole('button', { name: '依据与说明' }))
  expect(within(await screen.findByRole('dialog')).getByText(label)).toBeTruthy()
})
it('keeps classified limitation labels inside evidence details without publishing legacy flat notes', async () => {
  const current = state({ notices: [{ category: 'guideline', message: '合成指南范围。' }, { category: 'catalog', message: '合成目录范围。' },
    { category: 'verification', message: '合成独立核验。' }, { category: 'processing', message: '合成处理限制。' }], missingInformation: ['旧未分类说明。'] })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(current)))
  mount(props())
  await screen.findByText('发热，未特指')
  expect(screen.queryByText('合成指南范围。')).toBeNull()
  await userEvent.setup().click(screen.getByRole('button', { name: '依据与说明' }))
  const dialog = within(await screen.findByRole('dialog'))
  for (const label of ['指南覆盖', '院内目录', '核验未通过', '系统处理限制']) expect(dialog.getByRole('alert', { name: label })).toBeTruthy()
  expect(dialog.queryByText('旧未分类说明。')).toBeNull()
})

it('uses clinical labels for frequency and laboratory purpose while retaining protocol codes in the request', async () => {
  const current = prescriptionState(); const calls = stubRequests(() => current)
  const mounted = mount(props({ kind: 'prescription' }))
  await screen.findByText('合成药品')
  expect(await screen.findByText(/每日一次/)).toBeTruthy()
  expect(screen.queryByText(/ · QD · /)).toBeNull()
  await userEvent.setup().click(confirmButton())
  await waitFor(() => expect(calls.some(call => call.path.endsWith('/actions/confirm'))).toBe(true))
  expect(confirmDoctorPreparationRequestSchema.parse(calls.find(call => call.path.endsWith('/actions/confirm'))!.body).input.selections[0]).toMatchObject({ frequencyCode: 'QD' })
  mounted.unmount()
  const first = state().items[0]!
  const { kind: _kind, role: _role, referenceConcept: _referenceConcept, catalogItemId: _catalogItemId, ...base } = first.kind === 'diagnosis' ? first : (() => { throw new Error('Expected diagnosis') })()
  const laboratory = state({ kind: 'laboratory', items: [{ ...base, kind: 'laboratory', catalogItemId: 'lab-1', indicationCode: 'clinical-evaluation' }] })
  stubRequests(() => laboratory); mount(props({ kind: 'laboratory' }))
  await screen.findByText('发热，未特指')
  expect(await screen.findByText('临床评估')).toBeTruthy()
  expect(screen.queryByText('clinical-evaluation')).toBeNull()
})

it.each(['doseText', 'frequencyCode', 'courseDays', 'quantity'] as const)('keeps an absent prescription %s empty and unavailable instead of inventing a value', async field => {
  const original = prescriptionState()
  const current = prescriptionState({ items: original.items.map(item => ({ ...item, [field]: null })) })
  const calls = stubRequests(() => current); mount(props({ kind: 'prescription' }))
  await screen.findByText('合成药品')
  expect(selectionCheckbox('合成药品').getAttribute('aria-checked')).toBe('false')
  expect(selectionCheckbox('合成药品').getAttribute('aria-disabled')).toBe('true')
  expect(confirmButton()).toHaveProperty('disabled', true)
  expect(calls.filter(call => call.path.endsWith('/actions/confirm'))).toHaveLength(0)
})
it('does not invent a primary diagnosis for legacy results and requires the doctor to choose a role', async () => {
  const current = state({ items: state().items.map(item => item.kind === 'diagnosis' ? { ...item, role: undefined } : item) })
  stubRequests(() => current); mount(props()); await screen.findByText('发热，未特指')
  expect(selectionCheckbox().getAttribute('aria-disabled')).toBe('true')
  expect(confirmButton()).toHaveProperty('disabled', true)
  await edit(); await userEvent.setup().click(screen.getByRole('button', { name: '主诊断' }))
  await userEvent.setup().click(screen.getByRole('button', { name: '保留本次调整' }))
  expect(confirmButton()).toHaveProperty('disabled', false)
})
it('keeps both proposed primary roles and asks for a clinical choice', async () => {
  const first = state().items[0]!
  if (first.kind !== 'diagnosis') throw new Error('Expected diagnosis fixture')
  const current = state({ items: [first, { ...first, id: 'second', catalogItemId: 'diagnosis-other', label: '合成第二诊断' }] })
  stubRequests(() => current); mount(props()); await screen.findByText('合成第二诊断')
  expect(screen.getAllByText('主诊断')).toHaveLength(2)
  expect(confirmButton()).toHaveProperty('disabled', true)
})
it('retains cancelled selection and removal after a refresh of the same clinical evidence', async () => {
  const first = state().items[0]!
  if (first.kind !== 'diagnosis') throw new Error('Expected diagnosis fixture')
  let current = state({ items: [first, { ...first, id: 'second', catalogItemId: 'diagnosis-other', label: '合成第二诊断' }] })
  stubRequests(() => current); const mounted = mount(props()); const user = userEvent.setup()
  await screen.findByText('合成第二诊断'); await user.click(selectionCheckbox())
  await user.click(screen.getByRole('button', { name: '移除合成第二诊断' }))
  current = state({ ...current, generation: 2 })
  await act(async () => { await mounted.client.invalidateQueries({ queryKey: ['doctor-recommendations'] }) })
  expect(selectionCheckbox().getAttribute('aria-checked')).toBe('false')
  expect(screen.queryByText('合成第二诊断')).toBeNull()
  expect(confirmButton()).toHaveProperty('disabled', true)
})
it('offers a removed item for explicit review when its relevant report changes', async () => {
  let current = prescriptionState({ caseEvidence: state().caseEvidence.map(source => ({ ...source, kind: 'report', label: '合成相关报告' })) })
  const calls = stubRequests(() => current)
  const mounted = mount(props({ kind: 'prescription' })); const user = userEvent.setup()
  await screen.findByText('合成药品'); await user.click(screen.getByRole('button', { name: '移除合成药品' }))
  current = prescriptionState({ generation: 2, inputFingerprint: 'b'.repeat(64), items: current.items.map(item => ({ ...item, id: 'new-recommendation-id' })),
    caseEvidence: [...current.caseEvidence, { id: 'unrelated-report', kind: 'report', label: '另一项合成报告', text: '与本项建议无关的合成资料。' }] })
  await act(async () => { await mounted.client.invalidateQueries({ queryKey: ['doctor-recommendations'] }) })
  expect(screen.queryByText('合成药品')).toBeNull()
  current = prescriptionState({ ...current, generation: 3, inputFingerprint: 'c'.repeat(64),
    caseEvidence: current.caseEvidence.map(evidence => evidence.id === 'patient-statement-fever' ? { ...evidence, text: '相关合成报告已更新，需重新评估本项用药。' } : evidence) })
  await act(async () => { await mounted.client.invalidateQueries({ queryKey: ['doctor-recommendations'] }) })
  await screen.findByText('合成药品')
  expect(screen.getByText('已移除项目的依据或方案有变化，请核对。')).toBeTruthy()
  expect(selectionCheckbox('合成药品').getAttribute('aria-checked')).toBe('false')
  expect(confirmButton()).toHaveProperty('disabled', true)
  await user.click(confirmButton())
  expect(calls.filter(call => call.path.endsWith('/actions/confirm'))).toHaveLength(0)
  await user.click(selectionCheckbox('合成药品'))
  expect(confirmButton()).toHaveProperty('disabled', false)
  await user.click(confirmButton())
  await waitFor(() => expect(calls.filter(call => call.path.endsWith('/actions/confirm'))).toHaveLength(1))
  expect(confirmDoctorPreparationRequestSchema.parse(calls.find(call => call.path.endsWith('/actions/confirm'))!.body).input.selections).toMatchObject([
    { source: 'agent', suggestionId: 'new-recommendation-id', catalogItemId: 'medication-1' },
  ])
})
it.each(['guideline source', 'guideline clause', 'dose', 'frequency', 'course', 'quantity'])('keeps a changed %s proposal unselected and respects removing it again', async change => {
  let current = prescriptionState()
  stubRequests(() => current); const mounted = mount(props({ kind: 'prescription' })); const user = userEvent.setup()
  await screen.findByText('合成药品'); await user.click(screen.getByRole('button', { name: '移除合成药品' }))
  current = prescriptionState({ ...current, generation: 2,
    guidelines: current.guidelines.map(source => ({ ...source,
      sourceHash: change === 'guideline source' ? 'b'.repeat(64) : source.sourceHash,
      text: change === 'guideline clause' ? '更新后的相关合成条款。' : source.text,
    })),
    items: current.items.map(item => item.kind === 'prescription' ? { ...item, id: 'changed-proposal',
      doseText: change === 'dose' ? '20 mg' : item.doseText,
      frequencyCode: change === 'frequency' ? 'BID' : item.frequencyCode,
      courseDays: change === 'course' ? 10 : item.courseDays,
      quantity: change === 'quantity' ? 10 : item.quantity,
    } : item),
  })
  await act(async () => { await mounted.client.invalidateQueries({ queryKey: ['doctor-recommendations'] }) })
  await screen.findByText('已移除项目的依据或方案有变化，请核对。')
  expect(selectionCheckbox('合成药品').getAttribute('aria-checked')).toBe('false')
  expect(confirmButton()).toHaveProperty('disabled', true)
  await user.click(screen.getByRole('button', { name: '移除合成药品' }))
  current = prescriptionState({ ...current, generation: 3, inputFingerprint: 'c'.repeat(64), items: current.items.map(item => ({ ...item, id: 'same-plan-new-id' })) })
  await act(async () => { await mounted.client.invalidateQueries({ queryKey: ['doctor-recommendations'] }) })
  expect(screen.queryByText('合成药品')).toBeNull()
})
it('keeps removal when related sources only change identifiers or ordering', async () => {
  const original = prescriptionState()
  let current = prescriptionState({
    caseEvidence: [...original.caseEvidence, { ...original.caseEvidence[0]!, id: 'second-source', text: '另一条相同相关依据。' }],
    guidelines: [...original.guidelines, { ...original.guidelines[0]!, id: 'second-guide', text: '另一条相关指南原文。' }],
    items: original.items.map(item => ({ ...item, caseEvidenceIds: ['patient-statement-fever', 'second-source'], guidelineEvidenceIds: ['nhc-influenza-2025-diagnosis', 'second-guide'] })),
  })
  stubRequests(() => current); const mounted = mount(props({ kind: 'prescription' })); const user = userEvent.setup()
  await screen.findByText('合成药品'); await user.click(screen.getByRole('button', { name: '移除合成药品' }))
  current = prescriptionState({ ...current, generation: 2, inputFingerprint: 'b'.repeat(64),
    caseEvidence: current.caseEvidence.toReversed().map(source => ({ ...source, id: `new-${source.id}` })),
    guidelines: current.guidelines.toReversed().map(source => ({ ...source, id: `new-${source.id}` })),
    items: current.items.map(item => ({ ...item, id: 'new-proposal-id', rationale: '说明文字调整，临床方案与相关依据相同。',
      caseEvidenceIds: item.caseEvidenceIds.toReversed().map(id => `new-${id}`), guidelineEvidenceIds: item.guidelineEvidenceIds.toReversed().map(id => `new-${id}`),
    })),
  })
  await act(async () => { await mounted.client.invalidateQueries({ queryKey: ['doctor-recommendations'] }) })
  expect(screen.queryByText('合成药品')).toBeNull()
  expect(confirmButton()).toHaveProperty('disabled', true)
})
it('preserves manual items, edits and cancelled choices when a removed automatic item needs review', async () => {
  const original = prescriptionState(), first = original.items[0]!
  if (first.kind !== 'prescription') throw new Error('Expected prescription fixture')
  let current = prescriptionState({ items: [first, { ...first, id: 'cancelled', catalogItemId: 'cancelled-medication', label: '取消选择药品' }] })
  stubRequests(() => current)
  const manualValue = { source: 'manual' as const, kind: 'prescription' as const, catalogItemId: 'manual-removed', doseText: '10 mg', frequencyCode: 'QD', courseDays: 30, quantity: 30 }
  const mounted = mount(props({ kind: 'prescription', manualItems: [{ label: '移除人工药品', value: manualValue }, { label: '保留人工药品', value: { ...manualValue, catalogItemId: 'manual-kept' } }] }))
  const user = userEvent.setup(); await screen.findByText('合成药品')
  await user.click(selectionCheckbox('取消选择药品'))
  await user.click(screen.getByRole('button', { name: '移除合成药品' }))
  await user.click(screen.getByRole('button', { name: '移除移除人工药品' }))
  await user.click(screen.getAllByRole('button', { name: '调整' })[0]!)
  fireEvent.change(screen.getByLabelText('每次剂量'), { target: { value: '15 mg' } })
  await user.click(screen.getByRole('button', { name: '保留本次调整' }))
  current = prescriptionState({ ...current, generation: 2, inputFingerprint: 'b'.repeat(64),
    caseEvidence: current.caseEvidence.map(source => ({ ...source, text: '新增相关合成报告。' })) })
  await act(async () => { await mounted.client.invalidateQueries({ queryKey: ['doctor-recommendations'] }) })
  await screen.findByText('合成药品')
  expect(selectionCheckbox('合成药品').getAttribute('aria-checked')).toBe('false')
  expect(selectionCheckbox('取消选择药品').getAttribute('aria-checked')).toBe('false')
  expect(screen.queryByText('移除人工药品')).toBeNull()
  expect(screen.getByText('保留人工药品')).toBeTruthy()
  expect(screen.getByText(/15 mg/)).toBeTruthy()
  await user.click(screen.getAllByRole('button', { name: '核对' }).find(button => button.parentElement?.textContent?.includes('合成药品'))!)
  fireEvent.change(screen.getByLabelText('每次剂量'), { target: { value: '20 mg' } })
  await user.click(screen.getByRole('button', { name: '保留本次调整' }))
  expect(selectionCheckbox('合成药品').getAttribute('aria-checked')).toBe('true')
  expect(screen.getByText(/20 mg/)).toBeTruthy()
  expect(screen.queryByText('已移除项目的依据或方案有变化，请核对。')).toBeNull()
  await user.click(screen.getByRole('button', { name: '移除合成药品' }))
  expect(screen.queryByText('合成药品')).toBeNull()
})
it.each([
  { provider: false, otherCase: false }, { provider: true, otherCase: false },
  { provider: false, otherCase: true }, { provider: true, otherCase: true },
])('isolates removals between scopes with provider=$provider and otherCase=$otherCase', async ({ provider, otherCase }) => {
  let current = prescriptionState()
  stubRequests(() => current)
  const initial = props({ kind: 'prescription' }), mounted = mount(initial, provider), user = userEvent.setup()
  await screen.findByText('合成药品'); await user.click(screen.getByRole('button', { name: '移除合成药品' }))
  current = prescriptionState({ caseId: otherCase ? 'case-other' : initial.caseId })
  mounted.rerenderPanel({ ...initial, caseId: current.caseId, scope: `workspace-demo:epoch-1:${otherCase ? 'doctor:case-other' : 'doctor-b:case-fever'}` })
  await screen.findByText('合成药品')
  expect(selectionCheckbox('合成药品').getAttribute('aria-checked')).toBe('true')
  current = prescriptionState()
  mounted.rerenderPanel(initial)
  expect(screen.queryByText('合成药品')).toBeNull()
})
it('keeps physician edits and retries the same confirmation intent with the same idempotency key after failure', async () => {
  let fail = true; const current = prescriptionState()
  const calls = stubRequests(() => current, () => fail ? Response.json({ error: { code: 'WORKFLOW_CONFLICT', message: '合成资料变化。' } }, { status: 409 }) : receipt('prescription'))
  const mounted = mount(props({ kind: 'prescription' })); const user = userEvent.setup()
  await screen.findByText('合成药品'); await edit(); fireEvent.change(screen.getByLabelText('每次剂量'), { target: { value: '10 mg' } })
  await user.click(screen.getByRole('button', { name: '保留本次调整' })); await user.click(confirmButton())
  await screen.findByText('更新或提交未完成，草稿已保留。')
  expect(screen.getByText(/10 mg/)).toBeTruthy()
  fail = false; await user.click(confirmButton()); await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
  const submitted = calls.filter(call => call.path.endsWith('/actions/confirm'))
  expect(submitted).toHaveLength(2); expect(submitted[0]!.key).toBeTruthy(); expect(submitted[1]!.key).toBe(submitted[0]!.key)
  expect(confirmDoctorPreparationRequestSchema.parse(submitted[0]!.body).input.selections[0]).toMatchObject({ source: 'manual', doseText: '10 mg' })
})
it.each(['pending', 'failed', 'missing-evidence'] as const)('keeps automatic confirmation unavailable for a %s result', async status => {
  const current = state({ status, items: status === 'missing-evidence' ? [] : state().items })
  stubRequests(() => current); mount(props()); await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', true))
})
it.each([{ enabled: false }, { disabled: true }, { unavailableReason: () => '请先处理当前检查草稿。' }])('honors the current edit permission %j', async permission => {
  const calls = stubRequests(); mount(props(permission))
  if (permission.enabled === false) { expect(screen.queryByRole('region')).toBeNull(); expect(calls).toHaveLength(0) }
  else { await screen.findByText('发热，未特指'); expect(confirmButton()).toHaveProperty('disabled', true) }
})
it('keeps manual input while hiding withdrawn source results and their explanations', async () => {
  let current = prescriptionState(); stubRequests(() => current); const mounted = mount(props({ kind: 'prescription' }))
  await screen.findByText('合成药品'); await edit(); fireEvent.change(screen.getByLabelText('每次剂量'), { target: { value: '10 mg' } })
  await userEvent.setup().click(screen.getByRole('button', { name: '保留本次调整' }))
  current = prescriptionState({ hidePreviousResults: true, stale: false, status: 'missing-evidence', items: [], guidelines: [], considerations: [], caseEvidence: [] })
  await act(async () => { await mounted.client.invalidateQueries({ queryKey: ['doctor-recommendations'] }) })
  expect(screen.getByText(/10 mg/)).toBeTruthy()
  const dialog = await details()
  expect(dialog.queryByText(state().guidelines[0]!.text)).toBeNull()
  expect(dialog.queryByText(state().items[0]!.rationale)).toBeNull()
})
it('preserves the previous list during a pending refresh and prevents its formal submission', async () => {
  let current = state(); stubRequests(() => current); const mounted = mount(props())
  await screen.findByText('发热，未特指')
  current = state({ generation: 2, status: 'pending', items: [] })
  await act(async () => { await mounted.client.invalidateQueries({ queryKey: ['doctor-recommendations'] }) })
  expect(screen.getByText('发热，未特指')).toBeTruthy()
  await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', true))
  expect(screen.getByRole('button', { name: '调整' })).toHaveProperty('disabled', false)
})
it('marks the Provider busy for the complete lifetime of a formal confirmation request', async () => {
  const delayed = deferredResponse(); stubRequests(() => state(), () => delayed.response)
  const mounted = mount(props(), true); await screen.findByText('发热，未特指'); await userEvent.setup().click(confirmButton())
  await waitFor(() => expect(screen.getByTestId('submitting').textContent).toBe('提交中'))
  await act(async () => { delayed.complete(receipt()) }); await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
  expect(screen.getByTestId('submitting').textContent).toBe('空闲')
})
it.each(['diagnosis', 'laboratory', 'imaging', 'pathology'] as const)('keeps unguided %s considerations outside formal confirmation with verify and dismiss actions', async kind => {
  const thought = { id: 'thought', label: '核对流感方向', rationale: '合成推测仅供核对。', supportingInformation: [], opposingInformation: [], missingInformation: [], caseEvidenceIds: ['patient-statement-fever'] }
  const current = state({ kind, status: 'missing-evidence', items: [], guidelines: [], considerations: [thought] })
  const calls = stubRequests(() => current); mount(props({ kind })); await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', true))
  expect(screen.queryByText(thought.label)).toBeNull()
  const dialog = await details(); const article = within(dialog.getByRole('article', { name: thought.label }))
  expect(article.getByText(thought.rationale)).toBeTruthy()
  expect(article.queryByRole('button', { name: /确认选中|开具|Confirm selected|Issue/ })).toBeNull()
  expect(article.getByRole('button', { name: `已核实：${thought.label}` })).toBeTruthy()
  expect(article.getByRole('button', { name: `忽略：${thought.label}` })).toBeTruthy()
  expect(calls.filter(call => call.path.endsWith('/actions/confirm'))).toHaveLength(0)
})
it('maps raw evidence references in reasoning text to readable source labels', async () => {
  const hash = 'e'.repeat(64)
  const thought = { id: 'thought', label: '核对流感方向', rationale: `合成推测仅供核对，见 evidence:${hash}。`, supportingInformation: [`evidence:${hash}`], opposingInformation: [], missingInformation: [], caseEvidenceIds: [hash] }
  const current = state({ status: 'missing-evidence', items: [], guidelines: [], considerations: [thought],
    caseEvidence: [{ id: hash, kind: 'consultation', label: '合成患者回答', text: '合成患者自述发热伴咳嗽三天，近期接触流感病例，尚无病原学结果。' }] })
  stubRequests(() => current); mount(props())
  const dialog = await details(); const article = dialog.getByRole('article', { name: thought.label })
  expect(article.textContent).not.toContain(`evidence:${hash}`)
  expect(article.textContent).toContain('合成患者回答')
})
it('summarizes packed history evidence as a record count and expands readable entries', async () => {
  const current = state({ status: 'missing-evidence', items: [], guidelines: [],
    caseEvidence: [{ id: 'synthetic-allergies', kind: 'history', label: '已记录过敏信息',
      text: JSON.stringify([{ code: 'A1', display: '合成青霉素过敏' }, { code: 'A2', display: '合成磺胺过敏' }]) }],
    considerations: [{ id: 'thought', label: '核对流感方向', rationale: '合成推测仅供核对。', supportingInformation: [], opposingInformation: [], missingInformation: [], caseEvidenceIds: ['synthetic-allergies'] }] })
  stubRequests(() => current); mount(props())
  const dialog = await details(); const article = dialog.getByRole('article', { name: '核对流感方向' })
  expect(article.textContent).toContain('已记录过敏信息 · 2 条记录')
  await within(article).getByText('已记录过敏信息').click()
  expect(article.textContent).toContain('合成青霉素过敏')
  expect(article.textContent).toContain('合成磺胺过敏')
})
it('records a verified disposition, hides the consideration, excludes it from the count and lets the doctor undo it', async () => {
  const thought = { id: 'thought', label: '核对流感方向', rationale: '合成推测仅供核对。', supportingInformation: [], opposingInformation: [], missingInformation: [], caseEvidenceIds: ['patient-statement-fever'] }
  const store = dispositionStore(state({ status: 'ready', items: [], guidelines: [], considerations: [thought] }))
  const calls = stubRequests(store.state, undefined, undefined, store.respond)
  const mounted = mount(props())
  await screen.findByText('本轮仅有待核实思路，见“依据与说明”。')
  const dialog = await details()
  expect(dialog.getByText('独立核验后发布 0 项，另有 1 项待核实思路。')).toBeTruthy()
  await userEvent.setup().click(within(dialog.getByRole('article', { name: thought.label })).getByRole('button', { name: `已核实：${thought.label}` }))
  await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
  await waitFor(() => expect(screen.queryByRole('article', { name: thought.label })).toBeNull())
  await waitFor(() => expect(dialog.getByText('独立核验后发布 0 项，另有 0 项待核实思路。')).toBeTruthy())
  expect(calls.filter(call => call.path.endsWith('/considerations/disposition'))).toHaveLength(1)
  const processed = dialog.getByText('已处理思路（1）').closest('details')!
  expect(processed.textContent).toContain(thought.label)
  await userEvent.setup().click(within(processed).getByRole('button', { name: `撤销：${thought.label}` }))
  await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
  await waitFor(() => expect(screen.getByRole('article', { name: thought.label })).toBeTruthy())
  expect(dialog.queryByText('已处理思路（1）')).toBeNull()
  expect(calls.filter(call => call.path.endsWith('/considerations/disposition'))).toHaveLength(2)
})
it('records a dismissed disposition and keeps the thought out of the active list', async () => {
  const thought = { id: 'thought', label: '核对流感方向', rationale: '合成推测仅供核对。', supportingInformation: [], opposingInformation: [], missingInformation: [], caseEvidenceIds: ['patient-statement-fever'] }
  const store = dispositionStore(state({ status: 'ready', items: [], guidelines: [], considerations: [thought] }))
  const calls = stubRequests(store.state, undefined, undefined, store.respond)
  const mounted = mount(props())
  await screen.findByText('暂无可直接确认或开具的项目。')
  const dialog = await details()
  await userEvent.setup().click(within(dialog.getByRole('article', { name: thought.label })).getByRole('button', { name: `忽略：${thought.label}` }))
  await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
  await waitFor(() => expect(screen.queryByRole('article', { name: thought.label })).toBeNull())
  const sent = calls.find(call => call.path.endsWith('/considerations/disposition'))
  expect(sent?.body).toEqual({ input: { label: thought.label, status: 'dismissed' } })
  const processed = dialog.getByText('已处理思路（1）').closest('details')!
  expect(processed.textContent).toContain('已忽略')
})
it('labels legacy unclassified notes without treating them as missing patient facts', async () => {
  const current = state({ items: [], status: 'missing-evidence', missingInformation: ['旧版未分类说明。'] })
  stubRequests(() => current); mount(props()); const dialog = await details()
  expect(within(await dialog.findByRole('alert', { name: '补充说明' })).getByText('旧版未分类说明。')).toBeTruthy()
})

it('keeps a newer automatic result visible when an earlier confirmation response arrives late', async () => {
  const delayed = deferredResponse(); let current = state()
  stubRequests(() => current, () => delayed.response); const mounted = mount(props())
  await screen.findByText('发热，未特指'); await userEvent.setup().click(confirmButton())
  current = state({ generation: 2, inputFingerprint: 'b'.repeat(64), items: [{ ...state().items[0]!, label: '新资料下的诊断候选' }] })
  await act(async () => { await mounted.client.invalidateQueries({ queryKey: ['doctor-recommendations'] }) })
  await screen.findByText('新资料下的诊断候选')
  await act(async () => { delayed.complete(receipt()) }); await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
  expect(screen.getByText('新资料下的诊断候选')).toBeTruthy()
})
it.each(['identity', 'source', 'enabled', 'case'] as const)('hides a late confirmation failure after an A to B to A %s transition', async mode => {
  const delayed = deferredResponse(); stubRequests(() => state(), () => delayed.response)
  const original = props(); const mounted = mount(original); await screen.findByText('发热，未特指'); await userEvent.setup().click(confirmButton())
  mounted.rerenderPanel({ ...original, ...(mode === 'identity' ? { scope: 'doctor-b' } : mode === 'source' ? { inputRevision: 'source-b' } : mode === 'case' ? { caseId: 'other-case' } : { enabled: false }) })
  mounted.rerenderPanel(original); await screen.findByText('发热，未特指')
  await act(async () => { delayed.complete(Response.json({ error: { code: 'DIAGNOSIS_PRIMARY_REQUIRED', message: '合成旧确认失败。' } }, { status: 409 })) })
  await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
  expect(screen.queryByText('更新或提交未完成，草稿已保留。')).toBeNull()
  expect(screen.queryByText('必须且只能选择一个主诊断。')).toBeNull()
})
it.each(['ready', 'missing-evidence', 'failed'] as const)('retains a completed %s read when its delayed generation receipt still says pending', async status => {
  const delayed = deferredResponse(); let current = state()
  stubRequests(() => current, () => receipt(), () => delayed.response)
  const mounted = mount(props()); await screen.findByText('发热，未特指'); await userEvent.setup().click(screen.getByRole('button', { name: '刷新' }))
  current = state({ generation: 2, status, items: status === 'ready' ? state().items : [], missingInformation: ['本轮已经结束。'] })
  await act(async () => { await mounted.client.invalidateQueries({ queryKey: ['doctor-recommendations'] }) })
  await act(async () => { delayed.complete(Response.json({ data: state({ generation: 2, status: 'pending', items: [] }), auditId: 'audit-generation', requestId: 'request-generation', effects: [], warnings: [] })) })
  await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
  expect((await details()).getByText('本轮已经结束。')).toBeTruthy()
  expect(screen.queryByText('正在按最新资料更新，旧自动项目暂不可开具。')).toBeNull()
})
it('retains a newer generation when an older completed generation receipt arrives late', async () => {
  const delayed = deferredResponse(); let current = state()
  stubRequests(() => current, () => receipt(), () => delayed.response)
  const mounted = mount(props()); await screen.findByText('发热，未特指'); await userEvent.setup().click(screen.getByRole('button', { name: '刷新' }))
  current = state({ generation: 3, items: [{ ...state().items[0]!, label: '最新一轮诊断' }] })
  await act(async () => { await mounted.client.invalidateQueries({ queryKey: ['doctor-recommendations'] }) })
  await act(async () => { delayed.complete(Response.json({ data: state({ generation: 2 }), auditId: 'audit-generation', requestId: 'request-generation', effects: [], warnings: [] })) })
  await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
  expect(screen.getByText('最新一轮诊断')).toBeTruthy()
})

it('keeps a known confirmation success when case refresh fails and refreshes records without issuing another command', async () => {
  const calls = stubRequests(); const mounted = mount(props(), true)
  let available = false
  const clinical = doctorCaseDetailSchema.parse({ registrationNumber: null, caseId: 'case-fever', allergies: [], encounter: { id: 'encounter-fever', versionId: '3', status: 'in-progress' },
    patient: { id: 'synthetic-patient', identifier: 'SYNTHETIC', name: '合成患者', synthetic: true, versionId: '1' },
    presentation: null, priorFacts: [], status: 'first-visit', taskId: 'task', taskVersion: '1', diagnosis: { draftVersion: 2,
      confirmation: { id: 'formal-record-1', confirmedAt: '2026-10-18T12:00:00+08:00', provenanceId: 'provenance-1', entries: [{
        catalogItemId: 'diagnosis-fever', role: 'primary', code: 'R50.9', conditionId: 'condition-1', conditionVersion: '1', display: '发热', system: 'http://hl7.org/fhir/sid/icd-10',
      }] } } })
  const observer = new QueryObserver(mounted.client, { queryKey: ['doctor-case', 'scope', 'case-fever'], queryFn: async () => {
    if (!available) throw new Error('Synthetic case refresh failed')
    return clinical
  }, retry: false })
  const unsubscribe = observer.subscribe(() => {})
  try {
    await screen.findByText('发热，未特指'); await userEvent.setup().click(confirmButton())
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(screen.getByTestId('confirmed-revision').textContent).toBe('0')
    expect(await screen.findByText('已完成确认，记录暂未刷新，请刷新查看。')).toBeTruthy()
    available = true; await userEvent.setup().click(screen.getByRole('button', { name: '刷新记录' }))
    await waitFor(() => expect(screen.getByTestId('confirmed-revision').textContent).toBe('1'))
    expect(calls.filter(call => call.path.endsWith('/actions/confirm'))).toHaveLength(1)
  } finally { unsubscribe() }
})

it('does not describe missing-evidence results as checked against the latest information', async () => {
  stubRequests(() => state({ status: 'missing-evidence', items: [] })); mount(props())
  await screen.findByText('暂无可直接确认或开具的项目。')
  await waitFor(() => expect(screen.getByRole('status').textContent).not.toContain('正在'))
  expect(screen.queryByText('已按最新资料核对，由医生确认。')).toBeNull()
})

it('explains an empty executable list when a ready result contains only considerations', async () => {
  const { id, label, rationale, supportingInformation, opposingInformation, missingInformation, caseEvidenceIds } = state().items[0]!
  stubRequests(() => state({ items: [], considerations: [{ id, label, rationale, supportingInformation, opposingInformation, missingInformation, caseEvidenceIds }] }))
  mount(props())
  await screen.findByText('暂无可直接确认或开具的项目。')
  await waitFor(() => expect(screen.getByRole('status').textContent).not.toContain('正在'))
  expect(screen.queryByText('已按最新资料核对，由医生确认。')).toBeNull()
  expect(screen.getByRole('status').textContent).toContain('思路')
  expect(confirmButton()).toHaveProperty('disabled', true)
  expect((await details()).getByRole('article', { name: label })).toBeTruthy()
})

it('keeps an unissued prescription candidate visible without returning issued medication to the list', async () => {
  const current = prescriptionState()
  const first = current.items[0]!
  if (first.kind !== 'prescription') throw new Error('Expected prescription fixture')
  stubRequests(() => prescriptionState({ items: [first, { ...first, id: 'prescription-2', catalogItemId: 'medication-2', label: '第二种未开具药品' }] }))
  mount(props({ kind: 'prescription', disabled: true, issuedCatalogItemIds: new Set(['medication-1']) }))
  await screen.findByRole('checkbox', { name: '选择第二种未开具药品' })
  expect(screen.queryByRole('checkbox', { name: '选择合成药品' })).toBeNull()
  expect(confirmButton()).toHaveProperty('disabled', true)
})

it('renders consultation evidence as the readable statement instead of a raw JSON blob', async () => {
  const current = state({ caseEvidence: [{ id: 'patient-statement-fever', kind: 'consultation', label: '患者问诊记录',
    text: JSON.stringify({ speaker: 'patient', text: '合成患者自述发热伴咳嗽三天。', kind: 'text', recordedAt: '2026-08-24T09:00:00+08:00', reportReference: null }) }] })
  stubRequests(() => current); mount(props())
  await screen.findByText('发热，未特指')
  await details()
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('合成患者自述发热伴咳嗽三天。')).toBeTruthy()
  expect(dialog.textContent).not.toContain('"speaker":"patient"')
})

it('renders packed visible-history evidence as readable entries instead of a raw JSON blob', async () => {
  const text = JSON.stringify({ source: 'visible-source', resourceType: 'Condition', missingFieldMeaning: 'not-recorded', entries: [
    { entryId: 'entry-a', clinicalDate: '2025-09-18T10:25:44+08:00', title: '牙龈炎（疾病）',
      clinical: { code: { text: '牙龈炎（疾病）' }, clinicalStatus: { coding: [{ code: 'resolved' }] } } },
    { entryId: 'entry-b', clinicalDate: '2013-07-11T09:00:00+08:00', title: '全职就业（临床所见）', clinical: {} },
  ] })
  const current = state({ caseEvidence: [{ id: 'patient-statement-fever', kind: 'history', label: '外部可见历史 / Condition / 2条', text }] })
  stubRequests(() => current); mount(props())
  await screen.findByText('发热，未特指')
  await details()
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('牙龈炎（疾病）')).toBeTruthy()
  expect(within(dialog).getByText('全职就业（临床所见）')).toBeTruthy()
  expect(dialog.textContent).not.toContain('missingFieldMeaning')
})

it('keeps local-completed history records inspectable behind a per-entry disclosure', async () => {
  const text = JSON.stringify({ source: 'local-completed', resourceType: 'Encounter', entries: [
    { entryId: 'case-past-1', record: { caseId: 'case-past-1', completedAt: '2026-09-01T10:00:00+08:00',
      clinicalDocuments: [{ chiefComplaint: '合成既往主诉：咽痛三天。' }] } },
  ] })
  const current = state({ caseEvidence: [{ id: 'patient-statement-fever', kind: 'history', label: '本院完诊记录 / Encounter / 1条', text }] })
  stubRequests(() => current); mount(props())
  await screen.findByText('发热，未特指')
  await details()
  const dialog = screen.getByRole('dialog')
  const summary = within(dialog).getByText('查看完整记录')
  expect(summary.closest('details')?.textContent).toContain('合成既往主诉：咽痛三天。')
  expect(summary.closest('details')).toHaveProperty('open', false)
  expect(within(dialog).getByText(/2026年9月1日/)).toBeTruthy()
})

it('collapses unrecognized JSON evidence behind a raw-data disclosure', async () => {
  const current = state({ caseEvidence: [{ id: 'patient-statement-fever', kind: 'presentation', label: '当前主诉与体征',
    text: JSON.stringify({ presentation: { summary: '发热三天。' }, triage: { acuityCode: 'level-3' } }) }] })
  stubRequests(() => current); mount(props())
  await screen.findByText('发热，未特指')
  await details()
  const dialog = screen.getByRole('dialog')
  const summary = within(dialog).getByText('查看原始数据')
  expect(summary.closest('details')?.textContent).toContain('"presentation"')
  expect(summary.closest('details')).toHaveProperty('open', false)
})

it('keeps a new manualItems edit visible while the confirmed case refresh is still pending', async () => {
  const read = deferredResponse(); const current = prescriptionState()
  stubRequests(() => current); const value = { source: 'manual' as const, kind: 'prescription' as const, catalogItemId: 'manual-medication', doseText: '10 mg', frequencyCode: 'QD', courseDays: 30, quantity: 30 }
  const initial = props({ kind: 'prescription', manualItems: [{ label: '人工处方', value }] })
  const mounted = mount(initial)
  let first = true
  const observer = new QueryObserver(mounted.client, { queryKey: ['doctor-case', 'scope', 'case-fever'], queryFn: async () => {
    if (first) { first = false; return { caseId: 'case-fever' } }
    return read.response
  }, retry: false })
  const unsubscribe = observer.subscribe(() => {})
  try {
    await screen.findByText('合成药品'); await userEvent.setup().click(confirmButton())
    await waitFor(() => expect(mounted.client.isMutating()).toBe(1))
    await waitFor(() => expect(screen.queryByText('人工处方')).toBeNull())
    mounted.rerenderPanel({ ...initial, manualItems: [{ label: '人工处方', value: { ...value, doseText: '20 mg' } }] })
    expect(screen.getByText(/20 mg/)).toBeTruthy()
    mounted.rerenderPanel(initial)
    expect(screen.getByText(/10 mg/)).toBeTruthy()
  } finally { await act(async () => { read.complete(Response.json({})) }); unsubscribe() }
})

it('can issue a retained unselected manual item after new preparation without reissuing the completed item', async () => {
  const first = state().items[0]!
  if (first.kind !== 'diagnosis') throw new Error('Expected diagnosis fixture')
  const { role: _role, referenceConcept: _referenceConcept, ...common } = first
  const items = ['A', 'B'].map(name => ({ ...common, kind: 'laboratory' as const, id: `suggestion-${name}`,
    catalogItemId: `lab-${name}`, label: `检查${name}`, indicationCode: 'clinical-evaluation' }))
  let current = state({ kind: 'laboratory', items })
  const issued: string[] = []
  const calls = stubRequests(() => current, () => {
    const name = issued.length === 0 ? 'A' : 'B'; issued.push(name)
    return Response.json({ data: { kind: 'laboratory', draftVersion: issued.length * 2, encounterVersion: '2', recordIds: [`formal-${name}`] },
      auditId: `audit-${name}`, requestId: `request-${name}`, effects: [], warnings: [] })
  })
  const original = props({ kind: 'laboratory', expectedDraftVersion: 0 })
  const mounted = mount(original)
  const observer = new QueryObserver(mounted.client, { queryKey: ['doctor-case', 'scope', 'case-fever'], retry: false,
    queryFn: async () => doctorCaseDetailSchema.parse({ registrationNumber: null, caseId: 'case-fever', allergies: [], encounter: { id: 'encounter-fever', versionId: '2', status: 'in-progress' },
      patient: { id: 'synthetic-patient', identifier: 'SYNTHETIC', name: '合成患者', synthetic: true, versionId: '1' },
      presentation: null, priorFacts: [], status: 'first-visit', taskId: 'task', taskVersion: '1', laboratoryRequests: {
        draftVersion: issued.length * 2, reportingSupported: true, requests: issued.map(name => ({ id: `formal-${name}`, catalogItemId: `lab-${name}`,
          indicationCode: 'clinical-evaluation', serviceRequestId: `service-${name}`, serviceRequestVersion: '1', taskId: `task-${name}`, taskVersion: '1', status: 'issued', version: 1 })),
      } }) })
  const unsubscribe = observer.subscribe(() => {})
  try {
    const user = userEvent.setup()
    await screen.findByText('检查B'); await user.click(screen.getAllByRole('button', { name: '调整' })[1]!)
    await user.click(screen.getByRole('button', { name: '保留本次调整' }))
    await user.click(selectionCheckbox('检查B')); await user.click(confirmButton())
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(issued).toEqual(['A'])
    expect(screen.queryByText('检查A')).toBeNull()
    expect(screen.getByText('检查B')).toBeTruthy()
    current = state({ kind: 'laboratory', items, generation: 2, inputFingerprint: 'b'.repeat(64) })
    mounted.rerenderPanel({ ...original, inputRevision: 'case-source-2', expectedDraftVersion: 2 })
    await screen.findByText('请核对新资料'); await user.click(screen.getByRole('button', { name: '核对' }))
    await user.click(screen.getByRole('button', { name: '保留本次调整' }))
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', false))
    await user.click(confirmButton()); await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    const confirmations = calls.filter(call => call.path.endsWith('/actions/confirm')).map(call => confirmDoctorPreparationRequestSchema.parse(call.body))
    expect(confirmations).toHaveLength(2)
    expect(confirmations[0]!.input.selections).toMatchObject([{ catalogItemId: 'lab-A', source: 'agent' }])
    expect(confirmations[1]!.input).toEqual({ expectedDraftVersion: 2, selections: [{ kind: 'laboratory', catalogItemId: 'lab-B', indicationCode: 'clinical-evaluation', source: 'manual' }] })
    expect(issued).toEqual(['A', 'B'])
  } finally { unsubscribe() }
})
