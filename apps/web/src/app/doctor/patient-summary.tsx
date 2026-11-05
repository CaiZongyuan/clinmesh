import type { ClinicalDocumentContent, DoctorCaseDetail } from '@clinmesh/contracts/his'
import { Avatar, AvatarFallback, AvatarImage } from '@clinmesh/ui/components/avatar'
import { Badge } from '@clinmesh/ui/components/badge'
import { createAvatar } from '@dicebear/core'
import * as lorelei from '@dicebear/lorelei'
import { LockKeyholeIcon } from 'lucide-react'
import { RegistrationNumber } from '../registration-number.tsx'
import { WorkspacePatientCard } from '../workspace-card-layout.tsx'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import { createWorkingClinicalDocument } from './clinical-document-content.ts'

type WorkspaceMessages = ReturnType<typeof getWorkspaceMessages>
const avatarCache = new Map<string, string>()

function syntheticAvatar(name: string): string {
  const cached = avatarCache.get(name)
  if (cached !== undefined) return cached
  const avatar = createAvatar(lorelei, { seed: `clinmesh:${name}` }).toDataUri()
  avatarCache.set(name, avatar)
  return avatar
}

function triageAcuityLabel(code: string, messages: WorkspaceMessages): string {
  if (code === 'level-1') return messages.acuity_level1
  if (code === 'level-2') return messages.acuity_level2
  if (code === 'level-3') return messages.acuity_level3
  if (code === 'level-4') return messages.acuity_level4
  return code
}

export function patientAge(
  birthDate: string | undefined,
  referenceDate: Date = new Date(),
): number | undefined {
  if (birthDate === undefined) return undefined
  const birth = new Date(`${birthDate}T00:00:00Z`)
  let age = referenceDate.getUTCFullYear() - birth.getUTCFullYear()
  const birthdayPending = referenceDate.getUTCMonth() < birth.getUTCMonth()
    || (
      referenceDate.getUTCMonth() === birth.getUTCMonth()
      && referenceDate.getUTCDate() < birth.getUTCDate()
    )
  if (birthdayPending) age -= 1
  return age
}

export function PatientAvatar({ className = 'size-12', label, name }: {
  className?: string
  label: string
  name: string
}): React.JSX.Element {
  return (
    <Avatar aria-label={label} className={className} role="img">
      <AvatarImage alt="" src={syntheticAvatar(name)} />
      <AvatarFallback className="bg-info/15 font-semibold text-info">
        {name.slice(0, 1)}
      </AvatarFallback>
    </Avatar>
  )
}

export function VitalSummary({ label, value }: {
  label: string
  value: number | string
}): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xs font-medium tabular-nums">{value}</dd>
    </div>
  )
}

export function PatientBanner({
  patientActions,
  assistant,
  detail,
  messages,
  statusText,
  workingDocument,
}: {
  patientActions?: React.ReactNode
  assistant?: React.ReactNode
  detail: DoctorCaseDetail
  messages: WorkspaceMessages
  statusText: string
  workingDocument?: ClinicalDocumentContent | undefined
}): React.JSX.Element {
  const signed = detail.clinicalDocument?.signed
    .toSorted((left, right) => right.revisionNumber - left.revisionNumber)[0]
  const savedChiefComplaint = createWorkingClinicalDocument(detail).chiefComplaint
  const chiefComplaint = signed?.content.chiefComplaint ?? workingDocument?.chiefComplaint ?? savedChiefComplaint
  const unsavedChiefComplaint = signed === undefined && workingDocument !== undefined
    && workingDocument.chiefComplaint !== savedChiefComplaint
  const readOnly = detail.encounter.status !== 'in-progress'
  const age = patientAge(detail.patient.birthDate)
  const genderLabel = messages[`gender_${detail.patient.gender}` as 'gender_male']
  const ageLabel = age === undefined ? undefined : messages.patientAge.replace('{age}', String(age))
  return (
    <section aria-label={messages.selectedPatient} className="min-w-0 shrink-0 border-b [overflow-wrap:anywhere]"><WorkspacePatientCard className=" overflow-visible rounded-none bg-transparent py-1 ring-0">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-1.5">
        <span aria-label={`${detail.patient.name} ${messages.patient}`} className="sr-only" role="img" />
        <h2 className="truncate text-[15px] font-semibold">{detail.patient.name}</h2>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge variant="outline">{ageLabel === undefined ? genderLabel : `${genderLabel} · ${ageLabel}`}</Badge>
          {detail.allergies.map(allergy => (
            <Badge className="h-auto max-w-full whitespace-normal" key={`${allergy.code}:${allergy.display}`} variant="destructive">
              {messages.allergySummary} · {allergy.display}
            </Badge>
          ))}
          {detail.triage === undefined ? null : (
            <Badge variant={detail.triage.acuityCode === 'level-1' || detail.triage.acuityCode === 'level-2' ? 'destructive' : detail.triage.acuityCode === 'level-3' ? 'warning' : 'outline'}>
              {triageAcuityLabel(detail.triage.acuityCode, messages)}
            </Badge>
          )}
          {readOnly ? (
            <Badge variant="outline"><LockKeyholeIcon aria-hidden="true" />{messages.encounterReadOnly}</Badge>
          ) : (
            <Badge variant="secondary">{statusText}</Badge>
          )}
        </div>
        <div className="flex min-w-0 flex-1 basis-56 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <RegistrationNumber key={detail.caseId} messages={messages} registrationNumber={detail.registrationNumber} />
          <span className="min-w-0 flex-1 basis-36 truncate" title={chiefComplaint?.trim() ? chiefComplaint : messages.clinicalHistoryNotRecorded}>{messages.chiefComplaint}：{chiefComplaint?.trim() ? chiefComplaint : messages.clinicalHistoryNotRecorded}</span>
          {unsavedChiefComplaint ? <Badge title={messages.clinicalDocumentDraftUnsaved} variant="outline">{messages.clinicalDocumentDraftUnsavedShort}</Badge> : null}
        </div>
        {patientActions === undefined ? null : (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {patientActions}
          </div>
        )}
      </div>
      {assistant}
    </WorkspacePatientCard></section>
  )
}

export function PatientVitals({ detail, messages }: { detail: DoctorCaseDetail; messages: WorkspaceMessages }) {
  if (detail.presentation === null) return null
  const vitals = detail.presentation.vitalSigns
  return <dl className="flex flex-wrap gap-x-4 gap-y-2">
    <VitalSummary label={messages.temperatureC} value={vitals.temperatureC} />
    <VitalSummary label={messages.pulseBpm} value={vitals.pulseBpm} />
    <VitalSummary label={messages.respirationBpm} value={vitals.respirationBpm} />
    <VitalSummary label={messages.bloodPressure} value={`${vitals.bloodPressure.systolicMmHg}/${vitals.bloodPressure.diastolicMmHg}`} />
    <VitalSummary label={messages.oxygenSaturationPct} value={vitals.oxygenSaturationPct} />
  </dl>
}
