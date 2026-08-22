// Throwaway prototype state for comparing DSH/HIS assistant integration layouts.

export type AssistantVariant = 'A' | 'B' | 'C'
export type ClinicalPage = 'record' | 'orders' | 'results'
export type ProposalKind = 'first-visit' | 'revisit'
export type ProposalStatus = 'ready' | 'applied' | 'stale' | 'submitted'
export type StepStatus = 'completed' | 'waiting-human' | 'rejected'
export type DraftField = 'history' | 'physicalExam' | 'assessment'

export interface ResultRow {
  name: string
  value: string
  reference: string
  flag: 'normal' | 'high'
}

export type TypedAction =
  | {
      id: string
      kind: 'navigate'
      label: string
      page: ClinicalPage
      risk: 'R0'
    }
  | {
      id: string
      kind: 'focusPanel'
      label: string
      panel: 'clinical-note' | 'orders' | 'results'
      risk: 'R0'
    }
  | {
      id: string
      kind: 'setDraftField'
      label: string
      field: DraftField
      value: string
      risk: 'R1'
    }
  | {
      id: string
      kind: 'proposeCommand'
      label: string
      command: 'order.create_draft'
      items: readonly string[]
      risk: 'R1'
    }
  | {
      id: string
      kind: 'proposeCommand'
      label: string
      command: 'outpatient.add_diagnosis'
      diagnosis: string
      risk: 'R1'
    }
  | {
      id: string
      kind: 'proposeCommand'
      label: string
      command: 'prescription.create_draft'
      medication: string
      risk: 'R1'
    }

export interface AssistantProposal {
  id: string
  kind: ProposalKind
  title: string
  summary: string
  expectedPageRevision: number
  expectedDraftRevision: number
  expectedContextRevision: number
  status: ProposalStatus
  actions: readonly TypedAction[]
}

export interface DshStep {
  id: string
  label: string
  detail: string
  status: StepStatus
  command: string | null
}

export interface AssistantTurn {
  id: string
  prompt: string
  response: string
  time: string
  steps: readonly DshStep[]
}

export interface ContextConflict {
  kind: 'page-version' | 'draft-version' | 'page-context'
  expected: number
  actual: number
}

export interface ClinicalNoteDraft {
  chiefComplaint: string
  history: string
  physicalExam: string
  assessment: string
}

export interface PatientCase {
  id: string
  encounterId: string
  queueNumber: string
  name: string
  gender: string
  age: number
  waitMinutes: number
  allergy: string
  vitalSigns: string
  statusLabel: string
  threadId: string
  sessionId: string
  contextBindingId: string
  page: ClinicalPage
  pageRevision: number
  draftRevision: number
  contextRevision: number
  note: ClinicalNoteDraft
  historySupplement: string
  suggestedLabs: readonly string[]
  results: readonly ResultRow[]
  candidateDiagnosis: string
  candidateMedication: string
  labOrders: readonly string[]
  labOrderStatus: 'none' | 'draft' | 'signed'
  resultsReady: boolean
  diagnosis: string
  medication: string
  treatmentStatus: 'none' | 'draft' | 'signed'
  turns: readonly AssistantTurn[]
  proposal: AssistantProposal | null
  lastConflict: ContextConflict | null
}

export interface ApplyProposalResult {
  patient: PatientCase
  outcome: 'applied' | 'stale' | 'missing'
}

export interface SubmitDraftResult {
  patient: PatientCase
  outcome: 'submitted' | 'stale' | 'missing'
}

export interface ReviewSnapshot {
  patientId: string
  kind: 'lab-order' | 'treatment'
  expectedPageRevision: number
  expectedDraftRevision: number
  planHash: string
}

const initialPatients: readonly PatientCase[] = [
  {
    id: 'SYN-P-1042',
    encounterId: 'ENC-MZ-0017',
    queueNumber: 'MZ0017',
    name: '林若溪',
    gender: '女',
    age: 34,
    waitMinutes: 12,
    allergy: '否认药物过敏',
    vitalSigns: 'T 38.6 °C · P 96 · BP 118/76',
    statusLabel: '初诊患者',
    threadId: 'thread-opd-0017',
    sessionId: 'ses-dsh-8F21',
    contextBindingId: 'ctx-0017-v3',
    page: 'record',
    pageRevision: 7,
    draftRevision: 2,
    contextRevision: 1,
    note: {
      chiefComplaint: '发热、咽痛 1 天。',
      history: '昨日傍晚开始发热，最高 38.7 °C，伴咽痛。',
      physicalExam: 'T 38.6 °C，咽部充血，双肺呼吸音清。',
      assessment: '发热待查。',
    },
    historySupplement: '无明显胸闷、气促，近期未自行服用抗菌药物。',
    suggestedLabs: ['血常规（五分类）', 'C 反应蛋白'],
    results: [
      { name: '白细胞计数', value: '11.2 ×10⁹/L', reference: '3.5–9.5', flag: 'high' },
      { name: 'C 反应蛋白', value: '28.6 mg/L', reference: '0–10', flag: 'high' },
    ],
    candidateDiagnosis: '急性上呼吸道感染',
    candidateMedication: '对乙酰氨基酚片 0.5 g，发热时口服',
    labOrders: [],
    labOrderStatus: 'none',
    resultsReady: false,
    diagnosis: '',
    medication: '',
    treatmentStatus: 'none',
    turns: [],
    proposal: null,
    lastConflict: null,
  },
  {
    id: 'SYN-P-1168',
    encounterId: 'ENC-MZ-0021',
    queueNumber: 'MZ0021',
    name: '赵川',
    gender: '男',
    age: 52,
    waitMinutes: 8,
    allergy: '青霉素皮疹史',
    vitalSigns: 'T 36.7 °C · P 82 · BP 136/84',
    statusLabel: '初诊患者',
    threadId: 'thread-opd-0021',
    sessionId: 'ses-dsh-8F35',
    contextBindingId: 'ctx-0021-v1',
    page: 'record',
    pageRevision: 3,
    draftRevision: 1,
    contextRevision: 1,
    note: {
      chiefComplaint: '口渴、乏力 2 个月。',
      history: '近两个月饮水量和夜尿增多，体重下降约 3 kg。',
      physicalExam: '神清，心肺查体未见明显异常。',
      assessment: '多饮、多尿待查。',
    },
    historySupplement: '无意识障碍、视物模糊，既往未接受降糖治疗。',
    suggestedLabs: ['空腹血糖', '糖化血红蛋白'],
    results: [
      { name: '空腹血糖', value: '9.8 mmol/L', reference: '3.9–6.1', flag: 'high' },
      { name: '糖化血红蛋白', value: '8.2%', reference: '4.0–6.5', flag: 'high' },
    ],
    candidateDiagnosis: '2 型糖尿病',
    candidateMedication: '二甲双胍片 0.5 g，每日 2 次，餐后口服',
    labOrders: [],
    labOrderStatus: 'none',
    resultsReady: false,
    diagnosis: '',
    medication: '',
    treatmentStatus: 'none',
    turns: [],
    proposal: null,
    lastConflict: null,
  },
  {
    id: 'SYN-P-1214',
    encounterId: 'ENC-MZ-0024',
    queueNumber: 'MZ0024',
    name: '顾宁',
    gender: '女',
    age: 41,
    waitMinutes: 3,
    allergy: '否认药物过敏',
    vitalSigns: 'T 37.8 °C · P 88 · BP 112/72',
    statusLabel: '初诊患者',
    threadId: 'thread-opd-0024',
    sessionId: 'ses-dsh-8F42',
    contextBindingId: 'ctx-0024-v2',
    page: 'record',
    pageRevision: 4,
    draftRevision: 1,
    contextRevision: 1,
    note: {
      chiefComplaint: '咳嗽、低热 4 天。',
      history: '干咳为主，夜间明显，无胸痛及呼吸困难。',
      physicalExam: '右下肺呼吸音稍低，未闻及明显湿啰音。',
      assessment: '咳嗽待查。',
    },
    historySupplement: '无胸痛、气促，近期未自行服用抗菌药物。',
    suggestedLabs: ['血常规（五分类）', '肺炎支原体核酸'],
    results: [
      { name: '白细胞计数', value: '8.9 ×10⁹/L', reference: '3.5–9.5', flag: 'normal' },
      { name: '肺炎支原体核酸', value: '阳性', reference: '阴性', flag: 'high' },
    ],
    candidateDiagnosis: '肺炎支原体感染',
    candidateMedication: '阿奇霉素片 0.5 g，每日 1 次，口服',
    labOrders: [],
    labOrderStatus: 'none',
    resultsReady: false,
    diagnosis: '',
    medication: '',
    treatmentStatus: 'none',
    turns: [],
    proposal: null,
    lastConflict: null,
  },
] as const

const pageLabels: Record<ClinicalPage, string> = {
  record: '门诊病历',
  orders: '医嘱',
  results: '检验结果',
}

function clonePatient(patient: PatientCase): PatientCase {
  return {
    ...patient,
    note: { ...patient.note },
    labOrders: [...patient.labOrders],
    turns: patient.turns.map((turn) => ({ ...turn, steps: [...turn.steps] })),
    proposal: patient.proposal === null ? null : { ...patient.proposal, actions: [...patient.proposal.actions] },
  }
}

export function createInitialPatients(): PatientCase[] {
  return initialPatients.map(clonePatient)
}

export function resetPatient(patientId: string): PatientCase {
  const patient = initialPatients.find((candidate) => candidate.id === patientId) ?? initialPatients[0]!
  return clonePatient(patient)
}

export function assistantVariantFromUrl(): AssistantVariant {
  const candidate = new URLSearchParams(window.location.search).get('variant')?.toUpperCase()
  return candidate === 'B' || candidate === 'C' ? candidate : 'A'
}

export function pageLabel(page: ClinicalPage): string {
  return pageLabels[page]
}

function nextTurnNumber(patient: PatientCase): number {
  return patient.turns.length + 1
}

function makeSteps(patient: PatientCase, turnNumber: number): readonly DshStep[] {
  return [
    {
      id: `step-${turnNumber}-1`,
      label: '捕获受信页面上下文',
      detail: `${pageLabels[patient.page]} · ${patient.encounterId} · page v${patient.pageRevision}`,
      status: 'completed',
      command: 'his context current --json',
    },
    {
      id: `step-${turnNumber}-2`,
      label: '读取本次就诊摘要',
      detail: `${patient.name} · ${patient.contextBindingId} · 最小必要字段`,
      status: 'completed',
      command: `his encounter summary --binding ${patient.contextBindingId}`,
    },
    {
      id: `step-${turnNumber}-3`,
      label: '生成结构化页面动作',
      detail: '仅允许 navigate、focusPanel、setDraftField 与 proposeCommand',
      status: 'completed',
      command: null,
    },
    {
      id: `step-${turnNumber}-4`,
      label: '等待医生处理建议',
      detail: '助手只能改草稿和请求预览，不能签发',
      status: 'waiting-human',
      command: null,
    },
  ]
}

function firstVisitProposal(patient: PatientCase, turnNumber: number): AssistantProposal {
  const prefix = `proposal-${patient.queueNumber}-${turnNumber}`
  const history = patient.note.history.includes(patient.historySupplement)
    ? patient.note.history
    : `${patient.note.history} ${patient.historySupplement}`
  return {
    id: prefix,
    kind: 'first-visit',
    title: '首诊病历与检验草稿',
    summary: `补全现病史和初步判断，并创建 ${patient.suggestedLabs.length} 项检验草稿。`,
    expectedPageRevision: patient.pageRevision,
    expectedDraftRevision: patient.draftRevision,
    expectedContextRevision: patient.contextRevision,
    status: 'ready',
    actions: [
      { id: `${prefix}-1`, kind: 'focusPanel', panel: 'clinical-note', label: '定位门诊病历', risk: 'R0' },
      {
        id: `${prefix}-2`,
        kind: 'setDraftField',
        field: 'history',
        label: '补全现病史草稿',
        value: history,
        risk: 'R1',
      },
      {
        id: `${prefix}-3`,
        kind: 'setDraftField',
        field: 'assessment',
        label: '更新初步判断',
        value: `${patient.note.assessment} 建议结合检验结果进一步判断。`,
        risk: 'R1',
      },
      {
        id: `${prefix}-4`,
        kind: 'proposeCommand',
        command: 'order.create_draft',
        items: patient.suggestedLabs,
        label: `创建 ${patient.suggestedLabs.length} 项检验草稿`,
        risk: 'R1',
      },
      { id: `${prefix}-5`, kind: 'navigate', page: 'orders', label: '打开医嘱页核对', risk: 'R0' },
    ],
  }
}

function revisitProposal(patient: PatientCase, turnNumber: number): AssistantProposal {
  const prefix = `proposal-${patient.queueNumber}-${turnNumber}`
  return {
    id: prefix,
    kind: 'revisit',
    title: '复诊诊断与处方草稿',
    summary: `基于已发布结果，提出“${patient.candidateDiagnosis}”及一条用药草稿。`,
    expectedPageRevision: patient.pageRevision,
    expectedDraftRevision: patient.draftRevision,
    expectedContextRevision: patient.contextRevision,
    status: 'ready',
    actions: [
      { id: `${prefix}-1`, kind: 'focusPanel', panel: 'results', label: '定位检验结果', risk: 'R0' },
      {
        id: `${prefix}-2`,
        kind: 'setDraftField',
        field: 'assessment',
        label: '补充结果解释',
        value: `检验结果支持${patient.candidateDiagnosis}，结合症状与查体拟作门诊处置。`,
        risk: 'R1',
      },
      {
        id: `${prefix}-3`,
        kind: 'proposeCommand',
        command: 'outpatient.add_diagnosis',
        diagnosis: patient.candidateDiagnosis,
        label: `添加诊断草稿：${patient.candidateDiagnosis}`,
        risk: 'R1',
      },
      {
        id: `${prefix}-4`,
        kind: 'proposeCommand',
        command: 'prescription.create_draft',
        medication: patient.candidateMedication,
        label: '创建处方草稿',
        risk: 'R1',
      },
      { id: `${prefix}-5`, kind: 'navigate', page: 'record', label: '返回病历页核对', risk: 'R0' },
    ],
  }
}

export function requestAssistantProposal(
  patient: PatientCase,
  kind: ProposalKind,
  prompt: string,
): PatientCase {
  const turnNumber = nextTurnNumber(patient)
  const proposal = kind === 'revisit' ? revisitProposal(patient, turnNumber) : firstVisitProposal(patient, turnNumber)
  const response = kind === 'revisit'
    ? `已读取 ${patient.results.length} 项已审核结果，并准备诊断与处方草稿。`
    : `已核对当前病历和过敏信息，并准备首诊补充与检验草稿。`

  return {
    ...patient,
    turns: [
      ...patient.turns,
      {
        id: `turn-${turnNumber}`,
        prompt,
        response,
        time: `09:${(28 + turnNumber * 2).toString().padStart(2, '0')}`,
        steps: makeSteps(patient, turnNumber),
      },
    ],
    proposal,
    lastConflict: null,
  }
}

function appendLastTurnStep(patient: PatientCase, step: DshStep): readonly AssistantTurn[] {
  const turns = [...patient.turns]
  const last = turns.at(-1)
  if (last === undefined) return turns
  turns[turns.length - 1] = { ...last, steps: [...last.steps, step] }
  return turns
}

function conflictFor(patient: PatientCase, proposal: AssistantProposal): ContextConflict | null {
  if (proposal.expectedPageRevision !== patient.pageRevision) {
    return { kind: 'page-version', expected: proposal.expectedPageRevision, actual: patient.pageRevision }
  }
  if (proposal.expectedDraftRevision !== patient.draftRevision) {
    return { kind: 'draft-version', expected: proposal.expectedDraftRevision, actual: patient.draftRevision }
  }
  if (proposal.expectedContextRevision !== patient.contextRevision) {
    return { kind: 'page-context', expected: proposal.expectedContextRevision, actual: patient.contextRevision }
  }
  return null
}

export function applyAssistantProposal(patient: PatientCase): ApplyProposalResult {
  const proposal = patient.proposal
  if (proposal === null || proposal.status !== 'ready') return { patient, outcome: 'missing' }

  const conflict = conflictFor(patient, proposal)
  if (conflict !== null) {
    return {
      outcome: 'stale',
      patient: {
        ...patient,
        proposal: { ...proposal, status: 'stale' },
        lastConflict: conflict,
        turns: appendLastTurnStep(patient, {
          id: `step-${patient.turns.length}-guard`,
          label: '版本守卫拒绝过期动作',
          detail: `expected ${conflict.expected}，actual ${conflict.actual}`,
          status: 'rejected',
          command: 'his draft apply --expected-version',
        }),
      },
    }
  }

  let note = { ...patient.note }
  let page = patient.page
  let labOrders = [...patient.labOrders]
  let labOrderStatus = patient.labOrderStatus
  let diagnosis = patient.diagnosis
  let medication = patient.medication
  let treatmentStatus = patient.treatmentStatus

  for (const action of proposal.actions) {
    if (action.kind === 'setDraftField') note = { ...note, [action.field]: action.value }
    if (action.kind === 'navigate') page = action.page
    if (action.kind === 'proposeCommand' && action.command === 'order.create_draft') {
      labOrders = [...action.items]
      labOrderStatus = 'draft'
    }
    if (action.kind === 'proposeCommand' && action.command === 'outpatient.add_diagnosis') {
      diagnosis = action.diagnosis
      treatmentStatus = 'draft'
    }
    if (action.kind === 'proposeCommand' && action.command === 'prescription.create_draft') {
      medication = action.medication
      treatmentStatus = 'draft'
    }
  }

  const contextChanged = page !== patient.page
  return {
    outcome: 'applied',
    patient: {
      ...patient,
      page,
      contextRevision: contextChanged ? patient.contextRevision + 1 : patient.contextRevision,
      draftRevision: patient.draftRevision + 1,
      note,
      labOrders,
      labOrderStatus,
      diagnosis,
      medication,
      treatmentStatus,
      proposal: { ...proposal, status: 'applied' },
      lastConflict: null,
      turns: appendLastTurnStep(patient, {
        id: `step-${patient.turns.length}-apply`,
        label: '结构化动作已写入草稿',
        detail: `${proposal.actions.length} 项动作 · draft r${patient.draftRevision + 1}`,
        status: 'completed',
        command: 'his draft apply --scope current-encounter',
      }),
    },
  }
}

export function navigateFromAssistant(patient: PatientCase, page: ClinicalPage, prompt: string): PatientCase {
  const turnNumber = nextTurnNumber(patient)
  return {
    ...patient,
    page,
    contextRevision: patient.contextRevision + 1,
    turns: [
      ...patient.turns,
      {
        id: `turn-${turnNumber}`,
        prompt,
        response: `已通过受信页面动作打开${pageLabels[page]}。`,
        time: `09:${(28 + turnNumber * 2).toString().padStart(2, '0')}`,
        steps: [
          {
            id: `step-${turnNumber}-1`,
            label: '校验页面动作范围',
            detail: `${patient.contextBindingId} 允许访问 ${pageLabels[page]}`,
            status: 'completed',
            command: 'his ui action validate --type navigate',
          },
          {
            id: `step-${turnNumber}-2`,
            label: '执行 typed navigate',
            detail: `doctor.${page} · 无 DOM selector 或脚本`,
            status: 'completed',
            command: `his ui navigate --page doctor.${page}`,
          },
        ],
      },
    ],
    proposal: null,
    lastConflict: null,
  }
}

export function updateDraftField(patient: PatientCase, field: DraftField | 'chiefComplaint', value: string): PatientCase {
  return {
    ...patient,
    draftRevision: patient.draftRevision + 1,
    note: { ...patient.note, [field]: value },
    lastConflict: null,
  }
}

export function selectClinicalPage(patient: PatientCase, page: ClinicalPage): PatientCase {
  if (page === patient.page) return patient
  return {
    ...patient,
    page,
    contextRevision: patient.contextRevision + 1,
  }
}

export function simulateRemoteUpdate(patient: PatientCase): PatientCase {
  return {
    ...patient,
    pageRevision: patient.pageRevision + 1,
    note: {
      ...patient.note,
      physicalExam: `${patient.note.physicalExam} 护士工作站补记：SpO₂ 98%。`,
    },
  }
}

export function publishSyntheticResults(patient: PatientCase): PatientCase {
  if (patient.labOrderStatus !== 'signed') return patient
  return {
    ...patient,
    resultsReady: true,
    page: 'results',
    pageRevision: patient.pageRevision + 1,
    contextRevision: patient.contextRevision + 1,
    statusLabel: '结果已回，待复诊',
    proposal: null,
    lastConflict: null,
  }
}

export function createReviewSnapshot(patient: PatientCase): ReviewSnapshot | null {
  const kind = patient.treatmentStatus === 'draft'
    ? 'treatment'
    : patient.labOrderStatus === 'draft'
      ? 'lab-order'
      : null
  if (kind === null) return null
  return {
    patientId: patient.id,
    kind,
    expectedPageRevision: patient.pageRevision,
    expectedDraftRevision: patient.draftRevision,
    planHash: `plan-${patient.queueNumber.toLowerCase()}-${patient.pageRevision}-${patient.draftRevision}`,
  }
}

export function submitReviewedDraft(patient: PatientCase, review: ReviewSnapshot): SubmitDraftResult {
  if (review.patientId !== patient.id) return { patient, outcome: 'missing' }
  const pageConflict = review.expectedPageRevision !== patient.pageRevision
  const draftConflict = review.expectedDraftRevision !== patient.draftRevision
  if (pageConflict || draftConflict) {
    const conflict: ContextConflict = pageConflict
      ? { kind: 'page-version', expected: review.expectedPageRevision, actual: patient.pageRevision }
      : { kind: 'draft-version', expected: review.expectedDraftRevision, actual: patient.draftRevision }
    return { patient: { ...patient, lastConflict: conflict }, outcome: 'stale' }
  }

  const isLabOrder = review.kind === 'lab-order' && patient.labOrderStatus === 'draft'
  const isTreatment = review.kind === 'treatment' && patient.treatmentStatus === 'draft'
  if (!isLabOrder && !isTreatment) return { patient, outcome: 'missing' }

  const proposal = patient.proposal
  return {
    outcome: 'submitted',
    patient: {
      ...patient,
      pageRevision: patient.pageRevision + 1,
      labOrderStatus: isLabOrder ? 'signed' : patient.labOrderStatus,
      treatmentStatus: isTreatment ? 'signed' : patient.treatmentStatus,
      statusLabel: isTreatment ? '诊疗完成' : '检验已签发',
      proposal: proposal === null ? null : { ...proposal, status: 'submitted' },
      lastConflict: null,
      turns: appendLastTurnStep(patient, {
        id: `step-${patient.turns.length}-submit`,
        label: 'HIS 返回人工提交结果',
        detail: `${review.planHash} · page v${patient.pageRevision + 1}`,
        status: 'completed',
        command: null,
      }),
    },
  }
}

export function proposalKindForPrompt(patient: PatientCase, prompt: string): ProposalKind {
  const asksForRevisit = /结果|诊断|复诊|处方|开药/.test(prompt)
  return patient.resultsReady && asksForRevisit ? 'revisit' : 'first-visit'
}

export function conflictLabel(conflict: ContextConflict): string {
  if (conflict.kind === 'page-version') return '患者数据版本已变化'
  if (conflict.kind === 'draft-version') return '医生草稿已变化'
  return '当前页面上下文已变化'
}
