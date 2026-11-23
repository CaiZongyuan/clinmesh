import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { pathologyReadingConfigInputSchema, pathologyReadingMessageSchema, pathologyReadingSessionInputSchema, readingAuthorizationInputSchema } from '@clinmesh/contracts/pathology-reading'
import type { IdentityService } from './application/identity-service.ts'
import type { PathologyReadingService } from './application/pathology-reading-service.ts'

/** 受限阅片的 HTTP 适配：浏览器沿原认证，外部服务只持有单会话回调凭据。 */
export function installPathologyReadingRoutes(app: Hono, identity: IdentityService, reading: PathologyReadingService,
  errorResponse: (context: Context, error: unknown) => Response) {
  const actor = async (context: Context) => (await identity.resolveSessionContext(context.req.raw.headers)).actor
  const key = (context: Context) => z.string().min(8).max(128).parse(context.req.header('idempotency-key'))
  app.use('/api/sim/v1/admin/pathology-reading/*', async (context, next) => { context.header('Cache-Control', 'private, no-store'); await next() })
  app.use('/api/his/v1/pathology-reading/*', async (context, next) => { context.header('Cache-Control', 'private, no-store'); await next() })
  app.get('/api/sim/v1/admin/pathology-reading/status', async context => {
    try { return context.json(await reading.status(await actor(context))) } catch (error) { return errorResponse(context, error) }
  })
  app.put('/api/sim/v1/admin/pathology-reading/config', async context => {
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      return context.json(reading.configure(await actor(context), pathologyReadingConfigInputSchema.parse(await context.req.json()), key(context)))
    } catch (error) { return errorResponse(context, error) }
  })
  app.post('/api/his/v1/pathology-requests/:requestId/reading-sessions', async context => {
    context.header('Cache-Control', 'private, no-store')
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      const current = await actor(context), auth = await identity.auth.api.getSession({ headers: context.req.raw.headers })
      if (auth === null) return context.json({ error: { code: 'AUTHENTICATION_REQUIRED', message: 'A human login is required' } }, 401)
      const input = pathologyReadingSessionInputSchema.parse(await context.req.json())
      if (input.parentOrigin !== context.req.header('origin')) return context.json({ error: { code: 'CSRF_REJECTED', message: 'The reading parent origin does not match' } }, 403)
      return context.json(await reading.open(current, auth.session.id, context.req.param('requestId'), input, key(context)))
    } catch (error) { return errorResponse(context, error) }
  })
  app.get('/api/his/v1/pathology-reading/sessions/:id', async context => {
    try { return context.json(await reading.state(await actor(context), context.req.param('id'))) } catch (error) { return errorResponse(context, error) }
  })
  app.post('/api/his/v1/pathology-reading/sessions/:id/displayed', async context => {
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      return context.json(await reading.displayed(await actor(context), context.req.param('id'), pathologyReadingMessageSchema.parse(await context.req.json())))
    } catch (error) { return errorResponse(context, error) }
  })
  app.delete('/api/his/v1/pathology-reading/sessions/:id', async context => {
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      return context.json(await reading.close(await actor(context), context.req.param('id'), key(context)))
    } catch (error) { return errorResponse(context, error) }
  })
  app.post('/api/his/v1/pathology-reading/authorize', async context => {
    const header = context.req.header('authorization'), token = header?.startsWith('Bearer ') ? header.slice(7) : ''
    if (token.length < 32 || token.length > 256) return context.json({ active: false, writable: false }, 401)
    try { return context.json(await reading.authorize(token, readingAuthorizationInputSchema.parse(await context.req.json()))) }
    catch { return context.json({ active: false, writable: false }, 403) }
  })
}
