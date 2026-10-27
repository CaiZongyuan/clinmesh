import { inpatientCatalogSchema, type InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { scenarioStateSchema, type SessionContext } from '@clinmesh/contracts/his'
import { Button } from '@clinmesh/ui/components/button'
import { useQueries, useQuery } from '@tanstack/react-query'
import { apiGet } from './api-client.ts'
import { DAY_MS, inpatientScopeKey } from './inpatient-scope.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { formatFen } from './workspace-format.ts'
import { inpatientStatus } from './inpatient-patient-workspace.tsx'
import type { z } from 'zod'

type Catalog = z.infer<typeof inpatientCatalogSchema>

// 护士站一览板：床位格、待接诊、召回窗口与本班医嘱任务，全部来自既有查询，不新增端点。
export function InpatientNurseBench({ admissions, catalog, session, locale, onSelect }: {
  admissions: InpatientAdmission[]
  catalog: Catalog | undefined
  session: SessionContext
  locale: WorkspaceLocale
  onSelect: (admissionId: string) => void
}): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const scope = inpatientScopeKey(session)
  const messages = getWorkspaceMessages(locale)
  const scenario = useQuery({ queryKey: ['scenario', 'virtual-time'], queryFn: ({ signal }) => apiGet('/api/sim/v1/scenario-runs/current', scenarioStateSchema, signal), retry: false })
  const virtualMs = scenario.data !== undefined ? Date.parse(scenario.data.virtualTime) : undefined
  const error = scenario.error

  const registered = admissions.filter(admission => admission.status === 'registered')
  const departedOpen = admissions.filter(admission => admission.status === 'departed' && admission.financialStatus === 'open' && admission.bedId !== undefined)
  // 出区清床后 admission 停留在 cleared（归档只锁病案），保留只读回查入口。
  const discharged = admissions.filter(admission => admission.status === 'cleared')
  const byId = new Map(admissions.map(admission => [admission.id, admission]))
  // 与 inpatientCareDay 的横幅合同不同：一览板自登记起算，未入科也显示第 1 天。
  const dayOf = (admission: InpatientAdmission) => {
    const start = admission.admittedAt ?? admission.registeredAt
    return virtualMs === undefined || start === undefined ? undefined : Math.max(1, Math.floor((virtualMs - Date.parse(start)) / DAY_MS) + 1)
  }

  const clinicalTargets = admissions.filter(admission => admission.status === 'admitted' || admission.status === 'discharge-pending')
  const clinicals = useQueries({ queries: clinicalTargets.map(admission => ({
    queryKey: [...scope, admission.id, 'clinical'],
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/clinical`, inpatientFullClinicalSchema, signal),
  })) })
  const tasks = clinicalTargets.map((admission, index) => {
    const data = clinicals[index]?.data
    if (data === undefined) return null
    const toVerify = data.orders.filter(order => order.state === 'signed').length
    const toAdminister = data.executions.filter(execution => execution.status === 'pending' || execution.status === 'dispensed').length
    return toVerify + toAdminister > 0 ? { admission, toVerify, toAdminister } : null
  }).filter(task => task !== null)

  const wards = catalog?.wards ?? []
  const beds = catalog?.beds ?? []

  return <div className="flex flex-col gap-4" aria-label={t('病区一览板', 'Ward board')}>
    <header className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-lg font-semibold">{t('病区一览板', 'Ward board')}</h2>
      <p className="font-mono text-xs text-muted-foreground">
        {scenario.data !== undefined ? new Date(scenario.data.virtualTime).toLocaleString(zh ? 'zh-CN' : 'en-US', { timeZone: 'Asia/Shanghai' }) : t('虚拟时间读取中', 'Loading virtual time')}
      </p>
    </header>
    {error !== null ? <p role="alert" className="text-sm text-destructive">{getWorkspaceErrorMessage(error, messages)}</p> : null}

    {registered.length > 0 ? <section aria-label={t('待接诊', 'Awaiting admission')} className="border-l-4 border-destructive bg-destructive/5 px-3 py-2">
      <p className="text-sm">
        {t('待接诊：', 'Awaiting admission: ')}
        {registered.map(admission => <Button key={admission.id} variant="link" className="h-auto px-1 font-mono" onClick={() => onSelect(admission.id)}>
          {admission.patientName}（{admission.inpatientNumber}）
        </Button>)}
        {t('——点击接诊并分床', ' — select to admit and assign a bed')}
      </p>
    </section> : null}

    {wards.map(ward => {
      const wardBeds = beds.filter(bed => bed.wardId === ward.id)
      return <section key={ward.id} aria-label={ward.name} className="border border-border bg-card">
        <h3 className="border-b border-border px-3 py-2 text-sm font-semibold">{ward.name}</h3>
        {wardBeds.length === 0 ? <p className="px-3 py-3 text-sm text-muted-foreground">{t('该病区暂无床位', 'No beds in this ward')}</p> : <ul className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {wardBeds.map(bed => {
            const admission = bed.admissionId !== undefined ? byId.get(bed.admissionId) : undefined
            const day = admission !== undefined ? dayOf(admission) : undefined
            return <li key={bed.id} className="bg-card">
              {admission !== undefined
                ? <button type="button" onClick={() => onSelect(admission.id)} className="flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-secondary focus-visible:outline-ring" aria-label={`${bed.name} ${admission.patientName}`}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{bed.name}</span>
                    <span className="border border-border px-1 text-xs">{inpatientStatus(admission, locale)}</span>
                  </span>
                  <span className="text-sm font-medium">{admission.patientName}</span>
                  {day !== undefined ? <span className="font-mono text-xs text-muted-foreground">{t(`住院第 ${day} 天`, `Day ${day}`)}</span> : null}
                </button>
                : <div className="flex flex-col gap-1 px-3 py-2 opacity-70">
                  <span className="font-mono text-xs text-muted-foreground">{bed.name}</span>
                  <span className="text-sm">{t('空闲', 'Free')}</span>
                  <span className="font-mono text-xs text-muted-foreground">{formatFen(bed.dailyPriceFen, locale)}/{t('天', 'day')}</span>
                </div>}
            </li>
          })}
        </ul>}
      </section>
    })}
    {catalog === undefined ? <p className="text-sm text-muted-foreground">{t('正在加载病区目录', 'Loading ward catalog')}</p> : null}

    {departedOpen.length > 0 ? <section aria-label={t('召回窗口', 'Recall window')} className="border border-warning/60 bg-warning/5 px-3 py-2">
      <h3 className="text-sm font-semibold">{t('召回窗口（出区未结算，原床保留）', 'Recall window (departed, unsettled, bed held)')}</h3>
      <ul className="mt-1 text-sm">
        {departedOpen.map(admission => <li key={admission.id}>
          <span className="font-medium">{admission.patientName}</span>
          <span className="font-mono text-muted-foreground"> · {admission.inpatientNumber}</span>
          {t(' —— 已出区待结算；点击上方床位格进入，召回由住院医生在患者页执行。', ' — departed and unsettled; use the bed card above to open the chart, recall is executed by the physician.')}
        </li>)}
      </ul>
    </section> : null}

    {discharged.length > 0 ? <section aria-label={t('出院后病历', 'Post-discharge records')} className="border border-border bg-card">
      <h3 className="border-b border-border px-3 py-2 text-sm font-semibold">{t('出院后病历（只读回查）', 'Post-discharge records (read only)')}</h3>
      <ul className="divide-y divide-border">
        {discharged.map(admission => <li key={admission.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
          <Button variant="link" className="h-auto px-0 font-medium" onClick={() => onSelect(admission.id)}>{admission.patientName}</Button>
          <span className="font-mono text-xs text-muted-foreground">{admission.inpatientNumber}</span>
          <span className="ml-auto border border-border px-1 text-xs text-muted-foreground">{inpatientStatus(admission, locale)}</span>
        </li>)}
      </ul>
    </section> : null}

    <section aria-label={t('本班医嘱任务', 'Shift medication tasks')} className="border border-border bg-card">
      <h3 className="border-b border-border px-3 py-2 text-sm font-semibold">{t('本班医嘱任务', 'Shift medication tasks')}</h3>
      {tasks.length === 0 ? <p className="px-3 py-3 text-sm text-muted-foreground">{t('本班暂无待校对或待执行任务', 'No orders awaiting verification or administration this shift')}</p> : <ul className="divide-y divide-border">
        {tasks.map(task => <li key={task.admission.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="text-sm font-medium">{task.admission.patientName}</span>
          <span className="font-mono text-xs text-muted-foreground">{task.admission.inpatientNumber}</span>
          {task.toVerify > 0 ? <span className="border border-warning px-1 text-xs text-warning">{t(`待校对 ${task.toVerify}`, `${task.toVerify} to verify`)}</span> : null}
          {task.toAdminister > 0 ? <span className="border border-destructive px-1 text-xs text-destructive">{t(`待执行/给药 ${task.toAdminister}`, `${task.toAdminister} to administer`)}</span> : null}
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => onSelect(task.admission.id)}>{t('去处理', 'Open')}</Button>
        </li>)}
      </ul>}
    </section>
  </div>
}
