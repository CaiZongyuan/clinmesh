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
          : key === 'inpatientIndications' || key === 'allowedDiagnosisCatalogItemIds' ? 'indication' : 'dose-limit')
  }
  if (!Number.isSafeInteger(priceFen) || priceFen <= 0) fields.add('price')
  if (result.success) {
    const config = result.data
    if (!config.availableScopes.includes('inpatient')) fields.add('inpatient-scope')
    if (!(config.inpatientMaxDoseQuantity ?? Math.max(0, ...config.inpatientDoses.map(dose => dose.quantity)))) fields.add('dose-limit')
    if (!config.allowedFrequencyCodes.some(code => ['QD', 'BID', 'PRN'].includes(code))) fields.add('frequency')
    if (config.allowedDiagnosisCatalogItemIds.length === 0 && config.inpatientIndications.length === 0) fields.add('indication')
  }
  return [...fields]
}
