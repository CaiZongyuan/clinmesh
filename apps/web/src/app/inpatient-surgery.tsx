import { InpatientSurgeryMaterials } from './inpatient-surgery-materials.tsx'
import { InpatientPciSelection } from './inpatient-pci-selection.tsx'
import { InpatientMaterialEstimates } from './inpatient-material-estimate.tsx'
import { InpatientGuidelineAdvicePanel } from './inpatient-guideline-advice.tsx'
import { pciSelectionProcedureCodes } from '@clinmesh/contracts/inpatient-pci-selection'
import { z } from 'zod'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema, type inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientMaterialReservationListSchema, type InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Spinner } from '@clinmesh/ui/components/spinner'
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { useQuery } from '@tanstack/react-query'
import { useLayoutEffect, useRef, useState } from 'react'
import { apiGet } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { WorkspaceActionBar } from './workspace-card-layout.tsx'
import { Skeleton } from '@clinmesh/ui/components/skeleton'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>; active?: boolean }
export function InpatientSurgery({ admission, session, locale, write, active = true }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const doctor = session.actor.roleCode === 'inpatient-doctor', nurse = session.actor.roleCode === 'ward-nurse'
  const scope = ['inpatient',session.actor.workspaceId,session.actor.epoch,session.actor.practitionerRoleId]
  const surgery = useQuery({ queryKey: [...scope,admission.id,'surgeries'], queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/surgeries`,inpatientSurgerySchema,signal) })
  const catalog = useQuery({ queryKey: [...scope,'surgery-catalog'], enabled: doctor || nurse, queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/surgery-catalog',inpatientSurgeryCatalogSchema,signal) })
  const reservations = useQuery({ queryKey: [...scope,admission.id,'drg-reservations'], enabled: doctor, queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/reservations`, inpatientMaterialReservationListSchema, signal) })
  const [procedureId,setProcedureId] = useState<string|null>(null), [plannedFor,setPlannedFor] = useState(''), [reason,setReason] = useState('')
  const [requestOpen, setRequestOpen] = useState(false), [assessmentOpen, setAssessmentOpen] = useState(false), [otherPlansOpen, setOtherPlansOpen] = useState(false)
  const requestOwnerKey = JSON.stringify([session.user.id, session.actor.actorId, scope, admission.id])
  const requestOwner = useRef(requestOwnerKey)
  useLayoutEffect(() => { requestOwner.current = requestOwnerKey }, [requestOwnerKey])
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null)
  const blocked = write.blocked || admission.status !== 'admitted'
  const procedure = catalog.data?.procedures.find(item => item.id === procedureId)
  const request = () => {
    if (!procedure || !surgery.data || !plannedFor || !reason.trim()) return
    const date = new Date(`${plannedFor}+08:00`)
    if (!Number.isFinite(date.getTime())) return
    write.mutation.mutate({ operation: 'inpatient.surgery.request', input: { admissionId: admission.id, encounterVersion: surgery.data.encounterVersion,
      procedureId: procedure.id, catalogVersion: procedure.version, plannedFor: date.toISOString(), reason } }, {
      onSuccess: () => { if (requestOwner.current === requestOwnerKey) setRequestOpen(false) },
    })
  }
  const error = surgery.error ?? catalog.error ?? reservations.error
  const formId = `${admission.id}-surgery-form`
  const requestAction = <Button disabled={blocked || !procedure || !plannedFor || !reason.trim() || !surgery.data} type="submit" form={formId}>{t('申请手术','Request surgery')}</Button>
  const running = surgery.data?.inProgress ?? []
  const pendingPlans = surgery.data?.requests.filter(row => ['requested', 'ready'].includes(row.status) && !running.some(execution => execution.requestId === row.id)) ?? []
  const selectedPlan = pendingPlans.find(row => row.id === selectedRequestId) ?? pendingPlans[0]
  const plans = <>
    {pendingPlans.length > 1 ? <Field><FieldLabel htmlFor="current-surgery-plan">{t('当前计划', 'Current plan')}</FieldLabel><WorkspaceSelect id="current-surgery-plan" value={selectedPlan?.id ?? null} disabled={write.blocked}
      items={pendingPlans.map(row => ({ value: row.id, label: `${row.plannedProcedure.coding.display} · ${row.reason}` }))} onValueChange={setSelectedRequestId} /></Field> : null}
    {pendingPlans.map(row => <div key={row.id} hidden={row.id !== selectedPlan?.id || running.length > 0 && !otherPlansOpen}><SurgeryRequest row={row} catalog={catalog.data} reservations={reservations.data?.reservations ?? []}
      admission={admission} session={session} locale={locale} write={write} focused={row.id === selectedPlan?.id && (running.length === 0 || otherPlansOpen)} /></div>)}
  </>
  return <section aria-label={t('住院手术','Inpatient surgery')} className="flex flex-col gap-4">
    {error ? <Alert variant="destructive"><AlertDescription>{t('手术资料读取失败：', 'Surgery records failed to load: ')}{getWorkspaceErrorMessage(error,getWorkspaceMessages(locale))}<Button variant="outline" size="sm" onClick={() => { void surgery.refetch(); void catalog.refetch(); if (doctor) void reservations.refetch() }}>{t('重试手术资料', 'Retry surgery records')}</Button></AlertDescription></Alert> : null}
    {surgery.isPending ? <Skeleton className="h-24 w-full" /> : null}
    {running.map(execution => {
      const plan = surgery.data?.requests.find(row => row.id === execution.requestId)
      return plan ? <InpatientSurgeryMaterials key={execution.id} admission={admission} session={session} locale={locale} write={write}
        execution={execution} request={plan} catalog={catalog.data} reservations={reservations.data?.reservations ?? []} running active={active}
        refresh={() => Promise.all([surgery.refetch(), catalog.refetch(), reservations.refetch()])} /> : null
    })}
    {pendingPlans.length > 0 ? running.length > 0 ? <details className="clinmesh-inpatient-disclosure" onToggle={event => setOtherPlansOpen(event.currentTarget.open)}><summary>{t('其他待实施手术', 'Other planned procedures')}</summary><div className="flex flex-col gap-4 py-3">{plans}</div></details> : plans : null}
    {surgery.data?.requests.length === 0 ? <p className="text-sm text-muted-foreground">{t('暂无手术申请；需要手术时从下方新增申请。','No surgery requests. Add a request below when surgery is needed.')}</p> : null}
    {doctor ? <details open={requestOpen} className="clinmesh-inpatient-disclosure" onToggle={event => setRequestOpen(event.currentTarget.open)}><summary onClick={event => { if (write.mutation.isPending) event.preventDefault() }}>{t('新增手术申请', 'New surgery request')}</summary>
      <p className="py-3 text-sm text-muted-foreground">{t('手术目录为固定来源的八条分类摘录，收费为合成本院演示价。','The catalog contains eight entries from a fixed classification source, with synthetic hospital demonstration prices.')}</p>
      <form hidden={!requestOpen} id={formId} onSubmit={event => { event.preventDefault(); request() }}><FieldSet disabled={blocked}><FieldLegend>{t('申请手术','Request surgery')}</FieldLegend><FieldGroup className="grid gap-3 md:grid-cols-2">
      <Field><FieldLabel htmlFor="inpatient-surgery-plan">{t('计划术式','Planned procedure')}</FieldLabel><WorkspaceSelect id="inpatient-surgery-plan" value={procedureId} items={(catalog.data?.procedures ?? []).map(item => ({ value: item.id, label: `${item.coding.code} · ${item.coding.display}` }))} onValueChange={setProcedureId} /></Field>
      <Field><FieldLabel htmlFor="inpatient-surgery-time">{t('计划手术时间（上海时间）','Planned surgery time (Shanghai)')}</FieldLabel><Input id="inpatient-surgery-time" type="datetime-local" value={plannedFor} onChange={event => setPlannedFor(event.currentTarget.value)} required /></Field>
      <Field><FieldLabel htmlFor="inpatient-surgery-reason">{t('手术申请理由','Surgery request reason')}</FieldLabel><Input id="inpatient-surgery-reason" maxLength={2000} value={reason} onChange={event => setReason(event.currentTarget.value)} required /></Field>
      {requestOpen ? <InpatientPrimaryAction stage="surgery" priority={10} fallback={requestAction}><WorkspaceActionBar tone={blocked || !procedure || !plannedFor || !reason.trim() || !surgery.data ? 'blocked' : 'normal'}
        summary={procedure?.coding.display} reason={!procedure ? t('还差：选择计划术式。', 'Select the planned procedure.') : !plannedFor ? t('还差：填写计划手术时间。', 'Enter the planned surgery time.') : !reason.trim() ? t('还差：填写手术申请理由。', 'Enter the surgery request reason.') : undefined}
        action={requestAction} /></InpatientPrimaryAction> : null}
    </FieldGroup></FieldSet></form></details> : null}
    <InpatientPciSelection admission={admission} session={session} locale={locale} write={write} active={active} />
    <details className="clinmesh-inpatient-disclosure" onToggle={event => setAssessmentOpen(event.currentTarget.open)}><summary onClick={event => { if (write.mutation.isPending) event.preventDefault() }}>{t('耗材与指南评估', 'Material estimates and guideline advice')}</summary><div className="flex flex-col gap-4 py-3">
    <InpatientMaterialEstimates admission={admission} session={session} locale={locale} write={write} requests={surgery.data?.requests ?? []} active={active && assessmentOpen}
      inProgressRequestIds={surgery.data?.inProgress.map(execution => execution.requestId) ?? []} />
    {doctor ? surgery.data?.requests.filter(row => pciSelectionProcedureCodes.includes(row.plannedProcedure.coding.code)).map(row =>
      <section key={`guideline-${row.id}`} aria-label={`${t('PCI 计划参考', 'PCI plan reference')}：${row.plannedProcedure.coding.display} · ${row.reason}`} className="flex min-w-0 flex-col gap-2">
        <p className="text-sm font-medium">{row.plannedProcedure.coding.display} · {row.reason}</p>
        <InpatientGuidelineAdvicePanel admission={admission} session={session} locale={locale} write={write} requestId={row.id} active={active && assessmentOpen}
          canReassess={active && assessmentOpen && admission.status === 'admitted' && admission.recordStatus !== 'archived' && ['requested', 'ready'].includes(row.status)
            && !surgery.data?.inProgress.some(execution => execution.requestId === row.id)} />
      </section>) : null}
    </div></details>
    {surgery.data?.executions.map(execution => {
      const request = surgery.data?.requests.find(item => item.id === execution.requestId)
      if (!request) return null
      const panel = <InpatientSurgeryMaterials admission={admission} session={session} locale={locale} write={write}
        execution={execution} request={request} catalog={catalog.data} reservations={reservations.data?.reservations ?? []} running={false} active={active}
        refresh={() => Promise.all([surgery.refetch(), catalog.refetch(), reservations.refetch()])} />
      return <details key={execution.id} className="clinmesh-inpatient-disclosure"><summary>{t('术后耗材更正与历史', 'Postoperative material corrections and history')} · {execution.actualProcedure.coding.display}</summary>{panel}</details>
    })}
    {surgery.data?.requests.some(row => ['completed', 'cancelled'].includes(row.status)) ? <details className="clinmesh-inpatient-disclosure"><summary>{t('已完成与已取消的手术计划', 'Completed and cancelled plans')}</summary><div className="flex flex-col gap-3 py-3">
      {surgery.data.requests.filter(row => ['completed', 'cancelled'].includes(row.status)).map(row => <SurgeryRequest key={row.id} row={row} catalog={catalog.data} reservations={reservations.data?.reservations ?? []} admission={admission} session={session} locale={locale} write={write} focused={false} />)}
    </div></details> : null}
    {surgery.data?.executions.length ? <details className="clinmesh-inpatient-disclosure"><summary>{t('实际手术记录', 'Performed procedures')}</summary>{surgery.data.executions.map(execution => <article key={execution.id} className="flex flex-col gap-2 py-3">
      <p>{t('实际实施：','Performed: ')}{execution.actualProcedure.coding.code} · {execution.actualProcedure.coding.display}</p>
      <p className="font-mono text-sm tabular-nums">{new Date(execution.performedAt).toLocaleString(locale,{timeZone:'Asia/Shanghai'})} · {execution.note}</p>
      <p>{t('分类：','Classification: ')}{execution.actualProcedure.coding.category} · ICD-9-CM-3 {execution.actualProcedure.coding.version}</p>
      {execution.materials.map(material => <p key={material.id}>{material.item.display} · {material.quantity}{material.item.chargeDefinition.unit}</p>)}
    </article>)}</details> : null}
  </section>
}

function SurgeryRequest({ row, catalog, reservations, admission, session, locale, write, focused }: Props & { row: z.infer<typeof inpatientSurgeryRequestSchema>; catalog: z.infer<typeof inpatientSurgeryCatalogSchema> | undefined; reservations: InpatientMaterialReservation[]; focused: boolean }): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const doctor = session.actor.roleCode === 'inpatient-doctor', nurse = session.actor.roleCode === 'ward-nurse'
  const [note,setNote] = useState(''), [actualId,setActualId] = useState<string|null>(null), [quantities,setQuantities] = useState<Record<string,string>>({})
  const [reservationIds, setReservationIds] = useState<Record<string, string>>({})
  const [completeOpen, setCompleteOpen] = useState(false)
  const actual = catalog?.procedures.find(item => item.id === actualId)
  const active = ['requested','ready'].includes(row.status), blocked = write.blocked || admission.status !== 'admitted'
  const common = { admissionId: admission.id, requestId: row.id, expectedRequestVersion: row.version, note }
  const confirmingConsent = write.mutation.isPending && write.mutation.variables?.operation === 'inpatient.surgery.confirm-consent'
    && write.mutation.variables.input.requestId === row.id
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
  return <article role="region" aria-label={focused ? t('当前手术计划', 'Current surgery plan') : t('手术计划记录', 'Surgery plan record')} className="flex min-w-0 flex-col gap-4">
    <div className="clinmesh-inpatient-summary flex flex-col gap-3">
      <div className="clinmesh-inpatient-section-heading flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold">{row.plannedProcedure.coding.display}</h4><Badge variant="outline">{{ requested:t('待准备','Preparation pending'), ready:t('已就绪','Ready'), completed:t('已实施','Completed'), cancelled:t('已取消','Cancelled') }[row.status]}</Badge></div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">{t('计划手术时间（上海时间）', 'Planned surgery time (Shanghai)')}</dt><dd className="tabular-nums">{new Date(row.plannedFor).toLocaleString(locale,{timeZone:'Asia/Shanghai'})}</dd></div><div><dt className="text-muted-foreground">{t('申请理由', 'Request reason')}</dt><dd>{row.reason}</dd></div></dl>
    </div>
    <section aria-label={active ? t('开始手术还差', 'Before starting surgery') : t('术前准备记录', 'Preparation record')} className="flex flex-col gap-2"><h4 className="font-medium">{active ? t('开始手术还差', 'Before starting surgery') : t('术前准备记录', 'Preparation record')}</h4><ul className="flex flex-col gap-2 text-sm">
      <li>{t('病区护士 · 术前核对：', 'Ward nurse · preoperative checks: ')}{row.preopCheck ? `${t('已完成 ', 'Completed ')}${new Date(row.preopCheck.recordedAt).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })}` : t('待完成', 'Pending')}</li>
      <li>{t('住院医生 · 知情同意：', 'Inpatient doctor · consent: ')}{row.consentConfirmation ? `${t('已完成 ', 'Completed ')}${new Date(row.consentConfirmation.recordedAt).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })}` : t('待确认同意书已签', 'Confirm signed consent')}</li>
    </ul></section>
    {row.preopCheck ? <p>{row.preopCheck.note}</p> : null}{row.consentConfirmation ? <p>{row.consentConfirmation.note}</p> : null}
    {row.cancellation ? <p>{t('取消原因：','Cancellation: ')}{row.cancellation.note}</p> : null}
    {active && (doctor || nurse) ? <FieldSet disabled={blocked}><FieldGroup>
      <Field><FieldLabel htmlFor={`surgery-note-${row.id}`}>{t('手术记录说明','Surgery record note')}</FieldLabel><Input id={`surgery-note-${row.id}`} maxLength={2000} value={note} onChange={event => setNote(event.currentTarget.value)} /></Field>
      <div className="flex flex-wrap gap-2">
        {nurse && !row.preopCheck ? <Button disabled={blocked || !note.trim()} onClick={() => write.mutation.mutate({ operation:'inpatient.surgery.check-preop',input:common })}>{t('术前核对','Record preoperative checks')}</Button> : null}
        {doctor && !row.consentConfirmation ? <Button aria-busy={confirmingConsent || undefined} data-busy={confirmingConsent || undefined} data-unavailable={!write.mutation.isPending && (blocked || !note.trim()) || undefined}
          disabled={blocked || !note.trim()} onClick={() => write.mutation.mutate({ operation:'inpatient.surgery.confirm-consent',input:common })}>{confirmingConsent ? <Spinner aria-hidden="true" data-icon="inline-start" /> : null}{confirmingConsent ? t('正在确认知情同意书', 'Confirming signed consent') : t('确认手术知情同意书已签','Confirm signed consent')}</Button> : null}
        {doctor ? <details className="clinmesh-inpatient-disclosure"><summary>{t('取消当前申请', 'Cancel current request')}</summary><Button variant="outline" disabled={blocked || !note.trim()} onClick={() => write.mutation.mutate({ operation:'inpatient.surgery.cancel',input:common })}>{t('取消手术申请','Cancel surgery request')}</Button></details> : null}
      </div>
      {doctor ? <>
        <Field><FieldLabel htmlFor={`surgery-actual-${row.id}`}>{t('实际术式','Performed procedure')}</FieldLabel><WorkspaceSelect id={`surgery-actual-${row.id}`} value={actualId} items={(catalog?.procedures ?? []).map(item => ({value:item.id,label:`${item.coding.code} · ${item.coding.display}`}))} onValueChange={setActualId} /></Field>
        {actual ? <p>{t('合成手术费用：','Synthetic procedure price: ')}<span className="font-mono tabular-nums">{formatFen(actual.chargeDefinition.priceFen,locale)}</span></p> : null}
        <p className="text-sm text-muted-foreground">{t('开始手术不登记耗材或收取术式费；实际用量须进入术中逐笔确认。', 'Starting creates no material entries or procedure charge. Confirm actual use during surgery.')}</p>
        {focused ? <InpatientPrimaryAction stage="surgery" priority={actual && note.trim() ? 20 : -20} fallback={start}><WorkspaceActionBar summary={row.plannedProcedure.coding.display}
          tone={blocked || row.status !== 'ready' || !actual || !note.trim() ? 'blocked' : 'normal'}
          reason={!row.preopCheck ? t('等病区护士完成术前核对。', 'Waiting for ward nurse preoperative checks.') : !row.consentConfirmation ? t('等住院医生确认手术知情同意书已签。', 'Waiting for the inpatient doctor to confirm signed consent.') : !actual ? t('还差：选择实际术式。', 'Select the performed procedure.') : !note.trim() ? t('还差：填写手术记录说明。', 'Enter the surgery record note.') : undefined}
          action={start} /></InpatientPrimaryAction> : null}
        <details className="clinmesh-inpatient-disclosure" onToggle={event => setCompleteOpen(event.currentTarget.open)}><summary onClick={event => { if (write.mutation.isPending) event.preventDefault() }}>{t('单次完整登记', 'Record an entire procedure at once')}</summary><FieldGroup hidden={!completeOpen} className="py-3">
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
        </FieldGroup></details>
      </> : null}
    </FieldGroup></FieldSet> : null}
  </article>
}
