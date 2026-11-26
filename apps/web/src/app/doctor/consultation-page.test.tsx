// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import {
  WebRuntimeProvider,
  type WebRuntimeValue,
  type WebSurfaceVoiceInput,
  type WebSurfaceVoiceShortcutContext,
  type WebSurfaceVoiceSnapshot,
  type WebSurfaceVoiceTarget,
} from '../web-runtime.tsx'
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

interface MockVoicePatch {
  installed?: boolean
  ready?: boolean
  phase?: WebSurfaceVoiceSnapshot['phase']
  unavailableReason?: string | undefined
  error?: string | undefined
  shortcutEnabled?: boolean
  shortcut?: string
}

function createMockVoiceInput(initial: MockVoicePatch = {}) {
  let snapshot: WebSurfaceVoiceSnapshot = {
    installed: initial.installed ?? true,
    ready: initial.ready ?? true,
    phase: initial.phase ?? 'idle',
    shortcutEnabled: initial.shortcutEnabled ?? true,
    shortcut: initial.shortcut ?? 'ctrl+shift+space',
    ...(initial.unavailableReason === undefined ? {} : { unavailableReason: initial.unavailableReason }),
    ...(initial.error === undefined ? {} : { error: initial.error }),
  }
  const listeners = new Set<() => void>()
  let activeTarget: WebSurfaceVoiceTarget | undefined
  let shortcutHandler: WebSurfaceVoiceShortcutContext | undefined

  const setSnapshot = (patch: MockVoicePatch) => {
    const unavailableReason = 'unavailableReason' in patch ? patch.unavailableReason : snapshot.unavailableReason
    const error = 'error' in patch ? patch.error : snapshot.error
    snapshot = {
      installed: patch.installed ?? snapshot.installed,
      ready: patch.ready ?? snapshot.ready,
      phase: patch.phase ?? snapshot.phase,
      shortcutEnabled: patch.shortcutEnabled ?? snapshot.shortcutEnabled,
      shortcut: patch.shortcut ?? snapshot.shortcut,
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
      ...(error === undefined ? {} : { error }),
    }
    for (const listener of listeners) listener()
  }

  const voiceInput: WebSurfaceVoiceInput = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    start: vi.fn(target => {
      activeTarget = target
      setSnapshot({ phase: 'recording', error: undefined })
    }),
    stop: vi.fn(() => {
      setSnapshot({ phase: 'idle' })
    }),
    cancel: vi.fn(() => {
      activeTarget = undefined
      setSnapshot({ phase: 'idle', error: undefined })
    }),
    clearError: vi.fn(() => {
      setSnapshot({ phase: 'idle', error: undefined })
    }),
    refresh: vi.fn(),
    registerShortcutHandler: vi.fn(handler => {
      shortcutHandler = handler
      return () => {
        if (shortcutHandler === handler) shortcutHandler = undefined
      }
    }),
  }

  return {
    voiceInput,
    setSnapshot,
    getActiveTarget: () => activeTarget,
    getShortcutHandler: () => shortcutHandler,
  }
}

describe('consultation voice input integration', () => {
  it('hides voice control when surfaceVoiceInput is absent or not installed', () => {
    const { rerender } = render(
      <ConsultationPage
        action={{ error: null, pending: false, onAsk: vi.fn(), onRetry: vi.fn() }}
        consultation={{ turns: [], version: 1 }}
        locale="zh-CN"
        messages={getWorkspaceMessages('zh-CN')}
        patientName="合成患者"
        readOnly={false}
      />,
    )
    expect(screen.queryByRole('button', { name: '语音输入' })).toBeNull()

    const mock = createMockVoiceInput({ installed: false, ready: false })
    rerender(
      <WebRuntimeProvider value={{ mode: 'surface', appearanceRoot: { current: null }, surfaceVoiceInput: mock.voiceInput }}>
        <ConsultationPage
          action={{ error: null, pending: false, onAsk: vi.fn(), onRetry: vi.fn() }}
          consultation={{ turns: [], version: 1 }}
          locale="zh-CN"
          messages={getWorkspaceMessages('zh-CN')}
          patientName="合成患者"
          readOnly={false}
        />
      </WebRuntimeProvider>,
    )
    expect(screen.queryByRole('button', { name: '语音输入' })).toBeNull()
  })

  it('shows unavailable reason when installed but not ready, and never auto-sends voice transcripts', async () => {
    const onAsk = vi.fn()
    const mock = createMockVoiceInput({
      installed: true,
      ready: false,
      unavailableReason: '请先在 DSH 设置 → dsh-ears 下载 Whisper 模型',
    })
    const { rerender } = render(
      <WebRuntimeProvider value={{ mode: 'surface', appearanceRoot: { current: null }, surfaceVoiceInput: mock.voiceInput }}>
        <ConsultationPage
          action={{ error: null, pending: false, onAsk, onRetry: vi.fn() }}
          consultation={{ turns: [], version: 1 }}
          locale="zh-CN"
          messages={getWorkspaceMessages('zh-CN')}
          patientName="合成患者"
          readOnly={false}
        />
      </WebRuntimeProvider>,
    )
    const unavailableButton = screen.getByRole('button', { name: '请先在 DSH 设置 → dsh-ears 下载 Whisper 模型' })
    expect(unavailableButton).toHaveProperty('disabled', true)

    mock.setSnapshot({ ready: true, unavailableReason: undefined })
    rerender(
      <WebRuntimeProvider value={{ mode: 'surface', appearanceRoot: { current: null }, surfaceVoiceInput: mock.voiceInput }}>
        <ConsultationPage
          action={{ error: null, pending: false, onAsk, onRetry: vi.fn() }}
          consultation={{ turns: [], version: 1 }}
          locale="zh-CN"
          messages={getWorkspaceMessages('zh-CN')}
          patientName="合成患者"
          readOnly={false}
        />
      </WebRuntimeProvider>,
    )

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '语音输入' }))
    expect(mock.voiceInput.start).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '停止语音输入' }).getAttribute('data-voice-state')).toBe('recording')
    expect(screen.getByRole('status').textContent).toBe('正在录音…')
    expect(screen.getByRole('button', { name: '取消语音输入' })).toBeDefined()

    // Simulated voice transcript fills draft ONLY and never calls onAsk automatically
    act(() => {
      mock.getActiveTarget()?.setDraft('请问疼痛是否向肩背部放射？')
    })
    await user.click(screen.getByRole('button', { name: '停止语音输入' }))
    expect(mock.voiceInput.stop).toHaveBeenCalledOnce()
    expect(onAsk).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: '向患者提问' })).toHaveProperty('value', '请问疼痛是否向肩背部放射？')

    // User manually sends after reviewing
    await user.click(screen.getByRole('button', { name: '向患者提问' }))
    expect(onAsk).toHaveBeenCalledWith('请问疼痛是否向肩背部放射？')
  })

  it('shows voice errors and cancels active capture when submitting, hiding surface, becoming readOnly or unmounting', async () => {
    const onAsk = vi.fn()
    const mock = createMockVoiceInput()
    const makeRuntime = (surfaceActive = true): WebRuntimeValue => ({
      mode: 'surface',
      appearanceRoot: { current: null },
      surfaceActive,
      surfaceVoiceInput: mock.voiceInput,
    })

    const { rerender, unmount } = render(
      <WebRuntimeProvider value={makeRuntime()}>
        <ConsultationPage
          action={{ error: null, pending: false, onAsk, onRetry: vi.fn() }}
          consultation={{ turns: [], version: 1 }}
          locale="zh-CN"
          messages={getWorkspaceMessages('zh-CN')}
          patientName="合成患者"
          readOnly={false}
        />
      </WebRuntimeProvider>,
    )

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '语音输入' }))
    act(() => {
      mock.setSnapshot({ phase: 'error', error: '润色失败，已保留原始转写文本' })
    })
    expect(screen.getByRole('alert').textContent).toBe('润色失败，已保留原始转写文本')
    fireEvent.change(screen.getByRole('textbox', { name: '向患者提问' }), { target: { value: '手工修改' } })
    expect(mock.voiceInput.clearError).toHaveBeenCalledOnce()

    // Start recording then hide Surface -> cancels voice
    await user.click(screen.getByRole('button', { name: '语音输入' }))
    rerender(
      <WebRuntimeProvider value={makeRuntime(false)}>
        <ConsultationPage
          action={{ error: null, pending: false, onAsk, onRetry: vi.fn() }}
          consultation={{ turns: [], version: 1 }}
          locale="zh-CN"
          messages={getWorkspaceMessages('zh-CN')}
          patientName="合成患者"
          readOnly={false}
        />
      </WebRuntimeProvider>,
    )
    expect(mock.voiceInput.cancel).toHaveBeenCalledTimes(1)

    // Restore active, start recording, then click Cancel button -> cancels voice
    rerender(
      <WebRuntimeProvider value={makeRuntime(true)}>
        <ConsultationPage
          action={{ error: null, pending: false, onAsk, onRetry: vi.fn() }}
          consultation={{ turns: [], version: 1 }}
          locale="zh-CN"
          messages={getWorkspaceMessages('zh-CN')}
          patientName="合成患者"
          readOnly={false}
        />
      </WebRuntimeProvider>,
    )
    expect(mock.voiceInput.refresh).toHaveBeenCalledTimes(2)
    await user.click(screen.getByRole('button', { name: '语音输入' }))
    await user.click(screen.getByRole('button', { name: '取消语音输入' }))
    expect(mock.voiceInput.cancel).toHaveBeenCalledTimes(2)

    // Start recording, fill draft, then submit -> cancels voice before calling onAsk
    await user.click(screen.getByRole('button', { name: '语音输入' }))
    act(() => {
      mock.getActiveTarget()?.setDraft('提交前正在录音的提问')
    })
    await user.click(screen.getByRole('button', { name: '向患者提问' }))
    expect(mock.voiceInput.cancel).toHaveBeenCalledTimes(3)
    expect(onAsk).toHaveBeenCalledWith('提交前正在录音的提问')

    // Start recording, then switch to readOnly -> cancels voice
    await user.click(screen.getByRole('button', { name: '语音输入' }))
    rerender(
      <WebRuntimeProvider value={makeRuntime(true)}>
        <ConsultationPage
          action={{ error: null, pending: false, onAsk, onRetry: vi.fn() }}
          consultation={{ turns: [], version: 1 }}
          locale="zh-CN"
          messages={getWorkspaceMessages('zh-CN')}
          patientName="合成患者"
          readOnly={true}
        />
      </WebRuntimeProvider>,
    )
    expect(mock.voiceInput.cancel).toHaveBeenCalledTimes(4)

    // Restore editable, start recording, then action.pending=true -> cancels voice
    rerender(
      <WebRuntimeProvider value={makeRuntime(true)}>
        <ConsultationPage
          action={{ error: null, pending: false, onAsk, onRetry: vi.fn() }}
          consultation={{ turns: [], version: 1 }}
          locale="zh-CN"
          messages={getWorkspaceMessages('zh-CN')}
          patientName="合成患者"
          readOnly={false}
        />
      </WebRuntimeProvider>,
    )
    await user.click(screen.getByRole('button', { name: '语音输入' }))
    rerender(
      <WebRuntimeProvider value={makeRuntime(true)}>
        <ConsultationPage
          action={{ error: null, pending: true, onAsk, onRetry: vi.fn() }}
          consultation={{ turns: [], version: 1 }}
          locale="zh-CN"
          messages={getWorkspaceMessages('zh-CN')}
          patientName="合成患者"
          readOnly={false}
        />
      </WebRuntimeProvider>,
    )
    expect(mock.voiceInput.cancel).toHaveBeenCalledTimes(5)

    // Restore idle, start recording, then unanswered doctor turn arrives -> cancels voice
    rerender(
      <WebRuntimeProvider value={makeRuntime(true)}>
        <ConsultationPage
          action={{ error: null, pending: false, onAsk, onRetry: vi.fn() }}
          consultation={{ turns: [], version: 1 }}
          locale="zh-CN"
          messages={getWorkspaceMessages('zh-CN')}
          patientName="合成患者"
          readOnly={false}
        />
      </WebRuntimeProvider>,
    )
    await user.click(screen.getByRole('button', { name: '语音输入' }))
    rerender(
      <WebRuntimeProvider value={makeRuntime(true)}>
        <ConsultationPage
          action={{ error: null, pending: false, onAsk, onRetry: vi.fn() }}
          consultation={{
            turns: [{
              actorId: 'synthetic-doctor',
              practitionerId: 'synthetic-practitioner',
              id: 'synthetic-doctor-turn-1',
              kind: 'text',
              speaker: 'doctor',
              source: 'doctor-typed',
              messageText: '等待回复的问题',
              sequence: 1,
              personaRevision: null,
              reportReference: null,
              recordedAt: '2026-10-20T00:00:00.000Z',
            }],
            version: 2,
          }}
          locale="zh-CN"
          messages={getWorkspaceMessages('zh-CN')}
          patientName="合成患者"
          readOnly={false}
        />
      </WebRuntimeProvider>,
    )
    expect(mock.voiceInput.cancel).toHaveBeenCalledTimes(6)

    // Restore answered state, start recording, then unmount -> cancels voice
    rerender(
      <WebRuntimeProvider value={makeRuntime(true)}>
        <ConsultationPage
          action={{ error: null, pending: false, onAsk, onRetry: vi.fn() }}
          consultation={{ turns: [], version: 3 }}
          locale="zh-CN"
          messages={getWorkspaceMessages('zh-CN')}
          patientName="合成患者"
          readOnly={false}
        />
      </WebRuntimeProvider>,
    )
    await user.click(screen.getByRole('button', { name: '语音输入' }))
    unmount()
    expect(mock.voiceInput.cancel).toHaveBeenCalledTimes(7)
  })

  it('claims voice shortcuts when focused, fullscreen, or conversation collapsed, and yields in unfocused split-screen', () => {
    const mock = createMockVoiceInput()
    const event = new KeyboardEvent('keydown', { code: 'Space', ctrlKey: true, shiftKey: true })
    const makeRuntime = (display: { fullscreen: boolean; collapsed: boolean; active?: boolean }): WebRuntimeValue => ({
      mode: 'surface',
      appearanceRoot: { current: null },
      surfaceActive: display.active ?? true,
      surfaceDisplay: {
        fullscreen: display.fullscreen,
        toggle: () => {},
        conversation: { collapsed: display.collapsed, toggle: () => {} },
      },
      surfaceVoiceInput: mock.voiceInput,
    })

    const { rerender } = render(
      <WebRuntimeProvider value={makeRuntime({ fullscreen: false, collapsed: false })}>
        <ConsultationPage
          action={{ error: null, pending: false, onAsk: vi.fn(), onRetry: vi.fn() }}
          consultation={{ turns: [], version: 1 }}
          locale="zh-CN"
          messages={getWorkspaceMessages('zh-CN')}
          patientName="合成患者"
          readOnly={false}
        />
      </WebRuntimeProvider>,
    )

    const textarea = screen.getByRole('textbox', { name: '向患者提问' })
    const handler = mock.getShortcutHandler()
    expect(handler).toBeDefined()

    // Unfocused in split-screen: yield to right conversation dsh-ears
    expect(handler!.shouldHandle(event)).toBe(false)

    // Focused in split-screen: claim shortcut
    textarea.focus()
    expect(handler!.shouldHandle(event)).toBe(true)
    textarea.blur()
    expect(handler!.shouldHandle(event)).toBe(false)

    // Fullscreen: claim shortcut even when textarea unfocused
    rerender(
      <WebRuntimeProvider value={makeRuntime({ fullscreen: true, collapsed: false })}>
        <ConsultationPage
          action={{ error: null, pending: false, onAsk: vi.fn(), onRetry: vi.fn() }}
          consultation={{ turns: [], version: 1 }}
          locale="zh-CN"
          messages={getWorkspaceMessages('zh-CN')}
          patientName="合成患者"
          readOnly={false}
        />
      </WebRuntimeProvider>,
    )
    expect(handler!.shouldHandle(event)).toBe(true)

    // Collapsed right conversation: claim shortcut even when textarea unfocused
    rerender(
      <WebRuntimeProvider value={makeRuntime({ fullscreen: false, collapsed: true })}>
        <ConsultationPage
          action={{ error: null, pending: false, onAsk: vi.fn(), onRetry: vi.fn() }}
          consultation={{ turns: [], version: 1 }}
          locale="zh-CN"
          messages={getWorkspaceMessages('zh-CN')}
          patientName="合成患者"
          readOnly={false}
        />
      </WebRuntimeProvider>,
    )
    expect(handler!.shouldHandle(event)).toBe(true)

    // Inactive Surface: never intercept
    rerender(
      <WebRuntimeProvider value={makeRuntime({ fullscreen: true, collapsed: true, active: false })}>
        <ConsultationPage
          action={{ error: null, pending: false, onAsk: vi.fn(), onRetry: vi.fn() }}
          consultation={{ turns: [], version: 1 }}
          locale="zh-CN"
          messages={getWorkspaceMessages('zh-CN')}
          patientName="合成患者"
          readOnly={false}
        />
      </WebRuntimeProvider>,
    )
    expect(handler!.shouldHandle(event)).toBe(false)
  })
})
