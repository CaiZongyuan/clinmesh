import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
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

/** 只组织申请的显示与选择；三类表单、报告及正式操作仍由各自页面拥有。 */
export function InvestigationRequestWorkspace({
  adding, children, editor, locale, onAddingChange, onSelectRequest, readOnly, requests, selectedRequestId,
}: {
  adding: boolean
  children: ReactNode
  editor: ReactNode
  locale: WorkspaceLocale
  onAddingChange: (adding: boolean) => void
  onSelectRequest?: ((id: string) => void) | undefined
  readOnly: boolean
  requests: RequestSummary[]
  selectedRequestId?: string | undefined
}) {
  const zh = locale === 'zh-CN'
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  if (requests.length === 0) return readOnly ? (
    <Empty><EmptyHeader><EmptyTitle>{zh ? '暂无申请' : 'No requests'}</EmptyTitle></EmptyHeader></Empty>
  ) : editor

  const visible = requests.filter(request => (
    request.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    && (filter === 'all' || (filter === 'unread' ? request.unread : request.inProgress))
  ))
  return (
    <div className="@container/investigation flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {zh ? `共 ${requests.length} 份申请 · ${requests.filter(request => request.unread).length} 份待阅` : `${requests.length} requests · ${requests.filter(request => request.unread).length} unread`}
        </p>
        {readOnly ? null : (
          <Dialog onOpenChange={onAddingChange} open={adding}>
            <DialogTrigger render={<Button type="button" variant="outline" />}>
              <PlusIcon data-icon="inline-start" />{zh ? '追加申请' : 'Add request'}
            </DialogTrigger>
            {adding ? <DialogContent className="max-w-5xl">
              <DialogHeader>
                <DialogTitle>{zh ? '追加申请' : 'Add request'}</DialogTitle>
                <DialogDescription>{zh ? '选择当前分类的项目，填写申请信息后正式开立。' : 'Select an item in this category, complete the request, and issue it.'}</DialogDescription>
              </DialogHeader>
              <div className="min-h-0 overflow-y-auto overscroll-contain p-4">{editor}</div>
            </DialogContent> : null}
          </Dialog>
        )}
      </div>
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
