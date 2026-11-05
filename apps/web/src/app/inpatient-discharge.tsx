import { inpatientDischargeEventsSchema, inpatientSettlementPreviewSchema, inpatientPaymentsSchema, type inpatientDepartureMethodSchema } from '@clinmesh/contracts/inpatient-discharge'
import { InpatientFinancialAdjustments } from './inpatient-financial-adjustments.tsx'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { z } from 'zod'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { CheckCircle2Icon, CircleIcon } from 'lucide-react'
import { Input } from '@clinmesh/ui/components/input'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { apiGet } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { formatFen, formatShanghaiMinute } from './workspace-format.ts'
import { inpatientFrequencyLabel } from './inpatient-labels.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InsurancePanel } from './insurance-panel.tsx'
import { InpatientFunding } from './inpatient-funding.tsx'
import { WorkspaceActionBar, WorkspaceFlow, useWorkspaceConfirmation } from './workspace-card-layout.tsx'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import type { InpatientActivity } from './inpatient-stage-activity.ts'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>; activity?: InpatientActivity; onOpenStage?: (stage: 'surgery' | 'investigations' | 'transfer' | 'orders') => void }
type CheckItem = { key: string; done: boolean; title: string; detail: string; owner?: string; go?: { label: string; stage: 'surgery' | 'investigations' | 'transfer' | 'orders' } }

function DischargeChecklist({ label, items, onOpenStage, badge, children }: { label: string; items: CheckItem[]; onOpenStage: Props['onOpenStage']; badge?: string | undefined; children?: React.ReactNode }) {
  return <section aria-label={label} className="clinmesh-inpatient-preparation"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium">{label}</h4>{badge ? <Badge variant="warning">{badge}</Badge> : null}</div>
    <ul className="clinmesh-inpatient-preparation-list">{items.map(item => <li key={item.key} data-complete={item.done}>
      {item.done ? <CheckCircle2Icon aria-hidden="true" /> : <CircleIcon aria-hidden="true" />}
      <div><strong>{item.title}</strong><span className="text-muted-foreground">{item.detail}</span></div>
      <div className="clinmesh-inpatient-preparation-owner">{item.owner ? <span>{item.owner}</span> : null}
        {item.go && onOpenStage ? <Button variant="link" size="sm" onClick={() => onOpenStage(item.go!.stage)}>{item.go.label}</Button> : null}</div>
    </li>)}</ul>{children}</section>
}

export function InpatientDischarge({ admission, session, locale, write, activity, onOpenStage }: Props): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const doctor = session.actor.roleCode === 'inpatient-doctor', nurse = session.actor.roleCode === 'ward-nurse'
  const [reason, setReason] = useState(''), [method, setMethod] = useState<z.infer<typeof inpatientDepartureMethodSchema> | null>(null)
  const [recallOpen, setRecallOpen] = useState(false), [recallReason, setRecallReason] = useState('')
  const methods = { home: t('医嘱离院','Discharged home'), transfer: t('医嘱转院','Transferred'), 'against-advice': t('非医嘱离院','Against medical advice'), death: t('死亡','Death'), other: t('其他','Other') }
  const events = useQuery({ queryKey: ['inpatient',session.actor.workspaceId,session.actor.epoch,session.actor.practitionerRoleId,admission.id,'discharge-events'],
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/discharge`, inpatientDischargeEventsSchema, signal) })
  const blocked = write.blocked || !reason.trim()
  const openSurgeries = activity?.surgery?.requests.filter(request => request.status === 'requested' || request.status === 'ready') ?? []
  const pendingSurgeries = openSurgeries.length
  const pendingInvestigations = [...activity?.investigations?.laboratoryRequests ?? [], ...activity?.investigations?.imagingRequests ?? []]
    .filter(request => ['issued', 'accepted', 'in-progress', 'generation-failed'].includes(request.status)).length
  const pendingTransfers = activity?.transfers?.transfers.filter(transfer => transfer.status === 'requested' || transfer.status === 'handed-over').length ?? 0
  const outstanding = pendingSurgeries + pendingInvestigations + pendingTransfers
  const issueBlocked = doctor && admission.status === 'admitted' && outstanding > 0
  const activeOrders = activity?.clinical?.orders.filter(order => !['stopped', 'completed'].includes(order.state)) ?? []
  const pendingOrders = activeOrders.length
  // 停嘱须先由医生申请；已申请的等护士核对。
  const doctorStops = activity?.clinical?.orders.filter(order => order.state === 'signed' || order.state === 'verified').length ?? 0
  const nurseStops = activity?.clinical?.orders.filter(order => order.state === 'stop-requested').length ?? 0
  const pendingAdministrations = activity?.clinical?.executions.filter(execution => !['completed', 'cancelled'].includes(execution.status)
    && activity.clinical?.orders.find(order => order.id === execution.orderId)?.kind === 'medication').length ?? 0
  const pendingServices = activity?.clinical?.executions.filter(execution => !['completed', 'cancelled'].includes(execution.status)
    && activity.clinical?.orders.find(order => order.id === execution.orderId)?.kind === 'service').length ?? 0
  const departureBlocked = nurse && admission.status === 'discharge-pending'
    && (activity !== undefined && activity.clinical === undefined || pendingOrders + pendingAdministrations + pendingServices > 0)
  const needsDischargeOrder = nurse && admission.status === 'admitted'
  const nurseClosing = nurse && (needsDischargeOrder || admission.status === 'discharge-pending')
  const noteMissing = !reason.trim() ? t('还差：出院处理说明', 'Enter a discharge note.') : undefined
  const missing = needsDischargeOrder ? t('等住院医生开出院医嘱，再由病区护士办理实际离院。', 'The inpatient doctor orders discharge before the ward nurse records departure.')
    : nurse && admission.status === 'discharge-pending' && activity !== undefined && activity.clinical === undefined
    ? t('医嘱资料未就绪，请先完成读取与核对。', 'Load and review clinical orders before discharge.')
    : nurseClosing && pendingOrders + pendingAdministrations + pendingServices > 0
    ? t(`还差 ${pendingOrders} 条医嘱、${pendingAdministrations} 次给药${pendingServices ? `、${pendingServices} 次执行` : ''}；请住院医生停嘱，再由病区护士核对并完成或取消执行。`, `${pendingOrders} orders and ${pendingAdministrations} administrations remain; the inpatient doctor requests stops, then the ward nurse verifies and completes or cancels execution.`)
    : noteMissing ? noteMissing
      : nurse && admission.status === 'discharge-pending' && method === null ? t('还差：选择离院方式。', 'Select the departure method.')
        : nurse && admission.status === 'departed' && admission.financialStatus !== 'settled' ? t('等收费员结算后再清床。', 'Wait for cashier settlement before clearing the bed.') : undefined
  const action = (operation: 'inpatient.discharge.issue' | 'inpatient.discharge.clear') => write.mutation.mutate({ operation,
    input: { admissionId: admission.id, encounterVersion: admission.versionId, reason } })
  const canRecall = doctor && admission.status === 'departed' && admission.financialStatus === 'open' && !!admission.bedId
  const kinds = { issue:t('出院医嘱','Discharge order'),depart:t('实际离院','Departure'),recall:t('召回','Recall'),clear:t('清床','Bed cleared') }
  const latest = (kind: 'issue' | 'depart') => events.data?.events.filter(event => event.kind === kind).at(-1)
  const history = events.data?.events.map(event => <p key={event.id}>{formatShanghaiMinute(event.virtualTime)} · {kinds[event.kind]}{event.departureMethod ? ` · ${methods[event.departureMethod]}` : ''} · {event.reason}</p>)
  const known = (value: unknown, count: number, done: string, open: string) => value === undefined ? t('正在读取', 'Loading') : count === 0 ? done : open
  const beforeIssue: CheckItem[] = [
    { key: 'surgery', done: activity?.surgery !== undefined && pendingSurgeries === 0, title: t('手术申请', 'Surgery requests'), detail: known(activity?.surgery, pendingSurgeries, t('无未收口申请', 'None outstanding'), t(`${openSurgeries.map(request => `${request.plannedProcedure.coding.display}（${request.plannedProcedure.coding.code}）`).join('、')}尚未实施或取消`, `${openSurgeries.map(request => `${request.plannedProcedure.coding.display} (${request.plannedProcedure.coding.code})`).join(', ')} not yet performed or cancelled`)),
      ...(pendingSurgeries ? { owner: t('住院医生', 'Inpatient doctor'), go: { label: t('去手术', 'Open surgery'), stage: 'surgery' as const } } : {}) },
    { key: 'investigations', done: activity?.investigations !== undefined && pendingInvestigations === 0, title: t('检查检验', 'Investigations'), detail: known(activity?.investigations, pendingInvestigations, t('已全部完成或取消', 'All complete or cancelled'), t(`${pendingInvestigations} 项检查检验尚未完成或取消`, `${pendingInvestigations} requests remain incomplete or uncancelled`)),
      ...(pendingInvestigations ? { owner: t('住院医生与医技科室', 'Doctor and investigation staff'), go: { label: t('去检查检验', 'Open investigations'), stage: 'investigations' as const } } : {}) },
    { key: 'transfer', done: pendingTransfers === 0, title: t('转科', 'Transfers'), detail: pendingTransfers === 0 ? t('无', 'None') : t(`${pendingTransfers} 项转科任务尚未接收或取消`, `${pendingTransfers} transfers remain unreceived or uncancelled`),
      ...(pendingTransfers ? { owner: t('转科相关岗位', 'Transfer staff'), go: { label: t('去转科交接', 'Open transfer'), stage: 'transfer' as const } } : {}) },
    { key: 'orders', done: activity?.clinical !== undefined && pendingOrders === 0, title: t('在用医嘱', 'Active orders'), detail: known(activity?.clinical, pendingOrders, t('已全部停止或完成', 'All stopped or completed'), `${activeOrders.map(order => `${order.display} ${order.doseText} ${inpatientFrequencyLabel(order.frequencyCode, locale, false)} · ${order.duration === 'long' ? t('长期', 'long-term') : t('临时', 'temporary')}`).join(t('；', '; '))} ${t('未停', 'still active')}`),
      ...(doctorStops ? { owner: t('住院医生', 'Inpatient doctor'), go: { label: t('去停嘱', 'Request stops'), stage: 'orders' as const } } : {}) },
  ]
  const beforeDeparture: CheckItem[] = [
    { key: 'stop', done: activity?.clinical !== undefined && doctorStops === 0, title: t('停嘱', 'Request stops'), detail: known(activity?.clinical, doctorStops, t('医嘱已全部停止', 'All orders stopped'), t(`${doctorStops} 条医嘱`, `${doctorStops} orders`)),
      ...(doctorStops ? { owner: t('住院医生', 'Inpatient doctor'), go: { label: t('去停嘱', 'Request stops'), stage: 'orders' as const } } : {}) },
    ...(nurseStops ? [{ key: 'verify-stop', done: false, title: t('核对停嘱', 'Verify stops'), detail: t(`${nurseStops} 条医嘱`, `${nurseStops} orders`), owner: t('病区护士', 'Ward nurse') }] : []),
    ...(pendingAdministrations + pendingServices ? [{ key: 'execution', done: false, title: t('完成或取消执行', 'Complete or cancel executions'), detail: t(`${pendingAdministrations + pendingServices} 次`, `${pendingAdministrations + pendingServices}`), owner: t('病区护士', 'Ward nurse') }] : []),
    { key: 'depart', done: false, title: t('核对医嘱、选择离院方式、办理离院', 'Verify orders, choose departure method, record departure'), detail: t('护士在病区工作台办理', 'Recorded by the ward nurse'), owner: t('病区护士', 'Ward nurse') },
  ]
  const noteField = <Field><div className="flex items-baseline gap-1"><FieldLabel htmlFor="inpatient-discharge-reason">{t('出院处理说明','Discharge note')}</FieldLabel><span aria-hidden="true" className="text-xs text-muted-foreground">{t('必填', 'Required')}</span></div>
    <Textarea id="inpatient-discharge-reason" aria-required="true" value={reason} placeholder={t('例如：治疗完成，带药出院，一周后门诊复诊', 'For example: treatment complete, discharged with medication, clinic follow-up in one week')} onChange={event => setReason(event.currentTarget.value)} />
    <FieldDescription>{t('写入出院办理记录，病区护士办理离院时能看到。', 'Saved to the discharge history and shown to the ward nurse at departure.')}</FieldDescription></Field>
  const doctorHistory = events.data?.events.length ? <section aria-label={t('出院办理记录', 'Discharge history')} className="clinmesh-inpatient-preparation"><h4 className="font-medium">{t('出院办理记录', 'Discharge history')}</h4>
    <ul className="clinmesh-inpatient-preparation-list">{events.data.events.map(event => <li key={event.id} className="text-sm"><time className="tabular-nums text-muted-foreground" dateTime={event.virtualTime}>{formatShanghaiMinute(event.virtualTime)}</time>
      <div><strong>{kinds[event.kind]}{event.departureMethod ? ` · ${methods[event.departureMethod]}` : ''}</strong></div><span>{event.reason}</span></li>)}</ul></section> : null
  if (doctor) return <section aria-label={t('出院处理','Discharge processing')} className="flex flex-col gap-3">
    {admission.status === 'admitted' ? <>
      <DischargeChecklist label={t('开出院医嘱前', 'Before ordering discharge')} items={beforeIssue} onOpenStage={onOpenStage}
        badge={issueBlocked ? t(`${outstanding} 项未收口`, `${outstanding} outstanding`) : undefined}>
        {pendingOrders > 0 ? <p className="text-sm text-muted-foreground">{t('在用医嘱不影响开出院医嘱；病区护士办理离院前，所有医嘱都要停止或完成。', 'Active orders do not block the discharge order, but all orders must be stopped or completed before the ward nurse records departure.')}</p> : null}
        {issueBlocked ? <p className="text-sm text-muted-foreground">{t('先处理以上申请，再开出院医嘱；开出院医嘱不会自动取消手术。', 'Resolve these requests before ordering discharge. A discharge order does not automatically cancel surgery.')}</p> : null}
      </DischargeChecklist>
      <FieldSet disabled={write.blocked}><FieldGroup>{noteField}
        <InpatientPrimaryAction stage="discharge"><WorkspaceActionBar reason={issueBlocked ? t('请先完成或取消未收口的手术、检查检验或转科申请。', 'Complete or cancel outstanding surgery, investigation or transfer requests first.') : noteMissing ?? t('开立后由病区护士办理出院', 'The ward nurse records departure next')} tone={blocked || issueBlocked ? 'blocked' : 'normal'} action={<Button disabled={blocked || issueBlocked} onClick={() => action('inpatient.discharge.issue')}>{t('开出院医嘱','Issue discharge order')}</Button>} /></InpatientPrimaryAction>
      </FieldGroup></FieldSet>
    </> : null}
    {admission.status === 'discharge-pending' ? <>
      <DischargeChecklist label={t('病区护士办理出院还差', 'Before the ward nurse records departure')} items={beforeDeparture} onOpenStage={onOpenStage} />
      <p className="text-xs text-muted-foreground">{t('出院医嘱开立后不能撤回；护士办理离院后、结算前可以召回住院。', 'A discharge order cannot be withdrawn once issued; after the nurse records departure and before settlement, the patient can be recalled.')}</p>
      <InpatientPrimaryAction stage="discharge">{doctorStops > 0 && onOpenStage
        ? <WorkspaceActionBar tone="blocked" reason={t(`护士办理出院还差：停 ${doctorStops} 条医嘱（你）`, `Departure needs ${doctorStops} order stops from you`)} action={<Button onClick={() => onOpenStage('orders')}>{t('去诊断医嘱停嘱', 'Request stops in orders')}</Button>} />
        : <WorkspaceActionBar reason={t('等病区护士办理出院', 'Waiting for the ward nurse to record departure')} />}</InpatientPrimaryAction>
    </> : null}
    {admission.status === 'departed' || admission.status === 'cleared' ? <>
      <dl className="grid gap-3 text-sm sm:grid-cols-4">
        <div><dt className="text-muted-foreground">{t('出院医嘱', 'Discharge order')}</dt><dd className="tabular-nums">{latest('issue') ? formatShanghaiMinute(latest('issue')!.virtualTime) : '—'}</dd></div>
        <div><dt className="text-muted-foreground">{t('实际离院', 'Departed')}</dt><dd className="tabular-nums">{latest('depart') ? formatShanghaiMinute(latest('depart')!.virtualTime) : '—'}</dd></div>
        <div><dt className="text-muted-foreground">{t('离院方式', 'Departure method')}</dt><dd>{latest('depart')?.departureMethod ? methods[latest('depart')!.departureMethod!] : '—'}</dd></div>
        <div><dt className="text-muted-foreground">{t('结算', 'Settlement')}</dt><dd>{admission.financialStatus === 'settled' ? t('已结算', 'Settled') : t('等收费员', 'Awaiting cashier')}</dd></div>
      </dl>
      <section aria-label={t('召回住院', 'Recall admission')} className="clinmesh-inpatient-preparation">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium">{t('召回住院', 'Recall admission')}</h4>
          {canRecall && !recallOpen ? <Button variant="outline" size="sm" disabled={write.blocked} onClick={() => setRecallOpen(true)}>{t('召回住院','Recall admission')}</Button> : null}</div>
        <p className="text-sm text-muted-foreground">{admission.financialStatus === 'settled' ? t('收费员已结算，召回窗口已关闭。', 'Settlement is complete, so recall is closed.')
          : canRecall ? t('患者离院后、收费员结算前，原床还保留，可以召回继续住院。结算后不能召回。', 'Before settlement, while the original bed is held, the patient can be recalled. Recall closes at settlement.')
            : t('原床未保留，不能召回。', 'The original bed is no longer held, so recall is unavailable.')}</p>
        {canRecall && recallOpen ? <FieldSet disabled={write.blocked}><Field><div className="flex items-baseline gap-1"><FieldLabel htmlFor="inpatient-recall-reason">{t('召回理由','Recall reason')}</FieldLabel><span aria-hidden="true" className="text-xs text-muted-foreground">{t('必填', 'Required')}</span></div>
          <Textarea id="inpatient-recall-reason" aria-required="true" value={recallReason} placeholder={t('例如：离院后胸痛复发，返回病区观察', 'For example: chest pain recurred after departure')} onChange={event => setRecallReason(event.currentTarget.value)} />
          <FieldDescription>{t('召回后患者回到原床「在院」状态，出院医嘱需要重新开立。', 'The patient returns to the original bed as admitted; discharge must be ordered again.')}</FieldDescription></Field>
          <InpatientPrimaryAction stage="discharge"><WorkspaceActionBar tone={recallReason.trim() ? 'normal' : 'blocked'} reason={recallReason.trim() ? t('召回后患者回到原床，出院医嘱需要重新开立', 'The patient returns to the original bed') : t('还差：召回理由', 'Enter a recall reason')}
            action={<><Button variant="outline" onClick={() => setRecallOpen(false)}>{t('取消', 'Cancel')}</Button><Button variant="destructive" disabled={write.blocked || !recallReason.trim()} onClick={() => write.mutation.mutate({ operation: 'inpatient.discharge.recall', input: { admissionId: admission.id, encounterVersion: admission.versionId, reason: recallReason } })}>{t('确认召回住院', 'Confirm recall')}</Button></>} /></InpatientPrimaryAction>
        </FieldSet> : null}
      </section>
    </> : null}
    {admission.status === 'registered' ? <p className="text-sm text-muted-foreground">{t('患者尚未入科，接诊分床后可开出院医嘱。', 'Receive the patient and assign a bed before ordering discharge.')}</p> : null}
    {events.error ? <p role="alert">{getWorkspaceErrorMessage(events.error,getWorkspaceMessages(locale))}</p> : null}
    {doctorHistory}
  </section>
  return <section aria-label={t('出院处理','Discharge processing')} className="flex flex-col gap-3">
    <h3>{t('出院处理','Discharge processing')}</h3>
    {nurseClosing && (needsDischargeOrder || departureBlocked) ? <section aria-label={t('办理出院还差', 'Before departure')} className="rounded-md border p-3 text-sm"><h4 className="font-medium">{t('办理出院还差', 'Before departure')}</h4><ul className="mt-2 flex flex-col gap-2">
      {needsDischargeOrder ? <li>{t('住院医生：先开出院医嘱', 'Inpatient doctor: order discharge first')}</li> : null}
      {pendingOrders > 0 ? <li>{t(`住院医生申请停嘱，病区护士核对：${pendingOrders} 条医嘱`, `Inpatient doctor requests stops, ward nurse verifies: ${pendingOrders} orders`)}</li> : null}
      {pendingAdministrations > 0 ? <li>{t(`病区护士完成或取消给药：${pendingAdministrations} 次`, `Ward nurse completes or cancels: ${pendingAdministrations} administrations`)}</li> : null}
      {pendingServices > 0 ? <li>{t(`病区护士完成或取消执行：${pendingServices} 次`, `Ward nurse completes or cancels: ${pendingServices} services`)}</li> : null}
      {activity?.clinical === undefined ? <li>{t('病区护士：先读取医嘱资料', 'Ward nurse: load clinical orders first')}</li> : null}
    </ul></section> : null}
    {nurse && admission.status === 'departed' ? <p className="text-sm text-muted-foreground">{t('结算前且原床保留时，可由住院医生召回；结算后召回窗口关闭，清床后停止床位占用。', 'The inpatient doctor can recall an unsettled departure while the original bed is held. Settlement closes recall; bed clearance ends occupancy.')}</p> : null}
    {nurse ? <FieldSet disabled={write.blocked}><FieldGroup>
      <Field><FieldLabel htmlFor="inpatient-discharge-reason">{t('出院处理说明','Discharge note')}</FieldLabel><Input id="inpatient-discharge-reason" value={reason} onChange={event => setReason(event.currentTarget.value)} /></Field>
      {admission.status === 'discharge-pending' ? <Field><FieldLabel htmlFor="inpatient-departure-method">{t('离院方式','Departure method')}</FieldLabel>
        <WorkspaceSelect id="inpatient-departure-method" value={method} items={Object.entries(methods).map(([value,label]) => ({ value,label }))}
          onValueChange={value => { if (value && value in methods) setMethod(value as z.infer<typeof inpatientDepartureMethodSchema>) }} /></Field> : null}
      <div className="flex flex-wrap gap-2">
        {needsDischargeOrder ? <InpatientPrimaryAction stage="discharge"><WorkspaceActionBar reason={missing} tone="blocked" action={<Button disabled>{t('办理出院', 'Record departure')}</Button>} /></InpatientPrimaryAction> : null}
        {admission.status === 'discharge-pending' ? <InpatientPrimaryAction stage="discharge"><WorkspaceActionBar reason={missing} tone={blocked || departureBlocked || method === null ? 'blocked' : 'normal'} action={<Button disabled={blocked || method === null || departureBlocked} onClick={() => { if (method) write.mutation.mutate({ operation: 'inpatient.discharge.depart',
          input: { admissionId: admission.id, encounterVersion: admission.versionId, reason, departureMethod: method } }) }}>{t('办理出院','Record departure')}</Button>} /></InpatientPrimaryAction> : null}
        {admission.status === 'departed' ? <InpatientPrimaryAction stage="discharge"><WorkspaceActionBar reason={missing} tone={blocked || admission.financialStatus !== 'settled' ? 'blocked' : 'normal'} action={<Button disabled={blocked || admission.financialStatus !== 'settled'} onClick={() => action('inpatient.discharge.clear')}>{t('清床','Clear bed')}</Button>} /></InpatientPrimaryAction> : null}
      </div>
    </FieldGroup></FieldSet> : null}
    {events.error ? <p role="alert">{getWorkspaceErrorMessage(events.error,getWorkspaceMessages(locale))}</p> : null}
    {history}
  </section>
}

export function InpatientSettlement({ admission, session, locale, write }: Props): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const client = useQueryClient()
  const { workspaceId, epoch, practitionerRoleId } = session.actor
  const insuranceChanged = useCallback(() => client.invalidateQueries({
    queryKey: ['inpatient', workspaceId, epoch, practitionerRoleId],
  }), [client, workspaceId, epoch, practitionerRoleId])
  const funds = useQuery({ queryKey: ['inpatient',session.actor.workspaceId,session.actor.epoch,session.actor.practitionerRoleId,admission.id,'payments'],
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/payments`, inpatientPaymentsSchema, signal) })
  // 收费员显式获取预览；后台失效或账目刷新不能替换已经看过的金额与指纹。
  const preview = useQuery({ queryKey: ['inpatient',session.actor.workspaceId,session.actor.epoch,session.actor.practitionerRoleId,admission.id,'settlement-preview'], enabled: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/discharge/preview`, inpatientSettlementPreviewSchema, signal) })
  const data = preview.data
  const [dismissedAt, setDismissedAt] = useState(0)
  const reviewing = data !== undefined && preview.dataUpdatedAt > dismissedAt
  const confirmation = useWorkspaceConfirmation({ open: reviewing && admission.financialStatus !== 'settled', pending: write.mutation.isPending || preview.isFetching,
    disabled: write.blocked || preview.isFetching || admission.status !== 'departed' || data?.status !== 'departed' || funds.isPending || !!funds.error || (funds.data?.pendingCount ?? 0) > 0,
    scope: JSON.stringify([session.user.id, session.actor, admission.id]), onCancel: () => setDismissedAt(preview.dataUpdatedAt) })
  const latest = write.mutation.data
  const collecting = latest?.command.operation === 'inpatient.payment.preview' && latest.command.input.admissionId === admission.id
  const remaining = funds.data?.remainingFen
  // 出院补交到清床的六步：已结算后只剩等护士清床，清床后全部完成。
  const current = admission.status === 'cleared' ? 6 : admission.financialStatus === 'settled' ? 5 : admission.status !== 'departed' ? -1
    : reviewing ? 4 : remaining !== undefined && remaining <= 0 ? 3 : collecting ? 2 : 0
  const collectionOccurred = funds.data?.payments.some(payment => payment.kind === 'supplement' && payment.outcome === 'success') === true
  const collectionPreviewed = collecting || funds.data?.payments.some(payment => payment.kind === 'supplement') === true
  const skipCollection = remaining !== undefined && remaining <= 0 && funds.data?.pendingCount === 0 && !collectionOccurred
  const steps = <>{skipCollection ? <p className="text-sm text-muted-foreground">{t('无需补交，直接预览结算。', 'No supplement is needed. Continue with settlement preview.')}</p> : null}<WorkspaceFlow numbered compactBelow={600} locale={locale} label={t('出院结算进度', 'Discharge settlement progress')} flow={[
    t('出院补交', 'Departure supplement'), t('预览收款', 'Preview collection'), t('确认收款', 'Confirm collection'),
    t('预览结算', 'Preview settlement'), t('确认结算', 'Confirm settlement'), t('等护士清床', 'Awaiting bed clearance'),
  ].flatMap((label, index) => {
    if (skipCollection && index < 3) return []
    const status = index < 3
      ? index === current ? 'current' : collectionOccurred || index === 1 && collectionPreviewed ? 'completed' : 'pending'
      : index < current ? 'completed' : index === current ? 'current' : 'pending'
    return [{ value: String(index), label, status }]
  })} /></>
  const previewAction = <Button ref={confirmation.triggerRef} variant="outline" disabled={preview.isFetching || admission.status !== 'departed'} onClick={() => { confirmation.captureTrigger(); void preview.refetch() }}>{data ? t('重新预览结算', 'Refresh settlement preview') : t('预览结算', 'Preview settlement')}</Button>
  if (admission.financialStatus === 'settled') return <>{steps}<p>{admission.status === 'cleared' ? t('已结算并清床','Settled and bed cleared') : t('已结算，等待病区清床','Settled; awaiting bed clearance')}</p><InpatientFinancialAdjustments key={admission.id} admission={admission} session={session} locale={locale} write={write} /></>
  return <section aria-label={t('住院结算','Inpatient settlement')} className="flex flex-col gap-3">
    {steps}
    <h3>{t('住院结算','Inpatient settlement')}</h3>
    <InsurancePanel key={JSON.stringify({ accountId: session.user.id, actor: session.actor, admissionId: admission.id })}
      target={{ kind: 'inpatient', id: admission.id }} session={session} locale={locale}
      disabled={write.blocked || admission.status !== 'departed' || (funds.data?.pendingCount ?? 0) > 0} onChanged={insuranceChanged} />
    {funds.error ? <p role="alert">{getWorkspaceErrorMessage(funds.error,getWorkspaceMessages(locale))}</p> : null}
    {funds.data ? <InpatientFunding admission={admission} locale={locale} write={write} statement={funds.data} allowExtraCollection collect={admission.status !== 'departed' || funds.data.remainingFen > 0} /> : null}
    {reviewing ? <Button variant="outline" disabled={preview.isFetching} onClick={() => { void preview.refetch() }}>{t('重新预览结算','Refresh settlement preview')}</Button> : null}
    {preview.error ? <p role="alert">{getWorkspaceErrorMessage(preview.error,getWorkspaceMessages(locale))}</p> : null}
    {data ? <>
      <p>{t('本次结算金额已固定；账目变化后请重新预览。','This preview is fixed. Refresh it explicitly after ledger changes.')}</p>
      <p data-testid="settlement-net">{t('预览费用合计：','Preview net charges: ')}{formatFen(data.chargesFen,locale)}</p>
      <dl className="grid gap-3 sm:grid-cols-3">
        <div><dt>{t('医保统筹支付', 'Fund pays')}</dt><dd>{formatFen(data.insurance?.fundFen ?? 0, locale)}</dd></div>
        <div><dt>{t('个人账户支付', 'Personal account pays')}</dt><dd>{formatFen(data.insurance?.accountFen ?? 0, locale)}</dd></div>
        <div><dt>{t('个人自付', 'Patient cash due')}</dt><dd>{formatFen(data.insurance?.patientFen ?? data.chargesFen, locale)}</dd></div>
      </dl>
      <p>{t('原预交金：','Original deposit: ')}{formatFen(data.depositFen,locale)}</p>
      <p data-testid="settlement-refund">{data.balanceFen < 0 ? t('应退：','Refund: ') : data.balanceFen > 0 ? t('应补缴：','Supplement: ') : t('无需补退：','No balance: ')}{formatFen(Math.abs(data.balanceFen),locale)}</p>
    </> : null}
    <InpatientPrimaryAction stage="discharge" fallback={!reviewing ? previewAction : undefined}><WorkspaceActionBar onKeyDown={confirmation.onKeyDown}
      summary={(funds.data?.remainingFen ?? 0) < 0 ? `${t('应退 ', 'Refund due ')}${formatFen(-funds.data!.remainingFen, locale)}` : funds.data?.remainingFen === 0 ? t('无需补退', 'No remaining balance') : `${t('当前需补交 ', 'Current amount due ')}${formatFen(Math.max(0, funds.data?.remainingFen ?? 0), locale)}`}
      tone={reviewing ? 'confirm' : admission.status !== 'departed' || (funds.data?.pendingCount ?? 0) > 0 ? 'blocked' : 'normal'}
      reason={admission.status !== 'departed' ? t('等病区护士办理出院。', 'Waiting for the ward nurse to record discharge.')
        : (funds.data?.pendingCount ?? 0) > 0 ? t('等收费员查明原支付结果。', 'Waiting for the cashier to resolve the original payment.')
          : reviewing ? t('确认后本次结算入账，随后由病区护士清床；账目变化须重新预览。', 'Confirmation records this settlement, then the ward nurse clears the bed. Ledger changes require a fresh preview.') : (funds.data?.remainingFen ?? 0) < 0 ? t('先核对结算和应退金额，再按原款办理退款。', 'Review settlement and the refundable amount, then refund the original collection.') : t('先预览结算，再核对并确认。', 'Preview settlement, then review and confirm.')}
      action={reviewing && data ? <><Button variant="outline" disabled={write.mutation.isPending || preview.isFetching} onClick={() => setDismissedAt(preview.dataUpdatedAt)}>{t('返回', 'Back')}</Button>
        <Button ref={confirmation.confirmRef} disabled={write.blocked || preview.isFetching || admission.status !== 'departed' || data.status !== 'departed' || funds.isPending || !!funds.error || (funds.data?.pendingCount ?? 0) > 0}
          onClick={() => write.mutation.mutate({ operation: 'inpatient.discharge.settle', input: { admissionId: admission.id, encounterVersion: data.encounterVersion,
            fingerprint: data.fingerprint, expectedChargesFen: data.chargesFen, expectedBalanceFen: data.balanceFen } })}>{t('确认结算', 'Confirm settlement')}</Button></>
        : previewAction} />
    </InpatientPrimaryAction>
  </section>
}
