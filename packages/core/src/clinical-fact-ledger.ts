import {
  DEFAULT_CLINICAL_FACT_HOSPITAL_ID,
  DEFAULT_CLINICAL_FACT_MAPPING_VERSION,
  type ClinicalFact,
  type ClinicalFactCategory,
  type ClinicalFactItemCode,
  type ClinicalFactLedger,
  type ClinicalFactPresence,
  type ClinicalFactQualityFlag,
  type ClinicalFactRecordStatus,
  type ClinicalFactSpecimenOrSite,
  type ClinicalFactSubjectKind,
  type ClinicalFactSuspiciousReason,
  type ClinicalFactValue,
  type ClinicalFactVerificationRecord,
  type ClinicalFactVerificationStatus,
} from '@clinmesh/contracts/clinical-fact-ledger'
import type { ClinicalRiskAssessmentValues } from '@clinmesh/contracts/clinical-scores'

export const CLINICAL_FACT_MAPPING_VERSION = DEFAULT_CLINICAL_FACT_MAPPING_VERSION
const LOINC_SYSTEM = 'http://loinc.org'
const CLINMESH_CONCEPT_SYSTEM = 'urn:clinmesh:concept'
const CLINMESH_RISK_SYSTEM = 'urn:clinmesh:clinical-risk-assessment'

const DAY_MS = 86_400_000
const NUMBER_EPSILON = 1e-6

interface CanonicalConceptSpec {
  canonicalCode: string
  system: string
  display: string
  categoryHint?: ClinicalFactCategory
  method?: string
  validityDays: number | null
  allowedUnits?: readonly string[]
  canonicalUnit?: string
  normalize?: (value: number, normalizedUnit: string) => number
  plausibleRange?: { min: number; max: number }
  sexRestriction?: 'female' | 'male'
  aliases: readonly string[]
}

function normalizeUnitToken(rawUnit: string): string {
  const trimmed = rawUnit.trim().replaceAll('µ', 'u').replaceAll('μ', 'u')
  const lower = trimmed.toLowerCase()
  if (lower === 'mg/dl') return 'mg/dL'
  if (lower === 'umol/l') return 'umol/L'
  if (lower === 'mmol/l') return 'mmol/L'
  if (lower === 'meq/l') return 'mEq/L'
  if (lower === 'g/dl') return 'g/dL'
  if (lower === 'g/l') return 'g/L'
  if (lower === 'ng/l' || lower === 'pg/ml') return 'ng/L'
  if (lower === 'ng/ml' || lower === 'ug/l') return 'ng/mL'
  if (lower === 'iu/l' || lower === 'u/l') return 'U/L'
  if (lower === 'miu/ml') return 'mIU/mL'
  if (lower === '10*9/l' || lower === '10^9/l' || lower === 'x10^9/l' || lower === 'k/ul') return '10*9/L'
  if (lower === '10*12/l' || lower === '10^12/l') return '10*12/L'
  if (lower === 'mm[hg]' || lower === 'mmhg') return 'mmHg'
  if (lower === 'cel' || lower === '°c' || lower === 'c') return 'Cel'
  if (lower === '/min' || lower === 'beats/min' || lower === 'bpm' || lower === 'breaths/min') return '/min'
  if (lower === '%') return '%'
  if (lower === 'kg') return 'kg'
  if (lower === 'cm') return 'cm'
  return trimmed
}

const CANONICAL_CONCEPT_SPECS: readonly CanonicalConceptSpec[] = [
  {
    canonicalCode: '2160-0',
    system: LOINC_SYSTEM,
    display: '血清肌酐',
    categoryHint: 'laboratory',
    validityDays: 90,
    allowedUnits: ['mg/dL', 'umol/L'],
    canonicalUnit: 'mg/dL',
    normalize: (value, unit) => (unit === 'mg/dL' ? value : value / 88.4),
    plausibleRange: { min: 0.1, max: 30 },
    aliases: ['2160-0', '14682-9', '1700404A'],
  },
  {
    canonicalCode: '89579-7',
    system: LOINC_SYSTEM,
    display: '高敏肌钙蛋白I (hs-cTnI)',
    categoryHint: 'laboratory',
    method: 'hs-cTnI',
    validityDays: 7,
    allowedUnits: ['ng/L', 'ng/mL'],
    canonicalUnit: 'ng/L',
    normalize: (value, unit) => (unit === 'ng/L' ? value : value * 1000),
    plausibleRange: { min: 0, max: 1_000_000 },
    aliases: ['89579-7', '49563-0', '2100404B'],
  },
  {
    canonicalCode: '10839-9',
    system: LOINC_SYSTEM,
    display: '肌钙蛋白I (常规 cTnI)',
    categoryHint: 'laboratory',
    method: 'cTnI',
    validityDays: 7,
    allowedUnits: ['ng/mL', 'ng/L'],
    canonicalUnit: 'ng/mL',
    normalize: (value, unit) => (unit === 'ng/mL' ? value : value / 1000),
    plausibleRange: { min: 0, max: 1_000 },
    aliases: ['10839-9', '6598-7', '2100404A'],
  },
  {
    canonicalCode: '6597-9',
    system: LOINC_SYSTEM,
    display: '肌钙蛋白T (cTnT)',
    categoryHint: 'laboratory',
    method: 'cTnT',
    validityDays: 7,
    allowedUnits: ['ng/L', 'ng/mL'],
    canonicalUnit: 'ng/L',
    normalize: (value, unit) => (unit === 'ng/L' ? value : value * 1000),
    plausibleRange: { min: 0, max: 1_000_000 },
    aliases: ['6597-9', '67151-1', '42757-5', '2100504A'],
  },
  {
    canonicalCode: '4548-4',
    system: LOINC_SYSTEM,
    display: '糖化血红蛋白 (HbA1c)',
    categoryHint: 'laboratory',
    validityDays: 90,
    allowedUnits: ['%'],
    canonicalUnit: '%',
    normalize: value => value,
    plausibleRange: { min: 2, max: 25 },
    aliases: ['4548-4', '17856-6', '1100301A'],
  },
  {
    canonicalCode: '2093-3',
    system: LOINC_SYSTEM,
    display: '总胆固醇 (TC)',
    categoryHint: 'laboratory',
    validityDays: 180,
    allowedUnits: ['mmol/L', 'mg/dL'],
    canonicalUnit: 'mmol/L',
    normalize: (value, unit) => (unit === 'mmol/L' ? value : value / 38.67),
    plausibleRange: { min: 1, max: 25 },
    aliases: ['2093-3', '1700301A'],
  },
  {
    canonicalCode: '2085-9',
    system: LOINC_SYSTEM,
    display: '高密度脂蛋白胆固醇 (HDL-C)',
    categoryHint: 'laboratory',
    validityDays: 180,
    allowedUnits: ['mmol/L', 'mg/dL'],
    canonicalUnit: 'mmol/L',
    normalize: (value, unit) => (unit === 'mmol/L' ? value : value / 38.67),
    plausibleRange: { min: 0.2, max: 5 },
    aliases: ['2085-9', '1700302A'],
  },
  {
    canonicalCode: '13457-7',
    system: LOINC_SYSTEM,
    display: '低密度脂蛋白胆固醇 (LDL-C)',
    categoryHint: 'laboratory',
    validityDays: 180,
    allowedUnits: ['mmol/L', 'mg/dL'],
    canonicalUnit: 'mmol/L',
    normalize: (value, unit) => (unit === 'mmol/L' ? value : value / 38.67),
    plausibleRange: { min: 0.2, max: 20 },
    aliases: ['13457-7', '18262-6', '2089-1', '1700303A'],
  },
  {
    canonicalCode: '2571-8',
    system: LOINC_SYSTEM,
    display: '甘油三酯 (TG)',
    categoryHint: 'laboratory',
    validityDays: 180,
    allowedUnits: ['mmol/L', 'mg/dL'],
    canonicalUnit: 'mmol/L',
    normalize: (value, unit) => (unit === 'mmol/L' ? value : value / 88.57),
    plausibleRange: { min: 0.1, max: 50 },
    aliases: ['2571-8', '1700304A'],
  },
  {
    canonicalCode: '718-7',
    system: LOINC_SYSTEM,
    display: '血红蛋白 (Hb)',
    categoryHint: 'laboratory',
    validityDays: 30,
    allowedUnits: ['g/dL', 'g/L'],
    canonicalUnit: 'g/dL',
    normalize: (value, unit) => (unit === 'g/dL' ? value : value / 10),
    plausibleRange: { min: 2, max: 25 },
    aliases: ['718-7'],
  },
  {
    canonicalCode: '6690-2',
    system: LOINC_SYSTEM,
    display: '白细胞计数 (WBC)',
    categoryHint: 'laboratory',
    validityDays: 14,
    allowedUnits: ['10*9/L'],
    canonicalUnit: '10*9/L',
    normalize: value => value,
    plausibleRange: { min: 0.1, max: 200 },
    aliases: ['6690-2', '26464-8'],
  },
  {
    canonicalCode: '2823-3',
    system: LOINC_SYSTEM,
    display: '血清钾 (K+)',
    categoryHint: 'laboratory',
    validityDays: 14,
    allowedUnits: ['mmol/L', 'mEq/L'],
    canonicalUnit: 'mmol/L',
    normalize: value => value,
    plausibleRange: { min: 1.5, max: 10 },
    aliases: ['2823-3'],
  },
  {
    canonicalCode: '2951-2',
    system: LOINC_SYSTEM,
    display: '血清钠 (Na+)',
    categoryHint: 'laboratory',
    validityDays: 14,
    allowedUnits: ['mmol/L', 'mEq/L'],
    canonicalUnit: 'mmol/L',
    normalize: value => value,
    plausibleRange: { min: 90, max: 200 },
    aliases: ['2951-2'],
  },
  {
    canonicalCode: '21198-7',
    system: LOINC_SYSTEM,
    display: '人绒毛膜促性腺激素/妊娠试验 (hCG)',
    categoryHint: 'laboratory',
    validityDays: 7,
    allowedUnits: ['mIU/mL', 'U/L'],
    canonicalUnit: 'mIU/mL',
    normalize: value => value,
    plausibleRange: { min: 0, max: 1_000_000 },
    sexRestriction: 'female',
    aliases: ['21198-7', '2118-8', '2119-6', '19080-1', '2106-3', '82810-3'],
  },
  {
    canonicalCode: '2857-1',
    system: LOINC_SYSTEM,
    display: '前列腺特异性抗原 (PSA)',
    categoryHint: 'laboratory',
    validityDays: 90,
    allowedUnits: ['ng/mL', 'ng/L'],
    canonicalUnit: 'ng/mL',
    normalize: (value, unit) => (unit === 'ng/mL' ? value : value / 1000),
    plausibleRange: { min: 0, max: 10_000 },
    sexRestriction: 'male',
    aliases: ['2857-1'],
  },
  {
    canonicalCode: '8310-5',
    system: LOINC_SYSTEM,
    display: '体温',
    categoryHint: 'vital-sign',
    validityDays: 7,
    allowedUnits: ['Cel'],
    canonicalUnit: 'Cel',
    normalize: value => value,
    plausibleRange: { min: 30, max: 45 },
    aliases: ['8310-5'],
  },
  {
    canonicalCode: '8867-4',
    system: LOINC_SYSTEM,
    display: '心率/脉搏',
    categoryHint: 'vital-sign',
    validityDays: 7,
    allowedUnits: ['/min'],
    canonicalUnit: '/min',
    normalize: value => value,
    plausibleRange: { min: 20, max: 300 },
    aliases: ['8867-4'],
  },
  {
    canonicalCode: '9279-1',
    system: LOINC_SYSTEM,
    display: '呼吸频率',
    categoryHint: 'vital-sign',
    validityDays: 7,
    allowedUnits: ['/min'],
    canonicalUnit: '/min',
    normalize: value => value,
    plausibleRange: { min: 4, max: 80 },
    aliases: ['9279-1'],
  },
  {
    canonicalCode: '8480-6',
    system: LOINC_SYSTEM,
    display: '收缩压',
    categoryHint: 'vital-sign',
    validityDays: 7,
    allowedUnits: ['mmHg'],
    canonicalUnit: 'mmHg',
    normalize: value => value,
    plausibleRange: { min: 40, max: 300 },
    aliases: ['8480-6'],
  },
  {
    canonicalCode: '8462-4',
    system: LOINC_SYSTEM,
    display: '舒张压',
    categoryHint: 'vital-sign',
    validityDays: 7,
    allowedUnits: ['mmHg'],
    canonicalUnit: 'mmHg',
    normalize: value => value,
    plausibleRange: { min: 20, max: 200 },
    aliases: ['8462-4'],
  },
  {
    canonicalCode: '59408-5',
    system: LOINC_SYSTEM,
    display: '经皮血氧饱和度 (SpO2)',
    categoryHint: 'vital-sign',
    validityDays: 7,
    allowedUnits: ['%'],
    canonicalUnit: '%',
    normalize: value => value,
    plausibleRange: { min: 40, max: 100 },
    aliases: ['59408-5'],
  },
  {
    canonicalCode: '29463-7',
    system: LOINC_SYSTEM,
    display: '体重',
    categoryHint: 'vital-sign',
    validityDays: 7,
    allowedUnits: ['kg'],
    canonicalUnit: 'kg',
    normalize: value => value,
    plausibleRange: { min: 1, max: 400 },
    aliases: ['29463-7'],
  },
  {
    canonicalCode: '8302-2',
    system: LOINC_SYSTEM,
    display: '身高',
    categoryHint: 'vital-sign',
    validityDays: 7,
    allowedUnits: ['cm'],
    canonicalUnit: 'cm',
    normalize: value => value,
    plausibleRange: { min: 30, max: 260 },
    aliases: ['8302-2'],
  },
  {
    canonicalCode: '11524-6',
    system: LOINC_SYSTEM,
    display: '十二导联心电图',
    categoryHint: 'examination',
    validityDays: null,
    aliases: ['11524-6', 'ECG-12', 'examination-ecg-12-lead'],
  },
  {
    canonicalCode: '48065-7',
    system: LOINC_SYSTEM,
    display: 'D-二聚体',
    categoryHint: 'laboratory',
    validityDays: 7,
    aliases: ['48065-7', '0501703A'],
  },
]

const CONCEPT_BY_ALIAS = new Map<string, CanonicalConceptSpec>()
for (const spec of CANONICAL_CONCEPT_SPECS) {
  for (const alias of spec.aliases) {
    CONCEPT_BY_ALIAS.set(alias, spec)
  }
}

export const PUBLIC_VALIDITY_DAYS_BY_ITEM_CODE: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    CANONICAL_CONCEPT_SPECS
      .filter((spec): spec is CanonicalConceptSpec & { validityDays: number } => spec.validityDays !== null)
      .map(spec => [spec.canonicalCode, spec.validityDays]),
  ),
)

export function resolveCanonicalItemCode(rawCode: string): string {
  return CONCEPT_BY_ALIAS.get(rawCode)?.canonicalCode ?? rawCode
}

export function getPublicValidityDays(itemCode: string): number | null {
  const canonical = resolveCanonicalItemCode(itemCode)
  return Object.hasOwn(PUBLIC_VALIDITY_DAYS_BY_ITEM_CODE, canonical)
    ? PUBLIC_VALIDITY_DAYS_BY_ITEM_CODE[canonical]!
    : null
}

export function tightenValidityDays(itemCode: string, overrideDays: number): number {
  if (!Number.isInteger(overrideDays) || overrideDays < 1) {
    throw new Error(`Validity days override must be a positive integer, received ${String(overrideDays)}`)
  }
  const canonical = resolveCanonicalItemCode(itemCode)
  const publicDefault = getPublicValidityDays(canonical)
  if (publicDefault !== null && overrideDays > publicDefault) {
    throw new Error(
      `Cannot loosen validity window for ${canonical}: override (${overrideDays}d) exceeds public default (${publicDefault}d)`,
    )
  }
  return overrideDays
}

export interface FhirCodingLike {
  code?: string | undefined
  system?: string | undefined
  display?: string | undefined
}

export interface FhirCodeableConceptLike {
  coding?: readonly FhirCodingLike[] | undefined
  text?: string | undefined
}

export interface FhirQuantityLike {
  value?: number | undefined
  unit?: string | undefined
  code?: string | undefined
  system?: string | undefined
}

export interface FhirReferenceRangeLike {
  low?: FhirQuantityLike | undefined
  high?: FhirQuantityLike | undefined
  text?: string | undefined
}

export interface FhirObservationComponentLike {
  code?: FhirCodeableConceptLike
  valueQuantity?: FhirQuantityLike
  valueCodeableConcept?: FhirCodeableConceptLike
  valueString?: string
  valueBoolean?: boolean
  valueInteger?: number
  interpretation?: readonly FhirCodeableConceptLike[]
  referenceRange?: readonly FhirReferenceRangeLike[]
}

export interface FhirObservationLike {
  resourceType?: 'Observation'
  id: string
  status: string
  category?: readonly FhirCodeableConceptLike[]
  code?: FhirCodeableConceptLike
  effectiveDateTime?: string
  issued?: string
  valueQuantity?: FhirQuantityLike
  valueCodeableConcept?: FhirCodeableConceptLike
  valueString?: string
  valueBoolean?: boolean
  valueInteger?: number
  interpretation?: readonly FhirCodeableConceptLike[]
  referenceRange?: readonly FhirReferenceRangeLike[]
  component?: readonly FhirObservationComponentLike[]
  specimen?: { reference?: string; display?: string }
  bodySite?: FhirCodeableConceptLike
  method?: FhirCodeableConceptLike
  basedOn?: readonly { reference?: string }[]
  meta?: { versionId?: string; lastUpdated?: string }
}

export interface FhirDiagnosticReportLike {
  resourceType?: 'DiagnosticReport'
  id: string
  status: string
  category?: readonly FhirCodeableConceptLike[]
  code?: FhirCodeableConceptLike
  effectiveDateTime?: string
  issued?: string
  conclusion?: string
  conclusionCode?: readonly FhirCodeableConceptLike[]
  result?: readonly { reference?: string }[]
  basedOn?: readonly { reference?: string }[]
  specimen?: readonly { reference?: string; display?: string }[]
  meta?: { versionId?: string; lastUpdated?: string }
}

export interface FhirConditionLike {
  resourceType?: 'Condition'
  id: string
  clinicalStatus?: FhirCodeableConceptLike
  verificationStatus?: FhirCodeableConceptLike
  code?: FhirCodeableConceptLike
  onsetDateTime?: string
  recordedDate?: string
  note?: readonly { text?: string }[]
  meta?: { versionId?: string; lastUpdated?: string }
}

export interface FhirAllergyIntoleranceLike {
  resourceType?: 'AllergyIntolerance'
  id: string
  clinicalStatus?: FhirCodeableConceptLike
  verificationStatus?: FhirCodeableConceptLike
  code?: FhirCodeableConceptLike
  recordedDate?: string
  reaction?: readonly { manifestation?: readonly FhirCodeableConceptLike[]; severity?: string }[]
  meta?: { versionId?: string; lastUpdated?: string }
}

export interface FhirMedicationLike {
  resourceType: 'MedicationRequest' | 'MedicationAdministration' | 'MedicationDispense'
  id: string
  status: string
  medicationCodeableConcept?: FhirCodeableConceptLike
  medicationReference?: { display?: string }
  authoredOn?: string
  effectiveDateTime?: string
  effectivePeriod?: { start?: string; end?: string }
  occurrenceDateTime?: string
  whenHandedOver?: string
  dosageInstruction?: readonly { text?: string }[]
  dosage?: { text?: string; dose?: FhirQuantityLike }
  meta?: { versionId?: string; lastUpdated?: string }
}

export interface FhirProcedureLike {
  resourceType?: 'Procedure'
  id: string
  status: string
  code?: FhirCodeableConceptLike
  performedDateTime?: string
  performedPeriod?: { start?: string; end?: string }
  occurrenceDateTime?: string
  recorded?: string
  outcome?: FhirCodeableConceptLike
  meta?: { versionId?: string; lastUpdated?: string }
}

export interface LocalFhirTranscriptionInput {
  observations?: readonly FhirObservationLike[]
  diagnosticReports?: readonly FhirDiagnosticReportLike[]
  conditions?: readonly FhirConditionLike[]
  allergyIntolerances?: readonly FhirAllergyIntoleranceLike[]
  medications?: readonly FhirMedicationLike[]
  procedures?: readonly FhirProcedureLike[]
  orderedAtByObservationId?: Readonly<Record<string, string>>
  orderedAtByReportId?: Readonly<Record<string, string>>
  orderedAtByRequestRef?: Readonly<Record<string, string>>
  specimenLabelById?: Readonly<Record<string, string>>
  supersedesObservationId?: Readonly<Record<string, string>>
  supersedesReportId?: Readonly<Record<string, string>>
  mappingVersion?: string
  sourceSystemId?: string
  sourceSystemIdByObservationId?: Readonly<Record<string, string>>
  ingestedAtByObservationId?: Readonly<Record<string, string>>
}

export interface VisibleSourceObservationFieldsLike {
  code?: FhirCodeableConceptLike | undefined
  interpretation?: readonly FhirCodeableConceptLike[] | undefined
  referenceRange?: readonly FhirReferenceRangeLike[] | undefined
  valueBoolean?: boolean | undefined
  valueCodeableConcept?: FhirCodeableConceptLike | undefined
  valueDateTime?: string | undefined
  valueInteger?: number | undefined
  valueQuantity?: FhirQuantityLike | undefined
  valueString?: string | undefined
}

export interface VisibleSourceClinicalLike extends VisibleSourceObservationFieldsLike {
  authoredOn?: string | undefined
  bodySite?: FhirCodeableConceptLike | readonly FhirCodeableConceptLike[] | undefined
  component?: readonly VisibleSourceObservationFieldsLike[] | undefined
  conclusion?: string | undefined
  dosageInstruction?: readonly { text?: string | undefined }[] | undefined
  effectiveDateTime?: string | undefined
  effectivePeriod?: { start?: string | undefined; end?: string | undefined } | undefined
  issued?: string | undefined
  medicationCodeableConcept?: FhirCodeableConceptLike | undefined
  medicationReference?: { display?: string | undefined } | undefined
  occurrenceDateTime?: string | undefined
  onsetDateTime?: string | undefined
  performedDateTime?: string | undefined
  recordedDate?: string | undefined
  status?: string | undefined
  title?: string | undefined
  vaccineCode?: FhirCodeableConceptLike | undefined
  verificationStatus?: FhirCodeableConceptLike | undefined
}

export interface VisibleSourceHistoryEntryInput {
  entryId: string
  sourceReference: string
  resourceType: string
  clinicalDate: string
  title: string
  ingestedAt?: string | undefined
  recordVersion?: string | undefined
  specimen?: { reference?: string | undefined; display?: string | undefined } | undefined
  clinical: VisibleSourceClinicalLike
}

export interface VisibleSourceHistoryTranscriptionInput {
  entries: readonly VisibleSourceHistoryEntryInput[]
  mappingVersion?: string
}

export interface BedsideQuestionnaireExtraAnswerInput {
  code: string
  display?: string
  unit?: string
  value: boolean | number | string | null
}

export interface BedsideQuestionnaireRevisionInput {
  revisionId: string
  revisionNumber: number
  recordedAt: string
  observationId?: string | null
  observationVersion?: string | null
  values?: ClinicalRiskAssessmentValues
  extraAnswers?: readonly BedsideQuestionnaireExtraAnswerInput[]
}

export interface BedsideQuestionnaireTranscriptionInput {
  revisions: readonly BedsideQuestionnaireRevisionInput[]
  mappingVersion?: string
}

export interface GeneralizedBedsideAnswerRecordInput {
  patientId?: string
  revisionId: string
  revisionNumber: number
  recordedAt: string
  answers: Readonly<Record<string, { display?: string; unit?: string; value: boolean | number | string | null }>>
  mappingVersion?: string
}

export interface ActivePackPromptItemInput {
  code: string
  labelZh: string
  unit?: string | undefined
}

export interface TranscribedClinicalFactCandidate {
  factId: string
  category: ClinicalFactCategory
  itemCode: ClinicalFactItemCode
  value: ClinicalFactValue
  method: string | null
  specimenOrSite: ClinicalFactSpecimenOrSite | null
  orderedAt: string | null
  effectiveAt: string | null
  reportedAt: string | null
  provenance: {
    recordType: string
    recordId: string
    recordVersion: string
    sourceSystemId: string
  }
  institutionScope: 'local' | 'external'
  recordStatus: ClinicalFactRecordStatus
  presence: ClinicalFactPresence
  supersedesFactId: string | null
  verificationStatus: ClinicalFactVerificationStatus
  ingestedAt: string
  mappingVersion: string
  sourceQuantityForQc?: {
    numericValue: number
    rawUnit: string | null
  }
  sexRestrictionHint?: 'female' | 'male' | null
  abnormal?: boolean | null | undefined
}

function isIsoDateTime(value: string | undefined | null): value is string {
  return typeof value === 'string' && value.length >= 19 && !Number.isNaN(Date.parse(value))
}

function pickTimestamp(...candidates: (string | undefined | null)[]): string | null {
  for (const candidate of candidates) {
    if (isIsoDateTime(candidate)) return candidate
  }
  return null
}

function pickCodingConcept(
  concept: FhirCodeableConceptLike | undefined,
  fallbackCode: string,
  fallbackDisplay: string,
  fallbackSystem = CLINMESH_CONCEPT_SYSTEM,
): { itemCode: ClinicalFactItemCode; method: string | null; spec: CanonicalConceptSpec | null } {
  const codings = concept?.coding ?? []
  for (const coding of codings) {
    if (coding.code && CONCEPT_BY_ALIAS.has(coding.code)) {
      const spec = CONCEPT_BY_ALIAS.get(coding.code)!
      return {
        itemCode: {
          code: spec.canonicalCode,
          system: spec.system,
          display: spec.display,
        },
        method: spec.method ?? null,
        spec,
      }
    }
  }
  const primary = codings.find(c => Boolean(c.code))
  return {
    itemCode: {
      code: primary?.code ?? fallbackCode,
      system: primary?.system ?? fallbackSystem,
      display: primary?.display ?? concept?.text ?? fallbackDisplay,
    },
    method: null,
    spec: null,
  }
}

function extractValueAndQcFromObservationFields(
  fields: VisibleSourceObservationFieldsLike,
  spec: CanonicalConceptSpec | null,
): {
  value: ClinicalFactValue
  presence: ClinicalFactPresence
  sourceQuantityForQc?: { numericValue: number; rawUnit: string | null }
} {
  if (fields.valueQuantity && typeof fields.valueQuantity.value === 'number' && Number.isFinite(fields.valueQuantity.value)) {
    const rawUnit = fields.valueQuantity.unit ?? fields.valueQuantity.code ?? null
    const rawText = rawUnit ? `${fields.valueQuantity.value} ${rawUnit}` : `${fields.valueQuantity.value}`
    const normalizedUnit = rawUnit ? normalizeUnitToken(rawUnit) : null
    if (spec && spec.allowedUnits && spec.normalize && spec.canonicalUnit && normalizedUnit && spec.allowedUnits.includes(normalizedUnit)) {
      const converted = spec.normalize(fields.valueQuantity.value, normalizedUnit)
      return {
        value: {
          rawText,
          normalizedValue: { value: Number(converted.toFixed(6)), unit: spec.canonicalUnit },
        },
        presence: 'present',
        sourceQuantityForQc: { numericValue: fields.valueQuantity.value, rawUnit },
      }
    }
    return {
      value: {
        rawText,
        normalizedValue: rawUnit
          ? { value: fields.valueQuantity.value, unit: normalizedUnit ?? rawUnit }
          : fields.valueQuantity.value,
      },
      presence: 'present',
      sourceQuantityForQc: { numericValue: fields.valueQuantity.value, rawUnit },
    }
  }
  if (typeof fields.valueBoolean === 'boolean') {
    return {
      value: { rawText: fields.valueBoolean ? '阳性/是' : '阴性/否', normalizedValue: fields.valueBoolean },
      presence: fields.valueBoolean ? 'present' : 'absent',
    }
  }
  if (typeof fields.valueInteger === 'number' && Number.isFinite(fields.valueInteger)) {
    return {
      value: { rawText: String(fields.valueInteger), normalizedValue: fields.valueInteger },
      presence: 'present',
    }
  }
  if (fields.valueCodeableConcept) {
    const code = fields.valueCodeableConcept.coding?.[0]?.code
    const system = fields.valueCodeableConcept.coding?.[0]?.system
    const display = fields.valueCodeableConcept.coding?.[0]?.display ?? fields.valueCodeableConcept.text
    const rawText = display ?? code ?? '未详'
    const isNegative = Boolean(code && /^(negative|absent|neg|-)$/i.test(code))
      || Boolean(display && /^(阴性|无|未见异常)$/i.test(display.trim()))
    return {
      value: {
        rawText,
        normalizedValue: code
          ? { code, ...(system ? { system } : {}), ...(display ? { display } : {}) }
          : rawText,
      },
      presence: isNegative ? 'absent' : 'present',
    }
  }
  if (typeof fields.valueString === 'string' && fields.valueString.trim().length > 0) {
    const trimmed = fields.valueString.trim()
    const isNegative = /^(negative|阴性|未见|(-))$/i.test(trimmed)
    return {
      value: { rawText: trimmed, normalizedValue: trimmed },
      presence: isNegative ? 'absent' : 'present',
    }
  }
  return {
    value: { rawText: '已记录', normalizedValue: 'recorded' },
    presence: 'present',
  }
}

function inferObservationAbnormal(
  fields: {
    interpretation?: readonly FhirCodeableConceptLike[] | undefined
    referenceRange?: readonly FhirReferenceRangeLike[] | undefined
    valueQuantity?: FhirQuantityLike | undefined
    valueBoolean?: boolean | undefined
    valueCodeableConcept?: FhirCodeableConceptLike | undefined
  },
): boolean | undefined {
  for (const interp of fields.interpretation ?? []) {
    for (const coding of interp.coding ?? []) {
      const code = coding.code?.trim().toUpperCase()
      if (!code) continue
      if (['H', 'HH', 'HU', 'L', 'LL', 'LU', 'A', 'AA', 'POS', 'POSITIVE', 'CRIT', 'CRITH', 'CRITL', 'DET', 'IND', 'ABNORMAL', 'HIGH', 'LOW'].includes(code)) {
        return true
      }
      if (['N', 'NORMAL', 'NEG', 'NEGATIVE', 'ND'].includes(code)) {
        return false
      }
    }
    const text = interp.text?.trim().toLowerCase()
    if (text) {
      if (/(?:abnormal|high|low|positive|异常|升高|偏高|降低|偏低|阳性)/.test(text)) return true
      if (/(?:normal|negative|正常|阴性)/.test(text)) return false
    }
  }
  const value = fields.valueQuantity?.value
  if (typeof value === 'number' && Number.isFinite(value) && fields.referenceRange && fields.referenceRange.length > 0) {
    const valUnit = normalizeUnitToken(fields.valueQuantity?.unit ?? fields.valueQuantity?.code ?? '')
    for (const range of fields.referenceRange) {
      const low = range.low?.value
      const high = range.high?.value
      const rangeUnit = normalizeUnitToken(range.low?.unit ?? range.low?.code ?? range.high?.unit ?? range.high?.code ?? '')
      if (valUnit && rangeUnit && valUnit !== rangeUnit) continue
      if (low !== undefined || high !== undefined) {
        if (low !== undefined && value < low) return true
        if (high !== undefined && value > high) return true
        return false
      }
    }
  }
  return undefined
}

const EXAM_ABNORMAL_CLAUSE_PATTERN = /(?:ST\s*段(?:抬高|压低|下移|偏移|改变)|T\s*波(?:倒置|低平|平低|高尖)|病理性\s*Q\s*波|急性?心肌缺血|心肌梗死|心律失常|心房颤动|心室颤动|传导阻滞|明显异常|异常)/i
const EXAM_CLAUSE_NEGATION_PATTERN = /(?:未见|未发现|无(?:明显|急性)?|排除|否定)/

function hasPositiveAbnormalExamClause(text: string): boolean {
  for (const clause of text.split(/[，,；;。]+|(?=但|而|伴|可见|提示)/)) {
    const trimmed = clause.trim()
    if (!trimmed) continue
    if (EXAM_ABNORMAL_CLAUSE_PATTERN.test(trimmed) && !EXAM_CLAUSE_NEGATION_PATTERN.test(trimmed)) {
      return true
    }
  }
  return false
}

function isNegativeNormalExamText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || hasPositiveAbnormalExamClause(trimmed)) return false
  return /(?:未见|未发现|无(?:明显|急性)?异常|心电图正常|窦性心律正常|normal\b)/i.test(trimmed)
}

function inferExamDiagnosticReportAbnormal(
  report: FhirDiagnosticReportLike,
  obsById: ReadonlyMap<string, FhirObservationLike>,
  conclusionText: string,
): boolean | undefined {
  for (const cCode of report.conclusionCode ?? []) {
    for (const coding of cCode.coding ?? []) {
      const code = coding.code?.trim().toLowerCase()
      if (!code) continue
      if (['a', 'abnormal', 'positive', 'ischemia'].includes(code)) return true
      if (['n', 'normal', 'negative'].includes(code)) return false
    }
  }
  const childAbnormalFlags: boolean[] = []
  for (const ref of report.result ?? []) {
    const obsId = ref.reference?.replace(/^Observation\//, '')
    if (!obsId) continue
    const childObs = obsById.get(obsId)
    if (!childObs) continue
    const valueStr = childObs.valueString?.trim()
    if (valueStr && isNegativeNormalExamText(valueStr)) {
      childAbnormalFlags.push(false)
      continue
    }
    const flag = inferObservationAbnormal(childObs)
    if (flag !== undefined) childAbnormalFlags.push(flag)
  }
  if (childAbnormalFlags.some(flag => flag === true)) return true

  if (conclusionText && hasPositiveAbnormalExamClause(conclusionText)) {
    return true
  }
  if (childAbnormalFlags.length > 0 && childAbnormalFlags.every(flag => flag === false)) {
    return false
  }
  if (conclusionText && isNegativeNormalExamText(conclusionText)) {
    return false
  }
  return undefined
}

function mapFhirReportOrObsStatus(status: string): ClinicalFactRecordStatus | null {
  if (status === 'entered-in-error') return 'entered-in-error'
  if (status === 'amended' || status === 'corrected' || status === 'appended') return 'amended'
  if (status === 'final') return 'final'
  return null
}

function observationCategory(obs: FhirObservationLike, spec: CanonicalConceptSpec | null): ClinicalFactCategory {
  if (spec?.categoryHint) return spec.categoryHint
  for (const cat of obs.category ?? []) {
    for (const coding of cat.coding ?? []) {
      const code = coding.code?.toLowerCase() ?? ''
      if (code === 'vital-signs') return 'vital-sign'
      if (code === 'laboratory') return 'laboratory'
      if (code === 'imaging' || code === 'exam' || code === 'examination' || code === 'procedure') return 'examination'
    }
  }
  return 'laboratory'
}

function hasSystemCode(concept: FhirCodeableConceptLike | undefined, system: string): boolean {
  return Boolean(concept?.coding?.some(c => c.system === system))
}

function mapVerificationStatus(concept: FhirCodeableConceptLike | undefined): {
  verificationStatus: ClinicalFactVerificationStatus
  presence: ClinicalFactPresence
  recordStatus: ClinicalFactRecordStatus
} {
  const code = concept?.coding?.[0]?.code?.toLowerCase() ?? ''
  if (code === 'entered-in-error') {
    return { verificationStatus: 'not-applicable', presence: 'present', recordStatus: 'entered-in-error' }
  }
  if (code === 'refuted') {
    return { verificationStatus: 'confirmed', presence: 'absent', recordStatus: 'final' }
  }
  if (code === 'confirmed') {
    return { verificationStatus: 'confirmed', presence: 'present', recordStatus: 'final' }
  }
  if (code === 'provisional' || code === 'differential' || code === 'unconfirmed') {
    return { verificationStatus: 'provisional', presence: 'present', recordStatus: 'final' }
  }
  return { verificationStatus: 'provisional', presence: 'present', recordStatus: 'final' }
}

function readOwnRecordValue<T>(map: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return map !== undefined && Object.hasOwn(map, key) ? map[key] : undefined
}

/** Build the composite per-version lookup key for an Observation record. */
export function observationVersionKey(observationId: string, versionId?: string): string {
  return `${observationId}::${versionId ?? '1'}`
}

function readObservationMapValue<T>(
  map: Readonly<Record<string, T>> | undefined,
  observationId: string,
  versionId?: string,
): T | undefined {
  return (
    readOwnRecordValue(map, observationVersionKey(observationId, versionId))
    ?? readOwnRecordValue(map, observationId)
  )
}

function resolveSpecimenOrSite(
  specimenRef: { reference?: string | undefined; display?: string | undefined } | undefined,
  bodySite: FhirCodeableConceptLike | readonly FhirCodeableConceptLike[] | undefined,
  specimenLabelById?: Readonly<Record<string, string>>,
): ClinicalFactSpecimenOrSite | null {
  const ref = specimenRef?.reference
  const specimenId = ref ? ref.replace(/^Specimen\//, '') : null
  const siteEntry = Array.isArray(bodySite) ? bodySite[0] : bodySite
  const label = specimenRef?.display
    ?? (specimenId ? readOwnRecordValue(specimenLabelById, specimenId) : undefined)
    ?? siteEntry?.coding?.[0]?.display
    ?? siteEntry?.text
    ?? null
  if (specimenId === null && label === null) return null
  return { label, specimenId }
}

function buildFactId(sourceSystemId: string, recordType: string, recordId: string, recordVersion: string, subKey?: string): string {
  return subKey
    ? `fact:${sourceSystemId}:${recordType}:${recordId}:${recordVersion}:${subKey}`
    : `fact:${sourceSystemId}:${recordType}:${recordId}:${recordVersion}`
}

function compareVersionIds(left: string, right: string): number {
  const leftNum = Number(left)
  const rightNum = Number(right)
  if (Number.isFinite(leftNum) && Number.isFinite(rightNum) && leftNum !== rightNum) {
    return leftNum - rightNum
  }
  return left.localeCompare(right)
}

function inferSexRestrictionFromCodeOrText(code: string, display: string): 'female' | 'male' | null {
  const spec = CONCEPT_BY_ALIAS.get(code)
  if (spec?.sexRestriction) return spec.sexRestriction
  const upperCode = code.toUpperCase()
  if (/^(O\d{2}|Z32|Z33|Z34)/.test(upperCode)) return 'female'
  if (/^(C61|N40)/.test(upperCode)) return 'male'
  if (/妊娠|早孕|绒毛膜促性腺激素|hcg|pregnancy/i.test(display)) return 'female'
  if (/前列腺特异抗原|前列腺癌|prostate/i.test(display)) return 'male'
  return null
}

export function transcribeLocalFhirFacts(input: LocalFhirTranscriptionInput): TranscribedClinicalFactCandidate[] {
  const mappingVersion = input.mappingVersion ?? CLINICAL_FACT_MAPPING_VERSION
  const defaultSourceSystemId = input.sourceSystemId ?? 'clinmesh-his-fhir'
  const candidates: TranscribedClinicalFactCandidate[] = []

  const obsById = new Map<string, FhirObservationLike>()
  const obsVersionsById = new Map<string, FhirObservationLike[]>()
  for (const obs of input.observations ?? []) {
    obsById.set(obs.id, obs)
    const list = obsVersionsById.get(obs.id)
    if (list) list.push(obs)
    else obsVersionsById.set(obs.id, [obs])
  }
  for (const list of obsVersionsById.values()) {
    if (list.length > 1) {
      list.sort((a, b) => compareVersionIds(a.meta?.versionId ?? '1', b.meta?.versionId ?? '1'))
    }
  }

  const reportByResultObsId = new Map<string, FhirDiagnosticReportLike>()
  for (const report of input.diagnosticReports ?? []) {
    for (const ref of report.result ?? []) {
      const obsId = ref.reference?.replace(/^Observation\//, '')
      if (obsId) reportByResultObsId.set(obsId, report)
    }
  }

  const resolveOrderedAtForObs = (obs: FhirObservationLike, report?: FhirDiagnosticReportLike): string | null => {
    const byObs = readObservationMapValue(input.orderedAtByObservationId, obs.id, obs.meta?.versionId)
    if (byObs) return byObs
    const byReport = report ? readOwnRecordValue(input.orderedAtByReportId, report.id) : undefined
    if (byReport) return byReport
    for (const ref of obs.basedOn ?? []) {
      const byReq = ref.reference ? readOwnRecordValue(input.orderedAtByRequestRef, ref.reference) : undefined
      if (byReq) return byReq
    }
    if (report) {
      for (const ref of report.basedOn ?? []) {
        const byReq = ref.reference ? readOwnRecordValue(input.orderedAtByRequestRef, ref.reference) : undefined
        if (byReq) return byReq
      }
    }
    return null
  }

  const resolveSupersedesObsFactId = (
    obs: FhirObservationLike,
    canonicalCode: string,
    report?: FhirDiagnosticReportLike,
    componentCode?: string,
  ): string | null => {
    const prevObsId = readOwnRecordValue(input.supersedesObservationId, obs.id)
    if (prevObsId) {
      const prevObs = obsById.get(prevObsId)
      const prevVersion = prevObs?.meta?.versionId ?? '1'
      const prevSourceSystemId = readObservationMapValue(input.sourceSystemIdByObservationId, prevObsId, prevVersion) ?? defaultSourceSystemId
      return buildFactId(prevSourceSystemId, 'Observation', prevObsId, prevVersion, componentCode)
    }
    const versions = obsVersionsById.get(obs.id)
    if (versions && versions.length > 1) {
      const currentVersion = obs.meta?.versionId ?? '1'
      const currentIdx = versions.findIndex(v => (v.meta?.versionId ?? '1') === currentVersion)
      for (let i = currentIdx - 1; i >= 0; i -= 1) {
        const prevObs = versions[i]!
        if (!mapFhirReportOrObsStatus(prevObs.status)) continue
        const prevVersion = prevObs.meta?.versionId ?? '1'
        const prevSourceSystemId = readObservationMapValue(input.sourceSystemIdByObservationId, prevObs.id, prevVersion) ?? defaultSourceSystemId
        return buildFactId(prevSourceSystemId, 'Observation', prevObs.id, prevVersion, componentCode)
      }
    }
    if (!report) return null
    const prevReportId = readOwnRecordValue(input.supersedesReportId, report.id)
    if (!prevReportId) return null
    const prevReport = (input.diagnosticReports ?? []).find(r => r.id === prevReportId)
    if (!prevReport) return null
    for (const ref of prevReport.result ?? []) {
      const prevResultObsId = ref.reference?.replace(/^Observation\//, '')
      if (!prevResultObsId) continue
      const prevObs = obsById.get(prevResultObsId)
      if (!prevObs) continue
      const { itemCode } = pickCodingConcept(prevObs.code, prevObs.id, prevObs.id)
      if (itemCode.code === canonicalCode) {
        const prevObsVer = prevObs.meta?.versionId ?? '1'
        const prevSourceSystemId = readObservationMapValue(input.sourceSystemIdByObservationId, prevObs.id, prevObsVer) ?? defaultSourceSystemId
        return buildFactId(prevSourceSystemId, 'Observation', prevObs.id, prevObsVer)
      }
    }
    return null
  }

  for (const obs of input.observations ?? []) {
    if (hasSystemCode(obs.code, CLINMESH_RISK_SYSTEM)) continue
    const recordStatus = mapFhirReportOrObsStatus(obs.status)
    if (!recordStatus) continue

    const recordVersion = obs.meta?.versionId ?? '1'
    const linkedReport = reportByResultObsId.get(obs.id)
    const reportStatus = linkedReport ? mapFhirReportOrObsStatus(linkedReport.status) : null
    const effectiveRecordStatus: ClinicalFactRecordStatus = recordStatus === 'entered-in-error'
      ? 'entered-in-error'
      : reportStatus === 'amended' || recordStatus === 'amended'
        ? 'amended'
        : 'final'

    const obsSourceSystemId = readObservationMapValue(input.sourceSystemIdByObservationId, obs.id, recordVersion) ?? defaultSourceSystemId
    const orderedAt = resolveOrderedAtForObs(obs, linkedReport)
    const reportedAt = pickTimestamp(obs.issued, linkedReport?.issued)
    const effectiveAt = pickTimestamp(obs.effectiveDateTime, linkedReport?.effectiveDateTime, reportedAt)
    const ingestedAt = pickTimestamp(
      readObservationMapValue(input.ingestedAtByObservationId, obs.id, recordVersion),
      obs.issued,
      linkedReport?.issued,
      obs.effectiveDateTime,
      obs.meta?.lastUpdated,
    ) ?? new Date(0).toISOString()

    if (obs.component && obs.component.length > 0) {
      const orderedComponents = [...obs.component].filter(c => {
        const hasVal = c.valueQuantity || c.valueBoolean !== undefined || c.valueInteger !== undefined || c.valueCodeableConcept || c.valueString
        return Boolean(hasVal)
      })
      for (let i = 0; i < orderedComponents.length; i++) {
        const comp = orderedComponents[i]!
        const { itemCode, method, spec } = pickCodingConcept(comp.code, `${obs.id}-comp-${i}`, `${obs.id} component ${i}`)
        const extracted = extractValueAndQcFromObservationFields(comp, spec)
        const category = spec?.categoryHint ?? 'vital-sign'
        const factId = buildFactId(obsSourceSystemId, 'Observation', obs.id, recordVersion, itemCode.code)
        const compAbnormal = inferObservationAbnormal(comp) ?? inferObservationAbnormal(obs)
        candidates.push({
          factId,
          category,
          itemCode,
          value: extracted.value,
          method,
          specimenOrSite: resolveSpecimenOrSite(obs.specimen, obs.bodySite, input.specimenLabelById),
          orderedAt,
          effectiveAt,
          reportedAt,
          provenance: {
            recordType: 'Observation',
            recordId: obs.id,
            recordVersion,
            sourceSystemId: obsSourceSystemId,
          },
          institutionScope: 'local',
          recordStatus: effectiveRecordStatus,
          presence: extracted.presence,
          supersedesFactId: resolveSupersedesObsFactId(obs, itemCode.code, linkedReport, itemCode.code),
          verificationStatus: 'not-applicable',
          ingestedAt,
          mappingVersion,
          ...(extracted.sourceQuantityForQc ? { sourceQuantityForQc: extracted.sourceQuantityForQc } : {}),
          sexRestrictionHint: inferSexRestrictionFromCodeOrText(itemCode.code, itemCode.display),
          ...(compAbnormal === undefined ? {} : { abnormal: compAbnormal }),
        })
      }
      if (
        obs.valueQuantity === undefined
        && obs.valueCodeableConcept === undefined
        && obs.valueString === undefined
        && obs.valueBoolean === undefined
        && obs.valueInteger === undefined
      ) {
        continue
      }
    }

    const { itemCode, method: mappedMethod, spec } = pickCodingConcept(obs.code, obs.id, obs.code?.text ?? obs.id)
    const method = mappedMethod ?? obs.method?.coding?.[0]?.code ?? obs.method?.coding?.[0]?.display ?? obs.method?.text ?? null
    const extracted = extractValueAndQcFromObservationFields(obs, spec)
    const category = observationCategory(obs, spec)

    const obsAbnormal = inferObservationAbnormal(obs)
    candidates.push({
      factId: buildFactId(obsSourceSystemId, 'Observation', obs.id, recordVersion),
      category,
      itemCode,
      value: extracted.value,
      method,
      specimenOrSite: resolveSpecimenOrSite(obs.specimen, obs.bodySite, input.specimenLabelById),
      orderedAt,
      effectiveAt,
      reportedAt,
      provenance: {
        recordType: 'Observation',
        recordId: obs.id,
        recordVersion,
        sourceSystemId: obsSourceSystemId,
      },
      institutionScope: 'local',
      recordStatus: effectiveRecordStatus,
      presence: extracted.presence,
      supersedesFactId: resolveSupersedesObsFactId(obs, itemCode.code, linkedReport),
      verificationStatus: 'not-applicable',
      ingestedAt,
      mappingVersion,
      ...(extracted.sourceQuantityForQc ? { sourceQuantityForQc: extracted.sourceQuantityForQc } : {}),
      sexRestrictionHint: inferSexRestrictionFromCodeOrText(itemCode.code, itemCode.display),
      ...(obsAbnormal === undefined ? {} : { abnormal: obsAbnormal }),
    })
  }

  for (const report of input.diagnosticReports ?? []) {
    const recordStatus = mapFhirReportOrObsStatus(report.status)
    if (!recordStatus) continue

    const { itemCode, method, spec } = pickCodingConcept(report.code, report.id, report.code?.text ?? report.id)
    const isExamOrImaging = spec?.categoryHint === 'examination'
      || Boolean(report.category?.some(cat =>
        cat.coding?.some(c => {
          const code = (c.code ?? '').toUpperCase()
          return code === 'RAD' || code === 'ECG' || code === 'EXAM' || code === 'EXAMINATION'
            || code === 'DIAGNOSTIC-IMAGING' || code === 'PATH' || code === 'PAT' || code === 'SP'
        }),
      ))
      || Boolean(report.code?.coding?.some(c =>
        c.system === 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/examination-service'
        || c.system === 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/imaging-service'
        || ['ECG-12', '11524-6', 'examination-ecg-12-lead', 'TTE', '18043-0', 'examination-tte'].includes(c.code ?? ''),
      ))
    const hasResultObservations = Boolean(report.result && report.result.some(r => {
      const obsId = r.reference?.replace(/^Observation\//, '')
      return Boolean(obsId && obsById.has(obsId))
    }))
    const conclusionText = report.conclusion?.trim()
      || report.conclusionCode?.map(c => c.text ?? c.coding?.[0]?.display).filter(Boolean).join('；')
      || ''

    // Skip laboratory DiagnosticReport wrapper whenever its child observations are transcribed;
    // panel conclusion boilerplate must never self-conflict with structured Observation results.
    if (hasResultObservations && !isExamOrImaging) continue
    if (!hasResultObservations && conclusionText.length === 0) continue

    const recordVersion = report.meta?.versionId ?? '1'
    const orderedAt = readOwnRecordValue(input.orderedAtByReportId, report.id)
      ?? report.basedOn?.map(b => (b.reference ? readOwnRecordValue(input.orderedAtByRequestRef, b.reference) : undefined)).find(Boolean)
      ?? null
    const reportedAt = pickTimestamp(report.issued, report.effectiveDateTime)
    const effectiveAt = pickTimestamp(report.effectiveDateTime, reportedAt)
    const ingestedAt = pickTimestamp(report.issued, report.effectiveDateTime, report.meta?.lastUpdated) ?? new Date(0).toISOString()

    const prevReportId = readOwnRecordValue(input.supersedesReportId, report.id)
    const prevReport = prevReportId ? (input.diagnosticReports ?? []).find(r => r.id === prevReportId) : undefined
    const supersedesFactId = prevReport
      ? buildFactId(defaultSourceSystemId, 'DiagnosticReport', prevReport.id, prevReport.meta?.versionId ?? '1')
      : null

    const reportAbnormal = isExamOrImaging
      ? inferExamDiagnosticReportAbnormal(report, obsById, conclusionText)
      : undefined
    candidates.push({
      factId: buildFactId(defaultSourceSystemId, 'DiagnosticReport', report.id, recordVersion),
      category: isExamOrImaging ? 'examination' : 'laboratory',
      itemCode,
      value: {
        rawText: conclusionText,
        normalizedValue: report.conclusionCode?.[0]?.coding?.[0]?.code
          ? {
              code: report.conclusionCode[0].coding[0].code,
              ...(report.conclusionCode[0].coding[0].system ? { system: report.conclusionCode[0].coding[0].system } : {}),
              display: conclusionText,
            }
          : conclusionText,
      },
      method,
      specimenOrSite: resolveSpecimenOrSite(report.specimen?.[0], undefined, input.specimenLabelById),
      orderedAt,
      effectiveAt,
      reportedAt,
      provenance: {
        recordType: 'DiagnosticReport',
        recordId: report.id,
        recordVersion,
        sourceSystemId: defaultSourceSystemId,
      },
      institutionScope: 'local',
      recordStatus,
      presence: 'present',
      supersedesFactId,
      verificationStatus: 'not-applicable',
      ingestedAt,
      mappingVersion,
      sexRestrictionHint: inferSexRestrictionFromCodeOrText(itemCode.code, `${itemCode.display} ${conclusionText}`),
      ...(reportAbnormal === undefined ? {} : { abnormal: reportAbnormal }),
    })
  }

  for (const cond of input.conditions ?? []) {
    const recordVersion = cond.meta?.versionId ?? '1'
    const { verificationStatus, presence, recordStatus } = mapVerificationStatus(cond.verificationStatus)
    const { itemCode } = pickCodingConcept(cond.code, cond.id, cond.code?.text ?? cond.id, 'http://hl7.org/fhir/sid/icd-10')
    const reportedAt = pickTimestamp(cond.recordedDate, cond.onsetDateTime)
    const ingestedAt = pickTimestamp(cond.recordedDate, cond.onsetDateTime, cond.meta?.lastUpdated) ?? new Date(0).toISOString()
    const effectiveAt = pickTimestamp(cond.onsetDateTime, cond.recordedDate)
    const noteText = cond.note?.map(n => n.text).filter(Boolean).join('; ')

    candidates.push({
      factId: buildFactId(defaultSourceSystemId, 'Condition', cond.id, recordVersion),
      category: 'diagnosis',
      itemCode,
      value: {
        rawText: noteText ? `${itemCode.display} (${noteText})` : itemCode.display,
        normalizedValue: { code: itemCode.code, system: itemCode.system, display: itemCode.display },
      },
      method: null,
      specimenOrSite: null,
      orderedAt: null,
      effectiveAt,
      reportedAt,
      provenance: {
        recordType: 'Condition',
        recordId: cond.id,
        recordVersion,
        sourceSystemId: defaultSourceSystemId,
      },
      institutionScope: 'local',
      recordStatus,
      presence,
      supersedesFactId: null,
      verificationStatus,
      ingestedAt,
      mappingVersion,
      sexRestrictionHint: inferSexRestrictionFromCodeOrText(itemCode.code, itemCode.display),
    })
  }

  for (const allergy of input.allergyIntolerances ?? []) {
    const recordVersion = allergy.meta?.versionId ?? '1'
    const { verificationStatus, presence, recordStatus } = mapVerificationStatus(allergy.verificationStatus)
    const { itemCode } = pickCodingConcept(allergy.code, allergy.id, allergy.code?.text ?? allergy.id)
    const reportedAt = pickTimestamp(allergy.recordedDate)
    const ingestedAt = pickTimestamp(allergy.recordedDate, allergy.meta?.lastUpdated) ?? new Date(0).toISOString()
    const reactions = allergy.reaction
      ?.flatMap(r => (r.manifestation ?? []).map(m => m.text ?? m.coding?.[0]?.display))
      .filter((t): t is string => Boolean(t)) ?? []
    const rawText = reactions.length > 0 ? `${itemCode.display}: ${reactions.join('、')}` : itemCode.display

    candidates.push({
      factId: buildFactId(defaultSourceSystemId, 'AllergyIntolerance', allergy.id, recordVersion),
      category: 'allergy',
      itemCode,
      value: {
        rawText,
        normalizedValue: { code: itemCode.code, system: itemCode.system, display: itemCode.display },
      },
      method: null,
      specimenOrSite: null,
      orderedAt: null,
      effectiveAt: reportedAt,
      reportedAt,
      provenance: {
        recordType: 'AllergyIntolerance',
        recordId: allergy.id,
        recordVersion,
        sourceSystemId: defaultSourceSystemId,
      },
      institutionScope: 'local',
      recordStatus,
      presence,
      supersedesFactId: null,
      verificationStatus,
      ingestedAt,
      mappingVersion,
    })
  }

  for (const med of input.medications ?? []) {
    if (med.status === 'draft' || med.status === 'unknown') continue
    const recordStatus: ClinicalFactRecordStatus = med.status === 'entered-in-error' ? 'entered-in-error' : 'final'
    const recordVersion = med.meta?.versionId ?? '1'
    const { itemCode } = pickCodingConcept(
      med.medicationCodeableConcept,
      med.id,
      med.medicationReference?.display ?? med.medicationCodeableConcept?.text ?? med.id,
    )
    const dosageText = med.dosageInstruction?.map(d => d.text).filter(Boolean).join(' ')
      || med.dosage?.text
      || (med.dosage?.dose?.value !== undefined ? `${med.dosage.dose.value}${med.dosage.dose.unit ?? ''}` : '')
    const rawText = dosageText ? `${itemCode.display} (${dosageText})` : itemCode.display
    const ingestedAt = pickTimestamp(
      med.whenHandedOver,
      med.occurrenceDateTime,
      med.effectiveDateTime,
      med.effectivePeriod?.start,
      med.authoredOn,
      med.meta?.lastUpdated,
    ) ?? new Date(0).toISOString()
    const effectiveAt = pickTimestamp(
      med.whenHandedOver,
      med.occurrenceDateTime,
      med.effectiveDateTime,
      med.effectivePeriod?.start,
      med.authoredOn,
    )

    candidates.push({
      factId: buildFactId(defaultSourceSystemId, med.resourceType, med.id, recordVersion),
      category: 'medication',
      itemCode,
      value: {
        rawText,
        normalizedValue: { code: itemCode.code, system: itemCode.system, display: itemCode.display },
      },
      method: null,
      specimenOrSite: null,
      orderedAt: pickTimestamp(med.authoredOn),
      effectiveAt,
      reportedAt: pickTimestamp(med.authoredOn, effectiveAt),
      provenance: {
        recordType: med.resourceType,
        recordId: med.id,
        recordVersion,
        sourceSystemId: defaultSourceSystemId,
      },
      institutionScope: 'local',
      recordStatus,
      presence: med.status === 'not-taken' ? 'absent' : 'present',
      supersedesFactId: null,
      verificationStatus: 'not-applicable',
      ingestedAt,
      mappingVersion,
    })
  }

  for (const proc of input.procedures ?? []) {
    if (proc.status === 'preparation' || proc.status === 'unknown') continue
    const recordStatus: ClinicalFactRecordStatus = proc.status === 'entered-in-error' ? 'entered-in-error' : 'final'
    const recordVersion = proc.meta?.versionId ?? '1'
    const { itemCode } = pickCodingConcept(proc.code, proc.id, proc.code?.text ?? proc.id)
    const effectiveAt = pickTimestamp(proc.performedDateTime, proc.performedPeriod?.start, proc.occurrenceDateTime, proc.recorded)
    const ingestedAt = pickTimestamp(proc.recorded, effectiveAt, proc.meta?.lastUpdated) ?? new Date(0).toISOString()
    const outcomeText = proc.outcome?.text ?? proc.outcome?.coding?.[0]?.display

    candidates.push({
      factId: buildFactId(defaultSourceSystemId, 'Procedure', proc.id, recordVersion),
      category: 'procedure',
      itemCode,
      value: {
        rawText: outcomeText ? `${itemCode.display}: ${outcomeText}` : itemCode.display,
        normalizedValue: { code: itemCode.code, system: itemCode.system, display: itemCode.display },
      },
      method: null,
      specimenOrSite: null,
      orderedAt: null,
      effectiveAt,
      reportedAt: ingestedAt,
      provenance: {
        recordType: 'Procedure',
        recordId: proc.id,
        recordVersion,
        sourceSystemId: defaultSourceSystemId,
      },
      institutionScope: 'local',
      recordStatus,
      presence: proc.status === 'not-done' ? 'absent' : 'present',
      supersedesFactId: null,
      verificationStatus: 'not-applicable',
      ingestedAt,
      mappingVersion,
    })
  }

  // Link sequential versions of the same FHIR resource as superseding earlier revisions
  // (independent of sourceSystemId or analyte code corrections on amended/retracted versions).
  const byResourceItem = new Map<string, TranscribedClinicalFactCandidate[]>()
  for (const candidate of candidates) {
    const componentPrefix = `fact:${candidate.provenance.sourceSystemId}:${candidate.provenance.recordType}:${candidate.provenance.recordId}:${candidate.provenance.recordVersion}:`
    const subKey = candidate.factId.startsWith(componentPrefix)
      ? `component::${candidate.factId.slice(componentPrefix.length)}`
      : candidate.provenance.recordType === 'Observation'
        ? 'primary'
        : `item::${candidate.itemCode.code}`
    const key = `${candidate.provenance.recordType}::${candidate.provenance.recordId}::${subKey}`
    const group = byResourceItem.get(key)
    if (group) group.push(candidate)
    else byResourceItem.set(key, [candidate])
  }
  for (const group of byResourceItem.values()) {
    if (group.length < 2) continue
    group.sort((a, b) => compareVersionIds(a.provenance.recordVersion, b.provenance.recordVersion))
    for (let i = 1; i < group.length; i++) {
      if (group[i]!.supersedesFactId === null) {
        group[i]!.supersedesFactId = group[i - 1]!.factId
        if (group[i]!.recordStatus === 'final' && (group[i]!.category === 'laboratory' || group[i]!.category === 'examination')) {
          group[i]!.recordStatus = 'amended'
        }
      }
    }
  }

  return candidates
}

export function transcribeVisibleSourceHistoryFacts(
  input: VisibleSourceHistoryTranscriptionInput,
): TranscribedClinicalFactCandidate[] {
  const mappingVersion = input.mappingVersion ?? CLINICAL_FACT_MAPPING_VERSION
  const candidates: TranscribedClinicalFactCandidate[] = []

  for (const entry of input.entries) {
    if (
      entry.resourceType === 'DocumentReference'
      || entry.resourceType === 'Composition'
      || entry.resourceType === 'ClinicalImpression'
      || entry.resourceType === 'Encounter'
      || entry.resourceType === 'ChargeItem'
      || entry.resourceType === 'Claim'
      || entry.resourceType === 'Coverage'
    ) {
      continue
    }

    const c = entry.clinical
    const recordVersion = entry.recordVersion ?? '1'
    const reportedAt = pickTimestamp(c.issued, c.recordedDate, entry.clinicalDate)
    const effectiveAt = pickTimestamp(c.effectiveDateTime, c.effectivePeriod?.start, c.onsetDateTime, c.performedDateTime, c.occurrenceDateTime, entry.clinicalDate)
    const ingestedAt = pickTimestamp(entry.ingestedAt, reportedAt, entry.clinicalDate) ?? entry.clinicalDate
    const orderedAt = pickTimestamp(c.authoredOn)

    if (entry.resourceType === 'Observation' || entry.resourceType === 'DiagnosticReport') {
      if (c.component && c.component.length > 0) {
        c.component.forEach((comp: VisibleSourceObservationFieldsLike, idx: number) => {
          const { itemCode, method, spec } = pickCodingConcept(comp.code, `${entry.entryId}-comp-${idx}`, `${entry.title} #${idx + 1}`)
          const extracted = extractValueAndQcFromObservationFields(comp, spec)
          candidates.push({
            factId: buildFactId('clinmesh-visible-source-history', entry.resourceType, entry.sourceReference, recordVersion, itemCode.code),
            category: spec?.categoryHint ?? 'vital-sign',
            itemCode,
            value: extracted.value,
            method,
            specimenOrSite: resolveSpecimenOrSite(entry.specimen, c.bodySite),
            orderedAt,
            effectiveAt,
            reportedAt,
            provenance: {
              recordType: entry.resourceType,
              recordId: entry.sourceReference,
              recordVersion,
              sourceSystemId: 'clinmesh-visible-source-history',
            },
            institutionScope: 'external',
            recordStatus: c.status === 'entered-in-error' ? 'entered-in-error' : c.status === 'amended' ? 'amended' : 'final',
            presence: extracted.presence,
            supersedesFactId: null,
            verificationStatus: 'provisional',
            ingestedAt,
            mappingVersion,
            ...(extracted.sourceQuantityForQc ? { sourceQuantityForQc: extracted.sourceQuantityForQc } : {}),
            sexRestrictionHint: inferSexRestrictionFromCodeOrText(itemCode.code, itemCode.display),
          })
        })
        if (
          c.valueQuantity === undefined
          && c.valueCodeableConcept === undefined
          && c.valueString === undefined
          && c.valueBoolean === undefined
          && c.valueInteger === undefined
          && !c.conclusion
        ) {
          continue
        }
      }

      const { itemCode, method, spec } = pickCodingConcept(c.code, entry.sourceReference, c.title ?? entry.title)
      const isExam = entry.resourceType === 'DiagnosticReport'
        || Boolean(c.conclusion && !c.valueQuantity)
      const extracted: {
        value: ClinicalFactValue
        presence: ClinicalFactPresence
        sourceQuantityForQc?: { numericValue: number; rawUnit: string | null }
      } = c.conclusion && !c.valueQuantity
        ? { value: { rawText: c.conclusion, normalizedValue: c.conclusion }, presence: 'present' as const }
        : extractValueAndQcFromObservationFields(c, spec)

      candidates.push({
        factId: buildFactId('clinmesh-visible-source-history', entry.resourceType, entry.sourceReference, recordVersion),
        category: spec?.categoryHint ?? (isExam ? 'examination' : 'laboratory'),
        itemCode,
        value: extracted.value,
        method,
        specimenOrSite: resolveSpecimenOrSite(entry.specimen, c.bodySite),
        orderedAt,
        effectiveAt,
        reportedAt,
        provenance: {
          recordType: entry.resourceType,
          recordId: entry.sourceReference,
          recordVersion,
          sourceSystemId: 'clinmesh-visible-source-history',
        },
        institutionScope: 'external',
        recordStatus: c.status === 'entered-in-error' ? 'entered-in-error' : c.status === 'amended' ? 'amended' : 'final',
        presence: extracted.presence,
        supersedesFactId: null,
        verificationStatus: 'provisional',
        ingestedAt,
        mappingVersion,
        ...(extracted.sourceQuantityForQc ? { sourceQuantityForQc: extracted.sourceQuantityForQc } : {}),
        sexRestrictionHint: inferSexRestrictionFromCodeOrText(itemCode.code, `${itemCode.display} ${extracted.value.rawText}`),
      })
      continue
    }

    if (entry.resourceType === 'Condition') {
      const { itemCode } = pickCodingConcept(c.code, entry.sourceReference, entry.title, 'http://hl7.org/fhir/sid/icd-10')
      const { verificationStatus, presence, recordStatus } = mapVerificationStatus(c.verificationStatus)
      candidates.push({
        factId: buildFactId('clinmesh-visible-source-history', 'Condition', entry.sourceReference, recordVersion),
        category: 'diagnosis',
        itemCode,
        value: {
          rawText: entry.title,
          normalizedValue: { code: itemCode.code, system: itemCode.system, display: itemCode.display },
        },
        method: null,
        specimenOrSite: null,
        orderedAt: null,
        effectiveAt,
        reportedAt: reportedAt ?? ingestedAt,
        provenance: {
          recordType: 'Condition',
          recordId: entry.sourceReference,
          recordVersion,
          sourceSystemId: 'clinmesh-visible-source-history',
        },
        institutionScope: 'external',
        recordStatus,
        presence,
        supersedesFactId: null,
        verificationStatus,
        ingestedAt,
        mappingVersion,
        sexRestrictionHint: inferSexRestrictionFromCodeOrText(itemCode.code, itemCode.display),
      })
      continue
    }

    if (entry.resourceType === 'AllergyIntolerance') {
      const { itemCode } = pickCodingConcept(c.code, entry.sourceReference, entry.title)
      const { verificationStatus, presence, recordStatus } = mapVerificationStatus(c.verificationStatus)
      candidates.push({
        factId: buildFactId('clinmesh-visible-source-history', 'AllergyIntolerance', entry.sourceReference, recordVersion),
        category: 'allergy',
        itemCode,
        value: {
          rawText: entry.title,
          normalizedValue: { code: itemCode.code, system: itemCode.system, display: itemCode.display },
        },
        method: null,
        specimenOrSite: null,
        orderedAt: null,
        effectiveAt,
        reportedAt: reportedAt ?? ingestedAt,
        provenance: {
          recordType: 'AllergyIntolerance',
          recordId: entry.sourceReference,
          recordVersion,
          sourceSystemId: 'clinmesh-visible-source-history',
        },
        institutionScope: 'external',
        recordStatus,
        presence,
        supersedesFactId: null,
        verificationStatus,
        ingestedAt,
        mappingVersion,
      })
      continue
    }

    if (
      entry.resourceType === 'MedicationRequest'
      || entry.resourceType === 'MedicationStatement'
      || entry.resourceType === 'MedicationDispense'
      || entry.resourceType === 'MedicationAdministration'
    ) {
      const { itemCode } = pickCodingConcept(c.medicationCodeableConcept ?? c.code, entry.sourceReference, c.medicationReference?.display ?? entry.title)
      const doseText = c.dosageInstruction?.map((d: { text?: string | undefined }) => d.text).filter(Boolean).join(' ')
      candidates.push({
        factId: buildFactId('clinmesh-visible-source-history', entry.resourceType, entry.sourceReference, recordVersion),
        category: 'medication',
        itemCode,
        value: {
          rawText: doseText ? `${itemCode.display} (${doseText})` : entry.title,
          normalizedValue: { code: itemCode.code, system: itemCode.system, display: itemCode.display },
        },
        method: null,
        specimenOrSite: null,
        orderedAt,
        effectiveAt,
        reportedAt: reportedAt ?? ingestedAt,
        provenance: {
          recordType: entry.resourceType,
          recordId: entry.sourceReference,
          recordVersion,
          sourceSystemId: 'clinmesh-visible-source-history',
        },
        institutionScope: 'external',
        recordStatus: c.status === 'entered-in-error' ? 'entered-in-error' : 'final',
        presence: 'present',
        supersedesFactId: null,
        verificationStatus: 'provisional',
        ingestedAt,
        mappingVersion,
      })
      continue
    }

    if (entry.resourceType === 'Procedure' || entry.resourceType === 'Immunization') {
      const { itemCode } = pickCodingConcept(c.code ?? c.vaccineCode, entry.sourceReference, entry.title)
      candidates.push({
        factId: buildFactId('clinmesh-visible-source-history', entry.resourceType, entry.sourceReference, recordVersion),
        category: 'procedure',
        itemCode,
        value: {
          rawText: entry.title,
          normalizedValue: { code: itemCode.code, system: itemCode.system, display: itemCode.display },
        },
        method: null,
        specimenOrSite: null,
        orderedAt: null,
        effectiveAt,
        reportedAt: reportedAt ?? ingestedAt,
        provenance: {
          recordType: entry.resourceType,
          recordId: entry.sourceReference,
          recordVersion,
          sourceSystemId: 'clinmesh-visible-source-history',
        },
        institutionScope: 'external',
        recordStatus: c.status === 'entered-in-error' ? 'entered-in-error' : 'final',
        presence: c.status === 'not-done' ? 'absent' : 'present',
        supersedesFactId: null,
        verificationStatus: 'provisional',
        ingestedAt,
        mappingVersion,
      })
    }
  }

  return candidates
}

interface QuestionnaireFieldDescriptor {
  key: keyof ClinicalRiskAssessmentValues
  code: string
  display: string
}

export const LEGACY_BEDSIDE_QUESTIONNAIRE_FIELDS: readonly QuestionnaireFieldDescriptor[] = [
  { key: 'killipClass', code: 'killip-class', display: 'Killip 心功能分级' },
  { key: 'cardiacArrestOnAdmission', code: 'cardiac-arrest-on-admission', display: '入院时心脏骤停' },
  { key: 'anginaEpisodes24h', code: 'angina-episodes-24h', display: '24 小时内反复心绞痛发作次数' },
  { key: 'stSegmentDeviation', code: 'st-segment-deviation', display: '床旁评估 ST 段偏移' },
  { key: 'aspirinUsedLast7Days', code: 'aspirin-used-last-7-days', display: '近 7 天内使用阿司匹林' },
  { key: 'smokingStatus', code: 'smoking-status', display: '吸烟史' },
  { key: 'familyHistoryPrematureCad', code: 'family-history-premature-cad', display: '早发冠心病家族史' },
  { key: 'knownCoronaryStenosisGe50', code: 'known-coronary-stenosis-ge-50', display: '既往已知冠脉狭窄 ≥ 50%' },
  { key: 'priorBleedingHistory', code: 'prior-bleeding-history', display: '既往出血史' },
]

const QUESTIONNAIRE_FIELDS = LEGACY_BEDSIDE_QUESTIONNAIRE_FIELDS

export function normalizeBedsideItemCode(rawCode: string): string {
  const trimmed = rawCode.trim()
  if (trimmed === 'known-coronary-stenosis-ge50') return 'known-coronary-stenosis-ge-50'
  if (trimmed === 'st-segment-deviation-bedside') return 'st-segment-deviation'
  return trimmed
}

function encodeScalarQuestionnaireValue(
  code: string,
  rawVal: boolean | number | string | null | undefined,
  unit?: string,
): { value: ClinicalFactValue; presence: ClinicalFactPresence } {
  if (rawVal === null || rawVal === undefined) {
    return {
      value: { rawText: '没问到', normalizedValue: null },
      presence: 'not-asked',
    }
  }
  if (typeof rawVal === 'boolean') {
    return {
      value: { rawText: rawVal ? '是' : '否', normalizedValue: rawVal },
      presence: rawVal ? 'present' : 'absent',
    }
  }
  if (typeof rawVal === 'number') {
    const normalizedUnit = unit?.trim()
    return {
      value: {
        rawText: normalizedUnit ? `${rawVal} ${normalizedUnit}` : String(rawVal),
        normalizedValue: normalizedUnit ? { value: rawVal, unit: normalizedUnit } : rawVal,
      },
      presence: code === 'angina-episodes-24h' && rawVal === 0 ? 'absent' : 'present',
    }
  }
  const str = String(rawVal)
  const isAbsent = str === 'never' || str === 'none' || str === 'negative'
  return {
    value: { rawText: str, normalizedValue: str },
    presence: isAbsent ? 'absent' : 'present',
  }
}

function encodeQuestionnaireField(
  descriptor: QuestionnaireFieldDescriptor,
  rawVal: ClinicalRiskAssessmentValues[keyof ClinicalRiskAssessmentValues],
): { value: ClinicalFactValue; presence: ClinicalFactPresence } {
  return encodeScalarQuestionnaireValue(descriptor.code, rawVal)
}

export function transcribeBedsideQuestionnaireFacts(
  input: BedsideQuestionnaireTranscriptionInput,
): TranscribedClinicalFactCandidate[] {
  const mappingVersion = input.mappingVersion ?? CLINICAL_FACT_MAPPING_VERSION
  const sortedRevisions = [...input.revisions].sort((a, b) => a.revisionNumber - b.revisionNumber)
  const previousFactIdByCode = new Map<string, string>()
  const candidates: TranscribedClinicalFactCandidate[] = []

  for (const rev of sortedRevisions) {
    const recordId = rev.observationId ?? rev.revisionId
    const recordVersion = rev.observationVersion ?? String(rev.revisionNumber)

    const legacyValues = rev.values
    if (legacyValues !== undefined) {
      for (const descriptor of QUESTIONNAIRE_FIELDS) {
        const encoded = encodeQuestionnaireField(descriptor, legacyValues[descriptor.key])
        const factId = buildFactId('clinmesh-bedside-questionnaire', 'ClinicalRiskAssessment', recordId, recordVersion, descriptor.code)
        const supersedesFactId = previousFactIdByCode.get(descriptor.code) ?? null
        previousFactIdByCode.set(descriptor.code, factId)

        candidates.push({
          factId,
          category: 'bedside-questionnaire',
          itemCode: {
            code: descriptor.code,
            system: CLINMESH_RISK_SYSTEM,
            display: descriptor.display,
          },
          value: encoded.value,
          method: null,
          specimenOrSite: null,
          orderedAt: null,
          effectiveAt: rev.recordedAt,
          reportedAt: rev.recordedAt,
          provenance: {
            recordType: 'ClinicalRiskAssessment',
            recordId,
            recordVersion,
            sourceSystemId: 'clinmesh-bedside-questionnaire',
          },
          institutionScope: 'local',
          recordStatus: rev.revisionNumber > 1 && supersedesFactId ? 'amended' : 'final',
          presence: encoded.presence,
          supersedesFactId,
          verificationStatus: 'not-applicable',
          ingestedAt: rev.recordedAt,
          mappingVersion,
        })
      }
    }

    for (const extra of rev.extraAnswers ?? []) {
      const code = normalizeBedsideItemCode(extra.code)
      const encoded = encodeScalarQuestionnaireValue(code, extra.value, extra.unit)
      const factId = buildFactId('clinmesh-bedside-questionnaire', 'BedsideQuestionnaire', recordId, recordVersion, code)
      const supersedesFactId = previousFactIdByCode.get(code) ?? null
      previousFactIdByCode.set(code, factId)

      candidates.push({
        factId,
        category: 'bedside-questionnaire',
        itemCode: {
          code,
          system: CLINMESH_RISK_SYSTEM,
          display: extra.display ?? code,
        },
        value: encoded.value,
        method: null,
        specimenOrSite: null,
        orderedAt: null,
        effectiveAt: rev.recordedAt,
        reportedAt: rev.recordedAt,
        provenance: {
          recordType: 'BedsideQuestionnaire',
          recordId,
          recordVersion,
          sourceSystemId: 'clinmesh-bedside-questionnaire',
        },
        institutionScope: 'local',
        recordStatus: rev.revisionNumber > 1 && supersedesFactId ? 'amended' : 'final',
        presence: encoded.presence,
        supersedesFactId,
        verificationStatus: 'not-applicable',
        ingestedAt: rev.recordedAt,
        mappingVersion,
      })
    }
  }

  return candidates
}

export function synthesizeUnaskedQuestionnaireCandidates(input: {
  evaluatedAt: string
  items: readonly ActivePackPromptItemInput[]
  mappingVersion?: string
  recordedCodes: ReadonlySet<string>
  subjectId: string
  subjectKind: 'outpatient' | 'inpatient'
}): TranscribedClinicalFactCandidate[] {
  const mappingVersion = input.mappingVersion ?? CLINICAL_FACT_MAPPING_VERSION
  const seen = new Set<string>()
  const candidates: TranscribedClinicalFactCandidate[] = []

  for (const item of input.items) {
    const code = normalizeBedsideItemCode(item.code)
    if (seen.has(code) || input.recordedCodes.has(code)) continue
    seen.add(code)
    const recordId = `${input.subjectKind}:${input.subjectId}`
    candidates.push({
      factId: buildFactId('clinmesh-bedside-questionnaire', 'QuestionnairePrompt', recordId, '0', code),
      category: 'bedside-questionnaire',
      itemCode: {
        code,
        system: CLINMESH_RISK_SYSTEM,
        display: item.labelZh,
      },
      value: { rawText: '没问到', normalizedValue: null },
      method: null,
      specimenOrSite: null,
      orderedAt: null,
      effectiveAt: input.evaluatedAt,
      reportedAt: input.evaluatedAt,
      provenance: {
        recordType: 'QuestionnairePrompt',
        recordId,
        recordVersion: '0',
        sourceSystemId: 'clinmesh-bedside-questionnaire',
      },
      institutionScope: 'local',
      recordStatus: 'final',
      presence: 'not-asked',
      supersedesFactId: null,
      verificationStatus: 'not-applicable',
      ingestedAt: input.evaluatedAt,
      mappingVersion,
    })
  }
  return candidates
}

function evaluateQuantityQc(
  canonicalCode: string,
  numericValue: number,
  rawUnit: string | null,
): ClinicalFactSuspiciousReason[] {
  const spec = CONCEPT_BY_ALIAS.get(canonicalCode)
  if (!spec || !spec.allowedUnits || !spec.plausibleRange || !spec.normalize) {
    return []
  }
  if (!rawUnit || rawUnit.trim().length === 0) {
    return ['unit-not-allowed']
  }
  const normalizedUnit = normalizeUnitToken(rawUnit)
  if (!spec.allowedUnits.includes(normalizedUnit)) {
    return ['unit-not-allowed']
  }
  const converted = spec.normalize(numericValue, normalizedUnit)
  if (!Number.isFinite(converted) || converted < spec.plausibleRange.min || converted > spec.plausibleRange.max) {
    return ['out-of-plausible-range']
  }
  return []
}

function canonicalValueEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left === 'number' && typeof right === 'number') {
    return Math.abs(left - right) <= NUMBER_EPSILON
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, idx) => canonicalValueEquals(entry, right[idx]))
  }
  const leftObj = left as Record<string, unknown>
  const rightObj = right as Record<string, unknown>
  const leftKeys = Object.keys(leftObj).filter(key => leftObj[key] !== undefined).sort()
  const rightKeys = Object.keys(rightObj).filter(key => rightObj[key] !== undefined).sort()
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(
    (key, idx) => key === rightKeys[idx] && Object.hasOwn(rightObj, key) && canonicalValueEquals(leftObj[key], rightObj[key]),
  )
}

function areFactsContradictory(a: TranscribedClinicalFactCandidate, b: TranscribedClinicalFactCandidate): boolean {
  if (a.presence !== b.presence) return true
  const valA = a.value.normalizedValue
  const valB = b.value.normalizedValue

  if (
    typeof valA === 'object' && valA !== null && 'unit' in valA && 'value' in valA
    && typeof valB === 'object' && valB !== null && 'unit' in valB && 'value' in valB
  ) {
    if (valA.unit !== valB.unit) return true
    const maxAbs = Math.max(Math.abs(valA.value), Math.abs(valB.value))
    return Math.abs(valA.value - valB.value) > Math.max(NUMBER_EPSILON, 0.01 * maxAbs)
  }

  return !canonicalValueEquals(valA, valB)
}

export interface ClinicalFactLedgerEvaluationInput {
  hospitalId?: string
  patientId: string
  patientSex?: 'male' | 'female' | 'other' | 'unknown' | null
  subjectKind: ClinicalFactSubjectKind
  subjectId: string
  evaluatedAsOf: string
  includeSuperseded?: boolean
  filterItemCodes?: readonly string[]
  filterCategories?: readonly ClinicalFactCategory[]
  candidates: readonly TranscribedClinicalFactCandidate[]
  verifications?: readonly ClinicalFactVerificationRecord[]
  validityDaysOverrides?: Readonly<Record<string, number>>
  mappingVersion?: string
}

export function evaluateClinicalFactLedger(input: ClinicalFactLedgerEvaluationInput): ClinicalFactLedger {
  const asOfMs = Date.parse(input.evaluatedAsOf)
  if (Number.isNaN(asOfMs)) {
    throw new Error(`Invalid evaluatedAsOf timestamp: ${input.evaluatedAsOf}`)
  }

  const normalizedOverrides = new Map<string, number>()
  for (const [code, days] of Object.entries(input.validityDaysOverrides ?? {})) {
    const canonical = resolveCanonicalItemCode(code)
    normalizedOverrides.set(canonical, tightenValidityDays(canonical, days))
  }

  // Deduplicate candidates by factId while filtering strictly to facts visible at <= asOf
  const visibleMap = new Map<string, TranscribedClinicalFactCandidate>()
  for (const candidate of input.candidates) {
    const ingestedMs = Date.parse(candidate.ingestedAt)
    if (Number.isNaN(ingestedMs) || ingestedMs > asOfMs) continue
    if (candidate.reportedAt !== null) {
      const reportedMs = Date.parse(candidate.reportedAt)
      if (Number.isNaN(reportedMs) || reportedMs > asOfMs) continue
    }
    if (!visibleMap.has(candidate.factId)) {
      visibleMap.set(candidate.factId, candidate)
    }
  }

  const visibleCandidates = [...visibleMap.values()]

  // Resolve supersededBy links strictly within asOf-visible facts (never leak future amendments)
  const supersededByMap = new Map<string, string>()
  for (const candidate of visibleCandidates) {
    if (candidate.supersedesFactId && visibleMap.has(candidate.supersedesFactId)) {
      supersededByMap.set(candidate.supersedesFactId, candidate.factId)
    }
  }

  // Index clinician verifications visible at <= asOf
  const latestVerificationByFactId = new Map<string, ClinicalFactVerificationRecord>()
  for (const ver of input.verifications ?? []) {
    const verifiedMs = Date.parse(ver.verifiedAt)
    if (Number.isNaN(verifiedMs) || verifiedMs > asOfMs) continue
    const existing = latestVerificationByFactId.get(ver.factId)
    if (!existing) {
      latestVerificationByFactId.set(ver.factId, ver)
      continue
    }
    const existingMs = Date.parse(existing.verifiedAt)
    if (verifiedMs > existingMs || (verifiedMs === existingMs && ver.verificationId > existing.verificationId)) {
      latestVerificationByFactId.set(ver.factId, ver)
    }
  }

  // Detect intra-specimen conflicts among active, non-error facts
  const conflictGroupMap = new Map<string, TranscribedClinicalFactCandidate[]>()
  for (const candidate of visibleCandidates) {
    if (supersededByMap.has(candidate.factId)) continue
    if (candidate.recordStatus === 'entered-in-error' || candidate.presence === 'not-asked') continue
    const specimenId = candidate.specimenOrSite?.specimenId
    if (!specimenId) continue
    const key = `${specimenId}::${candidate.itemCode.code}::${candidate.method ?? ''}`
    const group = conflictGroupMap.get(key)
    if (group) group.push(candidate)
    else conflictGroupMap.set(key, [candidate])
  }

  const conflictingIdsByFactId = new Map<string, string[]>()
  for (const group of conflictGroupMap.values()) {
    if (group.length < 2) continue
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!
        const b = group[j]!
        if (areFactsContradictory(a, b)) {
          const listA = conflictingIdsByFactId.get(a.factId) ?? []
          listA.push(b.factId)
          conflictingIdsByFactId.set(a.factId, listA)
          const listB = conflictingIdsByFactId.get(b.factId) ?? []
          listB.push(a.factId)
          conflictingIdsByFactId.set(b.factId, listB)
        }
      }
    }
  }

  const includeSuperseded = input.includeSuperseded ?? false
  const filterCategorySet = input.filterCategories && input.filterCategories.length > 0
    ? new Set(input.filterCategories)
    : null
  const filterItemCodeSet = input.filterItemCodes && input.filterItemCodes.length > 0
    ? new Set(input.filterItemCodes.flatMap(c => [c, resolveCanonicalItemCode(c)]))
    : null

  const evaluatedFacts: ClinicalFact[] = []

  for (const candidate of visibleCandidates) {
    const supersededByFactId = supersededByMap.get(candidate.factId) ?? null
    if (!includeSuperseded && supersededByFactId !== null) continue
    if (filterCategorySet && !filterCategorySet.has(candidate.category)) continue
    if (filterItemCodeSet && !filterItemCodeSet.has(candidate.itemCode.code)) continue

    const latestVer = latestVerificationByFactId.get(candidate.factId)
    const isVerifiedByClinician = latestVer?.decision === 'verified'
    const clinicianVerification = latestVer
      ? {
          verified: isVerifiedByClinician,
          verifiedAt: latestVer.verifiedAt,
          verifiedByActorId: latestVer.verifiedByActorId,
          verifiedByPractitionerId: latestVer.verifiedByPractitionerId,
          note: latestVer.note,
        }
      : {
          verified: false,
          verifiedAt: null,
          verifiedByActorId: null,
          verifiedByPractitionerId: null,
          note: null,
        }

    const suspiciousReasons: ClinicalFactSuspiciousReason[] = []
    if (candidate.sourceQuantityForQc) {
      suspiciousReasons.push(
        ...evaluateQuantityQc(
          candidate.itemCode.code,
          candidate.sourceQuantityForQc.numericValue,
          candidate.sourceQuantityForQc.rawUnit,
        ),
      )
    } else if (
      typeof candidate.value.normalizedValue === 'object'
      && candidate.value.normalizedValue !== null
      && 'value' in candidate.value.normalizedValue
      && 'unit' in candidate.value.normalizedValue
    ) {
      suspiciousReasons.push(
        ...evaluateQuantityQc(
          candidate.itemCode.code,
          candidate.value.normalizedValue.value,
          candidate.value.normalizedValue.unit,
        ),
      )
    }

    if (
      candidate.orderedAt !== null
      && candidate.reportedAt !== null
      && Date.parse(candidate.reportedAt) < Date.parse(candidate.orderedAt)
    ) {
      suspiciousReasons.push('reported-before-ordered')
    }

    const sexRestriction = candidate.sexRestrictionHint
      ?? inferSexRestrictionFromCodeOrText(candidate.itemCode.code, candidate.itemCode.display)
    if (
      sexRestriction
      && (input.patientSex === 'male' || input.patientSex === 'female')
      && sexRestriction !== input.patientSex
    ) {
      suspiciousReasons.push('sex-contradiction')
    }

    const conflictingFactIds = [...new Set(conflictingIdsByFactId.get(candidate.factId) ?? [])].sort()

    const qualityFlags: ClinicalFactQualityFlag[] = []
    if (suspiciousReasons.length > 0) qualityFlags.push('suspicious')
    if (conflictingFactIds.length > 0) qualityFlags.push('conflict')

    const isExternalUnverified = candidate.institutionScope === 'external' && !isVerifiedByClinician
    if (isExternalUnverified) qualityFlags.push('external-unverified')

    const canonicalCode = resolveCanonicalItemCode(candidate.itemCode.code)
    const validityDays = normalizedOverrides.get(canonicalCode) ?? getPublicValidityDays(canonicalCode)
    const anchorIso = candidate.effectiveAt ?? candidate.reportedAt ?? candidate.ingestedAt
    const anchorMs = Date.parse(anchorIso)
    const isExpiredAtAsOf = validityDays !== null && !Number.isNaN(anchorMs)
      ? (asOfMs - anchorMs) > validityDays * DAY_MS
      : false

    const ineligibleReasons: string[] = []
    if (supersededByFactId !== null) ineligibleReasons.push('superseded')
    if (candidate.recordStatus === 'entered-in-error') ineligibleReasons.push('entered-in-error')
    if (candidate.presence === 'not-asked') ineligibleReasons.push('not-asked')
    if (latestVer?.decision === 'rejected') ineligibleReasons.push('clinician-rejected')
    if (isExternalUnverified) ineligibleReasons.push('external-unverified')
    if (isExpiredAtAsOf) ineligibleReasons.push('expired')

    if (!isVerifiedByClinician) {
      for (const reason of suspiciousReasons) {
        ineligibleReasons.push(`suspicious:${reason}`)
      }
      if (conflictingFactIds.length > 0) ineligibleReasons.push('conflict')
    } else {
      // Clinician verification cannot make mathematically non-convertible units or out-of-bounds quantities computable
      for (const reason of suspiciousReasons) {
        if (reason === 'unit-not-allowed' || reason === 'out-of-plausible-range') {
          ineligibleReasons.push(`suspicious:${reason}`)
        }
      }
    }

    evaluatedFacts.push({
      factId: candidate.factId,
      category: candidate.category,
      itemCode: candidate.itemCode,
      value: candidate.value,
      method: candidate.method,
      specimenOrSite: candidate.specimenOrSite,
      orderedAt: candidate.orderedAt,
      effectiveAt: candidate.effectiveAt,
      reportedAt: candidate.reportedAt,
      provenance: candidate.provenance,
      institutionScope: candidate.institutionScope,
      recordStatus: candidate.recordStatus,
      presence: candidate.presence,
      relation: {
        supersedesFactId: candidate.supersedesFactId && visibleMap.has(candidate.supersedesFactId)
          ? candidate.supersedesFactId
          : null,
        supersededByFactId,
      },
      verificationStatus: candidate.verificationStatus,
      ingestedAt: candidate.ingestedAt,
      mappingVersion: candidate.mappingVersion,
      qualityFlags,
      suspiciousReasons,
      conflictingFactIds,
      requiresRecheckPrompt: isExternalUnverified,
      validityDays,
      isExpiredAtAsOf,
      clinicianVerification,
      eligibleForScoringAndRedLine: ineligibleReasons.length === 0,
      ineligibleReasons,
      ...(candidate.abnormal === undefined ? {} : { abnormal: candidate.abnormal }),
    })
  }

  evaluatedFacts.sort((a, b) => {
    const tDiff = Date.parse(a.ingestedAt) - Date.parse(b.ingestedAt)
    if (tDiff !== 0) return tDiff
    if (a.category !== b.category) return a.category.localeCompare(b.category)
    if (a.itemCode.code !== b.itemCode.code) return a.itemCode.code.localeCompare(b.itemCode.code)
    return a.factId.localeCompare(b.factId)
  })

  return {
    trace: {
      hospitalId: input.hospitalId ?? DEFAULT_CLINICAL_FACT_HOSPITAL_ID,
      evaluatedAsOf: input.evaluatedAsOf,
      mappingVersion: input.mappingVersion ?? CLINICAL_FACT_MAPPING_VERSION,
    },
    patientId: input.patientId,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    includeSuperseded,
    facts: evaluatedFacts,
    summary: {
      totalFacts: evaluatedFacts.length,
      eligibleCount: evaluatedFacts.filter(f => f.eligibleForScoringAndRedLine).length,
      suspiciousCount: evaluatedFacts.filter(f => f.qualityFlags.includes('suspicious')).length,
      conflictCount: evaluatedFacts.filter(f => f.qualityFlags.includes('conflict')).length,
      externalUnverifiedCount: evaluatedFacts.filter(f => f.qualityFlags.includes('external-unverified')).length,
      verifiedExternalCount: evaluatedFacts.filter(f => f.institutionScope === 'external' && f.clinicianVerification.verified).length,
      expiredCount: evaluatedFacts.filter(f => f.isExpiredAtAsOf).length,
      supersededCount: evaluatedFacts.filter(f => f.relation.supersededByFactId !== null).length,
      notAskedCount: evaluatedFacts.filter(f => f.presence === 'not-asked').length,
    },
  }
}
