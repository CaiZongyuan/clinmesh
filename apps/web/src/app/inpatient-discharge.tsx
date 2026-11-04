import { inpatientDischargeEventsSchema, inpatientSettlementPreviewSchema, inpatientPaymentsSchema, type inpatientDepartureMethodSchema } from '@clinmesh/contracts/inpatient-discharge'
import { InpatientFinancialAdjustments } from './inpatient-financial-adjustments.tsx'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { z } from 'zod'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { apiGet } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { formatFen } from './workspace-format.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InsurancePanel } from './insurance-panel.tsx'
import { InpatientFunding } from './inpatient-funding.tsx'
import { WorkspaceActionBar, WorkspaceFlow, useWorkspaceConfirmation } from './workspace-card-layout.tsx'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import type { InpatientActivity } from './inpatient-stage-activity.ts'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>; activity?: InpatientActivity; onOpenStage?: (stage: 'surgery' | 'investigations' | 'transfer') => void }
export function InpatientDischarge({ admission, session, locale, write, activity, onOpenStage }: Props): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const doctor = session.actor.roleCode === 'inpatient-doctor', nurse = session.actor.roleCode === 'ward-nurse'
  const [reason, setReason] = useState(''), [method, setMethod] = useState<z.infer<typeof inpatientDepartureMethodSchema> | null>(null)
  const methods = { home: t('医嘱离院','Discharged home'), transfer: t('医嘱转院','Transferred'), 'against-advice': t('非医嘱离院','Against medical advice'), death: t('死亡','Death'), other: t('其他','Other') }
  const events = useQuery({ queryKey: ['inpatient',session.actor.workspaceId,session.actor.epoch,session.actor.practitionerRoleId,admission.id,'discharge-events'],
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/discharge`, inpatientDischargeEventsSchema, signal) })
  const blocked = write.blocked || !reason.trim()
  const pendingSurgeries = activity?.surgery?.requests.filter(request => request.status === 'requested' || request.status === 'ready').length ?? 0
  const pendingInvestigations = [...activity?.investigations?.laboratoryRequests ?? [], ...activity?.investigations?.imagingRequests ?? []]
    .filter(request => ['issued', 'accepted', 'in-progress', 'generation-failed'].includes(request.status)).length
  const pendingTransfers = activity?.transfers?.transfers.filter(transfer => transfer.status === 'requested' || transfer.status === 'handed-over').length ?? 0
  const issueBlocked = doctor && admission.status === 'admitted' && pendingSurgeries + pendingInvestigations + pendingTransfers > 0
  const pendingOrders = activity?.clinical?.orders.filter(order => !['stopped', 'completed'].includes(order.state)).length ?? 0
  const pendingAdministrations = activity?.clinical?.executions.filter(execution => !['completed', 'cancelled'].includes(execution.status)
    && activity.clinical?.orders.find(order => order.id === execution.orderId)?.kind === 'medication').length ?? 0
  const pendingServices = activity?.clinical?.executions.filter(execution => !['completed', 'cancelled'].includes(execution.status)
    && activity.clinical?.orders.find(order => order.id === execution.orderId)?.kind === 'service').length ?? 0
  const departureBlocked = nurse && admission.status === 'discharge-pending'
    && (activity !== undefined && activity.clinical === undefined || pendingOrders + pendingAdministrations + pendingServices > 0)
  const needsDischargeOrder = nurse && admission.status === 'admitted'
  const nurseClosing = nurse && (needsDischargeOrder || admission.status === 'discharge-pending')
  const noteMissing = !reason.trim() ? t('还差：填写出院处理说明。', 'Enter a discharge note.') : undefined
  const missing = needsDischargeOrder ? t('等住院医生开出院医嘱，再由病区护士办理实际离院。', 'The inpatient doctor orders discharge before the ward nurse records departure.')
    : nurse && admission.status === 'discharge-pending' && activity !== undefined && activity.clinical === undefined
    ? t('医嘱资料未就绪，请先完成读取与核对。', 'Load and review clinical orders before discharge.')
    : nurseClosing && pendingOrders + pendingAdministrations + pendingServices > 0
    ? t(`还差 ${pendingOrders} 条医嘱、${pendingAdministrations} 次给药${pendingServices ? `、${pendingServices} 次执行` : ''}；请住院医生停嘱，再由病区护士核对并完成或取消执行。`, `${pendingOrders} orders and ${pendingAdministrations} administrations remain; the inpatient doctor requests stops, then the ward nurse verifies and completes or cancels execution.`)
    : noteMissing ? noteMissing
      : nurse && admission.status === 'discharge-pending' && method === null ? t('还差：选择离院方式。', 'Select the departure method.')
        : nurse && admission.status === 'departed' && admission.financialStatus !== 'settled' ? t('等收费员结算后再清床。', 'Wait for cashier settlement before clearing the bed.') : undefined
  const action = (operation: 'inpatient.discharge.issue' | 'inpatient.discharge.recall' | 'inpatient.discharge.clear') => write.mutation.mutate({ operation,
    input: { admissionId: admission.id, encounterVersion: admission.versionId, reason } })
  const canRecall = doctor && admission.status === 'departed' && admission.financialStatus === 'open' && !!admission.bedId
  const doctorStatus = admission.status === 'registered' ? t('患者尚未入科，接诊分床后可开出院医嘱。', 'Receive the patient and assign a bed before ordering discharge.')
    : admission.status === 'admitted' ? t('患者在院中。开出院医嘱后，由病区护士核对医嘱并办理实际离院。', 'The patient is admitted. After you order discharge, the ward nurse verifies orders and records departure.')
      : admission.status === 'discharge-pending' ? t('出院医嘱已开立，等待病区护士核对医嘱并办理实际离院。', 'Discharge has been ordered. The ward nurse verifies orders and records departure.')
        : admission.status === 'cleared' ? t('患者已离院，结算与清床已完成。', 'The patient has departed; settlement and bed clearance are complete.')
          : canRecall ? t('患者已离院，等待收费员结算。结算前且原床保留时，可召回住院。', 'The patient has departed and awaits settlement. Recall is available before settlement while the original bed is held.')
            : admission.financialStatus === 'settled' ? t('患者已结算，等待病区护士清床；召回窗口已关闭。', 'Settlement is complete; the ward nurse clears the bed. Recall is no longer available.')
              : t('患者已离院，等待收费员结算。', 'The patient has departed and awaits cashier settlement.')
  const history = events.data?.events.map(event => <p key={event.id}>{new Date(event.virtualTime).toLocaleString(zh ? 'zh-CN' : 'en-US',{ timeZone: 'Asia/Shanghai' })} · {({ issue:t('出院医嘱','Discharge order'),depart:t('实际离院','Departure'),recall:t('召回','Recall'),clear:t('清床','Bed cleared') })[event.kind]}{event.departureMethod ? ` · ${methods[event.departureMethod]}` : ''} · {event.reason}</p>)
  return <section aria-label={t('出院处理','Discharge processing')} className="flex flex-col gap-3">
    {doctor ? <section role="region" aria-label={t('出院办理状态', 'Discharge status')} className="clinmesh-inpatient-summary">
      <h3 className="clinmesh-inpatient-section-heading">{t('出院办理状态', 'Discharge status')}</h3>
      <p className="text-sm text-muted-foreground">{doctorStatus}</p>
    </section> : <h3>{t('出院处理','Discharge processing')}</h3>}
    {issueBlocked ? <section aria-label={t('开出院医嘱还差', 'Before ordering discharge')} className="flex flex-col gap-2 text-sm"><h4 className="font-medium">{t('开出院医嘱还差', 'Before ordering discharge')}</h4>
      {pendingSurgeries > 0 ? <p>{t(`住院医生：${pendingSurgeries} 项手术申请尚未实施或取消。`, `Inpatient doctor: ${pendingSurgeries} surgery requests remain unperformed or uncancelled.`)}{onOpenStage ? <Button variant="link" size="sm" onClick={() => onOpenStage('surgery')}>{t('前往手术处理', 'Open surgery')}</Button> : null}</p> : null}
      {pendingInvestigations > 0 ? <p>{t(`住院医生与医技科室：${pendingInvestigations} 项检查检验尚未完成或取消。`, `Inpatient doctor and investigation staff: ${pendingInvestigations} requests remain incomplete or uncancelled.`)}{onOpenStage ? <Button variant="link" size="sm" onClick={() => onOpenStage('investigations')}>{t('前往检查检验', 'Open investigations')}</Button> : null}</p> : null}
      {pendingTransfers > 0 ? <p>{t(`转科相关岗位：${pendingTransfers} 项转科任务尚未接收或取消。`, `Transfer staff: ${pendingTransfers} transfers remain unreceived or uncancelled.`)}{onOpenStage ? <Button variant="link" size="sm" onClick={() => onOpenStage('transfer')}>{t('前往转科交接', 'Open transfer')}</Button> : null}</p> : null}
      <p className="text-muted-foreground">{t('先处理以上申请，再开出院医嘱；开出院医嘱不会自动取消手术。', 'Resolve these requests before ordering discharge. A discharge order does not automatically cancel surgery.')}</p>
    </section> : null}
    {nurseClosing && (needsDischargeOrder || departureBlocked) ? <section aria-label={t('办理出院还差', 'Before departure')} className="rounded-md border p-3 text-sm"><h4 className="font-medium">{t('办理出院还差', 'Before departure')}</h4><ul className="mt-2 flex flex-col gap-2">
      {needsDischargeOrder ? <li>{t('住院医生：先开出院医嘱', 'Inpatient doctor: order discharge first')}</li> : null}
      {pendingOrders > 0 ? <li>{t(`住院医生申请停嘱，病区护士核对：${pendingOrders} 条医嘱`, `Inpatient doctor requests stops, ward nurse verifies: ${pendingOrders} orders`)}</li> : null}
      {pendingAdministrations > 0 ? <li>{t(`病区护士完成或取消给药：${pendingAdministrations} 次`, `Ward nurse completes or cancels: ${pendingAdministrations} administrations`)}</li> : null}
      {pendingServices > 0 ? <li>{t(`病区护士完成或取消执行：${pendingServices} 次`, `Ward nurse completes or cancels: ${pendingServices} services`)}</li> : null}
      {activity?.clinical === undefined ? <li>{t('病区护士：先读取医嘱资料', 'Ward nurse: load clinical orders first')}</li> : null}
    </ul></section> : null}
    {nurse && admission.status === 'departed' ? <p className="text-sm text-muted-foreground">{t('结算前且原床保留时，可由住院医生召回；结算后召回窗口关闭，清床后停止床位占用。', 'The inpatient doctor can recall an unsettled departure while the original bed is held. Settlement closes recall; bed clearance ends occupancy.')}</p> : null}
    {doctor && (admission.status === 'admitted' || canRecall) || nurse ? <FieldSet disabled={write.blocked}><FieldGroup>
      <Field><FieldLabel htmlFor="inpatient-discharge-reason">{t('出院处理说明','Discharge note')}</FieldLabel><Input id="inpatient-discharge-reason" value={reason} onChange={event => setReason(event.currentTarget.value)} /></Field>
      {nurse && admission.status === 'discharge-pending' ? <Field><FieldLabel htmlFor="inpatient-departure-method">{t('离院方式','Departure method')}</FieldLabel>
        <WorkspaceSelect id="inpatient-departure-method" value={method} items={Object.entries(methods).map(([value,label]) => ({ value,label }))}
          onValueChange={value => { if (value && value in methods) setMethod(value as z.infer<typeof inpatientDepartureMethodSchema>) }} /></Field> : null}
      <div className="flex flex-wrap gap-2">
        {doctor && admission.status === 'admitted' ? <InpatientPrimaryAction stage="discharge"><WorkspaceActionBar reason={issueBlocked ? t('请先完成或取消未收口的手术、检查检验或转科申请。', 'Complete or cancel outstanding surgery, investigation or transfer requests first.') : noteMissing} tone={blocked || issueBlocked ? 'blocked' : 'normal'} action={<Button disabled={blocked || issueBlocked} onClick={() => action('inpatient.discharge.issue')}>{t('开出院医嘱','Issue discharge order')}</Button>} /></InpatientPrimaryAction> : null}
        {needsDischargeOrder ? <InpatientPrimaryAction stage="discharge"><WorkspaceActionBar reason={missing} tone="blocked" action={<Button disabled>{t('办理出院', 'Record departure')}</Button>} /></InpatientPrimaryAction> : null}
        {nurse && admission.status === 'discharge-pending' ? <InpatientPrimaryAction stage="discharge"><WorkspaceActionBar reason={missing} tone={blocked || departureBlocked || method === null ? 'blocked' : 'normal'} action={<Button disabled={blocked || method === null || departureBlocked} onClick={() => { if (method) write.mutation.mutate({ operation: 'inpatient.discharge.depart',
          input: { admissionId: admission.id, encounterVersion: admission.versionId, reason, departureMethod: method } }) }}>{t('办理出院','Record departure')}</Button>} /></InpatientPrimaryAction> : null}
        {canRecall ? <Button variant="outline" disabled={blocked} onClick={() => action('inpatient.discharge.recall')}>{t('召回住院','Recall admission')}</Button> : null}
        {nurse && admission.status === 'departed' ? <InpatientPrimaryAction stage="discharge"><WorkspaceActionBar reason={missing} tone={blocked || admission.financialStatus !== 'settled' ? 'blocked' : 'normal'} action={<Button disabled={blocked || admission.financialStatus !== 'settled'} onClick={() => action('inpatient.discharge.clear')}>{t('清床','Clear bed')}</Button>} /></InpatientPrimaryAction> : null}
      </div>
    </FieldGroup></FieldSet> : null}
    {events.error ? <p role="alert">{getWorkspaceErrorMessage(events.error,getWorkspaceMessages(locale))}</p> : null}
    {doctor && history?.length ? <details className="clinmesh-inpatient-disclosure"><summary>{t('出院办理记录', 'Discharge history')}</summary><div className="flex flex-col gap-2 pt-3 text-sm">{history}</div></details> : history}
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
