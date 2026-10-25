import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  insurancePlans,
  type insurancePreviewResponseSchema,
  type InsuranceTarget,
} from '@clinmesh/contracts/insurance'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@clinmesh/ui/components/table'
import { getInsuranceState, newIdempotencyKey, previewInsurance } from './api-client.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { formatFen } from './workspace-format.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'

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
  const busy = disabled || preview.isPending || write.blocked
  const candidate = preview.data?.data.settlement
  const plan = state.data?.balance.planCode ?? selectedPlan
  const parameters = insurancePlans[plan][target.kind]
  const error = preview.error ?? write.mutation.error ?? write.storageFailure
  const ownPending = write.pending !== null && matchesTarget(write.pending.command.input, target)
  const cancellationSettlement = state.data?.activeSettlements.find(
    (item) => item.id === cancellation?.settlementId,
  )
  const feedback = <>
    {error === null ? null : (
      <Alert variant="destructive">
        <AlertTitle>{zh ? '医保操作未完成' : 'Benefits operation incomplete'}</AlertTitle>
        <AlertDescription>{getWorkspaceErrorMessage(error, getWorkspaceMessages(locale))}</AlertDescription>
      </Alert>
    )}
    {write.pending === null ? null : (
      <Alert>
        <AlertTitle>{zh ? '原操作结果待确认' : 'Original result unconfirmed'}</AlertTitle>
        <AlertDescription>
          {ownPending ? (
            <Button disabled={write.mutation.isPending} onClick={() => write.mutation.mutate(undefined)} variant="outline">
              {zh ? '恢复原医保操作' : 'Recover original benefits operation'}
            </Button>
          ) : <p>{zh ? '请回到原患者及岗位恢复待确认操作。' : 'Return to the original patient and workspace to recover the pending operation.'}</p>}
        </AlertDescription>
      </Alert>
    )}
  </>
  return (
    <section
      aria-label={zh ? '患者医保待遇' : 'Patient insurance benefits'}
      className="flex min-w-0 flex-col gap-4 rounded-md border p-4"
    >
      <Button variant="outline" aria-expanded={opened} onClick={() => setOpened((value) => !value)}>
        {zh ? '患者医保待遇（合成）' : 'Synthetic patient insurance benefits'}
      </Button>
      {opened ? (
        <>
          <p className="text-xs text-muted-foreground">
            {zh
              ? '基金、个人账户和患者现金分别核对；待遇确认不代表已经收款。'
              : 'Check fund, personal account and patient cash separately. Benefits confirmation does not collect money.'}
          </p>
          {state.isPending ? (
            <Skeleton className="h-20 w-full" />
          ) : state.isError ? (
            <Alert variant="destructive">
              <AlertTitle>{zh ? '医保读取失败' : 'Cannot read benefits'}</AlertTitle>
              <AlertDescription>
                <Button onClick={() => state.refetch()} variant="outline">
                  {zh ? '重试' : 'Retry'}
                </Button>
              </AlertDescription>
            </Alert>
          ) : state.data === undefined ? null : (
            <>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="insurance-plan">
                    {zh ? '固定合成方案' : 'Fixed synthetic plan'}
                  </FieldLabel>
                  <WorkspaceSelect
                    id="insurance-plan"
                    disabled={busy || state.data.balance.planCode !== undefined}
                    items={[
                      { value: 'employee-v1', label: zh ? '合成职工 v1' : 'Synthetic employee v1' },
                      { value: 'resident-v1', label: zh ? '合成居民 v1' : 'Synthetic resident v1' },
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
                {zh ? '年度起付线' : 'Annual deductible'}{' '}
                {formatFen(parameters.deductibleFen, locale)} · {zh ? '基金比例' : 'Fund rate'}{' '}
                {parameters.ratioBps / 100}% · {zh ? '年度封顶' : 'Annual fund cap'}{' '}
                {formatFen(parameters.capFen, locale)}
              </p>
              <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
                <div>
                  <dt>{zh ? '年度基金累计' : 'Annual fund used'}</dt>
                  <dd>
                    {formatFen(
                      target.kind === 'outpatient'
                        ? state.data.balance.outpatientFundFen
                        : state.data.balance.inpatientFundFen,
                      locale,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{zh ? '年度目录内累计' : 'Annual eligible charges'}</dt>
                  <dd>
                    {formatFen(
                      target.kind === 'outpatient'
                        ? state.data.balance.outpatientEligibleFen
                        : state.data.balance.inpatientEligibleFen,
                      locale,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{zh ? '个人账户余额' : 'Personal account balance'}</dt>
                  <dd>
                    {formatFen(
                      state.data.balance.planCode === undefined
                        ? insurancePlans[plan].initialAccountFen
                        : state.data.balance.accountFen,
                      locale,
                    )}
                  </dd>
                </div>
              </dl>
              <Button disabled={busy} onClick={() => preview.mutate()} variant="outline">
                {zh ? '预览医保待遇' : 'Preview benefits'}
              </Button>
              {state.data.activeSettlements.map((settlement, index) => (
                <div
                  key={settlement.id}
                  className="flex min-w-0 flex-col gap-3 rounded-md border p-3"
                >
                  <p className="text-sm font-medium">
                    {zh ? '有效待遇' : 'Active settlement'} {index + 1}
                  </p>
                  <InsuranceAmounts settlement={settlement} locale={locale} />
                  <Button
                    disabled={busy}
                    onClick={() => {
                        const balance = state.data.annualBalances.find(row => row.year === settlement.year) ?? state.data.balance
                      setCancellation({
                        settlementId: settlement.id,
                          expectedBalanceVersion: balance.version,
                      })
                      setReview('cancel')
                    }}
                    variant="outline"
                  >
                    {zh ? '撤销原待遇' : 'Cancel original benefits'}
                  </Button>
                </div>
              ))}
              {candidate === undefined ? null : (
                <>
                  <InsuranceAmounts settlement={candidate} locale={locale} />
                  <Button disabled={busy} onClick={() => setReview('confirm')}>
                    {zh ? '审阅医保结算' : 'Review benefits settlement'}
                  </Button>
                </>
              )}
              <details>
                <summary className="cursor-pointer text-sm">
                  {zh ? '待遇与补偿历史' : 'Benefits and compensation history'} (
                  {state.data.history.length})
                </summary>
                <ul className="mt-2 flex flex-col gap-2 text-xs">
                  {state.data.history.map((item) => (
                    <li key={item.id}>
                      {item.reversesId === undefined
                        ? zh
                          ? '待遇结算'
                          : 'Settlement'
                        : zh
                          ? '原待遇补偿'
                          : 'Compensation'}{' '}
                      · {formatFen(item.fundFen, locale)} {zh ? '基金' : 'fund'} ·{' '}
                      {formatFen(item.accountFen, locale)} {zh ? '个人账户' : 'personal account'}
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
          {review === null ? feedback : null}
          <AlertDialog
            open={review !== null}
            onOpenChange={(open) => {
              if (!write.mutation.isPending && !open) setReview(null)
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {review === 'cancel'
                    ? zh
                      ? '确认撤销医保'
                      : 'Confirm benefits cancellation'
                    : zh
                      ? '确认医保结算'
                      : 'Confirm benefits settlement'}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {zh
                    ? '核对本次基金、个人账户及患者应付。服务端会重新检查费用和年度余额；发生变化须重新预览。'
                    : 'Review fund, personal account and patient due. The server rechecks charges and annual balances; changed facts require another preview.'}
                </AlertDialogDescription>
              </AlertDialogHeader>
              {review === 'confirm' && candidate !== undefined ? (
                <InsuranceAmounts settlement={candidate} locale={locale} />
              ) : null}
              {review === 'cancel' && cancellationSettlement !== undefined ? (
                <InsuranceAmounts settlement={cancellationSettlement} locale={locale} />
              ) : null}
              {feedback}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={write.mutation.isPending}>
                  {zh ? '返回核对' : 'Back'}
                </AlertDialogCancel>
                <Button
                  disabled={
                    write.mutation.isPending ||
                    write.pending !== null ||
                    write.storageFailure !== null
                  }
                  onClick={() => {
                    if (review === 'confirm' && preview.data !== undefined) {
                      const data = preview.data.data
                      write.mutation.mutate({
                        operation: 'insurance.confirm',
                        input: {
                          ...target,
                          previewId: data.previewId,
                          commitToken: data.commitToken,
                        },
                      })
                    }
                    if (review === 'cancel' && cancellation !== null)
                      write.mutation.mutate({
                        operation: 'insurance.cancel',
                        input: { ...target, ...cancellation },
                      })
                  }}
                >
                  {review === 'cancel'
                    ? zh
                      ? '提交撤销'
                      : 'Submit cancellation'
                    : zh
                      ? '提交医保结算'
                      : 'Submit benefits settlement'}
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
  const labels = new Map(settlement.source.charges.map((row) => [row.reference, row.label]))
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt>{zh ? '基金支付' : 'Fund pays'}</dt>
          <dd>{formatFen(settlement.fundFen, locale)}</dd>
        </div>
        <div>
          <dt>{zh ? '个人账户支付' : 'Personal account pays'}</dt>
          <dd>{formatFen(settlement.accountFen, locale)}</dd>
        </div>
        <div>
          <dt>{zh ? '患者现金应付' : 'Patient cash due'}</dt>
          <dd>{formatFen(settlement.patientFen, locale)}</dd>
        </div>
      </dl>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{zh ? '原费用' : 'Original charge'}</TableHead>
            <TableHead>{zh ? '目录外' : 'Outside coverage'}</TableHead>
            <TableHead>{zh ? '先行自付' : 'Prior self pay'}</TableHead>
            <TableHead>{zh ? '起付' : 'Deductible'}</TableHead>
            <TableHead>{zh ? '基金' : 'Fund'}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {settlement.allocations.map((row) => (
            <TableRow key={row.reference}>
              <TableCell>{labels.get(row.reference)}</TableCell>
              <TableCell>{formatFen(row.outsideFen, locale)}</TableCell>
              <TableCell>{formatFen(row.priorSelfPayFen, locale)}</TableCell>
              <TableCell>{formatFen(row.deductibleFen, locale)}</TableCell>
              <TableCell>{formatFen(row.fundFen, locale)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
