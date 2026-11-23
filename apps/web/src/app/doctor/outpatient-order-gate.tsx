import type { DoctorCaseSection } from '@clinmesh/contracts/agent'
import type { DoctorCaseDetail, OutpatientOrderPrerequisiteCode } from '@clinmesh/contracts/his'
import { Button } from '@clinmesh/ui/components/button'
import { ArrowRightIcon } from 'lucide-react'
import type { WorkspaceLocale } from '../workspace-i18n.ts'

export interface OutpatientOrderPrerequisiteGate {
  readonly blocked: boolean
  readonly code?: OutpatientOrderPrerequisiteCode | undefined
  readonly missingConfirmedDiagnosis: boolean
  readonly missingSignedRecord: boolean
  readonly onNavigateSection?: ((section: DoctorCaseSection) => void) | undefined
}

export function resolveOutpatientOrderPrerequisiteGate(
  detail: DoctorCaseDetail | undefined,
  onNavigateSection?: (section: DoctorCaseSection) => void,
): OutpatientOrderPrerequisiteGate {
  if (detail === undefined || detail.consultation === undefined || detail.encounter.status !== 'in-progress') {
    return {
      blocked: false,
      missingConfirmedDiagnosis: false,
      missingSignedRecord: false,
      onNavigateSection,
    }
  }
  const missingSignedRecord = (detail.clinicalDocument?.signed.length ?? 0) === 0
  const missingConfirmedDiagnosis = !detail.diagnosis?.confirmation?.entries.some(
    entry => entry.role === 'primary',
  )
  const code: OutpatientOrderPrerequisiteCode | undefined = missingSignedRecord
    ? 'CLINICAL_DOCUMENT_UNSIGNED'
    : missingConfirmedDiagnosis
      ? 'DIAGNOSIS_UNCONFIRMED'
      : undefined
  return {
    blocked: code !== undefined,
    code,
    missingConfirmedDiagnosis,
    missingSignedRecord,
    onNavigateSection,
  }
}

export function assertOutpatientAgentOrderPrerequisites(detail: DoctorCaseDetail): void {
  const gate = resolveOutpatientOrderPrerequisiteGate(detail)
  if (gate.missingSignedRecord) {
    throw new Error('CLINICAL_DOCUMENT_UNSIGNED: 正式签发医嘱或确认用药结论前，请先完成首版结构化病历正式电子签名。')
  }
  if (gate.missingConfirmedDiagnosis) {
    throw new Error('DIAGNOSIS_UNCONFIRMED: 正式签发医嘱或确认用药结论前，请先确认至少一条有效主诊断。')
  }
}

export function OutpatientOrderGateGuidance({
  gate,
  locale,
}: {
  gate: OutpatientOrderPrerequisiteGate | undefined
  locale: WorkspaceLocale
}): React.JSX.Element | null {
  if (gate === undefined || !gate.blocked) return null
  const zh = locale === 'zh-CN'
  const reasonText = gate.missingSignedRecord && gate.missingConfirmedDiagnosis
    ? (zh ? '开单前须先签署首版病历并确认主诊断' : 'Sign the initial record and confirm a primary diagnosis before issuing')
    : gate.missingSignedRecord
      ? (zh ? '开单前须先签署首版病历' : 'Sign the initial clinical document before issuing')
      : (zh ? '开单前须先确认主诊断' : 'Confirm a primary diagnosis before issuing')

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-warning"
      data-outpatient-order-gate=""
      role="status"
    >
      <span className="min-w-0 whitespace-normal break-words font-medium">{reasonText}</span>
      {gate.onNavigateSection === undefined ? null : (
        <>
          {gate.missingSignedRecord ? (
            <Button
              className="h-auto max-w-full whitespace-normal py-1"
              onClick={() => { gate.onNavigateSection?.('record') }}
              size="sm"
              type="button"
              variant="outline"
            >
              {zh ? '去签署首版病历' : 'Sign initial record'}
              <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
            </Button>
          ) : null}
          {gate.missingConfirmedDiagnosis ? (
            <Button
              className="h-auto max-w-full whitespace-normal py-1"
              onClick={() => { gate.onNavigateSection?.('diagnosis') }}
              size="sm"
              type="button"
              variant="outline"
            >
              {zh ? '去确认诊断' : 'Confirm diagnosis'}
              <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
            </Button>
          ) : null}
        </>
      )}
    </div>
  )
}
