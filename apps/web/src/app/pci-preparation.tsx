import type { SessionContext } from '@clinmesh/contracts/his'
import {
  authoredCasePackPrepareResponseSchema,
  authoredCasePackSummarySchema,
  inpatientPciDataSchema,
  pciCaseSourceResponseSchema,
} from '@clinmesh/contracts/inpatient-pci-data'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet } from './api-client.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'

export function PciPreparation({ locale, session, onSourcePrepared }: {
  locale: WorkspaceLocale
  session: SessionContext
  onSourcePrepared: (profileId: string) => Promise<void>
}): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const client = useQueryClient()
  const scope = [session.actor.workspaceId, session.actor.epoch]
  const catalogKey = ['pci-catalog-preparation', ...scope]
  const sourceKey = ['pci-source-preparation', ...scope]
  const packKey = ['authored-case-pack', ...scope]
  const source = useQuery({ queryKey: sourceKey, queryFn: () => Promise.resolve(null), enabled: false,
    select: value => value === null ? null : pciCaseSourceResponseSchema.parse(value).data })
  const catalog = useQuery({ queryKey: catalogKey,
    queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/pci-data', inpatientPciDataSchema, signal) })
  const pack = useQuery({ queryKey: packKey,
    queryFn: ({ signal }) => apiGet('/api/sim/v1/synthetic-cases/authored-pack', authoredCasePackSummarySchema, signal) })
  const write = useInpatientWriteIntent(session, async (command, response) => {
    if (command.operation === 'admin.pci-case.prepare') {
      const prepared = pciCaseSourceResponseSchema.parse(response)
      client.setQueryData(sourceKey, prepared)
      await onSourcePrepared(prepared.data.profileId)
    } else if (command.operation === 'inpatient.pci-data.prepare') {
      await client.invalidateQueries({ queryKey: catalogKey })
    } else if (command.operation === 'admin.authored-case-pack.prepare') {
      client.setQueryData(packKey, authoredCasePackPrepareResponseSchema.parse(response).data)
      await client.invalidateQueries({ queryKey: ['synthetic-patient-profiles'] })
    }
  })
  const error = write.storageFailure ?? write.mutation.error
  const prepare = (operation: 'admin.pci-case.prepare' | 'inpatient.pci-data.prepare' | 'admin.authored-case-pack.prepare') =>
    write.mutation.mutate({ operation, input: { expectedEpoch: session.actor.epoch } })
  const installed = catalog.data?.installed
  const definition = catalog.data?.package
  const conflicts = installed?.medications.filter(item => item.conflicts.length > 0) ?? []
  const pendingOp = write.pending?.command.operation
  const pendingPreparation = pendingOp === 'admin.pci-case.prepare'
    || pendingOp === 'inpatient.pci-data.prepare'
    || pendingOp === 'admin.authored-case-pack.prepare'
  const ready = installed !== undefined && definition !== undefined && conflicts.length === 0
    && installed.medications.length === definition.medications.length
    && installed.laboratories.length === definition.laboratories.length
    && installed.materialIds.length === definition.materials.length
  const packCount = pack.data?.totalCount ?? 5
  const statusText = (s?: string) => (s === 'brief-ready' ? (zh ? '已就绪' : 'Ready') : s === 'started' ? (zh ? '已开始' : 'Started') : s === 'completed' ? (zh ? '已完成' : 'Done') : (zh ? '待准备' : 'Pending'))
  const msg = getWorkspaceMessages(locale)
  return <section aria-label={zh ? 'PCI 演示准备' : 'PCI prep'} className="flex min-w-0 flex-col gap-3">
    <h3 className="font-semibold">{zh ? 'PCI 演示准备' : 'PCI prep'}</h3>
    <p className="text-sm text-muted-foreground">{zh ? '准备目录与病例后患者档案自动就绪，重复准备保留已有修订与就诊绑定。' : 'Prepare catalog and cases; repeats keep revisions and bindings.'}</p>
    <div className="flex flex-wrap gap-2">
      <Button disabled={write.blocked} onClick={() => prepare('inpatient.pci-data.prepare')} type="button" variant="outline">{zh ? '准备 PCI 目录' : 'Prepare catalog'}</Button>
      <Button disabled={write.blocked} onClick={() => prepare('admin.pci-case.prepare')} type="button" variant="outline">{zh ? '准备固定 PCI 病例' : 'Prepare PCI case'}</Button>
      <Button disabled={write.blocked} onClick={() => prepare('admin.authored-case-pack.prepare')} type="button" variant="outline">{zh ? `准备专病病例包（${packCount} 例）` : `Prepare pack (${packCount})`}</Button>
      <Button disabled={catalog.isFetching || pack.isFetching} onClick={() => { void catalog.refetch(); void pack.refetch() }} type="button" variant="ghost">{zh ? '刷新准备状态' : 'Refresh'}</Button>
    </div>
    {write.mutation.isPending ? <p role="status" className="text-sm">{zh ? '正在准备，请稍候…' : 'Preparing…'}</p> : null}
    {catalog.isPending ? <Skeleton className="h-10 w-full" /> : null}
    {catalog.error ? <Alert variant="destructive"><AlertTitle>{zh ? '目录资料未就绪' : 'Catalog error'}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(catalog.error, msg)}</AlertDescription></Alert> : null}
    {pack.error ? <Alert variant="destructive"><AlertTitle>{zh ? '专病病例包未就绪' : 'Pack error'}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(pack.error, msg)}</AlertDescription></Alert> : null}
    {installed && definition ? <p role="status" className="text-sm">{ready ? (zh ? '目录已准备' : 'Catalog ready') : (zh ? '目录未就绪' : 'Not ready')}：{installed.medications.length}/{definition.medications.length} {zh ? '药品' : 'meds'}，{installed.laboratories.length}/{definition.laboratories.length} {zh ? '检验' : 'labs'}，{installed.materialIds.length}/{definition.materials.length} {zh ? '耗材' : 'materials'}</p> : null}
    {conflicts.length > 0 ? <Alert variant="destructive"><AlertTitle>{zh ? '目录存在限制' : 'Catalog restrictions'}</AlertTitle><AlertDescription>{zh ? '部分药品配置尚不满足病例要求，请到目录维护核对。' : 'Check medication rules in catalog maintenance.'}</AlertDescription></Alert> : null}
    {source.data ? <p role="status" className="break-all text-sm">{source.data.case.status === 'brief-ready'
      ? (zh ? '患者档案已就绪，可办理入院' : 'Persona ready')
      : source.data.case.status === 'brief-pending'
        ? (zh ? '病例来源已准备，请重新准备以完成患者档案' : 'Prepare again')
        : (zh ? '病例已开始就诊，保留原就诊绑定' : 'Binding retained')}</p> : null}
    {pack.data ? <div className="flex flex-col gap-1.5 rounded-md border p-2.5 text-sm">
      <p role="status" className="font-medium">{zh ? pack.data.name : pack.data.nameEn}：{pack.data.readyCount}/{pack.data.totalCount} {zh ? '已就绪' : 'ready'}</p>
      <ul className="flex flex-col gap-1">
        {pack.data.cases.map(item => <li key={item.draftId} className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="min-w-0 truncate">{zh ? item.title : item.titleEn}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            <Badge variant="outline">{item.recommendedEntry === 'outpatient' ? (zh ? '门诊' : 'OP') : (zh ? '住院' : 'IP')}</Badge>
            <Badge variant={item.case?.status === 'brief-ready' || item.case?.status === 'started' ? 'secondary' : 'outline'}>{statusText(item.case?.status)}</Badge>
          </span>
        </li>)}
      </ul>
    </div> : null}
    {pendingPreparation && !write.mutation.isPending ? <Alert role="region" aria-label={zh ? '待确认准备操作' : 'Pending'}><AlertDescription><p>{zh ? '原操作结果待确认，请先恢复，再继续准备。' : 'Recover original operation first.'}</p><Button onClick={() => write.mutation.mutate(undefined)} type="button" variant="outline">{zh ? '恢复原准备操作' : 'Recover'}</Button></AlertDescription></Alert> : null}
    {error ? <Alert variant="destructive"><AlertTitle>{zh ? '准备失败' : 'Failed'}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(error, msg)} {zh ? '若数据世代或版本已变化，请刷新后重试。' : 'Refresh and retry.'}</AlertDescription></Alert> : null}
  </section>
}
