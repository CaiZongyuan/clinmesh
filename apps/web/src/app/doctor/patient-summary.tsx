import type { DoctorCaseDetail } from '@clinmesh/contracts/his'
import { Avatar, AvatarFallback, AvatarImage } from '@clinmesh/ui/components/avatar'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { createAvatar } from '@dicebear/core'
import * as lorelei from '@dicebear/lorelei'
import { IdCardIcon, LockKeyholeIcon } from 'lucide-react'
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
  onShowContext,
  statusText,
}: {
  completionAction?: React.ReactNode
  detail: DoctorCaseDetail
  messages: WorkspaceMessages
  /** surface 模式下宿主右栏承载患者上下文:点击在右栏打开/聚焦患者信息标签页。 */
  onShowContext?: () => void
  statusText: string
}): React.JSX.Element {
  const presentation = detail.presentation
  const readOnly = detail.encounter.status !== 'in-progress'
  const age = patientAge(detail.patient.birthDate)
  return (
    <section aria-label={messages.selectedPatient} className="@container/patient-banner min-w-0 shrink-0 border-b bg-background [overflow-wrap:anywhere]">
      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <PatientAvatar label={`${detail.patient.name} ${messages.patient}`} name={detail.patient.name} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{detail.patient.name}</h2>
              <Badge variant="outline">{messages[`gender_${detail.patient.gender}` as 'gender_male']}</Badge>
              <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">
                {age === undefined ? '-' : messages.patientAge.replace('{age}', String(age))}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{messages.registrationNumber}：{detail.patient.identifier}</span>
              <span>{messages.chiefComplaint}：{presentation?.chiefComplaint ?? messages.triageNotRecorded}</span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="secondary">{statusText}</Badge>
          {readOnly ? (
            <Badge variant="outline"><LockKeyholeIcon aria-hidden="true" />{messages.encounterReadOnly}</Badge>
          ) : completionAction}
          {onShowContext === undefined ? null : (
            <Button onClick={onShowContext} size="sm" variant="outline">
              <IdCardIcon aria-hidden="true" />
              {messages.showPatientContext}
            </Button>
          )}
        </div>
      </div>
      {detail.allergies.length === 0 && detail.triage === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
          {detail.allergies.slice(0, 1).map(allergy => (
            <Badge className="h-auto max-w-full whitespace-normal" key={`${allergy.code}:${allergy.display}`} variant="destructive">
              {messages.allergySummary} · {allergy.display}
            </Badge>
          ))}
          {detail.triage === undefined ? null : (
            <Badge variant="warning">{triageAcuityLabel(detail.triage.acuityCode, messages)}</Badge>
          )}
        </div>
      )}
      {presentation === null ? null : <dl className="grid grid-cols-2 gap-px border-t bg-border @min-[400px]/patient-banner:grid-cols-3 @min-[680px]/patient-banner:grid-cols-5 [&>div]:bg-background [&>div]:px-3 [&>div]:py-2.5">
        <VitalSummary label={messages.temperatureC} value={presentation.vitalSigns.temperatureC} />
        <VitalSummary label={messages.pulseBpm} value={presentation.vitalSigns.pulseBpm} />
        <VitalSummary label={messages.respirationBpm} value={presentation.vitalSigns.respirationBpm} />
        <VitalSummary label={messages.bloodPressure} value={`${presentation.vitalSigns.bloodPressure.systolicMmHg}/${presentation.vitalSigns.bloodPressure.diastolicMmHg}`} />
        <VitalSummary label={messages.oxygenSaturationPct} value={presentation.vitalSigns.oxygenSaturationPct} />
      </dl>}
    </section>
  )
}
