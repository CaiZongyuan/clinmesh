// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { personaJobFailure, PersonaJobStatusNotice } from './persona-job-failure.tsx'

afterEach(() => { cleanup() })

describe('personaJobFailure', () => {
  it('maps AI provider failures to a localized summary with retry guidance', () => {
    const failure = personaJobFailure(
      { code: 'AI_RESPONSE_INVALID', message: 'The AI provider returned an invalid response' },
      'zh-CN',
    )
    expect(failure.summary).toBe('AI 模型返回了无效响应')
    expect(failure.guidance).toContain('重试')
    expect(failure.guidance).toContain('更换模型')
  })

  it('describes diagnosis leaks and validation failures by code', () => {
    expect(personaJobFailure({ code: 'PERSONA_DIAGNOSIS_LEAK', message: 'leak' }, 'zh-CN').summary)
      .toContain('隐藏诊断')
    expect(personaJobFailure({ code: 'PERSONA_RESPONSE_INVALID', message: 'invalid' }, 'zh-CN').summary)
      .toContain('校验')
  })

  it('falls back to the raw message and generic guidance for unknown codes', () => {
    const failure = personaJobFailure({ code: 'SOMETHING_ELSE', message: 'Raw provider complaint' }, 'zh-CN')
    expect(failure.summary).toBe('Raw provider complaint')
    expect(failure.guidance).toContain('重试')
  })

  it('localizes summaries to en-US', () => {
    const failure = personaJobFailure(
      { code: 'AI_RESPONSE_INVALID', message: 'The AI provider returned an invalid response' },
      'en-US',
    )
    expect(failure.summary).toBe('The AI model returned an invalid response')
  })
})

describe('PersonaJobStatusNotice', () => {
  it('shows a localized failure reason and opens a detail dialog from it', async () => {
    const user = userEvent.setup()
    render(
      <PersonaJobStatusNotice
        error={{ code: 'AI_RESPONSE_INVALID', message: 'The AI provider returned an invalid response' }}
        finishedAt="2026-09-20T07:23:32.782Z"
        label="患者档案生成失败"
        locale="zh-CN"
        status="failed"
      />,
    )
    expect(screen.getByText('AI 模型返回了无效响应')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '查看失败详情' }))
    expect(await screen.findByText('AI_RESPONSE_INVALID')).toBeTruthy()
    expect(screen.getByText('The AI provider returned an invalid response')).toBeTruthy()
    expect(screen.getByText('2026-09-20T07:23:32.782Z')).toBeTruthy()
  })

  it('keeps the plain status notice without a detail entry when the job succeeds', () => {
    render(
      <PersonaJobStatusNotice
        error={null}
        finishedAt={null}
        label="患者档案已完成"
        locale="zh-CN"
        status="succeeded"
      />,
    )
    expect(screen.queryByRole('button', { name: '查看失败详情' })).toBeNull()
  })

  it('omits the detail entry when a failed job carries no error payload', () => {
    render(
      <PersonaJobStatusNotice
        error={undefined}
        finishedAt={null}
        label="患者档案生成失败"
        locale="zh-CN"
        status="failed"
      />,
    )
    expect(screen.queryByRole('button', { name: '查看失败详情' })).toBeNull()
  })
})
