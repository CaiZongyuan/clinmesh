import type {
  DoctorRecommendationConsideration, DoctorRecommendationKind, DoctorRecommendationNotice, DoctorRecommendationState,
  DoctorRecommendationSuggestion, GuidelineEvidence,
} from '@clinmesh/contracts/doctor-recommendations'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@clinmesh/ui/components/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Separator } from '@clinmesh/ui/components/separator'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCwIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { generateDoctorRecommendations, getDoctorRecommendations } from '../api-client.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'

const titles: Record<DoctorRecommendationKind, [string, string]> = {
  laboratory: ['检验建议', 'Laboratory suggestions'],
  imaging: ['放射检查建议', 'Imaging suggestions'],
  pathology: ['病理会诊建议', 'Pathology suggestions'],
  diagnosis: ['诊断建议', 'Diagnosis suggestions'],
  prescription: ['处方建议', 'Prescription suggestions'],
}

const documentTypes: Record<GuidelineEvidence['documentType'], [string, string]> = {
  'national-standard': ['国家标准', 'National standard'],
  'health-standard': ['卫生行业标准', 'Health industry standard'],
  'official-protocol': ['诊疗方案', 'Clinical protocol'],
  guideline: ['临床指南', 'Clinical guideline'],
  'product-information': ['药品说明书', 'Product information'],
}

const noticeTitles: Record<DoctorRecommendationNotice['category'], [string, string]> = {
  guideline: ['指南覆盖', 'Guideline coverage'],
  catalog: ['院内目录', 'Hospital catalog'],
  verification: ['核验未通过', 'Verification not passed'],
  processing: ['系统处理限制', 'Processing limitations'],
}

function CaseReasoning({ item, zh }: { item: DoctorRecommendationConsideration; zh: boolean }) {
  return <>
    <p className="text-sm">{item.rationale}</p>
    {[
      { label: zh ? '支持信息' : 'Supporting information', values: item.supportingInformation },
      { label: zh ? '反对信息' : 'Information against', values: item.opposingInformation },
      { label: zh ? '影响判断的待核实事项' : 'Clarifications affecting this assessment', values: item.missingInformation },
    ].map(({ label, values }) => values.length > 0 ? (
      <div className="text-sm" key={label}><span className="font-medium">{label}</span>
        <ul className="list-inside list-disc">{values.map(value => <li key={value}>{value}</li>)}</ul>
      </div>
    ) : null)}
  </>
}

function newerGeneration(current: DoctorRecommendationState | undefined, incoming: DoctorRecommendationState) {
  if (current !== undefined && current.generation > incoming.generation) return current
  // POST 的 pending 回执可能晚于同轮完成结果。
  if (current?.generation === incoming.generation && current.inputFingerprint === incoming.inputFingerprint
    && ['ready', 'missing-evidence', 'failed'].includes(current.status) && incoming.status === 'pending' && !incoming.stale) return current
  return incoming
}

export function DoctorRecommendationsPanel({
  caseId, kind, enabled, inputRevision, scope, locale = 'zh-CN', onAdopt, canAdopt, unavailableReason,
}: {
  caseId: string
  kind: DoctorRecommendationKind
  enabled: boolean
  inputRevision?: string | undefined
  scope?: string | undefined
  locale?: WorkspaceLocale | undefined
  onAdopt: (suggestion: DoctorRecommendationSuggestion, state: DoctorRecommendationState) => void
  canAdopt?: ((suggestion: DoctorRecommendationSuggestion) => boolean) | undefined
  unavailableReason?: ((suggestion: DoctorRecommendationSuggestion) => string | undefined) | undefined
}): React.JSX.Element | null {
  const client = useQueryClient()
  const zh = locale === 'zh-CN'
  const messages = getWorkspaceMessages(locale)
  const title = titles[kind][zh ? 0 : 1]
  const identity = JSON.stringify([scope, caseId, kind, enabled, inputRevision])
  const currentView = useRef({ identity, revision: 0 })
  if (currentView.current.identity !== identity) {
    currentView.current = { identity, revision: currentView.current.revision + 1 }
  }
  const viewRevision = currentView.current.revision
  const callbacks = useRef({ canAdopt, onAdopt })
  callbacks.current = { canAdopt, onAdopt }
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const lastAutomaticRequest = useRef<string | undefined>(undefined)
  const queryKey = ['doctor-recommendations', scope, caseId, kind, inputRevision, viewRevision] as const
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const incoming = await getDoctorRecommendations(caseId, kind, signal)
      return newerGeneration(client.getQueryData<DoctorRecommendationState>(queryKey), incoming)
    },
    enabled,
    retry: false,
    refetchInterval: query => query.state.data?.status === 'pending' ? 1_000 : false,
  })
  const generation = useMutation({
    mutationFn: (request: { state: DoctorRecommendationState; refresh: boolean; viewRevision: number }) =>
      generateDoctorRecommendations(request.state, request.refresh),
    onSuccess: (state, request) => {
      if (mounted.current && currentView.current.revision === request.viewRevision) {
        client.setQueryData<DoctorRecommendationState>(queryKey, current => newerGeneration(current, state))
      }
    },
    onSettled: (_state, _error, request) => {
      if (mounted.current && currentView.current.revision === request.viewRevision) void client.invalidateQueries({ queryKey })
    },
  })
  const adoption = useMutation({
    mutationFn: (request: { state: DoctorRecommendationState; item: DoctorRecommendationSuggestion; viewRevision: number }) =>
      getDoctorRecommendations(request.state.caseId, request.state.kind),
    onSuccess: (latest, request) => {
      if (!mounted.current || currentView.current.revision !== request.viewRevision || latest.caseId !== caseId || latest.kind !== kind) return
      const previous = client.getQueryData<DoctorRecommendationState>(queryKey)
      if (previous === undefined || previous.caseId !== caseId || previous.kind !== kind || previous.generation !== request.state.generation
        || previous.inputFingerprint !== request.state.inputFingerprint || previous.status !== 'ready' || previous.stale
        || JSON.stringify(previous.items.find(item => item.id === request.item.id)) !== JSON.stringify(request.item)) return
      client.setQueryData<DoctorRecommendationState>(queryKey, current => newerGeneration(current, latest))
      const item = latest.items.find(item => item.id === request.item.id)
      if (latest.inputFingerprint !== request.state.inputFingerprint || latest.generation !== request.state.generation
        || latest.status !== 'ready' || latest.stale || item === undefined
        || JSON.stringify(item) !== JSON.stringify(request.item) || !(callbacks.current.canAdopt?.(item) ?? true)) return
      callbacks.current.onAdopt(item, latest)
    },
  })
  const state = query.data?.caseId === caseId && query.data.kind === kind ? query.data : undefined
  const mutate = generation.mutate
  const generationPending = generation.isPending && generation.variables.viewRevision === viewRevision
  useEffect(() => {
    if (!enabled || state === undefined || generationPending || !(state.status === 'idle' || state.stale)) return
    const requestIdentity = `${viewRevision}:${state.inputFingerprint}`
    if (lastAutomaticRequest.current === requestIdentity) return
    lastAutomaticRequest.current = requestIdentity
    mutate({ state, refresh: false, viewRevision })
  }, [enabled, state, generationPending, viewRevision, mutate])

  if (!enabled) return null
  const pending = query.isLoading || state?.status === 'pending' || generationPending
  const checking = adoption.isPending && adoption.variables.viewRevision === viewRevision
  const failed = query.isError || state?.status === 'failed'
    || (generation.isError && generation.variables?.viewRevision === viewRevision)
    || (adoption.isError && adoption.variables?.viewRevision === viewRevision)
  return (
    <Card aria-label={title} role="region" className="mb-4 min-w-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{kind === 'prescription'
          ? (zh ? '结合指南与当前病例核对处方候选；采纳仅填入草稿。' : 'Review prescription suggestions against guidance and this case. Adoption only fills the draft.')
          : (zh ? '可采纳建议与待核实思路分开展示；采纳仅填入草稿。' : 'Review adoptable suggestions and considerations separately. Adoption only fills the draft.')}</CardDescription>
        <CardAction>
          <Button disabled={pending || checking || state === undefined} onClick={() => {
            if (state !== undefined) generation.mutate({ state, refresh: true, viewRevision })
          }} size="sm" variant="outline">
            <RefreshCwIcon data-icon="inline-start" />{zh ? '刷新建议' : 'Refresh suggestions'}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {checking && <p aria-live="polite" role="status">{zh ? '正在核对建议…' : 'Checking suggestions…'}</p>}
        {pending && <p aria-live="polite" role="status">{zh ? '正在生成建议…' : 'Generating suggestions…'}</p>}
        {query.isLoading && <Skeleton className="h-12 w-full" />}
        {failed && <Alert><AlertDescription>
          {zh ? '建议暂不可用。现有草稿已保留，可刷新重试。' : 'Suggestions are unavailable. Your draft is preserved; refresh to retry.'}
          {state === undefined && <Button onClick={() => { void query.refetch() }} size="sm" variant="ghost">{messages.retry}</Button>}
        </AlertDescription></Alert>}
        {state?.stale && <Alert><AlertDescription>{zh ? '病例资料已变化，更新完成后再采纳。' : 'Case information has changed. Wait for updated suggestions before adoption.'}</AlertDescription></Alert>}
        {Object.entries(noticeTitles).map(([category, labels]) => {
          const notices = state?.notices?.filter(notice => notice.category === category) ?? []
          const label = labels[zh ? 0 : 1]
          return notices.length === 0 ? null : <Alert aria-label={label} key={category}>
            <AlertTitle>{label}</AlertTitle><AlertDescription>
              <ul className="list-inside list-disc">{notices.map(notice => <li key={notice.message}>{notice.message}</li>)}</ul>
            </AlertDescription>
          </Alert>
        })}
        {state !== undefined && state.notices === undefined && state.missingInformation.length > 0 && <Alert aria-label={zh ? '补充说明' : 'Additional notes'}>
          <AlertTitle>{zh ? '补充说明' : 'Additional notes'}</AlertTitle><AlertDescription>
            <ul className="list-inside list-disc">{state.missingInformation.map(note => <li key={note}>{note}</li>)}</ul>
          </AlertDescription></Alert>}
        {state !== undefined && state.items.length > 0 && <section aria-label={zh ? '可采纳建议' : 'Suggestions to adopt'} className="flex flex-col gap-3">
          <h3 className="font-medium">{zh ? '可采纳建议' : 'Suggestions to adopt'}</h3>
          {state.items.map(item => {
            const adoptable = !pending && !checking && !state.stale && state.status === 'ready' && (canAdopt?.(item) ?? true)
            const reason = unavailableReason?.(item)
            return (
              <div className="flex min-w-0 flex-col gap-2" key={item.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-medium">{item.label}</h4>
                  <Button disabled={!adoptable} onClick={() => {
                    if (adoptable) adoption.mutate({ state, item, viewRevision })
                  }} size="sm" variant="outline">
                    {zh ? '采纳' : 'Adopt'} {item.label}
                  </Button>
                </div>
                <CaseReasoning item={item} zh={zh} />
                {item.kind === 'prescription' && <dl className="flex flex-wrap gap-3 text-sm">
                  {[
                    [zh ? '剂量' : 'Dose', item.doseText], [zh ? '频次' : 'Frequency', item.frequencyCode],
                    [zh ? '疗程（天）' : 'Course (days)', item.courseDays], [zh ? '数量' : 'Quantity', item.quantity],
                  ].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd>{value ?? messages.recommendationFieldPending}</dd></div>)}
                </dl>}
                {reason && <p className="text-sm text-muted-foreground">{reason}</p>}
                <details className="text-sm">
                  <summary className="cursor-pointer">{zh ? '查看依据' : 'View evidence'}</summary>
                  <div className="mt-2 flex flex-col gap-3">
                    {item.guidelineEvidenceIds.map(id => {
                      const evidence = state.guidelines.find(entry => entry.id === id)
                      return evidence === undefined ? null : <div key={id}>
                        <Badge variant="secondary">{documentTypes[evidence.documentType][zh ? 0 : 1]}</Badge>
                        <p><a href={evidence.url} rel="noreferrer noopener" target="_blank">{evidence.title}</a> · {evidence.version} · {evidence.locator}</p>
                        <p className="text-muted-foreground">{evidence.publisher} · {evidence.scope}</p><p>{evidence.text}</p>
                      </div>
                    })}
                    {item.caseEvidenceIds.map(id => {
                      const evidence = state.caseEvidence.find(entry => entry.id === id)
                      return evidence === undefined ? null : <div key={id}><Badge variant="outline">{evidence.label}</Badge><p>{evidence.text}</p></div>
                    })}
                  </div>
                </details>
                <Separator />
              </div>
            )
          })}
        </section>}
        {(state?.considerations?.length ?? 0) > 0 && <section aria-label={zh ? '待核实思路' : 'Considerations to verify'} className="flex flex-col gap-3">
          <h3 className="font-medium">{zh ? '待核实思路' : 'Considerations to verify'}</h3>
          <p className="text-sm text-muted-foreground">{zh ? '仅供查看，需由医生核实病例依据与适用性。' : 'For review only. The doctor must verify case support and applicability.'}</p>
          {state?.considerations?.map(item => <article aria-label={item.label} className="flex min-w-0 flex-col gap-2" key={item.id}>
            <h4 className="font-medium">{item.label}</h4>
            <CaseReasoning item={item} zh={zh} />
            <div className="flex flex-col gap-2 text-sm">
              <span className="font-medium">{zh ? '病例依据' : 'Case evidence'}</span>
              {item.caseEvidenceIds.map(id => {
                const evidence = state.caseEvidence.find(entry => entry.id === id)
                return evidence === undefined ? null : <div key={id}><Badge variant="outline">{evidence.label}</Badge><p>{evidence.text}</p></div>
              })}
            </div>
            <Separator />
          </article>)}
        </section>}
        {!pending && !failed && state?.items.length === 0 && (state.considerations?.length ?? 0) === 0 && <Empty>
          <EmptyHeader><EmptyTitle>{zh ? '暂无可采纳的建议' : 'No suggestions to adopt'}</EmptyTitle>
            <EmptyDescription>{zh ? '本轮未发布建议，请查看上方说明，并结合病例继续评估。' : 'No suggestions were published in this round. Review the notes above and continue assessing the case.'}</EmptyDescription>
          </EmptyHeader>
        </Empty>}
      </CardContent>
    </Card>
  )
}
