import { z } from 'zod'

export const fhirVersionSchema = z.literal('5.0.0')

export const fhirReferenceSchema = z.object({
  reference: z.string().regex(/^[A-Z][A-Za-z]+\/[A-Za-z0-9.-]{1,64}$/),
  display: z.string().min(1).optional(),
})

export const fhirResourceSchema = z.object({
  resourceType: z.string().regex(/^[A-Z][A-Za-z]+$/),
  id: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/),
  meta: z.object({
    versionId: z.string().regex(/^\d+$/),
    lastUpdated: z.iso.datetime({ offset: true }),
  }).loose().optional(),
}).loose()

export const operationOutcomeSchema = z.object({
  resourceType: z.literal('OperationOutcome'),
  issue: z.array(z.object({
    severity: z.enum(['fatal', 'error', 'warning', 'information', 'success']),
    code: z.string().min(1),
    diagnostics: z.string().min(1).optional(),
  }).loose()).min(1),
}).loose()

export const fhirBundleSchema = z.object({
  resourceType: z.literal('Bundle'),
  type: z.enum(['searchset', 'history']),
  total: z.number().int().nonnegative().optional(),
  link: z.array(z.object({
    relation: z.string().min(1),
    url: z.url(),
  })).optional(),
  entry: z.array(z.object({
    fullUrl: z.url().optional(),
    resource: fhirResourceSchema,
  })).optional(),
}).loose()

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
      documentation: z.string().min(1).optional(),
      interaction: z.array(z.object({
        code: z.enum(['read', 'vread', 'update', 'create', 'history-instance', 'search-type']),
      })).optional(),
      searchParam: z.array(z.object({
        name: z.string().min(1),
        definition: z.url(),
        type: z.enum(['number', 'date', 'string', 'token', 'reference', 'composite', 'quantity', 'uri', 'special']),
      })).optional(),
    })).min(1).optional(),
  })).min(1),
})

export type FhirReference = z.infer<typeof fhirReferenceSchema>
export type FhirResource = z.infer<typeof fhirResourceSchema>
export type FhirBundle = z.infer<typeof fhirBundleSchema>
export type OperationOutcome = z.infer<typeof operationOutcomeSchema>
export type CapabilityStatement = z.infer<typeof capabilityStatementSchema>
