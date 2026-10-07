import type { DoctorCaseDetail } from '@clinmesh/contracts/his'
import { Avatar, AvatarFallback, AvatarImage } from '@clinmesh/ui/components/avatar'
import { Badge } from '@clinmesh/ui/components/badge'
import { createAvatar } from '@dicebear/core'
import * as lorelei from '@dicebear/lorelei'
import { LockKeyholeIcon } from 'lucide-react'
import { getWorkspaceMessages } from '../workspace-i18n.ts'

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
  completionAction,
  completionChecklist,
  detail,
  messages,
  statusText,
}: {
  completionAction?: React.ReactNode
  completionChecklist?: React.ReactNode
  detail: DoctorCaseDetail
  messages: WorkspaceMessages
  statusText: string
}): React.JSX.Element {
  const presentation = detail.presentation
  const readOnly = detail.encounter.status !== 'in-progress'
  const age = patientAge(detail.patient.birthDate)
  const genderLabel = messages[`gender_${detail.patient.gender}` as 'gender_male']
  const ageLabel = age === undefined ? undefined : messages.patientAge.replace('{age}', String(age))
  return (
    <section aria-label={messages.selectedPatient} className="max-h-[50%] min-h-0 min-w-0 shrink-0 overflow-y-auto overscroll-contain border-b bg-background [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5">
        <PatientAvatar className="size-7" label={`${detail.patient.name} ${messages.patient}`} name={detail.patient.name} />
        <h2 className="truncate text-sm font-semibold">{detail.patient.name}</h2>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge variant="outline">{ageLabel === undefined ? genderLabel : `${genderLabel} · ${ageLabel}`}</Badge>
          {detail.allergies.map(allergy => (
            <Badge className="h-auto max-w-full whitespace-normal" key={`${allergy.code}:${allergy.display}`} variant="destructive">
              {messages.allergySummary} · {allergy.display}
            </Badge>
          ))}
          {detail.triage === undefined ? null : (
            <Badge variant="warning">{triageAcuityLabel(detail.triage.acuityCode, messages)}</Badge>
          )}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden text-xs text-muted-foreground">
          <span className="truncate">{messages.registrationNumber}：{detail.patient.identifier}</span>
          <span className="truncate">{messages.chiefComplaint}：{presentation?.chiefComplaint ?? messages.triageNotRecorded}</span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Badge variant="secondary">{statusText}</Badge>
          {readOnly ? (
            <Badge variant="outline"><LockKeyholeIcon aria-hidden="true" />{messages.encounterReadOnly}</Badge>
          ) : completionAction}
        </div>
      </div>
      {completionChecklist}
      {presentation === null ? null : <dl className="flex flex-wrap gap-x-5 gap-y-1 border-t px-4 py-1.5">
        <VitalSummary label={messages.temperatureC} value={presentation.vitalSigns.temperatureC} />
        <VitalSummary label={messages.pulseBpm} value={presentation.vitalSigns.pulseBpm} />
        <VitalSummary label={messages.respirationBpm} value={presentation.vitalSigns.respirationBpm} />
        <VitalSummary label={messages.bloodPressure} value={`${presentation.vitalSigns.bloodPressure.systolicMmHg}/${presentation.vitalSigns.bloodPressure.diastolicMmHg}`} />
        <VitalSummary label={messages.oxygenSaturationPct} value={presentation.vitalSigns.oxygenSaturationPct} />
      </dl>}
    </section>
  )
}
