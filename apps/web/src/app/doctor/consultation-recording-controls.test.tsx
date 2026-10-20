// @vitest-environment jsdom
import type { DoctorCaseDetail } from '@clinmesh/contracts/his'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { ConsultationRecordingControls } from './consultation-recording-controls.tsx'

afterEach(cleanup)

const recording: NonNullable<DoctorCaseDetail['consultationRecording']> = {
  hasSavedDraft: true, version: 1, status: 'updated', paused: false,
  processedCount: 1, remainingCount: 0, failedCount: 0, additions: [], failures: [],
  verification: { pendingCount: 3, flaggedCount: 2, failedCount: 1, issues: [{
    additionId: 'legacy-addition', field: 'historyOfPresentIllness', text: '历史核对疑点。',
    sourceIds: ['legacy-source'], reason: 'verification-rejected',
  }] },
}

it.each([
  { status: 'updated', paused: false, label: '暂停自动整理', command: 'pause' },
  { status: 'paused', paused: true, label: '恢复并补录', command: 'resume' },
  { status: 'backfill', paused: false, label: '补录历史回答', command: 'backfill' },
] as const)('ignores retired verification failures and keeps $command available', async ({ status, paused, label, command }) => {
  const onSubmit = vi.fn()
  render(<ConsultationRecordingControls recording={{ ...recording, status, paused }}
    action={{ error: null, pending: false, onSubmit }} disabled={false} messages={getWorkspaceMessages('zh-CN')} />)
  expect(screen.queryByRole('button', { name: '重试病史整理' })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: label }))
  expect(onSubmit).toHaveBeenCalledWith(command)
})

it('keeps retry for a real recording failure and freezes its actions during signing', async () => {
  const onSubmit = vi.fn()
  const props = { recording: { ...recording, status: 'failed' as const, failedCount: 1 },
    action: { error: null, pending: false, onSubmit }, messages: getWorkspaceMessages('zh-CN') }
  const { rerender } = render(<ConsultationRecordingControls {...props} disabled={false} />)
  await userEvent.click(screen.getByRole('button', { name: '重试病史整理' }))
  expect(onSubmit).toHaveBeenCalledWith('retry')
  onSubmit.mockClear()
  rerender(<ConsultationRecordingControls {...props} disabled />)
  await userEvent.click(screen.getByRole('button', { name: '重试病史整理' }))
  await userEvent.click(screen.getByRole('button', { name: '暂停自动整理' }))
  expect(onSubmit).not.toHaveBeenCalled()
})
