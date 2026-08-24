import type { PharmacyQueueItem, SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@clinmesh/ui/components/select'
import { Separator } from '@clinmesh/ui/components/separator'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@clinmesh/ui/components/table'
import { Tabs, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlertIcon, PackageCheckIcon, PillIcon, ShieldAlertIcon, ShieldCheckIcon } from 'lucide-react'
import { useState } from 'react'
import {
  dispensePrescription,
  getPharmacyQueue,
  newIdempotencyKey,
  reviewPrescription,
} from './api-client.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { allergyWarningLabel } from './allergy-warning.ts'
import { PaginationControls } from './pagination-controls.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import { formatFen } from './workspace-format.ts'

interface PharmacyWorkspaceProps {
  locale: WorkspaceLocale
  session: SessionContext
}

type PharmacyStatus = 'completed' | 'exception' | 'pending'

export function PharmacyWorkspace({ locale, session }: PharmacyWorkspaceProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const queryClient = useQueryClient()
  const scope = [session.actor.workspaceId, session.actor.epoch] as const
  const [status, setStatus] = useState<PharmacyStatus>('pending')
  const [page, setPage] = useState(1)
  const [selectedPrescriptionId, setSelectedPrescriptionId] = useState<string>()
  const [selectedLotIds, setSelectedLotIds] = useState<Record<string, string>>({})
  const [dispenseQuantities, setDispenseQuantities] = useState<Record<string, string>>({})
  const [reviewNote, setReviewNote] = useState('')
  const queueKey = ['pharmacy-queue', ...scope, status, page] as const
  const queue = useQuery({
    queryFn: ({ signal }) => getPharmacyQueue(status, signal, page),
    queryKey: queueKey,
  })
  const selectedPrescription = queue.data?.items.find(
    item => item.prescriptionId === selectedPrescriptionId,
  ) ?? queue.data?.items[0]
  const review = useMutation({
    mutationFn: () => {
      if (selectedPrescription === undefined) throw new Error(messages.pharmacyUnavailable)
      return reviewPrescription({
        encounterId: selectedPrescription.encounterId,
        encounterVersion: selectedPrescription.encounterVersion,
        medications: selectedPrescription.medications,
        note: reviewNote,
        prescriptionId: selectedPrescription.prescriptionId,
        prescriptionVersion: selectedPrescription.prescriptionVersion,
      }, newIdempotencyKey())
    },
    onSuccess: async () => {
      setReviewNote('')
      await queryClient.invalidateQueries({ queryKey: ['pharmacy-queue', ...scope] })
    },
  })
  const dispense = useMutation({
    mutationFn: () => {
      if (selectedPrescription === undefined) throw new Error(messages.pharmacyUnavailable)
      return dispensePrescription({
        encounterId: selectedPrescription.encounterId,
        encounterVersion: selectedPrescription.encounterVersion,
        medications: selectedPrescription.medications,
        prescriptionId: selectedPrescription.prescriptionId,
        prescriptionVersion: selectedPrescription.prescriptionVersion,
        lotSelections: selectedPrescription.medications
          .filter(medication => medication.remainingQuantity > 0)
          .map(medication => {
            const lot = selectedLot(medication, selectedLotIds[medication.medicationRequestId])
            if (lot === undefined) throw new Error(messages.inventoryUnavailable)
            return {
              expectedVersion: lot.version,
              lotId: lot.id,
              quantity: Number(
                dispenseQuantities[medication.medicationRequestId] ?? medication.remainingQuantity,
              ),
            }
          }),
      }, newIdempotencyKey())
    },
    onSuccess: async () => {
      setSelectedPrescriptionId(undefined)
      setSelectedLotIds({})
      setDispenseQuantities({})
      setReviewNote('')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['pharmacy-queue', ...scope] }),
        queryClient.invalidateQueries({ queryKey: ['scenario-current', ...scope] }),
      ])
    },
  })
  const changeStatus = (value: PharmacyStatus) => {
    setStatus(value)
    setPage(1)
    setSelectedPrescriptionId(undefined)
    setSelectedLotIds({})
    setDispenseQuantities({})
    setReviewNote('')
    review.reset()
    dispense.reset()
  }
  const selectPrescription = (prescriptionId: string) => {
    setSelectedPrescriptionId(prescriptionId)
    setSelectedLotIds({})
    setDispenseQuantities({})
    setReviewNote('')
    review.reset()
    dispense.reset()
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(19rem,0.75fr)_minmax(32rem,1.25fr)]">
      <section aria-labelledby="pharmacy-queue-heading" className="flex min-w-0 flex-col gap-4 border-b pb-6 xl:border-r xl:border-b-0 xl:pr-6">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold" id="pharmacy-queue-heading">{messages.pharmacyQueue}</h2>
          <Badge variant="secondary">{queue.data?.total ?? 0}</Badge>
        </div>
        <Tabs onValueChange={value => changeStatus(value as PharmacyStatus)} value={status}>
          <TabsList className="w-full">
            <TabsTrigger className="min-w-0 flex-1" value="pending">{messages.pendingDispense}</TabsTrigger>
            <TabsTrigger className="min-w-0 flex-1" value="completed">{messages.completedDispense}</TabsTrigger>
            <TabsTrigger className="min-w-0 flex-1" value="exception">{messages.pharmacyException}</TabsTrigger>
          </TabsList>
        </Tabs>
        {queue.isPending ? <Skeleton className="h-44 w-full" /> : queue.isError ? (
          <PharmacyError message={getWorkspaceErrorMessage(queue.error, messages)} title={getWorkspaceErrorTitle(queue.error, messages, messages.pharmacyUnavailable)} />
        ) : queue.data.items.length === 0 ? (
          <Empty className="min-h-44 border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><PillIcon aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{messages.noPharmacyItems}</EmptyTitle>
              <EmptyDescription>{messages.noPharmacyItemsDescription}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-2" role="list">
            {queue.data.items.map(item => (
              <PrescriptionRow
                item={item}
                key={item.prescriptionId}
                messages={messages}
                onSelect={() => selectPrescription(item.prescriptionId)}
                selected={item.prescriptionId === selectedPrescription?.prescriptionId}
              />
            ))}
            <PaginationControls
              messages={messages}
              onPageChange={(nextPage) => {
                setPage(nextPage)
                setSelectedPrescriptionId(undefined)
                setSelectedLotIds({})
                setDispenseQuantities({})
                setReviewNote('')
                review.reset()
                dispense.reset()
              }}
              page={queue.data.page}
              pageSize={queue.data.pageSize}
              total={queue.data.total}
            />
          </div>
        )}
      </section>

      <section aria-labelledby="prescription-details-heading" className="flex min-w-0 flex-col gap-5">
        <h2 className="text-base font-semibold" id="prescription-details-heading">{messages.prescriptionDetails}</h2>
        {dispense.isSuccess ? (
          <Alert>
            <PackageCheckIcon aria-hidden="true" />
            <AlertTitle>{dispense.data.data.status === 'partial'
              ? messages.dispensePartiallyCompleted
              : messages.dispenseCompleted}</AlertTitle>
            <AlertDescription>
              {dispense.data.data.scenarioStatus === 'completed'
                ? messages.scenarioRunCompleted
                : messages.scenarioRunActive}
            </AlertDescription>
          </Alert>
        ) : null}
        {dispense.isError ? <PharmacyError message={getWorkspaceErrorMessage(dispense.error, messages)} title={getWorkspaceErrorTitle(dispense.error, messages, messages.operationFailed)} /> : null}
        {review.isSuccess ? <Alert><ShieldCheckIcon aria-hidden="true" /><AlertTitle>{messages.prescriptionReviewed}</AlertTitle></Alert> : null}
        {review.isError ? <PharmacyError message={getWorkspaceErrorMessage(review.error, messages)} title={getWorkspaceErrorTitle(review.error, messages, messages.operationFailed)} /> : null}
        {selectedPrescription === undefined ? (
          <Empty className="min-h-44 border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><PackageCheckIcon aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{messages.noPharmacyItems}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <PrescriptionDetails
            dispenseQuantities={dispenseQuantities}
            item={selectedPrescription}
            locale={locale}
            messages={messages}
            onLotChange={(medicationRequestId, lotId) => {
              setSelectedLotIds(current => ({ ...current, [medicationRequestId]: lotId }))
              dispense.reset()
            }}
            onQuantityChange={(medicationRequestId, quantity) => {
              setDispenseQuantities(current => ({ ...current, [medicationRequestId]: quantity }))
              dispense.reset()
            }}
            selectedLotIds={selectedLotIds}
          />
        )}
        {selectedPrescription?.status === 'awaiting-review' && status === 'pending' ? (
          <section aria-labelledby="prescription-review-heading" className="sticky bottom-0 flex flex-col gap-3 border-t bg-background py-4">
            <div>
              <h3 className="text-sm font-semibold" id="prescription-review-heading">{messages.prescriptionReview}</h3>
              <p className="text-xs text-muted-foreground">{selectedPrescription.prescriptionNumber}</p>
            </div>
            <Field>
              <FieldLabel htmlFor="prescription-review-note">{messages.reviewNote}</FieldLabel>
              <Textarea id="prescription-review-note" onChange={event => setReviewNote(event.currentTarget.value)} required value={reviewNote} />
            </Field>
            <div className="flex justify-end">
              <Button disabled={review.isPending || reviewNote.trim() === ''} onClick={() => review.mutate()} type="button">
                <ShieldCheckIcon data-icon="inline-start" />{messages.approvePrescription}
              </Button>
            </div>
          </section>
        ) : null}
        {selectedPrescription !== undefined
        && ['awaiting-dispense', 'partially-dispensed'].includes(selectedPrescription.status)
        && status === 'pending' ? (
          <section aria-labelledby="dispense-review-heading" className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t bg-background py-4">
            <div>
              <h3 className="text-sm font-semibold" id="dispense-review-heading">{messages.dispenseReview}</h3>
              <p className="text-xs text-muted-foreground">{selectedPrescription.prescriptionNumber}</p>
            </div>
            <Button
              disabled={dispense.isPending || !hasValidDispense(selectedPrescription, selectedLotIds, dispenseQuantities)}
              onClick={() => dispense.mutate()}
              type="button"
            >
              <PackageCheckIcon data-icon="inline-start" />
              {messages.confirmDispense}
            </Button>
          </section>
        ) : null}
      </section>
    </div>
  )
}

function PrescriptionRow({ item, messages, onSelect, selected }: {
  item: PharmacyQueueItem
  messages: ReturnType<typeof getWorkspaceMessages>
  onSelect: () => void
  selected: boolean
}): React.JSX.Element {
  return (
    <Button
      aria-label={`${messages.selectPrescription} ${item.patient.name}`}
      className="h-auto min-h-16 w-full justify-between gap-3 px-3 py-2 text-left"
      onClick={onSelect}
      role="listitem"
      type="button"
      variant={selected ? 'secondary' : 'outline'}
    >
      <span className="min-w-0">
        <span className="block truncate font-medium">{item.patient.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{item.prescriptionNumber}</span>
      </span>
      <Badge variant={item.status === 'completed' ? 'secondary' : 'outline'}>
        {item.status === 'completed'
          ? messages.completedDispense
          : item.status === 'partially-dispensed'
            ? messages.partialDispense
            : item.status === 'awaiting-review'
              ? messages.awaitingReview
              : messages.awaitingDispense}
      </Badge>
    </Button>
  )
}

function PrescriptionDetails({
  dispenseQuantities,
  item,
  locale,
  messages,
  onLotChange,
  onQuantityChange,
  selectedLotIds,
}: {
  dispenseQuantities: Record<string, string>
  item: PharmacyQueueItem
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  onLotChange: (medicationRequestId: string, lotId: string) => void
  onQuantityChange: (medicationRequestId: string, quantity: string) => void
  selectedLotIds: Record<string, string>
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-lg font-semibold">{item.patient.name}</div>
          <div className="text-sm text-muted-foreground">{item.prescriptionNumber}</div>
        </div>
        <Badge>{messages.paid}</Badge>
      </div>
      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-muted-foreground">{messages.authoredBy}</dt><dd className="font-medium">{item.authoredBy}</dd></div>
        <div><dt className="text-muted-foreground">{messages.paymentStatus}</dt><dd className="font-medium">{messages.paid}</dd></div>
        <div><dt className="text-muted-foreground">{messages.encounterStatus}</dt><dd className="font-medium">{item.encounterStatus === 'completed' ? messages.encounterCompleted : item.encounterStatus}</dd></div>
      </dl>
      {item.review === undefined ? null : (
        <dl className="grid grid-cols-1 gap-3 border-t pt-4 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">{messages.prescriptionReview}</dt><dd className="font-medium">{item.review.note}</dd></div>
          <div><dt className="text-muted-foreground">{messages.reviewedAt}</dt><dd className="font-medium">{item.review.reviewedAt}</dd></div>
        </dl>
      )}
      <Separator />
      {item.allergyWarnings.length === 0 ? (
        <Alert>
          <ShieldAlertIcon aria-hidden="true" />
          <AlertTitle>{messages.allergyWarnings}</AlertTitle>
          <AlertDescription>{messages.noAllergyWarnings}</AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive">
          <ShieldAlertIcon aria-hidden="true" />
          <AlertTitle>{messages.allergyWarnings}</AlertTitle>
          <AlertDescription>{item.allergyWarnings.map(allergyWarningLabel).join('; ')}</AlertDescription>
        </Alert>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{messages.medication}</TableHead>
            <TableHead>{messages.dose}</TableHead>
            <TableHead>{messages.quantity}</TableHead>
            <TableHead>{messages.dispensedQuantity}</TableHead>
            <TableHead>{messages.remainingQuantity}</TableHead>
            <TableHead>{messages.unitPrice}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {item.medications.map(medication => (
            <TableRow key={medication.medicationRequestId}>
              <TableCell className="font-medium">{locale === 'zh-CN' ? medication.nameZh : medication.nameEn}</TableCell>
              <TableCell>{medication.doseText} · {medication.frequencyCode}</TableCell>
              <TableCell>{medication.quantity}</TableCell>
              <TableCell>{medication.dispensedQuantity}</TableCell>
              <TableCell>{medication.remainingQuantity}</TableCell>
              <TableCell>{formatFen(medication.unitPriceFen, locale)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <FieldGroup>
        {item.medications.map(medication => {
          const lot = selectedLot(medication, selectedLotIds[medication.medicationRequestId])
          return (
            <Field key={medication.medicationRequestId}>
              <FieldLabel htmlFor={`lot-${medication.medicationRequestId}`}>
                {messages.inventoryLot} · {locale === 'zh-CN' ? medication.nameZh : medication.nameEn}
              </FieldLabel>
              {lot === undefined ? <p className="text-sm text-destructive">{messages.inventoryUnavailable}</p> : (
                <>
                  <Select
                    onValueChange={value => onLotChange(medication.medicationRequestId, value as string)}
                    value={lot.id}
                  >
                    <SelectTrigger className="w-full" id={`lot-${medication.medicationRequestId}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {medication.lots.map(option => (
                          <SelectItem key={option.id} value={option.id}>{option.lotNumber}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                    <span>{lot.lotNumber}</span>
                    <span>{messages.inventoryOnHand} {lot.quantityOnHand}</span>
                    <span>{messages.expiresOn} {lot.expiresOn}</span>
                  </div>
                  {medication.remainingQuantity > 0 ? <Field>
                    <FieldLabel htmlFor={`dispense-quantity-${medication.medicationRequestId}`}>
                      {messages.dispenseQuantity} · {locale === 'zh-CN' ? medication.nameZh : medication.nameEn}
                    </FieldLabel>
                    <Input
                      id={`dispense-quantity-${medication.medicationRequestId}`}
                      max={Math.min(medication.remainingQuantity, lot.quantityOnHand)}
                      min="1"
                      onChange={event => onQuantityChange(
                        medication.medicationRequestId,
                        event.currentTarget.value,
                      )}
                      required
                      type="number"
                      value={dispenseQuantities[medication.medicationRequestId]
                        ?? String(medication.remainingQuantity)}
                    />
                  </Field> : null}
                </>
              )}
            </Field>
          )
        })}
      </FieldGroup>
    </div>
  )
}

function selectedLot(
  medication: PharmacyQueueItem['medications'][number],
  selectedId: string | undefined,
) {
  return medication.lots.find(lot => lot.id === selectedId) ?? medication.lots[0]
}

function hasValidDispense(
  item: PharmacyQueueItem,
  selectedLotIds: Record<string, string>,
  dispenseQuantities: Record<string, string>,
): boolean {
  const remaining = item.medications.filter(medication => medication.remainingQuantity > 0)
  return remaining.length > 0 && remaining.every(medication => {
    const lot = selectedLot(medication, selectedLotIds[medication.medicationRequestId])
    const quantity = Number(
      dispenseQuantities[medication.medicationRequestId] ?? medication.remainingQuantity,
    )
    return lot !== undefined
      && Number.isInteger(quantity)
      && quantity > 0
      && quantity <= medication.remainingQuantity
      && quantity <= lot.quantityOnHand
  })
}

function PharmacyError({ message, title }: { message: string; title: string }): React.JSX.Element {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
