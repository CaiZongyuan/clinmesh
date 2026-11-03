import { useQuery } from '@tanstack/react-query'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientDrgPregroupResultSchema } from '@clinmesh/contracts/inpatient-drg'
import { Button } from '@clinmesh/ui/components/button'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { apiGet } from './api-client.ts'
import { DrgError, DrgGrouping } from './inpatient-drg.tsx'
import { formatFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

/** 病案岗位已有许可的正式分组读取；归档后继续展示冻结结果。 */
export function InpatientRecordDrgSummary({ admission, session, locale }: { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale }) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const grouping = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id, 'drg-pregroup'], retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/pregroup`, inpatientDrgPregroupResultSchema, signal) })
  const data = grouping.error === null ? grouping.data : undefined
  return <section aria-label={t('病案 DRG 分组复核', 'Record DRG grouping review')} className="clinmesh-inpatient-summary">
    <div className="clinmesh-inpatient-section-heading"><h3>{t('DRG 分组复核', 'DRG grouping review')}</h3><Button variant="ghost" size="sm" disabled={grouping.isFetching} onClick={() => void grouping.refetch()}>{t('刷新分组', 'Refresh grouping')}</Button></div>
    {grouping.isPending ? <Skeleton className="h-16 w-full" /> : null}
    <DrgError error={grouping.error} locale={locale} />
    {data ? <><DrgGrouping result={data.result} locale={locale} title={data.frozen ? t('归档分组', 'Fixed archive grouping') : t('当前病案分组', 'Current record grouping')} />
      <p className="text-sm text-muted-foreground">{data.frozen ? t('按归档时的诊断与实际操作固定，后续更正不改写该分组。', 'Fixed from archived diagnoses and performed procedures. Later corrections do not rewrite this group.') : t('按当前已确认诊断与实际操作计算；归档前可继续核对来源。', 'Calculated from confirmed diagnoses and performed procedures. Sources can be reviewed before archive.')}</p>
      {data.frozen && data.paymentEstimate ? <p>{t('归档医院支付参考 ', 'Archived hospital payment reference ')}{formatFen(data.paymentEstimate.referenceFen, locale)}</p> : null}</> : null}
  </section>
}
