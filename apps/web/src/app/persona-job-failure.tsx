import type { WorkspaceLocale } from './workspace-i18n.ts'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@clinmesh/ui/components/dialog'
import { CircleAlertIcon, LoaderCircleIcon, SparklesIcon } from 'lucide-react'
import { useState } from 'react'

export interface JobFailurePayload {
  code: string
  message: string
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed'

const failureCopy = {
  'AI_REQUEST_FAILED': {
    'en-US': { guidance: 'The provider was unreachable. Retry later.', summary: 'The AI provider request failed' },
    'zh-CN': { guidance: '网络或服务暂时不可用，请稍后重试。', summary: 'AI 服务请求失败' },
  },
  'AI_REQUEST_TOO_LARGE': {
    'en-US': { guidance: 'Retry; contact an administrator if it keeps failing.', summary: 'The AI request exceeds the size limit' },
    'zh-CN': { guidance: '请重试；若反复出现请联系管理员。', summary: 'AI 请求超过大小限制' },
  },
  'AI_RESPONSE_INVALID': {
    'en-US': {
      guidance: 'The model failed to return a valid structured result. Retry; if it keeps failing, switch to another model.',
      summary: 'The AI model returned an invalid response',
    },
    'zh-CN': {
      guidance: '模型未能输出合格的结构化结果，请重试；若反复失败，建议更换模型。',
      summary: 'AI 模型返回了无效响应',
    },
  },
  'AI_RESPONSE_TOO_LARGE': {
    'en-US': { guidance: 'Retry; contact an administrator if it keeps failing.', summary: 'The AI response exceeds the size limit' },
    'zh-CN': { guidance: '请重试；若反复出现请联系管理员。', summary: 'AI 响应超过大小限制' },
  },
  'AI_TIMEOUT': {
    'en-US': { guidance: 'The model answered too slowly. Retry; if it keeps timing out, switch to a faster model.', summary: 'The AI provider request timed out' },
    'zh-CN': { guidance: '模型响应过慢，请重试；反复超时建议更换更快的模型。', summary: 'AI 服务响应超时' },
  },
  'PERSONA_DIAGNOSIS_LEAK': {
    'en-US': { guidance: 'The leaked content was blocked. Retry; if it keeps failing, switch to another model.', summary: 'The generated persona disclosed the hidden diagnosis' },
    'zh-CN': { guidance: '系统已拦截该内容，请重试；反复出现建议更换模型。', summary: '生成的患者档案泄露了隐藏诊断' },
  },
  'PERSONA_GENERATION_FAILED': {
    'en-US': { guidance: 'Retry; contact an administrator if it keeps failing.', summary: 'Patient Persona generation failed' },
    'zh-CN': { guidance: '请重试；若反复失败，请联系管理员。', summary: '患者档案生成失败' },
  },
  'PERSONA_RESPONSE_INVALID': {
    'en-US': { guidance: 'Usually caused by an unstable model output. Retry; if it keeps failing, switch to another model.', summary: 'The generated Patient Persona failed content validation' },
    'zh-CN': { guidance: '通常由模型不稳定输出导致，请重试；若反复失败，建议更换模型。', summary: '生成的患者档案未通过内容校验' },
  },
} as const

const genericGuidance = {
  'en-US': 'Retry; contact an administrator if it keeps failing.',
  'zh-CN': '请重试；若反复失败，请联系管理员。',
} as const

export function personaJobFailure(error: JobFailurePayload, locale: WorkspaceLocale): {
  code: string
  guidance: string
  message: string
  summary: string
} {
  const known = (failureCopy as Record<string, Record<WorkspaceLocale, { guidance: string; summary: string }>>)[error.code]
  return known === undefined
    ? { code: error.code, guidance: genericGuidance[locale], message: error.message, summary: error.message }
    : { code: error.code, guidance: known[locale].guidance, message: error.message, summary: known[locale].summary }
}

const noticeCopy = {
  'en-US': {
    close: 'Close', codeLabel: 'Error code', detail: 'View failure details', dialogTitle: 'Failure details',
    guidanceLabel: 'What to do', messageLabel: 'Provider message', summaryLabel: 'Reason', timeLabel: 'Finished at',
  },
  'zh-CN': {
    close: '关闭', codeLabel: '错误码', detail: '查看失败详情', dialogTitle: '失败原因详情',
    guidanceLabel: '建议处理', messageLabel: '服务端信息', summaryLabel: '失败原因', timeLabel: '发生时间',
  },
} as const

export function PersonaJobStatusNotice({ error, finishedAt, label, locale, status }: {
  error: JobFailurePayload | null | undefined
  finishedAt: string | null | undefined
  label: string
  locale: WorkspaceLocale
  status: JobStatus
}) {
  const messages = noticeCopy[locale]
  const [detailOpen, setDetailOpen] = useState(false)
  const inProgress = status === 'queued' || status === 'running'
  const StatusIcon = status === 'failed' ? CircleAlertIcon : inProgress ? LoaderCircleIcon : SparklesIcon
  const failure = error === null || error === undefined ? undefined : personaJobFailure(error, locale)
  return (
    <>
      <Alert
        aria-label={label}
        className="mt-3"
        role={status === 'failed' ? 'alert' : 'status'}
        variant={status === 'failed' ? 'destructive' : 'default'}
      >
        <StatusIcon className={inProgress ? 'animate-spin' : undefined} />
        <AlertTitle>{label}</AlertTitle>
        {failure === undefined ? null : (
          <AlertDescription>
            {failure.summary}
            <Button className="mt-2" onClick={() => setDetailOpen(true)} size="sm" variant="outline">
              {messages.detail}
            </Button>
          </AlertDescription>
        )}
      </Alert>
      {failure === undefined ? null : (
        <Dialog onOpenChange={setDetailOpen} open={detailOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{messages.dialogTitle}</DialogTitle>
              <DialogDescription>{failure.summary}</DialogDescription>
            </DialogHeader>
            <dl className="grid gap-3 text-sm">
              <div><dt className="text-xs text-muted-foreground">{messages.summaryLabel}</dt><dd className="mt-1">{failure.summary}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{messages.codeLabel}</dt><dd className="mt-1 font-mono text-xs">{failure.code}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{messages.messageLabel}</dt><dd className="mt-1">{failure.message}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{messages.guidanceLabel}</dt><dd className="mt-1">{failure.guidance}</dd></div>
              {finishedAt === null || finishedAt === undefined ? null : (
                <div><dt className="text-xs text-muted-foreground">{messages.timeLabel}</dt><dd className="mt-1 font-mono text-xs">{finishedAt}</dd></div>
              )}
            </dl>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>{messages.close}</DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
