import type { SessionContext } from '@clinmesh/contracts/his'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@clinmesh/ui/components/card'
import { DataTable, type DataTableColumn } from '@clinmesh/ui/components/data-table'
import { Input } from '@clinmesh/ui/components/input'
import { SegmentedControl, SegmentedControlItem } from '@clinmesh/ui/components/segmented-control'
import { TruncatedTooltip } from '@clinmesh/ui/components/truncated-tooltip'
import { useQuery } from '@tanstack/react-query'
import { DownloadIcon, RefreshCwIcon, SearchIcon, SparklesIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { getCurrentScenario, getSyntheticPatientProfiles, searchPatients } from '../api-client.ts'
import type { WorkspaceLocale } from '../workspace-i18n.ts'
import { useChatHandoffStore } from './chat-handoff.ts'

type GenderFilter = 'all' | 'male' | 'female'

interface CohortRow {
  id: string
  identifier: string
  name: string
  gender: string
  birthDate: string
  age: number | null
}

const PATIENT_SEARCH_ROLES = new Set([
  'registrar',
  'triage-nurse',
  'outpatient-doctor',
  'cashier',
  'pharmacist',
])

function calculateAge(birthDate: string | null | undefined, referenceIso: string | undefined): number | null {
  if (!birthDate) return null
  const birth = Date.parse(birthDate)
  const ref = referenceIso ? Date.parse(referenceIso) : Date.now()
  if (!Number.isFinite(birth) || !Number.isFinite(ref)) return null
  const years = Math.floor((ref - birth) / (365.25 * 24 * 60 * 60 * 1000))
  return years >= 0 && years < 130 ? years : null
}

function escapeCsvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`
  return value
}

export function ResearchSpace({
  locale,
  session,
  onNavigate,
}: {
  locale: WorkspaceLocale
  session: SessionContext
  onNavigate: (path: string) => void
}): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const setChatHandoff = useChatHandoffStore(s => s.setHandoff)
  const [searchText, setSearchText] = useState('')
  const [genderFilter, setGenderFilter] = useState<GenderFilter>('all')
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())

  const scenarioQuery = useQuery({
    queryKey: ['research-scenario', session.actor.workspaceId, session.actor.epoch],
    queryFn: ({ signal }) => getCurrentScenario(signal),
  })

  const canSearchPatients = PATIENT_SEARCH_ROLES.has(session.actor.roleCode)
  const isAdmin = session.actor.roleCode === 'administrator'

  const patientsQuery = useQuery({
    queryKey: ['research-patients', session.actor.workspaceId, session.actor.epoch, session.actor.roleCode, searchText.trim()],
    enabled: canSearchPatients || isAdmin,
    queryFn: async ({ signal }) => {
      if (isAdmin) {
        const res = await getSyntheticPatientProfiles(signal, 1, searchText.trim() || undefined)
        return {
          total: res.total,
          items: res.items.map(item => ({
            id: item.profileId,
            identifier: item.mrn,
            name: item.name,
            gender: item.gender,
            birthDate: item.birthDate,
          })),
        }
      }
      return searchPatients(searchText.trim(), signal, 1)
    },
  })

  const virtualNow = scenarioQuery.data?.virtualTime

  const cohortRows = useMemo<CohortRow[]>(() => {
    const items = patientsQuery.data?.items ?? []
    return items
      .map(patient => ({
        id: patient.id,
        identifier: patient.identifier || patient.id,
        name: patient.name.replace(/^合成/, '').replace(/^Synthetic\s+/i, ''),
        gender: patient.gender ?? 'unknown',
        birthDate: patient.birthDate ?? '',
        age: calculateAge(patient.birthDate, virtualNow),
      }))
      .filter(row => genderFilter === 'all' || row.gender === genderFilter)
  }, [genderFilter, patientsQuery.data?.items, virtualNow])

  const stats = useMemo(() => {
    const ages = cohortRows.map(r => r.age).filter((a): a is number => a !== null)
    const avgAge = ages.length > 0 ? (ages.reduce((s, v) => s + v, 0) / ages.length).toFixed(1) : '—'
    const maleCount = cohortRows.filter(r => r.gender === 'male').length
    const femaleCount = cohortRows.filter(r => r.gender === 'female').length
    return {
      total: cohortRows.length,
      avgAge,
      maleRatio: cohortRows.length > 0 ? `${Math.round((maleCount * 100) / cohortRows.length)}%` : '—',
      femaleCount,
      maleCount,
    }
  }, [cohortRows])

  const exportRowsCsv = (rowsToExport: readonly CohortRow[]) => {
    const header = ['PatientID', 'Identifier', 'Name', 'Gender', 'BirthDate', 'Age']
    const lines = [
      header.join(','),
      ...rowsToExport.map(r => [
        r.id,
        r.identifier,
        r.name,
        r.gender,
        r.birthDate,
        r.age === null ? '' : String(r.age),
      ].map(escapeCsvCell).join(',')),
    ]
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `clinmesh-synthetic-cohort-${rowsToExport.length}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const sendRowsToChat = (rowsToAnalyze: readonly CohortRow[]) => {
    const ages = rowsToAnalyze.map(r => r.age).filter((a): a is number => a !== null)
    const meanAge = ages.length > 0 ? (ages.reduce((s, v) => s + v, 0) / ages.length).toFixed(1) : '—'
    const males = rowsToAnalyze.filter(r => r.gender === 'male').length
    const females = rowsToAnalyze.filter(r => r.gender === 'female').length
    const sampleIds = rowsToAnalyze
      .slice(0, 8)
      .map(r => `${r.name}(${r.identifier}, ${r.gender === 'male' ? '男' : r.gender === 'female' ? '女' : r.gender}, ${r.age ?? '?'}岁)`)
      .join('、')
    const prompt = zh
      ? `请对当前科研筛选出的脱敏合成患者队列（共 ${rowsToAnalyze.length} 例，平均年龄 ${meanAge} 岁，男性 ${males} 例 / 女性 ${females} 例；代表样本：${sampleIds || '暂无'}）进行人口学特征总结，并建议下一步病例质量与教学评测维度：`
      : `Summarize this filtered synthetic cohort (${rowsToAnalyze.length} patients, mean age ${meanAge}, ${males}M/${females}F) and suggest clinical evaluation dimensions:`
    setChatHandoff({ draft: prompt, sessionId: null })
    onNavigate('/chat')
  }

  const columns = useMemo<readonly DataTableColumn<CohortRow>[]>(() => [
    {
      id: 'identifier',
      header: zh ? '患者编号' : 'Identifier',
      sortValue: row => row.identifier,
      cellClassName: 'font-mono text-xs text-muted-foreground',
      cell: row => row.identifier,
    },
    {
      id: 'name',
      header: zh ? '姓名（合成）' : 'Name (Synthetic)',
      sortValue: row => row.name,
      hideable: false,
      cellClassName: 'font-medium',
      cell: row => row.name,
    },
    {
      id: 'gender',
      header: zh ? '性别' : 'Gender',
      sortValue: row => row.gender,
      cell: row => (
        <Badge variant="outline">
          {row.gender === 'male'
            ? (zh ? '男' : 'Male')
            : row.gender === 'female'
              ? (zh ? '女' : 'Female')
              : row.gender}
        </Badge>
      ),
    },
    {
      id: 'age',
      header: zh ? '年龄' : 'Age',
      sortValue: row => row.age ?? -1,
      cellClassName: 'tabular-nums',
      cell: row => (row.age !== null ? row.age : '—'),
    },
    {
      id: 'birthDate',
      header: zh ? '出生日期' : 'Birth Date',
      sortValue: row => row.birthDate,
      cellClassName: 'font-mono text-xs text-muted-foreground tabular-nums',
      cell: row => row.birthDate || '—',
    },
  ], [zh])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Main Research Body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto flex max-w-5xl flex-col gap-5 pb-12">
          {/* KPI Row */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="text-xs">{zh ? '当前入组合计' : 'Filtered Cohort'}</CardDescription>
                <CardTitle className="text-2xl tabular-nums">{stats.total}</CardTitle>
              </CardHeader>
              <CardContent className="text-[11px] text-muted-foreground">
                {zh ? `工作区总匹配 ${patientsQuery.data?.total ?? 0} 例合成患者` : `${patientsQuery.data?.total ?? 0} synthetic patients matched`}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="text-xs">{zh ? '队列平均年龄' : 'Mean Age'}</CardDescription>
                <CardTitle className="text-2xl tabular-nums">
                  {stats.avgAge}{stats.avgAge !== '—' && zh ? ' 岁' : ''}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-[11px] text-muted-foreground">
                {zh ? '按工作区当前业务时钟计算' : 'Computed against virtual clock'}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="text-xs">{zh ? '性别构成 (男 / 女)' : 'Sex Split (M / F)'}</CardDescription>
                <CardTitle className="text-2xl tabular-nums">
                  {stats.maleCount} / {stats.femaleCount}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-[11px] text-muted-foreground">
                {zh ? `男性占比 ${stats.maleRatio}` : `Male share ${stats.maleRatio}`}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="text-xs">{zh ? '当前仿真世代' : 'Active Scenario'}</CardDescription>
                <CardTitle className="text-base">
                  <TruncatedTooltip text={scenarioQuery.data?.scenarioId ?? `Epoch #${session.actor.epoch}`} />
                </CardTitle>
              </CardHeader>
              <CardContent className="text-[11px] text-muted-foreground">
                {zh ? '全脱敏合成仿真数据' : 'Synthetic de-identified data'}
              </CardContent>
            </Card>
          </div>

          {/* Interactive SaaS Cohort DataTable */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{zh ? '工作区合成患者队列明细' : 'Workspace Synthetic Cohort Table'}</CardTitle>
              <CardDescription className="text-xs">
                {zh
                  ? '支持点击表头排序、自定义显隐列、多选批量导出 CSV 或将选中子队列一键送入全屏聊天页由 pi-durable 深入分析。'
                  : 'Sortable columns, display column toggles, row selection, CSV export, and one-click handoff to full-screen pi-durable chat.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DataTable
                ariaLabel={zh ? '合成患者科研队列' : 'Synthetic research cohort'}
                clearSelectionLabel={zh ? '清除选择' : 'Clear selection'}
                columns={columns}
                columnsHeading={zh ? '显示列开关' : 'Visible columns'}
                displayLabel={zh ? '显示' : 'Display'}
                emptyState={zh ? '当前筛选条件下暂无匹配合成患者。' : 'No matching synthetic patients.'}
                getRowId={row => row.id}
                loading={patientsQuery.isLoading}
                loadingText={zh ? '正在加载工作区合成患者队列…' : 'Loading cohort…'}
                onSelectedIdsChange={setSelectedIds}
                pageSize={10}
                renderBatchActions={(selectedRows, clear) => (
                  <>
                    <Button
                      onClick={() => exportRowsCsv(selectedRows)}
                      size="xs"
                      type="button"
                      variant="outline"
                    >
                      <DownloadIcon aria-hidden="true" className="size-3.5" />
                      <span>{zh ? '导出所选 CSV' : 'Export selected'}</span>
                    </Button>
                    <Button
                      onClick={() => {
                        sendRowsToChat(selectedRows)
                        clear()
                      }}
                      size="xs"
                      type="button"
                    >
                      <SparklesIcon aria-hidden="true" className="size-3.5" />
                      <span>{zh ? '分析所选子队列' : 'Analyze selected'}</span>
                    </Button>
                  </>
                )}
                rows={cohortRows}
                selectable
                selectedIds={selectedIds}
                selectedLabel={count => (zh ? `已选 ${count} 例患者` : `${count} selected`)}
                toolbarLeading={(
                  <>
                    <div className="relative w-56">
                      <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        aria-label={zh ? '筛选合成患者队列' : 'Filter synthetic patient cohort'}
                        className="h-8 pl-8 text-xs"
                        onChange={event => setSearchText(event.currentTarget.value)}
                        placeholder={zh ? '按姓名或编号筛选队列…' : 'Filter by name or ID…'}
                        value={searchText}
                      />
                    </div>
                    <SegmentedControl
                      aria-label={zh ? '按性别筛选' : 'Filter by gender'}
                      onValueChange={val => {
                        if (val === 'all' || val === 'male' || val === 'female') {
                          setGenderFilter(val)
                        }
                      }}
                      value={genderFilter}
                    >
                      <SegmentedControlItem value="all">{zh ? '全部性别' : 'All'}</SegmentedControlItem>
                      <SegmentedControlItem value="male">{zh ? '男' : 'Male'}</SegmentedControlItem>
                      <SegmentedControlItem value="female">{zh ? '女' : 'Female'}</SegmentedControlItem>
                    </SegmentedControl>
                  </>
                )}
                toolbarTrailing={(
                  <>
                    <Button onClick={() => void patientsQuery.refetch()} size="sm" type="button" variant="ghost">
                      <RefreshCwIcon aria-hidden="true" className="size-3.5" />
                      <span>{zh ? '刷新' : 'Refresh'}</span>
                    </Button>
                    <Button disabled={cohortRows.length === 0} onClick={() => exportRowsCsv(cohortRows)} size="sm" type="button" variant="outline">
                      <DownloadIcon aria-hidden="true" className="size-3.5" />
                      <span>{zh ? '导出 CSV' : 'Export CSV'}</span>
                    </Button>
                    <Button onClick={() => sendRowsToChat(cohortRows)} size="sm" type="button">
                      <SparklesIcon aria-hidden="true" className="size-3.5" />
                      <span>{zh ? '送入聊天页分析' : 'Analyze in Chat'}</span>
                    </Button>
                  </>
                )}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
