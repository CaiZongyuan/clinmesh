import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Input } from '@clinmesh/ui/components/input'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { PlusIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { WorkspaceLocale } from '../workspace-i18n.ts'

interface RequestSummary {
  id: string
  title: string
  statusLabel: string
  unread: boolean
  inProgress: boolean
}

/** 目录与表单只负责准备；正式开具统一在待开具清单中完成。 */
export function InvestigationManualControls({ adding, children, disabled = false, label, locale, onAddingChange }: {
  adding: boolean
  children: ReactNode
  disabled?: boolean | undefined
  label: string
  locale: WorkspaceLocale
  onAddingChange: (adding: boolean) => void
}) {
  const zh = locale === 'zh-CN'
  return <Dialog onOpenChange={onAddingChange} open={adding}>
    <DialogTrigger render={<Button disabled={disabled} type="button" variant="outline" />}>
      <PlusIcon data-icon="inline-start" />{label}
    </DialogTrigger>
    {adding ? <DialogContent className="sm:max-w-5xl">
      <DialogHeader>
        <DialogTitle>{label}</DialogTitle>
        <DialogDescription>{zh ? '选择项目并填写信息，返回列表后统一开具。已有手工草稿时请先调整或移除，避免覆盖。' : 'Choose an item and complete its fields, then return to the list to issue it. Edit or remove an existing manual draft before choosing another item.'}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto overscroll-contain p-4">{children}</div>
      <DialogFooter><Button onClick={() => onAddingChange(false)} type="button">{zh ? '返回待开具列表' : 'Return to order list'}</Button></DialogFooter>
    </DialogContent> : null}
  </Dialog>
}

/** 只组织正式申请的显示与选择；准备清单由各页面拥有。 */
export function InvestigationRequestWorkspace({ children, locale, onSelectRequest, requests, selectedRequestId }: {
  children: ReactNode
  locale: WorkspaceLocale
  onSelectRequest?: ((id: string) => void) | undefined
  requests: RequestSummary[]
  selectedRequestId?: string | undefined
}) {
  const zh = locale === 'zh-CN'
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  if (requests.length === 0) return null

  const visible = requests.filter(request => (
    request.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    && (filter === 'all' || (filter === 'unread' ? request.unread : request.inProgress))
  ))
  return (
    <div className="@container/investigation flex min-w-0 flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {zh ? `共 ${requests.length} 份申请 · ${requests.filter(request => request.unread).length} 份待阅` : `${requests.length} requests · ${requests.filter(request => request.unread).length} unread`}
      </p>
      <div className="grid min-w-0 gap-4 @3xl/investigation:grid-cols-[minmax(14rem,0.7fr)_minmax(0,1.7fr)]">
        <section aria-label={zh ? '申请列表' : 'Request list'} className="flex min-w-0 flex-col gap-3">
          <Input aria-label={zh ? '搜索申请' : 'Search requests'} onChange={event => setQuery(event.target.value)} placeholder={zh ? '搜索申请名称' : 'Search request names'} value={query} />
          <ToggleGroup aria-label={zh ? '筛选申请' : 'Filter requests'} className="max-w-full flex-wrap" onValueChange={values => { if (values[0] !== undefined) setFilter(values[0]) }} size="sm" value={[filter]} variant="outline">
            <ToggleGroupItem value="all">{zh ? '全部' : 'All'}</ToggleGroupItem>
            <ToggleGroupItem value="unread">{zh ? '待阅' : 'Unread'}</ToggleGroupItem>
            <ToggleGroupItem value="progress">{zh ? '进行中' : 'In progress'}</ToggleGroupItem>
          </ToggleGroup>
          {visible.length === 0 ? (
            <Empty>
              <EmptyHeader><EmptyTitle>{zh ? '没有匹配的申请' : 'No matching requests'}</EmptyTitle></EmptyHeader>
              <EmptyContent><Button onClick={() => { setQuery(''); setFilter('all') }} type="button" variant="outline">{zh ? '查看全部申请' : 'Show all requests'}</Button></EmptyContent>
            </Empty>
          ) : (
            <ul className="flex flex-col gap-2">
              {visible.map(request => (
                <li key={request.id}>
                  <Button
                    aria-label={`${request.title} ${request.statusLabel}`}
                    aria-pressed={request.id === selectedRequestId}
                    className="h-auto w-full flex-col items-start gap-2 whitespace-normal p-3 text-left"
                    onClick={() => onSelectRequest?.(request.id)}
                    type="button"
                    variant={request.id === selectedRequestId ? 'secondary' : 'outline'}
                  >
                    <span className="break-words font-medium">{request.title}</span>
                    <Badge variant={request.unread ? 'warning' : 'outline'}>{request.statusLabel}</Badge>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-label={zh ? '申请详情' : 'Request detail'} className="min-w-0 rounded-lg border p-4">{children}</section>
      </div>
    </div>
  )
}
