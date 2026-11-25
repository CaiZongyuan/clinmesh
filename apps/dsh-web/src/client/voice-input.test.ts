// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import {
  createSurfaceVoiceInput,
  encodePcm16Wav,
  joinVoiceText,
  matchesVoiceShortcut,
  type DshEarsRemotePort,
  type MediaCaptureHandle,
  type RealtimeCaptureHandle,
  type SpeechRecognitionLike,
} from './voice-input.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function ok<T>(value: T) {
  return { ok: true as const, value }
}

function makeSettings(overrides: Record<string, unknown> = {}) {
  return {
    asrBackend: 'web-speech',
    webSpeechLanguage: '',
    localWhisperModel: 'tiny',
    cloudAsrProvider: 'groq',
    cloudAsrDeepgramService: 'recording-file',
    cloudAsrTencentService: 'recording-file',
    cloudAsrVolcengineService: 'recording-file',
    maxRecordingSeconds: 120,
    voiceShortcutEnabled: true,
    voiceShortcut: 'ctrl+shift+space',
    polishingEnabled: true,
    polishProvider: '',
    polishModel: '',
    polishReasoningEffort: '',
    ...overrides,
  }
}

function createFakeRemote(overrides: Partial<DshEarsRemotePort> = {}): DshEarsRemotePort {
  return {
    getSettings: vi.fn(async () => ok({ available: true, settings: makeSettings() })),
    listAsrBackends: vi.fn(async () => ok([
      { id: 'web-speech', available: true },
      { id: 'local-whisper', available: true },
      { id: 'cloud-openai', available: true },
    ])),
    getWhisperModelState: vi.fn(async () => ok({ runtimeAvailable: true, downloaded: true, downloading: false })),
    transcribe: vi.fn(async () => ok({ status: 'ok', text: '患者自述胸闷两天' })),
    startRealtime: vi.fn(async () => ok({ sessionId: 'rt-1' })),
    sendRealtimeAudio: vi.fn(async () => ok({ text: '胸痛持续十分钟', final: false })),
    finishRealtime: vi.fn(async () => ok({ status: 'ok', text: '胸痛持续十分钟，休息后缓解' })),
    cancelRealtime: vi.fn(async () => ok(null)),
    polish: vi.fn(async () => ok({ status: 'ok', text: '患者自述胸闷两天。' })),
    ...overrides,
  }
}

function createFakeContext(options: {
  remote?: DshEarsRemotePort
  locale?: string
} = {}) {
  let language = options.locale ?? 'zh-CN'
  let dshEars = options.remote
  const localeListeners = new Set<() => void>()
  const remoteListeners = new Map<string, Set<() => void>>()
  const ctxListeners = new Map<string, Set<() => void>>()
  let injectCallback: ((child: ClientContext) => void) | undefined
  let childDisposer: (() => void) | undefined
  const fiberDispose = vi.fn()

  const ctx = {
    get(name: string) {
      if (name === 'locale') {
        return {
          getLocale: () => ({ active: language }),
          subscribe(listener: () => void) {
            localeListeners.add(listener)
            return () => { localeListeners.delete(listener) }
          },
        }
      }
      if (name === 'remote.dshEars') return dshEars
      if (name === 'remote') {
        return {
          dshEars,
          $on(event: string, listener: () => void) {
            let bucket = remoteListeners.get(event)
            if (bucket === undefined) {
              bucket = new Set()
              remoteListeners.set(event, bucket)
            }
            bucket.add(listener)
            return () => { bucket.delete(listener) }
          },
        }
      }
      return undefined
    },
    on(event: string, listener: () => void) {
      let bucket = ctxListeners.get(event)
      if (bucket === undefined) {
        bucket = new Set()
        ctxListeners.set(event, bucket)
      }
      bucket.add(listener)
      return () => { bucket.delete(listener) }
    },
    inject(this: unknown, deps: string[], callback: (child: ClientContext) => void) {
      expect(this).toBe(ctx)
      expect(deps).toEqual(['remote.dshEars'])
      injectCallback = callback
      if (dshEars !== undefined) {
        mountInjected(dshEars)
      }
      return { dispose: fiberDispose }
    },
  }

  function mountInjected(nextRemote: DshEarsRemotePort) {
    dshEars = nextRemote
    const child = {
      get: (name: string) => (name === 'remote.dshEars' ? nextRemote : undefined),
      effect: (factory: () => () => void) => {
        childDisposer = factory()
      },
    }
    injectCallback?.(child as unknown as ClientContext)
  }

  return {
    ctx: ctx as unknown as ClientContext,
    fiberDispose,
    mountInjected,
    unmountInjected() {
      dshEars = undefined
      childDisposer?.()
      childDisposer = undefined
    },
    setLocale(next: string) {
      language = next
      for (const listener of localeListeners) listener()
    },
    emitRemote(event: string) {
      for (const listener of remoteListeners.get(event) ?? []) listener()
    },
    emitCtx(event: string) {
      for (const listener of ctxListeners.get(event) ?? []) listener()
    },
  }
}

function createFakeSpeechRecognition(): SpeechRecognitionLike & {
  emitResult: (results: Array<{ transcript: string; isFinal: boolean }>) => void
  emitError: (error: string) => void
  emitEnd: () => void
  started: number
  stopped: number
  aborted: number
} {
  const instance = {
    lang: '',
    continuous: false,
    interimResults: false,
    maxAlternatives: 1,
    onstart: null as (() => void) | null,
    onresult: null as SpeechRecognitionLike['onresult'],
    onerror: null as SpeechRecognitionLike['onerror'],
    onend: null as (() => void) | null,
    started: 0,
    stopped: 0,
    aborted: 0,
    start() {
      instance.started += 1
      instance.onstart?.()
    },
    stop() {
      instance.stopped += 1
      instance.onend?.()
    },
    abort() {
      instance.aborted += 1
    },
    emitResult(results: Array<{ transcript: string; isFinal: boolean }>) {
      instance.onresult?.({
        resultIndex: 0,
        results: results.map(item => ({ isFinal: item.isFinal, 0: { transcript: item.transcript } })),
      })
    },
    emitError(error: string) {
      instance.onerror?.({ error })
    },
    emitEnd() {
      instance.onend?.()
    },
  }
  return instance
}

describe('voice-input pure helpers', () => {
  it('joins CJK, ASCII and full-width punctuation cleanly', () => {
    expect(joinVoiceText('', '头痛')).toBe('头痛')
    expect(joinVoiceText('头痛', '')).toBe('头痛')
    expect(joinVoiceText('持续两天', '伴发热')).toBe('持续两天伴发热')
    expect(joinVoiceText('持续两天，', '伴发热')).toBe('持续两天，伴发热')
    expect(joinVoiceText('chest', 'pain')).toBe('chest pain')
    expect(joinVoiceText('胸痛', '2 hours')).toBe('胸痛 2 hours')
    expect(joinVoiceText('胸痛 ', '伴大汗')).toBe('胸痛 伴大汗')
  })

  it('encodes mono 16 kHz PCM16 WAV with downmixing and resampling', () => {
    const stereo48k = {
      sampleRate: 48_000,
      length: 480,
      numberOfChannels: 2,
      getChannelData: (channel: number) => new Float32Array(480).fill(channel === 0 ? 0.5 : -0.5),
    }
    const wav = encodePcm16Wav(stereo48k)
    const view = new DataView(wav.buffer)
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe('WAVE')
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(16_000) // 16 kHz
    expect(view.getUint16(34, true)).toBe(16) // 16-bit
    expect(view.getUint32(40, true)).toBe(160 * 2) // 480 * 16000 / 48000 = 160 frames
    // +0.5 and -0.5 average to 0
    expect(view.getInt16(44, true)).toBe(0)
    expect(() => encodePcm16Wav({ sampleRate: 0, length: 0, numberOfChannels: 1, getChannelData: () => new Float32Array() }))
      .toThrow(RangeError)
  })

  it('matches canonical dsh-ears shortcuts including modifier-only chords and rejects invalid chords', () => {
    expect(matchesVoiceShortcut('ctrl+shift+space', {
      ctrlKey: true, altKey: false, shiftKey: true, metaKey: false, code: 'Space', key: ' ',
    })).toBe(true)
    expect(matchesVoiceShortcut('ctrl+shift+space', {
      ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, code: 'Space', key: ' ',
    })).toBe(false)
    expect(matchesVoiceShortcut('alt+v', {
      ctrlKey: false, altKey: true, shiftKey: false, metaKey: false, code: 'KeyV', key: 'v',
    })).toBe(true)
    expect(matchesVoiceShortcut('ctrl+shift', {
      ctrlKey: true, altKey: false, shiftKey: true, metaKey: false, code: 'ShiftLeft', key: 'Shift',
    })).toBe(true)
    expect(matchesVoiceShortcut('ctrl+shift', {
      ctrlKey: true, altKey: false, shiftKey: true, metaKey: false, code: 'Space', key: ' ',
    })).toBe(false)
    expect(matchesVoiceShortcut('ctrl+unknownkey', {
      ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, code: 'Space', key: ' ',
    })).toBe(false)
    expect(matchesVoiceShortcut('', {
      ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, code: 'Space', key: ' ',
    })).toBe(false)
  })
})

describe('createSurfaceVoiceInput', () => {
  it('stays non-blocking when dsh-ears is absent and attaches/detaches reactively via ctx.inject', async () => {
    const fake = createFakeContext()
    const speech = createFakeSpeechRecognition()
    const voice = createSurfaceVoiceInput(fake.ctx, { createSpeechRecognition: () => speech })
    try {
      expect(voice.getSnapshot().installed).toBe(false)
      expect(voice.getSnapshot().ready).toBe(false)

      const remote = createFakeRemote()
      fake.mountInjected(remote)
      expect(voice.getSnapshot().installed).toBe(true)
      await vi.waitFor(() => expect(voice.getSnapshot().ready).toBe(true))

      fake.unmountInjected()
      expect(voice.getSnapshot().installed).toBe(false)
      expect(voice.getSnapshot().ready).toBe(false)
    } finally {
      voice.dispose()
      expect(fake.fiberDispose).toHaveBeenCalledOnce()
    }
  })

  it('streams Web Speech results, polishes after stop, preserves manual edits, and retains raw text on polish failure', async () => {
    const remote = createFakeRemote({
      polish: vi.fn(async () => ok({ status: 'ok', text: '请问发热几天了？' })),
    })
    const fake = createFakeContext({ remote })
    let speech = createFakeSpeechRecognition()
    const voice = createSurfaceVoiceInput(fake.ctx, { createSpeechRecognition: () => speech })
    try {
      await vi.waitFor(() => expect(voice.getSnapshot().ready).toBe(true))

      let draft = ''
      const target = { getDraft: () => draft, setDraft: (next: string) => { draft = next } }
      voice.start(target)
      expect(voice.getSnapshot().phase).toBe('recording')
      speech.emitResult([{ transcript: '请问发热几天了', isFinal: true }])
      expect(draft).toBe('请问发热几天了')
      voice.stop()
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('idle'))
      expect(draft).toBe('请问发热几天了？')

      // Manual edit during polish prevents overwriting user text
      let resolvePolish!: (value: unknown) => void
      remote.polish = vi.fn(() => new Promise(resolve => { resolvePolish = resolve }))
      speech = createFakeSpeechRecognition()
      draft = ''
      voice.start(target)
      speech.emitResult([{ transcript: '原始提问', isFinal: true }])
      voice.stop()
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('polishing'))
      draft = '医生手工修改后的问题'
      resolvePolish(ok({ status: 'ok', text: '润色文本' }))
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('idle'))
      expect(draft).toBe('医生手工修改后的问题')

      // Polish failure keeps raw transcript and surfaces non-destructive error
      remote.polish = vi.fn(async () => ok({ status: 'error', message: 'upstream failed' }))
      speech = createFakeSpeechRecognition()
      draft = ''
      voice.start(target)
      speech.emitResult([{ transcript: '是否有药物过敏史', isFinal: true }])
      voice.stop()
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('error'))
      expect(draft).toBe('是否有药物过敏史')
      expect(voice.getSnapshot().error).toContain('润色失败')
      voice.clearError()
      expect(voice.getSnapshot().phase).toBe('idle')
    } finally {
      voice.dispose()
    }
  })

  it('checks local-whisper readiness and converts audio to WAV before calling remote.dshEars.transcribe', async () => {
    let downloaded = false
    const remote = createFakeRemote({
      getSettings: vi.fn(async () => ok({ available: true, settings: makeSettings({ asrBackend: 'local-whisper', polishingEnabled: false }) })),
      getWhisperModelState: vi.fn(async () => ok({ runtimeAvailable: true, downloaded, downloading: false })),
      transcribe: vi.fn(async () => ok({ status: 'ok', text: '最近有没有胸痛？' })),
    })
    const fake = createFakeContext({ remote })
    const decodeToWav = vi.fn(async () => ({ base64: 'V0FWX0JZVEVTX1BBRERFRF9GSVhUVVJF'.repeat(10), mimeType: 'audio/wav' }))
    const mediaHandle: MediaCaptureHandle = {
      start: vi.fn(),
      stop: vi.fn(async () => ({ base64: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='.repeat(10), mimeType: 'audio/webm' })),
      abort: vi.fn(),
    }
    const voice = createSurfaceVoiceInput(fake.ctx, {
      isMediaRecorderAvailable: () => true,
      createMediaCapture: async () => mediaHandle,
      decodeToWav,
    })
    try {
      await vi.waitFor(() => expect(voice.getSnapshot().unavailableReason).toContain('Whisper'))
      expect(voice.getSnapshot().installed).toBe(true)
      expect(voice.getSnapshot().ready).toBe(false)

      downloaded = true
      fake.emitRemote('settings/document-updated')
      await vi.waitFor(() => expect(voice.getSnapshot().ready).toBe(true))

      let draft = ''
      voice.start({ getDraft: () => draft, setDraft: next => { draft = next } })
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('recording'))
      voice.stop()
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('idle'))
      expect(decodeToWav).toHaveBeenCalledOnce()
      expect(remote.transcribe).toHaveBeenCalledWith(expect.any(String), 'audio/wav', expect.any(AbortSignal))
      expect(draft).toBe('最近有没有胸痛？')
    } finally {
      voice.dispose()
    }
  })

  it('skips WAV conversion for bailian batch ASR and requires it for tencent batch ASR', async () => {
    let provider = 'bailian'
    let shortcut = 'ctrl+shift+space'
    const remote = createFakeRemote({
      getSettings: vi.fn(async () => ok({
        available: true,
        settings: makeSettings({ asrBackend: 'cloud-openai', cloudAsrProvider: provider, voiceShortcut: shortcut, polishingEnabled: false }),
      })),
      transcribe: vi.fn(async () => ok({ status: 'ok', text: '请问服药后有无缓解' })),
    })
    const fake = createFakeContext({ remote })
    const decodeToWav = vi.fn(async () => ({ base64: 'V0FW'.repeat(60), mimeType: 'audio/wav' }))
    const createMediaCapture = vi.fn(async (): Promise<MediaCaptureHandle> => ({
      start: vi.fn(),
      stop: vi.fn(async () => ({ base64: 'V0VCTQ=='.repeat(60), mimeType: 'audio/webm' })),
      abort: vi.fn(),
    }))
    const voice = createSurfaceVoiceInput(fake.ctx, {
      isMediaRecorderAvailable: () => true,
      createMediaCapture,
      decodeToWav,
    })
    try {
      await vi.waitFor(() => expect(voice.getSnapshot().ready).toBe(true))
      let draft = ''
      voice.start({ getDraft: () => draft, setDraft: next => { draft = next } })
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('recording'))
      voice.stop()
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('idle'))
      expect(decodeToWav).not.toHaveBeenCalled()
      expect(remote.transcribe).toHaveBeenLastCalledWith(expect.any(String), 'audio/webm', expect.any(AbortSignal))

      provider = 'tencent'
      shortcut = 'alt+t'
      fake.emitCtx('connection/reset')
      await vi.waitFor(() => expect(voice.getSnapshot().shortcut).toBe('alt+t'))
      draft = ''
      voice.start({ getDraft: () => draft, setDraft: next => { draft = next } })
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('recording'))
      voice.stop()
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('idle'))
      expect(decodeToWav).toHaveBeenCalledOnce()
      expect(remote.transcribe).toHaveBeenLastCalledWith(expect.any(String), 'audio/wav', expect.any(AbortSignal))
    } finally {
      voice.dispose()
    }
  })

  it('streams realtime cloud ASR chunks and cleans up remote sessions on stop', async () => {
    const remote = createFakeRemote({
      getSettings: vi.fn(async () => ok({
        available: true,
        settings: makeSettings({
          asrBackend: 'cloud-openai',
          cloudAsrProvider: 'deepgram',
          cloudAsrDeepgramService: 'realtime',
          polishingEnabled: false,
        }),
      })),
    })
    const fake = createFakeContext({ remote })
    let emitChunk!: (base64: string) => Promise<void>
    const handle: RealtimeCaptureHandle = {
      start: cb => { emitChunk = cb },
      stop: vi.fn(async () => undefined),
      abort: vi.fn(),
    }
    const voice = createSurfaceVoiceInput(fake.ctx, {
      isRealtimeCaptureAvailable: () => true,
      createRealtimeCapture: async () => handle,
    })
    try {
      await vi.waitFor(() => expect(voice.getSnapshot().ready).toBe(true))
      let draft = ''
      voice.start({ getDraft: () => draft, setDraft: next => { draft = next } })
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('recording'))
      await emitChunk('UENN')
      expect(draft).toBe('胸痛持续十分钟')
      voice.stop()
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('idle'))
      expect(draft).toBe('胸痛持续十分钟，休息后缓解')
      expect(remote.finishRealtime).toHaveBeenCalledWith('rt-1', expect.any(AbortSignal))
      expect(remote.cancelRealtime).toHaveBeenCalledWith('rt-1')
    } finally {
      voice.dispose()
    }
  })

  it('routes global capture shortcuts to consultation only when shouldHandle matches and avoids double-firing dsh-ears', async () => {
    const remote = createFakeRemote()
    const fake = createFakeContext({ remote })
    const speech = createFakeSpeechRecognition()
    const voice = createSurfaceVoiceInput(fake.ctx, { createSpeechRecognition: () => speech })
    const downstreamDshEars = vi.fn()
    window.addEventListener('keydown', downstreamDshEars, true)
    try {
      await vi.waitFor(() => expect(voice.getSnapshot().ready).toBe(true))
      let handleConsultation = false
      const toggle = vi.fn(() => {
        if (voice.getSnapshot().phase === 'recording') voice.stop()
        else voice.start({ getDraft: () => '', setDraft: () => {} })
      })
      const unregister = voice.registerShortcutHandler({
        shouldHandle: () => handleConsultation,
        toggle,
      })

      // Unfocused split-screen: should NOT intercept, letting dsh-ears handle right conversation
      window.dispatchEvent(new KeyboardEvent('keydown', {
        code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, cancelable: true,
      }))
      expect(toggle).not.toHaveBeenCalled()
      expect(downstreamDshEars).toHaveBeenCalledTimes(1)

      // Focused consultation or fullscreen/collapsed right pane: intercept and stopImmediatePropagation
      handleConsultation = true
      window.dispatchEvent(new KeyboardEvent('keydown', {
        code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, cancelable: true,
      }))
      expect(toggle).toHaveBeenCalledTimes(1)
      expect(voice.getSnapshot().phase).toBe('recording')
      expect(downstreamDshEars).toHaveBeenCalledTimes(1)

      // While consultation is actively recording, shortcut stops it even if focus moved away
      handleConsultation = false
      window.dispatchEvent(new KeyboardEvent('keydown', {
        code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, cancelable: true,
      }))
      expect(speech.stopped).toBe(1)
      expect(downstreamDshEars).toHaveBeenCalledTimes(1)

      unregister()
    } finally {
      window.removeEventListener('keydown', downstreamDshEars, true)
      voice.dispose()
    }
  })

  it('cancels active speech, media/transcribe, realtime, and polish sessions and releases resources', async () => {
    let transcribeSignal: AbortSignal | undefined
    let polishSignal: AbortSignal | undefined
    let realtimeChunkSignal: AbortSignal | undefined
    let resolveStopMedia!: (value: { base64: string; mimeType: string }) => void
    const remote = createFakeRemote({
      getSettings: vi.fn(async () => ok({ available: true, settings: makeSettings({ asrBackend: 'web-speech', polishingEnabled: true }) })),
      transcribe: vi.fn((_audio, _mime, signal) => {
        transcribeSignal = signal
        return new Promise(() => {})
      }),
      polish: vi.fn((_text, _p, _m, _r, signal) => {
        polishSignal = signal
        return new Promise(() => {})
      }),
      sendRealtimeAudio: vi.fn((_id, _audio, signal) => {
        realtimeChunkSignal = signal
        return new Promise(() => {})
      }),
    })
    const fake = createFakeContext({ remote })
    let speech = createFakeSpeechRecognition()
    const mediaHandle: MediaCaptureHandle = {
      start: vi.fn(),
      stop: vi.fn(() => new Promise<{ base64: string; mimeType: string }>(resolve => { resolveStopMedia = resolve })),
      abort: vi.fn(),
    }
    let emitRealtimeChunk!: (base64: string) => Promise<void>
    const realtimeHandle: RealtimeCaptureHandle = {
      start: cb => { emitRealtimeChunk = cb },
      stop: vi.fn(async () => undefined),
      abort: vi.fn(),
    }
    const voice = createSurfaceVoiceInput(fake.ctx, {
      createSpeechRecognition: () => speech,
      isMediaRecorderAvailable: () => true,
      createMediaCapture: async () => mediaHandle,
      isRealtimeCaptureAvailable: () => true,
      createRealtimeCapture: async () => realtimeHandle,
    })
    try {
      await vi.waitFor(() => expect(voice.getSnapshot().ready).toBe(true))

      // 1. Cancel active Web Speech
      let draft = ''
      const target = { getDraft: () => draft, setDraft: (next: string) => { draft = next } }
      voice.start(target)
      expect(voice.getSnapshot().phase).toBe('recording')
      voice.cancel()
      expect(speech.aborted).toBe(1)
      expect(voice.getSnapshot().phase).toBe('idle')

      // 2. Cancel in-flight polish
      speech = createFakeSpeechRecognition()
      voice.start(target)
      speech.emitResult([{ transcript: '是否伴随胸痛', isFinal: true }])
      voice.stop()
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('polishing'))
      expect(polishSignal?.aborted).toBe(false)
      voice.cancel()
      expect(polishSignal?.aborted).toBe(true)
      expect(voice.getSnapshot().phase).toBe('idle')

      // 3. Cancel media recording mid-stop() and during in-flight transcribe()
      remote.getSettings = vi.fn(async () => ok({
        available: true,
        settings: makeSettings({ asrBackend: 'cloud-openai', cloudAsrProvider: 'bailian', voiceShortcut: 'alt+b', polishingEnabled: false }),
      }))
      fake.emitRemote('settings/document-updated')
      await vi.waitFor(() => expect(voice.getSnapshot().shortcut).toBe('alt+b'))

      voice.start(target)
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('recording'))
      voice.stop()
      voice.cancel()
      expect(mediaHandle.abort).toHaveBeenCalledTimes(1)
      expect(voice.getSnapshot().phase).toBe('idle')
      resolveStopMedia({ base64: 'V0VCTQ=='.repeat(60), mimeType: 'audio/webm' })

      mediaHandle.stop = vi.fn(async () => ({ base64: 'V0VCTQ=='.repeat(60), mimeType: 'audio/webm' }))
      voice.start(target)
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('recording'))
      voice.stop()
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('transcribing'))
      expect(transcribeSignal?.aborted).toBe(false)
      voice.cancel()
      expect(transcribeSignal?.aborted).toBe(true)
      expect(voice.getSnapshot().phase).toBe('idle')

      // 4. Cancel active realtime recording -> aborts stream signal, handle, and remote session
      remote.getSettings = vi.fn(async () => ok({
        available: true,
        settings: makeSettings({
          asrBackend: 'cloud-openai',
          cloudAsrProvider: 'deepgram',
          cloudAsrDeepgramService: 'realtime',
          voiceShortcut: 'alt+r',
          polishingEnabled: false,
        }),
      }))
      fake.emitRemote('settings/document-updated')
      await vi.waitFor(() => expect(voice.getSnapshot().shortcut).toBe('alt+r'))

      voice.start(target)
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('recording'))
      void emitRealtimeChunk('UENN')
      await vi.waitFor(() => expect(realtimeChunkSignal).toBeDefined())
      expect(realtimeChunkSignal?.aborted).toBe(false)
      voice.cancel()
      expect(realtimeChunkSignal?.aborted).toBe(true)
      expect(realtimeHandle.abort).toHaveBeenCalledTimes(1)
      expect(remote.cancelRealtime).toHaveBeenCalledWith('rt-1')
      expect(voice.getSnapshot().phase).toBe('idle')
    } finally {
      voice.dispose()
    }
  })

  it('preserves manual draft edits made during batch transcription', async () => {
    let resolveTranscribe!: (value: unknown) => void
    const remote = createFakeRemote({
      getSettings: vi.fn(async () => ok({
        available: true,
        settings: makeSettings({ asrBackend: 'cloud-openai', cloudAsrProvider: 'bailian', polishingEnabled: false }),
      })),
      transcribe: vi.fn(() => new Promise(resolve => { resolveTranscribe = resolve })),
    })
    const fake = createFakeContext({ remote })
    const voice = createSurfaceVoiceInput(fake.ctx, {
      isMediaRecorderAvailable: () => true,
      createMediaCapture: async () => ({
        start: vi.fn(),
        stop: vi.fn(async () => ({ base64: 'V0VCTQ=='.repeat(60), mimeType: 'audio/webm' })),
        abort: vi.fn(),
      }),
    })
    try {
      await vi.waitFor(() => expect(voice.getSnapshot().ready).toBe(true))
      let draft = '既往史：'
      voice.start({ getDraft: () => draft, setDraft: next => { draft = next } })
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('recording'))
      voice.stop()
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('transcribing'))
      // Doctor manually appends text while waiting for ASR response
      draft = '既往史：高血压十年，'
      resolveTranscribe(ok({ status: 'ok', text: '否认糖尿病史' }))
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('idle'))
      expect(draft).toBe('既往史：高血压十年，否认糖尿病史')
    } finally {
      voice.dispose()
    }
  })

  it('does not hijack shortcuts when unready, inside ShadowRoot dialogs, when defaultPrevented, or when host dsh-ears is recording', async () => {
    const remote = createFakeRemote({
      listAsrBackends: vi.fn(async () => ok([
        { id: 'web-speech', available: true },
        { id: 'cloud-openai', available: false },
      ])),
      getSettings: vi.fn(async () => ok({
        available: true,
        settings: makeSettings({ asrBackend: 'cloud-openai', cloudAsrProvider: 'bailian' }),
      })),
    })
    const fake = createFakeContext({ remote })
    const speech = createFakeSpeechRecognition()
    const voice = createSurfaceVoiceInput(fake.ctx, {
      createSpeechRecognition: () => speech,
      isMediaRecorderAvailable: () => true,
    })
    const toggle = vi.fn()
    const unregister = voice.registerShortcutHandler({ shouldHandle: () => true, toggle })
    const host = document.createElement('div')
    document.body.append(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const dialogButton = document.createElement('button')
    dialog.append(dialogButton)
    shadow.append(dialog)
    const recognitionBar = document.createElement('div')
    recognitionBar.setAttribute('data-phase', 'visible')
    recognitionBar.setAttribute('data-state', 'recording')
    try {
      // 1. Unready backend must NOT intercept or preventDefault shortcut
      await vi.waitFor(() => expect(voice.getSnapshot().unavailableReason).toBeDefined())
      const unreadyEvent = new KeyboardEvent('keydown', {
        code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, cancelable: true,
      })
      window.dispatchEvent(unreadyEvent)
      expect(unreadyEvent.defaultPrevented).toBe(false)
      expect(toggle).not.toHaveBeenCalled()

      // Switch to ready web-speech
      remote.getSettings = vi.fn(async () => ok({ available: true, settings: makeSettings({ asrBackend: 'web-speech' }) }))
      fake.emitRemote('settings/document-updated')
      await vi.waitFor(() => expect(voice.getSnapshot().ready).toBe(true))

      // 2. ShadowRoot dialog suppresses shortcut via composedPath
      const shadowDialogEvent = new KeyboardEvent('keydown', {
        code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, bubbles: true, composed: true, cancelable: true,
      })
      dialogButton.dispatchEvent(shadowDialogEvent)
      expect(shadowDialogEvent.defaultPrevented).toBe(false)
      expect(toggle).not.toHaveBeenCalled()

      // 3. Already defaultPrevented event (e.g. handled by earlier listener) is ignored
      const alreadyHandled = new KeyboardEvent('keydown', {
        code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, cancelable: true,
      })
      alreadyHandled.preventDefault()
      window.dispatchEvent(alreadyHandled)
      expect(toggle).not.toHaveBeenCalled()

      // 4. Host dsh-ears actively recording in right pane yields shortcut AND blocks button-driven start()
      document.body.append(recognitionBar)
      const hostRecordingEvent = new KeyboardEvent('keydown', {
        code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, cancelable: true,
      })
      window.dispatchEvent(hostRecordingEvent)
      expect(hostRecordingEvent.defaultPrevented).toBe(false)
      expect(toggle).not.toHaveBeenCalled()
      voice.start({ getDraft: () => '', setDraft: () => {} })
      expect(speech.started).toBe(0)
      expect(voice.getSnapshot().phase).toBe('error')
      expect(voice.getSnapshot().error).toContain('右侧会话正在录音')
      recognitionBar.setAttribute('data-state', 'starting')
      voice.clearError()
      voice.start({ getDraft: () => '', setDraft: () => {} })
      expect(speech.started).toBe(0)
      expect(voice.getSnapshot().phase).toBe('error')
      recognitionBar.remove()
      voice.clearError()

      // 5. Once clear, shortcut and button-driven start() work normally
      const cleanEvent = new KeyboardEvent('keydown', {
        code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, cancelable: true,
      })
      window.dispatchEvent(cleanEvent)
      expect(cleanEvent.defaultPrevented).toBe(true)
      expect(toggle).toHaveBeenCalledTimes(1)
      voice.start({ getDraft: () => '', setDraft: () => {} })
      expect(speech.started).toBe(1)
      expect(voice.getSnapshot().phase).toBe('recording')
      voice.cancel()
    } finally {
      unregister()
      recognitionBar.remove()
      host.remove()
      voice.dispose()
    }
  })

  it('degrades gracefully when remote.dshEars omits optional realtime methods', async () => {
    const partialRemote: DshEarsRemotePort = {
      getSettings: vi.fn(async () => ok({
        available: true,
        settings: makeSettings({
          asrBackend: 'cloud-openai',
          cloudAsrProvider: 'deepgram',
          cloudAsrDeepgramService: 'realtime',
        }),
      })),
      listAsrBackends: vi.fn(async () => ok([{ id: 'cloud-openai', available: true }])),
      transcribe: vi.fn(async () => ok({ status: 'ok', text: '' })),
      polish: vi.fn(async () => ok({ status: 'ok', text: '' })),
    }
    const fake = createFakeContext({ remote: partialRemote })
    const voice = createSurfaceVoiceInput(fake.ctx, { isRealtimeCaptureAvailable: () => true })
    try {
      await vi.waitFor(() => expect(voice.getSnapshot().unavailableReason).toContain('实时语音识别接口'))
      expect(voice.getSnapshot().ready).toBe(false)
      expect(() => voice.cancel()).not.toThrow()
    } finally {
      voice.dispose()
    }
  })

  it('keeps the bridge unready and never falls back to web-speech when getSettings reports available: false', async () => {
    let available = false
    let backend = 'web-speech'
    const remote = createFakeRemote({
      getSettings: vi.fn(async () => ok({
        available,
        settings: makeSettings({ asrBackend: backend, cloudAsrProvider: 'bailian', polishingEnabled: false }),
      })),
    })
    const fake = createFakeContext({ remote })
    const speech = createFakeSpeechRecognition()
    const voice = createSurfaceVoiceInput(fake.ctx, {
      createSpeechRecognition: () => speech,
      isMediaRecorderAvailable: () => true,
    })
    const toggle = vi.fn()
    const unregister = voice.registerShortcutHandler({ shouldHandle: () => true, toggle })
    try {
      await vi.waitFor(() => expect(voice.getSnapshot().unavailableReason).toContain('语音设置暂不可用'))
      expect(voice.getSnapshot().installed).toBe(true)
      expect(voice.getSnapshot().ready).toBe(false)

      // Must refuse to start fallback Web Speech and must not hijack shortcut
      voice.start({ getDraft: () => '', setDraft: () => {} })
      expect(speech.started).toBe(0)
      expect(voice.getSnapshot().phase).toBe('idle')
      const shortcutEvent = new KeyboardEvent('keydown', {
        code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, cancelable: true,
      })
      window.dispatchEvent(shortcutEvent)
      expect(shortcutEvent.defaultPrevented).toBe(false)
      expect(toggle).not.toHaveBeenCalled()

      // Becomes ready once real configured backend is available
      available = true
      backend = 'cloud-openai'
      fake.emitRemote('settings/document-updated')
      await vi.waitFor(() => expect(voice.getSnapshot().ready).toBe(true))

      // Temporarily unavailable settings again -> becomes unready instead of switching to web-speech fallback
      available = false
      backend = 'web-speech'
      fake.emitRemote('settings/document-updated')
      await vi.waitFor(() => expect(voice.getSnapshot().ready).toBe(false))
      expect(voice.getSnapshot().unavailableReason).toContain('语音设置暂不可用')
      voice.start({ getDraft: () => '', setDraft: () => {} })
      expect(speech.started).toBe(0)
    } finally {
      unregister()
      voice.dispose()
    }
  })

  it('aborts stalled sendRealtimeAudio RPC before calling finishRealtime when stop() times out', async () => {
    let stalledSignal: AbortSignal | undefined
    let finishSawAbortedStream = false
    let pendingChunkPromise: Promise<void> | undefined
    const remote = createFakeRemote({
      getSettings: vi.fn(async () => ok({
        available: true,
        settings: makeSettings({
          asrBackend: 'cloud-openai',
          cloudAsrProvider: 'deepgram',
          cloudAsrDeepgramService: 'realtime',
          polishingEnabled: false,
        }),
      })),
      sendRealtimeAudio: vi.fn((_id, _audio, signal) => new Promise((_resolve, reject) => {
        stalledSignal = signal
        signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })),
      finishRealtime: vi.fn(async () => {
        finishSawAbortedStream = stalledSignal?.aborted === true
        return ok({ status: 'ok', text: '最终实时转写' })
      }),
    })
    const fake = createFakeContext({ remote })
    let emitChunk!: (base64: string) => Promise<void>
    const handle: RealtimeCaptureHandle = {
      start: cb => { emitChunk = cb },
      stop: vi.fn(async () => {
        if (pendingChunkPromise !== undefined) await pendingChunkPromise
      }),
      abort: vi.fn(),
    }
    const voice = createSurfaceVoiceInput(fake.ctx, {
      isRealtimeCaptureAvailable: () => true,
      createRealtimeCapture: async () => handle,
    })
    try {
      await vi.waitFor(() => expect(voice.getSnapshot().ready).toBe(true))
      let draft = ''
      voice.start({ getDraft: () => draft, setDraft: next => { draft = next } })
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('recording'))

      pendingChunkPromise = emitChunk('UENN')
      await vi.waitFor(() => expect(stalledSignal).toBeDefined())
      expect(stalledSignal?.aborted).toBe(false)

      vi.useFakeTimers()
      voice.stop()
      expect(voice.getSnapshot().phase).toBe('transcribing')

      // Advance past REALTIME_STOP_TIMEOUT_MS (4000ms)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(voice.getSnapshot().phase).toBe('idle')

      expect(stalledSignal?.aborted).toBe(true)
      expect(finishSawAbortedStream).toBe(true)
      expect(handle.abort).toHaveBeenCalledOnce()
      expect(remote.finishRealtime).toHaveBeenCalledWith('rt-1', expect.any(AbortSignal))
      expect(remote.cancelRealtime).toHaveBeenCalledWith('rt-1')
      expect(draft).toBe('最终实时转写')
    } finally {
      voice.dispose()
    }
  })

  it('blocks host dsh-ears mic button clicks and pointerdown while consultation owns the microphone', async () => {
    const remote = createFakeRemote()
    const fake = createFakeContext({ remote })
    const speech = createFakeSpeechRecognition()
    const voice = createSurfaceVoiceInput(fake.ctx, { createSpeechRecognition: () => speech })
    const slot = document.createElement('div')
    slot.setAttribute('data-slot', 'conversation.input.right')
    const hostMicButton = document.createElement('button')
    hostMicButton.type = 'button'
    hostMicButton.setAttribute('data-state', 'idle')
    hostMicButton.setAttribute('aria-pressed', 'false')
    const icon = document.createElement('span')
    hostMicButton.append(icon)
    slot.append(hostMicButton)
    const otherButton = document.createElement('button')
    otherButton.type = 'button'
    document.body.append(slot, otherButton)

    const hostOnClick = vi.fn()
    const hostOnPointerDown = vi.fn()
    const otherOnClick = vi.fn()
    hostMicButton.addEventListener('click', hostOnClick)
    hostMicButton.addEventListener('pointerdown', hostOnPointerDown)
    otherButton.addEventListener('click', otherOnClick)

    try {
      await vi.waitFor(() => expect(voice.getSnapshot().ready).toBe(true))

      // Idle consultation: host mic button clicks pass through normally
      icon.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      expect(hostOnClick).toHaveBeenCalledTimes(1)

      // Start consultation recording -> host mic click & pointerdown are blocked before reaching button
      voice.start({ getDraft: () => '', setDraft: () => {} })
      expect(voice.getSnapshot().phase).toBe('recording')

      const blockedClick = new MouseEvent('click', { bubbles: true, cancelable: true })
      icon.dispatchEvent(blockedClick)
      expect(blockedClick.defaultPrevented).toBe(true)
      expect(hostOnClick).toHaveBeenCalledTimes(1)

      const blockedPointerDown = new Event('pointerdown', { bubbles: true, cancelable: true })
      hostMicButton.dispatchEvent(blockedPointerDown)
      expect(blockedPointerDown.defaultPrevented).toBe(true)
      expect(hostOnPointerDown).toHaveBeenCalledTimes(0)

      // Unrelated buttons remain clickable
      otherButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      expect(otherOnClick).toHaveBeenCalledTimes(1)

      // After consultation stops/cancels, host mic button works again
      voice.cancel()
      expect(voice.getSnapshot().phase).toBe('idle')
      icon.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      expect(hostOnClick).toHaveBeenCalledTimes(2)
    } finally {
      slot.remove()
      otherButton.remove()
      voice.dispose()
    }
  })

  it('preserves trailing interim Web Speech words when stopping and passes the full transcript to polish', async () => {
    const polish = vi.fn(async (text: string) => ok({ status: 'ok', text: `${text}？` }))
    const remote = createFakeRemote({ polish })
    const fake = createFakeContext({ remote })
    const speech = createFakeSpeechRecognition()
    const voice = createSurfaceVoiceInput(fake.ctx, { createSpeechRecognition: () => speech })
    try {
      await vi.waitFor(() => expect(voice.getSnapshot().ready).toBe(true))
      let draft = ''
      voice.start({ getDraft: () => draft, setDraft: next => { draft = next } })
      speech.emitResult([
        { transcript: '胸痛持续多久', isFinal: true },
        { transcript: '是否伴出汗', isFinal: false },
      ])
      expect(draft).toBe('胸痛持续多久是否伴出汗')
      voice.stop()
      await vi.waitFor(() => expect(voice.getSnapshot().phase).toBe('idle'))
      expect(polish).toHaveBeenCalledWith('胸痛持续多久是否伴出汗', '', '', '', expect.any(AbortSignal))
      expect(draft).toBe('胸痛持续多久是否伴出汗？')
    } finally {
      voice.dispose()
    }
  })

  it('cancels the remote realtime session immediately when cancelled while microphone setup is pending', async () => {
    let resolveCapture!: (handle: RealtimeCaptureHandle) => void
    const remote = createFakeRemote({
      getSettings: vi.fn(async () => ok({
        available: true,
        settings: makeSettings({
          asrBackend: 'cloud-openai',
          cloudAsrProvider: 'deepgram',
          cloudAsrDeepgramService: 'realtime',
          polishingEnabled: false,
        }),
      })),
    })
    const fake = createFakeContext({ remote })
    const createRealtimeCapture = vi.fn(() => new Promise<RealtimeCaptureHandle>(resolve => {
      resolveCapture = resolve
    }))
    const voice = createSurfaceVoiceInput(fake.ctx, {
      isRealtimeCaptureAvailable: () => true,
      createRealtimeCapture,
    })
    try {
      await vi.waitFor(() => expect(voice.getSnapshot().ready).toBe(true))
      voice.start({ getDraft: () => '', setDraft: () => {} })
      await vi.waitFor(() => expect(createRealtimeCapture).toHaveBeenCalledOnce())
      expect(voice.getSnapshot().phase).toBe('starting')

      // Cancel BEFORE getUserMedia / createRealtimeCapture resolves -> remote session cancelled immediately
      voice.cancel()
      expect(voice.getSnapshot().phase).toBe('idle')
      expect(remote.cancelRealtime).toHaveBeenCalledTimes(1)
      expect(remote.cancelRealtime).toHaveBeenCalledWith('rt-1')

      // Late resolution aborts the newly acquired handle without cancelling remote session twice
      const lateHandle: RealtimeCaptureHandle = {
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
        abort: vi.fn(),
      }
      resolveCapture(lateHandle)
      await vi.waitFor(() => expect(lateHandle.abort).toHaveBeenCalledOnce())
      expect(lateHandle.start).not.toHaveBeenCalled()
      expect(remote.cancelRealtime).toHaveBeenCalledTimes(1)
    } finally {
      voice.dispose()
    }
  })
})
