import {
  confirmNoMedicationResponseSchema,
  dispenseResponseSchema,
  issuedPrescriptionSchema,
  issuePrescriptionResponseSchema,
  noMedicationConclusionSchema,
  prescriptionDraftContentSchema,
  prescriptionDraftResponseSchema,
  prescriptionReviewResponseSchema,
  prescriptionWithdrawalSchema,
  withdrawPrescriptionResponseSchema,
  type ApiConflict,
  type PrescriptionConflictReason,
  type PrescriptionDraftItem,
} from '@clinmesh/contracts/his'
import {
  referenceMedicationProductSchema,
  type ReferenceMedicationProduct,
} from '@clinmesh/contracts/reference-data'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import {
  type ActorContext,
  type CommandEffect,
  type CommandResponse,
  type CommandTransaction,
} from './command-executor.ts'
import { medicationDoseAndFrequencyAllowed } from './medication-rules.ts'
import { readOutpatientInsuranceAllocations } from './outpatient-insurance.ts'
import {
  activePrescriptionRowSchema,
  countRowSchema,
  isOutpatientMedicationConfig,
  issuedMedicationRequestSchema,
  issuedPrescriptionItemRowSchema,
  issuedPrescriptionRowSchema,
  legacyMedicationCatalogConfigSchema,
  medicationCatalogConfigRowSchema,
  medicationPresentationSchema,
  noMedicationConclusionRowSchema,
  parseStoredFhirResource,
  patientSummary,
  prescriptionDispenseWorkflowRowSchema,
  prescriptionDispensingRowSchema,
  prescriptionDraftStateRowSchema,
  prescriptionMedicationCatalogConfigSchema,
  prescriptionWithdrawalLookupRowSchema,
  prescriptionWithdrawalRowSchema,
  prescriptionWorkflowRowSchema,
  recommendationMedicationPresentationSchema,
  type CatalogRow,
  type DoctorRecommendationMedicationCatalogItem,
  type MedicationRuleSelection,
  type OutpatientPrescriptionTransactionPort,
  type OutpatientWorkflowContext,
} from './outpatient-workflow-context.ts'
import { WorkflowError } from './workflow-error.ts'

export interface OutpatientPrescriptionHost {
  completeScenarioIfReady(
    context: ActorContext,
    now?: string,
  ): { status: 'active' | 'completed'; effects: CommandEffect[] }
}

export class OutpatientPrescriptionService implements OutpatientPrescriptionTransactionPort {
  readonly #context: OutpatientWorkflowContext
  readonly #host: OutpatientPrescriptionHost

  constructor(options: {
    context: OutpatientWorkflowContext
    host: OutpatientPrescriptionHost
  }) {
    this.#context = options.context
    this.#host = options.host
  }

  catalogSlice(
    context: ActorContext,
    rows?: Array<CatalogRow & { config_json: string }>,
  ) {
    const sourceRows = rows ?? (this.#context.database.driver.prepare(`
      SELECT item_id, name_zh, name_en, price_fen, version, config_json
      FROM outpatient_catalog
      WHERE workspace_id = ? AND epoch = ?
        AND kind = 'medication' AND active = 1
      ORDER BY item_id
    `).all(context.workspaceId, context.epoch) as Array<CatalogRow & { config_json: string }>)
    const summary = (row: CatalogRow) => ({
      id: row.item_id,
      nameEn: row.name_en,
      nameZh: row.name_zh,
      priceFen: row.price_fen,
      version: row.version,
    })
    const medications = sourceRows.flatMap(row => {
      const rawConfig = JSON.parse(row.config_json) as unknown
      if (!isOutpatientMedicationConfig(rawConfig)) {
        return []
      }
      const presentation = medicationPresentationSchema.safeParse(rawConfig)
      return [{
        config: legacyMedicationCatalogConfigSchema.parse(rawConfig),
        presentation: presentation.success ? presentation.data : {},
        rawConfig,
        row,
      }]
    })
    const medicationMetadata = (
      dose: string,
      presentation: z.infer<typeof medicationPresentationSchema>,
    ) => ({
      ...(presentation.product?.dosageForm === undefined
        ? {}
        : { dosageForm: presentation.product.dosageForm }),
      ...(presentation.product?.packageDescription === undefined
        ? {}
        : { packageDescription: presentation.product.packageDescription }),
      strength: presentation.product?.strength ?? dose,
      ...(presentation.unit === undefined || presentation.unit === null ? {} : { unit: presentation.unit }),
    })
    const prescriptionConclusionSupported = this.prescriptionConclusionSupported(
      context,
      medications.map(({ rawConfig }) => rawConfig),
    )
    if (!prescriptionConclusionSupported) {
      return {
        medications: medications.map(({ config, presentation, row }) => ({
          ...summary(row),
          ...medicationMetadata(config.dose, presentation),
          allowedCombinationIds: config.allowedCombinationIds,
          allowedDoseTexts: config.allowedDoseTexts,
          allowedFrequencyCodes: config.allowedFrequencyCodes,
          defaultDoseText: config.dose,
          defaultFrequencyCode: config.frequency,
        })),
        prescriptionConclusionSupported: false as const,
      }
    }
    return {
      medications: medications.map(({ presentation, rawConfig, row }) => {
        const config = prescriptionMedicationCatalogConfigSchema.parse(rawConfig)
        return {
          ...summary(row),
          ...medicationMetadata(config.dose, presentation),
          allowedCombinationIds: config.allowedCombinationIds,
          allowedCourseDays: config.allowedCourseDays,
          allowedDoseTexts: config.allowedDoseTexts,
          allowedFrequencyCodes: config.allowedFrequencyCodes,
          allowedQuantities: config.allowedQuantities,
          defaultCourseDays: config.defaultCourseDays,
          defaultDoseText: config.dose,
          defaultFrequencyCode: config.frequency,
          defaultQuantity: config.defaultQuantity,
        }
      }),
      prescriptionConclusionSupported: true as const,
    }
  }

  doctorRecommendationMedications(context: ActorContext): DoctorRecommendationMedicationCatalogItem[] {
    this.#context.assertRole(context, ['outpatient-doctor'])
    const catalog = this.catalogSlice(context)
    if (!catalog.prescriptionConclusionSupported) return []
    const presentations = z.array(z.object({ item_id: z.string(), config_json: z.string() })).parse(
      this.#context.database.driver.prepare(`SELECT item_id, config_json FROM outpatient_catalog
        WHERE workspace_id = ? AND epoch = ? AND kind = 'medication' AND active = 1
        ORDER BY item_id
      `).all(context.workspaceId, context.epoch),
    )
    return catalog.medications.flatMap(medication => {
      const row = presentations.find(item => item.item_id === medication.id)!
      const presentation = recommendationMedicationPresentationSchema.parse(JSON.parse(row.config_json))
      return presentation.availableScopes !== undefined && !presentation.availableScopes.includes('outpatient')
        ? [] : [{ ...medication, ...presentation }]
    })
  }

  medicationConclusionState(context: ActorContext, caseId: string) {
    const prescriptionDraftState = prescriptionDraftStateRowSchema.optional().parse(
      this.#context.database.driver.prepare(`
        SELECT version, draft_json FROM prescription_draft_state
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, caseId),
    )
    if (prescriptionDraftState === undefined) return undefined
    const issuedPrescription = this.issuedPrescription(context, caseId)
    const noMedication = this.noMedicationConclusion(context, caseId)
    return {
      ...(prescriptionDraftState.draft_json === null
        ? {}
        : {
            draft: prescriptionDraftContentSchema.parse(
              JSON.parse(prescriptionDraftState.draft_json),
            ),
          }),
      draftVersion: prescriptionDraftState.version,
      ...(noMedication === undefined ? {} : { noMedication }),
      ...(issuedPrescription === undefined ? {} : { prescription: issuedPrescription }),
    }
  }

  completedCaseMedicationConclusion(context: ActorContext, caseId: string) {
    const prescription = this.issuedPrescription(context, caseId)
    const completedPrescription = prescription === undefined
      ? undefined
      : {
          ...prescription,
          withdrawalSupported: this.prescriptionConclusionSupportedInContext(context)
            && (
              prescription.status === 'signed' || prescription.status === 'paid'
            )
            && !this.prescriptionHasDispensedQuantity(context, prescription.id)
            && !this.#prescriptionHasUnsettledFunds(context, prescription.id),
        }
    const noMedication = this.noMedicationConclusion(context, caseId)
    if (completedPrescription === undefined && noMedication === undefined) return undefined
    return {
      ...(noMedication === undefined ? {} : { noMedication }),
      ...(completedPrescription === undefined ? {} : { prescription: completedPrescription }),
    }
  }

  medicationCompletionStatus(context: ActorContext, caseId: string) {
    const prescription = this.issuedPrescription(context, caseId)
    const prescriptionDraft = prescriptionDraftStateRowSchema.pick({ draft_json: true }).optional().parse(
      this.#context.database.driver.prepare(`
        SELECT draft_json FROM prescription_draft_state
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, caseId),
    )
    return {
      hasDraft: prescriptionDraft?.draft_json !== null && prescriptionDraft?.draft_json !== undefined,
      hasIssuedPrescription: prescription !== undefined && prescription.status !== 'withdrawn',
      hasNoMedicationConclusion: this.noMedicationConclusion(context, caseId) !== undefined,
      prescriptionConclusionSupported: this.prescriptionConclusionSupportedInContext(context),
    }
  }

  savePrescriptionDraft(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    items: PrescriptionDraftItem[]
  }): CommandResponse<z.infer<typeof prescriptionDraftResponseSchema.shape.data>> {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: prescriptionDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
        items: input.items,
      },
      operation: 'encounter.save-prescription-draft',
    }, transaction => this.applySavePrescriptionDraft(transaction, input))
  }

  applySavePrescriptionDraft(_transaction: CommandTransaction, input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    items: PrescriptionDraftItem[]
  }) {
    this.#context.assertRole(input.context, ['outpatient-doctor'])
    this.assertPrescriptionConclusionSupported(input.context)
    const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
    const encounter = this.#context.fhir.read(input.context, 'Encounter', input.encounterId)
    if (encounter.status !== 'in-progress' || outpatientCase.status === 'completed') {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        'The Encounter is not available for prescription editing',
        undefined,
        'PRESCRIPTION_ENCOUNTER_NOT_ACTIVE',
      )
    }
    this.#context.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
    this.#context.assertNoLegacyPrescriptionOwner(input.context, outpatientCase.case_id)
    const noMedication = this.#context.database.driver.prepare(`
      SELECT 1 AS present FROM no_medication_conclusion
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      LIMIT 1
    `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id)
    if (noMedication !== undefined) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        'The Encounter already has a no-medication conclusion',
        undefined,
        'PRESCRIPTION_NO_MEDICATION_RECORDED',
      )
    }
    const existingPrescription = this.#context.database.driver.prepare(`
      SELECT 1 AS present FROM prescription
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      LIMIT 1
    `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id)
    if (existingPrescription !== undefined) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        'The Encounter already has a prescription',
        undefined,
        'PRESCRIPTION_ALREADY_ISSUED',
      )
    }
    const resolvedMedications = this.#validatedPrescriptionDraftMedications(
      input.context,
      input.items,
      false,
    )
    const current = prescriptionDraftStateRowSchema.optional().parse(
      this.#context.database.driver.prepare(`
        SELECT version, draft_json FROM prescription_draft_state
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id),
    )
    if ((current?.version ?? 0) !== input.expectedDraftVersion) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        'The prescription draft version has changed',
        undefined,
        'PRESCRIPTION_DRAFT_STALE',
      )
    }
    const draft = prescriptionDraftContentSchema.parse({
      items: resolvedMedications.map(({ catalog: _catalog, external: _external, ...item }) => item),
    })
    const nextVersion = input.expectedDraftVersion + 1
    const updatedAt = this.#context.virtualTime(input.context)
    if (current === undefined) {
      this.#context.database.driver.prepare(`
        INSERT INTO prescription_draft_state (
          workspace_id, epoch, case_id, version, draft_json, updated_by, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        nextVersion,
        JSON.stringify(draft),
        input.context.actorId,
        updatedAt,
      )
    } else {
      const update = this.#context.database.driver.prepare(`
        UPDATE prescription_draft_state
        SET version = ?, draft_json = ?, updated_by = ?, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND version = ?
      `).run(
        nextVersion,
        JSON.stringify(draft),
        input.context.actorId,
        updatedAt,
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        input.expectedDraftVersion,
      )
      if (update.changes !== 1) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The prescription draft version has changed',
          undefined,
          'PRESCRIPTION_DRAFT_STALE',
        )
      }
    }
    return {
      data: { draftVersion: nextVersion },
      effects: [{
        kind: current === undefined ? 'created' as const : 'updated' as const,
        reference: `PrescriptionDraft/${outpatientCase.case_id}`,
        versionId: String(nextVersion),
      }],
    }
  }

  deletePrescriptionDraft(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<z.infer<typeof prescriptionDraftResponseSchema.shape.data>> {
    return this.#context.commands.execute({
      authorize: () => {
        this.#context.assertRole(input.context, ['outpatient-doctor'])
        const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
        this.#context.assertCaseResponsibility(input.context, outpatientCase.case_id)
      },
      context: input.context,
      dataSchema: prescriptionDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
      },
      mapExpectedVersionConflict: error => this.#context.expectedVersionWorkflowError(error, {
        code: 'WORKFLOW_CONFLICT',
        currentStatus: this.prescriptionDraftConflictStatus(
          input.context,
          input.encounterId,
        ),
        message: 'A prescription draft resource version has changed',
        owner: 'prescription-draft',
        resource: `Encounter/${input.encounterId}`,
      }),
      operation: 'encounter.delete-prescription-draft',
    }, () => {
      this.assertPrescriptionConclusionSupported(input.context)
      const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
      const encounter = this.#context.fhir.read(input.context, 'Encounter', input.encounterId)
      if (encounter.status !== 'in-progress' || outpatientCase.status === 'completed') {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The prescription draft cannot be deleted',
          {
            currentStatus: 'closed',
            owner: 'prescription-draft',
            resource: `PrescriptionDraft/${outpatientCase.case_id}`,
          },
        )
      }
      this.#context.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const state = prescriptionDraftStateRowSchema.optional().parse(
        this.#context.database.driver.prepare(`
          SELECT version, draft_json FROM prescription_draft_state
          WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id),
      )
      if (state === undefined) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The prescription draft does not exist',
          {
            currentStatus: 'missing',
            expectedVersion: String(input.expectedDraftVersion),
            owner: 'prescription-draft',
            resource: `PrescriptionDraft/${outpatientCase.case_id}`,
          },
        )
      }
      if (state.draft_json === null) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          `The prescription draft is empty at version ${state.version}`,
          {
            currentStatus: 'empty',
            currentVersion: String(state.version),
            expectedVersion: String(input.expectedDraftVersion),
            owner: 'prescription-draft',
            resource: `PrescriptionDraft/${outpatientCase.case_id}`,
          },
        )
      }
      if (state.version !== input.expectedDraftVersion) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          `The prescription draft is at version ${state.version}; expected version ${input.expectedDraftVersion}`,
          {
            currentStatus: 'draft',
            currentVersion: String(state.version),
            expectedVersion: String(input.expectedDraftVersion),
            owner: 'prescription-draft',
            resource: `PrescriptionDraft/${outpatientCase.case_id}`,
          },
        )
      }
      const draftVersion = state.version + 1
      const update = this.#context.database.driver.prepare(`
        UPDATE prescription_draft_state
        SET version = ?, draft_json = NULL, updated_by = ?, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
          AND version = ? AND draft_json IS NOT NULL
      `).run(
        draftVersion,
        input.context.actorId,
        this.#context.virtualTime(input.context),
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        state.version,
      )
      if (update.changes !== 1) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription draft version has changed')
      }
      return {
        data: { draftVersion },
        effects: [{
          kind: 'updated' as const,
          reference: `PrescriptionDraft/${outpatientCase.case_id}`,
          versionId: String(draftVersion),
        }],
      }
    })
  }

  issuePrescription(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<z.infer<typeof issuePrescriptionResponseSchema.shape.data>> {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: issuePrescriptionResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
      },
      operation: 'encounter.issue-prescription',
    }, transaction => this.applyIssuePrescription(transaction, input))
  }

  applyIssuePrescription(transaction: CommandTransaction, input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }) {
    this.#context.assertRole(input.context, ['outpatient-doctor'])
    this.assertPrescriptionConclusionSupported(input.context)
    if (input.context.practitionerRoleId === undefined) {
      throw new WorkflowError('ROLE_NOT_ALLOWED', 'A Practitioner Role is required to issue a prescription')
    }
    const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
    const encounter = transaction.fhir.read(input.context, 'Encounter', input.encounterId)
    if (encounter.status !== 'in-progress' || outpatientCase.status === 'completed') {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not available for prescription issuing', undefined, 'PRESCRIPTION_ENCOUNTER_NOT_ACTIVE')
    }
    this.#context.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
    this.#context.assertNoLegacyPrescriptionOwner(input.context, outpatientCase.case_id)
    const noMedication = this.#context.database.driver.prepare(`
      SELECT 1 AS present FROM no_medication_conclusion
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id)
    if (noMedication !== undefined) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        'The Encounter already has a no-medication conclusion',
        undefined,
        'PRESCRIPTION_NO_MEDICATION_RECORDED',
      )
    }
    const state = prescriptionDraftStateRowSchema.optional().parse(
      this.#context.database.driver.prepare(`
        SELECT version, draft_json FROM prescription_draft_state
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id),
    )
    if (
      state === undefined
      || state.draft_json === null
      || state.version !== input.expectedDraftVersion
    ) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription draft version has changed', undefined, 'PRESCRIPTION_DRAFT_STALE')
    }
    const existingPrescription = this.#context.database.driver.prepare(`
      SELECT 1 AS present FROM prescription
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id)
    if (existingPrescription !== undefined) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter already has a prescription', undefined, 'PRESCRIPTION_ALREADY_ISSUED')
    }
    const draft = prescriptionDraftContentSchema.parse(JSON.parse(state.draft_json))
    const medications = this.#validatedPrescriptionDraftMedications(
      input.context,
      draft.items,
      true,
    )
    this.assertMedicationAllergies(
      input.context,
      outpatientCase.patient_id,
      medications.filter(medication => !medication.external).map(medication => medication.catalog),
      'PRESCRIPTION_ALLERGY_CONFLICT',
    )
    const confirmedDiagnosisIds = this.#context.confirmedDiagnosisCatalogItemIds(
      input.context,
      outpatientCase.case_id,
    )
    if (confirmedDiagnosisIds.size === 0) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'A confirmed diagnosis is required to issue a prescription', undefined, 'PRESCRIPTION_DIAGNOSIS_UNCONFIRMED')
    }
    for (const medication of medications) {
      if (medication.external) continue
      const config = prescriptionMedicationCatalogConfigSchema.parse(
        JSON.parse(medication.catalog.config_json ?? '{}') as unknown,
      )
      if (!config.allowedDiagnosisCatalogItemIds.some(id => confirmedDiagnosisIds.has(id))) {
        throw new WorkflowError(
          'CATALOG_CONFLICT',
          `The confirmed diagnosis does not allow ${medication.catalogItemId}`,
          undefined,
          'PRESCRIPTION_DIAGNOSIS_NOT_ALLOWED',
        )
      }
    }
    const prescriptionId = uuidv7()
    const authoredAt = this.#context.virtualTime(input.context)
    const prescriptionCount = countRowSchema.parse(this.#context.database.driver.prepare(`
      SELECT COUNT(*) AS count FROM prescription WHERE workspace_id = ? AND epoch = ?
    `).get(input.context.workspaceId, input.context.epoch)).count + 1
    const prescriptionNumber
      = `CM-RX-${authoredAt.slice(0, 10).replaceAll('-', '')}-${String(prescriptionCount).padStart(4, '0')}`
    this.#context.database.driver.prepare(`
      INSERT INTO prescription (
        workspace_id, epoch, prescription_id, case_id, prescription_number,
        status, version, authored_by, authored_at, signed_at
      ) VALUES (?, ?, ?, ?, ?, 'signed', 1, ?, ?, ?)
    `).run(
      input.context.workspaceId,
      input.context.epoch,
      prescriptionId,
      outpatientCase.case_id,
      prescriptionNumber,
      input.context.actorId,
      authoredAt,
      authoredAt,
    )
    this.#context.database.driver.prepare(`
      INSERT INTO prescription_authorship (
        workspace_id, epoch, prescription_id,
        authored_by_actor_id, authored_by_practitioner_role_id
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      input.context.workspaceId,
      input.context.epoch,
      prescriptionId,
      input.context.actorId,
      input.context.practitionerRoleId,
    )
    const insertItem = this.#context.database.driver.prepare(`
      INSERT INTO prescription_item (
        workspace_id, epoch, prescription_id, medication_request_id,
        medication_id, medication_snapshot_json, quantity, dose_text,
        frequency_code, course_days
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const issuedItems = medications.map((medication) => {
      const medicationResourceId = medication.external ? uuidv7() : medication.catalogItemId
      if (medication.external) {
        transaction.fhir.create(input.context, {
          resourceType: 'Medication',
          id: medicationResourceId,
          status: 'active',
          code: {
            coding: [{
              code: medication.catalog.code,
              display: medication.catalog.name_zh,
              system: medication.referenceProduct?.system,
              version: medication.referenceProduct?.version,
            }],
            text: medication.catalog.name_zh,
          },
          doseForm: { text: medication.referenceProduct?.dosageForm },
          marketingAuthorizationHolder: {
            display: medication.referenceProduct?.manufacturer,
          },
        })
      }
      const medicationRequest = transaction.fhir.create(input.context, {
        resourceType: 'MedicationRequest',
        id: uuidv7(),
        status: 'active',
        intent: 'order',
        medication: {
          reference: {
            display: medication.catalog.name_zh,
            reference: `Medication/${medicationResourceId}`,
          },
        },
        subject: { reference: `Patient/${outpatientCase.patient_id}` },
        encounter: { reference: `Encounter/${input.encounterId}` },
        authoredOn: authoredAt,
        requester: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
        dosageInstruction: [{
          text: `${medication.doseText} ${medication.frequencyCode} for ${medication.courseDays} days`,
          timing: {
            repeat: {
              boundsDuration: {
                code: 'd',
                system: 'http://unitsofmeasure.org',
                unit: 'days',
                value: medication.courseDays,
              },
            },
          },
        }],
        dispenseRequest: { quantity: { value: medication.quantity } },
        groupIdentifier: {
          system: 'https://caizongyuan.github.io/clinmesh/fhir/prescription-number',
          value: prescriptionNumber,
        },
      })
      insertItem.run(
        input.context.workspaceId,
        input.context.epoch,
        prescriptionId,
        medicationRequest.id,
        medication.catalogItemId,
        JSON.stringify(medication.referenceProduct ?? {
          code: medication.catalog.code,
          display: medication.catalog.name_zh,
          id: medication.catalogItemId,
          sourceLocator: 'operational:outpatient_catalog',
          system: 'urn:clinmesh:operational:medication',
          version: String(medication.catalog.version),
        }),
        medication.quantity,
        medication.doseText,
        medication.frequencyCode,
        medication.courseDays,
      )
      return {
        catalogItemId: medication.catalogItemId,
        courseDays: medication.courseDays,
        display: medication.catalog.name_zh,
        doseText: medication.doseText,
        frequencyCode: medication.frequencyCode,
        medicationRequestId: medicationRequest.id,
        medicationRequestVersion: medicationRequest.meta?.versionId ?? '1',
        quantity: medication.quantity,
        ...(medication.referenceProduct === undefined
          ? {}
          : { referenceProduct: medication.referenceProduct }),
      }
    })
    const isExternalPrescription = medications.every(medication => medication.external)
    let chargeEffect: { kind: 'created'; reference: string; versionId: string } | undefined
    if (!isExternalPrescription) {
      const medicationTotalFen = medications.reduce(
        (total, medication) => total + medication.catalog.price_fen * medication.quantity,
        0,
      )
      const chargeItemId = uuidv7()
      const chargeId = uuidv7()
      const chargeItem = transaction.fhir.create(input.context, {
        resourceType: 'ChargeItem',
        id: chargeItemId,
        status: 'billable',
        code: { text: `Prescription ${prescriptionNumber}` },
        subject: { reference: `Patient/${outpatientCase.patient_id}` },
        encounter: { reference: `Encounter/${input.encounterId}` },
        account: [{ reference: `Account/${outpatientCase.account_id}` }],
        occurrenceDateTime: authoredAt,
        quantity: { value: medications.reduce((total, medication) => total + medication.quantity, 0) },
        ...(new Set(medications.map(medication => medication.catalog.price_fen)).size === 1
          ? {
              unitPriceComponent: {
                amount: { currency: 'CNY', value: (medications[0]?.catalog.price_fen ?? 0) / 100 },
              },
            }
          : {}),
        totalPriceComponent: { amount: { currency: 'CNY', value: medicationTotalFen / 100 } },
      })
      this.#context.database.driver.prepare(`
        INSERT INTO charge_record (
          workspace_id, epoch, charge_id, case_id, account_id, charge_item_id,
          category, source_reference, description_zh, description_en,
          quantity, unit_price_fen, total_fen, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'medication', ?, '门诊药品', 'Outpatient medication',
          ?, ?, ?, 'billable', ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        chargeId,
        outpatientCase.case_id,
        outpatientCase.account_id,
        chargeItemId,
        `Prescription/${prescriptionId}`,
        medications.reduce((total, medication) => total + medication.quantity, 0),
        medications.length === 1 ? medications[0]?.catalog.price_fen ?? 0 : medicationTotalFen,
        medicationTotalFen,
        authoredAt,
      )
      chargeEffect = {
        kind: 'created' as const,
        reference: `ChargeItem/${chargeItem.id}`,
        versionId: chargeItem.meta?.versionId ?? '1',
      }
    }
    const updateCase = this.#context.database.driver.prepare(`
      UPDATE outpatient_case
      SET prescription_id = ?, version = version + 1, updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND prescription_id IS NULL
    `).run(
      prescriptionId,
      authoredAt,
      input.context.workspaceId,
      input.context.epoch,
      outpatientCase.case_id,
    )
    if (updateCase.changes !== 1) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter already has a prescription', undefined, 'PRESCRIPTION_ALREADY_ISSUED')
    }
    const draftVersion = state.version + 1
    const updateDraft = this.#context.database.driver.prepare(`
      UPDATE prescription_draft_state
      SET version = ?, draft_json = NULL, updated_by = ?, updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        AND version = ? AND draft_json IS NOT NULL
    `).run(
      draftVersion,
      input.context.actorId,
      authoredAt,
      input.context.workspaceId,
      input.context.epoch,
      outpatientCase.case_id,
      state.version,
    )
    if (updateDraft.changes !== 1) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription draft version has changed', undefined, 'PRESCRIPTION_DRAFT_STALE')
    }
    const prescription = issuedPrescriptionSchema.parse({
      authoredAt,
      authoredByPractitionerRoleId: input.context.practitionerRoleId,
      id: prescriptionId,
      items: issuedItems,
      number: prescriptionNumber,
      status: 'signed',
      version: 1,
    })
    return {
      data: { draftVersion, prescription },
      effects: [
        {
          kind: 'created' as const,
          reference: `Prescription/${prescriptionId}`,
          versionId: '1',
        },
        ...issuedItems.map(item => ({
          kind: 'created' as const,
          reference: `MedicationRequest/${item.medicationRequestId}`,
          versionId: item.medicationRequestVersion,
        })),
        ...(chargeEffect === undefined ? [] : [chargeEffect]),
        {
          kind: 'updated' as const,
          reference: `PrescriptionDraft/${outpatientCase.case_id}`,
          versionId: String(draftVersion),
        },
      ],
    }
  }

  confirmNoMedication(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<z.infer<typeof confirmNoMedicationResponseSchema.shape.data>> {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: confirmNoMedicationResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
      },
      operation: 'encounter.confirm-no-medication',
    }, () => {
      this.#context.assertRole(input.context, ['outpatient-doctor'])
      this.assertPrescriptionConclusionSupported(input.context)
      if (input.context.practitionerRoleId === undefined) {
        throw new WorkflowError(
          'ROLE_NOT_ALLOWED',
          'A Practitioner Role is required to confirm no medication',
        )
      }
      const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
      const encounter = this.#context.fhir.read(input.context, 'Encounter', input.encounterId)
      if (encounter.status !== 'in-progress' || outpatientCase.status === 'completed') {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The Encounter is not available for a medication conclusion',
        )
      }
      this.#context.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      this.#context.assertNoLegacyPrescriptionOwner(input.context, outpatientCase.case_id)
      const prescription = activePrescriptionRowSchema.optional().parse(
        this.#context.database.driver.prepare(`
          SELECT withdrawal.withdrawal_id
          FROM prescription
          LEFT JOIN prescription_withdrawal AS withdrawal
            ON withdrawal.workspace_id = prescription.workspace_id
           AND withdrawal.epoch = prescription.epoch
           AND withdrawal.prescription_id = prescription.prescription_id
          WHERE prescription.workspace_id = ? AND prescription.epoch = ?
            AND prescription.case_id = ?
        `).get(
          input.context.workspaceId,
          input.context.epoch,
          outpatientCase.case_id,
        ),
      )
      if (prescription !== undefined && prescription.withdrawal_id === null) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The Encounter already has an active prescription',
        )
      }
      const existingConclusion = this.#context.database.driver.prepare(`
        SELECT 1 AS present FROM no_medication_conclusion
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id)
      if (existingConclusion !== undefined) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The Encounter already has a no-medication conclusion',
        )
      }
      const draftState = prescriptionDraftStateRowSchema.optional().parse(
        this.#context.database.driver.prepare(`
          SELECT version, draft_json FROM prescription_draft_state
          WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id),
      )
      if ((draftState?.version ?? 0) !== input.expectedDraftVersion) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription draft version has changed')
      }
      const authoredAt = this.#context.virtualTime(input.context)
      const conclusionId = uuidv7()
      this.#context.database.driver.prepare(`
        INSERT INTO no_medication_conclusion (
          workspace_id, epoch, conclusion_id, case_id, version,
          authored_by_actor_id, authored_by_practitioner_role_id, authored_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        conclusionId,
        outpatientCase.case_id,
        input.context.actorId,
        input.context.practitionerRoleId,
        authoredAt,
      )
      const draftVersion = input.expectedDraftVersion + 1
      if (draftState === undefined) {
        this.#context.database.driver.prepare(`
          INSERT INTO prescription_draft_state (
            workspace_id, epoch, case_id, version, draft_json, updated_by, updated_at
          ) VALUES (?, ?, ?, ?, NULL, ?, ?)
        `).run(
          input.context.workspaceId,
          input.context.epoch,
          outpatientCase.case_id,
          draftVersion,
          input.context.actorId,
          authoredAt,
        )
      } else {
        const update = this.#context.database.driver.prepare(`
          UPDATE prescription_draft_state
          SET version = ?, draft_json = NULL, updated_by = ?, updated_at = ?
          WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND version = ?
        `).run(
          draftVersion,
          input.context.actorId,
          authoredAt,
          input.context.workspaceId,
          input.context.epoch,
          outpatientCase.case_id,
          input.expectedDraftVersion,
        )
        if (update.changes !== 1) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription draft version has changed')
        }
      }
      const noMedication = noMedicationConclusionSchema.parse({
        authoredAt,
        authoredByActorId: input.context.actorId,
        authoredByPractitionerRoleId: input.context.practitionerRoleId,
        id: conclusionId,
        version: 1,
      })
      return {
        data: { draftVersion, noMedication },
        effects: [
          {
            kind: 'created' as const,
            reference: `NoMedicationConclusion/${conclusionId}`,
            versionId: '1',
          },
          {
            kind: draftState === undefined ? 'created' as const : 'updated' as const,
            reference: `PrescriptionDraft/${outpatientCase.case_id}`,
            versionId: String(draftVersion),
          },
        ],
      }
    })
  }

  withdrawPrescription(input: {
    context: ActorContext
    expectedPrescriptionVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    prescriptionId: string
  }): CommandResponse<z.infer<typeof withdrawPrescriptionResponseSchema.shape.data>> {
    return this.#context.commands.execute({
      authorize: () => {
        this.#context.assertRole(input.context, ['outpatient-doctor'])
        this.assertPrescriptionConclusionSupported(input.context)
        if (input.context.practitionerRoleId === undefined) {
          throw new WorkflowError(
            'ROLE_NOT_ALLOWED',
            'A Practitioner Role is required to withdraw a prescription',
          )
        }
        const prescription = z.object({ case_id: z.string().min(1) }).optional().parse(
          this.#context.database.driver.prepare(`
            SELECT case_id FROM prescription
            WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
          `).get(input.context.workspaceId, input.context.epoch, input.prescriptionId),
        )
        if (prescription === undefined) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription was not found')
        }
        this.#context.assertCaseResponsibility(input.context, prescription.case_id)
      },
      context: input.context,
      dataSchema: withdrawPrescriptionResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        expectedPrescriptionVersion: input.expectedPrescriptionVersion,
        prescriptionId: input.prescriptionId,
      },
      mapExpectedVersionConflict: error => this.#context.expectedVersionWorkflowError(error, {
        code: 'WORKFLOW_CONFLICT',
        currentStatus: this.prescriptionWithdrawalConflictStatus(
          input.context,
          input.prescriptionId,
        ),
        message: 'A prescription resource version has changed',
        owner: 'prescription',
        resource: `Prescription/${input.prescriptionId}`,
      }),
      operation: 'prescription.withdraw',
    }, transaction => {
      const prescription = prescriptionWithdrawalLookupRowSchema.optional().parse(
        this.#context.database.driver.prepare(`
          SELECT prescription.case_id, prescription.version, prescription.status,
            withdrawal.withdrawal_id
          FROM prescription
          LEFT JOIN prescription_withdrawal AS withdrawal
            ON withdrawal.workspace_id = prescription.workspace_id
           AND withdrawal.epoch = prescription.epoch
           AND withdrawal.prescription_id = prescription.prescription_id
          WHERE prescription.workspace_id = ? AND prescription.epoch = ?
            AND prescription.prescription_id = ?
        `).get(
          input.context.workspaceId,
          input.context.epoch,
          input.prescriptionId,
        ),
      )
      if (prescription === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription was not found')
      }
      if (prescription.version !== input.expectedPrescriptionVersion) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          `The prescription is at version ${prescription.version}; expected version ${input.expectedPrescriptionVersion}`,
          {
            currentStatus: prescription.withdrawal_id === null
              ? prescription.status
              : 'withdrawn',
            currentVersion: String(prescription.version),
            expectedVersion: String(input.expectedPrescriptionVersion),
            owner: 'prescription',
            resource: `Prescription/${input.prescriptionId}`,
          },
        )
      }
      if (prescription.withdrawal_id !== null) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          `The prescription is already withdrawn at version ${prescription.version}`,
          {
            currentStatus: 'withdrawn',
            currentVersion: String(prescription.version),
            owner: 'prescription',
            resource: `Prescription/${input.prescriptionId}`,
          },
        )
      }
      if (!['signed', 'paid'].includes(prescription.status)) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          `The prescription cannot be withdrawn from status "${prescription.status}"`,
          {
            currentStatus: prescription.status,
            currentVersion: String(prescription.version),
            owner: 'prescription',
            resource: `Prescription/${input.prescriptionId}`,
          },
        )
      }
      if (this.#prescriptionHasUnsettledFunds(input.context, input.prescriptionId)) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The prescription cannot be withdrawn with active insurance allocations or unresolved or partially collected payments; cancel its insurance settlement first',
        )
      }
      const items = z.array(prescriptionDispensingRowSchema).parse(
        this.#context.database.driver.prepare(`
          SELECT medication_request_id, dispensed_quantity
          FROM prescription_item
          WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
          ORDER BY medication_request_id
        `).all(
          input.context.workspaceId,
          input.context.epoch,
          input.prescriptionId,
        ),
      )
      if (items.length === 0 || items.some(item => item.dispensed_quantity > 0)) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The prescription cannot be withdrawn because its current state is "dispensing-started"',
          {
            currentStatus: 'dispensing-started',
            currentVersion: String(prescription.version),
            owner: 'prescription',
            resource: `Prescription/${input.prescriptionId}`,
          },
        )
      }
      const medicationReferences = items.map(
        item => `MedicationRequest/${item.medication_request_id}`,
      )
      this.#context.assertExpectedVersions(input.expectedVersions, medicationReferences)
      const withdrawalId = uuidv7()
      const withdrawnAt = this.#context.virtualTime(input.context)
      this.#context.database.driver.prepare(`
        INSERT INTO prescription_withdrawal (
          workspace_id, epoch, withdrawal_id, prescription_id, version,
          withdrawn_by_actor_id, withdrawn_by_practitioner_role_id, withdrawn_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        withdrawalId,
        input.prescriptionId,
        input.context.actorId,
        input.context.practitionerRoleId,
        withdrawnAt,
      )
      const medicationRequests = items.map((item) => {
        const reference = `MedicationRequest/${item.medication_request_id}`
        const request = transaction.fhir.read(
          input.context,
          'MedicationRequest',
          item.medication_request_id,
        )
        if (request.status !== 'active') {
          throw new WorkflowError(
            'WORKFLOW_CONFLICT',
            'The prescription has a medication request that cannot be cancelled',
          )
        }
        const updated = transaction.fhir.update(input.context, {
          ...request,
          status: 'cancelled',
        }, z.string().parse(input.expectedVersions[reference]))
        return {
          id: updated.id,
          version: updated.meta?.versionId ?? '2',
        }
      })
      const update = this.#context.database.driver.prepare(`
        UPDATE prescription SET version = version + 1
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
          AND status IN ('signed', 'paid') AND version = ?
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        input.prescriptionId,
        input.expectedPrescriptionVersion,
      )
      if (update.changes !== 1) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription changed concurrently')
      }
      const withdrawal = prescriptionWithdrawalSchema.parse({
        id: withdrawalId,
        prescriptionId: input.prescriptionId,
        version: 1,
        withdrawnAt,
        withdrawnByActorId: input.context.actorId,
        withdrawnByPractitionerRoleId: input.context.practitionerRoleId,
      })
      return {
        data: {
          medicationRequests,
          prescriptionId: input.prescriptionId,
          prescriptionVersion: input.expectedPrescriptionVersion + 1,
          status: 'withdrawn' as const,
          withdrawal,
        },
        effects: [
          {
            kind: 'created' as const,
            reference: `PrescriptionWithdrawal/${withdrawalId}`,
            versionId: '1',
          },
          ...medicationRequests.map(request => ({
            kind: 'updated' as const,
            reference: `MedicationRequest/${request.id}`,
            versionId: request.version,
          })),
          {
            kind: 'updated' as const,
            reference: `Prescription/${input.prescriptionId}`,
            versionId: String(input.expectedPrescriptionVersion + 1),
          },
        ],
      }
    })
  }

  pharmacyQueue(input: {
    context: ActorContext
    page: number
    pageSize: number
    status: 'completed' | 'exception' | 'pending'
  }) {
    this.#context.assertRole(input.context, ['pharmacist'])
    if (input.status === 'exception') {
      return { items: [], page: input.page, pageSize: input.pageSize, total: 0 }
    }
    const caseStatus = input.status === 'pending' ? 'awaiting-dispense' : 'completed'
    const total = this.#context.database.driver.prepare(`
      SELECT COUNT(*) AS count
      FROM outpatient_case AS outpatient_case
      JOIN prescription
        ON prescription.workspace_id = outpatient_case.workspace_id
       AND prescription.epoch = outpatient_case.epoch
       AND prescription.prescription_id = outpatient_case.prescription_id
      WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
        AND outpatient_case.status = ?
        AND prescription.status = ?
        AND NOT EXISTS (
          SELECT 1 FROM prescription_withdrawal AS withdrawal
          WHERE withdrawal.workspace_id = prescription.workspace_id
            AND withdrawal.epoch = prescription.epoch
            AND withdrawal.prescription_id = prescription.prescription_id
        )
    `).get(
      input.context.workspaceId,
      input.context.epoch,
      caseStatus,
      input.status === 'pending' ? 'paid' : 'dispensed',
    ) as { count: number }
    const rows = this.#context.database.driver.prepare(`
      SELECT outpatient_case.case_id, outpatient_case.encounter_id,
        outpatient_case.patient_id, outpatient_case.status AS case_status,
        prescription.prescription_id, prescription.prescription_number,
        prescription.status AS prescription_status, prescription.version AS prescription_version,
        prescription.authored_by, patient.content_json AS patient_json,
        review.review_id, review.note AS review_note,
        review.reviewed_at, review.reviewed_by,
        encounter.content_json AS encounter_json, encounter.version_id AS encounter_version
      FROM outpatient_case
      JOIN prescription
        ON prescription.workspace_id = outpatient_case.workspace_id
       AND prescription.epoch = outpatient_case.epoch
       AND prescription.prescription_id = outpatient_case.prescription_id
      JOIN fhir_resource AS patient
        ON patient.workspace_id = outpatient_case.workspace_id
       AND patient.epoch = outpatient_case.epoch
       AND patient.resource_type = 'Patient'
       AND patient.resource_id = outpatient_case.patient_id
      JOIN fhir_resource AS encounter
        ON encounter.workspace_id = outpatient_case.workspace_id
       AND encounter.epoch = outpatient_case.epoch
       AND encounter.resource_type = 'Encounter'
       AND encounter.resource_id = outpatient_case.encounter_id
      LEFT JOIN prescription_review AS review
        ON review.workspace_id = prescription.workspace_id
       AND review.epoch = prescription.epoch
       AND review.prescription_id = prescription.prescription_id
      WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
        AND outpatient_case.status = ?
        AND prescription.status = ?
        AND NOT EXISTS (
          SELECT 1 FROM prescription_withdrawal AS withdrawal
          WHERE withdrawal.workspace_id = prescription.workspace_id
            AND withdrawal.epoch = prescription.epoch
            AND withdrawal.prescription_id = prescription.prescription_id
        )
      ORDER BY outpatient_case.updated_at, outpatient_case.case_id
      LIMIT ? OFFSET ?
    `).all(
      input.context.workspaceId,
      input.context.epoch,
      caseStatus,
      input.status === 'pending' ? 'paid' : 'dispensed',
      input.pageSize,
      (input.page - 1) * input.pageSize,
    ) as Array<{
      authored_by: string
      case_id: string
      case_status: string
      encounter_id: string
      encounter_json: string
      encounter_version: number
      patient_id: string
      patient_json: string
      prescription_id: string
      prescription_number: string
      prescription_status: string
      prescription_version: number
      review_id: string | null
      review_note: string | null
      reviewed_at: string | null
      reviewed_by: string | null
    }>
    const selectItems = this.#context.database.driver.prepare(`
      SELECT item.medication_request_id, item.medication_id, item.quantity,
        item.dispensed_quantity,
        item.dose_text, item.frequency_code, catalog.name_zh, catalog.name_en,
        catalog.price_fen, medication_request.version_id AS medication_request_version
      FROM prescription_item AS item
      JOIN outpatient_catalog AS catalog
        ON catalog.workspace_id = item.workspace_id
       AND catalog.epoch = item.epoch
       AND catalog.item_id = item.medication_id
      JOIN fhir_resource AS medication_request
        ON medication_request.workspace_id = item.workspace_id
       AND medication_request.epoch = item.epoch
       AND medication_request.resource_type = 'MedicationRequest'
       AND medication_request.resource_id = item.medication_request_id
      WHERE item.workspace_id = ? AND item.epoch = ? AND item.prescription_id = ?
      ORDER BY item.medication_request_id
    `)
    const selectLots = this.#context.database.driver.prepare(`
      SELECT lot_id, location_id, lot_number, expires_on, quantity_on_hand, version
      FROM inventory_lot
      WHERE workspace_id = ? AND epoch = ? AND medication_id = ?
        AND location_id = ? AND expires_on >= ? AND quantity_on_hand > 0
      ORDER BY expires_on, lot_id
    `)
    return {
      items: rows.map(row => {
        const medications = (selectItems.all(
          input.context.workspaceId,
          input.context.epoch,
          row.prescription_id,
        ) as Array<{
          dose_text: string
          dispensed_quantity: number
          frequency_code: string
          medication_id: string
          medication_request_id: string
          medication_request_version: number
          name_en: string
          name_zh: string
          price_fen: number
          quantity: number
        }>).map(medication => ({
          doseText: medication.dose_text,
          frequencyCode: medication.frequency_code,
          medicationId: medication.medication_id,
          medicationRequestId: medication.medication_request_id,
          medicationRequestVersion: String(medication.medication_request_version),
          nameEn: medication.name_en,
          nameZh: medication.name_zh,
          dispensedQuantity: medication.dispensed_quantity,
          quantity: medication.quantity,
          remainingQuantity: medication.quantity - medication.dispensed_quantity,
          unitPriceFen: medication.price_fen,
          lots: (selectLots.all(
            input.context.workspaceId,
            input.context.epoch,
            medication.medication_id,
            input.context.locationId,
            this.#context.virtualTime(input.context).slice(0, 10),
          ) as Array<{
            expires_on: string
            location_id: string
            lot_id: string
            lot_number: string
            quantity_on_hand: number
            version: number
          }>).map(lot => ({
            expiresOn: lot.expires_on,
            id: lot.lot_id,
            locationId: lot.location_id,
            lotNumber: lot.lot_number,
            quantityOnHand: lot.quantity_on_hand,
            version: lot.version,
          })),
        }))
        const encounter = parseStoredFhirResource(row.encounter_json)
        return {
          allergyWarnings: this.#context.patientAllergyWarnings(input.context, row.patient_id),
          authoredBy: row.authored_by,
          caseId: row.case_id,
          encounterId: row.encounter_id,
          encounterStatus: encounter.status,
          encounterVersion: String(row.encounter_version),
          medications,
          patient: patientSummary(parseStoredFhirResource(row.patient_json)),
          prescriptionId: row.prescription_id,
          prescriptionNumber: row.prescription_number,
          prescriptionStatus: row.prescription_status,
          prescriptionVersion: row.prescription_version,
          ...(row.review_id === null
            ? {}
            : {
                review: {
                  note: row.review_note ?? '',
                  reviewId: row.review_id,
                  reviewedAt: row.reviewed_at ?? '',
                  reviewedBy: row.reviewed_by ?? '',
                },
              }),
          status: row.case_status === 'completed'
            ? 'completed'
            : medications.some(medication => medication.dispensedQuantity > 0)
              ? 'partially-dispensed'
              : row.review_id === null
                ? 'awaiting-review'
                : 'awaiting-dispense',
        }
      }),
      page: input.page,
      pageSize: input.pageSize,
      total: total.count,
    }
  }

  reviewPrescription(input: {
    context: ActorContext
    expectedPrescriptionVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    note: string
    prescriptionId: string
  }): CommandResponse<{
    prescriptionId: string
    prescriptionVersion: number
    reviewId: string
    status: 'awaiting-dispense'
  }> {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: prescriptionReviewResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        expectedPrescriptionVersion: input.expectedPrescriptionVersion,
        note: input.note,
        prescriptionId: input.prescriptionId,
      },
      operation: 'prescription.review',
    }, () => {
      this.#context.assertRole(input.context, ['pharmacist'])
      if (input.context.locationId === undefined) {
        throw new WorkflowError('ROLE_NOT_ALLOWED', 'The pharmacist has no active pharmacy location')
      }
      const prescription = prescriptionWorkflowRowSchema.optional().parse(
        this.#context.database.driver.prepare(`
          SELECT prescription.version, prescription.status,
            outpatient_case.encounter_id, outpatient_case.status AS case_status,
            withdrawal.withdrawal_id
          FROM prescription
          JOIN outpatient_case
            ON outpatient_case.workspace_id = prescription.workspace_id
           AND outpatient_case.epoch = prescription.epoch
           AND outpatient_case.case_id = prescription.case_id
          LEFT JOIN prescription_withdrawal AS withdrawal
            ON withdrawal.workspace_id = prescription.workspace_id
           AND withdrawal.epoch = prescription.epoch
           AND withdrawal.prescription_id = prescription.prescription_id
          WHERE prescription.workspace_id = ? AND prescription.epoch = ?
            AND prescription.prescription_id = ?
        `).get(input.context.workspaceId, input.context.epoch, input.prescriptionId),
      )
      if (
        prescription === undefined
        || prescription.status !== 'paid'
        || prescription.case_status !== 'awaiting-dispense'
        || prescription.version !== input.expectedPrescriptionVersion
        || prescription.withdrawal_id !== null
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription is not ready for review')
      }
      const medicationRequestIds = (this.#context.database.driver.prepare(`
        SELECT medication_request_id FROM prescription_item
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
        ORDER BY medication_request_id
      `).all(input.context.workspaceId, input.context.epoch, input.prescriptionId) as Array<{
        medication_request_id: string
      }>).map(row => row.medication_request_id)
      if (medicationRequestIds.length === 0) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription has no medication requests to review')
      }
      this.#context.assertExpectedVersions(input.expectedVersions, [
        `Encounter/${prescription.encounter_id}`,
        ...medicationRequestIds.map(id => `MedicationRequest/${id}`),
      ])
      const reviewId = uuidv7()
      const reviewedAt = this.#context.virtualTime(input.context)
      this.#context.database.driver.prepare(`
        INSERT INTO prescription_review (
          workspace_id, epoch, review_id, prescription_id, status,
          note, reviewed_by, reviewed_at
        ) VALUES (?, ?, ?, ?, 'approved', ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        reviewId,
        input.prescriptionId,
        input.note,
        input.context.actorId,
        reviewedAt,
      )
      const update = this.#context.database.driver.prepare(`
        UPDATE prescription SET version = version + 1
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
          AND status = 'paid' AND version = ?
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        input.prescriptionId,
        input.expectedPrescriptionVersion,
      )
      if (update.changes !== 1) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription changed during review')
      }
      return {
        data: {
          prescriptionId: input.prescriptionId,
          prescriptionVersion: input.expectedPrescriptionVersion + 1,
          reviewId,
          status: 'awaiting-dispense' as const,
        },
        effects: [{
          kind: 'created',
          reference: `PrescriptionReview/${reviewId}`,
          versionId: '1',
        }],
      }
    })
  }

  dispensePrescription(input: {
    context: ActorContext
    expectedPrescriptionVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    lotSelections: Array<{
      expectedVersion: number
      lotId: string
      quantity: number
    }>
    prescriptionId: string
  }): CommandResponse<{
    medicationDispenseIds: string[]
    prescriptionId: string
    prescriptionVersion: number
    scenarioStatus: 'completed' | 'active'
    status: 'completed' | 'partial'
  }> {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: dispenseResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        expectedPrescriptionVersion: input.expectedPrescriptionVersion,
        lotSelections: input.lotSelections,
        prescriptionId: input.prescriptionId,
      },
      operation: 'prescription.dispense',
    }, transaction => {
      this.#context.assertRole(input.context, ['pharmacist'])
      if (input.context.locationId === undefined) {
        throw new WorkflowError('ROLE_NOT_ALLOWED', 'The pharmacist has no active pharmacy location')
      }
      if (new Set(input.lotSelections.map(selection => selection.lotId)).size !== input.lotSelections.length) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'A lot can be selected only once')
      }
      const prescription = prescriptionDispenseWorkflowRowSchema.optional().parse(
        this.#context.database.driver.prepare(`
          SELECT prescription.prescription_id, prescription.prescription_number,
            prescription.version, prescription.status,
            outpatient_case.case_id, outpatient_case.patient_id,
            outpatient_case.encounter_id, outpatient_case.status AS case_status,
            outpatient_case.scenario_run_id,
            review.review_id, withdrawal.withdrawal_id
          FROM prescription
          JOIN outpatient_case
            ON outpatient_case.workspace_id = prescription.workspace_id
           AND outpatient_case.epoch = prescription.epoch
           AND outpatient_case.case_id = prescription.case_id
          LEFT JOIN prescription_review AS review
            ON review.workspace_id = prescription.workspace_id
           AND review.epoch = prescription.epoch
           AND review.prescription_id = prescription.prescription_id
          LEFT JOIN prescription_withdrawal AS withdrawal
            ON withdrawal.workspace_id = prescription.workspace_id
           AND withdrawal.epoch = prescription.epoch
           AND withdrawal.prescription_id = prescription.prescription_id
          WHERE prescription.workspace_id = ? AND prescription.epoch = ?
            AND prescription.prescription_id = ?
        `).get(input.context.workspaceId, input.context.epoch, input.prescriptionId),
      )
      if (
        prescription === undefined
        || prescription.status !== 'paid'
        || prescription.review_id === null
        || prescription.case_status !== 'awaiting-dispense'
        || prescription.version !== input.expectedPrescriptionVersion
        || prescription.withdrawal_id !== null
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription is not ready for dispensing')
      }
      const items = this.#context.database.driver.prepare(`
        SELECT medication_request_id, medication_id, quantity, dispensed_quantity
        FROM prescription_item
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
        ORDER BY medication_request_id
      `).all(input.context.workspaceId, input.context.epoch, input.prescriptionId) as Array<{
        medication_id: string
        medication_request_id: string
        dispensed_quantity: number
        quantity: number
      }>
      if (items.length === 0 || input.lotSelections.length === 0) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription has no dispensable medication')
      }
      this.#context.assertExpectedVersions(input.expectedVersions, [
        `Encounter/${prescription.encounter_id}`,
        ...items.map(item => `MedicationRequest/${item.medication_request_id}`),
      ])
      const selectLot = this.#context.database.driver.prepare(`
        SELECT lot_id, medication_id, location_id, lot_number, expires_on,
          quantity_on_hand, version
        FROM inventory_lot
        WHERE workspace_id = ? AND epoch = ? AND lot_id = ?
      `)
      const selections = input.lotSelections.map(selection => {
        const lot = selectLot.get(
          input.context.workspaceId,
          input.context.epoch,
          selection.lotId,
        ) as {
          expires_on: string
          location_id: string
          lot_id: string
          lot_number: string
          medication_id: string
          quantity_on_hand: number
          version: number
        } | undefined
        if (
          lot === undefined
          || lot.location_id !== input.context.locationId
          || lot.version !== selection.expectedVersion
          || lot.quantity_on_hand < selection.quantity
          || lot.expires_on < this.#context.virtualTime(input.context).slice(0, 10)
        ) {
          throw new WorkflowError('WORKFLOW_CONFLICT', `Inventory lot ${selection.lotId} is unavailable`)
        }
        return { ...selection, lot }
      })
      if (selections.some(selection => !items.some(
        item => item.medication_id === selection.lot.medication_id,
      ))) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'A selected lot is not part of the prescription')
      }
      const selectedItems = items.map(item => ({
        ...item,
        selectedQuantity: selections
          .filter(selection => selection.lot.medication_id === item.medication_id)
          .reduce((total, selection) => total + selection.quantity, 0),
      })).filter(item => item.selectedQuantity > 0)
      for (const item of selectedItems) {
        const selectedQuantity = selections
          .filter(selection => selection.lot.medication_id === item.medication_id)
          .reduce((total, selection) => total + selection.quantity, 0)
        if (selectedQuantity > item.quantity - item.dispensed_quantity) {
          throw new WorkflowError(
            'WORKFLOW_CONFLICT',
            `Selected quantity exceeds the remainder for ${item.medication_request_id}`,
          )
        }
      }

      const now = this.#context.virtualTime(input.context)
      const updateLot = this.#context.database.driver.prepare(`
        UPDATE inventory_lot
        SET quantity_on_hand = quantity_on_hand - ?, version = version + 1
        WHERE workspace_id = ? AND epoch = ? AND lot_id = ?
          AND location_id = ? AND version = ? AND quantity_on_hand >= ?
          AND expires_on >= ?
      `)
      const insertMovement = this.#context.database.driver.prepare(`
        INSERT INTO inventory_movement (
          workspace_id, epoch, movement_id, prescription_id, lot_id,
          quantity, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      const movementIds: string[] = []
      for (const selection of selections) {
        const updated = updateLot.run(
          selection.quantity,
          input.context.workspaceId,
          input.context.epoch,
          selection.lotId,
          input.context.locationId,
          selection.expectedVersion,
          selection.quantity,
          now.slice(0, 10),
        )
        if (updated.changes !== 1) {
          throw new WorkflowError('WORKFLOW_CONFLICT', `Inventory lot ${selection.lotId} changed concurrently`)
        }
        const inventoryItem = transaction.fhir.read(
          input.context,
          'InventoryItem',
          selection.lotId,
        )
        const netContent = typeof inventoryItem.netContent === 'object'
          && inventoryItem.netContent !== null
          ? inventoryItem.netContent as Record<string, unknown>
          : {}
        transaction.fhir.updateProjection(input.context, {
          ...inventoryItem,
          netContent: {
            ...netContent,
            value: selection.lot.quantity_on_hand - selection.quantity,
          },
        }, String(selection.expectedVersion))
        const movementId = uuidv7()
        insertMovement.run(
          input.context.workspaceId,
          input.context.epoch,
          movementId,
          input.prescriptionId,
          selection.lotId,
          selection.quantity,
          now,
        )
        movementIds.push(movementId)
      }

      const updateItem = this.#context.database.driver.prepare(`
        UPDATE prescription_item
        SET dispensed_quantity = dispensed_quantity + ?
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
          AND medication_request_id = ?
          AND dispensed_quantity + ? <= quantity
      `)
      for (const item of selectedItems) {
        const updated = updateItem.run(
          item.selectedQuantity,
          input.context.workspaceId,
          input.context.epoch,
          input.prescriptionId,
          item.medication_request_id,
          item.selectedQuantity,
        )
        if (updated.changes !== 1) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription quantity changed concurrently')
        }
      }
      const incomplete = this.#context.database.driver.prepare(`
        SELECT COUNT(*) AS count
        FROM prescription_item
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
          AND dispensed_quantity < quantity
      `).get(
        input.context.workspaceId,
        input.context.epoch,
        input.prescriptionId,
      ) as { count: number }
      const dispenseStatus = incomplete.count === 0 ? 'completed' as const : 'partial' as const

      const insertDispense = this.#context.database.driver.prepare(`
        INSERT INTO dispense (
          workspace_id, epoch, dispense_id, prescription_id,
          medication_dispense_id, status, dispensed_by, dispensed_at
        ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)
      `)
      const medicationDispenses = selectedItems.map(item => {
        const medicationDispenseId = uuidv7()
        const medicationDispense = transaction.fhir.create(input.context, {
          resourceType: 'MedicationDispense',
          id: medicationDispenseId,
          status: 'completed',
          medication: { reference: { reference: `Medication/${item.medication_id}` } },
          subject: { reference: `Patient/${prescription.patient_id}` },
          encounter: { reference: `Encounter/${prescription.encounter_id}` },
          authorizingPrescription: [{
            reference: `MedicationRequest/${item.medication_request_id}`,
          }],
          performer: [{ actor: { reference: `PractitionerRole/${input.context.practitionerRoleId}` } }],
          location: { reference: `Location/${input.context.locationId}` },
          quantity: { value: item.selectedQuantity },
          whenPrepared: now,
          whenHandedOver: now,
        })
        insertDispense.run(
          input.context.workspaceId,
          input.context.epoch,
          uuidv7(),
          input.prescriptionId,
          medicationDispenseId,
          input.context.actorId,
          now,
        )
        return medicationDispense
      })
      const prescriptionUpdate = this.#context.database.driver.prepare(`
        UPDATE prescription SET status = ?, version = version + 1
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
          AND status = 'paid' AND version = ?
      `).run(
        dispenseStatus === 'completed' ? 'dispensed' : 'paid',
        input.context.workspaceId,
        input.context.epoch,
        input.prescriptionId,
        input.expectedPrescriptionVersion,
      )
      if (prescriptionUpdate.changes !== 1) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription changed concurrently')
      }
      if (dispenseStatus === 'completed') {
        this.#context.database.driver.prepare(`
          UPDATE outpatient_case SET status = 'completed', version = version + 1, updated_at = ?
          WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status = 'awaiting-dispense'
        `).run(now, input.context.workspaceId, input.context.epoch, prescription.case_id)
      }
      const scenario = this.#host.completeScenarioIfReady(input.context, now)
      return {
        data: {
          medicationDispenseIds: medicationDispenses.map(dispense => dispense.id),
          prescriptionId: input.prescriptionId,
          prescriptionVersion: input.expectedPrescriptionVersion + 1,
          scenarioStatus: scenario.status,
          status: dispenseStatus,
        },
        effects: [
          ...medicationDispenses.map(medicationDispense => ({
            kind: 'created' as const,
            reference: `MedicationDispense/${medicationDispense.id}`,
            versionId: medicationDispense.meta?.versionId ?? '1',
          })),
          ...movementIds.map(movementId => ({
            kind: 'created' as const,
            reference: `InventoryMovement/${movementId}`,
            versionId: '1',
          })),
          ...selections.map(selection => ({
            kind: 'updated' as const,
            reference: `InventoryItem/${selection.lotId}`,
            versionId: String(selection.expectedVersion + 1),
          })),
          {
            kind: 'updated' as const,
            reference: `Prescription/${input.prescriptionId}`,
            versionId: String(input.expectedPrescriptionVersion + 1),
          },
          ...scenario.effects,
        ],
      }
    })
  }

  prescriptionDraftConflictStatus(
    context: ActorContext,
    encounterId: string,
  ): NonNullable<ApiConflict['currentStatus']> {
    const outpatientCase = this.#context.caseByEncounter(context, encounterId)
    const state = prescriptionDraftStateRowSchema.optional().parse(
      this.#context.database.driver.prepare(`
        SELECT version, draft_json FROM prescription_draft_state
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, outpatientCase.case_id),
    )
    if (state === undefined) return 'missing'
    return state.draft_json === null ? 'empty' : 'draft'
  }

  noMedicationConclusion(
    context: ActorContext,
    caseId: string,
  ): z.infer<typeof noMedicationConclusionSchema> | undefined {
    const conclusion = noMedicationConclusionRowSchema.optional().parse(
      this.#context.database.driver.prepare(`
        SELECT conclusion_id, version, authored_by_actor_id,
          authored_by_practitioner_role_id, authored_at
        FROM no_medication_conclusion
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, caseId),
    )
    if (conclusion === undefined) return undefined
    return noMedicationConclusionSchema.parse({
      authoredAt: conclusion.authored_at,
      authoredByActorId: conclusion.authored_by_actor_id,
      authoredByPractitionerRoleId: conclusion.authored_by_practitioner_role_id,
      id: conclusion.conclusion_id,
      version: conclusion.version,
    })
  }

  prescriptionWithdrawal(
    context: ActorContext,
    prescriptionId: string,
  ): z.infer<typeof prescriptionWithdrawalSchema> | undefined {
    const withdrawal = prescriptionWithdrawalRowSchema.optional().parse(
      this.#context.database.driver.prepare(`
        SELECT withdrawal_id, version, withdrawn_by_actor_id,
          withdrawn_by_practitioner_role_id, withdrawn_at
        FROM prescription_withdrawal
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
      `).get(context.workspaceId, context.epoch, prescriptionId),
    )
    if (withdrawal === undefined) return undefined
    return prescriptionWithdrawalSchema.parse({
      id: withdrawal.withdrawal_id,
      prescriptionId,
      version: withdrawal.version,
      withdrawnAt: withdrawal.withdrawn_at,
      withdrawnByActorId: withdrawal.withdrawn_by_actor_id,
      withdrawnByPractitionerRoleId: withdrawal.withdrawn_by_practitioner_role_id,
    })
  }

  assertMedicationAllergies(
    context: ActorContext,
    patientId: string,
    medications: Array<{ code: string; name_en?: string; name_zh?: string }>,
    reason?: string,
  ): void {
    const allergyCodes = this.#context.patientAllergyCodes(context, patientId)
    const contraindicated = medications.find(medication => allergyCodes.has(medication.code))
    if (contraindicated !== undefined) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        `Medication ${contraindicated.name_en ?? contraindicated.name_zh ?? contraindicated.code} conflicts with an active allergy`,
        undefined,
        reason,
      )
    }
  }

  assertMedicationCatalogRules(
    medications: MedicationRuleSelection[],
    dosageReason?: PrescriptionConflictReason,
  ): void {
    if (new Set(medications.map(medication => medication.catalogItemId)).size !== medications.length) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'A medication can appear only once in a prescription')
    }
    for (const medication of medications) {
      const config = legacyMedicationCatalogConfigSchema.parse(
        JSON.parse(medication.configJson ?? '{}') as unknown,
      )
      if (
        !medicationDoseAndFrequencyAllowed(config, medication.doseText, medication.frequencyCode)
      ) {
        throw new WorkflowError(
          'CATALOG_CONFLICT',
          `The dose or frequency is not allowed for ${medication.catalogItemId}`,
          undefined,
          dosageReason,
        )
      }
      const otherMedicationIds = medications
        .map(candidate => candidate.catalogItemId)
        .filter(candidateId => candidateId !== medication.catalogItemId)
      if (otherMedicationIds.some(candidateId => !config.allowedCombinationIds.includes(candidateId))) {
        throw new WorkflowError(
          'CATALOG_CONFLICT',
          `The medication combination is not allowed for ${medication.catalogItemId}`,
        )
      }
    }
  }

  #chargeAdjustmentFen(context: ActorContext, chargeItemId: string): number {
    return z.object({ amount: z.number().int() }).parse(
      this.#context.database.driver.prepare(`
        SELECT COALESCE(SUM(amount_fen), 0) AS amount
        FROM financial_charge_adjustment
        WHERE workspace_id = ? AND epoch = ? AND charge_item_id = ?
      `).get(context.workspaceId, context.epoch, chargeItemId),
    ).amount
  }

  #prescriptionHasUnsettledFunds(context: ActorContext, prescriptionId: string): boolean {
    const charges = z.array(z.object({
      case_id: z.string(),
      charge_item_id: z.string(),
      total_fen: z.number().int().nonnegative(),
    })).parse(
      this.#context.database.driver.prepare(`
        SELECT case_id, charge_item_id, total_fen FROM charge_record
        WHERE workspace_id = ? AND epoch = ? AND source_reference = ?
      `).all(context.workspaceId, context.epoch, `Prescription/${prescriptionId}`),
    )
    const firstCharge = charges[0]
    if (firstCharge === undefined) return false
    const allocated = readOutpatientInsuranceAllocations(this.#context.database, context, firstCharge.case_id)
    return charges.some(charge => {
      const balance = this.#context.payments.balance(context, charge.charge_item_id)
      const amountFen = charge.total_fen - this.#chargeAdjustmentFen(context, charge.charge_item_id)
      return balance.unresolved > 0
        || allocated.has(`ChargeItem/${charge.charge_item_id}`)
        || (balance.paidFen > 0 && balance.paidFen < amountFen)
    })
  }

  #validatedPrescriptionDraftMedications(
    context: ActorContext,
    items: PrescriptionDraftItem[],
    trustPersistedSnapshots: boolean,
  ): Array<PrescriptionDraftItem & { catalog: CatalogRow; external: boolean }> {
    const medications: Array<PrescriptionDraftItem & { catalog: CatalogRow; external: boolean }> = items.map((item) => {
      const { referenceProduct: untrustedProduct, ...draftItem } = item
      const referenceProduct: ReferenceMedicationProduct | undefined = trustPersistedSnapshots
        ? untrustedProduct
        : this.#context.referenceData?.medicationById(context, item.catalogItemId)
      if (referenceProduct !== undefined) {
        return {
          ...draftItem,
          catalog: {
            code: referenceProduct.code,
            item_id: referenceProduct.id,
            name_en: referenceProduct.genericName,
            name_zh: referenceProduct.genericName,
            price_fen: 0,
            version: 1,
          },
          external: true as const,
          referenceProduct,
        }
      }
      return {
        ...draftItem,
        catalog: this.#context.catalogItem(context, item.catalogItemId, 'medication'),
        external: false as const,
      }
    })
    if (new Set(medications.map(item => item.catalogItemId)).size !== medications.length) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'A medication can appear only once in a prescription')
    }
    if (medications.some(item => item.external) && medications.some(item => !item.external)) {
      throw new WorkflowError(
        'CATALOG_CONFLICT',
        'Hospital pharmacy and national reference catalog medications cannot be mixed in a single prescription',
        undefined,
        'PRESCRIPTION_MIXED_CATALOG_SOURCES',
      )
    }
    const localMedications = medications.filter(medication => !medication.external)
    this.assertMedicationCatalogRules(
      localMedications.map(medication => ({
        catalogItemId: medication.catalogItemId,
        configJson: medication.catalog.config_json,
        doseText: medication.doseText,
        frequencyCode: medication.frequencyCode,
      })),
      'PRESCRIPTION_DOSAGE_NOT_ALLOWED',
    )
    for (const medication of localMedications) {
      const rawConfig = JSON.parse(medication.catalog.config_json ?? '{}') as unknown
      if (!isOutpatientMedicationConfig(rawConfig)) {
        throw new WorkflowError('CATALOG_CONFLICT', `The medication ${medication.catalogItemId} is unavailable for outpatient care`)
      }
      const config = prescriptionMedicationCatalogConfigSchema.parse(rawConfig)
      if (
        !config.allowedCourseDays.includes(medication.courseDays)
        || !config.allowedQuantities.includes(medication.quantity)
      ) {
        throw new WorkflowError(
          'CATALOG_CONFLICT',
          `The course or quantity is not allowed for ${medication.catalogItemId}`,
          undefined,
          'PRESCRIPTION_DOSAGE_NOT_ALLOWED',
        )
      }
    }
    return medications
  }

  prescriptionHasDispensedQuantity(context: ActorContext, prescriptionId: string): boolean {
    const row = countRowSchema.parse(this.#context.database.driver.prepare(`
      SELECT COUNT(*) AS count
      FROM prescription_item
      WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
        AND dispensed_quantity > 0
    `).get(context.workspaceId, context.epoch, prescriptionId))
    return row.count > 0
  }

  prescriptionWithdrawalConflictStatus(
    context: ActorContext,
    prescriptionId: string,
  ): NonNullable<ApiConflict['currentStatus']> {
    const prescription = prescriptionWithdrawalLookupRowSchema.optional().parse(
      this.#context.database.driver.prepare(`
        SELECT prescription.case_id, prescription.version, prescription.status,
          withdrawal.withdrawal_id
        FROM prescription
        LEFT JOIN prescription_withdrawal AS withdrawal
          ON withdrawal.workspace_id = prescription.workspace_id
         AND withdrawal.epoch = prescription.epoch
         AND withdrawal.prescription_id = prescription.prescription_id
        WHERE prescription.workspace_id = ? AND prescription.epoch = ?
          AND prescription.prescription_id = ?
      `).get(context.workspaceId, context.epoch, prescriptionId),
    )
    if (prescription === undefined) return 'missing'
    if (prescription.withdrawal_id !== null) return 'withdrawn'
    if (this.prescriptionHasDispensedQuantity(context, prescriptionId)) {
      return 'dispensing-started'
    }
    return prescription.status
  }

  issuedPrescription(
    context: ActorContext,
    caseId: string,
  ): z.infer<typeof issuedPrescriptionSchema> | undefined {
    const prescription = issuedPrescriptionRowSchema.optional().parse(
      this.#context.database.driver.prepare(`
        SELECT prescription.prescription_id, prescription.prescription_number,
          prescription.status, prescription.version, prescription.authored_at,
          authorship.authored_by_practitioner_role_id
        FROM prescription
        LEFT JOIN prescription_authorship AS authorship
          ON authorship.workspace_id = prescription.workspace_id
         AND authorship.epoch = prescription.epoch
         AND authorship.prescription_id = prescription.prescription_id
        WHERE prescription.workspace_id = ? AND prescription.epoch = ?
          AND prescription.case_id = ? AND prescription.status != 'draft'
      `).get(context.workspaceId, context.epoch, caseId),
    )
    if (prescription === undefined) return undefined
    const withdrawal = this.prescriptionWithdrawal(
      context,
      prescription.prescription_id,
    )
    let authoredByPractitionerRoleId = prescription.authored_by_practitioner_role_id ?? undefined
    const items = z.array(issuedPrescriptionItemRowSchema).parse(
      this.#context.database.driver.prepare(`
        SELECT medication_request_id, medication_id, medication_snapshot_json, quantity, dose_text,
          frequency_code, course_days
        FROM prescription_item
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
        ORDER BY medication_request_id
      `).all(
        context.workspaceId,
        context.epoch,
        prescription.prescription_id,
      ),
    ).map((item) => {
      const resource = this.#context.fhir.read(context, 'MedicationRequest', item.medication_request_id)
      const request = issuedMedicationRequestSchema.parse(resource)
      if (!request.requester.reference.startsWith('PractitionerRole/')) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription requester is inconsistent')
      }
      const requesterRoleId = request.requester.reference.slice('PractitionerRole/'.length)
      authoredByPractitionerRoleId ??= requesterRoleId
      if (requesterRoleId !== authoredByPractitionerRoleId) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription requester is inconsistent')
      }
      const catalog = z.object({
        name_en: z.string().min(1),
        name_zh: z.string().min(1),
      }).strict().optional().parse(this.#context.database.driver.prepare(`
        SELECT name_zh, name_en FROM outpatient_catalog
        WHERE workspace_id = ? AND epoch = ? AND item_id = ? AND kind = 'medication'
      `).get(context.workspaceId, context.epoch, item.medication_id))
      const referenceProduct = referenceMedicationProductSchema.safeParse(
        JSON.parse(item.medication_snapshot_json) as unknown,
      )
      return {
        catalogItemId: item.medication_id,
        courseDays: item.course_days,
        display: request.medication.reference.display
          ?? catalog?.name_zh
          ?? catalog?.name_en
          ?? item.medication_id,
        doseText: item.dose_text,
        frequencyCode: item.frequency_code,
        medicationRequestId: item.medication_request_id,
        medicationRequestVersion: resource.meta?.versionId ?? '1',
        quantity: item.quantity,
        ...(referenceProduct.success ? { referenceProduct: referenceProduct.data } : {}),
      }
    })
    if (authoredByPractitionerRoleId === undefined) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription requester is incomplete')
    }
    return issuedPrescriptionSchema.parse({
      authoredAt: prescription.authored_at,
      authoredByPractitionerRoleId,
      id: prescription.prescription_id,
      items,
      number: prescription.prescription_number,
      status: withdrawal === undefined ? prescription.status : 'withdrawn',
      version: prescription.version,
      ...(withdrawal === undefined ? {} : { withdrawal }),
    })
  }

  assertPrescriptionConclusionSupported(context: ActorContext): void {
    if (!this.prescriptionConclusionSupportedInContext(context)) {
      throw new WorkflowError(
        'CATALOG_CONFLICT',
        'Independent medication conclusions are not supported by this Scenario',
      )
    }
  }

  prescriptionConclusionSupportedInContext(context: ActorContext): boolean {
    const rows = z.array(medicationCatalogConfigRowSchema).parse(
      this.#context.database.driver.prepare(`
        SELECT config_json FROM outpatient_catalog
        WHERE workspace_id = ? AND epoch = ? AND kind = 'medication' AND active = 1
      `).all(context.workspaceId, context.epoch),
    )
    return this.prescriptionConclusionSupported(
      context,
      rows.flatMap((row) => {
        const rawConfig = JSON.parse(row.config_json) as unknown
        return isOutpatientMedicationConfig(rawConfig) ? [rawConfig] : []
      }),
    )
  }

  prescriptionConclusionSupported(context: ActorContext, configs: unknown[]): boolean {
    if (configs.length > 0) {
      return configs.every(config => prescriptionMedicationCatalogConfigSchema.safeParse(config).success)
    }
    const allRows = z.array(medicationCatalogConfigRowSchema).parse(
      this.#context.database.driver.prepare(`
        SELECT config_json FROM outpatient_catalog
        WHERE workspace_id = ? AND epoch = ? AND kind = 'medication'
      `).all(context.workspaceId, context.epoch),
    )
    const allOutpatientConfigs = allRows.flatMap((row) => {
      const rawConfig = JSON.parse(row.config_json) as unknown
      return isOutpatientMedicationConfig(rawConfig) ? [rawConfig] : []
    })
    if (allOutpatientConfigs.length > 0) {
      return allOutpatientConfigs.every(config => prescriptionMedicationCatalogConfigSchema.safeParse(config).success)
    }
    return this.scenarioSupportsPrescriptionConclusion(context)
  }

  scenarioSupportsPrescriptionConclusion(context: ActorContext): boolean {
    const row = z.object({ schema_version: z.string() }).optional().parse(
      this.#context.database.driver.prepare(`
        SELECT definition.schema_version
        FROM scenario_epoch_state AS state
        JOIN scenario_definition AS definition
          ON definition.scenario_id = state.scenario_id
        WHERE state.workspace_id = ? AND state.epoch = ?
      `).get(context.workspaceId, context.epoch),
    )
    return row !== undefined && Number(row.schema_version) >= 3
  }
}
