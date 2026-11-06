import { DialogFooter } from '@clinmesh/ui/components/dialog'
import { Button } from '@clinmesh/ui/components/button'
import { CheckIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { WorkspaceLocale } from '../workspace-i18n.ts'

/** 目录与选中项分别滚动；断点以弹窗内容宽度计算，兼容 ShadowRoot 宿主。 */
export function OrderComposerLayout({ catalog, children, locale }: { catalog: ReactNode; children: ReactNode; locale: WorkspaceLocale }) {
  return <div className="@container/order-composer flex min-h-0 flex-1 p-0">
    <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(12rem,1fr)_minmax(10rem,1fr)] @min-[38rem]/order-composer:grid-cols-[5fr_6fr] @min-[38rem]/order-composer:grid-rows-1">
      <div data-order-catalog="" className="flex min-h-0 min-w-0 flex-col overflow-hidden border-b @min-[38rem]/order-composer:border-r @min-[38rem]/order-composer:border-b-0 [&>section]:h-full [&>div]:h-full [&_[data-catalog-results]]:max-h-none [&_[data-catalog-results]]:flex-1 [&_li>button]:py-1">
        {catalog}
      </div>
      <div data-order-details="" className="min-h-0 min-w-0 overflow-y-auto p-4 [&>section]:border-0 [&>section]:p-0 [&>div]:border-0 [&>div]:p-0">
        {children ?? <p className="flex h-full items-center justify-center text-sm text-muted-foreground">{locale === 'zh-CN' ? '从左侧选择项目，查看详情并填写。' : 'Choose an item to view details and complete the fields.'}</p>}
      </div>
    </div>
  </div>
}

export function OrderComposerFooter({ children, hint }: { children: ReactNode; hint: string }) {
  const needsInput = /^(还差：|请先|请选择|Complete:|Choose |Enter )/.test(hint)
  return <DialogFooter className="clinmesh-order-composer-action items-center"><p className={needsInput ? 'min-w-0 flex-1 text-sm font-medium text-warning' : 'min-w-0 flex-1 text-sm text-muted-foreground'} role="status">{hint}</p>{children}</DialogFooter>
}

export function OrderComposerSearch({ children }: { children: ReactNode }) {
  return <div className="shrink-0 px-4 py-3">{children}</div>
}

export function OrderCatalogCandidate({ children, label, selected = false, disabled = false, onSelect }: {
  children: ReactNode; label?: string; selected?: boolean; disabled?: boolean; onSelect(): void
}) {
  return <Button aria-label={label} aria-pressed={selected} disabled={disabled} onClick={onSelect} type="button" variant="ghost"
    className="h-auto w-full min-w-0 justify-start gap-2 rounded-md border border-transparent px-3 py-1.5 text-left font-normal whitespace-normal aria-pressed:border-info/40 aria-pressed:bg-info/10 disabled:border-dashed disabled:border-border disabled:bg-muted/50">
    <CheckIcon aria-hidden="true" className={selected ? 'size-4 shrink-0 text-info' : 'invisible size-4 shrink-0'} />
    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">{children}</span>
  </Button>
}
