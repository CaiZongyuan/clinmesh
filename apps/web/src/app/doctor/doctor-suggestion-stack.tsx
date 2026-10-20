import type { ClinicalDocumentContent, DoctorCaseDetail, EncounterCompletionPreview } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { CheckCircleIcon, SparklesIcon } from 'lucide-react'
import type { WorkspaceLocale, WorkspaceMessages } from '../workspace-i18n.ts'
import { encounterCompletionItemLabel } from './completion-checklist.tsx'
import { openIssues, shortIssue, useDocumentQualityControl } from './document-quality-control.tsx'
import { doctorRecommendationKindTitles } from './doctor-recommendations.tsx'
import { preparationKinds, useDoctorPreparation, type DoctorPreparationJob } from './doctor-preparation-state.tsx'

export type SuggestionCompletionView = {
  data: EncounterCompletionPreview | undefined
  isPending: boolean
  isLoading: boolean
  error: Error | null
  refetch: () => void
}

/** 建议栈：完诊清单未完项、质控疑点与医生推荐的聚合摘要。同一描述会同时挂载在右栏与抽屉中，禁止声明 DOM id。 */
export function DoctorSuggestionStack({ completion, detail, document, scope, locale, messages }: {
  completion: SuggestionCompletionView
  detail: DoctorCaseDetail | undefined
  document: ClinicalDocumentContent | undefined
  scope: string
  locale: WorkspaceLocale
  messages: WorkspaceMessages
}): React.JSX.Element {
  if (detail === undefined) {
    return <p className="p-3 text-sm text-muted-foreground">{messages.suggestionNoCase}</p>
  }
  return <ActiveSuggestionStack completion={completion} detail={detail} document={document} locale={locale} messages={messages} scope={scope} />
}

function ActiveSuggestionStack({ completion, detail, document, locale, messages, scope }: {
  completion: SuggestionCompletionView
  detail: DoctorCaseDetail
  document: ClinicalDocumentContent | undefined
  scope: string
  locale: WorkspaceLocale
  messages: WorkspaceMessages
}): React.JSX.Element {
  const preparation = useDoctorPreparation()
  const readOnly = detail.encounter.status !== 'in-progress' || detail.status === 'awaiting-doctor'
  const qualityEnabled = !readOnly && (detail.clinicalDocument?.signed.length ?? 0) === 0
  const quality = useDocumentQualityControl({ detail, scope, enabled: qualityEnabled,
    ...(document === undefined ? {} : { document }) })
  const incompleteItems = completion.data?.items.filter(item => item.status === 'incomplete') ?? []
  const issues = openIssues(quality)
  const jobs = preparation === undefined ? [] : preparationKinds.map(kind => ({ kind, job: preparation.jobs[kind] }))
  const jobAttention = jobs.some(({ job }) => job.error !== null || job.pending
    || job.state?.status === 'failed' || job.state?.status === 'missing-evidence' || (job.state?.status === 'ready' && job.state.items.length > 0))
  const attention = completion.error !== null || incompleteItems.length > 0 || issues.length > 0 || jobAttention
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
  return (
    <div className="flex min-h-0 flex-col gap-4 p-3">
      <section aria-label={messages.encounterCompletionChecklist} className="flex min-w-0 flex-col gap-1.5">
        <h3 className="text-xs font-medium text-muted-foreground">{messages.encounterCompletionChecklist}</h3>
        {completion.error !== null ? (
          <Alert>
            <AlertTitle>{messages.suggestionLoadFailed}</AlertTitle>
            <AlertDescription className="flex items-center gap-2">
              <Button onClick={completion.refetch} size="sm" type="button" variant="outline">{messages.suggestionRetry}</Button>
            </AlertDescription>
          </Alert>
        ) : completion.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : completion.data === undefined ? null : incompleteItems.length === 0 ? (
          <p className="flex items-center gap-1.5 text-sm">
            <CheckCircleIcon aria-hidden="true" className="size-4 shrink-0" />
            {messages.suggestionCompletionClear}
          </p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-1">
            {incompleteItems.map(item => (
              <li className="flex min-w-0 items-baseline justify-between gap-2 text-sm" key={item.code}>
                <span className="shrink-0">{encounterCompletionItemLabel(item.code, locale)}</span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">{item.statusText}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {qualityEnabled ? (
        <section aria-label={messages.documentQualityTitle} className="flex min-w-0 flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">{messages.documentQualityTitle}</h3>
          {quality.error !== null ? (
            <Alert>
              <AlertTitle>{messages.suggestionLoadFailed}</AlertTitle>
              <AlertDescription className="flex items-center gap-2">
                <Button onClick={quality.retry} size="sm" type="button" variant="outline">{messages.suggestionRetry}</Button>
              </AlertDescription>
            </Alert>
          ) : quality.pending ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <>
              {quality.stale ? <p className="text-xs text-muted-foreground">{messages.documentQualityStale}</p> : null}
              {issues.length === 0 ? (
                <p className="flex items-center gap-1.5 text-sm">
                  <CheckCircleIcon aria-hidden="true" className="size-4 shrink-0" />
                  {messages.suggestionQualityClear}
                </p>
              ) : (
                <ul className="flex min-w-0 flex-col gap-1">
                  {issues.map(issue => (
                    <li className="min-w-0 text-sm" key={issue.id}>{shortIssue(issue, messages, locale)}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      ) : null}
      {preparation !== undefined ? (
        <section aria-label={messages.suggestionRecommendationsTitle} className="flex min-w-0 flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">{messages.suggestionRecommendationsTitle}</h3>
          <ul className="flex min-w-0 flex-col gap-1">
            {jobs.map(({ kind, job }) => (
              <li key={kind}>
                <Button aria-label={doctorRecommendationKindTitles[kind][zh ? 0 : 1]} className="h-auto w-full justify-between px-2 py-1.5"
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

function recommendationStatusText(job: DoctorPreparationJob, messages: WorkspaceMessages): string {
  if (job.error !== null || job.state?.status === 'failed') return messages.suggestionRecommendationFailed
  if (job.pending || job.state?.status === 'pending') return messages.suggestionRecommendationPending
  const state = job.state
  if (state?.status === 'missing-evidence') return messages.suggestionRecommendationMissingEvidence
  if (state?.status === 'ready') return messages.suggestionRecommendationReadyCount.replace('{count}', String(state.items.length))
  return messages.suggestionRecommendationIdle
}
