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
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  )
}

export function PatientBanner({
  completionAction,
  detail,
  messages,
  statusText,
}: {
  completionAction?: React.ReactNode
  detail: DoctorCaseDetail
  messages: WorkspaceMessages
  statusText: string
}): React.JSX.Element {
  const presentation = detail.presentation
  const readOnly = detail.encounter.status !== 'in-progress'
  const age = patientAge(detail.patient.birthDate)
  return (
    <section aria-label={messages.selectedPatient} className="overflow-hidden border-b bg-background">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <PatientAvatar label={`${detail.patient.name} ${messages.patient}`} name={detail.patient.name} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{detail.patient.name}</h2>
              <Badge variant="outline">{messages[`gender_${detail.patient.gender}` as 'gender_male']}</Badge>
              <span className="text-sm text-muted-foreground">
                {age === undefined ? '-' : messages.patientAge.replace('{age}', String(age))}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{messages.registrationNumber}：{detail.patient.identifier}</span>
              <span>{messages.chiefComplaint}：{presentation.chiefComplaint}</span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {detail.allergies.slice(0, 1).map(allergy => (
            <Badge key={`${allergy.code}:${allergy.display}`} variant="destructive">
              {messages.allergySummary} · {allergy.display}
            </Badge>
          ))}
          {detail.triage === undefined ? null : (
            <Badge variant="warning">{triageAcuityLabel(detail.triage.acuityCode, messages)}</Badge>
          )}
          <Badge variant="secondary">{statusText}</Badge>
          {readOnly ? (
            <Badge variant="outline"><LockKeyholeIcon aria-hidden="true" />{messages.encounterReadOnly}</Badge>
          ) : completionAction}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-px border-t bg-border sm:grid-cols-3 lg:grid-cols-5 [&>div]:bg-background [&>div]:px-3 [&>div]:py-2.5">
        <VitalSummary label="T" value={`${presentation.vitalSigns.temperatureC} °C`} />
        <VitalSummary label="P" value={`${presentation.vitalSigns.pulseBpm} 次/分`} />
        <VitalSummary label="R" value={`${presentation.vitalSigns.respirationBpm} 次/分`} />
        <VitalSummary label="BP" value={`${presentation.vitalSigns.bloodPressure.systolicMmHg}/${presentation.vitalSigns.bloodPressure.diastolicMmHg} mmHg`} />
        <VitalSummary label="SpO₂" value={`${presentation.vitalSigns.oxygenSaturationPct}%`} />
      </dl>
    </section>
  )
}
