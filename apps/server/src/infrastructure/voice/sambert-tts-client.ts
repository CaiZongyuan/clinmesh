import { randomUUID } from 'node:crypto'
import { VOICE_SAMPLE_RATE, type SambertVoiceId } from '@clinmesh/contracts/voice'
import {
  VoiceServiceError,
  type ConnectVoiceUpstream,
  type ResolvedBailianCredentials,
} from './bailian-voice-config.ts'

const DEFAULT_TTS_TIMEOUT_MS = 25_000
const MAX_WAV_BYTES = 16 * 1024 * 1024 // 16 MiB defensive cap

function readAscii4(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  )
}

/**
 * DashScope Sambert streams WAV audio with sentinel chunk sizes (0x7fffffbf / 0x7fffff9b)
 * in the initial RIFF header. Once `task-finished` arrives, we patch RIFF and `data` chunk
 * sizes to the exact received byte lengths so browser Audio elements and Web Audio decode cleanly.
 */
export function repairFinishedWav(raw: Uint8Array): Uint8Array {
  if (raw.byteLength < 44) {
    throw new VoiceServiceError('VOICE_INVALID_AUDIO', 'Sambert returned truncated WAV audio')
  }
  if (readAscii4(raw, 0) !== 'RIFF' || readAscii4(raw, 8) !== 'WAVE') {
    throw new VoiceServiceError('VOICE_INVALID_AUDIO', 'Sambert response did not contain a valid RIFF/WAVE header')
  }

  const copy = new Uint8Array(raw.byteLength)
  copy.set(raw)
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength)

  // Patch top-level RIFF chunk size (fileLength - 8)
  view.setUint32(4, copy.byteLength - 8, true)

  // Locate the `data` subchunk dynamically to support headers larger than 44 bytes (e.g., LIST/FACT)
  let offset = 12
  let foundData = false
  while (offset + 8 <= copy.byteLength) {
    const chunkId = readAscii4(copy, offset)
    const declaredSize = view.getUint32(offset + 4, true)
    if (chunkId === 'data') {
      const actualDataSize = copy.byteLength - (offset + 8)
      view.setUint32(offset + 4, actualDataSize, true)
      foundData = true
      break
    }
    const nextOffset = offset + 8 + declaredSize + (declaredSize % 2)
    if (nextOffset <= offset || nextOffset > copy.byteLength) break
    offset = nextOffset
  }

  if (!foundData) {
    throw new VoiceServiceError('VOICE_INVALID_AUDIO', 'Sambert WAV stream was missing the data subchunk')
  }

  return copy
}

function concatChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const merged = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

export interface SynthesizeSambertOptions {
  credentials: ResolvedBailianCredentials
  connectUpstream: ConnectVoiceUpstream
  text: string
  voice: SambertVoiceId
  rate?: number | undefined
  pitch?: number | undefined
  volume?: number | undefined
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}

interface DashScopeControlEvent {
  header?: {
    event?: string
    error_code?: string
    error_message?: string
  }
}

/**
 * Synthesizes complete WAV audio using Alibaba Cloud Bailian Sambert WebSocket protocol.
 * Protocol invariant: send ONE `run-task` with complete text and NEVER send `finish-task`.
 */
export async function synthesizeSambertWav(options: SynthesizeSambertOptions): Promise<Uint8Array> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS
  const socket = await options.connectUpstream(options.credentials, options.signal)
  const taskId = randomUUID().replaceAll('-', '')

  return await new Promise<Uint8Array>((resolvePromise, rejectPromise) => {
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    let settled = false

    const finish = (outcome: { ok: true; wav: Uint8Array } | { ok: false; error: Error }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      socket.close(1000, outcome.ok ? 'done' : 'error')
      if (outcome.ok) resolvePromise(outcome.wav)
      else rejectPromise(outcome.error)
    }

    const onAbort = () => {
      finish({
        ok: false,
        error: new VoiceServiceError('VOICE_SESSION_ABORTED', 'TTS request was cancelled'),
      })
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: new VoiceServiceError('VOICE_UPSTREAM_TIMEOUT', 'Sambert speech synthesis timed out'),
      })
    }, timeoutMs)

    socket.onBinary((chunk) => {
      if (settled) return
      totalBytes += chunk.byteLength
      if (totalBytes > MAX_WAV_BYTES) {
        finish({
          ok: false,
          error: new VoiceServiceError('VOICE_INVALID_AUDIO', 'Sambert audio response exceeded maximum size limit'),
        })
        return
      }
      chunks.push(chunk)
    })

    socket.onText((payload) => {
      if (settled) return
      let parsed: DashScopeControlEvent
      try {
        parsed = JSON.parse(payload) as DashScopeControlEvent
      } catch {
        return
      }
      const event = parsed.header?.event
      if (event === 'task-finished') {
        try {
          const wav = repairFinishedWav(concatChunks(chunks, totalBytes))
          finish({ ok: true, wav })
        } catch (error) {
          finish({
            ok: false,
            error: error instanceof Error
              ? error
              : new VoiceServiceError('VOICE_INVALID_AUDIO', 'Failed to finalize WAV audio'),
          })
        }
        return
      }
      if (event === 'task-failed') {
        const code = parsed.header?.error_code ?? 'TASK_FAILED'
        const message = parsed.header?.error_message ?? 'Sambert synthesis failed'
        finish({
          ok: false,
          error: new VoiceServiceError('VOICE_UPSTREAM_FAILED', `${code}: ${message}`),
        })
      }
    })

    socket.onError((error) => {
      finish({
        ok: false,
        error: new VoiceServiceError('VOICE_UPSTREAM_FAILED', error.message || 'Sambert socket error'),
      })
    })

    socket.onClose((code, reason) => {
      if (settled) return
      finish({
        ok: false,
        error: new VoiceServiceError(
          'VOICE_UPSTREAM_FAILED',
          `Sambert stream closed before task-finished (code ${code}${reason ? `: ${reason}` : ''})`,
        ),
      })
    })

    // Sambert protocol: single `run-task` with complete `input.text`, `streaming: 'out'`, NO `finish-task`.
    socket.sendText(JSON.stringify({
      header: {
        action: 'run-task',
        task_id: taskId,
        streaming: 'out',
      },
      payload: {
        task_group: 'audio',
        task: 'tts',
        function: 'SpeechSynthesizer',
        model: options.voice,
        input: {
          text: options.text,
        },
        parameters: {
          text_type: 'PlainText',
          format: 'wav',
          sample_rate: VOICE_SAMPLE_RATE,
          volume: options.volume ?? 50,
          rate: options.rate ?? 1,
          pitch: options.pitch ?? 1,
        },
      },
    }))
  })
}
