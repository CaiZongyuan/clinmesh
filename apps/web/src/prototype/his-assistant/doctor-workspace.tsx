import { Avatar, AvatarFallback } from '@clinmesh/ui/components/avatar'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Separator } from '@clinmesh/ui/components/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { cn } from '@clinmesh/ui/lib/utils'
import {
  ActivityIcon,
  BeakerIcon,
  CheckIcon,
  ClipboardCheckIcon,
  FilePenLineIcon,
  FileTextIcon,
  FlaskConicalIcon,
  PillIcon,
  ShieldCheckIcon,
  StethoscopeIcon,
  TestTubeDiagonalIcon,
  TriangleAlertIcon,
  UserRoundIcon,
} from 'lucide-react'

import { pageLabel, type ClinicalPage, type DraftField, type PatientCase } from './model'

interface DoctorWorkspaceProps {
  activePatientId: string
  assistantAction?: React.ReactNode
  inlineAssistant?: React.ReactNode
  patient: PatientCase
  patients: readonly PatientCase[]
  onChangePage: (page: ClinicalPage) => void
  onChangeNote: (field: DraftField | 'chiefComplaint', value: string) => void
  onOpenReview: () => void
  onPublishResults: () => void
  onSelectPatient: (patientId: string) => void
}

export function DoctorWorkspace({
  activePatientId,
  assistantAction,
  inlineAssistant,
  patient,
  patients,
  onChangePage,
  onChangeNote,
  onOpenReview,
  onPublishResults,
  onSelectPatient,
}: DoctorWorkspaceProps): React.JSX.Element {
  const canReview = patient.labOrderStatus === 'draft' || patient.treatmentStatus === 'draft'

  return (
    <div className="min-w-0">
      <QueueStrip activePatientId={activePatientId} patients={patients} onSelectPatient={onSelectPatient} />
      <PatientHeader assistantAction={assistantAction} patient={patient} />
      {inlineAssistant}

      <div className="grid min-h-[36rem] xl:grid-cols-[17rem_minmax(0,1fr)]">
        <EncounterRail patient={patient} />
        <div className="min-w-0 p-4 lg:p-5">
          <Tabs
            onValueChange={(value) => {
              if (isClinicalPage(value)) onChangePage(value)
            }}
            value={patient.page}
          >
            <div className="flex flex-col gap-3 border-b pb-3 sm:flex-row sm:items-center sm:justify-between">
              <TabsList variant="line">
                <TabsTrigger value="record"><FileTextIcon />病历</TabsTrigger>
                <TabsTrigger value="orders"><BeakerIcon />医嘱</TabsTrigger>
                <TabsTrigger value="results"><ActivityIcon />结果</TabsTrigger>
              </TabsList>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">page v{patient.pageRevision}</Badge>
                <Badge variant="outline">draft r{patient.draftRevision}</Badge>
                <span>{pageLabel(patient.page)}</span>
              </div>
            </div>

            <TabsContent className="pt-5" value="record">
              <ClinicalRecord patient={patient} onChangeNote={onChangeNote} />
            </TabsContent>
            <TabsContent className="pt-5" value="orders">
              <Orders patient={patient} />
            </TabsContent>
            <TabsContent className="pt-5" value="results">
              <Results patient={patient} onPublishResults={onPublishResults} />
            </TabsContent>
          </Tabs>

          <div className="mt-5 flex flex-col gap-3 border-t bg-muted/20 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium">当前诊疗决策</p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{decisionLabel(patient)}</p>
            </div>
            <Button disabled={!canReview} onClick={onOpenReview}>
              <ShieldCheckIcon data-icon="inline-start" />人工预览与签发
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function QueueStrip({
  activePatientId,
  patients,
  onSelectPatient,
}: Pick<DoctorWorkspaceProps, 'activePatientId' | 'patients' | 'onSelectPatient'>): React.JSX.Element {
  return (
    <nav aria-label="今日候诊患者" className="border-b bg-muted/20">
      <div className="flex min-w-max items-stretch gap-0 overflow-x-auto px-3">
        <div className="flex items-center pr-3 text-xs font-medium text-muted-foreground">今日候诊 · {patients.length}</div>
        {patients.map((candidate) => (
          <button
            key={candidate.id}
            aria-current={candidate.id === activePatientId ? 'page' : undefined}
            className={cn(
              'min-w-40 border-b-2 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              candidate.id === activePatientId ? 'border-b-primary bg-background' : 'border-b-transparent hover:bg-muted',
            )}
            onClick={() => onSelectPatient(candidate.id)}
            type="button"
          >
            <span className="flex items-center justify-between gap-2 text-sm"><strong className="font-medium">{candidate.name}</strong><span className="text-xs text-muted-foreground">{candidate.waitMinutes} 分钟</span></span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{candidate.statusLabel} · {candidate.queueNumber}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}

function PatientHeader({ assistantAction, patient }: { assistantAction?: React.ReactNode; patient: PatientCase }): React.JSX.Element {
  return (
    <header className="border-b px-4 py-4 lg:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar className="size-10"><AvatarFallback><UserRoundIcon /></AvatarFallback></Avatar>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold">{patient.name}</h1>
              <span className="text-sm text-muted-foreground">{patient.gender}，{patient.age} 岁</span>
              <Badge variant="outline">合成患者</Badge>
              <Badge variant={patient.treatmentStatus === 'signed' ? 'success' : patient.resultsReady ? 'warning' : 'info'}>{patient.statusLabel}</Badge>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">{patient.id} · {patient.encounterId} · {patient.note.chiefComplaint}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {patient.allergy === '否认药物过敏' ? null : <Badge variant="destructive"><TriangleAlertIcon />{patient.allergy}</Badge>}
          {assistantAction}
        </div>
      </div>
    </header>
  )
}

function EncounterRail({ patient }: { patient: PatientCase }): React.JSX.Element {
  const firstVisitDone = patient.labOrderStatus !== 'none'
  const labDone = patient.resultsReady
  const treatmentDone = patient.treatmentStatus === 'signed'

  return (
    <aside className="border-b bg-muted/20 p-4 xl:border-r xl:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">本次就诊</h2>
        <Badge variant="secondary">内科 3 诊室</Badge>
      </div>
      <ol className="mt-5 flex flex-col gap-0">
        <TimelineItem copy={patient.vitalSigns} done label="分诊完成" time="09:19" />
        <TimelineItem copy="问诊、查体与检验申请" done={firstVisitDone} label="首诊" time="09:28" />
        <TimelineItem copy={labDone ? '检验报告已审核发布' : '等待检验结果'} done={labDone} label="检验" time="09:41" />
        <TimelineItem copy={treatmentDone ? patient.candidateDiagnosis : '待确认诊断与处方'} done={treatmentDone} label="复诊处置" time="09:48" />
      </ol>
      <Separator className="my-4" />
      <dl className="flex flex-col gap-3 text-xs">
        <Fact label="生命体征" value={patient.vitalSigns} />
        <Fact label="过敏史" value={patient.allergy} />
        <Fact label="Thread" value={patient.threadId} mono />
        <Fact label="DSH Session" value={patient.sessionId} mono />
      </dl>
    </aside>
  )
}

function ClinicalRecord({
  patient,
  onChangeNote,
}: Pick<DoctorWorkspaceProps, 'patient' | 'onChangeNote'>): React.JSX.Element {
  return (
    <FieldGroup>
      <div className="grid gap-5 lg:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`chief-${patient.id}`}>主诉</FieldLabel>
          <Textarea id={`chief-${patient.id}`} onChange={(event) => onChangeNote('chiefComplaint', event.currentTarget.value)} value={patient.note.chiefComplaint} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`history-${patient.id}`}>现病史</FieldLabel>
          <Textarea id={`history-${patient.id}`} onChange={(event) => onChangeNote('history', event.currentTarget.value)} rows={4} value={patient.note.history} />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor={`exam-${patient.id}`}>查体</FieldLabel>
        <Textarea id={`exam-${patient.id}`} onChange={(event) => onChangeNote('physicalExam', event.currentTarget.value)} value={patient.note.physicalExam} />
      </Field>
      <Field>
        <FieldLabel htmlFor={`assessment-${patient.id}`}>初步判断 / 结果解释</FieldLabel>
        <Textarea id={`assessment-${patient.id}`} onChange={(event) => onChangeNote('assessment', event.currentTarget.value)} rows={4} value={patient.note.assessment} />
        <FieldDescription>合成教学场景；内容不构成真实诊疗建议。</FieldDescription>
      </Field>
      <div className="grid gap-4 md:grid-cols-2">
        <ClinicalDraftFact label="诊断草稿" status={patient.treatmentStatus} value={patient.diagnosis || '尚未填写'} icon={<StethoscopeIcon />} />
        <ClinicalDraftFact label="处方草稿" status={patient.treatmentStatus} value={patient.medication || '尚未填写'} icon={<PillIcon />} />
      </div>
    </FieldGroup>
  )
}

function Orders({ patient }: { patient: PatientCase }): React.JSX.Element {
  if (patient.labOrders.length === 0 && patient.medication.length === 0) {
    return (
      <Empty className="min-h-72 border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><BeakerIcon /></EmptyMedia>
          <EmptyTitle>暂无医嘱草稿</EmptyTitle>
          <EmptyDescription>当前 Encounter 尚未创建检验或药品请求。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {patient.labOrders.length === 0 ? null : (
        <section>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">检验请求</h2>
            <StatusBadge status={patient.labOrderStatus} />
          </div>
          <Table>
            <TableHeader><TableRow><TableHead>项目</TableHead><TableHead>类型</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
            <TableBody>
              {patient.labOrders.map((order) => (
                <TableRow key={order}><TableCell className="font-medium">{order}</TableCell><TableCell>ServiceRequest</TableCell><TableCell>{patient.labOrderStatus === 'signed' ? '已签发' : '草稿'}</TableCell></TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
      {patient.medication.length === 0 ? null : (
        <section>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">诊断与处方</h2>
            <StatusBadge status={patient.treatmentStatus} />
          </div>
          <Table>
            <TableHeader><TableRow><TableHead>类别</TableHead><TableHead>内容</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
            <TableBody>
              <TableRow><TableCell>门诊诊断</TableCell><TableCell className="font-medium">{patient.diagnosis}</TableCell><TableCell>{patient.treatmentStatus === 'signed' ? '已确认' : '草稿'}</TableCell></TableRow>
              <TableRow><TableCell>药品请求</TableCell><TableCell className="font-medium">{patient.medication}</TableCell><TableCell>{patient.treatmentStatus === 'signed' ? '已签发' : '草稿'}</TableCell></TableRow>
            </TableBody>
          </Table>
        </section>
      )}
    </div>
  )
}

function Results({ patient, onPublishResults }: { patient: PatientCase; onPublishResults: () => void }): React.JSX.Element {
  if (!patient.resultsReady) {
    return (
      <Empty className="min-h-72 border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><TestTubeDiagonalIcon /></EmptyMedia>
          <EmptyTitle>检验结果尚未发布</EmptyTitle>
          <EmptyDescription>{patient.labOrderStatus === 'signed' ? '检验请求已签发，仿真 LIS 可以回传合成结果。' : '需先由医生人工签发检验请求。'}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button disabled={patient.labOrderStatus !== 'signed'} onClick={onPublishResults} variant="outline"><FlaskConicalIcon data-icon="inline-start" />模拟检验结果回传</Button>
        </EmptyContent>
      </Empty>
    )
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div><h2 className="text-sm font-semibold">检验报告</h2><p className="mt-1 text-xs text-muted-foreground">合成结果 · 09:41 审核发布</p></div>
        <Badge variant="success">已审核</Badge>
      </div>
      <Table>
        <TableHeader><TableRow><TableHead>项目</TableHead><TableHead>结果</TableHead><TableHead>参考区间</TableHead><TableHead>提示</TableHead></TableRow></TableHeader>
        <TableBody>
          {patient.results.map((result) => (
            <TableRow key={result.name}>
              <TableCell className="font-medium">{result.name}</TableCell>
              <TableCell>{result.value}</TableCell>
              <TableCell>{result.reference}</TableCell>
              <TableCell><Badge variant={result.flag === 'high' ? 'warning' : 'secondary'}>{result.flag === 'high' ? '异常' : '正常'}</Badge></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  )
}

function ClinicalDraftFact({
  icon,
  label,
  status,
  value,
}: {
  icon: React.ReactNode
  label: string
  status: PatientCase['treatmentStatus']
  value: string
}): React.JSX.Element {
  return (
    <div className="flex min-h-20 items-start gap-3 border-l-2 border-l-primary bg-muted/20 p-3">
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-sm font-medium">{value}</p></div>
      <StatusBadge status={status} />
    </div>
  )
}

function TimelineItem({ copy, done, label, time }: { copy: string; done: boolean; label: string; time: string }): React.JSX.Element {
  return (
    <li className="grid grid-cols-[2.75rem_1rem_1fr] gap-2 pb-5 last:pb-0">
      <time className="pt-0.5 font-mono text-[0.6875rem] text-muted-foreground">{done ? time : '--:--'}</time>
      <span className={cn('mt-1 flex size-3 items-center justify-center rounded-full ring-4', done ? 'bg-success text-success-foreground ring-success/15' : 'bg-muted-foreground/30 ring-muted')}>{done ? <CheckIcon className="size-2" /> : null}</span>
      <div><p className={cn('text-xs font-medium', done ? 'text-foreground' : 'text-muted-foreground')}>{label}</p><p className="mt-0.5 text-[0.6875rem] leading-4 text-muted-foreground">{copy}</p></div>
    </li>
  )
}

function Fact({ label, mono = false, value }: { label: string; mono?: boolean; value: string }): React.JSX.Element {
  return <div><dt className="text-muted-foreground">{label}</dt><dd className={cn('mt-0.5 font-medium', mono ? 'font-mono' : null)}>{value}</dd></div>
}

function StatusBadge({ status }: { status: 'none' | 'draft' | 'signed' }): React.JSX.Element {
  if (status === 'signed') return <Badge variant="success"><ClipboardCheckIcon />已签发</Badge>
  if (status === 'draft') return <Badge variant="warning"><FilePenLineIcon />草稿</Badge>
  return <Badge variant="secondary">未创建</Badge>
}

function decisionLabel(patient: PatientCase): string {
  if (patient.treatmentStatus === 'signed') return '诊断与处方已由医生签发，本次接诊可进入后续流程。'
  if (patient.treatmentStatus === 'draft') return '诊断和处方仍为草稿，等待医生预览。'
  if (patient.resultsReady) return '检验结果已发布，等待复诊判断。'
  if (patient.labOrderStatus === 'signed') return '检验请求已签发，等待 LIS 回传。'
  if (patient.labOrderStatus === 'draft') return '检验请求仍为草稿，等待医生预览。'
  return '记录首诊病历并决定是否申请检验。'
}

function isClinicalPage(value: unknown): value is ClinicalPage {
  return value === 'record' || value === 'orders' || value === 'results'
}
