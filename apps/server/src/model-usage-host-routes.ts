import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { hostDoctorUsageAdmissionSchema, hostDoctorUsageObservationSchema } from '@clinmesh/contracts/model-usage'
import type { ModelUsageService } from './application/model-usage-service.ts'
import { AgentIntegrationError, type AgentIntegrationService } from './application/agent-integration-service.ts'

export function installHostModelUsageRoutes(app: Hono, usage: ModelUsageService,
  integration: AgentIntegrationService, secret: string): void {
  const receiptFor = (id: string) => createHmac('sha256', secret).update(`doctor-delegation:${id}`).digest('base64url')
  app.use('/api/model-usage/host/*', async (context, next) => {
    const actual = Buffer.from(context.req.header('authorization') ?? '')
    const expected = Buffer.from(`Bearer ${secret}`)
    if (context.req.header('origin') !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return context.json({ error: { code: 'HOST_AUTH_REQUIRED' } }, 403)
    }
    return next()
  })
  app.use('/api/model-usage/host/*', bodyLimit({ maxSize: 32 * 1024 }))
  app.post('/api/model-usage/host/doctor-delegation/admit', async context => {
    try {
      const input = hostDoctorUsageAdmissionSchema.parse(await context.req.json())
      const binding = integration.doctorRecognitionContext(input.permit)
      const attemptId = usage.admitHost({ context: binding, feature: 'doctor_delegation',
        provider: input.provider, model: input.model, outputLimit: 1024, kind: 'initial',
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }) })
      if (attemptId === undefined) return context.json({ error: { code: 'HOST_ATTEMPT_ALREADY_ADMITTED' } }, 409)
      const receipt = receiptFor(attemptId)
      return context.json({ attemptId, receipt }, 201)
    } catch (error) {
      if (error instanceof AgentIntegrationError) return context.json({ error: { code: error.code } }, error.status)
      if (error instanceof z.ZodError || error instanceof SyntaxError) return context.json({ error: { code: 'HOST_INPUT_INVALID' } }, 400)
      return context.json({ error: { code: 'HOST_ADMISSION_UNAVAILABLE' } }, 503)
    }
  })
  app.post('/api/model-usage/host/doctor-delegation/observe', async context => {
    try {
      const input = hostDoctorUsageObservationSchema.parse(await context.req.json())
      const actual = Buffer.from(input.receipt)
      const expected = Buffer.from(receiptFor(input.attemptId))
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return context.json({ error: { code: 'HOST_RECEIPT_INVALID' } }, 403)
      }
      usage.observeHost(input.attemptId, input.outcome, input.phase === 'progress')
      return context.json({ recorded: true })
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) return context.json({ error: { code: 'HOST_INPUT_INVALID' } }, 400)
      return context.json({ error: { code: 'HOST_OBSERVATION_UNAVAILABLE' } }, 503)
    }
  })
}
