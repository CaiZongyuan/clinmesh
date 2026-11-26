import { useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import {
  decodeModelRoute,
  encodeModelRoute,
  modelCapabilitiesPath,
  modelCapabilitiesResponseSchema,
  modelReasoningEffortAutoLowest,
  modelReasoningEffortDefault,
  modelRouteSchema,
  type ModelCapabilitiesRequest,
  type ModelCapabilitiesResponse,
  type ModelRoute,
} from '@clinmesh/contracts/model-bridge'
import { normalizeHostLocale, type ClientLocalePort } from './host-locale.ts'

export interface ModelSettingsPatch {
  generationModel: string
  generationReasoningEffort: string
  fastModel: string
  fastReasoningEffort: string
}

export interface ModelSettingsRemote {
  $on?: (event: string, listener: () => void) => () => void
  settings: {
    describe(): Promise<unknown>
    update(namespace: string, patch: ModelSettingsPatch, revision: number): Promise<unknown>
  }
  session: { modelCatalog(): Promise<unknown> }
}

const settingsSchema = z.object({
  writable: z.boolean(),
  namespaces: z.array(z.object({ ns: z.string(), revision: z.number().int(), value: z.unknown() })),
})
const modelSettingsValueSchema = z.object({
  generationModel: z.string().default('default'),
  generationReasoningEffort: z.string().default(modelReasoningEffortDefault),
  fastModel: z.string().default('default'),
  fastReasoningEffort: z.string().default(modelReasoningEffortAutoLowest),
})
const modelSettingsNamespaceSchema = z.object({
  ns: z.literal('clinmesh-dsh-web'),
  revision: z.number().int(),
  value: modelSettingsValueSchema,
})
const catalogSchema = z.object({
  default: modelRouteSchema,
  groups: z.array(z.object({ id: z.string(), name: z.string(), models: z.array(z.object({ id: z.string(), name: z.string() })) })),
  failures: z.array(z.object({ id: z.string() })),
})
const queryKey = ['clinmesh-model-settings'] as const
const capabilitiesQueryPrefix = ['clinmesh-model-capabilities'] as const
const hostResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.unknown() }),
])

function hostValue(response: unknown): unknown {
  const result = hostResultSchema.parse(response)
  if (!result.ok) throw new Error('The host refused the model settings request')
  return result.value
}

function safeDecodeRoute(value: string): ModelRoute | undefined {
  try { return decodeModelRoute(value) } catch { return undefined }
}

async function fetchModelCapabilities(
  request: ModelCapabilitiesRequest,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch | undefined,
): Promise<ModelCapabilitiesResponse> {
  if (typeof fetchImpl !== 'function') return { efforts: [] }
  try {
    const response = await fetchImpl(modelCapabilitiesPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return { efforts: [] }
    return modelCapabilitiesResponseSchema.parse(await response.json())
  } catch (error) {
    if (signal?.aborted) throw error
    return { efforts: [] }
  }
}

const selectStyle = {
  maxWidth: '100%',
  minWidth: 180,
  borderRadius: 8,
  padding: 8,
  font: 'inherit',
  color: 'inherit',
  background: 'var(--dsw-alias-bg-module-platform)',
  border: '.5px solid var(--dsw-alias-border-l3)',
} as const

const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
} as const

export function ModelSetting({
  remote,
  language,
  fetchCapabilities,
}: {
  remote: ModelSettingsRemote
  language: 'zh-CN' | 'en-US'
  fetchCapabilities?: (request: ModelCapabilitiesRequest, signal?: AbortSignal) => Promise<ModelCapabilitiesResponse>
}) {
  const chinese = language === 'zh-CN'
  const client = useQueryClient()
  const state = useQuery({ queryKey, retry: false, queryFn: async () => {
    const [rawSettings, rawCatalog] = await Promise.all([remote.settings.describe(), remote.session.modelCatalog()])
    const settings = settingsSchema.parse(hostValue(rawSettings))
    const namespace = settings.namespaces.find(item => item.ns === 'clinmesh-dsh-web')
    if (namespace === undefined) throw new Error('ClinMesh settings are unavailable')
    const stored = modelSettingsNamespaceSchema.parse(namespace)
    return {
      writable: settings.writable,
      revision: stored.revision,
      values: stored.value,
      catalog: catalogSchema.parse(hostValue(rawCatalog)),
    }
  } })
  const save = useMutation({ mutationFn: async (patch: ModelSettingsPatch) => {
    if (state.data === undefined) throw new Error('Load settings first')
    const saved = modelSettingsNamespaceSchema.parse(hostValue(
      await remote.settings.update('clinmesh-dsh-web', patch, state.data.revision),
    ))
    await client.cancelQueries({ queryKey })
    client.setQueryData<NonNullable<typeof state.data>>(queryKey, previous =>
      previous === undefined || previous.revision > saved.revision ? previous
        : { ...previous, revision: saved.revision, values: saved.value },
    )
    await client.invalidateQueries({ queryKey })
  } })

  const models = state.data?.catalog.groups.flatMap(group => group.models.map(model => ({
    value: encodeModelRoute({ provider: group.id, model: model.id }), label: `${group.name} · ${model.name}`,
  }))) ?? []
  const values: ModelSettingsPatch = state.data?.values ?? {
    generationModel: 'default',
    generationReasoningEffort: modelReasoningEffortDefault,
    fastModel: 'default',
    fastReasoningEffort: modelReasoningEffortAutoLowest,
  }
  const missingPrimary = values.generationModel !== 'default' && !models.some(model => model.value === values.generationModel)
  const missingFast = values.fastModel !== 'default' && !models.some(model => model.value === values.fastModel)
  const primaryRoute = state.data === undefined
    ? undefined
    : values.generationModel === 'default'
      ? state.data.catalog.default
      : missingPrimary ? undefined : safeDecodeRoute(values.generationModel)
  const fastRoute = state.data === undefined
    ? undefined
    : values.fastModel === 'default'
      ? primaryRoute
      : missingFast ? undefined : safeDecodeRoute(values.fastModel)

  const readCapabilities = (route: ModelRoute | undefined) => async ({ signal }: { signal: AbortSignal }): Promise<ModelCapabilitiesResponse> => {
    if (route === undefined) return { efforts: [] }
    const request = { provider: route.provider, model: route.model }
    if (fetchCapabilities !== undefined) {
      return modelCapabilitiesResponseSchema.parse(await fetchCapabilities(request, signal))
    }
    return fetchModelCapabilities(request, signal, typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined)
  }

  const primaryCapabilities = useQuery<ModelCapabilitiesResponse>({
    queryKey: [...capabilitiesQueryPrefix, primaryRoute?.provider ?? '', primaryRoute?.model ?? ''],
    enabled: primaryRoute !== undefined,
    retry: false,
    queryFn: readCapabilities(primaryRoute),
  })
  const fastCapabilities = useQuery<ModelCapabilitiesResponse>({
    queryKey: [...capabilitiesQueryPrefix, fastRoute?.provider ?? '', fastRoute?.model ?? ''],
    enabled: fastRoute !== undefined,
    retry: false,
    queryFn: readCapabilities(fastRoute),
  })

  const primaryEfforts = primaryCapabilities.data?.efforts ?? []
  const fastEfforts = fastCapabilities.data?.efforts ?? []
  const primaryEffortValue = values.generationReasoningEffort === modelReasoningEffortDefault
    || primaryEfforts.some(item => item.id === values.generationReasoningEffort)
    ? values.generationReasoningEffort
    : modelReasoningEffortDefault
  const fastEffortValue = values.fastReasoningEffort === modelReasoningEffortAutoLowest
    || values.fastReasoningEffort === modelReasoningEffortDefault
    || fastEfforts.some(item => item.id === values.fastReasoningEffort)
    ? values.fastReasoningEffort
    : modelReasoningEffortAutoLowest

  const disabled = state.data === undefined || !state.data.writable || save.isPending || state.isFetching
  const updateValues = (changes: Partial<ModelSettingsPatch>) => {
    save.mutate({ ...values, ...changes })
  }

  const primaryLabel = chinese ? 'ClinMesh 模型' : 'ClinMesh model'
  const primaryEffortLabel = chinese ? '主模型思考强度' : 'Primary reasoning effort'
  const fastLabel = chinese ? 'ClinMesh 轻量模型' : 'ClinMesh fast model'
  const fastEffortLabel = chinese ? '轻量模型思考强度' : 'Fast reasoning effort'
  const fallback = chinese ? '使用 DSH 默认模型' : 'Use DSH default model'
  const followPrimary = chinese ? '沿用主模型' : 'Follow primary model'
  const effortDefaultName = (capabilities: ModelCapabilitiesResponse | undefined, inheritedEffort?: string) => {
    const effectiveDefault = inheritedEffort ?? capabilities?.defaultEffort
    const defaultItem = effectiveDefault === undefined
      ? undefined
      : capabilities?.efforts.find(item => item.id === effectiveDefault)
    if (defaultItem === undefined) return chinese ? '跟随模型默认' : 'Model default'
    return chinese ? `跟随模型默认（${defaultItem.name}）` : `Model default (${defaultItem.name})`
  }
  const primaryInheritedEffort = values.generationModel === 'default'
    ? state.data?.catalog.default.reasoningEffort
    : undefined
  const autoLowestLabel = () => {
    const lowest = fastEfforts[0]
    if (lowest === undefined) return chinese ? '自动最低' : 'Auto lowest'
    return chinese ? `自动最低（${lowest.name}）` : `Auto lowest (${lowest.name})`
  }

  return (
    <div style={{ padding: '16px 0', borderBottom: '.5px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-primary)', fontSize: 14, lineHeight: '22px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label style={rowStyle}>
          <span>{primaryLabel}</span>
          <select aria-label={primaryLabel} value={values.generationModel} disabled={disabled}
            onChange={event => {
              const nextPrimary = event.target.value
              updateValues({
                generationModel: nextPrimary,
                generationReasoningEffort: modelReasoningEffortDefault,
                ...(values.fastModel === 'default' && values.fastReasoningEffort !== modelReasoningEffortDefault
                  ? { fastReasoningEffort: modelReasoningEffortAutoLowest }
                  : {}),
              })
            }}
            style={selectStyle}>
            <option value="default">{fallback}</option>
            {missingPrimary ? <option value={values.generationModel}>{chinese ? '已选模型不可用' : 'Selected model unavailable'}</option> : null}
            {models.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}
          </select>
        </label>
        {values.generationModel === 'default' && state.data ? <p style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
          {`${state.data.catalog.default.provider} · ${state.data.catalog.default.model}`}
        </p> : null}
        {primaryEfforts.length > 0 ? <label style={rowStyle}>
          <span>{primaryEffortLabel}</span>
          <select aria-label={primaryEffortLabel} value={primaryEffortValue} disabled={disabled}
            onChange={event => updateValues({ generationReasoningEffort: event.target.value })}
            style={selectStyle}>
            <option value={modelReasoningEffortDefault}>{effortDefaultName(primaryCapabilities.data, primaryInheritedEffort)}</option>
            {primaryEfforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
          </select>
        </label> : null}
        <label style={rowStyle}>
          <span>{fastLabel}</span>
          <select aria-label={fastLabel} value={values.fastModel} disabled={disabled}
            onChange={event => updateValues({
              fastModel: event.target.value,
              fastReasoningEffort: modelReasoningEffortAutoLowest,
            })}
            style={selectStyle}>
            <option value="default">{followPrimary}</option>
            {missingFast ? <option value={values.fastModel}>{chinese ? '已选轻量模型不可用' : 'Selected fast model unavailable'}</option> : null}
            {models.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}
          </select>
        </label>
        {fastEfforts.length > 0 ? <label style={rowStyle}>
          <span>{fastEffortLabel}</span>
          <select aria-label={fastEffortLabel} value={fastEffortValue} disabled={disabled}
            onChange={event => updateValues({ fastReasoningEffort: event.target.value })}
            style={selectStyle}>
            <option value={modelReasoningEffortAutoLowest}>{autoLowestLabel()}</option>
            <option value={modelReasoningEffortDefault}>{effortDefaultName(fastCapabilities.data)}</option>
            {fastEfforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
          </select>
        </label> : null}
      </div>
      <p style={{ margin: '8px 0', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }}>
        {chinese
          ? '主模型用于诊疗建议、病历质控与住院 DRG 等复杂推理；轻量模型用于患者对话、病史整理、材料筛选、患者档案与检验生成，默认沿用主模型并自动选择最低思考强度。新请求和新的人工重试使用新设置，执行中和排队任务若已确定模型则保持原模型，尚未确定模型的排队任务使用新选择。'
          : 'Primary model handles clinical recommendations, document quality, and inpatient DRG reasoning. Fast model handles patient dialogue, history recording, evidence/catalog selection, patient personas, and laboratory generation, following the primary model with the lowest supported reasoning effort by default. New requests and new manual retries use the new settings. Active and queued tasks keep their model once assigned; queued tasks without an assigned model use the new selection.'}
      </p>
      <div role="status" aria-live="polite" style={{ fontSize: 12 }}>
        {state.isPending ? chinese ? '正在加载模型…' : 'Loading models…' : null}
        {save.isPending ? chinese ? '正在保存…' : 'Saving…' : null}
        {save.isSuccess ? chinese ? '已保存' : 'Saved' : null}
        {state.data && models.length === 0 ? chinese ? '暂无可用模型，请先在 DSH 模型设置中配置 Provider。' : 'No models available. Configure a provider in DSH model settings.' : null}
        {state.data && !state.data.writable ? chinese ? '当前配置只读。' : 'This profile is read-only.' : null}
      </div>
      {(state.isError && state.data === undefined) || save.isError || missingPrimary || missingFast || (state.data?.catalog.failures.length ?? 0) > 0 ? <p role="alert" style={{ fontSize: 12 }}>
        {chinese ? '模型或设置暂不可用，请刷新并检查 DSH 模型配置后重试。' : 'Models or settings are unavailable. Refresh and check DSH model settings before retrying.'}
      </p> : null}
      <button type="button" disabled={state.isFetching || save.isPending} onClick={() => {
        save.reset()
        void state.refetch()
        void client.invalidateQueries({ queryKey: capabilitiesQueryPrefix })
      }}
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
  const refresh = () => {
    void client.invalidateQueries({ queryKey })
    void client.invalidateQueries({ queryKey: capabilitiesQueryPrefix })
  }
  const unsubscribe = remote?.$on?.('settings/document-updated', refresh)
  const reconnect = (ctx as unknown as { on?: (event: string, listener: () => void) => () => void }).on?.('connection/reset', refresh)
  return () => { dispose(); unsubscribe?.(); reconnect?.(); client.clear() }
}
