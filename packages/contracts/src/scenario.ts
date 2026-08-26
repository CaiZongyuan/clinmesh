import { z } from 'zod'

const localDateSchema = z.iso.date()

export const scenarioGenerationRequestSchema = z.object({
  modules: z.array(z.enum(['fever', 'type-2-diabetes'])).min(1).max(8),
  name: z.string().trim().min(1).max(120),
  population: z.object({
    age: z.object({
      maximum: z.number().int().min(0).max(120),
      minimum: z.number().int().min(0).max(120),
    }).strict(),
    count: z.number().int().min(1).max(1_000),
    gender: z.enum(['any', 'female', 'male']),
  }).strict(),
  providerId: z.enum(['builtin', 'synthea']),
  seeds: z.object({
    clinical: z.number().int().min(0).max(2_147_483_647),
    population: z.number().int().min(0).max(2_147_483_647),
  }).strict(),
  timeRange: z.object({
    end: localDateSchema,
    start: localDateSchema,
  }).strict(),
  timeZone: z.enum(['Asia/Shanghai']),
}).strict().superRefine((value, context) => {
  if (value.population.age.minimum > value.population.age.maximum) {
    context.addIssue({
      code: 'custom',
      message: 'Minimum age must not exceed maximum age',
      path: ['population', 'age', 'minimum'],
    })
  }
  if (value.timeRange.start > value.timeRange.end) {
    context.addIssue({
      code: 'custom',
      message: 'Start date must not be after end date',
      path: ['timeRange', 'start'],
    })
  }
})

export const scenarioDiagnosticSchema = z.object({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(1_000),
  path: z.string().min(1).max(512),
  severity: z.enum(['error', 'warning']),
}).strict()

const scenarioCatalogItemBaseSchema = z.object({
  active: z.boolean(),
  code: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  organizationId: z.string().min(1),
  priceFen: z.number().int().nonnegative(),
  status: z.enum(['active', 'inactive']),
}).strict()

const scenarioDepartmentCatalogItemSchema = scenarioCatalogItemBaseSchema.extend({
  displayOrder: z.number().int().nonnegative(),
  parentId: z.string().min(1).nullable(),
  type: z.enum(['hospital', 'department']),
}).strict()

const scenarioDiagnosisCatalogItemSchema = scenarioCatalogItemBaseSchema.extend({
  codeSystem: z.string().url(),
}).strict()

const scenarioReferenceRangeSchema = z.object({
  appliesToGender: z.enum(['female', 'male', 'any']).default('any'),
  maximum: z.number().optional(),
  minimum: z.number().optional(),
  text: z.string().min(1),
}).strict()

const scenarioInvestigationCatalogItemSchema = scenarioCatalogItemBaseSchema.extend({
  allowedIndicationCodes: z.array(z.string().min(1)).min(1),
  available: z.boolean(),
  category: z.enum(['examination', 'imaging', 'laboratory']),
  componentItemIds: z.array(z.string().min(1)).min(1).optional(),
  contraindicatedAllergyCodes: z.array(z.string().min(1)),
  criticalMaximum: z.number().optional(),
  criticalMinimum: z.number().optional(),
  normalDistribution: z.object({
    assayCv: z.number().nonnegative().max(1),
    maximum: z.number(),
    mean: z.number(),
    minimum: z.number(),
    standardDeviation: z.number().positive(),
  }).strict().optional(),
  physiologyGeneratorId: z.string().min(1).optional(),
  referenceRanges: z.array(scenarioReferenceRangeSchema),
  reportTemplate: z.string().min(1),
  tatMinutes: z.number().int().nonnegative(),
  unit: z.string().min(1).optional(),
  valueType: z.enum(['boolean', 'codeable', 'panel', 'quantity', 'string']),
}).strict()

const scenarioMedicationCatalogItemSchema = scenarioCatalogItemBaseSchema.extend({
  category: z.string().min(1),
  defaultDose: z.string().min(1),
  defaultFrequency: z.string().min(1),
  defaultRoute: z.string().min(1),
  dosageForm: z.string().min(1),
  restriction: z.string().min(1).nullable(),
  workflow: z.object({
    allowedCombinationIds: z.array(z.string().min(1)),
    allowedCourseDays: z.array(z.number().int().positive()).min(1),
    allowedDiagnosisCodes: z.array(z.string().min(1)).min(1),
    allowedDoseTexts: z.array(z.string().min(1)).min(1),
    allowedFrequencyCodes: z.array(z.string().min(1)).min(1),
    allowedQuantities: z.array(z.number().int().positive()).min(1),
    defaultCourseDays: z.number().int().positive(),
    defaultQuantity: z.number().int().positive(),
  }).strict(),
  unit: z.string().min(1),
}).strict()

const scenarioResultValueSchema = z.union([z.boolean(), z.number(), z.string().min(1)])

export const scenarioInvestigationResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    flag: z.string().min(1).optional(),
    outcome: z.literal('reported'),
    referenceRange: z.string().min(1).optional(),
    unit: z.string().min(1).optional(),
    value: scenarioResultValueSchema,
  }).strict(),
  z.object({
    message: z.string().min(1),
    outcome: z.literal('catalog-boundary'),
  }).strict(),
  z.object({
    message: z.string().min(1),
    outcome: z.literal('not-indicated'),
  }).strict(),
])

const scenarioHistoryEventSchema = z.object({
  code: z.string().min(1),
  display: z.string().min(1),
  endedAt: z.iso.datetime({ offset: true }).optional(),
  id: z.string().min(1),
  kind: z.enum(['allergy', 'condition', 'encounter', 'medication', 'observation']),
  mappedCode: z.string().min(1).nullable(),
  occurredAt: z.union([localDateSchema, z.iso.datetime({ offset: true })]),
  sourceResourceId: z.string().min(1),
  sourceResourceType: z.enum([
    'AllergyIntolerance',
    'Condition',
    'Encounter',
    'MedicationRequest',
    'Observation',
  ]),
  status: z.string().min(1),
}).strict()

const scenarioCodeSchema = z.object({
  code: z.string().min(1).optional(),
  display: z.string().min(1),
  system: z.string().url().optional(),
}).strict()

const scenarioFhirHistorySchema = z.discriminatedUnion('resourceType', [
  z.object({
    classCode: z.string().min(1),
    id: z.string().min(1),
    period: z.object({
      end: z.iso.datetime({ offset: true }).optional(),
      start: z.iso.datetime({ offset: true }),
    }).strict(),
    resourceType: z.literal('Encounter'),
    status: z.string().min(1),
  }).strict(),
  z.object({
    clinicalStatus: z.string().min(1),
    code: scenarioCodeSchema,
    encounterId: z.string().min(1).optional(),
    id: z.string().min(1),
    onsetDateTime: z.iso.datetime({ offset: true }).optional(),
    recordedDate: z.iso.datetime({ offset: true }).optional(),
    resourceType: z.literal('Condition'),
  }).strict(),
  z.object({
    code: scenarioCodeSchema,
    effectiveDateTime: z.iso.datetime({ offset: true }).optional(),
    encounterId: z.string().min(1).optional(),
    id: z.string().min(1),
    resourceType: z.literal('Observation'),
    status: z.string().min(1),
    value: scenarioInvestigationResultSchema,
  }).strict(),
  z.object({
    authoredOn: z.iso.datetime({ offset: true }).optional(),
    encounterId: z.string().min(1).optional(),
    id: z.string().min(1),
    intent: z.string().min(1),
    medication: scenarioCodeSchema,
    resourceType: z.literal('MedicationRequest'),
    status: z.string().min(1),
  }).strict(),
  z.object({
    clinicalStatus: z.string().min(1),
    code: scenarioCodeSchema,
    id: z.string().min(1),
    recordedDate: z.iso.datetime({ offset: true }).optional(),
    resourceType: z.literal('AllergyIntolerance'),
  }).strict(),
])

const scenarioDiagnosisSchema = z.object({
  code: z.string().min(1).nullable(),
  display: z.string().min(1),
  evidence: z.array(z.string().min(1)),
  expectedAction: z.string().min(1).optional(),
  id: z.string().min(1),
  route: z.string().min(1).optional(),
  truth: z.string().min(1).optional(),
}).strict()

const scenarioPhysiologyGeneratorSchema = z.discriminatedUnion('kind', [
  z.object({
    assayCv: z.number().nonnegative().max(1).optional(),
    id: z.string().min(1),
    kind: z.literal('constant'),
    source: z.string().min(1),
    unit: z.string().min(1),
    value: z.number(),
  }).strict(),
  z.object({
    assayCv: z.number().nonnegative().max(1),
    id: z.string().min(1),
    kind: z.literal('normal'),
    maximum: z.number(),
    mean: z.number(),
    minimum: z.number(),
    source: z.string().min(1),
    standardDeviation: z.number().positive(),
    unit: z.string().min(1),
  }).strict(),
  z.object({
    assayCv: z.number().nonnegative().max(1),
    id: z.string().min(1),
    kind: z.literal('trajectory'),
    maximum: z.number(),
    minimum: z.number(),
    source: z.string().min(1),
    target: z.number(),
    unit: z.string().min(1),
    walkStep: z.number().positive(),
  }).strict(),
  z.object({
    dependencies: z.array(z.string().min(1)).min(1),
    formula: z.enum([
      'bmi',
      'egfr-ckd-epi-2021',
      'friedewald-ldl',
      'hematocrit-from-rbc-mcv',
      'urine-glucose-from-blood-glucose',
    ]),
    id: z.string().min(1),
    kind: z.literal('derived'),
    source: z.string().min(1),
    unit: z.string().min(1),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('text'),
    source: z.string().min(1),
    value: z.string().min(1),
  }).strict(),
])

export const scenarioPatientSchema = z.object({
  birthDate: localDateSchema,
  costBaseline: z.object({
    note: z.string().min(1),
    overInvestigationThresholdFen: z.number().int().nonnegative(),
    reasonableRangeFen: z.tuple([
      z.number().int().nonnegative(),
      z.number().int().nonnegative(),
    ]),
    referencePath: z.string().min(1),
  }).strict(),
  diagnosisSpace: z.object({
    comorbidities: z.array(scenarioDiagnosisSchema),
    differentials: z.array(scenarioDiagnosisSchema),
    primary: scenarioDiagnosisSchema,
    traps: z.array(z.string().min(1)),
  }).strict(),
  encounter: z.object({
    openingStatement: z.string().min(1),
    setting: z.string().min(1),
    timeStateItems: z.array(z.object({
      change: z.string().min(1),
      id: z.string().min(1),
      triggerAfterMinutes: z.number().int().positive(),
    }).strict()),
  }).strict(),
  examinationFindings: z.array(z.object({
    abnormal: z.array(z.string().min(1)),
    finding: z.string().min(1),
    id: z.string().min(1),
    name: z.string().min(1),
  }).strict()),
  fhirHistory: z.array(scenarioFhirHistorySchema),
  gender: z.enum(['female', 'male', 'other', 'unknown']),
  id: z.string().min(1),
  investigations: z.array(z.object({
    catalogItemId: z.string().min(1),
    critical: z.boolean(),
    feeFen: z.number().int().nonnegative(),
    id: z.string().min(1),
    name: z.string().min(1),
    report: z.string().min(1),
    result: scenarioInvestigationResultSchema,
    sourceLevel: z.enum(['L1', 'L2', 'L3']),
    tatMinutes: z.number().int().nonnegative(),
  }).strict()),
  longitudinalHistory: z.array(scenarioHistoryEventSchema),
  managementSpace: z.object({
    acceptableOptions: z.array(z.string().min(1)),
    contraindications: z.array(z.string().min(1)),
    followUp: z.string().min(1),
    requiredElements: z.array(z.string().min(1)),
  }).strict(),
  name: z.string().min(1),
  patientKnowledge: z.object({
    careMemory: z.string().min(1),
    chiefComplaint: z.string().min(1),
    healthLiteracy: z.string().min(1),
    lifestyle: z.array(z.object({
      actual: z.string().min(1),
      admittedOnFirstAsk: z.string().min(1),
      concedeOnSecondAsk: z.boolean(),
      id: z.string().min(1),
      label: z.string().min(1),
    }).strict()),
    medicationMemory: z.string().min(1),
    neverKnows: z.array(z.string().min(1)),
    toldDiagnoses: z.array(z.string().min(1)),
  }).strict(),
  persona: z.object({
    attitude: z.string().min(1),
    character: z.string().min(1),
    healthLiteracy: z.string().min(1),
    occupation: z.string().min(1),
    speechStyle: z.string().min(1),
  }).strict(),
  physiologyBaseline: z.object({
    generators: z.array(scenarioPhysiologyGeneratorSchema),
    vitalSigns: z.object({
      diastolicMmHg: z.number().positive().optional(),
      heightCm: z.number().positive().optional(),
      oxygenSaturationPct: z.number().min(0).max(100).optional(),
      pulseBpm: z.number().positive().optional(),
      respirationBpm: z.number().positive().optional(),
      systolicMmHg: z.number().positive().optional(),
      temperatureC: z.number().optional(),
      weightKg: z.number().positive().optional(),
    }).strict(),
  }).strict(),
  symptomResponses: z.array(z.object({
    avoids: z.array(z.object({
      questionPattern: z.string().min(1),
      response: z.string().min(1),
    }).strict()),
    denies: z.array(z.string().min(1)),
    id: z.string().min(1),
    name: z.string().min(1),
    passive: z.boolean(),
    responsePoints: z.array(z.string().min(1)),
    secondAskConcede: z.object({
      firstResponse: z.string().min(1),
      revealedResponse: z.string().min(1),
    }).strict().optional(),
  }).strict()),
}).strict()

export const scenarioDatasetContentSchema = z.object({
  catalog: z.object({
    departments: z.array(scenarioDepartmentCatalogItemSchema),
    diagnoses: z.array(scenarioDiagnosisCatalogItemSchema),
    investigations: z.array(scenarioInvestigationCatalogItemSchema),
    medications: z.array(scenarioMedicationCatalogItemSchema),
  }).strict(),
  hiddenFacts: z.array(z.object({
    code: z.string().min(1),
    patientId: z.string().min(1).optional(),
    value: z.json(),
  }).strict()),
  hospital: z.object({
    active: z.boolean(),
    businessCode: z.string().min(1),
    displayOrder: z.number().int().nonnegative(),
    id: z.string().min(1),
    locale: z.literal('zh-CN'),
    name: z.string().min(1),
    status: z.enum(['active', 'inactive']),
    type: z.literal('public-general-hospital'),
  }).strict(),
  inventory: z.array(z.object({
    expiresOn: localDateSchema,
    itemId: z.string().min(1),
    lotId: z.string().min(1),
    quantity: z.number().int().nonnegative(),
  }).strict()),
  patients: z.array(scenarioPatientSchema).min(1),
  reproduction: z.object({
    clinicalSeed: z.number().int(),
    configHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    generator: z.string().min(1),
    generatorVersion: z.string().min(1).optional(),
    modules: z.array(z.string().min(1)),
    populationSeed: z.number().int(),
    timeRange: z.object({ end: localDateSchema, start: localDateSchema }).strict(),
    timeZone: z.string().min(1),
  }).strict(),
  revealPolicies: z.array(z.object({
    code: z.string().min(1),
    factCode: z.string().min(1),
    patientId: z.string().min(1).optional(),
    triggerCode: z.enum([
      'after-examination',
      'after-request',
      'after-time',
      'after-topic',
      'evaluator-only',
      'initial',
      'second-ask-concede',
    ]),
  }).strict()),
  schemaVersion: z.literal('1'),
  simulatorRules: z.array(z.object({
    code: z.string().min(1),
    outcome: z.string().min(1),
    simulator: z.string().min(1),
  }).strict()),
}).strict()

export const scenarioDatasetSchema = z.object({
  content: scenarioDatasetContentSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime({ offset: true }),
  datasetId: z.string().min(1),
  diagnostics: z.array(scenarioDiagnosticSchema),
  name: z.string().min(1),
  providerId: z.enum(['builtin', 'synthea']),
  updatedAt: z.iso.datetime({ offset: true }),
  version: z.number().int().positive(),
  workspaceId: z.string().min(1),
}).strict()

export const scenarioDatasetSummarySchema = scenarioDatasetSchema.omit({
  content: true,
  diagnostics: true,
  workspaceId: true,
}).extend({
  diagnosticCounts: z.object({
    error: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
  }).strict(),
  patientCount: z.number().int().positive(),
}).strict()

export const scenarioDatasetListSchema = z.object({
  items: z.array(scenarioDatasetSummarySchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive().max(100),
  total: z.number().int().nonnegative(),
}).strict()

export const updateScenarioDatasetRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  input: z.object({
    content: scenarioDatasetContentSchema,
    name: z.string().trim().min(1).max(120),
  }).strict(),
}).strict()

export const scenarioProviderCapabilitiesSchema = z.object({
  available: z.boolean(),
  maxPopulation: z.number().int().positive(),
  modules: z.array(z.enum(['fever', 'type-2-diabetes'])),
  providerId: z.enum(['builtin', 'synthea']),
  providerName: z.string().min(1),
  unavailableReason: z.string().min(1).optional(),
}).strict()

export const scenarioGenerationJobSchema = z.object({
  createdAt: z.iso.datetime({ offset: true }),
  datasetId: z.string().min(1).nullable(),
  error: z.object({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(1_000),
  }).strict().nullable(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  jobId: z.string().min(1),
  request: scenarioGenerationRequestSchema,
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  updatedAt: z.iso.datetime({ offset: true }),
  workspaceId: z.string().min(1),
}).strict()

export type ScenarioDataset = z.infer<typeof scenarioDatasetSchema>
export type ScenarioDatasetList = z.infer<typeof scenarioDatasetListSchema>
export type ScenarioDatasetContent = z.infer<typeof scenarioDatasetContentSchema>
export type ScenarioDiagnostic = z.infer<typeof scenarioDiagnosticSchema>
export type ScenarioGenerationRequest = z.infer<typeof scenarioGenerationRequestSchema>
export type ScenarioGenerationJob = z.infer<typeof scenarioGenerationJobSchema>
export type ScenarioInvestigationResult = z.infer<typeof scenarioInvestigationResultSchema>
export type ScenarioPatient = z.infer<typeof scenarioPatientSchema>
export type ScenarioProviderCapabilities = z.infer<typeof scenarioProviderCapabilitiesSchema>
