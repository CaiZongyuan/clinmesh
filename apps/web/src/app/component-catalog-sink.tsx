import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from '@clinmesh/ui/components/accordion'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@clinmesh/ui/components/card'
import { ClinicalColorPicker } from '@clinmesh/ui/components/color-picker'
import {
  Combobox,
  ComboboxChip,
  ComboboxChipRemove,
  ComboboxChips,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
} from '@clinmesh/ui/components/combobox'
import { DataGrid } from '@clinmesh/ui/components/data-grid'
import { DataTable, type DataTableColumn } from '@clinmesh/ui/components/data-table'
import { DatePickerField } from '@clinmesh/ui/components/date-picker'
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@clinmesh/ui/components/drawer'
import { FileDropzone } from '@clinmesh/ui/components/file-input'
import { HighlightText } from '@clinmesh/ui/components/highlight-text'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@clinmesh/ui/components/hover-card'
import { InlineEdit } from '@clinmesh/ui/components/inline-edit'
import { Input } from '@clinmesh/ui/components/input'
import { Meter } from '@clinmesh/ui/components/meter'
import { NumberInput } from '@clinmesh/ui/components/number-input'
import { PasswordInputField } from '@clinmesh/ui/components/password-input'
import { Resizable, ResizableHandle, ResizablePanel } from '@clinmesh/ui/components/resizable'
import { ScrollArea } from '@clinmesh/ui/components/scroll-area'
import { SegmentedControl, SegmentedControlItem } from '@clinmesh/ui/components/segmented-control'
import {
  createTimelineController,
  Timeline,
  TimelineConnector,
  TimelineItem,
  TimelineMarker,
  TimelineTime,
  TimelineTitle,
  type TimelineStatus,
} from '@clinmesh/ui/components/timeline'
import { MentionTokenInput, type MentionOption } from '@clinmesh/ui/components/token-input'
import { Toolbar, ToolbarButton, ToolbarSeparator } from '@clinmesh/ui/components/toolbar'
import { Tree, TreeGroup, TreeItem, TreeItemIndicator, TreeItemLabel } from '@clinmesh/ui/components/tree'
import { TruncatedTooltip } from '@clinmesh/ui/components/truncated-tooltip'
import {
  visibleWaterfallRows,
  Waterfall,
  WaterfallAxis,
  WaterfallBar,
  WaterfallCell,
  WaterfallColumnHeader,
  WaterfallHeaderRow,
  WaterfallIndicator,
  WaterfallRow,
  WaterfallRowHeader,
  type WaterfallData,
} from '@clinmesh/ui/components/waterfall'
import { createUndoStack } from '@clinmesh/ui/hooks/use-history'
import {
  BoldIcon,
  FolderIcon,
  ItalicIcon,
  PanelRightOpenIcon,
  Redo2Icon,
  SparklesIcon,
  StethoscopeIcon,
  UnderlineIcon,
  Undo2Icon,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { WorkspaceLocale } from './workspace-i18n.ts'

interface SampleCohortRow {
  id: string
  mrn: string
  name: string
  dept: string
  diagnosis: string
  age: number
  crp: number
  status: 'in-visit' | 'waiting' | 'done'
}

const SAMPLE_COHORT: readonly SampleCohortRow[] = [
  { id: 'c1', mrn: 'CM-2026-001', name: '张琴（合成）', dept: '呼吸内科', diagnosis: '社区获得性肺炎', age: 56, crp: 48.2, status: 'in-visit' },
  { id: 'c2', mrn: 'CM-2026-002', name: '周明（合成）', dept: '全科医学', diagnosis: '原发性高血压', age: 42, crp: 4.1, status: 'waiting' },
  { id: 'c3', mrn: 'CM-2026-003', name: '李建国（合成）', dept: '内分泌科', diagnosis: '2 型糖尿病伴肾病', age: 64, crp: 12.6, status: 'done' },
  { id: 'c4', mrn: 'CM-2026-004', name: '王淑芬（合成）', dept: '心内科', diagnosis: '稳定型心绞痛', age: 68, crp: 9.8, status: 'in-visit' },
  { id: 'c5', mrn: 'CM-2026-005', name: '赵磊（合成）', dept: '呼吸内科', diagnosis: '急性支气管炎', age: 31, crp: 22.4, status: 'waiting' },
  { id: 'c6', mrn: 'CM-2026-006', name: '陈秀英（合成）', dept: '消化内科', diagnosis: '慢性萎缩性胃炎', age: 59, crp: 3.5, status: 'done' },
]

const DIAGNOSIS_OPTIONS = [
  { value: 'J18.9', label: 'J18.9 社区获得性肺炎' },
  { value: 'I10', label: 'I10 原发性高血压' },
  { value: 'E11.9', label: 'E11.9 2 型糖尿病' },
  { value: 'J20.9', label: 'J20.9 急性支气管炎' },
  { value: 'K29.5', label: 'K29.5 慢性胃炎' },
] as const

const MENTION_OPTIONS: readonly MentionOption[] = [
  { value: 'patient:zhangqin', label: '张琴 · 呼吸内科', category: '患者' },
  { value: 'lab:crp-48.2', label: 'CRP 48.2 mg/L ↑', category: '检验' },
  { value: 'img:chest-ct', label: '胸部 CT 平扫报告', category: '影像' },
  { value: 'rx:amoxicillin', label: '阿莫西林克拉维酸钾', category: '处方' },
]

const TIMELINE_EVENTS: readonly {
  id: string
  dateTime: string
  date: string
  title: string
  detail: string
  status: TimelineStatus
}[] = [
  { id: 't1', dateTime: '2026-01-12', date: '01-12', title: '门诊首诊', detail: '主诉咳嗽发热 3 天，完善血常规与胸片检查。', status: 'complete' },
  { id: 't2', dateTime: '2026-01-15', date: '01-15', title: '复诊复查', detail: '体温恢复正常，CRP 由 48.2 降至 14.5 mg/L。', status: 'complete' },
  { id: 't3', dateTime: '2026-02-02', date: '02-02', title: '慢病随访', detail: '血压 134/82 mmHg，规律服用氨氯地平 5mg qd。', status: 'current' },
  { id: 't4', dateTime: '2026-03-02', date: '03-02', title: '计划复诊', detail: '复查肝肾功能、糖化血红蛋白与胸部影像。', status: 'upcoming' },
]

const WATERFALL_SPANS: WaterfallData = [
  { value: 'turn', label: 'clinician_assistant.turn', start: 0, duration: 1180 },
  {
    value: 'context',
    label: 'build_clinical_context',
    start: 18,
    duration: 210,
    children: [
      { value: 'case', label: 'read_visible_case_summary', start: 24, duration: 82 },
      { value: 'labs', label: 'read_lab_results', start: 112, duration: 96 },
    ],
  },
  { value: 'reasoning', label: 'model.thinking', start: 235, duration: 480 },
  { value: 'stream', label: 'model.text_delta', start: 720, duration: 445 },
]

interface UndoSnapshot {
  text: string
  source: 'doctor' | 'assistant'
}

export function ComponentCatalogSink({ locale }: { locale: WorkspaceLocale }): React.JSX.Element {
  const zh = locale === 'zh-CN'

  // 1. DataTable state
  const [tableFilter, setTableFilter] = useState('')
  const [tableStatus, setTableStatus] = useState<'all' | 'in-visit' | 'waiting' | 'done'>('all')
  const [batchMessage, setBatchMessage] = useState<string | null>(null)
  const filteredCohort = useMemo(() => {
    const q = tableFilter.trim().toLowerCase()
    return SAMPLE_COHORT.filter(row => {
      if (tableStatus !== 'all' && row.status !== tableStatus) return false
      if (!q) return true
      return row.name.toLowerCase().includes(q)
        || row.mrn.toLowerCase().includes(q)
        || row.diagnosis.toLowerCase().includes(q)
    })
  }, [tableFilter, tableStatus])

  const cohortColumns = useMemo<readonly DataTableColumn<SampleCohortRow>[]>(() => [
    { id: 'mrn', header: zh ? '病历号' : 'MRN', sortValue: r => r.mrn, cellClassName: 'font-mono text-xs text-muted-foreground', cell: r => r.mrn },
    { id: 'name', header: zh ? '患者' : 'Patient', sortValue: r => r.name, hideable: false, cellClassName: 'font-medium', cell: r => r.name },
    { id: 'dept', header: zh ? '科室' : 'Dept', sortValue: r => r.dept, cell: r => r.dept },
    { id: 'diagnosis', header: zh ? '主诊断' : 'Diagnosis', sortValue: r => r.diagnosis, cell: r => r.diagnosis },
    { id: 'age', header: zh ? '年龄' : 'Age', sortValue: r => r.age, align: 'right', cellClassName: 'tabular-nums', cell: r => r.age },
    { id: 'crp', header: 'CRP (mg/L)', sortValue: r => r.crp, align: 'right', cellClassName: 'font-mono tabular-nums', cell: r => r.crp.toFixed(1) },
    {
      id: 'status',
      header: zh ? '状态' : 'Status',
      sortValue: r => r.status,
      cell: r => (
        <Badge variant={r.status === 'in-visit' ? 'info' : r.status === 'done' ? 'secondary' : 'outline'}>
          {r.status === 'in-visit' ? (zh ? '在诊' : 'Active') : r.status === 'done' ? (zh ? '完诊' : 'Done') : (zh ? '待诊' : 'Waiting')}
        </Badge>
      ),
    },
  ], [zh])

  // 2. Timeline state
  const [tlController] = useState(() => createTimelineController())
  const [selectedEvent, setSelectedEvent] = useState('t3')
  const activeEvent = TIMELINE_EVENTS.find(e => e.id === selectedEvent) ?? TIMELINE_EVENTS[0]!

  // 3. Waterfall state
  const [wfExpanded, setWfExpanded] = useState<string[]>(['context'])
  const [wfSelected, setWfSelected] = useState<string>('reasoning')
  const visibleSpans = useMemo(() => visibleWaterfallRows(WATERFALL_SPANS, wfExpanded), [wfExpanded])

  // 4. Form & picker state
  const [selectedDiagnoses, setSelectedDiagnoses] = useState<string[]>(['J18.9', 'I10'])
  const [dosageMg, setDosageMg] = useState<number | null>(500)
  const [inlineTitle, setInlineTitle] = useState(zh ? '2026 呼吸科社区肺炎随访队列' : '2026 CAP Follow-up Cohort')
  const [highlightQuery, setHighlightQuery] = useState('肺炎')
  const [toolbarNote, setToolbarNote] = useState(zh ? '点击上方工具栏按钮（单一 Tab 停靠，左右方向键切换）' : 'Single tab-stop toolbar (use arrow keys)')

  // 5. History / Agent Rewind demo
  const initialUndo: UndoSnapshot = { text: '主诉：咳嗽伴发热 3 天，最高体温 38.6℃。', source: 'doctor' }
  const undoStackRef = useRef(createUndoStack<UndoSnapshot>(initialUndo, { limit: 12 }))
  const [undoView, setUndoView] = useState<UndoSnapshot>(initialUndo)
  const [undoMeta, setUndoMeta] = useState({ canUndo: false, canRedo: false })

  const applyDraftChange = (next: UndoSnapshot) => {
    undoStackRef.current.record(next)
    setUndoView(next)
    setUndoMeta({ canUndo: undoStackRef.current.canUndo(), canRedo: undoStackRef.current.canRedo() })
  }

  return (
    <section
      aria-labelledby="catalog-sink-group-heading"
      className="flex flex-col gap-8 border-t pt-8"
      data-cm="component-catalog-sink"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold" id="catalog-sink-group-heading">
            {zh ? '交互组件工作坊（UI-SDK Sink 预备库）' : 'Interactive Component Workshop (UI-SDK Sink)'}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {zh
              ? '以下组件均基于 @ui-sdk/react 与 @ui-sdk/core 原语封装于 @clinmesh/ui，已就绪可直接接入临床、科研与智能体页面。'
              : 'All components below are wrapped in @clinmesh/ui on top of @ui-sdk/react & @ui-sdk/core and ready for clinical, research, and agent surfaces.'}
          </p>
        </div>
        <Badge variant="secondary">20+ Ready Primitives</Badge>
      </div>

      {/* 1. Interactive SaaS DataTable */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{zh ? '1. 交互式数据表（DataTable：排序 · 列显隐 · 勾选批量条 · 分页）' : '1. Interactive DataTable'}</CardTitle>
          <CardDescription className="text-xs">
            {zh ? '点击列头可切换升序/降序，点击「显示」控制可见列，勾选多行将浮出底部批量操作栏。' : 'Click column headers to sort, toggle visible columns via Display, or select rows for the floating batch toolbar.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {batchMessage ? (
            <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-1.5 text-xs" role="status">
              <span>{batchMessage}</span>
              <Button onClick={() => setBatchMessage(null)} size="xs" type="button" variant="ghost">
                {zh ? '关闭' : 'Dismiss'}
              </Button>
            </div>
          ) : null}
          <DataTable
            ariaLabel={zh ? '示例交互数据表' : 'Sample interactive data table'}
            columns={cohortColumns}
            getRowId={r => r.id}
            pageSize={4}
            renderBatchActions={(rows, clear) => (
              <Button
                onClick={() => {
                  setBatchMessage(zh ? `已触发批量操作：共处理 ${rows.length} 例病例（${rows.map(r => r.name).join('、')}）` : `Batch processed ${rows.length} rows`)
                  clear()
                }}
                size="xs"
                type="button"
              >
                <SparklesIcon aria-hidden="true" className="size-3.5" />
                <span>{zh ? '批量送入分析' : 'Batch analyze'}</span>
              </Button>
            )}
            rows={filteredCohort}
            selectable
            toolbarLeading={(
              <>
                <Input
                  aria-label={zh ? '过滤示例病例表' : 'Filter sample table'}
                  className="h-8 w-48 text-xs"
                  onChange={e => setTableFilter(e.currentTarget.value)}
                  placeholder={zh ? '筛选患者或诊断…' : 'Filter rows…'}
                  value={tableFilter}
                />
                <SegmentedControl
                  aria-label={zh ? '按就诊状态筛选' : 'Filter by status'}
                  onValueChange={val => {
                    if (val === 'all' || val === 'in-visit' || val === 'waiting' || val === 'done') {
                      setTableStatus(val)
                    }
                  }}
                  value={tableStatus}
                >
                  <SegmentedControlItem value="all">{zh ? '全部' : 'All'}</SegmentedControlItem>
                  <SegmentedControlItem value="in-visit">{zh ? '在诊' : 'Active'}</SegmentedControlItem>
                  <SegmentedControlItem value="waiting">{zh ? '待诊' : 'Waiting'}</SegmentedControlItem>
                  <SegmentedControlItem value="done">{zh ? '完诊' : 'Done'}</SegmentedControlItem>
                </SegmentedControl>
              </>
            )}
          />
        </CardContent>
      </Card>

      {/* 2. Interactive Spreadsheet DataGrid */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{zh ? '2. 可框选数据网格（DataGrid：单元格区间框选 · 实时求和均值 · Excel 复制粘贴）' : '2. Interactive Cell-Range DataGrid'}</CardTitle>
          <CardDescription className="text-xs">
            {zh ? '基于 @ui-sdk/core createGridFocus + createCellRange；鼠标拖拽或 Shift+方向键框选检验数值区域，支持直接 Ctrl+C / Ctrl+V。' : 'Powered by createGridFocus + createCellRange with live count/sum/avg and TSV copy/paste.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataGrid
            ariaLabel={zh ? '检验趋势对比网格' : 'Lab trend grid'}
            columns={['检验项目', '01-12 首诊', '01-15 复诊', '01-22 随访', '02-02 复查']}
            initialRows={[
              ['白细胞 (10^9/L)', '13.4', '9.6', '7.2', '6.4'],
              ['CRP (mg/L)', '48.2', '14.5', '6.8', '3.9'],
              ['中性粒细胞 (%)', '82.1', '71.4', '63.0', '59.5'],
              ['降钙素原 (ng/mL)', '0.68', '0.24', '0.09', '0.05'],
            ]}
          />
        </CardContent>
      </Card>

      {/* 3. Timeline & Waterfall & Tree */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{zh ? '3. 可擦洗就诊时间轴（Timeline）' : '3. Interactive Timeline'}</CardTitle>
            <CardDescription className="text-xs">
              {zh ? '支持方向键移动焦点与按住滑动快速回溯历次诊疗节点。' : 'Keyboard roving focus and pointer-drag scrubbing.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="rounded-md border bg-muted/30 p-3 text-xs">
              <div className="flex items-center justify-between gap-2 font-medium text-foreground">
                <span>{activeEvent.title}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{activeEvent.dateTime}</span>
              </div>
              <p className="mt-1 text-muted-foreground">{activeEvent.detail}</p>
            </div>
            <Timeline
              aria-label={zh ? '患者就诊时间轴' : 'Patient visit timeline'}
              controller={tlController}
              orientation="horizontal"
            >
              {TIMELINE_EVENTS.map(ev => (
                <TimelineItem
                  data-selected={ev.id === selectedEvent || undefined}
                  key={ev.id}
                  onClick={() => setSelectedEvent(ev.id)}
                  onFocus={() => setSelectedEvent(ev.id)}
                  status={ev.status}
                  value={ev.id}
                >
                  <TimelineMarker />
                  <TimelineConnector />
                  <TimelineTitle>{ev.title}</TimelineTitle>
                  <TimelineTime dateTime={ev.dateTime}>{ev.date}</TimelineTime>
                </TimelineItem>
              ))}
            </Timeline>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{zh ? '4. 层级耗时瀑布图（Waterfall）' : '4. Hierarchical Latency Waterfall'}</CardTitle>
            <CardDescription className="text-xs">
              {zh ? '展示 Agent 工具调用与诊疗流程跨度；支持展开子阶段与键盘导航。' : 'Expandable span waterfall for agent traces and clinical workflows.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Waterfall
              aria-label={zh ? '临床助手调用耗时瀑布' : 'Assistant latency waterfall'}
              expanded={wfExpanded}
              items={WATERFALL_SPANS}
              onExpandedChange={setWfExpanded}
              onValueChange={v => { if (v) setWfSelected(v) }}
              value={wfSelected}
            >
              <WaterfallHeaderRow>
                <WaterfallColumnHeader>{zh ? '阶段 / 工具' : 'Span'}</WaterfallColumnHeader>
                <WaterfallColumnHeader>{zh ? '耗时' : 'Duration'}</WaterfallColumnHeader>
                <WaterfallAxis />
              </WaterfallHeaderRow>
              {visibleSpans.map(row => (
                <WaterfallRow key={row.item.value} value={row.item.value}>
                  <WaterfallRowHeader style={{ paddingLeft: `${Math.max(0, row.level - 1) * 14}px` }}>
                    {row.item.children?.length ? <WaterfallIndicator /> : <span className="inline-block w-4 shrink-0" />}
                    <span className="truncate font-mono text-[11px]">{row.item.label}</span>
                  </WaterfallRowHeader>
                  <WaterfallCell>{row.item.duration}ms</WaterfallCell>
                  <WaterfallBar />
                </WaterfallRow>
              ))}
            </Waterfall>
          </CardContent>
        </Card>
      </div>

      {/* 4. Forms & Smart Clinical Pickers */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{zh ? '5. 多选诊断 Combobox · 步进数值 · 日期选择' : '5. Combobox, NumberInput & DatePicker'}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">{zh ? '多选诊断编码（Combobox）' : 'Multi-select Diagnosis'}</span>
              <Combobox
                multiple
                onValueChange={setSelectedDiagnoses}
                value={selectedDiagnoses}
              >
                <ComboboxChips>
                  <ComboboxValue>
                    {({ value }) =>
                      (Array.isArray(value) ? value : []).map(code => {
                        const opt = DIAGNOSIS_OPTIONS.find(o => o.value === code)
                        return (
                          <ComboboxChip key={String(code)} value={String(code)}>
                            <span>{opt?.label ?? String(code)}</span>
                            <ComboboxChipRemove aria-label={`移除 ${opt?.label ?? String(code)}`} />
                          </ComboboxChip>
                        )
                      })
                    }
                  </ComboboxValue>
                  <ComboboxInput aria-label={zh ? '搜索并添加诊断' : 'Search diagnoses'} placeholder={zh ? '输入关键词筛选…' : 'Filter…'} />
                </ComboboxChips>
                <ComboboxContent>
                  <ComboboxList>
                    {DIAGNOSIS_OPTIONS.map(opt => (
                      <ComboboxItem key={opt.value} value={opt.value}>{opt.label}</ComboboxItem>
                    ))}
                  </ComboboxList>
                  <ComboboxEmpty>{zh ? '无匹配诊断' : 'No match'}</ComboboxEmpty>
                </ComboboxContent>
              </Combobox>
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-foreground">{zh ? '给药剂量（NumberInput）' : 'Dosage'}</span>
                <NumberInput
                  inputAriaLabel={zh ? '给药剂量' : 'Dosage'}
                  max={2000}
                  min={50}
                  onValueChange={setDosageMg}
                  step={50}
                  unit="mg"
                  value={dosageMg}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-foreground">{zh ? '随访预约日期（DatePicker）' : 'Follow-up Date'}</span>
                <DatePickerField defaultValue="2026-09-10" inputAriaLabel={zh ? '随访预约日期' : 'Follow-up date'} />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">{zh ? '密钥输入框（PasswordInput · data-agent-secret）' : 'Password / Secret Input'}</span>
              <PasswordInputField
                defaultValue="sk-demo-synthetic-only"
                inputAriaLabel={zh ? '示例密钥输入' : 'Sample secret input'}
                secretAttribute
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{zh ? '6. @ 实体引用框（TokenInput）· 拖拽上传 · 配色校验' : '6. TokenInput, FileDropzone & ColorPicker'}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">{zh ? '临床助手上下文提及（输入 @ 触发）' : 'Context Mentions (type @)'}</span>
              <MentionTokenInput options={MENTION_OPTIONS} />
            </div>
            <FileDropzone
              accept=".zip,.json,.csv"
              hint={zh ? '支持 .zip 主题包或脱敏 CSV 队列，仅本机读取' : 'Local-only .zip or .csv files'}
              title={zh ? '拖拽文件到此上传区（FileDropzone）' : 'Drop files here'}
            />
          </CardContent>
        </Card>
      </div>

      {/* 5. Layout, Overlays, Tree, Meter, ColorPicker & Agent Rewind */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{zh ? '7. 层级目录树（Tree）& 语义计量（Meter）' : '7. Tree & Semantic Meter'}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Tree aria-label={zh ? '科室与诊断分类树' : 'Department tree'} defaultExpanded={['internal', 'resp']}>
              <TreeItem value="internal">
                <TreeItemIndicator />
                <FolderIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                <TreeItemLabel>{zh ? '内科中心' : 'Internal Medicine'}</TreeItemLabel>
                <TreeGroup>
                  <TreeItem value="resp">
                    <TreeItemIndicator />
                    <StethoscopeIcon aria-hidden="true" className="size-3.5 text-info" />
                    <TreeItemLabel>{zh ? '呼吸内科（CAP / COPD）' : 'Pulmonology'}</TreeItemLabel>
                  </TreeItem>
                  <TreeItem value="cardio">
                    <StethoscopeIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                    <TreeItemLabel>{zh ? '心内科（高血压 / 冠心病）' : 'Cardiology'}</TreeItemLabel>
                  </TreeItem>
                </TreeGroup>
              </TreeItem>
              <TreeItem value="research">
                <FolderIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                <TreeItemLabel>{zh ? '临床科研随访组' : 'Research Cohorts'}</TreeItemLabel>
              </TreeItem>
            </Tree>
            <Meter label={zh ? '上下文窗口占用' : 'Context window'} max={100} min={0} tone="info" unitText="%" value={68} />
            <Meter label={zh ? '病区床位占用率' : 'Ward occupancy'} max={100} min={0} tone="warning" unitText="%" value={88} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{zh ? '8. 实时 OKLCH 配色器与 WCAG 测算' : '8. OKLCH ColorPicker + WCAG'}</CardTitle>
          </CardHeader>
          <CardContent>
            <ClinicalColorPicker />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{zh ? '9. Agent 草稿撤销栈（History）& 行内编辑' : '9. Agent Rewind & InlineEdit'}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-xs">
            <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-2.5 py-2">
              <span className="shrink-0 text-muted-foreground">{zh ? '队列标题：' : 'Title:'}</span>
              <InlineEdit onCommit={setInlineTitle} value={inlineTitle} />
            </div>

            <div className="rounded-md border p-2.5">
              <div className="mb-1.5 flex items-center justify-between">
                <Badge variant={undoView.source === 'assistant' ? 'info' : 'secondary'}>
                  {undoView.source === 'assistant' ? (zh ? '来源：临床助手代填' : 'Source: Assistant') : (zh ? '来源：医生手写' : 'Source: Clinician')}
                </Badge>
                <div className="flex items-center gap-1">
                  <Button
                    disabled={!undoMeta.canUndo}
                    onClick={() => {
                      const prev = undoStackRef.current.undo()
                      if (prev) setUndoView(prev)
                      setUndoMeta({ canUndo: undoStackRef.current.canUndo(), canRedo: undoStackRef.current.canRedo() })
                    }}
                    size="xs"
                    type="button"
                    variant="outline"
                  >
                    <Undo2Icon aria-hidden="true" className="size-3" />
                    <span>{zh ? '撤销' : 'Undo'}</span>
                  </Button>
                  <Button
                    disabled={!undoMeta.canRedo}
                    onClick={() => {
                      const next = undoStackRef.current.redo()
                      if (next) setUndoView(next)
                      setUndoMeta({ canUndo: undoStackRef.current.canUndo(), canRedo: undoStackRef.current.canRedo() })
                    }}
                    size="xs"
                    type="button"
                    variant="outline"
                  >
                    <Redo2Icon aria-hidden="true" className="size-3" />
                    <span>{zh ? '重做' : 'Redo'}</span>
                  </Button>
                </div>
              </div>
              <p className="leading-relaxed text-foreground">{undoView.text}</p>
              <Button
                className="mt-2"
                onClick={() =>
                  applyDraftChange({
                    text: '主诉：咳嗽伴发热 3 天，最高体温 38.6℃；伴黄脓痰，否认青霉素过敏史，CRP 48.2 mg/L 提示细菌感染可能（助手补充）。',
                    source: 'assistant',
                  })}
                size="xs"
                type="button"
                variant="secondary"
              >
                <SparklesIcon aria-hidden="true" className="size-3" />
                <span>{zh ? '模拟助手补充病历草稿' : 'Simulate Assistant Edit'}</span>
              </Button>
            </div>

            <div className="flex flex-col gap-1.5">
              <Input
                aria-label={zh ? '高亮关键词测试' : 'Highlight query'}
                className="h-7 text-xs"
                onChange={e => setHighlightQuery(e.currentTarget.value)}
                value={highlightQuery}
              />
              <div className="rounded-md border bg-card px-2.5 py-1.5 text-xs">
                <HighlightText query={highlightQuery} text="社区获得性肺炎（CAP）门诊经验性抗感染与随访复查路径" />
              </div>
              <div className="w-48 rounded-md border bg-card px-2 py-1 text-xs">
                <TruncatedTooltip text="超长临床诊断截断自动提示示例：社区获得性肺炎合并慢性阻塞性肺疾病急性加重期" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 6. Resizable Split Pane, HoverCard, Drawer, Toolbar, Accordion & ScrollArea */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{zh ? '10. 可拖拽分栏（Resizable）· 悬停卡片 · 抽屉 · 工具栏' : '10. Resizable, HoverCard, Drawer & Toolbar'}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Resizable className="h-28 rounded-lg border bg-background">
              <ResizablePanel className="bg-card p-3 text-xs" defaultSize={40} minSize={20}>
                <div className="font-medium text-foreground">{zh ? '候诊队列栏' : 'Queue Pane'}</div>
                <p className="mt-1 text-muted-foreground">{zh ? '拖动中间分隔手柄自由调整左右宽度。' : 'Drag the center handle to resize.'}</p>
              </ResizablePanel>
              <ResizableHandle aria-label={zh ? '调整分栏宽度' : 'Resize panes'} />
              <ResizablePanel className="bg-muted/20 p-3 text-xs" defaultSize={60} minSize={30}>
                <div className="font-medium text-foreground">{zh ? '病例主视图' : 'Case Detail Pane'}</div>
                <p className="mt-1 text-muted-foreground">{zh ? '基于 @ui-sdk/react/resizable 零重渲染驱动。' : 'Zero-rerender CSS var resize.'}</p>
              </ResizablePanel>
            </Resizable>

            <div className="flex flex-wrap items-center gap-3 text-xs">
              <HoverCard>
                <HoverCardTrigger href="#hover-preview" onClick={e => e.preventDefault()}>
                  {zh ? '悬停查看患者速览卡（HoverCard）' : 'Hover for Patient Card'}
                </HoverCardTrigger>
                <HoverCardContent>
                  <div className="font-semibold text-foreground">张琴（合成） · 女 · 56 岁</div>
                  <div className="mt-1 text-muted-foreground">主诊断：社区获得性肺炎 · 过敏史：无已知药物过敏</div>
                  <div className="mt-2 flex gap-1.5">
                    <Badge variant="info">CRP 48.2 ↑</Badge>
                    <Badge variant="outline">T 38.4℃</Badge>
                  </div>
                </HoverCardContent>
              </HoverCard>

              <Drawer>
                <DrawerTrigger
                  render={(
                    <Button size="xs" type="button" variant="outline">
                      <PanelRightOpenIcon aria-hidden="true" className="size-3.5" />
                      <span>{zh ? '打开阻尼侧抽屉（Drawer）' : 'Open Drawer'}</span>
                    </Button>
                  )}
                />
                <DrawerContent side="right">
                  <DrawerHeader>
                    <DrawerTitle>{zh ? '临床参考抽屉（Drawer）' : 'Clinical Reference Drawer'}</DrawerTitle>
                    <DrawerDescription>{zh ? '基于 @ui-sdk/react/drawer，支持 Esc 关闭与焦锁恢复。' : 'Accessible slide-over drawer.'}</DrawerDescription>
                  </DrawerHeader>
                  <ScrollArea className="flex-1 p-4">
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {zh
                        ? '可用于展示国家药品说明书摘要、历史检验对比或移动端空间导航，不遮断主表单草稿状态。'
                        : 'Ideal for drug monographs, lab comparisons, or inspection overlays without discarding unsaved drafts.'}
                    </p>
                  </ScrollArea>
                </DrawerContent>
              </Drawer>
            </div>

            <div className="flex flex-col gap-1.5">
              <Toolbar aria-label={zh ? '病历排版工具栏' : 'Formatting toolbar'}>
                <ToolbarButton onClick={() => setToolbarNote(zh ? '已切换：加粗重点体征' : 'Bold toggled')}>
                  <BoldIcon aria-hidden="true" className="size-3.5" />
                </ToolbarButton>
                <ToolbarButton onClick={() => setToolbarNote(zh ? '已切换：斜体标注鉴别诊断' : 'Italic toggled')}>
                  <ItalicIcon aria-hidden="true" className="size-3.5" />
                </ToolbarButton>
                <ToolbarButton onClick={() => setToolbarNote(zh ? '已切换：下划线标记危急值' : 'Underline toggled')}>
                  <UnderlineIcon aria-hidden="true" className="size-3.5" />
                </ToolbarButton>
                <ToolbarSeparator />
                <ToolbarButton onClick={() => setToolbarNote(zh ? '已插入：标准体格检查模板' : 'Template inserted')}>
                  <span>{zh ? '插入模板' : 'Template'}</span>
                </ToolbarButton>
              </Toolbar>
              <span className="text-[11px] text-muted-foreground">{toolbarNote}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{zh ? '11. 临床指南折叠手风琴（Accordion）& 精细滚动区' : '11. Accordion & ScrollArea'}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Accordion defaultValue={['q1']}>
              <AccordionItem value="q1">
                <AccordionTrigger>{zh ? '为什么 ClinMesh 默认保留原版视觉？' : 'Why does ClinMesh preserve the default look?'}</AccordionTrigger>
                <AccordionPanel>
                  {zh ? '临床系统强调低认知迁移成本，默认主题保持原版高可读蓝灰体系不变，同时提供 5 套原创临床主题与零 JS 本地 .zip 扩展。' : 'Zero visual disruption by default, with 5 original palettes and zero-JS .zip custom themes.'}
                </AccordionPanel>
              </AccordionItem>
              <AccordionItem value="q2">
                <AccordionTrigger>{zh ? '哪些临床动作禁止绑定为单键快捷键？' : 'Which clinical commits block single-key shortcuts?'}</AccordionTrigger>
                <AccordionPanel>
                  {zh ? '所有带 data-agent-confirm 的正式写入（签发处方、确认诊断、完诊、收费退款等）强制要求人工显式确认，防止误触。' : 'All formal clinical writes carrying data-agent-confirm require explicit human confirmation.'}
                </AccordionPanel>
              </AccordionItem>
              <AccordionItem value="q3">
                <AccordionTrigger>{zh ? '如何把这里的组件应用到业务页面？' : 'How to adopt these components?'}</AccordionTrigger>
                <AccordionPanel>
                  {zh ? '全部组件均位于 packages/ui/src/components，通过 @clinmesh/ui/components/* 直接引入即可，自动继承当前激活主题与暗色模式。' : 'Import directly from @clinmesh/ui/components/* — all tokens inherit the active theme automatically.'}
                </AccordionPanel>
              </AccordionItem>
            </Accordion>
          </CardContent>
        </Card>
      </div>
    </section>
  )
}
