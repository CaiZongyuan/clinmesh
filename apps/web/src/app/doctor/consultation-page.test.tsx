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
