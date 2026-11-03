import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientGuidelineAdviceListSchema, type InpatientGuidelineAdvice } from '@clinmesh/contracts/inpatient-guideline-advice'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { apiGet } from './api-client.ts'
import { InpatientDrgUsagePanel } from './inpatient-drg-usage.tsx'
import { inpatientScopeKey } from './inpatient-scope.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceMessages } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale;
  write: ReturnType<typeof useInpatientWriteIntent>; canReassess: boolean; requestId?: string; active?: boolean }

const kinds = { 'stent-category': ['支架类别', 'Stent category'], 'imaging-guidance': ['IVUS／OCT 指导条件', 'IVUS / OCT guidance conditions'],
  'measurement-requirements': ['尺寸与测量要求', 'Sizing and measurement requirements'] } as const
const requestable = new Set<InpatientGuidelineAdvice['status']>(['idle', 'stale', 'failed', 'rejected', 'no-evidence', 'cancelled', 'frozen'])
type ViewFrame = { scope: string; active: boolean; canReassess: boolean }
type RequestAttempt = { frame: ViewFrame; requestId: string }
const englishStatus: Record<InpatientGuidelineAdvice['status'], string> = {
  idle: 'Guideline reference advice has not been prepared for this plan.', queued: 'Preparing guideline reference advice.',
  running: 'Drafting and independently verifying guideline advice against the original passages.',
  succeeded: 'Guideline reference advice is ready. Review it with the original passages and current patient facts.',
  incomplete: 'Guideline advice is ready with missing patient facts. Only conditional reference is available.',
  'no-evidence': 'No usable original guideline passages are available for this topic.',
  blocked: 'The model or usage controls are unavailable. Guideline advice has not been generated.',
  unknown: 'The original model request has an unknown outcome. Check the original request; it will not be sent again automatically.',
  rejected: 'Independent verification rejected this advice. Its content is hidden.',
  failed: 'Guideline preparation failed. Review the current state before explicitly requesting reassessment.',
  cancelled: 'Preparation was cancelled. Guideline advice is no longer being prepared.',
  stale: 'Patient facts, the plan, the catalogue or guideline sources changed. Explicit reassessment is required.',
  frozen: 'Preparation has stopped. Published advice remains read-only history.',
}

export function InpatientGuidelineAdvicePanel({ admission, session, locale, write, canReassess, requestId, active = true }: Props): React.JSX.Element | null {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const usageId = useId()
  const scope = JSON.stringify([session.actor, session.user.id, admission.id, admission.versionId, admission.status, admission.recordStatus, requestId ?? null])
  const live = useRef<ViewFrame>({ scope, active, canReassess }), mounted = useRef(true), inFlight = useRef<RequestAttempt | null>(null)
  if (live.current.scope !== scope || live.current.active !== active || live.current.canReassess !== canReassess) live.current = { scope, active, canReassess }
  const frame = live.current
  const [requesting, setRequesting] = useState<RequestAttempt | null>(null), [changed, setChanged] = useState<RequestAttempt | null>(null)
  const [usage, setUsage] = useState<RequestAttempt | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const query = useQuery({ queryKey: [...inpatientScopeKey(session), admission.id, 'guideline-advice'],
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/guideline-advice`, inpatientGuidelineAdviceListSchema, signal),
    enabled: active, refetchInterval: active ? 3_000 : false, refetchIntervalInBackground: false, retry: false })
  const doctor = session.actor.roleCode === 'inpatient-doctor'
  const mutable = admission.status === 'admitted' && admission.recordStatus !== 'archived'
  const reevaluate = async (advice: InpatientGuidelineAdvice) => {
    if (!active || !canReassess || !doctor || !mutable || write.blocked || !requestable.has(advice.status) || inFlight.current?.frame === frame) return
    const attempt = { frame, requestId: advice.requestId }
    inFlight.current = attempt; setRequesting(attempt); setChanged(null)
    try {
      const fresh = await query.refetch(), current = fresh.error === null && fresh.data?.admissionId === admission.id
        ? fresh.data.advice.find(item => item.admissionId === admission.id && item.requestId === advice.requestId) : undefined
      if (!mounted.current || live.current !== frame || !frame.active || !current) return
      if (current.version !== advice.version || current.fingerprint !== advice.fingerprint) { setChanged(attempt); return }
      if (!requestable.has(current.status)) return
      await write.mutation.mutateAsync({ operation: 'inpatient.guideline-advice.request', input: {
        admissionId: admission.id, requestId: current.requestId, expectedVersion: current.version, expectedFingerprint: current.fingerprint },
        isCurrent: () => mounted.current && live.current === frame && frame.active && frame.canReassess })
      if (mounted.current && live.current === frame) await query.refetch()
    } catch { /* 原 Command 意图保留错误和回执恢复；读取失败不派发模型。 */ }
    finally {
      if (inFlight.current === attempt) inFlight.current = null
      if (mounted.current) setRequesting(value => value === attempt ? null : value)
    }
  }
  if (!active) return null
  const data = query.error === null && query.data?.admissionId === admission.id ? query.data : undefined
  const advice = data?.advice.filter(item => item.admissionId === admission.id && (requestId === undefined || item.requestId === requestId))
  const attempted = write.mutation.variables
  const command = attempted?.operation === 'inpatient.guideline-advice.request' && attempted.isCurrent?.() !== false ? attempted.input : undefined
  return <section aria-label={t('指南参考意见', 'Guideline reference advice')} className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2"><h4 className="font-medium">{t('指南参考意见', 'Guideline reference advice')}</h4>
      <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>{t('刷新指南状态', 'Refresh guideline status')}</Button></div>
    <p className="text-sm text-muted-foreground">{t('只读参考；未确认耗材清单与当前预留分别办理，指南意见不形成产品条目或费用。', 'Read-only reference. The unconfirmed material list and current reservations are handled separately; advice does not create products or charges.')}</p>
    {query.isPending ? <div role="status">{t('正在读取指南参考意见', 'Loading guideline reference advice')}<Skeleton className="h-12 w-full" /></div> : null}
    {query.error ? <Alert variant="destructive"><AlertTitle>{t('指南参考意见读取失败', 'Could not read guideline advice')}</AlertTitle>
      <AlertDescription>{t('旧意见与原文暂不展示，请刷新核查当前状态。', 'Previous advice and quotations are hidden. Refresh to check the current state.')}</AlertDescription></Alert> : null}
    {advice?.length === 0 ? <Empty><EmptyHeader><EmptyTitle>{t('尚无本计划指南参考意见', 'No guideline advice for this plan yet')}</EmptyTitle>
      <EmptyDescription>{t('保存有效 PCI 计划后自动准备，无需开启持续跟进。', 'Advice is prepared after saving a valid PCI plan; follow-up is not required.')}</EmptyDescription></EmptyHeader></Empty> : null}
    {advice?.map(item => {
      const requestError = command?.admissionId === admission.id && command.requestId === item.requestId && command.expectedVersion === item.version
        && command.expectedFingerprint === item.fingerprint ? write.mutation.error : null
      return <div key={item.requestId} className="flex min-w-0 flex-col gap-3">
        <GuidelineAdvice advice={item} locale={locale} />
        {changed?.frame === frame && changed.requestId === item.requestId ? <p role="status">{t('指南资料已更新，请核对当前内容后再次重评。', 'The guideline sources or version changed. Review the current content before requesting again.')}</p> : null}
        {requestError ? <Alert variant="destructive"><AlertTitle>{t('指南重评尚未完成', 'Guideline reassessment is incomplete')}</AlertTitle>
          <AlertDescription>{getWorkspaceErrorMessage(requestError, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
        {canReassess && doctor && mutable && requestable.has(item.status) ? <Button variant="outline" className="self-start" disabled={write.blocked || requesting?.frame === frame || query.isFetching}
          onClick={() => void reevaluate(item)}>{requesting?.frame === frame && requesting.requestId === item.requestId
            ? t('正在核对指南依据…', 'Checking guideline sources…') : t('按当前依据重新评估指南', 'Reassess guidelines with current sources')}</Button> : null}
        {item.taskId || item.status === 'unknown' ? <Button variant="outline" className="self-start" disabled={query.isFetching}
          aria-controls={`${usageId}-${item.requestId}`} aria-expanded={usage?.frame === frame && usage.requestId === item.requestId} onClick={() => {
            setUsage(value => value?.frame === frame && value.requestId === item.requestId ? null : { frame, requestId: item.requestId })
            if (item.status === 'unknown') void query.refetch()
          }}>{item.status === 'unknown' ? t('核查原请求与实际用量', 'Check original request and actual usage') : t('查看指南实际用量', 'View actual guideline usage')}</Button> : null}
        {usage?.frame === frame && usage.requestId === item.requestId ? <div id={`${usageId}-${item.requestId}`}>
          {item.taskId ? <InpatientDrgUsagePanel key={`${scope}:${item.taskId}`} admissionId={admission.id} taskId={item.taskId}
            session={session} locale={locale} active={active} taskKind="guideline" />
            : <p className="text-sm text-muted-foreground">{t('当前暂无可读的用量记录；刷新仅核查原请求状态，不会重新发起AI请求。', 'No readable usage record is available. Refresh only checks the original request and does not redispatch the model.')}</p>}
        </div> : null}
      </div>
    })}
  </section>
}

function GuidelineAdvice({ advice, locale }: { advice: InpatientGuidelineAdvice; locale: WorkspaceLocale }): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const result = ['succeeded', 'incomplete', 'frozen'].includes(advice.status) && advice.result?.fingerprint === advice.fingerprint ? advice.result : null
  return <article className="flex min-w-0 flex-col gap-3">
    <p role="status">{locale === 'zh-CN' ? advice.message : englishStatus[advice.status]}</p>
    {advice.missing.length > 0 ? <Alert><AlertTitle>{t('资料与依据待核对', 'Facts and evidence need review')}</AlertTitle>
      <AlertDescription><ul className="list-disc space-y-1 pl-4">{advice.missing.map(item => <li key={item}>{item}</li>)}</ul></AlertDescription></Alert> : null}
    {result ? <>
      <div className="flex min-w-0 flex-col gap-4">{result.conclusions.map(conclusion => {
        const label = kinds[conclusion.kind][locale === 'zh-CN' ? 0 : 1]
        return <article key={conclusion.kind} className="flex min-w-0 flex-col gap-2 border-b pb-3 last:border-b-0">
          <div className="flex flex-wrap items-center gap-2"><h5 className="font-medium">{label}</h5>
            <Badge variant="outline" className="border-info/40 text-info">{t('助手', 'Assistant')}</Badge>
            <span className="text-xs text-muted-foreground">{conclusion.applicability === 'conditional' ? t('有条件的参考', 'Conditional reference') : t('依据当前资料的参考', 'Reference based on current facts')}</span></div>
          <p className="max-w-prose break-words text-sm">{conclusion.text}</p>
          <details><summary className="cursor-pointer text-sm text-info">{t(`查看${label}依据`, `View evidence for ${label}`)}</summary>
            <div role="group" aria-label={t(`${label}依据`, `Evidence for ${label}`)} className="flex min-w-0 flex-col gap-3 pt-2">
              {conclusion.citations.map((citation, index) => {
                const source = result.guidelines.find(item => item.id === citation.evidenceId)
                if (!source) return <p key={index}>{t('本条原文定位不可用，请刷新核查。', 'The original passage is unavailable. Refresh to check.')}</p>
                return <div key={index} className="flex min-w-0 flex-col gap-1">
                  <p className="break-words font-medium">{source.title}</p>
                  <p className="break-words text-xs text-muted-foreground">{source.version} · {source.locator} · {source.publisher}</p>
                  <p className="max-w-prose break-words text-xs text-muted-foreground">{source.scope}</p>
                  <blockquote className="max-w-prose whitespace-pre-wrap break-words text-sm">{citation.quote}</blockquote>
                  {source.url.startsWith('https://') || source.url.startsWith('http://') ? <a className="w-fit text-sm text-info underline underline-offset-2" href={source.url} target="_blank" rel="noopener noreferrer">{t('查看来源页面', 'Open source page')}</a> : null}
                </div>
              })}
            </div>
          </details>
        </article>
      })}</div>
      <ul aria-label={t('指南范围与限制', 'Guideline scope and limitations')} className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
        {result.limitations.map(item => <li key={item}>{item}</li>)}</ul>
    </> : null}
  </article>
}
