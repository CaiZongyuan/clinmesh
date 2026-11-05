import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientDrgRecordChecksSchema, type InpatientDrgRecordChecks, type inpatientDrgReviewIssueSchema } from '@clinmesh/contracts/inpatient-drg-review'
import type { z } from 'zod'
import { inpatientDrgExplanationSchema } from '@clinmesh/contracts/inpatient-drg-explanation'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Badge } from '@clinmesh/ui/components/badge'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2Icon, ChevronRightIcon, CircleIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { apiGet } from './api-client.ts'
import { InpatientDrgUsagePanel } from './inpatient-drg-usage.tsx'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { formatFen } from './workspace-format.ts'

export type DrgRecordTarget = InpatientDrgRecordChecks['sources'][number]['target'] | 'fees'
type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale;
  write: ReturnType<typeof useInpatientWriteIntent>; active: boolean; onOpenRecord?: ((target: DrgRecordTarget) => void) | undefined }

export function InpatientDrgRecordChecksPanel({ admission, session, locale, active, write, onOpenRecord }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const query = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id, 'drg-record-checks'],
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/record-checks`, inpatientDrgRecordChecksSchema, signal),
    enabled: active, refetchInterval: active ? 3_000 : false, refetchIntervalInBackground: false, retry: false })
  const data = query.error === null ? query.data : undefined
  const goLabel = { surgery: t('去手术', 'Open surgery'), record: t('去病案首页', 'Open medical record'), orders: t('去诊断医嘱', 'Open diagnoses and orders') } as const
  const heading = <><h4 className="font-medium">{t('分组核对', 'Grouping checks')}</h4>
    {data ? <Badge variant="outline" className={data.issues.length > 0 ? 'text-warning' : 'text-success'}>{data.issues.length > 0 ? t(`${data.issues.length} 项待处理`, `${data.issues.length} to review`) : t('无差异', 'No differences')}</Badge> : null}<span className="flex-1" /></>
  return <section aria-label={t('分组核对', 'Grouping checks')} className="flex flex-col gap-3">
    {data ? null : <div className="flex flex-wrap items-center gap-2">{heading}</div>}
    {query.isPending ? <div role="status">{t('正在读取分组核对', 'Loading grouping checks')}<Skeleton className="h-12 w-full" /></div> : null}
    {query.error ? <Alert variant="destructive"><AlertTitle>{t('分组核对读取失败', 'Could not read record checks')}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(query.error, getWorkspaceMessages(locale))}
      <Button variant="outline" size="sm" className="self-start" disabled={!active || query.isFetching} onClick={() => void query.refetch()}>{t('重新读取', 'Retry')}</Button></AlertDescription></Alert> : null}
    {data ? <InpatientDrgRecordExplanation admission={admission} session={session} locale={locale} write={write} active={active} checks={data} header={heading}>
      {data.status === 'frozen' ? <p role="status">{t('病案已归档，仅查看归档时的核对依据。', 'The medical record is archived; checks use the archived sources.')}</p> : null}
      {data.status === 'incomplete' ? <Alert><AlertTitle>{t('分组核对依据不完整', 'Record checks are incomplete')}</AlertTitle><AlertDescription>{data.missing.join(' · ')}</AlertDescription></Alert> : null}
      {data.issues.map(issue => <Alert key={issue.key}><AlertTitle>{issue.display}</AlertTitle><AlertDescription>
        <p>{issue.explanation}</p>
        <InpatientDrgIssueDetails issue={issue} locale={locale} onOpenRecord={onOpenRecord} />
        <details><summary>{t('查看本项核对来源', 'View sources for this check')}</summary>{issue.evidence.map(reference => <p key={reference} className="break-all text-sm">{data.sources.find(source => source.reference === reference)?.display ?? reference}</p>)}</details>
      </AlertDescription></Alert>)}
      {data.issues.length === 0 && data.status === 'complete' ? <p className="text-sm text-muted-foreground">{t('当前无本范围核对差异', 'No differences within these checks')}</p> : null}
      {data.paymentStatus !== 'available' ? <p role="status" className="text-sm">{data.paymentMessage}</p> : null}
      {data.sources.length > 0 ? <ul aria-label={t('分组核对清单', 'Grouping checklist')} className="clinmesh-inpatient-preparation-list">{data.sources.map(source => {
        const display = source.display.replace('clinmesh-chs-drg-1.1@', 'clinmesh-chs-drg-1.1 / ')
        const [label, ...rest] = display.split('：'), value = rest.join('：')
        const pending = value.includes('尚未选择') || value.includes('未确认') || value.includes('待处理')
        return <li key={source.reference} data-complete={!pending}>
          {pending ? <CircleIcon aria-hidden="true" className="text-warning" /> : <CheckCircle2Icon aria-hidden="true" className="text-success" />}
          <div>{value ? <><span className="text-xs text-muted-foreground">{label}</span><span>{value}</span></> : <span>{display}</span>}</div>
          <div className="clinmesh-inpatient-preparation-owner">{source.target !== 'drg' && onOpenRecord ? <Button variant="link" size="sm" className="text-info" onClick={() => onOpenRecord(source.target)}>{goLabel[source.target]}<ChevronRightIcon aria-hidden="true" data-icon="inline-end" /></Button> : null}</div>
        </li>
      })}</ul> : null}
      <p className="text-xs text-muted-foreground">{t('对照原记录判断；首页、诊断和手术在各自页签修改，本页只核对。', 'Compare with the original records; change the record, diagnoses and surgery in their own tabs. This page only checks.')}</p>
      {data.sources.length > 0 ? <details className="text-xs text-muted-foreground"><summary>{t('查看核对来源', 'View check sources')}</summary>{data.sources.map(source => <p key={source.reference} className="break-all">{source.display.replace('clinmesh-chs-drg-1.1@', 'clinmesh-chs-drg-1.1 / ')} · {source.reference.replace(/\b([0-9a-f]{8})[0-9a-f]{48}([0-9a-f]{8})\b/gi, '$1…$2')}</p>)}</details> : null}
    </InpatientDrgRecordExplanation> : null}
  </section>
}

export function InpatientDrgIssueDetails({ issue, locale, financial = false, onOpenRecord }: { issue: z.infer<typeof inpatientDrgReviewIssueSchema>; locale: WorkspaceLocale; financial?: boolean; onOpenRecord?: ((target: DrgRecordTarget) => void) | undefined }): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const target = issue.target === 'charges' ? 'fees' : issue.target
  return <div className="flex flex-col gap-1">
    {issue.procedureDisplay ? <p>{t('手术：', 'Procedure: ')}{issue.procedureDisplay}</p> : null}
    {!financial && (issue.plannedQuantity !== null || issue.actualQuantity !== null) ? <p className="tabular-nums">{t('计划量：', 'Planned: ')}{issue.plannedQuantity ?? t('未确认', 'Unconfirmed')} · {t('实际量：', 'Actual: ')}{issue.actualQuantity ?? t('未记录', 'Not recorded')}</p> : null}
    {issue.expectedChargeFen !== null && issue.expectedChargeFen !== undefined ? <p className="tabular-nums">{t('应计费用：', 'Expected charge: ')}{formatFen(issue.expectedChargeFen, locale)}</p> : null}
    {issue.actualChargeFen !== null && issue.actualChargeFen !== undefined ? <p className="tabular-nums">{t('正式费用合计（已扣除退费）：', 'Posted net charge: ')}{formatFen(issue.actualChargeFen, locale)}</p> : null}
    {issue.chargeDifferenceFen !== null && issue.chargeDifferenceFen !== undefined ? <p className="tabular-nums">{t('收费差额：', 'Charge difference: ')}{formatFen(issue.chargeDifferenceFen, locale)}<span className="text-sm text-muted-foreground">{t('（扣除退费后的费用合计减应计费用）', ' (posted net minus expected)')}</span></p> : null}
    {target && onOpenRecord && (!financial || target === 'fees') ? <Button variant="outline" size="sm" className="self-start" onClick={() => onOpenRecord(target)}>{target === 'fees' ? t('前往费用原记录', 'Open original charge records') : target === 'record' ? t('前往病案首页原记录', 'Open original medical record') : t('前往手术原记录', 'Open original surgery record')}</Button> : null}
  </div>
}

export function InpatientDrgRecordExplanation({ admission, session, locale, active, write, checks, header, children }: Props & { checks: InpatientDrgRecordChecks; header: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const [expanded, setExpanded] = useState(false), [requesting, setRequesting] = useState(false)
  const detailId = useId(), mounted = useRef(true), inFlight = useRef(false)
  const live = useRef({ active, fingerprint: checks.fingerprint })
  live.current = { active, fingerprint: checks.fingerprint }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const explanation = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId,
    admission.id, 'drg-record-explanation', checks.fingerprint],
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/record-checks/explanation`, inpatientDrgExplanationSchema, signal),
    enabled: active && expanded, refetchInterval: active && expanded ? 3_000 : false, refetchIntervalInBackground: false, retry: false })
  const data = explanation.error === null && explanation.data?.fingerprint === checks.fingerprint ? explanation.data : undefined
  const attempted = write.mutation.variables
  const requestError = attempted?.operation === 'inpatient.drg.record-checks.explain' && attempted.input.admissionId === admission.id
    && attempted.input.expectedFingerprint === checks.fingerprint ? write.mutation.error : null
  const doctor = session.actor.roleCode === 'inpatient-doctor', readonly = admission.recordStatus === 'archived' || checks.status === 'frozen'
  const request = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setRequesting(true); setExpanded(true)
    const fingerprint = checks.fingerprint
    try {
      const response = await explanation.refetch(), current = response.error === null ? response.data : undefined
      if (!mounted.current || !live.current.active || live.current.fingerprint !== fingerprint || !current || current.fingerprint !== fingerprint) return
      if (doctor && !readonly && !write.blocked && ['idle', 'stale', 'failed', 'blocked'].includes(current.status)) {
        await write.mutation.mutateAsync({ operation: 'inpatient.drg.record-checks.explain', input: {
          admissionId: admission.id, expectedFingerprint: fingerprint, expectedVersion: current.version } })
        if (mounted.current && live.current.fingerprint === fingerprint) await explanation.refetch()
      }
    } catch { /* 持久写意图保留原错误及回执恢复，规则结果继续可见。 */ }
    finally { inFlight.current = false; if (mounted.current) setRequesting(false) }
  }
  const statusText = data ? {
    idle: doctor ? t('尚未生成解释。', 'An explanation has not been requested.') : t('当前岗位可读取已生成解释，请由住院医生请求。', 'This role can read existing explanations; ask the inpatient doctor to request one.'),
    queued: t('解释已请求，正在等待 AI 处理。', 'The explanation is queued.'),
    running: t('正在生成并核验解释；规则核对仍可使用。', 'Generating and verifying explanations; rule checks remain available.'),
    succeeded: t('解释已完成独立核验，来源如下。', 'The explanation passed independent verification; sources follow.'),
    stale: t('核对依据已变化，旧解释已失效；可按当前依据重新请求。', 'The sources changed and the old explanation is stale; request an explanation for the current sources.'),
    blocked: t('解释请求受阻，请核对 AI 设置、使用权限或用量限制。规则结果继续保留。', 'The request is blocked; check AI settings, usage permissions and usage limits. Rule results are retained.'),
    unknown: t('原解释请求结果未知，请先核查原用量明细；不会自动重发。', 'The original explanation outcome is unknown. Check its usage details first; it will not be resent automatically.'),
    failed: t('解释生成或核验未通过，规则结果继续保留。', 'Generation or verification failed; rule results are retained.'),
    frozen: t('病案已归档，解释状态与原请求只读可查，不再发起 AI 请求。', 'The medical record is archived. Explanation status and original requests remain available to read; no AI request will be started.'),
  }[data.status] : null
  return <>
    <div className="flex flex-wrap items-center gap-2">{header}
      <Button variant="ghost" size="sm" disabled={requesting || !active} aria-expanded={expanded} aria-controls={detailId}
        onClick={() => { if (expanded) setExpanded(false); else void request() }}>{expanded ? t('收起 AI 解释', 'Hide AI explanation') : t('AI 解释', 'AI explanation')}</Button></div>
    {children}
    {expanded ? <section id={detailId} aria-label={t('按需分组解释', 'On-demand grouping explanation')} className="flex flex-col gap-2 rounded-md bg-muted p-3">
      {explanation.isPending || requesting ? <p role="status">{t('正在读取或请求当前解释', 'Reading or requesting the current explanation')}</p> : null}
      {explanation.error ? <Alert variant="destructive"><AlertTitle>{t('解释状态读取失败', 'Could not read explanation status')}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(explanation.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
      {requestError ? <Alert variant="destructive"><AlertTitle>{t('解释请求未完成', 'Explanation request incomplete')}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(requestError, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
      {statusText ? <p role="status">{statusText}</p> : null}
      {data?.result && data.result.fingerprint === checks.fingerprint ? <>
        <p className="text-sm text-muted-foreground">{t('生成时间：', 'Created: ')}{new Date(data.result.createdAt).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })}</p><details><summary>{t('查看分析技术来源', 'View analysis technical sources')}</summary><p>{data.result.model} · {data.result.createdAt}</p></details>
        {data.result.costExplanation ? <section aria-label={t('当前AI费用说明', 'Current AI cost explanation')}><h5 className="font-medium">{t('当前AI费用说明', 'Current AI cost explanation')}</h5><p>{data.result.costExplanation}</p></section> : null}
        {data.result.observations.map(item => <article key={item.key} className="flex flex-col gap-1"><p>{item.explanation}</p>
          <details><summary>{t('查看解释来源', 'View explanation sources')}</summary>{item.evidenceIds.map(reference => <p key={reference} className="break-all text-sm">{checks.sources.find(source => source.reference === reference)?.display ?? reference}</p>)}</details></article>)}
      </> : null}
      {doctor && !readonly && data && ['idle', 'stale', 'failed', 'blocked'].includes(data.status) ? <Button variant="outline" disabled={requesting || write.blocked || !active} onClick={() => void request()}>{t('按当前依据请求解释', 'Request explanation for current sources')}</Button> : null}
      <Button variant="outline" size="sm" disabled={explanation.isFetching || !active} onClick={() => void explanation.refetch()}>{t('核查原解释请求', 'Check original explanation request')}</Button>
      {data?.taskId ? <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">{t('查看 AI 调用耗时与 Token 审计明细', 'View AI latency and token audit details')}</summary><div className="pt-2"><InpatientDrgUsagePanel key={data.taskId} admissionId={admission.id} taskId={data.taskId} session={session} locale={locale} active={active} taskKind="explanation" /></div></details> : null}
    </section> : null}
  </>
}
