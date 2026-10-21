import { prescriptionDraftItemSchema } from '@clinmesh/contracts/his'
import type {
  CaseLaboratoryCatalogSearch,
  ClinicalCatalog,
  DiagnosisDraftEntry,
  LaboratoryServiceSnapshot,
} from '@clinmesh/contracts/his'
import type {
  ReferenceConcept,
  ReferenceConceptSnapshot,
  ReferenceDiagnosisCatalogSearch,
  ReferenceMedicationCatalogSearch,
  ReferenceMedicationProduct,
} from '@clinmesh/contracts/reference-data'
import { Alert, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@clinmesh/ui/components/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@clinmesh/ui/components/select'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { WorkspaceSelect } from '../workspace-select.tsx'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { cn } from '@clinmesh/ui/lib/utils'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleIcon,
  CircleAlertIcon,
  ListPlusIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import type { WorkspaceLocale } from '../workspace-i18n.ts'

type TriggerMode = 'add' | 'replace' | 'select'
type PrescriptionCatalog = Extract<ClinicalCatalog, { prescriptionConclusionSupported: true }>
type PrescriptionMedication = PrescriptionCatalog['medications'][number]

export interface ReferenceCatalogSearchModel<Data> {
  data: Data | undefined
  error: Error | null
  isError: boolean
  isFetching: boolean
  isPending: boolean
  onSearch: (query: string, page: number) => void
}

export interface ReferenceCatalogSearches {
  diagnoses: ReferenceCatalogSearchModel<ReferenceDiagnosisCatalogSearch>
  laboratory: ReferenceCatalogSearchModel<CaseLaboratoryCatalogSearch>
  medications: ReferenceCatalogSearchModel<ReferenceMedicationCatalogSearch>
}

const copy = {
  'en-US': {
    addDiagnosis: 'Add diagnosis',
    addMedication: 'Add medication',
    catalogUnavailable: 'The global catalog is unavailable. Use local common items or retry.',
    choose: 'Select',
    chooseDiagnosis: 'Select diagnosis',
    chooseLaboratory: 'Select laboratory item',
    chooseMedication: 'Select medication',
    close: 'Cancel',
    collapseCatalog: 'Collapse catalog',
    expandCatalog: 'Expand catalog',
    confirmDiagnosis: 'Add diagnosis',
    confirmLaboratory: 'Select',
    confirmMedication: 'Add to prescription',
    course: 'Course',
    days: 'days',
    diagnosisDescription: 'Current diagnosis catalog',
    diagnosisDetails: 'Diagnosis details',
    diagnosisNote: 'Diagnosis note',
    diagnosisPlaceholder: 'Name or code (2+ characters)',
    diagnosisRole: 'Diagnosis role',
    diagnosisSearchInput: 'Search diagnosis catalog',
    dose: 'Dose',
    editDiagnosis: 'Edit diagnosis',
    editMedication: 'Edit medication',
    frequency: 'Frequency',
    laboratoryDescription: 'Current laboratory catalog',
    laboratoryPlaceholder: 'Name or LOINC (2+ characters)',
    laboratorySearchInput: 'Search laboratory catalog',
    localCatalog: 'Local common',
    localMedication: 'Local common medication',
    medicationComposerDescription: 'Pick a product in the catalog, then enter the order; one dialog confirms one medication order.',
    medicationDescription: 'Current medication product catalog',
    medicationDetails: 'Medication order',
    medicationFieldsError: 'Enter dose and frequency. Course must be 1–30 days and quantity an integer from 1–1000.',
    medicationPlaceholder: 'Generic name, brand, manufacturer, or code',
    medicationSearchInput: 'Search medication catalog',
    next: 'Next page',
    noResults: 'No matching records',
    previous: 'Previous page',
    primaryDiagnosis: 'Primary diagnosis',
    quantity: 'Quantity',
    replaceDiagnosis: 'Replace diagnosis',
    replaceMedication: 'Replace medication',
    searchDiagnosis: 'Search diagnosis catalog',
    searchLaboratory: 'Search laboratory catalog',
    searchMedication: 'Search medication catalog',
    selectLaboratory: 'Select laboratory item',
    secondaryDiagnosis: 'Secondary diagnosis',
    total: '{total} records',
    updateDiagnosis: 'Save changes',
    updateMedication: 'Save changes',
  },
  'zh-CN': {
    addDiagnosis: '添加诊断',
    addMedication: '添加药品',
    catalogUnavailable: '全局目录暂不可用，可使用本院常用项或重试。',
    choose: '选择',
    chooseDiagnosis: '选择诊断',
    chooseLaboratory: '选择检验项目',
    chooseMedication: '选择药品',
    close: '取消',
    collapseCatalog: '收起目录',
    expandCatalog: '展开目录',
    confirmDiagnosis: '加入诊断',
    confirmLaboratory: '确定选择',
    confirmMedication: '加入处方',
    course: '疗程',
    days: '天',
    diagnosisDescription: '当前疾病诊断目录',
    diagnosisDetails: '诊断信息',
    diagnosisNote: '诊断备注',
    diagnosisPlaceholder: '病名或编码（至少 2 字）',
    diagnosisRole: '诊断类型',
    diagnosisSearchInput: '搜索疾病目录',
    dose: '剂量',
    editDiagnosis: '编辑诊断',
    editMedication: '编辑药品',
    frequency: '频次',
    laboratoryDescription: '当前检验目录',
    laboratoryPlaceholder: '检验名称或 LOINC（至少 2 字）',
    laboratorySearchInput: '搜索检验目录',
    localCatalog: '本院常用',
    localMedication: '本院常用药',
    medicationComposerDescription: '在目录中选择药品包装后填写用药信息，一次弹窗确认一条药品医嘱。',
    medicationDescription: '当前药品产品目录',
    medicationDetails: '用药信息',
    medicationFieldsError: '请填写剂量与频次，疗程为 1–30 天，数量为 1–1000 的整数。',
    medicationPlaceholder: '通用名、商品名、厂家或编码',
    medicationSearchInput: '搜索药品目录',
    next: '下一页',
    noResults: '没有匹配记录',
    previous: '上一页',
    primaryDiagnosis: '主诊断',
    quantity: '数量',
    replaceDiagnosis: '更换诊断',
    replaceMedication: '更换药品',
    searchDiagnosis: '执行疾病目录搜索',
    searchLaboratory: '执行检验目录搜索',
    searchMedication: '执行药品目录搜索',
    selectLaboratory: '选择检验项目',
    secondaryDiagnosis: '次诊断',
    total: '共 {total} 条',
    updateDiagnosis: '保存修改',
    updateMedication: '保存修改',
  },
} as const

function totalLabel(template: string, total: number): string {
  return template.replace('{total}', String(total))
}

function CatalogSearchForm({
  active,
  expansion,
  query,
  input,
  inputLabel,
  label,
  onInputChange,
  onSearch,
  pending,
  placeholder,
}: {
  active: boolean
  expansion?: { expanded: boolean; onChange: (expanded: boolean) => void; resultsId: string; locale: WorkspaceLocale } | undefined
  query: string
  input: string
  inputLabel: string
  label: string
  onInputChange: (value: string) => void
  onSearch: () => void
  pending: boolean
  placeholder: string
}) {
  // DSH 宿主运行 React 18.3.1，无 useEffectEvent（19.2 才转正）；用 latest ref 在不加入依赖的情况下调用最新回调。
  const searchLatestRef = useRef(onSearch)
  useEffect(() => {
    searchLatestRef.current = onSearch
  })
  useEffect(() => {
    const nextQuery = input.trim()
    if (!active || nextQuery.length === 1 || nextQuery === query) return
    const timer = setTimeout(() => { searchLatestRef.current() }, 300)
    return () => clearTimeout(timer)
  }, [active, input, query])
  const expansionTrigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const trigger = expansionTrigger.current
    if (expansion?.expanded !== false || trigger === null) return
    const root = trigger.getRootNode()
    if (!(root instanceof Document || root instanceof ShadowRoot)) return
    if (root.activeElement !== null && root.getElementById(expansion.resultsId)?.contains(root.activeElement)) trigger.focus()
  }, [expansion?.expanded, expansion?.resultsId])
  const invalidLength = input.trim().length === 1
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!invalidLength) onSearch()
  }
  return (
    <form className="flex shrink-0 items-center gap-2 px-3 py-2.5" onSubmit={submit}>
      <Input
        aria-label={inputLabel}
        aria-invalid={invalidLength}
        className="min-w-0 flex-1"
        onChange={event => onInputChange(event.currentTarget.value)}
        onFocus={() => expansion?.onChange(true)}
        placeholder={placeholder}
        value={input}
      />
      <Button
        aria-label={label}
        disabled={pending || invalidLength}
        size="icon"
        title={label}
        type="submit"
        variant="outline"
      >
        {pending ? <LoaderCircleIcon className="animate-spin" /> : <SearchIcon />}
      </Button>
      {expansion === undefined ? null : <Button
        ref={expansionTrigger}
        aria-controls={expansion.resultsId}
        aria-expanded={expansion.expanded}
        aria-label={copy[expansion.locale][expansion.expanded ? 'collapseCatalog' : 'expandCatalog']}
        onClick={() => expansion.onChange(!expansion.expanded)}
        size="icon"
        type="button"
        variant="outline"
      >
        {expansion.expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
      </Button>}
    </form>
  )
}

function CatalogPagination({
  locale,
  onPageChange,
  page,
  pageSize,
  total,
}: {
  locale: WorkspaceLocale
  onPageChange: (page: number) => void
  page: number
  pageSize: number
  total: number
}) {
  const messages = copy[locale]
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="flex shrink-0 items-center justify-between border-t px-3 py-2">
      <span className="text-xs text-muted-foreground">
        {totalLabel(messages.total, total)} · {page}/{pageCount}
      </span>
      <div className="flex gap-1">
        <Button
          aria-label={messages.previous}
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          size="icon-sm"
          title={messages.previous}
          type="button"
          variant="ghost"
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          aria-label={messages.next}
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
          size="icon-sm"
          title={messages.next}
          type="button"
          variant="ghost"
        >
          <ChevronRightIcon />
        </Button>
      </div>
    </div>
  )
}

function CatalogTriggerButton({
  catalog,
  disabled,
  label,
  mode,
  onClick,
}: {
  catalog: 'diagnosis' | 'laboratory' | 'medication'
  disabled?: boolean
  label: string
  mode: TriggerMode
  onClick: () => void
}) {
  if (mode === 'replace') {
    return (
      <Button
        data-agent-catalog-trigger={catalog}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        size="icon-sm"
        title={label}
        type="button"
        variant="ghost"
      >
        <PencilIcon />
      </Button>
    )
  }
  return (
    <Button data-agent-catalog-trigger={catalog} disabled={disabled} onClick={onClick} size="sm" type="button" variant="outline">
      {mode === 'add'
        ? <PlusIcon data-icon="inline-start" />
        : <ListPlusIcon data-icon="inline-start" />}
      {label}
    </Button>
  )
}

function SelectionButton({
  disabled,
  label,
  onSelectedChange,
  selected,
}: {
  disabled: boolean
  label: string
  onSelectedChange: (selected: boolean) => void
  selected: boolean
}) {
  return (
    <Button
      aria-label={label}
      aria-pressed={selected}
      className="size-7"
      disabled={disabled}
      onClick={() => onSelectedChange(!selected)}
      onDoubleClick={event => event.stopPropagation()}
      size="icon-sm"
      title={label}
      type="button"
      variant={selected ? 'default' : 'ghost'}
    >
      {selected ? <CheckIcon /> : <CircleIcon />}
    </Button>
  )
}

export interface DiagnosisCatalogSelection {
  catalogItemId: string
  code: string
  display: string
  referenceConcept?: DiagnosisDraftEntry['referenceConcept']
}

function diagnosisReferenceSnapshot(concept: ReferenceConcept) {
  return {
    code: concept.code,
    display: concept.display,
    id: concept.id,
    sourceLocator: concept.sourceLocator,
    system: concept.system,
    version: concept.version,
  }
}

export function DiagnosisCatalogPicker({
  active = true, collapsible = false, disabled = false, excludedIds, localCatalog, locale, onConfirm, onSearchReset, onSelect, search, selectedId,
}: {
  active?: boolean
  collapsible?: boolean
  disabled?: boolean
  excludedIds: ReadonlySet<string>
  localCatalog: ClinicalCatalog['diagnoses']
  locale: WorkspaceLocale
  onConfirm?: (selection: DiagnosisCatalogSelection) => void
  onSearchReset?: () => void
  onSelect: (selection: DiagnosisCatalogSelection | undefined) => void
  search: ReferenceCatalogSearches['diagnoses']
  selectedId?: string | undefined
}) {
  const messages = copy[locale]
  const [expanded, setExpanded] = useState(false)
  const resultsId = useId()
  const resultsVisible = !collapsible || expanded
  const select = (selection: DiagnosisCatalogSelection | undefined) => {
    onSelect(selection)
    if (selection !== undefined) setExpanded(false)
  }
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const results = search
  const remoteResults = results.data?.items ?? []
  const useLocal = results.isError
    || (query.length === 0 && results.data !== undefined && remoteResults.length === 0)
  const localTerms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const localResults = localCatalog.flatMap(item => {
    const display = locale === 'zh-CN' ? item.nameZh : item.nameEn
    if (!localTerms.every(term => display.toLocaleLowerCase().includes(term)
      || item.code.toLocaleLowerCase().includes(term))) return []
    return [{ catalogItemId: item.id, code: item.code, display }]
  })
  const searchLatestRef = useRef(search.onSearch)
  const searchParamsRef = useRef({ query, page })
  useEffect(() => {
    searchLatestRef.current = search.onSearch
    searchParamsRef.current = { query, page }
  })
  useEffect(() => {
    if (active) searchLatestRef.current(searchParamsRef.current.query, searchParamsRef.current.page)
  }, [active])
  const confirm = (selection: DiagnosisCatalogSelection) => {
    if (!disabled && !results.isFetching && !excludedIds.has(selection.catalogItemId)) onConfirm?.(selection)
  }
  return <section aria-label={locale === 'zh-CN' ? '诊断目录' : 'Diagnosis catalog'} data-agent-catalog="diagnosis" className="flex min-h-0 min-w-0 flex-col">
        <CatalogSearchForm
          active={active}
          expansion={collapsible ? { expanded: resultsVisible, onChange: setExpanded, resultsId, locale } : undefined}
          query={query}
          input={input}
          inputLabel={messages.diagnosisSearchInput}
          label={messages.searchDiagnosis}
          onInputChange={setInput}
          onSearch={() => {
            if (collapsible) setExpanded(true)
            setPage(1)
            onSearchReset?.()
            const nextQuery = input.trim()
            setQuery(nextQuery)
            search.onSearch(nextQuery, 1)
          }}
          pending={results.isFetching}
          placeholder={messages.diagnosisPlaceholder}
        />
        <div hidden={!resultsVisible} id={resultsId} className={cn('min-h-0 flex-1 flex-col', resultsVisible ? 'flex' : 'hidden')}>
        {results.isPending ? <div aria-label={locale === 'zh-CN' ? '正在加载疾病目录' : 'Loading diagnosis catalog'} role="status" className="min-h-24 max-h-[12.5rem] px-3 py-2"><Skeleton className="h-24" /></div> : (
          // 行内目录可见高度封顶五条（12.5rem），超出内部滚动；弹窗目录在弹窗可视高度内滚动，必要时再封顶防止超长。
          <div className={onConfirm === undefined ? 'max-h-[12.5rem] overflow-y-auto border-y' : 'mx-4 min-h-0 flex-1 overflow-auto border'}>
            {results.isError ? (
              <Alert className="m-2"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{messages.catalogUnavailable}</AlertTitle>
                <Button disabled={results.isFetching} onClick={() => search.onSearch(query, page)} size="sm" type="button" variant="outline">{locale === 'zh-CN' ? '重试目录' : 'Retry catalog'}</Button>
              </Alert>
            ) : null}
            {(useLocal ? localResults : remoteResults).length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">{messages.noResults}</p>
            ) : (
              onConfirm === undefined ? <ul className="divide-y">
                {(useLocal ? localResults : remoteResults).map(item => {
                  const selection: DiagnosisCatalogSelection = 'domain' in item
                    ? { catalogItemId: item.id, code: item.code, display: item.display, referenceConcept: diagnosisReferenceSnapshot(item) }
                    : item
                  const inactive = 'status' in item && item.status !== 'active'
                  const excluded = excludedIds.has(selection.catalogItemId)
                  // 行内目录单行紧凑行：名称截断、编码收尾，完整信息保留在编码提示与选中详情里。
                  return <li className="flex min-w-0 items-center justify-between gap-2 px-3 py-2" key={selection.catalogItemId}>
                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                      <strong className="min-w-0 truncate text-sm" title={selection.display}>{selection.display}</strong>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground" title={useLocal ? undefined : ('system' in item ? item.system : undefined)}>
                        {useLocal ? `${messages.localCatalog} · ` : ''}{selection.code}
                      </span>
                    </span>
                    <Button aria-label={`${messages.choose} ${selection.display} ${selection.code}`} disabled={disabled || results.isFetching || inactive || excluded} onClick={() => select(selection)} size="sm" type="button" variant="outline">
                      {excluded ? <CheckIcon data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}{excluded ? (locale === 'zh-CN' ? '已添加' : 'Added') : inactive ? (locale === 'zh-CN' ? '停用' : 'Inactive') : messages.chooseDiagnosis}
                    </Button>
                  </li>
                })}
              </ul> : <Table>
                <TableHeader className="sticky top-0 z-10 bg-popover">
                  <TableRow>
                    <TableHead className="w-12"><span className="sr-only">{messages.choose}</span></TableHead>
                    <TableHead>{locale === 'zh-CN' ? '诊断名称' : 'Diagnosis'}</TableHead>
                    <TableHead className="w-44">{locale === 'zh-CN' ? '诊断编码' : 'Code'}</TableHead>
                    <TableHead className="w-24">{locale === 'zh-CN' ? '状态' : 'Status'}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(useLocal ? localResults : remoteResults).map(item => {
                    const selection: DiagnosisCatalogSelection = 'domain' in item
                      ? {
                          catalogItemId: item.id,
                          code: item.code,
                          display: item.display,
                          referenceConcept: diagnosisReferenceSnapshot(item),
                        }
                      : item
                    const inactive = 'status' in item && item.status !== 'active'
                    const excluded = excludedIds.has(selection.catalogItemId)
                    const unavailable = disabled || results.isFetching || inactive || excluded
                    const label = `${messages.choose} ${selection.display} ${selection.code}`
                    return (
                      <TableRow
                        className={cn(unavailable && 'opacity-50', selectedId === selection.catalogItemId && 'bg-muted/70')}
                        key={selection.catalogItemId}
                        onDoubleClick={() => { if (!unavailable) confirm(selection) }}
                      >
                        <TableCell>
                          <SelectionButton
                            disabled={unavailable}
                            label={label}
                            onSelectedChange={next => select(next ? selection : undefined)}
                            selected={selectedId === selection.catalogItemId}
                          />
                        </TableCell>
                        <TableCell className="font-medium">{selection.display}</TableCell>
                        <TableCell className="font-mono text-xs">{selection.code}</TableCell>
                        <TableCell>
                          <Badge variant={unavailable ? 'secondary' : 'outline'}>
                            {excluded
                              ? (locale === 'zh-CN' ? '已添加' : 'Added')
                              : inactive
                                ? (locale === 'zh-CN' ? '停用' : 'Inactive')
                                : useLocal
                                  ? messages.localCatalog
                                  : (locale === 'zh-CN' ? '可选' : 'Active')}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        )}
        {!useLocal && results.data !== undefined ? (
          <CatalogPagination
            locale={locale}
            onPageChange={(nextPage) => {
              setPage(nextPage)
              onSearchReset?.()
              search.onSearch(query, nextPage)
            }}
            page={page}
            pageSize={results.data.pageSize}
            total={results.data.total}
          />
        ) : null}
        </div>
  </section>
}

export function DiagnosisCatalogDialog({ disabled, excludedIds, localCatalog, locale, mode = 'add', onOpenChange, onSelect, search }: {
  disabled?: boolean
  excludedIds: ReadonlySet<string>
  localCatalog: ClinicalCatalog['diagnoses']
  locale: WorkspaceLocale
  mode?: TriggerMode
  onOpenChange?: (open: boolean) => void
  onSelect: (selection: DiagnosisCatalogSelection) => void
  search: ReferenceCatalogSearches['diagnoses']
}) {
  const messages = copy[locale]
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<DiagnosisCatalogSelection>()
  const changeOpen = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }
  const confirm = (selection = selected) => {
    if (selection === undefined || search.isFetching || excludedIds.has(selection.catalogItemId)) return
    onSelect(selection)
    changeOpen(false)
  }
  return <Dialog onOpenChange={changeOpen} open={open}>
    <CatalogTriggerButton catalog="diagnosis" {...(disabled === undefined ? {} : { disabled })} label={mode === 'replace' ? messages.replaceDiagnosis : messages.addDiagnosis} mode={mode} onClick={() => { setSelected(undefined); changeOpen(true) }} />
    <DialogContent data-agent-catalog="diagnosis" className="h-[min(680px,calc(100svh-2rem))] sm:max-w-4xl">
      <DialogHeader><DialogTitle>{messages.chooseDiagnosis}</DialogTitle><DialogDescription>{messages.diagnosisDescription}</DialogDescription></DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{open ? <DiagnosisCatalogPicker active={open} excludedIds={excludedIds} localCatalog={localCatalog} locale={locale} onConfirm={confirm} onSearchReset={() => setSelected(undefined)} onSelect={setSelected} search={search} selectedId={selected?.catalogItemId} /> : null}</div>
      <DialogFooter><DialogClose render={<Button type="button" variant="outline" />}>{messages.close}</DialogClose><Button disabled={selected === undefined || search.isFetching} onClick={() => confirm()} type="button">{messages.confirmDiagnosis}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

export interface DiagnosisComposerTarget {
  catalogItemId: string
  code: string
  display: string
  note: string
  referenceConcept?: DiagnosisDraftEntry['referenceConcept']
  role: DiagnosisDraftEntry['role']
}

/** 三页签统一弹窗合同（诊断）：目录浏览与表单填写在同一次弹窗内完成，点「确认」落单这一条，未确认关闭即弃置弹窗内输入。 */
export function DiagnosisComposerDialog({
  defaultRole, disabled = false, excludedIds, localCatalog, locale, onConfirm, onOpenChange, open, search, target,
}: {
  defaultRole: DiagnosisDraftEntry['role']
  disabled?: boolean
  excludedIds: ReadonlySet<string>
  localCatalog: ClinicalCatalog['diagnoses']
  locale: WorkspaceLocale
  onConfirm: (selection: DiagnosisCatalogSelection, role: DiagnosisDraftEntry['role'], note: string) => void
  onOpenChange: (open: boolean) => void
  open: boolean
  search: ReferenceCatalogSearches['diagnoses']
  target: DiagnosisComposerTarget | undefined
}) {
  const messages = copy[locale]
  const [selected, setSelected] = useState<DiagnosisCatalogSelection>()
  const [role, setRole] = useState<DiagnosisDraftEntry['role']>(defaultRole)
  const [note, setNote] = useState('')
  // latest-ref：打开瞬间读取当时的编辑目标，避免把易变 target 写进重置副作用的依赖。
  const targetRef = useRef(target)
  targetRef.current = target
  const openingRef = useRef(open)
  useEffect(() => {
    if (open && !openingRef.current) {
      const current = targetRef.current
      setSelected(current === undefined ? undefined : {
        catalogItemId: current.catalogItemId,
        code: current.code,
        display: current.display,
        ...(current.referenceConcept === undefined ? {} : { referenceConcept: current.referenceConcept }),
      })
      setRole(current?.role ?? defaultRole)
      setNote(current?.note ?? '')
    }
    openingRef.current = open
  }, [defaultRole, open])
  const select = (selection: DiagnosisCatalogSelection | undefined) => {
    // 换选目录项只更换编码，保留已填的角色与备注（医生填到一半发现选错病，备注仍然适用）。
    setSelected(selection)
  }
  const confirm = () => {
    if (selected === undefined || disabled) return
    onConfirm(selected, role, note.trim())
    onOpenChange(false)
  }
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex h-[min(680px,calc(100svh-2rem))] flex-col sm:max-w-4xl" data-agent-catalog="diagnosis">
        <DialogHeader>
          <DialogTitle>{target === undefined ? messages.chooseDiagnosis : messages.editDiagnosis}</DialogTitle>
          <DialogDescription>{messages.diagnosisDescription}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {open ? <DiagnosisCatalogPicker active={open} excludedIds={excludedIds} localCatalog={localCatalog} locale={locale} onSelect={select} search={search} selectedId={selected?.catalogItemId} /> : null}
          {selected === undefined ? null : (
            <section aria-label={messages.diagnosisDetails} className="flex flex-col gap-4 border-t p-4">
              {/* 当前条目头：编辑的条目可能不在目录结果里（如调整过的建议），必须能看到在编辑谁。 */}
              <div className="min-w-0">
                <h4 className="break-words font-semibold text-sm">{selected.display}</h4>
                <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{selected.code}</p>
              </div>
              <FieldGroup>
                <Field>
                  <FieldTitle>{messages.diagnosisRole}</FieldTitle>
                  <ToggleGroup aria-label={messages.diagnosisRole} className="max-w-full flex-wrap" disabled={disabled} onValueChange={value => {
                    const next = value[0]
                    if (next === 'primary' || next === 'secondary') setRole(next)
                  }} size="sm" spacing={1} value={[role]} variant="outline">
                    <ToggleGroupItem value="primary">{messages.primaryDiagnosis}</ToggleGroupItem>
                    {/* 与页面编辑器同一保护：主诊断要先让位给其他条目，才能降为次诊断。 */}
                    <ToggleGroupItem disabled={role === 'primary'} value="secondary">{messages.secondaryDiagnosis}</ToggleGroupItem>
                  </ToggleGroup>
                  <FieldDescription>{locale === 'zh-CN'
                    ? '整组诊断保留一条主诊断，其他诊断为次诊断。'
                    : 'Keep one primary diagnosis; all other diagnoses are secondary.'}</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="diagnosis-composer-note">{messages.diagnosisNote}</FieldLabel>
                  <Textarea aria-label={messages.diagnosisNote} className="min-h-28" disabled={disabled} id="diagnosis-composer-note"
                    maxLength={500} onChange={event => setNote(event.currentTarget.value)} value={note} />
                  <FieldDescription>{note.length} / 500</FieldDescription>
                </Field>
              </FieldGroup>
            </section>
          )}
        </div>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>{messages.close}</DialogClose>
          <Button disabled={selected === undefined || disabled} onClick={confirm} type="button">{target === undefined ? messages.confirmDiagnosis : messages.updateDiagnosis}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface MedicationComposerFields {
  courseDays: number | null
  doseText: string
  frequencyCode: string
  quantity: number | null
}

export interface MedicationComposerTarget {
  fields: MedicationComposerFields
  selection: MedicationCatalogSelection
}

const medicationComposerSelectionId = (selection: MedicationCatalogSelection): string =>
  selection.kind === 'reference' ? selection.product.id : selection.medication.id

/** 三页签统一弹窗合同（处方）：目录选药与用药字段在同一次弹窗内完成，点「确认」落单这一条；换选药品时值域随药品变化，字段重置为该药品默认值。 */
export function MedicationComposerDialog({
  disabled = false, excludedIds, localCatalog, locale, onConfirm, onOpenChange, open, search, target,
}: {
  disabled?: boolean
  excludedIds: ReadonlySet<string>
  localCatalog: PrescriptionMedication[]
  locale: WorkspaceLocale
  onConfirm: (selection: MedicationCatalogSelection, fields: MedicationComposerFields) => void
  onOpenChange: (open: boolean) => void
  open: boolean
  search: ReferenceCatalogSearches['medications']
  target: MedicationComposerTarget | undefined
}) {
  const messages = copy[locale]
  const [selected, setSelected] = useState<MedicationCatalogSelection>()
  const [doseText, setDoseText] = useState('')
  const [frequencyCode, setFrequencyCode] = useState('')
  const [courseDays, setCourseDays] = useState<number | null>(null)
  const [quantity, setQuantity] = useState<number | null>(null)
  // latest-ref：打开瞬间读取当时的编辑目标，避免把易变 target 写进重置副作用的依赖。
  const targetRef = useRef(target)
  targetRef.current = target
  const openingRef = useRef(open)
  useEffect(() => {
    if (open && !openingRef.current) {
      const current = targetRef.current
      setSelected(current?.selection)
      setDoseText(current?.fields.doseText ?? '')
      setFrequencyCode(current?.fields.frequencyCode ?? '')
      setCourseDays(current?.fields.courseDays ?? null)
      setQuantity(current?.fields.quantity ?? null)
    }
    openingRef.current = open
  }, [open])
  const selectedMedication = selected?.kind === 'local' ? selected.medication : undefined
  const selectedProduct = selected?.kind === 'reference' ? selected.product : undefined
  const select = (selection: MedicationCatalogSelection | undefined) => {
    if (selection === undefined) return
    setSelected(selection)
    // 换选药品时剂量/频次/疗程/数量的值域随药品变化，重置为该药品默认值；重复点选同一药品保留已填内容。
    if (selected === undefined || medicationComposerSelectionId(selected) !== medicationComposerSelectionId(selection)) {
      setDoseText(selection.kind === 'local' ? selection.medication.defaultDoseText : '')
      setFrequencyCode(selection.kind === 'local' ? selection.medication.defaultFrequencyCode : '')
      setCourseDays(selection.kind === 'local' ? selection.medication.defaultCourseDays : 3)
      setQuantity(selection.kind === 'local' ? selection.medication.defaultQuantity : 1)
    }
  }
  // 字段值域复用 prescriptionDraftItemSchema 各字段 schema，避免手抄边界与合同漂移；本院药另按目录 allowed 值域收紧。
  const invalidFields = new Set<string>()
  if (selected !== undefined) {
    if (selectedMedication === undefined
      ? !prescriptionDraftItemSchema.shape.doseText.safeParse(doseText.trim()).success
      : !selectedMedication.allowedDoseTexts.includes(doseText)) invalidFields.add('doseText')
    if (selectedMedication === undefined
      ? !prescriptionDraftItemSchema.shape.frequencyCode.safeParse(frequencyCode.trim()).success
      : !selectedMedication.allowedFrequencyCodes.includes(frequencyCode)) invalidFields.add('frequencyCode')
    const courseResult = prescriptionDraftItemSchema.shape.courseDays.safeParse(courseDays)
    if (!courseResult.success
      || (selectedMedication !== undefined && !selectedMedication.allowedCourseDays.includes(courseResult.data))) invalidFields.add('courseDays')
    const quantityResult = prescriptionDraftItemSchema.shape.quantity.safeParse(quantity)
    if (!quantityResult.success
      || (selectedMedication !== undefined && !selectedMedication.allowedQuantities.includes(quantityResult.data))) invalidFields.add('quantity')
  }
  const fieldsValid = selected !== undefined && invalidFields.size === 0
  const confirm = () => {
    if (selected === undefined || disabled || !fieldsValid) return
    onConfirm(selected, { courseDays, doseText: doseText.trim(), frequencyCode: frequencyCode.trim(), quantity })
    onOpenChange(false)
  }
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex h-[min(680px,calc(100svh-2rem))] flex-col sm:max-w-4xl" data-agent-catalog="medication">
        <DialogHeader>
          <DialogTitle>{target === undefined ? messages.chooseMedication : messages.editMedication}</DialogTitle>
          <DialogDescription>{messages.medicationComposerDescription}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {open ? <MedicationCatalogPicker active={open} disabled={disabled} excludedIds={excludedIds} localCatalog={localCatalog} locale={locale} onSelect={select} search={search} {...(selected === undefined ? {} : { selectedId: medicationComposerSelectionId(selected) })} /> : null}
          {selected === undefined ? null : (
            <section aria-label={messages.medicationDetails} className="flex flex-col gap-4 border-t p-4">
              {/* 当前条目头：编辑的条目可能不在目录结果里，必须能看到在编辑谁。 */}
              <div className="min-w-0">
                <h4 className="break-words font-semibold text-sm">{selectedProduct?.genericName
                  ?? (locale === 'zh-CN' ? selectedMedication?.nameZh : selectedMedication?.nameEn)}</h4>
                <p className="mt-1 break-words text-xs text-muted-foreground">{selectedProduct === undefined
                  ? messages.localMedication
                  : [selectedProduct.manufacturer, selectedProduct.strength, medicationPackageSummary(selectedProduct.packageDescription)].filter(Boolean).join(' · ')}</p>
              </div>
              <FieldGroup className="grid min-w-0 grid-cols-2 gap-3">
                <Field data-invalid={invalidFields.has('doseText')}>
                  <FieldLabel htmlFor="medication-composer-dose">{messages.dose}</FieldLabel>
                  {selectedMedication === undefined ? <Input aria-invalid={invalidFields.has('doseText')} id="medication-composer-dose" maxLength={120} onChange={event => setDoseText(event.currentTarget.value)} value={doseText} />
                    : <WorkspaceSelect id="medication-composer-dose" items={selectedMedication.allowedDoseTexts.map(value => ({ label: value, value }))}
                      onValueChange={value => { if (value !== null) setDoseText(value) }}
                      placeholder={messages.choose} value={doseText || null} />}
                </Field>
                <Field data-invalid={invalidFields.has('frequencyCode')}>
                  <FieldLabel htmlFor="medication-composer-frequency">{messages.frequency}</FieldLabel>
                  {selectedMedication === undefined ? <Input aria-invalid={invalidFields.has('frequencyCode')} id="medication-composer-frequency" maxLength={32} onChange={event => setFrequencyCode(event.currentTarget.value)} value={frequencyCode} />
                    : <WorkspaceSelect id="medication-composer-frequency" items={selectedMedication.allowedFrequencyCodes.map(value => ({ label: value, value }))}
                      onValueChange={value => { if (value !== null) setFrequencyCode(value) }}
                      placeholder={messages.choose} value={frequencyCode || null} />}
                </Field>
                <Field data-invalid={invalidFields.has('courseDays')}>
                  <FieldLabel htmlFor="medication-composer-course">{messages.course}</FieldLabel>
                  {selectedMedication === undefined ? <Input aria-invalid={invalidFields.has('courseDays')} id="medication-composer-course" max={30} min={1} onChange={event => setCourseDays(event.currentTarget.value === '' ? null : Number(event.currentTarget.value))} step={1} type="number" value={courseDays ?? ''} />
                    : <WorkspaceSelect id="medication-composer-course" items={selectedMedication.allowedCourseDays.map(value => ({ label: `${value} ${messages.days}`, value: String(value) }))}
                      onValueChange={value => { if (value !== null) setCourseDays(Number(value)) }}
                      placeholder={messages.choose} value={courseDays === null ? null : String(courseDays)} />}
                </Field>
                <Field data-invalid={invalidFields.has('quantity')}>
                  <FieldLabel htmlFor="medication-composer-quantity">{messages.quantity}</FieldLabel>
                  {selectedMedication === undefined ? <Input aria-invalid={invalidFields.has('quantity')} id="medication-composer-quantity" max={1_000} min={1} onChange={event => setQuantity(event.currentTarget.value === '' ? null : Number(event.currentTarget.value))} step={1} type="number" value={quantity ?? ''} />
                    : <WorkspaceSelect id="medication-composer-quantity" items={selectedMedication.allowedQuantities.map(value => ({ label: String(value), value: String(value) }))}
                      onValueChange={value => { if (value !== null) setQuantity(Number(value)) }}
                      placeholder={messages.choose} value={quantity === null ? null : String(quantity)} />}
                </Field>
              </FieldGroup>
              {invalidFields.size === 0 ? null : <FieldError>{messages.medicationFieldsError}</FieldError>}
            </section>
          )}
        </div>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>{messages.close}</DialogClose>
          <Button disabled={!fieldsValid || disabled} onClick={confirm} type="button">{target === undefined ? messages.confirmMedication : messages.updateMedication}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface LaboratoryCatalogSelection {
  catalogItemId: string
  code: string
  display: string
  laboratoryService?: LaboratoryServiceSnapshot
  referenceConcept?: ReferenceConceptSnapshot
}

export function LaboratoryCatalogPicker({ active = true, collapsible = false, locale, onConfirm, onSearchReset, onSelect, search, selectedId }: {
  active?: boolean
  collapsible?: boolean
  locale: WorkspaceLocale
  onConfirm?: (selection: LaboratoryCatalogSelection) => void
  onSearchReset?: () => void
  onSelect: (selection: LaboratoryCatalogSelection | undefined) => void
  search: ReferenceCatalogSearches['laboratory']
  selectedId?: string
}) {
  const messages = copy[locale]
  const [expanded, setExpanded] = useState(false)
  const resultsId = useId()
  const resultsVisible = !collapsible || expanded
  const select = (selection: LaboratoryCatalogSelection | undefined) => {
    onSelect(selection)
    if (selection !== undefined) setExpanded(false)
  }
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const initialSearch = useRef(search.onSearch)
  useEffect(() => { initialSearch.current('', 1) }, [])
  const results = search
  const visibleResults = results.data?.items ?? []
  return (
    <div data-agent-catalog="laboratory" className="flex min-w-0 flex-col gap-3">
        <CatalogSearchForm
          active={active}
          expansion={collapsible ? { expanded: resultsVisible, onChange: setExpanded, resultsId, locale } : undefined}
          query={query}
          input={input}
          inputLabel={messages.laboratorySearchInput}
          label={messages.searchLaboratory}
          onInputChange={setInput}
          onSearch={() => {
            if (collapsible) setExpanded(true)
            setPage(1)
            onSearchReset?.()
            const nextQuery = input.trim()
            setQuery(nextQuery)
            search.onSearch(nextQuery, 1)
          }}
          pending={results.isFetching}
          placeholder={messages.laboratoryPlaceholder}
        />
        <div hidden={!resultsVisible} id={resultsId} className={cn('min-h-0 flex-1 flex-col gap-3', resultsVisible ? 'flex' : 'hidden')}>
        {results.isPending ? <Skeleton aria-label={locale === 'zh-CN' ? '正在加载检验目录' : 'Loading laboratory catalog'} role="status" className="m-3 min-h-24" /> : results.isError ? (
          <Alert className="mx-4" variant="destructive"><CircleAlertIcon /><AlertTitle>{locale === 'zh-CN' ? '无法加载本院检验目录' : 'Unable to load the hospital laboratory catalog'}</AlertTitle><Button onClick={() => search.onSearch(query, page)} type="button" variant="outline">{locale === 'zh-CN' ? '重试' : 'Retry'}</Button></Alert>
        ) : (
          <div className={onConfirm === undefined ? 'max-h-[12.5rem] overflow-y-auto border-y' : 'mx-4 min-h-0 flex-1 overflow-auto border'}>
            {visibleResults.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                {messages.noResults}
              </p>
            ) : onConfirm === undefined ? (
              <ul className="divide-y">
                {visibleResults.map(item => {
                  const selection: LaboratoryCatalogSelection = {
                    catalogItemId: item.id,
                    code: item.referenceConcept.code,
                    display: locale === 'zh-CN' ? item.nameZh : (item.nameEn ?? item.nameZh),
                    referenceConcept: item.referenceConcept,
                    laboratoryService: item,
                  }
                  // 行内检验目录单行紧凑行：项目名截断、LOINC 收尾；标本、报告结构与 TAT 在选中后的表单区展示。
                  return (
                    <li className="flex min-w-0 items-center justify-between gap-2 px-3 py-2" key={selection.catalogItemId}>
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <strong className="min-w-0 truncate text-sm" title={selection.display}>{selection.display}</strong>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">{selection.code}</span>
                      </span>
                      <SelectionButton
                        disabled={false}
                        label={`${messages.choose} ${selection.display} ${selection.code}`}
                        onSelectedChange={next => select(next ? selection : undefined)}
                        selected={selectedId === selection.catalogItemId}
                      />
                    </li>
                  )
                })}
              </ul>
            ) : (
              <Table className="min-w-[620px]" singleScrollContainer>
                <TableHeader className="sticky top-0 z-10 bg-popover">
                  <TableRow>
                    <TableHead className="w-12"><span className="sr-only">{messages.choose}</span></TableHead>
                    <TableHead>{locale === 'zh-CN' ? '检验项目' : 'Laboratory item'}</TableHead>
                    <TableHead className="w-44">LOINC</TableHead>
                    <TableHead className="w-36">{locale === 'zh-CN' ? '报告结构' : 'Report structure'}</TableHead>
                    <TableHead className="w-32">{locale === 'zh-CN' ? '标本' : 'Specimen'}</TableHead>
                    <TableHead className="w-24">TAT</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleResults.map(item => {
                    const selection: LaboratoryCatalogSelection = {
                      catalogItemId: item.id,
                      code: item.referenceConcept.code,
                      display: locale === 'zh-CN' ? item.nameZh : (item.nameEn ?? item.nameZh),
                      referenceConcept: item.referenceConcept,
                      laboratoryService: item,
                    }
                    const label = `${messages.choose} ${selection.display} ${selection.code}`
                    const resultStructure = item.reportDefinition.results.length > 1
                      ? locale === 'zh-CN'
                        ? `组合 · ${item.reportDefinition.results.length} 项`
                        : `Panel · ${item.reportDefinition.results.length} items`
                      : item.reportDefinition.results[0]?.valueType ?? '-'
                    return (
                      <TableRow
                        className={cn(selectedId === selection.catalogItemId && 'bg-muted/70')}
                        key={selection.catalogItemId}
                        onDoubleClick={() => (onConfirm ?? select)(selection)}
                      >
                        <TableCell>
                          <SelectionButton
                            disabled={false}
                            label={label}
                            onSelectedChange={next => select(next ? selection : undefined)}
                            selected={selectedId === selection.catalogItemId}
                          />
                        </TableCell>
                        <TableCell className="font-medium">{selection.display}</TableCell>
                        <TableCell className="font-mono text-xs">{selection.code}</TableCell>
                        <TableCell>{resultStructure}</TableCell>
                        <TableCell>{item.specimen.display}</TableCell>
                        <TableCell className="tabular-nums">{item.tatMinutes} min</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        )}
        {!results.isError && results.data !== undefined ? (
          <CatalogPagination
            locale={locale}
            onPageChange={(nextPage) => {
              setPage(nextPage)
              onSearchReset?.()
              search.onSearch(query, nextPage)
            }}
            page={page}
            pageSize={results.data.pageSize}
            total={results.data.total}
          />
        ) : null}
        </div>
    </div>
  )
}

export function LaboratoryCatalogDialog({ locale, onSelect, search }: {
  locale: WorkspaceLocale
  onSelect: (selection: LaboratoryCatalogSelection) => void
  search: ReferenceCatalogSearches['laboratory']
}) {
  const messages = copy[locale]
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<LaboratoryCatalogSelection>()
  const confirm = (selection = selected) => {
    if (selection === undefined) return
    onSelect(selection)
    setOpen(false)
  }
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <CatalogTriggerButton catalog="laboratory" label={messages.selectLaboratory} mode="select"
        onClick={() => { setSelected(undefined); setOpen(true) }} />
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{messages.chooseLaboratory}</DialogTitle>
          <DialogDescription>{messages.laboratoryDescription}</DialogDescription>
        </DialogHeader>
        <LaboratoryCatalogPicker active={open} locale={locale} onConfirm={confirm} onSearchReset={() => setSelected(undefined)} onSelect={setSelected}
          search={search} {...(selected === undefined ? {} : { selectedId: selected.catalogItemId })} />
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>{messages.close}</DialogClose>
          <Button disabled={selected === undefined} onClick={() => confirm()} type="button">
            {messages.confirmLaboratory}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export type MedicationCatalogSelection =
  | { kind: 'local'; medication: PrescriptionMedication }
  | { kind: 'reference'; product: ReferenceMedicationProduct }

interface MedicationProductGroup {
  product: ReferenceMedicationProduct
  variants: ReferenceMedicationProduct[]
}

const PACKAGE_SUMMARY_MAX_CHARS = 24

/** 包装主行只保留最小可选事实（包装量等末段），工艺细节留在悬停提示与完整字段里；参考目录该字段全量为「工艺；包装量」分段，末段即包装量。 */
export function medicationPackageSummary(packageDescription: string): string {
  const segments = packageDescription.split(/[;；]/).map(segment => segment.trim()).filter(Boolean)
  const last = segments[segments.length - 1]
  if (segments.length > 1 && last !== undefined && last.length <= PACKAGE_SUMMARY_MAX_CHARS) return last
  return packageDescription.length <= PACKAGE_SUMMARY_MAX_CHARS ? packageDescription : `${packageDescription.slice(0, PACKAGE_SUMMARY_MAX_CHARS)}…`
}

function medicationProductGroupKey(product: ReferenceMedicationProduct): string {
  return JSON.stringify([
    product.genericName,
    product.strength,
    product.dosageForm,
    product.manufacturer,
    product.approvalNumber,
  ])
}

function groupMedicationProducts(products: ReferenceMedicationProduct[]): MedicationProductGroup[] {
  const groups = new Map<string, MedicationProductGroup>()
  for (const product of products) {
    const key = medicationProductGroupKey(product)
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, { product, variants: [product] })
    } else {
      group.variants.push(product)
    }
  }
  return [...groups.values()]
}

function MedicationProductRow({ group, disabled = false, excludedIds, locale, selectionId, onSelect, onConfirm }: {
  disabled?: boolean
  group: MedicationProductGroup
  excludedIds: ReadonlySet<string>
  locale: WorkspaceLocale
  selectionId?: string | undefined
  onSelect: (selection: MedicationCatalogSelection | undefined) => void
  onConfirm?: (selection: MedicationCatalogSelection) => void
}) {
  const [packageId, setPackageId] = useState<string>()
  const available = (item: ReferenceMedicationProduct) => item.status === 'active' && !excludedIds.has(item.id)
  const item = group.variants.find(variant => variant.id === packageId && available(variant))
    ?? group.variants.find(available)
    ?? group.product
  const unavailable = disabled || !available(item)
  const selection: MedicationCatalogSelection = { kind: 'reference', product: item }
  const selected = group.variants.some(variant => variant.id === selectionId)
  const messages = copy[locale]
  const packageSelector = (
        <Select disabled={unavailable} value={item.id} onValueChange={value => {
          const next = group.variants.find(variant => variant.id === value && available(variant))
          if (next === undefined) return
          setPackageId(next.id)
          if (selected) onSelect({ kind: 'reference', product: next })
        }}>
          <SelectTrigger data-agent-medication-package="" className="w-full min-w-0" aria-label={`${locale === 'zh-CN' ? '包装' : 'Package'} ${item.genericName} ${item.manufacturer}`} title={item.packageDescription}>
            <SelectValue className="min-w-0"><span className="truncate" title={item.packageDescription}>{medicationPackageSummary(item.packageDescription)}</span></SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {group.variants.map(variant => (
                <SelectItem disabled={!available(variant)} key={variant.id} value={variant.id}>
                  <span className="max-w-72 truncate" title={variant.packageDescription}>{variant.packageDescription}</span>
                  {excludedIds.has(variant.id) ? (locale === 'zh-CN' ? ' · 已添加' : ' · Added')
                    : variant.status !== 'active' ? (locale === 'zh-CN' ? ' · 停用' : ' · Inactive') : ''}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
  )
  if (onConfirm === undefined) return (
    // 行内药品单行紧凑行：通用名截断、规格收尾；完整注册信息（厂家、剂型、商品名、批准文号）经悬停提示呈现。
    <li className="flex min-w-0 items-center gap-2 px-3 py-2" title={[item.manufacturer, item.dosageForm, item.brandName, item.approvalNumber].filter(Boolean).join(' · ') || undefined}>
      <strong data-agent-medication-name="" className="min-w-0 truncate text-sm" title={item.genericName}>{item.genericName}</strong>
      <span className="max-w-24 min-w-0 truncate text-xs text-muted-foreground" title={item.strength}>{item.strength}</span>
      <div className="min-w-0 flex-1">{packageSelector}</div>
      <Button aria-label={`${messages.choose} ${item.genericName} ${item.strength} ${item.packageDescription} ${item.manufacturer} ${item.approvalNumber}`} className="shrink-0" disabled={unavailable} onClick={() => onSelect(selection)} size="sm" type="button" variant="outline">
        {excludedIds.has(item.id) ? <CheckIcon data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}{excludedIds.has(item.id) ? (locale === 'zh-CN' ? '已添加' : 'Added') : item.status !== 'active' ? (locale === 'zh-CN' ? '停用' : 'Inactive') : (locale === 'zh-CN' ? '选择包装' : 'Select package')}
      </Button>
    </li>
  )
  return (
    <TableRow className={cn(unavailable && 'opacity-50', selected && 'bg-muted/70')}
      onDoubleClick={() => { if (!unavailable) onConfirm(selection) }}>
      <TableCell>
        <SelectionButton disabled={unavailable}
          label={`${messages.choose} ${item.genericName} ${item.strength} ${item.packageDescription} ${item.manufacturer} ${item.approvalNumber}`}
          onSelectedChange={next => onSelect(next ? selection : undefined)} selected={selected} />
      </TableCell>
      <TableCell data-agent-medication-name="" className="font-medium">
        <span className="line-clamp-2 whitespace-normal break-words" title={`${item.genericName} · ${item.dosageForm} · ${item.approvalNumber}`}>{item.genericName}</span>
      </TableCell>
      <TableCell><span className="line-clamp-2 whitespace-normal break-words" title={item.manufacturer}>{item.manufacturer}</span></TableCell>
      <TableCell><span className="block truncate" title={item.brandName ?? undefined}>{item.brandName ?? '-'}</span></TableCell>
      <TableCell><span className="block truncate" title={item.strength}>{item.strength}</span></TableCell>
      <TableCell onDoubleClick={event => event.stopPropagation()}>
        {packageSelector}
      </TableCell>
    </TableRow>
  )
}

export function MedicationCatalogPicker({
  active = true, collapsible = false, disabled = false, excludedIds, localCatalog, locale, onConfirm, onSearchReset, onSelect, search, selectedId: selectionId,
}: {
  active?: boolean
  collapsible?: boolean
  disabled?: boolean
  excludedIds: ReadonlySet<string>
  localCatalog: PrescriptionMedication[]
  locale: WorkspaceLocale
  onConfirm?: (selection: MedicationCatalogSelection) => void
  onSearchReset?: () => void
  onSelect: (selection: MedicationCatalogSelection | undefined) => void
  search: ReferenceCatalogSearches['medications']
  selectedId?: string | undefined
}) {
  const messages = copy[locale]
  const [expanded, setExpanded] = useState(false)
  const resultsId = useId()
  const resultsVisible = !collapsible || expanded
  const select = (selection: MedicationCatalogSelection | undefined) => {
    onSelect(selection)
    if (selection !== undefined) setExpanded(false)
  }
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const results = search
  const remoteResults = results.data?.items ?? []
  const useLocal = results.isError
    || (query.length === 0 && results.data !== undefined && remoteResults.length === 0)
  const localTerms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const localResults = localCatalog.filter(item => {
    const display = locale === 'zh-CN' ? item.nameZh : item.nameEn
    return localTerms.every(term => display.toLocaleLowerCase().includes(term))
  })
  const referenceGroups = useMemo(
    () => results.data === undefined ? [] : groupMedicationProducts(results.data.items),
    [results.data],
  )
  const searchLatestRef = useRef(search.onSearch)
  const searchParamsRef = useRef({ query, page })
  useEffect(() => {
    searchLatestRef.current = search.onSearch
    searchParamsRef.current = { query, page }
  })
  useEffect(() => {
    if (active) searchLatestRef.current(searchParamsRef.current.query, searchParamsRef.current.page)
  }, [active])
  const confirm = (selection: MedicationCatalogSelection) => {
    const id = selection.kind === 'reference' ? selection.product.id : selection.medication.id
    if (!disabled && !results.isFetching && !excludedIds.has(id)) onConfirm?.(selection)
  }
  return <section aria-label={locale === 'zh-CN' ? '药品目录' : 'Medication catalog'} data-agent-catalog="medication" className="flex min-h-0 min-w-0 flex-col">
        <CatalogSearchForm
          active={active}
          expansion={collapsible ? { expanded: resultsVisible, onChange: setExpanded, resultsId, locale } : undefined}
          query={query}
          input={input}
          inputLabel={messages.medicationSearchInput}
          label={messages.searchMedication}
          onInputChange={setInput}
          onSearch={() => {
            if (collapsible) setExpanded(true)
            setPage(1)
            onSearchReset?.()
            const nextQuery = input.trim()
            setQuery(nextQuery)
            search.onSearch(nextQuery, 1)
          }}
          pending={results.isFetching}
          placeholder={messages.medicationPlaceholder}
        />
        <div hidden={!resultsVisible} id={resultsId} className={cn('min-h-0 flex-1 flex-col', resultsVisible ? 'flex' : 'hidden')}>
        {results.isPending ? <div aria-label={locale === 'zh-CN' ? '正在加载药品目录' : 'Loading medication catalog'} role="status" className="min-h-24 max-h-[12.5rem] px-3 py-2"><Skeleton className="h-24" /></div> : (
          // 行内目录可见高度封顶五条（12.5rem），超出内部滚动；弹窗目录在弹窗可视高度内滚动，必要时再封顶防止超长。
          <div className={onConfirm === undefined ? 'max-h-[12.5rem] overflow-y-auto border-y' : 'mx-4 min-h-0 max-h-[28rem] flex-1 overflow-auto border'}>
            {results.isError ? (
              <Alert className="m-2"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{messages.catalogUnavailable}</AlertTitle>
                <Button disabled={results.isFetching} onClick={() => search.onSearch(query, page)} size="sm" type="button" variant="outline">{locale === 'zh-CN' ? '重试目录' : 'Retry catalog'}</Button>
              </Alert>
            ) : null}
            {(useLocal ? localResults : remoteResults).length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">{messages.noResults}</p>
            ) : (
              onConfirm === undefined ? <ul className="divide-y">
                {useLocal ? localResults.map(item => <li className="flex min-w-0 items-center justify-between gap-2 px-3 py-2" key={item.id}>
                  <span className="flex min-w-0 flex-1 items-baseline gap-2">
                    <strong data-agent-medication-name="" className="min-w-0 truncate text-sm">{locale === 'zh-CN' ? item.nameZh : item.nameEn}</strong>
                    <span className="shrink-0 text-xs text-muted-foreground">{messages.localCatalog}</span>
                  </span>
                  <Button aria-label={`${messages.choose} ${locale === 'zh-CN' ? item.nameZh : item.nameEn}`} className="shrink-0" disabled={disabled || results.isFetching || excludedIds.has(item.id)} onClick={() => select({ kind: 'local', medication: item })} size="sm" type="button" variant="outline">{excludedIds.has(item.id) ? (locale === 'zh-CN' ? '已添加' : 'Added') : messages.chooseMedication}</Button>
                </li>) : referenceGroups.map(group => <MedicationProductRow key={medicationProductGroupKey(group.product)} group={group} disabled={disabled || results.isFetching} excludedIds={excludedIds} locale={locale} onSelect={select} />)}
              </ul> : <Table className="min-w-[1000px] table-fixed" singleScrollContainer>
                <TableHeader className="sticky top-0 z-10 bg-popover">
                  <TableRow>
                    <TableHead className="w-12"><span className="sr-only">{messages.choose}</span></TableHead>
                    <TableHead className="w-60">{locale === 'zh-CN' ? '药品名称' : 'Medication name'}</TableHead>
                    <TableHead className="w-48">{locale === 'zh-CN' ? '生产企业' : 'Manufacturer'}</TableHead>
                    <TableHead className="w-32">{locale === 'zh-CN' ? '商品名' : 'Brand name'}</TableHead>
                    <TableHead className="w-44">{locale === 'zh-CN' ? '规格' : 'Strength'}</TableHead>
                    <TableHead className="w-56">{locale === 'zh-CN' ? '包装选择' : 'Package'}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {useLocal ? localResults.map(item => {
                    const selection: MedicationCatalogSelection = { kind: 'local', medication: item }
                    const id = item.id
                    const excluded = excludedIds.has(id)
                    const genericName = locale === 'zh-CN' ? item.nameZh : item.nameEn
                    return (
                      <TableRow
                        className={cn(excluded && 'opacity-50', selectionId === id && 'bg-muted/70')}
                        key={id}
                        onDoubleClick={() => { if (!disabled && !results.isFetching && !excluded) confirm(selection) }}
                      >
                        <TableCell>
                          <SelectionButton
                            disabled={disabled || results.isFetching || excluded}
                            label={`${messages.choose} ${genericName}`}
                            onSelectedChange={next => select(next ? selection : undefined)}
                            selected={selectionId === id}
                          />
                        </TableCell>
                        <TableCell data-agent-medication-name="" className="font-medium"><span className="line-clamp-2 whitespace-normal break-words" title={genericName}>{genericName}</span></TableCell>
                        <TableCell>-</TableCell>
                        <TableCell>-</TableCell>
                        <TableCell>-</TableCell>
                        <TableCell>{excluded ? <Badge variant="secondary">{locale === 'zh-CN' ? '已添加' : 'Added'}</Badge> : '-'}</TableCell>
                      </TableRow>
                    )
                  }) : referenceGroups.map(group => (
                    <MedicationProductRow key={medicationProductGroupKey(group.product)}
                      group={group} disabled={disabled || results.isFetching} excludedIds={excludedIds} locale={locale}
                      selectionId={selectionId} onSelect={select} onConfirm={confirm} />
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}
        {!useLocal && results.data !== undefined ? (
          <CatalogPagination
            locale={locale}
            onPageChange={(nextPage) => {
              setPage(nextPage)
              onSearchReset?.()
              search.onSearch(query, nextPage)
            }}
            page={page}
            pageSize={results.data.pageSize}
            total={results.data.total}
          />
        ) : null}
        </div>
  </section>
}

export function MedicationCatalogDialog({ disabled, excludedIds, localCatalog, locale, mode = 'add', onOpenChange, onSelect, search }: {
  disabled?: boolean
  excludedIds: ReadonlySet<string>
  localCatalog: PrescriptionMedication[]
  locale: WorkspaceLocale
  mode?: TriggerMode
  onOpenChange?: (open: boolean) => void
  onSelect: (selection: MedicationCatalogSelection) => void
  search: ReferenceCatalogSearches['medications']
}) {
  const messages = copy[locale]
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<MedicationCatalogSelection>()
  const changeOpen = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }
  const selectionId = selected === undefined ? undefined : selected.kind === 'reference' ? selected.product.id : selected.medication.id
  const confirm = (selection = selected) => {
    if (selection === undefined || search.isFetching) return
    const id = selection.kind === 'reference' ? selection.product.id : selection.medication.id
    if (excludedIds.has(id)) return
    onSelect(selection)
    changeOpen(false)
  }
  return <Dialog onOpenChange={changeOpen} open={open}>
    <CatalogTriggerButton catalog="medication" {...(disabled === undefined ? {} : { disabled })} label={mode === 'replace' ? messages.replaceMedication : messages.addMedication} mode={mode} onClick={() => { setSelected(undefined); changeOpen(true) }} />
    <DialogContent data-agent-catalog="medication" className="h-[min(720px,calc(100svh-2rem))] sm:max-w-6xl">
      <DialogHeader><DialogTitle>{messages.chooseMedication}</DialogTitle><DialogDescription>{messages.medicationDescription}</DialogDescription></DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{open ? <MedicationCatalogPicker active={open} excludedIds={excludedIds} localCatalog={localCatalog} locale={locale} onConfirm={confirm} onSearchReset={() => setSelected(undefined)} onSelect={setSelected} search={search} selectedId={selectionId} /> : null}</div>
      <DialogFooter><DialogClose render={<Button type="button" variant="outline" />}>{messages.close}</DialogClose><Button disabled={selected === undefined || search.isFetching} onClick={() => confirm()} type="button">{messages.confirmMedication}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
