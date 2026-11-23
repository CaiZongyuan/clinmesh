import type { SessionContext } from '@clinmesh/contracts/his'
import { Button } from '@clinmesh/ui/components/button'
import { Input } from '@clinmesh/ui/components/input'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { newIdempotencyKey } from './api-client.ts'
import { configurePathologyReading, getPathologyReadingStatus } from './pathology-reading-api.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { pathologyAdministratorScope } from './pathology-case-pack-preparation.tsx'

const labels = {
  'not-configured': ['未配置', 'Not configured'], disabled: ['已停用', 'Disabled'], ready: ['已连接', 'Connected'],
  offline: ['连接不可用', 'Offline'], incompatible: ['协议不兼容', 'Incompatible protocol'],
  'credentials-unavailable': ['连接凭据不可用', 'Connection credentials unavailable'], 'repair-required': ['需要修复', 'Repair required'],
} as const

export function PathologyReadingSettings({ locale, session }: { locale: WorkspaceLocale; session: SessionContext }) {
  return <ScopedPathologyReadingSettings key={JSON.stringify(pathologyAdministratorScope(session))} locale={locale} session={session} />
}

function ScopedPathologyReadingSettings({ locale, session }: { locale: WorkspaceLocale; session: SessionContext }) {
  const zh = locale === 'zh-CN', queryClient = useQueryClient()
  const key = ['administrator-pathology-reading', ...pathologyAdministratorScope(session)]
  const [open, setOpen] = useState(false)
  const status = useQuery({ enabled: open, queryKey: key, queryFn: ({ signal }) => getPathologyReadingStatus(signal) })
  const [endpoint, setEndpoint] = useState(''), [viewerOrigin, setViewerOrigin] = useState(''), [instanceId, setInstanceId] = useState('')
  useEffect(() => {
    setEndpoint(status.data?.config?.endpoint ?? ''); setViewerOrigin(status.data?.config?.viewerOrigin ?? ''); setInstanceId(status.data?.config?.instanceId ?? '')
  }, [status.data?.config])
  const save = useMutation({ mutationFn: (enabled: boolean) => {
    const saved = status.data?.config
    if (!enabled) {
      if (!saved) throw new Error('The saved reading configuration is unavailable')
      return configurePathologyReading({ endpoint: saved.endpoint, viewerOrigin: saved.viewerOrigin,
        instanceId: saved.instanceId, expectedVersion: saved.version, enabled: false }, newIdempotencyKey())
    }
    return configurePathologyReading({ endpoint, viewerOrigin, instanceId, expectedVersion: saved?.version ?? 0, enabled: true }, newIdempotencyKey())
  },
  onSuccess: async config => {
    await queryClient.cancelQueries({ queryKey: key })
    queryClient.setQueryData<Awaited<ReturnType<typeof getPathologyReadingStatus>>>(key, {
      state: config.enabled ? 'offline' : 'disabled', config, capabilities: [],
    })
    await queryClient.invalidateQueries({ queryKey: key })
    await queryClient.invalidateQueries({ queryKey: ['administrator-pathology'] })
  } })
  return <details className="rounded-lg border p-3" onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm font-medium">{zh ? '病理阅片服务' : 'Pathology reading service'}
    {status.data ? ` · ${labels[status.data.state][zh ? 0 : 1]}` : ''}</summary>
    <div className="mt-3 space-y-3 text-sm">
      {status.isError && !save.isSuccess ? <p role="alert">{zh ? '无法读取阅片服务状态' : 'Unable to read the service status'}</p> : null}
      {save.isSuccess ? <p role="status">{zh ? '已保存' : 'Saved'}</p> : null}
      <label className="block">{zh ? '服务实例标识' : 'Service instance'}<Input value={instanceId} onChange={event => setInstanceId(event.target.value)} disabled={save.isPending} /></label>
      <label className="block">{zh ? '服务地址' : 'Service address'}<Input type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} disabled={save.isPending} /></label>
      <label className="block">{zh ? '阅片页面地址' : 'Viewer origin'}<Input type="url" value={viewerOrigin} onChange={event => setViewerOrigin(event.target.value)} disabled={save.isPending} /></label>
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={save.isPending || !endpoint || !viewerOrigin || !instanceId} onClick={() => save.mutate(true)}>{zh ? '保存并启用' : 'Save and enable'}</Button>
        <Button size="sm" variant="outline" disabled={save.isPending || !status.data?.config?.enabled} onClick={() => save.mutate(false)}>{zh ? '停用' : 'Disable'}</Button>
        <Button size="sm" variant="outline" disabled={status.isFetching} onClick={() => { save.reset(); void status.refetch() }}>{zh ? '检查连接' : 'Check connection'}</Button></div>
      {save.isError ? <p role="alert">{zh ? '配置未保存，请核对地址、部署授权和当前版本后重试。' : 'Configuration was not saved. Check the address, deployment authorization and current version.'}</p> : null}
      {status.data?.capabilities.map(capability => <article className="border-t pt-2" key={`${capability.taskCode}:${capability.modelVersion}`}>
        <p>{capability.taskCode} · {capability.modelVersion} · {capability.available ? (zh ? '可用' : 'Available') : (zh ? '不可用' : 'Unavailable')}</p>
        {capability.limitations.map(item => <p className="text-xs text-muted-foreground" key={item}>{item}</p>)}
      </article>)}
    </div>
  </details>
}
