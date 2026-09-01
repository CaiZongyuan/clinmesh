import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@clinmesh/ui/components/table'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CircleAlertIcon,
  CloudUploadIcon,
  LoaderCircleIcon,
  SearchIcon,
} from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import {
  getLaboratoryServicePublicationJob,
  newIdempotencyKey,
  publishLaboratoryServices,
  searchLaboratoryServiceCandidates,
} from './api-client.ts'
import { PaginationControls } from './pagination-controls.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceMessages } from './workspace-i18n.ts'

const copy = {
  'en-US': {
    empty: 'No orderable laboratory reference candidates',
    failed: 'Failed',
    heading: 'Laboratory service configuration',
    panel: 'Panel',
    publish: 'Publish selected laboratory services',
    published: 'Published',
    publishing: 'Publishing',
    query: 'Search laboratory reference candidates',
    queryPlaceholder: 'Name or LOINC',
    search: 'Search candidates',
    select: 'Select',
    status: 'Status',
    type: 'Type',
    unconfigured: 'Unconfigured',
    unavailable: 'Laboratory service candidates are unavailable',
  },
  'zh-CN': {
    empty: '暂无可开立的检验参考候选',
    failed: '发布失败',
    heading: '检验服务配置',
    panel: '组合',
    publish: '发布所选检验服务',
    published: '已发布',
    publishing: '发布中',
    query: '搜索检验参考候选',
    queryPlaceholder: '检验名称或 LOINC',
    search: '搜索候选',
    select: '选择',
    status: '状态',
    type: '类型',
    unconfigured: '未配置',
    unavailable: '检验服务候选不可用',
  },
} as const

function statusVariant(status: 'failed' | 'published' | 'publishing' | 'unconfigured') {
  if (status === 'published') return 'default' as const
  if (status === 'failed') return 'destructive' as const
  return 'secondary' as const
}

function publicationErrorMessage(code: string, locale: WorkspaceLocale): string {
  const messages = {
    'en-US': {
      CATALOG_ENRICHMENT_INVALID: 'The generated service definition did not pass validation.',
      CATALOG_ENRICHMENT_UNAVAILABLE: 'Catalog Enrichment is not configured.',
      default: 'Publication failed. Review the candidate and retry.',
    },
    'zh-CN': {
      CATALOG_ENRICHMENT_INVALID: '生成的服务定义未通过校验。',
      CATALOG_ENRICHMENT_UNAVAILABLE: '尚未配置目录补全服务。',
      default: '发布失败，请检查候选配置后重试。',
    },
  } as const
  return messages[locale][code as keyof (typeof messages)[typeof locale]]
    ?? messages[locale].default
}

export function LaboratoryServiceWorkspace({
  locale,
  session,
}: {
  locale: WorkspaceLocale
  session: SessionContext
}): React.JSX.Element {
  const messages = copy[locale]
  const workspaceMessages = getWorkspaceMessages(locale)
  const queryClient = useQueryClient()
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [jobId, setJobId] = useState<string>()
  const queryKey = [
    'laboratory-service-candidates',
    session.actor.workspaceId,
    session.actor.epoch,
    query,
    page,
  ] as const
  const candidates = useQuery({
    queryFn: ({ signal }) => searchLaboratoryServiceCandidates(query, page, signal),
    queryKey,
  })
  const publish = useMutation({
    mutationFn: () => {
      const items = candidates.data?.items.filter(item => selectedIds.has(item.concept.id)) ?? []
      return publishLaboratoryServices(items.map(item => ({
        conceptId: item.concept.id,
        expectedVersion: item.version,
      })), newIdempotencyKey())
    },
    onSuccess: response => {
      setJobId(response.data.jobId)
      setSelectedIds(new Set())
    },
  })
  const job = useQuery({
    enabled: jobId !== undefined,
    queryFn: ({ signal }) => jobId === undefined
      ? Promise.reject(new Error('No Laboratory Service publication job'))
      : getLaboratoryServicePublicationJob(jobId, signal),
    queryKey: ['laboratory-service-publication-job', jobId ?? 'none'],
    refetchInterval: state => ['queued', 'running'].includes(state.state.data?.status ?? '')
      ? 500
      : false,
  })
  useEffect(() => {
    if (job.data?.status !== 'succeeded' && job.data?.status !== 'failed') return
    void queryClient.invalidateQueries({
      queryKey: [
        'laboratory-service-candidates',
        session.actor.workspaceId,
        session.actor.epoch,
      ],
    })
  }, [job.data?.status, queryClient, session.actor.epoch, session.actor.workspaceId])

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setQuery(input.trim())
    setPage(1)
    setSelectedIds(new Set())
  }
  return (
    <section aria-labelledby="laboratory-service-heading" className="flex flex-col gap-4 border-t pt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold" id="laboratory-service-heading">{messages.heading}</h2>
        <Button
          disabled={selectedIds.size === 0 || publish.isPending}
          onClick={() => publish.mutate()}
          type="button"
        >
          {publish.isPending
            ? <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
            : <CloudUploadIcon aria-hidden="true" />}
          {messages.publish}
        </Button>
      </div>
      <form className="flex max-w-xl gap-2" onSubmit={submitSearch}>
        <Input
          aria-label={messages.query}
          onChange={event => setInput(event.target.value)}
          placeholder={messages.queryPlaceholder}
          value={input}
        />
        <Button aria-label={messages.search} size="icon" title={messages.search} type="submit" variant="outline">
          <SearchIcon aria-hidden="true" />
        </Button>
      </form>
      {candidates.isPending ? <Skeleton className="h-44 w-full" /> : candidates.isError ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{messages.unavailable}</AlertTitle>
        </Alert>
      ) : candidates.data.items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{messages.empty}</p>
      ) : (
        <div className="overflow-x-auto border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12"><span className="sr-only">{messages.select}</span></TableHead>
                <TableHead>{locale === 'zh-CN' ? '参考项目' : 'Reference item'}</TableHead>
                <TableHead className="w-40">LOINC</TableHead>
                <TableHead className="w-28">{messages.type}</TableHead>
                <TableHead className="w-28">{messages.status}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidates.data.items.map((item) => {
                const selected = selectedIds.has(item.concept.id)
                const selectable = item.status !== 'publishing'
                return (
                  <TableRow key={item.concept.id}>
                    <TableCell>
                      <Checkbox
                        aria-label={`${messages.select} ${item.concept.display} ${item.concept.code}`}
                        checked={selected}
                        disabled={!selectable}
                        onCheckedChange={checked => setSelectedIds((current) => {
                          const next = new Set(current)
                          if (checked === true) next.add(item.concept.id)
                          else next.delete(item.concept.id)
                          return next
                        })}
                      />
                    </TableCell>
                    <TableCell className="font-medium">{item.concept.display}</TableCell>
                    <TableCell className="font-mono text-xs">{item.concept.code}</TableCell>
                    <TableCell>{item.definition.panelType === null ? item.definition.scaleType : messages.panel}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(item.status)}>{messages[item.status]}</Badge>
                      {item.error === null ? null : (
                        <p className="mt-1 max-w-80 text-xs text-destructive">
                          {publicationErrorMessage(item.error.code, locale)}
                        </p>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {candidates.data === undefined ? null : (
        <PaginationControls
          messages={workspaceMessages}
          onPageChange={(nextPage) => {
            setPage(nextPage)
            setSelectedIds(new Set())
          }}
          page={page}
          pageSize={candidates.data.pageSize}
          total={candidates.data.total}
        />
      )}
      {publish.isError ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{getWorkspaceErrorTitle(
            publish.error,
            workspaceMessages,
            messages.failed,
          )}</AlertTitle>
          <AlertDescription>{getWorkspaceErrorMessage(
            publish.error,
            workspaceMessages,
          )}</AlertDescription>
        </Alert>
      ) : null}
      {job.data?.status === 'queued' || job.data?.status === 'running' ? (
        <Alert><LoaderCircleIcon aria-hidden="true" className="animate-spin" /><AlertTitle>{messages.publishing}</AlertTitle></Alert>
      ) : null}
    </section>
  )
}
