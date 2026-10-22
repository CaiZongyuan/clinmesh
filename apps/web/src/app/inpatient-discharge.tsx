import { inpatientDischargeEventsSchema, inpatientSettlementPreviewSchema, type inpatientDepartureMethodSchema } from '@clinmesh/contracts/inpatient-discharge'
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

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent> }
export function InpatientDischarge({ admission, session, locale, write }: Props): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const doctor = session.actor.roleCode === 'inpatient-doctor', nurse = session.actor.roleCode === 'ward-nurse'
  const [reason, setReason] = useState(''), [method, setMethod] = useState<z.infer<typeof inpatientDepartureMethodSchema> | null>(null)
  const methods = { home: t('医嘱离院','Discharged home'), transfer: t('医嘱转院','Transferred'), 'against-advice': t('非医嘱离院','Against medical advice'), death: t('死亡','Death'), other: t('其他','Other') }
  const events = useQuery({ queryKey: ['inpatient',session.actor.workspaceId,session.actor.epoch,session.actor.practitionerRoleId,admission.id,'discharge-events'],
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/discharge`, inpatientDischargeEventsSchema, signal) })
  const blocked = write.blocked || !reason.trim()
  const action = (operation: 'inpatient.discharge.issue' | 'inpatient.discharge.recall' | 'inpatient.discharge.clear') => write.mutation.mutate({ operation,
    input: { admissionId: admission.id, encounterVersion: admission.versionId, reason } })
  return <section aria-label={t('出院处理','Discharge processing')} className="flex flex-col gap-3">
    <h3>{t('出院处理','Discharge processing')}</h3>
    {doctor || nurse ? <FieldSet disabled={write.blocked}><FieldGroup>
      <Field><FieldLabel htmlFor="inpatient-discharge-reason">{t('出院处理说明','Discharge note')}</FieldLabel><Input id="inpatient-discharge-reason" value={reason} onChange={event => setReason(event.currentTarget.value)} /></Field>
      {nurse && admission.status === 'discharge-pending' ? <Field><FieldLabel htmlFor="inpatient-departure-method">{t('离院方式','Departure method')}</FieldLabel>
        <WorkspaceSelect id="inpatient-departure-method" value={method} items={Object.entries(methods).map(([value,label]) => ({ value,label }))}
          onValueChange={value => { if (value && value in methods) setMethod(value as z.infer<typeof inpatientDepartureMethodSchema>) }} /></Field> : null}
      <div className="flex flex-wrap gap-2">
        {doctor && admission.status === 'admitted' ? <Button disabled={blocked} onClick={() => action('inpatient.discharge.issue')}>{t('开出院医嘱','Issue discharge order')}</Button> : null}
        {nurse && admission.status === 'discharge-pending' ? <Button disabled={blocked || method === null} onClick={() => { if (method) write.mutation.mutate({ operation: 'inpatient.discharge.depart',
          input: { admissionId: admission.id, encounterVersion: admission.versionId, reason, departureMethod: method } }) }}>{t('办理出区','Record departure')}</Button> : null}
        {doctor && admission.status === 'departed' && admission.financialStatus === 'open' && admission.bedId ? <Button variant="outline" disabled={blocked} onClick={() => action('inpatient.discharge.recall')}>{t('召回住院','Recall admission')}</Button> : null}
        {nurse && admission.status === 'departed' ? <Button disabled={blocked || admission.financialStatus !== 'settled'} onClick={() => action('inpatient.discharge.clear')}>{t('清床','Clear bed')}</Button> : null}
      </div>
    </FieldGroup></FieldSet> : null}
    {events.error ? <p role="alert">{getWorkspaceErrorMessage(events.error,getWorkspaceMessages(locale))}</p> : null}
    {events.data?.events.map(event => <p key={event.id}>{new Date(event.virtualTime).toLocaleString(zh ? 'zh-CN' : 'en-US',{ timeZone: 'Asia/Shanghai' })} · {({ issue:t('出院医嘱','Discharge order'),depart:t('实际出区','Departure'),recall:t('召回','Recall'),clear:t('清床','Bed cleared') })[event.kind]}{event.departureMethod ? ` · ${methods[event.departureMethod]}` : ''} · {event.reason}</p>)}
  </section>
}

export function InpatientSettlement({ admission, session, locale, write }: Props): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const client = useQueryClient()
  const { workspaceId, epoch, practitionerRoleId } = session.actor
  const insuranceChanged = useCallback(() => client.invalidateQueries({
    queryKey: ['inpatient', workspaceId, epoch, practitionerRoleId],
  }), [client, workspaceId, epoch, practitionerRoleId])
  // 收费员显式获取预览；后台失效或账目刷新不能替换已经看过的金额与指纹。
  const preview = useQuery({ queryKey: ['inpatient',session.actor.workspaceId,session.actor.epoch,session.actor.practitionerRoleId,admission.id,'settlement-preview'], enabled: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/discharge/preview`, inpatientSettlementPreviewSchema, signal) })
  const data = preview.data
  if (admission.financialStatus === 'settled') return <><p>{admission.status === 'cleared' ? t('已结算并清床','Settled and bed cleared') : t('已结算，等待病区清床','Settled; awaiting bed clearance')}</p><InpatientFinancialAdjustments key={admission.id} admission={admission} session={session} locale={locale} write={write} /></>
  return <section aria-label={t('住院结算','Inpatient settlement')} className="flex flex-col gap-3">
    <h3>{t('住院结算','Inpatient settlement')}</h3>
    <InsurancePanel key={JSON.stringify({ accountId: session.user.id, actor: session.actor, admissionId: admission.id })}
      target={{ kind: 'inpatient', id: admission.id }} session={session} locale={locale}
      disabled={write.blocked || admission.status !== 'departed'} onChanged={insuranceChanged} />
    <Button variant="outline" disabled={write.blocked || preview.isFetching} onClick={() => { void preview.refetch() }}>{data ? t('重新预览结算','Refresh settlement preview') : t('预览结算','Preview settlement')}</Button>
    {preview.error ? <p role="alert">{getWorkspaceErrorMessage(preview.error,getWorkspaceMessages(locale))}</p> : null}
    {data ? <>
      <p>{t('已冻结本次预览，账目变化后需重新预览。','This preview is frozen. Refresh it explicitly after ledger changes.')}</p>
      <p data-testid="settlement-net">{t('预览费用净额：','Preview net charges: ')}{formatFen(data.chargesFen,locale)}</p>
      <dl className="grid gap-3 sm:grid-cols-3">
        <div><dt>{t('基金支付', 'Fund pays')}</dt><dd>{formatFen(data.insurance?.fundFen ?? 0, locale)}</dd></div>
        <div><dt>{t('个人账户支付', 'Personal account pays')}</dt><dd>{formatFen(data.insurance?.accountFen ?? 0, locale)}</dd></div>
        <div><dt>{t('患者现金应付', 'Patient cash due')}</dt><dd>{formatFen(data.insurance?.patientFen ?? data.chargesFen, locale)}</dd></div>
      </dl>
      <p>{t('原预交金：','Original deposit: ')}{formatFen(data.depositFen,locale)}</p>
      <p data-testid="settlement-refund">{data.balanceFen < 0 ? t('应退：','Refund: ') : data.balanceFen > 0 ? t('应补缴：','Supplement: ') : t('无补退：','No balance: ')}{formatFen(Math.abs(data.balanceFen),locale)}</p>
      <Button disabled={write.blocked || preview.isFetching || admission.status !== 'departed' || data.status !== 'departed'} onClick={() => write.mutation.mutate({ operation:'inpatient.discharge.settle',input:{
        admissionId:admission.id,encounterVersion:data.encounterVersion,fingerprint:data.fingerprint,expectedChargesFen:data.chargesFen,expectedBalanceFen:data.balanceFen,
      } })}>{t('确认结算','Confirm settlement')}</Button>
    </> : null}
  </section>
}
