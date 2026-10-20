import { z } from 'zod'
import { commandResponseSchema } from './his.ts'
const id=z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const version=z.string().regex(/^[1-9]\d*$/)
export const inpatientTransferSchema=z.object({id,admissionId:id,sourceWardId:id,sourceOrganizationId:id,targetWardId:id,targetOrganizationId:id,reason:z.string().min(1),
  status:z.enum(['requested','handed-over','completed','cancelled']),version:z.number().int().positive(),taskVersion:version,requestedAt:z.iso.datetime({offset:true}),
  handedOverAt:z.iso.datetime({offset:true}).optional(),receivedAt:z.iso.datetime({offset:true}).optional(),bedId:id.optional()}).strict()
export const inpatientTransfersSchema=z.object({admissionId:id,transfers:z.array(inpatientTransferSchema)}).strict()
export const inpatientTransferResponseSchema=commandResponseSchema(inpatientTransfersSchema)
export const inpatientTransferRequestInputSchema=z.object({admissionId:id,encounterVersion:version,targetWardId:id,reason:z.string().trim().min(1).max(2000)}).strict()
export const inpatientTransferActionInputSchema=z.object({admissionId:id,encounterVersion:version,transferId:id,expectedTransferVersion:z.number().int().positive()}).strict()
export const inpatientTransferReceiveInputSchema=inpatientTransferActionInputSchema.extend({bedId:id}).strict()
export const inpatientIncomingTransfersSchema=z.object({items:z.array(z.object({admissionId:id,patientName:z.string(),inpatientNumber:id,encounterVersion:version,transfer:inpatientTransferSchema}).strict())}).strict()
export const inpatientTransferCatalogSchema=z.object({wards:z.array(z.object({id,name:z.string(),organizationId:id}).strict()),beds:z.array(z.object({id,wardId:id,name:z.string(),available:z.boolean()}).strict())}).strict()
