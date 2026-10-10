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
  type MedicationCatalogSelection,
  type ReferenceCatalogSearches,
} from './catalog-picker-dialogs.tsx'
import { formatClinicalDateTime } from './clinical-date-time.ts'
import { useAutosave } from './use-autosave.ts'

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

interface PrescriptionDraftLine extends PrescriptionDraftItem {
  key: string
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
  referenceSearch: ReferenceCatalogSearches['medications']
}): React.JSX.Element {
  const state = detail.medicationConclusion
  const prescription = state?.prescription
  const noMedicationConclusion = state?.noMedication
  const hasActivePrescription = prescription !== undefined && prescription.status !== 'withdrawn'
  const [mode, setMode] = useState<MedicationConclusionMode>(
    noMedicationConclusion === undefined ? 'prescription' : 'no-medication',
  )
  const [dirty, setDirty] = useState(false)
  const [deleteDraftOpen, setDeleteDraftOpen] = useState(false)
  const [issueOpen, setIssueOpen] = useState(false)
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
  useRegisterAgentForm({
    viewId: 'consultation', selectionId: detail.caseId, name: 'prescription',
    values: { mode, items: items.map(({ catalogItemId, courseDays, doseText, frequencyCode, quantity }) => ({ catalogItemId, courseDays, doseText, frequencyCode, quantity })) },
  })
  const currentRevision = JSON.stringify(submittedItems)
  useEffect(() => {
    if (actions.saveDraft.success && actions.saveDraft.savedRevision === currentRevision) {
      setDirty(false)
    }
  }, [actions.saveDraft.savedRevision, actions.saveDraft.success, currentRevision])
  const deletedCaseId = actions.deleteDraft.data?.caseId
  const deletedDraftVersion = actions.deleteDraft.data?.draftVersion
  useEffect(() => {
    if (deletedCaseId !== detail.caseId || deletedDraftVersion === undefined || (state?.draftVersion ?? 0) > deletedDraftVersion) return
    setItems([])
    setDirty(false)
  }, [deletedCaseId, deletedDraftVersion, detail.caseId, state?.draftVersion])
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
  const medicationLine = (
    selection: MedicationCatalogSelection,
    key: string = globalThis.crypto.randomUUID(),
  ) => selection.kind === 'reference'
    ? createReferencePrescriptionDraftLine(selection.product, key)
    : createPrescriptionDraftLine(selection.medication, key)
  const addMedication = (selection: MedicationCatalogSelection) => {
    const line = medicationLine(selection)
    if (items.length >= 8 || usedCatalogItemIds.has(line.catalogItemId)) return
    setItems(current => [...current, line])
    setSelectedDraftKey(line.key)
    setDirty(true)
  }
  const replaceMedication = (index: number, selection: MedicationCatalogSelection) => {
    setItems(current => current.map((item, itemIndex) => (
      itemIndex === index ? medicationLine(selection, item.key) : item
    )))
    setDirty(true)
  }
  const updateItem = (index: number, update: Partial<PrescriptionDraftLine>) => {
    setItems(current => current.map((item, itemIndex) => (
      itemIndex === index ? { ...item, ...update } : item
    )))
    setDirty(true)
  }
  const canAddMedication = items.length < 8
  const draftValidation = prescriptionDraftContentSchema.safeParse({ items: submittedItems })
  const invalidDraft = !draftValidation.success
  useAutosave({
    delayMs: 800,
    enabled: dirty && !invalidDraft && !actions.saveDraft.pending,
    onSave: () => actions.saveDraft.onSubmit(submittedItems),
    revision: `${state?.draftVersion ?? 0}:${currentRevision}`,
  })
  const draftSaveFeedback = (
    <div className="mr-auto flex flex-wrap items-center gap-2">
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
        <Button disabled={invalidDraft || actions.saveDraft.pending} onClick={() => actions.saveDraft.onSubmit(submittedItems)} size="sm" type="button" variant="outline">
          {locale === 'zh-CN' ? '重试保存' : 'Retry save'}
        </Button>
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

      {prescription === undefined ? null : (
        <div className="flex flex-col gap-3">
          <Alert>
            {prescription.status === 'withdrawn'
              ? <RotateCcwIcon aria-hidden="true" />
              : <PillIcon aria-hidden="true" />}
            <AlertTitle>
              {prescription.status === 'signed'
                ? messages.prescriptionIssued
                : prescription.status === 'withdrawn'
                  ? messages.prescriptionWithdrawn
                  : prescriptionStatusLabel(prescription.status, messages)}
            </AlertTitle>
            <AlertDescription>
              {messages.prescriptionNumber} {prescription.number} · {formatClinicalDateTime(prescription.authoredAt, locale)}
            </AlertDescription>
          </Alert>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">{messages.prescriptionStatus}</span>
              <Badge variant="secondary">{prescriptionStatusLabel(prescription.status, messages)}</Badge>
            </div>
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
              {prescription.withdrawal === undefined ? null : ` · ${formatClinicalDateTime(prescription.withdrawal.withdrawnAt, locale)}`}
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
          <p className="text-xs text-muted-foreground">
            {locale === 'zh-CN' ? `${prescription.items.length} 条药品医嘱 · 已开具处方不可直接编辑` : `${prescription.items.length} medication orders · Issued prescriptions are read only`}
          </p>
          <div className="grid min-w-0 gap-4 @min-[640px]/case-content:grid-cols-[minmax(0,0.8fr)_minmax(0,1.5fr)]">
            <section aria-label={locale === 'zh-CN' ? '药品列表' : 'Medication list'} className={cn('min-w-0 flex-col gap-3 @min-[640px]/case-content:flex', selectedRecord === undefined ? 'flex' : 'hidden')}>
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
                  className="h-auto w-full min-w-0 flex-col items-start gap-2 whitespace-normal p-3 text-left"
                  key={item.medicationRequestId}
                  onClick={() => {
                    setSelectedRecordId(item.medicationRequestId)
                    queueMicrotask(() => recordHeadingRef.current?.focus())
                  }}
                  type="button"
                  variant={selectedRecord?.medicationRequestId === item.medicationRequestId ? 'secondary' : 'outline'}
                >
                  <span className="break-words" data-agent-medication-name="">{item.display}</span>
                  {item.referenceProduct === undefined ? null : <span className="break-words text-xs text-muted-foreground">{item.referenceProduct.strength} · {item.referenceProduct.packageDescription}</span>}
                  <span className="break-words text-xs text-muted-foreground">{item.doseText} · {item.frequencyCode} · {item.courseDays} {messages.days} · {messages.quantity} {item.quantity}</span>
                </Button>
              ))}
            </section>
            <section aria-label={locale === 'zh-CN' ? '药品详情' : 'Medication details'} className={cn('min-w-0 flex-col gap-4 rounded-lg border p-4 @min-[640px]/case-content:flex', selectedRecord === undefined ? 'hidden' : 'flex')}>
              {selectedRecord === undefined ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>{locale === 'zh-CN' ? '选择一条药品记录查看详情' : 'Select a medication record'}</EmptyTitle>
                    <EmptyDescription>{locale === 'zh-CN' ? '从药品列表选择，或调整搜索。' : 'Choose from the medication list or adjust your search.'}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <>
                  <Button className="self-start @min-[640px]/case-content:hidden" onClick={() => {
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
          {!allowWithdrawal || actions.withdraw.error === null ? null : (
            <ErrorAlert
              message={getWorkspaceErrorMessage(actions.withdraw.error, messages)}
              title={getWorkspaceErrorTitle(actions.withdraw.error, messages, messages.operationFailed)}
            />
          )}
        </div>
      )}

      {noMedicationConclusion === undefined ? null : (
        <Alert>
          <CheckIcon aria-hidden="true" />
          <AlertTitle>{messages.noMedicationConfirmed}</AlertTitle>
          <AlertDescription>
            {messages.authoredAt} · {formatClinicalDateTime(noMedicationConclusion.authoredAt, locale)}
          </AlertDescription>
        </Alert>
      )}

      {readOnly || noMedicationConclusion !== undefined || hasActivePrescription ? null : (
        <Field>
          <FieldLabel id="medication-conclusion-mode-label">{messages.medicationConclusionMode}</FieldLabel>
          <ToggleGroup
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
      )}

      {!readOnly
        && noMedicationConclusion === undefined
        && !hasActivePrescription
        && mode === 'prescription'
        && prescription === undefined ? (
          <div>
            <FieldGroup>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold">{messages.prescription}</h4>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {locale === 'zh-CN' ? `${items.length} 条药品医嘱` : `${items.length} medication orders`}
                  </p>
                </div>
              </div>
              <div className="grid min-w-0 gap-4 @min-[640px]/case-content:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                <div className="min-w-0">
                  <MedicationCatalogPicker
                    active={!replacementOpen}
                    disabled={!canAddMedication}
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
                <section aria-label={locale === 'zh-CN' ? '药品详情' : 'Medication details'} className="flex min-w-0 flex-col gap-4 rounded-lg border p-4">
                  {items.length === 0 ? (
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>{locale === 'zh-CN' ? '选择药品，填写用法' : 'Select medication and enter directions'}</EmptyTitle>
                        <EmptyDescription>{locale === 'zh-CN' ? '从药品目录选择具体产品与包装，加入同一张处方草稿。' : 'Choose a product and package from the catalog to add it to this prescription draft.'}</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
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
                              value={item.doseText}
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
                              value={item.frequencyCode}
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
                              value={String(item.courseDays)}
                            /> : <Input aria-invalid={invalidFields.has('courseDays')} id={`prescription-course-${index}`} max={30} min={1} onChange={event => updateItem(index, { courseDays: Number(event.currentTarget.value) })} step={1} type="number" value={item.courseDays} />}
                          </Field>
                          <Field data-invalid={invalidFields.has('quantity')}>
                            <FieldLabel htmlFor={`prescription-quantity-${index}`}>{messages.quantity}{suffix}</FieldLabel>
                            {item.referenceProduct === undefined ? <WorkspaceSelect
                              id={`prescription-quantity-${index}`}
                              items={quantityItems}
                              onValueChange={value => {
                                if (value !== null) updateItem(index, { quantity: Number(value) })
                              }}
                              value={String(item.quantity)}
                            /> : <Input aria-invalid={invalidFields.has('quantity')} id={`prescription-quantity-${index}`} max={1_000} min={1} onChange={event => updateItem(index, { quantity: Number(event.currentTarget.value) })} step={1} type="number" value={item.quantity} />}
                          </Field>
                        </FieldGroup>
                        {invalidFields.size === 0 ? null : <FieldError>{locale === 'zh-CN' ? '请填写剂量与频次，疗程为 1–30 天，数量为 1–1000 的整数。' : 'Enter dose and frequency. Course must be 1–30 days and quantity an integer from 1–1000.'}</FieldError>}
                        <div className="flex items-center justify-end gap-1 self-end">
                          <MedicationCatalogDialog
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
                            aria-label={`${messages.removeMedication}${suffix}`}
                            onClick={() => {
                              setItems(current => current.filter((_, itemIndex) => itemIndex !== index))
                              setDirty(true)
                            }}
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
                </section>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {draftSaveFeedback}
                {state?.draft === undefined ? null : (
                  <>
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
                    <AlertDialog onOpenChange={setIssueOpen} open={issueOpen}>
                      <AlertDialogTrigger
                        render={(
                          <Button
                            disabled={invalidDraft || dirty || actions.issue.pending || actions.saveDraft.pending}
                            type="button"
                          />
                        )}
                      >
                        <PillIcon data-icon="inline-start" />{messages.issuePrescription}
                      </AlertDialogTrigger>
                      <AlertDialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            {locale === 'zh-CN' ? '确认正式开具处方' : 'Confirm prescription issuance'}
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            {locale === 'zh-CN'
                              ? '正式开具后将创建药品请求，普通草稿不能继续覆盖。'
                              : 'Issuance creates formal medication requests that an ordinary draft cannot overwrite.'}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <ul className="divide-y border text-sm">
                          {state.draft.items.map((draftItem) => {
                            const medication = catalogById.get(draftItem.catalogItemId)
                            return (
                              <li className="flex flex-wrap items-center justify-between gap-3 px-3 py-2" key={draftItem.catalogItemId}>
                                <span className="min-w-0 break-words font-medium">
                                  {(locale === 'zh-CN' ? medication?.nameZh : medication?.nameEn)
                                    ?? draftItem.referenceProduct?.genericName
                                    ?? draftItem.catalogItemId}
                                </span>
                                <span className="text-muted-foreground">
                                  {draftItem.doseText} · {draftItem.frequencyCode} · {draftItem.courseDays} {messages.days} · {messages.quantity} {draftItem.quantity}
                                </span>
                              </li>
                            )
                          })}
                        </ul>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
                          <AlertDialogCancel
                            disabled={invalidDraft || dirty || actions.issue.pending || actions.saveDraft.pending}
                            onClick={() => {
                              setIssueOpen(false)
                              queueMicrotask(actions.issue.onSubmit)
                            }}
                            variant="default"
                          >
                            <PillIcon data-icon="inline-start" />
                            {locale === 'zh-CN' ? '确认开具' : 'Issue prescription'}
                          </AlertDialogCancel>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </>
                )}
              </div>
              {actions.deleteDraft.data !== undefined
                && actions.deleteDraft.data.caseId === detail.caseId
                && state?.draft === undefined
                && state?.draftVersion === actions.deleteDraft.data.draftVersion ? (
                <Alert>
                  <CheckIcon aria-hidden="true" />
                  <AlertTitle>{messages.prescriptionDraftDeleted}</AlertTitle>
                </Alert>
              ) : null}
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
              {actions.issue.error === null ? null : (
                <ErrorAlert
                  message={getPrescriptionIssueErrorMessage(actions.issue.error, messages)}
                  title={getWorkspaceErrorTitle(actions.issue.error, messages, messages.operationFailed)}
                />
              )}
            </FieldGroup>
          </div>
        ) : null}

      {!readOnly
        && noMedicationConclusion === undefined
        && !hasActivePrescription
        && mode === 'no-medication' ? (
          <div className="flex flex-col items-end gap-3">
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
          </div>
        ) : null}
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

function getPrescriptionIssueErrorMessage(
  error: Error,
  messages: ReturnType<typeof getWorkspaceMessages>,
): string {
  if (
    error instanceof ApiClientError
    && (error.code === 'CATALOG_CONFLICT' || error.code === 'WORKFLOW_CONFLICT')
  ) {
    return messages.prescriptionIssueConflictDescription
  }
  return getWorkspaceErrorMessage(error, messages)
}
