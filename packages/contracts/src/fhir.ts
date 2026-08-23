import { z } from 'zod'

export const fhirVersionSchema = z.literal('5.0.0')

export const fhirReferenceSchema = z.object({
  reference: z.string().regex(/^[A-Z][A-Za-z]+\/[A-Za-z0-9.-]{1,64}$/),
  display: z.string().min(1).optional(),
})

export const capabilityStatementSchema = z.object({
  resourceType: z.literal('CapabilityStatement'),
  url: z.url(),
  version: z.string().min(1),
  name: z.string().min(1),
  title: z.string().min(1),
  status: z.literal('active'),
  experimental: z.boolean(),
  date: z.iso.datetime({ offset: true }),
  publisher: z.string().min(1),
  kind: z.literal('instance'),
  software: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }),
  implementation: z.object({
    description: z.string().min(1),
  }),
  fhirVersion: fhirVersionSchema,
  format: z.array(z.literal('application/fhir+json')).min(1),
  rest: z.array(z.object({
    mode: z.literal('server'),
    resource: z.array(z.object({
      type: z.string().regex(/^[A-Z][A-Za-z]+$/),
    })).min(1).optional(),
  })).min(1),
})

export type FhirReference = z.infer<typeof fhirReferenceSchema>
export type CapabilityStatement = z.infer<typeof capabilityStatementSchema>
