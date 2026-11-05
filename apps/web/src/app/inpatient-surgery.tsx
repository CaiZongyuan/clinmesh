import { InpatientSurgeryMaterials, SurgeryDrgLink } from './inpatient-surgery-materials.tsx'
import { InpatientPciSelection } from './inpatient-pci-selection.tsx'
import { InpatientMaterialEstimates } from './inpatient-material-estimate.tsx'
import { InpatientGuidelineAdvicePanel } from './inpatient-guideline-advice.tsx'
import { InpatientMaterialReservations } from './inpatient-surgery-reservations.tsx'
import { InpatientDrgReviewPanel } from './inpatient-drg-review.tsx'
import { inpatientPciSelectionSchema, pciSelectionProcedureCodes } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientMaterialEstimatesSchema, inpatientMaterialEstimateSaveInputSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientGuidelineAdviceListSchema } from '@clinmesh/contracts/inpatient-guideline-advice'
import { z } from 'zod'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema, type inpatientSurgeryExecutionSchema, type inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientMaterialReservationListSchema, type InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Spinner } from '@clinmesh/ui/components/spinner'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { cn } from '@clinmesh/ui/lib/utils'
import { useQuery } from '@tanstack/react-query'
import { useLayoutEffect, useRef, useState } from 'react'
import { apiGet } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen, formatShanghaiMinute } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { WorkspaceActionBar } from './workspace-card-layout.tsx'
import { OrderComposerFooter } from './doctor/order-composer-layout.tsx'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { CheckCircle2Icon, CircleIcon, PlusIcon, SparklesIcon } from 'lucide-react'
import { InpatientDrgUsagePanel } from './inpatient-drg-usage.tsx'

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
  const [stepView, setStepView] = useState<1 | 2 | 3>(3)
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
  const estimatePlans = surgery.data?.requests.filter(row => ['requested', 'ready'].includes(row.status)) ?? []
  const pendingPlans = estimatePlans.filter(row => !running.some(execution => execution.requestId === row.id))
  const selectedPlan = pendingPlans.find(row => row.id === selectedRequestId) ?? pendingPlans[0] ?? estimatePlans[0]
  const preoperative = running.length === 0 ? pendingPlans.length > 0 : assessmentOpen && estimatePlans.length > 0
  const latest = running.length === 0 && pendingPlans.length === 0 ? surgery.data?.executions.at(-1) : undefined
  const plans = <>
    {pendingPlans.length > 1 ? <Field><FieldLabel htmlFor="current-surgery-plan">{t('当前计划', 'Current plan')}</FieldLabel><WorkspaceSelect id="current-surgery-plan" value={selectedPlan?.id ?? null} disabled={write.blocked}
      items={pendingPlans.map(row => ({ value: row.id, label: `${row.plannedProcedure.coding.display} · ${row.reason}` }))} onValueChange={setSelectedRequestId} /></Field> : null}
    {pendingPlans.map(row => <div key={row.id} hidden={row.id !== selectedPlan?.id || running.length > 0 && !otherPlansOpen}><SurgeryRequest row={row} catalog={catalog.data} reservations={reservationRows}
      admission={admission} session={session} locale={locale} write={write} focused={row.id === selectedPlan?.id && (running.length === 0 || otherPlansOpen)} /></div>)}
  </>
  const estimate = reservationRows.filter(item => item.status === 'reserved' && (!item.requestId || item.requestId === selectedPlan?.id))
  const currentStep: 1 | 2 | 3 | 4 | 5 = running.length > 0 ? 4 : latest ? 5 : stepView
  const showSteps = doctor && ((surgery.data?.requests.length ?? 0) > 0 || (surgery.data?.executions.length ?? 0) > 0 || running.length > 0)
  const earlierExecutions = (surgery.data?.executions.length ?? 0) > 1 ? surgery.data!.executions.slice(0, -1) : []
  const latestRequest = latest ? surgery.data?.requests.find(item => item.id === latest.requestId) : undefined
  return <section aria-label={t('住院手术','Inpatient surgery')} className="flex flex-col gap-4">
    {error ? <Alert variant="destructive"><AlertDescription>{t('手术资料读取失败：', 'Surgery records failed to load: ')}{getWorkspaceErrorMessage(error,getWorkspaceMessages(locale))}<Button variant="outline" size="sm" onClick={() => { void surgery.refetch(); void catalog.refetch(); if (doctor) void reservations.refetch() }}>{t('重试手术资料', 'Retry surgery records')}</Button></AlertDescription></Alert> : null}
    {surgery.isPending ? <Skeleton className="h-24 w-full" /> : null}
    {showSteps ? <SurgeryStepBar currentStep={currentStep} canSelectPreop={running.length === 0 && pendingPlans.length > 0} hasReserved={estimate.length > 0} locale={locale} onSelectStep={setStepView} /> : null}
    {running.map(execution => {
      const plan = surgery.data?.requests.find(row => row.id === execution.requestId)
      return plan ? <InpatientSurgeryMaterials key={execution.id} admission={admission} session={session} locale={locale} write={write}
        execution={execution} request={plan} catalog={catalog.data} reservations={reservationRows} running onOpenDrg={openDrg} refresh={refresh} /> : null
    })}
    {running.length === 0 && pendingPlans.length > 0 && selectedPlan && stepView === 1 ? <PciStepOnePanel admission={admission} session={session} plan={selectedPlan} locale={locale} write={write} blocked={blocked} onNext={() => setStepView(2)} /> : null}
    {running.length === 0 && pendingPlans.length > 0 && selectedPlan && stepView === 2 ? <PciStepTwoPanel admission={admission} session={session} plan={selectedPlan} reservations={reservationRows} encounterVersion={reservations.data?.encounterVersion} reservationFingerprint={reservations.data?.reservationSets.find(set => set.requestId === selectedPlan.id)?.fingerprint} locale={locale} write={write} blocked={blocked} onBackToStepOne={() => setStepView(1)} onNext={() => setStepView(3)} onOpenDrg={openDrg} /> : null}
    {pendingPlans.length > 0 && (running.length > 0 || stepView === 3) ? running.length > 0 ? <details className="clinmesh-inpatient-disclosure" onToggle={event => setOtherPlansOpen(event.currentTarget.open)}><summary>{t('其他待实施手术', 'Other planned procedures')}</summary><div className="flex flex-col gap-4 py-3">{plans}</div></details> : <>
      {doctor && selectedPlan ? <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span><strong>{t('第 ① 步（选型参数）：', 'Step 1 (Selection): ')}</strong>{pciSelectionProcedureCodes.includes(selectedPlan.plannedProcedure.coding.code) ? t('可在术前确认造影带入的靶血管与病变测量参数', 'Confirm angiography vessel and lesion parameters') : t('常规手术无需冠脉选型参数', 'Standard procedure')}</span>
          <span><strong>{t('第 ② 步（手术耗材）：', 'Step 2 (Materials): ')}</strong>{estimate.length > 0 ? `${t('已锁定预留 ', 'Reserved ')}${estimate.length}${t(' 项（', ' items (')}${formatFen(estimate.reduce((sum, item) => sum + item.priceFen * (item.remainingQuantity ?? item.quantity - item.consumedQuantity), 0), locale)}）` : t('尚未锁定耗材预留', 'No materials reserved yet')}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => setStepView(1)}>{t('查看第①步', 'View Step 1')}</Button>
          <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => setStepView(2)}>{t('查看第②步', 'View Step 2')}</Button>
        </div>
      </div> : null}
      {plans}
    </> : null}
    {preoperative && (running.length > 0 || stepView === 3) ? <section aria-label={t('术前耗材预计', 'Preoperative material estimate')} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{t('术前耗材预计', 'Preoperative material estimate')}</h4>
        {doctor && running.length === 0 ? <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs text-info" onClick={() => setStepView(2)}>{t('前往第②步核对耗材 ›', 'Go to Step 2 materials ›')}</Button> : null}
      </div>
      <p className="text-xs text-muted-foreground">{estimate.length > 0 ? `${t('已确认为本计划预留：', 'Reserved for this plan: ')}${estimate.map(item => `${item.materialDisplay} ${item.remainingQuantity ?? item.quantity - item.consumedQuantity}${item.unit ?? ''}`).join('、')}。` : t('尚未预留耗材。', 'No materials reserved yet.')}{t('预留只用于费用预计；实际用量在术中逐笔登记。', ' Reservations only inform estimates; actual use is recorded during surgery.')}</p>
      <details className="clinmesh-inpatient-disclosure" onToggle={event => setAssessmentOpen(event.currentTarget.open)}><summary onClick={event => { if (write.mutation.isPending) event.preventDefault() }}>{t('查看与调整', 'Review and adjust')}</summary><div className="flex flex-col gap-4 py-3">
        <InpatientPciSelection admission={admission} session={session} locale={locale} write={write} active={active && assessmentOpen} />
        <InpatientMaterialEstimates admission={admission} session={session} locale={locale} write={write} requests={surgery.data?.requests ?? []} active={active && assessmentOpen}
          inProgressRequestIds={running.map(execution => execution.requestId)} />
        {doctor ? estimatePlans.filter(row => pciSelectionProcedureCodes.includes(row.plannedProcedure.coding.code)).map(row =>
          <section key={`guideline-${row.id}`} aria-label={`${t('PCI 计划参考', 'PCI plan reference')}：${row.plannedProcedure.coding.display} · ${row.reason}`} className="flex min-w-0 flex-col gap-2">
            <p className="text-sm font-medium">{row.plannedProcedure.coding.display} · {row.reason}</p>
            <InpatientGuidelineAdvicePanel admission={admission} session={session} locale={locale} write={write} requestId={row.id} active={active && assessmentOpen}
              canReassess={active && assessmentOpen && admission.status === 'admitted' && admission.recordStatus !== 'archived' && ['requested', 'ready'].includes(row.status)
                && !running.some(execution => execution.requestId === row.id)} />
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
    {latest && latestRequest ? <details className="clinmesh-inpatient-disclosure"><summary>{t('术后耗材更正与历史', 'Postoperative material corrections and history')} · {latest.actualProcedure.coding.display}</summary>
      <InpatientSurgeryMaterials admission={admission} session={session} locale={locale} write={write} execution={latest} request={latestRequest} catalog={catalog.data} reservations={reservationRows} running={false} refresh={refresh} />
    </details> : null}
    {earlierExecutions.length > 0 ? <details className="clinmesh-inpatient-disclosure"><summary>{t(`展开同次住院前序手术记录（${earlierExecutions.length} 台：${earlierExecutions.map(item => `${item.actualProcedure.coding.code} ${item.actualProcedure.coding.display}`).join('、')}）`, `Expand earlier surgeries in this admission (${earlierExecutions.length})`)}</summary><div className="flex flex-col gap-3 py-3">
      {earlierExecutions.map(execution => {
        const req = surgery.data?.requests.find(item => item.id === execution.requestId)
        return <article key={execution.id} className="flex flex-col gap-2 rounded-md border p-3">
          <p className="font-medium">{execution.actualProcedure.coding.code} · {execution.actualProcedure.coding.display}</p>
          <p className="text-xs text-muted-foreground tabular-nums">{formatShanghaiMinute(execution.performedAt)} · {execution.note}</p>
          {req ? <InpatientSurgeryMaterials admission={admission} session={session} locale={locale} write={write} execution={execution} request={req} catalog={catalog.data} reservations={reservationRows} running={false} refresh={refresh} /> : null}
        </article>
      })}
    </div></details> : null}
    {surgery.data?.requests.some(row => ['completed', 'cancelled'].includes(row.status)) ? <details className="clinmesh-inpatient-disclosure"><summary>{t('已完成与已取消的手术计划', 'Completed and cancelled plans')}</summary><div className="flex flex-col gap-3 py-3">
      {surgery.data.requests.filter(row => ['completed', 'cancelled'].includes(row.status)).map(row => <SurgeryRequest key={row.id} row={row} catalog={catalog.data} reservations={reservationRows} admission={admission} session={session} locale={locale} write={write} focused={false} />)}
    </div></details> : null}
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

function SurgeryStepBar({ currentStep, canSelectPreop, hasReserved, locale, onSelectStep }: {
  currentStep: 1 | 2 | 3 | 4 | 5
  canSelectPreop: boolean
  hasReserved: boolean
  locale: WorkspaceLocale
  onSelectStep: (step: 1 | 2 | 3) => void
}) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const steps: Array<{ step: 1 | 2 | 3 | 4 | 5; label: string }> = [
    { step: 1, label: t('① 选型参数', '1. Selection') },
    { step: 2, label: t('② 手术耗材', '2. Materials') },
    { step: 3, label: t('③ 术前核对', '3. Pre-op check') },
    { step: 4, label: t('④ 术中执行', '4. In progress') },
    { step: 5, label: t('⑤ 术后完成', '5. Completed') },
  ]
  return <nav aria-label={t('手术办理步骤', 'Surgery workflow steps')} className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
    {steps.map((item, index) => {
      const active = currentStep === item.step
      const done = currentStep > item.step || (item.step === 2 && hasReserved && currentStep === 3)
      const clickable = canSelectPreop && (item.step === 1 || item.step === 2 || item.step === 3)
      return <div key={item.step} className="flex items-center gap-1.5">
        {index > 0 ? <span aria-hidden="true" className="text-muted-foreground">—</span> : null}
        {clickable ? <button type="button" aria-current={active ? 'step' : undefined} onClick={() => onSelectStep(item.step as 1 | 2 | 3)}
          className={cn('inline-flex items-center gap-1 rounded-md border px-2.5 py-1 font-medium transition-colors', active ? 'border-info bg-info text-info-foreground' : done ? 'border-success/40 bg-success/10 text-success hover:bg-success/15' : 'border-border bg-background text-muted-foreground hover:bg-accent')}>
          {item.label}
        </button> : <span aria-current={active ? 'step' : undefined}
          className={cn('inline-flex items-center gap-1 rounded-md border px-2.5 py-1 font-medium', active ? 'border-info bg-info text-info-foreground' : done ? 'border-success/40 bg-success/10 text-success' : 'border-border bg-background text-muted-foreground')}>
          {item.label}
        </span>}
      </div>
    })}
  </nav>
}

function PciStepOnePanel({ admission, session, plan, locale, write, blocked, onNext }: {
  admission: InpatientAdmission
  session: SessionContext
  plan: Request
  locale: WorkspaceLocale
  write: ReturnType<typeof useInpatientWriteIntent>
  blocked: boolean
  onNext: () => void
}) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const scope = ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id]
  const selection = useQuery({ queryKey: [...scope, 'pci-selection'], retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/pci-selection`, inpatientPciSelectionSchema, signal) })
  const draft = selection.data?.drafts?.find(item => item.requestId === plan.id)
  const confirmed = selection.data?.confirmation?.parameters.requestId === plan.id ? selection.data.confirmation.parameters : undefined
  const base = draft?.parameters ?? confirmed
  const [targetSite, setTargetSite] = useState<string | null>(null)
  const [treatmentPlan, setTreatmentPlan] = useState<string | null>(null)
  const [lesionLength, setLesionLength] = useState<string | null>(null)
  const [proximalDiameter, setProximalDiameter] = useState<string | null>(null)
  const [distalDiameter, setDistalDiameter] = useState<string | null>(null)
  const siteValue = targetSite ?? base?.targetSite ?? 'LAD 中段'
  const planValue = treatmentPlan ?? base?.treatmentPlan ?? `${plan.plannedProcedure.coding.display} · ${plan.reason}`
  const findMeasurement = (kind: 'lesion-length' | 'proximal-reference-diameter' | 'distal-reference-diameter', fallback: number) =>
    base?.measurements.find(item => item.kind === kind)?.value ?? fallback
  const lengthVal = lesionLength ?? String(findMeasurement('lesion-length', 12))
  const proxVal = proximalDiameter ?? String(findMeasurement('proximal-reference-diameter', 3.0))
  const distVal = distalDiameter ?? String(findMeasurement('distal-reference-diameter', 3.0))
  const valid = siteValue.trim().length > 0 && planValue.trim().length > 0 && Number(lengthVal) > 0 && Number(proxVal) > 0 && Number(distVal) > 0
  const saveAndNext = async () => {
    if (!valid || blocked) return
    const defaultSource = base?.measurements[0]?.source ?? { reference: `DiagnosticReport/${draft?.reportId ?? 'report-1'}`, version: String(draft?.reportVersion ?? 1), note: t('医生按造影或实测填写', 'Entered by doctor'), synthetic: true as const }
    const buildMeasurement = (kind: 'lesion-length' | 'proximal-reference-diameter' | 'distal-reference-diameter', num: number) => {
      const existing = base?.measurements.find(item => item.kind === kind)
      return {
        kind,
        object: (kind === 'lesion-length' ? 'lesion' : 'reference-lumen') as 'lesion' | 'reference-lumen',
        site: siteValue.trim(),
        value: num,
        unit: 'mm',
        method: existing?.method ?? t('造影定量测量', 'QCA measurement'),
        source: existing?.source ?? defaultSource,
      }
    }
    const parameters = {
      requestId: plan.id,
      treatmentPlan: planValue.trim(),
      targetSite: siteValue.trim(),
      measurements: [
        buildMeasurement('lesion-length', Number(lengthVal)),
        buildMeasurement('proximal-reference-diameter', Number(proxVal)),
        buildMeasurement('distal-reference-diameter', Number(distVal)),
      ],
      plannedQuantities: base?.plannedQuantities.length ? base.plannedQuantities : [
        { category: 'guiding-catheter' as const, quantity: 1, basis: t('有限合成单病变方案', 'Single-lesion protocol') },
        { category: 'guidewire' as const, quantity: 1, basis: t('有限合成单病变方案', 'Single-lesion protocol') },
        { category: 'balloon' as const, quantity: 1, basis: t('有限合成单病变方案', 'Single-lesion protocol') },
        { category: 'stent' as const, quantity: 1, basis: t('有限合成单病变方案', 'Single-lesion protocol') },
      ],
      approvedMaterialIds: base?.approvedMaterialIds ?? (selection.data?.candidates ?? []).filter(item => item.eligibility === 'valid').map(item => item.materialId),
    }
    if (draft) {
      await write.mutation.mutateAsync({ operation: 'inpatient.pci-selection.save', input: { admissionId: admission.id, requestId: plan.id, expectedDraftVersion: draft.version, parameters } }).catch(() => undefined)
    }
    onNext()
  }
  const primaryButton = <Button disabled={blocked || !valid || write.mutation.isPending} onClick={() => { void saveAndNext() }}>{t('确认选型参数，去核对耗材 ›', 'Confirm parameters & review materials ›')}</Button>
  return <section aria-label={t('第 ① 步：确认 PCI 选型参数', 'Step 1: Confirm PCI selection parameters')} className="flex flex-col gap-3 rounded-lg border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h4 className="font-semibold">{t('第 ① 步：确认 PCI 选型参数', 'Step 1: Confirm PCI selection parameters')}</h4>
        <p className="text-xs text-muted-foreground">{t('轮到你：确认造影带入的靶血管与病变测量参数，确认后进入第 ② 步核对助手生成的手术耗材清单', 'Your turn: confirm the target vessel and lesion measurements, then proceed to Step 2 to review the material list')}</p>
      </div>
      {draft ? <Badge variant="outline" className="border-info/40 text-info"><SparklesIcon aria-hidden="true" className="mr-1 size-3" />{t('造影报告带入', 'Copied from angiography report')}</Badge> : null}
    </div>
    <FieldSet disabled={blocked}><FieldGroup className="grid gap-3 md:grid-cols-2">
      <Field>
        <FieldLabel htmlFor="pci-step1-target-site">{t('靶血管部位', 'Target vessel site')}</FieldLabel>
        <Input id="pci-step1-target-site" className="border-dashed border-info/50 bg-info/5" value={siteValue} onChange={event => setTargetSite(event.currentTarget.value)} />
      </Field>
      <Field>
        <FieldLabel htmlFor="pci-step1-treatment-plan">{t('治疗方案说明', 'Treatment plan note')}</FieldLabel>
        <Input id="pci-step1-treatment-plan" value={planValue} onChange={event => setTreatmentPlan(event.currentTarget.value)} />
      </Field>
      <div className="grid gap-3 md:col-span-2 md:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="pci-step1-lesion-length">{t('病变长度 (mm)', 'Lesion length (mm)')}</FieldLabel>
          <Input id="pci-step1-lesion-length" type="number" step="0.1" min="0.1" className="border-dashed border-info/50 bg-info/5 tabular-nums" value={lengthVal} onChange={event => setLesionLength(event.currentTarget.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="pci-step1-proximal-diameter">{t('近端参考管径 (mm)', 'Proximal reference diameter (mm)')}</FieldLabel>
          <Input id="pci-step1-proximal-diameter" type="number" step="0.1" min="0.1" className="border-dashed border-info/50 bg-info/5 tabular-nums" value={proxVal} onChange={event => setProximalDiameter(event.currentTarget.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="pci-step1-distal-diameter">{t('远端参考管径 (mm)', 'Distal reference diameter (mm)')}</FieldLabel>
          <Input id="pci-step1-distal-diameter" type="number" step="0.1" min="0.1" className="border-dashed border-info/50 bg-info/5 tabular-nums" value={distVal} onChange={event => setDistalDiameter(event.currentTarget.value)} />
        </Field>
      </div>
    </FieldGroup></FieldSet>
    <InpatientPrimaryAction stage="surgery" priority={45} fallback={primaryButton}>
      <WorkspaceActionBar tone="assistant" summary={`${t('已带入造影测量：', 'Angiography measurements: ')}${siteValue} · ${t('长度', 'length')} ${lengthVal} mm · ${t('近端', 'proximal')} ${proxVal} mm · ${t('远端', 'distal')} ${distVal} mm`} action={primaryButton} />
    </InpatientPrimaryAction>
  </section>
}

function PciStepTwoPanel({ admission, session, plan, reservations, encounterVersion, reservationFingerprint, locale, write, blocked, onBackToStepOne, onNext, onOpenDrg }: {
  admission: InpatientAdmission
  session: SessionContext
  plan: Request
  reservations: InpatientMaterialReservation[]
  encounterVersion: string | undefined
  reservationFingerprint: string | undefined
  locale: WorkspaceLocale
  write: ReturnType<typeof useInpatientWriteIntent>
  blocked: boolean
  onBackToStepOne: () => void
  onNext: () => void
  onOpenDrg: (() => void) | undefined
}) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const scope = ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id]
  const estimates = useQuery({ queryKey: [...scope, 'material-estimates'], retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/material-estimates`, inpatientMaterialEstimatesSchema, signal) })
  const selection = useQuery({ queryKey: [...scope, 'pci-selection'], retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/pci-selection`, inpatientPciSelectionSchema, signal) })
  const guidelines = useQuery({ queryKey: [...scope, 'guideline-advice'], retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/guideline-advice`, inpatientGuidelineAdviceListSchema, signal) })
  const estimate = estimates.data?.estimates.find(item => item.requestId === plan.id)
  const draft = selection.data?.drafts?.find(item => item.requestId === plan.id)
  const advice = guidelines.data?.advice.find(item => item.requestId === plan.id)
  const [items, setItems] = useState<Array<{ materialId: string; catalogVersion: number; quantity: string; reason: string }> | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [reviewed, setReviewed] = useState(false)
  const [ignoringCandidates, setIgnoringCandidates] = useState(false)
  const currentItems = items ?? (estimate?.draft?.items ?? []).map(item => ({ ...item, quantity: String(item.quantity) }))
  const currentNote = note ?? estimate?.draft?.note ?? ''
  const candidates = estimate?.candidates ?? []
  const eligible = candidates.filter(candidate => candidate.eligibility === 'valid' && candidate.item !== null)
  const activeReservations = reservations.filter(item => item.requestId === plan.id && item.status === 'reserved')
  const loading = estimate?.status === 'queued' || estimate?.status === 'running'
  const hasCandidateDiff = !ignoringCandidates && (estimate?.candidateItems.length ?? 0) > 0
  const totalMaterialFen = currentItems.reduce((sum, item) => {
    const candidate = candidates.find(c => c.materialId === item.materialId && c.catalogVersion === item.catalogVersion)
    const price = candidate?.item?.chargeDefinition.priceFen ?? 0
    return sum + price * (Number(item.quantity) || 0)
  }, 0)
  const saveAndConfirm = async () => {
    if (!estimate || blocked || !reviewed) return
    const saveParsed = inpatientMaterialEstimateSaveInputSchema.safeParse({
      admissionId: admission.id,
      requestId: plan.id,
      expectedVersion: estimate.version,
      expectedDraftRevision: estimate.draft?.revision ?? 0,
      expectedBasisFingerprint: estimate.basisFingerprint,
      analysisId: estimate.draft?.analysisId ?? estimate.analysis?.id ?? null,
      items: currentItems.map(item => ({ ...item, quantity: Number(item.quantity) })),
      note: currentNote,
    })
    if (saveParsed.success && items !== null) {
      await write.mutation.mutateAsync({ operation: 'inpatient.material-estimate.save', input: saveParsed.data }).catch(() => undefined)
    }
    if (encounterVersion && reservationFingerprint && estimate.draft) {
      await write.mutation.mutateAsync({
        operation: 'inpatient.material-estimate.confirm',
        input: {
          admissionId: admission.id,
          requestId: plan.id,
          expectedVersion: estimate.version,
          expectedDraftRevision: estimate.draft.revision,
          expectedBasisFingerprint: estimate.basisFingerprint,
          expectedRequestVersion: estimate.requestVersion,
          encounterVersion,
          expectedReservationFingerprint: reservationFingerprint,
          reason: currentNote || t('医生已核对整批预计耗材及原预留处理', 'Doctor reviewed the material estimate and reservation changes'),
        },
      }).catch(() => undefined)
    }
    onNext()
  }
  const confirmBtn = <Button disabled={blocked || !reviewed || loading || currentItems.length === 0} onClick={() => { void saveAndConfirm() }}>{t('确认耗材清单并锁定预留 ›', 'Confirm material list & lock reservations ›')}</Button>
  return <section aria-label={t('第 ② 步：核对手术耗材清单与预留', 'Step 2: Review surgical material list & reservations')} className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
      <span><strong>{t('第 ① 步已确认：', 'Step 1 confirmed: ')}</strong>{draft?.parameters.targetSite ?? 'LAD 中段'} · {plan.plannedProcedure.coding.display}</span>
      <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onBackToStepOne}>{t('修改选型参数', 'Edit selection parameters')}</Button>
    </div>
    <div className="rounded-lg border border-info/30 bg-info/5 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span><strong className="text-info">{t('指南参考', 'Guideline reference')}</strong> · {t('支架类别：DES 优先于 BMS · 腔内影像：左主干或复杂病变可考虑 IVUS/OCT · 测量要求：核对近远端参考管径与病变长度', 'Stent category: DES preferred · Intravascular imaging: consider IVUS/OCT for complex lesions · Verify proximal/distal diameters and length')}</span>
      </div>
      {advice?.result ? <details className="mt-1"><summary className="cursor-pointer text-info">{t('展开指南原文摘录与核验局限（只读）', 'Expand guideline quotes and verification limitations (read only)')}</summary>
        <div className="mt-1.5 flex flex-col gap-1 text-muted-foreground">
          {advice.result.conclusions.map(item => <p key={item.kind}>{item.text}</p>)}
          {advice.result.limitations.map(limitation => <p key={limitation}>{limitation}</p>)}
        </div>
      </details> : null}
    </div>
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="font-semibold">{t('手术耗材清单', 'Surgical material list')}</h4>
          <Badge variant="outline" className="border-info/40 text-info"><SparklesIcon aria-hidden="true" className="mr-1 size-3" />{loading ? t('正在生成并核验…', 'Generating & verifying…') : t('助手草稿 · 含独立核验', 'Assistant draft · verified')}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {loading && estimate ? <Button type="button" variant="outline" size="sm" disabled={blocked} onClick={() => write.mutation.mutate({ operation: 'inpatient.material-estimate.cancel', input: { admissionId: admission.id, requestId: plan.id, expectedRequestVersion: estimate.requestVersion, expectedVersion: estimate.version, expectedBasisFingerprint: estimate.basisFingerprint } })}>{t('取消本次预计', 'Cancel estimate')}</Button>
            : estimate ? <>
              <Button type="button" variant="outline" size="sm" disabled={blocked || eligible.length === 0} onClick={() => { setReviewed(false); setItems(eligible.map(c => ({ materialId: c.materialId, catalogVersion: c.catalogVersion, quantity: String(c.expectedQuantity ?? 1), reason: c.quantityBasis }))) }}>{t('从院内标准方案带入', 'Use verified hospital plan')}</Button>
              <Button type="button" variant="outline" size="sm" disabled={blocked} onClick={() => write.mutation.mutate({ operation: 'inpatient.material-estimate.request', input: { admissionId: admission.id, requestId: plan.id, expectedRequestVersion: estimate.requestVersion, expectedVersion: estimate.version, expectedBasisFingerprint: estimate.basisFingerprint } })}>{t('重新生成 AI 预计', 'Re-estimate with AI')}</Button>
            </> : null}
        </div>
      </div>
      {hasCandidateDiff && estimate ? <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs">
        <span className="font-medium text-warning">{t('选型参数已更新 · 助手已重算候选耗材，请核对是否替换你修改过的行', 'Selection parameters updated · Assistant recalculated candidate materials')}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => setIgnoringCandidates(true)}>{t('忽略候选保留当前', 'Ignore & keep current')}</Button>
          <Button type="button" size="sm" className="h-6 px-2 text-xs" onClick={() => { setReviewed(false); setIgnoringCandidates(true); setItems(estimate.candidateItems.map(item => ({ materialId: item.materialId, catalogVersion: item.catalogVersion, quantity: String(item.quantity), reason: item.reason }))) }}>{t('整批采用新候选', 'Adopt new candidates')}</Button>
        </div>
      </div> : null}
      {loading ? <div role="status" className="flex flex-col gap-2 py-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div> : <Table>
        <TableHeader><TableRow>
          <TableHead>{t('耗材名称与规格', 'Material & specification')}</TableHead>
          <TableHead>{t('来源与匹配依据', 'Source & basis')}</TableHead>
          <TableHead className="text-right">{t('单价', 'Unit price')}</TableHead>
          <TableHead>{t('数量', 'Quantity')}</TableHead>
          <TableHead className="text-right">{t('小计', 'Subtotal')}</TableHead>
          <TableHead className="text-right">{t('操作', 'Action')}</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {currentItems.length === 0 ? <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">{t('耗材清单暂无材料，可点击「从院内标准方案带入」或下方添加候选耗材。', 'No materials in list. Use verified hospital plan or add candidate materials below.')}</TableCell></TableRow> : null}
          {currentItems.map((item, idx) => {
            const candidate = candidates.find(c => c.materialId === item.materialId && c.catalogVersion === item.catalogVersion)
            const name = candidate?.item?.display ?? item.materialId
            const price = candidate?.item?.chargeDefinition.priceFen ?? 0
            const unit = candidate?.item?.chargeDefinition.unit ?? ''
            const qty = Number(item.quantity) || 0
            return <TableRow key={item.materialId}>
              <TableCell className="whitespace-normal">
                <div className="font-medium">{name}</div>
                <div className="text-xs text-muted-foreground">{candidate?.evidence.specification ?? ''}</div>
              </TableCell>
              <TableCell className="whitespace-normal text-xs text-muted-foreground">{item.reason || candidate?.quantityBasis}</TableCell>
              <TableCell className="text-right tabular-nums">{formatFen(price, locale)}{unit ? `/${unit}` : ''}</TableCell>
              <TableCell>
                <Input aria-label={`${t('预计数量：', 'Estimated quantity: ')}${name}`} type="number" min="1" max="1000" step="1" className="h-7 w-20 tabular-nums" value={item.quantity}
                  onChange={event => { setReviewed(false); setItems(currentItems.map((row, i) => i === idx ? { ...row, quantity: event.currentTarget.value } : row)) }} />
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">{formatFen(price * qty, locale)}</TableCell>
              <TableCell className="text-right">
                <Button type="button" variant="ghost" size="sm" onClick={() => { setReviewed(false); setItems(currentItems.filter((_, i) => i !== idx)) }}>{t('移除', 'Remove')}</Button>
              </TableCell>
            </TableRow>
          })}
        </TableBody>
      </Table>}
      <div className="grid gap-3 md:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`step2-add-${plan.id}`}>{t('+ 添加候选耗材', '+ Add candidate material')}</FieldLabel>
          <WorkspaceSelect id={`step2-add-${plan.id}`} value={null}
            items={candidates.filter(c => c.item !== null && !currentItems.some(i => i.materialId === c.materialId)).map(c => ({ value: c.materialId, label: `${c.item!.display} · ${c.evidence.specification}` }))}
            onValueChange={id => { const c = candidates.find(item => item.materialId === id); if (c) { setReviewed(false); setItems([...currentItems, { materialId: c.materialId, catalogVersion: c.catalogVersion, quantity: String(c.expectedQuantity ?? 1), reason: c.quantityBasis }]) } }} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`step2-note-${plan.id}`}>{t('耗材清单说明', 'Material list note')}</FieldLabel>
          <Input id={`step2-note-${plan.id}`} maxLength={2000} value={currentNote} onChange={event => { setReviewed(false); setNote(event.currentTarget.value) }} />
        </Field>
      </div>
      <div className="grid gap-2.5 rounded-lg border bg-muted/20 p-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="text-muted-foreground">{t('本台耗材预计', 'Estimated surgery materials')}</div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums">{formatFen(totalMaterialFen, locale)}</div>
          <div className="text-muted-foreground">{t(`共 ${currentItems.length} 项耗材`, `${currentItems.length} items`)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">{t('含本台手术后预计总费用', 'Projected total with surgery')}</div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums">{estimate?.costs ? formatFen(estimate.costs.components.projectedTotalFen, locale) : formatFen(admission.chargesFen + totalMaterialFen + plan.plannedProcedure.chargeDefinition.priceFen, locale)}</div>
          <div className="text-muted-foreground">{t('含在院已发生与术式费', 'Includes current charges & procedure fee')}</div>
        </div>
        <div>
          <div className="text-muted-foreground">{t('预计 DRG 入组与支付参考', 'Projected DRG & payment reference')}</div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums">{estimate?.costs?.projectedGrouping?.drgCode ?? t('待重算', 'Pending')}</div>
          <div className="text-muted-foreground">{onOpenDrg ? <button type="button" className="text-info underline" onClick={onOpenDrg}>{t('查看 DRG 预分组 ›', 'Open DRG pre-grouping ›')}</button> : null}</div>
        </div>
        <div>
          <div className="text-muted-foreground">{t('当前有效预留', 'Active reservations')}</div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums">{activeReservations.length > 0 ? t(`已锁定 ${activeReservations.length} 项`, `${activeReservations.length} locked`) : t('尚未锁定预留', 'None locked yet')}</div>
          <div className="text-muted-foreground">{t('确认后整批生成本计划预留', 'Confirmation locks reservations as a batch')}</div>
        </div>
      </div>
      {estimate ? <details className="clinmesh-inpatient-disclosure"><summary>{t('展开 AI 费用说明与调用记录', 'Expand AI cost explanation and usage records')}</summary>
        <div className="flex flex-col gap-2 py-2 text-xs">
          {estimate.analysis?.costExplanation ? <p>{estimate.analysis.costExplanation}</p> : null}
          <InpatientDrgUsagePanel admissionId={admission.id} taskId={estimate.id} session={session} locale={locale} active taskKind="estimate" />
        </div>
      </details> : null}
      <Field orientation="horizontal">
        <Checkbox id={`step2-review-${plan.id}`} checked={reviewed} onCheckedChange={checked => setReviewed(Boolean(checked))} />
        <FieldLabel htmlFor={`step2-review-${plan.id}`}>{t('已核对选型参数、耗材清单、数量依据与预留变更', 'Reviewed selection parameters, material list, quantity basis and reservation changes')}</FieldLabel>
      </Field>
    </div>
    <InpatientPrimaryAction stage="surgery" priority={45} fallback={confirmBtn}>
      <WorkspaceActionBar tone="assistant" summary={plan.plannedProcedure.coding.display} reason={reviewed ? t('确认后锁定本计划耗材预留并进入第 ③ 步术前核对', 'Confirm to lock material reservations and proceed to Step 3') : t('请先勾选已核对选型参数、耗材清单与预留变更', 'Check the review box before confirming')} action={confirmBtn} />
    </InpatientPrimaryAction>
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
  const bar = panel === 'cancel' ? { priority: 40, tone: cancelNote.trim() ? 'confirm' as const : 'blocked' as const, busy: undefined,
    reason: cancelNote.trim() ? t('取消后这份申请不能再开始手术', 'A cancelled request cannot start surgery') : t('还差：取消理由', 'Enter the cancellation reason'),
    action: <><Button variant="ghost" disabled={write.mutation.isPending} onClick={() => setPanel(null)}>{t('返回', 'Back')}</Button>
      <Button variant="destructive" disabled={blocked || !cancelNote.trim()} onClick={() => write.mutation.mutate({ operation: 'inpatient.surgery.cancel', input: { ...common, note: cancelNote.trim() } }, close)}>{t('确认取消手术申请', 'Cancel surgery request')}</Button></> }
    : panel === 'consent' ? { priority: 40, tone: consentNote.trim() ? 'normal' as const : 'blocked' as const,
      busy: pending('inpatient.surgery.confirm-consent') ? t('正在确认知情同意书', 'Confirming signed consent') : undefined,
      reason: consentNote.trim() ? t('确认后记入「开始手术还差」清单', 'Confirmation is recorded in the preparation checklist') : t('还差：签署说明', 'Enter the consent note'),
      action: <><Button variant="ghost" disabled={write.mutation.isPending} onClick={() => setPanel(null)}>{t('取消', 'Cancel')}</Button>
        <Button aria-busy={pending('inpatient.surgery.confirm-consent') || undefined} data-busy={pending('inpatient.surgery.confirm-consent') || undefined} data-unavailable={!write.mutation.isPending && (blocked || !consentNote.trim()) || undefined} disabled={blocked || !consentNote.trim()} onClick={() => write.mutation.mutate({ operation: 'inpatient.surgery.confirm-consent', input: { ...common, note: consentNote.trim() } }, close)}>{pending('inpatient.surgery.confirm-consent') ? <Spinner aria-hidden="true" data-icon="inline-start" /> : null}{pending('inpatient.surgery.confirm-consent') ? t('正在确认知情同意书', 'Confirming signed consent') : t('确认手术知情同意书已签', 'Confirm signed consent')}</Button></> }
      : { priority: ready ? 20 : -20, tone: ready && !blocked ? 'normal' as const : 'blocked' as const, busy: undefined,
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
      <dl className="grid gap-3 text-sm @lg:grid-cols-3"><div><dt className="text-xs text-muted-foreground">{t('计划手术时间（上海时间）', 'Planned surgery time (Shanghai)')}</dt><dd className="tabular-nums">{formatShanghaiMinute(row.plannedFor)}</dd></div>
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
        <div className="clinmesh-inpatient-preparation-owner"><span>{item.owner}</span>{item.record ? <time dateTime={item.record.recordedAt}>{formatShanghaiMinute(item.record.recordedAt)}</time> : null}
          {item.key === 'consent' && doctor && active && focused && !item.record && panel !== 'consent' ? <Button variant="outline" size="sm" disabled={blocked} onClick={() => setPanel('consent')}>{t('确认已签', 'Confirm signed')}</Button> : null}</div>
        {item.record ? <p className="col-span-2 col-start-2 text-xs text-muted-foreground">{t('说明：', 'Note: ')}{item.record.note}</p> : null}
        {item.key === 'consent' && panel === 'consent' && !item.record ? <Field className="col-span-2 col-start-2"><FieldLabel htmlFor={`surgery-consent-${row.id}`}>{t('签署说明','Consent note')}</FieldLabel><Input id={`surgery-consent-${row.id}`} autoFocus maxLength={2000} disabled={blocked} value={consentNote} onChange={event => setConsentNote(event.currentTarget.value)} /></Field> : null}
        {item.key === 'preop' && nurse && active && !item.record ? <FieldGroup className="col-span-2 col-start-2"><Field><FieldLabel htmlFor={`surgery-preop-${row.id}`}>{t('术前核对说明','Preoperative check note')}</FieldLabel><Input id={`surgery-preop-${row.id}`} maxLength={2000} disabled={blocked} value={preopNote} onChange={event => setPreopNote(event.currentTarget.value)} /></Field>
          <Button className="self-start" aria-busy={pending('inpatient.surgery.check-preop') || undefined} data-busy={pending('inpatient.surgery.check-preop') || undefined} data-unavailable={!write.mutation.isPending && (blocked || !preopNote.trim()) || undefined}
            disabled={blocked || !preopNote.trim()} onClick={() => write.mutation.mutate({ operation:'inpatient.surgery.check-preop', input: { ...common, note: preopNote.trim() } })}>{pending('inpatient.surgery.check-preop') ? <Spinner aria-hidden="true" data-icon="inline-start" /> : null}{pending('inpatient.surgery.check-preop') ? t('正在术前核对', 'Recording preoperative checks') : t('术前核对','Record preoperative checks')}</Button></FieldGroup> : null}
      </li>)}</ul>
    </section>
    {doctor && active && focused ? <InpatientPrimaryAction stage="surgery" priority={bar.priority} fallback={bar.action}><WorkspaceActionBar summary={row.plannedProcedure.coding.display} tone={bar.tone} reason={bar.reason} busy={bar.busy} action={bar.action} /></InpatientPrimaryAction> : null}
    {doctor && active ? <>
      <Dialog open={panel === 'start'} onOpenChange={open => { if (!open && !write.mutation.isPending) setPanel(null) }}>
        <DialogContent className="sm:max-w-[480px]"><DialogHeader><DialogTitle>{t('开始手术', 'Start surgery')}</DialogTitle>
          <DialogDescription>{t('开始时不登记耗材、不收术式费。', 'Starting records no materials or procedure fee.')}{actual ? `${t('术式费 ', ' Procedure fee ')}${formatFen(actual.chargeDefinition.priceFen, locale)}${t(' 在完成手术时计入。', ' is posted at completion.')}` : null}</DialogDescription></DialogHeader>
          <form className="flex min-h-0 flex-col p-0" onSubmit={event => { event.preventDefault(); start() }}>
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">{write.mutation.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(write.mutation.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}<InpatientWriteRecovery write={write} locale={locale} />
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
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">{write.mutation.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(write.mutation.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}<InpatientWriteRecovery write={write} locale={locale} />
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
