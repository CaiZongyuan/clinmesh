import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@clinmesh/ui/components/card'
import { Field, FieldDescription, FieldLabel } from '@clinmesh/ui/components/field'
import { Separator } from '@clinmesh/ui/components/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { cn } from '@clinmesh/ui/lib/utils'
import {
  ActivityIcon,
  BeakerIcon,
  ClipboardCheckIcon,
  FileTextIcon,
  PillIcon,
  StethoscopeIcon,
  TriangleAlertIcon,
  UserRoundIcon,
} from 'lucide-react'

import { stepRank, type Actor, type FlowStep, type PrototypeVariant, type ScenarioState } from './model'
import { NextHandoff, PageHeading } from './shared'

interface DoctorWorkstationProps {
  actor: Actor
  scenario: ScenarioState
  variant: PrototypeVariant
  onAdvance: (step: FlowStep, action: string, minutes?: number) => void
  onHandoff: () => void
}

interface DoctorVariantProps {
  actor: Actor
  scenario: ScenarioState
  onAdvance: (step: FlowStep, action: string, minutes?: number) => void
}

interface DoctorAction {
  label: string
  target: FlowStep
  event: string
}

const queuePatients = [
  { id: 'MZ0017', name: '林若溪', wait: '12 分钟', status: '复诊患者', selected: true },
  { id: 'MZ0021', name: '赵川', wait: '8 分钟', status: '初诊患者', selected: false },
  { id: 'MZ0024', name: '顾宁', wait: '3 分钟', status: '初诊患者', selected: false },
] as const

function doctorActionFor(step: FlowStep): DoctorAction | null {
  if (step === 'triaged') {
    return { label: '签发检验医嘱', target: 'lab-ordered', event: '签发血常规、CRP 检验医嘱' }
  }
  if (step === 'result-ready') {
    return { label: '签发药品处方', target: 'medication-ordered', event: '确认诊断并签发门诊处方' }
  }
  if (step === 'dispensed') {
    return { label: '完成本次就诊', target: 'finished', event: '确认发药完成并完诊' }
  }
  return null
}

function selectedPatientQueueStatus(step: FlowStep): string {
  const rank = stepRank[step]
  if (rank < 2) return '未进入医生队列'
  if (rank < 5) return '初诊患者'
  if (rank < 8) return '复诊患者'
  if (rank < 9) return '待完诊'
  return '已完诊'
}

export function DoctorWorkstation({
  actor,
  scenario,
  variant,
  onAdvance,
  onHandoff,
}: DoctorWorkstationProps): React.JSX.Element {
  const variantCopy = ({
    A: ['方案 A · 队列优先', '先处理等候队列，再在中央完成病历与医嘱，右侧持续显示患者摘要。'],
    B: ['方案 B · 患者病历优先', '以患者纵向病历为主轴，队列降为顶栏，适合连续阅读病史和结果。'],
    C: ['方案 C · 流程阶段优先', '将一次接诊拆成可见阶段，当前任务和完成条件最突出。'],
  } satisfies Record<PrototypeVariant, readonly [string, string]>)[variant]

  return (
    <div className="flex flex-col gap-4">
      <PageHeading eyebrow={variantCopy[0]} title="内科门诊医生工作台" description={variantCopy[1]} />
      {actor.id === 'doctor' ? null : (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>当前操作者没有医生岗位</AlertTitle>
          <AlertDescription>可以查看界面，但签发医嘱、处方和完诊必须切换为周芮医生。</AlertDescription>
        </Alert>
      )}
      {variant === 'A' ? <DoctorVariantA actor={actor} scenario={scenario} onAdvance={onAdvance} /> : null}
      {variant === 'B' ? <DoctorVariantB actor={actor} scenario={scenario} onAdvance={onAdvance} /> : null}
      {variant === 'C' ? <DoctorVariantC actor={actor} scenario={scenario} onAdvance={onAdvance} /> : null}
      <NextHandoff scenario={scenario} onHandoff={onHandoff} />
    </div>
  )
}

function DoctorVariantA({ actor, scenario, onAdvance }: DoctorVariantProps): React.JSX.Element {
  return (
    <section className="min-h-[34rem] overflow-hidden border bg-card lg:grid lg:grid-cols-[14rem_minmax(26rem,1fr)_18rem]">
      <aside className="border-b bg-muted/20 lg:border-r lg:border-b-0">
        <div className="flex items-center justify-between border-b px-3 py-2.5">
          <h2 className="text-sm font-semibold">候诊队列</h2>
          <Badge variant="secondary">3 人</Badge>
        </div>
        <div className="grid grid-cols-3 gap-1 p-2 lg:grid-cols-1">
          {queuePatients.map((patient) => (
            <button
              key={patient.id}
              className={cn(
                'min-w-0 border-l-2 px-2 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                patient.selected ? 'border-l-primary bg-accent' : 'border-l-transparent',
              )}
              type="button"
            >
              <span className="flex items-center justify-between gap-1">
                <strong className="truncate text-sm">{patient.name}</strong>
                <span className="text-[0.6875rem] text-muted-foreground">{patient.wait}</span>
              </span>
              <span className="mt-1 block truncate text-xs text-muted-foreground">{patient.selected ? selectedPatientQueueStatus(scenario.step) : patient.status} · {patient.id}</span>
            </button>
          ))}
        </div>
      </aside>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div>
            <h2 className="text-base font-semibold">林若溪 · 发热门诊</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">接诊 09:28 · 当前诊室：内科 3 诊室</p>
          </div>
          <EncounterPhaseBadge step={scenario.step} />
        </div>
        <Tabs defaultValue="record" className="p-4">
          <TabsList>
            <TabsTrigger value="record"><FileTextIcon />病历</TabsTrigger>
            <TabsTrigger value="orders"><BeakerIcon />医嘱</TabsTrigger>
            <TabsTrigger value="results"><ActivityIcon />结果</TabsTrigger>
          </TabsList>
          <TabsContent value="record" className="pt-4">
            <ClinicalNote scenario={scenario} />
          </TabsContent>
          <TabsContent value="orders" className="pt-4">
            <OrderTable scenario={scenario} />
          </TabsContent>
          <TabsContent value="results" className="pt-4">
            <LabResultTable scenario={scenario} />
          </TabsContent>
        </Tabs>
        <div className="border-t bg-muted/20 px-4 py-3">
          <DoctorPrimaryAction actor={actor} scenario={scenario} onAdvance={onAdvance} />
        </div>
      </div>

      <aside className="border-t bg-muted/20 lg:border-t-0 lg:border-l">
        <div className="border-b px-3 py-2.5">
          <h2 className="text-sm font-semibold">患者摘要</h2>
        </div>
        <dl className="grid grid-cols-2 gap-3 p-3 text-xs lg:grid-cols-1">
          <Fact label="生命体征" value="T 38.6 °C · P 96 · BP 118/76" />
          <Fact label="分诊级别" value={`${scenario.triageLevel} 级 · 普通`} />
          <Fact label="既往史" value="无慢性病史" />
          <Fact label="过敏史" value="否认药物过敏" />
          <Fact label="本次费用" value={stepRank[scenario.step] >= 6 ? '60.80 元' : stepRank[scenario.step] >= 3 ? '48.00 元' : '0.00 元'} />
        </dl>
      </aside>
    </section>
  )
}

function DoctorVariantB({ actor, scenario, onAdvance }: DoctorVariantProps): React.JSX.Element {
  return (
    <section className="border bg-card">
      <div className="flex min-w-[42rem] items-center gap-1 overflow-x-auto border-b bg-muted/20 px-3 py-2">
        <span className="mr-2 text-xs font-medium text-muted-foreground">今日候诊</span>
        {queuePatients.map((patient) => (
          <button
            key={patient.id}
            className={cn(
              'flex h-8 items-center gap-2 border-b-2 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              patient.selected ? 'border-b-primary bg-background font-medium' : 'border-b-transparent hover:bg-muted',
            )}
            type="button"
          >
            {patient.name}
            <span className="text-xs text-muted-foreground">{patient.wait}</span>
          </button>
        ))}
      </div>

      <div className="border-b px-5 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-full bg-secondary"><UserRoundIcon className="size-5" /></div>
            <div>
              <h2 className="text-lg font-semibold">林若溪 <span className="text-sm font-normal text-muted-foreground">女，34 岁</span></h2>
              <p className="mt-0.5 text-xs text-muted-foreground">SYN-P-1042 · 发热、咽痛 1 天 · 无药物过敏</p>
            </div>
          </div>
          <EncounterPhaseBadge step={scenario.step} />
        </div>
      </div>

      <div className="grid min-h-[30rem] xl:grid-cols-[20rem_minmax(0,1fr)]">
        <aside className="border-b p-4 xl:border-r xl:border-b-0">
          <h3 className="text-sm font-semibold">就诊时间线</h3>
          <ol className="mt-4 flex flex-col gap-0">
            <TimelineItem time="09:19" title="分诊完成" copy="T 38.6 °C，IV 级" done={stepRank[scenario.step] >= 1} />
            <TimelineItem time="09:28" title="首诊" copy="咽部充血，无呼吸困难" done={stepRank[scenario.step] >= 2} />
            <TimelineItem time="09:41" title="检验结果" copy="WBC 11.2，CRP 28.6" done={stepRank[scenario.step] >= 5} />
            <TimelineItem time="09:48" title="复诊处方" copy="对乙酰氨基酚片" done={stepRank[scenario.step] >= 6} />
            <TimelineItem time="10:02" title="完诊" copy="宣教并结束就诊" done={scenario.step === 'finished'} />
          </ol>
        </aside>

        <div className="min-w-0 p-5">
          <div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_22rem]">
            <div>
              <ClinicalNote scenario={scenario} />
              <Separator className="my-5" />
              {stepRank[scenario.step] >= 5 ? <LabResultTable scenario={scenario} /> : <PendingResults />}
            </div>
            <aside className="border-l-2 border-l-primary bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">当前诊疗决策</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">系统按当前就诊状态只开放一个有效写动作。</p>
              <div className="mt-4">
                <DoctorPrimaryAction actor={actor} scenario={scenario} onAdvance={onAdvance} stacked />
              </div>
            </aside>
          </div>
        </div>
      </div>
    </section>
  )
}

function DoctorVariantC({ actor, scenario, onAdvance }: DoctorVariantProps): React.JSX.Element {
  const stages = [
    { label: '01 评估', icon: StethoscopeIcon, threshold: 1, copy: '主诉、现病史与体格检查' },
    { label: '02 检验', icon: BeakerIcon, threshold: 3, copy: '血常规、CRP 与结果解释' },
    { label: '03 处置', icon: PillIcon, threshold: 6, copy: '诊断、处方、宣教与完诊' },
  ] as const
  const currentStage = stepRank[scenario.step] < 3 ? 0 : stepRank[scenario.step] < 6 ? 1 : 2

  return (
    <section className="border bg-card">
      <div className="grid border-b md:grid-cols-3">
        {stages.map((stage, index) => {
          const Icon = stage.icon
          const done = stepRank[scenario.step] >= (stages[index + 1]?.threshold ?? 9)
          return (
            <div
              key={stage.label}
              className={cn(
                'flex min-h-20 items-center gap-3 border-b px-4 py-3 last:border-b-0 md:border-r md:border-b-0 md:last:border-r-0',
                index === currentStage ? 'bg-accent' : 'bg-muted/20',
              )}
            >
              <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-full', done ? 'bg-success text-success-foreground' : index === currentStage ? 'bg-primary text-primary-foreground' : 'border bg-background')}>
                {done ? <ClipboardCheckIcon className="size-4" /> : <Icon className="size-4" />}
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">{stage.label}</h2>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{stage.copy}</p>
              </div>
            </div>
          )
        })}
      </div>

      <div className="grid min-h-[29rem] lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 p-5">
          {currentStage === 0 ? <ClinicalNote scenario={scenario} /> : null}
          {currentStage === 1 ? (
            <div className="flex flex-col gap-5">
              <OrderTable scenario={scenario} />
              {stepRank[scenario.step] >= 5 ? <LabResultTable scenario={scenario} /> : <PendingResults />}
            </div>
          ) : null}
          {currentStage === 2 ? (
            <div className="flex flex-col gap-5">
              <DiagnosisAndPrescription scenario={scenario} />
              <Field>
                <FieldLabel htmlFor="discharge-note-c">门诊宣教</FieldLabel>
                <Textarea id="discharge-note-c" defaultValue="充分休息、多饮水；体温超过 39 °C 或出现呼吸困难时及时复诊。" />
                <FieldDescription>完诊后写入本次就诊记录。</FieldDescription>
              </Field>
            </div>
          ) : null}
        </div>

        <aside className="border-t bg-muted/20 p-4 lg:border-t-0 lg:border-l">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">阶段完成条件</h2>
            <EncounterPhaseBadge step={scenario.step} />
          </div>
          <ul className="mt-4 flex flex-col gap-3 text-xs">
            <ChecklistItem done={stepRank[scenario.step] >= 1} label="生命体征已由分诊确认" />
            <ChecklistItem done={stepRank[scenario.step] >= 2} label="主诉与现病史已记录" />
            <ChecklistItem done={stepRank[scenario.step] >= 5} label="检验结果已发布" />
            <ChecklistItem done={stepRank[scenario.step] >= 6} label="诊断与处方已签发" />
            <ChecklistItem done={scenario.step === 'finished'} label="发药完成并已完诊" />
          </ul>
          <Separator className="my-4" />
          <DoctorPrimaryAction actor={actor} scenario={scenario} onAdvance={onAdvance} stacked />
        </aside>
      </div>
    </section>
  )
}

function ClinicalNote({ scenario }: { scenario: ScenarioState }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="chief-complaint">主诉</FieldLabel>
          <Textarea id="chief-complaint" defaultValue="发热、咽痛 1 天。" />
        </Field>
        <Field>
          <FieldLabel htmlFor="physical-exam">查体</FieldLabel>
          <Textarea id="physical-exam" defaultValue="T 38.6 °C，咽部充血，双肺呼吸音清。" />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="assessment">初步判断</FieldLabel>
        <Textarea
          id="assessment"
          defaultValue={stepRank[scenario.step] >= 5 ? '急性上呼吸道感染。检验提示轻度炎症反应。' : '发热待查；考虑急性上呼吸道感染，需检验辅助判断。'}
        />
        <FieldDescription>原型中的病历内容只用于演示交互，不构成真实诊疗建议。</FieldDescription>
      </Field>
    </div>
  )
}

function OrderTable({ scenario }: { scenario: ScenarioState }): React.JSX.Element {
  const ordered = stepRank[scenario.step] >= 2
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">本次医嘱</h3>
        <Badge variant={ordered ? 'success' : 'secondary'}>{ordered ? '已签发' : '草稿'}</Badge>
      </div>
      <Table>
        <TableHeader><TableRow><TableHead>项目</TableHead><TableHead>标本</TableHead><TableHead>金额</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
        <TableBody>
          <TableRow><TableCell className="font-medium">血常规（五分类）</TableCell><TableCell>静脉血</TableCell><TableCell>18.00 元</TableCell><TableCell>{ordered ? '已签发' : '待签发'}</TableCell></TableRow>
          <TableRow><TableCell className="font-medium">C 反应蛋白</TableCell><TableCell>血清</TableCell><TableCell>26.00 元</TableCell><TableCell>{ordered ? '已签发' : '待签发'}</TableCell></TableRow>
        </TableBody>
      </Table>
    </div>
  )
}

function LabResultTable({ scenario }: { scenario: ScenarioState }): React.JSX.Element {
  const ready = stepRank[scenario.step] >= 5
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">检验结果</h3>
        <Badge variant={ready ? 'success' : 'secondary'}>{ready ? '已审核' : '未发布'}</Badge>
      </div>
      <Table>
        <TableHeader><TableRow><TableHead>项目</TableHead><TableHead>结果</TableHead><TableHead>参考区间</TableHead><TableHead>提示</TableHead></TableRow></TableHeader>
        <TableBody>
          <TableRow><TableCell className="font-medium">白细胞计数</TableCell><TableCell>{ready ? '11.2 ×10⁹/L' : '--'}</TableCell><TableCell>3.5–9.5</TableCell><TableCell><Badge variant={ready ? 'warning' : 'secondary'}>{ready ? '偏高' : '等待'}</Badge></TableCell></TableRow>
          <TableRow><TableCell className="font-medium">C 反应蛋白</TableCell><TableCell>{ready ? '28.6 mg/L' : '--'}</TableCell><TableCell>0–10</TableCell><TableCell><Badge variant={ready ? 'warning' : 'secondary'}>{ready ? '偏高' : '等待'}</Badge></TableCell></TableRow>
        </TableBody>
      </Table>
    </div>
  )
}

function PendingResults(): React.JSX.Element {
  return (
    <Alert>
      <BeakerIcon />
      <AlertTitle>检验结果尚未回传</AlertTitle>
      <AlertDescription>结果发布后，本页会进入复诊决策状态。</AlertDescription>
    </Alert>
  )
}

function DiagnosisAndPrescription({ scenario }: { scenario: ScenarioState }): React.JSX.Element {
  const prescribed = stepRank[scenario.step] >= 6
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card size="sm">
        <CardHeader>
          <CardTitle>诊断</CardTitle>
          <CardDescription>门诊主诊断</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-2">
          <span className="font-medium">急性上呼吸道感染</span>
          <Badge variant={prescribed ? 'success' : 'secondary'}>{prescribed ? '已确认' : '待确认'}</Badge>
        </CardContent>
      </Card>
      <Card size="sm">
        <CardHeader>
          <CardTitle>处方</CardTitle>
          <CardDescription>院内合成药品目录</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-2">
          <span className="font-medium">对乙酰氨基酚片 0.5 g × 10</span>
          <Badge variant={prescribed ? 'success' : 'secondary'}>{prescribed ? '已签发' : '待签发'}</Badge>
        </CardContent>
      </Card>
    </div>
  )
}

function DoctorPrimaryAction({
  actor,
  scenario,
  onAdvance,
  stacked = false,
}: DoctorVariantProps & { stacked?: boolean }): React.JSX.Element {
  const action = doctorActionFor(scenario.step)
  const isAuthorized = actor.id === 'doctor'
  const waitingCopy = scenario.step === 'finished' ? '本次接诊已关闭' : '等待其他岗位完成当前任务'

  return (
    <div className={cn('flex gap-3', stacked ? 'flex-col' : 'flex-col sm:flex-row sm:items-center sm:justify-between')}>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">当前可执行动作</p>
        <p className="mt-0.5 truncate text-sm font-medium">{action?.label ?? waitingCopy}</p>
      </div>
      <Button
        disabled={action === null || !isAuthorized}
        onClick={() => {
          if (action !== null) onAdvance(action.target, action.event, 6)
        }}
      >
        {action?.label ?? '暂无医生动作'}
        <ClipboardCheckIcon data-icon="inline-end" />
      </Button>
    </div>
  )
}

function EncounterPhaseBadge({ step }: { step: FlowStep }): React.JSX.Element {
  const rank = stepRank[step]
  if (rank < 2) return <Badge variant="secondary">等待首诊</Badge>
  if (rank < 5) return <Badge variant="info">首诊 / 检验中</Badge>
  if (rank < 8) return <Badge variant="warning">复诊 / 处置中</Badge>
  return <Badge variant="success">{step === 'finished' ? '已完诊' : '待完诊'}</Badge>
}

function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium leading-5">{value}</dd>
    </div>
  )
}

function TimelineItem({ time, title, copy, done }: { time: string; title: string; copy: string; done: boolean }): React.JSX.Element {
  return (
    <li className="grid grid-cols-[2.75rem_1rem_1fr] gap-2 pb-4 last:pb-0">
      <time className="pt-0.5 font-mono text-[0.6875rem] text-muted-foreground">{done ? time : '--:--'}</time>
      <span className={cn('mt-1 size-2 rounded-full ring-4', done ? 'bg-success ring-success/15' : 'bg-muted-foreground/30 ring-muted')} />
      <div>
        <p className={cn('text-xs font-medium', done ? 'text-foreground' : 'text-muted-foreground')}>{title}</p>
        <p className="mt-0.5 text-[0.6875rem] leading-4 text-muted-foreground">{done ? copy : '尚未发生'}</p>
      </div>
    </li>
  )
}

function ChecklistItem({ done, label }: { done: boolean; label: string }): React.JSX.Element {
  return (
    <li className="flex items-start gap-2">
      <span className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full', done ? 'bg-success text-success-foreground' : 'border bg-background text-muted-foreground')}>
        {done ? <ClipboardCheckIcon className="size-2.5" /> : null}
      </span>
      <span className={cn(done ? 'text-foreground' : 'text-muted-foreground')}>{label}</span>
    </li>
  )
}
