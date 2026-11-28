import {
  VOICE_TTS_MAX_TEXT_LENGTH,
  voiceConfigResponseSchema,
  type VoiceConfigResponse,
  type VoiceSynthesizeRequest,
} from '@clinmesh/contracts/voice'
import { buildVoiceRequestHeaders, readVoiceSettings, type StoredVoiceSettings } from './voice-settings-storage.ts'

export class VoiceApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'VoiceApiError'
    this.code = code
    this.status = status
  }
}

async function parseErrorResponse(response: Response): Promise<VoiceApiError> {
  try {
    const json = await response.json() as { error?: { code?: unknown; message?: unknown } }
    const code = typeof json.error?.code === 'string' ? json.error.code : 'VOICE_REQUEST_FAILED'
    const message = typeof json.error?.message === 'string' ? json.error.message : `Voice request failed (${response.status})`
    return new VoiceApiError(code, message, response.status)
  } catch {
    return new VoiceApiError('VOICE_REQUEST_FAILED', `Voice request failed (${response.status})`, response.status)
  }
}

export async function getVoiceConfig(
  signal?: AbortSignal,
  settings: StoredVoiceSettings = readVoiceSettings(),
): Promise<VoiceConfigResponse> {
  const response = await fetch('/api/voice/config', {
    method: 'GET',
    credentials: 'same-origin',
    headers: buildVoiceRequestHeaders(settings),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    throw await parseErrorResponse(response)
  }
  return voiceConfigResponseSchema.parse(await response.json())
}

export async function synthesizeSpeechWav(
  request: VoiceSynthesizeRequest,
  signal?: AbortSignal,
  settings: StoredVoiceSettings = readVoiceSettings(),
): Promise<Blob> {
  const response = await fetch('/api/voice/tts', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...buildVoiceRequestHeaders(settings),
    },
    body: JSON.stringify(request),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    throw await parseErrorResponse(response)
  }
  return await response.blob()
}

export function buildVoiceSttWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/voice/stt`
}

/**
 * Splits long text into natural sentence chunks under the Sambert synthesis limit so
 * the first sentence begins playing quickly and long replies never fail length validation.
 */
export function splitIntoSpeechChunks(
  rawText: string,
  maxChars = 360,
): string[] {
  const limit = Math.max(40, Math.min(maxChars, VOICE_TTS_MAX_TEXT_LENGTH))
  const normalized = rawText
    .replaceAll(/\r\n?/g, '\n')
    .replaceAll(/[ \t]+/g, ' ')
    .trim()
  if (normalized.length === 0) return []
  if (normalized.length <= limit) return [normalized]

  const sentences = normalized
    .split(/(?<=[。！？；.!?\n])/)
    .map(part => part.trim())
    .filter(part => part.length > 0)

  const chunks: string[] = []
  let current = ''

  const pushOversized = (segment: string) => {
    for (let offset = 0; offset < segment.length; offset += limit) {
      chunks.push(segment.slice(offset, offset + limit))
    }
  }

  for (const sentence of sentences) {
    if (sentence.length > limit) {
      if (current.length > 0) {
        chunks.push(current)
        current = ''
      }
      pushOversized(sentence)
      continue
    }
    if (current.length === 0) {
      current = sentence
    } else if (current.length + 1 + sentence.length <= limit) {
      current = `${current}${/[a-zA-Z0-9]$/.test(current) ? ' ' : ''}${sentence}`
    } else {
      chunks.push(current)
      current = sentence
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}
