import type { DoctorRecommendationSuggestion } from '@clinmesh/contracts/doctor-recommendations'
import type {
  ClinicalCatalog,
  DoctorCaseDetail,
  PrescriptionDraftItem,
} from '@clinmesh/contracts/his'
import { prescriptionDraftContentSchema } from '@clinmesh/contracts/his'
import type { ReferenceMedicationProduct } from '@clinmesh/contracts/reference-data'
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
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { cn } from '@clinmesh/ui/lib/utils'
import {
  CheckIcon,
  CircleAlertIcon,
  PillIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRegisterAgentForm } from '../agent-page-context.tsx'
import {
  getPrescriptionIssueErrorMessage,
  getWorkspaceErrorMessage,
  getWorkspaceErrorTitle,
} from '../workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import {
  MedicationComposerDialog,
  medicationPackageSummary,
  type MedicationCatalogSelection,
  type MedicationComposerFields,
  type MedicationComposerTarget,
  type ReferenceCatalogSearches,
} from './catalog-picker-dialogs.tsx'
import { formatClinicalDateTime } from './clinical-date-time.ts'
import { DoctorDraftEditorScope, DoctorDraftItem, useDoctorDraftItemEdit } from './doctor-draft-fields.tsx'
import { DoctorOrderWorkspace } from './doctor-order-workspace.tsx'
import { useDoctorPreparation } from './doctor-preparation-state.tsx'
import { DoctorRecommendationsPanel, type ManualPreparedItem, type PreparationDraft } from './doctor-recommendations.tsx'
import { DoctorRecordReviewNotice } from './doctor-record-review-notice.tsx'
import { useAutosave } from './use-autosave.ts'
import { prescriptionEditorsChanged, usePrescriptionComposerDraft, usePrescriptionDraft, type PrescriptionDraftLine } from './prescription-draft-storage.ts'
import { useInvestigationConfirmationIntent, useInvestigationPreferences } from './investigation-draft-storage.ts'

function ErrorAlert({ message, title }: { message: string; title: string }): React.JSX.Element {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

export interface PrescriptionPageActions {
  confirmNoMedication: {
    error: Error | null
    onSubmit: () => void
    pending: boolean
  }
  deleteDraft: {
    data: { caseId: string; draftVersion: number } | undefined
    error: Error | null
    onSubmit: () => void
    pending: boolean
  }
  issue: {
    error: Error | null
    onSubmit: () => void
    pending: boolean
  }
  saveDraft: {
    error: Error | null
    onSubmit: (items: PrescriptionDraftItem[]) => void
    pending: boolean
    savedRevision: string | undefined
    success: boolean
  }
  withdraw: {
    error: Error | null
    onSubmit: () => void
    pending: boolean
  }
}

type PrescriptionClinicalCatalog = Extract<
  ClinicalCatalog,
  { prescriptionConclusionSupported: true }
>
type PrescriptionMedicationCatalogItem = PrescriptionClinicalCatalog['medications'][number]

function createPrescriptionDraftLine(
  medication: PrescriptionMedicationCatalogItem,
  key: string,
): PrescriptionDraftLine {
  return {
    catalogItemId: medication.id,
    courseDays: medication.defaultCourseDays,
    doseText: medication.defaultDoseText,
    frequencyCode: medication.defaultFrequencyCode,
    key,
    quantity: medication.defaultQuantity,
  }
}

function createReferencePrescriptionDraftLine(
  product: ReferenceMedicationProduct,
  key: string = globalThis.crypto.randomUUID(),
): PrescriptionDraftLine {
  return {
    catalogItemId: product.id,
    courseDays: 3,
    doseText: '',
    frequencyCode: '',
    key,
    quantity: 1,
    referenceProduct: product,
  }
}

export function PrescriptionPage({
  actions,
  allowWithdrawal,
  catalog,
  detail,
  elementId,
  locale,
  messages,
  readOnly,
  recommendationRevision,
  recommendationScope,
  referenceSearch,
}: {
  actions: PrescriptionPageActions
  allowWithdrawal: boolean
  catalog: PrescriptionClinicalCatalog['medications']
  detail: DoctorCaseDetail
  elementId: string
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  readOnly: boolean
  recommendationRevision?: string
  recommendationScope?: string
  referenceSearch: ReferenceCatalogSearches['medications']
}): React.JSX.Element {
  const dismissDraftItem = useDoctorDraftItemEdit()

  const preparationSubmitting = useDoctorPreparation()?.submitting('prescription') ?? false
  const operationPending = actions.saveDraft.pending || actions.issue.pending || actions.deleteDraft.pending || actions.confirmNoMedication.pending || preparationSubmitting
  const state = detail.medicationConclusion
  const prescription = state?.prescription
  const noMedicationConclusion = state?.noMedication
  const hasActivePrescription = prescription !== undefined && prescription.status !== 'withdrawn'
  const draftScope = JSON.stringify([recommendationScope, detail.caseId, detail.encounter.id, 'prescription'])
  const privateDraft = usePrescriptionDraft(draftScope,
    (state?.draft?.items ?? []).map(item => ({ ...item, key: `saved:${item.catalogItemId}` })),
    noMedicationConclusion === undefined ? 'prescription' : 'no-medication')
  const { dirty, items, mode } = privateDraft.value
  const composerDraft = usePrescriptionComposerDraft(draftScope, items)
  const pendingEditorChanges = prescriptionEditorsChanged(items, composerDraft.editors)
  const pendingEditorMessage = locale === 'zh-CN' ? '有未保存用药编辑，请保存修改后再确认。' : 'Save the pending medicine edits before confirming.'
  const preferences = useInvestigationPreferences(draftScope)
  const originalIntent = useInvestigationConfirmationIntent(draftScope, { caseId: detail.caseId, kind: 'prescription', encounterId: detail.encounter.id })
  const recoveryPending = originalIntent.value !== null || originalIntent.failed
  const pending = operationPending || recoveryPending || privateDraft.failed || composerDraft.failed || preferences.failed
  const setMode = (mode: 'prescription' | 'no-medication') => privateDraft.save(previous => ({ ...previous, mode }))
  const setDirty = (dirty: boolean) => privateDraft.save(previous => ({ ...previous, dirty }))
  const setItems = (update: PrescriptionDraftLine[] | ((previous: PrescriptionDraftLine[]) => PrescriptionDraftLine[])) => {
    const next = typeof update === 'function' ? update(currentItems.current) : update
    if (!privateDraft.save(previous => ({ ...previous, items: next }))) return false
    currentItems.current = next
    return composerDraft.rebaseEditors(next)
  }
  const canEditDraft = !readOnly && noMedicationConclusion === undefined
    && !hasActivePrescription && mode === 'prescription' && prescription === undefined
  const [composerOpen, setComposerOpen] = useState(false)
  const [composerEditIndex, setComposerEditIndex] = useState<number>()
  const [deleteDraftOpen, setDeleteDraftOpen] = useState(false)
  const [clearPrivateDraftOpen, setClearPrivateDraftOpen] = useState(false)
  const [clearPrivateDraftFailed, setClearPrivateDraftFailed] = useState(false)
  const [noMedicationOpen, setNoMedicationOpen] = useState(false)
  const [recordSearch, setRecordSearch] = useState('')
  const recordSearchRef = useRef<HTMLInputElement>(null)
  const recordTerms = recordSearch.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const visibleRecords = (prescription?.items ?? []).filter(item => {
    const text = [item.display, item.catalogItemId, item.referenceProduct?.manufacturer, item.referenceProduct?.packageDescription].join(' ').toLocaleLowerCase()
    return recordTerms.every(term => text.includes(term))
  })
  const currentItems = useRef(items)
  currentItems.current = items
  const catalogById = useMemo(() => new Map(catalog.map(item => [item.id, item])), [catalog])
  const submittedItems = items.map(({ key: _key, ...item }) => item)
  const draftValidation = prescriptionDraftContentSchema.safeParse({ items: submittedItems })
  useRegisterAgentForm({
    viewId: 'consultation', selectionId: detail.caseId, name: 'prescription',
    values: { mode, items: items.map(({ catalogItemId, courseDays, doseText, frequencyCode, quantity }) => ({ catalogItemId, courseDays, doseText, frequencyCode, quantity })) },
  })
  const currentRevision = JSON.stringify(draftValidation.success ? draftValidation.data.items : submittedItems)
  useEffect(() => {
    if (actions.saveDraft.success && actions.saveDraft.savedRevision === currentRevision) {
      setDirty(false)
    }
  }, [actions.saveDraft.savedRevision, actions.saveDraft.success, currentRevision])
  const deletedCaseId = actions.deleteDraft.data?.caseId
  const deletedDraftVersion = actions.deleteDraft.data?.draftVersion
  const draftDeletionRef = useRef<{ revision: string; clearComposer: boolean } | undefined>(undefined)
  const handledDeletionRef = useRef<{ caseId: string; draftVersion: number } | undefined>(undefined)
  useEffect(() => {
    if (deletedCaseId !== detail.caseId || deletedDraftVersion === undefined) return
    if (handledDeletionRef.current?.caseId === deletedCaseId && handledDeletionRef.current.draftVersion === deletedDraftVersion) return
    handledDeletionRef.current = { caseId: deletedCaseId, draftVersion: deletedDraftVersion }
    const deletion = draftDeletionRef.current
    if ((dirty && deletion?.revision !== currentRevision) || (state?.draftVersion ?? 0) > deletedDraftVersion) return
    draftDeletionRef.current = undefined
    if (!setItems([])) { setClearPrivateDraftFailed(true); return }
    setDirty(false)
    if (deletion?.clearComposer && !composerDraft.clear()) { setClearPrivateDraftFailed(true); return }
    if (!preferences.save(previous => ({ ...previous, edits: Object.fromEntries(Object.entries(previous.edits).filter(([, edit]) => !edit.formOwned)) }))) {
      setClearPrivateDraftFailed(true); return
    }
    setComposerEditIndex(undefined)
    setClearPrivateDraftOpen(false)
  }, [currentRevision, deletedCaseId, deletedDraftVersion, detail.caseId, dirty, state?.draftVersion])
  const usedCatalogItemIds = new Set(items.map(item => item.catalogItemId))
  const canCombineWithCurrentItems = (
    candidate: PrescriptionMedicationCatalogItem,
    ignoredIndex?: number,
  ) => items.every((item, index) => {
    if (index === ignoredIndex || item.catalogItemId === candidate.id) return true
    const selected = catalogById.get(item.catalogItemId)
    return selected?.allowedCombinationIds.includes(candidate.id) === true
      && candidate.allowedCombinationIds.includes(item.catalogItemId)
  })
  const isRecommendationAvailable = (suggestion: DoctorRecommendationSuggestion) => {
    if (!canEditDraft || suggestion.kind !== 'prescription' || items.length >= 8
      || actions.issue.pending || actions.confirmNoMedication.pending || actions.deleteDraft.pending
      || usedCatalogItemIds.has(suggestion.catalogItemId)) return false
    const medication = catalogById.get(suggestion.catalogItemId)
    return medication !== undefined && canCombineWithCurrentItems(medication)
      && (suggestion.doseText === null || medication.allowedDoseTexts.includes(suggestion.doseText))
      && (suggestion.frequencyCode === null || medication.allowedFrequencyCodes.includes(suggestion.frequencyCode))
      && (suggestion.courseDays === null || medication.allowedCourseDays.includes(suggestion.courseDays))
      && (suggestion.quantity === null || medication.allowedQuantities.includes(suggestion.quantity))
  }
  const medicationLine = (
    selection: MedicationCatalogSelection,
    key: string = globalThis.crypto.randomUUID(),
  ) => selection.kind === 'reference'
    ? createReferencePrescriptionDraftLine(selection.product, key)
    : createPrescriptionDraftLine(selection.medication, key)
  const addMedication = (selection: MedicationCatalogSelection, fields?: MedicationComposerFields) => {
    if (!canEditDraft || pending) return false
    const line = { ...medicationLine(selection), ...fields }
    const previous = currentItems.current
    if (previous.length >= 8 || previous.some(item => item.catalogItemId === line.catalogItemId
      || (item.referenceProduct !== undefined) !== (line.referenceProduct !== undefined))) return false
    if (selection.kind === 'local' && !canCombineWithCurrentItems(selection.medication)) return false
    const next = [...previous, line]
    if (!privateDraft.save(previous => ({ ...previous, items: next, dirty: true }))) return false
    currentItems.current = next
    return true
  }
  const replaceMedication = (index: number, selection: MedicationCatalogSelection, fields?: MedicationComposerFields) => {
    if (!canEditDraft || pending || currentItems.current[index] === undefined) return false
    const id = selection.kind === 'local' ? selection.medication.id : selection.product.id
    if (currentItems.current.some((item, itemIndex) => itemIndex !== index && (item.catalogItemId === id
      || (item.referenceProduct !== undefined) !== (selection.kind === 'reference')))) return false
    if (selection.kind === 'local' && !canCombineWithCurrentItems(selection.medication, index)) return false
    if (!setItems(current => current.map((item, itemIndex) => (
      itemIndex === index ? { ...medicationLine(selection, item.key), ...fields } : item
    )))) return false
    setDirty(true)
    return true
  }
  const changePreparedItem = ({ value }: ManualPreparedItem) => {
    if (value.kind !== 'prescription' || !canEditDraft || pending) return false
    const previousIndex = items.findIndex(item => item.catalogItemId === value.catalogItemId)
    if (previousIndex === -1 && items.length >= 8) return false
    const isReference = value.referenceProduct !== undefined
    if (items.some((item, index) => index !== previousIndex && (item.referenceProduct !== undefined) !== isReference)) {
      return false
    }
    if (!isReference) {
      const candidate = catalogById.get(value.catalogItemId)
      if (candidate === undefined || !canCombineWithCurrentItems(candidate, previousIndex === -1 ? undefined : previousIndex)) {
        return false
      }
    }
    if (!setItems(current => {
      const previous = current.find(item => item.catalogItemId === value.catalogItemId)
      const line: PrescriptionDraftLine = {
        catalogItemId: value.catalogItemId, key: previous?.key ?? globalThis.crypto.randomUUID(),
        courseDays: value.courseDays, doseText: value.doseText ?? '', frequencyCode: value.frequencyCode ?? '', quantity: value.quantity,
        ...(value.referenceProduct === undefined ? {} : { referenceProduct: value.referenceProduct }),
      }
      return previous === undefined ? [...current, line] : current.map(item => item.key === previous.key ? line : item)
    })) return false
    setDirty(true)
    return true
  }
  const manualPreparedUnavailableReason = (value: PreparationDraft): string | undefined => {
    if (value.kind !== 'prescription') return undefined
    if (pendingEditorChanges) return pendingEditorMessage
    if (!canEditDraft || actions.issue.pending || actions.confirmNoMedication.pending || actions.deleteDraft.pending) {
      return messages.recommendationRequestTargetUnavailable
    }
    const previousIndex = items.findIndex(item => item.catalogItemId === value.catalogItemId)
    const isReference = value.referenceProduct !== undefined
    if (items.some((item, index) => index !== previousIndex && (item.referenceProduct !== undefined) !== isReference)) {
      return messages.prescriptionIssueReason_mixedCatalogSources
    }
    if (isReference) return undefined
    const candidate = catalogById.get(value.catalogItemId)
    if (
      candidate === undefined
      || !canCombineWithCurrentItems(candidate, previousIndex === -1 ? undefined : previousIndex)
      || (value.doseText !== null && !candidate.allowedDoseTexts.includes(value.doseText))
      || (value.frequencyCode !== null && !candidate.allowedFrequencyCodes.includes(value.frequencyCode))
      || (value.courseDays !== null && !candidate.allowedCourseDays.includes(value.courseDays))
      || (value.quantity !== null && !candidate.allowedQuantities.includes(value.quantity))
    ) {
      return messages.recommendationRequestTargetUnavailable
    }
    return undefined
  }
  const removeMedication = (catalogItemId: string) => {
    if (!canEditDraft || pending) return
    const remaining = items.filter(item => item.catalogItemId !== catalogItemId)
    if (remaining.length === 0 && state?.draft !== undefined) {
      draftDeletionRef.current = { revision: currentRevision, clearComposer: false }
      actions.deleteDraft.onSubmit()
      return
    }
    if (!setItems(remaining)) return
    setDirty(true)
  }
  const removePreparedItem = (value: PreparationDraft) => {
    if (value.kind === 'prescription') removeMedication(value.catalogItemId)
  }
  const consumePreparedItems = (values: PreparationDraft[]) => {
    const remaining = items.filter(item => !values.some(value => value.kind === 'prescription'
      && value.catalogItemId === item.catalogItemId && value.doseText === item.doseText
      && value.frequencyCode === item.frequencyCode && value.courseDays === item.courseDays && value.quantity === item.quantity))
    if (remaining.length === items.length) return
    if (!setItems(remaining)) return false
    setDirty(remaining.length > 0)
  }
  const canAddMedication = items.length < 8
  const invalidDraft = !draftValidation.success
  const saveCurrentDraft = () => {
    if (canEditDraft && !pending && draftValidation.success) actions.saveDraft.onSubmit(draftValidation.data.items)
  }
  useAutosave({
    delayMs: 800,
    enabled: canEditDraft && dirty && !invalidDraft && !pending,
    onSave: saveCurrentDraft,
    revision: `${state?.draftVersion ?? 0}:${currentRevision}`,
  })
  const draftSaveFeedback = (
    <div className="flex flex-wrap items-center gap-2">
      <p aria-live="polite" className="text-xs text-muted-foreground">
        {actions.saveDraft.error !== null
          ? messages.autosaveFailed
          : actions.saveDraft.pending
            ? messages.autosaveSaving
            : dirty
              ? messages.autosavePending
              : state?.draft === undefined ? '' : messages.autosaveSaved}
      </p>
      {actions.saveDraft.error === null ? null : (
        <Button disabled={invalidDraft || pending} onClick={saveCurrentDraft} size="sm" type="button" variant="outline">
          {locale === 'zh-CN' ? '重试保存' : 'Retry save'}
        </Button>
      )}
    </div>
  )

  // 结论方式开关位于左主列顶部（选择入口之上）；草稿工具跟随表单区；
  // 右辅助列只保留一块推荐/待开具面板。
  const deletionReceiptVisible = actions.deleteDraft.data !== undefined
    && actions.deleteDraft.data.caseId === detail.caseId
    && state?.draft === undefined
    && state?.draftVersion === actions.deleteDraft.data.draftVersion
  const conclusionModeControl = readOnly || noMedicationConclusion !== undefined || hasActivePrescription ? null : (
    <Field className="min-w-0 flex-wrap items-center justify-between gap-2" orientation="horizontal">
      <FieldLabel className="shrink-0 text-xs text-muted-foreground" id="medication-conclusion-mode-label">{messages.medicationConclusionMode}</FieldLabel>
      <ToggleGroup
        className="max-w-full flex-wrap"
        data-view-switch=""
        disabled={pending}
        aria-labelledby="medication-conclusion-mode-label"
        onValueChange={value => {
          const selectedMode = value[0]
          if (selectedMode === 'prescription' || selectedMode === 'no-medication') {
            setMode(selectedMode)
          }
        }}
        size="sm"
        spacing={1}
        value={[mode]}
        variant="outline"
      >
        <ToggleGroupItem value="prescription">{messages.prescriptionMode}</ToggleGroupItem>
        <ToggleGroupItem value="no-medication">{messages.noMedicationMode}</ToggleGroupItem>
      </ToggleGroup>
    </Field>
  )
  const draftTools = canEditDraft
    && (dirty || state?.draft !== undefined || actions.saveDraft.error !== null || deletionReceiptVisible) ? (
      <div className="flex min-w-0 flex-col gap-2 border-t pt-3" data-draft-tools="">
        {draftSaveFeedback}
        {state?.draft === undefined ? null : (
          <AlertDialog pending={actions.deleteDraft.pending} onOpenChange={setDeleteDraftOpen} open={deleteDraftOpen}>
            <AlertDialogTrigger
              render={(
                <Button
                  disabled={dirty || actions.deleteDraft.pending || actions.issue.pending || actions.saveDraft.pending}
                  type="button"
                  variant="ghost"
                />
              )}
            >
              <Trash2Icon data-icon="inline-start" />{messages.deletePrescriptionDraft}
            </AlertDialogTrigger>
            <AlertDialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto">
              <AlertDialogHeader>
                <AlertDialogTitle>{messages.deletePrescriptionDraftTitle}</AlertDialogTitle>
                <AlertDialogDescription>{messages.deletePrescriptionDraftDescription}</AlertDialogDescription>
              </AlertDialogHeader>
              <ul className="flex flex-col gap-1.5 text-sm">
                {state.draft.items.map((item) => {
                  const medication = catalogById.get(item.catalogItemId)
                  return (
                    <li className="flex flex-wrap justify-between gap-2" key={item.catalogItemId}>
                      <span className="font-medium">
                        {(locale === 'zh-CN' ? medication?.nameZh : medication?.nameEn)
                          ?? item.referenceProduct?.genericName
                          ?? item.catalogItemId}
                      </span>
                      <span className="text-muted-foreground">
                        {messages.quantity} {item.quantity}
                      </span>
                    </li>
                  )
                })}
              </ul>
              <AlertDialogFooter>
                <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
                <AlertDialogCancel
                  disabled={dirty || actions.deleteDraft.pending || actions.saveDraft.pending}
                  onClick={() => {
                    setDeleteDraftOpen(false)
                    queueMicrotask(actions.deleteDraft.onSubmit)
                  }}
                  variant="destructive"
                >
                  <Trash2Icon data-icon="inline-start" />{messages.confirmDelete}
                </AlertDialogCancel>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        {deletionReceiptVisible ? (
          <Alert>
            <CheckIcon aria-hidden="true" />
            <AlertTitle>{messages.prescriptionDraftDeleted}</AlertTitle>
          </Alert>
        ) : null}
      </div>
    ) : null

  // 无需用药结论在左主列内呈现：结论方式切换后直接替换目录+表单卡，不空置栏位、不再另起整页横条。
  const noMedicationPanel = readOnly || noMedicationConclusion !== undefined || mode !== 'no-medication' ? null : (
    <section aria-label={messages.confirmNoMedication} className="flex min-w-0 flex-col gap-3 rounded-lg border p-4">
      <Alert>
        <CheckIcon aria-hidden="true" />
        <AlertTitle>{messages.confirmNoMedication}</AlertTitle>
        <AlertDescription>
          {locale === 'zh-CN' ? '记录本次就诊无需用药，不生成药品医嘱或处方。' : 'Record that no medication is needed for this encounter. No medication orders or prescription will be created.'}
          {items.length === 0 ? null : (locale === 'zh-CN' ? '现有未开具草稿将同时清除。' : 'The existing unissued draft will also be cleared.')}
        </AlertDescription>
      </Alert>
      {draftSaveFeedback}
      <AlertDialog pending={actions.confirmNoMedication.pending} onOpenChange={setNoMedicationOpen} open={noMedicationOpen}>
        <AlertDialogTrigger render={<Button
          className="self-start"
          data-unavailable={dirty || actions.confirmNoMedication.pending || actions.deleteDraft.pending || actions.issue.pending || actions.saveDraft.pending ? '' : undefined}
          disabled={dirty || actions.confirmNoMedication.pending || actions.deleteDraft.pending || actions.issue.pending || actions.saveDraft.pending}
          type="button"
          variant="outline"
        />}>
          <CheckIcon data-icon="inline-start" />{messages.confirmNoMedication}
        </AlertDialogTrigger>
        <AlertDialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>{messages.confirmNoMedication}</AlertDialogTitle>
            <AlertDialogDescription>
              {locale === 'zh-CN' ? '记录本次就诊无需用药，不生成药品医嘱或处方。' : 'Record that no medication is needed for this encounter. No medication orders or prescription will be created.'}
              {items.length === 0 ? null : (locale === 'zh-CN' ? '现有未开具草稿将同时清除。' : 'The existing unissued draft will also be cleared.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="break-words text-sm font-medium">{detail.patient.name}</p>
          {items.length === 0 ? null : (
            <ul className="flex flex-col gap-2 text-sm">
              {items.map(item => (
                <li className="flex flex-wrap justify-between gap-2" key={item.key}><DoctorDraftItem id={item.catalogItemId}><div className="flex min-w-0 items-center gap-1 pr-14">
                  <span className="break-words">{item.referenceProduct?.genericName
                    ?? (locale === 'zh-CN' ? catalogById.get(item.catalogItemId)?.nameZh : catalogById.get(item.catalogItemId)?.nameEn)
                    ?? item.catalogItemId}</span>
                  <span className="text-muted-foreground">{messages.quantity} {item.quantity}</span>
                </div></DoctorDraftItem></li>
              ))}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
            <AlertDialogCancel disabled={dirty || actions.confirmNoMedication.pending || actions.deleteDraft.pending || actions.issue.pending || actions.saveDraft.pending} onClick={() => {
              setNoMedicationOpen(false)
              queueMicrotask(actions.confirmNoMedication.onSubmit)
            }} variant="default">
              <CheckIcon data-icon="inline-start" />{messages.confirmNoMedication}
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {actions.confirmNoMedication.error === null ? null : (
        <ErrorAlert
          message={getWorkspaceErrorMessage(actions.confirmNoMedication.error, messages)}
          title={getWorkspaceErrorTitle(actions.confirmNoMedication.error, messages, messages.operationFailed)}
        />
      )}
    </section>
  )

  // 目录连续加入后保留打开，待开清单仍由页面唯一拥有。
  const composerExcludedIds = useMemo(() => new Set(
    items.flatMap((item, index) => (index === composerEditIndex ? [] : [item.catalogItemId])),
  ), [composerEditIndex, items])
  const composerLockedSource = useMemo<'local' | 'reference' | undefined>(() => {
    const otherItems = items.filter((_, index) => index !== composerEditIndex)
    if (otherItems.length === 0) return undefined
    return otherItems.some(item => item.referenceProduct !== undefined) ? 'reference' : 'local'
  }, [composerEditIndex, items])
  const composerLocalCatalog = useMemo(() => {
    if (composerLockedSource === 'reference') return catalog
    return catalog.filter(candidate => (
      composerEditIndex === undefined
        ? !composerExcludedIds.has(candidate.id) && canCombineWithCurrentItems(candidate)
        : candidate.id === items[composerEditIndex]?.catalogItemId
          || (!composerExcludedIds.has(candidate.id) && canCombineWithCurrentItems(candidate, composerEditIndex))
    ))
  }, [catalog, composerEditIndex, composerExcludedIds, composerLockedSource, items])
  const composerTarget = useMemo<MedicationComposerTarget | undefined>(() => {
    const item = composerEditIndex === undefined ? undefined : items[composerEditIndex]
    if (item === undefined) return undefined
    if (item.referenceProduct !== undefined) {
      return {
        key: item.key,
        fields: { courseDays: item.courseDays, doseText: item.doseText, frequencyCode: item.frequencyCode, quantity: item.quantity },
        selection: { kind: 'reference', product: item.referenceProduct },
      }
    }
    const medication = catalogById.get(item.catalogItemId)
    if (medication === undefined) return undefined
    return {
      key: item.key,
      fields: { courseDays: item.courseDays, doseText: item.doseText, frequencyCode: item.frequencyCode, quantity: item.quantity },
      selection: { kind: 'local', medication },
    }
  }, [catalogById, composerEditIndex, items])
  const draftEntrySection = (
    <section aria-label={locale === 'zh-CN' ? '填写处方' : 'Enter prescription'} className="flex min-w-0 flex-col gap-3">
      {hasActivePrescription ? <p className="text-xs text-muted-foreground">{locale === 'zh-CN'
        ? '本次就诊已有有效处方；如需调整，请先按处方状态撤回。未开具项目仍保留在下方。'
        : 'This encounter has an active prescription. Withdraw it according to its status before adjusting. Unissued items remain below.'}</p> : null}
      {canEditDraft ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button data-agent-catalog-trigger="medication" className="data-disabled:pointer-events-none data-disabled:opacity-50" disabled={pending || !canAddMedication} focusableWhenDisabled={actions.saveDraft.pending}
              onClick={() => { setComposerEditIndex(undefined); setComposerOpen(true) }} size="sm" type="button" variant="outline">
              <PlusIcon data-icon="inline-start" />{locale === 'zh-CN' ? '添加药品' : 'Add medication'}
            </Button>
            <p className="text-xs text-muted-foreground">{locale === 'zh-CN'
              ? `最多 8 条 · 当前 ${items.length} 条`
              : `Up to 8 · ${items.length} added`}</p>
            {items.length === 0 && composerDraft.value === null && !privateDraft.failed && !composerDraft.failed ? null : <Button disabled={operationPending || recoveryPending} onClick={() => setClearPrivateDraftOpen(true)} size="sm" type="button" variant="ghost">{locale === 'zh-CN' ? '清空手动草稿' : 'Discard manual draft'}</Button>}
          </div>
          {privateDraft.failed || composerDraft.failed ? <ErrorAlert title={messages.operationFailed} message={locale === 'zh-CN' ? '处方草稿无法读取或保存，已停止新开具。请确认清空草稿后再试。' : 'The prescription draft cannot be read or saved. Confirm discarding it before issuing.'} /> : null}
          {items.length > 0 && invalidDraft ? (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertTitle>{locale === 'zh-CN' ? '存在未完成的药品信息，点击对应条目补全后才能开具。' : 'Some medication orders are incomplete. Open them to finish before issuing.'}</AlertTitle>
            </Alert>
          ) : null}
          {draftTools}
          <DoctorDraftEditorScope id={composerEditIndex === undefined ? undefined : items[composerEditIndex]?.catalogItemId} open={composerOpen}>{commit => <MedicationComposerDialog
            atCapacity={!canAddMedication}
            draftItems={items}
            draftScope={draftScope}
            disabled={pending}
            excludedIds={composerExcludedIds}
            localCatalog={composerLocalCatalog}
            locale={locale}
            lockedSource={composerLockedSource}
            onConfirm={(selection, fields) => {
              const id = selection.kind === 'reference' ? selection.product.id : selection.medication.id
              const previous = composerEditIndex === undefined ? undefined : items[composerEditIndex]
              const accepted = composerEditIndex === undefined ? addMedication(selection, fields) : replaceMedication(composerEditIndex, selection, fields)
              if (!accepted) return false
              commit()
              if (previous?.catalogItemId !== id) dismissDraftItem(id)
              return true
            }}
            pendingItems={<section aria-label={locale === 'zh-CN' ? '处方待开清单' : 'Pending prescription'} className="flex flex-col gap-2 border-b p-4">
              <p className="text-sm font-medium">{locale === 'zh-CN' ? `待开具 ${items.length} 项` : `${items.length} pending`}</p>
              {items.length >= 8 ? <p className="text-xs text-muted-foreground">{locale === 'zh-CN' ? '已达 8 项上限，可编辑或移除已加药品。' : 'Eight-item limit reached. Edit or remove an added medicine.'}</p> : null}
              {items.length === 0 && composerDraft.value === null ? null : <Button disabled={operationPending || recoveryPending} onClick={() => setClearPrivateDraftOpen(true)} size="sm" type="button" variant="ghost">{locale === 'zh-CN' ? '清空手动草稿' : 'Discard manual draft'}</Button>}
              {items.map((item, index) => {
                const label = item.referenceProduct?.genericName ?? catalogById.get(item.catalogItemId)?.[locale === 'zh-CN' ? 'nameZh' : 'nameEn'] ?? item.catalogItemId
                return <div className="flex min-w-0 items-start justify-between gap-2 text-sm" key={item.key}>
                  <Button aria-label={`${locale === 'zh-CN' ? '编辑待开药品' : 'Edit pending medicine'} ${label}`} className="h-auto min-w-0 justify-start whitespace-normal text-left" disabled={pending} onClick={() => setComposerEditIndex(index)} type="button" variant="ghost">{label}</Button>
                  <Button aria-label={`${locale === 'zh-CN' ? '移除待开药品' : 'Remove pending medicine'} ${label}`} disabled={pending} onClick={() => { removeMedication(item.catalogItemId); setComposerEditIndex(undefined) }} type="button" variant="ghost">{locale === 'zh-CN' ? '移除' : 'Remove'}</Button>
                </div>
              })}
            </section>}
            onOpenChange={open => { if (!open) commit(); setComposerOpen(open) }}
            open={composerOpen}
            search={referenceSearch}
            target={composerTarget}
          />}</DoctorDraftEditorScope>
        </>
      ) : null}
    </section>
  )

  const issuedSummary = prescription === undefined ? null : (
    <div className="flex flex-col gap-3">
      {readOnly || prescription.status === 'withdrawn' ? null : <DoctorRecordReviewNotice caseId={detail.caseId}
        authoredAt={prescription.authoredAt} locale={locale} onReview={() => {
          setRecordSearch('')
          requestAnimationFrame(() => { recordSearchRef.current?.scrollIntoView({ block: 'nearest' }); recordSearchRef.current?.focus() })
        }} />}
      {/* 终态收敛为一行：状态徽章为主行，编号、时间与条目说明为辅，撤回动作就近；进度条继续承载发放链路。 */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2" data-prescription-status="">
        <Badge className="shrink-0 gap-1" variant={prescription.status === 'withdrawn' ? 'outline' : 'secondary'}>
          {prescription.status === 'withdrawn' ? <RotateCcwIcon aria-hidden="true" className="size-3" /> : <PillIcon aria-hidden="true" className="size-3" />}
          {prescriptionStatusLabel(prescription.status, messages)}
        </Badge>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {messages.prescriptionNumber} {prescription.number} · {formatClinicalDateTime(prescription.authoredAt, locale)}
          {prescription.status === 'withdrawn'
            ? prescription.withdrawal === undefined ? null : ` · ${formatClinicalDateTime(prescription.withdrawal.withdrawnAt, locale)}`
            : ` · ${locale === 'zh-CN' ? `${prescription.items.length} 条药品医嘱 · 已开具处方不可直接编辑` : `${prescription.items.length} medication orders · Issued prescriptions are read only`}`}
        </p>
        {allowWithdrawal
          && (prescription.status === 'signed' || prescription.status === 'paid') ? (
          <AlertDialog pending={actions.withdraw.pending}>
            <AlertDialogTrigger render={<Button size="sm" type="button" variant="outline" />}>
              <RotateCcwIcon data-icon="inline-start" />{messages.withdrawPrescription}
            </AlertDialogTrigger>
            <AlertDialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto">
              <AlertDialogHeader>
                <AlertDialogTitle>{messages.withdrawPrescriptionTitle}</AlertDialogTitle>
                <AlertDialogDescription>{messages.withdrawPrescriptionDescription}</AlertDialogDescription>
              </AlertDialogHeader>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">{messages.prescriptionNumber}</dt>
                  <dd className="mt-1 font-medium">{prescription.number}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{messages.prescriptionStatus}</dt>
                  <dd className="mt-1 font-medium">
                    {prescriptionStatusLabel(prescription.status, messages)}
                  </dd>
                </div>
              </dl>
              <AlertDialogFooter>
                <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
                <AlertDialogAction
                  disabled={actions.withdraw.pending}
                  onClick={actions.withdraw.onSubmit}
                >
                  <RotateCcwIcon data-icon="inline-start" />{messages.confirmWithdrawal}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>
      {prescription.status === 'withdrawn' ? (
        <p className="text-xs text-muted-foreground">
          {locale === 'zh-CN' ? '原处方明细保留，已支付记录不会自动退款。' : 'Original prescription details are retained. Payments are not automatically refunded.'}
        </p>
      ) : prescription.items.length > 0 && prescription.items.every(item => item.referenceProduct !== undefined) ? (
        <p className="text-xs text-muted-foreground">
          {locale === 'zh-CN' ? '电子外延处方已开具，不在本院收费或药房发药。' : 'External electronic prescription issued; not billed or dispensed at this hospital.'}
        </p>
      ) : (
        <ol aria-label={locale === 'zh-CN' ? '处方进度' : 'Prescription progress'} className="grid min-w-0 grid-cols-3 gap-3 text-xs">
          {(['signed', 'paid', 'dispensed'] as const).map((status, index) => {
            const completed = ['signed', 'paid', 'dispensed'].indexOf(prescription.status) >= index
            return (
              <li className={cn('flex min-w-0 flex-col gap-1 border-t-2 pt-2', completed ? 'border-primary' : 'text-muted-foreground')} key={status}>
                <span className="flex items-center gap-1">
                  {completed ? <CheckIcon aria-hidden="true" className="size-3 shrink-0" /> : null}
                  {status === 'signed'
                    ? (locale === 'zh-CN' ? '开具' : 'Issuance')
                    : status === 'paid'
                      ? (locale === 'zh-CN' ? '缴费' : 'Payment')
                      : (locale === 'zh-CN' ? '调剂' : 'Dispensing')}
                </span>
                {status === 'signed' ? <span>{formatClinicalDateTime(prescription.authoredAt, locale)}</span> : null}
                {completed ? null : <span>{locale === 'zh-CN' ? '待完成' : 'Pending'}</span>}
              </li>
            )
          })}
        </ol>
      )}
      {!allowWithdrawal || actions.withdraw.error === null ? null : (
        <ErrorAlert
          message={getWorkspaceErrorMessage(actions.withdraw.error, messages)}
          title={getWorkspaceErrorTitle(actions.withdraw.error, messages, messages.operationFailed)}
        />
      )}
    </div>
  )

  const issuedSet = new Set(prescription?.status === 'withdrawn' ? [] : prescription?.items.map(item => item.catalogItemId) ?? [])
  const unissuedManualItems = items.filter(item => !prescription?.items.some(record => record.catalogItemId === item.catalogItemId))

  return (
    <section
      aria-labelledby="medication-conclusion-heading"
      className="flex flex-col gap-4"
      id={elementId}
      tabIndex={-1}
    >
      <AlertDialog pending={actions.deleteDraft.pending} onOpenChange={setClearPrivateDraftOpen} open={clearPrivateDraftOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{locale === 'zh-CN' ? '确认清空手动处方草稿' : 'Discard the manual prescription draft?'}</AlertDialogTitle>
            <AlertDialogDescription>{locale === 'zh-CN' ? `将丢弃 ${items.length} 条手动待开药品及弹窗内尚未加入的用药输入。此操作不撤回正式处方。` : `Discard ${items.length} manual medicines and unfinished composer input. Issued prescriptions remain valid.`}</AlertDialogDescription>
          </AlertDialogHeader>
          {!clearPrivateDraftFailed && actions.deleteDraft.error === null ? null : <ErrorAlert title={messages.operationFailed}
            message={actions.deleteDraft.error === null ? (locale === 'zh-CN' ? '清空失败，请重试。尚未清除的输入已保留。' : 'Could not discard the draft. Remaining input is retained; retry.') : getWorkspaceErrorMessage(actions.deleteDraft.error, messages)} />}
          <AlertDialogFooter>
            <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
            <AlertDialogAction disabled={operationPending || recoveryPending} onClick={() => {
              if (operationPending || recoveryPending) return
              setClearPrivateDraftFailed(false)
              if (state?.draft !== undefined) {
                draftDeletionRef.current = { revision: currentRevision, clearComposer: true }
                actions.deleteDraft.onSubmit()
                return
              } else {
                if (!privateDraft.save(previous => ({ ...previous, items: [], dirty: false })) || !composerDraft.clear()) {
                  setClearPrivateDraftFailed(true); return
                }
              }
              if (!preferences.save(previous => ({ ...previous, edits: Object.fromEntries(Object.entries(previous.edits).filter(([, edit]) => !edit.formOwned)) }))) {
                setClearPrivateDraftFailed(true); return
              }
              setComposerEditIndex(undefined)
              setClearPrivateDraftOpen(false)
            }}>{locale === 'zh-CN' ? '确认清空' : 'Discard draft'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold" id="medication-conclusion-heading">
          {messages.medicationConclusion}
        </h3>
      </div>

      <DoctorOrderWorkspace
        hasRecords={prescription !== undefined}
        entry={readOnly || noMedicationConclusion !== undefined ? null : (
          <div className="flex min-w-0 flex-col gap-3">
            {conclusionModeControl}
            {mode === 'prescription' ? draftEntrySection : noMedicationPanel}
          </div>
        )}
        pending={
          <div className="min-w-0 @min-[800px]/order-workspace:sticky @min-[800px]/order-workspace:top-2">
            <DoctorRecommendationsPanel
              caseId={detail.caseId}
            enabled={!readOnly && noMedicationConclusion === undefined && mode === 'prescription'}
            disabled={!canEditDraft || pending}
            inputRevision={recommendationRevision}
            kind="prescription"
            locale={locale}
            issuedCatalogItemIds={issuedSet}
            expectedDraftVersion={state?.draftVersion ?? 0}
            encounter={detail.encounter}
            resolveExistingDraft={state?.draft !== undefined}
            onManualChange={changePreparedItem}
            onManualEdit={value => {
              if (value.kind !== 'prescription') return
              const index = items.findIndex(item => item.catalogItemId === value.catalogItemId)
              if (index < 0) return
              const item = items[index]!
              if (item.referenceProduct === undefined && !catalogById.has(item.catalogItemId)) return
              setComposerEditIndex(index)
              setComposerOpen(true)
            }}
            onManualRemove={removePreparedItem}
            onConfirmed={consumePreparedItems}
            manualItems={unissuedManualItems.map(item => ({
              label: item.referenceProduct?.genericName
                ?? (locale === 'zh-CN' ? catalogById.get(item.catalogItemId)?.nameZh : catalogById.get(item.catalogItemId)?.nameEn)
                ?? item.catalogItemId,
              value: { source: 'manual', kind: 'prescription', catalogItemId: item.catalogItemId,
                doseText: item.doseText || null, frequencyCode: item.frequencyCode || null, courseDays: item.courseDays, quantity: item.quantity,
                ...(item.referenceProduct === undefined ? {} : { referenceProduct: item.referenceProduct }) },
            } satisfies ManualPreparedItem))}
            manualUnavailableReason={manualPreparedUnavailableReason}
            unavailableReason={suggestion => pendingEditorChanges ? pendingEditorMessage : isRecommendationAvailable(suggestion)
              ? undefined
              : items.some(item => item.referenceProduct !== undefined)
                ? messages.prescriptionIssueReason_mixedCatalogSources
                : messages.recommendationRequestTargetUnavailable}
            scope={recommendationScope}
          />
          </div>
        }
        records={prescription === undefined ? null : (
          <div className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-3">
            {issuedSummary}
            <section aria-label={locale === 'zh-CN' ? '药品列表' : 'Medication list'} className="flex min-w-0 flex-col gap-3">
              <Input
                aria-label={locale === 'zh-CN' ? '搜索处方药品' : 'Search prescription medications'}
                onChange={event => setRecordSearch(event.currentTarget.value)}
                placeholder={locale === 'zh-CN' ? '搜索药品名称、编码或厂家' : 'Search name, code, or manufacturer'}
                ref={recordSearchRef}
                value={recordSearch}
              />
              {visibleRecords.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>{locale === 'zh-CN' ? '没有匹配的记录' : 'No matching records'}</EmptyTitle>
                    <EmptyDescription>{locale === 'zh-CN' ? '搜索为空不会删除处方记录。' : 'Searching does not delete prescription records.'}</EmptyDescription>
                  </EmptyHeader>
                  <Button onClick={() => setRecordSearch('')} size="sm" type="button" variant="outline">
                    {locale === 'zh-CN' ? '查看全部记录' : 'Show all records'}
                  </Button>
                </Empty>
              ) : (
                <div className="min-w-0 overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{locale === 'zh-CN' ? '药品通用名' : 'Medication'}</TableHead>
                        <TableHead>{locale === 'zh-CN' ? '规格与包装' : 'Strength & package'}</TableHead>
                        <TableHead>{locale === 'zh-CN' ? '用法用量与疗程' : 'Directions & course'}</TableHead>
                        <TableHead className="w-20">{messages.quantity}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleRecords.map(item => (
                        <TableRow key={item.medicationRequestId}>
                          <TableCell className="whitespace-normal break-words font-medium">
                            <span className="break-words" data-agent-medication-name="">{item.display}</span>
                          </TableCell>
                          <TableCell className="whitespace-normal break-words text-xs text-muted-foreground">
                            {item.referenceProduct === undefined ? '—' : (
                              <span title={item.referenceProduct.packageDescription}>
                                {item.referenceProduct.strength} · {medicationPackageSummary(item.referenceProduct.packageDescription)}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="whitespace-normal break-words text-xs text-muted-foreground">
                            {item.doseText} · {item.frequencyCode} · {item.courseDays} {messages.days}
                          </TableCell>
                          <TableCell className="tabular-nums">{item.quantity}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>
          </div>
        )}
        details={null}
      />


      {noMedicationConclusion === undefined ? null : (
        <Alert>
          <CheckIcon aria-hidden="true" />
          <AlertTitle>{messages.noMedicationConfirmed}</AlertTitle>
          <AlertDescription>
            {messages.authoredAt} · {formatClinicalDateTime(noMedicationConclusion.authoredAt, locale)}
          </AlertDescription>
        </Alert>
      )}

      {/* 结论方式控制位于左主列顶部（见 conclusionModeControl）；页脚只保留需要整页可见的错误提示。 */}
      {actions.saveDraft.error === null ? null : (
        <ErrorAlert
          message={getWorkspaceErrorMessage(actions.saveDraft.error, messages)}
          title={getWorkspaceErrorTitle(actions.saveDraft.error, messages, messages.operationFailed)}
        />
      )}
      {actions.deleteDraft.error === null ? null : (
        <ErrorAlert
          message={getWorkspaceErrorMessage(actions.deleteDraft.error, messages)}
          title={getWorkspaceErrorTitle(actions.deleteDraft.error, messages, messages.operationFailed)}
        />
      )}

      {/* 开具拒绝独立于编辑权限渲染：并发无药结论或既有处方会让刷新后的 canEditDraft 翻 false，
          若留在编辑块内，竞态场景下医生只看到状态变化而丢失新承诺的可操作拦截文案。 */}
      {actions.issue.error === null ? null : (
        <ErrorAlert
          message={getPrescriptionIssueErrorMessage(actions.issue.error, messages)}
          title={getWorkspaceErrorTitle(actions.issue.error, messages, messages.operationFailed)}
        />
      )}
    </section>
  )
}

function prescriptionStatusLabel(
  status: 'dispensed' | 'paid' | 'signed' | 'withdrawn',
  messages: ReturnType<typeof getWorkspaceMessages>,
): string {
  if (status === 'signed') return messages.prescriptionStatus_signed
  if (status === 'paid') return messages.prescriptionStatus_paid
  if (status === 'dispensed') return messages.prescriptionStatus_dispensed
  return messages.prescriptionStatus_withdrawn
}
