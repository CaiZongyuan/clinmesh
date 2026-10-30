import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientPciDataSchema, pciCaseSourceResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
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
  const source = useQuery({ queryKey: sourceKey, queryFn: () => Promise.resolve(null), enabled: false,
    select: value => value === null ? null : pciCaseSourceResponseSchema.parse(value).data })
  const catalog = useQuery({ queryKey: catalogKey,
    queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/pci-data', inpatientPciDataSchema, signal) })
  const write = useInpatientWriteIntent(session, async (command, response) => {
    if (command.operation === 'admin.pci-case.prepare') {
      const prepared = pciCaseSourceResponseSchema.parse(response)
      client.setQueryData(sourceKey, prepared)
      await onSourcePrepared(prepared.data.profileId)
    } else if (command.operation === 'inpatient.pci-data.prepare') {
      await client.invalidateQueries({ queryKey: catalogKey })
    }
  })
  const error = write.storageFailure ?? write.mutation.error
  const prepare = (operation: 'admin.pci-case.prepare' | 'inpatient.pci-data.prepare') => write.mutation.mutate({
    operation, input: { expectedEpoch: session.actor.epoch },
  })
  const installed = catalog.data?.installed
  const definition = catalog.data?.package
  const conflicts = installed?.medications.filter(item => item.conflicts.length > 0) ?? []
  const pendingPreparation = write.pending?.command.operation === 'admin.pci-case.prepare'
    || write.pending?.command.operation === 'inpatient.pci-data.prepare'
  const ready = installed !== undefined && definition !== undefined && conflicts.length === 0
    && installed.medications.length === definition.medications.length
    && installed.laboratories.length === definition.laboratories.length
    && installed.materialIds.length === definition.materials.length
  return <section aria-label={zh ? 'PCI 演示准备' : 'PCI demonstration preparation'} className="flex min-w-0 flex-col gap-3">
    <h3 className="font-semibold">{zh ? 'PCI 演示准备' : 'PCI demonstration preparation'}</h3>
    <p className="text-sm text-muted-foreground">{zh ? '准备目录与固定病例后，患者档案自动就绪并选用，可交给登记员办理直接住院、护士接诊分床。重复准备保留已有修订与就诊绑定。' : 'Prepare the catalog and fixed case to select a ready patient persona, then continue with registrar admission and nurse bed assignment. Preparing again retains existing revisions and visit bindings.'}</p>
    <div className="flex flex-wrap gap-2">
      <Button disabled={write.blocked} onClick={() => prepare('inpatient.pci-data.prepare')} type="button" variant="outline">{zh ? '准备 PCI 目录' : 'Prepare PCI catalog'}</Button>
      <Button disabled={write.blocked} onClick={() => prepare('admin.pci-case.prepare')} type="button" variant="outline">{zh ? '准备固定 PCI 病例' : 'Prepare fixed PCI case'}</Button>
      <Button disabled={catalog.isFetching} onClick={() => void catalog.refetch()} type="button" variant="ghost">{zh ? '刷新准备状态' : 'Refresh readiness'}</Button>
    </div>
    {write.mutation.isPending ? <p role="status" className="text-sm">{zh ? '正在准备，请稍候…' : 'Preparing; please wait…'}</p> : null}
    {catalog.isPending ? <Skeleton className="h-10 w-full" /> : null}
    {catalog.error ? <Alert variant="destructive"><AlertTitle>{zh ? '目录资料未就绪' : 'Catalog unavailable'}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(catalog.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    {installed && definition ? <p role="status" className="text-sm">{ready ? (zh ? '目录已准备' : 'Catalog ready') : (zh ? '目录未就绪' : 'Catalog not ready')}：{installed.medications.length}/{definition.medications.length} {zh ? '药品' : 'medications'}，{installed.laboratories.length}/{definition.laboratories.length} {zh ? '检验' : 'laboratories'}，{installed.materialIds.length}/{definition.materials.length} {zh ? '耗材' : 'materials'} · {definition.version}</p> : null}
    {conflicts.length > 0 ? <Alert variant="destructive"><AlertTitle>{zh ? '目录存在限制' : 'Catalog restrictions'}</AlertTitle><AlertDescription>{zh ? '部分药品的启用范围、价格或使用限制尚不满足病例要求，请到目录维护核对。重复准备会保留现有限制。' : 'Some medications need catalog review for scope, pricing or usage restrictions. Preparing again retains existing restrictions.'}</AlertDescription></Alert> : null}
    {source.data ? <p role="status" className="break-all text-sm">{source.data.case.status === 'brief-ready'
      ? (zh ? '患者档案已就绪，可办理入院' : 'Patient persona ready for admission')
      : source.data.case.status === 'brief-pending'
        ? (zh ? '病例来源已准备，请重新准备以完成患者档案' : 'Case source prepared; prepare again to complete the persona')
        : (zh ? '病例已开始就诊，保留原就诊绑定' : 'Visit already started; original binding retained')}
      {' · '}{source.data.case.caseId} · Profile {source.data.profileId} / {source.data.case.profileRevision} · Persona {source.data.case.activeBriefRevision ?? '—'} · {source.data.packageVersion}</p> : null}
    {pendingPreparation && !write.mutation.isPending ? <Alert role="region" aria-label={zh ? '待确认准备操作' : 'Pending preparation'}><AlertDescription><p>{zh ? '原操作结果待确认，请先恢复，再继续准备。' : 'Recover the original operation before preparing again.'}</p><Button onClick={() => write.mutation.mutate(undefined)} type="button" variant="outline">{zh ? '恢复原准备操作' : 'Recover preparation'}</Button></AlertDescription></Alert> : null}
    {error ? <Alert variant="destructive"><AlertTitle>{zh ? '准备失败' : 'Preparation failed'}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(error, getWorkspaceMessages(locale))} {zh ? '若数据世代或版本已变化，请刷新页面后重新核对。' : 'Refresh and review if the epoch or revision has changed.'}</AlertDescription></Alert> : null}
  </section>
}
