import { Button } from '@clinmesh/ui/components/button'
import { MicIcon, MicOffIcon, SettingsIcon, XIcon } from 'lucide-react'
import { useEffect } from 'react'
import { useVoiceCapture } from './use-voice-capture.ts'
import { useVoiceConfig } from './use-voice-config.ts'
import { useVoiceSettings } from './voice-settings-storage.ts'

export interface UseAssistantDictationOptions {
  zh: boolean
  disabled: boolean
  onAppendTranscript: (text: string) => void
}

export function useAssistantDictation({
  zh,
  disabled,
  onAppendTranscript,
}: UseAssistantDictationOptions) {
  const { config } = useVoiceConfig()
  const settings = useVoiceSettings()

  const capture = useVoiceCapture({
    sttProvider: config.sttProvider,
    locale: zh ? 'zh-CN' : 'en-US',
    deviceId: settings.selectedDeviceId,
    disabled,
    onFinal: onAppendTranscript,
  })

  // Allow Escape to quickly stop active dictation.
  useEffect(() => {
    if (!capture.isListening) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        capture.stop()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [capture])

  return {
    ...capture,
    sttProvider: config.sttProvider,
    toggleDictation: () => {
      if (capture.isListening) capture.stop()
      else void capture.startContinuous()
    },
  }
}

export function AssistantDictationBanner({
  isListening,
  interimText,
  error,
  needsBailianConfig = false,
  level,
  onStop,
  onDismissError,
  zh,
}: {
  isListening: boolean
  interimText: string
  error: string | null
  needsBailianConfig?: boolean
  level: number
  onStop: () => void
  onDismissError: () => void
  zh: boolean
}): React.JSX.Element | null {
  if (!isListening && error === null) return null

  if (error !== null) {
    return (
      <div
        className="flex flex-col gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
        data-testid="assistant-voice-error"
        role="alert"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 flex-1 leading-snug">{error}</span>
          <Button
            aria-label={zh ? '关闭语音错误提示' : 'Dismiss voice error'}
            onClick={onDismissError}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <XIcon aria-hidden="true" />
          </Button>
        </div>
        {needsBailianConfig ? (
          <div>
            <Button
              data-testid="assistant-voice-open-settings-link"
              render={<a href="/settings/models" />}
              size="xs"
              variant="outline"
            >
              <SettingsIcon aria-hidden="true" className="size-3" data-icon="inline-start" />
              {zh ? '前往配置百炼语音' : 'Configure Bailian Voice'}
            </Button>
          </div>
        ) : null}
      </div>
    )
  }

  const levelPercent = Math.round(Math.min(1, Math.max(0, level)) * 100)
  return (
    <div
      aria-live="polite"
      className="flex items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1 text-xs"
      data-testid="assistant-voice-listening-banner"
      role="status"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span aria-hidden="true" className="flex h-1.5 w-8 shrink-0 overflow-hidden rounded-full bg-muted">
          <span
            className="h-full bg-primary transition-[width] duration-75 motion-reduce:transition-none"
            style={{ width: `${Math.max(12, levelPercent)}%` }}
          />
        </span>
        <span className="truncate text-foreground">
          {interimText.length > 0
            ? interimText
            : (zh ? '语音听写中，请直接口述指令…（按 Esc 结束）' : 'Dictating… speak your request (Esc to stop)')}
        </span>
      </div>
      <Button
        aria-label={zh ? '结束语音听写' : 'Stop voice dictation'}
        className="h-5 shrink-0 px-1.5 text-[0.6875rem]"
        onClick={onStop}
        size="xs"
        type="button"
        variant="ghost"
      >
        {zh ? '结束' : 'Done'}
      </Button>
    </div>
  )
}

export function AssistantVoiceDictateButton({
  isListening,
  disabled,
  onToggle,
  zh,
}: {
  isListening: boolean
  disabled: boolean
  onToggle: () => void
  zh: boolean
}): React.JSX.Element {
  return (
    <Button
      aria-label={zh ? '语音听写输入' : 'Voice dictation input'}
      aria-pressed={isListening}
      className={isListening
        ? 'h-7 gap-1 px-2 text-xs'
        : 'h-7 gap-0.5 px-1.5 text-xs text-muted-foreground hover:text-foreground'}
      data-testid="assistant-voice-dictate-btn"
      disabled={disabled}
      onClick={onToggle}
      size="xs"
      title={isListening
        ? (zh ? '点击结束语音听写' : 'Click to stop dictation')
        : (zh ? '点击开始语音听写' : 'Click to start voice dictation')}
      type="button"
      variant={isListening ? 'default' : 'ghost'}
    >
      {isListening
        ? <MicOffIcon aria-hidden="true" className="size-3.5" />
        : <MicIcon aria-hidden="true" className="size-3.5" />}
      {isListening ? <span>{zh ? '听写中' : 'Listening'}</span> : null}
    </Button>
  )
}
