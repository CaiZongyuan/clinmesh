import { useQuery } from '@tanstack/react-query'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientDrgPregroupResultSchema } from '@clinmesh/contracts/inpatient-drg'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { ApiClientError, apiGet } from './api-client.ts'
import { DrgError } from './inpatient-drg.tsx'
import { DrgGroupingEvidence, DrgSummaryFacts, drgGroupingStatusLabel } from './inpatient-drg-summary.tsx'
import { formatFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

/** 病案岗位已有许可的正式分组读取；归档后继续展示冻结结果。 */
export function InpatientRecordDrgSummary({ admission, session, locale }: { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale }) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const grouping = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id, 'drg-pregroup'], retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/pregroup`, inpatientDrgPregroupResultSchema, signal) })
  // 与同页病案正文共用原查询；归档费用始终来自归档快照，不回退到当前住院金额。
  const record = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id, 'record'], retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/record`, inpatientRecordSchema, signal) })
  const data = grouping.error === null ? grouping.data : undefined
  const snapshot = record.error === null ? data?.frozen ? record.data?.archive?.snapshot : record.data?.snapshot : undefined
  const unknown = <span aria-label={t('当前资料未提供', 'Not provided in the current data')}>—</span>
  const missingArchive = admission.recordStatus === 'archived' && grouping.error instanceof ApiClientError
    && grouping.error.code === 'DRG_FROZEN_RESULT_MISSING'
  return <section aria-label={t('病案 DRG 分组复核', 'Record DRG grouping review')} className="clinmesh-inpatient-summary">
    <div className="clinmesh-inpatient-section-heading"><h3>{t('DRG 复核', 'DRG review')}</h3><div className="flex flex-wrap items-center gap-2">{data ? <span className="text-xs text-muted-foreground">{data.frozen ? t('按归档时固定', 'Fixed at archive') : t('按当前诊断与操作计算', 'From current diagnoses & procedures')}</span> : null}{data ? <Badge variant="outline">{drgGroupingStatusLabel(data.result.status, locale)}</Badge> : null}<Button variant="ghost" size="sm" disabled={grouping.isFetching || record.isFetching} onClick={() => { void grouping.refetch(); void record.refetch() }}>{t('刷新分组', 'Refresh grouping')}</Button></div></div>
    {grouping.isPending ? <Skeleton className="h-16 w-full" /> : null}
    {missingArchive ? <p role="status" className="text-sm text-muted-foreground">{t('归档时未形成固定分组，当前没有可复核的分组依据。', 'No grouping result was fixed at archive time; no grouping basis is available for review.')}</p> : <DrgError error={grouping.error} locale={locale} />}
    {data ? <><section aria-label={data.frozen ? t('归档分组', 'Fixed archive grouping') : t('当前病案分组', 'Current record grouping')} className="flex min-w-0 flex-col gap-2">
      <DrgSummaryFacts facts={[
        { label: t('病组', 'Group'), value: data.result.drgCode ?? unknown },
        { label: t('病组名称', 'Group name'), value: <span aria-label={t('当前资料未提供病组名称', 'Group name is not provided in the current data')}>—</span> },
        { label: t('病案费用', 'Record charges'), value: snapshot ? formatFen(snapshot.fees.chargesFen, locale) : unknown },
        { label: t('支付预估', 'Payment estimate'), value: data.paymentEstimate ? formatFen(data.paymentEstimate.referenceFen, locale) : unknown },
      ]} />
      <DrgGroupingEvidence result={data.result} locale={locale} />
    </section>
      <p className="text-xs text-muted-foreground">{data.frozen ? t('按归档时的诊断与实际操作固定，后续更正不改写该分组。', 'Fixed from archived diagnoses and performed procedures. Later corrections do not rewrite this group.') : t('按当前已确认诊断与实际操作计算；归档前可继续核对来源。', 'Calculated from confirmed diagnoses and performed procedures. Sources can be reviewed before archive.')}</p>
      {record.error ? <p role="status" className="text-sm text-muted-foreground">{t('病案费用暂不可用，请刷新后核对。', 'Record charges are unavailable. Refresh before reviewing them.')}</p> : null}</> : null}
  </section>
}
