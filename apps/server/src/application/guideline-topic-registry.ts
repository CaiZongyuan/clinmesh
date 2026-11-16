import {
  guidelineTopicIds,
  type GuidelineTopicBundle,
  type GuidelineTopicEvidence,
  type GuidelineTopicId,
  type GuidelineTopicPatientIndicator,
  type GuidelineTopicRead,
  type GuidelineTopicSummary,
} from '@clinmesh/contracts/guideline-topics'
import type { ClinicalScoreBundle } from '@clinmesh/contracts/clinical-scores'
import type { CoronaryVesselFinding } from '@clinmesh/contracts/inpatient-angiography'
import type { InpatientGuidelineAdviceKind } from '@clinmesh/contracts/inpatient-guideline-advice'
import { pciMeasurementSchema, pciSelectionProcedureCodes } from '@clinmesh/contracts/inpatient-pci-selection'
import { investigationResultContentSchema } from '@clinmesh/contracts/scenario'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository, RepositoryContext } from '../infrastructure/sqlite/fhir-repository.ts'
import type { GuidelineCorpus } from '../infrastructure/sqlite/guideline-corpus.ts'
import type { ActorContext } from './command-executor.ts'
import type { GuidelinePatientPopulation } from './guideline-corpus.ts'
import type { InpatientService } from './inpatient-service.ts'
import { resolvePatientGuidelinePopulation } from './patient-age.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

export interface GuidelineTopicReferenceSpec {
  readonly fragments: readonly string[]
  readonly page: number
  readonly sha256: string
  readonly sourceId: string
  readonly title: string
  readonly version: string
}

export interface GuidelineTopicDefinition {
  readonly conclusionKinds: readonly [InpatientGuidelineAdviceKind, InpatientGuidelineAdviceKind, InpatientGuidelineAdviceKind]
  readonly fingerprint: string
  readonly generationRule: string
  readonly id: GuidelineTopicId
  readonly limitations: readonly string[]
  readonly matchTerms: readonly string[]
  readonly navigation: string
  readonly references: readonly GuidelineTopicReferenceSpec[]
  readonly specialty: 'cardiology' | 'endocrinology'
  readonly titleEn: string
  readonly titleZh: string
  readonly version: string
}

const REVASCULARIZATION_HASH = '9843131ad84f9a261ceb8857025e656a067496472edabfb6bd2b6297f2c5ff0e'
const CVIT_IVUS_HASH = 'c2018438f6bfe9abf39cdfa813f6a6312de858bb6047ce18d9a01bff222ae9ad'
const CONTRAST_CONSENSUS_HASH = '332e74aa189a08a56053e38cc8deea8b07aeeb1903770a2b41248692cce77c0e'
const ACS_EMERGENCY_HASH = 'ed1502f49449419eb1d540e289e15715ea5f58b40a0dc71af281a08e69ed5139'
const STABLE_CAD_HASH = '703136f8921a50cb40c5db7c9033da9c5a21fe3ae7d957d0e60f67492812367b'
const DAPT_CONSENSUS_HASH = '02c7080308bc64e9c499f8ba01f70a572127aee069f256e19937c9749a55f9e9'
const DM_CVD_HASH = '9bcd9a39a232cd028f3d83f775ff3d5663cc199544a0392522c1bba0a886b54b'
const CVD_GLYCEMIC_HASH = '2dbf8c8053ce6fd10d6eb004d36f8149103260397fd94146bc691f6f8c767b0f'

function buildTopic(spec: Omit<GuidelineTopicDefinition, 'fingerprint'>): GuidelineTopicDefinition {
  const fingerprint = canonicalJsonHash({
    id: spec.id,
    limitations: spec.limitations,
    navigation: spec.navigation,
    references: spec.references,
    version: spec.version,
  })
  return { ...spec, fingerprint }
}

const TOPICS_LIST: readonly GuidelineTopicDefinition[] = [
  buildTopic({
    id: 'acute-chest-pain-acs',
    titleZh: '急性胸痛与急性冠脉综合征急诊评估与介入时机',
    titleEn: 'Acute chest pain & ACS initial evaluation and invasive timing',
    specialty: 'cardiology',
    version: '2026-11-17.r1',
    conclusionKinds: ['initial-triage-diagnostics', 'ischemic-risk-stratification', 'invasive-timing-strategy'],
    matchTerms: ['急性胸痛', '急性冠脉综合征', '胸骨后压榨', 'NSTEMI', 'STEMI', '不稳定型心绞痛', 'ACS', 'I20.0', 'I21'],
    navigation: '适用于急性胸痛及疑似急性冠脉综合征患者核对首诊 10 分钟 12 导联心电图、心肌肌钙蛋白（cTn/hs-cTn）复测与非冠脉病因鉴别、GRACE/TIMI 缺血危险分层以及 NSTE-ACS 不行溶栓与高危早期介入时机。以下仅为操作性导航，结论必须逐条引用同时回读的指南原文。',
    limitations: [
      '固定引用 2019 急性冠脉综合征急诊快速诊治指南，仅用于流程与限定条件核对。',
      '单次心电图或单次肌钙蛋白阴性不能直接排除 NSTE-ACS，亦不能跳过出血禁忌直接套用抗栓给药。',
    ],
    generationRule: '仅依据 guidelines 原文与 clinicalFacts 起草三类只读结论：initial-triage-diagnostics（首诊心电与肌钙蛋白评估及非冠脉鉴别）、ischemic-risk-stratification（GRACE/TIMI 危险分层与抗栓前提）、invasive-timing-strategy（NSTE-ACS 禁溶栓与介入时机分层）。保留原文限定条件，缺客观资料时仅输出 conditional 意见。',
    references: [
      {
        sourceId: 'coronary-31-2019',
        title: '急性冠脉综合征急诊快速诊治指南（2019）',
        version: '2019',
        sha256: ACS_EMERGENCY_HASH,
        page: 2,
        fragments: ['10 min 内行标准 12 导联', '检测 cTn 或 hs-cTn', '单次 ECG 对 NSTE-ACS 诊断价值有限', '非冠脉事件的 cTn 升高'],
      },
      {
        sourceId: 'coronary-31-2019',
        title: '急性冠脉综合征急诊快速诊治指南（2019）',
        version: '2019',
        sha256: ACS_EMERGENCY_HASH,
        page: 3,
        fragments: ['使用 GRACE 评分和（或）TIMI 积分评估 NSTE-ACS 缺血风险和预后', '所有无阿司匹林禁忌证的患者'],
      },
      {
        sourceId: 'coronary-31-2019',
        title: '急性冠脉综合征急诊快速诊治指南（2019）',
        version: '2019',
        sha256: ACS_EMERGENCY_HASH,
        page: 5,
        fragments: ['NSTE-ACS 患者 不行溶栓治疗', 'GRACE 评分＞ 140 分', '早期介入策略（＜ 24 h）'],
      },
    ],
  }),
  buildTopic({
    id: 'coronary-revascularization-indication',
    titleZh: '冠脉临界病变功能学评估（FFR/iFR）与血运重建指征',
    titleEn: 'Coronary physiological assessment (FFR/iFR) & revascularization indication',
    specialty: 'cardiology',
    version: '2026-11-17.r1',
    conclusionKinds: ['functional-ischemia-evaluation', 'revascularization-vs-gdmt', 'modality-and-anatomy-scope'],
    matchTerms: ['血运重建', '临界病变', '血流储备分数', 'FFR', 'iFR', '冠脉造影指征', 'coronary revascularization'],
    navigation: '适用于稳定性或非急诊冠脉病变核对解剖狭窄程度、FFR/iFR 功能学缺血阈值及血运重建与规范药物治疗（GDMT）边界：中等狭窄（40%–69% 或 <90%）需结合缺血证据或 FFR/iFR；当 FFR > 0.80 或 iFR > 0.89 时不应行 PCI。以下仅为操作性导航，结论必须引用同时回读的原文。',
    limitations: [
      '固定引用 2021 ACC/AHA/SCAI 血运重建指南与 2018 稳定性冠心病指南，不替代心脏团队对左主干或复杂多支病变的综合讨论。',
      '不能仅凭冠心病病名推定需要支架植入；FFR > 0.80 的非缺血病变以优化药物治疗与危险因素控制为主。',
    ],
    generationRule: '仅依据 guidelines 原文与 clinicalFacts 起草三类只读结论：functional-ischemia-evaluation（中等或 <90% 狭窄的功能学 FFR/iFR 与缺血证据要求）、revascularization-vs-gdmt（FFR > 0.80 / iFR > 0.89 不应行 PCI 与 ≥90% 狭窄或明确缺血干预边界）、modality-and-anatomy-scope（非左主干单双支解剖与生存获益限定条件）。缺造影或功能学数值时仅输出 conditional 意见。',
    references: [
      {
        sourceId: 'coronary-10-2021',
        title: '2021 ACC/AHA/SCAI 血运重建指南',
        version: '2021',
        sha256: REVASCULARIZATION_HASH,
        page: 14,
        fragments: [
          '40% to 69%',
          'fractional flow reserve (FFR) or instantaneous wave-free ratio (iFR) is recommended',
          'FFR >0.80 or iFR >0.89, PCI should not be performed',
        ],
      },
      {
        sourceId: 'coronary-10-2021',
        title: '2021 ACC/AHA/SCAI 血运重建指南',
        version: '2021',
        sha256: REVASCULARIZATION_HASH,
        page: 23,
        fragments: [
          '<70% diameter of non–left main coronary artery stenosis, FFR >0.80',
          'coronary revascularization should not be performed with the primary or sole intent to improve survival',
        ],
      },
      {
        sourceId: 'coronary-32-2018',
        title: '稳定性冠心病诊断与治疗指南（2018）',
        version: '2018',
        sha256: STABLE_CAD_HASH,
        page: 7,
        fragments: [
          '病变直径狭窄≥90% 时，可直接干预',
          '当病变直径狭窄<90% 时，建议仅对有相应缺血证据，或 FFR≤0.8 的病变进行干预',
        ],
      },
    ],
  }),
  buildTopic({
    id: 'pci-stent',
    titleZh: 'PCI 支架类别、腔内影像（IVUS/OCT）与参考段测量要求',
    titleEn: 'PCI stent category, IVUS/OCT guidance & reference measurement',
    specialty: 'cardiology',
    version: '2026-11-02.r1',
    conclusionKinds: ['stent-category', 'imaging-guidance', 'measurement-requirements'],
    matchTerms: ['支架选型', '血管内超声', 'IVUS', 'OCT', '药物洗脱支架', 'DES'],
    navigation: '适用于已提出PCI计划时核对支架类别、IVUS／OCT指导条件与测量要求。DES相对BMS属于类别建议；IVUS的用途及OCT的替代均须保留人群、条件、例外与推荐强度。测量须区分近远端参考段、管腔与EEM及测长方法。以下仅为操作性导航，结论必须引用同时回读的原文，不以导航文字作证据。',
    limitations: [
      '首期固定2021版血运重建指南与CVIT共识，未完成现行版本全集核查。',
      '不判断是否应接受PCI，不提供具体产品、规格或固定数量；合成方案的3.0mm、5–16mm与每类一件不属于指南要求。',
    ],
    generationRule: '仅依据guidelines完整原文与clinicalFacts起草三类只读指南参考意见：stent-category（支架类别）、imaging-guidance（IVUS/OCT指导条件）、measurement-requirements（测量要求）。topic仅是操作性导航不是证据。逐条给实际evidenceId和未经改写的原句。保留人群、条件、例外与推荐强度，不把可考虑写成必须；不能把所有PCI写为必须IVUS，OCT需保留左主干开口限制。缺测量或单位仍给conditional类别意见和缺项，不补造患者事实，不从目录倒推测量，不推荐固定产品、规格或数量；3.0mm、5–16mm及每类一件只是合成方案，不是指南要求。',
    references: [
      {
        sourceId: 'coronary-10-2021',
        title: '2021 ACC/AHA/SCAI 血运重建指南',
        version: '2021',
        sha256: REVASCULARIZATION_HASH,
        page: 35,
        fragments: ['In patients undergoing PCI, DES should be used in preference to BMS'],
      },
      {
        sourceId: 'coronary-10-2021',
        title: '2021 ACC/AHA/SCAI 血运重建指南',
        version: '2021',
        sha256: REVASCULARIZATION_HASH,
        page: 36,
        fragments: ['IVUS can be useful', 'left main or complex coronary artery stenting', 'except in ostial left main disease'],
      },
      {
        sourceId: 'coronary-15-2021',
        title: '2021 CVIT 血管内超声共识',
        version: '2021',
        sha256: CVIT_IVUS_HASH,
        page: 6,
        fragments: ['both proximal and distal reference', 'lumen, EEM, and plaque measurements', 'length cannot be measured'],
      },
    ],
  }),
  buildTopic({
    id: 'contrast-kidney-hydration',
    titleZh: '含碘对比剂肾病（PCAKI）风险分层、围术期水化与对比剂限量',
    titleEn: 'Contrast-associated AKI risk stratification, hydration & contrast dose limit',
    specialty: 'cardiology',
    version: '2026-11-17.r1',
    conclusionKinds: ['renal-risk-stratification', 'hydration-and-volume-balance', 'contrast-dose-control'],
    matchTerms: ['对比剂', '造影剂', '水化', 'PCAKI', '对比剂肾病', '碘海醇', '碘克沙醇', 'contrast media'],
    navigation: '适用于拟行或已行含碘对比剂冠脉造影/PCI 患者核对术前血肌酐与 eGFR 危险分层、0.9% 氯化钠围术期水化与左心功能不全防容量负荷过重限制、对比剂剂量/eGFR 比值 ≤ 3.7 控制，以及超低/零对比剂技术须严格限定适应证且有术前影像与 IVUS 条件。以下仅为操作性导航，结论必须引用同时回读的原文。',
    limitations: [
      '固定引用 2021 经动脉心血管介入诊治中含碘对比剂相关不良反应防治中国专家共识（第 4 页经受控勘误剥离图内乱码并保留原文正文）。',
      '左心功能不全或失代偿心力衰竭患者严禁机械套用高速补液，须结合心功能个体化调整水化速率并监测术后肾功能。',
    ],
    generationRule: '仅依据 guidelines 原文与 clinicalFacts 起草三类只读结论：renal-risk-stratification（术前肾功能 eGFR 分层、CKD 高危识别及必要时肾内科会诊）、hydration-and-volume-balance（0.9% 氯化钠水化方案与左心功能不全防容量负荷过重平衡）、contrast-dose-control（对比剂体积与 eGFR 比值不大于 3.7 及零对比剂严格限定条件）。缺 eGFR 或心功能评估时仅输出 conditional 意见。',
    references: [
      {
        sourceId: 'coronary-20-2021',
        title: '经动脉心血管介入诊治中含碘对比剂相关不良反应防治的中国专家共识（2021）',
        version: '2021',
        sha256: CONTRAST_CONSENSUS_HASH,
        page: 2,
        fragments: ['慢性肾脏疾病', '最重要的危险因素', '比值>3.7'],
      },
      {
        sourceId: 'coronary-20-2021',
        title: '经动脉心血管介入诊治中含碘对比剂相关不良反应防治的中国专家共识（2021）',
        version: '2021',
        sha256: CONTRAST_CONSENSUS_HASH,
        page: 3,
        fragments: ['必要时请肾内科会诊', '个体化的获益风险评估'],
      },
      {
        sourceId: 'coronary-20-2021',
        title: '经动脉心血管介入诊治中含碘对比剂相关不良反应防治的中国专家共识（2021）',
        version: '2021',
        sha256: CONTRAST_CONSENSUS_HASH,
        page: 4,
        fragments: [
          '术前进行肾功能的评估并根据患者 eGFR 的水平进行危险分层',
          '0.9% 氯化钠溶液',
          '对有左心功能不全的患者需防止容量负荷过重',
          '对比剂剂量与 eGFR 的比值不能大于 3.7',
        ],
      },
      {
        sourceId: 'coronary-20-2021',
        title: '经动脉心血管介入诊治中含碘对比剂相关不良反应防治的中国专家共识（2021）',
        version: '2021',
        sha256: CONTRAST_CONSENSUS_HASH,
        page: 5,
        fragments: ['患者需要在术前有冠状动脉造影及 CT 影像资料', '且须在 IVUS 指导下完成介入诊断治疗', '尚不能在临床常规推广应用', '建议严格限定其适应证'],
      },
    ],
  }),
  buildTopic({
    id: 'cad-dapt-and-secondary-prevention',
    titleZh: '冠心病双联抗血小板（DAPT）疗程权衡与二级预防达标管理',
    titleEn: 'CAD DAPT duration trade-off & secondary prevention lipid/GDMT management',
    specialty: 'cardiology',
    version: '2026-11-17.r1',
    conclusionKinds: ['dapt-duration-and-bleeding', 'lipid-target-therapy', 'cardioprotective-gdmt'],
    matchTerms: ['双联抗血小板', '双抗', 'DAPT', 'PRECISE-DAPT', '二级预防', '氯吡格雷', '替格瑞洛', '依折麦布'],
    navigation: '适用于冠心病（ACS 或 CCS）PCI 术后、保守药物治疗或院后随访阶段核对缺血与出血风险权衡（如 PRECISE-DAPT ≥ 25 高出血风险缩短疗程 vs 标准 6/12 个月疗程）、以 LDL-C 为首要靶点的降脂联合策略（他汀未达标加用依折麦布等）及合并高血压/LVEF ≤ 40%/糖尿病/CKD 时 ACEI/ARB 等二级预防用药。以下仅为操作性导航，结论必须引用同时回读的原文。',
    limitations: [
      '固定引用 2021 冠心病双联抗血小板治疗中国专家共识与 2018 稳定性冠心病指南，不能对所有支架或冠心病患者机械套用单一双抗月数。',
      '具体抗血小板与降脂药品选择须同时遵守患者过敏史、活动性出血禁忌、肝肾功能及院内处方审方规则。',
    ],
    generationRule: '仅依据 guidelines 原文与 clinicalFacts 起草三类只读结论：dapt-duration-and-bleeding（ACS/CCS 不同路径双抗疗程与 PRECISE-DAPT ≥ 25 高出血风险缩短条件）、lipid-target-therapy（以 LDL-C 为首要干预靶点及未达标联合依折麦布等条件）、cardioprotective-gdmt（合并高血压、LVEF ≤ 40%、糖尿病或慢性肾病时 ACEI/ARB 等综合二级预防）。缺出血评分或血脂/心超资料时仅输出 conditional 意见。',
    references: [
      {
        sourceId: 'coronary-24-2021',
        title: '冠心病双联抗血小板治疗中国专家共识（2021）',
        version: '2021',
        sha256: DAPT_CONSENSUS_HASH,
        page: 3,
        fragments: ['充分权衡缺血和出血风险', 'PRECISE-DAPT 评分≥25 分', '选择 3~6 个月的 DAPT'],
      },
      {
        sourceId: 'coronary-24-2021',
        title: '冠心病双联抗血小板治疗中国专家共识（2021）',
        version: '2021',
        sha256: DAPT_CONSENSUS_HASH,
        page: 9,
        fragments: [
          '推荐 CCS 患者 PCI 术后 DAPT 疗程为 6 个月',
          '6 个月 DAPT 并不适用于所有 CCS 患者',
          '高出血风险的 CCS 患者应考虑缩短 PCI 术后 DAPT 疗程至 1~3 个月',
        ],
      },
      {
        sourceId: 'coronary-24-2021',
        title: '冠心病双联抗血小板治疗中国专家共识（2021）',
        version: '2021',
        sha256: DAPT_CONSENSUS_HASH,
        page: 10,
        fragments: ['在接受单纯药物治疗的 ACS 患者中，建议 DAPT 至少 12 个月', '除非出血风险大于潜在缺血获益'],
      },
      {
        sourceId: 'coronary-32-2018',
        title: '稳定性冠心病诊断与治疗指南（2018）',
        version: '2018',
        sha256: STABLE_CAD_HASH,
        page: 7,
        fragments: ['推荐以 LDL-C 为首要干预靶点', '依折麦布', '合并高血压、LVEF≤40%、糖尿病或慢性肾病的高危患者', 'ACEI 或 ARB'],
      },
    ],
  }),
  buildTopic({
    id: 't2dm-renal-medication',
    titleZh: '2 型糖尿病合并心血管/慢性肾脏病（CKD）降糖药物选择与肾功能调整',
    titleEn: 'T2DM with CVD/CKD glucose-lowering selection & renal dose adjustment',
    specialty: 'endocrinology',
    version: '2026-11-17.r1',
    conclusionKinds: ['renal-stage-contraindications', 'cardiorenal-agent-selection', 'glycemic-monitoring-and-adjustment'],
    matchTerms: ['2型糖尿病', '糖尿病肾病', '慢性肾脏病', '二甲双胍', '达格列净', '利格列汀', 'SGLT-2i', 'E11', 'N18'],
    navigation: '适用于 2 型糖尿病合并心血管疾病或慢性肾脏病（CKD）患者按 eGFR 分期核对降糖药物禁忌与调整：重度肾功能不全（eGFR < 30 mL/min/1.73m²，CKD 4–5 期）及急性/失代偿心力衰竭禁用二甲双胍以防乳酸酸中毒，CKD 3b 期（44–30）慎用减量，核对 SGLT-2i/GLP-1RA 适用条件及 CKD 3b–5 期利格列汀或胰岛素替代策略。以下仅为操作性导航，结论必须引用同时回读的原文。',
    limitations: [
      '固定引用 2021 糖尿病患者合并心血管疾病诊治专家共识与心血管病合并糖代谢异常专家共识，作为跨病种慢病肾功用药核对依据。',
      '具体药品能否开立仍受本院审方硬红线（如已证实 eGFR < 30 禁用二甲双胍/达格列净）与药品说明书剂量上限约束。',
    ],
    generationRule: '仅依据 guidelines 原文与 clinicalFacts 起草三类只读结论：renal-stage-contraindications（按 CKD 3a/3b/4–5 期 eGFR 核对二甲双胍减量、停用及失代偿心衰乳酸酸中毒风险）、cardiorenal-agent-selection（合并 ASCVD/CKD 时 SGLT-2i、GLP-1RA、DPP-4i 利格列汀及胰岛素的分期选择条件）、glycemic-monitoring-and-adjustment（HbA1c、血糖与肾功能随访监测要求）。缺 eGFR 或 HbA1c 时仅输出 conditional 意见。',
    references: [
      {
        sourceId: 'coronary-25-2021',
        title: '糖尿病患者合并心血管疾病诊治专家共识（2021）',
        version: '2021',
        sha256: DM_CVD_HASH,
        page: 7,
        fragments: ['建议二甲双胍为 T2DM 合并 CVD 患者的一线降糖药物', '不建议急性及失代偿性心力衰竭患者使用二甲双胍', 'GLP-1RA 或 SGLT-2i'],
      },
      {
        sourceId: 'coronary-25-2021',
        title: '糖尿病患者合并心血管疾病诊治专家共识（2021）',
        version: '2021',
        sha256: DM_CVD_HASH,
        page: 8,
        fragments: ['T2DM 合并 CVD 伴 CKD 患者的降糖药物选择', 'CKD 3b~5 期患者建议胰岛素治疗'],
      },
      {
        sourceId: 'coronary-25-2021',
        title: '糖尿病患者合并心血管疾病诊治专家共识（2021）',
        version: '2021',
        sha256: DM_CVD_HASH,
        page: 9,
        fragments: ['双胍类：二甲双胍', '3a期（59~45）', '3b期（44~30）', '4期（29~15）', 'SGLT-2i：达格列净', 'DPP-4i：利格列汀'],
      },
      {
        sourceId: 'coronary-22-2021',
        title: '心血管病合并糖代谢异常患者心血管风险综合管理中国专家共识（2021）',
        version: '2021',
        sha256: CVD_GLYCEMIC_HASH,
        page: 6,
        fragments: ['重度肾功能不全', '可能增加乳酸酸中毒风险'],
      },
    ],
  }),
]

const TOPICS_BY_ID: ReadonlyMap<GuidelineTopicId, GuidelineTopicDefinition> = new Map(
  TOPICS_LIST.map(topic => [topic.id, topic]),
)

export function listGuidelineTopicDefinitions(): readonly GuidelineTopicDefinition[] {
  return TOPICS_LIST
}

export function getGuidelineTopicDefinition(topicId: GuidelineTopicId): GuidelineTopicDefinition {
  const topic = TOPICS_BY_ID.get(topicId)
  if (topic === undefined) throw new Error(`Unknown guideline topic: ${topicId}`)
  return topic
}

export function toGuidelineTopicSummary(definition: GuidelineTopicDefinition): GuidelineTopicSummary {
  return {
    fingerprint: definition.fingerprint,
    id: definition.id,
    specialty: definition.specialty,
    titleEn: definition.titleEn,
    titleZh: definition.titleZh,
    version: definition.version,
  }
}

export function normalizeGuidelineFragmentText(text: string): string {
  return text
    .replace(/([a-z])-\r?\n([a-z])/g, '$1$2')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s/g, '')
    .toLowerCase()
}

export interface GuidelineTopicSourceReadResult {
  degradedReason: string | null
  definition: GuidelineTopicDefinition
  guidelines: GuidelineTopicEvidence[]
  missing: string[]
  sourceStatus: 'available' | 'unavailable' | 'read-failed'
  topic: {
    id: GuidelineTopicId
    limitations: string[]
    navigation: string
    version: string
  }
}

export function readGuidelineTopicSource(
  topicId: GuidelineTopicId,
  corpus?: GuidelineCorpus,
  options?: { population?: GuidelinePatientPopulation },
): GuidelineTopicSourceReadResult {
  const definition = getGuidelineTopicDefinition(topicId)
  const topic = {
    id: definition.id,
    limitations: [...definition.limitations],
    navigation: definition.navigation,
    version: definition.version,
  }
  const empty = (degradedReason: string, missing: string[], sourceStatus: 'unavailable' | 'read-failed' = 'unavailable'): GuidelineTopicSourceReadResult => ({
    degradedReason,
    definition,
    guidelines: [],
    missing,
    sourceStatus,
    topic,
  })

  if (!corpus) {
    const msg = '尚无本专题可用的固定指南原文，无法提供指南参考意见。'
    return empty(msg, [msg], 'unavailable')
  }

  let read: ReturnType<GuidelineCorpus['readReferences']>
  try {
    read = corpus.readReferences(
      definition.references.map(({ page, sha256, sourceId, version }) => ({ page, sha256, sourceId, version })),
      options,
    )
  } catch {
    const msg = '指南原文读取失败，请核查指南库后显式重新评估。'
    return empty(msg, [msg], 'read-failed')
  }

  if (read.missing.length > 0) {
    const missing = read.missing.map((item) => {
      const ref = definition.references.find(candidate => candidate.sourceId === item.sourceId && candidate.page === item.page)
        ?? definition.references.find(candidate => candidate.sourceId === item.sourceId)!
      if (item.status === 'withheld' && item.reason === 'population-mismatch') {
        return `${ref.title}物理第${item.page}页适用人群与当前患者不匹配（已隔离不可用），不予引用。`
      }
      return `${ref.title}物理第${item.page}页不可用，请核查来源版本、用途与正文。`
    })
    return empty(missing.join('；'), missing, 'unavailable')
  }

  for (const reference of definition.references) {
    const pageText = read.guidelines
      .filter(item =>
        item.sourceHash === reference.sha256
        && item.version === reference.version
        && Number(/^PDF 物理第 (\d+) 页/.exec(item.locator)?.[1]) === reference.page)
      .map(item => item.text)
      .join('\n')
    if (!reference.fragments.every(fragment => normalizeGuidelineFragmentText(pageText).includes(normalizeGuidelineFragmentText(fragment)))) {
      const msg = `指南物理第${reference.page}页未完整保留本专题所需条款与限定语，停止使用专题。`
      return empty(msg, [msg], 'unavailable')
    }
  }

  if (read.guidelines.length + 1 > 8 || Buffer.byteLength(JSON.stringify({ topic, guidelines: read.guidelines })) > 48 * 1024) {
    const msg = '指南专题与完整原文超出证据预算，不能截断限定语后提供意见。'
    return empty(msg, [msg], 'unavailable')
  }

  return {
    degradedReason: null,
    definition,
    guidelines: read.guidelines,
    missing: [],
    sourceStatus: 'available',
    topic,
  }
}

export function matchApplicableGuidelineTopicIds(textCorpus: string): GuidelineTopicId[] {
  const lower = textCorpus.toLowerCase()
  return TOPICS_LIST
    .filter(topic => topic.matchTerms.some(term => lower.includes(term.toLowerCase())))
    .map(topic => topic.id)
}

export function collectPciSelectionMissingItems(options: {
  hasValidCandidate: boolean
  measurements: ReadonlyArray<z.infer<typeof pciMeasurementSchema>>
  targetSite: string | null | undefined
}): string[] {
  const missing: string[] = []
  if (!options.measurements.some(item => item.source.reference.startsWith('DiagnosticReport/'))) {
    missing.push('当前选型测量未关联本次正式造影报告；仅给出一般类别、测量要求与具体缺项。')
  }
  for (const [kind, label] of [
    ['lesion-length', '病变长度'],
    ['proximal-reference-diameter', '近端参考管径'],
    ['distal-reference-diameter', '远端参考管径'],
  ] as const) {
    const measurement = options.measurements.find(item => item.kind === kind)
    if (measurement?.value === null || measurement === undefined) missing.push(`缺少${label}。`)
    if (measurement && measurement.unit === null) missing.push(`${label}缺少单位。`)
    if (measurement?.object === 'unknown') missing.push(`${label}的测量对象尚未核实。`)
  }
  if (!options.targetSite) missing.push('缺少靶血管具体部位。')
  if (!options.hasValidCandidate) {
    missing.push('缺少本计划适用的具体耗材候选，类别意见不能代替具体产品。')
  }
  return missing
}

export function summarizeCoronaryAngiographyVessels(vessels: readonly CoronaryVesselFinding[]): {
  missingFfrMessages: string[]
  summaryText: string
} {
  const missingFfrMessages: string[] = []
  const parts: string[] = []
  for (const v of vessels) {
    const ffrValid = typeof v.ffr === 'number' && Number.isFinite(v.ffr)
    const ifrValid = typeof v.ifr === 'number' && Number.isFinite(v.ifr)
    if (v.stenosisPercent >= 40 && v.stenosisPercent < 90 && !ffrValid && !ifrValid) {
      missingFfrMessages.push(`${v.vessel}(${v.segment}) 呈 ${v.stenosisPercent}% 临界/中等狭窄，尚未记录该支 FFR/iFR 功能学测量或客观缺血证据。`)
    }
    const ffrPart = ffrValid ? `（FFR ${v.ffr}${v.ffr! > 0.8 ? ' > 0.80 保守治疗范围' : ' ≤ 0.80 功能性缺血'}）` : ''
    const ifrPart = ifrValid ? `（iFR ${v.ifr}${v.ifr! > 0.89 ? ' > 0.89 保守治疗范围' : ' ≤ 0.89 功能性缺血'}）` : ''
    parts.push(`${v.vessel}(${v.segment}) 狭窄 ${v.stenosisPercent}%${ffrPart}${ifrPart}`)
  }
  return {
    missingFfrMessages,
    summaryText: parts.join(' · '),
  }
}

interface SupplementaryClinicalIndicators {
  angiographySummary?: {
    missingFfrMessages: string[]
    sourceReference: string
    summaryText: string
    versionId: string
  } | undefined
  ecgSummary?: { conclusion: string; sourceReference: string; versionId: string } | undefined
  hba1c?: { sourceReference: string; valueText: string; versionId: string } | undefined
  pciPlanSummary?: {
    hasValidCandidate: boolean
    missingItems: string[]
    sourceReference: string
    targetSite: string | null
    versionId: string
  } | undefined
  tteLvef?: { lvefPct: number; sourceReference: string; versionId: string } | undefined
}

function scoreIndicator(
  scores: ClinicalScoreBundle,
  scoreId: ClinicalScoreBundle['scores'][number]['id'],
  labelZh: string,
  labelEn: string,
): GuidelineTopicPatientIndicator {
  const found = scores.scores.find(item => item.id === scoreId)
  if (found?.status === 'complete') {
    const firstRef = found.sourceReferences[0]
    return {
      code: scoreId,
      labelEn,
      labelZh,
      sourceReference: firstRef?.reference ?? null,
      status: 'present',
      valueText: found.summaryZh,
      versionId: firstRef?.versionId ?? null,
    }
  }
  return {
    code: scoreId,
    labelEn,
    labelZh,
    sourceReference: null,
    status: 'missing',
    valueText: found?.summaryZh ?? null,
    versionId: null,
  }
}

export function buildGuidelineTopicRead(options: {
  corpus?: GuidelineCorpus | undefined
  population: GuidelinePatientPopulation
  scores: ClinicalScoreBundle
  supplementary: SupplementaryClinicalIndicators
  topicId: GuidelineTopicId
}): GuidelineTopicRead {
  const sourceRead = readGuidelineTopicSource(options.topicId, options.corpus, { population: options.population })
  const { indicators, missingPatientInputs } = evaluateTopicPatientIndicators(
    options.topicId,
    options.scores,
    options.supplementary,
  )
  return {
    degradedReason: sourceRead.degradedReason,
    guidelines: sourceRead.guidelines,
    limitations: [...sourceRead.definition.limitations],
    missingPatientInputs,
    missingSources: sourceRead.missing,
    navigation: sourceRead.definition.navigation,
    patientIndicators: indicators,
    population: options.population,
    status: sourceRead.sourceStatus === 'available' ? 'available' : 'unavailable',
    topic: toGuidelineTopicSummary(sourceRead.definition),
  }
}

export function evaluateTopicPatientIndicators(
  topicId: GuidelineTopicId,
  scores: ClinicalScoreBundle,
  supplementary: SupplementaryClinicalIndicators,
): { indicators: GuidelineTopicPatientIndicator[]; missingPatientInputs: string[] } {
  const indicators: GuidelineTopicPatientIndicator[] = []
  const missing: string[] = []

  const pushExam = (
    code: string,
    labelZh: string,
    labelEn: string,
    present: { sourceReference: string; valueText: string; versionId: string } | undefined,
    missingMessage: string,
  ) => {
    if (present !== undefined) {
      indicators.push({
        code,
        labelEn,
        labelZh,
        sourceReference: present.sourceReference,
        status: 'present',
        valueText: present.valueText,
        versionId: present.versionId,
      })
    } else {
      indicators.push({
        code,
        labelEn,
        labelZh,
        sourceReference: null,
        status: 'missing',
        valueText: null,
        versionId: null,
      })
      missing.push(missingMessage)
    }
  }

  const pushScore = (
    scoreId: ClinicalScoreBundle['scores'][number]['id'],
    labelZh: string,
    labelEn: string,
    missingPrefix: string,
  ) => {
    const ind = scoreIndicator(scores, scoreId, labelZh, labelEn)
    indicators.push(ind)
    if (ind.status === 'missing') {
      const score = scores.scores.find(item => item.id === scoreId)
      missing.push(score ? `${missingPrefix}（${score.summaryZh}）` : missingPrefix)
    }
  }

  if (topicId === 'acute-chest-pain-acs') {
    pushExam(
      'ecg-12-lead',
      '12 导联心电图报告',
      '12-lead ECG report',
      supplementary.ecgSummary === undefined
        ? undefined
        : {
            sourceReference: supplementary.ecgSummary.sourceReference,
            valueText: supplementary.ecgSummary.conclusion,
            versionId: supplementary.ecgSummary.versionId,
          },
      '缺少已签发 12 导联心电图结构化报告。',
    )
    pushScore('grace-acs', 'GRACE 急性冠脉综合征评分', 'GRACE ACS score', 'GRACE 危险分层未就绪')
    pushScore('timi-ua-nstemi', 'TIMI UA/NSTEMI 评分', 'TIMI UA/NSTEMI score', 'TIMI 缺血评分未就绪')
    pushScore('ckd-epi-2021-egfr', '基线估算肾小球滤过率 (eGFR)', 'Baseline eGFR', '缺少基线血肌酐与 eGFR')
  } else if (topicId === 'coronary-revascularization-indication') {
    if (supplementary.angiographySummary !== undefined) {
      indicators.push({
        code: 'coronary-angiography',
        labelEn: 'Coronary angiography & FFR/iFR',
        labelZh: '冠脉造影解剖狭窄与功能学评估',
        sourceReference: supplementary.angiographySummary.sourceReference,
        status: 'present',
        valueText: supplementary.angiographySummary.summaryText,
        versionId: supplementary.angiographySummary.versionId,
      })
      missing.push(...supplementary.angiographySummary.missingFfrMessages)
    } else {
      indicators.push({
        code: 'coronary-angiography',
        labelEn: 'Coronary angiography & FFR/iFR',
        labelZh: '冠脉造影解剖狭窄与功能学评估',
        sourceReference: null,
        status: 'missing',
        valueText: null,
        versionId: null,
      })
      missing.push('尚未关联本次正式冠脉造影狭窄率或 FFR/iFR 功能学评估记录。')
    }
    pushExam(
      'tte-lvef',
      '经胸超声心动图 LVEF',
      'Transthoracic echo LVEF',
      supplementary.tteLvef === undefined
        ? undefined
        : {
            sourceReference: supplementary.tteLvef.sourceReference,
            valueText: `LVEF ${supplementary.tteLvef.lvefPct}%`,
            versionId: supplementary.tteLvef.versionId,
          },
      '缺少经胸超声心动图左室射血分数（LVEF）记录。',
    )
    pushScore('ckd-epi-2021-egfr', '估算肾小球滤过率 (eGFR)', 'eGFR', '缺少造影/血运重建前血肌酐与 eGFR')
  } else if (topicId === 'pci-stent') {
    if (supplementary.pciPlanSummary !== undefined) {
      indicators.push({
        code: 'pci-selection-plan',
        labelEn: 'PCI target vessel & sizing measurements',
        labelZh: 'PCI 靶血管与参考段测量',
        sourceReference: supplementary.pciPlanSummary.sourceReference,
        status: supplementary.pciPlanSummary.missingItems.length === 0 ? 'present' : 'missing',
        valueText: supplementary.pciPlanSummary.targetSite ?? '待补充靶血管与管径/长度测量',
        versionId: supplementary.pciPlanSummary.versionId,
      })
      missing.push(...supplementary.pciPlanSummary.missingItems)
    } else if (supplementary.angiographySummary !== undefined) {
      indicators.push({
        code: 'coronary-angiography',
        labelEn: 'Coronary angiography report',
        labelZh: '冠脉造影报告',
        sourceReference: supplementary.angiographySummary.sourceReference,
        status: 'present',
        valueText: supplementary.angiographySummary.summaryText,
        versionId: supplementary.angiographySummary.versionId,
      })
      missing.push('当前未绑定有效的 PCI 支架手术申请与近远端参考管径/病变长度选型参数。')
    } else {
      indicators.push({
        code: 'pci-selection-plan',
        labelEn: 'PCI target vessel & sizing measurements',
        labelZh: 'PCI 靶血管与参考段测量',
        sourceReference: null,
        status: 'missing',
        valueText: null,
        versionId: null,
      })
      missing.push('缺少冠脉造影报告及 PCI 靶病变长度、近端/远端参考管径测量。')
    }
  } else if (topicId === 'contrast-kidney-hydration') {
    pushScore('ckd-epi-2021-egfr', '术前估算肾小球滤过率 (eGFR)', 'Pre-procedural eGFR', '缺少术前血肌酐与 eGFR 危险分层依据')
    pushScore('cockcroft-gault-crcl', '肌酐清除率 (CrCl / 体重)', 'Creatinine clearance (CrCl)', '缺少体重或肌酐清除率（影响按体重水化速率计算）')
    pushExam(
      'tte-lvef',
      '左心室收缩功能 (TTE LVEF)',
      'Left ventricular function (TTE LVEF)',
      supplementary.tteLvef === undefined
        ? undefined
        : {
            sourceReference: supplementary.tteLvef.sourceReference,
            valueText: `LVEF ${supplementary.tteLvef.lvefPct}%`,
            versionId: supplementary.tteLvef.versionId,
          },
      '缺少经胸超声心动图 LVEF 或心功能评估（水化须防止左心功能不全容量负荷过重）。',
    )
  } else if (topicId === 'cad-dapt-and-secondary-prevention') {
    pushScore('precise-dapt', 'PRECISE-DAPT 出血风险评分', 'PRECISE-DAPT bleeding score', 'PRECISE-DAPT 出血评分未就绪')
    pushScore('ascvd-ldl-target', 'ASCVD 风险分层与 LDL-C 目标核对', 'ASCVD risk & LDL-C goal', 'LDL-C 目标值核对未就绪')
    pushExam(
      'tte-lvef',
      '经胸超声心动图 LVEF',
      'Transthoracic echo LVEF',
      supplementary.tteLvef === undefined
        ? undefined
        : {
            sourceReference: supplementary.tteLvef.sourceReference,
            valueText: `LVEF ${supplementary.tteLvef.lvefPct}%`,
            versionId: supplementary.tteLvef.versionId,
          },
      '缺少 LVEF 评估（影响合并 LVEF ≤ 40% 时 ACEI/ARB/β 受体阻滞剂二级预防核对）。',
    )
  } else {
    pushScore('ckd-epi-2021-egfr', '估算肾小球滤过率 (eGFR / CKD 分期)', 'eGFR & CKD stage', '缺少血肌酐与 eGFR（无法判定二甲双胍/达格列净肾功能分期界值）')
    pushScore('cockcroft-gault-crcl', '肌酐清除率 (CrCl)', 'Creatinine clearance (CrCl)', '缺少体重或肌酐清除率')
    pushExam(
      'lab-hba1c',
      '糖化血红蛋白 (HbA1c)',
      'HbA1c',
      supplementary.hba1c,
      '缺少近期糖化血红蛋白（HbA1c）检验记录。',
    )
  }

  return { indicators, missingPatientInputs: missing }
}

export function extractSupplementaryIndicators(options: {
  caseId: string
  context: RepositoryContext
  database: ClinMeshDatabase
  fhir: FhirRepository
  inpatient?: { actor: ActorContext; service: InpatientService } | undefined
}): SupplementaryClinicalIndicators {
  const { caseId, context, database, fhir, inpatient } = options

  const examRows = z.array(z.object({
    content_json: z.string(),
    diagnostic_report_id: z.string(),
    exam_code: z.enum(['ecg-12-lead', 'tte']),
  })).parse(
    database.driver.prepare(`
      SELECT d.exam_code, c.diagnostic_report_id, c.content_json
      FROM examination_report_content c
      JOIN laboratory_request r
        ON r.workspace_id = c.workspace_id
       AND r.epoch = c.epoch
       AND r.request_id = c.request_id
       AND r.diagnostic_report_id = c.diagnostic_report_id
      JOIN examination_request_detail d
        ON d.workspace_id = c.workspace_id
       AND d.epoch = c.epoch
       AND d.request_id = c.request_id
      WHERE c.workspace_id = ? AND c.epoch = ? AND c.case_id = ?
        AND r.status IN ('reported', 'acknowledged')
      ORDER BY julianday(c.issued_at) DESC, c.diagnostic_report_id DESC
    `).all(context.workspaceId, context.epoch, caseId),
  )

  let ecgSummary: SupplementaryClinicalIndicators['ecgSummary']
  let tteLvef: SupplementaryClinicalIndicators['tteLvef']
  for (const row of examRows) {
    const parsed = investigationResultContentSchema.safeParse(JSON.parse(row.content_json))
    if (!parsed.success) continue
    const report = fhir.read(context, 'DiagnosticReport', row.diagnostic_report_id)
    const versionId = report.meta?.versionId ?? '1'
    if (row.exam_code === 'ecg-12-lead' && ecgSummary === undefined) {
      ecgSummary = {
        conclusion: parsed.data.conclusion,
        sourceReference: `DiagnosticReport/${row.diagnostic_report_id}`,
        versionId,
      }
    }
    if (row.exam_code === 'tte' && tteLvef === undefined) {
      const lvef = parsed.data.results.find(item => item.code === 'lvef' && typeof item.value === 'number')
      if (lvef !== undefined && typeof lvef.value === 'number') {
        tteLvef = {
          lvefPct: lvef.value,
          sourceReference: `DiagnosticReport/${row.diagnostic_report_id}`,
          versionId,
        }
      }
    }
  }

  let hba1c: SupplementaryClinicalIndicators['hba1c']
  const labReportRows = z.array(z.object({ diagnostic_report_id: z.string() })).parse(
    database.driver.prepare(`
      SELECT r.diagnostic_report_id
      FROM laboratory_request r
      WHERE r.workspace_id = ? AND r.epoch = ? AND r.case_id = ?
        AND r.request_kind = 'laboratory'
        AND r.status IN ('reported', 'acknowledged')
        AND r.diagnostic_report_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM laboratory_report_revision rev
          WHERE rev.workspace_id = r.workspace_id
            AND rev.epoch = r.epoch
            AND rev.revision_of_diagnostic_report_id = r.diagnostic_report_id
        )
      ORDER BY julianday(COALESCE(r.reported_at, r.authored_at)) DESC, r.request_id DESC
    `).all(context.workspaceId, context.epoch, caseId),
  )
  for (const row of labReportRows) {
    if (hba1c !== undefined) break
    const report = z.object({
      result: z.array(z.object({ reference: z.string().optional() }).loose()).optional(),
      status: z.string().optional(),
    }).loose().safeParse(fhir.read(context, 'DiagnosticReport', row.diagnostic_report_id))
    if (!report.success || !['final', 'amended', 'corrected'].includes(report.data.status ?? '')) continue
    for (const ref of report.data.result ?? []) {
      const obsId = ref.reference?.startsWith('Observation/') ? ref.reference.slice('Observation/'.length) : undefined
      if (!obsId) continue
      const obs = z.object({
        code: z.object({
          coding: z.array(z.object({ code: z.string().optional(), display: z.string().optional() }).loose()).optional(),
          text: z.string().optional(),
        }).loose().optional(),
        id: z.string(),
        meta: z.object({ versionId: z.string().optional() }).loose().optional(),
        status: z.string().optional(),
        valueQuantity: z.object({ unit: z.string().optional(), value: z.number().finite().optional() }).loose().optional(),
      }).loose().safeParse(fhir.read(context, 'Observation', obsId))
      if (!obs.success || !['final', 'amended', 'corrected'].includes(obs.data.status ?? '')) continue
      const codes = new Set((obs.data.code?.coding ?? []).map(c => c.code ?? ''))
      const text = [obs.data.code?.text, ...(obs.data.code?.coding ?? []).map(c => c.display)].filter(Boolean).join(' ')
      if (
        obs.data.valueQuantity?.value !== undefined
        && (codes.has('1100301A') || codes.has('4548-4') || codes.has('17856-6') || /糖化血红蛋白|HbA1c/i.test(text))
      ) {
        hba1c = {
          sourceReference: `Observation/${obs.data.id}`,
          valueText: `${obs.data.valueQuantity.value}${obs.data.valueQuantity.unit ?? '%'}`,
          versionId: obs.data.meta?.versionId ?? '1',
        }
        break
      }
    }
  }

  let angiographySummary: SupplementaryClinicalIndicators['angiographySummary']
  let pciPlanSummary: SupplementaryClinicalIndicators['pciPlanSummary']
  if (inpatient !== undefined) {
    const reports = inpatient.service.angiography.reports(inpatient.actor, caseId)
    const latest = reports.find(item => item.status === 'final' || item.status === 'partial')
    if (latest !== undefined && latest.vessels.length > 0) {
      const { missingFfrMessages, summaryText } = summarizeCoronaryAngiographyVessels(latest.vessels)
      angiographySummary = {
        missingFfrMessages,
        sourceReference: `Procedure/${latest.procedureId}`,
        summaryText,
        versionId: String(latest.version),
      }
    }
    const pciRequest = inpatient.service.surgery.read(inpatient.actor, caseId).requests
      .find(item => item.status !== 'cancelled' && pciSelectionProcedureCodes.includes(item.plannedProcedure.coding.code))
    if (pciRequest !== undefined) {
      const selection = inpatient.service.pciSelection.read(inpatient.actor, caseId, pciRequest.id)
      const parameters = selection.drafts?.find(item => item.requestId === pciRequest.id)?.parameters
        ?? (selection.confirmation?.parameters.requestId === pciRequest.id ? selection.confirmation.parameters : undefined)
      const measurements = parameters?.measurements ?? []
      const hasValidCandidate = selection.candidates.some(item => item.eligibility === 'valid')
      pciPlanSummary = {
        hasValidCandidate,
        missingItems: collectPciSelectionMissingItems({
          hasValidCandidate,
          measurements,
          targetSite: parameters?.targetSite,
        }),
        sourceReference: `ServiceRequest/${pciRequest.id}`,
        targetSite: parameters?.targetSite ?? null,
        versionId: String(pciRequest.version),
      }
    }
  }

  return {
    angiographySummary,
    ecgSummary,
    hba1c,
    pciPlanSummary,
    tteLvef,
  }
}

export function buildSynchronousTopicBundle(options: {
  caseId: string
  context: RepositoryContext
  corpus?: GuidelineCorpus | undefined
  database: ClinMeshDatabase
  encounterId: string
  evaluatedAt: string
  fhir: FhirRepository
  inpatient?: { actor: ActorContext; service: InpatientService } | undefined
  patientBirthDate: string | undefined
  populationReferenceIso: string
  scores: ClinicalScoreBundle
  topicId?: GuidelineTopicId | undefined
}): GuidelineTopicBundle {
  const population = resolvePatientGuidelinePopulation(options.patientBirthDate, options.populationReferenceIso)
  const supplementary = extractSupplementaryIndicators({
    caseId: options.caseId,
    context: options.context,
    database: options.database,
    fhir: options.fhir,
    inpatient: options.inpatient,
  })
  const targetTopicIds = options.topicId === undefined ? guidelineTopicIds : [options.topicId]
  return {
    encounterId: options.encounterId,
    evaluatedAt: options.evaluatedAt,
    items: targetTopicIds.map(topicId => buildGuidelineTopicRead({
      corpus: options.corpus,
      population,
      scores: options.scores,
      supplementary,
      topicId,
    })),
  }
}
