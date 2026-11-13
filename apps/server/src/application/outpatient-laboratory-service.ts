import {
  acknowledgeLaboratoryReportResponseSchema,
  caseLaboratoryCatalogSearchSchema,
  correctLaboratoryReportResponseSchema,
  issueLaboratoryRequestResponseSchema,
  laboratoryOrderResponseSchema,
  laboratoryReportSchema,
  laboratoryRequestActionResponseSchema,
  laboratoryRequestDraftResponseSchema,
  laboratoryRequestSchema,
  laboratoryResultMeasurementSchema,
  laboratoryServiceSnapshotSchema,
  outpatientInvestigationPriceSchema,
  type ApiConflict,
  type LaboratoryRequestCatalogItemId,
} from '@clinmesh/contracts/his'
import type { FhirResource } from '@clinmesh/contracts/fhir'
import { referenceConceptSnapshotSchema } from '@clinmesh/contracts/reference-data'
import type { InvestigationResultContent } from '@clinmesh/contracts/scenario'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { assertInpatientRequestScope, inpatientRequestOwner } from './clinical-request-context.ts'
import {
  laboratoryRequestPolicy,
  reportAcknowledgementRowSchema,
} from './clinical-request-kernel.ts'
import {
  ExpectedVersionConflictError,
  provenanceAgents,
  type ActorContext,
  type CommandResponse,
  type CommandTransaction,
} from './command-executor.ts'
import {
  AdultReferenceApplicabilityError,
  assertAdultReferenceServiceApplicable,
} from './laboratory-adult-reference.ts'
import {
  diagnosticReportContentSchema,
  hiddenFactValueRowSchema,
  lisOrderDataSchema,
  observationResultContentSchema,
  respiratoryPathogenFactSchema,
  type CatalogRow,
  type OutpatientLaboratoryTransactionPort,
  type OutpatientWorkflowContext,
} from './outpatient-workflow-context.ts'
import { hasLaboratoryCriticalBounds, isLaboratoryValueCritical } from './laboratory-adult-reference.ts'
import { WorkflowError } from './workflow-error.ts'

const laboratoryServiceConfigSchema = z.object({
  laboratoryService: laboratoryServiceSnapshotSchema,
}).passthrough()

const laboratoryCatalogConfigSchema = z.object({
  allowedIndicationCodes: z.array(z.string().min(1)).min(1),
  contraindicatedAllergyCodes: z.array(z.string().min(1)),
  referenceConcept: referenceConceptSnapshotSchema.optional(),
})

export function laboratoryServiceCodings(
  catalog: { code: string; name_zh: string },
  config: z.infer<typeof laboratoryCatalogConfigSchema>,
) {
  return [{
    code: catalog.code,
    display: catalog.name_zh,
    system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-service',
  }, ...(config.referenceConcept === undefined ? [] : [{
    code: config.referenceConcept.code,
    display: config.referenceConcept.display,
    system: config.referenceConcept.system,
    version: config.referenceConcept.version,
  }])]
}

const laboratoryRequestRowSchema = z.object({
  catalog_item_id: laboratoryRequestSchema.shape.catalogItemId,
  diagnostic_report_id: z.string().min(1).nullable(),
  execution_task_id: z.string().min(1),
  generation_error_code: z.string().min(1).nullable(),
  generation_error_message: z.string().min(1).nullable(),
  indication_code: z.string().min(1),
  reference_json: z.string().min(1),
  service_snapshot_json: z.string().min(1).nullable(),
  result_snapshot_id: z.string().min(1).nullable(),
  request_id: z.string().min(1),
  service_request_id: z.string().min(1),
  status: laboratoryRequestSchema.shape.status,
  version: z.number().int().positive(),
})

const laboratoryRequestCommandRowSchema = laboratoryRequestRowSchema.extend({
  authored_by: z.string().min(1),
  case_id: z.string().min(1),
  encounter_id: z.string().min(1),
  patient_id: z.string().min(1),
})

const laboratoryRequestSystemResponseSchema = z.object({
  requestId: z.string().min(1),
  status: z.enum(['accepted', 'cancelled', 'generation-failed', 'in-progress']),
}).strict()

const laboratoryReportSystemResponseSchema = z.object({
  diagnosticReportId: z.string().min(1),
  requestId: z.string().min(1),
  status: z.literal('reported'),
}).strict()

const laboratoryReportRevisionRowSchema = z.object({
  diagnostic_report_id: z.string().min(1),
  provenance_id: z.string().min(1),
  reason: z.string().min(1),
  request_id: z.string().min(1),
  revision_of_diagnostic_report_id: z.string().min(1),
}).strict()

const laboratoryResultsFactSchema = z.object({
  'lab-cbc': z.object({
    conclusion: z.string().min(1),
    results: z.array(laboratoryResultMeasurementSchema).min(1),
  }).strict(),
  'lab-crp': z.object({
    conclusion: z.string().min(1),
    results: z.array(laboratoryResultMeasurementSchema).min(1),
  }).strict(),
}).strict()

const laboratoryRequestStateRowSchema = z.object({
  draft_catalog_item_id: laboratoryRequestSchema.shape.catalogItemId.nullable(),
  draft_indication_code: z.string().min(1).nullable(),
  draft_reference_json: z.string().min(1).nullable(),
  draft_service_snapshot_json: z.string().min(1).nullable(),
  draft_price_json: z.string().min(1).nullable(),
  version: z.number().int().positive(),
}).strict().refine(
  row => (row.draft_catalog_item_id === null) === (row.draft_indication_code === null)
    && (row.draft_catalog_item_id === null) === (row.draft_reference_json === null),
  { message: 'Laboratory request draft fields must be present together' },
)

const laboratoryDiagnosticReportContentSchema = z.object({
  basedOn: z.array(z.object({ reference: z.string().min(1) }).loose()).min(1),
  conclusion: z.string().min(1),
  issued: z.string().datetime({ offset: true }),
  result: z.array(z.object({ reference: z.string().min(1) }).loose()).min(1),
  specimen: z.array(z.object({ reference: z.string().min(1) }).loose()).min(1),
  status: z.literal('final'),
}).loose()

const laboratoryObservationContentSchema = z.object({
  basedOn: z.array(z.object({ reference: z.string().min(1) }).loose()).min(1),
  code: z.object({
    coding: z.array(z.object({
      code: z.string().min(1),
      display: z.string().min(1).optional(),
    }).loose()).min(1),
  }).loose(),
  interpretation: z.array(z.object({
    coding: z.array(z.object({ code: z.enum(['N', 'A', 'H', 'L']) }).loose()).min(1),
  }).loose()).min(1),
  referenceRange: z.array(z.object({
    high: z.object({ value: z.number().finite() }).loose().optional(),
    low: z.object({ value: z.number().finite() }).loose().optional(),
    text: z.string().min(1),
  }).loose()).min(1),
  specimen: z.object({ reference: z.string().min(1) }).loose(),
  valueBoolean: z.boolean().optional(),
  valueCodeableConcept: z.object({
    coding: z.array(z.object({
      code: z.string().min(1),
      display: z.string().min(1),
      system: z.string().url(),
    }).loose()).min(1),
  }).loose().optional(),
  valueQuantity: z.object({
    code: z.string().min(1),
    system: z.literal('http://unitsofmeasure.org'),
    unit: z.string().min(1),
    value: z.number().finite(),
  }).loose().optional(),
  valueString: z.string().min(1).optional(),
}).loose().refine(value => (
  Number(value.valueBoolean !== undefined)
  + Number(value.valueCodeableConcept !== undefined)
  + Number(value.valueQuantity !== undefined)
  + Number(value.valueString !== undefined)
) === 1, { message: 'Laboratory Observation must contain exactly one supported value' })

const legacyCompletedCaseLaboratoryRowSchema = z.object({
  diagnostic_report_id: z.string().min(1).nullable(),
  laboratory_task_id: z.string().min(1).nullable(),
  service_request_id: z.string().min(1).nullable(),
}).strict()

const completedCaseServiceRequestSchema = z.object({
  authoredOn: z.iso.datetime({ offset: true }),
  code: z.object({
    concept: z.object({ text: z.string().min(1) }).loose(),
  }).loose(),
  meta: z.object({ versionId: z.string().regex(/^\d+$/) }).loose(),
  reason: z.array(z.object({
    concept: z.object({
      coding: z.array(z.object({ code: z.string().min(1) }).loose()).min(1),
    }).loose(),
  }).loose()).min(1),
  resourceType: z.literal('ServiceRequest'),
}).loose()

const completedCaseDiagnosticReportSchema = z.object({
  conclusion: z.string().min(1),
  issued: z.iso.datetime({ offset: true }),
  meta: z.object({ versionId: z.string().regex(/^\d+$/) }).loose(),
  resourceType: z.literal('DiagnosticReport'),
  result: z.array(z.object({ reference: z.string().min(1) }).loose()).min(1),
  specimen: z.array(z.object({ reference: z.string().min(1) }).loose()).min(1),
  status: z.literal('final'),
}).loose()

const completedCaseObservationSchema = z.object({
  code: z.object({
    coding: z.array(z.object({
      code: z.string().min(1),
      display: z.string().min(1).optional(),
    }).loose()).min(1),
  }).loose(),
  interpretation: z.array(z.object({
    coding: z.array(z.object({ code: z.string().min(1) }).loose()).min(1),
  }).loose()).optional(),
  referenceRange: z.array(z.object({
    high: z.object({ value: z.number().finite() }).loose().optional(),
    low: z.object({ value: z.number().finite() }).loose().optional(),
    text: z.string().min(1).optional(),
  }).loose()).optional(),
  resourceType: z.literal('Observation'),
  valueBoolean: z.boolean().optional(),
  valueCodeableConcept: z.object({
    coding: z.array(z.object({
      code: z.string().min(1),
      display: z.string().min(1),
      system: z.string().url(),
    }).loose()).min(1),
  }).loose().optional(),
  valueQuantity: z.object({
    code: z.string().min(1).optional(),
    system: z.string().url().optional(),
    unit: z.string().min(1).optional(),
    value: z.number().finite(),
  }).loose().optional(),
  valueString: z.string().optional(),
}).loose()

const laboratoryCriticalValueExtensionUrl = 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/laboratory-critical-value'

function observationCriticalFlag(resource: FhirResource): boolean | undefined {
  if (!Array.isArray(resource.extension)) return undefined
  const found = resource.extension.find((item): item is { url: string; valueBoolean: boolean } => (
    typeof item === 'object'
    && item !== null
    && (item as { url?: unknown }).url === laboratoryCriticalValueExtensionUrl
    && typeof (item as { valueBoolean?: unknown }).valueBoolean === 'boolean'
  ))
  return found?.valueBoolean
}

export function completedCaseInterpretation(code: string | undefined): string | undefined {
  if (code === undefined) return undefined
  return ({ H: 'high', L: 'low', N: 'normal', NEG: 'negative', POS: 'positive' } as const)[
    code as 'H' | 'L' | 'N' | 'NEG' | 'POS'
  ] ?? code
}

export interface OutpatientLaboratoryHost {
  reportPublished(
    transaction: CommandTransaction,
    context: ActorContext,
    caseId: string,
    reportReference: string,
    reportName: string,
  ): void
}

export class OutpatientLaboratoryService implements OutpatientLaboratoryTransactionPort {
  readonly #context: OutpatientWorkflowContext
  readonly #host: OutpatientLaboratoryHost

  constructor(options: {
    context: OutpatientWorkflowContext
    host: OutpatientLaboratoryHost
  }) {
    this.#context = options.context
    this.#host = options.host
  }

  catalogItems(
    _context: ActorContext,
    rows: Array<CatalogRow & { config_json: string }>,
  ) {
    return rows.map(row => {
      const config = laboratoryCatalogConfigSchema.parse(JSON.parse(row.config_json) as unknown)
      return {
        id: row.item_id,
        nameEn: row.name_en,
        nameZh: row.name_zh,
        priceFen: row.price_fen,
        version: row.version,
        ...config,
        outpatientBilling: this.#context.outpatientBilling.priceForPublishedLaboratory({
          id: row.item_id,
          version: row.version,
          priceFen: row.price_fen,
        }),
      }
    })
  }

  lisOrderSummary(context: ActorContext, diagnosticReportId: string) {
    const diagnosticReport = this.#context.fhir.read(
      context,
      'DiagnosticReport',
      diagnosticReportId,
    )
    const parsedDiagnosticReport = diagnosticReportContentSchema.parse(diagnosticReport)
    const references = parsedDiagnosticReport.result?.map(result => result.reference) ?? []
    return {
      id: diagnosticReport.id,
      results: references.map(reference => {
        const observation = this.#context.fhir.read(
          context,
          'Observation',
          reference.replace(/^Observation\//, ''),
        )
        const parsedObservation = observationResultContentSchema.parse(observation)
        const value = parsedObservation.valueBoolean
          ?? parsedObservation.valueQuantity?.value
          ?? parsedObservation.valueString
          ?? ''
        return {
          code: parsedObservation.code?.coding?.[0]?.code ?? '',
          ...(parsedObservation.interpretation?.[0]?.coding?.[0]?.code === undefined
            ? {}
            : { interpretation: parsedObservation.interpretation[0]?.coding?.[0]?.code }),
          ...(parsedObservation.referenceRange?.[0]?.text === undefined
            ? {}
            : { referenceRange: parsedObservation.referenceRange[0].text }),
          ...(parsedObservation.valueQuantity?.unit === undefined
            ? {}
            : { unit: parsedObservation.valueQuantity.unit }),
          value,
        }
      }),
      status: parsedDiagnosticReport.status,
    }
  }

  hasDraft(context: ActorContext, caseId: string): boolean {
    return typeof this.#laboratoryRequestState(context, caseId)?.draft_catalog_item_id === 'string'
  }

  state(context: ActorContext, caseId: string) {
    const laboratoryRequestState = this.#laboratoryRequestState(context, caseId)
    if (laboratoryRequestState === undefined) return undefined
    const requests = this.laboratoryRequests(context, caseId)
    return {
      ...(laboratoryRequestState.draft_catalog_item_id === null
        || laboratoryRequestState.draft_indication_code === null
        || laboratoryRequestState.draft_reference_json === null
        ? {}
        : {
            draft: {
              catalogItemId: laboratoryRequestState.draft_catalog_item_id,
              indicationCode: laboratoryRequestState.draft_indication_code,
              ...(laboratoryRequestState.draft_service_snapshot_json === null
                ? {}
                : {
                    laboratoryService: laboratoryServiceSnapshotSchema.parse(JSON.parse(
                      laboratoryRequestState.draft_service_snapshot_json,
                    )),
                  }),
              referenceConcept: referenceConceptSnapshotSchema.parse(
                JSON.parse(laboratoryRequestState.draft_reference_json),
              ),
            },
          }),
      draftVersion: laboratoryRequestState.version,
      reportingSupported: this.#supportsLaboratoryReports(context, caseId),
      requests,
    }
  }

  caseLaboratoryCatalog(
    context: ActorContext,
    caseId: string,
    input: { page: number; pageSize: number; query?: string },
  ) {
    this.#context.requireDoctorCase(context, caseId)
    const terms = input.query?.trim().split(/\s+/).filter(Boolean) ?? []
    const bindings = [context.workspaceId, context.epoch, ...terms.flatMap(term => [term, term, term])]
    const searchCondition = terms.map(() => `AND (
      instr(lower(code), lower(?)) > 0
      OR instr(lower(name_zh), lower(?)) > 0
      OR instr(lower(name_en), lower(?)) > 0
    )`).join(' ')
    const total = z.object({ count: z.number().int().nonnegative() }).parse(
      this.#context.database.driver.prepare(`
        SELECT COUNT(*) AS count
        FROM hospital_service_catalog
        WHERE workspace_id = ? AND epoch = ? AND active = 1
          AND json_extract(config_json, '$.laboratoryService.doctorOrderable') = 1
          ${searchCondition}
      `).get(...bindings),
    ).count
    const rows = z.array(z.object({ config_json: z.string() }).strict()).parse(
      this.#context.database.driver.prepare(`
        SELECT config_json
        FROM hospital_service_catalog
        WHERE workspace_id = ? AND epoch = ? AND active = 1
          AND json_extract(config_json, '$.laboratoryService.doctorOrderable') = 1
          ${searchCondition}
        ORDER BY name_zh, code, service_id
        LIMIT ? OFFSET ?
      `).all(...bindings, input.pageSize, (input.page - 1) * input.pageSize),
    )
    return caseLaboratoryCatalogSearchSchema.parse({
      items: rows.map(row => laboratoryServiceConfigSchema.parse(
        JSON.parse(row.config_json),
      ).laboratoryService),
      page: input.page,
      pageSize: input.pageSize,
      total,
    })
  }

  saveLaboratoryRequestDraft(input: {
    catalogItemId: LaboratoryRequestCatalogItemId
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    indicationCode: string
  }): CommandResponse<{
    caseId: string
    draftVersion: number
  }> {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: laboratoryRequestDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        catalogItemId: input.catalogItemId,
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
        indicationCode: input.indicationCode,
      },
      operation: 'laboratory-request.save-draft',
      authorize: () => this.#context.assertRole(input.context, ['outpatient-doctor']),
    }, transaction => this.applySaveLaboratoryRequestDraft(transaction, input))
  }

  applySaveLaboratoryRequestDraft(_transaction: CommandTransaction, input: {
    catalogItemId: LaboratoryRequestCatalogItemId
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    indicationCode: string
  }) {
    const outpatientCase = this.#laboratoryRequestCaseForAction(
      input.context,
      input.encounterId,
      'edit-draft',
    )
    this.#context.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
    const selection = this.#resolvedLaboratorySelection(
      input.context,
      input.catalogItemId,
    )
    const { config: catalogConfig, laboratoryService, referenceConcept } = selection
    const price = laboratoryService === undefined
      ? this.#context.outpatientBilling.priceForPublishedLaboratory({ id: selection.catalog.item_id, version: selection.catalog.version, priceFen: selection.catalog.price_fen })
      : this.#context.outpatientBilling.priceForLaboratory(laboratoryService)
    const now = this.#context.virtualTime(input.context)
    if (laboratoryService !== undefined) {
      this.#assertAdultLaboratoryServiceApplicable(
        input.context,
        outpatientCase.patient_id,
        laboratoryService,
        now,
      )
    }
    if (laboratoryService === undefined) {
      this.#assertInvestigationGenerationSupported(
        input.context,
        outpatientCase.case_id,
        input.catalogItemId,
        referenceConcept,
      )
    } else {
      this.#assertLaboratoryServiceGenerationSupported(
        input.context,
        outpatientCase.case_id,
      )
    }
    if (!catalogConfig.allowedIndicationCodes.includes(input.indicationCode)) {
      throw new WorkflowError('CATALOG_CONFLICT', 'The indication is not allowed for this laboratory request')
    }
    const current = this.#laboratoryRequestState(input.context, outpatientCase.case_id)
    const currentVersion = current?.version ?? 0
    if (currentVersion !== input.expectedDraftVersion) {
      throw new WorkflowError(
        'LABORATORY_REQUEST_VERSION_CONFLICT',
        'The laboratory request draft version has changed',
      )
    }
    const nextVersion = currentVersion + 1
    if (current === undefined) {
      this.#context.database.driver.prepare(`
        INSERT INTO laboratory_request_state (
          workspace_id, epoch, case_id, version, draft_catalog_item_id,
          draft_indication_code, draft_reference_json, draft_service_snapshot_json, draft_price_json,
          updated_by, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        nextVersion,
        input.catalogItemId,
        input.indicationCode,
        JSON.stringify(referenceConcept),
        laboratoryService === undefined ? null : JSON.stringify(laboratoryService),
        JSON.stringify(price ?? null),
        input.context.actorId,
        now,
      )
    } else {
      const update = this.#context.database.driver.prepare(`
        UPDATE laboratory_request_state
        SET version = ?, draft_catalog_item_id = ?, draft_indication_code = ?,
          draft_reference_json = ?, draft_service_snapshot_json = ?, draft_price_json = ?,
          updated_by = ?, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND version = ?
      `).run(
        nextVersion,
        input.catalogItemId,
        input.indicationCode,
        JSON.stringify(referenceConcept),
        laboratoryService === undefined ? null : JSON.stringify(laboratoryService),
        JSON.stringify(price ?? null),
        input.context.actorId,
        now,
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        currentVersion,
      )
      if (update.changes !== 1) {
        throw new WorkflowError(
          'LABORATORY_REQUEST_VERSION_CONFLICT',
          'The laboratory request draft version has changed',
        )
      }
    }
    return {
      data: { caseId: outpatientCase.case_id, draftVersion: nextVersion },
      effects: [],
    }
  }

  deleteLaboratoryRequestDraft(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<{
    caseId: string
    draftVersion: number
  }> {
    return this.#context.commands.execute({
      authorize: () => {
        this.#context.assertRole(input.context, ['outpatient-doctor'])
        const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
        this.#context.assertCaseResponsibility(input.context, outpatientCase.case_id)
      },
      context: input.context,
      dataSchema: laboratoryRequestDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
      },
      mapExpectedVersionConflict: error => this.#context.expectedVersionWorkflowError(error, {
        code: 'LABORATORY_REQUEST_VERSION_CONFLICT',
        currentStatus: this.#laboratoryRequestDraftConflictStatus(
          input.context,
          input.encounterId,
        ),
        message: 'A laboratory request draft resource version has changed',
        owner: 'laboratory-request-draft',
        resource: `Encounter/${input.encounterId}`,
      }),
      operation: 'laboratory-request.delete-draft',
    }, transaction => this.applyDeleteLaboratoryRequestDraft(transaction, input))
  }

  applyDeleteLaboratoryRequestDraft(_transaction: CommandTransaction, input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }) {
    const outpatientCase = this.#laboratoryRequestCaseForAction(
      input.context,
      input.encounterId,
      'edit-draft',
    )
    this.#context.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
    const current = this.#laboratoryRequestState(input.context, outpatientCase.case_id)
    if (current === undefined) {
      throw new WorkflowError(
        'LABORATORY_REQUEST_VERSION_CONFLICT',
        'The laboratory request draft does not exist',
        {
          currentStatus: 'missing',
          expectedVersion: String(input.expectedDraftVersion),
          owner: 'laboratory-request-draft',
          resource: `LaboratoryRequestDraft/${outpatientCase.case_id}`,
        },
      )
    }
    if (current.draft_catalog_item_id === null) {
      throw new WorkflowError(
        'LABORATORY_REQUEST_VERSION_CONFLICT',
        `The laboratory request draft is empty at version ${current.version}`,
        {
          currentStatus: 'empty',
          currentVersion: String(current.version),
          expectedVersion: String(input.expectedDraftVersion),
          owner: 'laboratory-request-draft',
          resource: `LaboratoryRequestDraft/${outpatientCase.case_id}`,
        },
      )
    }
    if (current.version !== input.expectedDraftVersion) {
      throw new WorkflowError(
        'LABORATORY_REQUEST_VERSION_CONFLICT',
        `The laboratory request draft is at version ${current.version}; expected version ${input.expectedDraftVersion}`,
        {
          currentStatus: 'draft',
          currentVersion: String(current.version),
          expectedVersion: String(input.expectedDraftVersion),
          owner: 'laboratory-request-draft',
          resource: `LaboratoryRequestDraft/${outpatientCase.case_id}`,
        },
      )
    }
    const draftVersion = current.version + 1
    const update = this.#context.database.driver.prepare(`
      UPDATE laboratory_request_state
      SET version = ?, draft_catalog_item_id = NULL, draft_indication_code = NULL,
        draft_reference_json = NULL, draft_service_snapshot_json = NULL, draft_price_json = NULL,
        updated_by = ?, updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND version = ?
        AND draft_catalog_item_id IS NOT NULL
    `).run(
      draftVersion,
      input.context.actorId,
      this.#context.virtualTime(input.context),
      input.context.workspaceId,
      input.context.epoch,
      outpatientCase.case_id,
      current.version,
    )
    if (update.changes !== 1) {
      throw new WorkflowError(
        'LABORATORY_REQUEST_VERSION_CONFLICT',
        'The laboratory request draft version has changed',
      )
    }
    return {
      data: { caseId: outpatientCase.case_id, draftVersion },
      effects: [{
        kind: 'updated' as const,
        reference: `LaboratoryRequestDraft/${outpatientCase.case_id}`,
        versionId: String(draftVersion),
      }],
    }
  }

  issueLaboratoryRequest(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }) {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: issueLaboratoryRequestResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
      },
      operation: 'laboratory-request.issue',
      authorize: () => this.#context.assertRole(input.context, ['outpatient-doctor']),
    }, transaction => this.applyIssueLaboratoryRequest(transaction, input))
  }

  applyIssueLaboratoryRequest(transaction: CommandTransaction, input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }) {
    const outpatientCase = this.#laboratoryRequestCaseForAction(
      input.context,
      input.encounterId,
      'issue',
    )
    this.#context.assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
    const state = this.#laboratoryRequestState(input.context, outpatientCase.case_id)
    if (state === undefined
      || state.version !== input.expectedDraftVersion
      || state.draft_catalog_item_id === null
      || state.draft_indication_code === null
      || state.draft_reference_json === null) {
      throw new WorkflowError(
        'LABORATORY_REQUEST_VERSION_CONFLICT',
        'The laboratory request draft version has changed',
      )
    }
    const duplicate = this.#context.database.driver.prepare(`
      SELECT request_id FROM laboratory_request
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        AND catalog_item_id = ?
        AND status IN ('issued', 'accepted', 'in-progress', 'generation-failed')
    `).get(
      input.context.workspaceId,
      input.context.epoch,
      outpatientCase.case_id,
      state.draft_catalog_item_id,
    )
    if (duplicate !== undefined) {
      throw new WorkflowError(
        'LABORATORY_REQUEST_DUPLICATE',
        'An active laboratory request already exists for this catalog item',
      )
    }
    const referenceConcept = referenceConceptSnapshotSchema.parse(
      JSON.parse(state.draft_reference_json),
    )
    const laboratoryService = state.draft_service_snapshot_json === null
      ? undefined
      : laboratoryServiceSnapshotSchema.parse(JSON.parse(state.draft_service_snapshot_json))
    const now = this.#context.virtualTime(input.context)
    if (laboratoryService !== undefined) {
      this.#assertAdultLaboratoryServiceApplicable(
        input.context,
        outpatientCase.patient_id,
        laboratoryService,
        now,
      )
    }
    const { catalog, config: catalogConfig } = this.#laboratorySelectionFromSnapshot(
      input.context,
      state.draft_catalog_item_id,
      referenceConcept,
      state.draft_indication_code,
      laboratoryService,
    )
    const price = laboratoryService === undefined
      ? this.#context.outpatientBilling.priceForPublishedLaboratory({ id: catalog.item_id, version: catalog.version, priceFen: catalog.price_fen })
      : this.#context.outpatientBilling.priceForLaboratory(laboratoryService)
    if (inpatientRequestOwner(this.#context.database, input.context, outpatientCase.case_id) === undefined) {
      const currentPrice = outpatientInvestigationPriceSchema.nullable().parse(price ?? null)
      const draftPrice = state.draft_price_json === null ? undefined
        : outpatientInvestigationPriceSchema.nullable().parse(JSON.parse(state.draft_price_json))
      if (draftPrice === undefined || JSON.stringify(draftPrice) !== JSON.stringify(currentPrice)) {
        throw new WorkflowError('CATALOG_CONFLICT', '本院门诊价目已变化，请重新保存并审阅申请')
      }
    }
    if (laboratoryService === undefined) {
      this.#assertInvestigationGenerationSupported(
        input.context,
        outpatientCase.case_id,
        state.draft_catalog_item_id,
        referenceConcept,
      )
    } else {
      this.#assertLaboratoryServiceGenerationSupported(
        input.context,
        outpatientCase.case_id,
      )
    }
    if (!catalogConfig.allowedIndicationCodes.includes(state.draft_indication_code)) {
      throw new WorkflowError('CATALOG_CONFLICT', 'The indication is not allowed for this laboratory request')
    }
    const allergyCodes = this.#context.patientAllergyCodes(input.context, outpatientCase.patient_id)
    if (catalogConfig.contraindicatedAllergyCodes.some(code => allergyCodes.has(code))) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request is contraindicated')
    }
    const requestId = uuidv7()
    const serviceRequestId = uuidv7()
    const taskId = uuidv7()
    const serviceRequest = transaction.fhir.create(input.context, {
      resourceType: 'ServiceRequest',
      id: serviceRequestId,
      status: 'active',
      intent: 'order',
      code: {
        concept: {
          coding: laboratoryServiceCodings(catalog, catalogConfig),
          text: catalog.name_zh,
        },
      },
      subject: { reference: `Patient/${outpatientCase.patient_id}` },
      encounter: { reference: `Encounter/${input.encounterId}` },
      authoredOn: now,
      requester: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
      reason: [{
        concept: {
          coding: [{
            code: state.draft_indication_code,
            system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-indication',
          }],
        },
      }],
    })
    const task = transaction.fhir.create(input.context, {
      resourceType: 'Task',
      id: taskId,
      status: 'requested',
      intent: 'order',
      code: {
        coding: [{
          code: 'laboratory-request-execution',
          system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/task-kind',
        }],
        text: `${catalog.name_zh}执行`,
      },
      focus: { reference: `ServiceRequest/${serviceRequestId}` },
      for: { reference: `Patient/${outpatientCase.patient_id}` },
      encounter: { reference: `Encounter/${input.encounterId}` },
      authoredOn: now,
      requester: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
      owner: { reference: 'Organization/organization-clinmesh' },
    })
    this.#context.database.driver.prepare(`
      INSERT INTO laboratory_request (
        workspace_id, epoch, request_id, case_id, request_kind, catalog_item_id,
        reference_json, service_snapshot_json, indication_code,
        service_request_id, execution_task_id, status, version, authored_by, authored_at
      ) VALUES (?, ?, ?, ?, 'laboratory', ?, ?, ?, ?, ?, ?, 'issued', 1, ?, ?)
    `).run(
      input.context.workspaceId,
      input.context.epoch,
      requestId,
      outpatientCase.case_id,
      state.draft_catalog_item_id,
      JSON.stringify(referenceConcept),
      laboratoryService === undefined ? null : JSON.stringify(laboratoryService),
      state.draft_indication_code,
      serviceRequestId,
      taskId,
      input.context.practitionerId ?? input.context.actorId,
      now,
    )
    const draftVersion = state.version + 1
    const update = this.#context.database.driver.prepare(`
      UPDATE laboratory_request_state
      SET version = ?, draft_catalog_item_id = NULL, draft_indication_code = NULL,
        draft_reference_json = NULL, draft_service_snapshot_json = NULL, draft_price_json = NULL,
        updated_by = ?, updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND version = ?
    `).run(
      draftVersion,
      input.context.actorId,
      now,
      input.context.workspaceId,
      input.context.epoch,
      outpatientCase.case_id,
      state.version,
    )
    if (update.changes !== 1) {
      throw new WorkflowError(
        'LABORATORY_REQUEST_VERSION_CONFLICT',
        'The laboratory request draft version has changed',
      )
    }
    const charge = inpatientRequestOwner(this.#context.database, input.context, outpatientCase.case_id) === undefined
      ? this.#context.outpatientBilling.issue(transaction, input.context, {
          requestId, serviceRequestId, caseId: outpatientCase.case_id, category: 'laboratory',
          descriptionZh: catalog.name_zh, descriptionEn: catalog.name_en, now,
          price,
        })
      : undefined
    return {
      data: {
        caseId: outpatientCase.case_id,
        draftVersion,
        request: {
          catalogItemId: state.draft_catalog_item_id,
          id: requestId,
          ...(charge === undefined ? {} : { billing: charge.billing }),
          indicationCode: state.draft_indication_code,
          previousReports: [],
          ...(laboratoryService === undefined ? {} : { laboratoryService }),
          referenceConcept,
          serviceRequestId,
          serviceRequestVersion: serviceRequest.meta?.versionId ?? '1',
          status: 'issued' as const,
          taskId,
          taskVersion: task.meta?.versionId ?? '1',
          version: 1,
        },
      },
      effects: [...[serviceRequest, task].map(resource => ({
        kind: 'created' as const,
        reference: `${resource.resourceType}/${resource.id}`,
        versionId: resource.meta?.versionId ?? '1',
      })), ...(charge?.effects ?? [])],
    }
  }

  cancelLaboratoryRequest(input: {
    context: ActorContext
    expectedRequestVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    reasonCode: 'no-longer-needed'
    requestId: string
  }) {
    const execute = () => this.#context.commands.execute({
      authorize: () => {
        this.#context.assertRole(input.context, ['outpatient-doctor'])
        const request = this.#laboratoryRequest(input.context, input.requestId)
        if (request === undefined
          || request.authored_by !== (
            input.context.practitionerId ?? input.context.actorId
          )) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request was not found')
        }
        this.#context.assertCaseResponsibility(input.context, request.case_id)
      },
      context: input.context,
      dataSchema: laboratoryRequestActionResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        expectedRequestVersion: input.expectedRequestVersion,
        reasonCode: input.reasonCode,
        requestId: input.requestId,
      },
      operation: 'laboratory-request.cancel',
    }, (transaction) => {
      const request = this.#laboratoryRequest(input.context, input.requestId)
      if (request === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request was not found')
      }
      this.#context.assertExpectedVersions(input.expectedVersions, [
        `ServiceRequest/${request.service_request_id}`,
        `Task/${request.execution_task_id}`,
      ])
      const { serviceRequest: updatedServiceRequest, task: updatedTask, version, chargeEffects } = this.#context.requests.cancel(
        laboratoryRequestPolicy,
        transaction,
        input.context,
        request,
        {
          expectedRequestVersion: input.expectedRequestVersion,
          now: this.#context.virtualTime(input.context),
          reasonCode: input.reasonCode,
        },
      )
      return {
        data: {
          request: {
            catalogItemId: request.catalog_item_id,
            id: request.request_id,
            indicationCode: request.indication_code,
            previousReports: [],
            serviceRequestId: request.service_request_id,
            serviceRequestVersion: updatedServiceRequest.meta?.versionId ?? '2',
            status: 'cancelled' as const,
            billing: this.#context.outpatientBilling.read(input.context, request.request_id),
            taskId: request.execution_task_id,
            taskVersion: updatedTask.meta?.versionId ?? '2',
            version,
          },
        },
        effects: [...[updatedServiceRequest, updatedTask].map(resource => ({
          kind: 'updated' as const,
          reference: `${resource.resourceType}/${resource.id}`,
          versionId: resource.meta?.versionId ?? '2',
        })), ...chargeEffects],
      }
    })

    try {
      return execute()
    } catch (error) {
      if (error instanceof ExpectedVersionConflictError) {
        const current = this.#laboratoryRequest(input.context, input.requestId)
        if (current === undefined) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request was not found')
        }
        throw this.#context.requests.relatedVersionConflict(
          laboratoryRequestPolicy,
          current,
          input.expectedRequestVersion,
        )
      }
      throw error
    }
  }

  acceptLaboratoryRequest(input: {
    context: ActorContext
    eventId: string
    requestId: string
  }) {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: laboratoryRequestSystemResponseSchema,
      expectedVersions: {},
      idempotencyKey: input.eventId,
      input: { requestId: input.requestId },
      operation: 'laboratory-request.accept',
    }, (transaction) => {
      this.#context.assertRole(input.context, ['lis-system'])
      const request = this.#laboratoryRequest(input.context, input.requestId)
      if (request === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request was not found')
      }
      const accepted = this.#context.requests.accept(
        laboratoryRequestPolicy,
        transaction,
        input.context,
        request,
        this.#context.virtualTime(input.context),
      )
      if (accepted.status === 'cancelled') {
        return {
          data: { requestId: request.request_id, status: 'cancelled' as const },
          effects: [],
        }
      }
      return {
        data: { requestId: request.request_id, status: 'accepted' as const },
        effects: [{
          kind: 'updated' as const,
          reference: `Task/${accepted.task.id}`,
          versionId: accepted.task.meta?.versionId ?? '2',
        }],
      }
    })
  }

  startLaboratoryRequest(input: {
    context: ActorContext
    eventId: string
    requestId: string
  }) {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: laboratoryRequestSystemResponseSchema,
      expectedVersions: {},
      idempotencyKey: input.eventId,
      input: { requestId: input.requestId },
      operation: 'laboratory-request.start',
    }, (transaction) => {
      this.#context.assertRole(input.context, ['lis-system'])
      const request = this.#laboratoryRequest(input.context, input.requestId)
      if (request === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request cannot start execution')
      }
      const updatedTask = this.#context.requests.start(
        laboratoryRequestPolicy,
        transaction,
        input.context,
        request,
        {
          enqueueReport: this.#supportsLaboratoryReports(input.context, request.case_id),
          now: this.#context.virtualTime(input.context),
        },
      )
      return {
        data: { requestId: request.request_id, status: 'in-progress' as const },
        effects: [{
          kind: 'updated' as const,
          reference: `Task/${updatedTask.id}`,
          versionId: updatedTask.meta?.versionId ?? '3',
        }],
      }
    })
  }

  reportLaboratoryRequest(input: {
    context: ActorContext
    eventId: string
    requestId: string
    resultSnapshot?: {
      content: InvestigationResultContent
      inputHash: string
      provenance?: {
        datasetReleaseId: string
        generationPolicyVersion: string
        referenceReleaseId: string
      }
      snapshotId: string
      source: 'adult-reference-baseline' | 'investigation-agent' | 'mixed' | 'synthea-exact' | 'case-truth-exact'
    }
  }) {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: laboratoryReportSystemResponseSchema,
      expectedVersions: {},
      idempotencyKey: input.eventId,
      input: {
        requestId: input.requestId,
        resultSnapshotId: input.resultSnapshot?.snapshotId,
      },
      operation: 'laboratory-request.report',
    }, (transaction) => {
      this.#context.assertRole(input.context, ['lis-system'])
      const request = this.#laboratoryRequest(input.context, input.requestId)
      if (request === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request was not found')
      }
      if (request.status === 'reported' && request.diagnostic_report_id !== null) {
        transaction.fhir.read(input.context, 'DiagnosticReport', request.diagnostic_report_id)
        return {
          data: {
            diagnosticReportId: request.diagnostic_report_id,
            requestId: request.request_id,
            status: 'reported' as const,
          },
          effects: [],
        }
      }
      if (request.status !== 'in-progress') {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'Only an in-progress laboratory request can be reported',
        )
      }
      if(input.resultSnapshot===undefined && inpatientRequestOwner(this.#context.database,input.context,request.case_id)!==undefined) throw new WorkflowError('LABORATORY_GENERATION_UNSUPPORTED','住院检验必须从固定合成来源生成结果')
      let laboratoryResultFact = input.resultSnapshot?.content
      if (laboratoryResultFact === undefined) {
        laboratoryResultFact = this.#legacyLaboratoryResultFact(
          input.context,
          request.catalog_item_id,
        )
        if (laboratoryResultFact === undefined) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory result fact is unavailable')
        }
      }
      const requestedConcept = referenceConceptSnapshotSchema.parse(JSON.parse(request.reference_json))
      const laboratoryService = request.service_snapshot_json === null
        ? undefined
        : laboratoryServiceSnapshotSchema.parse(JSON.parse(request.service_snapshot_json))
      const resultDefinitions = new Map(laboratoryService?.reportDefinition.results.map(
        definition => [definition.referenceConcept.code, definition],
      ))
      const serviceRequest = transaction.fhir.read(
        input.context,
        'ServiceRequest',
        request.service_request_id,
      )
      const task = transaction.fhir.read(input.context, 'Task', request.execution_task_id)
      if (serviceRequest.status !== 'active' || task.status !== 'in-progress') {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The formal laboratory request is not in progress',
        )
      }
      const specimenId = `sp-${request.service_request_id}`
      const diagnosticReportId = `dr-${request.service_request_id}`
      const provenanceId = `prov-${request.service_request_id}`
      const now = this.#context.virtualTime(input.context)
      const specimen = transaction.fhir.create(input.context, {
        resourceType: 'Specimen',
        id: specimenId,
        status: 'available',
        type: {
          coding: [{
            code: laboratoryService?.specimen.code ?? '119297000',
            display: laboratoryService?.specimen.display ?? 'Blood specimen',
            system: laboratoryService === undefined
              ? 'http://snomed.info/sct'
              : (laboratoryService.specimen.system ?? 'http://loinc.org'),
            ...(laboratoryService?.specimen.version === undefined
              ? {}
              : { version: laboratoryService.specimen.version }),
          }],
          text: laboratoryService === undefined
            ? 'Synthetic blood specimen'
            : laboratoryService.specimen.display,
        },
        subject: { reference: `Patient/${request.patient_id}` },
        request: [{ reference: `ServiceRequest/${request.service_request_id}` }],
        collection: { collectedDateTime: now },
        receivedTime: now,
      })
      const observations = laboratoryResultFact.results.map((result) => {
        const resultDefinition = resultDefinitions.get(result.code)
        if (laboratoryService !== undefined && resultDefinition === undefined) {
          throw new WorkflowError(
            'WORKFLOW_CONFLICT',
            'The laboratory result is outside the frozen report definition',
          )
        }
        const resultConcept = resultDefinition?.referenceConcept ?? requestedConcept
        const resultCoding = {
          code: result.code,
          display: result.display,
          system: input.resultSnapshot === undefined
            ? 'http://loinc.org'
            : resultConcept.system,
          ...(input.resultSnapshot === undefined ? {} : { version: resultConcept.version }),
        }
        const observationId = `obs-${result.code}-${request.service_request_id}`
        const interpretationCode = result.interpretation === 'normal'
          ? 'N'
          : result.interpretation === 'abnormal'
            ? 'A'
            : result.interpretation === 'high' ? 'H' : 'L'
        const value = typeof result.value === 'number'
          ? result.unit === undefined
            ? { valueQuantity: { value: result.value } }
            : {
                valueQuantity: {
                  code: result.unit.code,
                  system: result.unit.system,
                  unit: result.unit.display,
                  value: result.value,
                },
              }
          : typeof result.value === 'boolean'
            ? { valueBoolean: result.value }
            : typeof result.value === 'string'
              ? { valueString: result.value }
              : {
                  valueCodeableConcept: {
                    coding: [result.value],
                    text: result.value.display,
                  },
                }
        const criticalFlag = typeof result.value === 'number'
          ? ('critical' in result && result.critical !== undefined
              ? result.critical
              : resultDefinition !== undefined && hasLaboratoryCriticalBounds(resultDefinition)
                ? isLaboratoryValueCritical(result.value, resultDefinition)
                : undefined)
          : undefined
        return transaction.fhir.create(input.context, {
          resourceType: 'Observation',
          id: observationId,
          ...(criticalFlag === undefined
            ? {}
            : {
                extension: [{
                  url: laboratoryCriticalValueExtensionUrl,
                  valueBoolean: criticalFlag,
                }],
              }),
          status: 'final',
          category: [{
            coding: [{
              code: 'laboratory',
              system: 'http://terminology.hl7.org/CodeSystem/observation-category',
            }],
          }],
          code: {
            coding: [resultCoding, ...(resultDefinition?.alternateCodings ?? []).map(coding => ({
              code: coding.code,
              system: coding.system,
              version: coding.version,
            }))],
            text: result.display,
          },
          subject: { reference: `Patient/${request.patient_id}` },
          encounter: { reference: `Encounter/${request.encounter_id}` },
          basedOn: [{ reference: `ServiceRequest/${request.service_request_id}` }],
          specimen: { reference: `Specimen/${specimenId}` },
          effectiveDateTime: now,
          issued: now,
          ...value,
          referenceRange: [{
            ...(result.referenceRange.low === undefined ? {} : {
              low: {
                ...(result.unit === undefined ? {} : {
                  code: result.unit.code,
                  system: result.unit.system,
                  unit: result.unit.display,
                }),
                value: result.referenceRange.low,
              },
            }),
            ...(result.referenceRange.high === undefined ? {} : {
              high: {
                ...(result.unit === undefined ? {} : {
                  code: result.unit.code,
                  system: result.unit.system,
                  unit: result.unit.display,
                }),
                value: result.referenceRange.high,
              },
            }),
            text: result.referenceRange.text,
          }],
          interpretation: [{
            coding: [{
              code: interpretationCode,
              system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
            }],
          }],
        })
      })
      const reportName = input.resultSnapshot !== undefined
        ? `${requestedConcept.display}报告`
        : request.catalog_item_id === 'lab-cbc' ? '血常规报告' : 'C 反应蛋白报告'
      const reportCodings = input.resultSnapshot === undefined
        ? [{
            code: request.catalog_item_id === 'lab-cbc' ? 'CBC' : 'CRP',
            display: reportName,
            system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-service',
          }]
        : [{
            code: laboratoryService?.localCode ?? requestedConcept.code,
            display: laboratoryService?.nameZh ?? requestedConcept.display,
            system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-service',
          }, {
            code: requestedConcept.code,
            display: requestedConcept.display,
            system: requestedConcept.system,
            version: requestedConcept.version,
          }]
      const report = transaction.fhir.create(input.context, {
        resourceType: 'DiagnosticReport',
        id: diagnosticReportId,
        status: 'final',
        code: {
          coding: reportCodings,
          text: reportName,
        },
        subject: { reference: `Patient/${request.patient_id}` },
        encounter: { reference: `Encounter/${request.encounter_id}` },
        basedOn: [{ reference: `ServiceRequest/${request.service_request_id}` }],
        specimen: [{ reference: `Specimen/${specimenId}` }],
        result: observations.map(observation => ({
          reference: `Observation/${observation.id}`,
        })),
        effectiveDateTime: now,
        issued: now,
        conclusion: laboratoryResultFact.conclusion,
      })
      const {
        serviceRequest: completedServiceRequest,
        task: completedTask,
        chargeEffects,
      } = this.#context.requests.completeReport(laboratoryRequestPolicy, transaction, input.context, request, {
        diagnosticReportId,
        now,
        resultSnapshotId: input.resultSnapshot?.snapshotId ?? null,
        serviceRequest,
        task,
      })
      this.#host.reportPublished(transaction, input.context, request.case_id, `DiagnosticReport/${diagnosticReportId}/_history/1`, reportName)
      const provenance = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Provenance',
        id: provenanceId,
        target: [
          { reference: `Specimen/${specimenId}` },
          { reference: `DiagnosticReport/${diagnosticReportId}` },
          ...observations.map(observation => ({ reference: `Observation/${observation.id}` })),
          { reference: `ServiceRequest/${request.service_request_id}` },
          { reference: `Task/${request.execution_task_id}` },
        ],
        recorded: now,
        activity: {
          text: input.resultSnapshot === undefined
            ? 'Laboratory result generation and report issuance'
            : `Laboratory report issuance from ${input.resultSnapshot.source}`,
        },
        agent: provenanceAgents(input.context, 'Laboratory report issuer'),
        ...(input.resultSnapshot?.provenance === undefined
          ? {}
          : {
              entity: [{
                role: 'source',
                what: {
                  identifier: {
                    system: 'https://caizongyuan.github.io/clinmesh/identifier/investigation-result-snapshot',
                    value: input.resultSnapshot.snapshotId,
                  },
                },
              }, ...[
                ['reference-release', input.resultSnapshot.provenance.referenceReleaseId],
                ['dataset-release', input.resultSnapshot.provenance.datasetReleaseId],
                ['generation-policy', input.resultSnapshot.provenance.generationPolicyVersion],
                ['input-hash', input.resultSnapshot.inputHash],
              ].map(([kind, value]) => ({
                role: 'source',
                what: {
                  identifier: {
                    system: `https://caizongyuan.github.io/clinmesh/identifier/${kind}`,
                    value,
                  },
                },
              }))],
            }),
      })
      return {
        data: {
          diagnosticReportId,
          requestId: request.request_id,
          status: 'reported' as const,
        },
        effects: [
          specimen,
          ...observations,
          report,
          provenance,
          completedServiceRequest,
          completedTask,
        ].map(resource => ({
          kind: resource.meta?.versionId === '1' ? 'created' as const : 'updated' as const,
          reference: `${resource.resourceType}/${resource.id}`,
          versionId: resource.meta?.versionId ?? '1',
        })).concat(chargeEffects),
      }
    })
  }

  failLaboratoryResultGeneration(input: {
    context: ActorContext
    error: { code: string; message: string }
    eventId: string
    requestId: string
  }) {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: laboratoryRequestSystemResponseSchema,
      expectedVersions: {},
      idempotencyKey: input.eventId,
      input: { errorCode: input.error.code, requestId: input.requestId },
      operation: 'laboratory-request.fail-generation',
    }, transaction => {
      this.#context.assertRole(input.context, ['lis-system'])
      const request = this.#laboratoryRequest(input.context, input.requestId)
      if (request === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request was not found')
      }
      const failedTask = this.#context.requests.failGeneration(
        laboratoryRequestPolicy,
        transaction,
        input.context,
        request,
        { error: input.error, now: this.#context.virtualTime(input.context) },
      )
      if (failedTask === undefined) {
        return {
          data: { requestId: request.request_id, status: 'generation-failed' as const },
          effects: [],
        }
      }
      return {
        data: { requestId: request.request_id, status: 'generation-failed' as const },
        effects: [{
          kind: 'updated' as const,
          reference: `Task/${failedTask.id}`,
          versionId: failedTask.meta?.versionId ?? '4',
        }],
      }
    })
  }

  retryLaboratoryResultGeneration(input: {
    context: ActorContext
    expectedRequestVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    requestId: string
  }) {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: laboratoryRequestActionResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        expectedRequestVersion: input.expectedRequestVersion,
        requestId: input.requestId,
      },
      operation: 'laboratory-request.retry-generation',
    }, transaction => {
      this.#context.assertRole(input.context, ['outpatient-doctor'])
      const request = this.#laboratoryRequest(input.context, input.requestId)
      if (request === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request was not found')
      }
      if (request.generation_error_code === 'INVESTIGATION_TRUTH_INCOMPATIBLE'
        || request.generation_error_code === 'INVESTIGATION_UNSUPPORTED') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The incompatible or unsupported laboratory result cannot be retried')
      }
      this.#context.requests.assertRetryable(
        laboratoryRequestPolicy,
        input.context,
        request,
        input.expectedRequestVersion,
      )
      this.#context.assertExpectedVersions(input.expectedVersions, [`Task/${request.execution_task_id}`])
      const retriedTask = this.#context.requests.retryGeneration(
        laboratoryRequestPolicy,
        transaction,
        input.context,
        request,
        this.#context.virtualTime(input.context),
      )
      const projected = this.laboratoryRequests(input.context, request.case_id)
        .find(item => item.id === request.request_id)
      if (projected === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request was not found')
      return {
        data: { request: projected },
        effects: [{
          kind: 'updated' as const,
          reference: `Task/${retriedTask.id}`,
          versionId: retriedTask.meta?.versionId ?? '5',
        }],
      }
    })
  }

  acknowledgeLaboratoryReport(input: {
    context: ActorContext
    diagnosticReportId: string
    expectedRequestVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    requestId: string
  }): CommandResponse<{
    acknowledgementId: string
    acknowledgedAt: string
    acknowledgedBy: string
    diagnosticReportId: string
    requestId: string
    requestVersion: number
    status: 'acknowledged'
  }> {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: acknowledgeLaboratoryReportResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        diagnosticReportId: input.diagnosticReportId,
        expectedRequestVersion: input.expectedRequestVersion,
        requestId: input.requestId,
      },
      operation: 'laboratory-report.acknowledge',
    }, (transaction) => {
      this.#context.assertRole(input.context, ['outpatient-doctor'])
      this.#context.assertExpectedVersions(
        input.expectedVersions,
        [`DiagnosticReport/${input.diagnosticReportId}`],
      )
      const request = this.#laboratoryRequest(input.context, input.requestId)
      if (request === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request was not found')
      }
      const acknowledgement = this.#context.requests.acknowledge(
        laboratoryRequestPolicy,
        transaction,
        input.context,
        request,
        {
          assertReportContent: report => laboratoryDiagnosticReportContentSchema.parse(report),
          diagnosticReportId: input.diagnosticReportId,
          expectedRequestVersion: input.expectedRequestVersion,
          now: this.#context.virtualTime(input.context),
        },
      )
      return {
        data: {
          acknowledgementId: acknowledgement.acknowledgementId,
          acknowledgedAt: acknowledgement.acknowledgedAt,
          acknowledgedBy: acknowledgement.acknowledgedBy,
          diagnosticReportId: acknowledgement.diagnosticReportId,
          requestId: acknowledgement.requestId,
          requestVersion: acknowledgement.requestVersion,
          status: 'acknowledged' as const,
        },
        effects: acknowledgement.created
          ? [{
              kind: 'created' as const,
              reference: `ReportAcknowledgement/${acknowledgement.acknowledgementId}`,
              versionId: '1',
            }]
          : [],
      }
    })
  }

  correctLaboratoryReport(input: {
    conclusion: string
    context: ActorContext
    diagnosticReportId: string
    expectedRequestVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    reason: string
    requestId: string
    results: Array<{ code: string; value: number }>
  }): CommandResponse<{
    diagnosticReportId: string
    previousDiagnosticReportId: string
    provenanceId: string
    requestId: string
    requestVersion: number
    status: 'reported'
  }> {
    return this.#context.commands.execute({
      authorize: () => this.#context.assertRole(input.context, ['lis-system']),
      context: input.context,
      dataSchema: correctLaboratoryReportResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        conclusion: input.conclusion,
        diagnosticReportId: input.diagnosticReportId,
        expectedRequestVersion: input.expectedRequestVersion,
        reason: input.reason,
        requestId: input.requestId,
        results: input.results,
      },
      mapExpectedVersionConflict: error => this.#context.expectedVersionWorkflowError(error, {
        code: 'LABORATORY_REQUEST_VERSION_CONFLICT',
        currentStatus: this.#laboratoryReportConflictStatus(
          input.context,
          input.requestId,
          input.diagnosticReportId,
        ),
        message: 'A laboratory report resource version has changed',
        owner: 'laboratory-report',
        resource: `DiagnosticReport/${input.diagnosticReportId}`,
      }),
      operation: 'laboratory-report.correct',
    }, (transaction) => {
      this.#context.assertExpectedVersions(
        input.expectedVersions,
        [`DiagnosticReport/${input.diagnosticReportId}`],
      )
      const request = this.#laboratoryRequest(input.context, input.requestId)
      if (request === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request was not found')
      }
      if (request.version !== input.expectedRequestVersion) {
        throw new WorkflowError(
          'LABORATORY_REQUEST_VERSION_CONFLICT',
          `The laboratory request is "${request.status}" at version ${request.version}; expected version ${input.expectedRequestVersion}`,
          {
            currentStatus: request.status,
            currentVersion: String(request.version),
            expectedVersion: String(input.expectedRequestVersion),
            owner: 'laboratory-report',
            resource: `DiagnosticReport/${input.diagnosticReportId}`,
          },
        )
      }
      if (request.diagnostic_report_id !== input.diagnosticReportId) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The laboratory report is superseded; only the latest signed report can be corrected',
          {
            currentStatus: 'superseded',
            currentVersion: String(request.version),
            expectedVersion: String(input.expectedRequestVersion),
            owner: 'laboratory-report',
            resource: `DiagnosticReport/${input.diagnosticReportId}`,
          },
        )
      }
      if (request.status !== 'reported' && request.status !== 'acknowledged') {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          `The laboratory report cannot be corrected while the request status is "${request.status}"`,
          {
            currentStatus: request.status,
            currentVersion: String(request.version),
            owner: 'laboratory-report',
            resource: `DiagnosticReport/${input.diagnosticReportId}`,
          },
        )
      }
      const sourceReportResource = transaction.fhir.read(
        input.context,
        'DiagnosticReport',
        input.diagnosticReportId,
      )
      if (sourceReportResource.status !== 'final') {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'Only a signed laboratory report can be corrected',
        )
      }
      const sourceReport = laboratoryDiagnosticReportContentSchema.parse(sourceReportResource)
      const currentReport = this.#laboratoryReport(
        input.context,
        request.request_id,
        input.diagnosticReportId,
        request.service_request_id,
      )
      const corrections = new Map(input.results.map(result => [result.code, result.value]))
      if (
        corrections.size !== currentReport.results.length
        || currentReport.results.some(result => !corrections.has(result.code))
      ) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The laboratory report correction must include each existing result exactly once',
        )
      }
      const now = this.#context.virtualTime(input.context)
      const sourceObservations = sourceReport.result.map((reference) => {
        if (!reference.reference.startsWith('Observation/')) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory report result is invalid')
        }
        const observationId = reference.reference.slice('Observation/'.length)
        const resource = transaction.fhir.read(input.context, 'Observation', observationId)
        return {
          content: laboratoryObservationContentSchema.parse(resource),
          id: observationId,
          resource,
        }
      })
      const laboratoryService = request.service_snapshot_json === null
        ? undefined
        : laboratoryServiceSnapshotSchema.parse(JSON.parse(request.service_snapshot_json))
      const resultDefinitions = new Map(laboratoryService?.reportDefinition.results.map(
        definition => [definition.referenceConcept.code, definition],
      ))
      const observations = sourceObservations.map((source) => {
        const code = source.content.code.coding[0]?.code
        const referenceRange = source.content.referenceRange[0]
        if (
          code === undefined
          || referenceRange === undefined
          || source.content.valueQuantity === undefined
          || (referenceRange.low === undefined && referenceRange.high === undefined)
        ) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory result is incomplete')
        }
        const value = corrections.get(code)
        if (value === undefined) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory result correction is incomplete')
        }
        const interpretation = referenceRange.low !== undefined && value < referenceRange.low.value
          ? 'L'
          : referenceRange.high !== undefined && value > referenceRange.high.value ? 'H' : 'N'
        const resultDefinition = resultDefinitions.get(code)
        const criticalFlag = resultDefinition !== undefined && hasLaboratoryCriticalBounds(resultDefinition)
          ? isLaboratoryValueCritical(value, resultDefinition)
          : undefined
        const priorExtensions = Array.isArray(source.resource.extension)
          ? source.resource.extension.filter(item => (
              typeof item !== 'object'
              || item === null
              || (item as { url?: unknown }).url !== laboratoryCriticalValueExtensionUrl
            ))
          : []
        const nextExtensions = criticalFlag === undefined
          ? priorExtensions
          : [...priorExtensions, { url: laboratoryCriticalValueExtensionUrl, valueBoolean: criticalFlag }]
        const content = Object.fromEntries(Object.entries(source.resource).filter(
          ([key]) => key !== 'id' && key !== 'meta' && key !== 'extension',
        ))
        return transaction.fhir.create(input.context, {
          ...content,
          ...(nextExtensions.length === 0 ? {} : { extension: nextExtensions }),
          resourceType: 'Observation',
          id: uuidv7(),
          status: 'final',
          effectiveDateTime: now,
          issued: now,
          valueQuantity: {
            ...source.content.valueQuantity,
            value,
          },
          interpretation: [{
            coding: [{
              ...source.content.interpretation[0]?.coding[0],
              code: interpretation,
            }],
          }],
        })
      })
      const reportContent = Object.fromEntries(Object.entries(sourceReportResource).filter(
        ([key]) => key !== 'id' && key !== 'meta',
      ))
      const diagnosticReportId = uuidv7()
      const report = transaction.fhir.create(input.context, {
        ...reportContent,
        resourceType: 'DiagnosticReport',
        id: diagnosticReportId,
        status: 'final',
        effectiveDateTime: now,
        issued: now,
        conclusion: input.conclusion,
        result: observations.map(observation => ({
          reference: `Observation/${observation.id}`,
        })),
      })
      this.#host.reportPublished(transaction, input.context, request.case_id, `DiagnosticReport/${diagnosticReportId}/_history/1`, input.reason.length > 0 ? '检验报告（已更正）' : '检验报告')
      const provenanceId = uuidv7()
      const provenance = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Provenance',
        id: provenanceId,
        target: [
          { reference: `DiagnosticReport/${diagnosticReportId}` },
          ...observations.map(observation => ({ reference: `Observation/${observation.id}` })),
        ],
        recorded: now,
        activity: { text: 'Laboratory report correction' },
        reason: [{ concept: { text: input.reason } }],
        agent: provenanceAgents(input.context, 'Laboratory report corrector'),
        entity: [
          {
            role: 'revision',
            what: { reference: `DiagnosticReport/${input.diagnosticReportId}` },
          },
          ...sourceObservations.map(observation => ({
            role: 'revision',
            what: { reference: `Observation/${observation.id}` },
          })),
        ],
      })
      this.#context.requests.recordReportRevision(laboratoryRequestPolicy, input.context, request, {
        diagnosticReportId,
        now,
        provenanceId,
        reason: input.reason,
        revisionOfDiagnosticReportId: input.diagnosticReportId,
      })
      return {
        data: {
          diagnosticReportId,
          previousDiagnosticReportId: input.diagnosticReportId,
          provenanceId,
          requestId: request.request_id,
          requestVersion: request.version + 1,
          status: 'reported' as const,
        },
        effects: [
          ...observations,
          report,
          provenance,
        ].map(resource => ({
          kind: 'created' as const,
          reference: `${resource.resourceType}/${resource.id}`,
          versionId: resource.meta?.versionId ?? '1',
        })),
      }
    })
  }

  issueLaboratoryOrder(input: {
    catalogItemId: string
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    indicationCode: string
  }): CommandResponse<{
    chargeItemId: string
    encounterId: string
    encounterVersion: string
    serviceRequestId: string
    status: 'awaiting-lab-payment'
    totalFen: number
  }> {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: laboratoryOrderResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        catalogItemId: input.catalogItemId,
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
        indicationCode: input.indicationCode,
      },
      operation: 'encounter.issue-laboratory-order',
    }, transaction => {
      this.#context.assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#context.caseByEncounter(input.context, input.encounterId)
      if (outpatientCase.status !== 'first-visit' || outpatientCase.doctor_task_id === null) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter cannot issue a laboratory request')
      }
      this.#context.assertExpectedVersions(input.expectedVersions, [
        `Encounter/${input.encounterId}`,
        `Task/${outpatientCase.doctor_task_id}`,
      ])
      const draft = this.#context.database.driver.prepare(`
        SELECT version FROM clinical_draft
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND draft_kind = 'first-visit'
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id) as {
        version: number
      } | undefined
      if (draft?.version !== input.expectedDraftVersion) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The first-visit draft version is stale')
      }
      const catalog = this.#context.catalogItem(input.context, input.catalogItemId, 'laboratory')
      const catalogConfig = laboratoryCatalogConfigSchema.parse(
        JSON.parse(catalog.config_json ?? '{}') as unknown,
      )
      if (!catalogConfig.allowedIndicationCodes.includes(input.indicationCode)) {
        throw new WorkflowError('CATALOG_CONFLICT', 'The indication is not allowed for this laboratory request')
      }
      const allergyCodes = this.#context.patientAllergyCodes(input.context, outpatientCase.patient_id)
      if (catalogConfig.contraindicatedAllergyCodes.some(code => allergyCodes.has(code))) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request is contraindicated')
      }
      const encounter = transaction.fhir.read(input.context, 'Encounter', input.encounterId)
      const task = transaction.fhir.read(input.context, 'Task', outpatientCase.doctor_task_id)
      const serviceRequestId = uuidv7()
      const chargeItemId = uuidv7()
      const chargeId = uuidv7()
      const now = this.#context.virtualTime(input.context)
      const serviceRequest = transaction.fhir.create(input.context, {
        resourceType: 'ServiceRequest',
        id: serviceRequestId,
        status: 'active',
        intent: 'order',
        code: {
          concept: {
            coding: laboratoryServiceCodings(catalog, catalogConfig),
            text: catalog.name_zh,
          },
        },
        subject: { reference: `Patient/${outpatientCase.patient_id}` },
        encounter: { reference: `Encounter/${input.encounterId}` },
        authoredOn: now,
        requester: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
        reason: [{ concept: { coding: [{ code: input.indicationCode }] } }],
      })
      const chargeItem = transaction.fhir.create(input.context, {
        resourceType: 'ChargeItem',
        id: chargeItemId,
        status: 'billable',
        code: { text: catalog.name_zh },
        subject: { reference: `Patient/${outpatientCase.patient_id}` },
        encounter: { reference: `Encounter/${input.encounterId}` },
        account: [{ reference: `Account/${outpatientCase.account_id}` }],
        occurrenceDateTime: now,
        quantity: { value: 1 },
        unitPriceComponent: { amount: { currency: 'CNY', value: catalog.price_fen / 100 } },
      })
      const updatedEncounter = transaction.fhir.update(input.context, {
        ...encounter,
        status: 'in-progress',
        extension: [
          ...(Array.isArray(encounter.extension) ? encounter.extension : []),
          {
            url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/workflow-phase',
            valueCode: 'awaiting-lab-payment',
          },
        ],
      }, encounter.meta?.versionId ?? '1')
      const completedTask = transaction.fhir.update(input.context, {
        ...task,
        status: 'completed',
        executionPeriod: {
          ...((typeof task.executionPeriod === 'object' && task.executionPeriod !== null)
            ? task.executionPeriod as Record<string, unknown>
            : {}),
          end: now,
        },
      }, task.meta?.versionId ?? '1')
      this.#context.database.driver.prepare(`
        INSERT INTO charge_record (
          workspace_id, epoch, charge_id, case_id, account_id, charge_item_id,
          category, source_reference, description_zh, description_en,
          quantity, unit_price_fen, total_fen, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'laboratory', ?, ?, ?, 1, ?, ?, 'billable', ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        chargeId,
        outpatientCase.case_id,
        outpatientCase.account_id,
        chargeItemId,
        `ServiceRequest/${serviceRequestId}`,
        catalog.name_zh,
        catalog.name_en,
        catalog.price_fen,
        catalog.price_fen,
        now,
      )
      this.#context.database.driver.prepare(`
        UPDATE outpatient_case
        SET status = 'awaiting-lab-payment', service_request_id = ?,
          version = version + 1, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status = 'first-visit'
      `).run(
        serviceRequestId,
        now,
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
      )
      return {
        data: {
          chargeItemId,
          encounterId: input.encounterId,
          encounterVersion: updatedEncounter.meta?.versionId ?? '4',
          serviceRequestId,
          status: 'awaiting-lab-payment' as const,
          totalFen: catalog.price_fen,
        },
        effects: [
          { kind: 'created' as const, resource: serviceRequest },
          { kind: 'created' as const, resource: chargeItem },
          { kind: 'updated' as const, resource: updatedEncounter },
          { kind: 'updated' as const, resource: completedTask },
        ].map(effect => ({
          kind: effect.kind,
          reference: `${effect.resource.resourceType}/${effect.resource.id}`,
          versionId: effect.resource.meta?.versionId ?? '1',
        })),
      }
    })
  }

  processLisOrder(input: {
    context: ActorContext
    eventId: string
    payload: {
      caseId: string
      encounterId: string
      patientId: string
      serviceRequestId: string
    }
  }): CommandResponse<{
    diagnosticReportId: string
    encounterVersion: string
    status: 'awaiting-revisit'
  }> {
    return this.#context.commands.execute({
      context: input.context,
      dataSchema: lisOrderDataSchema,
      expectedVersions: {},
      idempotencyKey: input.eventId,
      input: input.payload,
      operation: 'lis.process-order',
    }, transaction => {
      this.#context.assertRole(input.context, ['lis-system'])
      const outpatientCase = this.#context.database.driver.prepare(`
        SELECT case_id, patient_id, encounter_id, service_request_id,
          diagnostic_report_id, status
        FROM outpatient_case
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(input.context.workspaceId, input.context.epoch, input.payload.caseId) as {
        case_id: string
        diagnostic_report_id: string | null
        encounter_id: string
        patient_id: string
        service_request_id: string | null
        status: string
      } | undefined
      if (
        outpatientCase === undefined
        || outpatientCase.patient_id !== input.payload.patientId
        || outpatientCase.encounter_id !== input.payload.encounterId
        || outpatientCase.service_request_id !== input.payload.serviceRequestId
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The paid laboratory request is not available to LIS')
      }
      if (outpatientCase.diagnostic_report_id !== null) {
        transaction.fhir.read(
          input.context,
          'DiagnosticReport',
          outpatientCase.diagnostic_report_id,
        )
        const encounter = transaction.fhir.read(
          input.context,
          'Encounter',
          outpatientCase.encounter_id,
        )
        return {
          data: {
            diagnosticReportId: outpatientCase.diagnostic_report_id,
            encounterVersion: encounter.meta?.versionId ?? '5',
            status: 'awaiting-revisit' as const,
          },
          effects: [],
        }
      }
      if (outpatientCase.status !== 'awaiting-lis') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The paid laboratory request is not available to LIS')
      }
      const hiddenFact = this.#context.database.driver.prepare(`
        SELECT value_json FROM scenario_hidden_fact
        WHERE workspace_id = ? AND epoch = ? AND fact_code = 'respiratory-pathogen'
      `).get(input.context.workspaceId, input.context.epoch) as { value_json: string } | undefined
      if (hiddenFact === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The LIS Scenario fact is unavailable')
      const fact = respiratoryPathogenFactSchema.parse(JSON.parse(hiddenFact.value_json))
      const specimenId = `sp-${input.payload.serviceRequestId}`
      const influenzaObservationId = `obs-flu-${input.payload.serviceRequestId}`
      const bloodObservationId = `obs-wbc-${input.payload.serviceRequestId}`
      const diagnosticReportId = `dr-${input.payload.serviceRequestId}`
      const revisitTaskId = `task-rv-${input.payload.serviceRequestId}`
      const now = this.#context.virtualTime(input.context)
      const specimen = transaction.fhir.create(input.context, {
        resourceType: 'Specimen',
        id: specimenId,
        status: 'available',
        type: { text: 'Synthetic nasopharyngeal swab and blood specimen' },
        subject: { reference: `Patient/${input.payload.patientId}` },
        request: [{ reference: `ServiceRequest/${input.payload.serviceRequestId}` }],
        receivedTime: now,
      })
      const influenzaObservation = transaction.fhir.create(input.context, {
        resourceType: 'Observation',
        id: influenzaObservationId,
        status: 'final',
        category: [{ coding: [{ code: 'laboratory', system: 'http://terminology.hl7.org/CodeSystem/observation-category' }] }],
        code: { coding: [{ code: '80382-5', display: 'Influenza virus A Ag', system: 'http://loinc.org' }] },
        subject: { reference: `Patient/${input.payload.patientId}` },
        encounter: { reference: `Encounter/${input.payload.encounterId}` },
        basedOn: [{ reference: `ServiceRequest/${input.payload.serviceRequestId}` }],
        specimen: { reference: `Specimen/${specimenId}` },
        effectiveDateTime: now,
        valueBoolean: fact.detected,
        interpretation: [{ coding: [{ code: fact.detected ? 'POS' : 'NEG', system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation' }] }],
      })
      const bloodObservation = transaction.fhir.create(input.context, {
        resourceType: 'Observation',
        id: bloodObservationId,
        status: 'final',
        category: [{ coding: [{ code: 'laboratory', system: 'http://terminology.hl7.org/CodeSystem/observation-category' }] }],
        code: { coding: [{ code: '6690-2', display: 'Leukocytes [#/volume] in Blood', system: 'http://loinc.org' }] },
        subject: { reference: `Patient/${input.payload.patientId}` },
        encounter: { reference: `Encounter/${input.payload.encounterId}` },
        basedOn: [{ reference: `ServiceRequest/${input.payload.serviceRequestId}` }],
        specimen: { reference: `Specimen/${specimenId}` },
        effectiveDateTime: now,
        valueQuantity: { code: '10*9/L', system: 'http://unitsofmeasure.org', unit: '10^9/L', value: 6.8 },
        referenceRange: [{ low: { value: 3.5 }, high: { value: 9.5 }, text: '3.5-9.5 x10^9/L' }],
        interpretation: [{ coding: [{ code: 'N', system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation' }] }],
      })
      const report = transaction.fhir.create(input.context, {
        resourceType: 'DiagnosticReport',
        id: diagnosticReportId,
        status: 'final',
        code: { text: 'Synthetic fever laboratory panel' },
        subject: { reference: `Patient/${input.payload.patientId}` },
        encounter: { reference: `Encounter/${input.payload.encounterId}` },
        basedOn: [{ reference: `ServiceRequest/${input.payload.serviceRequestId}` }],
        specimen: [{ reference: `Specimen/${specimenId}` }],
        result: [
          { reference: `Observation/${influenzaObservationId}` },
          { reference: `Observation/${bloodObservationId}` },
        ],
        effectiveDateTime: now,
        issued: now,
        conclusion: fact.detected ? 'Influenza A antigen detected.' : 'Influenza A antigen not detected.',
      })
      const serviceRequest = transaction.fhir.read(input.context, 'ServiceRequest', input.payload.serviceRequestId)
      const completedRequest = transaction.fhir.update(input.context, {
        ...serviceRequest,
        status: 'completed',
      }, serviceRequest.meta?.versionId ?? '1')
      const encounter = transaction.fhir.read(input.context, 'Encounter', input.payload.encounterId)
      const updatedEncounter = transaction.fhir.update(input.context, {
        ...encounter,
        status: 'in-progress',
        extension: [
          ...(Array.isArray(encounter.extension) ? encounter.extension : []),
          {
            url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/workflow-phase',
            valueCode: 'awaiting-revisit',
          },
        ],
      }, encounter.meta?.versionId ?? '1')
      const revisitTask = transaction.fhir.create(input.context, {
        resourceType: 'Task',
        id: revisitTaskId,
        status: 'requested',
        intent: 'order',
        code: { text: 'Outpatient revisit after final laboratory report' },
        for: { reference: `Patient/${input.payload.patientId}` },
        focus: { reference: `Encounter/${input.payload.encounterId}` },
        owner: { reference: 'PractitionerRole/practitioner-role-outpatient-doctor' },
        authoredOn: now,
        input: [{
          type: { text: 'Diagnostic report' },
          valueReference: { reference: `DiagnosticReport/${diagnosticReportId}` },
        }],
      })
      this.#host.reportPublished(transaction, input.context, input.payload.caseId, `DiagnosticReport/${diagnosticReportId}/_history/1`, '呼吸道病原体检验报告')
      this.#context.database.driver.prepare(`
        UPDATE outpatient_case
        SET status = 'awaiting-revisit', diagnostic_report_id = ?, doctor_task_id = ?,
          version = version + 1, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status = 'awaiting-lis'
      `).run(
        diagnosticReportId,
        revisitTaskId,
        now,
        input.context.workspaceId,
        input.context.epoch,
        input.payload.caseId,
      )
      const created = [specimen, influenzaObservation, bloodObservation, report, revisitTask]
      const updated = [completedRequest, updatedEncounter]
      return {
        data: {
          diagnosticReportId,
          encounterVersion: updatedEncounter.meta?.versionId ?? '5',
          status: 'awaiting-revisit' as const,
        },
        effects: [
          ...created.map(resource => ({
            kind: 'created' as const,
            reference: `${resource.resourceType}/${resource.id}`,
            versionId: resource.meta?.versionId ?? '1',
          })),
          ...updated.map(resource => ({
            kind: 'updated' as const,
            reference: `${resource.resourceType}/${resource.id}`,
            versionId: resource.meta?.versionId ?? '2',
          })),
        ],
      }
    })
  }

  #laboratoryRequestCaseForAction(
    context: ActorContext,
    encounterId: string,
    action: 'edit-draft' | 'issue',
  ) {
    const admission = assertInpatientRequestScope(this.#context.database,context,encounterId,['inpatient-doctor'])
    if (admission !== undefined) {
      if (admission.status !== 'admitted' || admission.source_case_id === null) throw new WorkflowError('LABORATORY_GENERATION_UNSUPPORTED','本次住院缺少可用合成病例来源或不在院')
      return {case_id:admission.admission_id,patient_id:admission.patient_id,status:'admitted'}
    }
    this.#context.assertRole(context, ['outpatient-doctor'])
    const outpatientCase = this.#context.caseByEncounter(context, encounterId)
    this.#context.assertCaseResponsibility(context, outpatientCase.case_id)
    if (outpatientCase.status !== 'first-visit'
      || !this.#context.hasConsultation(context, outpatientCase.case_id)) {
      const message = action === 'issue'
        ? 'The Encounter cannot issue a laboratory request'
        : 'The Encounter cannot edit a laboratory request draft'
      throw new WorkflowError('WORKFLOW_CONFLICT', message)
    }
    return outpatientCase
  }

  #laboratoryRequestState(context: ActorContext, caseId: string) {
    return laboratoryRequestStateRowSchema.optional().parse(
      this.#context.database.driver.prepare(`
        SELECT version, draft_catalog_item_id, draft_indication_code,
          draft_reference_json, draft_service_snapshot_json, draft_price_json
        FROM laboratory_request_state
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, caseId),
    )
  }

  #laboratoryRequestDraftConflictStatus(
    context: ActorContext,
    encounterId: string,
  ): NonNullable<ApiConflict['currentStatus']> {
    const outpatientCase = this.#context.caseByEncounter(context, encounterId)
    const state = this.#laboratoryRequestState(context, outpatientCase.case_id)
    if (state === undefined) return 'missing'
    return state.draft_catalog_item_id === null ? 'empty' : 'draft'
  }

  #laboratoryReportConflictStatus(
    context: ActorContext,
    requestId: string,
    diagnosticReportId: string,
  ): NonNullable<ApiConflict['currentStatus']> {
    const request = this.#laboratoryRequest(context, requestId)
    if (request === undefined) return 'missing'
    if (request.diagnostic_report_id !== diagnosticReportId) return 'superseded'
    return request.status
  }

  inpatientLaboratoryRequests(context: ActorContext, admissionId: string) {
    if (assertInpatientRequestScope(this.#context.database,context,admissionId) === undefined) throw new WorkflowError('WORKFLOW_CONFLICT','未找到本次住院')
    return this.laboratoryRequests(context,admissionId)
  }

  laboratoryRequests(context: ActorContext, caseId: string) {
    const requests = z.array(laboratoryRequestRowSchema).parse(
      this.#context.database.driver.prepare(`
        SELECT request_id, catalog_item_id, indication_code, service_request_id,
          execution_task_id, diagnostic_report_id, reference_json,
          service_snapshot_json,
          result_snapshot_id, generation_error_code, generation_error_message,
          status, version
        FROM laboratory_request
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND request_kind = 'laboratory'
        ORDER BY julianday(authored_at), request_id
      `).all(context.workspaceId, context.epoch, caseId),
    ).map((request) => {
      const serviceRequest = this.#context.fhir.read(
        context,
        'ServiceRequest',
        request.service_request_id,
      )
      const task = this.#context.fhir.read(context, 'Task', request.execution_task_id)
      const reportVersions = request.diagnostic_report_id === null
        ? []
        : this.#laboratoryReportVersions(
            context,
            request.request_id,
            request.diagnostic_report_id,
            request.service_request_id,
          )
      return {
        catalogItemId: request.catalog_item_id,
        authoredAt: serviceRequest.authoredOn,
        billing: this.#context.outpatientBilling.read(context, request.request_id),
        id: request.request_id,
        indicationCode: request.indication_code,
        ...(request.generation_error_code === null || request.generation_error_message === null
          ? {}
          : {
              generationError: {
                code: request.generation_error_code,
                message: request.generation_error_message,
              },
            }),
        previousReports: reportVersions.slice(0, -1),
        ...(request.service_snapshot_json === null
          ? {}
          : {
              laboratoryService: laboratoryServiceSnapshotSchema.parse(
                JSON.parse(request.service_snapshot_json),
              ),
            }),
        referenceConcept: referenceConceptSnapshotSchema.parse(JSON.parse(request.reference_json)),
        ...(reportVersions.length === 0 ? {} : { report: reportVersions.at(-1) }),
        serviceRequestId: request.service_request_id,
        serviceRequestVersion: serviceRequest.meta?.versionId ?? '1',
        status: request.status,
        taskId: request.execution_task_id,
        taskVersion: task.meta?.versionId ?? '1',
        version: request.version,
      }
    })
    return z.array(laboratoryRequestSchema).parse(requests)
  }

  completedCaseLaboratoryRequests(context: ActorContext, caseId: string) {
    const independentRequests = this.laboratoryRequests(context, caseId)
    if (independentRequests.length > 0) {
      return independentRequests.map(request => ({
        ...request,
        correctionSupported: true,
      }))
    }
    const row = legacyCompletedCaseLaboratoryRowSchema.optional().parse(
      this.#context.database.driver.prepare(`
        SELECT service_request_id, laboratory_task_id, diagnostic_report_id
        FROM outpatient_case
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, caseId),
    )
    if (
      row?.service_request_id === null
      || row?.diagnostic_report_id === null
      || row === undefined
    ) return []
    const serviceRequestResource = this.#context.fhir.read(
      context,
      'ServiceRequest',
      row.service_request_id,
    )
    const serviceRequest = completedCaseServiceRequestSchema.parse(serviceRequestResource)
    const task = row.laboratory_task_id === null
      ? undefined
      : this.#context.fhir.read(context, 'Task', row.laboratory_task_id)
    const reportResource = this.#context.fhir.read(context, 'DiagnosticReport', row.diagnostic_report_id)
    const report = completedCaseDiagnosticReportSchema.parse(reportResource)
    const specimenReference = report.specimen[0]?.reference
    if (specimenReference === undefined || !specimenReference.startsWith('Specimen/')) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The completed laboratory report specimen is invalid')
    }
    const results = report.result.map((reference) => {
      if (!reference.reference.startsWith('Observation/')) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The completed laboratory result is invalid')
      }
      const observationId = reference.reference.slice('Observation/'.length)
      const rawObservation = this.#context.fhir.read(context, 'Observation', observationId)
      const observation = completedCaseObservationSchema.parse(rawObservation)
      const coding = observation.code.coding[0]
      const codeableValue = observation.valueCodeableConcept?.coding[0]
      const value = observation.valueBoolean
        ?? observation.valueQuantity?.value
        ?? observation.valueString
        ?? codeableValue
      if (coding === undefined || value === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The completed laboratory result is incomplete')
      }
      const critical = typeof value === 'number' ? observationCriticalFlag(rawObservation) : undefined
      const referenceRange = observation.referenceRange?.[0]
      const unit = observation.valueQuantity?.unit
      return {
        code: coding.code,
        ...(critical === undefined ? {} : { critical }),
        display: coding.display ?? coding.code,
        ...(completedCaseInterpretation(observation.interpretation?.[0]?.coding[0]?.code) === undefined
          ? {}
          : {
              interpretation: completedCaseInterpretation(
                observation.interpretation?.[0]?.coding[0]?.code,
              ),
            }),
        observationId,
        ...(referenceRange?.text === undefined ? {} : { referenceRange }),
        ...(unit === undefined
          ? {}
          : {
              unit: {
                ...(observation.valueQuantity?.code === undefined
                  ? {}
                  : { code: observation.valueQuantity.code }),
                display: unit,
                ...(observation.valueQuantity?.system === undefined
                  ? {}
                  : { system: observation.valueQuantity.system }),
              },
            }),
        value,
      }
    })
    const catalog = z.object({ item_id: z.string().min(1) }).strict().optional().parse(
      this.#context.database.driver.prepare(`
        SELECT item_id FROM outpatient_catalog
        WHERE workspace_id = ? AND epoch = ? AND kind = 'laboratory'
          AND (name_zh = ? OR name_en = ?)
        ORDER BY item_id
        LIMIT 1
      `).get(
        context.workspaceId,
        context.epoch,
        serviceRequest.code.concept.text,
        serviceRequest.code.concept.text,
      ),
    )
    return [{
      catalogDisplay: serviceRequest.code.concept.text,
      ...(catalog === undefined ? {} : { catalogItemId: catalog.item_id }),
      correctionSupported: false,
      id: `legacy-${row.service_request_id}`,
      indicationCode: serviceRequest.reason[0]?.concept.coding[0]?.code ?? 'legacy-indication',
      previousReports: [],
      report: {
        conclusion: report.conclusion,
        diagnosticReportId: row.diagnostic_report_id,
        diagnosticReportVersion: report.meta.versionId,
        issuedAt: report.issued,
        revisionNumber: 1,
        results,
        specimenId: specimenReference.slice('Specimen/'.length),
        status: report.status,
      },
      serviceRequestId: row.service_request_id,
      serviceRequestVersion: serviceRequest.meta.versionId,
      status: 'reported' as const,
      ...(row.laboratory_task_id === null
        ? {}
        : {
            taskId: row.laboratory_task_id,
            taskVersion: task?.meta?.versionId ?? '1',
          }),
      version: 1,
    }]
  }

  #supportsLaboratoryReports(context: ActorContext, outpatientCaseId: string): boolean {
    if (inpatientRequestOwner(this.#context.database,context,outpatientCaseId) !== undefined) return this.#context.database.driver.prepare('SELECT 1 FROM clinical_request_source WHERE workspace_id=? AND epoch=? AND case_id=? AND synthetic_case_id IS NOT NULL').get(context.workspaceId,context.epoch,outpatientCaseId) !== undefined
    return this.#context.database.driver.prepare(`
      SELECT 1 AS present FROM clinical_request_source
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND synthetic_case_id IS NOT NULL
    `).get(context.workspaceId, context.epoch, outpatientCaseId) !== undefined
      || this.#context.database.driver.prepare(`
      SELECT 1 AS present FROM scenario_hidden_fact
      WHERE workspace_id = ? AND epoch = ? AND fact_code = 'laboratory-results'
    `).get(context.workspaceId, context.epoch) !== undefined
  }

  #assertLaboratoryServiceGenerationSupported(
    context: ActorContext,
    outpatientCaseId: string,
  ): void {
    const materialized = this.#context.database.driver.prepare(`
      SELECT 1 AS present FROM clinical_request_source
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND synthetic_case_id IS NOT NULL
    `).get(context.workspaceId, context.epoch, outpatientCaseId) !== undefined
    if (materialized) return
    throw new WorkflowError(
      'LABORATORY_GENERATION_UNSUPPORTED',
      'The case has no synthetic case materialization to generate this laboratory service from',
    )
  }

  #assertAdultLaboratoryServiceApplicable(
    context: ActorContext,
    patientId: string,
    service: z.infer<typeof laboratoryServiceSnapshotSchema>,
    authoredAt: string,
  ): void {
    if (service.sourceDataset?.datasetId !== 'laboratory-cn') return
    const patient = z.object({
      birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      gender: z.enum(['female', 'male', 'other', 'unknown']),
    }).passthrough().parse(this.#context.fhir.read(context, 'Patient', patientId))
    try {
      assertAdultReferenceServiceApplicable(service, patient, authoredAt)
    } catch (error) {
      if (!(error instanceof AdultReferenceApplicabilityError)) throw error
      throw new WorkflowError('LABORATORY_ADULT_REFERENCE_NOT_APPLICABLE', error.message)
    }
  }

  #assertInvestigationGenerationSupported(
    context: ActorContext,
    outpatientCaseId: string,
    catalogItemId: string,
    concept: z.infer<typeof referenceConceptSnapshotSchema>,
  ): void {
    const materialized = this.#context.database.driver.prepare(`
      SELECT 1 AS present FROM clinical_request_source
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND synthetic_case_id IS NOT NULL
    `).get(context.workspaceId, context.epoch, outpatientCaseId) !== undefined
    const referenceItem = this.#context.referenceData?.laboratoryById(context, catalogItemId)
    const supported = !materialized && referenceItem === undefined
      ? this.#legacyLaboratoryResultFact(context, catalogItemId) !== undefined
      : this.#context.investigation?.generationCapabilityForCase(
          context.workspaceId,
          context.epoch,
          outpatientCaseId,
          concept,
        ).supported === true
    if (supported) return
    throw new WorkflowError(
      materialized ? 'CATALOG_CONFLICT' : 'LABORATORY_GENERATION_UNSUPPORTED',
      'The investigation cannot generate a result for this case and catalog item',
    )
  }

  #legacyLaboratoryResultFact(
    context: ActorContext,
    catalogItemId: string,
  ) {
    const hiddenFact = hiddenFactValueRowSchema.optional().parse(
      this.#context.database.driver.prepare(`
        SELECT value_json FROM scenario_hidden_fact
        WHERE workspace_id = ? AND epoch = ? AND fact_code = 'laboratory-results'
      `).get(context.workspaceId, context.epoch),
    )
    if (hiddenFact === undefined) return undefined
    const facts = laboratoryResultsFactSchema.parse(JSON.parse(hiddenFact.value_json))
    if (catalogItemId === 'lab-cbc' || catalogItemId === 'lab-crp') return facts[catalogItemId]
    return undefined
  }

  #laboratoryReportVersions(
    context: ActorContext,
    requestId: string,
    diagnosticReportId: string,
    serviceRequestId: string,
  ) {
    const chain: Array<{
      diagnosticReportId: string
      revision?: z.infer<typeof laboratoryReportRevisionRowSchema>
    }> = []
    const seen = new Set<string>()
    let currentId: string | undefined = diagnosticReportId
    while (currentId !== undefined) {
      if (seen.has(currentId)) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory report revision chain is cyclic')
      }
      seen.add(currentId)
      const revision = laboratoryReportRevisionRowSchema.optional().parse(
        this.#context.database.driver.prepare(`
          SELECT diagnostic_report_id, provenance_id, reason, request_id,
            revision_of_diagnostic_report_id
          FROM laboratory_report_revision
          WHERE workspace_id = ? AND epoch = ? AND diagnostic_report_id = ?
        `).get(context.workspaceId, context.epoch, currentId),
      )
      if (revision !== undefined && revision.request_id !== requestId) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The laboratory report revision does not belong to its request',
        )
      }
      chain.push({ diagnosticReportId: currentId, ...(revision === undefined ? {} : { revision }) })
      currentId = revision?.revision_of_diagnostic_report_id
    }
    return chain.reverse().map((entry, index) => this.#laboratoryReport(
      context,
      requestId,
      entry.diagnosticReportId,
      serviceRequestId,
      {
        revisionNumber: index + 1,
        ...(entry.revision === undefined ? {} : {
          revisionOfDiagnosticReportId: entry.revision.revision_of_diagnostic_report_id,
          revisionReason: entry.revision.reason,
        }),
      },
    ))
  }

  #laboratoryReport(
    context: ActorContext,
    requestId: string,
    diagnosticReportId: string,
    serviceRequestId: string,
    revision: {
      revisionNumber: number
      revisionOfDiagnosticReportId?: string
      revisionReason?: string
    } = { revisionNumber: 1 },
  ) {
    const reportResource = this.#context.fhir.read(context, 'DiagnosticReport', diagnosticReportId)
    const report = laboratoryDiagnosticReportContentSchema.parse(reportResource)
    const serviceRequestReference = `ServiceRequest/${serviceRequestId}`
    if (!report.basedOn.some(reference => reference.reference === serviceRequestReference)) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        'The laboratory report does not reference its request',
      )
    }
    const specimenReference = report.specimen[0]?.reference
    if (specimenReference === undefined || !specimenReference.startsWith('Specimen/')) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory report specimen is invalid')
    }
    const specimenId = specimenReference.slice('Specimen/'.length)
    const acknowledgement = reportAcknowledgementRowSchema.optional().parse(
      this.#context.database.driver.prepare(`
        SELECT acknowledgement_id, acknowledged_at, acknowledged_by,
          diagnostic_report_id, request_id, request_version
        FROM laboratory_report_acknowledgement
        WHERE workspace_id = ? AND epoch = ? AND diagnostic_report_id = ?
      `).get(context.workspaceId, context.epoch, diagnosticReportId),
    )
    if (acknowledgement !== undefined && acknowledgement.request_id !== requestId) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        'The laboratory report acknowledgement does not belong to its request',
      )
    }
    return laboratoryReportSchema.parse({
      ...(acknowledgement === undefined ? {} : {
        acknowledgement: {
          acknowledgedAt: acknowledgement.acknowledged_at,
          acknowledgedBy: acknowledgement.acknowledged_by,
          id: acknowledgement.acknowledgement_id,
        },
      }),
      conclusion: report.conclusion,
      diagnosticReportId,
      diagnosticReportVersion: reportResource.meta?.versionId ?? '1',
      issuedAt: report.issued,
      ...revision,
      results: report.result.map((resultReference) => {
        if (!resultReference.reference.startsWith('Observation/')) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory report result is invalid')
        }
        const observationId = resultReference.reference.slice('Observation/'.length)
        const rawObservation = this.#context.fhir.read(context, 'Observation', observationId)
        const observation = laboratoryObservationContentSchema.parse(rawObservation)
        if (!observation.basedOn.some(reference => (
          reference.reference === serviceRequestReference
        )) || observation.specimen.reference !== specimenReference) {
          throw new WorkflowError(
            'WORKFLOW_CONFLICT',
            'The laboratory result does not reference its request and specimen',
          )
        }
        const coding = observation.code.coding[0]
        const interpretationCode = observation.interpretation[0]?.coding[0]?.code
        const referenceRange = observation.referenceRange[0]
        if (coding === undefined || interpretationCode === undefined || referenceRange === undefined) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory result is incomplete')
        }
        const critical = observationCriticalFlag(rawObservation)
        const base = {
          code: coding.code,
          display: coding.display,
          interpretation: interpretationCode === 'N'
            ? 'normal' as const
            : interpretationCode === 'H'
              ? 'high' as const
              : interpretationCode === 'L' ? 'low' as const : 'abnormal' as const,
          observationId,
        }
        if (observation.valueQuantity !== undefined) {
          if (referenceRange.high === undefined && referenceRange.low === undefined) {
            throw new WorkflowError('WORKFLOW_CONFLICT', 'The quantitative laboratory result is incomplete')
          }
          return {
            ...base,
            ...(critical === undefined ? {} : { critical }),
            referenceRange: {
              ...(referenceRange.high === undefined ? {} : { high: referenceRange.high.value }),
              ...(referenceRange.low === undefined ? {} : { low: referenceRange.low.value }),
              text: referenceRange.text,
            },
            unit: {
              code: observation.valueQuantity.code,
              display: observation.valueQuantity.unit,
              system: observation.valueQuantity.system,
            },
            value: observation.valueQuantity.value,
          }
        }
        const qualitativeValue = observation.valueBoolean
          ?? observation.valueString
          ?? observation.valueCodeableConcept?.coding[0]
        if (qualitativeValue === undefined) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The qualitative laboratory result is incomplete')
        }
        return {
          ...base,
          referenceRange: {
            text: referenceRange.text,
          },
          value: qualitativeValue,
        }
      }),
      specimenId,
      status: report.status,
    })
  }

  #laboratoryRequest(context: ActorContext, requestId: string) {
    return laboratoryRequestCommandRowSchema.optional().parse(
      this.#context.database.driver.prepare(`
        SELECT laboratory_request.request_id, laboratory_request.case_id,
          laboratory_request.catalog_item_id, laboratory_request.indication_code,
          laboratory_request.reference_json, laboratory_request.service_snapshot_json,
          laboratory_request.result_snapshot_id,
          laboratory_request.generation_error_code,
          laboratory_request.generation_error_message,
          laboratory_request.service_request_id, laboratory_request.execution_task_id,
          laboratory_request.diagnostic_report_id, laboratory_request.status,
          laboratory_request.version, laboratory_request.authored_by,
          clinical_request_context.patient_id, clinical_request_context.encounter_id
        FROM laboratory_request
        JOIN clinical_request_context
          ON clinical_request_context.workspace_id = laboratory_request.workspace_id
         AND clinical_request_context.epoch = laboratory_request.epoch
         AND clinical_request_context.case_id = laboratory_request.case_id
        WHERE laboratory_request.workspace_id = ? AND laboratory_request.epoch = ?
          AND laboratory_request.request_id = ? AND laboratory_request.request_kind = 'laboratory'
      `).get(context.workspaceId, context.epoch, requestId),
    )
  }

  #resolvedLaboratorySelection(
    context: ActorContext,
    itemId: string,
  ) {
    const row = z.object({
      code: z.string(),
      config_json: z.string(),
      name_en: z.string(),
      name_zh: z.string(),
      service_id: z.string(),
      version: z.number().int().positive(),
    }).optional().parse(this.#context.database.driver.prepare(`
      SELECT service_id, code, name_zh, name_en, version, config_json
      FROM hospital_service_catalog
      WHERE workspace_id = ? AND epoch = ? AND service_id = ? AND active = 1
        AND json_extract(config_json, '$.laboratoryService.doctorOrderable') = 1
    `).get(context.workspaceId, context.epoch, itemId))
    if (row === undefined) {
      const catalog = this.#context.catalogItem(context, itemId, 'laboratory')
      const config = laboratoryCatalogConfigSchema.parse(
        JSON.parse(catalog.config_json ?? '{}') as unknown,
      )
      const referenceConcept = config.referenceConcept ?? referenceConceptSnapshotSchema.parse({
        code: catalog.code,
        display: catalog.name_zh,
        id: catalog.item_id,
        sourceLocator: 'operational:outpatient_catalog',
        system: 'urn:clinmesh:operational:laboratory',
        version: String(catalog.version),
      })
      return { catalog, config, laboratoryService: undefined, referenceConcept }
    }
    const laboratoryService = laboratoryServiceConfigSchema.parse(
      JSON.parse(row.config_json),
    ).laboratoryService
    if (laboratoryService.id !== row.service_id || laboratoryService.version !== row.version) {
      throw new WorkflowError('CATALOG_CONFLICT', 'The Laboratory Service snapshot is inconsistent')
    }
    const catalog = {
      code: row.code,
      item_id: row.service_id,
      name_en: row.name_en,
      name_zh: row.name_zh,
      price_fen: laboratoryService.priceFen,
      version: row.version,
    }
    const config = laboratoryCatalogConfigSchema.parse({
      allowedIndicationCodes: laboratoryService.allowedIndicationCodes,
      contraindicatedAllergyCodes: [],
      referenceConcept: laboratoryService.referenceConcept,
    })
    return {
      catalog,
      config,
      laboratoryService,
      referenceConcept: laboratoryService.referenceConcept,
    }
  }

  #laboratorySelectionFromSnapshot(
    context: ActorContext,
    itemId: string,
    referenceConcept: z.infer<typeof referenceConceptSnapshotSchema>,
    indicationCode: string,
    laboratoryService?: z.infer<typeof laboratoryServiceSnapshotSchema>,
  ) {
    if (laboratoryService !== undefined) {
      const current = this.#resolvedLaboratorySelection(context, itemId)
      if (current.laboratoryService === undefined
        || current.laboratoryService.version !== laboratoryService.version
        || JSON.stringify(current.laboratoryService) !== JSON.stringify(laboratoryService)) {
        throw new WorkflowError(
          'CATALOG_CONFLICT',
          'The Laboratory Service changed after the draft was saved',
        )
      }
      return current
    }
    const local = this.#context.database.driver.prepare(`
      SELECT item_id, code, name_zh, name_en, price_fen, version, config_json
      FROM outpatient_catalog
      WHERE workspace_id = ? AND epoch = ? AND item_id = ?
        AND kind = 'laboratory' AND active = 1
    `).get(context.workspaceId, context.epoch, itemId) as CatalogRow | undefined
    if (local !== undefined) {
      return {
        catalog: local,
        config: laboratoryCatalogConfigSchema.parse(JSON.parse(local.config_json ?? '{}')),
      }
    }
    return {
      catalog: {
        code: referenceConcept.code,
        item_id: itemId,
        name_en: referenceConcept.display,
        name_zh: referenceConcept.display,
        price_fen: 0,
        version: 1,
      },
      config: laboratoryCatalogConfigSchema.parse({
        allowedIndicationCodes: [indicationCode],
        contraindicatedAllergyCodes: [],
        referenceConcept,
      }),
    }
  }
}
