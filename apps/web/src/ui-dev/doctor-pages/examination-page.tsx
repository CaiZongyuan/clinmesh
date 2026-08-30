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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@clinmesh/ui/components/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { cn } from '@clinmesh/ui/lib/utils'
import {
  CalendarClockIcon,
  CheckIcon,
  CircleCheckIcon,
  ClipboardListIcon,
  FileCheck2Icon,
  FileTextIcon,
  PlusIcon,
  RefreshCwIcon,
  ScanLineIcon,
  SearchIcon,
} from 'lucide-react'
import { useState } from 'react'

type ExaminationPriority = 'urgent' | 'normal'
type ExaminationRequestStatus = '已出报告' | '已开立' | '已执行' | '已预约'
type ResultFilter = 'all' | 'pending' | 'reported'

interface ExaminationCatalogItem {
  department: string
  id: string
  name: string
  purpose: string
}

interface ExaminationRequest extends ExaminationCatalogItem {
  priority: ExaminationPriority
  status: ExaminationRequestStatus
}

interface ExaminationResult {
  finding: string
  id: string
  name: string
  reportStatus: '待审核' | '报告已出'
  time: string
}

const examinationCatalog = [
  { department: '放射科', id: 'chest-xray', name: '胸部 X 线片（正位）', purpose: '排查肺部感染、肺结核及肺不张' },
  { department: '放射科', id: 'chest-ct', name: '胸部 CT 平扫', purpose: '进一步评估肺部病变范围与性质' },
  { department: '心电图室', id: 'ecg', name: '十二导联心电图', purpose: '评估心律及心肌缺血风险' },
  { department: '超声科', id: 'abdomen-ultrasound', name: '腹部彩超（肝胆胰脾）', purpose: '评估上腹部脏器情况' },
  { department: '肺功能室', id: 'pulmonary-function', name: '肺功能检查', purpose: '评估通气功能和阻塞程度' },
] as const satisfies readonly ExaminationCatalogItem[]

const initialRequests: ExaminationRequest[] = [
  { ...examinationCatalog[0], priority: 'normal', status: '已预约' },
  { ...examinationCatalog[1], priority: 'normal', status: '已执行' },
  { ...examinationCatalog[2], priority: 'normal', status: '已出报告' },
]

const examinationResults = [
  {
    finding: '两肺纹理增多，未见明显实变影；心影大小、形态正常。',
    id: 'chest-xray',
    name: '胸部 X 线片（正位）',
    reportStatus: '报告已出',
    time: '06-06 09:45',
  },
  {
    finding: '双肺下叶见片状磨玻璃影，右肺中叶见约 4 mm 小结节影。',
    id: 'chest-ct',
    name: '胸部 CT 平扫',
    reportStatus: '待审核',
    time: '06-06 10:18',
  },
  {
    finding: '窦性心律，心率 86 次/分，ST-T 非特异性改变。',
    id: 'ecg',
    name: '十二导联心电图',
    reportStatus: '报告已出',
    time: '06-06 09:32',
  },
] as const satisfies readonly ExaminationResult[]

const evidenceFacts = [
  { label: '主诉', value: '咳嗽伴胸闷 3 天，夜间加重，偶有白痰。' },
  { label: '现病史', value: '受凉后出现咳嗽，伴胸闷，无胸痛、气促及咯血。' },
  { label: '体格检查', value: '体温 37.6°C，双肺呼吸音清，心率 86 次/分。' },
  { label: '初步判断', value: '急性上呼吸道感染，需排除肺部感染及其他病变。' },
  { label: '检查目的', value: '明确病因，评估肺部感染范围并排除心源性风险。' },
] as const

const progressItems = [
  { label: '胸部 X 线片', progress: 100, status: '已出报告', time: '10:02' },
  { label: '胸部 CT 平扫', progress: 80, status: '待审核', time: '10:18' },
  { label: '十二导联心电图', progress: 100, status: '已出报告', time: '09:36' },
] as const

const resultFilterItems = [
  { label: '全部状态', value: 'all' },
  { label: '报告已出', value: 'reported' },
  { label: '待审核', value: 'pending' },
] as const satisfies ReadonlyArray<{ label: string; value: ResultFilter }>

const progressStages = [
  { complete: true, icon: FileTextIcon, label: '已申请', time: '09:18' },
  { complete: true, icon: FileCheck2Icon, label: '已缴费', time: '09:20' },
  { complete: true, icon: CalendarClockIcon, label: '已预约', time: '09:22' },
  { active: true, icon: ScanLineIcon, label: '执行中', time: '3 / 5 项' },
  { icon: ClipboardListIcon, label: '出报告', time: '部分完成' },
] as const

export function ExaminationPage(): React.JSX.Element {
  const [composerOpen, setComposerOpen] = useState(false)
  const [clinicalPurpose, setClinicalPurpose] = useState('明确肺部感染情况，评估病变范围与严重程度。')
  const [priority, setPriority] = useState<ExaminationPriority>('normal')
  const [requests, setRequests] = useState<ExaminationRequest[]>(initialRequests)
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all')
  const [search, setSearch] = useState('')
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([])

  const normalizedSearch = search.trim().toLowerCase()
  const catalogItems = normalizedSearch.length === 0
    ? examinationCatalog
    : examinationCatalog.filter(item => `${item.name}${item.department}`.toLowerCase().includes(normalizedSearch))
  const requestedIds = new Set(requests.map(item => item.id))
  const filteredResults = examinationResults.filter(result => {
    if (resultFilter === 'reported') return result.reportStatus === '报告已出'
    if (resultFilter === 'pending') return result.reportStatus === '待审核'
    return true
  })

  function openComposer(presetIds: string[] = []): void {
    setSearch('')
    setSelectedProjectIds(presetIds.filter(id => !requestedIds.has(id)))
    setComposerOpen(true)
  }

  function toggleProject(id: string, checked: boolean): void {
    setSelectedProjectIds(current => checked ? [...current, id] : current.filter(projectId => projectId !== id))
  }

  function createRequests(): void {
    const selectedItems = examinationCatalog.filter(item => selectedProjectIds.includes(item.id) && !requestedIds.has(item.id))
    if (selectedItems.length === 0) return

    setRequests(current => [
      ...current,
      ...selectedItems.map(item => ({ ...item, priority, purpose: clinicalPurpose, status: '已开立' as const })),
    ])
    setSelectedProjectIds([])
    setComposerOpen(false)
  }

  return (
    <>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <WorkspaceSection
          action={
            <div className="flex items-center gap-2">
              <Button onClick={() => openComposer()} size="sm">
                <PlusIcon data-icon="inline-start" />
                新增检查
              </Button>
              <Button onClick={() => openComposer(['pulmonary-function'])} size="sm" variant="outline">
                <ClipboardListIcon data-icon="inline-start" />
                套餐模板
              </Button>
            </div>
          }
          description={`共 ${requests.length} 项 · 本次就诊`}
          title="检查申请"
        >
          <Table className="table-fixed">
            <colgroup>
              <col className="w-[42%]" />
              <col className="w-[38%]" />
              <col className="w-[20%]" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>检查项目</TableHead>
                <TableHead>临床目的</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map(request => (
                <TableRow key={request.id}>
                  <TableCell className="whitespace-normal">
                    <strong className="block text-xs leading-5">{request.name}</strong>
                    <span className="block text-xs leading-5 text-muted-foreground">
                      {request.department} · {request.priority === 'urgent' ? '加急' : '普通'}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-normal text-xs leading-5 text-muted-foreground">{request.purpose}</TableCell>
                  <TableCell>
                    <RequestStatusBadge status={request.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </WorkspaceSection>

        <WorkspaceSection
          action={
            <div className="flex items-center gap-2">
              <Button aria-label="刷新检查结果" size="icon-sm" title="刷新检查结果" variant="outline">
                <RefreshCwIcon />
              </Button>
              <Select
                items={resultFilterItems}
                onValueChange={value => { if (value !== null) setResultFilter(value as ResultFilter) }}
                value={resultFilter}
              >
                <SelectTrigger aria-label="筛选检查结果" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {resultFilterItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          }
          description="最近一次同步 10:26"
          title="检查结果"
        >
          <Table className="table-fixed">
            <colgroup>
              <col className="w-[34%]" />
              <col className="w-[46%]" />
              <col className="w-[20%]" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>检查项目</TableHead>
                <TableHead>主要所见</TableHead>
                <TableHead>报告状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredResults.map(result => (
                <TableRow key={result.id}>
                  <TableCell className="whitespace-normal">
                    <strong className="block text-xs leading-5">{result.name}</strong>
                    <span className="block text-xs tabular-nums text-muted-foreground">{result.time}</span>
                  </TableCell>
                  <TableCell className="whitespace-normal text-xs leading-5">{result.finding}</TableCell>
                  <TableCell>
                    <Badge variant={result.reportStatus === '报告已出' ? 'success' : 'warning'}>{result.reportStatus}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </WorkspaceSection>

        <WorkspaceSection description="来自当前问诊记录" title="检查相关病历依据">
          <dl className="flex flex-col px-4 py-2">
            {evidenceFacts.map(fact => (
              <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-4 border-b py-3 last:border-b-0" key={fact.label}>
                <dt className="text-xs font-medium text-muted-foreground">{fact.label}</dt>
                <dd className="text-sm leading-6">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </WorkspaceSection>

        <WorkspaceSection description="预计 12:30 前全部完成" title="检查进度">
          <ol className="grid grid-cols-5 border-b px-4 py-5">
            {progressStages.map((stage, index) => (
              <ProgressStage index={index} key={stage.label} {...stage} />
            ))}
          </ol>
          <div className="flex flex-col px-4 py-2">
            {progressItems.map(item => (
              <div className="grid grid-cols-[minmax(7rem,1fr)_6rem_4.5rem] items-center gap-3 border-b py-3 last:border-b-0" key={item.label}>
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{item.label}</p>
                  <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">{item.time}</p>
                </div>
                <Progress aria-label={`${item.label}进度 ${item.progress}%`} value={item.progress} />
                <Badge variant={item.status === '已出报告' ? 'success' : 'warning'}>{item.status}</Badge>
              </div>
            ))}
          </div>
          <div className="mt-auto flex items-center border-t px-4 py-3 text-xs">
            <span>当前完成 <strong className="text-primary">3 / 5</strong> 项</span>
            <Button className="ml-auto" size="xs" variant="link">查看详情</Button>
          </div>
        </WorkspaceSection>
      </div>

      <Sheet onOpenChange={setComposerOpen} open={composerOpen}>
        <SheetContent className="w-full sm:max-w-xl" side="right">
          <SheetHeader>
            <SheetTitle>新增检查</SheetTitle>
            <SheetDescription>选择检查项目并补充本次申请的临床目的。</SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="examination-search">查找检查项目</FieldLabel>
                <InputGroup>
                  <InputGroupAddon><SearchIcon aria-hidden="true" /></InputGroupAddon>
                  <InputGroupInput
                    id="examination-search"
                    onChange={event => setSearch(event.target.value)}
                    placeholder="搜索名称或执行科室"
                    value={search}
                  />
                </InputGroup>
              </Field>

              <FieldSet>
                <FieldLegend variant="label">检查项目</FieldLegend>
                <FieldGroup>
                  {catalogItems.map(item => {
                    const alreadyRequested = requestedIds.has(item.id)
                    return (
                      <FieldLabel key={item.id}>
                        <Field data-disabled={alreadyRequested || undefined} orientation="horizontal">
                          <Checkbox
                            checked={selectedProjectIds.includes(item.id)}
                            disabled={alreadyRequested}
                            onCheckedChange={checked => toggleProject(item.id, checked === true)}
                          />
                          <FieldContent>
                            <FieldTitle>
                              {item.name}
                              {alreadyRequested ? <Badge variant="secondary">已申请</Badge> : null}
                            </FieldTitle>
                            <FieldDescription>{item.department} · {item.purpose}</FieldDescription>
                          </FieldContent>
                        </Field>
                      </FieldLabel>
                    )
                  })}
                </FieldGroup>
              </FieldSet>

              <FieldSet>
                <FieldLegend variant="label">优先级</FieldLegend>
                <ToggleGroup
                  onValueChange={values => {
                    const next = values[0] as ExaminationPriority | undefined
                    if (next !== undefined) setPriority(next)
                  }}
                  size="sm"
                  spacing={0}
                  value={[priority]}
                  variant="outline"
                >
                  <ToggleGroupItem value="normal">普通</ToggleGroupItem>
                  <ToggleGroupItem value="urgent">加急</ToggleGroupItem>
                </ToggleGroup>
              </FieldSet>

              <Field>
                <FieldLabel htmlFor="examination-purpose">临床目的</FieldLabel>
                <Textarea
                  id="examination-purpose"
                  onChange={event => setClinicalPurpose(event.target.value)}
                  rows={4}
                  value={clinicalPurpose}
                />
                <FieldDescription>将同步写入本次检查申请。</FieldDescription>
              </Field>
            </FieldGroup>
          </div>
          <SheetFooter className="border-t">
            <div className="flex items-center gap-2">
              <span className="mr-auto text-xs text-muted-foreground">已选择 {selectedProjectIds.length} 项</span>
              <Button onClick={() => setComposerOpen(false)} variant="outline">取消</Button>
              <Button disabled={selectedProjectIds.length === 0 || clinicalPurpose.trim().length === 0} onClick={createRequests}>
                <CheckIcon data-icon="inline-start" />
                确认开立
              </Button>
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  )
}

function WorkspaceSection({
  action,
  children,
  description,
  title,
}: {
  action?: React.ReactNode
  children: React.ReactNode
  description: string
  title: string
}): React.JSX.Element {
  return (
    <section className="flex min-h-[21rem] min-w-0 flex-col overflow-hidden rounded-lg border bg-background">
      <header className="flex min-h-14 items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>
        </div>
        {action === undefined ? null : <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div>}
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
    </section>
  )
}

function RequestStatusBadge({ status }: { status: ExaminationRequestStatus }): React.JSX.Element {
  const variant = status === '已出报告' ? 'success' : status === '已执行' ? 'info' : status === '已开立' ? 'secondary' : 'warning'
  return <Badge variant={variant}>{status}</Badge>
}

function ProgressStage({
  active = false,
  complete = false,
  icon: Icon,
  index,
  label,
  time,
}: {
  active?: boolean
  complete?: boolean
  icon: typeof FileTextIcon
  index: number
  label: string
  time: string
}): React.JSX.Element {
  return (
    <li className="relative flex min-w-0 flex-col items-center gap-1.5 text-center">
      {index === 0 ? null : <span aria-hidden="true" className="absolute right-1/2 top-4 h-px w-full bg-border" />}
      <span className={cn(
        'relative flex size-8 items-center justify-center rounded-full border bg-background [&>svg]:size-4',
        complete ? 'border-primary text-primary' : active ? 'border-info text-info' : 'text-muted-foreground',
      )}>
        {complete ? <CircleCheckIcon aria-hidden="true" /> : <Icon aria-hidden="true" />}
      </span>
      <span className="text-xs font-medium">{label}</span>
      <span className="text-[0.6875rem] tabular-nums text-muted-foreground">{time}</span>
    </li>
  )
}
