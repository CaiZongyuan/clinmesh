import { InpatientQueueGroup } from './inpatient-layout.tsx'
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
import { InpatientNumberTail } from './inpatient-number.tsx'

type Catalog = z.infer<typeof inpatientCatalogSchema>

// 护士站一览板：床位格、待接诊、召回窗口与本班医嘱任务，全部来自既有查询，不新增端点。
export function InpatientNurseBench({ admissions, catalog, session, locale, onSelect, selectedId, allowTransfers = false }: {
  admissions: InpatientAdmission[]
  catalog: Catalog | undefined
  session: SessionContext
  locale: WorkspaceLocale
  onSelect: (admissionId: string) => void
  selectedId?: string | undefined
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
  const error = scenario.error ?? queries.find(query => query.error)?.error ?? null
  const tasks = clinicalTargets.map((admission, index) => {
    const data = clinicals[index]?.data
    if (data === undefined) return null
    const pending = inpatientPending({ admission, role: 'ward-nurse', clinical: data, investigations: investigations[index]?.data,
      surgery: surgeries[index]?.data, transfers: transfers[index]?.data, virtualTime: scenario.data?.virtualTime })
    const total = Object.values(pending).reduce((sum, value) => sum + value, 0)
    return total > 0 ? { admission, total } : null
  }).filter(task => task !== null)

  const wards = catalog?.wards ?? []
  const beds = (catalog?.beds ?? []).toSorted((a, b) => a.name.localeCompare(b.name, locale, { numeric: true }))

  return <div className="clinmesh-inpatient-nurse-queue flex min-h-0 flex-1 flex-col" aria-label={t('本病区', 'My ward')}>
    <div className="clinmesh-inpatient-nurse-queue-items">
    {error !== null ? <div role="alert" className="text-sm text-destructive">{t('待办读取失败：', 'Unable to load ward tasks: ')}{getWorkspaceErrorMessage(error, messages)}<Button variant="outline" size="sm" onClick={() => { void scenario.refetch(); void Promise.all(queries.map(query => query.refetch())) }}>{t('重试', 'Retry')}</Button></div> : null}

    {registered.length > 0 ? <InpatientQueueGroup title={t('新入院', 'New admissions')} count={registered.length}>
      <div data-inpatient-queue-items>
        {registered.map(admission => <Button key={admission.id} variant="link" className="h-auto justify-start whitespace-normal px-1 text-start" onClick={() => onSelect(admission.id)}>
          {admission.patientName}（<InpatientNumberTail locale={locale} number={admission.inpatientNumber} />）
        </Button>)}
      </div>
    </InpatientQueueGroup> : null}

    {wards.map(ward => {
      const wardBeds = beds.filter(bed => bed.wardId === ward.id)
      return <InpatientQueueGroup key={ward.id} title={wards.length > 1 ? `${t('床位', 'Beds')} · ${ward.name}` : t('床位', 'Beds')} count={wardBeds.length}>
        <section aria-label={ward.name}>
        {wardBeds.length === 0 ? <p className="px-3 py-3 text-sm text-muted-foreground">{t('该病区暂无床位', 'No beds in this ward')}</p> : <ul data-inpatient-queue-items className="clinmesh-inpatient-bed-list">
          {wardBeds.map(bed => {
            const admission = bed.admissionId !== undefined ? byId.get(bed.admissionId) : undefined
            const day = admission !== undefined ? dayOf(admission) : undefined
            const task = tasks.find(task => task.admission.id === admission?.id)
            const index = clinicalTargets.findIndex(item => item.id === admission?.id)
            const ready = index < 0 || !!clinicals[index]?.data && !!investigations[index]?.data && !!surgeries[index]?.data && !!scenario.data
            const pending = task?.total ?? (admission === undefined ? 0
              : Object.values(inpatientPending({ admission, role: 'ward-nurse' })).reduce((sum, value) => sum + value, 0))
            return <li key={bed.id}>
              {admission !== undefined
                ? <button type="button" onClick={() => onSelect(admission.id)} className="clinmesh-inpatient-bed-row" aria-description={ready && pending > 0 ? t(`待办 ${pending} 项`, `${pending} pending tasks`) : undefined} aria-current={selectedId === admission.id ? 'true' : undefined} aria-label={`${bed.name} ${admission.patientName}`}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{bed.name} {admission.patientName}</span>
                    <span className={ready && pending > 0 ? 'text-xs font-medium text-info' : 'text-xs text-muted-foreground'}>{!ready ? t('正在读取待办', 'Loading tasks') : admission.status === 'departed' && admission.financialStatus === 'settled' ? t('清床', 'Clear bed') : pending > 0 ? t(`轮到你 ${pending} 项`, `${pending} tasks for you`) : inpatientStatus(admission, locale)}</span>
                  </span>
                  {day !== undefined ? <span className="text-xs text-muted-foreground">{t(`住院第 ${day} 天`, `Day ${day}`)}</span> : null}
                </button>
                : <div className="clinmesh-inpatient-bed-empty"><span>{bed.name} <span>{t('空床', 'Empty bed')}</span></span><span className="tabular-nums">{formatFen(bed.dailyPriceFen, locale)}/{t('天', 'day')}</span></div>}
            </li>
          })}
        </ul>}
        </section>
      </InpatientQueueGroup>
    })}
    {catalog === undefined ? <p className="text-sm text-muted-foreground">{t('正在加载病区目录', 'Loading ward catalog')}</p> : null}

    </div>
    <div className="clinmesh-inpatient-queue-footer">
      <details><summary className="flex cursor-pointer justify-between text-sm">{t('召回窗口', 'Recall window')}<span className="tabular-nums">{departedOpen.length}</span></summary>
        <section aria-label={t('召回窗口', 'Recall window')} className="flex flex-col gap-1 pt-2" data-inpatient-queue-items><p className="text-xs text-muted-foreground">{t('离院未结算，原床保留；召回由住院医生办理。', 'Departed and unsettled; the original bed is held. The inpatient doctor recalls the admission.')}</p>
          {departedOpen.map(admission => <Button key={admission.id} variant="ghost" className="justify-start" onClick={() => onSelect(admission.id)}>{admission.patientName}</Button>)}
        </section>
      </details>
      <details><summary className="flex cursor-pointer justify-between text-sm">{t('出院后病历', 'Post-discharge records')}<span className="tabular-nums">{discharged.length}</span></summary>
        <section aria-label={t('出院后病历', 'Post-discharge records')} className="flex flex-col gap-1 pt-2" data-inpatient-queue-items>
          {discharged.map(admission => <Button key={admission.id} variant="ghost" className="h-auto justify-start whitespace-normal" onClick={() => onSelect(admission.id)}>{admission.patientName} · <InpatientNumberTail locale={locale} number={admission.inpatientNumber} /></Button>)}
        </section>
      </details>
    </div>
  </div>
}
