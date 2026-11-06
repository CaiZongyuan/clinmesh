import { inpatientFrequencyLabel } from './inpatient-labels.ts'
import { formatShanghaiMinute } from './workspace-format.ts'
import { inpatientPharmacyListSchema, inpatientPharmacySchema } from '@clinmesh/contracts/inpatient-clinical'
import { scenarioStateSchema, type SessionContext } from '@clinmesh/contracts/his'
import type { z } from 'zod'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldDescription, FieldLabel } from '@clinmesh/ui/components/field'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@clinmesh/ui/components/empty'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { apiGet } from './api-client.ts'
import { DAY_MS } from './inpatient-scope.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import { WorkspaceModeSwitch } from './workspace-mode.tsx'
import { WorkspaceActionBar, WorkspaceCardLayout, WorkspaceQueueCard, announceHandoff, useWorkspaceConfirmation } from './workspace-card-layout.tsx'
import { InpatientItemRow, InpatientPatientHeader, InpatientStageCard } from './inpatient-layout.tsx'
import { inpatientFlow } from './inpatient-stage-activity.ts'
import { InpatientNumber } from './inpatient-number.tsx'
import { PaginationControls } from './pagination-controls.tsx'
import { RefreshCwIcon } from 'lucide-react'

type PharmacyTab = 'pending' | 'dispensed'
type PharmacyAdmission = z.infer<typeof inpatientPharmacyListSchema>['items'][number]
type PharmacyData = z.infer<typeof inpatientPharmacySchema>
type QueueEntry = { data: PharmacyData; execution: PharmacyData['executions'][number] | undefined; order: PharmacyData['orders'][number] }
type ReviewState = { admissionId: string; executionId: string; expectedExecutionVersion: number; lotId: string; expectedLotVersion: number; quantity: number; display: string }
const NEAR_EXPIRY_DAYS = 30
const PATIENTS_PER_PAGE = 10

function pharmacyCandidates(indexed: readonly PharmacyAdmission[], tab: PharmacyTab): readonly PharmacyAdmission[] {
  return tab === 'pending' ? indexed.filter(item => item.status === 'admitted') : indexed
}

export function InpatientPharmacy({ session, locale }: { session: SessionContext; locale: WorkspaceLocale }): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const scope = ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId]
  const [selectedId, setSelectedId] = useState<string>(), [lotIds, setLotIds] = useState<Record<string, string>>({})
  const [review, setReview] = useState<ReviewState>()
  const [tab, setTab] = useState<PharmacyTab>('pending')
  const [requestedPages, setRequestedPages] = useState<Record<PharmacyTab, number>>({ pending: 0, dispensed: 0 })
  const pageScopeId = useId()
  const client = useQueryClient()
  const write = useInpatientWriteIntent(session, async command => {
    const name = command.operation === 'inpatient.execution.dispense' ? admissions.data?.items.find(item => item.admissionId === command.input.admissionId)?.patientName : undefined
    await client.invalidateQueries({ queryKey: ['inpatient'] })
    setReview(undefined)
    if (name !== undefined) announceHandoff(`${t('已发药', 'Dispensed')} · ${name}`, t('已交给病区护士给药', 'Handed to the ward nurse to administer'))
  })
  const admissions = useQuery({ queryKey: [...scope, 'pharmacy-list'], queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/pharmacy/admissions', inpatientPharmacyListSchema, signal) })
  const indexed = admissions.data?.items ?? []
  const candidates = pharmacyCandidates(indexed, tab)
  const pageCount = Math.max(1, Math.ceil(candidates.length / PATIENTS_PER_PAGE))
  const page = Math.min(requestedPages[tab], pageCount - 1)
  const pageAdmissions = candidates.slice(page * PATIENTS_PER_PAGE, (page + 1) * PATIENTS_PER_PAGE)
  const hasNextPage = page < pageCount - 1
  // 历史索引不包含药品摘要。只读取当前患者页的窄投影，其他页由用户显式翻页后读取。
  const details = useQueries({ queries: pageAdmissions.map(admission => ({
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
  const pending = entries.filter(entry => entry.data.admission.status === 'admitted' && (entry.execution === undefined || entry.execution.status === 'pending'))
  const dispensed = entries.filter(entry => entry.execution !== undefined && entry.execution.status !== 'pending')
  const shown = tab === 'pending' ? pending : dispensed
  const selected = shown.find(entry => entryId(entry) === selectedId)
  const data = selected?.data
  const selectedRead = data === undefined ? undefined : details.find(query => query.data?.admission.admissionId === data.admission.admissionId)
  const allergyReady = selectedRead?.isSuccess === true && !selectedRead.isFetching
  const scenario = useQuery({ queryKey: ['scenario', 'virtual-time'], queryFn: ({ signal }) => apiGet('/api/sim/v1/scenario-runs/current', scenarioStateSchema, signal), retry: false })
  const virtualNow = scenario.data !== undefined ? Date.parse(scenario.data.virtualTime) : undefined
  const queueReady = admissions.isSuccess && details.every(query => query.isSuccess)
  const loading = admissions.isPending || details.some(query => query.isPending)
  const error = admissions.error ?? details.find(query => query.error)?.error ?? write.storageFailure ?? write.mutation.error
  const choose = (id?: string) => { setSelectedId(id); setReview(undefined) }
  const listed = useRef<string[]>([])
  const selectAfterPageLoad = useRef(false)
  const changePage = useCallback((nextPage: number, selectFirst = false, nextTab: PharmacyTab = tab) => {
    if (write.mutation.isPending) return
    selectAfterPageLoad.current = selectFirst
    setTab(nextTab)
    setRequestedPages(current => ({ ...current, [nextTab]: nextPage }))
    setSelectedId(undefined)
    setReview(undefined)
    setLotIds({})
    listed.current = []
  }, [tab, write.mutation.isPending])
  const completedResult = write.mutation.isSuccess ? write.mutation.data : undefined
  const completedCommand = completedResult?.command.operation === 'inpatient.execution.dispense' ? completedResult.command : undefined
  const followedResult = useRef<typeof completedResult>(undefined)
  useEffect(() => {
    if (!completedResult || !completedCommand || followedResult.current === completedResult || !admissions.isSuccess) return
    followedResult.current = completedResult
    const patient = admissions.data.items.find(item => item.admissionId === completedCommand.input.admissionId)
    if (!patient) return
    const destination = patient.status === 'admitted' ? 'pending' : 'dispensed'
    const index = pharmacyCandidates(admissions.data.items, destination).findIndex(item => item.admissionId === patient.admissionId)
    const destinationPage = Math.floor(index / PATIENTS_PER_PAGE)
    // 原患者已离院时恢复到已发历史；页码始终来自目标页签的同一候选集合。
    if (destination !== tab || destinationPage !== page) changePage(destinationPage, false, destination)
  }, [admissions.data, admissions.isSuccess, changePage, completedCommand, completedResult, page, tab])
  const completedOnPage = completedCommand !== undefined && pageAdmissions.some(item => item.admissionId === completedCommand.input.admissionId)
  useEffect(() => {
    if (!queueReady || !selectAfterPageLoad.current) return
    selectAfterPageLoad.current = false
    setSelectedId(shown[0] ? entryId(shown[0]) : undefined)
  }, [queueReady, shown])
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
  const valid = !!selected && allergyReady && !write.blocked && selected.data.admission.status === 'admitted' && selected.order.state === 'verified'
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
    : selected?.execution?.status === 'pending' ? <WorkspaceActionBar summary={`${selected.order.display} · ${selected.order.doseQuantity}${selected.order.unit}${lot ? ` · ${lotLabel(lot.id)}` : ''}`} reason={valid ? t('护士已校对，核对批次和数量后发药。', 'The nurse verified the order. Check the lot and quantity before dispensing.') : t('库存不足或医嘱不能发药，请核对批次和当前医嘱。', 'Stock or order status prevents dispensing. Check the lot and current order.')}
      tone={valid ? 'normal' : 'blocked'} action={<Button ref={confirmation.triggerRef} disabled={!valid} onClick={prepare}>{t('发药', 'Dispense')}</Button>} />
      : selected && selected.execution === undefined ? <WorkspaceActionBar tone="normal" summary={selected.order.display} reason={t('护士已校对；等下一次给药执行单生成后再核对批次发药。', 'Verified by nurse; awaiting next scheduled execution.')} />
      : queueReady && completedOnPage && (tab === 'dispensed' || pending.length === 0) ? <WorkspaceActionBar tone="complete" summary={<span role="status">{tab === 'dispensed' ? t('已完成本次发药', 'Dispensing completed') : pageCount > 1 ? t('本页已完成发药', 'Dispensing completed on this page') : t('已完成发药', 'Dispensing completed')}</span>} reason={tab === 'dispensed' ? t('本次发药已完成，已发记录保留只读。', 'Dispensing is complete. Its record remains read only.') : hasNextPage ? t('本页药品已处理，可继续下一页；已发药由病区护士按时给药。', 'This page is complete. Continue to the next page; the ward nurse administers dispensed medication.'): t('下一步：病区护士按时给药。', 'Next: the ward nurse administers medication at the scheduled time.')} action={tab === 'pending' && hasNextPage ? <Button variant="outline" onClick={() => changePage(page + 1, true, 'pending')}>{t('继续下一页', 'Continue to next page')}</Button> : undefined} /> : undefined
  const queue = <WorkspaceQueueCard title={<h2>{t('住院发药', 'Inpatient dispensing')}</h2>} actions={<>{queueReady ? <Badge variant="secondary" className="tabular-nums">{shown.length}</Badge> : null}<Button variant="ghost" size="icon-sm" aria-label={t('刷新', 'Refresh')} title={t('刷新', 'Refresh')} onClick={() => void client.invalidateQueries({ queryKey: ['inpatient'] })}><RefreshCwIcon aria-hidden="true" /></Button></>}>
    <div className="flex flex-col gap-3"><WorkspaceModeSwitch />
      <ToggleGroup aria-label={t('住院发药状态', 'Inpatient dispensing status')} aria-describedby={pageScopeId} disabled={write.mutation.isPending} value={[tab]} variant="outline" data-view-switch="" onValueChange={values => { if (values[0] === 'pending' || values[0] === 'dispensed') changePage(requestedPages[values[0]], false, values[0]) }}>
        <ToggleGroupItem value="pending">{t('待发药', 'Awaiting dispensing')}{queueReady ? ` ${pending.length}` : ''}</ToggleGroupItem><ToggleGroupItem value="dispensed">{t('已发药', 'Dispensed')}{queueReady ? ` ${dispensed.length}` : ''}</ToggleGroupItem>
      </ToggleGroup>
      <span id={pageScopeId} hidden>{t('药品计数仅限本页患者', 'Medication counts cover patients on this page')}</span>
      {admissions.isSuccess && pageCount > 1 ? <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{t(`本页 ${pageAdmissions.length} 位患者`, `${pageAdmissions.length} patients on this page`)}</span>
        <PaginationControls ariaLabel={t('住院发药分页', 'Inpatient dispensing pages')} messages={getWorkspaceMessages(locale)} page={page + 1} pageSize={PATIENTS_PER_PAGE} total={candidates.length} disabled={write.mutation.isPending} onPageChange={next => changePage(next - 1)} />
      </div> : null}
      {admissions.isPending || details.some(query => query.isPending) ? <Skeleton className="h-24 w-full" /> : null}
      <div data-inpatient-queue-items>{shown.map(entry => <Button key={entryId(entry)} variant="ghost" className="h-auto w-full justify-start whitespace-normal text-start" aria-current={selectedId === entryId(entry) ? 'true' : undefined} disabled={write.mutation.isPending}
        aria-label={`${t('查看', 'View ')}${entry.data.admission.patientName} · ${entry.order.display}`} onClick={() => choose(entryId(entry))}><span className="flex min-w-0 flex-1 flex-col gap-1"><span className="flex items-center justify-between gap-2"><strong className="truncate">{entry.order.display}</strong><Badge variant={entry.execution === undefined || entry.execution.status === 'pending' ? 'warning' : 'success'} className="shrink-0">{entry.execution === undefined || entry.execution.status === 'pending' ? t('待发', 'Pending') : t('已发', 'Dispensed')}</Badge></span><span className="text-xs text-muted-foreground">{entry.data.admission.patientName} · {entry.order.duration === 'long' ? t('长期', 'Long') : t('临时', 'Temporary')} · {entry.order.doseText} · {entry.order.frequencyCode} · {entry.order.doseQuantity}{entry.order.unit}</span></span></Button>)}</div>
      {queueReady && shown.length === 0 ? <p className="text-sm text-muted-foreground">{pageCount > 1
        ? t('本页暂无药品记录，可翻页查看。', 'No medication records on this page. Browse another page.')
        : tab === 'pending' ? t('护士校对医嘱后，待发药品会出现在这里。', 'Medication appears here after nurse verification.') : t('发药后可在这里查看记录。', 'Dispensing records appear here after medication is issued.')}</p> : null}
    </div>
  </WorkspaceQueueCard>
  const status = selected?.data.admission.status
  const current = status === 'registered' ? 1 : status === 'admitted' ? 2 : status === 'discharge-pending' ? 3 : status === 'departed' ? 4 : status === 'cleared' ? 6 : -1
  const flow = inpatientFlow(undefined, locale).map((step, index) => ({ ...step, status: index === current ? 'current' as const : index < current ? 'completed' as const : 'pending' as const }))
  return <section aria-label={t('住院药房', 'Inpatient pharmacy')} className="clinmesh-inpatient-workspace flex min-h-0 min-w-0 flex-1 flex-col"><WorkspaceCardLayout id={`inpatient-pharmacy-${session.actor.practitionerRoleId}`} locale={locale} queue={queue} flow={flow} action={action}
    patient={selected ? <><section aria-label={t('当前住院患者', 'Current inpatient')}><InpatientPatientHeader name={selected.data.admission.patientName}
      status={selected.data.admission.status === 'discharge-pending' ? t('待出院', 'Pending discharge') : t('在院', 'Admitted')}
      statusVariant="info"
      details={<><InpatientNumber locale={locale} number={selected.data.admission.inpatientNumber} />{selected.order.verifiedAt ? <span>{t('校对时间 ', 'Verified ')}{formatShanghaiMinute(selected.order.verifiedAt).slice(5)}</span> : null}</>} /></section>
      {data ? <section aria-label={t('药物过敏提示', 'Medication allergies')} className="flex flex-wrap items-center gap-1.5 px-4 pb-2 text-xs">
        <Badge variant="outline">{t('药物过敏提示', 'Medication allergies')}</Badge>
        {data.medicationAllergies.length ? data.medicationAllergies.map(item => <Badge key={item.id} variant="destructive">{t('药物过敏 · ', 'Allergy · ')}{item.display}</Badge>) : allergyReady ? <span className="text-muted-foreground">{t('未记录有效药物过敏', 'No active medication allergies recorded')}</span> : null}
        {!allergyReady ? <span role="status" className="text-muted-foreground">{selectedRead?.isError ? t('药物过敏信息读取失败，请重试。', 'Medication allergies failed to load. Retry loading.') : t('正在读取药物过敏信息', 'Loading medication allergies')}</span> : null}
      </section> : null}</> : undefined}>
    {error ? <Alert variant="destructive"><AlertDescription>{t('住院药房读取或操作失败：', 'Inpatient pharmacy data or action failed: ')}{getWorkspaceErrorMessage(error, getWorkspaceMessages(locale))}<Button variant="outline" onClick={() => { void admissions.refetch(); void Promise.all(details.map(query => query.refetch())) }}>{t('重试读取', 'Retry loading')}</Button></AlertDescription></Alert> : null}
    <InpatientWriteRecovery write={write} locale={locale} />
    {!selected && !loading && !error ? <Empty><EmptyHeader><EmptyTitle>{shown.length > 0 ? t('从队列选择药品', 'Select a medication') : tab === 'dispensed' ? t('本页暂无已发记录', 'No dispensed records on this page') : pageCount > 1 ? t('本页暂无待发药品', 'No medications awaiting dispensing on this page') : t('暂无待发药品', 'No medications awaiting dispensing')}</EmptyTitle><EmptyDescription>{tab === 'dispensed' ? t('已发药品的记录可在这里查阅。', 'View dispensing records here.') : pending.length === 0 ? pageCount > 1 ? t('可翻页查看其他患者；本页已发药品由病区护士按时给药。', 'Browse other patient pages. The ward nurse administers medication already dispensed on this page.') : t('下一步：病区护士按时给药。', 'Next: the ward nurse administers medication at the scheduled time.') : t('核对护士已校对的药嘱、批次及数量后办理发药。', 'Review the verified order, lot and quantity before dispensing.')}</EmptyDescription></EmptyHeader></Empty> : selected ? <InpatientStageCard title={t('住院发药', 'Inpatient dispensing')}
      turn={selected.execution === undefined ? t('等下一次给药执行单生成', 'Waiting for the next medication execution to be scheduled') : selected.execution.status === 'pending' ? t('轮到你：核对批次和数量后发药', 'Your turn: check the lot and quantity, then dispense') : t('等病区护士按时给药', 'Waiting for the ward nurse to administer')}
      owners={<p className="text-xs">{t('护士校对', 'Nurse verification')} › <strong>{t('药师发药', 'Pharmacist dispensing')}</strong> › {t('护士给药', 'Nurse administration')}</p>}>
      <InpatientItemRow key={entryId(selected)} title={selected.order.display} badge={<div className="flex items-center gap-1.5"><Badge variant="outline">{selected.order.duration === 'long' ? t('长期', 'Long') : t('临时', 'Temporary')}</Badge><Badge variant={selected.execution === undefined || selected.execution.status === 'pending' ? 'warning' : 'success'}>{selected.execution === undefined ? t('待生成执行单', 'Awaiting execution schedule') : selected.execution.status === 'pending' ? t('待发药', 'Awaiting dispensing') : t('已发药', 'Dispensed')}</Badge></div>}
        metadata={<><span>{selected.order.doseText} · {selected.order.doseQuantity}{selected.order.unit} · {inpatientFrequencyLabel(selected.order.frequencyCode, locale, false)}</span>{selected.execution ? <span>{formatShanghaiMinute(selected.execution.scheduledFor).slice(5)}</span> : null}</>} complete={selected.execution !== undefined && selected.execution.status !== 'pending'}>
        {selected.execution === undefined ? <p>{t('护士已校对；执行单生成后可核对批次和数量并发药。', 'The nurse has verified the order. Check the lot and quantity once the execution is scheduled.')}</p> : selected.execution.status === 'pending' ? <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field><FieldLabel htmlFor={`inpatient-lot-${selected.execution.id}`}>{t('发药批次', 'Inventory lot')}</FieldLabel><WorkspaceSelect id={`inpatient-lot-${selected.execution.id}`} value={lot?.id ?? null} disabled={write.blocked || write.mutation.isPending}
              items={lots.map(item => ({ value: item.id, label: `${lotLabel(item.id)} · ${t('库存', 'Stock ')} ${item.quantityOnHand}${selected.order.unit} · ${t('有效期', 'Expires ')} ${item.expiresOn}${virtualNow !== undefined && Date.parse(item.expiresOn) - virtualNow <= NEAR_EXPIRY_DAYS * DAY_MS ? t(' · 临期批次', ' · Near expiry') : ''}` }))} onValueChange={value => { if (value) { setLotIds(current => ({ ...current, [entryId(selected)]: value })); setReview(undefined) } }} />
              <FieldDescription>{t('默认最早到期的批次', 'Defaults to the earliest-expiring lot')}</FieldDescription></Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t('本次发药数量', 'Quantity for this execution')}</span>
              <div className="flex h-9 items-center rounded-md border bg-muted/20 px-3 text-sm font-semibold tabular-nums">{selected.order.doseQuantity}{selected.order.unit}</div>
            </div>
          </div>
          {lot && lot.quantityOnHand < selected.order.doseQuantity ? <p role="alert">{t('本批次库存不足，请选择其他批次。', 'This lot has insufficient stock. Choose another lot.')}</p> : null}
        </> : data?.dispenses.filter(item => item.executionId === selected.execution?.id).map(item => <p key={item.id}>{lotLabel(item.lotId)} · {item.quantity}{selected.order.unit}</p>)}
      </InpatientItemRow>
    </InpatientStageCard> : null}
  </WorkspaceCardLayout></section>
}
