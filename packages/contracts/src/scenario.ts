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

const scenarioCatalogItemSchema = z.object({
  code: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  priceFen: z.number().int().nonnegative(),
}).strict()

const scenarioPatientSchema = z.object({
  birthDate: localDateSchema,
  diagnosisSpace: z.record(z.string(), z.unknown()),
  examinationFindings: z.record(z.string(), z.unknown()),
  gender: z.enum(['female', 'male', 'other', 'unknown']),
  id: z.string().min(1),
  investigations: z.array(z.record(z.string(), z.unknown())),
  longitudinalHistory: z.array(z.record(z.string(), z.unknown())),
  managementSpace: z.record(z.string(), z.unknown()),
  name: z.string().min(1),
  patientKnowledge: z.record(z.string(), z.unknown()),
  physiologyBaseline: z.record(z.string(), z.unknown()),
  symptomResponses: z.array(z.record(z.string(), z.unknown())),
}).strict()

export const scenarioDatasetContentSchema = z.object({
  catalog: z.object({
    departments: z.array(scenarioCatalogItemSchema),
    investigations: z.array(scenarioCatalogItemSchema),
    medications: z.array(scenarioCatalogItemSchema),
  }).strict(),
  hiddenFacts: z.array(z.object({
    code: z.string().min(1),
    value: z.unknown(),
  }).strict()),
  hospital: z.object({
    id: z.string().min(1),
    locale: z.literal('zh-CN'),
    name: z.string().min(1),
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
    generator: z.string().min(1),
    modules: z.array(z.string().min(1)),
    populationSeed: z.number().int(),
    timeRange: z.object({ end: localDateSchema, start: localDateSchema }).strict(),
    timeZone: z.string().min(1),
  }).strict(),
  revealPolicies: z.array(z.record(z.string(), z.unknown())),
  schemaVersion: z.literal('1'),
  simulatorRules: z.array(z.record(z.string(), z.unknown())),
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

export type ScenarioDataset = z.infer<typeof scenarioDatasetSchema>
export type ScenarioDatasetList = z.infer<typeof scenarioDatasetListSchema>
export type ScenarioDatasetContent = z.infer<typeof scenarioDatasetContentSchema>
export type ScenarioDiagnostic = z.infer<typeof scenarioDiagnosticSchema>
export type ScenarioGenerationRequest = z.infer<typeof scenarioGenerationRequestSchema>
export type ScenarioProviderCapabilities = z.infer<typeof scenarioProviderCapabilitiesSchema>
