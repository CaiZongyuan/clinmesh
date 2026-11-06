import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientDrgPregroupResultSchema } from '@clinmesh/contracts/inpatient-drg'
import { inpatientDrgPayerReviewListSchema, inpatientDrgPayerReviewPreviewSchema, type InpatientDrgPayerReviewPreview, type inpatientDrgPayerCaseSummarySchema } from '@clinmesh/contracts/inpatient-drg-payer'
import type { z } from 'zod'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { useQuery } from '@tanstack/react-query'
import { useLayoutEffect, useRef, useState } from 'react'
import { inpatientAdmissionConditionLabel, inpatientDepartureLabel } from './inpatient-labels.ts'
import { apiGet } from './api-client.ts'
import { DrgError } from './inpatient-drg.tsx'
import { DrgGroupingEvidence, DrgSummaryFacts, drgGroupingStatusLabel } from './inpatient-drg-summary.tsx'
import { RefreshCwIcon } from 'lucide-react'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { formatFen, formatShanghaiMinute } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { WorkspaceActionBar, announceHandoff } from './workspace-card-layout.tsx'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { Skeleton } from '@clinmesh/ui/components/skeleton'

export function InpatientDrgPayer({ admission, session, locale, write, onNext }: {
  admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>; onNext?: () => void
}): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const scope = ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id]
  const archived = admission.recordStatus === 'archived'
  const insurer = session.actor.roleCode === 'medical-insurance'
  const path = `/api/his/v1/inpatient/admissions/${admission.id}/drg`
  const grouping = useQuery({ queryKey: [...scope, 'drg-pregroup'], enabled: archived, retry: false,
    queryFn: ({ signal }) => apiGet(`${path}/pregroup`, inpatientDrgPregroupResultSchema, signal) })
  const reviews = useQuery({ queryKey: [...scope, 'drg-payer-reviews'], retry: false,
    queryFn: ({ signal }) => apiGet(`${path}/payer-reviews`, inpatientDrgPayerReviewListSchema, signal) })
  const preview = useQuery({ queryKey: [...scope, 'drg-payer-preview'], enabled: archived && insurer, retry: false,
    queryFn: ({ signal }) => apiGet(`${path}/payer-review-preview`, inpatientDrgPayerReviewPreviewSchema, signal) })
  const [reason, setReason] = useState('')
  const [review, setReview] = useState<{ preview: InpatientDrgPayerReviewPreview }>()
  const [reassessing, setReassessing] = useState(false)
  const reviewTrigger = useRef<HTMLButtonElement>(null)
  const reviewConfirm = useRef<HTMLButtonElement>(null)
  const wasReviewing = useRef(false)
  const reviewing = review !== undefined
  useLayoutEffect(() => {
    if (reviewing && !write.blocked) reviewConfirm.current?.focus()
    else if (!reviewing && wasReviewing.current) reviewTrigger.current?.focus({ preventScroll: true })
    wasReviewing.current = reviewing
  }, [reviewing, write.blocked])
  const frozen = grouping.error === null && grouping.data?.frozen === true ? grouping.data : undefined
  const displayedPreview = review?.preview ?? (preview.error === null ? preview.data : undefined)
  const hasReviews = reviews.error === null && (reviews.data?.reviews.length ?? 0) > 0
  const completedHere = write.mutation.isSuccess && write.mutation.data?.command.operation === 'inpatient.drg.payer.review'
    && write.mutation.data.command.input.admissionId === admission.id
  const canStartReview = !write.blocked && !!frozen && !grouping.isFetching && !preview.isFetching && !!preview.data && !preview.error && frozen.result.status === 'grouped'
  const presets = [
    t('按归档病组核定，无扣减', 'Approved as archived group without deduction'),
    t('超支部分属合理冠脉介入耗材，按标准核定', 'Overrun due to reasonable PCI consumables; approved per standard'),
    t('编码与病案首页一致，复核通过', 'Coding matches medical record front page; review passed'),
  ]
  return <section aria-label={t('医保办 DRG 复核', 'DRG payer review')} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
    {!archived ? <Alert><AlertDescription>{t('病案尚未归档，归档后才能读取固定分组并模拟核定。', 'Archive the medical record before reviewing fixed grouping and simulating assessment.')}</AlertDescription></Alert> : null}
    {(completedHere || (hasReviews && !reassessing)) && !review ? <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-800 dark:text-emerald-300">
      <span>✓ {t('已完成模拟核定，记录已进入历次模拟核定与差异', 'Simulated assessment completed and recorded in history')}</span>
      {insurer && (hasReviews || completedHere) && !reassessing ? <Button type="button" variant="outline" size="xs" onClick={() => setReassessing(true)}>{t('重新发起模拟核定', 'Start a new assessment')}</Button> : null}
    </div> : null}
    {grouping.isPending || reviews.isPending || preview.isPending ? <Skeleton className="h-24 w-full" /> : null}
    <DrgError error={grouping.error ?? reviews.error ?? preview.error} locale={locale} />
    <section aria-label={t('归档时的分组与费用', 'Archived grouping and charges')} className="clinmesh-inpatient-summary">
      <div className="clinmesh-inpatient-section-heading"><h3>{t('归档时的分组与费用', 'Archived grouping and charges')}</h3>
        <Button variant="ghost" size="sm" disabled={!archived || preview.isFetching || grouping.isFetching || reviews.isFetching || write.blocked || review !== undefined} onClick={() => { void preview.refetch(); void grouping.refetch(); void reviews.refetch() }}><RefreshCwIcon aria-hidden="true" />{t('刷新复核依据', 'Refresh review basis')}</Button>
      </div>
      {frozen ? <section aria-label={t('归档分组', 'Fixed archive grouping')} className="flex min-w-0 flex-col gap-2">
        <DrgSummaryFacts facts={[
          { label: t('归档分组', 'Archived grouping'), value: drgGroupingStatusLabel(frozen.result.status, locale) },
          { label: t('归档病组', 'Archived group'), value: frozen.result.drgCode ?? '—' },
          { label: t('归档费用', 'Archived charges'), value: displayedPreview ? formatFen(displayedPreview.hospitalChargesFen, locale) : '—' },
          { label: t('归档支付预估', 'Archived payment estimate'), value: frozen.paymentEstimate ? formatFen(frozen.paymentEstimate.referenceFen, locale) : '—' },
        ]} />
        <DrgGroupingEvidence result={frozen.result} locale={locale} />
        <details className="clinmesh-inpatient-disclosure"><summary>{t('查看归档分组来源', 'View archived grouping sources')}</summary><div className="flex flex-col gap-1 pt-2 text-sm"><p>{t('归档首页修订 ', 'Archived record revision ')}{frozen.recordRevision}</p><p>{t('规则修订 ', 'Rules revision ')}{frozen.rulesVersion}</p>{!frozen.paymentEstimate ? <p>{t('缺少归档支付预估，无法核对核定与预估差额。', 'The archived payment estimate is missing; comparison with assessment is unavailable.')}</p> : null}</div></details>
      </section> : null}
    </section>
    {displayedPreview ? <details className="clinmesh-inpatient-disclosure"><summary>{t('查看归档病例与编码', 'View archived case and coding')}</summary><FrozenCaseSummary summary={displayedPreview.caseSummary} locale={locale} /></details> : null}
    <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold">{t('模拟核定', 'Simulated assessment')}</h3>
        <span className="text-xs text-muted-foreground">{t('医院侧模拟核定独立于患者医保待遇和收退款。', 'Hospital assessment is separate from patient benefits and cash transactions.')}</span>
      </div>
      {displayedPreview ? <PaymentPreview preview={displayedPreview} locale={locale} /> : null}
      {insurer && ((!hasReviews && !completedHere) || reassessing || review !== undefined) ? <FieldGroup className="pt-1">
        <Field>
          <FieldLabel htmlFor="drg-payer-reason">{t('核定说明', 'Assessment note')}</FieldLabel>
          <div className="flex flex-wrap gap-1.5 pb-1">
            {presets.map(preset => <Button key={preset} type="button" variant="outline" size="sm" className="h-auto py-1 text-xs" disabled={write.blocked} onClick={() => setReason(preset)}>{preset}</Button>)}
          </div>
          <Input id="drg-payer-reason" maxLength={2000} placeholder={t('填写核定意见或点击上方常用说明', 'Enter assessment note or select a preset above')} disabled={write.blocked} value={reason} onChange={event => setReason(event.currentTarget.value)} />
        </Field>
      </FieldGroup> : null}
    </div>
    <h3 className="text-xs font-semibold">{t('历次模拟核定与差异', 'Assessment history and differences')}</h3>
    {reviews.error === null && reviews.data?.reviews.length === 0 ? <p className="text-xs text-muted-foreground">{t('尚无模拟核定记录。', 'No assessments yet.')}</p> : null}
    {reviews.error === null && (reviews.data?.reviews.length ?? 0) > 0 ? <Table><TableHeader><TableRow><TableHead>{t('病组与时间', 'Group and time')}</TableHead><TableHead className="text-right">{t('归档费用', 'Archived charges')}</TableHead><TableHead className="text-right">{t('归档支付预估', 'Archived payment estimate')}</TableHead><TableHead className="text-right">{t('模拟核定', 'Assessment')}</TableHead><TableHead className="text-right">{t('核定减归档预估', 'Assessment less archived estimate')}</TableHead><TableHead className="text-right">{t('核定与归档费用差额', 'Assessment less charges')}</TableHead></TableRow></TableHeader><TableBody>{reviews.data?.reviews.map(item => <TableRow key={item.id}><TableCell><strong>{item.drgCode}</strong><p className="text-xs text-muted-foreground tabular-nums">{formatShanghaiMinute(item.reviewedAt).slice(5)}</p><p>{item.reason}</p><details><summary className="cursor-pointer text-xs text-muted-foreground">{t('查看核定来源', 'Assessment sources')}</summary><p>{t('核定时间 ', 'Assessed at ')}{formatShanghaiMinute(item.reviewedAt).slice(5)}</p><p>{t('支付参数修订 ', 'Payment parameter revision ')}{item.parameterVersion}</p><p>{t('归档分组规则修订 ', 'Archived grouping rules revision ')}{item.frozenRulesVersion}</p><p>{t('归档首页修订 ', 'Archived record revision ')}{item.recordRevision}</p>{item.paymentEstimate ? <p>{t('预估参数修订 ', 'Estimate parameter revision ')}{item.paymentEstimate.parameterVersion}</p> : null}</details></TableCell><TableCell className="text-right tabular-nums">{formatFen(item.hospitalChargesFen, locale)}</TableCell><TableCell className="text-right tabular-nums">{item.paymentEstimate ? formatFen(item.paymentEstimate.referenceFen, locale) : t('缺少归档预估', 'Archived estimate missing')}</TableCell><TableCell className="text-right font-semibold tabular-nums">{formatFen(item.simulatedPaymentFen, locale)}</TableCell><TableCell className="text-right tabular-nums">{item.estimateDifferenceFen === null ? t('无法计算', 'Unavailable') : formatFen(item.estimateDifferenceFen, locale)}</TableCell><TableCell className="text-right tabular-nums">{formatFen(item.differenceFen, locale)}</TableCell></TableRow>)}</TableBody></Table> : null}
    {reviews.error === null && reviews.data?.reviews.at(-1) ? <details className="clinmesh-inpatient-disclosure"><summary>{t('查看最近核定说明', 'View the latest assessment note')}</summary><p className="text-sm text-muted-foreground">{reviews.data.reviews.at(-1)!.note}</p></details> : null}
    <DrgError error={write.mutation.error} locale={locale} />
    {insurer ? <InpatientPrimaryAction stage="record">{completedHere && !review ? <WorkspaceActionBar tone="complete"
      summary={t('已完成模拟核定', 'Simulated assessment completed')}
      reason={t('记录已进入历次模拟核定与差异。', 'The record is now in the assessment history.')}
      action={onNext ? <Button onClick={onNext}>{t('下一份', 'Next record')}</Button> : undefined} />
      : <WorkspaceActionBar tone={review ? (reason.trim() ? 'confirm' : 'blocked') : !canStartReview ? 'blocked' : 'normal'}
        summary={review ? formatFen(review.preview.simulatedPaymentFen, locale) : admission.patientName}
        reason={review ? (reason.trim() ? t('核对病组、核定金额及说明后提交；不会自动收退款。', 'Check the group, assessment amount and note before submitting. This does not collect or refund patient funds.') : t('还差：填写核定说明。', 'Enter the assessment note.')) : t('先审阅归档病组与模拟核定预览。', 'Review the archived grouping and assessment preview.')}
        action={review ? <div className="flex flex-wrap gap-2" onKeyDown={event => {
          if (event.key === 'Escape' && !write.mutation.isPending) { event.preventDefault(); setReview(undefined) }
        }}><Button variant="outline" disabled={write.mutation.isPending} onClick={() => setReview(undefined)}>{t('返回', 'Back')}</Button><Button ref={reviewConfirm} disabled={write.blocked || !reason.trim()} onClick={() => write.mutation.mutate({ operation: 'inpatient.drg.payer.review', input: { admissionId: admission.id, encounterVersion: review.preview.encounterVersion, expectedFingerprint: review.preview.fingerprint, reason: reason.trim() } }, { onSuccess: () => { setReview(undefined); setReassessing(false); setReason(''); announceHandoff(`${t('已提交模拟核定', 'Assessment submitted')} · ${admission.patientName}`, t('记录已进入历史核定', 'The record is now in the assessment history')) } })}>{t('提交模拟核定', 'Submit assessment')}</Button></div>
          : <Button ref={reviewTrigger} disabled={!canStartReview} onClick={() => { if (preview.data) setReview({ preview: preview.data }) }}>{t('审阅模拟核定', 'Review assessment')}</Button>} />}</InpatientPrimaryAction> : null}
  </section>
}

function PaymentPreview({ preview, locale }: { preview: InpatientDrgPayerReviewPreview; locale: WorkspaceLocale }): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  return <div className="@container/payer-simulation flex min-w-0 flex-col gap-3" data-testid="drg-payer-preview">
    <dl className="grid grid-cols-2 gap-x-5 gap-y-3 @min-[42rem]/payer-simulation:grid-cols-3">
      <div className="min-w-0"><dt className="text-xs text-muted-foreground">{t('模拟核定支付', 'Simulated assessment payment')}</dt>{' '}<dd className="mt-1 text-sm font-semibold tabular-nums">{formatFen(preview.simulatedPaymentFen, locale)}</dd></div>
      <div className="min-w-0"><dt className="text-xs text-muted-foreground">{t('核定与归档费用差额', 'Payment less archived charges')}</dt>{' '}<dd className="mt-1 text-sm font-semibold tabular-nums">{formatFen(preview.differenceFen, locale)}</dd></div>
      <div className="min-w-0"><dt className="text-xs text-muted-foreground">{t('核定减归档预估', 'Assessment less archived estimate')}</dt>{' '}<dd className="mt-1 text-sm font-semibold tabular-nums">{preview.estimateDifferenceFen === null ? t('无法计算', 'Unavailable') : formatFen(preview.estimateDifferenceFen, locale)}</dd></div>
    </dl>
    <p className="text-sm text-muted-foreground">{t('模拟核定仅供复核；差额不会自动产生收款或退款。', 'This simulated assessment is for review. Differences do not automatically collect or refund funds.')}</p><details className="clinmesh-inpatient-disclosure"><summary>{t('查看核定参数来源', 'View assessment parameter sources')}</summary><div className="flex flex-col gap-1 pt-2 text-sm"><p>{preview.note}</p><p>{t('核定参数修订 ', 'Assessment parameter revision ')}{preview.parameterVersion}</p>{preview.paymentEstimate ? <p>{t('预估参数修订 ', 'Estimate parameter revision ')}{preview.paymentEstimate.parameterVersion}</p> : null}</div></details>
  </div>
}

function FrozenCaseSummary({ summary, locale }: { summary: z.infer<typeof inpatientDrgPayerCaseSummarySchema>; locale: WorkspaceLocale }): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const input = summary.groupingInput
  const gender = { female: t('女', 'Female'), male: t('男', 'Male'), unknown: t('性别未知', 'Gender unknown') }[input.gender]
  return <section aria-label={t('固定病例与编码来源', 'Fixed case and coding sources')} className="flex min-w-0 flex-col gap-2 rounded-md border p-3 text-sm">
    <h4 className="font-medium">{t('固定病例与编码来源', 'Fixed case and coding sources')}</h4>
    <p>{t('首页修订 ', 'Record revision ')}{summary.recordRevision} · {gender} · {input.ageYears}{t('岁', ' years')} · {t('住院 ', 'Stay ')}{input.inpatientDays}{t('天', ' days')} · {t('离院方式 ', 'Departure method ')}{inpatientDepartureLabel(input.dischargeMode, locale)}</p>
    {input.ageDays !== null || input.birthWeightGrams !== null ? <p>{t('出生天数 ', 'Age in days ')}{input.ageDays ?? '—'} · {t('出生体重（克）', 'Birth weight (grams) ')}{input.birthWeightGrams ?? '—'}</p> : null}
    {summary.diagnoses.map(item => <p key={item.conditionId}>{item.role === 'primary' ? t('主诊断 ', 'Primary diagnosis ') : t('次诊断 ', 'Secondary diagnosis ')}{item.coding.code} · {item.coding.display} · {t('入院病情 ', 'Admission condition ')}{inpatientAdmissionConditionLabel(item.admissionCondition, locale)}</p>)}
    {summary.operations.length === 0 ? <p>{t('本次归档无已实施操作。', 'No performed procedure in this archive.')}</p> : summary.operations.map(item => <p key={item.executionId}>{item.primary ? t('主操作 ', 'Primary procedure ') : t('其他操作 ', 'Other procedure ')}{item.coding.code} · {item.coding.display}</p>)}
    <details><summary>{t('查看固定分组输入与来源', 'Fixed grouping input and sources')}</summary><div className="flex flex-col gap-2 pt-2">
      <p className="break-all">{t('规则修订 ', 'Rules revision ')}{summary.rulesVersion}</p>
      <p className="break-all">{summary.inputCoding} · {summary.codingNote}</p>
      <p>{t('分组用诊断编码 ', 'Grouping diagnosis codes ')}{input.diagnoses.map(item => `${item.role === 'main' ? t('主诊断 ', 'Primary ') : ''}${item.code}`).join('、') || '—'}</p>
      <p>{t('分组用操作编码 ', 'Grouping procedure codes ')}{input.operations.map(item => `${item.primary ? t('主操作 ', 'Primary ') : ''}${item.code}`).join('、') || '—'}</p>
      {summary.diagnoses.map(item => <div key={item.conditionId} className="break-all"><p>{item.coding.code} · {item.coding.system} · {t('修订 ', 'Revision ')}{item.coding.version}</p><p>{item.coding.releaseId ?? t('来源发布未登记', 'Source release unavailable')} · {item.coding.sourceLocator}</p></div>)}
      {summary.operations.map(item => <div key={item.executionId} className="break-all"><p>{item.coding.code} · {item.coding.system} · {t('修订 ', 'Revision ')}{item.coding.version} · {t('操作修订 ', 'Procedure revision ')}{item.procedureVersion}</p><p>{item.coding.releaseId} · {item.coding.sourceLocator}</p><a href={item.coding.sourceUrl} target="_blank" rel="noreferrer" className="underline">{t('查看操作分类来源', 'Procedure classification source')}</a></div>)}
    </div></details>
  </section>
}
