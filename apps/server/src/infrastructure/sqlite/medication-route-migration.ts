import type Database from 'better-sqlite3'
import { medicationRouteSchema, type MedicationRoute } from '@clinmesh/contracts/medication-safety'
import { deriveReferenceMedicationRoutes } from '@clinmesh/core/medication-safety'
import { resolveCatalogMedicationRoutes } from '../../application/inpatient-medication-config.ts'

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

function parseRouteList(raw: unknown): MedicationRoute[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const parsed = medicationRouteSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

function parseCatalogRowRoutes(nameZh: string, configJson: string): {
  allowedRouteCodes: MedicationRoute[]
  defaultRouteCode: MedicationRoute
} {
  try {
    const parsed: unknown = JSON.parse(configJson)
    if (isObject(parsed)) {
      const parsedDefault = medicationRouteSchema.safeParse(parsed.defaultRouteCode)
      const parsedAllowed = parseRouteList(parsed.allowedRouteCodes)
      const product = isObject(parsed.product) && typeof parsed.product.dosageForm === 'string'
        ? { dosageForm: parsed.product.dosageForm }
        : undefined
      return resolveCatalogMedicationRoutes({
        ...(parsedAllowed.length > 0 ? { allowedRouteCodes: parsedAllowed } : {}),
        ...(parsedDefault.success ? { defaultRouteCode: parsedDefault.data } : {}),
        ...(product === undefined ? {} : { product }),
        ...(typeof parsed.route === 'string' ? { route: parsed.route } : {}),
      }, nameZh)
    }
  } catch {
    // Fall back to generic-name derivation if legacy config JSON cannot be parsed.
  }
  return deriveReferenceMedicationRoutes({ dosageForm: '', genericName: nameZh })
}

function resolveFallbackLocalRoutes(catalogItemId: unknown, display: unknown): {
  allowedRouteCodes: MedicationRoute[]
  defaultRouteCode: MedicationRoute
} {
  if (typeof catalogItemId === 'string' && catalogItemId in localHospitalDefaultRoutes) {
    const route = localHospitalDefaultRoutes[catalogItemId]!
    return { allowedRouteCodes: [route], defaultRouteCode: route }
  }
  if (typeof display === 'string' && display.trim() !== '') {
    return deriveReferenceMedicationRoutes({ dosageForm: '', genericName: display })
  }
  return { allowedRouteCodes: ['PO'], defaultRouteCode: 'PO' }
}

function normalizeReferenceRoutes(referenceProduct: Record<string, unknown>): {
  allowedRouteCodes: MedicationRoute[]
  defaultRouteCode: MedicationRoute
} {
  const derived = deriveReferenceMedicationRoutes({
    dosageForm: typeof referenceProduct.dosageForm === 'string' ? referenceProduct.dosageForm : '',
    genericName: typeof referenceProduct.genericName === 'string' ? referenceProduct.genericName : '',
  })
  const parsedAllowed = parseRouteList(referenceProduct.allowedRouteCodes)
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

  const catalogRoutes = new Map<string, { allowedRouteCodes: MedicationRoute[]; defaultRouteCode: MedicationRoute }>()
  const hasOutpatientCatalog = driver.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'outpatient_catalog'",
  ).get() !== undefined
  if (hasOutpatientCatalog) {
    const rows = driver.prepare(
      "SELECT workspace_id, epoch, item_id, name_zh, config_json FROM outpatient_catalog WHERE kind = 'medication'",
    ).all() as Array<{ config_json: string; epoch: string; item_id: string; name_zh: string; workspace_id: string }>
    for (const row of rows) {
      catalogRoutes.set(`${row.workspace_id}\0${row.epoch}\0${row.item_id}`, parseCatalogRowRoutes(row.name_zh, row.config_json))
    }
  }

  const lookupLocalRoutes = (workspaceId: unknown, epoch: unknown, catalogItemId: unknown, display: unknown) => {
    if (typeof workspaceId === 'string' && typeof epoch === 'string' && typeof catalogItemId === 'string') {
      const matched = catalogRoutes.get(`${workspaceId}\0${epoch}\0${catalogItemId}`)
      if (matched !== undefined) return matched
    }
    return resolveFallbackLocalRoutes(catalogItemId, display)
  }

  driver.function(
    'clinmesh_backfill_prescription_item_route',
    { deterministic: true },
    (workspaceId: unknown, epoch: unknown, medicationId: unknown, medicationSnapshotJson: unknown): MedicationRoute => {
      let snapshotDisplay: unknown
      if (typeof medicationSnapshotJson === 'string') {
        try {
          const snapshot: unknown = JSON.parse(medicationSnapshotJson)
          if (isObject(snapshot)) {
            if (typeof snapshot.dosageForm === 'string' && typeof snapshot.genericName === 'string') {
              return normalizeReferenceRoutes(snapshot).defaultRouteCode
            }
            snapshotDisplay = snapshot.display
          }
        } catch {
          // Fall back to outpatient_catalog lookup when snapshot JSON is not structured.
        }
      }
      return lookupLocalRoutes(workspaceId, epoch, medicationId, snapshotDisplay).defaultRouteCode
    },
  )

  driver.function(
    'clinmesh_backfill_inpatient_order_route',
    { deterministic: true },
    (workspaceId: unknown, epoch: unknown, kind: unknown, catalogItemId: unknown, display: unknown): MedicationRoute | null => {
      if (kind === 'service') return null
      return lookupLocalRoutes(workspaceId, epoch, catalogItemId, display).defaultRouteCode
    },
  )

  driver.function(
    'clinmesh_backfill_prescription_json_item',
    { deterministic: true },
    (workspaceId: unknown, epoch: unknown, itemJson: unknown): string => {
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
      const { allowedRouteCodes, defaultRouteCode } = lookupLocalRoutes(workspaceId, epoch, item.catalogItemId, item.display)
      if (parsedItemRoute.success && allowedRouteCodes.includes(parsedItemRoute.data)) return itemJson
      return JSON.stringify({
        ...item,
        routeCode: defaultRouteCode,
      })
    },
  )

  driver.function(
    'clinmesh_backfill_inpatient_json_order',
    { deterministic: true },
    (workspaceId: unknown, epoch: unknown, itemJson: unknown): string => {
      if (typeof itemJson !== 'string') return String(itemJson ?? 'null')
      const item: unknown = JSON.parse(itemJson)
      if (!isObject(item) || item.kind !== 'medication') return itemJson
      const parsedItemRoute = medicationRouteSchema.safeParse(item.routeCode)
      const { allowedRouteCodes, defaultRouteCode } = lookupLocalRoutes(workspaceId, epoch, item.catalogItemId, item.display)
      if (parsedItemRoute.success && allowedRouteCodes.includes(parsedItemRoute.data)) return itemJson
      return JSON.stringify({
        ...item,
        routeCode: defaultRouteCode,
      })
    },
  )
}
