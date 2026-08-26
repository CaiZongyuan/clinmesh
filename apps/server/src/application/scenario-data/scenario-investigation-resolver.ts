import { createHash } from 'node:crypto'
import type {
  ScenarioDatasetContent,
  ScenarioInvestigationResult,
} from '@clinmesh/contracts/scenario'

export interface ScenarioInvestigationResolution {
  components?: ScenarioInvestigationResolution[]
  critical: boolean
  diagnostics: string[]
  feeFen: number
  itemId: string
  name: string
  report: string
  result: ScenarioInvestigationResult
  sourceLevel: 'L1' | 'L2' | 'L3'
  tatMinutes: number
}

type InvestigationCatalogItem = ScenarioDatasetContent['catalog']['investigations'][number]
type ScenarioPatient = ScenarioDatasetContent['patients'][number]
type ReportedInvestigationResult = Extract<ScenarioInvestigationResult, { outcome: 'reported' }>

function rounded(value: number): number {
  return Number(value.toFixed(2))
}

interface ReplayKey {
  catalogItemId: string
  patientId: string
  repeatIndex: number
  scenarioRunId: string
}

function deterministicZScore(key: ReplayKey, source: string): number {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      key.scenarioRunId,
      key.patientId,
      key.catalogItemId,
      key.repeatIndex,
      source,
    ]))
    .digest()
  const denominator = 0x1_0000_0000 + 1
  const first = (digest.readUInt32BE(0) + 1) / denominator
  const second = (digest.readUInt32BE(4) + 1) / denominator
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second)
}

function assayValue(value: number, assayCv: number | undefined, key: ReplayKey, source: string): number {
  if (key.repeatIndex === 0 || assayCv === undefined || assayCv === 0) return value
  const zScore = Math.max(-3, Math.min(3, deterministicZScore(key, source)))
  return value + zScore * Math.abs(value) * assayCv
}

function reportedResult(input: {
  catalogItem: InvestigationCatalogItem
  gender: ScenarioPatient['gender']
  value: boolean | number | string
}): ReportedInvestigationResult {
  const referenceRange = input.catalogItem.referenceRanges.find(
    range => range.appliesToGender === input.gender,
  ) ?? input.catalogItem.referenceRanges.find(range => range.appliesToGender === 'any')
  const flag = typeof input.value === 'number'
    ? referenceRange?.maximum !== undefined && input.value > referenceRange.maximum
      ? 'H'
      : referenceRange?.minimum !== undefined && input.value < referenceRange.minimum ? 'L' : 'N'
    : typeof input.value === 'string' && input.value !== '阴性' ? 'H' : 'N'
  return {
    flag,
    outcome: 'reported',
    ...(referenceRange === undefined ? {} : { referenceRange: referenceRange.text }),
    ...(input.catalogItem.unit === undefined ? {} : { unit: input.catalogItem.unit }),
    value: typeof input.value === 'number' ? rounded(input.value) : input.value,
  }
}

function reportedResolution(input: {
  catalogItem: InvestigationCatalogItem
  critical: boolean
  diagnostics: string[]
  gender: ScenarioPatient['gender']
  sourceLevel: 'L2' | 'L3'
  value: boolean | number | string
}): ScenarioInvestigationResolution {
  const result = reportedResult(input)
  return {
    critical: input.critical,
    diagnostics: input.diagnostics,
    feeFen: input.catalogItem.priceFen,
    itemId: input.catalogItem.id,
    name: input.catalogItem.name,
    report: input.catalogItem.reportTemplate.replace('{value}', String(result.value)),
    result,
    sourceLevel: input.sourceLevel,
    tatMinutes: input.catalogItem.tatMinutes,
  }
}

function generatorValue(
  generator: ScenarioPatient['physiologyBaseline']['generators'][number],
  patient: ScenarioPatient,
  referenceDate: string,
  replayKey: ReplayKey,
  resolving = new Set<string>(),
): boolean | number | string | undefined {
  if (generator.kind === 'constant') {
    return assayValue(generator.value, generator.assayCv, replayKey, generator.id)
  }
  if (generator.kind === 'normal') {
    return assayValue(generator.mean, generator.assayCv, replayKey, generator.id)
  }
  if (generator.kind === 'trajectory') {
    return assayValue(generator.target, generator.assayCv, replayKey, generator.id)
  }
  if (generator.kind === 'text') return generator.value
  if (generator.kind !== 'derived') return undefined
  if (resolving.has(generator.id)) throw new Error(`Physiology generator cycle at ${generator.id}`)
  const nextResolving = new Set(resolving).add(generator.id)
  const dependencies = generator.dependencies.map((dependency) => {
    if (dependency.startsWith('vital:')) {
      const key = dependency.slice('vital:'.length)
      const value = (patient.physiologyBaseline.vitalSigns as Record<string, number | undefined>)[key]
      if (value === undefined) throw new Error(`Physiology dependency ${dependency} was not found`)
      return value
    }
    const source = patient.physiologyBaseline.generators.find(candidate => candidate.id === dependency)
    if (source === undefined) throw new Error(`Physiology dependency ${dependency} was not found`)
    const value = generatorValue(source, patient, referenceDate, replayKey, nextResolving)
    if (typeof value !== 'number') throw new Error(`Physiology dependency ${dependency} is not numeric`)
    return value
  })
  if (generator.formula === 'bmi') {
    const [weightKg, heightCm] = dependencies
    if (weightKg === undefined || heightCm === undefined || heightCm <= 0) {
      throw new Error('BMI requires positive weight and height')
    }
    return weightKg / ((heightCm / 100) ** 2)
  }
  if (generator.formula === 'egfr-ckd-epi-2021') {
    const [creatinineUmolL] = dependencies
    if (creatinineUmolL === undefined || creatinineUmolL <= 0) {
      throw new Error('eGFR requires positive serum creatinine')
    }
    const birth = new Date(`${patient.birthDate}T00:00:00Z`)
    const reference = new Date(`${referenceDate}T00:00:00Z`)
    let age = reference.getUTCFullYear() - birth.getUTCFullYear()
    if (
      reference.getUTCMonth() < birth.getUTCMonth()
      || (reference.getUTCMonth() === birth.getUTCMonth()
        && reference.getUTCDate() < birth.getUTCDate())
    ) age -= 1
    const creatinineMgDl = creatinineUmolL / 88.4
    const female = patient.gender === 'female'
    const kappa = female ? 0.7 : 0.9
    const alpha = female ? -0.241 : -0.302
    const ratio = creatinineMgDl / kappa
    return 142
      * Math.min(ratio, 1) ** alpha
      * Math.max(ratio, 1) ** -1.2
      * 0.9938 ** age
      * (female ? 1.012 : 1)
  }
  if (generator.formula === 'friedewald-ldl') {
    const [totalCholesterol, hdlCholesterol, triglycerides] = dependencies
    const dependencyUnits = generator.dependencies.map((dependency) => {
      if (dependency.startsWith('vital:')) return undefined
      const source = patient.physiologyBaseline.generators.find(candidate => candidate.id === dependency)
      return source !== undefined && 'unit' in source ? source.unit : undefined
    })
    if (
      totalCholesterol === undefined
      || hdlCholesterol === undefined
      || triglycerides === undefined
      || generator.dependencies.length !== 3
      || generator.unit !== 'mmol/L'
      || dependencyUnits.some(unit => unit !== 'mmol/L')
      || triglycerides < 0
      || triglycerides >= 4.5
    ) {
      throw new Error('Friedewald LDL requires total cholesterol, HDL and triglycerides below 4.5 mmol/L')
    }
    return totalCholesterol - hdlCholesterol - triglycerides / 2.2
  }
  if (generator.formula === 'hematocrit-from-rbc-mcv') {
    const [redBloodCells, meanCorpuscularVolume] = dependencies
    if (redBloodCells === undefined || meanCorpuscularVolume === undefined) {
      throw new Error('Hematocrit requires RBC and MCV')
    }
    return redBloodCells * meanCorpuscularVolume / 1_000
  }
  if (generator.formula === 'urine-glucose-from-blood-glucose') {
    const [bloodGlucose] = dependencies
    if (bloodGlucose === undefined) throw new Error('Urine glucose requires blood glucose')
    if (bloodGlucose < 10) return '阴性'
    if (bloodGlucose < 13.9) return '阳性（+）'
    if (bloodGlucose < 16.7) return '阳性（++）'
    return '阳性（+++）'
  }
  return undefined
}

interface ResolveScenarioInvestigationInput {
  catalogItemId: string
  content: ScenarioDatasetContent
  indicationCode: string
  patientId: string
  repeatIndex: number
  scenarioRunId: string
}

function resolveScenarioInvestigationInternal(
  input: ResolveScenarioInvestigationInput,
  resolvingPanels: ReadonlySet<string>,
): ScenarioInvestigationResolution {
  const patient = input.content.patients.find(candidate => candidate.id === input.patientId)
  if (patient === undefined) throw new Error(`Scenario patient ${input.patientId} was not found`)
  const catalogItem = input.content.catalog.investigations.find(
    candidate => candidate.id === input.catalogItemId,
  )
  if (catalogItem === undefined) throw new Error(`Investigation ${input.catalogItemId} was not found`)
  const replayKey: ReplayKey = {
    catalogItemId: input.catalogItemId,
    patientId: input.patientId,
    repeatIndex: input.repeatIndex,
    scenarioRunId: input.scenarioRunId,
  }
  if (!catalogItem.available) {
    return {
      critical: false,
      diagnostics: [],
      feeFen: 0,
      itemId: catalogItem.id,
      name: catalogItem.name,
      report: catalogItem.reportTemplate,
      result: { message: catalogItem.reportTemplate, outcome: 'catalog-boundary' },
      sourceLevel: 'L3',
      tatMinutes: 0,
    }
  }
  if (!catalogItem.allowedIndicationCodes.includes(input.indicationCode)) {
    const message = `检查项目“${catalogItem.name}”不适用于当前指征。`
    return {
      critical: false,
      diagnostics: [],
      feeFen: 0,
      itemId: catalogItem.id,
      name: catalogItem.name,
      report: message,
      result: { message, outcome: 'not-indicated' },
      sourceLevel: 'L3',
      tatMinutes: 0,
    }
  }
  const exact = patient.investigations.find(
    investigation => investigation.catalogItemId === input.catalogItemId,
  )
  if (exact === undefined && catalogItem.physiologyGeneratorId !== undefined) {
    const generator = patient.physiologyBaseline.generators.find(
      candidate => candidate.id === catalogItem.physiologyGeneratorId,
    )
    const value = generator === undefined
      ? undefined
      : generatorValue(generator, patient, input.content.reproduction.timeRange.end, replayKey)
    if (value !== undefined) {
      return reportedResolution({
        catalogItem,
        critical: typeof value === 'number' && (
          (catalogItem.criticalMinimum !== undefined && value < catalogItem.criticalMinimum)
          || (catalogItem.criticalMaximum !== undefined && value > catalogItem.criticalMaximum)
        ),
        diagnostics: [],
        gender: patient.gender,
        sourceLevel: 'L2',
        value,
      })
    }
  }
  if (exact === undefined && catalogItem.normalDistribution !== undefined) {
    const distribution = catalogItem.normalDistribution
    const baselineKey = { ...replayKey, repeatIndex: 0 }
    const sampled = distribution.mean
      + deterministicZScore(baselineKey, 'l3-baseline') * distribution.standardDeviation
    const baseline = Math.min(distribution.maximum, Math.max(distribution.minimum, sampled))
    const value = Math.min(
      distribution.maximum,
      Math.max(
        distribution.minimum,
        assayValue(baseline, distribution.assayCv, replayKey, 'l3-assay'),
      ),
    )
    return reportedResolution({
      catalogItem,
      critical: false,
      diagnostics: ['unmodeled_item'],
      gender: patient.gender,
      sourceLevel: 'L3',
      value,
    })
  }
  if (exact === undefined && catalogItem.componentItemIds !== undefined) {
    if (resolvingPanels.has(catalogItem.id)) {
      throw new Error(`Investigation panel cycle at ${catalogItem.id}`)
    }
    const nextResolvingPanels = new Set(resolvingPanels).add(catalogItem.id)
    const components = catalogItem.componentItemIds.map(componentItemId => (
      resolveScenarioInvestigationInternal(
        { ...input, catalogItemId: componentItemId },
        nextResolvingPanels,
      )
    ))
    if (components.some(component => component.result.outcome !== 'reported')) {
      throw new Error(`Investigation panel ${catalogItem.id} has an unavailable component`)
    }
    const report = components.map(component => component.report).join(' ')
    const sourceLevel = components.some(component => component.sourceLevel === 'L3')
      ? 'L3'
      : components.some(component => component.sourceLevel === 'L2') ? 'L2' : 'L1'
    return {
      components,
      critical: components.some(component => component.critical),
      diagnostics: [...new Set(components.flatMap(component => component.diagnostics))],
      feeFen: catalogItem.priceFen,
      itemId: catalogItem.id,
      name: catalogItem.name,
      report: catalogItem.reportTemplate.replace('{value}', report),
      result: { outcome: 'reported', value: report },
      sourceLevel,
      tatMinutes: catalogItem.tatMinutes,
    }
  }
  if (exact === undefined) throw new Error(`Investigation ${input.catalogItemId} cannot be resolved`)
  return {
    critical: exact.critical,
    diagnostics: [],
    feeFen: exact.feeFen,
    itemId: exact.catalogItemId,
    name: exact.name,
    report: exact.report,
    result: exact.result,
    sourceLevel: 'L1',
    tatMinutes: exact.tatMinutes,
  }
}

export function resolveScenarioInvestigation(
  input: ResolveScenarioInvestigationInput,
): ScenarioInvestigationResolution {
  return resolveScenarioInvestigationInternal(input, new Set())
}
