import {
  SURGICAL_CONSENT_DISCLAIMER,
  type AnesthesiaMethod,
  type InpatientSurgicalConsentDocument,
  type InpatientSurgeryLocation,
  type InpatientSurgeryPractitioner,
  type PreopOrderPolicy,
  type SurgicalConsentSignerRole,
  type SurgicalConsentTemplateId,
  type SurgeryLocationId,
  type SurgeryType,
} from '@clinmesh/contracts/inpatient-surgery'

export type SurgeryDisplayLocale = 'zh-CN' | 'en-US'

export const SURGICAL_LOCATIONS: readonly InpatientSurgeryLocation[] = Object.freeze([
  { id: 'location-catheterization-lab', name: '导管室', nameEn: 'Catheterization lab' },
  { id: 'location-operating-center', name: '中心手术室', nameEn: 'Central operating suite' },
  { id: 'location-endoscopy-suite', name: '内镜室', nameEn: 'Endoscopy suite' },
  { id: 'location-outpatient-or', name: '门诊手术室', nameEn: 'Outpatient operating room' },
])

const SURGERY_TYPE_LABELS: Record<SurgeryType, { zh: string; en: string }> = {
  elective: { zh: '择期手术', en: 'Elective' },
  'semi-elective': { zh: '限期手术', en: 'Semi-elective' },
  emergency: { zh: '急诊手术', en: 'Emergency' },
  'day-surgery': { zh: '日间手术', en: 'Day surgery' },
}

const ANESTHESIA_METHOD_LABELS: Record<AnesthesiaMethod, { zh: string; en: string }> = {
  'local-infiltration': { zh: '局部浸润麻醉', en: 'Local infiltration anesthesia' },
  'local-sedation': { zh: '局部麻醉+镇静', en: 'Local anesthesia with sedation' },
  general: { zh: '全身麻醉', en: 'General anesthesia' },
  neuraxial: { zh: '椎管内麻醉', en: 'Neuraxial anesthesia' },
  'nerve-block': { zh: '神经阻滞', en: 'Regional nerve block' },
}

const PREOP_ORDER_POLICY_LABELS: Record<PreopOrderPolicy, { zh: string; en: string }> = {
  'continue-active': { zh: '继续术前有效长期医嘱（常规介入/局麻）', en: 'Continue active pre-op long-term orders' },
  'stop-on-completion': { zh: '术后自动停术前长期医嘱并重整（外科/全麻）', en: 'Auto-stop active pre-op long-term orders on completion' },
}

const SIGNER_ROLE_LABELS: Record<SurgicalConsentSignerRole, { zh: string; en: string }> = {
  patient: { zh: '患者本人', en: 'Patient' },
  'family-proxy': { zh: '患者近亲属/受托人', en: 'Family member / proxy' },
}

export function formatSurgeryType(type: SurgeryType, locale: SurgeryDisplayLocale = 'zh-CN'): string {
  return locale === 'zh-CN' ? SURGERY_TYPE_LABELS[type].zh : SURGERY_TYPE_LABELS[type].en
}

export function formatAnesthesiaMethod(method: AnesthesiaMethod, locale: SurgeryDisplayLocale = 'zh-CN'): string {
  return locale === 'zh-CN' ? ANESTHESIA_METHOD_LABELS[method].zh : ANESTHESIA_METHOD_LABELS[method].en
}

export function formatPreopOrderPolicy(policy: PreopOrderPolicy, locale: SurgeryDisplayLocale = 'zh-CN'): string {
  return locale === 'zh-CN' ? PREOP_ORDER_POLICY_LABELS[policy].zh : PREOP_ORDER_POLICY_LABELS[policy].en
}

export function formatConsentSignerRole(role: SurgicalConsentSignerRole, locale: SurgeryDisplayLocale = 'zh-CN'): string {
  return locale === 'zh-CN' ? SIGNER_ROLE_LABELS[role].zh : SIGNER_ROLE_LABELS[role].en
}

export function formatPractitionerDisplay(practitioner: InpatientSurgeryPractitioner): string {
  return practitioner.title ? `${practitioner.name}（${practitioner.title}）` : practitioner.name
}

export function recommendedSurgeryLocationId(procedure: {
  coding: { category: '手术' | '介入治疗' | '诊断性操作'; code: string }
}): SurgeryLocationId {
  if (procedure.coding.category === '介入治疗' || procedure.coding.category === '诊断性操作') {
    return 'location-catheterization-lab'
  }
  return 'location-operating-center'
}

export function recommendedAnesthesiaMethod(procedure: {
  coding: { category: '手术' | '介入治疗' | '诊断性操作'; code: string }
}): AnesthesiaMethod {
  if (procedure.coding.category === '介入治疗' || procedure.coding.category === '诊断性操作') {
    return 'local-infiltration'
  }
  if (procedure.coding.code === '53.0001') {
    return 'neuraxial'
  }
  return 'general'
}

export function recommendedPreopOrderPolicy(
  procedure: { coding: { category: '手术' | '介入治疗' | '诊断性操作'; code: string } },
  anesthesiaMethod?: AnesthesiaMethod | undefined,
): PreopOrderPolicy {
  const effectiveAnesthesia = anesthesiaMethod ?? recommendedAnesthesiaMethod(procedure)
  if (
    procedure.coding.category === '手术'
    || effectiveAnesthesia === 'general'
    || effectiveAnesthesia === 'neuraxial'
    || effectiveAnesthesia === 'nerve-block'
  ) {
    return 'stop-on-completion'
  }
  return 'continue-active'
}

const SURGERY_TYPE_CODE_SYSTEM = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/surgery-type'
const ANESTHESIA_CODE_SYSTEM = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/anesthesia-method'
const PREOP_ORDER_POLICY_CODE_SYSTEM = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/preop-order-policy'
const SURGERY_ORDER_PARAMETER_SYSTEM = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/surgery-order-parameter'
const SURGERY_PERFORMER_ROLE_URL = 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/surgery-performer-role'

export function buildSurgeryServiceRequestFields(input: {
  surgeryType: SurgeryType
  location: { id: SurgeryLocationId; name: string }
  surgeon: InpatientSurgeryPractitioner
  assistant?: InpatientSurgeryPractitioner | undefined
  anesthesiaMethod: AnesthesiaMethod
  preopOrderPolicy: PreopOrderPolicy
}) {
  const priority = input.surgeryType === 'emergency'
    ? 'stat'
    : input.surgeryType === 'semi-elective'
      ? 'urgent'
      : 'routine'
  const surgeryTypeDisplay = formatSurgeryType(input.surgeryType, 'zh-CN')
  const anesthesiaDisplay = formatAnesthesiaMethod(input.anesthesiaMethod, 'zh-CN')
  const preopOrderPolicyDisplay = formatPreopOrderPolicy(input.preopOrderPolicy, 'zh-CN')
  return {
    priority,
    category: [{
      coding: [{ system: SURGERY_TYPE_CODE_SYSTEM, code: input.surgeryType, display: surgeryTypeDisplay }],
      text: surgeryTypeDisplay,
    }],
    location: [{
      reference: { reference: `Location/${input.location.id}`, display: input.location.name },
    }],
    performer: [
      {
        reference: `Practitioner/${input.surgeon.id}`,
        display: input.surgeon.name,
        extension: [{ url: SURGERY_PERFORMER_ROLE_URL, valueCode: 'primary-surgeon' }],
      },
      ...(input.assistant
        ? [{
            reference: `Practitioner/${input.assistant.id}`,
            display: input.assistant.name,
            extension: [{ url: SURGERY_PERFORMER_ROLE_URL, valueCode: 'first-assistant' }],
          }]
        : []),
    ],
    orderDetail: [{
      parameter: [
        {
          code: {
            coding: [{ system: SURGERY_ORDER_PARAMETER_SYSTEM, code: 'anesthesia-method', display: '拟行麻醉方式' }],
            text: '拟行麻醉方式',
          },
          valueCodeableConcept: {
            coding: [{ system: ANESTHESIA_CODE_SYSTEM, code: input.anesthesiaMethod, display: anesthesiaDisplay }],
            text: anesthesiaDisplay,
          },
        },
        {
          code: {
            coding: [{ system: SURGERY_ORDER_PARAMETER_SYSTEM, code: 'preop-order-policy', display: '术前长期医嘱停续策略' }],
            text: '术前长期医嘱停续策略',
          },
          valueCodeableConcept: {
            coding: [{ system: PREOP_ORDER_POLICY_CODE_SYSTEM, code: input.preopOrderPolicy, display: preopOrderPolicyDisplay }],
            text: preopOrderPolicyDisplay,
          },
        },
      ],
    }],
  }
}

export interface SurgicalConsentTemplate {
  readonly id: SurgicalConsentTemplateId
  readonly templateVersion: '2026-11-23.r1'
  readonly title: string
  readonly purposeAndMethod: string
  readonly commonRisks: readonly string[]
  readonly alternativePlans: string
  readonly patientChoiceStatement: string
}

const CONSENT_TEMPLATES: Record<SurgicalConsentTemplateId, SurgicalConsentTemplate> = Object.freeze({
  'coronary-angiography': Object.freeze({
    id: 'coronary-angiography',
    templateVersion: '2026-11-23.r1',
    title: '冠状动脉造影术知情同意书',
    purposeAndMethod:
      '经桡动脉或股动脉局部麻醉穿刺置入动脉鞘管，沿导丝送入造影导管至左、右冠状动脉开口，注射含碘对比剂并在多体位 X 线透视下记录冠状动脉管腔狭窄部位、程度及血流分级，必要时联合冠脉血流储备分数（FFR/iFR）明确心肌缺血指征，为后续药物保守或血运重建治疗提供客观依据。',
    commonRisks: Object.freeze([
      '穿刺部位局部出血、皮下血肿、假性动脉瘤、动静脉瘘、桡动脉痉挛或闭塞及周围神经损伤。',
      '含碘对比剂不良反应（皮疹、恶心呕吐、喉头水肿乃至过敏性休克）及对比剂相关性急性肾损伤。',
      '导管或导丝操作诱发冠状动脉痉挛、内膜夹层、血管穿孔、斑块脱落致远端微栓塞或急性闭塞。',
      '术中及术后严重心律失常（室性心动过速、心室颤动、严重心动过缓或传导阻滞）、急性心肌梗死、心包填塞、脑卒中或外周动脉栓塞。',
      '因血管严重迂曲、钙化或解剖变异导致插管困难或检查未能按计划完成。',
    ]),
    alternativePlans:
      '可选冠状动脉 CT 血管成像（CCTA）、心肌灌注显像或负荷超声心动图等无创评估方案，以及单纯规范冠心病药物保守治疗；无创影像在严重钙化或管腔功能学评估上存在局限。',
    patientChoiceStatement:
      '医师已向本人（或患者近亲属/受托人）详细告知当前病情、拟行冠状动脉造影术的目的与操作过程、拟行麻醉方式、常见及个体化医疗风险与替代医疗方案。本人已充分理解并自愿同意实施该项检查操作及相应麻醉与急救处置。',
  }),
  'coronary-des-pci': Object.freeze({
    id: 'coronary-des-pci',
    templateVersion: '2026-11-23.r1',
    title: '经皮冠状动脉药物洗脱支架置入术知情同意书',
    purposeAndMethod:
      '经外周动脉入路置入指引导管至靶冠状动脉开口，操控冠脉导丝通过狭窄或闭塞病变，先行球囊扩张预处理后精确释放药物洗脱支架支撑病变血管壁，恢复冠状动脉前向血流与心肌灌注，降低缺血事件风险。术后需按医嘱规范接受双联抗血小板及冠心病二级预防治疗。',
    commonRisks: Object.freeze([
      '冠状动脉急性夹层、穿孔、心包积血或急性心包填塞，严重时需急诊心包穿刺引流或外科开胸冠状动脉旁路移植术抢救。',
      '靶病变急性闭塞、分支血管受压闭塞、慢血流或无复流现象、支架脱载、支架膨胀不全或贴壁不良、急性/亚急性支架内血栓形成及远期支架内再狭窄。',
      '围术期心肌损伤或急性心肌梗死、恶性心律失常、急性心力衰竭、心源性休克乃至心搏骤停。',
      '围术期抗血小板与抗凝药物相关的消化道出血、颅内出血、泌尿道出血及穿刺入路大血肿、假性动脉瘤或腹膜后血肿。',
      '含碘对比剂过敏反应与对比剂相关性急性肾损伤，或因重度钙化、慢性闭塞致器械无法通过而血运重建失败。',
    ]),
    alternativePlans:
      '可选强化规范药物保守治疗（抗血小板、他汀调脂稳斑、抗心肌缺血及危险因素控制）、单纯球囊/药物涂层球囊成形术，或外科冠状动脉旁路移植术（CABG，尤其适用于复杂多支或左主干病变）。',
    patientChoiceStatement:
      '医师已向本人（或患者近亲属/受托人）详细说明当前诊断、拟行经皮冠状动脉药物洗脱支架置入术的必要性、麻醉方式、支架置入专有并发症风险、术后双联抗血小板治疗要求及替代治疗方案。本人已充分理解并自愿同意实施拟定介入手术与麻醉方案。',
  }),
  'coronary-balloon-pci': Object.freeze({
    id: 'coronary-balloon-pci',
    templateVersion: '2026-11-23.r1',
    title: '经皮冠状动脉球囊扩张成形术知情同意书',
    purposeAndMethod:
      '经外周动脉入路送入指引导管与冠脉导丝跨越靶血管狭窄段，使用普通球囊或药物涂层球囊对病变进行扩张成形（或释放抗增殖药物），改善冠状动脉管腔狭窄与远端心肌供血；若术中出现严重限流性夹层或急性弹性回缩，可能需补救性置入冠脉支架。',
    commonRisks: Object.freeze([
      '球囊扩张部位急性血管弹性回缩、严重内膜撕裂或限流性夹层、急性血管闭塞，需术中紧急补救性支架置入或急诊外科搭桥。',
      '冠状动脉穿孔、心包积液或急性心包填塞、分支血管受压闭塞、斑块碎屑远端栓塞致慢血流或无复流。',
      '围术期急性心肌梗死、恶性心律失常、急性心力衰竭或心源性休克，以及远期靶病变再狭窄。',
      '穿刺部位出血、血肿、假性动脉瘤及围术期抗栓治疗相关脏器出血。',
      '含碘对比剂过敏反应与对比剂相关性急性肾损伤。',
    ]),
    alternativePlans:
      '可选强化规范药物保守治疗、药物洗脱支架置入术或外科冠状动脉旁路移植术（CABG）。',
    patientChoiceStatement:
      '医师已向本人（或患者近亲属/受托人）详细说明当前病情、拟行冠状动脉球囊扩张成形术的操作方法、麻醉方式、急性夹层/弹性回缩等专有风险及替代方案。本人已充分理解并自愿同意实施拟定介入治疗与麻醉方案。',
  }),
  'general-surgery': Object.freeze({
    id: 'general-surgery',
    templateVersion: '2026-11-23.r1',
    title: '手术知情同意书',
    purposeAndMethod:
      '针对患者当前外科病变，在预定麻醉方式下按临床操作规范切除病灶或修补解剖缺损（腔镜微创术式必要时可根据术中解剖粘连或出血情况中转开放手术），以解除病灶、缓解症状并预防疾病进展并发症。',
    commonRisks: Object.freeze([
      '术中及术后创面或血管出血、血肿形成，严重时需输血或再次手术止血。',
      '手术切口或腔内感染、脂肪液化、切口裂开、吻合口或修补部位愈合不良及病变复发。',
      '邻近脏器、血管或神经副损伤，术后粘连性肠梗阻、胆瘘/肠瘘或局部慢性疼痛（腔镜手术含气腹相关高碳酸血症、皮下气肿及中转开腹可能）。',
      '围术期麻醉意外、药物过敏、呼吸抑制、心脑血管意外、肺部感染及下肢深静脉血栓形成或肺栓塞。',
    ]),
    alternativePlans:
      '可选暂行抗感染/对症支持等非手术保守观察，或选择其他手术入路方式（如开放手术与腔镜手术互换）；保守治疗可能存在病情反复、穿孔梗阻或延误手术时机风险。',
    patientChoiceStatement:
      '医师已向本人（或患者近亲属/受托人）详细告知当前病情、拟施手术名称与方式、拟行麻醉方式、术中术后常见与个体化医疗风险及替代治疗方案。本人已充分理解并自愿同意实施拟定手术及麻醉方案。',
  }),
})

export function resolveSurgicalConsentTemplate(procedureCode: string): SurgicalConsentTemplate {
  if (procedureCode === '88.5500' || procedureCode === '88.5600') {
    return CONSENT_TEMPLATES['coronary-angiography']
  }
  if (procedureCode === '36.0700') {
    return CONSENT_TEMPLATES['coronary-des-pci']
  }
  if (procedureCode === '00.6600' || procedureCode === '00.6600x008') {
    return CONSENT_TEMPLATES['coronary-balloon-pci']
  }
  return CONSENT_TEMPLATES['general-surgery']
}

function formatGenderZh(gender: 'female' | 'male' | 'other' | 'unknown'): string {
  if (gender === 'female') return '女'
  if (gender === 'male') return '男'
  if (gender === 'other') return '其他'
  return '未记录'
}

function formatConsentMinuteShanghai(iso: string): string {
  const shifted = new Date(Date.parse(iso) + 8 * 60 * 60 * 1000)
  if (!Number.isFinite(shifted.getTime())) return iso
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')} ${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`
}

export interface BuildSurgicalConsentDocumentInput {
  patient: {
    name: string
    gender: 'female' | 'male' | 'other' | 'unknown'
    birthDate: string | null
    inpatientNumber: string
  }
  primaryDiagnosis: { code: string; display: string } | null
  surgeryNotice: {
    surgeryType: SurgeryType | null
    procedureCode: string
    procedureDisplay: string
    plannedFor: string
    locationName: string | null
    anesthesiaMethod: AnesthesiaMethod | null
    surgeonName: string | null
    assistantName: string | null
  }
  individualizedRisks?: string | null | undefined
  signature: {
    signerRole: SurgicalConsentSignerRole
    signerName: string
    signerRelationship?: string | null | undefined
    talkingDoctorId: string
    talkingDoctorName: string
    signedAt: string
  }
}

export function buildSurgicalConsentDocument(input: BuildSurgicalConsentDocumentInput): InpatientSurgicalConsentDocument {
  const template = resolveSurgicalConsentTemplate(input.surgeryNotice.procedureCode)
  const individualized = input.individualizedRisks?.trim() || null
  const relationship = input.signature.signerRole === 'family-proxy'
    ? (input.signature.signerRelationship?.trim() || null)
    : null
  const diagnosisText = input.primaryDiagnosis
    ? `${input.primaryDiagnosis.code} ${input.primaryDiagnosis.display}`
    : '尚未确认住院主诊断'
  const surgeryTypeText = input.surgeryNotice.surgeryType
    ? formatSurgeryType(input.surgeryNotice.surgeryType, 'zh-CN')
    : '未记录'
  const anesthesiaText = input.surgeryNotice.anesthesiaMethod
    ? formatAnesthesiaMethod(input.surgeryNotice.anesthesiaMethod, 'zh-CN')
    : '未记录'
  const surgeonText = input.surgeryNotice.surgeonName ?? '未记录'
  const assistantText = input.surgeryNotice.assistantName ? `；第一助手：${input.surgeryNotice.assistantName}` : ''
  const signerText = input.signature.signerRole === 'patient'
    ? `患者本人：${input.signature.signerName.trim()}`
    : `患者近亲属/受托人：${input.signature.signerName.trim()}（关系：${relationship ?? '未注明'}）`

  const renderedText = [
    `【${SURGICAL_CONSENT_DISCLAIMER}】`,
    template.title,
    `一、患者与拟施手术信息：姓名 ${input.patient.name}，性别 ${formatGenderZh(input.patient.gender)}，出生日期 ${input.patient.birthDate ?? '未记录'}，住院号 ${input.patient.inpatientNumber}；住院主诊断：${diagnosisText}；手术类型：${surgeryTypeText}；拟施术式：${input.surgeryNotice.procedureCode} ${input.surgeryNotice.procedureDisplay}；计划手术时间：${formatConsentMinuteShanghai(input.surgeryNotice.plannedFor)}；手术执行地点：${input.surgeryNotice.locationName ?? '未记录'}；拟行麻醉方式：${anesthesiaText}；主刀医师：${surgeonText}${assistantText}。`,
    `二、手术目的与简要方法：${template.purposeAndMethod}`,
    `三、常见风险与并发症告知：\n${template.commonRisks.map((clause, index) => `${index + 1}. ${clause}`).join('\n')}`,
    `四、患者个体化特别风险说明：${individualized ?? '无额外补充特殊风险条款。'}`,
    `五、替代医疗方案：${template.alternativePlans}`,
    `六、知情选择与签署确认：${template.patientChoiceStatement}\n签署方：${signerText}（同意手术与麻醉方案）｜谈话医师：${input.signature.talkingDoctorName}｜确认时间：${formatConsentMinuteShanghai(input.signature.signedAt)}`,
  ].join('\n\n')

  return {
    templateId: template.id,
    templateVersion: template.templateVersion,
    title: template.title,
    disclaimer: SURGICAL_CONSENT_DISCLAIMER,
    patient: input.patient,
    primaryDiagnosis: input.primaryDiagnosis,
    surgeryNotice: input.surgeryNotice,
    purposeAndMethod: template.purposeAndMethod,
    commonRisks: [...template.commonRisks],
    individualizedRisks: individualized,
    alternativePlans: template.alternativePlans,
    patientChoiceStatement: template.patientChoiceStatement,
    signature: {
      signerRole: input.signature.signerRole,
      signerName: input.signature.signerName.trim(),
      signerRelationship: relationship,
      patientChoice: 'agree',
      talkingDoctorId: input.signature.talkingDoctorId,
      talkingDoctorName: input.signature.talkingDoctorName,
      signedAt: input.signature.signedAt,
    },
    renderedText,
  }
}

export function formatSurgicalConsentSummaryNote(
  consent: InpatientSurgicalConsentDocument,
  explicitNote?: string | undefined,
): string {
  const trimmed = explicitNote?.trim()
  const signerSummary = consent.signature.signerRole === 'patient'
    ? `患者本人（${consent.signature.signerName}）已签署《${consent.title}》`
    : `患者受托人${consent.signature.signerName}（${consent.signature.signerRelationship ?? '家属'}）已签署《${consent.title}》`
  const base = `${signerSummary}，谈话医师：${consent.signature.talkingDoctorName}`
  return trimmed ? `${base}；${trimmed}` : base
}
