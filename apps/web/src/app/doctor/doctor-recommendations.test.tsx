// @vitest-environment jsdom
import { doctorRecommendationStateSchema, confirmDoctorPreparationRequestSchema, type DoctorRecommendationState } from '@clinmesh/contracts/doctor-recommendations'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DoctorPreparationProvider, useDoctorPreparation } from './doctor-preparation-state.tsx'
import { DoctorRecommendationsPanel } from './doctor-recommendations.tsx'

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
function stubRequests(get: () => DoctorRecommendationState = () => state(), confirm: () => Promise<Response> | Response = () => receipt(get().kind), generate?: () => Promise<Response> | Response) {
  const calls: Array<{ path: string; method: string; body: unknown; key: string | null }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), key: new Headers(init?.headers).get('idempotency-key') })
    if (path.endsWith('/actions/confirm')) return confirm()
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
  it('keeps an edit made during submission even when its value returns to the submitted value', async () => {
    const delayed = deferredResponse(); const current = prescriptionState()
    stubRequests(() => current, () => delayed.response); const mounted = mount(props({ kind: 'prescription' }))
    await screen.findByText('合成药品'); const user = userEvent.setup()
    await edit(); fireEvent.change(screen.getByLabelText('每次剂量'), { target: { value: '10 mg' } })
    await user.click(screen.getByRole('button', { name: '保留本次调整' })); await user.click(confirmButton())
    await waitFor(() => expect(mounted.client.isMutating()).toBe(1))
    await edit(); fireEvent.change(screen.getByLabelText('每次剂量'), { target: { value: '20 mg' } })
    fireEvent.change(screen.getByLabelText('每次剂量'), { target: { value: '10 mg' } })
    await user.click(screen.getByRole('button', { name: '保留本次调整' }))
    await act(async () => { delayed.complete(receipt('prescription')) })
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
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
it('keeps physician edits and retries the same confirmation intent with the same idempotency key after failure', async () => {
  let fail = true; const current = prescriptionState()
  const calls = stubRequests(() => current, () => fail ? Response.json({ error: { code: 'WORKFLOW_CONFLICT', message: '合成资料变化。' } }, { status: 409 }) : receipt('prescription'))
  const mounted = mount(props({ kind: 'prescription' })); const user = userEvent.setup()
  await screen.findByText('合成药品'); await edit(); fireEvent.change(screen.getByLabelText('每次剂量'), { target: { value: '10 mg' } })
  await user.click(screen.getByRole('button', { name: '保留本次调整' })); await user.click(confirmButton())
  await screen.findByText('更新或提交未完成，草稿已保留，可重试。')
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
it.each(['diagnosis', 'laboratory', 'imaging', 'pathology'] as const)('keeps unguided %s considerations read-only inside details', async kind => {
  const thought = { id: 'thought', label: '核对流感方向', rationale: '合成推测仅供核对。', supportingInformation: [], opposingInformation: [], missingInformation: [], caseEvidenceIds: ['patient-statement-fever'] }
  const current = state({ kind, status: 'missing-evidence', items: [], guidelines: [], considerations: [thought] })
  const calls = stubRequests(() => current); mount(props({ kind })); await waitFor(() => expect(confirmButton()).toHaveProperty('disabled', true))
  expect(screen.queryByText(thought.label)).toBeNull()
  const dialog = await details(); const article = within(dialog.getByRole('article', { name: thought.label }))
  expect(article.getByText(thought.rationale)).toBeTruthy(); expect(article.queryByRole('button')).toBeNull()
  expect(calls.filter(call => call.path.endsWith('/actions/confirm'))).toHaveLength(0)
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
it.each(['identity', 'source', 'enabled'] as const)('hides a late confirmation failure after an A to B to A %s transition', async mode => {
  const delayed = deferredResponse(); stubRequests(() => state(), () => delayed.response)
  const original = props(); const mounted = mount(original); await screen.findByText('发热，未特指'); await userEvent.setup().click(confirmButton())
  mounted.rerenderPanel({ ...original, ...(mode === 'identity' ? { scope: 'doctor-b' } : mode === 'source' ? { inputRevision: 'source-b' } : { enabled: false }) })
  mounted.rerenderPanel(original); await screen.findByText('发热，未特指')
  await act(async () => { delayed.complete(Response.json({ error: { code: 'WORKFLOW_CONFLICT', message: '合成旧确认失败。' } }, { status: 409 })) })
  await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
  expect(screen.queryByText('更新或提交未完成，草稿已保留，可重试。')).toBeNull()
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
  const clinical = doctorCaseDetailSchema.parse({ caseId: 'case-fever', allergies: [], encounter: { id: 'encounter-fever', versionId: '3', status: 'in-progress' },
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
