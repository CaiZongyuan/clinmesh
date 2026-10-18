import { guidelineEvidenceSchema, type GuidelineEvidence } from '@clinmesh/contracts/doctor-recommendations'

export const doctorGuidelineRevision = 'official-clauses-2026-10-13-v2'

const influenza = {
  title: '流行性感冒诊疗方案（2025 年版）',
  publisher: '国家卫生健康委办公厅、国家中医药局综合司',
  documentType: 'official-protocol' as const,
  version: '2025', publishedAt: '2025-01-20',
  scope: '各级医疗机构的流感诊疗；需结合流行病学、临床表现和病原学资料，不能用于所有发热病例的确诊。',
  url: 'https://www.nhc.gov.cn/ylyjs/zcwj/202501/f8fcecca59a048bebc4a71847ce57594/files/1741764832851_94226.pdf',
  sourceHash: 'd19f8cba72af08fd11fe17c0d6c3614c9aaac8d8c77fa803e7e9b999abea1125',
}
const hypertension = {
  title: 'WS/T 872—2025 基层医疗卫生机构高血压防治管理标准',
  publisher: '国家卫生健康委员会', documentType: 'health-standard' as const,
  version: 'WS/T 872—2025', publishedAt: '2025-09-19', effectiveAt: '2026-03-01',
  scope: '基层医疗卫生机构成人高血压管理；首次评估与后续随访需分别核对，不能从本标准推导具体药品剂量或固定疗程。',
  url: 'https://www.nhc.gov.cn/fzs/c100048/202509/2f3f7cce449145f8b361e70b3ed4ae9a/files/WS%20T%20872%E2%80%942025-20250930105429913.pdf',
  sourceHash: '4c099a4a656b72d6524c7acd05359da10b4dd861def402b80acd94a307d410d6',
}
const breast = {
  title: '乳腺癌诊疗指南（2022 年版）', publisher: '国家卫生健康委员会',
  documentType: 'guideline' as const, version: '2022',
  scope: '乳腺癌诊疗；需实际病理与病例依据，既往乳腺手术本身不证明需要病理会诊。',
  url: 'https://www.nhc.gov.cn/yzygj/c100068/202204/0c1f7d3aca0545abbeb02030ce255930/files/1732863054702_65919.pdf',
  sourceHash: '9d3b51f20abe6b80fa2f6273d371c36e14554bfecceb84a274ffe60195c8ffae',
}
const amlodipine = {
  title: '苯磺酸氨氯地平片（络活喜）说明书', publisher: '晖致制药（大连）有限公司',
  documentType: 'product-information' as const, version: '2026-10-13 核验版本',
  scope: '成人高血压用药；需核对既有方案、年龄、体型、虚弱与肝功能。本院合成药品并非本说明书的具体产品，不能套用包装，也无固定 30 天疗程或 30 片数量依据。',
  url: 'https://www.viatris.cn/-/media/project/viatris-sites/product-document/02norvasc.pdf',
  sourceHash: '6421355efdba7552efc1d814295f8dcff186dfbb44805af6d78c6673199e5689',
}

export const doctorGuidelineSourceIds: ReadonlyMap<string, string> = new Map([
  [influenza.sourceHash, 'nhc-influenza-2025'],
  [hypertension.sourceHash, 'nhc-hypertension-wst-872-2025'],
  [breast.sourceHash, 'nhc-breast-cancer-2022'],
])

export const doctorGuidelineGroups: ReadonlyArray<{ terms: readonly string[]; evidence: readonly GuidelineEvidence[] }> = [
  { terms: ['流感', '发热', '咳嗽', 'influenza', 'fever', 'cough'], evidence: [
    { ...influenza, id: 'nhc-influenza-2025-diagnosis', locator: '第六节“诊断”，印刷第 5 页',
      text: '主要结合流行病学史、临床表现和病原学检查进行诊断。' },
    { ...influenza, id: 'nhc-influenza-2025-antigen', locator: '第五节“病原学相关检查”，印刷第 5 页',
      text: '抗原检测阳性支持诊断，阴性不能排除流感。' },
    { ...influenza, id: 'nhc-influenza-2025-antimicrobial', locator: '第十节“治疗”，印刷第 9 页',
      text: '避免盲目或不恰当使用抗菌药物。' },
  ].map(item => guidelineEvidenceSchema.parse(item)) },
  { terms: ['高血压', 'hypertension', 'I10'], evidence: [
    { ...hypertension, id: 'ws-t-872-2025-initial-assessment', locator: '第 7 节，印刷第 2 页',
      text: '符合高血压诊断的患者，应进行首次评估，询问病史、进行体格检查和血尿常规、生化及心电图检测。' },
    { ...hypertension, id: 'ws-t-872-2025-treatment', locator: '第 8.2 节，印刷第 3 页',
      text: '在生活方式干预的基础上，根据患者个体情况合理选择降压药物，逐步调定' },
    { ...amlodipine, id: 'viatris-norvasc-adult-hypertension-dose', locator: '“用法用量—成人”，印刷第 3 页',
      text: '通常本品治疗高血压的起始剂量为5 mg，每日一次，最大剂量为10 mg，每日一次。\n身材小、虚弱、老年、或伴肝功能不全患者，起始剂量为2.5 mg，每日一次；此剂量也可为本品联合其它抗高血压药物治疗的剂量。' },
  ].map(item => guidelineEvidenceSchema.parse(item)) },
  { terms: ['乳腺', 'breast'], evidence: [
    { ...breast, id: 'nhc-breast-2022-pathology', locator: '第三节“组织病理学诊断”，印刷第 11 页',
      text: '病理学诊断是乳腺癌确诊和治疗的依据。' },
  ].map(item => guidelineEvidenceSchema.parse(item)) },
]
