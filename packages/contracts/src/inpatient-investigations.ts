import { z } from 'zod'
import { commandResponseSchema, imagingRequestSchema, laboratoryRequestSchema } from './his.ts'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const catalogId=z.string().min(1).max(512)
const version = z.string().regex(/^[1-9]\d*$/)
export const inpatientInvestigationsSchema = z.object({ admissionId: id, laboratoryRequests: z.array(laboratoryRequestSchema), imagingRequests: z.array(imagingRequestSchema),
  sent: z.array(z.object({ requestId: id, sentAt: z.iso.datetime({ offset: true }), sentBy: id }).strict()) }).strict()
export const inpatientInvestigationResponseSchema = commandResponseSchema(inpatientInvestigationsSchema)
export const inpatientInvestigationIssueInputSchema = z.object({ admissionId: id, encounterVersion: version, catalogVersion:z.number().int().positive(),
  selection: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('laboratory'), catalogItemId: catalogId, indicationCode: z.string().min(1).max(64) }).strict(),
    z.object({ kind: z.literal('imaging'), serviceId: catalogId, indication: z.string().trim().min(2).max(500) }).strict(),
  ]) }).strict()
export const inpatientInvestigationActionInputSchema = z.object({ admissionId: id, requestId: id, expectedRequestVersion: z.number().int().positive(),
  serviceRequestVersion: version, taskVersion: version }).strict()
export const inpatientInvestigationAcknowledgeInputSchema = inpatientInvestigationActionInputSchema.extend({ diagnosticReportId: id, diagnosticReportVersion: version }).strict()
export const inpatientInvestigationCatalogSchema = z.object({ items: z.array(z.object({ id:catalogId, kind: z.enum(['laboratory', 'imaging']), display: z.string().min(1), version: z.number().int().positive(),
  priceFen: z.number().int().positive().safe().optional(), available: z.boolean(), unavailableReason:z.enum(['unpriced','not-offered']).optional(), indicationCodes: z.array(z.string().min(1)) }).strict().refine(item=>!item.available||(item.priceFen!==undefined&&item.unavailableReason===undefined),'可开展检查须声明有效医院价格')) }).strict()
