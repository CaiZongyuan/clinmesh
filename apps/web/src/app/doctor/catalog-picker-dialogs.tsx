import type { ClinicalCatalog, DiagnosisDraftEntry } from '@clinmesh/contracts/his'
import type {
  ReferenceConcept,
  ReferenceDiagnosisCatalogSearch,
  ReferenceLaboratoryCatalogSearch,
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
import { useMemo, useState, type FormEvent } from 'react'
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
  laboratory: ReferenceCatalogSearchModel<ReferenceLaboratoryCatalogSearch>
  medications: ReferenceCatalogSearchModel<ReferenceMedicationCatalogSearch>
}

const copy = {
  'en-US': {
    addDiagnosis: 'Add diagnosis',
    addMedication: 'Add medication',
    catalogUnavailable: 'The global catalog is unavailable. Local common items are shown.',
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
    packageVariants: '{count} package variants',
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
    catalogUnavailable: '全局目录暂不可用，当前显示本院常用项。',
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
    packageVariants: '{count} 个包装',
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

function countLabel(template: string, count: number): string {
  return template.replace('{count}', String(count))
}

function CatalogSearchForm({
  input,
  inputLabel,
  label,
  onInputChange,
  onSearch,
  pending,
  placeholder,
}: {
  input: string
  inputLabel: string
  label: string
  onInputChange: (value: string) => void
  onSearch: () => void
  pending: boolean
  placeholder: string
}) {
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
  disabled,
  label,
  mode,
  onClick,
}: {
  disabled?: boolean
  label: string
  mode: TriggerMode
  onClick: () => void
}) {
  if (mode === 'replace') {
    return (
      <Button
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
    <Button disabled={disabled} onClick={onClick} size="sm" type="button" variant="outline">
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
  onSelect,
  selected,
}: {
  disabled: boolean
  label: string
  onSelect: () => void
  selected: boolean
}) {
  return (
    <Button
      aria-label={label}
      className="size-7"
      disabled={disabled}
      onClick={onSelect}
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

export function DiagnosisCatalogDialog({
  disabled,
  excludedIds,
  localCatalog,
  locale,
  mode = 'add',
  onSelect,
  search,
}: {
  disabled?: boolean
  excludedIds: ReadonlySet<string>
  localCatalog: ClinicalCatalog['diagnoses']
  locale: WorkspaceLocale
  mode?: TriggerMode
  onSelect: (selection: DiagnosisCatalogSelection) => void
  search: ReferenceCatalogSearches['diagnoses']
}) {
  const messages = copy[locale]
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<DiagnosisCatalogSelection>()
  const results = search
  const remoteResults = results.data?.items ?? []
  const useLocal = results.isError
    || (query.length === 0 && results.data !== undefined && remoteResults.length === 0)
  const normalizedLocalQuery = query.toLocaleLowerCase()
  const localResults = localCatalog.flatMap(item => {
    const display = locale === 'zh-CN' ? item.nameZh : item.nameEn
    if (
      normalizedLocalQuery.length > 0
      && !display.toLocaleLowerCase().includes(normalizedLocalQuery)
      && !item.code.toLocaleLowerCase().includes(normalizedLocalQuery)
    ) return []
    return [{ catalogItemId: item.id, code: item.code, display }]
  })
  const openDialog = () => {
    setInput('')
    setQuery('')
    setPage(1)
    setSelected(undefined)
    search.onSearch('', 1)
    setOpen(true)
  }
  const confirm = (selection = selected) => {
    if (selection === undefined || excludedIds.has(selection.catalogItemId)) return
    onSelect(selection)
    setOpen(false)
  }
  const triggerLabel = mode === 'replace' ? messages.replaceDiagnosis : messages.addDiagnosis
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <CatalogTriggerButton
        {...(disabled === undefined ? {} : { disabled })}
        label={triggerLabel}
        mode={mode}
        onClick={openDialog}
      />
      <DialogContent className="h-[min(680px,calc(100svh-2rem))] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{messages.chooseDiagnosis}</DialogTitle>
          <DialogDescription>{messages.diagnosisDescription}</DialogDescription>
        </DialogHeader>
        <CatalogSearchForm
          input={input}
          inputLabel={messages.diagnosisSearchInput}
          label={messages.searchDiagnosis}
          onInputChange={setInput}
          onSearch={() => {
            setPage(1)
            setSelected(undefined)
            const nextQuery = input.trim()
            setQuery(nextQuery)
            search.onSearch(nextQuery, 1)
          }}
          pending={results.isFetching}
          placeholder={messages.diagnosisPlaceholder}
        />
        {results.isPending ? <Skeleton className="mx-4 min-h-0 flex-1" /> : (
          <div className="mx-4 min-h-0 flex-1 overflow-auto border">
            {results.isError && localResults.length > 0 ? (
              <Alert className="m-2"><CircleAlertIcon /><AlertTitle>{messages.catalogUnavailable}</AlertTitle></Alert>
            ) : null}
            {(useLocal ? localResults : remoteResults).length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">{messages.noResults}</p>
            ) : (
              <Table>
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
                    const unavailable = inactive || excluded
                    const label = `${messages.choose} ${selection.display} ${selection.code}`
                    return (
                      <TableRow
                        className={cn(unavailable && 'opacity-50', selected?.catalogItemId === selection.catalogItemId && 'bg-muted/70')}
                        key={selection.catalogItemId}
                        onDoubleClick={() => { if (!unavailable) confirm(selection) }}
                      >
                        <TableCell>
                          <SelectionButton
                            disabled={unavailable}
                            label={label}
                            onSelect={() => setSelected(selection)}
                            selected={selected?.catalogItemId === selection.catalogItemId}
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
              setSelected(undefined)
              search.onSearch(query, nextPage)
            }}
            page={page}
            pageSize={results.data.pageSize}
            total={results.data.total}
          />
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>{messages.close}</DialogClose>
          <Button disabled={selected === undefined} onClick={() => confirm()} type="button">
            {messages.confirmDiagnosis}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface LaboratoryCatalogSelection {
  catalogItemId: string
  code: string
  display: string
  referenceConcept?: ReferenceConcept
}

export function LaboratoryCatalogDialog({
  localCatalog,
  locale,
  onSelect,
  search,
}: {
  localCatalog: ClinicalCatalog['laboratory']
  locale: WorkspaceLocale
  onSelect: (selection: LaboratoryCatalogSelection) => void
  search: ReferenceCatalogSearches['laboratory']
}) {
  const messages = copy[locale]
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<LaboratoryCatalogSelection>()
  const results = search
  const remoteResults = results.data?.items ?? []
  const useLocal = results.isError
    || (query.length === 0 && results.data !== undefined && remoteResults.length === 0)
  const normalizedLocalQuery = query.toLocaleLowerCase()
  const localResults = localCatalog.flatMap(item => {
    const display = locale === 'zh-CN' ? item.nameZh : item.nameEn
    if (normalizedLocalQuery.length > 0 && !display.toLocaleLowerCase().includes(normalizedLocalQuery)) return []
    return [{ catalogItemId: item.id, code: item.id, display }]
  })
  const openDialog = () => {
    setInput('')
    setQuery('')
    setPage(1)
    setSelected(undefined)
    search.onSearch('', 1)
    setOpen(true)
  }
  const confirm = (selection = selected) => {
    if (selection === undefined) return
    onSelect(selection)
    setOpen(false)
  }
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <CatalogTriggerButton label={messages.selectLaboratory} mode="select" onClick={openDialog} />
      <DialogContent className="h-[min(640px,calc(100svh-2rem))] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{messages.chooseLaboratory}</DialogTitle>
          <DialogDescription>{messages.laboratoryDescription}</DialogDescription>
        </DialogHeader>
        <CatalogSearchForm
          input={input}
          inputLabel={messages.laboratorySearchInput}
          label={messages.searchLaboratory}
          onInputChange={setInput}
          onSearch={() => {
            setPage(1)
            setSelected(undefined)
            const nextQuery = input.trim()
            setQuery(nextQuery)
            search.onSearch(nextQuery, 1)
          }}
          pending={results.isFetching}
          placeholder={messages.laboratoryPlaceholder}
        />
        {results.isPending ? <Skeleton className="mx-4 min-h-0 flex-1" /> : (
          <div className="mx-4 min-h-0 flex-1 overflow-auto border">
            {results.isError && localResults.length > 0 ? (
              <Alert className="m-2"><CircleAlertIcon /><AlertTitle>{messages.catalogUnavailable}</AlertTitle></Alert>
            ) : null}
            {(useLocal ? localResults : remoteResults).length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">{messages.noResults}</p>
            ) : (
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-popover">
                  <TableRow>
                    <TableHead className="w-12"><span className="sr-only">{messages.choose}</span></TableHead>
                    <TableHead>{locale === 'zh-CN' ? '检验项目' : 'Laboratory item'}</TableHead>
                    <TableHead className="w-44">LOINC</TableHead>
                    <TableHead className="w-36">{locale === 'zh-CN' ? '结果类型' : 'Result type'}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(useLocal ? localResults : remoteResults).map(item => {
                    const selection: LaboratoryCatalogSelection = 'domain' in item
                      ? {
                          catalogItemId: item.id,
                          code: item.code,
                          display: item.display,
                          referenceConcept: item,
                        }
                      : item
                    const inactive = 'status' in item && item.status !== 'active'
                    const label = `${messages.choose} ${selection.display} ${selection.code}`
                    return (
                      <TableRow
                        className={cn(inactive && 'opacity-50', selected?.catalogItemId === selection.catalogItemId && 'bg-muted/70')}
                        key={selection.catalogItemId}
                        onDoubleClick={() => { if (!inactive) confirm(selection) }}
                      >
                        <TableCell>
                          <SelectionButton
                            disabled={inactive}
                            label={label}
                            onSelect={() => setSelected(selection)}
                            selected={selected?.catalogItemId === selection.catalogItemId}
                          />
                        </TableCell>
                        <TableCell className="font-medium">{selection.display}</TableCell>
                        <TableCell className="font-mono text-xs">{selection.code}</TableCell>
                        <TableCell>
                          {'laboratory' in item && item.laboratory !== undefined
                            ? item.laboratory.resultType
                            : messages.localCatalog}
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
              setSelected(undefined)
              search.onSearch(query, nextPage)
            }}
            page={page}
            pageSize={results.data.pageSize}
            total={results.data.total}
          />
        ) : null}
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

export function MedicationCatalogDialog({
  disabled,
  excludedIds,
  localCatalog,
  locale,
  mode = 'add',
  onSelect,
  search,
}: {
  disabled?: boolean
  excludedIds: ReadonlySet<string>
  localCatalog: PrescriptionMedication[]
  locale: WorkspaceLocale
  mode?: TriggerMode
  onSelect: (selection: MedicationCatalogSelection) => void
  search: ReferenceCatalogSearches['medications']
}) {
  const messages = copy[locale]
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<MedicationCatalogSelection>()
  const results = search
  const remoteResults = results.data?.items ?? []
  const useLocal = results.isError
    || (query.length === 0 && results.data !== undefined && remoteResults.length === 0)
  const normalizedLocalQuery = query.toLocaleLowerCase()
  const localResults = localCatalog.filter(item => {
    const display = locale === 'zh-CN' ? item.nameZh : item.nameEn
    return normalizedLocalQuery.length === 0
      || display.toLocaleLowerCase().includes(normalizedLocalQuery)
  })
  const referenceGroups = useMemo(
    () => results.data === undefined ? [] : groupMedicationProducts(results.data.items),
    [results.data],
  )
  const openDialog = () => {
    setInput('')
    setQuery('')
    setPage(1)
    setSelected(undefined)
    search.onSearch('', 1)
    setOpen(true)
  }
  const selectionId = selected === undefined
    ? undefined
    : selected.kind === 'reference'
      ? selected.product.id
      : selected.medication.id
  const confirm = (selection = selected) => {
    if (selection === undefined) return
    const id = selection.kind === 'reference' ? selection.product.id : selection.medication.id
    if (excludedIds.has(id)) return
    onSelect(selection)
    setOpen(false)
  }
  const triggerLabel = mode === 'replace' ? messages.replaceMedication : messages.addMedication
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <CatalogTriggerButton
        {...(disabled === undefined ? {} : { disabled })}
        label={triggerLabel}
        mode={mode}
        onClick={openDialog}
      />
      <DialogContent className="h-[min(720px,calc(100svh-2rem))] sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>{messages.chooseMedication}</DialogTitle>
          <DialogDescription>{messages.medicationDescription}</DialogDescription>
        </DialogHeader>
        <CatalogSearchForm
          input={input}
          inputLabel={messages.medicationSearchInput}
          label={messages.searchMedication}
          onInputChange={setInput}
          onSearch={() => {
            setPage(1)
            setSelected(undefined)
            const nextQuery = input.trim()
            setQuery(nextQuery)
            search.onSearch(nextQuery, 1)
          }}
          pending={results.isFetching}
          placeholder={messages.medicationPlaceholder}
        />
        {results.isPending ? <Skeleton className="mx-4 min-h-0 flex-1" /> : (
          <div className="mx-4 min-h-0 flex-1 overflow-auto border">
            {results.isError && localResults.length > 0 ? (
              <Alert className="m-2"><CircleAlertIcon /><AlertTitle>{messages.catalogUnavailable}</AlertTitle></Alert>
            ) : null}
            {(useLocal ? localResults : remoteResults).length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">{messages.noResults}</p>
            ) : (
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-popover">
                  <TableRow>
                    <TableHead className="w-12"><span className="sr-only">{messages.choose}</span></TableHead>
                    <TableHead className="min-w-52">{locale === 'zh-CN' ? '临床产品' : 'Clinical product'}</TableHead>
                    <TableHead className="min-w-28">{locale === 'zh-CN' ? '规格' : 'Strength'}</TableHead>
                    <TableHead className="min-w-24">{locale === 'zh-CN' ? '剂型' : 'Form'}</TableHead>
                    <TableHead className="min-w-56">{locale === 'zh-CN' ? '生产企业' : 'Manufacturer'}</TableHead>
                    <TableHead className="min-w-44">{locale === 'zh-CN' ? '批准文号' : 'Approval number'}</TableHead>
                    <TableHead className="min-w-32">{locale === 'zh-CN' ? '包装变体' : 'Package variant'}</TableHead>
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
                        onDoubleClick={() => { if (!excluded) confirm(selection) }}
                      >
                        <TableCell>
                          <SelectionButton
                            disabled={excluded}
                            label={`${messages.choose} ${genericName}`}
                            onSelect={() => setSelected(selection)}
                            selected={selectionId === id}
                          />
                        </TableCell>
                        <TableCell className="font-medium">{genericName}</TableCell>
                        <TableCell>-</TableCell>
                        <TableCell>{messages.localCatalog}</TableCell>
                        <TableCell>-</TableCell>
                        <TableCell className="font-mono text-xs">{excluded ? (locale === 'zh-CN' ? '已添加' : 'Added') : '-'}</TableCell>
                        <TableCell>-</TableCell>
                      </TableRow>
                    )
                  }) : referenceGroups.flatMap(group => group.variants.map((item, index) => {
                    const selection: MedicationCatalogSelection = { kind: 'reference', product: item }
                    const inactive = item.status !== 'active'
                    const excluded = excludedIds.has(item.id)
                    const unavailable = inactive || excluded
                    const label = `${messages.choose} ${item.genericName} ${item.strength} ${item.packageDescription} ${item.manufacturer} ${item.approvalNumber}`
                    return (
                      <TableRow
                        className={cn(unavailable && 'opacity-50', selectionId === item.id && 'bg-muted/70')}
                        key={item.id}
                        onDoubleClick={() => { if (!unavailable) confirm(selection) }}
                      >
                        <TableCell>
                          <SelectionButton
                            disabled={unavailable}
                            label={label}
                            onSelect={() => setSelected(selection)}
                            selected={selectionId === item.id}
                          />
                        </TableCell>
                        {index === 0 ? (
                          <>
                            <TableCell className="align-top font-medium" rowSpan={group.variants.length}>
                              <div className="flex items-center gap-2">
                                <span>{group.product.genericName}</span>
                                {group.variants.length > 1 ? (
                                  <Badge variant="secondary">
                                    {countLabel(messages.packageVariants, group.variants.length)}
                                  </Badge>
                                ) : null}
                              </div>
                            </TableCell>
                            <TableCell className="align-top" rowSpan={group.variants.length}>{group.product.strength}</TableCell>
                            <TableCell className="align-top" rowSpan={group.variants.length}>{group.product.dosageForm}</TableCell>
                            <TableCell className="align-top" rowSpan={group.variants.length}>{group.product.manufacturer}</TableCell>
                            <TableCell className="align-top font-mono text-xs" rowSpan={group.variants.length}>{group.product.approvalNumber}</TableCell>
                          </>
                        ) : null}
                        <TableCell>{item.packageDescription}</TableCell>
                      </TableRow>
                    )
                  }))}
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
              setSelected(undefined)
              search.onSearch(query, nextPage)
            }}
            page={page}
            pageSize={results.data.pageSize}
            total={results.data.total}
          />
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>{messages.close}</DialogClose>
          <Button disabled={selected === undefined} onClick={() => confirm()} type="button">
            {messages.confirmMedication}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
