// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelSetting, registerModelSettings, type ModelSettingsPatch, type ModelSettingsRemote } from './model-settings.tsx'
import { Config } from '../index.ts'
import type { Context } from '@deepseek-ai/cordis'
import { encodeModelRoute, type ModelCapabilitiesRequest, type ModelCapabilitiesResponse } from '@clinmesh/contracts/model-bridge'

const cleanup: Array<() => void> = []
afterEach(async () => { await act(() => { for (const dispose of cleanup.splice(0)) dispose() }); vi.unstubAllGlobals() })

const defaultCapabilities = async (request: ModelCapabilitiesRequest): Promise<ModelCapabilitiesResponse> => (
  request.provider === 'a'
    ? {
        efforts: [
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium' },
          { id: 'high', name: 'High' },
        ],
        defaultEffort: 'medium',
      }
    : { efforts: [] }
)

async function render(
  remote: ModelSettingsRemote,
  language: 'zh-CN' | 'en-US' = 'zh-CN',
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  fetchCapabilities: (request: ModelCapabilitiesRequest, signal?: AbortSignal) => Promise<ModelCapabilitiesResponse> = defaultCapabilities,
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  cleanup.push(() => { root.unmount(); container.remove(); client.clear() })
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ModelSetting remote={remote} language={language} fetchCapabilities={fetchCapabilities} />
      </QueryClientProvider>,
    )
  })
  await settle()
  return container
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) }) }

function selectByLabel(container: HTMLElement, label: string): HTMLSelectElement | null {
  return container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
}

function fixture(initial?: Partial<ModelSettingsPatch>) {
  let stored = {
    bridgeSecret: 'synthetic-bridge-secret-must-never-be-overwritten',
    upstreamOrigin: 'http://127.0.0.1:51868',
    generationModel: initial?.generationModel ?? 'default',
    generationReasoningEffort: initial?.generationReasoningEffort ?? 'default',
    fastModel: initial?.fastModel ?? 'default',
    fastReasoningEffort: initial?.fastReasoningEffort ?? 'auto-lowest',
  }
  let revision = 1
  let fail = false
  let refreshFailure: 'settings' | 'catalog' | undefined
  const volatileView = () => ({
    generationModel: stored.generationModel,
    generationReasoningEffort: stored.generationReasoningEffort,
    fastModel: stored.fastModel,
    fastReasoningEffort: stored.fastReasoningEffort,
  })
  const remote = {
    settings: {
      describe: async () => {
        if (refreshFailure === 'settings') throw new Error('Synthetic settings refresh failure')
        return { ok: true, value: { writable: true, namespaces: [{ ns: 'clinmesh-dsh-web', revision, value: volatileView() }] } }
      },
      update: vi.fn(async (_namespace: string, patch: ModelSettingsPatch, expectedRevision: number) => {
        if ('bridgeSecret' in patch || 'upstreamOrigin' in patch) {
          throw new Error('Non-volatile keys must never be sent in settings patches')
        }
        if (fail || expectedRevision !== revision) return { ok: false, error: { code: 'conflict' } }
        stored = { ...stored, ...patch }
        revision++
        return { ok: true, value: { ns: 'clinmesh-dsh-web', revision, value: volatileView() } }
      }),
    },
    session: { modelCatalog: async () => {
      if (refreshFailure === 'catalog') throw new Error('Synthetic catalog refresh failure')
      return { ok: true, value: { default: { provider: 'a', model: 'same' },
        groups: ['a', 'b'].map(id => ({ id, name: `Provider ${id}`, models: [{ id: 'same', name: 'Same model' }] })), failures: [] } }
    } },
  }
  return {
    remote,
    fail: () => { fail = true },
    failRefresh: (source: NonNullable<typeof refreshFailure>) => { refreshFailure = source },
    persisted: () => ({ ...stored, revision }),
  }
}

it('declares only model routing fields volatile while keeping bridgeSecret and upstreamOrigin non-volatile', () => {
  const dict = Config.dict as Record<string, { meta?: { volatile?: boolean; default?: unknown } }>
  expect(dict.bridgeSecret?.meta?.volatile).not.toBe(true)
  expect(dict.upstreamOrigin?.meta?.volatile).not.toBe(true)
  expect(dict.maxRequestBytes?.meta?.volatile).not.toBe(true)
  expect(dict.maxResponseBytes?.meta?.volatile).not.toBe(true)
  expect(dict.requestTimeoutMs?.meta?.volatile).not.toBe(true)
  expect(dict.generationModel?.meta).toMatchObject({ volatile: true, default: 'default' })
  expect(dict.generationReasoningEffort?.meta).toMatchObject({ volatile: true, default: 'default' })
  expect(dict.fastModel?.meta).toMatchObject({ volatile: true, default: 'default' })
  expect(dict.fastReasoningEffort?.meta).toMatchObject({ volatile: true, default: 'auto-lowest' })
})

it('loads the native catalog without a Session and saves a distinct Provider/model with the settings revision', async () => {
  const { remote, persisted } = fixture()
  const container = await render(remote)
  const select = selectByLabel(container, 'ClinMesh 模型')!
  expect(select.value).toBe('default')
  expect(container.textContent).toContain('a · same')
  expect(select.options).toHaveLength(3)
  await act(() => { select.value = encodeModelRoute({ provider: 'b', model: 'same' }); select.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
  expect(remote.settings.update).toHaveBeenCalledWith('clinmesh-dsh-web', {
    generationModel: encodeModelRoute({ provider: 'b', model: 'same' }),
    generationReasoningEffort: 'default',
    fastModel: 'default',
    fastReasoningEffort: 'auto-lowest',
  }, 1)
  expect(select.value).toBe(encodeModelRoute({ provider: 'b', model: 'same' }))
  expect(container.textContent).toContain('已保存')
  // Provider b does not support reasoning efforts, so both effort dropdowns stay hidden.
  expect(selectByLabel(container, '主模型思考强度')).toBeNull()
  expect(selectByLabel(container, '轻量模型思考强度')).toBeNull()
  // Existing non-volatile connection fields remain untouched.
  expect(persisted()).toMatchObject({
    bridgeSecret: 'synthetic-bridge-secret-must-never-be-overwritten',
    upstreamOrigin: 'http://127.0.0.1:51868',
  })
  await act(() => { select.value = 'default'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
  expect(remote.settings.update).toHaveBeenLastCalledWith('clinmesh-dsh-web', {
    generationModel: 'default',
    generationReasoningEffort: 'default',
    fastModel: 'default',
    fastReasoningEffort: 'auto-lowest',
  }, 2)
})

it('renders optional reasoning effort dropdowns for reasoning models and hides them for non-reasoning models without invalid options', async () => {
  const { remote, persisted } = fixture({ generationReasoningEffort: 'unsupported-stale', fastReasoningEffort: 'stale-fast' })
  const container = await render(remote, 'en-US')
  const primaryEffort = selectByLabel(container, 'Primary reasoning effort')!
  const fastModel = selectByLabel(container, 'ClinMesh fast model')!
  const fastEffort = selectByLabel(container, 'Fast reasoning effort')!
  // Stale invalid efforts are never offered as options and display as safe defaults.
  expect(Array.from(primaryEffort.options).map(option => option.value)).toEqual(['default', 'low', 'medium', 'high'])
  expect(primaryEffort.value).toBe('default')
  expect(Array.from(fastEffort.options).map(option => option.value)).toEqual(['auto-lowest', 'default', 'low', 'medium', 'high'])
  expect(fastEffort.value).toBe('auto-lowest')

  await act(() => { primaryEffort.value = 'high'; primaryEffort.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
  expect(persisted()).toMatchObject({
    generationModel: 'default',
    generationReasoningEffort: 'high',
    fastModel: 'default',
    bridgeSecret: 'synthetic-bridge-secret-must-never-be-overwritten',
    upstreamOrigin: 'http://127.0.0.1:51868',
  })

  await act(() => { fastEffort.value = 'low'; fastEffort.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
  expect(persisted()).toMatchObject({
    generationReasoningEffort: 'high',
    fastReasoningEffort: 'low',
  })

  // Switching fast model to non-reasoning provider b hides fast effort dropdown while preserving primary effort.
  const routeB = encodeModelRoute({ provider: 'b', model: 'same' })
  await act(() => { fastModel.value = routeB; fastModel.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
  expect(selectByLabel(container, 'Fast reasoning effort')).toBeNull()
  expect(selectByLabel(container, 'Primary reasoning effort')?.value).toBe('high')
  expect(persisted()).toMatchObject({
    generationReasoningEffort: 'high',
    fastModel: routeB,
    fastReasoningEffort: 'auto-lowest',
    bridgeSecret: 'synthetic-bridge-secret-must-never-be-overwritten',
    upstreamOrigin: 'http://127.0.0.1:51868',
  })
})

it('shows DSH default reasoningEffort for primary default option while keeping model default for fast default option', async () => {
  const base = fixture()
  const remote: ModelSettingsRemote = {
    settings: base.remote.settings,
    session: {
      modelCatalog: async () => ({
        ok: true,
        value: {
          default: { provider: 'a', model: 'same', reasoningEffort: 'high' },
          groups: [{ id: 'a', name: 'Provider a', models: [{ id: 'same', name: 'Same model' }] }],
          failures: [],
        },
      }),
    },
  }
  const container = await render(remote, 'en-US')
  const primaryEffort = selectByLabel(container, 'Primary reasoning effort')!
  const fastEffort = selectByLabel(container, 'Fast reasoning effort')!
  expect(primaryEffort.options[0]?.textContent).toBe('Model default (High)')
  expect(fastEffort.options[1]?.textContent).toBe('Model default (Medium)')
})

it('preserves the stored selection when saving fails and offers a refresh', async () => {
  const { remote, fail } = fixture()
  const container = await render(remote, 'en-US')
  fail()
  const select = selectByLabel(container, 'ClinMesh model')!
  await act(() => { select.value = encodeModelRoute({ provider: 'b', model: 'same' }); select.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
  expect(select.value).toBe('default')
  expect(container.querySelector('[role=alert]')?.textContent).toContain('unavailable')
  expect(container.querySelector('button')?.textContent).toBe('Refresh models')
})

it.each(['settings', 'catalog'] as const)('keeps the saved model and revision when the %s refresh fails', async source => {
  const { remote, failRefresh, persisted } = fixture()
  const container = await render(remote, 'en-US')
  const select = selectByLabel(container, 'ClinMesh model')!
  const route = encodeModelRoute({ provider: 'b', model: 'same' })
  failRefresh(source)
  await act(() => { select.value = route; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
  expect(persisted()).toMatchObject({ generationModel: route, revision: 2 })
  expect(select.value).toBe(route)
  expect(container.querySelector('[role=status]')?.textContent).toContain('Saved')
  expect(container.querySelector('[role=alert]')).toBeNull()
  expect(select.disabled).toBe(false)
  await act(() => { select.value = 'default'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
  expect(remote.settings.update).toHaveBeenLastCalledWith('clinmesh-dsh-web', {
    generationModel: 'default',
    generationReasoningEffort: 'default',
    fastModel: 'default',
    fastReasoningEffort: 'auto-lowest',
  }, 2)
  expect(persisted()).toMatchObject({ generationModel: 'default', revision: 3 })
  expect(select.value).toBe('default')
  expect(container.querySelector('[role=status]')?.textContent).toContain('Saved')
  expect(container.querySelector('[role=alert]')).toBeNull()
})

it('discards an older read started by a host notification during saving', async () => {
  const { remote } = fixture()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const container = await render(remote, 'en-US', client)
  const oldSettings = await remote.settings.describe()
  const describe = remote.settings.describe
  let releaseRead: (() => void) | undefined
  let reads = 0
  remote.settings.describe = async () => {
    if (reads++ === 0) return new Promise(resolve => { releaseRead = () => resolve(oldSettings) })
    return describe()
  }
  const update = remote.settings.update.getMockImplementation()!
  remote.settings.update.mockImplementation(async (...args) => {
    const response = await update(...args)
    void client.invalidateQueries({ queryKey: ['clinmesh-model-settings'] })
    return response
  })
  const select = selectByLabel(container, 'ClinMesh model')!
  const route = encodeModelRoute({ provider: 'b', model: 'same' })
  await act(() => { select.value = route; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
  expect(releaseRead).toBeTypeOf('function')
  expect(select.value).toBe(route)
  await act(() => { releaseRead?.() })
  await settle()
  expect(select.value).toBe(route)
  expect(container.querySelector('[role=status]')?.textContent).toContain('Saved')
})

it('does not display an unvalidated saved selection from another namespace', async () => {
  const { remote } = fixture()
  const container = await render(remote, 'en-US')
  const route = encodeModelRoute({ provider: 'b', model: 'same' })
  remote.settings.update.mockResolvedValueOnce({
    ok: true,
    value: {
      ns: 'another-plugin',
      revision: 2,
      value: {
        generationModel: route,
        generationReasoningEffort: 'default',
        fastModel: 'default',
        fastReasoningEffort: 'auto-lowest',
      },
    },
  })
  const select = selectByLabel(container, 'ClinMesh model')!
  await act(() => { select.value = route; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
  expect(select.value).toBe('default')
  expect(container.querySelector('[role=status]')?.textContent).not.toContain('Saved')
  expect(container.querySelector('[role=alert]')).not.toBeNull()
})

it('shows read-only and unavailable selections without silently choosing another model', async () => {
  const remote: ModelSettingsRemote = {
    settings: { describe: async () => ({ ok: true, value: { writable: false, namespaces: [{ ns: 'clinmesh-dsh-web', revision: 1,
      value: { generationModel: encodeModelRoute({ provider: 'removed', model: 'same' }) } }] } }), update: vi.fn() },
    session: { modelCatalog: async () => ({ ok: true, value: { default: { provider: 'a', model: 'same' }, groups: [], failures: [] } }) },
  }
  const container = await render(remote)
  const select = selectByLabel(container, 'ClinMesh 模型')!
  expect(select.disabled).toBe(true)
  expect(select.value).toBe(encodeModelRoute({ provider: 'removed', model: 'same' }))
  expect(container.textContent).toContain('当前配置只读')
  expect(container.textContent).toContain('暂无可用模型')
  expect(container.querySelector('[role=alert]')).not.toBeNull()
})

it('retracts its slot and host subscriptions on plugin unload', () => {
  const unregister = vi.fn()
  const unsubscribe = vi.fn()
  const reconnect = vi.fn()
  const remote = { ...fixture().remote, $on: vi.fn(() => unsubscribe) }
  const ctx = {
    get: (name: string) => name === 'remote' ? remote : { subscribe: vi.fn(), getLocale: () => ({ active: 'zh-CN' }) },
    on: vi.fn(() => reconnect),
    slots: { inject: (_name: string, register: () => () => void) => register(), register: vi.fn(() => unregister) },
  }
  const dispose = registerModelSettings(ctx as unknown as Context)
  expect(remote.$on).toHaveBeenCalledWith('settings/document-updated', expect.any(Function))
  dispose()
  expect(unregister).toHaveBeenCalledOnce()
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(reconnect).toHaveBeenCalledOnce()
})
