import {
  CURATED_SAMBERT_VOICES,
  DEFAULT_SAMBERT_VOICE,
  VOICE_SAMPLE_RATE,
  type VoiceConfigResponse,
} from '@clinmesh/contracts/voice'
import { useQuery } from '@tanstack/react-query'
import { getVoiceConfig } from './voice-api.ts'
import { useVoiceSettings } from './voice-settings-storage.ts'

export const FALLBACK_VOICE_CONFIG: VoiceConfigResponse = {
  sttProvider: 'web-speech',
  ttsProvider: 'web-speech',
  bailianConfigured: false,
  serverTokenConfigured: false,
  defaultVoice: DEFAULT_SAMBERT_VOICE,
  sampleRate: VOICE_SAMPLE_RATE,
  voices: [...CURATED_SAMBERT_VOICES],
}

export function useVoiceConfig() {
  const settings = useVoiceSettings()
  const hasByokKey = settings.apiKey.trim().length > 0
  const workspace = settings.workspace.trim()

  const query = useQuery({
    queryKey: ['voice-config', hasByokKey ? 'byok' : 'server', workspace],
    queryFn: ({ signal }) => getVoiceConfig(signal, settings),
    staleTime: 60_000,
    retry: false,
  })

  return {
    ...query,
    config: query.data ?? (hasByokKey
      ? {
          ...FALLBACK_VOICE_CONFIG,
          sttProvider: 'paraformer-realtime-v2' as const,
          ttsProvider: 'sambert' as const,
          bailianConfigured: true,
        }
      : FALLBACK_VOICE_CONFIG),
  }
}
