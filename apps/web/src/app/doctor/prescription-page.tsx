import type {
  ClinicalCatalog,
  DoctorCaseDetail,
  PrescriptionDraftItem,
} from '@clinmesh/contracts/his'
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
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { useMutation } from '@tanstack/react-query'
import {
  CheckIcon,
  CircleAlertIcon,
  CircleXIcon,
  ClipboardPenIcon,
  PillIcon,
  RotateCcwIcon,
  Trash2Icon,
} from 'lucide-react'
import { useState } from 'react'
import {
  ApiClientError,
  confirmNoMedication,
  deletePrescriptionDraft,
  issuePrescription,
  newIdempotencyKey,
  savePrescriptionDraft,
  withdrawPrescription,
} from '../api-client.ts'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from '../workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'
import { WorkspaceSelect } from '../workspace-select.tsx'
import {
  MedicationCatalogDialog,
  type MedicationCatalogSelection,
} from './catalog-picker-dialogs.tsx'
import { formatClinicalDateTime } from './clinical-date-time.ts'

function ErrorAlert({ message, title }: { message: string; title: string }): React.JSX.Element {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
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

export function PrescriptionPage({
  allowWithdrawal,
  catalog,
  detail,
  elementId,
  locale,
  messages,
  onRefresh,
  readOnly,
}: {
  allowWithdrawal: boolean
  catalog: PrescriptionClinicalCatalog['medications']
  detail: DoctorCaseDetail
  elementId: string
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  onRefresh: () => Promise<void>
  readOnly: boolean
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
  const [items, setItems] = useState<PrescriptionDraftLine[]>(() => {
    if (state?.draft !== undefined) {
      return state.draft.items.map((item, index) => ({ ...item, key: `saved-${index}` }))
    }
    return []
  })
  const saveDraft = useMutation({
    mutationFn: () => savePrescriptionDraft({
      encounterId: detail.encounter.id,
      encounterVersion: detail.encounter.versionId,
      expectedDraftVersion: state?.draftVersion ?? 0,
      items: items.map(({ key: _key, ...item }) => item),
    }, newIdempotencyKey()),
    onError: onRefresh,
    onSuccess: async () => {
      setDirty(false)
      await onRefresh()
    },
  })
  const removeDraft = useMutation({
    mutationFn: (caseId: string) => {
      if (detail.caseId !== caseId || state?.draft === undefined) {
        throw new Error(messages.consultationUnavailable)
      }
      return deletePrescriptionDraft({
        encounterId: detail.encounter.id,
        encounterVersion: detail.encounter.versionId,
        expectedDraftVersion: state.draftVersion,
      }, newIdempotencyKey())
    },
    onError: onRefresh,
    onSuccess: async () => {
      setDirty(false)
      await onRefresh()
    },
  })
  const issue = useMutation({
    mutationFn: () => {
      if (state?.draft === undefined) throw new Error(messages.consultationUnavailable)
      return issuePrescription({
        encounterId: detail.encounter.id,
        encounterVersion: detail.encounter.versionId,
        expectedDraftVersion: state.draftVersion,
      }, newIdempotencyKey())
    },
    onError: onRefresh,
    onSuccess: onRefresh,
  })
  const confirmNone = useMutation({
    mutationFn: () => confirmNoMedication({
      encounterId: detail.encounter.id,
      encounterVersion: detail.encounter.versionId,
      expectedDraftVersion: state?.draftVersion ?? 0,
    }, newIdempotencyKey()),
    onError: onRefresh,
    onSuccess: onRefresh,
  })
  const withdraw = useMutation({
    mutationFn: ({ caseId, prescriptionId }: { caseId: string; prescriptionId: string }) => {
      if (
        detail.caseId !== caseId
        || prescription === undefined
        || prescription.id !== prescriptionId
      ) {
        throw new Error(messages.consultationUnavailable)
      }
      return withdrawPrescription({
        expectedPrescriptionVersion: prescription.version,
        medicationRequests: prescription.items.map(item => ({
          id: item.medicationRequestId,
          version: item.medicationRequestVersion,
        })),
        prescriptionId: prescription.id,
      }, newIdempotencyKey())
    },
    onError: onRefresh,
    onSuccess: onRefresh,
  })
  const usedCatalogItemIds = new Set(items.map(item => item.catalogItemId))
  const canCombineWithCurrentItems = (
    candidate: PrescriptionMedicationCatalogItem,
    ignoredIndex?: number,
  ) => items.every((item, index) => {
    if (index === ignoredIndex || item.catalogItemId === candidate.id) return true
    const selected = catalog.find(medication => medication.id === item.catalogItemId)
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
    setItems(current => [...current, medicationLine(selection)])
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
  const invalidDraft = items.length === 0 || items.some(item => (
    item.doseText.trim().length === 0
    || item.frequencyCode.trim().length === 0
    || !Number.isInteger(item.courseDays)
    || item.courseDays < 1
    || !Number.isInteger(item.quantity)
    || item.quantity < 1
  ))

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
                <AlertDialogContent>
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
                      disabled={withdraw.isPending}
                      onClick={() => withdraw.mutate({
                        caseId: detail.caseId,
                        prescriptionId: prescription.id,
                      })}
                    >
                      <RotateCcwIcon data-icon="inline-start" />{messages.confirmWithdrawal}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{messages.medication}</TableHead>
                <TableHead>{messages.dose}</TableHead>
                <TableHead>{messages.frequency}</TableHead>
                <TableHead>{messages.course}</TableHead>
                <TableHead>{messages.quantity}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {prescription.items.map(item => (
                <TableRow key={item.medicationRequestId}>
                  <TableCell className="font-medium">{item.display}</TableCell>
                  <TableCell>{item.doseText}</TableCell>
                  <TableCell>{item.frequencyCode}</TableCell>
                  <TableCell>{item.courseDays} {messages.days}</TableCell>
                  <TableCell>{item.quantity}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!allowWithdrawal
            || withdraw.error === null
            || withdraw.variables?.caseId !== detail.caseId
            || withdraw.variables.prescriptionId !== prescription.id ? null : (
            <ErrorAlert
              message={getWorkspaceErrorMessage(withdraw.error, messages)}
              title={getWorkspaceErrorTitle(withdraw.error, messages, messages.operationFailed)}
            />
          )}
        </div>
      )}

      {noMedicationConclusion === undefined ? null : (
        <Alert>
          <CircleXIcon aria-hidden="true" />
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
          <form
            onSubmit={event => {
              event.preventDefault()
              saveDraft.mutate()
            }}
          >
            <FieldGroup>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold">{messages.prescription}</h4>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {locale === 'zh-CN' ? `${items.length} 条药品医嘱` : `${items.length} medication orders`}
                  </p>
                </div>
                <MedicationCatalogDialog
                  disabled={!canAddMedication}
                  excludedIds={usedCatalogItemIds}
                  localCatalog={catalog.filter(candidate => (
                    !usedCatalogItemIds.has(candidate.id) && canCombineWithCurrentItems(candidate)
                  ))}
                  locale={locale}
                  onSelect={addMedication}
                />
              </div>
              {items.length === 0 ? (
                <div className="border px-4 py-10 text-center text-sm text-muted-foreground">
                  {locale === 'zh-CN' ? '尚未添加处方药品' : 'No medication added'}
                </div>
              ) : null}
              {items.length === 0 ? null : <div className="@container/prescription border">{items.map((item, index) => {
                const suffix = index === 0 ? '' : ` ${index + 1}`
                const selectedMedication = catalog.find(medication => medication.id === item.catalogItemId)
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
                const detailText = item.referenceProduct === undefined
                  ? (locale === 'zh-CN' ? '本院常用药' : 'Local common medication')
                  : [
                      item.referenceProduct.strength,
                      item.referenceProduct.dosageForm,
                      item.referenceProduct.manufacturer,
                      item.referenceProduct.approvalNumber,
                    ].join(' · ')
                const replacementExcludedIds = new Set(
                  items.flatMap((candidate, candidateIndex) => (
                    candidateIndex === index ? [] : [candidate.catalogItemId]
                  )),
                )
                return (
                  <FieldSet
                    className="grid gap-3 border-0 border-b p-3 last:border-b-0 @2xl/prescription:grid-cols-[minmax(12rem,1.5fr)_minmax(6rem,0.7fr)_minmax(6rem,0.7fr)_minmax(4.5rem,0.5fr)_minmax(4.5rem,0.5fr)_4rem] @2xl/prescription:items-end"
                    key={item.key}
                  >
                    <FieldLegend className="sr-only" variant="label">{messages.medication} {index + 1}</FieldLegend>
                    <div className="min-w-0 self-center">
                      <span className="min-w-0">
                        <strong className="flex gap-1 break-words text-sm">
                          <span aria-hidden="true">{index + 1}.</span>
                          <span>{display}</span>
                        </strong>
                        <span className="mt-1 block break-words text-xs text-muted-foreground">{detailText}</span>
                      </span>
                    </div>
                    <Field>
                      <FieldLabel htmlFor={`prescription-dose-${index}`}>{messages.dose}{suffix}</FieldLabel>
                      {item.referenceProduct === undefined ? <WorkspaceSelect
                        id={`prescription-dose-${index}`}
                        items={doseItems}
                        onValueChange={value => {
                          if (value !== null) updateItem(index, { doseText: value })
                        }}
                        value={item.doseText}
                      /> : <Input id={`prescription-dose-${index}`} maxLength={120} onChange={event => updateItem(index, { doseText: event.currentTarget.value })} value={item.doseText} />}
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`prescription-frequency-${index}`}>{messages.frequency}{suffix}</FieldLabel>
                      {item.referenceProduct === undefined ? <WorkspaceSelect
                        id={`prescription-frequency-${index}`}
                        items={frequencyItems}
                        onValueChange={value => {
                          if (value !== null) updateItem(index, { frequencyCode: value })
                        }}
                        value={item.frequencyCode}
                      /> : <Input id={`prescription-frequency-${index}`} maxLength={32} onChange={event => updateItem(index, { frequencyCode: event.currentTarget.value })} value={item.frequencyCode} />}
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`prescription-course-${index}`}>{messages.course}{suffix}</FieldLabel>
                      {item.referenceProduct === undefined ? <WorkspaceSelect
                        id={`prescription-course-${index}`}
                        items={courseItems}
                        onValueChange={value => {
                          if (value !== null) updateItem(index, { courseDays: Number(value) })
                        }}
                        value={String(item.courseDays)}
                      /> : <Input id={`prescription-course-${index}`} max={30} min={1} onChange={event => updateItem(index, { courseDays: Number(event.currentTarget.value) })} type="number" value={item.courseDays} />}
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`prescription-quantity-${index}`}>{messages.quantity}{suffix}</FieldLabel>
                      {item.referenceProduct === undefined ? <WorkspaceSelect
                        id={`prescription-quantity-${index}`}
                        items={quantityItems}
                        onValueChange={value => {
                          if (value !== null) updateItem(index, { quantity: Number(value) })
                        }}
                        value={String(item.quantity)}
                      /> : <Input id={`prescription-quantity-${index}`} max={1_000} min={1} onChange={event => updateItem(index, { quantity: Number(event.currentTarget.value) })} type="number" value={item.quantity} />}
                    </Field>
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
                        onSelect={selection => replaceMedication(index, selection)}
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
              })}</div>}
              <div className="flex flex-wrap justify-end gap-2">
                <Button disabled={saveDraft.isPending || invalidDraft} type="submit" variant="outline">
                  <ClipboardPenIcon data-icon="inline-start" />{messages.savePrescriptionDraft}
                </Button>
                {state?.draft === undefined ? null : (
                  <>
                    <AlertDialog onOpenChange={setDeleteDraftOpen} open={deleteDraftOpen}>
                      <AlertDialogTrigger
                        render={(
                          <Button
                            disabled={removeDraft.isPending || issue.isPending}
                            type="button"
                            variant="ghost"
                          />
                        )}
                      >
                        <Trash2Icon data-icon="inline-start" />{messages.deletePrescriptionDraft}
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{messages.deletePrescriptionDraftTitle}</AlertDialogTitle>
                          <AlertDialogDescription>{messages.deletePrescriptionDraftDescription}</AlertDialogDescription>
                        </AlertDialogHeader>
                        <ul className="flex flex-col gap-1.5 text-sm">
                          {state.draft.items.map((item) => {
                            const medication = catalog.find(candidate => candidate.id === item.catalogItemId)
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
                            disabled={removeDraft.isPending}
                            onClick={() => {
                              setDeleteDraftOpen(false)
                              queueMicrotask(() => removeDraft.mutate(detail.caseId))
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
                            disabled={dirty || issue.isPending || saveDraft.isPending}
                            type="button"
                          />
                        )}
                      >
                        <PillIcon data-icon="inline-start" />{messages.issuePrescription}
                      </AlertDialogTrigger>
                      <AlertDialogContent className="sm:max-w-lg">
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
                            const medication = catalog.find(candidate => candidate.id === draftItem.catalogItemId)
                            return (
                              <li className="flex items-center justify-between gap-3 px-3 py-2" key={draftItem.catalogItemId}>
                                <span className="font-medium">
                                  {(locale === 'zh-CN' ? medication?.nameZh : medication?.nameEn)
                                    ?? draftItem.referenceProduct?.genericName
                                    ?? draftItem.catalogItemId}
                                </span>
                                <span className="text-muted-foreground">
                                  {draftItem.doseText} · {draftItem.frequencyCode} · {messages.quantity} {draftItem.quantity}
                                </span>
                              </li>
                            )
                          })}
                        </ul>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
                          <AlertDialogCancel
                            disabled={issue.isPending}
                            onClick={() => {
                              setIssueOpen(false)
                              queueMicrotask(() => issue.mutate())
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
              {saveDraft.isSuccess && state?.draft !== undefined ? (
                <Alert>
                  <CheckIcon aria-hidden="true" />
                  <AlertTitle>{messages.prescriptionDraftSaved}</AlertTitle>
                </Alert>
              ) : null}
              {removeDraft.data !== undefined
                && removeDraft.variables === detail.caseId
                && state?.draft === undefined
                && state?.draftVersion === removeDraft.data.data.draftVersion ? (
                <Alert>
                  <CheckIcon aria-hidden="true" />
                  <AlertTitle>{messages.prescriptionDraftDeleted}</AlertTitle>
                </Alert>
              ) : null}
              {saveDraft.error === null ? null : (
                <ErrorAlert
                  message={getWorkspaceErrorMessage(saveDraft.error, messages)}
                  title={getWorkspaceErrorTitle(saveDraft.error, messages, messages.operationFailed)}
                />
              )}
              {removeDraft.error === null || removeDraft.variables !== detail.caseId ? null : (
                <ErrorAlert
                  message={getWorkspaceErrorMessage(removeDraft.error, messages)}
                  title={getWorkspaceErrorTitle(removeDraft.error, messages, messages.operationFailed)}
                />
              )}
              {issue.error === null ? null : (
                <ErrorAlert
                  message={getPrescriptionIssueErrorMessage(issue.error, messages)}
                  title={getWorkspaceErrorTitle(issue.error, messages, messages.operationFailed)}
                />
              )}
            </FieldGroup>
          </form>
        ) : null}

      {!readOnly
        && noMedicationConclusion === undefined
        && !hasActivePrescription
        && mode === 'no-medication' ? (
          <div className="flex flex-col items-end gap-3">
            <Button disabled={confirmNone.isPending} onClick={() => confirmNone.mutate()} type="button">
              <CircleXIcon data-icon="inline-start" />{messages.confirmNoMedication}
            </Button>
            {confirmNone.error === null ? null : (
              <ErrorAlert
                message={getWorkspaceErrorMessage(confirmNone.error, messages)}
                title={getWorkspaceErrorTitle(confirmNone.error, messages, messages.operationFailed)}
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
