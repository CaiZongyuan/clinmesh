// @vitest-environment jsdom
import type { SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { PathologyReadingSettings } from './pathology-reading-settings.tsx'

const session: SessionContext = { user: { id: 'synthetic-admin', email: 'admin@demo.clinmesh.local', name: '合成管理员' },
  actor: { actorId: 'synthetic-admin', epoch: 'epoch-1', practitionerRoleId: 'role-admin', roleCode: 'administrator',
    scenarioRunId: 'run-1', workspaceId: 'workspace-demo' }, availableRoles: [] }
const config = { version: 1, enabled: true, instanceId: 'saved-instance', endpoint: 'http://saved-service.invalid', viewerOrigin: 'http://saved-viewer.invalid' }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('停用始终沿已保存的原实例和地址，不将未保存编辑悄悄写入配置', async () => {
  let submitted: unknown
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input).endsWith('/status')) return Response.json({ state: 'ready', config, capabilities: [] })
    if (String(input).endsWith('/config')) { submitted = JSON.parse(String(init?.body)); return Response.json({ ...config, version: 2, enabled: false }) }
    throw new Error(String(input))
  }))
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } }), user = userEvent.setup()
  render(<QueryClientProvider client={cache}><PathologyReadingSettings locale="zh-CN" session={session} /></QueryClientProvider>)
  await user.click(screen.getByText('病理阅片服务'))
  const instance = await screen.findByDisplayValue('saved-instance')
  await user.clear(instance); await user.type(instance, 'unsaved-instance')
  const endpoint = screen.getByLabelText('服务地址')
  await user.clear(endpoint); await user.type(endpoint, 'http://unsaved-service.invalid')
  const viewer = screen.getByLabelText('阅片页面地址')
  await user.clear(viewer); await user.type(viewer, 'http://unsaved-viewer.invalid')
  await user.click(screen.getByRole('button', { name: '停用' }))
  expect(submitted).toEqual({ expectedVersion: 1, enabled: false, instanceId: config.instanceId, endpoint: config.endpoint, viewerOrigin: config.viewerOrigin })
  cache.clear()
})


it('管理员切换工作区后不展示上一工作区的阅片配置缓存', async () => {
  let statusCalls = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    statusCalls++
    return Response.json(statusCalls === 1 ? { state: 'ready', config, capabilities: [] } : { state: 'not-configured', config: null, capabilities: [] })
  }))
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }), user = userEvent.setup()
  const result = render(<QueryClientProvider client={cache}><PathologyReadingSettings locale="zh-CN" session={session} /></QueryClientProvider>)
  await user.click(screen.getByText('病理阅片服务'))
  expect(await screen.findByDisplayValue('saved-instance')).toBeTruthy()
  const changed = { ...session, actor: { ...session.actor, workspaceId: 'workspace-other' } }
  result.rerender(<QueryClientProvider client={cache}><PathologyReadingSettings locale="zh-CN" session={changed} /></QueryClientProvider>)
  await user.click(screen.getByText('病理阅片服务'))
  expect(await screen.findByText('病理阅片服务 · 未配置')).toBeTruthy()
  expect(screen.queryByDisplayValue('saved-instance')).toBeNull()
  expect(statusCalls).toBe(2)
  cache.clear()
})
