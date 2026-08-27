import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@clinmesh/ui/components/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@clinmesh/ui/components/tooltip'
import { cn } from '@clinmesh/ui/lib/utils'
import {
  ActivityIcon,
  BeakerIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  ClipboardCheckIcon,
  ClipboardListIcon,
  ComponentIcon,
  FileTextIcon,
  HospitalIcon,
  MoonIcon,
  PanelsTopLeftIcon,
  PillIcon,
  RotateCcwIcon,
  SunIcon,
  UserRoundIcon,
} from 'lucide-react'
import { useState } from 'react'
import {
  applyResolvedWebTheme,
  readWebPreferences,
  type ResolvedWebTheme,
  writeWebPreferences,
} from '../app/preferences.ts'

type LabView = 'workspace' | 'components'
type MotionProfile = 'quiet' | 'continuous' | 'emphatic'
type RefinementId = 'r1' | 'r2' | 'r3'
type ViewId = 'record' | 'orders' | 'results' | 'plan'
type WorkflowStatus = 'attention' | 'complete' | 'current' | 'pending'

interface Patient {
  age: number
  allergy: string
  assessment: string
  chiefComplaint: string
  encounterId: string
  exam: string
  gender: '女' | '男'
  history: string
  id: string
  name: string
  queueNumber: string
  vitalSigns: string
  waitMinutes: number
}

const refinements = [
  { id: 'r1', label: '完整状态' },
  { id: 'r2', label: '紧凑状态' },
  { id: 'r3', label: '任务强调' },
] as const satisfies ReadonlyArray<{ id: RefinementId; label: string }>

const patients = [
  {
    age: 34,
    allergy: '否认药物过敏',
    assessment: '发热待查，考虑急性上呼吸道感染。',
    chiefComplaint: '发热、咽痛 1 天。',
    encounterId: 'ENC-MZ-0017',
    exam: 'T 38.6 °C，咽部充血，双肺呼吸音清。',
    gender: '女',
    history: '昨日傍晚开始发热，最高 38.7 °C，伴咽痛，无明显胸闷、气促。',
    id: 'SYN-P-1042',
    name: '林若溪',
    queueNumber: 'MZ0017',
    vitalSigns: 'T 38.6 °C · P 96 · BP 118/76',
    waitMinutes: 12,
  },
  {
    age: 52,
    allergy: '青霉素皮疹史',
    assessment: '多饮、多尿待查。',
    chiefComplaint: '口渴、乏力 2 个月。',
    encounterId: 'ENC-MZ-0021',
    exam: '神清，心肺查体未见明显异常。',
    gender: '男',
    history: '近两个月饮水量和夜尿增多，体重下降约 3 kg。',
    id: 'SYN-P-1168',
    name: '赵川',
    queueNumber: 'MZ0021',
    vitalSigns: 'T 36.7 °C · P 82 · BP 136/84',
    waitMinutes: 8,
  },
  {
    age: 41,
    allergy: '否认药物过敏',
    assessment: '咳嗽待查。',
    chiefComplaint: '咳嗽、低热 4 天。',
    encounterId: 'ENC-MZ-0024',
    exam: '右下肺呼吸音稍低，未闻及明显湿啰音。',
    gender: '女',
    history: '干咳为主，夜间明显，无胸痛及呼吸困难。',
    id: 'SYN-P-1214',
    name: '顾宁',
    queueNumber: 'MZ0024',
    vitalSigns: 'T 37.8 °C · P 88 · BP 112/72',
    waitMinutes: 3,
  },
] as const satisfies readonly Patient[]

const stages = [
  { id: 'record', icon: FileTextIcon, label: '病历' },
  { id: 'orders', icon: BeakerIcon, label: '医嘱' },
  { id: 'results', icon: ActivityIcon, label: '结果' },
  { id: 'plan', icon: PillIcon, label: '处置' },
] as const satisfies ReadonlyArray<{ id: ViewId; icon: typeof FileTextIcon; label: string }>

const labResults = [
  { flag: '偏高', item: '白细胞计数', reference: '3.5-9.5', value: '11.2 x10^9/L' },
  { flag: '偏高', item: 'C 反应蛋白', reference: '0-10', value: '28.6 mg/L' },
] as const

const refinementLabels = new Map(refinements.map(refinement => [refinement.id, refinement.label]))

const labViews = [
  { id: 'workspace', icon: PanelsTopLeftIcon, label: '工作台' },
  { id: 'components', icon: ComponentIcon, label: '组件与动效' },
] as const satisfies ReadonlyArray<{ id: LabView; icon: typeof PanelsTopLeftIcon; label: string }>

const themeOptions = [
  { id: 'light', icon: SunIcon, label: '浅色模式' },
  { id: 'dark', icon: MoonIcon, label: '深色模式' },
] as const satisfies ReadonlyArray<{ id: ResolvedWebTheme; icon: typeof SunIcon; label: string }>

const motionProfiles = [
  { id: 'quiet', label: '克制' },
  { id: 'continuous', label: '连续' },
  { id: 'emphatic', label: '强调' },
] as const satisfies ReadonlyArray<{ id: MotionProfile; label: string }>

export function UiDevPage(): React.JSX.Element {
  const [labView, setLabView] = useState<LabView>('workspace')
  const [theme, setTheme] = useState<ResolvedWebTheme>(() => (
    document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  ))
  const [patientId, setPatientId] = useState<string>(patients[0].id)
  const [activeView, setActiveView] = useState<ViewId>('results')
  const [resultsReviewed, setResultsReviewed] = useState(false)
  const [visitSigned, setVisitSigned] = useState(false)
  const patient = patients.find(item => item.id === patientId) ?? patients[0]

  const updateTheme = (nextTheme: ResolvedWebTheme): void => {
    setTheme(nextTheme)
    applyResolvedWebTheme(nextTheme)
    writeWebPreferences({ ...readWebPreferences(), theme: nextTheme })
  }

  const handlePrimaryAction = (): void => {
    if (!resultsReviewed) {
      setResultsReviewed(true)
      setActiveView('plan')
      return
    }
    if (!visitSigned) setVisitSigned(true)
  }

  return (
    <TooltipProvider>
      <main className="min-h-svh bg-muted/30">
        <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
          <div className="flex min-h-14 items-center gap-3 px-3 sm:px-5">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-info text-info-foreground">
                <HospitalIcon aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">ClinMesh UI Lab</p>
                <p className="truncate text-xs text-muted-foreground">
                  {labView === 'workspace' ? 'R1 两栏医生工作台' : '组件与动效基线'}
                </p>
              </div>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <ToggleGroup
                aria-label="UI Lab 视图"
                onValueChange={values => {
                  const next = (values as LabView[])[0]
                  if (next !== undefined) setLabView(next)
                }}
                size="sm"
                spacing={0}
                value={[labView]}
                variant="outline"
              >
                {labViews.map(item => (
                  <ToggleGroupItem aria-label={item.label} key={item.id} title={item.label} value={item.id}>
                    <item.icon data-icon="inline-start" />
                    <span className="hidden md:inline">{item.label}</span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <ToggleGroup
                aria-label="主题模式"
                onValueChange={values => {
                  const next = (values as ResolvedWebTheme[])[0]
                  if (next !== undefined) updateTheme(next)
                }}
                size="sm"
                spacing={0}
                value={[theme]}
                variant="outline"
              >
                {themeOptions.map(item => (
                  <ToggleGroupItem aria-label={item.label} key={item.id} title={item.label} value={item.id}>
                    <item.icon aria-hidden="true" />
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </div>
        </header>

        <div className="p-2 sm:p-4">
          {labView === 'workspace' ? (
            <RefinedWorkspace
              activeView={activeView}
              onActiveViewChange={setActiveView}
              onPatientChange={setPatientId}
              onPrimaryAction={handlePrimaryAction}
              patient={patient}
              patientId={patientId}
              refinement="r1"
              resultsReviewed={resultsReviewed}
              visitSigned={visitSigned}
            />
          ) : <ComponentMotionLab />}
        </div>
      </main>
    </TooltipProvider>
  )
}

interface RefinedWorkspaceProps {
  activeView: ViewId
  onActiveViewChange: (view: ViewId) => void
  onPatientChange: (patientId: string) => void
  onPrimaryAction: () => void
  patient: Patient
  patientId: string
  refinement: RefinementId
  resultsReviewed: boolean
  visitSigned: boolean
}

function RefinedWorkspace({
  activeView,
  onActiveViewChange,
  onPatientChange,
  onPrimaryAction,
  patient,
  patientId,
  refinement,
  resultsReviewed,
  visitSigned,
}: RefinedWorkspaceProps): React.JSX.Element {
  const statusFor = (view: ViewId): WorkflowStatus => {
    if (view === 'record' || view === 'orders') return 'complete'
    if (view === 'results') return resultsReviewed ? 'complete' : 'attention'
    if (visitSigned) return 'complete'
    return resultsReviewed ? 'current' : 'pending'
  }

  return (
    <section
      aria-label={`${refinement.toUpperCase()} ${refinementLabels.get(refinement)}`}
      className="mx-auto grid min-h-[calc(100svh-5.5rem)] max-w-[96rem] grid-cols-[3.75rem_minmax(0,1fr)] overflow-hidden border bg-background"
    >
      <QueueRail onPatientChange={onPatientChange} patientId={patientId} />

      <div className="flex min-w-0 flex-col">
        <PatientHeader patient={patient} resultsReviewed={resultsReviewed} visitSigned={visitSigned} />
        <Tabs
          className="min-h-0 flex-1 gap-0"
          onValueChange={value => onActiveViewChange(value as ViewId)}
          value={activeView}
        >
          <WorkflowHeader refinement={refinement} statusFor={statusFor} />
          {refinement === 'r3' && !resultsReviewed ? <AttentionBanner /> : null}
          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            <div className="mx-auto max-w-5xl">
              <TabsContent value="record"><RecordPanel patient={patient} /></TabsContent>
              <TabsContent value="orders"><OrdersPanel /></TabsContent>
              <TabsContent value="results"><ResultsPanel reviewed={resultsReviewed} /></TabsContent>
              <TabsContent value="plan"><PlanPanel patient={patient} visitSigned={visitSigned} /></TabsContent>
            </div>
          </div>
        </Tabs>
        <ActionBar
          onPrimaryAction={onPrimaryAction}
          resultsReviewed={resultsReviewed}
          visitSigned={visitSigned}
        />
      </div>
    </section>
  )
}

function QueueRail({ onPatientChange, patientId }: {
  onPatientChange: (patientId: string) => void
  patientId: string
}): React.JSX.Element {
  return (
    <aside aria-label="候诊队列" className="flex flex-col items-center border-r bg-muted/20 py-3">
      <div className="mb-3 flex flex-col items-center gap-1 text-muted-foreground">
        <ClipboardListIcon aria-hidden="true" className="size-4" />
        <span className="text-xs font-medium tabular-nums">{patients.length}</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        {patients.map(patient => (
          <Tooltip key={patient.id}>
            <TooltipTrigger
              render={(
                <button
                  aria-current={patient.id === patientId ? 'true' : undefined}
                  aria-label={`${patient.name}，等候 ${patient.waitMinutes} 分钟`}
                  className="flex size-9 items-center justify-center rounded-md border bg-background text-xs font-semibold outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-current:border-primary aria-current:bg-accent aria-current:text-accent-foreground"
                  onClick={() => onPatientChange(patient.id)}
                  type="button"
                />
              )}
            >
              {patient.name.slice(0, 1)}
            </TooltipTrigger>
            <TooltipContent side="right">
              {patient.name} · {patient.queueNumber} · 等候 {patient.waitMinutes} 分钟
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </aside>
  )
}

function PatientHeader({ patient, resultsReviewed, visitSigned }: {
  patient: Patient
  resultsReviewed: boolean
  visitSigned: boolean
}): React.JSX.Element {
  return (
    <div className="flex min-h-16 items-center gap-3 border-b px-3 sm:px-4">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary">
        <UserRoundIcon aria-hidden="true" className="size-4" />
      </div>
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold">
          {patient.name} <span className="text-sm font-normal text-muted-foreground">{patient.gender} · {patient.age} 岁</span>
        </h1>
        <p className="truncate text-xs text-muted-foreground">
          {patient.id} · {patient.vitalSigns} · {patient.allergy}
        </p>
      </div>
      <div className="ml-auto hidden shrink-0 items-center gap-2 sm:flex">
        <Badge variant="secondary">内科 3 诊室</Badge>
        <Badge variant={visitSigned ? 'success' : resultsReviewed ? 'info' : 'warning'}>
          {visitSigned ? '已完诊' : resultsReviewed ? '待处置' : '新结果待确认'}
        </Badge>
      </div>
    </div>
  )
}

function WorkflowHeader({ refinement, statusFor }: {
  refinement: RefinementId
  statusFor: (view: ViewId) => WorkflowStatus
}): React.JSX.Element {
  if (refinement === 'r2') {
    return (
      <TabsList className="h-auto w-full justify-start gap-0 overflow-x-auto rounded-none border-b bg-background px-2 py-0" variant="line">
        {stages.map(stage => (
          <TabsTrigger className="min-h-11 min-w-20 justify-start px-2" key={stage.id} value={stage.id}>
            <StatusMark status={statusFor(stage.id)} />
            <span>{stage.label}</span>
            <span className="sr-only">{statusLabel(statusFor(stage.id))}</span>
          </TabsTrigger>
        ))}
      </TabsList>
    )
  }

  if (refinement === 'r3') {
    return (
      <TabsList className="grid h-auto w-full grid-cols-4 gap-0 rounded-none border-b bg-background p-0" variant="line">
        {stages.map(stage => (
          <TabsTrigger className="min-h-12 min-w-0 flex-col gap-0.5 px-1" key={stage.id} value={stage.id}>
            <span className="flex items-center gap-1.5">
              <stage.icon aria-hidden="true" className="size-3.5" />
              <span>{stage.label}</span>
            </span>
            <span className={cn('text-[0.6875rem] font-normal', statusTextClass(statusFor(stage.id)))}>
              {statusLabel(statusFor(stage.id))}
            </span>
          </TabsTrigger>
        ))}
      </TabsList>
    )
  }

  return (
    <TabsList className="grid w-full grid-cols-4 gap-0 rounded-none border-b bg-background p-0 group-data-horizontal/tabs:h-auto" variant="line">
      {stages.map((stage, index) => (
        <TabsTrigger className="min-h-16 min-w-0 flex-col justify-center gap-1 border-r px-1 last:border-r-0 sm:flex-row sm:justify-start sm:gap-3 sm:px-3" key={stage.id} value={stage.id}>
          <StatusMark status={statusFor(stage.id)} />
          <span className="min-w-0 text-center sm:text-left">
            <span className="hidden text-[0.6875rem] font-normal text-muted-foreground sm:block">0{index + 1}</span>
            <span className="block truncate">{stage.label}</span>
            <span className={cn('block text-[0.6875rem] font-normal', statusTextClass(statusFor(stage.id)))}>
              {statusLabel(statusFor(stage.id))}
            </span>
          </span>
        </TabsTrigger>
      ))}
    </TabsList>
  )
}

function StatusMark({ status }: { status: WorkflowStatus }): React.JSX.Element {
  if (status === 'complete') {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-success bg-success text-success-foreground">
        <CheckIcon aria-hidden="true" className="size-3" />
      </span>
    )
  }
  if (status === 'attention') {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-warning bg-warning text-warning-foreground">
        <CircleAlertIcon aria-hidden="true" className="size-3" />
      </span>
    )
  }
  if (status === 'current') {
    return <span className="size-6 shrink-0 rounded-full border-[0.4375rem] border-primary bg-primary-foreground" />
  }
  return <span className="size-6 shrink-0 rounded-full border bg-background" />
}

function statusLabel(status: WorkflowStatus): string {
  if (status === 'complete') return '已完成'
  if (status === 'attention') return '2 项待确认'
  if (status === 'current') return '进行中'
  return '待处理'
}

function statusTextClass(status: WorkflowStatus): string {
  if (status === 'complete') return 'text-success'
  if (status === 'attention') return 'text-warning-foreground'
  if (status === 'current') return 'text-primary'
  return 'text-muted-foreground'
}

function AttentionBanner(): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-warning/15 px-3 py-2 text-xs sm:px-4">
      <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-warning-foreground" />
      <span className="font-semibold">2 项检验结果刚刚发布</span>
      <span className="text-muted-foreground">白细胞计数、C 反应蛋白均高于参考范围</span>
    </div>
  )
}

function RecordPanel({ patient }: { patient: Patient }): React.JSX.Element {
  return (
    <section aria-labelledby="record-heading" className="flex flex-col gap-5">
      <PanelHeading eyebrow={patient.encounterId} id="record-heading" title="门诊病历" />
      <FieldGroup className="grid gap-4 xl:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`chief-${patient.id}`}>主诉</FieldLabel>
          <Textarea defaultValue={patient.chiefComplaint} id={`chief-${patient.id}`} rows={2} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`assessment-${patient.id}`}>初步判断</FieldLabel>
          <Textarea defaultValue={patient.assessment} id={`assessment-${patient.id}`} rows={2} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`history-${patient.id}`}>现病史</FieldLabel>
          <Textarea defaultValue={patient.history} id={`history-${patient.id}`} rows={5} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`exam-${patient.id}`}>体格检查</FieldLabel>
          <Textarea defaultValue={patient.exam} id={`exam-${patient.id}`} rows={5} />
        </Field>
      </FieldGroup>
    </section>
  )
}

function OrdersPanel(): React.JSX.Element {
  return (
    <section aria-labelledby="orders-heading" className="flex flex-col gap-5">
      <PanelHeading eyebrow="09:32 签发" id="orders-heading" title="检验医嘱" />
      <Table>
        <TableHeader>
          <TableRow><TableHead>检验项目</TableHead><TableHead>标本</TableHead><TableHead>状态</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          <TableRow><TableCell className="font-medium">血常规（五分类）</TableCell><TableCell>静脉血</TableCell><TableCell><Badge variant="success">已完成</Badge></TableCell></TableRow>
          <TableRow><TableCell className="font-medium">C 反应蛋白</TableCell><TableCell>血清</TableCell><TableCell><Badge variant="success">已完成</Badge></TableCell></TableRow>
        </TableBody>
      </Table>
    </section>
  )
}

function ResultsPanel({ reviewed }: { reviewed: boolean }): React.JSX.Element {
  return (
    <section aria-labelledby="results-heading" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PanelHeading eyebrow="09:41 发布" id="results-heading" title="检验结果" />
        <Badge variant={reviewed ? 'success' : 'warning'}>{reviewed ? '已确认' : '2 项新结果'}</Badge>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>项目</TableHead>
            <TableHead>结果</TableHead>
            <TableHead className="hidden sm:table-cell">参考范围</TableHead>
            <TableHead>提示</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {labResults.map(result => (
            <TableRow key={result.item}>
              <TableCell className="font-medium">{result.item}</TableCell>
              <TableCell>{result.value}</TableCell>
              <TableCell className="hidden sm:table-cell">{result.reference}</TableCell>
              <TableCell><Badge variant="destructive">{result.flag}</Badge></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="grid gap-4 border-t pt-4 sm:grid-cols-3">
        <ResultFact label="临床判断" value="炎症指标升高，结合查体考虑上呼吸道感染。" />
        <ResultFact label="过敏史" value="否认药物过敏" />
        <ResultFact label="下一步" value={reviewed ? '进入诊断与处置' : '医生确认结果'} />
      </div>
    </section>
  )
}

function PlanPanel({ patient, visitSigned }: { patient: Patient; visitSigned: boolean }): React.JSX.Element {
  return (
    <section aria-labelledby="plan-heading" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PanelHeading eyebrow="复诊处置" id="plan-heading" title="诊断与处方" />
        <Badge variant={visitSigned ? 'success' : 'info'}>{visitSigned ? '已签署' : '待签署'}</Badge>
      </div>
      <FieldGroup className="grid gap-4 xl:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`diagnosis-${patient.id}`}>门诊诊断</FieldLabel>
          <Textarea defaultValue="急性上呼吸道感染" id={`diagnosis-${patient.id}`} rows={3} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`prescription-${patient.id}`}>处方</FieldLabel>
          <Textarea defaultValue="对乙酰氨基酚片 0.5 g，发热时口服。" id={`prescription-${patient.id}`} rows={3} />
        </Field>
        <Field className="xl:col-span-2">
          <FieldLabel htmlFor={`education-${patient.id}`}>门诊宣教</FieldLabel>
          <Textarea defaultValue="充分休息、多饮水；体温超过 39 °C 或出现呼吸困难时及时复诊。" id={`education-${patient.id}`} rows={3} />
        </Field>
      </FieldGroup>
    </section>
  )
}

function PanelHeading({ eyebrow, id, title }: { eyebrow: string; id: string; title: string }): React.JSX.Element {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{eyebrow}</p>
      <h2 className="mt-1 text-lg font-semibold" id={id}>{title}</h2>
    </div>
  )
}

function ResultFact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm leading-5">{value}</p>
    </div>
  )
}

function ComponentMotionLab(): React.JSX.Element {
  const [motionProfile, setMotionProfile] = useState<MotionProfile>('continuous')
  const [motionStage, setMotionStage] = useState(2)

  return (
    <section aria-label="组件与动效基线" className="mx-auto max-w-[96rem] overflow-hidden border bg-background">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <div className="mr-auto">
          <h1 className="text-base font-semibold">组件与动效</h1>
          <p className="text-xs text-muted-foreground">ClinMesh Web 基线</p>
        </div>
        <ToggleGroup
          aria-label="动效方向"
          onValueChange={values => {
            const next = (values as MotionProfile[])[0]
            if (next !== undefined) setMotionProfile(next)
          }}
          size="sm"
          spacing={0}
          value={[motionProfile]}
          variant="outline"
        >
          {motionProfiles.map(profile => (
            <ToggleGroupItem key={profile.id} value={profile.id}>{profile.label}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="grid border-b lg:grid-cols-2">
        <section aria-labelledby="commands-heading" className="border-b p-4 lg:border-r lg:border-b-0">
          <SpecimenHeading id="commands-heading" title="命令与状态" />
          <div className="mt-4 flex flex-wrap gap-2">
            <Button><CheckIcon data-icon="inline-start" />确认结果</Button>
            <Button variant="outline">暂存草稿</Button>
            <Button variant="secondary">查看详情</Button>
            <Button variant="destructive">撤销处方</Button>
            <Button disabled>处理中</Button>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <Badge variant="success">已完成</Badge>
            <Badge variant="info">进行中</Badge>
            <Badge variant="warning">待确认</Badge>
            <Badge variant="destructive">异常</Badge>
            <Badge variant="outline">只读</Badge>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <Alert>
              <CheckIcon aria-hidden="true" />
              <AlertTitle>病历已保存</AlertTitle>
              <AlertDescription>草稿版本已更新。</AlertDescription>
            </Alert>
            <Alert variant="destructive">
              <CircleAlertIcon aria-hidden="true" />
              <AlertTitle>版本冲突</AlertTitle>
              <AlertDescription>请刷新后重新核对。</AlertDescription>
            </Alert>
          </div>
        </section>

        <section aria-labelledby="fields-heading" className="p-4">
          <SpecimenHeading id="fields-heading" title="字段与录入" />
          <FieldGroup className="mt-4">
            <Field>
              <FieldLabel htmlFor="lab-component-diagnosis">门诊诊断</FieldLabel>
              <Input defaultValue="急性上呼吸道感染" id="lab-component-diagnosis" />
            </Field>
            <Field>
              <FieldLabel htmlFor="lab-component-note">临床判断</FieldLabel>
              <Textarea defaultValue="结合症状、查体与检验结果，拟作门诊处置。" id="lab-component-note" rows={4} />
            </Field>
          </FieldGroup>
        </section>
      </div>

      <section aria-labelledby="motion-heading" className="border-b">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <SpecimenHeading id="motion-heading" title="阶段与内容切换" />
          <div className="ml-auto flex gap-2">
            <Button
              aria-label="重置动效阶段"
              onClick={() => setMotionStage(0)}
              size="icon-sm"
              title="重置"
              variant="ghost"
            >
              <RotateCcwIcon aria-hidden="true" />
            </Button>
            <Button onClick={() => setMotionStage(current => (current + 1) % stages.length)} size="sm">
              下一阶段
              <ChevronRightIcon data-icon="inline-end" />
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-4 border-y">
          {stages.map((stage, index) => {
            const status: WorkflowStatus = index < motionStage
              ? 'complete'
              : index === motionStage
                ? index === 2 ? 'attention' : 'current'
                : 'pending'
            return (
              <button
                aria-current={index === motionStage ? 'step' : undefined}
                className={cn(
                  'flex min-h-16 min-w-0 flex-col items-center justify-center gap-1 border-r px-1 outline-none last:border-r-0 hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:flex-row sm:gap-3 sm:px-3',
                  motionDurationClass(motionProfile),
                  index === motionStage ? 'bg-accent' : 'bg-background',
                )}
                key={stage.id}
                onClick={() => setMotionStage(index)}
                type="button"
              >
                <StatusMark status={status} />
                <span className="min-w-0 text-center sm:text-left">
                  <span className="block truncate text-sm font-medium">{stage.label}</span>
                  <span className={cn('block text-[0.6875rem]', statusTextClass(status))}>{statusLabel(status)}</span>
                </span>
              </button>
            )
          })}
        </div>
        <div className="min-h-44 p-4 sm:p-6">
          <div
            className={cn('mx-auto max-w-3xl', motionEntryClass(motionProfile))}
            key={`${motionProfile}:${motionStage}`}
          >
            <p className="text-xs text-muted-foreground">当前阶段</p>
            <h2 className="mt-1 text-lg font-semibold">{stages[motionStage]?.label}</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
              {motionStage === 0 ? '记录主诉、现病史与体格检查。' : null}
              {motionStage === 1 ? '核对项目、标本与签发状态。' : null}
              {motionStage === 2 ? '查看异常结果并完成临床确认。' : null}
              {motionStage === 3 ? '确认诊断、处方、宣教与完诊条件。' : null}
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="overlay-heading" className="flex flex-wrap items-center gap-4 p-4">
        <div className="mr-auto">
          <SpecimenHeading id="overlay-heading" title="覆盖层" />
          <p className="mt-1 text-xs text-muted-foreground">底部 Sheet</p>
        </div>
        <Sheet>
          <SheetTrigger render={<Button variant="outline" />}>
            打开核对面板
          </SheetTrigger>
          <SheetContent className={cn('max-h-[65vh]', motionDurationClass(motionProfile))} side="bottom">
            <SheetHeader>
              <SheetTitle>签署前核对</SheetTitle>
              <SheetDescription>诊断、处方与门诊宣教</SheetDescription>
            </SheetHeader>
            <div className="grid gap-3 px-4 sm:grid-cols-3">
              <ResultFact label="诊断" value="急性上呼吸道感染" />
              <ResultFact label="处方" value="对乙酰氨基酚片 0.5 g" />
              <ResultFact label="状态" value="等待医生签署" />
            </div>
            <SheetFooter className="sm:flex-row sm:justify-end">
              <SheetClose render={<Button variant="outline" />}>返回修改</SheetClose>
              <SheetClose render={<Button />}>确认签署</SheetClose>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </section>
    </section>
  )
}

function SpecimenHeading({ id, title }: { id: string; title: string }): React.JSX.Element {
  return <h2 className="text-sm font-semibold" id={id}>{title}</h2>
}

function motionDurationClass(profile: MotionProfile): string {
  if (profile === 'quiet') return 'transition-colors duration-100 motion-reduce:duration-0'
  if (profile === 'continuous') return 'transition-all duration-200 ease-out motion-reduce:duration-0'
  return 'transition-all duration-300 ease-out motion-reduce:duration-0'
}

function motionEntryClass(profile: MotionProfile): string {
  if (profile === 'quiet') {
    return 'animate-in fade-in-0 duration-100 motion-reduce:animate-none'
  }
  if (profile === 'continuous') {
    return 'animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out motion-reduce:animate-none'
  }
  return 'animate-in fade-in-0 slide-in-from-right-2 zoom-in-95 duration-300 ease-out motion-reduce:animate-none'
}

function ActionBar({ onPrimaryAction, resultsReviewed, visitSigned }: {
  onPrimaryAction: () => void
  resultsReviewed: boolean
  visitSigned: boolean
}): React.JSX.Element {
  const actionLabel = visitSigned
    ? '本次就诊已完成'
    : resultsReviewed
      ? '签署并完成就诊'
      : '确认 2 项结果并进入处置'
  const statusCopy = visitSigned
    ? '病历、医嘱、结果与处置均已完成'
    : resultsReviewed
      ? '结果已确认，等待签署诊断与处方'
      : '2 项新结果需要医生确认'

  return (
    <div className="flex min-h-14 flex-wrap items-center gap-2 border-t bg-background px-3 py-2 sm:px-4">
      <div className="mr-auto min-w-0">
        <p className="truncate text-xs font-medium">{statusCopy}</p>
        <p className="hidden text-xs text-muted-foreground sm:block">草稿已自动保存</p>
      </div>
      <Button size="sm" variant="outline">暂存草稿</Button>
      <Button disabled={visitSigned} onClick={onPrimaryAction} size="sm">
        {visitSigned ? <ClipboardCheckIcon data-icon="inline-start" /> : null}
        {actionLabel}
        {visitSigned ? null : <ChevronRightIcon data-icon="inline-end" />}
      </Button>
    </div>
  )
}
