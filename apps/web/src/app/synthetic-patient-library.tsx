import { createAvatar } from '@dicebear/core'
import * as lorelei from '@dicebear/lorelei'
import type {
  ScenarioGenerationRequest,
  ScenarioProviderCapabilities,
  SyntheticPatientIdentity,
  SyntheticPatientMappingCatalog,
  SyntheticPatientMappingInput,
  SyntheticPatientProfile,
  SyntheticPatientProfileSummary,
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { cn } from '@clinmesh/ui/lib/utils'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CircleAlertIcon,
  DatabaseIcon,
  FileTextIcon,
  ListFilterIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  ShieldAlertIcon,
  SparklesIcon,
  StethoscopeIcon,
  UserPlusIcon,
  UsersIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  enqueueScenarioGenerationJob,
  getCurrentScenario,
  getRegistrationCatalog,
  getScenarioGenerationJob,
  getScenarioProviders,
  getSyntheticPatientProfile,
  getSyntheticPatientMappingCatalog,
  getSyntheticPatientProfiles,
  newIdempotencyKey,
  startSyntheticPatientVisits,
  updateSyntheticPatientMappings,
  updateSyntheticPatientProfile,
} from './api-client.ts'
import { scenarioModuleOptions } from './scenario-module-options.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

const profileListKey = ['synthetic-patient-profiles'] as const
const providerKey = ['scenario-providers'] as const
const registrationCatalogKey = ['registration-catalog'] as const
const mappingCatalogKey = ['synthetic-patient-mapping-catalog'] as const
const currentScenarioKey = ['scenario-current'] as const
const avatarCache = new Map<string, string>()

function mappingOptionValue(item: { catalogItemId: string; version: number }): string {
  return JSON.stringify([item.catalogItemId, item.version])
}

function mappingInputTarget(
  catalog: SyntheticPatientMappingCatalog,
  targetValue: string,
): SyntheticPatientMappingInput['target'] {
  const item = catalog.items.find(candidate => mappingOptionValue(candidate) === targetValue)
  return item === undefined
    ? null
    : { catalogItemId: item.catalogItemId, version: item.version }
}

const copy = {
  'en-US': {
    activeVisit: 'Active visit',
    address: 'Address',
    advancedParameters: 'Reproduction parameters',
    allergy: 'Allergies',
    batch: 'Generation batch',
    batchQueue: 'Start selected visits',
    builtinDescription: 'Fixed cases for functional testing',
    cancel: 'Cancel',
    chronicConditions: 'Chronic conditions',
    clinicalSeed: 'Clinical seed',
    contact: 'Contact',
    department: 'Department',
    editProfile: 'Edit profile',
    editMappings: 'Edit mappings',
    email: 'Email',
    emptyDescription: 'Generate up to ten synthetic patients with Synthea or the ClinMesh template.',
    emptyTitle: 'No synthetic patients yet',
    generate: 'Generate patients',
    generating: 'Generating patients',
    generationFailed: 'Patient generation failed',
    generationSucceeded: 'Patients saved to the library',
    healthRecord: 'Health record',
    history: 'Visit history',
    historyYears: 'History start',
    identity: 'Identity',
    insurance: 'Simulated insurance',
    laboratory: 'Investigations',
    libraryDescription: 'Persistent synthetic profiles and source history. Batches remain provenance only.',
    libraryTitle: 'Synthetic patient library',
    mappingComplete: 'Mapped',
    mappingWarnings: 'mapping warnings',
    medications: 'Medications',
    mrn: 'MRN',
    name: 'Display name',
    nationalId: 'Synthetic national ID',
    noAllergy: 'No recorded allergy',
    noConditions: 'No recorded chronic condition',
    noMedication: 'No recorded medication',
    patientCount: 'Patient count',
    phone: 'Phone',
    populationSeed: 'Population seed',
    provider: 'Generator',
    queued: 'Generation request accepted',
    rawSource: 'Raw source',
    save: 'Save profile',
    search: 'Search patients',
    sourceData: 'Source data',
    sourceReadOnly: 'Source history is read-only. Profile edits apply only to future materialization.',
    startVisit: 'Start outpatient visit',
    syntheaDescription: 'Longitudinal FHIR R4 history; recommended',
    visitType: 'Visit type',
  },
  'zh-CN': {
    activeVisit: '已有活动就诊',
    address: '地址',
    advancedParameters: '高级复现参数',
    allergy: '过敏史',
    batch: '生成批次',
    batchQueue: '批量发起就诊',
    builtinDescription: '固定病例，仅用于功能测试',
    cancel: '取消',
    chronicConditions: '慢病与既往问题',
    clinicalSeed: '临床 seed',
    contact: '联系方式',
    department: '就诊科室',
    editProfile: '编辑档案',
    editMappings: '处理映射',
    email: '电子邮箱',
    emptyDescription: '使用 Synthea 或 ClinMesh 快速模板生成患者，每批最多 10 人。',
    emptyTitle: '还没有合成患者',
    generate: '生成患者',
    generating: '正在生成患者',
    generationFailed: '患者生成失败',
    generationSucceeded: '患者已保存到患者库',
    healthRecord: '健康档案',
    history: '就诊历史',
    historyYears: '历史起始日期',
    identity: '身份信息',
    insurance: '模拟保险',
    laboratory: '检查检验',
    libraryDescription: '患者档案和来源病史持久保存；批次只作为生成来源。',
    libraryTitle: '合成患者库',
    mappingComplete: '映射完整',
    mappingWarnings: '项待映射',
    medications: '用药',
    mrn: 'MRN',
    name: '展示姓名',
    nationalId: '模拟身份证',
    noAllergy: '无过敏记录',
    noConditions: '无明确慢病记录',
    noMedication: '无历史用药记录',
    patientCount: '患者人数',
    phone: '手机号码',
    populationSeed: '人口 seed',
    provider: '生成器',
    queued: '生成请求已提交',
    rawSource: '原始来源',
    save: '保存档案',
    search: '搜索患者',
    sourceData: '来源数据',
    sourceReadOnly: '来源病史只读；档案修改仅用于之后的业务物化。',
    startVisit: '发起门诊就诊',
    syntheaDescription: '纵向 FHIR R4 病史，默认推荐',
    visitType: '门诊类型',
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

function ProfileAvatar({ className, name, profileId }: { className?: string; name: string; profileId: string }) {
  return <Avatar className={cn('size-10 bg-muted', className)}><AvatarImage alt={`${name}的合成头像`} src={avatarUri(profileId)} /><AvatarFallback>{name.slice(0, 1)}</AvatarFallback></Avatar>
}

function age(birthDate: string, referenceDate: string): number {
  const [birthYear, birthMonth, birthDay] = birthDate.split('-').map(Number)
  const [year, month, day] = referenceDate.split('-').map(Number)
  if (
    birthYear === undefined || birthMonth === undefined || birthDay === undefined
    || year === undefined || month === undefined || day === undefined
  ) return 0
  return year - birthYear - (month < birthMonth || (month === birthMonth && day < birthDay) ? 1 : 0)
}

function profileConditions(profile: SyntheticPatientProfile): string[] {
  return [...new Set(profile.patient.fhirHistory.flatMap(resource => (
    resource.resourceType === 'Condition' && resource.clinicalStatus === 'active'
      ? [resource.code.display]
      : []
  )))]
}

function profileAllergies(profile: SyntheticPatientProfile): string[] {
  return profile.patient.fhirHistory.flatMap(resource => (
    resource.resourceType === 'AllergyIntolerance' ? [resource.code.display] : []
  ))
}

function profileMedications(profile: SyntheticPatientProfile): string[] {
  return [...new Set(profile.patient.fhirHistory.flatMap(resource => (
    resource.resourceType === 'MedicationRequest' ? [resource.medication.display] : []
  )))]
}

function ProfileTimeline({ profile }: { profile: SyntheticPatientProfile }) {
  const history = profile.patient.longitudinalHistory.toSorted((left, right) => (
    right.occurredAt.localeCompare(left.occurredAt)
  ))
  return <div className="flex flex-col gap-0">{history.map(item => <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 pb-4" key={item.id}><div className="pt-1 text-xs text-muted-foreground">{item.occurredAt.slice(0, 10)}</div><div className="relative border-l pl-4"><span className="absolute -left-1.5 top-1.5 size-3 rounded-full border-2 border-primary bg-background" /><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{item.kind}</Badge><strong className="text-sm">{item.display}</strong></div><p className="mt-1 text-xs text-muted-foreground">{item.sourceResourceType} · {item.status}</p></div></div>)}</div>
}

function ProfileDetails({
  activeVisit,
  locale,
  onEdit,
  onEditMappings,
  onStartVisit,
  profile,
  referenceDate,
}: {
  activeVisit: boolean
  locale: WorkspaceLocale
  onEdit: () => void
  onEditMappings: () => void
  onStartVisit: () => void
  profile: SyntheticPatientProfile
  referenceDate: string
}) {
  const messages = copy[locale]
  const conditions = profileConditions(profile)
  const allergies = profileAllergies(profile)
  const medications = profileMedications(profile)
  const displayPhone = /^1\d{10}$/.test(profile.identity.phone)
    ? `${profile.identity.phone.slice(0, 3)}****${profile.identity.phone.slice(-4)}`
    : profile.identity.phone
  return <div className="min-w-0 bg-background"><header className="border-b px-4 py-4"><div className="flex flex-wrap items-start gap-4"><ProfileAvatar className="size-16" name={profile.identity.displayName} profileId={profile.profileId} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-xl font-semibold">{profile.identity.displayName}</h3><Badge variant="outline">{profile.patient.gender}</Badge><span className="text-sm text-muted-foreground">{age(profile.patient.birthDate, referenceDate)} 岁（{profile.patient.birthDate}）</span>{activeVisit ? <Badge variant="info">{messages.activeVisit}</Badge> : <Badge variant="success">{messages.startVisit}</Badge>}</div><div className="mt-3 grid gap-x-6 gap-y-1 text-sm text-muted-foreground sm:grid-cols-2 xl:grid-cols-4"><span>{messages.mrn}：<strong className="font-medium text-foreground">{profile.identity.mrn}</strong></span><span>{messages.phone}：<strong className="font-medium text-foreground">{displayPhone}</strong></span><span>{messages.provider}：<strong className="font-medium text-foreground">{profile.source.providerId === 'synthea' ? 'Synthea' : 'ClinMesh'}</strong></span><span>{messages.batch}：<strong className="font-medium text-foreground">{profile.source.batchName}</strong></span></div></div><div className="flex w-full gap-2 sm:w-auto"><Button aria-label={messages.editMappings} onClick={onEditMappings} size="icon" title={messages.editMappings} variant="outline"><FileTextIcon /></Button><Button aria-label={messages.editProfile} onClick={onEdit} size="icon" title={messages.editProfile} variant="outline"><PencilIcon /></Button><Button className="flex-1 sm:flex-none" disabled={activeVisit} onClick={onStartVisit}><UserPlusIcon data-icon="inline-start" />{messages.startVisit}</Button></div></div></header><div className="grid border-b sm:grid-cols-2 xl:grid-cols-4"><section className="min-w-0 border-b p-4 sm:border-r xl:border-b-0"><h4 className="text-sm font-semibold">{messages.identity}</h4><p className="mt-2 text-sm">{profile.identity.nationalId}</p><p className="mt-1 text-xs text-muted-foreground">{profile.patient.gender} · {profile.patient.birthDate}</p></section><section className="min-w-0 border-b p-4 sm:border-r xl:border-b-0"><h4 className="text-sm font-semibold">{messages.address}</h4><p className="mt-2 break-words text-sm">{profile.identity.address}</p></section><section className="min-w-0 border-b p-4 sm:border-r xl:border-b-0"><h4 className="text-sm font-semibold">{messages.contact}</h4><p className="mt-2 text-sm">{displayPhone}</p><p className="mt-1 break-words text-xs text-muted-foreground">{profile.identity.email}</p></section><section className="min-w-0 p-4"><h4 className="text-sm font-semibold">{messages.insurance}</h4><p className="mt-2 text-sm">{profile.identity.insuranceDisplay}</p><p className="mt-1 text-xs text-muted-foreground">仅档案展示，不参与结算</p></section></div><div className="grid min-h-[430px] xl:grid-cols-[minmax(0,1fr)_300px]"><main className="min-w-0 p-4"><Tabs defaultValue="record"><TabsList className="max-w-full overflow-x-auto" variant="line"><TabsTrigger value="record">{messages.healthRecord}</TabsTrigger><TabsTrigger value="history">{messages.history}</TabsTrigger><TabsTrigger value="laboratory">{messages.laboratory}</TabsTrigger><TabsTrigger value="medications">{messages.medications}</TabsTrigger><TabsTrigger value="source">{messages.sourceData}</TabsTrigger></TabsList><TabsContent className="pt-4" value="record"><div className="grid gap-4 md:grid-cols-3"><section className="border-b pb-3"><h4 className="text-sm font-semibold">{messages.chronicConditions}</h4><p className="mt-2 text-sm">{conditions.join('、') || messages.noConditions}</p></section><section className="border-b pb-3"><h4 className="text-sm font-semibold">{messages.allergy}</h4><p className="mt-2 text-sm">{allergies.join('、') || messages.noAllergy}</p></section><section className="border-b pb-3"><h4 className="text-sm font-semibold">本次建议主题</h4><p className="mt-2 text-sm">{profile.patient.encounter.openingStatement}</p></section></div></TabsContent><TabsContent className="pt-4" value="history"><ProfileTimeline profile={profile} /></TabsContent><TabsContent className="pt-4" value="laboratory"><Table><TableHeader><TableRow><TableHead>项目</TableHead><TableHead>结果</TableHead><TableHead>来源</TableHead></TableRow></TableHeader><TableBody>{profile.patient.investigations.map(item => <TableRow key={item.id}><TableCell>{item.name}</TableCell><TableCell>{item.report}</TableCell><TableCell>{item.sourceLevel}</TableCell></TableRow>)}</TableBody></Table></TabsContent><TabsContent className="pt-4" value="medications">{medications.length === 0 ? <p className="text-sm text-muted-foreground">{messages.noMedication}</p> : <ul className="flex flex-col gap-2">{medications.map(item => <li className="border-b py-2 text-sm" key={item}>{item}</li>)}</ul>}</TabsContent><TabsContent className="pt-4" value="source"><Alert><FileTextIcon aria-hidden="true" /><AlertTitle>{messages.sourceReadOnly}</AlertTitle><AlertDescription>{profile.source.format} · {profile.source.mappingVersion} · SHA-256 {profile.source.hash}</AlertDescription></Alert>{profile.source.raw === null ? null : <details className="mt-4"><summary className="cursor-pointer text-sm font-medium">{messages.rawSource}</summary><pre className="mt-2 max-h-96 overflow-auto border bg-muted/20 p-3 text-xs">{JSON.stringify(profile.source.raw, null, 2)}</pre></details>}</TabsContent></Tabs></main><aside className="flex flex-col gap-3 border-l bg-muted/15 p-3"><section className="border-b bg-background p-3"><div className="flex items-center justify-between"><h4 className="text-sm font-semibold">重要提示</h4><ShieldAlertIcon className="size-4 text-warning" /></div><div className="mt-3 flex flex-wrap gap-1.5">{allergies.map(item => <Badge key={item} variant="destructive">{item}</Badge>)}{conditions.map(item => <Badge key={item} variant="warning">{item}</Badge>)}</div></section><section className="border-b bg-background p-3"><h4 className="text-sm font-semibold">{messages.medications}</h4><p className="mt-3 text-sm">{medications.join('、') || messages.noMedication}</p></section><section className="bg-background p-3"><h4 className="text-sm font-semibold">来源质量</h4><p className="mt-2 text-sm">{profile.source.providerId === 'synthea' ? 'Synthea 完整病史' : 'ClinMesh 快速模板'}</p><p className="mt-1 text-xs text-muted-foreground">Profile revision {profile.revision}</p><Badge className="mt-2" variant={profile.patient.longitudinalHistory.some(item => item.mappedCode === null) ? 'warning' : 'success'}>{profile.patient.longitudinalHistory.filter(item => item.mappedCode === null).length === 0 ? messages.mappingComplete : `${profile.patient.longitudinalHistory.filter(item => item.mappedCode === null).length} ${messages.mappingWarnings}`}</Badge></section></aside></div></div>
}

function GenerationSheet({
  error,
  locale,
  onGenerate,
  onOpenChange,
  open,
  pending,
  providers,
}: {
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
    modules: ['fever'],
    name: locale === 'zh-CN' ? '合成患者批次' : 'Synthetic patient batch',
    population: { age: { maximum: 80, minimum: 18 }, count: 6, gender: 'any' },
    providerId: 'synthea',
    seeds: { clinical: 7331, population: 4242 },
    timeRange: { end: '2026-08-01', start: '2011-08-01' },
    timeZone: 'Asia/Shanghai',
  })
  const provider = providers.find(item => item.providerId === request.providerId)
  const updatePopulation = (next: Partial<ScenarioGenerationRequest['population']>) => setRequest(current => ({ ...current, population: { ...current.population, ...next } }))
  const updateModule = (
    module: ScenarioGenerationRequest['modules'][number],
    checked: boolean,
  ) => setRequest(current => ({
    ...current,
    modules: checked
      ? [...new Set([...current.modules, module])]
      : current.modules.length === 1
        ? current.modules
        : current.modules.filter(item => item !== module),
  }))
  return <Sheet onOpenChange={onOpenChange} open={open}><SheetContent className="w-full sm:max-w-lg" side="right"><SheetHeader><SheetTitle>{messages.generate}</SheetTitle><SheetDescription>{messages.emptyDescription}</SheetDescription></SheetHeader><div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4"><Field><FieldLabel id="patient-provider-label">{messages.provider}</FieldLabel><ToggleGroup aria-labelledby="patient-provider-label" className="w-full items-stretch" onValueChange={values => { const next = values[0] as ScenarioGenerationRequest['providerId'] | undefined; if (next !== undefined) setRequest(current => ({ ...current, providerId: next })) }} spacing={2} value={[request.providerId]} variant="outline"><ToggleGroupItem className="h-auto min-w-0 flex-1 justify-start whitespace-normal p-3 text-left" disabled={providers.find(item => item.providerId === 'synthea')?.available !== true} value="synthea"><span><strong className="block text-sm">Synthea</strong><span className="mt-1 block text-xs text-muted-foreground">{messages.syntheaDescription}</span></span></ToggleGroupItem><ToggleGroupItem className="h-auto min-w-0 flex-1 justify-start whitespace-normal p-3 text-left" value="builtin"><span><strong className="block text-sm">ClinMesh</strong><span className="mt-1 block text-xs text-muted-foreground">{messages.builtinDescription}</span></span></ToggleGroupItem></ToggleGroup></Field><FieldGroup className="grid gap-3 sm:grid-cols-2"><Field><FieldLabel htmlFor="patient-batch-name">{messages.batch}</FieldLabel><Input id="patient-batch-name" maxLength={120} onChange={event => setRequest(current => ({ ...current, name: event.target.value }))} value={request.name} /></Field><Field><FieldLabel htmlFor="patient-count">{messages.patientCount}</FieldLabel><Input id="patient-count" max={10} min={1} onChange={event => updatePopulation({ count: Number(event.target.value) })} type="number" value={request.population.count} /></Field><Field><FieldLabel htmlFor="patient-min-age">最小年龄</FieldLabel><Input id="patient-min-age" max={120} min={0} onChange={event => updatePopulation({ age: { ...request.population.age, minimum: Number(event.target.value) } })} type="number" value={request.population.age.minimum} /></Field><Field><FieldLabel htmlFor="patient-max-age">最大年龄</FieldLabel><Input id="patient-max-age" max={120} min={0} onChange={event => updatePopulation({ age: { ...request.population.age, maximum: Number(event.target.value) } })} type="number" value={request.population.age.maximum} /></Field></FieldGroup><Field><FieldLabel htmlFor="patient-gender">性别</FieldLabel><Select items={genderItems} onValueChange={value => { if (value !== null) updatePopulation({ gender: value }) }} value={request.population.gender}><SelectTrigger className="w-full" id="patient-gender"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{genderItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><FieldSet><FieldLegend variant="label">纵向健康模块</FieldLegend><FieldGroup className="gap-3">{scenarioModuleOptions.map(option => <Field key={option.value} orientation="horizontal"><Checkbox checked={request.modules.includes(option.value)} id={`patient-${option.value}`} onCheckedChange={checked => updateModule(option.value, checked === true)} /><FieldLabel htmlFor={`patient-${option.value}`}>{option.label[locale]}</FieldLabel></Field>)}</FieldGroup></FieldSet><details className="border-t pt-4"><summary className="cursor-pointer text-sm font-medium">{messages.advancedParameters}</summary><FieldGroup className="mt-3 grid gap-3 sm:grid-cols-2"><Field><FieldLabel htmlFor="patient-population-seed">{messages.populationSeed}</FieldLabel><Input id="patient-population-seed" min={0} onChange={event => setRequest(current => ({ ...current, seeds: { ...current.seeds, population: Number(event.target.value) } }))} type="number" value={request.seeds.population} /></Field><Field><FieldLabel htmlFor="patient-clinical-seed">{messages.clinicalSeed}</FieldLabel><Input id="patient-clinical-seed" min={0} onChange={event => setRequest(current => ({ ...current, seeds: { ...current.seeds, clinical: Number(event.target.value) } }))} type="number" value={request.seeds.clinical} /></Field><Field className="sm:col-span-2"><FieldLabel htmlFor="patient-history-start">{messages.historyYears}</FieldLabel><Input id="patient-history-start" onChange={event => setRequest(current => ({ ...current, timeRange: { ...current.timeRange, start: event.target.value } }))} type="date" value={request.timeRange.start} /></Field></FieldGroup></details>{provider?.available === false ? <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{provider.unavailableReason}</AlertTitle></Alert> : null}{error === null ? null : <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{locale === "zh-CN" ? "生成失败" : "Generation failed"}</AlertTitle><AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription></Alert>}</div><SheetFooter><Button disabled={pending || provider?.available !== true} onClick={() => onGenerate(request)}><SparklesIcon data-icon="inline-start" />{pending ? messages.generating : messages.generate}</Button></SheetFooter></SheetContent></Sheet>
}

function EditProfileSheet({ error, locale, onOpenChange, onSave, open, pending, profile }: { error: unknown; locale: WorkspaceLocale; onOpenChange: (open: boolean) => void; onSave: (identity: SyntheticPatientIdentity) => void; open: boolean; pending: boolean; profile: SyntheticPatientProfile }) {
  const messages = copy[locale]
  const [identity, setIdentity] = useState(profile.identity)
  const update = (next: Partial<SyntheticPatientIdentity>) => setIdentity(current => ({ ...current, ...next }))
  return <Sheet onOpenChange={onOpenChange} open={open}><SheetContent className="w-full sm:max-w-lg" side="right"><SheetHeader><SheetTitle>{messages.editProfile}</SheetTitle><SheetDescription>{messages.sourceReadOnly}</SheetDescription></SheetHeader><FieldGroup className="overflow-y-auto px-4"><Field><FieldLabel htmlFor="profile-name">{messages.name}</FieldLabel><Input id="profile-name" onChange={event => update({ displayName: event.target.value })} value={identity.displayName} /></Field><Field><FieldLabel htmlFor="profile-mrn">{messages.mrn}</FieldLabel><Input id="profile-mrn" onChange={event => update({ mrn: event.target.value })} value={identity.mrn} /></Field><Field><FieldLabel htmlFor="profile-national-id">{messages.nationalId}</FieldLabel><Input id="profile-national-id" onChange={event => update({ nationalId: event.target.value })} value={identity.nationalId} /></Field><Field><FieldLabel htmlFor="profile-phone">{messages.phone}</FieldLabel><Input id="profile-phone" onChange={event => update({ phone: event.target.value })} value={identity.phone} /></Field><Field><FieldLabel htmlFor="profile-email">{messages.email}</FieldLabel><Input id="profile-email" onChange={event => update({ email: event.target.value })} type="email" value={identity.email} /></Field><Field><FieldLabel htmlFor="profile-address">{messages.address}</FieldLabel><Input id="profile-address" onChange={event => update({ address: event.target.value })} value={identity.address} /></Field><Field><FieldLabel htmlFor="profile-insurance">{messages.insurance}</FieldLabel><Input id="profile-insurance" onChange={event => update({ insuranceDisplay: event.target.value })} value={identity.insuranceDisplay} /></Field></FieldGroup>{error === null ? null : <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{locale === "zh-CN" ? "保存失败" : "Save failed"}</AlertTitle><AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription></Alert>}<SheetFooter><Button disabled={pending} onClick={() => onSave(identity)}><SparklesIcon data-icon="inline-start" />{messages.save}</Button></SheetFooter></SheetContent></Sheet>
}

function MappingSheet({
  catalog,
  catalogPending,
  error,
  locale,
  onOpenChange,
  onSave,
  open,
  pending,
  profile,
}: {
  catalog: SyntheticPatientMappingCatalog
  catalogPending: boolean
  error: unknown
  locale: WorkspaceLocale
  onOpenChange: (open: boolean) => void
  onSave: (mappings: SyntheticPatientMappingInput[]) => void
  open: boolean
  pending: boolean
  profile: SyntheticPatientProfile
}) {
  const messages = copy[locale]
  const persistedMappingBySourceId = new Map(profile.mappings.map(mapping => (
    [mapping.sourceResourceId, mapping] as const
  )))
  const [mappings, setMappings] = useState(() => profile.patient.longitudinalHistory.map((event) => {
    const persistedMapping = persistedMappingBySourceId.get(event.sourceResourceId)
    return {
      display: event.display,
      sourceResourceId: event.sourceResourceId,
      sourceResourceType: event.sourceResourceType,
      targetValue: persistedMapping === undefined
        ? '__unmapped__'
        : mappingOptionValue(persistedMapping.target),
    }
  }))
  const unmappedValue = '__unmapped__'
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-full sm:max-w-lg" side="right">
        <SheetHeader>
          <SheetTitle>{messages.editMappings}</SheetTitle>
          <SheetDescription>{messages.sourceReadOnly}</SheetDescription>
        </SheetHeader>
        <FieldGroup className="overflow-y-auto px-4">
          {catalogPending ? <Skeleton className="h-24 w-full" /> : mappings.map((mapping, index) => {
            const supported = catalog.items.filter(item => (
              item.sourceResourceType === mapping.sourceResourceType
            ))
            const items = [{
              label: locale === 'zh-CN' ? '未映射' : 'Unmapped',
              value: unmappedValue,
            }, ...supported.map(item => ({
              label: `${locale === 'zh-CN' ? item.nameZh : item.nameEn} · ${item.code}`,
              value: mappingOptionValue(item),
            }))]
            const value = supported.some(item => mappingOptionValue(item) === mapping.targetValue)
              ? mapping.targetValue
              : unmappedValue
            return (
            <Field key={`${mapping.sourceResourceType}:${mapping.sourceResourceId}`}>
              <FieldLabel htmlFor={`profile-mapping-${index}`}>
                {mapping.display} · {mapping.sourceResourceType}/{mapping.sourceResourceId}
              </FieldLabel>
              <Select
                items={items}
                id={`profile-mapping-${index}`}
                onValueChange={next => setMappings(current => current.map((item, itemIndex) => (
                  itemIndex === index
                    ? { ...item, targetValue: next ?? unmappedValue }
                    : item
                )))}
                value={value}
              >
                <SelectTrigger className="w-full" id={`profile-mapping-${index}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {items.map(item => (
                      <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            )
          })}
        </FieldGroup>
        {error === null ? null : (
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>{locale === 'zh-CN' ? '保存映射失败' : 'Failed to save mappings'}</AlertTitle>
            <AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription>
          </Alert>
        )}
        <SheetFooter>
          <Button disabled={catalogPending || pending || mappings.length === 0} onClick={() => onSave(mappings.map(mapping => ({
            sourceResourceId: mapping.sourceResourceId,
            target: mappingInputTarget(catalog, mapping.targetValue),
          })))}>
            <FileTextIcon data-icon="inline-start" />
            {locale === 'zh-CN' ? '保存映射' : 'Save mappings'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function VisitSheet({ error, locale, onOpenChange, onStart, open, pending, profiles }: { error: unknown; locale: WorkspaceLocale; onOpenChange: (open: boolean) => void; onStart: (input: { departmentId: string; locationId: string; visitDate: string; visitTypeId: string }) => void; open: boolean; pending: boolean; profiles: readonly SyntheticPatientProfileSummary[] }) {
  const messages = copy[locale]
  const catalog = useQuery({ enabled: open, queryFn: ({ signal }) => getRegistrationCatalog(signal), queryKey: registrationCatalogKey })
  const [departmentId, setDepartmentId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [visitTypeId, setVisitTypeId] = useState('')
  const effectiveDepartment = departmentId || catalog.data?.departments[0]?.id || ''
  const effectiveLocation = locationId || catalog.data?.locations[0]?.id || ''
  const effectiveVisitType = visitTypeId || catalog.data?.visitTypes[0]?.id || ''
  return <Sheet onOpenChange={onOpenChange} open={open}><SheetContent className="w-full sm:max-w-md" side="right"><SheetHeader><SheetTitle>{profiles.length > 1 ? messages.batchQueue : messages.startVisit}</SheetTitle><SheetDescription>{profiles.length} 名患者提交后进入分诊队列。</SheetDescription></SheetHeader><div className="flex flex-col gap-4 overflow-y-auto px-4"><div className="flex flex-wrap gap-2">{profiles.map(profile => <ProfileAvatar className="size-8" key={profile.profileId} name={profile.name} profileId={profile.profileId} />)}</div>{catalog.isPending ? <Skeleton className="h-24 w-full" /> : null}{catalog.isError ? <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{messages.generationFailed}</AlertTitle></Alert> : null}{catalog.data !== undefined ? <FieldGroup><Field><FieldLabel htmlFor="visit-department">{messages.department}</FieldLabel><Select items={catalog.data.departments.map(item => ({ label: locale === 'zh-CN' ? item.nameZh : item.nameEn, value: item.id }))} onValueChange={value => setDepartmentId(value ?? '')} value={effectiveDepartment}><SelectTrigger className="w-full" id="visit-department"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{catalog.data.departments.map(item => <SelectItem key={item.id} value={item.id}>{locale === 'zh-CN' ? item.nameZh : item.nameEn}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><Field><FieldLabel htmlFor="visit-location">就诊地点</FieldLabel><Select items={catalog.data.locations.map(item => ({ label: locale === 'zh-CN' ? item.nameZh : item.nameEn, value: item.id }))} onValueChange={value => setLocationId(value ?? '')} value={effectiveLocation}><SelectTrigger className="w-full" id="visit-location"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{catalog.data.locations.map(item => <SelectItem key={item.id} value={item.id}>{locale === 'zh-CN' ? item.nameZh : item.nameEn}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><Field><FieldLabel htmlFor="visit-type">{messages.visitType}</FieldLabel><Select items={catalog.data.visitTypes.map(item => ({ label: locale === 'zh-CN' ? item.nameZh : item.nameEn, value: item.id }))} onValueChange={value => setVisitTypeId(value ?? '')} value={effectiveVisitType}><SelectTrigger className="w-full" id="visit-type"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{catalog.data.visitTypes.map(item => <SelectItem key={item.id} value={item.id}>{locale === 'zh-CN' ? item.nameZh : item.nameEn}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><Alert><StethoscopeIcon aria-hidden="true" /><AlertTitle>提交后进入分诊队列</AlertTitle><AlertDescription>同一患者存在活动 Encounter 时整批请求会回滚。</AlertDescription></Alert></FieldGroup> : null}{error === null ? null : <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{locale === "zh-CN" ? "发起就诊失败" : "Failed to start visit"}</AlertTitle><AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription></Alert>}</div><SheetFooter><Button disabled={pending || effectiveDepartment === '' || effectiveLocation === '' || effectiveVisitType === ''} onClick={() => onStart({ departmentId: effectiveDepartment, locationId: effectiveLocation, visitDate: catalog.data?.virtualDate ?? '', visitTypeId: effectiveVisitType })}><UserPlusIcon data-icon="inline-start" />{profiles.length > 1 ? `${messages.batchQueue} ${profiles.length}` : messages.startVisit}</Button></SheetFooter></SheetContent></Sheet>
}

export function SyntheticPatientLibrary({ locale }: { locale: WorkspaceLocale }): React.JSX.Element {
  const messages = copy[locale]
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const [selectedProfileId, setSelectedProfileId] = useState<string>()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [generationOpen, setGenerationOpen] = useState(false)
  const [generationJobId, setGenerationJobId] = useState<string>()
  const [editOpen, setEditOpen] = useState(false)
  const [mappingOpen, setMappingOpen] = useState(false)
  const [visitOpen, setVisitOpen] = useState(false)
  const profiles = useQuery({ queryFn: ({ signal }) => getSyntheticPatientProfiles(signal, page, submittedSearch), queryKey: [...profileListKey, page, submittedSearch] })
  const scenario = useQuery({ queryFn: ({ signal }) => getCurrentScenario(signal), queryKey: currentScenarioKey })
  const referenceDate = scenario.data?.virtualTime.slice(0, 10)
    ?? profiles.data?.items[0]?.createdAt.slice(0, 10)
    ?? '1970-01-01'
  const effectiveProfileId = selectedProfileId ?? profiles.data?.items[0]?.profileId
  const profile = useQuery({ enabled: effectiveProfileId !== undefined, queryFn: ({ signal }) => effectiveProfileId === undefined ? Promise.reject(new Error('No profile selected')) : getSyntheticPatientProfile(effectiveProfileId, signal), queryKey: ['synthetic-patient-profile', effectiveProfileId ?? 'none'] })
  const providers = useQuery({ queryFn: ({ signal }) => getScenarioProviders(signal), queryKey: providerKey })
  const mappingCatalog = useQuery({ enabled: mappingOpen, queryFn: ({ signal }) => getSyntheticPatientMappingCatalog(signal), queryKey: mappingCatalogKey })
  const generate = useMutation({ mutationFn: (request: ScenarioGenerationRequest) => enqueueScenarioGenerationJob(request, newIdempotencyKey()), onSuccess: response => { setGenerationJobId(response.data.jobId); setGenerationOpen(false) } })
  const generationJob = useQuery({ enabled: generationJobId !== undefined, queryFn: ({ signal }) => generationJobId === undefined ? Promise.reject(new Error('No generation job')) : getScenarioGenerationJob(generationJobId, signal), queryKey: ['scenario-generation-job', generationJobId ?? 'none'], refetchInterval: query => ['queued', 'running'].includes(query.state.data?.status ?? '') ? 1_000 : false })
  useEffect(() => { if (generationJob.data?.status === 'succeeded') void queryClient.invalidateQueries({ queryKey: profileListKey }) }, [generationJob.data?.status, queryClient])
  const updateProfile = useMutation({ mutationFn: (identity: SyntheticPatientIdentity) => { if (profile.data === undefined) throw new Error('No profile selected'); return updateSyntheticPatientProfile({ expectedRevision: profile.data.revision, identity, profileId: profile.data.profileId }, newIdempotencyKey()) }, onSuccess: async response => { queryClient.setQueryData(['synthetic-patient-profile', response.data.profileId], response.data); await queryClient.invalidateQueries({ queryKey: profileListKey }); setEditOpen(false) } })
  const updateMappings = useMutation({ mutationFn: (mappings: SyntheticPatientMappingInput[]) => { if (profile.data === undefined) throw new Error('No profile selected'); return updateSyntheticPatientMappings({ expectedRevision: profile.data.revision, mappings, profileId: profile.data.profileId }, newIdempotencyKey()) }, onSuccess: async response => { queryClient.setQueryData(['synthetic-patient-profile', response.data.profileId], response.data); await queryClient.invalidateQueries({ queryKey: profileListKey }); setMappingOpen(false) } })
  const selectedProfiles = profiles.data?.items.filter(item => selectedIds.has(item.profileId) && !item.activeVisit) ?? []
  const activeSummary = profiles.data?.items.find(item => item.profileId === effectiveProfileId)
  const visitProfiles = selectedProfiles.length > 0 ? selectedProfiles : activeSummary === undefined ? [] : [activeSummary]
  const startVisits = useMutation({ mutationFn: (catalog: { departmentId: string; locationId: string; visitDate: string; visitTypeId: string }) => startSyntheticPatientVisits({ ...catalog, patients: visitProfiles.map(item => ({ expectedRevision: item.revision, profileId: item.profileId })) }, newIdempotencyKey()), onSuccess: async () => { setSelectedIds(new Set()); await queryClient.invalidateQueries({ queryKey: profileListKey }); setVisitOpen(false) } })
  const mutationError = generate.error ?? updateProfile.error ?? updateMappings.error ?? startVisits.error
  const toggleSelected = (profileId: string) => setSelectedIds(current => { const next = new Set(current); if (next.has(profileId)) next.delete(profileId); else next.add(profileId); return next })
  return <section aria-labelledby="synthetic-patient-library-heading" className="flex min-w-0 flex-col gap-4"><div className="flex flex-wrap items-start gap-3"><div><h2 className="text-base font-semibold" id="synthetic-patient-library-heading">{messages.libraryTitle}</h2><p className="mt-1 text-sm text-muted-foreground">{messages.libraryDescription}</p></div><div className="ml-auto flex gap-2"><Button disabled={selectedProfiles.length === 0} onClick={() => setVisitOpen(true)} variant="outline"><UsersIcon data-icon="inline-start" />{messages.batchQueue}{selectedProfiles.length > 0 ? ` ${selectedProfiles.length}` : ''}</Button><Button onClick={() => setGenerationOpen(true)}><PlusIcon data-icon="inline-start" />{messages.generate}</Button></div></div>{mutationError !== null ? <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{locale === "zh-CN" ? "操作失败" : "Operation failed"}</AlertTitle><AlertDescription>{mutationError instanceof Error ? mutationError.message : String(mutationError)}</AlertDescription></Alert> : null}{generationJob.data !== undefined ? <Alert variant={generationJob.data.status === 'failed' ? 'destructive' : 'default'}><SparklesIcon aria-hidden="true" /><AlertTitle>{generationJob.data.status === 'succeeded' ? messages.generationSucceeded : generationJob.data.status === 'failed' ? messages.generationFailed : messages.queued}</AlertTitle><AlertDescription>{generationJob.data.error?.message}</AlertDescription></Alert> : null}{profiles.isError ? <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{messages.generationFailed}</AlertTitle><AlertDescription>{profiles.error instanceof Error ? profiles.error.message : ''}</AlertDescription></Alert> : null}{profiles.isPending ? <Skeleton className="h-[680px] w-full" /> : null}{profiles.data?.items.length === 0 ? <Empty className="min-h-96 border"><EmptyHeader><EmptyMedia variant="icon"><DatabaseIcon /></EmptyMedia><EmptyTitle>{messages.emptyTitle}</EmptyTitle><EmptyDescription>{messages.emptyDescription}</EmptyDescription></EmptyHeader><EmptyContent><Button onClick={() => setGenerationOpen(true)}><PlusIcon data-icon="inline-start" />{messages.generate}</Button></EmptyContent></Empty> : null}{profiles.data !== undefined && profiles.data.items.length > 0 ? <div className="grid min-h-[680px] border lg:grid-cols-[280px_minmax(0,1fr)]"><aside className="flex min-h-0 flex-col border-r bg-background"><form className="flex items-center gap-2 border-b p-3" onSubmit={event => { event.preventDefault(); setPage(1); setSubmittedSearch(search.trim()) }}><InputGroup className="min-w-0 flex-1"><InputGroupAddon><SearchIcon aria-hidden="true" /></InputGroupAddon><InputGroupInput aria-label={messages.search} onChange={event => setSearch(event.target.value)} placeholder={`${messages.name}、${messages.mrn}、${messages.batch}`} value={search} /></InputGroup><Button aria-label={messages.search} size="icon" title={messages.search} type="submit" variant="outline"><ListFilterIcon /></Button></form><div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground"><span>{profiles.data.total} 名患者</span><span>每批最多 10 人</span></div><div className="min-h-0 flex-1 overflow-y-auto p-2">{profiles.data.items.map(item => <div className={cn('flex items-center gap-2 border-b px-2 py-2', item.profileId === effectiveProfileId && 'rounded-md border border-primary/30 bg-primary/5')} key={item.profileId}><Checkbox aria-label={`选择 ${item.name}`} checked={selectedIds.has(item.profileId)} disabled={item.activeVisit} onCheckedChange={() => toggleSelected(item.profileId)} /><button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setSelectedProfileId(item.profileId)} type="button"><ProfileAvatar name={item.name} profileId={item.profileId} /><span className="min-w-0 flex-1"><span className="flex items-center gap-2"><strong className="truncate text-sm">{item.name}</strong><span className="text-xs text-muted-foreground">{age(item.birthDate, referenceDate)} 岁</span></span><span className="mt-1 block truncate text-xs text-muted-foreground">{item.mrn}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{item.batchName} · {item.providerId === 'synthea' ? 'Synthea' : 'ClinMesh'}</span></span>{item.activeVisit ? <Badge variant="info">{messages.activeVisit}</Badge> : null}</button></div>)}</div>{profiles.data.total > profiles.data.pageSize ? <div className="flex justify-between border-t p-2"><Button disabled={page === 1} onClick={() => setPage(current => Math.max(1, current - 1))} size="sm" variant="ghost">上一页</Button><Button disabled={page * profiles.data.pageSize >= profiles.data.total} onClick={() => setPage(current => current + 1)} size="sm" variant="ghost">下一页</Button></div> : null}</aside>{profile.isPending ? <Skeleton className="h-full w-full" /> : null}{profile.isError ? <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{messages.generationFailed}</AlertTitle></Alert> : null}{profile.data !== undefined ? <ProfileDetails activeVisit={activeSummary?.activeVisit ?? false} locale={locale} onEdit={() => setEditOpen(true)} onEditMappings={() => setMappingOpen(true)} onStartVisit={() => { setSelectedIds(new Set()); setVisitOpen(true) }} profile={profile.data} referenceDate={referenceDate} /> : null}</div> : null}<GenerationSheet error={generate.error} locale={locale} onGenerate={request => generate.mutate(request)} onOpenChange={setGenerationOpen} open={generationOpen} pending={generate.isPending} providers={providers.data?.items ?? []} />{profile.data !== undefined ? <EditProfileSheet error={updateProfile.error} key={`${profile.data.profileId}:${profile.data.revision}`} locale={locale} onOpenChange={setEditOpen} onSave={identity => updateProfile.mutate(identity)} open={editOpen} pending={updateProfile.isPending} profile={profile.data} /> : null}{profile.data !== undefined ? <MappingSheet catalog={mappingCatalog.data ?? { items: [] }} catalogPending={mappingCatalog.isPending} error={updateMappings.error ?? mappingCatalog.error} key={`mapping:${profile.data.profileId}:${profile.data.revision}`} locale={locale} onOpenChange={setMappingOpen} onSave={mappings => updateMappings.mutate(mappings)} open={mappingOpen} pending={updateMappings.isPending} profile={profile.data} /> : null}<VisitSheet error={startVisits.error} locale={locale} onOpenChange={setVisitOpen} onStart={catalog => startVisits.mutate(catalog)} open={visitOpen} pending={startVisits.isPending} profiles={visitProfiles} /></section>
}
