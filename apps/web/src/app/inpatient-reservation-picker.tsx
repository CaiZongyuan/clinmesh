import { useId, useRef, useState } from 'react'
import type { z } from 'zod'
import type { inpatientSurgeryCatalogSchema, inpatientMaterialItemSchema } from '@clinmesh/contracts/inpatient-surgery'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { formatFen } from './workspace-format.ts'

export function ReservationMaterialPicker({ catalog, locale, added, limit, disabled, onAdd }: {
  catalog: z.infer<typeof inpatientSurgeryCatalogSchema> | undefined; locale: WorkspaceLocale
  added: string[]; limit: number; disabled: boolean; onAdd: (item: z.infer<typeof inpatientMaterialItemSchema>) => void
}) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState(''), [page, setPage] = useState(1)
  const focus = useRef<HTMLElement | null>(null), id = useId(), zh = locale === 'zh-CN'
  const filtered = catalog?.materials.filter(item => item.display.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? []
  const pages = Math.max(1, Math.ceil(filtered.length / 10)), current = Math.min(page, pages)
  return <Dialog open={open && !disabled} onOpenChange={setOpen}>
    <DialogTrigger render={<Button type="button" variant="outline" disabled={disabled || !catalog} />} onClick={event => { focus.current = event.currentTarget }}>
      {zh ? '添加预留耗材' : 'Add reservation materials'}
    </DialogTrigger>
    <DialogContent className="h-[min(80svh,640px)] sm:max-w-[640px]" finalFocus={focus}>
      <DialogHeader><DialogTitle>{zh ? '选择预留耗材' : 'Choose reservation materials'}</DialogTitle>
        <DialogDescription>{zh ? `已加入 ${added.length} / ${limit} 项；加入后可继续选择，完成后核对数量与理由。` : `${added.length} / ${limit} items added. Continue selecting, then review quantities and reasons.`}</DialogDescription></DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <Field><FieldLabel htmlFor={id}>{zh ? '搜索预留耗材' : 'Search reservation materials'}</FieldLabel><Input id={id} maxLength={200} value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></Field>
        {added.length >= limit ? <p role="status">{zh ? `已达到${limit}项上限，请先移除不需要的项目；原输入已保留。` : `The ${limit}-item limit is reached. Remove an item before adding another; existing input is kept.`}</p> : null}
        {filtered.slice((current - 1) * 10, current * 10).map(item => <article key={item.id} className="flex min-w-0 items-start gap-3 rounded-md border p-3">
          <div className="min-w-0 flex-1 break-words"><p>{item.display}</p><p className="text-xs text-muted-foreground">{'chargeDefinition' in item ? `${formatFen(item.chargeDefinition.priceFen, locale)}/${item.chargeDefinition.unit}` : zh ? '计价单位未确认，暂不可加入' : 'Billing unit unconfirmed; unavailable'}</p></div>
          <Button type="button" variant="outline" size="sm" disabled={disabled || added.length >= limit || added.includes(item.id) || !('chargeDefinition' in item)} aria-label={`${zh ? '加入' : 'Add '}${item.display}`}
            onClick={() => { if (!disabled && 'chargeDefinition' in item && !added.includes(item.id) && added.length < limit) onAdd(item) }}>{added.includes(item.id) ? zh ? '已加入' : 'Added' : zh ? '加入' : 'Add'}</Button>
        </article>)}
        {filtered.length === 0 ? <p>{zh ? '没有匹配耗材' : 'No matching materials'}</p> : null}
        <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">{zh ? `第 ${current} / ${pages} 页，共 ${filtered.length} 项` : `Page ${current} / ${pages}, ${filtered.length} items`}</span>
          <Button type="button" variant="outline" size="sm" disabled={current <= 1} onClick={() => setPage(current - 1)}>{zh ? '上一页预留耗材' : 'Previous reservation materials'}</Button>
          <Button type="button" variant="outline" size="sm" disabled={current >= pages} onClick={() => setPage(current + 1)}>{zh ? '下一页预留耗材' : 'Next reservation materials'}</Button></div>
      </div>
      <DialogFooter><Button type="button" onClick={() => setOpen(false)}>{zh ? '完成选择' : 'Finish selection'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
