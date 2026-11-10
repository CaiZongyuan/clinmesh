import type { ClinicalDocumentContent, DoctorCaseDetail, EncounterCompletionPreview, EncounterCompletionTarget } from '@clinmesh/contracts/his'
import type { DoctorRecommendationKind } from '@clinmesh/contracts/doctor-recommendations'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { cn } from '@clinmesh/ui/lib/utils'
import { CheckCircleIcon, ChevronDownIcon, ChevronRightIcon, CircleIcon, ListChecksIcon, SparklesIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { WorkspaceLocale, WorkspaceMessages } from '../workspace-i18n.ts'
import { completionGoToLabel, encounterCompletionItemLabel, encounterCompletionTargetSectionLabel } from './completion-checklist.tsx'
import { preparationKinds, useDoctorPreparation, type DoctorPreparationJob, type DraftPreferences } from './doctor-preparation-state.tsx'
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

function isRecommendationItemSettled(
  item: NonNullable<DoctorPreparationJob['state']>['items'][number],
  detail: DoctorCaseDetail | undefined,
  preferences: DraftPreferences | undefined,
): boolean {
  const key = JSON.stringify([
    item.kind,
    item.kind === 'imaging' || item.kind === 'pathology' ? item.serviceId : item.catalogItemId,
  ])
  if (preferences !== undefined && (preferences.removed[key] !== undefined || (preferences.completed[key]?.length ?? 0) > 0)) {
    return true
  }
  if (detail === undefined) return false
  if (item.kind === 'diagnosis') {
    return detail.diagnosis?.confirmation?.entries.some(entry => entry.catalogItemId === item.catalogItemId) === true
  }
  if (item.kind === 'prescription') {
    if (detail.medicationConclusion?.noMedication !== undefined) return true
    const activePrescription = detail.medicationConclusion?.prescription
    if (activePrescription !== undefined && activePrescription.status !== 'withdrawn') {
      return activePrescription.items.some(entry => entry.catalogItemId === item.catalogItemId)
    }
    return false
  }
  if (item.kind === 'laboratory') {
    return detail.laboratoryRequests?.requests.some(req => req.status !== 'cancelled' && req.catalogItemId === item.catalogItemId) === true
  }
  if (item.kind === 'imaging') {
    return detail.imagingRequests?.requests.some(req => req.status !== 'cancelled' && req.service.id === item.serviceId) === true
  }
  return detail.pathologyRequests?.requests.some(req => req.status !== 'cancelled' && req.service.id === item.serviceId) === true
}

/** 推荐中待医生确认的条数；只在就绪时计数并扣减已确认/已开具项，供「助手 n」页签标记与助手行共用。 */
export function readyRecommendationCount(
  job: DoctorPreparationJob,
  detail?: DoctorCaseDetail,
  preferences?: DraftPreferences,
  excludedItemIds?: ReadonlySet<string>,
): number {
  if (job.state?.status !== 'ready') return 0
  return job.state.items.filter(item => !excludedItemIds?.has(item.kind === 'imaging' || item.kind === 'pathology' ? item.serviceId : item.catalogItemId)
    && !isRecommendationItemSettled(item, detail, preferences)).length
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
  const checklistRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setChecklistOpen(false)
  }, [detail.caseId])
  useEffect(() => {
    if (!checklistOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (checklistRef.current && event.target instanceof Node && !checklistRef.current.contains(event.target)) {
        setChecklistOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setChecklistOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [checklistOpen])
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
  const totalCount = completion.data?.items.length ?? 0
  const remainingCount = Math.max(0, totalCount - completed)
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
        {completionActive ? <div className="relative" ref={checklistRef}>
          <Button aria-expanded={checklistOpen} className={cn(chip, checklistOpen ? 'border-info/50 bg-info/10 text-info' : null)} onClick={() => setChecklistOpen(!checklistOpen)} size="sm" type="button" variant="outline">
            <ListChecksIcon aria-hidden="true" />
            {completion.data === undefined ? messages.encounterCompletionChecklist : messages.completionChecklistCount
              .replace('{complete}', String(completed)).replace('{total}', String(totalCount))}
            <ChevronDownIcon aria-hidden="true" className={cn('transition-transform', checklistOpen ? 'rotate-180' : null)} />
          </Button>
          {checklistOpen ? <section aria-label={messages.encounterCompletionChecklist}
            className="absolute top-full left-0 z-30 mt-1 w-[300px] max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-2.5 text-popover-foreground shadow-md">
            <div className="mb-1.5 flex items-center justify-between gap-2 border-b pb-1.5 text-xs">
              <span className="font-semibold">
                {completion.data === undefined ? messages.encounterCompletionChecklist : messages.completionChecklistCount
                  .replace('{complete}', String(completed)).replace('{total}', String(totalCount))}
              </span>
              {completion.data === undefined ? null : <Badge variant={remainingCount === 0 ? 'success' : 'warning'}>
                {remainingCount === 0
                  ? (zh ? '已全部满足' : 'All satisfied')
                  : (zh ? `还差 ${remainingCount} 项` : `${remainingCount} remaining`)}
              </Badge>}
            </div>
            <SectionState error={completion.error} messages={messages} onRetry={completion.refetch} pending={completion.isLoading}>
              {completion.data === undefined ? null : <ul className="flex min-w-0 flex-col gap-0.5">
                {completion.data.items.map(item => {
                  const sectionLabel = encounterCompletionTargetSectionLabel(item.target, messages)
                  const done = item.status === 'complete'
                  const body = <>
                    <span className="flex min-w-0 items-center gap-1.5">
                      {done
                        ? <CheckCircleIcon aria-hidden="true" className="size-3.5 shrink-0 text-success" />
                        : <CircleIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
                      <span className="truncate text-left text-xs font-medium">{encounterCompletionItemLabel(item.code, locale)}</span>
                    </span>
                    <span className={cn('shrink-0 text-[11px] font-normal', done ? 'text-muted-foreground' : 'text-info')} title={item.statusText}>
                      {done ? (zh ? '已满足' : 'Done') : (zh ? `前往${sectionLabel} ›` : `${sectionLabel} ›`)}
                    </span>
                    <span className="sr-only">{sectionLabel}</span>
                    <span className="sr-only">{item.statusText}</span>
                  </>
                  return <li className="min-w-0" key={item.code}>
                    {onNavigateToCompletionTarget === undefined
                      ? <div className="flex min-w-0 items-center justify-between gap-2 px-1.5 py-1 text-xs">{body}</div>
                      : <Button aria-label={completionGoToLabel(item, locale, messages)} className="h-auto w-full justify-between gap-2 px-1.5 py-1"
                        onClick={() => { onNavigateToCompletionTarget(item.target); setChecklistOpen(false) }} size="sm" type="button" variant="ghost">
                        {body}
                      </Button>}
                  </li>
                })}
              </ul>}
            </SectionState>
          </section> : null}
        </div> : null}
      </div>}
      {readOnly ? null : <section aria-label={messages.assistantPrepared} className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg bg-info/10 px-2.5 py-1.5">
        <span className="inline-flex items-center gap-1 text-xs font-medium text-info"><SparklesIcon aria-hidden="true" className="size-3.5" />{messages.assistantPrepared}</span>
        {preparation === undefined ? null : preparationKinds.map(kind => {
          const job = preparation.jobs[kind]
          const preferences = preparation.preferences(kind)
          const degraded = job.error !== null || job.state?.status === 'failed'
            || job.state?.recovery?.status === 'exhausted' || job.state?.recovery?.status === 'unknown'
            || job.state?.errorCode === 'MODEL_OUTCOME_UNKNOWN'
          const readyCount = job.state?.status === 'ready' ? readyRecommendationCount(job, detail, preferences) : undefined
          if (readyCount === 0 && !degraded && !jobInProgress(job)) return null
          const label = `${assistantKindLabels[kind][zh ? 0 : 1]} ${recommendationStatusText(job, kind, detail, messages, preferences)}`
          return <Button className={cn(
            chip,
            degraded ? 'border-dashed border-warning/60 bg-background/80 text-warning' : 'border-info/40 bg-background/80 text-info',
            jobInProgress(job) ? 'clinmesh-glow' : null,
          )} key={kind} size="sm" type="button" variant="outline"
            onClick={() => onNavigateToCompletionTarget === undefined ? preparation.openDetails(kind) : onNavigateToCompletionTarget(assistantKindTarget(kind))}>
            {label}
            {(readyCount !== undefined && readyCount > 0) || degraded ? <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0" /> : null}
          </Button>
        })}
        {!qualityEnabled ? null : qualityFailed ? <span className="inline-flex items-center gap-1 text-xs text-warning">
          {`${messages.suggestionQualityLabel} ${messages.suggestionRecommendationFailed}`}
          <Button className={chip} onClick={quality.retry} size="sm" type="button" variant="ghost">{messages.suggestionRetry}</Button>
        </span> : quality.stale ? <span className="inline-flex items-center gap-1 text-xs text-warning">
          {messages.documentQualityStale}
          <Button className={chip} onClick={quality.retry} size="sm" type="button" variant="ghost">{messages.suggestionRetry}</Button>
        </span> : quality.pending ? <span className={cn(chip, 'clinmesh-glow inline-flex items-center border border-info/40 bg-background/80 text-info')}>
          {`${messages.suggestionQualityLabel} ${messages.suggestionRecommendationPending}`}
        </span> : issues.length > 0 ? <Button className={cn(chip, 'border-info/40 bg-background/80 text-info')} size="sm" type="button" variant="outline"
          onClick={() => onNavigateToCompletionTarget === undefined ? preparation?.openDetails('quality') : onNavigateToCompletionTarget('clinical-document')}>
          {messages.suggestionQualityOpen.replace('{count}', String(issues.length))}
        </Button> : <span className="sr-only">{messages.suggestionQualityClear}</span>}
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

function recommendationStatusText(
  job: DoctorPreparationJob,
  kind: DoctorRecommendationKind,
  detail: DoctorCaseDetail,
  messages: WorkspaceMessages,
  preferences?: DraftPreferences,
): string {
  if (job.error !== null || job.state?.status === 'failed') return messages.suggestionRecommendationFailed
  if (jobInProgress(job)) return messages.suggestionRecommendationPending
  const state = job.state
  if (state?.recovery?.status === 'exhausted') return messages.suggestionRecommendationIdle === '待生成' ? '· 未自动生成' : '· not auto-generated'
  if (state?.recovery?.status === 'unknown' || state?.errorCode === 'MODEL_OUTCOME_UNKNOWN') return messages.suggestionRecommendationIdle === '待生成' ? '· 待继续确认' : '· awaiting confirmation'
  if (state?.status === 'missing-evidence') return messages.suggestionRecommendationMissingEvidence
  if (state?.status === 'ready') return String(readyRecommendationCount(job, detail, preferences))
  // 处方建议以已确认诊断为输入；诊断未确认时写明原因而不是「待生成」。
  if (kind === 'prescription' && detail.diagnosis?.confirmation === undefined) return messages.suggestionPrescriptionAfterDiagnosis
  return messages.suggestionRecommendationIdle
}
