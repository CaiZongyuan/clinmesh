import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Input } from '@clinmesh/ui/components/input'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { useState, type ReactNode } from 'react'
import type { WorkspaceLocale } from '../workspace-i18n.ts'
import { DoctorOrderWorkspace } from './doctor-order-workspace.tsx'

interface RequestSummary {
  id: string
  title: string
  statusLabel: string
  unread: boolean
  inProgress: boolean
}

/** 只组织正式申请的显示与选择；准备清单由各页面拥有。 */
export function InvestigationRequestWorkspace({ children, entry, pending, locale, onSelectRequest, requests, selectedRequestId }: {
  children: ReactNode
  entry: ReactNode
  pending: ReactNode
  locale: WorkspaceLocale
  onSelectRequest?: ((id: string) => void) | undefined
  requests: RequestSummary[]
  selectedRequestId?: string | undefined
}) {
  const zh = locale === 'zh-CN'
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')

  const visible = requests.filter(request => (
    request.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    && (filter === 'all' || (filter === 'unread' ? request.unread : request.inProgress))
  ))
  const records = requests.length === 0 ? null : (
    <section aria-label={zh ? '申请列表' : 'Request list'} className="flex min-w-0 flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h4 className="text-sm font-semibold">{zh ? '已开具' : 'Issued'}</h4>
        <p className="text-xs text-muted-foreground">
          {zh ? `共 ${requests.length} 份申请 · ${requests.filter(request => request.unread).length} 份待阅` : `${requests.length} requests · ${requests.filter(request => request.unread).length} unread`}
        </p>
      </div>
      <Input aria-label={zh ? '搜索申请' : 'Search requests'} onChange={event => setQuery(event.target.value)} placeholder={zh ? '搜索申请名称' : 'Search request names'} value={query} />
      <ToggleGroup aria-label={zh ? '筛选申请' : 'Filter requests'} className="max-w-full flex-wrap" onValueChange={values => { if (values[0] !== undefined) setFilter(values[0]) }} size="sm" value={[filter]} variant="outline">
        <ToggleGroupItem value="all">{zh ? '全部' : 'All'}</ToggleGroupItem>
        <ToggleGroupItem value="unread">{zh ? '待阅' : 'Unread'}</ToggleGroupItem>
        <ToggleGroupItem value="progress">{zh ? '进行中' : 'In progress'}</ToggleGroupItem>
      </ToggleGroup>
      {visible.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{zh ? '没有匹配的申请' : 'No matching requests'}</EmptyTitle>
            <EmptyDescription>{zh ? '搜索为空不会删除申请记录。' : 'Searching does not delete request records.'}</EmptyDescription>
          </EmptyHeader>
          <Button onClick={() => { setQuery(''); setFilter('all') }} size="sm" type="button" variant="outline">{zh ? '查看全部申请' : 'Show all requests'}</Button>
        </Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map(request => (
            <li key={request.id}>
              <Button
                aria-label={`${request.title} ${request.statusLabel}`}
                aria-pressed={request.id === selectedRequestId}
                className="h-auto w-full min-w-0 items-center justify-start gap-2 whitespace-normal p-3 text-left"
                onClick={() => onSelectRequest?.(request.id)}
                type="button"
                variant={request.id === selectedRequestId ? 'secondary' : 'outline'}
              >
                <span className="min-w-0 flex-1 break-words font-medium">{request.title}</span>
                <Badge variant={request.unread ? 'warning' : 'outline'}>{request.statusLabel}</Badge>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
  return <DoctorOrderWorkspace entry={entry} pending={pending} records={records} hasRecords={requests.length > 0}
    details={<section aria-label={zh ? '申请详情' : 'Request detail'} className="min-w-0 rounded-lg border p-4">{children}</section>} />
}
