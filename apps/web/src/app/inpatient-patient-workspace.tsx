import { scenarioStateSchema, type SessionContext } from '@clinmesh/contracts/his'
import { inpatientCatalogSchema, type InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { z } from 'zod'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@clinmesh/ui/components/tabs'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@clinmesh/ui/components/sheet'
import { BellIcon, CheckIcon, CopyIcon, MinusIcon, RefreshCwIcon } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useState } from 'react'
import { InpatientClinical } from './inpatient-clinical.tsx'
import { InpatientDoctorPatientList } from './inpatient-doctor-patient-list.tsx'
import { InpatientDoctorReminders } from './inpatient-doctor-reminders.tsx'
import { InpatientFundingBadge } from './inpatient-funding-badge.tsx'
import { inpatientCareDay } from './inpatient-scope.ts'
import { InpatientDrgPanel } from './inpatient-drg.tsx'
import { InpatientCharges } from './inpatient-charges.tsx'
import { InpatientDischarge, InpatientSettlement } from './inpatient-discharge.tsx'
import { InpatientInvestigations } from './inpatient-investigations.tsx'
import { InpatientRecord } from './inpatient-record.tsx'
import { inpatientStageStates, type InpatientStageId, type InpatientStageState } from './inpatient-stage-states.ts'
import { InpatientSurgery } from './inpatient-surgery.tsx'
import { InpatientTransfers } from './inpatient-transfers.tsx'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { apiGet } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

type Stage = InpatientStageId
const stages = [
  { id: 'admission', zh: '入科分床', en: 'Admission', ownerZh: '病区护士', ownerEn: 'Ward nurse', conditionZh: '登记完成后由病区护士接诊并分床，入科后开始住院诊疗。', conditionEn: 'After registration, the ward nurse receives the patient and assigns a bed before inpatient care.' },
  { id: 'orders', zh: '诊断医嘱', en: 'Diagnoses & orders', ownerZh: '住院医生 → 病区护士 → 药师', ownerEn: 'Inpatient doctor → ward nurse → pharmacist', conditionZh: '入科后医生确认诊断、签发医嘱；护士校对后执行。药品须先由药师在“住院药房”发药，再由护士给药。', conditionEn: 'After admission, the doctor confirms diagnoses and issues orders. Nurses verify before execution; medication must be dispensed in Inpatient pharmacy before administration.' },
  { id: 'investigations', zh: '检查检验', en: 'Investigations', ownerZh: '住院医生 → 病区护士 → 检验 / 检查执行岗位', ownerEn: 'Inpatient doctor → ward nurse → investigation staff', conditionZh: '入科后开立申请，由病区护士校对并送检；执行岗位签发报告后，回到本次住院查看并确认已阅。', conditionEn: 'Order after admission; the ward nurse verifies and dispatches. Published reports return to this admission for review.' },
  { id: 'surgery', zh: '手术', en: 'Surgery', ownerZh: '住院医生 → 病区护士 → 住院医生', ownerEn: 'Inpatient doctor → ward nurse → inpatient doctor', conditionZh: '医生申请手术并确认知情同意已签署，护士完成术前检查核对，两项准备齐全后才能记录实际手术。术后医嘱在“诊断医嘱”办理。', conditionEn: 'The doctor requests surgery and confirms signed consent; the nurse verifies preoperative checks. Both are required before recording surgery. Issue postoperative orders under Diagnoses & orders.' },
  { id: 'transfer', zh: '转科交接', en: 'Transfer', ownerZh: '住院医生 → 原病区护士 → 接收病区护士', ownerEn: 'Inpatient doctor → source nurse → receiving nurse', conditionZh: '转科申请须先完成原病区交接，再由目标病区护士接收并分床；接收后切换责任病区。', conditionEn: 'Source handover precedes receiving nurse acceptance and bed assignment; responsibility changes on receipt.' },
  { id: 'fees', zh: '费用', en: 'Charges', ownerZh: '收费员', ownerEn: 'Cashier', conditionZh: '费用来自实际执行、发药、手术及每日床费；收费员可核对并按原费用冲正，预交金独立记录。', conditionEn: 'Charges come from actual execution, dispensing, surgery and daily bed fees. Cashiers reconcile and reverse original charges; deposits remain separate.' },
  { id: 'discharge', zh: '出院结算', en: 'Discharge & settlement', ownerZh: '住院医生 → 病区护士 → 收费员', ownerEn: 'Inpatient doctor → ward nurse → cashier', conditionZh: '医生开出院医嘱，护士办理出区后收费员才能结算；结算完成后护士清床。未收口的医嘱、检查、手术或转科会阻止出院。', conditionEn: 'The doctor orders discharge, the nurse records departure, the cashier settles, then the nurse clears the bed. Outstanding care can block discharge.' },
  { id: 'record', zh: '病案', en: 'Medical record', ownerZh: '住院医生 → 病案人员', ownerEn: 'Inpatient doctor → medical records staff', conditionZh: '医生核对真实来源并提交首页，病案人员编码审核；结算并清床、当前修订审核通过后方可归档。来源变化需重新提交与审核，归档后只读。', conditionEn: 'The doctor submits the record from real sources; medical records staff review coding. Settlement, bed clearance and current approval precede archiving. Source changes require resubmission and review; archived records are read only.' },
  { id: 'drg', zh: 'DRG 与费用推演', en: 'DRG & charges', ownerZh: '住院医生', ownerEn: 'Inpatient doctor', conditionZh: '读取正式诊疗与费用，比较治疗计划及草稿；预留转实际使用后不再重复推算。', conditionEn: 'Compare confirmed care and charges with plans and drafts. Reservations replaced by actual use are not counted twice.' },
] as const

export function inpatientStatus(admission: InpatientAdmission, locale: WorkspaceLocale): string {
  const zh = locale === 'zh-CN'
  return { registered: zh ? '待入科' : 'Registered', admitted: zh ? '在院' : 'Admitted', 'discharge-pending': zh ? '待出院' : 'Discharge pending', departed: zh ? '已出区' : 'Departed', cleared: zh ? '已清床' : 'Cleared' }[admission.status]
}

function nextStep(admission: InpatientAdmission, locale: WorkspaceLocale): { stage: Stage; text: string } {
  const zh = locale === 'zh-CN'
  if (admission.recordStatus === 'archived') return { stage: 'record', text: zh ? '归档完成，可在病案区查询固定首页。' : 'Archiving complete; read the fixed snapshot under Medical record.' }
  if (admission.status === 'registered') return { stage: 'admission', text: zh ? '病区护士 → 入科分床 → 接诊并分床' : 'Ward nurse → Admission → Receive and assign bed' }
  if (admission.status === 'admitted') return { stage: 'orders', text: zh ? '住院医生 → 诊断医嘱；病区护士 → 校对与执行' : 'Inpatient doctor → Diagnoses & orders; ward nurse → verify and execute' }
  if (admission.status === 'discharge-pending') return { stage: 'discharge', text: zh ? '病区护士 → 出院结算 → 办理出区' : 'Ward nurse → Discharge & settlement → Record departure' }
  if (admission.status === 'departed') return { stage: 'discharge', text: admission.financialStatus === 'settled' ? (zh ? '病区护士 → 出院结算 → 清床' : 'Ward nurse → Discharge & settlement → Clear bed') : (zh ? '收费员 → 住院费用 → 出院结算 → 预览并确认结算' : 'Cashier → Inpatient charges → Discharge & settlement → Preview and confirm settlement') }
  return { stage: 'record', text: zh ? '住院医生 → 病案 → 提交首页；病案人员 → 编码审核与归档' : 'Inpatient doctor → Medical record → Submit; medical records staff → Review and archive' }
}

// 住院号较长会挤占横幅；展示截断值，复制动作保留完整原值。
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

type Props = { allowTransfers: boolean; admission: InpatientAdmission; admissions: InpatientAdmission[]; catalog: z.infer<typeof inpatientCatalogSchema> | undefined; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent> }
const stageGroups: Array<{ zh: string; en: string; ids: Stage[] }> = [
  { zh: '入院', en: 'Admission', ids: ['admission'] },
  { zh: '在院', en: 'In care', ids: ['orders', 'investigations', 'surgery', 'transfer', 'fees', 'drg'] },
  { zh: '出院', en: 'Discharge', ids: ['discharge'] },
  { zh: '病案', en: 'Record', ids: ['record'] },
]
const optionalStages: ReadonlySet<Stage> = new Set(['investigations', 'surgery', 'transfer'])
const stateMarker: Record<InpatientStageState, { icon: 'done' | 'current' | 'closed' | null; titleZh: string; titleEn: string }> = {
  done: { icon: 'done', titleZh: '已完成', titleEn: 'Done' },
  current: { icon: 'current', titleZh: '进行中', titleEn: 'Current' },
  todo: { icon: null, titleZh: '待办', titleEn: 'Upcoming' },
  closed: { icon: 'closed', titleZh: '已关闭，本次住院未发生', titleEn: 'Closed; did not occur this admission' },
}
export function InpatientPatientWorkspace({ admission: selectedAdmission, admissions, catalog, allowTransfers, session, locale, write }: Props): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const role = session.actor.roleCode, nurse = role === 'ward-nurse', doctor = role === 'inpatient-doctor', cashier = role === 'cashier'
  const clinical = doctor || nurse
  const scenario = useQuery({ queryKey: ['scenario', 'virtual-time'], queryFn: ({ signal }) => apiGet('/api/sim/v1/scenario-runs/current', scenarioStateSchema, signal), retry: false })
  // 医生站左栏就地切换当前查看的住院；其余岗位始终跟随外层选中的患者。
  const [viewedId, setViewedId] = useState<string | null>(null)
  const admission = doctor ? admissions.find(item => item.id === viewedId) ?? selectedAdmission : selectedAdmission
  const [selectedStage, setSelectedStage] = useState<Stage | null>(null), [visited, setVisited] = useState<Stage[]>([])
  const [remindersOpen, setRemindersOpen] = useState(false)
  // 就地切换患者后回到默认阶段，visited 只描述当前住院访问过的环节。
  const [lastViewedId, setLastViewedId] = useState(admission.id)
  if (lastViewedId !== admission.id) { setLastViewedId(admission.id); setSelectedStage(null); setVisited([]) }
  const archived = admission.recordStatus === 'archived'
  const next = nextStep(admission, locale)
  const stageStates = inpatientStageStates(admission)
  const careDay = inpatientCareDay(admission, scenario.data?.virtualTime)
  const defaultStage = cashier ? 'discharge' : role === 'registrar' ? 'admission' : archived || role === 'medical-records' ? 'record' : next.stage
  const active = selectedStage ?? defaultStage
  const client = useQueryClient()
  const ward = catalog?.wards.find(item => item.id === admission.wardId), bed = catalog?.beds.find(item => item.id === admission.bedId)
  // 病区与床位合成一个事实；已有床位 ID 但目录未取得时显示未知，不宣示未分床。
  const place = ward === undefined ? '—' : `${ward.name} · ${bed !== undefined ? bed.name : admission.bedId === undefined ? t('未分床', 'Unassigned') : '—'}`
  // 在院未结算是常态，不显示；出院流程中与结算完成后才有信息量。
  const settle = admission.financialStatus === 'settled' ? t('已结算', 'Settled') : admission.status === 'discharge-pending' || admission.status === 'departed' ? t('待结算', 'To settle') : null
  const changeStage = (stage: Stage) => { setSelectedStage(stage); setVisited(current => [...new Set([...current, active, stage])]) }
  const visibleStages = stages.filter(stage => (stage.id !== 'transfer' || clinical && allowTransfers) && (stage.id !== 'drg' || doctor))
  const mayRead = (stage: Stage) => {
    if (stage === 'admission') return true
    if (stage === 'record') return clinical || role === 'medical-records'
    if (stage === 'drg') return doctor
    if (stage === 'fees' || stage === 'discharge') return cashier || clinical && !archived
    return clinical && !archived
  }
  const workspace = <section aria-label={t('住院详情', 'Admission details')} className="flex min-h-0 flex-1 flex-col">
    <section aria-label={t('当前住院患者', 'Current inpatient')} className="flex max-h-[40%] shrink-0 flex-col gap-2 overflow-y-auto border-b bg-background px-4 py-3">
      <div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold">{admission.patientName}</h2>{careDay !== undefined ? <Badge variant="outline">{t(`住院第 ${careDay} 天`, `Day ${careDay}`)}</Badge> : null}<InpatientNumber locale={locale} number={admission.inpatientNumber} /><Badge variant="secondary">{inpatientStatus(admission, locale)}</Badge><InpatientFundingBadge outstandingFen={admission.outstandingFen} locale={locale} />{archived ? <Badge variant="outline">{t('已归档 · 只读', 'Archived · read only')}</Badge> : null}</div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground"><span>{place}</span><span>{t('预交 ', 'Deposit ')}<span className="font-mono tabular-nums">{formatFen(admission.depositFen, locale)}</span></span><span>{t('费用 ', 'Charges ')}<span className="font-mono tabular-nums">{formatFen(admission.chargesFen, locale)}</span></span>{settle === null ? null : <span>{settle}</span>}</div>
    </section>
    <Tabs value={active} onValueChange={value => { if (visibleStages.some(stage => stage.id === value)) changeStage(value as Stage) }} className="min-h-0 flex-1 gap-0">
      <div className="flex shrink-0 items-center gap-2 border-b px-4"><div className="min-w-0 flex-1 overflow-x-auto"><TabsList aria-label={t('住院阶段', 'Inpatient stages')} variant="line" className="min-w-max gap-2">{stageGroups.map(group => {
        const groupStages = visibleStages.filter(stage => group.ids.includes(stage.id))
        if (groupStages.length === 0) return null
        return <Fragment key={group.zh}>
          <span aria-hidden className="flex items-center gap-2 ps-1 text-xs font-medium text-muted-foreground"><span>{zh ? group.zh : group.en}</span><span className="h-4 w-px bg-border" /></span>
          {groupStages.map(stage => {
            const state = stageStates[stage.id], marker = stateMarker[state]
            return <TabsTrigger key={stage.id} value={stage.id} data-stage-state={state} title={t(marker.titleZh, marker.titleEn)}>
              {marker.icon === 'done' ? <CheckIcon aria-hidden className="size-3.5 shrink-0 text-green-700 dark:text-green-500" />
                : marker.icon === 'current' ? <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />
                  : marker.icon === 'closed' ? <MinusIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /> : null}
              {zh ? stage.zh : stage.en}
              {optionalStages.has(stage.id) ? <span aria-hidden className="text-[10px] font-normal text-muted-foreground">{t('可选', 'optional')}</span> : null}
            </TabsTrigger>
          })}
        </Fragment>
      })}</TabsList></div><Button size="icon-sm" variant="ghost" aria-label={t('刷新诊疗记录', 'Refresh care')} onClick={() => void client.invalidateQueries({ queryKey: ['inpatient'] })}><RefreshCwIcon aria-hidden /></Button></div>
      {visibleStages.map(stage => <TabsContent key={stage.id} value={stage.id} keepMounted className="min-h-0 overflow-y-auto p-4">
        {active === stage.id || visited.includes(stage.id) ? <div key={admission.id} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1"><h3 className="text-base font-medium">{zh ? stage.zh : stage.en}</h3><p className="text-sm text-muted-foreground">{t('负责岗位：', 'Responsible: ')}{zh ? stage.ownerZh : stage.ownerEn}</p><p className="text-sm text-muted-foreground">{zh ? stage.conditionZh : stage.conditionEn}</p></div>
          {admission.status === 'registered' && stage.id !== 'admission' ? <Alert role="note"><AlertDescription>{t('尚未入科。请先由病区护士在“入科分床”接诊并分床。', 'Not yet received. The ward nurse must receive and assign a bed under Admission first.')}</AlertDescription></Alert> : null}
          {!mayRead(stage.id) ? <Alert role="note"><AlertDescription>{archived ? t('病案已归档，诊疗写入关闭；有权限的岗位可在“病案”查询归档快照。', 'The record is archived and care writes are closed. Authorized staff can read the archived snapshot under Medical record.') : t('请由上述负责岗位从自己的工作台进入本环节办理。切换环节不会变更当前账户或岗位。', 'The responsible staff must continue from their own workspace. Changing stages does not change your account or role.')}</AlertDescription></Alert> : <>
            {stage.id === 'admission' ? nurse && !archived ? <InpatientBedAssignment admission={admission} admissions={admissions} catalog={catalog} locale={locale} write={write} /> : <p>{admission.status === 'registered' ? t('登记已完成，等待病区护士接诊。', 'Registration completed; awaiting ward nurse receipt.') : t('入科登记已完成；床位变更由病区护士办理。', 'Admission received; the ward nurse handles bed changes.')}</p> : null}
            {stage.id === 'orders' ? <InpatientClinical admission={admission} session={session} locale={locale} write={write} active={active === stage.id} /> : null}
            {stage.id === 'drg' ? <InpatientDrgPanel admission={admission} session={session} locale={locale} write={write} active={active === stage.id} /> : null}
            {stage.id === 'investigations' ? <InpatientInvestigations admission={admission} session={session} locale={locale} write={write} /> : null}
            {stage.id === 'surgery' ? <InpatientSurgery admission={admission} session={session} locale={locale} write={write} /> : null}
            {stage.id === 'transfer' ? <InpatientTransfers admission={admission} session={session} locale={locale} write={write} /> : null}
            {stage.id === 'fees' ? cashier ? <InpatientCharges admissionId={admission.id} session={session} locale={locale} write={write} /> : <InpatientClinical admission={admission} session={session} locale={locale} write={write} view="fees" /> : null}
            {stage.id === 'discharge' ? cashier ? <InpatientSettlement admission={admission} session={session} locale={locale} write={write} /> : <InpatientDischarge admission={admission} session={session} locale={locale} write={write} /> : null}
            {stage.id === 'record' ? <InpatientRecord admission={admission} session={session} locale={locale} write={write} /> : null}
          </>}
        </div> : null}
      </TabsContent>)}
    </Tabs>
  </section>
  if (!doctor) return workspace
  // 医生站三栏：患者列表 / 工作区 / 临床提醒栏；窄容器下右栏降级为抽屉，左栏在更窄容器隐藏。
  const reminders = <InpatientDoctorReminders admission={admission} admissions={admissions} session={session} locale={locale} />
  return <div className="@container/inp-doctor relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
    <div className="grid min-h-0 min-w-0 flex-1 @min-[720px]/inp-doctor:grid-cols-[200px_minmax(0,1fr)] @min-[1080px]/inp-doctor:grid-cols-[200px_minmax(0,1fr)_300px]">
      <aside aria-label={t('住院患者列表', 'Inpatient list')} data-inpatient-region="patient-list" className="min-h-0 min-w-0 overflow-y-auto border-r bg-card @max-[720px]/inp-doctor:hidden">
        <InpatientDoctorPatientList admissions={admissions} viewedId={admission.id} catalog={catalog} virtualTime={scenario.data?.virtualTime} locale={locale} onSelect={setViewedId} />
      </aside>
      <div data-inpatient-region="workspace" className="flex min-h-0 min-w-0 flex-col @max-[1080px]/inp-doctor:pb-14">{workspace}</div>
      <aside aria-label={t('临床提醒', 'Clinical reminders')} data-inpatient-region="reminders" className="hidden min-h-0 min-w-0 overflow-y-auto border-l bg-card @min-[1080px]/inp-doctor:block">
        {reminders}
      </aside>
    </div>
    <Button aria-expanded={remindersOpen} aria-haspopup="dialog" className="@min-[1080px]/inp-doctor:hidden absolute right-4 bottom-4 z-10"
      onClick={() => setRemindersOpen(true)} size="icon-sm" variant="secondary">
      <BellIcon aria-hidden />
      <span className="sr-only">{t('打开临床提醒', 'Open clinical reminders')}</span>
    </Button>
    <Sheet onOpenChange={setRemindersOpen} open={remindersOpen}>
      <SheetContent className="w-80 sm:max-w-80" side="right">
        <SheetHeader>
          <SheetTitle>{t('临床提醒', 'Clinical reminders')}</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{reminders}</div>
      </SheetContent>
    </Sheet>
  </div>
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
    <Button disabled={write.blocked || bedId === null || !['registered', 'admitted'].includes(admission.status)} onClick={assignBed}>{admission.status === 'registered' ? t('接诊并分床', 'Receive and assign bed') : t('转床', 'Move bed')}</Button>
    {admission.status === 'admitted' ? <><Field><FieldLabel htmlFor="inpatient-swap">{t('换床患者', 'Swap with')}</FieldLabel><WorkspaceSelect id="inpatient-swap" value={swapId} items={admissions.filter(item => item.id !== admission.id && item.wardId === admission.wardId && item.status === 'admitted').map(item => ({ value: item.id, label: `${item.patientName} · ${catalog?.beds.find(bed => bed.id === item.bedId)?.name}` }))} onValueChange={setSwapId} /></Field><Button disabled={write.blocked || swapId === null} onClick={swapBeds}>{t('互换床位', 'Swap beds')}</Button></> : null}
  </FieldGroup></FieldSet>
}
