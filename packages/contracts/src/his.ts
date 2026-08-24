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

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
})

export const patientSummarySchema = z.object({
  birthDate: z.string().optional(),
  gender: z.string().optional(),
  id: z.string().min(1),
  identifier: z.string(),
  name: z.string(),
  synthetic: z.literal(true),
  versionId: z.string().regex(/^\d+$/),
})

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

const catalogItemSchema = z.object({
  id: z.string().min(1),
  nameEn: z.string().min(1),
  nameZh: z.string().min(1),
  priceFen: z.number().int().nonnegative().optional(),
  version: z.number().int().positive(),
})

export const clinicalCatalogSchema = z.object({
  laboratory: z.array(catalogItemSchema.extend({
    allowedIndicationCodes: z.array(z.string().min(1)).min(1),
    contraindicatedAllergyCodes: z.array(z.string().min(1)),
  })),
  medications: z.array(catalogItemSchema.extend({
    allowedCombinationIds: z.array(z.string().min(1)),
    allowedDoseTexts: z.array(z.string().min(1)).min(1),
    allowedFrequencyCodes: z.array(z.string().min(1)).min(1),
    defaultDoseText: z.string().min(1),
    defaultFrequencyCode: z.string().min(1),
  })),
})

export const registrationCatalogSchema = z.object({
  departments: z.array(catalogItemSchema),
  locations: z.array(catalogItemSchema),
  virtualDate: z.iso.date(),
  visitTypes: z.array(catalogItemSchema),
})

const paginationShape = {
  page: z.number().int().positive(),
  pageSize: z.number().int().positive().max(100),
  total: z.number().int().nonnegative(),
}

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

export const registrationQueueSchema = z.object({
  items: z.array(z.object({
    arrivedAt: z.string().min(1),
    caseId: z.string().min(1),
    encounterId: z.string().min(1),
    encounterVersion: z.string().regex(/^\d+$/),
    patient: patientSummarySchema,
    registrationId: z.string().min(1),
    registrationNumber: z.string().min(1),
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
  status: z.enum([
    'awaiting-doctor',
    'awaiting-report',
    'awaiting-revisit',
    'first-visit',
    'revisit-draft',
  ]),
  taskId: z.string().min(1),
  taskVersion: z.string().regex(/^\d+$/),
  triage: triageSummarySchema,
}).loose()

export const doctorQueueSchema = z.object({
  items: z.array(doctorQueueItemSchema),
  ...paginationShape,
})

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

export const doctorCaseDetailSchema = z.object({
  allergies: z.array(allergyWarningSchema),
  caseId: z.string().min(1),
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
  patient: patientSummarySchema,
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
  triage: triageVitalSummarySchema,
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
  provenanceId: z.string().min(1),
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
export type SessionContext = z.infer<typeof sessionContextSchema>
export type ScenarioState = z.infer<typeof scenarioStateSchema>
export type PatientSummary = z.infer<typeof patientSummarySchema>
export type ClinicalCatalog = z.infer<typeof clinicalCatalogSchema>
export type TriageQueueItem = z.infer<typeof triageQueueSchema>['items'][number]
export type DoctorQueueItem = z.infer<typeof doctorQueueItemSchema>
export type DoctorCaseDetail = z.infer<typeof doctorCaseDetailSchema>
export type BillingQueueItem = z.infer<typeof billingQueueSchema>['items'][number]
export type PharmacyQueueItem = z.infer<typeof pharmacyQueueSchema>['items'][number]
