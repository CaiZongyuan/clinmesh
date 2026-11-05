import { InpatientDrgAgentPanel } from './inpatient-drg-agent.tsx'
import { DrgChargeMix, DrgPaymentMonitor } from './inpatient-drg-monitor.tsx'
import { InpatientDrgRecordChecksPanel, type DrgRecordTarget } from './inpatient-drg-record-checks.tsx'
import { InpatientDrgFollowupPanel } from './inpatient-drg-followup.tsx'
import type { z } from 'zod'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientDrgPregroupResultSchema } from '@clinmesh/contracts/inpatient-drg'
import type { drgGroupingResultSchema } from '@clinmesh/contracts/drg'
import { inpatientDrgRecordChecksSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { inpatientDrgSimulationSchema, type InpatientDrgSimulationInput } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ApiClientError, apiGet, apiMutation } from './api-client.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { DrgGroupingEvidence, drgGroupingStatusLabel } from './inpatient-drg-summary.tsx'

export type DrgReview = { fingerprint: string; estimatedTotalFen: number; drgCode: string | null }
export type DrgEvaluationState = { fingerprint: string | null; stale: boolean; reviewable: boolean }
type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent> }

export function DrgError({ error, locale }: { error: Error | null; locale: WorkspaceLocale }): React.JSX.Element | null {
  if (error === null) return null
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const code = error instanceof ApiClientError ? error.code : ''
  const message = code === 'DRG_RULES_NOT_CONFIGURED' ? t('尚未配置分组规则，暂不能评估；临床诊疗仍可继续。', 'Grouping rules are not configured. Clinical care can continue.')
    : code === 'DRG_PAYMENT_PARAMETER_MISSING' ? t('本病组缺少合成支付参数，暂不能核定。原归档结果保留。', 'Synthetic payment parameters are missing for this group. The archived result is retained.')
      : code === 'INPATIENT_DRG_EVALUATION_STALE' || code === 'INPATIENT_DRG_PAYER_PREVIEW_STALE' ? t('诊疗、费用或目录已变化，请刷新依据并重新审阅后提交。', 'Care, charges or the catalog changed. Refresh and review before submitting.')
        : code === 'DRG_FROZEN_RESULT_MISSING' ? t('归档时未形成固定分组，当前没有可复核的分组依据。', 'No grouping result was fixed at archive time.')
          : code === 'DRG_FROZEN_UNGROUPED' ? t('归档病例尚未确定病组，暂不能模拟核定。', 'The archived case has no determined group and cannot be assessed.')
            : code === 'INPATIENT_DRG_NOT_ARCHIVED' ? t('病案尚未归档，归档后才能模拟核定。', 'Archive the medical record before assessment.')
              : getWorkspaceErrorMessage(error, getWorkspaceMessages(locale))
  return <Alert variant="destructive"><AlertDescription>{message}</AlertDescription></Alert>
}

export function DrgGrouping({ result, locale, title }: { result: z.infer<typeof drgGroupingResultSchema>; locale: WorkspaceLocale; title: string }): React.JSX.Element {
  const status = drgGroupingStatusLabel(result.status, locale)
  return <section aria-label={title} className="flex flex-col gap-2">
    <h4 className="font-medium">{title}</h4>
    <p>{status}{result.drgCode ? ` · ${result.drgCode}` : ''}</p>
    <DrgGroupingEvidence result={result} locale={locale} />
  </section>
}

export function InpatientDrgPanel({ admission, session, locale, write, draft, onReview, active = true, onEvaluationChange, onOpenRecord }: Props & {
  draft?: InpatientDrgSimulationInput; onReview?: (review: DrgReview) => void; reservations?: boolean; active?: boolean; onEvaluationChange?: (state: DrgEvaluationState) => void; onOpenRecord?: (target: DrgRecordTarget) => void
}): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const scope = ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id]
  const path = `/api/his/v1/inpatient/admissions/${admission.id}/drg`
  const archived = admission.recordStatus === 'archived'
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  const enabled = active && visible && !archived && admission.status !== 'registered'
  const allowPlanSelection = draft === undefined && onReview === undefined && !archived
  const surgery = useQuery({ queryKey: [...scope, 'surgeries'], enabled: enabled && allowPlanSelection,
    refetchInterval: enabled && allowPlanSelection ? 3_000 : false, refetchIntervalInBackground: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/surgeries`, inpatientSurgerySchema, signal) })
  const plans = (surgery.data?.requests ?? []).filter(item => item.status === 'requested' || item.status === 'ready')
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const primarySurgeryRequestId = allowPlanSelection && plans.length > 1 && plans.some(item => item.id === selectedPlanId) ? selectedPlanId : null
  const simulationInput = draft ?? (primarySurgeryRequestId === null ? undefined : { medications: [], services: [], primarySurgeryRequestId })
  const evaluationKey = JSON.stringify([...scope, simulationInput ?? null])
  const currentKey = useRef(evaluationKey)
  currentKey.current = evaluationKey
  // Only the accepted fingerprint and its invalidation latch are view state; Query owns the result.
  const [basis, setBasis] = useState<{ key: string; fingerprint: string; stale: boolean }>()
  const grouping = useQuery({ queryKey: [...scope, 'drg-pregroup'], enabled: archived, retry: false,
    queryFn: ({ signal }) => apiGet(`${path}/pregroup`, inpatientDrgPregroupResultSchema, signal) })
  const simulation = useQuery({ queryKey: [...scope, 'drg-simulation', simulationInput ?? null], enabled, retry: false, refetchInterval: enabled ? 3_000 : false, refetchIntervalInBackground: false,
    queryFn: ({ signal }) => apiMutation(`${path}/simulation`, inpatientDrgSimulationSchema, { input: simulationInput ?? {} }, { signal }) })
  const checks = useQuery({ queryKey: [...scope, 'drg-record-checks'], enabled: false, retry: false,
    queryFn: ({ signal }) => apiGet(`${path}/record-checks`, inpatientDrgRecordChecksSchema, signal) })
  const data = simulation.data
  const fingerprint = data?.fingerprint ?? null
  const accepted = basis?.key === evaluationKey ? basis : undefined
  const stale = accepted !== undefined && (accepted.stale || fingerprint !== accepted.fingerprint)
  const reviewable = enabled && accepted !== undefined && !stale && !simulation.isFetching && simulation.error === null && data?.draft.missing.length === 0
  useEffect(() => {
    if (fingerprint === null) return
    setBasis(previous => previous?.key !== evaluationKey ? { key: evaluationKey, fingerprint, stale: false }
      : previous.fingerprint !== fingerprint && !previous.stale ? { ...previous, stale: true } : previous)
  }, [evaluationKey, fingerprint])
  useEffect(() => { onEvaluationChange?.({ fingerprint, stale, reviewable }) }, [fingerprint, stale, reviewable, onEvaluationChange])
  const recalculate = async () => {
    if (archived) { await grouping.refetch(); return }
    const result = await simulation.refetch()
    if (currentKey.current === evaluationKey && result.error === null && result.data)
      setBasis({ key: evaluationKey, fingerprint: result.data.fingerprint, stale: false })
  }
  // 环节首行由住院工作台渲染；更新时间与重新计算跟在同一行，避免重复说明。
  const host = useRef<HTMLElement>(null), [turnSlot, setTurnSlot] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => { setTurnSlot(host.current?.closest('.clinmesh-inpatient-stage')?.querySelector<HTMLElement>('.clinmesh-inpatient-turn > p') ?? null) }, [])
  const updatedAt = data ? new Date(data.evaluatedAt).toLocaleTimeString(locale, { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }) : null
  const refresh = <Button variant="link" size="sm" className="h-auto px-0 text-xs text-info" disabled={(archived ? grouping.isFetching : simulation.isFetching) || admission.status === 'registered'} onClick={() => void recalculate()}>{archived ? t('刷新固定结果', 'Refresh fixed result') : t('重新计算', 'Recalculate')}</Button>
  return <section ref={host} aria-label={t('DRG 预分组', 'DRG and charge estimate')} className="flex flex-col gap-3">
    {!archived && turnSlot ? createPortal(<span className="ml-2 inline-flex items-center gap-2 text-xs font-normal text-muted-foreground">{updatedAt ? `· ${updatedAt} ${t('已更新', 'updated')}` : null}{refresh}</span>, turnSlot)
      : <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{archived ? t('病案已归档 · 结算与分组结果已固定', 'Medical record archived · grouping result fixed') : `${t('随诊断、手术和收费自动更新', 'Updates automatically with diagnoses, procedures and charges')}${updatedAt ? ` · ${updatedAt}` : ''}`}</span>{refresh}
      </div>}
    {archived ? <>
      {grouping.isPending ? <p role="status">{t('正在读取固定结果', 'Loading fixed result')}</p> : null}
      <DrgError error={grouping.error} locale={locale} />
      {grouping.data ? <><DrgGrouping result={grouping.data.result} locale={locale} title={t('归档分组', 'Fixed archive grouping')} /><p className="text-sm text-muted-foreground">{t('归档结果保持固定，后续规则及财务更正不改写此病组。', 'This result is fixed. Later rules or financial corrections do not rewrite the group.')}</p></> : null}
    </> : <>
    {allowPlanSelection && plans.length > 1 ? <FieldGroup><Field><FieldLabel htmlFor="drg-primary-plan">{t('计划主操作（仅预计）', 'Primary planned procedure (estimate only)')}</FieldLabel><WorkspaceSelect id="drg-primary-plan" value={primarySurgeryRequestId} placeholder={t('请选择计划主操作', 'Select the primary planned procedure')} items={plans.map(item => ({ value: item.id, label: `${item.plannedProcedure.coding.code} · ${item.plannedProcedure.coding.display} · ${item.reason}` }))} onValueChange={setSelectedPlanId} /><p className="text-sm text-muted-foreground">{t('多个待实施计划须明确预计主操作。此选择不更改实际主操作或病案首页。', 'Choose a primary procedure when several plans remain. This does not change performed procedures or the medical record.')}</p></Field></FieldGroup> : null}
    {simulation.isPending && simulation.fetchStatus !== 'idle' ? <p role="status">{t('正在计算分组与费用', 'Calculating grouping and charges')}</p> : null}
    {data ? <p role="status" aria-label={t('分组费用核对状态', 'Grouping and charge refresh status')} aria-hidden={!simulation.isFetching} className="aria-hidden:invisible">{t('正在更新，旧结果暂不可用于审阅。', 'Updating; the previous result cannot be reviewed.')}</p> : null}
    <DrgError error={simulation.error ?? (allowPlanSelection ? surgery.error : null)} locale={locale} />
    {stale ? <DrgStaleNotice locale={locale} /> : null}
    {data && !simulation.error ? <>
      <DrgPaymentMonitor data={data} costs={checks.error === null ? checks.data?.costs : undefined} locale={locale} />
      <DrgChargeMix data={data} locale={locale} onOpenFees={onOpenRecord ? () => onOpenRecord('fees') : undefined} />
      {data.draft.missing.length > 0 ? <Alert><AlertDescription>{t('部分待提交项目缺少当前目录价格，请刷新目录后重新选择；本次费用预计不完整。', 'Some pending items lack current catalog prices. Refresh and select again; this estimate is incomplete.')}</AlertDescription></Alert> : null}
      {data.incompleteness.paymentReferenceMissing ? <p className="text-sm text-muted-foreground">{t('当前正式病组的医院支付参考参数不完整。', 'Hospital payment reference parameters are incomplete for the formal group.')}</p> : null}
      {onReview && draft ? <Button disabled={write.blocked || admission.status !== 'admitted' || !reviewable} onClick={() => onReview({ fingerprint: data.fingerprint, estimatedTotalFen: data.coverage.estimatedTotalFen, drgCode: data.grouping.formal.drgCode ?? null })}>{t('审阅预计并开立医嘱', 'Review estimate and issue order')}</Button> : null}
    </> : null}
    </>}
    {onReview === undefined ? <>
      <div className="rounded-lg border p-3">
        <InpatientDrgRecordChecksPanel key={`${session.actor.workspaceId}/${session.actor.epoch}/${session.actor.practitionerRoleId}/${admission.id}`} admission={admission} session={session} locale={locale} write={write} active={active && visible} onOpenRecord={onOpenRecord} />
      </div>
      <InpatientDrgFollowupPanel admission={admission} session={session} locale={locale} write={write} active={active && visible}>
        <InpatientDrgAgentPanel admission={admission} session={session} locale={locale} write={write} active={active && visible} />
      </InpatientDrgFollowupPanel>
    </> : null}
  </section>
}

export function DrgStaleNotice({ locale }: { locale: WorkspaceLocale }): React.JSX.Element {
  return <Alert variant="destructive"><AlertDescription>{locale === 'zh-CN' ? '评估已过期。诊疗、费用或目录已变化；请重新计算并审阅。' : 'This assessment is stale. Care, charges or the catalog changed; recalculate and review.'}</AlertDescription></Alert>
}
