import type { WorkspaceLocale } from '../workspace-i18n.ts'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { useDoctorPreparation } from './doctor-preparation-state.tsx'

export function DoctorRecordReviewNotice({ caseId, authoredAt, locale, onReview }: {
  caseId: string
  authoredAt?: string | undefined
  locale: WorkspaceLocale
  onReview: () => void
}) {
  const detail = useDoctorPreparation()?.detail
  if (detail?.caseId !== caseId || authoredAt === undefined) return null
  const recordTime = Date.parse(authoredAt)
  const sourceTimes = [
    ...(detail.consultation?.turns.map(turn => turn.recordedAt) ?? []),
    detail.clinicalDocument?.draft?.updatedAt,
    ...(detail.clinicalDocument?.signed.map(document => document.signedAt) ?? []),
    ...(detail.laboratoryRequests?.requests.map(request => request.report?.issuedAt) ?? []),
    ...(detail.imagingRequests?.requests.map(request => request.report?.issuedAt) ?? []),
    ...(detail.pathologyRequests?.requests.map(request => request.report?.issuedAt) ?? []),
    detail.diagnosis?.confirmation?.confirmedAt,
    detail.medicationConclusion?.prescription?.authoredAt,
    detail.medicationConclusion?.noMedication?.authoredAt,
  ]
  if (!Number.isFinite(recordTime) || !sourceTimes.some(time => time !== undefined && Date.parse(time) > recordTime)) return null
  const zh = locale === 'zh-CN'
  return <Alert><AlertDescription className="flex flex-wrap items-center justify-between gap-2">
    <span>{zh ? '有新资料，请核对这条记录。' : 'New information is available. Review this record.'}</span>
    <Button onClick={onReview} size="sm" type="button" variant="link">{zh ? '查看记录' : 'Review record'}</Button>
  </AlertDescription></Alert>
}
