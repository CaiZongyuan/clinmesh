// @vitest-environment jsdom
import { doctorRecommendationStateSchema, doctorReviewedInvestigationServiceSchema, confirmDoctorPreparationRequestSchema, type DoctorRecommendationState } from '@clinmesh/contracts/doctor-recommendations'
import { doctorCaseDetailSchema, sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { signOut } from '../api-client.ts'
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
  return { caseId: 'case-fever', kind: 'diagnosis', enabled: true, scope: 'workspace-demo:epoch-1:doctor:case-fever', inputRevision: 'case-source-1',
    investigationServiceFor: value => value.kind === 'diagnosis' || value.kind === 'prescription' ? undefined : doctorReviewedInvestigationServiceSchema.parse({
      id: value.kind === 'laboratory' ? value.catalogItemId : value.serviceId, version: 1,
      outpatientBilling: { id: 'synthetic-price', version: 1, priceFen: 1000, currency: 'CNY', unit: '项目', source: 'synthetic-test', effectiveOn: '2026-08-24' },
    }), ...overrides }
}
function prescriptionState(overrides: Partial<DoctorRecommendationState> = {}): DoctorRecommendationState {
  const first = state().items[0]!
  if (first.kind !== 'diagnosis') throw new Error('Expected diagnosis fixture')
  const { role: _role, referenceConcept: _referenceConcept, ...common } = first
  return state({ kind: 'prescription', items: [{ ...common, kind: 'prescription', id: 'prescription-1', catalogItemId: 'medication-1', label: '合成药品',
    doseText: '5 mg', frequencyCode: 'QD', routeCode: 'PO', courseDays: 30, quantity: 30 }], ...overrides })
}
function manualDiagnosisItems() {
  return [
    { label: '第一诊断', value: { source: 'manual' as const, kind: 'diagnosis' as const,
      catalogItemId: 'diagnosis-fever', role: 'primary' as const, note: '主诊断备注' } },
    { label: '第二诊断', value: { source: 'manual' as const, kind: 'diagnosis' as const,
      catalogItemId: 'diagnosis-influenza', role: 'secondary' as const, note: '次诊断备注' } },
  ]
}
function receipt(kind: DoctorRecommendationState['kind'] = 'diagnosis') {
  return Response.json({ data: { kind, draftVersion: 2, encounterVersion: '3', recordIds: ['formal-record-1'] }, auditId: 'audit-confirm', requestId: 'request-confirm', effects: [], warnings: [] })
}
function deferredResponse() {
  let complete!: (response: Response) => void
  const response = new Promise<Response>(resolve => { complete = resolve })
  return { response, complete }
}
function stubRequests(get: () => DoctorRecommendationState = () => state(), confirm: () => Promise<Response> | Response = () => receipt(get().kind), generate?: () => Promise<Response> | Response, disposition?: (body: unknown) => Promise<Response> | Response, confirmation?: () => Promise<Response> | Response) {
  const calls: Array<{ path: string; method: string; body: unknown; key: string | null }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), key: new Headers(init?.headers).get('idempotency-key') })
    if (path.endsWith('/actions/confirm')) return confirm()
    if (path.includes('/confirmations/')) return confirmation?.() ?? Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: 'No receipt' } }, { status: 404 })
    if (path.endsWith('/considerations/disposition')) return disposition === undefined ? Response.json({ dispositions: [] }) : disposition(JSON.parse(String(init?.body)))
    if (path.endsWith('/actions/generate')) return generate?.() ?? Response.json({ data: get(), auditId: 'audit-generate', requestId: 'request-generate', effects: [], warnings: [] })
    return Response.json(get())
  }))
  return calls
}
const clients: QueryClient[] = []
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
function mount(panelProps: ComponentProps<typeof DoctorRecommendationsPanel>, provider = false, session?: SessionContext) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const content = (next: ComponentProps<typeof DoctorRecommendationsPanel>) => <QueryClientProvider client={client}>{provider
    ? <DoctorPreparationProvider session={session} caseId={next.caseId} detail={undefined} enabled={next.enabled} inputRevision={next.inputRevision ?? '1'} scope={next.scope ?? ''}><DoctorRecommendationsPanel {...next} /><SubmissionProbe /></DoctorPreparationProvider>
    : <DoctorRecommendationsPanel {...next} />}</QueryClientProvider>
  const rendered = render(content(panelProps))
  return { ...rendered, client, rerenderPanel: (next: ComponentProps<typeof DoctorRecommendationsPanel>) => rendered.rerender(content(next)) }
}
const confirmButton = () => screen.getByRole('button', { name: /确认选中诊断|开具处方|开具选中项目|Confirm selected|Issue prescription|Issue selected/ })
const selectionCheckbox = (label = '发热，未特指') => screen.getByRole('checkbox', { name: `选择${label}` })
async function edit() { await userEvent.setup().click(screen.getByRole('button', { name: '调整' })); return within(await screen.findByRole('dialog')) }
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); sessionStorage.clear(); vi.unstubAllGlobals() })

describe('prepared clinical confirmation', () => {
  it.each((['laboratory', 'imaging', 'pathology'] as const).flatMap(kind =>
    (['succeeded', 'failed'] as const).map(status => ({ kind, status }))))('recovers the original $kind confirmation after logout only in its original scope ($status)', async ({ kind, status }) => {
    const calls = stubRequests(() => state({ kind, items: [] }),
      () => { throw new TypeError('Synthetic lost response') }, undefined, undefined, () => Response.json({
        data: { kind, caseId: 'case-fever', draftVersion: status === 'succeeded' ? 2 : 0, encounterVersion: '2',
          recordIds: status === 'succeeded' ? ['formal-record-1'] : [], results: [status === 'succeeded'
            ? { selectionIndex: 0, status, recordId: 'formal-record-1' }
            : { selectionIndex: 0, status, code: 'CATALOG_CONFLICT', message: 'Synthetic stale price' }] },
        auditId: 'audit-confirm', requestId: 'request-confirm', effects: [], warnings: [],
      }))
    const initial = props({ kind, encounter: { id: 'encounter-fever', versionId: '2' }, manualItems: [{
      label: '原检查', value: kind === 'laboratory'
        ? { source: 'manual', kind, catalogItemId: 'original-lab', indicationCode: 'clinical-evaluation' }
        : kind === 'imaging' ? { source: 'manual', kind, serviceId: 'original-imaging', indication: '原放射指征' }
          : { source: 'manual', kind, serviceId: 'original-pathology', sourceProcedureReference: 'Procedure/original', purpose: '原会诊目的' },
    }] })
    const user = userEvent.setup(), first = mount(initial)
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', false))
    await user.click(confirmButton())
    await screen.findByRole('button', { name: '恢复原开立' })
    await act(async () => { await signOut() })
    first.unmount()

    const other = mount({ ...initial, scope: 'another-account', manualItems: [] })
    expect(screen.queryByRole('button', { name: '恢复原开立' })).toBeNull()
    other.unmount()
    const restored = mount({ ...initial, manualItems: [] })
    await user.click(await screen.findByRole('button', { name: '恢复原开立' }))
    await waitFor(() => expect(restored.client.isMutating()).toBe(0))
    const posts = calls.filter(call => call.path.endsWith('/actions/confirm'))
    expect(posts).toHaveLength(1)
    expect(calls.find(call => call.path.includes('/confirmations/'))?.path).toContain(posts[0]!.key)
    expect(screen.queryByRole('button', { name: '恢复原开立' })).toBeNull()
    if (status === 'failed') {
      expect(screen.getByRole('checkbox', { name: '选择原检查' }).getAttribute('aria-checked')).toBe('true')
      restored.unmount()
      mount({ ...initial, manualItems: [] })
      await user.click(within(screen.getByRole('group', { name: '原检查' })).getByRole('button', { name: '调整' }))
      if (kind === 'laboratory') expect(screen.getByRole('combobox', { name: '检查目的' }).textContent).toContain('临床评估')
      else expect(screen.getByLabelText(kind === 'imaging' ? '检查目的' : '会诊目的')).toHaveProperty('value', kind === 'imaging' ? '原放射指征' : '原会诊目的')
    }
  })

  it.each(['receipt', 'rejection'])('keeps newer manual input after logout when recovery returns a $mode', async mode => {
    let postCount = 0
    const calls = stubRequests(() => state({ kind: 'laboratory', items: [] }),
      () => {
        if (++postCount === 1) throw new TypeError('Synthetic lost response')
        return Response.json({ error: { code: 'EXPECTED_VERSION_CONFLICT', message: 'Synthetic encounter advanced' } }, { status: 409 })
      }, undefined, undefined, () => mode === 'rejection'
        ? Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: 'No receipt' } }, { status: 404 })
        : Response.json({
        data: { kind: 'laboratory', caseId: 'case-fever', draftVersion: 0, encounterVersion: '2', recordIds: [],
          results: [{ selectionIndex: 0, status: 'failed', code: 'CATALOG_CONFLICT', message: 'Synthetic stale price' }] },
        auditId: 'audit-confirm', requestId: 'request-confirm', effects: [], warnings: [],
      }))
    const initial = props({ kind: 'laboratory', encounter: { id: 'encounter-fever', versionId: '2' }, manualItems: [
      { label: '原检查', value: { source: 'manual', kind: 'laboratory', catalogItemId: 'original-lab', indicationCode: 'clinical-evaluation' } },
    ] })
    const user = userEvent.setup(), first = mount(initial)
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', false))
    await user.click(confirmButton())
    await screen.findByRole('button', { name: '恢复原开立' })
    await act(async () => { await signOut() })
    first.unmount()
    mount({ ...initial, manualItems: [
      { label: '修改后的检查', value: { source: 'manual', kind: 'laboratory', catalogItemId: 'original-lab', indicationCode: 'fever' } },
    ] })
    await user.click(screen.getByRole('button', { name: '恢复原开立' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原开立' })).toBeNull())
    expect(screen.getByRole('checkbox', { name: '选择修改后的检查' })).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: '选择原检查' })).toBeNull()
    await edit()
    expect(screen.getByRole('combobox', { name: '检查目的' }).textContent).toContain('发热')
    expect(calls.filter(call => call.path.endsWith('/actions/confirm'))).toHaveLength(mode === 'rejection' ? 2 : 1)
  })


  it('诊断组丢响应后刷新只读原回执且保留主次和备注', async () => {
    const manualItems = manualDiagnosisItems()
    const calls = stubRequests(() => state({ items: [] }), () => { throw new TypeError('Synthetic lost diagnosis response') },
      undefined, undefined, () => receipt('diagnosis'))
    const initial = props({ encounter: { id: 'encounter-fever', versionId: '2' }, manualItems })
    const user = userEvent.setup(), first = mount(initial)
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', false))
    await user.click(confirmButton())
    await screen.findByRole('button', { name: '恢复原确认' })
    expect(confirmButton()).toHaveProperty('disabled', true)
    first.unmount()
    const onConfirmed = vi.fn()
    mount({ ...initial, manualItems: [], onConfirmed })
    await user.click(await screen.findByRole('button', { name: '恢复原确认' }))
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith(manualItems.map(item => item.value), expect.anything()))
    const posts = calls.filter(call => call.path.endsWith('/actions/confirm'))
    expect(posts).toHaveLength(1)
    expect(confirmDoctorPreparationRequestSchema.parse(posts[0]?.body).input.selections).toEqual(manualItems.map(item => item.value))
    expect(calls.find(call => call.path.includes('/confirmations/'))?.path).toContain(posts[0]!.key)
  })

  it('诊断组清空选择保留主次备注并跨刷新恢复，全选后仍限制唯一主诊断', async () => {
    stubRequests(() => state({ items: [] }))
    const manualItems = manualDiagnosisItems(), initial = props({ manualItems, encounter: { id: 'encounter-fever', versionId: '2' } })
    const user = userEvent.setup(), first = mount(initial)
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', false))
    await user.click(screen.getByRole('button', { name: '清空选择' }))
    expect(confirmButton()).toHaveProperty('disabled', true)
    for (const item of manualItems) expect(selectionCheckbox(item.label).getAttribute('aria-checked')).toBe('false')
    first.unmount()
    const second = mount(initial)
    for (const item of manualItems) expect(selectionCheckbox(item.label).getAttribute('aria-checked')).toBe('false')
    await user.click(screen.getByRole('button', { name: '全选可办理项目' }))
    for (const item of manualItems) expect(selectionCheckbox(item.label).getAttribute('aria-checked')).toBe('true')
    expect(confirmButton()).toHaveProperty('disabled', false)
    second.rerenderPanel({ ...initial, manualItems: manualItems.map(item => ({ ...item, value: { ...item.value, role: 'primary' } })) })
    expect(confirmButton()).toHaveProperty('disabled', true)
    expect(screen.getByText('请核对主次诊断，保留一条主诊断。')).toBeTruthy()
  })

  it.each([
    { status: 503, code: 'UNAVAILABLE' },
    { status: 409, code: 'DIAGNOSIS_PRIMARY_REQUIRED' },
  ])('诊断组回执查询失败 $code 不重发，明确不存在才重放原组且保留后来备注', async failure => {
    let absent = false, postCount = 0
    const calls = stubRequests(() => state({ items: [] }), () => {
      if (++postCount === 1) throw new TypeError('Synthetic lost diagnosis response')
      return receipt('diagnosis')
    }, undefined, undefined, () => Response.json({ error: {
      code: absent ? 'COMMAND_RECEIPT_NOT_FOUND' : failure.code, message: 'Synthetic diagnosis receipt read',
    } }, { status: absent ? 404 : failure.status }))
    const manualItems = manualDiagnosisItems(), onConfirmed = vi.fn()
    const initial = props({ manualItems, onConfirmed, encounter: { id: 'encounter-fever', versionId: '2' } })
    const mounted = mount(initial), user = userEvent.setup()
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', false))
    await user.click(confirmButton())
    await user.click(await screen.findByRole('button', { name: '恢复原确认' }))
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(calls.filter(call => call.path.endsWith('/actions/confirm'))).toHaveLength(1)
    expect(confirmButton()).toHaveProperty('disabled', true)
    mounted.rerenderPanel({ ...initial, manualItems: [{ ...manualItems[0]!, value: { ...manualItems[0]!.value, note: '后来重新核对的备注' } }, manualItems[1]!] })
    absent = true
    await user.click(screen.getByRole('button', { name: '恢复原确认' }))
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    const posts = calls.filter(call => call.path.endsWith('/actions/confirm'))
    expect(posts).toHaveLength(2)
    expect(posts[1]?.body).toEqual(posts[0]?.body)
    expect(posts[1]?.key).toBe(posts[0]?.key)
    expect(onConfirmed).toHaveBeenCalledWith([manualItems[1]!.value], expect.anything())
    expect(selectionCheckbox('第一诊断')).toBeTruthy()
  })

  it('诊断组原意图无法持久化时保留整组并阻止发送', async () => {
    const calls = stubRequests(() => state({ items: [] }))
    mount(props({ manualItems: manualDiagnosisItems(), encounter: { id: 'encounter-fever', versionId: '2' } }))
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', false))
    const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Synthetic diagnosis storage failure') })
    try { await userEvent.setup().click(confirmButton()) } finally { save.mockRestore() }
    await screen.findByText('待开记录无法读取或保存，已停止新开立。请恢复浏览器存储后重试。')
    expect(calls.filter(call => call.path.endsWith('/actions/confirm'))).toHaveLength(0)
    expect(confirmButton()).toHaveProperty('disabled', true)
    for (const item of manualDiagnosisItems()) expect(selectionCheckbox(item.label)).toBeTruthy()
  })

  it('整张双药处方丢响应后刷新只读原回执并禁止新开具', async () => {
    const manualItems = ['medication-one', 'medication-two'].map(catalogItemId => ({ label: catalogItemId, value: {
      source: 'manual' as const, kind: 'prescription' as const, catalogItemId,
      doseText: '5 mg', frequencyCode: 'QD', routeCode: 'PO' as const, courseDays: 30, quantity: 30,
    } }))
    const calls = stubRequests(() => prescriptionState({ items: [] }), () => { throw new TypeError('Synthetic lost prescription response') },
      undefined, undefined, () => receipt('prescription'))
    const initial = props({ kind: 'prescription', encounter: { id: 'encounter-fever', versionId: '2' }, manualItems })
    const user = userEvent.setup(), first = mount(initial)
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', false))
    await user.click(confirmButton())
    await screen.findByRole('button', { name: '恢复原开立' })
    expect(confirmButton()).toHaveProperty('disabled', true)
    first.unmount()
    const onConfirmed = vi.fn()
    mount({ ...initial, manualItems: [], onConfirmed })
    await user.click(await screen.findByRole('button', { name: '恢复原开立' }))
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith(manualItems.map(item => item.value), expect.anything()))
    const posts = calls.filter(call => call.path.endsWith('/actions/confirm'))
    expect(posts).toHaveLength(1)
    expect(calls.find(call => call.path.includes('/confirmations/'))?.path).toContain(posts[0]!.key)
  })

  it('处方恢复原回执时保留后来修改又恢复原值的输入', async () => {
    const delayed = deferredResponse()
    stubRequests(() => prescriptionState({ items: [] }), () => { throw new TypeError('Synthetic lost prescription response') },
      undefined, undefined, () => delayed.response)
    const value = { source: 'manual' as const, kind: 'prescription' as const, catalogItemId: 'manual-medication',
      doseText: '5 mg', frequencyCode: 'QD', routeCode: 'PO' as const, courseDays: 3, quantity: 3 }
    const onConfirmed = vi.fn(), initial = props({ kind: 'prescription', encounter: { id: 'encounter-fever', versionId: '2' },
      manualItems: [{ label: '医生药品', value }], onConfirmed })
    const mounted = mount(initial), user = userEvent.setup()
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', false))
    await user.click(confirmButton())
    await user.click(await screen.findByRole('button', { name: '恢复原开立' }))
    mounted.rerenderPanel({ ...initial, manualItems: [{ label: '医生药品', value: { ...value, doseText: '10 mg' } }] })
    mounted.rerenderPanel(initial)
    await act(async () => { delayed.complete(receipt('prescription')) })
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(onConfirmed).toHaveBeenCalledWith([], expect.objectContaining({ recordIds: ['formal-record-1'] }))
    expect(selectionCheckbox('医生药品')).toBeTruthy()
  })

  it('处方回执查询失败时保留原意图，明确不存在后才重放原整单并保留新输入', async () => {
    let absent = false, postCount = 0
    const calls = stubRequests(() => prescriptionState({ items: [] }), () => {
      if (++postCount === 1) throw new TypeError('Synthetic lost prescription response')
      return receipt('prescription')
    }, undefined, undefined, () => Response.json({ error: { code: absent ? 'COMMAND_RECEIPT_NOT_FOUND' : 'UNAVAILABLE', message: 'Synthetic receipt read' } }, { status: absent ? 404 : 503 }))
    const manualItems = ['medication-one', 'medication-two'].map(catalogItemId => ({ label: catalogItemId, value: {
      source: 'manual' as const, kind: 'prescription' as const, catalogItemId,
      doseText: '5 mg', frequencyCode: 'QD', routeCode: 'PO' as const, courseDays: 3, quantity: 3,
    } }))
    const onConfirmed = vi.fn(), initial = props({ kind: 'prescription', encounter: { id: 'encounter-fever', versionId: '2' }, manualItems, onConfirmed })
    const mounted = mount(initial), user = userEvent.setup()
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', false))
    await user.click(confirmButton())
    await user.click(await screen.findByRole('button', { name: '恢复原开立' }))
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(calls.filter(call => call.path.endsWith('/actions/confirm'))).toHaveLength(1)
    expect(confirmButton()).toHaveProperty('disabled', true)
    mounted.rerenderPanel({ ...initial, manualItems: [{ ...manualItems[0]!, value: { ...manualItems[0]!.value, doseText: '10 mg' } }, manualItems[1]!] })
    absent = true
    await user.click(screen.getByRole('button', { name: '恢复原开立' }))
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    const posts = calls.filter(call => call.path.endsWith('/actions/confirm'))
    expect(posts).toHaveLength(2)
    expect(posts[1]?.body).toEqual(posts[0]?.body)
    expect(posts[1]?.key).toBe(posts[0]?.key)
    expect(onConfirmed).toHaveBeenCalledWith([manualItems[1]!.value], expect.anything())
    expect(selectionCheckbox('medication-one')).toBeTruthy()
    expect(screen.getByText(/10 mg/)).toBeTruthy()
  })

  it('无法持久保存处方原意图时禁止发送并保留全部药品', async () => {
    const calls = stubRequests(() => prescriptionState({ items: [] }))
    const manualItems = ['medication-one', 'medication-two'].map(catalogItemId => ({ label: catalogItemId, value: {
      source: 'manual' as const, kind: 'prescription' as const, catalogItemId,
      doseText: '5 mg', frequencyCode: 'QD', routeCode: 'PO' as const, courseDays: 3, quantity: 3,
    } }))
    mount(props({ kind: 'prescription', encounter: { id: 'encounter-fever', versionId: '2' }, manualItems }))
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', false))
    const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Synthetic storage unavailable') })
    try { await userEvent.setup().click(confirmButton()) } finally { save.mockRestore() }
    await screen.findByText('待开记录无法读取或保存，已停止新开立。请恢复浏览器存储后重试。')
    expect(calls.filter(call => call.path.endsWith('/actions/confirm'))).toHaveLength(0)
    expect(selectionCheckbox('medication-one')).toBeTruthy()
    expect(selectionCheckbox('medication-two')).toBeTruthy()
    expect(confirmButton()).toHaveProperty('disabled', true)
  })

  it('双药处方整单明确拒绝后保留两行并以修正后的整单再次开具', async () => {
    let fail = true
    const calls = stubRequests(() => prescriptionState({ items: [] }), () => fail
      ? Response.json({ error: { code: 'WORKFLOW_CONFLICT', message: 'Synthetic invalid prescription' } }, { status: 409 }) : receipt('prescription'))
    const manualItems = ['medication-one', 'medication-two'].map(catalogItemId => ({ label: catalogItemId, value: {
      source: 'manual' as const, kind: 'prescription' as const, catalogItemId,
      doseText: '5 mg', frequencyCode: 'QD', routeCode: 'PO' as const, courseDays: 3, quantity: 3,
    } }))
    const initial = props({ kind: 'prescription', encounter: { id: 'encounter-fever', versionId: '2' }, manualItems }), mounted = mount(initial), user = userEvent.setup()
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', false))
    await user.click(confirmButton())
    await screen.findByText('更新或提交未完成，草稿已保留。')
    expect(selectionCheckbox('medication-one')).toBeTruthy()
    expect(selectionCheckbox('medication-two')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '恢复原开立' })).toBeNull()
    const corrected = [{ ...manualItems[0]!, value: { ...manualItems[0]!.value, doseText: '10 mg' } }, manualItems[1]!]
    mounted.rerenderPanel({ ...initial, manualItems: corrected })
    fail = false
    await user.click(confirmButton())
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    const posts = calls.filter(call => call.path.endsWith('/actions/confirm'))
    expect(posts).toHaveLength(2)
    expect(confirmDoctorPreparationRequestSchema.parse(posts[1]?.body).input.selections).toEqual(corrected.map(row => row.value))
    expect(posts[1]?.key).not.toBe(posts[0]?.key)
  })

  it('rechecks the server session after a receipt lookup before replaying the original order', async () => {
    const session = sessionContextSchema.parse({ user: { id: 'synthetic-account', email: 'doctor@example.test', name: '合成医生' },
      actor: { actorId: 'doctor', epoch: 'epoch-1', workspaceId: 'workspace-demo', scenarioRunId: 'scenario-1', practitionerRoleId: 'doctor-role', roleCode: 'outpatient-doctor' }, availableRoles: [] })
    let changed = false
    const calls = stubRequests(() => state({ kind: 'laboratory', items: [] }), () => { throw new TypeError('Synthetic lost response') }, undefined, undefined,
      () => { changed = true; return Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: 'Absent in changed session' } }, { status: 404 }) })
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input) === '/api/auth/context'
      ? Response.json({ ...session, actor: { ...session.actor, practitionerRoleId: changed ? 'another-role' : session.actor.practitionerRoleId } })
      : originalFetch(input, init)))
    const mounted = mount(props({ kind: 'laboratory', encounter: { id: 'encounter-fever', versionId: '2' }, manualItems: [
      { label: '原检验', value: { source: 'manual', kind: 'laboratory', catalogItemId: 'original-lab', indicationCode: 'clinical-evaluation' } },
    ] }), true, session)
    const user = userEvent.setup()
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', false))
    await user.click(confirmButton())
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    await user.click(screen.getByRole('button', { name: '恢复原开立' }))
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(calls.filter(call => call.path.includes('/confirmations/'))).toHaveLength(1)
    expect(calls.filter(call => call.path.endsWith('/actions/confirm'))).toHaveLength(1)
    expect(screen.getByRole('button', { name: '恢复原开立' })).toBeTruthy()
  })

  it.each(['scope', 'case', 'disabled', 'unmount'] as const)('does not resend an absent receipt after leaving the original %s context', async mode => {
    const delayed = deferredResponse()
    const calls = stubRequests(() => state({ kind: 'laboratory', items: [] }), () => { throw new TypeError('Synthetic lost response') }, undefined, undefined, () => delayed.response)
    const initial = props({ kind: 'laboratory', encounter: { id: 'encounter-fever', versionId: '2' }, manualItems: [
      { label: '原检验', value: { source: 'manual', kind: 'laboratory', catalogItemId: 'original-lab', indicationCode: 'clinical-evaluation' } },
    ] })
    const mounted = mount(initial), user = userEvent.setup()
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', false))
    await user.click(confirmButton())
    await user.click(await screen.findByRole('button', { name: '恢复原开立' }))
    await waitFor(() => expect(calls.filter(call => call.path.includes('/confirmations/'))).toHaveLength(1))
    if (mode === 'unmount') mounted.unmount()
    else {
      mounted.rerenderPanel({ ...initial, ...(mode === 'scope' ? { scope: 'other-doctor' } : mode === 'case' ? { caseId: 'other-case' } : { enabled: false }) })
      mounted.rerenderPanel(initial)
    }
    await act(async () => { delayed.complete(Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: 'Absent' } }, { status: 404 })) })
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(calls.filter(call => call.path.endsWith('/actions/confirm'))).toHaveLength(1)
    if (mode !== 'unmount') expect(screen.getByRole('button', { name: '恢复原开立' })).toBeTruthy()
  })

  it.each(['non-json', 'IDEMPOTENCY_KEY_REUSED', 'UNKNOWN_REJECTION'])('preserves the frozen original key after an uncertain %s rejection', async rejection => {
    const calls = stubRequests(() => state({ kind: 'laboratory', items: [] }), () => rejection === 'non-json'
      ? new Response('Synthetic gateway', { status: 409 })
      : Response.json({ error: { code: rejection, message: 'Uncertain original result' } }, { status: 409 }))
    const mounted = mount(props({ kind: 'laboratory', encounter: { id: 'encounter-fever', versionId: '2' }, manualItems: [
      { label: '待核对检验', value: { source: 'manual', kind: 'laboratory', catalogItemId: 'original-lab', indicationCode: 'clinical-evaluation' } },
    ] }))
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', false))
    await userEvent.setup().click(confirmButton())
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(await screen.findByRole('button', { name: '恢复原开立' })).toBeTruthy()
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', true))
    expect(calls.filter(call => call.path.endsWith('/actions/confirm'))).toHaveLength(1)
  })

  it('consumes a successful edited investigation while only its checkbox changes during the request', async () => {
    const delayed = deferredResponse()
    stubRequests(() => state({ kind: 'laboratory', items: [] }), () => delayed.response)
    const onConfirmed = vi.fn()
    mount(props({ kind: 'laboratory', encounter: { id: 'encounter-fever', versionId: '2' }, onConfirmed, manualItems: [
      { label: '已调整检验', value: { source: 'manual', kind: 'laboratory', catalogItemId: 'edited-lab', indicationCode: 'clinical-evaluation' } },
    ] }))
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '调整' }))
    await user.click(screen.getByRole('button', { name: '保留本次调整' }))
    await user.click(confirmButton())
    await user.click(selectionCheckbox('已调整检验'))
    await act(async () => { delayed.complete(receipt('laboratory')) })
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith([expect.objectContaining({ catalogItemId: 'edited-lab' })], expect.anything()))
    expect(screen.queryByRole('checkbox', { name: '选择已调整检验' })).toBeNull()
  })

  it('selects eligible investigations and clears selection without deleting drafts', async () => {
    stubRequests(() => state({ kind: 'laboratory', items: [] }))
    mount(props({ kind: 'laboratory', encounter: { id: 'encounter-fever', versionId: '2' }, manualItems: [
      { label: '完整检验', value: { source: 'manual', kind: 'laboratory', catalogItemId: 'complete-lab', indicationCode: 'clinical-evaluation' } },
      { label: '未完成检验', value: { source: 'manual', kind: 'laboratory', catalogItemId: 'incomplete-lab', indicationCode: '' } },
    ] }))
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '清空选择' }))
    expect(selectionCheckbox('完整检验').getAttribute('aria-checked')).toBe('false')
    expect(selectionCheckbox('未完成检验')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '全选可办理项目' }))
    expect(selectionCheckbox('完整检验').getAttribute('aria-checked')).toBe('true')
    expect(selectionCheckbox('未完成检验').getAttribute('aria-checked')).toBe('false')
  })

  it('处方清空选择保留所有药品，再全选只勾选当前可办理行', async () => {
    stubRequests(() => prescriptionState({ items: [] }))
    const complete = { source: 'manual' as const, kind: 'prescription' as const, catalogItemId: 'complete-medication',
      doseText: '5 mg', frequencyCode: 'QD', routeCode: 'PO' as const, courseDays: 3, quantity: 3 }
    mount(props({ kind: 'prescription', encounter: { id: 'encounter-fever', versionId: '2' }, manualItems: [
      { label: '完整药品', value: complete }, { label: '未完成药品', value: { ...complete, catalogItemId: 'incomplete-medication', doseText: null } },
      { label: '不可办理药品', value: { ...complete, catalogItemId: 'unavailable-medication' } },
    ], manualUnavailableReason: value => value.kind === 'prescription' && value.catalogItemId === 'unavailable-medication' ? '合成禁用药品' : undefined }))
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '清空选择' }))
    for (const label of ['完整药品', '未完成药品', '不可办理药品']) expect(selectionCheckbox(label).getAttribute('aria-checked')).toBe('false')
    await user.click(screen.getByRole('button', { name: '全选可办理项目' }))
    expect(selectionCheckbox('完整药品').getAttribute('aria-checked')).toBe('true')
    expect(selectionCheckbox('未完成药品').getAttribute('aria-checked')).toBe('false')
    expect(selectionCheckbox('不可办理药品').getAttribute('aria-checked')).toBe('false')
  })

  it('recovers a lost laboratory response after reload using the original receipt while the model is unavailable', async () => {
    const manualItems = [{ label: '原检验', value: { source: 'manual' as const, kind: 'laboratory' as const,
      catalogItemId: 'original-lab', indicationCode: 'clinical-evaluation' } }]
    let unavailable = false
    const calls = stubRequests(() => state({ kind: 'laboratory', status: unavailable ? 'failed' : 'ready', items: [] }),
      () => { throw new TypeError('Synthetic lost response') }, undefined, undefined, () => receipt('laboratory'))
    const initial = props({ kind: 'laboratory', encounter: { id: 'encounter-fever', versionId: '2' }, manualItems })
    const first = mount(initial)
    await waitFor(() => expect(confirmButton().hasAttribute('disabled')).toBe(false))
    await userEvent.setup().click(confirmButton())
    await screen.findByRole('button', { name: '恢复原开立' })
    first.unmount(); unavailable = true
    const onConfirmed = vi.fn()
    mount({ ...initial, onConfirmed })
    await userEvent.setup().click(await screen.findByRole('button', { name: '恢复原开立' }))
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith([expect.objectContaining({ catalogItemId: 'original-lab' })], expect.anything()))
    const posts = calls.filter(call => call.path.endsWith('/actions/confirm'))
    expect(posts).toHaveLength(1)
    expect(calls.find(call => call.path.includes('/confirmations/'))?.path).toContain(posts[0]!.key)
  })

  it.each([{ code: 'UNAVAILABLE', status: 503 }, { code: 'EXPECTED_VERSION_CONFLICT', status: 409 }])('keeps the original intent after a $code receipt read error and resends only its frozen body and key when absent', async ({ code, status }) => {
    let receiptAvailable = false, postCount = 0
    const calls = stubRequests(() => state({ kind: 'laboratory', items: [] }), () => {
      if (++postCount === 1) throw new TypeError('Synthetic lost response')
      return receipt('laboratory')
    }, undefined, undefined, () => Response.json({ error: { code: receiptAvailable ? 'COMMAND_RECEIPT_NOT_FOUND' : code, message: 'Synthetic read error' } }, { status: receiptAvailable ? 404 : status }))
    const initial = props({ kind: 'laboratory', encounter: { id: 'encounter-fever', versionId: '2' }, manualItems: [
      { label: '冻结检验', value: { source: 'manual', kind: 'laboratory', catalogItemId: 'frozen-lab', indicationCode: 'clinical-evaluation' } },
    ] })
    const mounted = mount(initial)
    await waitFor(() => expect(confirmButton().hasAttribute('disabled')).toBe(false))
    await userEvent.setup().click(confirmButton())
    await userEvent.setup().click(await screen.findByRole('button', { name: '恢复原开立' }))
    await waitFor(() => expect(calls.filter(call => call.path.includes('/confirmations/'))).toHaveLength(1))
    expect(calls.filter(call => call.path.endsWith('/actions/confirm'))).toHaveLength(1)
    mounted.rerenderPanel({ ...initial, manualItems: [{ label: '已修改检验', value: { source: 'manual', kind: 'laboratory', catalogItemId: 'changed-lab', indicationCode: 'fever' } }] })
    receiptAvailable = true
    await userEvent.setup().click(await screen.findByRole('button', { name: '恢复原开立' }))
    await waitFor(() => expect(calls.filter(call => call.path.endsWith('/actions/confirm'))).toHaveLength(2))
    const posts = calls.filter(call => call.path.endsWith('/actions/confirm'))
    expect(posts[1]?.body).toEqual(posts[0]?.body)
    expect(posts[1]?.key).toBe(posts[0]?.key)
  })

  it.each((['laboratory', 'imaging', 'pathology'] as const).flatMap(kind =>
    (['initial', 'recovery'] as const).map(mode => ({ kind, mode }))))('releases a definitive $kind version conflict during $mode and allows a fresh confirmation', async ({ kind, mode }) => {
    let postCount = 0
    const rejectedPost = mode === 'recovery' ? 2 : 1
    const calls = stubRequests(() => state({ kind, items: [] }), () => {
      postCount++
      if (mode === 'recovery' && postCount === 1) throw new TypeError('Synthetic lost response')
      return postCount === rejectedPost
        ? Response.json({ error: { code: 'EXPECTED_VERSION_CONFLICT', message: 'Synthetic encounter advanced' } }, { status: 409 })
        : receipt(kind)
    })
    const onConfirmed = vi.fn()
    const initial = props({ kind, onConfirmed, encounter: { id: 'encounter-fever', versionId: '2' }, manualItems: [{
      label: '保留检查', value: kind === 'laboratory'
        ? { source: 'manual', kind, catalogItemId: 'original-lab', indicationCode: 'clinical-evaluation' }
        : kind === 'imaging' ? { source: 'manual', kind, serviceId: 'original-imaging', indication: '原放射指征' }
          : { source: 'manual', kind, serviceId: 'original-pathology', sourceProcedureReference: 'Procedure/original', purpose: '原会诊目的' },
    }] })
    const user = userEvent.setup()
    let mounted = mount(initial)
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', false))
    await user.click(confirmButton())
    if (mode === 'recovery') {
      await screen.findByRole('button', { name: '恢复原开立' })
      await act(async () => { await signOut() })
      mounted.unmount()
      mounted = mount({ ...initial, manualItems: [] })
      await user.click(await screen.findByRole('button', { name: '恢复原开立' }))
    }
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(postCount).toBe(rejectedPost)
    expect(screen.queryByRole('button', { name: '恢复原开立' })).toBeNull()
    expect(selectionCheckbox('保留检查').getAttribute('aria-checked')).toBe('true')
    expect(onConfirmed).not.toHaveBeenCalled()

    mounted.rerenderPanel({ ...initial, manualItems: mode === 'recovery' ? [] : initial.manualItems,
      encounter: { id: 'encounter-fever', versionId: '3' } })
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', false))
    await user.click(confirmButton())
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledOnce())
    const posts = calls.filter(call => call.path.endsWith('/actions/confirm'))
    expect(posts).toHaveLength(rejectedPost + 1)
    expect(posts[0]?.body).toMatchObject({ expectedVersions: { 'Encounter/encounter-fever': '2' } })
    expect(posts.at(-1)?.body).toMatchObject({ expectedVersions: { 'Encounter/encounter-fever': '3' } })
    expect(posts.at(-1)?.key).not.toBe(posts[0]?.key)
    if (mode === 'recovery') {
      expect(posts[1]?.body).toEqual(posts[0]?.body)
      expect(posts[1]?.key).toBe(posts[0]?.key)
      expect(calls.filter(call => call.path.includes('/confirmations/'))).toHaveLength(1)
    }
  })

  it('keeps a rejected recovery intent until its missing inputs can be saved', async () => {
    let postCount = 0
    const calls = stubRequests(() => state({ kind: 'laboratory', items: [] }), () => {
      if (++postCount === 1) throw new TypeError('Synthetic lost response')
      return Response.json({ error: { code: 'EXPECTED_VERSION_CONFLICT', message: 'Synthetic encounter advanced' } }, { status: 409 })
    })
    const initial = props({ kind: 'laboratory', encounter: { id: 'encounter-fever', versionId: '2' }, manualItems: [
      { label: '原检验', value: { source: 'manual', kind: 'laboratory', catalogItemId: 'original-lab', indicationCode: 'clinical-evaluation' } },
    ] })
    const user = userEvent.setup(), first = mount(initial)
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', false))
    await user.click(confirmButton())
    await screen.findByRole('button', { name: '恢复原开立' })
    await act(async () => { await signOut() })
    first.unmount()
    const restored = mount({ ...initial, manualItems: [] })
    const save = sessionStorage.setItem.bind(sessionStorage)
    const failingStorage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
      if (key.startsWith('clinmesh.outpatient-investigation.preferences:')) throw new DOMException('Synthetic denied save', 'QuotaExceededError')
      save(key, value)
    })
    try {
      await user.click(screen.getByRole('button', { name: '恢复原开立' }))
      await waitFor(() => expect(restored.client.isMutating()).toBe(0))
      expect(postCount).toBe(2)
      expect(screen.getByRole('button', { name: '恢复原开立' })).toBeTruthy()
      expect(confirmButton()).toHaveProperty('disabled', true)
    } finally { failingStorage.mockRestore() }
    restored.unmount()
    mount({ ...initial, manualItems: [] })
    await user.click(screen.getByRole('button', { name: '恢复原开立' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原开立' })).toBeNull())
    expect(selectionCheckbox('原检验').getAttribute('aria-checked')).toBe('true')
    const posts = calls.filter(call => call.path.endsWith('/actions/confirm'))
    expect(posts).toHaveLength(3)
    expect(posts.every(post => post.key === posts[0]?.key && JSON.stringify(post.body) === JSON.stringify(posts[0]?.body))).toBe(true)
  })

  it('uses the current form adapter when a delayed recovery rejection meets newer input', async () => {
    const rejection = deferredResponse()
    let postCount = 0
    stubRequests(() => state({ kind: 'imaging', items: [] }), () => {
      if (++postCount === 1) throw new TypeError('Synthetic lost response')
      return rejection.response
    })
    const oldAdapter = vi.fn(() => true), currentAdapter = vi.fn(() => false)
    const initial = props({ kind: 'imaging', onManualChange: oldAdapter, encounter: { id: 'encounter-fever', versionId: '2' }, manualItems: [
      { label: '原放射检查', value: { source: 'manual', kind: 'imaging', serviceId: 'original-imaging', indication: '原放射指征' } },
    ] })
    const user = userEvent.setup(), first = mount(initial)
    await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', false))
    await user.click(confirmButton())
    await screen.findByRole('button', { name: '恢复原开立' })
    await act(async () => { await signOut() })
    first.unmount()
    const restored = mount({ ...initial, manualItems: [] })
    await user.click(screen.getByRole('button', { name: '恢复原开立' }))
    await waitFor(() => expect(postCount).toBe(2))
    oldAdapter.mockClear()
    restored.rerenderPanel({ ...initial, onManualChange: currentAdapter, manualItems: [
      { label: '新放射检查', value: { source: 'manual', kind: 'imaging', serviceId: 'new-imaging', indication: '新放射指征' } },
    ] })
    await act(async () => rejection.complete(Response.json({ error: { code: 'EXPECTED_VERSION_CONFLICT', message: 'Synthetic encounter advanced' } }, { status: 409 })))
    await waitFor(() => expect(restored.client.isMutating()).toBe(0))
    expect(oldAdapter).not.toHaveBeenCalled()
    expect(currentAdapter).toHaveBeenCalledWith(expect.objectContaining({ value: expect.objectContaining({ serviceId: 'original-imaging' }) }))
    expect(screen.getByRole('button', { name: '恢复原开立' })).toBeTruthy()
    expect(selectionCheckbox('新放射检查')).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: '选择原放射检查' })).toBeNull()
  })

  it('consumes only the successful manual laboratory row and retains the failed row with its input', async () => {
    const manualItems = ['first-lab', 'second-lab'].map(catalogItemId => ({ label: catalogItemId, value: {
      source: 'manual' as const, kind: 'laboratory' as const, catalogItemId, indicationCode: 'clinical-evaluation',
    } }))
    stubRequests(() => state({ kind: 'laboratory', items: [] }), () => Response.json({
      data: { kind: 'laboratory', caseId: 'case-fever', draftVersion: 2, encounterVersion: '2', recordIds: ['first-record'], results: [
        { selectionIndex: 0, status: 'succeeded', recordId: 'first-record' },
        { selectionIndex: 1, status: 'failed', code: 'CATALOG_CONFLICT', message: 'Synthetic stale price' },
      ] }, auditId: 'audit-confirm', requestId: 'request-confirm', effects: [], warnings: [],
    }))
    const onConfirmed = vi.fn()
    mount(props({ kind: 'laboratory', encounter: { id: 'encounter-fever', versionId: '2' }, manualItems, onConfirmed }))
    await screen.findByRole('checkbox', { name: '选择second-lab' })
    await userEvent.setup().click(confirmButton())
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith([expect.objectContaining({ catalogItemId: 'first-lab' })],
      expect.objectContaining({ recordIds: ['first-record'] })))
    expect(screen.queryByRole('checkbox', { name: '选择first-lab' })).toBeNull()
    expect(selectionCheckbox('second-lab').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(/second-lab.*失败/)).toBeTruthy()
  })

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
    const selected = { source: 'manual' as const, kind: 'prescription' as const, catalogItemId: 'medication-selected', doseText: '5 mg', frequencyCode: 'QD', routeCode: 'PO' as const, courseDays: 3, quantity: 3 }
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
    const value = { source: 'manual' as const, kind: 'prescription' as const, catalogItemId: 'manual-medication', doseText: '5 mg', frequencyCode: 'QD', routeCode: 'PO' as const, courseDays: 3, quantity: 3 }
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
  it('does not reveal the old automatic copy after a confirmed manual item is removed from its form', async () => {
    const current = prescriptionState(); stubRequests(() => current)
    const value = { source: 'manual' as const, kind: 'prescription' as const, catalogItemId: 'medication-1', doseText: '5 mg', frequencyCode: 'QD', routeCode: 'PO' as const, courseDays: 30, quantity: 30 }
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

  it('shares physician form values with row edits and exposes the manual entry in the same list', async () => {
    const current = prescriptionState(); stubRequests(() => current)
    const onManualChange = vi.fn(), onManualRemove = vi.fn()
    const initial = props({ kind: 'prescription', onManualChange, onManualRemove,
      manualControls: <button type="button">添加药品</button>,
      manualItems: [{ label: '合成药品', value: { source: 'manual', kind: 'prescription', catalogItemId: 'medication-1', doseText: '5 mg', frequencyCode: 'QD', routeCode: 'PO', courseDays: 30, quantity: 30 } }] })
    const mounted = mount(initial)
    await screen.findByText('合成药品')
    const user = userEvent.setup(); await edit()
    fireEvent.change(screen.getByLabelText('每次剂量'), { target: { value: '10 mg' } })
    await user.click(screen.getByRole('button', { name: '保留本次调整' }))
    expect(onManualChange).toHaveBeenCalledWith({ label: '合成药品', value: expect.objectContaining({ source: 'manual', doseText: '10 mg' }) })
    mounted.rerenderPanel({ ...initial, manualItems: [{ label: '合成药品', value: { ...initial.manualItems![0]!.value, kind: 'prescription', source: 'manual', catalogItemId: 'medication-1', doseText: '20 mg', frequencyCode: 'QD', routeCode: 'PO', courseDays: 30, quantity: 30 } }] })
    expect(screen.getByText(/20 mg/)).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '待开具处方' })).getByRole('button', { name: '添加药品' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '移除合成药品' }))
    expect(onManualRemove).toHaveBeenCalledWith(expect.objectContaining({ source: 'manual', doseText: '20 mg' }))
  })



})




it('shows a doctor-authored free-text frequency without replacing it with a verification warning', async () => {
  stubRequests(() => prescriptionState())
  mount(props({ kind: 'prescription', manualItems: [{ label: '医生填写的药品', value: {
    source: 'manual', kind: 'prescription', catalogItemId: 'medication-free-text', doseText: '一片',
    frequencyCode: '每晚睡前一次', routeCode: 'PO', courseDays: 3, quantity: 3,
  } }] }))
  expect(await screen.findByText(/一片 · 每晚睡前一次 · 口服（po） · 3 天 · 3/)).toBeTruthy()
  expect(screen.queryByText(/频次待核对/)).toBeNull()
})


it.each(['pending', 'failed', 'missing-evidence'] as const)('keeps automatic confirmation unavailable for a %s result', async status => {
  const current = state({ status, items: status === 'missing-evidence' ? [] : state().items })
  stubRequests(() => current); mount(props()); await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', true))
})















