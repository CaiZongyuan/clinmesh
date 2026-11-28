import {
  CURATED_SAMBERT_VOICES,
  VOICE_SAMPLE_RATE,
  selectPatientSambertVoice,
  type SambertVoiceId,
  type VoiceCaptureMode,
  type VoiceConfigResponse,
  type VoiceSynthesizeRequest,
} from '@clinmesh/contracts/voice'
import {
  connectDashScopeWebSocket,
  defaultSambertVoiceOf,
  resolveBailianCredentials,
  VoiceServiceError,
  type ConnectVoiceUpstream,
  type ServerVoiceConfig,
  type VoiceCredentialOverrides,
} from '../infrastructure/voice/bailian-voice-config.ts'
import {
  createParaformerSession,
  type ParaformerSession,
  type ParaformerSessionCallbacks,
} from '../infrastructure/voice/paraformer-realtime-client.ts'
import { synthesizeSambertWav } from '../infrastructure/voice/sambert-tts-client.ts'

export interface VoiceServiceOptions {
  config?: ServerVoiceConfig | undefined
  connectUpstream?: ConnectVoiceUpstream | undefined
  now?: (() => Date) | undefined
}

export interface SynthesizedSpeechResult {
  wav: Uint8Array
  voice: SambertVoiceId
  rate: number
}

export class VoiceService {
  readonly #config: ServerVoiceConfig | undefined
  readonly #connectUpstream: ConnectVoiceUpstream
  readonly #now: () => Date

  constructor(options: VoiceServiceOptions = {}) {
    this.#config = options.config
    this.#connectUpstream = options.connectUpstream ?? connectDashScopeWebSocket
    this.#now = options.now ?? (() => new Date())
  }

  getConfig(overrides?: VoiceCredentialOverrides): VoiceConfigResponse {
    const serverTokenConfigured = (this.#config?.bailianToken?.trim().length ?? 0) > 0
    const resolved = resolveBailianCredentials(this.#config, overrides)
    const bailianConfigured = resolved !== null
    return {
      sttProvider: bailianConfigured ? 'paraformer-realtime-v2' : 'web-speech',
      ttsProvider: bailianConfigured ? 'sambert' : 'web-speech',
      bailianConfigured,
      serverTokenConfigured,
      defaultVoice: defaultSambertVoiceOf(this.#config),
      sampleRate: VOICE_SAMPLE_RATE,
      voices: [...CURATED_SAMBERT_VOICES],
    }
  }

  async synthesize(
    request: VoiceSynthesizeRequest,
    overrides?: VoiceCredentialOverrides,
    signal?: AbortSignal,
  ): Promise<SynthesizedSpeechResult> {
    const credentials = resolveBailianCredentials(this.#config, overrides)
    if (credentials === null) {
      throw new VoiceServiceError(
        'VOICE_PROVIDER_UNCONFIGURED',
        'Bailian voice token is not configured. Set BAILIAN_TOKEN on the server or provide a browser-local key in Settings > Models.',
        503,
      )
    }

    const patientSuggestion = selectPatientSambertVoice({
      gender: request.patientGender,
      birthDate: request.patientBirthDate,
      now: this.#now(),
    })
    const voice = request.voice ?? (
      request.patientGender !== undefined || request.patientBirthDate !== undefined
        ? patientSuggestion.voice
        : defaultSambertVoiceOf(this.#config)
    )
    const rate = request.rate ?? (
      request.voice === undefined && (request.patientGender !== undefined || request.patientBirthDate !== undefined)
        ? patientSuggestion.rate
        : 1.0
    )

    const wav = await synthesizeSambertWav({
      credentials,
      connectUpstream: this.#connectUpstream,
      text: request.text,
      voice,
      rate,
      pitch: request.pitch,
      volume: request.volume,
      signal,
    })

    return { wav, voice, rate }
  }

  async openSttSession(input: {
    mode: VoiceCaptureMode
    languageHints?: readonly ('zh' | 'en')[] | undefined
    overrides?: VoiceCredentialOverrides | undefined
    callbacks: ParaformerSessionCallbacks
  }): Promise<ParaformerSession> {
    const credentials = resolveBailianCredentials(this.#config, input.overrides)
    if (credentials === null) {
      throw new VoiceServiceError(
        'VOICE_PROVIDER_UNCONFIGURED',
        'Bailian voice token is not configured. Switch to Web Speech fallback or configure BAILIAN_TOKEN.',
        503,
      )
    }
    return await createParaformerSession({
      credentials,
      connectUpstream: this.#connectUpstream,
      mode: input.mode,
      languageHints: input.languageHints,
      callbacks: input.callbacks,
    })
  }
}
