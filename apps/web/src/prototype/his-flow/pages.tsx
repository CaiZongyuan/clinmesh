import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Avatar, AvatarFallback } from '@clinmesh/ui/components/avatar'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@clinmesh/ui/components/card'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@clinmesh/ui/components/input-group'
import { Progress } from '@clinmesh/ui/components/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { cn } from '@clinmesh/ui/lib/utils'
import {
  ArrowRightIcon,
  BeakerIcon,
  BoxesIcon,
  Building2Icon,
  CheckIcon,
  CircleDollarSignIcon,
  Clock3Icon,
  DatabaseIcon,
  FileCheck2Icon,
  FileLock2Icon,
  FingerprintIcon,
  FlaskConicalIcon,
  GaugeIcon,
  GitCompareArrowsIcon,
  KeyRoundIcon,
  LaptopIcon,
  LockKeyholeIcon,
  LogInIcon,
  PackageCheckIcon,
  PackageOpenIcon,
  PillIcon,
  PlayIcon,
  ReceiptTextIcon,
  RefreshCcwIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldCheckIcon,
  StethoscopeIcon,
  TestTube2Icon,
  TriangleAlertIcon,
  UploadIcon,
  UserRoundCheckIcon,
  UsersIcon,
} from 'lucide-react'

import {
  actors,
  flowStages,
  nextAssignments,
  stepLabels,
  stepRank,
  type Actor,
  type DatasetKind,
  type FlowStep,
  type LisMode,
  type PrototypeScreen,
  type ScenarioState,
} from './model'
import { NextHandoff, PageHeading, statusVariant } from './shared'

interface WorkflowPageProps {
  actor: Actor
  scenario: ScenarioState
  onAdvance: (step: FlowStep, action: string, minutes?: number) => void
  onHandoff: () => void
}

interface NavigationProps {
  onNavigate: (screen: PrototypeScreen) => void
}

const stageCompletedCount: Record<FlowStep, number> = {
  'waiting-registration': 0,
  registered: 1,
  triaged: 2,
  'lab-ordered': 3,
  'lab-paid': 4,
  'specimen-received': 4,
  'result-ready': 5,
  'medication-ordered': 6,
  'medication-paid': 7,
  dispensed: 8,
  finished: 9,
}

export function LoginPage({ onLogin }: { onLogin: () => void }): React.JSX.Element {
  return (
    <main className="grid min-h-svh bg-background lg:grid-cols-[minmax(24rem,0.85fr)_minmax(32rem,1.15fr)]">
      <section className="flex flex-col justify-between border-b bg-sidebar p-6 lg:border-r lg:border-b-0 lg:p-10">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground"><StethoscopeIcon className="size-5" /></div>
          <div>
            <strong className="block text-base">ClinMesh</strong>
            <span className="text-xs text-muted-foreground">中国公立医院仿真 HIS</span>
          </div>
        </div>
        <div className="my-10 max-w-lg">
          <Badge variant="outline">虚构机构 · 全部为合成数据</Badge>
          <h1 className="mt-5 text-2xl font-semibold sm:text-3xl">榆江市中心医院</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">一个共享的门诊仿真环境。不同岗位在同一 Workspace 与 Epoch 中接续处理患者。</p>
          <div className="mt-8 grid grid-cols-3 gap-3 text-xs">
            <LoginFact icon={<UsersIcon />} label="7 个演示岗位" />
            <LoginFact icon={<Clock3Icon />} label="虚拟时钟" />
            <LoginFact icon={<ShieldCheckIcon />} label="全动作审计" />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">outpatient-fever-001 · Epoch E-014</p>
      </section>

      <section className="flex items-center justify-center p-5 sm:p-10">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>登录工作台</CardTitle>
            <CardDescription>原型使用预置演示账户；正式实现由 Better Auth 建立浏览器会话。</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              id="prototype-login-form"
              onSubmit={(event) => {
                event.preventDefault()
                onLogin()
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="email">医院账号</FieldLabel>
                  <Input id="email" type="email" defaultValue="demo.operator@clinmesh.local" autoComplete="username" />
                </Field>
                <Field>
                  <div className="flex items-center justify-between gap-3">
                    <FieldLabel htmlFor="password">密码</FieldLabel>
                    <span className="text-xs text-muted-foreground">演示环境</span>
                  </div>
                  <Input id="password" type="password" defaultValue="prototype-only" autoComplete="current-password" />
                </Field>
              </FieldGroup>
            </form>
          </CardContent>
          <CardFooter className="flex-col gap-2">
            <Button className="w-full" form="prototype-login-form" type="submit">
              <LogInIcon data-icon="inline-start" />
              登录并选择岗位
            </Button>
            <Button className="w-full" onClick={onLogin} variant="outline">
              <KeyRoundIcon data-icon="inline-start" />
              使用通行密钥
            </Button>
          </CardFooter>
        </Card>
      </section>
    </main>
  )
}

function LoginFact({ icon, label }: { icon: React.ReactNode; label: string }): React.JSX.Element {
  return (
    <div className="flex min-h-20 flex-col justify-between border-t-2 border-t-primary bg-background p-3">
      <span className="text-primary [&>svg]:size-4">{icon}</span>
      <span className="font-medium">{label}</span>
    </div>
  )
}

export function RoleSelectionPage({
  actor,
  onSelectActor,
}: {
  actor: Actor
  onSelectActor: (actor: Actor, navigate?: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-5">
      <PageHeading
        eyebrow="身份与访问"
        title="选择本次工作身份"
        description="账号只证明你是谁；Workspace 成员资格与岗位决定你能在哪个科室执行哪些动作。"
      />
      <Alert>
        <FingerprintIcon />
        <AlertTitle>认证身份与医院岗位分开管理</AlertTitle>
        <AlertDescription>Better Auth 会话解析为 ClinMesh Actor context；岗位、地点、Epoch 和患者范围由服务端重新校验。</AlertDescription>
      </Alert>
      <section aria-labelledby="role-list-title">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="role-list-title" className="text-sm font-semibold">榆江市中心医院 · 门诊仿真</h2>
          <Badge variant="info">7 个可用身份</Badge>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {actors.map((candidate) => (
            <Card key={candidate.id} size="sm">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Avatar className="size-9"><AvatarFallback>{candidate.initials}</AvatarFallback></Avatar>
                  <div className="min-w-0">
                    <CardTitle className="truncate">{candidate.name}</CardTitle>
                    <CardDescription className="truncate">{candidate.role}</CardDescription>
                  </div>
                </div>
                <CardAction>{candidate.id === actor.id ? <Badge variant="success">当前</Badge> : null}</CardAction>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-[4.5rem_1fr] gap-y-1.5 text-xs">
                  <dt className="text-muted-foreground">工作地点</dt><dd>{candidate.location}</dd>
                  <dt className="text-muted-foreground">Workspace</dt><dd className="font-mono">yujiang-general</dd>
                  <dt className="text-muted-foreground">Epoch</dt><dd className="font-mono">active</dd>
                </dl>
              </CardContent>
              <CardFooter>
                <Button className="w-full" onClick={() => onSelectActor(candidate, true)} variant={candidate.id === actor.id ? 'secondary' : 'outline'}>
                  <UserRoundCheckIcon data-icon="inline-start" />
                  进入{candidate.role}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      </section>
    </div>
  )
}

export function HospitalFlowPage({
  scenario,
  onNavigate,
  onHandoff,
}: { scenario: ScenarioState } & NavigationProps & { onHandoff: () => void }): React.JSX.Element {
  const completed = stageCompletedCount[scenario.step]
  return (
    <div className="flex flex-col gap-5">
      <PageHeading
        eyebrow="一条患者旅程，六个岗位接力"
        title="门诊发热闭环"
        description="每一步只由对应岗位推进；费用支付是检验执行和药房发药的前置条件。"
        actions={<Button onClick={onHandoff}>转到当前任务<ArrowRightIcon data-icon="inline-end" /></Button>}
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section aria-labelledby="flow-table-title" className="overflow-hidden border bg-card">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
            <h2 id="flow-table-title" className="text-sm font-semibold">业务交接表</h2>
            <Badge variant={scenario.step === 'finished' ? 'success' : 'info'}>{stepLabels[scenario.step]}</Badge>
          </div>
          <Table>
            <TableHeader><TableRow><TableHead className="w-12">序号</TableHead><TableHead>环节</TableHead><TableHead>责任岗位</TableHead><TableHead>完成条件</TableHead><TableHead>状态</TableHead><TableHead className="w-12"><span className="sr-only">打开</span></TableHead></TableRow></TableHeader>
            <TableBody>
              {flowStages.map((stage, index) => {
                const status = index < completed ? 'done' : index === completed ? 'active' : 'waiting'
                return (
                  <TableRow key={stage.id} className={cn(status === 'active' ? 'bg-accent/50' : undefined)}>
                    <TableCell className="font-mono text-muted-foreground">{(index + 1).toString().padStart(2, '0')}</TableCell>
                    <TableCell className="font-medium">{stage.label}</TableCell>
                    <TableCell>{stage.owner}</TableCell>
                    <TableCell className="max-w-[26rem] text-muted-foreground">{stage.description}</TableCell>
                    <TableCell><Badge variant={statusVariant(status)}>{status === 'done' ? '完成' : status === 'active' ? '当前' : '等待'}</Badge></TableCell>
                    <TableCell><Button aria-label={`打开${stage.label}`} onClick={() => onNavigate(stage.screen)} size="icon-sm" variant="ghost" title={`打开${stage.label}`}><ArrowRightIcon /></Button></TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </section>

        <aside className="flex flex-col gap-4">
          <Card size="sm">
            <CardHeader><CardTitle>患者等待在哪里</CardTitle><CardDescription>当前责任只归一个岗位</CardDescription></CardHeader>
            <CardContent>
              <p className="text-lg font-semibold">{nextAssignments[scenario.step].label}</p>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">其他岗位可以读取已授权信息，但不能越权推进状态。</p>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardHeader><CardTitle>闭环完成度</CardTitle><CardDescription>{completed} / {flowStages.length} 个环节</CardDescription></CardHeader>
            <CardContent><Progress value={(completed / flowStages.length) * 100} /></CardContent>
          </Card>
        </aside>
      </div>
      <NextHandoff scenario={scenario} onHandoff={onHandoff} />
    </div>
  )
}

export function RegistrationPage({ actor, scenario, onAdvance, onHandoff }: WorkflowPageProps): React.JSX.Element {
  const canSubmit = actor.id === 'registrar' && scenario.step === 'waiting-registration'
  return (
    <div className="flex flex-col gap-5">
      <PageHeading eyebrow="门诊服务 · 挂号" title="挂号工作台" description="先确认合成患者身份，再选择科室、号源和就诊类型。" />
      <AuthorizationNotice authorized={actor.id === 'registrar'} expected="门诊挂号员" />
      <div className="grid gap-4 xl:grid-cols-[minmax(22rem,0.85fr)_minmax(30rem,1.15fr)]">
        <section className="border bg-card p-4">
          <h2 className="text-sm font-semibold">1. 查找患者</h2>
          <Field className="mt-4">
            <FieldLabel htmlFor="patient-search">患者编号 / 姓名</FieldLabel>
            <InputGroup>
              <InputGroupAddon><SearchIcon /></InputGroupAddon>
              <InputGroupInput id="patient-search" defaultValue="SYN-P-1042" />
            </InputGroup>
            <FieldDescription>只显示当前 Workspace 内的合成患者。</FieldDescription>
          </Field>
          <Card className="mt-4" size="sm">
            <CardHeader>
              <CardTitle>林若溪</CardTitle>
              <CardDescription>女，34 岁 · SYN-P-1042</CardDescription>
              <CardAction><Badge variant="success">已核验</Badge></CardAction>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 text-xs">
              <Fact label="证件" value="合成居民标识 · 尾号 0042" />
              <Fact label="联系方式" value="13X-XXXX-0042" />
              <Fact label="患者类型" value="城镇职工 · 仿真" />
              <Fact label="建档时间" value="2026-06-10" />
            </CardContent>
          </Card>
        </section>

        <section className="border bg-card p-4">
          <h2 className="text-sm font-semibold">2. 选择号源</h2>
          <FieldGroup className="mt-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field><FieldLabel htmlFor="department">科室</FieldLabel><Input id="department" value="内科门诊" readOnly /></Field>
              <Field><FieldLabel htmlFor="visit-type">号别</FieldLabel><Input id="visit-type" value="普通号 · 初诊" readOnly /></Field>
            </div>
            <FieldSet>
              <FieldLegend variant="label">可用时段</FieldLegend>
              <ToggleGroup defaultValue={['09:00-10:00']} className="flex-wrap" spacing={2}>
                <ToggleGroupItem value="09:00-10:00">09:00–10:00 · 余 6</ToggleGroupItem>
                <ToggleGroupItem value="10:00-11:00">10:00–11:00 · 余 9</ToggleGroupItem>
                <ToggleGroupItem value="14:00-15:00">14:00–15:00 · 余 12</ToggleGroupItem>
              </ToggleGroup>
            </FieldSet>
          </FieldGroup>
          <div className="mt-5 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div><p className="text-xs text-muted-foreground">挂号费</p><p className="mt-0.5 text-lg font-semibold tabular-nums">8.00 元</p></div>
            <Button disabled={!canSubmit} onClick={() => onAdvance('registered', '确认患者身份并完成内科普通号挂号', 3)}>
              <ReceiptTextIcon data-icon="inline-start" />
              {scenario.step === 'waiting-registration' ? '确认并挂号' : '挂号已完成'}
            </Button>
          </div>
        </section>
      </div>
      <NextHandoff scenario={scenario} onHandoff={onHandoff} />
    </div>
  )
}

export function TriagePage({
  actor,
  scenario,
  onAdvance,
  onHandoff,
  onSetTriageLevel,
}: WorkflowPageProps & { onSetTriageLevel: (level: 'III' | 'IV') => void }): React.JSX.Element {
  const canSubmit = actor.id === 'triage-nurse' && scenario.step === 'registered'
  return (
    <div className="flex flex-col gap-5">
      <PageHeading eyebrow="护理 · 门诊分诊" title="分诊工作台" description="生命体征和分诊级别决定患者进入哪个候诊队列，但不替代医生诊断。" />
      <AuthorizationNotice authorized={actor.id === 'triage-nurse'} expected="分诊护士" />
      <div className="grid gap-4 xl:grid-cols-[19rem_minmax(32rem,1fr)]">
        <section className="border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-3"><h2 className="text-sm font-semibold">待分诊</h2><Badge variant="secondary">1 人</Badge></div>
          <button className="w-full border-l-2 border-l-primary bg-accent px-4 py-3 text-left" type="button">
            <span className="flex items-center justify-between gap-2"><strong>林若溪</strong><span className="text-xs text-muted-foreground">等待 4 分钟</span></span>
            <span className="mt-1 block text-xs text-muted-foreground">内科普通号 · MZ-SYN-0017</span>
          </button>
        </section>
        <section className="border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">林若溪 · 分诊记录</h2><Badge variant={scenario.step === 'registered' ? 'info' : 'success'}>{scenario.step === 'registered' ? '待提交' : '已提交'}</Badge></div>
          <FieldGroup className="mt-5">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field><FieldLabel htmlFor="temperature">体温（°C）</FieldLabel><Input id="temperature" inputMode="decimal" defaultValue="38.6" /></Field>
              <Field><FieldLabel htmlFor="pulse">脉搏（次/分）</FieldLabel><Input id="pulse" inputMode="numeric" defaultValue="96" /></Field>
              <Field><FieldLabel htmlFor="systolic">收缩压（mmHg）</FieldLabel><Input id="systolic" inputMode="numeric" defaultValue="118" /></Field>
              <Field><FieldLabel htmlFor="diastolic">舒张压（mmHg）</FieldLabel><Input id="diastolic" inputMode="numeric" defaultValue="76" /></Field>
            </div>
            <FieldSet>
              <FieldLegend variant="label">分诊级别</FieldLegend>
              <FieldDescription>III 级优先，IV 级普通；本场景推荐 IV 级。</FieldDescription>
              <ToggleGroup
                value={[scenario.triageLevel]}
                onValueChange={(value) => {
                  const level = value[0]
                  if (level === 'III' || level === 'IV') onSetTriageLevel(level)
                }}
                spacing={2}
              >
                <ToggleGroupItem value="III">III 级 · 优先</ToggleGroupItem>
                <ToggleGroupItem value="IV">IV 级 · 普通</ToggleGroupItem>
              </ToggleGroup>
            </FieldSet>
            <Field><FieldLabel htmlFor="triage-note">分诊摘要</FieldLabel><Input id="triage-note" defaultValue="发热、咽痛，无呼吸困难及意识障碍。" /></Field>
          </FieldGroup>
          <div className="mt-5 flex justify-end border-t pt-4">
            <Button disabled={!canSubmit} onClick={() => onAdvance('triaged', `完成门诊分诊，分级 ${scenario.triageLevel}`, 4)}>
              <UserRoundCheckIcon data-icon="inline-start" />
              {scenario.step === 'registered' ? '提交分诊' : '分诊已完成'}
            </Button>
          </div>
        </section>
      </div>
      <NextHandoff scenario={scenario} onHandoff={onHandoff} />
    </div>
  )
}

export function BillingPage({ actor, scenario, onAdvance, onHandoff }: WorkflowPageProps): React.JSX.Element {
  const action = scenario.step === 'lab-ordered'
    ? { step: 'lab-paid' as const, label: '收取检验费 48.00 元', event: '完成检验费用结算' }
    : scenario.step === 'medication-ordered'
      ? { step: 'medication-paid' as const, label: '收取药品费 12.80 元', event: '完成药品费用结算' }
      : null
  const canSubmit = actor.id === 'cashier' && action !== null
  const amount = action?.step === 'lab-paid' ? '48.00 元' : action?.step === 'medication-paid' ? '12.80 元' : '0.00 元'
  const labPaid = stepRank[scenario.step] >= 3
  const medicationOrdered = stepRank[scenario.step] >= 6
  const medicationPaid = stepRank[scenario.step] >= 7

  return (
    <div className="flex flex-col gap-5">
      <PageHeading eyebrow="门诊财务 · 收费" title="收费工作台" description="检验与药品分别结算；支付成功后才向下游岗位释放可执行任务。" />
      <AuthorizationNotice authorized={actor.id === 'cashier'} expected="门诊收费员" />
      <div className="grid gap-4 xl:grid-cols-[minmax(34rem,1fr)_20rem]">
        <section className="overflow-hidden border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-3"><h2 className="text-sm font-semibold">林若溪 · 待结算项目</h2><Badge variant={action === null ? 'secondary' : 'warning'}>{action === null ? '无待缴项目' : '待收款'}</Badge></div>
          <Table>
            <TableHeader><TableRow><TableHead>费用批次</TableHead><TableHead>项目</TableHead><TableHead>开立岗位</TableHead><TableHead>金额</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
            <TableBody>
              <TableRow><TableCell className="font-mono">CHG-LAB-0017</TableCell><TableCell>血常规 + CRP + 采血费</TableCell><TableCell>周芮医生</TableCell><TableCell>48.00 元</TableCell><TableCell><Badge variant={labPaid ? 'success' : stepRank[scenario.step] >= 2 ? 'warning' : 'secondary'}>{labPaid ? '已支付' : stepRank[scenario.step] >= 2 ? '待支付' : '未开立'}</Badge></TableCell></TableRow>
              <TableRow><TableCell className="font-mono">CHG-MED-0017</TableCell><TableCell>对乙酰氨基酚片</TableCell><TableCell>周芮医生</TableCell><TableCell>12.80 元</TableCell><TableCell><Badge variant={medicationPaid ? 'success' : medicationOrdered ? 'warning' : 'secondary'}>{medicationPaid ? '已支付' : medicationOrdered ? '待支付' : '未开立'}</Badge></TableCell></TableRow>
            </TableBody>
          </Table>
        </section>
        <Card>
          <CardHeader><CardTitle>本次收款</CardTitle><CardDescription>{action?.label ?? '当前没有可收费用'}</CardDescription></CardHeader>
          <CardContent>
            <FieldSet>
              <FieldLegend variant="label">支付方式</FieldLegend>
              <ToggleGroup defaultValue={['insurance']} className="flex-wrap" spacing={2}>
                <ToggleGroupItem value="insurance">医保电子凭证</ToggleGroupItem>
                <ToggleGroupItem value="mobile">移动支付</ToggleGroupItem>
                <ToggleGroupItem value="cash">现金</ToggleGroupItem>
              </ToggleGroup>
            </FieldSet>
            <dl className="mt-5 flex flex-col gap-2 border-t pt-4 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">应收</dt><dd className="font-semibold">{amount}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">仿真统筹支付</dt><dd>0.00 元</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">个人支付</dt><dd>{amount}</dd></div>
            </dl>
          </CardContent>
          <CardFooter><Button className="w-full" disabled={!canSubmit} onClick={() => { if (action !== null) onAdvance(action.step, action.event, 2) }}><CircleDollarSignIcon data-icon="inline-start" />确认收款</Button></CardFooter>
        </Card>
      </div>
      <NextHandoff scenario={scenario} onHandoff={onHandoff} />
    </div>
  )
}

export function LisPage({ actor, scenario, onAdvance, onHandoff }: WorkflowPageProps): React.JSX.Element {
  const canReceive = actor.id === 'lis' && scenario.step === 'lab-paid'
  const canPublish = actor.id === 'lis' && scenario.step === 'specimen-received' && scenario.lisMode !== 'rejected'
  const received = stepRank[scenario.step] >= 4
  const ready = stepRank[scenario.step] >= 5
  return (
    <div className="flex flex-col gap-5">
      <PageHeading eyebrow="外部系统模拟 · LIS" title="检验信息系统" description="此页面模拟检验科接收标本、分析并发布结果，不连接真实 LIS 或设备。" />
      <AuthorizationNotice authorized={actor.id === 'lis'} expected="检验接口模拟器" />
      {scenario.lisMode === 'rejected' ? <Alert variant="destructive"><TriangleAlertIcon /><AlertTitle>LIS 已拒绝本次请求</AlertTitle><AlertDescription>返回代码 SYN-LIS-422；需在仿真控制中恢复正常模式后重试。</AlertDescription></Alert> : null}
      {scenario.lisMode === 'delayed' ? <Alert><Clock3Icon /><AlertTitle>结果发布延迟</AlertTitle><AlertDescription>当前脚本会把分析耗时从 8 分钟延长到 23 分钟。</AlertDescription></Alert> : null}
      <section className="overflow-hidden border bg-card">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3"><h2 className="text-sm font-semibold">检验工作列表</h2><Badge variant={ready ? 'success' : received ? 'info' : 'secondary'}>{ready ? '结果已发布' : received ? '分析中' : '等待标本'}</Badge></div>
        <Table>
          <TableHeader><TableRow><TableHead>申请单</TableHead><TableHead>患者</TableHead><TableHead>组合</TableHead><TableHead>标本</TableHead><TableHead>优先级</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
          <TableBody><TableRow><TableCell className="font-mono">LAB-SYN-0017</TableCell><TableCell className="font-medium">林若溪</TableCell><TableCell>血常规 + CRP</TableCell><TableCell>静脉血</TableCell><TableCell>常规</TableCell><TableCell>{ready ? '已发布' : received ? '分析中' : stepRank[scenario.step] >= 3 ? '待接收' : '未缴费'}</TableCell></TableRow></TableBody>
        </Table>
      </section>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <section className="border bg-card p-4">
          <div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">分析结果</h2><Badge variant={ready ? 'success' : 'secondary'}>{ready ? '审核通过' : '待分析'}</Badge></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <ResultMetric name="白细胞计数" value={ready || received ? '11.2' : '--'} unit="×10⁹/L" range="3.5–9.5" high={ready || received} />
            <ResultMetric name="C 反应蛋白" value={ready || received ? '28.6' : '--'} unit="mg/L" range="0–10" high={ready || received} />
          </div>
        </section>
        <Card>
          <CardHeader><CardTitle>接口动作</CardTitle><CardDescription>幂等键 LIS-LAB-SYN-0017</CardDescription></CardHeader>
          <CardContent className="text-xs leading-5 text-muted-foreground">同一动作重复提交不会生成第二份标本或结果；结果发布后医生队列自动出现复诊任务。</CardContent>
          <CardFooter className="flex-col gap-2">
            <Button className="w-full" disabled={!canReceive} onClick={() => onAdvance('specimen-received', '接收 LAB-SYN-0017 静脉血标本', 5)}><TestTube2Icon data-icon="inline-start" />接收标本</Button>
            <Button className="w-full" disabled={!canPublish} onClick={() => onAdvance('result-ready', '审核并发布血常规与 CRP 结果', scenario.lisMode === 'delayed' ? 23 : 8)} variant="outline"><FileCheck2Icon data-icon="inline-start" />发布结果</Button>
          </CardFooter>
        </Card>
      </div>
      <NextHandoff scenario={scenario} onHandoff={onHandoff} />
    </div>
  )
}

export function PharmacyPage({ actor, scenario, onAdvance, onHandoff }: WorkflowPageProps): React.JSX.Element {
  const canDispense = actor.id === 'pharmacist' && scenario.step === 'medication-paid'
  const prescribed = stepRank[scenario.step] >= 6
  const paid = stepRank[scenario.step] >= 7
  const dispensed = stepRank[scenario.step] >= 8
  return (
    <div className="flex flex-col gap-5">
      <PageHeading eyebrow="门诊药事 · 发药" title="药房工作台" description="处方签发且费用支付成功后，药师才可按库存批次核对并发药。" />
      <AuthorizationNotice authorized={actor.id === 'pharmacist'} expected="门诊药师" />
      <div className="grid gap-4 xl:grid-cols-[18rem_minmax(34rem,1fr)]">
        <section className="border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-3"><h2 className="text-sm font-semibold">待发药队列</h2><Badge variant={paid && !dispensed ? 'warning' : 'secondary'}>{paid && !dispensed ? '1 张' : '0 张'}</Badge></div>
          <button className={cn('w-full border-l-2 px-4 py-3 text-left', paid && !dispensed ? 'border-l-primary bg-accent' : 'border-l-transparent')} type="button">
            <strong className="block">林若溪</strong><span className="mt-1 block text-xs text-muted-foreground">RX-SYN-0017 · {dispensed ? '已发药' : prescribed ? paid ? '待发药' : '待缴费' : '未开方'}</span>
          </button>
        </section>
        <section className="overflow-hidden border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3"><div><h2 className="text-sm font-semibold">RX-SYN-0017</h2><p className="mt-0.5 text-xs text-muted-foreground">周芮医生 · 内科门诊</p></div><Badge variant={dispensed ? 'success' : paid ? 'warning' : 'secondary'}>{dispensed ? '已发药' : paid ? '已缴费' : '不可发药'}</Badge></div>
          <Table>
            <TableHeader><TableRow><TableHead>药品</TableHead><TableHead>用法</TableHead><TableHead>数量</TableHead><TableHead>库存批次</TableHead><TableHead>有效期</TableHead><TableHead>可用量</TableHead></TableRow></TableHeader>
            <TableBody><TableRow><TableCell><div className="font-medium">对乙酰氨基酚片</div><div className="text-xs text-muted-foreground">H-MED-SYN-0008 · 0.5 g × 10</div></TableCell><TableCell>口服，发热时 0.5 g</TableCell><TableCell>1 盒</TableCell><TableCell className="font-mono">SYN-260801-A</TableCell><TableCell>2028-07-31</TableCell><TableCell>126 盒</TableCell></TableRow></TableBody>
          </Table>
          <div className="grid gap-4 border-t p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <Field><FieldLabel htmlFor="lot-scan">扫描院内批次码</FieldLabel><InputGroup><InputGroupAddon><PackageOpenIcon /></InputGroupAddon><InputGroupInput id="lot-scan" defaultValue="SYN-260801-A" /></InputGroup><FieldDescription>批次、数量和效期必须同时通过校验。</FieldDescription></Field>
            <Button disabled={!canDispense} onClick={() => onAdvance('dispensed', '核对处方与库存批次并完成发药', 4)}><PackageCheckIcon data-icon="inline-start" />{dispensed ? '发药已完成' : '核对并发药'}</Button>
          </div>
        </section>
      </div>
      <NextHandoff scenario={scenario} onHandoff={onHandoff} />
    </div>
  )
}

export function SimulationPage({
  scenario,
  onAdvanceTime,
  onReset,
  onSetDataset,
  onSetLisMode,
  onSetCheckpoint,
  onSimulateConflict,
}: {
  scenario: ScenarioState
  onAdvanceTime: (minutes: number) => void
  onReset: () => void
  onSetDataset: (dataset: DatasetKind) => void
  onSetLisMode: (mode: LisMode) => void
  onSetCheckpoint: (step: FlowStep, label: string) => void
  onSimulateConflict: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-5">
      <PageHeading eyebrow="场景运行时" title="仿真控制" description="控制虚拟时间、外部系统脚本和 Epoch；重置会让所有岗位同时回到同一初始状态。" actions={<Button onClick={() => onAdvanceTime(15)} variant="outline"><PlayIcon data-icon="inline-start" />推进 15 分钟</Button>} />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>数据密度</CardTitle><CardDescription>决定背景患者与队列规模</CardDescription></CardHeader>
          <CardContent>
            <ToggleGroup value={[scenario.dataset]} onValueChange={(value) => { const dataset = value[0]; if (dataset === 'golden' || dataset === 'density') onSetDataset(dataset) }} spacing={2}>
              <ToggleGroupItem value="golden">Golden · 最小闭环</ToggleGroupItem>
              <ToggleGroupItem value="density">Density · 繁忙门诊</ToggleGroupItem>
            </ToggleGroup>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>LIS 响应脚本</CardTitle><CardDescription>模拟正常、延迟与拒绝</CardDescription></CardHeader>
          <CardContent>
            <ToggleGroup value={[scenario.lisMode]} onValueChange={(value) => { const mode = value[0]; if (mode === 'normal' || mode === 'delayed' || mode === 'rejected') onSetLisMode(mode) }} className="flex-wrap" spacing={2}>
              <ToggleGroupItem value="normal">正常</ToggleGroupItem>
              <ToggleGroupItem value="delayed">延迟</ToggleGroupItem>
              <ToggleGroupItem value="rejected">拒绝</ToggleGroupItem>
            </ToggleGroup>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>当前 Epoch</CardTitle><CardDescription>多用户共享的隔离运行版本</CardDescription></CardHeader>
          <CardContent><p className="font-mono text-2xl font-semibold">E-{scenario.epoch.toString().padStart(3, '0')}</p><p className="mt-2 text-xs text-muted-foreground">当前状态：{stepLabels[scenario.step]}</p></CardContent>
          <CardFooter><Button className="w-full" onClick={onReset} variant="destructive"><RotateCcwIcon data-icon="inline-start" />重置并创建新 Epoch</Button></CardFooter>
        </Card>
      </div>
      <section className="border bg-card">
        <div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">检查点</h2><p className="mt-0.5 text-xs text-muted-foreground">直接载入关键节点以比较工作台，不写入正式审计记录。</p></div>
        <div className="grid divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
          <Checkpoint icon={<RefreshCcwIcon />} label="待挂号" copy="从完整闭环起点开始" onClick={() => onSetCheckpoint('waiting-registration', '载入待挂号检查点')} />
          <Checkpoint icon={<StethoscopeIcon />} label="待首诊" copy="已完成挂号与分诊" onClick={() => onSetCheckpoint('triaged', '载入待首诊检查点')} />
          <Checkpoint icon={<BeakerIcon />} label="待复诊" copy="检验结果已经发布" onClick={() => onSetCheckpoint('result-ready', '载入待复诊检查点')} />
          <Checkpoint icon={<PillIcon />} label="待发药" copy="处方费用已经支付" onClick={() => onSetCheckpoint('medication-paid', '载入待发药检查点')} />
        </div>
      </section>
      <section className="grid gap-4 border bg-card p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">乐观并发演练</h2>
            <Badge variant={scenario.lastConflict ? 'warning' : 'secondary'}>当前 v{scenario.version}</Badge>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">模拟另一岗位先写入后，当前页面携带旧 expected version 提交；服务端拒绝覆盖并返回最新版本。</p>
          {scenario.lastConflict ? (
            <p className="mt-2 text-xs font-medium text-warning-foreground">冲突已捕获：expected v{scenario.lastConflict.expectedVersion}，实际 v{scenario.lastConflict.actualVersion}，页面已刷新。</p>
          ) : null}
        </div>
        <Button onClick={onSimulateConflict} variant="outline"><GitCompareArrowsIcon data-icon="inline-start" />模拟版本冲突</Button>
      </section>
      <Alert><GaugeIcon /><AlertTitle>所有时间都是虚拟时间</AlertTitle><AlertDescription>推进时间只影响当前 Workspace Epoch，不依赖服务器系统时钟，也不会触发真实外部服务。</AlertDescription></Alert>
    </div>
  )
}

function Checkpoint({ icon, label, copy, onClick }: { icon: React.ReactNode; label: string; copy: string; onClick: () => void }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 p-4">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary [&>svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1"><h3 className="text-sm font-medium">{label}</h3><p className="mt-0.5 truncate text-xs text-muted-foreground">{copy}</p></div>
      <Button onClick={onClick} size="sm" variant="outline">载入</Button>
    </div>
  )
}

export function DataPackagePage({ onImport }: { onImport: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-5">
      <PageHeading eyebrow="Scenario compiler 输入" title="数据包" description="每个来源先成为带版本、哈希与许可状态的离线 artifact，再编译成本院目录和场景数据。" actions={<Button onClick={onImport} variant="outline"><UploadIcon data-icon="inline-start" />导入本地参考包</Button>} />
      <Alert><FileLock2Icon /><AlertTitle>官方可查询，不等于可以整库再分发</AlertTitle><AlertDescription>医保目录和药监数据只从用户合法取得的本地文件导入；Git 中保存 adapter、manifest 与合成院内子集。</AlertDescription></Alert>
      <Tabs defaultValue="sources">
        <TabsList>
          <TabsTrigger value="sources"><DatabaseIcon />来源包</TabsTrigger>
          <TabsTrigger value="outputs"><BoxesIcon />编译产物</TabsTrigger>
          <TabsTrigger value="quality"><ShieldCheckIcon />质量门</TabsTrigger>
        </TabsList>
        <TabsContent value="sources" className="pt-4">
          <section className="overflow-hidden border bg-card">
            <Table>
              <TableHeader><TableRow><TableHead>来源</TableHead><TableHead>版本 / 批次</TableHead><TableHead>用途</TableHead><TableHead>许可处置</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
              <TableBody>
                <SourceRow icon={<FlaskConicalIcon />} name="Synthea FHIR R4" version="固定 commit + seed" use="患者临床历史输入" policy="可按兼容许可证使用；转 R5" status="ready" />
                <SourceRow icon={<FileCheck2Icon />} name="医保药品分类与代码数据库" version="20260819 / 截至 2026-08-07" use="产品代码；支付属性单独映射" policy="仅授权离线导入，不入 Git" status="controlled" />
                <SourceRow icon={<Building2Icon />} name="NMPA 药品查询" version="取得日 + 页面证据" use="批准文号、剂型与规格核验" policy="人工或受控离线核验" status="manual" />
                <SourceRow icon={<LaptopIcon />} name="OpenHIS" version="2.0.5 参考源码" use="目录分层和 Excel 导入模式" policy="不复制 seed、目录或凭证" status="reference" />
              </TableBody>
            </Table>
          </section>
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <DataFact title="医保快照" value="280,531 条" copy="官网匿名查询总数，仅作来源规模记录；原始行未包含在仓库。" />
            <DataFact title="批次标识" value="20260819" copy="发布批次与数据截止日分开保存，不能混用。" />
            <DataFact title="官方 PDF MD5" value="299cf424…f4bb" copy="导入时还会记录实际内容哈希与 parser 版本。" mono />
          </div>
        </TabsContent>
        <TabsContent value="outputs" className="pt-4">
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <DataOutput icon={<Building2Icon />} title="Hospital Baseline" copy="虚构吉林省地市级三级综合公立医院、科室、地点、岗位与号源。" />
            <DataOutput icon={<PillIcon />} title="Hospital Catalog" copy="院内码、合成厂家、价格、批次、效期和库存移动。" />
            <DataOutput icon={<DatabaseIcon />} title="FHIR R5 Bundle" copy="患者、就诊、医嘱、结果与用药资源，固定为 5.0.0。" />
            <DataOutput icon={<FileCheck2Icon />} title="Scenario Truth" copy="流程脚本、预期版本、外部响应、隐藏真值和评分规则。" />
          </section>
        </TabsContent>
        <TabsContent value="quality" className="pt-4">
          <section className="border bg-card p-5">
            <h2 className="text-sm font-semibold">编译前必须全部通过</h2>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <QualityGate label="来源 manifest 完整" />
              <QualityGate label="许可状态允许当前用途" />
              <QualityGate label="R4 → R5 映射通过 profile" />
              <QualityGate label="院内目录引用无悬空" />
              <QualityGate label="金额、数量与库存守恒" />
              <QualityGate label="患者、凭证与机构全部合成" />
            </ul>
          </section>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function AuthorizationNotice({ authorized, expected }: { authorized: boolean; expected: string }): React.JSX.Element | null {
  if (authorized) return null
  return (
    <Alert variant="destructive">
      <LockKeyholeIcon />
      <AlertTitle>当前为只读查看</AlertTitle>
      <AlertDescription>此页面的业务动作要求“{expected}”岗位；切换身份后才可提交。</AlertDescription>
    </Alert>
  )
}

function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  )
}

function ResultMetric({ name, value, unit, range, high }: { name: string; value: string; unit: string; range: string; high: boolean }): React.JSX.Element {
  return (
    <Card size="sm">
      <CardHeader><CardTitle>{name}</CardTitle><CardDescription>参考区间 {range} {unit}</CardDescription><CardAction><Badge variant={high ? 'warning' : 'secondary'}>{high ? '偏高' : '等待'}</Badge></CardAction></CardHeader>
      <CardContent><span className="text-2xl font-semibold tabular-nums">{value}</span> <span className="text-xs text-muted-foreground">{unit}</span></CardContent>
    </Card>
  )
}

function SourceRow({ icon, name, version, use, policy, status }: { icon: React.ReactNode; name: string; version: string; use: string; policy: string; status: 'ready' | 'controlled' | 'manual' | 'reference' }): React.JSX.Element {
  const labels = { ready: '可使用', controlled: '受控导入', manual: '人工核验', reference: '仅参考' } as const
  const variants = { ready: 'success', controlled: 'warning', manual: 'info', reference: 'secondary' } as const
  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground [&>svg]:size-4">{icon}</span>
          <span className="font-medium">{name}</span>
        </div>
      </TableCell>
      <TableCell className="font-mono text-xs">{version}</TableCell>
      <TableCell>{use}</TableCell>
      <TableCell className="max-w-[22rem] text-muted-foreground">{policy}</TableCell>
      <TableCell><Badge variant={variants[status]}>{labels[status]}</Badge></TableCell>
    </TableRow>
  )
}

function DataFact({ title, value, copy, mono = false }: { title: string; value: string; copy: string; mono?: boolean }): React.JSX.Element {
  return (
    <Card size="sm">
      <CardHeader><CardTitle>{title}</CardTitle><CardDescription>{copy}</CardDescription></CardHeader>
      <CardContent><span className={cn('text-lg font-semibold', mono ? 'font-mono' : undefined)}>{value}</span></CardContent>
    </Card>
  )
}

function DataOutput({ icon, title, copy }: { icon: React.ReactNode; title: string; copy: string }): React.JSX.Element {
  return (
    <Card size="sm">
      <CardHeader>
        <span className="mb-2 text-primary [&>svg]:size-5">{icon}</span>
        <CardTitle>{title}</CardTitle>
        <CardDescription className="leading-5">{copy}</CardDescription>
      </CardHeader>
    </Card>
  )
}

function QualityGate({ label }: { label: string }): React.JSX.Element {
  return (
    <li className="flex items-center gap-2 text-sm">
      <span className="flex size-5 items-center justify-center rounded-full bg-success text-success-foreground"><CheckIcon className="size-3" /></span>
      {label}
    </li>
  )
}
