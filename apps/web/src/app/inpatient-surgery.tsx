import { SurgeryRequestReason } from './inpatient-surgery-request-reason.tsx'
import { EquivalentMaterialAdvice } from './inpatient-equivalent-materials.tsx'
import type { InpatientEquivalentMaterialSuggestion } from '@clinmesh/contracts/inpatient-pci-selection'
import { InpatientSurgeryMaterials, SurgeryDrgLink } from './inpatient-surgery-materials.tsx'
import { inpatientAngiographyReportsSchema, type InpatientAngiographyReport } from '@clinmesh/contracts/inpatient-angiography'
import { inpatientPciSelectionSchema, pciSelectionProcedureCodes } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientMaterialEstimateResponseSchema, inpatientMaterialEstimatesSchema, inpatientMaterialEstimateSaveInputSchema, type InpatientMaterialEstimate } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientGuidelineAdviceListSchema, type InpatientGuidelineAdvice } from '@clinmesh/contracts/inpatient-guideline-advice'
import type { z } from 'zod'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema, type inpatientSurgeryExecutionSchema, type inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientMaterialReservationListSchema, type InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
import { Spinner } from '@clinmesh/ui/components/spinner'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { cn } from '@clinmesh/ui/lib/utils'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { useLayoutEffect, useRef, useState } from 'react'
import { apiGet } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen, formatShanghaiMinute } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { WorkspaceActionBar } from './workspace-card-layout.tsx'
import { OrderComposerFooter } from './doctor/order-composer-layout.tsx'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { AlertCircleIcon, CheckCircle2Icon, CheckIcon, CircleIcon, PlusIcon } from 'lucide-react'
import { InpatientSurgeryDetails } from './inpatient-surgery-details.tsx'
import { CoronaryAngiographyDisclosure } from './inpatient-pci-draft-fields.tsx'
import { InpatientDrgReviewPanel } from './inpatient-drg-review.tsx'
import { surgeryPreparation, surgeryStepLabel, useSurgeryView, type SurgeryView } from './inpatient-surgery-flow.ts'
import { SurgeryExecuteComposer } from './inpatient-surgery-execute-composer.tsx'

type Props = {
  admission: InpatientAdmission
  session: SessionContext
  locale: WorkspaceLocale
  write: ReturnType<typeof useInpatientWriteIntent>
  active?: boolean
  view?: SurgeryView
  onOpenStage?: (stage: string) => void
  onOpenUsage?: (taskId?: string, taskKind?: 'estimate' | 'followup' | 'explanation' | 'guideline') => void
}
type Request = z.infer<typeof inpatientSurgeryRequestSchema>
type Catalog = z.infer<typeof inpatientSurgeryCatalogSchema>
const angiographyProcedureCodes = new Set(['88.5500', '88.5600'])
const coronaryProcedureCodes = new Set([...angiographyProcedureCodes, ...pciSelectionProcedureCodes])

export function InpatientSurgery({ admission, session, locale, write, active = true, onOpenStage, onOpenUsage, view: providedView }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const doctor = session.actor.roleCode === 'inpatient-doctor', nurse = session.actor.roleCode === 'ward-nurse', medicalRecords = session.actor.roleCode === 'medical-records'
  const scope = ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId]
  const surgery = useQuery({ queryKey: [...scope, admission.id, 'surgeries'], enabled: active, queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/surgeries`, inpatientSurgerySchema, signal) })
  const catalog = useQuery({ queryKey: [...scope, 'surgery-catalog'], enabled: active && (doctor || nurse), queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/surgery-catalog', inpatientSurgeryCatalogSchema, signal) })
  const reservations = useQuery({ queryKey: [...scope, admission.id, 'drg-reservations'], enabled: active && doctor, queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/reservations`, inpatientMaterialReservationListSchema, signal) })
  const [procedureId, setProcedureId] = useState<string | null>(null), [plannedFor, setPlannedFor] = useState(''), [reason, setReason] = useState('')
  const [preparationSlot, setPreparationSlot] = useState<HTMLDivElement | null>(null)
  const [requestOpen, setRequestOpen] = useState(false), [otherPlansOpen, setOtherPlansOpen] = useState(false)
  const [correctionOpen, setCorrectionOpen] = useState(false), [correctionVisited, setCorrectionVisited] = useState(false)
  const localView = useSurgeryView()
  const [view, setView] = providedView ?? localView
  const { editingStep1, selectionEditedAfterReserve, selectedRequestId } = view
  const setStep1ConfirmedPlanId = (value: string | null) => setView(previous => ({ ...previous, step1ConfirmedPlanId: value }))
  const setEditingStep1 = (value: boolean) => setView(previous => ({ ...previous, editingStep1: value }))
  const setEditingStep2 = (value: boolean) => setView(previous => ({ ...previous, editingStep2: value }))
  const setSelectionEditedAfterReserve = (value: boolean) => setView(previous => ({ ...previous, selectionEditedAfterReserve: value }))
  const setSelectedRequestId = (value: string | null) => setView(previous => ({ ...previous, selectedRequestId: value, editingStep1: false, editingStep2: false, selectionEditedAfterReserve: false }))
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null)
  const requestOwnerKey = JSON.stringify([session.user.id, session.actor, admission.id])
  const requestOwner = useRef(requestOwnerKey)
  const requestFocus = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (requestOwner.current !== requestOwnerKey) {
      setRequestOpen(false); setCorrectionOpen(false); setCorrectionVisited(false)
      setProcedureId(null); setPlannedFor(''); setReason('')
      setStep1ConfirmedPlanId(null); setEditingStep1(false); setEditingStep2(false)
      setSelectionEditedAfterReserve(false); setSelectedRequestId(null)
      setSelectedExecutionId(null)
    }
    requestOwner.current = requestOwnerKey
  }, [requestOwnerKey])
  useLayoutEffect(() => { if (!active) { setRequestOpen(false); setCorrectionOpen(false) } }, [active])
  const blocked = write.blocked || admission.status !== 'admitted'
  const procedure = catalog.data?.procedures.find(item => item.id === procedureId)
  const request = () => {
    if (!procedure || !surgery.data || !plannedFor || !reason.trim()) return
    const date = new Date(`${plannedFor}+08:00`)
    if (!Number.isFinite(date.getTime())) return
    write.mutation.mutate({
      operation: 'inpatient.surgery.request',
      input: {
        admissionId: admission.id,
        encounterVersion: surgery.data.encounterVersion,
        procedureId: procedure.id,
        catalogVersion: procedure.version,
        plannedFor: date.toISOString(),
        reason,
      },
    }, {
      onSuccess: () => { if (requestOwner.current === requestOwnerKey) { setRequestOpen(false); setProcedureId(null); setPlannedFor(''); setReason('') } },
    })
  }
  const error = surgery.error ?? catalog.error ?? reservations.error
  const attemptedCommand = write.mutation.variables ?? write.mutation.context
  const formId = `${admission.id}-surgery-form`
  const requestAction = <>
    <DialogClose render={<Button type="button" variant="ghost" />}>{t('取消', 'Cancel')}</DialogClose>
    <Button disabled={blocked || !procedure || !plannedFor || !reason.trim() || !surgery.data} type="submit" form={formId}>{t('提交手术申请', 'Submit surgery request')}</Button>
  </>
  const running = surgery.data?.inProgress ?? []
  const reservationRows = reservations.data?.reservations ?? []
  const refresh = () => Promise.all([surgery.refetch(), catalog.refetch(), reservations.refetch()])
  const openDrg = onOpenStage ? () => onOpenStage('drg') : undefined
  const estimatePlans = surgery.data?.requests.filter(row => ['requested', 'ready'].includes(row.status)) ?? []
  const pendingPlans = estimatePlans.filter(row => !running.some(execution => execution.requestId === row.id))
  const selectedPlan = pendingPlans.find(row => row.id === selectedRequestId) ?? pendingPlans[0] ?? estimatePlans[0]
  const isPci = Boolean(selectedPlan && pciSelectionProcedureCodes.includes(selectedPlan.plannedProcedure.coding.code))
  const preopActive = doctor && running.length === 0 && pendingPlans.length > 0 && selectedPlan !== undefined
  const pollActive = active && preopActive && admission.status === 'admitted' && admission.recordStatus !== 'archived'
  const selection = useQuery({
    queryKey: [...scope, admission.id, 'pci-selection'],
    enabled: active && preopActive && isPci,
    retry: false,
    refetchInterval: pollActive ? 3_000 : false,
    refetchIntervalInBackground: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/pci-selection`, inpatientPciSelectionSchema, signal),
  })
  const estimates = useQuery({
    queryKey: [...scope, admission.id, 'material-estimates'],
    enabled: active && preopActive,
    retry: false,
    refetchInterval: pollActive ? 3_000 : false,
    refetchIntervalInBackground: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/material-estimates`, inpatientMaterialEstimatesSchema, signal),
  })
  const guidelines = useQuery({
    queryKey: [...scope, admission.id, 'guideline-advice'],
    enabled: active && preopActive && isPci,
    retry: false,
    refetchInterval: pollActive ? 3_000 : false,
    refetchIntervalInBackground: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/guideline-advice`, inpatientGuidelineAdviceListSchema, signal),
  })
  const completedExecutions = surgery.data?.executions ?? []
  const hasCoronaryProcedure = Boolean(
    surgery.data?.requests.some(item => coronaryProcedureCodes.has(item.plannedProcedure.coding.code))
    || surgery.data?.inProgress.some(item => coronaryProcedureCodes.has(item.actualProcedure.coding.code))
    || completedExecutions.some(item => coronaryProcedureCodes.has(item.actualProcedure.coding.code)),
  )
  const angiographyReports = useQuery<z.infer<typeof inpatientAngiographyReportsSchema>>({
    queryKey: [...scope, admission.id, 'angiography-reports'],
    enabled: active && (doctor || nurse || medicalRecords) && hasCoronaryProcedure,
    retry: false,
    refetchInterval: (query) => {
      if (!active) return false
      if (pollActive && isPci) return 3_000
      if (admission.status !== 'admitted' || admission.recordStatus === 'archived') return false
      const reports = query.state.data?.reports
      const pendingReport = completedExecutions.some((execution) => {
        if (!angiographyProcedureCodes.has(execution.actualProcedure.coding.code)) return false
        const matched = reports?.find(item => item.procedureId === execution.id)
        return matched === undefined || matched.status === 'processing'
      })
      return pendingReport ? 3_000 : false
    },
    refetchIntervalInBackground: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/angiography-reports`, inpatientAngiographyReportsSchema, signal),
  })
  const selectedCompletedExecution = completedExecutions.find(item => item.id === selectedExecutionId) ?? completedExecutions.at(-1)
  const materialDataReady = catalog.isSuccess && !catalog.isFetching && reservations.isSuccess && !reservations.isFetching
  const activeReservations = reservationRows.filter(item => item.status === 'reserved' && item.requestId === selectedPlan?.id)
  const currentEstimate = selectedPlan ? estimates.data?.estimates.find(item => item.requestId === selectedPlan.id) : undefined
  const currentDraft = selectedPlan ? selection.data?.drafts?.find(item => item.requestId === selectedPlan.id) : undefined
  const currentConfirmed = selectedPlan && selection.data?.confirmation?.parameters.requestId === selectedPlan.id ? selection.data.confirmation.parameters : undefined
  const currentAdvice = selectedPlan ? guidelines.data?.advice.find(item => item.requestId === selectedPlan.id) : undefined
  const selectedAngiographyReport = (currentDraft ? angiographyReports.data?.reports.find(item => item.id === currentDraft.reportId) : undefined)
    ?? angiographyReports.data?.reports.find(item => item.status === 'final' || item.status === 'partial')
  const selectedCompletedCode = selectedCompletedExecution?.actualProcedure.coding.code
  const completedAngiographyReport = selectedCompletedExecution === undefined || selectedCompletedCode === undefined
    ? undefined
    : angiographyProcedureCodes.has(selectedCompletedCode)
      ? angiographyReports.data?.reports.find(item => item.procedureId === selectedCompletedExecution.id)
      : coronaryProcedureCodes.has(selectedCompletedCode)
        ? angiographyReports.data?.reports.find(item => item.status !== 'processing' && (item.vessels.length > 0 || item.conclusion !== null))
        : undefined
  const preparation = selectedPlan ? surgeryPreparation(selectedPlan, selection.data, currentEstimate, view, activeReservations.length > 0) : undefined
  const selDone = preparation?.selectionDone ?? false
  const showStepTwo = preparation?.needsMaterials ?? false
  const plans = <>
    {pendingPlans.length > 1 ? <Field><FieldLabel htmlFor="current-surgery-plan">{t('当前计划', 'Current plan')}</FieldLabel><WorkspaceSelect id="current-surgery-plan" value={selectedPlan?.id ?? null} disabled={write.blocked}
      items={pendingPlans.map(row => ({ value: row.id, label: `${row.plannedProcedure.coding.display} · ${row.reason}` }))} onValueChange={setSelectedRequestId} /></Field> : null}
    {pendingPlans.map(row => <div key={row.id} hidden={row.id !== selectedPlan?.id || running.length > 0 && !otherPlansOpen}><SurgeryRequest row={row} catalog={catalog.data} reservations={reservationRows}
      dataReady={materialDataReady} onRetry={() => { void refresh() }}
      admission={admission} session={session} locale={locale} write={write} preparationSlot={isPci || showStepTwo ? preparationSlot : null} preparation={row.id === selectedPlan?.id ? preparation : undefined} focused={active && row.id === selectedPlan?.id && (running.length === 0 || otherPlansOpen)} /></div>)}
  </>
  return <section aria-label={t('住院手术', 'Inpatient surgery')} className="flex flex-col gap-4">
    {doctor ? <div className="flex flex-wrap items-center justify-end gap-2">
      {selectedPlan && preopActive && active ? <InpatientSurgeryDetails key={`${requestOwnerKey}:${selectedPlan.id}`} admission={admission} session={session} locale={locale} write={write} plan={selectedPlan} estimate={currentEstimate} selection={selection.data} report={selectedAngiographyReport} onOpenUsage={onOpenUsage} /> : null}
      <Dialog open={requestOpen} pending={write.mutation.isPending} onOpenChange={setRequestOpen}>
        <DialogTrigger render={<Button type="button" variant="outline" size="sm" disabled={blocked} />} onClick={event => { requestFocus.current = event.currentTarget }}><PlusIcon aria-hidden="true" data-icon="inline-start" />{t('申请手术', 'Request surgery')}</DialogTrigger>
        <DialogContent className="sm:max-w-[640px]" showCloseButton={!write.mutation.isPending} finalFocus={requestFocus}>
          <DialogHeader><DialogTitle>{t('申请手术', 'Request surgery')}</DialogTitle><DialogDescription>{t('填写计划术式、时间与申请理由', 'Enter the planned procedure, time and request reason')}</DialogDescription></DialogHeader>
          <form id={formId} className="flex min-h-0 flex-col" onSubmit={event => { event.preventDefault(); request() }}>
            <div className="min-h-0 overflow-y-auto p-4">
              {write.mutation.error && write.mutation.variables?.operation === 'inpatient.surgery.request' && write.mutation.variables.input.admissionId === admission.id ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(write.mutation.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
              <FieldSet disabled={blocked}><FieldGroup className="grid gap-3 md:grid-cols-2">
                <Field><FieldLabel htmlFor={`${formId}-plan`}>{t('计划术式', 'Planned procedure')}</FieldLabel><WorkspaceSelect id={`${formId}-plan`} value={procedureId} items={(catalog.data?.procedures ?? []).map(item => ({ value: item.id, label: `${item.coding.code} · ${item.coding.display}` }))} onValueChange={setProcedureId} /></Field>
                <Field><FieldLabel htmlFor={`${formId}-time`}>{t('计划手术时间（上海时间）', 'Planned surgery time (Shanghai)')}</FieldLabel><Input id={`${formId}-time`} type="datetime-local" value={plannedFor} onChange={event => setPlannedFor(event.currentTarget.value)} required /></Field>
                <div className="md:col-span-2"><SurgeryRequestReason key={requestOwnerKey} admissionId={admission.id} session={session} open={requestOpen && active} locale={locale} value={reason} onChange={setReason} id={`${formId}-reason`} disabled={blocked} /></div>
              </FieldGroup></FieldSet>
            </div>
            <OrderComposerFooter hint={!procedure ? t('还差：选择计划术式', 'Select the planned procedure') : !plannedFor ? t('还差：填写计划手术时间', 'Enter the planned surgery time') : !reason.trim() ? t('还差：填写手术申请理由', 'Enter the surgery request reason') : t('提交后办理知情同意与术前核对', 'Complete consent and preoperative checks after submission')}>{requestAction}</OrderComposerFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div> : null}
    {error ? <Alert variant="destructive"><AlertDescription>{t('手术资料读取失败：', 'Surgery records failed to load: ')}{getWorkspaceErrorMessage(error, getWorkspaceMessages(locale))}<Button variant="outline" size="sm" onClick={() => { void surgery.refetch(); void catalog.refetch(); if (doctor) void reservations.refetch() }}>{t('重试手术资料', 'Retry surgery records')}</Button></AlertDescription></Alert> : null}
    {surgery.isPending ? <Skeleton className="h-24 w-full" /> : null}
    {running.map(execution => {
      const plan = surgery.data?.requests.find(row => row.id === execution.requestId)
      return plan ? <InpatientSurgeryMaterials key={execution.id} admission={admission} session={session} locale={locale} write={write} active={active}
        execution={execution} request={plan} catalog={catalog.data} reservations={reservationRows} dataReady={materialDataReady} running onOpenDrg={openDrg} refresh={refresh} /> : null
    })}
    {pendingPlans.length > 0 ? running.length > 0 ? <details className="clinmesh-inpatient-disclosure" onToggle={event => setOtherPlansOpen(event.currentTarget.open)}><summary>{t('其他待实施手术', 'Other planned procedures')}</summary><div className="flex flex-col gap-4 py-3">{plans}</div></details> : <>
      {plans}
      {doctor && selectedPlan && isPci ? <PciStepOneCard
        key={`step1:${requestOwnerKey}:${selectedPlan.id}`}
        admission={admission}
        plan={selectedPlan}
        selectionData={selection.data}
        draft={currentDraft}
        confirmed={currentConfirmed}
        report={selectedAngiographyReport}
        done={selDone && !editingStep1}
        editedAfterReserve={selectionEditedAfterReserve}
        locale={locale}
        write={write}
        blocked={blocked}
        onEdit={() => setEditingStep1(true)}
        onConfirmed={changed => {
          setStep1ConfirmedPlanId(selectedPlan.id)
          setEditingStep1(false)
          if (changed && activeReservations.length > 0) {
            setSelectionEditedAfterReserve(true)
            setEditingStep2(true)
          }
          void selection.refetch()
          void estimates.refetch()
          void guidelines.refetch()
        }}
      /> : null}
      {doctor && selectedPlan && showStepTwo ? <PciStepTwoCard
        key={`step2:${requestOwnerKey}:${selectedPlan.id}`}
        admission={admission}
        plan={selectedPlan}
        isPci={isPci}
        selDone={selDone && !editingStep1}
        done={preparation?.materialsDone ?? false}
        selectionEditedAfterReserve={preparation?.selectionChanged ?? false}
        estimate={currentEstimate}
        advice={currentAdvice}
        reservations={activeReservations}
        encounterVersion={reservations.data?.encounterVersion ?? surgery.data?.encounterVersion}
        reservationFingerprint={reservations.data?.reservationSets.find(set => set.requestId === selectedPlan.id)?.fingerprint}
        locale={locale}
        write={write}
        blocked={blocked}
        onEdit={() => setEditingStep2(true)}
        onConfirmed={() => {
          setEditingStep2(false)
          setSelectionEditedAfterReserve(false)
          void estimates.refetch()
          void reservations.refetch()
        }}
        onOpenUsage={onOpenUsage}
      /> : null}
      <div ref={setPreparationSlot} />
    </> : null}
    {selectedCompletedExecution && running.length === 0 && pendingPlans.length === 0 ? <SurgeryDone execution={selectedCompletedExecution} angiographyReport={completedAngiographyReport} locale={locale} onOpenDrg={openDrg} /> : null}
    {surgery.data?.requests.length === 0 ? <>
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">
        <p>{t('本次住院暂无手术申请。', 'No surgery requests for this admission.')}</p>
      </div>
      {doctor ? <InpatientPrimaryAction stage="surgery" priority={-30}>
        <WorkspaceActionBar
          reason={t('尚无手术计划，可按诊疗需要申请', 'No surgery planned; request as clinically needed')}
          action={<Button type="button" variant="outline" disabled={blocked} onClick={event => { requestFocus.current = event.currentTarget; setRequestOpen(true) }}><PlusIcon aria-hidden="true" data-icon="inline-start" />{t('申请手术', 'Request surgery')}</Button>}
        />
      </InpatientPrimaryAction> : null}
    </> : null}
    {selectedCompletedExecution ? (() => {
      const req = surgery.data?.requests.find(item => item.id === selectedCompletedExecution.requestId)
      if (!req) return null
      return <><Dialog open={correctionOpen} pending={write.mutation.isPending} onOpenChange={open => { setCorrectionOpen(open); if (open) setCorrectionVisited(true) }}>
        <DialogTrigger render={<Button type="button" variant="outline" className="self-start" />}>{t('补登记与更正耗材', 'Add or correct materials')}</DialogTrigger>
        <DialogContent keepMounted={correctionVisited} className="sm:max-w-[800px]" showCloseButton={!write.mutation.isPending}>
          <DialogHeader><DialogTitle>{t('术后耗材补登记、更正与历史', 'Postoperative material addenda, corrections and history')}</DialogTitle><DialogDescription>{selectedCompletedExecution.actualProcedure.coding.display}</DialogDescription></DialogHeader>
          <div className="min-h-0 overflow-y-auto p-4">
            {completedExecutions.length > 1 ? <Field className="mb-4"><FieldLabel htmlFor={`${admission.id}-completed-surgery`}>{t('已完成手术', 'Completed surgery')}</FieldLabel>
              <WorkspaceSelect id={`${admission.id}-completed-surgery`} value={selectedCompletedExecution.id} disabled={write.blocked} onValueChange={setSelectedExecutionId}
                items={completedExecutions.map(item => ({ value: item.id, label: `${item.actualProcedure.coding.display} · ${formatShanghaiMinute(item.performedAt)} · ${item.note}` }))} />
            </Field> : null}
            {write.mutation.error && (attemptedCommand?.operation === 'inpatient.surgery.correct-material' || attemptedCommand?.operation === 'inpatient.surgery.supplement-material')
              && attemptedCommand.input.admissionId === admission.id && attemptedCommand.input.requestId === req.id
              && attemptedCommand.input.executionId === selectedCompletedExecution.id ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(write.mutation.error, getWorkspaceMessages(locale))} <Button type="button" variant="outline" size="sm" disabled={write.blocked} onClick={() => { void refresh() }}>{t('刷新目录与记录，保留编辑', 'Refresh catalog and records, keep edits')}</Button></AlertDescription></Alert> : null}
            {doctor && (running.length > 0 || pendingPlans.length > 0) && correctionVisited ? <InpatientDrgReviewPanel key={`review:${requestOwnerKey}:${req.id}`} requestId={req.id} admission={admission} session={session} locale={locale} write={write} active={active && correctionOpen} compact onOpenRecord={target => onOpenStage?.(target)} /> : null}
            {correctionVisited ? <InpatientSurgeryMaterials key={`${requestOwnerKey}:${selectedCompletedExecution.id}`} admission={admission} session={session} locale={locale} write={write} active={active && correctionOpen} execution={selectedCompletedExecution} request={req} catalog={catalog.data} reservations={reservationRows} dataReady={materialDataReady} running={false} inDialog refresh={refresh} /> : null}
          </div>
          <OrderComposerFooter hint={t('补登记只增加本笔费用；更正保留原记录与历史', 'Addenda add one charge; corrections retain the original record and history')}><DialogClose disabled={write.mutation.isPending} render={<Button type="button" variant="outline" />}>{t('关闭', 'Close')}</DialogClose></OrderComposerFooter>
        </DialogContent>
      </Dialog>
      {doctor && running.length === 0 && pendingPlans.length === 0 ? <InpatientDrgReviewPanel key={requestOwnerKey} requestId={selectedCompletedExecution.requestId} admission={admission} session={session} locale={locale} write={write} active={active} compact onOpenRecord={target => onOpenStage?.(target)} /> : null}</>
    })() : null}
  </section>
}

function SurgeryDone({ execution, angiographyReport, locale, onOpenDrg }: { execution: z.infer<typeof inpatientSurgeryExecutionSchema>; angiographyReport: InpatientAngiographyReport | undefined; locale: WorkspaceLocale; onOpenDrg: (() => void) | undefined }) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const rows = execution.materials.reduce<{ item: (typeof execution.materials)[number]['item']; quantity: number; amountFen: number }[]>((result, use) => {
    const row = result.find(item => item.item.id === use.item.id)
    if (row) { row.quantity += use.quantity; row.amountFen += use.amountFen } else result.push({ item: use.item, quantity: use.quantity, amountFen: use.amountFen })
    return result
  }, [])
  const procedureFen = execution.actualProcedure.chargeDefinition.priceFen
  return <section aria-label={t('最终耗材', 'Final materials')} className="flex min-w-0 flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold">{execution.actualProcedure.coding.display}</h4><span className="font-mono text-xs text-muted-foreground">{execution.actualProcedure.coding.code}</span><Badge variant="outline" className="text-success">{t('已完成', 'Completed')}</Badge></div>
    {angiographyReport && angiographyReport.status !== 'processing' ? <CoronaryAngiographyDisclosure report={angiographyReport} locale={locale} summary={t('冠脉造影与生理学报告', 'Coronary angiography & physiology report')} /> : null}
    <Table><TableHeader><TableRow><TableHead>{t('耗材', 'Material')}</TableHead><TableHead>{t('最终用量', 'Final quantity')}</TableHead><TableHead className="text-right">{t('费用', 'Charge')}</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map(row => <TableRow key={row.item.id}><TableCell className="whitespace-normal">{row.item.display}</TableCell><TableCell className="tabular-nums">{row.quantity} {row.item.chargeDefinition.unit}</TableCell><TableCell className="text-right tabular-nums">{formatFen(row.amountFen, locale)}</TableCell></TableRow>)}
        <TableRow><TableCell className="whitespace-normal">{t('术式费', 'Procedure fee')} · {execution.actualProcedure.coding.display}</TableCell><TableCell>{t('1 次', '1')}</TableCell><TableCell className="text-right tabular-nums">{formatFen(procedureFen, locale)}</TableCell></TableRow></TableBody>
      <TableFooter><TableRow><TableCell colSpan={2}>{t('本台合计', 'Surgery total')}</TableCell><TableCell className="text-right tabular-nums">{formatFen(rows.reduce((sum, row) => sum + row.amountFen, procedureFen), locale)}</TableCell></TableRow></TableFooter></Table>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground"><span>{t('耗材与术式费已计入住院费用', 'Materials and procedure fee are posted')}</span><span className="flex-1" /><SurgeryDrgLink locale={locale} onOpenDrg={onOpenDrg} /></div>
  </section>
}

function PciStepOneCard({ admission, plan, selectionData, draft, confirmed, report, done, editedAfterReserve, locale, write, blocked, onEdit, onConfirmed }: {
  admission: InpatientAdmission
  plan: Request
  selectionData: z.infer<typeof inpatientPciSelectionSchema> | undefined
  draft: NonNullable<z.infer<typeof inpatientPciSelectionSchema>['drafts']>[number] | undefined
  confirmed: NonNullable<z.infer<typeof inpatientPciSelectionSchema>['confirmation']>['parameters'] | undefined
  report: InpatientAngiographyReport | undefined
  done: boolean
  editedAfterReserve: boolean
  locale: WorkspaceLocale
  write: ReturnType<typeof useInpatientWriteIntent>
  blocked: boolean
  onEdit: () => void
  onConfirmed: (changed: boolean) => void
}) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const base = draft?.parameters ?? confirmed
  const [targetSite, setTargetSite] = useState<string | null>(null)
  const [treatmentPlan, setTreatmentPlan] = useState<string | null>(null)
  const [lesionLength, setLesionLength] = useState<string | null>(null)
  const [proximalDiameter, setProximalDiameter] = useState<string | null>(null)
  const [distalDiameter, setDistalDiameter] = useState<string | null>(null)
  const siteValue = targetSite ?? base?.targetSite ?? ''
  const planValue = treatmentPlan ?? base?.treatmentPlan ?? plan.plannedProcedure.coding.display
  const findMeasurement = (kind: 'lesion-length' | 'proximal-reference-diameter' | 'distal-reference-diameter') =>
    base?.measurements.find(item => item.kind === kind)
  const lengthM = findMeasurement('lesion-length')
  const proxM = findMeasurement('proximal-reference-diameter')
  const distM = findMeasurement('distal-reference-diameter')
  const lengthVal = lesionLength ?? (lengthM !== undefined ? String(lengthM.value) : '')
  const proxVal = proximalDiameter ?? (proxM !== undefined ? String(proxM.value) : '')
  const distVal = distalDiameter ?? (distM !== undefined ? String(distM.value) : '')
  const prefilled = draft !== undefined && !draft.edited
  const validNum = (v: string, allowEmpty = false) => allowEmpty && v.trim() === '' ? true : Number(v) > 0
  const valid = siteValue.trim().length > 0 && planValue.trim().length > 0 && validNum(lengthVal) && validNum(proxVal) && validNum(distVal, true)
  const hasManualEdits = siteValue.trim() !== (base?.targetSite ?? '') || planValue.trim() !== (base?.treatmentPlan ?? plan.plannedProcedure.coding.display)
    || [lengthVal, proxVal, distVal].some((value, index) => value.trim() !== ([lengthM, proxM, distM][index]?.value == null ? '' : String([lengthM, proxM, distM][index]!.value)))
  const saveAndConfirmStepOne = async () => {
    if (!valid || blocked) return
    const defaultSource = base?.measurements[0]?.source ?? {
      reference: `DiagnosticReport/${draft?.reportId ?? 'report-1'}`,
      version: String(draft?.reportVersion ?? 1),
      note: t('医生按造影或实测填写', 'Entered by doctor'),
      synthetic: true as const,
    }
    const buildMeasurement = (kind: 'lesion-length' | 'proximal-reference-diameter' | 'distal-reference-diameter', raw: string) => {
      const existing = base?.measurements.find(item => item.kind === kind)
      const num = raw.trim() === '' ? null : Number(raw)
      return {
        kind,
        object: (kind === 'lesion-length' ? 'lesion' : 'reference-lumen') as 'lesion' | 'reference-lumen',
        site: siteValue.trim(),
        value: num,
        unit: num === null ? null : 'mm',
        method: existing?.method ?? t('造影定量测量', 'QCA measurement'),
        source: existing?.source ?? defaultSource,
      }
    }
    const parameters = {
      requestId: plan.id,
      treatmentPlan: planValue.trim(),
      targetSite: siteValue.trim(),
      measurements: [
        buildMeasurement('lesion-length', lengthVal),
        buildMeasurement('proximal-reference-diameter', proxVal),
        buildMeasurement('distal-reference-diameter', distVal),
      ],
      plannedQuantities: base?.plannedQuantities.length
        ? base.plannedQuantities
        : (selectionData?.candidates ?? []).map(c => ({ category: c.category, quantity: 1, basis: c.evidence.quantityBasis })),
      approvedMaterialIds: base?.approvedMaterialIds.length
        ? base.approvedMaterialIds
        : draft
          ? []
          : (selectionData?.candidates ?? []).map(c => c.materialId),
    }
    try {
      if (draft) {
        if (hasManualEdits) {
          await write.mutation.mutateAsync({
            operation: 'inpatient.pci-selection.save',
            input: { admissionId: admission.id, requestId: plan.id, expectedDraftVersion: draft.version, parameters },
          })
        }
      } else if (selectionData) {
        await write.mutation.mutateAsync({
          operation: 'inpatient.pci-selection.confirm',
          input: { admissionId: admission.id, expectedVersion: selectionData.confirmation?.version ?? 0, parameters },
        })
      }
    } catch {
      return
    }
    onConfirmed(hasManualEdits)
  }
  if (done) {
    const summaryText = `${siteValue || t('已填部位', 'Site entered')} · ${t('病变长度', 'Lesion length')} ${lengthVal || '—'} mm · ${t('参考直径', 'Reference diameter')} ${proxVal || '—'} / ${distVal || '—'} mm`
    return <section role="region" aria-label={t('选型参数', 'Selection parameters')} className="flex flex-col gap-1 rounded-lg border bg-card px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-grid size-5 place-items-center rounded-full bg-success text-[11px] font-semibold text-white"><CheckIcon aria-hidden="true" className="size-3" /></span>
        <h4 className="text-sm font-semibold">{t('选型参数', 'Selection parameters')}</h4>
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground">{editedAfterReserve ? t('你 · 已修改', 'You · edited') : t('你 · 已确认', 'You · confirmed')}</span>
        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={blocked} onClick={onEdit}>{t('修改', 'Edit')}</Button>
      </div>
      <p className="pl-7 text-xs text-muted-foreground">{summaryText}</p>
    </section>
  }
  const hasPrefilledMeasurements = Boolean(draft && (draft.parameters.targetSite !== null || draft.parameters.measurements.length > 0))
  const primaryButton = <Button disabled={blocked || !valid || write.mutation.isPending} onClick={() => { void saveAndConfirmStepOne() }}>{t('确认选型参数', 'Confirm selection parameters')}</Button>
  return <section role="region" aria-label={t('选型参数', 'Selection parameters')} className="flex flex-col gap-3 rounded-lg border bg-card p-3.5">
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-grid size-5 place-items-center rounded-full border border-info text-[11px] font-semibold text-info">1</span>
      <h4 className="text-sm font-semibold">{t('选型参数', 'Selection parameters')}</h4>
    </div>
    {hasPrefilledMeasurements ? <div className="flex items-start gap-2 rounded-lg bg-info/10 px-3 py-2 text-xs">
      <span className="mt-0.5 rounded border border-info/40 px-1 py-0.5 text-[11px] font-semibold text-info">{t('助手', 'Assistant')}</span>
      <div>
        <p>{t('已按冠脉造影报告预填病变测量，请逐项核对后确认。', 'Lesion measurements prefilled from the coronary angiography report; review and confirm each item.')}</p>
        <p className="mt-0.5 text-muted-foreground">{t('测量只取报告里已有的数值；报告没写的项留空，不推测。', 'Only measurements present in the report are prefilled; missing items are left blank.')}</p>
      </div>
    </div> : <div className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      {t('开启自动跟进后，助手按冠脉造影报告预填；也可以直接填写。', 'Enable auto follow-up to prefill from the angiography report, or enter directly.')}
    </div>}
    <FieldSet disabled={blocked}><FieldGroup className="grid gap-3 md:grid-cols-2">
      <Field>
        <FieldLabel htmlFor="pci-step1-target-site">{t('靶病变部位', 'Target lesion site')}</FieldLabel>
        <Input id="pci-step1-target-site" placeholder={t('例如：前降支近段', 'e.g. proximal LAD')} className={cn(prefilled && targetSite === null && siteValue && 'border-dashed border-info/50 bg-info/5')} value={siteValue} onChange={event => setTargetSite(event.currentTarget.value)} />
      </Field>
      <Field>
        <FieldLabel htmlFor="pci-step1-treatment-plan">{t('治疗方向与术式', 'Treatment plan & procedure')}</FieldLabel>
        <Input id="pci-step1-treatment-plan" value={planValue} onChange={event => setTreatmentPlan(event.currentTarget.value)} />
        <FieldDescription>{t('默认取手术计划', 'Defaults to the planned procedure')}</FieldDescription>
      </Field>
    </FieldGroup></FieldSet>
    <Table>
      <TableHeader><TableRow>
        <TableHead>{t('测量', 'Measurement')}</TableHead>
        <TableHead>{t('数值', 'Value')}</TableHead>
        <TableHead>{t('部位与方法', 'Site & method')}</TableHead>
      </TableRow></TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>{t('病变长度', 'Lesion length')}</TableCell>
          <TableCell>
            <div className="inline-flex items-center gap-1.5">
              <Input id="pci-step1-lesion-length" aria-label={t('病变长度 (mm)', 'Lesion length (mm)')} type="number" step="0.1" min="0.1" placeholder={t('未测', 'Unmeasured')} className={cn('h-7 w-24 tabular-nums', prefilled && lesionLength === null && lengthVal && 'border-dashed border-info/50 bg-info/5')} value={lengthVal} onChange={event => setLesionLength(event.currentTarget.value)} />
              <span className="text-xs text-muted-foreground">mm</span>
            </div>
          </TableCell>
          <TableCell className="whitespace-normal text-xs text-muted-foreground">{lengthM ? `${lengthM.site} · ${lengthM.method}` : ''}</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>{t('近端参考直径', 'Proximal reference diameter')}</TableCell>
          <TableCell>
            <div className="inline-flex items-center gap-1.5">
              <Input id="pci-step1-proximal-diameter" aria-label={t('近端参考管径 (mm)', 'Proximal reference diameter (mm)')} type="number" step="0.1" min="0.1" placeholder={t('未测', 'Unmeasured')} className={cn('h-7 w-24 tabular-nums', prefilled && proximalDiameter === null && proxVal && 'border-dashed border-info/50 bg-info/5')} value={proxVal} onChange={event => setProximalDiameter(event.currentTarget.value)} />
              <span className="text-xs text-muted-foreground">mm</span>
            </div>
          </TableCell>
          <TableCell className="whitespace-normal text-xs text-muted-foreground">{proxM?.site ?? ''}</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>{t('远端参考直径', 'Distal reference diameter')}</TableCell>
          <TableCell>
            <div className="inline-flex items-center gap-1.5">
              <Input id="pci-step1-distal-diameter" aria-label={t('远端参考管径 (mm)', 'Distal reference diameter (mm)')} type="number" step="0.1" min="0.1" placeholder={t('未测', 'Unmeasured')} className={cn('h-7 w-24 tabular-nums', prefilled && distalDiameter === null && distVal && 'border-dashed border-info/50 bg-info/5')} value={proxVal && !distVal && distalDiameter === null ? '' : distVal} onChange={event => setDistalDiameter(event.currentTarget.value)} />
              <span className="text-xs text-muted-foreground">mm</span>
            </div>
          </TableCell>
          <TableCell className="whitespace-normal text-xs text-muted-foreground">{distM?.site ?? ''}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
    {report && report.status !== 'processing' ? <CoronaryAngiographyDisclosure report={report} locale={locale} summary={t('冠脉造影与生理学依据', 'Coronary angiography & physiology evidence')} /> : null}
    <p className="text-xs text-muted-foreground">{t('报告没写的测量可以留空；单位、测量对象和来源随报告一并记录。', 'Measurements not in the report can be left blank; units, objects and sources are recorded with the report.')}</p>
    <InpatientPrimaryAction stage="surgery" priority={45} fallback={primaryButton}>
      <WorkspaceActionBar tone={valid ? 'normal' : 'blocked'} summary={plan.plannedProcedure.coding.display} reason={draft ? t('核对助手预填的病变测量', 'Review assistant-prefilled lesion measurements') : t('填写病变测量', 'Enter lesion measurements')} action={primaryButton} />
    </InpatientPrimaryAction>
  </section>
}

function PciStepTwoCard({ admission, plan, isPci, selDone, done, selectionEditedAfterReserve, estimate, advice, reservations, encounterVersion, reservationFingerprint, locale, write, blocked, onEdit, onConfirmed, onOpenUsage }: {
  admission: InpatientAdmission
  plan: Request
  isPci: boolean
  selDone: boolean
  done: boolean
  selectionEditedAfterReserve: boolean
  estimate: InpatientMaterialEstimate | undefined
  advice: InpatientGuidelineAdvice | undefined
  reservations: InpatientMaterialReservation[]
  encounterVersion: string | undefined
  reservationFingerprint: string | undefined
  locale: WorkspaceLocale
  write: ReturnType<typeof useInpatientWriteIntent>
  blocked: boolean
  onEdit: () => void
  onConfirmed: () => void
  onOpenUsage: ((taskId?: string, taskKind?: 'estimate' | 'followup' | 'explanation' | 'guideline') => void) | undefined
}) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const [items, setItems] = useState<Array<{ materialId: string; catalogVersion: number; quantity: string; reason: string }> | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [adopted, setAdopted] = useState<InpatientEquivalentMaterialSuggestion | null>(null)
  const candidates = estimate?.candidates ?? []
  const eligible = candidates.filter(candidate => candidate.eligibility === 'valid' && candidate.item !== null)
  const loading = estimate?.status === 'queued' || estimate?.status === 'running'
  const failed = estimate?.status === 'failed' || estimate?.status === 'blocked' || estimate?.status === 'unknown'
  const changedAfterReserve = selectionEditedAfterReserve
  const matDone = done
  if (!selDone) {
    return <section role="region" aria-label={t('手术耗材', 'Surgical materials')} className="flex flex-col rounded-lg border border-dashed px-3.5 py-2.5 text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-grid size-5 place-items-center rounded-full border border-muted-foreground text-[11px] font-semibold">2</span>
        <h4 className="text-sm font-medium">{t('手术耗材', 'Surgical materials')}</h4>
        <span className="text-xs">{t('确认选型参数后，助手给出指南参考并预填具体耗材', 'Confirm selection parameters first; the assistant will provide guideline reference and prefill materials')}</span>
      </div>
    </section>
  }
  if (matDone) {
    const reservedFen = reservations.length > 0
      ? reservations.reduce((sum, item) => sum + item.priceFen * (item.remainingQuantity ?? item.quantity - item.consumedQuantity), 0)
      : (estimate?.draft?.items ?? []).reduce((sum, item) => {
        const c = candidates.find(cand => cand.materialId === item.materialId && cand.catalogVersion === item.catalogVersion)
        return sum + (c?.item?.chargeDefinition.priceFen ?? 0) * item.quantity
      }, 0)
    const itemsText = reservations.length > 0
      ? reservations.map(item => `${item.materialDisplay.replace(/^合成演示/, '')} ${item.remainingQuantity ?? item.quantity - item.consumedQuantity}`).join(t('、', ', '))
      : (estimate?.draft?.items ?? []).map(item => {
        const c = candidates.find(cand => cand.materialId === item.materialId && cand.catalogVersion === item.catalogVersion)
        return `${(c?.item?.display ?? item.materialId).replace(/^合成演示/, '')} ${item.quantity}`
      }).join(t('、', ', '))
    const summaryText = `${t('已为本计划预留 ', 'Reserved for this plan: ')}${itemsText} · ${t('预计 ', 'Est. ')}${formatFen(reservedFen, locale)}`
    return <section role="region" aria-label={t('手术耗材', 'Surgical materials')} className="flex flex-col gap-1 rounded-lg border bg-card px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-grid size-5 place-items-center rounded-full bg-success text-[11px] font-semibold text-white"><CheckIcon aria-hidden="true" className="size-3" /></span>
        <h4 className="text-sm font-semibold">{t('手术耗材', 'Surgical materials')}</h4>
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground">{t('你 · 已确认', 'You · confirmed')}</span>
        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={blocked} onClick={onEdit}>{t('修改', 'Edit')}</Button>
      </div>
      <p className="pl-7 text-xs text-muted-foreground">{summaryText}</p>
    </section>
  }
  const baseRows = (estimate?.draft?.items.length ? estimate.draft.items : eligible.filter(candidate => candidate.selected !== false).map(c => ({
    materialId: c.materialId,
    catalogVersion: c.catalogVersion,
    quantity: failed && reservations.length === 0 ? 0 : (c.expectedQuantity ?? 1),
    reason: c.quantityBasis,
  }))).map(item => ({ ...item, quantity: item.quantity > 0 ? String(item.quantity) : '' }))
  const currentItems = items ?? baseRows
  const currentNote = note ?? estimate?.draft?.note ?? ''
  const nonZeroItems = currentItems.filter(item => (Number(item.quantity) || 0) > 0)
  const totalMaterialFen = nonZeroItems.reduce((sum, item) => {
    const candidate = candidates.find(c => c.materialId === item.materialId && c.catalogVersion === item.catalogVersion)
    const price = candidate?.item?.chargeDefinition.priceFen ?? 0
    return sum + price * (Number(item.quantity) || 0)
  }, 0)
  const replaceEquivalent = async (suggestion: InpatientEquivalentMaterialSuggestion, restore = false) => {
    if (!estimate || blocked || write.mutation.isPending) return
    const from = restore ? suggestion.to : suggestion.from, to = restore ? suggestion.from : suggestion.to
    const rows = currentItems.map(item => item.materialId === from.id ? { ...item, materialId: to.id, catalogVersion: to.version } : item)
    const parsed = inpatientMaterialEstimateSaveInputSchema.safeParse({ admissionId: admission.id, requestId: plan.id,
      expectedVersion: estimate.version, expectedDraftRevision: estimate.draft?.revision ?? 0,
      expectedBasisFingerprint: estimate.basisFingerprint, analysisId: null,
      items: rows.filter(item => Number(item.quantity) > 0).map(item => ({ ...item, quantity: Number(item.quantity) })), note: currentNote })
    if (!parsed.success) return
    const submittedNote = note
    setItems(rows)
    try {
      await write.mutation.mutateAsync({ operation: 'inpatient.material-estimate.save', input: parsed.data })
      setItems(current => current === rows ? null : current)
      setNote(current => current === submittedNote ? null : current)
      setAdopted(restore ? null : suggestion)
    } catch { /* Existing write recovery keeps the original intent and current input. */ }
  }
  const saveAndConfirm = async () => {
    if (!estimate || blocked || nonZeroItems.length === 0 || !encounterVersion || !reservationFingerprint) return
    let target = estimate
    const needSave = items !== null || note !== null || !estimate.draft || estimate.status === 'stale'
    if (needSave) {
      const validAnalysisId = estimate.analysis && estimate.analysis.basisFingerprint === estimate.basisFingerprint
        ? (estimate.draft?.analysisId ?? estimate.analysis.id)
        : null
      const saveParsed = inpatientMaterialEstimateSaveInputSchema.safeParse({
        admissionId: admission.id,
        requestId: plan.id,
        expectedVersion: estimate.version,
        expectedDraftRevision: estimate.draft?.revision ?? 0,
        expectedBasisFingerprint: estimate.basisFingerprint,
        analysisId: validAnalysisId,
        items: nonZeroItems.map(item => ({ ...item, quantity: Number(item.quantity) })),
        note: currentNote,
      })
      if (!saveParsed.success) return
      try {
        const result = await write.mutation.mutateAsync({ operation: 'inpatient.material-estimate.save', input: saveParsed.data })
        target = inpatientMaterialEstimateResponseSchema.parse(result.response).data
      } catch {
        return
      }
    }
    if (!target.draft) return
    try {
      await write.mutation.mutateAsync({
        operation: 'inpatient.material-estimate.confirm',
        input: {
          admissionId: admission.id,
          requestId: plan.id,
          expectedVersion: target.version,
          expectedDraftRevision: target.draft.revision,
          expectedBasisFingerprint: target.basisFingerprint,
          expectedRequestVersion: target.requestVersion,
          encounterVersion,
          expectedReservationFingerprint: reservationFingerprint,
          reason: currentNote || t('医生已核对整批预计耗材及原预留处理', 'Doctor reviewed the material estimate and reservation changes'),
        },
      })
      setItems(null)
      setNote(null)
      onConfirmed()
    } catch {
      return
    }
  }
  const hasIneligibleItems = reservations.length === 0 && nonZeroItems.some(item => {
    const candidate = candidates.find(c => c.materialId === item.materialId && c.catalogVersion === item.catalogVersion)
    return candidate !== undefined && candidate.eligibility !== 'valid'
  })
  const guidelineRows: Array<[string, string]> = advice?.result?.conclusions.length
    ? advice.result.conclusions.slice(0, 3).map((item, idx) => [
      idx === 0 ? t('支架类别', 'Stent category') : idx === 1 ? t('影像指导', 'Imaging guidance') : t('测量要求', 'Measurement rule'),
      item.text,
    ])
    : []
  const renderGuideBox = (withTail: boolean) => <div className="flex flex-col gap-1.5 rounded-lg bg-info/10 px-3 py-2.5 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <strong className="font-semibold">{t('指南参考', 'Guideline reference')}</strong>
      <span className="rounded border border-info/40 px-1 py-0.5 text-[11px] font-semibold text-info">{t('助手', 'Assistant')}</span>
      <span className="text-muted-foreground">{t('按确认的选型参数生成 · 合成 PCI 指南摘录', 'Generated from confirmed selection parameters · synthetic PCI guideline excerpt')}</span>
    </div>
    {guidelineRows.length > 0 ? guidelineRows.map(([label, text]) => <div key={label} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span>{text}</span>
    </div>) : advice ? <p className="text-muted-foreground">
      {advice.message}
      {advice.status === 'unknown' && onOpenUsage ? <Button type="button" variant="link" size="sm" className="h-auto px-1 text-xs text-info" onClick={() => onOpenUsage(advice.taskId ?? undefined, 'guideline')}>{t('查看原因', 'View reason')}</Button> : null}
    </p> : <p className="text-muted-foreground">{t('尚无本计划的指南参考结果。', 'No guideline advice is available for this plan.')}</p>}
    {withTail ? <div className="mt-1 border-t border-info/20 pt-1.5">
      <p>{t('请结合指南参考与当前病情核对下表耗材和数量后确认。', 'Review materials and quantities against the available guideline advice and current patient facts before confirming.')}</p>
      <p className="text-muted-foreground">{t('只在兼容的候选里选择；确认后即为本计划预留并记作计划数量，实际用量在术中逐笔登记。', 'Confirming reserves materials for this plan and records planned quantities; actual use is logged during surgery.')}</p>
    </div> : null}
  </div>
  const confirmLabel = t('确认手术耗材', 'Confirm surgical materials')
  const confirmBtn = <Button disabled={blocked || !estimate || !encounterVersion || !reservationFingerprint || nonZeroItems.length === 0 || hasIneligibleItems || write.mutation.isPending} onClick={() => { void saveAndConfirm() }}>{confirmLabel}</Button>
  return <section role="region" aria-label={t('手术耗材', 'Surgical materials')} className="flex flex-col gap-3 rounded-lg border bg-card p-3.5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-grid size-5 place-items-center rounded-full border border-info text-[11px] font-semibold text-info">2</span>
        <h4 className="text-sm font-semibold">{t('手术耗材', 'Surgical materials')}</h4>
      </div>
      {loading && estimate ? <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" disabled={blocked} onClick={() => write.mutation.mutate({ operation: 'inpatient.material-estimate.cancel', input: { admissionId: admission.id, requestId: plan.id, expectedRequestVersion: estimate.requestVersion, expectedVersion: estimate.version, expectedBasisFingerprint: estimate.basisFingerprint } })}>{t('取消本次预计', 'Cancel estimate')}</Button> : null}
    </div>
    {hasIneligibleItems && estimate?.missing.length ? <div role="alert" className="flex items-start gap-2 rounded-lg bg-warning/15 px-3 py-2 text-xs">
      <AlertCircleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
      <p>{estimate.missing.join(' · ')}</p>
    </div> : null}
    {loading ? <div role="status" className="flex items-start gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <Spinner aria-hidden="true" className="mt-0.5 size-3.5" />
      <div>
        <p>{t('助手正在按确认的选型参数生成指南参考并预填耗材…', 'Assistant is generating guideline reference and prefilling materials from confirmed parameters…')}</p>
        <p className="mt-0.5">{t('通常几秒；也可以先直接填写，助手不会覆盖你填的数量。', 'Usually takes a few seconds; you can also enter quantities directly without being overwritten.')}</p>
      </div>
    </div> : changedAfterReserve ? <>
      <div className="flex items-start gap-2 rounded-lg bg-warning/15 px-3 py-2 text-xs">
        <AlertCircleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
        <div>
          <p className="font-medium">{t('选型已变化，已有预留保持不变，请核对耗材后再次确认。', 'Selection parameters changed; existing reservations are kept unchanged. Review materials and confirm again.')}</p>
          <p className="mt-0.5 text-muted-foreground">{t('助手只标出与新测量不符的行，不改你已确认的数量。', 'The assistant highlights rows that differ from new measurements without changing your confirmed quantities.')}</p>
        </div>
      </div>
      {isPci ? renderGuideBox(false) : null}
    </> : failed && !changedAfterReserve ? <>
      {isPci && advice?.result ? renderGuideBox(false) : null}
      <div className="flex items-start gap-2 rounded-lg bg-warning/15 px-3 py-2 text-xs">
        <AlertCircleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
        <div>
          <p>
            {t('助手这次未能预填耗材，请直接填写。', 'Assistant could not prefill materials this time; please enter directly.')}
            {onOpenUsage ? <Button type="button" variant="link" size="sm" className="h-auto px-1 text-xs text-info" onClick={() => onOpenUsage(estimate?.id, 'estimate')}>{t('查看原因', 'View reason')}</Button> : null}
          </p>
          <p className="mt-0.5 text-muted-foreground">{t('依据变化后会自动再试；你填写的内容不会被覆盖。', 'Will retry automatically when inputs change; your entries will not be overwritten.')}</p>
        </div>
      </div>
    </> : isPci ? renderGuideBox(true) : null}
    <EquivalentMaterialAdvice locale={locale} assistantExplanation={estimate?.status === 'succeeded' && estimate.analysis?.basisFingerprint === estimate.basisFingerprint ? estimate.analysis.costExplanation : null} disabled={blocked || write.mutation.isPending}
      suggestions={(estimate?.equivalentSuggestions ?? []).filter(suggestion => currentItems.some(item => item.materialId === suggestion.from.id && Number(item.quantity) === suggestion.quantity))}
      onPick={suggestion => { void replaceEquivalent(suggestion) }}
      undo={adopted && currentItems.some(item => item.materialId === adopted.to.id) ? { savingsFen: adopted.totalSavingsFen, onUndo: () => { void replaceEquivalent(adopted, true) } } : undefined} />
    <Table>
      <TableHeader><TableRow>
        <TableHead>{t('耗材', 'Material')}</TableHead>
        <TableHead>{t('数量', 'Quantity')}</TableHead>
        <TableHead>{t('依据', 'Basis')}</TableHead>
        <TableHead className="text-right">{t('预计', 'Estimated')}</TableHead>
      </TableRow></TableHeader>
      <TableBody>
        {currentItems.length === 0 ? <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">{t('暂无候选耗材，请从下方添加。', 'No materials yet; add from candidates below.')}</TableCell></TableRow> : null}
        {currentItems.map((item, idx) => {
          const candidate = candidates.find(c => c.materialId === item.materialId && c.catalogVersion === item.catalogVersion)
          const name = candidate?.item?.display ?? item.materialId
          const price = candidate?.item?.chargeDefinition.priceFen ?? 0
          const unit = candidate?.item?.chargeDefinition.unit ?? ''
          const qty = Number(item.quantity) || 0
          const candidateDiff = estimate?.candidateItems.find(c => c.materialId === item.materialId && c.quantity !== qty)
          const showMismatch = changedAfterReserve && (candidateDiff !== undefined || candidate !== undefined && candidate.eligibility !== 'valid')
          return <TableRow key={item.materialId}>
            <TableCell className="whitespace-normal font-medium">{name}</TableCell>
            <TableCell>
              <div className="inline-flex items-center gap-1.5">
                <Input
                  aria-label={`${t('预计数量：', 'Estimated quantity: ')}${name}`}
                  type="number"
                  min="0"
                  max="1000"
                  step="1"
                  className={cn('h-7 w-16 tabular-nums', items === null && !failed && !loading && qty > 0 && 'border-dashed border-info/50 bg-info/5')}
                  value={item.quantity}
                  onChange={event => setItems(currentItems.map((row, i) => i === idx ? { ...row, quantity: event.currentTarget.value } : row))}
                />
                {unit ? <span className="text-xs text-muted-foreground">{unit}</span> : null}
              </div>
            </TableCell>
            <TableCell className="whitespace-normal text-xs text-muted-foreground">
              {showMismatch ? <><span className="font-medium text-warning">{t('与新测量不符：', 'Mismatch with new measurement: ')}</span>{candidateDiff?.reason ?? candidate?.missing.join(' · ')}</> : (failed && items === null ? '' : item.reason || candidate?.quantityBasis)}
            </TableCell>
            <TableCell className="text-right font-medium tabular-nums">{qty > 0 ? formatFen(price * qty, locale) : '—'}</TableCell>
          </TableRow>
        })}
      </TableBody>
      {nonZeroItems.length > 0 ? <TableFooter><TableRow>
        <TableCell colSpan={3}>{changedAfterReserve ? t('已预留合计', 'Reserved total') : t('预计耗材合计', 'Estimated material total')}</TableCell>
        <TableCell className="text-right tabular-nums">{formatFen(totalMaterialFen, locale)}</TableCell>
      </TableRow></TableFooter> : null}
    </Table>
    <div className="grid gap-3 md:grid-cols-2">
      {candidates.some(c => c.item !== null && !currentItems.some(i => i.materialId === c.materialId)) ? <Field>
        <FieldLabel htmlFor={`step2-add-${plan.id}`}>{t('+ 添加候选耗材', '+ Add candidate material')}</FieldLabel>
        <WorkspaceSelect id={`step2-add-${plan.id}`} value={null}
          items={candidates.filter(c => c.item !== null && !currentItems.some(i => i.materialId === c.materialId)).map(c => ({ value: c.materialId, label: `${c.item!.display} · ${c.evidence.specification}` }))}
          onValueChange={id => { const c = candidates.find(item => item.materialId === id); if (!c) return; const other = currentItems.find(item => c.equivalenceGroupId && candidates.find(candidate => candidate.materialId === item.materialId)?.equivalenceGroupId === c.equivalenceGroupId); setItems(other ? currentItems.map(item => item === other ? { ...item, materialId: c.materialId, catalogVersion: c.catalogVersion } : item) : [...currentItems, { materialId: c.materialId, catalogVersion: c.catalogVersion, quantity: String(c.expectedQuantity ?? 1), reason: c.quantityBasis }]) }} />
      </Field> : null}
      <Field>
        <FieldLabel htmlFor={`step2-note-${plan.id}`}>{t('耗材清单说明', 'Material list note')}</FieldLabel>
        <Input id={`step2-note-${plan.id}`} maxLength={2000} value={currentNote} onChange={event => setNote(event.currentTarget.value)} />
      </Field>
    </div>
    <InpatientPrimaryAction stage="surgery" priority={45} fallback={confirmBtn}>
      <WorkspaceActionBar
        tone={nonZeroItems.length === 0 ? 'blocked' : 'normal'}
        summary={plan.plannedProcedure.coding.display}
        reason={loading ? t('助手正在预填耗材，也可以直接填写', 'Assistant is prefilling materials; you may also enter directly') : nonZeroItems.length === 0 ? t('还差：耗材数量', 'Enter material quantities') : changedAfterReserve ? t('已预留的耗材保持不变；核对后更新预留', 'Reserved materials remain unchanged; review and update reservations') : t('确认后为本计划预留，费用按预留预计', 'Confirm to reserve for this plan and project costs')}
        action={confirmBtn}
      />
    </InpatientPrimaryAction>
  </section>
}

function SurgeryRequest({ row, catalog, reservations, dataReady, onRetry, admission, session, locale, write, focused, preparation, preparationSlot }: Props & { preparationSlot?: HTMLDivElement | null; preparation?: ReturnType<typeof surgeryPreparation> | undefined; row: Request; catalog: Catalog | undefined; reservations: InpatientMaterialReservation[]; focused: boolean; dataReady: boolean; onRetry: () => void }): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const doctor = session.actor.roleCode === 'inpatient-doctor', nurse = session.actor.roleCode === 'ward-nurse'
  const [panel, setPanel] = useState<'consent' | 'cancel' | 'start' | 'batch' | null>(null)
  const [consentNote, setConsentNote] = useState(''), [preopNote, setPreopNote] = useState(''), [cancelNote, setCancelNote] = useState('')
  const [startNote, setStartNote] = useState('')
  const [actualId, setActualId] = useState<string | null>(null)
  const batchTrigger = useRef<HTMLButtonElement | null>(null), startTrigger = useRef<HTMLButtonElement | null>(null)
  useLayoutEffect(() => { if (!focused) setPanel(null) }, [focused])
  const actual = catalog?.procedures.find(item => item.id === (actualId ?? row.plannedProcedure.id))
  const active = ['requested', 'ready'].includes(row.status), ready = row.status === 'ready', blocked = write.blocked || admission.status !== 'admitted'
  const common = { admissionId: admission.id, requestId: row.id, expectedRequestVersion: row.version }
  const close = { onSuccess: () => setPanel(null) }
  const pending = (operation: string) => write.mutation.isPending && write.mutation.variables?.operation === operation
  const planned = reservations.filter(item => item.requestId === row.id && item.status === 'reserved')
  const plannedFen = planned.reduce((sum, item) => sum + item.priceFen * (item.remainingQuantity ?? item.quantity - item.consumedQuantity), 0)
  const start = () => {
    if (actual && startNote.trim()) {
      write.mutation.mutate({
        operation: 'inpatient.surgery.start',
        input: { ...common, note: startNote.trim(), procedureId: actual.id, catalogVersion: actual.version },
      }, close)
    }
  }
  const missing = [!row.consentConfirmation ? t('手术知情同意书（你）', 'signed consent (you)') : null, !row.preopCheck ? t('术前核对（病区护士）', 'preoperative checks (ward nurse)') : null].filter(Boolean)
  const status = { requested: t('待准备', 'Preparation pending'), ready: t('已就绪', 'Ready'), completed: t('已实施', 'Completed'), cancelled: t('已取消', 'Cancelled') }[row.status]
  const preparationTitle = t('术前准备', 'Preoperative preparation')
  const preparationReady = !doctor || !preparation || ['consent', 'nurse', 'start'].includes(preparation.step)
  const bar = panel === 'cancel' ? {
    priority: 50,
    tone: cancelNote.trim() ? 'confirm' as const : 'blocked' as const,
    busy: undefined,
    reason: cancelNote.trim() ? t('取消后这份申请不能再开始手术', 'A cancelled request cannot start surgery') : t('还差：取消理由', 'Enter the cancellation reason'),
    action: <><Button variant="ghost" disabled={write.mutation.isPending} onClick={() => setPanel(null)}>{t('返回', 'Back')}</Button>
      <Button variant="destructive" disabled={blocked || !cancelNote.trim()} onClick={() => write.mutation.mutate({ operation: 'inpatient.surgery.cancel', input: { ...common, note: cancelNote.trim() } }, close)}>{t('确认取消手术申请', 'Cancel surgery request')}</Button></>,
  }
    : panel === 'consent' && !row.consentConfirmation ? {
      priority: 50,
      tone: consentNote.trim() ? 'normal' as const : 'blocked' as const,
      busy: pending('inpatient.surgery.confirm-consent') ? t('正在确认知情同意书', 'Confirming signed consent') : undefined,
      reason: consentNote.trim() ? t('确认后记入「开始手术还差」清单', 'Confirmation is recorded in the preparation checklist') : t('还差：签署说明', 'Enter the consent note'),
      action: <><Button variant="ghost" disabled={write.mutation.isPending} onClick={() => setPanel(null)}>{t('取消', 'Cancel')}</Button>
        <Button aria-busy={pending('inpatient.surgery.confirm-consent') || undefined} data-busy={pending('inpatient.surgery.confirm-consent') || undefined} data-unavailable={!write.mutation.isPending && (blocked || !consentNote.trim()) || undefined} disabled={blocked || !consentNote.trim()} onClick={() => write.mutation.mutate({ operation: 'inpatient.surgery.confirm-consent', input: { ...common, note: consentNote.trim() } }, close)}>{pending('inpatient.surgery.confirm-consent') ? <Spinner aria-hidden="true" data-icon="inline-start" /> : null}{pending('inpatient.surgery.confirm-consent') ? t('正在确认知情同意书', 'Confirming signed consent') : t('确认手术知情同意书已签', 'Confirm signed consent')}</Button></>,
    }
      : {
        priority: ready ? 20 : -20,
        tone: ready && !blocked ? 'normal' as const : 'blocked' as const,
        busy: undefined,
        reason: missing.length > 0 ? `${t('还差：', 'Still needed: ')}${missing.join(t('、', ', '))}` : t('开始后逐笔登记耗材；术式费在完成手术时计入', 'Record materials one by one after starting; the procedure fee is posted at completion'),
        action: <>{ready ? <Button ref={batchTrigger} variant="outline" disabled={blocked} onClick={() => setPanel('batch')}>{t('整台补录', 'Record entire surgery')}</Button> : null}
          <Button ref={startTrigger} disabled={blocked || !ready} onClick={() => { setActualId(null); setPanel('start') }}>{t('开始手术', 'Start surgery')}</Button></>,
      }
  const nextStep = preparation?.step ?? (!row.consentConfirmation ? 'consent' : !row.preopCheck ? 'nurse' : 'start')
  if (panel === null && nextStep !== 'start') {
    bar.reason = surgeryStepLabel(nextStep, locale)
    bar.action = <Button disabled={blocked || nextStep !== 'consent'} onClick={() => setPanel('consent')}>{surgeryStepLabel(nextStep, locale)}</Button>
  }
  const procedureItems = (catalog?.procedures ?? []).map(item => ({ value: item.id, label: `${item.coding.code} · ${item.coding.display}` }))
  const actualField = <Field><FieldLabel htmlFor={`surgery-actual-${row.id}`}>{t('实际术式', 'Performed procedure')}</FieldLabel><WorkspaceSelect id={`surgery-actual-${row.id}`} value={actual?.id ?? null} items={procedureItems} onValueChange={setActualId} />
    <FieldDescription>{actual && actual.coding.code !== row.plannedProcedure.coding.code ? `${t('与计划不同（计划：', 'Differs from plan (')}${row.plannedProcedure.coding.display}${t('）；DRG 预分组按实际术式重算', '); DRG is recalculated with the performed procedure')}` : t('默认与计划术式相同', 'Defaults to the planned procedure')}</FieldDescription></Field>
  const preparationContent = <div hidden={doctor && !focused} className="flex flex-col gap-4">
    {!preparationReady ? <section aria-label={preparationTitle} className="rounded-lg border border-dashed px-3.5 py-2.5 text-sm text-muted-foreground"><h4>{preparationTitle}</h4><p>{t('确认手术耗材后办理术前准备', 'Confirm surgical materials before preoperative preparation')}</p></section> : <section aria-label={preparationTitle} className="clinmesh-inpatient-preparation"><h4 className="font-medium">{doctor ? '3 · ' : ''}{preparationTitle}</h4>
      <ul className="clinmesh-inpatient-preparation-list">{[
        { key: 'consent', title: t('手术知情同意书已签', 'Signed surgical consent'), owner: t('住院医生', 'Inpatient doctor'), record: row.consentConfirmation },
        { key: 'preop', title: t('术前核对', 'Preoperative checks'), owner: t('病区护士', 'Ward nurse'), record: row.preopCheck },
      ].map(item => <li key={item.key} data-complete={!!item.record}>
        {item.record ? <CheckCircle2Icon aria-hidden="true" /> : <CircleIcon aria-hidden="true" />}
        <div><strong>{item.title}</strong><span className="text-xs text-muted-foreground">{item.record ? t('已完成', 'Completed') : t('待完成', 'Pending')}</span></div>
        <div className="clinmesh-inpatient-preparation-owner"><span>{item.owner}</span>{item.record ? <time dateTime={item.record.recordedAt}>{formatShanghaiMinute(item.record.recordedAt).slice(5)}</time> : null}
          {item.key === 'consent' && doctor && active && focused && !item.record && panel !== 'consent' ? <Button variant="outline" size="sm" disabled={blocked} onClick={() => setPanel('consent')}>{t('确认已签', 'Confirm signed')}</Button> : null}</div>
        {item.record ? <p className="col-span-2 col-start-2 text-xs text-muted-foreground">{t('说明：', 'Note: ')}{item.record.note}</p> : null}
        {item.key === 'consent' && panel === 'consent' && !item.record ? <Field className="col-span-2 col-start-2"><FieldLabel htmlFor={`surgery-consent-${row.id}`}>{t('签署说明', 'Consent note')}</FieldLabel><div className="flex flex-wrap gap-2">{[["患者及家属已签署手术知情同意书", "The patient and family have signed the surgical consent"], ["患者本人已签署手术知情同意书", "The patient has signed the surgical consent"]].map(([cn, en]) => t(cn!, en!)).map(value => <Button key={value} type="button" variant="outline" size="sm" disabled={blocked} onClick={() => setConsentNote(value)}>{value}</Button>)}</div><Input id={`surgery-consent-${row.id}`} autoFocus maxLength={2000} disabled={blocked} value={consentNote} onChange={event => setConsentNote(event.currentTarget.value)} /></Field> : null}
        {item.key === 'preop' && nurse && active && !item.record ? <Field className="col-span-2 col-start-2"><FieldLabel htmlFor={`surgery-preop-${row.id}`}>{t('术前核对说明', 'Preoperative check note')}</FieldLabel><Input id={`surgery-preop-${row.id}`} maxLength={2000} disabled={blocked} value={preopNote} onChange={event => setPreopNote(event.currentTarget.value)} /></Field> : null}
      </li>)}</ul>
    </section>}
    {nurse && active && focused && !row.preopCheck ? <InpatientPrimaryAction stage="surgery" priority={1} fallback={<Button className="self-start" aria-busy={pending('inpatient.surgery.check-preop') || undefined} data-busy={pending('inpatient.surgery.check-preop') || undefined} data-unavailable={!write.mutation.isPending && (blocked || !preopNote.trim()) || undefined} disabled={blocked || !preopNote.trim()} onClick={() => write.mutation.mutate({ operation: 'inpatient.surgery.check-preop', input: { ...common, note: preopNote.trim() } })}>{pending('inpatient.surgery.check-preop') ? <Spinner aria-hidden="true" data-icon="inline-start" /> : null}{pending('inpatient.surgery.check-preop') ? t('正在术前核对', 'Recording preoperative checks') : t('术前核对', 'Record preoperative checks')}</Button>}><WorkspaceActionBar summary={row.plannedProcedure.coding.display} tone={blocked || !preopNote.trim() ? 'blocked' : 'normal'} reason={preopNote.trim() ? t('已填写术前核对说明，可提交术前核对', 'Ready to record preoperative checks') : t('还差：术前核对说明', 'Complete: Preoperative check note')} busy={pending('inpatient.surgery.check-preop') ? t('正在术前核对', 'Recording preoperative checks') : undefined} action={<Button aria-busy={pending('inpatient.surgery.check-preop') || undefined} data-busy={pending('inpatient.surgery.check-preop') || undefined} data-unavailable={!write.mutation.isPending && (blocked || !preopNote.trim()) || undefined} disabled={blocked || !preopNote.trim()} onClick={() => write.mutation.mutate({ operation: 'inpatient.surgery.check-preop', input: { ...common, note: preopNote.trim() } })}>{pending('inpatient.surgery.check-preop') ? <Spinner aria-hidden="true" data-icon="inline-start" /> : null}{pending('inpatient.surgery.check-preop') ? t('正在术前核对', 'Recording preoperative checks') : t('术前核对', 'Record preoperative checks')}</Button>} /></InpatientPrimaryAction> : null}
    {doctor && (preparationReady || panel === 'cancel') && active && focused && panel !== 'start' && panel !== 'batch' ? <InpatientPrimaryAction stage="surgery" priority={bar.priority} fallback={bar.action}><WorkspaceActionBar summary={row.plannedProcedure.coding.display} tone={bar.tone} reason={bar.reason} busy={bar.busy} action={bar.action} /></InpatientPrimaryAction> : null}
    {doctor && active ? <Dialog open={panel === 'start' && focused} pending={write.mutation.isPending} onOpenChange={open => { if (!open) setPanel(null) }}>
      <DialogContent className="max-h-[calc(100%-2rem)] sm:max-w-[640px]" showCloseButton={!write.mutation.isPending} finalFocus={() => startTrigger.current}>
      <DialogHeader>
        <DialogTitle>{t('开始手术', 'Start surgery')}</DialogTitle>
        <DialogDescription>{t('开始时不登记耗材、不收术式费。', 'Starting records no materials or procedure fee.')}{actual ? `${t('术式费 ', ' Procedure fee ')}${formatFen(actual.chargeDefinition.priceFen, locale)}${t(' 在完成手术时计入。', ' is posted at completion.')}` : null}</DialogDescription>
      </DialogHeader>
      <form className="flex min-h-0 flex-col p-0" onSubmit={event => { event.preventDefault(); start() }}>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
          {write.mutation.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(write.mutation.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
          <FieldSet disabled={blocked}><FieldGroup>{actualField}
            <Field><FieldLabel htmlFor={`surgery-start-${row.id}`}>{t('开始说明', 'Start note')}</FieldLabel><div className="flex flex-wrap gap-2">{[["术前准备已完成，按计划开始手术", "Preoperative preparation complete; start as planned"], ["核对患者、术式及部位无误，开始手术", "Patient, procedure and site verified; start surgery"]].map(([cn, en]) => t(cn!, en!)).map(value => <Button key={value} type="button" variant="outline" size="sm" disabled={blocked} onClick={() => setStartNote(value)}>{value}</Button>)}</div><Input id={`surgery-start-${row.id}`} maxLength={2000} value={startNote} onChange={event => setStartNote(event.currentTarget.value)} /></Field>
          </FieldGroup></FieldSet>
        </div>
        <OrderComposerFooter hint={startNote.trim() ? t('开始后在本页逐笔登记耗材', 'Record materials on this page after starting') : t('还差：开始说明', 'Enter the start note')}>
          <Button type="button" variant="outline" disabled={write.mutation.isPending} onClick={() => setPanel(null)}>{t('取消', 'Cancel')}</Button>
          <Button type="submit" aria-busy={pending('inpatient.surgery.start') || undefined} disabled={blocked || !ready || !actual || !startNote.trim()}>{pending('inpatient.surgery.start') ? <Spinner aria-hidden="true" data-icon="inline-start" /> : null}{t('开始手术', 'Start surgery')}</Button>
        </OrderComposerFooter>
      </form>
    </DialogContent></Dialog> : null}
    {doctor && active ? <SurgeryExecuteComposer admission={admission} session={session} request={row} catalog={catalog} reservations={reservations} locale={locale} write={write}
      dataReady={dataReady} onRetry={onRetry} open={panel === 'batch'} focused={focused} onOpenChange={open => setPanel(open ? 'batch' : null)} returnFocus={batchTrigger} /> : null}</div>
  return <article role="region" aria-label={focused ? t('当前手术计划', 'Current surgery plan') : t('手术计划记录', 'Surgery plan record')} className="flex min-w-0 flex-col gap-4">
    <div className="clinmesh-inpatient-summary flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2"><h4 className="font-semibold">{row.plannedProcedure.coding.display}</h4><span className="font-mono text-xs text-muted-foreground">{row.plannedProcedure.coding.code}</span><span className="flex-1" /><Badge variant="outline">{status}</Badge>
        {doctor && active && focused ? <Button variant="ghost" size="sm" aria-expanded={panel === 'cancel'} disabled={blocked} onClick={() => setPanel(panel === 'cancel' ? null : 'cancel')}>{t('取消申请', 'Cancel request')}</Button> : null}</div>
      <dl className="grid gap-3 text-sm @lg:grid-cols-3"><div><dt className="text-xs text-muted-foreground">{t('计划手术时间（上海时间）', 'Planned surgery time (Shanghai)')}</dt><dd className="tabular-nums">{formatShanghaiMinute(row.plannedFor).slice(5)}</dd></div>
        {nurse ? <div><dt className="text-xs text-muted-foreground">{t('申请医生', 'Requesting doctor')}</dt><dd>{t('住院医生', 'Inpatient doctor')}</dd></div>
          : planned.length > 0 ? <div><dt className="text-xs text-muted-foreground">{t('预计耗材', 'Estimated materials')}</dt><dd className="tabular-nums">{formatFen(plannedFen, locale)} · {t('已预留', 'Reserved')}</dd></div>
          : ready && pciSelectionProcedureCodes.includes(row.plannedProcedure.coding.code) ? <div><dt className="text-xs text-muted-foreground">{t('术前准备', 'Preop preparation')}</dt><dd>{t('同意书、术前核对已完成', 'Consent & preop check complete')}</dd></div> : null}
        <div><dt className="text-xs text-muted-foreground">{t('申请理由', 'Request reason')}</dt><dd>{row.reason}</dd></div></dl>
      {panel === 'cancel' ? <Field><FieldLabel htmlFor={`surgery-cancel-${row.id}`}>{t('取消理由', 'Cancellation reason')}</FieldLabel><Input id={`surgery-cancel-${row.id}`} autoFocus maxLength={2000} disabled={blocked} value={cancelNote} onChange={event => setCancelNote(event.currentTarget.value)} /></Field> : null}
      {row.cancellation ? <p className="text-sm">{t('取消原因：', 'Cancellation: ')}{row.cancellation.note}</p> : null}
    </div>
    {doctor && preparationSlot ? createPortal(preparationContent, preparationSlot) : preparationContent}
  </article>
}
