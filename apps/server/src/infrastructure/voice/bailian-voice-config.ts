import WebSocket from 'ws'
import {
  DEFAULT_SAMBERT_VOICE,
  VOICE_RUNTIME_HEADERS,
  type SambertVoiceId,
} from '@clinmesh/contracts/voice'

export const DEFAULT_DASHSCOPE_WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000

export class VoiceServiceError extends Error {
  readonly code:
    | 'VOICE_PROVIDER_UNCONFIGURED'
    | 'VOICE_UPSTREAM_AUTH_FAILED'
    | 'VOICE_UPSTREAM_FAILED'
    | 'VOICE_UPSTREAM_TIMEOUT'
    | 'VOICE_INVALID_AUDIO'
    | 'VOICE_SESSION_ABORTED'
  readonly status: 400 | 401 | 502 | 503 | 504

  constructor(
    code: VoiceServiceError['code'],
    message: string,
    status?: 400 | 401 | 502 | 503 | 504,
  ) {
    super(message)
    this.name = 'VoiceServiceError'
    this.code = code
    this.status = status ?? (
      code === 'VOICE_PROVIDER_UNCONFIGURED'
        ? 503
        : code === 'VOICE_UPSTREAM_AUTH_FAILED'
          ? 401
          : code === 'VOICE_UPSTREAM_TIMEOUT'
            ? 504
            : code === 'VOICE_SESSION_ABORTED'
              ? 400
              : 502
    )
  }
}

export interface ServerVoiceConfig {
  bailianToken?: string | undefined
  bailianWorkspace?: string | undefined
  bailianWsUrl?: string | undefined
  defaultVoice?: SambertVoiceId | undefined
}

export interface VoiceCredentialOverrides {
  apiKey?: string | undefined
  workspace?: string | undefined
}

export interface ResolvedBailianCredentials {
  token: string
  wsUrl: string
  workspace?: string | undefined
  source: 'byok' | 'server'
}

export interface VoiceUpstreamSocket {
  sendText: (payload: string) => void
  sendBinary: (chunk: Uint8Array) => void
  close: (code?: number, reason?: string) => void
  onText: (handler: (payload: string) => void) => void
  onBinary: (handler: (chunk: Uint8Array) => void) => void
  onClose: (handler: (code: number, reason: string) => void) => void
  onError: (handler: (error: Error) => void) => void
}

export type ConnectVoiceUpstream = (
  credentials: ResolvedBailianCredentials,
  signal?: AbortSignal,
) => Promise<VoiceUpstreamSocket>

export function extractVoiceCredentialOverrides(headers: Headers): VoiceCredentialOverrides {
  const apiKey = headers.get(VOICE_RUNTIME_HEADERS.apiKey)?.trim()
  const workspace = headers.get(VOICE_RUNTIME_HEADERS.workspace)?.trim()
  return {
    ...(apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {}),
    ...(workspace !== undefined && workspace.length > 0 ? { workspace } : {}),
  }
}

export function resolveBailianEndpoint(options: {
  wsUrl?: string | undefined
  workspace?: string | undefined
}): { wsUrl: string; workspace?: string | undefined } {
  const workspace = options.workspace?.trim()
  const explicitUrl = options.wsUrl?.trim()
  if (explicitUrl !== undefined && explicitUrl.length > 0) {
    return {
      wsUrl: explicitUrl,
      ...(workspace !== undefined && workspace.length > 0 ? { workspace } : {}),
    }
  }
  if (workspace !== undefined && workspace.length > 0) {
    return {
      wsUrl: `wss://${workspace}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`,
      workspace,
    }
  }
  return { wsUrl: DEFAULT_DASHSCOPE_WS_URL }
}

export function resolveBailianCredentials(
  serverConfig: ServerVoiceConfig | undefined,
  overrides: VoiceCredentialOverrides | undefined,
): ResolvedBailianCredentials | null {
  const byokToken = overrides?.apiKey?.trim()
  if (byokToken !== undefined && byokToken.length > 0) {
    const endpoint = resolveBailianEndpoint({
      wsUrl: serverConfig?.bailianWsUrl,
      workspace: overrides?.workspace ?? serverConfig?.bailianWorkspace,
    })
    return {
      token: byokToken,
      wsUrl: endpoint.wsUrl,
      ...(endpoint.workspace === undefined ? {} : { workspace: endpoint.workspace }),
      source: 'byok',
    }
  }
  const serverToken = serverConfig?.bailianToken?.trim()
  if (serverToken !== undefined && serverToken.length > 0) {
    const endpoint = resolveBailianEndpoint({
      wsUrl: serverConfig?.bailianWsUrl,
      workspace: overrides?.workspace ?? serverConfig?.bailianWorkspace,
    })
    return {
      token: serverToken,
      wsUrl: endpoint.wsUrl,
      ...(endpoint.workspace === undefined ? {} : { workspace: endpoint.workspace }),
      source: 'server',
    }
  }
  return null
}

export function defaultSambertVoiceOf(serverConfig: ServerVoiceConfig | undefined): SambertVoiceId {
  return serverConfig?.defaultVoice ?? DEFAULT_SAMBERT_VOICE
}

function toUint8Array(data: WebSocket.RawData): Uint8Array {
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

/**
 * Opens an authenticated DashScope inference WebSocket using Node `ws`.
 * Never leaks the Bearer token into error messages or URLs.
 */
export function connectDashScopeWebSocket(
  credentials: ResolvedBailianCredentials,
  signal?: AbortSignal,
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
): Promise<VoiceUpstreamSocket> {
  return new Promise<VoiceUpstreamSocket>((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new VoiceServiceError('VOICE_SESSION_ABORTED', 'Voice request was cancelled'))
      return
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials.token}`,
    }
    if (credentials.workspace !== undefined && credentials.workspace.length > 0) {
      headers['X-DashScope-WorkSpace'] = credentials.workspace
    }

    const ws = new WebSocket(credentials.wsUrl, {
      headers,
      handshakeTimeout: handshakeTimeoutMs,
    })

    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      try { ws.terminate() } catch { /* ignore */ }
      rejectPromise(new VoiceServiceError('VOICE_SESSION_ABORTED', 'Voice request was cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    ws.once('unexpected-response', (_req, res) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      try { ws.terminate() } catch { /* ignore */ }
      const statusCode = res.statusCode ?? 502
      if (statusCode === 401 || statusCode === 403) {
        rejectPromise(new VoiceServiceError(
          'VOICE_UPSTREAM_AUTH_FAILED',
          'Bailian voice API key was rejected (HTTP 401/403). Please verify your BAILIAN_TOKEN.',
          401,
        ))
        return
      }
      rejectPromise(new VoiceServiceError(
        'VOICE_UPSTREAM_FAILED',
        `Bailian voice upstream rejected handshake with HTTP ${statusCode}.`,
        502,
      ))
    })

    ws.once('error', (error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      const message = error.message || 'DashScope voice connection failed'
      const isTimeout = /timeout|timed out/i.test(message)
      rejectPromise(new VoiceServiceError(
        isTimeout ? 'VOICE_UPSTREAM_TIMEOUT' : 'VOICE_UPSTREAM_FAILED',
        isTimeout
          ? 'Timed out connecting to Bailian voice service.'
          : `Failed to connect to Bailian voice service: ${message}`,
      ))
    })

    ws.once('open', () => {
      if (settled) {
        try { ws.close() } catch { /* ignore */ }
        return
      }
      settled = true
      signal?.removeEventListener('abort', onAbort)

      const textHandlers = new Set<(payload: string) => void>()
      const binaryHandlers = new Set<(chunk: Uint8Array) => void>()
      const closeHandlers = new Set<(code: number, reason: string) => void>()
      const errorHandlers = new Set<(error: Error) => void>()

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const bytes = toUint8Array(data)
          for (const handler of binaryHandlers) handler(bytes)
        } else {
          const text = typeof data === 'string'
            ? data
            : Buffer.isBuffer(data)
              ? data.toString('utf8')
              : Buffer.from(toUint8Array(data)).toString('utf8')
          for (const handler of textHandlers) handler(text)
        }
      })

      ws.on('close', (code, reasonBuffer) => {
        const reason = reasonBuffer.toString('utf8')
        for (const handler of closeHandlers) handler(code, reason)
      })

      ws.on('error', (error) => {
        for (const handler of errorHandlers) handler(error)
      })

      resolvePromise({
        sendText: (payload) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload)
          }
        },
        sendBinary: (chunk) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(chunk, { binary: true })
          }
        },
        close: (code = 1000, reason = '') => {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            try { ws.close(code, reason) } catch { /* ignore */ }
          }
        },
        onText: (handler) => { textHandlers.add(handler) },
        onBinary: (handler) => { binaryHandlers.add(handler) },
        onClose: (handler) => { closeHandlers.add(handler) },
        onError: (handler) => { errorHandlers.add(handler) },
      })
    })
  })
}
