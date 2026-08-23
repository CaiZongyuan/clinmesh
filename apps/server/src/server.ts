import { serve } from '@hono/node-server'
import { createApp, type CreateAppOptions } from './app.ts'

export interface StartServerOptions extends CreateAppOptions {
  hostname: string
  port: number
}

export function startServer(options: StartServerOptions) {
  const app = createApp(options)

  return serve({
    fetch: app.fetch,
    hostname: options.hostname,
    port: options.port,
  })
}
