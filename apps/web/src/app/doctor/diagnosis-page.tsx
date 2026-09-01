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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { CheckCircleIcon, CheckIcon, CircleAlertIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from '../workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import {
  DiagnosisCatalogDialog,
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

export function DiagnosisPage({ actions, catalog, elementId, locale, messages, readOnly, referenceSearch, state }: {
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
  const [dirty, setDirty] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const usedCatalogItemIds = new Set(entries.map(entry => entry.catalogItemId))
  const addEntry = (selection: DiagnosisCatalogSelection) => {
    setEntries(current => [...current, {
      catalogItemId: selection.catalogItemId,
      key: globalThis.crypto.randomUUID(),
      note: '',
      ...(selection.referenceConcept === undefined
        ? {}
        : { referenceConcept: selection.referenceConcept }),
      role: current.some(entry => entry.role === 'primary') ? 'secondary' : 'primary',
    }])
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
      const { referenceConcept: _previousReference, ...withoutReference } = entry
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
  const currentEntries = submittedEntries()
  const currentRevision = JSON.stringify(currentEntries)
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

  if (readOnly && state?.confirmation !== undefined) {
    return (
      <section aria-labelledby="diagnosis-heading" className="flex flex-col gap-3" id={elementId} tabIndex={-1}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold" id="diagnosis-heading">{messages.diagnosisRecord}</h3>
          <Badge variant="secondary">{state.confirmation.entries.length}</Badge>
        </div>
        <Alert>
          <CheckCircleIcon aria-hidden="true" />
          <AlertTitle>{messages.diagnosisConfirmed}</AlertTitle>
          <AlertDescription>{messages.diagnosisConfirmedAt} · {state.confirmation.confirmedAt}</AlertDescription>
        </Alert>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{messages.diagnosisRole}</TableHead>
              <TableHead>{messages.diagnosisItem}</TableHead>
              <TableHead>{messages.diagnosisNote}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.confirmation.entries.map(entry => (
              <TableRow key={entry.conditionId}>
                <TableCell>
                  <Badge variant={entry.role === 'primary' ? 'default' : 'secondary'}>
                    {entry.role === 'primary' ? messages.primaryDiagnosis : messages.secondaryDiagnosis}
                  </Badge>
                </TableCell>
                <TableCell className="font-medium">{entry.code} · {entry.display}</TableCell>
                <TableCell>{entry.note ?? ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    )
  }

  if (readOnly) {
    return (
      <section aria-labelledby="diagnosis-heading" className="flex flex-col gap-3" id={elementId} tabIndex={-1}>
        <h3 className="text-sm font-semibold" id="diagnosis-heading">{messages.diagnosisRecord}</h3>
      </section>
    )
  }

  return (
    <section aria-labelledby="diagnosis-heading" className="flex flex-col gap-4" id={elementId} tabIndex={-1}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold" id="diagnosis-heading">{messages.diagnosisRecord}</h3>
        <DiagnosisCatalogDialog
          disabled={entries.length >= 8}
          excludedIds={usedCatalogItemIds}
          localCatalog={catalog}
          locale={locale}
          onSelect={addEntry}
          search={referenceSearch}
        />
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
            {locale === 'zh-CN'
              ? '本次就诊结束前仍可继续修改；再次确认会保留上一版本。'
              : 'You can keep editing until the encounter ends; reconfirming preserves the previous revision.'}
          </AlertDescription>
        </Alert>
      )}
      {entries.length === 0 ? (
        <div className="border px-4 py-10 text-center text-sm text-muted-foreground">
          {locale === 'zh-CN' ? '尚未添加本次诊断' : 'No encounter diagnosis added'}
        </div>
      ) : (
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">{messages.diagnosisRole}</TableHead>
              <TableHead className="w-[36%]">{messages.diagnosisItem}</TableHead>
              <TableHead>{messages.diagnosisNote}</TableHead>
              <TableHead className="w-20"><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry, index) => {
              const diagnosis = entryDisplay(entry)
              const suffix = index === 0 ? '' : ` ${index + 1}`
              const replacementExcludedIds = new Set(entries.flatMap((candidate, candidateIndex) => (
                candidateIndex === index ? [] : [candidate.catalogItemId]
              )))
              return (
                <TableRow key={entry.key}>
                  <TableCell className="align-top">
                    <ToggleGroup
                      aria-label={`${messages.diagnosisRole}${suffix}`}
                      className="flex-col items-stretch"
                      onValueChange={value => {
                        const role = value[0]
                        if (role === 'primary' || role === 'secondary') updateRole(index, role)
                      }}
                      size="sm"
                      spacing={1}
                      value={[entry.role]}
                      variant="outline"
                    >
                      <ToggleGroupItem value="primary">{messages.primaryDiagnosis}</ToggleGroupItem>
                      <ToggleGroupItem value="secondary">{messages.secondaryDiagnosis}</ToggleGroupItem>
                    </ToggleGroup>
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <span className="min-w-0">
                        <strong className="block break-words text-sm">{diagnosis.display}</strong>
                        <span className="mt-1 block break-all font-mono text-xs text-muted-foreground">{diagnosis.code}</span>
                      </span>
                      <DiagnosisCatalogDialog
                        excludedIds={replacementExcludedIds}
                        localCatalog={catalog}
                        locale={locale}
                        mode="replace"
                        onSelect={selection => selectEntry(index, selection)}
                        search={referenceSearch}
                      />
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    <Textarea
                      aria-label={`${messages.diagnosisNote}${suffix}`}
                      className="min-h-20"
                      maxLength={500}
                      onChange={event => updateEntry(index, { note: event.currentTarget.value })}
                      value={entry.note}
                    />
                  </TableCell>
                  <TableCell className="align-top text-right">
                    <Button
                      aria-label={`${messages.removeDiagnosis}${suffix}`}
                      onClick={() => removeEntry(index)}
                      size="icon-sm"
                      title={`${messages.removeDiagnosis}${suffix}`}
                      type="button"
                      variant="ghost"
                    >
                      <Trash2Icon />
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
      {entries.length > 0 && primaryCount !== 1 ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{messages.diagnosisPrimaryRequiredDescription}</AlertTitle>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {actions.save.error !== null
            ? messages.autosaveFailed
            : actions.save.pending
            ? messages.autosaveSaving
            : dirty
              ? messages.autosavePending
              : state?.draft === undefined ? '' : messages.autosaveSaved}
        </p>
        <AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
          <AlertDialogTrigger
            render={<Button disabled={!valid || dirty || state?.draft === undefined || actions.confirm.pending} type="button" />}
          >
            <CheckCircleIcon data-icon="inline-start" />{messages.confirmDiagnosis}
          </AlertDialogTrigger>
          <AlertDialogContent className="sm:max-w-lg">
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
                    <span className="font-medium">{diagnosis.code} · {diagnosis.display}</span>
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
                disabled={actions.confirm.pending}
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
      {actions.save.success && !dirty ? (
        <Alert><CheckIcon /><AlertTitle>{messages.diagnosisDraftSaved}</AlertTitle></Alert>
      ) : null}
      {actions.save.error === null ? null : (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{getWorkspaceErrorTitle(actions.save.error, messages, messages.operationFailed)}</AlertTitle>
          <AlertDescription>{getWorkspaceErrorMessage(actions.save.error, messages)}</AlertDescription>
        </Alert>
      )}
      {actions.confirm.error === null ? null : (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{getWorkspaceErrorTitle(actions.confirm.error, messages, messages.operationFailed)}</AlertTitle>
          <AlertDescription>{getWorkspaceErrorMessage(actions.confirm.error, messages)}</AlertDescription>
        </Alert>
      )}
    </section>
  )
}
