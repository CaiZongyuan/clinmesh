import {
  laboratorySpecimenContainerSchema,
  type LaboratorySpecimenContainer,
} from '@clinmesh/contracts/his'

const edtaPurple: LaboratorySpecimenContainer = laboratorySpecimenContainerSchema.parse({
  capColor: 'purple',
  code: 'edta-k2-purple',
  collectionRequirementEn: 'Draw venous blood and invert gently 8 times immediately; do not shake',
  collectionRequirementZh: '静脉采血 · 立即颠倒混匀 8 次，勿剧烈摇晃',
  containerNameEn: 'EDTA-K2 purple-top tube',
  containerNameZh: 'EDTA-K2 紫头管',
  mergeable: true,
  specimenCategoryEn: 'Whole blood',
  specimenCategoryZh: '全血',
})

const sstYellow: LaboratorySpecimenContainer = laboratorySpecimenContainerSchema.parse({
  capColor: 'yellow',
  code: 'sst-yellow',
  collectionRequirementEn: 'Draw venous blood, invert 5 times, and allow to clot before centrifugation',
  collectionRequirementZh: '静脉采血 · 颠倒混匀 5 次后静置促凝分离血清',
  containerNameEn: 'SST yellow-top tube',
  containerNameZh: '促凝黄头管',
  mergeable: true,
  specimenCategoryEn: 'Serum',
  specimenCategoryZh: '血清',
})

const citrateBlue: LaboratorySpecimenContainer = laboratorySpecimenContainerSchema.parse({
  capColor: 'blue',
  code: 'citrate-blue',
  collectionRequirementEn: 'Fill strictly to volume mark (1:9) and invert 5–8 times immediately',
  collectionRequirementZh: '严格采足刻度 · 立即颠倒混匀 5–8 次',
  containerNameEn: 'Sodium citrate blue-top tube (1:9)',
  containerNameZh: '枸橼酸钠蓝头管 (1:9)',
  mergeable: true,
  specimenCategoryEn: 'Citrated plasma',
  specimenCategoryZh: '抗凝血浆',
})

const esrBlack: LaboratorySpecimenContainer = laboratorySpecimenContainerSchema.parse({
  capColor: 'black',
  code: 'esr-black',
  collectionRequirementEn: 'Fill to ESR mark (1:4) and invert gently 5–8 times; do not merge with EDTA or 1:9 citrate tubes',
  collectionRequirementZh: '静脉采血至血沉刻度 · 颠倒混匀 5–8 次，独立成管',
  containerNameEn: 'Sodium citrate black-top tube (1:4)',
  containerNameZh: '枸橼酸钠黑头管 (1:4)',
  mergeable: true,
  specimenCategoryEn: 'Whole blood',
  specimenCategoryZh: '全血',
})

const sterileUrine: LaboratorySpecimenContainer = laboratorySpecimenContainerSchema.parse({
  capColor: 'amber',
  code: 'sterile-urine',
  collectionRequirementEn: 'Collect clean midstream urine and dispatch promptly',
  collectionRequirementZh: '留取清洁中段尿及时送检',
  containerNameEn: 'Clean urine tube',
  containerNameZh: '一次性清洁尿管',
  mergeable: true,
  specimenCategoryEn: 'Urine',
  specimenCategoryZh: '尿液',
})

const mixedSpecimen: LaboratorySpecimenContainer = laboratorySpecimenContainerSchema.parse({
  capColor: 'neutral',
  code: 'mixed-specimen',
  collectionRequirementEn: 'Collect separate tubes per panel member requirements',
  collectionRequirementZh: '按组合明细要求分别采集对应标本管',
  containerNameEn: 'Multi-tube collection',
  containerNameZh: '多管分装采集',
  mergeable: false,
  specimenCategoryEn: 'Mixed specimens',
  specimenCategoryZh: '混合标本',
})

function customSpecimenContainer(display: string): LaboratorySpecimenContainer {
  const normalized = display.trim().slice(0, 120)
  return laboratorySpecimenContainerSchema.parse({
    capColor: 'neutral',
    code: 'custom-specimen',
    collectionRequirementEn: 'Verify and collect independently per original request',
    collectionRequirementZh: '按检验申请单标本要求独立核对采集',
    containerNameEn: 'Standard specimen container',
    containerNameZh: '标准标本容器',
    mergeable: false,
    specimenCategoryEn: normalized.length > 0 ? normalized : 'Verify per request',
    specimenCategoryZh: normalized.length > 0 ? normalized : '按申请核对标本',
  })
}

export interface SpecimenResolutionInput {
  referenceCode?: string | null | undefined
  specimen?: { code?: string | undefined; display?: string | null | undefined } | string | null | undefined
  specimenContainer?: LaboratorySpecimenContainer | null | undefined
}

const routineUrineCodes = new Set(['urine', 'lp7681-2'])
const routineUrineDisplays = new Set(['尿液', '清洁中段尿', '随机尿', '晨尿'])
const routineUrineEnDisplays = new Set(['urine', 'clean midstream urine', 'random urine'])
const serumCodes = new Set(['serum', 'ser', 'lp7633-3'])
const serumDisplays = new Set(['血清', '合成血清', '血清、血浆', '血清/血浆', '全血、血清、血浆'])
const serumEnDisplays = new Set(['serum', 'serum or plasma', 'serum/plasma'])
const coagulationLoincCodes = new Set(['6301-6', '5902-2', '3173-2', '3255-7', '48065-7'])
const edtaLoincCodes = new Set(['6690-2', '718-7', '777-3', '789-8', '4544-3', '787-2', '785-6', '786-4', '4548-4'])

export function resolveLaboratorySpecimenContainer(input: SpecimenResolutionInput): LaboratorySpecimenContainer {
  if (input.specimenContainer !== undefined && input.specimenContainer !== null) {
    return input.specimenContainer
  }
  const ref = input.referenceCode?.trim() ?? ''
  const rawCode = typeof input.specimen === 'object' && input.specimen !== null ? (input.specimen.code?.trim().toLowerCase() ?? '') : ''
  const rawDisplay = typeof input.specimen === 'string'
    ? input.specimen.trim()
    : typeof input.specimen === 'object' && input.specimen !== null
      ? (input.specimen.display?.trim() ?? '')
      : ''
  const lowerDisplay = rawDisplay.toLowerCase()

  if (rawCode === 'esr-blood' || (ref === '0300101A' && (rawDisplay === '' || rawDisplay === '全血' || lowerDisplay === 'whole blood'))) {
    return esrBlack
  }
  if (rawDisplay === '混合标本' || lowerDisplay === 'mixed specimens' || rawCode === 'mixed' || rawCode === 'mixed-specimen') {
    return mixedSpecimen
  }
  const isRoutineUrineDisplay = routineUrineDisplays.has(rawDisplay) || routineUrineEnDisplays.has(lowerDisplay)
  if (isRoutineUrineDisplay || (routineUrineCodes.has(rawCode) && rawDisplay === '')) {
    return sterileUrine
  }
  const explicitCitrateSpecimen = (
    rawCode === 'citrated-plasma'
    || rawCode === 'ppp'
    || rawDisplay.includes('枸橼酸')
    || rawDisplay.includes('柠檬酸')
    || lowerDisplay.includes('citrate')
    || rawDisplay.includes('贫血小板血浆')
  ) && !rawDisplay.includes('1:4') && !rawDisplay.includes('血沉')
  const isKnownCoagulationReference = ref === 'CN-LAB-COAGULATION'
    || /^05\d{5}[A-Z]$/.test(ref)
    || coagulationLoincCodes.has(ref)
  const genericPlasmaOrUnset = rawDisplay === '' || rawDisplay === '血浆' || lowerDisplay === 'plasma'
  if (explicitCitrateSpecimen || (isKnownCoagulationReference && genericPlasmaOrUnset)) {
    return citrateBlue
  }
  if (serumDisplays.has(rawDisplay) || serumEnDisplays.has(lowerDisplay) || (serumCodes.has(rawCode) && rawDisplay === '')) {
    return sstYellow
  }
  const explicitEdtaWholeBlood = (
    rawCode === 'edta-blood'
    || rawCode === 'edta-k2'
    || rawCode === 'bld-edta'
    || lowerDisplay.includes('edta')
    || rawDisplay.includes('紫头')
  ) && !rawDisplay.includes('血浆') && !lowerDisplay.includes('plasma') && !rawDisplay.includes('血清') && !lowerDisplay.includes('serum')
  const isKnownEdtaReference = ref === 'CN-LAB-CBC'
    || ref === 'CN-LAB-CBC-5DIFF'
    || ref === 'CN-LAB-HBA1C'
    || /^01\d{5}[A-Z]$/.test(ref)
    || ref === '1100301A'
    || edtaLoincCodes.has(ref)
  const genericWholeBloodOrUnset = rawDisplay === '' || rawDisplay === '全血' || rawDisplay === '合成全血' || lowerDisplay === 'whole blood'
  if (explicitEdtaWholeBlood || (isKnownEdtaReference && genericWholeBloodOrUnset)) {
    return edtaPurple
  }
  return customSpecimenContainer(rawDisplay)
}

export function isBloodDrawSpecimenContainer(container: LaboratorySpecimenContainer): boolean {
  return container.code === 'edta-k2-purple'
    || container.code === 'sst-yellow'
    || container.code === 'citrate-blue'
    || container.code === 'esr-black'
}

export const maxMergedRequestsPerTube = 20

export function specimenContainerMergeKey(container: LaboratorySpecimenContainer): string | null {
  if (!container.mergeable) return null
  return `tube:${container.code}:${container.specimenCategoryZh}:${container.collectionRequirementZh}`
}

export type DispatchableInvestigationItem = {
  id: string
  kind: 'laboratory' | 'examination' | 'imaging'
  referenceCode?: string | null | undefined
  specimen?: { code?: string | undefined; display?: string | null | undefined } | string | null | undefined
  specimenContainer?: LaboratorySpecimenContainer | null | undefined
}

export type MergedInvestigationDispatchUnit<T extends DispatchableInvestigationItem> =
  | {
      container: LaboratorySpecimenContainer
      groupKey: string
      items: T[]
      unitKind: 'tube'
    }
  | {
      groupKey: string
      item: T
      kind: 'examination' | 'imaging'
      unitKind: 'non-specimen'
    }

export type InvestigationDispatchUnit<T extends DispatchableInvestigationItem> =
  | MergedInvestigationDispatchUnit<T>
  | {
      groupKey: string
      item: T
      unitKind: 'unmerged'
    }

export function groupInvestigationDispatchUnits<T extends DispatchableInvestigationItem>(
  entries: readonly T[],
): MergedInvestigationDispatchUnit<T>[]
export function groupInvestigationDispatchUnits<T extends DispatchableInvestigationItem>(
  entries: readonly T[],
  options: { unmerged: (item: T) => boolean },
): InvestigationDispatchUnit<T>[]
export function groupInvestigationDispatchUnits<T extends DispatchableInvestigationItem>(
  entries: readonly T[],
  options?: { unmerged?: ((item: T) => boolean) | undefined },
): InvestigationDispatchUnit<T>[] {
  const units: InvestigationDispatchUnit<T>[] = []
  const byMergeKey = new Map<string, Extract<InvestigationDispatchUnit<T>, { unitKind: 'tube' }>>()
  const tubeChunkCounts = new Map<string, number>()

  for (const entry of entries) {
    if (options?.unmerged?.(entry) === true) {
      units.push({
        groupKey: `unmerged:${entry.id}`,
        item: entry,
        unitKind: 'unmerged',
      })
      continue
    }
    if (entry.kind !== 'laboratory') {
      units.push({
        groupKey: `non-specimen:${entry.kind}:${entry.id}`,
        item: entry,
        kind: entry.kind,
        unitKind: 'non-specimen',
      })
      continue
    }
    const container = resolveLaboratorySpecimenContainer(entry)
    const mergeKey = specimenContainerMergeKey(container)
    if (mergeKey !== null) {
      const existing = byMergeKey.get(mergeKey)
      if (existing !== undefined && existing.items.length < maxMergedRequestsPerTube) {
        existing.items.push(entry)
        continue
      }
      const chunkIndex = (tubeChunkCounts.get(mergeKey) ?? 0) + 1
      tubeChunkCounts.set(mergeKey, chunkIndex)
      const created: Extract<InvestigationDispatchUnit<T>, { unitKind: 'tube' }> = {
        container,
        groupKey: chunkIndex === 1 ? mergeKey : `${mergeKey}#${chunkIndex}`,
        items: [entry],
        unitKind: 'tube',
      }
      byMergeKey.set(mergeKey, created)
      units.push(created)
      continue
    }
    units.push({
      container,
      groupKey: `single-tube:${entry.id}`,
      items: [entry],
      unitKind: 'tube',
    })
  }
  return units
}
