import type { ComponentType, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import { registerWorkspaceHistory } from './workspace-history.tsx'
import type { DirectoryFlowOwner } from './directory-flow.tsx'

const styles = document.createElement('style')
styles.textContent = `
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui}
  [data-conversation]{position:relative;height:calc(100vh - 70px);width:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
  [data-theme=light]{--dsw-alias-bg-base:rgb(250,250,250);--dsw-alias-label-primary:rgb(24,30,36);--dsw-alias-border-l3:rgb(210,215,220)}
  [data-theme=dark]{--dsw-alias-bg-base:rgb(30,35,40);--dsw-alias-label-primary:rgb(225,230,235);--dsw-alias-border-l3:rgb(75,80,85)}
`
document.head.append(styles)
const conversation = document.createElement('main')
conversation.dataset.conversation = ''
conversation.dataset.theme = 'light'
conversation.innerHTML = '<div data-slot="conversation.header.leading" style="height:0"></div><header data-slot="conversation.session.header" style="height:0"><div style="position:absolute;right:48px;top:8px;display:flex;align-items:center"><div data-slot="conversation.session.header.utilities" style="display:flex;gap:8px"><button aria-label="宿主文件" style="width:28px;height:32px">文</button><button aria-label="宿主更多" style="width:28px;height:32px">更</button></div></div></header><button aria-label="宿主右栏" style="position:absolute;right:12px;top:11px;width:28px;height:28px">右</button><p style="margin:0;padding-top:60px">合成对话内容</p>'
document.body.append(conversation)
const leading = conversation.querySelector<HTMLElement>('[data-slot]')!
const root = createRoot(leading)
const subscriptions = new Set<() => void>()
const snapshot = <T,>(value: T) => ({
  getSnapshot: () => value,
  subscribe: (listener: () => void) => {
    subscriptions.add(listener)
    return () => { subscriptions.delete(listener) }
  },
})
const sessions = {
  ids: ['session-1'],
  byId: { 'session-1': { id: 'session-1', title: '合成门诊讨论', displayTitle: '合成门诊讨论', updatedAt: 12, blank: false } },
  phase: 'ready',
}
const workspaces = {
  items: [{ workspaceId: 'workspace-1', title: '合成教学工作区', sessionIds: ['session-1'] }],
  archivedSessionIds: [], pinnedSessionIds: [], phase: 'ready', state: 'idle',
}
const services: Record<string, unknown> = {
  uiWorkspace: { startSession() {}, openSession() {}, pinSession: async () => {} },
  sessions: {
    list: snapshot(sessions), searchResultLimit: 20,
    search: async () => ({ ok: true, value: { items: [], hasMore: false } }),
    using: async (_id: string, _options: unknown, operation: (reference: unknown) => Promise<unknown>) =>
      operation({ binding: { session: { rename: async () => ({ ok: true, value: {} }) } } }),
  },
  workspaces: { list: snapshot(workspaces) },
  uiSession: { adapter: { current: snapshot({ key: 'session-1' }) } },
  locale: { getLocale: () => ({ active: 'zh-CN' }), subscribe: snapshot(null).subscribe },
}
type HeaderProps = { renderSlot(name: string, owner: DirectoryFlowOwner): ReactNode }
let Header: ComponentType<HeaderProps> = () => null
let flow: { component: ComponentType<DirectoryFlowOwner>; inject: (() => object) | undefined } | undefined
const sourceFlow = { component: () => null, inject: () => ({}) }
const renderSlot = (_name: string, owner: DirectoryFlowOwner) => {
  if (!flow) return null
  const Flow = flow.component
  return <Flow {...owner} {...flow.inject?.()} />
}
let registered = false
const ctx = {
  get: (name: string) => services[name],
  slots: {
    inject: (_name: string, register: () => () => void) => register(),
    register: (entry: { name: string; inject?: () => object }, component: unknown) => {
      if (entry.name === 'conversation.header.leading') {
        Header = component as ComponentType<HeaderProps>
        registered = true
        return () => { flushSync(() => root.unmount()); registered = false }
      }
      flow = { component: component as ComponentType<DirectoryFlowOwner>, inject: entry.inject }
      return () => { flow = undefined }
    },
    entries: () => flow ? [flow] : [],
    entriesOfSlot: () => [sourceFlow],
    subscribe: (_key: string, listener: () => void) => {
      subscriptions.add(listener)
      return () => { subscriptions.delete(listener) }
    },
  },
}
const dispose = registerWorkspaceHistory(ctx as unknown as Context)
flushSync(() => root.render(<Header renderSlot={renderSlot} />))
const controls = document.createElement('div')
controls.innerHTML = '<button type="button">切换主题</button><button type="button">卸载插件</button><output aria-label="插件释放状态"></output>'
document.body.append(controls)
controls.querySelector<HTMLButtonElement>('button')!.onclick = () => {
  conversation.dataset.theme = conversation.dataset.theme === 'light' ? 'dark' : 'light'
}
controls.querySelectorAll<HTMLButtonElement>('button')[1]!.onclick = () => {
  dispose()
  controls.querySelector('output')!.textContent = !registered && subscriptions.size === 0 ? '已释放' : '仍有注册或订阅'
}
