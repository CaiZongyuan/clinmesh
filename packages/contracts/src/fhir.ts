import { z } from 'zod'

export const fhirReferenceSchema = z.object({
  reference: z.string().regex(/^[A-Z][A-Za-z]+\/[A-Za-z0-9.-]{1,64}$/),
  display: z.string().min(1).optional(),
})

export type FhirReference = z.infer<typeof fhirReferenceSchema>
