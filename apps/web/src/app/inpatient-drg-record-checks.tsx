import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientDrgRecordChecksSchema, type InpatientDrgRecordChecks } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientDrgExplanationSchema } from '@clinmesh/contracts/inpatient-drg-explanation'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { apiGet } from './api-client.ts'
import { InpatientDrgUsagePanel } from './inpatient-drg-usage.tsx'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'

export type DrgRecordTarget = InpatientDrgRecordChecks['sources'][number]['target']
type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale;
  write: ReturnType<typeof useInpatientWriteIntent>; active: boolean; onOpenRecord?: (target: DrgRecordTarget) => void }

export function InpatientDrgRecordChecksPanel({ admission, session, locale, active, write, onOpenRecord }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const query = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id, 'drg-record-checks'],
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/record-checks`, inpatientDrgRecordChecksSchema, signal),
    enabled: active, refetchInterval: active ? 3_000 : false, refetchIntervalInBackground: false, retry: false })
  const data = query.error === null ? query.data : undefined
  const sourceLabel = (target: DrgRecordTarget) => ({ surgery: t('前往手术原记录', 'Open original surgery record'),
    record: t('前往病案首页原记录', 'Open original medical record'), orders: t('前往诊断医嘱原记录', 'Open original diagnoses and orders'),
    drg: t('前往分组与推演依据', 'Open grouping and simulation sources') })[target]
  return <section aria-label={t('分组记录核对', 'Grouping record checks')} className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2"><h4 className="font-medium">{t('分组记录核对', 'Grouping record checks')}</h4>
      <Button variant="outline" size="sm" disabled={!active || query.isFetching} onClick={() => void query.refetch()}>{t('刷新分组核对', 'Refresh record checks')}</Button></div>
    <p className="text-sm text-muted-foreground">{t('按当前正式记录核对，无需开启跟进。请对照原记录判断；首页、诊断、报告已阅、费用和分组由原入口办理。', 'Checks use current formal records without follow-up. Review original records; use their existing workflows for medical records, diagnoses, report acknowledgements, charges and grouping.')}</p>
    {query.isPending ? <div role="status">{t('正在读取分组记录核对', 'Loading grouping record checks')}<Skeleton className="h-12 w-full" /></div> : null}
    {query.error ? <Alert variant="destructive"><AlertTitle>{t('分组核对读取失败', 'Could not read record checks')}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(query.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    {data ? <>
      {data.status === 'frozen' ? <p role="status">{t('病案已归档，核对只读冻结依据。', 'The medical record is archived; checks use frozen sources.')}</p> : null}
      {data.status === 'incomplete' ? <Alert><AlertTitle>{t('分组核对依据不完整', 'Record checks are incomplete')}</AlertTitle><AlertDescription>{data.missing.join(' · ')}</AlertDescription></Alert> : null}
      {data.issues.map(issue => <Alert key={issue.key}><AlertTitle>{issue.display}</AlertTitle><AlertDescription>
        <p>{issue.explanation}</p>
        <details><summary>{t('查看本项核对来源', 'View sources for this check')}</summary>{issue.evidence.map(reference => <p key={reference} className="break-all text-sm">{data.sources.find(source => source.reference === reference)?.display ?? reference}</p>)}</details>
      </AlertDescription></Alert>)}
      {data.issues.length === 0 && data.status === 'complete' ? <Empty><EmptyHeader><EmptyTitle>{t('当前无本范围核对差异', 'No differences within these checks')}</EmptyTitle><EmptyDescription>{t('已核对实际 PCI 与首页主操作、正式与计划分组以及分组缺项。', 'Checked actual PCI against the medical record, formal against planned grouping, and grouping completeness.')}</EmptyDescription></EmptyHeader></Empty> : null}
      <p role="status">{data.paymentMessage}</p>
      {data.sources.length > 0 ? <section aria-label={t('分组核对原记录', 'Original records for grouping checks')} className="flex flex-col gap-2">
        {data.sources.map(source => <div key={source.reference} className="flex flex-col gap-1"><p>{source.display}</p><p className="break-all text-xs text-muted-foreground">{source.reference}</p>
          {onOpenRecord ? <Button variant="outline" size="sm" onClick={() => onOpenRecord(source.target)}>{sourceLabel(source.target)}</Button> : null}</div>)}
      </section> : null}
      <DrgRecordExplanation admission={admission} session={session} locale={locale} write={write} active={active} checks={data} />
    </> : null}
  </section>
}

function DrgRecordExplanation({ admission, session, locale, active, write, checks }: Props & { checks: InpatientDrgRecordChecks }): React.JSX.Element {
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
    queued: t('解释已请求，正在等待模型处理。', 'The explanation is queued.'),
    running: t('正在生成并核验解释；规则核对仍可使用。', 'Generating and verifying explanations; rule checks remain available.'),
    succeeded: t('解释已完成独立核验，来源如下。', 'The explanation passed independent verification; sources follow.'),
    stale: t('核对依据已变化，旧解释已失效；可按当前依据重新请求。', 'The sources changed and the old explanation is stale; request an explanation for the current sources.'),
    blocked: t('解释派发受阻，请核对模型配置、授权或用量控制。规则结果继续保留。', 'The request is blocked; check model configuration, authorization and usage controls. Rule results are retained.'),
    unknown: t('原解释请求结果未知，请先核查原用量明细；不会自动重发。', 'The original explanation outcome is unknown. Check its usage details first; it will not be resent automatically.'),
    failed: t('解释生成或核验未通过，规则结果继续保留。', 'Generation or verification failed; rule results are retained.'),
    frozen: t('解释已转为只读，保留已核验结果，不再发起模型请求。', 'Explanations are read only; verified results are retained and no model request will be started.'),
  }[data.status] : null
  return <section aria-label={t('按需分组解释', 'On-demand grouping explanation')} className="flex flex-col gap-2">
    <Button variant="outline" disabled={requesting || !active} aria-expanded={expanded} aria-controls={detailId}
      onClick={() => { if (expanded) setExpanded(false); else void request() }}>{expanded ? t('收起 AI 解释', 'Hide AI explanation') : t('展开 AI 解释', 'Expand AI explanation')}</Button>
    {expanded ? <div id={detailId} className="flex flex-col gap-2">
      {explanation.isPending || requesting ? <p role="status">{t('正在读取或请求当前解释', 'Reading or requesting the current explanation')}</p> : null}
      {explanation.error ? <Alert variant="destructive"><AlertTitle>{t('解释状态读取失败', 'Could not read explanation status')}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(explanation.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
      {requestError ? <Alert variant="destructive"><AlertTitle>{t('解释请求未完成', 'Explanation request incomplete')}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(requestError, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
      {statusText ? <p role="status">{statusText}</p> : null}
      {data?.failureCode ? <p className="text-sm text-muted-foreground">{data.failureCode}</p> : null}
      {data?.result && data.result.fingerprint === checks.fingerprint ? <>
        <p className="text-sm text-muted-foreground">{data.result.model} · {data.result.createdAt}</p>
        {data.result.observations.map(item => <article key={item.key} className="flex flex-col gap-1"><p>{item.explanation}</p>
          <details><summary>{t('查看解释来源', 'View explanation sources')}</summary>{item.evidenceIds.map(reference => <p key={reference} className="break-all text-sm">{checks.sources.find(source => source.reference === reference)?.display ?? reference}</p>)}</details></article>)}
      </> : null}
      {doctor && !readonly && data && ['idle', 'stale', 'failed', 'blocked'].includes(data.status) ? <Button variant="outline" disabled={requesting || write.blocked || !active} onClick={() => void request()}>{t('按当前依据请求解释', 'Request explanation for current sources')}</Button> : null}
      <Button variant="outline" size="sm" disabled={explanation.isFetching || !active} onClick={() => void explanation.refetch()}>{t('核查原解释请求', 'Check original explanation request')}</Button>
      {data?.taskId ? <InpatientDrgUsagePanel key={data.taskId} admissionId={admission.id} taskId={data.taskId} session={session} locale={locale} active={active} taskKind="explanation" /> : null}
    </div> : null}
  </section>
}
