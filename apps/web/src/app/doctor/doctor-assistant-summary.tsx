import type { ClinicalDocumentContent, DoctorCaseDetail, EncounterCompletionPreview, EncounterCompletionTarget } from '@clinmesh/contracts/his'
import type { DoctorRecommendationKind } from '@clinmesh/contracts/doctor-recommendations'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { cn } from '@clinmesh/ui/lib/utils'
import { ArrowRightIcon, CheckCircleIcon, ChevronDownIcon, ListChecksIcon, SparklesIcon } from 'lucide-react'
import { useState } from 'react'
import type { WorkspaceLocale, WorkspaceMessages } from '../workspace-i18n.ts'
import { completionGoToLabel, encounterCompletionItemLabel, encounterCompletionTargetSectionLabel } from './completion-checklist.tsx'
import { preparationKinds, useDoctorPreparation, type DoctorPreparationJob } from './doctor-preparation-state.tsx'
import { openIssues, useDocumentQualityControl } from './document-quality-control.tsx'

export type SuggestionCompletionView = {
  data: EncounterCompletionPreview | undefined
  isLoading: boolean
  error: Error | null
  refetch: () => void
}

const assistantKindLabels: Record<DoctorRecommendationKind, [string, string]> = {
  diagnosis: ['诊断建议', 'Diagnoses'], laboratory: ['检验建议', 'Laboratory'], imaging: ['放射检查建议', 'Imaging'],
  pathology: ['病理会诊', 'Pathology'], prescription: ['处方', 'Prescription'],
}

export function assistantKindTarget(kind: DoctorRecommendationKind): EncounterCompletionTarget {
  return kind === 'prescription' ? 'medication-conclusion' : kind
}

/** 推荐中待医生确认的条数；只在就绪时计数，供「助手 n」页签标记与助手行共用。 */
export function readyRecommendationCount(job: DoctorPreparationJob): number {
  return job.state?.status === 'ready' ? job.state.items.length : 0
}

/** 患者头部的事实标签与「助手已准备」行：生命体征、可展开的完诊清单、各项推荐与质控状态，点击跳到对应页签。 */
export function DoctorAssistantSummary({ completion, detail, clinicalDocument, scope, locale, messages, onNavigateToCompletionTarget }: {
  completion: SuggestionCompletionView
  detail: DoctorCaseDetail
  clinicalDocument: ClinicalDocumentContent | undefined
  scope: string
  locale: WorkspaceLocale
  messages: WorkspaceMessages
  onNavigateToCompletionTarget?: (target: EncounterCompletionTarget) => void
}): React.JSX.Element {
  const [checklistOpen, setChecklistOpen] = useState(false)
  const preparation = useDoctorPreparation()
  const readOnly = detail.encounter.status !== 'in-progress' || detail.status === 'awaiting-doctor'
  const qualityEnabled = !readOnly && (detail.clinicalDocument?.signed.length ?? 0) === 0
  const quality = useDocumentQualityControl({ detail, scope, enabled: qualityEnabled,
    ...(clinicalDocument === undefined ? {} : { document: clinicalDocument }) })
  const issues = openIssues(quality)
  const qualityStatus = quality.state?.status
  // 质控返回未完成终态时，空疑点列表不代表检查通过；按失败呈现，避免冒充清空。
  const qualityFailed = quality.error !== null || (!quality.stale && !quality.pending
    && (qualityStatus === 'failed' || qualityStatus === 'incomplete' || qualityStatus === 'unavailable'))
  const zh = locale === 'zh-CN'
  const vitals = detail.presentation?.vitalSigns
  const completed = completion.data?.items.filter(item => item.status === 'complete').length ?? 0
  // 完诊清单只在就诊进行中呈现：完诊后检查单已定稿，残留未完项与前往动作会与只读状态矛盾。
  const completionActive = detail.encounter.status === 'in-progress'
  const chip = 'h-6 gap-1 rounded-md px-2 text-xs font-normal'
  return (
    <div className="flex min-w-0 flex-col gap-1.5 px-4 pb-2">
      {vitals === undefined && !completionActive ? null : <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {vitals === undefined ? null : <span className={cn(chip, 'inline-flex items-center border bg-muted/40 tabular-nums')} title={messages.vitalSigns}>
          <span className="sr-only">{messages.vitalSigns}：</span>
          {messages.vitalsFact.replace('{temperature}', String(vitals.temperatureC)).replace('{pulse}', String(vitals.pulseBpm))
            .replace('{respiration}', String(vitals.respirationBpm))
            .replace('{bloodPressure}', `${vitals.bloodPressure.systolicMmHg}/${vitals.bloodPressure.diastolicMmHg}`)
            .replace('{oxygen}', String(vitals.oxygenSaturationPct))}
        </span>}
        {completionActive ? <Button aria-expanded={checklistOpen} className={chip} onClick={() => setChecklistOpen(!checklistOpen)} size="sm" type="button" variant="outline">
          <ListChecksIcon aria-hidden="true" />
          {completion.data === undefined ? messages.encounterCompletionChecklist : messages.completionChecklistCount
            .replace('{complete}', String(completed)).replace('{total}', String(completion.data.items.length))}
          <ChevronDownIcon aria-hidden="true" className={cn('transition-transform', checklistOpen ? 'rotate-180' : null)} />
        </Button> : null}
      </div>}
      {completionActive && checklistOpen ? <section aria-label={messages.encounterCompletionChecklist} className="min-w-0 rounded-md border p-1.5">
        <SectionState error={completion.error} messages={messages} onRetry={completion.refetch} pending={completion.isLoading}>
          {completion.data === undefined ? null : <ul className="grid min-w-0 gap-1 @4xl/case-detail:grid-cols-2">
            {completion.data.items.map(item => {
              const body = <>
                <span className="flex min-w-0 flex-col items-start">
                  <span className="flex min-w-0 items-center gap-1">{item.status === 'complete' ? <CheckCircleIcon aria-hidden="true" className="size-3.5 shrink-0 text-success" /> : null}<span className="whitespace-normal text-left">{encounterCompletionItemLabel(item.code, locale)}</span></span>
                  <span className="text-xs font-normal text-muted-foreground">{encounterCompletionTargetSectionLabel(item.target, messages)}</span>
                </span>
                <span className="min-w-0 truncate text-xs font-normal text-muted-foreground" title={item.statusText}>{item.statusText}</span>
              </>
              return <li className="min-w-0" key={item.code}>
                {onNavigateToCompletionTarget === undefined
                  ? <div className="flex min-w-0 items-baseline justify-between gap-2 px-2 py-1.5 text-sm">{body}</div>
                  : <Button aria-label={completionGoToLabel(item, locale, messages)} className="h-auto w-full justify-between gap-2 px-2 py-1.5"
                    onClick={() => { onNavigateToCompletionTarget(item.target) }} size="sm" type="button" variant="ghost">
                    {body}<ArrowRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                  </Button>}
              </li>
            })}
          </ul>}
        </SectionState>
      </section> : null}
      {readOnly ? null : <section aria-label={messages.assistantPrepared} className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 text-xs font-medium text-info"><SparklesIcon aria-hidden="true" className="size-3.5" />{messages.assistantPrepared}</span>
        {preparation === undefined ? null : preparationKinds.map(kind => {
          const job = preparation.jobs[kind]
          const label = `${assistantKindLabels[kind][zh ? 0 : 1]} ${recommendationStatusText(job, kind, detail, messages)}`
          return <Button className={cn(chip, 'border-info/40 text-info', jobInProgress(job) ? 'clinmesh-glow' : null)} key={kind} size="sm" type="button" variant="outline"
            onClick={() => onNavigateToCompletionTarget === undefined ? preparation.openDetails(kind) : onNavigateToCompletionTarget(assistantKindTarget(kind))}>
            {label}
          </Button>
        })}
        {!qualityEnabled ? null : qualityFailed ? <span className="inline-flex items-center gap-1 text-xs text-warning">
          {`${messages.suggestionQualityLabel} ${messages.suggestionRecommendationFailed}`}
          <Button className={chip} onClick={quality.retry} size="sm" type="button" variant="ghost">{messages.suggestionRetry}</Button>
        </span> : quality.stale ? <span className="inline-flex items-center gap-1 text-xs text-warning">
          {messages.documentQualityStale}
          <Button className={chip} onClick={quality.retry} size="sm" type="button" variant="ghost">{messages.suggestionRetry}</Button>
        </span> : quality.pending ? <span className={cn(chip, 'clinmesh-glow inline-flex items-center border border-info/40 text-info')}>
          {`${messages.suggestionQualityLabel} ${messages.suggestionRecommendationPending}`}
        </span> : issues.length > 0 ? <Button className={cn(chip, 'border-info/40 text-info')} size="sm" type="button" variant="outline"
          onClick={() => onNavigateToCompletionTarget === undefined ? preparation?.openDetails('quality') : onNavigateToCompletionTarget('clinical-document')}>
          {messages.suggestionQualityOpen.replace('{count}', String(issues.length))}
        </Button> : <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <CheckCircleIcon aria-hidden="true" className="size-3.5" />{messages.suggestionQualityClear}
        </span>}
      </section>}
    </div>
  )
}

/** 分区状态体：失败给 Alert 与重试，加载给骨架，否则渲染内容。 */
function SectionState({ error, pending, onRetry, messages, children }: {
  error: Error | null
  pending: boolean
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
  return <>{children}</>
}

/** 推荐生成进行中：柔光只标记这一状态，不扩大到失败或就绪。 */
function jobInProgress(job: DoctorPreparationJob): boolean {
  return job.pending || job.state?.status === 'pending'
}

function recommendationStatusText(job: DoctorPreparationJob, kind: DoctorRecommendationKind, detail: DoctorCaseDetail, messages: WorkspaceMessages): string {
  if (job.error !== null || job.state?.status === 'failed') return messages.suggestionRecommendationFailed
  if (jobInProgress(job)) return messages.suggestionRecommendationPending
  const state = job.state
  if (state?.status === 'missing-evidence') return messages.suggestionRecommendationMissingEvidence
  if (state?.status === 'ready') return String(state.items.length)
  // 处方建议以已确认诊断为输入；诊断未确认时写明原因而不是「待生成」。
  if (kind === 'prescription' && detail.diagnosis?.confirmation === undefined) return messages.suggestionPrescriptionAfterDiagnosis
  return messages.suggestionRecommendationIdle
}
