import { z } from 'zod'
import type { InpatientCatalogMissingField } from '@clinmesh/contracts/inpatient-clinical'
import { laboratoryServiceSnapshotSchema } from '@clinmesh/contracts/his'

export const inpatientInvestigationBillingSchema = z.object({ id: z.string().min(1), display: z.string().min(1), priceFen: z.number().int().positive().safe(), currency: z.literal('CNY'),
  trigger: z.literal('execution-completed'), source: z.string().min(1), availableScopes: z.array(z.string()).refine(value => value.includes('inpatient')) }).passthrough()

export function inpatientLaboratoryConfiguration(raw: unknown) {
  const record = z.record(z.string(), z.unknown()).safeParse(raw)
  const config = record.success ? record.data : {}
  const service = laboratoryServiceSnapshotSchema.safeParse(config.laboratoryService)
  const billing = inpatientInvestigationBillingSchema.safeParse(config.inpatientInvestigationBilling)
  const scopes = z.array(z.string()).safeParse(config.availableScopes)
  const charge = z.object({ id: z.string().min(1), currency: z.literal('CNY'), priceFen: z.number().int().positive().safe() }).passthrough().safeParse(config.chargeDefinition)
  const missingFields: InpatientCatalogMissingField[] = []
  if (!service.success) missingFields.push('laboratory-definition')
  else if (!service.data.doctorOrderable) missingFields.push('not-orderable')
  if (!z.object({ display: z.string().trim().min(1) }).safeParse(config.billingUnit).success) missingFields.push('unit')
  const inpatient = scopes.success && scopes.data.includes('inpatient')
  if (!billing.success && !inpatient) missingFields.push('inpatient-scope')
  if (config.inpatientInvestigationBilling !== undefined && !billing.success) missingFields.push('billing')
  const chargeDefinition = billing.success ? billing.data
    : config.inpatientInvestigationBilling === undefined && inpatient && charge.success ? charge.data : undefined
  const priceFen = chargeDefinition?.priceFen
  if (priceFen === undefined) missingFields.push('price')
  return { missingFields, ...(service.success ? { service: service.data } : {}), ...(chargeDefinition === undefined ? {} : { priceFen, chargeDefinition }) }
}
