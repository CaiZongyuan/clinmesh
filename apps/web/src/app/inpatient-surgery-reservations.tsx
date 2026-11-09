import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { apiGet } from './api-client.ts'
import { DrgError } from './inpatient-drg.tsx'
import { InpatientConfirmation } from './inpatient-confirmation.tsx'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>; active?: boolean }

export function InpatientMaterialReservations({ admission, session, locale, write, active = true }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const scope = ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id]
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  const list = useQuery({ enabled: active, queryKey: [...scope, 'drg-reservations'], queryFn: ({ signal }) => apiGet(`${path}/drg/reservations`, inpatientMaterialReservationListSchema, signal) })
  const catalog = useQuery({ enabled: active, queryKey: [...scope, 'surgery-catalog'], queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/surgery-catalog', inpatientSurgeryCatalogSchema, signal) })
  const surgery = useQuery({ enabled: active, queryKey: [...scope, 'surgeries'], queryFn: ({ signal }) => apiGet(`${path}/surgeries`, inpatientSurgerySchema, signal) })
  const [materialId, setMaterialId] = useState<string | null>(null), [requestId, setRequestId] = useState<string | null>(null)
  const [quantity, setQuantity] = useState('1'), [reason, setReason] = useState('')
  const [review, setReview] = useState<Parameters<typeof write.mutation.mutate>[0]>()
  const materials = catalog.data?.materials.filter(item => 'chargeDefinition' in item) ?? []
  const material = materials.find(item => item.id === materialId)
  const amount = Number(quantity), valid = Number.isInteger(amount) && amount > 0 && amount <= 1000
  const error = list.error ?? catalog.error ?? surgery.error
  return <section aria-label={t('治疗耗材预留', 'Treatment material reservations')} className="flex flex-col gap-3">
    <h4 className="font-medium">{t('治疗耗材预留', 'Treatment material reservations')}</h4>
    <p className="text-sm text-muted-foreground">{t('预留用于预计，未使用余量不计费。实际使用须逐笔引用预留；已消耗部分保留正式收费，不再重复预计。', 'Unused reservations are estimates and carry no charge. Reference a reservation for each actual use; consumed quantities retain their posted charges and leave the estimate.')}</p>
    <DrgError error={error} locale={locale} />
    <FieldSet disabled={write.blocked}><FieldLegend>{t('新增预留', 'New reservation')}</FieldLegend><FieldGroup className="grid gap-3 md:grid-cols-2">
      <Field><FieldLabel htmlFor="drg-material">{t('预留耗材', 'Material')}</FieldLabel><WorkspaceSelect id="drg-material" value={materialId} items={materials.map(item => ({ value: item.id, label: item.display }))} onValueChange={setMaterialId} /></Field>
      <Field><FieldLabel htmlFor="drg-request">{t('关联手术计划', 'Surgery plan')}</FieldLabel><WorkspaceSelect id="drg-request" value={requestId ?? ''} items={[{ value: '', label: t('未关联', 'Not linked') }, ...(surgery.data?.requests ?? []).filter(item => item.status === 'requested' || item.status === 'ready').map(item => ({ value: item.id, label: item.plannedProcedure.coding.display }))]} onValueChange={setRequestId} /></Field>
      <Field><FieldLabel htmlFor="drg-quantity">{t('预留数量', 'Quantity')}</FieldLabel><Input id="drg-quantity" type="number" min="1" max="1000" step="1" value={quantity} onChange={event => setQuantity(event.currentTarget.value)} /></Field>
      <Field><FieldLabel htmlFor="drg-reason">{t('预留或释放理由', 'Reason for reservation or release')}</FieldLabel><Input id="drg-reason" value={reason} maxLength={2000} onChange={event => setReason(event.currentTarget.value)} /></Field>
    </FieldGroup><Button variant="outline" disabled={write.blocked || !material || !list.data || !valid || !reason.trim()} onClick={() => { if (material && list.data) setReview({ operation: 'inpatient.drg.reservation.create', input: { admissionId: admission.id, encounterVersion: list.data.encounterVersion, materialId: material.id, catalogVersion: material.version, quantity: amount, ...(requestId ? { requestId } : {}), reason: reason.trim() } }) }}>{t('审阅新增预留', 'Review reservation')}</Button></FieldSet>
    {list.data?.reservations.map(item => <div key={item.id} className="flex flex-wrap items-center gap-2"><p>{item.materialDisplay} × {item.quantity} · {t('已用 ', 'Used ')}{item.consumedQuantity} · {t('余量 ', 'Remaining ')}{item.remainingQuantity ?? (item.status === 'reserved' ? item.quantity - item.consumedQuantity : 0)} · {t('余量预计 ', 'Remaining estimate ')}{formatFen(item.priceFen * (item.remainingQuantity ?? (item.status === 'reserved' ? item.quantity - item.consumedQuantity : 0)), locale)} · {{ reserved: t('预留中', 'Reserved'), replaced: t('已转实际使用', 'Replaced with actual use'), released: t('已释放', 'Released') }[item.status]}{item.releaseReason ? ` · ${item.releaseReason}` : ''}</p>{item.status === 'reserved' ? <Button variant="outline" disabled={write.blocked || !reason.trim()} onClick={() => { if (list.data) setReview({ operation: 'inpatient.drg.reservation.release', input: { admissionId: admission.id, encounterVersion: list.data.encounterVersion, reservationId: item.id, reason: reason.trim() } }) }}>{t('审阅释放预留', 'Review release')}</Button> : null}</div>)}
    {review ? <InpatientConfirmation locale={locale} title={t('确认耗材预留变更', 'Confirm reservation change')}
      description={t('核对耗材、数量与理由。预留变更不产生收费或手术执行。', 'Review material, quantity and reason. This does not create charges or performed procedures.')}
      confirmLabel={t('确认预留变更', 'Confirm reservation change')} pending={write.mutation.isPending} disabled={write.blocked}
      onCancel={() => setReview(undefined)} onConfirm={() => write.mutation.mutate(review, { onSuccess: () => setReview(undefined) })}>
      {review.operation === 'inpatient.drg.reservation.create' ? <p>{materials.find(item => item.id === review.input.materialId)?.display} × {review.input.quantity} · {review.input.reason}</p> : review.operation === 'inpatient.drg.reservation.release' ? <p>{list.data?.reservations.find(item => item.id === review.input.reservationId)?.materialDisplay} · {review.input.reason}</p> : null}
      <DrgError error={write.mutation.error} locale={locale} />
    </InpatientConfirmation> : null}
  </section>
}
