import type { SambertVoiceId, VoiceTtsProvider } from '@clinmesh/contracts/voice'
import { useCallback, useEffect, useRef, useState } from 'react'
import { VoiceApiError, splitIntoSpeechChunks, synthesizeSpeechWav } from './voice-api.ts'
import { readVoiceSettings } from './voice-settings-storage.ts'

export interface SpeakOptions {
  voice?: SambertVoiceId | undefined
  patientGender?: string | undefined
  patientBirthDate?: string | undefined
  rate?: number | undefined
}

export interface UseSpeechPlaybackOptions {
  ttsProvider: VoiceTtsProvider
  locale: 'zh-CN' | 'en-US'
  resetKey?: string | undefined
}

export interface UseSpeechPlaybackResult {
  speakingId: string | null
  isSpeaking: boolean
  error: string | null
  speak: (id: string, text: string, options?: SpeakOptions) => Promise<void>
  toggleSpeak: (id: string, text: string, options?: SpeakOptions) => Promise<void>
  interrupt: () => void
}

function speakWithBrowserSynthesis(
  text: string,
  locale: 'zh-CN' | 'en-US',
  rate: number,
  isCancelled: () => boolean,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (typeof window === 'undefined' || typeof window.speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') {
      reject(new Error(locale === 'zh-CN' ? '当前浏览器不支持语音合成。' : 'Speech synthesis is unavailable in this browser.'))
      return
    }
    if (isCancelled()) {
      resolve()
      return
    }
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = locale
    utterance.rate = Math.max(0.5, Math.min(2, rate))
    utterance.onend = () => resolve()
    utterance.onerror = (event) => {
      if (isCancelled() || event.error === 'interrupted' || event.error === 'canceled') {
        resolve()
        return
      }
      reject(new Error(`Web Speech synthesis error: ${event.error}`))
    }
    window.speechSynthesis.speak(utterance)
  })
}

function playWavBlob(
  blob: Blob,
  audioRef: { current: HTMLAudioElement | null },
  isCancelled: () => boolean,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (isCancelled()) {
      resolve()
      return
    }
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    audioRef.current = audio

    const cleanup = () => {
      if (audioRef.current === audio) audioRef.current = null
      audio.onended = null
      audio.onerror = null
      audio.onpause = null
      URL.revokeObjectURL(url)
    }

    audio.onended = () => {
      cleanup()
      resolve()
    }
    audio.onerror = () => {
      cleanup()
      if (isCancelled()) resolve()
      else reject(new Error('Failed to decode synthesized WAV audio'))
    }
    audio.onpause = () => {
      if (isCancelled()) {
        cleanup()
        resolve()
      }
    }

    void audio.play().catch((err: unknown) => {
      cleanup()
      if (isCancelled()) resolve()
      else reject(err instanceof Error ? err : new Error('Browser blocked audio playback'))
    })
  })
}

export function useSpeechPlayback(options: UseSpeechPlaybackOptions): UseSpeechPlaybackResult {
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const ttsProviderRef = useRef(options.ttsProvider)
  const localeRef = useRef(options.locale)
  useEffect(() => { ttsProviderRef.current = options.ttsProvider }, [options.ttsProvider])
  useEffect(() => { localeRef.current = options.locale }, [options.locale])

  const generationRef = useRef(0)
  const speakingIdRef = useRef<string | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const interrupt = useCallback(() => {
    generationRef.current += 1
    if (abortControllerRef.current !== null) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    if (audioRef.current !== null) {
      try {
        audioRef.current.pause()
        audioRef.current.currentTime = 0
      } catch { /* ignore */ }
      audioRef.current = null
    }
    if (typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined') {
      try { window.speechSynthesis.cancel() } catch { /* ignore */ }
    }
    speakingIdRef.current = null
    setSpeakingId(null)
  }, [])

  const speak = useCallback(async (id: string, text: string, speakOptions?: SpeakOptions) => {
    const chunks = splitIntoSpeechChunks(text)
    if (chunks.length === 0) return

    interrupt()
    const myGen = generationRef.current
    const isCancelled = () => generationRef.current !== myGen
    const abortController = new AbortController()
    abortControllerRef.current = abortController

    speakingIdRef.current = id
    setSpeakingId(id)
    setError(null)

    const settings = readVoiceSettings()
    const resolvedVoice = speakOptions?.voice
      ?? (settings.preferredVoice !== 'auto' ? settings.preferredVoice : undefined)
    const resolvedRate = speakOptions?.rate ?? settings.speechRate

    const runWebSpeechChunks = async (startIndex: number) => {
      for (let i = startIndex; i < chunks.length; i += 1) {
        if (isCancelled()) return
        await speakWithBrowserSynthesis(chunks[i]!, localeRef.current, resolvedRate, isCancelled)
      }
    }

    try {
      if (ttsProviderRef.current === 'sambert') {
        const fetchChunk = (chunkText: string) => synthesizeSpeechWav(
          {
            text: chunkText,
            ...(resolvedVoice === undefined ? {} : { voice: resolvedVoice }),
            ...(speakOptions?.patientGender === undefined ? {} : { patientGender: speakOptions.patientGender }),
            ...(speakOptions?.patientBirthDate === undefined ? {} : { patientBirthDate: speakOptions.patientBirthDate }),
            ...(resolvedRate === 1 ? {} : { rate: resolvedRate }),
          },
          abortController.signal,
          settings,
        )

        let pendingBlobPromise: Promise<Blob> | null = fetchChunk(chunks[0]!)
        for (let i = 0; i < chunks.length; i += 1) {
          if (isCancelled()) return
          let wavBlob: Blob
          try {
            wavBlob = await pendingBlobPromise!
          } catch (err) {
            if (isCancelled()) return
            if (err instanceof VoiceApiError && err.code === 'VOICE_PROVIDER_UNCONFIGURED') {
              await runWebSpeechChunks(i)
              return
            }
            throw err
          }
          if (isCancelled()) return
          // Prefetch the next sentence chunk while the current WAV plays for seamless transitions.
          pendingBlobPromise = i + 1 < chunks.length ? fetchChunk(chunks[i + 1]!) : null
          await playWavBlob(wavBlob, audioRef, isCancelled)
        }
      } else {
        await runWebSpeechChunks(0)
      }
    } catch (err) {
      if (!isCancelled()) {
        const message = err instanceof Error ? err.message : 'Speech playback failed'
        setError(message)
      }
    } finally {
      if (!isCancelled()) {
        abortControllerRef.current = null
        speakingIdRef.current = null
        setSpeakingId(null)
      }
    }
  }, [interrupt])

  const toggleSpeak = useCallback(async (id: string, text: string, speakOptions?: SpeakOptions) => {
    if (speakingIdRef.current === id) {
      interrupt()
      return
    }
    await speak(id, text, speakOptions)
  }, [interrupt, speak])

  useEffect(() => {
    interrupt()
    setError(null)
  }, [options.resetKey, interrupt])

  useEffect(() => () => {
    interrupt()
  }, [interrupt])

  return {
    speakingId,
    isSpeaking: speakingId !== null,
    error,
    speak,
    toggleSpeak,
    interrupt,
  }
}
