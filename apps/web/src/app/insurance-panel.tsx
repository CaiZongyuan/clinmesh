import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  insurancePlans,
  type InsuranceCoverage,
  type insurancePreviewResponseSchema,
  type InsuranceTarget,
} from '@clinmesh/contracts/insurance'
import { insuranceTier } from '@clinmesh/core/insurance'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { z } from 'zod'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@clinmesh/ui/components/alert-dialog'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { getInsuranceState, newIdempotencyKey, previewInsurance } from './api-client.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { formatFen } from './workspace-format.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'

export function coverageTierLabel(
  coverage: Pick<InsuranceCoverage, 'included' | 'priorSelfPayBps'>,
  zh: boolean,
  items?: ReadonlyArray<{ coverage: Pick<InsuranceCoverage, 'included' | 'priorSelfPayBps'> }>,
): string {
  const one = (c: Pick<InsuranceCoverage, 'included' | 'priorSelfPayBps'>) => {
    const t = insuranceTier(c)
    return t === 'C' ? (zh ? '丙类' : 'Class C')
      : t === 'A' ? (zh ? '甲类' : 'Class A')
        : `${zh ? '乙类' : 'Class B'} ${c.priorSelfPayBps / 100}%`
  }
  if (items && items.length > 0) {
    const first = one(items[0]!.coverage)
    return items.every(i => one(i.coverage) === first) ? first : (zh ? '混合' : 'Mixed')
  }
  return one(coverage)
}

export function formatTierMeta(
  item: { outsideFen: number; priorSelfPayFen: number },
  locale: WorkspaceLocale,
): string {
  const zh = locale === 'zh-CN'
  return `${item.outsideFen > 0 ? ` · ${zh ? '目录外' : 'Outside'} ${formatFen(item.outsideFen, locale)}` : ''}${item.priorSelfPayFen > 0 ? ` · ${zh ? '先行' : 'Prior'} ${formatFen(item.priorSelfPayFen, locale)}` : ''}`
}

/** Key by session and target at the owning workspace so previews cannot cross patients. */
export function InsurancePanel({
  target,
  session,
  locale,
  onChanged,
  disabled = false,
}: {
  target: InsuranceTarget
  session: SessionContext
  locale: WorkspaceLocale
  onChanged: () => unknown | Promise<unknown>
  disabled?: boolean
}) {
  const zh = locale === 'zh-CN'
  const t = (c: string, e: string) => zh ? c : e
  const f = (n: number) => formatFen(n, locale)
  const client = useQueryClient()
  const [opened, setOpened] = useState(false)
  const queryKey = [
    'insurance',
    session.user.id,
    session.actor.workspaceId,
    session.actor.epoch,
    session.actor.practitionerRoleId,
    target.kind,
    target.id,
  ] as const
  const state = useQuery({
    queryKey,
    queryFn: ({ signal }) => getInsuranceState(target, signal),
    enabled: opened,
  })
  const [selectedPlan, setSelectedPlan] = useState<'employee-v1' | 'resident-v1'>('employee-v1')
  const [review, setReview] = useState<'confirm' | 'cancel' | null>(null)
  const [cancellation, setCancellation] = useState<{
    settlementId: string
    expectedBalanceVersion: number
  } | null>(null)
  const preview = useMutation({
    mutationFn: () =>
      previewInsurance(target, state.data?.balance.planCode ?? selectedPlan, newIdempotencyKey()),
  })
  const write = useInpatientWriteIntent(session, async (command) => {
    if (!matchesTarget(command.input, target)) return
    setReview(null)
    preview.reset()
    await Promise.all([client.invalidateQueries({ queryKey }), onChanged()])
  })
  const data = state.data
  const busy = disabled || preview.isPending || write.blocked
  const candidate = preview.data?.data.settlement
  const plan = data?.balance.planCode ?? selectedPlan
  const parameters = insurancePlans[plan][target.kind]
  const error = preview.error ?? write.mutation.error ?? write.storageFailure
  const ownPending = write.pending !== null && matchesTarget(write.pending.command.input, target)
  const reviewSettlement = review === 'confirm'
    ? candidate
    : review === 'cancel'
      ? data?.activeSettlements.find(item => item.id === cancellation?.settlementId)
      : undefined
  const op = target.kind === 'outpatient'
  const feedback = <>
    {error === null ? null : (
      <Alert variant="destructive">
        <AlertTitle>{t('医保操作未完成', 'Benefits operation incomplete')}</AlertTitle>
        <AlertDescription>{getWorkspaceErrorMessage(error, getWorkspaceMessages(locale))}</AlertDescription>
      </Alert>
    )}
    {write.pending === null ? null : (
      <Alert>
        <AlertTitle>{t('原操作结果待确认', 'Original result unconfirmed')}</AlertTitle>
        <AlertDescription>
          {ownPending ? (
            <Button disabled={write.mutation.isPending} onClick={() => write.mutation.mutate(undefined)} variant="outline">
              {t('恢复原医保操作', 'Recover original benefits operation')}
            </Button>
          ) : <p>{t('请回到原患者及岗位恢复待确认操作。', 'Return to the original patient and workspace to recover the pending operation.')}</p>}
        </AlertDescription>
      </Alert>
    )}
  </>
  return (
    <section
      aria-label={t('患者医保待遇', 'Patient insurance benefits')}
      className="flex min-w-0 flex-col gap-4 rounded-md border p-4"
    >
      <Button className="w-fit self-start" variant="outline" aria-expanded={opened} onClick={() => setOpened(v => !v)}>
        {t('患者医保待遇（合成）', 'Synthetic patient insurance benefits')}
      </Button>
      {opened ? (
        <>
          <p className="text-xs text-muted-foreground">
            {t('基金、个人账户和患者现金分别核对；待遇确认不代表已经收款。', 'Check fund, personal account and patient cash separately. Benefits confirmation does not collect money.')}
          </p>
          {state.isPending ? (
            <Skeleton className="h-20 w-full" />
          ) : state.isError ? (
            <Alert variant="destructive">
              <AlertTitle>{t('医保读取失败', 'Cannot read benefits')}</AlertTitle>
              <AlertDescription>
                <Button onClick={() => state.refetch()} variant="outline">{t('重试', 'Retry')}</Button>
              </AlertDescription>
            </Alert>
          ) : data === undefined ? null : (
            <>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="insurance-plan">{t('固定合成方案', 'Fixed synthetic plan')}</FieldLabel>
                  <WorkspaceSelect
                    id="insurance-plan"
                    disabled={busy || data.balance.planCode !== undefined}
                    items={[
                      { value: 'employee-v1', label: t('合成职工 v1', 'Synthetic employee v1') },
                      { value: 'resident-v1', label: t('合成居民 v1', 'Synthetic resident v1') },
                    ]}
                    value={plan}
                    onValueChange={(value) => {
                      if (value === 'employee-v1' || value === 'resident-v1') {
                        setSelectedPlan(value)
                        preview.reset()
                      }
                    }}
                  />
                </Field>
              </FieldGroup>
              <p className="text-xs text-muted-foreground">
                {t('年度起付线', 'Annual deductible')} {f(parameters.deductibleFen)} · {t('基金比例', 'Fund rate')} {parameters.ratioBps / 100}% · {t('年度封顶', 'Annual fund cap')} {f(parameters.capFen)}
              </p>
              <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
                {([
                  ['年度基金累计', 'Annual fund used', op ? data.balance.outpatientFundFen : data.balance.inpatientFundFen],
                  ['年度目录内累计', 'Annual eligible charges', op ? data.balance.outpatientEligibleFen : data.balance.inpatientEligibleFen],
                  ['个人账户余额', 'Personal account balance', data.balance.planCode === undefined ? insurancePlans[plan].initialAccountFen : data.balance.accountFen],
                ] as const).map(([c, e, v]) => (
                  <div key={e}><dt>{t(c, e)}</dt><dd>{f(v)}</dd></div>
                ))}
              </dl>
              <Button className="w-fit self-start" disabled={busy} onClick={() => preview.mutate()} variant="outline">
                {t('预览医保待遇', 'Preview benefits')}
              </Button>
              {data.activeSettlements.map((settlement, index) => (
                <div key={settlement.id} className="flex min-w-0 flex-col gap-3 rounded-md border p-3">
                  <p className="text-sm font-medium">{t('有效待遇', 'Active settlement')} {index + 1}</p>
                  <InsuranceAmounts settlement={settlement} locale={locale} />
                  <Button
                    disabled={busy}
                    onClick={() => {
                      const balance = data.annualBalances.find(row => row.year === settlement.year) ?? data.balance
                      setCancellation({ settlementId: settlement.id, expectedBalanceVersion: balance.version })
                      setReview('cancel')
                    }}
                    variant="outline"
                  >
                    {t('撤销原待遇', 'Cancel original benefits')}
                  </Button>
                </div>
              ))}
              {candidate === undefined ? null : (
                <>
                  <InsuranceAmounts settlement={candidate} locale={locale} />
                  <Button disabled={busy} onClick={() => setReview('confirm')}>
                    {t('审阅医保结算', 'Review benefits settlement')}
                  </Button>
                </>
              )}
              <details>
                <summary className="cursor-pointer text-sm">
                  {t('待遇与补偿历史', 'Benefits and compensation history')} ({data.history.length})
                </summary>
                <ul className="mt-2 flex flex-col gap-2 text-xs">
                  {data.history.map((item) => (
                    <li key={item.id}>
                      {item.reversesId === undefined ? t('待遇结算', 'Settlement') : t('原待遇补偿', 'Compensation')} · {f(item.fundFen)} {t('基金', 'fund')} · {f(item.accountFen)} {t('个人账户', 'personal account')}
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
          {review === null ? feedback : null}
          <AlertDialog pending={write.mutation.isPending} open={review !== null} onOpenChange={(open) => { if (!open) setReview(null) }}>
            <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {review === 'cancel' ? t('确认撤销医保', 'Confirm benefits cancellation') : t('确认医保结算', 'Confirm benefits settlement')}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t('核对本次基金、个人账户及患者应付。服务端会重新检查费用和年度余额；发生变化须重新预览。', 'Review fund, personal account and patient due. The server rechecks charges and annual balances; changed facts require another preview.')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              {reviewSettlement ? <InsuranceAmounts settlement={reviewSettlement} locale={locale} /> : null}
              {feedback}
              <AlertDialogFooter>
                <AlertDialogCancel>{t('返回核对', 'Back')}</AlertDialogCancel>
                <Button
                  disabled={write.mutation.isPending || write.pending !== null || write.storageFailure !== null}
                  onClick={() => {
                    if (review === 'confirm' && preview.data !== undefined) {
                      const data = preview.data.data
                      write.mutation.mutate({ operation: 'insurance.confirm', input: { ...target, previewId: data.previewId, commitToken: data.commitToken } })
                    }
                    if (review === 'cancel' && cancellation !== null)
                      write.mutation.mutate({ operation: 'insurance.cancel', input: { ...target, ...cancellation } })
                  }}
                >
                  {review === 'cancel' ? t('提交撤销', 'Submit cancellation') : t('提交医保结算', 'Submit benefits settlement')}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : null}
    </section>
  )
}
function matchesTarget(input: object, target: InsuranceTarget) {
  return 'kind' in input && 'id' in input && input.kind === target.kind && input.id === target.id
}

function InsuranceAmounts({
  settlement,
  locale,
}: {
  settlement: z.infer<typeof insurancePreviewResponseSchema>['data']['settlement']
  locale: WorkspaceLocale
}) {
  const zh = locale === 'zh-CN'
  const t = (c: string, e: string) => zh ? c : e
  const f = (n: number) => formatFen(n, locale)
  const charges = new Map(settlement.source.charges.map(row => [row.reference, row]))
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        {([
          ['基金支付', 'Fund pays', settlement.fundFen],
          ['个人账户支付', 'Personal account pays', settlement.accountFen],
          ['患者现金应付', 'Patient cash due', settlement.patientFen],
        ] as const).map(([c, e, v]) => (
          <div key={e}><dt>{t(c, e)}</dt><dd>{f(v)}</dd></div>
        ))}
      </dl>
      <Table>
        <TableHeader>
          <TableRow>
            {([
              ['原费用', 'Original charge'],
              ['目录外', 'Outside coverage'],
              ['先行自付', 'Prior self pay'],
              ['起付', 'Deductible'],
              ['基金', 'Fund'],
            ] as const).map(([c, e]) => <TableHead key={e}>{t(c, e)}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {settlement.allocations.map((row) => {
            const charge = charges.get(row.reference)
            const tier = charge ? coverageTierLabel(charge.coverage, zh, row.items ?? charge.items) : null
            return (
              <TableRow key={row.reference}>
                <TableCell>
                  <div>
                    <span>{charge?.label}</span>
                    {tier ? <span className="ml-1.5 rounded border px-1 text-xs">{tier}</span> : null}
                  </div>
                  {row.items && row.items.length > 1 ? (
                    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                      {row.items.map((item, idx) => (
                        <li key={item.id ?? `${row.reference}-${idx}`}>
                          {item.label} · {coverageTierLabel(item.coverage, zh)} · {f(item.amountFen)}{formatTierMeta(item, locale)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </TableCell>
                {[row.outsideFen, row.priorSelfPayFen, row.deductibleFen, row.fundFen].map((n, i) => (
                  <TableCell key={i}>{f(n)}</TableCell>
                ))}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
