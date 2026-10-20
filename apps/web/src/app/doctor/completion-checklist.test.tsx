// @vitest-environment jsdom
import { encounterCompletionPreviewSchema, type EncounterCompletionItem, type EncounterCompletionPreview } from '@clinmesh/contracts/his'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { EncounterCompletionProgress } from './completion-checklist.tsx'

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
