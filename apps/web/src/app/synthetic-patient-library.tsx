import { createAvatar } from '@dicebear/core'
import * as lorelei from '@dicebear/lorelei'
import type {
  ScenarioGenerationRequest,
  ScenarioProviderCapabilities,
  SyntheticPatientIdentity,
  SyntheticPatientProfileDetail,
} from '@clinmesh/contracts/scenario'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@clinmesh/ui/components/avatar'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@clinmesh/ui/components/empty'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@clinmesh/ui/components/input-group'
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
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { cn } from '@clinmesh/ui/lib/utils'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRightIcon,
  CircleAlertIcon,
  DatabaseIcon,
  FileJsonIcon,
  ListFilterIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  UserPlusIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  enqueuePatientBrief,
  enqueueScenarioGenerationJob,
  getCurrentScenario,
  getPatientBriefJob,
  getPatientBriefRevisions,
  getRegistrationCatalog,
  getScenarioGenerationJob,
  getScenarioProviders,
  getSyntheticCaseHistory,
  getSyntheticCaseHistoryDetail,
  getSyntheticPatientProfile,
  getSyntheticPatientProfiles,
  newIdempotencyKey,
  selectPatientBriefRevision,
  startSyntheticCaseVisit,
  updateSyntheticPatientProfile,
} from './api-client.ts'
import { scenarioModuleOptions } from './scenario-module-options.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

const profileListKey = ['synthetic-patient-profiles'] as const
const providerKey = ['scenario-providers'] as const
const currentScenarioKey = ['scenario-current'] as const
const avatarCache = new Map<string, string>()

const copy = {
  'en-US': {
    address: 'Address', advanced: 'Advanced settings', allModules: 'All Synthea modules',
    batch: 'Generation batch', brief: 'Patient Brief', briefFailed: 'Brief generation failed', briefGenerate: 'Generate Brief', caseType: 'Case type', clinicalSeed: 'Clinical seed',
    contact: 'Contact', editProfile: 'Edit profile', email: 'Email',
    emptyDescription: 'Generate localized longitudinal Synthea records for up to ten patients.',
    emptyTitle: 'No synthetic patients yet', externalHistory: 'External synthetic R4 history',
    filterModules: 'Limit Synthea modules', generate: 'Generate patients',
    generationFailed: 'Patient generation failed', generationSucceeded: 'Profiles and cases are ready',
    history: 'Source history', historyStart: 'History start', identity: 'Identity',
    insurance: 'Simulated insurance', libraryDescription: 'Localized source history and immutable current cases.',
    libraryTitle: 'Synthetic patient library', mrn: 'MRN', name: 'Display name',
    nationalId: 'Synthetic national ID', next: 'Next', noCase: 'No usable current case',
    noHistory: 'No visible source history', patientCount: 'Patient count', phone: 'Phone',
    populationSeed: 'Population seed', previous: 'Previous', queued: 'Generation request accepted',
    resourceDetail: 'R4 resource detail', save: 'Save profile', saveFailed: 'Failed to save profile', search: 'Search patients', source: 'Source', startVisit: 'Start outpatient visit',
  },
  'zh-CN': {
    address: '地址', advanced: '高级设置', allModules: '全部 Synthea 模块', batch: '生成批次', brief: '患者梗概', briefFailed: '梗概生成失败', briefGenerate: '生成患者梗概',
    caseType: '病例类型', clinicalSeed: '临床 seed', contact: '联系方式', editProfile: '编辑档案',
    email: '电子邮箱', emptyDescription: '生成完整中文 Synthea 纵向病历，每批最多 10 人。',
    emptyTitle: '还没有合成患者', externalHistory: '外部合成 R4 历史', filterModules: '限制 Synthea 模块',
    generate: '生成患者', generationFailed: '患者生成失败', generationSucceeded: '患者档案与病例已生成',
    history: '来源历史', historyStart: '历史起始日期', identity: '身份信息', insurance: '模拟保险',
    libraryDescription: '中文来源病史与不可变本次病例。', libraryTitle: '合成患者库', mrn: 'MRN',
    name: '展示姓名', nationalId: '模拟身份证', next: '下一页', noCase: '没有可用的本次病例',
    noHistory: '没有可见来源历史', patientCount: '患者人数', phone: '手机号码', populationSeed: '人口 seed',
    previous: '上一页', queued: '生成请求已提交', resourceDetail: 'R4 资源详情', save: '保存档案', saveFailed: '保存失败',
    search: '搜索患者', source: '来源', startVisit: '开始门诊就诊',
  },
} as const

const genderItems = [
  { label: '不限', value: 'any' },
  { label: '女', value: 'female' },
  { label: '男', value: 'male' },
] as const

function avatarUri(seed: string): string {
  const cached = avatarCache.get(seed)
  if (cached !== undefined) return cached
  const value = createAvatar(lorelei, { seed: `clinmesh:${seed}` }).toDataUri()
  avatarCache.set(seed, value)
  return value
}

function ProfileAvatar({ className, name, profileId }: {
  className?: string
  name: string
  profileId: string
}) {
  return <Avatar className={cn('size-10 bg-muted', className)}><AvatarImage alt={`${name}的合成头像`} src={avatarUri(profileId)} /><AvatarFallback>{name.slice(0, 1)}</AvatarFallback></Avatar>
}

function age(birthDate: string, referenceDate: string): number {
  const birth = new Date(`${birthDate}T00:00:00Z`)
  const reference = new Date(`${referenceDate}T00:00:00Z`)
  let years = reference.getUTCFullYear() - birth.getUTCFullYear()
  if (reference.getUTCMonth() < birth.getUTCMonth() || (reference.getUTCMonth() === birth.getUTCMonth() && reference.getUTCDate() < birth.getUTCDate())) years -= 1
  return years
}

function caseTypeLabel(type: NonNullable<SyntheticPatientProfileDetail['case']>['caseType'], locale: WorkspaceLocale): string {
  const labels = locale === 'zh-CN'
    ? { 'follow-up': '复诊', 'new-problem': '新问题', preventive: '预防保健' }
    : { 'follow-up': 'Follow-up', 'new-problem': 'New problem', preventive: 'Preventive' }
  return labels[type]
}

function SourceHistory({ caseId, locale }: { caseId: string; locale: WorkspaceLocale }) {
  const messages = copy[locale]
  const [page, setPage] = useState(1)
  const [selectedReference, setSelectedReference] = useState<string>()
  const history = useQuery({
    queryFn: ({ signal }) => getSyntheticCaseHistory(caseId, signal, page),
    queryKey: ['synthetic-case-history', caseId, page],
  })
  const detail = useQuery({
    enabled: selectedReference !== undefined,
    queryFn: ({ signal }) => selectedReference === undefined
      ? Promise.reject(new Error('No source resource selected'))
      : getSyntheticCaseHistoryDetail(caseId, selectedReference, signal),
    queryKey: ['synthetic-case-history-detail', caseId, selectedReference ?? 'none'],
  })
  if (history.isPending) return <Skeleton className="h-72 w-full" />
  if (history.isError) return <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{messages.generationFailed}</AlertTitle></Alert>
  if (history.data.items.length === 0) return <p className="py-8 text-sm text-muted-foreground">{messages.noHistory}</p>
  return <div className="grid min-h-[360px] lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]"><div className="border-r">{history.data.items.map(item => <button className={cn('grid w-full grid-cols-[104px_minmax(0,1fr)_24px] items-center gap-3 border-b px-3 py-3 text-left', selectedReference === item.sourceReference && 'bg-muted/50')} key={item.sourceReference} onClick={() => setSelectedReference(item.sourceReference)} type="button"><span className="text-xs text-muted-foreground">{item.clinicalDate.slice(0, 10)}</span><span className="min-w-0"><strong className="block truncate text-sm">{item.title}</strong><span className="mt-0.5 block truncate text-xs text-muted-foreground">{item.resourceType}</span></span><ChevronRightIcon className="size-4 text-muted-foreground" /></button>)}<div className="flex justify-between p-2"><Button disabled={page === 1} onClick={() => setPage(current => current - 1)} size="sm" variant="ghost">{messages.previous}</Button><Button disabled={page * history.data.pageSize >= history.data.total} onClick={() => setPage(current => current + 1)} size="sm" variant="ghost">{messages.next}</Button></div></div><section className="min-w-0 p-3"><h4 className="flex items-center gap-2 text-sm font-semibold"><FileJsonIcon className="size-4" />{messages.resourceDetail}</h4>{selectedReference === undefined ? <p className="mt-4 text-sm text-muted-foreground">{messages.externalHistory}</p> : detail.isPending ? <Skeleton className="mt-3 h-64 w-full" /> : detail.isError ? <Alert className="mt-3" variant="destructive"><CircleAlertIcon /><AlertTitle>{messages.generationFailed}</AlertTitle></Alert> : <pre className="mt-3 max-h-[420px] overflow-auto border bg-muted/20 p-3 text-xs">{JSON.stringify(detail.data.resource, null, 2)}</pre>}</section></div>
}

function StartCaseVisitSheet({ locale, onOpenChange, open, profileId, syntheticCase }: {
  locale: WorkspaceLocale
  onOpenChange: (open: boolean) => void
  open: boolean
  profileId: string
  syntheticCase: NonNullable<SyntheticPatientProfileDetail['case']>
}) {
  const messages = copy[locale]
  const queryClient = useQueryClient()
  const [departmentId, setDepartmentId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [visitTypeId, setVisitTypeId] = useState('')
  const catalog = useQuery({
    enabled: open,
    queryFn: ({ signal }) => getRegistrationCatalog(signal),
    queryKey: ['registration-catalog'],
  })
  const effectiveDepartmentId = departmentId || catalog.data?.departments[0]?.id || ''
  const effectiveLocationId = locationId || catalog.data?.locations[0]?.id || ''
  const effectiveVisitTypeId = visitTypeId || catalog.data?.visitTypes[0]?.id || ''
  const start = useMutation({
    mutationFn: () => {
      if (syntheticCase.activeBriefRevision === null || catalog.data === undefined) {
        throw new Error('The Synthetic Case has no active Patient Brief')
      }
      return startSyntheticCaseVisit({
        activeBriefRevision: syntheticCase.activeBriefRevision,
        caseId: syntheticCase.caseId,
        departmentId: effectiveDepartmentId,
        expectedCaseRevision: syntheticCase.revision,
        locationId: effectiveLocationId,
        visitDate: catalog.data.virtualDate,
        visitTypeId: effectiveVisitTypeId,
      }, newIdempotencyKey())
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['synthetic-patient-profile', profileId] }),
        queryClient.invalidateQueries({ queryKey: profileListKey }),
      ])
      onOpenChange(false)
    },
  })
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-full sm:max-w-md" side="right">
        <SheetHeader><SheetTitle>{messages.startVisit}</SheetTitle><SheetDescription>{syntheticCase.caseId}</SheetDescription></SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4">
          {catalog.isPending ? <Skeleton className="h-28 w-full" /> : catalog.isError ? (
            <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{messages.generationFailed}</AlertTitle></Alert>
          ) : catalog.data === undefined ? null : (
            <FieldGroup>
              <Field><FieldLabel htmlFor="case-visit-department">{locale === 'zh-CN' ? '就诊科室' : 'Department'}</FieldLabel><Select items={catalog.data.departments.map(item => ({ label: locale === 'zh-CN' ? item.nameZh : item.nameEn, value: item.id }))} onValueChange={value => setDepartmentId(value ?? '')} value={effectiveDepartmentId}><SelectTrigger className="w-full" id="case-visit-department"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{catalog.data.departments.map(item => <SelectItem key={item.id} value={item.id}>{locale === 'zh-CN' ? item.nameZh : item.nameEn}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
              <Field><FieldLabel htmlFor="case-visit-location">{locale === 'zh-CN' ? '就诊地点' : 'Location'}</FieldLabel><Select items={catalog.data.locations.map(item => ({ label: locale === 'zh-CN' ? item.nameZh : item.nameEn, value: item.id }))} onValueChange={value => setLocationId(value ?? '')} value={effectiveLocationId}><SelectTrigger className="w-full" id="case-visit-location"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{catalog.data.locations.map(item => <SelectItem key={item.id} value={item.id}>{locale === 'zh-CN' ? item.nameZh : item.nameEn}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
              <Field><FieldLabel htmlFor="case-visit-type">{locale === 'zh-CN' ? '门诊类型' : 'Visit type'}</FieldLabel><Select items={catalog.data.visitTypes.map(item => ({ label: locale === 'zh-CN' ? item.nameZh : item.nameEn, value: item.id }))} onValueChange={value => setVisitTypeId(value ?? '')} value={effectiveVisitTypeId}><SelectTrigger className="w-full" id="case-visit-type"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{catalog.data.visitTypes.map(item => <SelectItem key={item.id} value={item.id}>{locale === 'zh-CN' ? item.nameZh : item.nameEn}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
            </FieldGroup>
          )}
          {start.error === null ? null : <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{messages.generationFailed}</AlertTitle><AlertDescription>{start.error instanceof Error ? start.error.message : String(start.error)}</AlertDescription></Alert>}
        </div>
        <SheetFooter><Button disabled={catalog.data === undefined || start.isPending || effectiveDepartmentId === '' || effectiveLocationId === '' || effectiveVisitTypeId === ''} onClick={() => start.mutate()}><UserPlusIcon data-icon="inline-start" />{messages.startVisit}</Button></SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function PatientBriefPanel({ locale, profileId, syntheticCase }: {
  locale: WorkspaceLocale
  profileId: string
  syntheticCase: NonNullable<SyntheticPatientProfileDetail['case']>
}) {
  const messages = copy[locale]
  const queryClient = useQueryClient()
  const [jobId, setJobId] = useState<string>()
  const [visitOpen, setVisitOpen] = useState(false)
  const revisions = useQuery({
    queryFn: ({ signal }) => getPatientBriefRevisions(syntheticCase.caseId, signal),
    queryKey: ['patient-brief-revisions', syntheticCase.caseId],
  })
  const generate = useMutation({
    mutationFn: () => enqueuePatientBrief(syntheticCase.caseId, newIdempotencyKey()),
    onSuccess: response => setJobId(response.data.jobId),
  })
  const job = useQuery({
    enabled: jobId !== undefined,
    queryFn: ({ signal }) => jobId === undefined
      ? Promise.reject(new Error('No Patient Brief job'))
      : getPatientBriefJob(jobId, signal),
    queryKey: ['patient-brief-job', jobId ?? 'none'],
    refetchInterval: query => ['queued', 'running'].includes(query.state.data?.status ?? '')
      ? 1_000
      : false,
  })
  useEffect(() => {
    if (job.data?.status !== 'succeeded') return
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['patient-brief-revisions', syntheticCase.caseId] }),
      queryClient.invalidateQueries({ queryKey: ['synthetic-patient-profile', profileId] }),
      queryClient.invalidateQueries({ queryKey: profileListKey }),
    ])
  }, [job.data?.status, profileId, queryClient, syntheticCase.caseId])
  const select = useMutation({
    mutationFn: (revision: number) => selectPatientBriefRevision({
      briefRevision: revision,
      caseId: syntheticCase.caseId,
      expectedCaseRevision: syntheticCase.revision,
    }, newIdempotencyKey()),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['patient-brief-revisions', syntheticCase.caseId] }),
        queryClient.invalidateQueries({ queryKey: ['synthetic-patient-profile', profileId] }),
      ])
    },
  })
  const running = job.data?.status === 'queued' || job.data?.status === 'running'
  return (
    <section className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{messages.brief}</h4>
        <div className="flex flex-wrap gap-2">
          {syntheticCase.status === 'brief-ready' && syntheticCase.activeBriefRevision !== null ? (
            <Button onClick={() => setVisitOpen(true)} size="sm" variant="outline">
              <UserPlusIcon data-icon="inline-start" />{messages.startVisit}
            </Button>
          ) : null}
          <Button disabled={generate.isPending || running || syntheticCase.status === 'started'} onClick={() => generate.mutate()} size="sm">
            <SparklesIcon data-icon="inline-start" />{messages.briefGenerate}
          </Button>
        </div>
      </div>
      {generate.error === null ? null : (
        <Alert className="mt-3" variant="destructive">
          <CircleAlertIcon /><AlertTitle>{messages.briefFailed}</AlertTitle>
          <AlertDescription>{generate.error instanceof Error ? generate.error.message : String(generate.error)}</AlertDescription>
        </Alert>
      )}
      {job.data?.status === 'failed' ? (
        <Alert className="mt-3" variant="destructive">
          <CircleAlertIcon /><AlertTitle>{messages.briefFailed}</AlertTitle>
          <AlertDescription>{job.data.error?.message}</AlertDescription>
        </Alert>
      ) : null}
      {running ? <Skeleton className="mt-3 h-20 w-full" /> : null}
      {revisions.isPending ? (
        <Skeleton className="mt-3 h-64 w-full" />
      ) : revisions.isError ? (
        <Alert className="mt-3" variant="destructive"><CircleAlertIcon /><AlertTitle>{messages.briefFailed}</AlertTitle></Alert>
      ) : revisions.data.items.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{locale === 'zh-CN' ? '尚未生成患者梗概' : 'No Patient Brief revision'}</p>
      ) : (
        <div className="mt-4 border-t">
          {revisions.data.items.map(revision => (
            <section className="border-b py-4" key={revision.revision}>
              <div className="flex flex-wrap items-center gap-2">
                <h5 className="text-sm font-semibold">Revision {revision.revision}</h5>
                {revisions.data.activeRevision === revision.revision
                  ? <Badge variant="success">Active</Badge>
                  : <Button disabled={select.isPending} onClick={() => select.mutate(revision.revision)} size="sm" variant="outline">{locale === 'zh-CN' ? '设为当前' : 'Select'}</Button>}
                <span className="text-xs text-muted-foreground">{revision.model}</span>
              </div>
              <dl className="mt-3 grid gap-3 text-sm">
                <div><dt className="text-xs text-muted-foreground">{locale === 'zh-CN' ? '主诉' : 'Chief complaint'}</dt><dd className="mt-1">{revision.content.chiefComplaint}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{locale === 'zh-CN' ? '开场陈述' : 'Opening statement'}</dt><dd className="mt-1">{revision.content.openingStatement}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{locale === 'zh-CN' ? '已知史' : 'Known history'}</dt><dd className="mt-1">{revision.content.knownHistorySummary}</dd></div>
              </dl>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {revision.content.symptomTopics.map(topic => <Badge key={topic.id} variant="outline">{topic.name}</Badge>)}
              </div>
            </section>
          ))}
        </div>
      )}
      {select.error === null ? null : (
        <Alert className="mt-3" variant="destructive"><CircleAlertIcon /><AlertTitle>{messages.briefFailed}</AlertTitle><AlertDescription>{select.error instanceof Error ? select.error.message : String(select.error)}</AlertDescription></Alert>
      )}
      <StartCaseVisitSheet
        locale={locale}
        onOpenChange={setVisitOpen}
        open={visitOpen}
        profileId={profileId}
        syntheticCase={syntheticCase}
      />
    </section>
  )
}

function ProfileDetails({ locale, onEdit, profile, referenceDate }: {
  locale: WorkspaceLocale
  onEdit: () => void
  profile: SyntheticPatientProfileDetail
  referenceDate: string
}) {
  const messages = copy[locale]
  const displayPhone = /^1\d{10}$/.test(profile.identity.phone)
    ? `${profile.identity.phone.slice(0, 3)}****${profile.identity.phone.slice(-4)}`
    : profile.identity.phone
  return (
    <div className="min-w-0 bg-background">
      <header className="border-b px-4 py-4">
        <div className="flex flex-wrap items-start gap-4">
          <ProfileAvatar className="size-16" name={profile.identity.displayName} profileId={profile.profileId} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xl font-semibold">{profile.identity.displayName}</h3>
              <Badge variant="outline">{profile.gender}</Badge>
              <span className="text-sm text-muted-foreground">{age(profile.birthDate, referenceDate)} 岁（{profile.birthDate}）</span>
              {profile.case === null
                ? <Badge variant="warning">{messages.noCase}</Badge>
                : <Badge variant="info">{caseTypeLabel(profile.case.caseType, locale)}</Badge>}
            </div>
            <div className="mt-3 grid gap-x-6 gap-y-1 text-sm text-muted-foreground sm:grid-cols-2 xl:grid-cols-4">
              <span>{messages.mrn}：<strong className="font-medium text-foreground">{profile.identity.mrn}</strong></span>
              <span>{messages.phone}：<strong className="font-medium text-foreground">{displayPhone}</strong></span>
              <span>{messages.source}：<strong className="font-medium text-foreground">{profile.source.providerId === 'synthea' ? 'Synthea R4' : 'ClinMesh'}</strong></span>
              <span>{messages.batch}：<strong className="font-medium text-foreground">{profile.source.batchName}</strong></span>
            </div>
          </div>
          <Button aria-label={messages.editProfile} onClick={onEdit} size="icon" title={messages.editProfile} variant="outline"><PencilIcon /></Button>
        </div>
      </header>
      <div className="grid border-b sm:grid-cols-2 xl:grid-cols-4">
        <section className="min-w-0 border-b p-4 sm:border-r xl:border-b-0"><h4 className="text-sm font-semibold">{messages.identity}</h4><p className="mt-2 text-sm">{profile.identity.nationalId}</p><p className="mt-1 text-xs text-muted-foreground">{profile.gender} · {profile.birthDate}</p></section>
        <section className="min-w-0 border-b p-4 sm:border-r xl:border-b-0"><h4 className="text-sm font-semibold">{messages.address}</h4><p className="mt-2 break-words text-sm">{profile.identity.address}</p></section>
        <section className="min-w-0 border-b p-4 sm:border-r xl:border-b-0"><h4 className="text-sm font-semibold">{messages.contact}</h4><p className="mt-2 text-sm">{displayPhone}</p><p className="mt-1 break-words text-xs text-muted-foreground">{profile.identity.email}</p></section>
        <section className="min-w-0 p-4"><h4 className="text-sm font-semibold">{messages.insurance}</h4><p className="mt-2 text-sm">{profile.identity.insuranceDisplay}</p></section>
      </div>
      <Tabs defaultValue="history">
        <TabsList className="mx-4 mt-3" variant="line">
          <TabsTrigger value="history">{messages.history}{profile.case === null ? '' : ` ${profile.case.visibleHistoryCount}`}</TabsTrigger>
          {profile.case === null ? null : <TabsTrigger value="brief">{messages.brief}</TabsTrigger>}
          <TabsTrigger value="source">{messages.source}</TabsTrigger>
        </TabsList>
        <TabsContent value="history">
          {profile.case === null
            ? <p className="p-4 text-sm text-muted-foreground">{messages.noHistory}</p>
            : <SourceHistory caseId={profile.case.caseId} locale={locale} />}
        </TabsContent>
        {profile.case === null ? null : (
          <TabsContent value="brief">
            <PatientBriefPanel locale={locale} profileId={profile.profileId} syntheticCase={profile.case} />
          </TabsContent>
        )}
        <TabsContent className="p-4" value="source">
          <Alert><FileJsonIcon /><AlertTitle>{messages.externalHistory}</AlertTitle><AlertDescription>{profile.source.format} · SHA-256 {profile.source.hash}</AlertDescription></Alert>
          {profile.case === null ? null : (
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
              <div><dt className="text-muted-foreground">Case ID</dt><dd className="mt-1 break-all font-mono text-xs">{profile.case.caseId}</dd></div>
              <div><dt className="text-muted-foreground">{messages.caseType}</dt><dd className="mt-1">{caseTypeLabel(profile.case.caseType, locale)}</dd></div>
              <div><dt className="text-muted-foreground">Status</dt><dd className="mt-1">{profile.case.status}</dd></div>
            </dl>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function GenerationSheet({ error, locale, onGenerate, onOpenChange, open, pending, providers }: {
  error: unknown
  locale: WorkspaceLocale
  onGenerate: (request: ScenarioGenerationRequest) => void
  onOpenChange: (open: boolean) => void
  open: boolean
  pending: boolean
  providers: readonly ScenarioProviderCapabilities[]
}) {
  const messages = copy[locale]
  const [request, setRequest] = useState<ScenarioGenerationRequest>({
    moduleMode: 'all', modules: [],
    name: locale === 'zh-CN' ? 'Synthea 中文患者批次' : 'Localized Synthea patient batch',
    population: { age: { maximum: 80, minimum: 18 }, count: 1, gender: 'any' },
    providerId: 'synthea', seeds: { clinical: 7331, population: 4242 },
    timeRange: { end: '2026-08-01', start: '2011-08-01' }, timeZone: 'Asia/Shanghai',
  })
  const provider = providers.find(item => item.providerId === 'synthea')
  const filtered = request.moduleMode === 'filter'
  const updatePopulation = (next: Partial<ScenarioGenerationRequest['population']>) => setRequest(current => ({ ...current, population: { ...current.population, ...next } }))
  const updateModule = (module: string, checked: boolean) => setRequest(current => ({ ...current, modules: checked ? [...new Set([...current.modules, module])] : current.modules.length === 1 ? current.modules : current.modules.filter(item => item !== module) }))
  return <Sheet onOpenChange={onOpenChange} open={open}><SheetContent className="w-full sm:max-w-lg" side="right"><SheetHeader><SheetTitle>{messages.generate}</SheetTitle><SheetDescription>{messages.emptyDescription}</SheetDescription></SheetHeader><div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4"><div className="border-b pb-3"><p className="text-sm font-semibold">Synthea</p><p className="mt-1 text-xs text-muted-foreground">{messages.allModules}</p></div><FieldGroup className="grid gap-3 sm:grid-cols-2"><Field><FieldLabel htmlFor="patient-batch-name">{messages.batch}</FieldLabel><Input id="patient-batch-name" maxLength={120} onChange={event => setRequest(current => ({ ...current, name: event.target.value }))} value={request.name} /></Field><Field><FieldLabel htmlFor="patient-count">{messages.patientCount}</FieldLabel><Input id="patient-count" max={10} min={1} onChange={event => updatePopulation({ count: Number(event.target.value) })} type="number" value={request.population.count} /></Field><Field><FieldLabel htmlFor="patient-min-age">最小年龄</FieldLabel><Input id="patient-min-age" max={120} min={0} onChange={event => updatePopulation({ age: { ...request.population.age, minimum: Number(event.target.value) } })} type="number" value={request.population.age.minimum} /></Field><Field><FieldLabel htmlFor="patient-max-age">最大年龄</FieldLabel><Input id="patient-max-age" max={120} min={0} onChange={event => updatePopulation({ age: { ...request.population.age, maximum: Number(event.target.value) } })} type="number" value={request.population.age.maximum} /></Field></FieldGroup><Field><FieldLabel htmlFor="patient-gender">性别</FieldLabel><Select items={genderItems} onValueChange={value => { if (value !== null) updatePopulation({ gender: value }) }} value={request.population.gender}><SelectTrigger className="w-full" id="patient-gender"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{genderItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><details className="border-t pt-4"><summary className="cursor-pointer text-sm font-medium">{messages.advanced}</summary><FieldGroup className="mt-4"><Field orientation="horizontal"><Checkbox checked={filtered} id="patient-filter-modules" onCheckedChange={checked => setRequest(current => ({ ...current, moduleMode: checked === true ? 'filter' : 'all', modules: checked === true ? ['fever'] : [] }))} /><FieldLabel htmlFor="patient-filter-modules">{messages.filterModules}</FieldLabel></Field>{filtered ? <FieldSet><FieldLegend variant="label">Synthea modules</FieldLegend><FieldGroup>{scenarioModuleOptions.map(option => <Field key={option.value} orientation="horizontal"><Checkbox checked={request.modules.includes(option.value)} id={`patient-${option.value}`} onCheckedChange={checked => updateModule(option.value, checked === true)} /><FieldLabel htmlFor={`patient-${option.value}`}>{option.label[locale]}</FieldLabel></Field>)}</FieldGroup></FieldSet> : null}<FieldGroup className="grid gap-3 sm:grid-cols-2"><Field><FieldLabel htmlFor="patient-population-seed">{messages.populationSeed}</FieldLabel><Input id="patient-population-seed" min={0} onChange={event => setRequest(current => ({ ...current, seeds: { ...current.seeds, population: Number(event.target.value) } }))} type="number" value={request.seeds.population} /></Field><Field><FieldLabel htmlFor="patient-clinical-seed">{messages.clinicalSeed}</FieldLabel><Input id="patient-clinical-seed" min={0} onChange={event => setRequest(current => ({ ...current, seeds: { ...current.seeds, clinical: Number(event.target.value) } }))} type="number" value={request.seeds.clinical} /></Field><Field className="sm:col-span-2"><FieldLabel htmlFor="patient-history-start">{messages.historyStart}</FieldLabel><Input id="patient-history-start" onChange={event => setRequest(current => ({ ...current, timeRange: { ...current.timeRange, start: event.target.value } }))} type="date" value={request.timeRange.start} /></Field></FieldGroup></FieldGroup></details>{provider?.available === false ? <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{provider.unavailableReason}</AlertTitle></Alert> : null}{error === null ? null : <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{messages.generationFailed}</AlertTitle><AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription></Alert>}</div><SheetFooter><Button disabled={pending || provider?.available !== true} onClick={() => onGenerate(request)}><SparklesIcon data-icon="inline-start" />{messages.generate}</Button></SheetFooter></SheetContent></Sheet>
}

function EditProfileSheet({ error, locale, onOpenChange, onSave, open, pending, profile }: {
  error: unknown
  locale: WorkspaceLocale
  onOpenChange: (open: boolean) => void
  onSave: (identity: SyntheticPatientIdentity) => void
  open: boolean
  pending: boolean
  profile: SyntheticPatientProfileDetail
}) {
  const messages = copy[locale]
  const [identity, setIdentity] = useState(profile.identity)
  const update = (next: Partial<SyntheticPatientIdentity>) => setIdentity(current => ({ ...current, ...next }))
  return <Sheet onOpenChange={onOpenChange} open={open}><SheetContent className="w-full sm:max-w-lg" side="right"><SheetHeader><SheetTitle>{messages.editProfile}</SheetTitle><SheetDescription>{profile.identity.displayName}</SheetDescription></SheetHeader><FieldGroup className="overflow-y-auto px-4"><Field><FieldLabel htmlFor="profile-name">{messages.name}</FieldLabel><Input id="profile-name" onChange={event => update({ displayName: event.target.value })} value={identity.displayName} /></Field><Field><FieldLabel htmlFor="profile-mrn">{messages.mrn}</FieldLabel><Input id="profile-mrn" onChange={event => update({ mrn: event.target.value })} value={identity.mrn} /></Field><Field><FieldLabel htmlFor="profile-national-id">{messages.nationalId}</FieldLabel><Input id="profile-national-id" onChange={event => update({ nationalId: event.target.value })} value={identity.nationalId} /></Field><Field><FieldLabel htmlFor="profile-phone">{messages.phone}</FieldLabel><Input id="profile-phone" onChange={event => update({ phone: event.target.value })} value={identity.phone} /></Field><Field><FieldLabel htmlFor="profile-email">{messages.email}</FieldLabel><Input id="profile-email" onChange={event => update({ email: event.target.value })} type="email" value={identity.email} /></Field><Field><FieldLabel htmlFor="profile-address">{messages.address}</FieldLabel><Input id="profile-address" onChange={event => update({ address: event.target.value })} value={identity.address} /></Field><Field><FieldLabel htmlFor="profile-insurance">{messages.insurance}</FieldLabel><Input id="profile-insurance" onChange={event => update({ insuranceDisplay: event.target.value })} value={identity.insuranceDisplay} /></Field></FieldGroup>{error === null ? null : <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{messages.saveFailed}</AlertTitle><AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription></Alert>}<SheetFooter><Button disabled={pending} onClick={() => onSave(identity)}><SparklesIcon data-icon="inline-start" />{messages.save}</Button></SheetFooter></SheetContent></Sheet>
}

export function SyntheticPatientLibrary({ locale }: { locale: WorkspaceLocale }): React.JSX.Element {
  const messages = copy[locale]
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const [selectedProfileId, setSelectedProfileId] = useState<string>()
  const [generationOpen, setGenerationOpen] = useState(false)
  const [generationJobId, setGenerationJobId] = useState<string>()
  const [editOpen, setEditOpen] = useState(false)
  const profiles = useQuery({ queryFn: ({ signal }) => getSyntheticPatientProfiles(signal, page, submittedSearch), queryKey: [...profileListKey, page, submittedSearch] })
  const scenario = useQuery({ queryFn: ({ signal }) => getCurrentScenario(signal), queryKey: currentScenarioKey })
  const referenceDate = scenario.data?.virtualTime.slice(0, 10) ?? profiles.data?.items[0]?.createdAt.slice(0, 10) ?? '1970-01-01'
  const effectiveProfileId = selectedProfileId ?? profiles.data?.items[0]?.profileId
  const profile = useQuery({ enabled: effectiveProfileId !== undefined, queryFn: ({ signal }) => effectiveProfileId === undefined ? Promise.reject(new Error('No profile selected')) : getSyntheticPatientProfile(effectiveProfileId, signal), queryKey: ['synthetic-patient-profile', effectiveProfileId ?? 'none'] })
  const providers = useQuery({ queryFn: ({ signal }) => getScenarioProviders(signal), queryKey: providerKey })
  const generate = useMutation({ mutationFn: (request: ScenarioGenerationRequest) => enqueueScenarioGenerationJob(request, newIdempotencyKey()), onSuccess: response => { setGenerationJobId(response.data.jobId); setGenerationOpen(false) } })
  const generationJob = useQuery({ enabled: generationJobId !== undefined, queryFn: ({ signal }) => generationJobId === undefined ? Promise.reject(new Error('No generation job')) : getScenarioGenerationJob(generationJobId, signal), queryKey: ['scenario-generation-job', generationJobId ?? 'none'], refetchInterval: query => ['queued', 'running'].includes(query.state.data?.status ?? '') ? 1_000 : false })
  useEffect(() => {
    if (generationJob.data?.status !== 'succeeded') return
    const firstProfileId = generationJob.data.profileIds[0]
    if (firstProfileId !== undefined) setSelectedProfileId(firstProfileId)
    void queryClient.invalidateQueries({ queryKey: profileListKey })
  }, [generationJob.data?.profileIds, generationJob.data?.status, queryClient])
  const updateProfile = useMutation({ mutationFn: (identity: SyntheticPatientIdentity) => { if (profile.data === undefined) throw new Error('No profile selected'); return updateSyntheticPatientProfile({ expectedRevision: profile.data.revision, identity, profileId: profile.data.profileId }, newIdempotencyKey()) }, onSuccess: async response => { queryClient.setQueryData(['synthetic-patient-profile', response.data.profileId], response.data); await queryClient.invalidateQueries({ queryKey: profileListKey }); setEditOpen(false) } })
  const mutationError = generate.error ?? updateProfile.error
  return <section aria-labelledby="synthetic-patient-library-heading" className="flex min-w-0 flex-col gap-4"><div className="flex flex-wrap items-start gap-3"><div><h2 className="text-base font-semibold" id="synthetic-patient-library-heading">{messages.libraryTitle}</h2><p className="mt-1 text-sm text-muted-foreground">{messages.libraryDescription}</p></div><Button className="ml-auto" onClick={() => setGenerationOpen(true)}><PlusIcon data-icon="inline-start" />{messages.generate}</Button></div>{mutationError !== null ? <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{messages.generationFailed}</AlertTitle><AlertDescription>{mutationError instanceof Error ? mutationError.message : String(mutationError)}</AlertDescription></Alert> : null}{generationJob.data !== undefined ? <Alert variant={generationJob.data.status === 'failed' ? 'destructive' : 'default'}><SparklesIcon /><AlertTitle>{generationJob.data.status === 'succeeded' ? messages.generationSucceeded : generationJob.data.status === 'failed' ? messages.generationFailed : messages.queued}</AlertTitle><AlertDescription>{generationJob.data.error?.message}</AlertDescription></Alert> : null}{profiles.isError ? <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{messages.generationFailed}</AlertTitle></Alert> : null}{profiles.isPending ? <Skeleton className="h-[680px] w-full" /> : null}{profiles.data?.items.length === 0 ? <Empty className="min-h-96 border"><EmptyHeader><EmptyMedia variant="icon"><DatabaseIcon /></EmptyMedia><EmptyTitle>{messages.emptyTitle}</EmptyTitle><EmptyDescription>{messages.emptyDescription}</EmptyDescription></EmptyHeader><EmptyContent><Button onClick={() => setGenerationOpen(true)}><PlusIcon data-icon="inline-start" />{messages.generate}</Button></EmptyContent></Empty> : null}{profiles.data !== undefined && profiles.data.items.length > 0 ? <div className="grid min-h-[680px] border lg:grid-cols-[280px_minmax(0,1fr)]"><aside className="flex min-h-0 flex-col border-r bg-background"><form className="flex items-center gap-2 border-b p-3" onSubmit={event => { event.preventDefault(); setPage(1); setSubmittedSearch(search.trim()) }}><InputGroup className="min-w-0 flex-1"><InputGroupAddon><SearchIcon /></InputGroupAddon><InputGroupInput aria-label={messages.search} onChange={event => setSearch(event.target.value)} placeholder={`${messages.name}、${messages.mrn}、${messages.batch}`} value={search} /></InputGroup><Button aria-label={messages.search} size="icon" title={messages.search} type="submit" variant="outline"><ListFilterIcon /></Button></form><div className="border-b px-3 py-2 text-xs text-muted-foreground">{profiles.data.total} 名患者</div><div className="min-h-0 flex-1 overflow-y-auto p-2">{profiles.data.items.map(item => <button className={cn('flex w-full items-center gap-3 border-b px-2 py-2 text-left', item.profileId === effectiveProfileId && 'border border-primary/30 bg-primary/5')} key={item.profileId} onClick={() => setSelectedProfileId(item.profileId)} type="button"><ProfileAvatar name={item.name} profileId={item.profileId} /><span className="min-w-0 flex-1"><span className="flex items-center gap-2"><strong className="truncate text-sm">{item.name}</strong><span className="text-xs text-muted-foreground">{age(item.birthDate, referenceDate)} 岁</span></span><span className="mt-1 block truncate text-xs text-muted-foreground">{item.mrn}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{item.batchName} · {item.providerId === 'synthea' ? 'Synthea' : 'ClinMesh'}</span></span></button>)}</div>{profiles.data.total > profiles.data.pageSize ? <div className="flex justify-between border-t p-2"><Button disabled={page === 1} onClick={() => setPage(current => current - 1)} size="sm" variant="ghost">{messages.previous}</Button><Button disabled={page * profiles.data.pageSize >= profiles.data.total} onClick={() => setPage(current => current + 1)} size="sm" variant="ghost">{messages.next}</Button></div> : null}</aside>{profile.isPending ? <Skeleton className="h-full w-full" /> : null}{profile.isError ? <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{messages.generationFailed}</AlertTitle></Alert> : null}{profile.data !== undefined ? <ProfileDetails locale={locale} onEdit={() => setEditOpen(true)} profile={profile.data} referenceDate={referenceDate} /> : null}</div> : null}<GenerationSheet error={generate.error} locale={locale} onGenerate={request => generate.mutate(request)} onOpenChange={setGenerationOpen} open={generationOpen} pending={generate.isPending} providers={providers.data?.items ?? []} />{profile.data !== undefined ? <EditProfileSheet error={updateProfile.error} key={`${profile.data.profileId}:${profile.data.revision}`} locale={locale} onOpenChange={setEditOpen} onSave={identity => updateProfile.mutate(identity)} open={editOpen} pending={updateProfile.isPending} profile={profile.data} /> : null}</section>
}
