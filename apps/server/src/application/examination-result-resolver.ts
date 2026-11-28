import { z } from 'zod'
import { investigationResultContentSchema, type InvestigationResultContent } from '@clinmesh/contracts/scenario'
import { examinationServiceSnapshotSchema } from '@clinmesh/contracts/his'
import { v7 as uuidv7 } from 'uuid'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import { InvestigationResultRepository } from '../infrastructure/sqlite/investigation-result-repository.ts'
import { SyntheticCaseRepository } from '../infrastructure/sqlite/synthetic-case-repository.ts'
import { SyntheticPatientProfileRepository } from '../infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import { InvestigationGenerationError } from './investigation-service.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
import {
  buildTruthStagePriority,
  EXAMINATION_CONCLUSION_SYSTEM,
  EXAMINATION_ECG_SYSTEM,
  EXAMINATION_EXAM_CODE_EXTENSION_URL,
  EXAMINATION_SERVICE_SYSTEM,
  EXAMINATION_TTE_SYSTEM,
  readExtensionCode,
  readTruthStage,
  selectStageBucket,
  type CaseTruthStage,
} from './scenario-data/truth-stage.ts'
import type { ExaminationResult } from './examination-request-service.ts'

const examinationServiceSystem = EXAMINATION_SERVICE_SYSTEM
const examinationMetricSystems: Record<'ecg-12-lead' | 'tte', readonly string[]> = {
  'ecg-12-lead': [EXAMINATION_SERVICE_SYSTEM, EXAMINATION_ECG_SYSTEM],
  tte: [EXAMINATION_SERVICE_SYSTEM, EXAMINATION_TTE_SYSTEM],
}
const allExaminationMetricSystems = new Set<string>([
  EXAMINATION_SERVICE_SYSTEM,
  EXAMINATION_ECG_SYSTEM,
  EXAMINATION_TTE_SYSTEM,
])
const examinationConclusionSystem = EXAMINATION_CONCLUSION_SYSTEM

type Definition = {
  code: string
  display: string
  value: number | string
  low?: number
  high?: number
  unit?: string
  sourceCodes?: string[]
}
const definitions: Record<'ecg-12-lead' | 'tte', Definition[]> = {
  'ecg-12-lead': [
    { code: 'rhythm', display: '心律', value: '窦性心律' },
    {
      code: 'ventricular-rate',
      display: '心室率',
      value: 72,
      low: 60,
      high: 100,
      unit: '/min',
      sourceCodes: ['8867-4'],
    },
    { code: 'pr-interval', display: 'PR 间期', value: 160, low: 120, high: 200, unit: 'ms', sourceCodes: ['8625-6'] },
    { code: 'qrs-duration', display: 'QRS 时限', value: 90, low: 60, high: 110, unit: 'ms', sourceCodes: ['8633-0'] },
    { code: 'qtc-interval', display: 'QTc 间期', value: 410, low: 350, high: 450, unit: 'ms', sourceCodes: ['8636-3'] },
    { code: 'st-t-anterior', display: '前壁导联组 ST-T', value: '未见明显异常' },
    { code: 'st-t-inferior', display: '下壁导联组 ST-T', value: '未见明显异常' },
    { code: 'st-t-lateral', display: '侧壁导联组 ST-T', value: '未见明显异常' },
  ],
  tte: [
    { code: 'lvef', display: '左室射血分数 LVEF', value: 62, low: 50, high: 75, unit: '%', sourceCodes: ['10230-1'] },
    { code: 'lvedd', display: '左室舒张末期内径', value: 48, low: 35, high: 56, unit: 'mm', sourceCodes: ['29468-6'] },
    { code: 'regional-wall-motion', display: '室壁节段运动', value: '未见节段性室壁运动异常' },
    { code: 'valves', display: '瓣膜', value: '瓣膜结构及启闭未见明显异常' },
    { code: 'diastolic-function', display: '舒张功能', value: '左室舒张功能未见明显异常' },
  ],
}

const measurementSchema = z
  .object({
    code: z
      .object({
        coding: z
          .array(z.object({ code: z.string(), system: z.string().optional(), display: z.string().optional() }).loose())
          .optional(),
        text: z.string().optional(),
      })
      .loose()
      .optional(),
  })
  .loose()
const resourceSchema = measurementSchema.extend({
  resourceType: z.string(),
  component: z.array(measurementSchema).optional(),
})
function semanticEvidence(resources: z.infer<typeof resourceSchema>[]) {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value))
      return value.map(normalize).sort((a, b) => canonicalJsonHash(a).localeCompare(canonicalJsonHash(b)))
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]))
    return value
  }
  return resources
    .map((item) =>
      normalize({
        resourceType: item.resourceType,
        code: item.code,
        clinicalStatus: item.clinicalStatus,
        verificationStatus: item.verificationStatus,
        status: item.status,
        valueQuantity: item.valueQuantity,
        valueString: item.valueString,
        valueBoolean: item.valueBoolean,
        valueCodeableConcept: item.valueCodeableConcept,
        component: item.component,
        interpretation: item.interpretation,
        ...(item.extension === undefined ? {} : { extension: item.extension }),
      }),
    )
    .sort((a, b) => canonicalJsonHash(a).localeCompare(canonicalJsonHash(b)))
}
const cardiovascularSnomed = new Set([
  '59621000',
  '53741008',
  '22298006',
  '84114007',
  '49436004',
  '42343007',
  '49483002',
  '164889003',
  '233970002',
  '429559004',
  '429007001',
  '25569003',
  '6456007',
  '71908006',
])
// A negative display keyword match cannot classify an unfamiliar SNOMED code.
const baselineNonCardiovascularSnomed = new Set([
  '10509002',
  '233604007',
  '386661006',
  '44054006',
  '195662009',
  '254637007',
  '399208008',
])
function refuted(resource: z.infer<typeof resourceSchema>): boolean {
  return (
    z
      .object({ coding: z.array(z.object({ code: z.string() }).loose()).optional() })
      .loose()
      .safeParse(resource.verificationStatus)
      .data?.coding?.some((item) => ['refuted', 'entered-in-error'].includes(item.code)) === true
  )
}
function cardiovascular(resource: z.infer<typeof resourceSchema>): boolean {
  if (!['Condition', 'Procedure', 'Observation'].includes(resource.resourceType)) return false
  if (resource.status === 'entered-in-error' || refuted(resource)) return false
  const codings = resource.code?.coding ?? []
  return (
    codings.some(
      (item) =>
        (/icd-?10/i.test(item.system ?? '') && /^(?:I\d|Q2[0-8]|R0[01]|R94\.3|Z86\.7|Z95|Z98\.6)/i.test(item.code)) ||
        (item.system === 'http://snomed.info/sct' && cardiovascularSnomed.has(item.code)),
    ) ||
    /冠心病|冠状动脉|心血管|循环系统|高血压|心肌|心衰|心力衰竭|心律|房颤|房扑|瓣膜|心脏|室性|室上性|心动过速|心动过缓|早搏|传导阻滞|心包|主动脉|肺心病|肺动脉高压|动脉粥样硬化|先天性心|心绞痛|缺血|coronary|cardiac|cardiovascular|heart (?:failure|disease|attack|defect)|myocard|ischemi|infarct|atheroscl|hypertension|arrhythm|tachycard|bradycard|fibrillation|flutter|heart block|conduction.*block|atrioventricular.*block|bundle branch block|cardiomyopath|endocard|pericard|valvular|mitral|tricuspid|pulmonic|angina|cardiomegaly|aortic|pulmonary hypertension/i.test(
      [resource.code?.text, ...codings.map((item) => item.display)].join(' '),
    )
  )
}

function unclassifiedClinicalHistory(resource: z.infer<typeof resourceSchema>): boolean {
  if (!['Condition', 'Procedure'].includes(resource.resourceType) || refuted(resource)) return false
  return !(resource.code?.coding ?? []).some(
    (coding) =>
      (coding.system === 'http://snomed.info/sct' && baselineNonCardiovascularSnomed.has(coding.code)) ||
      (/icd-?10/i.test(coding.system ?? '') && /^[A-Z]\d{2}(?:\.?[A-Z\d]+)?$/i.test(coding.code)),
  )
}

const finalizedObservationStatuses = new Set(['final', 'amended', 'corrected'])
function finalizedObservation(resource: z.infer<typeof resourceSchema>): boolean {
  return (
    resource.resourceType === 'Observation'
    && typeof resource.status === 'string'
    && finalizedObservationStatuses.has(resource.status)
    && !refuted(resource)
  )
}

function incompatibleBaselineMeasurement(resource: z.infer<typeof resourceSchema>): boolean {
  if (resource.resourceType !== 'Observation' || resource.status === 'entered-in-error' || refuted(resource)) return false
  const finalized = finalizedObservation(resource)
  return [resource, ...resource.component ?? []].some(measurement => {
    const definition = Object.values(definitions).flat().find(item => measurement.code?.coding?.some(coding =>
      coding.system !== undefined && allExaminationMetricSystems.has(coding.system) && coding.code === item.code
      || coding.system === 'http://loinc.org' && item.sourceCodes?.includes(coding.code),
    ))
    if (definition === undefined) return false
    if (!finalized) return true
    if (typeof definition.value === 'number') {
      const quantity = z.object({ value: z.number().finite(), code: z.string().optional(), unit: z.string().optional(), system: z.string().optional() })
        .loose().safeParse(measurement.valueQuantity)
      const units = definition.unit === '/min' ? ['/min', '{beats}/min', 'min-1', 'bpm', 'beats/min'] : [definition.unit]
      if (!quantity.success || !units.includes(quantity.data.code ?? quantity.data.unit)
        || quantity.data.system !== undefined && quantity.data.system !== 'http://unitsofmeasure.org'
        || quantity.data.value < (definition.low ?? 0) || quantity.data.value > (definition.high ?? 1000)) return true
    } else if (measurement.valueString !== definition.value) return true
    if (measurement.interpretation === undefined) return false
    const interpretation = z.array(z.object({ coding: z.array(z.object({ code: z.string() }).loose()).optional(), text: z.string().optional() }).loose())
      .safeParse(measurement.interpretation)
    return !interpretation.success || interpretation.data.some(item =>
      item.coding?.some(coding => !['N', 'NORMAL'].includes(coding.code.toUpperCase()))
      || item.text !== undefined && !/^(?:normal|正常)$/i.test(item.text.trim()),
    )
  })
}

function matchesExamMetric(
  measurement: z.infer<typeof measurementSchema>,
  examCode: 'ecg-12-lead' | 'tte',
  definition: Definition,
  allowLoinc: boolean,
): boolean {
  const systems = examinationMetricSystems[examCode]
  return measurement.code?.coding?.some(
    (coding) =>
      (coding.system !== undefined && systems.includes(coding.system) && coding.code === definition.code)
      || (allowLoinc && coding.system === 'http://loinc.org' && definition.sourceCodes?.includes(coding.code)),
  ) === true
}

function matchesExamConclusion(
  resource: z.infer<typeof resourceSchema>,
  examCode: 'ecg-12-lead' | 'tte',
): boolean {
  const examCodeExt = readExtensionCode(resource, EXAMINATION_EXAM_CODE_EXTENSION_URL)
  const codings = resource.code?.coding ?? []
  const examSpecificSystem = examCode === 'ecg-12-lead' ? EXAMINATION_ECG_SYSTEM : EXAMINATION_TTE_SYSTEM
  return codings.some((coding) => {
    if (coding.system === examinationConclusionSystem) {
      if (coding.code === examCode) return examCodeExt === undefined || examCodeExt === examCode
      if (coding.code === 'conclusion') return examCodeExt === undefined || examCodeExt === examCode
      return false
    }
    if (coding.system === examSpecificSystem && coding.code === 'conclusion') {
      return examCodeExt === undefined || examCodeExt === examCode
    }
    if (coding.system === examinationServiceSystem && coding.code === 'conclusion') {
      return examCodeExt === examCode
    }
    return false
  })
}

/** Simulator-only boundary: private truth is consumed here and only validated result values leave it. */
export class ExaminationResultResolver {
  constructor(private readonly database: ClinMeshDatabase) {}

  resolve(workspaceId: string, epoch: string, requestId: string): ExaminationResult {
    const row = z
      .object({
        admission_id: z.string().nullable(),
        case_id: z.string(),
        is_revisit: z.number().int().min(0).max(1),
        service_snapshot_json: z.string(),
        result_snapshot_id: z.string().nullable(),
        synthetic_case_id: z.string().nullable(),
        synthetic_case_revision: z.number().nullable(),
        profile_id: z.string().nullable(),
        profile_revision: z.number().nullable(),
        patient_id: z.string(),
        authored_at: z.string(),
      })
      .optional()
      .parse(
        this.database.driver
          .prepare(
            `
      SELECT r.case_id,r.service_snapshot_json,r.result_snapshot_id,r.authored_at,
        s.synthetic_case_id,s.synthetic_case_revision,s.profile_id,s.profile_revision,
        c.admission_id,c.patient_id,
        CASE WHEN revisit.source_case_id IS NOT NULL THEN 1 ELSE 0 END AS is_revisit
      FROM laboratory_request r
      JOIN clinical_request_source s USING(workspace_id,epoch,case_id)
      JOIN clinical_request_context c USING(workspace_id,epoch,case_id)
      LEFT JOIN outpatient_case_source revisit
        ON revisit.workspace_id=c.workspace_id AND revisit.epoch=c.epoch AND revisit.outpatient_case_id=c.outpatient_case_id
      WHERE r.workspace_id=? AND r.epoch=? AND r.request_id=? AND r.request_kind='examination'
    `,
          )
          .get(workspaceId, epoch, requestId),
      )
    if (row === undefined)
      throw new InvestigationGenerationError('INVESTIGATION_UNSUPPORTED', '功能检查缺少固定合成病例来源')
    const snapshots = new InvestigationResultRepository(this.database)
    const bound = row.result_snapshot_id === null ? undefined : snapshots.getById(workspaceId, row.result_snapshot_id)
    if (bound !== undefined) return { snapshotId: bound.snapshotId, content: bound.content }
    if (
      row.synthetic_case_id === null
      || row.synthetic_case_revision === null
      || row.profile_id === null
      || row.profile_revision === null
    )
      throw new InvestigationGenerationError('INVESTIGATION_UNSUPPORTED', '功能检查缺少固定合成病例来源')
    const service = examinationServiceSnapshotSchema.parse(JSON.parse(row.service_snapshot_json))
    const cases = new SyntheticCaseRepository(this.database)
    const source = cases.get(workspaceId, row.synthetic_case_id)
    const truth = cases.getTruthForSimulator(workspaceId, row.synthetic_case_id)
    if (source === undefined || truth === undefined)
      throw new InvestigationGenerationError('INVESTIGATION_UNSUPPORTED', '功能检查病例来源不完整')
    const profile = new SyntheticPatientProfileRepository(this.database).getRevision(
      workspaceId,
      row.profile_id,
      row.profile_revision,
    )
    if (profile === undefined)
      throw new InvestigationGenerationError('INVESTIGATION_UNSUPPORTED', '功能检查人口学来源缺失')
    const hidden = truth.hiddenResources.map((item) => resourceSchema.parse(item.resource))
    const history = z
      .array(z.object({ resource_json: z.string() }))
      .parse(
        this.database.driver
          .prepare('SELECT resource_json FROM synthetic_case_visible_resource WHERE workspace_id=? AND case_id=?')
          .all(workspaceId, row.synthetic_case_id),
      )
      .map((item) => resourceSchema.parse(JSON.parse(item.resource_json)))
    const formal = z
      .array(z.object({ resource_json: z.string() }))
      .parse(
        this.database.driver
          .prepare(
            `SELECT content_json AS resource_json FROM fhir_resource
      WHERE workspace_id=? AND epoch=? AND deleted=0 AND resource_type IN ('Condition','Observation','Procedure')
        AND json_extract(content_json,'$.subject.reference')=?`,
          )
          .all(workspaceId, epoch, 'Patient/' + row.patient_id),
      )
      .map((item) => resourceSchema.parse(JSON.parse(item.resource_json)))
      .filter((item) => !(item.code?.coding ?? []).some((coding) => coding.system?.endsWith('/examination-service')))
    const hasPriorSigned = this.database.driver
      .prepare(
        `SELECT 1 FROM examination_report_content c
      JOIN laboratory_request r ON r.workspace_id=c.workspace_id AND r.epoch=c.epoch AND r.request_id=c.request_id
      JOIN examination_request_detail d ON d.workspace_id=c.workspace_id AND d.epoch=c.epoch AND d.request_id=c.request_id
      WHERE c.workspace_id=? AND c.epoch=? AND c.case_id=? AND d.exam_code=?
        AND r.status IN ('reported','acknowledged') AND c.request_id!=?
      LIMIT 1`,
      )
      .get(workspaceId, epoch, row.case_id, service.examCode, requestId) !== undefined
    const stagePriority = buildTruthStagePriority({
      isInpatient: row.admission_id !== null,
      isRepeat: hasPriorSigned,
      isRevisit: row.is_revisit === 1,
    })
    const requested = definitions[service.examCode]
    const finalizedHidden = hidden.filter(finalizedObservation)
    const allTaggedMeasurements = finalizedHidden.flatMap((item) => {
      const parentStage = readTruthStage(item)
      return [
        { measurement: item as z.infer<typeof measurementSchema>, stage: parentStage },
        ...(item.component ?? []).map((component) => ({
          measurement: component,
          stage: readTruthStage(component) ?? parentStage,
        })),
      ]
    })
    const isSpecificExamMeasurement = (measurement: z.infer<typeof measurementSchema>) =>
      requested.some((definition) =>
        matchesExamMetric(
          measurement,
          service.examCode,
          definition,
          !(service.examCode === 'ecg-12-lead' && definition.code === 'ventricular-rate'),
        ),
      )
    const examSpecificBucket = selectStageBucket(
      allTaggedMeasurements.filter((entry) => isSpecificExamMeasurement(entry.measurement)),
      (entry) => entry.stage,
      stagePriority,
    )
    const selectedMetricStage: CaseTruthStage | undefined = examSpecificBucket?.stage
    const conclusionCandidates = finalizedHidden
      .filter((item) => matchesExamConclusion(item, service.examCode))
      .map((item) => ({ resource: item, stage: readTruthStage(item) }))
    const conclusionBucket = selectStageBucket(conclusionCandidates, (entry) => entry.stage, stagePriority)
    const resolvedStage = selectedMetricStage ?? conclusionBucket?.stage
    const inputHash = canonicalJsonHash({
      policy: 'functional-examination-v1',
      service,
      sourceHash: source.sourceHash,
      revision: row.synthetic_case_revision,
      demographics: profile.demographics,
      hidden: semanticEvidence(hidden),
      history: semanticEvidence(history),
      evidence: semanticEvidence(formal),
      ...(resolvedStage === undefined ? {} : { truthStage: resolvedStage }),
    })
    const existing = snapshots.getByEvidence(workspaceId, row.synthetic_case_id, service.id, inputHash)
    if (existing !== undefined) return { snapshotId: existing.snapshotId, content: existing.content }
    const stageMeasurements =
      examSpecificBucket === undefined
        ? allTaggedMeasurements
            .filter((entry) => entry.stage === undefined)
            .map((entry) => entry.measurement)
        : allTaggedMeasurements
            .filter((entry) => entry.stage === selectedMetricStage)
            .map((entry) => entry.measurement)
    const hasEcgSpecificTruth = examSpecificBucket !== undefined
    const normalizeExactUnit = (definition: Definition, rawUnit: string | undefined) =>
      definition.unit === '/min' && rawUnit !== undefined && ['/min', '{beats}/min', 'min-1', 'bpm', 'beats/min'].includes(rawUnit)
        ? '/min'
        : rawUnit
    const exact = requested.map((definition) => {
      // A routine heart-rate vital alone does not declare a partial ECG panel.
      if (service.examCode === 'ecg-12-lead' && definition.code === 'ventricular-rate' && !hasEcgSpecificTruth)
        return undefined
      const directMatches = stageMeasurements.filter((measurement) =>
        matchesExamMetric(measurement, service.examCode, definition, false),
      )
      const matches =
        definition.code === 'ventricular-rate' && directMatches.length > 0
          ? directMatches
          : stageMeasurements.filter((measurement) =>
              matchesExamMetric(measurement, service.examCode, definition, true),
            )
      const values = matches.map((item) => {
        if (typeof definition.value !== 'number') return { value: item.valueString }
        const quantity = z
          .object({
            value: z.number().finite(),
            code: z.string().optional(),
            unit: z.string().optional(),
            system: z.string().optional(),
          })
          .loose()
          .safeParse(item.valueQuantity)
        return quantity.success
          ? {
              system: quantity.data.system ?? 'http://unitsofmeasure.org',
              unit: normalizeExactUnit(definition, quantity.data.code ?? quantity.data.unit),
              value: quantity.data.value,
            }
          : { invalidQuantity: item.valueQuantity }
      })
      if (new Set(values.map((value) => canonicalJsonHash(value))).size > 1)
        throw new InvestigationGenerationError(
          'INVESTIGATION_TRUTH_INCOMPATIBLE',
          '功能检查同一指标存在冲突精确真值，不能选择性签发报告',
        )
      return matches[0]
    })
    const hasExact = exact.some((item) => item !== undefined)
    if (hasExact && exact.some((item) => item === undefined))
      throw new InvestigationGenerationError(
        'INVESTIGATION_TRUTH_INCOMPATIBLE',
        '功能检查精确真值不完整，不能补造正常指标',
      )
    let exactConclusion: string | undefined
    if (conclusionBucket !== undefined) {
      const texts = conclusionBucket.items.map((entry) => {
        const parsed = z.string().trim().min(1).max(1000).safeParse(entry.resource.valueString)
        if (!parsed.success) {
          throw new InvestigationGenerationError(
            'INVESTIGATION_TRUTH_INCOMPATIBLE',
            '功能检查精确结论缺少有效文本内容',
          )
        }
        return parsed.data
      })
      if (new Set(texts).size > 1) {
        throw new InvestigationGenerationError(
          'INVESTIGATION_TRUTH_INCOMPATIBLE',
          '功能检查精确结论存在冲突，不能选择性签发报告',
        )
      }
      exactConclusion = texts[0]
    }
    if (!hasExact) {
      if (profile.source.providerId !== 'synthea')
        throw new InvestigationGenerationError(
          'INVESTIGATION_UNSUPPORTED',
          '本病例未预置该检查',
        )
      const age = (Date.parse(row.authored_at) - Date.parse(profile.demographics.birthDate)) / (365.2425 * 86_400_000)
      if (age < 18 || age > 120 || !Number.isFinite(age))
        throw new InvestigationGenerationError('INVESTIGATION_UNSUPPORTED', '功能检查成人正常基线不适用于该患者')
      if ([...hidden, ...history, ...formal].some(incompatibleBaselineMeasurement))
        throw new InvestigationGenerationError(
          'INVESTIGATION_TRUTH_INCOMPATIBLE',
          '病例已有功能指标异常或其数值、单位与标记无法判定，不能生成正常功能检查基线',
        )
      if ([...hidden, ...history, ...formal].some(cardiovascular))
        throw new InvestigationGenerationError(
          'INVESTIGATION_TRUTH_INCOMPATIBLE',
          '患者存在心血管阳性事实且无完整精确检查真值，不能生成正常报告',
        )
      if ([...hidden, ...history, ...formal].some(unclassifiedClinicalHistory))
        throw new InvestigationGenerationError(
          'INVESTIGATION_UNSUPPORTED',
          '病例含尚未分类的诊断或操作证据，不能仅凭显示文字推定无心血管冲突并生成正常报告',
        )
    }
    const content: InvestigationResultContent = investigationResultContentSchema.parse({
      conclusion: hasExact
        ? (exactConclusion ?? '功能检查结果见结构化指标，请结合临床判断。')
        : service.examCode === 'ecg-12-lead'
          ? '窦性心律，未见明显 ST-T 异常（确定性合成成人基线）。'
          : '心脏结构及左室收缩、舒张功能未见明显异常（确定性合成成人基线）。',
      results: requested.map((definition, index) => {
        const observation = exact[index]
        const quantity = z
          .object({
            value: z.number().finite(),
            code: z.string().optional(),
            unit: z.string().optional(),
            system: z.string().optional(),
          })
          .loose()
          .safeParse(observation?.valueQuantity)
        const value =
          observation === undefined
            ? definition.value
            : typeof definition.value === 'number'
              ? quantity.success
                ? quantity.data.value
                : undefined
              : z.string().trim().min(1).max(1000).safeParse(observation.valueString).data
        if (value === undefined || (typeof value === 'number' && (value < 0 || value > 1000)))
          throw new InvestigationGenerationError('INVESTIGATION_TRUTH_INCOMPATIBLE', '功能检查精确真值数值或单位无效')
        if (
          observation !== undefined &&
          definition.unit !== undefined &&
          (
            !quantity.success ||
            (quantity.data.system !== undefined && quantity.data.system !== 'http://unitsofmeasure.org') ||
            normalizeExactUnit(definition, quantity.data.code ?? quantity.data.unit) !== definition.unit
          )
        )
          throw new InvestigationGenerationError('INVESTIGATION_TRUTH_INCOMPATIBLE', '功能检查精确真值单位不相容')
        return {
          code: definition.code,
          display: definition.display,
          value,
          source: hasExact ? 'case-truth-exact' : 'adult-reference-baseline',
          interpretation:
            typeof value === 'number'
              ? value < (definition.low ?? 0)
                ? 'low'
                : value > (definition.high ?? 1000)
                  ? 'high'
                  : 'normal'
              : value === definition.value
                ? 'normal'
                : 'abnormal',
          referenceRange: {
            text: typeof definition.value === 'string' ? definition.value : `${definition.low}–${definition.high}`,
            ...(definition.low === undefined ? {} : { low: definition.low }),
            ...(definition.high === undefined ? {} : { high: definition.high }),
          },
          ...(definition.unit === undefined
            ? {}
            : { unit: { code: definition.unit, display: definition.unit, system: 'http://unitsofmeasure.org' } }),
        }
      }),
    })
    const snapshot = snapshots.createOrGet({
      workspaceId,
      caseId: row.synthetic_case_id,
      catalogItemId: service.id,
      snapshotId: uuidv7(),
      content,
      inputHash,
      outputHash: canonicalJsonHash(content),
      createdAt: new Date().toISOString(),
      source: hasExact ? 'case-truth-exact' : 'adult-reference-baseline',
      model: null,
      promptHash: null,
      promptVersion: null,
      requestedConcept: {
        id: service.id,
        code: service.code,
        display: service.name,
        system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/examination-service',
        version: String(service.version),
        sourceLocator: 'Hospital Baseline functional examination',
      },
    })
    return { snapshotId: snapshot.snapshotId, content: snapshot.content }
  }
}
