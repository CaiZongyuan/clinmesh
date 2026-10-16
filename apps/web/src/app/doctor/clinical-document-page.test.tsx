// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ClinicalDocumentContent, DoctorCaseDetail } from '@clinmesh/contracts/his'
import { afterEach, expect, it, vi } from 'vitest'
import { ClinicalDocumentPage, type ClinicalDocumentPageActions } from './clinical-document-page.tsx'
import { getWorkspaceMessages } from '../workspace-i18n.ts'

afterEach(cleanup)
const content: ClinicalDocumentContent = {
  chiefComplaint: '头晕一周。', historyOfPresentIllness: '起立时明显。', priorMedicalHistory: '既往高血压。',
  familyHistory: '父亲患高血压。', allergyHistory: '无已知过敏。', physicalExamination: '查体正常。',
  auxiliaryExamination: '暂无检查。', assessment: '初步评估。', disposition: '门诊随访。', followUp: '加重及时就诊。',
}
const signed = (revisionNumber: number) => ({
  bundleId: `bundle-${revisionNumber}`, compositionId: `composition-${revisionNumber}`, compositionVersion: '1',
  content: { ...content, assessment: `第 ${revisionNumber} 版评估。` }, documentId: `document-${revisionNumber}`,
  provenanceId: `provenance-${revisionNumber}`, revisionNumber, signedAt: '2026-10-16T09:00:00+08:00',
  ...(revisionNumber > 1 ? { revisionReason: `第 ${revisionNumber} 次核对。` } : {}),
})
const detail: DoctorCaseDetail = {
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
    expect.stringContaining('版本 3'), expect.stringContaining('版本 2'), expect.stringContaining('版本 1'),
  ])
  expect(within(entries[0]!).getByText('最新版本')).toBeTruthy()
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
  await userEvent.click(screen.getByText('版本 1'))
  rerender(<ClinicalDocumentPage {...props} detail={{ ...detail, clinicalDocument: { signed: [signed(1), signed(2), signed(3), signed(4)] } }} />)
  const history = screen.getByRole('region', { name: '签署历史' })
  expect(history.querySelector('details')!.open).toBe(false)
  expect(screen.getByText('版本 1').closest('details')!.open).toBe(true)
  expect(screen.getByRole('form', { name: '修订病历版本' }).querySelector('[name="assessment"]')).toHaveProperty('value', '第 4 版评估。')
  rerender(<ClinicalDocumentPage {...props} detail={{ ...detail, caseId: 'another-case' }} />)
  expect([...screen.getByRole('region', { name: '签署历史' }).querySelectorAll('details')].every(entry => !entry.open)).toBe(true)
})

it('allows read-only history review and keeps unsigned drafts free of empty history', async () => {
  const { props } = setup()
  const { rerender } = render(<ClinicalDocumentPage {...props} allowRevision={false} />)
  expect(screen.queryByRole('form')).toBeNull()
  await userEvent.click(screen.getByText('版本 1'))
  expect(screen.getByText('版本 1').closest('details')!.open).toBe(true)
  rerender(<ClinicalDocumentPage {...props} detail={{ ...detail, clinicalDocument: { signed: [] } }} />)
  expect(screen.queryByRole('region', { name: '签署历史' })).toBeNull()
  expect(screen.getByRole('form', { name: '结构化病历' })).toBeTruthy()
})
