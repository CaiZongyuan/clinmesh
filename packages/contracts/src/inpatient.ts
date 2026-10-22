import { z } from 'zod'
import { commandResponseSchema } from './his.ts'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const version = z.string().regex(/^\d+$/)
const fen = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const inpatientAdmissionRouteSchema = z.enum(['direct', 'outpatient', 'transfer'])
export const inpatientAdmissionSchema = z.object({
  id, patientId: id, patientName: z.string(), inpatientNumber: z.string().min(1),
  admissionRoute: inpatientAdmissionRouteSchema, referralId: id.optional(),
  wardId: id, organizationId: id, bedId: id.optional(),
  status: z.enum(['registered', 'admitted', 'discharge-pending', 'departed', 'cleared']),
  financialStatus: z.enum(['open', 'settled']), recordStatus: z.enum(['open', 'reviewed', 'archived']),
  admittedAt: z.iso.datetime({ offset: true }).optional(), registeredAt: z.iso.datetime({ offset: true }),
  depositFen: fen, chargesFen: fen, versionId: version,
}).strict()
export type InpatientAdmission = z.infer<typeof inpatientAdmissionSchema>
export const inpatientListSchema = z.object({ items: z.array(inpatientAdmissionSchema) }).strict()
export const inpatientDetailSchema = z.object({ admission: inpatientAdmissionSchema }).strict()
export const inpatientCommandResponseSchema = commandResponseSchema(inpatientDetailSchema)
export const inpatientRegistrationInputSchema = z.object({
  expectedEpoch: z.string().min(1).max(128),
  patientId: id, patientVersion: version, admissionRoute: inpatientAdmissionRouteSchema,
  wardId: id, depositFen: fen, referralId: id.optional(), sourceEncounterId: id.optional(),
}).strict().refine(input => input.admissionRoute === 'outpatient' ? input.referralId !== undefined : input.referralId === undefined,
  '门诊转收必须引用住院证，其他入院途径不得引用住院证')
export const inpatientReferralSchema = z.object({ id, patientId: id, patientName: z.string(), patientVersion: version, encounterId: id,
  wardId: id, reason: z.string().min(1), status: z.enum(['issued', 'received']),
  issuedAt: z.iso.datetime({ offset: true }),
}).strict()
export const inpatientReferralListSchema = z.object({ items: z.array(inpatientReferralSchema) }).strict()
export const inpatientReferralResponseSchema = commandResponseSchema(z.object({ referral: inpatientReferralSchema }).strict())
export const inpatientReferralInputSchema = z.object({ encounterId: id, encounterVersion: version,
  wardId: id, reason: z.string().trim().min(1).max(2000) }).strict()
export const inpatientBedInputSchema = z.object({ admissionId: id, encounterVersion: version, bedId: id }).strict()
export const inpatientSwapInputSchema = z.object({ admissionId: id, encounterVersion: version,
  otherAdmissionId: id, otherEncounterVersion: version }).strict()
export const inpatientSwapResponseSchema = commandResponseSchema(z.object({
  admission: inpatientAdmissionSchema, otherAdmission: inpatientAdmissionSchema,
}).strict())
export const inpatientCatalogSchema = z.object({
  wards: z.array(z.object({ id, name: z.string(), organizationId: id, acceptingAdmissions: z.boolean().optional() }).strict()),
  beds: z.array(z.object({ id, wardId: id, roomId: id, name: z.string(), dailyPriceFen: fen,
    admissionId: id.optional() }).strict()),
}).strict()
export const advanceVirtualTimeInputSchema = z.object({
  expectedVirtualTime: z.iso.datetime({ offset: true }), targetVirtualTime: z.iso.datetime({ offset: true }),
}).strict()
export const advanceVirtualTimeResponseSchema = commandResponseSchema(z.object({
  virtualTime: z.iso.datetime({ offset: true }), clockRevision: z.number().int().positive(), bedChargesCreated: z.number().int().nonnegative(),
}).strict())
