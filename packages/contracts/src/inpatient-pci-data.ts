import { z } from 'zod'
import { commandResponseSchema, laboratoryServiceSnapshotSchema } from './his.ts'
import { referenceConceptSnapshotSchema, referenceMedicationProductSchema } from './reference-data.ts'
import { inpatientMaterialItemSchema, inpatientProcedureItemSchema } from './inpatient-surgery.ts'

const id = z.string().min(1).max(128)
const amount = z.number().int().positive().safe()
const synthetic = z.literal(true)

export const inpatientPciMedicationDataSchema = z.object({
  id,
  product: referenceMedicationProductSchema,
  referenceReleaseId: id,
  hospitalSupplement: z.object({
    synthetic,
    unit: z.string().min(1),
    priceFen: amount,
    doseBasis: z.object({ amount: z.number().positive().finite(), unit: z.string().min(1) }).strict(),
    maxDoseQuantity: amount,
    suggestedDoseText: z.string().min(1),
    suggestedQuantity: amount,
    frequencyCodes: z.array(z.enum(['QD', 'BID', 'PRN'])).min(1),
    route: z.string().min(1),
    initialStock: amount,
    note: z.string().min(1),
  }).strict(),
  sourceQuotation: z.object({
    recordId: id,
    sourceLocator: z.string().min(1),
    priceFen: amount,
    unit: z.null(),
    basis: z.literal('denominator_unverified'),
    original: z.record(z.string(), z.json()),
  }).strict().optional(),
}).strict()

export const inpatientPciDataPackageSchema = z.object({
  id,
  version: id,
  synthetic,
  caseDraft: z.object({
    id,
    name: z.string().min(1),
    birthDate: z.iso.date(),
    gender: z.literal('male'),
    chiefComplaint: z.string().min(1),
    history: z.string().min(1),
    baselineObservations: z.array(z.object({
      coding: referenceConceptSnapshotSchema,
      value: z.number().finite(),
      unit: z.string().min(1),
    }).strict()),
    plannedStentCount: z.literal(1),
    intendedUse: z.literal('authoring-only'),
  }).strict(),
  diagnosis: referenceConceptSnapshotSchema,
  procedures: z.array(inpatientProcedureItemSchema).min(1),
  groupingTarget: z.object({
    code: z.literal('FM39'),
    status: z.literal('target-only'),
    note: z.string().min(1),
  }).strict(),
  medications: z.array(inpatientPciMedicationDataSchema),
  materials: z.array(z.object({
    item: inpatientMaterialItemSchema,
    hospitalSupplement: z.object({ synthetic, specification: z.string().min(1), note: z.string().min(1) }).strict(),
  }).strict()),
  laboratories: z.array(laboratoryServiceSnapshotSchema),
  paymentParameters: z.object({
    parameterSetId: id,
    version: id,
    synthetic,
    baseRateFen: amount,
    weightsBp: z.object({ FM39: amount }).strict(),
    note: z.string().min(1),
  }).strict(),
  note: z.string().min(1),
}).strict()

export const inpatientPciDataSchema = z.object({
  package: inpatientPciDataPackageSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  installed: z.object({
    medications: z.array(z.object({
      definitionId: id,
      catalogItemId: id,
      version: amount,
      active: z.boolean(),
      priceFen: z.number().int().nonnegative().safe(),
      unit: z.string().nullable(),
      availableScopes: z.array(z.string()),
      conflicts: z.array(z.enum(['inactive', 'scope-disabled', 'unit-mismatch', 'indication-restricted', 'combination-restricted', 'frequency-restricted', 'unpriced', 'invalid-configuration'])),
      lots: z.array(z.object({ id, version: amount, quantityOnHand: z.number().int().nonnegative(), expiresOn: z.iso.date() }).strict()),
    }).strict()),
    laboratories: z.array(z.object({ definitionId: id, catalogItemId: id, version: amount }).strict()),
    materialIds: z.array(id),
  }).strict(),
}).strict()

export const inpatientPciDataPrepareRequestSchema = z.object({
  input: z.object({ expectedEpoch: id }).strict(),
}).strict()
export const inpatientPciDataResponseSchema = commandResponseSchema(inpatientPciDataSchema)
export type InpatientPciDataPackage = z.infer<typeof inpatientPciDataPackageSchema>
