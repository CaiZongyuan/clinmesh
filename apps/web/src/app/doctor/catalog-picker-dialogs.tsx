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
import { Input } from '@clinmesh/ui/components/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@clinmesh/ui/components/select'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { cn } from '@clinmesh/ui/lib/utils'
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleIcon,
  CircleAlertIcon,
  ListPlusIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
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
    confirmDiagnosis: 'Add diagnosis',
    confirmLaboratory: 'Select',
    confirmMedication: 'Add to prescription',
    diagnosisDescription: 'Current diagnosis catalog',
    diagnosisPlaceholder: 'Name or code (2+ characters)',
    diagnosisSearchInput: 'Search diagnosis catalog',
    laboratoryDescription: 'Current laboratory catalog',
    laboratoryPlaceholder: 'Name or LOINC (2+ characters)',
    laboratorySearchInput: 'Search laboratory catalog',
    localCatalog: 'Local common',
    medicationDescription: 'Current medication product catalog',
    medicationPlaceholder: 'Generic name, brand, manufacturer, or code',
    medicationSearchInput: 'Search medication catalog',
    next: 'Next page',
    noResults: 'No matching records',
    previous: 'Previous page',
    replaceDiagnosis: 'Replace diagnosis',
    replaceMedication: 'Replace medication',
    searchDiagnosis: 'Search diagnosis catalog',
    searchLaboratory: 'Search laboratory catalog',
    searchMedication: 'Search medication catalog',
    selectLaboratory: 'Select laboratory item',
    total: '{total} records',
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
    confirmDiagnosis: '加入诊断',
    confirmLaboratory: '确定选择',
    confirmMedication: '加入处方',
    diagnosisDescription: '当前疾病诊断目录',
    diagnosisPlaceholder: '病名或编码（至少 2 字）',
    diagnosisSearchInput: '搜索疾病目录',
    laboratoryDescription: '当前检验目录',
    laboratoryPlaceholder: '检验名称或 LOINC（至少 2 字）',
    laboratorySearchInput: '搜索检验目录',
    localCatalog: '本院常用',
    medicationDescription: '当前药品产品目录',
    medicationPlaceholder: '通用名、商品名、厂家或编码',
    medicationSearchInput: '搜索药品目录',
    next: '下一页',
    noResults: '没有匹配记录',
    previous: '上一页',
    replaceDiagnosis: '更换诊断',
    replaceMedication: '更换药品',
    searchDiagnosis: '执行疾病目录搜索',
    searchLaboratory: '执行检验目录搜索',
    searchMedication: '执行药品目录搜索',
    selectLaboratory: '选择检验项目',
    total: '共 {total} 条',
  },
} as const

function totalLabel(template: string, total: number): string {
  return template.replace('{total}', String(total))
}

function CatalogSearchForm({
  active,
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
  const invalidLength = input.trim().length === 1
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!invalidLength) onSearch()
  }
  return (
    <form className="flex shrink-0 items-center gap-2 px-4 py-3" onSubmit={submit}>
      <Input
        aria-label={inputLabel}
        aria-invalid={invalidLength}
        className="min-w-0 flex-1"
        onChange={event => onInputChange(event.currentTarget.value)}
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
  active = true, disabled = false, excludedIds, localCatalog, locale, onConfirm, onSearchReset, onSelect, search, selectedId,
}: {
  active?: boolean
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
          query={query}
          input={input}
          inputLabel={messages.diagnosisSearchInput}
          label={messages.searchDiagnosis}
          onInputChange={setInput}
          onSearch={() => {
            setPage(1)
            onSearchReset?.()
            const nextQuery = input.trim()
            setQuery(nextQuery)
            search.onSearch(nextQuery, 1)
          }}
          pending={results.isFetching}
          placeholder={messages.diagnosisPlaceholder}
        />
        {results.isPending ? <div aria-label={locale === 'zh-CN' ? '正在加载疾病目录' : 'Loading diagnosis catalog'} role="status" className="mx-4 min-h-0 flex-1"><Skeleton className="h-full min-h-24" /></div> : (
          <div className="mx-4 min-h-0 flex-1 overflow-auto border">
            {results.isError ? (
              <Alert className="m-2"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{messages.catalogUnavailable}</AlertTitle>
                <Button disabled={results.isFetching} onClick={() => search.onSearch(query, page)} size="sm" type="button" variant="outline">{locale === 'zh-CN' ? '重试目录' : 'Retry catalog'}</Button>
              </Alert>
            ) : null}
            {(useLocal ? localResults : remoteResults).length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">{messages.noResults}</p>
            ) : (
              onConfirm === undefined ? <ul className="flex flex-col gap-2 p-2">
                {(useLocal ? localResults : remoteResults).map(item => {
                  const selection: DiagnosisCatalogSelection = 'domain' in item
                    ? { catalogItemId: item.id, code: item.code, display: item.display, referenceConcept: diagnosisReferenceSnapshot(item) }
                    : item
                  const inactive = 'status' in item && item.status !== 'active'
                  const excluded = excludedIds.has(selection.catalogItemId)
                  return <li className="flex min-w-0 flex-col gap-2 rounded-lg border p-3" key={selection.catalogItemId}>
                    <div className="flex flex-wrap items-start justify-between gap-2"><strong className="break-words text-sm">{selection.display}</strong><Badge variant="outline">{selection.code}</Badge></div>
                    <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{useLocal ? messages.localCatalog : ('system' in item ? item.system : '')}</span>
                      <Button aria-label={`${messages.choose} ${selection.display} ${selection.code}`} disabled={disabled || results.isFetching || inactive || excluded} onClick={() => onSelect(selection)} size="sm" type="button" variant="outline">
                        {excluded ? <CheckIcon data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}{excluded ? (locale === 'zh-CN' ? '已添加' : 'Added') : inactive ? (locale === 'zh-CN' ? '停用' : 'Inactive') : messages.chooseDiagnosis}
                      </Button>
                    </div>
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
                            onSelectedChange={next => onSelect(next ? selection : undefined)}
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

export interface LaboratoryCatalogSelection {
  catalogItemId: string
  code: string
  display: string
  laboratoryService?: LaboratoryServiceSnapshot
  referenceConcept?: ReferenceConceptSnapshot
}

export function LaboratoryCatalogPicker({ active = true, locale, onConfirm, onSearchReset, onSelect, search, selectedId }: {
  active?: boolean
  locale: WorkspaceLocale
  onConfirm?: (selection: LaboratoryCatalogSelection) => void
  onSearchReset?: () => void
  onSelect: (selection: LaboratoryCatalogSelection | undefined) => void
  search: ReferenceCatalogSearches['laboratory']
  selectedId?: string
}) {
  const messages = copy[locale]
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
          query={query}
          input={input}
          inputLabel={messages.laboratorySearchInput}
          label={messages.searchLaboratory}
          onInputChange={setInput}
          onSearch={() => {
            setPage(1)
            onSearchReset?.()
            const nextQuery = input.trim()
            setQuery(nextQuery)
            search.onSearch(nextQuery, 1)
          }}
          pending={results.isFetching}
          placeholder={messages.laboratoryPlaceholder}
        />
        {results.isPending ? <Skeleton aria-label={locale === 'zh-CN' ? '正在加载检验目录' : 'Loading laboratory catalog'} role="status" className="mx-4 min-h-48 flex-1" /> : results.isError ? (
          <Alert className="mx-4" variant="destructive"><CircleAlertIcon /><AlertTitle>{locale === 'zh-CN' ? '无法加载本院检验目录' : 'Unable to load the hospital laboratory catalog'}</AlertTitle><Button onClick={() => search.onSearch(query, page)} type="button" variant="outline">{locale === 'zh-CN' ? '重试' : 'Retry'}</Button></Alert>
        ) : (
          <div className="mx-4 min-h-0 flex-1 overflow-auto border">
            {visibleResults.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                {messages.noResults}
              </p>
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
                        onDoubleClick={() => (onConfirm ?? onSelect)(selection)}
                      >
                        <TableCell>
                          <SelectionButton
                            disabled={false}
                            label={label}
                            onSelectedChange={next => onSelect(next ? selection : undefined)}
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
          <SelectTrigger data-agent-medication-package="" className="w-full min-w-0" aria-label={`${locale === 'zh-CN' ? '包装' : 'Package'} ${item.genericName} ${item.manufacturer}`}>
            <SelectValue className="min-w-0"><span className="truncate" title={item.packageDescription}>{item.packageDescription}</span></SelectValue>
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
  if (onConfirm === undefined) return <li className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
    <div className="flex flex-wrap items-start justify-between gap-2"><strong data-agent-medication-name="" className="break-words text-sm">{item.genericName}</strong><Badge variant="outline">{item.strength}</Badge></div>
    <p className="break-words text-xs text-muted-foreground">{[item.manufacturer, item.dosageForm, item.brandName, item.approvalNumber].filter(Boolean).join(' · ')}</p>
    {packageSelector}
    <Button aria-label={`${messages.choose} ${item.genericName} ${item.strength} ${item.packageDescription} ${item.manufacturer} ${item.approvalNumber}`} disabled={unavailable} onClick={() => onSelect(selection)} size="sm" type="button" variant="outline">
      {excludedIds.has(item.id) ? <CheckIcon data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}{excludedIds.has(item.id) ? (locale === 'zh-CN' ? '已添加' : 'Added') : item.status !== 'active' ? (locale === 'zh-CN' ? '停用' : 'Inactive') : (locale === 'zh-CN' ? '选择包装' : 'Select package')}
    </Button>
  </li>
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
  active = true, disabled = false, excludedIds, localCatalog, locale, onConfirm, onSearchReset, onSelect, search, selectedId: selectionId,
}: {
  active?: boolean
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
          query={query}
          input={input}
          inputLabel={messages.medicationSearchInput}
          label={messages.searchMedication}
          onInputChange={setInput}
          onSearch={() => {
            setPage(1)
            onSearchReset?.()
            const nextQuery = input.trim()
            setQuery(nextQuery)
            search.onSearch(nextQuery, 1)
          }}
          pending={results.isFetching}
          placeholder={messages.medicationPlaceholder}
        />
        {results.isPending ? <div aria-label={locale === 'zh-CN' ? '正在加载药品目录' : 'Loading medication catalog'} role="status" className="mx-4 min-h-0 flex-1"><Skeleton className="h-full min-h-24" /></div> : (
          <div className="mx-4 min-h-0 flex-1 overflow-auto border">
            {results.isError ? (
              <Alert className="m-2"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{messages.catalogUnavailable}</AlertTitle>
                <Button disabled={results.isFetching} onClick={() => search.onSearch(query, page)} size="sm" type="button" variant="outline">{locale === 'zh-CN' ? '重试目录' : 'Retry catalog'}</Button>
              </Alert>
            ) : null}
            {(useLocal ? localResults : remoteResults).length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">{messages.noResults}</p>
            ) : (
              onConfirm === undefined ? <ul className="flex flex-col gap-2 p-2">
                {useLocal ? localResults.map(item => <li className="flex min-w-0 flex-col gap-2 rounded-lg border p-3" key={item.id}>
                  <strong data-agent-medication-name="" className="break-words text-sm">{locale === 'zh-CN' ? item.nameZh : item.nameEn}</strong><span className="text-xs text-muted-foreground">{messages.localCatalog}</span>
                  <Button aria-label={`${messages.choose} ${locale === 'zh-CN' ? item.nameZh : item.nameEn}`} disabled={disabled || results.isFetching || excludedIds.has(item.id)} onClick={() => onSelect({ kind: 'local', medication: item })} size="sm" type="button" variant="outline">{excludedIds.has(item.id) ? (locale === 'zh-CN' ? '已添加' : 'Added') : messages.chooseMedication}</Button>
                </li>) : referenceGroups.map(group => <MedicationProductRow key={medicationProductGroupKey(group.product)} group={group} disabled={disabled || results.isFetching} excludedIds={excludedIds} locale={locale} onSelect={onSelect} />)}
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
                            onSelectedChange={next => onSelect(next ? selection : undefined)}
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
                      selectionId={selectionId} onSelect={onSelect} onConfirm={confirm} />
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
