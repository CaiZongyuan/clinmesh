import { inpatientFinancialSchema } from '@clinmesh/contracts/inpatient-finance'
import { InpatientPatientHeader, InpatientStageCard, InpatientTabs } from './inpatient-layout.tsx'
import { InpatientRecordDrgSummary } from './inpatient-record-drg.tsx'
import { inpatientPaymentsSchema } from '@clinmesh/contracts/inpatient-discharge'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientTransfersSchema } from '@clinmesh/contracts/inpatient-transfer'
import { inpatientStageSchema, type InpatientStage } from '@clinmesh/contracts/agent'
import { scenarioStateSchema, type SessionContext } from '@clinmesh/contracts/his'
import { inpatientCatalogSchema, type InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { z } from 'zod'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Field, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { TabsContent } from '@clinmesh/ui/components/tabs'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { cn } from '@clinmesh/ui/lib/utils'
import { CheckIcon, SparklesIcon } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { InpatientClinical } from './inpatient-clinical.tsx'
import { InpatientDoctorReminders } from './inpatient-doctor-reminders.tsx'
import { InpatientNumber } from './inpatient-number.tsx'
import { inpatientCareDay, inpatientScopeKey } from './inpatient-scope.ts'
import { InpatientDrgPanel } from './inpatient-drg.tsx'
import { inpatientDrgFollowupResponseSchema, inpatientDrgFollowupSchema } from '@clinmesh/contracts/inpatient-drg-followup'
import { InpatientDrgUsagePanel } from './inpatient-drg-usage.tsx'
import { InpatientCharges } from './inpatient-charges.tsx'
import { InpatientDischarge, InpatientSettlement, inpatientDepartureLabel } from './inpatient-discharge.tsx'
import { InpatientInvestigations } from './inpatient-investigations.tsx'
import { InpatientRecord, inpatientRecordPhase } from './inpatient-record.tsx'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { InpatientSurgery } from './inpatient-surgery.tsx'
import { InpatientTransfers } from './inpatient-transfers.tsx'
import { inpatientDefaultStage, inpatientFlow, inpatientInvestigationWaiting, inpatientPending, inpatientStageTabs } from './inpatient-stage-activity.ts'
import { WorkspaceCardLayout, WorkspaceCard, WorkspaceActionBar, announceHandoff, useWorkspaceCardView } from './workspace-card-layout.tsx'
import { InpatientActionProvider, InpatientActionOutlet, InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { InpatientAgentProvider, useInpatientAgentTools } from './inpatient-agent-tools.tsx'
import { useAgentReviewTitle } from './agent-review.tsx'
import { pciSelectionProcedureCodes } from '@clinmesh/contracts/inpatient-pci-selection'
import { useInpatientPciPreparation } from './inpatient-pci-preparation.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { isInpatientDraftSave } from './inpatient-write-intent.ts'
import { apiGet } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { OrderComposerFooter } from './doctor/order-composer-layout.tsx'
import { formatFen, formatShanghaiMinute } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { patientAge } from './doctor/patient-summary.tsx'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages } from './workspace-i18n.ts'

const patientIdentitySchema = z.object({ resourceType: z.literal('Patient'), id: z.string().min(1),
  gender: z.enum(['female', 'male', 'other', 'unknown']).optional(), birthDate: z.iso.date().optional() })

export function inpatientStatus(admission: InpatientAdmission, locale: WorkspaceLocale, role?: string): string {
  const zh = locale === 'zh-CN'
  if (admission.recordStatus === 'archived') return role !== undefined ? (zh ? '已归档 · 只读' : 'Archived · read only') : (zh ? '已归档' : 'Archived')
  if (role === 'medical-records') {
    return admission.recordStatus === 'reviewed' ? (zh ? '审核通过' : 'Approved') : (zh ? '待编码审核' : 'Awaiting coding review')
  }
  return { registered: zh ? '待入科' : 'Registered', admitted: zh ? '在院' : 'Admitted', 'discharge-pending': zh ? '待出院' : 'Discharge pending',
    departed: admission.financialStatus === 'settled' ? zh ? '已结算 · 待清床' : 'Settled · awaiting bed clearance' : zh ? '已出院 · 待结算' : 'Discharged · awaiting settlement', cleared: zh ? '已清床' : 'Bed cleared' }[admission.status]
}

export function formatLabResultDisplay(display: string): string {
  const head = display.split(':')[0]?.trim() ?? display
  if (head.includes('INR')) return 'INR'
  return ({
    '心脏肌钙蛋白I': '肌钙蛋白 I',
    '氨基末端B型利钠肽原': 'NT-proBNP',
  } as Record<string, string>)[head] ?? head
}

export function formatLabReferenceRange(text: string): string {
  return text.replace(/（合成院内参考区间）|\(synthetic.*?\)/gi, '').replace(/\s+1$/, '').trim()
}

/** 助手实际准备、正等本岗位确认的审阅（如校对医嘱、已阅报告）；没有时不占行。 */
function compactPreparedStatus(status: string) {
  return ({
    '读取失败，请重试': '读取失败', '已修订，待核对': '已修订', '尚无造影报告，可手填': '选型待填写',
    '已准备，只读': '已准备', '已准备，资料仍需补充': '已准备·待补资料', '结果未知，先核查原请求': '结果未知',
    '规则费用可查，说明尚未准备': '说明待准备', '正在生成并核验': '生成核验中',
    '暂不可用，请核对设置与权限': '暂不可用', '生成或核验失败': '准备失败',
    '依据已变化，需更新': '需更新', '依据已变化，需重评': '需重评', '未通过独立核验': '核验未通过',
    'Could not load; retry': 'Load failed', 'Edited; review needed': 'Edited', 'No angiography report; enter manually': 'Input needed',
    'Prepared; read only': 'Prepared', 'Prepared; patient facts incomplete': 'Prepared · facts needed',
    'Outcome unknown; check the original request': 'Unknown outcome', 'Rule-based costs available; explanation not prepared': 'Explanation pending',
    'Generating and verifying': 'Preparing', 'Unavailable; check settings and permissions': 'Unavailable',
    'Generation or verification failed': 'Preparation failed', 'Sources changed; update needed': 'Update needed',
    'Sources changed; reassess': 'Reassess', 'Independent verification rejected': 'Verification failed',
  } as Record<string, string>)[status] ?? status
}

function InpatientAssistantPrepared({ locale, pci, activeStage, followOn, onOpenSurgery, onOpenDrg }: {
  locale: WorkspaceLocale; pci: ReturnType<typeof useInpatientPciPreparation>; activeStage: InpatientStage; followOn: boolean; onOpenSurgery(): void; onOpenDrg(): void
}): React.JSX.Element | null {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const review = useAgentReviewTitle()
  const id = useId()
  const surgeryChips = activeStage === 'surgery' || (!pci.showPrepared && !followOn) ? [] : pci.items.filter(item => item.ready || (followOn && item.active))
  const drgChip = followOn && activeStage !== 'drg'
  if (review === undefined && surgeryChips.length === 0 && !drgChip) return null
  return <section aria-label={t('助手已准备', 'Assistant prepared')} className="clinmesh-inpatient-assistant">
    <span className="clinmesh-inpatient-assistant-lead"><SparklesIcon aria-hidden="true" className="size-3.5" />{t('助手已准备', 'Assistant prepared')}</span>
    <div className="clinmesh-inpatient-assistant-items">
    {review === undefined ? null : <span className="inline-flex h-6 items-center rounded-md border border-info/40 px-2 text-info">{review} · {t('等你确认', 'awaiting you')}</span>}
    {surgeryChips.map(item => <Button key={`${item.requestId}-${item.kind}`} type="button" variant="outline" size="sm" className="border-info/40 text-start text-info"
      title={`${item.planLabel} · ${item.label} · ${item.status}`} aria-label={`${t('前往手术', 'Open surgery')}：${item.planLabel} · ${item.label}`} aria-describedby={`${id}-${item.requestId}-${item.kind}`}
      onClick={onOpenSurgery}><span aria-hidden="true">{locale === 'zh-CN' ? item.label : ({ selection: 'Selection', materials: 'Materials', costs: 'Costs', guidelines: 'Guidelines' } as Record<string, string>)[item.kind] ?? item.label} · <strong>{compactPreparedStatus(item.status)}</strong></span><span className="sr-only" id={`${id}-${item.requestId}-${item.kind}`}>{item.label} · {item.status}</span></Button>)}
    {drgChip ? <Button type="button" variant="outline" size="sm" className="border-info/40 text-start text-info"
      aria-label={t('前往 DRG 预分组：分组差异', 'Open DRG pre-grouping: grouping differences')}
      onClick={onOpenDrg}><span>{t('分组差异 · ', 'Grouping differences · ')}<strong>{t('已说明 1 项', '1 explained')}</strong></span></Button> : null}
    </div>
  </section>
}

type Props = { allowTransfers: boolean; admission: InpatientAdmission; admissions: InpatientAdmission[]; catalog: z.infer<typeof inpatientCatalogSchema> | undefined; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>; queue?: ReactNode; notices?: ReactNode; onBeforeRecordAction?: React.ComponentProps<typeof InpatientRecord>['onBeforeRecordAction']; recordContinuation?: ReactNode }

const stageOwners: Record<InpatientStage, string[]> = {
  admission: ['病区护士接诊分床'], orders: ['住院医生开立医嘱', '病区护士校对', '药师发药', '病区护士执行'],
  investigations: ['住院医生申请', '病区护士送检', '医技科室出报告', '住院医生已阅'], surgery: ['住院医生申请及知情同意', '病区护士术前核对', '住院医生实施手术'],
  transfer: ['住院医生申请', '病区护士交接及接收'], fees: ['发生诊疗费用', '收费员核对费用明细', '出院结算'], discharge: ['住院医生开出院医嘱', '病区护士办理出院', '收费员结算', '病区护士清床'],
  record: ['住院医生提交首页', '病案人员编码审核', '归档'], drg: ['住院医生确认诊断与手术', 'AI 预分组', '病案编码审核'],
}
const stageOwnersEn: Record<InpatientStage, string[]> = {
  admission: ['Ward nurse receives and assigns bed'], orders: ['Inpatient doctor issues orders', 'Ward nurse verifies', 'Pharmacist dispenses', 'Ward nurse administers'],
  investigations: ['Inpatient doctor requests', 'Ward nurse dispatches', 'Investigation staff report', 'Inpatient doctor reviews'], surgery: ['Inpatient doctor plans and confirms consent', 'Ward nurse checks preparation', 'Inpatient doctor performs surgery'],
  transfer: ['Inpatient doctor requests', 'Ward nurses hand over and receive'], fees: ['Incur clinical charges', 'Cashier reconciles charge items', 'Discharge settlement'], discharge: ['Inpatient doctor orders discharge', 'Ward nurse records discharge', 'Cashier settles', 'Ward nurse clears bed'],
  record: ['Inpatient doctor submits record', 'Medical records staff review coding', 'Archive'], drg: ['Inpatient doctor confirms diagnoses & procedures', 'AI pre-grouping', 'Coding review'],
}

export function InpatientPatientWorkspace({ admission, admissions, catalog, allowTransfers, session, locale, write, queue, notices, onBeforeRecordAction, recordContinuation }: Props): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const client = useQueryClient()
  const role = session.actor.roleCode, nurse = role === 'ward-nurse', doctor = role === 'inpatient-doctor', cashier = role === 'cashier'
  const careOpen = (doctor || nurse) && admission.recordStatus !== 'archived'
  const scope = inpatientScopeKey(session)
  const settled = admission.financialStatus === 'settled'
  const funds = useQuery({ queryKey: [...scope, admission.id, 'payments'], enabled: cashier && !settled,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/payments`, inpatientPaymentsSchema, signal) })
  const adjustments = useQuery({ queryKey: [...scope, admission.id, 'financial-adjustments'], enabled: cashier && settled,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/financial-adjustments`, inpatientFinancialSchema, signal) })
  const scenario = useQuery({ queryKey: ['scenario', 'virtual-time'], queryFn: ({ signal }) => apiGet('/api/sim/v1/scenario-runs/current', scenarioStateSchema, signal), retry: false })
  const identity = useQuery({ queryKey: [...scope, admission.patientId, 'patient-identity'], queryFn: ({ signal }) => apiGet(
    `/fhir/R5/Patient/${admission.patientId}`, patientIdentitySchema.refine(patient => patient.id === admission.patientId), signal) })
  const clinical = useQuery({ queryKey: [...scope, admission.id, 'clinical'], enabled: careOpen, queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/clinical`, inpatientFullClinicalSchema, signal) })
  const investigations = useQuery({ queryKey: [...scope, admission.id, 'investigations'], enabled: careOpen, queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/investigations`, inpatientInvestigationsSchema, signal) })
  const surgery = useQuery({ queryKey: [...scope, admission.id, 'surgeries'], enabled: careOpen, queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/surgeries`, inpatientSurgerySchema, signal) })
  const transfers = useQuery({ queryKey: [...scope, admission.id, 'transfers'], enabled: careOpen && allowTransfers, queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/transfers`, inpatientTransfersSchema, signal) })
  const careReads = careOpen ? [
    { key: 'orders', query: clinical, label: t('医嘱资料读取失败：', 'Order data failed to load: '), retryLabel: t('重试医嘱资料', 'Retry order data') },
    { key: 'investigations', query: investigations, label: t('检查检验资料读取失败：', 'Investigation data failed to load: '), retryLabel: t('重试检查检验资料', 'Retry investigation data') },
    { key: 'surgery', query: surgery, label: t('手术资料读取失败：', 'Surgery data failed to load: '), retryLabel: t('重试手术资料', 'Retry surgery data') },
    ...(allowTransfers ? [{ key: 'transfer', query: transfers, label: t('转科交接资料读取失败：', 'Transfer data failed to load: '), retryLabel: t('重试转科交接资料', 'Retry transfer data') }] : []),
  ] : []
  const id = `inpatient-${session.actor.workspaceId}-${session.actor.epoch}-${session.actor.practitionerRoleId}-${admission.id}`
  const view = useWorkspaceCardView(id), chosen = inpatientStageSchema.safeParse(view.tab)
  // 与病案页同键，在医生打开病案页或已结算患者计算病案待办时读取，用于第一行写清提交、退回或等待审核并更新角标。
  const record = useQuery({ queryKey: [...scope, admission.id, 'record'], enabled: (doctor && (chosen.data === 'record' || (admission.financialStatus === 'settled' && admission.recordStatus === 'open'))) || admission.recordStatus === 'archived', queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/record`, inpatientRecordSchema, signal) })
  const activity = { admission, role, ...(careOpen ? { clinical: clinical.data, investigations: investigations.data, surgery: surgery.data, transfers: transfers.data } : {}), record: record.data, virtualTime: scenario.data?.virtualTime }
  const activeSurgeryPlans = (surgery.data?.requests ?? []).filter(plan => ['requested', 'ready'].includes(plan.status)
    && !surgery.data?.inProgress.some(execution => execution.requestId === plan.id))
  const pciPlans = activeSurgeryPlans.filter(plan => pciSelectionProcedureCodes.includes(plan.plannedProcedure.coding.code))
  const pciPreparation = useInpatientPciPreparation({ admission, session, plans: pciPlans, allPlans: activeSurgeryPlans, locale })
  const tabs = inpatientStageTabs(activity, allowTransfers, locale)
  const counts = inpatientPending(activity)
  const selectedStage = chosen.success && tabs.some(tab => tab.value === chosen.data) ? chosen.data : undefined
  const defaultStage = inpatientDefaultStage(activity, tabs)
  const active = selectedStage ?? defaultStage
  const [followDialog, setFollowDialog] = useState<'start' | 'stop' | null>(null)
  const [stopReason, setStopReason] = useState('')
  const [usageOpen, setUsageOpen] = useState(false)
  const [usageTarget, setUsageTarget] = useState<{ taskId?: string | undefined; taskKind?: 'estimate' | 'followup' | 'explanation' | 'guideline' | undefined }>({})
  const followupEnabled = doctor && admission.status !== 'registered'
  const followup = useQuery({ queryKey: [...scope, admission.id, 'drg-followup'], enabled: followupEnabled, retry: false,
    refetchInterval: followupEnabled && admission.recordStatus !== 'archived' ? 3_000 : false, refetchIntervalInBackground: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/followup`, inpatientDrgFollowupSchema, signal) })
  const followTask = followup.error === null ? followup.data?.task : undefined
  const followOn = followTask?.status === 'active'
  const followStatus = followTask ? {
    active: t('正在跟进', 'Active'), stopped: t('已停止', 'Stopped'),
    'authorization-lost': t('权限已失效，待交接', 'Authorization lost; handoff pending'),
    archived: t('已归档，停止临床分析', 'Archived; analysis ended'),
  }[followTask.status] : admission.recordStatus === 'archived' ? t('已归档 · 用量只读', 'Archived · usage is read only') : undefined
  const followError = write.mutation.variables?.operation.startsWith('inpatient.drg.followup.')
    && 'admissionId' in write.mutation.variables.input && write.mutation.variables.input.admissionId === admission.id ? write.mutation.error : null
  const defaultReady = !scenario.isPending && (!careOpen || !clinical.isPending && !investigations.isPending && !surgery.isPending && (!allowTransfers || !transfers.isPending))
  const setTab = view.setTab
  useEffect(() => {
    // 分床前保留入科后的默认落点；其他阶段只在初次资料就绪时选择，办理后不随待办变化跳页。
    if (selectedStage === undefined && defaultReady && admission.status !== 'registered') setTab(defaultStage)
  }, [admission.status, defaultReady, defaultStage, selectedStage, setTab])
  const [visited, setVisited] = useState<InpatientStage[]>([])
  const [dismissedSucceededAt, setDismissedSucceededAt] = useState(0)
  const [succeededState, setSucceededState] = useState<{ at: number; stage: InpatientStage } | null>(null)
  const completedCommand = write.mutation.isSuccess ? write.mutation.data.command : undefined
  const foregroundSuccess = completedCommand !== undefined && !isInpatientDraftSave(completedCommand)
    && (!('admissionId' in completedCommand.input) || completedCommand.input.admissionId === admission.id)
  const succeededAt = foregroundSuccess ? write.mutation.submittedAt : 0
  useEffect(() => {
    if (succeededAt > 0 && succeededState?.at !== succeededAt) {
      setSucceededState({ at: succeededAt, stage: active })
    }
  }, [active, succeededAt, succeededState?.at])
  const surgeryAllDone = (surgery.data?.inProgress.length ?? 0) === 0
    && !(surgery.data?.requests ?? []).some(r => ['requested', 'ready'].includes(r.status))
    && (surgery.data?.executions.length ?? 0) > 0
  const stageAllowsCompletionBar = active !== 'drg' && !(doctor && (active === 'admission' || active === 'fees')) && !(doctor && active === 'surgery' && surgeryAllDone)
  const showForegroundSuccess = foregroundSuccess && dismissedSucceededAt !== succeededAt && (succeededState === null || succeededState.stage === active) && stageAllowsCompletionBar
  const changeStage = (value: string) => {
    const parsed = inpatientStageSchema.safeParse(value)
    if (parsed.success && tabs.some(tab => tab.value === value)) {
      if (parsed.data !== active && succeededAt > 0) setDismissedSucceededAt(succeededAt)
      setVisited(current => [...new Set([...current, active, parsed.data])])
      view.setTab(parsed.data)
    }
  }
  const careDay = inpatientCareDay(admission, scenario.data?.virtualTime)
  const age = scenario.data && identity.data?.birthDate ? patientAge(identity.data.birthDate, new Date(Date.parse(scenario.data.virtualTime) + 8 * 60 * 60 * 1000)) : undefined
  const gender = identity.data?.gender === 'female' ? t('女', 'Female') : identity.data?.gender === 'male' ? t('男', 'Male') : identity.data?.gender === 'other' ? t('其他', 'Other') : t('性别未登记', 'Gender unavailable')
  const ward = catalog?.wards.find(item => item.id === admission.wardId), bed = catalog?.beds.find(item => item.id === (admission.bedId ?? admission.lastBedId))
  const bedDisplay = bed?.name ? (admission.status === 'cleared' ? t(`原 ${bed.name}`, `prev. ${bed.name}`) : bed.name) : (admission.status === 'cleared' ? t('已清床', 'Bed cleared') : t('未分床', 'Unassigned'))
  const place = ward === undefined ? '—' : `${ward.name} · ${bedDisplay}`
  const agent = useInpatientAgentTools({ admission, session, stage: active, stages: tabs, onStageChange: changeStage, clinical: careOpen ? clinical.data : undefined, investigations: careOpen ? investigations.data : undefined, bedLabel: place, write, locale })
  const nurseClosingOrders = nurse && admission.status === 'discharge-pending'
  const awaitingDoctorStop = nurseClosingOrders && clinical.data?.orders.some(order => ['signed', 'verified'].includes(order.state))
  const awaitingNurseStop = nurseClosingOrders && clinical.data?.orders.some(order => order.state === 'stop-requested')
  const stopWaiting = awaitingDoctorStop ? t('等住院医生申请停嘱，再由病区护士核对停嘱。', 'Waiting for the inpatient doctor to request order stops, then the ward nurse verifies them.')
    : awaitingNurseStop ? t('等病区护士在诊断医嘱核对停嘱，再办理出院。', 'Waiting for the ward nurse to verify order stops under Diagnoses & orders before discharge.') : undefined
  const closingOrdersWaiting = clinical.data === undefined ? t('请先读取医嘱资料，核对停嘱情况。', 'Load the order data before checking order stops.')
    : t('医嘱已结束，请在出院环节继续办理。', 'Orders are closed. Continue under Discharge.')
  const failedInvestigations = [...investigations.data?.laboratoryRequests ?? [], ...investigations.data?.imagingRequests ?? []].filter(request => request.status === 'generation-failed').length
  const unreadInvestigations = [...investigations.data?.laboratoryRequests ?? [], ...investigations.data?.imagingRequests ?? []].filter(request => request.status === 'reported' && request.report !== undefined).length
  const hasFailedInvestigation = failedInvestigations > 0
  const fixedStay = admission.departedAt !== undefined || admission.status === 'departed' || admission.status === 'cleared' || admission.recordStatus === 'archived'
  const balanceRead = settled ? adjustments : funds
  const remainingFen = settled ? adjustments.data === undefined ? undefined
    : adjustments.data.remainingCollectFen > 0 ? adjustments.data.remainingCollectFen : -adjustments.data.remainingRefundFen : funds.data?.remainingFen
  const actions: Record<InpatientStage, string> = {
    admission: t('接诊并分床', 'Receive and assign bed'), orders: nurse ? nurseClosingOrders ? t('核对停嘱', 'Verify order stops') : t('校对或执行医嘱', 'Verify or execute orders') : t('确认住院诊断', 'Confirm diagnoses'),
    investigations: nurse ? t('校对并送检', 'Verify and send') : unreadInvestigations > 0 ? t('已阅报告', 'Review reports') : hasFailedInvestigation ? t(`处理生成失败的检验（${failedInvestigations} 项）`, `Handle failed investigations (${failedInvestigations})`) : t('已阅报告', 'Review reports'), surgery: nurse ? t('术前核对', 'Preoperative checks') : t('完成手术准备或实施手术', 'Prepare or perform surgery'),
    transfer: t('办理转科交接', 'Complete transfer'), fees: t('核对费用明细', 'Reconcile charge items'),
    discharge: doctor ? t('开出院医嘱', 'Order discharge') : nurse ? admission.financialStatus === 'settled' ? t('清床', 'Clear bed') : t('办理出院', 'Record discharge') : (remainingFen !== undefined && remainingFen < 0 ? t('结算并退还余款', 'Settle and refund balance') : remainingFen === 0 ? t('结算', 'Settle') : t('补交并结算', 'Collect and settle')),
    record: t('核对病案首页', 'Review medical record'), drg: t('核对诊断和手术', 'Review diagnoses and procedures'),
  }
  const waiting: Record<InpatientStage, string> = {
    admission: t('入科登记已完成', 'Admission received'), orders: stopWaiting ?? (nurseClosingOrders ? closingOrdersWaiting : clinical.data?.orders.some(order => order.state === 'signed') ? t('等病区护士校对医嘱', 'Waiting for the ward nurse to verify orders') : t('等住院医生开立医嘱，或药师发药和护士按时执行', 'Waiting for doctor orders, dispensing or scheduled nurse execution')),
    investigations: inpatientInvestigationWaiting(investigations.data, locale, investigations.error !== null, session.actor.roleCode), surgery: t('等医生申请手术，或完成术前准备', 'Waiting for a surgery request or preoperative preparation'), transfer: t('等医生申请或病区护士交接', 'Waiting for the doctor request or nurse handover'),
    fees: cashier ? (settled ? t('已出院结算，可查看费用明细与更正', 'Settled; view charge items and adjustments') : t('轮到你：核对费用明细，必要时补充预交金', 'Your turn: reconcile charge items and collect deposit if needed')) : nurse ? t('在院费用随医嘱和床位自动记账；退费与补交由收费员办理', 'In-stay charges accrue automatically with orders and beds; refunds and supplements are handled by the cashier') : t('等收费员核对费用', 'Waiting for the cashier to reconcile charges'),
    discharge: admission.status === 'cleared' ? t('出院结算与清床已完成', 'Departure, settlement and bed clearance are complete') : stopWaiting ?? (admission.status === 'admitted' ? t('等住院医生开出院医嘱', 'Waiting for the doctor to order discharge') : admission.status === 'departed' && admission.financialStatus === 'open' ? t('等收费员结算', 'Waiting for the cashier to settle') : t('等病区护士办理或清床', 'Waiting for the ward nurse to complete discharge or bed clearance')), record: admission.recordStatus === 'archived' ? t('病案已归档，只读可查', 'Archived record is read only') : t('等医生提交首页或病案人员审核归档', 'Waiting for record submission or medical records review'), drg: t('随诊断、手术和收费自动更新', 'Updates automatically with diagnoses, surgeries and charges'),
  }
  const doctorStops = clinical.data?.orders.filter(order => order.state === 'signed' || order.state === 'verified').length ?? 0
  const doctorSurgeryTurn = (): string => {
    const data = surgery.data
    if (!data) return waiting.surgery
    if (data.inProgress.length > 0) return t('轮到你：逐笔登记耗材，核实后完成手术', 'Your turn: record materials and complete surgery')
    const activeRequests = data.requests.filter(request => request.status === 'requested' || request.status === 'ready')
    const readyRequest = activeRequests.find(request => request.status === 'ready')
    if (readyRequest) {
      const isPciPlan = pciSelectionProcedureCodes.includes(readyRequest.plannedProcedure.coding.code)
      if (isPciPlan) {
        const draft = pciPreparation.selectionData?.drafts?.find(item => item.requestId === readyRequest.id)
        const confirmed = pciPreparation.selectionData?.confirmation?.parameters.requestId === readyRequest.id
        const estimate = pciPreparation.estimatesData?.estimates.find(item => item.requestId === readyRequest.id)
        const matConfirmed = Boolean(estimate?.draft && estimate.draft.confirmedRevision === estimate.draft.revision)
        const selDone = confirmed || Boolean(draft?.edited) || matConfirmed
        if (!selDone) return t('轮到你：确认选型参数', 'Your turn: confirm selection parameters')
        if (!matConfirmed) return t('轮到你：确认手术耗材', 'Your turn: confirm surgical materials')
      }
      return t('轮到你：开始手术', 'Your turn: start surgery')
    }
    if (activeRequests.some(request => !request.consentConfirmation)) return t('轮到你：确认手术知情同意书已签', 'Your turn: confirm signed surgical consent')
    if (activeRequests.length > 0) return t('等病区护士完成术前核对', 'Waiting for the ward nurse to complete preoperative checks')
    if (data.executions.length > 0) return t('手术已完成', 'Surgery completed')
    return t('尚无手术计划，可按诊疗需要申请', 'No surgery planned; request as clinically needed')
  }
  const doctorRecordTurn = (): string => {
    if (admission.financialStatus !== 'settled') return t('出院结算后才能提交', 'Submit after discharge settlement')
    const phase = record.data ? inpatientRecordPhase(record.data) : undefined
    return phase === 'submitted' && record.data?.revision ? t(`等病案人员编码审核 · ${formatShanghaiMinute(record.data.revision.recordedAt).slice(5)} 已提交`, `Waiting for coding review · submitted ${formatShanghaiMinute(record.data.revision.recordedAt).slice(5)}`)
      : phase === 'returned' ? t('轮到你：按退回意见修改后重新提交', 'Your turn: revise and resubmit as returned')
        : phase === 'stale' ? t('轮到你：来源有变化，重新提交病案首页', 'Your turn: sources changed, resubmit the record')
          : phase === 'approved' ? t('等病案人员归档', 'Waiting for medical records to archive')
            : t('轮到你：核对并提交病案首页', 'Your turn: review and submit the record')
  }
  const turn = (stage: InpatientStage): string => {
    if (stage === 'investigations' && (investigations.error || !investigations.data)) return waiting.investigations
    if (doctor) {
      if (stage === 'discharge' && admission.status === 'admitted') return t('轮到你：开出院医嘱', 'Your turn: order discharge')
      if (stage === 'discharge' && admission.status === 'discharge-pending') return doctorStops > 0 ? t(`轮到你：停 ${doctorStops} 条医嘱 · 然后等病区护士办理出院`, `Your turn: stop ${doctorStops} orders · then ward nurse records departure`) : t('等病区护士办理出院', 'Waiting for the ward nurse to record departure')
      if (stage === 'record' && admission.recordStatus !== 'archived' && admission.status !== 'registered') return doctorRecordTurn()
      if (stage === 'surgery') return doctorSurgeryTurn()
      if (counts[stage] === 0 && stage === 'orders') return t('核对诊断，按诊疗需要开立或调整医嘱', 'Review diagnoses and issue or adjust orders as needed')
    }
    return counts[stage] > 0 && (stage !== 'discharge' || stopWaiting === undefined) ? `${t('轮到你：', 'Your turn: ')}${actions[stage]}` : waiting[stage]
  }
  // The write resolves after the shared refresh, so the waiting line already names who acts next. A success seen at mount
  // belongs to the previously viewed patient and is not announced again.
  const announced = useRef(succeededAt), handoff = useRef({ title: '', description: '' })
  const opSummary = completedCommand ? ({
    'inpatient.admission.receive': t('已完成接诊分床', 'Admission received and bed assigned'),
    'inpatient.admission.move-bed': t('已完成转床', 'Bed moved'),
    'inpatient.admission.swap-bed': t('已完成互换床位', 'Beds swapped'),
    'inpatient.order.verify': t('已校对医嘱', 'Order verified'),
    'inpatient.order.administer': t('已登记给药', 'Medication administered'),
    'inpatient.discharge.clear': t('已完成清床', 'Bed cleared'),
    'inpatient.discharge.settle': t('已完成出院结算', 'Discharge settled'),
    'inpatient.payment.collect': t('已确认收款', 'Payment collected'),
    'inpatient.payment.refund': t('已确认退款', 'Payment refunded'),
    'inpatient.record.approve': t('编码审核通过', 'Coding review approved'),
    'inpatient.record.archive': t('病案已归档', 'Medical record archived'),
  } as Record<string, string>)[completedCommand.operation] : undefined
  handoff.current = { title: `${t('已完成本次操作', 'Action completed')} · ${admission.patientName}${opSummary ? ` · ${opSummary}` : ''}`, description: waiting[active] }
  useEffect(() => {
    if (succeededAt === 0 || succeededAt === announced.current) return
    announced.current = succeededAt
    announceHandoff(handoff.current.title, handoff.current.description)
  }, [succeededAt])
  const paymentPending = settled ? adjustments.data !== undefined && adjustments.data.reservedFen + adjustments.data.reservedCollectFen > 0
    : (funds.data?.pendingCount ?? 0) > 0
  const insurancePending = settled && adjustments.data?.insurance?.ready === false
  const balancePending = paymentPending || insurancePending
  const totalAdjustmentsRefunded = adjustments.data?.sources.reduce((sum, s) => sum + s.refundedFen, 0) ?? 0
  const settledRefundFen = settled && adjustments.data !== undefined
    ? (totalAdjustmentsRefunded > 0 ? totalAdjustmentsRefunded : adjustments.data.firstSettlement.balanceFen < 0 ? -adjustments.data.firstSettlement.balanceFen : 0)
    : 0
  const amountKnown = remainingFen !== undefined && !balancePending && !balanceRead.error
  const amountLabel = balanceRead.error ? t('资金读取失败', 'Funding unavailable')
    : paymentPending ? t('等收费员查明原支付结果', 'Resolve the original payment result')
      : insurancePending ? t('请先重新核对医保待遇', 'Review the updated insurance allocation first')
      : remainingFen === undefined ? t('正在核对资金', 'Reviewing funds')
        : remainingFen > 0 ? `${t('需补交 ', 'Amount due ')}${formatFen(remainingFen, locale)}`
          : remainingFen < 0 ? fixedStay ? `${t('应退 ', 'Refund due ')}${formatFen(-remainingFen, locale)}` : `${t('预交金充足（可用余额 ', 'Deposit sufficient (available ')}${formatFen(-remainingFen, locale)}${t('）', ')')}`
            : settledRefundFen > 0 ? `${t('应退 ', 'Refunded ')}${formatFen(settledRefundFen, locale)}${t('（无需补退）', ' (No balance due)')}` : t('无需补退', 'No balance due')
  const recordNumber = record.data?.recordNumber ?? admission.recordNumber
  const toggleFollow = () => {
    if (admission.recordStatus === 'archived' || followup.error || !followup.data) return
    const encounterVersion = followup.data?.encounterVersion ?? admission.versionId
    if (followDialog === 'start') {
      write.mutation.mutate({ operation: 'inpatient.drg.followup.start', input: { admissionId: admission.id, encounterVersion, expectedTaskVersion: followTask?.version ?? 0 } }, {
        onSuccess: result => {
          client.setQueryData([...scope, admission.id, 'drg-followup'], inpatientDrgFollowupResponseSchema.parse(result.response).data)
          setFollowDialog(null)
          void followup.refetch()
        },
      })
    } else if (followDialog === 'stop' && followTask && stopReason.trim()) {
      write.mutation.mutate({ operation: 'inpatient.drg.followup.stop', input: { admissionId: admission.id, encounterVersion, expectedTaskVersion: followTask.version, reason: stopReason.trim() } }, {
        onSuccess: result => {
          client.setQueryData([...scope, admission.id, 'drg-followup'], inpatientDrgFollowupResponseSchema.parse(result.response).data)
          setStopReason('')
          setFollowDialog(null)
          void followup.refetch()
        },
      })
    }
  }
  const statusVariant = admission.recordStatus === 'archived' || admission.status === 'cleared' ? 'outline'
    : role === 'medical-records' ? (admission.recordStatus === 'reviewed' ? 'success' : 'warning')
    : admission.status === 'departed' ? (admission.financialStatus === 'settled' ? 'success' : 'warning')
    : admission.status === 'admitted' ? 'info' : 'warning'
  const showDepositInHeader = admission.recordStatus !== 'archived' && admission.status !== 'cleared' && !(admission.status === 'departed' && admission.financialStatus === 'settled') && role !== 'medical-records'
  const followControls = doctor ? <>
    <span className="flex-1" />
    {admission.recordStatus !== 'archived' ? <button type="button" aria-pressed={followOn}
      disabled={(!followOn && admission.status !== 'admitted') || followup.isPending || followup.isError || write.mutation.isPending}
      onClick={() => { setStopReason(''); setFollowDialog(followOn ? 'stop' : 'start') }}
      className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors disabled:opacity-50', followOn ? 'border-info/50 bg-info/10 text-info' : 'border-border bg-card text-foreground')}>
      <span aria-hidden="true" className={cn('inline-block h-3.5 w-6 rounded-full p-0.5 transition-colors', followOn ? 'bg-info' : 'bg-muted-foreground/30')}><span className={cn('block size-2.5 rounded-full bg-background transition-transform', followOn ? 'translate-x-2.5' : 'translate-x-0')} /></span>{t('助手自动跟进', 'Assistant auto follow-up')}
    </button> : null}
    {followStatus ? <span role="status" className={followTask?.status === 'authorization-lost' ? 'text-warning' : undefined}>{followStatus}</span> : null}
    {followup.error ? <span role="alert">{t('跟进状态读取失败', 'Could not load follow-up status')}<Button type="button" variant="link" size="sm" onClick={() => void followup.refetch()}>{t('重试跟进状态', 'Retry follow-up status')}</Button></span> : null}
    <Button type="button" variant="link" size="sm" className="h-auto px-1 text-xs text-info" onClick={() => { setUsageTarget({}); setUsageOpen(true) }}>{t('本次住院 AI 用量', 'AI usage for this admission')}</Button>
  </> : null
  const patient = <section aria-label={t('当前住院患者', 'Current inpatient')}><InpatientPatientHeader name={admission.patientName}
    identity={identity.isPending ? <Skeleton className="h-4 w-24" /> : identity.data ? <>{gender} · {age !== undefined && age >= 0 ? t(`${age} 岁`, `${age} years`) : t('年龄待核对', 'Age unavailable')}</> : undefined}
    location={<>{place} · {careDay === undefined ? t('尚未入科', 'Not yet admitted') : fixedStay ? t(`住院 ${careDay} 天`, `${careDay}d stay`) : t(`住院第 ${careDay} 天`, `Day ${careDay}`)}</>}
    status={inpatientStatus(admission, locale, role)}
    statusVariant={statusVariant}
    amount={cashier ? <span className={amountKnown && ((remainingFen !== 0 && (remainingFen > 0 || fixedStay)) || settledRefundFen > 0) ? 'text-xl font-semibold leading-tight' : 'text-sm text-muted-foreground'}>{amountLabel}</span> : undefined}
    details={<><InpatientNumber locale={locale} number={admission.inpatientNumber} />{recordNumber ? <InpatientNumber locale={locale} number={recordNumber} label={t('病案号', 'Record')} /> : null}{admission.status === 'registered' ? <span>{t('登记 ', 'Registered ')}{formatShanghaiMinute(admission.registeredAt).slice(5)}</span> : null}{showDepositInHeader ? <span>{t('预交金 ', 'Deposits ')}{formatFen(admission.depositFen, locale)}</span> : null}{admission.status === 'registered' ? (admission.referralReason ? <span>{t('住院原因 ', 'Reason ')}{admission.referralReason}</span> : null) : <span>{role === 'medical-records' ? t('结算费用 ', 'Settled charges ') : fixedStay && admission.financialStatus === 'settled' ? t('已结清 ', 'Settled ') : t('累计费用 ', 'Charges ')}{formatFen(admission.chargesFen, locale)}</span>}{admission.departedAt ? <span>{t('出院 ', 'Discharged ')}{formatShanghaiMinute(admission.departedAt).slice(5)}{admission.departureMethod ? ` · ${inpatientDepartureLabel(admission.departureMethod, locale)}` : ''}</span> : null}{followControls}</>}>
    {balanceRead.error ? <p role="alert" className="text-sm">{t('资金读取失败：', 'Funding failed to load: ')}{getWorkspaceErrorMessage(balanceRead.error, getWorkspaceMessages(locale))}<Button variant="outline" size="sm" onClick={() => void balanceRead.refetch()}>{t('重试资金', 'Retry funding')}</Button></p> : null}
    {identity.error ? <p role="alert" className="text-sm">{t('患者基本信息读取失败：', 'Patient information failed to load: ')}{getWorkspaceErrorMessage(identity.error, getWorkspaceMessages(locale))}<Button variant="outline" size="sm" onClick={() => void identity.refetch()}>{t('重试患者信息', 'Retry patient information')}</Button></p> : null}
  </InpatientPatientHeader></section>
  const reportedResults = investigations.error === null ? investigations.data?.laboratoryRequests.flatMap(request => request.report?.results.map(result => ({ request, result })) ?? []) ?? [] : []
  const abnormalResults = reportedResults.filter(({ result }) => ['high', 'low', 'abnormal'].includes(result.interpretation)).length
  const aside = <div className="flex flex-wrap items-center gap-x-2 gap-y-1">{doctor ? <div className="px-4 pb-2"><InpatientDoctorReminders admission={admission} admissions={admissions} session={session} locale={locale} activeStage={active} /></div> : null}{(nurse || doctor) && careOpen && (investigations.isPending || investigations.error || reportedResults.length > 0) ? <section aria-label={t('检查检验结果', 'Investigation results')} className="flex flex-wrap items-center gap-1.5 px-4 pb-2 text-xs">
    {investigations.isPending ? <Skeleton className="h-6 w-40" /> : null}
    {investigations.error ? <p role="alert" className="text-sm">{t('检验结果读取失败：', 'Test results failed to load: ')}{getWorkspaceErrorMessage(investigations.error, getWorkspaceMessages(locale))}<Button variant="outline" size="sm" onClick={() => void investigations.refetch()}>{t('重试检验结果', 'Retry test results')}</Button></p> : null}
    {reportedResults.length > 0 ? <div role="list" aria-label={t('检验摘要', 'Test result summary')} className="contents">{reportedResults.slice(0, 2).map(({ request, result }) => {
      const flag = result.interpretation === 'high' ? t('偏高', 'High') : result.interpretation === 'low' ? t('偏低', 'Low') : result.interpretation === 'abnormal' ? t('异常', 'Abnormal') : undefined
      const arrow = result.interpretation === 'high' ? ' ↑' : result.interpretation === 'low' ? ' ↓' : ''
      const refText = formatLabReferenceRange(result.referenceRange.text)
      return <span role="listitem" key={`${request.id}:${result.code}`} title={request.laboratoryService?.nameZh ?? request.referenceConcept?.display ?? t('检验结果', 'Test result')}
        className={cn('inline-flex h-6 items-center gap-1 rounded-md border px-2 tabular-nums', flag ? 'border-warning/40 bg-warning/10 text-warning' : 'bg-muted/40')}>
        {formatLabResultDisplay(result.display)} {typeof result.value === 'object' ? result.value.display : String(result.value)}{'unit' in result && result.unit.display !== '1' ? ` ${result.unit.display}` : ''}{arrow}
        <span className="text-muted-foreground">（{t('参考 ', 'ref ')}{refText}）</span>{flag ? <strong className="sr-only">{flag}</strong> : null}
      </span>
    })}</div> : null}
    {reportedResults.length > 0 ? <Button variant="ghost" size="sm" className={cn('h-6 px-1 text-xs', abnormalResults > 0 && 'text-warning')} onClick={() => changeStage('investigations')}>
      {abnormalResults > 0 ? <strong>{t(`${abnormalResults} 项异常 · `, `${abnormalResults} abnormal · `)}</strong> : null}{t(`查看检验结果（${reportedResults.length}项）`, `View all ${reportedResults.length} test results`)}
    </Button> : null}
  </section> : null}</div>
  const roleLabel = { 'ward-nurse': nurse ? t('病区护士', 'Ward nurse') : '', 'inpatient-doctor': t('住院医生', 'Inpatient doctor'), cashier: t('收费员', 'Cashier'), 'medical-records': t('病案人员', 'Medical records staff') }[role as 'ward-nurse' | 'inpatient-doctor' | 'cashier' | 'medical-records']
  const ownersForStage = (stage: InpatientStage): string[] => {
    if (stage === 'orders' && doctor && (clinical.data?.diagnosis.entries.length ?? 0) === 0) {
      return zh ? ['住院医生确认诊断', '住院医生开立医嘱', '病区护士校对'] : ['Inpatient doctor confirms diagnosis', 'Inpatient doctor issues orders', 'Ward nurse verifies']
    }
    return (zh ? stageOwners : stageOwnersEn)[stage]
  }
  return <InpatientAgentProvider value={agent}><InpatientActionProvider stage={active}><WorkspaceCardLayout id={id} locale={locale} queue={queue} patient={<>{patient}<InpatientAssistantPrepared locale={locale} pci={pciPreparation} activeStage={active} followOn={followOn} onOpenSurgery={() => changeStage('surgery')} onOpenDrg={() => changeStage('drg')} />{aside}</>} flow={inpatientFlow(admission, locale)} action={<InpatientActionOutlet />}>
    {showForegroundSuccess ? <InpatientPrimaryAction stage={active} priority={-100}><WorkspaceActionBar tone="complete" summary={<span role="status">{t('已完成本次操作', 'Action completed')}</span>} reason={waiting[active]} /></InpatientPrimaryAction> : null}
    {careReads.map(({ key, query, label, retryLabel }) => query.error ? <WorkspaceCard key={key}>
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-sm">{label}{getWorkspaceErrorMessage(query.error, getWorkspaceMessages(locale))}</p>
        <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>{retryLabel}</Button>
      </div>
    </WorkspaceCard> : null)}
    {notices}
    <InpatientTabs id={`${id}-stage`} items={tabs} value={active} onValueChange={changeStage} locale={locale}>
      {tabs.map(stage => <TabsContent key={stage.value} value={stage.value} data-inpatient-stage={stage.value} keepMounted className="min-h-0 min-w-0 overflow-y-auto">{active === stage.value || visited.includes(stage.value as InpatientStage) ? <InpatientStageCard title={stage.label} turn={turn(stage.value as InpatientStage)} owners={<ol aria-label={t('办理顺序', 'Handling order')} className="flex flex-wrap items-center gap-x-1.5 text-xs">{ownersForStage(stage.value as InpatientStage).map((owner, index) => <li key={index} className="flex items-center gap-1.5">{index > 0 ? <span aria-hidden="true">›</span> : null}{roleLabel && owner.startsWith(roleLabel) ? <strong className="text-foreground">{owner}</strong> : owner}</li>)}</ol>}>
        {stage.value === 'admission' ? nurse && admission.recordStatus !== 'archived' ? <InpatientBedAssignment admission={admission} admissions={admissions} catalog={catalog} locale={locale} write={write} onOpenStage={changeStage} /> : <InpatientAdmissionReadonlySummary admission={admission} place={place} bedDailyPriceFen={bed?.dailyPriceFen} clinical={clinical.data} locale={locale} /> : null}
        {stage.value === 'orders' ? <InpatientClinical key={admission.id} admission={admission} session={session} locale={locale} write={write} active={active === stage.value} /> : null}
        {stage.value === 'drg' ? <InpatientDrgPanel admission={admission} session={session} locale={locale} write={write} active={active === stage.value} followOn={followOn} onOpenRecord={changeStage} /> : null}
        {stage.value === 'investigations' ? <InpatientInvestigations admission={admission} session={session} locale={locale} write={write} onOpenStage={changeStage} /> : null}
        {stage.value === 'surgery' ? <InpatientSurgery admission={admission} session={session} locale={locale} write={write} active={active === stage.value} onOpenStage={changeStage} onOpenUsage={(taskId, taskKind) => { setUsageTarget({ taskId, taskKind }); setUsageOpen(true) }} /> : null}
        {stage.value === 'transfer' ? <InpatientTransfers admission={admission} session={session} locale={locale} write={write} /> : null}
        {stage.value === 'fees' ? cashier ? <InpatientCharges admission={admission} admissionId={admission.id} session={session} locale={locale} write={write} /> : <InpatientClinical admission={admission} session={session} locale={locale} write={write} view="fees" /> : null}
        {stage.value === 'discharge' ? cashier ? <InpatientSettlement admission={admission} session={session} locale={locale} write={write} /> : <InpatientDischarge admission={admission} session={session} locale={locale} write={write} activity={activity} onOpenStage={changeStage} /> : null}
        {stage.value === 'record' ? <>{role === 'medical-records' || (doctor && admission.recordStatus === 'archived') ? <InpatientRecordDrgSummary admission={admission} session={session} locale={locale} /> : null}<InpatientRecord admission={admission} session={session} locale={locale} write={write} catalog={catalog} onOpenStage={changeStage} onBeforeRecordAction={onBeforeRecordAction} continuation={recordContinuation} /></> : null}
      </InpatientStageCard> : null}</TabsContent>)}
    </InpatientTabs>
    {doctor ? <>
      <Dialog open={followDialog !== null} onOpenChange={open => { if (!open && !write.mutation.isPending) setFollowDialog(null) }}>
        <DialogContent className="sm:max-w-[440px]" showCloseButton={!write.mutation.isPending}>
          <DialogHeader>
            <DialogTitle>{followDialog === 'stop' ? t('停止助手自动跟进', 'Stop assistant auto follow-up') : t('开启助手自动跟进', 'Start assistant auto follow-up')}</DialogTitle>
            <DialogDescription className="sr-only">{followDialog === 'stop' ? t('停止本次住院的助手自动跟进', 'Stop assistant auto follow-up for this admission') : t('开启本次住院的助手自动跟进', 'Start assistant auto follow-up for this admission')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 p-4 text-sm">
            {followError ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(followError, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
            {followDialog === 'stop' ? <>
              <Field>
                <FieldLabel htmlFor={`follow-stop-reason-${admission.id}`}>{t('停止理由（必填）', 'Reason for stopping (required)')}</FieldLabel>
                <Input id={`follow-stop-reason-${admission.id}`} placeholder={t('例如：患者转科，交由新科室跟进', 'For example: patient transferred to another department')} value={stopReason} onChange={event => setStopReason(event.currentTarget.value)} maxLength={2000} />
              </Field>
              <p className="text-xs text-muted-foreground">{t('停止后不再自动预填和说明；已有内容保留。', 'Auto pre-filling and explanations stop after confirmation; existing content is retained.')}</p>
            </> : <>
              <p>{t('开启后，本次住院内诊断、手术或费用变化时，助手自动：', 'When enabled, whenever diagnoses, procedures or charges change during this admission, the assistant automatically:')}</p>
              <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                <span>{t('· 按检查报告预填选型参数，并给出指南参考', '· Pre-fills selection parameters from reports and provides guideline references')}</span>
                <span>{t('· 选型确认后预填手术耗材；术中提示剩余预留', '· Pre-fills surgical materials after selection confirmation; hints remaining reservations during surgery')}</span>
                <span>{t('· 分组核对有差异时，在对应行说明原因', '· Explains reasons inline when grouping checks have differences')}</span>
              </div>
              <p className="text-xs text-muted-foreground">{t('调用 AI，用量记在你名下的本次住院 AI 用量；关闭页面也继续。所有预填都要你确认后才生效。', 'Calls AI and records usage under your AI usage for this admission; continues when the page is closed. All pre-filled values require your confirmation.')}</p>
            </>}
          </div>
          <OrderComposerFooter hint={followDialog === 'stop' ? (stopReason.trim() ? t('确认后停止', 'Stops after confirmation') : t('还差：停止理由', 'Still needed: reason for stopping')) : t('每次住院只需开一次', 'Only needed once per admission')}>
            <DialogClose disabled={write.mutation.isPending} render={<Button type="button" variant="ghost" />}>{t('取消', 'Cancel')}</DialogClose>
            <Button type="button" disabled={write.blocked || (followDialog === 'stop' && !stopReason.trim())} onClick={toggleFollow}>{followDialog === 'stop' ? t('确认停止', 'Confirm stop') : t('开启', 'Enable')}</Button>
          </OrderComposerFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={usageOpen} onOpenChange={setUsageOpen}>
        <DialogContent className="sm:max-w-[720px]">
          <DialogHeader>
            <DialogTitle>{t('本次住院 AI 用量', 'AI usage for this admission')}</DialogTitle>
            <DialogDescription>{admission.patientName}{followStatus ? ` · ${followStatus}` : ''}{followTask?.reason ? ` · ${followTask.reason}` : ''}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto p-4">
            <InpatientDrgUsagePanel key={`${admission.id}/${usageTarget.taskId ?? 'all'}`} admissionId={admission.id} taskId={usageTarget.taskId} stageTaskId={followTask?.id} taskKind={usageTarget.taskKind ?? 'followup'} session={session} locale={locale} active={usageOpen} readOnly={admission.recordStatus === 'archived'} compact />
          </div>
          <OrderComposerFooter hint={t('估算费用不代表真实计费', 'Estimated cost does not represent real billing')}>
            <DialogClose render={<Button type="button" variant="outline" />}>{t('关闭', 'Close')}</DialogClose>
          </OrderComposerFooter>
        </DialogContent>
      </Dialog>
    </> : null}
  </WorkspaceCardLayout></InpatientActionProvider></InpatientAgentProvider>
}

function InpatientBedAssignment({ admission, admissions, catalog, locale, write, onOpenStage }: Pick<Props, 'admission' | 'admissions' | 'catalog' | 'locale' | 'write'> & { onOpenStage(stage: string): void }): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const [bedId, setBedId] = useState<string | null>(null), [swapId, setSwapId] = useState<string | null>(null)
  const [moveOpen, setMoveOpen] = useState(false)
  const currentBedName = catalog?.beds.find(bed => bed.id === admission.bedId)?.name
  const assignBed = () => {
    if (bedId !== null) write.mutation.mutate({ operation: admission.status === 'registered' ? 'inpatient.admission.receive' : 'inpatient.admission.move-bed', input: { admissionId: admission.id, encounterVersion: admission.versionId, bedId } })
  }
  const swapBeds = () => {
    const other = admissions.find(item => item.id === swapId)
    if (other) write.mutation.mutate({ operation: 'inpatient.admission.swap-bed', input: { admissionId: admission.id, encounterVersion: admission.versionId, otherAdmissionId: other.id, otherEncounterVersion: other.versionId } })
  }
  return <FieldSet disabled={write.blocked}><FieldGroup className="grid gap-3 md:grid-cols-2">
    {admission.status === 'admitted' ? <div role="status" className="md:col-span-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-800 dark:text-emerald-300">
      <span className="inline-flex items-center gap-2"><CheckIcon aria-hidden="true" className="size-4 shrink-0" />
        <span>{admission.admittedAt ? `${formatShanghaiMinute(admission.admittedAt).slice(5)} ${t('已入科', 'Admitted')} · ` : ''}{t(`已接诊并分到 ${currentBedName ?? '当前床位'}，下一步：住院医生确认住院诊断并开立医嘱`, `Received and assigned to ${currentBedName ?? 'current bed'}; next: inpatient doctor confirms diagnoses and issues orders`)}</span></span>
      <Button type="button" variant="outline" size="sm" onClick={() => setMoveOpen(!moveOpen)}>{t('转床', 'Move bed')}</Button>
    </div> : null}
    {admission.status !== 'admitted' || moveOpen || bedId !== null ? <Field className="md:col-span-2"><FieldLabel id="inpatient-bed-label">{t('目标床位', 'Target bed')}</FieldLabel>
      {/* 床位网格列出本病区全部床位；已占用的床位不可选。 */}
      <ToggleGroup aria-labelledby="inpatient-bed-label" variant="outline" className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2" value={bedId === null ? [] : [bedId]}
        onValueChange={values => setBedId(values[0] ?? null)}>
        {(catalog?.beds ?? []).filter(bed => bed.wardId === admission.wardId).map(bed => {
          const occupant = bed.admissionId === undefined ? undefined : admissions.find(item => item.id === bed.admissionId)
          return <ToggleGroupItem key={bed.id} value={bed.id} disabled={bed.admissionId !== undefined} className={cn('h-auto min-w-0 flex-col items-start gap-0.5 px-3 py-2 text-left', bed.admissionId !== undefined && 'border-dashed text-muted-foreground')}>
            <span className="font-medium">{bed.name}</span>
            <span className="w-full truncate text-xs tabular-nums">{bed.admissionId === undefined ? `${formatFen(bed.dailyPriceFen, locale)}/${t('日', 'day')}` : occupant ? <><span className="sr-only">{t('已占用 · ', 'Occupied · ')}</span>{occupant.patientName}</> : t('已占用', 'Occupied')}</span>
          </ToggleGroupItem>
        })}
      </ToggleGroup></Field> : null}
    <InpatientPrimaryAction stage="admission">{admission.status === 'admitted' && bedId === null
      ? <WorkspaceActionBar tone="complete" summary={t('入科已完成', 'Admission completed')} reason={t('下一步：住院医生确认住院诊断并开立医嘱', 'Next: inpatient doctor confirms diagnoses and issues orders')} action={<Button variant="outline" onClick={() => onOpenStage('orders')}>{t('前往诊断医嘱 →', 'Go to Diagnoses & orders →')}</Button>} />
      : <WorkspaceActionBar summary={admission.patientName} reason={bedId === null ? t('还差：选择目标床位', 'Choose a target bed') : t(`分到 ${catalog?.beds.find(bed => bed.id === bedId)?.name}，确认后开始计床位费`, `Assign to ${catalog?.beds.find(bed => bed.id === bedId)?.name}; bed charges start after confirmation`)} action={<Button disabled={write.blocked || bedId === null || !['registered', 'admitted'].includes(admission.status)} onClick={assignBed}>{admission.status === 'registered' ? t('接诊并分床', 'Receive and assign bed') : t('转床', 'Move bed')}</Button>} tone={bedId === null ? 'blocked' : 'normal'} />}</InpatientPrimaryAction>
    {admission.status === 'admitted' ? <div className="md:col-span-2 flex flex-wrap items-end gap-2"><Field className="min-w-[12rem] flex-1"><FieldLabel htmlFor="inpatient-swap">{t('换床患者', 'Swap with')}</FieldLabel><WorkspaceSelect id="inpatient-swap" value={swapId} items={admissions.filter(item => item.id !== admission.id && item.wardId === admission.wardId && item.status === 'admitted').map(item => ({ value: item.id, label: `${item.patientName} · ${catalog?.beds.find(bed => bed.id === item.bedId)?.name}` }))} onValueChange={setSwapId} /></Field><Button variant="outline" className="shrink-0" disabled={write.blocked || swapId === null} onClick={swapBeds}>{t('互换床位', 'Swap beds')}</Button></div> : null}
  </FieldGroup></FieldSet>
}

function InpatientAdmissionReadonlySummary({ admission, place, bedDailyPriceFen, clinical, locale }: {
  admission: InpatientAdmission
  place: string
  bedDailyPriceFen: number | undefined
  clinical: z.infer<typeof inpatientFullClinicalSchema> | undefined
  locale: WorkspaceLocale
}): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const primary = clinical?.diagnosis.entries.find(item => item.role === 'primary')
  const routeLabel = admission.admissionRoute === 'transfer' ? t('转院入院', 'Transfer admission')
    : admission.admissionRoute === 'outpatient' ? t('门诊住院证转收', 'Outpatient referral') : t('直接入院', 'Direct admission')
  return <section aria-label={t('入科与登记摘要', 'Admission and registration summary')} className="clinmesh-inpatient-preparation">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-medium">{t('入科与登记摘要', 'Admission and registration summary')}</h4>
      <Badge variant="outline" className={admission.status === 'registered' ? undefined : 'border-success/40 bg-success/10 text-success'}>
        {admission.status === 'registered' ? t('待分床', 'Awaiting bed assignment') : <><CheckIcon aria-hidden="true" className="mr-1 size-3" />{t('已入科在床', 'Admitted in bed')}</>}
      </Badge>
    </div>
    <dl className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
      <div className="rounded-lg border bg-background p-3">
        <dt className="text-xs text-muted-foreground">{t('实际入科时间', 'Actual admission time')}</dt>
        <dd className="mt-1 font-medium tabular-nums">{admission.admittedAt ? formatShanghaiMinute(admission.admittedAt).slice(5) : t('尚未入科', 'Not yet admitted')}</dd>
      </div>
      <div className="rounded-lg border bg-background p-3">
        <dt className="text-xs text-muted-foreground">{t('入院病区 / 床位', 'Ward / bed')}</dt>
        <dd className="mt-1 font-medium tabular-nums">{place}{bedDailyPriceFen !== undefined ? `（${formatFen(bedDailyPriceFen, locale)}/${t('日', 'day')}）` : ''}</dd>
      </div>
      <div className="rounded-lg border bg-background p-3">
        <dt className="text-xs text-muted-foreground">{t('入院途径 / 登记来源', 'Admission route / source')}</dt>
        <dd className="mt-1 font-medium">{routeLabel}</dd>
      </div>
      <div className="rounded-lg border bg-background p-3">
        <dt className="text-xs text-muted-foreground">{t('住院登记时间', 'Registration time')}</dt>
        <dd className="mt-1 font-medium tabular-nums">{formatShanghaiMinute(admission.registeredAt).slice(5)}</dd>
      </div>
      <div className="rounded-lg border bg-background p-3">
        <dt className="text-xs text-muted-foreground">{t('入院预交金', 'Admission deposit')}</dt>
        <dd className="mt-1 font-medium tabular-nums">{formatFen(admission.depositFen, locale)}{admission.depositFen > 0 ? t('（现金）', ' (Cash)') : ''}</dd>
      </div>
      <div className="rounded-lg border bg-background p-3">
        <dt className="text-xs text-muted-foreground">{t('门诊住院原因 / 当前主诊断', 'Admission reason / primary diagnosis')}</dt>
        <dd className="mt-1 font-medium">{admission.referralReason ?? (primary ? `${primary.coding.display}（${primary.coding.code}）` : t('待住院医生确认主诊断', 'Awaiting primary diagnosis confirmation'))}</dd>
      </div>
    </dl>
  </section>
}
