// @vitest-environment jsdom
import type { DoctorCaseDetail } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantComposer } from '../assistant/assistant-composer.tsx'
import { ConsultationPage } from '../doctor/consultation-page.tsx'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { downsampleToPcm16 } from './audio-capture-engine.ts'
import { splitIntoSpeechChunks } from './voice-api.ts'
import { VoiceSettingsCard } from './voice-settings-card.tsx'
import { DEFAULT_VOICE_SETTINGS, readVoiceSettings, writeVoiceSettings } from './voice-settings-storage.ts'

class MockSpeechRecognition {
  static latest: MockSpeechRecognition | null = null
  lang = 'zh-CN'
  continuous = false
  interimResults = false
  onstart: (() => void) | null = null
  onresult: ((event: { resultIndex: number; results: Array<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  started = false
  aborted = false

  constructor() {
    MockSpeechRecognition.latest = this
  }

  start() {
    this.started = true
    this.onstart?.()
  }

  stop() {
    this.onend?.()
  }

  abort() {
    this.aborted = true
  }

  emitResult(transcript: string, isFinal: boolean) {
    this.onresult?.({
      resultIndex: 0,
      results: [{ isFinal, 0: { transcript } }],
    })
  }
}

class MockSpeechSynthesisUtterance {
  text: string
  lang = 'zh-CN'
  rate = 1
  onend: (() => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  constructor(text: string) {
    this.text = text
  }
}

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>,
  )
}

function buildConsultation(
  turns: NonNullable<DoctorCaseDetail['consultation']>['turns'],
): NonNullable<DoctorCaseDetail['consultation']> {
  return {
    turns,
    version: 1,
  }
}

function buildPatientTurn(
  id: string,
  sequence: number,
  messageText: string,
  recordedAt: string,
): NonNullable<DoctorCaseDetail['consultation']>['turns'][number] {
  return {
    id,
    kind: 'text',
    speaker: 'patient',
    messageText,
    recordedAt,
    actorId: null,
    practitionerId: null,
    personaRevision: 1,
    reportReference: null,
    sequence,
    source: 'patient-agent',
  }
}

const spokenUtterances: MockSpeechSynthesisUtterance[] = []
const cancelSpeechMock = vi.fn()

beforeEach(() => {
  MockSpeechRecognition.latest = null
  spokenUtterances.length = 0
  cancelSpeechMock.mockReset()
  writeVoiceSettings(DEFAULT_VOICE_SETTINGS)

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/api/voice/config')) {
      return new Response(JSON.stringify({
        sttProvider: 'web-speech',
        ttsProvider: 'web-speech',
        bailianConfigured: false,
        serverTokenConfigured: false,
        defaultVoice: 'sambert-zhida-v1',
        sampleRate: 16_000,
        voices: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }), { status: 404 })
  }))

  Object.defineProperty(window, 'SpeechRecognition', {
    configurable: true,
    writable: true,
    value: MockSpeechRecognition,
  })
  Object.defineProperty(window, 'SpeechSynthesisUtterance', {
    configurable: true,
    writable: true,
    value: MockSpeechSynthesisUtterance,
  })
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    writable: true,
    value: {
      speak: (utterance: MockSpeechSynthesisUtterance) => {
        spokenUtterances.push(utterance)
      },
      cancel: cancelSpeechMock,
    },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Voice audio utilities', () => {
  it('downsamples 48kHz Float32 audio into 16kHz Int16 PCM with bounded RMS', () => {
    const input = new Float32Array(480)
    for (let i = 0; i < input.length; i += 1) {
      input[i] = Math.sin((2 * Math.PI * 440 * i) / 48_000) * 0.5
    }
    const { pcm, rms } = downsampleToPcm16(input, 48_000, 16_000)
    expect(pcm.length).toBe(160)
    expect(rms).toBeGreaterThan(0.1)
    expect(rms).toBeLessThanOrEqual(1)
  })

  it('splits long clinical text into natural sentence chunks', () => {
    const longText = '患者主诉反复胸闷三天。活动后加重，休息五分钟可缓解。既往有高血压病史五年，规律服药。'
    const chunks = splitIntoSpeechChunks(longText, 24)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(longText)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40)
    }
  })
})

describe('ConsultationPage voice bar & patient TTS playback', () => {
  it('does not auto-play history on mount, auto-plays newly arrived patient turn, and supports barge-in & replay', () => {
    const messages = getWorkspaceMessages('zh-CN')
    const onAsk = vi.fn()
    const initialTurn = buildPatientTurn(
      'turn-1',
      1,
      '历史记录：三天前开始咳嗽。',
      '2026-11-28T08:00:00Z',
    )

    const { rerender, container } = renderWithQuery(
      <ConsultationPage
        action={{ error: null, onAsk, onRetry: vi.fn(), pending: false }}
        caseId="case-voice-1"
        consultation={buildConsultation([initialTurn])}
        locale="zh-CN"
        messages={messages}
        patientBirthDate="1985-03-15"
        patientGender="female"
        patientName="林女士"
        readOnly={false}
      />,
    )

    // Accessible toolbar structure
    const toolbar = screen.getByRole('toolbar', { name: '问诊语音控制' })
    expect(toolbar).toBeTruthy()
    expect(container.querySelector('[role="separator"]')).toBeTruthy()
    // Historical turn must NOT auto-speak on mount
    expect(spokenUtterances).toHaveLength(0)

    // Newly appended patient turn auto-speaks
    const newTurn = buildPatientTurn(
      'turn-2',
      2,
      '昨晚还有点发烧，大概三十八度二。',
      '2026-11-28T08:02:00Z',
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    rerender(
      <QueryClientProvider client={queryClient}>
        <ConsultationPage
          action={{ error: null, onAsk, onRetry: vi.fn(), pending: false }}
          caseId="case-voice-1"
          consultation={buildConsultation([initialTurn, newTurn])}
          locale="zh-CN"
          messages={messages}
          patientBirthDate="1985-03-15"
          patientGender="female"
          patientName="林女士"
          readOnly={false}
        />
      </QueryClientProvider>,
    )
    expect(spokenUtterances).toHaveLength(1)
    expect(spokenUtterances[0]?.text).toBe('昨晚还有点发烧，大概三十八度二。')

    // Per-bubble replay button speaks the selected historical turn on demand
    fireEvent.click(screen.getByTestId('patient-turn-speak-turn-1'))
    expect(spokenUtterances.at(-1)?.text).toBe('历史记录：三天前开始咳嗽。')
  })

  it('guards push-to-talk against short taps, supports slide-up cancel, commits >= 600ms speech, and shows privacy pause banner', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-28T10:00:00Z'))

    const messages = getWorkspaceMessages('zh-CN')
    const onAsk = vi.fn()
    renderWithQuery(
      <ConsultationPage
        action={{ error: null, onAsk, onRetry: vi.fn(), pending: false }}
        caseId="case-voice-2"
        consultation={buildConsultation([])}
        locale="zh-CN"
        messages={messages}
        patientName="张先生"
        readOnly={false}
      />,
    )

    const holdBtn = screen.getByTestId('voice-hold-btn')

    // 1. Short tap (< 600ms) is discarded without calling onAsk
    fireEvent.pointerDown(holdBtn, { button: 0, pointerId: 1, clientY: 200 })
    act(() => { vi.advanceTimersByTime(250) })
    fireEvent.pointerUp(holdBtn, { button: 0, pointerId: 1, clientY: 200 })
    expect(onAsk).not.toHaveBeenCalled()
    expect(screen.getByTestId('voice-live-status').textContent).toContain('说话时间过短')

    // 2. Slide up (> 48px) cancels cleanly without sending
    fireEvent.pointerDown(holdBtn, { button: 0, pointerId: 2, clientY: 200 })
    act(() => { vi.advanceTimersByTime(800) })
    act(() => { MockSpeechRecognition.latest?.emitResult('不想发出的内容', true) })
    fireEvent.pointerMove(holdBtn, { button: 0, pointerId: 2, clientY: 130 })
    expect(holdBtn.textContent).toContain('松开取消')
    fireEvent.pointerUp(holdBtn, { button: 0, pointerId: 2, clientY: 130 })
    expect(onAsk).not.toHaveBeenCalled()

    // 3. Hold >= 600ms commits and sends utterance
    fireEvent.pointerDown(holdBtn, { button: 0, pointerId: 3, clientY: 200 })
    act(() => { vi.advanceTimersByTime(900) })
    act(() => { MockSpeechRecognition.latest?.emitResult('请问胸痛会向后背放射吗？', true) })
    fireEvent.pointerUp(holdBtn, { button: 0, pointerId: 3, clientY: 200 })
    expect(onAsk).toHaveBeenCalledWith('请问胸痛会向后背放射吗？')

    // 4. Privacy pause stops capture and displays explicit banner
    fireEvent.click(screen.getByTestId('voice-pause-btn'))
    expect(screen.getByTestId('voice-privacy-paused-banner').textContent).toContain('麦克风采集已完全关闭')
  })
})

describe('AssistantComposer voice dictation & VoiceSettingsCard', () => {
  it('dictates speech into AssistantComposer with live interim banner and appends final transcript', () => {
    const onChange = vi.fn()
    renderWithQuery(
      <AssistantComposer
        attachedEntities={[]}
        catalog={undefined}
        catalogFetching={false}
        clinicalEntities={[]}
        contextInspectorOpen={false}
        isRunning={false}
        onAttachEntity={vi.fn()}
        onChange={onChange}
        onClearQuote={vi.fn()}
        onCompact={vi.fn()}
        onExport={vi.fn()}
        onOpenContextInspector={vi.fn()}
        onOpenInstructions={vi.fn()}
        onOpenSideChat={vi.fn()}
        onRecallQueuedInput={vi.fn()}
        onRefreshCatalog={vi.fn()}
        onRemoveEntity={vi.fn()}
        onReset={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        queuedInputs={[]}
        quotedText={null}
        recallPending={false}
        sendPending={false}
        stopPending={false}
        value="请帮我"
        zh
      />,
    )

    const dictateBtn = screen.getByTestId('assistant-voice-dictate-btn')
    expect(dictateBtn.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(dictateBtn)
    expect(dictateBtn.getAttribute('aria-pressed')).toBe('true')

    act(() => {
      MockSpeechRecognition.latest?.emitResult('起草门诊病历', false)
    })
    expect(screen.getByTestId('assistant-voice-listening-banner').textContent).toContain('起草门诊病历')

    act(() => {
      MockSpeechRecognition.latest?.emitResult('起草门诊病历并配好检查', true)
    })
    expect(onChange).toHaveBeenCalledWith('请帮我 起草门诊病历并配好检查')

    // Web Speech network failure shows clear Bailian guidance and settings link
    act(() => {
      MockSpeechRecognition.latest?.onerror?.({ error: 'network' })
    })
    expect(screen.getByTestId('assistant-voice-error').textContent).toContain('阿里云百炼')
    expect(screen.getByTestId('assistant-voice-open-settings-link')).toBeTruthy()
  })

  it('marks BYOK BAILIAN_TOKEN input with data-agent-secret, previews speech, and persists local voice settings', () => {
    renderWithQuery(<VoiceSettingsCard locale="zh-CN" />)
    const tokenInput = screen.getByLabelText(/阿里云百炼 API Key/i)
    expect(tokenInput.hasAttribute('data-agent-secret')).toBe(true)

    // Without token configured, preview falls back cleanly to browser Web Speech synthesis
    fireEvent.click(screen.getByTestId('voice-test-tts-btn'))
    expect(spokenUtterances.length).toBeGreaterThanOrEqual(1)

    // Persists browser-local BYOK token cleanly
    fireEvent.change(tokenInput, { target: { value: 'sk-local-voice-test' } })
    expect(readVoiceSettings().apiKey).toBe('sk-local-voice-test')
  })
})
