import { z } from 'zod'
import { inpatientCatalogSearchInputSchema, inpatientCatalogSearchSchema, type InpatientCatalogCandidate, type InpatientCatalogMissingField } from '@clinmesh/contracts/inpatient-clinical'
import { laboratoryServiceSnapshotSchema } from '@clinmesh/contracts/his'
import type { ActorContext } from './command-executor.ts'
import type { InpatientService } from './inpatient-service.ts'
import { inpatientMedicationMissingFields } from './inpatient-medication-config.ts'

const rowSchema = z.object({ id: z.string(), name_zh: z.string(), version: z.number().int().positive(), active: z.number(),
  price_fen: z.number().int().nonnegative(), config_json: z.string() })
type CatalogRow = z.infer<typeof rowSchema>
const billingSchema = z.object({ display: z.string().min(1), priceFen: z.number().int().positive().safe(), currency: z.literal('CNY'),
  trigger: z.literal('execution-completed'), source: z.string().min(1), availableScopes: z.array(z.string()).refine(value => value.includes('inpatient')) })

export function inpatientLaboratoryConfiguration(raw: unknown) {
  const config = z.object({ laboratoryService: z.unknown().optional(), billingUnit: z.unknown().optional(),
    availableScopes: z.array(z.string()).optional(), inpatientInvestigationBilling: z.unknown().optional(),
    chargeDefinition: z.object({ priceFen: z.number().int().nonnegative() }).optional() }).parse(raw)
  const service = laboratoryServiceSnapshotSchema.safeParse(config.laboratoryService)
  const billing = billingSchema.safeParse(config.inpatientInvestigationBilling)
  const missingFields: InpatientCatalogMissingField[] = []
  if (!service.success) missingFields.push('laboratory-definition')
  else if (!service.data.doctorOrderable) missingFields.push('not-orderable')
  if (!z.object({ display: z.string().trim().min(1) }).safeParse(config.billingUnit).success) missingFields.push('unit')
  if (!billing.success && !config.availableScopes?.includes('inpatient')) missingFields.push('inpatient-scope')
  const priceFen = billing.success ? billing.data.priceFen : config.availableScopes?.includes('inpatient') ? config.chargeDefinition?.priceFen : undefined
  if (priceFen === undefined || priceFen <= 0) missingFields.push('price')
  return { missingFields, ...(service.success ? { service: service.data } : {}), ...(priceFen === undefined ? {} : { priceFen }) }
}

/** 共享目录候选按真实来源分别分页，写入身份只来自可用的院内配置。 */
export class InpatientCatalogSearch {
  constructor(readonly owner: InpatientService) {}

  search(context: ActorContext, raw: unknown) {
    this.owner.assertReadRole(context, ['inpatient-doctor'])
    const input = inpatientCatalogSearchInputSchema.parse(raw)
    if (input.source === 'hospital') {
      const medication = input.kind === 'medication'
      const table = medication ? 'outpatient_catalog' : 'hospital_service_catalog', id = medication ? 'item_id' : 'service_id'
      const where = `workspace_id=? AND epoch=? AND ${medication ? "kind='medication'" : "(json_type(config_json,'$.laboratoryService')='object' OR json_array_length(config_json,'$.requestCatalogItemIds')>0)"}
        AND (instr(lower(name_zh),lower(?))>0 OR instr(lower(${medication ? 'code' : 'service_id'}),lower(?))>0)`
      const params = [context.workspaceId, context.epoch, input.query ?? '', input.query ?? '']
      const total = z.object({ total: z.number().int().nonnegative() }).parse(this.owner.database.driver.prepare(`SELECT COUNT(*) total FROM ${table} WHERE ${where}`).get(...params)).total
      const rows = z.array(rowSchema).parse(this.owner.database.driver.prepare(`SELECT ${id} id,name_zh,version,active,${medication ? 'price_fen' : '0'} price_fen,config_json FROM ${table} WHERE ${where}
        ORDER BY name_zh,${id} LIMIT ? OFFSET ?`).all(...params, input.pageSize, (input.page - 1) * input.pageSize))
      return inpatientCatalogSearchSchema.parse({ kind: input.kind, source: input.source, page: input.page, pageSize: input.pageSize,
        total, items: rows.map(row => this.candidate(context, input.kind, row)) })
    }
    const query = { page: input.page, pageSize: input.pageSize, ...(input.query === undefined ? {} : { query: input.query }) }
    const reference = input.kind === 'medication' ? this.owner.referenceData.searchMedications(context, query) : this.owner.referenceData.searchLaboratory(context, query)
    const items = reference.items.map(item => {
      const medication = input.kind === 'medication'
      const referencePath = medication ? 'product' : 'laboratoryService.referenceConcept'
      const table = medication ? 'outpatient_catalog' : 'hospital_service_catalog', id = medication ? 'item_id' : 'service_id'
      const rows = z.array(rowSchema).parse(this.owner.database.driver.prepare(`SELECT ${id} id,name_zh,version,active,${medication ? 'price_fen' : '0'} price_fen,config_json FROM ${table}
        WHERE workspace_id=? AND epoch=? ${medication ? "AND kind='medication'" : ''}
        AND json_extract(config_json,'$.${referencePath}.id')=? AND json_extract(config_json,'$.${referencePath}.system')=? AND json_extract(config_json,'$.${referencePath}.version')=?
        ORDER BY ${id} LIMIT 2`).all(context.workspaceId, context.epoch, item.id, item.system, item.version))
      const display = 'genericName' in item ? `${item.genericName} · ${item.strength} · ${item.manufacturer}` : item.display
      if (item.status === 'inactive') return { id: item.id, referenceId: item.id, display, status: 'inactive' as const, missingFields: [] }
      if (rows.length !== 1) return { id: item.id, referenceId: item.id, display, status: 'incomplete' as const,
        missingFields: rows.length > 1 ? ['ambiguous-mapping'] : medication
          ? ['hospital-mapping', 'unit', 'price', 'inpatient-scope', 'dose-limit', 'frequency', 'indication', 'billing']
          : ['hospital-mapping', 'laboratory-definition', 'unit', 'price', 'inpatient-scope'] }
      return { ...this.candidate(context, input.kind, rows[0]!), id: item.id, referenceId: item.id, display }
    })
    return inpatientCatalogSearchSchema.parse({ kind: input.kind, source: input.source, page: input.page, pageSize: input.pageSize,
      releaseId: reference.releaseId, total: reference.total, items })
  }

  private candidate(context: ActorContext, kind: 'medication' | 'laboratory', row: CatalogRow): InpatientCatalogCandidate {
    const config: unknown = JSON.parse(row.config_json)
    const laboratory = kind === 'laboratory' ? inpatientLaboratoryConfiguration(config) : undefined
    const missingFields = laboratory?.missingFields ?? inpatientMedicationMissingFields(config, row.price_fen)
    const status = row.active !== 1 ? 'inactive' : missingFields.length > 0 ? 'incomplete' : 'available'
    const base = { id: row.id, display: row.name_zh, status, missingFields } as const
    if (status !== 'available') return base
    return { ...base, catalogItemId: row.id, catalogVersion: row.version,
      ...(kind === 'medication' ? { medication: this.owner.orders.medications(context, [row.id])[0]! }
        : { laboratory: { indicationCodes: laboratory!.service!.allowedIndicationCodes, priceFen: laboratory!.priceFen! } }) }
  }
}
