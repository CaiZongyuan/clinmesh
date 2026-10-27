import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { ModelUsageOverview } from '@clinmesh/contracts/model-usage'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { ApiClientError } from './api-client.ts'
import { getModelUsageOverview, getModelUsageRequests, getModelUsageRetention } from './model-usage-api.ts'
import { modelUsageMessages } from './model-usage-i18n.ts'
import { retentionPeriod } from './model-usage-retention.tsx'
import { inpatientScopeKey } from './inpatient-scope.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

type Props = { admissionId: string; taskId: string; session: SessionContext; locale: WorkspaceLocale; active: boolean }
type Stage = NonNullable<ModelUsageOverview['stages']>[number]

function stageLabel(stage: string, locale: WorkspaceLocale) {
  const labels: Record<string, readonly [string, string]> = {
    'preoperative-generation': ['术前生成', 'Preoperative generation'], 'preoperative-verification': ['术前核验', 'Preoperative verification'],
    'intraoperative-generation': ['术中生成', 'Intraoperative generation'], 'intraoperative-verification': ['术中核验', 'Intraoperative verification'],
    'postoperative-generation': ['术后生成', 'Postoperative generation'], 'postoperative-verification': ['术后核验', 'Postoperative verification'],
  }
  return labels[stage]?.[locale === 'zh-CN' ? 0 : 1] ?? stage
}

export function InpatientDrgUsagePanel({ admissionId, taskId, session, locale, active }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const messages = modelUsageMessages(locale)
  const [expanded, setExpanded] = useState(false), [offset, setOffset] = useState(0)
  const detailId = useId()
  const scope = [...inpatientScopeKey(session), admissionId, 'drg-model-usage', taskId, session.user.id, session.actor.actorId, session.actor.roleCode]
  const filters = { caseId: admissionId, taskId, offset: 0, limit: 25 }
  const poll = { enabled: active, refetchInterval: active ? 3_000 : false, refetchIntervalInBackground: false, retry: false } as const
  const overview = useQuery({ queryKey: [...scope, 'overview'], queryFn: ({ signal }) => getModelUsageOverview(filters, signal), ...poll })
  const requests = useQuery({ queryKey: [...scope, 'requests', offset],
    queryFn: ({ signal }) => getModelUsageRequests({ ...filters, offset }, signal), ...poll, enabled: active && expanded })
  const retention = useQuery({ queryKey: ['model-usage', 'retention', session.actor.workspaceId, session.user.id, session.actor.roleCode],
    queryFn: ({ signal }) => getModelUsageRetention(signal), enabled: active, retry: false })
  const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 })
  const currencyFormat = new Intl.NumberFormat(locale, { style: 'currency', currency: 'CNY', maximumFractionDigits: 6 })
  const count = (value: number | null) => value === null ? messages.unknown : numberFormat.format(value)
  const tokens = (known: number, unknown: number) => count(known === 0 && unknown > 0 ? null : known)
  const money = (value: number | null) => value === null ? messages.unknown : currencyFormat.format(value)
  const errorText = (error: unknown) => error instanceof ApiClientError && (error.status === 403 || error.status === 404)
    ? t('当前岗位无权读取本次住院模型用量，或该病例已不可访问。', 'This role cannot read model usage for this admission, or the admission is no longer accessible.')
    : t('本次住院模型用量读取失败，请重试。', 'Unable to read model usage for this admission. Retry the request.')
  const totals = overview.data?.totals
  const stages = overview.data?.stages
  const metrics = totals ? [
    { label: t('实际模型请求数', 'Actual model requests'), value: count(totals.requests) },
    { label: t('已知输入 Token', 'Known input tokens'), value: tokens(totals.knownInputTokens, totals.unknownInputTokenRequests) },
    { label: t('已知输出 Token', 'Known output tokens'), value: tokens(totals.knownOutputTokens, totals.unknownOutputTokenRequests) },
    { label: t('已知总 Token', 'Known total tokens'), value: tokens(totals.knownTokens, totals.unknownTokenRequests) },
    { label: t('估算人民币费用', 'Estimated CNY cost'), value: totals.requests === 0 ? t('尚无请求', 'No requests yet') : money(totals.cny) },
  ] : []
  const stageTokens = (stage: Stage) => `${tokens(stage.knownInputTokens, stage.unknownInputTokenRequests)} / ${tokens(stage.knownOutputTokens, stage.unknownOutputTokenRequests)} / ${tokens(stage.knownTokens, stage.unknownTokenRequests)}`
  return <section aria-label={t('本次住院模型用量', 'Model usage for this admission')} className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2"><h5 className="font-medium">{t('本次住院模型用量', 'Model usage for this admission')}</h5>
      <Button variant="outline" size="sm" disabled={!active || overview.isFetching} onClick={() => {
        void overview.refetch(); if (expanded) void requests.refetch(); void retention.refetch()
      }}>{t('刷新病例用量', 'Refresh admission usage')}</Button></div>
    <p className="text-sm text-muted-foreground">{t('仅归集本次住院、当前跟进任务的实际模型请求；关闭页面、重启或停止跟进不会清零。', 'Only actual model requests for this admission and follow-up task are included. Closing the page, restarting or stopping follow-up does not reset usage.')}</p>
    {overview.isPending ? <div role="status">{messages.loading}<Skeleton className="h-12 w-full" /></div> : null}
    {overview.error ? <Alert variant="destructive"><AlertDescription>{errorText(overview.error)}</AlertDescription></Alert> : null}
    {totals && !overview.error ? <>
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{metrics.map(metric => <div key={metric.label}>
        <dt className="text-sm text-muted-foreground">{metric.label}</dt><dd aria-label={metric.label} className="tabular-nums">{metric.value}</dd>
      </div>)}</dl>
      <p>{t('进行中 ', 'In flight ')}{totals.inFlight} · {t('结果未知 ', 'Unknown outcomes ')}{totals.unknownRequests}
        {' · '}{totals.unknownTokenRequests} {messages.unknownTokenRequests} · {totals.unpricedRequests} {messages.unpricedRequests}</p>
      <p className="text-sm text-muted-foreground">{t('输入用量不完整 ', 'Incomplete input usage ')}{totals.unknownInputTokenRequests} · {t('输出用量不完整 ', 'Incomplete output usage ')}{totals.unknownOutputTokenRequests}</p>
      <p className="text-xs text-muted-foreground">{messages.tokenExplanation}</p>
      {totals.requests === 0 ? <Empty><EmptyHeader><EmptyTitle>{t('本次跟进尚无模型请求', 'No model requests for this follow-up yet')}</EmptyTitle>
        <EmptyDescription>{t('规则检查和有效结果复用不新增模型请求。', 'Rule checks and reuse of valid results do not add model requests.')}</EmptyDescription></EmptyHeader></Empty> : null}
      {stages ? <>
        <Table aria-label={t('模型阶段累计', 'Model usage by stage')}><TableHeader><TableRow>
          <TableHead>{messages.stage}</TableHead><TableHead>{messages.requestCount}</TableHead>
          <TableHead>{t('输入 / 输出 / 总 Token', 'Input / output / total tokens')}</TableHead><TableHead>{t('估算人民币费用', 'Estimated CNY cost')}</TableHead>
        </TableRow></TableHeader><TableBody>{stages.map(stage => <TableRow key={stage.stage}>
          <TableCell>{stageLabel(stage.stage, locale)}</TableCell><TableCell>{stage.requests}</TableCell><TableCell>{stageTokens(stage)}
            {stage.unknownTokenRequests > 0 ? <p className="text-xs text-muted-foreground">{stage.unknownTokenRequests} {messages.unknownTokenRequests}</p> : null}</TableCell>
          <TableCell>{money(stage.cny)}{stage.unpricedRequests > 0 ? <p className="text-xs text-muted-foreground">{stage.unpricedRequests} {messages.unpricedRequests}</p> : null}</TableCell>
        </TableRow>)}</TableBody></Table>
        {([['preoperative', '术前', 'preoperative'], ['intraoperative', '术中', 'intraoperative'], ['postoperative', '术后', 'postoperative']] as const)
          .filter(([stage]) => !stages.some(item => item.stage.startsWith(`${stage}-`) && item.requests > 0))
          .map(([stage, cn, en]) => <p key={stage} className="text-sm text-muted-foreground">{t(`尚无${cn}模型调用`, `No ${en} model calls yet`)}</p>)}
      </> : <p>{t('阶段累计暂不可用。', 'Stage totals are unavailable.')}</p>}
      <Button variant="outline" aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded(value => !value)}>
        {expanded ? t('收起模型请求明细', 'Hide model request details') : t('展开模型请求明细', 'Show model request details')}</Button>
      {expanded ? <div id={detailId} className="flex min-w-0 flex-col gap-3">
        {requests.isPending ? <p role="status">{messages.loading}</p> : null}
        {requests.error ? <Alert variant="destructive"><AlertDescription>{errorText(requests.error)}</AlertDescription></Alert> : null}
        {requests.data && !requests.error ? <>
          <Table aria-label={t('本次住院模型请求明细', 'Model request details for this admission')}><TableHeader><TableRow>
            <TableHead>{messages.requestTime}</TableHead><TableHead>{messages.stage}</TableHead><TableHead>{t('触发与请求类型', 'Trigger and request kind')}</TableHead>
            <TableHead>{messages.model}</TableHead><TableHead>{messages.result}</TableHead><TableHead>{t('输入 / 输出 / 总 Token', 'Input / output / total tokens')}</TableHead><TableHead>{t('估算人民币费用', 'Estimated CNY cost')}</TableHead>
          </TableRow></TableHeader><TableBody>{requests.data.items.map(attempt => {
            const cost = attempt.effectiveCost ?? attempt.cost
            return <TableRow key={attempt.id}><TableCell>{new Date(attempt.startedAt).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })}</TableCell>
              <TableCell>{stageLabel(attempt.context.stage, locale)}</TableCell><TableCell>{messages.triggerLabel(attempt.context.trigger)} · {messages.kindLabel(attempt.kind)}
                {attempt.context.sources.filter(source => source.relationship === 'trigger').map(source => <p key={`${source.kind}:${source.id}`} className="max-w-48 break-all text-xs text-muted-foreground">{t('触发来源：', 'Trigger source: ')}{source.kind} / {source.id}</p>)}</TableCell>
              <TableCell className="max-w-48 whitespace-normal break-all">{attempt.actualModel ?? attempt.requestedModel}</TableCell>
              <TableCell><Badge variant="secondary">{messages.statusLabel(attempt.status)}</Badge><p className="text-xs text-muted-foreground">{messages.dispatchLabel(attempt.dispatch)}</p></TableCell>
              <TableCell>{count(attempt.usage.inputTokens)} / {count(attempt.usage.outputTokens)} / {count(attempt.accounting?.totalTokens ?? attempt.usage.totalTokens)}</TableCell>
              <TableCell>{money(cost.cny)}<p className="text-xs text-muted-foreground">{messages.costStatusLabel(cost.status)}</p></TableCell>
            </TableRow>
          })}</TableBody></Table>
          {requests.data.items.length === 0 ? <p>{t('当前授权和保留期内没有请求明细；已发生用量仍计入累计。', 'No request details remain within the current access scope and retention period. Historical usage remains in the totals.')}</p> : null}
          <div className="flex flex-wrap items-center gap-2"><Button variant="outline" size="sm" disabled={offset === 0 || requests.isFetching} onClick={() => setOffset(value => Math.max(0, value - 25))}>{messages.previous}</Button>
            <span>{requests.data.total === 0 ? 0 : offset + 1}–{offset + requests.data.items.length} / {requests.data.total}</span>
            <Button variant="outline" size="sm" disabled={offset + requests.data.items.length >= requests.data.total || requests.isFetching} onClick={() => setOffset(value => value + 25)}>{messages.next}</Button></div>
        </> : null}
      </div> : null}
    </> : null}
    {retention.data ? <p className="text-xs text-muted-foreground">{t('明细保留期限：', 'Request detail retention: ')}{retentionPeriod(retention.data, messages)}{t('；已清理明细无法恢复，累计保留。', '; deleted details cannot be restored, while totals remain.')}</p>
      : retention.error ? <p>{t('明细保留期限暂不可读。', 'Request detail retention is currently unavailable.')}</p> : null}
  </section>
}
