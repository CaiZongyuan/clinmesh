// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { ConsultationPage } from './consultation-page.tsx'

afterEach(cleanup)

it('sends the consultation input only to the patient and clears the submitted question', async () => {
  const onAsk = vi.fn()
  render(<ConsultationPage action={{ error: null, pending: false, onAsk, onRetry: vi.fn() }}
    consultation={{ turns: [], version: 1 }} locale="zh-CN" messages={getWorkspaceMessages('zh-CN')}
    patientName="合成患者" readOnly={false} />)
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox', { name: '向患者提问' }), '最近两周服用了哪些药物？')
  expect(screen.queryByRole('button', { name: '交给助手代问' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '向患者提问' }))
  expect(onAsk).toHaveBeenCalledWith('最近两周服用了哪些药物？')
  expect(screen.getByRole('textbox', { name: '向患者提问' })).toHaveProperty('value', '')
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps recording failures quiet while offering one explanation and retry on demand', async () => {
  const onSubmit = vi.fn()
  render(<ConsultationPage action={{ error: null, pending: false, onAsk: vi.fn(), onRetry: vi.fn() }}
    consultation={{ turns: [], version: 1 }} locale="zh-CN" messages={getWorkspaceMessages('zh-CN')}
    patientName="合成患者" readOnly={false}
    recording={{ hasSavedDraft: false, version: 1, paused: false, status: 'failed', processedCount: 1,
      remainingCount: 3, failedCount: 3, additions: [], failures: [
        { sourceTurnId: 'synthetic-1', code: 'AI_TIMEOUT', retrying: false },
        { sourceTurnId: 'synthetic-2', code: 'AI_TIMEOUT', retrying: false },
        { sourceTurnId: 'synthetic-3', code: 'CONSULTATION_RECORDING_SOURCE_INVALID', retrying: false },
      ] }} recordingAction={{ error: null, pending: false, onSubmit }} />)
  expect(screen.queryByText(/整理失败|自动记录超时|未通过校验/)).toBeNull()
  expect(screen.getByRole('button', { name: '问诊自动记录' }).textContent).toBe('问诊自动记录')
  const user = userEvent.setup()
  screen.getByRole('button', { name: '问诊自动记录' }).focus()
  await user.keyboard('{ArrowDown}')
  expect(screen.getAllByText('部分内容尚未写入病历，问诊原文已保存。可重试或直接编辑病历。')).toHaveLength(1)
  expect(screen.queryByText(/整理失败|自动记录超时|未通过校验/)).toBeNull()
  await user.keyboard('{Escape}')
  await user.click(screen.getByRole('button', { name: '重试病史整理' }))
  expect(onSubmit).toHaveBeenCalledWith('retry')
})
