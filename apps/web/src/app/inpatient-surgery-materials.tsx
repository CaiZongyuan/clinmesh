import type { z } from 'zod'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { inpatientSurgeryCatalogSchema, inpatientSurgeryExecutionSchema, inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { useState } from 'react'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale;
  write: ReturnType<typeof useInpatientWriteIntent>; execution: z.infer<typeof inpatientSurgeryExecutionSchema>;
  request: z.infer<typeof inpatientSurgeryRequestSchema>; catalog: z.infer<typeof inpatientSurgeryCatalogSchema> | undefined;
  reservations: InpatientMaterialReservation[]; running: boolean }

export function InpatientSurgeryMaterials({ admission, session, locale, write, execution, request, catalog, reservations, running }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const [materialId, setMaterialId] = useState<string | null>(null), [quantity, setQuantity] = useState('1')
  const [reservationId, setReservationId] = useState<string | null>(null), [note, setNote] = useState('')
  const materials = (catalog?.materials ?? []).filter(item => 'chargeDefinition' in item)
  const material = materials.find(item => item.id === materialId), amount = Number(quantity)
  const reservation = reservations.find(item => item.id === reservationId)
  const selection = material && Number.isSafeInteger(amount) && amount > 0 && amount <= 1000 ? {
    materialId: material.id, catalogVersion: material.version, quantity: amount,
    ...(reservation ? { reservationId: reservation.id, expectedReservationVersion: reservation.version } : {}),
  } : null
  const writable = session.actor.roleCode === 'inpatient-doctor' && admission.recordStatus !== 'archived' && admission.financialStatus === 'open'
  const blocked = write.blocked || !note.trim(), common = { admissionId: admission.id, requestId: request.id,
    expectedRequestVersion: request.version, executionId: execution.id, note: note.trim() }
  return <section aria-label={t('术中耗材逐笔登记', 'Surgical material entries')} className="flex flex-col gap-3 rounded-md border p-3">
    <h4 className="font-medium">{running ? t('手术进行中', 'Surgery in progress') : t('手术已完成', 'Surgery completed')} · {execution.actualProcedure.coding.display}</h4>
    <p className="text-sm text-muted-foreground">{t('实际使用逐笔确认并记费；更正保留原记录与原费用冲正，不代表取出器械或退库存。', 'Each confirmed use is charged separately. Corrections retain the original record and charge reversal; they do not remove devices or return inventory.')}</p>
    {writable ? <FieldSet disabled={write.blocked}><FieldLegend>{running ? t('本笔实际使用', 'Current material use') : t('术后记录更正', 'Postoperative record correction')}</FieldLegend><FieldGroup>
      <Field><FieldLabel htmlFor={`surgery-entry-material-${execution.id}`}>{t('本笔耗材产品', 'Material product')}</FieldLabel><WorkspaceSelect id={`surgery-entry-material-${execution.id}`} value={materialId} items={materials.map(item => ({ value: item.id, label: item.display }))} onValueChange={id => { setMaterialId(id); setReservationId(null) }} /></Field>
      <Field><FieldLabel htmlFor={`surgery-entry-quantity-${execution.id}`}>{t('本笔实际数量', 'Quantity used')}</FieldLabel><Input id={`surgery-entry-quantity-${execution.id}`} type="number" min="1" max="1000" step="1" value={quantity} onChange={event => setQuantity(event.target.value)} /></Field>
      <Field><FieldLabel htmlFor={`surgery-entry-reservation-${execution.id}`}>{t('本笔消耗预留', 'Reservation to consume')}</FieldLabel><WorkspaceSelect id={`surgery-entry-reservation-${execution.id}`} value={reservationId ?? ''} items={[
        { value: '', label: t('额外使用，不消耗预留', 'Additional use without reservation') },
        ...reservations.filter(item => item.status === 'reserved' && item.materialId === materialId && (item.catalogVersion === undefined || item.catalogVersion === material?.version) && (!item.requestId || item.requestId === request.id))
          .map(item => ({ value: item.id, label: `${item.materialDisplay} · ${t('余量', 'remaining')} ${item.remainingQuantity ?? item.quantity - item.consumedQuantity} · ${item.reason}` })),
      ]} onValueChange={id => setReservationId(id || null)} /></Field>
      <Field><FieldLabel htmlFor={`surgery-entry-note-${execution.id}`}>{t('本笔使用或更正依据', 'Use or correction basis')}</FieldLabel><Input id={`surgery-entry-note-${execution.id}`} value={note} onChange={event => setNote(event.target.value)} maxLength={2000} /></Field>
      {material && selection ? <p>{t('本笔预计收费 ', 'Expected charge ')}{formatFen((reservation?.priceFen ?? material.chargeDefinition.priceFen) * amount, locale)} · {t('单位 ', 'Unit ')}{material.chargeDefinition.unit}</p> : null}
      {running ? <Button disabled={blocked || !selection || (reservation !== undefined && amount > (reservation.remainingQuantity ?? reservation.quantity - reservation.consumedQuantity))} onClick={() => {
        if (selection) write.mutation.mutate({ operation: 'inpatient.surgery.record-material', input: { ...common, material: selection } })
      }}>{t('确认登记本笔使用', 'Confirm material use')}</Button> : null}
    </FieldGroup></FieldSet> : null}
    {execution.materials.length === 0 ? <p>{t('当前无有效实际耗材使用记录。', 'No current material use records.')}</p> : null}
    {execution.materials.map(use => <article key={use.id} className="flex flex-col gap-2 rounded-md border p-2">
      <p>{use.item.display} × {use.quantity}{use.item.chargeDefinition.unit} · {formatFen(use.amountFen, locale)}</p>
      {writable ? <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={blocked} onClick={() => write.mutation.mutate({ operation: 'inpatient.surgery.correct-material', input: { ...common, materialUseId: use.id } })}>{t('撤销错误记录', 'Void incorrect record')} {use.item.display}</Button>
        <Button variant="outline" disabled={blocked || !selection} onClick={() => { if (selection) write.mutation.mutate({ operation: 'inpatient.surgery.correct-material', input: { ...common, materialUseId: use.id, replacement: selection } }) }}>{t('更正为当前选择', 'Replace with current selection')} {use.item.display}</Button>
      </div> : null}
    </article>)}
    <details><summary>{t('查看使用与更正历史', 'Material and correction history')}</summary>{execution.materialHistory.map(use => <p key={use.id}>{use.item.display} × {use.quantity} · {use.note} · {use.recordedAt}{use.correction ? ` · ${t('已更正：', 'Corrected: ')}${use.correction.note}` : ''}</p>)}</details>
    {running && writable ? <>
      <p className="text-sm text-muted-foreground">{t('完成仅追加一次术式费，并收拢明确绑定本手术的未用预留余量；未绑定的住院后续治疗预留保留。', 'Completing adds the procedure charge once and releases unused reservations bound to this surgery. Other admission reservations remain available.')}</p>
      <Button disabled={blocked} onClick={() => write.mutation.mutate({ operation: 'inpatient.surgery.complete', input: common })}>{t('确认完成本次手术', 'Complete this surgery')}</Button>
    </> : null}
  </section>
}
