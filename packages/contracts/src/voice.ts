import { z } from 'zod'

export const VOICE_SAMPLE_RATE = 16_000 as const
export const VOICE_TTS_MAX_TEXT_LENGTH = 1_000 as const

export const VOICE_RUNTIME_HEADERS = {
  apiKey: 'x-clinmesh-voice-api-key',
  workspace: 'x-clinmesh-voice-workspace',
} as const

export const voiceSttProviderSchema = z.enum(['paraformer-realtime-v2', 'web-speech'])
export type VoiceSttProvider = z.infer<typeof voiceSttProviderSchema>

export const voiceTtsProviderSchema = z.enum(['sambert', 'web-speech'])
export type VoiceTtsProvider = z.infer<typeof voiceTtsProviderSchema>

export const voiceCaptureModeSchema = z.enum(['continuous', 'hold'])
export type VoiceCaptureMode = z.infer<typeof voiceCaptureModeSchema>

export const CURATED_SAMBERT_VOICES = [
  {
    id: 'sambert-zhida-v1',
    nameZh: '知达（标准男声）',
    nameEn: 'Zhida (Standard Male)',
    gender: 'male',
    ageGroup: 'adult',
  },
  {
    id: 'sambert-zhishuo-v1',
    nameZh: '知硕（自然男声）',
    nameEn: 'Zhishuo (Natural Male)',
    gender: 'male',
    ageGroup: 'adult',
  },
  {
    id: 'sambert-zhiye-v1',
    nameZh: '知晔（青年男声）',
    nameEn: 'Zhiye (Young Male)',
    gender: 'male',
    ageGroup: 'young',
  },
  {
    id: 'sambert-zhishu-v1',
    nameZh: '知树（沉稳男声）',
    nameEn: 'Zhishu (Mature Male)',
    gender: 'male',
    ageGroup: 'senior',
  },
  {
    id: 'sambert-zhiyue-v1',
    nameZh: '知悦（温柔女声）',
    nameEn: 'Zhiyue (Warm Female)',
    gender: 'female',
    ageGroup: 'adult',
  },
  {
    id: 'sambert-zhistella-v1',
    nameZh: '知莎（知性女声）',
    nameEn: 'Zhistella (Composed Female)',
    gender: 'female',
    ageGroup: 'senior',
  },
  {
    id: 'sambert-zhixiao-v1',
    nameZh: '知笑（青年女声）',
    nameEn: 'Zhixiao (Young Female)',
    gender: 'female',
    ageGroup: 'young',
  },
  {
    id: 'sambert-zhiyuan-v1',
    nameZh: '知媛（亲切女声）',
    nameEn: 'Zhiyuan (Friendly Female)',
    gender: 'female',
    ageGroup: 'adult',
  },
  {
    id: 'sambert-zhiying-v1',
    nameZh: '知颖（儿童音色）',
    nameEn: 'Zhiying (Child)',
    gender: 'unknown',
    ageGroup: 'child',
  },
  {
    id: 'sambert-zhimiao-emo-v1',
    nameZh: '知妙（多情感女声）',
    nameEn: 'Zhimiao (Expressive Female)',
    gender: 'female',
    ageGroup: 'adult',
  },
] as const

export const sambertVoiceIdSchema = z.enum([
  'sambert-zhida-v1',
  'sambert-zhishuo-v1',
  'sambert-zhiye-v1',
  'sambert-zhishu-v1',
  'sambert-zhiyue-v1',
  'sambert-zhistella-v1',
  'sambert-zhixiao-v1',
  'sambert-zhiyuan-v1',
  'sambert-zhiying-v1',
  'sambert-zhimiao-emo-v1',
])
export type SambertVoiceId = z.infer<typeof sambertVoiceIdSchema>

export const DEFAULT_SAMBERT_VOICE: SambertVoiceId = 'sambert-zhida-v1'

export const voiceOptionSchema = z.object({
  id: sambertVoiceIdSchema,
  nameZh: z.string().min(1),
  nameEn: z.string().min(1),
  gender: z.enum(['male', 'female', 'unknown']),
  ageGroup: z.enum(['child', 'young', 'adult', 'senior']),
})
export type VoiceOption = z.infer<typeof voiceOptionSchema>

export const voiceConfigResponseSchema = z.object({
  sttProvider: voiceSttProviderSchema,
  ttsProvider: voiceTtsProviderSchema,
  bailianConfigured: z.boolean(),
  serverTokenConfigured: z.boolean(),
  defaultVoice: sambertVoiceIdSchema,
  sampleRate: z.literal(VOICE_SAMPLE_RATE),
  voices: z.array(voiceOptionSchema),
})
export type VoiceConfigResponse = z.infer<typeof voiceConfigResponseSchema>

export const voiceSynthesizeRequestSchema = z.object({
  text: z.string().trim().min(1).max(VOICE_TTS_MAX_TEXT_LENGTH),
  voice: sambertVoiceIdSchema.optional(),
  patientGender: z.string().trim().max(32).optional(),
  patientBirthDate: z.string().trim().max(32).optional(),
  rate: z.number().min(0.5).max(2).optional(),
  pitch: z.number().min(0.5).max(2).optional(),
  volume: z.number().int().min(0).max(100).optional(),
}).strict()
export type VoiceSynthesizeRequest = z.infer<typeof voiceSynthesizeRequestSchema>

export const voiceSttClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    mode: voiceCaptureModeSchema.default('continuous'),
    sampleRate: z.literal(VOICE_SAMPLE_RATE).default(VOICE_SAMPLE_RATE),
    languageHints: z.array(z.enum(['zh', 'en'])).min(1).max(4).optional(),
    apiKey: z.string().trim().min(1).max(512).optional(),
    workspace: z.string().trim().min(1).max(128).optional(),
  }).strict(),
  z.object({ type: z.literal('commit') }).strict(),
  z.object({ type: z.literal('cancel') }).strict(),
  z.object({ type: z.literal('stop') }).strict(),
])
export type VoiceSttClientMessage = z.infer<typeof voiceSttClientMessageSchema>

export const voiceSttServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    provider: z.literal('paraformer-realtime-v2'),
    mode: voiceCaptureModeSchema,
  }).strict(),
  z.object({
    type: z.literal('interim'),
    text: z.string(),
  }).strict(),
  z.object({
    type: z.literal('final'),
    text: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal('empty'),
  }).strict(),
  z.object({
    type: z.literal('error'),
    code: z.string().min(1),
    message: z.string().min(1),
  }).strict(),
])
export type VoiceSttServerMessage = z.infer<typeof voiceSttServerMessageSchema>

function calculateAgeFromBirthDate(birthDate: string | undefined, now: Date): number | null {
  if (birthDate === undefined || birthDate.trim() === '') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthDate.trim())
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  let age = now.getUTCFullYear() - year
  const currentMonth = now.getUTCMonth() + 1
  const currentDay = now.getUTCDate()
  if (currentMonth < month || (currentMonth === month && currentDay < day)) {
    age -= 1
  }
  return age >= 0 && age <= 130 ? age : null
}

/**
 * Selects an age- and gender-appropriate free-quota Sambert voice for a synthetic patient.
 */
export function selectPatientSambertVoice(input: {
  gender?: string | undefined
  birthDate?: string | undefined
  now?: Date | undefined
}): { voice: SambertVoiceId; rate: number } {
  const age = calculateAgeFromBirthDate(input.birthDate, input.now ?? new Date())
  if (age !== null && age < 14) {
    return { voice: 'sambert-zhiying-v1', rate: 1.0 }
  }
  const normalizedGender = input.gender?.trim().toLowerCase()
  if (normalizedGender === 'female' || normalizedGender === 'f' || normalizedGender === '女') {
    if (age !== null && age >= 60) return { voice: 'sambert-zhistella-v1', rate: 0.92 }
    if (age !== null && age < 30) return { voice: 'sambert-zhixiao-v1', rate: 1.02 }
    return { voice: 'sambert-zhiyue-v1', rate: 1.0 }
  }
  if (normalizedGender === 'male' || normalizedGender === 'm' || normalizedGender === '男') {
    if (age !== null && age >= 60) return { voice: 'sambert-zhishu-v1', rate: 0.92 }
    if (age !== null && age < 30) return { voice: 'sambert-zhiye-v1', rate: 1.02 }
    return { voice: 'sambert-zhishuo-v1', rate: 1.0 }
  }
  return { voice: DEFAULT_SAMBERT_VOICE, rate: 1.0 }
}
