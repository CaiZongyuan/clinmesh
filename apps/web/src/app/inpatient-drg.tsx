import { InpatientDrgAgentPanel } from './inpatient-drg-agent.tsx'
import { InpatientDrgReviewPanel } from './inpatient-drg-review.tsx'
import { InpatientDrgFollowupPanel } from './inpatient-drg-followup.tsx'
import type { z } from 'zod'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientDrgPregroupResultSchema } from '@clinmesh/contracts/inpatient-drg'
import type { drgGroupingResultSchema } from '@clinmesh/contracts/drg'
import { inpatientDrgSimulationSchema, inpatientMaterialReservationListSchema, type InpatientDrgSimulationInput } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientSurgeryCatalogSchema, inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { InpatientConfirmation } from './inpatient-confirmation.tsx'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { ApiClientError, apiGet, apiMutation } from './api-client.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'

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
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const status = { grouped: t('已分组', 'Grouped'), ungroupable: t('无法入组', 'Ungroupable'), ambiguous: t('分组有歧义', 'Ambiguous group'), 'invalid-input': t('分组依据不完整', 'Incomplete grouping input') }[result.status]
  return <section aria-label={title} className="flex flex-col gap-2">
    <h4 className="font-medium">{title}</h4>
    <p>{status}{result.drgCode ? ` · ${result.drgCode}` : ''}</p>
    {result.reason ? <p className="text-sm text-muted-foreground">{result.reason}</p> : null}
    {result.steps.length > 0 ? <details><summary>{t('查看分组依据', 'Grouping basis')}</summary><ol className="list-inside list-decimal text-sm">{result.steps.map((step, index) => <li key={index}>{step.basis}{step.matchedCode ? ` · ${t('命中编码 ', 'Matched code ')}${step.matchedCode}` : ''} · {step.result}</li>)}</ol></details> : null}
  </section>
}

export function InpatientDrgPanel({ admission, session, locale, write, draft, onReview, reservations = true, active = true, onEvaluationChange }: Props & {
  draft?: InpatientDrgSimulationInput; onReview?: (review: DrgReview) => void; reservations?: boolean; active?: boolean; onEvaluationChange?: (state: DrgEvaluationState) => void
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
  const groups = data ? [
    { title: t('已发生收费', 'Posted charges'), items: data.formal.items },
    { title: t('已开立待执行', 'Ordered, not yet charged'), items: data.committed.items },
    { title: t('治疗预留', 'Treatment reservations'), items: data.reserved.items },
    { title: t('当前待提交项目', 'Current pending items'), items: data.draft.items },
  ] : []
  return <section aria-label={t('DRG 预分组', 'DRG and charge estimate')} className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{t('DRG 预分组', 'DRG and charge estimate')}</h3><Button variant="outline" disabled={(archived ? grouping.isFetching : simulation.isFetching) || admission.status === 'registered'} onClick={() => void recalculate()}>{archived ? t('刷新固定结果', 'Refresh fixed result') : t('重新计算', 'Recalculate')}</Button></div>
    {onReview === undefined ? <InpatientDrgReviewPanel admission={admission} session={session} locale={locale} write={write} active={active && visible} /> : null}
    {onReview === undefined ? <InpatientDrgFollowupPanel admission={admission} session={session} locale={locale} write={write} active={active && visible} /> : null}
    {onReview === undefined ? <InpatientDrgAgentPanel admission={admission} session={session} locale={locale} write={write} active={active && visible} /> : null}
    <p className="text-sm text-muted-foreground">{t('正式分组读取已确认诊疗。计划与待提交项目仅供比较，不改变临床记录；医院支付参考与患者医保待遇分别计算。', 'Formal grouping reads confirmed care. Plans and pending items are comparisons only. Hospital payment references and patient benefits are calculated separately.')}</p>
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
      <div className="grid gap-4 md:grid-cols-2"><DrgGrouping result={data.grouping.formal} locale={locale} title={t('按当前诊断和手术', 'Current diagnoses and procedures')} />{data.grouping.projected ? <DrgGrouping result={data.grouping.projected} locale={locale} title={t('如按计划手术', 'If surgery proceeds as planned')} /> : null}</div>
      <p data-testid="drg-charges">{t('已发生收费 ', 'Posted charges ')}{formatFen(data.formal.chargesFen, locale)} · {t('含计划、预留及待提交项目的费用预计 ', 'Charges including plans, reservations and pending items ')}{formatFen(data.coverage.estimatedTotalFen, locale)}</p>
      <p className="text-sm text-muted-foreground">{t('预计收入：尚未取得完整收入组成，暂不估算。', 'Expected revenue: unavailable until all revenue components are known.')}</p>
      {data.incompleteness.costMissing ? <p className="text-sm text-muted-foreground">{t('已覆盖成本：成本资料不完整，暂不估算，也不能据此判断住院盈亏。', 'Covered cost: cost data is incomplete; no estimate or profit and loss calculation is available.')}</p> : null}
      {data.incompleteness.paymentReferenceMissing ? <p className="text-sm text-muted-foreground">{t('当前正式病组的医院支付参考参数不完整。', 'Hospital payment reference parameters are incomplete for the formal group.')}</p> : null}
      {data.paymentReference ? <div className="rounded-md border p-3"><p>{t('正式病组医院支付参考 ', 'Hospital payment reference ')}{data.paymentReference.drgCode} · {formatFen(data.paymentReference.referenceFen, locale)}</p><p>{t('参考额减已发生收费 ', 'Reference less posted charges ')}{formatFen(data.paymentReference.referenceFen - data.formal.chargesFen, locale)} · {t('参考额减预计费用 ', 'Reference less estimated charges ')}{formatFen(data.paymentReference.referenceFen - data.coverage.estimatedTotalFen, locale)}</p><p className="text-sm text-muted-foreground">{t('合成参数修订 ', 'Synthetic parameter revision ')}{data.paymentReference.parameterVersion} · {data.paymentReference.note}</p></div> : null}
      {data.draft.missing.length > 0 ? <Alert><AlertDescription>{t('部分待提交项目项目缺少当前目录价格，请刷新目录后重新选择；本次费用预计不完整。', 'Some pending items items lack current catalog prices. Refresh and select again; this estimate is incomplete.')}</AlertDescription></Alert> : null}
      <Table><TableHeader><TableRow><TableHead>{t('归集', 'Category')}</TableHead><TableHead>{t('项目', 'Item')}</TableHead><TableHead>{t('数量', 'Quantity')}</TableHead><TableHead>{t('金额', 'Amount')}</TableHead></TableRow></TableHeader><TableBody>{groups.flatMap(group => group.items.map((item, index) => <TableRow key={`${group.title}-${item.id}-${index}`}><TableCell>{group.title}</TableCell><TableCell>{item.display}</TableCell><TableCell>{item.quantity}</TableCell><TableCell>{item.estimatedFen === null ? t('缺价', 'Price missing') : formatFen(item.estimatedFen, locale)}</TableCell></TableRow>))}</TableBody></Table>
      {groups.every(group => group.items.length === 0) ? <p>{t('尚无费用、计划或待提交项目项目。', 'No charges, plans or pending items items yet.')}</p> : null}
      <p className="text-xs text-muted-foreground">{t('规则修订：', 'Rules revision: ')}{data.rulesVersion}</p>
      {onReview && draft ? <Button disabled={write.blocked || admission.status !== 'admitted' || !reviewable} onClick={() => onReview({ fingerprint: data.fingerprint, estimatedTotalFen: data.coverage.estimatedTotalFen, drgCode: data.grouping.formal.drgCode ?? null })}>{t('审阅预计并开立医嘱', 'Review estimate and issue order')}</Button> : null}
    </> : null}
    {reservations && admission.status === 'admitted' ? <MaterialReservations admission={admission} session={session} locale={locale} write={write} /> : null}
    </>}
  </section>
}

export function DrgStaleNotice({ locale }: { locale: WorkspaceLocale }): React.JSX.Element {
  return <Alert variant="destructive"><AlertDescription>{locale === 'zh-CN' ? '评估已过期。诊疗、费用或目录已变化；请重新计算并审阅。' : 'This assessment is stale. Care, charges or the catalog changed; recalculate and review.'}</AlertDescription></Alert>
}

function MaterialReservations({ admission, session, locale, write }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const scope = ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id]
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  const list = useQuery({ queryKey: [...scope, 'drg-reservations'], queryFn: ({ signal }) => apiGet(`${path}/drg/reservations`, inpatientMaterialReservationListSchema, signal) })
  const catalog = useQuery({ queryKey: [...scope, 'surgery-catalog'], queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/surgery-catalog', inpatientSurgeryCatalogSchema, signal) })
  const surgery = useQuery({ queryKey: [...scope, 'surgeries'], queryFn: ({ signal }) => apiGet(`${path}/surgeries`, inpatientSurgerySchema, signal) })
  const [materialId, setMaterialId] = useState<string | null>(null), [requestId, setRequestId] = useState<string | null>(null)
  const [quantity, setQuantity] = useState('1'), [reason, setReason] = useState('')
  const [review, setReview] = useState<Parameters<typeof write.mutation.mutate>[0]>()
  const materials = catalog.data?.materials.filter(item => 'chargeDefinition' in item) ?? []
  const material = materials.find(item => item.id === materialId)
  const amount = Number(quantity), valid = Number.isInteger(amount) && amount > 0 && amount <= 1000
  const error = list.error ?? catalog.error ?? surgery.error
  return <section aria-label={t('治疗耗材预留', 'Treatment material reservations')} className="flex flex-col gap-3">
    <h4 className="font-medium">{t('治疗耗材预留', 'Treatment material reservations')}</h4>
    <p className="text-sm text-muted-foreground">{t('预留用于预计，未使用余量不计费。实际使用须逐笔引用预留；已消耗部分保留正式收费，不再重复预计。', 'Unused reservations are estimates and carry no charge. Reference a reservation for each actual use; consumed quantities retain their posted charges and leave the estimate.')}</p>
    <DrgError error={error} locale={locale} />
    <FieldSet disabled={write.blocked}><FieldLegend>{t('新增预留', 'New reservation')}</FieldLegend><FieldGroup className="grid gap-3 md:grid-cols-2">
      <Field><FieldLabel htmlFor="drg-material">{t('预留耗材', 'Material')}</FieldLabel><WorkspaceSelect id="drg-material" value={materialId} items={materials.map(item => ({ value: item.id, label: item.display }))} onValueChange={setMaterialId} /></Field>
      <Field><FieldLabel htmlFor="drg-request">{t('关联手术计划', 'Surgery plan')}</FieldLabel><WorkspaceSelect id="drg-request" value={requestId ?? ''} items={[{ value: '', label: t('未关联', 'Not linked') }, ...(surgery.data?.requests ?? []).filter(item => item.status === 'requested' || item.status === 'ready').map(item => ({ value: item.id, label: item.plannedProcedure.coding.display }))]} onValueChange={setRequestId} /></Field>
      <Field><FieldLabel htmlFor="drg-quantity">{t('预留数量', 'Quantity')}</FieldLabel><Input id="drg-quantity" type="number" min="1" max="1000" step="1" value={quantity} onChange={event => setQuantity(event.currentTarget.value)} /></Field>
      <Field><FieldLabel htmlFor="drg-reason">{t('预留或释放理由', 'Reason for reservation or release')}</FieldLabel><Input id="drg-reason" value={reason} maxLength={2000} onChange={event => setReason(event.currentTarget.value)} /></Field>
    </FieldGroup><Button variant="outline" disabled={write.blocked || !material || !list.data || !valid || !reason.trim()} onClick={() => { if (material && list.data) setReview({ operation: 'inpatient.drg.reservation.create', input: { admissionId: admission.id, encounterVersion: list.data.encounterVersion, materialId: material.id, catalogVersion: material.version, quantity: amount, ...(requestId ? { requestId } : {}), reason: reason.trim() } }) }}>{t('审阅新增预留', 'Review reservation')}</Button></FieldSet>
    {list.data?.reservations.map(item => <div key={item.id} className="flex flex-wrap items-center gap-2"><p>{item.materialDisplay} × {item.quantity} · {t('已用 ', 'Used ')}{item.consumedQuantity} · {t('余量 ', 'Remaining ')}{item.remainingQuantity ?? (item.status === 'reserved' ? item.quantity - item.consumedQuantity : 0)} · {t('余量预计 ', 'Remaining estimate ')}{formatFen(item.priceFen * (item.remainingQuantity ?? (item.status === 'reserved' ? item.quantity - item.consumedQuantity : 0)), locale)} · {{ reserved: t('预留中', 'Reserved'), replaced: t('已转实际使用', 'Replaced with actual use'), released: t('已释放', 'Released') }[item.status]}{item.releaseReason ? ` · ${item.releaseReason}` : ''}</p>{item.status === 'reserved' ? <Button variant="outline" disabled={write.blocked || !reason.trim()} onClick={() => { if (list.data) setReview({ operation: 'inpatient.drg.reservation.release', input: { admissionId: admission.id, encounterVersion: list.data.encounterVersion, reservationId: item.id, reason: reason.trim() } }) }}>{t('审阅释放预留', 'Review release')}</Button> : null}</div>)}
    {review ? <InpatientConfirmation locale={locale} title={t('确认耗材预留变更', 'Confirm reservation change')}
      description={t('核对耗材、数量与理由。预留变更不产生收费或手术执行。', 'Review material, quantity and reason. This does not create charges or performed procedures.')}
      confirmLabel={t('确认预留变更', 'Confirm reservation change')} pending={write.mutation.isPending} disabled={write.blocked}
      onCancel={() => setReview(undefined)} onConfirm={() => write.mutation.mutate(review, { onSuccess: () => setReview(undefined) })}>
      {review.operation === 'inpatient.drg.reservation.create' ? <p>{materials.find(item => item.id === review.input.materialId)?.display} × {review.input.quantity} · {review.input.reason}</p> : review.operation === 'inpatient.drg.reservation.release' ? <p>{list.data?.reservations.find(item => item.id === review.input.reservationId)?.materialDisplay} · {review.input.reason}</p> : null}
      <DrgError error={write.mutation.error} locale={locale} />
    </InpatientConfirmation> : null}
  </section>
}
