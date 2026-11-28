import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  VOICE_RUNTIME_HEADERS,
  selectPatientSambertVoice,
  voiceConfigResponseSchema,
  voiceSttServerMessageSchema,
  type VoiceSttServerMessage,
} from '@clinmesh/contracts/voice'
import { createClinMeshRuntime } from '../src/runtime.ts'
import { startServer } from '../src/server.ts'
import type {
  ConnectVoiceUpstream,
  ResolvedBailianCredentials,
  VoiceUpstreamSocket,
} from '../src/infrastructure/voice/bailian-voice-config.ts'
import { createParaformerSession } from '../src/infrastructure/voice/paraformer-realtime-client.ts'
import {
  repairFinishedWav,
  synthesizeSambertWav,
} from '../src/infrastructure/voice/sambert-tts-client.ts'

interface FakeUpstreamController {
  socket: VoiceUpstreamSocket
  sentText: string[]
  sentBinary: Uint8Array[]
  closed: boolean
  onClientText: (handler: (payload: string) => void) => void
  emitText: (event: unknown) => void
  emitBinary: (chunk: Uint8Array) => void
  emitClose: (code?: number, reason?: string) => void
  emitError: (error: Error) => void
}

function createFakeUpstream(): FakeUpstreamController {
  const sentText: string[] = []
  const sentBinary: Uint8Array[] = []
  const clientTextHandlers: Array<(payload: string) => void> = []
  const textHandlers: Array<(payload: string) => void> = []
  const binaryHandlers: Array<(chunk: Uint8Array) => void> = []
  const closeHandlers: Array<(code: number, reason: string) => void> = []
  const errorHandlers: Array<(error: Error) => void> = []
  const controller: FakeUpstreamController = {
    sentText,
    sentBinary,
    closed: false,
    onClientText: (handler) => { clientTextHandlers.push(handler) },
    socket: {
      sendText: (payload) => {
        sentText.push(payload)
        for (const handler of clientTextHandlers) handler(payload)
      },
      sendBinary: (chunk) => { sentBinary.push(new Uint8Array(chunk)) },
      close: () => { controller.closed = true },
      onText: (handler) => { textHandlers.push(handler) },
      onBinary: (handler) => { binaryHandlers.push(handler) },
      onClose: (handler) => { closeHandlers.push(handler) },
      onError: (handler) => { errorHandlers.push(handler) },
    },
    emitText: (event) => {
      const payload = typeof event === 'string' ? event : JSON.stringify(event)
      for (const handler of textHandlers) handler(payload)
    },
    emitBinary: (chunk) => {
      for (const handler of binaryHandlers) handler(chunk)
    },
    emitClose: (code = 1000, reason = '') => {
      for (const handler of closeHandlers) handler(code, reason)
    },
    emitError: (error) => {
      for (const handler of errorHandlers) handler(error)
    },
  }
  return controller
}

function makeSentinelWav(pcmPayloadBytes: number, withListChunk = false): Uint8Array {
  const listChunk = withListChunk
    ? (() => {
        const bytes = new Uint8Array(12)
        bytes.set(Buffer.from('LIST', 'ascii'), 0)
        new DataView(bytes.buffer).setUint32(4, 4, true)
        bytes.set(Buffer.from('INFO', 'ascii'), 8)
        return bytes
      })()
    : new Uint8Array(0)

  const headerSize = 12 + 24 + listChunk.byteLength + 8
  const raw = new Uint8Array(headerSize + pcmPayloadBytes)
  const view = new DataView(raw.buffer)
  raw.set(Buffer.from('RIFF', 'ascii'), 0)
  view.setUint32(4, 0x7fffffbf, true) // Sambert streaming sentinel
  raw.set(Buffer.from('WAVE', 'ascii'), 8)
  raw.set(Buffer.from('fmt ', 'ascii'), 12)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, 16_000, true)
  view.setUint32(28, 32_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)

  let offset = 36
  if (listChunk.byteLength > 0) {
    raw.set(listChunk, offset)
    offset += listChunk.byteLength
  }
  raw.set(Buffer.from('data', 'ascii'), offset)
  view.setUint32(offset + 4, 0x7fffff9b, true) // Sambert streaming sentinel
  for (let i = 0; i < pcmPayloadBytes; i += 1) {
    raw[offset + 8 + i] = i % 251
  }
  return raw
}

const activeRuntimes: Array<Awaited<ReturnType<typeof createClinMeshRuntime>>> = []
const tempDirectories: string[] = []
afterEach(async () => {
  await Promise.all(activeRuntimes.splice(0).map(rt => rt.close().catch(() => undefined)))
  while (tempDirectories.length > 0) {
    const dir = tempDirectories.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('Voice protocol helpers (WAV repair & patient voice matching)', () => {
  it('repairs Sambert streaming WAV sentinel sizes for standard and extra-chunk headers', () => {
    const rawStandard = makeSentinelWav(640, false)
    const repairedStandard = repairFinishedWav(rawStandard)
    const viewStandard = new DataView(repairedStandard.buffer, repairedStandard.byteOffset, repairedStandard.byteLength)
    expect(viewStandard.getUint32(4, true)).toBe(rawStandard.byteLength - 8)
    expect(viewStandard.getUint32(40, true)).toBe(640)

    const rawWithList = makeSentinelWav(320, true)
    const repairedWithList = repairFinishedWav(rawWithList)
    const viewWithList = new DataView(repairedWithList.buffer, repairedWithList.byteOffset, repairedWithList.byteLength)
    expect(viewWithList.getUint32(4, true)).toBe(rawWithList.byteLength - 8)
    // `data` size sits right after 36 + 12 = 48 + 4 = 52
    expect(viewWithList.getUint32(52, true)).toBe(320)
  })

  it('rejects truncated or non-WAV buffers', () => {
    expect(() => repairFinishedWav(new Uint8Array(12))).toThrow(/truncated/i)
    const fake = new Uint8Array(64)
    fake.set(Buffer.from('OggS', 'ascii'), 0)
    expect(() => repairFinishedWav(fake)).toThrow(/RIFF\/WAVE/i)
  })

  it('selects age- and gender-appropriate Sambert voices', () => {
    const now = new Date('2026-11-28T00:00:00Z')
    expect(selectPatientSambertVoice({ gender: 'female', birthDate: '2018-04-01', now }).voice).toBe('sambert-zhiying-v1')
    expect(selectPatientSambertVoice({ gender: 'female', birthDate: '1958-01-01', now })).toEqual({
      voice: 'sambert-zhistella-v1',
      rate: 0.92,
    })
    expect(selectPatientSambertVoice({ gender: 'male', birthDate: '1990-05-10', now })).toEqual({
      voice: 'sambert-zhishuo-v1',
      rate: 1.0,
    })
    expect(selectPatientSambertVoice({ gender: 'male', birthDate: '1955-05-10', now })).toEqual({
      voice: 'sambert-zhishu-v1',
      rate: 0.92,
    })
  })
})

describe('Sambert TTS & Paraformer STT upstream clients', () => {
  const credentials: ResolvedBailianCredentials = {
    token: 'test-bailian-secret-token',
    wsUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    source: 'server',
  }

  it('synthesizes WAV with a single run-task and NEVER sends finish-task', async () => {
    const fake = createFakeUpstream()
    const rawWav = makeSentinelWav(400)
    const connectUpstream: ConnectVoiceUpstream = async () => fake.socket

    const promise = synthesizeSambertWav({
      credentials,
      connectUpstream,
      text: '医生您好，我胸口闷了两天。',
      voice: 'sambert-zhiyue-v1',
      rate: 0.95,
    })

    // Let run-task send
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fake.sentText).toHaveLength(1)
    const runTask = JSON.parse(fake.sentText[0]!) as {
      header: { action: string; streaming: string }
      payload: { model: string; input: { text: string }; parameters: { format: string; rate: number } }
    }
    expect(runTask.header.action).toBe('run-task')
    expect(runTask.header.streaming).toBe('out')
    expect(runTask.payload.model).toBe('sambert-zhiyue-v1')
    expect(runTask.payload.parameters.format).toBe('wav')
    expect(runTask.payload.parameters.rate).toBe(0.95)

    fake.emitText({ header: { event: 'task-started' } })
    fake.emitBinary(rawWav.subarray(0, 128))
    fake.emitBinary(rawWav.subarray(128))
    fake.emitText({ header: { event: 'task-finished' } })

    const wav = await promise
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    expect(view.getUint32(4, true)).toBe(rawWav.byteLength - 8)
    expect(view.getUint32(40, true)).toBe(400)
    // Verify protocol invariant: NO finish-task was ever sent to Sambert.
    expect(fake.sentText).toHaveLength(1)
    expect(fake.closed).toBe(true)
  })

  it('buffers Paraformer PCM frames until task-started and supports continuous & hold modes', async () => {
    const fakeContinuous = createFakeUpstream()
    const interims: string[] = []
    const finals: string[] = []
    let readyCount = 0

    const session = await createParaformerSession({
      credentials,
      connectUpstream: async () => fakeContinuous.socket,
      mode: 'continuous',
      callbacks: {
        onReady: () => { readyCount += 1 },
        onInterim: (text) => { interims.push(text) },
        onFinal: (text) => { finals.push(text) },
        onEmpty: () => {},
        onError: () => {},
      },
    })

    const chunk1 = new Uint8Array([1, 2, 3, 4])
    const chunk2 = new Uint8Array([5, 6, 7, 8])
    session.feedAudio(chunk1)
    expect(fakeContinuous.sentBinary).toHaveLength(0)

    fakeContinuous.emitText({ header: { event: 'task-started' } })
    expect(readyCount).toBe(1)
    expect(fakeContinuous.sentBinary).toHaveLength(1)
    expect(Array.from(fakeContinuous.sentBinary[0]!)).toEqual([1, 2, 3, 4])

    session.feedAudio(chunk2)
    expect(fakeContinuous.sentBinary).toHaveLength(2)

    // Heartbeat must be ignored
    fakeContinuous.emitText({
      header: { event: 'result-generated' },
      payload: { output: { sentence: { text: 'noise', heartbeat: true, sentence_end: true } } },
    })
    fakeContinuous.emitText({
      header: { event: 'result-generated' },
      payload: { output: { sentence: { text: '请问发热', sentence_end: false } } },
    })
    fakeContinuous.emitText({
      header: { event: 'result-generated' },
      payload: { output: { sentence: { text: '请问发热几天了？', sentence_end: true } } },
    })

    expect(interims).toEqual(['请问发热'])
    expect(finals).toEqual(['请问发热几天了？'])
    session.cancel()

    // Hold mode stitches multiple sentences and emits one final on commit -> task-finished
    const fakeHold = createFakeUpstream()
    const holdInterims: string[] = []
    const holdFinals: string[] = []

    const holdSession = await createParaformerSession({
      credentials,
      connectUpstream: async () => fakeHold.socket,
      mode: 'hold',
      callbacks: {
        onReady: () => {},
        onInterim: (text) => { holdInterims.push(text) },
        onFinal: (text) => { holdFinals.push(text) },
        onEmpty: () => {},
        onError: () => {},
      },
    })

    fakeHold.emitText({ header: { event: 'task-started' } })
    fakeHold.emitText({
      header: { event: 'result-generated' },
      payload: { output: { sentence: { text: '最近有没有胸痛，', sentence_end: true } } },
    })
    fakeHold.emitText({
      header: { event: 'result-generated' },
      payload: { output: { sentence: { text: '活动后气促？', sentence_end: false } } },
    })
    expect(holdFinals).toEqual([])
    expect(holdInterims.at(-1)).toBe('最近有没有胸痛，活动后气促？')

    holdSession.commit()
    expect(fakeHold.sentText.some(item => item.includes('"action":"finish-task"'))).toBe(true)
    fakeHold.emitText({ header: { event: 'task-finished' } })
    expect(holdFinals).toEqual(['最近有没有胸痛，活动后气促？'])
  })
})

describe('Voice HTTP routes & authenticated /api/voice/stt WebSocket', () => {
  async function createSignedInRuntime(options?: {
    bailianToken?: string
    connectUpstream?: ConnectVoiceUpstream
  }) {
    const dir = mkdtempSync(join(tmpdir(), 'clinmesh-voice-test-'))
    tempDirectories.push(dir)
    const runtime = await createClinMeshRuntime({
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-32-characters-minimum-0001',
      cursorSecret: 'test-cursor-secret-32-characters-minimum-01',
      databasePath: join(dir, 'clinmesh.sqlite'),
      demoPassword: 'ClinMesh-test-password-2026!',
      localProviders: { enabled: false },
      migrationMode: 'apply',
      trustedOrigins: ['http://localhost'],
      ...(options?.bailianToken ? { voice: { bailianToken: options.bailianToken } } : {}),
      ...(options?.connectUpstream ? { voiceConnectUpstream: options.connectUpstream } : {}),
    })
    activeRuntimes.push(runtime)

    const signInResponse = await runtime.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost',
      },
      body: JSON.stringify({
        email: 'doctor@demo.clinmesh.local',
        password: 'ClinMesh-test-password-2026!',
      }),
    })
    expect(signInResponse.status).toBe(200)
    const rawSetCookie = signInResponse.headers.get('set-cookie') ?? ''
    const cookie = rawSetCookie.split(';')[0] ?? ''
    expect(cookie.length).toBeGreaterThan(0)
    return { runtime, cookie }
  }

  it('serves /api/voice/config safely without leaking secrets and enforces auth on /api/voice/tts', async () => {
    const rawWav = makeSentinelWav(256)
    const seenTokens: string[] = []
    const connectUpstream: ConnectVoiceUpstream = async (creds) => {
      seenTokens.push(creds.token)
      const fakeTts = createFakeUpstream()
      fakeTts.onClientText((payload) => {
        if (payload.includes('"action":"run-task"')) {
          fakeTts.emitText({ header: { event: 'task-started' } })
          fakeTts.emitBinary(rawWav)
          fakeTts.emitText({ header: { event: 'task-finished' } })
        }
      })
      return fakeTts.socket
    }

    const { runtime, cookie } = await createSignedInRuntime({ connectUpstream })
    // Unauthenticated request rejected
    const unauth = await runtime.app.request('/api/voice/config')
    expect(unauth.status).toBe(401)

    // No token configured -> web-speech fallback
    const configRes = await runtime.app.request('/api/voice/config', {
      headers: { Cookie: cookie },
    })
    expect(configRes.status).toBe(200)
    const configData = voiceConfigResponseSchema.parse(await configRes.json())
    expect(configData.sttProvider).toBe('web-speech')
    expect(configData.ttsProvider).toBe('web-speech')
    expect(configData.bailianConfigured).toBe(false)

    // TTS without token returns 503 VOICE_PROVIDER_UNCONFIGURED
    const unconfiguredTts = await runtime.app.request('/api/voice/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: 'http://localhost',
      },
      body: JSON.stringify({ text: '测试语音' }),
    })
    expect(unconfiguredTts.status).toBe(503)
    const unconfiguredJson = await unconfiguredTts.json() as { error: { code: string } }
    expect(unconfiguredJson.error.code).toBe('VOICE_PROVIDER_UNCONFIGURED')

    // BYOK header enables Paraformer + Sambert and never echoes the token back
    const byokSecret = 'sk-byok-secret-never-leak-12345'
    const byokConfigRes = await runtime.app.request('/api/voice/config', {
      headers: {
        Cookie: cookie,
        [VOICE_RUNTIME_HEADERS.apiKey]: byokSecret,
      },
    })
    const byokConfigText = await byokConfigRes.text()
    expect(byokConfigText).not.toContain(byokSecret)
    const byokConfig = voiceConfigResponseSchema.parse(JSON.parse(byokConfigText))
    expect(byokConfig.sttProvider).toBe('paraformer-realtime-v2')
    expect(byokConfig.ttsProvider).toBe('sambert')
    expect(byokConfig.bailianConfigured).toBe(true)

    // BYOK TTS returns repaired audio/wav and auto-matched female voice header
    const ttsRes = await runtime.app.request('/api/voice/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: 'http://localhost',
        [VOICE_RUNTIME_HEADERS.apiKey]: byokSecret,
      },
      body: JSON.stringify({
        text: '医生您好，我今天有点头晕。',
        patientGender: 'female',
        patientBirthDate: '1988-06-12',
      }),
    })
    expect(ttsRes.status).toBe(200)
    expect(ttsRes.headers.get('content-type')).toBe('audio/wav')
    expect(ttsRes.headers.get('x-clinmesh-voice-model')).toBe('sambert-zhiyue-v1')
    const wavBytes = new Uint8Array(await ttsRes.arrayBuffer())
    const wavView = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength)
    expect(wavView.getUint32(4, true)).toBe(wavBytes.byteLength - 8)
    expect(wavView.getUint32(40, true)).toBe(256)
    expect(seenTokens).toEqual([byokSecret])
  })

  it('authenticates /api/voice/stt WebSocket upgrades and streams PCM16 -> Paraformer transcripts', async () => {
    const fakeStt = createFakeUpstream()
    fakeStt.onClientText((payload) => {
      if (payload.includes('"action":"run-task"')) {
        fakeStt.emitText({ header: { event: 'task-started' } })
      } else if (payload.includes('"action":"finish-task"')) {
        fakeStt.emitText({ header: { event: 'task-finished' } })
      }
    })
    const connectUpstream: ConnectVoiceUpstream = async () => fakeStt.socket

    const { runtime, cookie } = await createSignedInRuntime({
      bailianToken: 'server-bailian-token-xyz',
      connectUpstream,
    })
    const server = startServer({
      app: runtime.app,
      hostname: '127.0.0.1',
      identity: runtime.identity,
      port: 0,
      voice: runtime.voice,
    })

    await new Promise<void>(resolve => server.once('listening', () => resolve()))
    const address = server.address() as AddressInfo
    const wsUrl = `ws://127.0.0.1:${address.port}/api/voice/stt`

    try {
      // 1. Reject unauthenticated upgrade
      const unauthStatus = await new Promise<number>((resolve) => {
        const client = new WebSocket(wsUrl, {
          headers: { Origin: 'http://localhost' },
        })
        client.once('unexpected-response', (_req, res) => {
          resolve(res.statusCode ?? 0)
          client.terminate()
        })
        client.once('error', () => resolve(401))
      })
      expect(unauthStatus).toBe(401)

      // 2. Authenticated upgrade with trusted Origin succeeds and relays events
      const received: VoiceSttServerMessage[] = []
      await new Promise<void>((resolve, reject) => {
        const client = new WebSocket(wsUrl, {
          headers: {
            Cookie: cookie,
            Origin: 'http://localhost',
          },
        })
        client.once('error', reject)
        client.once('open', () => {
          client.send(JSON.stringify({ type: 'start', mode: 'hold', sampleRate: 16_000 }))
        })
        client.on('message', (data) => {
          const parsed = voiceSttServerMessageSchema.parse(JSON.parse(String(data)))
          received.push(parsed)
          if (parsed.type === 'ready') {
            client.send(new Uint8Array([10, 20, 30, 40]), { binary: true })
            setTimeout(() => {
              fakeStt.emitText({
                header: { event: 'result-generated' },
                payload: { output: { sentence: { text: '胸闷持续两天', sentence_end: true } } },
              })
              client.send(JSON.stringify({ type: 'commit' }))
            }, 20)
          } else if (parsed.type === 'final') {
            client.close()
            resolve()
          }
        })
      })

      expect(received.map(item => item.type)).toEqual(['ready', 'interim', 'final'])
      expect(received[2]).toEqual({ type: 'final', text: '胸闷持续两天' })
      expect(fakeStt.sentBinary.length).toBeGreaterThanOrEqual(1)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
