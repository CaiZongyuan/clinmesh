import { useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { encodeModelRoute, modelRouteSchema } from '@clinmesh/contracts/model-bridge'
import { normalizeHostLocale, type ClientLocalePort } from './host-locale.ts'

export interface ModelSettingsRemote {
  $on?: (event: string, listener: () => void) => () => void
  settings: {
    describe(): Promise<unknown>
    update(namespace: string, patch: { generationModel: string }, revision: number): Promise<unknown>
  }
  session: { modelCatalog(): Promise<unknown> }
}

const settingsSchema = z.object({
  writable: z.boolean(),
  namespaces: z.array(z.object({ ns: z.string(), revision: z.number().int(), value: z.unknown() })),
})
const catalogSchema = z.object({
  default: modelRouteSchema,
  groups: z.array(z.object({ id: z.string(), name: z.string(), models: z.array(z.object({ id: z.string(), name: z.string() })) })),
  failures: z.array(z.object({ id: z.string() })),
})
const queryKey = ['clinmesh-model-settings'] as const
const hostResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.unknown() }),
])
function hostValue(response: unknown): unknown {
  const result = hostResultSchema.parse(response)
  if (!result.ok) throw new Error('The host refused the model settings request')
  return result.value
}

export function ModelSetting({ remote, language }: { remote: ModelSettingsRemote; language: 'zh-CN' | 'en-US' }) {
  const chinese = language === 'zh-CN'
  const client = useQueryClient()
  const state = useQuery({ queryKey, retry: false, queryFn: async () => {
    const [rawSettings, rawCatalog] = await Promise.all([remote.settings.describe(), remote.session.modelCatalog()])
    const settings = settingsSchema.parse(hostValue(rawSettings))
    const namespace = settings.namespaces.find(item => item.ns === 'clinmesh-dsh-web')
    if (namespace === undefined) throw new Error('ClinMesh settings are unavailable')
    return { writable: settings.writable, revision: namespace.revision,
      selected: z.object({ generationModel: z.string() }).parse(namespace.value).generationModel,
      catalog: catalogSchema.parse(hostValue(rawCatalog)) }
  } })
  const save = useMutation({ mutationFn: async (generationModel: string) => {
    if (state.data === undefined) throw new Error('Load settings first')
    hostValue(await remote.settings.update('clinmesh-dsh-web', { generationModel }, state.data.revision))
    await client.invalidateQueries({ queryKey })
  } })
  const models = state.data?.catalog.groups.flatMap(group => group.models.map(model => ({
    value: encodeModelRoute({ provider: group.id, model: model.id }), label: `${group.name} · ${model.name}`,
  }))) ?? []
  const selected = state.data?.selected ?? 'default'
  const missing = selected !== 'default' && !models.some(model => model.value === selected)
  const label = chinese ? 'ClinMesh 模型' : 'ClinMesh model'
  const fallback = chinese ? '使用 DSH 默认模型' : 'Use DSH default model'
  return (
    <div style={{ padding: '16px 0', borderBottom: '.5px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-primary)', fontSize: 14, lineHeight: '22px' }}>
      <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <span>{label}</span>
        <select aria-label={label} value={selected}
          disabled={state.data === undefined || !state.data.writable || save.isPending || state.isFetching}
          onChange={event => save.mutate(event.target.value)}
          style={{ maxWidth: '100%', minWidth: 180, borderRadius: 8, padding: 8, font: 'inherit', color: 'inherit', background: 'var(--dsw-alias-bg-module-platform)', border: '.5px solid var(--dsw-alias-border-l3)' }}>
          <option value="default">{fallback}</option>
          {missing ? <option value={selected}>{chinese ? '已选模型不可用' : 'Selected model unavailable'}</option> : null}
          {models.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}
        </select>
      </label>
      <p style={{ margin: '8px 0', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }}>
        {chinese ? '用于患者档案、问诊回答、检验结果生成和检验目录补全。新请求和新的人工重试使用新模型，执行中和排队任务保持原模型。' : 'Used for patient personas, patient replies, laboratory result generation and laboratory catalog enrichment. New requests and new manual retries use the new model; active and queued tasks keep their original model.'}
      </p>
      {selected === 'default' && state.data ? <p style={{ margin: '4px 0', fontSize: 12 }}>
        {`${state.data.catalog.default.provider} · ${state.data.catalog.default.model}`}
      </p> : null}
      <div role="status" aria-live="polite" style={{ fontSize: 12 }}>
        {state.isPending ? chinese ? '正在加载模型…' : 'Loading models…' : null}
        {save.isPending ? chinese ? '正在保存…' : 'Saving…' : null}
        {save.isSuccess ? chinese ? '已保存' : 'Saved' : null}
        {state.data && models.length === 0 ? chinese ? '暂无可用模型，请先在 DSH 模型设置中配置 Provider。' : 'No models available. Configure a provider in DSH model settings.' : null}
        {state.data && !state.data.writable ? chinese ? '当前配置只读。' : 'This profile is read-only.' : null}
      </div>
      {state.isError || save.isError || missing || (state.data?.catalog.failures.length ?? 0) > 0 ? <p role="alert" style={{ fontSize: 12 }}>
        {chinese ? '模型或设置暂不可用，请刷新并检查 DSH 模型配置后重试。' : 'Models or settings are unavailable. Refresh and check DSH model settings before retrying.'}
      </p> : null}
      <button type="button" disabled={state.isFetching || save.isPending} onClick={() => { save.reset(); void state.refetch() }}
        style={{ font: 'inherit', fontSize: 12, color: 'inherit', background: 'transparent', border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: 6, padding: '4px 10px', marginTop: 8 }}>
        {chinese ? '刷新模型' : 'Refresh models'}
      </button>
    </div>
  )
}

export function registerModelSettings(ctx: Context): () => void {
  const locale = ctx.get('locale') as unknown as ClientLocalePort
  const remote = ctx.get('remote') as unknown as ModelSettingsRemote
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000 } } })
  const subscribe = (listener: () => void) => locale.subscribe(listener)
  const snapshot = () => normalizeHostLocale(locale.getLocale().active)
  function Setting() {
    const language = useSyncExternalStore(subscribe, snapshot, snapshot)
    return <QueryClientProvider client={client}><ModelSetting remote={remote} language={language} /></QueryClientProvider>
  }
  const dispose = ctx.slots.inject('settings.general.item', () => ctx.slots.register(
    { name: 'settings.general.item', id: 'clinmesh.model', order: 10.6 }, Setting,
  ))
  const refresh = () => { void client.invalidateQueries({ queryKey }) }
  const unsubscribe = remote?.$on?.('settings/document-updated', refresh)
  const reconnect = (ctx as unknown as { on?: (event: string, listener: () => void) => () => void }).on?.('connection/reset', refresh)
  return () => { dispose(); unsubscribe?.(); reconnect?.(); client.clear() }
}
