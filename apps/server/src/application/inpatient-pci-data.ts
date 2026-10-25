import { z } from 'zod'
import { inpatientPciDataSchema, inpatientPciDataPrepareRequestSchema } from '@clinmesh/contracts/inpatient-pci-data'
import type { ActorContext, CommandEffect } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
import { pciDataPackage } from './scenario-data/pci-data.ts'
import { storeMaterialSnapshot } from './scenario-data/cardiovascular-materials.ts'

const catalogRow = z.object({ item_id: z.string(), version: z.number(), active: z.number(), price_fen: z.number(), config_json: z.string() })
const serviceRow = z.object({ service_id: z.string(), version: z.number(), config_json: z.string() })

/** 固定 PCI 数据准备；不生成患者、就诊或临床事实。 */
export class InpatientPciData {
  constructor(readonly owner: InpatientService) {}

  read(context: ActorContext) {
    this.owner.assertReadRole(context, ['administrator', 'inpatient-doctor'])
    const medications = pciDataPackage.medications.flatMap(definition => {
      const row = this.medication(context, definition.product)
      if (row === undefined) return []
      const config = z.object({ unit: z.string().nullish(), availableScopes: z.array(z.string()).optional(),
        inpatientIndications: z.array(z.object({ id: z.string(), system: z.string(), version: z.string() })).optional(),
        allowedCombinationIds: z.array(z.string()).optional(), allowedFrequencyCodes: z.array(z.string()).optional(),
      }).parse(JSON.parse(row.config_json))
      const conflicts: string[] = []
      if (row.active === 0) conflicts.push('inactive')
      if (!config.availableScopes?.includes('inpatient')) conflicts.push('scope-disabled')
      if (config.unit !== definition.hospitalSupplement.unit) conflicts.push('unit-mismatch')
      if (row.price_fen <= 0) conflicts.push('unpriced')
      if (!config.inpatientIndications?.some(coding => coding.id === pciDataPackage.diagnosis.id && coding.system === pciDataPackage.diagnosis.system && coding.version === pciDataPackage.diagnosis.version)) conflicts.push('indication-restricted')
      if (!definition.hospitalSupplement.frequencyCodes.some(code => config.allowedFrequencyCodes?.includes(code))) conflicts.push('frequency-restricted')
      if (pciDataPackage.medications.some(other => other.id !== definition.id && !config.allowedCombinationIds?.includes(this.medication(context, other.product)?.item_id ?? other.id))) conflicts.push('combination-restricted')
      return [{ definitionId: definition.id, catalogItemId: row.item_id, version: row.version,
        active: row.active === 1, priceFen: row.price_fen, unit: config.unit ?? null, availableScopes: config.availableScopes ?? [], conflicts,
        lots: z.array(z.object({ id: z.string(), version: z.number(), quantityOnHand: z.number(), expiresOn: z.string() })).parse(this.owner.database.driver.prepare(
          'SELECT lot_id id,version,quantity_on_hand quantityOnHand,expires_on expiresOn FROM inventory_lot WHERE workspace_id=? AND epoch=? AND medication_id=? ORDER BY lot_id')
          .all(context.workspaceId, context.epoch, row.item_id)) }]
    })
    const laboratories = pciDataPackage.laboratories.flatMap(definition => {
      const row = this.laboratory(context, definition.referenceConcept)
      return row === undefined ? [] : [{ definitionId: definition.id, catalogItemId: row.service_id, version: row.version }]
    })
    const materialIds = pciDataPackage.materials.flatMap(({ item }) => this.owner.database.driver.prepare(
      'SELECT 1 FROM inpatient_surgery_catalog WHERE workspace_id=? AND epoch=? AND item_id=? AND kind=\'material\'')
      .get(context.workspaceId, context.epoch, item.id) === undefined ? [] : [item.id])
    return inpatientPciDataSchema.parse({ package: pciDataPackage, contentHash: canonicalJsonHash(pciDataPackage), installed: { medications, laboratories, materialIds } })
  }

  prepare(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientPciDataPrepareRequestSchema.shape.input.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.pci-data.prepare', expectedVersions: {},
      dataSchema: inpatientPciDataSchema, authorize: () => {
        this.owner.assertRole(context, ['administrator'])
        if (input.expectedEpoch !== context.epoch) throw new InpatientError('INPATIENT_PCI_EPOCH_CONFLICT', 'PCI 数据准备的 Epoch 已变化，请刷新后重试')
      } }, () => {
      const effects: CommandEffect[] = []
      this.prepareMedications(context, effects)
      this.prepareLaboratories(context, effects)
      for (const { item } of pciDataPackage.materials) {
        const result = this.owner.database.driver.prepare(`INSERT INTO inpatient_surgery_catalog
          (workspace_id,epoch,item_id,kind,version,snapshot_json) VALUES(?,?,?,'material',?,?)
          ON CONFLICT(workspace_id,epoch,item_id) DO NOTHING`)
          .run(context.workspaceId, context.epoch, item.id, item.version, JSON.stringify(storeMaterialSnapshot(item)))
        if (result.changes === 1) effects.push({ kind: 'created', reference: `InpatientMaterial/${item.id}`, versionId: String(item.version) })
      }
      return { data: this.read(context), effects }
    })
  }

  private prepareLaboratories(context: ActorContext, effects: CommandEffect[]) {
    for (const definition of pciDataPackage.laboratories) {
      const current = this.laboratory(context, definition.referenceConcept)
      const serviceId = current?.service_id ?? definition.id
      const old = current === undefined ? {} : z.record(z.string(), z.json()).parse(JSON.parse(current.config_json))
      const previousPrice = z.object({ chargeDefinition: z.object({ priceFen: z.number().int().positive().safe() }).optional() }).safeParse(old)
      const priceFen = previousPrice.success ? previousPrice.data.chargeDefinition?.priceFen ?? definition.priceFen : definition.priceFen
      const billing = { id: `inpatient-charge-${serviceId}`, version: 1, display: definition.nameZh, priceFen, currency: 'CNY', trigger: 'execution-completed',
        source: priceFen === definition.priceFen ? `synthetic-pci-${pciDataPackage.version}` : 'published-hospital-price', availableScopes: ['inpatient'], effectiveOn: '2026-10-25' }
      const config = { ...old,
        ...(old.availableScopes === undefined ? { availableScopes: ['outpatient', 'inpatient'] } : {}),
        ...(old.laboratoryService === undefined ? { laboratoryService: definition } : {}),
        ...(old.inpatientInvestigationBilling === undefined || old.inpatientInvestigationBilling === null ? { inpatientInvestigationBilling: billing } : {}),
        ...(old.pciDataSupplement === undefined ? { pciDataSupplement: { synthetic: true, packageId: pciDataPackage.id, version: pciDataPackage.version, referenceRanges: 'synthetic-hospital' } } : {}),
      }
      if (current === undefined) {
        const inserted = this.owner.database.driver.prepare(`INSERT INTO hospital_service_catalog(workspace_id,epoch,service_id,code,name_zh,name_en,version,active,config_json)
          VALUES(?,?,?,?,?,?,1,1,?) ON CONFLICT(workspace_id,epoch,service_id) DO NOTHING`)
          .run(context.workspaceId, context.epoch, serviceId, definition.localCode, definition.nameZh, definition.nameZh, JSON.stringify(config))
        if (inserted.changes !== 1) throw new InpatientError('INPATIENT_PCI_CATALOG_AMBIGUOUS', 'PCI 检验院内 ID 已被其他项目占用')
        effects.push({ kind: 'created', reference: `HospitalService/${serviceId}`, versionId: '1' })
      } else if (JSON.stringify(config) !== JSON.stringify(old)) {
        this.owner.database.driver.prepare('UPDATE hospital_service_catalog SET config_json=?,version=version+1 WHERE workspace_id=? AND epoch=? AND service_id=? AND version=?')
          .run(JSON.stringify(config), context.workspaceId, context.epoch, serviceId, current.version)
        effects.push({ kind: 'updated', reference: `HospitalService/${serviceId}`, versionId: String(current.version + 1) })
      }
    }
  }

  private prepareMedications(context: ActorContext, effects: CommandEffect[]) {
    const database = this.owner.database.driver
    const identities = new Map(pciDataPackage.medications.map(definition => [definition.id, this.medication(context, definition.product)?.item_id ?? definition.id]))
    for (const definition of pciDataPackage.medications) {
      const current = this.medication(context, definition.product)
      const itemId = identities.get(definition.id)!
      const supplement = definition.hospitalSupplement
      const { sourceLocator: _sourceLocator, status: _status, ...productSnapshot } = definition.product
      const defaults = {
        product: productSnapshot, availableScopes: ['outpatient', 'inpatient'], unit: supplement.unit,
        dose: supplement.suggestedDoseText, frequency: supplement.frequencyCodes[0], route: supplement.route,
        inpatientDoses: [{ doseText: supplement.suggestedDoseText, quantity: supplement.suggestedQuantity }],
        inpatientDoseBasis: supplement.doseBasis, inpatientMaxDoseQuantity: supplement.maxDoseQuantity,
        allowedDoseTexts: [supplement.suggestedDoseText], allowedFrequencyCodes: supplement.frequencyCodes,
        allowedCombinationIds: [...identities.values()].filter(id => id !== itemId),
        allowedDiagnosisCatalogItemIds: [pciDataPackage.diagnosis.id], inpatientIndications: [pciDataPackage.diagnosis], inpatientBillingTrigger: 'dispense',
        allowedCourseDays: [1], defaultCourseDays: 1, allowedQuantities: [supplement.suggestedQuantity], defaultQuantity: supplement.suggestedQuantity,
        pciDataSupplement: { packageId: pciDataPackage.id, version: pciDataPackage.version, ...supplement },
      }
      const old = current === undefined ? {} : z.record(z.string(), z.json()).parse(JSON.parse(current.config_json))
      const config: Record<string, unknown> = { ...old }
      if (current?.active === 1 && old.pciDataSupplement === undefined && Array.isArray(old.availableScopes)) {
        config.availableScopes = [...new Set([...z.array(z.string()).parse(old.availableScopes), 'inpatient'])]
      }
      for (const [key, value] of Object.entries(defaults)) {
        if (config[key] !== undefined && config[key] !== null) continue
        // 含量基于每一最小制剂单位；已确认的其他单位不能直接套用该换算。
        if (key === 'inpatientDoseBasis' && old.unit !== undefined && old.unit !== supplement.unit) continue
        config[key] = value
      }
      if (current === undefined) {
        const inserted = database.prepare(`INSERT INTO outpatient_catalog
          (workspace_id,epoch,item_id,kind,code,name_zh,name_en,price_fen,version,active,config_json)
          VALUES(?,?,?,'medication',?,?,?,?,1,1,?) ON CONFLICT(workspace_id,epoch,item_id) DO NOTHING`)
          .run(context.workspaceId, context.epoch, itemId, definition.product.code, definition.product.genericName, definition.product.genericName, supplement.priceFen, JSON.stringify(config))
        if (inserted.changes !== 1) throw new InpatientError('INPATIENT_PCI_CATALOG_AMBIGUOUS', 'PCI 药品院内 ID 已被其他产品占用')
        effects.push({ kind: 'created', reference: `HospitalMedication/${itemId}`, versionId: '1' })
      } else if (JSON.stringify(config) !== JSON.stringify(old)) {
        database.prepare('UPDATE outpatient_catalog SET config_json=?,version=version+1 WHERE workspace_id=? AND epoch=? AND item_id=? AND version=?')
          .run(JSON.stringify(config), context.workspaceId, context.epoch, itemId, current.version)
        effects.push({ kind: 'updated', reference: `HospitalMedication/${itemId}`, versionId: String(current.version + 1) })
      }
      if (!this.fhirExists(context, 'Medication', itemId)) {
        this.owner.fhir.create(context, { resourceType: 'Medication', id: itemId, status: current?.active === 0 ? 'inactive' : 'active',
          code: { coding: [{ system: definition.product.system, version: definition.product.version, code: definition.product.code, display: definition.product.genericName }], text: definition.product.genericName } })
        effects.push({ kind: 'created', reference: `Medication/${itemId}`, versionId: '1' })
      }
      const hasInventory = database.prepare('SELECT 1 FROM inventory_lot WHERE workspace_id=? AND epoch=? AND medication_id=?').get(context.workspaceId, context.epoch, itemId) !== undefined
      if (hasInventory) continue
      // 旧单位不同或停用项目只补目录资料；不制造数量口径不明的库存。
      if (current?.active === 0 || (old.unit !== undefined && old.unit !== supplement.unit)) continue
      const lotId = `lot-pci-${definition.id.replace('medication-pci-', '')}-20261025`
      const expiresOn = '2028-12-31'
      database.prepare(`INSERT INTO inventory_lot(workspace_id,epoch,lot_id,medication_id,location_id,lot_number,expires_on,quantity_on_hand,version)
        VALUES(?,?,?,?,'location-pharmacist',?,?,?,1)`)
        .run(context.workspaceId, context.epoch, lotId, itemId, `SYN-PCI-${definition.product.code}`, expiresOn, supplement.initialStock)
      this.owner.fhir.createProjection(context, { resourceType: 'InventoryItem', id: lotId, status: 'active',
        category: [{ text: '合成 PCI 药品批次' }], code: [{ text: definition.product.genericName }],
        baseUnit: { text: supplement.unit }, netContent: { value: supplement.initialStock, unit: supplement.unit },
        instance: { lotNumber: `SYN-PCI-${definition.product.code}`, expiry: expiresOn, location: { reference: 'Location/location-pharmacist' } } })
      effects.push({ kind: 'created', reference: `InventoryItem/${lotId}`, versionId: '1' })
    }
  }

  private fhirExists(context: ActorContext, type: string, id: string) {
    return this.owner.database.driver.prepare('SELECT 1 FROM fhir_resource WHERE workspace_id=? AND epoch=? AND resource_type=? AND resource_id=? AND deleted=0')
      .get(context.workspaceId, context.epoch, type, id) !== undefined
  }

  private medication(context: ActorContext, product: { id: string, system: string, version: string }) {
    const rows = z.array(catalogRow).parse(this.owner.database.driver.prepare(`SELECT * FROM outpatient_catalog
      WHERE workspace_id=? AND epoch=? AND kind='medication' AND json_extract(config_json,'$.product.id')=?
      AND json_extract(config_json,'$.product.system')=? AND json_extract(config_json,'$.product.version')=?`)
      .all(context.workspaceId, context.epoch, product.id, product.system, product.version))
    if (rows.length > 1) throw new InpatientError('INPATIENT_PCI_CATALOG_AMBIGUOUS', '同一具体药品产品匹配多个院内项目，须先明确映射')
    return rows[0]
  }

  private laboratory(context: ActorContext, coding: { id: string, system: string, version: string }) {
    const rows = z.array(serviceRow).parse(this.owner.database.driver.prepare(`SELECT * FROM hospital_service_catalog
      WHERE workspace_id=? AND epoch=? AND json_extract(config_json,'$.laboratoryService.referenceConcept.id')=?
      AND json_extract(config_json,'$.laboratoryService.referenceConcept.system')=? AND json_extract(config_json,'$.laboratoryService.referenceConcept.version')=?
      AND json_extract(config_json,'$.laboratoryService.doctorOrderable')=1`)
      .all(context.workspaceId, context.epoch, coding.id, coding.system, coding.version))
    if (rows.length > 1) throw new InpatientError('INPATIENT_PCI_CATALOG_AMBIGUOUS', '同一检验根项目匹配多个院内服务，须先明确映射')
    return rows[0]
  }
}
