import { InpatientSurgeryMaterials } from './inpatient-surgery-materials.tsx'
import { InpatientPciSelection } from './inpatient-pci-selection.tsx'
import { InpatientMaterialEstimates } from './inpatient-material-estimate.tsx'
import { z } from 'zod'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema, type inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientMaterialReservationListSchema, type InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { apiGet } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { WorkspaceActionBar } from './workspace-card-layout.tsx'
import { Skeleton } from '@clinmesh/ui/components/skeleton'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent> }
export function InpatientSurgery({ admission, session, locale, write }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const doctor = session.actor.roleCode === 'inpatient-doctor', nurse = session.actor.roleCode === 'ward-nurse'
  const scope = ['inpatient',session.actor.workspaceId,session.actor.epoch,session.actor.practitionerRoleId]
  const surgery = useQuery({ queryKey: [...scope,admission.id,'surgeries'], queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/surgeries`,inpatientSurgerySchema,signal) })
  const catalog = useQuery({ queryKey: [...scope,'surgery-catalog'], enabled: doctor || nurse, queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/surgery-catalog',inpatientSurgeryCatalogSchema,signal) })
  const reservations = useQuery({ queryKey: [...scope,admission.id,'drg-reservations'], enabled: doctor, queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/reservations`, inpatientMaterialReservationListSchema, signal) })
  const [procedureId,setProcedureId] = useState<string|null>(null), [plannedFor,setPlannedFor] = useState(''), [reason,setReason] = useState('')
  const blocked = write.blocked || admission.status !== 'admitted'
  const procedure = catalog.data?.procedures.find(item => item.id === procedureId)
  const request = () => {
    if (!procedure || !surgery.data || !plannedFor || !reason.trim()) return
    const date = new Date(`${plannedFor}+08:00`)
    if (!Number.isFinite(date.getTime())) return
    write.mutation.mutate({ operation: 'inpatient.surgery.request', input: { admissionId: admission.id, encounterVersion: surgery.data.encounterVersion,
      procedureId: procedure.id, catalogVersion: procedure.version, plannedFor: date.toISOString(), reason } })
  }
  const error = surgery.error ?? catalog.error ?? reservations.error
  const formId = `${admission.id}-surgery-form`
  const requestAction = <Button disabled={blocked || !procedure || !plannedFor || !reason.trim() || !surgery.data} type="submit" form={formId}>{t('申请手术','Request surgery')}</Button>
  return <section aria-label={t('住院手术','Inpatient surgery')} className="flex flex-col gap-4">
    <h3 className="text-base font-semibold">{t('手术计划与实际实施','Surgery plans and performed procedures')}</h3>
    <p>{t('手术目录为固定来源的八条分类摘录，收费为合成本院演示价。','The catalog contains eight entries from a fixed classification source, with synthetic hospital demonstration prices.')}</p>
    {error ? <Alert variant="destructive"><AlertDescription>{t('手术资料读取失败：', 'Surgery records failed to load: ')}{getWorkspaceErrorMessage(error,getWorkspaceMessages(locale))}<Button variant="outline" size="sm" onClick={() => { void surgery.refetch(); void catalog.refetch(); if (doctor) void reservations.refetch() }}>{t('重试手术资料', 'Retry surgery records')}</Button></AlertDescription></Alert> : null}
    <InpatientPciSelection admission={admission} session={session} locale={locale} write={write} />
    {surgery.isPending ? <Skeleton className="h-24 w-full" /> : null}
    {doctor ? <form id={formId} onSubmit={event => { event.preventDefault(); request() }}><FieldSet disabled={blocked}><FieldLegend>{t('申请手术','Request surgery')}</FieldLegend><FieldGroup className="grid gap-3 md:grid-cols-2">
      <Field><FieldLabel htmlFor="inpatient-surgery-plan">{t('计划术式','Planned procedure')}</FieldLabel><WorkspaceSelect id="inpatient-surgery-plan" value={procedureId} items={(catalog.data?.procedures ?? []).map(item => ({ value: item.id, label: `${item.coding.code} · ${item.coding.display}` }))} onValueChange={setProcedureId} /></Field>
      <Field><FieldLabel htmlFor="inpatient-surgery-time">{t('计划手术时间（上海时间）','Planned surgery time (Shanghai)')}</FieldLabel><Input id="inpatient-surgery-time" type="datetime-local" value={plannedFor} onChange={event => setPlannedFor(event.currentTarget.value)} required /></Field>
      <Field><FieldLabel htmlFor="inpatient-surgery-reason">{t('手术申请理由','Surgery request reason')}</FieldLabel><Input id="inpatient-surgery-reason" maxLength={2000} value={reason} onChange={event => setReason(event.currentTarget.value)} required /></Field>
      <InpatientPrimaryAction stage="surgery" fallback={requestAction}><WorkspaceActionBar tone={blocked || !procedure || !plannedFor || !reason.trim() || !surgery.data ? 'blocked' : 'normal'}
        summary={procedure?.coding.display} reason={!procedure ? t('还差：选择计划术式。', 'Select the planned procedure.') : !plannedFor ? t('还差：填写计划手术时间。', 'Enter the planned surgery time.') : !reason.trim() ? t('还差：填写手术申请理由。', 'Enter the surgery request reason.') : undefined}
        action={requestAction} /></InpatientPrimaryAction>
    </FieldGroup></FieldSet></form> : null}
    <InpatientMaterialEstimates admission={admission} session={session} locale={locale} write={write} requests={surgery.data?.requests ?? []} />
    {surgery.data?.requests.map(row => <SurgeryRequest key={row.id} row={row} catalog={catalog.data} reservations={reservations.data?.reservations ?? []} inProgress={surgery.data?.inProgress.some(execution => execution.requestId === row.id) ?? false} admission={admission} session={session} locale={locale} write={write} />)}
    {[...(surgery.data?.inProgress ?? []), ...(surgery.data?.executions ?? [])].map(execution => {
      const request = surgery.data?.requests.find(item => item.id === execution.requestId)
      if (!request) return null
      const running = surgery.data?.inProgress.some(item => item.id === execution.id) ?? false
      const panel = <InpatientSurgeryMaterials admission={admission} session={session} locale={locale} write={write}
        execution={execution} request={request} catalog={catalog.data} reservations={reservations.data?.reservations ?? []} running={running}
        refresh={() => Promise.all([surgery.refetch(), catalog.refetch(), reservations.refetch()])} />
      return running ? <div key={execution.id}>{panel}</div> : <details key={execution.id}><summary>{t('术后耗材更正与历史', 'Postoperative material corrections and history')}</summary>{panel}</details>
    })}
    {surgery.data?.executions.map(execution => <article key={execution.id} className="rounded-md border p-3">
      <p>{t('实际实施：','Performed: ')}{execution.actualProcedure.coding.code} · {execution.actualProcedure.coding.display}</p>
      <p className="font-mono text-sm tabular-nums">{new Date(execution.performedAt).toLocaleString(locale,{timeZone:'Asia/Shanghai'})} · {execution.note}</p>
      <p>{t('分类：','Classification: ')}{execution.actualProcedure.coding.category} · ICD-9-CM-3 {execution.actualProcedure.coding.version}</p>
      {execution.materials.map(material => <p key={material.id}>{material.item.display} · {material.quantity}{material.item.chargeDefinition.unit}</p>)}
    </article>)}
    {surgery.data?.requests.length === 0 ? <p>{t('暂无手术申请；本次无已实施手术。','No surgery requests or performed procedures for this admission.')}</p> : null}
  </section>
}

function SurgeryRequest({ row, catalog, reservations, admission, session, locale, write, inProgress }: Props & { row: z.infer<typeof inpatientSurgeryRequestSchema>; catalog: z.infer<typeof inpatientSurgeryCatalogSchema> | undefined; reservations: InpatientMaterialReservation[]; inProgress: boolean }): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const doctor = session.actor.roleCode === 'inpatient-doctor', nurse = session.actor.roleCode === 'ward-nurse'
  const [note,setNote] = useState(''), [actualId,setActualId] = useState<string|null>(null), [quantities,setQuantities] = useState<Record<string,string>>({})
  const [reservationIds, setReservationIds] = useState<Record<string, string>>({})
  const actual = catalog?.procedures.find(item => item.id === actualId)
  const active = !inProgress && ['requested','ready'].includes(row.status), blocked = write.blocked || admission.status !== 'admitted'
  const common = { admissionId: admission.id, requestId: row.id, expectedRequestVersion: row.version, note }
  const materials = (catalog?.materials ?? []).filter(item => 'chargeDefinition' in item)
  const unavailableCount = (catalog?.materials.length ?? 0) - materials.length
  const materialValues = materials.filter(item => quantities[item.id] !== undefined).map(item => ({ item, quantity: Number(quantities[item.id]) }))
  const quantitiesValid = materialValues.every(value => Number.isSafeInteger(value.quantity) && value.quantity >= 0 && value.quantity <= 1000)
  const execute = () => {
    if (!actual || !quantitiesValid) return
    write.mutation.mutate({ operation: 'inpatient.surgery.execute', input: { ...common, procedureId: actual.id, catalogVersion: actual.version,
      materials: materialValues.filter(value => value.quantity > 0).map(({item,quantity}) => ({ materialId: item.id, catalogVersion: item.version, quantity, ...(reservationIds[item.id] ? { reservationId: reservationIds[item.id] } : {}) })) } })
  }
  const start = <Button disabled={blocked || row.status !== 'ready' || !actual || !note.trim()} onClick={() => {
    if (actual) write.mutation.mutate({ operation: 'inpatient.surgery.start', input: { ...common, procedureId: actual.id, catalogVersion: actual.version } })
  }}>{t('开始手术逐笔登记', 'Start surgery with material entries')}</Button>
  return <article className="flex flex-col gap-3 rounded-md border bg-card p-3">
    <p>{row.plannedProcedure.coding.display} · {{ requested:t('待准备','Preparation pending'), ready:t('已就绪','Ready'), completed:t('已实施','Completed'), cancelled:t('已取消','Cancelled') }[row.status]}</p>
    <p>{t('计划时间：','Planned time: ')}{new Date(row.plannedFor).toLocaleString(locale,{timeZone:'Asia/Shanghai'})} · {row.reason}</p>
    <p>{t('术前核对：','Preoperative checks: ')}{row.preopCheck ? t('已核对','Checked') : t('等病区护士核对','Waiting for the ward nurse')} · {t('知情同意：','Consent: ')}{row.consentConfirmation ? t('手术知情同意书已签','Surgical consent confirmed') : t('等住院医生确认同意书已签','Waiting for the inpatient doctor to confirm signed consent')}</p>
    {row.preopCheck ? <p>{row.preopCheck.note}</p> : null}{row.consentConfirmation ? <p>{row.consentConfirmation.note}</p> : null}
    {row.cancellation ? <p>{t('取消原因：','Cancellation: ')}{row.cancellation.note}</p> : null}
    {active && (doctor || nurse) ? <FieldSet disabled={blocked}><FieldGroup>
      <Field><FieldLabel htmlFor={`surgery-note-${row.id}`}>{t('手术记录说明','Surgery record note')}</FieldLabel><Input id={`surgery-note-${row.id}`} maxLength={2000} value={note} onChange={event => setNote(event.currentTarget.value)} /></Field>
      <div className="flex flex-wrap gap-2">
        {nurse && !row.preopCheck ? <Button disabled={blocked || !note.trim()} onClick={() => write.mutation.mutate({ operation:'inpatient.surgery.check-preop',input:common })}>{t('术前核对','Record preoperative checks')}</Button> : null}
        {doctor && !row.consentConfirmation ? <Button disabled={blocked || !note.trim()} onClick={() => write.mutation.mutate({ operation:'inpatient.surgery.confirm-consent',input:common })}>{t('确认手术知情同意书已签','Confirm signed consent')}</Button> : null}
        {doctor ? <Button variant="outline" disabled={blocked || !note.trim()} onClick={() => write.mutation.mutate({ operation:'inpatient.surgery.cancel',input:common })}>{t('取消手术申请','Cancel surgery request')}</Button> : null}
      </div>
      {doctor ? <>
        <Field><FieldLabel htmlFor={`surgery-actual-${row.id}`}>{t('实际术式','Performed procedure')}</FieldLabel><WorkspaceSelect id={`surgery-actual-${row.id}`} value={actualId} items={(catalog?.procedures ?? []).map(item => ({value:item.id,label:`${item.coding.code} · ${item.coding.display}`}))} onValueChange={setActualId} /></Field>
        {actual ? <p>{t('合成手术费用：','Synthetic procedure price: ')}<span className="font-mono tabular-nums">{formatFen(actual.chargeDefinition.priceFen,locale)}</span></p> : null}
        <p className="text-sm text-muted-foreground">{t('开始手术不登记耗材或收取术式费；实际用量须进入术中逐笔确认。', 'Starting creates no material entries or procedure charge. Confirm actual use during surgery.')}</p>
        <InpatientPrimaryAction stage="surgery" priority={actual && note.trim() ? 20 : -20} fallback={start}><WorkspaceActionBar summary={row.plannedProcedure.coding.display}
          tone={blocked || row.status !== 'ready' || !actual || !note.trim() ? 'blocked' : 'normal'}
          reason={!row.preopCheck ? t('等病区护士完成术前核对。', 'Waiting for ward nurse preoperative checks.') : !row.consentConfirmation ? t('等住院医生确认手术知情同意书已签。', 'Waiting for the inpatient doctor to confirm signed consent.') : !actual ? t('还差：选择实际术式。', 'Select the performed procedure.') : !note.trim() ? t('还差：填写手术记录说明。', 'Enter the surgery record note.') : undefined}
          action={start} /></InpatientPrimaryAction>
        <Field><FieldLabel htmlFor={`surgery-material-select-${row.id}`}>{t('手术耗材','Surgical material')}</FieldLabel>
          <WorkspaceSelect id={`surgery-material-select-${row.id}`} value={null} placeholder={t('选择实际使用耗材（最多20项）','Select materials used (up to 20)')}
            items={materialValues.length >= 20 ? [] : materials.filter(item => quantities[item.id] === undefined).map(item => ({ value: item.id, label: item.display }))}
            onValueChange={id => { if (id) setQuantities(previous => ({ ...previous, [id]: '1' })) }} />
        </Field>
        {unavailableCount > 0 ? <p>{t(`${unavailableCount} 项耗材因计价单位未确认而未启用`,`${unavailableCount} materials are unavailable because their billing unit is unconfirmed`)}</p> : null}
        {materialValues.map(({item}) => <Field key={item.id}><FieldLabel htmlFor={`surgery-material-${row.id}-${item.id}`}>{item.display}{t('实际用量',' quantity used')}</FieldLabel><Input id={`surgery-material-${row.id}-${item.id}`} type="number" min="0" max="1000" step="1" disabled={!!reservationIds[item.id]} value={quantities[item.id] ?? '0'} onChange={event => setQuantities(previous => ({...previous,[item.id]:event.currentTarget.value}))} /><p>{formatFen(item.chargeDefinition.priceFen,locale)}/{item.chargeDefinition.unit}</p>
          <FieldLabel htmlFor={`surgery-reservation-${row.id}-${item.id}`}>{t('替换治疗预留','Replace treatment reservation')}</FieldLabel><WorkspaceSelect id={`surgery-reservation-${row.id}-${item.id}`} value={reservationIds[item.id] ?? ''} items={[{ value: '', label: t('独立记录实际使用','Record separate actual use') }, ...reservations.filter(value => value.status === 'reserved' && value.materialId === item.id && (!value.requestId || value.requestId === row.id)).map(value => ({ value: value.id, label: `${value.materialDisplay} × ${value.quantity} · ${value.reason}` }))]} onValueChange={id => { setReservationIds(previous => ({ ...previous, [item.id]: id ?? '' })); const reservation = reservations.find(value => value.id === id); if (reservation) setQuantities(previous => ({ ...previous, [item.id]: String(reservation.quantity) })) }} />
          <Button type="button" variant="outline" aria-label={`${t('移除耗材','Remove material')} ${item.display}`} onClick={() => { setQuantities(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== item.id))); setReservationIds(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== item.id))) }}>{t('移除','Remove')}</Button>
        </Field>)}
        <Button disabled={blocked || row.status !== 'ready' || !actual || !note.trim() || !quantitiesValid} onClick={execute}>{t('记录实际手术','Record performed surgery')}</Button>
      </> : null}
    </FieldGroup></FieldSet> : null}
  </article>
}
