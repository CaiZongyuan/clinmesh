import type { z } from 'zod'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { inpatientDrgAgentSchema, inpatientDrgAgentConfirmInputSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { WorkspaceSelect } from './workspace-select.tsx'
import { Badge } from '@clinmesh/ui/components/badge'
import { apiGet } from './api-client.ts'
import { inpatientScopeKey } from './inpatient-scope.ts'
import { formatFen } from './workspace-format.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>; active: boolean }
type Agent = z.infer<typeof inpatientDrgAgentSchema>
type Item = NonNullable<Agent['analysis']>['items'][number]
const stageLabels = { preoperative: ['术前', 'Preoperative'], intraoperative: ['术中', 'Intraoperative'], postoperative: ['术后', 'Postoperative'] } as const

export function InpatientDrgAgentPanel({ admission, session, locale, write, active }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const query = useQuery({ queryKey: [...inpatientScopeKey(session), admission.id, 'drg-agent'], enabled: active, retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/agent`, inpatientDrgAgentSchema, signal),
    refetchInterval: active && admission.recordStatus !== 'archived' ? 3_000 : false, refetchIntervalInBackground: false })
  const selection = useQuery({ queryKey: [...inpatientScopeKey(session), admission.id, 'pci-selection'], enabled: active, retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/pci-selection`, inpatientPciSelectionSchema, signal),
    refetchInterval: active && admission.recordStatus !== 'archived' ? 3_000 : false, refetchIntervalInBackground: false })
  const intent = write.pending?.command ?? write.mutation.variables
  const mutationError = intent !== undefined && 'admissionId' in intent.input && intent.input.admissionId === admission.id ? write.mutation.error : null
  const data = query.data, analysis = data?.analysis
  const fresh = data?.status === 'succeeded' && analysis !== null && analysis !== undefined && analysis.basisFingerprint === data.basisFingerprint && query.error === null
  const status = data ? {
    inactive: data.taskId === null ? t('尚未开启模型分析', 'Model analysis is inactive') : t('本轮模型分析已停止', 'Model analysis has stopped'), incomplete: t('模型分析尚未完成，依据不完整', 'Model analysis is incomplete; sources are missing'),
    queued: t('等待模型分析', 'Waiting for model analysis'), running: t('模型分析进行中', 'Model analysis is running'),
    succeeded: t('模型分析与核验已完成', 'Model analysis and verification completed'), stale: t('依据已变化，建议需重评', 'Sources changed; reassessment required'),
    blocked: t('模型分析尚未完成，派发受阻', 'Model analysis is incomplete; dispatch is blocked'), unknown: t('模型请求结果未知，等待核查', 'Model request outcome is unknown; reconciliation required'), failed: t('模型分析失败', 'Model analysis failed'),
  }[data.status] : ''
  return <section aria-label={t('住院耗材建议', 'Inpatient material recommendations')} className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2"><h4 className="font-medium">{t('住院耗材建议', 'Inpatient material recommendations')}</h4>{data ? <Badge variant="secondary">{status}</Badge> : null}</div>
    <p>{t('建议与已确认计划、实际使用分别保留。确认计划不执行手术、不形成收费。', 'Recommendations, confirmed plans and actual use are retained separately. Confirming a plan does not perform surgery or create charges.')}</p>
    {query.isPending && query.fetchStatus !== 'idle' ? <p role="status">{t('正在读取耗材建议', 'Loading recommendations')}</p> : null}
    {query.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(query.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    {selection.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(selection.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    {mutationError ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(mutationError, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    {data?.missing.map(reason => <p key={reason}>{reason}</p>)}
    {data?.failureCode ? <Alert variant="destructive"><AlertDescription>{status} · {data.failureCode}</AlertDescription></Alert> : null}
    {analysis ? <>
      <h5 className="font-medium">{fresh ? t('当前模型建议', 'Current model recommendation') : t('历史模型建议，暂不可确认', 'Historical model recommendation; confirmation unavailable')}</h5>
      <p>{t(stageLabels[analysis.stage][0], stageLabels[analysis.stage][1])} · {analysis.model} · {analysis.createdAt}</p>
      {!fresh ? <Alert><AlertDescription>{t('旧依据的建议不能作为当前有效建议；请核对最新参数与分析状态。', 'Recommendations based on old sources are not current. Review the latest parameters and analysis state.')}</AlertDescription></Alert> : null}
      <PlanItems items={analysis.items} locale={locale} /><SourcesDetails sources={analysis.sources} locale={locale} />
      {!data?.confirmedPlan ? <p>{t('建议尚未作为已确认计划，请由医生审阅。', 'This recommendation is not yet a confirmed plan. Doctor review is required.')}</p> : null}
    </> : null}
    {data?.analysis && selection.data && session.actor.roleCode === 'inpatient-doctor' && admission.status === 'admitted' && admission.recordStatus !== 'archived' ? <PlanEditor key={`${admission.id}:${data.analysis.id}:${data.confirmedPlan?.revision ?? 0}`} admission={admission} data={data} selection={selection.data} locale={locale} write={write} current={fresh && active && !query.isFetching && !selection.isFetching && selection.error === null} /> : null}
    {data?.confirmedPlan ? <section aria-label={t('已确认耗材计划', 'Confirmed material plan')} className="flex flex-col gap-2">
      <h5 className="font-medium">{t('已确认耗材计划', 'Confirmed material plan')} v{data.confirmedPlan.revision}</h5>
      {data.confirmedPlan.basisFingerprint !== data.basisFingerprint || !fresh ? <p>{t('原确认计划需重评，原始确认事实仍保留。', 'The original plan requires reassessment; its confirmation record is retained.')}</p> : null}
      <p>{t(stageLabels[data.confirmedPlan.stage][0], stageLabels[data.confirmedPlan.stage][1])}</p>
      <p>{data.confirmedPlan.confirmedBy} · {data.confirmedPlan.confirmedAt} · {data.confirmedPlan.note}</p><PlanItems items={data.confirmedPlan.items} locale={locale} /><SourcesDetails sources={data.confirmedPlan.sources} locale={locale} />
    </section> : null}
    {data && data.planHistory.length > 0 ? <details><summary>{t('查看已确认计划历史', 'Review confirmed plan history')}</summary>{data.planHistory.map(plan => <article key={plan.revision}><p>v{plan.revision} · {t(stageLabels[plan.stage][0], stageLabels[plan.stage][1])} · {plan.confirmedBy} · {plan.confirmedAt} · {plan.note}</p><PlanItems items={plan.items} locale={locale} /><SourcesDetails sources={plan.sources} locale={locale} /></article>)}</details> : null}
  </section>
}
function PlanItems({ items, locale }: { items: Item[]; locale: WorkspaceLocale }) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  return <div className="flex flex-col gap-2">{items.map(item => <article key={item.materialId} className="flex flex-col gap-1 rounded-md border p-3">
    <p>{item.display} · {item.materialId} v{item.catalogVersion}</p>
    <p>{item.quantity}{item.unit} · {formatFen(item.unitPriceFen, locale)}/{item.unit} · {t('预计收费 ', 'Estimated charge ')}{formatFen(item.estimatedFen, locale)}</p>
    <p>{t('数量来源：', 'Quantity basis: ')}{item.quantityBasis}</p><p>{item.reason}</p><p>{t('依据引用：', 'Evidence references: ')}{item.evidenceIds.join('、')}</p>
  </article>)}</div>
}

function PlanEditor({ admission, data, selection, locale, write, current }: { admission: InpatientAdmission; data: Agent; selection: z.infer<typeof inpatientPciSelectionSchema>; locale: WorkspaceLocale; write: Props['write']; current: boolean }) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const initial = data.confirmedPlan?.basisFingerprint === data.basisFingerprint ? data.confirmedPlan.items : data.analysis!.items
  const [items, setItems] = useState(() => initial.map(item => ({ materialId: item.materialId, catalogVersion: item.catalogVersion, quantity: String(item.quantity), reason: item.reason })))
  const [note, setNote] = useState('')
  const candidates = selection.candidates.filter(candidate => candidate.eligibility === 'valid' && candidate.item !== null)
  const supported = items.length > 0 && new Set(items.map(item => item.materialId)).size === items.length && items.every(item => candidates.some(candidate => candidate.materialId === item.materialId && candidate.materialVersion === item.catalogVersion && candidate.expectedQuantity === Number(item.quantity)))
  const input = inpatientDrgAgentConfirmInputSchema.safeParse({ admissionId: admission.id, analysisId: data.analysis!.id, expectedBasisFingerprint: data.basisFingerprint,
    expectedRevision: data.confirmedPlan?.revision ?? 0, note, items: items.map(item => ({ ...item, quantity: Number(item.quantity) })) })
  const blocked = write.blocked
  return <form onSubmit={event => { event.preventDefault(); if (!blocked && current && supported && input.success) write.mutation.mutate({ operation: 'inpatient.drg.agent.confirm', input: input.data }) }}>
    <FieldSet disabled={blocked}><FieldLegend>{t('医生审阅耗材计划', 'Doctor review of material plan')}</FieldLegend><FieldGroup>
      {items.map((item, index) => {
        const candidate = candidates.find(candidate => candidate.materialId === item.materialId && candidate.materialVersion === item.catalogVersion)
        const original = data.analysis!.items.find(value => value.materialId === item.materialId)
        const label = candidate?.item?.display ?? original?.display ?? item.materialId
        const update = (patch: Partial<typeof item>) => setItems(previous => previous.map((value, position) => position === index ? { ...value, ...patch } : value))
        const quantityValid = candidate?.expectedQuantity === Number(item.quantity)
        const quantityBasis = selection.confirmation?.parameters.plannedQuantities.find(plan => plan.category === candidate?.category)?.basis
        return <FieldGroup key={index}>
          <Field><FieldLabel htmlFor={`drg-plan-product-${index}`}>{t('计划产品', 'Planned product')}{index + 1}</FieldLabel><WorkspaceSelect id={`drg-plan-product-${index}`} value={candidate ? `${item.materialId}:${item.catalogVersion}` : null} items={candidates.filter(value => value.materialId === item.materialId || !items.some(selected => selected.materialId === value.materialId)).map(value => ({ value: `${value.materialId}:${value.materialVersion}`, label: `${value.item!.display} · v${value.materialVersion}` }))} onValueChange={value => { const selected = candidates.find(candidate => `${candidate.materialId}:${candidate.materialVersion}` === value); if (selected) update({ materialId: selected.materialId, catalogVersion: selected.materialVersion }) }} /></Field>
          <Field data-invalid={!quantityValid}><FieldLabel htmlFor={`drg-plan-quantity-${index}`}>{t('预计数量：', 'Planned quantity: ')}{label}</FieldLabel><Input id={`drg-plan-quantity-${index}`} aria-invalid={!quantityValid} type="number" min="1" max="1000" step="1" value={item.quantity} onChange={event => update({ quantity: event.currentTarget.value })} /></Field>
          <Field data-invalid={!item.reason.trim()}><FieldLabel htmlFor={`drg-plan-reason-${index}`}>{t('计划理由：', 'Plan reason: ')}{label}</FieldLabel><Input id={`drg-plan-reason-${index}`} aria-invalid={!item.reason.trim()} maxLength={2000} value={item.reason} onChange={event => update({ reason: event.currentTarget.value })} /></Field>
          <p>{t('数量来源：', 'Quantity basis: ')}{quantityBasis ?? t('未知', 'Unknown')} · {t('预计收费：', 'Estimated charge: ')}{candidate?.expectedAmountFen !== null && candidate?.expectedAmountFen !== undefined && quantityValid ? formatFen(candidate.expectedAmountFen, locale) : t('尚未核验', 'Not verified')}</p>
        </FieldGroup>
      })}
      {!supported ? <Alert><AlertDescription>{t('修改后的产品或数量超出当前核验范围。请先在手术页更新并确认 PCI 参数，再审阅新建议。', 'The changed product or quantity is outside the verified scope. Update and confirm PCI parameters under Surgery, then review the new recommendation.')}</AlertDescription></Alert> : null}
      <Field><FieldLabel htmlFor="drg-plan-note">{t('医生确认说明', 'Doctor confirmation note')}</FieldLabel><Input id="drg-plan-note" required maxLength={2000} value={note} onChange={event => setNote(event.currentTarget.value)} /></Field>
      <Button type="submit" disabled={blocked || !current || !supported || !input.success}>{t('确认耗材计划', 'Confirm material plan')}</Button>
    </FieldGroup></FieldSet>
  </form>
}

function SourcesDetails({ sources, locale }: { sources: NonNullable<Agent['analysis']>['sources']; locale: WorkspaceLocale }) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  return <details><summary>{t('查看原参数与证据版本', 'Review original parameter and evidence versions')}</summary>
    <p>{t('原参数确认：', 'Original parameter confirmation: ')}{sources.selectionConfirmationId} v{sources.selectionVersion}</p>
    <p>{t('原依据包：', 'Original evidence package: ')}{sources.evidencePackageId} · {sources.evidencePackageVersion}</p>
    <p>{t('以下是形成该结果时冻结的合成依据，只证明明示仿真范围，不是真实器械 IFU 或临床金标准。', 'The following synthetic evidence was frozen with this result. It supports only the stated simulation scope and is not a real device IFU or clinical gold standard.')}</p>
    {sources.materialEvidence.map(evidence => <article key={evidence.id}><p>{evidence.id} · {evidence.version} · {evidence.specification}</p><p>{evidence.scope}</p><p>{evidence.applicability}</p><p>{evidence.compatibility}</p><p>{evidence.quantityBasis}</p><p>{evidence.sourceLocator}</p></article>)}
  </details>
}
