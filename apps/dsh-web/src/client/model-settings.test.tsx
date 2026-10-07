// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelSetting, registerModelSettings, type ModelSettingsRemote } from './model-settings.tsx'
import type { Context } from '@deepseek-ai/cordis'
import { encodeModelRoute } from '@clinmesh/contracts/model-bridge'

const cleanup: Array<() => void> = []
afterEach(async () => { await act(() => { for (const dispose of cleanup.splice(0)) dispose() }); vi.unstubAllGlobals() })

async function render(remote: ModelSettingsRemote, language: 'zh-CN' | 'en-US' = 'zh-CN',
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  cleanup.push(() => { root.unmount(); container.remove(); client.clear() })
  await act(async () => { root.render(<QueryClientProvider client={client}><ModelSetting remote={remote} language={language} /></QueryClientProvider>) })
  await settle()
  return container
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) }) }

function fixture() {
  let selected = 'default'
  let revision = 1
  let fail = false
  let refreshFailure: 'settings' | 'catalog' | undefined
  const remote = {
    settings: {
      describe: async () => {
        if (refreshFailure === 'settings') throw new Error('Synthetic settings refresh failure')
        return { ok: true, value: { writable: true, namespaces: [{ ns: 'clinmesh-dsh-web', revision, value: { generationModel: selected } }] } }
      },
      update: vi.fn(async (_namespace: string, patch: { generationModel: string }, expectedRevision: number) => {
        if (fail || expectedRevision !== revision) return { ok: false, error: { code: 'conflict' } }
        selected = patch.generationModel; revision++
        return { ok: true, value: { ns: 'clinmesh-dsh-web', revision, value: { generationModel: selected } } }
      }),
    },
    session: { modelCatalog: async () => {
      if (refreshFailure === 'catalog') throw new Error('Synthetic catalog refresh failure')
      return { ok: true, value: { default: { provider: 'a', model: 'same' },
        groups: ['a', 'b'].map(id => ({ id, name: `Provider ${id}`, models: [{ id: 'same', name: 'Same model' }] })), failures: [] } }
    } },
  }
  return { remote, fail: () => { fail = true },
    failRefresh: (source: NonNullable<typeof refreshFailure>) => { refreshFailure = source },
    persisted: () => ({ selected, revision }),
  }
}

it('loads the native catalog without a Session and saves a distinct Provider/model with the settings revision', async () => {
  const { remote } = fixture()
  const container = await render(remote)
  const select = container.querySelector('select')!
  expect(select.value).toBe('default')
  expect(container.textContent).toContain('a · same')
  expect(select.options).toHaveLength(3)
  await act(() => { select.value = encodeModelRoute({ provider: 'b', model: 'same' }); select.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
  expect(remote.settings.update).toHaveBeenCalledWith('clinmesh-dsh-web', { generationModel: encodeModelRoute({ provider: 'b', model: 'same' }) }, 1)
  expect(select.value).toBe(encodeModelRoute({ provider: 'b', model: 'same' }))
  expect(container.textContent).toContain('已保存')
  await act(() => { select.value = 'default'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
  expect(remote.settings.update).toHaveBeenLastCalledWith('clinmesh-dsh-web', { generationModel: 'default' }, 2)
})

it('preserves the stored selection when saving fails and offers a refresh', async () => {
  const { remote, fail } = fixture()
  const container = await render(remote, 'en-US')
  fail()
  const select = container.querySelector('select')!
  await act(() => { select.value = encodeModelRoute({ provider: 'b', model: 'same' }); select.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
  expect(select.value).toBe('default')
  expect(container.querySelector('[role=alert]')?.textContent).toContain('unavailable')
  expect(container.querySelector('button')?.textContent).toBe('Refresh models')
})

it.each(['settings', 'catalog'] as const)('keeps the saved model and revision when the %s refresh fails', async source => {
  const { remote, failRefresh, persisted } = fixture()
  const container = await render(remote, 'en-US')
  const select = container.querySelector('select')!
  const route = encodeModelRoute({ provider: 'b', model: 'same' })
  failRefresh(source)
  await act(() => { select.value = route; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
  expect(persisted()).toEqual({ selected: route, revision: 2 })
  expect(select.value).toBe(route)
  expect(container.querySelector('[role=status]')?.textContent).toContain('Saved')
  expect(container.querySelector('[role=alert]')).toBeNull()
  expect(select.disabled).toBe(false)
  await act(() => { select.value = 'default'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
  expect(remote.settings.update).toHaveBeenLastCalledWith('clinmesh-dsh-web', { generationModel: 'default' }, 2)
  expect(persisted()).toEqual({ selected: 'default', revision: 3 })
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
  const select = container.querySelector('select')!
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
  remote.settings.update.mockResolvedValueOnce({ ok: true,
    value: { ns: 'another-plugin', revision: 2, value: { generationModel: route } },
  })
  const select = container.querySelector('select')!
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
  expect(container.querySelector('select')?.disabled).toBe(true)
  expect(container.querySelector('select')?.value).toBe(encodeModelRoute({ provider: 'removed', model: 'same' }))
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
