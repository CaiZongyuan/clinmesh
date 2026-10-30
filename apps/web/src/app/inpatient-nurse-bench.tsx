import { inpatientCatalogSchema, type InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientTransfersSchema } from '@clinmesh/contracts/inpatient-transfer'
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
import { inpatientPending } from './inpatient-stage-activity.ts'
import { Skeleton } from '@clinmesh/ui/components/skeleton'

type Catalog = z.infer<typeof inpatientCatalogSchema>

// 护士站一览板：床位格、待接诊、召回窗口与本班医嘱任务，全部来自既有查询，不新增端点。
export function InpatientNurseBench({ admissions, catalog, session, locale, onSelect, allowTransfers = false }: {
  admissions: InpatientAdmission[]
  catalog: Catalog | undefined
  session: SessionContext
  locale: WorkspaceLocale
  onSelect: (admissionId: string) => void
  allowTransfers?: boolean
}): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const scope = inpatientScopeKey(session)
  const messages = getWorkspaceMessages(locale)
  const scenario = useQuery({ queryKey: ['scenario', 'virtual-time'], queryFn: ({ signal }) => apiGet('/api/sim/v1/scenario-runs/current', scenarioStateSchema, signal), retry: false })
  const virtualMs = scenario.data !== undefined ? Date.parse(scenario.data.virtualTime) : undefined

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
  const investigations = useQueries({ queries: clinicalTargets.map(admission => ({
    queryKey: [...scope, admission.id, 'investigations'], queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/investigations`, inpatientInvestigationsSchema, signal),
  })) })
  const surgeries = useQueries({ queries: clinicalTargets.map(admission => ({
    queryKey: [...scope, admission.id, 'surgeries'], queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/surgeries`, inpatientSurgerySchema, signal),
  })) })
  const transfers = useQueries({ queries: clinicalTargets.map(admission => ({
    queryKey: [...scope, admission.id, 'transfers'], enabled: allowTransfers,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/transfers`, inpatientTransfersSchema, signal),
  })) })
  const queries = [...clinicals, ...investigations, ...surgeries, ...(allowTransfers ? transfers : [])]
  const loading = queries.some(query => query.isPending) || scenario.isPending
  const error = scenario.error ?? queries.find(query => query.error)?.error ?? null
  const tasks = clinicalTargets.map((admission, index) => {
    const data = clinicals[index]?.data
    if (data === undefined) return null
    const toVerify = data.orders.filter(order => order.state === 'signed' || order.state === 'stop-requested').length
    const toAdminister = data.executions.filter(execution => {
      const order = data.orders.find(order => order.id === execution.orderId)
      return order?.state === 'verified' && virtualMs !== undefined && Date.parse(execution.scheduledFor) <= virtualMs
        && (execution.status === 'dispensed' || execution.status === 'pending' && order.kind === 'service')
    }).length
    const pending = inpatientPending({ admission, role: 'ward-nurse', clinical: data, investigations: investigations[index]?.data,
      surgery: surgeries[index]?.data, transfers: transfers[index]?.data, virtualTime: scenario.data?.virtualTime })
    const total = Object.values(pending).reduce((sum, value) => sum + value, 0)
    return total > 0 ? { admission, toVerify, toAdminister, total } : null
  }).filter(task => task !== null)

  const wards = catalog?.wards ?? []
  const beds = catalog?.beds ?? []

  return <div className="flex flex-col gap-4" data-inpatient-nurse-queue aria-label={t('本病区', 'My ward')}>
    <header className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-sm font-semibold">{t('床位与任务', 'Beds and tasks')}</h3>
      <p className="font-mono text-xs text-muted-foreground">
        {scenario.data !== undefined ? new Date(scenario.data.virtualTime).toLocaleString(zh ? 'zh-CN' : 'en-US', { timeZone: 'Asia/Shanghai' }) : t('正在读取当前时间', 'Loading current time')}
      </p>
    </header>
    {error !== null ? <div role="alert" className="text-sm text-destructive">{t('待办读取失败：', 'Unable to load ward tasks: ')}{getWorkspaceErrorMessage(error, messages)}<Button variant="outline" size="sm" onClick={() => { void scenario.refetch(); void Promise.all(queries.map(query => query.refetch())) }}>{t('重试', 'Retry')}</Button></div> : null}

    {registered.length > 0 ? <section aria-label={t('新入院', 'New admissions')} className="rounded-md border border-border px-3 py-2">
      <p className="text-sm">{t('新入院：', 'New admissions: ')}</p>
      <div data-inpatient-queue-items>
        {registered.map(admission => <Button key={admission.id} variant="link" className="h-auto justify-start whitespace-normal px-1 text-start font-mono" onClick={() => onSelect(admission.id)}>
          {admission.patientName}（{admission.inpatientNumber}）
        </Button>)}
      </div>
      <p className="text-sm">{t('点击接诊并分床', 'Select to admit and assign a bed')}</p>
    </section> : null}

    {wards.map(ward => {
      const wardBeds = beds.filter(bed => bed.wardId === ward.id)
      return <section key={ward.id} aria-label={ward.name} className="border border-border bg-card">
        <h3 className="border-b border-border px-3 py-2 text-sm font-semibold">{ward.name}</h3>
        {wardBeds.length === 0 ? <p className="px-3 py-3 text-sm text-muted-foreground">{t('该病区暂无床位', 'No beds in this ward')}</p> : <ul data-inpatient-queue-items className="flex flex-col gap-px bg-border">
          {wardBeds.map(bed => {
            const admission = bed.admissionId !== undefined ? byId.get(bed.admissionId) : undefined
            const day = admission !== undefined ? dayOf(admission) : undefined
            const task = tasks.find(task => task.admission.id === admission?.id)
            const index = clinicalTargets.findIndex(item => item.id === admission?.id)
            const ready = index < 0 || !!clinicals[index]?.data && !!investigations[index]?.data && !!surgeries[index]?.data && !!scenario.data
            const pending = task?.total ?? (admission === undefined ? 0
              : Object.values(inpatientPending({ admission, role: 'ward-nurse' })).reduce((sum, value) => sum + value, 0))
            return <li key={bed.id} className="bg-card">
              {admission !== undefined
                ? <button type="button" onClick={() => onSelect(admission.id)} className="flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-secondary focus-visible:outline-ring" aria-label={`${bed.name} ${admission.patientName}`}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{bed.name}</span>
                    <span className="border border-border px-1 text-xs">{inpatientStatus(admission, locale)}</span>
                  </span>
                  <span className="text-sm font-medium">{admission.patientName}</span>
                  <span className="text-xs text-info">{ready ? t(`轮到你 ${pending} 项`, `${pending} tasks for you`) : t('正在读取待办', 'Loading tasks')}</span>
                  {day !== undefined ? <span className="font-mono text-xs text-muted-foreground">{t(`住院第 ${day} 天`, `Day ${day}`)}</span> : null}
                </button>
                : <div className="flex flex-col gap-1 px-3 py-2 opacity-70">
                  <span className="font-mono text-xs text-muted-foreground">{bed.name}</span>
                  <span className="text-sm">{t('空床', 'Empty bed')}</span>
                  <span className="font-mono text-xs text-muted-foreground">{formatFen(bed.dailyPriceFen, locale)}/{t('天', 'day')}</span>
                </div>}
            </li>
          })}
        </ul>}
      </section>
    })}
    {catalog === undefined ? <p className="text-sm text-muted-foreground">{t('正在加载病区目录', 'Loading ward catalog')}</p> : null}

    {departedOpen.length > 0 ? <section aria-label={t('召回窗口', 'Recall window')} className="border border-warning/60 bg-warning/5 px-3 py-2">
      <h3 className="text-sm font-semibold">{t('召回窗口（离院未结算，原床保留）', 'Recall window (departed, unsettled, bed held)')}</h3>
      <ul data-inpatient-queue-items className="mt-1 text-sm">
        {departedOpen.map(admission => <li key={admission.id}>
          <span className="font-medium">{admission.patientName}</span>
          <span className="font-mono text-muted-foreground"> · {admission.inpatientNumber}</span>
          {t(' —— 已出院待结算；点击上方床位格进入，召回由住院医生在患者页执行。', ' — departed and unsettled; use the bed card above to open the chart, recall is executed by the physician.')}
        </li>)}
      </ul>
    </section> : null}

    {discharged.length > 0 ? <section aria-label={t('出院后病历', 'Post-discharge records')} className="border border-border bg-card">
      <h3 className="border-b border-border px-3 py-2 text-sm font-semibold">{t('出院后病历（只读回查）', 'Post-discharge records (read only)')}</h3>
      <ul data-inpatient-queue-items className="divide-y divide-border">
        {discharged.map(admission => <li key={admission.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
          <Button variant="link" className="h-auto px-0 font-medium" onClick={() => onSelect(admission.id)}>{admission.patientName}</Button>
          <span className="font-mono text-xs text-muted-foreground">{admission.inpatientNumber}</span>
          <span className="ml-auto border border-border px-1 text-xs text-muted-foreground">{inpatientStatus(admission, locale)}</span>
        </li>)}
      </ul>
    </section> : null}

    <section aria-label={t('本班医嘱任务', 'Shift medication tasks')} className="border border-border bg-card">
      <h3 className="border-b border-border px-3 py-2 text-sm font-semibold">{t('本班医嘱任务', 'Shift medication tasks')}</h3>
      {loading ? <Skeleton className="h-16 w-full" /> : tasks.length === 0 ? <p className="px-3 py-3 text-sm text-muted-foreground">{t('本班暂无待校对或待执行任务', 'No orders awaiting verification or administration this shift')}</p> : <ul data-inpatient-queue-items className="divide-y divide-border">
        {tasks.map(task => <li key={task.admission.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="text-sm font-medium">{task.admission.patientName}</span>
          <span className="font-mono text-xs text-muted-foreground">{task.admission.inpatientNumber}</span>
          <span className="text-xs">{t(`轮到你 ${task.total} 项`, `${task.total} tasks for you`)}</span>
          {task.toVerify > 0 ? <span className="border border-warning px-1 text-xs text-warning">{t(`待校对 ${task.toVerify}`, `${task.toVerify} to verify`)}</span> : null}
          {task.toAdminister > 0 ? <span className="border border-destructive px-1 text-xs text-destructive">{t(`待执行/给药 ${task.toAdminister}`, `${task.toAdminister} to administer`)}</span> : null}
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => onSelect(task.admission.id)}>{t('去处理', 'Open')}</Button>
        </li>)}
      </ul>}
    </section>
  </div>
}
