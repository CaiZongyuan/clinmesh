import type {
  ClinicalFact,
  ClinicalFactLedger,
} from '@clinmesh/contracts/clinical-fact-ledger'
import {
  DEFAULT_LOCAL_INGESTION_HOSPITAL_ID,
  DEFAULT_LOCAL_INGESTION_MAPPING_VERSION,
  DEFAULT_PATIENT_MATCH_CONFIDENCE_THRESHOLD,
  evaluateSourceAgnosticismResult,
  PRIMARY_LOCAL_SOURCE_SYSTEM_ID,
  SIM_LIS_V2_SOURCE_SYSTEM_ID,
  type LocalIngestionPatientRef,
  type LocalSourceReportStatus,
  type PatientIdentityCandidate,
  type PrimaryHisLabRecord,
  type SimLisV2Record,
  type SourceAgnosticismResult,
} from '@clinmesh/contracts/local-source-ingestion'
import type { FhirObservationLike } from './clinical-fact-ledger.ts'

const LOINC_SYSTEM = 'http://loinc.org'
const UCUM_SYSTEM = 'http://unitsofmeasure.org'
const INTERPRETATION_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation'

interface AnalyteAdapterSpec {
  canonicalLoincCode: string
  canonicalDisplay: string
  l1TargetUnit: string
  methodHint?: string
  aliases: readonly string[]
  toL1TargetUnit: (value: number, cleanUnit: string) => { value: number; unit: string } | null
}

function roundQuantity(value: number): number {
  return Number(value.toFixed(6))
}

function cleanUnitText(rawUnit: string): string {
  const trimmed = rawUnit.trim()
  const lower = trimmed.toLowerCase()
  if (lower === 'μmol/l' || lower === 'µmol/l' || lower === 'umol/l') return 'umol/L'
  if (lower === 'mmol/l') return 'mmol/L'
  if (lower === 'meq/l') return 'mEq/L'
  if (lower === 'mg/dl') return 'mg/dL'
  if (lower === 'g/dl') return 'g/dL'
  if (lower === 'g/l') return 'g/L'
  if (lower === 'ng/l' || lower === 'pg/ml') return 'ng/L'
  if (lower === 'ng/ml' || lower === 'ug/l' || lower === 'μg/l') return 'ng/mL'
  if (lower === 'miu/ml' || lower === 'iu/l' || lower === 'u/l') return lower === 'miu/ml' ? 'mIU/mL' : 'U/L'
  if (lower === '10*9/l' || lower === '10^9/l' || lower === 'x10^9/l' || lower === '×10^9/l' || lower === 'k/ul') {
    return '10*9/L'
  }
  if (lower === '%') return '%'
  return trimmed
}

const ANALYTE_ADAPTER_SPECS: readonly AnalyteAdapterSpec[] = [
  {
    canonicalLoincCode: '2160-0',
    canonicalDisplay: '血清肌酐',
    l1TargetUnit: 'umol/L',
    aliases: ['2160-0', '14682-9', '1700404A', 'CREA', 'SCR', 'CREAT', 'CREATININE'],
    toL1TargetUnit: (value, unit) => {
      if (unit === 'umol/L') return { value: roundQuantity(value), unit: 'umol/L' }
      if (unit === 'mg/dL') return { value: roundQuantity(value * 88.4), unit: 'umol/L' }
      return null
    },
  },
  {
    canonicalLoincCode: '89579-7',
    canonicalDisplay: '高敏肌钙蛋白I (hs-cTnI)',
    l1TargetUnit: 'ng/L',
    methodHint: 'hs-cTnI',
    aliases: ['89579-7', '49563-0', '2100404B', 'HS-CTNI', 'HS_CTNI', 'HSCTNI'],
    toL1TargetUnit: (value, unit) => {
      if (unit === 'ng/L') return { value: roundQuantity(value), unit: 'ng/L' }
      if (unit === 'ng/mL') return { value: roundQuantity(value * 1000), unit: 'ng/L' }
      return null
    },
  },
  {
    canonicalLoincCode: '10839-9',
    canonicalDisplay: '肌钙蛋白I (常规 cTnI)',
    l1TargetUnit: 'ng/mL',
    methodHint: 'cTnI',
    aliases: ['10839-9', '6598-7', '2100404A', 'CTNI'],
    toL1TargetUnit: (value, unit) => {
      if (unit === 'ng/mL') return { value: roundQuantity(value), unit: 'ng/mL' }
      if (unit === 'ng/L') return { value: roundQuantity(value / 1000), unit: 'ng/mL' }
      return null
    },
  },
  {
    canonicalLoincCode: '6597-9',
    canonicalDisplay: '肌钙蛋白T (cTnT)',
    l1TargetUnit: 'ng/L',
    methodHint: 'cTnT',
    aliases: ['6597-9', '67151-1', '42757-5', '2100504A', 'CTNT', 'HS-CTNT', 'HS_CTNT'],
    toL1TargetUnit: (value, unit) => {
      if (unit === 'ng/L') return { value: roundQuantity(value), unit: 'ng/L' }
      if (unit === 'ng/mL') return { value: roundQuantity(value * 1000), unit: 'ng/L' }
      return null
    },
  },
  {
    canonicalLoincCode: '4548-4',
    canonicalDisplay: '糖化血红蛋白 (HbA1c)',
    l1TargetUnit: '%',
    aliases: ['4548-4', '17856-6', '1100301A', 'HBA1C', 'A1C'],
    toL1TargetUnit: (value, unit) => {
      if (unit === '%') return { value: roundQuantity(value), unit: '%' }
      return null
    },
  },
  {
    canonicalLoincCode: '2093-3',
    canonicalDisplay: '总胆固醇 (TC)',
    l1TargetUnit: 'mmol/L',
    aliases: ['2093-3', '1700301A', 'TC', 'CHOL'],
    toL1TargetUnit: (value, unit) => {
      if (unit === 'mmol/L') return { value: roundQuantity(value), unit: 'mmol/L' }
      if (unit === 'mg/dL') return { value: roundQuantity(value / 38.67), unit: 'mmol/L' }
      return null
    },
  },
  {
    canonicalLoincCode: '2085-9',
    canonicalDisplay: '高密度脂蛋白胆固醇 (HDL-C)',
    l1TargetUnit: 'mmol/L',
    aliases: ['2085-9', '1700302A', 'HDL', 'HDL-C', 'HDLC'],
    toL1TargetUnit: (value, unit) => {
      if (unit === 'mmol/L') return { value: roundQuantity(value), unit: 'mmol/L' }
      if (unit === 'mg/dL') return { value: roundQuantity(value / 38.67), unit: 'mmol/L' }
      return null
    },
  },
  {
    canonicalLoincCode: '13457-7',
    canonicalDisplay: '低密度脂蛋白胆固醇 (LDL-C)',
    l1TargetUnit: 'mmol/L',
    aliases: ['13457-7', '18262-6', '2089-1', '1700303A', 'LDL', 'LDL-C', 'LDLC'],
    toL1TargetUnit: (value, unit) => {
      if (unit === 'mmol/L') return { value: roundQuantity(value), unit: 'mmol/L' }
      if (unit === 'mg/dL') return { value: roundQuantity(value / 38.67), unit: 'mmol/L' }
      return null
    },
  },
  {
    canonicalLoincCode: '2571-8',
    canonicalDisplay: '甘油三酯 (TG)',
    l1TargetUnit: 'mmol/L',
    aliases: ['2571-8', '1700304A', 'TG', 'TRIG'],
    toL1TargetUnit: (value, unit) => {
      if (unit === 'mmol/L') return { value: roundQuantity(value), unit: 'mmol/L' }
      if (unit === 'mg/dL') return { value: roundQuantity(value / 88.57), unit: 'mmol/L' }
      return null
    },
  },
  {
    canonicalLoincCode: '718-7',
    canonicalDisplay: '血红蛋白 (Hb)',
    l1TargetUnit: 'g/L',
    aliases: ['718-7', 'HB', 'HGB'],
    toL1TargetUnit: (value, unit) => {
      if (unit === 'g/L') return { value: roundQuantity(value), unit: 'g/L' }
      if (unit === 'g/dL') return { value: roundQuantity(value * 10), unit: 'g/L' }
      return null
    },
  },
  {
    canonicalLoincCode: '6690-2',
    canonicalDisplay: '白细胞计数 (WBC)',
    l1TargetUnit: '10*9/L',
    aliases: ['6690-2', '26464-8', 'WBC'],
    toL1TargetUnit: (value, unit) => {
      if (unit === '10*9/L') return { value: roundQuantity(value), unit: '10*9/L' }
      return null
    },
  },
  {
    canonicalLoincCode: '2823-3',
    canonicalDisplay: '血清钾 (K+)',
    l1TargetUnit: 'mmol/L',
    aliases: ['2823-3', 'K', 'POTASSIUM', 'SERUM-K'],
    toL1TargetUnit: (value, unit) => {
      if (unit === 'mmol/L' || unit === 'mEq/L') return { value: roundQuantity(value), unit: 'mmol/L' }
      return null
    },
  },
  {
    canonicalLoincCode: '2951-2',
    canonicalDisplay: '血清钠 (Na+)',
    l1TargetUnit: 'mmol/L',
    aliases: ['2951-2', 'NA', 'SODIUM', 'SERUM-NA'],
    toL1TargetUnit: (value, unit) => {
      if (unit === 'mmol/L' || unit === 'mEq/L') return { value: roundQuantity(value), unit: 'mmol/L' }
      return null
    },
  },
  {
    canonicalLoincCode: '21198-7',
    canonicalDisplay: '人绒毛膜促性腺激素/妊娠试验 (hCG)',
    l1TargetUnit: 'mIU/mL',
    aliases: ['21198-7', '2118-8', '2119-6', '19080-1', '2106-3', '82810-3', 'HCG', 'BHCG'],
    toL1TargetUnit: (value, unit) => {
      if (unit === 'mIU/mL' || unit === 'U/L') return { value: roundQuantity(value), unit: 'mIU/mL' }
      return null
    },
  },
  {
    canonicalLoincCode: '2857-1',
    canonicalDisplay: '前列腺特异性抗原 (PSA)',
    l1TargetUnit: 'ng/mL',
    aliases: ['2857-1', 'PSA'],
    toL1TargetUnit: (value, unit) => {
      if (unit === 'ng/mL') return { value: roundQuantity(value), unit: 'ng/mL' }
      if (unit === 'ng/L') return { value: roundQuantity(value / 1000), unit: 'ng/mL' }
      return null
    },
  },
]

const ANALYTE_BY_ALIAS = new Map<string, AnalyteAdapterSpec>()
for (const spec of ANALYTE_ADAPTER_SPECS) {
  for (const alias of spec.aliases) {
    ANALYTE_BY_ALIAS.set(alias.toUpperCase(), spec)
  }
}

function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function buildDeterministicObservationId(sourceSystemId: string, externalReportId: string): string {
  const sourceSlug = sourceSystemId.replace(/[^A-Za-z0-9.-]/g, '-').slice(0, 20)
  const reportSlug = externalReportId.replace(/[^A-Za-z0-9.-]/g, '-').slice(0, 24)
  const suffix = fnv1a32Hex(`${sourceSystemId}::${externalReportId}`)
  const candidate = `l0-${sourceSlug}-${reportSlug}-${suffix}`
  return candidate.slice(0, 64)
}

function mapSourceStatusToFhir(status: LocalSourceReportStatus): 'final' | 'amended' | 'entered-in-error' {
  if (status === 'corrected' || status === 'amended') return 'amended'
  return status
}

function normalizeSpecimenLabel(rawSpecimen?: string | null): string | null {
  if (!rawSpecimen) return null
  const trimmed = rawSpecimen.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  if (lower === 'serum' || lower === '血清' || lower === 'ser') return 'Serum'
  if (lower === 'venous blood' || lower === 'venous_blood' || lower === '静脉血' || lower === 'whole blood' || lower === '全血') {
    return 'Venous blood'
  }
  if (lower === 'plasma' || lower === '血浆') return 'Plasma'
  return trimmed
}

function normalizeMethodText(rawMethod?: string | null): string | null {
  if (!rawMethod) return null
  const trimmed = rawMethod.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  if (lower === 'enzymatic' || lower === '酶法' || lower === '肌氨酸氧化酶法') return 'Enzymatic'
  if (lower === 'eclia' || lower === '电化学发光' || lower === '电化学发光法') return 'ECLIA'
  if (lower === 'clia' || lower === '化学发光' || lower === '化学发光法') return 'CLIA'
  if (lower === 'immunoturbidimetry' || lower === '免疫比浊' || lower === '免疫比浊法') return 'Immunoturbidimetry'
  if (lower === 'ise' || lower === '离子选择电极法') return 'ISE'
  if (lower === 'hplc') return 'HPLC'
  return trimmed
}

function normalizeInterpretationCode(rawFlag?: string | null): string | null {
  if (!rawFlag) return null
  const upper = rawFlag.trim().toUpperCase()
  if (!upper) return null
  if (upper === 'H' || upper === 'HIGH' || upper === '偏高') return 'H'
  if (upper === 'HH' || upper === 'CRIT_HIGH' || upper === 'CRITICAL_HIGH' || upper === '危急高') return 'HH'
  if (upper === 'L' || upper === 'LOW' || upper === '偏低') return 'L'
  if (upper === 'LL' || upper === 'CRIT_LOW' || upper === 'CRITICAL_LOW' || upper === '危急低') return 'LL'
  if (upper === 'N' || upper === 'NORMAL' || upper === '正常') return 'N'
  if (upper === 'POS' || upper === 'POSITIVE' || upper === '阳性') return 'POS'
  return rawFlag.trim()
}

export interface NormalizedFhirProvenanceMetadata {
  resourceType: 'Provenance'
  id: string
  target: ReadonlyArray<{ reference: string }>
  recorded: string
  sourceSystemId: string
  hospitalId: string
  batchId: string
  ingestedAt: string
  mappingVersion: string
  orderedAt: string | null
  externalReportId: string
  specimenBarcode: string | null
  adapterFormat: 'clinmesh-sim-lis-v2' | 'clinmesh-his-fhir-v1'
  meta: {
    versionId: string
    lastUpdated: string
  }
}

export interface NormalizedFhirObservationRecord {
  observation: FhirObservationLike & {
    resourceType: 'Observation'
    subject: { reference: string }
    status: 'final' | 'amended' | 'entered-in-error'
    identifier?: ReadonlyArray<{ system: string; value: string }>
    referenceRange?: ReadonlyArray<{
      low?: { value: number; unit: string }
      high?: { value: number; unit: string }
    }>
    interpretation?: ReadonlyArray<{
      coding: ReadonlyArray<{ system: string; code: string }>
    }>
  }
  provenance: NormalizedFhirProvenanceMetadata
  recordKey: string
  externalReportId: string
  version: number
}

function buildNormalizedFhirRecord(input: {
  sourceSystemId: string
  hospitalId: string
  batchId: string
  ingestedAt: string
  mappingVersion: string
  localPatientId: string
  adapterFormat: 'clinmesh-sim-lis-v2' | 'clinmesh-his-fhir-v1'
  externalReportId: string
  orderId: string | null
  specimenBarcode: string | null
  analyteCode: string
  analyteDisplay: string
  rawValue: number
  rawUnit: string
  effectiveAt: string
  issuedAt: string
  orderedAt: string | null
  status: LocalSourceReportStatus
  version: number
  specimenLabel: string | null
  methodText: string | null
  referenceLow: number | null
  referenceHigh: number | null
  interpretationFlag: string | null
}): NormalizedFhirObservationRecord {
  const obsId = buildDeterministicObservationId(input.sourceSystemId, input.externalReportId)
  const versionStr = String(input.version)
  const spec = ANALYTE_BY_ALIAS.get(input.analyteCode.trim().toUpperCase())
  const cleanedUnit = cleanUnitText(input.rawUnit)
  const converted = spec?.toL1TargetUnit(input.rawValue, cleanedUnit) ?? null
  const finalQuantity = converted ?? { value: input.rawValue, unit: cleanedUnit }

  const canonicalCode = spec?.canonicalLoincCode ?? input.analyteCode.trim()
  const canonicalDisplay = spec?.canonicalDisplay ?? input.analyteDisplay.trim()
  const normalizedSpecimen = normalizeSpecimenLabel(input.specimenLabel)
  const normalizedMethod = spec?.methodHint ?? normalizeMethodText(input.methodText)
  const normalizedInterpretation = normalizeInterpretationCode(input.interpretationFlag)

  const convertedLow = input.referenceLow !== null
    ? (spec?.toL1TargetUnit(input.referenceLow, cleanedUnit)?.value ?? input.referenceLow)
    : null
  const convertedHigh = input.referenceHigh !== null
    ? (spec?.toL1TargetUnit(input.referenceHigh, cleanedUnit)?.value ?? input.referenceHigh)
    : null

  const fhirStatus = mapSourceStatusToFhir(input.status)
  const observation: NormalizedFhirObservationRecord['observation'] = {
    resourceType: 'Observation',
    id: obsId,
    status: fhirStatus,
    category: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/observation-category',
            code: 'laboratory',
            display: 'Laboratory',
          },
        ],
      },
    ],
    code: {
      coding: [
        {
          system: LOINC_SYSTEM,
          code: canonicalCode,
          display: canonicalDisplay,
        },
      ],
      text: canonicalDisplay,
    },
    subject: {
      reference: `Patient/${input.localPatientId}`,
    },
    effectiveDateTime: input.effectiveAt,
    issued: input.issuedAt,
    valueQuantity: {
      value: finalQuantity.value,
      unit: finalQuantity.unit,
      system: UCUM_SYSTEM,
      code: finalQuantity.unit,
    },
    ...(normalizedSpecimen ? { specimen: { display: normalizedSpecimen } } : {}),
    ...(normalizedMethod ? { method: { text: normalizedMethod } } : {}),
    ...(input.orderId ? { basedOn: [{ reference: `ServiceRequest/${input.orderId}` }] } : {}),
    ...(convertedLow !== null || convertedHigh !== null
      ? {
          referenceRange: [
            {
              ...(convertedLow !== null ? { low: { value: convertedLow, unit: finalQuantity.unit } } : {}),
              ...(convertedHigh !== null ? { high: { value: convertedHigh, unit: finalQuantity.unit } } : {}),
            },
          ],
        }
      : {}),
    ...(normalizedInterpretation
      ? {
          interpretation: [
            {
              coding: [
                {
                  system: INTERPRETATION_SYSTEM,
                  code: normalizedInterpretation,
                },
              ],
            },
          ],
        }
      : {}),
    identifier: [
      {
        system: `urn:clinmesh:local-source:${input.sourceSystemId}:report`,
        value: input.externalReportId,
      },
      ...(input.specimenBarcode
        ? [
            {
              system: `urn:clinmesh:local-source:${input.sourceSystemId}:specimen-barcode`,
              value: input.specimenBarcode,
            },
          ]
        : []),
    ],
    meta: {
      versionId: versionStr,
      lastUpdated: input.ingestedAt,
    },
  }

  const provenance: NormalizedFhirProvenanceMetadata = {
    resourceType: 'Provenance',
    id: `prov-${obsId}-v${versionStr}`.slice(0, 64),
    target: [{ reference: `Observation/${obsId}` }],
    recorded: input.ingestedAt,
    sourceSystemId: input.sourceSystemId,
    hospitalId: input.hospitalId,
    batchId: input.batchId,
    ingestedAt: input.ingestedAt,
    mappingVersion: input.mappingVersion,
    orderedAt: input.orderedAt,
    externalReportId: input.externalReportId,
    specimenBarcode: input.specimenBarcode,
    adapterFormat: input.adapterFormat,
    meta: {
      versionId: versionStr,
      lastUpdated: input.ingestedAt,
    },
  }

  return {
    observation,
    provenance,
    recordKey: `${obsId}::v${versionStr}`,
    externalReportId: input.externalReportId,
    version: input.version,
  }
}

export interface NormalizeSimLisV2ReportInput {
  record: SimLisV2Record
  batchId: string
  localPatientId: string
  ingestedAt: string
  sourceSystemId?: string
  hospitalId?: string
  specimenBarcode?: string | null
  mappingVersion?: string
}

export function normalizeSimLisV2ReportToFhir(
  input: NormalizeSimLisV2ReportInput,
): NormalizedFhirObservationRecord {
  const { record } = input
  return buildNormalizedFhirRecord({
    sourceSystemId: input.sourceSystemId ?? SIM_LIS_V2_SOURCE_SYSTEM_ID,
    hospitalId: input.hospitalId ?? DEFAULT_LOCAL_INGESTION_HOSPITAL_ID,
    batchId: input.batchId,
    ingestedAt: input.ingestedAt,
    mappingVersion: input.mappingVersion ?? DEFAULT_LOCAL_INGESTION_MAPPING_VERSION,
    localPatientId: input.localPatientId,
    adapterFormat: 'clinmesh-sim-lis-v2',
    externalReportId: record.externalReportId,
    orderId: record.orderId,
    specimenBarcode: input.specimenBarcode ?? null,
    analyteCode: record.analyte_local_code,
    analyteDisplay: record.analyte_label,
    rawValue: record.result_num,
    rawUnit: record.uom_text,
    effectiveAt: record.collected_ts,
    issuedAt: record.released_ts,
    orderedAt: record.ordered_ts ?? null,
    status: record.report_status,
    version: record.version,
    specimenLabel: record.specimen_type ?? null,
    methodText: record.method_text ?? null,
    referenceLow: record.reference_low ?? null,
    referenceHigh: record.reference_high ?? null,
    interpretationFlag: record.interpretation_flag ?? null,
  })
}

export interface NormalizePrimaryLisReportInput {
  record: PrimaryHisLabRecord
  batchId: string
  localPatientId: string
  ingestedAt: string
  sourceSystemId?: string
  hospitalId?: string
  specimenBarcode?: string | null
  mappingVersion?: string
}

export function normalizePrimaryLisReportToFhir(
  input: NormalizePrimaryLisReportInput,
): NormalizedFhirObservationRecord {
  const { record } = input
  return buildNormalizedFhirRecord({
    sourceSystemId: input.sourceSystemId ?? PRIMARY_LOCAL_SOURCE_SYSTEM_ID,
    hospitalId: input.hospitalId ?? DEFAULT_LOCAL_INGESTION_HOSPITAL_ID,
    batchId: input.batchId,
    ingestedAt: input.ingestedAt,
    mappingVersion: input.mappingVersion ?? DEFAULT_LOCAL_INGESTION_MAPPING_VERSION,
    localPatientId: input.localPatientId,
    adapterFormat: 'clinmesh-his-fhir-v1',
    externalReportId: record.externalReportId,
    orderId: record.orderId ?? null,
    specimenBarcode: input.specimenBarcode ?? null,
    analyteCode: record.loincCode,
    analyteDisplay: record.display,
    rawValue: record.value,
    rawUnit: record.unit,
    effectiveAt: record.effectiveDateTime,
    issuedAt: record.issued,
    orderedAt: record.orderedAt ?? null,
    status: record.status,
    version: record.version,
    specimenLabel: record.specimenLabel ?? null,
    methodText: record.methodText ?? null,
    referenceLow: record.referenceLow ?? null,
    referenceHigh: record.referenceHigh ?? null,
    interpretationFlag: record.interpretationCode ?? null,
  })
}

export interface LocalPatientIndexEntry {
  localPatientId: string
  fullName: string
  birthDate: string
  nationalId: string | null
  phone?: string | null
  linkedExternalIds?: ReadonlyArray<{
    sourceSystemId: string
    externalPatientId: string
  }>
}

export interface MatchSourcePatientIdentityInput {
  candidateId: string
  sourceSystemId: string
  batchId: string
  patientPayload: LocalIngestionPatientRef
  localPatients: readonly LocalPatientIndexEntry[]
  confidenceThreshold?: number
}

function normalizeNameText(value: string): string {
  return value.trim().replace(/\s+/g, '').toUpperCase()
}

function normalizeNationalIdText(value: string): string {
  return value.trim().toUpperCase()
}

function normalizePhoneText(value: string | null | undefined): string | null {
  if (!value) return null
  const normalized = value.replace(/[\s\-()]/g, '')
  return normalized.length > 0 ? normalized : null
}

function computeNameSimilarityDelta(
  incomingName: string,
  localName: string,
): { points: number; reason: string | null } {
  if (incomingName.trim() === localName.trim()) {
    return { points: 0.15, reason: null }
  }
  const normIn = normalizeNameText(incomingName)
  const normLocal = normalizeNameText(localName)
  if (normIn === normLocal) {
    return { points: 0.1, reason: 'name-formatting-variance' }
  }
  if (normIn.includes(normLocal) || normLocal.includes(normIn) || normIn[0] === normLocal[0]) {
    return { points: 0.05, reason: 'name-partial-mismatch' }
  }
  return { points: 0, reason: 'name-mismatch' }
}

export function matchSourcePatientIdentity(
  input: MatchSourcePatientIdentityInput,
): PatientIdentityCandidate {
  const threshold = input.confidenceThreshold ?? DEFAULT_PATIENT_MATCH_CONFIDENCE_THRESHOLD
  const payload = input.patientPayload
  const incomingNatId = normalizeNationalIdText(payload.nationalId)
  const incomingNameNorm = normalizeNameText(payload.fullName)
  const incomingPhone = normalizePhoneText(payload.phone)

  const collisionReasons = new Set<string>()
  const scoredCandidates: Array<{
    localPatientId: string
    score: number
    reasons: string[]
    hasVerifiedNationalId: boolean
  }> = []

  for (const local of input.localPatients) {
    const hasVerifiedExternalLink = Boolean(
      local.linkedExternalIds?.some(
        link => link.sourceSystemId === input.sourceSystemId && link.externalPatientId === payload.externalPatientId,
      ),
    )
    const hasLocalPatientMatch = Boolean(
      payload.localPatientId && payload.localPatientId === local.localPatientId,
    )
    const hasPrimaryDirectIdMatch =
      input.sourceSystemId === PRIMARY_LOCAL_SOURCE_SYSTEM_ID
      && payload.externalPatientId === local.localPatientId
    const hasIdLink = hasVerifiedExternalLink || hasLocalPatientMatch || hasPrimaryDirectIdMatch
    const externalIdCollidesLocalId = payload.externalPatientId === local.localPatientId
    const nameCollides = normalizeNameText(local.fullName) === incomingNameNorm
    const localNatId = local.nationalId ? normalizeNationalIdText(local.nationalId) : null
    const nationalIdMatches = localNatId !== null && localNatId === incomingNatId

    // Rule 1: Different birthDate MUST NEVER merge, even if fullName or externalPatientId collides.
    if (local.birthDate !== payload.birthDate) {
      if (hasIdLink || externalIdCollidesLocalId) {
        collisionReasons.add('external-id-collision-birth-date-mismatch')
      }
      if (nameCollides) {
        collisionReasons.add('homonym-birth-date-mismatch')
      }
      if (nationalIdMatches) {
        collisionReasons.add('national-id-collision-birth-date-mismatch')
      }
      continue
    }

    // Hard distinction if both records hold non-empty, different real national IDs.
    if (localNatId !== null && localNatId !== incomingNatId) {
      if (hasIdLink || externalIdCollidesLocalId || nameCollides) {
        collisionReasons.add('national-id-mismatch')
      }
      continue
    }

    if (localNatId === null && !hasIdLink) {
      if (nameCollides) {
        collisionReasons.add('local-national-id-missing')
      }
      continue
    }

    let score = nationalIdMatches ? 0.58 : 0.48
    const reasons: string[] = []

    if (hasIdLink) {
      score += 0.22
    } else {
      reasons.push('external-patient-id-unlinked')
    }

    const nameEval = computeNameSimilarityDelta(payload.fullName, local.fullName)
    score += nameEval.points
    if (nameEval.reason) reasons.push(nameEval.reason)

    const localPhone = normalizePhoneText(local.phone)
    if (incomingPhone && localPhone) {
      if (incomingPhone === localPhone) {
        score += 0.05
      } else {
        reasons.push('phone-mismatch')
      }
    } else {
      reasons.push('phone-missing')
    }

    if (!nationalIdMatches) {
      reasons.push('local-national-id-missing')
    }

    const clampedScore = Number(Math.min(1, Math.max(0, score)).toFixed(2))
    scoredCandidates.push({
      localPatientId: local.localPatientId,
      score: clampedScore,
      reasons,
      hasVerifiedNationalId: nationalIdMatches,
    })
  }

  if (scoredCandidates.length === 0) {
    if (collisionReasons.size === 0) {
      collisionReasons.add('no-matching-local-patient')
    }
    const hadCollision = !collisionReasons.has('no-matching-local-patient')
    return {
      candidateId: input.candidateId,
      sourceSystemId: input.sourceSystemId,
      externalPatientId: payload.externalPatientId,
      batchId: input.batchId,
      patientPayload: payload,
      matchedLocalPatientId: null,
      confidenceScore: hadCollision ? 0.15 : 0,
      confidenceThreshold: threshold,
      decision: 'distinct-patient',
      mismatchReasons: [...collisionReasons],
      resolutionStatus: 'rejected-distinct',
      resolvedByActorId: null,
      resolvedAt: null,
      auditNote: null,
    }
  }

  scoredCandidates.sort((a, b) => b.score - a.score)
  const best = scoredCandidates[0]!
  const hasTieAtTop = scoredCandidates.length > 1 && scoredCandidates[1]!.score === best.score

  if (hasTieAtTop || !best.hasVerifiedNationalId || best.score < threshold) {
    const reasons = [...best.reasons]
    if (hasTieAtTop) reasons.push('multiple-local-candidates')
    return {
      candidateId: input.candidateId,
      sourceSystemId: input.sourceSystemId,
      externalPatientId: payload.externalPatientId,
      batchId: input.batchId,
      patientPayload: payload,
      matchedLocalPatientId: best.localPatientId,
      confidenceScore: best.score,
      confidenceThreshold: threshold,
      decision: 'quarantined',
      mismatchReasons: reasons,
      resolutionStatus: 'pending-review',
      resolvedByActorId: null,
      resolvedAt: null,
      auditNote: null,
    }
  }

  return {
    candidateId: input.candidateId,
    sourceSystemId: input.sourceSystemId,
    externalPatientId: payload.externalPatientId,
    batchId: input.batchId,
    patientPayload: payload,
    matchedLocalPatientId: best.localPatientId,
    confidenceScore: best.score,
    confidenceThreshold: threshold,
    decision: 'matched',
    mismatchReasons: best.reasons,
    resolutionStatus: 'auto-matched',
    resolvedByActorId: null,
    resolvedAt: null,
    auditNote: null,
  }
}

export function isBatchComplete(expectedItemCount: number, receivedItemCount: number): boolean {
  return (
    Number.isInteger(expectedItemCount)
    && expectedItemCount > 0
    && Number.isInteger(receivedItemCount)
    && receivedItemCount === expectedItemCount
  )
}

export interface CompareSourceSystemLedgersInput {
  leftSourceSystemId: string
  leftLedger: ClinicalFactLedger
  rightSourceSystemId: string
  rightLedger: ClinicalFactLedger
  categories?: readonly ClinicalFact['category'][]
}

export function compareSourceSystemLedgers(
  input: CompareSourceSystemLedgersInput,
): SourceAgnosticismResult {
  const categorySet = input.categories ? new Set(input.categories) : null
  const filterFacts = (ledger: ClinicalFactLedger, sourceSystemId: string) =>
    ledger.facts.filter(
      fact =>
        fact.provenance.sourceSystemId === sourceSystemId
        && (categorySet === null || categorySet.has(fact.category)),
    )

  return evaluateSourceAgnosticismResult(
    {
      sourceSystemId: input.leftSourceSystemId,
      facts: filterFacts(input.leftLedger, input.leftSourceSystemId),
    },
    {
      sourceSystemId: input.rightSourceSystemId,
      facts: filterFacts(input.rightLedger, input.rightSourceSystemId),
    },
  )
}
