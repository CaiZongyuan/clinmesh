import { commandResponseSchema } from '@clinmesh/contracts/his'
import { inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { inpatientDrgPayerReviewCreateInputSchema, inpatientDrgPayerReviewListSchema } from '@clinmesh/contracts/inpatient-drg-payer'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@clinmesh/ui/components/alert-dialog'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@clinmesh/ui/components/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiGet, apiMutation, newIdempotencyKey } from './api-client.ts'
import { formatFen } from './workspace-format.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'

function ReviewKv({ label, tone = 'default', children }: { label: string; tone?: 'default' | 'crit' | 'good'; children: React.ReactNode }): React.JSX.Element {
  return <div className="flex min-w-0 flex-col gap-0.5">
    <span className="text-xs text-muted-foreground">{label}</span>
    <span className={`select-text break-all font-mono text-sm${tone === 'crit' ? ' text-destructive' : tone === 'good' ? ' text-success' : ''}`}>{children}</span>
  </div>
}

/**
 * 医保办 DRG 支付模拟核定：核定队列（已归档病案）＋执行核定＋历史核定回查。
 * 服务端仅 medical-insurance 可核，medical-records 也可回查；核定金额由服务端确定性产生，界面不提供任何手填金额。
 */
export function InpatientInsuranceReview({ session, locale }: { session: SessionContext; locale: WorkspaceLocale }): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const client = useQueryClient()
  const key = ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId]
  const insurer = session.actor.roleCode === 'medical-insurance'
  const admissions = useQuery({ queryKey: [...key, 'admissions'], queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/admissions', inpatientListSchema, signal) })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const archived = (admissions.data?.items ?? []).filter(item => item.recordStatus === 'archived')
  const selected = archived.find(item => item.id === selectedId) ?? archived[0]
  const reviews = useQuery({ queryKey: [...key, 'payer-reviews', selected?.id], enabled: selected !== undefined,
    queryFn: ({ signal }) => {
      const target = selected
      if (target === undefined) throw new Error('Review target unavailable')
      return apiGet(`/api/his/v1/inpatient/admissions/${encodeURIComponent(target.id)}/drg/payer-reviews`, inpatientDrgPayerReviewListSchema, signal)
    } })
  const [dialogOpen, setDialogOpen] = useState(false), [reason, setReason] = useState('')
  const execute = useMutation({
    mutationFn: (input: { admissionId: string; encounterVersion: string; reason: string }) => apiMutation(
      `/api/his/v1/inpatient/admissions/${encodeURIComponent(input.admissionId)}/drg/payer-review`,
      commandResponseSchema(inpatientDrgPayerReviewListSchema),
      { input: inpatientDrgPayerReviewCreateInputSchema.omit({ admissionId: true }).parse({ encounterVersion: input.encounterVersion, reason: input.reason.trim() }) },
      { idempotencyKey: newIdempotencyKey() }),
    onSuccess: () => {
      setDialogOpen(false)
      setReason('')
      void client.invalidateQueries({ queryKey: [...key, 'payer-reviews'] })
    },
  })
  return <section data-theme="paper" aria-label={t('医保办 DRG 支付模拟核定', 'Insurance DRG payer simulation review')} className="flex min-w-0 flex-col gap-4">
    <div className="flex flex-col gap-1">
      <h2 className="font-serif text-lg">{t('DRG 支付模拟核定', 'DRG payer simulation review')}</h2>
      <p className="text-sm text-muted-foreground">{t('对已归档病案执行模拟核定：以归档冻结分组 × 固定版本合成支付参数计算模拟核定支付额，由服务端确定性产生；差异不构成完整盈亏，独立于患者结算。', 'Run simulation reviews on archived admissions: the simulated payment derives deterministically from the frozen grouping and fixed-version synthetic payment parameters; differences are not a full profit-and-loss figure and stay independent of patient settlement.')}</p>
    </div>
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <Card size="sm" aria-label={t('核定队列', 'Review queue')} className="w-full shrink-0 lg:w-80">
        <CardHeader className="border-b">
          <CardTitle className="font-serif">{t('核定队列', 'Review queue')}</CardTitle>
          <CardDescription>{t('已归档病案', 'Archived admissions')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5">
          {admissions.isPending ? <Skeleton className="h-16 w-full" /> : null}
          {admissions.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(admissions.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
          {admissions.data !== undefined && archived.length === 0 ? <Empty className="min-h-32 border-dashed">
            <EmptyHeader>
              <EmptyTitle>{t('无已归档病例', 'No archived admissions')}</EmptyTitle>
              <EmptyDescription>{t('病案归档后进入核定队列。', 'Archived records enter the review queue.')}</EmptyDescription>
            </EmptyHeader>
          </Empty> : null}
          {archived.map(item => <button key={item.id} type="button" aria-current={item.id === selected?.id ? 'true' : undefined}
            onClick={() => setSelectedId(item.id)}
            className={`flex min-w-0 flex-col gap-1 rounded-md border border-border px-3 py-2 text-left${item.id === selected?.id ? ' bg-accent/60' : ' hover:bg-accent/30'}`}>
            <span className="flex items-center gap-2 text-sm font-medium">{item.patientName}
              <span className="ml-auto min-w-0 break-all font-mono text-xs text-muted-foreground">{item.inpatientNumber}</span>
            </span>
          </button>)}
        </CardContent>
      </Card>
      <Card size="sm" className="min-w-0 flex-1" aria-label={t('历史核定', 'Review history')}>
        <CardHeader className="border-b">
          <CardTitle className="font-serif">{selected ? `${t('病案', 'Record')} · ${selected.patientName}` : t('历史核定', 'Review history')}</CardTitle>
          {selected ? <CardDescription><span className="break-all font-mono">{selected.inpatientNumber}</span></CardDescription> : null}
          {insurer && selected ? <CardAction>
            <Button size="sm" onClick={() => { execute.reset(); setDialogOpen(true) }}>{t('执行模拟核定', 'Run simulation review')}</Button>
          </CardAction> : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {selected === undefined ? null : <>
            {reviews.isPending ? <Skeleton className="h-24 w-full" /> : null}
            {reviews.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(reviews.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
            {reviews.data !== undefined && reviews.data.reviews.length === 0 ? <p className="text-sm text-muted-foreground">{t('该病案暂无核定记录，待执行模拟核定。', 'No review record yet for this admission; run the simulation review.')}</p> : null}
            {reviews.data !== undefined && reviews.data.reviews.length > 0 ? <>
              <p className="text-xs text-muted-foreground">{reviews.data.reviews[0]!.note}</p>
              {reviews.data.reviews.map(review => <div key={review.id} className="flex min-w-0 flex-col gap-2 rounded-md border border-border px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="success">{t('已核定', 'Reviewed')}</Badge>
                  <span className="font-mono text-sm font-medium">{review.drgCode}</span>
                  <span className="ml-auto break-all font-mono text-xs text-muted-foreground">{review.reviewedAt}</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <ReviewKv label={t('模拟核定支付', 'Simulated payment')}>{formatFen(review.simulatedPaymentFen, locale)}</ReviewKv>
                  <ReviewKv label={t('医院收费净额（归档快照）', 'Hospital charges (archived snapshot)')}>{formatFen(review.hospitalChargesFen, locale)}</ReviewKv>
                  <ReviewKv label={t('差额（核定 − 收费）', 'Difference (payment − charges)')} tone={review.differenceFen < 0 ? 'crit' : review.differenceFen > 0 ? 'good' : 'default'}>{formatFen(review.differenceFen, locale)}</ReviewKv>
                  <ReviewKv label={t('支付参数', 'Payment parameters')}>{review.parameterSetId} · v{review.parameterVersion}</ReviewKv>
                  <ReviewKv label={t('冻结分组依据', 'Frozen grouping basis')}>{review.frozenRulesId} · v{review.frozenRulesVersion}</ReviewKv>
                  <ReviewKv label={t('归档修订与来源哈希', 'Archived revision and sources hash')}>{t('修订', 'Revision')} {review.recordRevision} · {review.archiveSourcesHash}</ReviewKv>
                  <ReviewKv label={t('复核号', 'Review id')}>{review.id}</ReviewKv>
                  <ReviewKv label={t('核定说明', 'Review note')}>{review.reason}</ReviewKv>
                </div>
              </div>)}
            </> : null}
          </>}
        </CardContent>
      </Card>
    </div>
    <AlertDialog open={dialogOpen} onOpenChange={open => { if (!execute.isPending) setDialogOpen(open) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('执行 DRG 支付模拟核定', 'Run DRG payer simulation review')}</AlertDialogTitle>
          <AlertDialogDescription>{t('以归档冻结分组 × 固定版本合成支付参数模拟核定，金额由服务端确定性产生，不能手填。', 'The simulated payment derives deterministically from the frozen grouping and fixed synthetic parameters; amounts cannot be entered by hand.')}</AlertDialogDescription>
        </AlertDialogHeader>
        {selected ? <p className="text-sm">{selected.patientName} · <span className="break-all font-mono">{selected.inpatientNumber}</span></p> : null}
        <Field>
          <FieldLabel htmlFor="insurance-review-reason">{t('核定说明', 'Review note')}</FieldLabel>
          <Input id="insurance-review-reason" value={reason} maxLength={2000} onChange={event => setReason(event.currentTarget.value)} />
        </Field>
        {execute.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(execute.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={execute.isPending}>{t('取消', 'Cancel')}</AlertDialogCancel>
          <Button disabled={execute.isPending || reason.trim().length === 0} onClick={() => { if (selected) execute.mutate({ admissionId: selected.id, encounterVersion: selected.versionId, reason }) }}>{t('确认执行核定', 'Confirm simulation review')}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>
}
