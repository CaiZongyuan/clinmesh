import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  WebSurfaceVoiceInput,
  WebSurfaceVoicePhase,
  WebSurfaceVoiceShortcutContext,
  WebSurfaceVoiceSnapshot,
  WebSurfaceVoiceTarget,
} from '@clinmesh/web/runtime'
import { z } from 'zod'
import { normalizeHostLocale, type ClientLocalePort } from './host-locale.ts'

const WHISPER_SAMPLE_RATE = 16_000
const REALTIME_BUFFER_SIZE = 1024
const REALTIME_CHUNK_SAMPLES = WHISPER_SAMPLE_RATE / 25
const REALTIME_CHUNK_BYTES = REALTIME_CHUNK_SAMPLES * 2
const REALTIME_STOP_TIMEOUT_MS = 4_000
const MEDIA_STOP_FALLBACK_MS = 3_000
const SPEECH_STOP_FALLBACK_MS = 2_000
const TRIVIAL_RECORDING_MS = 250
const TRIVIAL_RECORDING_BYTES = 128
const BAILIAN_MAX_RECORDING_SECONDS = 300
const SHORTCUT_MAX_LENGTH = 64

const CJK_SCRIPT = '\\p{Script=Han}|\\p{Script=Hiragana}|\\p{Script=Katakana}|\\p{Script=Hangul}'
const FULL_WIDTH_PUNCTUATION = '[\\u3000-\\u303f\\u30fc\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65\\u2014\\u2026]'
const FULL_WIDTH_PUNCTUATION_HEAD = new RegExp(`^${FULL_WIDTH_PUNCTUATION}`, 'u')
const FULL_WIDTH_PUNCTUATION_TAIL = new RegExp(`${FULL_WIDTH_PUNCTUATION}$`, 'u')
const CJK_SCRIPT_HEAD = new RegExp(`^(?:${CJK_SCRIPT})`, 'u')
const CJK_SCRIPT_TAIL = new RegExp(`(?:${CJK_SCRIPT})$`, 'u')

const SHORTCUT_MODIFIERS = ['ctrl', 'alt', 'shift', 'meta'] as const
type ShortcutModifier = (typeof SHORTCUT_MODIFIERS)[number]

const KEY_TOKEN_BY_CODE: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {
    Space: 'space',
    Backquote: 'backquote',
    Semicolon: 'semicolon',
    Period: 'period',
    Comma: 'comma',
    Minus: 'minus',
    Equal: 'equal',
    BracketLeft: 'bracketleft',
    BracketRight: 'bracketright',
    Backslash: 'backslash',
    Slash: 'slash',
    Quote: 'quote',
    IntlBackslash: 'intlbackslash',
    Enter: 'enter',
    Tab: 'tab',
    Backspace: 'backspace',
    Delete: 'delete',
    ArrowUp: 'arrowup',
    ArrowDown: 'arrowdown',
    ArrowLeft: 'arrowleft',
    ArrowRight: 'arrowright',
    Home: 'home',
    End: 'end',
    PageUp: 'pageup',
    PageDown: 'pagedown',
    Insert: 'insert',
  }
  for (let index = 1; index <= 12; index += 1) map[`F${index}`] = `f${index}`
  for (let index = 0; index < 26; index += 1) {
    const letter = String.fromCharCode(65 + index)
    map[`Key${letter}`] = letter.toLowerCase()
  }
  for (let index = 0; index <= 9; index += 1) map[`Digit${index}`] = String(index)
  return map
})()

const CODE_BY_KEY_TOKEN: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(KEY_TOKEN_BY_CODE).map(([code, token]) => [token, code]),
)

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
])

const remoteEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string().optional(),
      message: z.string().optional(),
    }).passthrough().optional(),
  }),
])

const earsSettingsSchema = z.object({
  asrBackend: z.string().default('web-speech'),
  webSpeechLanguage: z.string().default(''),
  localWhisperModel: z.string().default('tiny'),
  cloudAsrProvider: z.string().default('groq'),
  cloudAsrDeepgramService: z.string().default('recording-file'),
  cloudAsrTencentService: z.string().default('recording-file'),
  cloudAsrVolcengineService: z.string().default('recording-file'),
  maxRecordingSeconds: z.number().default(120),
  voiceShortcutEnabled: z.boolean().default(true),
  voiceShortcut: z.string().default('ctrl+shift+space'),
  polishingEnabled: z.boolean().default(true),
  polishProvider: z.string().default(''),
  polishModel: z.string().default(''),
  polishReasoningEffort: z.string().default(''),
}).passthrough()

const earsSettingsViewSchema = z.object({
  available: z.boolean(),
  settings: earsSettingsSchema,
}).passthrough()

const asrBackendInfoSchema = z.object({
  id: z.string(),
  available: z.boolean(),
  detail: z.string().optional(),
}).passthrough()

const whisperModelStateSchema = z.object({
  runtimeAvailable: z.boolean(),
  downloaded: z.boolean(),
  downloading: z.boolean(),
}).passthrough()

const remoteTextResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), text: z.string() }),
  z.object({ status: z.literal('error'), code: z.string().optional(), message: z.string().optional() }),
])

const realtimeSessionSchema = z.object({ sessionId: z.string().min(1) })
const realtimeTranscriptSchema = z.object({ text: z.string(), final: z.boolean().optional() })

type EarsSettings = z.infer<typeof earsSettingsSchema>
type AsrBackendInfo = z.infer<typeof asrBackendInfoSchema>
type WhisperModelState = z.infer<typeof whisperModelStateSchema>

export interface DshEarsRemotePort {
  getSettings(): Promise<unknown>
  listAsrBackends(): Promise<unknown>
  getWhisperModelState?(model: string): Promise<unknown>
  transcribe(audioBase64: string, mimeType: string, signal?: AbortSignal): Promise<unknown>
  startRealtime?(signal?: AbortSignal): Promise<unknown>
  sendRealtimeAudio?(sessionId: string, audioBase64: string, signal?: AbortSignal): Promise<unknown>
  finishRealtime?(sessionId: string, signal?: AbortSignal): Promise<unknown>
  cancelRealtime?(sessionId: string): Promise<unknown>
  polish(transcript: string, provider: string, model: string, reasoningEffort: string, signal?: AbortSignal): Promise<unknown>
}

interface RealtimeDshEarsRemotePort extends DshEarsRemotePort {
  startRealtime(signal?: AbortSignal): Promise<unknown>
  sendRealtimeAudio(sessionId: string, audioBase64: string, signal?: AbortSignal): Promise<unknown>
  finishRealtime(sessionId: string, signal?: AbortSignal): Promise<unknown>
  cancelRealtime(sessionId: string): Promise<unknown>
}

export interface SpeechRecognitionResultLike {
  readonly isFinal?: boolean
  readonly 0?: { readonly transcript?: string }
}

export interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onstart: (() => void) | null
  onresult: ((event: { readonly resultIndex: number; readonly results: ArrayLike<SpeechRecognitionResultLike> }) => void) | null
  onerror: ((event: { readonly error?: string; readonly message?: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

export interface AudioBufferLike {
  readonly sampleRate: number
  readonly length: number
  readonly numberOfChannels: number
  getChannelData(channel: number): Float32Array
}

export interface MediaCaptureHandle {
  start(): void
  stop(): Promise<{ base64: string; mimeType: string }>
  abort(): void
}

export interface RealtimeCaptureHandle {
  start(onChunk: (audioBase64: string) => Promise<void>): void
  stop(): Promise<void>
  abort(): void
}

export interface SurfaceVoiceBrowserDeps {
  createSpeechRecognition?: () => SpeechRecognitionLike | undefined
  isMediaRecorderAvailable?: () => boolean
  createMediaCapture?: () => Promise<MediaCaptureHandle>
  isRealtimeCaptureAvailable?: () => boolean
  createRealtimeCapture?: () => Promise<RealtimeCaptureHandle>
  decodeToWav?: (audio: { base64: string; mimeType: string }, signal: AbortSignal) => Promise<{ base64: string; mimeType: string }>
}

export interface SurfaceVoiceInputController extends WebSurfaceVoiceInput {
  dispose(): void
}

interface VoiceRemoteContainer {
  $on?: (event: string, listener: () => void) => () => void
  dshEars?: unknown
}

function isDshEarsRemote(value: unknown): value is DshEarsRemotePort {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.getSettings === 'function'
    && typeof record.listAsrBackends === 'function'
    && typeof record.transcribe === 'function'
    && typeof record.polish === 'function'
}

function supportsRealtimeRemote(remote: DshEarsRemotePort | undefined): remote is RealtimeDshEarsRemotePort {
  return remote !== undefined
    && typeof remote.startRealtime === 'function'
    && typeof remote.sendRealtimeAudio === 'function'
    && typeof remote.finishRealtime === 'function'
    && typeof remote.cancelRealtime === 'function'
}

/** Join speech segments inserting spaces only where the writing system expects one. */
export function joinVoiceText(current: string, next: string): string {
  if (next === '') return current
  if (current === '') return next
  if (/\s$/.test(current) || /^\s/.test(next)) return current + next
  if (FULL_WIDTH_PUNCTUATION_TAIL.test(current) || FULL_WIDTH_PUNCTUATION_HEAD.test(next)) return current + next
  if (CJK_SCRIPT_TAIL.test(current) && CJK_SCRIPT_HEAD.test(next)) return current + next
  return `${current} ${next}`
}

/** Encode an AudioBuffer-like source into mono 16 kHz 16-bit PCM WAV bytes. */
export function encodePcm16Wav(input: AudioBufferLike): Uint8Array {
  if (!Number.isFinite(input.sampleRate) || input.sampleRate <= 0) {
    throw new RangeError('Audio sample rate must be positive')
  }
  const channels: Float32Array[] = []
  for (let index = 0; index < input.numberOfChannels; index += 1) {
    channels.push(input.getChannelData(index))
  }
  const frameCount = input.length
  const outputFrames = frameCount === 0 ? 0 : Math.max(1, Math.round(frameCount * WHISPER_SAMPLE_RATE / input.sampleRate))
  const wav = new Uint8Array(44 + outputFrames * 2)
  const view = new DataView(wav.buffer)
  writeAscii(wav, 0, 'RIFF')
  view.setUint32(4, 36 + outputFrames * 2, true)
  writeAscii(wav, 8, 'WAVE')
  writeAscii(wav, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, WHISPER_SAMPLE_RATE, true)
  view.setUint32(28, WHISPER_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(wav, 36, 'data')
  view.setUint32(40, outputFrames * 2, true)

  const monoAt = (frame: number): number => {
    if (channels.length === 0) return 0
    let sum = 0
    for (const channel of channels) {
      const value = channel[frame] ?? 0
      sum += Number.isFinite(value) ? value : 0
    }
    const average = sum / channels.length
    return average <= -1 ? -1 : average >= 1 ? 1 : average
  }

  for (let frame = 0; frame < outputFrames; frame += 1) {
    let sample: number
    if (frameCount === 1 || outputFrames === 1) {
      sample = monoAt(0)
    } else if (input.sampleRate === WHISPER_SAMPLE_RATE && frame < frameCount) {
      sample = monoAt(frame)
    } else {
      const position = frame * (frameCount - 1) / (outputFrames - 1)
      const lower = Math.floor(position)
      const upper = Math.min(frameCount - 1, lower + 1)
      const fraction = position - lower
      sample = monoAt(lower) + (monoAt(upper) - monoAt(lower)) * fraction
    }
    const clamped = sample <= -1 ? -1 : sample >= 1 ? 1 : sample
    view.setInt16(44 + frame * 2, clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff), true)
  }
  return wav
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) target[offset + index] = text.charCodeAt(index)
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

function base64ByteLength(base64: string): number {
  const trimmed = base64.trim()
  if (trimmed === '') return 0
  const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

type ShortcutKeyboardEventLike = Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'code' | 'key'> & {
  getModifierState?: (key: string) => boolean
}

function modifiersFromKeyboardEvent(event: ShortcutKeyboardEventLike, fromModifierKey: boolean): Set<ShortcutModifier> {
  const held = new Set<ShortcutModifier>()
  if (event.ctrlKey || event.getModifierState?.('Control') === true
    || (fromModifierKey && (event.key === 'Control' || event.code === 'ControlLeft' || event.code === 'ControlRight'))) {
    held.add('ctrl')
  }
  if (event.altKey || event.getModifierState?.('Alt') === true
    || (fromModifierKey && (event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight'))) {
    held.add('alt')
  }
  if (event.shiftKey || event.getModifierState?.('Shift') === true
    || (fromModifierKey && (event.key === 'Shift' || event.code === 'ShiftLeft' || event.code === 'ShiftRight'))) {
    held.add('shift')
  }
  if (event.metaKey || event.getModifierState?.('Meta') === true
    || (fromModifierKey && (event.key === 'Meta' || event.code === 'MetaLeft' || event.code === 'MetaRight'))) {
    held.add('meta')
  }
  return held
}

/** Match a dsh-ears canonical shortcut string (including modifier-only chords) against a KeyboardEvent. */
export function matchesVoiceShortcut(
  chord: string,
  event: ShortcutKeyboardEventLike,
): boolean {
  if (typeof chord !== 'string' || chord.trim() === '' || chord.length > SHORTCUT_MAX_LENGTH) return false
  const tokens = chord.trim().toLowerCase().split('+').filter(token => token !== '')
  if (tokens.length === 0) return false
  const isModifier = (token: string): token is ShortcutModifier =>
    (SHORTCUT_MODIFIERS as readonly string[]).includes(token)
  const modifierKey = MODIFIER_CODES.has(event.code)
  const modifiers = new Set<ShortcutModifier>()
  if (tokens.every(isModifier)) {
    if (!modifierKey) return false
    for (const token of tokens) modifiers.add(token)
  } else {
    const keyToken = tokens[tokens.length - 1]
    if (keyToken === undefined || !(keyToken in CODE_BY_KEY_TOKEN)) return false
    for (const token of tokens.slice(0, -1)) {
      if (!isModifier(token)) return false
      modifiers.add(token)
    }
    const eventToken = KEY_TOKEN_BY_CODE[event.code] ?? (event.key === ' ' ? 'space' : event.key.toLowerCase())
    if (eventToken !== keyToken) return false
  }
  const held = modifiersFromKeyboardEvent(event, modifierKey)
  return SHORTCUT_MODIFIERS.every(modifier => held.has(modifier) === modifiers.has(modifier))
}

function isCloudRealtime(settings: EarsSettings): boolean {
  if (settings.asrBackend !== 'cloud-openai') return false
  if (settings.cloudAsrProvider === 'deepgram') return settings.cloudAsrDeepgramService === 'realtime'
  if (settings.cloudAsrProvider === 'tencent') return settings.cloudAsrTencentService === 'realtime'
  if (settings.cloudAsrProvider === 'volcengine') return settings.cloudAsrVolcengineService === 'realtime'
  return false
}

function needsWavConversion(settings: EarsSettings): boolean {
  if (settings.asrBackend === 'local-whisper') return true
  return settings.asrBackend === 'cloud-openai'
    && (settings.cloudAsrProvider === 'tencent' || settings.cloudAsrProvider === 'mimo' || settings.cloudAsrProvider === 'volcengine')
}

function effectiveMaxSeconds(settings: EarsSettings): number {
  const configured = Number.isFinite(settings.maxRecordingSeconds) && settings.maxRecordingSeconds > 0
    ? Math.min(600, Math.max(1, settings.maxRecordingSeconds))
    : 120
  if (settings.asrBackend === 'cloud-openai' && settings.cloudAsrProvider === 'bailian') {
    return Math.min(configured, BAILIAN_MAX_RECORDING_SECONDS)
  }
  return configured
}

function effectiveSpeechLanguage(configured: string, locale: 'zh-CN' | 'en-US'): string {
  const trimmed = configured.trim()
  return trimmed !== '' ? trimmed : locale
}

function collapseDraft(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function shouldApplyPolish(current: string, expected: string, base: string): boolean {
  const normalizedCurrent = collapseDraft(current)
  return normalizedCurrent === collapseDraft(expected)
    || (base.trim() !== '' && normalizedCurrent === collapseDraft(base))
}

function unwrapRemoteResult(raw: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  const parsed = remoteEnvelopeSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, message: '语音服务返回了无法识别的响应' }
  if (!parsed.data.ok) {
    return { ok: false, message: parsed.data.error?.message?.trim() || '语音服务请求失败' }
  }
  return { ok: true, value: parsed.data.value }
}

function extractRemoteText(raw: unknown): { ok: true; text: string } | { ok: false } {
  const envelope = unwrapRemoteResult(raw)
  if (!envelope.ok) return { ok: false }
  const parsed = remoteTextResultSchema.safeParse(envelope.value)
  if (!parsed.success || parsed.data.status === 'error') return { ok: false }
  return { ok: true, text: parsed.data.text }
}

function applyLiveDraft(
  target: WebSurfaceVoiceTarget,
  state: { baseDraft: string; sessionDraft: string },
  text: string,
): void {
  const currentDraft = target.getDraft()
  if (currentDraft !== state.sessionDraft) {
    if (currentDraft.trim() !== '') return
    state.baseDraft = ''
  }
  state.sessionDraft = joinVoiceText(state.baseDraft, text)
  target.setDraft(state.sessionDraft)
}

function isEventInsideDialog(event: KeyboardEvent): boolean {
  if (typeof Element === 'undefined') return false
  if (typeof event.composedPath === 'function') {
    for (const node of event.composedPath()) {
      if (node instanceof Element && (node.matches('[role="dialog"]') || node.closest('[role="dialog"]') !== null)) {
        return true
      }
    }
  }
  return event.target instanceof Element && event.target.closest('[role="dialog"]') !== null
}

const HOST_VOICE_BUTTON_IDLE_SELECTOR = '[data-slot="conversation.input.right"] button[data-state][aria-pressed="false"]'
const HOST_VOICE_ACTIVE_SELECTOR = [
  '[data-phase="visible"][data-state="starting"]',
  '[data-phase="visible"][data-state="recording"]',
  '[data-slot="conversation.input.right"] button[data-state="starting"][aria-pressed="true"]',
  '[data-slot="conversation.input.right"] button[data-state="recording"][aria-pressed="true"]',
].join(', ')

function isHostVoiceRecording(): boolean {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return false
  return document.querySelector(HOST_VOICE_ACTIVE_SELECTOR) !== null
}

function findIdleHostVoiceButton(event: Event): HTMLButtonElement | null {
  if (typeof Element === 'undefined') return null
  const matchNode = (node: EventTarget | null | undefined): HTMLButtonElement | null => {
    if (!(node instanceof Element)) return null
    return node.closest<HTMLButtonElement>(HOST_VOICE_BUTTON_IDLE_SELECTOR)
  }
  if (typeof event.composedPath === 'function') {
    for (const node of event.composedPath()) {
      const found = matchNode(node)
      if (found !== null) return found
    }
  }
  return matchNode(event.target)
}

function getSpeechConstructor(): (new () => SpeechRecognitionLike) | undefined {
  if (typeof window === 'undefined') return undefined
  const scope = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition
}

function getAudioContextConstructor(): (new () => AudioContext) | undefined {
  if (typeof globalThis === 'undefined') return undefined
  const scope = globalThis as unknown as {
    AudioContext?: new () => AudioContext
    webkitAudioContext?: new () => AudioContext
  }
  return scope.AudioContext ?? scope.webkitAudioContext
}

function supportedRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const mime of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  return ''
}

async function createBrowserMediaCapture(): Promise<MediaCaptureHandle> {
  if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function' || typeof MediaRecorder === 'undefined') {
    throw new Error('当前浏览器不支持麦克风录音')
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const mimeType = supportedRecorderMimeType()
  let recorder: MediaRecorder
  try {
    recorder = mimeType === '' ? new MediaRecorder(stream) : new MediaRecorder(stream, { mimeType })
  } catch (error) {
    for (const track of stream.getTracks()) track.stop()
    throw error
  }
  const chunks: Blob[] = []
  let aborted = false
  let stopPromise: Promise<{ base64: string; mimeType: string }> | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  recorder.addEventListener('dataavailable', event => {
    if (event.data.size > 0) chunks.push(event.data)
  })
  const stopTracks = () => {
    for (const track of stream.getTracks()) track.stop()
  }
  const finish = async (): Promise<{ base64: string; mimeType: string }> => {
    try {
      if (aborted) throw new DOMException('Recording aborted', 'AbortError')
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (aborted) throw new DOMException('Recording aborted', 'AbortError')
      return { base64: bytesToBase64(bytes), mimeType: blob.type }
    } finally {
      chunks.length = 0
      stopTracks()
    }
  }
  return {
    start() {
      recorder.start(1_000)
    },
    stop() {
      if (aborted) return Promise.reject(new DOMException('Recording aborted', 'AbortError'))
      if (stopPromise !== undefined) return stopPromise
      if (recorder.state === 'inactive') {
        stopPromise = finish()
        return stopPromise
      }
      stopPromise = new Promise((resolve, reject) => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          if (stopTimer !== undefined) clearTimeout(stopTimer)
          recorder.removeEventListener('stop', done)
          recorder.removeEventListener('error', onError)
          void finish().then(resolve, reject)
        }
        const onError = () => {
          if (settled) return
          settled = true
          if (stopTimer !== undefined) clearTimeout(stopTimer)
          recorder.removeEventListener('stop', done)
          recorder.removeEventListener('error', onError)
          chunks.length = 0
          stopTracks()
          reject(new Error('录音失败'))
        }
        recorder.addEventListener('stop', done)
        recorder.addEventListener('error', onError)
        stopTimer = setTimeout(done, MEDIA_STOP_FALLBACK_MS)
        try {
          recorder.stop()
        } catch (error) {
          onError()
          void error
        }
      })
      return stopPromise
    },
    abort() {
      if (aborted) return
      aborted = true
      if (stopTimer !== undefined) clearTimeout(stopTimer)
      if (recorder.state !== 'inactive') {
        try { recorder.stop() } catch { /* ignore */ }
      }
      chunks.length = 0
      stopTracks()
    },
  }
}

async function createBrowserRealtimeCapture(): Promise<RealtimeCaptureHandle> {
  const Constructor = getAudioContextConstructor()
  if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function' || Constructor === undefined) {
    throw new Error('当前浏览器不支持实时音频采集')
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  let context: AudioContext
  try {
    context = new Constructor()
    await context.resume()
  } catch (error) {
    for (const track of stream.getTracks()) track.stop()
    throw error
  }
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(REALTIME_BUFFER_SIZE, 1, 1)
  const sink = context.createGain()
  sink.gain.value = 0
  source.connect(processor)
  processor.connect(sink)
  sink.connect(context.destination)

  let closed = false
  let pendingPcm = new Uint8Array()
  let queue = Promise.resolve()
  let failure: unknown
  let onChunkRef: ((audioBase64: string) => Promise<void>) | undefined
  let generation = 0

  const enqueueChunk = (callback: (audioBase64: string) => Promise<void>, pcm: Uint8Array) => {
    const currentGen = generation
    queue = queue.then(async () => {
      if (currentGen !== generation || failure !== undefined) return
      await callback(bytesToBase64(pcm))
    }).catch(error => {
      failure ??= error
    })
  }

  processor.onaudioprocess = event => {
    if (closed || onChunkRef === undefined) return
    const input = event.inputBuffer
    const wav = encodePcm16Wav(input)
    const pcm = wav.subarray(44)
    if (pcm.byteLength === 0) return
    const combined = new Uint8Array(pendingPcm.byteLength + pcm.byteLength)
    combined.set(pendingPcm)
    combined.set(pcm, pendingPcm.byteLength)
    let offset = 0
    while (combined.byteLength - offset >= REALTIME_CHUNK_BYTES) {
      enqueueChunk(onChunkRef, combined.subarray(offset, offset + REALTIME_CHUNK_BYTES))
      offset += REALTIME_CHUNK_BYTES
    }
    pendingPcm = combined.slice(offset)
  }

  const teardown = () => {
    processor.onaudioprocess = null
    source.disconnect()
    processor.disconnect()
    sink.disconnect()
    for (const track of stream.getTracks()) track.stop()
  }

  return {
    start(onChunk) {
      if (closed) throw new Error('实时采集已关闭')
      onChunkRef = onChunk
    },
    async stop() {
      if (closed) return
      const callback = onChunkRef
      closed = true
      onChunkRef = undefined
      if (callback !== undefined && pendingPcm.byteLength > 0) {
        enqueueChunk(callback, pendingPcm)
        pendingPcm = new Uint8Array()
      }
      teardown()
      try {
        await queue
        if (failure !== undefined) throw failure
      } finally {
        await context.close().catch(() => undefined)
      }
    },
    abort() {
      generation += 1
      if (closed) return
      closed = true
      onChunkRef = undefined
      pendingPcm = new Uint8Array()
      teardown()
      void context.close().catch(() => undefined)
    },
  }
}

async function decodeBrowserAudioToWav(
  audio: { base64: string; mimeType: string },
  signal: AbortSignal,
): Promise<{ base64: string; mimeType: string }> {
  signal.throwIfAborted()
  const Constructor = getAudioContextConstructor()
  if (Constructor === undefined) throw new Error('当前浏览器不支持音频解码')
  const context = new Constructor()
  try {
    const decoded = await context.decodeAudioData(base64ToArrayBuffer(audio.base64))
    signal.throwIfAborted()
    const wav = encodePcm16Wav(decoded)
    signal.throwIfAborted()
    return { base64: bytesToBase64(wav), mimeType: 'audio/wav' }
  } finally {
    await context.close().catch(() => undefined)
  }
}

function defaultSettings(): EarsSettings {
  return earsSettingsSchema.parse({})
}

function resolveUnavailableReason(
  settings: EarsSettings,
  backends: readonly AsrBackendInfo[],
  whisperState: WhisperModelState | undefined,
  browser: { webSpeech: boolean; mediaRecorder: boolean; realtimeCapture: boolean; realtimeRemote: boolean },
  chinese: boolean,
): string | undefined {
  if (settings.asrBackend === 'web-speech') {
    if (!browser.webSpeech) {
      return chinese ? '当前浏览器不支持 Web Speech，请在 DSH 设置 → dsh-ears 切换识别后端' : 'Web Speech is unavailable in this browser. Switch backend in DSH Settings → dsh-ears.'
    }
    return undefined
  }
  if (settings.asrBackend === 'local-whisper') {
    if (!browser.mediaRecorder) {
      return chinese ? '当前浏览器不支持麦克风录音' : 'Microphone recording is unavailable in this browser.'
    }
    if (whisperState !== undefined && !whisperState.runtimeAvailable) {
      return chinese ? '本地 Whisper 运行时不可用，请检查 DSH 设置 → dsh-ears' : 'Local Whisper runtime is unavailable. Check DSH Settings → dsh-ears.'
    }
    if (whisperState !== undefined && !whisperState.downloaded) {
      return chinese ? '请先在 DSH 设置 → dsh-ears 下载 Whisper 模型' : 'Download a Whisper model in DSH Settings → dsh-ears first.'
    }
    const info = backends.find(item => item.id === 'local-whisper')
    if (info !== undefined && !info.available) {
      return chinese ? '本地 Whisper 尚未就绪，请在 DSH 设置 → dsh-ears 检查配置' : 'Local Whisper is not ready. Check DSH Settings → dsh-ears.'
    }
    return undefined
  }
  if (settings.asrBackend === 'cloud-openai') {
    if (isCloudRealtime(settings) && !browser.realtimeRemote) {
      return chinese ? '当前 dsh-ears 版本不支持实时语音识别接口' : 'Installed dsh-ears does not support realtime ASR RPC.'
    }
    if (isCloudRealtime(settings) ? !browser.realtimeCapture : !browser.mediaRecorder) {
      return chinese ? '当前浏览器不支持麦克风录音' : 'Microphone recording is unavailable in this browser.'
    }
    const info = backends.find(item => item.id === 'cloud-openai')
    if (info !== undefined && !info.available) {
      return chinese ? '请先在 DSH 设置 → dsh-ears 填写语音识别 API 凭据' : 'Configure ASR credentials in DSH Settings → dsh-ears first.'
    }
    return undefined
  }
  return chinese ? '不支持的语音识别后端，请在 DSH 设置 → dsh-ears 重新选择' : 'Unsupported ASR backend. Re-select in DSH Settings → dsh-ears.'
}

/**
 * Bridge the host `dsh-ears` plugin into ClinMesh's outpatient consultation composer.
 * Uses optional `remote.dshEars` so disabling or delaying `dsh-ears` never blocks Surface mount.
 */
export function createSurfaceVoiceInput(
  ctx: ClientContext,
  deps: SurfaceVoiceBrowserDeps = {},
): SurfaceVoiceInputController {
  const listeners = new Set<() => void>()
  const shortcutHandlers = new Set<WebSurfaceVoiceShortcutContext>()

  let disposed = false
  let earsRemote: DshEarsRemotePort | undefined
  let settings: EarsSettings = defaultSettings()
  let settingsLoaded = false
  let settingsAvailable = true
  let backends: readonly AsrBackendInfo[] = []
  let whisperState: WhisperModelState | undefined
  let phase: WebSurfaceVoicePhase = 'idle'
  let errorText: string | undefined
  let epoch = 0
  let refreshInFlight: Promise<void> | undefined
  let refreshQueued = false

  let activeTarget: WebSurfaceVoiceTarget | undefined
  let speechSession: SpeechRecognitionLike | undefined
  let stopSpeechSession: (() => void) | undefined
  let speechStopTimer: ReturnType<typeof setTimeout> | undefined
  let mediaHandle: MediaCaptureHandle | undefined
  let mediaStopping = false
  let mediaBaseDraft = ''
  let mediaStartedAt = 0
  let mediaSettingsSnapshot: EarsSettings | undefined
  let realtimeHandle: RealtimeCaptureHandle | undefined
  let realtimeStopping = false
  let realtimeSessionId: string | undefined
  let realtimeStreamAbort: AbortController | undefined
  let realtimeDraftState = { baseDraft: '', sessionDraft: '' }
  let realtimeSettingsSnapshot: EarsSettings | undefined
  let activeAbort: AbortController | undefined
  let maxDurationTimer: ReturnType<typeof setTimeout> | undefined

  const getLocale = (): 'zh-CN' | 'en-US' => {
    try {
      const locale = ctx.get('locale') as unknown as ClientLocalePort | undefined
      return normalizeHostLocale(locale?.getLocale?.().active)
    } catch {
      return 'zh-CN'
    }
  }

  const readRemote = (): DshEarsRemotePort | undefined => {
    if (earsRemote !== undefined) return earsRemote
    try {
      const direct = ctx.get('remote.dshEars' as never) as unknown
      if (isDshEarsRemote(direct)) {
        earsRemote = direct
        return earsRemote
      }
    } catch { /* optional service */ }
    try {
      const container = ctx.get('remote') as unknown as VoiceRemoteContainer | undefined
      if (isDshEarsRemote(container?.dshEars)) {
        earsRemote = container.dshEars
        return earsRemote
      }
    } catch { /* optional service */ }
    return undefined
  }

  const browserCaps = () => ({
    webSpeech: deps.createSpeechRecognition !== undefined || getSpeechConstructor() !== undefined,
    mediaRecorder: deps.isMediaRecorderAvailable?.()
      ?? (typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof MediaRecorder !== 'undefined'),
    realtimeCapture: deps.isRealtimeCaptureAvailable?.()
      ?? (typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function' && getAudioContextConstructor() !== undefined),
    realtimeRemote: supportsRealtimeRemote(readRemote()),
  })

  const buildSnapshot = (): WebSurfaceVoiceSnapshot => {
    const installed = readRemote() !== undefined
    const chinese = getLocale() === 'zh-CN'
    const unavailableReason = !installed
      ? undefined
      : !settingsAvailable
        ? (chinese ? '语音设置暂不可用，请稍后重试或检查 DSH 设置 → dsh-ears' : 'Voice settings are temporarily unavailable. Retry or check DSH Settings → dsh-ears.')
        : settingsLoaded
          ? resolveUnavailableReason(settings, backends, whisperState, browserCaps(), chinese)
          : undefined
    return {
      installed,
      ready: installed && settingsAvailable && settingsLoaded && unavailableReason === undefined,
      phase,
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
      ...(errorText === undefined ? {} : { error: errorText }),
      shortcutEnabled: settings.voiceShortcutEnabled,
      shortcut: settings.voiceShortcut,
    }
  }

  let snapshot: WebSurfaceVoiceSnapshot = buildSnapshot()

  const emit = () => {
    const next = buildSnapshot()
    if (
      next.installed === snapshot.installed
      && next.ready === snapshot.ready
      && next.phase === snapshot.phase
      && next.unavailableReason === snapshot.unavailableReason
      && next.error === snapshot.error
      && next.shortcutEnabled === snapshot.shortcutEnabled
      && next.shortcut === snapshot.shortcut
    ) {
      return
    }
    snapshot = next
    for (const listener of listeners) listener()
  }

  const setPhase = (nextPhase: WebSurfaceVoicePhase, nextError?: string) => {
    phase = nextPhase
    errorText = nextError
    emit()
  }

  const clearTimers = () => {
    if (maxDurationTimer !== undefined) {
      clearTimeout(maxDurationTimer)
      maxDurationTimer = undefined
    }
    if (speechStopTimer !== undefined) {
      clearTimeout(speechStopTimer)
      speechStopTimer = undefined
    }
  }

  const armMaxDuration = (seconds: number) => {
    if (maxDurationTimer !== undefined) clearTimeout(maxDurationTimer)
    maxDurationTimer = setTimeout(() => {
      maxDurationTimer = undefined
      stop()
    }, seconds * 1_000)
  }

  const teardownActiveCapture = (cancelRemoteRealtime: boolean) => {
    clearTimers()
    activeAbort?.abort()
    activeAbort = undefined
    realtimeStreamAbort?.abort()
    realtimeStreamAbort = undefined
    if (speechSession !== undefined) {
      const session = speechSession
      speechSession = undefined
      stopSpeechSession = undefined
      session.onstart = null
      session.onresult = null
      session.onerror = null
      session.onend = null
      try { session.abort() } catch { /* ignore */ }
    }
    if (mediaHandle !== undefined) {
      const handle = mediaHandle
      mediaHandle = undefined
      mediaStopping = false
      handle.abort()
    }
    if (realtimeHandle !== undefined) {
      const handle = realtimeHandle
      realtimeHandle = undefined
      realtimeStopping = false
      handle.abort()
    }
    if (cancelRemoteRealtime && realtimeSessionId !== undefined) {
      const id = realtimeSessionId
      realtimeSessionId = undefined
      const remote = readRemote()
      if (typeof remote?.cancelRealtime === 'function') {
        void remote.cancelRealtime(id).catch(() => undefined)
      }
    } else if (!cancelRemoteRealtime) {
      realtimeSessionId = undefined
    }
    mediaSettingsSnapshot = undefined
    realtimeSettingsSnapshot = undefined
  }

  const failVoice = (message: string, capturedEpoch: number) => {
    if (disposed || epoch !== capturedEpoch) return
    setPhase('error', message)
  }

  const runPolish = async (
    target: WebSurfaceVoiceTarget,
    transcript: string,
    baseDraft: string,
    expectedDraft: string,
    currentSettings: EarsSettings,
    capturedEpoch: number,
  ) => {
    const remote = readRemote()
    if (!currentSettings.polishingEnabled || remote === undefined) {
      if (!disposed && epoch === capturedEpoch) setPhase('idle')
      return
    }
    const controller = new AbortController()
    activeAbort = controller
    setPhase('polishing')
    try {
      const raw = await remote.polish(
        transcript,
        currentSettings.polishProvider,
        currentSettings.polishModel,
        currentSettings.polishReasoningEffort,
        controller.signal,
      )
      if (disposed || controller.signal.aborted || epoch !== capturedEpoch) return
      if (!shouldApplyPolish(target.getDraft(), expectedDraft, baseDraft)) {
        setPhase('idle')
        return
      }
      const extracted = extractRemoteText(raw)
      if (!extracted.ok) {
        failVoice(getLocale() === 'zh-CN' ? '润色失败，已保留原始转写文本' : 'Polishing failed; raw transcript kept.', capturedEpoch)
        return
      }
      const polished = extracted.text.trim() !== '' ? extracted.text.trim() : transcript
      target.setDraft(joinVoiceText(baseDraft, polished))
      setPhase('idle')
    } catch {
      if (disposed || controller.signal.aborted || epoch !== capturedEpoch) return
      failVoice(getLocale() === 'zh-CN' ? '润色失败，已保留原始转写文本' : 'Polishing failed; raw transcript kept.', capturedEpoch)
    } finally {
      if (activeAbort === controller) activeAbort = undefined
    }
  }

  const commitTranscript = (
    target: WebSurfaceVoiceTarget,
    transcript: string,
    baseDraft: string,
    expectedDraft: string,
    alreadyApplied: boolean,
    currentSettings: EarsSettings,
    capturedEpoch: number,
  ) => {
    if (disposed || epoch !== capturedEpoch) return
    const trimmed = transcript.trim()
    if (trimmed === '') {
      setPhase('idle')
      return
    }
    let appliedDraft = expectedDraft
    if (!alreadyApplied) {
      appliedDraft = joinVoiceText(baseDraft, trimmed)
      target.setDraft(appliedDraft)
    }
    void runPolish(target, trimmed, baseDraft, appliedDraft, currentSettings, capturedEpoch)
  }

  const refreshAsync = async (): Promise<void> => {
    const remote = readRemote()
    if (remote === undefined || disposed) {
      emit()
      return
    }
    try {
      const [rawSettings, rawBackends] = await Promise.all([
        remote.getSettings(),
        remote.listAsrBackends(),
      ])
      if (disposed) return
      const unwrappedSettings = unwrapRemoteResult(rawSettings)
      if (unwrappedSettings.ok) {
        const parsed = earsSettingsViewSchema.safeParse(unwrappedSettings.value)
        if (parsed.success) {
          if (parsed.data.available) {
            settings = parsed.data.settings
            settingsAvailable = true
            settingsLoaded = true
          } else {
            // Do not adopt fallback settings (e.g. web-speech) when host settings are unavailable.
            settingsAvailable = false
            settingsLoaded = false
            whisperState = undefined
          }
        }
      }
      const unwrappedBackends = unwrapRemoteResult(rawBackends)
      if (unwrappedBackends.ok) {
        const parsed = z.array(asrBackendInfoSchema).safeParse(unwrappedBackends.value)
        if (parsed.success) backends = parsed.data
      }
      if (settingsAvailable && settingsLoaded && settings.asrBackend === 'local-whisper' && typeof remote.getWhisperModelState === 'function') {
        const rawWhisper = await remote.getWhisperModelState(settings.localWhisperModel)
        if (disposed) return
        const unwrappedWhisper = unwrapRemoteResult(rawWhisper)
        if (unwrappedWhisper.ok) {
          const parsed = whisperModelStateSchema.safeParse(unwrappedWhisper.value)
          if (parsed.success) whisperState = parsed.data
        }
      } else {
        whisperState = undefined
      }
    } catch {
      // Keep the latest known snapshot; retry on next focus/settings event.
    } finally {
      emit()
    }
  }

  const refresh = () => {
    if (disposed) return
    if (refreshInFlight !== undefined) {
      refreshQueued = true
      return
    }
    const task = refreshAsync().finally(() => {
      if (refreshInFlight === task) refreshInFlight = undefined
      if (refreshQueued && !disposed) {
        refreshQueued = false
        refresh()
      }
    })
    refreshInFlight = task
  }

  const startWebSpeech = (target: WebSurfaceVoiceTarget, currentSettings: EarsSettings, capturedEpoch: number) => {
    const recognition = deps.createSpeechRecognition !== undefined
      ? deps.createSpeechRecognition()
      : (() => {
          const Constructor = getSpeechConstructor()
          return Constructor === undefined ? undefined : new Constructor()
        })()
    if (recognition === undefined) {
      failVoice(getLocale() === 'zh-CN' ? '当前浏览器不支持 Web Speech 语音识别' : 'Web Speech is unavailable in this browser.', capturedEpoch)
      return
    }
    const initialDraft = target.getDraft()
    const draftState = { baseDraft: initialDraft, sessionDraft: initialDraft }
    let finalText = ''
    let lastHeard = ''
    let failed = false
    let stopping = false
    let ended = false

    const updateLive = (heard: string) => {
      if (disposed || epoch !== capturedEpoch || ended) return
      applyLiveDraft(target, draftState, heard)
    }

    const finishSpeech = () => {
      if (ended) return
      ended = true
      clearTimers()
      if (speechSession === recognition) {
        speechSession = undefined
        stopSpeechSession = undefined
      }
      if (disposed || epoch !== capturedEpoch || failed) return
      const transcript = (finalText !== '' ? finalText : lastHeard).trim()
      if (transcript === '') {
        setPhase('idle')
        return
      }
      commitTranscript(target, transcript, draftState.baseDraft, draftState.sessionDraft, true, currentSettings, capturedEpoch)
    }

    recognition.lang = effectiveSpeechLanguage(currentSettings.webSpeechLanguage, getLocale())
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.onresult = event => {
      if (ended || disposed || epoch !== capturedEpoch) return
      let finalChunk = ''
      let interimChunk = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const text = result?.[0]?.transcript ?? ''
        if (result?.isFinal === true) finalChunk = joinVoiceText(finalChunk, text)
        else interimChunk = joinVoiceText(interimChunk, text)
      }
      if (finalChunk !== '') {
        finalText = joinVoiceText(finalText, finalChunk)
        lastHeard = finalText
        updateLive(finalText)
      }
      const heard = joinVoiceText(finalText, interimChunk)
      if (heard !== '') {
        lastHeard = heard
        updateLive(heard)
      }
    }
    recognition.onerror = event => {
      if (stopping || ended || disposed || epoch !== capturedEpoch) return
      failed = true
      const reason = event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? (getLocale() === 'zh-CN' ? '麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问' : 'Microphone permission denied.')
        : (getLocale() === 'zh-CN' ? '语音识别失败，请检查网络或在 DSH 设置 → dsh-ears 切换识别后端' : 'Speech recognition failed. Check network or switch backend in DSH Settings → dsh-ears.')
      failVoice(reason, capturedEpoch)
      try { recognition.abort() } catch { /* ignore */ }
      finishSpeech()
    }
    recognition.onend = () => {
      if (ended || disposed || epoch !== capturedEpoch) return
      if (!stopping && !failed) {
        try {
          recognition.start()
          return
        } catch {
          // Fall through to finish with captured speech.
        }
      }
      finishSpeech()
    }

    speechSession = recognition
    stopSpeechSession = () => {
      if (stopping || ended) return
      stopping = true
      speechStopTimer = setTimeout(() => {
        speechStopTimer = undefined
        if (ended) return
        try { recognition.abort() } catch { /* ignore */ }
        finishSpeech()
      }, SPEECH_STOP_FALLBACK_MS)
      try {
        recognition.stop()
      } catch {
        finishSpeech()
      }
    }
    setPhase('recording')
    armMaxDuration(effectiveMaxSeconds(currentSettings))
    try {
      recognition.start()
    } catch {
      failed = true
      speechSession = undefined
      stopSpeechSession = undefined
      clearTimers()
      failVoice(getLocale() === 'zh-CN' ? '无法启动浏览器语音识别' : 'Could not start speech recognition.', capturedEpoch)
    }
  }

  const startMediaRecording = async (target: WebSurfaceVoiceTarget, currentSettings: EarsSettings, capturedEpoch: number) => {
    setPhase('starting')
    let handle: MediaCaptureHandle | undefined
    try {
      handle = await (deps.createMediaCapture ?? createBrowserMediaCapture)()
      if (disposed || epoch !== capturedEpoch) {
        handle.abort()
        return
      }
      if (isHostVoiceRecording()) {
        handle.abort()
        failVoice(
          getLocale() === 'zh-CN'
            ? '右侧会话正在录音，请先停止后再启动问诊语音'
            : 'Stop the right-hand conversation recording before starting consultation voice.',
          capturedEpoch,
        )
        return
      }
      mediaHandle = handle
      mediaBaseDraft = target.getDraft()
      mediaStartedAt = Date.now()
      mediaSettingsSnapshot = currentSettings
      handle.start()
      setPhase('recording')
      armMaxDuration(effectiveMaxSeconds(currentSettings))
    } catch {
      handle?.abort()
      if (disposed || epoch !== capturedEpoch) return
      failVoice(getLocale() === 'zh-CN' ? '无法启动麦克风录音，请检查浏览器麦克风权限' : 'Could not start microphone recording. Check browser permissions.', capturedEpoch)
    }
  }

  const startRealtimeRecording = async (target: WebSurfaceVoiceTarget, currentSettings: EarsSettings, capturedEpoch: number) => {
    const remote = readRemote()
    if (!supportsRealtimeRemote(remote)) {
      failVoice(getLocale() === 'zh-CN' ? 'dsh-ears 实时语音接口不可用' : 'dsh-ears realtime ASR RPC is unavailable.', capturedEpoch)
      return
    }
    setPhase('starting')
    const controller = new AbortController()
    activeAbort = controller
    let sessionId: string | undefined
    let handle: RealtimeCaptureHandle | undefined
    try {
      const started = unwrapRemoteResult(await remote.startRealtime(controller.signal))
      if (!started.ok) throw new Error(started.message)
      const parsed = realtimeSessionSchema.parse(started.value)
      sessionId = parsed.sessionId
      if (disposed || controller.signal.aborted || epoch !== capturedEpoch) {
        void remote.cancelRealtime(sessionId).catch(() => undefined)
        return
      }
      handle = await (deps.createRealtimeCapture ?? createBrowserRealtimeCapture)()
      if (disposed || controller.signal.aborted || epoch !== capturedEpoch) {
        handle.abort()
        void remote.cancelRealtime(sessionId).catch(() => undefined)
        return
      }
      if (isHostVoiceRecording()) {
        handle.abort()
        void remote.cancelRealtime(sessionId).catch(() => undefined)
        if (activeAbort === controller) activeAbort = undefined
        failVoice(
          getLocale() === 'zh-CN'
            ? '右侧会话正在录音，请先停止后再启动问诊语音'
            : 'Stop the right-hand conversation recording before starting consultation voice.',
          capturedEpoch,
        )
        return
      }
      const streamAbort = new AbortController()
      realtimeHandle = handle
      realtimeStopping = false
      realtimeSessionId = sessionId
      realtimeStreamAbort = streamAbort
      const initialDraft = target.getDraft()
      realtimeDraftState = { baseDraft: initialDraft, sessionDraft: initialDraft }
      realtimeSettingsSnapshot = currentSettings
      if (activeAbort === controller) activeAbort = undefined
      handle.start(async audioBase64 => {
        if (disposed || streamAbort.signal.aborted || epoch !== capturedEpoch || realtimeSessionId !== sessionId) return
        const chunkResult = unwrapRemoteResult(await remote.sendRealtimeAudio(sessionId!, audioBase64, streamAbort.signal))
        if (disposed || streamAbort.signal.aborted || epoch !== capturedEpoch) return
        if (!chunkResult.ok) throw new Error(chunkResult.message)
        const parsedChunk = realtimeTranscriptSchema.safeParse(chunkResult.value)
        if (!parsedChunk.success) return
        const text = parsedChunk.data.text.trim()
        if (text === '') return
        applyLiveDraft(target, realtimeDraftState, text)
      })
      setPhase('recording')
      armMaxDuration(effectiveMaxSeconds(currentSettings))
    } catch {
      handle?.abort()
      if (sessionId !== undefined) void remote.cancelRealtime(sessionId).catch(() => undefined)
      if (activeAbort === controller) activeAbort = undefined
      if (disposed || controller.signal.aborted || epoch !== capturedEpoch) return
      failVoice(getLocale() === 'zh-CN' ? '无法建立实时语音识别连接，请检查 DSH 设置 → dsh-ears' : 'Could not start realtime ASR. Check DSH Settings → dsh-ears.', capturedEpoch)
    }
  }

  const stopMediaRecording = async (capturedEpoch: number) => {
    const handle = mediaHandle
    const target = activeTarget
    const currentSettings = mediaSettingsSnapshot ?? settings
    const remote = readRemote()
    if (handle === undefined || mediaStopping || target === undefined || remote === undefined) return
    mediaStopping = true
    const controller = new AbortController()
    activeAbort = controller
    try {
      const audio = await handle.stop()
      if (mediaHandle === handle) {
        mediaHandle = undefined
        mediaStopping = false
      }
      mediaSettingsSnapshot = undefined
      if (disposed || controller.signal.aborted || epoch !== capturedEpoch) return
      if (Date.now() - mediaStartedAt < TRIVIAL_RECORDING_MS && base64ByteLength(audio.base64) < TRIVIAL_RECORDING_BYTES) {
        setPhase('idle')
        return
      }
      setPhase('transcribing')
      const prepared = needsWavConversion(currentSettings)
        ? await (deps.decodeToWav ?? decodeBrowserAudioToWav)(audio, controller.signal)
        : audio
      if (disposed || controller.signal.aborted || epoch !== capturedEpoch) return
      const raw = await remote.transcribe(prepared.base64, prepared.mimeType, controller.signal)
      if (disposed || controller.signal.aborted || epoch !== capturedEpoch) return
      const extracted = extractRemoteText(raw)
      if (!extracted.ok) {
        failVoice(getLocale() === 'zh-CN' ? '语音转写失败，请检查 DSH 设置 → dsh-ears' : 'Transcription failed. Check DSH Settings → dsh-ears.', capturedEpoch)
        return
      }
      const currentDraft = target.getDraft()
      const effectiveBase = currentDraft === mediaBaseDraft
        ? mediaBaseDraft
        : currentDraft.trim() === ''
          ? ''
          : currentDraft
      commitTranscript(target, extracted.text, effectiveBase, effectiveBase, false, currentSettings, capturedEpoch)
    } catch {
      if (disposed || controller.signal.aborted || epoch !== capturedEpoch) return
      failVoice(getLocale() === 'zh-CN' ? '语音转写失败，请重试' : 'Transcription failed. Please retry.', capturedEpoch)
    } finally {
      if (mediaHandle === handle) {
        mediaHandle = undefined
        mediaStopping = false
      }
      mediaSettingsSnapshot = undefined
      if (activeAbort === controller) activeAbort = undefined
    }
  }

  const stopRealtimeRecording = async (capturedEpoch: number) => {
    const handle = realtimeHandle
    const sessionId = realtimeSessionId
    const streamAbort = realtimeStreamAbort
    const target = activeTarget
    const currentSettings = realtimeSettingsSnapshot ?? settings
    const remote = readRemote()
    if (handle === undefined || realtimeStopping || sessionId === undefined || target === undefined || !supportsRealtimeRemote(remote)) return
    realtimeStopping = true
    const controller = new AbortController()
    activeAbort = controller
    setPhase('transcribing')
    let stopFallbackTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const stopPromise = handle.stop()
      // Avoid unhandled rejection if stopPromise rejects after the timeout branch wins the race.
      void stopPromise.catch(() => undefined)
      await Promise.race([
        stopPromise,
        new Promise<void>(resolve => {
          stopFallbackTimer = setTimeout(() => {
            stopFallbackTimer = undefined
            // Abort any stalled sendRealtimeAudio RPC before calling finishRealtime/cancelRealtime.
            streamAbort?.abort()
            handle.abort()
            resolve()
          }, REALTIME_STOP_TIMEOUT_MS)
        }),
      ])
      if (realtimeHandle === handle) {
        realtimeHandle = undefined
        realtimeStopping = false
      }
      if (disposed || controller.signal.aborted || epoch !== capturedEpoch) return
      const raw = await remote.finishRealtime(sessionId, controller.signal)
      if (disposed || controller.signal.aborted || epoch !== capturedEpoch) return
      const extracted = extractRemoteText(raw)
      if (!extracted.ok) {
        failVoice(getLocale() === 'zh-CN' ? '实时语音转写失败，请重试' : 'Realtime transcription failed. Please retry.', capturedEpoch)
        return
      }
      const transcript = extracted.text.trim()
      if (transcript === '') {
        setPhase('idle')
        return
      }
      const currentDraft = target.getDraft()
      if (currentDraft === realtimeDraftState.sessionDraft) {
        const nextDraft = joinVoiceText(realtimeDraftState.baseDraft, transcript)
        target.setDraft(nextDraft)
        commitTranscript(target, transcript, realtimeDraftState.baseDraft, nextDraft, true, currentSettings, capturedEpoch)
      } else if (currentDraft.trim() === '') {
        realtimeDraftState.baseDraft = ''
        target.setDraft(transcript)
        commitTranscript(target, transcript, '', transcript, true, currentSettings, capturedEpoch)
      } else {
        setPhase('idle')
      }
    } catch {
      if (disposed || controller.signal.aborted || epoch !== capturedEpoch) return
      failVoice(getLocale() === 'zh-CN' ? '实时语音转写失败，请重试' : 'Realtime transcription failed. Please retry.', capturedEpoch)
    } finally {
      if (stopFallbackTimer !== undefined) clearTimeout(stopFallbackTimer)
      streamAbort?.abort()
      if (realtimeHandle === handle) {
        realtimeHandle = undefined
        realtimeStopping = false
      }
      if (realtimeSessionId === sessionId) realtimeSessionId = undefined
      if (realtimeStreamAbort === streamAbort) realtimeStreamAbort = undefined
      realtimeSettingsSnapshot = undefined
      if (activeAbort === controller) activeAbort = undefined
      void remote.cancelRealtime(sessionId).catch(() => undefined)
    }
  }

  const start = (target: WebSurfaceVoiceTarget) => {
    if (disposed) return
    if (phase === 'starting' || phase === 'recording' || phase === 'transcribing' || phase === 'polishing') return
    if (isHostVoiceRecording()) {
      setPhase(
        'error',
        getLocale() === 'zh-CN'
          ? '右侧会话正在录音，请先停止后再启动问诊语音'
          : 'Stop the right-hand conversation recording before starting consultation voice.',
      )
      return
    }
    const currentSnapshot = buildSnapshot()
    if (!currentSnapshot.ready) {
      emit()
      return
    }
    epoch += 1
    const capturedEpoch = epoch
    activeTarget = target
    const currentSettings = settings
    if (currentSettings.asrBackend === 'web-speech') {
      startWebSpeech(target, currentSettings, capturedEpoch)
      return
    }
    if (isCloudRealtime(currentSettings)) {
      void startRealtimeRecording(target, currentSettings, capturedEpoch)
      return
    }
    void startMediaRecording(target, currentSettings, capturedEpoch)
  }

  const stop = () => {
    if (disposed) return
    clearTimers()
    if (phase === 'starting' && speechSession === undefined && mediaHandle === undefined && realtimeHandle === undefined) {
      epoch += 1
      teardownActiveCapture(true)
      setPhase('idle')
      return
    }
    if (stopSpeechSession !== undefined) {
      stopSpeechSession()
      return
    }
    const capturedEpoch = epoch
    if (realtimeHandle !== undefined) {
      void stopRealtimeRecording(capturedEpoch)
      return
    }
    if (mediaHandle !== undefined) {
      void stopMediaRecording(capturedEpoch)
    }
  }

  const cancel = () => {
    if (disposed) return
    const wasBusy = phase !== 'idle'
    epoch += 1
    teardownActiveCapture(true)
    activeTarget = undefined
    if (wasBusy || errorText !== undefined) setPhase('idle')
  }

  const clearError = () => {
    if (disposed || phase !== 'error') return
    setPhase('idle')
  }

  // Register on window CAPTURE at profile boot (before dsh-ears mounts MicrophoneButton),
  // so a focused consultation textarea or fullscreen/collapsed-conversation view intercepts
  // the chord cleanly without double-triggering dsh-ears.
  const onKeyDown = (event: KeyboardEvent) => {
    if (disposed || !settings.voiceShortcutEnabled) return
    if (event.defaultPrevented || event.isComposing || event.repeat) return
    if (!matchesVoiceShortcut(settings.voiceShortcut, event)) return
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    if (isEventInsideDialog(event)) return

    // If our consultation session is actively recording, the shortcut always stops it rather
    // than letting dsh-ears start a second concurrent recording in the right composer.
    if (phase === 'starting' || phase === 'recording') {
      event.preventDefault()
      event.stopImmediatePropagation()
      stop()
      return
    }
    if (!snapshot.installed || !settingsLoaded || !snapshot.ready) return
    // If host dsh-ears is actively recording in the right conversation, yield so the shortcut stops it.
    if (isHostVoiceRecording()) return
    for (const handler of shortcutHandlers) {
      if (!handler.shouldHandle(event)) continue
      event.preventDefault()
      event.stopImmediatePropagation()
      handler.toggle()
      return
    }
  }

  // While consultation voice owns the microphone, block clicks / pointerdown on the host
  // dsh-ears microphone button in capture phase before React's root handler runs, preventing
  // dual concurrent microphone capture in split-screen mode.
  const onHostMicInteraction = (event: Event) => {
    if (disposed || (phase !== 'starting' && phase !== 'recording')) return
    if (findIdleHostVoiceButton(event) === null) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  const onWindowFocus = () => {
    refresh()
  }

  const onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') refresh()
  }

  const disposers: Array<() => void> = []
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('click', onHostMicInteraction, true)
    window.addEventListener('pointerdown', onHostMicInteraction, true)
    window.addEventListener('focus', onWindowFocus)
    disposers.push(() => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('click', onHostMicInteraction, true)
      window.removeEventListener('pointerdown', onHostMicInteraction, true)
      window.removeEventListener('focus', onWindowFocus)
    })
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
    disposers.push(() => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    })
  }

  try {
    const optionalHost = ctx as unknown as {
      inject?: (
        deps: string[],
        callback: (child: ClientContext) => void,
      ) => (() => void) | { dispose?: () => void } | undefined
    }
    const injectHandle = optionalHost.inject?.(['remote.dshEars'], child => {
      const candidate = child.get('remote.dshEars' as never) as unknown
      if (isDshEarsRemote(candidate)) {
        earsRemote = candidate
        emit()
        refresh()
      }
      child.effect?.(() => () => {
        if (earsRemote === candidate) {
          earsRemote = undefined
          settingsLoaded = false
          settingsAvailable = true
          whisperState = undefined
          cancel()
          emit()
        }
      }, 'clinmesh-dsh-web: release dsh-ears remote')
    })
    if (typeof injectHandle === 'function') {
      disposers.push(injectHandle)
    } else if (typeof injectHandle?.dispose === 'function') {
      disposers.push(() => { void injectHandle.dispose?.() })
    }
  } catch { /* optional remote.dshEars */ }

  try {
    const remoteContainer = ctx.get('remote') as unknown as VoiceRemoteContainer | undefined
    const unsubscribeSettings = remoteContainer?.$on?.('settings/document-updated', refresh)
    if (typeof unsubscribeSettings === 'function') disposers.push(unsubscribeSettings)
  } catch { /* optional event */ }

  try {
    const unsubscribeReset = (ctx as unknown as {
      on?: (event: string, listener: () => void) => () => void
    }).on?.('connection/reset', refresh)
    if (typeof unsubscribeReset === 'function') disposers.push(unsubscribeReset)
  } catch { /* optional event */ }

  try {
    const locale = ctx.get('locale') as unknown as ClientLocalePort | undefined
    const unsubscribeLocale = locale?.subscribe?.(() => emit())
    if (typeof unsubscribeLocale === 'function') disposers.push(unsubscribeLocale)
  } catch { /* optional locale */ }

  refresh()

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    start,
    stop,
    cancel,
    clearError,
    refresh,
    registerShortcutHandler(context) {
      shortcutHandlers.add(context)
      return () => { shortcutHandlers.delete(context) }
    },
    dispose() {
      if (disposed) return
      disposed = true
      epoch += 1
      teardownActiveCapture(true)
      shortcutHandlers.clear()
      listeners.clear()
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}
