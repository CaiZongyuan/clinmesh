import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ApiClientError } from './api-client.ts'
import { fetchInpatientDrgPregroup, runInpatientDrgSimulation } from './inpatient-doctor-queries.ts'
import { inpatientScopeKey } from './inpatient-scope.ts'
import { formatFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

const stateLabels: Record<string, [string, string]> = {
  grouped: ['已入组', 'Grouped'],
  ungroupable: ['无法入组', 'Ungroupable'],
  ambiguous: ['分组歧义', 'Ambiguous'],
  'invalid-input': ['输入无效', 'Invalid input'],
}
/** 预分组不可用的两类已知原因按提示呈现（首页未提交、规则包未配置），其余按错误呈现。 */
const expectedBlockers = ['DRG_RECORD_NOT_SUBMITTED', 'DRG_RULES_NOT_CONFIGURED']

/** 医生站概要卡：DRG 预分组与处方推演试算，全部来自既有只读接口；失败显示错误态。 */
export function InpatientDoctorDrgCard({ admission, session, locale }: {
  admission: InpatientAdmission
  session: SessionContext
  locale: WorkspaceLocale
}): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const scope = inpatientScopeKey(session)
  const available = admission.status !== 'registered'
  const pregroup = useQuery({ queryKey: [...scope, admission.id, 'drg-pregroup'], enabled: available,
    queryFn: ({ signal }) => fetchInpatientDrgPregroup(admission.id, signal) })
  const simulation = useMutation({ mutationFn: () => runInpatientDrgSimulation(admission.id) })
  const describe = (error: Error) => error instanceof ApiClientError && error.message.trim() !== '' ? error.message : t('读取失败，请稍后重试。', 'Request failed; try again later.')
  const pregrouped = pregroup.data
  const result = pregrouped?.result
  return <section aria-label={t('DRG 预分组与推演', 'DRG pregrouping and simulation')} data-inpatient-doctor-drg className="flex flex-col gap-2 rounded-md border bg-card p-3">
    <h3 className="font-serif text-sm font-semibold">{t('DRG 预分组与推演', 'DRG pregrouping and simulation')}</h3>
    {!available ? <p className="text-sm text-muted-foreground">{t('尚未入科，入科后可预分组。', 'Available after the patient is admitted.')}</p>
      : pregroup.isPending ? <p className="text-sm text-muted-foreground">{t('正在读取预分组…', 'Loading pregrouping…')}</p>
      : pregroup.error !== null ? (pregroup.error instanceof ApiClientError && expectedBlockers.includes(pregroup.error.code)
        ? <p className="text-sm text-muted-foreground">{describe(pregroup.error)}</p>
        : <p role="alert" className="text-sm text-destructive">{describe(pregroup.error)}</p>)
      : result !== undefined ? <div className="flex flex-col gap-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={result.status === 'grouped' ? 'text-success' : result.status === 'invalid-input' ? 'text-destructive' : 'text-warning'}>
            {(() => { const [zhLabel, enLabel] = stateLabels[result.status] ?? [result.status, result.status]; return t(zhLabel, enLabel) })()}
          </Badge>
          {result.drgCode !== null ? <span className="font-mono text-base font-semibold">{result.drgCode}</span> : null}
          <Badge variant="outline" className="text-muted-foreground">{pregrouped!.frozen ? t('归档冻结', 'Frozen at archive') : t('实时推算', 'Live estimate')}</Badge>
        </div>
        <p className="text-muted-foreground">MDC <span className="font-mono">{result.mdcCode ?? '—'}</span> · ADRG <span className="font-mono">{result.adrgCode ?? '—'}</span></p>
        <p className="text-muted-foreground">{t('规则 ', 'Rules ')}<span className="font-mono">{pregrouped!.rulesId} {pregrouped!.rulesVersion}</span> · {t('首页修订 ', 'record rev. ')}<span className="font-mono">{pregrouped!.recordRevision}</span></p>
        {result.reason !== null && result.status !== 'grouped' ? <p className="text-warning">{result.reason}</p> : null}
      </div> : null}
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" disabled={!available || simulation.isPending}
        onClick={() => simulation.mutate()}>{simulation.isPending ? t('推演中…', 'Simulating…') : t('处方推演试算', 'Run simulation')}</Button>
      {simulation.isPending ? <span className="text-xs text-muted-foreground">{t('只读对照，不改变诊疗与收费。', 'Read-only comparison; nothing is billed.')}</span> : null}
    </div>
    {simulation.error !== null ? <p role="alert" className="text-sm text-destructive">{describe(simulation.error)}</p> : null}
    {simulation.data !== undefined ? <div className="flex flex-col gap-1 text-sm">
      <p>{t('正式分组 ', 'Formal group ')}<span className="font-mono">{simulation.data.grouping.formal.drgCode ?? '—'}</span>
        {simulation.data.grouping.projected !== null ? <> · {t('若计划手术实施 ', 'if planned surgery performed ')}<span className="font-mono">{simulation.data.grouping.projected.drgCode ?? '—'}</span></> : null}</p>
      <p>{t('正式收费 ', 'Formal charges ')}<span className="font-mono tabular-nums">{formatFen(simulation.data.formal.chargesFen, locale)}</span>
        {' · '}{t('推演总额 ', 'estimated total ')}<span className="font-mono tabular-nums">{formatFen(simulation.data.coverage.estimatedTotalFen, locale)}</span>
        {' · '}{t('已覆盖 ', 'covered ')}<span className="font-mono">{simulation.data.coverage.coveredRatioBp === null ? '—' : `${(simulation.data.coverage.coveredRatioBp / 100).toFixed(2)}%`}</span></p>
      <p>{t('未记费承诺 ', 'Committed items ')}<span className="font-mono">{simulation.data.committed.items.length}</span>{t(' 项 · 治疗预留 ', ' · reserved items ')}<span className="font-mono">{simulation.data.reserved.items.length}</span>{t(' 项', '')}</p>
      <p className="text-xs text-muted-foreground">{simulation.data.coverage.note}</p>
    </div> : null}
  </section>
}
