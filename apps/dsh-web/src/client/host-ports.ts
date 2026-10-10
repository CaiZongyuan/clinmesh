import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** DSH 0.2 当前主会话绑定;无选中会话时 key 为 undefined。 */
export interface ClientSessionBindingPort {
  adapter: {
    current: {
      getSnapshot(): { key: string | undefined }
      subscribe(listener: () => void): () => void
    }
  }
}

export interface ClientThemePort {
  getTheme(): { active: { colorScheme: 'light' | 'dark' } }
}

export interface ClientSessionInputPort {
  binding(id: string): { session: {
    getSnapshot(): { sessionId: string; pendingSubmissions: ReadonlyArray<{
      requestId: string; text: string; attachments: readonly unknown[]
    }> }
    subscribe(listener: () => void): () => void
  } } | undefined
}

export interface ClientThemeContext {
  on(event: 'theme/change', listener: () => void): () => void
}

/** 订阅宿主主题切换事件(ctx.on('theme/change'))。 */
export function subscribeHostTheme(ctx: ClientContext, listener: () => void): () => void {
  return (ctx as unknown as ClientThemeContext).on('theme/change', listener)
}
