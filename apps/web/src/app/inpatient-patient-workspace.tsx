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
import { Field, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { TabsContent } from '@clinmesh/ui/components/tabs'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { CopyIcon } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { InpatientClinical } from './inpatient-clinical.tsx'
import { InpatientDoctorReminders } from './inpatient-doctor-reminders.tsx'
import { inpatientCareDay, inpatientScopeKey } from './inpatient-scope.ts'
import { InpatientDrgPanel } from './inpatient-drg.tsx'
import { InpatientDrgReviewPanel } from './inpatient-drg-review.tsx'
import { InpatientCharges } from './inpatient-charges.tsx'
import { InpatientDischarge, InpatientSettlement } from './inpatient-discharge.tsx'
import { InpatientInvestigations } from './inpatient-investigations.tsx'
import { InpatientRecord } from './inpatient-record.tsx'
import { InpatientSurgery } from './inpatient-surgery.tsx'
import { InpatientTransfers } from './inpatient-transfers.tsx'
import { inpatientDefaultStage, inpatientFlow, inpatientPending, inpatientStageTabs } from './inpatient-stage-activity.ts'
import { WorkspaceCardLayout, WorkspaceCard, WorkspacePatientCard, WorkspaceTabs, WorkspaceActionBar, useWorkspaceCardView } from './workspace-card-layout.tsx'
import { InpatientActionProvider, InpatientActionOutlet, InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { InpatientAgentProvider, useInpatientAgentTools } from './inpatient-agent-tools.tsx'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { apiGet } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { patientAge } from './doctor/patient-summary.tsx'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages } from './workspace-i18n.ts'

const patientIdentitySchema = z.object({ resourceType: z.literal('Patient'), id: z.string().min(1),
  gender: z.enum(['female', 'male', 'other', 'unknown']).optional(), birthDate: z.iso.date().optional() })

export function inpatientStatus(admission: InpatientAdmission, locale: WorkspaceLocale): string {
  const zh = locale === 'zh-CN'
  return { registered: zh ? '待入科' : 'Registered', admitted: zh ? '在院' : 'Admitted', 'discharge-pending': zh ? '待出院' : 'Discharge pending',
    departed: admission.financialStatus === 'settled' ? zh ? '已结算 · 待清床' : 'Settled · awaiting bed clearance' : zh ? '已出院 · 待结算' : 'Discharged · awaiting settlement', cleared: zh ? '已清床' : 'Bed cleared' }[admission.status]
}

function InpatientNumber({ locale, number }: { locale: WorkspaceLocale; number: string }): React.JSX.Element {
  // 不同号码各自拥有复制反馈，包括迟到的剪贴板响应。
  return <InpatientNumberValue key={number} locale={locale} number={number} />
}
function InpatientNumberValue({ locale, number }: { locale: WorkspaceLocale; number: string }): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const [result, setResult] = useState<'copied' | 'failed'>()
  return <span className="inline-flex items-center gap-1" data-inpatient-number>
    <span className="font-mono tabular-nums" title={number}>{t('住院号 ', 'Inpatient no. ')}{number.length > 14 ? `${number.slice(0, 10)}…` : number}</span>
    <Button aria-label={`${t('复制住院号', 'Copy inpatient number')} ${number}`} onClick={async () => {
      setResult(undefined)
      try { await navigator.clipboard.writeText(number); setResult('copied') } catch { setResult('failed') }
    }} size="icon-xs" type="button" variant="ghost"><CopyIcon aria-hidden="true" /></Button>
    {result === undefined ? null : <span className="text-xs text-muted-foreground" role={result === 'failed' ? 'alert' : 'status'}>
      {result === 'copied' ? t('已复制', 'Copied') : t('复制失败', 'Copy failed')}
    </span>}
  </span>
}

type Props = { allowTransfers: boolean; admission: InpatientAdmission; admissions: InpatientAdmission[]; catalog: z.infer<typeof inpatientCatalogSchema> | undefined; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>; queue?: ReactNode; notices?: ReactNode }

const stageOwners: Record<InpatientStage, string[]> = {
  admission: ['病区护士接诊分床'], orders: ['住院医生开立医嘱', '病区护士校对', '药师发药', '病区护士执行'],
  investigations: ['住院医生开立', '病区护士送检', '医技科室出报告', '住院医生已阅'], surgery: ['住院医生申请及知情同意', '病区护士术前核对', '住院医生实施手术'],
  transfer: ['住院医生申请', '病区护士交接及接收'], fees: ['收费员核对费用'], discharge: ['住院医生开出院医嘱', '病区护士办理出院', '收费员结算', '病区护士清床'],
  record: ['住院医生提交首页', '病案人员审核归档'], drg: ['住院医生核对诊断和手术'],
}
const stageOwnersEn: Record<InpatientStage, string[]> = {
  admission: ['Ward nurse receives and assigns bed'], orders: ['Inpatient doctor issues orders', 'Ward nurse verifies', 'Pharmacist dispenses', 'Ward nurse administers'],
  investigations: ['Inpatient doctor orders', 'Ward nurse dispatches', 'Investigation staff report', 'Inpatient doctor reviews'], surgery: ['Inpatient doctor plans and confirms consent', 'Ward nurse checks preparation', 'Inpatient doctor performs surgery'],
  transfer: ['Inpatient doctor requests', 'Ward nurses hand over and receive'], fees: ['Cashier reconciles charges'], discharge: ['Inpatient doctor orders discharge', 'Ward nurse records discharge', 'Cashier settles', 'Ward nurse clears bed'],
  record: ['Inpatient doctor submits record', 'Medical records staff review and archive'], drg: ['Inpatient doctor reviews diagnoses and procedures'],
}

export function InpatientPatientWorkspace({ admission, admissions, catalog, allowTransfers, session, locale, write, queue, notices }: Props): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const role = session.actor.roleCode, nurse = role === 'ward-nurse', doctor = role === 'inpatient-doctor', cashier = role === 'cashier'
  const careOpen = (doctor || nurse) && admission.recordStatus !== 'archived'
  const scope = inpatientScopeKey(session)
  const scenario = useQuery({ queryKey: ['scenario', 'virtual-time'], queryFn: ({ signal }) => apiGet('/api/sim/v1/scenario-runs/current', scenarioStateSchema, signal), retry: false })
  const identity = useQuery({ queryKey: [...scope, admission.patientId, 'patient-identity'], queryFn: ({ signal }) => apiGet(
    `/fhir/R5/Patient/${admission.patientId}`, patientIdentitySchema.refine(patient => patient.id === admission.patientId), signal) })
  const clinical = useQuery({ queryKey: [...scope, admission.id, 'clinical'], enabled: careOpen, queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/clinical`, inpatientFullClinicalSchema, signal) })
  const investigations = useQuery({ queryKey: [...scope, admission.id, 'investigations'], enabled: careOpen, queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/investigations`, inpatientInvestigationsSchema, signal) })
  const surgery = useQuery({ queryKey: [...scope, admission.id, 'surgeries'], enabled: careOpen, queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/surgeries`, inpatientSurgerySchema, signal) })
  const transfers = useQuery({ queryKey: [...scope, admission.id, 'transfers'], enabled: careOpen && allowTransfers, queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/transfers`, inpatientTransfersSchema, signal) })
  const activity = { admission, role, ...(careOpen ? { clinical: clinical.data, investigations: investigations.data, surgery: surgery.data, transfers: transfers.data } : {}), virtualTime: scenario.data?.virtualTime }
  const tabs = inpatientStageTabs(activity, allowTransfers, locale), counts = inpatientPending(activity)
  const id = `inpatient-${session.actor.workspaceId}-${session.actor.epoch}-${session.actor.practitionerRoleId}-${admission.id}`
  const view = useWorkspaceCardView(id), chosen = inpatientStageSchema.safeParse(view.tab)
  const active = chosen.success && tabs.some(tab => tab.value === chosen.data) ? chosen.data : inpatientDefaultStage(activity, tabs)
  const [visited, setVisited] = useState<InpatientStage[]>([])
  const changeStage = (value: string) => {
    const parsed = inpatientStageSchema.safeParse(value)
    if (parsed.success && tabs.some(tab => tab.value === value)) { setVisited(current => [...new Set([...current, active, parsed.data])]); view.setTab(parsed.data) }
  }
  const careDay = inpatientCareDay(admission, scenario.data?.virtualTime)
  const age = scenario.data && identity.data?.birthDate ? patientAge(identity.data.birthDate, new Date(Date.parse(scenario.data.virtualTime) + 8 * 60 * 60 * 1000)) : undefined
  const gender = identity.data?.gender === 'female' ? t('女', 'Female') : identity.data?.gender === 'male' ? t('男', 'Male') : identity.data?.gender === 'other' ? t('其他', 'Other') : t('性别未登记', 'Gender unavailable')
  const ward = catalog?.wards.find(item => item.id === admission.wardId), bed = catalog?.beds.find(item => item.id === admission.bedId)
  const place = ward === undefined ? '—' : `${ward.name} · ${bed?.name ?? t('未分床', 'Unassigned')}`
  const agent = useInpatientAgentTools({ admission, session, stage: active, stages: tabs, onStageChange: changeStage, clinical: careOpen ? clinical.data : undefined, investigations: careOpen ? investigations.data : undefined, bedLabel: place, write, locale })
  const actions: Record<InpatientStage, string> = {
    admission: t('接诊并分床', 'Receive and assign bed'), orders: nurse ? t('校对或执行医嘱', 'Verify or execute orders') : t('确认诊断', 'Confirm diagnosis'),
    investigations: nurse ? t('校对并送检', 'Verify and send') : t('已阅报告', 'Review reports'), surgery: nurse ? t('术前核对', 'Preoperative checks') : t('完成手术准备或实施手术', 'Prepare or perform surgery'),
    transfer: t('办理转科交接', 'Complete transfer'), fees: t('核对费用', 'Reconcile charges'), discharge: nurse ? admission.financialStatus === 'settled' ? t('清床', 'Clear bed') : t('办理出院', 'Record discharge') : t('补交并结算', 'Collect and settle'), record: t('核对病案首页', 'Review medical record'), drg: t('核对诊断和手术', 'Review diagnoses and procedures'),
  }
  const waiting: Record<InpatientStage, string> = {
    admission: t('入科登记已完成', 'Admission received'), orders: clinical.data?.orders.some(order => order.state === 'signed') ? t('等病区护士校对医嘱', 'Waiting for the ward nurse to verify orders') : t('等住院医生开立医嘱，或药师发药和护士按时执行', 'Waiting for doctor orders, dispensing or scheduled nurse execution'),
    investigations: t('等医技科室出报告；已出的报告由医生查阅', 'Waiting for investigation reports and doctor review'), surgery: t('等医生申请手术，或完成术前准备', 'Waiting for a surgery request or preoperative preparation'), transfer: t('等医生申请或病区护士交接', 'Waiting for the doctor request or nurse handover'), fees: t('等收费员核对费用', 'Waiting for the cashier to reconcile charges'),
    discharge: admission.status === 'admitted' ? t('等住院医生开出院医嘱', 'Waiting for the doctor to order discharge') : admission.status === 'departed' && admission.financialStatus === 'open' ? t('等收费员结算', 'Waiting for the cashier to settle') : t('等病区护士办理或清床', 'Waiting for the ward nurse to complete discharge or bed clearance'), record: t('等医生提交首页或病案人员审核归档', 'Waiting for record submission or medical records review'), drg: t('按当前诊断和手术核对', 'Review current diagnoses and procedures'),
  }
  const patient = <section aria-label={t('当前住院患者', 'Current inpatient')}><WorkspacePatientCard title={admission.patientName} description={<>{place} · {careDay === undefined ? t('尚未入科', 'Not yet admitted') : t(`住院第 ${careDay} 天`, `Day ${careDay}`)}</>} actions={<Badge variant="outline">{inpatientStatus(admission, locale)}</Badge>}>
    <div className="flex flex-wrap items-center gap-3 text-sm tabular-nums"><InpatientNumber locale={locale} number={admission.inpatientNumber} />{identity.isPending ? <Skeleton className="h-4 w-24" /> : identity.data ? <span>{gender} · {age !== undefined && age >= 0 ? t(`${age} 岁`, `${age} years`) : t('年龄待核对', 'Age unavailable')}</span> : null}<span>{t('预交金 ', 'Deposits ')}{formatFen(admission.depositFen, locale)}</span><span>{t('累计费用 ', 'Charges ')}{formatFen(admission.chargesFen, locale)}</span>
      {cashier && admission.outstandingFen !== undefined ? <strong className="text-xl font-semibold leading-tight">{admission.outstandingFen === null ? t('等收费员核对资金', 'Funding needs review') : `${t('需补交 ', 'Amount due ')}${formatFen(Math.max(0, admission.outstandingFen), locale)}`}</strong> : null}
      {admission.recordStatus === 'archived' ? <Badge variant="outline">{t('已归档 · 只读', 'Archived · read only')}</Badge> : null}</div>
    {identity.error ? <p role="alert" className="text-sm">{t('患者基本信息读取失败：', 'Patient information failed to load: ')}{getWorkspaceErrorMessage(identity.error, getWorkspaceMessages(locale))}<Button variant="outline" size="sm" onClick={() => void identity.refetch()}>{t('重试患者信息', 'Retry patient information')}</Button></p> : null}
  </WorkspacePatientCard></section>
  const aside = doctor ? <WorkspaceCard><InpatientDoctorReminders admission={admission} admissions={admissions} session={session} locale={locale} /></WorkspaceCard> : nurse && careOpen ? <WorkspaceCard title={t('检查检验结果', 'Investigation results')}>
    {investigations.isPending && careOpen ? <Skeleton className="h-20 w-full" /> : null}
    {investigations.error ? <p role="alert" className="text-sm">{t('检验结果读取失败：', 'Test results failed to load: ')}{getWorkspaceErrorMessage(investigations.error, getWorkspaceMessages(locale))}<Button variant="outline" size="sm" onClick={() => void investigations.refetch()}>{t('重试检验结果', 'Retry test results')}</Button></p> : null}
    {investigations.data?.laboratoryRequests.filter(request => request.report).map(request => <section className="flex flex-col gap-1 py-2" key={request.id}><h3 className="text-sm font-medium">{request.laboratoryService?.nameZh ?? request.catalogItemId}</h3>{request.report?.results.map(result => <p className="text-sm tabular-nums" key={result.code}>{result.display} · {typeof result.value === 'object' ? result.value.display : String(result.value)} {'unit' in result ? result.unit.display : ''} · {result.referenceRange.text}</p>)}</section>)}
    {investigations.data && !investigations.data.laboratoryRequests.some(request => request.report) ? <p className="text-sm text-muted-foreground">{t('暂无结果，送检后在这里查看已出的报告。', 'No results yet. Published reports appear here after dispatch.')}</p> : null}
  </WorkspaceCard> : role === 'medical-records' ? <WorkspaceCard><InpatientDrgReviewPanel admission={admission} session={session} locale={locale} write={write} active={active === 'record'} /></WorkspaceCard> : undefined
  const roleLabel = { 'ward-nurse': nurse ? t('病区护士', 'Ward nurse') : '', 'inpatient-doctor': t('住院医生', 'Inpatient doctor'), cashier: t('收费员', 'Cashier'), 'medical-records': t('病案人员', 'Medical records staff') }[role as 'ward-nurse' | 'inpatient-doctor' | 'cashier' | 'medical-records']
  return <InpatientAgentProvider value={agent}><InpatientActionProvider stage={active}><WorkspaceCardLayout id={id} locale={locale} queue={queue} patient={patient} aside={aside} flow={inpatientFlow(admission, locale)} action={<InpatientActionOutlet />}>
    {write.mutation.isSuccess ? <InpatientPrimaryAction stage={active} priority={-100}><WorkspaceActionBar tone="complete" summary={<span role="status">{t('已完成本次操作', 'Action completed')}</span>} reason={waiting[active]} /></InpatientPrimaryAction> : null}
    {notices}
    <WorkspaceTabs id={`${id}-stage`} items={tabs} value={active} onValueChange={changeStage} locale={locale}>
      {tabs.map(stage => <TabsContent key={stage.value} value={stage.value} data-inpatient-stage={stage.value} keepMounted className="min-h-0 min-w-0 overflow-y-auto">{active === stage.value || visited.includes(stage.value as InpatientStage) ? <WorkspaceCard title={stage.label} description={<div className="flex flex-col gap-2"><ol className="flex flex-wrap gap-2">{(zh ? stageOwners : stageOwnersEn)[stage.value as InpatientStage].map((owner, index) => <li key={index}>{roleLabel && owner.startsWith(roleLabel) ? <strong>{owner}</strong> : owner}</li>)}</ol><p>{counts[stage.value as InpatientStage] > 0 ? `${t('轮到你：', 'Your turn: ')}${actions[stage.value as InpatientStage]}` : waiting[stage.value as InpatientStage]}</p></div>}>
        {stage.value === 'admission' ? nurse && admission.recordStatus !== 'archived' ? <InpatientBedAssignment admission={admission} admissions={admissions} catalog={catalog} locale={locale} write={write} /> : <p>{waiting.admission}</p> : null}
        {stage.value === 'orders' ? <InpatientClinical admission={admission} session={session} locale={locale} write={write} active={active === stage.value} /> : null}
        {stage.value === 'drg' ? <InpatientDrgPanel admission={admission} session={session} locale={locale} write={write} active={active === stage.value} /> : null}
        {stage.value === 'investigations' ? <InpatientInvestigations admission={admission} session={session} locale={locale} write={write} /> : null}
        {stage.value === 'surgery' ? <InpatientSurgery admission={admission} session={session} locale={locale} write={write} /> : null}
        {stage.value === 'transfer' ? <InpatientTransfers admission={admission} session={session} locale={locale} write={write} /> : null}
        {stage.value === 'fees' ? cashier ? <><InpatientDrgReviewPanel admission={admission} session={session} locale={locale} write={write} active={active === stage.value} /><InpatientCharges admissionId={admission.id} session={session} locale={locale} write={write} /></> : <InpatientClinical admission={admission} session={session} locale={locale} write={write} view="fees" /> : null}
        {stage.value === 'discharge' ? cashier ? <InpatientSettlement admission={admission} session={session} locale={locale} write={write} /> : <InpatientDischarge admission={admission} session={session} locale={locale} write={write} activity={activity} /> : null}
        {stage.value === 'record' ? <InpatientRecord admission={admission} session={session} locale={locale} write={write} catalog={catalog} /> : null}
      </WorkspaceCard> : null}</TabsContent>)}
    </WorkspaceTabs>
  </WorkspaceCardLayout></InpatientActionProvider></InpatientAgentProvider>
}

function InpatientBedAssignment({ admission, admissions, catalog, locale, write }: Pick<Props, 'admission' | 'admissions' | 'catalog' | 'locale' | 'write'>): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const [bedId, setBedId] = useState<string | null>(null), [swapId, setSwapId] = useState<string | null>(null)
  const assignBed = () => {
    if (bedId !== null) write.mutation.mutate({ operation: admission.status === 'registered' ? 'inpatient.admission.receive' : 'inpatient.admission.move-bed', input: { admissionId: admission.id, encounterVersion: admission.versionId, bedId } })
  }
  const swapBeds = () => {
    const other = admissions.find(item => item.id === swapId)
    if (other) write.mutation.mutate({ operation: 'inpatient.admission.swap-bed', input: { admissionId: admission.id, encounterVersion: admission.versionId, otherAdmissionId: other.id, otherEncounterVersion: other.versionId } })
  }
  return <FieldSet disabled={write.blocked}><FieldGroup className="grid gap-3 md:grid-cols-2">
    <Field><FieldLabel htmlFor="inpatient-bed">{t('目标床位', 'Target bed')}</FieldLabel><WorkspaceSelect id="inpatient-bed" value={bedId} items={(catalog?.beds ?? []).filter(bed => bed.wardId === admission.wardId && bed.admissionId === undefined).map(bed => ({ value: bed.id, label: `${bed.name} · ${formatFen(bed.dailyPriceFen, locale)}/${t('日', 'day')}` }))} onValueChange={setBedId} /></Field>
    <InpatientPrimaryAction stage="admission"><WorkspaceActionBar summary={admission.patientName} reason={bedId === null ? t('还差：选择目标床位', 'Choose a target bed') : undefined} action={<Button disabled={write.blocked || bedId === null || !['registered', 'admitted'].includes(admission.status)} onClick={assignBed}>{admission.status === 'registered' ? t('接诊并分床', 'Receive and assign bed') : t('转床', 'Move bed')}</Button>} tone={bedId === null ? 'blocked' : 'normal'} /></InpatientPrimaryAction>
    {admission.status === 'admitted' ? <><Field><FieldLabel htmlFor="inpatient-swap">{t('换床患者', 'Swap with')}</FieldLabel><WorkspaceSelect id="inpatient-swap" value={swapId} items={admissions.filter(item => item.id !== admission.id && item.wardId === admission.wardId && item.status === 'admitted').map(item => ({ value: item.id, label: `${item.patientName} · ${catalog?.beds.find(bed => bed.id === item.bedId)?.name}` }))} onValueChange={setSwapId} /></Field><Button disabled={write.blocked || swapId === null} onClick={swapBeds}>{t('互换床位', 'Swap beds')}</Button></> : null}
  </FieldGroup></FieldSet>
}
