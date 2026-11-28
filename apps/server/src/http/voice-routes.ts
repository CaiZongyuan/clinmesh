import type { IncomingMessage } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context, Hono } from 'hono'
import { WebSocket, WebSocketServer } from 'ws'
import {
  voiceSttClientMessageSchema,
  voiceSynthesizeRequestSchema,
  type VoiceSttServerMessage,
} from '@clinmesh/contracts/voice'
import { IdentityError, type IdentityService } from '../application/identity-service.ts'
import type { VoiceService } from '../application/voice-service.ts'
import {
  extractVoiceCredentialOverrides,
  VoiceServiceError,
} from '../infrastructure/voice/bailian-voice-config.ts'
import type { ParaformerSession } from '../infrastructure/voice/paraformer-realtime-client.ts'

const MAX_STT_SESSION_MS = 10 * 60 * 1_000
const MAX_PENDING_BINARY_BYTES = 128 * 1024
const MAX_WS_PAYLOAD_BYTES = 256 * 1024

export function registerVoiceRoutes(
  app: Hono,
  options: {
    identity: IdentityService
    voice: VoiceService
    apiErrorResponse: (context: Context, error: unknown, invalidInputMessage?: string) => Response
  },
): void {
  const { identity, voice, apiErrorResponse } = options

  app.get('/api/voice/config', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      await identity.resolveSessionContext(context.req.raw.headers)
      const overrides = extractVoiceCredentialOverrides(context.req.raw.headers)
      return context.json(voice.getConfig(overrides))
    } catch (error) {
      return apiErrorResponse(context, error)
    }
  })

  app.post('/api/voice/tts', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      await identity.resolveSessionContext(context.req.raw.headers)
      const body = voiceSynthesizeRequestSchema.parse(await context.req.json())
      const overrides = extractVoiceCredentialOverrides(context.req.raw.headers)
      const result = await voice.synthesize(body, overrides, context.req.raw.signal)
      const wavBuffer = new ArrayBuffer(result.wav.byteLength)
      new Uint8Array(wavBuffer).set(result.wav)
      return new Response(wavBuffer, {
        status: 200,
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'audio/wav',
          'X-ClinMesh-Voice-Model': result.voice,
        },
      })
    } catch (error) {
      return apiErrorResponse(context, error, 'The voice synthesis request is invalid')
    }
  })
}

function incomingMessageToHeaders(request: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else {
      headers.set(key, value)
    }
  }
  return headers
}

function rejectUpgrade(socket: Duplex, status: 401 | 403 | 500, message: string): void {
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Internal Server Error'
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Type: text/plain; charset=utf-8\r\n'
      + `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`
      + message,
    )
  } catch {
    // Socket may already be closed
  }
  socket.destroy()
}

function rawDataToUint8Array(data: WebSocket.RawData): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) {
    const total = data.reduce((sum, item) => sum + item.byteLength, 0)
    const merged = new Uint8Array(total)
    let offset = 0
    for (const item of data) {
      merged.set(item, offset)
      offset += item.byteLength
    }
    return merged
  }
  return new Uint8Array(0)
}

function sendJson(ws: WebSocket, message: VoiceSttServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message))
  }
}

function handleVoiceSttConnection(ws: WebSocket, voice: VoiceService): void {
  let activeSession: ParaformerSession | null = null
  let openingPromise: Promise<void> | null = null
  let generation = 0
  let closed = false
  let pendingBinaryBytes = 0
  const pendingBinary: Uint8Array[] = []

  const clearPendingBinary = () => {
    pendingBinary.length = 0
    pendingBinaryBytes = 0
  }

  const teardownSession = (mode: 'close' | 'cancel') => {
    generation += 1
    clearPendingBinary()
    const current = activeSession
    activeSession = null
    if (current !== null) {
      if (mode === 'cancel') current.cancel()
      else current.close()
    }
  }

  const lifetimeTimer = setTimeout(() => {
    sendJson(ws, {
      type: 'error',
      code: 'VOICE_SESSION_TIMEOUT',
      message: 'Voice recognition session reached the 10-minute safety limit.',
    })
    teardownSession('close')
    try { ws.close(1000, 'session-timeout') } catch { /* ignore */ }
  }, MAX_STT_SESSION_MS)

  ws.on('close', () => {
    closed = true
    clearTimeout(lifetimeTimer)
    teardownSession('cancel')
  })

  ws.on('error', () => {
    closed = true
    clearTimeout(lifetimeTimer)
    teardownSession('cancel')
  })

  ws.on('message', (data, isBinary) => {
    if (closed) return

    if (isBinary) {
      const chunk = rawDataToUint8Array(data)
      if (chunk.byteLength === 0) return
      if (activeSession !== null) {
        activeSession.feedAudio(chunk)
      } else if (openingPromise !== null && pendingBinaryBytes + chunk.byteLength <= MAX_PENDING_BINARY_BYTES) {
        pendingBinary.push(chunk)
        pendingBinaryBytes += chunk.byteLength
      }
      return
    }

    const rawText = typeof data === 'string'
      ? data
      : Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Buffer.from(rawDataToUint8Array(data)).toString('utf8')

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(rawText)
    } catch {
      sendJson(ws, { type: 'error', code: 'INVALID_MESSAGE', message: 'Voice control frame must be valid JSON.' })
      return
    }

    const parsed = voiceSttClientMessageSchema.safeParse(parsedJson)
    if (!parsed.success) {
      sendJson(ws, { type: 'error', code: 'INVALID_MESSAGE', message: 'Invalid voice control payload.' })
      return
    }

    const message = parsed.data
    if (message.type === 'start') {
      teardownSession('cancel')
      const currentGen = generation
      openingPromise = voice.openSttSession({
        mode: message.mode,
        languageHints: message.languageHints,
        overrides: {
          ...(message.apiKey === undefined ? {} : { apiKey: message.apiKey }),
          ...(message.workspace === undefined ? {} : { workspace: message.workspace }),
        },
        callbacks: {
          onReady: () => {
            if (closed || currentGen !== generation) return
            sendJson(ws, { type: 'ready', provider: 'paraformer-realtime-v2', mode: message.mode })
          },
          onInterim: (text) => {
            if (closed || currentGen !== generation) return
            sendJson(ws, { type: 'interim', text })
          },
          onFinal: (text) => {
            if (closed || currentGen !== generation) return
            sendJson(ws, { type: 'final', text })
          },
          onEmpty: () => {
            if (closed || currentGen !== generation) return
            sendJson(ws, { type: 'empty' })
          },
          onError: (code, errorMessage) => {
            if (closed || currentGen !== generation) return
            sendJson(ws, { type: 'error', code, message: errorMessage })
          },
        },
      }).then((session) => {
        if (closed || currentGen !== generation) {
          session.cancel()
          return
        }
        activeSession = session
        for (const chunk of pendingBinary) {
          session.feedAudio(chunk)
        }
        clearPendingBinary()
      }).catch((error: unknown) => {
        if (closed || currentGen !== generation) return
        clearPendingBinary()
        const code = error instanceof VoiceServiceError ? error.code : 'VOICE_UPSTREAM_FAILED'
        const errorMessage = error instanceof Error ? error.message : 'Failed to start voice recognition'
        sendJson(ws, { type: 'error', code, message: errorMessage })
      }).finally(() => {
        if (currentGen === generation) {
          openingPromise = null
        }
      })
      return
    }

    if (message.type === 'commit') {
      if (activeSession !== null) {
        activeSession.commit()
      } else if (openingPromise !== null) {
        const expectedGen = generation
        void openingPromise.then(() => {
          if (!closed && expectedGen === generation && activeSession !== null) {
            activeSession.commit()
          }
        })
      }
      return
    }

    if (message.type === 'cancel') {
      teardownSession('cancel')
      return
    }

    if (message.type === 'stop') {
      teardownSession('close')
    }
  })
}

export function attachVoiceSttWebSocket(
  server: HttpServer,
  options: {
    identity: IdentityService
    voice: VoiceService
  },
): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
  })

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    } catch {
      return
    }
    if (pathname !== '/api/voice/stt') return

    const headers = incomingMessageToHeaders(request)
    void (async () => {
      try {
        options.identity.assertTrustedMutation(headers)
        await options.identity.resolveSessionContext(headers)
      } catch (error) {
        if (error instanceof IdentityError) {
          rejectUpgrade(socket, error.status === 401 ? 401 : 403, error.message)
        } else {
          rejectUpgrade(socket, 401, 'Authentication required for voice stream')
        }
        return
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        handleVoiceSttConnection(ws, options.voice)
      })
    })()
  }

  server.on('upgrade', onUpgrade)
  server.once('close', () => {
    server.off('upgrade', onUpgrade)
    for (const client of wss.clients) {
      try { client.close(1001, 'server-closing') } catch { /* ignore */ }
    }
    wss.close()
  })

  return wss
}
