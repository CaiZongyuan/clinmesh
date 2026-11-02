import { z } from 'zod'
import { pciMeasurementSchema } from './inpatient-pci-selection.ts'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
export const inpatientAngiographyReportSchema = z.object({
  id, admissionId: id, procedureId: id, version: z.number().int().positive(), synthetic: z.literal(true),
  status: z.enum(['processing', 'final', 'partial', 'unavailable']),
  targetSite: z.string().trim().min(1).max(2000).nullable(), measurements: z.array(pciMeasurementSchema).max(3),
  missing: z.array(z.string().min(1).max(2000)), issuedAt: z.iso.datetime({ offset: true }).nullable(),
}).strict()
export const inpatientAngiographyReportsSchema = z.object({ admissionId: id, reports: z.array(inpatientAngiographyReportSchema) }).strict()
