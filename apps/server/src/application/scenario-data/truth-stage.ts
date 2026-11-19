export const TRUTH_STAGE_EXTENSION_URL = 'urn:clinmesh:synthetic:truth-stage'
export const EXAMINATION_EXAM_CODE_EXTENSION_URL = 'urn:clinmesh:examination:exam-code'
export const EXAMINATION_SERVICE_SYSTEM = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/examination-service'
export const EXAMINATION_ECG_SYSTEM = 'urn:clinmesh:examination:ecg'
export const EXAMINATION_TTE_SYSTEM = 'urn:clinmesh:examination:tte'
export const EXAMINATION_CONCLUSION_SYSTEM = 'urn:clinmesh:examination:conclusion'

export const CASE_TRUTH_STAGES = ['initial', 'inpatient', 'repeat', 'follow-up'] as const
export type CaseTruthStage = (typeof CASE_TRUTH_STAGES)[number]

const validStages = new Set<string>(CASE_TRUTH_STAGES)

export function readExtensionCode(resource: unknown, url: string): string | undefined {
  if (typeof resource !== 'object' || resource === null) return undefined
  const extensions = (resource as Record<string, unknown>).extension
  if (!Array.isArray(extensions)) return undefined
  for (const item of extensions) {
    if (typeof item !== 'object' || item === null) continue
    const candidate = item as Record<string, unknown>
    if (candidate.url === url && typeof candidate.valueCode === 'string' && candidate.valueCode.length > 0) {
      return candidate.valueCode
    }
  }
  return undefined
}

export function readTruthStage(resource: unknown): CaseTruthStage | undefined {
  const code = readExtensionCode(resource, TRUTH_STAGE_EXTENSION_URL)
  return code !== undefined && validStages.has(code) ? (code as CaseTruthStage) : undefined
}

export function buildTruthStagePriority(context: {
  isInpatient: boolean
  isRevisit: boolean
  isRepeat: boolean
}): readonly (CaseTruthStage | undefined)[] {
  if (context.isRevisit) {
    return ['follow-up', undefined]
  }
  if (context.isInpatient) {
    return context.isRepeat ? ['repeat', 'inpatient', 'initial', undefined] : ['inpatient', 'initial', undefined]
  }
  return context.isRepeat ? ['repeat', 'initial', undefined] : ['initial', undefined]
}

export function selectStageBucket<T>(
  items: readonly T[],
  readStage: (item: T) => CaseTruthStage | undefined,
  stagePriority: readonly (CaseTruthStage | undefined)[],
): { items: T[]; stage: CaseTruthStage | undefined } | undefined {
  for (const stage of stagePriority) {
    const matched = items.filter(item => readStage(item) === stage)
    if (matched.length > 0) return { items: matched, stage }
  }
  return undefined
}
