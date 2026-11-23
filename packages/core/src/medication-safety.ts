import {
  medicationFrequencySchema,
  medicationRouteSchema,
  type MedicationFrequency,
  type MedicationRoute,
  type MedicationSafetyRule,
} from '@clinmesh/contracts/medication-safety'

export const MEDICATION_ROUTE_CODE_SYSTEM = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/medication-route' as const

const exclusiveClasses = [['acei', 'arb'], ['acei', 'arni'], ['arb', 'arni'], ['p2y12', 'p2y12'], ['statin', 'statin']] as const

export function medicationCombinationConflict(left: readonly string[], right: readonly string[]): boolean {
  return exclusiveClasses.some(([a, b]) => (left.includes(a) && right.includes(b)) || (left.includes(b) && right.includes(a)))
}

export function medicationIndicationMatches(prefixes: readonly string[], diagnosisCodes: readonly string[]): boolean {
  return diagnosisCodes.some(code => prefixes.some(prefix => code.toUpperCase().startsWith(prefix.toUpperCase())))
}

export function medicationScheduledHours(frequency: MedicationFrequency): readonly number[] {
  return { QD: [8], BID: [8, 20], TID: [8, 14, 20], QN: [22], PRN: [], ONCE: [] }[frequency]
}

const frequencyDisplayCatalog: Readonly<Record<string, readonly [zh: string, en: string, time: string]>> = {
  QD: ['每日一次', 'Once daily', '08:00'],
  BID: ['每日两次', 'Twice daily', '08:00、20:00'],
  TID: ['每日三次', 'Three times daily', '08:00、14:00、20:00'],
  QN: ['每晚一次', 'Every night', '22:00'],
  PRN: ['必要时', 'As needed', ''],
  ONCE: ['仅一次', 'Once only', ''],
}

/** 统一展示给药频次（中文全角括号、英文半角括号），可选附加住院执行时点；未知自定义频次原样保留。 */
export function formatMedicationFrequency(
  code: string,
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
  options?: { withTime?: boolean },
): string {
  const normalized = code.trim().toUpperCase()
  const entry = frequencyDisplayCatalog[normalized]
  if (entry === undefined) return code
  const [zh, en, time] = entry
  const base = locale === 'zh-CN' ? `${zh}（${normalized}）` : `${en} (${normalized})`
  if (!options?.withTime || !time) return base
  return `${base} · ${locale === 'zh-CN' ? time : time.replaceAll('、', ', ')}`
}

const routeDisplayCatalog: Readonly<Record<MedicationRoute, readonly [zh: string, en: string]>> = {
  PO: ['口服', 'Oral'],
  IVGTT: ['静脉滴注', 'Intravenous infusion'],
  IV: ['静脉注射', 'Intravenous injection'],
  IM: ['肌内注射', 'Intramuscular injection'],
  IH: ['皮下注射', 'Subcutaneous injection'],
  SL: ['舌下含服', 'Sublingual'],
  TOP: ['外用', 'Topical'],
  INH: ['吸入', 'Inhalation'],
}

/** 统一展示受控给药途径（中文全角括号小写缩写、英文半角括号小写缩写）；未知编码原样保留。 */
export function formatMedicationRoute(
  code: string,
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): string {
  const parsed = medicationRouteSchema.safeParse(code.trim().toUpperCase())
  if (!parsed.success) return code
  const route = parsed.data
  const [zh, en] = routeDisplayCatalog[route]
  const abbr = route.toLowerCase()
  return locale === 'zh-CN' ? `${zh}（${abbr}）` : `${en} (${abbr})`
}

export function medicationRouteAllowed(
  allowedRouteCodes: readonly string[],
  routeCode: string,
): boolean {
  const parsed = medicationRouteSchema.safeParse(routeCode)
  return parsed.success && allowedRouteCodes.includes(parsed.data)
}

export function medicationRouteConcept(code: MedicationRoute) {
  const [zh] = routeDisplayCatalog[code]
  return {
    coding: [{
      system: MEDICATION_ROUTE_CODE_SYSTEM,
      code,
      display: zh,
    }],
    text: formatMedicationRoute(code, 'zh-CN'),
  }
}

const topicalFormOrNamePattern = /外用|乳膏|软膏|眼用|眼膏|滴眼|滴耳|耳用|滴鼻|鼻用|栓剂|橡胶膏|橡胶贴膏|贴膏|膏药|贴剂|片剂\(贴片\)|片剂\(阴道\)|搽剂|擦剂|洗剂|凝胶|膜剂|涂膜|涂剂|灸剂|锭剂|植入剂|湿敷|灌肠|冲洗|含漱|溶液剂\(含甘油\)|开塞露|体外诊断|诊断试剂|点刺|放射性密封/
const topicalAerosolNamePattern = /云南白药|双氯芬酸|利多卡因|氯己定|麝香|伤湿|止痛|烧伤|口腔|咽|复方角菜酸酯/
const inhalationPattern = /吸入|粉雾|雾化/
const subcutaneousOnlyPattern = /依诺肝素|那屈肝素|达肝素|贝米肝素|帕肝素|低分子.*肝素|磺达肝癸钠|利拉鲁肽|司美格鲁肽|度拉糖肽|艾塞那肽|重组人促红素|粒细胞刺激因子|尤单抗/
const intramuscularOnlyPattern = /疫苗|破伤风|黄体酮注射液|苄星青霉素|普鲁卡因青霉素|绒促性素|尿促性素/
const infusionFluidNamePattern = /氯化钠注射液|葡萄糖注射液|糖盐水|林格|甘露醇注射液|氨基酸注射液|脂肪乳|羟乙基淀粉|右旋糖酐/
const contrastInjectablePattern = /碘海醇注射液|碘帕醇注射液|碘克沙醇注射液|碘佛醇注射液|碘普罗胺注射液/

/** 在服务读取边界按剂型与通用名确定性派生国家参考目录给药途径，不改动参考库底层哈希行。 */
export function deriveReferenceMedicationRoutes(input: {
  dosageForm: string
  genericName: string
}): { defaultRouteCode: MedicationRoute; allowedRouteCodes: MedicationRoute[] } {
  const form = input.dosageForm.trim()
  const name = input.genericName.trim()
  const combined = `${form} ${name}`

  if (topicalFormOrNamePattern.test(combined)) {
    return { defaultRouteCode: 'TOP', allowedRouteCodes: ['TOP'] }
  }
  if (inhalationPattern.test(combined)) {
    return { defaultRouteCode: 'INH', allowedRouteCodes: ['INH'] }
  }
  if (form.includes('气雾剂')) {
    return topicalAerosolNamePattern.test(name)
      ? { defaultRouteCode: 'TOP', allowedRouteCodes: ['TOP'] }
      : { defaultRouteCode: 'INH', allowedRouteCodes: ['INH'] }
  }
  if (form.includes('喷雾剂')) {
    return { defaultRouteCode: 'TOP', allowedRouteCodes: ['TOP'] }
  }
  if (combined.includes('口服') && combined.includes('疫苗')) {
    return { defaultRouteCode: 'PO', allowedRouteCodes: ['PO'] }
  }
  if (/注射|粉针|冻干|无菌粉末|无菌分装|溶媒结晶|输液|预灌封|多剂量笔/.test(form) || /注射液|注射用/.test(name)) {
    if (name.includes('胰岛素') && !name.includes('三磷酸腺苷辅酶胰岛素')) {
      return { defaultRouteCode: 'IH', allowedRouteCodes: ['IH', 'IV', 'IVGTT'] }
    }
    if (/多剂量笔|预灌封|皮下/.test(combined) || subcutaneousOnlyPattern.test(name)) {
      return { defaultRouteCode: 'IH', allowedRouteCodes: ['IH'] }
    }
    if (/肌肉注射|肌内注射/.test(combined) || intramuscularOnlyPattern.test(name)) {
      return { defaultRouteCode: 'IM', allowedRouteCodes: ['IM'] }
    }
    if (/大容量|输液|静脉滴注/.test(combined) || infusionFluidNamePattern.test(name)) {
      return { defaultRouteCode: 'IVGTT', allowedRouteCodes: ['IVGTT', 'IV'] }
    }
    if (name.startsWith('注射用') || /粉针|冻干|无菌粉末|无菌分装|溶媒结晶/.test(form)) {
      return { defaultRouteCode: 'IVGTT', allowedRouteCodes: ['IVGTT', 'IV', 'IM'] }
    }
    if (combined.includes('静脉注射') || contrastInjectablePattern.test(name)) {
      return { defaultRouteCode: 'IV', allowedRouteCodes: ['IV', 'IVGTT'] }
    }
    if (name.includes('肝素钠注射液') || name.includes('肝素钙注射液')) {
      return { defaultRouteCode: 'IV', allowedRouteCodes: ['IV', 'IVGTT', 'IH'] }
    }
    return { defaultRouteCode: 'IV', allowedRouteCodes: ['IV', 'IVGTT', 'IM', 'IH'] }
  }
  if (combined.includes('舌下')) {
    return { defaultRouteCode: 'SL', allowedRouteCodes: ['SL'] }
  }
  if (name.includes('硝酸甘油') || /含片|口含/.test(combined)) {
    return { defaultRouteCode: 'SL', allowedRouteCodes: ['SL', 'PO'] }
  }
  if (name.includes('硝酸异山梨酯片')) {
    return { defaultRouteCode: 'PO', allowedRouteCodes: ['PO', 'SL'] }
  }
  return { defaultRouteCode: 'PO', allowedRouteCodes: ['PO'] }
}

/** PRN 按每日最多四次的保守上界审方；执行仍须单独记录每次给药。 */
export function medicationDailyFrequency(frequency: MedicationFrequency): number {
  return frequency === 'PRN' ? 4 : frequency === 'ONCE' ? 1 : medicationScheduledHours(frequency).length
}

export function medicationDoseConflict(limits: MedicationSafetyRule['doseLimits'], doseText: string, frequency: MedicationFrequency): 'invalid-dose' | 'single-dose' | 'daily-dose' | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(mg|g|mL|IU)\s*$/i.exec(doseText)
  if (!match) return 'invalid-dose'
  const source = match[2]!.toLowerCase(), target = limits.unit.toLowerCase()
  const multiplier = source === target ? 1 : source === 'g' && target === 'mg' ? 1000 : source === 'mg' && target === 'g' ? 0.001 : undefined
  if (multiplier === undefined) return 'invalid-dose'
  const amount = Number(match[1]) * multiplier
  if (!Number.isFinite(amount) || amount < limits.minimumSingleDose || amount > limits.maximumSingleDose) return 'single-dose'
  if (amount * medicationDailyFrequency(frequency) > limits.maximumDailyDose) return 'daily-dose'
  return undefined
}

export function medicationRegimenDoseAllowed(config: { safety?: MedicationSafetyRule | undefined; allowedDoseTexts: readonly string[]; allowedFrequencyCodes: readonly string[] }, doseText: string, frequency: string): boolean {
  if (!config.allowedFrequencyCodes.includes(frequency)) return false
  if (!config.safety) return config.allowedDoseTexts.includes(doseText)
  const parsed = medicationFrequencySchema.safeParse(frequency)
  return parsed.success && medicationDoseConflict(config.safety.doseLimits, doseText, parsed.data) === undefined
}

export function medicationQuantityAllowed(
  config: { safety?: MedicationSafetyRule | undefined; allowedQuantities: readonly number[] },
  quantity: number,
  courseDays: number,
  frequencyCode?: string,
): boolean {
  const effectiveDays = frequencyCode === 'ONCE' ? 1 : courseDays
  return config.safety
    ? Number.isSafeInteger(quantity) && quantity > 0 && quantity <= Math.min(1000, config.safety.maximumDailyQuantity * effectiveDays)
    : config.allowedQuantities.includes(quantity)
}
