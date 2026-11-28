import { randomUUID } from 'node:crypto'
import { VOICE_SAMPLE_RATE, type VoiceCaptureMode } from '@clinmesh/contracts/voice'
import {
  VoiceServiceError,
  type ConnectVoiceUpstream,
  type ResolvedBailianCredentials,
  type VoiceUpstreamSocket,
} from './bailian-voice-config.ts'

const MAX_PRE_START_BUFFER_BYTES = 512 * 1024 // ~16 seconds of 16 kHz mono PCM16
const FINISH_WAIT_TIMEOUT_MS = 5_000
const PARAFORMER_MODEL = 'paraformer-realtime-v2'

export interface ParaformerSessionCallbacks {
  onReady: () => void
  onInterim: (text: string) => void
  onFinal: (text: string) => void
  onEmpty: () => void
  onError: (code: string, message: string) => void
}

export interface ParaformerSessionOptions {
  credentials: ResolvedBailianCredentials
  connectUpstream: ConnectVoiceUpstream
  mode: VoiceCaptureMode
  languageHints?: readonly ('zh' | 'en')[] | undefined
  callbacks: ParaformerSessionCallbacks
  finishTimeoutMs?: number | undefined
}

export interface ParaformerSession {
  feedAudio: (pcm16Chunk: Uint8Array) => void
  commit: () => void
  cancel: () => void
  close: () => void
}

interface ParaformerServerEvent {
  header?: {
    event?: string
    error_code?: string
    error_message?: string
  }
  payload?: {
    output?: {
      sentence?: {
        text?: string
        sentence_end?: boolean
        heartbeat?: boolean
      }
    }
  }
}

/**
 * Manages one duplex streaming recognition session with Alibaba Cloud Bailian Paraformer v2.
 * Supports:
 * - `continuous` (hands-free): emits `onInterim` live and `onFinal` on every `sentence_end: true`.
 * - `hold` (push-to-talk): accumulates finalized sentences while the button is held and emits ONE
 *   combined `onFinal` (or `onEmpty`) when `commit()` completes `finish-task` -> `task-finished`.
 */
export async function createParaformerSession(
  options: ParaformerSessionOptions,
): Promise<ParaformerSession> {
  const socket: VoiceUpstreamSocket = await options.connectUpstream(options.credentials)
  const taskId = randomUUID().replaceAll('-', '')
  const finishTimeoutMs = options.finishTimeoutMs ?? FINISH_WAIT_TIMEOUT_MS

  let started = false
  let closed = false
  let committing = false
  let cancelled = false
  let finishTimer: ReturnType<typeof setTimeout> | undefined

  const pendingAudio: Uint8Array[] = []
  let pendingAudioBytes = 0

  // Used in `hold` mode to stitch multi-sentence push-to-talk utterances into one turn.
  const holdFinalizedParts: string[] = []
  let holdCurrentPartial = ''

  const clearTimers = () => {
    if (finishTimer !== undefined) {
      clearTimeout(finishTimer)
      finishTimer = undefined
    }
  }

  const combinedHoldText = (): string => {
    const parts = holdCurrentPartial.trim().length > 0
      ? [...holdFinalizedParts, holdCurrentPartial.trim()]
      : holdFinalizedParts
    return parts.join('').trim()
  }

  const finalizeHoldTurn = () => {
    clearTimers()
    if (cancelled || closed) return
    const finalText = combinedHoldText()
    closed = true
    socket.close(1000, 'committed')
    if (finalText.length > 0) {
      options.callbacks.onFinal(finalText)
    } else {
      options.callbacks.onEmpty()
    }
  }

  const shutdown = (reason: string) => {
    if (closed) return
    closed = true
    clearTimers()
    pendingAudio.length = 0
    pendingAudioBytes = 0
    socket.close(1000, reason)
  }

  socket.onText((payload) => {
    if (closed) return
    let event: ParaformerServerEvent
    try {
      event = JSON.parse(payload) as ParaformerServerEvent
    } catch {
      return
    }
    const eventName = event.header?.event

    if (eventName === 'task-started') {
      started = true
      for (const chunk of pendingAudio) {
        socket.sendBinary(chunk)
      }
      pendingAudio.length = 0
      pendingAudioBytes = 0
      options.callbacks.onReady()
      if (committing) {
        sendFinishTask()
      }
      return
    }

    if (eventName === 'result-generated') {
      const sentence = event.payload?.output?.sentence
      if (sentence === undefined || sentence.heartbeat === true) return
      const text = typeof sentence.text === 'string' ? sentence.text.trim() : ''
      const sentenceEnd = sentence.sentence_end === true

      if (options.mode === 'continuous') {
        if (sentenceEnd) {
          if (text.length > 0) {
            options.callbacks.onFinal(text)
          }
        } else if (text.length > 0) {
          options.callbacks.onInterim(text)
        }
        return
      }

      // Hold (push-to-talk) mode
      if (sentenceEnd) {
        if (text.length > 0) {
          holdFinalizedParts.push(text)
        }
        holdCurrentPartial = ''
      } else {
        holdCurrentPartial = text
      }
      const liveText = combinedHoldText()
      if (liveText.length > 0) {
        options.callbacks.onInterim(liveText)
      }
      return
    }

    if (eventName === 'task-finished') {
      if (options.mode === 'hold' && committing && !cancelled) {
        finalizeHoldTurn()
      } else {
        shutdown('task-finished')
      }
      return
    }

    if (eventName === 'task-failed') {
      const code = event.header?.error_code ?? 'VOICE_UPSTREAM_FAILED'
      const message = event.header?.error_message ?? 'Paraformer recognition failed'
      shutdown('task-failed')
      options.callbacks.onError(code, message)
    }
  })

  socket.onError((error) => {
    if (closed) return
    shutdown('upstream-error')
    options.callbacks.onError('VOICE_UPSTREAM_FAILED', error.message || 'Paraformer socket error')
  })

  socket.onClose((code, reason) => {
    if (closed) return
    if (options.mode === 'hold' && committing && !cancelled) {
      finalizeHoldTurn()
      return
    }
    closed = true
    clearTimers()
    if (!cancelled && code !== 1000) {
      options.callbacks.onError(
        'VOICE_UPSTREAM_FAILED',
        `Paraformer upstream closed unexpectedly (code ${code}${reason ? `: ${reason}` : ''})`,
      )
    }
  })

  const sendFinishTask = () => {
    socket.sendText(JSON.stringify({
      header: {
        action: 'finish-task',
        task_id: taskId,
        streaming: 'duplex',
      },
      payload: {
        input: {},
      },
    }))
    clearTimers()
    finishTimer = setTimeout(() => {
      if (options.mode === 'hold' && !cancelled) {
        finalizeHoldTurn()
      } else {
        shutdown('finish-timeout')
      }
    }, finishTimeoutMs)
  }

  // Kick off the duplex Paraformer recognition session immediately upon socket open.
  socket.sendText(JSON.stringify({
    header: {
      action: 'run-task',
      task_id: taskId,
      streaming: 'duplex',
    },
    payload: {
      task_group: 'audio',
      task: 'asr',
      function: 'recognition',
      model: PARAFORMER_MODEL,
      input: {},
      parameters: {
        format: 'pcm',
        sample_rate: VOICE_SAMPLE_RATE,
        language_hints: options.languageHints ?? ['zh', 'en'],
        semantic_punctuation_enabled: true,
        disfluency_removal_enabled: false,
        heartbeat: true,
      },
    },
  }))

  return {
    feedAudio: (pcm16Chunk) => {
      if (closed || committing || cancelled || pcm16Chunk.byteLength === 0) return
      if (!started) {
        if (pendingAudioBytes + pcm16Chunk.byteLength <= MAX_PRE_START_BUFFER_BYTES) {
          pendingAudio.push(pcm16Chunk)
          pendingAudioBytes += pcm16Chunk.byteLength
        }
        return
      }
      socket.sendBinary(pcm16Chunk)
    },
    commit: () => {
      if (closed || committing || cancelled) return
      committing = true
      if (started) {
        sendFinishTask()
      } else {
        // Wait briefly for `task-started` to flush buffered audio, then finish.
        clearTimers()
        finishTimer = setTimeout(() => {
          if (options.mode === 'hold' && !cancelled) {
            finalizeHoldTurn()
          } else {
            shutdown('commit-before-start-timeout')
          }
        }, finishTimeoutMs)
      }
    },
    cancel: () => {
      cancelled = true
      shutdown('cancelled')
    },
    close: () => {
      if (closed) return
      if (started && !committing && !cancelled) {
        committing = true
        try {
          sendFinishTask()
          return
        } catch {
          // Fall through to hard close
        }
      }
      shutdown('closed')
    },
  }
}

export { VoiceServiceError }
