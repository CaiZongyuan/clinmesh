import { z } from 'zod'
import { fhirResourceSchema } from './fhir.ts'

export const roleCodeSchema = z.enum([
  'administrator',
  'cashier',
  'outpatient-doctor',
  'pharmacist',
  'registrar',
  'triage-nurse',
])

export const apiConflictSchema = z.object({
  currentStatus: z.enum([
    'accepted',
    'acknowledged',
    'cancelled',
    'closed',
    'dispensed',
    'dispensing-started',
    'draft',
    'empty',
    'in-progress',
    'issued',
    'missing',
    'paid',
    'reported',
    'signed',
    'superseded',
    'withdrawn',
  ]).optional(),
  currentVersion: z.string().regex(/^\d+$/).optional(),
  expectedVersion: z.string().regex(/^\d+$/).optional(),
  owner: z.enum([
    'clinical-document',
    'laboratory-report',
    'laboratory-request',
    'laboratory-request-draft',
    'prescription',
    'prescription-draft',
  ]),
  resource: z.string().regex(/^[A-Z][A-Za-z]+\/[A-Za-z0-9.-]{1,128}$/),
}).strict()

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    conflict: apiConflictSchema.optional(),
    message: z.string().min(1),
  }),
})

const fhirExpectedVersionsSchema = z.record(
  z.string().regex(/^[A-Z][A-Za-z]+\/[A-Za-z0-9.-]{1,64}$/),
  z.string().regex(/^\d+$/),
)

export const patientSummarySchema = z.object({
  birthDate: z.string().optional(),
  gender: z.string().optional(),
  id: z.string().min(1),
  identifier: z.string(),
  name: z.string(),
  synthetic: z.literal(true),
  versionId: z.string().regex(/^\d+$/),
})

export const clinicalPresentationSchema = z.object({
  chiefComplaint: z.string().min(1),
  summary: z.string().min(1),
  vitalSigns: z.object({
    bloodPressure: z.object({
      diastolicMmHg: z.number().positive(),
      systolicMmHg: z.number().positive(),
    }).strict(),
    oxygenSaturationPct: z.number().min(0).max(100),
    pulseBpm: z.number().positive(),
    respirationBpm: z.number().positive(),
    temperatureC: z.number(),
  }).strict(),
}).strict()

const paginationShape = {
  page: z.number().int().positive(),
  pageSize: z.number().int().positive().max(100),
  total: z.number().int().nonnegative(),
}

export const virtualPatientListSchema = z.object({
  items: z.array(z.object({
    birthDate: z.iso.date(),
    gender: z.enum(['female', 'male', 'other', 'unknown']),
    id: z.string().min(1),
    name: z.string().min(1),
    presentation: clinicalPresentationSchema,
    version: z.string().min(32).max(2_048),
  }).strict()),
  ...paginationShape,
}).strict()

export const sessionContextSchema = z.object({
  actor: z.object({
    actorId: z.string().min(1),
    epoch: z.string().min(1),
    locationId: z.string().min(1).optional(),
    organizationId: z.string().min(1).optional(),
    practitionerId: z.string().min(1).optional(),
    practitionerRoleId: z.string().min(1).optional(),
    roleCode: roleCodeSchema,
    scenarioRunId: z.string().min(1),
    workspaceId: z.string().min(1),
  }),
  availableRoles: z.array(z.object({
    code: roleCodeSchema,
    id: z.string().min(1),
    locationId: z.string().min(1),
    organizationId: z.string().min(1),
    practitionerId: z.string().min(1),
    practitionerName: z.string().min(1),
  })),
  user: z.object({
    email: z.email(),
    id: z.string().min(1),
    name: z.string().min(1),
  }),
})

export const scenarioStateSchema = z.object({
  clinicalReview: z.record(z.string(), z.unknown()).nullable(),
  epoch: z.string().min(1),
  initialStateHash: z.string().min(1),
  kind: z.enum(['candidate', 'density', 'golden']),
  scenarioId: z.string().min(1),
  scenarioRunId: z.string().min(1),
  seed: z.number().int(),
  status: z.enum(['active', 'closed', 'completed']),
  virtualTime: z.string().min(1),
  workspaceId: z.string().min(1),
})

const commandEffectSchema = z.object({
  kind: z.enum(['created', 'updated']),
  reference: z.string().min(1),
  versionId: z.string().min(1),
})

export function commandResponseSchema<Schema extends z.ZodType>(data: Schema) {
  return z.object({
    auditId: z.string().min(1),
    data,
    effects: z.array(commandEffectSchema),
    requestId: z.string().min(1),
    warnings: z.array(z.string()),
  })
}

export const scenarioCommandResponseSchema = commandResponseSchema(scenarioStateSchema)

export const startVirtualPatientResponseSchema = commandResponseSchema(z.object({
  caseId: z.string().min(1),
  encounterId: z.string().min(1),
  patientId: z.string().min(1),
  queueTaskId: z.string().min(1),
  registrationId: z.string().min(1),
  status: z.literal('first-visit'),
  virtualPatientId: z.string().min(1),
}))

const catalogItemSchema = z.object({
  id: z.string().min(1),
  nameEn: z.string().min(1),
  nameZh: z.string().min(1),
  priceFen: z.number().int().nonnegative().optional(),
  version: z.number().int().positive(),
})

const clinicalCatalogBaseShape = {
  diagnoses: z.array(catalogItemSchema.extend({
    code: z.string().min(1),
    system: z.url(),
  })).default([]),
  laboratory: z.array(catalogItemSchema.extend({
    allowedIndicationCodes: z.array(z.string().min(1)).min(1),
    contraindicatedAllergyCodes: z.array(z.string().min(1)),
  })),
}

const legacyMedicationCatalogItemSchema = catalogItemSchema.extend({
  allowedCombinationIds: z.array(z.string().min(1)),
  allowedDoseTexts: z.array(z.string().min(1)).min(1),
  allowedFrequencyCodes: z.array(z.string().min(1)).min(1),
  defaultDoseText: z.string().min(1),
  defaultFrequencyCode: z.string().min(1),
}).strict()

const prescriptionMedicationCatalogItemSchema = legacyMedicationCatalogItemSchema.extend({
  allowedCourseDays: z.array(z.number().int().positive()).min(1),
  allowedQuantities: z.array(z.number().int().positive()).min(1),
  defaultCourseDays: z.number().int().positive(),
  defaultQuantity: z.number().int().positive(),
}).strict()

export const clinicalCatalogSchema = z.discriminatedUnion('prescriptionConclusionSupported', [
  z.object({
    ...clinicalCatalogBaseShape,
    medications: z.array(legacyMedicationCatalogItemSchema),
    prescriptionConclusionSupported: z.literal(false),
  }),
  z.object({
    ...clinicalCatalogBaseShape,
    medications: z.array(prescriptionMedicationCatalogItemSchema),
    prescriptionConclusionSupported: z.literal(true),
  }),
])

export const diagnosisRoleSchema = z.enum(['primary', 'secondary'])

export const diagnosisDraftEntrySchema = z.object({
  catalogItemId: z.string().min(1),
  note: z.string().trim().min(1).max(500).optional(),
  role: diagnosisRoleSchema,
}).strict()

export const diagnosisDraftContentSchema = z.object({
  entries: z.array(diagnosisDraftEntrySchema).min(1).max(8),
}).strict()

export const saveDiagnosisDraftRequestSchema = z.object({
  expectedVersions: fhirExpectedVersionsSchema,
  input: diagnosisDraftContentSchema.extend({
    expectedDraftVersion: z.number().int().nonnegative(),
  }),
}).strict()

export const diagnosisDraftResponseSchema = commandResponseSchema(z.object({
  draftVersion: z.number().int().positive(),
}).strict())

export const confirmDiagnosisRequestSchema = z.object({
  expectedVersions: fhirExpectedVersionsSchema,
  input: z.object({
    expectedDraftVersion: z.number().int().positive(),
  }).strict(),
}).strict()

export const diagnosisConfirmationEntrySchema = diagnosisDraftEntrySchema.extend({
  code: z.string().min(1),
  conditionId: z.string().min(1),
  conditionVersion: z.string().regex(/^\d+$/),
  display: z.string().min(1),
  system: z.url(),
}).strict()

export const diagnosisConfirmationSchema = z.object({
  confirmedAt: z.iso.datetime({ offset: true }),
  entries: z.array(diagnosisConfirmationEntrySchema).min(1).max(8),
  id: z.string().min(1),
  provenanceId: z.string().min(1),
}).strict()

export const confirmDiagnosisResponseSchema = commandResponseSchema(z.object({
  confirmation: diagnosisConfirmationSchema,
  diagnosisVersion: z.number().int().positive(),
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
}).strict())

export const diagnosisStateSchema = z.object({
  confirmation: diagnosisConfirmationSchema.optional(),
  draft: diagnosisDraftContentSchema.optional(),
  draftVersion: z.number().int().positive(),
}).strict()

export const prescriptionDraftItemSchema = z.object({
  catalogItemId: z.string().min(1),
  courseDays: z.number().int().min(1).max(30),
  doseText: z.string().trim().min(1).max(120),
  frequencyCode: z.string().trim().min(1).max(32),
  quantity: z.number().int().min(1).max(1_000),
}).strict()

export const prescriptionDraftContentSchema = z.object({
  items: z.array(prescriptionDraftItemSchema).min(1).max(8),
}).strict()

export const savePrescriptionDraftRequestSchema = z.object({
  expectedVersions: fhirExpectedVersionsSchema,
  input: prescriptionDraftContentSchema.extend({
    expectedDraftVersion: z.number().int().nonnegative(),
  }),
}).strict()

export const deletePrescriptionDraftRequestSchema = z.object({
  expectedVersions: fhirExpectedVersionsSchema,
  input: z.object({
    expectedDraftVersion: z.number().int().positive(),
  }).strict(),
}).strict()

export const prescriptionDraftResponseSchema = commandResponseSchema(z.object({
  draftVersion: z.number().int().positive(),
}).strict())

export const issuedPrescriptionItemSchema = prescriptionDraftItemSchema.extend({
  display: z.string().min(1),
  medicationRequestId: z.string().min(1),
  medicationRequestVersion: z.string().regex(/^\d+$/),
}).strict()

export const prescriptionWithdrawalSchema = z.object({
  id: z.string().min(1),
  prescriptionId: z.string().min(1),
  version: z.number().int().positive(),
  withdrawnAt: z.iso.datetime({ offset: true }),
  withdrawnByActorId: z.string().min(1),
  withdrawnByPractitionerRoleId: z.string().min(1),
}).strict()

export const issuedPrescriptionSchema = z.object({
  authoredAt: z.iso.datetime({ offset: true }),
  authoredByPractitionerRoleId: z.string().min(1),
  id: z.string().min(1),
  items: z.array(issuedPrescriptionItemSchema).min(1).max(8),
  number: z.string().min(1),
  status: z.enum(['dispensed', 'paid', 'signed', 'withdrawn']),
  version: z.number().int().positive(),
  withdrawal: prescriptionWithdrawalSchema.optional(),
}).strict()

const completedCasePrescriptionSchema = issuedPrescriptionSchema.extend({
  withdrawalSupported: z.boolean().default(false),
}).strict()

export const issuePrescriptionRequestSchema = z.object({
  expectedVersions: fhirExpectedVersionsSchema,
  input: z.object({
    expectedDraftVersion: z.number().int().positive(),
  }).strict(),
}).strict()

export const issuePrescriptionResponseSchema = commandResponseSchema(z.object({
  draftVersion: z.number().int().positive(),
  prescription: issuedPrescriptionSchema,
}).strict())

export const noMedicationConclusionSchema = z.object({
  authoredAt: z.iso.datetime({ offset: true }),
  authoredByActorId: z.string().min(1),
  authoredByPractitionerRoleId: z.string().min(1),
  id: z.string().min(1),
  version: z.number().int().positive(),
}).strict()

export const confirmNoMedicationRequestSchema = z.object({
  expectedVersions: fhirExpectedVersionsSchema,
  input: z.object({
    expectedDraftVersion: z.number().int().nonnegative(),
  }).strict(),
}).strict()

export const confirmNoMedicationResponseSchema = commandResponseSchema(z.object({
  draftVersion: z.number().int().positive(),
  noMedication: noMedicationConclusionSchema,
}).strict())

export const withdrawPrescriptionRequestSchema = z.object({
  expectedVersions: fhirExpectedVersionsSchema,
  input: z.object({
    expectedPrescriptionVersion: z.number().int().positive(),
  }).strict(),
}).strict()

export const withdrawPrescriptionResponseSchema = commandResponseSchema(z.object({
  medicationRequests: z.array(z.object({
    id: z.string().min(1),
    version: z.string().regex(/^\d+$/),
  }).strict()).min(1),
  prescriptionId: z.string().min(1),
  prescriptionVersion: z.number().int().positive(),
  status: z.literal('withdrawn'),
  withdrawal: prescriptionWithdrawalSchema,
}).strict())

export const medicationConclusionStateSchema = z.object({
  draft: prescriptionDraftContentSchema.optional(),
  draftVersion: z.number().int().positive(),
  noMedication: noMedicationConclusionSchema.optional(),
  prescription: issuedPrescriptionSchema.optional(),
}).strict()

export const registrationCatalogSchema = z.object({
  departments: z.array(catalogItemSchema),
  locations: z.array(catalogItemSchema),
  virtualDate: z.iso.date(),
  visitTypes: z.array(catalogItemSchema),
})

export const patientSearchSchema = z.object({
  items: z.array(patientSummarySchema),
  ...paginationShape,
})

export const createPatientResponseSchema = commandResponseSchema(z.object({
  patient: patientSummarySchema,
}))

export const registrationResponseSchema = commandResponseSchema(z.object({
  accountId: z.string().min(1),
  chargeItemId: z.string().min(1),
  encounterId: z.string().min(1),
  patientId: z.string().min(1),
  queueTaskId: z.string().min(1),
  registrationId: z.string().min(1),
  status: z.literal('awaiting-triage'),
  totalFen: z.number().int().nonnegative(),
}))

export const registrationStatusSchema = z.enum([
  'registered',
  'triaged',
  'in-progress',
  'completed',
  'cancelled',
])

export const registrationQueueSchema = z.object({
  items: z.array(z.object({
    arrivedAt: z.string().min(1),
    caseId: z.string().min(1),
    encounterId: z.string().min(1),
    encounterVersion: z.string().regex(/^\d+$/),
    patient: patientSummarySchema,
    registrationId: z.string().min(1),
    registrationNumber: z.string().min(1),
    registrationStatus: registrationStatusSchema,
    status: z.string().min(1),
    taskId: z.string().min(1),
    taskVersion: z.string().regex(/^\d+$/),
  })),
  ...paginationShape,
})

export const triageQueueSchema = z.object({
  items: z.array(z.object({
    arrivedAt: z.string().min(1),
    caseId: z.string().min(1),
    department: z.object({
      id: z.string().min(1),
      nameEn: z.string().min(1),
      nameZh: z.string().min(1),
    }),
    encounterId: z.string().min(1),
    encounterVersion: z.string().regex(/^\d+$/),
    location: z.object({
      id: z.string().min(1),
      nameEn: z.string().min(1),
      nameZh: z.string().min(1),
    }),
    patient: patientSummarySchema,
    registrationNumber: z.string().min(1),
    riskFlags: z.array(z.object({
      code: z.string().min(1),
      display: z.string().min(1),
    })),
    status: z.string().min(1),
    taskId: z.string().min(1),
    taskVersion: z.string().regex(/^\d+$/),
    visitType: z.object({
      id: z.string().min(1),
      nameEn: z.string().min(1),
      nameZh: z.string().min(1),
    }),
  }).loose()),
  ...paginationShape,
})

export const triageResponseSchema = commandResponseSchema(z.object({
  doctorTaskId: z.string().min(1),
  encounterId: z.string().min(1),
  encounterVersion: z.string().min(1),
  observationId: z.string().min(1),
  status: z.literal('awaiting-doctor'),
}))

const triageSummarySchema = z.object({
  acuityCode: z.string().min(1),
  chiefComplaint: z.string().min(1),
  temperatureC: z.number(),
})

const triageVitalSummarySchema = triageSummarySchema.extend({
  bloodPressure: z.object({
    diastolicMmHg: z.number(),
    systolicMmHg: z.number(),
  }),
  oxygenSaturationPct: z.number(),
  pulseBpm: z.number(),
  respirationBpm: z.number(),
})

export const doctorQueueItemSchema = z.object({
  caseId: z.string().min(1),
  diagnosticReportId: z.string().min(1).optional(),
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
  patient: patientSummarySchema,
  presentation: clinicalPresentationSchema,
  status: z.enum([
    'awaiting-doctor',
    'awaiting-report',
    'awaiting-revisit',
    'first-visit',
    'revisit-draft',
  ]),
  taskId: z.string().min(1),
  taskVersion: z.string().regex(/^\d+$/),
  triage: triageSummarySchema.optional(),
}).loose()

export const doctorQueueSchema = z.object({
  items: z.array(doctorQueueItemSchema),
  ...paginationShape,
})

export const doctorCompletedCaseSummarySchema = z.object({
  caseId: z.string().min(1),
  completedAt: z.iso.datetime({ offset: true }),
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
  patient: patientSummarySchema,
  primaryDiagnosis: diagnosisConfirmationEntrySchema.extend({
    catalogItemId: diagnosisConfirmationEntrySchema.shape.catalogItemId.optional(),
  }).strict().optional(),
}).strict()

export const doctorCompletedCaseListSchema = z.object({
  items: z.array(doctorCompletedCaseSummarySchema),
  ...paginationShape,
}).strict()

export const encounterCompletionItemCodeSchema = z.enum([
  'primary-diagnosis-confirmed',
  'clinical-document-signed',
  'required-reports-acknowledged',
  'medication-conclusion-recorded',
  'no-pending-drafts',
  'disposition-complete',
  'follow-up-complete',
])

export const encounterCompletionTargetSchema = z.enum([
  'diagnosis',
  'clinical-document',
  'laboratory',
  'medication-conclusion',
])

export const encounterCompletionItemSchema = z.object({
  code: encounterCompletionItemCodeSchema,
  status: z.enum(['complete', 'incomplete']),
  statusText: z.string().min(1).regex(/[\u3400-\u9fff]/),
  target: encounterCompletionTargetSchema,
}).strict()

const encounterCompletionItemCodes = encounterCompletionItemCodeSchema.options

export const encounterCompletionPreviewSchema = z.object({
  canComplete: z.boolean(),
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
  items: z.array(encounterCompletionItemSchema).length(encounterCompletionItemCodes.length)
    .superRefine((items, context) => {
      const codes = new Set(items.map(item => item.code))
      for (const code of encounterCompletionItemCodes) {
        if (!codes.has(code)) {
          context.addIssue({
            code: 'custom',
            message: `Missing Encounter completion condition: ${code}`,
          })
        }
      }
    }),
}).strict()

export const completeEncounterRequestSchema = z.object({
  expectedVersions: z.record(
    z.string().regex(/^Encounter\/[A-Za-z0-9.-]{1,64}$/),
    z.string().regex(/^\d+$/),
  ).refine(versions => Object.keys(versions).length === 1, {
    message: 'Exactly one Encounter expected version is required',
  }),
  input: z.object({}).strict(),
}).strict()

export const encounterCompletionResponseSchema = commandResponseSchema(z.object({
  completedAt: z.iso.datetime({ offset: true }),
  encounterId: z.string().min(1),
  encounterVersion: z.string().regex(/^\d+$/),
  status: z.literal('completed'),
}).strict())

export const priorFactSchema = z.object({
  clinicalStatus: z.string(),
  code: z.string(),
  display: z.string(),
  id: z.string().min(1),
  recordedDate: z.string().optional(),
})

export const allergyWarningSchema = z.object({
  code: z.string().min(1),
  display: z.string().min(1),
}).strict()

export const consultationQuestionSchema = z.object({
  code: z.string().min(1),
  text: z.string().min(1),
}).strict()

export const consultationRecordSchema = z.object({
  answer: z.string().min(1),
  id: z.string().min(1),
  question: consultationQuestionSchema,
  recordedAt: z.string().min(1),
  sequence: z.number().int().positive(),
}).strict()

export const askConsultationQuestionResponseSchema = commandResponseSchema(z.object({
  caseId: z.string().min(1),
  consultationVersion: z.number().int().positive(),
  record: consultationRecordSchema,
}).strict())

export const clinicalDocumentContentSchema = z.object({
  assessment: z.string().trim().min(2).max(4_000),
  chiefComplaint: z.string().trim().min(2).max(1_000),
  disposition: z.string().trim().min(2).max(4_000),
  followUp: z.string().trim().min(2).max(4_000),
  historyOfPresentIllness: z.string().trim().min(2).max(5_000),
  physicalExamination: z.string().trim().min(2).max(4_000),
}).strict()

export const saveClinicalDocumentDraftRequestSchema = z.object({
  expectedVersions: fhirExpectedVersionsSchema,
  input: z.object({
    document: clinicalDocumentContentSchema,
    expectedDraftVersion: z.number().int().nonnegative(),
  }).strict(),
}).strict()

export const clinicalDocumentDraftResponseSchema = commandResponseSchema(z.object({
  caseId: z.string().min(1),
  draftVersion: z.number().int().positive(),
}).strict())

export const previewClinicalDocumentSignRequestSchema = z.object({
  expectedVersions: fhirExpectedVersionsSchema,
  input: z.object({
    expectedDraftVersion: z.number().int().positive(),
  }).strict(),
}).strict()

export const clinicalDocumentSignPreviewResponseSchema = commandResponseSchema(z.object({
  commitToken: z.string().min(1),
  document: z.object({
    content: clinicalDocumentContentSchema,
    version: z.number().int().positive(),
  }).strict(),
  expiresAt: z.string().min(1),
  previewId: z.string().min(1),
}).strict())

export const signClinicalDocumentRequestSchema = z.object({
  expectedVersions: fhirExpectedVersionsSchema,
  input: z.object({
    commitToken: z.string().min(16).max(256),
    previewId: z.string().min(1).max(128),
  }).strict(),
}).strict()

const clinicalDocumentRevisionReasonSchema = z.string().trim().min(2).max(500)

export const reviseClinicalDocumentRequestSchema = z.object({
  expectedVersions: fhirExpectedVersionsSchema,
  input: z.union([
    z.object({
      document: clinicalDocumentContentSchema,
      reason: clinicalDocumentRevisionReasonSchema,
    }).strict(),
    z.object({
      assessment: z.string().trim().min(2).max(4_000),
      plan: z.string().trim().min(2).max(4_000),
      reason: clinicalDocumentRevisionReasonSchema,
    }).strict(),
  ]),
}).strict()

export const clinicalDocumentSignResponseSchema = commandResponseSchema(z.object({
  bundleId: z.string().min(1),
  compositionId: z.string().min(1),
  compositionVersion: z.string().regex(/^\d+$/),
  documentId: z.string().min(1),
  provenanceId: z.string().min(1),
  revisionNumber: z.literal(1),
}).strict())

export const signedClinicalDocumentSchema = z.object({
  bundleId: z.string().min(1),
  compositionId: z.string().min(1),
  compositionVersion: z.string().regex(/^\d+$/),
  content: clinicalDocumentContentSchema,
  documentId: z.string().min(1),
  provenanceId: z.string().min(1),
  revisionNumber: z.number().int().positive(),
  revisionOfCompositionId: z.string().min(1).optional(),
  revisionReason: z.string().min(1).optional(),
  signedAt: z.string().min(1),
}).strict()

const legacyClinicalDocumentContentSchema = z.object({
  assessment: z.string().trim().min(2).max(4_000),
  plan: z.string().trim().min(2).max(4_000),
}).strict()

export const completedCaseClinicalDocumentSchema = signedClinicalDocumentSchema.extend({
  content: z.union([
    clinicalDocumentContentSchema,
    legacyClinicalDocumentContentSchema,
  ]),
  correctionSupported: z.boolean().default(false),
}).strict()

export const clinicalDocumentStateSchema = z.object({
  draft: clinicalDocumentContentSchema.extend({
    updatedAt: z.string().min(1),
    version: z.number().int().positive(),
  }).strict().optional(),
  signed: z.array(signedClinicalDocumentSchema),
}).strict()

export const laboratoryRequestDraftResponseSchema = commandResponseSchema(z.object({
  caseId: z.string().min(1),
  draftVersion: z.number().int().positive(),
}).strict())

export const laboratoryRequestCatalogItemIdSchema = z.enum(['lab-cbc', 'lab-crp'])

export const saveLaboratoryRequestDraftRequestSchema = z.object({
  expectedVersions: fhirExpectedVersionsSchema,
  input: z.object({
    catalogItemId: laboratoryRequestCatalogItemIdSchema,
    expectedDraftVersion: z.number().int().nonnegative(),
    indicationCode: z.string().min(1).max(64),
  }).strict(),
}).strict()

export const deleteLaboratoryRequestDraftRequestSchema = z.object({
  expectedVersions: fhirExpectedVersionsSchema,
  input: z.object({
    expectedDraftVersion: z.number().int().positive(),
  }).strict(),
}).strict()

export const laboratoryRequestStatusSchema = z.enum([
  'issued',
  'accepted',
  'in-progress',
  'reported',
  'acknowledged',
  'cancelled',
])

export const laboratoryResultInterpretationSchema = z.enum(['normal', 'high', 'low'])

const laboratoryResultMeasurementShape = {
  code: z.string().min(1),
  display: z.string().min(1),
  interpretation: laboratoryResultInterpretationSchema,
  referenceRange: z.object({
    high: z.number().finite(),
    low: z.number().finite(),
    text: z.string().min(1),
  }).strict().refine(range => range.low <= range.high, {
    message: 'Laboratory result reference range low must not exceed high',
  }),
  unit: z.object({
    code: z.string().min(1),
    display: z.string().min(1),
    system: z.literal('http://unitsofmeasure.org'),
  }).strict(),
  value: z.number().finite(),
} as const

function laboratoryInterpretationMatchesRange(result: {
  interpretation: z.infer<typeof laboratoryResultInterpretationSchema>
  referenceRange: { high: number; low: number }
  value: number
}): boolean {
  if (result.value < result.referenceRange.low) return result.interpretation === 'low'
  if (result.value > result.referenceRange.high) return result.interpretation === 'high'
  return result.interpretation === 'normal'
}

export const laboratoryResultMeasurementSchema = z.object(
  laboratoryResultMeasurementShape,
).strict().refine(laboratoryInterpretationMatchesRange, {
  message: 'Laboratory result interpretation must match its value and reference range',
})

export const laboratoryResultSchema = z.object({
  ...laboratoryResultMeasurementShape,
  observationId: z.string().min(1),
}).strict().refine(laboratoryInterpretationMatchesRange, {
  message: 'Laboratory result interpretation must match its value and reference range',
})

export const laboratoryReportAcknowledgementSchema = z.object({
  acknowledgedAt: z.string().datetime({ offset: true }),
  acknowledgedBy: z.string().min(1),
  id: z.string().min(1),
}).strict()

interface LaboratoryReportRevisionFields {
  revisionNumber: number
  revisionOfDiagnosticReportId?: string | undefined
  revisionReason?: string | undefined
}

function validateLaboratoryReportRevision(
  report: LaboratoryReportRevisionFields,
  context: z.RefinementCtx,
): void {
  const isRevision = report.revisionNumber > 1
  if (
    isRevision === (report.revisionOfDiagnosticReportId !== undefined)
    && isRevision === (report.revisionReason !== undefined)
  ) return
  context.addIssue({
    code: 'custom',
    message: isRevision
      ? 'A revised laboratory report must identify its source and reason'
      : 'The initial laboratory report cannot identify a revision source',
    path: ['revisionNumber'],
  })
}

interface LaboratoryRequestReportFields {
  report?: { acknowledgement?: unknown } | undefined
  status: z.infer<typeof laboratoryRequestStatusSchema>
}

function validateLaboratoryRequestReport(
  request: LaboratoryRequestReportFields,
  context: z.RefinementCtx,
): void {
  const requiresReport = request.status === 'reported' || request.status === 'acknowledged'
  if (requiresReport !== (request.report !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: requiresReport
        ? 'A reported laboratory request must include its report'
        : 'A laboratory request cannot include a report before it is reported',
      path: ['report'],
    })
    return
  }
  if (request.report === undefined) return
  const requiresAcknowledgement = request.status === 'acknowledged'
  if (requiresAcknowledgement === (request.report.acknowledgement !== undefined)) return
  context.addIssue({
    code: 'custom',
    message: requiresAcknowledgement
      ? 'An acknowledged laboratory request must include its acknowledgement'
      : 'A reported laboratory request cannot include a current acknowledgement',
    path: ['report', 'acknowledgement'],
  })
}

export const laboratoryReportSchema = z.object({
  acknowledgement: laboratoryReportAcknowledgementSchema.optional(),
  conclusion: z.string().min(1),
  diagnosticReportId: z.string().min(1),
  diagnosticReportVersion: z.string().regex(/^\d+$/),
  issuedAt: z.string().datetime({ offset: true }),
  revisionNumber: z.number().int().positive(),
  revisionOfDiagnosticReportId: z.string().min(1).optional(),
  revisionReason: z.string().min(1).optional(),
  results: z.array(laboratoryResultSchema).min(1),
  specimenId: z.string().min(1),
  status: z.literal('final'),
}).strict().superRefine(validateLaboratoryReportRevision)

export const acknowledgeLaboratoryReportRequestSchema = z.object({
  expectedVersions: fhirExpectedVersionsSchema,
  input: z.object({
    expectedRequestVersion: z.number().int().positive(),
  }).strict(),
}).strict()

export const acknowledgeLaboratoryReportResponseSchema = commandResponseSchema(z.object({
  acknowledgementId: z.string().min(1),
  acknowledgedAt: z.string().datetime({ offset: true }),
  acknowledgedBy: z.string().min(1),
  diagnosticReportId: z.string().min(1),
  requestId: z.string().min(1),
  requestVersion: z.number().int().positive(),
  status: z.literal('acknowledged'),
}).strict())

const laboratoryReportCorrectionResultSchema = z.object({
  code: z.string().min(1),
  value: z.number().finite(),
}).strict()

export const correctLaboratoryReportRequestSchema = z.object({
  expectedVersions: fhirExpectedVersionsSchema,
  input: z.object({
    conclusion: z.string().trim().min(2).max(2_000),
    expectedRequestVersion: z.number().int().positive(),
    reason: z.string().trim().min(2).max(500),
    results: z.array(laboratoryReportCorrectionResultSchema).min(1).max(32),
  }).strict().superRefine((input, context) => {
    const codes = new Set(input.results.map(result => result.code))
    if (codes.size === input.results.length) return
    context.addIssue({
      code: 'custom',
      message: 'Laboratory report correction result codes must be unique',
      path: ['results'],
    })
  }),
}).strict()

export const correctLaboratoryReportResponseSchema = commandResponseSchema(z.object({
  diagnosticReportId: z.string().min(1),
  previousDiagnosticReportId: z.string().min(1),
  provenanceId: z.string().min(1),
  requestId: z.string().min(1),
  requestVersion: z.number().int().positive(),
  status: z.literal('reported'),
}).strict())

export const laboratoryRequestSchema = z.object({
  catalogItemId: laboratoryRequestCatalogItemIdSchema,
  id: z.string().min(1),
  indicationCode: z.string().min(1),
  previousReports: z.array(laboratoryReportSchema).default([]),
  report: laboratoryReportSchema.optional(),
  serviceRequestId: z.string().min(1),
  serviceRequestVersion: z.string().regex(/^\d+$/),
  status: laboratoryRequestStatusSchema,
  taskId: z.string().min(1),
  taskVersion: z.string().regex(/^\d+$/),
  version: z.number().int().positive(),
}).strict().superRefine(validateLaboratoryRequestReport)

const completedCaseLaboratoryResultSchema = z.object({
  code: z.string().min(1),
  display: z.string().min(1),
  interpretation: z.string().min(1).optional(),
  observationId: z.string().min(1),
  referenceRange: z.object({
    text: z.string().min(1),
  }).loose().optional(),
  unit: z.object({
    code: z.string().min(1).optional(),
    display: z.string().min(1),
    system: z.string().url().optional(),
  }).strict().optional(),
  value: z.union([z.boolean(), z.number().finite(), z.string()]),
}).strict()

const completedCaseLaboratoryReportSchema = z.object({
  acknowledgement: laboratoryReportAcknowledgementSchema.optional(),
  conclusion: z.string().min(1),
  diagnosticReportId: z.string().min(1),
  diagnosticReportVersion: z.string().regex(/^\d+$/),
  issuedAt: z.string().datetime({ offset: true }),
  revisionNumber: z.number().int().positive(),
  revisionOfDiagnosticReportId: z.string().min(1).optional(),
  revisionReason: z.string().min(1).optional(),
  results: z.array(completedCaseLaboratoryResultSchema).min(1),
  specimenId: z.string().min(1),
  status: z.literal('final'),
}).strict().superRefine(validateLaboratoryReportRevision)

export const completedCaseLaboratoryRequestSchema = z.object({
  catalogDisplay: z.string().min(1).optional(),
  catalogItemId: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/).optional(),
  correctionSupported: z.boolean().default(false),
  id: z.string().min(1),
  indicationCode: z.string().min(1),
  previousReports: z.array(completedCaseLaboratoryReportSchema).default([]),
  report: completedCaseLaboratoryReportSchema.optional(),
  serviceRequestId: z.string().min(1),
  serviceRequestVersion: z.string().regex(/^\d+$/),
  status: laboratoryRequestStatusSchema,
  taskId: z.string().min(1).optional(),
  taskVersion: z.string().regex(/^\d+$/).optional(),
  version: z.number().int().positive(),
}).strict().superRefine((request, context) => {
  if ((request.taskId === undefined) !== (request.taskVersion === undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'Laboratory task ID and version must be present together',
      path: ['taskId'],
    })
  }
  validateLaboratoryRequestReport(request, context)
})

export const issueLaboratoryRequestRequestSchema = z.object({
  expectedVersions: fhirExpectedVersionsSchema,
  input: z.object({
    expectedDraftVersion: z.number().int().positive(),
  }).strict(),
}).strict()

export const issueLaboratoryRequestResponseSchema = commandResponseSchema(z.object({
  caseId: z.string().min(1),
  draftVersion: z.number().int().positive(),
  request: laboratoryRequestSchema,
}).strict())

export const cancelLaboratoryRequestRequestSchema = z.object({
  expectedVersions: fhirExpectedVersionsSchema,
  input: z.object({
    expectedRequestVersion: z.number().int().positive(),
    reasonCode: z.literal('no-longer-needed'),
  }).strict(),
}).strict()

export const laboratoryRequestActionResponseSchema = commandResponseSchema(z.object({
  request: laboratoryRequestSchema,
}).strict())

export const laboratoryRequestStateSchema = z.object({
  draft: z.object({
    catalogItemId: laboratoryRequestCatalogItemIdSchema,
    indicationCode: z.string().min(1),
  }).strict().optional(),
  draftVersion: z.number().int().nonnegative(),
  reportingSupported: z.boolean(),
  requests: z.array(laboratoryRequestSchema),
}).strict()

export const doctorCompletedCaseTimelineKindSchema = z.enum([
  'consultation-recorded',
  'clinical-document-signed',
  'clinical-document-revised',
  'laboratory-request-draft-deleted',
  'laboratory-request-issued',
  'laboratory-request-cancelled',
  'laboratory-report-issued',
  'laboratory-report-revised',
  'laboratory-report-acknowledged',
  'diagnosis-confirmed',
  'prescription-draft-deleted',
  'prescription-issued',
  'prescription-withdrawn',
  'no-medication-confirmed',
  'encounter-completed',
])

const doctorCompletedCaseTimelineReferenceSchema = z.string().regex(
  /^[A-Za-z][A-Za-z0-9]+\/[A-Za-z0-9.-]+$/,
)

export const doctorCompletedCaseTimelineEventSchema = z.object({
  kind: doctorCompletedCaseTimelineKindSchema,
  occurredAt: z.iso.datetime({ offset: true }),
  reference: doctorCompletedCaseTimelineReferenceSchema,
  relatedReferences: z.array(doctorCompletedCaseTimelineReferenceSchema),
}).strict()

export const doctorCompletedCaseDetailSchema = z.object({
  caseId: z.string().min(1),
  clinicalDocuments: z.array(completedCaseClinicalDocumentSchema),
  completedAt: z.iso.datetime({ offset: true }),
  consultation: z.object({
    records: z.array(consultationRecordSchema),
    version: z.number().int().positive(),
  }).strict().optional(),
  diagnosis: diagnosisConfirmationSchema.extend({
    entries: z.array(diagnosisConfirmationEntrySchema.extend({
      catalogItemId: diagnosisConfirmationEntrySchema.shape.catalogItemId.optional(),
    }).strict()).min(1),
  }).strict().optional(),
  encounter: z.object({
    id: z.string().min(1),
    status: z.literal('completed'),
    versionId: z.string().regex(/^\d+$/),
  }).strict(),
  laboratoryRequests: z.array(completedCaseLaboratoryRequestSchema),
  medicationConclusion: z.object({
    noMedication: noMedicationConclusionSchema.optional(),
    prescription: completedCasePrescriptionSchema.optional(),
  }).strict().optional(),
  patient: patientSummarySchema,
  timeline: z.array(doctorCompletedCaseTimelineEventSchema),
}).strict()

export const doctorCaseDetailSchema = z.object({
  allergies: z.array(allergyWarningSchema),
  caseId: z.string().min(1),
  clinicalDocument: clinicalDocumentStateSchema.optional(),
  consultation: z.object({
    questions: z.array(consultationQuestionSchema),
    records: z.array(consultationRecordSchema),
    version: z.number().int().positive(),
  }).strict().optional(),
  diagnosis: diagnosisStateSchema.optional(),
  drafts: z.object({
    document: z.object({
      assessment: z.string(),
      composition: fhirResourceSchema,
      medicationRequestIds: z.array(z.string()).optional(),
      plan: z.string(),
      version: z.number().int().positive(),
    }).loose().optional(),
    firstVisit: z.object({
      assessment: z.string(),
      historyOfPresentIllness: z.string(),
      version: z.number().int().positive(),
    }).loose().optional(),
    prescription: z.object({
      id: z.string().min(1),
      items: z.array(z.object({
        doseText: z.string(),
        frequencyCode: z.string(),
        medicationId: z.string().min(1),
        medicationRequestId: z.string().min(1),
        quantity: z.number().int().positive(),
        versionId: z.string().regex(/^\d+$/),
      })),
      number: z.string().min(1),
      status: z.string().min(1),
      version: z.number().int().positive(),
    }).loose().optional(),
    revisit: z.object({
      conditionId: z.string().min(1),
      conditionVersion: z.string().regex(/^\d+$/),
      diagnosis: z.object({ code: z.string(), display: z.string() }),
      version: z.number().int().positive(),
    }).loose().optional(),
  }).partial().optional(),
  encounter: z.object({
    id: z.string().min(1),
    status: z.string().optional(),
    versionId: z.string().regex(/^\d+$/),
  }),
  laboratoryRequests: laboratoryRequestStateSchema.optional(),
  medicationConclusion: medicationConclusionStateSchema.optional(),
  patient: patientSummarySchema,
  presentation: clinicalPresentationSchema,
  priorFacts: z.array(priorFactSchema),
  report: z.object({
    id: z.string().min(1),
    results: z.array(z.object({
      code: z.string(),
      interpretation: z.string().optional(),
      referenceRange: z.string().optional(),
      unit: z.string().optional(),
      value: z.union([z.boolean(), z.number(), z.string()]),
    })),
    status: z.string(),
  }).optional(),
  status: z.string().min(1),
  taskId: z.string().min(1),
  taskVersion: z.string().regex(/^\d+$/),
  triage: triageVitalSummarySchema.optional(),
}).loose()

export const startVisitResponseSchema = commandResponseSchema(z.object({
  encounterVersion: z.string().min(1),
  status: z.enum(['first-visit', 'revisit-draft']),
  taskVersion: z.string().min(1),
}))

export const firstVisitDraftResponseSchema = commandResponseSchema(z.object({
  draftVersion: z.number().int().positive(),
}))

export const laboratoryOrderResponseSchema = commandResponseSchema(z.object({
  chargeItemId: z.string().min(1),
  encounterId: z.string().min(1),
  encounterVersion: z.string().min(1),
  serviceRequestId: z.string().min(1),
  status: z.literal('awaiting-lab-payment'),
  totalFen: z.number().int().nonnegative(),
}))

export const revisitDraftResponseSchema = commandResponseSchema(z.object({
  conditionId: z.string().min(1),
  documentDraftVersion: z.number().int().positive(),
  medicationRequestIds: z.array(z.string().min(1)).min(1),
  prescriptionId: z.string().min(1),
  prescriptionNumber: z.string().min(1),
  prescriptionVersion: z.number().int().positive(),
  revisitDraftVersion: z.number().int().positive(),
}))

export const clinicalSignPreviewResponseSchema = commandResponseSchema(z.object({
  commitToken: z.string().min(1),
  expiresAt: z.string().min(1),
  medicationTotalFen: z.number().int().nonnegative(),
  previewId: z.string().min(1),
  summary: z.object({
    diagnosis: z.object({
      code: z.string(),
      display: z.string(),
    }),
    document: z.object({
      assessment: z.string(),
      plan: z.string(),
    }),
    medications: z.array(z.object({
      medicationId: z.string().min(1),
      medicationRequestId: z.string().min(1),
      nameEn: z.string().min(1),
      nameZh: z.string().min(1),
      quantity: z.number().int().positive(),
      subtotalFen: z.number().int().nonnegative(),
      unitPriceFen: z.number().int().nonnegative(),
    })).min(1),
  }),
}))

export const clinicalSignResponseSchema = commandResponseSchema(z.object({
  bundleId: z.string().min(1),
  chargeItemId: z.string().min(1),
  compositionId: z.string().min(1),
  encounterId: z.string().min(1),
  encounterVersion: z.string().min(1),
  provenanceId: z.string().min(1),
  status: z.literal('awaiting-medication-payment'),
}))

export const clinicalDocumentRevisionResponseSchema = commandResponseSchema(z.object({
  bundleId: z.string().min(1),
  compositionId: z.string().min(1),
  compositionVersion: z.string().regex(/^\d+$/),
  documentId: z.string().min(1),
  provenanceId: z.string().min(1),
  revisionNumber: z.number().int().min(2),
  revisionOfCompositionId: z.string().min(1),
}))

export const billingQueueSchema = z.object({
  items: z.array(z.object({
    accountId: z.string().min(1),
    amountFen: z.number().int().nonnegative(),
    caseId: z.string().min(1),
    category: z.enum(['laboratory', 'medication']),
    chargeItemId: z.string().min(1),
    chargeVersion: z.number().int().positive(),
    descriptionEn: z.string().min(1),
    descriptionZh: z.string().min(1),
    encounterId: z.string().min(1),
    lines: z.array(z.object({
      descriptionEn: z.string().min(1),
      descriptionZh: z.string().min(1),
      quantity: z.number().int().positive(),
      sourceReference: z.string().min(1),
      subtotalFen: z.number().int().nonnegative(),
      unitPriceFen: z.number().int().nonnegative(),
    })).min(1),
    patient: patientSummarySchema,
    status: z.string().min(1),
  }).loose()),
  ...paginationShape,
})

export const paymentPreviewResponseSchema = commandResponseSchema(z.object({
  allocations: z.array(z.object({
    amountFen: z.number().int().nonnegative(),
    chargeItemId: z.string().min(1),
  })).min(1),
  amountFen: z.number().int().nonnegative(),
  channel: z.literal('synthetic-payment'),
  chargeItemId: z.string().min(1),
  chargeVersion: z.number().int().positive(),
  commitToken: z.string().min(1),
  expectedOutcome: z.enum(['ambiguous', 'declined', 'success']),
  expiresAt: z.string().min(1),
  previewId: z.string().min(1),
}))

export const paymentResponseSchema = commandResponseSchema(z.object({
  amountFen: z.number().int().nonnegative(),
  outcome: z.enum(['ambiguous', 'declined', 'success']),
  paymentId: z.string().min(1),
  status: z.string().min(1),
}))

const inventoryLotSchema = z.object({
  expiresOn: z.iso.date(),
  id: z.string().min(1),
  locationId: z.string().min(1),
  lotNumber: z.string().min(1),
  quantityOnHand: z.number().int().nonnegative(),
  version: z.number().int().positive(),
})

export const pharmacyQueueSchema = z.object({
  items: z.array(z.object({
    allergyWarnings: z.array(allergyWarningSchema),
    authoredBy: z.string().min(1),
    caseId: z.string().min(1),
    encounterId: z.string().min(1),
    encounterStatus: z.string().optional(),
    encounterVersion: z.string().regex(/^\d+$/),
    medications: z.array(z.object({
      doseText: z.string().min(1),
      dispensedQuantity: z.number().int().nonnegative(),
      frequencyCode: z.string().min(1),
      lots: z.array(inventoryLotSchema),
      medicationId: z.string().min(1),
      medicationRequestId: z.string().min(1),
      medicationRequestVersion: z.string().regex(/^\d+$/),
      nameEn: z.string().min(1),
      nameZh: z.string().min(1),
      quantity: z.number().int().positive(),
      remainingQuantity: z.number().int().nonnegative(),
      unitPriceFen: z.number().int().nonnegative(),
    })),
    patient: patientSummarySchema,
    prescriptionId: z.string().min(1),
    prescriptionNumber: z.string().min(1),
    prescriptionStatus: z.string().min(1),
    prescriptionVersion: z.number().int().positive(),
    review: z.object({
      note: z.string().min(1),
      reviewId: z.string().min(1),
      reviewedAt: z.string().min(1),
      reviewedBy: z.string().min(1),
    }).optional(),
    status: z.enum(['awaiting-review', 'awaiting-dispense', 'completed', 'partially-dispensed']),
  })),
  ...paginationShape,
})

export const prescriptionReviewResponseSchema = commandResponseSchema(z.object({
  prescriptionId: z.string().min(1),
  prescriptionVersion: z.number().int().positive(),
  reviewId: z.string().min(1),
  status: z.literal('awaiting-dispense'),
}))

export const dispenseResponseSchema = commandResponseSchema(z.object({
  medicationDispenseIds: z.array(z.string().min(1)).min(1),
  prescriptionId: z.string().min(1),
  prescriptionVersion: z.number().int().positive(),
  scenarioStatus: z.enum(['active', 'completed']),
  status: z.enum(['completed', 'partial']),
}))

export type RoleCode = z.infer<typeof roleCodeSchema>
export type ApiConflict = z.infer<typeof apiConflictSchema>
export type SessionContext = z.infer<typeof sessionContextSchema>
export type ScenarioState = z.infer<typeof scenarioStateSchema>
export type PatientSummary = z.infer<typeof patientSummarySchema>
export type ClinicalPresentation = z.infer<typeof clinicalPresentationSchema>
export type ClinicalDocumentContent = z.infer<typeof clinicalDocumentContentSchema>
export type DiagnosisDraftEntry = z.infer<typeof diagnosisDraftEntrySchema>
export type DiagnosisConfirmation = z.infer<typeof diagnosisConfirmationSchema>
export type DiagnosisState = z.infer<typeof diagnosisStateSchema>
export type PrescriptionDraftItem = z.infer<typeof prescriptionDraftItemSchema>
export type VirtualPatientList = z.infer<typeof virtualPatientListSchema>
export type ClinicalCatalog = z.infer<typeof clinicalCatalogSchema>
export type TriageQueueItem = z.infer<typeof triageQueueSchema>['items'][number]
export type DoctorQueueItem = z.infer<typeof doctorQueueItemSchema>
export type DoctorCompletedCaseSummary = z.infer<typeof doctorCompletedCaseSummarySchema>
export type DoctorCompletedCaseList = z.infer<typeof doctorCompletedCaseListSchema>
export type DoctorCompletedCaseDetail = z.infer<typeof doctorCompletedCaseDetailSchema>
export type DoctorCompletedCaseTimelineEvent = z.infer<typeof doctorCompletedCaseTimelineEventSchema>
export type DoctorCaseDetail = z.infer<typeof doctorCaseDetailSchema>
export type EncounterCompletionItem = z.infer<typeof encounterCompletionItemSchema>
export type EncounterCompletionPreview = z.infer<typeof encounterCompletionPreviewSchema>
export type EncounterCompletionTarget = z.infer<typeof encounterCompletionTargetSchema>
export type LaboratoryRequestCatalogItemId = z.infer<typeof laboratoryRequestCatalogItemIdSchema>
export type LaboratoryRequest = z.infer<typeof laboratoryRequestSchema>
export type LaboratoryReport = z.infer<typeof laboratoryReportSchema>
export type BillingQueueItem = z.infer<typeof billingQueueSchema>['items'][number]
export type PharmacyQueueItem = z.infer<typeof pharmacyQueueSchema>['items'][number]
