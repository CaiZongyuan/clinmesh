import { z } from 'zod'
import {
  referenceDataProvenanceSchema,
  referenceMappingPackageProvenanceSchema,
} from './reference-data.ts'

const localDateSchema = z.iso.date()

const legacyUcumUnitByDisplay = {
  '%': '%',
  '1': '1',
  '10^12/L': '10*12/L',
  '10^9/L': '10*9/L',
  '10*3/uL': '10*3/uL',
  '10*6/uL': '10*6/uL',
  'L/L': 'L/L',
  'fL': 'fL',
  'g/L': 'g/L',
  'g/dL': 'g/dL',
  'kg/m²': 'kg/m2',
  'mIU/L': 'm[IU]/L',
  'mL/min/1.73m²': 'mL/min/{1.73_m2}',
  'mg/L': 'mg/L',
  'mmol/L': 'mmol/L',
  'qualitative': '{qualitative}',
  'pg': 'pg',
  '°C': 'Cel',
  'μmol/L': 'umol/L',
} as const

const canonicalUcumUnitSchema = z.object({
  code: z.string().min(1),
  display: z.string().min(1),
  system: z.literal('http://unitsofmeasure.org'),
  version: z.literal('2.2'),
}).strict()

export const scenarioUcumUnitSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  const code = legacyUcumUnitByDisplay[value as keyof typeof legacyUcumUnitByDisplay]
  return code === undefined ? value : {
    code,
    display: value,
    system: 'http://unitsofmeasure.org',
    version: '2.2',
  }
}, canonicalUcumUnitSchema)

export const scenarioLoincCodingSchema = z.object({
  code: z.string().regex(/^\d{1,5}-\d$/),
  display: z.string().min(1),
  system: z.literal('http://loinc.org'),
  version: z.literal('2.83'),
}).strict()

export const scenarioModuleSchema = z.enum([
  'fever',
  'type-2-diabetes',
  'hypertension',
])

export const scenarioGenerationRequestSchema = z.object({
  modules: z.array(scenarioModuleSchema).min(1).max(8),
  name: z.string().trim().min(1).max(120),
  population: z.object({
    age: z.object({
      maximum: z.number().int().min(0).max(120),
      minimum: z.number().int().min(0).max(120),
    }).strict(),
    count: z.number().int().min(1).max(10),
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

export const scenarioCatalogCompilationReportSchema = z.object({
  blockers: z.array(z.object({
    code: z.enum([
      'CRITICAL_DEPENDENCY_AMBIGUOUS',
      'CRITICAL_DEPENDENCY_MISSING',
      'WORKFLOW_DEPENDENCY_AMBIGUOUS',
      'WORKFLOW_DEPENDENCY_MISSING',
    ]),
    module: scenarioModuleSchema,
    targetId: z.string().min(1),
  }).strict()),
  caseDefinitions: z.array(z.object({
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    module: scenarioModuleSchema,
    version: z.string().min(1),
  }).strict()).min(1),
  catalogHash: z.string().regex(/^[a-f0-9]{64}$/),
  compiler: z.object({
    id: z.literal('clinmesh-scenario-catalog-compiler'),
    version: z.string().min(1),
  }).strict(),
  counts: z.object({
    requirements: z.object({
      criticalTruth: z.number().int().nonnegative(),
      explicitlyIgnored: z.number().int().nonnegative(),
      historyOnly: z.number().int().nonnegative(),
      workflowRequired: z.number().int().nonnegative(),
    }).strict(),
    resolutions: z.object({
      ambiguous: z.number().int().nonnegative(),
      hospitalNotEnabled: z.number().int().nonnegative(),
      mapped: z.number().int().nonnegative(),
      missing: z.number().int().nonnegative(),
      notApplicable: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  entries: z.array(z.object({
    generatedOccurrences: z.number().int().nonnegative().optional(),
    module: z.union([scenarioModuleSchema, z.literal('baseline-workflow')]),
    requirement: z.enum([
      'critical-truth',
      'workflow-required',
      'history-only',
      'explicitly-ignored',
    ]),
    resolution: z.enum([
      'ambiguous',
      'hospital-not-enabled',
      'mapped',
      'missing',
      'not-applicable',
    ]),
    source: z.union([
      z.object({
        code: z.string().min(1),
        display: z.string().min(1),
        system: z.string().min(1),
        version: z.string().min(1).optional(),
      }).strict(),
      z.object({ resourceType: z.string().min(1) }).strict(),
    ]).optional(),
    staticOccurrences: z.number().int().nonnegative().optional(),
    targetId: z.string().min(1).optional(),
  }).strict()),
  hospitalBaselineHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceInventory: z.object({
    generatedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    generatedCorpusHash: z.string().regex(/^[a-f0-9]{64}$/),
    generatedPatientCount: z.number().int().positive(),
    staticContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    syntheaCommit: z.string().regex(/^[a-f0-9]{40}$/),
  }).strict(),
  supported: z.boolean(),
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
  registrationAvailable: z.boolean().optional(),
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

export const scenarioInvestigationCatalogItemSchema = scenarioCatalogItemBaseSchema.extend({
  allowedIndicationCodes: z.array(z.string().min(1)).min(1),
  available: z.boolean(),
  category: z.enum(['examination', 'imaging', 'laboratory']),
  coding: scenarioLoincCodingSchema.optional(),
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
  unit: scenarioUcumUnitSchema.optional(),
  valueType: z.enum(['boolean', 'codeable', 'panel', 'quantity', 'string']),
}).strict()

const scenarioMedicationWorkflowSchema = z.object({
  allowedCombinationIds: z.array(z.string().min(1)),
  allowedCourseDays: z.array(z.number().int().positive()).min(1),
  allowedDiagnosisCodes: z.array(z.string().min(1)).min(1),
  allowedDoseTexts: z.array(z.string().min(1)).min(1),
  allowedFrequencyCodes: z.array(z.string().min(1)).min(1),
  allowedQuantities: z.array(z.number().int().positive()).min(1),
  defaultCourseDays: z.number().int().positive(),
  defaultQuantity: z.number().int().positive(),
}).strict()

const scenarioLegacyMedicationCatalogItemSchema = scenarioCatalogItemBaseSchema.extend({
  category: z.string().min(1),
  defaultDose: z.string().min(1),
  defaultFrequency: z.string().min(1),
  defaultRoute: z.string().min(1),
  dosageForm: z.string().min(1),
  restriction: z.string().min(1).nullable(),
  unit: z.string().min(1),
  workflow: scenarioMedicationWorkflowSchema,
}).strict()

export const scenarioProductMedicationCatalogItemSchema = scenarioLegacyMedicationCatalogItemSchema.extend({
  availableScopes: z.array(z.enum(['outpatient', 'inpatient'])).min(1),
  drugConcept: z.object({
    code: z.string().min(1),
    conceptId: z.string().min(1),
    display: z.string().min(1),
    kind: z.literal('drug-concept'),
    system: z.literal('urn:clinmesh:reference:drug-concept'),
    version: z.string().min(1),
  }).strict(),
  product: z.object({
    approvalNumber: z.string().min(1),
    brandName: z.string().min(1).nullable(),
    code: z.string().min(1),
    dosageForm: z.string().min(1),
    genericName: z.string().min(1),
    id: z.string().min(1),
    manufacturer: z.string().min(1),
    packageDescription: z.string().min(1),
    strength: z.string().min(1),
    system: z.literal('urn:clinmesh:reference:nhsa-medication-product'),
    version: z.string().min(1),
  }).strict(),
  regulatoryVerification: z.object({
    evidenceUrl: z.string().url(),
    result: z.literal('synthetic-match'),
    source: z.literal('nmpa-manual-check'),
    verifiedAt: z.iso.datetime({ offset: true }),
    verifiedFieldsHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
}).strict()

export const scenarioMedicationCatalogItemSchema = z.union([
  scenarioProductMedicationCatalogItemSchema,
  scenarioLegacyMedicationCatalogItemSchema,
])

const scenarioServiceValueCodingSchema = z.object({
  code: z.string().min(1),
  display: z.string().min(1),
  system: z.string().url(),
  valueSet: z.string().url(),
  version: z.string().min(1),
}).strict()

export const scenarioHospitalServiceCatalogItemSchema = scenarioCatalogItemBaseSchema.extend({
  availableScopes: z.array(z.enum(['outpatient', 'inpatient'])).min(1),
  billingUnit: scenarioServiceValueCodingSchema,
  category: scenarioServiceValueCodingSchema,
  chargeDefinition: z.object({
    currency: z.literal('CNY'),
    effectiveOn: localDateSchema,
    id: z.string().min(1),
    priceFen: z.number().int().nonnegative(),
  }).strict(),
  componentServiceIds: z.array(z.string().min(1)),
  executingDepartmentId: z.string().min(1),
  nationalService: z.object({
    code: z.string().min(1),
    display: z.string().min(1),
    id: z.string().min(1),
    system: z.literal('urn:clinmesh:reference:nhc-medical-service'),
    version: z.string().min(1),
  }).strict(),
  reportTemplate: z.string().min(1),
  requestCatalogItemIds: z.array(z.string().min(1)),
  tatMinutes: z.number().int().nonnegative(),
}).strict()

const scenarioResultValueSchema = z.union([z.boolean(), z.number(), z.string().min(1)])

export const scenarioInvestigationResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    flag: z.string().min(1).optional(),
    outcome: z.literal('reported'),
    referenceRange: z.string().min(1).optional(),
    unit: scenarioUcumUnitSchema.optional(),
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
  sourceDisplay: z.string().min(1).optional(),
  sourceSystem: z.string().url().optional(),
  sourceVersion: z.string().min(1).optional(),
  status: z.string().min(1),
}).strict()

const scenarioCodeSchema = z.object({
  code: z.string().min(1).optional(),
  display: z.string().min(1),
  system: z.string().url().optional(),
  version: z.string().min(1).optional(),
}).strict()

const scenarioMedicationHistoryCodingSchema = z.union([
  scenarioCodeSchema.extend({
    conceptId: z.string().min(1),
    kind: z.literal('drug-concept'),
  }).strict(),
  scenarioCodeSchema.extend({
    sourceCodings: z.array(scenarioCodeSchema).min(2),
  }).strict(),
  scenarioCodeSchema,
])

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
    medication: scenarioMedicationHistoryCodingSchema,
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

export const scenarioPhysiologyGeneratorSchema = z.discriminatedUnion('kind', [
  z.object({
    assayCv: z.number().nonnegative().max(1).optional(),
    id: z.string().min(1),
    kind: z.literal('constant'),
    source: z.string().min(1),
    unit: scenarioUcumUnitSchema,
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
    unit: scenarioUcumUnitSchema,
  }).strict(),
  z.object({
    assayCv: z.number().nonnegative().max(1),
    id: z.string().min(1),
    kind: z.literal('trajectory'),
    maximum: z.number(),
    minimum: z.number(),
    source: z.string().min(1),
    target: z.number(),
    unit: scenarioUcumUnitSchema,
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
    unit: scenarioUcumUnitSchema,
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
    services: z.array(scenarioHospitalServiceCatalogItemSchema).optional(),
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
    catalogCompilation: scenarioCatalogCompilationReportSchema.optional(),
    clinicalSeed: z.number().int(),
    configHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    generator: z.string().min(1),
    generatorVersion: z.string().min(1).optional(),
    modules: z.array(z.string().min(1)),
    populationSeed: z.number().int(),
    referenceData: referenceDataProvenanceSchema.optional(),
    timeRange: z.object({ end: localDateSchema, start: localDateSchema }).strict(),
    timeZone: z.string().min(1),
  }).strict(),
  revealPolicies: z.array(z.object({
    code: z.string().min(1),
    factCode: z.string().min(1),
    patientId: z.string().min(1).optional(),
    triggerId: z.string().min(1).optional(),
    triggerCode: z.enum([
      'after-topic',
      'evaluator-only',
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
  modules: z.array(scenarioModuleSchema),
  providerId: z.enum(['builtin', 'synthea']),
  providerName: z.string().min(1),
  unavailableReason: z.string().min(1).optional(),
}).strict()

export const scenarioProviderCapabilitiesListSchema = z.object({
  items: z.array(scenarioProviderCapabilitiesSchema),
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

export const syntheticPatientIdentitySchema = z.object({
  address: z.string().min(1).max(500),
  displayName: z.string().min(1).max(100),
  email: z.string().email().max(200),
  insuranceDisplay: z.string().min(1).max(100),
  mrn: z.string().min(1).max(64),
  nationalId: z.string().regex(/^\d{17}[\dX]$/),
  phone: z.string().regex(/^1\d{10}$/),
}).strict()

const syntheticPatientSourceSchema = z.object({
  batchId: z.string().min(1),
  batchName: z.string().min(1),
  compilation: z.object({
    modules: z.array(scenarioModuleSchema).min(1),
    ordinal: z.number().int().nonnegative(),
    seeds: z.object({
      clinical: z.number().int(),
      population: z.number().int(),
    }).strict(),
    timeRange: z.object({ end: localDateSchema, start: localDateSchema }).strict(),
    timeZone: z.literal('Asia/Shanghai'),
  }).strict().nullable(),
  format: z.enum(['clinmesh-template', 'fhir-r4-bundle', 'legacy-compiled-profile']),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  mappingProvenance: z.object({
    compiler: z.object({
      id: z.string().min(1).max(128),
      version: z.string().min(1).max(128),
    }).strict(),
    overlayRevision: z.number().int().positive().optional(),
    packages: z.array(referenceMappingPackageProvenanceSchema).min(1).max(20),
  }).strict().optional(),
  mappingVersion: z.string().min(1),
  patientId: z.string().min(1),
  providerId: z.enum(['builtin', 'synthea']),
  referenceData: referenceDataProvenanceSchema.optional(),
  raw: z.json().nullable(),
}).strict()

const syntheticPatientProfileMappingSchema = z.object({
  sourceResourceId: z.string().min(1).max(128),
  sourceResourceType: z.enum([
    'Condition',
    'Encounter',
    'MedicationRequest',
    'Observation',
  ]),
  target: z.object({
    catalogItemId: z.string().min(1).max(128),
    code: z.string().min(1).max(128),
    system: z.string().url().optional(),
    version: z.number().int().positive(),
  }).strict(),
}).strict()

export const syntheticPatientProfileSchema = z.object({
  createdAt: z.iso.datetime({ offset: true }),
  identity: syntheticPatientIdentitySchema,
  mappings: z.array(syntheticPatientProfileMappingSchema).max(100),
  patient: scenarioPatientSchema,
  profileId: z.string().min(1),
  revision: z.number().int().positive(),
  source: syntheticPatientSourceSchema,
  updatedAt: z.iso.datetime({ offset: true }),
  workspaceId: z.string().min(1),
}).strict().superRefine((profile, context) => {
  const sourceIds = new Set<string>()
  profile.mappings.forEach((mapping, index) => {
    if (sourceIds.has(mapping.sourceResourceId)) {
      context.addIssue({
        code: 'custom',
        message: 'A source resource can have only one persisted mapping',
        path: ['mappings', index, 'sourceResourceId'],
      })
    }
    sourceIds.add(mapping.sourceResourceId)
  })
})

export const syntheticPatientProfileSummarySchema = z.object({
  activeVisit: z.boolean(),
  allergyCount: z.number().int().nonnegative(),
  batchId: z.string().min(1),
  batchName: z.string().min(1),
  birthDate: localDateSchema,
  chronicConditions: z.array(z.string().min(1)),
  createdAt: z.iso.datetime({ offset: true }),
  gender: z.enum(['female', 'male', 'other', 'unknown']),
  historyCount: z.number().int().nonnegative(),
  mappingWarningCount: z.number().int().nonnegative(),
  mrn: z.string().min(1),
  name: z.string().min(1),
  profileId: z.string().min(1),
  providerId: z.enum(['builtin', 'synthea']),
  revision: z.number().int().positive(),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict()

export const syntheticPatientProfileListSchema = z.object({
  items: z.array(syntheticPatientProfileSummarySchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive().max(100),
  total: z.number().int().nonnegative(),
}).strict()

export const syntheticPatientMappingCatalogSchema = z.object({
  items: z.array(z.object({
    catalogItemId: z.string().min(1).max(128),
    code: z.string().min(1).max(128),
    nameEn: z.string().min(1).max(200),
    nameZh: z.string().min(1).max(200),
    sourceResourceType: z.enum([
      'Condition',
      'Encounter',
      'MedicationRequest',
      'Observation',
    ]),
    system: z.string().url().optional(),
    version: z.number().int().positive(),
  }).strict()),
}).strict()

export const updateSyntheticPatientProfileRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
  input: syntheticPatientIdentitySchema,
}).strict()

export const updateSyntheticPatientMappingsRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
  input: z.array(z.object({
    sourceResourceId: z.string().min(1).max(128),
    target: z.object({
      catalogItemId: z.string().min(1).max(128),
      version: z.number().int().positive(),
    }).strict().nullable(),
  }).strict()).min(1).max(100),
}).strict().superRefine((value, context) => {
  const sourceIds = new Set<string>()
  value.input.forEach((mapping, index) => {
    if (sourceIds.has(mapping.sourceResourceId)) {
      context.addIssue({
        code: 'custom',
        message: 'A source resource can be mapped only once',
        path: ['input', index, 'sourceResourceId'],
      })
    }
    sourceIds.add(mapping.sourceResourceId)
  })
})

export const startSyntheticPatientVisitsRequestSchema = z.object({
  departmentId: z.string().min(1),
  locationId: z.string().min(1),
  patients: z.array(z.object({
    expectedRevision: z.number().int().positive(),
    profileId: z.string().min(1),
  }).strict()).min(1).max(10),
  visitDate: localDateSchema,
  visitTypeId: z.string().min(1),
}).strict().superRefine((value, context) => {
  const profileIds = new Set<string>()
  value.patients.forEach((patient, index) => {
    if (profileIds.has(patient.profileId)) {
      context.addIssue({
        code: 'custom',
        message: 'A Synthetic Patient Profile can appear only once',
        path: ['patients', index, 'profileId'],
      })
    }
    profileIds.add(patient.profileId)
  })
})

export const startSyntheticPatientVisitsResultSchema = z.object({
  items: z.array(z.object({
    encounterId: z.string().min(1),
    patientId: z.string().min(1),
    profileId: z.string().min(1),
    queueTaskId: z.string().min(1),
    registrationId: z.string().min(1),
    status: z.literal('awaiting-triage'),
  }).strict()).min(1).max(10),
}).strict()

export type ScenarioDataset = z.infer<typeof scenarioDatasetSchema>
export type ScenarioDatasetList = z.infer<typeof scenarioDatasetListSchema>
export type ScenarioDatasetContent = z.infer<typeof scenarioDatasetContentSchema>
export type ScenarioCatalogCompilationReport = z.infer<
  typeof scenarioCatalogCompilationReportSchema
>
export type ScenarioProductMedicationCatalogItem = z.infer<
  typeof scenarioProductMedicationCatalogItemSchema
>
export type ScenarioHospitalServiceCatalogItem = z.infer<
  typeof scenarioHospitalServiceCatalogItemSchema
>
export type ScenarioDiagnostic = z.infer<typeof scenarioDiagnosticSchema>
export type ScenarioGenerationRequest = z.infer<typeof scenarioGenerationRequestSchema>
export type ScenarioModule = z.infer<typeof scenarioModuleSchema>
export type ScenarioGenerationJob = z.infer<typeof scenarioGenerationJobSchema>
export type ScenarioInvestigationResult = z.infer<typeof scenarioInvestigationResultSchema>
export type ScenarioPatient = z.infer<typeof scenarioPatientSchema>
export type ScenarioProviderCapabilities = z.infer<typeof scenarioProviderCapabilitiesSchema>
export type SyntheticPatientIdentity = z.infer<typeof syntheticPatientIdentitySchema>
export type SyntheticPatientMappingCatalog = z.infer<typeof syntheticPatientMappingCatalogSchema>
export type SyntheticPatientMappingInput = z.infer<typeof updateSyntheticPatientMappingsRequestSchema>['input'][number]
export type SyntheticPatientProfile = z.infer<typeof syntheticPatientProfileSchema>
export type SyntheticPatientProfileList = z.infer<typeof syntheticPatientProfileListSchema>
export type SyntheticPatientProfileSummary = z.infer<typeof syntheticPatientProfileSummarySchema>
