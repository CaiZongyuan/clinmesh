import type { ClinicalCatalog, DiagnosisDraftEntry, DoctorCaseDetail } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@clinmesh/ui/components/alert-dialog'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@clinmesh/ui/components/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Separator } from '@clinmesh/ui/components/separator'
import { cn } from '@clinmesh/ui/lib/utils'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { ArrowLeftIcon, CheckCircleIcon, CheckIcon, CircleAlertIcon, PlusIcon, Trash2Icon } from 'lucide-react'
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

export function DiagnosisPage({ actions, caseId, catalog, elementId, locale, messages, readOnly, referenceSearch, state }: {
  caseId: string
  actions: DiagnosisPageActions
  catalog: ClinicalCatalog['diagnoses']
  elementId: string
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  readOnly: boolean
  referenceSearch: ReferenceCatalogSearches['diagnoses']
  state: DoctorCaseDetail['diagnosis']
}): React.JSX.Element {
  const catalogById = useMemo(() => new Map(catalog.map(item => [item.id, item])), [catalog])
  const [entries, setEntries] = useState<DiagnosisDraftLine[]>(() => {
    if (state?.draft !== undefined) {
      return state.draft.entries.map((entry, index) => ({
        ...entry,
        key: `saved-${index}`,
        note: entry.note ?? '',
      }))
    }
    return state?.confirmation?.entries.map((entry, index) => ({
      catalogItemId: entry.catalogItemId,
      key: `confirmed-${index}`,
      note: entry.note ?? '',
      ...(entry.referenceConcept === undefined ? {} : { referenceConcept: entry.referenceConcept }),
      role: entry.role,
      snapshotCode: entry.code,
      snapshotDisplay: entry.display,
    })) ?? []
  })
  const [selectedKey, setSelectedKey] = useState<string | undefined>(() => entries[0]?.key)
  const [recordQuery, setRecordQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<'all' | DiagnosisDraftEntry['role']>('all')
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const listSearchRef = useRef<HTMLInputElement>(null)
  const detailsHeadingRef = useRef<HTMLHeadingElement>(null)
  const [replacementOpen, setReplacementOpen] = useState(false)
  const [dirty, setDirty] = useState(false)
  useRegisterAgentForm({
    viewId: 'consultation', selectionId: caseId, name: 'diagnosis',
    values: { entries: entries.map(({ catalogItemId, role, note }) => ({ catalogItemId, role, note })) },
  })
  const [confirmOpen, setConfirmOpen] = useState(false)
  const usedCatalogItemIds = new Set(entries.map(entry => entry.catalogItemId))
  const addEntry = (selection: DiagnosisCatalogSelection) => {
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
    setEntries(current => current.map((entry, entryIndex) => (
      entryIndex === index ? { ...entry, ...update } : entry
    )))
    setDirty(true)
  }
  const selectEntry = (index: number, selection: DiagnosisCatalogSelection) => {
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
  const canConfirm = valid && !dirty && state?.draft !== undefined
    && actions.save.error === null && !actions.save.pending && !actions.confirm.pending
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
    <Button disabled={!valid || actions.save.pending} onClick={() => actions.save.onSubmit(currentEntries)} size="sm" type="button" variant="outline">
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
    enabled: !readOnly && dirty && valid && !actions.save.pending,
    onSave: () => actions.save.onSubmit(currentEntries),
    revision: `${state?.draftVersion ?? 0}:${currentRevision}`,
  })
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
  const displayedEntries: DiagnosisDraftLine[] = readOnly ? state?.confirmation?.entries.map((entry, index) => ({
    catalogItemId: entry.catalogItemId,
    key: entries.find(line => line.catalogItemId === entry.catalogItemId)?.key ?? `confirmed-${index}`,
    note: entry.note ?? '',
    ...(entry.referenceConcept === undefined ? {} : { referenceConcept: entry.referenceConcept }),
    role: entry.role,
    snapshotCode: entry.code,
    snapshotDisplay: entry.display,
  })) ?? [] : entries
  const activeKey = readOnly && !displayedEntries.some(entry => entry.key === selectedKey)
    ? displayedEntries[0]?.key : selectedKey
  const selectedEntry = displayedEntries.find(entry => entry.key === activeKey)
  const visibleEntries = displayedEntries.filter(entry => {
    const diagnosis = entryDisplay(entry)
    return (roleFilter === 'all' || entry.role === roleFilter)
      && `${diagnosis.code} ${diagnosis.display}`.toLocaleLowerCase().includes(recordQuery.trim().toLocaleLowerCase())
  })
  const showMobileDetail = mobileDetailOpen && visibleEntries.some(entry => entry.key === activeKey)
  const renderEditor = (showChips = true) => {
    const index = displayedEntries.findIndex(entry => entry.key === activeKey)
    const entry = showChips ? selectedEntry : visibleEntries.find(candidate => candidate.key === activeKey)
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
      <section aria-label={locale === 'zh-CN' ? '诊断详情' : 'Diagnosis details'} data-agent-diagnosis-entry=""
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
        {readOnly ? (
          <dl className="flex flex-col gap-4 text-sm">
            <div><dt className="text-muted-foreground">{messages.diagnosisRole}</dt>
              <dd className="mt-1">{entry.role === 'primary' ? messages.primaryDiagnosis : messages.secondaryDiagnosis}</dd></div>
            <div><dt className="text-muted-foreground">{messages.diagnosisNote}</dt>
              <dd className="mt-1 whitespace-pre-wrap break-words">{entry.note || (locale === 'zh-CN' ? '未填写备注' : 'No note recorded')}</dd></div>
          </dl>
        ) : <FieldGroup>
          <Field>
            <FieldTitle>{messages.diagnosisRole}</FieldTitle>
            <ToggleGroup aria-label={`${messages.diagnosisRole}${suffix}`} className="max-w-full flex-wrap" onValueChange={value => {
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
            <Textarea aria-label={`${messages.diagnosisNote}${suffix}`} className="min-h-28" id={`${elementId}-note`}
              maxLength={500} onChange={event => updateEntry(index, { note: event.currentTarget.value })} value={entry.note} />
            <FieldDescription>{entry.note.length} / 500</FieldDescription>
          </Field>
        </FieldGroup>}
        {readOnly ? null : <div className="flex flex-wrap items-center justify-between gap-2">
          <DiagnosisCatalogDialog excludedIds={new Set(entries.filter(line => line.key !== entry.key).map(line => line.catalogItemId))}
            localCatalog={catalog} locale={locale} mode="replace" onOpenChange={setReplacementOpen} onSelect={selection => selectEntry(index, selection)} search={referenceSearch} />
          <Button aria-label={`${messages.removeDiagnosis}${suffix}`} onClick={() => removeEntry(index)} size="sm" type="button" variant="ghost">
            <Trash2Icon data-icon="inline-start" />{messages.removeDiagnosis}
          </Button>
        </div>}
      </section>
    )
  }
  const catalogEditor = (
    <div className="grid min-w-0 gap-4 @min-[760px]/case-content:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <DiagnosisCatalogPicker active={(state?.confirmation === undefined || addOpen) && !replacementOpen} disabled={entries.length >= 8} excludedIds={usedCatalogItemIds}
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
        {readOnly || state?.confirmation === undefined ? null : (
          <Dialog onOpenChange={open => { setAddOpen(open); if (!open) setMobileDetailOpen(true) }} open={addOpen}>
            <DialogTrigger render={<Button data-agent-catalog-trigger="diagnosis" disabled={entries.length >= 8} size="sm" type="button" variant="outline" />}>
              <PlusIcon data-icon="inline-start" />{locale === 'zh-CN' ? '添加诊断' : 'Add diagnosis'}
            </DialogTrigger>
            <DialogContent className="@container/case-content h-[min(760px,calc(100svh-2rem))] sm:max-w-5xl">
              <DialogHeader>
                <DialogTitle>{locale === 'zh-CN' ? '添加诊断' : 'Add diagnosis'}</DialogTitle>
                <DialogDescription>{locale === 'zh-CN'
                  ? '选择后加入本次诊断，修改自动保存；正式确认作用于整组诊断。'
                  : 'Selections join this encounter and edits save automatically. Formal confirmation applies to the whole diagnosis group.'}</DialogDescription>
              </DialogHeader>
              <div className="min-h-0 flex-1 overflow-y-auto">{addOpen ? catalogEditor : null}</div>
              {addOpen ? saveError : null}
              <DialogFooter>
                <p aria-live="polite" className="mr-auto text-xs text-muted-foreground">{saveStatus}</p>
                {retrySave}
                <DialogClose render={<Button type="button" />}>
                  {locale === 'zh-CN' ? '完成选择' : 'Done selecting'}
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>
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
      {state?.confirmation === undefined ? (
        catalogEditor
      ) : (
        <div className="grid min-w-0 gap-4 @min-[760px]/case-content:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.2fr)]">
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
                  data-agent-diagnosis-entry="" key={entry.key} onClick={() => { setSelectedKey(entry.key); setMobileDetailOpen(true); queueMicrotask(() => detailsHeadingRef.current?.focus()) }}
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
          {!readOnly && addOpen ? null : renderEditor(false)}
        </div>
      )}
      {!readOnly && entries.length > 0 && primaryCount !== 1 ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{messages.diagnosisPrimaryRequiredDescription}</AlertTitle>
        </Alert>
      ) : null}
      {readOnly ? null : <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {saveStatus}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {addOpen ? null : retrySave}
          <AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
            <AlertDialogTrigger
              render={<Button disabled={!canConfirm} type="button" />}
            >
              <CheckCircleIcon data-icon="inline-start" />{messages.confirmDiagnosis}
            </AlertDialogTrigger>
          <AlertDialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
              <AlertDialogHeader>
                <AlertDialogTitle>{locale === 'zh-CN' ? '确认诊断版本' : 'Confirm diagnosis revision'}</AlertDialogTitle>
                <AlertDialogDescription>
                  {locale === 'zh-CN'
                    ? '确认后生成正式诊断版本；本次就诊结束前仍可继续修改，历史版本会保留。'
                    : 'Confirmation creates a formal diagnosis revision. You can keep editing until the encounter ends, and prior revisions remain available.'}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <ul className="divide-y border text-sm">
                {entries.map((entry) => {
                  const diagnosis = entryDisplay(entry)
                  return (
                    <li className="flex items-center justify-between gap-3 px-3 py-2" key={entry.key}>
                      <span className="flex min-w-0 flex-col gap-1 break-words">
                        <span className="font-medium">{diagnosis.code} · {diagnosis.display}</span>
                        {entry.note.trim().length === 0 ? null : <span className="whitespace-pre-wrap text-xs text-muted-foreground">{entry.note.trim()}</span>}
                      </span>
                      <Badge variant={entry.role === 'primary' ? 'default' : 'secondary'}>
                        {entry.role === 'primary' ? messages.primaryDiagnosis : messages.secondaryDiagnosis}
                      </Badge>
                    </li>
                  )
                })}
              </ul>
              <AlertDialogFooter>
                <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
                <AlertDialogAction
                  disabled={!canConfirm}
                  onClick={() => {
                    setConfirmOpen(false)
                    actions.confirm.onSubmit()
                  }}
                >
                  <CheckCircleIcon data-icon="inline-start" />
                  {locale === 'zh-CN' ? '确认诊断版本' : 'Confirm diagnosis revision'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>}
      {!readOnly && actions.save.success && !dirty ? (
        <Alert><CheckIcon /><AlertTitle>{messages.diagnosisDraftSaved}</AlertTitle></Alert>
      ) : null}
      {readOnly || addOpen ? null : saveError}
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
