import { createAvatar } from '@dicebear/core'
import * as lorelei from '@dicebear/lorelei'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@clinmesh/ui/components/avatar'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@clinmesh/ui/components/input-group'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@clinmesh/ui/components/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@clinmesh/ui/components/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { cn } from '@clinmesh/ui/lib/utils'
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleAlertIcon,
  FileTextIcon,
  HistoryIcon,
  HospitalIcon,
  ListFilterIcon,
  PlusIcon,
  SearchIcon,
  ShieldAlertIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  StethoscopeIcon,
  UserPlusIcon,
} from 'lucide-react'
import { useState } from 'react'

type CandidateId = 'a' | 'b' | 'c' | 'd' | 'e'
type PatientStatus = 'active' | 'available' | 'used'
type ProviderId = 'builtin' | 'synthea'

interface PatientHistoryItem {
  date: string
  detail: string
  facility: string
  kind: '检查' | '门诊' | '住院'
  title: string
}

interface SyntheticPatient {
  address: string
  age: number
  allergy: string
  batch: string
  birthDate: string
  chronic: string[]
  email: string
  gender: '女' | '男'
  history: PatientHistoryItem[]
  id: string
  insurance: string
  labs: Array<{ flag: '异常' | '正常' | '偏高'; item: string; value: string }>
  lastVisit: string
  mappingWarnings: number
  medications: string[]
  mrn: string
  name: string
  phone: string
  provider: 'ClinMesh 快速模板' | 'Synthea 完整病史'
  status: PatientStatus
  vaccinations: Array<{ date: string; name: string }>
  visitTheme: string
}

const candidateOptions = [
  { description: '最贴近参考图，患者目录与完整病案并行', id: 'a', label: 'A · 参考病案台' },
  { description: '患者表格优先，右侧检查器适合批量操作', id: 'b', label: 'B · 患者注册簿' },
  { description: '纵向病史为中心，突出 Synthea 时间序列', id: 'c', label: 'C · 纵向时间轴' },
  { description: '按可用状态组织患者，强调进入业务流程', id: 'd', label: 'D · 候诊运营台' },
  { description: '减少右栏，适合中等宽度与连续编辑', id: 'e', label: 'E · 紧凑双栏' },
] as const satisfies ReadonlyArray<{ description: string; id: CandidateId; label: string }>

const baseHistory: PatientHistoryItem[] = [
  { date: '2026-06-18', detail: '主诉：口渴、多饮；诊断：2 型糖尿病随访', facility: '合成市第一医院 · 内科', kind: '门诊', title: '糖尿病随访' },
  { date: '2025-11-03', detail: 'HbA1c 8.4%，随机血糖 12.9 mmol/L', facility: '合成社区卫生中心', kind: '检查', title: '代谢指标复查' },
  { date: '2024-08-22', detail: '主诉：发热、咽痛 3 天；对症处理后好转', facility: '合成市第一医院 · 全科', kind: '门诊', title: '急性上呼吸道感染' },
  { date: '2023-04-10', detail: '年度体检，发现血压升高', facility: '合成体检中心', kind: '检查', title: '年度健康体检' },
]

const patients: readonly [SyntheticPatient, ...SyntheticPatient[]] = [
  {
    address: '江苏省苏州市张家港市杨舍镇人民中路 123 号', age: 45, allergy: '青霉素：皮疹', batch: 'SYN-20260827-01', birthDate: '1981-03-15',
    chronic: ['2 型糖尿病', '高血压'], email: 'zhangwei@example.test', gender: '男', history: baseHistory, id: 'synthetic-patient-001',
    insurance: '模拟城镇职工医保', labs: [{ flag: '正常', item: '血常规', value: '正常' }, { flag: '异常', item: 'HbA1c', value: '8.4%' }, { flag: '偏高', item: '随机血糖', value: '12.9 mmol/L' }],
    lastVisit: '2026-06-18', mappingWarnings: 2, medications: ['二甲双胍片 500 mg', '氨氯地平片 5 mg'], mrn: 'SYN000001', name: '张伟', phone: '138****1234',
    provider: 'Synthea 完整病史', status: 'available', vaccinations: [{ date: '2025-10-15', name: '流感疫苗' }, { date: '2023-05-20', name: '甲肝疫苗' }], visitTheme: '糖尿病随访',
  },
  {
    address: '浙江省杭州市拱墅区湖墅南路 76 号', age: 32, allergy: '否认药物过敏', batch: 'SYN-20260827-01', birthDate: '1994-09-08',
    chronic: [], email: 'liqing@example.test', gender: '女', history: baseHistory.slice(2), id: 'synthetic-patient-002', insurance: '模拟城乡居民医保',
    labs: [{ flag: '正常', item: '血常规', value: '正常' }, { flag: '正常', item: 'C 反应蛋白', value: '4.2 mg/L' }], lastVisit: '2024-08-22', mappingWarnings: 0,
    medications: [], mrn: 'SYN000002', name: '李静', phone: '139****0821', provider: 'Synthea 完整病史', status: 'used', vaccinations: [{ date: '2025-10-21', name: '流感疫苗' }], visitTheme: '发热门诊',
  },
  {
    address: '四川省成都市武侯区人民南路四段 18 号', age: 28, allergy: '磺胺类：荨麻疹', batch: 'SYN-20260826-03', birthDate: '1998-01-19',
    chronic: ['过敏性鼻炎'], email: 'wangfang@example.test', gender: '女', history: baseHistory.slice(1), id: 'synthetic-patient-003', insurance: '模拟城乡居民医保',
    labs: [{ flag: '偏高', item: '体温', value: '38.6 °C' }, { flag: '正常', item: '血常规', value: '正常' }], lastVisit: '2026-08-26', mappingWarnings: 1,
    medications: ['氯雷他定片 10 mg'], mrn: 'SYN000003', name: '王芳', phone: '136****5108', provider: 'Synthea 完整病史', status: 'active', vaccinations: [], visitTheme: '发热门诊',
  },
  {
    address: '湖北省武汉市江岸区建设大道 216 号', age: 61, allergy: '否认药物过敏', batch: 'SYN-20260826-03', birthDate: '1965-12-02',
    chronic: ['高血压', '脂肪肝'], email: 'liuyang@example.test', gender: '男', history: baseHistory, id: 'synthetic-patient-004', insurance: '模拟城镇职工医保',
    labs: [{ flag: '异常', item: '肝功能', value: 'ALT 68 U/L' }, { flag: '偏高', item: '血压', value: '156/92 mmHg' }], lastVisit: '2026-02-11', mappingWarnings: 3,
    medications: ['氨氯地平片 5 mg'], mrn: 'SYN000004', name: '刘洋', phone: '137****6620', provider: 'ClinMesh 快速模板', status: 'available', vaccinations: [{ date: '2025-09-30', name: '流感疫苗' }], visitTheme: '慢病随访',
  },
  {
    address: '广东省深圳市南山区科技南十二路 9 号', age: 37, allergy: '头孢类：胃肠不适', batch: 'SYN-20260825-02', birthDate: '1989-07-23',
    chronic: [], email: 'chenming@example.test', gender: '男', history: baseHistory.slice(2), id: 'synthetic-patient-005', insurance: '模拟自费',
    labs: [{ flag: '正常', item: '心电图', value: '窦性心律' }], lastVisit: '2025-12-16', mappingWarnings: 0, medications: [], mrn: 'SYN000005', name: '陈明', phone: '135****9042',
    provider: 'Synthea 完整病史', status: 'used', vaccinations: [], visitTheme: '发热门诊',
  },
  {
    address: '山东省青岛市市南区香港中路 41 号', age: 51, allergy: '否认药物过敏', batch: 'SYN-20260825-02', birthDate: '1975-05-11',
    chronic: ['2 型糖尿病'], email: 'zhaomin@example.test', gender: '女', history: baseHistory.slice(0, 3), id: 'synthetic-patient-006', insurance: '模拟城镇职工医保',
    labs: [{ flag: '异常', item: 'HbA1c', value: '9.1%' }, { flag: '偏高', item: '随机血糖', value: '13.8 mmol/L' }], lastVisit: '2026-05-12', mappingWarnings: 2,
    medications: ['二甲双胍片 500 mg'], mrn: 'SYN000006', name: '赵敏', phone: '138****7633', provider: 'Synthea 完整病史', status: 'available', vaccinations: [{ date: '2024-10-18', name: '流感疫苗' }], visitTheme: '糖尿病随访',
  },
]

const initialPatient = patients[0]

const statusMeta = {
  active: { label: '进行中就诊', variant: 'info' },
  available: { label: '可发起就诊', variant: 'success' },
  used: { label: '历史已使用', variant: 'secondary' },
} as const

const visitThemeItems = [
  { label: '发热门诊', value: 'fever' },
  { label: '糖尿病随访', value: 'diabetes' },
] as const

const departmentItems = [
  { label: '全科医学科', value: 'general' },
  { label: '内科', value: 'internal' },
] as const

const visitTypeItems = [
  { label: '普通门诊', value: 'general' },
  { label: '慢病复诊', value: 'follow-up' },
] as const

const avatarCache = new Map<string, string>()

function avatarDataUri(seed: string): string {
  const cached = avatarCache.get(seed)
  if (cached !== undefined) return cached
  const value = createAvatar(lorelei, { seed: `clinmesh:${seed}` }).toDataUri()
  avatarCache.set(seed, value)
  return value
}

function PatientAvatar({ patient, className }: { className?: string; patient: SyntheticPatient }) {
  return (
    <Avatar className={cn('size-10 bg-muted', className)}>
      <AvatarImage alt={`${patient.name}的合成头像`} src={avatarDataUri(patient.id)} />
      <AvatarFallback>{patient.name.slice(0, 1)}</AvatarFallback>
    </Avatar>
  )
}

function StaffAvatar() {
  return (
    <Avatar className="size-8 bg-muted">
      <AvatarImage alt="合成管理员头像" src={avatarDataUri('practitioner-administrator')} />
      <AvatarFallback>管</AvatarFallback>
    </Avatar>
  )
}

function StatusBadge({ status }: { status: PatientStatus }) {
  const meta = statusMeta[status]
  return <Badge variant={meta.variant}>{meta.label}</Badge>
}

function PatientDirectory({
  activeId,
  className,
  onSelect,
  queuedIds,
}: {
  activeId: string
  className?: string
  onSelect: (id: string) => void
  queuedIds: ReadonlySet<string>
}) {
  return (
    <aside className={cn('flex min-h-0 flex-col border-r bg-background', className)}>
      <div className="flex items-center gap-2 border-b p-3">
        <InputGroup className="min-w-0 flex-1">
          <InputGroupAddon><SearchIcon aria-hidden="true" /></InputGroupAddon>
          <InputGroupInput aria-label="搜索合成患者" placeholder="姓名、MRN 或批次" />
        </InputGroup>
        <Button aria-label="筛选患者" size="icon" title="筛选患者" variant="outline">
          <ListFilterIcon />
        </Button>
      </div>
      <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
        <span>全部患者 {patients.length}</span>
        <span>每批最多 10 人</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {patients.map(patient => (
          <button
            className={cn(
              'flex w-full items-center gap-3 border-b px-2 py-3 text-left transition-colors hover:bg-muted/60',
              activeId === patient.id && 'rounded-md border border-primary/30 bg-primary/5',
            )}
            key={patient.id}
            onClick={() => onSelect(patient.id)}
            type="button"
          >
            <PatientAvatar patient={patient} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <strong className="truncate text-sm">{patient.name}</strong>
                <span className="text-xs text-muted-foreground">{patient.gender} · {patient.age}岁</span>
              </span>
              <span className="mt-1 block truncate text-xs text-muted-foreground">MRN: {patient.mrn}</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">{patient.visitTheme} · {patient.lastVisit}</span>
            </span>
            {queuedIds.has(patient.id) ? <CheckCircle2Icon className="size-4 text-success" /> : null}
          </button>
        ))}
      </div>
    </aside>
  )
}

function PatientIdentityHeader({ compact = false, patient, onQueue }: { compact?: boolean; onQueue: () => void; patient: SyntheticPatient }) {
  return (
    <header className="border-b bg-background px-4 py-4 lg:px-5">
      <div className="flex flex-wrap items-start gap-4">
        <PatientAvatar className={compact ? 'size-12' : 'size-16'} patient={patient} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold">{patient.name}</h2>
            <Badge variant="outline">{patient.gender}</Badge>
            <span className="text-sm text-muted-foreground">{patient.age}岁（{patient.birthDate}）</span>
            <StatusBadge status={patient.status} />
          </div>
          <div className={cn('mt-3 grid gap-x-6 gap-y-1 text-sm text-muted-foreground', compact ? 'grid-cols-1' : 'sm:grid-cols-2 xl:grid-cols-4')}>
            <span>MRN：<strong className="font-medium text-foreground">{patient.mrn}</strong></span>
            <span>手机：<strong className="font-medium text-foreground">{patient.phone}</strong></span>
            <span>来源：<strong className="font-medium text-foreground">{patient.provider}</strong></span>
            <span>批次：<strong className="font-medium text-foreground">{patient.batch}</strong></span>
          </div>
        </div>
        <Button className={compact ? 'w-full' : 'w-full sm:w-auto'} disabled={patient.status === 'active'} onClick={onQueue}>
          <UserPlusIcon data-icon="inline-start" />
          发起门诊就诊
        </Button>
      </div>
    </header>
  )
}

function ProfileFacts({ patient }: { patient: SyntheticPatient }) {
  return (
    <div className="grid border-b sm:grid-cols-2 xl:grid-cols-4">
      {[
        ['基本信息', `${patient.gender} · ${patient.birthDate}`, `模拟身份证 3205********150012`],
        ['地址', patient.address, '确定性中国合成地址'],
        ['联系方式', patient.phone, patient.email],
        ['模拟保险', patient.insurance, '仅档案展示，不参与结算'],
      ].map(([title, primary, secondary]) => (
        <section className="min-w-0 border-b p-4 sm:border-r xl:border-b-0" key={title}>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="mt-2 break-words text-sm">{primary}</p>
          <p className="mt-1 break-words text-xs text-muted-foreground">{secondary}</p>
        </section>
      ))}
    </div>
  )
}

function HistoryTimeline({ patient, compact = false }: { compact?: boolean; patient: SyntheticPatient }) {
  return (
    <div className="flex flex-col gap-0">
      {patient.history.map(item => (
        <div className="relative grid grid-cols-[80px_minmax(0,1fr)] gap-3 pb-4" key={`${item.date}-${item.title}`}>
          <div className="pt-1 text-xs text-muted-foreground">{item.date}</div>
          <div className={cn('relative border-l pl-4', compact ? 'pb-2' : 'pb-4')}>
            <span className="absolute -left-1.5 top-1.5 size-3 rounded-full border-2 border-primary bg-background" />
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{item.kind}</Badge>
              <strong className="text-sm">{item.title}</strong>
            </div>
            <p className="mt-1 text-sm">{item.detail}</p>
            {!compact ? <p className="mt-1 text-xs text-muted-foreground">{item.facility}</p> : null}
          </div>
        </div>
      ))}
    </div>
  )
}

function InsightRail({ patient }: { patient: SyntheticPatient }) {
  return (
    <aside className="flex flex-col gap-3 border-l bg-muted/15 p-3">
      <section className="border-b bg-background p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">重要提示</h3>
          <ShieldAlertIcon className="size-4 text-warning" />
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge variant="destructive">{patient.allergy}</Badge>
          {patient.chronic.map(item => <Badge key={item} variant="warning">{item}</Badge>)}
        </div>
      </section>
      <section className="border-b bg-background p-3">
        <h3 className="text-sm font-semibold">当前用药</h3>
        {patient.medications.length === 0
          ? <p className="mt-3 text-sm text-muted-foreground">无长期用药记录</p>
          : <ul className="mt-3 flex flex-col gap-2 text-sm">{patient.medications.map(item => <li key={item}>{item}</li>)}</ul>}
      </section>
      <section className="border-b bg-background p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">近期检查</h3>
          <span className="text-xs text-muted-foreground">最近 6 个月</span>
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {patient.labs.map(lab => (
            <div className="grid grid-cols-[1fr_auto] gap-2 text-sm" key={lab.item}>
              <span>{lab.item}<span className="ml-2 text-muted-foreground">{lab.value}</span></span>
              <span className={cn(lab.flag === '正常' ? 'text-success' : 'text-warning-foreground')}>{lab.flag}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="bg-background p-3">
        <h3 className="text-sm font-semibold">来源质量</h3>
        <p className="mt-2 text-sm">{patient.provider}</p>
        <p className="mt-1 text-xs text-muted-foreground">FHIR R4 原始 Bundle 已保存</p>
        <Badge className="mt-2" variant={patient.mappingWarnings === 0 ? 'success' : 'warning'}>
          {patient.mappingWarnings === 0 ? '映射完整' : `${patient.mappingWarnings} 项待映射`}
        </Badge>
      </section>
    </aside>
  )
}

function PatientRecordTabs({ patient }: { patient: SyntheticPatient }) {
  return (
    <Tabs defaultValue="record">
      <TabsList className="max-w-full overflow-x-auto" variant="line">
        <TabsTrigger value="record">健康档案</TabsTrigger>
        <TabsTrigger value="visits">就诊历史</TabsTrigger>
        <TabsTrigger value="labs">检查检验</TabsTrigger>
        <TabsTrigger value="medications">用药</TabsTrigger>
        <TabsTrigger value="vaccines">疫苗</TabsTrigger>
        <TabsTrigger value="source">来源数据</TabsTrigger>
      </TabsList>
      <TabsContent className="pt-4" value="record">
        <div className="grid gap-4 md:grid-cols-3">
          <section className="border-b pb-3"><h3 className="text-sm font-semibold">既往病史</h3><p className="mt-2 text-sm">{patient.chronic.join('、') || '无明确慢性病'}</p></section>
          <section className="border-b pb-3"><h3 className="text-sm font-semibold">过敏史</h3><p className="mt-2 text-sm">{patient.allergy}</p></section>
          <section className="border-b pb-3"><h3 className="text-sm font-semibold">本次建议主题</h3><p className="mt-2 text-sm">{patient.visitTheme}</p></section>
        </div>
      </TabsContent>
      <TabsContent className="pt-4" value="visits"><HistoryTimeline patient={patient} /></TabsContent>
      <TabsContent className="pt-4" value="labs">
        <Table><TableHeader><TableRow><TableHead>项目</TableHead><TableHead>结果</TableHead><TableHead>标记</TableHead></TableRow></TableHeader><TableBody>{patient.labs.map(lab => <TableRow key={lab.item}><TableCell>{lab.item}</TableCell><TableCell>{lab.value}</TableCell><TableCell>{lab.flag}</TableCell></TableRow>)}</TableBody></Table>
      </TabsContent>
      <TabsContent className="pt-4" value="medications"><ul className="flex flex-col gap-2">{patient.medications.map(item => <li className="border-b py-2" key={item}>{item}</li>)}</ul></TabsContent>
      <TabsContent className="pt-4" value="vaccines"><ul className="flex flex-col gap-2">{patient.vaccinations.map(item => <li className="flex justify-between border-b py-2" key={item.name}><span>{item.name}</span><span className="text-muted-foreground">{item.date}</span></li>)}</ul></TabsContent>
      <TabsContent className="pt-4" value="source">
        <Alert><FileTextIcon /><AlertTitle>Synthea FHIR R4 来源只读</AlertTitle><AlertDescription>Bundle、source hash 和 mapping version 独立保存；重新映射会创建新的 Profile revision，不覆盖既有就诊。</AlertDescription></Alert>
      </TabsContent>
    </Tabs>
  )
}

interface CandidateProps {
  onQueue: (patients: readonly SyntheticPatient[]) => void
  onSelect: (id: string) => void
  patient: SyntheticPatient
  queuedIds: ReadonlySet<string>
  selectedIds: ReadonlySet<string>
  toggleSelected: (id: string) => void
}

function ReferenceCandidate({ onQueue, onSelect, patient, queuedIds }: CandidateProps) {
  return (
    <div className="grid min-h-[720px] border lg:grid-cols-[270px_minmax(0,1fr)]">
      <PatientDirectory activeId={patient.id} onSelect={onSelect} queuedIds={queuedIds} />
      <div className="min-w-0 bg-background">
        <PatientIdentityHeader onQueue={() => onQueue([patient])} patient={patient} />
        <ProfileFacts patient={patient} />
        <div className="grid min-h-[430px] xl:grid-cols-[minmax(0,1fr)_300px]">
          <main className="min-w-0 p-4"><PatientRecordTabs patient={patient} /></main>
          <InsightRail patient={patient} />
        </div>
      </div>
    </div>
  )
}

function RegistryCandidate({ onQueue, onSelect, patient, queuedIds, selectedIds, toggleSelected }: CandidateProps) {
  const selectedPatients = patients.filter(item => selectedIds.has(item.id))

  return (
    <div className="grid min-h-[720px] border xl:grid-cols-[minmax(0,1fr)_420px]">
      <main className="min-w-0 bg-background">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <InputGroup className="min-w-56 flex-1"><InputGroupAddon><SearchIcon aria-hidden="true" /></InputGroupAddon><InputGroupInput aria-label="搜索患者注册簿" placeholder="搜索患者、MRN、批次" /></InputGroup>
          <Button variant="outline"><SlidersHorizontalIcon data-icon="inline-start" />筛选</Button>
          <Button disabled={selectedPatients.length === 0} onClick={() => onQueue(selectedPatients)}><UserPlusIcon data-icon="inline-start" />批量发起 {selectedPatients.length || ''}</Button>
        </div>
        <Table>
          <TableHeader><TableRow><TableHead className="w-10"><span className="sr-only">选择</span></TableHead><TableHead>患者</TableHead><TableHead>来源</TableHead><TableHead>建议主题</TableHead><TableHead>映射</TableHead><TableHead>状态</TableHead><TableHead className="w-12"><span className="sr-only">详情</span></TableHead></TableRow></TableHeader>
          <TableBody>{patients.map(item => {
            const selectionDisabled = item.status === 'active' || queuedIds.has(item.id)
            return <TableRow className={cn(item.id === patient.id && 'bg-primary/5')} key={item.id}><TableCell><Checkbox aria-label={`选择 ${item.name}`} checked={selectedIds.has(item.id)} disabled={selectionDisabled} onCheckedChange={() => toggleSelected(item.id)} /></TableCell><TableCell><button className="flex items-center gap-2 text-left" onClick={() => onSelect(item.id)} type="button"><PatientAvatar className="size-8" patient={item} /><span><strong className="block text-sm">{item.name}</strong><small className="text-muted-foreground">{item.mrn}</small></span></button></TableCell><TableCell><span className="text-sm">{item.provider}</span><small className="block text-muted-foreground">{item.batch}</small></TableCell><TableCell>{item.visitTheme}</TableCell><TableCell>{item.mappingWarnings === 0 ? <Badge variant="success">完整</Badge> : <Badge variant="warning">{item.mappingWarnings} 项</Badge>}</TableCell><TableCell>{queuedIds.has(item.id) ? <Badge variant="info">已加入</Badge> : <StatusBadge status={item.status} />}</TableCell><TableCell><Button aria-label={`查看 ${item.name}`} onClick={() => onSelect(item.id)} size="icon" title={`查看 ${item.name}`} variant="ghost"><ChevronRightIcon /></Button></TableCell></TableRow>
          })}</TableBody>
        </Table>
      </main>
      <aside className="border-l bg-muted/10">
        <PatientIdentityHeader compact onQueue={() => onQueue([patient])} patient={patient} />
        <div className="flex flex-col gap-4 p-4">
          <section><h3 className="text-sm font-semibold">重要提示</h3><div className="mt-2 flex flex-wrap gap-1"><Badge variant="destructive">{patient.allergy}</Badge>{patient.chronic.map(item => <Badge key={item} variant="warning">{item}</Badge>)}</div></section>
          <section><h3 className="text-sm font-semibold">最近记录</h3><div className="mt-3"><HistoryTimeline compact patient={patient} /></div></section>
        </div>
      </aside>
    </div>
  )
}

function TimelineCandidate({ onQueue, onSelect, patient, queuedIds }: CandidateProps) {
  return (
    <div className="min-h-[720px] border bg-background">
      <div className="flex gap-2 overflow-x-auto border-b p-3">
        {patients.map(item => <button className={cn('flex min-w-44 items-center gap-2 rounded-md border px-2 py-2 text-left', item.id === patient.id && 'border-primary bg-primary/5')} key={item.id} onClick={() => onSelect(item.id)} type="button"><PatientAvatar className="size-8" patient={item} /><span><strong className="block text-sm">{item.name}</strong><small className="text-muted-foreground">{item.visitTheme}</small></span>{queuedIds.has(item.id) ? <CheckCircle2Icon className="ml-auto size-4 text-success" /> : null}</button>)}
      </div>
      <PatientIdentityHeader onQueue={() => onQueue([patient])} patient={patient} />
      <div className="grid lg:grid-cols-[230px_minmax(0,1fr)_270px]">
        <aside className="flex flex-col gap-4 border-r p-4">
          <section><h3 className="text-sm font-semibold">档案摘要</h3><dl className="mt-3 flex flex-col gap-2 text-sm"><div><dt className="text-muted-foreground">保险</dt><dd>{patient.insurance}</dd></div><div><dt className="text-muted-foreground">过敏</dt><dd>{patient.allergy}</dd></div><div><dt className="text-muted-foreground">来源</dt><dd>{patient.batch}</dd></div></dl></section>
          <section className="border-t pt-4"><h3 className="text-sm font-semibold">慢病</h3><div className="mt-2 flex flex-wrap gap-1">{patient.chronic.map(item => <Badge key={item} variant="warning">{item}</Badge>)}</div></section>
        </aside>
        <main className="min-w-0 p-5"><div className="mb-4 flex items-center gap-2"><HistoryIcon className="size-4" /><h3 className="text-sm font-semibold">完整纵向病史</h3><Badge variant="outline">FHIR R4</Badge></div><HistoryTimeline patient={patient} /></main>
        <InsightRail patient={patient} />
      </div>
    </div>
  )
}

function OperationsCandidate({ onQueue, onSelect, patient, queuedIds }: CandidateProps) {
  const groups = [
    { id: 'available', label: '待使用患者', patients: patients.filter(item => item.status === 'available' && !queuedIds.has(item.id)) },
    { id: 'used', label: '历史可复用', patients: patients.filter(item => item.status === 'used' && !queuedIds.has(item.id)) },
    { id: 'active', label: '已有活动就诊', patients: patients.filter(item => item.status === 'active' || queuedIds.has(item.id)) },
  ] as const
  return (
    <div className="min-h-[720px] border bg-background">
      <PatientIdentityHeader onQueue={() => onQueue([patient])} patient={patient} />
      <div className="grid border-b lg:grid-cols-3">
        {groups.map(group => <section className="min-w-0 border-b p-3 lg:border-b-0 lg:border-r" key={group.id}><div className="flex items-center justify-between"><h3 className="text-sm font-semibold">{group.label}</h3><Badge variant="outline">{group.patients.length}</Badge></div><div className="mt-3 flex flex-col gap-1">{group.patients.map(item => <button className={cn('flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted', item.id === patient.id && 'bg-primary/5')} key={item.id} onClick={() => onSelect(item.id)} type="button"><PatientAvatar className="size-8" patient={item} /><span className="min-w-0 flex-1"><strong className="block truncate text-sm">{item.name}</strong><small className="block truncate text-muted-foreground">{item.visitTheme} · {item.batch}</small></span>{item.mappingWarnings > 0 ? <CircleAlertIcon className="size-4 text-warning" /> : null}</button>)}</div></section>)}
      </div>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_320px]">
        <main className="p-4"><h3 className="mb-3 text-sm font-semibold">患者就诊准备度</h3><Table><TableBody><TableRow><TableCell>身份与联系方式</TableCell><TableCell><Badge variant="success">完整</Badge></TableCell></TableRow><TableRow><TableCell>临床来源历史</TableCell><TableCell><Badge variant="success">已保存</Badge></TableCell></TableRow><TableRow><TableCell>院内编码映射</TableCell><TableCell><Badge variant={patient.mappingWarnings === 0 ? 'success' : 'warning'}>{patient.mappingWarnings === 0 ? '完整' : `${patient.mappingWarnings} 项待处理`}</Badge></TableCell></TableRow><TableRow><TableCell>活动 Encounter</TableCell><TableCell><Badge variant={patient.status === 'active' ? 'warning' : 'secondary'}>{patient.status === 'active' ? '已有活动就诊' : '无'}</Badge></TableCell></TableRow></TableBody></Table></main>
        <aside className="border-l p-4"><h3 className="text-sm font-semibold">建议动作</h3><p className="mt-2 text-sm text-muted-foreground">预选全科医学科 · 普通门诊，提交后进入分诊队列。</p><Button className="mt-4 w-full" disabled={patient.status === 'active'} onClick={() => onQueue([patient])}><UserPlusIcon data-icon="inline-start" />发起门诊就诊</Button><Button className="mt-2 w-full" variant="outline"><FileTextIcon data-icon="inline-start" />处理映射问题</Button></aside>
      </div>
    </div>
  )
}

function CompactCandidate({ onQueue, onSelect, patient, queuedIds }: CandidateProps) {
  return (
    <div className="grid min-h-[720px] border md:grid-cols-[320px_minmax(0,1fr)]">
      <PatientDirectory activeId={patient.id} onSelect={onSelect} queuedIds={queuedIds} />
      <main className="min-w-0 bg-background">
        <PatientIdentityHeader onQueue={() => onQueue([patient])} patient={patient} />
        <div className="grid gap-0 lg:grid-cols-2">
          <section className="border-b p-4 lg:border-r"><h3 className="text-sm font-semibold">身份与保障</h3><dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">联系方式</dt><dd>{patient.phone}</dd></div><div><dt className="text-muted-foreground">模拟保险</dt><dd>{patient.insurance}</dd></div><div className="sm:col-span-2"><dt className="text-muted-foreground">地址</dt><dd>{patient.address}</dd></div></dl></section>
          <section className="border-b p-4"><h3 className="text-sm font-semibold">风险摘要</h3><div className="mt-3 flex flex-wrap gap-1"><Badge variant="destructive">{patient.allergy}</Badge>{patient.chronic.map(item => <Badge key={item} variant="warning">{item}</Badge>)}</div></section>
        </div>
        <div className="grid lg:grid-cols-2">
          <section className="border-r p-4"><h3 className="text-sm font-semibold">最近病史</h3><div className="mt-3"><HistoryTimeline compact patient={patient} /></div></section>
          <section className="p-4"><h3 className="text-sm font-semibold">近期检查与用药</h3><div className="mt-3 flex flex-col gap-2">{patient.labs.map(lab => <div className="flex justify-between border-b py-2 text-sm" key={lab.item}><span>{lab.item}</span><span>{lab.value}</span></div>)}</div><h3 className="mt-5 text-sm font-semibold">长期用药</h3><ul className="mt-2 flex flex-col gap-2 text-sm">{patient.medications.map(item => <li key={item}>{item}</li>)}</ul></section>
        </div>
      </main>
    </div>
  )
}

function GenerationSheet({ onOpenChange, open }: { onOpenChange: (open: boolean) => void; open: boolean }) {
  const [provider, setProvider] = useState<ProviderId>('synthea')
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-full sm:max-w-lg" side="right">
        <SheetHeader><SheetTitle>生成合成患者</SheetTitle><SheetDescription>整批最多 10 人；Synthea 批次全部成功后才写入患者库。</SheetDescription></SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4">
          <Field>
            <FieldLabel id="lab-provider-label">生成器</FieldLabel>
            <ToggleGroup
              aria-labelledby="lab-provider-label"
              className="w-full items-stretch"
              onValueChange={values => {
                const next = (values as ProviderId[])[0]
                if (next !== undefined) setProvider(next)
              }}
              spacing={2}
              value={[provider]}
              variant="outline"
            >
              <ToggleGroupItem className="h-auto min-w-0 flex-1 justify-start whitespace-normal p-3 text-left" value="synthea">
                <span><strong className="block text-sm">Synthea 完整病史</strong><span className="mt-1 block text-xs text-muted-foreground">纵向 FHIR R4 · 默认推荐</span></span>
              </ToggleGroupItem>
              <ToggleGroupItem className="h-auto min-w-0 flex-1 justify-start whitespace-normal p-3 text-left" value="builtin">
                <span><strong className="block text-sm">ClinMesh 快速模板</strong><span className="mt-1 block text-xs text-muted-foreground">固定病例 · 仅功能测试</span></span>
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <FieldGroup className="grid gap-3 sm:grid-cols-2"><Field><FieldLabel htmlFor="lab-generation-count">患者人数</FieldLabel><Input defaultValue="6" id="lab-generation-count" max={10} min={1} type="number" /></Field><Field><FieldLabel htmlFor="lab-history-years">历史年数</FieldLabel><Input defaultValue="15" id="lab-history-years" max={40} min={1} type="number" /></Field><Field><FieldLabel htmlFor="lab-age-min">最小年龄</FieldLabel><Input defaultValue="18" id="lab-age-min" max={120} min={0} type="number" /></Field><Field><FieldLabel htmlFor="lab-age-max">最大年龄</FieldLabel><Input defaultValue="80" id="lab-age-max" max={120} min={0} type="number" /></Field></FieldGroup>
          <Field>
            <FieldLabel htmlFor="lab-visit-theme">本次就诊主题</FieldLabel>
            <Select defaultValue="fever" items={visitThemeItems}>
              <SelectTrigger className="w-full" id="lab-visit-theme"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{visitThemeItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </Field>
          <FieldSet>
            <FieldLegend variant="label">纵向健康模块</FieldLegend>
            <FieldGroup className="gap-3">
              <Field orientation="horizontal"><Checkbox defaultChecked id="lab-metabolic-module" /><FieldLabel htmlFor="lab-metabolic-module">代谢综合征</FieldLabel></Field>
              <Field orientation="horizontal"><Checkbox defaultChecked id="lab-respiratory-module" /><FieldLabel htmlFor="lab-respiratory-module">鼻窦炎与呼吸道</FieldLabel></Field>
            </FieldGroup>
          </FieldSet>
          <details className="border-t pt-4"><summary className="cursor-pointer text-sm font-medium">高级复现参数</summary><FieldGroup className="mt-3 grid gap-3 sm:grid-cols-2"><Field><FieldLabel htmlFor="lab-population-seed">人口 seed</FieldLabel><Input defaultValue="4242" id="lab-population-seed" type="number" /></Field><Field><FieldLabel htmlFor="lab-provider-seed">Provider seed</FieldLabel><Input defaultValue="7331" id="lab-provider-seed" type="number" /></Field></FieldGroup></details>
        </div>
        <SheetFooter><Button onClick={() => onOpenChange(false)}><SparklesIcon data-icon="inline-start" />生成并保存到患者库</Button></SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function QueueSheet({ onConfirm, onOpenChange, open, patients: queuePatients }: { onConfirm: () => void; onOpenChange: (open: boolean) => void; open: boolean; patients: readonly SyntheticPatient[] }) {
  const batch = queuePatients.length > 1
  const patient = queuePatients[0] ?? initialPatient

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-full sm:max-w-md" side="right">
        <SheetHeader><SheetTitle>{batch ? '批量发起门诊就诊' : '发起门诊就诊'}</SheetTitle><SheetDescription>创建患者、挂号和分诊任务；已有历史不会被改写。</SheetDescription></SheetHeader>
        <div className="flex flex-col gap-4 px-4">
          {batch ? (
            <div className="flex flex-col gap-3 border-b pb-4">
              <strong>已选择 {queuePatients.length} 名患者</strong>
              <div className="flex flex-wrap gap-2">{queuePatients.map(item => <PatientAvatar className="size-8" key={item.id} patient={item} />)}</div>
              <p className="text-xs text-muted-foreground">{queuePatients.map(item => item.name).join('、')}</p>
            </div>
          ) : (
            <div className="flex items-center gap-3 border-b pb-4"><PatientAvatar patient={patient} /><div><strong>{patient.name}</strong><p className="text-xs text-muted-foreground">{patient.mrn} · {patient.visitTheme}</p></div></div>
          )}
          <Field>
            <FieldLabel htmlFor="lab-department">就诊科室</FieldLabel>
            <Select defaultValue="general" items={departmentItems}>
              <SelectTrigger className="w-full" id="lab-department"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{departmentItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="lab-visit-type">门诊类型</FieldLabel>
            <Select defaultValue="general" items={visitTypeItems}>
              <SelectTrigger className="w-full" id="lab-visit-type"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{visitTypeItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </Field>
          <Alert><StethoscopeIcon /><AlertTitle>提交后进入分诊队列</AlertTitle><AlertDescription>同一患者存在活动 Encounter 时将拒绝重复发起。</AlertDescription></Alert>
        </div>
        <SheetFooter><Button onClick={onConfirm}><UserPlusIcon data-icon="inline-start" />{batch ? `确认发起 ${queuePatients.length} 人就诊` : '确认发起就诊'}</Button></SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

export function DataGenerationLabPage(): React.JSX.Element {
  const [candidateId, setCandidateId] = useState<CandidateId>('a')
  const [patientId, setPatientId] = useState(initialPatient.id)
  const [generationOpen, setGenerationOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [queuePatients, setQueuePatients] = useState<readonly SyntheticPatient[]>([initialPatient])
  const [queuedIds, setQueuedIds] = useState<Set<string>>(() => new Set())
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const patient = patients.find(item => item.id === patientId) ?? initialPatient
  const candidate = candidateOptions.find(item => item.id === candidateId) ?? candidateOptions[0]
  const candidateProps: CandidateProps = {
    onQueue: (nextPatients: readonly SyntheticPatient[]) => { setQueuePatients(nextPatients); setQueueOpen(true) },
    onSelect: setPatientId,
    patient,
    queuedIds,
    selectedIds,
    toggleSelected: (id: string) => setSelectedIds(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    }),
  }

  return (
    <main className="min-h-svh bg-muted/25 text-foreground">
      <header className="sticky top-0 z-30 border-b bg-background/95">
        <div className="flex min-h-14 flex-wrap items-center gap-3 px-3 py-2 lg:px-5">
          <a className="flex items-center gap-2 text-sm font-semibold" href="/ui-dev"><HospitalIcon className="size-5 text-primary" />ClinMesh UI Lab</a>
          <span className="hidden text-muted-foreground sm:inline">/</span><span className="text-sm">合成患者库</span>
          <div className="ml-auto flex items-center gap-2"><Button onClick={() => setGenerationOpen(true)} size="sm"><PlusIcon data-icon="inline-start" />生成患者</Button><StaffAvatar /></div>
        </div>
        <div className="flex flex-col gap-2 border-t px-3 py-2 lg:flex-row lg:items-center lg:px-5">
          <ToggleGroup aria-label="数据生成页面候选" className="max-w-full justify-start overflow-x-auto" onValueChange={values => { const next = (values as CandidateId[])[0]; if (next !== undefined) setCandidateId(next) }} size="sm" spacing={0} value={[candidateId]} variant="outline">
            {candidateOptions.map(option => <ToggleGroupItem key={option.id} value={option.id}>{option.label}</ToggleGroupItem>)}
          </ToggleGroup>
          <p className="text-xs text-muted-foreground lg:ml-auto">{candidate.description}</p>
        </div>
      </header>
      <section className="mx-auto max-w-[1560px] p-3 lg:p-5">
        {candidateId === 'a' ? <ReferenceCandidate {...candidateProps} /> : null}
        {candidateId === 'b' ? <RegistryCandidate {...candidateProps} /> : null}
        {candidateId === 'c' ? <TimelineCandidate {...candidateProps} /> : null}
        {candidateId === 'd' ? <OperationsCandidate {...candidateProps} /> : null}
        {candidateId === 'e' ? <CompactCandidate {...candidateProps} /> : null}
      </section>
      <GenerationSheet onOpenChange={setGenerationOpen} open={generationOpen} />
      <QueueSheet
        onConfirm={() => {
          setQueuedIds(current => {
            const next = new Set(current)
            queuePatients.forEach(item => next.add(item.id))
            return next
          })
          setSelectedIds(current => {
            const next = new Set(current)
            queuePatients.forEach(item => next.delete(item.id))
            return next
          })
          setQueueOpen(false)
        }}
        onOpenChange={setQueueOpen}
        open={queueOpen}
        patients={queuePatients}
      />
    </main>
  )
}
