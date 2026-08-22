import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Avatar, AvatarFallback } from '@clinmesh/ui/components/avatar'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@clinmesh/ui/components/sheet'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
} from '@clinmesh/ui/components/sidebar'
import { Toaster, toast } from '@clinmesh/ui/components/toast'
import { TooltipProvider } from '@clinmesh/ui/components/tooltip'
import {
  BotIcon,
  CheckIcon,
  ClipboardListIcon,
  FileClockIcon,
  HospitalIcon,
  ShieldCheckIcon,
  StethoscopeIcon,
  TriangleAlertIcon,
  UserRoundIcon,
} from 'lucide-react'
import { useState } from 'react'

import { AssistantPrototypeSwitcher } from './assistant-prototype-switcher'
import { AssistantSurface, InlineAssistant } from './assistant-surface'
import { DoctorWorkspace } from './doctor-workspace'
import {
  applyAssistantProposal,
  assistantVariantFromUrl,
  createInitialPatients,
  createReviewSnapshot,
  navigateFromAssistant,
  proposalKindForPrompt,
  publishSyntheticResults,
  requestAssistantProposal,
  resetPatient,
  selectClinicalPage,
  simulateRemoteUpdate,
  submitReviewedDraft,
  updateDraftField,
  type AssistantVariant,
  type ClinicalPage,
  type DraftField,
  type PatientCase,
  type ReviewSnapshot,
} from './model'

// Three DSH/HIS assistant layouts, switchable with ?variant=, on the throwaway /prototype/his-assistant route.

interface AssistantHandlers {
  onApplyProposal: () => void
  onNavigate: (page: ClinicalPage, prompt: string) => void
  onOpenReview: () => void
  onPrompt: (prompt: string) => void
  onResetPatient: () => void
  onSimulateRemoteUpdate: () => void
}

export default function HisAssistantPrototype(): React.JSX.Element {
  const [variant, setVariant] = useState<AssistantVariant>(assistantVariantFromUrl)
  const [patients, setPatients] = useState<PatientCase[]>(createInitialPatients)
  const [activePatientId, setActivePatientId] = useState(() => createInitialPatients()[0]!.id)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [review, setReview] = useState<ReviewSnapshot | null>(null)
  const patient = patients.find((candidate) => candidate.id === activePatientId) ?? patients[0]!

  const replacePatient = (nextPatient: PatientCase) => {
    setPatients((current) => current.map((candidate) => candidate.id === nextPatient.id ? nextPatient : candidate))
  }

  const promptAssistant = (prompt: string) => {
    const kind = proposalKindForPrompt(patient, prompt)
    replacePatient(requestAssistantProposal(patient, kind, prompt))
    toast.add({
      title: `已创建 ${patient.turns.length + 1} 号 Turn`,
      description: kind === 'revisit' ? '已生成诊断与处方草稿建议。' : '已生成首诊与检验草稿建议。',
      type: 'info',
    })
  }

  const applyProposal = () => {
    const result = applyAssistantProposal(patient)
    replacePatient(result.patient)
    if (result.outcome === 'applied') {
      toast.add({ title: '结构化动作已写入草稿', description: `当前 draft r${result.patient.draftRevision}，尚未签发。`, type: 'success' })
    }
    if (result.outcome === 'stale') {
      toast.add({ title: '已拒绝过期建议', description: '患者数据、草稿或页面上下文已变化，请重新生成。', type: 'warning' })
    }
  }

  const navigateByAssistant = (page: ClinicalPage, prompt: string) => {
    replacePatient(navigateFromAssistant(patient, page, prompt))
    toast.add({ title: '已执行 typed navigate', description: `已打开 doctor.${page}，未使用 DOM selector。`, type: 'info' })
  }

  const openReview = () => {
    const snapshot = createReviewSnapshot(patient)
    if (snapshot === null) {
      toast.add({ title: '当前没有可预览草稿', description: '先应用一份助手建议或手工创建临床草稿。', type: 'warning' })
      return
    }
    setReview(snapshot)
  }

  const remoteUpdate = () => {
    const next = simulateRemoteUpdate(patient)
    replacePatient(next)
    toast.add({ title: '患者数据已由他处更新', description: `page v${patient.pageRevision} → v${next.pageRevision}，旧建议将被拒绝。`, type: 'warning' })
  }

  const resetActivePatient = () => {
    const next = resetPatient(patient.id)
    replacePatient(next)
    setReview(null)
    toast.add({ title: `已重置${patient.name}`, description: `${next.threadId} 已回到初始 Session 状态。`, type: 'success' })
  }

  const handlers: AssistantHandlers = {
    onApplyProposal: applyProposal,
    onNavigate: navigateByAssistant,
    onOpenReview: openReview,
    onPrompt: promptAssistant,
    onResetPatient: resetActivePatient,
    onSimulateRemoteUpdate: remoteUpdate,
  }

  const changeVariant = (nextVariant: AssistantVariant) => {
    setVariant(nextVariant)
    setAssistantOpen(false)
    const url = new URL(window.location.href)
    url.searchParams.set('variant', nextVariant)
    window.history.replaceState(null, '', url)
  }

  const selectPatient = (patientId: string) => {
    const next = patients.find((candidate) => candidate.id === patientId)
    if (next === undefined) return
    setActivePatientId(patientId)
    setReview(null)
    toast.add({ title: `已切换至${next.name}`, description: `${next.threadId} ↔ ${next.sessionId}`, type: 'info' })
  }

  return (
    <TooltipProvider>
      <Toaster>
        <SidebarProvider defaultOpen={false}>
          <PrototypeSidebar />
          <SidebarInset className="h-svh min-w-0 overflow-hidden">
            <PrototypeHeader patient={patient} />
            <PrototypeLayout
              activePatientId={activePatientId}
              handlers={handlers}
              patient={patient}
              patients={patients}
              variant={variant}
              onChangeNote={(field, value) => replacePatient(updateDraftField(patient, field, value))}
              onChangePage={(page) => replacePatient(selectClinicalPage(patient, page))}
              onOpenAssistant={() => setAssistantOpen(true)}
              onOpenReview={openReview}
              onPublishResults={() => {
                const next = publishSyntheticResults(patient)
                replacePatient(next)
                if (next.resultsReady) toast.add({ title: '合成检验结果已发布', description: `HIS page v${next.pageRevision}，当前切换到结果页。`, type: 'success' })
              }}
              onSelectPatient={selectPatient}
            />
            {import.meta.env.DEV ? <div aria-hidden="true" className="h-16 shrink-0" /> : null}
          </SidebarInset>

          {variant === 'A' || variant === 'B' ? (
            <AssistantSheet handlers={handlers} open={assistantOpen} patient={patient} onOpenChange={setAssistantOpen} />
          ) : null}
          <ReviewSheet
            patient={patients.find((candidate) => candidate.id === review?.patientId) ?? patient}
            review={review}
            onClose={() => setReview(null)}
            onRemoteUpdate={() => {
              const reviewPatient = patients.find((candidate) => candidate.id === review?.patientId)
              if (reviewPatient !== undefined) replacePatient(simulateRemoteUpdate(reviewPatient))
            }}
            onSubmit={() => {
              if (review === null) return
              const reviewPatient = patients.find((candidate) => candidate.id === review.patientId)
              if (reviewPatient === undefined) return
              const result = submitReviewedDraft(reviewPatient, review)
              replacePatient(result.patient)
              if (result.outcome === 'submitted') {
                setReview(null)
                toast.add({ title: '医生已确认并签发', description: `HIS page v${result.patient.pageRevision}；DSH 仅接收提交结果。`, type: 'success' })
              }
              if (result.outcome === 'stale') {
                toast.add({ title: '提交预览已过期', description: '依赖版本发生变化，必须重新生成预览。', type: 'warning' })
              }
            }}
          />

          {import.meta.env.DEV ? <AssistantPrototypeSwitcher current={variant} onChange={changeVariant} /> : null}
        </SidebarProvider>
      </Toaster>
    </TooltipProvider>
  )
}

function PrototypeLayout({
  activePatientId,
  handlers,
  patient,
  patients,
  variant,
  onChangeNote,
  onChangePage,
  onOpenAssistant,
  onOpenReview,
  onPublishResults,
  onSelectPatient,
}: {
  activePatientId: string
  handlers: AssistantHandlers
  patient: PatientCase
  patients: readonly PatientCase[]
  variant: AssistantVariant
  onChangeNote: (field: DraftField | 'chiefComplaint', value: string) => void
  onChangePage: (page: ClinicalPage) => void
  onOpenAssistant: () => void
  onOpenReview: () => void
  onPublishResults: () => void
  onSelectPatient: (patientId: string) => void
}): React.JSX.Element {
  const assistantButton = (
    <Button className={variant === 'A' ? 'xl:hidden' : undefined} onClick={onOpenAssistant} variant="outline">
      <BotIcon data-icon="inline-start" />打开助手
    </Button>
  )

  const inlineAssistant = variant === 'C' ? <InlineAssistant patient={patient} {...handlers} /> : undefined
  const workspace = (
    <>
      <DoctorWorkspace
        activePatientId={activePatientId}
        assistantAction={variant === 'C' ? undefined : assistantButton}
        inlineAssistant={inlineAssistant}
        patient={patient}
        patients={patients}
        onChangeNote={onChangeNote}
        onChangePage={onChangePage}
        onOpenReview={onOpenReview}
        onPublishResults={onPublishResults}
        onSelectPatient={onSelectPatient}
      />
      <PrototypeStateInspector patient={patient} variant={variant} />
      <div aria-hidden="true" className="h-20" />
    </>
  )

  if (variant === 'A') {
    return (
      <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(0,1fr)_25rem]">
        <main className="min-w-0 overflow-y-auto">{workspace}</main>
        <aside className="hidden min-h-0 border-l xl:block"><AssistantSurface patient={patient} {...handlers} /></aside>
      </div>
    )
  }

  return <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{workspace}</main>
}

function AssistantSheet({
  handlers,
  open,
  patient,
  onOpenChange,
}: {
  handlers: AssistantHandlers
  open: boolean
  patient: PatientCase
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="gap-0 data-[side=right]:w-[calc(100%-1.5rem)] sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2"><BotIcon />临床助手</SheetTitle>
          <SheetDescription>{patient.name} · {patient.sessionId} · {patient.contextBindingId}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1"><AssistantSurface patient={patient} showHeader={false} {...handlers} /></div>
      </SheetContent>
    </Sheet>
  )
}

function ReviewSheet({
  patient,
  review,
  onClose,
  onRemoteUpdate,
  onSubmit,
}: {
  patient: PatientCase
  review: ReviewSnapshot | null
  onClose: () => void
  onRemoteUpdate: () => void
  onSubmit: () => void
}): React.JSX.Element {
  const stale = review !== null && (
    review.expectedPageRevision !== patient.pageRevision ||
    review.expectedDraftRevision !== patient.draftRevision
  )

  return (
    <Sheet onOpenChange={(open) => { if (!open) onClose() }} open={review !== null}>
      <SheetContent className="data-[side=right]:w-[calc(100%-1.5rem)] sm:max-w-lg">
        <SheetHeader className="border-b">
          <SheetTitle>医生人工预览</SheetTitle>
          <SheetDescription>{patient.name} · {review?.kind === 'treatment' ? '诊断与处方签发' : '检验请求签发'}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          <div className="grid grid-cols-3 gap-3 border-b py-4 text-xs">
            <ReviewValue label="Plan hash" value={review?.planHash ?? '—'} />
            <ReviewValue label="Expected page" value={`v${review?.expectedPageRevision ?? '—'}`} />
            <ReviewValue label="Expected draft" value={`r${review?.expectedDraftRevision ?? '—'}`} />
          </div>

          {stale ? (
            <Alert className="mt-4" variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>预览依赖已经变化</AlertTitle>
              <AlertDescription>当前 page v{patient.pageRevision} / draft r{patient.draftRevision}，本次提交会被版本守卫拒绝。</AlertDescription>
            </Alert>
          ) : null}

          <section className="py-4">
            <h3 className="text-sm font-semibold">将提交的临床事实</h3>
            <dl className="mt-3 flex flex-col gap-3 text-sm">
              {review?.kind === 'treatment' ? (
                <>
                  <ReviewEffect label="门诊诊断" value={patient.diagnosis} />
                  <ReviewEffect label="药品请求" value={patient.medication} />
                </>
              ) : (
                patient.labOrders.map((order) => <ReviewEffect key={order} label="检验请求" value={order} />)
              )}
            </dl>
          </section>

          <Alert>
            <ShieldCheckIcon />
            <AlertTitle>提交主体：周芮 / 内科门诊医师</AlertTitle>
            <AlertDescription>DSH 已完成草稿与预览；最终 Command 由当前医生确认。</AlertDescription>
          </Alert>
        </div>
        <SheetFooter className="border-t">
          <Button disabled={stale || review === null} onClick={onSubmit}><CheckIcon data-icon="inline-start" />医生确认并签发</Button>
          <Button onClick={onRemoteUpdate} variant="outline"><FileClockIcon data-icon="inline-start" />模拟提交前版本变化</Button>
          {stale ? <Button onClick={onClose} variant="ghost">关闭并重新预览</Button> : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function PrototypeStateInspector({ patient, variant }: { patient: PatientCase; variant: AssistantVariant }): React.JSX.Element {
  const turn = patient.turns.at(-1)
  const step = turn?.steps.at(-1)
  return (
    <section aria-labelledby="assistant-state-title" className="border-y bg-muted/30 px-4 py-4 lg:px-5">
      <div className="flex flex-col gap-4 2xl:flex-row 2xl:items-start 2xl:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><h2 id="assistant-state-title" className="text-sm font-semibold">当前原型状态</h2><Badge variant="outline">方案 {variant}</Badge></div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-4 xl:grid-cols-6">
            <StateValue label="Workspace / Epoch" value="yujiang-general / E-014" />
            <StateValue label="Actor" value="周芮 / outpatient-doctor" />
            <StateValue label="Patient / Encounter" value={`${patient.id} / ${patient.encounterId}`} />
            <StateValue label="Page snapshot" value={`doctor.${patient.page} · v${patient.pageRevision} · c${patient.contextRevision}`} />
            <StateValue label="Draft" value={`r${patient.draftRevision} · lab:${patient.labOrderStatus} · tx:${patient.treatmentStatus}`} />
            <StateValue label="Context binding" value={patient.contextBindingId} />
            <StateValue label="AssistantThread" value={patient.threadId} />
            <StateValue label="DSH Session" value={patient.sessionId} />
            <StateValue label="Turn / Step" value={`${turn?.id ?? '—'} / ${step?.id ?? '—'}`} />
            <StateValue label="Proposal" value={patient.proposal === null ? 'none' : `${patient.proposal.kind}:${patient.proposal.status}`} />
            <StateValue label="Assistant grant" value="read + navigate + draft + preview" />
            <StateValue label="Final submit" value="human only" />
          </dl>
        </div>
        <div className="w-full 2xl:w-80">
          <p className="text-xs font-medium text-muted-foreground">最近 Step</p>
          <div className="mt-2 flex items-start gap-2 text-xs">
            {step?.status === 'rejected' ? <TriangleAlertIcon className="size-4 text-destructive" /> : <CheckIcon className="size-4 text-success" />}
            <span><strong className="font-medium">{step?.label ?? '等待医生发起 Turn'}</strong><span className="mt-1 block leading-5 text-muted-foreground">{step?.detail ?? 'Session 已绑定当前患者与 Encounter。'}</span></span>
          </div>
        </div>
      </div>
    </section>
  )
}

function PrototypeHeader({ patient }: { patient: PatientCase }): React.JSX.Element {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-3 sm:px-4">
      <SidebarTrigger aria-label="切换导航栏" title="切换导航栏" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">内科门诊医生工作台</p>
        <p className="hidden truncate text-xs text-muted-foreground sm:block">榆江市中心医院 · 2026-08-21 09:28 · {patient.encounterId}</p>
      </div>
      <Badge className="hidden sm:inline-flex" variant="success"><BotIcon />DSH 已连接</Badge>
      <Badge className="hidden md:inline-flex" variant="warning">原型 · 合成数据</Badge>
      <Avatar className="size-8"><AvatarFallback>周</AvatarFallback></Avatar>
    </header>
  )
}

function PrototypeSidebar(): React.JSX.Element {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => window.location.assign('/prototype/his-flow?page=flow&variant=B')} size="lg" tooltip="ClinMesh 全院原型">
              <div className="flex aspect-square size-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground"><HospitalIcon /></div>
              <div className="grid flex-1 text-left text-sm leading-tight"><span className="truncate font-semibold">ClinMesh</span><span className="truncate text-xs">助手融合原型</span></div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarSeparator />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>门诊工作台</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem><SidebarMenuButton isActive tooltip="医生工作台"><StethoscopeIcon /><span>医生工作台</span></SidebarMenuButton></SidebarMenuItem>
              <SidebarMenuItem><SidebarMenuButton onClick={() => window.location.assign('/prototype/his-flow?page=flow&variant=B')} tooltip="全院流程"><ClipboardListIcon /><span>全院流程</span></SidebarMenuButton></SidebarMenuItem>
              <SidebarMenuItem><SidebarMenuButton onClick={() => window.location.assign('/prototype/his-flow?page=roles&variant=B')} tooltip="岗位选择"><UserRoundIcon /><span>岗位选择</span></SidebarMenuButton></SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" tooltip="周芮 · 内科门诊医师">
              <Avatar className="size-8"><AvatarFallback>周</AvatarFallback></Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight"><span className="truncate font-medium">周芮</span><span className="truncate text-xs text-muted-foreground">内科门诊医师</span></div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

function ReviewValue({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="min-w-0"><span className="block text-muted-foreground">{label}</span><strong className="mt-1 block truncate font-mono" title={value}>{value}</strong></div>
}

function ReviewEffect({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="border-l-2 border-l-primary pl-3"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 font-medium">{value}</dd></div>
}

function StateValue({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="mt-0.5 truncate font-mono font-medium" title={value}>{value}</dd></div>
}
