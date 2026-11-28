import type { VoiceSttProvider, VoiceTtsProvider } from '@clinmesh/contracts/voice'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import {
  CircleAlertIcon,
  MicIcon,
  MicOffIcon,
  PauseCircleIcon,
  RadioIcon,
  SettingsIcon,
  SquareIcon,
  Volume2Icon,
  VolumeXIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useVoiceCapture } from './use-voice-capture.ts'
import { updateVoiceSettings, useVoiceSettings } from './voice-settings-storage.ts'

const SLIDE_CANCEL_THRESHOLD_PX = 48

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}

export interface ConsultationVoiceBarProps {
  caseId: string
  locale: 'zh-CN' | 'en-US'
  sttProvider: VoiceSttProvider
  ttsProvider: VoiceTtsProvider
  disabled: boolean
  isSpeaking: boolean
  speechError: string | null
  onFinalTranscript: (text: string) => void
  onSpeechStart: () => void
  onInterruptSpeech: () => void
}

export function ConsultationVoiceBar({
  caseId,
  locale,
  sttProvider,
  ttsProvider,
  disabled,
  isSpeaking,
  speechError,
  onFinalTranscript,
  onSpeechStart,
  onInterruptSpeech,
}: ConsultationVoiceBarProps): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const settings = useVoiceSettings()
  const [slideCancelling, setSlideCancelling] = useState(false)
  const pointerHoldRef = useRef<{ pointerId: number; startY: number } | null>(null)
  const spaceHeldRef = useRef(false)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const [focusedToolbarIndex, setFocusedToolbarIndex] = useState(0)

  const capture = useVoiceCapture({
    sttProvider,
    locale,
    resetKey: caseId,
    deviceId: settings.selectedDeviceId,
    disabled,
    onFinal: onFinalTranscript,
    onSpeechStart,
  })

  // Latest-ref helpers for global Space (hold-to-talk) and M (privacy pause) shortcuts.
  const captureRef = useRef(capture)
  const disabledRef = useRef(disabled)
  useEffect(() => { captureRef.current = capture }, [capture])
  useEffect(() => { disabledRef.current = disabled }, [disabled])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (disabledRef.current || event.metaKey || event.ctrlKey || event.altKey) return
      if (isEditableElement(event.target)) return

      if ((event.key === 'm' || event.key === 'M') && !event.repeat) {
        event.preventDefault()
        captureRef.current.togglePause()
        return
      }

      if (event.code === 'Space' && !event.repeat && !spaceHeldRef.current) {
        // Only bind global Space push-to-talk when focus is not on another button/link.
        const target = event.target
        if (target instanceof HTMLElement && target.closest('button, a, [role="button"], [role="tab"]')) {
          return
        }
        event.preventDefault()
        spaceHeldRef.current = true
        void captureRef.current.beginHold()
      }
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space' && spaceHeldRef.current) {
        event.preventDefault()
        spaceHeldRef.current = false
        captureRef.current.commitHold()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  // Roving tabindex fallback only when native `focusgroup` is unsupported.
  const supportsFocusGroup = typeof HTMLElement !== 'undefined' && 'focusGroup' in HTMLElement.prototype
  const handleToolbarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (supportsFocusGroup) return
    const bar = toolbarRef.current
    if (!bar) return
    const items = Array.from(bar.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled])'))
    if (items.length === 0) return
    const activeIndex = items.findIndex(item => item === document.activeElement)
    const currentIndex = activeIndex >= 0 ? activeIndex : focusedToolbarIndex

    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % items.length
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + items.length) % items.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = items.length - 1
    if (nextIndex === null) return

    event.preventDefault()
    setFocusedToolbarIndex(nextIndex)
    items[nextIndex]?.focus()
  }

  const handleHoldPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || event.button !== 0) return
    event.preventDefault()
    pointerHoldRef.current = { pointerId: event.pointerId, startY: event.clientY }
    setSlideCancelling(false)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch { /* ignore in JSDOM */ }
    void capture.beginHold()
  }

  const handleHoldPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = pointerHoldRef.current
    if (active === null || active.pointerId !== event.pointerId) return
    const deltaUp = active.startY - event.clientY
    setSlideCancelling(deltaUp >= SLIDE_CANCEL_THRESHOLD_PX)
  }

  const handleHoldPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = pointerHoldRef.current
    if (active === null || active.pointerId !== event.pointerId) return
    const deltaUp = active.startY - event.clientY
    pointerHoldRef.current = null
    setSlideCancelling(false)
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch { /* ignore */ }
    if (deltaUp >= SLIDE_CANCEL_THRESHOLD_PX) {
      capture.cancelHold(zh ? '上滑已取消本次语音发送。' : 'Slid up — voice utterance cancelled.')
    } else {
      capture.commitHold()
    }
  }

  const handleHoldPointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (pointerHoldRef.current?.pointerId !== event.pointerId) return
    pointerHoldRef.current = null
    setSlideCancelling(false)
    capture.cancelHold()
  }

  const continuousActive = capture.activeMode === 'continuous' && capture.isListening
  const holdingActive = capture.activeMode === 'hold' && (capture.status === 'holding' || capture.status === 'connecting')
  const levelPercent = Math.round(Math.min(1, Math.max(0, capture.level)) * 100)
  const providerBadgeLabel = sttProvider === 'paraformer-realtime-v2' || ttsProvider === 'sambert'
    ? (zh ? '百炼语音' : 'Bailian Voice')
    : (zh ? '浏览器语音' : 'Browser Voice')

  const toolbarFocusProps = supportsFocusGroup
    ? ({ focusgroup: 'toolbar wrap' } as Record<string, string>)
    : {}

  const rovingTabIndex = (idx: number): number | undefined => {
    if (supportsFocusGroup) return undefined
    return focusedToolbarIndex === idx ? 0 : -1
  }

  return (
    <div className="flex shrink-0 flex-col gap-1.5" data-testid="consultation-voice-bar">
      {capture.isPaused ? (
        <div
          className="flex items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-1.5 text-xs text-foreground"
          data-testid="voice-privacy-paused-banner"
          role="status"
        >
          <span className="flex items-center gap-1.5 font-medium">
            <PauseCircleIcon aria-hidden="true" className="size-3.5 text-warning" />
            {zh
              ? '已暂停收音 · 麦克风采集已完全关闭（按 M 恢复）'
              : 'Microphone paused · audio capture fully stopped (press M to resume)'}
          </span>
          <Button
            onClick={capture.togglePause}
            size="xs"
            type="button"
            variant="outline"
          >
            {zh ? '恢复可用' : 'Resume'}
          </Button>
        </div>
      ) : null}

      <div
        aria-label={zh ? '问诊语音控制' : 'Consultation voice controls'}
        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5"
        onKeyDown={handleToolbarKeyDown}
        ref={toolbarRef}
        role="toolbar"
        {...toolbarFocusProps}
      >
        <div
          aria-label={zh ? '医生语音输入' : 'Clinician voice input'}
          className="flex flex-wrap items-center gap-1.5"
          role="group"
        >
          <Button
            aria-label={zh ? '持续收音' : 'Hands-free voice capture'}
            aria-pressed={continuousActive}
            className="min-h-8 gap-1.5"
            data-testid="voice-continuous-btn"
            disabled={disabled || capture.isPaused}
            onClick={() => {
              if (continuousActive) capture.stop()
              else void capture.startContinuous()
            }}
            onFocus={() => setFocusedToolbarIndex(0)}
            size="xs"
            tabIndex={rovingTabIndex(0)}
            type="button"
            variant={continuousActive ? 'default' : 'outline'}
          >
            <RadioIcon
              aria-hidden="true"
              className={continuousActive ? 'size-3.5 animate-pulse motion-reduce:animate-none' : 'size-3.5'}
            />
            <span>{continuousActive ? (zh ? '收音中…' : 'Listening…') : (zh ? '持续收音' : 'Hands-free')}</span>
          </Button>

          <Button
            aria-label={zh ? '按住说话' : 'Push to talk'}
            aria-pressed={holdingActive}
            className="min-h-8 touch-pan-x select-none gap-1.5"
            data-testid="voice-hold-btn"
            disabled={disabled || capture.isPaused}
            onFocus={() => setFocusedToolbarIndex(1)}
            onKeyDown={(event) => {
              if ((event.key === ' ' || event.key === 'Enter') && !event.repeat && !holdingActive) {
                event.preventDefault()
                void capture.beginHold()
              }
            }}
            onKeyUp={(event) => {
              if ((event.key === ' ' || event.key === 'Enter') && holdingActive) {
                event.preventDefault()
                capture.commitHold()
              }
            }}
            onPointerCancel={handleHoldPointerCancel}
            onPointerDown={handleHoldPointerDown}
            onPointerMove={handleHoldPointerMove}
            onPointerUp={handleHoldPointerUp}
            size="xs"
            tabIndex={rovingTabIndex(1)}
            type="button"
            variant={slideCancelling ? 'destructive' : holdingActive ? 'default' : 'outline'}
          >
            <MicIcon aria-hidden="true" className="size-3.5" />
            <span>
              {slideCancelling
                ? (zh ? '松开取消' : 'Release to cancel')
                : holdingActive
                  ? (zh ? '松开发送（上滑取消）' : 'Release to send')
                  : capture.status === 'committing'
                    ? (zh ? '识别整理中…' : 'Finalizing…')
                    : (zh ? '按住说话' : 'Hold to talk')}
            </span>
          </Button>

          <Button
            aria-label={zh ? '暂停收音' : 'Pause microphone'}
            aria-pressed={capture.isPaused}
            className="min-h-8 gap-1"
            data-testid="voice-pause-btn"
            onClick={capture.togglePause}
            onFocus={() => setFocusedToolbarIndex(2)}
            size="xs"
            tabIndex={rovingTabIndex(2)}
            title={zh ? '暂停收音并立即关闭麦克风 (M)' : 'Pause and release microphone (M)'}
            type="button"
            variant={capture.isPaused ? 'secondary' : 'ghost'}
          >
            <MicOffIcon aria-hidden="true" className="size-3.5" />
            <span>{zh ? '暂停' : 'Pause'}</span>
          </Button>
        </div>

        <span
          aria-orientation="vertical"
          className="hidden h-4 border-l border-border sm:inline-block"
          role="separator"
        />

        <div
          aria-label={zh ? '患者语音朗读与设备' : 'Patient speech playback and device'}
          className="flex flex-wrap items-center gap-1.5"
          role="group"
        >
          <Button
            aria-label={zh ? '患者回复自动朗读' : 'Auto-speak patient replies'}
            aria-pressed={settings.autoSpeakPatient}
            className="min-h-8 gap-1"
            data-testid="voice-autospeak-btn"
            onClick={() => {
              const next = !settings.autoSpeakPatient
              updateVoiceSettings(current => ({ ...current, autoSpeakPatient: next }))
              if (!next) onInterruptSpeech()
            }}
            onFocus={() => setFocusedToolbarIndex(3)}
            size="xs"
            tabIndex={rovingTabIndex(3)}
            type="button"
            variant={settings.autoSpeakPatient ? 'secondary' : 'ghost'}
          >
            {settings.autoSpeakPatient
              ? <Volume2Icon aria-hidden="true" className="size-3.5" />
              : <VolumeXIcon aria-hidden="true" className="size-3.5" />}
            <span>{settings.autoSpeakPatient ? (zh ? '患者出声' : 'Voice on') : (zh ? '已静音' : 'Muted')}</span>
          </Button>

          {isSpeaking ? (
            <Button
              aria-label={zh ? '停止当前患者朗读' : 'Stop patient speech'}
              className="min-h-8 gap-1"
              data-testid="voice-interrupt-btn"
              onClick={onInterruptSpeech}
              onFocus={() => setFocusedToolbarIndex(4)}
              size="xs"
              tabIndex={rovingTabIndex(4)}
              type="button"
              variant="outline"
            >
              <SquareIcon aria-hidden="true" className="size-3 fill-current" />
              <span>{zh ? '打断朗读' : 'Stop'}</span>
            </Button>
          ) : null}

          {capture.devices.length > 1 ? (
            <select
              aria-label={zh ? '选择麦克风设备' : 'Select microphone device'}
              className="h-8 max-w-36 rounded-md border border-border bg-background px-2 text-xs text-foreground"
              onChange={(event) => {
                const nextId = event.currentTarget.value
                updateVoiceSettings(current => ({ ...current, selectedDeviceId: nextId }))
              }}
              value={settings.selectedDeviceId}
            >
              <option value="">{zh ? '默认麦克风' : 'Default mic'}</option>
              {capture.devices.map(device => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
          ) : null}

          <Badge className="text-[0.6875rem] font-normal" variant="outline">
            {providerBadgeLabel}
          </Badge>
        </div>
      </div>

      {/* Live audio meter & polite interim transcript status region (always outside role="toolbar"). */}
      <div
        aria-live="polite"
        className={capture.isListening || capture.interimText.length > 0 || capture.notice !== null
          ? 'flex items-center gap-2 rounded-md border border-border/70 bg-background px-2.5 py-1 text-xs'
          : 'sr-only'}
        data-testid="voice-live-status"
        role="status"
      >
        {capture.isListening ? (
          <span aria-hidden="true" className="flex h-2 w-12 shrink-0 overflow-hidden rounded-full bg-muted">
            <span
              className="h-full bg-primary transition-[width] duration-75 motion-reduce:transition-none"
              style={{ width: `${Math.max(8, levelPercent)}%` }}
            />
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {capture.interimText.length > 0
            ? capture.interimText
            : capture.notice !== null
              ? capture.notice
              : capture.status === 'connecting'
                ? (zh ? '正在连接语音识别服务…' : 'Connecting to speech recognition…')
                : capture.status === 'holding'
                  ? (zh ? '请说话，松开自动发送，上滑可取消…' : 'Speak now, release to send, slide up to cancel…')
                  : capture.status === 'listening'
                    ? (zh ? '正在持续收音，说完停顿将自动提问…' : 'Listening continuously — pause to send…')
                    : capture.status === 'committing'
                      ? (zh ? '正在完成语音转写…' : 'Finalizing speech transcript…')
                      : ''}
        </span>
      </div>

      {capture.error !== null || speechError !== null ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertDescription className="space-y-2 text-xs">
            <p>{capture.error ?? speechError}</p>
            {capture.needsBailianConfig ? (
              <Button
                data-testid="voice-open-settings-link"
                render={<a href="/settings/models" />}
                size="xs"
                variant="outline"
              >
                <SettingsIcon aria-hidden="true" className="size-3.5" data-icon="inline-start" />
                {zh ? '前往配置百炼语音' : 'Configure Bailian Voice'}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}
