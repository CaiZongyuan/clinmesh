import {
  VOICE_SAMPLE_RATE,
  voiceSttServerMessageSchema,
  type VoiceCaptureMode,
  type VoiceSttProvider,
} from '@clinmesh/contracts/voice'
import { useCallback, useEffect, useRef, useState } from 'react'
import { startPcm16Capture, type Pcm16CaptureHandle } from './audio-capture-engine.ts'
import { buildVoiceSttWebSocketUrl } from './voice-api.ts'
import { readVoiceSettings } from './voice-settings-storage.ts'

export const HOLD_MIN_DURATION_MS = 600

export type VoiceCaptureStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'holding'
  | 'committing'
  | 'paused'

export interface AudioInputDeviceOption {
  deviceId: string
  label: string
}

interface SpeechRecognitionAlternativeLike {
  transcript: string
}

interface SpeechRecognitionResultLike {
  isFinal: boolean
  0?: SpeechRecognitionAlternativeLike
}

interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<SpeechRecognitionResultLike>
}

interface SpeechRecognitionErrorEventLike {
  error?: string
  message?: string
}

interface SpeechRecognitionInstanceLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onstart: (() => void) | null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

type SpeechRecognitionCtorLike = new () => SpeechRecognitionInstanceLike

function getBrowserSpeechRecognitionCtor(): SpeechRecognitionCtorLike | null {
  if (typeof window === 'undefined') return null
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtorLike
    webkitSpeechRecognition?: SpeechRecognitionCtorLike
  }
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null
}

export function isWebSpeechSttSupported(): boolean {
  return getBrowserSpeechRecognitionCtor() !== null
}

function formatVoiceErrorMessage(error: unknown, zh: boolean): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      return zh
        ? '麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问后重试。'
        : 'Microphone permission was denied. Allow microphone access in the browser and try again.'
    }
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      return zh
        ? '未检测到可用麦克风设备，请检查麦克风连接。'
        : 'No microphone device was detected.'
    }
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }
  return zh ? '语音采集启动失败，请重试。' : 'Failed to start voice capture.'
}

export interface UseVoiceCaptureOptions {
  sttProvider: VoiceSttProvider
  locale: 'zh-CN' | 'en-US'
  resetKey?: string | undefined
  deviceId?: string | undefined
  disabled?: boolean | undefined
  onFinal: (text: string) => void
  onSpeechStart?: (() => void) | undefined
}

export interface UseVoiceCaptureResult {
  status: VoiceCaptureStatus
  activeMode: VoiceCaptureMode | null
  activeProvider: VoiceSttProvider
  interimText: string
  level: number
  error: string | null
  needsBailianConfig: boolean
  notice: string | null
  devices: AudioInputDeviceOption[]
  isListening: boolean
  isPaused: boolean
  startContinuous: () => Promise<void>
  stop: () => void
  togglePause: () => void
  beginHold: () => Promise<void>
  commitHold: () => void
  cancelHold: (reason?: string) => void
  clearError: () => void
}

export function useVoiceCapture(options: UseVoiceCaptureOptions): UseVoiceCaptureResult {
  const zh = options.locale === 'zh-CN'
  const [status, setStatus] = useState<VoiceCaptureStatus>('idle')
  const [activeMode, setActiveMode] = useState<VoiceCaptureMode | null>(null)
  const [activeProvider, setActiveProvider] = useState<VoiceSttProvider>(options.sttProvider)
  const [interimText, setInterimText] = useState('')
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [needsBailianConfig, setNeedsBailianConfig] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [devices, setDevices] = useState<AudioInputDeviceOption[]>([])

  // Latest-ref callbacks (React 18/19 compatible, no useEffectEvent).
  const onFinalRef = useRef(options.onFinal)
  const onSpeechStartRef = useRef(options.onSpeechStart)
  const sttProviderRef = useRef(options.sttProvider)
  const localeRef = useRef(options.locale)
  const deviceIdRef = useRef(options.deviceId)
  const statusRef = useRef(status)

  useEffect(() => { onFinalRef.current = options.onFinal }, [options.onFinal])
  useEffect(() => { onSpeechStartRef.current = options.onSpeechStart }, [options.onSpeechStart])
  useEffect(() => {
    sttProviderRef.current = options.sttProvider
    if (statusRef.current === 'idle' || statusRef.current === 'paused') {
      setActiveProvider(options.sttProvider)
    }
  }, [options.sttProvider])
  useEffect(() => { localeRef.current = options.locale }, [options.locale])
  useEffect(() => { deviceIdRef.current = options.deviceId }, [options.deviceId])
  useEffect(() => { statusRef.current = status }, [status])

  const wsRef = useRef<WebSocket | null>(null)
  const pcmRef = useRef<Pcm16CaptureHandle | null>(null)
  const webSpeechRef = useRef<SpeechRecognitionInstanceLike | null>(null)
  const webSpeechKeepAliveRef = useRef(false)
  const holdStartedAtRef = useRef<number | null>(null)
  const holdModeRef = useRef<VoiceCaptureMode | null>(null)
  const webSpeechHoldFinalsRef = useRef<string[]>([])
  const webSpeechHoldInterimRef = useRef('')
  const webSpeechHoldCommittedRef = useRef(false)
  const webSpeechHoldCancelledRef = useRef(false)
  const sessionTokenRef = useRef(0)

  const refreshDevicesAfterPermission = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      const inputs = list
        .filter(item => item.kind === 'audioinput' && item.deviceId.length > 0)
        .map((item, idx) => ({
          deviceId: item.deviceId,
          label: item.label || (zh ? `麦克风 ${idx + 1}` : `Microphone ${idx + 1}`),
        }))
      setDevices(inputs)
    } catch {
      // Ignore device enumeration restrictions.
    }
  }, [zh])

  const teardownAll = useCallback((nextStatus: VoiceCaptureStatus = 'idle') => {
    sessionTokenRef.current += 1
    webSpeechKeepAliveRef.current = false
    holdStartedAtRef.current = null
    holdModeRef.current = null
    webSpeechHoldFinalsRef.current = []
    webSpeechHoldInterimRef.current = ''
    webSpeechHoldCommittedRef.current = false
    webSpeechHoldCancelledRef.current = false

    if (pcmRef.current !== null) {
      pcmRef.current.stop()
      pcmRef.current = null
    }
    if (wsRef.current !== null) {
      const ws = wsRef.current
      wsRef.current = null
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'cancel' }))
        }
        ws.close(1000, 'client-stop')
      } catch { /* ignore */ }
    }
    if (webSpeechRef.current !== null) {
      const recognition = webSpeechRef.current
      webSpeechRef.current = null
      recognition.onstart = null
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      try { recognition.abort() } catch { /* ignore */ }
    }
    setStatus(nextStatus)
    setActiveMode(null)
    setInterimText('')
    setLevel(0)
  }, [])

  const startWebSpeech = useCallback((mode: VoiceCaptureMode) => {
    const Ctor = getBrowserSpeechRecognitionCtor()
    if (Ctor === null) {
      setNeedsBailianConfig(true)
      setError(
        zh
          ? '当前浏览器不支持 Web Speech API，请在「设置 → 模型与服务商」配置阿里云百炼 BAILIAN_TOKEN 使用实时语音识别。'
          : 'Web Speech API is unavailable in this browser. Configure BAILIAN_TOKEN in Settings > Models for realtime recognition.',
      )
      setStatus('idle')
      setActiveMode(null)
      return
    }

    const token = sessionTokenRef.current + 1
    sessionTokenRef.current = token
    holdModeRef.current = mode
    webSpeechKeepAliveRef.current = mode === 'continuous'
    webSpeechHoldFinalsRef.current = []
    webSpeechHoldInterimRef.current = ''
    webSpeechHoldCommittedRef.current = false
    webSpeechHoldCancelledRef.current = false

    const recognition = new Ctor()
    recognition.lang = localeRef.current
    recognition.continuous = true
    recognition.interimResults = true
    webSpeechRef.current = recognition
    setActiveProvider('web-speech')
    setActiveMode(mode)
    setError(null)
    setNeedsBailianConfig(false)
    setNotice(null)
    setStatus(mode === 'hold' ? 'holding' : 'listening')

    recognition.onstart = () => {
      if (sessionTokenRef.current !== token) return
      onSpeechStartRef.current?.()
    }

    recognition.onresult = (event) => {
      if (sessionTokenRef.current !== token) return
      let latestInterim = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]
        const text = result?.[0]?.transcript?.trim() ?? ''
        if (text.length === 0) continue
        if (result?.isFinal) {
          if (mode === 'continuous') {
            setInterimText('')
            onFinalRef.current(text)
          } else {
            webSpeechHoldFinalsRef.current.push(text)
          }
        } else {
          latestInterim = latestInterim ? `${latestInterim}${text}` : text
        }
      }
      if (mode === 'continuous') {
        if (latestInterim.length > 0) {
          onSpeechStartRef.current?.()
          setInterimText(latestInterim)
        }
      } else {
        webSpeechHoldInterimRef.current = latestInterim
        const combined = [...webSpeechHoldFinalsRef.current, latestInterim].filter(Boolean).join('')
        if (combined.length > 0) {
          onSpeechStartRef.current?.()
          setInterimText(combined)
        }
      }
    }

    recognition.onerror = (event) => {
      if (sessionTokenRef.current !== token) return
      const errCode = event.error ?? 'unknown'
      if (errCode === 'aborted' || errCode === 'no-speech') return
      if (errCode === 'not-allowed' || errCode === 'service-not-allowed') {
        teardownAll('idle')
        setNeedsBailianConfig(false)
        setError(
          zh
            ? '麦克风或浏览器语音识别权限被拒绝，请在浏览器地址栏允许麦克风访问后重试。'
            : 'Microphone or browser speech recognition permission was denied.',
        )
        return
      }
      if (errCode === 'network') {
        teardownAll('idle')
        setNeedsBailianConfig(true)
        setError(
          zh
            ? '浏览器内置语音识别无法连接上游服务（Chrome/Edge 的 Web Speech 需直连 Google 语音接口，当前网络不可达）。请在「设置 → 模型与服务商 → 语音交互」配置阿里云百炼 BAILIAN_TOKEN（或在服务端 .env 配置）以启用国内百炼 Paraformer 实时识别。'
            : 'Browser Web Speech could not reach its cloud service (network error). Configure Alibaba Bailian BAILIAN_TOKEN in Settings > Models (or server .env) to use Paraformer realtime recognition.',
        )
        return
      }
      if (errCode === 'audio-capture') {
        teardownAll('idle')
        setNeedsBailianConfig(false)
        setError(
          zh
            ? '未能采集到麦克风音频，请检查系统麦克风设备是否已连接且未被其他程序占用。'
            : 'Failed to capture microphone audio. Check that your microphone is connected and available.',
        )
        return
      }
      setNeedsBailianConfig(false)
      setError(zh ? `浏览器语音识别异常：${errCode}` : `Browser speech recognition error: ${errCode}`)
      teardownAll('idle')
    }

    recognition.onend = () => {
      if (sessionTokenRef.current !== token) return
      if (mode === 'hold') {
        if (!webSpeechHoldCancelledRef.current && webSpeechHoldCommittedRef.current) {
          const text = [...webSpeechHoldFinalsRef.current, webSpeechHoldInterimRef.current]
            .map(part => part.trim())
            .filter(Boolean)
            .join('')
            .trim()
          teardownAll('idle')
          if (text.length > 0) {
            onFinalRef.current(text)
          } else {
            setNotice(zh ? '未识别到有效语音内容。' : 'No speech detected.')
          }
        } else {
          teardownAll('idle')
        }
        return
      }
      if (webSpeechKeepAliveRef.current) {
        try {
          recognition.start()
        } catch {
          teardownAll('idle')
        }
      } else {
        teardownAll('idle')
      }
    }

    try {
      recognition.start()
    } catch (startErr) {
      teardownAll('idle')
      setError(formatVoiceErrorMessage(startErr, zh))
    }
  }, [teardownAll, zh])

  const startParaformer = useCallback(async (mode: VoiceCaptureMode) => {
    const token = sessionTokenRef.current + 1
    sessionTokenRef.current = token
    holdModeRef.current = mode
    setActiveProvider('paraformer-realtime-v2')
    setActiveMode(mode)
    setStatus('connecting')
    setError(null)
    setNeedsBailianConfig(false)
    setNotice(null)
    setInterimText('')

    const settings = readVoiceSettings()
    const ws = new WebSocket(buildVoiceSttWebSocketUrl())
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    let pcmStarted = false

    const handleFailure = (message: string, allowWebSpeechFallback = false, suggestBailianConfig = false) => {
      if (sessionTokenRef.current !== token) return
      teardownAll('idle')
      if (allowWebSpeechFallback && isWebSpeechSttSupported()) {
        startWebSpeech(mode)
        return
      }
      setNeedsBailianConfig(suggestBailianConfig)
      setError(message)
    }

    ws.onopen = () => {
      if (sessionTokenRef.current !== token) return
      const apiKey = settings.apiKey.trim()
      const workspace = settings.workspace.trim()
      ws.send(JSON.stringify({
        type: 'start',
        mode,
        sampleRate: VOICE_SAMPLE_RATE,
        languageHints: ['zh', 'en'],
        ...(apiKey.length > 0 ? { apiKey } : {}),
        ...(workspace.length > 0 ? { workspace } : {}),
      }))
      void startPcm16Capture({
        deviceId: deviceIdRef.current ?? settings.selectedDeviceId,
        onChunk: (pcm16, rms) => {
          if (sessionTokenRef.current !== token) return
          setLevel(rms)
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(pcm16)
          }
        },
      }).then((handle) => {
        if (sessionTokenRef.current !== token) {
          handle.stop()
          return
        }
        pcmStarted = true
        pcmRef.current = handle
        setStatus(mode === 'hold' ? 'holding' : 'listening')
        onSpeechStartRef.current?.()
        void refreshDevicesAfterPermission()
      }).catch((captureErr: unknown) => {
        handleFailure(formatVoiceErrorMessage(captureErr, zh))
      })
    }

    ws.onmessage = (event) => {
      if (sessionTokenRef.current !== token || typeof event.data !== 'string') return
      let raw: unknown
      try {
        raw = JSON.parse(event.data)
      } catch {
        return
      }
      const parsed = voiceSttServerMessageSchema.safeParse(raw)
      if (!parsed.success) return
      const msg = parsed.data
      if (msg.type === 'ready') {
        if (pcmStarted) {
          setStatus(mode === 'hold' ? 'holding' : 'listening')
        }
        return
      }
      if (msg.type === 'interim') {
        onSpeechStartRef.current?.()
        setInterimText(msg.text)
        return
      }
      if (msg.type === 'final') {
        setInterimText('')
        onFinalRef.current(msg.text)
        if (mode === 'hold') {
          teardownAll('idle')
        }
        return
      }
      if (msg.type === 'empty') {
        setInterimText('')
        if (mode === 'hold') {
          teardownAll('idle')
          setNotice(zh ? '未识别到有效语音内容。' : 'No speech detected.')
        }
        return
      }
      if (msg.type === 'error') {
        const isConfigIssue = msg.code === 'VOICE_PROVIDER_UNCONFIGURED' || msg.code === 'VOICE_UPSTREAM_AUTH_FAILED'
        handleFailure(msg.message, msg.code === 'VOICE_PROVIDER_UNCONFIGURED', isConfigIssue)
      }
    }

    ws.onerror = () => {
      handleFailure(
        zh ? '语音识别连接中断，请检查网络或百炼配置。' : 'Voice recognition connection failed.',
      )
    }

    ws.onclose = () => {
      if (sessionTokenRef.current !== token) return
      teardownAll('idle')
    }
  }, [refreshDevicesAfterPermission, startWebSpeech, teardownAll, zh])

  const startContinuous = useCallback(async () => {
    if (options.disabled) return
    teardownAll('idle')
    if (sttProviderRef.current === 'paraformer-realtime-v2') {
      await startParaformer('continuous')
    } else {
      startWebSpeech('continuous')
    }
  }, [options.disabled, startParaformer, startWebSpeech, teardownAll])

  const beginHold = useCallback(async () => {
    if (options.disabled) return
    teardownAll('idle')
    holdStartedAtRef.current = Date.now()
    onSpeechStartRef.current?.()
    if (sttProviderRef.current === 'paraformer-realtime-v2') {
      await startParaformer('hold')
    } else {
      startWebSpeech('hold')
    }
  }, [options.disabled, startParaformer, startWebSpeech, teardownAll])

  const cancelHold = useCallback((reason?: string) => {
    if (holdModeRef.current !== 'hold') return
    webSpeechHoldCancelledRef.current = true
    teardownAll('idle')
    if (reason) setNotice(reason)
  }, [teardownAll])

  const commitHold = useCallback(() => {
    if (holdModeRef.current !== 'hold') return
    const elapsed = holdStartedAtRef.current === null ? 0 : Date.now() - holdStartedAtRef.current
    if (elapsed < HOLD_MIN_DURATION_MS) {
      webSpeechHoldCancelledRef.current = true
      teardownAll('idle')
      setNotice(zh ? '说话时间过短，已忽略（请按住至少 0.6 秒）。' : 'Held too briefly — hold for at least 0.6s to speak.')
      return
    }

    if (pcmRef.current !== null) {
      pcmRef.current.stop()
      pcmRef.current = null
    }
    setLevel(0)
    setStatus('committing')

    if (wsRef.current !== null && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'commit' }))
      return
    }
    if (webSpeechRef.current !== null) {
      webSpeechHoldCommittedRef.current = true
      try {
        webSpeechRef.current.stop()
      } catch {
        teardownAll('idle')
      }
      return
    }
    teardownAll('idle')
  }, [teardownAll, zh])

  const stop = useCallback(() => {
    teardownAll('idle')
    setNotice(null)
  }, [teardownAll])

  const togglePause = useCallback(() => {
    if (statusRef.current === 'paused') {
      setStatus('idle')
      setNotice(null)
      return
    }
    teardownAll('paused')
    setNotice(null)
  }, [teardownAll])

  // Stop capture cleanly on encounter switch or unmount.
  useEffect(() => {
    teardownAll('idle')
    setError(null)
    setNotice(null)
  }, [options.resetKey, teardownAll])

  useEffect(() => () => {
    teardownAll('idle')
  }, [teardownAll])

  // Cancel active hold-to-talk if browser tab loses focus while holding.
  useEffect(() => {
    const onBlur = () => {
      if (holdModeRef.current === 'hold') {
        cancelHold(zh ? '窗口失焦，已取消按住说话。' : 'Window blurred — push-to-talk cancelled.')
      }
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [cancelHold, zh])

  const isListening = status === 'connecting' || status === 'listening' || status === 'holding' || status === 'committing'

  return {
    status,
    activeMode,
    activeProvider,
    interimText,
    level,
    error,
    needsBailianConfig,
    notice,
    devices,
    isListening,
    isPaused: status === 'paused',
    startContinuous,
    stop,
    togglePause,
    beginHold,
    commitHold,
    cancelHold,
    clearError: () => { setError(null); setNeedsBailianConfig(false); setNotice(null) },
  }
}
