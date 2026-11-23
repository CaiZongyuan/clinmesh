import type Database from 'better-sqlite3'
import { medicationRouteSchema, type MedicationRoute } from '@clinmesh/contracts/medication-safety'
import { deriveReferenceMedicationRoutes } from '@clinmesh/core/medication-safety'

const localHospitalDefaultRoutes: Readonly<Record<string, MedicationRoute>> = {
  'medication-enoxaparin': 'IH',
  'medication-heparin': 'IV',
  'medication-nitroglycerin': 'SL',
  'medication-pci-heparin': 'IV',
  'medication-pci-iohexol': 'IV',
  'medication-sodium-chloride': 'IVGTT',
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveLocalDefaultRoute(catalogItemId: unknown): MedicationRoute {
  return (typeof catalogItemId === 'string' && localHospitalDefaultRoutes[catalogItemId]) || 'PO'
}

function normalizeReferenceRoutes(referenceProduct: Record<string, unknown>): {
  allowedRouteCodes: MedicationRoute[]
  defaultRouteCode: MedicationRoute
} {
  const derived = deriveReferenceMedicationRoutes({
    dosageForm: typeof referenceProduct.dosageForm === 'string' ? referenceProduct.dosageForm : '',
    genericName: typeof referenceProduct.genericName === 'string' ? referenceProduct.genericName : '',
  })
  const parsedAllowed = Array.isArray(referenceProduct.allowedRouteCodes)
    ? referenceProduct.allowedRouteCodes.flatMap((entry) => {
        const parsed = medicationRouteSchema.safeParse(entry)
        return parsed.success ? [parsed.data] : []
      })
    : []
  const parsedDefault = medicationRouteSchema.safeParse(referenceProduct.defaultRouteCode)
  const defaultRouteCode = parsedDefault.success
    ? parsedDefault.data
    : parsedAllowed[0] ?? derived.defaultRouteCode
  const allowedRouteCodes = parsedAllowed.length > 0
    ? (parsedAllowed.includes(defaultRouteCode) ? parsedAllowed : [defaultRouteCode, ...parsedAllowed])
    : (derived.allowedRouteCodes.includes(defaultRouteCode) ? derived.allowedRouteCodes : [defaultRouteCode])
  return { allowedRouteCodes, defaultRouteCode }
}

export function prepareMedicationRouteMigration(driver: Database.Database, file: string): void {
  if (file !== '0119_medication-route.sql') return

  driver.function(
    'clinmesh_backfill_prescription_item_route',
    { deterministic: true },
    (medicationId: unknown, medicationSnapshotJson: unknown): MedicationRoute => {
      if (typeof medicationSnapshotJson === 'string') {
        try {
          const snapshot: unknown = JSON.parse(medicationSnapshotJson)
          if (isObject(snapshot) && typeof snapshot.dosageForm === 'string' && typeof snapshot.genericName === 'string') {
            return normalizeReferenceRoutes(snapshot).defaultRouteCode
          }
        } catch {
          // Fall back to hospital catalog mapping if snapshot JSON is not an external product.
        }
      }
      return resolveLocalDefaultRoute(medicationId)
    },
  )

  driver.function(
    'clinmesh_backfill_prescription_json_item',
    { deterministic: true },
    (itemJson: unknown): string => {
      if (typeof itemJson !== 'string') return String(itemJson ?? 'null')
      const item: unknown = JSON.parse(itemJson)
      if (!isObject(item)) return itemJson
      const parsedItemRoute = medicationRouteSchema.safeParse(item.routeCode)
      if (isObject(item.referenceProduct)) {
        const { allowedRouteCodes, defaultRouteCode } = normalizeReferenceRoutes(item.referenceProduct)
        const routeCode = parsedItemRoute.success && allowedRouteCodes.includes(parsedItemRoute.data)
          ? parsedItemRoute.data
          : defaultRouteCode
        return JSON.stringify({
          ...item,
          referenceProduct: {
            ...item.referenceProduct,
            allowedRouteCodes,
            defaultRouteCode,
          },
          routeCode,
        })
      }
      if (parsedItemRoute.success) return itemJson
      return JSON.stringify({
        ...item,
        routeCode: resolveLocalDefaultRoute(item.catalogItemId),
      })
    },
  )
}
