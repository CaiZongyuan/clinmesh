import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { inpatientDrgAgentSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { inpatientDrgRecordChecksSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { useQuery } from '@tanstack/react-query'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { apiGet } from './api-client.ts'
import { inpatientScopeKey } from './inpatient-scope.ts'
import { InpatientPciCosts } from './inpatient-pci-costs.tsx'
import { InpatientDrgRecordExplanation } from './inpatient-drg-record-checks.tsx'
import { formatFen } from './workspace-format.ts'
import { getWorkspaceMessages } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent>; executionId: string; active?: boolean }
export function InpatientSurgeryCosts({ admission, session, locale, write, executionId, active = true }: Props): React.JSX.Element {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const doctor = session.actor.roleCode === 'inpatient-doctor'
  const scope = [...inpatientScopeKey(session), admission.id]
  const poll = active && admission.recordStatus !== 'archived' ? 3_000 : false
  const query = useQuery({ queryKey: [...scope, 'drg-agent'], enabled: active, retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/agent`, inpatientDrgAgentSchema, signal),
    refetchInterval: poll, refetchIntervalInBackground: false })
  const checks = useQuery({ queryKey: [...scope, 'drg-record-checks'], enabled: active && doctor, retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/drg/record-checks`, inpatientDrgRecordChecksSchema, signal),
    refetchInterval: doctor ? poll : false, refetchIntervalInBackground: false })
  const data = query.error === null ? query.data : undefined
  const usage = data?.usage.filter(item => item.executionId === executionId) ?? []
  return <section aria-label={t('本台耗材与实时费用', 'Surgery material use and live costs')} className="flex min-w-0 flex-col gap-3 border-t pt-3">
    <h5 className="font-medium">{t('本台耗材与实时费用', 'Surgery material use and live costs')}</h5>
    <p className="text-sm text-muted-foreground">{t('按正式登记和更正即时核算，读取与更新费用不请求 AI。费用不改变临床选择。', 'Costs follow formal entries and corrections. Reading or updating costs does not request AI and does not change clinical choices.')}</p>
    {query.isPending ? <p role="status">{t('正在读取实时费用', 'Loading live costs')}</p> : query.isFetching ? <p role="status">{t('正在更新费用，请稍候核对', 'Updating costs; wait before reviewing')}</p> : null}
    {query.error ? <Alert variant="destructive"><AlertDescription>{t('实时费用读取失败。', 'Live costs could not be read.')} {getWorkspaceErrorMessage(query.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    {data ? <>
      {usage.length > 0 ? <Table><TableHeader><TableRow><TableHead>{t('材料', 'Material')}</TableHead><TableHead>{t('计划量', 'Planned')}</TableHead><TableHead>{t('已用量', 'Used')}</TableHead><TableHead>{t('剩余量', 'Remaining')}</TableHead><TableHead>{t('费用影响', 'Cost effect')}</TableHead></TableRow></TableHeader><TableBody>
        {usage.map(item => <TableRow key={`${item.materialId}:${item.catalogVersion}`}>
          <TableCell className="whitespace-normal">{item.display}<div className="flex flex-wrap gap-1">{item.unplanned ? <Badge variant="secondary">{t('计划外', 'Unplanned')}</Badge> : item.excessQuantity > 0 ? <Badge variant="secondary">{t(`超出计划 ${item.excessQuantity}${item.unit}`, `Above plan by ${item.excessQuantity} ${item.unit}`)}</Badge> : null}</div></TableCell>
          <TableCell className="tabular-nums">{item.plannedQuantity === null ? t('未确认', 'Unconfirmed') : `${item.plannedQuantity}${item.unit}`}</TableCell>
          <TableCell className="tabular-nums">{item.actualQuantity}{item.unit}</TableCell>
          <TableCell className="tabular-nums">{item.remainingQuantity === null ? t('未知', 'Unknown') : `${item.remainingQuantity}${item.unit}`}</TableCell>
          <TableCell className="tabular-nums">{formatFen(item.usedFen, locale)}{item.additionalFen > 0 ? <p className="text-sm">{t('其中计划外或超计划 ', 'Unplanned or excess portion ')}{formatFen(item.additionalFen, locale)}</p> : null}</TableCell>
        </TableRow>)}
      </TableBody></Table> : <p>{t('本台尚无可核算的耗材计划或实际使用。', 'No material plan or actual use is available for this surgery.')}</p>}
      <dl><div className="flex flex-wrap justify-between gap-2"><dt>{t('本台已用耗材费用', 'Materials used in this surgery')}</dt><dd className="tabular-nums">{formatFen(usage.reduce((sum, item) => sum + item.usedFen, 0), locale)}</dd></div></dl>
      <InpatientPciCosts costs={data.costs} locale={locale} />
    </> : null}
    {doctor && checks.error ? <Alert variant="destructive"><AlertDescription>{t('费用解释依据读取失败，规则费用仍可查看。', 'Explanation sources could not be read; rule-based costs remain available.')}</AlertDescription></Alert> : null}
    {doctor && checks.error === null && checks.data ? <InpatientDrgRecordExplanation key={scope.join('/')} admission={admission} session={session} locale={locale} write={write} active={active} checks={checks.data} /> : null}
  </section>
}
