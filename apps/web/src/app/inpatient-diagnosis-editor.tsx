import type { inpatientFullCatalogSchema, inpatientFullClinicalSchema, inpatientAdmissionConditionSchema } from '@clinmesh/contracts/inpatient-clinical'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { z } from 'zod'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { searchReferenceDiagnoses } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { PaginationControls } from './pagination-controls.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

type Clinical = z.infer<typeof inpatientFullClinicalSchema>
type Entry = { key: string; catalogItemId: string | null; display: string; role: 'primary' | 'secondary'; admissionCondition: z.infer<typeof inpatientAdmissionConditionSchema> | null; note: string }
type Draft = { encounterVersion: string; expectedRevision: number; entries: Entry[] }

export function InpatientDiagnosisEditor({ data, diagnoses, session, locale, blocked, write }: {
  data: Clinical; diagnoses: z.infer<typeof inpatientFullCatalogSchema>['diagnoses']; session: SessionContext
  locale: WorkspaceLocale; blocked: boolean; write: ReturnType<typeof useInpatientWriteIntent>
}): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const [draft, setDraft] = useState<Draft | null>(null)
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [page, setPage] = useState(1)
  const references = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, 'diagnosis-reference', search, page],
    enabled: search.length > 0, queryFn: ({ signal }) => searchReferenceDiagnoses(search, page, signal) })
  const current: Draft = draft ?? { encounterVersion: data.encounterVersion, expectedRevision: data.diagnosis.revision,
    entries: data.diagnosis.entries.length > 0 ? data.diagnosis.entries.map(entry => ({ key: entry.conditionId, catalogItemId: entry.coding.id, display: entry.coding.display,
      role: entry.role, admissionCondition: entry.admissionCondition, note: entry.note ?? '' })) : [{ key: 'primary', catalogItemId: null, display: '', role: 'primary', admissionCondition: null, note: '' }] }
  // Freeze both versions when editing, so a background refresh cannot overwrite an unsaved decision.
  const edit = (change: (entries: Entry[]) => Entry[]) => setDraft({ ...current, entries: change(current.entries) })
  const result = write.mutation.data
  useEffect(() => {
    if (draft && result?.command?.operation === 'inpatient.diagnosis.confirm'
      && result.command.input.admissionId === data.admissionId && result.command.input.expectedRevision === draft.expectedRevision
      && data.diagnosis.revision > draft.expectedRevision) setDraft(null)
  }, [data.admissionId, data.diagnosis.revision, draft, result])
  const candidates = new Map((search ? references.data?.items ?? [] : diagnoses).map(item => [item.id, { value: item.id, label: item.display }]))
  for (const entry of current.entries) if (entry.catalogItemId && !candidates.has(entry.catalogItemId)) candidates.set(entry.catalogItemId, { value: entry.catalogItemId, label: entry.display })
  const conditions = [{ value: '1' as const, label: t('1 · 有', '1 · Present') }, { value: '2' as const, label: t('2 · 临床未确定', '2 · Clinically undetermined') },
    { value: '3' as const, label: t('3 · 情况不明', '3 · Unknown') }, { value: '4' as const, label: t('4 · 无', '4 · Absent') }]
  const valid = current.entries.every(entry => entry.catalogItemId && entry.admissionCondition) && new Set(current.entries.map(entry => entry.catalogItemId)).size === current.entries.length
  const move = (index: number, delta: number) => edit(entries => { const next = [...entries]; [next[index], next[index + delta]] = [next[index + delta]!, next[index]!]; return next })
  const submit = () => {
    if (!valid) return
    write.mutation.mutate({ operation: 'inpatient.diagnosis.confirm', input: { admissionId: data.admissionId, encounterVersion: current.encounterVersion, expectedRevision: current.expectedRevision,
      entries: current.entries.map(entry => ({ catalogItemId: entry.catalogItemId!, role: entry.role, admissionCondition: entry.admissionCondition!, ...(entry.note.trim() ? { note: entry.note } : {}) })) } })
  }
  let secondary = 0
  return <form onSubmit={event => { event.preventDefault(); submit() }}><FieldSet disabled={blocked}>
    <FieldLegend>{t('确认本次住院诊断', 'Confirm admission diagnosis')}</FieldLegend>
    <FieldGroup className="flex flex-col gap-3">
      <Field><FieldLabel htmlFor="inpatient-diagnosis-search">{t('诊断目录检索', 'Search diagnosis catalog')}</FieldLabel><Input id="inpatient-diagnosis-search" value={query} onChange={event => setQuery(event.currentTarget.value)} /></Field>
      <Button type="button" variant="outline" onClick={() => { setSearch(query.trim()); setPage(1) }}>{t('查询诊断', 'Search diagnoses')}</Button>
      {references.error ? <p role="alert">{getWorkspaceErrorMessage(references.error, getWorkspaceMessages(locale))}</p> : null}
      {current.entries.map((entry, index) => {
        const primary = entry.role === 'primary', title = primary ? t('住院诊断', 'Inpatient diagnosis') : t(`次诊断 ${++secondary}`, `Secondary diagnosis ${secondary}`)
        const conditionTitle = primary ? t('主诊断入院病情', 'Primary diagnosis on admission') : t(`${title} 入院病情`, `${title} on admission`)
        const update = (patch: Partial<Entry>) => edit(entries => entries.map((item, i) => i === index ? { ...item, ...patch } : item))
        return <div key={entry.key} className="grid gap-3 rounded-md border p-3 md:grid-cols-2">
          <Field><FieldLabel htmlFor={`inpatient-diagnosis-${entry.key}`}>{title}</FieldLabel><WorkspaceSelect id={`inpatient-diagnosis-${entry.key}`} value={entry.catalogItemId}
            items={[...candidates.values()].filter(item => item.value === entry.catalogItemId || !current.entries.some(other => other.catalogItemId === item.value))}
            onValueChange={value => update({ catalogItemId: value, display: value ? candidates.get(value)?.label ?? '' : '' })} /></Field>
          <Field><FieldLabel htmlFor={`inpatient-condition-${entry.key}`}>{conditionTitle}</FieldLabel><WorkspaceSelect id={`inpatient-condition-${entry.key}`} value={entry.admissionCondition} items={conditions} onValueChange={value => update({ admissionCondition: value })} /></Field>
          <Field><FieldLabel htmlFor={`inpatient-note-${entry.key}`}>{primary ? t('主诊断备注', 'Primary diagnosis note') : t(`${title} 备注`, `${title} note`)}</FieldLabel><Input id={`inpatient-note-${entry.key}`} maxLength={2000} value={entry.note} onChange={event => update({ note: event.currentTarget.value })} /></Field>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" aria-label={t(`上移${title}`, `Move up ${title}`)} disabled={index === 0} onClick={() => move(index, -1)}>{t('上移', 'Move up')}</Button>
            <Button type="button" variant="outline" aria-label={t(`下移${title}`, `Move down ${title}`)} disabled={index === current.entries.length - 1} onClick={() => move(index, 1)}>{t('下移', 'Move down')}</Button>
            {!primary ? <Button type="button" variant="outline" aria-label={t(`删除${title}`, `Remove ${title}`)} onClick={() => edit(entries => entries.filter((_, i) => i !== index))}>{t('删除', 'Remove')}</Button> : null}
          </div>
        </div>
      })}
      <Button type="button" variant="outline" disabled={current.entries.length >= 20} onClick={() => edit(entries => [...entries, { key: crypto.randomUUID(), catalogItemId: null, display: '', role: 'secondary', admissionCondition: null, note: '' }])}>{t('添加次诊断', 'Add secondary diagnosis')}</Button>
      {draft ? <Button type="button" variant="outline" onClick={() => setDraft(null)}>{t('放弃编辑，载入已确认诊断', 'Discard edits and load confirmed diagnoses')}</Button> : null}
      <Button type="submit" disabled={blocked || !valid}>{t('确认住院诊断', 'Confirm diagnosis')}</Button>
      {references.data && search ? <PaginationControls messages={getWorkspaceMessages(locale)} page={page} pageSize={references.data.pageSize} total={references.data.total} onPageChange={setPage} /> : null}
    </FieldGroup>
  </FieldSet></form>
}
