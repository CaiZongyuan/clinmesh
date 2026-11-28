// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { ConsultationPage } from './consultation-page.tsx'

afterEach(cleanup)

it.each(['executing', 'blocked', 'failed', 'unknown'] as const)('shows a persisted %s patient reply after returning to the page', status => {
  render(<ConsultationPage action={{ error: null, pending: false, onAsk: vi.fn(), onRetry: vi.fn() }}
    consultation={{ turns: [{
      actorId: 'synthetic-doctor', practitionerId: 'synthetic-practitioner', id: 'synthetic-doctor-turn',
      kind: 'text', speaker: 'doctor', source: 'doctor-typed', messageText: '什么时候晕？', sequence: 2,
      personaRevision: null, reportReference: null, recordedAt: '2026-10-20T00:00:00.000Z',
    }], version: 3, replyAttempt: {
      doctorTurnId: 'synthetic-doctor-turn', status,
      startedAt: '2026-10-20T00:00:00.000Z', deadlineAt: '2026-10-20T00:00:30.000Z',
      ...(status === 'executing' ? {} : { errorCode: status === 'blocked' ? 'MODEL_CONTROL_BLOCKED' : status === 'unknown' ? 'CONSULTATION_REPLY_UNKNOWN' : 'AI_AUTH_FAILED' }),
    } }} locale="zh-CN" messages={getWorkspaceMessages('zh-CN')} patientName="合成患者" readOnly={false} />)
  if (status === 'executing') {
    expect(screen.getByRole('status').textContent).toBe('患者正在输入…')
    expect(screen.getByRole('button', { name: '等待当前回答' })).toBeDefined()
    expect(screen.getByText('患者回答仍在生成，等待将复用本次回答。')).toBeDefined()
  } else if (status === 'blocked') {
    expect(screen.getByRole('button', { name: '等待模型控制恢复' })).toHaveProperty('disabled', true)
    expect(screen.getByText('医生问题已保存，模型控制恢复且本次回答期限仍有效时将自动接续。')).toBeDefined()
  } else {
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: '重试患者回答' })).toBeDefined()
    expect(screen.getByText(status === 'unknown'
      ? '上次回答结果未知，未自动补答。明确重试将使用当前 ClinMesh 模型设置。'
      : '患者回答失败。重试将使用当前 ClinMesh 模型设置。')).toBeDefined()
  }
})

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
