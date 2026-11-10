import { useId, useState } from 'react'
import type { InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Field, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { remainingAfterCompletion, type CompletionDraftRow, type CompletionRelease } from './inpatient-surgery-completion-draft.ts'

type Props = { reservations: InpatientMaterialReservation[]; rows: CompletionDraftRow[]; selected: CompletionRelease[];
  locale: WorkspaceLocale; disabled: boolean; onChange: (selected: CompletionRelease[]) => void }

export function SurgeryReleasePicker({ reservations, rows, selected, locale, disabled, onChange }: Props) {
  const [search, setSearch] = useState(''), [page, setPage] = useState(1), id = useId(), zh = locale === 'zh-CN'
  const filtered = reservations.filter(item => `${item.materialDisplay} ${item.reason}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const pageCount = Math.max(1, Math.ceil(filtered.length / 10)), currentPage = Math.min(page, pageCount)
  const shown = filtered.slice((currentPage - 1) * 10, currentPage * 10)
  const unavailableReason = (item: InpatientMaterialReservation) => {
    const remaining = remainingAfterCompletion(item, rows)
    if (item.releaseReason != null || item.status === 'released') return zh ? '原预留已关闭，不可释放' : 'Reservation closed'
    if (rows.some(row => row.reservationId === item.id && row.expectedReservationVersion !== item.version)) return zh ? '预留依据变化，请刷新核实依据' : 'Reservation changed; refresh review sources'
    if (remaining === null) return zh ? '请先填写合法最终总量' : 'Enter valid final quantities first'
    if (remaining <= 0) return zh ? '最终用量后无剩余预留' : 'No remaining reservation after final use'
    if (remaining > item.quantity) return zh ? '原使用依据变化，请重新核实当前用量' : 'Recorded use changed; review current quantities'
    return null
  }
  const eligible = (item: InpatientMaterialReservation) => unavailableReason(item) === null
  const select = (items: InpatientMaterialReservation[]) => onChange([...selected,
    ...items.filter(item => !selected.some(value => value.reservationId === item.id)).map(item => ({ reservationId: item.id, expectedReservationVersion: item.version, display: `${item.materialDisplay} · ${item.reason}` }))])
  return <FieldSet disabled={disabled} aria-label={zh ? '剩余预留释放' : 'Release remaining reservations'} className="min-w-0 rounded-md border p-3">
    <FieldLegend>{zh ? '剩余预留释放' : 'Release remaining reservations'}</FieldLegend>
    <p role="status" className="text-xs text-muted-foreground">{zh ? `已选释放 ${selected.length} / 100 项；仅释放本手术最终用量核实后的剩余预留，未选项继续保留。` : `${selected.length} / 100 releases selected. Only remaining reservations for this surgery are released; unselected items are retained.`}</p>
    <Field><FieldLabel htmlFor={id}>{zh ? '搜索剩余预留' : 'Search remaining reservations'}</FieldLabel><Input id={id} maxLength={200} value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></Field>
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={disabled || shown.every(item => !eligible(item)) || selected.length + shown.filter(item => eligible(item) && !selected.some(value => value.reservationId === item.id)).length > 100}
        onClick={() => select(shown.filter(eligible))}>{zh ? '全选当前页可释放预留' : 'Select eligible reservations on this page'}</Button>
      <Button type="button" size="sm" variant="ghost" disabled={disabled || selected.length === 0} onClick={() => onChange([])}>{zh ? '清空释放选择' : 'Clear release selection'}</Button>
    </div>
    {shown.map(item => {
      const remaining = remainingAfterCompletion(item, rows), checked = selected.some(value => value.reservationId === item.id)
      return <label key={item.id} className="flex min-w-0 items-start gap-2">
        <Checkbox aria-label={`${zh ? '释放剩余预留' : 'Release remaining reservation'} · ${item.materialDisplay} · ${item.reason} · ${item.id.slice(-6)}`} checked={checked}
          disabled={disabled || !checked && (!eligible(item) || selected.length >= 100)}
          onCheckedChange={value => value ? select([item]) : onChange(selected.filter(value => value.reservationId !== item.id))} />
        <span className="min-w-0 break-words text-sm">{item.materialDisplay} · {item.reason}
          <span className="block text-xs text-muted-foreground">{unavailableReason(item) ?? `${zh ? '最终剩余' : 'Final remaining'} ${remaining} ${item.unit ?? ''}`}</span>
        </span>
      </label>
    })}
    {filtered.length === 0 ? <p className="text-xs text-muted-foreground">{zh ? '没有匹配的本手术预留' : 'No matching reservation for this surgery'}</p> : null}
    <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">{zh ? `预留第 ${currentPage} / ${pageCount} 页` : `Reservations page ${currentPage} / ${pageCount}`}</span>
      <Button type="button" size="sm" variant="outline" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>{zh ? '上一页预留' : 'Previous reservations'}</Button>
      <Button type="button" size="sm" variant="outline" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>{zh ? '下一页预留' : 'Next reservations'}</Button></div>
    {selected.length > 0 ? <section aria-label={zh ? '完整已选释放清单' : 'All selected releases'} className="flex min-w-0 flex-col gap-2">
      {selected.map(item => <div key={item.reservationId} className="flex min-w-0 items-start gap-2"><span className="min-w-0 flex-1 break-words text-xs">{item.display}</span>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(selected.filter(value => value.reservationId !== item.reservationId))} aria-label={`${zh ? '取消释放' : 'Deselect release'} ${item.display}`}>{zh ? '取消释放' : 'Deselect'}</Button></div>)}
    </section> : null}
  </FieldSet>
}
