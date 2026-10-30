import type { DoctorRecommendationSuggestion } from '@clinmesh/contracts/doctor-recommendations'
import type { ClinicalCatalog, DiagnosisDraftEntry, DoctorCaseDetail } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Input } from '@clinmesh/ui/components/input'
import { Separator } from '@clinmesh/ui/components/separator'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { cn } from '@clinmesh/ui/lib/utils'
import { ArrowLeftIcon, CheckCircleIcon, CircleAlertIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRegisterAgentForm } from '../agent-page-context.tsx'
import { AgentReviewAnchor } from '../agent-review.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from '../workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import {
  DiagnosisComposerDialog,
  type DiagnosisCatalogSelection,
  type DiagnosisComposerTarget,
  type ReferenceCatalogSearches,
} from './catalog-picker-dialogs.tsx'
import { DoctorDraftItem, DoctorDraftItemScope, useDoctorDraftItemEdit } from './doctor-draft-fields.tsx'
import { DoctorOrderWorkspace } from './doctor-order-workspace.tsx'
import { useDoctorPreparation } from './doctor-preparation-state.tsx'
import { DoctorRecommendationsPanel, type ManualPreparedItem, type PreparationDraft } from './doctor-recommendations.tsx'
import { DoctorRecordReviewNotice } from './doctor-record-review-notice.tsx'
import { useAutosave } from './use-autosave.ts'

export interface DiagnosisPageActions {
  confirm: {
    error: Error | null
    onSubmit: () => void
    pending: boolean
  }
  save: {
    error: Error | null
    onSubmit: (entries: DiagnosisDraftEntry[]) => void
    pending: boolean
    savedRevision: string | undefined
    success: boolean
  }
}

interface DiagnosisDraftLine extends DiagnosisDraftEntry {
  key: string
  note: string
  snapshotCode?: string
  snapshotDisplay?: string
}

export function DiagnosisPage({ actions, caseId, catalog, elementId, encounter, locale, messages, readOnly, recommendationRevision, recommendationScope, referenceSearch, state }: {
  caseId: string
  actions: DiagnosisPageActions
  catalog: ClinicalCatalog['diagnoses']
  elementId: string
  encounter?: { id: string; versionId: string } | undefined
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  readOnly: boolean
  recommendationRevision?: string | undefined
  recommendationScope?: string | undefined
  referenceSearch: ReferenceCatalogSearches['diagnoses']
  state: DoctorCaseDetail['diagnosis']
}): React.JSX.Element {
  const dismissDraftItem = useDoctorDraftItemEdit()

  const preparationSubmitting = useDoctorPreparation()?.submitting('diagnosis') ?? false
  const pending = actions.save.pending || actions.confirm.pending || preparationSubmitting
  const catalogById = useMemo(() => new Map(catalog.map(item => [item.id, item])), [catalog])
  const [entries, setEntries] = useState<DiagnosisDraftLine[]>(() => {
    if (state?.draft !== undefined) {
      return state.draft.entries.map((entry, index) => ({
        ...entry,
        key: `saved-${index}`,
        note: entry.note ?? '',
      }))
    }
    return []
  })
  const [selectedRecordCatalogItemId, setSelectedRecordCatalogItemId] = useState<string>()
  const [recordQuery, setRecordQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<'all' | DiagnosisDraftEntry['role']>('all')
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const listSearchRef = useRef<HTMLInputElement>(null)
  const detailsHeadingRef = useRef<HTMLHeadingElement>(null)
  // 弹窗合同：一次弹窗只处理一条诊断；undefined 编辑索引表示新增。
  const [composerOpen, setComposerOpen] = useState(false)
  const [composerEditIndex, setComposerEditIndex] = useState<number>()
  const [dirty, setDirty] = useState(false)
  useRegisterAgentForm({
    viewId: 'consultation', selectionId: caseId, name: 'diagnosis',
    values: { entries: entries.map(({ catalogItemId, role, note }) => ({ catalogItemId, role, note })) },
  })
  const usedCatalogItemIds = new Set(entries.map(entry => entry.catalogItemId))
  const recommendationUnavailableReason = (suggestion: DoctorRecommendationSuggestion) => {
    if (readOnly || suggestion.kind !== 'diagnosis') return messages.recommendationDiagnosisUnavailable
    if (usedCatalogItemIds.has(suggestion.catalogItemId)) return messages.recommendationDiagnosisDuplicate
    if (entries.length >= 8) return messages.recommendationDiagnosisLimit
    if (referenceSearch.data?.items.some(item => item.id === suggestion.catalogItemId && item.status === 'inactive')) {
      return messages.recommendationDiagnosisUnavailable
    }
    const concept = suggestion.referenceConcept
    if (!catalogById.has(suggestion.catalogItemId)
      && (concept?.id !== suggestion.catalogItemId || concept.sourceLocator === 'operational:diagnosis_catalog')) {
      return messages.recommendationDiagnosisUnavailable
    }
    return undefined
  }
  const addEntry = (selection: DiagnosisCatalogSelection, role: DiagnosisDraftEntry['role'], note: string) => {
    if (pending) return
    if (entries.length >= 8 || usedCatalogItemIds.has(selection.catalogItemId)) return
    const key = globalThis.crypto.randomUUID()
    setEntries(current => {
      const next = [...current, {
        catalogItemId: selection.catalogItemId,
        key,
        note,
        ...(selection.referenceConcept === undefined
          ? {}
          : { referenceConcept: selection.referenceConcept }),
        role,
      }]
      // 与主次切换同一互斥语义：新的主诊断让位既有主诊断。
      return role === 'primary'
        ? next.map(entry => entry.key !== key && entry.role === 'primary' ? { ...entry, role: 'secondary' } : entry)
        : next
    })
    setDirty(true)
  }
  const applyEntryEdit = (index: number, selection: DiagnosisCatalogSelection, role: DiagnosisDraftEntry['role'], note: string) => {
    if (pending) return
    if (entries[index] === undefined) return
    setEntries(current => current.map((line, lineIndex) => {
      if (lineIndex !== index) return line
      const {
        referenceConcept: _previousReference,
        snapshotCode: _previousCode,
        snapshotDisplay: _previousDisplay,
        ...withoutReference
      } = line
      return {
        ...withoutReference,
        catalogItemId: selection.catalogItemId,
        note,
        ...(selection.referenceConcept === undefined
          ? {}
          : { referenceConcept: selection.referenceConcept }),
      }
    }))
    if (role !== entries[index].role) updateRole(index, role)
    setDirty(true)
  }
  const updateRole = (index: number, role: DiagnosisDraftEntry['role']) => {
    if (pending) return
    setEntries(current => {
      if (
        role === 'secondary'
        && current[index]?.role === 'primary'
        && !current.some((entry, entryIndex) => entryIndex !== index && entry.role === 'primary')
      ) {
        return current
      }
      return current.map((entry, entryIndex) => {
        if (entryIndex === index) return { ...entry, role }
        if (role === 'primary' && entry.role === 'primary') return { ...entry, role: 'secondary' }
        return entry
      })
    })
    setDirty(true)
  }
  const removeEntry = (index: number) => {
    if (pending) return
    setEntries(current => {
      const remaining = current.filter((_, entryIndex) => entryIndex !== index)
      if (remaining.length > 0 && !remaining.some(entry => entry.role === 'primary')) {
        const first = remaining[0]
        if (first !== undefined) remaining[0] = { ...first, role: 'primary' }
      }
      return remaining
    })
    setDirty(true)
  }
  const changePreparedEntry = ({ label, value }: ManualPreparedItem) => {
    if (value.kind !== 'diagnosis' || value.role === null || pending) return false
    const role = value.role
    setEntries(current => {
      const previous = current.find(entry => entry.catalogItemId === value.catalogItemId)
      const line: DiagnosisDraftLine = {
        catalogItemId: value.catalogItemId, key: previous?.key ?? globalThis.crypto.randomUUID(),
        note: value.note ?? '', role,
        ...(previous?.snapshotCode === undefined ? {} : { snapshotCode: previous.snapshotCode }),
        snapshotDisplay: previous?.snapshotDisplay ?? label,
        ...(value.referenceConcept === undefined ? {} : { referenceConcept: value.referenceConcept }),
      }
      const updated = previous === undefined ? [...current, line] : current.map(entry => entry.key === previous.key ? line : entry)
      return role === 'primary' ? updated.map(entry => entry.key !== line.key && entry.role === 'primary'
        ? { ...entry, role: 'secondary' } : entry) : updated
    })
    setDirty(true)
    return true
  }
  const removePreparedEntry = (value: PreparationDraft) => {
    if (value.kind !== 'diagnosis' || pending) return
    const index = entries.findIndex(entry => entry.catalogItemId === value.catalogItemId)
    if (index !== -1) removeEntry(index)
  }
  const consumePreparedEntries = (values: PreparationDraft[]) => {
    const remaining = entries.filter(entry => !values.some(value => value.kind === 'diagnosis'
      && value.catalogItemId === entry.catalogItemId && value.role === entry.role && (value.note ?? '') === entry.note.trim()))
    if (remaining.length === entries.length) return
    setEntries(remaining)
    setDirty(remaining.length > 0)
  }
  const submittedEntries = (): DiagnosisDraftEntry[] => entries.map(({
    key: _key,
    note,
    snapshotCode: _snapshotCode,
    snapshotDisplay: _snapshotDisplay,
    ...entry
  }) => ({
    ...entry,
    ...(note.trim().length === 0 ? {} : { note: note.trim() }),
  }))
  const primaryCount = entries.filter(entry => entry.role === 'primary').length
  const valid = entries.length > 0
    && entries.every(entry => entry.catalogItemId.length > 0)
    && primaryCount === 1
  const currentEntries = submittedEntries()
  const currentRevision = JSON.stringify(currentEntries)
  const saveStatus = actions.save.error !== null
    ? messages.autosaveFailed
    : actions.save.pending
      ? messages.autosaveSaving
      : dirty
        ? messages.autosavePending
        : state?.draft === undefined ? '' : messages.autosaveSaved
  const retrySave = actions.save.error === null ? null : (
    <Button disabled={!valid || pending} onClick={() => actions.save.onSubmit(currentEntries)} size="sm" type="button" variant="outline">
      {locale === 'zh-CN' ? '重试保存' : 'Retry save'}
    </Button>
  )
  const saveError = actions.save.error === null ? null : (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>{getWorkspaceErrorTitle(actions.save.error, messages, messages.operationFailed)}</AlertTitle>
      <AlertDescription>{getWorkspaceErrorMessage(actions.save.error, messages)}</AlertDescription>
    </Alert>
  )
  useEffect(() => {
    if (actions.save.success && actions.save.savedRevision === currentRevision) setDirty(false)
  }, [actions.save.savedRevision, actions.save.success, currentRevision])
  useAutosave({
    delayMs: 800,
    enabled: !readOnly && dirty && valid && !pending,
    onSave: () => actions.save.onSubmit(currentEntries),
    revision: `${state?.draftVersion ?? 0}:${currentRevision}`,
  })
  const editConfirmedEntries = () => {
    if (pending || readOnly || state?.confirmation === undefined) return
    if (entries.length > 0) return
    const confirmed = state.confirmation.entries.map((entry, index) => ({
      catalogItemId: entry.catalogItemId, key: `confirmed-${index}`, note: entry.note ?? '', role: entry.role,
      snapshotCode: entry.code, snapshotDisplay: entry.display,
      ...(entry.referenceConcept === undefined ? {} : { referenceConcept: entry.referenceConcept }),
    }))
    setEntries(confirmed)
    setDirty(true)
  }
  const entryDisplay = (entry: DiagnosisDraftLine) => {
    const local = catalogById.get(entry.catalogItemId)
    return {
      code: entry.referenceConcept?.code ?? entry.snapshotCode ?? local?.code ?? entry.catalogItemId,
      display: entry.referenceConcept?.display
        ?? entry.snapshotDisplay
        ?? (locale === 'zh-CN' ? local?.nameZh : local?.nameEn)
        ?? entry.catalogItemId,
    }
  }
  const displayedEntries: DiagnosisDraftLine[] = state?.confirmation?.entries.map((entry, index) => ({
    catalogItemId: entry.catalogItemId,
    key: entries.find(line => line.catalogItemId === entry.catalogItemId)?.key ?? `confirmed-${index}`,
    note: entry.note ?? '',
    ...(entry.referenceConcept === undefined ? {} : { referenceConcept: entry.referenceConcept }),
    role: entry.role,
    snapshotCode: entry.code,
    snapshotDisplay: entry.display,
  })) ?? []
  const activeKey = (displayedEntries.find(entry => entry.catalogItemId === selectedRecordCatalogItemId)
    ?? displayedEntries[0])?.key
  const visibleEntries = displayedEntries.filter(entry => {
    const diagnosis = entryDisplay(entry)
    return (roleFilter === 'all' || entry.role === roleFilter)
      && `${diagnosis.code} ${diagnosis.display}`.toLocaleLowerCase().includes(recordQuery.trim().toLocaleLowerCase())
  })
  const showMobileDetail = mobileDetailOpen && visibleEntries.some(entry => entry.key === activeKey)
  const renderDetails = () => {
    const entry = visibleEntries.find(candidate => candidate.key === activeKey)
    if (entry === undefined) return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{locale === 'zh-CN' ? '选择一条诊断查看详情' : 'Select a diagnosis to view details'}</EmptyTitle>
          <EmptyDescription>{locale === 'zh-CN' ? '从列表选择，或调整搜索与筛选。' : 'Select from the list, or adjust the search and filters.'}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
    const diagnosis = entryDisplay(entry)
    return (
      <section aria-label={locale === 'zh-CN' ? '诊断详情' : 'Diagnosis details'}
        className={cn('flex min-w-0 flex-col gap-4 rounded-lg border p-4', !showMobileDetail && 'hidden @min-[760px]/case-content:flex')}>
        <Button className="self-start @min-[760px]/case-content:hidden" onClick={() => {
          setMobileDetailOpen(false)
          window.setTimeout(() => listSearchRef.current?.focus(), 0)
        }} size="sm" type="button" variant="ghost">
          <ArrowLeftIcon data-icon="inline-start" />{locale === 'zh-CN' ? '返回诊断列表' : 'Back to diagnosis list'}
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h4 className="break-words font-semibold" ref={detailsHeadingRef} tabIndex={-1}>{diagnosis.display}</h4>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{diagnosis.code}</p>
          </div>
          <Badge variant={entry.role === 'primary' ? 'default' : 'secondary'}>
            {entry.role === 'primary' ? messages.primaryDiagnosis : messages.secondaryDiagnosis}
          </Badge>
        </div>
        <Separator />
        <dl className="flex flex-col gap-4 text-sm">
          <div><dt className="text-muted-foreground">{messages.diagnosisRole}</dt>
            <dd className="mt-1">{entry.role === 'primary' ? messages.primaryDiagnosis : messages.secondaryDiagnosis}</dd></div>
          <div><dt className="text-muted-foreground">{messages.diagnosisNote}</dt>
            <dd className="mt-1 whitespace-pre-wrap break-words">{entry.note || (locale === 'zh-CN' ? '未填写备注' : 'No note recorded')}</dd></div>
        </dl>
      </section>
    )
  }
  const composerTarget = useMemo<DiagnosisComposerTarget | undefined>(() => {
    const entry = composerEditIndex === undefined ? undefined : entries[composerEditIndex]
    if (entry === undefined) return undefined
    const diagnosis = entryDisplay(entry)
    return {
      catalogItemId: entry.catalogItemId,
      code: diagnosis.code,
      display: diagnosis.display,
      note: entry.note,
      ...(entry.referenceConcept === undefined ? {} : { referenceConcept: entry.referenceConcept }),
      role: entry.role,
    }
  }, [catalogById, composerEditIndex, entries, locale])
  const composerDefaultRole: DiagnosisDraftEntry['role'] = entries.some(entry => entry.role === 'primary') ? 'secondary' : 'primary'
  const draftEntrySection = (
    // 弹窗合同：左主列只保留选择入口与已选列表；目录浏览与表单填写在同一次弹窗内完成。
    <section aria-label={locale === 'zh-CN' ? '填写诊断' : 'Enter diagnosis'} className="flex min-w-0 flex-col gap-3"><AgentReviewAnchor id={`doctor-diagnosis:${caseId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button data-agent-catalog-trigger="diagnosis" disabled={pending || entries.length >= 8}
          onClick={() => { setComposerEditIndex(undefined); setComposerOpen(true) }} size="sm" type="button" variant="outline">
          <PlusIcon data-icon="inline-start" />{messages.addDiagnosis}
        </Button>
        <p className="text-xs text-muted-foreground">{locale === 'zh-CN'
          ? `最多 8 条 · 当前 ${entries.length} 条`
          : `Up to 8 · ${entries.length} recorded`}</p>
      </div>
      {entries.length === 0 ? (
        <div className="rounded-lg border border-dashed p-3">
          <p className="text-sm font-medium">{locale === 'zh-CN' ? '选择一个诊断开始填写' : 'Select a diagnosis to start'}</p>
          <p className="mt-1 text-xs text-muted-foreground">{
            locale === 'zh-CN' ? '在弹窗中检索疾病名称或 ICD 编码，明确选择后填写诊断信息。' : 'Search a disease name or ICD code in the dialog, then enter the diagnosis details.'}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {entries.map((entry, index) => {
            const diagnosis = entryDisplay(entry)
            return (
              <li className="flex min-w-0 items-center gap-1 rounded-md border px-2 py-1.5 [&:has([data-agent-draft-source])]:border-transparent" key={entry.key}><DoctorDraftItem id={entry.catalogItemId}><div className="flex min-w-0 items-center gap-1 pr-14">
                <Button aria-label={`${locale === 'zh-CN' ? '编辑诊断' : 'Edit diagnosis'} ${diagnosis.display}`}
                  className="h-auto min-w-0 flex-1 justify-start gap-2" data-agent-diagnosis-entry=""
                  onClick={() => { setComposerEditIndex(index); setComposerOpen(true) }}
                  type="button" variant="ghost">
                  <span className="flex min-w-0 flex-col items-start">
                    <span className="break-words text-left font-medium text-sm">{diagnosis.display}</span>
                    <span className="break-all text-left font-mono text-xs text-muted-foreground">{diagnosis.code}</span>
                  </span>
                </Button>
                <Badge className="shrink-0" variant={entry.role === 'primary' ? 'default' : 'secondary'}>
                  {entry.role === 'primary' ? messages.primaryDiagnosis : messages.secondaryDiagnosis}
                </Badge>
                <Button aria-label={`${messages.removeDiagnosis} ${diagnosis.display}`} disabled={pending}
                  onClick={() => removeEntry(index)} size="icon-sm" title={messages.removeDiagnosis} type="button" variant="ghost">
                  <Trash2Icon />
                </Button>
              </div></DoctorDraftItem></li>
            )
          })}
        </ul>
      )}
      {!readOnly && entries.length > 0 && primaryCount !== 1 ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{messages.diagnosisPrimaryRequiredDescription}</AlertTitle>
        </Alert>
      ) : null}
      <DoctorDraftItemScope id={composerEditIndex === undefined ? undefined : entries[composerEditIndex]?.catalogItemId}><DiagnosisComposerDialog
        defaultRole={composerDefaultRole}
        disabled={pending}
        excludedIds={composerEditIndex === undefined
          ? usedCatalogItemIds
          : new Set(entries.filter((_, entryIndex) => entryIndex !== composerEditIndex).map(line => line.catalogItemId))}
        localCatalog={catalog}
        locale={locale}
        onConfirm={(selection, role, note) => {
              dismissDraftItem(selection.catalogItemId)
              const previous = composerEditIndex === undefined ? undefined : entries[composerEditIndex]
              if (previous !== undefined) dismissDraftItem(previous.catalogItemId)
          if (composerEditIndex === undefined) addEntry(selection, role, note)
          else applyEntryEdit(composerEditIndex, selection, role, note)
        }}
        onOpenChange={setComposerOpen}
        open={composerOpen}
        search={referenceSearch}
        target={composerTarget}
      /></DoctorDraftItemScope>
    </AgentReviewAnchor></section>
  )

  if (readOnly && state?.confirmation === undefined) {
    return (
      <section aria-labelledby="diagnosis-heading" className="flex flex-col gap-3" id={elementId} tabIndex={-1}>
        <h3 className="text-sm font-semibold" id="diagnosis-heading">{messages.diagnosisRecord}</h3>
      </section>
    )
  }

  return (
    <section aria-labelledby="diagnosis-heading" className="flex flex-col gap-4" id={elementId} tabIndex={-1}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" id="diagnosis-heading">{messages.diagnosisRecord}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{displayedEntries.length === 0
            ? locale === 'zh-CN' ? '搜索疾病目录，填写本次就诊的主次诊断' : 'Search the disease catalog and record the encounter diagnoses'
            : locale === 'zh-CN'
              ? `共 ${displayedEntries.length} 条诊断 · ${displayedEntries.filter(entry => entry.role === 'primary').length} 条主诊断`
              : `${displayedEntries.length} diagnoses · ${displayedEntries.filter(entry => entry.role === 'primary').length} primary`}</p>
        </div>
      </div>
      <DoctorOrderWorkspace
        hasRecords={state?.confirmation !== undefined}
        entry={readOnly ? null : draftEntrySection}
        pending={
          <DoctorRecommendationsPanel caseId={caseId} enabled={!readOnly} disabled={actions.save.pending || actions.confirm.pending}
            expectedDraftVersion={state?.draftVersion ?? 0} inputRevision={recommendationRevision}
            encounter={encounter} resolveExistingDraft={state?.draft !== undefined}
            onManualChange={changePreparedEntry} onManualRemove={removePreparedEntry} onConfirmed={consumePreparedEntries}
            kind="diagnosis" locale={locale} manualItems={entries.map(entry => ({ label: entryDisplay(entry).display,
              value: { source: 'manual', kind: 'diagnosis', catalogItemId: entry.catalogItemId, role: entry.role,
                ...(entry.referenceConcept === undefined ? {} : { referenceConcept: entry.referenceConcept }),
                ...(entry.note.trim() ? { note: entry.note.trim() } : {}) },
            } satisfies ManualPreparedItem))} scope={recommendationScope} unavailableReason={recommendationUnavailableReason} />
        }
        records={state?.confirmation === undefined ? null : (
          <section aria-label={locale === 'zh-CN' ? '诊断列表' : 'Diagnosis list'}
            className={cn('flex min-w-0 flex-col gap-3 border p-3', showMobileDetail && 'hidden @min-[760px]/case-content:flex')}>
            {/* 确认状态与编辑入口归位于正式记录所在的列表头部，不再以独立告警块堆叠在页签底部。 */}
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                  <CheckCircleIcon aria-hidden="true" className="size-4 shrink-0 text-success" />
                  <span className="min-w-0">{messages.diagnosisConfirmed} · {locale === 'zh-CN'
                    ? `第 ${state.confirmation.revisionNumber} 版`
                    : `Revision ${state.confirmation.revisionNumber}`}</span>
                </p>
                {readOnly ? null : <Button disabled={pending} onClick={editConfirmedEntries}
                  size="sm" type="button" variant="outline">
                  {locale === 'zh-CN' ? '修改已确认诊断' : 'Edit confirmed diagnoses'}
                </Button>}
              </div>
              <p className="text-xs text-muted-foreground">
                {readOnly ? `${messages.diagnosisConfirmedAt} · ${state.confirmation.confirmedAt}` : locale === 'zh-CN'
                  ? '本次就诊结束前仍可继续修改；再次确认会保留上一版本。'
                  : 'You can keep editing until the encounter ends; reconfirming preserves the previous revision.'}
              </p>
            </div>
            {readOnly ? null : <DoctorRecordReviewNotice caseId={caseId}
              authoredAt={state.confirmation.confirmedAt} locale={locale} onReview={editConfirmedEntries} />}
            <Input aria-label={locale === 'zh-CN' ? '搜索本次诊断' : 'Search encounter diagnoses'}
              onChange={event => setRecordQuery(event.currentTarget.value)} placeholder={locale === 'zh-CN' ? '疾病名称或编码' : 'Disease name or code'}
              ref={listSearchRef} value={recordQuery} />
            <ToggleGroup aria-label={locale === 'zh-CN' ? '筛选诊断' : 'Filter diagnoses'} className="max-w-full flex-wrap" onValueChange={value => {
              const next = value[0]
              if (next === 'all' || next === 'primary' || next === 'secondary') setRoleFilter(next)
            }} size="sm" spacing={1} value={[roleFilter]} variant="outline">
              <ToggleGroupItem value="all">{locale === 'zh-CN' ? '全部' : 'All'}</ToggleGroupItem>
              <ToggleGroupItem value="primary">{messages.primaryDiagnosis}</ToggleGroupItem>
              <ToggleGroupItem value="secondary">{messages.secondaryDiagnosis}</ToggleGroupItem>
            </ToggleGroup>
            {visibleEntries.length === 0 ? (
              <Empty>
                <EmptyHeader><EmptyTitle>{locale === 'zh-CN' ? '没有匹配的诊断' : 'No matching diagnoses'}</EmptyTitle>
                  <EmptyDescription>{locale === 'zh-CN' ? '搜索与筛选不会删除本次诊断。' : 'Search and filters do not remove encounter diagnoses.'}</EmptyDescription>
                </EmptyHeader>
                <Button onClick={() => { setRecordQuery(''); setRoleFilter('all') }} size="sm" type="button" variant="outline">
                  {locale === 'zh-CN' ? '查看全部诊断' : 'View all diagnoses'}
                </Button>
              </Empty>
            ) : visibleEntries.map(entry => {
              const diagnosis = entryDisplay(entry)
              return (
                <Button aria-pressed={entry.key === activeKey} className="h-auto min-w-0 justify-start whitespace-normal py-2"
                  data-agent-diagnosis-entry="" key={entry.key} onClick={() => { setSelectedRecordCatalogItemId(entry.catalogItemId); setMobileDetailOpen(true); queueMicrotask(() => detailsHeadingRef.current?.focus()) }}
                  type="button" variant={entry.key === activeKey ? 'secondary' : 'outline'}>
                  <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                    <span className="break-words text-left font-medium">{diagnosis.display}</span>
                    <span className="break-all font-mono text-xs text-muted-foreground">{diagnosis.code}</span>
                  </span>
                  <Badge variant={entry.role === 'primary' ? 'default' : 'secondary'}>
                    {entry.role === 'primary' ? messages.primaryDiagnosis : messages.secondaryDiagnosis}
                  </Badge>
                </Button>
              )
            })}
          </section>
        )}
        details={state?.confirmation === undefined ? null : renderDetails()}
      />
      {readOnly ? null : <div className="flex flex-wrap items-center justify-between gap-2">
        <p aria-live="polite" className="text-xs text-muted-foreground">{saveStatus}</p>
        {retrySave}
      </div>}
      {readOnly ? null : saveError}
      {readOnly || actions.confirm.error === null ? null : (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{getWorkspaceErrorTitle(actions.confirm.error, messages, messages.operationFailed)}</AlertTitle>
          <AlertDescription>{getWorkspaceErrorMessage(actions.confirm.error, messages)}</AlertDescription>
        </Alert>
      )}
    </section>
  )
}
