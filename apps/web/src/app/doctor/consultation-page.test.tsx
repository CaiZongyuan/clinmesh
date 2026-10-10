// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { ConsultationPage } from './consultation-page.tsx'

afterEach(cleanup)

it('directly submits the doctor follow-up scope without sending it as a patient question', async () => {
  const onAsk = vi.fn()
  const onDelegate = vi.fn()
  render(<ConsultationPage action={{ error: null, pending: false, onAsk, onRetry: vi.fn(), onDelegate }}
    consultation={{ turns: [], version: 1 }} locale="zh-CN" messages={getWorkspaceMessages('zh-CN')}
    patientName="合成患者" readOnly={false} />)
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox', { name: '向患者提问' }), '了解近两周用药情况')
  await user.click(screen.getByRole('button', { name: '交给助手代问' }))
  expect(onDelegate).toHaveBeenCalledWith('了解近两周用药情况')
  expect(onAsk).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps the follow-up scope available after submission fails', async () => {
  const onDelegate = vi.fn(async () => { throw new Error('任务尚未提交') })
  render(<ConsultationPage action={{ error: null, pending: false, onAsk: vi.fn(), onRetry: vi.fn(), onDelegate }}
    consultation={{ turns: [], version: 1 }} locale="zh-CN" messages={getWorkspaceMessages('zh-CN')}
    patientName="合成患者" readOnly={false} />)
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox', { name: '向患者提问' }), '了解近两周用药情况')
  await user.click(screen.getByRole('button', { name: '交给助手代问' }))
  expect((screen.getByRole('textbox', { name: '向患者提问' }) as HTMLTextAreaElement).value).toBe('了解近两周用药情况')
  expect(onDelegate).toHaveBeenCalledOnce()
})
