import { useEffect, useId, useRef, useState } from 'react'
import type { z } from 'zod'
import type { inpatientInvestigationCatalogSchema } from '@clinmesh/contracts/inpatient-investigations'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@clinmesh/ui/components/alert-dialog'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Spinner } from '@clinmesh/ui/components/spinner'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { OrderCatalogCandidate, OrderComposerFooter, OrderComposerLayout, OrderComposerSearch } from './doctor/order-composer-layout.tsx'
import { indicationLabel } from './doctor/laboratory-page.tsx'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { ApiClientError, newIdempotencyKey } from './api-client.ts'
import { InpatientCommandRejection, OriginalContinuationUnreadable } from './inpatient-write-intent.ts'
import { subscribeIssueDraftSettlement } from './inpatient-issue-draft-settlement.ts'
import { getBatchFailureMessage } from './workspace-error.ts'
import { investigationBatchLimit, investigationDraftSchema, readInvestigationDraft, saveInvestigationDraft, type InvestigationAttempt, type InvestigationDraft, type InvestigationDraftRow } from './inpatient-investigation-drafts.ts'

type CatalogItem = z.infer<typeof inpatientInvestigationCatalogSchema>['items'][number]
const emptyDraft = (): InvestigationDraft => ({ rows: [], successes: [] })

export function InpatientInvestigationComposer({ open, onOpenChange, items, locale, disabled, disabledReason, loading, error, onReload, draftKey, admissionId, encounterVersion, onIssue, onRecover }: {
  open: boolean; onOpenChange(open: boolean): void; items: readonly CatalogItem[]; locale: WorkspaceLocale
  disabled: boolean; disabledReason?: string | undefined; loading: boolean; error?: string | undefined; onReload(): void
  draftKey: string; admissionId: string; encounterVersion: string
  onIssue(attempt: InvestigationAttempt, isCurrent: () => boolean): Promise<unknown>; onRecover(attempt: InvestigationAttempt, isCurrent: () => boolean): Promise<unknown>
}) {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en, messages = getWorkspaceMessages(locale), formId = useId()
  const [loaded] = useState(() => {
    try {
      const draft = readInvestigationDraft(draftKey)
      if (draft.rows.some(row => row.attempt && row.attempt.input.admissionId !== admissionId)) throw new Error('Draft admission mismatch')
      return { draft, error: false }
    }
    catch { return { draft: emptyDraft(), error: true } }
  })
  const [draft, setDraft] = useState(loaded.draft), current = useRef(draft)
  const [storageError, setStorageError] = useState(loaded.error), [running, setRunning] = useState(false), busy = useRef(false)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => subscribeIssueDraftSettlement(draftKey, () => {
    try {
      const next = readInvestigationDraft(draftKey)
      if (next.rows.some(row => row.attempt && row.attempt.input.admissionId !== admissionId)) throw new Error('Draft admission mismatch')
      current.current = next; setDraft(next); setStorageError(false)
    } catch { setStorageError(true) }
  }), [draftKey, admissionId])
  const [query, setQuery] = useState(''), [kind, setKind] = useState<'laboratory' | 'imaging'>('laboratory'), [page, setPage] = useState(1), [draftPage, setDraftPage] = useState(1)
  const [showUnavailable, setShowUnavailable] = useState(false), [confirmClear, setConfirmClear] = useState(false), [notice, setNotice] = useState('')
  const save = (next: InvestigationDraft) => {
    try {
      const valid = investigationDraftSchema.parse(next)
      saveInvestigationDraft(draftKey, valid); current.current = valid; setDraft(valid); setStorageError(false)
      return true
    } catch { setStorageError(true); return false }
  }
  const update = (id: string, patch: Partial<InvestigationDraftRow>) => save({ ...current.current, rows: current.current.rows.map(row => row.id === id ? { ...row, ...patch } : row) })
  const locked = disabled || running || storageError || draft.rows.some(row => row.attempt)
  const text = query.trim().toLowerCase(), matches = items.filter(item => item.kind === kind && (text === '' || item.display.toLowerCase().includes(text) || item.id.toLowerCase().includes(text)))
  const available = matches.filter(item => item.available), unavailable = matches.filter(item => !item.available), pageSize = 10
  const catalogPage = Math.min(page, Math.max(1, Math.ceil(available.length / pageSize))), visible = available.slice((catalogPage - 1) * pageSize, catalogPage * pageSize)
  const rows = draft.rows.filter(row => row.item.kind === kind), rowPage = Math.min(draftPage, Math.max(1, Math.ceil(rows.length / pageSize))), visibleRows = rows.slice((rowPage - 1) * pageSize, rowPage * pageSize)
  const selected = rows.filter(row => row.selected && !row.attempt)
  const problem = (row: InvestigationDraftRow) => {
    const latest = items.find(item => item.kind === row.item.kind && item.id === row.item.id)
    if (!latest?.available) return t('该项目当前不可开立', 'This item is currently unavailable')
    if (latest.version !== row.item.version || latest.priceFen !== row.item.priceFen) return t('目录或价格已变化，请移除后重新选择', 'Catalog or price changed; remove and select again')
    if (row.item.kind === 'imaging') return row.indication.trim().length < 2 ? t('请填写检查指征（至少 2 字）', 'Enter a clinical indication (at least 2 characters)') : undefined
    return !latest.indicationCodes.includes(row.indicationCode) ? t('请选择有效检验适应证', 'Choose a valid laboratory indication') : undefined
  }
  const add = (item: CatalogItem) => {
    if (locked || draft.rows.some(row => row.item.kind === item.kind && row.item.id === item.id)) return
    if (draft.rows.length >= investigationBatchLimit) { setNotice(t(`最多保留 ${investigationBatchLimit} 项，请先办理或移除项目`, `Keep at most ${investigationBatchLimit} items; process or remove an item first`)); return }
    save({ ...current.current, rows: [...current.current.rows, { id: newIdempotencyKey(), item, indicationCode: item.indicationCodes.length === 1 ? item.indicationCodes[0]! : '', indication: '', selected: true }] })
    setDraftPage(Math.ceil((rows.length + 1) / pageSize)); setNotice('')
  }
  const run = async (recover?: InvestigationDraftRow) => {
    if (busy.current || storageError || (recover === undefined && (locked || loading || error !== undefined || selected.length === 0 || selected.some(problem)))) return
    busy.current = true; setRunning(true); setNotice('')
    try {
      for (const row of recover ? [recover] : selected) {
        if (!active.current) break
        const attempt: InvestigationAttempt = row.attempt ?? { idempotencyKey: newIdempotencyKey(), input: { admissionId, encounterVersion, catalogVersion: row.item.version,
          selection: row.item.kind === 'imaging' ? { kind: 'imaging', serviceId: row.item.id, indication: row.indication.trim() } : { kind: 'laboratory', catalogItemId: row.item.id, indicationCode: row.indicationCode } } }
        if (!update(row.id, { attempt, error: undefined })) break
        try {
          await (recover ? onRecover(attempt, () => active.current) : onIssue(attempt, () => active.current))
          if (!active.current) break
        } catch (cause) {
          const definite = cause instanceof InpatientCommandRejection
          if (!active.current || cause instanceof OriginalContinuationUnreadable
            || cause instanceof ApiClientError && cause.code === 'INPATIENT_INTENT_STORAGE_UNAVAILABLE') break
          if (!definite) update(row.id, { attempt, error: cause instanceof ApiClientError
            ? { status: cause.status, code: cause.code } : { status: 0, code: '' } })
          if (definite && cause.code === 'INPATIENT_INVESTIGATION_CATALOG_CONFLICT') { onReload(); break }
          if (!definite) break
        }
      }
    } finally { busy.current = false; setRunning(false) }
  }
  if (!open) return null
  const kindName = kind === 'laboratory' ? t('检验', 'laboratory') : t('检查', 'imaging')
  return <>
    <Dialog open={open} pending={running} onOpenChange={next => { if (!busy.current) onOpenChange(next) }}>
      <DialogContent className="flex h-[min(760px,calc(100svh-2.5rem))] flex-col sm:max-w-5xl" showCloseButton={!running}>
        <DialogHeader><DialogTitle>{t('开立住院检查', 'Order inpatient investigation')}</DialogTitle>
          <DialogDescription>{t(`同类项目连续添加、逐项核对后集中开立；待开清单最多 ${investigationBatchLimit} 项，关闭后保留。开立后仍须护士送检。`, `Add and review items of one category, then issue together. Drafts keep up to ${investigationBatchLimit} items after closing; nurse dispatch is still required.`)}</DialogDescription></DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ToggleGroup data-view-switch="" aria-label={t('检查类别', 'Investigation category')} size="sm" variant="outline" disabled={running} value={[kind]} onValueChange={values => {
            const next = values[0]
            if (next === 'laboratory' || next === 'imaging') { setKind(next); setPage(1); setDraftPage(1); setQuery('') }
          }}>
            <ToggleGroupItem value="laboratory">{t('检验', 'Laboratory')}</ToggleGroupItem>
            <ToggleGroupItem value="imaging">{t('检查', 'Imaging')}</ToggleGroupItem>
          </ToggleGroup>
          <Button size="sm" variant="outline" disabled={running || loading} onClick={onReload}>{t('刷新目录', 'Refresh catalog')}</Button>
        </div>
        <OrderComposerLayout locale={locale} catalog={<div className="flex min-h-0 flex-1 flex-col">
          <OrderComposerSearch><Input aria-label={t('搜索检查检验目录', 'Search investigations')} value={query} maxLength={200} onChange={event => { setQuery(event.currentTarget.value); setPage(1) }} /></OrderComposerSearch>
          <ul data-catalog-results="" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1 pb-2">
            {loading ? <li role="status">{t('正在加载目录…', 'Loading catalog…')}</li> : error !== undefined ? <li><p>{error}</p><Button onClick={onReload}>{t('重试加载', 'Retry loading')}</Button></li> : <>
              {visible.map(item => <li key={item.id}><OrderCatalogCandidate label={t(`选择${item.display}`, `Select ${item.display}`)} selected={draft.rows.some(row => row.item.id === item.id && row.item.kind === item.kind)} disabled={locked} onSelect={() => add(item)}>
                <span className="font-medium">{item.display}</span><span className="text-xs tabular-nums text-muted-foreground">{item.priceFen === undefined ? '—' : formatFen(item.priceFen, locale)}</span>
              </OrderCatalogCandidate></li>)}
              {available.length === 0 ? <li className="p-3 text-sm text-muted-foreground">{t('没有匹配的可开立项目', 'No matching orderable items')}</li> : null}
              {unavailable.length > 0 ? <li className="p-3 text-sm"><span>{t(`另有 ${unavailable.length} 项暂不能开立`, `${unavailable.length} unavailable items`)}</span><Button variant="link" size="sm" aria-expanded={showUnavailable} onClick={() => setShowUnavailable(value => !value)}>{showUnavailable ? t('收起原因', 'Hide reasons') : t('查看原因', 'Show reasons')}</Button>
                {showUnavailable ? unavailable.map(item => <p key={item.id}>{item.display} · {item.unavailableReason === 'unpriced' ? t('未声明住院价格', 'No inpatient price') : t('本院尚未开展', 'Not offered')}</p>) : null}</li> : null}
            </>}
          </ul>
          <div className="flex items-center justify-between gap-2 p-2 text-xs"><Button size="sm" variant="outline" disabled={catalogPage === 1} onClick={() => setPage(catalogPage - 1)}>{t('上一页', 'Previous')}</Button><span>{catalogPage} / {Math.max(1, Math.ceil(available.length / pageSize))}</span><Button size="sm" variant="outline" disabled={catalogPage * pageSize >= available.length} onClick={() => setPage(catalogPage + 1)}>{t('下一页', 'Next')}</Button></div>
        </div>}>
          <div className="flex min-w-0 flex-col gap-3">
            <p className="text-sm font-medium">{t(`待开 ${draft.rows.length} 项 · 本类已选 ${selected.length} 项`, `${draft.rows.length} draft items · ${selected.length} selected in this category`)}</p>
            <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={locked || loading || error !== undefined} onClick={() => save({ ...current.current, rows: current.current.rows.map(row => visibleRows.some(item => item.id === row.id) && !row.attempt && problem(row) === undefined ? { ...row, selected: true } : row) })}>{t('全选本页可办理项目', 'Select eligible items on this page')}</Button>
              <Button size="sm" variant="outline" disabled={locked} onClick={() => save({ ...current.current, rows: current.current.rows.map(row => row.item.kind === kind ? { ...row, selected: false } : row) })}>{t('清空选择', 'Clear selection')}</Button>
              <Button size="sm" variant="outline" disabled={running || draft.rows.some(row => row.attempt)} onClick={() => setConfirmClear(true)}>{t('清空待开清单', 'Discard drafts')}</Button></div>
            <p className="text-xs text-muted-foreground">{t(`完整已选清单：${selected.map(row => row.item.display).join('、') || '未选择'}`, `All selected: ${selected.map(row => row.item.display).join(', ') || 'None'}`)}</p>
            {visibleRows.map(row => <section key={row.id} aria-label={t(`待开：${row.item.display}`, `Draft: ${row.item.display}`)} className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
              <div className="flex items-start gap-2"><Checkbox aria-label={t(`选择待开${row.item.display}`, `Select draft ${row.item.display}`)} checked={row.selected} disabled={locked || !!row.attempt} onCheckedChange={selected => update(row.id, { selected })} /><strong className="min-w-0 flex-1 text-sm wrap-anywhere">{row.item.display}</strong>
                <Button variant="ghost" size="sm" disabled={locked || !!row.attempt} onClick={() => save({ ...current.current, rows: current.current.rows.filter(item => item.id !== row.id) })}>{t('移除项目', 'Remove item')}</Button></div>
              <span className="text-xs text-muted-foreground"><span>{t('住院价格', 'Inpatient price')}</span> · {row.item.priceFen === undefined ? '—' : formatFen(row.item.priceFen, locale)}</span>
              <Field><FieldLabel htmlFor={`${formId}-${row.id}`}>{row.item.kind === 'imaging' ? t('检查指征', 'Clinical indication') : messages.laboratoryIndication}</FieldLabel>
                {row.item.kind === 'imaging' ? <Input id={`${formId}-${row.id}`} disabled={locked || !!row.attempt} value={row.indication} maxLength={500} onChange={event => update(row.id, { indication: event.currentTarget.value, error: undefined })} />
                  : row.item.indicationCodes.length === 1 ? <div id={`${formId}-${row.id}`} className="flex h-8 items-center rounded-md border px-2.5 text-sm">{indicationLabel(row.item.indicationCodes[0]!, messages)}</div>
                    : <WorkspaceSelect id={`${formId}-${row.id}`} disabled={locked || !!row.attempt} value={row.indicationCode || null} onValueChange={value => update(row.id, { indicationCode: value ?? '', error: undefined })} items={row.item.indicationCodes.map(code => ({ value: code, label: indicationLabel(code, messages) }))} />}</Field>
              {!loading && error === undefined && problem(row) ? <p className="text-xs text-destructive">{problem(row)}</p> : null}
              {row.error ? <p role="alert" className="text-xs text-destructive">{typeof row.error === 'string' && zh ? row.error : <>
                  {getBatchFailureMessage(typeof row.error === 'string' ? undefined : row.error, locale)} · {row.attempt
                    ? t('结果待确认，请恢复原操作', 'Result unconfirmed; recover the original operation')
                    : t('请核对信息后重试', 'Review before retrying')}
                </>}</p> : null}
              {row.attempt ? <Button size="sm" disabled={running} onClick={() => void run(row)}>{t(`恢复原开立：${row.item.display}`, `Recover original order: ${row.item.display}`)}</Button> : null}
            </section>)}
            {rows.length > pageSize ? <div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={rowPage === 1} onClick={() => setDraftPage(rowPage - 1)}>{t('待开上一页', 'Previous drafts')}</Button><span>{rowPage} / {Math.ceil(rows.length / pageSize)}</span><Button variant="outline" size="sm" disabled={rowPage * pageSize >= rows.length} onClick={() => setDraftPage(rowPage + 1)}>{t('待开下一页', 'Next drafts')}</Button></div> : null}
            {draft.rows.length === 0 ? <p className="text-sm text-muted-foreground">{t('暂无待开项目，请从目录连续添加', 'No draft items; add items from the catalog')}</p> : null}
            {draft.successes.length > 0 ? <div role="status" className="text-sm"><p>{t(`已成功开立 ${draft.successes.length} 项`, `${draft.successes.length} items issued successfully`)}</p>{draft.successes.map(result => <p key={result.id}>{result.display} · {t('已开立，待送检', 'Issued, awaiting dispatch')}</p>)}</div> : null}
          </div>
        </OrderComposerLayout>
        {storageError || notice ? <Alert variant="destructive"><AlertDescription>{storageError ? t('待开清单无法保存或读取，已停止开立。请确认后清空待开清单再试。', 'Draft storage unavailable; ordering stopped. Confirm discarding drafts to retry.') : notice}</AlertDescription></Alert> : null}
        <OrderComposerFooter hint={running ? t('正在逐项开立，请稍候…', 'Issuing each item…') : disabledReason ?? (selected.some(problem) ? t('还差：请修正所选项目的问题', 'Complete: fix the selected items') : t(`本次仅开立所选${kindName} ${selected.length} 项`, `Issue only ${selected.length} selected ${kindName} items`))}>
          <DialogClose render={<Button variant="outline" />}>{t('关闭', 'Close')}</DialogClose>
          <Button aria-busy={running || undefined} data-busy={running || undefined} disabled={locked || loading || error !== undefined || selected.length === 0 || selected.some(problem)} onClick={() => void run()}>
            {running ? <Spinner aria-hidden="true" data-icon="inline-start" /> : null}{running ? t('正在开立…', 'Issuing…') : t(`开立所选${kindName}（${selected.length}）`, `Issue selected ${kindName} (${selected.length})`)}
          </Button>
        </OrderComposerFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog pending={false} open={confirmClear} onOpenChange={setConfirmClear}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('丢弃全部未提交待开清单？', 'Discard all unsubmitted drafts?')}</AlertDialogTitle><AlertDialogDescription>{t('将删除本次住院两类检查的未提交输入，已开立申请不受影响。', 'Discard unsubmitted inputs in both categories for this admission. Issued requests remain.')}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t('保留待开清单', 'Keep drafts')}</AlertDialogCancel><AlertDialogAction onClick={() => { save(emptyDraft()); setConfirmClear(false) }}>{t('确认清空', 'Confirm discard')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>
}
