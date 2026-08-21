import { z } from 'zod'

export const healthResponseSchema = z.object({
  service: z.literal('clinmesh-server'),
  status: z.literal('ok'),
  fhirVersion: z.literal('5.0.0'),
})

export type HealthResponse = z.infer<typeof healthResponseSchema>
