import type {
  ScenarioDatasetContent,
  ScenarioDiagnostic,
} from '@clinmesh/contracts/scenario'

export function validateScenarioDataset(content: ScenarioDatasetContent): ScenarioDiagnostic[] {
  const catalogItemIds = new Set([
    ...content.catalog.departments.map(item => item.id),
    ...content.catalog.investigations.map(item => item.id),
    ...content.catalog.medications.map(item => item.id),
  ])
  return content.inventory.flatMap((lot, index) => catalogItemIds.has(lot.itemId) ? [] : [{
    code: 'CATALOG_REFERENCE_MISSING',
    message: `Inventory item ${lot.itemId} does not reference a catalog item`,
    path: `inventory[${index}].itemId`,
    severity: 'error' as const,
  }])
}
