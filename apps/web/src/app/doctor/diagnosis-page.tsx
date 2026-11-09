import type { DoctorRecommendationSuggestion } from '@clinmesh/contracts/doctor-recommendations'
import type { ClinicalCatalog, DiagnosisDraftEntry, DoctorCaseDetail } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@clinmesh/ui/components/alert-dialog'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { CheckCircleIcon, CircleAlertIcon, PlusIcon } from 'lucide-react'
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
import { DoctorDraftEditorScope, useDoctorDraftItemEdit } from './doctor-draft-fields.tsx'
import { DoctorOrderWorkspace } from './doctor-order-workspace.tsx'
import { useDoctorPreparation } from './doctor-preparation-state.tsx'
import { DoctorRecommendationsPanel, type ManualPreparedItem, type PreparationDraft } from './doctor-recommendations.tsx'
import { DoctorRecordReviewNotice } from './doctor-record-review-notice.tsx'
import { useAutosave } from './use-autosave.ts'
import { diagnosisEditorsChanged, useDiagnosisComposerDraft, useDiagnosisDraft, type DiagnosisDraftLine } from './diagnosis-draft-storage.ts'
import { useInvestigationConfirmationIntent, useInvestigationPreferences } from './investigation-draft-storage.ts'

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
  const operationPending = actions.save.pending || actions.confirm.pending || preparationSubmitting
  const catalogById = useMemo(() => new Map(catalog.map(item => [item.id, item])), [catalog])
  const draftScope = JSON.stringify([recommendationScope, caseId, encounter?.id, 'diagnosis'])
  const privateDraft = useDiagnosisDraft(draftScope, (state?.draft?.entries ?? []).map((entry, index) => ({
    ...entry, key: `saved-${index}`, note: entry.note ?? '',
  })))
  const composerDraft = useDiagnosisComposerDraft(draftScope)
  const preferences = useInvestigationPreferences(draftScope)
  const originalIntent = useInvestigationConfirmationIntent(draftScope, { caseId, kind: 'diagnosis', encounterId: encounter?.id })
  const recoveryPending = originalIntent.value !== null || originalIntent.failed
  const pending = operationPending || recoveryPending || privateDraft.failed || composerDraft.failed || preferences.failed
  const { entries, dirty } = privateDraft.value
  const pendingEditorChanges = diagnosisEditorsChanged(entries, composerDraft.editors)
  const pendingEditorMessage = locale === 'zh-CN' ? '有未保存诊断编辑，请保存修改后再确认。' : 'Save the pending diagnosis edits before confirming.'
  const currentEntriesRef = useRef(entries)
  currentEntriesRef.current = entries
  const saveEntries = (update: (previous: DiagnosisDraftLine[]) => DiagnosisDraftLine[], dirty = true) => {
    const before = currentEntriesRef.current, next = update(before)
    if (!privateDraft.save(previous => ({ ...previous, entries: next, dirty }))) return false
    currentEntriesRef.current = next
    return composerDraft.rebaseEditors(before, next)
  }
  const setDirty = (dirty: boolean) => privateDraft.save(previous => ({ ...previous, dirty }))
  const [recordQuery, setRecordQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<'all' | DiagnosisDraftEntry['role']>('all')
  const listSearchRef = useRef<HTMLInputElement>(null)
  // undefined 编辑索引表示连续新增；同窗回看使用稳定条目 key。
  const [composerOpen, setComposerOpen] = useState(false)
  const [composerEditIndex, setComposerEditIndex] = useState<number>()
  const [clearDraftOpen, setClearDraftOpen] = useState(false)
  const [clearDraftFailed, setClearDraftFailed] = useState(false)
  useRegisterAgentForm({
    viewId: 'consultation', selectionId: caseId, name: 'diagnosis',
    values: { entries: entries.map(({ catalogItemId, role, note }) => ({ catalogItemId, role, note })) },
  })
  const usedCatalogItemIds = new Set(entries.map(entry => entry.catalogItemId))
  const unavailableDiagnosis = (catalogItemId: string, referenceConcept: DiagnosisDraftEntry['referenceConcept']) => {
    if (referenceSearch.data?.items.some(item => item.id === catalogItemId && item.status === 'inactive')) return messages.recommendationDiagnosisUnavailable
    if (!catalogById.has(catalogItemId) && (referenceConcept?.id !== catalogItemId || referenceConcept.sourceLocator === 'operational:diagnosis_catalog')) return messages.recommendationDiagnosisUnavailable
    return undefined
  }
  const recommendationUnavailableReason = (suggestion: DoctorRecommendationSuggestion) => {
    if (pendingEditorChanges) return pendingEditorMessage
    if (readOnly || suggestion.kind !== 'diagnosis') return messages.recommendationDiagnosisUnavailable
    if (usedCatalogItemIds.has(suggestion.catalogItemId)) return messages.recommendationDiagnosisDuplicate
    if (entries.length >= 8) return messages.recommendationDiagnosisLimit
    return unavailableDiagnosis(suggestion.catalogItemId, suggestion.referenceConcept)
  }
  const addEntry = (selection: DiagnosisCatalogSelection, role: DiagnosisDraftEntry['role'], note: string) => {
    if (pending || readOnly) return false
    if (currentEntriesRef.current.length >= 8 || currentEntriesRef.current.some(entry => entry.catalogItemId === selection.catalogItemId)) return false
    const key = globalThis.crypto.randomUUID()
    return saveEntries(current => {
      const next = [...current, {
        catalogItemId: selection.catalogItemId,
        key,
        note,
        snapshotCode: selection.code, snapshotDisplay: selection.display,
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
  }
  const applyEntryEdit = (index: number, selection: DiagnosisCatalogSelection, role: DiagnosisDraftEntry['role'], note: string) => {
    if (pending || readOnly || entries[index] === undefined || entries.some((entry, entryIndex) => entryIndex !== index && entry.catalogItemId === selection.catalogItemId)) return false
    const nextRole = entries[index].role === 'primary' && role === 'secondary' && !entries.some((entry, entryIndex) => entryIndex !== index && entry.role === 'primary') ? 'primary' : role
    return saveEntries(current => current.map((line, lineIndex) => {
      if (lineIndex !== index) return nextRole === 'primary' && line.role === 'primary' ? { ...line, role: 'secondary' } : line
      const {
        referenceConcept: _previousReference,
        snapshotCode: _previousCode,
        snapshotDisplay: _previousDisplay,
        ...withoutReference
      } = line
      return {
        ...withoutReference,
        catalogItemId: selection.catalogItemId,
        role: nextRole,
        note,
        snapshotCode: selection.code, snapshotDisplay: selection.display,
        ...(selection.referenceConcept === undefined
          ? {}
          : { referenceConcept: selection.referenceConcept }),
      }
    }))
  }
  const removeEntry = (index: number) => {
    if (pending || readOnly) return false
    return saveEntries(current => {
      const remaining = current.filter((_, entryIndex) => entryIndex !== index)
      if (remaining.length > 0 && !remaining.some(entry => entry.role === 'primary')) {
        const first = remaining[0]
        if (first !== undefined) remaining[0] = { ...first, role: 'primary' }
      }
      return remaining
    })
  }
  const changePreparedEntry = ({ label, value }: ManualPreparedItem) => {
    if (value.kind !== 'diagnosis' || value.role === null || pending) return false
    const role = value.role
    return saveEntries(current => {
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
  }
  const removePreparedEntry = (value: PreparationDraft) => {
    if (value.kind !== 'diagnosis' || pending) return
    const index = entries.findIndex(entry => entry.catalogItemId === value.catalogItemId)
    if (index !== -1) removeEntry(index)
  }
  const consumePreparedEntries = (values: PreparationDraft[]) => {
    const remaining = entries.filter(entry => !values.some(value => value.kind === 'diagnosis'
      && value.catalogItemId === entry.catalogItemId && value.role === entry.role && (value.note ?? '') === entry.note.trim()))
    if (remaining.length === entries.length) return true
    return saveEntries(() => remaining, remaining.length > 0)
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
    if (!privateDraft.failed && dirty && actions.save.success && actions.save.savedRevision === currentRevision) setDirty(false)
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
    saveEntries(() => confirmed)
  }
  const entryDisplay = (entry: DiagnosisDraftLine) => {
    const local = catalogById.get(entry.catalogItemId)
    return {
      key: entry.key,
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
  const visibleEntries = displayedEntries.filter(entry => {
    const diagnosis = entryDisplay(entry)
    return (roleFilter === 'all' || entry.role === roleFilter)
      && `${diagnosis.code} ${diagnosis.display}`.toLocaleLowerCase().includes(recordQuery.trim().toLocaleLowerCase())
  })
  const composerTarget = useMemo<DiagnosisComposerTarget | undefined>(() => {
    const entry = composerEditIndex === undefined ? undefined : entries[composerEditIndex]
    if (entry === undefined) return undefined
    const diagnosis = entryDisplay(entry)
    return {
      key: entry.key,
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
      {entries.length === 0 && composerDraft.value === null && !privateDraft.failed && !composerDraft.failed && !preferences.failed ? null : <Button className="self-start" disabled={operationPending || recoveryPending} onClick={() => setClearDraftOpen(true)} size="sm" type="button" variant="ghost">{locale === 'zh-CN' ? '清空手动草稿' : 'Discard manual draft'}</Button>}
      {!privateDraft.failed && !composerDraft.failed && !preferences.failed ? null : <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{locale === 'zh-CN' ? '诊断草稿无法读取或保存，请确认清空草稿后再试。' : 'The diagnosis draft could not be read or saved. Confirm discarding it before continuing.'}</AlertTitle></Alert>}
      {!readOnly && entries.length > 0 && primaryCount !== 1 ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{messages.diagnosisPrimaryRequiredDescription}</AlertTitle>
        </Alert>
      ) : null}
      <DoctorDraftEditorScope id={composerEditIndex === undefined ? undefined : entries[composerEditIndex]?.catalogItemId} open={composerOpen}>{commit => <DiagnosisComposerDialog
        atCapacity={entries.length >= 8}
        defaultRole={composerDefaultRole}
        disabled={pending}
        draftScope={draftScope}
        excludedIds={composerEditIndex === undefined
          ? usedCatalogItemIds
          : new Set(entries.filter((_, entryIndex) => entryIndex !== composerEditIndex).map(line => line.catalogItemId))}
        localCatalog={catalog}
        locale={locale}
        onConfirm={(selection, role, note) => {
          const previous = composerEditIndex === undefined ? undefined : entries[composerEditIndex]
          const accepted = composerEditIndex === undefined ? addEntry(selection, role, note) : applyEntryEdit(composerEditIndex, selection, role, note)
          if (!accepted) return false
          commit()
          if (previous?.catalogItemId !== selection.catalogItemId) dismissDraftItem(selection.catalogItemId)
          return true
        }}
        pendingItems={<section aria-label={locale === 'zh-CN' ? '本次待确认诊断' : 'Pending diagnoses'} className="flex flex-col gap-2 border-b p-4">
          <p className="text-sm font-medium">{locale === 'zh-CN' ? `待确认 ${entries.length} 项 · 最多 8 项` : `${entries.length} pending · Up to 8`}</p>
          {entries.length === 0 && composerDraft.value === null ? null : <Button className="self-start" disabled={operationPending || recoveryPending} onClick={() => setClearDraftOpen(true)} size="sm" type="button" variant="ghost">{locale === 'zh-CN' ? '清空手动草稿' : 'Discard manual draft'}</Button>}
          {entries.map((entry, index) => <div className="flex min-w-0 items-start justify-between gap-2 text-sm" key={entry.key}>
            <div className="min-w-0"><Button aria-label={`${locale === 'zh-CN' ? '编辑待确认诊断' : 'Edit pending diagnosis'} ${entryDisplay(entry).display}`} className="h-auto whitespace-normal text-left" disabled={pending} onClick={() => setComposerEditIndex(index)} type="button" variant="ghost">{entryDisplay(entry).display} · {entry.role === 'primary' ? messages.primaryDiagnosis : messages.secondaryDiagnosis}</Button><p className="break-words text-xs text-muted-foreground">{entry.note}</p></div>
            <Button aria-label={`${locale === 'zh-CN' ? '移除待确认诊断' : 'Remove pending diagnosis'} ${entryDisplay(entry).display}`} disabled={pending} onClick={() => { if (removeEntry(index)) setComposerEditIndex(undefined) }} type="button" variant="ghost">{locale === 'zh-CN' ? '移除' : 'Remove'}</Button>
          </div>)}
        </section>}
        onOpenChange={setComposerOpen}
        open={composerOpen}
        search={referenceSearch}
        target={composerTarget}
      />}</DoctorDraftEditorScope>
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
          <DoctorRecommendationsPanel caseId={caseId} enabled={!readOnly} disabled={operationPending || privateDraft.failed || composerDraft.failed || preferences.failed}
            manualUnavailableReason={value => pendingEditorChanges ? pendingEditorMessage : value.kind === 'diagnosis' ? unavailableDiagnosis(value.catalogItemId, value.referenceConcept) : undefined}
            expectedDraftVersion={state?.draftVersion ?? 0} inputRevision={recommendationRevision}
            encounter={encounter} resolveExistingDraft={state?.draft !== undefined}
            issuedCatalogItemIds={new Set((state?.confirmation?.entries ?? []).filter(entry => !entries.some(line => line.catalogItemId === entry.catalogItemId)).map(entry => entry.catalogItemId))}
            onManualChange={changePreparedEntry} onManualEdit={value => { if (value.kind !== 'diagnosis') return; const index = entries.findIndex(entry => entry.catalogItemId === value.catalogItemId); if (index >= 0) { setComposerEditIndex(index); setComposerOpen(true) } }} onManualRemove={removePreparedEntry} onConfirmed={consumePreparedEntries}
            kind="diagnosis" locale={locale} manualItems={entries.map(entry => ({ label: entryDisplay(entry).display,
              value: { source: 'manual', kind: 'diagnosis', catalogItemId: entry.catalogItemId, role: entry.role,
                ...(entry.referenceConcept === undefined ? {} : { referenceConcept: entry.referenceConcept }),
                ...(entry.note.trim() ? { note: entry.note.trim() } : {}) },
            } satisfies ManualPreparedItem))} scope={recommendationScope} unavailableReason={recommendationUnavailableReason} />
        }
        records={state?.confirmation === undefined ? null : (
          <section aria-label={locale === 'zh-CN' ? '诊断列表' : 'Diagnosis list'}
            className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-3">
            {/* 确认状态与编辑入口归位于正式记录所在的列表头部，不再以独立告警块堆叠在页签底部。 */}
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                  <CheckCircleIcon aria-hidden="true" className="size-4 shrink-0 text-success" />
                  <span className="min-w-0">{messages.diagnosisConfirmed} · {locale === 'zh-CN'
                    ? `第 ${state.confirmation.revisionNumber} 次确认`
                    : `Revision ${state.confirmation.revisionNumber}`}</span>
                </p>
                {readOnly ? null : <Button disabled={pending} onClick={editConfirmedEntries}
                  size="sm" type="button" variant="outline">
                  {locale === 'zh-CN' ? '修改已确认诊断' : 'Edit confirmed diagnoses'}
                </Button>}
              </div>
              <p className="text-xs text-muted-foreground">
                {readOnly ? `${messages.diagnosisConfirmedAt} · ${state.confirmation.confirmedAt}` : locale === 'zh-CN'
                  ? '本次就诊结束前仍可继续修改；再次确认会保留上一轮记录。'
                  : 'You can keep editing until the encounter ends; reconfirming preserves the previous revision.'}
              </p>
            </div>
            {readOnly ? null : <DoctorRecordReviewNotice caseId={caseId}
              authoredAt={state.confirmation.confirmedAt} locale={locale} onReview={editConfirmedEntries} />}
            <div className="flex flex-wrap items-center gap-2">
              <Input aria-label={locale === 'zh-CN' ? '搜索本次诊断' : 'Search encounter diagnoses'}
                className="min-w-[12rem] flex-1"
                onChange={event => setRecordQuery(event.currentTarget.value)} placeholder={locale === 'zh-CN' ? '疾病名称或编码' : 'Disease name or code'}
                ref={listSearchRef} value={recordQuery} />
              <ToggleGroup data-view-switch="" aria-label={locale === 'zh-CN' ? '筛选诊断' : 'Filter diagnoses'} className="max-w-full flex-wrap" onValueChange={value => {
                const next = value[0]
                if (next === 'all' || next === 'primary' || next === 'secondary') setRoleFilter(next)
              }} size="sm" spacing={1} value={[roleFilter]} variant="outline">
                <ToggleGroupItem value="all">{locale === 'zh-CN' ? '全部' : 'All'}</ToggleGroupItem>
                <ToggleGroupItem value="primary">{messages.primaryDiagnosis}</ToggleGroupItem>
                <ToggleGroupItem value="secondary">{messages.secondaryDiagnosis}</ToggleGroupItem>
              </ToggleGroup>
            </div>
            {visibleEntries.length === 0 ? (
              <Empty>
                <EmptyHeader><EmptyTitle>{locale === 'zh-CN' ? '没有匹配的诊断' : 'No matching diagnoses'}</EmptyTitle>
                  <EmptyDescription>{locale === 'zh-CN' ? '搜索与筛选不会删除本次诊断。' : 'Search and filters do not remove encounter diagnoses.'}</EmptyDescription>
                </EmptyHeader>
                <Button onClick={() => { setRecordQuery(''); setRoleFilter('all') }} size="sm" type="button" variant="outline">
                  {locale === 'zh-CN' ? '查看全部诊断' : 'View all diagnoses'}
                </Button>
              </Empty>
            ) : (
              <div className="min-w-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-24">{messages.diagnosisRole}</TableHead>
                      <TableHead>{messages.diagnosisDisplay}</TableHead>
                      <TableHead className="w-28">{messages.diagnosisCode}</TableHead>
                      <TableHead>{messages.diagnosisNote}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleEntries.map(entry => {
                      const diagnosis = entryDisplay(entry)
                      return (
                        <TableRow key={entry.key}>
                          <TableCell>
                            <Badge variant={entry.role === 'primary' ? 'default' : 'secondary'}>
                              {entry.role === 'primary' ? messages.primaryDiagnosis : messages.secondaryDiagnosis}
                            </Badge>
                          </TableCell>
                          <TableCell className="whitespace-normal break-words font-medium">
                            <span data-agent-diagnosis-entry="">{diagnosis.display}</span>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">{diagnosis.code}</TableCell>
                          <TableCell className="whitespace-normal break-words text-xs text-muted-foreground">
                            {entry.note || (locale === 'zh-CN' ? '未填写备注' : 'No note recorded')}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>
        )}
        details={null}
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
      <AlertDialog onOpenChange={setClearDraftOpen} open={clearDraftOpen}>
        <AlertDialogContent><AlertDialogHeader>
          <AlertDialogTitle>{locale === 'zh-CN' ? '丢弃诊断手动草稿？' : 'Discard the manual diagnosis draft?'}</AlertDialogTitle>
          <AlertDialogDescription>{locale === 'zh-CN' ? '将丢弃本次就诊尚未确认的手动诊断及弹窗输入，已确认诊断不受影响。' : 'Discard the unconfirmed manual diagnoses and composer input for this encounter. Confirmed diagnoses are retained.'}</AlertDialogDescription>
        </AlertDialogHeader>
          {clearDraftFailed ? <p role="alert">{locale === 'zh-CN' ? '清空失败，草稿仍需核对，请重试。' : 'Discard failed. Review the remaining draft and retry.'}</p> : null}
          <AlertDialogFooter><AlertDialogCancel>{locale === 'zh-CN' ? '保留草稿' : 'Keep draft'}</AlertDialogCancel>
            <AlertDialogAction disabled={operationPending || recoveryPending} onClick={event => {
              event.preventDefault()
              if (!saveEntries(() => [], false) || !composerDraft.clear()
                || !preferences.save(previous => ({ ...previous, edits: Object.fromEntries(Object.entries(previous.edits).filter(([, edit]) => !edit.formOwned)) }))) {
                setClearDraftFailed(true); return
              }
              setComposerEditIndex(undefined); setClearDraftFailed(false); setClearDraftOpen(false)
            }}>{locale === 'zh-CN' ? '确认丢弃' : 'Discard draft'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
