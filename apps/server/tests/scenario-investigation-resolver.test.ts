import { scenarioGenerationRequestSchema } from '@clinmesh/contracts/scenario'
import { describe, expect, it } from 'vitest'
import { resolveScenarioInvestigation } from '../src/application/scenario-data/scenario-investigation-resolver.ts'
import { BuiltInScenarioGenerationProvider } from '../src/infrastructure/scenario-generation/builtin-provider.ts'

const ucum = (code: string, display = code) => ({
  code,
  display,
  system: 'http://unitsofmeasure.org' as const,
  version: '2.2' as const,
})

async function generatedContent(module: 'fever' | 'type-2-diabetes') {
  const provider = new BuiltInScenarioGenerationProvider()
  const generated = await provider.generate(scenarioGenerationRequestSchema.parse({
    modules: [module],
    name: '检查解析测试病例',
    population: { age: { maximum: 40, minimum: 40 }, count: 1, gender: 'female' },
    providerId: 'builtin',
    seeds: { clinical: 7331, population: 4242 },
    timeRange: { end: '2026-08-01', start: '2020-01-01' },
    timeZone: 'Asia/Shanghai',
  }))
  return generated.content
}

describe('Scenario investigation resolver', () => {
  it('returns the exact L1 CaseTruth result with its report, TAT and fee', async () => {
    const content = await generatedContent('fever')
    const patient = content.patients[0]!

    expect(resolveScenarioInvestigation({
      catalogItemId: 'lab-body-temperature',
      content,
      indicationCode: 'clinical-assessment',
      patientId: patient.id,
      repeatIndex: 0,
      scenarioRunId: 'scenario-run-l1',
    })).toEqual({
      critical: false,
      diagnostics: [],
      feeFen: 0,
      itemId: 'lab-body-temperature',
      name: '体温',
      report: '体温 38.6 °C',
      result: {
        flag: 'H',
        outcome: 'reported',
        referenceRange: '36.0-37.3 °C',
        unit: ucum('Cel', '°C'),
        value: 38.6,
      },
      sourceLevel: 'L1',
      tatMinutes: 0,
    })
  })

  it('resolves an L2 trajectory generator through an explicit catalog binding', async () => {
    const content = await generatedContent('type-2-diabetes')
    const patient = content.patients[0]!
    patient.investigations = patient.investigations.filter(
      investigation => investigation.catalogItemId !== 'lab-random-glucose',
    )
    const catalogItem = content.catalog.investigations.find(item => item.id === 'lab-random-glucose')!
    Object.assign(catalogItem, { physiologyGeneratorId: 'random-glucose' })

    expect(resolveScenarioInvestigation({
      catalogItemId: 'lab-random-glucose',
      content,
      indicationCode: 'type-2-diabetes',
      patientId: patient.id,
      repeatIndex: 0,
      scenarioRunId: 'scenario-run-l2-trajectory',
    })).toMatchObject({
      critical: false,
      diagnostics: [],
      feeFen: 500,
      itemId: 'lab-random-glucose',
      name: '随机血糖',
      report: '随机血糖 13.8 mmol/L。',
      result: {
        flag: 'H',
        outcome: 'reported',
        referenceRange: '3.9-11.1 mmol/L',
        unit: ucum('mmol/L'),
        value: 13.8,
      },
      sourceLevel: 'L2',
      tatMinutes: 30,
    })
  })

  it('resolves an L2 constant generator without changing its CaseTruth value', async () => {
    const content = await generatedContent('fever')
    const patient = content.patients[0]!
    patient.investigations = []

    expect(resolveScenarioInvestigation({
      catalogItemId: 'lab-body-temperature',
      content,
      indicationCode: 'clinical-assessment',
      patientId: patient.id,
      repeatIndex: 0,
      scenarioRunId: 'scenario-run-l2-constant',
    })).toMatchObject({
      critical: false,
      report: '体温 38.6 °C。',
      result: { flag: 'H', outcome: 'reported', unit: ucum('Cel', '°C'), value: 38.6 },
      sourceLevel: 'L2',
    })
  })

  it('resolves the mean of an L2 normal physiology generator on its first assay', async () => {
    const content = await generatedContent('type-2-diabetes')
    const patient = content.patients[0]!

    expect(resolveScenarioInvestigation({
      catalogItemId: 'lab-hemoglobin',
      content,
      indicationCode: 'type-2-diabetes',
      patientId: patient.id,
      repeatIndex: 0,
      scenarioRunId: 'scenario-run-l2-normal',
    })).toMatchObject({
      critical: false,
      report: '血红蛋白 148 g/L。',
      result: { flag: 'N', outcome: 'reported', unit: ucum('g/L'), value: 148 },
      sourceLevel: 'L2',
    })
  })

  it('derives BMI from the patient height and weight without an independent random draw', async () => {
    const content = await generatedContent('type-2-diabetes')
    const patient = content.patients[0]!
    content.catalog.investigations.push({
      active: true,
      allowedIndicationCodes: ['type-2-diabetes'],
      available: true,
      category: 'examination',
      code: 'BMI',
      contraindicatedAllergyCodes: [],
      id: 'exam-bmi-worked-example',
      name: '体重指数',
      organizationId: content.hospital.id,
      physiologyGeneratorId: 'body-mass-index-worked-example',
      priceFen: 0,
      referenceRanges: [{ appliesToGender: 'any', maximum: 23.9, minimum: 18.5, text: '18.5-23.9 kg/m²' }],
      reportTemplate: '体重指数 {value} kg/m²。',
      status: 'active',
      tatMinutes: 0,
      unit: ucum('kg/m2', 'kg/m²'),
      valueType: 'quantity',
    })
    patient.physiologyBaseline.generators.push({
      dependencies: ['vital:weightKg', 'vital:heightCm'],
      formula: 'bmi',
      id: 'body-mass-index-worked-example',
      kind: 'derived',
      source: 'scenario:height-weight',
      unit: ucum('kg/m2', 'kg/m²'),
    })

    expect(resolveScenarioInvestigation({
      catalogItemId: 'exam-bmi-worked-example',
      content,
      indicationCode: 'type-2-diabetes',
      patientId: patient.id,
      repeatIndex: 0,
      scenarioRunId: 'scenario-run-l2-bmi',
    })).toMatchObject({
      critical: false,
      report: '体重指数 27.11 kg/m²。',
      result: { flag: 'H', outcome: 'reported', unit: ucum('kg/m2', 'kg/m²'), value: 27.11 },
      sourceLevel: 'L2',
    })
  })

  it('derives eGFR from creatinine, age and gender using CKD-EPI 2021', async () => {
    const content = await generatedContent('type-2-diabetes')
    const patient = content.patients[0]!
    content.catalog.investigations.push({
      active: true,
      allowedIndicationCodes: ['type-2-diabetes'],
      available: true,
      category: 'laboratory',
      code: 'EGFR',
      contraindicatedAllergyCodes: [],
      id: 'lab-egfr-worked-example',
      name: '估算肾小球滤过率',
      organizationId: content.hospital.id,
      physiologyGeneratorId: 'estimated-gfr-worked-example',
      priceFen: 0,
      referenceRanges: [{ appliesToGender: 'any', minimum: 60, text: '>=60 mL/min/1.73m²' }],
      reportTemplate: '估算肾小球滤过率 {value} mL/min/1.73m²。',
      status: 'active',
      tatMinutes: 60,
      unit: ucum('mL/min/{1.73_m2}', 'mL/min/1.73m²'),
      valueType: 'quantity',
    })
    patient.physiologyBaseline.generators.push({
      assayCv: 0.02,
      id: 'serum-creatinine-worked-example',
      kind: 'normal',
      maximum: 88.4,
      mean: 88.4,
      minimum: 88.4,
      source: 'scenario:renal-baseline',
      standardDeviation: 1,
      unit: ucum('umol/L', 'μmol/L'),
    }, {
      dependencies: ['serum-creatinine-worked-example'],
      formula: 'egfr-ckd-epi-2021',
      id: 'estimated-gfr-worked-example',
      kind: 'derived',
      source: 'scenario:ckd-epi-2021',
      unit: ucum('mL/min/{1.73_m2}', 'mL/min/1.73m²'),
    })

    expect(resolveScenarioInvestigation({
      catalogItemId: 'lab-egfr-worked-example',
      content,
      indicationCode: 'type-2-diabetes',
      patientId: patient.id,
      repeatIndex: 0,
      scenarioRunId: 'scenario-run-l2-egfr',
    })).toMatchObject({
      critical: false,
      report: '估算肾小球滤过率 73.04 mL/min/1.73m²。',
      result: { flag: 'N', outcome: 'reported', value: 73.04 },
      sourceLevel: 'L2',
    })
  })

  it('keeps Hb, RBC, HCT and MCV coupled through one physiology baseline', async () => {
    const content = await generatedContent('type-2-diabetes')
    const patient = content.patients[0]!
    const bind = (itemId: string, physiologyGeneratorId: string) => {
      Object.assign(content.catalog.investigations.find(item => item.id === itemId)!, {
        physiologyGeneratorId,
      })
    }
    bind('lab-rbc', 'red-blood-cells')
    bind('lab-mcv', 'mean-corpuscular-volume')
    bind('lab-hematocrit', 'hematocrit')
    patient.physiologyBaseline.generators.push({
      assayCv: 0.03,
      id: 'red-blood-cells',
      kind: 'normal',
      maximum: 5.8,
      mean: 4.7,
      minimum: 3.8,
      source: 'scenario:hematology-baseline',
      standardDeviation: 0.35,
      unit: ucum('10*12/L', '10^12/L'),
    }, {
      assayCv: 0.02,
      id: 'mean-corpuscular-volume',
      kind: 'normal',
      maximum: 100,
      mean: 90,
      minimum: 80,
      source: 'scenario:hematology-baseline',
      standardDeviation: 4,
      unit: ucum('fL'),
    }, {
      dependencies: ['red-blood-cells', 'mean-corpuscular-volume'],
      formula: 'hematocrit-from-rbc-mcv',
      id: 'hematocrit',
      kind: 'derived',
      source: 'scenario:rbc-mcv',
      unit: ucum('L/L'),
    })
    const resolveValue = (catalogItemId: string) => {
      const resolved = resolveScenarioInvestigation({
        catalogItemId,
        content,
        indicationCode: 'type-2-diabetes',
        patientId: patient.id,
        repeatIndex: 0,
        scenarioRunId: 'scenario-run-l2-hematology',
      })
      if (resolved.result.outcome !== 'reported') throw new Error('Expected a reported result')
      return resolved.result.value
    }

    expect({
      hematocrit: resolveValue('lab-hematocrit'),
      hemoglobin: resolveValue('lab-hemoglobin'),
      meanCorpuscularVolume: resolveValue('lab-mcv'),
      redBloodCells: resolveValue('lab-rbc'),
    }).toEqual({
      hematocrit: 0.42,
      hemoglobin: 148,
      meanCorpuscularVolume: 90,
      redBloodCells: 4.7,
    })
  })

  it('derives urine glucose from the same blood-glucose physiology baseline', async () => {
    const content = await generatedContent('type-2-diabetes')
    const patient = content.patients[0]!
    content.catalog.investigations.push({
      active: true,
      allowedIndicationCodes: ['type-2-diabetes'],
      available: true,
      category: 'laboratory',
      code: 'URINE-GLUCOSE',
      contraindicatedAllergyCodes: [],
      id: 'lab-urine-glucose-worked-example',
      name: '尿糖',
      organizationId: content.hospital.id,
      physiologyGeneratorId: 'urine-glucose-worked-example',
      priceFen: 500,
      referenceRanges: [{ appliesToGender: 'any', text: '阴性' }],
      reportTemplate: '尿糖 {value}。',
      status: 'active',
      tatMinutes: 30,
      valueType: 'codeable',
    })
    patient.physiologyBaseline.generators.push({
      dependencies: ['random-glucose'],
      formula: 'urine-glucose-from-blood-glucose',
      id: 'urine-glucose-worked-example',
      kind: 'derived',
      source: 'scenario:renal-glucose-threshold',
      unit: ucum('{qualitative}', 'qualitative'),
    })

    expect(resolveScenarioInvestigation({
      catalogItemId: 'lab-urine-glucose-worked-example',
      content,
      indicationCode: 'type-2-diabetes',
      patientId: patient.id,
      repeatIndex: 0,
      scenarioRunId: 'scenario-run-l2-urine-glucose',
    })).toMatchObject({
      critical: false,
      report: '尿糖 阳性（+）。',
      result: { flag: 'H', outcome: 'reported', value: '阳性（+）' },
      sourceLevel: 'L2',
    })
  })

  it('reports an L2 text generator as a qualitative result', async () => {
    const content = await generatedContent('type-2-diabetes')
    const patient = content.patients[0]!
    content.catalog.investigations.push({
      active: true,
      allowedIndicationCodes: ['type-2-diabetes'],
      available: true,
      category: 'laboratory',
      code: 'KETONE',
      contraindicatedAllergyCodes: [],
      id: 'lab-ketone-worked-example',
      name: '血酮体',
      organizationId: content.hospital.id,
      physiologyGeneratorId: 'ketone-worked-example',
      priceFen: 2_000,
      referenceRanges: [{ appliesToGender: 'any', text: '阴性' }],
      reportTemplate: '血酮体 {value}。',
      status: 'active',
      tatMinutes: 30,
      valueType: 'codeable',
    })
    patient.physiologyBaseline.generators.push({
      id: 'ketone-worked-example',
      kind: 'text',
      source: 'scenario:ketone-baseline',
      value: '阴性',
    })

    expect(resolveScenarioInvestigation({
      catalogItemId: 'lab-ketone-worked-example',
      content,
      indicationCode: 'type-2-diabetes',
      patientId: patient.id,
      repeatIndex: 0,
      scenarioRunId: 'scenario-run-l2-text',
    })).toMatchObject({
      critical: false,
      report: '血酮体 阴性。',
      result: { flag: 'N', outcome: 'reported', value: '阴性' },
      sourceLevel: 'L2',
    })
  })

  it('derives LDL cholesterol with the Friedewald formula inside its valid domain', async () => {
    const content = await generatedContent('type-2-diabetes')
    const patient = content.patients[0]!
    content.catalog.investigations.push({
      active: true,
      allowedIndicationCodes: ['type-2-diabetes'],
      available: true,
      category: 'laboratory',
      code: 'LDL-C',
      contraindicatedAllergyCodes: [],
      id: 'lab-ldl-worked-example',
      name: '低密度脂蛋白胆固醇',
      organizationId: content.hospital.id,
      physiologyGeneratorId: 'ldl-worked-example',
      priceFen: 800,
      referenceRanges: [{ appliesToGender: 'any', maximum: 3.4, text: '<=3.4 mmol/L' }],
      reportTemplate: '低密度脂蛋白胆固醇 {value} mmol/L。',
      status: 'active',
      tatMinutes: 60,
      unit: ucum('mmol/L'),
      valueType: 'quantity',
    })
    patient.physiologyBaseline.generators.push(...[
      { id: 'total-cholesterol-worked-example', value: 6, unit: ucum('mmol/L') },
      { id: 'hdl-worked-example', value: 1, unit: ucum('mmol/L') },
      { id: 'triglycerides-worked-example', value: 2.2, unit: ucum('mmol/L') },
    ].map(generator => ({
      assayCv: 0,
      ...generator,
      kind: 'constant' as const,
      source: 'scenario:lipid-baseline',
    })), {
      dependencies: [
        'total-cholesterol-worked-example',
        'hdl-worked-example',
        'triglycerides-worked-example',
      ],
      formula: 'friedewald-ldl',
      id: 'ldl-worked-example',
      kind: 'derived',
      source: 'scenario:friedewald',
      unit: ucum('mmol/L'),
    })

    expect(resolveScenarioInvestigation({
      catalogItemId: 'lab-ldl-worked-example',
      content,
      indicationCode: 'type-2-diabetes',
      patientId: patient.id,
      repeatIndex: 0,
      scenarioRunId: 'scenario-run-l2-friedewald',
    })).toMatchObject({
      critical: false,
      report: '低密度脂蛋白胆固醇 4 mmol/L。',
      result: { flag: 'H', outcome: 'reported', unit: ucum('mmol/L'), value: 4 },
      sourceLevel: 'L2',
    })
  })

  it('samples an unmodeled L3 item deterministically inside the normal reference domain', async () => {
    const content = await generatedContent('type-2-diabetes')
    const patient = content.patients[0]!
    Object.assign(content.catalog.investigations.find(item => item.id === 'lab-tsh')!, {
      criticalMaximum: 1,
    })
    const input = {
      catalogItemId: 'lab-tsh',
      content,
      indicationCode: 'type-2-diabetes',
      patientId: patient.id,
      repeatIndex: 0,
      scenarioRunId: 'scenario-run-l3',
    }

    const first = resolveScenarioInvestigation(input)
    const replay = resolveScenarioInvestigation(input)

    expect(replay).toEqual(first)
    expect(first).toMatchObject({
      critical: false,
      diagnostics: ['unmodeled_item'],
      feeFen: 18_000,
      itemId: 'lab-tsh',
      result: { flag: 'N', outcome: 'reported', unit: ucum('m[IU]/L', 'mIU/L') },
      sourceLevel: 'L3',
      tatMinutes: 240,
    })
    if (first.result.outcome !== 'reported' || typeof first.result.value !== 'number') {
      throw new Error('Expected a numeric TSH result')
    }
    expect(first.result.value).toBeGreaterThanOrEqual(0.55)
    expect(first.result.value).toBeLessThanOrEqual(4.78)
    expect(first.report).toBe(`促甲状腺激素 ${first.result.value} mIU/L。`)
  })

  it('returns catalog-boundary without fabricating a report for an unavailable item', async () => {
    const content = await generatedContent('type-2-diabetes')
    const patient = content.patients[0]!

    expect(resolveScenarioInvestigation({
      catalogItemId: 'exam-fundus-screening',
      content,
      indicationCode: 'type-2-diabetes',
      patientId: patient.id,
      repeatIndex: 0,
      scenarioRunId: 'scenario-run-catalog-boundary',
    })).toMatchObject({
      critical: false,
      feeFen: 0,
      result: { outcome: 'catalog-boundary' },
      sourceLevel: 'L3',
      tatMinutes: 0,
    })
  })

  it('returns not-indicated before generating a value outside the allowed indications', async () => {
    const content = await generatedContent('type-2-diabetes')
    const patient = content.patients[0]!

    expect(resolveScenarioInvestigation({
      catalogItemId: 'lab-tsh',
      content,
      indicationCode: 'clinical-assessment',
      patientId: patient.id,
      repeatIndex: 0,
      scenarioRunId: 'scenario-run-not-indicated',
    })).toMatchObject({
      critical: false,
      feeFen: 0,
      result: { outcome: 'not-indicated' },
      sourceLevel: 'L3',
      tatMinutes: 0,
    })
  })

  it('keys repeat assays by Run, patient, item and repeat index and only adds bounded CV noise', async () => {
    const content = await generatedContent('type-2-diabetes')
    const patient = content.patients[0]!
    patient.investigations = patient.investigations.filter(
      investigation => investigation.catalogItemId !== 'lab-random-glucose',
    )
    const baseInput = {
      catalogItemId: 'lab-random-glucose',
      content,
      indicationCode: 'type-2-diabetes',
      patientId: patient.id,
      scenarioRunId: 'scenario-run-repeat',
    }
    const initial = resolveScenarioInvestigation({ ...baseInput, repeatIndex: 0 })
    const repeat = resolveScenarioInvestigation({ ...baseInput, repeatIndex: 1 })
    const replay = resolveScenarioInvestigation({ ...baseInput, repeatIndex: 1 })
    if (
      initial.result.outcome !== 'reported'
      || repeat.result.outcome !== 'reported'
      || typeof initial.result.value !== 'number'
      || typeof repeat.result.value !== 'number'
    ) throw new Error('Expected numeric glucose results')

    expect(initial.result.value).toBe(13.8)
    expect(replay).toEqual(repeat)
    expect(repeat.result.value).not.toBe(initial.result.value)
    expect(Math.abs(repeat.result.value - initial.result.value)).toBeLessThanOrEqual(1.25)
  })

  it('resolves an investigation panel from explicit component relationships', async () => {
    const content = await generatedContent('type-2-diabetes')
    const patient = content.patients[0]!
    Object.assign(content.catalog.investigations.find(item => item.id === 'lab-cbc')!, {
      componentItemIds: ['lab-wbc', 'lab-hemoglobin', 'lab-rbc', 'lab-mcv', 'lab-hematocrit'],
    })
    const bind = (itemId: string, physiologyGeneratorId: string) => {
      Object.assign(content.catalog.investigations.find(item => item.id === itemId)!, {
        physiologyGeneratorId,
      })
    }
    bind('lab-rbc', 'red-blood-cells')
    bind('lab-mcv', 'mean-corpuscular-volume')
    bind('lab-hematocrit', 'hematocrit')
    patient.physiologyBaseline.generators.push({
      assayCv: 0.03,
      id: 'red-blood-cells',
      kind: 'normal',
      maximum: 5.8,
      mean: 4.7,
      minimum: 3.8,
      source: 'scenario:hematology-baseline',
      standardDeviation: 0.35,
      unit: ucum('10*12/L', '10^12/L'),
    }, {
      assayCv: 0.02,
      id: 'mean-corpuscular-volume',
      kind: 'normal',
      maximum: 100,
      mean: 90,
      minimum: 80,
      source: 'scenario:hematology-baseline',
      standardDeviation: 4,
      unit: ucum('fL'),
    }, {
      dependencies: ['red-blood-cells', 'mean-corpuscular-volume'],
      formula: 'hematocrit-from-rbc-mcv',
      id: 'hematocrit',
      kind: 'derived',
      source: 'scenario:rbc-mcv',
      unit: ucum('L/L'),
    })

    const resolved = resolveScenarioInvestigation({
      catalogItemId: 'lab-cbc',
      content,
      indicationCode: 'type-2-diabetes',
      patientId: patient.id,
      repeatIndex: 0,
      scenarioRunId: 'scenario-run-panel',
    })

    expect(resolved).toMatchObject({
      critical: false,
      diagnostics: ['unmodeled_item'],
      feeFen: 2_500,
      itemId: 'lab-cbc',
      sourceLevel: 'L3',
      tatMinutes: 20,
    })
    expect(resolved.components?.map(component => component.itemId)).toEqual([
      'lab-wbc',
      'lab-hemoglobin',
      'lab-rbc',
      'lab-mcv',
      'lab-hematocrit',
    ])
    expect(resolved.report).toContain('血红蛋白 148 g/L。')
  })

  it('rejects a cyclic investigation panel with a stable error', async () => {
    const content = await generatedContent('fever')
    const patient = content.patients[0]!
    const panel = {
      ...content.catalog.investigations[0]!,
      componentItemIds: ['lab-cycle-panel'],
      id: 'lab-cycle-panel',
      normalDistribution: undefined,
      physiologyGeneratorId: undefined,
    }
    content.catalog.investigations.push(panel)

    expect(() => resolveScenarioInvestigation({
      catalogItemId: panel.id,
      content,
      indicationCode: panel.allowedIndicationCodes[0]!,
      patientId: patient.id,
      repeatIndex: 0,
      scenarioRunId: 'scenario-run-panel-cycle',
    })).toThrow('Investigation panel cycle at lab-cycle-panel')
  })

  it('ships generated T2DM CaseTruth with executable coupled investigation sources', async () => {
    const content = await generatedContent('type-2-diabetes')
    const patient = content.patients[0]!
    const resolve = (catalogItemId: string) => resolveScenarioInvestigation({
      catalogItemId,
      content,
      indicationCode: 'type-2-diabetes',
      patientId: patient.id,
      repeatIndex: 0,
      scenarioRunId: 'scenario-run-generated-t2dm',
    })

    expect(resolve('exam-bmi').result).toMatchObject({ outcome: 'reported', value: 27.11 })
    expect(resolve('lab-egfr').result).toMatchObject({ outcome: 'reported', value: 88.96 })
    expect(resolve('lab-urine-glucose').result).toMatchObject({ outcome: 'reported', value: '阳性（+）' })
    expect(resolve('lab-cbc').components).toHaveLength(5)
  })
})
