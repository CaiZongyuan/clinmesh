import { inpatientPharmacyListSchema, inpatientPharmacySchema } from '@clinmesh/contracts/inpatient-clinical'
import { scenarioStateSchema, type SessionContext } from '@clinmesh/contracts/his'
import type { z } from 'zod'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiGet } from './api-client.ts'
import { DAY_MS } from './inpatient-scope.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import { WorkspaceModeSwitch } from './workspace-mode.tsx'

type PharmacyAdmissionStatus = z.infer<typeof inpatientPharmacyListSchema>['items'][number]['status']
// 临期提示仅做展示（warn 语义色），不改变发药门禁；以虚拟时间判断，虚拟时间不可读时静默降级。
const NEAR_EXPIRY_DAYS = 30

export function InpatientPharmacy({ session, locale }: { session: SessionContext; locale: WorkspaceLocale }): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const scope = ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId]
  const [selectedId, setSelectedId] = useState<string>(), [lotIds, setLotIds] = useState<Record<string, string>>({})
  const client = useQueryClient()
  const write = useInpatientWriteIntent(session, async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
  const admissions = useQuery({ queryKey: [...scope, 'pharmacy-list'], queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/pharmacy/admissions', inpatientPharmacyListSchema, signal) })
  const pharmacy = useQuery({ queryKey: [...scope, selectedId, 'pharmacy'], enabled: selectedId !== undefined,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${selectedId}/pharmacy`, inpatientPharmacySchema, signal) })
  // 与住院详情共用同一虚拟时间缓存；仅用于临期批次提示，读取失败不提示错误。
  const scenario = useQuery({ queryKey: ['scenario', 'virtual-time'], queryFn: ({ signal }) => apiGet('/api/sim/v1/scenario-runs/current', scenarioStateSchema, signal), retry: false })
  const virtualNow = scenario.data !== undefined ? Date.parse(scenario.data.virtualTime) : undefined
  const data = pharmacy.data, error = admissions.error ?? pharmacy.error ?? write.storageFailure ?? write.mutation.error
  const statusText = (status: PharmacyAdmissionStatus) => ({ registered: t('待入科', 'Registered'), admitted: t('在院', 'Admitted'), 'discharge-pending': t('待出院', 'Discharge pending'), departed: t('已出区', 'Departed'), cleared: t('已清床', 'Cleared') }[status])
  return <section aria-label={t('住院药房', 'Inpatient pharmacy')} className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <div className="shrink-0 px-4">
    <WorkspaceModeSwitch />
    {error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    <InpatientWriteRecovery write={write} locale={locale} />
    {write.mutation.isSuccess && write.mutation.data?.command?.operation === 'inpatient.execution.dispense' && write.mutation.data.command.input.admissionId === selectedId ? <p role="status">{t('操作成功', 'Operation completed')}</p> : null}
    </div><div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2">
    {selectedId ? <Button variant="outline" onClick={() => setSelectedId(undefined)}>{t('返回住院患者', 'Back to admissions')}</Button> : null}
    <Button variant="outline" onClick={() => void client.invalidateQueries({ queryKey: ['inpatient'] })}>{t('刷新药房记录', 'Refresh pharmacy')}</Button>
    {selectedId ? <Field orientation="horizontal" className="w-auto min-w-0 flex-1"><FieldLabel htmlFor="inpatient-pharmacy-switch">{t('切换住院患者', 'Switch patient')}</FieldLabel><WorkspaceSelect id="inpatient-pharmacy-switch" value={selectedId} items={(admissions.data?.items ?? []).map(item => ({ value: item.admissionId, label: `${item.patientName} · ${item.inpatientNumber}` }))} onValueChange={value => { if (value) { setSelectedId(value); setLotIds({}) } }} /></Field> : null}</div>
    {!selectedId ? <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
    <div className="flex flex-col gap-1">
      <h2 className="font-bold">{t('住院发药队列', 'Inpatient dispensing queue')}</h2>
      <p className="text-sm text-muted-foreground">{t('护士校对通过后进入此队列；仅已校验医嘱可发药，发药后护士站给药解锁。', 'Verified orders enter this queue. Only verified orders can be dispensed; dispensing unlocks nurse administration.')}</p>
    </div>
    <div className="flex flex-col gap-2">
    {admissions.data?.items.map(admission => <div key={admission.admissionId} className="flex items-center gap-3 rounded-md border bg-card px-3 py-2">
      <div className="min-w-0 flex-1"><p className="truncate font-semibold">{admission.patientName}</p><p className="font-mono text-xs text-muted-foreground">{admission.inpatientNumber}</p></div>
      <Badge variant={admission.status === 'admitted' ? 'secondary' : 'outline'}>{statusText(admission.status)}</Badge>
      <Button variant="outline" aria-label={`${t('查看', 'View ')}${admission.patientName}`} onClick={() => { setSelectedId(admission.admissionId); setLotIds({}) }}>{t('查看', 'View')}</Button></div>)}
    </div>
    {admissions.data?.items.length === 0 ? <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{t('暂无住院药品医嘱', 'No inpatient medication orders')}</p> : null}
    </div> : null}
    {data && data.admission.admissionId === selectedId ? <>
      <section aria-label={t('当前住院患者', 'Current inpatient')} className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-background px-4 py-3"><h2 className="font-semibold">{data.admission.patientName}</h2><Badge variant="outline"><span className="font-mono">{t('住院号 ', 'Inpatient number ')}{data.admission.inpatientNumber}</span></Badge><Badge variant="secondary">{statusText(data.admission.status)}</Badge></section>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"><div className="flex flex-col gap-1"><h3 className="font-bold">{t('住院发药', 'Inpatient dispensing')}</h3><p className="text-sm text-muted-foreground">{t('负责岗位：药师。护士校对医嘱后方可发药，发药后由护士给药。', 'Responsible: pharmacist. Nurse verification precedes dispensing; the nurse administers dispensed medication.')}</p><p className="text-sm">{t('下一步：病区护士 → 诊断医嘱 → 给药', 'Next: ward nurse → Diagnoses & orders → Administer')}</p></div>
      <p className="text-sm">{t('有效药物过敏风险：', 'Active medication allergies: ')}{data.medicationAllergies.map(item => item.display).join('、') || t('未记录', 'None recorded')}</p>
      {data.executions.map(execution => {
        const order = data.orders.find(item => item.id === execution.orderId)!
        const lots = data.medications.find(item => item.id === order.catalogItemId)?.lots ?? []
        const lot = lots.find(item => item.id === (lotIds[execution.id] ?? lots[0]?.id))
        const valid = !write.blocked && data.admission.status === 'admitted' && order.state === 'verified'
        const expiryMs = lot === undefined ? undefined : Date.parse(lot.expiresOn)
        const nearExpiry = virtualNow !== undefined && !Number.isNaN(virtualNow) && expiryMs !== undefined && !Number.isNaN(expiryMs) && expiryMs - virtualNow <= NEAR_EXPIRY_DAYS * DAY_MS
        return <article key={execution.id} className="flex flex-col gap-2 rounded-md border bg-card p-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><p className="font-medium">{order.display} · {{ pending: t('待执行', 'Pending'), dispensed: t('已发药', 'Dispensed'), completed: t('已完成', 'Completed'), cancelled: t('已取消', 'Cancelled') }[execution.status]}</p>
          <span className="ms-auto font-mono text-xs text-muted-foreground">{new Date(execution.scheduledFor).toLocaleString(zh ? 'zh-CN' : 'en-US', { timeZone: 'Asia/Shanghai' })}</span></div>
          <p className="text-sm text-muted-foreground">{order.doseText} · <span className="font-mono">{order.doseQuantity}{order.unit}</span></p>
          {execution.status === 'pending' ? <>
            <Field><FieldLabel htmlFor={`inpatient-lot-${execution.id}`}>{t('发药批次', 'Inventory lot')}</FieldLabel><WorkspaceSelect id={`inpatient-lot-${execution.id}`} value={lot?.id ?? null}
              items={lots.map(item => ({ value: item.id, label: `${item.id} · ${item.quantityOnHand}${order.unit} · ${item.expiresOn}` }))} onValueChange={value => { if (value) setLotIds(current => ({ ...current, [execution.id]: value })) }} /></Field>
            {lot !== undefined && nearExpiry ? <p className="text-xs text-warning">{t('临期批次', 'Near expiry')} · <span className="font-mono">{lot.expiresOn}</span></p> : null}
            <div><Button disabled={!valid || !lot || lot.quantityOnHand < order.doseQuantity} onClick={() => { if (lot) write.mutation.mutate({ operation: 'inpatient.execution.dispense', input: { admissionId: data.admission.admissionId,
              executionId: execution.id, expectedExecutionVersion: execution.version, lotSelections: [{ lotId: lot.id, expectedVersion: lot.version, quantity: order.doseQuantity }] } }) }}>{t('发药', 'Dispense')}</Button></div>
          </> : null}
        </article>
      })}
    </div></> : null}
  </section>
}
