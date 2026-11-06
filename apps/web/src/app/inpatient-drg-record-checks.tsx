import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientDrgExplanationSchema } from '@clinmesh/contracts/inpatient-drg-explanation'
import { inpatientDrgRecordChecksSchema, type InpatientDrgRecordChecks, type inpatientDrgReviewIssueSchema } from '@clinmesh/contracts/inpatient-drg-review'
import type { z } from 'zod'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Badge } from '@clinmesh/ui/components/badge'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Spinner } from '@clinmesh/ui/components/spinner'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2Icon, ChevronRightIcon, CircleIcon } from 'lucide-react'
import { apiGet } from './api-client.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { formatFen } from './workspace-format.ts'

export type DrgRecordTarget = InpatientDrgRecordChecks['sources'][number]['target'] | 'fees'
type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale;
  write: ReturnType<typeof useInpatientWriteIntent>; active: boolean; followOn?: boolean | undefined; onOpenRecord?: ((target: DrgRecordTarget) => void) | undefined }

function formatCheckSourceDisplay(source: InpatientDrgRecordChecks['sources'][number], admission: InpatientAdmission, locale: WorkspaceLocale): {
  label: string
  value: string
  state: 'ok' | 'wait' | 'todo'
} {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const [rawLabel = '', ...rest] = source.display.split('：')
  const rawValue = rest.join('：').trim()
  if (rawLabel === '分组规则' || source.reference.startsWith('DrgRules/')) {
    return {
      label: rawLabel || t('分组规则', 'Grouping rules'),
      value: t('合成分组规则 · CHS-DRG 1.1', 'Synthetic grouping rules · CHS-DRG 1.1'),
      state: 'ok',
    }
  }
  const inHospital = admission.status !== 'departed' && admission.status !== 'cleared' && admission.recordStatus !== 'archived'
  if (rawLabel === '首页主操作' && inHospital && rawValue.includes('尚未选择')) {
    return {
      label: rawLabel,
      value: t('出院后在病案首页选择', 'Select on medical record after discharge'),
      state: 'wait',
    }
  }
  const pending = rawValue.includes('尚未选择') || rawValue.includes('未确认') || rawValue.includes('待处理')
  return {
    label: rawLabel,
    value: rawValue,
    state: pending ? 'todo' : 'ok',
  }
}

export function InpatientDrgRecordChecksPanel({ admission, session, locale, active, followOn, onOpenRecord }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const query = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id, 'drg-record-checks'],
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/record-checks`, inpatientDrgRecordChecksSchema, signal),
    enabled: active, refetchInterval: active ? 3_000 : false, refetchIntervalInBackground: false, retry: false })
  const explanation = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id, 'drg-explanation'],
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/record-checks/explanation`, inpatientDrgExplanationSchema, signal),
    enabled: active && session.actor.roleCode === 'inpatient-doctor', refetchInterval: active && session.actor.roleCode === 'inpatient-doctor' ? 3_000 : false, refetchIntervalInBackground: false, retry: false })
  const data = query.error === null ? query.data : undefined
  const verifiedObservations = data !== undefined && explanation.error === null && explanation.data?.status === 'succeeded' && explanation.data.fingerprint === data.fingerprint
    ? explanation.data.result?.observations
    : undefined
  const explanationRunning = explanation.error === null && (explanation.data?.status === 'queued' || explanation.data?.status === 'running')
  const followDisabled = followOn === false && session.actor.roleCode === 'inpatient-doctor'
  const issueExplanation = (issue: InpatientDrgRecordChecks['issues'][number]) => verifiedObservations?.find(item => item.key === issue.key)?.explanation ?? issue.explanation
  const goLabel = { surgery: t('去手术', 'Open surgery'), record: t('去病案首页', 'Open medical record'), orders: t('去诊断医嘱', 'Open diagnoses and orders') } as const
  const formattedSources = (data?.sources ?? []).map(source => ({
    source,
    ...formatCheckSourceDisplay(source, admission, locale),
  }))
  const hasWaitRow = formattedSources.some(item => item.state === 'wait')
  const actionableIssues = (data?.issues ?? []).filter(issue => {
    if (hasWaitRow && issue.kind === 'primary-procedure-difference' && formattedSources.some(item => item.state === 'wait' && issue.evidence.includes(item.source.reference))) {
      return false
    }
    return true
  })
  const todoCount = actionableIssues.length
  const badgeText = todoCount > 0
    ? t(`${todoCount} 项待处理`, `${todoCount} to review`)
    : hasWaitRow
      ? t('暂无需你处理', 'Nothing to handle now')
      : t('无差异', 'No differences')
  const matchedIssueKeys = new Set<string>()
  const formalCode = data?.simulation?.grouping.formal.drgCode
  const projectedCode = data?.simulation?.grouping.projected?.drgCode
  const waitExplanation = hasWaitRow && formalCode && projectedCode && formalCode !== projectedCode
    ? t(`正式分组只看病案首页选定的主操作。现在还没选，所以按无操作分到 ${formalCode}；手术完成、出院后在病案首页选为主操作，预计进入 ${projectedCode}。`,
      `Formal grouping uses the primary procedure selected on the medical record. Before selection it groups as ${formalCode}; after surgery and discharge selection it is projected as ${projectedCode}.`)
    : undefined

  return <section aria-label={t('分组核对', 'Grouping checks')} className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2">
      <h4 className="font-medium">{t('分组核对', 'Grouping checks')}</h4>
      {data ? <Badge variant="outline" className={todoCount > 0 ? 'text-warning' : 'text-success'}>{badgeText}</Badge> : null}
      <span className="flex-1" />
    </div>
    {query.isPending ? <div role="status">{t('正在读取分组核对', 'Loading grouping checks')}<Skeleton className="h-12 w-full" /></div> : null}
    {query.error ? <Alert variant="destructive"><AlertTitle>{t('分组核对读取失败', 'Could not read record checks')}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(query.error, getWorkspaceMessages(locale))}
      <Button variant="outline" size="sm" className="self-start" disabled={!active || query.isFetching} onClick={() => void query.refetch()}>{t('重新读取', 'Retry')}</Button></AlertDescription></Alert> : null}
    {data ? <>
      {data.status === 'frozen' ? <p role="status">{t('病案已归档，仅查看归档时的核对依据。', 'The medical record is archived; checks use the archived sources.')}</p> : null}
      {data.status === 'incomplete' ? <Alert><AlertTitle>{t('分组核对依据不完整', 'Record checks are incomplete')}</AlertTitle><AlertDescription>{data.missing.join(' · ')}</AlertDescription></Alert> : null}
      {data.paymentStatus !== 'available' ? <p role="status" className="text-sm">{data.paymentMessage}</p> : null}
      {formattedSources.length > 0 || data.issues.length > 0 ? <ul aria-label={t('分组核对清单', 'Grouping checklist')} className="clinmesh-inpatient-preparation-list">
        {formattedSources.map(({ source, label, value, state }) => {
          const rowIssues = data.issues.filter(issue => issue.evidence.includes(source.reference) && !matchedIssueKeys.has(issue.key))
          for (const issue of rowIssues) matchedIssueKeys.add(issue.key)
          const hasIssue = rowIssues.length > 0
          const effectiveState = hasIssue ? 'todo' : state
          return <li key={source.reference} data-complete={effectiveState === 'ok'}>
            {effectiveState === 'ok' ? <CheckCircle2Icon aria-hidden="true" className="text-success" /> : <CircleIcon aria-hidden="true" className={effectiveState === 'wait' ? 'text-muted-foreground opacity-50' : 'text-warning'} />}
            <div>{value ? <><span className="text-xs text-muted-foreground">{label}</span><span>{value}</span></> : <span>{source.display}</span>}</div>
            <div className="clinmesh-inpatient-preparation-owner">
              {effectiveState === 'wait'
                ? <span className="text-xs text-muted-foreground">{t('等手术完成', 'Wait for surgery completion')}</span>
                : source.target !== 'drg' && onOpenRecord
                  ? <Button variant="link" size="sm" className="text-info" onClick={() => onOpenRecord(source.target)}>{goLabel[source.target]}<ChevronRightIcon aria-hidden="true" data-icon="inline-end" /></Button>
                  : null}
            </div>
            {rowIssues.map(issue => <div key={issue.key} role="alert" className="col-span-full mt-1 flex items-start gap-2 rounded-md bg-info/10 px-2.5 py-2 text-xs text-foreground">
              <Badge variant="outline" className="shrink-0 border-info/50 px-1 py-0 text-[11px] text-info">{t('助手', 'Assistant')}</Badge>
              <div className="flex flex-col gap-1">
                <p className="font-medium">{issue.display}</p>
                <p>{issueExplanation(issue)}</p>
                {explanationRunning ? <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Spinner aria-hidden="true" className="size-3" />{t('依据刚变化，助手正在重写说明…', 'Sources just changed; assistant is rewriting explanation…')}</span> : null}
                {followDisabled ? <span className="text-muted-foreground">{t('开启自动跟进后，助手在这里说明原因。', 'Enable auto follow-up to see assistant explanations here.')}</span> : null}
                <InpatientDrgIssueDetails issue={issue} locale={locale} onOpenRecord={onOpenRecord} />
              </div>
            </div>)}
            {rowIssues.length === 0 && effectiveState === 'wait' && waitExplanation ? followDisabled ? <div className="col-span-full mt-1 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">{t('开启自动跟进后，助手在这里说明原因。', 'Enable auto follow-up to see assistant explanations here.')}</div>
              : explanationRunning ? <div className="col-span-full mt-1 flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground"><Spinner aria-hidden="true" className="size-3" /><span>{t('依据刚变化，助手正在重写说明…', 'Sources just changed; assistant is rewriting explanation…')}</span></div>
              : <div className="col-span-full mt-1 flex items-start gap-2 rounded-md bg-info/10 px-2.5 py-2 text-xs text-foreground">
              <Badge variant="outline" className="shrink-0 border-info/50 px-1 py-0 text-[11px] text-info">{t('助手', 'Assistant')}</Badge>
              <span>{waitExplanation}</span>
            </div> : null}
          </li>
        })}
        {data.issues.filter(issue => !matchedIssueKeys.has(issue.key)).map(issue => <li key={issue.key} data-complete={false}>
          <CircleIcon aria-hidden="true" className="text-warning" />
          <div role="alert" className="col-span-2 flex items-start gap-2 rounded-md bg-info/10 px-2.5 py-2 text-xs text-foreground">
            <Badge variant="outline" className="shrink-0 border-info/50 px-1 py-0 text-[11px] text-info">{t('助手', 'Assistant')}</Badge>
            <div className="flex flex-col gap-1">
              <p className="font-medium">{issue.display}</p>
              <p>{issueExplanation(issue)}</p>
              <InpatientDrgIssueDetails issue={issue} locale={locale} onOpenRecord={onOpenRecord} />
            </div>
          </div>
        </li>)}
      </ul> : null}
      {data.issues.length === 0 && data.status === 'complete' && !hasWaitRow ? <p className="text-sm text-muted-foreground">{t('当前无本范围核对差异', 'No differences within these checks')}</p> : null}
      <p className="text-xs text-muted-foreground">{t('对照原记录判断；首页、诊断和手术在各自页签修改，本页只核对。', 'Compare with the original records; change the record, diagnoses and surgery in their own tabs. This page only checks.')}</p>
    </> : null}
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
