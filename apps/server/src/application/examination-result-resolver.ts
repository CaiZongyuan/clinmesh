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
import type { ExaminationResult } from './examination-request-service.ts'

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
  if (refuted(resource)) return false
  const codings = resource.code?.coding ?? []
  return (
    codings.some(
      (item) =>
        (/icd-?10/i.test(item.system ?? '') && /^(?:I\d|Q2[0-8]|R0[01]|Z95)/i.test(item.code)) ||
        (item.system === 'http://snomed.info/sct' && cardiovascularSnomed.has(item.code)),
    ) ||
    /冠心病|高血压|心肌|心衰|心力衰竭|心律|房颤|房扑|瓣膜|心脏|室性|室上性|心动过速|心动过缓|早搏|传导阻滞|心包|主动脉|肺心病|肺动脉高压|动脉粥样硬化|先天性心|心绞痛|缺血|coronary|cardiac|cardiovascular|heart (?:failure|disease|attack|defect)|myocard|ischemi|infarct|atheroscl|hypertension|arrhythm|tachycard|bradycard|fibrillation|flutter|heart block|conduction.*block|atrioventricular.*block|bundle branch block|cardiomyopath|endocard|pericard|valvular|mitral|tricuspid|pulmonic|angina|cardiomegaly|aortic|pulmonary hypertension/i.test(
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

function incompatibleBaselineMeasurement(resource: z.infer<typeof resourceSchema>): boolean {
  if (resource.resourceType !== 'Observation' || resource.status === 'entered-in-error') return false
  return [resource, ...resource.component ?? []].some(measurement => {
    const definition = Object.values(definitions).flat().find(item => measurement.code?.coding?.some(coding =>
      coding.system === 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/examination-service' && coding.code === item.code
      || coding.system === 'http://loinc.org' && item.sourceCodes?.includes(coding.code),
    ))
    if (definition === undefined) return false
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

/** Simulator-only boundary: private truth is consumed here and only validated result values leave it. */
export class ExaminationResultResolver {
  constructor(private readonly database: ClinMeshDatabase) {}

  resolve(workspaceId: string, epoch: string, requestId: string): ExaminationResult {
    const row = z
      .object({
        case_id: z.string(),
        service_snapshot_json: z.string(),
        result_snapshot_id: z.string().nullable(),
        synthetic_case_id: z.string(),
        synthetic_case_revision: z.number(),
        profile_id: z.string(),
        profile_revision: z.number(),
        patient_id: z.string(),
        authored_at: z.string(),
      })
      .optional()
      .parse(
        this.database.driver
          .prepare(
            `
      SELECT r.case_id,r.service_snapshot_json,r.result_snapshot_id,r.authored_at,s.synthetic_case_id,s.synthetic_case_revision,s.profile_id,s.profile_revision,c.patient_id
      FROM laboratory_request r JOIN clinical_request_source s USING(workspace_id,epoch,case_id) JOIN clinical_request_context c USING(workspace_id,epoch,case_id)
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
    const inputHash = canonicalJsonHash({
      policy: 'functional-examination-v1',
      service,
      sourceHash: source.sourceHash,
      revision: row.synthetic_case_revision,
      demographics: profile.demographics,
      hidden: semanticEvidence(hidden),
      history: semanticEvidence(history),
      evidence: semanticEvidence(formal),
    })
    const existing = snapshots.getByEvidence(workspaceId, row.synthetic_case_id, service.id, inputHash)
    if (existing !== undefined) return { snapshotId: existing.snapshotId, content: existing.content }
    const requested = definitions[service.examCode]
    const hasEcgSpecificTruth = hidden.some(
      (item) =>
        item.resourceType === 'Observation' &&
        item.code?.coding?.some(
          (coding) =>
            (coding.system === 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/examination-service' &&
              requested.some((definition) => definition.code === coding.code)) ||
            (coding.system === 'http://loinc.org' &&
              requested.some(
                (definition) => definition.code !== 'ventricular-rate' && definition.sourceCodes?.includes(coding.code),
              )),
        ),
    )
    const exact = requested.map((definition) => {
      // A routine heart-rate vital alone does not declare a partial ECG panel.
      if (service.examCode === 'ecg-12-lead' && definition.code === 'ventricular-rate' && !hasEcgSpecificTruth)
        return undefined
      const matches = hidden.filter(
        (item) =>
          item.resourceType === 'Observation' &&
          item.code?.coding?.some(
            (coding) =>
              (coding.system === 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/examination-service' &&
                coding.code === definition.code) ||
              (coding.system === 'http://loinc.org' && definition.sourceCodes?.includes(coding.code)),
          ),
      )
      const values = matches.map((item) => {
        if (typeof definition.value !== 'number') return { value: item.valueString }
        const quantity = z
          .object({ value: z.number().finite(), code: z.string().optional(), unit: z.string().optional() })
          .loose()
          .safeParse(item.valueQuantity)
        return quantity.success
          ? { value: quantity.data.value, unit: quantity.data.code ?? quantity.data.unit }
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
    if (!hasExact) {
      if (profile.source.providerId !== 'synthea')
        throw new InvestigationGenerationError(
          'INVESTIGATION_UNSUPPORTED',
          '仅普通 Synthea 病例可使用成人正常基线，当前来源必须提供完整精确真值',
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
        ? '功能检查结果见结构化指标，请结合临床判断。'
        : service.examCode === 'ecg-12-lead'
          ? '窦性心律，未见明显 ST-T 异常（确定性合成成人基线）。'
          : '心脏结构及左室收缩、舒张功能未见明显异常（确定性合成成人基线）。',
      results: requested.map((definition, index) => {
        const observation = exact[index]
        const quantity = z
          .object({ value: z.number().finite(), code: z.string().optional(), unit: z.string().optional() })
          .loose()
          .safeParse(observation?.valueQuantity)
        const value =
          observation === undefined
            ? definition.value
            : typeof definition.value === 'number'
              ? quantity.success
                ? quantity.data.value
                : undefined
              : z.string().min(1).max(1000).safeParse(observation.valueString).data
        if (value === undefined || (typeof value === 'number' && (value < 0 || value > 1000)))
          throw new InvestigationGenerationError('INVESTIGATION_TRUTH_INCOMPATIBLE', '功能检查精确真值数值或单位无效')
        if (
          observation !== undefined &&
          definition.unit !== undefined &&
          (!quantity.success || (quantity.data.code ?? quantity.data.unit) !== definition.unit)
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
