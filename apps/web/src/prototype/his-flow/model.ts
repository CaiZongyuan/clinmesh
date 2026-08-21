export type PrototypeVariant = 'A' | 'B' | 'C'

export type PrototypeScreen =
  | 'login'
  | 'roles'
  | 'flow'
  | 'registration'
  | 'triage'
  | 'doctor'
  | 'billing'
  | 'lis'
  | 'pharmacy'
  | 'simulation'
  | 'data'

export type FlowStep =
  | 'waiting-registration'
  | 'registered'
  | 'triaged'
  | 'lab-ordered'
  | 'lab-paid'
  | 'specimen-received'
  | 'result-ready'
  | 'medication-ordered'
  | 'medication-paid'
  | 'dispensed'
  | 'finished'

export type DatasetKind = 'golden' | 'density'
export type LisMode = 'normal' | 'delayed' | 'rejected'

export interface Actor {
  id: string
  initials: string
  name: string
  role: string
  location: string
  screen: PrototypeScreen
}

export interface ScenarioEvent {
  id: number
  time: string
  actor: string
  action: string
}

export interface ScenarioConflict {
  expectedVersion: number
  actualVersion: number
}

export interface ScenarioState {
  epoch: number
  version: number
  clockMinutes: number
  dataset: DatasetKind
  lisMode: LisMode
  step: FlowStep
  triageLevel: 'III' | 'IV'
  events: ScenarioEvent[]
  lastConflict: ScenarioConflict | null
}

export interface FlowStage {
  id: string
  label: string
  owner: string
  screen: PrototypeScreen
  description: string
}

export const actors: readonly Actor[] = [
  {
    id: 'registrar',
    initials: '陈',
    name: '陈序',
    role: '门诊挂号员',
    location: '门诊一楼挂号处',
    screen: 'registration',
  },
  {
    id: 'triage-nurse',
    initials: '孙',
    name: '孙宁',
    role: '分诊护士',
    location: '内科分诊台',
    screen: 'triage',
  },
  {
    id: 'doctor',
    initials: '周',
    name: '周芮',
    role: '内科门诊医师',
    location: '内科 3 诊室',
    screen: 'doctor',
  },
  {
    id: 'cashier',
    initials: '林',
    name: '林桐',
    role: '门诊收费员',
    location: '门诊收费 2 号窗',
    screen: 'billing',
  },
  {
    id: 'lis',
    initials: 'L',
    name: 'LIS-01',
    role: '检验接口模拟器',
    location: '检验科接口',
    screen: 'lis',
  },
  {
    id: 'pharmacist',
    initials: '赵',
    name: '赵禾',
    role: '门诊药师',
    location: '门诊药房 1 号窗',
    screen: 'pharmacy',
  },
  {
    id: 'sim-admin',
    initials: '唐',
    name: '唐澄',
    role: '仿真管理员',
    location: '仿真控制台',
    screen: 'simulation',
  },
] as const

export const flowStages: readonly FlowStage[] = [
  {
    id: 'registration',
    label: '挂号',
    owner: '挂号员',
    screen: 'registration',
    description: '确认患者与号源，创建门诊就诊。',
  },
  {
    id: 'triage',
    label: '分诊',
    owner: '分诊护士',
    screen: 'triage',
    description: '记录生命体征和分级，送入医生队列。',
  },
  {
    id: 'first-visit',
    label: '首诊',
    owner: '医生',
    screen: 'doctor',
    description: '完成问诊并签发检验医嘱。',
  },
  {
    id: 'lab-payment',
    label: '检验缴费',
    owner: '收费员',
    screen: 'billing',
    description: '收取检验费用，医嘱才可执行。',
  },
  {
    id: 'lab',
    label: '检验',
    owner: '模拟 LIS',
    screen: 'lis',
    description: '接收标本、生成并发布检验结果。',
  },
  {
    id: 'revisit',
    label: '复诊',
    owner: '医生',
    screen: 'doctor',
    description: '查看结果、确认诊断并签发处方。',
  },
  {
    id: 'medication-payment',
    label: '药品缴费',
    owner: '收费员',
    screen: 'billing',
    description: '结算处方费用，生成可发药任务。',
  },
  {
    id: 'dispense',
    label: '发药',
    owner: '药师',
    screen: 'pharmacy',
    description: '核对处方、批次和数量后发药。',
  },
  {
    id: 'finish',
    label: '完诊',
    owner: '医生',
    screen: 'doctor',
    description: '确认本次诊疗完成并关闭就诊。',
  },
] as const

export const screenTitles: Record<PrototypeScreen, string> = {
  login: '账号登录',
  roles: '岗位选择',
  flow: '全院流程',
  registration: '挂号工作台',
  triage: '分诊工作台',
  doctor: '医生工作台',
  billing: '收费工作台',
  lis: '模拟 LIS',
  pharmacy: '药房工作台',
  simulation: '仿真控制',
  data: '数据包',
}

export const stepRank: Record<FlowStep, number> = {
  'waiting-registration': -1,
  registered: 0,
  triaged: 1,
  'lab-ordered': 2,
  'lab-paid': 3,
  'specimen-received': 4,
  'result-ready': 4,
  'medication-ordered': 5,
  'medication-paid': 6,
  dispensed: 7,
  finished: 8,
}

export const stepLabels: Record<FlowStep, string> = {
  'waiting-registration': '待挂号',
  registered: '已挂号，待分诊',
  triaged: '已分诊，待首诊',
  'lab-ordered': '检验医嘱待缴费',
  'lab-paid': '检验已缴费，待采样',
  'specimen-received': '标本处理中',
  'result-ready': '结果已发布，待复诊',
  'medication-ordered': '处方待缴费',
  'medication-paid': '药品已缴费，待发药',
  dispensed: '已发药，待完诊',
  finished: '本次就诊已完成',
}

export const nextAssignments: Record<FlowStep, { actorId: string; screen: PrototypeScreen; label: string }> = {
  'waiting-registration': { actorId: 'registrar', screen: 'registration', label: '挂号员确认患者与号源' },
  registered: { actorId: 'triage-nurse', screen: 'triage', label: '分诊护士录入生命体征' },
  triaged: { actorId: 'doctor', screen: 'doctor', label: '医生完成首诊并开检验' },
  'lab-ordered': { actorId: 'cashier', screen: 'billing', label: '收费员收取检验费用' },
  'lab-paid': { actorId: 'lis', screen: 'lis', label: '检验科接收标本' },
  'specimen-received': { actorId: 'lis', screen: 'lis', label: 'LIS 发布检验结果' },
  'result-ready': { actorId: 'doctor', screen: 'doctor', label: '医生查看结果并开药' },
  'medication-ordered': { actorId: 'cashier', screen: 'billing', label: '收费员收取药品费用' },
  'medication-paid': { actorId: 'pharmacist', screen: 'pharmacy', label: '药师核对并发药' },
  dispensed: { actorId: 'doctor', screen: 'doctor', label: '医生确认完诊' },
  finished: { actorId: 'doctor', screen: 'flow', label: '流程结束，可重置场景' },
}

export function createInitialScenario(epoch = 14): ScenarioState {
  return {
    epoch,
    version: 1,
    clockMinutes: 9 * 60 + 12,
    dataset: 'golden',
    lisMode: 'normal',
    step: 'waiting-registration',
    triageLevel: 'IV',
    lastConflict: null,
    events: [
      {
        id: 1,
        time: '09:12',
        actor: 'Scenario compiler',
        action: '加载 outpatient-fever-001 场景',
      },
    ],
  }
}

export function formatVirtualTime(clockMinutes: number): string {
  const hours = Math.floor(clockMinutes / 60) % 24
  const minutes = clockMinutes % 60
  return `2026-08-21 ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
}

export function variantFromUrl(): PrototypeVariant {
  const candidate = new URLSearchParams(window.location.search).get('variant')?.toUpperCase()
  return candidate === 'B' || candidate === 'C' ? candidate : 'A'
}

export function screenFromUrl(): PrototypeScreen {
  const candidate = new URLSearchParams(window.location.search).get('page')
  return candidate !== null && candidate in screenTitles ? (candidate as PrototypeScreen) : 'login'
}
