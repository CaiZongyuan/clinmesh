import type { inpatientFullClinicalSchema, inpatientAdmissionConditionSchema } from '@clinmesh/contracts/inpatient-clinical'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { z } from 'zod'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Input } from '@clinmesh/ui/components/input'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { searchReferenceDiagnoses } from './api-client.ts'
import { PaginationControls } from './pagination-controls.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { OrderCatalogCandidate, OrderComposerFooter, OrderComposerLayout, OrderComposerSearch } from './doctor/order-composer-layout.tsx'

type Clinical = z.infer<typeof inpatientFullClinicalSchema>
type Condition = z.infer<typeof inpatientAdmissionConditionSchema>
/** 列表顺序即诊断顺序：第一条为主诊断。 */
type Entry = { catalogItemId: string; display: string; code: string; admissionCondition: Condition | null; note: string; noteOpen: boolean }
type Draft = { encounterVersion: string; expectedRevision: number; entries: Entry[] }

/** 两栏诊断弹窗：左侧只查国家临床版诊断，右侧为本次诊断。弹窗关闭后组件仍挂载，草稿与检索词保留。 */
export function InpatientDiagnosisEditor({ data, session, locale, blocked, write, open, onOpenChange }: {
  data: Clinical; session: SessionContext; locale: WorkspaceLocale; blocked: boolean
  write: ReturnType<typeof useInpatientWriteIntent>; open: boolean; onOpenChange(open: boolean): void
}): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const messages = getWorkspaceMessages(locale)
  const [draft, setDraft] = useState<Draft | null>(null)
  const submittedDraft = useRef<Draft | null>(null)
  const [query, setQuery] = useState(''), [page, setPage] = useState(1)
  const search = query.trim()
  const references = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, 'diagnosis-reference', search, page],
    enabled: open, queryFn: ({ signal }) => searchReferenceDiagnoses(search, page, signal) })
  const current: Draft = draft ?? { encounterVersion: data.encounterVersion, expectedRevision: data.diagnosis.revision,
    entries: data.diagnosis.entries.map(entry => ({ catalogItemId: entry.coding.id, display: entry.coding.display, code: entry.coding.code,
      admissionCondition: entry.admissionCondition, note: entry.note ?? '', noteOpen: Boolean(entry.note) })) }
  // Freeze both versions when editing, so a background refresh cannot overwrite an unsaved decision.
  const edit = (change: (entries: Entry[]) => Entry[]) => setDraft({ ...current, entries: change(current.entries) })
  const update = (index: number, patch: Partial<Entry>) => edit(entries => entries.map((item, i) => i === index ? { ...item, ...patch } : item))
  const move = (from: number, to: number) => edit(entries => { const next = [...entries]; const [item] = next.splice(from, 1); next.splice(to, 0, item!); return next })
  const result = write.mutation.data
  useEffect(() => {
    if (draft && draft === submittedDraft.current && result?.command?.operation === 'inpatient.diagnosis.confirm'
      && result.command.input.admissionId === data.admissionId && result.command.input.expectedRevision === draft.expectedRevision
      && data.diagnosis.revision > draft.expectedRevision) setDraft(currentDraft => currentDraft === draft ? null : currentDraft)
  }, [data.admissionId, data.diagnosis.revision, draft, result])
  const conditions: Array<[Condition, string]> = [['1', t('有', 'Present')], ['2', t('临床未确定', 'Clinically undetermined')], ['3', t('情况不明', 'Unknown')], ['4', t('无', 'Absent')]]
  const missingConditions = current.entries.filter(entry => entry.admissionCondition === null).length
  const missing = current.entries.length === 0 ? t('至少加入一条诊断', 'add at least one diagnosis')
    : missingConditions > 0 ? t(`${missingConditions} 条诊断的入院病情`, `condition on admission for ${missingConditions} diagnoses`) : undefined
  const submit = () => {
    if (missing) return
    submittedDraft.current = current
    write.mutation.mutate({ operation: 'inpatient.diagnosis.confirm', input: { admissionId: data.admissionId, encounterVersion: current.encounterVersion, expectedRevision: current.expectedRevision,
      entries: current.entries.map((entry, index) => ({ catalogItemId: entry.catalogItemId, role: index === 0 ? 'primary' as const : 'secondary' as const,
        admissionCondition: entry.admissionCondition!, ...(entry.note.trim() ? { note: entry.note } : {}) })) } }, { onSuccess: () => onOpenChange(false) })
  }
  const failure = write.mutation.variables?.operation === 'inpatient.diagnosis.confirm' ? write.mutation.error : null
  const items = references.data?.items ?? []
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-h-[min(720px,calc(100svh-2.5rem))] flex-col sm:max-w-4xl" data-agent-catalog="inpatient-diagnosis">
      <DialogHeader className="flex-row flex-wrap items-baseline gap-x-3">
        <DialogTitle>{data.diagnosis.entries.length > 0 ? t('修改住院诊断', 'Edit inpatient diagnoses') : t('确认住院诊断', 'Confirm inpatient diagnoses')}</DialogTitle>
        <DialogDescription>{t('国家临床版 2022', 'National clinical edition 2022')}</DialogDescription>
      </DialogHeader>
      <OrderComposerLayout locale={locale} catalog={<div className="flex min-h-0 flex-1 flex-col">
        <OrderComposerSearch><Input aria-label={t('搜索诊断名称或编码', 'Search diagnosis name or code')} maxLength={200} placeholder={t('搜索诊断名称或编码', 'Search diagnosis name or code')}
          value={query} onChange={event => { setQuery(event.currentTarget.value); setPage(1) }} /></OrderComposerSearch>
        <div className="min-h-0 flex-1 overflow-y-auto border-y">
          {!search ? <p className="px-4 py-2 text-xs text-muted-foreground">{t('输入诊断名称或编码查询，例如「冠状动脉」「高血压」「I10」。只查国家临床版 2022。', 'Search by diagnosis name or code, for example "coronary" or "I10". Only the national clinical edition 2022 is searched.')}</p> : null}
          {references.error ? <p className="p-4 text-sm text-destructive" role="alert">{getWorkspaceErrorMessage(references.error, messages)}</p>
            : references.isPending ? <p className="p-4 text-sm text-muted-foreground" role="status">{t('正在查询诊断', 'Searching diagnoses')}</p>
              : items.length === 0 ? (search ? <p className="p-4 text-sm text-muted-foreground">{t('没有匹配的诊断，换个关键词试试。', 'No matching diagnoses. Try another keyword.')}</p> : null)
                : <ul className="divide-y">{items.map(item => {
                  const added = current.entries.some(entry => entry.catalogItemId === item.id), inactive = item.status === 'inactive'
                  return <li key={item.id}><OrderCatalogCandidate selected={added} disabled={added || inactive || blocked || current.entries.length >= 20}
                    label={`${added ? t('已加入', 'Added ') : t('加入', 'Add ')}${item.display}`}
                    onSelect={() => edit(entries => [...entries, { catalogItemId: item.id, display: item.display, code: item.code, admissionCondition: null, note: '', noteOpen: false }])}>
                    <strong className="min-w-0">{item.display}</strong><span className="text-xs text-muted-foreground tabular-nums">{item.code}</span>
                    <span className="ms-auto text-xs text-muted-foreground">{added ? t('已加入', 'Added') : inactive ? t('已停用', 'Inactive') : <span className="inline-flex items-center gap-1 text-info"><PlusIcon aria-hidden="true" className="size-3" />{t('加入', 'Add')}</span>}</span>
                  </OrderCatalogCandidate></li>
                })}</ul>}
        </div>
        {references.data && references.data.total > 0 ? <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs text-muted-foreground">
          <span>{t(`共 ${references.data.total} 条`, `${references.data.total} results`)}</span>
          {references.data.total > references.data.pageSize ? <PaginationControls messages={messages} page={page} pageSize={references.data.pageSize} total={references.data.total} disabled={references.isFetching} onPageChange={setPage} /> : null}
        </div> : null}
      </div>}>
        <section aria-label={t('本次住院诊断', 'Diagnoses for this admission')} className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">{t('本次住院诊断', 'Diagnoses for this admission')} <span className="font-normal text-muted-foreground">{t(`${current.entries.length} 条 · 第一条加入的自动为主诊断`, `${current.entries.length} · the first added is primary`)}</span></h3>
          {current.entries.length === 0 ? <p className="text-sm text-muted-foreground">{t('从左侧搜索并加入诊断。', 'Search and add diagnoses on the left.')}</p> : null}
          {current.entries.map((entry, index) => <div key={entry.catalogItemId} data-missing={entry.admissionCondition === null || undefined}
            className="flex flex-col gap-2 rounded-md border p-3 data-missing:border-warning/60 data-missing:bg-warning/5">
            <div className="flex min-w-0 items-center gap-2">
              {index === 0 ? <Badge>{t('主诊断', 'Primary')}</Badge> : <Button type="button" variant="link" size="sm" className="h-auto p-0 text-info" disabled={blocked}
                aria-label={t(`设为主诊断：${entry.display}`, `Make primary: ${entry.display}`)} onClick={() => move(index, 0)}>{t('设为主诊断', 'Make primary')}</Button>}
              <span className="min-w-0 flex-1 truncate font-medium">{entry.display} <span className="text-xs font-normal text-muted-foreground tabular-nums">{entry.code}</span></span>
              {index > 0 ? <>
                {index > 1 ? <Button type="button" variant="ghost" size="icon-sm" disabled={blocked} aria-label={t(`上移${entry.display}`, `Move up ${entry.display}`)} onClick={() => move(index, index - 1)}><ArrowUpIcon /></Button> : null}
                <Button type="button" variant="ghost" size="icon-sm" disabled={blocked || index === current.entries.length - 1} aria-label={t(`下移${entry.display}`, `Move down ${entry.display}`)} onClick={() => move(index, index + 1)}><ArrowDownIcon /></Button>
                {index < current.entries.length - 1 ? <Button type="button" variant="ghost" size="icon-sm" disabled={blocked} aria-label={t(`下移${entry.display}`, `Move down ${entry.display}`)} onClick={() => move(index, index + 1)}><ArrowDownIcon /></Button> : null}
              </> : null}
              <Button type="button" variant="ghost" size="icon-sm" disabled={blocked} aria-label={t(`移除${entry.display}`, `Remove ${entry.display}`)} onClick={() => edit(entries => entries.filter((_, i) => i !== index))}><XIcon /></Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{t('入院病情', 'On admission')}</span>
              <ToggleGroup aria-label={t(`${entry.display} 入院病情`, `${entry.display} condition on admission`)} size="sm" variant="outline" disabled={blocked}
                value={entry.admissionCondition ? [entry.admissionCondition] : []} onValueChange={values => { const value = conditions.find(([code]) => code === values[0])?.[0]; if (value) update(index, { admissionCondition: value }) }}>
                {conditions.map(([code, label]) => <ToggleGroupItem key={code} value={code}>{label}</ToggleGroupItem>)}
              </ToggleGroup>
              {entry.noteOpen ? <Input className="min-w-40 flex-1" aria-label={t(`${entry.display} 备注`, `${entry.display} note`)} placeholder={t('备注（选填）', 'Note (optional)')} maxLength={2000}
                disabled={blocked} value={entry.note} onChange={event => update(index, { note: event.currentTarget.value })} />
                : <Button type="button" variant="link" size="sm" className="h-auto p-0" disabled={blocked} aria-label={t(`加备注：${entry.display}`, `Add note: ${entry.display}`)} onClick={() => update(index, { noteOpen: true })}>{t('加备注', 'Add note')}</Button>}
            </div>
          </div>)}
          {data.diagnosis.entries.length > 0 ? <p className="text-xs text-muted-foreground">{t('确认后整组替换当前诊断。', 'Confirming replaces the current diagnoses as a set.')}</p> : null}
          {draft ? <Button type="button" variant="outline" className="self-start" onClick={() => setDraft(null)}>{t('放弃编辑，载入已确认诊断', 'Discard edits and load confirmed diagnoses')}</Button> : null}
          {failure ? <p className="text-sm text-destructive" role="alert">{getWorkspaceErrorMessage(failure, messages)}</p> : null}
        </section>
      </OrderComposerLayout>
      <OrderComposerFooter hint={missing ? `${t('还差：', 'Complete: ')}${missing}` : `${t('主诊断：', 'Primary: ')}${current.entries[0]!.display}`}>
        <DialogClose render={<Button type="button" variant="outline" />}>{t('取消', 'Cancel')}</DialogClose>
        <Button type="button" disabled={blocked || missing !== undefined} onClick={submit}>{t('确认住院诊断', 'Confirm diagnoses')}</Button>
      </OrderComposerFooter>
    </DialogContent>
  </Dialog>
}
