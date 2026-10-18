import type { DoctorRecommendationSuggestion } from '@clinmesh/contracts/doctor-recommendations'
import { DoctorRecordReviewNotice } from './doctor-record-review-notice.tsx'
import type { ClinicalCatalog, DiagnosisDraftEntry, DoctorCaseDetail } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Separator } from '@clinmesh/ui/components/separator'
import { cn } from '@clinmesh/ui/lib/utils'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { ArrowLeftIcon, CheckCircleIcon, CheckIcon, CircleAlertIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRegisterAgentForm } from '../agent-page-context.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from '../workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import {
  DiagnosisCatalogDialog,
  DiagnosisCatalogPicker,
  type DiagnosisCatalogSelection,
  type ReferenceCatalogSearches,
} from './catalog-picker-dialogs.tsx'
import { DoctorRecommendationsPanel, type ManualPreparedItem, type PreparationDraft } from './doctor-recommendations.tsx'
import { useDoctorPreparation } from './doctor-preparation-state.tsx'
import { useAutosave } from './use-autosave.ts'
import { DoctorOrderWorkspace } from './doctor-order-workspace.tsx'

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
  const [selectedKey, setSelectedKey] = useState<string | undefined>(() => entries[0]?.key)
  const [selectedRecordCatalogItemId, setSelectedRecordCatalogItemId] = useState<string>()
  const [recordQuery, setRecordQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<'all' | DiagnosisDraftEntry['role']>('all')
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const listSearchRef = useRef<HTMLInputElement>(null)
  const detailsHeadingRef = useRef<HTMLHeadingElement>(null)
  const [replacementOpen, setReplacementOpen] = useState(false)
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
  const addEntry = (selection: DiagnosisCatalogSelection) => {
    if (pending) return
    if (entries.length >= 8 || usedCatalogItemIds.has(selection.catalogItemId)) return
    const key = globalThis.crypto.randomUUID()
    setEntries(current => [...current, {
      catalogItemId: selection.catalogItemId,
      key,
      note: '',
      ...(selection.referenceConcept === undefined
        ? {}
        : { referenceConcept: selection.referenceConcept }),
      role: current.some(entry => entry.role === 'primary') ? 'secondary' : 'primary',
    }])
    setSelectedKey(key)
    setDirty(true)
  }
  const updateEntry = (index: number, update: Partial<DiagnosisDraftLine>) => {
    if (pending) return
    setEntries(current => current.map((entry, entryIndex) => (
      entryIndex === index ? { ...entry, ...update } : entry
    )))
    setDirty(true)
  }
  const selectEntry = (index: number, selection: DiagnosisCatalogSelection) => {
    if (pending) return
    setEntries(current => current.map((entry, entryIndex) => {
      if (entryIndex !== index) return entry
      const {
        referenceConcept: _previousReference,
        snapshotCode: _previousCode,
        snapshotDisplay: _previousDisplay,
        ...withoutReference
      } = entry
      return {
        ...withoutReference,
        catalogItemId: selection.catalogItemId,
        ...(selection.referenceConcept === undefined
          ? {}
          : { referenceConcept: selection.referenceConcept }),
      }
    }))
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
    if (entries[index]?.key === selectedKey) {
      setSelectedKey(entries[index + 1]?.key ?? entries[index - 1]?.key)
    }
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
    setSelectedKey(current => remaining.some(entry => entry.key === current) ? current : remaining[0]?.key)
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
    setSelectedKey(confirmed[0]?.key)
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
  const renderEditor = (showChips = true) => {
    const entry = showChips ? entries.find(entry => entry.key === selectedKey) ?? entries[0] : visibleEntries.find(candidate => candidate.key === activeKey)
    const index = entries.findIndex(candidate => candidate.key === entry?.key)
    if (entry === undefined) return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{showChips
            ? locale === 'zh-CN' ? '选择一个诊断开始填写' : 'Select a diagnosis to start'
            : locale === 'zh-CN' ? '选择一条诊断查看详情' : 'Select a diagnosis to view details'}</EmptyTitle>
          <EmptyDescription>{showChips
            ? locale === 'zh-CN' ? '在左侧检索疾病名称或 ICD 编码，明确选择后编辑诊断信息。' : 'Search a disease name or ICD code, then select a diagnosis to edit its details.'
            : locale === 'zh-CN' ? '从左侧列表选择，或调整搜索与筛选。' : 'Select from the list, or adjust the search and filters.'}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
    const diagnosis = entryDisplay(entry)
    const suffix = index === 0 ? '' : ` ${index + 1}`
    return (
      <section aria-label={locale === 'zh-CN' ? showChips && state?.confirmation !== undefined ? '填写诊断详情' : '诊断详情' : showChips && state?.confirmation !== undefined ? 'Enter diagnosis details' : 'Diagnosis details'} data-agent-diagnosis-entry=""
        className={cn('flex min-w-0 flex-col gap-4 p-4', !showChips && !showMobileDetail && 'hidden @min-[760px]/case-content:flex')}>
        {showChips ? null : (
          <Button className="self-start @min-[760px]/case-content:hidden" onClick={() => {
            setMobileDetailOpen(false)
            window.setTimeout(() => listSearchRef.current?.focus(), 0)
          }} size="sm" type="button" variant="ghost">
            <ArrowLeftIcon data-icon="inline-start" />{locale === 'zh-CN' ? '返回诊断列表' : 'Back to diagnosis list'}
          </Button>
        )}
        {showChips ? <div aria-label={locale === 'zh-CN' ? '已选诊断' : 'Selected diagnoses'} className="flex flex-wrap gap-2" role="group">
          {entries.map(line => (
            <Button aria-pressed={line.key === selectedKey} data-agent-diagnosis-entry="" key={line.key}
              onClick={() => setSelectedKey(line.key)} size="sm" type="button" variant={line.key === selectedKey ? 'secondary' : 'outline'}>
              {entryDisplay(line).display}
            </Button>
          ))}
        </div> : null}
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
        {!showChips || readOnly ? (
          <dl className="flex flex-col gap-4 text-sm">
            <div><dt className="text-muted-foreground">{messages.diagnosisRole}</dt>
              <dd className="mt-1">{entry.role === 'primary' ? messages.primaryDiagnosis : messages.secondaryDiagnosis}</dd></div>
            <div><dt className="text-muted-foreground">{messages.diagnosisNote}</dt>
              <dd className="mt-1 whitespace-pre-wrap break-words">{entry.note || (locale === 'zh-CN' ? '未填写备注' : 'No note recorded')}</dd></div>
          </dl>
        ) : <FieldGroup>
          <Field>
            <FieldTitle>{messages.diagnosisRole}</FieldTitle>
            <ToggleGroup disabled={pending} aria-label={`${messages.diagnosisRole}${suffix}`} className="max-w-full flex-wrap" onValueChange={value => {
              const role = value[0]
              if (role === 'primary' || role === 'secondary') updateRole(index, role)
            }} size="sm" spacing={1} value={[entry.role]} variant="outline">
              <ToggleGroupItem value="primary">{messages.primaryDiagnosis}</ToggleGroupItem>
              <ToggleGroupItem disabled={entry.role === 'primary'} value="secondary">{messages.secondaryDiagnosis}</ToggleGroupItem>
            </ToggleGroup>
            <FieldDescription>{locale === 'zh-CN'
              ? '整组诊断保留一条主诊断，其他诊断为次诊断。'
              : 'Keep one primary diagnosis; all other diagnoses are secondary.'}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${elementId}-note`}>{messages.diagnosisNote}</FieldLabel>
            <Textarea disabled={pending} aria-label={`${messages.diagnosisNote}${suffix}`} className="min-h-28" id={`${elementId}-note`}
              maxLength={500} onChange={event => updateEntry(index, { note: event.currentTarget.value })} value={entry.note} />
            <FieldDescription>{entry.note.length} / 500</FieldDescription>
          </Field>
        </FieldGroup>}
        {!showChips || readOnly ? null : <div className="flex flex-wrap items-center justify-between gap-2">
          <DiagnosisCatalogDialog excludedIds={new Set(entries.filter(line => line.key !== entry.key).map(line => line.catalogItemId))}
            disabled={pending} localCatalog={catalog} locale={locale} mode="replace" onOpenChange={setReplacementOpen} onSelect={selection => selectEntry(index, selection)} search={referenceSearch} />
          <Button aria-label={`${messages.removeDiagnosis}${suffix}`} disabled={pending} onClick={() => removeEntry(index)} size="sm" type="button" variant="ghost">
            <Trash2Icon data-icon="inline-start" />{messages.removeDiagnosis}
          </Button>
        </div>}
      </section>
    )
  }
  const catalogEditor = (
    <div className="flex min-w-0 flex-col gap-4">
      <DiagnosisCatalogPicker active={!replacementOpen && !readOnly} collapsible={state?.confirmation !== undefined} disabled={pending || entries.length >= 8} excludedIds={usedCatalogItemIds}
        localCatalog={catalog} locale={locale} onSelect={selection => { if (selection !== undefined) addEntry(selection) }}
        search={referenceSearch} />
      {renderEditor()}
    </div>
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
        entry={readOnly ? null : <section aria-label={locale === 'zh-CN' ? '填写诊断' : 'Enter diagnosis'} className="flex min-w-0 flex-col gap-3">
          {catalogEditor}
          {state?.confirmation === undefined ? null : <Button disabled={pending} onClick={editConfirmedEntries}
            className="self-start" size="sm" type="button" variant="outline">
            {locale === 'zh-CN' ? '修改已确认诊断' : 'Edit confirmed diagnoses'}
          </Button>}
        </section>}
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
                <Button aria-pressed={entry.key === activeKey} className="h-auto min-w-0 justify-start whitespace-normal py-3"
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
        details={state?.confirmation === undefined ? null : renderEditor(false)}
      />
      {state?.confirmation === undefined ? null : (
        <Alert>
          <CheckCircleIcon aria-hidden="true" />
          <AlertTitle>
            {messages.diagnosisConfirmed} · {locale === 'zh-CN'
              ? `第 ${state.confirmation.revisionNumber} 版`
              : `Revision ${state.confirmation.revisionNumber}`}
          </AlertTitle>
          <AlertDescription>
            {readOnly ? `${messages.diagnosisConfirmedAt} · ${state.confirmation.confirmedAt}` : locale === 'zh-CN'
              ? '本次就诊结束前仍可继续修改；再次确认会保留上一版本。'
              : 'You can keep editing until the encounter ends; reconfirming preserves the previous revision.'}
          </AlertDescription>
        </Alert>
      )}
      {readOnly || state?.confirmation === undefined ? null : <DoctorRecordReviewNotice caseId={caseId}
        authoredAt={state.confirmation.confirmedAt} locale={locale} onReview={editConfirmedEntries} />}
      {!readOnly && entries.length > 0 && primaryCount !== 1 ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{messages.diagnosisPrimaryRequiredDescription}</AlertTitle>
        </Alert>
      ) : null}
      {readOnly ? null : <div className="flex flex-wrap items-center justify-between gap-2">
        <p aria-live="polite" className="text-xs text-muted-foreground">{saveStatus}</p>
        {retrySave}
      </div>}
      {!readOnly && actions.save.success && !dirty ? (
        <Alert><CheckIcon /><AlertTitle>{messages.diagnosisDraftSaved}</AlertTitle></Alert>
      ) : null}
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
