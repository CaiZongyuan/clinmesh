import type { ClinicalDocumentContent, DoctorCaseDetail, EncounterCompletionPreview, EncounterCompletionTarget } from '@clinmesh/contracts/his'
import type { DoctorRecommendationKind } from '@clinmesh/contracts/doctor-recommendations'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { cn } from '@clinmesh/ui/lib/utils'
import { CheckCircleIcon, ChevronDownIcon, CircleIcon, ListChecksIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { WorkspaceLocale, WorkspaceMessages } from '../workspace-i18n.ts'
import { completionGoToLabel, encounterCompletionItemLabel, encounterCompletionTargetSectionLabel } from './completion-checklist.tsx'
import type { DoctorPreparationJob, DraftPreferences } from './doctor-preparation-state.tsx'

export type SuggestionCompletionView = {
  data: EncounterCompletionPreview | undefined
  isLoading: boolean
  error: Error | null
  refetch: () => void
}

export function assistantKindTarget(kind: DoctorRecommendationKind): EncounterCompletionTarget {
  return kind === 'prescription' ? 'medication-conclusion' : kind
}

export function readyRecommendationCount(
  _job: DoctorPreparationJob,
  _detail?: DoctorCaseDetail,
  _preferences?: DraftPreferences,
  _excludedItemIds?: ReadonlySet<string>,
): number {
  return 0
}

/** 患者头部的事实标签：生命体征与可展开的完诊清单，点击跳到对应页签。 */
export function DoctorAssistantSummary({ completion, detail, locale, messages, onNavigateToCompletionTarget }: {
  completion: SuggestionCompletionView
  detail: DoctorCaseDetail
  clinicalDocument?: ClinicalDocumentContent | undefined
  scope?: string
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
  const zh = locale === 'zh-CN'
  const vitals = detail.presentation?.vitalSigns
  const completed = completion.data?.items.filter(item => item.status === 'complete').length ?? 0
  const totalCount = completion.data?.items.length ?? 0
  const remainingCount = Math.max(0, totalCount - completed)
  // 完诊清单只在就诊进行中呈现：完诊后检查单已定稿，残留未完项与前往动作会与只读状态矛盾。
  const completionActive = detail.encounter.status === 'in-progress'
  const chip = 'h-6 gap-1 rounded-md px-2 text-xs font-normal'
  if (vitals === undefined && !completionActive) return <></>
  return (
    <div className="flex min-w-0 flex-col gap-1.5 px-4 pb-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {vitals === undefined ? null : <span className={cn(chip, 'inline-flex items-center border bg-muted/40 tabular-nums')} title={messages.vitalSigns}>
          <span className="sr-only">{messages.vitalSigns}：</span>
          {messages.vitalsFact.replace('{temperature}', String(vitals.temperatureC)).replace('{pulse}', String(vitals.pulseBpm))
            .replace('{respiration}', String(vitals.respirationBpm))
            .replace('{bloodPressure}', `${vitals.bloodPressure.systolicMmHg}/${vitals.bloodPressure.diastolicMmHg}`)
            .replace('{oxygen}', String(vitals.oxygenSaturationPct))}
          {vitals.weightKg === undefined ? '' : ` · ${vitals.weightKg} kg`}
          {vitals.heightCm === undefined ? '' : ` · ${vitals.heightCm} cm`}
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
      </div>
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
