// @vitest-environment jsdom
import { cleanup, render as renderComponent, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import userEvent from '@testing-library/user-event'
import type { ClinicalDocumentContent, DoctorCaseDetail } from '@clinmesh/contracts/his'
import { checkClinicalDocumentQualityRequestSchema, clinicalDocumentQualityControlStateSchema, type ClinicalDocumentQualityControlState } from '@clinmesh/contracts/his'
import { afterEach, expect, it, vi } from 'vitest'
import { ClinicalDocumentPage, type ClinicalDocumentPageActions } from './clinical-document-page.tsx'
import { getWorkspaceMessages } from '../workspace-i18n.ts'

const clients: QueryClient[] = []
function render(element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const view = renderComponent(<QueryClientProvider client={client}>{element}</QueryClientProvider>)
  return { ...view, rerender: (next: ReactElement) => view.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>) }
}
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.unstubAllGlobals()
})
const content: ClinicalDocumentContent = {
  chiefComplaint: '头晕一周。', historyOfPresentIllness: '起立时明显。', priorMedicalHistory: '既往高血压。',
  familyHistory: '父亲患高血压。', allergyHistory: '无已知过敏。', physicalExamination: '查体正常。',
  menstrualHistory: '患者自述月经规律。', obstetricHistory: '患者自述从未妊娠。',
  auxiliaryExamination: '暂无检查。', assessment: '初步评估。', disposition: '门诊随访。', followUp: '加重及时就诊。',
}
const signed = (revisionNumber: number) => ({
  bundleId: `bundle-${revisionNumber}`, compositionId: `composition-${revisionNumber}`, compositionVersion: '1',
  content: { ...content, assessment: `第 ${revisionNumber} 版评估。` }, documentId: `document-${revisionNumber}`,
  provenanceId: `provenance-${revisionNumber}`, revisionNumber, signedAt: '2026-10-16T09:00:00+08:00',
  ...(revisionNumber > 1 ? { revisionReason: `第 ${revisionNumber} 次核对。` } : {}),
})
const detail: DoctorCaseDetail = {
  registrationNumber: null,
  allergies: [], caseId: 'synthetic-case', encounter: { id: 'encounter', status: 'in-progress', versionId: '1' },
  patient: { id: 'patient', identifier: 'SYNTHETIC', name: '合成患者', gender: 'female', birthDate: '1990-01-01', synthetic: true, versionId: '1' },
  presentation: null, priorFacts: [], status: 'first-visit', taskId: 'task', taskVersion: '1',
  clinicalDocument: { signed: [signed(2), signed(1), signed(3)] },
}
function setup() {
  const actions: ClinicalDocumentPageActions = {
    prepareSign: { data: undefined, error: null, onReset: vi.fn(), onSubmit: vi.fn(), pending: false },
    revise: { error: null, onSubmit: vi.fn(), pending: false, success: false },
    sign: { error: null, onSubmit: vi.fn(), pending: false, success: false },
  }
  const props = { actions, allowRevision: true, detail, elementId: 'document', locale: 'zh-CN' as const,
    messages: getWorkspaceMessages('zh-CN'), onDocumentChange: vi.fn(), workingDocument: content }
  return { actions, props }
}

it('places revision first, sorts all signed versions newest first and keeps independent history review out of the form', async () => {
  const user = userEvent.setup()
  const { actions, props } = setup()
  render(<ClinicalDocumentPage {...props} />)
  const form = screen.getByRole('form', { name: '修订病历版本' })
  const history = screen.getByRole('region', { name: '签署历史' })
  expect(form.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const entries = within(history).getAllByRole('listitem')
  expect(entries.map(entry => entry.querySelector('summary')?.textContent)).toEqual([
    expect.stringContaining('第 3 次签署'), expect.stringContaining('第 2 次签署'), expect.stringContaining('第 1 次签署'),
  ])
  expect(within(entries[0]!).getByText('当前生效')).toBeTruthy()
  expect(entries.every(entry => !entry.querySelector('details')!.open)).toBe(true)
  const assessment = within(form).getByLabelText<HTMLTextAreaElement>('评估')
  expect(assessment.value).toBe('第 3 版评估。')
  await user.clear(assessment)
  await user.type(assessment, '尚未提交的新评估。')
  await user.type(within(form).getByLabelText('修订原因'), '待核对原因。')
  await user.click(entries[2]!.querySelector('summary')!)
  await user.click(entries[0]!.querySelector('summary')!)
  expect(entries[2]!.querySelector('details')!.open).toBe(true)
  expect(entries[0]!.querySelector('details')!.open).toBe(true)
  expect(assessment.value).toBe('尚未提交的新评估。')
  expect(within(form).getByLabelText<HTMLTextAreaElement>('修订原因').value).toBe('待核对原因。')
  expect(actions.revise.onSubmit).not.toHaveBeenCalled()
  expect(actions.prepareSign.onSubmit).not.toHaveBeenCalled()
  await user.click(within(form).getByRole('button', { name: '提交病历修订' }))
  const dialog = screen.getByRole('alertdialog', { name: '确认提交病历修订' })
  await user.click(within(dialog).getByRole('button', { name: '确认提交修订' }))
  expect(actions.revise.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    compositionId: 'composition-3', document: expect.objectContaining({ assessment: '尚未提交的新评估。' }), reason: '待核对原因。',
  }))
})

it('preserves open history across data refreshes, collapses new versions and resets history when the case changes', async () => {
  const { props } = setup()
  const { rerender } = render(<ClinicalDocumentPage {...props} />)
  await userEvent.click(screen.getByText('第 1 次签署'))
  rerender(<ClinicalDocumentPage {...props} detail={{ ...detail, clinicalDocument: { signed: [signed(1), signed(2), signed(3), signed(4)] } }} />)
  const history = screen.getByRole('region', { name: '签署历史' })
  expect(history.querySelector('details')!.open).toBe(false)
  expect(screen.getByText('第 1 次签署').closest('details')!.open).toBe(true)
  expect(screen.getByRole('form', { name: '修订病历版本' }).querySelector('[name="assessment"]')).toHaveProperty('value', '第 4 版评估。')
  rerender(<ClinicalDocumentPage {...props} detail={{ ...detail, caseId: 'another-case' }} />)
  expect([...screen.getByRole('region', { name: '签署历史' }).querySelectorAll('details')].every(entry => !entry.open)).toBe(true)
})

function stubReadyQualityFetch() {
  let quality: ClinicalDocumentQualityControlState | undefined
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path === '/api/his/v1/doctor/cases/synthetic-case/document-quality-control/actions/check') {
      const request = checkClinicalDocumentQualityRequestSchema.parse(JSON.parse(String(init?.body)))
      quality = clinicalDocumentQualityControlStateSchema.parse({ caseId: 'synthetic-case', encounterId: 'encounter',
        draftVersion: 0, clientId: request.input.clientId, clientRevision: request.input.clientRevision,
        documentFingerprint: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64), generation: 1,
        stale: false, status: 'ready', issues: [], notices: [] })
      return Response.json({ data: quality, auditId: 'audit-quality', effects: [], requestId: 'request-quality', warnings: [] })
    }
    if (path === '/api/his/v1/doctor/cases/synthetic-case/document-quality-control' && quality !== undefined) return Response.json(quality)
    throw new Error(`Unexpected request: ${path}`)
  }))
}

it('allows read-only history review and keeps unsigned drafts free of empty history', async () => {
  stubReadyQualityFetch()
  const { props } = setup()
  const { rerender } = render(<ClinicalDocumentPage {...props} allowRevision={false} />)
  expect(screen.queryByRole('form')).toBeNull()
  await userEvent.click(screen.getByText('第 1 次签署'))
  expect(screen.getByText('第 1 次签署').closest('details')!.open).toBe(true)
  rerender(<ClinicalDocumentPage {...props} detail={{ ...detail, clinicalDocument: { signed: [] } }} />)
  expect(screen.queryByRole('region', { name: '签署历史' })).toBeNull()
  expect(screen.getByRole('form', { name: '结构化病历' })).toBeTruthy()
})

it('merges collapsed reproductive history fields without duplicate labels, restores focus and keeps nonblank values expanded', async () => {
  stubReadyQualityFetch()
  const user = userEvent.setup()
  const { actions, props } = setup()
  const blankReproductive: ClinicalDocumentContent = { ...content, menstrualHistory: '', obstetricHistory: '' }
  const maleDetail: DoctorCaseDetail = {
    ...detail,
    patient: { ...detail.patient, gender: 'male' },
    clinicalHistory: {
      policyVersion: 'outpatient-history-v2',
      requiredFields: [],
      reason: 'non-female',
      showByDefault: false,
      visitKind: 'unknown',
      classificationEditable: false,
    },
    clinicalDocument: { signed: [] },
  }
  const { rerender } = render(<ClinicalDocumentPage {...props} detail={maleDetail} workingDocument={blankReproductive} />)
  const form = screen.getByRole('form', { name: '结构化病历' })
  expect(form.querySelectorAll('summary').length).toBe(0)
  expect(within(form).queryByText(/可留空|默认免填/)).toBeNull()
  expect(form.querySelector('[data-clinical-document-field="chiefComplaint"] [data-required-indicator]')?.textContent).toBe('*')
  expect(form.querySelector('[data-clinical-document-field="familyHistory"] [data-required-indicator]')).toBeNull()
  expect(form.querySelector('[data-clinical-document-field="allergyHistory"] [data-required-indicator]')).toBeNull()
  const disclosure = form.querySelector('[data-reproductive-history-disclosure]')!
  expect(disclosure.getAttribute('data-reproductive-history-disclosure')).toBe('collapsed')
  expect(within(disclosure as HTMLElement).getByText('月经史、孕产史').classList.contains('text-muted-foreground')).toBe(true)
  expect(form.querySelector('[data-clinical-document-field="allergyHistory"]')!.compareDocumentPosition(disclosure)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  expect(disclosure.compareDocumentPosition(form.querySelector('[data-clinical-document-field="physicalExamination"]')!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  expect(within(form).getByLabelText('月经史').closest('[hidden]')).toBeTruthy()
  expect(within(form).getByLabelText('孕产史').closest('[hidden]')).toBeTruthy()

  const expandButton = within(form).getByRole('button', { name: /展开/ })
  await user.click(expandButton)
  expect(disclosure.getAttribute('data-reproductive-history-disclosure')).toBe('expanded')
  expect(within(form).queryByText(/可留空|默认免填/)).toBeNull()
  expect(disclosure.querySelectorAll('[data-required-indicator]')).toHaveLength(0)
  for (const label of ['月经史', '孕产史']) {
    expect(within(disclosure as HTMLElement).getByText(label).classList.contains('text-muted-foreground')).toBe(true)
  }
  const menstrualInput = within(form).getByLabelText<HTMLTextAreaElement>('月经史')
  const obstetricInput = within(form).getByLabelText<HTMLTextAreaElement>('孕产史')
  expect(menstrualInput.closest('[hidden]')).toBeNull()
  expect(obstetricInput.closest('[hidden]')).toBeNull()
  expect(document.activeElement).toBe(menstrualInput)
  expect(within(disclosure as HTMLElement).getAllByText('月经史')).toHaveLength(1)
  expect(within(disclosure as HTMLElement).getAllByText('孕产史')).toHaveLength(1)

  await user.click(within(disclosure as HTMLElement).getByRole('button', { name: '收起' }))
  expect(disclosure.getAttribute('data-reproductive-history-disclosure')).toBe('collapsed')
  expect(document.activeElement).toBe(within(form).getByRole('button', { name: /展开/ }))

  rerender(<ClinicalDocumentPage {...props} detail={maleDetail} workingDocument={{ ...blankReproductive, menstrualHistory: '补充记录。' }} />)
  expect(disclosure.getAttribute('data-reproductive-history-disclosure')).toBe('expanded')
  expect(within(disclosure as HTMLElement).queryByRole('button', { name: '收起' })).toBeNull()

  const signedBlank = { ...signed(1), content: blankReproductive }
  rerender(<ClinicalDocumentPage {...props} detail={{ ...maleDetail, clinicalDocument: { signed: [signedBlank] } }} workingDocument={blankReproductive} />)
  const revisionForm = screen.getByRole('form', { name: '修订病历版本' })
  expect(within(revisionForm).queryByText(/可留空|默认免填/)).toBeNull()
  expect(within(revisionForm).getByLabelText('修订原因').closest('[data-slot="field"]')!.querySelector('[data-required-indicator]')?.textContent).toBe('*')
  expect(within(revisionForm).getByLabelText('家族史').closest('[data-slot="field"]')!.querySelector('[data-required-indicator]')).toBeNull()
  const revisionDisclosure = revisionForm.querySelector('[data-reproductive-history-disclosure]')!
  expect(revisionDisclosure.getAttribute('data-reproductive-history-disclosure')).toBe('collapsed')
  expect(within(revisionForm).getByLabelText('过敏史').compareDocumentPosition(revisionDisclosure)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  expect(revisionDisclosure.compareDocumentPosition(within(revisionForm).getByLabelText('体格检查'))).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  await user.type(within(revisionForm).getByLabelText('修订原因'), '折叠状态下核对。')
  await user.click(within(revisionForm).getByRole('button', { name: '提交病历修订' }))
  await user.click(within(screen.getByRole('alertdialog', { name: '确认提交病历修订' })).getByRole('button', { name: '确认提交修订' }))
  expect(actions.revise.onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
    document: expect.objectContaining({
      chiefComplaint: blankReproductive.chiefComplaint,
      menstrualHistory: '',
      obstetricHistory: '',
      followUp: blankReproductive.followUp,
    }),
    reason: '折叠状态下核对。',
  }))

  await user.click(within(revisionForm).getByRole('button', { name: /展开/ }))
  expect(within(revisionDisclosure as HTMLElement).getAllByText('月经史')).toHaveLength(1)
  await user.type(within(revisionForm).getByLabelText('孕产史'), '无特殊。')
  expect(within(revisionDisclosure as HTMLElement).queryByRole('button', { name: '收起' })).toBeNull()
  await user.clear(within(revisionForm).getByLabelText('修订原因'))
  await user.type(within(revisionForm).getByLabelText('修订原因'), '补充核对。')
  await user.click(within(revisionForm).getByRole('button', { name: '提交病历修订' }))
  const dialog = screen.getByRole('alertdialog', { name: '确认提交病历修订' })
  await user.click(within(dialog).getByRole('button', { name: '确认提交修订' }))
  expect(actions.revise.onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
    document: expect.objectContaining({ menstrualHistory: '', obstetricHistory: '无特殊。' }),
    reason: '补充核对。',
  }))
})
