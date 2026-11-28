import { CURATED_SAMBERT_VOICES, type SambertVoiceId } from '@clinmesh/contracts/voice'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Switch } from '@clinmesh/ui/components/switch'
import {
  CircleAlertIcon,
  EyeIcon,
  EyeOffIcon,
  MicIcon,
  ShieldCheckIcon,
  SquareIcon,
  Volume2Icon,
} from 'lucide-react'
import { useState } from 'react'
import { useSpeechPlayback } from './use-speech-playback.ts'
import { useVoiceConfig } from './use-voice-config.ts'
import {
  updateVoiceSettings,
  useVoiceSettings,
  type PreferredVoiceSetting,
} from './voice-settings-storage.ts'
import { WorkspaceCard } from '../workspace-card-layout.tsx'
import type { WorkspaceLocale } from '../workspace-i18n.ts'
import { WorkspaceSelect } from '../workspace-select.tsx'

const SPEECH_RATE_OPTIONS = [
  { value: '0.85', labelZh: '0.85x（稍慢，清晰）', labelEn: '0.85x (Slower)' },
  { value: '1', labelZh: '1.0x（标准语速）', labelEn: '1.0x (Standard)' },
  { value: '1.15', labelZh: '1.15x（高效）', labelEn: '1.15x (Brisk)' },
  { value: '1.3', labelZh: '1.3x（快速）', labelEn: '1.3x (Fast)' },
] as const

export function VoiceSettingsCard({ locale }: { locale: WorkspaceLocale }): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const settings = useVoiceSettings()
  const { config } = useVoiceConfig()
  const [showToken, setShowToken] = useState(false)
  const speech = useSpeechPlayback({
    ttsProvider: config.ttsProvider,
    locale,
    resetKey: 'voice-settings-test',
  })

  const voiceItems = [
    {
      value: 'auto',
      label: zh ? '自动按患者性别与年龄匹配（推荐）' : 'Auto-match patient gender & age (Recommended)',
    },
    ...CURATED_SAMBERT_VOICES.map(item => ({
      value: item.id,
      label: zh ? item.nameZh : item.nameEn,
    })),
  ]

  const sampleText = zh
    ? '您好医生，我是合成患者，语音合成与实时转写已就绪。'
    : 'Hello doctor, synthetic patient speech synthesis and realtime dictation are ready.'

  return (
    <WorkspaceCard
      title={(
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5" id="settings-voice-heading">
            <MicIcon aria-hidden="true" className="size-4" />
            <span>{zh ? '语音交互（阿里云百炼 STT / TTS 与浏览器回退）' : 'Voice (Bailian STT / TTS & Browser Fallback)'}</span>
          </h2>
          {config.bailianConfigured ? (
            <Badge variant="secondary">
              <ShieldCheckIcon aria-hidden="true" className="size-3" />
              {config.serverTokenConfigured && settings.apiKey.trim().length === 0
                ? (zh ? '百炼服务端已就绪（Paraformer + Sambert）' : 'Bailian server ready')
                : (zh ? '百炼 BYOK 已就绪（Paraformer + Sambert）' : 'Bailian BYOK ready')}
            </Badge>
          ) : (
            <Badge variant="outline">
              {zh ? '浏览器内置 Web Speech 回退' : 'Browser Web Speech fallback'}
            </Badge>
          )}
        </div>
      )}
    >
      <div className="flex flex-col gap-4" data-testid="voice-settings-card">
        <FieldSet className="rounded-md border bg-muted/20 p-3">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <FieldLabel htmlFor="voice-auto-speak-switch">
                {zh ? '问诊时自动朗读合成患者回复' : 'Auto-speak synthetic patient replies'}
              </FieldLabel>
              <FieldDescription>
                {zh
                  ? '开启后，门诊问诊收到新的患者回复会自动语音播报；医生开口说话或按住说话时将自动打断（Barge-in）。'
                  : 'Automatically reads newly received synthetic patient replies during consultation, with automatic barge-in when the clinician starts speaking.'}
              </FieldDescription>
            </div>
            <Switch
              aria-label={zh ? '问诊时自动朗读合成患者回复' : 'Auto-speak synthetic patient replies'}
              checked={settings.autoSpeakPatient}
              id="voice-auto-speak-switch"
              onCheckedChange={(checked) => {
                updateVoiceSettings(current => ({ ...current, autoSpeakPatient: checked }))
              }}
            />
          </div>
        </FieldSet>

        <FieldGroup className="gap-3">
          <Field>
            <FieldLabel htmlFor="voice-bailian-token-input">
              {zh ? '阿里云百炼 API Key（BAILIAN_TOKEN，可选 BYOK）' : 'Alibaba Bailian API Key (BAILIAN_TOKEN, optional BYOK)'}
            </FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
                className="flex-1"
                data-agent-secret=""
                id="voice-bailian-token-input"
                onChange={(event) => {
                  const nextValue = event.currentTarget.value
                  updateVoiceSettings(current => ({ ...current, apiKey: nextValue }))
                }}
                placeholder={config.serverTokenConfigured
                  ? (zh ? '服务端已配置 BAILIAN_TOKEN；填写此处将覆盖使用本机 Key' : 'Server BAILIAN_TOKEN is configured; enter here to override')
                  : (zh ? 'sk-...（留空将自动使用浏览器内置 Web Speech 语音）' : 'sk-... (leave empty to use browser Web Speech fallback)')}
                spellCheck={false}
                type={showToken ? 'text' : 'password'}
                value={settings.apiKey}
              />
              <Button
                aria-label={showToken
                  ? (zh ? '隐藏百炼 API Key' : 'Hide Bailian API key')
                  : (zh ? '显示百炼 API Key' : 'Show Bailian API key')}
                aria-pressed={showToken}
                onClick={() => setShowToken(prev => !prev)}
                size="icon"
                type="button"
                variant="outline"
              >
                {showToken ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
              </Button>
            </div>
            <FieldDescription>
              {zh
                ? '默认对接阿里云百炼免费额度：Paraformer 实时识别（paraformer-realtime-v2）+ Sambert 语音合成。密钥仅存于本机浏览器，请求时临时透传，绝不写入数据库或日志。'
                : 'Uses Bailian Paraformer realtime v2 (STT) + Sambert (TTS). Browser keys stay local and are forwarded transiently per request without persistence.'}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="voice-bailian-workspace-input">
              {zh ? '百炼业务空间 ID（可选，X-DashScope-WorkSpace）' : 'Bailian Workspace ID (Optional)'}
            </FieldLabel>
            <Input
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              id="voice-bailian-workspace-input"
              onChange={(event) => {
                const nextValue = event.currentTarget.value
                updateVoiceSettings(current => ({ ...current, workspace: nextValue }))
              }}
              placeholder={zh ? '默认主空间可留空' : 'Leave empty for default workspace'}
              spellCheck={false}
              value={settings.workspace}
            />
          </Field>

          <div className="grid gap-3 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="voice-preferred-speaker-select">
                {zh ? '患者合成音色' : 'Patient TTS Voice'}
              </FieldLabel>
              <WorkspaceSelect
                id="voice-preferred-speaker-select"
                items={voiceItems}
                onValueChange={(value) => {
                  if (value !== null) {
                    updateVoiceSettings(current => ({
                      ...current,
                      preferredVoice: value as PreferredVoiceSetting,
                    }))
                  }
                }}
                value={settings.preferredVoice}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="voice-speech-rate-select">
                {zh ? '朗读语速' : 'Speech Rate'}
              </FieldLabel>
              <WorkspaceSelect
                id="voice-speech-rate-select"
                items={SPEECH_RATE_OPTIONS.map(item => ({
                  value: item.value,
                  label: zh ? item.labelZh : item.labelEn,
                }))}
                onValueChange={(value) => {
                  const parsed = Number(value)
                  if (Number.isFinite(parsed) && parsed >= 0.5 && parsed <= 2) {
                    updateVoiceSettings(current => ({ ...current, speechRate: parsed }))
                  }
                }}
                value={String(settings.speechRate)}
              />
            </Field>
          </div>
        </FieldGroup>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="voice-test-tts-btn"
            onClick={() => {
              void speech.toggleSpeak('voice-settings-sample', sampleText, {
                voice: settings.preferredVoice === 'auto' ? undefined : settings.preferredVoice as SambertVoiceId,
                rate: settings.speechRate,
              })
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {speech.isSpeaking
              ? <SquareIcon aria-hidden="true" className="size-3.5 fill-current" data-icon="inline-start" />
              : <Volume2Icon aria-hidden="true" className="size-3.5" data-icon="inline-start" />}
            {speech.isSpeaking
              ? (zh ? '停止试听' : 'Stop preview')
              : (zh ? '试听语音合成' : 'Test speech playback')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {zh
              ? `当前引擎：识别 ${config.sttProvider} · 合成 ${config.ttsProvider}`
              : `Active engines: STT ${config.sttProvider} · TTS ${config.ttsProvider}`}
          </span>
        </div>

        {speech.error !== null ? (
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertDescription className="text-xs">{speech.error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </WorkspaceCard>
  )
}
