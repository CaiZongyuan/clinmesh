// @vitest-environment jsdom
import { encounterCompletionPreviewSchema, type EncounterCompletionItem, type EncounterCompletionPreview } from '@clinmesh/contracts/his'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { EncounterCompletionChecklist, EncounterCompletionProgress, encounterCompletionItemLabel } from './completion-checklist.tsx'

afterEach(cleanup)

const messages = getWorkspaceMessages('zh-CN')

const baseStatuses: Record<EncounterCompletionItem['code'], [EncounterCompletionItem['status'], string]> = {
  'primary-diagnosis-confirmed': ['incomplete', '尚未确认主诊断'],
  'clinical-document-signed': ['incomplete', '尚未签署病历'],
  'required-reports-acknowledged': ['complete', '已查阅必需报告'],
  'medication-conclusion-recorded': ['complete', '已记录用药结论'],
  'no-pending-drafts': ['complete', '无待处理草稿'],
  'disposition-complete': ['complete', '处置方案已完成'],
  'follow-up-complete': ['complete', '随访已安排'],
}

function preview(overrides: Partial<Record<EncounterCompletionItem['code'], EncounterCompletionItem['status']>> = {}): EncounterCompletionPreview {
  return encounterCompletionPreviewSchema.parse({
    canComplete: false, encounterId: 'encounter-progress', encounterVersion: '1',
    items: Object.entries(baseStatuses).map(([code, [status, statusText]]) => ({
      code, statusText, status: overrides[code as EncounterCompletionItem['code']] ?? status,
      target: 'clinical-document',
    })),
  })
}

const checklistExpectations: Record<EncounterCompletionItem['code'], [EncounterCompletionItem['status'], EncounterCompletionItem['target'], string]> = {
  'primary-diagnosis-confirmed': ['incomplete', 'diagnosis', '尚未确认主诊断'],
  'clinical-document-signed': ['incomplete', 'clinical-document', '尚未签署病历'],
  'required-reports-acknowledged': ['complete', 'laboratory', '已查阅必需报告'],
  'medication-conclusion-recorded': ['complete', 'medication-conclusion', '已记录用药结论'],
  'no-pending-drafts': ['complete', 'clinical-document', '无待处理草稿'],
  'disposition-complete': ['incomplete', 'clinical-document', '待填写处置方案'],
  'follow-up-complete': ['complete', 'clinical-document', '随访已安排'],
}

function checklistPreview(overrides: Partial<Record<EncounterCompletionItem['code'], EncounterCompletionItem['status']>> = {}): EncounterCompletionPreview {
  return encounterCompletionPreviewSchema.parse({
    canComplete: false, encounterId: 'encounter-checklist', encounterVersion: '1',
    items: Object.entries(checklistExpectations).map(([code, [status, target, statusText]]) => ({
      code, target, statusText, status: overrides[code as EncounterCompletionItem['code']] ?? status,
    })),
  })
}

it('以计数展示完诊进度并标注未完项数量', () => {
  render(<EncounterCompletionProgress completion={preview()} locale="zh-CN" />)
  expect(screen.getByText('5 / 7')).toBeTruthy()
  expect(screen.getByText(messages.encounterCompletionOutstanding.replace('{count}', '2'))).toBeTruthy()
  expect(screen.getByLabelText(messages.encounterCompletionSatisfied
    .replace('{complete}', '5').replace('{total}', '7'))).toBeTruthy()
})

it('全部完成时只保留计数与完成标记，不再显示未完提示', () => {
  const statuses = Object.fromEntries(Object.keys(baseStatuses).map(code => [code, 'complete'])) as Record<EncounterCompletionItem['code'], EncounterCompletionItem['status']>
  render(<EncounterCompletionProgress completion={preview(statuses)} locale="zh-CN" />)
  expect(screen.getByText('7 / 7')).toBeTruthy()
  expect(screen.queryByText(/未完/)).toBeNull()
})

describe('EncounterCompletionChecklist 完诊检查单', () => {
  it('呈现全部七项：未完项带项名、状态与前往按钮，完成项只做清点且无按钮', () => {
    const onNavigate = vi.fn()
    render(<EncounterCompletionChecklist completion={checklistPreview()} locale="zh-CN" messages={messages} onNavigate={onNavigate} />)
    for (const code of Object.keys(checklistExpectations) as EncounterCompletionItem['code'][]) {
      expect(screen.getByText(encounterCompletionItemLabel(code, 'zh-CN'))).toBeTruthy()
    }
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(3)
    expect(screen.getByRole('button', { name: '前往诊断完成主诊断确认' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '前往病历记录完成门诊病历签署' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '前往病历记录完成处置方案' })).toBeTruthy()
    expect(screen.getByText('已完成 4 / 7 项')).toBeTruthy()
    expect(screen.getByText('必需报告查阅')).toBeTruthy()
    expect(screen.getByText('用药结论记录')).toBeTruthy()
    expect(screen.getByText('随访安排')).toBeTruthy()
  })

  it('点击前往按钮导航到检查项对应页签', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    render(<EncounterCompletionChecklist completion={checklistPreview()} locale="zh-CN" messages={messages} onNavigate={onNavigate} />)
    await user.click(screen.getByRole('button', { name: '前往诊断完成主诊断确认' }))
    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledWith('diagnosis')
    await user.click(screen.getByRole('button', { name: '前往病历记录完成门诊病历签署' }))
    expect(onNavigate).toHaveBeenLastCalledWith('clinical-document')
  })

  it('未提供导航回调时不渲染前往按钮，检查单保持只读呈现', () => {
    render(<EncounterCompletionChecklist completion={checklistPreview()} locale="zh-CN" messages={messages} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByText('主诊断确认')).toBeTruthy()
    expect(screen.getByText('尚未确认主诊断')).toBeTruthy()
  })

  it('全部完成时只呈现完成清点，不列未完项', () => {
    const statuses = Object.fromEntries(
      (Object.keys(checklistExpectations) as EncounterCompletionItem['code'][]).map(code => [code, 'complete']),
    ) as Record<EncounterCompletionItem['code'], EncounterCompletionItem['status']>
    render(<EncounterCompletionChecklist completion={checklistPreview(statuses)} locale="zh-CN" messages={messages} onNavigate={vi.fn()} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByText('已完成 7 / 7 项')).toBeTruthy()
    expect(screen.queryByText('尚未确认主诊断')).toBeNull()
  })

  it('英文区域使用英文项名、分区名与完成清点', () => {
    const en = getWorkspaceMessages('en-US')
    render(<EncounterCompletionChecklist completion={checklistPreview()} locale={'en-US' as WorkspaceLocale} messages={en} onNavigate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Go to Diagnosis to complete: Primary diagnosis' })).toBeTruthy()
    expect(screen.getByText('4 / 7 complete')).toBeTruthy()
    expect(screen.getByText('Reports reviewed')).toBeTruthy()
  })
})
