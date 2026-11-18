import {
  guidelineTopicBundleSchema,
  guidelineTopicIds,
  type GuidelineTopicId,
  type GuidelineTopicRead,
} from '@clinmesh/contracts/guideline-topics'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import {
  inpatientGuidelineAdviceListSchema,
  type InpatientGuidelineAdvice,
  type InpatientGuidelineAdviceKind,
} from '@clinmesh/contracts/inpatient-guideline-advice'
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
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'

type Props = {
  admission: InpatientAdmission
  session: SessionContext
  locale: WorkspaceLocale
  write: ReturnType<typeof useInpatientWriteIntent>
  canReassess: boolean
  requestId?: string | null | undefined
  active?: boolean | undefined
  enableTopicPicker?: boolean | undefined
  initialTopicId?: GuidelineTopicId | undefined
}

export const guidelineTopicOptionLabels: Record<GuidelineTopicId, readonly [string, string]> = {
  'contrast-kidney-hydration': ['对比剂肾损伤预防与围术期水化', 'Contrast kidney protection & hydration'],
  'coronary-revascularization-indication': ['冠脉血运重建指征与 FFR 功能学评估', 'Coronary revascularization & FFR'],
  'cad-dapt-and-secondary-prevention': ['双联抗血小板与冠心病二级预防', 'DAPT & secondary prevention'],
  'acute-chest-pain-acs': ['急性胸痛与 ACS 危险分层', 'Acute chest pain & ACS risk'],
  'pci-stent': ['冠脉介入支架选型与腔内影像', 'PCI stent category & imaging'],
  't2dm-renal-medication': ['2 型糖尿病合并慢性肾脏病用药', 'T2DM & CKD medication'],
}

const orderedPickerTopics = Object.keys(guidelineTopicOptionLabels) as GuidelineTopicId[]

const kinds: Record<InpatientGuidelineAdviceKind, readonly [string, string]> = {
  'stent-category': ['支架类别', 'Stent category'],
  'imaging-guidance': ['IVUS／OCT 指导条件', 'IVUS / OCT guidance conditions'],
  'measurement-requirements': ['尺寸与测量要求', 'Sizing and measurement requirements'],
  'initial-triage-diagnostics': ['急诊初筛与早期检查', 'Initial triage and early diagnostics'],
  'ischemic-risk-stratification': ['缺血危险分层', 'Ischemic risk stratification'],
  'invasive-timing-strategy': ['侵入检查时机策略', 'Invasive timing strategy'],
  'functional-ischemia-evaluation': ['功能学缺血评估（FFR／iFR）', 'Functional ischemia evaluation (FFR / iFR)'],
  'revascularization-vs-gdmt': ['血运重建与药物保守治疗指征', 'Revascularization vs optimal medical therapy'],
  'modality-and-anatomy-scope': ['解剖范围与术式适用界限', 'Anatomical scope and modality limits'],
  'renal-risk-stratification': ['造影前肾损伤危险分层', 'Pre-contrast renal risk stratification'],
  'hydration-and-volume-balance': ['围术期水化与容量平衡', 'Peri-procedural hydration and volume balance'],
  'contrast-dose-control': ['对比剂选择与用量控制', 'Contrast selection and dose control'],
  'dapt-duration-and-bleeding': ['双联抗血小板疗程与出血平衡', 'DAPT duration and bleeding balance'],
  'lipid-target-therapy': ['降脂目标与强化治疗', 'Lipid target and intensive therapy'],
  'cardioprotective-gdmt': ['心室重构与二级预防基础用药', 'Cardioprotective secondary prevention'],
  'renal-stage-contraindications': ['肾功能分期用药界值与禁忌', 'Renal-stage thresholds and contraindications'],
  'cardiorenal-agent-selection': ['心肾获益降糖药物选择', 'Cardiorenal glucose-lowering agent selection'],
  'glycemic-monitoring-and-adjustment': ['血糖监测与联合调整注意事项', 'Glycemic monitoring and adjustment'],
}

const requestable = new Set<InpatientGuidelineAdvice['status']>([
  'idle',
  'stale',
  'failed',
  'rejected',
  'no-evidence',
  'cancelled',
  'frozen',
])

type ViewFrame = { scope: string; active: boolean; canReassess: boolean }
type RequestAttempt = { frame: ViewFrame; itemKey: string }

function adviceItemKey(item: Pick<InpatientGuidelineAdvice, 'topicId' | 'requestId'>): string {
  return item.requestId !== null ? item.requestId : `topic:${item.topicId}`
}

const englishStatus: Record<InpatientGuidelineAdvice['status'], string> = {
  idle: 'Guideline reference advice has not been prepared for this plan.',
  queued: 'Preparing guideline reference advice.',
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

export function InpatientGuidelineAdvicePanel({
  admission,
  session,
  locale,
  write,
  canReassess,
  requestId,
  active = true,
  enableTopicPicker = false,
  initialTopicId = 'contrast-kidney-hydration',
}: Props): React.JSX.Element | null {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const usageId = useId()
  const [selectedTopic, setSelectedTopic] = useState<GuidelineTopicId>(initialTopicId)
  const scope = JSON.stringify([
    session.actor,
    session.user.id,
    admission.id,
    admission.versionId,
    admission.status,
    admission.recordStatus,
    enableTopicPicker ? `topic:${selectedTopic}` : (requestId ?? null),
  ])
  const live = useRef<ViewFrame>({ scope, active, canReassess })
  const mounted = useRef(true)
  const inFlight = useRef<RequestAttempt | null>(null)
  if (live.current.scope !== scope || live.current.active !== active || live.current.canReassess !== canReassess) {
    live.current = { scope, active, canReassess }
  }
  const frame = live.current
  const [requesting, setRequesting] = useState<RequestAttempt | null>(null)
  const [changed, setChanged] = useState<RequestAttempt | null>(null)
  const [usage, setUsage] = useState<RequestAttempt | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const advicePath = enableTopicPicker
    ? `/api/his/v1/inpatient/admissions/${admission.id}/guideline-advice?topicId=${encodeURIComponent(selectedTopic)}`
    : `/api/his/v1/inpatient/admissions/${admission.id}/guideline-advice`
  const query = useQuery({
    queryKey: enableTopicPicker
      ? [...inpatientScopeKey(session), admission.id, 'guideline-advice', selectedTopic]
      : [...inpatientScopeKey(session), admission.id, 'guideline-advice'],
    queryFn: ({ signal }) => apiGet(advicePath, inpatientGuidelineAdviceListSchema, signal),
    enabled: active,
    refetchInterval: active ? 3_000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  })
  const topicReadQuery = useQuery({
    queryKey: [...inpatientScopeKey(session), admission.id, 'guideline-topics', selectedTopic],
    queryFn: ({ signal }) => apiGet(
      `/api/his/v1/inpatient/admissions/${admission.id}/guideline-topics?topicId=${encodeURIComponent(selectedTopic)}`,
      guidelineTopicBundleSchema,
      signal,
    ),
    enabled: active && enableTopicPicker,
    retry: false,
  })

  const doctor = session.actor.roleCode === 'inpatient-doctor'
  const mutable = admission.status === 'admitted' && admission.recordStatus !== 'archived'
  const reevaluate = async (advice: InpatientGuidelineAdvice) => {
    if (!active || !canReassess || !doctor || !mutable || write.blocked || !requestable.has(advice.status) || inFlight.current?.frame === frame) {
      return
    }
    const itemKey = adviceItemKey(advice)
    const attempt: RequestAttempt = { frame, itemKey }
    inFlight.current = attempt
    setRequesting(attempt)
    setChanged(null)
    try {
      const fresh = await query.refetch()
      const current = fresh.error === null && fresh.data?.admissionId === admission.id
        ? fresh.data.advice.find(item =>
            item.admissionId === admission.id
            && item.requestId === advice.requestId
            && (advice.requestId !== null || item.topicId === advice.topicId))
        : undefined
      if (!mounted.current || live.current !== frame || !frame.active || !current) return
      if (current.version !== advice.version || current.fingerprint !== advice.fingerprint) {
        setChanged(attempt)
        return
      }
      if (!requestable.has(current.status)) return
      await write.mutation.mutateAsync({
        operation: 'inpatient.guideline-advice.request',
        input: current.requestId !== null
          ? {
              admissionId: admission.id,
              requestId: current.requestId,
              expectedVersion: current.version,
              expectedFingerprint: current.fingerprint,
            }
          : {
              admissionId: admission.id,
              topicId: current.topicId,
              requestId: null,
              expectedVersion: current.version,
              expectedFingerprint: current.fingerprint,
            },
        isCurrent: () => mounted.current && live.current === frame && frame.active && frame.canReassess,
      })
      if (mounted.current && live.current === frame) await query.refetch()
    } catch {
      /* 原 Command 意图保留错误和回执恢复；读取失败不发起新请求。 */
    } finally {
      if (inFlight.current === attempt) inFlight.current = null
      if (mounted.current) setRequesting(value => value === attempt ? null : value)
    }
  }

  if (!active) return null
  const data = query.error === null && query.data?.admissionId === admission.id ? query.data : undefined
  const topicCandidates = data?.advice.filter(item => item.admissionId === admission.id && item.topicId === selectedTopic)
  const activeSurgeryBoundPci = selectedTopic === 'pci-stent'
    ? topicCandidates?.filter(item => item.requestId !== null && item.status !== 'cancelled')
    : undefined
  const admissionLevelCandidates = topicCandidates?.filter(item => item.requestId === null)
  const advice = enableTopicPicker
    ? (
        activeSurgeryBoundPci && activeSurgeryBoundPci.length > 0
          ? activeSurgeryBoundPci
          : (admissionLevelCandidates && admissionLevelCandidates.length > 0
              ? admissionLevelCandidates
              : topicCandidates)
      )
    : data?.advice.filter(item =>
        item.admissionId === admission.id
        && item.requestId !== null
        && (requestId === undefined || item.requestId === requestId))
  const topicRead = enableTopicPicker && topicReadQuery.error === null
    ? topicReadQuery.data?.items.find(item => item.topic.id === selectedTopic)
    : undefined
  const attempted = write.mutation.variables
  const command = attempted?.operation === 'inpatient.guideline-advice.request' && attempted.isCurrent?.() !== false ? attempted.input : undefined

  return (
    <section aria-label={t('指南参考意见', 'Guideline reference advice')} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-medium">{t('指南参考意见', 'Guideline reference advice')}</h4>
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetching || topicReadQuery.isFetching}
          onClick={() => {
            void query.refetch()
            if (enableTopicPicker) void topicReadQuery.refetch()
          }}
        >
          {t('刷新指南状态', 'Refresh guideline status')}
        </Button>
      </div>
      {enableTopicPicker ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="font-medium" htmlFor={`${usageId}-topic-select`}>
            {t('指南专题', 'Guideline topic')}
          </label>
          <select
            id={`${usageId}-topic-select`}
            aria-label={t('指南专题', 'Guideline topic')}
            className="h-8 max-w-full rounded-md border border-input bg-background px-2 text-xs"
            value={selectedTopic}
            onChange={event => {
              const value = event.currentTarget.value
              if ((guidelineTopicIds as readonly string[]).includes(value)) {
                setSelectedTopic(value as GuidelineTopicId)
              }
            }}
          >
            {orderedPickerTopics.map(topicId => (
              <option key={topicId} value={topicId}>
                {guidelineTopicOptionLabels[topicId][locale === 'zh-CN' ? 0 : 1]}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground">
        {t(
          '只读参考；未确认耗材清单与当前预留分别办理，指南意见不形成产品条目或费用。',
          'Read-only reference. The unconfirmed material list and current reservations are handled separately; advice does not create products or charges.',
        )}
      </p>
      {enableTopicPicker ? (
        <SynchronousGuidelineTopicCard
          error={topicReadQuery.error}
          loading={topicReadQuery.isPending}
          locale={locale}
          read={topicRead}
        />
      ) : null}
      {query.isPending ? (
        <div role="status">
          {t('正在读取指南参考意见', 'Loading guideline reference advice')}
          <Skeleton className="h-12 w-full" />
        </div>
      ) : null}
      {query.error ? (
        <Alert variant="destructive">
          <AlertTitle>{t('指南参考意见读取失败', 'Could not read guideline advice')}</AlertTitle>
          <AlertDescription>
            {t('旧意见与原文暂不展示，请刷新核查当前状态。', 'Previous advice and quotations are hidden. Refresh to check the current state.')}
          </AlertDescription>
        </Alert>
      ) : null}
      {!enableTopicPicker && advice?.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t('尚无本计划指南参考意见', 'No guideline advice for this plan yet')}</EmptyTitle>
            <EmptyDescription>
              {t('保存有效 PCI 计划后自动准备，无需开启持续跟进。', 'Advice is prepared after saving a valid PCI plan; follow-up is not required.')}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {advice?.map(item => {
        const key = adviceItemKey(item)
        const requestError = command?.admissionId === admission.id
          && (command.requestId ?? null) === item.requestId
          && (item.requestId !== null || command.topicId === item.topicId)
          && command.expectedVersion === item.version
          && command.expectedFingerprint === item.fingerprint
          ? write.mutation.error
          : null
        return (
          <div key={key} className="flex min-w-0 flex-col gap-3">
            <GuidelineAdvice advice={item} locale={locale} />
            {changed?.frame === frame && changed.itemKey === key ? (
              <p role="status">
                {t('指南资料已更新，请核对当前内容后再次重评。', 'The guideline sources or version changed. Review the current content before requesting again.')}
              </p>
            ) : null}
            {requestError ? (
              <Alert variant="destructive">
                <AlertTitle>{t('指南重评尚未完成', 'Guideline reassessment is incomplete')}</AlertTitle>
                <AlertDescription>{getWorkspaceErrorMessage(requestError, getWorkspaceMessages(locale))}</AlertDescription>
              </Alert>
            ) : null}
            {canReassess && doctor && mutable && requestable.has(item.status) ? (
              <Button
                variant="outline"
                className="self-start"
                disabled={write.blocked || requesting?.frame === frame || query.isFetching}
                onClick={() => void reevaluate(item)}
              >
                {requesting?.frame === frame && requesting.itemKey === key
                  ? t('正在核对指南依据…', 'Checking guideline sources…')
                  : t('按当前依据重新评估指南', 'Reassess guidelines with current sources')}
              </Button>
            ) : null}
            {item.taskId || item.status === 'unknown' ? (
              <Button
                variant="outline"
                className="self-start"
                disabled={query.isFetching}
                aria-controls={`${usageId}-${key}`}
                aria-expanded={usage?.frame === frame && usage.itemKey === key}
                onClick={() => {
                  setUsage(value => value?.frame === frame && value.itemKey === key ? null : { frame, itemKey: key })
                  if (item.status === 'unknown') void query.refetch()
                }}
              >
                {item.status === 'unknown'
                  ? t('核查原请求与实际用量', 'Check original request and actual usage')
                  : t('查看指南实际用量', 'View actual guideline usage')}
              </Button>
            ) : null}
            {usage?.frame === frame && usage.itemKey === key ? (
              <div id={`${usageId}-${key}`}>
                {item.taskId ? (
                  <InpatientDrgUsagePanel
                    key={`${scope}:${item.taskId}`}
                    admissionId={admission.id}
                    taskId={item.taskId}
                    session={session}
                    locale={locale}
                    active={active}
                    taskKind="guideline"
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t(
                      '当前暂无可读的用量记录；刷新仅核查原请求状态，不会重新发起AI请求。',
                      'No readable usage record is available. Refresh only checks the original request and does not redispatch the model.',
                    )}
                  </p>
                )}
              </div>
            ) : null}
          </div>
        )
      })}
    </section>
  )
}

export function SynchronousGuidelineTopicCard({
  error,
  loading,
  locale,
  read,
}: {
  error: Error | null | undefined
  loading: boolean
  locale: WorkspaceLocale
  read: GuidelineTopicRead | undefined
}): React.JSX.Element | null {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  if (loading) {
    return (
      <div role="status" className="text-xs text-muted-foreground">
        {t('正在读取同步专题依据…', 'Loading synchronous guideline topic passages…')}
      </div>
    )
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t('同步专题依据读取失败', 'Could not read synchronous guideline passages')}</AlertTitle>
        <AlertDescription>{getWorkspaceErrorMessage(error, getWorkspaceMessages(locale))}</AlertDescription>
      </Alert>
    )
  }
  if (!read) return null

  return (
    <div aria-label={t('同步原文与客观指标核对', 'Synchronous guideline passages & patient indicators')} className="flex min-w-0 flex-col gap-2 rounded-md border bg-muted/20 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{locale === 'zh-CN' ? read.topic.titleZh : read.topic.titleEn}</span>
        <Badge variant={read.status === 'available' ? 'secondary' : 'outline'}>
          {read.status === 'available'
            ? t('原文已核验 · 零AI调用', 'Verified passages · 0 AI calls')
            : t('原文暂不可用', 'Sources unavailable')}
        </Badge>
      </div>
      {read.status === 'unavailable' && read.degradedReason ? (
        <Alert>
          <AlertTitle>{t('本专题原文暂不可用', 'Topic sources unavailable')}</AlertTitle>
          <AlertDescription>{read.degradedReason}</AlertDescription>
        </Alert>
      ) : null}
      {read.patientIndicators.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="font-medium text-muted-foreground">{t('当前患者客观指标', 'Current patient indicators')}</span>
          <ul className="space-y-1">
            {read.patientIndicators.map(indicator => (
              <li key={indicator.code} className="flex flex-wrap items-center gap-1.5">
                <Badge variant={indicator.status === 'present' ? 'secondary' : 'outline'}>
                  {indicator.status === 'present' ? t('已记录', 'Present') : t('待补充', 'Missing')}
                </Badge>
                <span>{locale === 'zh-CN' ? indicator.labelZh : indicator.labelEn}</span>
                {indicator.valueText ? <span className="text-muted-foreground tabular-nums">· {indicator.valueText}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {read.missingPatientInputs.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="font-medium text-muted-foreground">{t('患者资料待补充项', 'Missing patient inputs')}</span>
          <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
            {read.missingPatientInputs.map(item => <li key={item}>{item}</li>)}
          </ul>
        </div>
      ) : null}
      {read.guidelines.length > 0 ? (
        <details>
          <summary className="cursor-pointer font-medium text-info">
            {t(`查看经核验指南原文段落 (${read.guidelines.length})`, `View verified guideline passages (${read.guidelines.length})`)}
          </summary>
          <div className="flex min-w-0 flex-col gap-2 pt-2">
            {read.guidelines.map(source => (
              <div key={source.id} className="flex min-w-0 flex-col gap-1 border-b pb-2 last:border-b-0">
                <p className="break-words font-medium">{source.title}</p>
                <p className="break-words text-muted-foreground">{source.version} · {source.locator} · {source.publisher}</p>
                <blockquote className="max-w-prose whitespace-pre-wrap break-words">{source.text}</blockquote>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
        {read.limitations.map(item => <li key={item}>{item}</li>)}
      </ul>
    </div>
  )
}

function GuidelineAdvice({ advice, locale }: { advice: InpatientGuidelineAdvice; locale: WorkspaceLocale }): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const result = ['succeeded', 'incomplete', 'frozen'].includes(advice.status) && advice.result?.fingerprint === advice.fingerprint ? advice.result : null
  return (
    <article className="flex min-w-0 flex-col gap-3">
      <p role="status">{locale === 'zh-CN' ? advice.message : englishStatus[advice.status]}</p>
      {advice.missing.length > 0 ? (
        <Alert>
          <AlertTitle>{t('资料与依据待核对', 'Facts and evidence need review')}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {advice.missing.map(item => <li key={item}>{item}</li>)}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {result ? (
        <>
          <div className="flex min-w-0 flex-col gap-4">
            {result.conclusions.map(conclusion => {
              const label = kinds[conclusion.kind][locale === 'zh-CN' ? 0 : 1]
              return (
                <article key={conclusion.kind} className="flex min-w-0 flex-col gap-2 border-b pb-3 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h5 className="font-medium">{label}</h5>
                    <Badge variant="outline" className="border-info/40 text-info">{t('助手', 'Assistant')}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {conclusion.applicability === 'conditional'
                        ? t('有条件的参考', 'Conditional reference')
                        : t('依据当前资料的参考', 'Reference based on current facts')}
                    </span>
                  </div>
                  <p className="max-w-prose break-words text-sm">{conclusion.text}</p>
                  <details>
                    <summary className="cursor-pointer text-sm text-info">{t(`查看${label}依据`, `View evidence for ${label}`)}</summary>
                    <div role="group" aria-label={t(`${label}依据`, `Evidence for ${label}`)} className="flex min-w-0 flex-col gap-3 pt-2">
                      {conclusion.citations.map((citation, index) => {
                        const source = result.guidelines.find(item => item.id === citation.evidenceId)
                        if (!source) {
                          return <p key={index}>{t('本条原文定位不可用，请刷新核查。', 'The original passage is unavailable. Refresh to check.')}</p>
                        }
                        return (
                          <div key={index} className="flex min-w-0 flex-col gap-1">
                            <p className="break-words font-medium">{source.title}</p>
                            <p className="break-words text-xs text-muted-foreground">{source.version} · {source.locator} · {source.publisher}</p>
                            <p className="max-w-prose break-words text-xs text-muted-foreground">{source.scope}</p>
                            <blockquote className="max-w-prose whitespace-pre-wrap break-words text-sm">{citation.quote}</blockquote>
                            {source.url.startsWith('https://') || source.url.startsWith('http://') ? (
                              <a
                                className="w-fit text-sm text-info underline underline-offset-2"
                                href={source.url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {t('查看来源页面', 'Open source page')}
                              </a>
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                  </details>
                </article>
              )
            })}
          </div>
          <ul aria-label={t('指南范围与限制', 'Guideline scope and limitations')} className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
            {result.limitations.map(item => <li key={item}>{item}</li>)}
          </ul>
        </>
      ) : null}
    </article>
  )
}
