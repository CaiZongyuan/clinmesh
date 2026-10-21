import type {
  ClinicalCatalog,
  DoctorCaseDetail,
  PrescriptionDraftItem,
} from '@clinmesh/contracts/his'
import { prescriptionDraftContentSchema } from '@clinmesh/contracts/his'
import type { ReferenceMedicationProduct } from '@clinmesh/contracts/reference-data'
import type { DoctorRecommendationSuggestion } from '@clinmesh/contracts/doctor-recommendations'
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
import { Field, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Separator } from '@clinmesh/ui/components/separator'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { cn } from '@clinmesh/ui/lib/utils'
import {
  ArrowLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  PillIcon,
  RotateCcwIcon,
  Trash2Icon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRegisterAgentForm } from '../agent-page-context.tsx'
import { ApiClientError } from '../api-client.ts'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from '../workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { WorkspaceSelect } from '../workspace-select.tsx'
import {
  MedicationCatalogDialog,
  MedicationCatalogPicker,
  medicationPackageSummary,
  type MedicationCatalogSelection,
  type ReferenceCatalogSearches,
} from './catalog-picker-dialogs.tsx'
import { formatClinicalDateTime } from './clinical-date-time.ts'
import { DoctorRecommendationsPanel, type ManualPreparedItem, type PreparationDraft } from './doctor-recommendations.tsx'
import { useDoctorPreparation } from './doctor-preparation-state.tsx'
import { useAutosave } from './use-autosave.ts'
import { DoctorOrderWorkspace } from './doctor-order-workspace.tsx'
import { DoctorRecordReviewNotice } from './doctor-record-review-notice.tsx'

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

interface PrescriptionDraftLine extends Omit<PrescriptionDraftItem, 'courseDays' | 'quantity'> {
  courseDays: number | null
  key: string
  quantity: number | null
}

type MedicationConclusionMode = 'no-medication' | 'prescription'
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

function MedicationProductDetails({ product, locale }: {
  product: ReferenceMedicationProduct
  locale: WorkspaceLocale
}): React.JSX.Element {
  const fields = [
    [locale === 'zh-CN' ? '规格' : 'Strength', product.strength],
    [locale === 'zh-CN' ? '剂型' : 'Dosage form', product.dosageForm],
    [locale === 'zh-CN' ? '包装' : 'Package', product.packageDescription],
    [locale === 'zh-CN' ? '生产企业' : 'Manufacturer', product.manufacturer],
    [locale === 'zh-CN' ? '批准文号' : 'Approval number', product.approvalNumber],
    [locale === 'zh-CN' ? '商品名' : 'Brand name', product.brandName ?? '—'],
  ]
  return (
    <dl className="grid min-w-0 grid-cols-2 gap-3 text-sm">
      {fields.map(([label, value]) => (
        <div className="min-w-0" key={label}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  )
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
  const preparationSubmitting = useDoctorPreparation()?.submitting('prescription') ?? false
  const pending = actions.saveDraft.pending || actions.issue.pending || actions.deleteDraft.pending || actions.confirmNoMedication.pending || preparationSubmitting
  const state = detail.medicationConclusion
  const prescription = state?.prescription
  const noMedicationConclusion = state?.noMedication
  const hasActivePrescription = prescription !== undefined && prescription.status !== 'withdrawn'
  const [mode, setMode] = useState<MedicationConclusionMode>(
    noMedicationConclusion === undefined ? 'prescription' : 'no-medication',
  )
  const canEditDraft = !readOnly && noMedicationConclusion === undefined
    && !hasActivePrescription && mode === 'prescription' && prescription === undefined
  const [dirty, setDirty] = useState(false)
  const [deleteDraftOpen, setDeleteDraftOpen] = useState(false)
  const [noMedicationOpen, setNoMedicationOpen] = useState(false)
  const [replacementOpen, setReplacementOpen] = useState(false)
  const [recordSearch, setRecordSearch] = useState('')
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>()
  const recordSearchRef = useRef<HTMLInputElement>(null)
  const recordHeadingRef = useRef<HTMLHeadingElement>(null)
  const recordTerms = recordSearch.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const visibleRecords = (prescription?.items ?? []).filter(item => {
    const text = [item.display, item.catalogItemId, item.referenceProduct?.manufacturer, item.referenceProduct?.packageDescription].join(' ').toLocaleLowerCase()
    return recordTerms.every(term => text.includes(term))
  })
  const recordSelectionId = selectedRecordId === undefined
    ? prescription?.items[0]?.medicationRequestId
    : selectedRecordId
  const selectedRecord = visibleRecords.find(item => item.medicationRequestId === recordSelectionId)
  const [items, setItems] = useState<PrescriptionDraftLine[]>(() => {
    if (state?.draft !== undefined) {
      return state.draft.items.map((item, index) => ({ ...item, key: `saved-${index}` }))
    }
    return []
  })
  const [selectedDraftKey, setSelectedDraftKey] = useState<string>()
  const selectedDraft = items.find(item => item.key === selectedDraftKey) ?? items[0]
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
  const finalRemovalRevisionRef = useRef<string | undefined>(undefined)
  const handledDeletionRef = useRef<{ caseId: string; draftVersion: number } | undefined>(undefined)
  useEffect(() => {
    if (deletedCaseId !== detail.caseId || deletedDraftVersion === undefined) return
    if (handledDeletionRef.current?.caseId === deletedCaseId && handledDeletionRef.current.draftVersion === deletedDraftVersion) return
    handledDeletionRef.current = { caseId: deletedCaseId, draftVersion: deletedDraftVersion }
    if ((dirty && finalRemovalRevisionRef.current !== currentRevision) || (state?.draftVersion ?? 0) > deletedDraftVersion) return
    finalRemovalRevisionRef.current = undefined
    setItems([])
    setDirty(false)
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
  const addMedication = (selection: MedicationCatalogSelection) => {
    if (!canEditDraft || pending) return
    const line = medicationLine(selection)
    if (items.length >= 8 || usedCatalogItemIds.has(line.catalogItemId)) return
    setItems(current => [...current, line])
    setSelectedDraftKey(line.key)
    setDirty(true)
  }
  const replaceMedication = (index: number, selection: MedicationCatalogSelection) => {
    if (!canEditDraft || pending) return
    setItems(current => current.map((item, itemIndex) => (
      itemIndex === index ? medicationLine(selection, item.key) : item
    )))
    setDirty(true)
  }
  const updateItem = (index: number, update: Partial<PrescriptionDraftLine>) => {
    if (!canEditDraft || pending) return
    setItems(current => current.map((item, itemIndex) => (
      itemIndex === index ? { ...item, ...update } : item
    )))
    setDirty(true)
  }
  const changePreparedItem = ({ value }: ManualPreparedItem) => {
    if (value.kind !== 'prescription' || !canEditDraft || pending) return false
    setItems(current => {
      const previous = current.find(item => item.catalogItemId === value.catalogItemId)
      const line: PrescriptionDraftLine = {
        catalogItemId: value.catalogItemId, key: previous?.key ?? globalThis.crypto.randomUUID(),
        courseDays: value.courseDays, doseText: value.doseText ?? '', frequencyCode: value.frequencyCode ?? '', quantity: value.quantity,
        ...(value.referenceProduct === undefined ? {} : { referenceProduct: value.referenceProduct }),
      }
      return previous === undefined ? [...current, line] : current.map(item => item.key === previous.key ? line : item)
    })
    setDirty(true)
    return true
  }
  const removeMedication = (catalogItemId: string) => {
    if (!canEditDraft || pending) return
    const remaining = items.filter(item => item.catalogItemId !== catalogItemId)
    if (remaining.length === 0 && state?.draft !== undefined) {
      finalRemovalRevisionRef.current = currentRevision
      actions.deleteDraft.onSubmit()
      return
    }
    setItems(remaining)
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
    setItems(remaining)
    setDirty(remaining.length > 0)
  }
  const canAddMedication = items.length < 8
  const invalidDraft = !draftValidation.success
  const saveCurrentDraft = () => {
    if (canEditDraft && draftValidation.success) actions.saveDraft.onSubmit(draftValidation.data.items)
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
        <Button disabled={invalidDraft || actions.saveDraft.pending || actions.deleteDraft.pending} onClick={saveCurrentDraft} size="sm" type="button" variant="outline">
          {locale === 'zh-CN' ? '重试保存' : 'Retry save'}
        </Button>
      )}
    </div>
  )

  // 结论方式开关移到左主列顶部（目录+表单同卡之上）；草稿工具跟随表单区；
  // 右辅助列只保留一块推荐/待开具面板。
  const deletionReceiptVisible = actions.deleteDraft.data !== undefined
    && actions.deleteDraft.data.caseId === detail.caseId
    && state?.draft === undefined
    && state?.draftVersion === actions.deleteDraft.data.draftVersion
  const conclusionModeControl = readOnly || noMedicationConclusion !== undefined || hasActivePrescription ? null : (
    <Field className="min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border p-2.5" orientation="horizontal">
      <FieldLabel className="shrink-0 text-xs text-muted-foreground" id="medication-conclusion-mode-label">{messages.medicationConclusionMode}</FieldLabel>
      <ToggleGroup
        disabled={pending}
        aria-labelledby="medication-conclusion-mode-label"
        onValueChange={value => {
          const selectedMode = value[0]
          if (selectedMode === 'prescription' || selectedMode === 'no-medication') {
            setMode(selectedMode)
          }
        }}
        size="sm"
        spacing={2}
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
          <AlertDialog onOpenChange={setDeleteDraftOpen} open={deleteDraftOpen}>
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
      <AlertDialog onOpenChange={setNoMedicationOpen} open={noMedicationOpen}>
        <AlertDialogTrigger render={<Button
          className="self-start"
          disabled={dirty || actions.confirmNoMedication.pending || actions.deleteDraft.pending || actions.issue.pending || actions.saveDraft.pending}
          type="button"
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
                <li className="flex flex-wrap justify-between gap-2" key={item.key}>
                  <span className="break-words">{item.referenceProduct?.genericName
                    ?? (locale === 'zh-CN' ? catalogById.get(item.catalogItemId)?.nameZh : catalogById.get(item.catalogItemId)?.nameEn)
                    ?? item.catalogItemId}</span>
                  <span className="text-muted-foreground">{messages.quantity} {item.quantity}</span>
                </li>
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

  const draftEditor = (
    <FieldSet disabled={!canEditDraft || pending}>
      {/* 目录+表单同卡：目录居左、表单居右（约 3:2），窄容器回落上下堆叠；草稿工具与自动保存状态收敛在表单侧。 */}
      <div className="@container/card grid min-w-0 overflow-hidden rounded-lg border @min-[640px]/card:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 border-b @min-[640px]/card:border-b-0 @min-[640px]/card:border-r">
          <MedicationCatalogPicker
            active={!replacementOpen && !readOnly}
            collapsible={prescription !== undefined}
            disabled={!canEditDraft || !canAddMedication || pending}
            excludedIds={usedCatalogItemIds}
            localCatalog={catalog.filter(candidate => (
              !usedCatalogItemIds.has(candidate.id) && canCombineWithCurrentItems(candidate)
            ))}
            locale={locale}
            onSelect={selection => { if (selection !== undefined) addMedication(selection) }}
            search={referenceSearch}
            selectedId={selectedDraft?.catalogItemId}
          />
        </div>
        <section aria-label={locale === 'zh-CN' ? prescription === undefined ? '药品详情' : '填写药品' : prescription === undefined ? 'Medication details' : 'Enter medication'} className="flex min-w-0 flex-col gap-4 p-4">
          {items.length === 0 ? (
            // 空态引导左对齐贴住目录入口，不再用居中 Empty 在详情框里悬空。
            <div className="flex flex-col gap-1 py-1" data-medication-details-hint="">
              <p className="text-sm font-medium">{locale === 'zh-CN' ? '选择药品，填写用法' : 'Select medication and enter directions'}</p>
              <p className="text-xs text-muted-foreground">{locale === 'zh-CN' ? '从药品目录选择具体产品与包装，加入同一张处方草稿。' : 'Choose a product and package from the catalog to add it to this prescription draft.'}</p>
            </div>
          ) : (
            <ToggleGroup
              aria-label={locale === 'zh-CN' ? '已选药品' : 'Selected medications'}
              className="flex w-full flex-wrap"
              onValueChange={value => { if (value[0] !== undefined) setSelectedDraftKey(value[0]) }}
              size="sm"
              spacing={1}
              value={selectedDraft === undefined ? [] : [selectedDraft.key]}
              variant="outline"
            >
              {items.map(item => (
                <ToggleGroupItem className="max-w-full whitespace-normal break-words" key={item.key} value={item.key}>
                  {item.referenceProduct?.genericName
                    ?? (locale === 'zh-CN' ? catalogById.get(item.catalogItemId)?.nameZh : catalogById.get(item.catalogItemId)?.nameEn)
                    ?? item.catalogItemId}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
          {items.map((item, index) => {
            if (item.key !== selectedDraft?.key) return null
            const invalidFields = new Set(draftValidation.success ? [] : draftValidation.error.issues.filter(issue => issue.path[1] === index).map(issue => issue.path[2]))
            const suffix = index === 0 ? '' : ` ${index + 1}`
            const selectedMedication = catalogById.get(item.catalogItemId)
            const doseItems = selectedMedication?.allowedDoseTexts.map(value => ({ label: value, value })) ?? []
            const frequencyItems = selectedMedication?.allowedFrequencyCodes.map(value => ({ label: value, value })) ?? []
            const courseItems = selectedMedication?.allowedCourseDays.map(value => ({
              label: `${value} ${messages.days}`,
              value: String(value),
            })) ?? []
            const quantityItems = selectedMedication?.allowedQuantities.map(value => ({
              label: String(value),
              value: String(value),
            })) ?? []
            const display = item.referenceProduct?.genericName
              ?? (locale === 'zh-CN' ? selectedMedication?.nameZh : selectedMedication?.nameEn)
              ?? item.catalogItemId
            const replacementExcludedIds = new Set(
              items.flatMap((candidate, candidateIndex) => (
                candidateIndex === index ? [] : [candidate.catalogItemId]
              )),
            )
            return (
              <FieldSet
                className="min-w-0 gap-4"
                key={item.key}
              >
                <FieldLegend className="sr-only" variant="label">{messages.medication} {index + 1}</FieldLegend>
                <div data-agent-medication-name="" className="min-w-0">
                  <span className="min-w-0">
                    <strong className="flex gap-1 break-words text-sm">
                      <span aria-hidden="true">{index + 1}.</span>
                      <span>{display}</span>
                    </strong>
                    {item.referenceProduct === undefined ? <span className="mt-1 block text-xs text-muted-foreground">{locale === 'zh-CN' ? '本院常用药' : 'Local common medication'}</span> : null}
                  </span>
                </div>
                {item.referenceProduct === undefined ? null : <MedicationProductDetails locale={locale} product={item.referenceProduct} />}
                <Separator />
                <FieldGroup className="grid min-w-0 grid-cols-2 gap-3">
                  <Field data-invalid={invalidFields.has('doseText')}>
                    <FieldLabel htmlFor={`prescription-dose-${index}`}>{messages.dose}{suffix}</FieldLabel>
                    {item.referenceProduct === undefined ? <WorkspaceSelect
                      id={`prescription-dose-${index}`}
                      items={doseItems}
                      onValueChange={value => {
                        if (value !== null) updateItem(index, { doseText: value })
                      }}
                      placeholder={messages.recommendationFieldPending}
                      value={item.doseText || null}
                    /> : <Input aria-invalid={invalidFields.has('doseText')} id={`prescription-dose-${index}`} maxLength={120} onChange={event => updateItem(index, { doseText: event.currentTarget.value })} value={item.doseText} />}
                  </Field>
                  <Field data-invalid={invalidFields.has('frequencyCode')}>
                    <FieldLabel htmlFor={`prescription-frequency-${index}`}>{messages.frequency}{suffix}</FieldLabel>
                    {item.referenceProduct === undefined ? <WorkspaceSelect
                      id={`prescription-frequency-${index}`}
                      items={frequencyItems}
                      onValueChange={value => {
                        if (value !== null) updateItem(index, { frequencyCode: value })
                      }}
                      placeholder={messages.recommendationFieldPending}
                      value={item.frequencyCode || null}
                    /> : <Input aria-invalid={invalidFields.has('frequencyCode')} id={`prescription-frequency-${index}`} maxLength={32} onChange={event => updateItem(index, { frequencyCode: event.currentTarget.value })} value={item.frequencyCode} />}
                  </Field>
                  <Field data-invalid={invalidFields.has('courseDays')}>
                    <FieldLabel htmlFor={`prescription-course-${index}`}>{messages.course}{suffix}</FieldLabel>
                    {item.referenceProduct === undefined ? <WorkspaceSelect
                      id={`prescription-course-${index}`}
                      items={courseItems}
                      onValueChange={value => {
                        if (value !== null) updateItem(index, { courseDays: Number(value) })
                      }}
                      placeholder={messages.recommendationFieldPending}
                      value={item.courseDays === null ? null : String(item.courseDays)}
                    /> : <Input aria-invalid={invalidFields.has('courseDays')} id={`prescription-course-${index}`} max={30} min={1} onChange={event => updateItem(index, { courseDays: event.currentTarget.value === '' ? null : Number(event.currentTarget.value) })} step={1} type="number" value={item.courseDays ?? ''} />}
                  </Field>
                  <Field data-invalid={invalidFields.has('quantity')}>
                    <FieldLabel htmlFor={`prescription-quantity-${index}`}>{messages.quantity}{suffix}</FieldLabel>
                    {item.referenceProduct === undefined ? <WorkspaceSelect
                      id={`prescription-quantity-${index}`}
                      items={quantityItems}
                      onValueChange={value => {
                        if (value !== null) updateItem(index, { quantity: Number(value) })
                      }}
                      placeholder={messages.recommendationFieldPending}
                      value={item.quantity === null ? null : String(item.quantity)}
                    /> : <Input aria-invalid={invalidFields.has('quantity')} id={`prescription-quantity-${index}`} max={1_000} min={1} onChange={event => updateItem(index, { quantity: event.currentTarget.value === '' ? null : Number(event.currentTarget.value) })} step={1} type="number" value={item.quantity ?? ''} />}
                  </Field>
                </FieldGroup>
                {invalidFields.size === 0 ? null : <FieldError>{locale === 'zh-CN' ? '请填写剂量与频次，疗程为 1–30 天，数量为 1–1000 的整数。' : 'Enter dose and frequency. Course must be 1–30 days and quantity an integer from 1–1000.'}</FieldError>}
                <div className="flex items-center justify-end gap-1 self-end">
                  <MedicationCatalogDialog
                    disabled={pending}
                    excludedIds={replacementExcludedIds}
                    localCatalog={catalog.filter(candidate => (
                      candidate.id === item.catalogItemId
                      || (!replacementExcludedIds.has(candidate.id)
                        && canCombineWithCurrentItems(candidate, index))
                    ))}
                    locale={locale}
                    mode="replace"
                  onOpenChange={setReplacementOpen}
                    onSelect={selection => replaceMedication(index, selection)}
                    search={referenceSearch}
                  />
                  <Button
                    disabled={pending}
                    aria-label={`${messages.removeMedication}${suffix}`}
                    onClick={() => removeMedication(item.catalogItemId)}
                    size="icon-sm"
                    title={`${messages.removeMedication}${suffix}`}
                    type="button"
                    variant="ghost"
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </FieldSet>
            )
          })}
          {draftTools}
        </section>
      </div>
    </FieldSet>
  )

  const issuedSummary = prescription === undefined ? null : (
    <div className="flex flex-col gap-3">
      {readOnly || prescription.status === 'withdrawn' ? null : <DoctorRecordReviewNotice caseId={detail.caseId}
        authoredAt={prescription.authoredAt} locale={locale} onReview={() => {
          setRecordSearch(''); setSelectedRecordId(prescription.items[0]?.medicationRequestId)
          requestAnimationFrame(() => { recordHeadingRef.current?.scrollIntoView({ block: 'nearest' }); recordHeadingRef.current?.focus() })
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
          <AlertDialog>
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

  return (
    <section
      aria-labelledby="medication-conclusion-heading"
      className="flex flex-col gap-4"
      id={elementId}
      tabIndex={-1}
    >
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
            {mode === 'prescription' ? <section aria-label={locale === 'zh-CN' ? '填写处方' : 'Enter prescription'} className="flex min-w-0 flex-col gap-3">
              {hasActivePrescription ? <p className="text-xs text-muted-foreground">{locale === 'zh-CN'
                ? '本次就诊已有有效处方；如需调整，请先按处方状态撤回。未开具项目仍保留在下方。'
                : 'This encounter has an active prescription. Withdraw it according to its status before adjusting. Unissued items remain below.'}</p> : null}
              {draftEditor}
            </section> : noMedicationPanel}
          </div>
        )}
        pending={
          <div className="min-w-0 @min-[800px]/order-workspace:sticky @min-[800px]/order-workspace:top-2">
            <DoctorRecommendationsPanel
              caseId={detail.caseId}
            enabled={!readOnly && noMedicationConclusion === undefined && mode === 'prescription'}
            disabled={!canEditDraft || actions.saveDraft.pending || actions.issue.pending || actions.deleteDraft.pending || actions.confirmNoMedication.pending}
            inputRevision={recommendationRevision}
            kind="prescription"
            locale={locale}
            issuedCatalogItemIds={new Set(prescription?.status === 'withdrawn' ? [] : prescription?.items.map(item => item.catalogItemId) ?? [])}
            expectedDraftVersion={state?.draftVersion ?? 0}
            encounter={detail.encounter}
            resolveExistingDraft={state?.draft !== undefined}
            onManualChange={changePreparedItem}
            onManualRemove={removePreparedItem}
            onConfirmed={consumePreparedItems}
            manualItems={items.filter(item => !prescription?.items.some(record => record.catalogItemId === item.catalogItemId)).map(item => ({
              label: item.referenceProduct?.genericName
                ?? (locale === 'zh-CN' ? catalogById.get(item.catalogItemId)?.nameZh : catalogById.get(item.catalogItemId)?.nameEn)
                ?? item.catalogItemId,
              value: { source: 'manual', kind: 'prescription', catalogItemId: item.catalogItemId,
                doseText: item.doseText || null, frequencyCode: item.frequencyCode || null, courseDays: item.courseDays, quantity: item.quantity,
                ...(item.referenceProduct === undefined ? {} : { referenceProduct: item.referenceProduct }) },
            } satisfies ManualPreparedItem))}
            unavailableReason={suggestion => isRecommendationAvailable(suggestion) ? undefined : messages.recommendationRequestTargetUnavailable}
            scope={recommendationScope}
          />
          </div>
        }
        records={prescription === undefined ? null : (
            <section aria-label={locale === 'zh-CN' ? '药品列表' : 'Medication list'} className={cn('min-w-0 flex-col gap-3 @min-[760px]/case-content:flex', selectedRecord === undefined ? 'flex' : 'hidden')}>
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
              ) : visibleRecords.map(item => (
                <Button
                  aria-label={`${locale === 'zh-CN' ? '查看药品' : 'View medication'} ${item.display}`}
                  aria-pressed={selectedRecord?.medicationRequestId === item.medicationRequestId}
                  className="h-auto w-full min-w-0 flex-col items-start gap-1.5 whitespace-normal p-2.5 text-left"
                  key={item.medicationRequestId}
                  onClick={() => {
                    setSelectedRecordId(item.medicationRequestId)
                    queueMicrotask(() => recordHeadingRef.current?.focus())
                  }}
                  type="button"
                  variant={selectedRecord?.medicationRequestId === item.medicationRequestId ? 'secondary' : 'outline'}
                >
                  <span className="break-words" data-agent-medication-name="">{item.display}</span>
                  {item.referenceProduct === undefined ? null : (
                    <span className="break-words text-xs text-muted-foreground" title={item.referenceProduct.packageDescription}>
                      {item.referenceProduct.strength} · {medicationPackageSummary(item.referenceProduct.packageDescription)}
                    </span>
                  )}
                  <span className="break-words text-xs text-muted-foreground">{item.doseText} · {item.frequencyCode} · {item.courseDays} {messages.days} · {messages.quantity} {item.quantity}</span>
                </Button>
              ))}
            </section>
        )}
        details={prescription === undefined ? null : (
          <div className="flex min-w-0 flex-col gap-4">
            {issuedSummary}
            <section aria-label={locale === 'zh-CN' ? '药品详情' : 'Medication details'} className={cn('min-w-0 flex-col gap-4 rounded-lg border p-4 @min-[760px]/case-content:flex', selectedRecord === undefined ? 'hidden' : 'flex')}>
              {selectedRecord === undefined ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>{locale === 'zh-CN' ? '选择一条药品记录查看详情' : 'Select a medication record'}</EmptyTitle>
                    <EmptyDescription>{locale === 'zh-CN' ? '从药品列表选择，或调整搜索。' : 'Choose from the medication list or adjust your search.'}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <>
                  <Button className="self-start @min-[760px]/case-content:hidden" onClick={() => {
                    setSelectedRecordId(null)
                    queueMicrotask(() => recordSearchRef.current?.focus())
                  }} size="sm" type="button" variant="ghost">
                    <ArrowLeftIcon data-icon="inline-start" />{locale === 'zh-CN' ? '返回药品列表' : 'Back to medication list'}
                  </Button>
                  <h4 className="break-words text-base font-semibold" data-agent-medication-name="" ref={recordHeadingRef} tabIndex={-1}>{selectedRecord.display}</h4>
                  {selectedRecord.referenceProduct === undefined ? null : <MedicationProductDetails locale={locale} product={selectedRecord.referenceProduct} />}
                  <Separator />
                  <dl className="grid min-w-0 grid-cols-2 gap-4 text-sm">
                    {[
                      [messages.dose, selectedRecord.doseText],
                      [messages.frequency, selectedRecord.frequencyCode],
                      [messages.course, `${selectedRecord.courseDays} ${messages.days}`],
                      [messages.quantity, String(selectedRecord.quantity)],
                    ].map(([label, value]) => (
                      <div className="min-w-0" key={label}>
                        <dt className="text-xs text-muted-foreground">{label}</dt>
                        <dd className="mt-1 break-words font-medium">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="text-xs text-muted-foreground">{locale === 'zh-CN' ? '用药明细属于同一张处方，开具与撤回作用于整张处方。' : 'Medication orders belong to one prescription. Issuance and withdrawal apply to the entire prescription.'}</p>
                </>
              )}
            </section>
          </div>
        )}
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

/** 开具拦截按成因给可操作文案：告诉医生哪一步未满足、去哪里处理，而不是笼统拒绝。 */
export function getPrescriptionIssueErrorMessage(
  error: Error,
  messages: ReturnType<typeof getWorkspaceMessages>,
): string {
  if (error instanceof ApiClientError && error.reason !== undefined) {
    const byReason = prescriptionIssueReasonMessage(error.reason, messages)
    if (byReason !== null) return byReason
  }
  if (
    error instanceof ApiClientError
    && (error.code === 'CATALOG_CONFLICT' || error.code === 'WORKFLOW_CONFLICT')
  ) {
    return messages.prescriptionIssueConflictDescription
  }
  return getWorkspaceErrorMessage(error, messages)
}

function prescriptionIssueReasonMessage(
  reason: string,
  messages: ReturnType<typeof getWorkspaceMessages>,
): string | null {
  const mapping: Record<string, keyof ReturnType<typeof getWorkspaceMessages>> = {
    PRESCRIPTION_ENCOUNTER_NOT_ACTIVE: 'prescriptionIssueReason_encounterNotActive',
    PRESCRIPTION_NO_MEDICATION_RECORDED: 'prescriptionIssueReason_noMedicationRecorded',
    PRESCRIPTION_DRAFT_STALE: 'prescriptionIssueReason_draftStale',
    PRESCRIPTION_ALREADY_ISSUED: 'prescriptionIssueReason_alreadyIssued',
    PRESCRIPTION_ALLERGY_CONFLICT: 'prescriptionIssueReason_allergyConflict',
    PRESCRIPTION_DIAGNOSIS_UNCONFIRMED: 'prescriptionIssueReason_diagnosisUnconfirmed',
    PRESCRIPTION_DIAGNOSIS_NOT_ALLOWED: 'prescriptionIssueReason_diagnosisNotAllowed',
    PRESCRIPTION_DOSAGE_NOT_ALLOWED: 'prescriptionIssueReason_dosageNotAllowed',
  }
  const key = mapping[reason]
  if (key === undefined) return null
  const text = messages[key]
  return typeof text === 'string' ? text : null
}
