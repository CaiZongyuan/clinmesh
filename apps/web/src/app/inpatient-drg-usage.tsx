import { useId, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
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
import { ModelUsageCorrections } from './model-usage-corrections.tsx'
import { retentionPeriod } from './model-usage-retention.tsx'
import { inpatientScopeKey } from './inpatient-scope.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

type Props = { admissionId: string; taskId?: string | undefined; stageTaskId?: string | undefined; session: SessionContext; locale: WorkspaceLocale; active: boolean; taskKind?: 'estimate' | 'followup' | 'explanation' | 'guideline' | undefined; compact?: boolean | undefined; readOnly?: boolean | undefined }
type Stage = NonNullable<ModelUsageOverview['stages']>[number]

function stageLabel(stage: string, locale: WorkspaceLocale) {
  const guideline = /^guideline-(\d+)-(generation|verification)$/.exec(stage)
  if (guideline) return locale === 'zh-CN' ? `第 ${guideline[1]} 轮指南意见${guideline[2] === 'generation' ? '生成' : '核验'}`
    : `Guideline advice ${guideline[1]} ${guideline[2]}`
  const estimate = /^estimate-(\d+)-(generation|verification)$/.exec(stage)
  if (estimate) return locale === 'zh-CN' ? `第 ${estimate[1]} 轮预计${estimate[2] === 'generation' ? '生成' : '核验'}`
    : `Estimate ${estimate[1]} ${estimate[2]}`
  const explanation = /^record-check-(\d+)-(generation|verification)$/.exec(stage)
  if (explanation) return locale === 'zh-CN' ? `第 ${explanation[1]} 轮核对解释${explanation[2] === 'generation' ? '生成' : '核验'}`
    : `Record explanation ${explanation[1]} ${explanation[2]}`
  const labels: Record<string, readonly [string, string]> = {
    'preoperative-generation': ['术前生成', 'Preoperative generation'], 'preoperative-verification': ['术前核验', 'Preoperative verification'],
    'intraoperative-generation': ['术中生成', 'Intraoperative generation'], 'intraoperative-verification': ['术中核验', 'Intraoperative verification'],
    'postoperative-generation': ['术后生成', 'Postoperative generation'], 'postoperative-verification': ['术后核验', 'Postoperative verification'],
    'record-check-generation': ['核对解释生成', 'Record explanation generation'], 'record-check-verification': ['核对解释核验', 'Record explanation verification'],
  }
  return labels[stage]?.[locale === 'zh-CN' ? 0 : 1] ?? stage
}

function triggerSourceLabel(id: string, locale: WorkspaceLocale) {
  const labels: Record<string, readonly [string, string]> = {
    ServiceRequest: ['手术计划更新', 'Surgery plan updated'],
    InpatientPciSelection: ['选型参数更新', 'Selection parameters updated'],
    Procedure: ['手术记录更新', 'Surgery record updated'],
    InpatientSurgeryMaterial: ['实际耗材使用更新', 'Actual material use updated'],
    InpatientSurgeryMaterialCorrection: ['耗材使用更正', 'Material use corrected'],
    DrgBasis: ['分组或费用依据更新', 'Grouping or charge sources updated'],
    InpatientDrgReview: ['术后核查依据更新', 'Postoperative review sources updated'],
  }
  return labels[id.split('/')[0] ?? '']?.[locale === 'zh-CN' ? 0 : 1]
}

function stagePurpose(stage: string, locale: WorkspaceLocale) {
  if (stage.startsWith('guideline-')) return locale === 'zh-CN' ? '选型参数与指南参考' : 'Selection & guideline reference'
  if (stage.startsWith('estimate-') || stage.startsWith('preoperative-') || stage.startsWith('intraoperative-') || stage.startsWith('postoperative-')) {
    return locale === 'zh-CN' ? '手术耗材预填' : 'Surgical material prefill'
  }
  if (stage.startsWith('record-check-')) return locale === 'zh-CN' ? '分组差异说明' : 'Grouping difference explanation'
  return stageLabel(stage, locale)
}

export function InpatientDrgUsagePanel({ admissionId, taskId, stageTaskId, session, locale, active, taskKind = 'followup', compact = false, readOnly = false }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const messages = modelUsageMessages(locale)
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false), [offset, setOffset] = useState(0)
  const [stagesOpen, setStagesOpen] = useState(false)
  const [correctionId, setCorrectionId] = useState<string>()
  const correctionTrigger = useRef<HTMLButtonElement>(null)
  const canCorrectUsage = !readOnly && (session.actor.roleCode === 'administrator' || session.availableRoles.some(role => role.code === 'administrator'))
  const detailId = useId()
  const scope = [...inpatientScopeKey(session), admissionId, 'drg-model-usage', taskId ?? 'all', session.user.id, session.actor.actorId, session.actor.roleCode]
  const filters = { caseId: admissionId, ...(taskId ? { taskId } : {}), offset: 0, limit: 25 }
  const poll = { enabled: active, refetchInterval: active ? 3_000 : false, refetchIntervalInBackground: false, retry: false } as const
  const overview = useQuery({ queryKey: [...scope, 'overview'], queryFn: ({ signal }) => getModelUsageOverview(filters, signal), ...poll })
  const stageOverview = useQuery({ queryKey: [...scope, 'stages', stageTaskId],
    queryFn: ({ signal }) => getModelUsageOverview({ ...filters, taskId: stageTaskId }, signal), ...poll,
    enabled: active && stagesOpen && taskId === undefined && stageTaskId !== undefined,
    refetchInterval: active && stagesOpen ? 3_000 : false })
  const requests = useQuery({ queryKey: [...scope, 'requests', offset],
    queryFn: ({ signal }) => getModelUsageRequests({ ...filters, offset }, signal), ...poll, enabled: active && expanded })
  const retention = useQuery({ queryKey: ['model-usage', 'retention', session.actor.workspaceId, session.user.id, session.actor.roleCode],
    queryFn: ({ signal }) => getModelUsageRetention(signal), enabled: active, retry: false })
  const correction = requests.data?.items.find(item => item.id === correctionId)
  const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 })
  const currencyFormat = new Intl.NumberFormat(locale, { style: 'currency', currency: 'CNY', maximumFractionDigits: 6 })
  const count = (value: number | null) => value === null ? messages.unknown : numberFormat.format(value)
  const tokens = (known: number, unknown: number) => count(known === 0 && unknown > 0 ? null : known)
  const money = (value: number | null) => value === null ? messages.unknown : currencyFormat.format(value)
  const errorText = (error: unknown) => error instanceof ApiClientError && (error.status === 403 || error.status === 404)
    ? t('当前岗位无权读取本次住院AI用量，或该病例已不可访问。', 'This role cannot read AI usage for this admission, or the admission is no longer accessible.')
    : t('本次住院AI用量读取失败，请重试。', 'Unable to read AI usage for this admission. Retry the request.')
  const totals = overview.data?.totals
  const stages = overview.data?.stages ?? (stageOverview.error === null ? stageOverview.data?.stages : undefined)
  const metrics = totals ? [
    { label: t('实际AI请求数', 'Actual AI requests'), value: count(totals.requests) },
    { label: t('已知输入 Token', 'Known input tokens'), value: tokens(totals.knownInputTokens, totals.unknownInputTokenRequests) },
    { label: t('已知输出 Token', 'Known output tokens'), value: tokens(totals.knownOutputTokens, totals.unknownOutputTokenRequests) },
    { label: t('已知总 Token', 'Known total tokens'), value: tokens(totals.knownTokens, totals.unknownTokenRequests) },
    { label: t('估算人民币费用', 'Estimated CNY cost'), value: totals.requests === 0 ? t('尚无请求', 'No requests yet') : money(totals.cny) },
  ] : []
  const purposeRows = (() => {
    const grouped = new Map<string, Stage>()
    for (const s of stages ?? []) {
      const key = stagePurpose(s.stage, locale)
      const prev = grouped.get(key)
      if (!prev) grouped.set(key, { ...s, stage: key })
      else {
        prev.requests += s.requests
        prev.inFlight += s.inFlight
        prev.unknownRequests += s.unknownRequests
        prev.knownInputTokens += s.knownInputTokens
        prev.knownOutputTokens += s.knownOutputTokens
        prev.knownTokens += s.knownTokens
        prev.unknownInputTokenRequests += s.unknownInputTokenRequests
        prev.unknownOutputTokenRequests += s.unknownOutputTokenRequests
        prev.unknownTokenRequests += s.unknownTokenRequests
        prev.unpricedRequests += s.unpricedRequests
        prev.cny = prev.cny === null || s.cny === null ? null : prev.cny + s.cny
      }
    }
    return [...grouped.values()]
  })()
  const stageTokens = (stage: Stage, includeTotal = !compact) => [
    tokens(stage.knownInputTokens, stage.unknownInputTokenRequests),
    tokens(stage.knownOutputTokens, stage.unknownOutputTokenRequests),
    ...(includeTotal ? [tokens(stage.knownTokens, stage.unknownTokenRequests)] : []),
  ].join(' / ')
  const stageTable = stages ? <Table aria-label={t('AI阶段累计', 'AI usage by stage')}><TableHeader><TableRow>
    <TableHead>{messages.stage}</TableHead><TableHead>{messages.requestCount}</TableHead>
    <TableHead>{t('输入 / 输出 / 总 Token', 'Input / output / total tokens')}</TableHead><TableHead>{t('估算人民币费用', 'Estimated CNY cost')}</TableHead>
  </TableRow></TableHeader><TableBody>{stages.map(stage => <TableRow key={stage.stage}>
    <TableCell>{stageLabel(stage.stage, locale)}</TableCell><TableCell>{stage.requests}</TableCell><TableCell>{stageTokens(stage, true)}
      {stage.unknownTokenRequests > 0 ? <p className="text-xs text-muted-foreground">{stage.unknownTokenRequests} {messages.unknownTokenRequests}</p> : null}</TableCell>
    <TableCell>{money(stage.cny)}{stage.unpricedRequests > 0 ? <p className="text-xs text-muted-foreground">{stage.unpricedRequests} {messages.unpricedRequests}</p> : null}</TableCell>
  </TableRow>)}</TableBody></Table> : <p>{t('阶段累计暂不可用。', 'Stage totals are unavailable.')}</p>
  return <section aria-label={t('本次住院AI用量', 'AI usage for this admission')} className="flex min-w-0 flex-col gap-3">
    {!compact ? <>
      <div className="flex flex-wrap items-center gap-2"><h5 className="font-medium">{t('本次住院AI用量', 'AI usage for this admission')}</h5>
        <Button variant="outline" size="sm" disabled={!active || overview.isFetching} onClick={() => {
          void overview.refetch(); if (expanded) void requests.refetch(); void retention.refetch()
        }}>{t('刷新病例用量', 'Refresh admission usage')}</Button></div>
      <p className="text-sm text-muted-foreground">{taskKind === 'estimate'
        ? t('仅归集本次住院、当前手术预计的实际AI请求；刷新、重启或取消预计不会清零。未知结果先核查原请求，不重新安排。', 'Only actual requests for this admission and surgery estimate are included. Refreshing, restarting or cancelling does not reset usage. Reconcile unknown original requests before redispatch.')
        : taskKind === 'explanation' ? t('仅归集本次住院、当前按需解释的实际AI请求；关闭解释或刷新不会清零。未知结果先核查原请求，不重新安排。', 'Only actual requests for this admission and explanation are included. Closing or refreshing does not reset usage. Check unknown original requests before redispatch.')
          : taskKind === 'guideline' ? t('仅归集本次住院、当前指南意见任务的实际AI请求；刷新、取消或显式重评不会清零。结果未知时先核查原请求，不重新发起AI请求。', 'Only actual requests for this admission and guideline advice task are included. Refreshing, cancelling or reassessing does not reset usage. Check unknown original requests before redispatch.')
            : t('仅归集本次住院、当前跟进任务的实际AI请求；关闭页面、重启或停止跟进不会清零。', 'Only actual AI requests for this admission and follow-up task are included. Closing the page, restarting or stopping follow-up does not reset usage.')}</p>
    </> : null}
    {overview.isPending ? <div role="status">{messages.loading}<Skeleton className="h-12 w-full" /></div> : null}
    {overview.error ? <Alert variant="destructive"><AlertDescription>{errorText(overview.error)}</AlertDescription></Alert> : null}
    {totals && !overview.error ? <>{compact ? <>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">{metrics.map((metric, index) => <div key={metric.label} className={index === 1 || index === 2 ? 'sr-only' : undefined}><dt className="text-xs text-muted-foreground">{metric.label}</dt><dd className="tabular-nums text-lg font-semibold" aria-label={metric.label}>{metric.value}</dd></div>)}</dl>
      {totals.inFlight > 0 || totals.unknownRequests > 0 ? <div role="status" className="flex flex-wrap items-center gap-2 text-sm">
        {totals.inFlight > 0 ? <span>{t('进行中 ', 'In flight ')}{totals.inFlight}</span> : null}
        {totals.unknownRequests > 0 ? <><span className="text-warning">{t('结果未知 ', 'Unknown outcomes ')}{totals.unknownRequests}</span><Button variant="outline" size="sm" onClick={() => { setOffset(0); setExpanded(true) }}>{t(`核查未决请求（${totals.unknownRequests}）`, `Review unresolved requests (${totals.unknownRequests})`)}</Button></> : null}
      </div> : null}
      {totals.requests === 0 ? <p className="text-sm text-muted-foreground">{t('本次住院尚无AI请求', 'No AI requests for this admission yet')}</p> : null}
      {stagesOpen && purposeRows.length > 0 ? <Table aria-label={t('AI用途汇总', 'AI usage by purpose')}>
        <caption className="caption-top pb-2 text-left text-xs text-muted-foreground">{taskId ? t('当前任务用途汇总', 'Usage by purpose for this task') : t('当前跟进任务用途汇总；住院累计包含全部任务。', 'Usage by purpose for the current follow-up task; admission totals include all tasks.')}</caption>
        <TableHeader><TableRow>
          <TableHead>{t('用途', 'Purpose')}</TableHead>
          <TableHead>{t('请求', 'Requests')}</TableHead>
          <TableHead>{t('输入 / 输出 Token', 'Input / output tokens')}</TableHead>
          <TableHead className="text-right">{t('估算费用', 'Estimated cost')}</TableHead>
          <TableHead>{t('结果', 'Result')}</TableHead>
        </TableRow></TableHeader>
        <TableBody>{purposeRows.map(row => <TableRow key={row.stage}>
          <TableCell>{row.stage}</TableCell>
          <TableCell className="tabular-nums">{row.requests}</TableCell>
          <TableCell className="tabular-nums">{stageTokens(row)}{row.unknownTokenRequests > 0 ? <span className="ml-1 text-xs text-muted-foreground">({row.unknownTokenRequests} {messages.unknownTokenRequests})</span> : null}</TableCell>
          <TableCell className="text-right tabular-nums">{money(row.cny)}</TableCell>
          <TableCell><div className="flex flex-col gap-1">{row.unknownRequests > 0 ? <span className="text-warning">{t('结果未知 ', 'Unknown outcomes ')}{row.unknownRequests}</span> : null}{row.inFlight > 0 ? <span>{t('进行中 ', 'In flight ')}{row.inFlight}</span> : null}{row.unpricedRequests > 0 || row.unknownTokenRequests > 0 ? <span>{t('用量待核查', 'Usage needs review')}</span> : row.unknownRequests === 0 && row.inFlight === 0 ? <span>{t('已完成', 'Completed')}</span> : null}</div></TableCell>
        </TableRow>)}</TableBody>
      </Table> : null}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{taskId ? t('仅统计当前任务；停止跟进不清零。', 'Current task only; stopping follow-up does not reset usage.') : t('累计本次住院各任务的实际请求；停止跟进不清零。', 'Actual requests across all tasks in this admission; stopping follow-up does not reset usage.')}</span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" aria-expanded={stagesOpen} onClick={() => setStagesOpen(value => !value)}>{stagesOpen ? t('收起阶段累计', 'Hide stage totals') : t('查看阶段累计', 'View stage totals')}</Button>
          <Button variant="ghost" size="sm" disabled={!active || overview.isFetching} onClick={() => {
            void overview.refetch(); if (expanded) void requests.refetch(); void retention.refetch()
          }}>{t('刷新病例用量', 'Refresh admission usage')}</Button>
          <Button variant="outline" size="sm" aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded(value => !value)}>
            {expanded ? t('收起AI请求明细', 'Hide AI request details') : t('展开AI请求明细', 'Show AI request details')}</Button>
        </div>
      </div>
      {stagesOpen ? <>
        {taskId === undefined && stageTaskId !== undefined ? <p className="text-xs text-muted-foreground">{t('阶段累计限当前跟进任务；上方总额包含本次住院全部任务。', 'Stage totals cover the current follow-up task; the summary above includes all tasks in this admission.')}</p> : null}
        {stageOverview.isFetching ? <p role="status">{messages.loading}</p> : null}
        {stageOverview.error ? <Alert variant="destructive"><AlertDescription>{errorText(stageOverview.error)}</AlertDescription></Alert> : stageTable}
      </> : null}
    </> : <>
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{metrics.map(metric => <div key={metric.label}>
        <dt className="text-sm text-muted-foreground">{metric.label}</dt><dd aria-label={metric.label} className="tabular-nums">{metric.value}</dd>
      </div>)}</dl>
      <p>{t('进行中 ', 'In flight ')}{totals.inFlight} · {t('结果未知 ', 'Unknown outcomes ')}{totals.unknownRequests}
        {' · '}{totals.unknownTokenRequests} {messages.unknownTokenRequests} · {totals.unpricedRequests} {messages.unpricedRequests}</p>
      <p className="text-sm text-muted-foreground">{t('输入用量不完整 ', 'Incomplete input usage ')}{totals.unknownInputTokenRequests} · {t('输出用量不完整 ', 'Incomplete output usage ')}{totals.unknownOutputTokenRequests}</p>
      <p className="text-xs text-muted-foreground">{messages.tokenExplanation}</p>
      {totals.requests === 0 ? <Empty><EmptyHeader><EmptyTitle>{taskKind === 'estimate' ? t('本次预计尚无AI请求', 'No AI requests for this estimate yet') : taskKind === 'explanation' ? t('本次解释尚无AI请求', 'No AI requests for this explanation yet') : taskKind === 'guideline' ? t('本次指南意见尚无AI请求', 'No AI requests for this guideline advice yet') : t('本次跟进尚无AI请求', 'No AI requests for this follow-up yet')}</EmptyTitle>
        <EmptyDescription>{t('规则检查和有效结果复用不新增AI请求。', 'Rule checks and reuse of valid results do not add AI requests.')}</EmptyDescription></EmptyHeader></Empty> : null}
      {stages ? <>
        {stageTable}
        {taskKind === 'followup' ? ([['preoperative', '术前', 'preoperative'], ['intraoperative', '术中', 'intraoperative'], ['postoperative', '术后', 'postoperative']] as const)
          .filter(([stage]) => !stages.some(item => item.stage.startsWith(`${stage}-`) && item.requests > 0))
          .map(([stage, cn, en]) => <p key={stage} className="text-sm text-muted-foreground">{t(`尚无${cn}AI调用`, `No ${en} model calls yet`)}</p>) : null}
      </> : <p>{t('阶段累计暂不可用。', 'Stage totals are unavailable.')}</p>}
      <Button variant="outline" aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded(value => !value)}>
        {expanded ? t('收起AI请求明细', 'Hide AI request details') : t('展开AI请求明细', 'Show AI request details')}</Button>
    </>}
      {expanded ? <div id={detailId} className="flex min-w-0 flex-col gap-3">
        {requests.isPending ? <p role="status">{messages.loading}</p> : null}
        {requests.error ? <Alert variant="destructive"><AlertDescription>{errorText(requests.error)}</AlertDescription></Alert> : null}
        {requests.data && !requests.error ? <>
          <Table aria-label={t('本次住院AI请求明细', 'AI request details for this admission')}><TableHeader><TableRow>
            <TableHead>{messages.requestTime}</TableHead><TableHead>{messages.stage}</TableHead><TableHead>{t('触发与请求类型', 'Trigger and request kind')}</TableHead>
            <TableHead>{messages.model}</TableHead><TableHead>{messages.result}</TableHead><TableHead>{t('输入 / 输出 / 总 Token', 'Input / output / total tokens')}</TableHead><TableHead>{t('估算人民币费用', 'Estimated CNY cost')}</TableHead>
            {canCorrectUsage ? <TableHead>{messages.corrections}</TableHead> : null}
          </TableRow></TableHeader><TableBody>{requests.data.items.map(attempt => {
            const cost = attempt.effectiveCost ?? attempt.cost
            return <TableRow key={attempt.id}><TableCell>{new Date(attempt.startedAt).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })}</TableCell>
              <TableCell>{stageLabel(attempt.context.stage, locale)}</TableCell><TableCell>{messages.triggerLabel(attempt.context.trigger)} · {messages.kindLabel(attempt.kind)}
                {attempt.context.sources.filter(source => source.relationship === 'trigger').map(source => <p key={`${source.kind}:${source.id}`} className="max-w-48 break-all text-xs text-muted-foreground">{triggerSourceLabel(source.id, locale) ?? t('后台任务事件', 'Background task event')}{canCorrectUsage ? ` · ${source.id}` : ''}</p>)}</TableCell>
              <TableCell className="max-w-48 whitespace-normal break-all">{attempt.actualModel ?? attempt.requestedModel}</TableCell>
              <TableCell><Badge variant="secondary">{messages.statusLabel(attempt.status)}</Badge><p className="text-xs text-muted-foreground">{messages.dispatchLabel(attempt.dispatch)}</p></TableCell>
              <TableCell>{count(attempt.usage.inputTokens)} / {count(attempt.usage.outputTokens)} / {count(attempt.accounting?.totalTokens ?? attempt.usage.totalTokens)}</TableCell>
              <TableCell>{money(cost.cny)}<p className="text-xs text-muted-foreground">{messages.costStatusLabel(cost.status)}</p></TableCell>
              {canCorrectUsage ? <TableCell><Button variant="outline" size="sm" aria-expanded={correctionId === attempt.id}
                aria-controls={`${detailId}-correction`} disabled={attempt.status === 'in-flight' || attempt.dispatch === 'not-dispatched'} onClick={event => {
                  correctionTrigger.current = event.currentTarget; setCorrectionId(attempt.id)
                }}>{t('查看计量核对', 'Review usage accounting')}</Button></TableCell> : null}
            </TableRow>
          })}</TableBody></Table>
          {requests.data.items.length === 0 ? <p>{t('当前权限和保留期内没有请求明细；已发生用量仍计入累计。', 'No request details remain within the current access scope and retention period. Historical usage remains in the totals.')}</p> : null}
          <div className="flex flex-wrap items-center gap-2"><Button variant="outline" size="sm" disabled={offset === 0 || requests.isFetching} onClick={() => setOffset(value => Math.max(0, value - 25))}>{messages.previous}</Button>
            <span>{requests.data.total === 0 ? 0 : offset + 1}–{offset + requests.data.items.length} / {requests.data.total}</span>
            <Button variant="outline" size="sm" disabled={offset + requests.data.items.length >= requests.data.total || requests.isFetching} onClick={() => setOffset(value => value + 25)}>{messages.next}</Button></div>
          {canCorrectUsage && correction ? <section id={`${detailId}-correction`} aria-label={t('本次住院计量核对', 'Admission usage accounting')} className="flex flex-col gap-3">
            <ModelUsageCorrections item={correction} locale={locale} administrator saved={() => {
              void queryClient.invalidateQueries({ queryKey: scope })
              void queryClient.invalidateQueries({ queryKey: ['model-usage'] })
            }} />
            <Button variant="outline" onClick={() => { correctionTrigger.current?.focus(); setCorrectionId(undefined) }}>{t('收起计量核对', 'Close usage accounting')}</Button>
          </section> : null}
        </> : null}
      </div> : null}
    </> : null}
    {retention.data ? <p className="text-xs text-muted-foreground">{t('明细保留期限：', 'Request detail retention: ')}{retentionPeriod(retention.data, messages)}{t('；已清理明细无法恢复，累计保留。', '; deleted details cannot be restored, while totals remain.')}</p>
      : retention.error ? <p>{t('明细保留期限暂不可读。', 'Request detail retention is currently unavailable.')}</p> : null}
  </section>
}
