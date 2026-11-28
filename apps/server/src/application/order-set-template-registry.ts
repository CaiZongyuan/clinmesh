import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  hospitalBaselineConfigSchema,
  type DiseasePack,
  type HospitalBaselineConfig,
  type HospitalGeneralLabPanel,
} from '@clinmesh/contracts/disease-pack'
import { type PackSourceSummary } from '@clinmesh/contracts/guideline-topics'
import {
  orderSetTemplateSchema,
  type OrderSetTemplate,
  type OrderSetTemplateId,
} from '@clinmesh/contracts/order-set-templates'
import { DiseasePackRegistry } from './disease-pack-runtime-service.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

export class UnknownOrderSetTemplateError extends Error {
  readonly code = 'ORDER_SET_TEMPLATE_NOT_FOUND' as const
  readonly status = 404 as const

  constructor(readonly templateId: string) {
    super(`Unknown order set template: ${templateId}`)
    this.name = 'UnknownOrderSetTemplateError'
  }
}

export interface RegisteredOrderSetTemplateEntry {
  readonly ownerPack?: PackSourceSummary
  readonly template: OrderSetTemplate
}

let cachedHospitalConfig: HospitalBaselineConfig | undefined
let cachedDefaultOrderSetRegistry: DiseasePackRegistry | undefined

export function loadHospitalBaselineConfig(configPath?: string): HospitalBaselineConfig {
  const defaultPath = resolve(import.meta.dirname, '../../hospital-overlays/clinmesh-hospital.json')
  if (configPath === undefined && cachedHospitalConfig !== undefined) {
    return cachedHospitalConfig
  }
  const targetPath = configPath ?? defaultPath
  if (!existsSync(targetPath)) {
    throw new Error(`Missing hospital baseline config: ${targetPath}`)
  }
  const parsed = hospitalBaselineConfigSchema.parse(JSON.parse(readFileSync(targetPath, 'utf8')))
  if (configPath === undefined) {
    cachedHospitalConfig = parsed
  }
  return parsed
}

export function listHospitalGeneralLabPanels(configPath?: string): readonly HospitalGeneralLabPanel[] {
  return loadHospitalBaselineConfig(configPath).generalLabPanels
}

function getDefaultOrderSetPackRegistry(): DiseasePackRegistry {
  cachedDefaultOrderSetRegistry ??= new DiseasePackRegistry()
  return cachedDefaultOrderSetRegistry
}

function toExecutableOrderSetTemplate(raw: NonNullable<DiseasePack['orderSets']>[number]): OrderSetTemplate | null {
  if (
    raw.descriptionZh === undefined
    || raw.version === undefined
    || raw.scopes === undefined
    || raw.scopes.length === 0
    || raw.items.some(item => (
      item.options === undefined
      || item.rationaleZh === undefined
      || item.rules === undefined
      || item.scopes === undefined
      || item.titleEn === undefined
    ))
  ) {
    return null
  }
  const unsigned = {
    ...(raw.applicableProcedureCodes === undefined ? {} : { applicableProcedureCodes: raw.applicableProcedureCodes }),
    descriptionZh: raw.descriptionZh,
    id: raw.id,
    items: raw.items,
    scopes: raw.scopes,
    titleEn: raw.titleEn,
    titleZh: raw.titleZh,
    version: raw.version,
  }
  const parsed = orderSetTemplateSchema.safeParse({
    ...unsigned,
    fingerprint: canonicalJsonHash(unsigned),
  })
  return parsed.success ? parsed.data : null
}

export function listRegisteredOrderSetEntries(registry?: DiseasePackRegistry): readonly RegisteredOrderSetTemplateEntry[] {
  const effectiveRegistry = registry ?? getDefaultOrderSetPackRegistry()
  const entries: RegisteredOrderSetTemplateEntry[] = []
  const seenIds = new Set<string>()

  for (const effective of effectiveRegistry.listEffective()) {
    const ownerPack: PackSourceSummary = {
      packId: effective.pack.manifest.id,
      packVersion: effective.pack.manifest.version,
      titleZh: effective.pack.manifest.titleZh,
    }
    for (const rawOrderSet of effective.pack.orderSets ?? []) {
      const template = toExecutableOrderSetTemplate(rawOrderSet)
      if (template === null || seenIds.has(template.id)) continue
      seenIds.add(template.id)
      entries.push({ ownerPack, template })
    }
  }

  for (const rawOrderSet of loadHospitalBaselineConfig().orderSets) {
    const template = toExecutableOrderSetTemplate(rawOrderSet)
    if (template === null || seenIds.has(template.id)) continue
    seenIds.add(template.id)
    entries.push({ template })
  }

  return entries
}

export function getOrderSetTemplateEntry(
  id: OrderSetTemplateId,
  registry?: DiseasePackRegistry,
): RegisteredOrderSetTemplateEntry {
  const found = listRegisteredOrderSetEntries(registry).find(entry => entry.template.id === id)
  if (found === undefined) throw new UnknownOrderSetTemplateError(id)
  return found
}

export function listOrderSetTemplates(registry?: DiseasePackRegistry): readonly OrderSetTemplate[] {
  return listRegisteredOrderSetEntries(registry).map(entry => entry.template)
}

/** 组套定义由已注册专病包与院内基础层动态装配；指纹覆盖全部条目、候选与筛选规则。 */
export const orderSetTemplates: readonly OrderSetTemplate[] = Object.freeze(listOrderSetTemplates())

export function orderSetTemplate(id: OrderSetTemplateId, registry?: DiseasePackRegistry): OrderSetTemplate {
  return getOrderSetTemplateEntry(id, registry).template
}
