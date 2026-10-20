import type { ClinicalDocumentContent, DoctorCaseDetail, EncounterCompletionPreview } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { cn } from '@clinmesh/ui/lib/utils'
import { CheckCircleIcon, SparklesIcon } from 'lucide-react'
import type { WorkspaceLocale, WorkspaceMessages } from '../workspace-i18n.ts'
import { encounterCompletionItemLabel } from './completion-checklist.tsx'
import { openIssues, shortIssue, useDocumentQualityControl, type QualityIssue } from './document-quality-control.tsx'
import { doctorRecommendationKindTitles } from './doctor-recommendations.tsx'
import { preparationKinds, useDoctorPreparation, type DoctorPreparationJob } from './doctor-preparation-state.tsx'

export type SuggestionCompletionView = {
  data: EncounterCompletionPreview | undefined
  isLoading: boolean
  error: Error | null
  refetch: () => void
}

/** 质控疑点服务端按片段逐条产生，同字段的短句完全相同；栈内按短句聚合计数，避免同文案逐行刷屏。 */
function groupIssueLines(issues: QualityIssue[], messages: WorkspaceMessages, locale: WorkspaceLocale) {
  const groups = new Map<string, { text: string, count: number }>()
  for (const issue of issues) {
    const text = shortIssue(issue, messages, locale)
    const group = groups.get(text)
    if (group === undefined) groups.set(text, { text, count: 1 })
    else group.count += 1
  }
  return [...groups.values()]
}

/** 建议栈：完诊清单未完项、质控疑点与医生推荐的聚合摘要。同一描述会同时挂载在右栏与抽屉中，禁止声明 DOM id。 */
export function DoctorSuggestionStack({ completion, detail, clinicalDocument, scope, locale, messages }: {
  completion: SuggestionCompletionView
  detail: DoctorCaseDetail | undefined
  clinicalDocument: ClinicalDocumentContent | undefined
  scope: string
  locale: WorkspaceLocale
  messages: WorkspaceMessages
}): React.JSX.Element {
  if (detail === undefined) {
    return <p className="p-3 text-sm text-muted-foreground">{messages.suggestionNoCase}</p>
  }
  return <ActiveSuggestionStack completion={completion} detail={detail} clinicalDocument={clinicalDocument} locale={locale} messages={messages} scope={scope} />
}

function ActiveSuggestionStack({ completion, detail, clinicalDocument, locale, messages, scope }: {
  completion: SuggestionCompletionView
  detail: DoctorCaseDetail
  clinicalDocument: ClinicalDocumentContent | undefined
  scope: string
  locale: WorkspaceLocale
  messages: WorkspaceMessages
}): React.JSX.Element {
  const preparation = useDoctorPreparation()
  const readOnly = detail.encounter.status !== 'in-progress' || detail.status === 'awaiting-doctor'
  const qualityEnabled = !readOnly && (detail.clinicalDocument?.signed.length ?? 0) === 0
  const quality = useDocumentQualityControl({ detail, scope, enabled: qualityEnabled,
    ...(clinicalDocument === undefined ? {} : { document: clinicalDocument }) })
  const incompleteItems = completion.data?.items.filter(item => item.status === 'incomplete') ?? []
  const issues = openIssues(quality)
  const jobs = preparation === undefined ? [] : preparationKinds.map(kind => ({ kind, job: preparation.jobs[kind] }))
  const jobAttention = jobs.some(({ job }) => jobNeedsAttention(job))
  const attention = completion.error !== null || quality.error !== null || incompleteItems.length > 0
    || issues.length > 0 || jobAttention
  if (!attention && !completion.isLoading && !quality.pending) {
    return (
      <div className="flex min-h-0 flex-col gap-3 p-3">
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <SparklesIcon aria-hidden="true" className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{messages.suggestionStackEmpty}</p>
        </div>
      </div>
    )
  }
  const zh = locale === 'zh-CN'
  const completionClear = completion.data === undefined || incompleteItems.length > 0 ? null : messages.suggestionCompletionClear
  return (
    <div className="flex min-h-0 flex-col gap-4 p-3">
      <section aria-label={messages.encounterCompletionChecklist} className="flex min-w-0 flex-col gap-1.5">
        <h3 className="text-xs font-medium text-muted-foreground">{messages.encounterCompletionChecklist}</h3>
        <StackSectionState
          clearText={completionClear}
          error={completion.error}
          messages={messages}
          onRetry={completion.refetch}
          pending={completion.isLoading}
        >
          {completion.data === undefined ? null : (
            <ul className="flex min-w-0 flex-col gap-1">
              {incompleteItems.map(item => (
                <li className="flex min-w-0 items-baseline justify-between gap-2 text-sm" key={item.code}>
                  <span className="shrink-0">{encounterCompletionItemLabel(item.code, locale)}</span>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">{item.statusText}</span>
                </li>
              ))}
            </ul>
          )}
        </StackSectionState>
      </section>
      {qualityEnabled ? (
        <section aria-label={messages.documentQualityTitle} className="flex min-w-0 flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">{messages.documentQualityTitle}</h3>
          {quality.stale ? <p className="text-xs text-muted-foreground">{messages.documentQualityStale}</p> : null}
          <StackSectionState
            clearText={issues.length === 0 ? messages.suggestionQualityClear : null}
            error={quality.error}
            messages={messages}
            onRetry={quality.retry}
            pending={quality.pending}
          >
            <ul className="flex min-w-0 flex-col gap-1">
              {groupIssueLines(issues, messages, locale).map(({ text, count }) => (
                <li className="min-w-0 text-sm" key={text}>
                  {count === 1 ? text : zh ? `${text}（${count} 处）` : `${text} (${count})`}
                </li>
              ))}
            </ul>
          </StackSectionState>
        </section>
      ) : null}
      {preparation !== undefined ? (
        <section aria-label={messages.suggestionRecommendationsTitle} className="flex min-w-0 flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">{messages.suggestionRecommendationsTitle}</h3>
          <ul className="flex min-w-0 flex-col gap-1">
            {jobs.map(({ kind, job }) => (
              <li key={kind}>
                <Button aria-label={doctorRecommendationKindTitles[kind][zh ? 0 : 1]}
                  className={cn('h-auto w-full justify-between px-2 py-1.5', jobInProgress(job) ? 'clinmesh-glow' : null)}
                  onClick={() => preparation.openDetails(kind)} size="sm" type="button" variant="ghost">
                  <span className="min-w-0 truncate">{doctorRecommendationKindTitles[kind][zh ? 0 : 1]}</span>
                  <span className="shrink-0 text-xs font-normal text-muted-foreground">{recommendationStatusText(job, messages)}</span>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

/** 分区状态体：失败给 Alert 与重试，加载给骨架，无内容给清空态，否则渲染内容。 */
function StackSectionState({ error, pending, clearText, onRetry, messages, children }: {
  error: Error | null
  pending: boolean
  clearText: string | null
  onRetry: () => void
  messages: WorkspaceMessages
  children: React.ReactNode
}): React.JSX.Element {
  if (error !== null) {
    return (
      <Alert>
        <AlertTitle>{messages.suggestionLoadFailed}</AlertTitle>
        <AlertDescription className="flex items-center gap-2">
          <Button onClick={onRetry} size="sm" type="button" variant="outline">{messages.suggestionRetry}</Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (pending) return <Skeleton className="h-16 w-full" />
  if (clearText !== null) {
    return (
      <p className="flex items-center gap-1.5 text-sm">
        <CheckCircleIcon aria-hidden="true" className="size-4 shrink-0" />
        {clearText}
      </p>
    )
  }
  return <>{children}</>
}

/** 推荐条目需要医生关注：失败、进行中、缺证据或有待确认候选。 */
function jobNeedsAttention(job: DoctorPreparationJob): boolean {
  return job.error !== null || jobInProgress(job)
    || job.state?.status === 'failed' || job.state?.status === 'missing-evidence'
    || (job.state?.status === 'ready' && job.state.items.length > 0)
}

/** 推荐生成进行中：环绕柔光只标记这一状态，不扩大到失败或就绪。 */
function jobInProgress(job: DoctorPreparationJob): boolean {
  return job.pending || job.state?.status === 'pending'
}

function recommendationStatusText(job: DoctorPreparationJob, messages: WorkspaceMessages): string {
  if (job.error !== null || job.state?.status === 'failed') return messages.suggestionRecommendationFailed
  if (jobInProgress(job)) return messages.suggestionRecommendationPending
  const state = job.state
  if (state?.status === 'missing-evidence') return messages.suggestionRecommendationMissingEvidence
  if (state?.status === 'ready') return messages.suggestionRecommendationReadyCount.replace('{count}', String(state.items.length))
  return messages.suggestionRecommendationIdle
}
