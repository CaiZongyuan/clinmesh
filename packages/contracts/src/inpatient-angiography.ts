import { z } from 'zod'
import { pciMeasurementSchema } from './inpatient-pci-selection.ts'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)

export const coronaryVesselSchema = z.enum(['LM', 'LAD', 'LCX', 'RCA'])

export const coronaryVesselFindingSchema = z.object({
  vessel: coronaryVesselSchema,
  segment: z.string().trim().min(1).max(200),
  stenosisPercent: z.number().finite().min(0).max(100),
  timiFlow: z.number().int().min(0).max(3),
  lesionCharacteristics: z.string().trim().min(1).max(1000),
  ffr: z.number().finite().min(0).max(1.5).nullable().optional(),
  ifr: z.number().finite().min(0).max(1.5).nullable().optional(),
}).strict()

export const inpatientAngiographyReportSchema = z.object({
  id,
  admissionId: id,
  procedureId: id,
  version: z.number().int().positive(),
  synthetic: z.literal(true),
  status: z.enum(['processing', 'final', 'partial', 'unavailable']),
  targetSite: z.string().trim().min(1).max(2000).nullable(),
  measurements: z.array(pciMeasurementSchema).max(3),
  vessels: z.array(coronaryVesselFindingSchema).max(32).default([]),
  conclusion: z.string().trim().min(1).max(2000).nullable().default(null),
  missing: z.array(z.string().min(1).max(2000)),
  issuedAt: z.iso.datetime({ offset: true }).nullable(),
}).strict()

export const inpatientAngiographyReportsSchema = z.object({
  admissionId: id,
  reports: z.array(inpatientAngiographyReportSchema),
}).strict()

export type CoronaryVessel = z.infer<typeof coronaryVesselSchema>
export type CoronaryVesselFinding = z.infer<typeof coronaryVesselFindingSchema>
export type InpatientAngiographyReport = z.infer<typeof inpatientAngiographyReportSchema>
export type InpatientAngiographyReports = z.infer<typeof inpatientAngiographyReportsSchema>
