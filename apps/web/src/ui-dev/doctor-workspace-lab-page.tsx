import { createAvatar } from '@dicebear/core'
import * as lorelei from '@dicebear/lorelei'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Avatar, AvatarBadge, AvatarFallback, AvatarImage } from '@clinmesh/ui/components/avatar'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@clinmesh/ui/components/input-group'
import { Progress } from '@clinmesh/ui/components/progress'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@clinmesh/ui/components/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@clinmesh/ui/components/tooltip'
import { cn } from '@clinmesh/ui/lib/utils'
import {
  AudioLinesIcon,
  BotIcon,
  CalendarDaysIcon,
  CalendarClockIcon,
  ChartNoAxesCombinedIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleHelpIcon,
  ClipboardClockIcon,
  ClipboardListIcon,
  ClipboardPlusIcon,
  FileCheck2Icon,
  FileTextIcon,
  FlaskConicalIcon,
  HeartPulseIcon,
  HospitalIcon,
  HouseIcon,
  ListFilterIcon,
  MicroscopeIcon,
  PackageCheckIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PillIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  ScanLineIcon,
  SearchIcon,
  SettingsIcon,
  ShieldAlertIcon,
  SparklesIcon,
  StethoscopeIcon,
  SyringeIcon,
  TestTube2Icon,
  TrendingUpIcon,
  UsersIcon,
  WalletCardsIcon,
} from 'lucide-react'
import { useState, type CSSProperties } from 'react'

type MainTab = 'consultation' | 'diagnosis' | 'examination' | 'laboratory' | 'prescription' | 'record'
type PatientStatus = 'checked-in' | 'current' | 'revisit' | 'urgent' | 'waiting'
type StatusFilter = 'all' | PatientStatus

interface Patient {
  age: number
  allergy: string
  chiefComplaint: string
  gender: '女' | '男'
  id: string
  name: string
  patientNumber: string
  room: string
  seed: string
  status: PatientStatus
  statusLabel: string
  time: string
}

const patients = [
  { age: 34, allergy: '青霉素', chiefComplaint: '咳嗽伴发热 3 天', gender: '女', id: 'P10012876', name: '王小雨', patientNumber: '25050600123', room: '诊室 1', seed: 'wang-xiaoyu', status: 'current', statusLabel: '当前就诊', time: '09:15' },
  { age: 28, allergy: '否认药物过敏', chiefComplaint: '咽痛 2 天', gender: '男', id: 'P10012891', name: '李明', patientNumber: '25050600128', room: '诊室 1', seed: 'li-ming', status: 'waiting', statusLabel: '待诊', time: '09:22' },
  { age: 45, allergy: '否认药物过敏', chiefComplaint: '高血压复查及用药咨询', gender: '男', id: 'P10012903', name: '张伟', patientNumber: '25050600131', room: '诊室 1', seed: 'zhang-wei', status: 'revisit', statusLabel: '复诊', time: '09:28' },
  { age: 60, allergy: '头孢类', chiefComplaint: '胸部 CT 后结果咨询', gender: '女', id: 'P10012916', name: '陈思', patientNumber: '25050600136', room: '诊室 1', seed: 'chen-si', status: 'revisit', statusLabel: '检查后复诊', time: '09:35' },
  { age: 38, allergy: '磺胺类', chiefComplaint: '突发腹痛伴恶心 1 天', gender: '男', id: 'P10012928', name: '赵强', patientNumber: '25050600142', room: '诊室 1', seed: 'zhao-qiang', status: 'urgent', statusLabel: '急诊加号', time: '09:40' },
  { age: 26, allergy: '否认药物过敏', chiefComplaint: '月经不规律', gender: '女', id: 'P10012937', name: '刘洋', patientNumber: '25050600147', room: '诊室 1', seed: 'liu-yang', status: 'checked-in', statusLabel: '已签到', time: '09:50' },
  { age: 52, allergy: '否认药物过敏', chiefComplaint: '血糖偏高咨询', gender: '男', id: 'P10012951', name: '周敏', patientNumber: '25050600154', room: '诊室 1', seed: 'zhou-min', status: 'waiting', statusLabel: '待诊', time: '10:00' },
] as const satisfies readonly Patient[]

const firstPatient = patients[0]

const statusFilterItems = [
  { label: '全部状态', value: 'all' },
  { label: '当前就诊', value: 'current' },
  { label: '待诊', value: 'waiting' },
  { label: '复诊', value: 'revisit' },
  { label: '急诊加号', value: 'urgent' },
  { label: '已签到', value: 'checked-in' },
] as const satisfies ReadonlyArray<{ label: string; value: StatusFilter }>

const primaryNav = [
  { icon: HouseIcon, label: '工作台' },
  { active: true, icon: StethoscopeIcon, label: '门诊问诊' },
  { icon: UsersIcon, label: '患者' },
  { icon: FlaskConicalIcon, label: '检查检验' },
  { icon: ClipboardListIcon, label: '处方' },
  { icon: FileTextIcon, label: '病历' },
  { icon: HeartPulseIcon, label: '护理' },
  { icon: WalletCardsIcon, label: '医保结算' },
  { icon: ChartNoAxesCombinedIcon, label: '报表' },
] as const

const secondaryNav = [
  { icon: CircleHelpIcon, label: '帮助' },
  { icon: SettingsIcon, label: '设置' },
] as const

const mainTabs = [
  { id: 'consultation', label: '问诊记录' },
  { id: 'record', label: '病历' },
  { id: 'examination', label: '检查' },
  { id: 'laboratory', label: '检验' },
  { id: 'diagnosis', label: '诊断' },
  { count: 3, id: 'prescription', label: '处方' },
] as const satisfies ReadonlyArray<{ count?: number; id: MainTab; label: string }>

const symptomOptions = [
  { label: '咳嗽', value: 'cough' },
  { label: '咳痰', value: 'sputum' },
  { label: '发热', value: 'fever' },
  { label: '咽痛', value: 'sore-throat' },
  { label: '乏力', value: 'fatigue' },
  { label: '头痛', value: 'headache' },
] as const

const onsetUnitItems = [
  { label: '小时', value: 'hour' },
  { label: '天', value: 'day' },
  { label: '周', value: 'week' },
  { label: '月', value: 'month' },
] as const

const examinationRequests = [
  { department: '放射科', name: '胸部 X 线片（正位）', priority: '普通', purpose: '排查肺部感染、肺结核、肺不张等', status: '已预约' },
  { department: '放射科', name: '胸部 CT 平扫', priority: '普通', purpose: '进一步评估肺部病变', status: '已预约' },
  { department: '心电图室', name: '心电图', priority: '普通', purpose: '评估心律、心肌缺血', status: '已预约' },
  { department: '超声科', name: '腹部彩超（肝胆胰脾）', priority: '普通', purpose: '评估上腹部脏器情况', status: '已预约' },
  { department: '肺功能室', name: '肺功能检查', priority: '普通', purpose: '评估通气功能和阻塞程度', status: '已预约' },
] as const

const examinationResults = [
  { finding: '两肺纹理增多，未见明显实变影，心影大小形态正常。', name: '胸部 X 线片（正位）', reportStatus: '报告已出', reportTime: '10:02', time: '09:45' },
  { finding: '双肺下叶见片状磨玻璃影，边界模糊，右肺中叶见小结节影，直径约 4 mm。', name: '胸部 CT 平扫', reportStatus: '待审核', reportTime: '—', time: '10:18' },
  { finding: '窦性心律，心率 86 次/分，ST-T 改变（非特异性）。', name: '心电图', reportStatus: '报告已出', reportTime: '09:36', time: '09:32' },
  { finding: '肝脏大小形态正常，实质回声均匀；胆囊内见胆泥样回声。', name: '腹部彩超（肝胆胰脾）', reportStatus: '已执行', reportTime: '—', time: '10:05' },
  { finding: '轻度阻塞性通气功能障碍。', name: '肺功能检查', reportStatus: '已预约', reportTime: '—', time: '10:30' },
] as const

const laboratoryRequests = [
  { fasting: '否', name: '血常规（五分类）', priority: '常规', sample: '全血', status: '已采样', time: '09:16' },
  { fasting: '否', name: 'C 反应蛋白（CRP）', priority: '常规', sample: '血清', status: '已出报告', time: '09:16' },
  { fasting: '是', name: '肝功能（八项）', priority: '常规', sample: '血清', status: '已出报告', time: '09:16' },
  { fasting: '是', name: '肾功能三项', priority: '常规', sample: '血清', status: '检验中', time: '09:16' },
  { fasting: '否', name: '尿常规', priority: '常规', sample: '尿液', status: '待采样', time: '09:16' },
  { fasting: '否', name: '甲/乙流抗原（鼻咽拭子）', priority: '常规', sample: '鼻咽拭子', status: '待采样', time: '09:16' },
] as const

const laboratoryResults = [
  { flag: '—', item: '白细胞（WBC）', reference: '3.50-9.50', status: '已审核', unit: '10^9/L', value: '8.62' },
  { flag: '偏高', item: '中性粒细胞%（NE%）', reference: '40.0-75.0', status: '已审核', unit: '%', value: '78.6 ↑' },
  { flag: '偏低', item: '淋巴细胞%（LY%）', reference: '20.0-50.0', status: '已审核', unit: '%', value: '15.1' },
  { flag: '升高', item: 'C 反应蛋白（CRP）', reference: '0-8', status: '已审核', unit: 'mg/L', value: '18.7 ↑' },
  { flag: '偏高', item: '血糖（GLU）', reference: '3.90-6.10', status: '已审核', unit: 'mmol/L', value: '6.28' },
  { flag: '升高', item: 'ALT（谷丙转氨酶）', reference: '7-40', status: '已审核', unit: 'U/L', value: '46 ↑' },
  { flag: '阳性', item: '尿蛋白（PRO）', reference: '阴性', status: '已审核', unit: '—', value: '1+' },
  { flag: '—', item: '尿白细胞（LEU）', reference: '阴性', status: '已审核', unit: '—', value: '阴性' },
] as const

const diagnosisCatalog = [
  { code: 'J06.9', id: 'j069', name: '急性上呼吸道感染' },
  { code: 'J20.9', id: 'j209', name: '急性支气管炎' },
  { code: 'R05.9', id: 'r059', name: '咳嗽' },
  { code: 'J02.9', id: 'j029', name: '急性咽炎' },
  { code: 'I10', id: 'i10', name: '原发性高血压' },
] as const

const diagnosisSelectItems = diagnosisCatalog.map(item => ({ label: `${item.name}（${item.code}）`, value: item.id }))

const severityItems = [
  { label: '轻度', value: 'mild' },
  { label: '中度', value: 'moderate' },
  { label: '重度', value: 'severe' },
] as const

const medicationCatalog = [
  { defaultDose: '0.5 g', id: 'acetaminophen', name: '对乙酰氨基酚片', spec: '0.5g*10片', stock: '126 盒' },
  { defaultDose: '10 ml', id: 'ambroxol-liquid', name: '氨溴索口服液', spec: '100ml', stock: '54 瓶' },
  { defaultDose: '30 mg', id: 'ambroxol-tablet', name: '盐酸氨溴索片', spec: '30mg*20片', stock: '83 盒' },
  { defaultDose: '10 mg', id: 'loratadine', name: '氯雷他定片', spec: '10mg*6片', stock: '72 盒' },
] as const

const routeItems = [
  { label: '口服', value: 'oral' },
  { label: '雾化吸入', value: 'inhaled' },
  { label: '外用', value: 'topical' },
] as const

const frequencyItems = [
  { label: '每日 1 次', value: 'qd' },
  { label: '每日 2 次', value: 'bid' },
  { label: '每日 3 次', value: 'tid' },
  { label: '必要时', value: 'prn' },
] as const

const prescriptionTypeItems = [
  { label: '西药处方', value: 'western' },
  { label: '中成药处方', value: 'patent-cn' },
  { label: '外用药处方', value: 'topical' },
] as const

const recordTypeItems = [
  { label: '门诊病历', value: 'outpatient' },
  { label: '复诊病历', value: 'revisit' },
  { label: '专病随访记录', value: 'follow-up' },
] as const

const dispositionItems = [
  { label: '门诊治疗', value: 'outpatient' },
  { label: '留观', value: 'observation' },
  { label: '转急诊', value: 'emergency' },
  { label: '建议住院', value: 'admission' },
] as const

const labRows = [
  { date: '2025-05-06', item: '胸部 CT 平扫', result: '双肺支气管壁增厚，右肺下叶可见少量炎性渗出影。', status: '报告已出' },
  { date: '2025-05-06', item: '血常规（五分类）', result: '白细胞 8.21 x10^9/L，中性粒细胞 72.3% ↑', status: '报告已出' },
  { date: '2025-05-06', item: 'C 反应蛋白（CRP）', result: '14.6 mg/L ↑', status: '报告已出' },
  { date: '2025-05-06', item: '甲型流感病毒抗原', result: '阴性', status: '报告已出' },
  { date: '2025-04-20', item: '肝功能（八项）', result: '谷丙转氨酶 28 U/L，余正常', status: '报告已出' },
] as const

const historyRows = [
  { date: '2025-03-18', detail: '血压控制稳定，继续口服氨氯地平 5 mg qd，低盐饮食、定期监测。', title: '高血压病 · 复诊' },
  { date: '2024-11-02', detail: '给予对症治疗，症状好转。', title: '急性上呼吸道感染 · 门诊' },
  { date: '2024-07-15', detail: '建议清淡饮食、规律作息，避免辛辣刺激食物。', title: '慢性胃炎 · 门诊' },
] as const

const avatarCache = new Map<string, string>()

function avatarDataUri(seed: string): string {
  const cached = avatarCache.get(seed)
  if (cached !== undefined) return cached
  const value = createAvatar(lorelei, { seed: `clinmesh:${seed}` }).toDataUri()
  avatarCache.set(seed, value)
  return value
}

export function DoctorWorkspaceLabPage(): React.JSX.Element {
  const [selectedPatientId, setSelectedPatientId] = useState(firstPatient.id)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const [mainTab, setMainTab] = useState<MainTab>('consultation')
  const [navCollapsed, setNavCollapsed] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(true)
  const [saved, setSaved] = useState(false)
  const [signed, setSigned] = useState(false)
  const [generated, setGenerated] = useState(false)
  const [adviceVersion, setAdviceVersion] = useState(0)
  const patient = patients.find(item => item.id === selectedPatientId) ?? firstPatient
  const normalizedSearch = search.trim().toLowerCase()
  const visiblePatients = patients.filter(item => (
    (statusFilter === 'all' || item.status === statusFilter)
    && (normalizedSearch === '' || `${item.name}${item.id}${item.chiefComplaint}`.toLowerCase().includes(normalizedSearch))
  ))
  const shellStyle = {
    '--primary': 'var(--success)',
    '--primary-foreground': 'var(--success-foreground)',
    '--ring': 'var(--success)',
    gridTemplateColumns: `${navCollapsed ? 72 : 210}px 310px minmax(760px, 1fr) ${assistantOpen ? 300 : 56}px`,
  } as CSSProperties

  const selectPatient = (patientId: string): void => {
    setSelectedPatientId(patientId)
    setMainTab('consultation')
    setSaved(false)
    setSigned(false)
    setGenerated(false)
  }

  return (
    <TooltipProvider>
      <main className="h-svh overflow-auto bg-muted/35 p-1.5">
        <div
          className="mx-auto grid h-[calc(100svh-0.75rem)] min-w-[1560px] max-w-[1780px] overflow-hidden rounded-lg border bg-background shadow-sm transition-[grid-template-columns] duration-200"
          style={shellStyle}
        >
          <GlobalNavigation collapsed={navCollapsed} onToggle={() => setNavCollapsed(current => !current)} />
          <PatientQueue
            filter={statusFilter}
            onFilterChange={setStatusFilter}
            onPatientChange={selectPatient}
            patients={visiblePatients}
            selectedPatientId={patient.id}
          />
          <DoctorWorkspace
            mainTab={mainTab}
            onMainTabChange={setMainTab}
            onSave={() => setSaved(true)}
            onSearchChange={setSearch}
            onSign={() => setSigned(true)}
            patient={patient}
            saved={saved}
            search={search}
            signed={signed}
          />
          <ClinicalAssistant
            adviceVersion={adviceVersion}
            generated={generated}
            mainTab={mainTab}
            onGenerate={() => setGenerated(true)}
            onRefresh={() => setAdviceVersion(current => (current + 1) % 2)}
            onToggle={() => setAssistantOpen(current => !current)}
            open={assistantOpen}
          />
        </div>
      </main>
    </TooltipProvider>
  )
}

function GlobalNavigation({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <aside className="flex min-w-0 flex-col border-r bg-background">
      <div className={cn('flex h-16 items-center border-b px-3', collapsed ? 'justify-center' : 'gap-2')}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"><HospitalIcon className="size-5" /></span>
        {collapsed ? null : <strong className="whitespace-nowrap text-sm">Clinmesh HIS</strong>}
        <Tooltip>
          <TooltipTrigger render={<Button aria-label={collapsed ? '展开导航' : '收起导航'} className={cn(collapsed ? '' : 'ml-auto')} onClick={onToggle} size="icon-sm" variant="ghost" />}>
            {collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
          </TooltipTrigger>
          <TooltipContent side="right">{collapsed ? '展开导航' : '收起导航'}</TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-4">
        <NavGroup collapsed={collapsed} items={primaryNav} label="核心功能" />
        <div className="mt-8"><NavGroup collapsed={collapsed} items={secondaryNav} label="系统管理" /></div>
      </div>
      <button className={cn('m-2 flex min-h-10 items-center rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring', collapsed ? 'justify-center' : 'gap-3')} title="收起" type="button">
        <PanelLeftCloseIcon className="size-4" />
        {collapsed ? <span className="sr-only">收起</span> : <span>收起</span>}
      </button>
    </aside>
  )
}

function NavGroup({ collapsed, items, label }: {
  collapsed: boolean
  items: ReadonlyArray<{ active?: boolean; icon: typeof HouseIcon; label: string }>
  label: string
}): React.JSX.Element {
  return (
    <nav aria-label={label}>
      {collapsed ? null : <p className="mb-2 px-2 text-[0.6875rem] text-muted-foreground">{label}</p>}
      <div className="flex flex-col gap-1">
        {items.map(item => (
          <button
            aria-current={item.active ? 'page' : undefined}
            className={cn(
              'flex min-h-10 items-center rounded-md px-2 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
              collapsed ? 'justify-center' : 'gap-3',
              item.active ? 'bg-primary/10 font-medium text-primary hover:bg-primary/15' : 'text-muted-foreground',
            )}
            key={item.label}
            title={collapsed ? item.label : undefined}
            type="button"
          >
            <item.icon className="size-4 shrink-0" />
            {collapsed ? <span className="sr-only">{item.label}</span> : <span>{item.label}</span>}
          </button>
        ))}
      </div>
    </nav>
  )
}

function PatientQueue({ filter, onFilterChange, onPatientChange, patients: queuePatients, selectedPatientId }: {
  filter: StatusFilter
  onFilterChange: (filter: StatusFilter) => void
  onPatientChange: (patientId: string) => void
  patients: readonly Patient[]
  selectedPatientId: string
}): React.JSX.Element {
  return (
    <aside className="flex min-w-0 flex-col border-r bg-muted/10">
      <div className="flex h-16 items-center gap-2 border-b bg-background px-3">
        <div className="mr-auto"><h2 className="text-base font-semibold">候诊患者 <span className="text-xs font-normal text-muted-foreground">（7 人）</span></h2></div>
        <Select
          items={statusFilterItems}
          onValueChange={value => { if (value !== null) onFilterChange(value as StatusFilter) }}
          value={filter}
        >
          <SelectTrigger className="w-24" size="sm"><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup>{statusFilterItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
        <Button aria-label="筛选患者" size="icon-sm" title="筛选患者" variant="outline"><ListFilterIcon /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-2">
          {queuePatients.map(patient => (
            <PatientQueueCard key={patient.id} onClick={() => onPatientChange(patient.id)} patient={patient} selected={patient.id === selectedPatientId} />
          ))}
          {queuePatients.length === 0 ? <p className="py-10 text-center text-xs text-muted-foreground">没有匹配的候诊患者</p> : null}
        </div>
      </div>
    </aside>
  )
}

function PatientQueueCard({ onClick, patient, selected }: { onClick: () => void; patient: Patient; selected: boolean }): React.JSX.Element {
  return (
    <button
      aria-current={selected ? 'true' : undefined}
      className="w-full rounded-md border bg-background p-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring aria-current:border-primary/25 aria-current:bg-primary/5"
      onClick={onClick}
      type="button"
    >
      <span className="flex items-start gap-3">
        <SyntheticAvatar patient={patient} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2"><strong className="truncate text-sm font-semibold">{patient.name}</strong><span className="text-xs text-muted-foreground">{patient.gender} · {patient.age} 岁</span><StatusBadge patient={patient} /></span>
          <span className="mt-2 flex items-center justify-between text-xs text-muted-foreground"><span>{patient.room}</span><span className="tabular-nums">{patient.time}</span></span>
          <span className="mt-1 block truncate text-sm">{patient.chiefComplaint}</span>
        </span>
      </span>
    </button>
  )
}

function SyntheticAvatar({ className, large = false, patient }: { className?: string; large?: boolean; patient: Patient }): React.JSX.Element {
  return (
    <Avatar className={cn('size-10 bg-muted', className)} style={large ? { height: 56, width: 56 } : undefined}>
      <AvatarImage alt={`${patient.name}的合成头像`} src={avatarDataUri(patient.seed)} />
      <AvatarFallback>{patient.name.slice(0, 1)}</AvatarFallback>
      {patient.status === 'current' ? <AvatarBadge /> : null}
    </Avatar>
  )
}

function StatusBadge({ patient }: { patient: Patient }): React.JSX.Element {
  const variant = patient.status === 'current'
    ? 'success'
    : patient.status === 'urgent'
      ? 'destructive'
      : patient.status === 'revisit'
        ? 'warning'
        : patient.status === 'waiting'
          ? 'info'
          : 'secondary'
  return <Badge className="ml-auto" variant={variant}>{patient.statusLabel}</Badge>
}

interface DoctorWorkspaceProps {
  mainTab: MainTab
  onMainTabChange: (tab: MainTab) => void
  onSave: () => void
  onSearchChange: (value: string) => void
  onSign: () => void
  patient: Patient
  saved: boolean
  search: string
  signed: boolean
}

function DoctorWorkspace({ mainTab, onMainTabChange, onSave, onSearchChange, onSign, patient, saved, search, signed }: DoctorWorkspaceProps): React.JSX.Element {
  return (
    <section className="flex min-w-0 flex-col bg-muted/20">
      <header className="flex h-16 items-center gap-2 border-b bg-background px-4">
        <h1 className="mr-auto shrink-0 text-xl font-semibold">门诊医生工作台</h1>
        <InputGroup className="w-64 2xl:w-72">
          <InputGroupInput aria-label="搜索患者、病历或检查" onChange={event => onSearchChange(event.target.value)} placeholder="搜索患者、病历、检查等" value={search} />
          <InputGroupAddon><SearchIcon /></InputGroupAddon>
          <InputGroupAddon align="inline-end"><span className="text-[0.6875rem]">⌘K</span></InputGroupAddon>
        </InputGroup>
        <Button onClick={onSave} size="sm" variant="outline"><SaveIcon data-icon="inline-start" />{saved ? '已保存' : '保存病历'}</Button>
        <Button disabled={signed} onClick={onSign} size="sm">{signed ? <CircleCheckIcon data-icon="inline-start" /> : null}{signed ? '已签署' : '提交/签名'}</Button>
        <div className="ml-2 flex items-center gap-2 border-l pl-3">
          <Avatar size="sm"><AvatarImage alt="张医生的合成头像" src={avatarDataUri('doctor-zhang')} /><AvatarFallback>张</AvatarFallback></Avatar>
          <span className="hidden text-xs 2xl:block"><strong className="block font-medium">张医生</strong><span className="text-muted-foreground">内科主治医师</span></span>
          <ChevronDownIcon className="size-3 text-muted-foreground" />
        </div>
      </header>

      <div className="flex h-12 items-center gap-2 border-b bg-background px-4">
        <Button size="sm" variant="outline"><CalendarDaysIcon data-icon="inline-start" />今日&nbsp; 2025-05-06<ChevronDownIcon data-icon="inline-end" /></Button>
        <Button size="sm" variant="outline"><StethoscopeIcon data-icon="inline-start" />内科门诊<ChevronDownIcon data-icon="inline-end" /></Button>
        <Button size="sm" variant="outline"><UsersIcon data-icon="inline-start" />我的排队 <span className="text-primary">6</span> 人</Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <PatientBanner patient={patient} />
        <Tabs className="mt-3 min-h-0 gap-0" onValueChange={value => onMainTabChange(value as MainTab)} value={mainTab}>
          <TabsList className="h-10 w-full justify-start gap-5 rounded-none border-b bg-transparent px-2 py-0" variant="line">
            {mainTabs.map(tab => (
              <TabsTrigger className="flex-none px-0" key={tab.id} value={tab.id}>{tab.label}{tab.count === undefined ? null : <span className="text-[0.6875rem] text-muted-foreground">{tab.count}</span>}</TabsTrigger>
            ))}
          </TabsList>
          <TabsContent className="pt-3" value="consultation"><StructuredInquiry key={`consultation:${patient.id}`} patient={patient} /></TabsContent>
          <TabsContent className="pt-3" value="record"><MedicalRecordEditor key={`record:${patient.id}`} patient={patient} /></TabsContent>
          <TabsContent className="pt-3" value="examination"><ExaminationWorkspace key={`examination:${patient.id}`} /></TabsContent>
          <TabsContent className="pt-3" value="laboratory"><LaboratoryWorkspace key={`laboratory:${patient.id}`} /></TabsContent>
          <TabsContent className="pt-3" value="diagnosis"><DiagnosisEditor key={`diagnosis:${patient.id}`} /></TabsContent>
          <TabsContent className="pt-3" value="prescription"><PrescriptionEditor key={`prescription:${patient.id}`} /></TabsContent>
        </Tabs>
      </div>
    </section>
  )
}

function PatientBanner({ patient }: { patient: Patient }): React.JSX.Element {
  return (
    <section aria-label="当前患者" className="rounded-md border bg-background p-3 shadow-xs">
      <div className="flex items-center gap-4">
        <SyntheticAvatar large patient={patient} />
        <div className="min-w-0">
          <div className="flex items-center gap-2"><h2 className="text-lg font-semibold">{patient.name}</h2><Badge variant={patient.gender === '女' ? 'destructive' : 'info'}>{patient.gender}</Badge><span className="text-sm text-muted-foreground">{patient.age} 岁</span></div>
          <dl className="mt-2 flex flex-wrap gap-x-7 gap-y-1 text-xs">
            <PatientFact label="患者 ID" value={patient.id.replace('P', '')} />
            <PatientFact label="就诊科室" value="内科门诊" />
            <PatientFact label="就诊号" value={patient.patientNumber} />
            <PatientFact label="就诊时间" value={`2025-05-06 ${patient.time}`} />
          </dl>
        </div>
        <div className="ml-auto flex max-w-72 flex-wrap justify-end gap-2">
          <Badge variant={patient.allergy === '否认药物过敏' ? 'secondary' : 'destructive'}>过敏史：{patient.allergy}</Badge>
          <Badge variant="warning">分诊级别：III 级</Badge>
          <Button size="xs" variant="secondary">病程史</Button>
          <Button size="xs" variant="secondary">医嘱</Button>
          <Button size="xs" variant="secondary">基础信息</Button>
        </div>
      </div>
    </section>
  )
}

function PatientFact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="flex gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="font-medium">{value}</dd></div>
}

function StructuredInquiry({ patient }: { patient: Patient }): React.JSX.Element {
  const [saved, setSaved] = useState(false)
  const [symptoms, setSymptoms] = useState<string[]>(['cough', 'fever', 'sore-throat', 'fatigue'])
  return (
    <section className="rounded-md border bg-background">
      <PanelHeader
        action={<div className="flex gap-2"><Button size="xs" variant="outline"><AudioLinesIcon data-icon="inline-start" />AI 语音转写</Button><Button size="xs" variant="outline">从分诊同步</Button></div>}
        aside="接诊中"
        title="结构化问诊"
      />
      <form onSubmit={event => { event.preventDefault(); setSaved(true) }}>
        <FieldGroup className="p-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_12rem_10rem]">
            <Field>
              <FieldLabel htmlFor={`consultation-chief-${patient.id}`}>主诉</FieldLabel>
              <Input defaultValue={patient.chiefComplaint.replace('伴', '、')} id={`consultation-chief-${patient.id}`} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`consultation-onset-${patient.id}`}>发病时长</FieldLabel>
              <Input defaultValue="3" id={`consultation-onset-${patient.id}`} min={0} type="number" />
            </Field>
            <Field>
              <FieldLabel htmlFor={`consultation-onset-unit-${patient.id}`}>单位</FieldLabel>
              <Select defaultValue="day" items={onsetUnitItems}>
                <SelectTrigger className="w-full" id={`consultation-onset-unit-${patient.id}`}><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>{onsetUnitItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
            </Field>
          </div>

          <FieldSet>
            <FieldLegend variant="label">主要症状</FieldLegend>
            <ToggleGroup className="flex-wrap justify-start" multiple onValueChange={setSymptoms} size="sm" spacing={2} value={symptoms} variant="outline">
              {symptomOptions.map(item => <ToggleGroupItem key={item.value} value={item.value}>{item.label}</ToggleGroupItem>)}
            </ToggleGroup>
          </FieldSet>

          <Field>
            <FieldLabel htmlFor={`consultation-history-${patient.id}`}>现病史</FieldLabel>
            <Textarea defaultValue="3 天前出现咳嗽，干咳为主，伴咽部不适，1 天前体温升高，最高 38.5°C，伴乏力、头痛，无明显胸闷、气促。无恶心呕吐、腹泻、咯血。" id={`consultation-history-${patient.id}`} rows={5} />
            <FieldDescription>按时间顺序记录症状变化、伴随症状和已采取的处理。</FieldDescription>
          </Field>

          <div className="grid gap-4 xl:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`consultation-past-${patient.id}`}>既往史</FieldLabel>
              <Textarea defaultValue="高血压病史 2 年，间断口服氨氯地平片，血压控制可。否认糖尿病、冠心病、肝炎、结核等病史。" id={`consultation-past-${patient.id}`} rows={4} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`consultation-medication-${patient.id}`}>用药史与过敏史</FieldLabel>
              <Textarea defaultValue={`长期用药：氨氯地平片 5 mg qd。药物过敏：${patient.allergy}。`} id={`consultation-medication-${patient.id}`} rows={4} />
            </Field>
          </div>

          <FieldSet>
            <FieldLegend variant="label">生命体征</FieldLegend>
            <FieldGroup className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <VitalField defaultValue="38.5" id={`temperature-${patient.id}`} label="体温（°C）" />
              <VitalField defaultValue="96" id={`pulse-${patient.id}`} label="脉搏（次/分）" />
              <VitalField defaultValue="20" id={`respiration-${patient.id}`} label="呼吸（次/分）" />
              <VitalField defaultValue="138/86" id={`blood-pressure-${patient.id}`} label="血压（mmHg）" />
              <VitalField defaultValue="98" id={`spo2-${patient.id}`} label="SpO₂（%）" />
            </FieldGroup>
          </FieldSet>

          <Field>
            <FieldLabel htmlFor={`consultation-exam-${patient.id}`}>体格检查</FieldLabel>
            <Textarea defaultValue="一般情况可，咽部充血，双肺呼吸音清，未闻及干湿啰音，心率齐，腹软无压痛。" id={`consultation-exam-${patient.id}`} rows={4} />
          </Field>
        </FieldGroup>
        <div className="flex items-center justify-end gap-2 border-t p-3">
          <span className="mr-auto text-xs text-muted-foreground">{saved ? '问诊记录已保存' : '未保存的问诊草稿'}</span>
          <Button
            onClick={event => {
              event.currentTarget.form?.reset()
              setSymptoms(['cough', 'fever', 'sore-throat', 'fatigue'])
              setSaved(false)
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            清空本次修改
          </Button>
          <Button size="sm" type="submit"><SaveIcon data-icon="inline-start" />保存问诊记录</Button>
        </div>
      </form>
    </section>
  )
}

function VitalField({ defaultValue, id, label }: { defaultValue: string; id: string; label: string }): React.JSX.Element {
  return <Field><FieldLabel htmlFor={id}>{label}</FieldLabel><Input defaultValue={defaultValue} id={id} /></Field>
}

function MedicalRecordEditor({ patient }: { patient: Patient }): React.JSX.Element {
  const [saved, setSaved] = useState(false)
  const [synced, setSynced] = useState(false)
  return (
    <section className="rounded-md border bg-background">
      <PanelHeader
        action={<Button onClick={() => setSynced(true)} size="xs" variant="outline"><RefreshCwIcon data-icon="inline-start" />{synced ? '已从问诊同步' : '从问诊记录同步'}</Button>}
        aside="门诊病历草稿"
        title="病历填写"
      />
      <div className="grid xl:grid-cols-[minmax(0,1fr)_17rem]">
        <form className="border-b xl:border-r xl:border-b-0" onSubmit={event => { event.preventDefault(); setSaved(true) }}>
          <FieldGroup className="p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`record-type-${patient.id}`}>文书类型</FieldLabel>
                <Select defaultValue="outpatient" items={recordTypeItems}>
                  <SelectTrigger className="w-full" id={`record-type-${patient.id}`}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{recordTypeItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`record-disposition-${patient.id}`}>处置去向</FieldLabel>
                <Select defaultValue="outpatient" items={dispositionItems}>
                  <SelectTrigger className="w-full" id={`record-disposition-${patient.id}`}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{dispositionItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor={`record-chief-${patient.id}`}>主诉</FieldLabel>
              <Input defaultValue={patient.chiefComplaint} id={`record-chief-${patient.id}`} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`record-present-${patient.id}`}>现病史</FieldLabel>
              <Textarea defaultValue="3 天前出现咳嗽，干咳为主，伴咽部不适；1 天前体温升高，最高 38.5°C。无明显胸闷、气促，无恶心呕吐、腹泻、咯血。" id={`record-present-${patient.id}`} rows={5} />
            </Field>
            <div className="grid gap-4 xl:grid-cols-2">
              <Field><FieldLabel htmlFor={`record-past-${patient.id}`}>既往史</FieldLabel><Textarea defaultValue="高血压病史 2 年，间断口服氨氯地平片，血压控制可。" id={`record-past-${patient.id}`} rows={4} /></Field>
              <Field><FieldLabel htmlFor={`record-personal-${patient.id}`}>个人史与家族史</FieldLabel><Textarea defaultValue="无吸烟史，偶尔饮酒。否认家族遗传病史。" id={`record-personal-${patient.id}`} rows={4} /></Field>
            </div>
            <Field><FieldLabel htmlFor={`record-exam-${patient.id}`}>体格检查</FieldLabel><Textarea defaultValue="T 38.5°C，P 96 次/分，R 20 次/分，BP 138/86 mmHg。咽部充血，双肺呼吸音清。" id={`record-exam-${patient.id}`} rows={4} /></Field>
            <Field><FieldLabel htmlFor={`record-auxiliary-${patient.id}`}>辅助检查摘要</FieldLabel><Textarea defaultValue="血常规：白细胞 8.21 x10^9/L，中性粒细胞 72.3%；CRP 14.6 mg/L。" id={`record-auxiliary-${patient.id}`} rows={3} /></Field>
            <Field><FieldLabel htmlFor={`record-advice-${patient.id}`}>处理意见与随访</FieldLabel><Textarea defaultValue="对症治疗，注意休息和补液；体温持续升高或出现呼吸困难时及时复诊。" id={`record-advice-${patient.id}`} rows={4} /></Field>
          </FieldGroup>
          <div className="flex items-center justify-end gap-2 border-t p-3">
            <span className="mr-auto text-xs text-muted-foreground">{saved ? '病历草稿已保存' : '病历草稿未保存'}</span>
            <Button size="sm" type="button" variant="outline">预览病历</Button>
            <Button size="sm" type="submit"><SaveIcon data-icon="inline-start" />保存病历草稿</Button>
          </div>
        </form>
        <aside className="bg-muted/10 p-3">
          <h3 className="text-sm font-semibold">历史病历</h3>
          <p className="mt-1 text-xs text-muted-foreground">近 1 年 · 3 次就诊</p>
          <ol className="mt-3 flex flex-col gap-3">
            {historyRows.map(row => (
              <li className="border-l-2 border-l-border pl-3" key={row.date}>
                <p className="text-[0.6875rem] tabular-nums text-muted-foreground">{row.date}</p>
                <p className="mt-1 text-xs font-medium">{row.title}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{row.detail}</p>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </section>
  )
}

function ExaminationWorkspace(): React.JSX.Element {
  const [added, setAdded] = useState(false)
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 xl:grid-cols-[42%_minmax(0,58%)]">
        <section className="rounded-md border bg-background">
          <PanelHeader
            action={<div className="flex gap-2"><Button onClick={() => setAdded(true)} size="xs"><PlusIcon data-icon="inline-start" />{added ? '已新增检查' : '新增检查'}</Button><Button size="xs" variant="outline"><ClipboardListIcon data-icon="inline-start" />套餐模板</Button></div>}
            title="检查申请"
          />
          <Table>
            <TableHeader><TableRow><TableHead>检查项目</TableHead><TableHead>临床目的</TableHead><TableHead>优先级</TableHead><TableHead>执行科室</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
            <TableBody>{examinationRequests.map(item => <TableRow key={item.name}><TableCell className="text-xs font-medium">{item.name}</TableCell><TableCell className="text-xs leading-5">{item.purpose}</TableCell><TableCell><Badge variant="secondary">{item.priority}</Badge></TableCell><TableCell className="text-xs">{item.department}</TableCell><TableCell><Badge variant="info">{item.status}</Badge></TableCell></TableRow>)}</TableBody>
          </Table>
          <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground"><span>共 {added ? 6 : 5} 条</span><span>1 / 1</span></div>
        </section>

        <section className="rounded-md border bg-background">
          <PanelHeader action={<div className="flex gap-2"><Button aria-label="刷新检查结果" size="icon-xs" title="刷新" variant="outline"><RefreshCwIcon /></Button><Button size="xs" variant="outline">全部状态<ChevronDownIcon data-icon="inline-end" /></Button></div>} title="检查结果" />
          <Table>
            <TableHeader><TableRow><TableHead>检查项目</TableHead><TableHead>检查时间</TableHead><TableHead>主要所见</TableHead><TableHead>报告状态</TableHead><TableHead>报告时间</TableHead></TableRow></TableHeader>
            <TableBody>{examinationResults.map(item => <TableRow key={item.name}><TableCell className="text-xs font-medium">{item.name}</TableCell><TableCell className="whitespace-nowrap text-xs tabular-nums">2025-06-06 {item.time}</TableCell><TableCell className={cn('text-xs leading-5', item.reportStatus === '待审核' ? 'font-medium text-destructive' : '')}>{item.finding}</TableCell><TableCell><Badge variant={item.reportStatus === '报告已出' ? 'success' : item.reportStatus === '待审核' ? 'warning' : 'info'}>{item.reportStatus}</Badge></TableCell><TableCell className="whitespace-nowrap text-xs tabular-nums">{item.reportTime}</TableCell></TableRow>)}</TableBody>
          </Table>
          <Button className="m-2" size="xs" variant="link">查看全部检查结果（共 5 条）</Button>
        </section>
      </div>

      <div className="grid gap-3 xl:grid-cols-[40%_minmax(0,60%)]">
        <section className="rounded-md border bg-background">
          <PanelHeader action={<Button size="xs" variant="link"><SparklesIcon data-icon="inline-start" />AI 生成摘要</Button>} title="检查相关病历依据" />
          <dl className="grid gap-2 p-3 text-xs leading-5"><EvidenceFact label="主诉" value="咳嗽伴胸闷 3 天，夜间加重，偶有白痰，无发热。" /><EvidenceFact label="现病史" value="3 天前受凉后出现咳嗽，夜间明显，伴胸闷，无胸痛、气促。" /><EvidenceFact label="体格检查" value="心肺听诊未闻及明显异常，双肺呼吸音清，心率 86 次/分。" /><EvidenceFact label="初步印象" value="上呼吸道感染？支气管炎？需排除肺部感染及其他病变。" /><EvidenceFact label="检查目的" value="明确病因，排查肺部感染、结核、肿块及心脏相关异常。" /></dl>
        </section>
        <section className="rounded-md border bg-background">
          <PanelHeader title="检查进度" />
          <div className="p-4">
            <div className="grid grid-cols-5">
              <ProgressStage complete icon={CircleCheckIcon} label="已申请" time="06-06 09:18" />
              <ProgressStage complete icon={FileCheck2Icon} label="已缴费" time="06-06 09:20" />
              <ProgressStage complete icon={CalendarClockIcon} label="已预约" time="06-06 09:22" />
              <ProgressStage active icon={ScanLineIcon} label="已执行" time="部分完成" />
              <ProgressStage icon={ClipboardClockIcon} label="已出报告" time="部分完成" />
            </div>
            <div className="mt-5 flex items-center gap-3 border-t pt-3 text-xs"><span>当前完成 <strong className="text-primary">3/5</strong> 项检查</span><span className="text-muted-foreground">预计全部完成时间：2025-06-06 12:30</span><Button className="ml-auto" size="xs" variant="link">查看详情</Button></div>
          </div>
        </section>
      </div>
    </div>
  )
}

function LaboratoryWorkspace(): React.JSX.Element {
  const [added, setAdded] = useState(false)
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 xl:grid-cols-[48%_minmax(0,52%)]">
        <section className="rounded-md border bg-background">
          <PanelHeader action={<div className="flex gap-2"><Button onClick={() => setAdded(true)} size="xs"><PlusIcon data-icon="inline-start" />{added ? '已新增检验' : '新增检验'}</Button><Button size="xs" variant="outline">套餐模板</Button></div>} title="检验申请" />
          <Table>
            <TableHeader><TableRow><TableHead>检验项目</TableHead><TableHead>标本类型</TableHead><TableHead>是否空腹</TableHead><TableHead>优先级</TableHead><TableHead>申请时间</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
            <TableBody>{laboratoryRequests.map(item => <TableRow key={item.name}><TableCell className="text-xs font-medium">{item.name}</TableCell><TableCell className="text-xs">{item.sample}</TableCell><TableCell className="text-xs">{item.fasting}</TableCell><TableCell className="text-xs">{item.priority}</TableCell><TableCell className="whitespace-nowrap text-xs tabular-nums">05-06 {item.time}</TableCell><TableCell><Badge variant={item.status === '已出报告' || item.status === '已采样' ? 'success' : item.status === '检验中' ? 'info' : 'warning'}>{item.status}</Badge></TableCell></TableRow>)}</TableBody>
          </Table>
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">共 {added ? 7 : 6} 项</div>
        </section>
        <section className="rounded-md border bg-background">
          <PanelHeader action={<Button size="xs" variant="link">查看报告单</Button>} aside="报告时间：2025-05-06 10:25" title="检验结果" />
          <Table>
            <TableHeader><TableRow><TableHead>检验项目</TableHead><TableHead>结果值</TableHead><TableHead>单位</TableHead><TableHead>参考范围</TableHead><TableHead>异常提示</TableHead><TableHead>报告状态</TableHead></TableRow></TableHeader>
            <TableBody>{laboratoryResults.map(item => <TableRow key={item.item}><TableCell className="text-xs font-medium">{item.item}</TableCell><TableCell className={cn('whitespace-nowrap text-xs tabular-nums', item.flag === '—' ? '' : 'font-medium text-destructive')}>{item.value}</TableCell><TableCell className="text-xs">{item.unit}</TableCell><TableCell className="whitespace-nowrap text-xs">{item.reference}</TableCell><TableCell>{item.flag === '—' ? <span className="text-xs text-muted-foreground">—</span> : <Badge variant="destructive">{item.flag}</Badge>}</TableCell><TableCell><Badge variant="success">{item.status}</Badge></TableCell></TableRow>)}</TableBody>
          </Table>
        </section>
      </div>

      <div className="grid gap-3 xl:grid-cols-[42%_minmax(0,58%)]">
        <section className="rounded-md border bg-background">
          <PanelHeader title="结果解读 / 趋势" />
          <div className="grid gap-2 p-3"><InterpretationRow icon={TrendingUpIcon} label="炎症指标" value="CRP 18.7 mg/L，轻度升高；中性粒细胞%偏高，提示体内存在炎症。" /><InterpretationRow icon={StethoscopeIcon} label="感染倾向" value="结合症状，倾向病毒或上呼吸道感染可能性大，细菌感染可能性低。" /><InterpretationRow icon={HeartPulseIcon} label="肝功能" value="ALT 轻度升高，建议避免饮酒及肝损伤药物，必要时复查。" /><InterpretationRow icon={TestTube2Icon} label="其他" value="尿蛋白 1+，建议复查尿常规，注意休息与补水。" /></div>
        </section>
        <section className="rounded-md border bg-background">
          <PanelHeader title="采样与报告进度" />
          <div className="flex items-center justify-center gap-6 border-b p-3 text-xs"><MiniStage icon={FileCheck2Icon} label="已开立" /><span className="text-muted-foreground">→</span><MiniStage icon={SyringeIcon} label="已采样" /><span className="text-muted-foreground">→</span><MiniStage icon={MicroscopeIcon} label="检验中" /><span className="text-muted-foreground">→</span><MiniStage icon={PackageCheckIcon} label="已出报告" /></div>
          <div className="p-3"><LabProgressRow label="血常规（五分类）" progress={100} status="已出报告" time="2025-05-06 09:28" /><LabProgressRow label="C 反应蛋白（CRP）" progress={100} status="已出报告" time="2025-05-06 09:28" /><LabProgressRow label="肝功能（八项）" progress={100} status="已出报告" time="2025-05-06 10:25" /><LabProgressRow label="肾功能三项" progress={66} status="检验中" time="—" /><LabProgressRow label="尿常规" progress={20} status="待采样" time="—" /></div>
        </section>
      </div>
    </div>
  )
}

function EvidenceFact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2"><dt className="font-medium">{label}</dt><dd>{value}</dd></div>
}

function ProgressStage({ active = false, complete = false, icon: Icon, label, time }: { active?: boolean; complete?: boolean; icon: typeof CircleCheckIcon; label: string; time: string }): React.JSX.Element {
  return <div className="relative flex flex-col items-center text-center before:absolute before:top-4 before:right-1/2 before:left-[-50%] before:h-px before:bg-border first:before:hidden"><span className={cn('relative flex size-8 items-center justify-center rounded-full border bg-background', complete ? 'border-primary bg-primary/10 text-primary' : active ? 'border-info bg-info/10 text-info' : 'text-muted-foreground')}><Icon className="size-4" /></span><strong className="mt-2 text-xs">{label}</strong><span className="mt-1 text-[0.6875rem] text-muted-foreground">{time}</span></div>
}

function InterpretationRow({ icon: Icon, label, value }: { icon: typeof TrendingUpIcon; label: string; value: string }): React.JSX.Element {
  return <div className="grid grid-cols-[2rem_5rem_minmax(0,1fr)] items-start gap-2 rounded-md border bg-muted/10 p-2"><span className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary"><Icon className="size-4" /></span><strong className="pt-1 text-xs">{label}</strong><p className="text-xs leading-5 text-muted-foreground">{value}</p></div>
}

function MiniStage({ icon: Icon, label }: { icon: typeof FileCheck2Icon; label: string }): React.JSX.Element {
  return <span className="flex items-center gap-1.5"><Icon className="size-4 text-primary" /><strong className="font-medium">{label}</strong></span>
}

function LabProgressRow({ label, progress, status, time }: { label: string; progress: number; status: string; time: string }): React.JSX.Element {
  return <div className="grid grid-cols-[9rem_minmax(0,1fr)_7rem_5rem] items-center gap-3 border-b py-2 text-xs last:border-b-0"><span className="font-medium">{label}</span><Progress value={progress} /><span className="tabular-nums text-muted-foreground">{time}</span><Badge variant={status === '已出报告' ? 'success' : status === '检验中' ? 'info' : 'warning'}>{status}</Badge></div>
}

function DiagnosisEditor(): React.JSX.Element {
  const [saved, setSaved] = useState(false)
  const [chronic, setChronic] = useState('no')

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 xl:grid-cols-[43%_minmax(0,57%)]">
        <section className="rounded-md border bg-background">
          <PanelHeader action={<Button size="xs" variant="ghost">清空</Button>} title="诊断录入" />
          <form onSubmit={event => { event.preventDefault(); setSaved(true) }}>
            <FieldGroup className="p-3">
              <Field><FieldLabel htmlFor="primary-diagnosis">主诊断 *</FieldLabel><Select defaultValue="j069" items={diagnosisSelectItems}><SelectTrigger className="w-full" id="primary-diagnosis"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{diagnosisSelectItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
              <Field><FieldLabel htmlFor="secondary-diagnosis">次要诊断</FieldLabel><Select defaultValue="i10" items={diagnosisSelectItems}><SelectTrigger className="w-full" id="secondary-diagnosis"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{diagnosisSelectItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
              <Button size="sm" type="button" variant="outline"><PlusIcon data-icon="inline-start" />添加诊断</Button>
              <FieldSet><FieldLegend variant="label">诊断依据 *</FieldLegend><div className="flex flex-wrap gap-1.5"><Badge variant="success">流涕 ×</Badge><Badge variant="success">咽痛 ×</Badge><Badge variant="success">咳嗽 ×</Badge><Badge variant="success">低热 ×</Badge><Badge variant="success">咽部充血 ×</Badge><Badge variant="success">白细胞正常 ×</Badge></div></FieldSet>
              <Field><FieldLabel htmlFor="diagnosis-icd">ICD-10 编码</FieldLabel><Input defaultValue="J06.9, I10" id="diagnosis-icd" /></Field>
              <Field><FieldLabel htmlFor="diagnosis-severity">病情分级</FieldLabel><Select defaultValue="mild" items={severityItems}><SelectTrigger className="w-full" id="diagnosis-severity"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{severityItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
              <FieldSet><FieldLegend variant="label">是否慢病</FieldLegend><ToggleGroup onValueChange={values => { const next = values[0]; if (next !== undefined) setChronic(next) }} size="sm" spacing={0} value={[chronic]} variant="outline"><ToggleGroupItem value="yes">是</ToggleGroupItem><ToggleGroupItem value="no">否</ToggleGroupItem></ToggleGroup></FieldSet>
              <Field><FieldLabel htmlFor="diagnosis-note">备注</FieldLabel><Textarea defaultValue="建议注意保暖，避免受凉，注意休息。" id="diagnosis-note" rows={3} /></Field>
              <div className="grid gap-3 sm:grid-cols-2"><Field><FieldLabel htmlFor="diagnosis-time">诊断时间</FieldLabel><Input defaultValue="2025-06-06 08:36" id="diagnosis-time" /></Field><Field><FieldLabel htmlFor="diagnosis-doctor">诊断医生</FieldLabel><Input defaultValue="张医生（呼吸内科）" id="diagnosis-doctor" /></Field></div>
            </FieldGroup>
            <div className="flex items-center justify-end border-t p-3"><span className="mr-auto text-xs text-muted-foreground">{saved ? '诊断已保存' : '诊断草稿未保存'}</span><Button size="sm" type="submit"><SaveIcon data-icon="inline-start" />保存诊断</Button></div>
          </form>
        </section>

        <section className="rounded-md border bg-background">
          <PanelHeader action={<Badge variant="success">匹配度 92%</Badge>} title="诊断结论" />
          <div className="p-3 text-xs">
            <DiagnosisGroup title="最终诊断（按优先级）"><DiagnosisMatch index={1} match={92} name="急性上呼吸道感染（J06.9）" primary /><DiagnosisMatch index={2} match={81} name="高血压病（I10）" /></DiagnosisGroup>
            <DiagnosisGroup title="鉴别诊断"><DiagnosisMatch index={1} match={48} name="流行性感冒（J11.9）" /><DiagnosisMatch index={2} match={36} name="急性支气管炎（J20.9）" /></DiagnosisGroup>
            <div className="mt-3"><strong>排除诊断</strong><p className="mt-1 leading-5"><b>肺炎（J18.9）</b> - 无发热高热、肺部啰音，影像未见异常。<br /><b>COVID-19（U07.1）</b> - 无流行病学史，抗原阴性。</p></div>
            <div className="mt-3"><strong>诊断依据摘要</strong><p className="mt-1 leading-5">患者以流涕、咽痛、咳嗽 2 天就诊，伴低热，咽部充血，肺部听诊未闻及湿啰音；血常规白细胞计数正常，CRP 正常，综合考虑为急性上呼吸道感染，同时既往有高血压病史。</p></div>
            <div className="mt-3"><strong>处理建议</strong><ul className="mt-1 list-disc pl-4 leading-5"><li>对症治疗为主，必要时抗病毒或抗菌治疗</li><li>继续规律监测血压，遵医嘱服用降压药物</li><li>注意休息、多饮水、清淡饮食</li></ul></div>
          </div>
        </section>
      </div>

      <div className="grid gap-3 xl:grid-cols-[40%_minmax(0,60%)]">
        <section className="rounded-md border bg-background"><PanelHeader action={<Button size="xs" variant="outline"><LinkIcon data-icon="inline-start" />关联设置</Button>} title="问题列表 / 既往病史关联" /><div className="p-3 text-xs"><strong>当前问题</strong><ProblemRow label="急性上呼吸道感染相关症状" status="本次就诊" /><ProblemRow label="咽痛、流涕、咳嗽、低热" status="本次就诊" /><strong className="mt-3 block">慢性问题</strong><ProblemRow label="高血压病（5 年）" status="慢病" /><ProblemRow label="青霉素过敏史" status="过敏史" /></div></section>
        <section className="rounded-md border bg-background"><PanelHeader title="随访与处置建议" /><dl className="grid gap-2 p-3 text-xs"><FollowUpRow label="复诊时间" value="2025-06-09（3 天后）" /><FollowUpRow label="注意事项" value="注意保暖，避免受凉；规律作息，清淡饮食；若症状加重或持续不缓解及时就诊。" /><FollowUpRow label="健康宣教" value="上呼吸道感染多由病毒引起，注意个人卫生、勤洗手，咳嗽或打喷嚏时用纸巾遮掩口鼻。" /><FollowUpRow alert label="返回就诊提示" value="若出现高热（≥38.5°C）、呼吸困难、胸痛、意识改变等，请立即就诊。" /></dl></section>
      </div>
    </div>
  )
}

function DiagnosisGroup({ children, title }: { children: React.ReactNode; title: string }): React.JSX.Element {
  return <div className="mb-3"><strong>{title}</strong><div className="mt-1 flex flex-col gap-1">{children}</div></div>
}

function DiagnosisMatch({ index, match, name, primary = false }: { index: number; match: number; name: string; primary?: boolean }): React.JSX.Element {
  return <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_3rem_5rem] items-center gap-2 rounded-md border px-2 py-1.5"><span className="flex size-5 items-center justify-center rounded-full bg-muted">{index}</span><span className="font-medium">{name} {primary ? <Badge variant="success">主要</Badge> : null}</span><span className="tabular-nums text-muted-foreground">{match}%</span><Progress value={match} /></div>
}

function ProblemRow({ label, status }: { label: string; status: string }): React.JSX.Element {
  return <div className="mt-2 flex items-center justify-between border-b pb-2"><span>{label}</span><Badge variant={status === '过敏史' ? 'destructive' : status === '慢病' ? 'warning' : 'success'}>{status}</Badge></div>
}

function FollowUpRow({ alert = false, label, value }: { alert?: boolean; label: string; value: string }): React.JSX.Element {
  return <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2 rounded-md border p-2"><dt className="font-medium">{label}</dt><dd className={cn('leading-5', alert ? 'font-medium text-destructive' : '')}>{value}</dd></div>
}

function PrescriptionEditor(): React.JSX.Element {
  const [medicationIds, setMedicationIds] = useState<string[]>(medicationCatalog.map(item => item.id))
  const [signed, setSigned] = useState(false)
  const selectedMedications = medicationIds.flatMap(id => {
    const item = medicationCatalog.find(medication => medication.id === id)
    return item === undefined ? [] : [item]
  })

  const addMedication = (): void => {
    const next = medicationCatalog.find(item => !medicationIds.includes(item.id))
    if (next !== undefined) setMedicationIds(current => [...current, next.id])
    setSigned(false)
  }

  const removeMedication = (medicationId: string): void => {
    setSigned(false)
    setMedicationIds(current => current.filter(id => id !== medicationId))
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 xl:grid-cols-[58%_minmax(0,42%)]">
        <section className="rounded-md border bg-background">
          <PanelHeader
            action={<div className="flex gap-2"><Button disabled={medicationIds.length === medicationCatalog.length} onClick={addMedication} size="xs"><PlusIcon data-icon="inline-start" />新增药品</Button><Button size="xs" variant="outline"><HistoryIcon data-icon="inline-start" />常用处方</Button><Button size="xs" variant="outline">模板</Button></div>}
            title="处方开立"
          />
          <div className="flex items-center gap-3 border-b p-3"><span className="text-xs text-muted-foreground">处方类型</span><Select defaultValue="western" items={prescriptionTypeItems}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{prescriptionTypeItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent></Select></div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>#</TableHead><TableHead>药品名称 / 规格</TableHead><TableHead>用法用量</TableHead><TableHead>频次</TableHead><TableHead>天数</TableHead><TableHead>数量</TableHead><TableHead>给药途径</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
              <TableBody>{selectedMedications.map((item, index) => <TableRow key={item.id}><TableCell className="text-xs">{index + 1}</TableCell><TableCell><strong className="block whitespace-nowrap text-xs">{item.name}</strong><span className="text-[0.6875rem] text-muted-foreground">{item.spec}</span></TableCell><TableCell><Input aria-label={`${item.name}用法用量`} className="w-20" defaultValue={item.defaultDose} /></TableCell><TableCell><Select defaultValue={index === 3 ? 'qd' : 'tid'} items={frequencyItems}><SelectTrigger className="w-24"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{frequencyItems.map(frequency => <SelectItem key={frequency.value} value={frequency.value}>{frequency.label}</SelectItem>)}</SelectGroup></SelectContent></Select></TableCell><TableCell><Input aria-label={`${item.name}天数`} className="w-14" defaultValue={index === 0 ? '3' : '5'} type="number" /></TableCell><TableCell><Input aria-label={`${item.name}数量`} className="w-14" defaultValue="1" type="number" /></TableCell><TableCell><Select defaultValue="oral" items={routeItems}><SelectTrigger className="w-20"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{routeItems.map(route => <SelectItem key={route.value} value={route.value}>{route.label}</SelectItem>)}</SelectGroup></SelectContent></Select></TableCell><TableCell><Button onClick={() => removeMedication(item.id)} size="xs" variant="destructive">删除</Button></TableCell></TableRow>)}</TableBody>
            </Table>
          </div>
          <div className="flex items-center gap-3 border-t p-3 text-xs"><strong>共 {selectedMedications.length} 种药品</strong><span className="ml-auto text-muted-foreground">预计费用</span><strong className="tabular-nums">¥ 68.30</strong></div>
        </section>

        <section className="rounded-md border bg-background">
          <PanelHeader action={<Badge variant="success">可取药</Badge>} title="处方结果" />
          <div className="p-3 text-xs">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2"><SummaryFact label="处方编号" value="RX20250606123001" /><SummaryFact label="总费用" value="¥ 68.30" /><SummaryFact label="医保支付" value="¥ 48.10" /><SummaryFact label="自费" value="¥ 20.20" /><SummaryFact label="审方状态" value={signed ? '已审方' : '待审方'} /><SummaryFact label="药房状态" value="待发药" /><SummaryFact label="开方医生" value="张医生" /><SummaryFact label="开方时间" value="2025-06-06 09:18" /><SummaryFact label="有效期至" value="2025-05-08 23:59" /></dl>
            <div className="mt-3 border-t pt-3"><strong>用药交代摘要</strong><p className="mt-1 leading-5">按时按量服药，多饮水，注意休息，清淡饮食。如持续高热、呼吸困难或症状加重，请及时就医。</p></div>
            <Alert className="mt-3" variant="destructive"><ShieldAlertIcon /><AlertTitle>药物相互作用 / 过敏校验</AlertTitle><AlertDescription>患者过敏史：青霉素。本处方未含青霉素及相关药物，校验通过。</AlertDescription></Alert>
            <Button className="mt-2" size="xs" variant="link">完整校验报告<ChevronDownIcon data-icon="inline-end" /></Button>
          </div>
          <div className="flex items-center justify-end gap-2 border-t p-3"><Button size="sm" variant="outline"><SaveIcon data-icon="inline-start" />保存为常用处方</Button><Button disabled={signed} onClick={() => setSigned(true)} size="sm"><CircleCheckIcon data-icon="inline-start" />{signed ? '处方已签署' : '核对并签署'}</Button></div>
        </section>
      </div>

      <div className="grid gap-3 xl:grid-cols-[48%_minmax(0,52%)]">
        <section className="rounded-md border bg-background"><PanelHeader action={<Button size="xs" variant="link"><PrinterIcon data-icon="inline-start" />打印用药指导单</Button>} title="用药说明 / 患者教育" /><div className="grid gap-2 p-3"><EducationRow text="对乙酰氨基酚片：退热止痛，出现皮疹、肝区不适请停药就医。" /><EducationRow text="氨溴索口服液：化痰，饭后服用，多饮水，促进痰液排出。" /><EducationRow text="盐酸氨溴索片：清除黏痰，缓解发热、咳嗽等症状。" /><EducationRow text="氯雷他定片：抗过敏，嗜睡者避免驾车或高空作业。" /></div></section>
        <section className="rounded-md border bg-background"><PanelHeader title="处方历史 / 常用方案" /><div className="p-3"><div className="mb-2 flex gap-4 text-xs"><strong className="text-primary">历史处方</strong><span className="text-muted-foreground">常用方案</span></div><Table><TableBody><TableRow><TableCell className="text-xs">2025-04-22</TableCell><TableCell className="text-xs">普通感冒（咳嗽）</TableCell><TableCell className="text-xs">4 种药品</TableCell><TableCell className="text-xs">¥ 56.20</TableCell><TableCell><Button size="xs" variant="link">查看</Button></TableCell></TableRow><TableRow><TableCell className="text-xs">2025-03-18</TableCell><TableCell className="text-xs">过敏性鼻炎</TableCell><TableCell className="text-xs">3 种药品</TableCell><TableCell className="text-xs">¥ 32.50</TableCell><TableCell><Button size="xs" variant="link">查看</Button></TableCell></TableRow><TableRow><TableCell className="text-xs">2025-02-10</TableCell><TableCell className="text-xs">急性上呼吸道感染</TableCell><TableCell className="text-xs">3 种药品</TableCell><TableCell className="text-xs">¥ 28.60</TableCell><TableCell><Button size="xs" variant="link">查看</Button></TableCell></TableRow></Table><div className="mt-2 flex justify-between"><Button size="xs" variant="link">更多历史处方</Button><Button size="xs" variant="outline">复用所选方案</Button></div></div></section>
      </div>
    </div>
  )
}

function SummaryFact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="flex gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="font-medium">{value}</dd></div>
}

function EducationRow({ text }: { text: string }): React.JSX.Element {
  return <div className="flex items-start gap-2 text-xs leading-5"><FileTextIcon className="mt-0.5 size-4 shrink-0 text-info" /><p>{text}</p></div>
}

function PanelHeader({ action, aside, title }: { action?: React.ReactNode; aside?: string; title: string }): React.JSX.Element {
  return <header className="flex min-h-11 items-center gap-3 border-b px-3"><h3 className="text-sm font-semibold">{title}</h3>{aside === undefined ? null : <span className="text-xs text-muted-foreground">{aside}</span>}<div className="ml-auto">{action}</div></header>
}

function ClinicalAssistant({ adviceVersion, generated, onGenerate, onRefresh, onToggle, open }: {
  adviceVersion: number
  generated: boolean
  onGenerate: () => void
  onRefresh: () => void
  onToggle: () => void
  open: boolean
}): React.JSX.Element {
  if (!open) {
    return (
      <aside className="flex flex-col items-center border-l bg-background py-3">
        <Tooltip><TooltipTrigger render={<Button aria-label="展开临床助手" onClick={onToggle} size="icon-sm" variant="ghost" />}><PanelLeftOpenIcon /></TooltipTrigger><TooltipContent side="left">展开临床助手</TooltipContent></Tooltip>
        <BotIcon className="mt-4 size-5 text-info" />
        <Badge className="mt-2" variant="info">AI</Badge>
      </aside>
    )
  }

  const fourthSuggestion = adviceVersion === 0 ? '建议休息、多饮水，清淡饮食' : '复核过敏史后再选择抗菌药物'
  return (
    <aside className="flex min-w-0 flex-col border-l bg-muted/10">
      <header className="flex h-16 items-center gap-2 border-b bg-background px-3">
        <span className="flex size-8 items-center justify-center rounded-md bg-info/10 text-info"><BotIcon className="size-4" /></span>
        <h2 className="text-base font-semibold">临床助手</h2>
        <Badge className="ml-auto" variant="success">AI</Badge>
        <Button aria-label="收起临床助手" onClick={onToggle} size="icon-sm" title="收起临床助手" variant="ghost"><PanelLeftCloseIcon /></Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-3">
          <AssistantPanel className="border-info/20 bg-info/5" icon={SparklesIcon} title="下一步建议" titleAction={<Button onClick={onRefresh} size="xs" variant="link"><RefreshCwIcon data-icon="inline-start" />换一换</Button>}>
            <ol className="flex flex-col gap-2">{['建议完善血常规、CRP，必要时胸部影像', '注意监测体温变化，必要时复查血常规', '评估血压控制情况，指导用药依从性', fourthSuggestion].map((item, index) => <li className="flex gap-2 text-xs leading-5" key={item}><span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-info/10 text-[0.625rem] font-medium text-info">{index + 1}</span><span>{item}</span></li>)}</ol>
          </AssistantPanel>

          <AssistantPanel icon={CircleCheckIcon} title="医患对话摘要">
            <div className="flex flex-col gap-1.5 text-xs leading-5"><p><strong>患者：</strong>医生，我这两天咳嗽得厉害，喉咙也痛。</p><p><strong>医生：</strong>有没有发热？体温最高多少？</p><p><strong>患者：</strong>昨天开始发烧，最高 38 度多一点。</p><p><strong>医生：</strong>有胸痛或胸闷的情况吗？</p><p><strong>患者：</strong>有点痰，胸口不闷。</p></div>
            <Button className="mt-2" size="xs" variant="link">展开全部<ChevronDownIcon data-icon="inline-end" /></Button>
          </AssistantPanel>

          <AssistantPanel className="border-destructive/20 bg-destructive/5" icon={ShieldAlertIcon} title="风险提醒">
            <div className="flex flex-col gap-3 text-xs"><div><p className="font-medium text-destructive">青霉素过敏史</p><p className="mt-1 text-muted-foreground">避免使用头孢类、青霉素类抗生素。</p></div><div><p className="font-medium text-destructive">用药相互作用</p><p className="mt-1 text-muted-foreground">氨溴索与部分镇咳药合用需谨慎，请确认用药。</p></div></div>
            <Button className="mt-2" size="xs" variant="link">查看详情<ChevronDownIcon data-icon="inline-end" /></Button>
          </AssistantPanel>

          <AssistantPanel icon={ClipboardPlusIcon} title="辅助诊断建议">
            <div className="flex flex-col gap-3"><ScoreRow label="急性上呼吸道感染" score={82} /><ScoreRow label="慢性咳嗽" score={56} /><ScoreRow label="急性支气管炎" score={41} /><ScoreRow label="支气管哮喘" score={33} /></div>
            <p className="mt-3 text-[0.6875rem] leading-4 text-muted-foreground">基于历史相似病例与当前检查结果。</p>
          </AssistantPanel>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 border-t bg-background p-3">
        <Button onClick={onGenerate}><SparklesIcon data-icon="inline-start" />{generated ? '病历已生成' : '一键生成病历'}</Button>
        <Button variant="outline">采纳建议</Button>
      </div>
    </aside>
  )
}

function AssistantPanel({ children, className, icon: Icon, title, titleAction }: {
  children: React.ReactNode
  className?: string
  icon: typeof BotIcon
  title: string
  titleAction?: React.ReactNode
}): React.JSX.Element {
  return (
    <section className={cn('rounded-md border bg-background p-3', className)}>
      <div className="mb-3 flex items-center gap-2"><Icon className="size-4 text-primary" /><h3 className="text-sm font-semibold">{title}</h3><div className="ml-auto">{titleAction}</div></div>
      {children}
    </section>
  )
}

function ScoreRow({ label, score }: { label: string; score: number }): React.JSX.Element {
  return <div className="grid grid-cols-[minmax(0,1fr)_2rem_4.5rem] items-center gap-2"><span className="truncate text-xs">{label}</span><span className="text-right text-[0.6875rem] tabular-nums text-muted-foreground">{(score / 100).toFixed(2)}</span><Progress value={score} /></div>
}
