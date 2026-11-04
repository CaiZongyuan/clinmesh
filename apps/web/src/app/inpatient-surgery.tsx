import { InpatientSurgeryMaterials, SurgeryDrgLink } from './inpatient-surgery-materials.tsx'
import { InpatientPciSelection } from './inpatient-pci-selection.tsx'
import { InpatientMaterialEstimates } from './inpatient-material-estimate.tsx'
import { InpatientGuidelineAdvicePanel } from './inpatient-guideline-advice.tsx'
import { InpatientMaterialReservations } from './inpatient-surgery-reservations.tsx'
import { InpatientDrgReviewPanel } from './inpatient-drg-review.tsx'
import { pciSelectionProcedureCodes } from '@clinmesh/contracts/inpatient-pci-selection'
import { z } from 'zod'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema, type inpatientSurgeryExecutionSchema, type inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientMaterialReservationListSchema, type InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Spinner } from '@clinmesh/ui/components/spinner'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { useQuery } from '@tanstack/react-query'
import { useLayoutEffect, useRef, useState } from 'react'
import { apiGet } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { WorkspaceActionBar } from './workspace-card-layout.tsx'
import { OrderComposerFooter } from './doctor/order-composer-layout.tsx'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { CheckCircle2Icon, CircleIcon, PlusIcon } from 'lucide-react'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>; active?: boolean; onOpenStage?: (stage: string) => void }
type Request = z.infer<typeof inpatientSurgeryRequestSchema>
type Catalog = z.infer<typeof inpatientSurgeryCatalogSchema>

export function InpatientSurgery({ admission, session, locale, write, active = true, onOpenStage }: Props): React.JSX.Element {
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
  const reservationRows = reservations.data?.reservations ?? []
  const refresh = () => Promise.all([surgery.refetch(), catalog.refetch(), reservations.refetch()])
  const openDrg = onOpenStage ? () => onOpenStage('drg') : undefined
  const pendingPlans = surgery.data?.requests.filter(row => ['requested', 'ready'].includes(row.status) && !running.some(execution => execution.requestId === row.id)) ?? []
  const selectedPlan = pendingPlans.find(row => row.id === selectedRequestId) ?? pendingPlans[0]
  const preoperative = running.length === 0 && pendingPlans.length > 0
  const latest = running.length === 0 && pendingPlans.length === 0 ? surgery.data?.executions.at(-1) : undefined
  const plans = <>
    {pendingPlans.length > 1 ? <Field><FieldLabel htmlFor="current-surgery-plan">{t('当前计划', 'Current plan')}</FieldLabel><WorkspaceSelect id="current-surgery-plan" value={selectedPlan?.id ?? null} disabled={write.blocked}
      items={pendingPlans.map(row => ({ value: row.id, label: `${row.plannedProcedure.coding.display} · ${row.reason}` }))} onValueChange={setSelectedRequestId} /></Field> : null}
    {pendingPlans.map(row => <div key={row.id} hidden={row.id !== selectedPlan?.id || running.length > 0 && !otherPlansOpen}><SurgeryRequest row={row} catalog={catalog.data} reservations={reservationRows}
      admission={admission} session={session} locale={locale} write={write} focused={row.id === selectedPlan?.id && (running.length === 0 || otherPlansOpen)} /></div>)}
  </>
  const estimate = reservationRows.filter(item => item.status === 'reserved' && (!item.requestId || item.requestId === selectedPlan?.id))
  return <section aria-label={t('住院手术','Inpatient surgery')} className="flex flex-col gap-4">
    {error ? <Alert variant="destructive"><AlertDescription>{t('手术资料读取失败：', 'Surgery records failed to load: ')}{getWorkspaceErrorMessage(error,getWorkspaceMessages(locale))}<Button variant="outline" size="sm" onClick={() => { void surgery.refetch(); void catalog.refetch(); if (doctor) void reservations.refetch() }}>{t('重试手术资料', 'Retry surgery records')}</Button></AlertDescription></Alert> : null}
    {surgery.isPending ? <Skeleton className="h-24 w-full" /> : null}
    {running.map(execution => {
      const plan = surgery.data?.requests.find(row => row.id === execution.requestId)
      return plan ? <InpatientSurgeryMaterials key={execution.id} admission={admission} session={session} locale={locale} write={write}
        execution={execution} request={plan} catalog={catalog.data} reservations={reservationRows} running onOpenDrg={openDrg} refresh={refresh} /> : null
    })}
    {pendingPlans.length > 0 ? running.length > 0 ? <details className="clinmesh-inpatient-disclosure" onToggle={event => setOtherPlansOpen(event.currentTarget.open)}><summary>{t('其他待实施手术', 'Other planned procedures')}</summary><div className="flex flex-col gap-4 py-3">{plans}</div></details> : plans : null}
    {preoperative ? <section aria-label={t('术前耗材预计', 'Preoperative material estimate')} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
      <h4 className="text-sm font-semibold">{t('术前耗材预计', 'Preoperative material estimate')}</h4>
      <p className="text-xs text-muted-foreground">{estimate.length > 0 ? `${t('已确认为本计划预留：', 'Reserved for this plan: ')}${estimate.map(item => `${item.materialDisplay} ${item.remainingQuantity ?? item.quantity - item.consumedQuantity}${item.unit ?? ''}`).join('、')}。` : t('尚未预留耗材。', 'No materials reserved yet.')}{t('预留只用于费用预计；实际用量在术中逐笔登记。', ' Reservations only inform estimates; actual use is recorded during surgery.')}</p>
      <details className="clinmesh-inpatient-disclosure" onToggle={event => setAssessmentOpen(event.currentTarget.open)}><summary onClick={event => { if (write.mutation.isPending) event.preventDefault() }}>{t('查看与调整', 'Review and adjust')}</summary><div className="flex flex-col gap-4 py-3">
        <InpatientPciSelection admission={admission} session={session} locale={locale} write={write} active={active && assessmentOpen} />
        <InpatientMaterialEstimates admission={admission} session={session} locale={locale} write={write} requests={surgery.data?.requests ?? []} active={active && assessmentOpen}
          inProgressRequestIds={running.map(execution => execution.requestId)} />
        {doctor ? pendingPlans.filter(row => pciSelectionProcedureCodes.includes(row.plannedProcedure.coding.code)).map(row =>
          <section key={`guideline-${row.id}`} aria-label={`${t('PCI 计划参考', 'PCI plan reference')}：${row.plannedProcedure.coding.display} · ${row.reason}`} className="flex min-w-0 flex-col gap-2">
            <p className="text-sm font-medium">{row.plannedProcedure.coding.display} · {row.reason}</p>
            <InpatientGuidelineAdvicePanel admission={admission} session={session} locale={locale} write={write} requestId={row.id} active={active && assessmentOpen}
              canReassess={active && assessmentOpen && admission.status === 'admitted' && admission.recordStatus !== 'archived'} />
          </section>) : null}
        {doctor && admission.status === 'admitted' ? <InpatientMaterialReservations admission={admission} session={session} locale={locale} write={write} /> : null}
      </div></details>
    </section> : null}
    {latest ? <SurgeryDone execution={latest} locale={locale} onOpenDrg={openDrg} /> : null}
    {doctor && surgery.data?.executions.length ? <InpatientDrgReviewPanel admission={admission} session={session} locale={locale} write={write} active={active} onOpenRecord={onOpenStage} /> : null}
    {surgery.data?.requests.length === 0 ? <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">{t('本次住院暂无手术申请。','No surgery requests for this admission.')}</p> : null}
    {doctor ? <details open={requestOpen} className="clinmesh-inpatient-disclosure" onToggle={event => setRequestOpen(event.currentTarget.open)}><summary onClick={event => { if (write.mutation.isPending) event.preventDefault() }}><PlusIcon aria-hidden="true" className="inline size-3.5" /> {t('新增手术申请', 'New surgery request')}</summary>
      <form hidden={!requestOpen} id={formId} onSubmit={event => { event.preventDefault(); request() }}><FieldSet disabled={blocked}><FieldLegend>{t('申请手术','Request surgery')}</FieldLegend><FieldGroup className="grid gap-3 md:grid-cols-2">
      <Field><FieldLabel htmlFor="inpatient-surgery-plan">{t('计划术式','Planned procedure')}</FieldLabel><WorkspaceSelect id="inpatient-surgery-plan" value={procedureId} items={(catalog.data?.procedures ?? []).map(item => ({ value: item.id, label: `${item.coding.code} · ${item.coding.display}` }))} onValueChange={setProcedureId} /></Field>
      <Field><FieldLabel htmlFor="inpatient-surgery-time">{t('计划手术时间（上海时间）','Planned surgery time (Shanghai)')}</FieldLabel><Input id="inpatient-surgery-time" type="datetime-local" value={plannedFor} onChange={event => setPlannedFor(event.currentTarget.value)} required /></Field>
      <Field className="md:col-span-2"><FieldLabel htmlFor="inpatient-surgery-reason">{t('手术申请理由','Surgery request reason')}</FieldLabel><Input id="inpatient-surgery-reason" maxLength={2000} value={reason} onChange={event => setReason(event.currentTarget.value)} required /></Field>
      {requestOpen ? <InpatientPrimaryAction stage="surgery" priority={10} fallback={requestAction}><WorkspaceActionBar tone={blocked || !procedure || !plannedFor || !reason.trim() || !surgery.data ? 'blocked' : 'normal'}
        summary={procedure?.coding.display} reason={!procedure ? t('还差：选择计划术式。', 'Select the planned procedure.') : !plannedFor ? t('还差：填写计划手术时间。', 'Enter the planned surgery time.') : !reason.trim() ? t('还差：填写手术申请理由。', 'Enter the surgery request reason.') : t('提交后需签手术知情同意书、等病区护士术前核对', 'After submission, confirm consent and wait for ward nurse checks')}
        action={requestAction} /></InpatientPrimaryAction> : null}
    </FieldGroup></FieldSet></form></details> : null}
    {surgery.data?.executions.map(execution => {
      const request = surgery.data?.requests.find(item => item.id === execution.requestId)
      if (!request) return null
      const panel = <InpatientSurgeryMaterials admission={admission} session={session} locale={locale} write={write}
        execution={execution} request={request} catalog={catalog.data} reservations={reservationRows} running={false} refresh={refresh} />
      return <details key={execution.id} className="clinmesh-inpatient-disclosure"><summary>{t('术后耗材更正与历史', 'Postoperative material corrections and history')} · {execution.actualProcedure.coding.display}</summary>{panel}</details>
    })}
    {surgery.data?.requests.some(row => ['completed', 'cancelled'].includes(row.status)) ? <details className="clinmesh-inpatient-disclosure"><summary>{t('已完成与已取消的手术计划', 'Completed and cancelled plans')}</summary><div className="flex flex-col gap-3 py-3">
      {surgery.data.requests.filter(row => ['completed', 'cancelled'].includes(row.status)).map(row => <SurgeryRequest key={row.id} row={row} catalog={catalog.data} reservations={reservationRows} admission={admission} session={session} locale={locale} write={write} focused={false} />)}
    </div></details> : null}
    {surgery.data?.executions.length ? <details className="clinmesh-inpatient-disclosure"><summary>{t('实际手术记录', 'Performed procedures')}</summary>{surgery.data.executions.map(execution => <article key={execution.id} className="flex flex-col gap-2 py-3">
      <p>{t('实际实施：','Performed: ')}{execution.actualProcedure.coding.code} · {execution.actualProcedure.coding.display}</p>
      <p className="font-mono text-sm tabular-nums">{new Date(execution.performedAt).toLocaleString(locale,{timeZone:'Asia/Shanghai'})} · {execution.note}</p>
      <p>{t('分类：','Classification: ')}{execution.actualProcedure.coding.category} · ICD-9-CM-3 {execution.actualProcedure.coding.version}</p>
      {execution.materials.map(material => <p key={material.id}>{material.item.display} · {material.quantity}{material.item.chargeDefinition.unit}</p>)}
    </article>)}</details> : null}
  </section>
}

function SurgeryDone({ execution, locale, onOpenDrg }: { execution: z.infer<typeof inpatientSurgeryExecutionSchema>; locale: WorkspaceLocale; onOpenDrg: (() => void) | undefined }) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const rows = execution.materials.reduce<{ item: (typeof execution.materials)[number]['item']; quantity: number; amountFen: number }[]>((result, use) => {
    const row = result.find(item => item.item.id === use.item.id)
    if (row) { row.quantity += use.quantity; row.amountFen += use.amountFen } else result.push({ item: use.item, quantity: use.quantity, amountFen: use.amountFen })
    return result
  }, [])
  const procedureFen = execution.actualProcedure.chargeDefinition.priceFen
  return <section aria-label={t('最终耗材', 'Final materials')} className="flex min-w-0 flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold">{execution.actualProcedure.coding.display}</h4><span className="font-mono text-xs text-muted-foreground">{execution.actualProcedure.coding.code}</span><Badge variant="outline" className="text-success">{t('已完成', 'Completed')}</Badge></div>
    <Table><TableHeader><TableRow><TableHead>{t('耗材', 'Material')}</TableHead><TableHead>{t('最终用量', 'Final quantity')}</TableHead><TableHead className="text-right">{t('费用', 'Charge')}</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map(row => <TableRow key={row.item.id}><TableCell className="whitespace-normal">{row.item.display}</TableCell><TableCell className="tabular-nums">{row.quantity} {row.item.chargeDefinition.unit}</TableCell><TableCell className="text-right tabular-nums">{formatFen(row.amountFen, locale)}</TableCell></TableRow>)}
        <TableRow><TableCell className="whitespace-normal">{t('术式费', 'Procedure fee')} · {execution.actualProcedure.coding.display}</TableCell><TableCell>{t('1 次', '1')}</TableCell><TableCell className="text-right tabular-nums">{formatFen(procedureFen, locale)}</TableCell></TableRow></TableBody>
      <TableFooter><TableRow><TableCell colSpan={2}>{t('本台合计', 'Surgery total')}</TableCell><TableCell className="text-right tabular-nums">{formatFen(rows.reduce((sum, row) => sum + row.amountFen, procedureFen), locale)}</TableCell></TableRow></TableFooter></Table>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground"><span>{t('耗材与术式费已计入住院费用', 'Materials and procedure fee are posted')}</span><span className="flex-1" /><SurgeryDrgLink locale={locale} onOpenDrg={onOpenDrg} /></div>
  </section>
}

function SurgeryRequest({ row, catalog, reservations, admission, session, locale, write, focused }: Props & { row: Request; catalog: Catalog | undefined; reservations: InpatientMaterialReservation[]; focused: boolean }): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const doctor = session.actor.roleCode === 'inpatient-doctor', nurse = session.actor.roleCode === 'ward-nurse'
  const [panel, setPanel] = useState<'consent' | 'cancel' | 'start' | 'batch' | null>(null)
  const [consentNote, setConsentNote] = useState(''), [preopNote, setPreopNote] = useState(''), [cancelNote, setCancelNote] = useState('')
  const [startNote, setStartNote] = useState(''), [batchNote, setBatchNote] = useState('')
  const [actualId,setActualId] = useState<string|null>(null), [quantities,setQuantities] = useState<Record<string,string>>({})
  const [reservationIds, setReservationIds] = useState<Record<string, string>>({})
  const actual = catalog?.procedures.find(item => item.id === (actualId ?? row.plannedProcedure.id))
  const active = ['requested','ready'].includes(row.status), ready = row.status === 'ready', blocked = write.blocked || admission.status !== 'admitted'
  const common = { admissionId: admission.id, requestId: row.id, expectedRequestVersion: row.version }
  const close = { onSuccess: () => setPanel(null) }
  const pending = (operation: string) => write.mutation.isPending && write.mutation.variables?.operation === operation
  const materials = (catalog?.materials ?? []).filter(item => 'chargeDefinition' in item)
  const unavailableCount = (catalog?.materials.length ?? 0) - materials.length
  const materialValues = materials.filter(item => quantities[item.id] !== undefined).map(item => ({ item, quantity: Number(quantities[item.id]) }))
  const quantitiesValid = materialValues.every(value => Number.isSafeInteger(value.quantity) && value.quantity >= 0 && value.quantity <= 1000)
  const planned = reservations.filter(item => item.requestId === row.id && item.status === 'reserved')
  const plannedFen = planned.reduce((sum, item) => sum + item.priceFen * (item.remainingQuantity ?? item.quantity - item.consumedQuantity), 0)
  const execute = () => {
    if (!actual || !quantitiesValid || !batchNote.trim()) return
    write.mutation.mutate({ operation: 'inpatient.surgery.execute', input: { ...common, note: batchNote.trim(), procedureId: actual.id, catalogVersion: actual.version,
      materials: materialValues.filter(value => value.quantity > 0).map(({item,quantity}) => ({ materialId: item.id, catalogVersion: item.version, quantity, ...(reservationIds[item.id] ? { reservationId: reservationIds[item.id] } : {}) })) } }, close)
  }
  const start = () => { if (actual && startNote.trim()) write.mutation.mutate({ operation: 'inpatient.surgery.start', input: { ...common, note: startNote.trim(), procedureId: actual.id, catalogVersion: actual.version } }, close) }
  const missing = [!row.consentConfirmation ? t('手术知情同意书（你）', 'signed consent (you)') : null, !row.preopCheck ? t('术前核对（病区护士）', 'preoperative checks (ward nurse)') : null].filter(Boolean)
  const status = { requested:t('待准备','Preparation pending'), ready:t('已就绪','Ready'), completed:t('已实施','Completed'), cancelled:t('已取消','Cancelled') }[row.status]
  const preparationTitle = !active ? t('术前准备记录', 'Preparation record') : missing.length === 0 ? t('术前准备已完成', 'Preparation complete') : t('开始手术还差', 'Before starting surgery')
  const bar = panel === 'cancel' ? { priority: 40, tone: cancelNote.trim() ? 'confirm' as const : 'blocked' as const,
    reason: cancelNote.trim() ? t('取消后这份申请不能再开始手术', 'A cancelled request cannot start surgery') : t('还差：取消理由', 'Enter the cancellation reason'),
    action: <><Button variant="ghost" disabled={write.mutation.isPending} onClick={() => setPanel(null)}>{t('返回', 'Back')}</Button>
      <Button variant="destructive" disabled={blocked || !cancelNote.trim()} onClick={() => write.mutation.mutate({ operation: 'inpatient.surgery.cancel', input: { ...common, note: cancelNote.trim() } }, close)}>{t('确认取消手术申请', 'Cancel surgery request')}</Button></> }
    : panel === 'consent' ? { priority: 40, tone: consentNote.trim() ? 'normal' as const : 'blocked' as const,
      reason: consentNote.trim() ? t('确认后记入「开始手术还差」清单', 'Confirmation is recorded in the preparation checklist') : t('还差：签署说明', 'Enter the consent note'),
      action: <><Button variant="ghost" disabled={write.mutation.isPending} onClick={() => setPanel(null)}>{t('取消', 'Cancel')}</Button>
        <Button aria-busy={pending('inpatient.surgery.confirm-consent') || undefined} disabled={blocked || !consentNote.trim()} onClick={() => write.mutation.mutate({ operation: 'inpatient.surgery.confirm-consent', input: { ...common, note: consentNote.trim() } }, close)}>{t('确认手术知情同意书已签', 'Confirm signed consent')}</Button></> }
      : { priority: ready ? 20 : -20, tone: ready && !blocked ? 'normal' as const : 'blocked' as const,
        reason: missing.length > 0 ? `${t('还差：', 'Still needed: ')}${missing.join(t('、', ', '))}` : t('开始后逐笔登记耗材；术式费在完成手术时计入', 'Record materials one by one after starting; the procedure fee is posted at completion'),
        action: <>{ready ? <Button variant="outline" disabled={blocked} onClick={() => setPanel('batch')}>{t('整台补录', 'Record entire surgery')}</Button> : null}
          <Button disabled={blocked || !ready} onClick={() => { setActualId(null); setPanel('start') }}>{t('开始手术逐笔登记', 'Start surgery with material entries')}</Button></> }
  const procedureItems = (catalog?.procedures ?? []).map(item => ({value:item.id,label:`${item.coding.code} · ${item.coding.display}`}))
  const actualField = <Field><FieldLabel htmlFor={`surgery-actual-${row.id}`}>{t('实际术式','Performed procedure')}</FieldLabel><WorkspaceSelect id={`surgery-actual-${row.id}`} value={actual?.id ?? null} items={procedureItems} onValueChange={setActualId} />
    <FieldDescription>{actual && actual.coding.code !== row.plannedProcedure.coding.code ? `${t('与计划不同（计划：', 'Differs from plan (')}${row.plannedProcedure.coding.display}${t('）；DRG 预分组按实际术式重算', '); DRG is recalculated with the performed procedure')}` : t('默认与计划术式相同', 'Defaults to the planned procedure')}</FieldDescription></Field>
  return <article role="region" aria-label={focused ? t('当前手术计划', 'Current surgery plan') : t('手术计划记录', 'Surgery plan record')} className="flex min-w-0 flex-col gap-4">
    <div className="clinmesh-inpatient-summary flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2"><h4 className="font-semibold">{row.plannedProcedure.coding.display}</h4><span className="font-mono text-xs text-muted-foreground">{row.plannedProcedure.coding.code}</span><span className="flex-1" /><Badge variant="outline">{status}</Badge>
        {doctor && active && focused ? <Button variant="ghost" size="sm" aria-expanded={panel === 'cancel'} disabled={blocked} onClick={() => setPanel(panel === 'cancel' ? null : 'cancel')}>{t('取消申请', 'Cancel request')}</Button> : null}</div>
      <dl className="grid gap-3 text-sm @lg:grid-cols-3"><div><dt className="text-xs text-muted-foreground">{t('计划手术时间（上海时间）', 'Planned surgery time (Shanghai)')}</dt><dd className="tabular-nums">{new Date(row.plannedFor).toLocaleString(locale,{timeZone:'Asia/Shanghai'})}</dd></div>
        {planned.length > 0 ? <div><dt className="text-xs text-muted-foreground">{t('预计耗材', 'Estimated materials')}</dt><dd className="tabular-nums">{formatFen(plannedFen, locale)} · {t('已预留', 'Reserved')}</dd></div> : null}
        <div><dt className="text-xs text-muted-foreground">{t('申请理由', 'Request reason')}</dt><dd>{row.reason}</dd></div></dl>
      {panel === 'cancel' ? <Field><FieldLabel htmlFor={`surgery-cancel-${row.id}`}>{t('取消理由','Cancellation reason')}</FieldLabel><Input id={`surgery-cancel-${row.id}`} autoFocus maxLength={2000} disabled={blocked} value={cancelNote} onChange={event => setCancelNote(event.currentTarget.value)} /></Field> : null}
      {row.cancellation ? <p className="text-sm">{t('取消原因：','Cancellation: ')}{row.cancellation.note}</p> : null}
    </div>
    <section aria-label={preparationTitle} className="clinmesh-inpatient-preparation"><h4 className="font-medium">{preparationTitle}</h4>
      <ul className="clinmesh-inpatient-preparation-list">{[
        { key: 'consent', title: t('手术知情同意书已签', 'Signed surgical consent'), owner: t('住院医生', 'Inpatient doctor'), record: row.consentConfirmation },
        { key: 'preop', title: t('术前核对', 'Preoperative checks'), owner: t('病区护士', 'Ward nurse'), record: row.preopCheck },
      ].map(item => <li key={item.key} data-complete={!!item.record}>
        {item.record ? <CheckCircle2Icon aria-hidden="true" /> : <CircleIcon aria-hidden="true" />}
        <div><strong>{item.title}</strong><span className="text-xs text-muted-foreground">{item.record ? t('已完成', 'Completed') : t('待完成', 'Pending')}</span></div>
        <div className="clinmesh-inpatient-preparation-owner"><span>{item.owner}</span>{item.record ? <time dateTime={item.record.recordedAt}>{new Date(item.record.recordedAt).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })}</time> : null}
          {item.key === 'consent' && doctor && active && focused && !item.record && panel !== 'consent' ? <Button variant="outline" size="sm" disabled={blocked} onClick={() => setPanel('consent')}>{t('确认已签', 'Confirm signed')}</Button> : null}</div>
        {item.record ? <p className="col-span-2 col-start-2 text-xs text-muted-foreground">{t('说明：', 'Note: ')}{item.record.note}</p> : null}
        {item.key === 'consent' && panel === 'consent' && !item.record ? <Field className="col-span-2 col-start-2"><FieldLabel htmlFor={`surgery-consent-${row.id}`}>{t('签署说明','Consent note')}</FieldLabel><Input id={`surgery-consent-${row.id}`} autoFocus maxLength={2000} disabled={blocked} value={consentNote} onChange={event => setConsentNote(event.currentTarget.value)} /></Field> : null}
        {item.key === 'preop' && nurse && active && !item.record ? <FieldGroup className="col-span-2 col-start-2"><Field><FieldLabel htmlFor={`surgery-preop-${row.id}`}>{t('术前核对说明','Preoperative check note')}</FieldLabel><Input id={`surgery-preop-${row.id}`} maxLength={2000} disabled={blocked} value={preopNote} onChange={event => setPreopNote(event.currentTarget.value)} /></Field>
          <Button className="self-start" aria-busy={pending('inpatient.surgery.check-preop') || undefined} data-busy={pending('inpatient.surgery.check-preop') || undefined} data-unavailable={!write.mutation.isPending && (blocked || !preopNote.trim()) || undefined}
            disabled={blocked || !preopNote.trim()} onClick={() => write.mutation.mutate({ operation:'inpatient.surgery.check-preop', input: { ...common, note: preopNote.trim() } })}>{pending('inpatient.surgery.check-preop') ? <Spinner aria-hidden="true" data-icon="inline-start" /> : null}{pending('inpatient.surgery.check-preop') ? t('正在术前核对', 'Recording preoperative checks') : t('术前核对','Record preoperative checks')}</Button></FieldGroup> : null}
      </li>)}</ul>
    </section>
    {doctor && active && focused ? <InpatientPrimaryAction stage="surgery" priority={bar.priority} fallback={bar.action}><WorkspaceActionBar summary={row.plannedProcedure.coding.display} tone={bar.tone} reason={bar.reason} action={bar.action} /></InpatientPrimaryAction> : null}
    {doctor && active ? <>
      <Dialog open={panel === 'start'} onOpenChange={open => { if (!open && !write.mutation.isPending) setPanel(null) }}>
        <DialogContent className="sm:max-w-[480px]"><DialogHeader><DialogTitle>{t('开始手术', 'Start surgery')}</DialogTitle>
          <DialogDescription>{t('开始时不登记耗材、不收术式费。', 'Starting records no materials or procedure fee.')}{actual ? `${t('术式费 ', ' Procedure fee ')}${formatFen(actual.chargeDefinition.priceFen, locale)}${t(' 在完成手术时计入。', ' is posted at completion.')}` : null}</DialogDescription></DialogHeader>
          <form className="flex min-h-0 flex-col p-0" onSubmit={event => { event.preventDefault(); start() }}>
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4"><InpatientWriteRecovery write={write} locale={locale} />
              <FieldSet disabled={blocked}><FieldGroup>{actualField}
                <Field><FieldLabel htmlFor={`surgery-start-${row.id}`}>{t('开始说明','Start note')}</FieldLabel><Input id={`surgery-start-${row.id}`} maxLength={2000} value={startNote} onChange={event => setStartNote(event.currentTarget.value)} /></Field>
              </FieldGroup></FieldSet></div>
            <OrderComposerFooter hint={startNote.trim() ? t('开始后在本页逐笔登记耗材', 'Record materials on this page after starting') : t('还差：开始说明', 'Enter the start note')}>
              <DialogClose disabled={write.mutation.isPending} render={<Button type="button" variant="outline" />}>{t('取消', 'Cancel')}</DialogClose>
              <Button type="submit" aria-busy={pending('inpatient.surgery.start') || undefined} disabled={blocked || !ready || !actual || !startNote.trim()}>{pending('inpatient.surgery.start') ? <Spinner aria-hidden="true" data-icon="inline-start" /> : null}{t('开始手术', 'Start surgery')}</Button>
            </OrderComposerFooter></form>
        </DialogContent></Dialog>
      <Dialog open={panel === 'batch'} onOpenChange={open => { if (!open && !write.mutation.isPending) setPanel(null) }}>
        <DialogContent className="sm:max-w-[640px]"><DialogHeader><DialogTitle>{t('整台补录', 'Record entire surgery')}</DialogTitle>
          <DialogDescription>{t('一次提交实际术式和全部耗材，用于术后补录；提交后手术即完成。', 'Submit the performed procedure and all materials at once; the surgery is completed on submission.')}</DialogDescription></DialogHeader>
          <form className="flex min-h-0 flex-col p-0" onSubmit={event => { event.preventDefault(); execute() }}>
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4"><InpatientWriteRecovery write={write} locale={locale} />
              <FieldSet disabled={blocked}><FieldGroup>{actualField}
                <Field><FieldLabel htmlFor={`surgery-material-select-${row.id}`}>{t('手术耗材','Surgical material')}</FieldLabel>
                  <WorkspaceSelect id={`surgery-material-select-${row.id}`} value={null} placeholder={t('选择实际使用耗材（最多20项）','Select materials used (up to 20)')}
                    items={materialValues.length >= 20 ? [] : materials.filter(item => quantities[item.id] === undefined).map(item => ({ value: item.id, label: item.display }))}
                    onValueChange={id => { if (id) setQuantities(previous => ({ ...previous, [id]: '1' })) }} />
                  {unavailableCount > 0 ? <FieldDescription>{t(`${unavailableCount} 项耗材因计价单位未确认而未启用`,`${unavailableCount} materials are unavailable because their billing unit is unconfirmed`)}</FieldDescription> : null}
                </Field>
                {materialValues.map(({item}) => <Field key={item.id}><FieldLabel htmlFor={`surgery-material-${row.id}-${item.id}`}>{item.display}{t('实际用量',' quantity used')}</FieldLabel><Input id={`surgery-material-${row.id}-${item.id}`} type="number" min="0" max="1000" step="1" disabled={!!reservationIds[item.id]} value={quantities[item.id] ?? '0'} onChange={event => setQuantities(previous => ({...previous,[item.id]:event.currentTarget.value}))} /><FieldDescription>{formatFen(item.chargeDefinition.priceFen,locale)}/{item.chargeDefinition.unit}</FieldDescription>
                  <FieldLabel htmlFor={`surgery-reservation-${row.id}-${item.id}`}>{t('替换治疗预留','Replace treatment reservation')}</FieldLabel><WorkspaceSelect id={`surgery-reservation-${row.id}-${item.id}`} value={reservationIds[item.id] ?? ''} items={[{ value: '', label: t('独立记录实际使用','Record separate actual use') }, ...reservations.filter(value => value.status === 'reserved' && value.materialId === item.id && (!value.requestId || value.requestId === row.id)).map(value => ({ value: value.id, label: `${value.materialDisplay} × ${value.quantity} · ${value.reason}` }))]} onValueChange={id => { setReservationIds(previous => ({ ...previous, [item.id]: id ?? '' })); const reservation = reservations.find(value => value.id === id); if (reservation) setQuantities(previous => ({ ...previous, [item.id]: String(reservation.quantity) })) }} />
                  <Button type="button" variant="outline" className="self-start" aria-label={`${t('移除耗材','Remove material')} ${item.display}`} onClick={() => { setQuantities(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== item.id))); setReservationIds(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== item.id))) }}>{t('移除','Remove')}</Button>
                </Field>)}
                <Field><FieldLabel htmlFor={`surgery-batch-${row.id}`}>{t('补录依据','Record basis')}</FieldLabel><Input id={`surgery-batch-${row.id}`} maxLength={2000} value={batchNote} onChange={event => setBatchNote(event.currentTarget.value)} /></Field>
              </FieldGroup></FieldSet></div>
            <OrderComposerFooter hint={batchNote.trim() ? t('提交后计入耗材与术式费，手术完成', 'Submission posts materials and the procedure fee and completes surgery') : t('还差：补录依据', 'Enter the record basis')}>
              <DialogClose disabled={write.mutation.isPending} render={<Button type="button" variant="outline" />}>{t('取消', 'Cancel')}</DialogClose>
              <Button type="submit" disabled={blocked || !ready || !actual || !batchNote.trim() || !quantitiesValid}>{t('记录实际手术','Record performed surgery')}</Button>
            </OrderComposerFooter></form>
        </DialogContent></Dialog>
    </> : null}
  </article>
}
