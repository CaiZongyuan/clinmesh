import { getHisOperation, commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldLabel, FieldSet, FieldLegend } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { ApiClientError, apiGet, apiMutation, getDoctorCase, getSession, newIdempotencyKey } from '../api-client.ts'
import type { WorkspaceLocale } from '../workspace-i18n.ts'
import { ActionDraftStorageError, actionCommand, actionKey, actionScope, discardActionDraft, investigationActionChanged, loadActionDraft, requestSnapshot, saveActionDraft, unavailableAction,
  type ActionDraft, type ActionRow, type ActionScope, type InvestigationAction, type InvestigationKind, type InvestigationRequest,
  type OutpatientInvestigationActionContext } from './outpatient-investigation-action-store.ts'

const activeScopes = new Set<string>()
const requestStatusLabels: Record<InvestigationRequest['status'], [string, string]> = {
  issued: ['已开具', 'Issued'], accepted: ['已受理', 'Accepted'], 'in-progress': ['检查中', 'In progress'],
  reported: ['已报告', 'Reported'], acknowledged: ['医生已阅', 'Acknowledged'],
  'generation-failed': ['未取得结果', 'No result'], cancelled: ['已取消', 'Cancelled'],
}
const actionLabels = {
  cancel: {
    label: ['取消', 'Cancel'], main: ['集中取消申请', 'Cancel selected requests'],
    select: ['选择取消：', 'Select cancellation: '], selectPage: ['全选本页可取消申请', 'Select eligible cancellations on this page'],
    clear: ['清空取消选择', 'Clear cancellation selection'], discard: ['丢弃取消清单', 'Discard cancellation list'],
    pending: ['取消申请完整待处理清单', 'Pending cancellations'], pendingItem: ['待处理取消：', 'Pending cancellation: '],
    remove: ['移除取消：', 'Remove cancellation: '], results: ['取消申请逐项结果', 'Cancellation results'],
    unknown: ['原取消结果待查明', 'Original cancellation result unknown'], recover: ['恢复原取消', 'Recover original cancellation'],
    preview: ['集中取消申请核对', 'Review request cancellations'], confirm: ['确认取消申请', 'Confirm cancellations'],
  },
  retry: {
    label: ['重试', 'Retry'], main: ['集中重试申请', 'Retry selected requests'],
    select: ['选择重试：', 'Select retry: '], selectPage: ['全选本页可重试申请', 'Select eligible retries on this page'],
    clear: ['清空重试选择', 'Clear retry selection'], discard: ['丢弃重试清单', 'Discard retry list'],
    pending: ['重试申请完整待处理清单', 'Pending retries'], pendingItem: ['待处理重试：', 'Pending retry: '],
    remove: ['移除重试：', 'Remove retry: '], results: ['重试申请逐项结果', 'Retry results'],
    unknown: ['原重试结果待查明', 'Original retry result unknown'], recover: ['恢复原重试', 'Recover original retry'],
    preview: ['集中重试申请核对', 'Review request retries'], confirm: ['确认重试申请', 'Confirm retries'],
  },
} satisfies Record<InvestigationAction, Record<string, [string, string]>>
// Persisted outcomes use these bounded canonical messages. Translate at display time so changing locale also translates restored lists.
const englishActionMessages: Readonly<Record<string, string>> = {
  '当前状态或关联费用不允许办理，请核对后重试': 'The current state or associated charges prevent this action. Review before retrying.',
  '当前岗位无权办理': 'Your current role cannot perform this action.',
  '申请已变化，请重新核对': 'The request has changed. Review it again.',
  '本项未完成，请重新核对': 'This item did not complete. Review it again.',
  '最多保留20项，请先移除不需要的项目': 'Keep at most 20 items. Remove unwanted items first.',
  '无法保存待处理清单，请恢复存储后重试': 'The pending list could not be saved. Restore storage before retrying.',
  '办理成功': 'Completed successfully',
  '原结果仍待查明，请再次恢复原操作': 'The original result is still unknown. Recover the original action again.',
  '当前就诊只读，未查到原回执；请保留原操作。': 'This encounter is read-only and the original receipt was not found. Keep the original attempt.',
  '原操作已查明，余项请重新核对后办理': 'The original action is resolved. Review the remaining items before continuing.',
  '待处理清单已变化，请重新核对': 'The pending list has changed. Review it again.',
  '尚未办理': 'Not yet processed',
  '患者或就诊状态已变化，请重新核对': 'The patient or encounter has changed. Review it again.',
  '申请已不存在': 'The request no longer exists.',
  '申请状态、费用或内容已变化，请重新核对': 'The request status, charges or content have changed. Review it again.',
  '结果待查明，后续项目已停止': 'The result is unknown. Subsequent items have stopped.',
  '请先恢复原操作，再重新核对余项': 'Recover the original action first, then review the remaining items.',
  '无法读取或保存待处理清单，请恢复存储后重试': 'The pending list could not be read or saved. Restore storage before retrying.',
  '操作未完成；原结果待查明时请先恢复，余项需重新核对': 'The action did not complete. Recover any unknown original result, then review the remaining items.',
  '仅未取得结果的申请可重试': 'Only requests without a result can be retried.',
  '当前项目不支持重试，请调整申请': 'This item does not support retry. Revise the request.',
  '仅未受理的申请可取消': 'Only requests that have not been accepted can be cancelled.',
  '费用结果待查明，请先恢复原资金操作': 'The financial result is unknown. Recover the original financial action first.',
  '请先撤销关联检查的有效医保待遇': 'Cancel the associated active insurance benefits first.',
}
function actionMessage(message: string | undefined, locale: WorkspaceLocale) {
  if (message === undefined) return ''
  return locale === 'zh-CN' ? message : Object.hasOwn(englishActionMessages, message) ? englishActionMessages[message] : 'Review this item before continuing.'
}
class ActionSelectionLimit extends Error {}
const proofSchema = z.object({ auditId: z.string().min(1), effects: z.array(z.object({ kind: z.string(), reference: z.string(), versionId: z.string() }).loose()),
  data: z.object({ request: z.object({ id: z.string(), version: z.number(), status: z.string(),
    serviceRequestId: z.string(), serviceRequestVersion: z.string(), taskId: z.string(), taskVersion: z.string() }).loose() }).loose() }).loose()
function read(scope: ActionScope) {
  try { return { draft: loadActionDraft(scope), error: false } }
  catch { return { draft: null, error: true } }
}
function sameSnapshot(row: ActionRow, request: InvestigationRequest | undefined) {
  return request !== undefined && JSON.stringify(row.snapshot) === JSON.stringify(requestSnapshot(request, row.snapshot.title))
}
function rejected(error: unknown) {
  return error instanceof ApiClientError && error.status >= 400 && error.status < 500
    && !['UNEXPECTED_RESPONSE', 'IDEMPOTENCY_KEY_REUSED'].includes(error.code)
}
function errorMessage(error: unknown) {
  if (error instanceof ApiClientError && error.code === 'WORKFLOW_CONFLICT') return '当前状态或关联费用不允许办理，请核对后重试'
  if (error instanceof ApiClientError && error.status === 403) return '当前岗位无权办理'
  if (error instanceof ApiClientError && error.status === 409) return '申请已变化，请重新核对'
  return '本项未完成，请重新核对'
}
function useActionList(context: OutpatientInvestigationActionContext, kind: InvestigationKind, action: InvestigationAction, readOnly: boolean) {
  const scope = actionScope(context, kind, action), key = actionKey(scope)
  const [state, setState] = useState(() => ({ key, ...read(scope) }))
  const [message, setMessage] = useState({ key, text: '' })
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const current = useRef(key)
  current.current = key
  const mounted = useRef(true)
  const currentReadOnly = useRef(readOnly)
  currentReadOnly.current = readOnly
  const failedStorage = useRef<string | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    const refresh = () => { const latest = read(scope); setState({ key, ...latest, error: latest.error || failedStorage.current === key }) }
    refresh()
    window.addEventListener(investigationActionChanged, refresh)
    return () => window.removeEventListener(investigationActionChanged, refresh)
  // The serialized key includes the complete scope.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const loaded = state.key === key ? state : read(scope)
  const draft = loaded.draft
  const notify = (value: string) => { if (mounted.current && current.current === key) setMessage({ key, text: value }) }
  const change = (update: (value: ActionDraft) => ActionDraft) => {
    try {
      const value = loadActionDraft(scope)
      if (activeScopes.has(key) || value.intent !== null) return
      saveActionDraft(update(value))
      notify('')
    } catch (error) {
      if (error instanceof ActionSelectionLimit) { notify('最多保留20项，请先移除不需要的项目'); return }
      failedStorage.current = key
      setState({ key, ...read(scope), error: true }); notify('无法保存待处理清单，请恢复存储后重试')
    }
  }
  const result = (value: ActionDraft, row: ActionRow, status: ActionDraft['results'][number]['status'], text: string) => ({
    ...value, results: value.results.map(item => item.revision === row.revision ? { ...item, status, message: text } : item),
  })
  const settle = (intent: NonNullable<ActionDraft['intent']>) => {
    const value = loadActionDraft(scope)
    if (value.intent?.key !== intent.key) throw new Error('Original attempt changed')
    // Settle the original revision before removing its recovery record. A failed cleanup can only repeat this settlement.
    const settled = result({ ...value, rows: value.rows.filter(row => row.revision !== intent.row.revision), intent: { ...intent, settled: true } }, intent.row, 'success', '办理成功')
    saveActionDraft(settled)
    saveActionDraft({ ...settled, intent: null })
  }
  const assertSession = async () => {
    const session = await getSession()
    if (session.user.id !== scope.accountId || JSON.stringify(session.actor) !== JSON.stringify(scope.actor)
      || current.current !== key || !mounted.current) throw new Error('办理上下文已切换，请回到原患者与岗位核对')
  }
  const send = async (intent: NonNullable<ActionDraft['intent']>) => {
    if (currentReadOnly.current) throw new Error('The current encounter is read-only')
    const operation = getHisOperation(intent.command.operation)
    const response = await apiMutation(operation.http.path.replace(':requestId', encodeURIComponent(intent.command.input.requestId)),
      operation.output, intent.command.body, { idempotencyKey: intent.key })
    verify(intent, response)
  }
  const verify = (intent: NonNullable<ActionDraft['intent']>, response: unknown) => {
    const parsed = proofSchema.parse(getHisOperation(intent.command.operation).output.parse(response))
    const original = intent.row.snapshot, request = parsed.data.request
    const taskVersion = String(BigInt(original.taskVersion) + 1n)
    const serviceRequestVersion = action === 'cancel' ? String(BigInt(original.serviceRequestVersion) + 1n) : original.serviceRequestVersion
    const effect = (reference: string, version: string) => parsed.effects.some(item => item.kind === 'updated' && item.reference === reference && item.versionId === version)
    if (request.id !== original.id || request.version !== original.version + 1 || request.status !== (action === 'cancel' ? 'cancelled' : 'in-progress')
      || request.taskId !== original.taskId || request.taskVersion !== taskVersion
      || request.serviceRequestId !== original.serviceRequestId || request.serviceRequestVersion !== serviceRequestVersion
      || !effect(`Task/${original.taskId}`, taskVersion)
      || (action === 'cancel' && !effect(`ServiceRequest/${original.serviceRequestId}`, serviceRequestVersion))) throw new Error('未取得匹配的原操作回执')
  }
  const run = async (plan: ActionRow[] | null) => {
    if (activeScopes.has(key) || plan !== null && currentReadOnly.current) return
    activeScopes.add(key); setBusyKey(key)
    try {
      let value = loadActionDraft(scope)
      await assertSession()
      if (plan === null) {
        const intent = value.intent
        if (intent === null) return
        if (intent.settled) { settle(intent); await context.onChanged(); return }
        // Receipt failures never become a definite command rejection. Only a missing receipt permits the original resend.
        let receipt
        try {
          receipt = await apiGet(`/api/his/v1/command-receipts?${new URLSearchParams({ operationId: intent.command.operation, idempotencyKey: intent.key })}`, commandReceiptLookupSchema)
        } catch (error) {
          if (!(error instanceof ApiClientError && error.code === 'COMMAND_RECEIPT_NOT_FOUND' && error.status === 404)) {
            notify('原结果仍待查明，请再次恢复原操作'); return
          }
        }
        if (receipt !== undefined) {
          if (receipt.operationId !== intent.command.operation || receipt.idempotencyKey !== intent.key || receipt.status !== 'completed') {
            notify('原结果仍待查明，请再次恢复原操作'); return
          }
          verify(intent, receipt.response)
        } else {
          if (currentReadOnly.current) { notify('当前就诊只读，未查到原回执；请保留原操作。'); return }
          await assertSession()
          try { await send(intent) }
          catch (error) {
            if (rejected(error)) {
              saveActionDraft(result({ ...loadActionDraft(scope), intent: null }, intent.row, 'rejected', errorMessage(error)))
              await context.onChanged(); return
            }
            throw error
          }
        }
        settle(intent)
        await context.onChanged()
        notify('原操作已查明，余项请重新核对后办理')
        return
      }
      if (value.intent !== null || plan.length === 0) return
      // Review owns a fixed set. Another mounted view cannot enlarge this submission.
      if (plan.some(row => !value.rows.some(item => item.revision === row.revision && item.selected && JSON.stringify(item.snapshot) === JSON.stringify(row.snapshot)))) {
        notify('待处理清单已变化，请重新核对'); return
      }
      value = { ...value, results: plan.map(row => ({ revision: row.revision, title: row.snapshot.title, status: 'waiting', message: '尚未办理' })) }
      saveActionDraft(value)
      for (const row of plan) {
        await assertSession()
        const detail = await getDoctorCase(scope.caseId)
        if (detail.patient.id !== scope.patientId || detail.encounter.id !== scope.encounterId || detail.encounter.status !== 'in-progress') {
          notify('患者或就诊状态已变化，请重新核对'); break
        }
        const requests = kind === 'laboratory' ? detail.laboratoryRequests?.requests : kind === 'imaging' ? detail.imagingRequests?.requests : detail.pathologyRequests?.requests
        const request = requests?.find(item => item.id === row.snapshot.id)
        const issue = request === undefined ? '申请已不存在' : unavailableAction(request, action)
        if (!sameSnapshot(row, request) || issue !== undefined) {
          saveActionDraft(result(loadActionDraft(scope), row, 'rejected', issue ?? '申请状态、费用或内容已变化，请重新核对'))
          continue
        }
        const intent = { row, command: actionCommand(scope, row), key: newIdempotencyKey(), settled: false }
        saveActionDraft({ ...loadActionDraft(scope), intent })
        try {
          await assertSession()
          await send(intent)
        } catch (error) {
          if (rejected(error)) {
            saveActionDraft(result({ ...loadActionDraft(scope), intent: null }, row, 'rejected', errorMessage(error)))
            await context.onChanged()
            continue
          }
          saveActionDraft(result(loadActionDraft(scope), row, 'unknown', '结果待查明，后续项目已停止'))
          notify('请先恢复原操作，再重新核对余项')
          break
        }
        settle(intent)
        await context.onChanged()
      }
    } catch (error) {
      const latest = read(scope)
      if (latest.error || error instanceof ActionDraftStorageError) { failedStorage.current = key; setState({ key, ...latest, error: true }) }
      notify(latest.error || error instanceof ActionDraftStorageError ? '无法读取或保存待处理清单，请恢复存储后重试' : '操作未完成；原结果待查明时请先恢复，余项需重新核对')
    } finally {
      activeScopes.delete(key)
      if (mounted.current && current.current === key) setBusyKey(null)
      window.dispatchEvent(new CustomEvent(investigationActionChanged))
    }
  }
  const discard = () => {
    if (!mounted.current || current.current !== key || activeScopes.has(key)) return false
    try {
      if (!discardActionDraft(scope)) { notify('请先恢复原操作，再重新核对余项'); return false }
      failedStorage.current = null
      setState({ key, ...read(scope) }); notify('')
      return true
    } catch {
      failedStorage.current = key
      setState({ key, ...read(scope), error: true }); notify('无法读取或保存待处理清单，请恢复存储后重试')
      return false
    }
  }
  return { draft, error: loaded.error, message: message.key === key ? message.text : '', busy: busyKey === key || activeScopes.has(key), change, run, discard,
    reload: () => { const latest = read(scope); if (!latest.error) failedStorage.current = null; setState({ key, ...latest }) } }
}

export interface InvestigationActionRecord { request: InvestigationRequest; title: string; statusLabel: string }
export function OutpatientInvestigationActions({ context, kind, locale, records, onSelectRequest, selectedRequestId, readOnly }: {
  context: OutpatientInvestigationActionContext
  kind: InvestigationKind
  locale: WorkspaceLocale
  records: InvestigationActionRecord[]
  onSelectRequest: (id: string) => void
  selectedRequestId?: string | undefined
  readOnly: boolean
}) {
  const zh = locale === 'zh-CN'
  const text = (value: readonly [string, string]) => value[zh ? 0 : 1]
  const cancel = useActionList(context, kind, 'cancel', readOnly), retry = useActionList(context, kind, 'retry', readOnly)
  const [query, setQuery] = useState(''), [page, setPage] = useState(0)
  const [filter, setFilter] = useState<'all' | 'unread' | 'progress'>('all')
  const [preview, setPreview] = useState<{ action: InvestigationAction; rows: ActionRow[] } | null>(null)
  const [discard, setDiscard] = useState<InvestigationAction | null>(null)
  const lists = { cancel, retry }, pending = cancel.busy || retry.busy || cancel.draft?.intent != null || retry.draft?.intent != null
  const blocked = pending || cancel.error || retry.error || readOnly
  const filtered = records.filter(item => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    && (filter === 'all' || (filter === 'unread' ? item.request.status === 'reported' : ['issued', 'accepted', 'in-progress'].includes(item.request.status))))
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 10) - 1)), visible = filtered.slice(currentPage * 10, currentPage * 10 + 10)
  const scopeKey = JSON.stringify(actionScope(context, kind, 'cancel'))
  useEffect(() => { setPreview(null); setDiscard(null); setQuery(''); setFilter('all'); setPage(0) }, [scopeKey])
  const select = (action: InvestigationAction, values: InvestigationActionRecord[], checked: boolean) => lists[action].change(value => {
    let rows = value.rows.map(row => values.some(item => item.request.id === row.snapshot.id) ? { ...row, selected: checked } : row)
    if (checked) for (const item of values) if (!rows.some(row => row.snapshot.id === item.request.id)) rows = [...rows, { revision: newIdempotencyKey(), snapshot: requestSnapshot(item.request, item.title), selected: true }]
    if (rows.length > 20) throw new ActionSelectionLimit()
    return { ...value, rows }
  })
  const issue = (row: ActionRow, action: InvestigationAction) => {
    const current = records.find(item => item.request.id === row.snapshot.id)?.request
    if (!sameSnapshot(row, current)) return '申请状态、费用或内容已变化，请重新核对'
    return current === undefined ? '申请已不存在' : unavailableAction(current, action)
  }
  return <section aria-label={text(['申请列表', 'Request list'])} className="flex min-w-0 flex-col gap-3 rounded-lg border p-3">
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <h4 className="text-sm font-semibold">{text(['已开具', 'Issued'])}</h4>
      <p className="text-xs text-muted-foreground">{zh ? `共 ${records.length} 份申请 · ${records.filter(item => item.request.status === 'reported').length} 份待阅`
        : `${records.length} requests · ${records.filter(item => item.request.status === 'reported').length} unread`}</p>
    </div>
    <Input aria-label={text(['搜索申请', 'Search requests'])} placeholder={text(['搜索申请名称', 'Search request names'])} value={query} onChange={event => { setQuery(event.target.value); setPage(0) }} />
    <ToggleGroup data-view-switch="" aria-label={text(['筛选申请', 'Filter requests'])} className="max-w-full flex-wrap" value={[filter]} size="sm" variant="outline"
      onValueChange={values => { const value = values[0]; if (value === 'all' || value === 'unread' || value === 'progress') { setFilter(value); setPage(0) } }}>
      <ToggleGroupItem value="all">{text(['全部', 'All'])}</ToggleGroupItem>
      <ToggleGroupItem value="unread">{text(['待阅', 'Unread'])}</ToggleGroupItem>
      <ToggleGroupItem value="progress">{text(['进行中', 'In progress'])}</ToggleGroupItem>
    </ToggleGroup>
    {(['cancel', 'retry'] as const).map(action => {
      const list = lists[action], copy = actionLabels[action]
      const rows = list.draft?.rows ?? [], selected = rows.filter(row => row.selected)
      return <FieldSet key={action}>
        <FieldLegend variant="label">{text(copy.label)}{text(['申请', ' requests'])} · {text(['待处理', 'Pending'])} {rows.length}/20 · {text(['已选', 'Selected'])} {selected.length}</FieldLegend>
        <div className="flex flex-wrap gap-2">
          <Button disabled={blocked || selected.length === 0} onClick={() => setPreview({ action, rows: structuredClone(selected) })} size="sm">{text(copy.main)}</Button>
          <Button disabled={blocked} onClick={() => select(action, visible.filter(item => unavailableAction(item.request, action) === undefined), true)} size="sm" variant="outline">{text(copy.selectPage)}</Button>
          <Button disabled={blocked || selected.length === 0} onClick={() => list.change(value => ({ ...value, rows: value.rows.map(row => ({ ...row, selected: false })) }))} size="sm" variant="outline">{text(copy.clear)}</Button>
          <Button disabled={pending || rows.length === 0 && !list.error} onClick={() => setDiscard(action)} size="sm" variant="outline">{text(copy.discard)}</Button>
        </div>
        {list.error ? <Alert variant="destructive"><AlertTitle>{text(['待处理清单存储不可用', 'Pending-list storage unavailable'])}</AlertTitle><AlertDescription>{text(['无法核对原操作，已停止写入。', 'The original action cannot be verified. Writes have stopped.'])}<Button onClick={list.reload} size="sm" variant="outline">{text(['重新读取清单', 'Reload pending list'])}</Button></AlertDescription></Alert> : null}
        {list.message ? <p role="status" className="text-sm">{actionMessage(list.message, locale)}</p> : null}
        {list.draft?.intent == null ? null : <Alert><AlertTitle>{text(copy.unknown)}</AlertTitle><AlertDescription><Button disabled={list.busy || list.error} onClick={() => void list.run(null)} size="sm">{text(copy.recover)}</Button></AlertDescription></Alert>}
        {rows.length === 0 ? null : <section aria-label={text(copy.pending)} className="flex flex-col gap-2">
          {rows.map(row => <div key={row.revision} className="flex flex-wrap items-center gap-2">
            <Field orientation="horizontal"><Checkbox aria-label={`${text(copy.pendingItem)}${row.snapshot.title}`} checked={row.selected} disabled={blocked} onCheckedChange={checked => list.change(value => ({ ...value, rows: value.rows.map(item => item.revision === row.revision ? { ...item, selected: checked } : item) }))} /><FieldLabel>{row.snapshot.title}</FieldLabel></Field>
            {issue(row, action) ? <p className="text-sm text-destructive">{actionMessage(issue(row, action), locale)}</p> : null}
            <Button disabled={blocked} onClick={() => list.change(value => ({ ...value, rows: value.rows.filter(item => item.revision !== row.revision) }))} size="sm" variant="ghost" aria-label={`${text(copy.remove)}${row.snapshot.title}`}>{text(['移除项目', 'Remove item'])}</Button>
            {issue(row, action) ? <Button disabled={blocked || !records.some(item => item.request.id === row.snapshot.id && unavailableAction(item.request, action) === undefined)} onClick={() => list.change(value => ({ ...value, rows: value.rows.map(item => item.revision !== row.revision ? item : { ...item, revision: newIdempotencyKey(), snapshot: requestSnapshot(records.find(record => record.request.id === row.snapshot.id)!.request, row.snapshot.title) }) }))} size="sm" variant="outline">{text(['重新核对本项', 'Review this item again'])}</Button> : null}
          </div>)}
        </section>}
        {list.draft?.results.length ? <section aria-label={text(copy.results)} className="flex flex-col gap-2" role="region">
          <p role="status">{list.busy ? text(['办理中', 'Processing']) : list.draft.intent === null ? text(['本次办理已结束', 'This attempt has finished']) : text(['已停止，原结果待查明', 'Stopped; the original result is unknown'])} · {text(['成功', 'Succeeded'])} {list.draft.results.filter(item => item.status === 'success').length}/{list.draft.results.length}</p>
          {list.draft.results.map(item => <p key={item.revision}>{item.title}{text(['：', ': '])}{actionMessage(item.message, locale)}</p>)}
        </section> : null}
      </FieldSet>
    })}
    {visible.length === 0 ? <Empty><EmptyHeader><EmptyTitle>{text(['没有匹配的申请', 'No matching requests'])}</EmptyTitle><EmptyDescription>{text(['搜索为空不会删除申请记录。', 'Searching does not delete request records.'])}</EmptyDescription></EmptyHeader>
      <Button onClick={() => { setQuery(''); setFilter('all'); setPage(0) }} size="sm" variant="outline">{text(['查看全部申请', 'Show all requests'])}</Button>
    </Empty> : <ul className="flex flex-col gap-2">{visible.map(item => <li className="flex flex-col gap-2 rounded-lg border p-3" key={item.request.id}>
      <Button aria-label={`${item.title} ${item.statusLabel}`} aria-pressed={selectedRequestId === item.request.id} onClick={() => onSelectRequest(item.request.id)} size="sm" variant="ghost" className="h-auto min-w-0 justify-start whitespace-normal text-left">{item.title}<Badge variant={item.request.status === 'reported' ? 'warning' : 'outline'}>{item.statusLabel}</Badge></Button>
      {(['cancel', 'retry'] as const).map(action => <Field orientation="horizontal" key={action}>
        <Checkbox aria-label={`${text(actionLabels[action].select)}${item.title}`} disabled={blocked || unavailableAction(item.request, action) !== undefined}
          checked={lists[action].draft?.rows.some(row => row.snapshot.id === item.request.id && row.selected) ?? false} onCheckedChange={checked => select(action, [item], checked)} />
        <FieldLabel>{text(actionLabels[action].label)}<span className="text-xs text-muted-foreground">{actionMessage(unavailableAction(item.request, action), locale)}</span></FieldLabel>
      </Field>)}
    </li>)}</ul>}
    <div className="flex items-center gap-2"><Button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} size="sm" variant="outline">{text(['上一页申请', 'Previous requests page'])}</Button><span>{text(['第 ', 'Page '])}{currentPage + 1}/{Math.max(1, Math.ceil(filtered.length / 10))}{text([' 页 · 每页10项', ' · 10 per page'])}</span><Button disabled={(currentPage + 1) * 10 >= filtered.length} onClick={() => setPage(currentPage + 1)} size="sm" variant="outline">{text(['下一页申请', 'Next requests page'])}</Button></div>
    <Dialog open={preview !== null} onOpenChange={open => { if (!open) setPreview(null) }}>
      <DialogContent><DialogHeader><DialogTitle>{text(actionLabels[preview?.action ?? 'cancel'].preview)}</DialogTitle><DialogDescription>{context.patientName}{text([' · 同患者同次就诊，逐项办理。', ' · Requests for this patient and encounter are processed individually. '])}{preview?.action === 'cancel' ? text(['取消不等于退款；退款须按原交易另行办理。未知资金须先查明，有效医保待遇须先撤销。', 'Cancellation does not issue a refund; refunds must be handled separately against the original transaction. Resolve unknown funds and cancel active insurance benefits first.']) : text(['仅重试未取得结果且仍支持重试的申请。', 'Only eligible requests without a result will be retried.'])}</DialogDescription></DialogHeader>
        <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto">{preview?.rows.map(row => <article key={row.revision}><strong>{row.snapshot.title}</strong><p>{text(requestStatusLabels[row.snapshot.status])} · {preview.action === 'cancel' ? text(['取消原因：不再需要', 'Reason: no longer needed']) : text(['重试取得结果', 'Retry to obtain a result'])}</p>{issue(row, preview.action) ? <p className="text-destructive">{actionMessage(issue(row, preview.action), locale)}</p> : null}</article>)}</div>
        <Button disabled={blocked || preview === null || preview.rows.some(row => issue(row, preview.action) !== undefined)} onClick={() => { if (preview) { const plan = preview; setPreview(null); void lists[plan.action].run(plan.rows) } }}>{text(actionLabels[preview?.action ?? 'cancel'].confirm)}</Button>
      </DialogContent>
    </Dialog>
    <Dialog open={discard !== null} onOpenChange={open => { if (!open) setDiscard(null) }}><DialogContent><DialogHeader><DialogTitle>{text(['确认丢弃待处理清单', 'Confirm discarding the pending list'])}</DialogTitle><DialogDescription>{text(['将移除本动作的待处理项目；不会取消已开具申请，也不会删除正式记录。', 'This removes pending items for this action. It does not cancel issued requests or delete clinical records.'])}</DialogDescription></DialogHeader><Button disabled={pending} onClick={() => { if (discard && lists[discard].discard()) setDiscard(null) }}>{text(['确认丢弃', 'Confirm discard'])}</Button></DialogContent></Dialog>
  </section>
}
