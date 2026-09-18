import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** 宿主会话列表端口;current 为宿主任意原始值,经 normalizeSessionId 归一后使用。 */
export interface ClientSessionsPort {
  list: {
    getSnapshot(): { current: unknown }
    subscribe(listener: () => void): () => void
  }
}

export interface ClientThemePort {
  getTheme(): { active: { colorScheme: 'light' | 'dark' } }
}

export interface ClientThemeContext {
  on(event: 'theme/change', listener: () => void): () => void
}

/** 会话 id 归一化:undefined 视为无会话(hero/未发首条消息),其余统一转 string,
 * 不得把宿主的 null 等值误当真实会话。 */
export function normalizeSessionId(current: unknown): string | undefined {
  return current === undefined ? undefined : String(current)
}

/** 订阅宿主主题切换事件(ctx.on('theme/change'))。 */
export function subscribeHostTheme(ctx: ClientContext, listener: () => void): () => void {
  return (ctx as unknown as ClientThemeContext).on('theme/change', listener)
}
