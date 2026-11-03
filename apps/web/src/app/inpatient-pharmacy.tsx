import { inpatientPharmacyListSchema, inpatientPharmacySchema } from '@clinmesh/contracts/inpatient-clinical'
import { scenarioStateSchema, type SessionContext } from '@clinmesh/contracts/his'
import type { z } from 'zod'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@clinmesh/ui/components/empty'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { apiGet } from './api-client.ts'
import { DAY_MS } from './inpatient-scope.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import { WorkspaceModeSwitch } from './workspace-mode.tsx'
import { WorkspaceActionBar, WorkspaceCardLayout, WorkspaceQueueCard, announceHandoff, useWorkspaceConfirmation } from './workspace-card-layout.tsx'
import { InpatientItemRow, InpatientPatientHeader, InpatientQueueGroup, InpatientStageCard } from './inpatient-layout.tsx'
import { inpatientFlow } from './inpatient-stage-activity.ts'
import { InpatientNumber } from './inpatient-number.tsx'

type PharmacyData = z.infer<typeof inpatientPharmacySchema>
type QueueEntry = { data: PharmacyData; execution: PharmacyData['executions'][number] | undefined; order: PharmacyData['orders'][number] }
const NEAR_EXPIRY_DAYS = 30

export function InpatientPharmacy({ session, locale }: { session: SessionContext; locale: WorkspaceLocale }): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const scope = ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId]
  const [selectedId, setSelectedId] = useState<string>(), [lotIds, setLotIds] = useState<Record<string, string>>({})
  const [tab, setTab] = useState<'pending' | 'dispensed'>('pending')
  const [review, setReview] = useState<{ admissionId: string; executionId: string; expectedExecutionVersion: number; lotId: string; expectedLotVersion: number; quantity: number; display: string }>()
  const client = useQueryClient()
  const write = useInpatientWriteIntent(session, async command => {
    setReview(undefined)
    const name = command.operation === 'inpatient.execution.dispense' ? admissions.data?.items.find(item => item.admissionId === command.input.admissionId)?.patientName : undefined
    await client.invalidateQueries({ queryKey: ['inpatient'] })
    if (name !== undefined) announceHandoff(`${t('已发药', 'Dispensed')} · ${name}`, t('已交给病区护士给药', 'Handed to the ward nurse to administer'))
  })
  const admissions = useQuery({ queryKey: [...scope, 'pharmacy-list'], queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/pharmacy/admissions', inpatientPharmacyListSchema, signal) })
  // 许可列表只提供患者索引；按原有窄投影读取药嘱，Query cache 是唯一服务端状态。
  const details = useQueries({ queries: (admissions.data?.items ?? []).map(admission => ({
    queryKey: [...scope, admission.admissionId, 'pharmacy'],
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.admissionId}/pharmacy`, inpatientPharmacySchema, signal),
  })) })
  const entries: QueueEntry[] = details.flatMap(query => {
    if (!query.data) return []
    const data = query.data
    return data.orders.flatMap<QueueEntry>(order => {
      const executions = data.executions.filter(execution => execution.orderId === order.id && (order.state === 'verified' && execution.status === 'pending' || ['dispensed', 'completed'].includes(execution.status)))
      // 长期药嘱校对后，下一时点的执行单可能尚未展开；保留药品上下文，但不提供发药写入。
      return executions.length > 0 ? executions.map(execution => ({ data, execution, order })) : order.state === 'verified' ? [{ data, execution: undefined, order }] : []
    })
  })
  const entryId = (entry: QueueEntry) => entry.execution?.id ?? entry.order.id
  const pending = entries.filter(entry => entry.execution === undefined || entry.execution.status === 'pending')
  const dispensed = entries.filter(entry => entry.execution !== undefined && entry.execution.status !== 'pending')
  const shown = tab === 'pending' ? pending : dispensed
  const selected = shown.find(entry => entryId(entry) === selectedId)
  const data = selected?.data
  const scenario = useQuery({ queryKey: ['scenario', 'virtual-time'], queryFn: ({ signal }) => apiGet('/api/sim/v1/scenario-runs/current', scenarioStateSchema, signal), retry: false })
  const virtualNow = scenario.data !== undefined ? Date.parse(scenario.data.virtualTime) : undefined
  const loading = admissions.isPending || details.some(query => query.isPending)
  const error = admissions.error ?? details.find(query => query.error)?.error ?? write.storageFailure ?? write.mutation.error
  const choose = (id?: string) => { setSelectedId(id); setReview(undefined) }
  const listed = useRef<string[]>([])
  useEffect(() => {
    const ids = shown.map(entryId)
    const completed = write.mutation.data?.command.operation === 'inpatient.execution.dispense' && write.mutation.data.command.input.executionId === selectedId
    const index = selectedId === undefined ? -1 : listed.current.indexOf(selectedId)
    // 刷新会早于 mutation 的 success 通知移走旧行；保留原位置，等写入确认后再选择下一条。
    if (selectedId !== undefined && !ids.includes(selectedId) && !completed) return
    if (completed && index >= 0 && !ids.includes(selectedId!)) { setSelectedId(ids[Math.min(index, ids.length - 1)]); setReview(undefined) }
    listed.current = ids
  }, [shown, selectedId, write.mutation.data])
  const lots = data?.medications.find(item => item.id === selected?.order.catalogItemId)?.lots.toSorted((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.id.localeCompare(b.id)) ?? []
  const lot = lots.find(item => item.id === (selectedId ? lotIds[selectedId] : undefined)) ?? lots[0]
  // 当前 DTO 没有厂家批号；本页序号仅用于区分真实库存批次，不把内部 id 伪装成批号。
  const lotLabel = (id: string) => {
    const index = lots.findIndex(item => item.id === id)
    return index < 0 ? t('已记录库存批次', 'Recorded stock lot') : `${t('库存批次 ', 'Stock lot ')}${index + 1}`
  }
  const valid = !!selected && !write.blocked && selected.data.admission.status === 'admitted' && selected.order.state === 'verified'
    && selected.execution?.status === 'pending' && !!lot && lot.quantityOnHand >= selected.order.doseQuantity
  const prepare = () => {
    if (!valid || !selected?.execution || !lot) return
    confirmation.captureTrigger()
    setReview({ admissionId: selected.data.admission.admissionId, executionId: selected.execution.id, expectedExecutionVersion: selected.execution.version,
      lotId: lot.id, expectedLotVersion: lot.version, quantity: selected.order.doseQuantity, display: `${selected.order.display} · ${selected.order.doseQuantity}${selected.order.unit} · ${lotLabel(lot.id)}` })
  }
  const reviewCurrent = !!review && !!selected && selected.execution?.version === review.expectedExecutionVersion && valid
    && selected.data.admission.admissionId === review.admissionId && selected.execution.id === review.executionId && lot?.id === review.lotId && lot.version === review.expectedLotVersion
  const confirmation = useWorkspaceConfirmation({ open: review !== undefined, pending: write.mutation.isPending, disabled: write.blocked || !reviewCurrent,
    scope: JSON.stringify([session.user.id, session.actor, selectedId]), onCancel: () => setReview(undefined) })
  const action = review ? <WorkspaceActionBar tone="confirm" onKeyDown={confirmation.onKeyDown} busy={write.mutation.isPending ? t('正在发药', 'Dispensing') : undefined} summary={review.display} reason={t('确认后扣减本批次库存并记录发药，由病区护士按时给药。', 'Confirmation deducts this lot and records dispensing. The ward nurse administers at the scheduled time.')}
    action={<><Button variant="outline" disabled={write.mutation.isPending} onClick={() => setReview(undefined)}>{t('返回', 'Back')}</Button><Button ref={confirmation.confirmRef} disabled={write.blocked || !reviewCurrent} onClick={() => {
      if (reviewCurrent) write.mutation.mutate({ operation: 'inpatient.execution.dispense', input: { admissionId: review.admissionId, executionId: review.executionId,
        expectedExecutionVersion: review.expectedExecutionVersion, lotSelections: [{ lotId: review.lotId, expectedVersion: review.expectedLotVersion, quantity: review.quantity }] } })
    }}>{t('确认发药', 'Confirm dispensing')}</Button></>} />
    : selected?.execution?.status === 'pending' ? <WorkspaceActionBar summary={selected.order.display} reason={valid ? t('护士已校对，核对批次和数量后发药。', 'The nurse verified the order. Check the lot and quantity before dispensing.') : t('库存不足或医嘱不能发药，请核对批次和当前医嘱。', 'Stock or order status prevents dispensing. Check the lot and current order.')}
      tone={valid ? 'normal' : 'blocked'} action={<Button ref={confirmation.triggerRef} disabled={!valid} onClick={prepare}>{t('发药', 'Dispense')}</Button>} />
      : pending.length === 0 && write.mutation.isSuccess ? <WorkspaceActionBar tone="complete" summary={<span role="status">{t('已完成发药', 'Dispensing completed')}</span>} reason={t('下一步：病区护士按时给药。', 'Next: the ward nurse administers medication at the scheduled time.')} /> : undefined
  const queue = <WorkspaceQueueCard title={<h2>{t('住院发药', 'Inpatient dispensing')}</h2>} actions={<Button variant="ghost" size="sm" onClick={() => void client.invalidateQueries({ queryKey: ['inpatient'] })}>{t('刷新', 'Refresh')}</Button>}>
    <div className="flex flex-col gap-3"><WorkspaceModeSwitch />
      <ToggleGroup aria-label={t('住院发药状态', 'Inpatient dispensing status')} value={[tab]} variant="outline" data-view-switch="" onValueChange={values => { if (values[0] === 'pending' || values[0] === 'dispensed') { setTab(values[0]); choose() } }}>
        <ToggleGroupItem value="pending">{t('待发药', 'Awaiting dispensing')} {pending.length}</ToggleGroupItem><ToggleGroupItem value="dispensed">{t('已发药', 'Dispensed')} {dispensed.length}</ToggleGroupItem>
      </ToggleGroup>
      {admissions.isPending || details.some(query => query.isPending) ? <Skeleton className="h-24 w-full" /> : null}
      <InpatientQueueGroup title={tab === 'pending' ? t('待发药', 'Awaiting dispensing') : t('已发药', 'Dispensed')} count={shown.length}>
        <div data-inpatient-queue-items>{shown.map(entry => <Button key={entryId(entry)} variant="ghost" className="h-auto w-full justify-start whitespace-normal text-start" aria-current={selectedId === entryId(entry) ? 'true' : undefined}
          aria-label={`${t('查看', 'View ')}${entry.data.admission.patientName} · ${entry.order.display}`} onClick={() => choose(entryId(entry))}><span className="flex min-w-0 flex-col gap-1"><strong>{entry.order.display}</strong><span className="text-xs text-muted-foreground">{entry.data.admission.patientName} · {entry.order.doseText} · {entry.order.frequencyCode}</span></span></Button>)}</div>
      </InpatientQueueGroup>
      {admissions.data && !details.some(query => query.isPending) && shown.length === 0 ? <p className="text-sm text-muted-foreground">{t('暂无待办；护士校对医嘱后进入待发药，发药后由病区护士按时给药。', 'No pending work. Orders appear after nurse verification; the ward nurse administers after dispensing.')}</p> : null}
    </div>
  </WorkspaceQueueCard>
  const status = selected?.data.admission.status
  const current = status === 'registered' ? 1 : status === 'admitted' ? 2 : status === 'discharge-pending' ? 3 : status === 'departed' ? 4 : status === 'cleared' ? 6 : -1
  const flow = inpatientFlow(undefined, locale).map((step, index) => ({ ...step, status: index === current ? 'current' as const : index < current ? 'completed' as const : 'pending' as const }))
  return <section aria-label={t('住院药房', 'Inpatient pharmacy')} className="clinmesh-inpatient-workspace flex min-h-0 min-w-0 flex-1 flex-col"><WorkspaceCardLayout id={`inpatient-pharmacy-${session.actor.practitionerRoleId}`} locale={locale} queue={queue} flow={flow} action={action}
    patient={selected ? <><section aria-label={t('当前住院患者', 'Current inpatient')}><InpatientPatientHeader name={selected.order.display} identity={`${selected.data.admission.patientName} · ${selected.order.doseText} · ${selected.order.frequencyCode}`}
      status={selected.execution === undefined ? t('待生成执行单', 'Awaiting execution schedule') : selected.execution.status === 'pending' ? t('待发药', 'Awaiting dispensing') : t('已发药', 'Dispensed')}
      details={<><InpatientNumber locale={locale} number={selected.data.admission.inpatientNumber} />{selected.order.verifiedAt ? <span>{t('校对时间 ', 'Verified ')}{new Date(selected.order.verifiedAt).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })}</span> : null}</>} /></section>
      {data?.medicationAllergies.length ? <section aria-label={t('药物过敏提示', 'Medication allergies')} className="flex flex-wrap gap-1.5 px-4 pb-2">{data.medicationAllergies.map(item => <Badge key={item.id} variant="destructive">{t('药物过敏 · ', 'Allergy · ')}{item.display}</Badge>)}</section> : null}</> : undefined}>
    {error ? <Alert variant="destructive"><AlertDescription>{t('住院药房读取或操作失败：', 'Inpatient pharmacy data or action failed: ')}{getWorkspaceErrorMessage(error, getWorkspaceMessages(locale))}<Button variant="outline" onClick={() => { void admissions.refetch(); void Promise.all(details.map(query => query.refetch())) }}>{t('重试读取', 'Retry loading')}</Button></AlertDescription></Alert> : null}
    <InpatientWriteRecovery write={write} locale={locale} />
    {!selected && !loading && !error ? <Empty><EmptyHeader><EmptyTitle>{pending.length === 0 ? t('暂无待发药品', 'No medications awaiting dispensing') : t('从队列选择药品', 'Select a medication')}</EmptyTitle><EmptyDescription>{pending.length === 0 ? t('下一步：病区护士按时给药。', 'Next: the ward nurse administers medication at the scheduled time.') : t('核对护士已校对的药嘱、批次及数量后办理发药。', 'Review the verified order, lot and quantity before dispensing.')}</EmptyDescription></EmptyHeader></Empty> : selected ? <InpatientStageCard title={t('住院发药', 'Inpatient dispensing')}
      turn={selected.execution === undefined ? t('等下一次给药执行单生成', 'Waiting for the next medication execution to be scheduled') : selected.execution.status === 'pending' ? t('轮到你：核对批次和数量后发药', 'Your turn: check the lot and quantity, then dispense') : t('等病区护士按时给药', 'Waiting for the ward nurse to administer')}
      owners={<p className="text-xs">{t('护士校对', 'Nurse verification')} → <strong>{t('药师发药', 'Pharmacist dispensing')}</strong> → {t('护士给药', 'Nurse administration')}</p>}>
      <InpatientItemRow key={entryId(selected)} title={selected.order.display} badge={<Badge variant="outline">{selected.order.duration === 'long' ? t('长期', 'Long') : t('临时', 'Temporary')}</Badge>}
        metadata={<><span>{selected.order.doseText} · {selected.order.doseQuantity}{selected.order.unit} · {selected.order.frequencyCode}</span>{selected.execution ? <span>{new Date(selected.execution.scheduledFor).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })}</span> : null}</>} complete={selected.execution !== undefined && selected.execution.status !== 'pending'}>
        {selected.execution === undefined ? <p>{t('护士已校对；执行单生成后可核对批次和数量并发药。', 'The nurse has verified the order. Check the lot and quantity once the execution is scheduled.')}</p> : selected.execution.status === 'pending' ? <>
          <Field><FieldLabel htmlFor={`inpatient-lot-${selected.execution.id}`}>{t('发药批次', 'Inventory lot')}</FieldLabel><WorkspaceSelect id={`inpatient-lot-${selected.execution.id}`} value={lot?.id ?? null} disabled={write.blocked || review !== undefined}
            items={lots.map(item => ({ value: item.id, label: `${lotLabel(item.id)} · ${t('库存', 'Stock ')} ${item.quantityOnHand}${selected.order.unit} · ${t('有效期', 'Expires ')} ${item.expiresOn}${virtualNow !== undefined && Date.parse(item.expiresOn) - virtualNow <= NEAR_EXPIRY_DAYS * DAY_MS ? t(' · 临期批次', ' · Near expiry') : ''}` }))} onValueChange={value => { if (value) setLotIds(current => ({ ...current, [entryId(selected)]: value })) }} /></Field>
          <p>{t('本次发药数量：', 'Quantity for this execution: ')}<strong className="tabular-nums">{selected.order.doseQuantity}{selected.order.unit}</strong></p>
          {lot && lot.quantityOnHand < selected.order.doseQuantity ? <p role="alert">{t('本批次库存不足，请选择其他批次。', 'This lot has insufficient stock. Choose another lot.')}</p> : null}
        </> : data?.dispenses.filter(item => item.executionId === selected.execution?.id).map(item => <p key={item.id}>{lotLabel(item.lotId)} · {item.quantity}{selected.order.unit}</p>)}
      </InpatientItemRow>
    </InpatientStageCard> : null}
  </WorkspaceCardLayout></section>
}
