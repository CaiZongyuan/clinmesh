import { serve } from '@hono/node-server'
import type { Hono } from 'hono'
import { createApp, type CreateAppOptions } from './app.ts'

export interface StartServerOptions extends CreateAppOptions {
  app?: Hono
  hostname: string
  port: number
}

export function startServer(options: StartServerOptions) {
  const app = options.app ?? createApp(options)

  return serve({
    fetch: app.fetch,
    hostname: options.hostname,
    port: options.port,
  })
}
