import { z } from 'zod'
import type { InpatientCatalogMissingField } from '@clinmesh/contracts/inpatient-clinical'

export const inpatientMedicationConfigSchema = z.object({
  availableScopes: z.array(z.string()), unit: z.string().trim().min(1),
  product: z.object({ id: z.string().min(1), system: z.string().min(1), version: z.string().min(1),
    strength: z.string().min(1), dosageForm: z.string().min(1), packageDescription: z.string().min(1) }),
  inpatientDoses: z.array(z.object({ doseText: z.string(), quantity: z.number().int().positive().max(100) })).default([]),
  inpatientDoseBasis: z.object({ amount: z.number().positive(), unit: z.string().trim().min(1) }).optional(),
  inpatientMaxDoseQuantity: z.number().int().positive().max(100).optional(),
  allowedFrequencyCodes: z.array(z.string()), allowedCombinationIds: z.array(z.string()),
  allowedDiagnosisCatalogItemIds: z.array(z.string()).default([]),
  inpatientIndications: z.array(z.object({ id: z.string(), system: z.string(), version: z.string(), code: z.string(), sourceLocator: z.string() })).default([]),
  inpatientBillingTrigger: z.literal('dispense'),
})

export function inpatientMedicationMissingFields(raw: unknown, priceFen: number): InpatientCatalogMissingField[] {
  const result = inpatientMedicationConfigSchema.safeParse(raw)
  const fields = new Set<InpatientCatalogMissingField>()
  if (!result.success) for (const issue of result.error.issues) {
    const key = issue.path[0]
    fields.add(key === 'product' ? issue.path[1] === 'strength' ? 'strength' : 'product'
      : key === 'unit' ? 'unit' : key === 'availableScopes' ? 'inpatient-scope'
        : key === 'allowedFrequencyCodes' ? 'frequency' : key === 'inpatientBillingTrigger' ? 'billing'
          : key === 'allowedCombinationIds' ? 'combination' : key === 'inpatientDoseBasis' ? 'conversion'
          : key === 'inpatientIndications' || key === 'allowedDiagnosisCatalogItemIds' ? 'indication' : 'dose-limit')
  }
  if (!Number.isSafeInteger(priceFen) || priceFen <= 0) fields.add('price')
  const record = z.record(z.string(), z.unknown()).safeParse(raw)
  const config = record.success ? record.data : {}
  const shape = inpatientMedicationConfigSchema.shape
  const scopes = shape.availableScopes.safeParse(config.availableScopes)
  if (scopes.success && !scopes.data.includes('inpatient')) fields.add('inpatient-scope')
  const doses = shape.inpatientDoses.safeParse(config.inpatientDoses), maximum = shape.inpatientMaxDoseQuantity.safeParse(config.inpatientMaxDoseQuantity)
  if (maximum.success && maximum.data === undefined && doses.success && doses.data.length === 0) fields.add('dose-limit')
  const frequencies = shape.allowedFrequencyCodes.safeParse(config.allowedFrequencyCodes)
  if (frequencies.success && !frequencies.data.some(code => ['QD', 'BID', 'PRN'].includes(code))) fields.add('frequency')
  const diagnoses = shape.allowedDiagnosisCatalogItemIds.safeParse(config.allowedDiagnosisCatalogItemIds), indications = shape.inpatientIndications.safeParse(config.inpatientIndications)
  if (diagnoses.success && indications.success && diagnoses.data.length === 0 && indications.data.length === 0) fields.add('indication')
  return [...fields]
}
