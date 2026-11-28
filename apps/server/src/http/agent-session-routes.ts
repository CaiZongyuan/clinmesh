import type { Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  compactAgentSessionRequestSchema,
  createAgentSessionRequestSchema,
  createClinicianMemoryRequestSchema,
  forkAgentSessionRequestSchema,
  renameAgentSessionRequestSchema,
  resetAgentSessionRequestSchema,
  sendAgentMessageRequestSchema,
  sideChatRequestSchema,
  testLlmProviderRequestSchema,
  updateClinicianMemoryRequestSchema,
  type AgentSessionSseEvent,
} from '@clinmesh/contracts/agent-sessions'
import type { AgentSessionService } from '../application/agent-session-service.ts'
import type { IdentityService } from '../application/identity-service.ts'

export function registerAgentSessionRoutes(
  app: Hono,
  options: {
    identity: IdentityService
    agentSessions: AgentSessionService
    apiErrorResponse: (context: Context, error: unknown, invalidInputMessage?: string) => Response
  },
): void {
  const { identity, agentSessions, apiErrorResponse } = options

  async function resolveActor(context: Context) {
    const session = await identity.resolveSessionContext(context.req.raw.headers)
    return session.actor
  }

  app.get('/api/agents/providers/status', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      await resolveActor(context)
      return context.json(agentSessions.providers.serverDefaultStatus)
    } catch (error) {
      return apiErrorResponse(context, error)
    }
  })

  app.get('/api/agents/providers/catalog', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      await resolveActor(context)
      const refresh = context.req.query('refresh') === '1' || context.req.query('refresh') === 'true'
      return context.json(agentSessions.providers.getCatalog({ force: refresh }))
    } catch (error) {
      return apiErrorResponse(context, error)
    }
  })

  app.post('/api/agents/providers/test', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      await resolveActor(context)
      const body = testLlmProviderRequestSchema.parse(await context.req.json())
      const result = await agentSessions.providers.testConnection(
        body,
        context.req.raw.headers,
        context.req.raw.signal,
      )
      return context.json(result)
    } catch (error) {
      return apiErrorResponse(context, error, 'The provider connection test payload is invalid')
    }
  })

  app.get('/api/agents/sessions', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      const actor = await resolveActor(context)
      const encounterParam = context.req.query('encounterId')
      const filter = encounterParam === undefined
        ? {}
        : { encounterId: encounterParam === '__none__' || encounterParam === '' ? null : encounterParam }
      const sessions = await agentSessions.listClinicianSessions(actor, filter)
      return context.json({ sessions })
    } catch (error) {
      return apiErrorResponse(context, error)
    }
  })

  app.get('/api/agents/sessions/search', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      const actor = await resolveActor(context)
      const q = context.req.query('q') ?? ''
      const encounterParam = context.req.query('encounterId')
      const filter = encounterParam === undefined
        ? {}
        : { encounterId: encounterParam === '__none__' || encounterParam === '' ? null : encounterParam }
      const result = await agentSessions.searchClinicianSessions(actor, q, filter)
      return context.json(result)
    } catch (error) {
      return apiErrorResponse(context, error)
    }
  })

  app.get('/api/agents/clinical-entities', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      const actor = await resolveActor(context)
      const encounterParam = context.req.query('encounterId')
      const caseParam = context.req.query('caseId')
      const entities = agentSessions.listClinicalEntitiesForScope(actor, {
        encounterId: encounterParam && encounterParam !== '__none__' ? encounterParam : null,
        caseId: caseParam && caseParam !== '__none__' ? caseParam : null,
      })
      return context.json(entities)
    } catch (error) {
      return apiErrorResponse(context, error)
    }
  })

  app.post('/api/agents/side-question', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      const actor = await resolveActor(context)
      const body = sideChatRequestSchema.parse(await context.req.json())
      const result = await agentSessions.runStandaloneSideChatQuestion(
        actor,
        body,
        context.req.raw.headers,
        context.req.raw.signal,
      )
      return context.json(result)
    } catch (error) {
      return apiErrorResponse(context, error, 'The side question payload is invalid')
    }
  })

  app.get('/api/agents/memory', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      const actor = await resolveActor(context)
      const items = await agentSessions.listClinicianMemories(actor)
      return context.json({ items })
    } catch (error) {
      return apiErrorResponse(context, error)
    }
  })

  app.post('/api/agents/memory', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      const actor = await resolveActor(context)
      const body = createClinicianMemoryRequestSchema.parse(await context.req.json())
      const items = await agentSessions.createClinicianMemory(actor, body)
      return context.json({ items }, 201)
    } catch (error) {
      return apiErrorResponse(context, error, 'The clinician memory payload is invalid')
    }
  })

  app.patch('/api/agents/memory/:memoryId', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      const actor = await resolveActor(context)
      const body = updateClinicianMemoryRequestSchema.parse(await context.req.json())
      const items = await agentSessions.updateClinicianMemory(actor, context.req.param('memoryId'), body)
      return context.json({ items })
    } catch (error) {
      return apiErrorResponse(context, error, 'The clinician memory update payload is invalid')
    }
  })

  app.delete('/api/agents/memory/:memoryId', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      const actor = await resolveActor(context)
      const items = await agentSessions.deleteClinicianMemory(actor, context.req.param('memoryId'))
      return context.json({ items })
    } catch (error) {
      return apiErrorResponse(context, error)
    }
  })

  app.post('/api/agents/sessions', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      const actor = await resolveActor(context)
      const rawBody = await context.req.text()
      const body = createAgentSessionRequestSchema.parse(rawBody.trim().length > 0 ? JSON.parse(rawBody) : {})
      const detail = await agentSessions.createClinicianSession(actor, body)
      return context.json(detail, 201)
    } catch (error) {
      return apiErrorResponse(context, error, 'The agent session payload is invalid')
    }
  })

  app.get('/api/agents/sessions/:sessionId', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      const actor = await resolveActor(context)
      const detail = await agentSessions.getClinicianSession(actor, context.req.param('sessionId'))
      return context.json(detail)
    } catch (error) {
      return apiErrorResponse(context, error)
    }
  })

  app.get('/api/agents/sessions/:sessionId/context', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      const actor = await resolveActor(context)
      const snapshot = await agentSessions.getClinicianSessionContext(actor, context.req.param('sessionId'))
      return context.json(snapshot)
    } catch (error) {
      return apiErrorResponse(context, error)
    }
  })

  app.get('/api/agents/sessions/:sessionId/model-calls/:callId', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      const actor = await resolveActor(context)
      const modelCall = await agentSessions.getClinicianModelCallDetail(
        actor,
        context.req.param('sessionId'),
        context.req.param('callId'),
      )
      return context.json({ modelCall })
    } catch (error) {
      return apiErrorResponse(context, error)
    }
  })

  app.patch('/api/agents/sessions/:sessionId', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      const actor = await resolveActor(context)
      const body = renameAgentSessionRequestSchema.parse(await context.req.json())
      const summary = await agentSessions.updateClinicianSession(actor, context.req.param('sessionId'), body)
      return context.json({ session: summary })
    } catch (error) {
      return apiErrorResponse(context, error, 'The session update payload is invalid')
    }
  })

  app.delete('/api/agents/sessions/:sessionId', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      const actor = await resolveActor(context)
      await agentSessions.deleteClinicianSession(actor, context.req.param('sessionId'))
      return context.json({ deleted: true })
    } catch (error) {
      return apiErrorResponse(context, error)
    }
  })

  app.post('/api/agents/sessions/:sessionId/messages', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      const actor = await resolveActor(context)
      const body = sendAgentMessageRequestSchema.parse(await context.req.json())
      const detail = await agentSessions.sendClinicianMessage(
        actor,
        context.req.param('sessionId'),
        body,
        context.req.raw.headers,
      )
      return context.json(detail, 202)
    } catch (error) {
      return apiErrorResponse(context, error, 'The message payload is invalid')
    }
  })

  app.delete('/api/agents/sessions/:sessionId/queue/:submissionId', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      const actor = await resolveActor(context)
      const submissionId = Number(context.req.param('submissionId'))
      if (!Number.isInteger(submissionId) || submissionId <= 0) {
        return apiErrorResponse(context, new Error('Invalid submissionId'), 'Invalid queued submission ID')
      }
      const result = await agentSessions.recallQueuedClinicianInput(
        actor,
        context.req.param('sessionId'),
        submissionId,
      )
      return context.json(result)
    } catch (error) {
      return apiErrorResponse(context, error)
    }
  })

  app.post('/api/agents/sessions/:sessionId/compact', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      const actor = await resolveActor(context)
      const rawBody = await context.req.text()
      const body = compactAgentSessionRequestSchema.parse(rawBody.trim().length > 0 ? JSON.parse(rawBody) : {})
      const detail = await agentSessions.compactClinicianSession(
        actor,
        context.req.param('sessionId'),
        body,
        context.req.raw.headers,
      )
      return context.json(detail)
    } catch (error) {
      return apiErrorResponse(context, error, 'The compact payload is invalid')
    }
  })

  app.post('/api/agents/sessions/:sessionId/reset', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      const actor = await resolveActor(context)
      const rawBody = await context.req.text()
      const body = resetAgentSessionRequestSchema.parse(rawBody.trim().length > 0 ? JSON.parse(rawBody) : {})
      const detail = await agentSessions.resetClinicianSession(
        actor,
        context.req.param('sessionId'),
        body,
      )
      return context.json(detail)
    } catch (error) {
      return apiErrorResponse(context, error, 'The reset payload is invalid')
    }
  })

  app.post('/api/agents/sessions/:sessionId/side-question', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      const actor = await resolveActor(context)
      const body = sideChatRequestSchema.parse(await context.req.json())
      const result = await agentSessions.runSideChatQuestion(
        actor,
        context.req.param('sessionId'),
        body,
        context.req.raw.headers,
        context.req.raw.signal,
      )
      return context.json(result)
    } catch (error) {
      return apiErrorResponse(context, error, 'The side question payload is invalid')
    }
  })

  app.get('/api/agents/sessions/:sessionId/clinical-entities', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      const actor = await resolveActor(context)
      const entities = await agentSessions.listClinicalEntities(actor, context.req.param('sessionId'))
      return context.json(entities)
    } catch (error) {
      return apiErrorResponse(context, error)
    }
  })

  app.get('/api/agents/sessions/:sessionId/export', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      const actor = await resolveActor(context)
      const exported = await agentSessions.exportClinicianSessionMarkdown(actor, context.req.param('sessionId'))
      return context.json(exported)
    } catch (error) {
      return apiErrorResponse(context, error)
    }
  })

  app.post('/api/agents/sessions/:sessionId/stop', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      const actor = await resolveActor(context)
      const detail = await agentSessions.stopClinicianSession(actor, context.req.param('sessionId'))
      return context.json(detail)
    } catch (error) {
      return apiErrorResponse(context, error)
    }
  })

  app.post('/api/agents/sessions/:sessionId/retry', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      const actor = await resolveActor(context)
      const detail = await agentSessions.retryLatestClinicianMessage(
        actor,
        context.req.param('sessionId'),
        context.req.raw.headers,
      )
      return context.json(detail, 202)
    } catch (error) {
      return apiErrorResponse(context, error)
    }
  })

  app.post('/api/agents/sessions/:sessionId/fork', async (context) => {
    context.header('Cache-Control', 'no-store')
    try {
      identity.assertTrustedMutation(context.req.raw.headers)
      const actor = await resolveActor(context)
      const rawBody = await context.req.text()
      const body = forkAgentSessionRequestSchema.parse(rawBody.trim().length > 0 ? JSON.parse(rawBody) : {})
      const detail = await agentSessions.forkClinicianSession(actor, context.req.param('sessionId'), body)
      return context.json(detail, 201)
    } catch (error) {
      return apiErrorResponse(context, error, 'The fork payload is invalid')
    }
  })

  app.get('/api/agents/sessions/:sessionId/events', async (context) => {
    let actor
    const sessionId = context.req.param('sessionId')
    try {
      actor = await resolveActor(context)
      // Verify session access before opening the SSE response stream.
      await agentSessions.getClinicianSession(actor, sessionId)
    } catch (error) {
      return apiErrorResponse(context, error)
    }

    context.header('Cache-Control', 'no-cache, no-transform')
    context.header('X-Accel-Buffering', 'no')
    return streamSSE(context, async (stream) => {
      const controller = new AbortController()
      const onRequestAbort = () => controller.abort()
      context.req.raw.signal.addEventListener('abort', onRequestAbort, { once: true })
      stream.onAbort(() => controller.abort())

      let writeChain = Promise.resolve()
      const enqueueEvent = (payload: AgentSessionSseEvent) => {
        if (controller.signal.aborted) return
        writeChain = writeChain.then(async () => {
          if (controller.signal.aborted) return
          await stream.writeSSE({
            event: payload.type,
            data: JSON.stringify(payload),
          })
        }).catch(() => {
          controller.abort()
        })
      }

      const heartbeat = setInterval(() => {
        enqueueEvent({ type: 'heartbeat', timestamp: new Date().toISOString() })
      }, 15_000)

      try {
        await agentSessions.watchClinicianSession(actor, sessionId, controller.signal, (detail) => {
          enqueueEvent({ type: 'snapshot', detail })
        })
        await writeChain
      } finally {
        clearInterval(heartbeat)
        context.req.raw.signal.removeEventListener('abort', onRequestAbort)
      }
    })
  })
}
