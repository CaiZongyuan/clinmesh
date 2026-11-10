import { getHisOperation, commandReceiptLookupSchema } from '@clinmesh/contracts/his-operations'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Field, FieldLabel, FieldSet, FieldLegend } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { ApiClientError, apiGet, apiMutation, getDoctorCase, getSession, newIdempotencyKey } from '../api-client.ts'
import { actionCommand, actionKey, actionScope, investigationActionChanged, loadActionDraft, requestSnapshot, saveActionDraft, unavailableAction,
  type ActionDraft, type ActionRow, type ActionScope, type InvestigationAction, type InvestigationKind, type InvestigationRequest,
  type OutpatientInvestigationActionContext } from './outpatient-investigation-action-store.ts'

const activeScopes = new Set<string>()
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
function useActionList(context: OutpatientInvestigationActionContext, kind: InvestigationKind, action: InvestigationAction) {
  const scope = actionScope(context, kind, action), key = actionKey(scope)
  const [state, setState] = useState(() => ({ key, ...read(scope) }))
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const current = useRef(key)
  current.current = key
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    const refresh = () => setState({ key, ...read(scope) })
    refresh()
    window.addEventListener(investigationActionChanged, refresh)
    return () => window.removeEventListener(investigationActionChanged, refresh)
  // The serialized key includes the complete scope.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const loaded = state.key === key ? state : read(scope)
  const draft = loaded.draft
  const notify = (value: string) => { if (mounted.current && current.current === key) setMessage(value) }
  const change = (update: (value: ActionDraft) => ActionDraft) => {
    try {
      const value = loadActionDraft(scope)
      if (activeScopes.has(key) || value.intent !== null) return
      saveActionDraft(update(value))
      notify('')
    } catch (error) {
      if (error instanceof ActionSelectionLimit) { notify('最多保留20项，请先移除不需要的项目'); return }
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
    if (activeScopes.has(key)) return
    activeScopes.add(key); setBusy(true)
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
    } catch {
      const latest = read(scope)
      if (latest.error) setState({ key, ...latest })
      notify(latest.error ? '无法读取或保存待处理清单，请恢复存储后重试' : '操作未完成；原结果待查明时请先恢复，余项需重新核对')
    } finally {
      activeScopes.delete(key)
      if (mounted.current && current.current === key) setBusy(false)
      window.dispatchEvent(new CustomEvent(investigationActionChanged))
    }
  }
  return { draft, error: loaded.error, message, busy: busy || activeScopes.has(key), change, run,
    reload: () => setState({ key, ...read(scope) }) }
}

export interface InvestigationActionRecord { request: InvestigationRequest; title: string; statusLabel: string }
export function OutpatientInvestigationActions({ context, kind, records, onSelectRequest, selectedRequestId, readOnly }: {
  context: OutpatientInvestigationActionContext
  kind: InvestigationKind
  records: InvestigationActionRecord[]
  onSelectRequest: (id: string) => void
  selectedRequestId?: string | undefined
  readOnly: boolean
}) {
  const cancel = useActionList(context, kind, 'cancel'), retry = useActionList(context, kind, 'retry')
  const [query, setQuery] = useState(''), [page, setPage] = useState(0)
  const [preview, setPreview] = useState<{ action: InvestigationAction; rows: ActionRow[] } | null>(null)
  const [discard, setDiscard] = useState<InvestigationAction | null>(null)
  const lists = { cancel, retry }, pending = cancel.busy || retry.busy || cancel.draft?.intent != null || retry.draft?.intent != null
  const blocked = pending || cancel.error || retry.error || readOnly
  const filtered = records.filter(item => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 10) - 1)), visible = filtered.slice(currentPage * 10, currentPage * 10 + 10)
  const scopeKey = JSON.stringify(actionScope(context, kind, 'cancel'))
  useEffect(() => { setPreview(null); setDiscard(null); setQuery(''); setPage(0) }, [scopeKey])
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
  return <section aria-label="申请列表" className="flex min-w-0 flex-col gap-3 rounded-lg border p-3">
    <h4 className="text-sm font-semibold">已开具 · {records.length} 份申请</h4>
    <Input aria-label="搜索申请" placeholder="搜索申请名称" value={query} onChange={event => { setQuery(event.target.value); setPage(0) }} />
    {(['cancel', 'retry'] as const).map(action => {
      const list = lists[action], label = action === 'cancel' ? '取消' : '重试'
      const rows = list.draft?.rows ?? [], selected = rows.filter(row => row.selected)
      return <FieldSet key={action}>
        <FieldLegend variant="label">{label}申请 · 待处理 {rows.length}/20 · 已选 {selected.length}</FieldLegend>
        <div className="flex flex-wrap gap-2">
          <Button disabled={blocked || selected.length === 0} onClick={() => setPreview({ action, rows: structuredClone(selected) })} size="sm">集中{label}申请</Button>
          <Button disabled={blocked} onClick={() => select(action, visible.filter(item => unavailableAction(item.request, action) === undefined), true)} size="sm" variant="outline">全选本页可{label}申请</Button>
          <Button disabled={blocked || selected.length === 0} onClick={() => list.change(value => ({ ...value, rows: value.rows.map(row => ({ ...row, selected: false })) }))} size="sm" variant="outline">清空{label}选择</Button>
          <Button disabled={blocked || rows.length === 0} onClick={() => setDiscard(action)} size="sm" variant="outline">丢弃{label}清单</Button>
        </div>
        {list.error ? <Alert variant="destructive"><AlertTitle>待处理清单存储不可用</AlertTitle><AlertDescription>无法核对原操作，已停止写入。<Button onClick={list.reload} size="sm" variant="outline">重新读取清单</Button></AlertDescription></Alert> : null}
        {list.message ? <p role="status" className="text-sm">{list.message}</p> : null}
        {list.draft?.intent == null ? null : <Alert><AlertTitle>原{label}结果待查明</AlertTitle><AlertDescription><Button disabled={readOnly || list.busy} onClick={() => void list.run(null)} size="sm">恢复原{label}</Button></AlertDescription></Alert>}
        {rows.length === 0 ? null : <section aria-label={`${label}申请完整待处理清单`} className="flex flex-col gap-2">
          {rows.map(row => <div key={row.revision} className="flex flex-wrap items-center gap-2">
            <Field orientation="horizontal"><Checkbox aria-label={`待处理${label}：${row.snapshot.title}`} checked={row.selected} disabled={blocked} onCheckedChange={checked => list.change(value => ({ ...value, rows: value.rows.map(item => item.revision === row.revision ? { ...item, selected: checked } : item) }))} /><FieldLabel>{row.snapshot.title}</FieldLabel></Field>
            {issue(row, action) ? <p className="text-sm text-destructive">{issue(row, action)}</p> : null}
            <Button disabled={blocked} onClick={() => list.change(value => ({ ...value, rows: value.rows.filter(item => item.revision !== row.revision) }))} size="sm" variant="ghost" aria-label={`移除${label}：${row.snapshot.title}`}>移除项目</Button>
            {issue(row, action) ? <Button disabled={blocked || !records.some(item => item.request.id === row.snapshot.id && unavailableAction(item.request, action) === undefined)} onClick={() => list.change(value => ({ ...value, rows: value.rows.map(item => item.revision !== row.revision ? item : { ...item, revision: newIdempotencyKey(), snapshot: requestSnapshot(records.find(record => record.request.id === row.snapshot.id)!.request, row.snapshot.title) }) }))} size="sm" variant="outline">重新核对本项</Button> : null}
          </div>)}
        </section>}
        {list.draft?.results.length ? <section aria-label={`${label}申请逐项结果`} className="flex flex-col gap-2" role="region">
          <p role="status">{list.busy ? '办理中' : list.draft.intent === null ? '本次办理已结束' : '已停止，原结果待查明'} · 成功 {list.draft.results.filter(item => item.status === 'success').length}/{list.draft.results.length}</p>
          {list.draft.results.map(item => <p key={item.revision}>{item.title}：{item.message}</p>)}
        </section> : null}
      </FieldSet>
    })}
    {visible.length === 0 ? <p className="text-sm text-muted-foreground">没有匹配的申请</p> : <ul className="flex flex-col gap-2">{visible.map(item => <li className="flex flex-col gap-2 rounded-lg border p-3" key={item.request.id}>
      <Button aria-label={`${item.title} ${item.statusLabel}`} aria-pressed={selectedRequestId === item.request.id} onClick={() => onSelectRequest(item.request.id)} size="sm" variant="ghost" className="h-auto min-w-0 justify-start whitespace-normal text-left">{item.title}<Badge variant="outline">{item.statusLabel}</Badge></Button>
      {(['cancel', 'retry'] as const).map(action => <Field orientation="horizontal" key={action}>
        <Checkbox aria-label={`选择${action === 'cancel' ? '取消' : '重试'}：${item.title}`} disabled={blocked || unavailableAction(item.request, action) !== undefined}
          checked={lists[action].draft?.rows.some(row => row.snapshot.id === item.request.id && row.selected) ?? false} onCheckedChange={checked => select(action, [item], checked)} />
        <FieldLabel>{action === 'cancel' ? '取消' : '重试'}<span className="text-xs text-muted-foreground">{unavailableAction(item.request, action)}</span></FieldLabel>
      </Field>)}
    </li>)}</ul>}
    <div className="flex items-center gap-2"><Button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} size="sm" variant="outline">上一页申请</Button><span>第 {currentPage + 1}/{Math.max(1, Math.ceil(filtered.length / 10))} 页 · 每页10项</span><Button disabled={(currentPage + 1) * 10 >= filtered.length} onClick={() => setPage(currentPage + 1)} size="sm" variant="outline">下一页申请</Button></div>
    <Dialog open={preview !== null} onOpenChange={open => { if (!open) setPreview(null) }}>
      <DialogContent><DialogHeader><DialogTitle>集中{preview?.action === 'retry' ? '重试' : '取消'}申请核对</DialogTitle><DialogDescription>{context.patientName} · 同患者同次就诊，逐项办理。{preview?.action === 'cancel' ? '取消不等于退款；退款须按原交易另行办理。未知资金须先查明，有效医保待遇须先撤销。' : '仅重试未取得结果且仍支持重试的申请。'}</DialogDescription></DialogHeader>
        <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto">{preview?.rows.map(row => <article key={row.revision}><strong>{row.snapshot.title}</strong><p>{row.snapshot.status} · {preview.action === 'cancel' ? '取消原因：不再需要' : '重试取得结果'}</p>{issue(row, preview.action) ? <p className="text-destructive">{issue(row, preview.action)}</p> : null}</article>)}</div>
        <Button disabled={blocked || preview === null || preview.rows.some(row => issue(row, preview.action) !== undefined)} onClick={() => { if (preview) { const plan = preview; setPreview(null); void lists[plan.action].run(plan.rows) } }}>确认{preview?.action === 'retry' ? '重试' : '取消'}申请</Button>
      </DialogContent>
    </Dialog>
    <Dialog open={discard !== null} onOpenChange={open => { if (!open) setDiscard(null) }}><DialogContent><DialogHeader><DialogTitle>确认丢弃待处理清单</DialogTitle><DialogDescription>将移除本动作的待处理项目；不会取消已开具申请，也不会删除正式记录。</DialogDescription></DialogHeader><Button disabled={blocked} onClick={() => { if (discard) lists[discard].change(value => ({ ...value, rows: [] })); setDiscard(null) }}>确认丢弃</Button></DialogContent></Dialog>
  </section>
}
