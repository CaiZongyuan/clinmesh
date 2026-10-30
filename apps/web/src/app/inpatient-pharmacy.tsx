import { inpatientPharmacyListSchema, inpatientPharmacySchema } from '@clinmesh/contracts/inpatient-clinical'
import { scenarioStateSchema, type SessionContext } from '@clinmesh/contracts/his'
import type { z } from 'zod'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@clinmesh/ui/components/empty'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiGet } from './api-client.ts'
import { DAY_MS } from './inpatient-scope.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import { WorkspaceModeSwitch } from './workspace-mode.tsx'
import { WorkspaceActionBar, WorkspaceCard, WorkspaceCardLayout, WorkspacePatientCard, WorkspaceQueueCard, useWorkspaceConfirmation } from './workspace-card-layout.tsx'
import { inpatientFlow } from './inpatient-stage-activity.ts'

type PharmacyData = z.infer<typeof inpatientPharmacySchema>
const NEAR_EXPIRY_DAYS = 30

export function InpatientPharmacy({ session, locale }: { session: SessionContext; locale: WorkspaceLocale }): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const scope = ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId]
  const [selectedId, setSelectedId] = useState<string>(), [lotIds, setLotIds] = useState<Record<string, string>>({})
  const [review, setReview] = useState<{ admissionId: string; executionId: string; expectedExecutionVersion: number; lotId: string; expectedLotVersion: number; quantity: number; display: string }>()
  const client = useQueryClient()
  const write = useInpatientWriteIntent(session, async () => { setReview(undefined); await client.invalidateQueries({ queryKey: ['inpatient'] }) })
  const admissions = useQuery({ queryKey: [...scope, 'pharmacy-list'], queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/pharmacy/admissions', inpatientPharmacyListSchema, signal) })
  const pharmacy = useQuery({ queryKey: [...scope, selectedId, 'pharmacy'], enabled: selectedId !== undefined,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${selectedId}/pharmacy`, inpatientPharmacySchema, signal) })
  const scenario = useQuery({ queryKey: ['scenario', 'virtual-time'], queryFn: ({ signal }) => apiGet('/api/sim/v1/scenario-runs/current', scenarioStateSchema, signal), retry: false })
  const virtualNow = scenario.data !== undefined ? Date.parse(scenario.data.virtualTime) : undefined
  const data = pharmacy.data?.admission.admissionId === selectedId ? pharmacy.data : undefined
  const error = admissions.error ?? pharmacy.error ?? write.storageFailure ?? write.mutation.error
  const statusText = (status: z.infer<typeof inpatientPharmacyListSchema>['items'][number]['status']) => ({ registered: t('待入科', 'Registered'), admitted: t('在院', 'Admitted'), 'discharge-pending': t('待出院', 'Discharge pending'), departed: t('已出院', 'Discharged'), cleared: t('已清床', 'Bed cleared') }[status])
  const choose = (id?: string) => { setSelectedId(id); setLotIds({}); setReview(undefined) }
  const row = (execution: PharmacyData['executions'][number]) => {
    const order = data!.orders.find(item => item.id === execution.orderId)!
    const lots = (data!.medications.find(item => item.id === order.catalogItemId)?.lots ?? []).toSorted((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.id.localeCompare(b.id))
    const lot = lots.find(item => item.id === (lotIds[execution.id] ?? lots[0]?.id))
    const valid = !write.blocked && data!.admission.status === 'admitted' && order.state === 'verified' && execution.status === 'pending' && lot !== undefined && lot.quantityOnHand >= order.doseQuantity
    return { order, lots, lot, valid }
  }
  const prepare = (execution: PharmacyData['executions'][number]) => {
    const { order, lot, valid } = row(execution)
    if (valid && lot && data) {
      confirmation.captureTrigger()
      setReview({ admissionId: data.admission.admissionId, executionId: execution.id, expectedExecutionVersion: execution.version,
        lotId: lot.id, expectedLotVersion: lot.version, quantity: order.doseQuantity, display: `${order.display} · ${order.doseQuantity}${order.unit} · ${lot.id}` })
    }
  }
  const first = data?.executions.find(item => item.status === 'pending')
  const selected = review && data?.executions.find(item => item.id === review.executionId)
  const reviewCurrent = !!review && !!selected && selected.version === review.expectedExecutionVersion && selected.status === 'pending'
    && data?.admission.admissionId === review.admissionId && row(selected).lot?.id === review.lotId && row(selected).lot?.version === review.expectedLotVersion && row(selected).valid
  const confirmation = useWorkspaceConfirmation({ open: review !== undefined, pending: write.mutation.isPending, disabled: write.blocked || !reviewCurrent,
    scope: JSON.stringify([session.user.id, session.actor, selectedId]), onCancel: () => setReview(undefined) })
  const action = review ? <WorkspaceActionBar tone="confirm" onKeyDown={confirmation.onKeyDown} summary={review.display} reason={t('确认后扣减本批次库存并记录发药，由病区护士按时给药。', 'Confirmation deducts this lot and records dispensing. The ward nurse administers the medication at the scheduled time.')}
    action={<><Button variant="outline" disabled={write.mutation.isPending} onClick={() => setReview(undefined)}>{t('返回', 'Back')}</Button><Button ref={confirmation.confirmRef} disabled={write.blocked || !reviewCurrent} onClick={() => {
      if (reviewCurrent) write.mutation.mutate({ operation: 'inpatient.execution.dispense', input: { admissionId: review.admissionId, executionId: review.executionId,
        expectedExecutionVersion: review.expectedExecutionVersion, lotSelections: [{ lotId: review.lotId, expectedVersion: review.expectedLotVersion, quantity: review.quantity }] } })
    }}>{t('确认发药', 'Confirm dispensing')}</Button></>} />
    : first ? <WorkspaceActionBar summary={row(first).order.display} reason={row(first).valid ? t('护士已校对，核对批次和数量后发药。', 'The nurse verified the order. Check the lot and quantity before dispensing.') : t('库存不足或医嘱不能发药，请核对批次和当前医嘱。', 'Stock or order status prevents dispensing. Check the lot and current order.')}
      tone={row(first).valid ? 'normal' : 'blocked'} action={<Button ref={confirmation.triggerRef} disabled={!row(first).valid} onClick={() => prepare(first)}>{t('发药', 'Dispense')}</Button>} />
      : write.mutation.isSuccess && write.mutation.data?.command.operation === 'inpatient.execution.dispense' && write.mutation.data.command.input.admissionId === selectedId
        ? <WorkspaceActionBar tone="complete" summary={<span role="status">{t('已完成发药', 'Dispensing completed')}</span>} reason={t('下一步：病区护士按时给药。', 'Next: the ward nurse administers the medication at the scheduled time.')} /> : undefined
  const queue = <WorkspaceQueueCard title={<h2>{t('住院发药队列', 'Inpatient dispensing queue')}</h2>} actions={<Button variant="ghost" size="sm" onClick={() => void client.invalidateQueries({ queryKey: ['inpatient'] })}>{t('刷新', 'Refresh')}</Button>}>
    <div data-inpatient-queue className="flex flex-col gap-3"><WorkspaceModeSwitch />
      {selectedId ? <Button variant="outline" size="sm" onClick={() => choose()}>{t('返回住院患者', 'Back to admissions')}</Button> : null}
      <p className="text-sm text-muted-foreground">{t('等护士校对医嘱后进入队列；发药后由护士给药。', 'Orders enter after nurse verification. The nurse administers dispensed medication.')}</p>
      {admissions.isPending ? <Skeleton className="h-24 w-full" /> : null}
      <div data-inpatient-queue-items>{admissions.data?.items.map(admission => <Button key={admission.admissionId} variant="ghost" className="h-auto w-full justify-start whitespace-normal py-3 text-start" aria-current={selectedId === admission.admissionId ? 'true' : undefined}
        aria-label={`${t('查看', 'View ')}${admission.patientName}`} onClick={() => choose(admission.admissionId)}><span className="flex min-w-0 flex-col gap-1"><strong>{admission.patientName}</strong><span className="text-xs tabular-nums text-muted-foreground">{admission.inpatientNumber} · {statusText(admission.status)}</span></span></Button>)}</div>
      {admissions.data?.items.length === 0 ? <p className="text-sm text-muted-foreground">{t('暂无住院药品医嘱，等病区护士完成校对。', 'No inpatient medication orders. Wait for ward nurse verification.')}</p> : null}
    </div>
  </WorkspaceQueueCard>
  const known = data?.admission.status
  const current = known === 'registered' ? 1 : known === 'admitted' ? 2 : known === 'discharge-pending' ? 3 : undefined
  const through = known === 'cleared' ? 5 : known === 'departed' ? 3 : current === undefined ? -1 : current - 1
  const flow = inpatientFlow(undefined, locale).map((step, index) => ({ ...step, status: index === current ? 'current' as const : index <= through ? 'completed' as const : 'pending' as const }))
  return <section aria-label={t('住院药房', 'Inpatient pharmacy')} className="flex min-h-0 min-w-0 flex-1 flex-col"><WorkspaceCardLayout id={`inpatient-pharmacy-${session.actor.practitionerRoleId}`} locale={locale} queue={queue} flow={flow} action={action}
    patient={data ? <section aria-label={t('当前住院患者', 'Current inpatient')}><WorkspacePatientCard title={data.admission.patientName} description={data.admission.inpatientNumber} actions={<Badge variant="outline">{statusText(data.admission.status)}</Badge>}><p>{t('护士已校对的住院药嘱', 'Nurse-verified inpatient medication orders')}</p></WorkspacePatientCard></section> : undefined}
    aside={data ? <WorkspaceCard title={t('药物过敏提示', 'Medication allergies')}><p>{data.medicationAllergies.map(item => item.display).join('、') || t('未记录有效药物过敏。', 'No active medication allergies recorded.')}</p></WorkspaceCard> : undefined}>
    {error ? <Alert variant="destructive"><AlertDescription>{t('住院药房读取或操作失败：', 'Inpatient pharmacy data or action failed: ')}{getWorkspaceErrorMessage(error, getWorkspaceMessages(locale))}<Button variant="outline" onClick={() => { void admissions.refetch(); if (selectedId) void pharmacy.refetch() }}>{t('重试读取', 'Retry loading')}</Button></AlertDescription></Alert> : null}
    <InpatientWriteRecovery write={write} locale={locale} />
    {selectedId && pharmacy.isPending ? <Skeleton className="h-32 w-full" /> : null}
    {!selectedId ? <Empty><EmptyHeader><EmptyTitle>{t('从队列选择患者', 'Select a patient')}</EmptyTitle><EmptyDescription>{t('核对护士已校对的药嘱、批次及数量后办理发药。', 'Review verified medication orders, lots and quantities before dispensing.')}</EmptyDescription></EmptyHeader></Empty> : null}
    {data ? <WorkspaceCard title={<h2>{t('住院发药', 'Inpatient dispensing')}</h2>} description={t('护士校对 → 药师发药 → 护士给药', 'Nurse verification → pharmacist dispensing → nurse administration')}>
      <div className="flex flex-col gap-3">{data.executions.map(execution => {
        const { order, lots, lot, valid } = row(execution)
        const expiryMs = lot === undefined ? undefined : Date.parse(lot.expiresOn)
        const nearExpiry = virtualNow !== undefined && expiryMs !== undefined && expiryMs - virtualNow <= NEAR_EXPIRY_DAYS * DAY_MS
        return <article key={execution.id} className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
          <p className="font-medium">{order.display} · {{ pending: t('待发药', 'Awaiting dispensing'), dispensed: t('已发药', 'Dispensed'), completed: t('已完成', 'Completed'), cancelled: t('已取消', 'Cancelled') }[execution.status]}</p>
          <p className="text-sm tabular-nums">{order.doseText} · {order.doseQuantity}{order.unit} · {new Date(execution.scheduledFor).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })}</p>
          {execution.status === 'pending' ? <>
            <Field><FieldLabel htmlFor={`inpatient-lot-${execution.id}`}>{t('发药批次', 'Inventory lot')}</FieldLabel><WorkspaceSelect id={`inpatient-lot-${execution.id}`} value={lot?.id ?? null} disabled={write.blocked || review !== undefined}
              items={lots.map(item => ({ value: item.id, label: `${item.id} · ${t('库存', 'Stock ')} ${item.quantityOnHand}${order.unit} · ${t('有效期', 'Expires ')} ${item.expiresOn}` }))} onValueChange={value => { if (value) setLotIds(current => ({ ...current, [execution.id]: value })) }} /></Field>
            {lot && lot.quantityOnHand < order.doseQuantity ? <p role="alert">{t('本批次库存不足，请选择其他批次。', 'This lot has insufficient stock. Choose another lot.')}</p> : null}
            {lot && nearExpiry ? <p className="text-sm text-warning">{t('临期批次', 'Near expiry')} · {lot.expiresOn}</p> : null}
            {first?.id !== execution.id ? <Button variant="outline" disabled={!valid || review !== undefined} onClick={() => prepare(execution)}>{t('准备此条发药', 'Prepare this dispensing')}</Button> : null}
          </> : null}
        </article>
      })}</div>
    </WorkspaceCard> : null}
  </WorkspaceCardLayout></section>
}
