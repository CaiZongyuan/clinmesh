import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { pciSelectionProcedureCodes } from '@clinmesh/contracts/inpatient-pci-selection'
import {
  medicationPackageInsertSchema,
  medicationRouteSchema,
  medicationSafetyRuleSchema,
} from '@clinmesh/contracts/medication-safety'
import {
  anesthesiaMethodSchema,
  inpatientBaseStockMedicationSchema,
  inpatientLegacySurgeryRequestInputSchema,
  inpatientMaterialItemSchema,
  inpatientProcedureItemSchema,
  inpatientProcedureNursingBindingSchema,
  inpatientSurgeryActionInputSchema,
  inpatientSurgeryCatalogSchema,
  inpatientSurgeryCompleteInputSchema,
  inpatientSurgeryCompletionReviewInputSchema,
  inpatientSurgeryConfirmConsentInputSchema,
  inpatientSurgeryCorrectMaterialInputSchema,
  inpatientSurgeryExecuteInputSchema,
  inpatientSurgeryLocationSchema,
  inpatientSurgeryMaterialHistorySchema,
  inpatientSurgeryMaterialSelectionSchema,
  inpatientSurgeryMedicationSelectionSchema,
  inpatientSurgeryNursingChargeSchema,
  inpatientSurgeryPractitionerSchema,
  inpatientSurgeryRecordMaterialInputSchema,
  inpatientSurgeryRecordMedicationInputSchema,
  inpatientSurgeryRequestInputSchema,
  inpatientSurgeryRequestSchema,
  inpatientSurgeryExecutionSchema,
  inpatientSurgerySchema,
  inpatientSurgeryStartInputSchema,
  inpatientSurgerySupplementMaterialInputSchema,
  preopOrderPolicySchema,
  surgeryTypeSchema,
  type InpatientBaseStockMedication,
  type InpatientProcedureNursingBinding,
  type SurgeryLocationId,
} from '@clinmesh/contracts/inpatient-surgery'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import type { ActorContext, CommandTransaction } from './command-executor.ts'
import type { InpatientEffects } from './inpatient-billing.ts'
import { freezeCatalogCoverageJson, readConfigInsuranceCoverage } from './catalog-insurance-coverage.ts'
import { resolveCatalogMedicationRoutes } from './inpatient-medication-config.ts'
import { businessDate } from './inpatient-orders.ts'
import { readMaterialSnapshot } from './scenario-data/cardiovascular-materials.ts'
import { standardMedicationDoseBasis, standardMedicationSafety } from './scenario-data/standard-medications.ts'
import { planSurgeryCompletion, materialReductions, type MaterialChargeBasis } from './inpatient-surgery-completion.ts'
import {
  SURGICAL_LOCATIONS,
  buildSurgicalConsentDocument,
  buildSurgeryServiceRequestFields,
  formatPractitionerDisplay,
  formatSurgicalConsentSummaryNote,
} from '@clinmesh/core/inpatient-surgery-consent'
import {
  DEFAULT_INTRAOPERATIVE_MEDICATION_NOTE,
  buildSurgicalMedicationPackages,
  linkedNursingForProcedureId,
  surgicalMedicationSafetyDose,
  validateSurgicalMedicationSelection,
} from '@clinmesh/core/inpatient-surgery-medications'
import { medicationRouteConcept } from '@clinmesh/core/medication-safety'
import {
  DEFAULT_ROUTINE_EXECUTE_NOTE,
  DEFAULT_ROUTINE_START_NOTE,
  evaluateCompletionNoteRequirement,
  evaluateExecuteNoteRequirement,
  formatPlannedReservationMaterialNote,
  isSamePlannedProcedure,
  mergeExecutionCompletionNote,
} from '@clinmesh/core/inpatient-surgery-notes'
import type { RepositoryContext } from '../infrastructure/sqlite/fhir-repository.ts'

const DEDICATED_SURGICAL_PRACTITIONER_IDS = [
  'practitioner-surgeon-chief',
  'practitioner-surgeon-attending',
] as const

const KNOWN_SURGICAL_PRACTITIONER_ORDER = [
  'practitioner-inpatient-doctor',
  'practitioner-surgeon-chief',
  'practitioner-surgeon-attending',
  'practitioner-outpatient-doctor',
] as const

const cachedCatalogItemsSchema = inpatientSurgeryCatalogSchema.pick({
  procedures: true,
  materials: true,
})

const storedLocationContentSchema = z.object({
  status: z.string().optional(),
  name: z.string().optional(),
}).loose()

const storedPractitionerRoleContentSchema = z.object({
  active: z.boolean().optional(),
  practitioner: z.object({ reference: z.string().optional() }).loose().optional(),
  code: z.array(z.object({
    text: z.string().optional(),
    coding: z.array(z.object({ code: z.string().optional() }).loose()).optional(),
  }).loose()).optional(),
}).loose()

const storedPractitionerContentSchema = z.object({
  active: z.boolean().optional(),
  name: z.array(z.object({ text: z.string().optional() }).loose()).optional(),
  qualification: z.array(z.object({
    code: z.object({ text: z.string().optional() }).loose().optional(),
  }).loose()).optional(),
}).loose()

const surgicalBaseMedicationConfigSchema = z.object({
  unit: z.string().trim().min(1),
  defaultRouteCode: medicationRouteSchema.optional(),
  allowedRouteCodes: z.array(medicationRouteSchema).min(1).optional(),
  route: z.string().trim().min(1).optional(),
  product: z.object({
    strength: z.string().min(1),
    dosageForm: z.string().min(1),
    packageDescription: z.string().min(1),
  }).loose(),
  inpatientDoses: z.array(z.object({
    doseText: z.string().trim().min(1).max(120),
    quantity: z.number().int().positive().max(1000),
  })).default([]),
  inpatientDoseBasis: z.object({
    amount: z.number().positive(),
    unit: z.string().trim().min(1),
  }).optional(),
  inpatientMaxDoseQuantity: z.number().int().positive().max(1000).optional(),
  safety: medicationSafetyRuleSchema.optional(),
  packageInsert: medicationPackageInsertSchema.optional().catch(undefined),
}).loose()

const surgicalNursingServiceConfigSchema = z.object({
  billingUnit: z.object({ display: z.string().min(1) }).loose(),
  chargeDefinition: z.object({ priceFen: z.number().int().positive().safe() }).loose(),
  surgicalProcedureIds: z.array(z.string().min(1)).min(1),
}).loose()

const storedLinkedNursingSchema = inpatientSurgeryNursingChargeSchema.omit({ chargeId: true })

export class InpatientSurgery {
  #catalogCache: {
    key: string
    procedures: z.infer<typeof inpatientProcedureItemSchema>[]
    materials: z.infer<typeof inpatientSurgeryCatalogSchema>['materials']
  } | undefined
  constructor(readonly owner: InpatientService) {}
  #ensureCatalogItems(context: RepositoryContext) {
    const rows = z.array(z.object({ kind: z.enum(['procedure', 'material']), snapshot_json: z.string() })).parse(
      this.owner.database.driver.prepare(
        'SELECT kind,snapshot_json FROM inpatient_surgery_catalog WHERE workspace_id=? AND epoch=? ORDER BY item_id',
      ).all(context.workspaceId, context.epoch),
    )
    const key = rows.map(row => `${row.kind}:${row.snapshot_json}`).join('\n')
    if (this.#catalogCache?.key !== key) {
      const parsed = cachedCatalogItemsSchema.parse({
        procedures: rows.filter(row => row.kind === 'procedure').map(row => JSON.parse(row.snapshot_json)),
        materials: rows.filter(row => row.kind === 'material').map(row => readMaterialSnapshot(JSON.parse(row.snapshot_json))),
      })
      this.#catalogCache = { key, procedures: parsed.procedures, materials: parsed.materials }
    }
    return this.#catalogCache
  }
  catalog(context: ActorContext): z.infer<typeof inpatientSurgeryCatalogSchema> {
    this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
    const cached = this.#ensureCatalogItems(context)
    const { medications: baseStockMedications, inactiveIds } = this.#readBaseStockMedications(context)
    const { bindings: nursingBindings } = this.#readNursingBindings(context)
    return {
      procedures: cached.procedures,
      materials: cached.materials,
      locations: this.#readLocations(context),
      practitioners: this.#readPractitioners(context),
      baseStockMedications,
      medicationPackages: buildSurgicalMedicationPackages(baseStockMedications, inactiveIds),
      nursingBindings,
    }
  }
  #readBaseStockMedications(context: RepositoryContext) {
    const rows = z.array(z.object({
      item_id: z.string(),
      code: z.string(),
      name_zh: z.string(),
      version: z.number().int().positive(),
      active: z.number(),
      price_fen: z.number().int().nonnegative(),
      config_json: z.string(),
    })).parse(
      this.owner.database.driver.prepare(`
        SELECT item_id, code, name_zh, version, active, price_fen, config_json
        FROM outpatient_catalog
        WHERE workspace_id=? AND epoch=? AND kind='medication'
          AND json_extract(config_json,'$.surgicalBaseStock')=1
        ORDER BY item_id
      `).all(context.workspaceId, context.epoch),
    )
    const inactiveIds = new Set<string>()
    const configByItemId = new Map<string, string>()
    const medications: InpatientBaseStockMedication[] = []
    for (const row of rows) {
      if (row.active !== 1) {
        inactiveIds.add(row.item_id)
        continue
      }
      if (row.price_fen <= 0) continue
      const parsedConfig = surgicalBaseMedicationConfigSchema.safeParse(JSON.parse(row.config_json))
      if (!parsedConfig.success) continue
      const config = parsedConfig.data
      const routes = resolveCatalogMedicationRoutes(config, row.name_zh)
      const safety = config.safety ?? standardMedicationSafety(row.item_id)
      const doseBasis = config.inpatientDoseBasis ?? standardMedicationDoseBasis(row.item_id)
      const singleLimitQuantity = safety?.doseLimits.unit === config.unit
        ? Math.floor(safety.doseLimits.maximumSingleDose)
        : safety && doseBasis && doseBasis.unit === safety.doseLimits.unit
          ? Math.floor(safety.doseLimits.maximumSingleDose / doseBasis.amount)
          : 100
      const maxDoseQuantity = Math.min(
        1000,
        config.inpatientMaxDoseQuantity
          ?? Math.max(1, singleLimitQuantity, ...config.inpatientDoses.map(dose => dose.quantity)),
      )
      configByItemId.set(row.item_id, row.config_json)
      medications.push(inpatientBaseStockMedicationSchema.parse({
        id: row.item_id,
        version: row.version,
        code: row.code,
        display: row.name_zh,
        unit: config.unit,
        priceFen: row.price_fen,
        strength: config.product.strength,
        packageDescription: config.product.packageDescription,
        ...routes,
        doses: config.inpatientDoses,
        ...(doseBasis === undefined ? {} : { doseBasis }),
        maxDoseQuantity,
        ...(safety === undefined ? {} : { safety }),
        ...(config.packageInsert === undefined ? {} : { packageInsert: config.packageInsert }),
      }))
    }
    return { medications, inactiveIds, configByItemId }
  }
  #readNursingBindings(context: RepositoryContext) {
    const rows = z.array(z.object({
      service_id: z.string(),
      name_zh: z.string(),
      version: z.number().int().positive(),
      config_json: z.string(),
    })).parse(
      this.owner.database.driver.prepare(`
        SELECT service_id, name_zh, version, config_json
        FROM hospital_service_catalog
        WHERE workspace_id=? AND epoch=? AND active=1
          AND json_extract(config_json,'$.inpatientBillingTrigger')='surgery-completion'
        ORDER BY service_id
      `).all(context.workspaceId, context.epoch),
    )
    const configByServiceId = new Map<string, string>()
    const bindings: InpatientProcedureNursingBinding[] = []
    for (const row of rows) {
      const parsed = surgicalNursingServiceConfigSchema.safeParse(JSON.parse(row.config_json))
      if (!parsed.success) continue
      configByServiceId.set(row.service_id, row.config_json)
      bindings.push(inpatientProcedureNursingBindingSchema.parse({
        serviceId: row.service_id,
        serviceVersion: row.version,
        display: row.name_zh,
        unit: parsed.data.billingUnit.display,
        priceFen: parsed.data.chargeDefinition.priceFen,
        procedureIds: parsed.data.surgicalProcedureIds,
      }))
    }
    return { bindings, configByServiceId }
  }
  #readLocations(context: RepositoryContext) {
    const rows = z.array(z.object({ resource_id: z.string(), content_json: z.string() })).parse(
      this.owner.database.driver.prepare(`
        SELECT resource_id, content_json FROM fhir_resource
        WHERE workspace_id=? AND epoch=? AND resource_type='Location' AND deleted=0
          AND resource_id IN (${SURGICAL_LOCATIONS.map(() => '?').join(',')})
      `).all(context.workspaceId, context.epoch, ...SURGICAL_LOCATIONS.map(item => item.id)),
    )
    const byId = new Map(rows.map(row => [row.resource_id, storedLocationContentSchema.parse(JSON.parse(row.content_json))]))
    return SURGICAL_LOCATIONS.flatMap((item) => {
      const stored = byId.get(item.id)
      if (!stored || stored.status !== 'active') return []
      const name = stored.name && stored.name.trim().length > 0 ? stored.name.trim() : item.name
      return [inpatientSurgeryLocationSchema.parse({ id: item.id, name, nameEn: item.nameEn })]
    })
  }
  #readPractitioners(context: RepositoryContext) {
    const roleRows = z.array(z.object({ content_json: z.string() })).parse(
      this.owner.database.driver.prepare(`
        SELECT content_json FROM fhir_resource
        WHERE workspace_id=? AND epoch=? AND resource_type='PractitionerRole' AND deleted=0
      `).all(context.workspaceId, context.epoch),
    )
    const eligibleIds = new Set<string>(DEDICATED_SURGICAL_PRACTITIONER_IDS)
    for (const roleRow of roleRows) {
      const parsed = storedPractitionerRoleContentSchema.parse(JSON.parse(roleRow.content_json))
      if (parsed.active === false) continue
      const ref = parsed.practitioner?.reference ?? ''
      if (!ref.startsWith('Practitioner/')) continue
      const codes = (parsed.code ?? []).flatMap(entry => [
        ...(entry.text === undefined ? [] : [entry.text]),
        ...(entry.coding ?? []).flatMap(coding => (coding.code === undefined ? [] : [coding.code])),
      ])
      if (codes.some(code => code === 'inpatient-doctor' || code === 'outpatient-doctor')) {
        eligibleIds.add(ref.slice('Practitioner/'.length))
      }
    }
    const practitionerRows = z.array(z.object({ resource_id: z.string(), content_json: z.string() })).parse(
      this.owner.database.driver.prepare(`
        SELECT resource_id, content_json FROM fhir_resource
        WHERE workspace_id=? AND epoch=? AND resource_type='Practitioner' AND deleted=0
      `).all(context.workspaceId, context.epoch),
    )
    const orderIndex = (id: string) => {
      const idx = (KNOWN_SURGICAL_PRACTITIONER_ORDER as readonly string[]).indexOf(id)
      return idx === -1 ? KNOWN_SURGICAL_PRACTITIONER_ORDER.length : idx
    }
    return practitionerRows
      .filter(row => eligibleIds.has(row.resource_id))
      .flatMap((row) => {
        const parsed = storedPractitionerContentSchema.parse(JSON.parse(row.content_json))
        if (parsed.active === false) return []
        const firstName = parsed.name?.[0]?.text?.trim()
        const nameText = firstName && firstName.length > 0 ? firstName : row.resource_id
        const firstTitle = parsed.qualification?.[0]?.code?.text?.trim()
        const titleText = firstTitle && firstTitle.length > 0 ? firstTitle : undefined
        return [inpatientSurgeryPractitionerSchema.parse({
          id: row.resource_id,
          name: nameText,
          ...(titleText === undefined ? {} : { title: titleText }),
        })]
      })
      .sort((left, right) => orderIndex(left.id) - orderIndex(right.id) || left.id.localeCompare(right.id))
  }
  #surgicalLocation(context: RepositoryContext, locationId: SurgeryLocationId) {
    const location = this.#readLocations(context).find(item => item.id === locationId)
    if (!location) throw new InpatientError('INPATIENT_SURGERY_LOCATION_INVALID', '手术执行地点不可用或未启用', 409)
    return { id: location.id, name: location.name }
  }
  #surgicalPractitioner(context: RepositoryContext, practitionerId: string) {
    const practitioner = this.#readPractitioners(context).find(item => item.id === practitionerId)
    if (!practitioner) throw new InpatientError('INPATIENT_SURGERY_PRACTITIONER_INVALID', '主刀医师或第一助手须为本院有效临床医师', 409)
    return practitioner
  }
  read(context: ActorContext, admissionId: string) {
    this.owner.assertReadRole(context, ['inpatient-doctor','ward-nurse','medical-records'])
    this.owner.readAdmissionBinding(context, admissionId)
    const rows = z.array(requestRowSchema).parse(this.owner.database.driver.prepare(
      'SELECT * FROM inpatient_surgery_request WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY julianday(requested_at),request_id').all(context.workspaceId, context.epoch, admissionId))
    return inpatientSurgerySchema.parse({ admissionId, encounterVersion: this.owner.fhir.read(context, 'Encounter', admissionId).meta!.versionId,
      virtualTime: this.owner.virtualTime(context), requests: rows.map(row => inpatientSurgeryRequestSchema.parse({ id: row.request_id, admissionId, version: row.version, status: row.status,
        ...(row.surgery_type === null ? {} : { surgeryType: row.surgery_type }),
        plannedProcedure: JSON.parse(row.planned_procedure_json), plannedFor: row.planned_for,
        ...(row.location_json === null ? {} : { location: JSON.parse(row.location_json) }),
        ...(row.surgeon_json === null ? {} : { surgeon: JSON.parse(row.surgeon_json) }),
        ...(row.assistant_json === null ? {} : { assistant: JSON.parse(row.assistant_json) }),
        ...(row.anesthesia_method === null ? {} : { anesthesiaMethod: row.anesthesia_method }),
        preopOrderPolicy: row.preop_order_policy,
        reason: row.reason, requestedAt: row.requested_at,
        requestedBy: row.requested_by, organizationId: row.organization_id,
        ...(row.preop_check_json === null ? {} : { preopCheck: JSON.parse(row.preop_check_json) }),
        ...(row.consent_confirmation_json === null ? {} : { consentConfirmation: JSON.parse(row.consent_confirmation_json) }),
        ...(row.cancellation_json === null ? {} : { cancellation: JSON.parse(row.cancellation_json) }),
      })), executions: this.executedForAdmission(context, admissionId), inProgress: this.executions(context, admissionId, 'in-progress') })
  }
  /** 首页与术后医嘱只消费已完成操作；术中事实通过独立集合返回。 */
  executedForAdmission(context: ActorContext, admissionId: string) { return this.executions(context, admissionId, 'completed') }
  private executions(context: ActorContext, admissionId: string, status: 'in-progress' | 'completed') {
    this.owner.assertReadRole(context, ['inpatient-doctor','ward-nurse','medical-records'])
    this.owner.readAdmissionBinding(context, admissionId)
    return this.executionFacts(context, admissionId, status)
  }
  /** 仅供受信住院规则读取已提交事实；HTTP 读取继续经过 executions 的岗位校验。 */
  executionFacts(context: RepositoryContext, admissionId: string, status: 'in-progress' | 'completed') {
    const rows = z.array(executionRowSchema).parse(this.owner.database.driver.prepare(
      'SELECT * FROM inpatient_surgery_execution WHERE workspace_id=? AND epoch=? AND admission_id=? AND status=? ORDER BY julianday(performed_at),execution_id')
      .all(context.workspaceId, context.epoch, admissionId, status))
    return rows.map(row => {
      const materials = z.array(z.object({ material_use_id: z.string(), item_json: z.string(), quantity: z.number(), amount_fen: z.number(),
        recorded_at: z.string().nullable(), recorded_by: z.string().nullable(), practitioner_role_id: z.string().nullable(), note: z.string().nullable(), reservation_id: z.string().nullable(),
        recording_kind: inpatientSurgeryMaterialHistorySchema.shape.recordingKind.nullable(), charge_id: z.string().nullable(), correction_json: z.string().nullable() })).parse(this.owner.database.driver.prepare(`
          SELECT m.*,r.recorded_at,r.recorded_by,r.practitioner_role_id,r.note,r.reservation_id,r.recording_kind,b.charge_id,
          CASE WHEN c.correction_id IS NULL THEN NULL ELSE json_object('id',c.correction_id,'recordedAt',c.recorded_at,
            'recordedBy',c.recorded_by,'practitionerRoleId',c.practitioner_role_id,'note',c.note,'replacementMaterialUseId',c.replacement_use_id,
            'originalChargeId',c.original_charge_id,'reversalChargeId',c.reversal_charge_id) END correction_json
          FROM inpatient_surgery_material m LEFT JOIN inpatient_surgery_material_record r
          ON r.workspace_id=m.workspace_id AND r.epoch=m.epoch AND r.material_use_id=m.material_use_id
          LEFT JOIN inpatient_charge b ON b.workspace_id=m.workspace_id AND b.epoch=m.epoch AND b.source_id=m.material_use_id AND b.kind='material' AND b.admission_id=?
          LEFT JOIN inpatient_surgery_material_correction c ON c.workspace_id=m.workspace_id AND c.epoch=m.epoch AND c.material_use_id=m.material_use_id
          WHERE m.workspace_id=? AND m.epoch=? AND m.execution_id=? ORDER BY m.material_use_id`).all(admissionId, context.workspaceId, context.epoch, row.execution_id))
      const uses = materials.map(item => ({ id: item.material_use_id, item: JSON.parse(item.item_json), quantity: item.quantity, amountFen: item.amount_fen }))
      const medicationRows = z.array(z.object({
        medication_use_id: z.string(),
        administration_id: z.string(),
        medication_id: z.string(),
        catalog_version: z.number().int().positive(),
        display: z.string(),
        dose_text: z.string(),
        quantity: z.number().int().positive(),
        unit: z.string(),
        route_code: medicationRouteSchema,
        price_fen: z.number().int().nonnegative(),
        amount_fen: z.number().int().nonnegative(),
        recorded_at: z.string(),
        recorded_by: z.string(),
        practitioner_role_id: z.string(),
        note: z.string(),
        charge_id: z.string().nullable(),
      })).parse(this.owner.database.driver.prepare(`
        SELECT m.*, b.charge_id
        FROM inpatient_surgery_medication m
        LEFT JOIN inpatient_charge b
          ON b.workspace_id=m.workspace_id AND b.epoch=m.epoch AND b.source_id=m.medication_use_id AND b.kind='medication' AND b.admission_id=?
        WHERE m.workspace_id=? AND m.epoch=? AND m.execution_id=?
        ORDER BY julianday(m.recorded_at), m.medication_use_id
      `).all(admissionId, context.workspaceId, context.epoch, row.execution_id))
      const medications = medicationRows.map(item => ({
        id: item.medication_use_id,
        administrationId: item.administration_id,
        medicationId: item.medication_id,
        catalogVersion: item.catalog_version,
        display: item.display,
        doseText: item.dose_text,
        quantity: item.quantity,
        unit: item.unit,
        routeCode: item.route_code,
        priceFen: item.price_fen,
        amountFen: item.amount_fen,
        recordedAt: item.recorded_at,
        recordedBy: item.recorded_by,
        practitionerRoleId: item.practitioner_role_id,
        note: item.note,
        chargeId: item.charge_id,
      }))
      const linkedNursing = row.linked_nursing_json === null
        ? undefined
        : (() => {
            const parsed = storedLinkedNursingSchema.parse(JSON.parse(row.linked_nursing_json))
            const charge = z.object({ charge_id: z.string() }).optional().parse(
              this.owner.database.driver.prepare(
                "SELECT charge_id FROM inpatient_charge WHERE workspace_id=? AND epoch=? AND admission_id=? AND kind='service' AND source_id=?",
              ).get(context.workspaceId, context.epoch, admissionId, row.execution_id),
            )
            return { ...parsed, chargeId: charge?.charge_id ?? null }
          })()
      return inpatientSurgeryExecutionSchema.parse({ id: row.execution_id, admissionId, requestId: row.request_id,
        actualProcedure: JSON.parse(row.actual_procedure_json), performedAt: row.performed_at, performedBy: row.performed_by,
        practitionerRoleId: row.practitioner_role_id, organizationId: row.organization_id, note: row.note,
        ...(row.completed_at === null ? {} : { completedAt: row.completed_at }), materials: uses.filter((_item, index) => materials[index]!.correction_json === null),
        materialHistory: materials.map((item, index) => ({ ...uses[index], recordedAt: item.recorded_at ?? row.performed_at,
          recordedBy: item.recorded_by ?? row.performed_by, practitionerRoleId: item.practitioner_role_id ?? row.practitioner_role_id,
          recordingKind: item.recording_kind ?? 'initial', note: item.note ?? row.note, reservationId: item.reservation_id, chargeId: item.charge_id, correction: item.correction_json === null ? null : JSON.parse(item.correction_json) })),
        ...(medications.length === 0 ? {} : { medications }),
        ...(linkedNursing === undefined ? {} : { linkedNursing }),
      })
    })
  }
  /** 调用者先授权；目标护士在接收事务内检查时尚未接管住院。 */
  assertNoPending(context: ActorContext, admissionId: string) {
    if (this.owner.database.driver.prepare("SELECT 1 FROM inpatient_surgery_request WHERE workspace_id=? AND epoch=? AND admission_id=? AND status IN ('requested','ready') LIMIT 1")
      .get(context.workspaceId, context.epoch, admissionId)) throw new InpatientError('INPATIENT_SURGERY_PENDING', '尚有未实施或未取消的手术申请')
  }
  assertExecution(context: ActorContext, admissionId: string, executionId: string) {
    this.owner.admissionBinding(context, admissionId)
    const row = this.owner.database.driver.prepare('SELECT 1 FROM inpatient_surgery_execution WHERE workspace_id=? AND epoch=? AND admission_id=? AND execution_id=?')
      .get(context.workspaceId, context.epoch, admissionId, executionId)
    if (row === undefined) throw new InpatientError('INPATIENT_SURGERY_EXECUTION_REQUIRED', '术后医嘱须引用本次住院已实施的手术')
    const procedure = this.owner.fhir.read(context, 'Procedure', executionId)
    if (procedure.status !== 'completed') throw new InpatientError('INPATIENT_SURGERY_EXECUTION_REQUIRED', '术后医嘱须引用本次住院已实施的手术')
  }
  request(context: ActorContext, raw: unknown, idempotencyKey: string) {
    if (!inpatientSurgeryRequestInputSchema.safeParse(raw).success) {
      const legacy = inpatientLegacySurgeryRequestInputSchema.safeParse(raw)
      if (legacy.success) {
        const replayed = this.owner.commands.replayIfExists({
          context,
          input: legacy.data,
          idempotencyKey,
          operation: 'inpatient.surgery.request',
          expectedVersions: { [`Encounter/${legacy.data.admissionId}`]: legacy.data.encounterVersion },
          dataSchema: inpatientSurgerySchema,
        })
        if (replayed !== null) return replayed
      }
    }
    const input = inpatientSurgeryRequestInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.surgery.request',
      expectedVersions: { [`Encounter/${input.admissionId}`]: input.encounterVersion }, dataSchema: inpatientSurgerySchema,
      authorize: () => this.authorize(context, input.admissionId, ['inpatient-doctor']) }, transaction => {
      this.owner.assertNotArchived(context,input.admissionId)
      const admission = this.owner.orders.assertAdmitted(context, input.admissionId), now = this.owner.virtualTime(context)
      if (Date.parse(input.plannedFor) < Date.parse(now)) throw new InpatientError('INPATIENT_SURGERY_TIME_CONFLICT', '计划手术时间不能早于当前虚拟时间')
      const item = this.procedure(context, input.procedureId, input.catalogVersion), id = uuidv7()
      const location = this.#surgicalLocation(context, input.locationId)
      const surgeon = this.#surgicalPractitioner(context, input.surgeonPractitionerId)
      const assistant = input.assistantPractitionerId === undefined ? undefined : this.#surgicalPractitioner(context, input.assistantPractitionerId)
      if (assistant && assistant.id === surgeon.id) {
        throw new InpatientError('INPATIENT_SURGERY_PRACTITIONER_CONFLICT', '主刀医师与第一助手不能为同一人', 400)
      }
      const quality = pciSelectionProcedureCodes.includes(item.coding.code)
        ? this.owner.workflow.clinicalQuality.enforce(context, {
            check: this.owner.workflow.clinicalQuality.inpatientPciPlan(this.owner, context, admission.id),
            operation: 'inpatient.surgery.request',
            override: input.clinicalOverride,
            patientId: admission.patientId,
            subjectReference: `Encounter/${admission.id}`,
          })
        : { effects: [] }
      this.owner.database.driver.prepare(`INSERT INTO inpatient_surgery_request(
        workspace_id,epoch,request_id,admission_id,status,surgery_type,planned_procedure_json,planned_for,
        location_json,surgeon_json,assistant_json,anesthesia_method,preop_order_policy,reason,requested_at,requested_by,organization_id
      ) VALUES(?,?,?,?,'requested',?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        context.workspaceId, context.epoch, id, admission.id, input.surgeryType, JSON.stringify(item), input.plannedFor,
        JSON.stringify(location), JSON.stringify(surgeon), assistant ? JSON.stringify(assistant) : null, input.anesthesiaMethod,
        input.preopOrderPolicy, input.reason, now, context.actorId, admission.organizationId,
      )
      this.owner.fhir.create(context, {
        resourceType: 'ServiceRequest',
        id,
        status: 'active',
        intent: 'order',
        ...buildSurgeryServiceRequestFields({
          surgeryType: input.surgeryType,
          location,
          surgeon,
          assistant,
          anesthesiaMethod: input.anesthesiaMethod,
          preopOrderPolicy: input.preopOrderPolicy,
        }),
        code: { concept: { coding: [clinicalCoding(item.coding)], text: item.coding.display } },
        subject: { reference: `Patient/${admission.patientId}` },
        encounter: { reference: `Encounter/${admission.id}` },
        authoredOn: now,
        occurrenceDateTime: input.plannedFor,
        requester: { reference: `PractitionerRole/${context.practitionerRoleId}` },
        note: [{ text: input.reason }],
      })
      this.owner.pciSelection.prepareDraft(context, admission.id, id)
      this.owner.materialEstimates.automatic(context, admission.id, id, transaction)
      return {
        data: this.read(context, admission.id),
        effects: [{ kind: 'created' as const, reference: `ServiceRequest/${id}`, versionId: '1' }, ...quality.effects],
        ...(quality.receipt === undefined ? {} : { clinicalQuality: quality.receipt }),
      }
    })
  }
  confirmConsent(context: ActorContext, raw: unknown, idempotencyKey: string) {
    if (!inpatientSurgeryConfirmConsentInputSchema.safeParse(raw).success) {
      const legacy = inpatientSurgeryActionInputSchema.safeParse(raw)
      if (legacy.success) {
        const replayed = this.owner.commands.replayIfExists({
          context,
          input: legacy.data,
          idempotencyKey,
          operation: 'inpatient.surgery.confirm-consent',
          expectedVersions: {},
          dataSchema: inpatientSurgerySchema,
        })
        if (replayed !== null) return replayed
      }
    }
    const input = inpatientSurgeryConfirmConsentInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.surgery.confirm-consent', expectedVersions: {}, dataSchema: inpatientSurgerySchema,
      authorize: () => this.authorize(context, input.admissionId, ['inpatient-doctor']) }, () => {
      this.owner.assertNotArchived(context, input.admissionId)
      const admission = this.owner.orders.assertAdmitted(context, input.admissionId)
      const row = this.currentRequest(context, input)
      if (this.executionForRequest(context, row.request_id)) throw new InpatientError('INPATIENT_SURGERY_IN_PROGRESS', '手术已经开始，不能撤销或重做术前准备')
      if (row.consent_confirmation_json !== null) throw new InpatientError('INPATIENT_SURGERY_CONFLICT', '该准备事实已记录，请刷新手术记录')
      const now = this.owner.virtualTime(context)
      const patient = this.owner.fhir.read(context, 'Patient', admission.patientId)
      const patientNames = z.array(z.object({ text: z.string().optional() })).optional().parse(patient.name)
      const patientName = patientNames?.[0]?.text?.trim() || admission.patientId
      const patientGender = z.enum(['female', 'male', 'other', 'unknown']).optional().safeParse(patient.gender).data ?? 'unknown'
      const patientBirthDate = z.iso.date().optional().safeParse(patient.birthDate).data ?? null
      const diagnosis = this.owner.orders.diagnosis(context, input.admissionId)
      if (diagnosis.revision !== input.expectedDiagnosisRevision) {
        throw new InpatientError('INPATIENT_SURGERY_CONFLICT', '住院诊断已更新，请重新核对知情同意书后再确认签署')
      }
      const primaryEntry = diagnosis.entries.find(entry => entry.role === 'primary')
      const plannedProcedure = inpatientProcedureItemSchema.parse(JSON.parse(row.planned_procedure_json))
      const location = row.location_json === null ? null : inpatientSurgeryLocationSchema.pick({ id: true, name: true }).parse(JSON.parse(row.location_json))
      const surgeon = row.surgeon_json === null ? null : inpatientSurgeryPractitionerSchema.parse(JSON.parse(row.surgeon_json))
      const assistant = row.assistant_json === null ? null : inpatientSurgeryPractitionerSchema.parse(JSON.parse(row.assistant_json))
      const talkingDoctorId = context.practitionerId ?? 'practitioner-inpatient-doctor'
      const talkingDoctor = this.#readPractitioners(context).find(item => item.id === talkingDoctorId)
      const talkingDoctorName = talkingDoctor ? formatPractitionerDisplay(talkingDoctor) : talkingDoctorId
      const document = buildSurgicalConsentDocument({
        patient: {
          name: patientName,
          gender: patientGender,
          birthDate: patientBirthDate,
          inpatientNumber: admission.row.inpatient_number,
        },
        primaryDiagnosis: primaryEntry ? { code: primaryEntry.coding.code, display: primaryEntry.coding.display } : null,
        surgeryNotice: {
          surgeryType: row.surgery_type,
          procedureCode: plannedProcedure.coding.code,
          procedureDisplay: plannedProcedure.coding.display,
          plannedFor: row.planned_for,
          locationName: location?.name ?? null,
          anesthesiaMethod: row.anesthesia_method,
          surgeonName: surgeon ? formatPractitionerDisplay(surgeon) : null,
          assistantName: assistant ? formatPractitionerDisplay(assistant) : null,
        },
        individualizedRisks: input.individualizedRisks,
        signature: {
          signerRole: input.signerRole,
          signerName: input.signerName,
          signerRelationship: input.signerRelationship,
          talkingDoctorId,
          talkingDoctorName,
          signedAt: now,
        },
      })
      const summaryNote = formatSurgicalConsentSummaryNote(document, input.note)
      const fact = JSON.stringify({
        actorId: context.actorId,
        practitionerRoleId: context.practitionerRoleId,
        recordedAt: now,
        note: summaryNote,
        document,
      })
      const ready = row.preop_check_json !== null
      this.owner.database.driver.prepare(
        'UPDATE inpatient_surgery_request SET consent_confirmation_json=?,version=version+1,status=? WHERE workspace_id=? AND epoch=? AND request_id=? AND version=?',
      ).run(fact, ready ? 'ready' : 'requested', context.workspaceId, context.epoch, row.request_id, row.version)
      const effects: InpatientEffects = [{ kind: 'updated', reference: `InpatientSurgeryRequest/${row.request_id}`, versionId: String(row.version + 1) }]
      return { data: this.read(context, input.admissionId), effects }
    })
  }
  prepare(context: ActorContext, raw: unknown, idempotencyKey: string, action: 'check-preop' | 'cancel') {
    const input = inpatientSurgeryActionInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: `inpatient.surgery.${action}`, expectedVersions: {}, dataSchema: inpatientSurgerySchema,
      authorize: () => this.authorize(context, input.admissionId, action === 'check-preop' ? ['ward-nurse'] : ['inpatient-doctor']) }, () => {
      this.owner.assertNotArchived(context,input.admissionId)
      this.owner.orders.assertAdmitted(context, input.admissionId)
      const row = this.currentRequest(context, input)
      if (this.executionForRequest(context, row.request_id)) throw new InpatientError('INPATIENT_SURGERY_IN_PROGRESS', '手术已经开始，不能撤销或重做术前准备')
      const column = action === 'check-preop' ? 'preop_check_json' : 'cancellation_json'
      if (row[column] !== null) throw new InpatientError('INPATIENT_SURGERY_CONFLICT', '该准备事实已记录，请刷新手术记录')
      const fact = JSON.stringify({ actorId: context.actorId, practitionerRoleId: context.practitionerRoleId, recordedAt: this.owner.virtualTime(context), note: input.note })
      const ready = action === 'check-preop' ? row.consent_confirmation_json !== null : false
      this.owner.database.driver.prepare(`UPDATE inpatient_surgery_request SET ${column}=?,version=version+1,status=? WHERE workspace_id=? AND epoch=? AND request_id=? AND version=?`)
        .run(fact, action === 'cancel' ? 'cancelled' : ready ? 'ready' : 'requested', context.workspaceId, context.epoch, row.request_id, row.version)
      const effects: InpatientEffects = [{ kind: 'updated', reference: `InpatientSurgeryRequest/${row.request_id}`, versionId: String(row.version + 1) }]
      if (action === 'cancel') {
        this.updateRequestProjection(context, row.request_id, 'revoked', effects)
        const activeReservations = z.array(z.object({ reservation_id: z.string(), version: z.number() })).parse(
          this.owner.database.driver.prepare(
            "SELECT reservation_id, version FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id=? AND status='reserved' ORDER BY created_at, reservation_id",
          ).all(context.workspaceId, context.epoch, input.admissionId, row.request_id),
        )
        for (const reservation of activeReservations) {
          this.owner.database.driver.prepare(
            "UPDATE inpatient_material_reservation SET status='released', release_reason=?, version=version+1 WHERE workspace_id=? AND epoch=? AND reservation_id=? AND version=? AND status='reserved'",
          ).run(`手术计划已取消：${input.note}`, context.workspaceId, context.epoch, reservation.reservation_id, reservation.version)
          effects.push({ kind: 'updated', reference: `InpatientMaterialReservation/${reservation.reservation_id}`, versionId: String(reservation.version + 1) })
        }
      }
      return { data: this.read(context, input.admissionId), effects }
    })
  }
  execute(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientSurgeryExecuteInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.surgery.execute', expectedVersions: {}, dataSchema: inpatientSurgerySchema,
      authorize: () => this.authorize(context, input.admissionId, ['inpatient-doctor']) }, transaction => {
      const row = this.readyRequest(context, input), effects: InpatientEffects = []
      const planned = inpatientProcedureItemSchema.parse(JSON.parse(row.planned_procedure_json))
      const actual = this.procedure(context, input.procedureId, input.catalogVersion)
      const selections = input.materials.map(selection => {
        if (selection.reservationId === undefined) return selection
        const reservation = z.object({ quantity: z.number(), consumed_quantity: z.number(), version: z.number() }).optional().parse(this.owner.database.driver.prepare(
          'SELECT * FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND admission_id=? AND reservation_id=?')
          .get(context.workspaceId, context.epoch, input.admissionId, selection.reservationId))
        if (!reservation) throw new InpatientError('INPATIENT_RESERVATION_NOT_FOUND', '未找到本次住院的耗材预留', 404)
        if (reservation.consumed_quantity !== 0 || reservation.quantity !== selection.quantity)
          throw new InpatientError('INPATIENT_RESERVATION_CONFLICT', '一次性完成仍须按整笔原预留替换，请使用逐笔登记处理部分使用')
        return { ...selection, expectedReservationVersion: reservation.version }
      })
      const activeRequestReservations = z.array(z.object({ reservation_id: z.string(), quantity: z.number() })).parse(this.owner.database.driver.prepare(
        "SELECT reservation_id, quantity FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id=? AND status='reserved'")
        .all(context.workspaceId, context.epoch, input.admissionId, row.request_id))
      const { noteRequired, procedureChanged } = evaluateExecuteNoteRequirement({
        actual,
        planned,
        materials: selections,
        activeRequestReservations: activeRequestReservations.map(item => ({ id: item.reservation_id, quantity: item.quantity })),
        planBasis: this.owner.materialPlans.forRequestFacts(context, input.admissionId, row.request_id),
      })
      const explicitNote = input.note?.trim() || undefined
      if (noteRequired && !explicitNote) {
        throw new InpatientError('INPATIENT_SURGERY_NOTE_REQUIRED', procedureChanged ? '实际术式偏离原计划术式，请填写变更原因' : '存在计划外耗材或未按本台预留完整消耗，请填写补录依据', 400)
      }
      const resolvedNote = explicitNote ?? DEFAULT_ROUTINE_EXECUTE_NOTE
      const execution = this.createExecution(context, row, actual, resolvedNote, 'completed', effects)
      this.billProcedure(context, execution, effects)
      for (const selection of selections) {
        this.writeMaterial(context, execution, selection, explicitNote, effects)
      }
      for (const medication of input.medications ?? []) {
        this.writeMedication(context, execution, medication, explicitNote, effects)
      }
      this.billLinkedNursing(context, execution, effects)
      this.finish(context, row, execution, resolvedNote, effects, transaction)
      return { data: this.read(context, input.admissionId), effects }
    })
  }
  start(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientSurgeryStartInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.surgery.start', expectedVersions: {}, dataSchema: inpatientSurgerySchema,
      authorize: () => this.authorize(context, input.admissionId, ['inpatient-doctor']) }, () => {
      const row = this.readyRequest(context, input), effects: InpatientEffects = []
      const planned = inpatientProcedureItemSchema.parse(JSON.parse(row.planned_procedure_json))
      const actual = this.procedure(context, input.procedureId, input.catalogVersion)
      const explicitNote = input.note?.trim() || undefined
      if (!isSamePlannedProcedure(actual, planned) && !explicitNote) {
        throw new InpatientError('INPATIENT_SURGERY_NOTE_REQUIRED', '实际术式偏离原计划术式，请填写变更原因', 400)
      }
      this.createExecution(context, row, actual, explicitNote ?? DEFAULT_ROUTINE_START_NOTE, 'in-progress', effects)
      this.advanceRequest(context, row, effects)
      return { data: this.read(context, input.admissionId), effects }
    })
  }
  recordMaterial(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientSurgeryRecordMaterialInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.surgery.record-material', expectedVersions: {}, dataSchema: inpatientSurgerySchema,
      authorize: () => this.authorize(context, input.admissionId, ['inpatient-doctor']) }, () => {
      const { request, execution } = this.#requireInProgressExecution(context, input)
      const effects: InpatientEffects = []
      this.writeMaterial(context, execution, input.material, input.note?.trim() || undefined, effects)
      this.advanceRequest(context, request, effects)
      return { data: this.read(context, input.admissionId), effects }
    })
  }
  recordMedication(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientSurgeryRecordMedicationInputSchema.parse(raw)
    return this.owner.commands.execute({
      context,
      input,
      idempotencyKey,
      operation: 'inpatient.surgery.record-medication',
      expectedVersions: {},
      dataSchema: inpatientSurgerySchema,
      authorize: () => this.authorize(context, input.admissionId, ['inpatient-doctor']),
    }, () => {
      const { request, execution } = this.#requireInProgressExecution(context, input)
      const effects: InpatientEffects = []
      this.writeMedication(context, execution, input.medication, input.note?.trim() || undefined, effects)
      this.advanceRequest(context, request, effects)
      return { data: this.read(context, input.admissionId), effects }
    })
  }
  #requireInProgressExecution(
    context: ActorContext,
    input: { admissionId: string; requestId: string; expectedRequestVersion: number; executionId: string },
  ) {
    this.owner.assertNotArchived(context, input.admissionId)
    this.owner.orders.assertAdmitted(context, input.admissionId)
    const request = this.currentRequest(context, input)
    const execution = this.executionForRequest(context, request.request_id)
    if (!execution || execution.execution_id !== input.executionId || execution.status !== 'in-progress') {
      throw new InpatientError('INPATIENT_SURGERY_NOT_IN_PROGRESS', '须引用本次住院正在进行的手术')
    }
    return { request, execution }
  }
  supplementMaterial(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientSurgerySupplementMaterialInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.surgery.supplement-material', expectedVersions: {}, dataSchema: inpatientSurgerySchema,
      authorize: () => this.authorize(context, input.admissionId, ['inpatient-doctor']) }, () => {
      this.owner.assertNotArchived(context, input.admissionId)
      const admission = this.owner.admissionBinding(context, input.admissionId)
      if (admission.financialStatus !== 'open') throw new InpatientError('INPATIENT_ACCOUNT_SETTLED', '已结算住院账户不能补登记耗材')
      if (admission.status !== 'admitted') throw new InpatientError('INPATIENT_STATE_CONFLICT', '仅在院患者可以补登记术后耗材')
      const request = this.requestRow(context, input), execution = this.executionForRequest(context, request.request_id)
      if (request.status !== 'completed' || !execution || execution.execution_id !== input.executionId || execution.status !== 'completed')
        throw new InpatientError('INPATIENT_SURGERY_NOT_COMPLETED', '须引用本次住院已完成的原手术')
      const effects: InpatientEffects = []
      this.writeMaterial(context, execution, input.material, input.note, effects, { addendumCharge: input.expectedCharge, recordingKind: 'postoperative-addendum' })
      this.advanceRequest(context, request, effects)
      return { data: this.read(context, input.admissionId), effects }
    })
  }
  correctMaterial(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientSurgeryCorrectMaterialInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.surgery.correct-material', expectedVersions: {}, dataSchema: inpatientSurgerySchema,
      authorize: () => this.authorize(context, input.admissionId, ['inpatient-doctor']) }, () => {
      this.owner.assertNotArchived(context, input.admissionId)
      const request = this.requestRow(context, input), execution = this.executionForRequest(context, request.request_id)
      const admission = this.owner.admissionBinding(context, input.admissionId)
      if (admission.financialStatus !== 'open') throw new InpatientError('INPATIENT_ACCOUNT_SETTLED', '已结算住院账户不能更正临床耗材记录')
      if (!execution || execution.execution_id !== input.executionId) throw new InpatientError('INPATIENT_SURGERY_NOT_FOUND', '未找到本次住院的手术', 404)
      const effects: InpatientEffects = []
      this.applyCorrection(context, input, execution, effects)
      this.advanceRequest(context, request, effects)
      return { data: this.read(context, input.admissionId), effects }
    })
  }
  private applyCorrection(context: ActorContext, input: z.infer<typeof inpatientSurgeryCorrectMaterialInputSchema>,
    execution: z.infer<typeof executionRowSchema>, effects: InpatientEffects, replacementSnapshot?: z.infer<typeof inpatientMaterialItemSchema>) {
    const material = z.object({ quantity: z.number(), reservation_id: z.string().nullable(), recording_kind: inpatientSurgeryMaterialHistorySchema.shape.recordingKind.nullable(),
      charge_id: z.string().nullable(), charge_version: z.number().nullable() }).optional()
      .parse(this.owner.database.driver.prepare(`SELECT m.quantity,r.reservation_id,r.recording_kind,b.charge_id,b.version charge_version FROM inpatient_surgery_material m
        LEFT JOIN inpatient_surgery_material_record r ON r.workspace_id=m.workspace_id AND r.epoch=m.epoch AND r.material_use_id=m.material_use_id
        LEFT JOIN inpatient_charge b ON b.workspace_id=m.workspace_id AND b.epoch=m.epoch AND b.kind='material' AND b.source_id=m.material_use_id AND b.admission_id=?
        WHERE m.workspace_id=? AND m.epoch=? AND m.execution_id=? AND m.material_use_id=?`)
        .get(input.admissionId, context.workspaceId, context.epoch, execution.execution_id, input.materialUseId))
    if (!material) throw new InpatientError('INPATIENT_MATERIAL_USE_NOT_FOUND', '未找到本手术的耗材使用', 404)
    if (this.owner.database.driver.prepare('SELECT 1 FROM inpatient_surgery_material_correction WHERE workspace_id=? AND epoch=? AND material_use_id=?')
      .get(context.workspaceId, context.epoch, input.materialUseId)) throw new InpatientError('INPATIENT_MATERIAL_USE_CORRECTED', '该使用已更正，请核对当前有效记录')
    if (!material.charge_id || material.charge_version === null) throw new InpatientError('INPATIENT_MATERIAL_CHARGE_MISSING', '原耗材费用缺失，须先核实账务')
    const now = this.owner.virtualTime(context)
    const reversal = z.object({ charge_id: z.string() }).optional().parse(this.owner.database.driver.prepare(
      'SELECT charge_id FROM inpatient_charge WHERE workspace_id=? AND epoch=? AND admission_id=? AND reversal_of=?')
      .get(context.workspaceId, context.epoch, input.admissionId, material.charge_id))
    const reversalId = reversal?.charge_id ?? this.owner.billing.reverse(context, { admissionId: input.admissionId,
      chargeId: material.charge_id, expectedChargeVersion: material.charge_version, reason: input.note, serviceDate: businessDate(now), virtualTime: now }, effects)
    let replacement = input.replacement
    if (material.reservation_id) {
      const reservation = z.object({ quantity: z.number(), consumed_quantity: z.number(), status: z.string(), version: z.number(), release_reason: z.string().nullable() }).parse(
        this.owner.database.driver.prepare('SELECT * FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND reservation_id=?')
          .get(context.workspaceId, context.epoch, material.reservation_id))
      if (reservation.consumed_quantity < material.quantity) throw new InpatientError('INPATIENT_RESERVATION_CONFLICT', '原预留消耗与使用不一致，须先核实')
      if (replacement?.reservationId === material.reservation_id) {
        if (replacement.expectedReservationVersion !== reservation.version)
          throw new InpatientError('INPATIENT_RESERVATION_CONFLICT', '原预留版本已变化，请重新核对')
        // 同一事务先退回原消耗；替换继续使用刚核实的预留及其内部新版本。
        replacement = { ...replacement, expectedReservationVersion: reservation.version + 1 }
      }
      const released = reservation.status === 'released' || reservation.release_reason !== null
      this.owner.database.driver.prepare(`UPDATE inpatient_material_reservation SET consumed_quantity=consumed_quantity-?,version=version+1,status=?,material_use_id=NULL,
        release_reason=CASE WHEN ? THEN COALESCE(release_reason,?) ELSE release_reason END WHERE workspace_id=? AND epoch=? AND reservation_id=? AND version=?`)
        .run(material.quantity, released ? 'released' : 'reserved', released ? 1 : 0, '术后更正收拢本手术未使用预留余量', context.workspaceId, context.epoch, material.reservation_id, reservation.version)
      effects.push({ kind: 'updated', reference: `InpatientMaterialReservation/${material.reservation_id}`, versionId: String(reservation.version + 1) })
    }
    const replacementId = replacement === undefined ? null : this.writeMaterial(context, execution, replacement, input.note, effects,
      { restoredReservationId: material.reservation_id ?? undefined, frozenItem: replacementSnapshot, recordingKind: material.recording_kind ?? 'initial' })
    const correctionId = uuidv7()
    this.owner.database.driver.prepare('INSERT INTO inpatient_surgery_material_correction VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(context.workspaceId, context.epoch, correctionId, input.materialUseId, replacementId, material.charge_id,
        reversalId, now, context.actorId, context.practitionerRoleId!, input.note)
    const procedure = this.owner.fhir.read(context, 'Procedure', execution.execution_id)
    const updated = this.owner.fhir.updateProjection(context, { ...procedure, note: [...z.array(z.object({ text: z.string() })).parse(procedure.note ?? []), { text: input.note }] }, procedure.meta!.versionId!)
    effects.push({ kind: 'created', reference: `InpatientSurgeryMaterialCorrection/${correctionId}`, versionId: '1' },
      { kind: 'updated', reference: `Procedure/${execution.execution_id}`, versionId: updated.meta!.versionId! })
  }
  complete(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientSurgeryCompleteInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.surgery.complete', expectedVersions: {}, dataSchema: inpatientSurgerySchema,
      authorize: () => this.authorize(context, input.admissionId, ['inpatient-doctor']) }, transaction => {
      this.owner.assertNotArchived(context, input.admissionId)
      this.owner.orders.assertAdmitted(context, input.admissionId)
      const request = this.currentRequest(context, input), execution = this.executionForRequest(context, request.request_id)
      if (!execution || execution.execution_id !== input.executionId || execution.status !== 'in-progress')
        throw new InpatientError('INPATIENT_SURGERY_NOT_IN_PROGRESS', '须完成本次住院正在进行的原手术')
      const effects: InpatientEffects = []
      const explicitNote = input.note?.trim() || undefined
      let resolvedNote = explicitNote
      if (input.reconciliation) {
        const { reconciliation, ...common } = input
        const { expectedFingerprint, ...draft } = reconciliation
        const planned = this.completionPlan(context, { ...common, ...draft })
        const { preview } = planned
        resolvedNote = planned.resolvedNote
        if (preview.fingerprint !== expectedFingerprint)
          throw new InpatientError('INPATIENT_SURGERY_REVIEW_CONFLICT', '核实依据已变化，请重新预览差额后确认')
        // 同一预留的减少先退回余量，随后才可按其他冻结依据增加。
        for (const row of preview.materials.toSorted((left, right) => left.deltaQuantity - right.deltaQuantity)) {
          const selection = { materialId: row.item.id, catalogVersion: row.item.version,
            ...(row.reservationId === null ? {} : { reservationId: row.reservationId }) }
          if (row.deltaQuantity > 0) {
            const reservation = this.owner.drg.reservations(context, input.admissionId).reservations.find(item => item.id === row.reservationId)
            this.writeMaterial(context, execution, { ...selection, quantity: row.deltaQuantity,
              ...(reservation ? { expectedReservationVersion: reservation.version } : {}) }, resolvedNote, effects, { frozenItem: row.item })
          } else if (row.deltaQuantity < 0) {
            const snapshot = this.read(context, input.admissionId).inProgress.find(item => item.id === input.executionId)!
            const uses = row.materialUseIds.map(id => snapshot.materials.find(item => item.id === id)!)
            for (const { materialUseId, quantity } of materialReductions(uses, row.quantity)) {
              const reservation = this.owner.drg.reservations(context, input.admissionId).reservations.find(item => item.id === row.reservationId)
              this.applyCorrection(context, { ...common, note: resolvedNote, materialUseId,
                ...(quantity === 0 ? {} : { replacement: { ...selection, quantity,
                  ...(reservation ? { expectedReservationVersion: reservation.version } : {}) } }) }, execution, effects, row.item)
            }
          }
        }
        for (const selected of reconciliation.releaseReservations) {
          const reservation = this.owner.drg.reservations(context, input.admissionId).reservations.find(item => item.id === selected.reservationId)!
          this.owner.database.driver.prepare("UPDATE inpatient_material_reservation SET status=CASE WHEN consumed_quantity=quantity THEN 'replaced' ELSE 'released' END,release_reason=?,version=version+1 WHERE workspace_id=? AND epoch=? AND reservation_id=? AND version=?")
            .run(resolvedNote, context.workspaceId, context.epoch, reservation.id, reservation.version)
          effects.push({ kind: 'updated', reference: `InpatientMaterialReservation/${reservation.id}`, versionId: String(reservation.version + 1) })
        }
      } else if (!resolvedNote) {
        const currentExecution = this.read(context, input.admissionId).inProgress.find(item => item.id === input.executionId && item.requestId === input.requestId)!
        const plannedProcedure = inpatientProcedureItemSchema.parse(JSON.parse(request.planned_procedure_json))
        const allReservations = this.owner.drg.reservations(context, input.admissionId).reservations
        const requestReservationIds = new Set(allReservations.filter(item => item.requestId === input.requestId).map(item => item.id))
        const hasUnusedReservation = allReservations.some(item =>
          item.requestId === input.requestId && item.status === 'reserved' && (item.remainingQuantity ?? item.quantity - item.consumedQuantity) > 0)
        const activeHistory = currentExecution.materialHistory.filter(use => use.correction === null)
        const notePolicy = evaluateCompletionNoteRequirement({
          finalMaterials: activeHistory.map(use => ({
            materialId: use.item.id, catalogVersion: use.item.version, quantity: use.quantity, deltaQuantity: 0, reservationId: use.reservationId,
          })),
          requestReservationIds,
          hasUnusedReservation,
          planBasis: this.owner.materialPlans.forRequestFacts(context, input.admissionId, input.requestId),
          samePlannedProcedure: isSamePlannedProcedure(currentExecution.actualProcedure, plannedProcedure),
        })
        if (notePolicy.noteRequired) {
          throw new InpatientError('INPATIENT_SURGERY_NOTE_REQUIRED', '存在未消耗本台预留或未核实的术前清单差异，请填写核实说明', 400)
        }
        resolvedNote = notePolicy.defaultNote
      }
      this.finish(context, request, execution, resolvedNote, effects, transaction, Boolean(explicitNote))
      const retained = this.owner.drg.reservations(context, input.admissionId).reservations.filter(item => item.requestId === input.requestId && item.status === 'reserved')
      return { data: this.read(context, input.admissionId), effects,
        warnings: retained.map(item => `未选择释放的原预留已保留：${item.id}，余量 ${item.remainingQuantity} ${item.unit ?? '单位未确认'}`) }
    })
  }
  previewCompletion(context: ActorContext, raw: unknown) {
    const input = inpatientSurgeryCompletionReviewInputSchema.parse(raw)
    this.authorize(context, input.admissionId, ['inpatient-doctor'])
    return this.completionPlan(context, input).preview
  }
  private completionPlan(context: ActorContext, input: z.infer<typeof inpatientSurgeryCompletionReviewInputSchema>) {
    this.owner.assertNotArchived(context, input.admissionId)
    this.owner.orders.assertAdmitted(context, input.admissionId)
    const request = this.currentRequest(context, input)
    const plannedProcedure = inpatientProcedureItemSchema.parse(JSON.parse(request.planned_procedure_json))
    const execution = this.read(context, input.admissionId).inProgress.find(item => item.id === input.executionId && item.requestId === input.requestId)
    if (!execution) throw new InpatientError('INPATIENT_SURGERY_NOT_IN_PROGRESS', '须核实本次住院正在进行的原手术')
    const frozen = z.array(z.object({ reservation_id: z.string(), material_snapshot_json: z.string().nullable() })).parse(this.owner.database.driver.prepare(
      'SELECT reservation_id,material_snapshot_json FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY reservation_id')
      .all(context.workspaceId, context.epoch, input.admissionId))
    const reservationItems: Record<string, z.infer<typeof inpatientMaterialItemSchema>> = {}
    for (const row of frozen) {
      const historical = execution.materialHistory.filter(use => use.reservationId === row.reservation_id)
      const snapshot = row.material_snapshot_json !== null ? inpatientMaterialItemSchema.parse(JSON.parse(row.material_snapshot_json))
        : historical.length > 0 && historical.every(use => JSON.stringify(use.item) === JSON.stringify(historical[0]!.item)) ? historical[0]!.item : undefined
      if (snapshot) reservationItems[row.reservation_id] = snapshot
    }
    const chargeRows = z.array(z.object({ material_use_id: z.string(), charge_id: z.string(), version: z.number(), amount_fen: z.number(), reversal_id: z.string().nullable() })).parse(
      this.owner.database.driver.prepare(`SELECT m.material_use_id,b.charge_id,b.version,b.amount_fen,r.charge_id reversal_id
        FROM inpatient_surgery_material m JOIN inpatient_charge b ON b.workspace_id=m.workspace_id AND b.epoch=m.epoch AND b.source_id=m.material_use_id AND b.kind='material'
        LEFT JOIN inpatient_charge r ON r.workspace_id=b.workspace_id AND r.epoch=b.epoch AND r.reversal_of=b.charge_id AND r.admission_id=b.admission_id
        WHERE m.workspace_id=? AND m.epoch=? AND m.execution_id=? AND b.admission_id=? ORDER BY m.material_use_id`)
        .all(context.workspaceId, context.epoch, input.executionId, input.admissionId))
    const charges: MaterialChargeBasis = Object.fromEntries(chargeRows.map(row => [row.material_use_id,
      { chargeId: row.charge_id, version: row.version, amountFen: row.amount_fen, reversalId: row.reversal_id }]))
    const autoStopPreopOrders = request.preop_order_policy === 'stop-on-completion'
      ? this.owner.orders.previewAutoStopPreopOrders(context, input.admissionId)
      : []
    return planSurgeryCompletion(input, execution, plannedProcedure, this.catalog(context), this.owner.drg.reservations(context, input.admissionId), reservationItems, charges,
      { workspaceId: context.workspaceId, epoch: context.epoch, actorId: context.actorId, practitionerRoleId: context.practitionerRoleId! },
      this.owner.materialPlans.forRequestFacts(context, input.admissionId, input.requestId),
      { preopOrderPolicy: request.preop_order_policy, autoStopPreopOrders })
  }
  private readyRequest(context: ActorContext, input: { admissionId: string; requestId: string; expectedRequestVersion: number }) {
    this.owner.assertNotArchived(context, input.admissionId)
    this.owner.orders.assertAdmitted(context, input.admissionId)
    const row = this.currentRequest(context, input)
    if (row.status !== 'ready' || row.preop_check_json === null || row.consent_confirmation_json === null)
      throw new InpatientError('INPATIENT_SURGERY_NOT_READY', '术前检查核对与已签署知情同意确认均须完成')
    if (this.executionForRequest(context, row.request_id)) throw new InpatientError('INPATIENT_SURGERY_IN_PROGRESS', '手术已经开始，请逐笔登记并完成原手术')
    return row
  }
  private createExecution(context: ActorContext, row: z.infer<typeof requestRowSchema>, actual: z.infer<typeof inpatientProcedureItemSchema>,
    note: string, status: 'in-progress' | 'completed', effects: InpatientEffects) {
    const admission = this.owner.admissionBinding(context, row.admission_id), id = uuidv7(), now = this.owner.virtualTime(context)
    this.owner.database.driver.prepare(`INSERT INTO inpatient_surgery_execution
      (workspace_id,epoch,execution_id,request_id,admission_id,actual_procedure_json,performed_at,performed_by,practitioner_role_id,organization_id,note,status,completed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(context.workspaceId, context.epoch, id, row.request_id, admission.id,
        JSON.stringify(actual), now, context.actorId, context.practitionerRoleId!, admission.organizationId, note, status, status === 'completed' ? now : null)
    this.owner.fhir.createProjection(context, { resourceType: 'Procedure', id, status,
      code: { coding: [clinicalCoding(actual.coding)], text: actual.coding.display }, subject: { reference: `Patient/${admission.patientId}` },
      encounter: { reference: `Encounter/${admission.id}` }, basedOn: [{ reference: `ServiceRequest/${row.request_id}` }], occurrenceDateTime: now,
      recorded: now, performer: [{ actor: { reference: `PractitionerRole/${context.practitionerRoleId}` }, onBehalfOf: { reference: `Organization/${admission.organizationId}` } }], note: [{ text: note }] })
    effects.push({ kind: 'created', reference: `Procedure/${id}`, versionId: '1' })
    return this.executionForRequest(context, row.request_id)!
  }
  private billProcedure(context: ActorContext, execution: z.infer<typeof executionRowSchema>, effects: InpatientEffects) {
    const actual = inpatientProcedureItemSchema.parse(JSON.parse(execution.actual_procedure_json)), now = this.owner.virtualTime(context)
    this.owner.billing.record(context, { admissionId: execution.admission_id, organizationId: execution.organization_id,
      kind: 'surgery', sourceId: execution.execution_id, amountFen: actual.chargeDefinition.priceFen,
      serviceDate: businessDate(now), virtualTime: now, label: actual.coding.display,
      coverageJson: JSON.stringify({ code: `synthetic-inpatient-surgery:${actual.id}`, version: `item-v${actual.version}`, included: true, priorSelfPayBps: 0 }) }, effects)
  }
  private billLinkedNursing(context: ActorContext, execution: z.infer<typeof executionRowSchema>, effects: InpatientEffects) {
    const actual = inpatientProcedureItemSchema.parse(JSON.parse(execution.actual_procedure_json))
    const { bindings, configByServiceId } = this.#readNursingBindings(context)
    const linked = linkedNursingForProcedureId(bindings, actual.id)
    if (!linked) return
    const now = this.owner.virtualTime(context)
    const stored = storedLinkedNursingSchema.parse({
      serviceId: linked.serviceId,
      serviceVersion: linked.serviceVersion,
      display: linked.display,
      unit: linked.unit,
      amountFen: linked.priceFen,
    })
    this.owner.database.driver.prepare(
      'UPDATE inpatient_surgery_execution SET linked_nursing_json=? WHERE workspace_id=? AND epoch=? AND execution_id=?',
    ).run(JSON.stringify(stored), context.workspaceId, context.epoch, execution.execution_id)
    const coverageJson = freezeCatalogCoverageJson(
      `synthetic-inpatient-service:${linked.serviceId}`,
      `item-v${linked.serviceVersion}`,
      readConfigInsuranceCoverage(configByServiceId.get(linked.serviceId)),
    )
    this.owner.billing.record(context, {
      admissionId: execution.admission_id,
      organizationId: execution.organization_id,
      kind: 'service',
      sourceId: execution.execution_id,
      amountFen: linked.priceFen,
      serviceDate: businessDate(now),
      virtualTime: now,
      label: `${linked.display}（${actual.coding.display}）`,
      coverageJson,
    }, effects)
  }
  private finish(context: ActorContext, request: z.infer<typeof requestRowSchema>, execution: z.infer<typeof executionRowSchema>, note: string, effects: InpatientEffects, transaction: CommandTransaction, explicitNote = true) {
    const now = this.owner.virtualTime(context)
    if (execution.status === 'in-progress') {
      this.billProcedure(context, execution, effects)
      this.billLinkedNursing(context, execution, effects)
    }
    const executionNote = execution.status === 'in-progress' ? mergeExecutionCompletionNote(execution.note, note, explicitNote) : note
    this.owner.database.driver.prepare("UPDATE inpatient_surgery_execution SET status='completed',completed_at=?,note=? WHERE workspace_id=? AND epoch=? AND execution_id=? AND status='in-progress'")
      .run(now, executionNote, context.workspaceId, context.epoch, execution.execution_id)
    this.owner.database.driver.prepare("UPDATE inpatient_surgery_request SET status='completed',version=version+1 WHERE workspace_id=? AND epoch=? AND request_id=? AND version=?")
      .run(context.workspaceId, context.epoch, request.request_id, request.version)
    if (execution.status === 'in-progress') {
      const procedure = this.owner.fhir.read(context, 'Procedure', execution.execution_id)
      const updated = this.owner.fhir.updateProjection(context, { ...procedure, status: 'completed',
        note: [...z.array(z.object({ text: z.string() })).parse(procedure.note ?? []), { text: note }] }, procedure.meta!.versionId!)
      effects.push({ kind: 'updated', reference: `Procedure/${execution.execution_id}`, versionId: updated.meta!.versionId! })
    }
    effects.push({ kind: 'updated', reference: `InpatientSurgeryRequest/${request.request_id}`, versionId: String(request.version + 1) })
    this.updateRequestProjection(context, request.request_id, 'completed', effects)
    if (request.preop_order_policy === 'stop-on-completion') {
      const actual = inpatientProcedureItemSchema.parse(JSON.parse(execution.actual_procedure_json))
      this.owner.orders.requestStopForSurgeryCompletion(
        context,
        request.admission_id,
        execution.execution_id,
        actual.coding.display,
        effects,
      )
    }
    this.owner.angiography.schedule(context, request.admission_id, execution.execution_id, transaction)
  }
  private executionForRequest(context: ActorContext, requestId: string) {
    return executionRowSchema.optional().parse(this.owner.database.driver.prepare(
      'SELECT * FROM inpatient_surgery_execution WHERE workspace_id=? AND epoch=? AND request_id=?').get(context.workspaceId, context.epoch, requestId))
  }
  private advanceRequest(context: ActorContext, row: z.infer<typeof requestRowSchema>, effects: InpatientEffects) {
    this.owner.database.driver.prepare('UPDATE inpatient_surgery_request SET version=version+1 WHERE workspace_id=? AND epoch=? AND request_id=? AND version=?')
      .run(context.workspaceId, context.epoch, row.request_id, row.version)
    effects.push({ kind: 'updated', reference: `InpatientSurgeryRequest/${row.request_id}`, versionId: String(row.version + 1) })
  }
  private writeMaterial(context: ActorContext, execution: z.infer<typeof executionRowSchema>, selection: z.infer<typeof inpatientSurgeryMaterialSelectionSchema>, note: string | undefined, effects: InpatientEffects,
    { restoredReservationId, frozenItem, addendumCharge, recordingKind = 'initial' }: { restoredReservationId?: string | undefined; frozenItem?: z.infer<typeof inpatientMaterialItemSchema> | undefined;
      recordingKind?: z.infer<typeof inpatientSurgeryMaterialHistorySchema>['recordingKind'];
      addendumCharge?: z.infer<typeof inpatientSurgerySupplementMaterialInputSchema>['expectedCharge'] } = {}) {
    const reservation = selection.reservationId === undefined ? undefined : z.object({ reservation_id: z.string(), material_id: z.string(), catalog_version: z.number(),
      request_id: z.string().nullable(), quantity: z.number(), consumed_quantity: z.number(), price_fen: z.number(), status: z.string(), version: z.number(), reason: z.string(), material_snapshot_json: z.string().nullable() }).optional()
      .parse(this.owner.database.driver.prepare('SELECT * FROM inpatient_material_reservation WHERE workspace_id=? AND epoch=? AND admission_id=? AND reservation_id=?')
        .get(context.workspaceId, context.epoch, execution.admission_id, selection.reservationId))
    if (selection.reservationId !== undefined && !reservation) throw new InpatientError('INPATIENT_RESERVATION_NOT_FOUND', '未找到本次住院的耗材预留', 404)
    if (reservation && ((reservation.status !== 'reserved' && !(reservation.status === 'released' && reservation.reservation_id === restoredReservationId))
      || reservation.version !== selection.expectedReservationVersion
      || reservation.material_id !== selection.materialId || reservation.catalog_version !== selection.catalogVersion
      || reservation.quantity - reservation.consumed_quantity < selection.quantity || (reservation.request_id !== null && reservation.request_id !== execution.request_id)))
      throw new InpatientError('INPATIENT_RESERVATION_CONFLICT', '预留余量、产品、版本或手术归属已变化，请重新核对')
    const explicitNote = note?.trim() || undefined
    if (!explicitNote && (!reservation || reservation.request_id !== execution.request_id)) {
      throw new InpatientError('INPATIENT_SURGERY_NOTE_REQUIRED', '计划外耗材或非本台手术预留使用须填写临床原因', 400)
    }
    const resolvedNote = explicitNote ?? formatPlannedReservationMaterialNote(reservation!.reason)
    const current = this.#ensureCatalogItems(context).materials.find(item => item.id === selection.materialId && item.version === selection.catalogVersion)
    if (!frozenItem && (!current || !('chargeDefinition' in current))) throw new InpatientError('CATALOG_CONFLICT', '耗材目录、版本或计价单位不可用')
    const basis = frozenItem ?? inpatientMaterialItemSchema.parse(current)
    if (addendumCharge && reservation) {
      const frozen = reservation.material_snapshot_json === null ? undefined : inpatientMaterialItemSchema.parse(JSON.parse(reservation.material_snapshot_json))
      if (!frozen || frozen.id !== basis.id || frozen.version !== basis.version
        || frozen.chargeDefinition.id !== basis.chargeDefinition.id || frozen.chargeDefinition.unit !== basis.chargeDefinition.unit)
        throw new InpatientError('INPATIENT_RESERVATION_CONFLICT', '预留的冻结收费依据不完整或与当前目录不一致，请核对后按当前目录登记额外使用')
    }
    const item = reservation ? { ...basis, chargeDefinition: { ...basis.chargeDefinition, priceFen: reservation.price_fen } } : basis
    if (addendumCharge && (addendumCharge.id !== item.chargeDefinition.id || addendumCharge.priceFen !== item.chargeDefinition.priceFen || addendumCharge.unit !== item.chargeDefinition.unit))
      throw new InpatientError('CATALOG_CONFLICT', '耗材计费依据已变化，请刷新并重新核对新增费用')
    const id = uuidv7(), now = this.owner.virtualTime(context), amountFen = z.number().int().nonnegative().safe().parse(item.chargeDefinition.priceFen * selection.quantity)
    this.owner.database.driver.prepare('INSERT INTO inpatient_surgery_material VALUES(?,?,?,?,?,?,?)')
      .run(context.workspaceId, context.epoch, id, execution.execution_id, JSON.stringify(item), selection.quantity, amountFen)
    this.owner.database.driver.prepare(`INSERT INTO inpatient_surgery_material_record
      (workspace_id,epoch,material_use_id,reservation_id,recorded_at,recorded_by,practitioner_role_id,note,recording_kind) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(context.workspaceId, context.epoch, id, selection.reservationId ?? null, now, context.actorId, context.practitionerRoleId!, resolvedNote, recordingKind)
    if (reservation) {
      const consumed = reservation.consumed_quantity + selection.quantity, replaced = consumed === reservation.quantity
      this.owner.database.driver.prepare(`UPDATE inpatient_material_reservation SET consumed_quantity=?,version=version+1,status=?,material_use_id=?
        WHERE workspace_id=? AND epoch=? AND reservation_id=? AND version=?`).run(consumed, replaced ? 'replaced' : reservation.status, replaced ? id : null,
          context.workspaceId, context.epoch, reservation.reservation_id, reservation.version)
      effects.push({ kind: 'updated', reference: `InpatientMaterialReservation/${reservation.reservation_id}`, versionId: String(reservation.version + 1) })
    }
    this.owner.billing.record(context, { admissionId: execution.admission_id, organizationId: execution.organization_id,
      kind: 'material', sourceId: id, serviceDate: businessDate(now), virtualTime: now, amountFen, label: item.display,
      coverageJson: JSON.stringify({ code: `synthetic-inpatient-material:${item.id}`, version: `item-v${item.version}`, included: false, priorSelfPayBps: 0 }) }, effects)
    effects.push({ kind: 'created', reference: `InpatientSurgeryMaterial/${id}`, versionId: '1' })
    return id
  }
  private writeMedication(
    context: ActorContext,
    execution: z.infer<typeof executionRowSchema>,
    selection: z.infer<typeof inpatientSurgeryMedicationSelectionSchema>,
    note: string | undefined,
    effects: InpatientEffects,
  ) {
    const admission = this.owner.admissionBinding(context, execution.admission_id)
    const { medications, configByItemId } = this.#readBaseStockMedications(context)
    const item = medications.find(
      candidate => candidate.id === selection.medicationId && candidate.version === selection.catalogVersion,
    )
    if (!item) throw new InpatientError('CATALOG_CONFLICT', '台内基数药目录或版本无效')
    const safetyDose = surgicalMedicationSafetyDose(item, selection.doseText, selection.quantity)
    const candidate = {
      catalogItemId: item.id,
      code: item.code,
      display: item.display,
      pharmacologyClasses: item.safety?.pharmacologyClasses ?? this.owner.workflow.clinicalQuality.medicationClasses(context, item.id),
      doseLimits: item.safety?.doseLimits,
      doseText: safetyDose,
      frequencyCode: 'ONCE',
    }
    const redLineCheck = () => {
      const check = this.owner.workflow.clinicalQuality.inpatientOrder(
        this.owner,
        context,
        admission.id,
        admission.patientId,
        candidate,
        [],
        { skipRenal: true },
      )
      return check.redLines.length > 0 ? check : undefined
    }
    const validation = validateSurgicalMedicationSelection(item, selection)
    if (!validation.ok) {
      if (validation.reason === 'MEDICATION_ROUTE_NOT_ALLOWED') {
        throw new InpatientError('CATALOG_CONFLICT', '给药途径不符合台内基数药允许范围', 409, 'MEDICATION_ROUTE_NOT_ALLOWED', redLineCheck())
      }
      throw new InpatientError('CATALOG_CONFLICT', '剂量、单位或每次数量不符合台内基数药目录', 409, 'MEDICATION_DOSAGE_NOT_ALLOWED', redLineCheck())
    }
    const check = redLineCheck()
    if (check?.redLines.some(line => line.code === 'MEDICATION_ALLERGY_CONFLICT')) {
      throw new InpatientError('CATALOG_CONFLICT', '药品与已确认的有效药物过敏冲突', 409, 'MEDICATION_ALLERGY_CONFLICT', check)
    }
    const id = uuidv7()
    const administrationId = uuidv7()
    const now = this.owner.virtualTime(context)
    const resolvedNote = note?.trim() || DEFAULT_INTRAOPERATIVE_MEDICATION_NOTE
    const amountFen = z.number().int().nonnegative().safe().parse(item.priceFen * selection.quantity)
    this.owner.database.driver.prepare(`
      INSERT INTO inpatient_surgery_medication(
        workspace_id,epoch,medication_use_id,execution_id,administration_id,medication_id,catalog_version,
        display,dose_text,quantity,unit,route_code,price_fen,amount_fen,recorded_at,recorded_by,practitioner_role_id,note
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      context.workspaceId,
      context.epoch,
      id,
      execution.execution_id,
      administrationId,
      item.id,
      item.version,
      item.display,
      selection.doseText,
      selection.quantity,
      item.unit,
      selection.routeCode,
      item.priceFen,
      amountFen,
      now,
      context.actorId,
      context.practitionerRoleId!,
      resolvedNote,
    )
    this.owner.fhir.create(context, {
      resourceType: 'MedicationAdministration',
      id: administrationId,
      status: 'completed',
      medication: { reference: { reference: `Medication/${item.id}`, display: item.display } },
      subject: { reference: `Patient/${admission.patientId}` },
      encounter: { reference: `Encounter/${admission.id}` },
      partOf: [{ reference: `Procedure/${execution.execution_id}` }],
      occurenceDateTime: now,
      recorded: now,
      performer: [{ actor: { reference: { reference: `PractitionerRole/${context.practitionerRoleId}` } } }],
      dosage: {
        route: medicationRouteConcept(selection.routeCode),
        text: selection.doseText,
        dose: { value: selection.quantity, unit: item.unit },
      },
      note: [{ text: resolvedNote }],
    })
    const actual = inpatientProcedureItemSchema.parse(JSON.parse(execution.actual_procedure_json))
    const coverageJson = freezeCatalogCoverageJson(
      `synthetic-inpatient-medication:${item.id}`,
      `item-v${item.version}`,
      readConfigInsuranceCoverage(configByItemId.get(item.id)),
    )
    this.owner.billing.record(context, {
      admissionId: execution.admission_id,
      organizationId: execution.organization_id,
      kind: 'medication',
      sourceId: id,
      serviceDate: businessDate(now),
      virtualTime: now,
      amountFen,
      label: `${item.display}（${actual.coding.display} · ${selection.doseText}）`,
      coverageJson,
    }, effects)
    effects.push(
      { kind: 'created', reference: `MedicationAdministration/${administrationId}`, versionId: '1' },
      { kind: 'created', reference: `InpatientSurgeryMedication/${id}`, versionId: '1' },
    )
    return id
  }
  private authorize(context: ActorContext, admissionId: string, roles: string[]) {
    this.owner.assertRole(context, roles)
    this.owner.admissionBinding(context, admissionId)
  }
  private procedure(context: ActorContext, id: string, version: number) {
    const item = this.#ensureCatalogItems(context).procedures.find(item => item.id === id && item.version === version)
    if (!item) throw new InpatientError('CATALOG_CONFLICT', '术式目录或版本无效')
    return item
  }
  private requestRow(context: ActorContext, input: { admissionId: string; requestId: string; expectedRequestVersion: number }) {
    const row = requestRowSchema.optional().parse(this.owner.database.driver.prepare(
      'SELECT * FROM inpatient_surgery_request WHERE workspace_id=? AND epoch=? AND admission_id=? AND request_id=?').get(context.workspaceId, context.epoch, input.admissionId, input.requestId))
    if (!row) throw new InpatientError('INPATIENT_SURGERY_NOT_FOUND', '未找到本次住院的手术申请', 404)
    if (row.version !== input.expectedRequestVersion) throw new InpatientError('INPATIENT_SURGERY_CONFLICT', '手术申请版本已变化')
    return row
  }
  private currentRequest(context: ActorContext, input: { admissionId: string; requestId: string; expectedRequestVersion: number }) {
    const row = this.requestRow(context, input)
    if (!['requested','ready'].includes(row.status)) throw new InpatientError('INPATIENT_SURGERY_CONFLICT', '手术申请状态已变化')
    return row
  }
  private updateRequestProjection(context: ActorContext, id: string, status: 'revoked' | 'completed', effects: InpatientEffects) {
    const request = this.owner.fhir.read(context, 'ServiceRequest', id)
    const updated = this.owner.fhir.update(context, { ...request, status }, request.meta!.versionId!)
    effects.push({ kind: 'updated', reference: `ServiceRequest/${id}`, versionId: updated.meta!.versionId! })
  }
}
const requestRowSchema = z.object({ request_id: z.string(), admission_id: z.string(), version: z.number(), status: inpatientSurgeryRequestSchema.shape.status,
  surgery_type: surgeryTypeSchema.nullable().default(null),
  planned_procedure_json: z.string(), planned_for: z.string(),
  location_json: z.string().nullable().default(null),
  surgeon_json: z.string().nullable().default(null),
  assistant_json: z.string().nullable().default(null),
  anesthesia_method: anesthesiaMethodSchema.nullable().default(null),
  preop_order_policy: preopOrderPolicySchema.default('continue-active'),
  reason: z.string(),
  requested_at: z.string(), requested_by: z.string(), organization_id: z.string(), preop_check_json: z.string().nullable(), consent_confirmation_json: z.string().nullable(), cancellation_json: z.string().nullable() })
const executionRowSchema = z.object({ execution_id: z.string(), admission_id: z.string(), request_id: z.string(),
  actual_procedure_json: z.string(), performed_at: z.string(), performed_by: z.string(), practitioner_role_id: z.string(), organization_id: z.string(), note: z.string(), status: z.enum(['in-progress','completed']), completed_at: z.string().nullable(),
  linked_nursing_json: z.string().nullable().default(null) })

function clinicalCoding({ system, version, code, display }: z.infer<typeof inpatientProcedureItemSchema>['coding']) { return { system, version, code, display } }
