import type { PharmacyQueueItem, SessionContext } from '@clinmesh/contracts/his'
import { agentToolInputSchemas, parseAgentToolInput, type AgentOperationId } from '@clinmesh/contracts/agent'
import { z } from 'zod'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlertIcon, PackageCheckIcon, PillIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { dispensePrescription, getPharmacyQueue, newIdempotencyKey, reviewPrescription } from './api-client.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { PaginationControls } from './pagination-controls.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import { formatFen } from './workspace-format.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { agentViewRevision, useRegisterAgentPage } from './agent-page-context.tsx'
import { useAgentReview, useAgentReviewPending } from './agent-review.tsx'
import { WorkspaceModeSwitch } from './workspace-mode.tsx'
import { AgentDraftField, WorkspaceActionBar, WorkspaceCard, WorkspaceCardLayout, WorkspacePatientCard, WorkspaceQueueCard, useWorkspaceCardView, announceHandoff } from './workspace-card-layout.tsx'
import { outpatientFlow } from './workspace-flow.ts'
import type { SurfaceAgentPageAction } from './surface-agent-tools.ts'

interface PharmacyWorkspaceProps { locale: WorkspaceLocale; session: SessionContext }
type PharmacyStatus = 'completed' | 'pending'
type PharmacyDraft = { note: string; lots: Record<string, string>; quantities: Record<string, string>; assisted: Record<string, boolean> }
const emptyDraft: PharmacyDraft = { note: '', lots: {}, quantities: {}, assisted: {} }
type PreparedBase = { namespace: string; draftKey: string; draft: PharmacyDraft; patientName: string; prescriptionNumber: string; idempotencyKey: string; workspaceId: string; epoch: string }
type ReviewCommand = PreparedBase & { kind: 'review'; input: Parameters<typeof reviewPrescription>[0] }
type DispenseCommand = PreparedBase & { kind: 'dispense'; input: Parameters<typeof dispensePrescription>[0]; rows: Array<{ name: string; lot: string; expiresOn: string; quantity: number }> }
type PharmacyCommand = ReviewCommand | DispenseCommand

function pharmacyNamespace(session: SessionContext): string {
  return JSON.stringify([session.user.id, ...(['actorId', 'workspaceId', 'epoch', 'scenarioRunId', 'practitionerRoleId',
    'roleCode', 'organizationId', 'locationId', 'practitionerId'] as const).map(key => session.actor[key])])
}
function parameters(operation: AgentOperationId): SurfaceAgentPageAction['parameters'] {
  const json = z.toJSONSchema(agentToolInputSchemas[operation])
  return { type: 'object', properties: json.properties ?? {}, required: json.required ?? [], additionalProperties: false }
}

export function PharmacyWorkspace({ locale, session }: PharmacyWorkspaceProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale), t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const agentReview = useAgentReview(), agentPending = useAgentReviewPending(), queryClient = useQueryClient()
  const namespace = pharmacyNamespace(session), scope = [session.actor.workspaceId, session.actor.epoch, namespace]
  const view = useWorkspaceCardView(`pharmacy:${namespace}`), status: PharmacyStatus = view.tab === 'completed' ? 'completed' : 'pending'
  const [selection, setSelection] = useState<{ namespace: string; page: number; id?: string }>({ namespace, page: 1 })
  const page = selection.namespace === namespace ? selection.page : 1
  const selectedId = selection.namespace === namespace ? selection.id : undefined
  const [drafts, setDrafts] = useState<Record<string, PharmacyDraft>>({})
  const [manual, setManual] = useState<PharmacyCommand>()
  const queue = useQuery({ queryKey: ['pharmacy-queue', ...scope, status, page], enabled: session.actor.roleCode === 'pharmacist',
    queryFn: ({ signal }) => getPharmacyQueue(status, signal, page) })
  const lastPendingPage = Math.max(1, Math.ceil((queue.data?.total ?? 0) / (queue.data?.pageSize ?? 20)))
  const earlierPendingPage = Math.min(page, lastPendingPage)
  const hasEarlierPendingPage = status === 'pending' && queue.isSuccess && queue.data.total > 0
    && queue.data.items.length === 0 && page > lastPendingPage
  const earlierPendingQueue = useQuery({ queryKey: ['pharmacy-queue', ...scope, 'pending', earlierPendingPage],
    enabled: hasEarlierPendingPage,
    queryFn: ({ signal }) => getPharmacyQueue('pending', signal, earlierPendingPage) })
  const selectedInQueue = selectedId === undefined ? queue.data?.items[0] : queue.data?.items.find(item => item.prescriptionId === selectedId)
  const selectedPrescription = selectedInQueue
  const draftKey = selectedPrescription === undefined ? undefined : JSON.stringify([namespace, selectedPrescription.prescriptionId])
  const draft = draftKey === undefined ? emptyDraft : drafts[draftKey] ?? emptyDraft
  const selectedLotIds = draft.lots, dispenseQuantities = draft.quantities, reviewNote = draft.note
  const latest = useRef({ namespace, selectedId: selectedPrescription?.prescriptionId, status, page, draft, pending: false })
  useLayoutEffect(() => { latest.current = { namespace, selectedId: selectedPrescription?.prescriptionId, status, page, draft, pending: busy } })
  useEffect(() => () => agentReview.cancel('当前岗位或处方已变化，请重新准备。'), [agentReview, namespace, selectedPrescription?.prescriptionId, status, page])
  useLayoutEffect(() => { setManual(current => current?.draftKey === draftKey ? current : undefined) }, [draftKey])
  const updateDraft = (change: (current: PharmacyDraft) => PharmacyDraft) => {
    if (draftKey === undefined) return
    setDrafts(current => ({ ...current, [draftKey]: change(current[draftKey] ?? emptyDraft) }))
  }
  const assertPage = () => {
    if (latest.current.namespace !== namespace || latest.current.selectedId !== selectedPrescription?.prescriptionId || latest.current.status !== status || latest.current.page !== page) {
      throw new Error(t('当前岗位或处方已变化，请重新准备。', 'The current role or prescription changed. Prepare the action again.'))
    }
  }
  const assertBinding = (command: PharmacyCommand) => {
    if (latest.current.namespace !== command.namespace || latest.current.selectedId !== command.input.prescriptionId || latest.current.status !== 'pending') {
      throw new Error(t('当前岗位或处方已变化，请重新准备。', 'The current role or prescription changed. Prepare the action again.'))
    }
  }
  const afterSuccess = async (command: PharmacyCommand) => {
    if (command.kind === 'review') announceHandoff(t('审核完成', 'Review complete'), t('处方可以继续发药', 'The prescription is ready for dispensing'))
    else announceHandoff(t('发药完成', 'Dispensing complete'), t('已登记发药，处方流程结束', 'Dispensing is recorded and the prescription is closed'))
    setDrafts(current => {
      if ((current[command.draftKey] ?? emptyDraft) !== command.draft) return current
      return { ...current, [command.draftKey]: command.kind === 'review'
        ? { ...command.draft, note: '', assisted: { ...command.draft.assisted, note: false } } : emptyDraft }
    })
    setManual(current => current === command ? undefined : current)
    if (latest.current.namespace === command.namespace && latest.current.selectedId === command.input.prescriptionId) {
      setSelection(current => ({ namespace: command.namespace, page: current.namespace === command.namespace ? current.page : 1, id: command.input.prescriptionId }))
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['pharmacy-queue', command.workspaceId, command.epoch] }),
      queryClient.invalidateQueries({ queryKey: ['scenario-current', command.workspaceId, command.epoch] }),
    ])
  }
  const review = useMutation({ mutationFn: (command: ReviewCommand) => {
    assertBinding(command)
    return reviewPrescription(command.input, command.idempotencyKey)
  }, onSuccess: (_result, command) => afterSuccess(command) })
  const dispense = useMutation({ mutationFn: (command: DispenseCommand) => {
    assertBinding(command)
    return dispensePrescription(command.input, command.idempotencyKey)
  }, onSuccess: (_result, command) => afterSuccess(command) })
  const busy = review.isPending || dispense.isPending
  const canReview = status === 'pending' && selectedPrescription?.status === 'awaiting-review' && reviewNote.trim() !== ''
  const canDispense = status === 'pending' && selectedPrescription?.review !== undefined && hasValidDispense(selectedPrescription, selectedLotIds, dispenseQuantities)
  const prepare = (kind: 'review' | 'dispense'): PharmacyCommand => {
    assertPage()
    if (!selectedPrescription || !draftKey || latest.current.draft !== draft
      || status !== 'pending' || busy || latest.current.pending || manual || agentPending || session.actor.roleCode !== 'pharmacist') throw new Error(messages.pharmacyUnavailable)
    const item = selectedPrescription
    const common = { namespace, draftKey, draft, patientName: item.patient.name, prescriptionNumber: item.prescriptionNumber,
      idempotencyKey: newIdempotencyKey(), workspaceId: session.actor.workspaceId, epoch: session.actor.epoch }
    const input = { encounterId: item.encounterId, encounterVersion: item.encounterVersion, prescriptionId: item.prescriptionId,
      prescriptionVersion: item.prescriptionVersion, medications: item.medications.map(medication => ({ medicationRequestId: medication.medicationRequestId,
        medicationRequestVersion: medication.medicationRequestVersion })) }
    if (kind === 'review') {
      if (!canReview) throw new Error(messages.pharmacyUnavailable)
      return { ...common, kind, input: { ...input, note: reviewNote.trim() } }
    }
    if (!canDispense) throw new Error(messages.inventoryUnavailable)
    const rows = item.medications.filter(medication => medication.remainingQuantity > 0).map(medication => {
      const lot = selectedLot(medication, selectedLotIds[medication.medicationRequestId])!
      return { name: locale === 'zh-CN' ? medication.nameZh : medication.nameEn, lot: lot.lotNumber, expiresOn: lot.expiresOn,
        lotId: lot.id, expectedVersion: lot.version, quantity: Number(dispenseQuantities[medication.medicationRequestId] ?? medication.remainingQuantity) }
    })
    return { ...common, kind, input: { ...input, lotSelections: rows.map(({ lotId, expectedVersion, quantity }) => ({ lotId, expectedVersion, quantity })) }, rows }
  }
  const commit = (command: PharmacyCommand) => command.kind === 'review' ? review.mutateAsync(command) : dispense.mutateAsync(command)
  const changeStatus = (value: PharmacyStatus) => { dispense.reset(); view.setTab(value); setSelection({ namespace, page: 1 }); setManual(undefined) }
  const selectPrescription = (id: string) => { setSelection({ namespace, page, id }); setManual(undefined) }
  const requestReview = (kind: 'review' | 'dispense', signal: AbortSignal) => {
    const command = prepare(kind)
    return agentReview.request({ signal, title: activeLocale => kind === 'review' ? getWorkspaceMessages(activeLocale).prescriptionReview : getWorkspaceMessages(activeLocale).dispenseReview,
      confirmLabel: activeLocale => kind === 'review' ? getWorkspaceMessages(activeLocale).approvePrescription : getWorkspaceMessages(activeLocale).confirmDispense,
      description: `${command.patientName} · ${command.prescriptionNumber}`,
      content: activeLocale => <PreparedSummary command={command} locale={activeLocale} />, onConfirm: () => commit(command) })
  }
  useRegisterAgentPage({ label: t('门诊药房', 'Outpatient pharmacy'),
    claim: { version: 1, viewId: 'pharmacy', activeSection: status,
      viewRevision: agentViewRevision({ namespace, page, status, selectedPrescription, draft }),
      ...(selectedPrescription ? { selection: { kind: 'prescription', id: selectedPrescription.prescriptionId, version: String(selectedPrescription.prescriptionVersion) },
        draft: { kind: selectedPrescription.status === 'awaiting-review' ? 'pharmacy-review' : 'dispense', id: `${selectedPrescription.prescriptionId}:pharmacy`,
          dirty: reviewNote !== '' || Object.keys(selectedLotIds).length > 0 || Object.keys(dispenseQuantities).length > 0, revision: agentViewRevision(draft) } } : {}),
      ui: { status: queue.isPending ? 'loading' : queue.isError ? 'error' : queue.data?.items.length ? 'ready' : 'empty' } },
    readState: () => ({ namespace, dispenseQuantities, selectedLotIds, reviewNote, queueCount: queue.data?.total ?? 0, status,
      selectedPrescription: selectedPrescription ? { patientName: selectedPrescription.patient.name, prescriptionId: selectedPrescription.prescriptionId,
        prescriptionNumber: selectedPrescription.prescriptionNumber, status: selectedPrescription.status } : null }),
    actions: {
      'pharmacy.queue.read': { description: 'Read the current authorized pharmacy queue page.', parameters: parameters('pharmacy.queue.read'),
        execute(raw, signal) { parseAgentToolInput('pharmacy.queue.read', raw); assertPage(); return getPharmacyQueue(status, signal, page) } },
      'pharmacy.prescription.select': { description: 'Select one prescription from the current pharmacy queue.', parameters: parameters('pharmacy.prescription.select'), enabled: !busy && !!queue.data?.items.length,
        execute(raw) { const { prescriptionId } = parseAgentToolInput('pharmacy.prescription.select', raw)
          assertPage(); if (!queue.data?.items.some(item => item.prescriptionId === prescriptionId)) throw new Error(messages.pharmacyUnavailable)
          selectPrescription(prescriptionId); return { prescriptionId, selected: true } } },
      'pharmacy.review.draft.set': { description: 'Fill the pharmacist review note without approving the prescription.', parameters: parameters('pharmacy.review.draft.set'), enabled: !busy && selectedPrescription?.status === 'awaiting-review',
        execute(raw) { const { note } = parseAgentToolInput('pharmacy.review.draft.set', raw)
          assertPage(); if (!selectedPrescription || selectedPrescription.status !== 'awaiting-review') throw new Error(messages.pharmacyUnavailable)
          updateDraft(current => ({ ...current, note, assisted: { ...current.assisted, note: true } })); return { updated: true } } },
      'pharmacy.dispense.draft.set': { description: 'Fill lot and quantity selections without dispensing medication.', parameters: parameters('pharmacy.dispense.draft.set'), enabled: !busy && status === 'pending' && selectedPrescription?.review !== undefined,
        execute(raw) { const { selections } = parseAgentToolInput('pharmacy.dispense.draft.set', raw)
          assertPage(); if (!selectedPrescription || !selectedPrescription.review) throw new Error(messages.pharmacyUnavailable)
          const lots: Record<string, string> = {}, quantities: Record<string, string> = {}, assisted: Record<string, boolean> = {}
          for (const selection of selections) { const medication = selectedPrescription.medications.find(item => item.medicationRequestId === selection.medicationRequestId)
            if (!medication || !medication.lots.some(lot => lot.id === selection.lotId)) throw new Error(messages.inventoryUnavailable)
            lots[selection.medicationRequestId] = selection.lotId; quantities[selection.medicationRequestId] = String(selection.quantity)
            assisted[`lot:${selection.medicationRequestId}`] = true; assisted[`quantity:${selection.medicationRequestId}`] = true }
          updateDraft(current => ({ ...current, lots: { ...current.lots, ...lots }, quantities: { ...current.quantities, ...quantities }, assisted: { ...current.assisted, ...assisted } })); return { updated: true } } },
      'pharmacy.review.propose': { description: 'Prepare human review for formal pharmacist approval.', parameters: parameters('pharmacy.review.propose'), enabled: canReview && !busy && !manual && !agentPending,
        execute(raw, signal) { parseAgentToolInput('pharmacy.review.propose', raw); return requestReview('review', signal) } },
      'pharmacy.dispense.propose': { description: 'Prepare human review for formal medication dispense.', parameters: parameters('pharmacy.dispense.propose'), enabled: canDispense && !busy && !manual && !agentPending,
        execute(raw, signal) { parseAgentToolInput('pharmacy.dispense.propose', raw); return requestReview('dispense', signal) } },
    },
  })
  const trigger = useRef<HTMLButtonElement>(null), confirm = useRef<HTMLButtonElement>(null), previousManual = useRef<PharmacyCommand | undefined>(undefined)
  const currentManual = manual?.draftKey === draftKey ? manual : undefined
  useLayoutEffect(() => {
    if (currentManual) {
      if (!busy) confirm.current?.focus()
      previousManual.current = currentManual
    } else if (!busy && previousManual.current) {
      if (previousManual.current.draftKey === draftKey) trigger.current?.focus({ preventScroll: true })
      previousManual.current = undefined
    }
  }, [currentManual, busy, draftKey])
  useEffect(() => {
    const root = confirm.current?.getRootNode()
    if (!currentManual || busy || !root) return
    const cancel = (event: Event) => {
      if (!(event instanceof KeyboardEvent) || event.key !== 'Escape' || event.defaultPrevented || latest.current.pending) return
      event.preventDefault()
      setManual(undefined)
    }
    root.addEventListener('keydown', cancel)
    return () => root.removeEventListener('keydown', cancel)
  }, [currentManual, busy])
  const currentError = review.variables?.draftKey === draftKey && review.error || dispense.variables?.draftKey === draftKey && dispense.error
  const completed = dispense.isSuccess && dispense.variables.namespace === namespace ? { ...dispense.data.data, patientName: dispense.variables.patientName } : undefined
  // 发完的处方离开待发队列后，操作栏提供下一位待处理的患者。
  const nextPrescription = status !== 'pending' ? undefined : queue.data?.items[0]
    ?? (hasEarlierPendingPage && earlierPendingQueue.isSuccess && !earlierPendingQueue.isFetching ? earlierPendingQueue.data.items[0] : undefined)
  const nextPrescriptionPage = hasEarlierPendingPage ? earlierPendingPage : page
  const selectNextPrescription = () => {
    if (!nextPrescription) return
    dispense.reset(); setManual(undefined)
    setSelection({ namespace, page: nextPrescriptionPage, id: nextPrescription.prescriptionId })
  }
  let nextReason: ReactNode = t('请刷新待发队列后继续。', 'Refresh the pending queue to continue.')
  if (status !== 'pending') nextReason = t('已发药处方仅供回查。', 'Completed prescriptions are read only.')
  else if (nextPrescription) nextReason = t('核对发药结果后可继续下一位。', 'Review the result before continuing to the next patient.')
  else if (hasEarlierPendingPage && earlierPendingQueue.isError) nextReason = <><p>{t('下一位处方暂时无法读取，当前发药结果已保留。', 'The next prescription is unavailable. This dispense result is preserved.')}</p><Button variant="outline" onClick={() => void earlierPendingQueue.refetch()}>{t('重试读取下一位', 'Retry next prescription')}</Button></>
  else if (hasEarlierPendingPage && (earlierPendingQueue.isPending || earlierPendingQueue.isFetching)) nextReason = t('正在读取其他页的待发处方。', 'Loading pending prescriptions from the earlier page.')
  else if (queue.isSuccess && queue.data.total === 0) nextReason = t('待发队列已清空。', 'No pending prescriptions.')
  const primaryKind = selectedPrescription?.status === 'awaiting-review' ? 'review' : 'dispense'
  const canPrepare = primaryKind === 'review' ? canReview : canDispense
  const beginManual = () => { review.reset(); dispense.reset(); setManual(prepare(primaryKind)) }
  const queuePanel = <WorkspaceQueueCard title={messages.pharmacyQueue} actions={<Button size="sm" variant="ghost" disabled={queue.isFetching} onClick={() => void queue.refetch()}>{t('刷新', 'Refresh')}</Button>}>
    <div className="flex flex-col gap-3"><WorkspaceModeSwitch presentation="select" />
      <Tabs value={status} onValueChange={value => { if (!busy && (value === 'pending' || value === 'completed')) changeStatus(value) }}><TabsList className="w-full">
        <TabsTrigger disabled={busy} value="pending">{messages.pendingDispense}</TabsTrigger><TabsTrigger disabled={busy} value="completed">{messages.completedDispense}</TabsTrigger>
      </TabsList></Tabs>
      <p className="text-sm text-muted-foreground">{queue.data?.total ?? '—'} {t('张处方', 'prescriptions')}</p>
      {queue.isPending ? <Skeleton className="h-36 w-full" /> : queue.isError ? <PharmacyError message={getWorkspaceErrorMessage(queue.error, messages)} title={messages.pharmacyUnavailable} />
        : !queue.data.items.length ? <p className="text-sm text-muted-foreground">{status === 'pending' ? queue.data.total > 0 ? t('本页处方已处理完，其他页仍有待发处方。', 'This page is complete. Other pages still contain pending prescriptions.') : t('暂无待发处方；缴费后的处方会进入这里。', 'Paid prescriptions appear here when ready.') : t('暂无已发药处方。', 'No dispensed prescriptions yet.')}</p>
          : <div data-workspace-queue-items role="list">{queue.data.items.map(item => <PrescriptionRow key={item.prescriptionId} item={item} messages={messages} selected={item.prescriptionId === selectedPrescription?.prescriptionId} onSelect={() => { if (!busy) { dispense.reset(); selectPrescription(item.prescriptionId) } }} />)}</div>}
      {queue.data === undefined || queue.data.total === 0 ? null : hasEarlierPendingPage
        ? <Button disabled={busy} variant="outline" onClick={() => { dispense.reset(); setManual(undefined); setSelection({ namespace, page: earlierPendingPage }) }}>{t('查看其他待发处方', 'View other pending prescriptions')}</Button>
        : <PaginationControls messages={messages} page={queue.data.page} pageSize={queue.data.pageSize} total={queue.data.total} onPageChange={nextPage => { if (!busy) { dispense.reset(); setSelection({ namespace, page: nextPage }); setManual(undefined) } }} />}
    </div>
  </WorkspaceQueueCard>
  const patient = selectedPrescription ? <WorkspacePatientCard title={selectedPrescription.patient.name} description={selectedPrescription.prescriptionNumber} actions={<Badge variant="outline">{messages.paid}</Badge>}>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground"><span>{selectedPrescription.encounterStatus === 'completed' ? t('就诊已完成', 'Visit completed') : selectedPrescription.encounterStatus === 'in-progress' ? t('诊疗中', 'In progress') : selectedPrescription.encounterStatus ?? t('未记录', 'Not recorded')}</span><details><summary className="cursor-pointer">{t('查看开方记录', 'View prescription source')}</summary><span className="text-xs">{t('医生已开具并完成收费', 'Issued by the doctor and paid')}</span></details></div>
    <p role="note" aria-label={messages.allergyWarnings} className="mt-2 text-sm wrap-anywhere"><span className="font-medium">{messages.allergyWarnings}：</span><span className={selectedPrescription.allergyWarnings.length ? 'font-medium text-destructive' : 'font-medium'}>{selectedPrescription.allergyWarnings.length ? selectedPrescription.allergyWarnings.map(item => item.display).join('；') : messages.noAllergyWarnings}</span><span className="ml-2 text-muted-foreground">{t('请药师核对过敏信息；此提示不阻止审核或发药。', 'Review allergy information. This warning does not prevent review or dispensing.')}</span></p>
  </WorkspacePatientCard> : completed ? <WorkspacePatientCard title={completed.patientName} description={dispense.variables?.prescriptionNumber}
    actions={<Badge variant="outline">{completed.status === 'partial' ? messages.dispensePartiallyCompleted : messages.dispenseCompleted}</Badge>}>{null}</WorkspacePatientCard> : undefined
  const action = currentManual ? <WorkspaceActionBar tone="confirm" summary={`${currentManual.patientName} · ${currentManual.prescriptionNumber}`}
    busy={busy ? currentManual.kind === 'review' ? t('正在审核处方', 'Approving prescription') : t('正在发药', 'Dispensing') : undefined}
    reason={<><PreparedSummary command={currentManual} locale={locale} /><p>{currentManual.kind === 'review' ? t('确认后记录审核意见，随后可办理发药。', 'Confirmation records this review and allows dispensing.') : t('确认后按以上批次扣减库存并登记发药；剩余数量继续待发。', 'Confirmation deducts this stock and records dispensing; any remainder stays pending.')}</p></>}
    action={<><Button disabled={busy} variant="outline" onClick={() => setManual(undefined)}>{t('取消', 'Cancel')}</Button><Button ref={confirm} disabled={busy} onClick={() => { void commit(currentManual).catch(() => undefined) }}>{currentManual.kind === 'review' ? messages.approvePrescription : messages.confirmDispense}</Button></>} />
    : selectedPrescription && status === 'pending' && selectedPrescription.status !== 'completed' ? <WorkspaceActionBar tone={canPrepare ? 'normal' : 'blocked'} summary={selectedPrescription.prescriptionNumber}
      reason={primaryKind === 'review' ? reviewNote.trim() ? t('先核对本次审核意见，再确认通过。', 'Review this note before approving.') : t('还差：填写审核意见。', 'Enter the review note.')
        : canDispense ? t('核对批次、有效期和数量；确认后扣减库存，可部分发药。', 'Check the lot, expiry and quantity. Confirmation deducts stock; partial dispensing is allowed.') : t('请核对可用批次、库存和本次发放数量。', 'Check available lots, stock and quantities.')}
      action={<Button ref={trigger} disabled={busy || !canPrepare || agentPending} onClick={beginManual}>{primaryKind === 'review' ? t('审核处方', 'Review prescription') : t('审阅发药', 'Review dispensing')}</Button>} />
      : completed ? <WorkspaceActionBar tone="complete" summary={`${completed.patientName} · ${completed.status === 'partial' ? messages.dispensePartiallyCompleted : messages.dispenseCompleted}`}
        reason={nextReason}
        action={<Button disabled={nextPrescription === undefined} onClick={selectNextPrescription}>{nextPrescription ? t(`下一位：${nextPrescription.patient.name}`, `Next: ${nextPrescription.patient.name}`) : t('下一位', 'Next patient')}</Button>} /> : undefined
  const dispensingCompleted = selectedPrescription?.status === 'completed'
    || selectedPrescription === undefined && completed?.status === 'completed'
  const flow = outpatientFlow(locale, dispensingCompleted ? { pharmacy: 'completed' } : selectedPrescription ? { pharmacy: 'current' } : {})
  return <WorkspaceCardLayout id={`pharmacy:${namespace}`} locale={locale} queue={queuePanel} patient={patient} action={action} flow={flow}>
    {queue.error ? <Button variant="outline" onClick={() => void queue.refetch()}>{t('重试发药队列', 'Retry pharmacy queue')}</Button> : null}
    {currentError ? <PharmacyError message={getWorkspaceErrorMessage(currentError, messages)} title={getWorkspaceErrorTitle(currentError, messages, messages.operationFailed)} /> : null}
    {review.isSuccess && review.variables.namespace === namespace && review.variables.input.prescriptionId === selectedPrescription?.prescriptionId && selectedPrescription.review === undefined
      ? <p role="status" className="flex flex-wrap gap-x-3 gap-y-1 text-sm"><span className="font-medium">{messages.prescriptionReviewed}</span><span className="wrap-anywhere text-muted-foreground">{review.variables.input.note}</span></p> : null}
    {completed ? <Alert><PackageCheckIcon aria-hidden="true" /><AlertTitle>{completed.patientName} · {completed.status === 'partial' ? messages.dispensePartiallyCompleted : messages.dispenseCompleted}</AlertTitle><AlertDescription><p>{completed.scenarioStatus === 'completed' ? messages.scenarioRunCompleted : messages.scenarioRunActive}</p><p>{t('本次发药', 'This dispense')}</p>{dispense.variables ? <PreparedSummary command={dispense.variables} locale={locale} /> : null}</AlertDescription></Alert> : null}
    {selectedPrescription ? <><WorkspaceCard title={messages.prescriptionDetails}><PrescriptionDetails item={selectedPrescription} locale={locale} messages={messages} selectedLotIds={selectedLotIds} dispenseQuantities={dispenseQuantities}
      assisted={draft.assisted} disabled={busy || status !== 'pending'}
      onLotChange={(id, value) => updateDraft(current => ({ ...current, lots: { ...current.lots, [id]: value }, assisted: { ...current.assisted, [`lot:${id}`]: false } }))}
      onQuantityChange={(id, value) => updateDraft(current => ({ ...current, quantities: { ...current.quantities, [id]: value }, assisted: { ...current.assisted, [`quantity:${id}`]: false } }))} /></WorkspaceCard>
      {selectedPrescription.status === 'awaiting-review' && status === 'pending' ? <WorkspaceCard title={messages.prescriptionReview}><AgentDraftField locale={locale} assisted={draft.assisted.note === true}>
        <Field><FieldLabel htmlFor="prescription-review-note">{messages.reviewNote}</FieldLabel><Textarea id="prescription-review-note" disabled={busy} required maxLength={500} value={reviewNote} onChange={event => { const note = event.currentTarget.value; updateDraft(current => ({ ...current, note, assisted: { ...current.assisted, note: false } })) }} /></Field>
      </AgentDraftField></WorkspaceCard> : null}</> : completed ? null : <WorkspaceCard><Empty className="min-h-40"><EmptyHeader><EmptyMedia variant="icon"><PillIcon aria-hidden="true" /></EmptyMedia><EmptyTitle>{t('请选择处方', 'Select a prescription')}</EmptyTitle><EmptyDescription>{t('从队列选择处方后核对审核与发药信息。', 'Select a prescription to review and dispense.')}</EmptyDescription></EmptyHeader></Empty></WorkspaceCard>}
  </WorkspaceCardLayout>
}

function PreparedSummary({ command, locale }: { command: PharmacyCommand; locale: WorkspaceLocale }) {
  return command.kind === 'review' ? <p className="break-words">{command.input.note}</p> : <ul className="flex flex-col gap-1">
    {command.rows.map((row, index) => <li key={index}>{row.name} · {row.lot} · {locale === 'zh-CN' ? '有效期至' : 'Expires'} {row.expiresOn} · {locale === 'zh-CN' ? '本次' : 'Quantity'} {row.quantity}</li>)}
  </ul>
}

function PrescriptionRow({ item, messages, onSelect, selected }: {
  item: PharmacyQueueItem
  messages: ReturnType<typeof getWorkspaceMessages>
  onSelect: () => void
  selected: boolean
}): React.JSX.Element {
  return (
    <div role="listitem"><Button
      aria-label={`${messages.selectPrescription} ${item.patient.name}`}
      data-agent-selection={item.prescriptionId}
      className="h-auto min-h-16 w-full justify-between gap-3 px-3 py-2 text-left"
      onClick={onSelect}
      type="button"
      variant={selected ? 'secondary' : 'outline'}
    >
      <span className="min-w-0">
        <span className="block truncate font-medium">{item.patient.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{item.prescriptionNumber}</span>
      </span>
      <Badge variant={item.status === 'completed' ? 'secondary' : 'outline'}>
        {item.status === 'completed'
          ? messages.completedDispense
          : item.status === 'partially-dispensed'
            ? messages.partialDispense
            : item.status === 'awaiting-review'
              ? messages.awaitingReview
              : messages.awaitingDispense}
      </Badge>
    </Button></div>
  )
}

function PrescriptionDetails({
  dispenseQuantities,
  item,
  locale,
  messages,
  onLotChange,
  onQuantityChange,
  selectedLotIds,
  assisted,
  disabled,
}: {
  dispenseQuantities: Record<string, string>
  item: PharmacyQueueItem
  locale: WorkspaceLocale
  messages: ReturnType<typeof getWorkspaceMessages>
  onLotChange: (medicationRequestId: string, lotId: string) => void
  onQuantityChange: (medicationRequestId: string, quantity: string) => void
  selectedLotIds: Record<string, string>
  assisted: Record<string, boolean>
  disabled: boolean
}): React.JSX.Element {
  const reviewedAt = item.review ? new Date(item.review.reviewedAt) : undefined
  const reviewTime = reviewedAt && Number.isFinite(reviewedAt.getTime()) ? reviewedAt.toLocaleString(locale, { timeZone: 'Asia/Shanghai' }) : item.review?.reviewedAt
  const editable = item.status !== 'completed' && item.review !== undefined
  return <div className="flex min-w-0 flex-col gap-3">
    {item.review === undefined ? null : <div role="status" aria-label={locale === 'zh-CN' ? '处方审核结论' : 'Prescription review outcome'} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
      <span className="font-medium">{messages.prescriptionReviewed}</span>
      <time className="text-muted-foreground" dateTime={item.review.reviewedAt}>{reviewTime}</time>
      <span className="wrap-anywhere text-muted-foreground">{item.review.note}</span>
    </div>}
    <Table className="table-fixed [&_th]:whitespace-normal [&_th]:px-1 [&_td]:align-top [&_td]:whitespace-normal [&_td]:break-words [&_td]:px-1">
      <TableHeader><TableRow>
        <TableHead className={editable ? 'w-[30%]' : 'w-[60%]'}>{messages.medication}</TableHead>
        <TableHead className={editable ? 'w-[18%]' : undefined}>{messages.quantity}</TableHead>
        {editable ? <><TableHead className="w-[34%]">{messages.inventoryLot}</TableHead><TableHead>{messages.dispenseQuantity}</TableHead></> : null}
      </TableRow></TableHeader>
      <TableBody>{item.medications.map(medication => {
        const name = locale === 'zh-CN' ? medication.nameZh : medication.nameEn
        const lot = selectedLot(medication, selectedLotIds[medication.medicationRequestId])
        const quantity = dispenseQuantities[medication.medicationRequestId] ?? String(medication.remainingQuantity)
        const error = lot && medication.remainingQuantity > 0 ? dispenseQuantityError(medication, lot, quantity, locale) : undefined
        const lotItems = medication.lots.map(option => ({
          label: <span className="min-w-0 whitespace-normal wrap-anywhere">{option.lotNumber} · {messages.inventoryOnHand} {option.quantityOnHand} · {messages.expiresOn} {option.expiresOn}</span>,
          value: option.id,
        }))
        return <TableRow key={medication.medicationRequestId}>
          <TableCell><span className="font-medium">{name}</span><span className="mt-1 block text-xs text-muted-foreground">{medication.doseText} · {medication.frequencyCode}</span><span className="mt-1 block text-xs text-muted-foreground">{messages.unitPrice} {formatFen(medication.unitPriceFen, locale)}</span></TableCell>
          <TableCell><dl className="flex flex-col gap-1 text-xs">
            <div><dt className="inline text-muted-foreground">{messages.quantity} </dt><dd className="inline tabular-nums">{medication.quantity}</dd></div>
            <div><dt className="inline text-muted-foreground">{messages.dispensedQuantity} </dt><dd className="inline tabular-nums">{medication.dispensedQuantity}</dd></div>
            <div><dt className="inline text-muted-foreground">{messages.remainingQuantity} </dt><dd className="inline tabular-nums">{medication.remainingQuantity}</dd></div>
          </dl></TableCell>
          {editable ? <>
            <TableCell><AgentDraftField locale={locale} assisted={assisted[`lot:${medication.medicationRequestId}`] === true}>
              <Field className="[&_[data-slot=select-trigger]]:h-auto [&_[data-slot=select-trigger]]:min-h-8 [&_[data-slot=select-trigger]]:min-w-0 [&_[data-slot=select-trigger]]:whitespace-normal [&_[data-slot=select-value]]:line-clamp-none [&_[data-slot=select-value]]:min-w-0">
                {lot === undefined ? <p role="alert" className="text-sm text-destructive">{messages.inventoryUnavailable}</p> : null}
                {lotItems.length ? <WorkspaceSelect ariaLabel={`${messages.inventoryLot} · ${name}`} disabled={disabled || medication.remainingQuantity === 0} id={`lot-${medication.medicationRequestId}`} items={lotItems} value={lot?.id ?? null}
                  onValueChange={value => { if (value !== null) onLotChange(medication.medicationRequestId, value) }} /> : null}
              </Field>
            </AgentDraftField></TableCell>
            <TableCell>{medication.remainingQuantity > 0 && lot ? <AgentDraftField locale={locale} assisted={assisted[`quantity:${medication.medicationRequestId}`] === true}><Field data-invalid={!!error}>
              <Input aria-label={`${messages.dispenseQuantity} · ${name}`} disabled={disabled} aria-invalid={!!error} aria-describedby={error ? `quantity-error-${medication.medicationRequestId}` : undefined}
                id={`dispense-quantity-${medication.medicationRequestId}`} max={Math.min(medication.remainingQuantity, lot.quantityOnHand)} min="1" required type="number" value={quantity}
                onChange={event => onQuantityChange(medication.medicationRequestId, event.currentTarget.value)} />
              {error ? <p role="alert" id={`quantity-error-${medication.medicationRequestId}`} className="text-sm text-destructive">{error}</p> : null}
            </Field></AgentDraftField> : null}</TableCell>
          </> : null}
        </TableRow>
      })}</TableBody>
    </Table>
    {item.status !== 'completed' && item.review === undefined ? <p className="text-sm text-muted-foreground">{locale === 'zh-CN' ? '审核通过后选择批次与本次发放数量。' : 'Approve the prescription before selecting lots and quantities.'}</p> : null}
  </div>
}

function selectedLot(
  medication: PharmacyQueueItem['medications'][number],
  selectedId: string | undefined,
) {
  return selectedId === undefined ? medication.lots[0] : medication.lots.find(lot => lot.id === selectedId)
}

function dispenseQuantityError(medication: PharmacyQueueItem['medications'][number], lot: PharmacyQueueItem['medications'][number]['lots'][number], raw: string, locale: WorkspaceLocale): string | undefined {
  const quantity = Number(raw), t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  if (!Number.isSafeInteger(quantity) || quantity <= 0) return t('请填写大于零的整数数量。', 'Enter a positive whole quantity.')
  if (quantity > lot.quantityOnHand) return t(`库存仅剩 ${lot.quantityOnHand}，请减少数量或选择其他批次。`, `Only ${lot.quantityOnHand} remain in this lot. Reduce the quantity or select another lot.`)
  if (quantity > medication.remainingQuantity) return t(`尚需发放 ${medication.remainingQuantity}，请核对本次数量。`, `${medication.remainingQuantity} remain to dispense. Check this quantity.`)
  return undefined
}

function hasValidDispense(
  item: PharmacyQueueItem,
  selectedLotIds: Record<string, string>,
  dispenseQuantities: Record<string, string>,
): boolean {
  const remaining = item.medications.filter(medication => medication.remainingQuantity > 0)
  return remaining.length > 0 && remaining.every(medication => {
    const lot = selectedLot(medication, selectedLotIds[medication.medicationRequestId])
    const quantity = Number(
      dispenseQuantities[medication.medicationRequestId] ?? medication.remainingQuantity,
    )
    return lot !== undefined
      && Number.isSafeInteger(quantity)
      && quantity > 0
      && quantity <= medication.remainingQuantity
      && quantity <= lot.quantityOnHand
  })
}

function PharmacyError({ message, title }: { message: string; title: string }): React.JSX.Element {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
