import type { Server as HttpServer } from 'node:http'
import { serve } from '@hono/node-server'
import type { Hono } from 'hono'
import { createApp, type CreateAppOptions } from './app.ts'
import { attachVoiceSttWebSocket } from './http/voice-routes.ts'

export interface StartServerOptions extends CreateAppOptions {
  app?: Hono
  hostname: string
  port: number
}

export function startServer(options: StartServerOptions) {
  const app = options.app ?? createApp(options)

  const server = serve({
    fetch: app.fetch,
    hostname: options.hostname,
    port: options.port,
  })

  if (options.identity !== undefined && options.voice !== undefined) {
    attachVoiceSttWebSocket(server as HttpServer, {
      identity: options.identity,
      voice: options.voice,
    })
  }

  return server
}
