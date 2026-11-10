import { useId, useRef, useState } from 'react'
import type { z } from 'zod'
import type { inpatientSurgeryCatalogSchema, inpatientMaterialItemSchema } from '@clinmesh/contracts/inpatient-surgery'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { formatFen } from './workspace-format.ts'

type Props = { catalog: z.infer<typeof inpatientSurgeryCatalogSchema> | undefined; locale: WorkspaceLocale;
  count: number; disabled: boolean; onAdd: (item: z.infer<typeof inpatientMaterialItemSchema>) => void }

export function SurgeryFinalMaterialPicker({ catalog, locale, count, disabled, onAdd }: Props) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState(''), [page, setPage] = useState(1)
  const focus = useRef<HTMLElement | null>(null), id = useId(), zh = locale === 'zh-CN'
  const filtered = catalog?.materials.filter(item => item.display.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? []
  const pageCount = Math.max(1, Math.ceil(filtered.length / 10)), currentPage = Math.min(page, pageCount)
  return <Dialog open={open && !disabled} onOpenChange={setOpen}>
    <DialogTrigger render={<Button type="button" variant="outline" disabled={disabled || !catalog} />} onClick={event => { focus.current = event.currentTarget }}>
      {zh ? '新增最终耗材' : 'Add final material'}
    </DialogTrigger>
    <DialogContent className="h-[min(80svh,640px)] sm:max-w-[640px]" finalFocus={focus}>
      <DialogHeader><DialogTitle>{zh ? '选择最终耗材' : 'Choose final materials'}</DialogTitle>
        <DialogDescription>{zh ? `已加入 ${count} / 100 项；加入后继续选择，完成后逐项核实数量及预留。` : `${count} / 100 items added. Continue selecting, then review quantities and reservations.`}</DialogDescription></DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <Field><FieldLabel htmlFor={id}>{zh ? '搜索耗材' : 'Search materials'}</FieldLabel><Input id={id} value={search} maxLength={200} onChange={event => { setSearch(event.target.value); setPage(1) }} /></Field>
        {count >= 100 ? <p role="status">{zh ? '已达到100项上限，请先移除不需要的项目。' : 'The 100-item limit is reached. Remove an item before adding another.'}</p> : null}
        {filtered.slice((currentPage - 1) * 10, currentPage * 10).map(item => <article key={item.id} className="flex min-w-0 items-start gap-3 rounded-md border p-3">
          <div className="min-w-0 flex-1 break-words"><p>{item.display}</p><p className="text-xs text-muted-foreground">{'chargeDefinition' in item ? `${formatFen(item.chargeDefinition.priceFen, locale)}/${item.chargeDefinition.unit}` : zh ? '计价单位未确认，暂不可加入' : 'Billing unit unconfirmed; unavailable'}</p></div>
          <Button type="button" variant="outline" size="sm" disabled={disabled || count >= 100 || !('chargeDefinition' in item)} aria-label={`${zh ? '加入' : 'Add '}${item.display}`}
            onClick={() => { if ('chargeDefinition' in item && count < 100) onAdd(item) }}>{zh ? '加入' : 'Add'}</Button>
        </article>)}
        {filtered.length === 0 ? <p>{zh ? '没有匹配耗材' : 'No matching materials'}</p> : null}
        <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">{zh ? `第 ${currentPage} / ${pageCount} 页，共 ${filtered.length} 项` : `Page ${currentPage} / ${pageCount}, ${filtered.length} items`}</span>
          <Button type="button" variant="outline" size="sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>{zh ? '上一页耗材' : 'Previous materials'}</Button>
          <Button type="button" variant="outline" size="sm" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>{zh ? '下一页耗材' : 'Next materials'}</Button></div>
      </div>
      <DialogFooter><Button type="button" onClick={() => setOpen(false)}>{zh ? '完成选择' : 'Finish selection'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
