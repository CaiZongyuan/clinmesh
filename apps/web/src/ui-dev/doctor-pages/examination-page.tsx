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
import {
  CheckIcon,
  ClipboardListIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
} from 'lucide-react'
import { useState } from 'react'

type ExaminationPriority = 'urgent' | 'normal'
type ResultFilter = 'all' | 'pending' | 'reported'
type WorkflowStatus = '待执行' | '报告审核中' | '报告已出'

interface ExaminationCatalogItem {
  department: string
  id: string
  name: string
  purpose: string
}

interface ExaminationRequest extends ExaminationCatalogItem {
  priority: ExaminationPriority
}

interface ExaminationWorkflowRow {
  finding: string
  id: string
  name: string
  progress: number
  status: WorkflowStatus
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
  { ...examinationCatalog[0], priority: 'normal' },
  { ...examinationCatalog[1], priority: 'normal' },
  { ...examinationCatalog[2], priority: 'normal' },
]

const initialWorkflowRows = [
  {
    finding: '两肺纹理增多，未见明显实变影；心影大小、形态正常。',
    id: 'chest-xray',
    name: '胸部 X 线片（正位）',
    progress: 100,
    status: '报告已出',
    time: '06-06 09:45',
  },
  {
    finding: '检查已完成，影像报告正在审核。',
    id: 'chest-ct',
    name: '胸部 CT 平扫',
    progress: 82,
    status: '报告审核中',
    time: '06-06 10:18',
  },
  {
    finding: '窦性心律，心率 86 次/分，ST-T 非特异性改变。',
    id: 'ecg',
    name: '十二导联心电图',
    progress: 100,
    status: '报告已出',
    time: '06-06 09:32',
  },
] as const satisfies readonly ExaminationWorkflowRow[]

const resultFilterItems = [
  { label: '全部状态', value: 'all' },
  { label: '报告已出', value: 'reported' },
  { label: '处理中', value: 'pending' },
] as const satisfies ReadonlyArray<{ label: string; value: ResultFilter }>

export function ExaminationPage(): React.JSX.Element {
  const [composerOpen, setComposerOpen] = useState(false)
  const [clinicalPurpose, setClinicalPurpose] = useState('明确肺部感染情况，评估病变范围与严重程度。')
  const [priority, setPriority] = useState<ExaminationPriority>('normal')
  const [requests, setRequests] = useState<ExaminationRequest[]>(initialRequests)
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all')
  const [search, setSearch] = useState('')
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([])
  const [workflowRows, setWorkflowRows] = useState<ExaminationWorkflowRow[]>([...initialWorkflowRows])

  const normalizedSearch = search.trim().toLowerCase()
  const catalogItems = normalizedSearch.length === 0
    ? examinationCatalog
    : examinationCatalog.filter(item => `${item.name}${item.department}`.toLowerCase().includes(normalizedSearch))
  const requestedIds = new Set(requests.map(item => item.id))
  const filteredResults = workflowRows.filter(result => {
    if (resultFilter === 'reported') return result.status === '报告已出'
    if (resultFilter === 'pending') return result.status !== '报告已出'
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
      ...selectedItems.map(item => ({ ...item, priority, purpose: clinicalPurpose })),
    ])
    setWorkflowRows(current => [
      ...current,
      ...selectedItems.map(item => ({
        finding: '检查已开立，等待患者完成预约与执行。',
        id: item.id,
        name: item.name,
        progress: 18,
        status: '待执行' as const,
        time: '刚刚开立',
      })),
    ])
    setSelectedProjectIds([])
    setComposerOpen(false)
  }

  return (
    <>
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(20rem,0.82fr)_minmax(0,1.18fr)]">
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
              <col className="w-[46%]" />
              <col className="w-[54%]" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>检查项目</TableHead>
                <TableHead>临床目的</TableHead>
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
          description={`${workflowRows.filter(row => row.status === '报告已出').length} 份报告 · ${workflowRows.length} 项检查`}
          title="检查结果与进度"
        >
          <Table className="table-fixed">
            <colgroup>
              <col className="w-[30%]" />
              <col className="w-[43%]" />
              <col className="w-[27%]" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>检查项目</TableHead>
                <TableHead>主要所见</TableHead>
                <TableHead>执行进度</TableHead>
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
                  <TableCell className="whitespace-normal">
                    <div className="flex items-center gap-2">
                      <Progress aria-label={`${result.name}${result.status}`} className="min-w-16 flex-1" value={result.progress} />
                      <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{result.progress}%</span>
                    </div>
                    <Badge className="mt-2" variant={result.status === '报告已出' ? 'success' : result.status === '报告审核中' ? 'warning' : 'secondary'}>{result.status}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
    <section className="flex min-h-[34rem] min-w-0 flex-col overflow-hidden rounded-lg border bg-background">
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
