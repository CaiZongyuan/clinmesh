import {
  VOICE_RUNTIME_HEADERS,
  sambertVoiceIdSchema,
  type SambertVoiceId,
} from '@clinmesh/contracts/voice'
import { useSyncExternalStore } from 'react'
import { z } from 'zod'

const VOICE_SETTINGS_STORAGE_KEY = 'clinmesh.voice-settings:v1'
const VOICE_SETTINGS_CHANGE_EVENT = 'clinmesh:voice-settings-change'

const preferredVoiceSchema = z.union([z.literal('auto'), sambertVoiceIdSchema])

const storedVoiceSettingsSchema = z.object({
  apiKey: z.string().max(512).default(''),
  workspace: z.string().max(128).default(''),
  autoSpeakPatient: z.boolean().default(true),
  preferredVoice: preferredVoiceSchema.default('auto'),
  speechRate: z.number().min(0.5).max(2).default(1),
  selectedDeviceId: z.string().max(256).default(''),
})

export type PreferredVoiceSetting = 'auto' | SambertVoiceId
export type StoredVoiceSettings = z.infer<typeof storedVoiceSettingsSchema>

export const DEFAULT_VOICE_SETTINGS: StoredVoiceSettings = {
  apiKey: '',
  workspace: '',
  autoSpeakPatient: true,
  preferredVoice: 'auto',
  speechRate: 1,
  selectedDeviceId: '',
}

let cachedRaw: string | null | undefined
let cachedSnapshot: StoredVoiceSettings = DEFAULT_VOICE_SETTINGS

export function readVoiceSettings(): StoredVoiceSettings {
  if (typeof window === 'undefined') return DEFAULT_VOICE_SETTINGS
  try {
    const raw = window.localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY)
    if (raw === cachedRaw) return cachedSnapshot
    cachedRaw = raw
    if (raw === null) {
      cachedSnapshot = DEFAULT_VOICE_SETTINGS
      return cachedSnapshot
    }
    const parsed = storedVoiceSettingsSchema.safeParse(JSON.parse(raw))
    cachedSnapshot = parsed.success ? parsed.data : DEFAULT_VOICE_SETTINGS
    return cachedSnapshot
  } catch {
    return DEFAULT_VOICE_SETTINGS
  }
}

export function writeVoiceSettings(next: StoredVoiceSettings): void {
  if (typeof window === 'undefined') return
  try {
    const serialized = JSON.stringify(next)
    window.localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, serialized)
    cachedRaw = serialized
    cachedSnapshot = next
    window.dispatchEvent(new CustomEvent(VOICE_SETTINGS_CHANGE_EVENT))
  } catch {
    // Ignore storage quota or private browsing restrictions.
  }
}

export function updateVoiceSettings(
  updater: (current: StoredVoiceSettings) => StoredVoiceSettings,
): StoredVoiceSettings {
  const next = updater(readVoiceSettings())
  writeVoiceSettings(next)
  return next
}

function subscribeVoiceSettings(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === VOICE_SETTINGS_STORAGE_KEY) {
      cachedRaw = undefined
      listener()
    }
  }
  window.addEventListener(VOICE_SETTINGS_CHANGE_EVENT, listener)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(VOICE_SETTINGS_CHANGE_EVENT, listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useVoiceSettings(): StoredVoiceSettings {
  return useSyncExternalStore(
    subscribeVoiceSettings,
    readVoiceSettings,
    () => DEFAULT_VOICE_SETTINGS,
  )
}

export function buildVoiceRequestHeaders(
  settings: StoredVoiceSettings = readVoiceSettings(),
): Record<string, string> {
  const headers: Record<string, string> = {}
  const apiKey = settings.apiKey.trim()
  const workspace = settings.workspace.trim()
  if (apiKey.length > 0) {
    headers[VOICE_RUNTIME_HEADERS.apiKey] = apiKey
  }
  if (workspace.length > 0) {
    headers[VOICE_RUNTIME_HEADERS.workspace] = workspace
  }
  return headers
}
