import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientDrgPregroupResultSchema } from '@clinmesh/contracts/inpatient-drg'
import { inpatientDrgPayerReviewListSchema, inpatientDrgPayerReviewPreviewSchema, type InpatientDrgPayerReviewPreview, type inpatientDrgPayerReviewCreateInputSchema, type inpatientDrgPayerCaseSummarySchema } from '@clinmesh/contracts/inpatient-drg-payer'
import type { z } from 'zod'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { apiGet } from './api-client.ts'
import { DrgError, DrgGrouping } from './inpatient-drg.tsx'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { formatFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { WorkspaceActionBar } from './workspace-card-layout.tsx'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import { Skeleton } from '@clinmesh/ui/components/skeleton'

export function InpatientDrgPayer({ admission, session, locale, write }: {
  admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>
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
  const [review, setReview] = useState<{ input: z.infer<typeof inpatientDrgPayerReviewCreateInputSchema>; preview: InpatientDrgPayerReviewPreview }>()
  const frozen = grouping.data?.frozen === true ? grouping.data : undefined
  const displayedPreview = review?.preview ?? preview.data
  return <section aria-label={t('医保办 DRG 复核', 'DRG payer review')} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
    <h2 className="font-semibold">{admission.patientName} · {t('医保办 DRG 复核', 'DRG payer review')}</h2>
    <Button variant="outline" disabled={!archived || preview.isFetching || grouping.isFetching || write.blocked || review !== undefined} onClick={() => { void preview.refetch(); void grouping.refetch(); void reviews.refetch() }}>{t('刷新复核依据', 'Refresh review basis')}</Button>
    <p className="text-sm text-muted-foreground">{t('医院侧模拟核定独立于患者医保待遇和收退款。差异供复核，不自动产生患者退款。', 'Hospital assessment is separate from patient benefits and cash transactions. A difference does not automatically create a patient refund.')}</p>
    {!archived ? <Alert><AlertDescription>{t('病案尚未归档，归档后才能读取固定分组并模拟核定。', 'Archive the medical record before reviewing fixed grouping and simulating assessment.')}</AlertDescription></Alert> : null}
    {grouping.isPending || reviews.isPending || preview.isPending ? <Skeleton className="h-24 w-full" /> : null}
    <DrgError error={grouping.error ?? reviews.error ?? preview.error} locale={locale} />
    {frozen ? <><DrgGrouping result={frozen.result} locale={locale} title={t('归档分组', 'Fixed archive grouping')} /><p className="text-sm text-muted-foreground">{t('归档首页修订 ', 'Archived record revision ')}{frozen.recordRevision} · {t('规则修订 ', 'Rules revision ')}{frozen.rulesVersion}</p></> : null}
    {insurer ? <FieldGroup><Field><FieldLabel htmlFor="drg-payer-reason">{t('核定说明', 'Assessment note')}</FieldLabel><Input id="drg-payer-reason" maxLength={2000} disabled={review !== undefined} value={reason} onChange={event => setReason(event.currentTarget.value)} /></Field></FieldGroup> : null}
    {displayedPreview ? <><PaymentPreview preview={displayedPreview} locale={locale} /><FrozenCaseSummary summary={displayedPreview.caseSummary} locale={locale} /></> : null}
    <h3 className="font-medium">{t('历次模拟核定与差异', 'Assessment history and differences')}</h3>
    {reviews.data?.reviews.length === 0 ? <p>{t('尚无模拟核定记录。', 'No assessments yet.')}</p> : null}
    <Table><TableHeader><TableRow><TableHead>{t('病组与时间', 'Group and time')}</TableHead><TableHead>{t('归档费用', 'Archived charges')}</TableHead><TableHead>{t('归档支付预估', 'Archived payment estimate')}</TableHead><TableHead>{t('模拟核定', 'Assessment')}</TableHead><TableHead>{t('核定减归档预估', 'Assessment less archived estimate')}</TableHead><TableHead>{t('核定与归档费用差额', 'Assessment less charges')}</TableHead></TableRow></TableHeader><TableBody>{reviews.data?.reviews.map(item => <TableRow key={item.id}><TableCell>{item.drgCode}<p>{new Date(item.reviewedAt).toLocaleString(locale, { timeZone: 'Asia/Shanghai' })}</p><p>{item.reason}</p><p className="text-xs text-muted-foreground">{t('核定参数修订 ', 'Assessment parameter revision ')}{item.parameterVersion}</p><details><summary>{t('查看核定来源', 'Assessment sources')}</summary><p>{t('复核号 ', 'Review ID ')}{item.id}</p><p>{t('支付参数 ', 'Payment parameters ')}{item.parameterSetId} · {item.parameterVersion}</p><p>{t('归档分组依据 ', 'Archived grouping basis ')}{item.frozenRulesId} · {item.frozenRulesVersion}</p><p>{t('归档首页及来源 ', 'Archived record and sources ')}{item.recordRevision} · {item.archiveSourcesHash}</p></details></TableCell><TableCell>{formatFen(item.hospitalChargesFen, locale)}</TableCell><TableCell>{item.paymentEstimate ? <>{formatFen(item.paymentEstimate.referenceFen, locale)}<p className="text-xs text-muted-foreground">{item.paymentEstimate.parameterVersion}</p></> : t('缺少归档预估', 'Archived estimate missing')}</TableCell><TableCell>{formatFen(item.simulatedPaymentFen, locale)}</TableCell><TableCell>{item.estimateDifferenceFen === null ? t('无法计算', 'Unavailable') : formatFen(item.estimateDifferenceFen, locale)}</TableCell><TableCell>{formatFen(item.differenceFen, locale)}</TableCell></TableRow>)}</TableBody></Table>
    {reviews.data?.reviews.at(-1) ? <p className="text-sm text-muted-foreground">{reviews.data.reviews.at(-1)!.note}</p> : null}
    <DrgError error={write.mutation.error} locale={locale} />
    {insurer ? <InpatientPrimaryAction stage="record"><WorkspaceActionBar tone={review ? 'confirm' : !reason.trim() || !preview.data ? 'blocked' : 'normal'}
      summary={review ? formatFen(review.preview.simulatedPaymentFen, locale) : admission.patientName}
      reason={review ? t('核对病组、核定金额及说明后提交；不会自动收退款。', 'Check the group, assessment amount and note before submitting. This does not collect or refund patient funds.') : !reason.trim() ? t('还差：填写核定说明。', 'Enter the assessment note.') : t('先审阅归档病组与模拟核定预览。', 'Review the archived grouping and assessment preview.')}
      action={review ? <><Button variant="outline" disabled={write.mutation.isPending} onClick={() => setReview(undefined)}>{t('返回', 'Back')}</Button><Button disabled={write.blocked} onClick={() => write.mutation.mutate({ operation: 'inpatient.drg.payer.review', input: review.input }, { onSuccess: () => { setReview(undefined); setReason('') } })}>{t('提交模拟核定', 'Submit assessment')}</Button></>
        : <Button disabled={write.blocked || !frozen || grouping.isFetching || preview.isFetching || !preview.data || !!preview.error || frozen.result.status !== 'grouped' || !reason.trim()} onClick={() => { if (preview.data) setReview({ preview: preview.data, input: { admissionId: admission.id, encounterVersion: preview.data.encounterVersion, expectedFingerprint: preview.data.fingerprint, reason: reason.trim() } }) }}>{t('审阅模拟核定', 'Review assessment')}</Button>} />
    </InpatientPrimaryAction> : null}
  </section>
}

function PaymentPreview({ preview, locale }: { preview: InpatientDrgPayerReviewPreview; locale: WorkspaceLocale }): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  return <div className="flex flex-col gap-1 rounded-md border p-3" data-testid="drg-payer-preview">
    <p>{t('归档病组 ', 'Archived group ')}{preview.drgCode}</p>
    <p>{t('归档费用 ', 'Archived charges ')}{formatFen(preview.hospitalChargesFen, locale)}</p>
    {preview.paymentEstimate ? <><p>{t('归档支付预估 ', 'Archived payment estimate ')}{formatFen(preview.paymentEstimate.referenceFen, locale)}</p><p className="text-sm text-muted-foreground">{t('预估参数修订 ', 'Estimate parameter revision ')}{preview.paymentEstimate.parameterVersion}</p></> : <p>{t('缺少归档支付预估，无法核对核定与预估差额。', 'The archived payment estimate is missing; comparison with assessment is unavailable.')}</p>}
    <p>{t('模拟核定支付 ', 'Simulated assessment payment ')}{formatFen(preview.simulatedPaymentFen, locale)}</p>
    <p>{t('核定减归档预估 ', 'Assessment less archived estimate ')}{preview.estimateDifferenceFen === null ? t('无法计算', 'Unavailable') : formatFen(preview.estimateDifferenceFen, locale)}</p>
    <p>{t('核定与归档费用差额 ', 'Payment less archived charges ')}{formatFen(preview.differenceFen, locale)}</p>
    <p className="text-sm text-muted-foreground">{t('合成参数修订 ', 'Synthetic parameter revision ')}{preview.parameterVersion} · {preview.note}</p>
  </div>
}

function FrozenCaseSummary({ summary, locale }: { summary: z.infer<typeof inpatientDrgPayerCaseSummarySchema>; locale: WorkspaceLocale }): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const input = summary.groupingInput
  const gender = { female: t('女', 'Female'), male: t('男', 'Male'), unknown: t('性别未知', 'Gender unknown') }[input.gender]
  return <section aria-label={t('固定病例与编码来源', 'Fixed case and coding sources')} className="flex min-w-0 flex-col gap-2 rounded-md border p-3 text-sm">
    <h4 className="font-medium">{t('固定病例与编码来源', 'Fixed case and coding sources')}</h4>
    <p>{t('首页修订 ', 'Record revision ')}{summary.recordRevision} · {gender} · {input.ageYears}{t('岁', ' years')} · {t('住院 ', 'Stay ')}{input.inpatientDays}{t('天', ' days')} · {t('离院方式编码 ', 'Discharge mode code ')}{input.dischargeMode}</p>
    {input.ageDays !== null || input.birthWeightGrams !== null ? <p>{t('出生天数 ', 'Age in days ')}{input.ageDays ?? '—'} · {t('出生体重（克）', 'Birth weight (grams) ')}{input.birthWeightGrams ?? '—'}</p> : null}
    {summary.diagnoses.map(item => <p key={item.conditionId}>{item.role === 'primary' ? t('主诊断 ', 'Primary diagnosis ') : t('次诊断 ', 'Secondary diagnosis ')}{item.coding.code} · {item.coding.display} · {t('入院病情 ', 'Admission condition ')}{item.admissionCondition}</p>)}
    {summary.operations.length === 0 ? <p>{t('本次归档无已实施操作。', 'No performed procedure in this archive.')}</p> : summary.operations.map(item => <p key={item.executionId}>{item.primary ? t('主操作 ', 'Primary procedure ') : t('其他操作 ', 'Other procedure ')}{item.coding.code} · {item.coding.display}</p>)}
    <details><summary>{t('查看固定分组输入与来源', 'Fixed grouping input and sources')}</summary><div className="flex flex-col gap-2 pt-2">
      <p className="break-all">{t('规则 ', 'Rules ')}{summary.rulesId} · {summary.rulesVersion}</p>
      <p className="break-all">{summary.inputCoding} · {summary.codingNote}</p>
      <p>{t('分组用诊断编码 ', 'Grouping diagnosis codes ')}{input.diagnoses.map(item => `${item.role === 'main' ? t('主诊断 ', 'Primary ') : ''}${item.code}`).join('、') || '—'}</p>
      <p>{t('分组用操作编码 ', 'Grouping procedure codes ')}{input.operations.map(item => `${item.primary ? t('主操作 ', 'Primary ') : ''}${item.code}`).join('、') || '—'}</p>
      {summary.diagnoses.map(item => <div key={item.conditionId} className="break-all"><p>{item.coding.code} · {item.coding.system} · {t('修订 ', 'Revision ')}{item.coding.version}</p><p>{item.coding.releaseId ?? t('来源发布未登记', 'Source release unavailable')} · {item.coding.sourceLocator}</p></div>)}
      {summary.operations.map(item => <div key={item.executionId} className="break-all"><p>{item.coding.code} · {item.coding.system} · {t('修订 ', 'Revision ')}{item.coding.version} · {t('操作修订 ', 'Procedure revision ')}{item.procedureVersion}</p><p>{item.coding.releaseId} · {item.coding.sourceLocator}</p><a href={item.coding.sourceUrl} target="_blank" rel="noreferrer" className="underline">{t('查看操作分类来源', 'Procedure classification source')}</a></div>)}
    </div></details>
  </section>
}
